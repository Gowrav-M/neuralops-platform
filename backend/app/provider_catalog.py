from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
import os
from secrets import token_hex
import time
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken

from .config import load_local_env
from .database import get_record, list_records, save_record
from .auth import auth_required, current_claims, workspace_id_from_claims
from .schemas import (
    ProviderConnection,
    ProviderConnectionCreate,
    ProviderConnectionDisableRequest,
    ProviderConnectionPatch,
    ProviderConnectionRotateKeyRequest,
    ProviderConnectionTestResult,
    ProviderPreset,
    ProviderStatus,
)

load_local_env()


PROVIDER_PRESETS: list[ProviderPreset] = [
    ProviderPreset(
        id="openai",
        label="OpenAI",
        category="frontier",
        baseUrl="https://api.openai.com/v1",
        defaultModel="gpt-4o-mini",
        supportsChat=True,
        supportsEmbeddings=True,
        supportsVision=True,
        notes=["OpenAI-compatible chat completions endpoint."],
    ),
    ProviderPreset(
        id="azure-openai",
        label="Azure OpenAI",
        category="cloud",
        baseUrl="https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
        defaultModel="gpt-4o-mini",
        notes=["Use a deployment-specific base URL and model/deployment name."],
    ),
    ProviderPreset(
        id="anthropic-compatible",
        label="Anthropic via OpenAI-Compatible Gateway",
        category="gateway",
        baseUrl="https://openrouter.ai/api/v1",
        defaultModel="anthropic/claude-sonnet-4.5",
        supportsVision=True,
        notes=["Use through OpenRouter, LiteLLM, Vercel AI Gateway, or another compatible gateway."],
    ),
    ProviderPreset(
        id="google-compatible",
        label="Google Gemini via OpenAI-Compatible Gateway",
        category="gateway",
        baseUrl="https://openrouter.ai/api/v1",
        defaultModel="google/gemini-2.5-flash",
        supportsVision=True,
        notes=["Use through an OpenAI-compatible gateway when direct Gemini syntax is not configured."],
    ),
    ProviderPreset(
        id="aws-bedrock-compatible",
        label="AWS Bedrock via Gateway",
        category="cloud",
        baseUrl="https://openrouter.ai/api/v1",
        defaultModel="anthropic/claude-sonnet-4.5",
        notes=["Route Bedrock models through OpenRouter, LiteLLM, Vercel AI Gateway, or an internal gateway."],
    ),
    ProviderPreset(
        id="vercel-ai-gateway",
        label="Vercel AI Gateway",
        category="gateway",
        baseUrl="https://ai-gateway.vercel.sh/v1",
        defaultModel="openai/gpt-4o-mini",
        supportsChat=True,
        supportsEmbeddings=True,
        supportsVision=True,
        notes=["Unified gateway with provider routing and fallbacks."],
    ),
    ProviderPreset(
        id="openrouter",
        label="OpenRouter",
        category="gateway",
        baseUrl="https://openrouter.ai/api/v1",
        defaultModel="openai/gpt-4o-mini",
        supportsChat=True,
        supportsVision=True,
        notes=["One OpenAI-compatible endpoint for many model providers."],
    ),
    ProviderPreset(
        id="litellm",
        label="LiteLLM Proxy",
        category="gateway",
        baseUrl="http://localhost:4000/v1",
        defaultModel="gpt-4o-mini",
        supportsChat=True,
        supportsEmbeddings=True,
        notes=["Use for internal enterprise routing, budgets, fallbacks, and provider normalization."],
    ),
    ProviderPreset(
        id="groq",
        label="Groq",
        category="open-source",
        baseUrl="https://api.groq.com/openai/v1",
        defaultModel="llama-3.3-70b-versatile",
        notes=["Fast OpenAI-compatible inference for supported open models."],
    ),
    ProviderPreset(
        id="nvidia",
        label="NVIDIA NIM",
        category="open-source",
        baseUrl="https://integrate.api.nvidia.com/v1",
        defaultModel="nvidia/llama-3.1-nemotron-70b-instruct",
        supportsChat=True,
        supportsEmbeddings=True,
        supportsVision=True,
        notes=["NVIDIA-hosted NIM endpoint using OpenAI-compatible APIs."],
    ),
    ProviderPreset(
        id="together",
        label="Together AI",
        category="open-source",
        baseUrl="https://api.together.xyz/v1",
        defaultModel="meta-llama/Llama-3.3-70B-Instruct-Turbo",
        supportsChat=True,
        supportsEmbeddings=True,
    ),
    ProviderPreset(
        id="fireworks",
        label="Fireworks AI",
        category="open-source",
        baseUrl="https://api.fireworks.ai/inference/v1",
        defaultModel="accounts/fireworks/models/llama-v3p3-70b-instruct",
        supportsChat=True,
        supportsEmbeddings=True,
    ),
    ProviderPreset(
        id="mistral",
        label="Mistral AI",
        category="frontier",
        baseUrl="https://api.mistral.ai/v1",
        defaultModel="mistral-large-latest",
        supportsChat=True,
        supportsEmbeddings=True,
    ),
    ProviderPreset(
        id="cohere",
        label="Cohere",
        category="frontier",
        baseUrl="https://api.cohere.com/v2",
        defaultModel="command-a-03-2025",
        supportsChat=True,
        supportsEmbeddings=True,
    ),
    ProviderPreset(
        id="deepseek",
        label="DeepSeek",
        category="frontier",
        baseUrl="https://api.deepseek.com/v1",
        defaultModel="deepseek-chat",
        supportsChat=True,
    ),
    ProviderPreset(
        id="ollama",
        label="Ollama Local",
        category="local",
        baseUrl="http://localhost:11434/v1",
        defaultModel="llama3.1",
        authType="none",
        supportsChat=True,
        notes=["Local OpenAI-compatible endpoint; no cloud key required."],
    ),
    ProviderPreset(
        id="vllm",
        label="vLLM Local/Private",
        category="local",
        baseUrl="http://localhost:8001/v1",
        defaultModel="meta-llama/Llama-3.1-8B-Instruct",
        authType="none",
        supportsChat=True,
    ),
    ProviderPreset(
        id="lm-studio",
        label="LM Studio Local",
        category="local",
        baseUrl="http://localhost:1234/v1",
        defaultModel="local-model",
        authType="none",
        supportsChat=True,
    ),
    ProviderPreset(
        id="custom",
        label="Custom OpenAI-Compatible Endpoint",
        category="custom",
        baseUrl="https://your-provider.example.com/v1",
        defaultModel="your-model",
        supportsChat=True,
        supportsEmbeddings=True,
        supportsVision=True,
        notes=["Use any provider, internal gateway, or private model server with OpenAI-compatible chat completions."],
    ),
]


