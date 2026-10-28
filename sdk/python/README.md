# neuralops-sdk

Local Python SDK for sending real AI workflow traces into NeuralOps and routing OpenAI-compatible model calls through the NeuralOps Policy Gateway.

## Gate OpenAI Agents SDK tools before execution

Install the local SDK with its optional adapter extra and configure an external NeuralOps agent identity with the required provider and tool permissions:

```bash
python -m pip install -e "sdk/python[openai-agents]"
```

The optional adapter targets the OpenAI Agents SDK 0.24.x API.

```python
import os
from agents import Agent, Runner
from neuralops import NeuralOpsClient, guard_openai_tool

client = NeuralOpsClient(
    agent_credential=os.environ["NEURALOPS_AGENT_CREDENTIAL"],
    base_url=os.getenv("NEURALOPS_API_URL", "http://localhost:8000"),
)

def read_status(service: str) -> str:
    """Read a simulated service status."""
    return f"{service}: simulated healthy"

guarded_status = guard_openai_tool(
    client,
    read_status,
    identity_id=os.environ["NEURALOPS_AGENT_IDENTITY_ID"],
    action="metadata_read",
    tool_category="metadata",
    provider="openai",
    environment="dev",
)
agent = Agent(name="governed-ops-agent", instructions="Use the status tool.", tools=[guarded_status])
result = Runner.run_sync(agent, "Read the demo service status")
print(result.final_output)
```

The adapter hashes a canonical representation of tool arguments locally. It sends only action metadata and hashes to NeuralOps, requests authorization, atomically consumes the action-bound single-use lease, and only then invokes the tool. If approval is required, the backend is unavailable, the lease is invalid, or consumption fails, the tool is not called. Review and approve pending actions in NeuralOps, then allow the agent runtime to retry the tool call. Keep real side effects out of demos.

`guard_openai_tool` checks the workspace's approval-preview policy before high-risk actions. New workspaces default to metadata-only; the adapter does not submit arguments in that mode. When a workspace explicitly enables `redacted_preview`, an optional `create_approval_preview(arguments)` callback may return a required `summary` (up to 240 characters) and optional `resource` (up to 160 characters) and `impact` (up to 240 characters). Only those returned strings are sent for the pending approval; the callback is responsible for redacting sensitive values. Raw arguments are never sent by the adapter.

Approval retries reuse a SHA-256-derived idempotency key from OpenAI's `ToolContext.tool_call_id`. If approval happens outside the run and your retry creates a new tool-call ID, pass `idempotency_key(context, arguments)` backed by your application's stable operation ID. The callback result is hashed before it is sent, and a later distinct tool call should use a distinct operation ID.

```python
import os
from neuralops import NeuralOpsClient

client = NeuralOpsClient(
    api_key=os.environ["NEURALOPS_API_KEY"],
    base_url=os.getenv("NEURALOPS_API_URL", "http://localhost:8000"),
)

client.ingest_trace(
    session="rag-api-001",
    environment="staging",
    model="llama-3.3-70b-versatile",
    tokens=512,
    latency_ms=420,
    cost_usd=0.006,
    status="success",
    score=0.91,
    prompt="Answer billing policy question",
    output="Answered from retrieval context",
)

completion = client.chat_completions(
    model="gpt-4o-mini",
    metadata={"environment": "staging", "session": "rag-api-001"},
    messages=[
        {"role": "system", "content": "Answer from approved context only."},
        {"role": "user", "content": "Explain the support policy."},
    ],
)

print(completion["neuralops"]["traceId"])
```

Keep the API key on the server. Use `trace:ingest` for telemetry and `gateway:invoke` for governed model calls. Do not expose keys in browser JavaScript.
