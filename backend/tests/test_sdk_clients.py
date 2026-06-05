from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from neuralops import NeuralOpsClient, NeuralOpsError  # noqa: E402


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
