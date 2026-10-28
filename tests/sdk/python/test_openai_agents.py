from __future__ import annotations

import asyncio
import builtins
import hashlib
import json
import sys
import threading
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from neuralops import (  # noqa: E402
    NeuralOpsAuthorizationError,
    NeuralOpsClient,
    guard_openai_tool,
)


class FakeClient:
    def __init__(self, preview_mode: str = "metadata_only") -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.preview_mode = preview_mode
        self.lease = {
            "id": "lease_once",
            "idempotencyKey": "idem_once",
        }

    def get_approval_preview_policy(self, identity_id: str) -> dict[str, str]:
        self.events.append(("preview_policy", {"identity_id": identity_id}))
        return {"mode": self.preview_mode, "updatedAt": "now", "updatedBy": "owner"}

    def authorize_action(self, **metadata: Any) -> dict[str, Any]:
        self.events.append(("authorize", metadata))
        return {
            "id": self.lease["id"],
            "idempotencyKey": metadata.get("idempotency_key", self.lease["idempotencyKey"]),
        }

    def consume_lease(self, **metadata: Any) -> dict[str, Any]:
        self.events.append(("consume", metadata))
        return {"status": "consumed"}


def install_function_tool_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    agents = ModuleType("agents")
    tool_context = ModuleType("agents.tool_context")

    class ToolContext:
        def __init__(self, tool_call_id: str) -> None:
            self.tool_call_id = tool_call_id

    tool_context.ToolContext = ToolContext  # type: ignore[attr-defined]

    def function_tool(function=None, **options):  # noqa: ANN001
        del options
        if function is not None:
            async def invoke(*args, **kwargs):  # noqa: ANN001
                call_id = kwargs.pop("_tool_call_id", "tool-call-default")
                return await function(ToolContext(call_id), *args, **kwargs)

            return invoke
        return lambda wrapped: wrapped

    agents.function_tool = function_tool  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "agents", agents)
    monkeypatch.setitem(sys.modules, "agents.tool_context", tool_context)


