from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from neuralops import (  # noqa: E402
    AGENT_ACTION_METADATA_READ,
    AGENT_ACTION_SHELL,
    AGENT_TOOL_CATEGORY_METADATA,
    AGENT_TOOL_CATEGORY_SHELL,
    NeuralOpsAuthorizationError,
    NeuralOpsClient,
    NeuralOpsError,
    trace_function,
    wrap_openai,
)


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_python_sdk_routes_chat_completions_through_gateway(monkeypatch) -> None:
    calls: list[Any] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        calls.append((request, timeout))
        return FakeResponse({"id": "chatcmpl_test", "neuralops": {"decision": "allow", "traceId": "tr_gateway_test"}})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(api_key="nop_sk_secret_value", base_url="https://neuralops.example")

    result = client.chat_completions(messages=[{"role": "user", "content": "hello"}], model="test-model")

    assert result["neuralops"]["traceId"] == "tr_gateway_test"
    request, timeout = calls[0]
    assert request.full_url == "https://neuralops.example/api/gateway/openai/v1/chat/completions"
    assert request.get_method() == "POST"
    assert request.get_header("X-neuralops-key") == "nop_sk_secret_value"
    assert json.loads(request.data.decode("utf-8"))["messages"][0]["content"] == "hello"
    assert timeout == 10.0


def test_python_sdk_preserves_legacy_positional_api_key_constructor() -> None:
    client = NeuralOpsClient("nop_sk_existing_key", "https://legacy.neuralops.example", 7.5)

    assert client.api_key == "nop_sk_existing_key"
    assert client.base_url == "https://legacy.neuralops.example"
    assert client.timeout_seconds == 7.5
    assert client.agent_credential is None


def test_python_sdk_sends_batch_traces_with_idempotency_keys(monkeypatch) -> None:
    calls: list[Any] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        calls.append((request, timeout))
        return FakeResponse({"accepted": 1, "duplicates": 1, "items": [{"trace": {"id": "tr_one"}}, {"trace": {"id": "tr_one"}}]})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(api_key="nop_sk_secret_value", base_url="https://neuralops.example")

    result = client.ingest_traces(
        [
            {
                "session": "sess_batch",
                "environment": "prod",
                "model": "gpt-test",
                "tokens": 42,
                "latencyMs": 120,
                "costUsd": 0,
                "status": "success",
                "score": 1,
                "prompt": "hello",
                "output": "world",
                "idempotencyKey": "evt_001",
            }
        ]
    )

    assert result["accepted"] == 1
    request, _timeout = calls[0]
    assert request.full_url == "https://neuralops.example/api/traces/batch"
    assert json.loads(request.data.decode("utf-8"))["traces"][0]["idempotencyKey"] == "evt_001"


def test_python_sdk_gateway_errors_do_not_include_full_api_key(monkeypatch) -> None:
    def fake_urlopen(_request, timeout):  # noqa: ANN001
        assert timeout == 10.0
        raise HTTPError("https://neuralops.example/api/gateway/openai/v1/chat/completions", 403, "Forbidden", {}, None)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(api_key="nop_sk_secret_value", base_url="https://neuralops.example")

    try:
        client.chat_completions(messages=[{"role": "user", "content": "unsafe"}])
    except NeuralOpsError as exc:
        assert "nop_sk_secret_value" not in str(exc)
        assert "HTTP 403" in str(exc)
    else:
        raise AssertionError("Expected NeuralOpsError")


def test_python_trace_function_fails_open_when_ingest_fails() -> None:
    class BrokenClient:
        def ingest_trace(self, **_kwargs):  # noqa: ANN001
            raise NeuralOpsError("backend down")

    result = trace_function(
        BrokenClient(),
        "checkout-agent",
        lambda: "operation completed",
        session="sess_py_trace",
        environment="staging",
        prompt="Run checkout agent.",
    )

    assert result == "operation completed"


