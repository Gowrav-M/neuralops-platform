from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from copy import deepcopy
from hashlib import sha256
import hmac
import os
from secrets import compare_digest, token_hex
from threading import Lock
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .database import delete_record, get_record, init_db, list_records, save_record, storage_backend, update_record
from .agent_runtime import AGENT_DEFINITIONS, list_providers, run_agent
from .auth import auth_required, current_claims, public_auth_paths, reset_current_claims, set_current_claims, verify_supabase_token, workspace_id_from_claims
from . import seed
from .job_queue import cancel_job, get_job, list_jobs, process_job, process_next_job, queue_summary, retry_job, submit_job
from .metrics import build_stats
from .otel import normalize_otel_payload, replay_trace
from .provider_catalog import create_provider_connection, list_provider_presets, provider_connections, test_provider_connection
from .schemas import (
    AgentJob,
    AgentJobProcessResponse,
    AgentJobSubmitRequest,
    AgentJobSubmitResponse,
    AgentRuntime,
    AutomationEvent,
    AutomationRunTestRequest,
    AutomationRule,
    AutomationRuleCreate,
    AutomationRulePatch,
    AutomationTrigger,
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    AuditEvent,
    AgentDefinition,
    AgentRunRecord,
    AgentRunRequest,
    AgentRunResponse,
    DashboardSnapshot,
    Evaluator,
    EvidenceReport,
    FeatureTruth,
    Incident,
    IncidentPatch,
    LabExperiment,
    LabRunRequest,
    LabRunResponse,
    LabVariantResult,
    OtelIngestRequest,
    OtelIngestResult,
    Policy,
    PolicyPatch,
    PolicyTestRequest,
    PolicyTestResult,
    PolicyViolation,
    CostBudgetUpdateRequest,
    ConnectGuide,
    ConnectSnippet,
    ConnectVerifyRequest,
    ConnectVerifyResponse,
    ConnectorDelivery,
    ConnectorDeliveryProcessRequest,
    ConnectorDeliveryProcessResult,
    GitHubPrCommentRequest,
    GitHubPrCommentResult,
    PromptTrafficUpdate,
    ProviderStatus,
    ProviderConnection,
    ProviderConnectionCreate,
    ProviderConnectionTestResult,
    ProviderPreset,
    PromptVersion,
    RagRetrievalTestRequest,
    RagQuery,
    ReleaseGateCheck,
    ReleaseGateDefinition,
    ReleaseGateDefinitionCreate,
    ReleaseGateDefinitionPatch,
    ReleaseGateRequest,
    ReleaseGateResult,
    ReleaseGateRunRequest,
    ReleaseAutopilotComparison,
    ReleaseAutopilotRequest,
    ReleaseAutopilotResult,
    ReplayResult,
    SettingsPayload,
    Stats,
    SystemStatus,
    Trace,
    TraceIngestRequest,
    TraceIngestResponse,
    RetentionUpdateRequest,
    WebhookCreateRequest,
    WorkspaceMember,
    WorkspaceMemberCreateRequest,
    WorkspaceMemberPatchRequest,
    WorkspaceProfile,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="NeuralOps Platform API", version="0.1.0", lifespan=lifespan)
SETTINGS_WRITE_LOCK = Lock()

