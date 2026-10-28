from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import wraps
import hashlib
from http.client import IncompleteRead
import inspect
import json
import math
import time
from typing import Any, Callable, Literal, TypeVar
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4


TraceStatus = Literal["success", "warning", "failed", "blocked"]
Environment = Literal["prod", "staging", "dev"]
T = TypeVar("T")

AGENT_ACTION_METADATA_READ = "metadata_read"
AGENT_TOOL_CATEGORY_METADATA = "metadata"
AGENT_ACTION_SHELL = "shell"
AGENT_TOOL_CATEGORY_SHELL = "shell"


class NeuralOpsError(RuntimeError):
    """Raised when NeuralOps rejects or cannot accept a trace."""


class NeuralOpsAuthorizationError(NeuralOpsError):
    """Raised when an agent action cannot be safely authorized."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "authorization_failed",
        status: int | None = None,
        approval: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.approval = approval
        self.idempotency_key = idempotency_key


def guard_openai_tool(
    client: Any,
    function: Callable[..., Any],
    *,
    identity_id: str,
    action: str,
    tool_category: str,
    provider: str,
    environment: Environment = "staging",
    tool_name: str | None = None,
    idempotency_key: Callable[[Any, dict[str, Any]], str] | None = None,
    create_approval_preview: Callable[[dict[str, Any]], dict[str, str]] | None = None,
) -> Any:
    """Wrap an OpenAI Agents SDK function tool with NeuralOps authorization.

    The tool arguments are hashed locally and are never sent by this adapter.
    NeuralOps must authorize and atomically consume the resulting lease before
    the wrapped function is invoked.
    """
    try:
        from agents import function_tool
        from agents.tool_context import ToolContext
    except ImportError as exc:
        raise ImportError(
            "OpenAI Agents SDK integration requires the optional extra: "
            "pip install neuralops-sdk[openai-agents]"
        ) from exc

    if not callable(function):
        raise TypeError("function must be callable")
    if not all(isinstance(value, str) and value.strip() for value in (identity_id, action, tool_category, provider)):
        raise ValueError("identity_id, action, tool_category, and provider are required")

    signature = inspect.signature(function)
    context_parameter_name = next(
        (parameter.name for parameter in signature.parameters.values() if _is_openai_context_parameter(parameter)),
        None,
    )
    synthetic_context = context_parameter_name is None
    if synthetic_context:
        context_parameter_name = "_neuralops_tool_context"
        while context_parameter_name in signature.parameters:
            context_parameter_name += "_"
        tool_signature = signature.replace(
            parameters=(
                inspect.Parameter(
                    context_parameter_name,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    annotation=ToolContext,
                ),
                *signature.parameters.values(),
            )
        )
    else:
        first_parameter = next(iter(signature.parameters.values()), None)
        if first_parameter is None or first_parameter.name != context_parameter_name:
            raise ValueError("OpenAI tool context must be the first function parameter")
        tool_signature = signature
    name = tool_name or function.__name__
    if not name or len(name) > 120:
        raise ValueError("tool_name must contain 1 to 120 characters")
    definition = "\n".join((f"{function.__module__}.{function.__qualname__}", str(signature), inspect.getdoc(function) or ""))
    context_hash = f"sha256:{hashlib.sha256(definition.encode('utf-8')).hexdigest()}"

    @wraps(function)
    async def guarded(*args: Any, **kwargs: Any) -> Any:
        bound = tool_signature.bind(*args, **kwargs)
        bound.apply_defaults()
        tool_context = bound.arguments.get(context_parameter_name)
        if synthetic_context:
            original_kwargs = dict(kwargs)
            original_kwargs.pop(context_parameter_name, None)
            original_args = args[1:] if args else args
        else:
            original_kwargs = kwargs
            original_args = args
        function_bound = signature.bind(*original_args, **original_kwargs)
        function_bound.apply_defaults()
        action_arguments = {
            parameter_name: value
            for parameter_name, value in function_bound.arguments.items()
            if not _is_openai_context_parameter(signature.parameters[parameter_name])
        }
        canonical_arguments = json.dumps(
            _json_safe_tool_arguments(action_arguments),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        content_hash = f"sha256:{hashlib.sha256(canonical_arguments.encode('utf-8')).hexdigest()}"
        binding = {
            "identity_id": identity_id,
            "action": action,
            "tool_category": tool_category,
            "operation": name,
            "context_hash": context_hash,
            "content_hash": content_hash,
            "provider": provider,
            "environment": environment,
        }

        stable_key: str | None = None
        if idempotency_key is not None:
            try:
                callback_key = await _run_openai_callback(idempotency_key, tool_context, action_arguments)
            except Exception:
                raise NeuralOpsAuthorizationError(
                    "NeuralOps idempotency key generation failed; action denied",
                    code="invalid_metadata",
                ) from None
            if not isinstance(callback_key, str) or not callback_key.strip():
                raise NeuralOpsAuthorizationError(
                    "NeuralOps idempotency callback must return a non-empty string; action denied",
                    code="invalid_metadata",
                )
            stable_key = _openai_idempotency_key(callback_key)
        else:
            call_id = getattr(tool_context, "tool_call_id", None)
            if isinstance(call_id, str) and call_id:
                stable_key = _openai_idempotency_key(call_id)
        if stable_key is not None:
            binding["idempotency_key"] = stable_key

        if (action, tool_category) != (AGENT_ACTION_METADATA_READ, AGENT_TOOL_CATEGORY_METADATA):
            policy = await asyncio.to_thread(client.get_approval_preview_policy, identity_id)
            if not isinstance(policy, dict) or policy.get("mode") not in {"metadata_only", "redacted_preview"}:
                raise NeuralOpsAuthorizationError(
                    "NeuralOps approval preview policy is invalid; action denied",
                    code="backend_unavailable",
                )
            if policy["mode"] == "redacted_preview" and create_approval_preview is not None:
                try:
                    preview = await _run_openai_callback(create_approval_preview, action_arguments)
                except Exception:
                    raise NeuralOpsAuthorizationError(
                        "NeuralOps approval preview generation failed; action denied",
                        code="invalid_metadata",
                    ) from None
                binding["approval_preview"] = _normalize_approval_preview(preview)

        lease = await asyncio.to_thread(client.authorize_action, **binding)
        lease_id = lease.get("id") if isinstance(lease, dict) else None
        lease_idempotency_key = lease.get("idempotencyKey") if isinstance(lease, dict) else None
        if (
            not isinstance(lease_id, str)
            or not lease_id
            or not isinstance(lease_idempotency_key, str)
            or not lease_idempotency_key
        ):
            raise NeuralOpsAuthorizationError(
                "NeuralOps returned an invalid authorization lease; action denied",
                code="backend_unavailable",
            )
        lease_binding = {
            **binding,
            "lease_id": lease_id,
            "idempotency_key": lease_idempotency_key,
        }
        await asyncio.to_thread(client.consume_lease, **lease_binding)

        if inspect.iscoroutinefunction(function):
            return await function(*function_bound.args, **function_bound.kwargs)
        result = await asyncio.to_thread(function, *function_bound.args, **function_bound.kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    guarded.__signature__ = tool_signature  # type: ignore[attr-defined]
    guarded.__annotations__ = {
        **getattr(function, "__annotations__", {}),
        **({context_parameter_name: ToolContext} if synthetic_context else {}),
    }
    return function_tool(
        guarded,
        name_override=name,
        description_override=inspect.getdoc(function) or "",
    )


def _is_openai_context_parameter(parameter: inspect.Parameter) -> bool:
    annotation = parameter.annotation
    annotation_name = getattr(annotation, "__name__", "")
    annotation_text = str(annotation)
    return annotation_name in {"RunContextWrapper", "ToolContext"} or any(
        context_name in annotation_text for context_name in ("RunContextWrapper", "ToolContext")
    )


def _openai_idempotency_key(stable_value: str) -> str:
    digest = hashlib.sha256(stable_value.encode("utf-8")).hexdigest()
    return f"nop_openai_{digest}"


async def _run_openai_callback(callback: Callable[..., Any], *args: Any) -> Any:
    if inspect.iscoroutinefunction(callback):
        return await callback(*args)
    result = await asyncio.to_thread(callback, *args)
    if inspect.isawaitable(result):
        return await result
    return result


def _json_safe_tool_arguments(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Tool arguments must contain finite numbers")
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe_tool_arguments(item) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: _json_safe_tool_arguments(item) for key, item in value.items()}
    raise TypeError("Tool arguments must be JSON-compatible to authorize safely")


@dataclass(frozen=True)
class NeuralOpsClient:
    api_key: str = ""
    base_url: str = "http://localhost:8000"
    timeout_seconds: float = 10.0
    agent_credential: str | None = None
    retry_max_seconds: float = 90.0
    retry_max_attempts: int | None = None
    retry_initial_delay_seconds: float = 0.25
    retry_max_delay_seconds: float = 5.0

    def __post_init__(self) -> None:
        if not self.api_key and not self.agent_credential:
            raise ValueError("api_key or agent_credential is required")
        if self.retry_max_seconds < 0 or self.retry_initial_delay_seconds < 0 or self.retry_max_delay_seconds < 0:
            raise ValueError("retry durations must be non-negative")
        if self.retry_max_attempts is not None and self.retry_max_attempts < 1:
            raise ValueError("retry_max_attempts must be positive")
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

    def authorize_action(self, **metadata: Any) -> dict[str, Any]:
        request_metadata = dict(metadata)
        request_metadata["idempotency_key"] = str(
            request_metadata.get("idempotency_key") or f"nop_action_{uuid4()}"
        )
        response = self._agent_control_post(
            "/api/agent-control/authorize",
            request_metadata,
            response_validator=_is_canonical_authorize_response,
        )
        if response["decision"] == "review":
            approval = response["approval"]
            raise NeuralOpsAuthorizationError(
                "NeuralOps denied authorization pending explicit approval",
                code="approval_required",
                approval={"id": approval["id"], "status": approval["status"]},
                idempotency_key=str(request_metadata["idempotency_key"]),
            )
        return response["lease"]

    def get_approval_preview_policy(self, identity_id: str) -> dict[str, str | None]:
        """Read the workspace policy before deciding whether to submit a preview."""
        if not self.agent_credential:
            raise NeuralOpsAuthorizationError(
                "NeuralOps agent_credential is required",
                code="credential_required",
            )
        if not isinstance(identity_id, str) or not identity_id.strip():
            raise NeuralOpsAuthorizationError(
                "NeuralOps agent identity is required",
                code="invalid_metadata",
            )
        request = Request(
            f"{self.base_url}/api/agent-control/agent-privacy-policy/{quote(identity_id, safe='')}",
            method="GET",
            headers={"x-neuralops-agent-key": self.agent_credential},
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                policy = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code in _RETRYABLE_AGENT_STATUSES:
                raise _agent_unavailable_error(exc.code) from exc
            raise NeuralOpsAuthorizationError(
                f"NeuralOps agent control returned HTTP {exc.code}",
                code="request_rejected",
                status=exc.code,
            ) from exc
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, IncompleteRead) as exc:
            raise _agent_unavailable_error() from exc
        if (
            not isinstance(policy, dict)
            or policy.get("mode") not in {"metadata_only", "redacted_preview"}
            or (policy.get("updatedAt") is not None and not isinstance(policy.get("updatedAt"), str))
            or not isinstance(policy.get("updatedBy"), str)
        ):
            raise _agent_unavailable_error()
        return {
            "mode": policy["mode"],
            "updatedAt": policy.get("updatedAt"),
            "updatedBy": policy["updatedBy"],
        }

    def request_approval(self, **metadata: Any) -> dict[str, Any]:
        return self._agent_control_post(
            "/api/agent-control/approvals", metadata,
            response_validator=_is_canonical_approval,
        )

    def validate_lease(self, **metadata: Any) -> dict[str, Any]:
        return self._agent_control_post(
            "/api/agent-control/leases/validate", metadata, include_lease=True,
            response_validator=lambda response, request: _is_canonical_bound_lease(
                response, request, expected_status="active"
            ),
        )

    def consume_lease(self, **metadata: Any) -> dict[str, Any]:
        return self._agent_control_post(
            "/api/agent-control/leases/consume", metadata, include_lease=True,
            response_validator=lambda response, request: _is_canonical_bound_lease(
                response, request, expected_status="consumed"
            ),
            retry_invalid_response=False,
            retry_request_failures=False,
        )

    def _agent_control_post(
        self,
        path: str,
        metadata: dict[str, Any],
        *,
        include_lease: bool = False,
        response_validator: Callable[[Any, dict[str, Any]], bool] | None = None,
        retry_invalid_response: bool = True,
        retry_request_failures: bool = True,
    ) -> dict[str, Any]:
        if not self.agent_credential:
            raise NeuralOpsAuthorizationError("NeuralOps agent_credential is required", code="credential_required")
        payload = _normalize_agent_metadata(metadata, include_lease=include_lease)
        idempotency_key = str(payload["idempotencyKey"])
        body = json.dumps(payload).encode("utf-8")
        started_at = time.monotonic()
        attempts = 0
        while True:
            attempts += 1
            sanitized_error: NeuralOpsAuthorizationError | None = None
            request = Request(
                f"{self.base_url}{path}",
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "x-neuralops-agent-key": self.agent_credential,
                    "Idempotency-Key": idempotency_key,
                },
            )
            try:
                remaining_seconds = max(0.001, self.retry_max_seconds - (time.monotonic() - started_at))
                request_timeout = min(self.timeout_seconds, remaining_seconds)
                with urlopen(request, timeout=request_timeout) as response:
                    try:
                        result = json.loads(response.read().decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError, IncompleteRead):
                        if retry_invalid_response and self._can_retry_agent_request(attempts, started_at):
                            self._wait_before_agent_retry(attempts, started_at)
                            continue
                        result = None
                        sanitized_error = _agent_unavailable_error()
                    if sanitized_error is not None:
                        raise sanitized_error
                    validator = response_validator or _is_record
                    if not validator(result, payload):
                        if retry_invalid_response and self._can_retry_agent_request(attempts, started_at):
                            self._wait_before_agent_retry(attempts, started_at)
                            continue
                        raise _agent_unavailable_error()
                    return result
            except HTTPError as exc:
                if (
                    retry_request_failures
                    and exc.code in _RETRYABLE_AGENT_STATUSES
                    and self._can_retry_agent_request(attempts, started_at)
                ):
                    self._wait_before_agent_retry(attempts, started_at)
                    continue
                if exc.code in _RETRYABLE_AGENT_STATUSES:
                    sanitized_error = _agent_unavailable_error(exc.code)
                else:
                    sanitized_error = NeuralOpsAuthorizationError(
                        f"NeuralOps agent control returned HTTP {exc.code}",
                        code="request_rejected",
                        status=exc.code,
                    )
            except NeuralOpsAuthorizationError:
                raise
            except OSError:
                if retry_request_failures and self._can_retry_agent_request(attempts, started_at):
                    self._wait_before_agent_retry(attempts, started_at)
                    continue
                sanitized_error = _agent_unavailable_error()
            if sanitized_error is not None:
                raise sanitized_error

    def _can_retry_agent_request(self, attempts: int, started_at: float) -> bool:
        attempts_available = self.retry_max_attempts is None or attempts < self.retry_max_attempts
        return attempts_available and time.monotonic() - started_at < self.retry_max_seconds

    def _wait_before_agent_retry(self, attempts: int, started_at: float) -> None:
        remaining = max(0.0, self.retry_max_seconds - (time.monotonic() - started_at))
        delay = min(
            self.retry_initial_delay_seconds * (2 ** max(0, attempts - 1)),
            self.retry_max_delay_seconds,
            remaining,
        )
        if delay > 0:
            time.sleep(delay)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.api_key:
            raise ValueError("api_key is required for telemetry and gateway operations")
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


_RETRYABLE_AGENT_STATUSES = {408, 425, 429, 502, 503, 504}
_AGENT_METADATA_FIELDS = {
    "identity_id": "identityId",
    "action": "action",
    "tool_category": "toolCategory",
    "operation": "operation",
    "context_hash": "contextHash",
    "content_hash": "contentHash",
    "provider": "provider",
    "environment": "environment",
    "model": "model",
    "timing_ms": "timingMs",
    "tokens": "tokens",
    "cost_usd": "costUsd",
    "status": "status",
    "policy_findings": "policyFindings",
    "approval_preview": "approvalPreview",
}


def _normalize_agent_metadata(metadata: dict[str, Any], *, include_lease: bool) -> dict[str, Any]:
    payload = {
        wire_name: metadata[source_name]
        for source_name, wire_name in _AGENT_METADATA_FIELDS.items()
        if source_name in metadata and metadata[source_name] is not None
    }
    for field in ("identityId", "action", "toolCategory", "operation", "contextHash", "contentHash", "provider"):
        if not isinstance(payload.get(field), str) or not payload[field]:
            raise NeuralOpsAuthorizationError(
                f'NeuralOps agent metadata field "{field}" is required',
                code="invalid_metadata",
            )
    supplied_key = metadata.get("idempotency_key", metadata.get("idempotencyKey"))
    payload["idempotencyKey"] = str(supplied_key or f"nop_action_{uuid4()}")
    if include_lease:
        lease_id = metadata.get("lease_id")
        if not isinstance(lease_id, str) or not lease_id:
            raise NeuralOpsAuthorizationError(
                'NeuralOps agent metadata field "leaseId" is required',
                code="invalid_metadata",
            )
        payload["leaseId"] = lease_id
    if "approvalPreview" in payload:
        payload["approvalPreview"] = _normalize_approval_preview(payload["approvalPreview"])
    return payload


def _normalize_approval_preview(preview: Any) -> dict[str, str]:
    allowed_fields = {"summary", "resource", "impact"}
    if not isinstance(preview, dict) or "summary" not in preview or set(preview) - allowed_fields:
        raise ValueError("Approval preview requires summary and may contain only resource and impact")
    normalized: dict[str, str] = {}
    for field in ("summary", "resource", "impact"):
        if field not in preview:
            continue
        value = preview[field]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Approval preview {field} must be a non-empty string")
        max_length = 160 if field == "resource" else 240
        if len(value) > max_length:
            raise ValueError(f"Approval preview {field} must be at most {max_length} characters")
        normalized[field] = value.strip()
    return normalized


def _agent_unavailable_error(status: int | None = None) -> NeuralOpsAuthorizationError:
    return NeuralOpsAuthorizationError(
        "NeuralOps agent control is unavailable; action denied",
        code="backend_unavailable",
        status=status,
    )


def _is_record(value: Any, _request: dict[str, Any] | None = None) -> bool:
    return isinstance(value, dict)


def _is_canonical_authorize_response(response: Any, request: dict[str, Any]) -> bool:
    if not isinstance(response, dict) or not isinstance(response.get("reason"), str) or not response["reason"]:
        return False
    if response.get("decision") == "review":
        approval = response.get("approval")
        return (
            isinstance(approval, dict)
            and isinstance(approval.get("id"), str)
            and bool(approval["id"])
            and approval.get("status") == "pending"
        )
    if response.get("decision") != "allow":
        return False
    lease = response.get("lease")
    if not isinstance(lease, dict):
        return False
    if not isinstance(lease.get("id"), str) or not lease["id"] or lease.get("status") != "active":
        return False
    for field in (
        "identityId", "action", "toolCategory", "operation", "contextHash",
        "contentHash", "provider", "idempotencyKey",
    ):
        if lease.get(field) != request.get(field):
            return False
    for field in ("environment", "model"):
        if field in request and lease.get(field) != request[field]:
            return False
    return lease.get("risk") in {"low", "high"}


def _has_canonical_binding(response: dict[str, Any], request: dict[str, Any]) -> bool:
    for field in (
        "identityId", "action", "toolCategory", "operation", "contextHash",
        "contentHash", "provider", "idempotencyKey",
    ):
        if response.get(field) != request.get(field):
            return False
    for field in ("environment", "model"):
        if field in request and response.get(field) != request[field]:
            return False
    return True


def _is_canonical_approval(response: Any, request: dict[str, Any]) -> bool:
    return (
        isinstance(response, dict)
        and isinstance(response.get("id"), str)
        and bool(response["id"])
        and response.get("status") == "pending"
        and response.get("risk") == "high"
        and response.get("environment") in {"prod", "staging", "dev"}
        and isinstance(response.get("requestedBy"), str)
        and bool(response["requestedBy"])
        and isinstance(response.get("createdAt"), str)
        and bool(response["createdAt"])
        and isinstance(response.get("expiresAt"), str)
        and bool(response["expiresAt"])
        and _has_canonical_binding(response, request)
    )


def _is_canonical_bound_lease(
    response: Any, request: dict[str, Any], *, expected_status: str
) -> bool:
    return (
        isinstance(response, dict)
        and isinstance(response.get("id"), str)
        and response["id"] == request.get("leaseId")
        and response.get("status") == expected_status
        and response.get("risk") in {"low", "high"}
        and response.get("environment") in {"prod", "staging", "dev"}
        and isinstance(response.get("createdAt"), str)
        and bool(response["createdAt"])
        and isinstance(response.get("expiresAt"), str)
        and bool(response["expiresAt"])
        and (
            expected_status != "consumed"
            or (isinstance(response.get("consumedAt"), str) and bool(response["consumedAt"]))
        )
        and _has_canonical_binding(response, request)
    )


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


__all__ = [
    "AGENT_ACTION_METADATA_READ",
    "AGENT_ACTION_SHELL",
    "AGENT_TOOL_CATEGORY_METADATA",
    "AGENT_TOOL_CATEGORY_SHELL",
    "NeuralOpsAuthorizationError",
    "NeuralOpsClient",
    "NeuralOpsError",
    "NeuralOpsFastAPIMiddleware",
    "guard_openai_tool",
    "trace_function",
    "wrap_openai",
]