def test_python_wrap_openai_captures_successful_chat_call() -> None:
    traces: list[dict[str, Any]] = []

    class CaptureClient:
        def ingest_trace(self, **kwargs):  # noqa: ANN001
            traces.append(kwargs)
            return {"trace": {"id": "tr_py_wrap"}}

    class FakeResponse:
        model = "gpt-test"
        usage = {"total_tokens": 31}
        choices = [{"message": {"content": "Safe wrapped output."}}]

    class FakeCompletions:
        def create(self, **_kwargs):  # noqa: ANN001
            return FakeResponse()

    class FakeOpenAI:
        class Chat:
            completions = FakeCompletions()

        chat = Chat()

    wrapped = wrap_openai(CaptureClient(), FakeOpenAI(), session="sess_py_openai", environment="prod")
    result = wrapped.chat.completions.create(model="gpt-test", messages=[{"role": "user", "content": "hello"}])

    assert result is not None
    assert traces[0]["session"] == "sess_py_openai"
    assert traces[0]["model"] == "gpt-test"
    assert traces[0]["tokens"] == 31
    assert traces[0]["status"] == "success"
    assert "hello" in traces[0]["prompt"]
    assert traces[0]["output"] == "Safe wrapped output."


def _agent_action(**overrides: Any) -> dict[str, Any]:
    action: dict[str, Any] = {
        "identity_id": "agent_identity_1",
        "action": AGENT_ACTION_METADATA_READ,
        "tool_category": AGENT_TOOL_CATEGORY_METADATA,
        "operation": "traces.list",
        "context_hash": f"sha256:{'a' * 64}",
        "content_hash": f"sha256:{'b' * 64}",
        "provider": "internal",
    }
    action.update(overrides)
    return action