def test_openai_tool_consumes_bound_lease_before_running_without_sending_arguments(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    executed: list[dict[str, Any]] = []

    async def transfer_funds(account: str, amount: int) -> str:
        executed.append({"account": account, "amount": amount})
        client.events.append(("execute", {}))
        return "simulated"

    tool = guard_openai_tool(
        client,
        transfer_funds,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        environment="staging",
        provider="openai",
    )

    result = asyncio.run(tool(account="acct-private", amount=40))

    assert result == "simulated"
    assert [event[0] for event in client.events] == ["preview_policy", "authorize", "consume", "execute"]
    authorize = client.events[1][1]
    consume = client.events[2][1]
    expected_content = hashlib.sha256(b'{"account":"acct-private","amount":40}').hexdigest()
    assert authorize["content_hash"] == f"sha256:{expected_content}"
    assert "acct-private" not in json.dumps(authorize)
    assert "account" not in authorize
    assert "approval_preview" not in authorize
    assert consume["lease_id"] == "lease_once"
    assert consume["idempotency_key"] == authorize["idempotency_key"]
    assert executed == [{"account": "acct-private", "amount": 40}]


def test_openai_tool_fails_closed_when_neuralops_requests_approval(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    executed = False

    def risky_action() -> str:
        nonlocal executed
        executed = True
        return "should not run"

    def require_review(**metadata: Any) -> dict[str, Any]:
        client.events.append(("authorize", metadata))
        raise NeuralOpsAuthorizationError(
            "NeuralOps denied authorization pending explicit approval",
            code="approval_required",
            approval={"id": "approval_1", "status": "pending"},
        )

    client.authorize_action = require_review  # type: ignore[method-assign]
    tool = guard_openai_tool(
        client,
        risky_action,
        identity_id="agent_1",
        action="shell",
        tool_category="shell",
        provider="openai",
    )

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        asyncio.run(tool())

    assert raised.value.code == "approval_required"
    assert executed is False
    assert [event[0] for event in client.events] == ["preview_policy", "authorize"]


def test_openai_tool_fails_closed_if_lease_consumption_is_rejected(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    executed = False

    def fail_consume(**metadata: Any) -> dict[str, Any]:
        client.events.append(("consume", metadata))
        raise NeuralOpsAuthorizationError("lease revoked", code="request_rejected", status=409)

    client.consume_lease = fail_consume  # type: ignore[method-assign]

    def destructive_action(path: str) -> str:
        nonlocal executed
        executed = True
        return path

    tool = guard_openai_tool(
        client,
        destructive_action,
        identity_id="agent_1",
        action="destructive",
        tool_category="destructive",
        provider="openai",
    )

    with pytest.raises(NeuralOpsAuthorizationError):
        asyncio.run(tool(path="private/path"))

    assert executed is False
    assert [event[0] for event in client.events] == ["preview_policy", "authorize", "consume"]


def test_openai_tool_stops_after_identity_revocation(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    executed: list[str] = []
    revoked = False

    def authorize(**metadata: Any) -> dict[str, Any]:
        client.events.append(("authorize", metadata))
        if revoked:
            raise NeuralOpsAuthorizationError("identity revoked", code="request_rejected", status=403)
        return {"id": "lease_once", "idempotencyKey": metadata.get("idempotency_key", "idem_once")}

    client.authorize_action = authorize  # type: ignore[method-assign]

    def simulate_write(record: str) -> str:
        executed.append(record)
        return record

    tool = guard_openai_tool(
        client,
        simulate_write,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
    )

    assert asyncio.run(tool(record="first")) == "first"
    revoked = True
    with pytest.raises(NeuralOpsAuthorizationError, match="identity revoked"):
        asyncio.run(tool(record="second", _tool_call_id="fresh-call-after-revocation"))

    assert executed == ["first"]
    assert [event for event, _metadata in client.events].count("consume") == 1


def test_openai_tool_sends_only_bounded_redacted_preview_when_workspace_enables_it(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient(preview_mode="redacted_preview")
    raw_arguments: list[dict[str, Any]] = []

    def delete_record(record_id: str, api_token: str) -> str:
        return record_id

    def preview(arguments: dict[str, Any]) -> dict[str, str]:
        raw_arguments.append(arguments)
        return {
            "summary": "Delete the selected demo record",
            "resource": "record: demo-only",
            "impact": "One simulated record will be removed",
        }

    tool = guard_openai_tool(
        client,
        delete_record,
        identity_id="agent_1",
        action="destructive",
        tool_category="destructive",
        provider="openai",
        create_approval_preview=preview,
    )

    result = asyncio.run(tool(record_id="rec-private-991", api_token="secret-value"))

    assert result == "rec-private-991"
    authorize = next(metadata for event, metadata in client.events if event == "authorize")
    assert authorize["approval_preview"] == {
        "summary": "Delete the selected demo record",
        "resource": "record: demo-only",
        "impact": "One simulated record will be removed",
    }
    assert "rec-private-991" not in json.dumps(authorize)
    assert "secret-value" not in json.dumps(authorize)
    assert raw_arguments == [{"record_id": "rec-private-991", "api_token": "secret-value"}]


def test_openai_tool_allows_summary_only_approval_preview(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient(preview_mode="redacted_preview")

    def update_record(record_id: str) -> str:
        return record_id

    tool = guard_openai_tool(
        client,
        update_record,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
        create_approval_preview=lambda _arguments: {"summary": "Update one simulated record"},
    )

    assert asyncio.run(tool(record_id="rec-private")) == "rec-private"
    authorize = next(metadata for event, metadata in client.events if event == "authorize")
    assert authorize["approval_preview"] == {"summary": "Update one simulated record"}


def test_openai_tool_rejects_unbounded_preview_before_authorization(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient(preview_mode="redacted_preview")

    def update_record(record_id: str) -> str:
        return record_id

    tool = guard_openai_tool(
        client,
        update_record,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
        create_approval_preview=lambda _arguments: {
            "summary": "x" * 241,
            "resource": "record",
            "impact": "update",
        },
    )

    with pytest.raises(ValueError, match="at most 240 characters"):
        asyncio.run(tool(record_id="rec-private"))

    assert [event[0] for event in client.events] == ["preview_policy"]


def test_openai_tool_enforces_shorter_resource_preview_limit(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient(preview_mode="redacted_preview")

    def change_record(record_id: str) -> str:
        return record_id

    tool = guard_openai_tool(
        client,
        change_record,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
        create_approval_preview=lambda _arguments: {
            "summary": "Update a demo record",
            "resource": "r" * 161,
            "impact": "No external side effects",
        },
    )

    with pytest.raises(ValueError, match="resource must be at most 160 characters"):
        asyncio.run(tool(record_id="rec-private"))

    assert [event[0] for event in client.events] == ["preview_policy"]


def test_openai_tool_sanitizes_preview_callback_errors(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient(preview_mode="redacted_preview")

    def risky_tool(secret: str) -> str:
        return secret

    def broken_preview(_arguments: dict[str, Any]) -> dict[str, str]:
        raise RuntimeError("secret-value should not reach logs")

    tool = guard_openai_tool(
        client,
        risky_tool,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
        create_approval_preview=broken_preview,
    )

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        asyncio.run(tool(secret="secret-value"))

    assert raised.value.code == "invalid_metadata"
    assert "secret-value" not in str(raised.value)
    assert [event[0] for event in client.events] == ["preview_policy"]


def test_preview_policy_lookup_uses_agent_credential_and_validates_response(monkeypatch) -> None:  # noqa: ANN001
    calls: list[Any] = []

    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps({"mode": "metadata_only", "updatedAt": "now", "updatedBy": "owner"}).encode()

    def fake_urlopen(request, timeout):  # noqa: ANN001
        calls.append((request, timeout))
        return Response()

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(agent_credential="nop_agent_secret_value", base_url="https://neuralops.example")

    policy = client.get_approval_preview_policy("agent_1")

    assert policy == {"mode": "metadata_only", "updatedAt": "now", "updatedBy": "owner"}
    request, timeout = calls[0]
    assert request.full_url == "https://neuralops.example/api/agent-control/agent-privacy-policy/agent_1"
    assert request.get_method() == "GET"
    assert request.get_header("X-neuralops-agent-key") == "nop_agent_secret_value"
    assert timeout == 10.0


def test_preview_policy_lookup_accepts_default_null_updated_at(monkeypatch) -> None:  # noqa: ANN001
    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps({"mode": "metadata_only", "updatedAt": None, "updatedBy": "system"}).encode()

    monkeypatch.setattr("neuralops.urlopen", lambda *_args, **_kwargs: Response())
    client = NeuralOpsClient(agent_credential="nop_agent_secret_value")

    policy = client.get_approval_preview_policy("agent_1")

    assert policy == {"mode": "metadata_only", "updatedAt": None, "updatedBy": "system"}


def test_openai_tool_retry_reuses_approval_key_and_later_action_gets_fresh_key(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    approved_keys: set[str] = set()
    consumed_keys: list[str] = []
    executed: list[str] = []
    lease_count = 0

    def authorize(**metadata: Any) -> dict[str, Any]:
        nonlocal lease_count
        client.events.append(("authorize", metadata))
        key = metadata["idempotency_key"]
        if key not in approved_keys:
            raise NeuralOpsAuthorizationError(
                "Approval required",
                code="approval_required",
                approval={"id": "approval_1", "status": "pending"},
                idempotency_key=key,
            )
        lease_count += 1
        return {"id": f"lease_{lease_count}", "idempotencyKey": key}

    def consume(**metadata: Any) -> dict[str, Any]:
        client.events.append(("consume", metadata))
        consumed_keys.append(metadata["idempotency_key"])
        return {"status": "consumed"}

    client.authorize_action = authorize  # type: ignore[method-assign]
    client.consume_lease = consume  # type: ignore[method-assign]

    def simulated_write(record: str) -> str:
        executed.append(record)
        return record

    tool = guard_openai_tool(
        client,
        simulated_write,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
    )

    with pytest.raises(NeuralOpsAuthorizationError) as pending:
        asyncio.run(tool(_tool_call_id="call_same", record="demo-record"))
    first_key = pending.value.idempotency_key
    assert first_key
    approved_keys.add(first_key)

    assert asyncio.run(tool(_tool_call_id="call_same", record="demo-record")) == "demo-record"
    with pytest.raises(NeuralOpsAuthorizationError) as later_pending:
        asyncio.run(tool(_tool_call_id="call_later", record="demo-record"))
    later_key = later_pending.value.idempotency_key
    assert later_key
    assert later_key != first_key
    approved_keys.add(later_key)
    assert asyncio.run(tool(_tool_call_id="call_later", record="demo-record")) == "demo-record"

    authorize_keys = [metadata["idempotency_key"] for event, metadata in client.events if event == "authorize"]
    assert authorize_keys == [first_key, first_key, later_key, later_key]
    assert consumed_keys == [first_key, later_key]
    assert executed == ["demo-record", "demo-record"]


def test_openai_tool_accepts_application_stable_idempotency_callback(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    callback_context_ids: list[str] = []

    def simulated_write(record: str) -> str:
        return record

    def stable_key(context: Any, arguments: dict[str, Any]) -> str:
        callback_context_ids.append(context.tool_call_id)
        assert arguments == {"record": "demo-record"}
        return "workflow-operation-42"

    tool = guard_openai_tool(
        client,
        simulated_write,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
        idempotency_key=stable_key,
    )

    assert asyncio.run(tool(_tool_call_id="call_one", record="demo-record")) == "demo-record"
    assert asyncio.run(tool(_tool_call_id="call_two", record="demo-record")) == "demo-record"

    authorize_keys = [metadata["idempotency_key"] for event, metadata in client.events if event == "authorize"]
    assert authorize_keys[0] == authorize_keys[1]
    assert authorize_keys[0].startswith("nop_openai_")
    assert "workflow-operation-42" not in authorize_keys[0]
    assert callback_context_ids == ["call_one", "call_two"]


def test_openai_tool_runs_sync_neuralops_calls_off_event_loop(monkeypatch) -> None:  # noqa: ANN001
    install_function_tool_stub(monkeypatch)
    client = FakeClient()
    control_threads: list[int] = []

    for method_name in ("get_approval_preview_policy", "authorize_action", "consume_lease"):
        original = getattr(client, method_name)

        def instrumented(*args, _original=original, **kwargs):  # noqa: ANN001
            control_threads.append(threading.get_ident())
            return _original(*args, **kwargs)

        setattr(client, method_name, instrumented)

    def simulated_write(record: str) -> str:
        return record

    tool = guard_openai_tool(
        client,
        simulated_write,
        identity_id="agent_1",
        action="write",
        tool_category="write",
        provider="openai",
    )

    async def invoke() -> tuple[str, int]:
        loop_thread = threading.get_ident()
        return await tool(record="demo-record"), loop_thread

    result, loop_thread = asyncio.run(invoke())

    assert result == "demo-record"
    assert len(control_threads) == 3
    assert all(thread_id != loop_thread for thread_id in control_threads)


def test_installed_openai_agents_sdk_receives_hidden_tool_context_schema() -> None:
    agents = pytest.importorskip("agents")
    from agents.tool_context import ToolContext

    client = FakeClient()

    def read_status(service: str) -> str:
        """Return a simulated service status."""
        return service

    tool = guard_openai_tool(
        client,
        read_status,
        identity_id="agent_1",
        action="metadata_read",
        tool_category="metadata",
        provider="openai",
    )

    assert isinstance(tool, agents.FunctionTool)
    assert set(tool.params_json_schema["properties"]) == {"service"}

    arguments = {"service": "payments"}
    context = ToolContext(
        context=None,
        tool_name=tool.name,
        tool_call_id="openai-tool-call-1",
        tool_arguments=json.dumps(arguments),
    )
    result = asyncio.run(tool.on_invoke_tool(context, json.dumps(arguments)))

    assert result == "payments"
    assert [event for event, _metadata in client.events] == ["authorize", "consume"]


def test_openai_tool_requires_optional_agents_extra(monkeypatch) -> None:  # noqa: ANN001
    original_import = builtins.__import__

    def without_agents(name, *args, **kwargs):  # noqa: ANN001
        if name == "agents" or name.startswith("agents."):
            raise ImportError("agents is not installed")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_agents)
    client = FakeClient()

    def harmless() -> str:
        return "ok"

    with pytest.raises(ImportError, match=r"pip install neuralops-sdk\[openai-agents\]"):
        guard_openai_tool(
            client,
            harmless,
            identity_id="agent_1",
            action="metadata_read",
            tool_category="metadata",
            provider="openai",
        )