@dataclass(frozen=True)
class RuntimeProvider:
    id: str
    label: str
    base_url: str
    api_key: str | None
    default_model: str
    source: str
    priority: int
    environment: str
    connection_id: str | None = None


def list_provider_presets() -> list[ProviderPreset]:
    return PROVIDER_PRESETS


def preset_by_id(provider_id: str) -> ProviderPreset | None:
    return next((preset for preset in PROVIDER_PRESETS if preset.id == provider_id), None)


def current_provider_workspace_id() -> str:
    claim_workspace_id = workspace_id_from_claims(current_claims())
    if claim_workspace_id:
        return claim_workspace_id
    return os.getenv("NEURALOPS_WORKSPACE_ID", "local-workspace")


def provider_connections(workspace_id: str | None = None) -> list[ProviderConnection]:
    target_workspace = workspace_id or current_provider_workspace_id()
    records = list_records("provider_connections")
    if auth_required():
        records = [record for record in records if record.get("workspaceId") == target_workspace]
    connections = [public_provider_connection(record) for record in records]
    return sorted(connections, key=lambda item: (item.priority, item.label.lower()))


def create_provider_connection(request: ProviderConnectionCreate, workspace_id: str) -> ProviderConnection:
    now = datetime.now().isoformat()
    key_preview = key_preview_for(request.apiKey)
    payload = {
        "id": f"pc_{token_hex(5)}",
        "workspaceId": workspace_id,
        "providerId": request.providerId,
        "label": request.label.strip(),
        "baseUrl": request.baseUrl.rstrip("/"),
        "defaultModel": request.defaultModel.strip(),
        "environment": request.environment,
        "priority": request.priority,
        "configured": bool(request.apiKey) or provider_auth_type(request.providerId) == "none",
        "keyPreview": key_preview,
        "encryptedApiKey": encrypt_secret(request.apiKey) if request.apiKey else None,
        "supportsChat": request.supportsChat,
        "supportsEmbeddings": request.supportsEmbeddings,
        "supportsVision": request.supportsVision,
        "status": "active",
        "disabledAt": None,
        "disabledReason": None,
        "rotatedAt": None,
        "rotatedBy": None,
        "lastUsedAt": None,
        "lastRouteDecision": None,
        "lastTestedAt": None,
        "lastStatus": "untested",
        "lastError": None,
        "createdAt": now,
        "updatedAt": now,
    }
    saved = save_record("provider_connections", payload["id"], payload)
    return public_provider_connection(saved)