def _canonical_authorize_lease(metadata: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    lease: dict[str, Any] = {
        "id": "agent_lease_valid",
        "identityId": metadata["identity_id"],
        "action": metadata["action"],
        "toolCategory": metadata["tool_category"],
        "operation": metadata["operation"],
        "contextHash": metadata["context_hash"],
        "contentHash": metadata["content_hash"],
        "provider": metadata["provider"],
        "environment": metadata.get("environment", "staging"),
        "risk": "low" if metadata["action"] == AGENT_ACTION_METADATA_READ else "high",
        "status": "active",
        "idempotencyKey": metadata.get("idempotency_key", "server-generated"),
        "createdAt": "2026-07-16T00:00:00Z",
        "expiresAt": "2026-07-16T00:10:00Z",
    }
    if metadata.get("model") is not None:
        lease["model"] = metadata["model"]
    lease.update(overrides)
    return lease


def _canonical_approval(metadata: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    approval: dict[str, Any] = {
        "id": "agent_approval_valid",
        "identityId": metadata["identity_id"],
        "action": metadata["action"],
        "toolCategory": metadata["tool_category"],
        "operation": metadata["operation"],
        "contextHash": metadata["context_hash"],
        "contentHash": metadata["content_hash"],
        "provider": metadata["provider"],
        "environment": metadata.get("environment", "staging"),
        "risk": "high",
        "status": "pending",
        "idempotencyKey": metadata.get("idempotency_key", "server-generated"),
        "requestedBy": metadata["identity_id"],
        "createdAt": "2026-07-16T00:00:00Z",
        "expiresAt": "2026-07-16T00:10:00Z",
    }
    if metadata.get("model") is not None:
        approval["model"] = metadata["model"]
    approval.update(overrides)
    return approval


@pytest.mark.parametrize(
    ("case", "invalid_lease_factory"),
    [
        ("string lease", lambda action: "agent_lease_forged"),
        ("empty lease", lambda action: {}),
        ("missing id", lambda action: {k: v for k, v in _canonical_authorize_lease(action).items() if k != "id"}),
        ("invalid id", lambda action: _canonical_authorize_lease(action, id=42)),
        ("missing status", lambda action: {k: v for k, v in _canonical_authorize_lease(action).items() if k != "status"}),
        ("invalid status", lambda action: _canonical_authorize_lease(action, status="revoked")),
        *[
            (
                f"mismatched {wire_field}",
                lambda action, field=wire_field: _canonical_authorize_lease(action, **{field: f"wrong-{field}"}),
            )
            for wire_field in (
                "identityId", "action", "toolCategory", "operation", "contextHash",
                "contentHash", "provider", "environment", "model",
            )
        ],
    ],
    ids=lambda value: value if isinstance(value, str) else None,
)
def test_python_retries_json_valid_noncanonical_allow_with_same_key(
    monkeypatch, case: str, invalid_lease_factory: Any
) -> None:
    del case
    calls: list[dict[str, Any]] = []
    action = _agent_action(environment="staging", model="ops-reader-v1")

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        wire_request = json.loads(request.data.decode("utf-8"))
        calls.append(wire_request)
        if len(calls) == 1:
            lease = invalid_lease_factory(action)
        else:
            replay_action = {**action, "idempotency_key": wire_request["idempotencyKey"]}
            lease = _canonical_authorize_lease(replay_action)
        return FakeResponse({"decision": "allow", "reason": "Authorized", "lease": lease})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )

    lease = client.authorize_action(**action)
    assert lease["id"] == "agent_lease_valid"
    assert len(calls) == 2
    assert calls[0]["idempotencyKey"] == calls[1]["idempotencyKey"]


def test_python_retries_unsafe_approval_projection_before_approval_required(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        calls.append(json.loads(request.data.decode("utf-8")))
        approval = (
            {"id": {}, "status": "pending", "reason": "private"}
            if len(calls) == 1
            else {"id": "agent_approval_valid", "status": "pending", "reason": "private"}
        )
        return FakeResponse({"decision": "review", "reason": "Explicit approval required", "approval": approval})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.authorize_action(
            **_agent_action(action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL, operation="exec")
        )

    assert raised.value.code == "approval_required"
    assert raised.value.approval == {"id": "agent_approval_valid", "status": "pending"}
    assert "private" not in repr(raised.value.__dict__)
    assert len(calls) == 2
    assert calls[0]["idempotencyKey"] == calls[1]["idempotencyKey"]


def test_python_noncanonical_allow_exhaustion_returns_sanitized_backend_unavailable(monkeypatch) -> None:
    calls = 0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        del timeout
        nonlocal calls
        calls += 1
        return FakeResponse({
            "decision": "allow",
            "reason": "private backend detail",
            "lease": {"id": {}, "status": "active", "secret": "nop_agent_secret_value"},
        })

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.authorize_action(**_agent_action())

    assert raised.value.code == "backend_unavailable"
    assert "private backend detail" not in str(raised.value)
    assert "nop_agent_secret_value" not in repr(raised.value.__dict__)
    assert calls == 2


def test_python_agent_control_retries_warming_with_same_key_and_metadata_only(monkeypatch) -> None:
    calls: list[Any] = []
    action = _agent_action(prompt="do not retain", tool_args={"api_key": "provider-secret"})

    def fake_urlopen(request, timeout):  # noqa: ANN001
        calls.append((request, timeout))
        if len(calls) == 1:
            raise HTTPError(request.full_url, 503, "warming", {}, None)
        wire_request = json.loads(request.data.decode("utf-8"))
        lease = _canonical_authorize_lease(
            {**action, "idempotency_key": wire_request["idempotencyKey"]}, id="agent_lease_1"
        )
        return FakeResponse({"decision": "allow", "reason": "Authorized", "lease": lease})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        api_key="nop_sk_existing_key",
        agent_credential="nop_agent_secret_value",
        base_url="https://neuralops.example",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )

    result = client.authorize_action(**action)

    assert result["id"] == "agent_lease_1"
    assert len(calls) == 2
    first_request = calls[0][0]
    second_request = calls[1][0]
    assert first_request.get_header("X-neuralops-agent-key") == "nop_agent_secret_value"
    assert first_request.get_header("X-neuralops-key") is None
    assert first_request.get_header("Idempotency-key") == second_request.get_header("Idempotency-key")
    body = json.loads(first_request.data.decode("utf-8"))
    assert body["idempotencyKey"] == first_request.get_header("Idempotency-key")
    assert set(body) == {"identityId", "action", "toolCategory", "operation", "contextHash", "contentHash", "idempotencyKey", "provider"}
    assert "do not retain" not in first_request.data.decode("utf-8")
    assert "provider-secret" not in first_request.data.decode("utf-8")


def test_python_agent_control_fails_closed_on_review_without_retry(monkeypatch) -> None:
    calls = 0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        assert timeout == 10.0
        nonlocal calls
        calls += 1
        return FakeResponse({
            "decision": "review",
            "reason": "Explicit approval required",
            "approval": {"id": "agent_approval_1", "status": "pending"},
        })

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(api_key="nop_sk_existing_key", agent_credential="nop_agent_secret_value")

    try:
        client.authorize_action(**_agent_action(action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL, operation="exec"))
    except NeuralOpsAuthorizationError as exc:
        assert exc.code == "approval_required"
        assert exc.approval == {"id": "agent_approval_1", "status": "pending"}
    else:
        raise AssertionError("Expected NeuralOpsAuthorizationError")
    assert calls == 1


def test_python_high_risk_authorization_exposes_safe_generated_key_for_approval_retry(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []
    action = _agent_action(action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL, operation="exec")

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        calls.append(json.loads(request.data.decode("utf-8")))
        if len(calls) == 1:
            return FakeResponse(
                {
                    "decision": "review",
                    "reason": "Explicit approval required",
                    "approval": {
                        "id": "agent_approval_1",
                        "status": "pending",
                "evidenceHash": f"sha256:{'a' * 64}",
                        "reason": "private operator context",
                    },
                }
            )
        return FakeResponse(
            {
                "decision": "allow",
                "reason": "Authorized",
                "lease": _canonical_authorize_lease(
                    {**action, "idempotency_key": calls[-1]["idempotencyKey"]}, id="agent_lease_1"
                ),
            }
        )

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(agent_credential="nop_agent_secret_value")
    try:
        client.authorize_action(**action)
    except NeuralOpsAuthorizationError as exc:
        retry_key = exc.idempotency_key
        assert retry_key.startswith("nop_action_")
        assert exc.approval == {"id": "agent_approval_1", "status": "pending"}
        assert "private-evidence" not in repr(exc.__dict__)
        assert "private operator context" not in repr(exc.__dict__)
    else:
        raise AssertionError("Expected NeuralOpsAuthorizationError")

    lease = client.authorize_action(**action, idempotency_key=retry_key)
    assert lease["id"] == "agent_lease_1"
    assert calls[0]["idempotencyKey"] == retry_key
    assert calls[1]["idempotencyKey"] == retry_key


def test_python_agent_control_approval_and_lease_lifecycle_redacts_errors(monkeypatch) -> None:
    calls: list[Any] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        assert timeout == 10.0
        calls.append(request)
        wire_request = json.loads(request.data.decode("utf-8"))
        source = {
            "identity_id": wire_request["identityId"], "action": wire_request["action"],
            "tool_category": wire_request["toolCategory"], "operation": wire_request["operation"],
            "context_hash": wire_request["contextHash"], "content_hash": wire_request["contentHash"],
            "provider": wire_request["provider"], "idempotency_key": wire_request["idempotencyKey"],
        }
        if request.full_url.endswith("/approvals"):
            return FakeResponse(_canonical_approval(source, id="agent_approval_1"))
        if request.full_url.endswith("/leases/validate"):
            return FakeResponse(_canonical_authorize_lease(source, id="agent_lease_1"))
        raise HTTPError(request.full_url, 403, "nop_agent_secret_value raw prompt", {}, None)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(api_key="nop_sk_existing_key", agent_credential="nop_agent_secret_value", retry_max_attempts=4)
    binding = _agent_action(idempotency_key="action-fixed-key", lease_id="agent_lease_1")

    assert client.request_approval(**binding)["id"] == "agent_approval_1"
    assert client.validate_lease(**binding)["status"] == "active"
    try:
        client.consume_lease(**binding)
    except NeuralOpsAuthorizationError as exc:
        assert exc.status == 403
        assert "nop_agent_secret_value" not in str(exc)
        assert "raw prompt" not in str(exc)
        assert exc.__cause__ is None
        assert exc.__context__ is None
    else:
        raise AssertionError("Expected NeuralOpsAuthorizationError")
    assert len(calls) == 3


@pytest.mark.parametrize(
    ("case", "invalid_factory"),
    [
        ("empty object", lambda lease: {}),
        ("wrong id type", lambda lease: {**lease, "id": 42}),
        ("wrong status", lambda lease: {**lease, "status": "revoked"}),
        ("wrong lease id", lambda lease: {**lease, "id": "agent_lease_other"}),
        ("wrong identity binding", lambda lease: {**lease, "identityId": "agent_identity_other"}),
        ("wrong provider binding", lambda lease: {**lease, "provider": "other-provider"}),
    ],
)
def test_python_validate_retries_noncanonical_response_with_same_key(
    monkeypatch, case: str, invalid_factory: Any
) -> None:
    del case
    binding = _agent_action(
        action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL,
        operation="exec", environment="staging", model="ops-runner-v1",
        idempotency_key="lifecycle-fixed-key", lease_id="agent_lease_1",
    )
    canonical = _canonical_authorize_lease(binding, id=binding["lease_id"])
    calls: list[dict[str, Any]] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        calls.append(json.loads(request.data.decode("utf-8")))
        return FakeResponse(invalid_factory(canonical) if len(calls) == 1 else canonical)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value", retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )
    assert client.validate_lease(**binding)["id"] == binding["lease_id"]
    assert len(calls) == 2
    assert calls[0]["idempotencyKey"] == calls[1]["idempotencyKey"]


def test_python_approval_retries_mismatched_binding_with_same_key(monkeypatch) -> None:
    binding = _agent_action(
        action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL,
        operation="exec", environment="staging", model="ops-runner-v1",
        idempotency_key="approval-fixed-key",
    )
    canonical = _canonical_approval(binding)
    calls: list[dict[str, Any]] = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        calls.append(json.loads(request.data.decode("utf-8")))
        return FakeResponse({**canonical, "action": "forged-action"} if len(calls) == 1 else canonical)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value", retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )
    assert client.request_approval(**binding)["id"] == canonical["id"]
    assert len(calls) == 2
    assert calls[0]["idempotencyKey"] == calls[1]["idempotencyKey"]


@pytest.mark.parametrize(
    "invalid_response",
    [
        {},
        {"id": 42, "status": "consumed"},
        {"id": "agent_lease_other", "status": "consumed"},
        {"id": "agent_lease_1", "status": "active"},
    ],
)
def test_python_consume_fails_closed_on_noncanonical_success_without_replay(
    monkeypatch, invalid_response: dict[str, Any]
) -> None:
    calls = 0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        del timeout
        nonlocal calls
        calls += 1
        return FakeResponse(invalid_response)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value", retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )
    binding = _agent_action(
        action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL,
        operation="exec", idempotency_key="consume-fixed-key", lease_id="agent_lease_1",
    )
    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.consume_lease(**binding)
    assert raised.value.code == "backend_unavailable"
    assert "nop_agent_secret_value" not in repr(raised.value.__dict__)
    assert calls == 1


def test_python_consume_does_not_replay_when_delivery_outcome_is_unknown(monkeypatch) -> None:
    calls = 0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        del timeout
        nonlocal calls
        calls += 1
        raise OSError("connection reset after private response")

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value", retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )
    binding = _agent_action(
        action=AGENT_ACTION_SHELL, tool_category=AGENT_TOOL_CATEGORY_SHELL,
        operation="exec", idempotency_key="consume-network-key", lease_id="agent_lease_1",
    )
    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.consume_lease(**binding)
    assert raised.value.code == "backend_unavailable"
    assert "private response" not in str(raised.value)
    assert calls == 1


def test_python_agent_control_network_exhaustion_fails_closed_and_redacts(monkeypatch) -> None:
    calls = 0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        assert timeout == 10.0
        nonlocal calls
        calls += 1
        raise OSError("network failure nop_agent_secret_value")

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        api_key="",
        agent_credential="nop_agent_secret_value",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )
    try:
        client.authorize_action(**_agent_action())
    except NeuralOpsAuthorizationError as exc:
        assert exc.code == "backend_unavailable"
        assert "nop_agent_secret_value" not in str(exc)
        assert exc.__cause__ is None
        assert exc.__context__ is None
    else:
        raise AssertionError("Expected NeuralOpsAuthorizationError")
    assert calls == 2


def test_python_agent_control_caps_each_request_to_remaining_retry_deadline(monkeypatch) -> None:
    observed_timeout = 0.0

    def fake_urlopen(_request, timeout):  # noqa: ANN001
        nonlocal observed_timeout
        observed_timeout = timeout
        raise OSError("network unavailable")

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value",
        timeout_seconds=10,
        retry_max_seconds=2,
        retry_max_attempts=1,
    )
    try:
        client.authorize_action(**_agent_action())
    except NeuralOpsAuthorizationError:
        pass
    else:
        raise AssertionError("Expected NeuralOpsAuthorizationError")
    assert 0 < observed_timeout <= 2


