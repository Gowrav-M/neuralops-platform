from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from neuralops import NeuralOpsClient, NeuralOpsError, trace_function, wrap_openai  # noqa: E402


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