def patch_provider_connection(connection_id: str, request: ProviderConnectionPatch, workspace_id: str | None = None) -> ProviderConnection | None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return None
    if auth_required() and payload.get("workspaceId") != (workspace_id or current_provider_workspace_id()):
        return None
    patch = request.model_dump(exclude_none=True)
    if "label" in patch:
        payload["label"] = patch["label"].strip()
    if "baseUrl" in patch:
        payload["baseUrl"] = patch["baseUrl"].rstrip("/")
    if "defaultModel" in patch:
        payload["defaultModel"] = patch["defaultModel"].strip()
    for field in ("environment", "priority", "supportsChat", "supportsEmbeddings", "supportsVision"):
        if field in patch:
            payload[field] = patch[field]
    payload["updatedAt"] = datetime.now().isoformat()
    saved = save_record("provider_connections", connection_id, payload)
    return public_provider_connection(saved)


def disable_provider_connection(connection_id: str, request: ProviderConnectionDisableRequest, workspace_id: str | None = None) -> ProviderConnection | None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return None
    if auth_required() and payload.get("workspaceId") != (workspace_id or current_provider_workspace_id()):
        return None
    now = datetime.now().isoformat()
    payload["status"] = "disabled"
    payload["disabledAt"] = now
    payload["disabledReason"] = request.reason
    payload["lastRouteDecision"] = "disabled_by_operator"
    payload["updatedAt"] = now
    saved = save_record("provider_connections", connection_id, payload)
    return public_provider_connection(saved)


def enable_provider_connection(connection_id: str, workspace_id: str | None = None) -> ProviderConnection | None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return None
    if auth_required() and payload.get("workspaceId") != (workspace_id or current_provider_workspace_id()):
        return None
    now = datetime.now().isoformat()
    payload["status"] = "active"
    payload["disabledAt"] = None
    payload["disabledReason"] = None
    payload["lastRouteDecision"] = "enabled_by_operator"
    payload["updatedAt"] = now
    saved = save_record("provider_connections", connection_id, payload)
    return public_provider_connection(saved)


def rotate_provider_connection_key(
    connection_id: str,
    request: ProviderConnectionRotateKeyRequest,
    rotated_by: str,
    workspace_id: str | None = None,
) -> ProviderConnection | None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return None
    if auth_required() and payload.get("workspaceId") != (workspace_id or current_provider_workspace_id()):
        return None
    now = datetime.now().isoformat()
    payload["encryptedApiKey"] = encrypt_secret(request.apiKey)
    payload["keyPreview"] = key_preview_for(request.apiKey)
    payload["configured"] = True
    payload["status"] = "rotating"
    payload["rotatedAt"] = now
    payload["rotatedBy"] = rotated_by
    payload["lastStatus"] = "untested"
    payload["lastError"] = None
    payload["lastRouteDecision"] = "rotation_pending_test"
    payload["updatedAt"] = now
    saved = save_record("provider_connections", connection_id, payload)
    return public_provider_connection(saved)