def test_python_exports_the_backend_canonical_agent_action_contract() -> None:
    assert AGENT_ACTION_METADATA_READ == "metadata_read"
    assert AGENT_TOOL_CATEGORY_METADATA == "metadata"
    assert AGENT_ACTION_SHELL == "shell"
    assert AGENT_TOOL_CATEGORY_SHELL == "shell"


def test_python_retries_truncated_success_with_same_idempotency_key(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []
    action = _agent_action(action=AGENT_ACTION_METADATA_READ, tool_category=AGENT_TOOL_CATEGORY_METADATA)

    class TruncatedResponse(FakeResponse):
        def read(self) -> bytes:
            return b'{"decision":"allow","lease":'

    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        calls.append(json.loads(request.data.decode("utf-8")))
        if len(calls) == 1:
            return TruncatedResponse({})
        lease = _canonical_authorize_lease(
            {**action, "idempotency_key": calls[-1]["idempotencyKey"]}, id="agent_lease_replayed"
        )
        return FakeResponse({"decision": "allow", "reason": "Authorized", "lease": lease})

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(
        agent_credential="nop_agent_secret_value",
        retry_max_attempts=2,
        retry_initial_delay_seconds=0,
    )

    lease = client.authorize_action(**action)

    assert lease["id"] == "agent_lease_replayed"
    assert calls[0]["idempotencyKey"] == calls[1]["idempotencyKey"]


def test_python_truncated_success_exhaustion_fails_closed_and_redacts(monkeypatch) -> None:
    class TruncatedResponse(FakeResponse):
        def read(self) -> bytes:
            return b'{"private":"nop_agent_secret_value"'

    monkeypatch.setattr("neuralops.urlopen", lambda _request, timeout: TruncatedResponse({}))
    client = NeuralOpsClient(agent_credential="nop_agent_secret_value", retry_max_attempts=1)

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.authorize_action(
            **_agent_action(action=AGENT_ACTION_METADATA_READ, tool_category=AGENT_TOOL_CATEGORY_METADATA)
        )

    assert raised.value.code == "backend_unavailable"
    assert "private" not in str(raised.value)
    assert "nop_agent_secret_value" not in str(raised.value)
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None


def test_python_retryable_http_exhaustion_discards_raw_transport_exception(monkeypatch) -> None:
    def fake_urlopen(request, timeout):  # noqa: ANN001
        del timeout
        raise HTTPError(request.full_url, 503, "private backend warming detail", {}, None)

    monkeypatch.setattr("neuralops.urlopen", fake_urlopen)
    client = NeuralOpsClient(agent_credential="nop_agent_secret_value", retry_max_attempts=1)

    with pytest.raises(NeuralOpsAuthorizationError) as raised:
        client.authorize_action(**_agent_action())

    assert raised.value.code == "backend_unavailable"
    assert raised.value.status == 503
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None
    assert "private backend warming detail" not in repr(raised.value.__dict__)
