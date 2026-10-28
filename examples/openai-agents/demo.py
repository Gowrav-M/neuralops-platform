"""Invoke a guarded OpenAI Agents SDK FunctionTool without calling a model."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from uuid import uuid4

from agents.tool_context import ToolContext

from neuralops import NeuralOpsClient, guard_openai_tool


def simulate_publish(context: ToolContext, document_name: str, body: str) -> str:
    """Simulate publishing a document in memory. No network or file writes occur."""
    del context, body
    return f"Simulated publish authorized for {document_name}; no external side effect occurred."


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--call-id",
        default=f"neuralops-demo-{uuid4()}",
        help="Keep this value unchanged when retrying the same pending approval.",
    )
    arguments = parser.parse_args()

    identity_id = os.environ.get("NEURALOPS_AGENT_IDENTITY_ID")
    credential = os.environ.get("NEURALOPS_AGENT_CREDENTIAL")
    if not identity_id or not credential:
        parser.error("Set NEURALOPS_AGENT_IDENTITY_ID and NEURALOPS_AGENT_CREDENTIAL.")

    client = NeuralOpsClient(
        agent_credential=credential,
        base_url=os.environ.get("NEURALOPS_API_URL", "http://localhost:8000"),
    )
    tool = guard_openai_tool(
        client,
        simulate_publish,
        identity_id=identity_id,
        action="write",
        tool_category="write",
        provider="openai",
        environment=os.environ.get("NEURALOPS_ENVIRONMENT", "dev"),
        create_approval_preview=lambda values: {
            "summary": "Publish a document in the in-memory demo",
            "resource": values["document_name"],
            "impact": "No network or filesystem side effect",
        },
    )

    tool_arguments = {"document_name": "demo-brief", "body": "Example content only"}
    context = ToolContext(
        context=None,
        tool_name=tool.name,
        tool_call_id=arguments.call_id,
        tool_arguments=json.dumps(tool_arguments),
    )
    try:
        result = await tool.on_invoke_tool(context, json.dumps(tool_arguments))
    except Exception as exc:
        code = getattr(exc, "code", "")
        if code == "approval_required":
            print("Blocked before the simulated tool ran. Review the pending request in Agent Command Center.")
            print(f"Retry this same approval with: python demo.py --call-id {arguments.call_id}")
            return 2
        if code in {"backend_unavailable", "request_rejected"}:
            print(f"Blocked before the simulated tool ran: NeuralOps authorization failed ({code}).")
            return 3
        raise

    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