def mark_provider_connection_route(connection_id: str, decision: str) -> None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return
    now = datetime.now().isoformat()
    payload["lastUsedAt"] = now
    payload["lastRouteDecision"] = decision
    payload["updatedAt"] = now
    save_record("provider_connections", connection_id, payload)


def test_provider_connection(connection_id: str, workspace_id: str | None = None) -> ProviderConnectionTestResult | None:
    payload = get_record("provider_connections", connection_id)
    if payload is None:
        return None
    if auth_required() and payload.get("workspaceId") != (workspace_id or current_provider_workspace_id()):
        return None

    started = time.perf_counter()
    api_key = decrypt_secret(payload.get("encryptedApiKey"))
    auth_type = provider_auth_type(payload.get("providerId", "custom"))
    if auth_type != "none" and not api_key:
        payload["lastTestedAt"] = datetime.now().isoformat()
        payload["lastStatus"] = "not_configured"
        payload["lastError"] = "No server-side API key is stored for this provider."
        payload["lastRouteDecision"] = "test_not_configured"
        payload["updatedAt"] = payload["lastTestedAt"]
        saved = save_record("provider_connections", connection_id, payload)
        return ProviderConnectionTestResult(
            ok=False,
            connection=public_provider_connection(saved),
            latencyMs=max(1, int((time.perf_counter() - started) * 1000)),
            message=payload["lastError"],
        )

    try:
        ping_openai_compatible(payload["baseUrl"], api_key, payload["defaultModel"], auth_type)
        payload["lastStatus"] = "healthy"
        payload["lastError"] = None
        if payload.get("status") == "rotating":
            payload["status"] = "active"
        payload["lastRouteDecision"] = "test_healthy"
        ok = True
        message = "Provider accepted the OpenAI-compatible test request."
    except Exception as exc:  # noqa: BLE001 - persist operator-facing health reason.
        payload["lastStatus"] = "failed"
        payload["lastError"] = str(exc)[:240]
        payload["lastRouteDecision"] = "test_failed"
        ok = False
        message = payload["lastError"]
    payload["lastTestedAt"] = datetime.now().isoformat()
    payload["updatedAt"] = payload["lastTestedAt"]
    saved = save_record("provider_connections", connection_id, payload)
    return ProviderConnectionTestResult(
        ok=ok,
        connection=public_provider_connection(saved),
        latencyMs=max(1, int((time.perf_counter() - started) * 1000)),
        message=message,
    )


def runtime_providers() -> list[RuntimeProvider]:
    providers = configured_connection_providers()
    providers.extend(configured_env_providers())
    return sorted(providers, key=lambda item: (item.priority, item.label.lower()))


def list_provider_statuses() -> list[ProviderStatus]:
    statuses: list[ProviderStatus] = [
        ProviderStatus(
            id="local",
            label="Deterministic Local Runtime",
            configured=True,
            baseUrl=None,
            defaultModel="local-neuralops-agent",
            source="local",
            priority=999,
            status="healthy",
        )
    ]
    env_ids = {provider.id for provider in configured_env_providers()}
    for preset in PROVIDER_PRESETS:
        env_provider = next((provider for provider in configured_env_providers() if provider.id == preset.id), None)
        if env_provider is not None:
            statuses.append(
                ProviderStatus(
                    id=env_provider.id,
                    label=env_provider.label,
                    configured=True,
                    baseUrl=env_provider.base_url,
                    defaultModel=env_provider.default_model,
                    source="env",
                    priority=env_provider.priority,
                    supportsChat=preset.supportsChat,
                    supportsEmbeddings=preset.supportsEmbeddings,
                    supportsVision=preset.supportsVision,
                    status="configured",
                )
            )
        elif preset.id not in env_ids:
            statuses.append(
                ProviderStatus(
                    id=preset.id,
                    label=preset.label,
                    configured=False,
                    baseUrl=preset.baseUrl,
                    defaultModel=preset.defaultModel,
                    source="preset",
                    supportsChat=preset.supportsChat,
                    supportsEmbeddings=preset.supportsEmbeddings,
                    supportsVision=preset.supportsVision,
                    status="not_configured",
                )
            )

    for connection in provider_connections():
        statuses.append(
            ProviderStatus(
                id=connection.id,
                label=connection.label,
                configured=connection.configured,
                baseUrl=connection.baseUrl,
                defaultModel=connection.defaultModel,
                source="connection",
                environment=connection.environment,
                priority=connection.priority,
                supportsChat=connection.supportsChat,
                supportsEmbeddings=connection.supportsEmbeddings,
                supportsVision=connection.supportsVision,
                status=connection.status if connection.status != "active" else connection.lastStatus if connection.lastStatus != "untested" else "configured" if connection.configured else "not_configured",
            )
        )
    return sorted(statuses, key=lambda item: (item.source != "local", item.priority, item.label.lower()))


