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


__all__ = ["NeuralOpsClient", "NeuralOpsError"]

