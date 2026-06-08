from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Callable, Literal, TypeVar
from urllib.error import HTTPError
from urllib.request import Request, urlopen


TraceStatus = Literal["success", "warning", "failed", "blocked"]
Environment = Literal["prod", "staging", "dev"]
T = TypeVar("T")


class NeuralOpsError(RuntimeError):
    """Raised when NeuralOps rejects or cannot accept a trace."""


@dataclass(frozen=True)
class NeuralOpsClient:
    api_key: str
    base_url: str = "http://localhost:8000"
    timeout_seconds: float = 10.0

    def __post_init__(self) -> None:
        if not self.api_key:
            raise ValueError("api_key is required")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))

    def ingest_trace(
        self,
        *,
        session: str,
        environment: Environment,
        model: str,
        tokens: int,
        latency_ms: int,
        cost_usd: float,
        status: TraceStatus,
        score: float,
        prompt: str,
        output: str,
        tool_calls: str | None = None,
        risk_flags: list[str] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "session": session,
            "environment": environment,
            "model": model,
            "tokens": tokens,
            "latencyMs": latency_ms,
            "costUsd": cost_usd,
            "status": status,
            "score": score,
            "prompt": prompt,
            "output": output,
            "riskFlags": risk_flags or [],
        }
        if tool_calls is not None:
            payload["toolCalls"] = tool_calls
        return self._post("/api/traces/ingest", payload)

    def ingest_traces(self, traces: list[dict[str, Any]]) -> dict[str, Any]:
        if not traces:
            raise ValueError("traces is required")
        return self._post("/api/traces/batch", {"traces": traces})

    def chat_completions(
        self,
        *,
        messages: list[dict[str, Any]],
        model: str | None = None,
        stream: bool = False,
        **options: Any,
    ) -> dict[str, Any]:
        if not messages:
            raise ValueError("messages is required")
        payload: dict[str, Any] = {
            **options,
            "messages": messages,
            "stream": stream,
        }
        if model is not None:
            payload["model"] = model
        return self._post("/api/gateway/openai/v1/chat/completions", payload)

    def trace_model_call(
        self,
        *,
        session: str,
        environment: Environment,
        model: str,
        prompt: str,
        call: Callable[[], T],
        tool_calls: str | None = None,
    ) -> T:
        start = time.perf_counter()
        try:
            result = call()
        except Exception as exc:
            self.ingest_trace(
                session=session,
                environment=environment,
                model=model,
                tokens=max(1, len(prompt) // 4),
                latency_ms=max(1, int((time.perf_counter() - start) * 1000)),
                cost_usd=0.0,
                status="failed",
                score=0.0,
                prompt=prompt,
                output=str(exc),
                tool_calls=tool_calls,
                risk_flags=["client_exception"],
            )
            raise

        self.ingest_trace(
            session=session,
            environment=environment,
            model=model,
            tokens=max(1, (len(prompt) + len(str(result))) // 4),
            latency_ms=max(1, int((time.perf_counter() - start) * 1000)),
            cost_usd=0.0,
            status="success",
            score=1.0,
            prompt=prompt,
            output=str(result),
            tool_calls=tool_calls,
        )
        return result

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-neuralops-key": self.api_key,
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            message = exc.read().decode("utf-8", errors="replace")
            raise NeuralOpsError(f"NeuralOps returned HTTP {exc.code}: {message}") from exc


def trace_function(
    client: Any,
    name: str,
    fn: Callable[[], T],
    *,
    session: str,
    environment: Environment = "staging",
    model: str | None = None,
    prompt: str = "",
    tool_calls: str | None = None,
    strict: bool = False,
) -> T:
    start = time.perf_counter()
    trace_model = model or name
    trace_prompt = prompt or f"trace_function:{name}"
    try:
        result = fn()
    except Exception as exc:
        _safe_ingest(
            client,
            strict=False,
            session=session,
            environment=environment,
            model=trace_model,
            tokens=_estimate_tokens(trace_prompt),
            latency_ms=_elapsed_ms(start),
            cost_usd=0.0,
            status="failed",
            score=0.0,
            prompt=trace_prompt,
            output=str(exc),
            tool_calls=tool_calls,
            risk_flags=["sdk-captured-error"],
        )
        raise

    _safe_ingest(
        client,
        strict=strict,
        session=session,
        environment=environment,
        model=trace_model,
        tokens=_estimate_tokens(f"{trace_prompt}\n{result}"),
        latency_ms=_elapsed_ms(start),
        cost_usd=0.0,
        status="success",
        score=1.0,
        prompt=trace_prompt,
        output=str(result),
        tool_calls=tool_calls,
        risk_flags=["sdk-trace-function"],
    )
    return result


def wrap_openai(
    neuralops_client: Any,
    openai_client: Any,
    *,
    session: str,
    environment: Environment = "staging",
    strict: bool = False,
) -> Any:
    original_create = openai_client.chat.completions.create

    class WrappedCompletions:
        def create(self, **kwargs: Any) -> Any:
            start = time.perf_counter()
            prompt = _messages_text(kwargs.get("messages", []))
            model = str(kwargs.get("model") or "openai-compatible")
            try:
                response = original_create(**kwargs)
            except Exception as exc:
                _safe_ingest(
                    neuralops_client,
                    strict=False,
                    session=session,
                    environment=environment,
                    model=model,
                    tokens=_estimate_tokens(prompt),
                    latency_ms=_elapsed_ms(start),
                    cost_usd=0.0,
                    status="failed",
                    score=0.0,
                    prompt=prompt,
                    output=str(exc),
                    risk_flags=["sdk-captured-error"],
                )
                raise

            output = _response_text(response)
            _safe_ingest(
                neuralops_client,
                strict=strict,
                session=session,
                environment=environment,
                model=str(getattr(response, "model", model) or model),
                tokens=_response_tokens(response) or _estimate_tokens(f"{prompt}\n{output}"),
                latency_ms=_elapsed_ms(start),
                cost_usd=0.0,
                status="success",
                score=1.0,
                prompt=prompt,
                output=output,
                risk_flags=["sdk-openai-wrapper"],
            )
            return response

    class WrappedChat:
        completions = WrappedCompletions()

    class WrappedClient:
        chat = WrappedChat()

    return WrappedClient()


class NeuralOpsFastAPIMiddleware:
    def __init__(
        self,
        app: Any,
        client: NeuralOpsClient,
        *,
        service_name: str = "fastapi-app",
        environment: Environment = "prod",
        strict: bool = False,
    ) -> None:
        self.app = app
        self.client = client
        self.service_name = service_name
        self.environment = environment
        self.strict = strict

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status_code = 500

        async def send_wrapper(message: dict[str, Any]) -> None:
            nonlocal status_code
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status", 500))
            await send(message)

        await self.app(scope, receive, send_wrapper)
        path = str(scope.get("path", "/"))
        _safe_ingest(
            self.client,
            strict=self.strict,
            session=str(scope.get("headers", []))[:32] or f"req-{int(time.time())}",
            environment=self.environment,
            model=self.service_name,
            tokens=1,
            latency_ms=_elapsed_ms(start),
            cost_usd=0.0,
            status="success" if status_code < 500 else "failed",
            score=1.0 if status_code < 500 else 0.0,
            prompt=f"{scope.get('method', 'GET')} {path}",
            output=f"HTTP {status_code}",
            tool_calls="fastapi.middleware",
            risk_flags=["sdk-fastapi-middleware"],
        )


def _safe_ingest(client: Any, strict: bool, **kwargs: Any) -> None:
    try:
        client.ingest_trace(**kwargs)
    except Exception:
        if strict:
            raise


def _estimate_tokens(text: str) -> int:
    return max(1, len(str(text).split()) + len(str(text)) // 5)


def _elapsed_ms(start: float) -> int:
    return max(1, int((time.perf_counter() - start) * 1000))


def _messages_text(messages: list[dict[str, Any]]) -> str:
    return "\n".join(f"{message.get('role', 'message')}: {message.get('content', '')}" for message in messages)


def _response_text(response: Any) -> str:
    choices = getattr(response, "choices", None)
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else getattr(choices[0], "message", None)
        if isinstance(message, dict) and message.get("content") is not None:
            return str(message["content"])
        if getattr(message, "content", None) is not None:
            return str(message.content)
    return str(response)


def _response_tokens(response: Any) -> int:
    usage = getattr(response, "usage", None)
    if isinstance(usage, dict):
        return int(usage.get("total_tokens", 0) or 0)
    if usage is not None and getattr(usage, "total_tokens", None):
        return int(usage.total_tokens)
    return 0


__all__ = ["NeuralOpsClient", "NeuralOpsError", "NeuralOpsFastAPIMiddleware", "trace_function", "wrap_openai"]