def public_provider_connection(payload: dict[str, Any]) -> ProviderConnection:
    return ProviderConnection(
        id=payload["id"],
        providerId=payload["providerId"],
        label=payload["label"],
        baseUrl=payload["baseUrl"],
        defaultModel=payload["defaultModel"],
        environment=payload.get("environment", "all"),
        priority=payload.get("priority", 100),
        configured=bool(payload.get("configured")),
        keyPreview=payload.get("keyPreview"),
        supportsChat=bool(payload.get("supportsChat", True)),
        supportsEmbeddings=bool(payload.get("supportsEmbeddings", False)),
        supportsVision=bool(payload.get("supportsVision", False)),
        status=payload.get("status", "active"),
        disabledAt=payload.get("disabledAt"),
        disabledReason=payload.get("disabledReason"),
        rotatedAt=payload.get("rotatedAt"),
        rotatedBy=payload.get("rotatedBy"),
        lastUsedAt=payload.get("lastUsedAt"),
        lastRouteDecision=payload.get("lastRouteDecision"),
        lastTestedAt=payload.get("lastTestedAt"),
        lastStatus=payload.get("lastStatus", "untested"),
        lastError=payload.get("lastError"),
        createdAt=payload["createdAt"],
        updatedAt=payload["updatedAt"],
    )


def configured_connection_providers() -> list[RuntimeProvider]:
    providers: list[RuntimeProvider] = []
    records = list_records("provider_connections")
    if auth_required():
        workspace_id = current_provider_workspace_id()
        records = [record for record in records if record.get("workspaceId") == workspace_id]
    for record in records:
        api_key = decrypt_secret(record.get("encryptedApiKey"))
        if record.get("status", "active") != "active":
            continue
        if provider_auth_type(record.get("providerId", "custom")) != "none" and not api_key:
            continue
        if not record.get("configured"):
            continue
        providers.append(
            RuntimeProvider(
                id=record["providerId"],
                label=record["label"],
                base_url=record["baseUrl"],
                api_key=api_key,
                default_model=record["defaultModel"],
                source="connection",
                priority=record.get("priority", 100),
                environment=record.get("environment", "all"),
                connection_id=record["id"],
            )
        )
    return providers