allowed_origins = [
    origin.strip()
    for origin in os.getenv("NEURALOPS_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    if not auth_required() or request.method == "OPTIONS" or request.url.path in public_auth_paths():
        return await call_next(request)
    token = None
    try:
        claims = verify_supabase_token(request.headers.get("authorization"))
        request.state.user_claims = claims
        token = set_current_claims(claims)
        return await call_next(request)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    finally:
        if token is not None:
            reset_current_claims(token)


def hash_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def settings_payload_or_404() -> dict[str, Any]:
    record_id = settings_record_id()
    payload = get_record("settings", record_id)
    if payload is None and record_id != "current":
        payload = deepcopy(seed.SETTINGS)
        payload["workspaceId"] = current_workspace_id()
        payload = save_record("settings", record_id, payload)
    if payload is None:
        raise HTTPException(status_code=404, detail="Settings not found")
    return payload


def public_webhook_payload(webhook: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in webhook.items() if key != "secret"}


def public_settings_payload(payload: dict[str, Any]) -> dict[str, Any]:
    public_payload = {**payload}
    public_payload["apiKeys"] = [
        {key: value for key, value in api_key.items() if key != "tokenHash"}
        for api_key in payload.get("apiKeys", [])
    ]
    public_payload["webhooks"] = [
        public_webhook_payload(webhook)
        for webhook in payload.get("webhooks", [])
    ]
    public_payload["teamMembers"] = public_workspace_members()
    return public_payload


def settings_record_id() -> str:
    if not auth_required():
        return "current"
    return f"current:{current_workspace_id()}"


def token_from_headers(authorization: str | None, neuralops_key: str | None) -> str:
    if neuralops_key:
        return neuralops_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    raise HTTPException(status_code=401, detail="Missing NeuralOps API key")


def api_key_has_scope(api_key: dict[str, Any], required_scope: str) -> bool:
    scopes = api_key.get("scopes")
    if not scopes:
        scopes = ["trace:ingest"]
    return "admin" in scopes or required_scope in scopes


def record_api_key_use(payload: dict[str, Any], key_id: str, required_scope: str) -> dict[str, Any]:
    now = datetime.now().isoformat()
    for api_key in payload.get("apiKeys", []):
        if api_key.get("id") == key_id:
            api_key["lastUsedAt"] = now
            api_key["useCount"] = int(api_key.get("useCount", 0)) + 1
            api_key["lastScope"] = required_scope
            save_record("settings", settings_record_id(), payload)
            return api_key
    raise HTTPException(status_code=401, detail="Invalid NeuralOps API key")


def authenticate_api_key(authorization: str | None, neuralops_key: str | None, required_scope: str = "trace:ingest") -> dict[str, Any]:
    token = token_from_headers(authorization, neuralops_key)
    token_hash = hash_token(token)
    settings_payload = settings_payload_or_404()
    for api_key in settings_payload.get("apiKeys", []):
        stored_hash = api_key.get("tokenHash")
        if stored_hash and compare_digest(stored_hash, token_hash):
            if not api_key_has_scope(api_key, required_scope):
                raise HTTPException(status_code=403, detail=f"API key missing required scope: {required_scope}")
            used_key = record_api_key_use(settings_payload, api_key["id"], required_scope)
            save_audit_event(
                "api_key.use",
                used_key.get("name", used_key.get("id", "api-key")),
                used_key["id"],
                "allow",
                f"API key used with scope {required_scope}.",
            )
            return used_key
    raise HTTPException(status_code=401, detail="Invalid NeuralOps API key")


def save_audit_event(event_type: str, actor: str, subject: str, decision: str, summary: str) -> AuditEvent:
    event = AuditEvent(
        id=f"aud_{token_hex(6)}",
        type=event_type,
        actor=actor,
        subject=subject,
        decision=decision,
        summary=summary,
        createdAt=datetime.now().isoformat(),
    )
    payload = event.model_dump()
    payload["workspaceId"] = current_workspace_id()
    save_record("audit", event.id, payload)
    return event


def scoped_records(domain: str) -> list[dict[str, Any]]:
    records = list_records(domain)
    if not auth_required():
        return records
    workspace_id = current_workspace_id()
    global_domains = {"policies"}
    scoped: list[dict[str, Any]] = []
    for record in records:
        if domain in global_domains:
            scoped.append(record)
        elif record.get("workspaceId") == workspace_id:
            scoped.append(record)
        elif domain == "workspaces" and record.get("id") == workspace_id:
            scoped.append(record)
    return scoped


def count_domain(domain: str) -> int:
    return len(scoped_records(domain))


def scoped_record_id(record_id: str) -> str:
    if not auth_required():
        return record_id
    return f"{current_workspace_id()}:{record_id}"


def stamp_workspace(payload: dict[str, Any]) -> dict[str, Any]:
    stamped = {**payload}
    stamped["workspaceId"] = current_workspace_id()
    return stamped


def save_scoped_record(domain: str, record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return save_record(domain, scoped_record_id(record_id), stamp_workspace(payload))


def get_scoped_record(domain: str, record_id: str) -> dict[str, Any] | None:
    if auth_required():
        return get_record(domain, scoped_record_id(record_id))
    return get_record(domain, record_id)


def update_scoped_record(domain: str, record_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    payload = get_scoped_record(domain, record_id)
    if payload is None:
        return None
    payload.update({key: value for key, value in patch.items() if value is not None})
    return save_scoped_record(domain, record_id, payload)


def delete_scoped_record(domain: str, record_id: str) -> None:
    delete_record(domain, scoped_record_id(record_id))


def costs_record_id() -> str:
    return "current" if not auth_required() else f"current:{current_workspace_id()}"


def current_workspace_id() -> str:
    claim_workspace_id = workspace_id_from_claims(current_claims())
    if claim_workspace_id:
        return claim_workspace_id
    return os.getenv("NEURALOPS_WORKSPACE_ID", "local-workspace")


def workspace_auth_required() -> bool:
    return os.getenv("NEURALOPS_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes"}


def workspace_access_for_role(role: str) -> str:
    return "Read Only" if role == "Viewer" else "All Workspace"


def workspace_profile_payload() -> dict[str, Any]:
    workspace_id = current_workspace_id()
    payload = get_record("workspaces", workspace_id)
    now = datetime.now().isoformat()
    if payload is None:
        payload = {
            "id": workspace_id,
            "name": os.getenv("NEURALOPS_WORKSPACE_NAME", "Local Workspace"),
            "storage": storage_backend(),
            "authRequired": workspace_auth_required(),
            "memberCount": count_domain("workspace_members"),
            "createdAt": now,
            "updatedAt": now,
        }
        return save_record("workspaces", workspace_id, payload)
    payload["storage"] = storage_backend()
    payload["authRequired"] = workspace_auth_required()
    payload["memberCount"] = count_domain("workspace_members")
    payload["updatedAt"] = now
    return save_record("workspaces", workspace_id, payload)


def workspace_members_payload() -> list[dict[str, Any]]:
    workspace_id = current_workspace_id()
    return [
        member
        for member in list_records("workspace_members")
        if member.get("workspaceId") == workspace_id
    ]


def workspace_member_or_404(member_id: str) -> dict[str, Any]:
    payload = get_record("workspace_members", member_id)
    if payload is None or payload.get("workspaceId") != current_workspace_id():
        raise HTTPException(status_code=404, detail="Workspace member not found")
    return payload


def public_workspace_members() -> list[dict[str, Any]]:
    members = []
    for member in workspace_members_payload():
        members.append(
            {
                "id": member["id"],
                "name": member["name"],
                "email": member["email"],
                "role": member["role"],
                "access": member.get("access", workspace_access_for_role(member["role"])),
            }
        )
    return members


def build_system_status() -> SystemStatus:
    workspace_profile_payload()
    domains = [
        "workspaces",
        "workspace_members",
        "traces",
        "prompts",
        "evals",
        "rag",
        "policies",
        "policy_violations",
        "incidents",
        "costs",
        "agent_runs",
        "agent_jobs",
        "lab_experiments",
        "provider_connections",
        "automation_rules",
        "automation_events",
        "release_autopilot",
        "connector_deliveries",
        "release_gate_definitions",
        "release_gates",
        "audit",
    ]
    record_counts = {domain: count_domain(domain) for domain in domains}
    settings_payload = settings_payload_or_404()
    providers = list_providers()
    live_configured = any(provider.configured for provider in providers if provider.id != "local")
    auth_required = os.getenv("NEURALOPS_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes"}
    webhook_count = len(settings_payload.get("webhooks", []))
    api_key_count = len(settings_payload.get("apiKeys", []))
    member_count = record_counts["workspace_members"]
    blockers: list[str] = []

    features = [
        FeatureTruth(
            id="database",
            label="Database Evidence Store",
            state="persisted",
            evidence=f"{storage_backend()} storage with {sum(record_counts.values())} record(s)",
            action="All product data is read from and written to the backend store.",
        ),
        FeatureTruth(
            id="workspace_rbac",
            label="Workspace RBAC",
            state="persisted",
            evidence=f"{record_counts['workspaces']} workspace record(s), {member_count} member record(s)",
            action="Add workspace members and roles in Settings before enabling public deployment.",
        ),
        FeatureTruth(
            id="trace_ingest",
            label="Trace Ingestion",
            state="persisted" if api_key_count else "not_configured",
            evidence=f"{record_counts['traces']} trace(s), {api_key_count} ingest key(s)",
            action="Create an ingest API key in Settings, then send traces to /api/traces/ingest.",
        ),
        FeatureTruth(
            id="release_gates",
            label="Release Gates",
            state="persisted" if record_counts["release_gate_definitions"] or record_counts["release_gates"] else "not_configured",
            evidence=f"{record_counts['release_gate_definitions']} saved gate(s), {record_counts['release_gates']} run(s)",
            action="Create a saved release gate and run it from the Evidence page or CLI before deployment.",
        ),
        FeatureTruth(
            id="connect_sdk",
            label="SDK + Collector Connection",
            state="persisted" if api_key_count and record_counts["traces"] else "not_configured",
            evidence=f"{api_key_count} key(s), {record_counts['traces']} trace(s)",
            action="Use the Connect page to create a key and verify JavaScript, Python, REST, or OTEL ingestion.",
        ),
        FeatureTruth(
            id="prompt_registry",
            label="Prompt Registry",
            state="persisted" if record_counts["prompts"] else "not_configured",
            evidence=f"{record_counts['prompts']} prompt version record(s)",
            action="Create prompt records before using canary deploy or rollback.",
        ),
        FeatureTruth(
            id="eval_center",
            label="Evaluation Center",
            state="persisted" if record_counts["evals"] or record_counts["traces"] else "not_configured",
            evidence=f"{record_counts['evals']} evaluator(s), {record_counts['traces']} trace(s)",
            action="Run agent/lab workflows or ingest traces to produce evaluable data.",
        ),
        FeatureTruth(
            id="rag_quality",
            label="RAG Quality",
            state="persisted" if record_counts["rag"] else "not_configured",
            evidence=f"{record_counts['rag']} retrieval test record(s)",
            action="Ingest knowledge records before running retrieval quality tests.",
        ),
        FeatureTruth(
            id="guardrails",
            label="Policy Guardrails",
            state="persisted",
            evidence=f"{record_counts['policies']} policy rule(s), {record_counts['policy_violations']} violation record(s)",
            action="Policy sandbox and agent runs use deterministic guardrail checks.",
        ),
        FeatureTruth(
            id="incidents_cost",
            label="Incidents + Cost Automation",
            state="persisted" if record_counts["costs"] or record_counts["incidents"] else "not_configured",
            evidence=f"{record_counts['incidents']} incident(s), {record_counts['costs']} cost snapshot(s)",
            action="Incidents and budgets persist only after backend actions.",
        ),
        FeatureTruth(
            id="agent_runtime",
            label="Agent Runtime",
            state="live_provider" if live_configured else "local_drill",
            evidence="Live provider configured" if live_configured else "Only deterministic local runtime is configured",
            action="Create a provider connection or set OpenAI-compatible server env vars for live calls.",
        ),
        FeatureTruth(
            id="provider_gateway",
            label="Provider Gateway",
            state="live_provider" if live_configured else "not_configured",
            evidence=f"{record_counts['provider_connections']} provider connection record(s), {len(providers)} catalog/status entries",
            action="Add a provider connection for OpenRouter, Vercel AI Gateway, Groq, NVIDIA, Ollama, vLLM, or a custom endpoint.",
        ),
        FeatureTruth(
            id="webhooks",
            label="Webhook Notifications",
            state="persisted" if webhook_count else "not_configured",
            evidence=f"{webhook_count} webhook endpoint(s), {record_counts['connector_deliveries']} delivery attempt(s)",
            action="Register a webhook before expecting external notifications.",
        ),
        FeatureTruth(
            id="automation_engine",
            label="Automation Engine",
            state="persisted" if record_counts["automation_rules"] or record_counts["automation_events"] else "not_configured",
            evidence=f"{record_counts['automation_rules']} rule(s), {record_counts['automation_events']} event(s)",
            action="Create rules that turn release-gate, trace, policy, or cost failures into audit records, incidents, or webhook records.",
        ),
        FeatureTruth(
            id="release_autopilot",
            label="Release Autopilot",
            state="persisted" if record_counts["release_autopilot"] else "not_configured",
            evidence=f"{record_counts['release_autopilot']} replay evidence packet(s)",
            action="Replay risky traces against candidate instructions before approving a prompt, model, or agent release.",
        ),
        FeatureTruth(
            id="auth",
            label="Supabase Auth Gate",
            state="persisted" if auth_required else "not_configured",
            evidence="Auth required by backend" if auth_required else "Auth is not enforced in local development",
            action="Set NEURALOPS_AUTH_REQUIRED=true before public deployment.",
        ),
    ]

    for feature in features:
        if feature.state == "not_configured":
            blockers.append(f"{feature.label}: {feature.action}")
    readiness_score = round(100 * sum(1 for feature in features if feature.state != "not_configured") / len(features))

    return SystemStatus(
        storage=storage_backend(),  # type: ignore[arg-type]
        environment=os.getenv("NEURALOPS_ENVIRONMENT", "local"),
        authRequired=auth_required,
        workspaceId=current_workspace_id(),
        recordCounts=record_counts,
        providers=providers,
        features=features,
        readinessScore=readiness_score,
        blockers=blockers,
        generatedAt=datetime.now().isoformat(),
    )


def parse_seconds(value: str) -> float:
    try:
        return float(value.replace("s", ""))
    except ValueError:
        return 0.0


def list_release_gate_definitions() -> list[ReleaseGateDefinition]:
    gates = [ReleaseGateDefinition.model_validate(item) for item in scoped_records("release_gate_definitions")]
    return sorted(gates, key=lambda item: item.updatedAt, reverse=True)


def release_gate_request_from_definition(gate: ReleaseGateDefinition, target_override: str | None = None) -> ReleaseGateRequest:
    return ReleaseGateRequest(
        target=target_override or gate.target,
        promptId=gate.promptId,
        maxLatencyMs=gate.maxLatencyMs,
        maxErrorRate=gate.maxErrorRate,
        minEvalPassRate=gate.minEvalPassRate,
        requireLiveProvider=gate.requireLiveProvider,
        requireAuth=gate.requireAuth,
    )


def run_release_gate(request: ReleaseGateRequest) -> ReleaseGateResult:
    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    incidents = [Incident.model_validate(item) for item in scoped_records("incidents")]
    prompts = [PromptVersion.model_validate(item) for item in scoped_records("prompts")]
    rag_records = [RagQuery.model_validate(item) for item in scoped_records("rag")]
    status = build_system_status()
    stats = build_stats(traces, incidents)
    live_configured = any(provider.configured for provider in status.providers if provider.id != "local")

    failed_or_blocked = [trace for trace in traces if trace.status in {"failed", "blocked"}]
    avg_latency_ms = round(sum(parse_seconds(trace.latency) for trace in traces) * 1000 / max(len(traces), 1))
    eval_pass_rate = float(stats.evalPassRate.replace("%", "")) / 100 if stats.evalPassRate.endswith("%") else 0
    error_rate = len(failed_or_blocked) / max(len(traces), 1)

    checks = [
        ReleaseGateCheck(
            id="trace_volume",
            label="Production Trace Evidence",
            status="pass" if len(traces) >= 3 else "warn" if traces else "fail",
            reason="Release needs replayable trace evidence.",
            evidence=f"{len(traces)} trace(s) available",
        ),
        ReleaseGateCheck(
            id="error_rate",
            label="Failure / Block Rate",
            status="pass" if error_rate <= request.maxErrorRate else "fail",
            reason=f"Blocked or failed traces must stay under {request.maxErrorRate:.0%}.",
            evidence=f"{error_rate:.1%} current failure/block rate",
        ),
        ReleaseGateCheck(
            id="latency",
            label="Latency Budget",
            status="pass" if avg_latency_ms <= request.maxLatencyMs else "warn",
            reason=f"Average latency should stay below {request.maxLatencyMs}ms.",
            evidence=f"{avg_latency_ms}ms average latency",
        ),
        ReleaseGateCheck(
            id="evals",
            label="Evaluation Pass Rate",
            status="pass" if eval_pass_rate >= request.minEvalPassRate else "fail" if traces else "warn",
            reason=f"Eval pass rate should be at least {request.minEvalPassRate:.0%}.",
            evidence=f"{stats.evalPassRate} current pass rate",
        ),
        ReleaseGateCheck(
            id="prompt_registry",
            label="Prompt Version Control",
            status="pass" if prompts else "warn",
            reason="Prompt promotions should be tied to versioned prompt records.",
            evidence=f"{len(prompts)} prompt record(s)",
        ),
        ReleaseGateCheck(
            id="rag_grounding",
            label="RAG Grounding Evidence",
            status="pass" if rag_records else "warn",
            reason="RAG releases should include retrieval quality evidence.",
            evidence=f"{len(rag_records)} RAG quality record(s)",
        ),
        ReleaseGateCheck(
            id="provider",
            label="Live Provider Readiness",
            status="pass" if live_configured else "fail" if request.requireLiveProvider else "warn",
            reason="Public production should have at least one configured live provider or explicitly run local-only.",
            evidence="Live provider configured" if live_configured else "No Groq/NVIDIA/OpenAI-compatible key configured",
        ),
        ReleaseGateCheck(
            id="auth",
            label="Public Auth Gate",
            status="pass" if status.authRequired else "fail" if request.requireAuth else "warn",
            reason="Public deployment must require authentication unless this gate is explicitly local-only.",
            evidence="NEURALOPS_AUTH_REQUIRED=true" if status.authRequired else "Auth is not enforced",
        ),
    ]
    fail_count = sum(1 for check in checks if check.status == "fail")
    warn_count = sum(1 for check in checks if check.status == "warn")
    score = max(0, 100 - fail_count * 22 - warn_count * 8)
    decision = "block" if fail_count else "review" if warn_count else "allow"
    recommendations = [f"{check.label}: {check.reason} {check.evidence}" for check in checks if check.status != "pass"]
    result = ReleaseGateResult(
        id=f"gate_{token_hex(6)}",
        target=request.target,
        decision=decision,
        score=score,
        checks=checks,
        recommendations=recommendations,
        generatedAt=datetime.now().isoformat(),
    )
    save_scoped_record("release_gates", result.id, result.model_dump())
    save_audit_event("release_gate.run", current_workspace_id(), result.id, decision, f"Release gate for {request.target}: {decision}.")
    trigger_release_gate_automations(result)
    return result


def run_release_gate_definition(gate: ReleaseGateDefinition, request: ReleaseGateRunRequest | None = None) -> ReleaseGateResult:
    result = run_release_gate(release_gate_request_from_definition(gate, request.target if request else None))
    result = result.model_copy(update={"gateId": gate.id, "gateName": gate.name})
    save_scoped_record("release_gates", result.id, result.model_dump())
    updated_gate = gate.model_copy(
        update={
            "lastRunId": result.id,
            "lastDecision": result.decision,
            "lastScore": result.score,
            "updatedAt": datetime.now().isoformat(),
        }
    )
    save_scoped_record("release_gate_definitions", updated_gate.id, updated_gate.model_dump())
    save_audit_event(
        "release_gate.definition_run",
        current_workspace_id(),
        updated_gate.id,
        result.decision,
        f"Ran saved gate {updated_gate.name}; result {result.decision} ({result.score}/100).",
    )
    return result


def latest_release_gate() -> ReleaseGateResult | None:
    gates = [ReleaseGateResult.model_validate(item) for item in scoped_records("release_gates")]
    if not gates:
        return None
    return sorted(gates, key=lambda item: item.generatedAt, reverse=True)[0]


CONTROL_PATTERNS: dict[str, tuple[str, ...]] = {
    "prompt_injection": ("prompt injection", "instruction override", "ignore previous", "jailbreak", "system prompt"),
    "secret_exfiltration": ("api key", "secret", "credential", "password", "token", "never disclose"),
    "external_sink": ("webhook", "external sink", "external url", "email", "slack", "exfiltration"),
    "dangerous_tool": ("shell", "terminal", "powershell", "bash", "curl", "delete", "sandbox"),
    "groundedness": ("grounded", "evidence", "retrieved context", "citation", "source"),
    "cost_budget": ("cost", "budget", "token", "latency", "limit"),
}


def required_controls_for_trace(trace: Trace, replay: ReplayResult) -> list[str]:
    required: set[str] = set()
    for check in replay.checks:
        if check.status == "pass":
            continue
        name = check.name.lower()
        if "injection" in name:
            required.add("prompt_injection")
        if "secret" in name or "external" in name:
            required.update({"secret_exfiltration", "external_sink"})
        if "dangerous" in name or "tool" in name:
            required.add("dangerous_tool")
        if "cost" in name or "token" in name:
            required.add("cost_budget")
    for flag in trace.riskFlags:
        normalized = flag.lower()
        if "injection" in normalized:
            required.add("prompt_injection")
        if "credential" in normalized or "secret" in normalized:
            required.add("secret_exfiltration")
        if "external" in normalized:
            required.add("external_sink")
        if "dangerous" in normalized or "command" in normalized:
            required.add("dangerous_tool")
    if trace.toolCalls and "rag" in trace.toolCalls.lower():
        required.add("groundedness")
    return sorted(required)


def missing_candidate_controls(candidate_instructions: str, required_controls: list[str]) -> list[str]:
    text = candidate_instructions.lower()
    missing = []
    for control in required_controls:
        if not any(pattern in text for pattern in CONTROL_PATTERNS[control]):
            missing.append(control)
    return missing


def compare_candidate_to_trace(trace: Trace, candidate_instructions: str) -> ReleaseAutopilotComparison:
    replay = replay_trace(trace.model_dump())
    required = required_controls_for_trace(trace, replay)
    missing = missing_candidate_controls(candidate_instructions, required)
    critical_missing = [control for control in missing if control in {"prompt_injection", "secret_exfiltration", "external_sink", "dangerous_tool"}]
    if critical_missing:
        candidate_decision = "block"
    elif missing:
        candidate_decision = "review"
    else:
        candidate_decision = "allow"
    candidate_score = round(max(0.0, 1.0 - len(critical_missing) * 0.28 - (len(missing) - len(critical_missing)) * 0.12), 2)
    recommendation = (
        f"Add explicit controls for {', '.join(missing)} before release."
        if missing
        else "Candidate instructions cover the observed risky trace path."
    )
    return ReleaseAutopilotComparison(
        traceId=trace.id,
        currentStatus=trace.status,
        currentScore=trace.score,
        replayDecision=replay.decision,
        candidateDecision=candidate_decision,  # type: ignore[arg-type]
        candidateScore=candidate_score,
        improvement=round(candidate_score - trace.score, 2),
        requiredControls=required,
        missingControls=missing,
        recommendation=recommendation,
    )


def risky_traces_for_autopilot(limit: int) -> list[Trace]:
    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    risky = [trace for trace in traces if trace.status in {"blocked", "failed", "warning"} or trace.riskFlags]
    return sorted(risky, key=lambda item: item.timestamp, reverse=True)[:limit]


def build_autopilot_pr_comment(result: ReleaseAutopilotResult) -> str:
    lines = [
        "## NeuralOps Release Autopilot",
        "",
        f"- Candidate: `{result.candidateName}`",
        f"- Target: `{result.target}`",
        f"- Decision: **{result.decision.upper()}**",
        f"- Score: `{result.score}/100`",
        f"- Mode: `{result.mode}`",
        f"- Risky traces replayed: `{result.summary['testedTraces']}`",
        f"- Failed comparisons: `{result.summary['failedComparisons']}`",
        "",
        "### Trace Replay Results",
    ]
    for comparison in result.comparisons:
        lines.append(
            f"- `{comparison.traceId}`: candidate `{comparison.candidateDecision}` "
            f"score `{comparison.candidateScore}`; missing `{', '.join(comparison.missingControls) or 'none'}`"
        )
    lines.extend(
        [
            "",
            "### Gate Snapshot",
            f"- Release gate decision: `{result.gate.decision}`",
            f"- Release gate score: `{result.gate.score}/100`",
        ]
    )
    return "\n".join(lines)


def run_release_autopilot(request: ReleaseAutopilotRequest) -> ReleaseAutopilotResult:
    traces = risky_traces_for_autopilot(request.traceLimit)
    comparisons = [compare_candidate_to_trace(trace, request.candidateInstructions) for trace in traces]
    failed = [item for item in comparisons if item.candidateDecision == "block"]
    review = [item for item in comparisons if item.candidateDecision == "review"]
    avg_score = round(sum(item.candidateScore for item in comparisons) / max(len(comparisons), 1), 2)
    gate = run_release_gate(
        ReleaseGateRequest(
            target=request.target,
            maxErrorRate=1.0,
            minEvalPassRate=0,
            requireLiveProvider=request.requireLiveProvider,
            requireAuth=request.requireAuth,
        )
    )
    if failed or gate.decision == "block":
        decision = "block"
    elif review or not comparisons:
        decision = "review"
    else:
        decision = "allow"
    score = max(0, min(100, round(avg_score * 100) - len(failed) * 18 - len(review) * 6))
    summary = {
        "testedTraces": len(comparisons),
        "failedComparisons": len(failed),
        "reviewComparisons": len(review),
        "averageCandidateScore": avg_score,
        "gateDecision": gate.decision,
        "truthfulMode": "deterministic policy replay over stored risky traces",
    }
    result = ReleaseAutopilotResult(
        id=f"autopilot_{token_hex(6)}",
        candidateName=request.candidateName,
        target=request.target,
        decision=decision,  # type: ignore[arg-type]
        score=score,
        comparisons=comparisons,
        gate=gate,
        summary=summary,
        prCommentMarkdown="",
        generatedAt=datetime.now().isoformat(),
    )
    result = result.model_copy(update={"prCommentMarkdown": build_autopilot_pr_comment(result)})
    save_scoped_record("release_autopilot", result.id, result.model_dump())
    save_audit_event(
        "release_autopilot.run",
        current_workspace_id(),
        result.id,
        result.decision,
        f"Autopilot evaluated {request.candidateName}: {result.decision} ({result.score}/100).",
    )
    return result


def latest_release_autopilot() -> ReleaseAutopilotResult | None:
    records = [ReleaseAutopilotResult.model_validate(item) for item in scoped_records("release_autopilot")]
    if not records:
        return None
    return sorted(records, key=lambda item: item.generatedAt, reverse=True)[0]


def list_automation_rules() -> list[AutomationRule]:
    rules = [AutomationRule.model_validate(item) for item in scoped_records("automation_rules")]
    return sorted(rules, key=lambda item: item.updatedAt, reverse=True)


def list_automation_events() -> list[AutomationEvent]:
    events = [AutomationEvent.model_validate(item) for item in scoped_records("automation_events")]
    return sorted(events, key=lambda item: item.createdAt, reverse=True)


def sign_connector_payload(secret: str, payload: dict[str, Any]) -> str:
    body = str(sorted(payload.items())).encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), body, sha256).hexdigest()
    return f"sha256={digest}"


def env_flag_enabled(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def infer_webhook_connector_type(url: str | None) -> str:
    normalized = (url or "").lower()
    if "hooks.slack.com" in normalized or "slack.com" in normalized:
        return "slack"
    if "atlassian.net" in normalized or "jira" in normalized:
        return "jira"
    return "webhook"


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[int, str, dict[str, Any]]:
    with httpx.Client(timeout=10.0) as client:
        response = client.post(url, json=payload, headers=headers)
    try:
        response_payload = response.json()
    except ValueError:
        response_payload = {}
    return response.status_code, response.text, response_payload


def save_connector_delivery_record(delivery: ConnectorDelivery) -> ConnectorDelivery:
    save_scoped_record("connector_deliveries", delivery.id, delivery.model_dump())
    return delivery


def create_connector_delivery(
    webhook: dict[str, Any],
    subject_type: str,
    subject_id: str,
    payload: dict[str, Any],
    event_id: str | None = None,
    attempt: int = 1,
) -> ConnectorDelivery:
    secret = str(webhook.get("secret") or "")
    delivery_payload = {
        "workspaceId": current_workspace_id(),
        "subjectType": subject_type,
        "subjectId": subject_id,
        "event": payload,
    }
    created_at = datetime.now().isoformat()
    delivery = ConnectorDelivery(
        id=f"deliv_{token_hex(6)}",
        connectorType=infer_webhook_connector_type(str(webhook.get("url"))),
        connectorId=str(webhook["id"]),
        connectorName=str(webhook["name"]),
        subjectType=subject_type,
        subjectId=subject_id,
        eventId=event_id,
        status="pending",
        attempt=attempt,
        url=str(webhook.get("url")),
        signature=sign_connector_payload(secret, delivery_payload),
        payload=delivery_payload,
        lastError="External delivery worker is not running in local deterministic mode.",
        createdAt=created_at,
        nextRetryAt=created_at,
    )
    return save_connector_delivery_record(delivery)


def create_webhook_deliveries(subject_type: str, subject_id: str, payload: dict[str, Any], event_id: str | None = None) -> list[ConnectorDelivery]:
    webhooks = [webhook for webhook in settings_payload_or_404().get("webhooks", []) if webhook.get("status") == "active"]
    return [create_connector_delivery(webhook, subject_type, subject_id, payload, event_id) for webhook in webhooks]


def list_connector_deliveries() -> list[ConnectorDelivery]:
    deliveries = [ConnectorDelivery.model_validate(item) for item in scoped_records("connector_deliveries")]
    return sorted(deliveries, key=lambda item: item.createdAt, reverse=True)


def retry_connector_delivery(delivery_id: str) -> ConnectorDelivery:
    payload = get_scoped_record("connector_deliveries", delivery_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Connector delivery not found")
    delivery = ConnectorDelivery.model_validate(payload)
    webhook = next(
        (item for item in settings_payload_or_404().get("webhooks", []) if item.get("id") == delivery.connectorId),
        None,
    )
    if webhook is None:
        raise HTTPException(status_code=404, detail="Webhook connector not found")
    retried = create_connector_delivery(
        webhook,
        delivery.subjectType,
        delivery.subjectId,
        delivery.payload.get("event", {}),
        delivery.eventId,
        delivery.attempt + 1,
    )
    save_audit_event("connector.retry", "connector_delivery", retried.id, "review", f"Retried delivery {delivery_id}.")
    return retried


def mark_connector_delivery(delivery: ConnectorDelivery, status: str, last_error: str | None, payload_patch: dict[str, Any] | None = None) -> ConnectorDelivery:
    payload = delivery.payload
    if payload_patch:
        payload = {**payload, **payload_patch}
    updated = delivery.model_copy(
        update={
            "status": status,
            "payload": payload,
            "lastError": last_error,
            "nextRetryAt": datetime.now().isoformat() if status == "failed" else None,
        }
    )
    return save_connector_delivery_record(updated)


def process_connector_delivery(delivery: ConnectorDelivery) -> ConnectorDelivery:
    if not delivery.url:
        return mark_connector_delivery(delivery, "failed", "Connector delivery has no target URL.")
    headers = {
        "Content-Type": "application/json",
        "X-NeuralOps-Signature": delivery.signature,
        "X-NeuralOps-Delivery-Id": delivery.id,
        "X-NeuralOps-Workspace-Id": current_workspace_id(),
    }
    try:
        status_code, response_text, response_payload = post_json(delivery.url, delivery.payload, headers)
    except httpx.HTTPError as exc:
        save_audit_event("connector.delivery_failed", "connector_worker", delivery.id, "review", str(exc))
        return mark_connector_delivery(delivery, "failed", str(exc))
    if 200 <= status_code < 300:
        save_audit_event("connector.delivered", "connector_worker", delivery.id, "allow", f"Delivered {delivery.connectorType} notification.")
        return mark_connector_delivery(delivery, "delivered", None, {"response": response_payload})
    error = f"HTTP {status_code}: {response_text[:240]}"
    save_audit_event("connector.delivery_failed", "connector_worker", delivery.id, "review", error)
    return mark_connector_delivery(delivery, "failed", error)


def process_connector_delivery_queue(request: ConnectorDeliveryProcessRequest) -> ConnectorDeliveryProcessResult:
    pending = [
        delivery
        for delivery in list_connector_deliveries()
        if delivery.status in {"pending", "failed"}
    ][: request.limit]
    if not request.sendExternal:
        return ConnectorDeliveryProcessResult(
            processed=0,
            delivered=0,
            failed=0,
            skipped=len(pending),
            mode="dry_run",
            deliveries=pending,
        )
    if not env_flag_enabled("NEURALOPS_DELIVERY_SEND_ENABLED"):
        raise HTTPException(
            status_code=409,
            detail="External connector sending is disabled. Set NEURALOPS_DELIVERY_SEND_ENABLED=true to run the worker.",
        )
    processed: list[ConnectorDelivery] = []
    for delivery in pending:
        processed.append(process_connector_delivery(delivery))
    return ConnectorDeliveryProcessResult(
        processed=len(processed),
        delivered=sum(1 for item in processed if item.status == "delivered"),
        failed=sum(1 for item in processed if item.status == "failed"),
        skipped=0,
        mode="external_send",
        deliveries=processed,
    )


def create_github_delivery(request: GitHubPrCommentRequest) -> ConnectorDelivery:
    url = f"https://api.github.com/repos/{request.owner}/{request.repo}/issues/{request.issueNumber}/comments"
    delivery_payload = {
        "workspaceId": current_workspace_id(),
        "subjectType": "github_pr",
        "subjectId": f"{request.owner}/{request.repo}#{request.issueNumber}",
        "event": {
            "owner": request.owner,
            "repo": request.repo,
            "issueNumber": request.issueNumber,
            "body": request.body,
        },
    }
    created_at = datetime.now().isoformat()
    delivery = ConnectorDelivery(
        id=f"deliv_{token_hex(6)}",
        connectorType="github",
        connectorId=f"github:{request.owner}/{request.repo}#{request.issueNumber}",
        connectorName=f"GitHub PR #{request.issueNumber}",
        subjectType="github_pr",
        subjectId=f"{request.owner}/{request.repo}#{request.issueNumber}",
        status="pending",
        attempt=1,
        url=url,
        signature=sign_connector_payload(os.getenv("NEURALOPS_SECRET_KEY", "neuralops-github-comment"), delivery_payload),
        payload=delivery_payload,
        lastError=None,
        createdAt=created_at,
        nextRetryAt=created_at,
    )
    return save_connector_delivery_record(delivery)


def post_github_pr_comment(request: GitHubPrCommentRequest) -> GitHubPrCommentResult:
    delivery = create_github_delivery(request)
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not request.sendExternal:
        skipped = mark_connector_delivery(delivery, "skipped", "GitHub comment dry-run only; external posting was not requested.")
        return GitHubPrCommentResult(posted=False, delivery=skipped, message="Dry run recorded. No GitHub request was sent.")
    if not env_flag_enabled("NEURALOPS_GITHUB_SEND_ENABLED") or not token:
        skipped = mark_connector_delivery(delivery, "skipped", "GitHub posting is not configured. Set NEURALOPS_GITHUB_SEND_ENABLED=true and GITHUB_TOKEN.")
        return GitHubPrCommentResult(posted=False, delivery=skipped, message="GitHub posting is not configured.")
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        status_code, response_text, response_payload = post_json(str(delivery.url), {"body": request.body}, headers)
    except httpx.HTTPError as exc:
        failed = mark_connector_delivery(delivery, "failed", str(exc))
        save_audit_event("github.comment_failed", "github_connector", failed.id, "review", str(exc))
        return GitHubPrCommentResult(posted=False, delivery=failed, message="GitHub request failed.")
    if 200 <= status_code < 300:
        html_url = response_payload.get("html_url") if isinstance(response_payload, dict) else None
        delivered = mark_connector_delivery(delivery, "delivered", None, {"response": {"htmlUrl": html_url}})
        save_audit_event("github.comment_posted", "github_connector", delivered.id, "allow", f"Posted GitHub PR comment to {request.owner}/{request.repo}#{request.issueNumber}.")
        return GitHubPrCommentResult(posted=True, delivery=delivered, url=html_url, message="GitHub PR comment posted.")
    error = f"HTTP {status_code}: {response_text[:240]}"
    failed = mark_connector_delivery(delivery, "failed", error)
    save_audit_event("github.comment_failed", "github_connector", failed.id, "review", error)
    return GitHubPrCommentResult(posted=False, delivery=failed, message=error)


def create_automation_incident(rule: AutomationRule, subject_id: str, summary: str) -> Incident:
    incident = Incident(
        id=f"inc_auto_{token_hex(5)}",
        title=f"Automation: {rule.name}",
        severity=rule.severity,
        status="Open",
        time=datetime.now().isoformat(),
        owner=rule.owner,
    )
    payload = incident.model_dump()
    payload["source"] = "automation"
    payload["subjectId"] = subject_id
    payload["summary"] = summary
    save_scoped_record("incidents", incident.id, payload)
    return incident


def record_automation_event(
    rule: AutomationRule,
    subject_type: str,
    subject_id: str,
    decision: str,
    summary: str,
    status: str,
    result: dict[str, Any],
) -> AutomationEvent:
    event = AutomationEvent(
        id=f"autoevt_{token_hex(6)}",
        ruleId=rule.id,
        ruleName=rule.name,
        trigger=rule.trigger,
        action=rule.action,
        subjectType=subject_type,
        subjectId=subject_id,
        decision=decision,  # type: ignore[arg-type]
        summary=summary,
        status=status,  # type: ignore[arg-type]
        result=result,
        createdAt=datetime.now().isoformat(),
    )
    save_scoped_record("automation_events", event.id, event.model_dump())
    updated_rule = rule.model_copy(update={"lastRunAt": event.createdAt, "runCount": rule.runCount + 1, "updatedAt": event.createdAt})
    save_scoped_record("automation_rules", rule.id, updated_rule.model_dump())
    return event


def run_matching_automations(
    trigger: AutomationTrigger,
    subject_type: str,
    subject_id: str,
    decision: str,
    summary: str,
) -> list[AutomationEvent]:
    events: list[AutomationEvent] = []
    for rule in list_automation_rules():
        if not rule.enabled or rule.trigger != trigger:
            continue
        result: dict[str, Any] = {"action": rule.action}
        status = "recorded"
        if rule.action == "create_incident":
            incident = create_automation_incident(rule, subject_id, summary)
            result.update({"incidentId": incident.id, "incidentStatus": incident.status, "owner": incident.owner})
        elif rule.action == "webhook_record":
            deliveries = create_webhook_deliveries(
                subject_type,
                subject_id,
                {
                    "ruleId": rule.id,
                    "ruleName": rule.name,
                    "trigger": trigger,
                    "decision": decision,
                    "summary": summary,
                },
            )
            webhook_count = len(deliveries)
            status = "recorded" if webhook_count else "skipped"
            result.update(
                {
                    "webhookCount": webhook_count,
                    "deliveryAttemptIds": [delivery.id for delivery in deliveries],
                    "externalDelivery": False,
                    "reason": "Signed webhook delivery attempts are persisted for a worker; external network sending is disabled in local deterministic mode.",
                }
            )
        else:
            result.update({"auditOnly": True})
        event = record_automation_event(rule, subject_type, subject_id, decision, summary, status, result)
        save_audit_event(
            "automation.run",
            "automation_engine",
            event.id,
            decision,  # type: ignore[arg-type]
            f"Rule {rule.name} handled {trigger} for {subject_id}: {status}.",
        )
        events.append(event)
    return events


def trigger_release_gate_automations(result: ReleaseGateResult) -> None:
    if result.decision == "block":
        run_matching_automations("release_gate.blocked", "release_gate", result.id, result.decision, f"Release gate blocked {result.target}.")
    elif result.decision == "review":
        run_matching_automations("release_gate.review", "release_gate", result.id, result.decision, f"Release gate requires review for {result.target}.")


def trigger_trace_automations(trace: Trace) -> None:
    if trace.status == "blocked":
        run_matching_automations("trace.blocked", "trace", trace.id, "block", f"Trace {trace.id} was blocked by policy or evaluation.")
    elif trace.status == "failed":
        run_matching_automations("trace.failed", "trace", trace.id, "review", f"Trace {trace.id} failed and needs investigation.")


def build_evidence_report() -> EvidenceReport:
    status = build_system_status()
    gate = latest_release_gate()
    saved_gates = list_release_gate_definitions()
    summary = {
        "decision": gate.decision if gate else "review",
        "readinessScore": status.readinessScore,
        "configuredFeatures": sum(1 for feature in status.features if feature.state != "not_configured"),
        "blockedFeatures": sum(1 for feature in status.features if feature.state == "not_configured"),
        "savedReleaseGates": len(saved_gates),
    }
    markdown_lines = [
        "# NeuralOps Evidence Report",
        "",
        f"- Generated: {status.generatedAt}",
        f"- Storage: {status.storage}",
        f"- Workspace: {status.workspaceId}",
        f"- Readiness score: {status.readinessScore}/100",
        f"- Saved release gates: {len(saved_gates)}",
        f"- Latest gate decision: {gate.decision if gate else 'not_run'}",
        "",
        "## Feature Truth Contract",
        *[f"- **{feature.label}**: `{feature.state}` - {feature.evidence}" for feature in status.features],
    ]
    if gate:
        markdown_lines.extend(
            [
                "",
                "## Release Gate Checks",
                *[f"- **{check.label}**: `{check.status}` - {check.evidence}" for check in gate.checks],
            ]
        )
    if saved_gates:
        markdown_lines.extend(
            [
                "",
                "## Saved Release Gates",
                *[
                    f"- **{saved_gate.name}** (`{saved_gate.id}`): target `{saved_gate.target}`, last decision `{saved_gate.lastDecision or 'not_run'}`"
                    for saved_gate in saved_gates
                ],
            ]
        )
    report = EvidenceReport(
        id=f"evidence_{token_hex(6)}",
        generatedAt=datetime.now().isoformat(),
        status=status,
        latestGate=gate,
        summary=summary,
        markdown="\n".join(markdown_lines),
    )
    save_scoped_record("evidence_reports", report.id, report.model_dump())
    return report


def api_base_url() -> str:
    return os.getenv("NEURALOPS_PUBLIC_API_URL", "http://localhost:8000").rstrip("/")


def build_connect_guide() -> ConnectGuide:
    base_url = api_base_url()
    snippets = [
        ConnectSnippet(
            id="javascript",
            label="Node / JavaScript SDK",
            language="javascript",
            command="npm install @neuralops/sdk",
            code=(
                "import { NeuralOps } from '@neuralops/sdk';\n\n"
                "const neuralops = new NeuralOps({\n"
                "  apiKey: process.env.NEURALOPS_API_KEY,\n"
                f"  baseUrl: process.env.NEURALOPS_API_URL || '{base_url}'\n"
                "});\n\n"
                "await neuralops.ingestTrace({\n"
                "  session: 'checkout-agent-001',\n"
                "  environment: 'staging',\n"
                "  model: 'llama-3.3-70b-versatile',\n"
                "  tokens: 742,\n"
                "  latencyMs: 830,\n"
                "  costUsd: 0.012,\n"
                "  status: 'success',\n"
                "  score: 0.93,\n"
                "  prompt: 'Classify checkout outage ticket',\n"
                "  output: 'P1 incident routed to payments on-call'\n"
                "});"
            ),
            notes=["Use server-side environment variables only.", "Do not send raw secrets in prompts or outputs."],
        ),
        ConnectSnippet(
            id="python",
            label="Python / FastAPI SDK",
            language="python",
            command="pip install neuralops-sdk",
            code=(
                "import os\n"
                "from neuralops import NeuralOpsClient\n\n"
                "client = NeuralOpsClient(\n"
                "    api_key=os.environ['NEURALOPS_API_KEY'],\n"
                f"    base_url=os.getenv('NEURALOPS_API_URL', '{base_url}'),\n"
                ")\n\n"
                "client.ingest_trace(\n"
                "    session='rag-api-001',\n"
                "    environment='staging',\n"
                "    model='gpt-4o-mini',\n"
                "    tokens=512,\n"
                "    latency_ms=420,\n"
                "    cost_usd=0.006,\n"
                "    status='success',\n"
                "    score=0.91,\n"
                "    prompt='Answer billing policy question',\n"
                "    output='Answered from retrieval context',\n"
                ")"
            ),
            notes=["Wrap model calls in try/finally so failures are also ingested.", "Use API keys created from Settings or Connect."],
        ),
        ConnectSnippet(
            id="curl",
            label="Direct REST Ingest",
            language="bash",
            command=None,
            code=(
                f"curl -X POST {base_url}/api/traces/ingest \\\n"
                "  -H \"Content-Type: application/json\" \\\n"
                "  -H \"x-neuralops-key: $NEURALOPS_API_KEY\" \\\n"
                "  -d '{\n"
                "    \"session\":\"manual-smoke-001\",\n"
                "    \"environment\":\"staging\",\n"
                "    \"model\":\"manual-test\",\n"
                "    \"tokens\":128,\n"
                "    \"latencyMs\":240,\n"
                "    \"costUsd\":0.001,\n"
                "    \"status\":\"success\",\n"
                "    \"score\":0.95,\n"
                "    \"prompt\":\"connection smoke test\",\n"
                "    \"output\":\"trace accepted\"\n"
                "  }'"
            ),
            notes=["This is the fastest way to test a new workspace key."],
        ),
        ConnectSnippet(
            id="otel",
            label="OpenTelemetry Collector",
            language="yaml",
            command=None,
            code=(
                "exporters:\n"
                "  otlphttp/neuralops:\n"
                f"    endpoint: {base_url}/api/traces/otel\n"
                "    headers:\n"
                "      x-neuralops-key: ${NEURALOPS_API_KEY}\n\n"
                "service:\n"
                "  pipelines:\n"
                "    traces:\n"
                "      receivers: [otlp]\n"
                "      processors: [batch]\n"
                "      exporters: [otlphttp/neuralops]\n"
            ),
            notes=["Use for teams already collecting OpenTelemetry spans.", "Prompt content capture should follow your privacy policy."],
        ),
    ]
    return ConnectGuide(
        apiBaseUrl=base_url,
        ingestEndpoint=f"{base_url}/api/traces/ingest",
        otelEndpoint=f"{base_url}/api/traces/otel",
        authHeader="x-neuralops-key",
        snippets=snippets,
        generatedAt=datetime.now().isoformat(),
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "neuralops-api", "version": app.version, "storage": storage_backend()}


@app.get("/api/system/status", response_model=SystemStatus)
def system_status() -> SystemStatus:
    return build_system_status()


@app.post("/api/release-gate/run", response_model=ReleaseGateResult)
def release_gate(request: ReleaseGateRequest) -> ReleaseGateResult:
    return run_release_gate(request)


@app.get("/api/release-gate/latest", response_model=ReleaseGateResult | None)
def release_gate_latest() -> ReleaseGateResult | None:
    return latest_release_gate()


@app.get("/api/release-gates", response_model=list[ReleaseGateDefinition])
def release_gates() -> list[ReleaseGateDefinition]:
    return list_release_gate_definitions()


@app.post("/api/release-gates", response_model=ReleaseGateDefinition)
def create_release_gate(request: ReleaseGateDefinitionCreate) -> ReleaseGateDefinition:
    now = datetime.now().isoformat()
    gate = ReleaseGateDefinition(
        id=f"rg_{token_hex(5)}",
        name=request.name,
        target=request.target,
        promptId=request.promptId,
        maxLatencyMs=request.maxLatencyMs,
        maxErrorRate=request.maxErrorRate,
        minEvalPassRate=request.minEvalPassRate,
        requireLiveProvider=request.requireLiveProvider,
        requireAuth=request.requireAuth,
        description=request.description,
        createdAt=now,
        updatedAt=now,
    )
    save_scoped_record("release_gate_definitions", gate.id, gate.model_dump())
    save_audit_event("release_gate.create", current_workspace_id(), gate.id, "allow", f"Created release gate {gate.name}.")
    return gate


@app.get("/api/release-gates/{gate_id}", response_model=ReleaseGateDefinition)
def release_gate_definition(gate_id: str) -> ReleaseGateDefinition:
    payload = get_scoped_record("release_gate_definitions", gate_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    return ReleaseGateDefinition.model_validate(payload)


@app.patch("/api/release-gates/{gate_id}", response_model=ReleaseGateDefinition)
def patch_release_gate(gate_id: str, patch: ReleaseGateDefinitionPatch) -> ReleaseGateDefinition:
    existing = get_scoped_record("release_gate_definitions", gate_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    payload = ReleaseGateDefinition.model_validate(existing).model_dump()
    payload.update(patch.model_dump(exclude_unset=True, exclude_none=True))
    payload["updatedAt"] = datetime.now().isoformat()
    saved = ReleaseGateDefinition.model_validate(save_scoped_record("release_gate_definitions", gate_id, payload))
    save_audit_event("release_gate.update", current_workspace_id(), gate_id, "allow", f"Updated release gate {saved.name}.")
    return saved


@app.delete("/api/release-gates/{gate_id}")
def delete_release_gate(gate_id: str) -> dict[str, Any]:
    if get_scoped_record("release_gate_definitions", gate_id) is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    delete_scoped_record("release_gate_definitions", gate_id)
    save_audit_event("release_gate.delete", current_workspace_id(), gate_id, "allow", "Deleted release gate definition.")
    return {"ok": True, "deleted": gate_id}


@app.get("/api/release-gates/{gate_id}/runs", response_model=list[ReleaseGateResult])
def release_gate_runs(gate_id: str) -> list[ReleaseGateResult]:
    if get_scoped_record("release_gate_definitions", gate_id) is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    runs = [
        ReleaseGateResult.model_validate(item)
        for item in scoped_records("release_gates")
        if item.get("gateId") == gate_id
    ]
    return sorted(runs, key=lambda item: item.generatedAt, reverse=True)


@app.post("/api/release-gates/{gate_id}/run", response_model=ReleaseGateResult)
def run_saved_release_gate(gate_id: str, request: ReleaseGateRunRequest | None = None) -> ReleaseGateResult:
    payload = get_scoped_record("release_gate_definitions", gate_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    return run_release_gate_definition(ReleaseGateDefinition.model_validate(payload), request)


@app.get("/api/evidence", response_model=EvidenceReport)
def evidence_report() -> EvidenceReport:
    return build_evidence_report()


@app.post("/api/release-autopilot/run", response_model=ReleaseAutopilotResult)
def release_autopilot_run(request: ReleaseAutopilotRequest) -> ReleaseAutopilotResult:
    return run_release_autopilot(request)


@app.get("/api/release-autopilot/latest", response_model=ReleaseAutopilotResult | None)
def release_autopilot_latest() -> ReleaseAutopilotResult | None:
    return latest_release_autopilot()


@app.get("/api/automations", response_model=list[AutomationRule])
def automation_rules() -> list[AutomationRule]:
    return list_automation_rules()


@app.post("/api/automations", response_model=AutomationRule)
def create_automation_rule(request: AutomationRuleCreate) -> AutomationRule:
    now = datetime.now().isoformat()
    rule = AutomationRule(
        id=f"auto_{token_hex(5)}",
        name=request.name,
        trigger=request.trigger,
        action=request.action,
        enabled=request.enabled,
        severity=request.severity,
        owner=request.owner,
        description=request.description,
        createdAt=now,
        updatedAt=now,
    )
    save_scoped_record("automation_rules", rule.id, rule.model_dump())
    save_audit_event("automation.create", current_workspace_id(), rule.id, "allow", f"Created automation rule {rule.name}.")
    return rule


@app.patch("/api/automations/{rule_id}", response_model=AutomationRule)
def patch_automation_rule(rule_id: str, patch: AutomationRulePatch) -> AutomationRule:
    existing = get_scoped_record("automation_rules", rule_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Automation rule not found")
    payload = AutomationRule.model_validate(existing).model_dump()
    payload.update(patch.model_dump(exclude_unset=True, exclude_none=True))
    payload["updatedAt"] = datetime.now().isoformat()
    saved = AutomationRule.model_validate(save_scoped_record("automation_rules", rule_id, payload))
    save_audit_event("automation.update", current_workspace_id(), rule_id, "allow", f"Updated automation rule {saved.name}.")
    return saved


@app.post("/api/automations/{rule_id}/run-test", response_model=AutomationEvent)
def run_automation_test(rule_id: str, request: AutomationRunTestRequest) -> AutomationEvent:
    existing = get_scoped_record("automation_rules", rule_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Automation rule not found")
    rule = AutomationRule.model_validate(existing)
    if not rule.enabled:
        raise HTTPException(status_code=409, detail="Automation rule is disabled")
    events = run_matching_automations(rule.trigger, request.subjectType, request.subjectId, request.decision, request.summary)
    event = next((item for item in events if item.ruleId == rule_id), None)
    if event is None:
        raise HTTPException(status_code=409, detail="Automation rule did not match its configured trigger")
    return event


@app.get("/api/automation-events", response_model=list[AutomationEvent])
def automation_events() -> list[AutomationEvent]:
    return list_automation_events()


@app.get("/api/connector-deliveries", response_model=list[ConnectorDelivery])
def connector_deliveries() -> list[ConnectorDelivery]:
    return list_connector_deliveries()


@app.post("/api/connector-deliveries/{delivery_id}/retry", response_model=ConnectorDelivery)
def connector_delivery_retry(delivery_id: str) -> ConnectorDelivery:
    return retry_connector_delivery(delivery_id)


@app.post("/api/connector-deliveries/process", response_model=ConnectorDeliveryProcessResult)
def connector_delivery_process(request: ConnectorDeliveryProcessRequest) -> ConnectorDeliveryProcessResult:
    return process_connector_delivery_queue(request)


@app.post("/api/github/pr-comment", response_model=GitHubPrCommentResult)
def github_pr_comment(request: GitHubPrCommentRequest) -> GitHubPrCommentResult:
    return post_github_pr_comment(request)


@app.get("/api/connect/guide", response_model=ConnectGuide)
def connect_guide() -> ConnectGuide:
    return build_connect_guide()


@app.post("/api/connect/verify", response_model=ConnectVerifyResponse)
def verify_connect_ingest(
    request: ConnectVerifyRequest,
    authorization: str | None = Header(default=None),
    neuralops_key: str | None = Header(default=None, alias="x-neuralops-key"),
) -> ConnectVerifyResponse:
    api_key = authenticate_api_key(authorization, neuralops_key)
    now = datetime.now()
    trace = Trace(
        id=f"tr_conn_{token_hex(6)}",
        timestamp=now.strftime("%H:%M:%S"),
        session=f"{request.serviceName}-connect-{token_hex(3)}",
        environment=request.environment,
        model=f"neuralops-connect-{request.sdk}",
        tokens=64,
        latency="0.01s",
        cost="$0.000",
        status="success",
        score=1,
        prompt=f"Connection verification from {request.serviceName} using {request.sdk}.",
        output="NeuralOps accepted the ingest key and stored this verification trace.",
        toolCalls="connect.verify",
        source="api",
        riskFlags=["connection-verification"],
    )
    save_scoped_record("traces", trace.id, trace.model_dump())
    audit = save_audit_event(
        "connect.verify",
        api_key.get("name", api_key.get("id", "api-key")),
        trace.id,
        "allow",
        f"Verified {request.sdk} ingest for {request.serviceName}.",
    )
    return ConnectVerifyResponse(
        ok=True,
        trace=trace,
        auditId=audit.id,
        message=f"Connection verified. Trace {trace.id} was stored.",
    )


@app.get("/api/dashboard", response_model=DashboardSnapshot)
def dashboard() -> DashboardSnapshot:
    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    incidents = [Incident.model_validate(item) for item in scoped_records("incidents")]
    stats = build_stats(traces, incidents)
    return DashboardSnapshot(stats=stats, traces=traces[:50], incidents=incidents)


@app.get("/api/traces", response_model=list[Trace])
def traces() -> list[Trace]:
    return [Trace.model_validate(item) for item in scoped_records("traces")]


@app.get("/api/traces/{trace_id}", response_model=Trace)
def trace_detail(trace_id: str) -> Trace:
    trace = get_scoped_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return Trace.model_validate(trace)


@app.post("/api/traces/otel", response_model=OtelIngestResult)
def ingest_otel_trace(
    request: OtelIngestRequest,
    authorization: str | None = Header(default=None),
    neuralops_key: str | None = Header(default=None, alias="x-neuralops-key"),
) -> OtelIngestResult:
    authenticate_api_key(authorization, neuralops_key, "trace:ingest")
    try:
        trace, findings = normalize_otel_payload(request.payload, request.environment)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    save_scoped_record("traces", trace.id, trace.model_dump())
    trigger_trace_automations(trace)
    decision = "block" if trace.status == "blocked" else "review" if trace.status == "warning" else "allow"
    return OtelIngestResult(decision=decision, trace=trace, spanCount=trace.spanCount, findings=findings)


@app.post("/api/traces/otel/sample", response_model=OtelIngestResult)
def ingest_sample_otel_trace() -> OtelIngestResult:
    raise HTTPException(status_code=410, detail="Sample OTEL ingestion is disabled in real-data mode")


@app.post("/api/traces/ingest", response_model=TraceIngestResponse)
def ingest_trace(
    request: TraceIngestRequest,
    authorization: str | None = Header(default=None),
    neuralops_key: str | None = Header(default=None, alias="x-neuralops-key"),
) -> TraceIngestResponse:
    api_key = authenticate_api_key(authorization, neuralops_key)
    now = datetime.now()
    trace = Trace(
        id=f"tr_ing_{token_hex(6)}",
        timestamp=now.strftime("%H:%M:%S"),
        session=request.session,
        environment=request.environment,
        model=request.model,
        tokens=request.tokens,
        latency=f"{request.latencyMs / 1000:.2f}s",
        cost=f"${request.costUsd:.3f}",
        status=request.status,
        score=request.score,
        prompt=request.prompt,
        output=request.output,
        toolCalls=request.toolCalls,
        source="api",
        riskFlags=request.riskFlags,
    )
    save_scoped_record("traces", trace.id, trace.model_dump())
    trigger_trace_automations(trace)
    decision = "block" if trace.status == "blocked" else "review" if trace.status in {"warning", "failed"} else "allow"
    audit = save_audit_event(
        "trace.ingest",
        api_key.get("name", api_key.get("id", "api-key")),
        trace.id,
        decision,
        f"Ingested {trace.model} trace for session {trace.session}.",
    )
    return TraceIngestResponse(trace=trace, auditId=audit.id)


@app.post("/api/traces/{trace_id}/replay", response_model=ReplayResult)
def replay_existing_trace(trace_id: str) -> ReplayResult:
    trace = get_scoped_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return replay_trace(trace)


@app.post("/api/traces/simulate", response_model=Trace)
def simulate_trace() -> Trace:
    raise HTTPException(status_code=410, detail="Random trace simulation is disabled in real-data mode")


@app.get("/api/incidents", response_model=list[Incident])
def incidents() -> list[Incident]:
    return [Incident.model_validate(item) for item in scoped_records("incidents")]


@app.patch("/api/incidents/{incident_id}", response_model=Incident)
def patch_incident(incident_id: str, patch: IncidentPatch) -> Incident:
    updated = update_scoped_record("incidents", incident_id, patch.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return Incident.model_validate(updated)


@app.get("/api/prompts", response_model=list[PromptVersion])
def prompts() -> list[PromptVersion]:
    return [PromptVersion.model_validate(item) for item in scoped_records("prompts")]


@app.post("/api/prompts/{prompt_id}/deploy", response_model=PromptVersion)
def deploy_prompt(prompt_id: str) -> PromptVersion:
    prompt = get_scoped_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["status"] = "Production"
    prompt["canaryPercent"] = 100
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_scoped_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/traffic", response_model=PromptVersion)
def update_prompt_traffic(prompt_id: str, request: PromptTrafficUpdate) -> PromptVersion:
    prompt = get_scoped_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["canaryPercent"] = request.canaryPercent
    prompt["status"] = "Production" if request.canaryPercent == 100 else "Canary"
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_scoped_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/rollback", response_model=PromptVersion)
def rollback_prompt(prompt_id: str) -> PromptVersion:
    prompt = get_scoped_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    history = prompt.get("history", [])
    if len(history) < 2:
        raise HTTPException(status_code=409, detail="No previous prompt version recorded")
    previous = history[1]
    current = {
        "version": prompt["version"],
        "date": datetime.now().strftime("%Y-%m-%d"),
        "owner": prompt.get("owner", "AI Platform"),
        "score": prompt.get("evalScore", 0),
        "status": "Archived",
    }
    prompt["version"] = previous["version"]
    prompt["status"] = "Production"
    prompt["canaryPercent"] = 0
    prompt["evalScore"] = previous["score"]
    prompt["updatedAt"] = datetime.now().isoformat()
    prompt["history"] = [{**previous, "status": "Production"}, current, *history[2:]]
    return PromptVersion.model_validate(save_scoped_record("prompts", prompt_id, prompt))


@app.get("/api/evals", response_model=list[Evaluator])
def evals() -> list[Evaluator]:
    return [Evaluator.model_validate(item) for item in scoped_records("evals")]


@app.post("/api/evals/run", response_model=list[Evaluator])
def run_evals() -> list[Evaluator]:
    records = []
    for evaluator in scoped_records("evals"):
        evaluator["lastRun"] = "just now"
        evaluator["passRate"] = min(0.99, round(float(evaluator["passRate"]) + 0.01, 2))
        records.append(save_scoped_record("evals", evaluator["id"], evaluator))
    return [Evaluator.model_validate(item) for item in records]


@app.get("/api/rag", response_model=list[RagQuery])
def rag() -> list[RagQuery]:
    return [RagQuery.model_validate(item) for item in scoped_records("rag")]


@app.post("/api/rag/test", response_model=RagQuery)
def test_rag_retrieval(request: RagRetrievalTestRequest) -> RagQuery:
    query = get_scoped_record("rag", request.queryId)
    if query is None:
        raise HTTPException(status_code=404, detail="RAG query not found")

    reranker_bonus = 0.03 if request.reranker != "none" else -0.02
    chunk_penalty = abs(request.chunkSize - 512) / 4096
    top_k_penalty = abs(request.topK - len(query.get("chunks", []))) / 50
    model_bonus = 0.02 if "large" in request.embeddingModel else 0
    adjustment = reranker_bonus + model_bonus - chunk_penalty - top_k_penalty

    for metric in ("faithfulness", "relevance", "precision", "recall"):
        query[metric] = max(0.0, min(0.99, round(float(query.get(metric, 0)) + adjustment, 2)))

    save_scoped_record("rag", request.queryId, query)
    return RagQuery.model_validate(query)


@app.get("/api/costs")
def costs() -> dict[str, Any]:
    return get_record("costs", costs_record_id()) or {}


@app.patch("/api/costs/budget")
def update_cost_budget(request: CostBudgetUpdateRequest) -> dict[str, Any]:
    payload = get_record("costs", costs_record_id()) or {}
    summary = payload.setdefault("summary", {})
    summary["budgetLimit"] = request.budgetLimit
    summary.setdefault("mtdSpend", 0)
    summary.setdefault("projectedSpend", summary["mtdSpend"])
    saved = save_record("costs", costs_record_id(), stamp_workspace(payload))
    save_audit_event(
        "cost.budget_update",
        current_workspace_id(),
        "costs.current",
        "allow",
        f"Updated monthly budget limit to {request.budgetLimit}.",
    )
    return saved


@app.post("/api/costs/simulate-anomaly")
def simulate_cost_anomaly() -> dict[str, Any]:
    raise HTTPException(status_code=410, detail="Cost anomaly simulation is disabled in real-data mode")


@app.get("/api/policies", response_model=list[Policy])
def policies() -> list[Policy]:
    return [Policy.model_validate(item) for item in list_records("policies")]


@app.patch("/api/policies/{policy_id}", response_model=Policy)
def patch_policy(policy_id: str, patch: PolicyPatch) -> Policy:
    updated = update_record("policies", policy_id, patch.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    return Policy.model_validate(updated)


@app.get("/api/policy-violations", response_model=list[PolicyViolation])
def policy_violations() -> list[PolicyViolation]:
    return [PolicyViolation.model_validate(item) for item in scoped_records("policy_violations")]


@app.post("/api/policies/test", response_model=PolicyTestResult)
def test_policy(request: PolicyTestRequest) -> PolicyTestResult:
    text = request.input.lower()
    critical_patterns = ["ignore previous", "ignore standard", "password", "api key", "secret", "token"]
    matched = [pattern for pattern in critical_patterns if pattern in text]
    if matched:
        return PolicyTestResult(
            decision="block",
            severity="Critical",
            reason="Input matched prompt-injection or credential exfiltration patterns.",
            matchedPatterns=matched,
        )
    if "external" in text or "send" in text or "webhook" in text:
        return PolicyTestResult(
            decision="review",
            severity="Major",
            reason="Input asks for external communication or tool use and requires approval.",
            matchedPatterns=["external-tool"],
        )
    return PolicyTestResult(decision="allow", severity=None, reason="No configured policy matched.", matchedPatterns=[])


@app.get("/api/agents", response_model=list[AgentRuntime])
def agents() -> list[AgentRuntime]:
    return [AgentRuntime.model_validate(item) for item in scoped_records("agents")]


@app.get("/api/agent-runtime/definitions", response_model=list[AgentDefinition])
def agent_definitions() -> list[AgentDefinition]:
    return AGENT_DEFINITIONS


@app.get("/api/agent-runtime/providers", response_model=list[ProviderStatus])
def provider_status() -> list[ProviderStatus]:
    return list_providers()


@app.get("/api/providers/catalog", response_model=list[ProviderPreset])
def provider_catalog() -> list[ProviderPreset]:
    return list_provider_presets()


@app.get("/api/providers/connections", response_model=list[ProviderConnection])
def list_provider_connections() -> list[ProviderConnection]:
    return provider_connections(current_workspace_id())


@app.post("/api/providers/connections", response_model=ProviderConnection)
def add_provider_connection(request: ProviderConnectionCreate) -> ProviderConnection:
    connection = create_provider_connection(request, current_workspace_id())
    save_audit_event(
        "provider.connection.create",
        current_workspace_id(),
        connection.id,
        "allow",
        f"Created provider connection {connection.label} for {connection.environment}.",
    )
    return connection


@app.post("/api/providers/connections/{connection_id}/test", response_model=ProviderConnectionTestResult)
def run_provider_connection_test(connection_id: str) -> ProviderConnectionTestResult:
    result = test_provider_connection(connection_id, current_workspace_id())
    if result is None:
        raise HTTPException(status_code=404, detail="Provider connection not found")
    save_audit_event(
        "provider.connection.test",
        current_workspace_id(),
        connection_id,
        "allow" if result.ok else "review",
        result.message,
    )
    return result


@app.get("/api/agent-runtime/runs", response_model=list[AgentRunRecord])
def agent_runs() -> list[AgentRunRecord]:
    return [AgentRunRecord.model_validate(item) for item in scoped_records("agent_runs")]


@app.get("/api/agent-runtime/runs/{run_id}", response_model=AgentRunRecord)
def agent_run_detail(run_id: str) -> AgentRunRecord:
    run = get_scoped_record("agent_runs", run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return AgentRunRecord.model_validate(run)


@app.post("/api/agent-runtime/run", response_model=AgentRunResponse)
def execute_agent(request: AgentRunRequest) -> AgentRunResponse:
    try:
        run, trace = run_agent(request)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    save_scoped_record("agent_runs", run.id, run.model_dump())
    save_scoped_record("traces", trace.id, trace.model_dump())
    trigger_trace_automations(trace)
    return AgentRunResponse(run=run, trace=trace)


@app.get("/api/labs/experiments", response_model=list[LabExperiment])
def lab_experiments() -> list[LabExperiment]:
    experiments = [LabExperiment.model_validate(item) for item in scoped_records("lab_experiments")]
    return sorted(experiments, key=lambda item: item.createdAt, reverse=True)


@app.get("/api/labs/experiments/{experiment_id}", response_model=LabExperiment)
def lab_experiment_detail(experiment_id: str) -> LabExperiment:
    experiment = get_scoped_record("lab_experiments", experiment_id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="Lab experiment not found")
    return LabExperiment.model_validate(experiment)


@app.post("/api/labs/run", response_model=LabRunResponse)
def run_lab_experiment(request: LabRunRequest) -> LabRunResponse:
    variants: list[LabVariantResult] = []
    traces: list[Trace] = []
    failures: list[dict[str, str]] = []

    for agent_id in dict.fromkeys(request.agentIds):
        try:
            run, trace = run_agent(
                AgentRunRequest(
                    agentId=agent_id,
                    input=request.input,
                    providerMode=request.providerMode,
                    model=request.model,
                    environment=request.environment,
                )
            )
        except ValueError as exc:
            failures.append({"agentId": agent_id, "error": str(exc)})
            continue
        except RuntimeError as exc:
            failures.append({"agentId": agent_id, "error": str(exc)})
            continue

        save_scoped_record("agent_runs", run.id, run.model_dump())
        save_scoped_record("traces", trace.id, trace.model_dump())
        trigger_trace_automations(trace)
        variants.append(
            LabVariantResult(
                agentId=run.agentId,
                agentName=run.agentName,
                runId=run.id,
                traceId=run.traceId,
                provider=run.provider,
                model=run.model,
                decision=run.decision,
                score=run.score,
                latencyMs=run.latencyMs,
                tokens=run.tokens,
                costUsd=run.costUsd,
                output=run.output,
                policyFindings=run.policyFindings,
            )
        )
        traces.append(trace)

    if not variants:
        detail = failures[0]["error"] if failures else "No lab variants could be executed"
        raise HTTPException(status_code=422, detail=detail)

    ordered = sorted(
        variants,
        key=lambda item: (
            {"allow": 3, "review": 2, "block": 1}[item.decision],
            item.score,
            -item.latencyMs,
            -item.costUsd,
        ),
        reverse=True,
    )
    winner = ordered[0]
    decision = "block" if any(item.decision == "block" for item in variants) else "review" if any(item.decision == "review" for item in variants) else "allow"
    created_at = datetime.now().isoformat()
    experiment = LabExperiment(
        id=f"lab_{token_hex(6)}",
        name=request.name.strip() or "Untitled experiment",
        input=request.input,
        providerMode=request.providerMode,
        environment=request.environment,
        createdAt=created_at,
        decision=decision,
        winnerRunId=winner.runId,
        variants=variants,
        summary={
            "variantCount": len(variants),
            "blockedCount": sum(1 for item in variants if item.decision == "block"),
            "reviewCount": sum(1 for item in variants if item.decision == "review"),
            "allowCount": sum(1 for item in variants if item.decision == "allow"),
            "bestScore": winner.score,
            "winnerAgent": winner.agentName,
            "totalCostUsd": round(sum(item.costUsd for item in variants), 5),
            "failures": failures,
        },
    )
    save_scoped_record("lab_experiments", experiment.id, experiment.model_dump())
    save_audit_event(
        "lab.experiment",
        current_workspace_id(),
        experiment.id,
        decision,
        f"Ran {len(variants)} lab variant(s); winner: {winner.agentName}.",
    )
    return LabRunResponse(experiment=experiment, traces=traces)


@app.get("/api/agent-runtime/jobs", response_model=list[AgentJob])
def agent_jobs() -> list[AgentJob]:
    return list_jobs()


@app.get("/api/agent-runtime/jobs/summary")
def agent_jobs_summary() -> dict[str, Any]:
    return queue_summary()


@app.get("/api/agent-runtime/jobs/{job_id}", response_model=AgentJob)
def agent_job_detail(job_id: str) -> AgentJob:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return job


@app.post("/api/agent-runtime/jobs", response_model=AgentJobSubmitResponse)
def submit_agent_job(request: AgentJobSubmitRequest) -> AgentJobSubmitResponse:
    return AgentJobSubmitResponse(job=submit_job(request))


@app.post("/api/agent-runtime/jobs/process-next", response_model=AgentJobProcessResponse)
def process_next_agent_job() -> AgentJobProcessResponse:
    result = process_next_job()
    if result is None:
        raise HTTPException(status_code=404, detail="No queued agent jobs")
    return result


@app.post("/api/agent-runtime/jobs/{job_id}/process", response_model=AgentJobProcessResponse)
def process_agent_job(job_id: str) -> AgentJobProcessResponse:
    result = process_job(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return result


@app.post("/api/agent-runtime/jobs/{job_id}/retry", response_model=AgentJob)
def retry_agent_job(job_id: str) -> AgentJob:
    job = retry_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return job


@app.post("/api/agent-runtime/jobs/{job_id}/cancel", response_model=AgentJob)
def cancel_agent_job(job_id: str) -> AgentJob:
    job = cancel_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return job


@app.get("/api/workspace", response_model=WorkspaceProfile)
def workspace_profile() -> WorkspaceProfile:
    return WorkspaceProfile.model_validate(workspace_profile_payload())


@app.get("/api/workspace/members", response_model=list[WorkspaceMember])
def workspace_members() -> list[WorkspaceMember]:
    return [WorkspaceMember.model_validate(member) for member in workspace_members_payload()]


@app.post("/api/workspace/members", response_model=WorkspaceMember)
def create_workspace_member(request: WorkspaceMemberCreateRequest) -> WorkspaceMember:
    workspace_id = current_workspace_id()
    normalized_email = request.email.strip().lower()
    if any(member.get("email", "").lower() == normalized_email for member in workspace_members_payload()):
        raise HTTPException(status_code=409, detail="Workspace member already exists")
    now = datetime.now().isoformat()
    member = WorkspaceMember(
        id=f"mem_{token_hex(4)}",
        workspaceId=workspace_id,
        name=request.name.strip(),
        email=normalized_email,
        role=request.role,
        access=workspace_access_for_role(request.role),
        createdAt=now,
        updatedAt=now,
    )
    save_record("workspace_members", member.id, member.model_dump())
    workspace_profile_payload()
    save_audit_event(
        "workspace.member.create",
        "workspace_admin",
        member.id,
        "allow",
        f"Added {member.email} as {member.role}.",
    )
    return member


@app.patch("/api/workspace/members/{member_id}", response_model=WorkspaceMember)
def patch_workspace_member(member_id: str, request: WorkspaceMemberPatchRequest) -> WorkspaceMember:
    payload = workspace_member_or_404(member_id)
    if request.name is not None:
        payload["name"] = request.name.strip()
    if request.email is not None:
        payload["email"] = request.email.strip().lower()
    if request.role is not None:
        payload["role"] = request.role
        payload["access"] = workspace_access_for_role(request.role)
    payload["updatedAt"] = datetime.now().isoformat()
    saved = save_record("workspace_members", member_id, payload)
    workspace_profile_payload()
    save_audit_event(
        "workspace.member.update",
        "workspace_admin",
        member_id,
        "allow",
        f"Updated workspace member {saved['email']}.",
    )
    return WorkspaceMember.model_validate(saved)


@app.delete("/api/workspace/members/{member_id}")
def delete_workspace_member(member_id: str) -> dict[str, str]:
    payload = workspace_member_or_404(member_id)
    delete_record("workspace_members", member_id)
    workspace_profile_payload()
    save_audit_event(
        "workspace.member.delete",
        "workspace_admin",
        member_id,
        "allow",
        f"Removed workspace member {payload['email']}.",
    )
    return {"deleted": member_id}


@app.get("/api/settings", response_model=SettingsPayload)
def settings() -> SettingsPayload:
    return SettingsPayload.model_validate(public_settings_payload(settings_payload_or_404()))


@app.post("/api/settings/api-keys", response_model=ApiKeyCreateResponse)
def create_api_key(request: ApiKeyCreateRequest) -> ApiKeyCreateResponse:
    with SETTINGS_WRITE_LOCK:
        payload = settings_payload_or_404()
        key_id = f"key_{token_hex(4)}"
        token = f"nop_sk_{token_hex(18)}"
        payload.setdefault("apiKeys", []).insert(
            0,
            {
                "id": key_id,
                "name": request.name,
                "role": request.role,
                "environment": request.environment,
                "scopes": request.scopes,
                "created": datetime.now().strftime("%Y-%m-%d"),
                "prefix": token[:10],
                "tokenHash": hash_token(token),
                "lastUsedAt": None,
                "useCount": 0,
                "lastScope": None,
            },
        )
        saved_payload = save_record("settings", settings_record_id(), payload)
    settings_payload = SettingsPayload.model_validate(public_settings_payload(saved_payload))
    save_audit_event("api_key.create", request.role, key_id, "allow", f"Created API key record {request.name}.")
    return ApiKeyCreateResponse(settings=settings_payload, token=token)


@app.post("/api/settings/webhooks", response_model=SettingsPayload)
def create_webhook(request: WebhookCreateRequest) -> SettingsPayload:
    with SETTINGS_WRITE_LOCK:
        payload = settings_payload_or_404()
        secret = f"whsec_{token_hex(16)}"
        payload.setdefault("webhooks", []).append(
            {
                "id": f"wh_{token_hex(4)}",
                "name": request.name,
                "url": request.url,
                "status": "active",
                "secret": secret,
                "secretPreview": f"{secret[:10]}...{secret[-4:]}",
                "createdAt": datetime.now().isoformat(),
            }
        )
        saved = save_record("settings", settings_record_id(), payload)
    save_audit_event("webhook.create", "settings", request.name, "allow", f"Created webhook connector {request.name}.")
    return SettingsPayload.model_validate(public_settings_payload(saved))


@app.patch("/api/settings/retention", response_model=SettingsPayload)
def update_retention(request: RetentionUpdateRequest) -> SettingsPayload:
    with SETTINGS_WRITE_LOCK:
        payload = settings_payload_or_404()
        payload["retentionDays"] = request.retentionDays
        saved = save_record("settings", settings_record_id(), payload)
    return SettingsPayload.model_validate(public_settings_payload(saved))


@app.get("/api/audit", response_model=list[AuditEvent])
def audit_events() -> list[AuditEvent]:
    return [AuditEvent.model_validate(item) for item in scoped_records("audit")]