def configured_env_providers() -> list[RuntimeProvider]:
    env_map = [
        ("groq", "Groq", "GROQ_API_KEY", "GROQ_BASE_URL", "https://api.groq.com/openai/v1", "GROQ_MODEL", "llama-3.3-70b-versatile", 10),
        ("nvidia", "NVIDIA NIM", "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1", "NVIDIA_MODEL", "nvidia/llama-3.1-nemotron-70b-instruct", 20),
        ("openai", "OpenAI", "OPENAI_API_KEY", "OPENAI_BASE_URL", "https://api.openai.com/v1", "OPENAI_MODEL", "gpt-4o-mini", 30),
        ("openrouter", "OpenRouter", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1", "OPENROUTER_MODEL", "openai/gpt-4o-mini", 40),
        ("vercel-ai-gateway", "Vercel AI Gateway", "VERCEL_AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_BASE_URL", "https://ai-gateway.vercel.sh/v1", "VERCEL_AI_GATEWAY_MODEL", "openai/gpt-4o-mini", 50),
        ("together", "Together AI", "TOGETHER_API_KEY", "TOGETHER_BASE_URL", "https://api.together.xyz/v1", "TOGETHER_MODEL", "meta-llama/Llama-3.3-70B-Instruct-Turbo", 60),
        ("fireworks", "Fireworks AI", "FIREWORKS_API_KEY", "FIREWORKS_BASE_URL", "https://api.fireworks.ai/inference/v1", "FIREWORKS_MODEL", "accounts/fireworks/models/llama-v3p3-70b-instruct", 70),
        ("mistral", "Mistral AI", "MISTRAL_API_KEY", "MISTRAL_BASE_URL", "https://api.mistral.ai/v1", "MISTRAL_MODEL", "mistral-large-latest", 80),
        ("deepseek", "DeepSeek", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1", "DEEPSEEK_MODEL", "deepseek-chat", 90),
        ("custom", "Custom OpenAI-Compatible", "NEURALOPS_API_KEY", "NEURALOPS_PROVIDER_URL", "", "NEURALOPS_MODEL", "custom-model", 95),
    ]
    providers: list[RuntimeProvider] = []
    for provider_id, label, key_env, url_env, default_url, model_env, default_model, priority in env_map:
        api_key = os.getenv(key_env)
        base_url = os.getenv(url_env, default_url).rstrip("/")
        if not api_key or not base_url:
            continue
        providers.append(
            RuntimeProvider(
                id=provider_id,
                label=label,
                base_url=base_url,
                api_key=api_key,
                default_model=os.getenv(model_env, default_model),
                source="env",
                priority=priority,
                environment="all",
            )
        )
    for provider_id, label, url_env, default_url, model_env, default_model, priority in [
        ("ollama", "Ollama Local", "OLLAMA_BASE_URL", "http://localhost:11434/v1", "OLLAMA_MODEL", "llama3.1", 120),
        ("vllm", "vLLM Local/Private", "VLLM_BASE_URL", "http://localhost:8001/v1", "VLLM_MODEL", "meta-llama/Llama-3.1-8B-Instruct", 130),
        ("lm-studio", "LM Studio Local", "LM_STUDIO_BASE_URL", "http://localhost:1234/v1", "LM_STUDIO_MODEL", "local-model", 140),
    ]:
        if os.getenv(f"{provider_id.upper().replace('-', '_')}_ENABLED", "false").lower() not in {"1", "true", "yes"}:
            continue
        providers.append(
            RuntimeProvider(
                id=provider_id,
                label=label,
                base_url=os.getenv(url_env, default_url).rstrip("/"),
                api_key=None,
                default_model=os.getenv(model_env, default_model),
                source="env",
                priority=priority,
                environment="all",
            )
        )
    return providers


def provider_auth_type(provider_id: str) -> str:
    preset = preset_by_id(provider_id)
    return preset.authType if preset is not None else "bearer"


def ping_openai_compatible(base_url: str, api_key: str | None, model: str, auth_type: str) -> None:
    headers = {"Content-Type": "application/json"}
    if auth_type != "none" and api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 16,
        "messages": [
            {"role": "system", "content": "Return a short health check."},
            {"role": "user", "content": "Say NeuralOps provider check passed."},
        ],
    }
    with httpx.Client(timeout=20) as client:
        response = client.post(f"{base_url.rstrip('/')}/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    if not data.get("choices"):
        raise RuntimeError("Provider returned no choices.")


def key_preview_for(api_key: str | None) -> str | None:
    if not api_key:
        return None
    if len(api_key) <= 10:
        return "***"
    return f"{api_key[:6]}...{api_key[-4:]}"


def fernet() -> Fernet:
    secret = os.getenv("NEURALOPS_SECRET_KEY") or os.getenv("SUPABASE_JWT_SECRET") or "local-dev-neuralops-secret"
    digest = sha256(secret.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    return fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None
