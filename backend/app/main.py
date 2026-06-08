from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from copy import deepcopy
from hashlib import sha256
import hmac
import json
import os
import re
from secrets import compare_digest, token_hex
from threading import Lock
from time import perf_counter, sleep
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .database import (
    count_records_for_workspace,
    delete_record,
    get_record,
    init_db,
    list_records,
    list_records_for_workspace,
    save_record,
    storage_backend,
    update_record,
)
from .agent_runtime import AGENT_DEFINITIONS, detect_policy_findings, estimate_tokens, list_providers, run_agent
from .auth import (
    auth_required,
    current_claims,
    public_auth_paths,
    requested_workspace_id,
    reset_current_claims,
    reset_requested_workspace_id,
    set_current_claims,
    set_requested_workspace_id,
    verify_request_claims,
    workspace_id_from_claims,
)
from . import seed
from .job_queue import cancel_job, get_job, list_jobs, process_job, process_next_job, queue_summary, retry_job, submit_job
from .metrics import build_stats
from .otel import normalize_otel_payload, replay_trace
from .provider_catalog import RuntimeProvider, create_provider_connection, list_provider_presets, provider_connections, runtime_providers, test_provider_connection
from .schemas import (
    AccessCheckRequest,
    AccessCheckResult,
    AccessCurrentUser,
    AccessPermission,
    AccessPolicyMatrix,
    AccessRolePolicy,
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
    EvidenceExportArtifact,
    EvidenceExportPack,
    EvidenceReport,
    FeatureTruth,
    Incident,
    IncidentPatch,
    LabExperiment,
    LabRunRequest,
    LabRunResponse,
    LabVariantResult,
    OnboardingStatus,
    OnboardingStep,
    OtelIngestRequest,
    OtelIngestResult,
    Policy,
    PolicyPatch,
    PolicyTestRequest,
    PolicyTestResult,
    PolicyViolation,
    ProductionReadinessCheck,
    ProductionReadinessReport,
    CostBudgetUpdateRequest,
    ConnectGuide,
    ConnectSnippet,
    ConnectVerifyRequest,
    ConnectVerifyResponse,
    ConnectivityAction,
    ConnectivityCheck,
    ConnectivityMap,
    ConnectorDelivery,
    ConnectorDeliveryProcessRequest,
    ConnectorDeliveryProcessResult,
    DetectionActionRequest,
    DetectionCase,
    DetectionCaseCreateRequest,
    GatewayChatCompletionRequest,
    GatewayBudget,
    GatewayCacheEntry,
    GatewayCostSuggestion,
    GatewayMetrics,
    GatewayPolicyDecision,
    GatewayProviderMetric,
    GatewayRequestLog,
    GatewayRouteAttempt,
    GatewayRouteEvent,
    GatewayRouteProvider,
    GatewayRoutingPolicy,
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
    ReplayDatasetGateRequest,
    ReplayDatasetGateResult,
    ReplayGateRequest,
    ReplayGateResult,
    ReplayResult,
    SettingsPayload,
    Stats,
    SystemStatus,
    SyntheticCanaryCheck,
    SyntheticCanaryRequest,
    SyntheticCanaryRun,
    Trace,
    TraceBatchIngestRequest,
    TraceBatchIngestResponse,
    TraceIngestRequest,
    TraceIngestResponse,
    TraceSpan,
    RetentionUpdateRequest,
    WebhookCreateRequest,
    WorkspaceMember,
    WorkspaceMemberCreateRequest,
    WorkspaceMemberPatchRequest,
    WorkspaceInvite,
    WorkspaceInviteAcceptResult,
    WorkspaceInviteCreateRequest,
    WorkspaceProfile,
    WorkspaceRole,
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
    workspace_token = None
    try:
        claims = verify_request_claims(
            request.headers.get("authorization"),
            request.headers.get("x-neuralops-qa-token"),
        )
        request.state.user_claims = claims
        token = set_current_claims(claims)
        workspace_token = set_requested_workspace_id(request.headers.get("x-neuralops-workspace-id"))
        authorize_workspace_request(request.url.path)
        return await call_next(request)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    finally:
        if workspace_token is not None:
            reset_requested_workspace_id(workspace_token)
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
    if not auth_required():
        return list_records(domain)
    workspace_id = current_workspace_id()
    global_domains = {"policies"}
    return list_records_for_workspace(domain, workspace_id, global_domains)


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


def home_workspace_id() -> str:
    claim_workspace_id = workspace_id_from_claims(current_claims())
    if claim_workspace_id:
        return claim_workspace_id
    return os.getenv("NEURALOPS_WORKSPACE_ID", "local-workspace")


def current_workspace_id() -> str:
    if auth_required():
        selected_workspace = requested_workspace_id()
        if selected_workspace:
            return selected_workspace
    return home_workspace_id()


def workspace_auth_required() -> bool:
    return os.getenv("NEURALOPS_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes"}


def workspace_access_for_role(role: str) -> str:
    return "Read Only" if role == "Viewer" else "All Workspace"


def workspace_member_for_email(workspace_id: str, email: str) -> dict[str, Any] | None:
    normalized_email = email.lower()
    for member in list_records("workspace_members"):
        if member.get("workspaceId") == workspace_id and member.get("email", "").lower() == normalized_email:
            return member
    return None


def workspace_has_members(workspace_id: str) -> bool:
    return any(member.get("workspaceId") == workspace_id for member in list_records("workspace_members"))


def authorize_workspace_request(path: str) -> None:
    if not auth_required():
        return
    if path.startswith("/api/workspace/invites/") and path.endswith("/accept"):
        return
    selected_workspace = current_workspace_id()
    if selected_workspace == home_workspace_id():
        return
    if workspace_member_for_email(selected_workspace, current_user_email()) is not None:
        return
    raise HTTPException(
        status_code=403,
        detail={
            "code": "workspace_access_denied",
            "workspaceId": selected_workspace,
            "message": "You must be an accepted member before accessing this workspace.",
        },
    )


ROLE_PERMISSIONS: dict[WorkspaceRole, tuple[AccessPermission, ...]] = {
    "Owner": (
        "workspace:read",
        "workspace:write",
        "settings:read",
        "settings:write",
        "provider:write",
        "policy:write",
        "gateway:operate",
        "release:gate",
        "incident:write",
        "automation:write",
    ),
    "Admin": (
        "workspace:read",
        "workspace:write",
        "settings:read",
        "settings:write",
        "provider:write",
        "policy:write",
        "gateway:operate",
        "release:gate",
        "incident:write",
        "automation:write",
    ),
    "Developer": (
        "workspace:read",
        "settings:read",
        "gateway:operate",
        "release:gate",
    ),
    "Security": (
        "workspace:read",
        "settings:read",
        "policy:write",
        "release:gate",
        "incident:write",
        "automation:write",
    ),
    "Viewer": (
        "workspace:read",
        "settings:read",
    ),
}

ROLE_DESCRIPTIONS: dict[WorkspaceRole, str] = {
    "Owner": "Full workspace administration, credentials, policy, gateway, and audit authority.",
    "Admin": "Operational administrator for settings, providers, gateway policy, releases, and incidents.",
    "Developer": "Can run releases and gateway drills, but cannot mutate credentials or workspace membership.",
    "Security": "Can manage policy, incidents, and automation evidence without changing provider secrets.",
    "Viewer": "Read-only visibility for reports, traces, settings metadata, and evidence.",
}


def role_permissions(role: str) -> list[AccessPermission]:
    typed_role = role if role in ROLE_PERMISSIONS else "Viewer"
    return list(ROLE_PERMISSIONS[typed_role])  # type: ignore[index]


def current_workspace_member_payload() -> dict[str, Any]:
    ensure_workspace_bootstrap()
    email = current_user_email()
    member = workspace_member_for_email(current_workspace_id(), email)
    if member is not None:
        return member
    raise HTTPException(
        status_code=403,
        detail={
            "code": "workspace_access_denied",
            "workspaceId": current_workspace_id(),
            "message": "No workspace membership exists for this authenticated user.",
        },
    )


def current_access_user() -> AccessCurrentUser:
    if not auth_required():
        return AccessCurrentUser(
            email=current_user_email(),
            role="Owner",
            permissions=role_permissions("Owner"),
            workspaceId=current_workspace_id(),
        )
    member = current_workspace_member_payload()
    role = member.get("role", "Viewer")
    return AccessCurrentUser(
        email=member.get("email", current_user_email()),
        role=role if role in ROLE_PERMISSIONS else "Viewer",
        permissions=role_permissions(role),
        workspaceId=current_workspace_id(),
    )


def access_check_result(permission: AccessPermission, subject: str) -> AccessCheckResult:
    user = current_access_user()
    allowed = permission in user.permissions
    decision = "allow" if allowed else "block"
    reason = (
        f"{user.role} can perform {permission}."
        if allowed
        else f"{user.role} does not include {permission}."
    )
    save_audit_event(
        "access.check",
        user.email,
        permission,
        decision,
        f"{decision.upper()}: {permission} on {subject or 'manual-check'}. {reason}",
    )
    return AccessCheckResult(
        allowed=allowed,
        decision=decision,
        role=user.role,
        permission=permission,
        subject=subject or permission,
        reason=reason,
    )


def require_permission(permission: AccessPermission, subject: str) -> AccessCheckResult:
    if not auth_required():
        return AccessCheckResult(
            allowed=True,
            decision="allow",
            role="Owner",
            permission=permission,
            subject=subject,
            reason="Local development mode grants owner-equivalent permissions.",
        )
    result = access_check_result(permission, subject)
    if result.allowed:
        return result
    raise HTTPException(
        status_code=403,
        detail={
            "code": "permission_denied",
            "requiredPermission": permission,
            "role": result.role,
            "message": result.reason,
        },
    )


def claim_text(*keys: str) -> str | None:
    claims = current_claims() or {}
    for key in keys:
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def current_user_email() -> str:
    email = claim_text("email")
    if email:
        return email.lower()
    subject = claim_text("sub")
    if subject:
        return f"{subject.lower()}@neuralops.local"
    return "local-operator@neuralops.local"


def current_user_display_name() -> str:
    email = current_user_email()
    name = email.split("@", 1)[0].replace(".", " ").replace("_", " ").replace("-", " ").strip()
    return name.title() if name else "Workspace Owner"


def default_workspace_name(workspace_id: str) -> str:
    configured = os.getenv("NEURALOPS_WORKSPACE_NAME")
    if configured:
        return configured
    if not auth_required():
        return "Local Workspace"
    email = current_user_email()
    if "@" in email and not email.endswith("@neuralops.local"):
        domain = email.split("@", 1)[1].split(".", 1)[0]
        if domain:
            return f"{domain.title()} Workspace"
    return f"{workspace_id.replace('-', ' ').title()} Workspace"


def workspace_profile_payload() -> dict[str, Any]:
    workspace_id = current_workspace_id()
    payload = get_record("workspaces", workspace_id)
    now = datetime.now().isoformat()
    if payload is None:
        payload = {
            "id": workspace_id,
            "name": default_workspace_name(workspace_id),
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


def ensure_workspace_bootstrap() -> dict[str, Any]:
    workspace = workspace_profile_payload()
    if not auth_required():
        return workspace
    if workspace_members_payload():
        return workspace_profile_payload()
    if current_workspace_id() != home_workspace_id():
        return workspace

    now = datetime.now().isoformat()
    email = current_user_email()
    member = WorkspaceMember(
        id=f"mem_owner_{sha256(f'{current_workspace_id()}:{email}'.encode('utf-8')).hexdigest()[:10]}",
        workspaceId=current_workspace_id(),
        name=current_user_display_name(),
        email=email,
        role="Owner",
        access="All Workspace",
        createdAt=now,
        updatedAt=now,
    )
    save_record("workspace_members", member.id, member.model_dump())
    save_audit_event(
        "workspace.bootstrap",
        email,
        current_workspace_id(),
        "allow",
        "Created first workspace owner from authenticated session.",
    )
    return workspace_profile_payload()


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


def workspace_invites_payload() -> list[dict[str, Any]]:
    return scoped_records("workspace_invites")


def workspace_invite_by_token(invite_token: str) -> dict[str, Any] | None:
    for invite in list_records("workspace_invites"):
        if invite.get("token") == invite_token:
            return invite
    return None


def refresh_invite_status(invite: dict[str, Any]) -> dict[str, Any]:
    if invite.get("status") != "pending":
        return invite
    try:
        expires_at = datetime.fromisoformat(str(invite.get("expiresAt")))
    except ValueError:
        invite["status"] = "expired"
        save_record("workspace_invites", invite["id"], invite)
        return invite
    if expires_at < datetime.now():
        invite["status"] = "expired"
        save_record("workspace_invites", invite["id"], invite)
    return invite


def workspace_member_from_invite(invite: WorkspaceInvite) -> WorkspaceMember:
    now = datetime.now().isoformat()
    existing = workspace_member_for_email(invite.workspaceId, invite.email)
    if existing is not None:
        existing["role"] = invite.role
        existing["access"] = workspace_access_for_role(invite.role)
        existing["updatedAt"] = now
        return WorkspaceMember.model_validate(save_record("workspace_members", existing["id"], existing))
    member = WorkspaceMember(
        id=f"mem_{token_hex(4)}",
        workspaceId=invite.workspaceId,
        name=invite.email.split("@", 1)[0].replace(".", " ").replace("_", " ").title(),
        email=invite.email,
        role=invite.role,
        access=workspace_access_for_role(invite.role),
        createdAt=now,
        updatedAt=now,
    )
    save_record("workspace_members", member.id, member.model_dump())
    return member


def onboarding_step(step_id: str, label: str, complete: bool, complete_detail: str, action_detail: str) -> OnboardingStep:
    return OnboardingStep(
        id=step_id,
        label=label,
        state="complete" if complete else "action_required",
        detail=complete_detail if complete else action_detail,
    )


def build_onboarding_status() -> OnboardingStatus:
    workspace = WorkspaceProfile.model_validate(ensure_workspace_bootstrap())
    settings_payload = settings_payload_or_404()
    has_ingest_key = any(
        "trace:ingest" in api_key.get("scopes", ["trace:ingest"]) or "admin" in api_key.get("scopes", [])
        for api_key in settings_payload.get("apiKeys", [])
    )
    trace_count = count_domain("traces")
    gate_count = count_domain("release_gates") + count_domain("evidence_reports")
    steps = [
        onboarding_step(
            "auth",
            "Sign in",
            auth_required() or not workspace.authRequired,
            "Dashboard is running inside an authenticated workspace." if workspace.authRequired else "Local development mode is active.",
            "Enable Supabase Auth before exposing the product publicly.",
        ),
        onboarding_step(
            "workspace",
            "Workspace provisioned",
            True,
            f"{workspace.name} is stored in {workspace.storage}.",
            "Create a workspace before ingesting traces.",
        ),
        onboarding_step(
            "ingest_key",
            "Ingest key created",
            has_ingest_key,
            "A server-side trace ingest key exists for this workspace.",
            "Create an ingest key from Connect or Settings.",
        ),
        onboarding_step(
            "first_trace",
            "First trace received",
            trace_count > 0,
            f"{trace_count} trace records are stored for this workspace.",
            "Verify the connection or post a real trace to /api/traces/ingest.",
        ),
        onboarding_step(
            "release_evidence",
            "Release evidence ready",
            gate_count > 0,
            "Release gate or evidence records exist for this workspace.",
            "Run a release gate evidence check.",
        ),
    ]
    completed = sum(1 for step in steps if step.state == "complete")
    next_action = next((step.detail for step in steps if step.state != "complete"), "Review production readiness evidence.")
    return OnboardingStatus(
        workspace=workspace,
        progress=round((completed / len(steps)) * 100),
        nextAction=next_action,
        steps=steps,
        generatedAt=datetime.now().isoformat(),
    )


def readiness_check(check_id: str, label: str, state: str, detail: str) -> ProductionReadinessCheck:
    return ProductionReadinessCheck(id=check_id, label=label, state=state, detail=detail)


def build_production_readiness() -> ProductionReadinessReport:
    ensure_workspace_bootstrap()
    status = build_system_status()
    member_count = len(workspace_members_payload())
    provider_count = len(provider_connections(current_workspace_id()))
    gateway_policy = gateway_routing_policy()
    access_audit_count = len([item for item in scoped_records("audit") if str(item.get("type", "")).startswith("access.")])
    checks = [
        readiness_check(
            "auth_required",
            "Authentication required",
            "pass" if auth_required() else "block",
            "Supabase/Auth JWT middleware is required." if auth_required() else "Enable NEURALOPS_AUTH_REQUIRED before public deployment.",
        ),
        readiness_check(
            "database",
            "Production database",
            "pass" if storage_backend() == "postgres" else "review",
            "Postgres/Supabase storage is active." if storage_backend() == "postgres" else "SQLite is acceptable for local proof, but deployment should use Supabase Postgres.",
        ),
        readiness_check(
            "workspace_isolation",
            "Workspace isolation",
            "pass" if auth_required() and member_count > 0 else "block",
            f"{member_count} member record(s) are scoped to workspace {current_workspace_id()}.",
        ),
        readiness_check(
            "rbac_enforced",
            "RBAC enforced",
            "pass" if "settings:write" not in ROLE_PERMISSIONS["Viewer"] and "provider:write" not in ROLE_PERMISSIONS["Security"] else "block",
            "Backend permission gates are active for settings, provider, gateway, release, incident, and automation writes.",
        ),
        readiness_check(
            "provider_gateway",
            "Live provider gateway",
            "pass" if provider_count > 0 else "review",
            f"{provider_count} provider connection(s) are configured for this workspace.",
        ),
        readiness_check(
            "gateway_policy",
            "Gateway routing policy",
            "pass" if gateway_policy.rateLimitPerMinute > 0 else "block",
            f"Strategy {gateway_policy.strategy}, rate limit {gateway_policy.rateLimitPerMinute}/minute.",
        ),
        readiness_check(
            "access_audit",
            "Access audit evidence",
            "pass" if access_audit_count > 0 else "review",
            f"{access_audit_count} access decision(s) recorded.",
        ),
    ]
    if status.readinessScore < 50:
        checks.append(readiness_check("system_truth", "System truth contract", "review", f"System readiness score is {status.readinessScore}."))
    blockers = [check.detail for check in checks if check.state == "block"]
    review_count = sum(1 for check in checks if check.state == "review")
    decision = "block" if blockers else "review" if review_count else "allow"
    score = max(0, min(100, round((sum(1 for check in checks if check.state == "pass") / len(checks)) * 100)))
    return ProductionReadinessReport(
        workspaceId=current_workspace_id(),
        decision=decision,
        score=score,
        checks=checks,
        blockers=blockers,
        generatedAt=datetime.now().isoformat(),
    )


def build_system_status() -> SystemStatus:
    ensure_workspace_bootstrap()
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
        "replay_gates",
        "dataset_replay_gates",
        "gateway_route_events",
        "connector_deliveries",
        "detections",
        "release_gate_definitions",
        "release_gates",
        "audit",
    ]
    if auth_required():
        record_counts = count_records_for_workspace(domains, current_workspace_id(), {"policies"})
    else:
        record_counts = {domain: count_domain(domain) for domain in domains}
    settings_payload = settings_payload_or_404()
    providers = list_providers()
    live_configured = any(provider.configured for provider in providers if provider.id != "local")
    auth_required_enabled = os.getenv("NEURALOPS_AUTH_REQUIRED", "false").lower() in {"1", "true", "yes"}
    webhook_count = len(settings_payload.get("webhooks", []))
    api_key_count = len(settings_payload.get("apiKeys", []))
    gateway_key_count = sum(1 for api_key in settings_payload.get("apiKeys", []) if "gateway:invoke" in api_key.get("scopes", []) or "admin" in api_key.get("scopes", []))
    gateway_trace_count = sum(1 for trace in scoped_records("traces") if str(trace.get("id", "")).startswith("tr_gateway_"))
    gateway_route_count = record_counts["gateway_route_events"]
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
            state="persisted" if record_counts["release_gate_definitions"] or record_counts["release_gates"] or record_counts["dataset_replay_gates"] else "not_configured",
            evidence=f"{record_counts['release_gate_definitions']} saved gate(s), {record_counts['release_gates']} run(s), {record_counts['dataset_replay_gates']} dataset replay(s)",
            action="Create a saved release gate or dataset replay gate and run it from the Evidence page or CLI before deployment.",
        ),
        FeatureTruth(
            id="connect_sdk",
            label="SDK + Collector Connection",
            state="persisted" if api_key_count and record_counts["traces"] else "not_configured",
            evidence=f"{api_key_count} key(s), {record_counts['traces']} trace(s)",
            action="Use the Connect page to create a key and verify JavaScript, Python, REST, or OTEL ingestion.",
        ),
        FeatureTruth(
            id="policy_gateway",
            label="OpenAI-Compatible Policy Gateway",
            state="persisted" if gateway_trace_count or gateway_route_count else "live_provider" if live_configured and gateway_key_count else "not_configured",
            evidence=f"{gateway_key_count} gateway key(s), {gateway_trace_count} gateway trace(s), {gateway_route_count} route event(s)",
            action="Route LLM calls through /api/gateway/openai/v1/chat/completions to enforce policy and store evidence.",
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
            id="detection_response",
            label="Agent Detection + Response",
            state="persisted" if record_counts["detections"] else "not_configured",
            evidence=f"{record_counts['detections']} detection case(s), {record_counts['traces']} trace(s)",
            action="Analyze a risky trace to create a persisted case with root cause, blast radius, containment, and audit proof.",
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
            state="persisted" if auth_required_enabled else "not_configured",
            evidence="Auth required by backend" if auth_required_enabled else "Auth is not enforced in local development",
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
        authRequired=auth_required_enabled,
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


def parse_cost(value: str) -> float:
    try:
        return float(value.replace("$", "").replace(",", ""))
    except ValueError:
        return 0.0


def list_release_gate_definitions() -> list[ReleaseGateDefinition]:
    gates = [ReleaseGateDefinition.model_validate(item) for item in scoped_records("release_gate_definitions")]
    return sorted(gates, key=lambda item: item.updatedAt, reverse=True)


def release_gate_request_from_definition(gate: ReleaseGateDefinition, target_override: str | None = None) -> ReleaseGateRequest:
    return ReleaseGateRequest(
        target=target_override or gate.target,
        traceEnvironment=gate.traceEnvironment,
        promptId=gate.promptId,
        maxLatencyMs=gate.maxLatencyMs,
        maxErrorRate=gate.maxErrorRate,
        minEvalPassRate=gate.minEvalPassRate,
        requireLiveProvider=gate.requireLiveProvider,
        requireAuth=gate.requireAuth,
        requireSyntheticCanary=gate.requireSyntheticCanary,
        syntheticCanaryMaxAgeMinutes=gate.syntheticCanaryMaxAgeMinutes,
        includeSyntheticTraces=gate.includeSyntheticTraces,
    )


def synthetic_canary_release_gate_check(request: ReleaseGateRequest) -> ReleaseGateCheck:
    canary = latest_synthetic_canary()
    if canary is None:
        return ReleaseGateCheck(
            id="synthetic_canary",
            label="Synthetic Production Canary",
            status="fail" if request.requireSyntheticCanary else "warn",
            reason="Production release should include a recent synthetic end-to-end canary.",
            evidence="No synthetic canary has been recorded.",
        )

    try:
        age_seconds = max(0.0, (datetime.now() - datetime.fromisoformat(canary.generatedAt)).total_seconds())
    except ValueError:
        age_seconds = request.syntheticCanaryMaxAgeMinutes * 60 + 1
    age_minutes = round(age_seconds / 60, 1)
    stale = age_seconds > request.syntheticCanaryMaxAgeMinutes * 60
    failed_checks = [check.label for check in canary.checks if check.status == "fail"]
    warned_checks = [check.label for check in canary.checks if check.status == "warn"]

    if canary.decision == "block" or stale:
        status = "fail" if request.requireSyntheticCanary else "warn"
    elif canary.decision == "review":
        status = "warn"
    else:
        status = "pass"

    evidence_parts = [
        f"{canary.id}: {canary.decision} ({canary.score}/100)",
        f"age {age_minutes}m / limit {request.syntheticCanaryMaxAgeMinutes}m",
    ]
    if failed_checks:
        evidence_parts.append(f"failed: {', '.join(failed_checks)}")
    if warned_checks:
        evidence_parts.append(f"warned: {', '.join(warned_checks)}")
    return ReleaseGateCheck(
        id="synthetic_canary",
        label="Synthetic Production Canary",
        status=status,
        reason="Release gate uses the latest backend/database/gateway synthetic proof before deploy.",
        evidence=" | ".join(evidence_parts),
    )


def trace_environment_for_release_target(request: ReleaseGateRequest) -> str:
    if request.traceEnvironment is not None:
        return request.traceEnvironment
    target = request.target.strip().lower()
    if target in {"production", "prod", "live"} or "prod" in target:
        return "prod"
    if target in {"staging", "stage", "preview"} or "stag" in target:
        return "staging"
    if target in {"dev", "development", "local", "ci", "test"} or target.startswith("ci-"):
        return "dev"
    return "all"


def is_synthetic_trace(trace: Trace) -> bool:
    return trace.model == "neuralops-synthetic-canary" or "synthetic-canary" in trace.riskFlags


def release_gate_metric_traces(request: ReleaseGateRequest, traces: list[Trace]) -> tuple[list[Trace], str, int]:
    trace_environment = trace_environment_for_release_target(request)
    scoped = traces if trace_environment == "all" else [trace for trace in traces if trace.environment == trace_environment]
    scoped_count = len(scoped)
    if not request.includeSyntheticTraces:
        scoped = [trace for trace in scoped if not is_synthetic_trace(trace)]
    return scoped, trace_environment, scoped_count


def run_release_gate(request: ReleaseGateRequest) -> ReleaseGateResult:
    all_traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    traces, trace_environment, scoped_trace_count = release_gate_metric_traces(request, all_traces)
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
            label="Target Trace Evidence",
            status="pass" if len(traces) >= 3 else "warn" if traces else "fail",
            reason="Release needs replayable non-synthetic trace evidence for the selected target.",
            evidence=(
                f"{len(traces)} metric trace(s) for {trace_environment}; "
                f"{scoped_trace_count} total target trace(s); {len(all_traces)} workspace trace(s)"
            ),
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
        synthetic_canary_release_gate_check(request),
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


def latest_replay_gate() -> ReplayGateResult | None:
    gates = [ReplayGateResult.model_validate(item) for item in scoped_records("replay_gates")]
    if not gates:
        return None
    return sorted(gates, key=lambda item: item.generatedAt, reverse=True)[0]


def latest_dataset_replay_gate() -> ReplayDatasetGateResult | None:
    gates = [ReplayDatasetGateResult.model_validate(item) for item in scoped_records("dataset_replay_gates")]
    if not gates:
        return None
    return sorted(gates, key=lambda item: item.generatedAt, reverse=True)[0]


def run_trace_replay_gate(trace: Trace, request: ReplayGateRequest) -> ReplayGateResult:
    replay = replay_trace(trace.model_dump())
    latency_ms = round(parse_seconds(trace.latency) * 1000)
    cost_usd = parse_cost(trace.cost)
    combined_text = f"{trace.prompt}\n{trace.output}".lower()
    blocked_phrase_hits = [phrase for phrase in request.blockedPhrases if phrase.lower() in combined_text]
    live_provider_configured = bool(gateway_providers_for_environment(trace.environment))
    provider_required = request.providerMode == "live" or request.requireLiveProvider

    checks = [
        ReleaseGateCheck(
            id="policy_replay",
            label="Replay Policy Decision",
            status="fail" if replay.decision == "block" else "warn" if replay.decision == "review" else "pass",
            reason="Stored trace replay must not reproduce blocked or review-only policy paths.",
            evidence=f"Replay decision {replay.decision}; {replay.recommendation}",
        ),
        ReleaseGateCheck(
            id="latency_budget",
            label="Latency Regression Budget",
            status="pass" if latency_ms <= request.maxLatencyMs else "warn",
            reason=f"Replay candidate should stay under {request.maxLatencyMs}ms.",
            evidence=f"{latency_ms}ms recorded latency",
        ),
        ReleaseGateCheck(
            id="cost_budget",
            label="Cost Budget",
            status="pass" if cost_usd <= request.maxCostUsd else "warn",
            reason=f"Replay candidate should stay under ${request.maxCostUsd:.4f}.",
            evidence=f"${cost_usd:.4f} recorded trace cost",
        ),
        ReleaseGateCheck(
            id="eval_score",
            label="Evaluation Score Floor",
            status="pass" if trace.score >= request.minScore else "fail" if trace.score < 0.5 else "warn",
            reason=f"Trace score should be at least {request.minScore:.2f} before promotion.",
            evidence=f"{trace.score:.2f} recorded score",
        ),
        ReleaseGateCheck(
            id="blocked_phrases",
            label="Policy-as-Code Blocked Phrases",
            status="fail" if blocked_phrase_hits else "pass",
            reason="Local policy file phrases must not appear in replayed release evidence.",
            evidence=", ".join(blocked_phrase_hits) if blocked_phrase_hits else "No policy-file blocked phrases matched.",
        ),
        ReleaseGateCheck(
            id="provider_mode",
            label="Provider Mode Readiness",
            status="fail" if provider_required and not live_provider_configured else "pass",
            reason="Live replay must use a configured key-backed provider; local replay remains deterministic.",
            evidence=(
                "Live provider configured"
                if live_provider_configured
                else "Live provider not configured; local deterministic replay only"
            ),
        ),
    ]

    failed = sum(check.status == "fail" for check in checks)
    warned = sum(check.status == "warn" for check in checks)
    decision = "block" if failed else "review" if warned else "allow"
    recommendations = [f"{check.label}: {check.reason} {check.evidence}" for check in checks if check.status != "pass"]
    result = ReplayGateResult(
        id=f"rpg_{token_hex(6)}",
        traceId=trace.id,
        target=request.target,
        decision=decision,
        score=max(0, 100 - failed * 28 - warned * 10),
        providerMode=request.providerMode,
        replay=replay,
        checks=checks,
        originalOutput=trace.output,
        replayedOutput=(
            f"Local deterministic replay reused stored output for trace {trace.id}. "
            "Configure providerMode=live after a live provider is connected to compare fresh model output."
        ),
        recommendations=recommendations,
        generatedAt=datetime.now().isoformat(),
    )
    save_scoped_record("replay_gates", result.id, result.model_dump())
    save_audit_event(
        "trace.replay_gate",
        current_workspace_id(),
        result.id,
        result.decision,
        f"Replay gate for trace {trace.id}: {result.decision} ({result.score}/100).",
    )
    return result


def dataset_replay_request(request: ReplayDatasetGateRequest) -> ReplayGateRequest:
    return ReplayGateRequest(
        target=request.target,
        providerMode=request.providerMode,
        maxLatencyMs=request.maxLatencyMs,
        maxCostUsd=request.maxCostUsd,
        minScore=request.minScore,
        blockedPhrases=request.blockedPhrases,
        requireLiveProvider=request.requireLiveProvider,
    )


def select_dataset_replay_traces(request: ReplayDatasetGateRequest) -> list[Trace]:
    if request.traceIds:
        selected: list[Trace] = []
        for trace_id in request.traceIds:
            payload = get_scoped_record("traces", trace_id)
            if payload is None:
                raise HTTPException(status_code=404, detail=f"Trace not found: {trace_id}")
            selected.append(Trace.model_validate(payload))
        return selected[: request.limit]

    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    if request.traceEnvironment != "all":
        traces = [trace for trace in traces if trace.environment == request.traceEnvironment]
    return list(reversed(traces))[: request.limit]


def run_dataset_replay_gate(request: ReplayDatasetGateRequest) -> ReplayDatasetGateResult:
    traces = select_dataset_replay_traces(request)
    if not traces:
        dataset = ReplayDatasetGateResult(
            id=f"rdg_{token_hex(6)}",
            target=request.target,
            decision="review",
            score=0,
            providerMode=request.providerMode,
            traceCount=0,
            allowed=0,
            review=0,
            blocked=0,
            traceEnvironment=request.traceEnvironment,
            results=[],
            checks=[
                ReleaseGateCheck(
                    id="dataset_trace_coverage",
                    label="Replay Dataset Coverage",
                    status="warn",
                    reason="Release replay evidence needs at least one stored trace.",
                    evidence=f"0 trace(s) matched {request.traceEnvironment} scope with limit {request.limit}.",
                )
            ],
            recommendations=[
                "Ingest production traces or run a synthetic canary before using dataset replay as release evidence."
            ],
            generatedAt=datetime.now().isoformat(),
        )
        save_scoped_record("dataset_replay_gates", dataset.id, dataset.model_dump())
        save_audit_event(
            "trace.dataset_replay_gate",
            current_workspace_id(),
            dataset.id,
            dataset.decision,
            "Dataset replay gate needs trace evidence before promotion.",
        )
        return dataset

    replay_request = dataset_replay_request(request)
    results = [run_trace_replay_gate(trace, replay_request) for trace in traces]
    blocked = sum(1 for result in results if result.decision == "block")
    review = sum(1 for result in results if result.decision == "review")
    allowed = sum(1 for result in results if result.decision == "allow")
    trace_count = len(results)
    coverage_warn = not request.traceIds and trace_count < min(5, request.limit)
    decision = "block" if blocked else "review" if review or coverage_warn else "allow"
    checks = [
        ReleaseGateCheck(
            id="dataset_trace_coverage",
            label="Replay Dataset Coverage",
            status="warn" if coverage_warn else "pass",
            reason="Release evidence should cover the selected trace dataset.",
            evidence=f"{trace_count} trace(s) replayed from {request.traceEnvironment} scope with limit {request.limit}.",
        ),
        ReleaseGateCheck(
            id="dataset_blocked_traces",
            label="Blocked Trace Replays",
            status="fail" if blocked else "pass",
            reason="No trace in the replay dataset should reproduce a blocking policy path.",
            evidence=f"{blocked} blocked replay(s).",
        ),
        ReleaseGateCheck(
            id="dataset_review_traces",
            label="Review Trace Replays",
            status="warn" if review else "pass",
            reason="Review-only trace paths should be investigated before promotion.",
            evidence=f"{review} review replay(s).",
        ),
        ReleaseGateCheck(
            id="dataset_average_score",
            label="Dataset Replay Average Score",
            status="fail" if sum(result.score for result in results) / trace_count < 60 else "warn" if review else "pass",
            reason="Dataset replay score should remain healthy across the trace sample.",
            evidence=f"{sum(result.score for result in results) / trace_count:.1f}/100 average replay score.",
        ),
    ]
    recommendations = [
        f"Trace {result.traceId}: {result.decision} ({result.score}/100)"
        for result in results
        if result.decision != "allow"
    ]
    failed = sum(check.status == "fail" for check in checks)
    warned = sum(check.status == "warn" for check in checks)
    score = max(0, min(100, round(sum(result.score for result in results) / trace_count) - failed * 10 - warned * 5))
    dataset = ReplayDatasetGateResult(
        id=f"rdg_{token_hex(6)}",
        target=request.target,
        decision=decision,
        score=score,
        providerMode=request.providerMode,
        traceCount=trace_count,
        allowed=allowed,
        review=review,
        blocked=blocked,
        traceEnvironment=request.traceEnvironment,
        results=results,
        checks=checks,
        recommendations=recommendations,
        generatedAt=datetime.now().isoformat(),
    )
    save_scoped_record("dataset_replay_gates", dataset.id, dataset.model_dump())
    save_audit_event(
        "trace.dataset_replay_gate",
        current_workspace_id(),
        dataset.id,
        dataset.decision,
        f"Dataset replay gate for {dataset.traceCount} trace(s): {dataset.decision} ({dataset.score}/100).",
    )
    return dataset


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
            traceEnvironment="all",
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


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def automation_inline_limit() -> int:
    return max(0, env_int("NEURALOPS_AUTOMATION_INLINE_LIMIT", 3))


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
    matching_rules = [rule for rule in list_automation_rules() if rule.enabled and rule.trigger == trigger]
    for rule in matching_rules[:automation_inline_limit()]:
        events.append(run_automation_rule(rule, subject_type, subject_id, decision, summary))
    skipped_count = max(0, len(matching_rules) - len(events))
    if skipped_count:
        save_audit_event(
            "automation.inline_limit",
            "automation_engine",
            f"{trigger}:{subject_id}",
            "review",
            f"Skipped {skipped_count} matching automation rule(s) for {trigger}; increase NEURALOPS_AUTOMATION_INLINE_LIMIT or process rules with a worker.",
        )
    return events


def run_automation_rule(
    rule: AutomationRule,
    subject_type: str,
    subject_id: str,
    decision: str,
    summary: str,
) -> AutomationEvent:
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
                "trigger": rule.trigger,
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
        f"Rule {rule.name} handled {rule.trigger} for {subject_id}: {status}.",
    )
    return event


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
    replay_gate = latest_replay_gate()
    dataset_replay_gate = latest_dataset_replay_gate()
    saved_gates = list_release_gate_definitions()
    summary = {
        "decision": (
            "block"
            if (dataset_replay_gate and dataset_replay_gate.decision == "block") or (replay_gate and replay_gate.decision == "block")
            else gate.decision
            if gate
            else "review"
        ),
        "readinessScore": status.readinessScore,
        "configuredFeatures": sum(1 for feature in status.features if feature.state != "not_configured"),
        "blockedFeatures": sum(1 for feature in status.features if feature.state == "not_configured"),
        "savedReleaseGates": len(saved_gates),
        "latestReplayGateDecision": replay_gate.decision if replay_gate else "not_run",
        "latestDatasetReplayGateDecision": dataset_replay_gate.decision if dataset_replay_gate else "not_run",
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
        f"- Latest replay gate decision: {replay_gate.decision if replay_gate else 'not_run'}",
        f"- Latest dataset replay gate decision: {dataset_replay_gate.decision if dataset_replay_gate else 'not_run'}",
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
    if replay_gate:
        markdown_lines.extend(
            [
                "",
                "## Replay Gate Checks",
                f"- Trace: `{replay_gate.traceId}`",
                f"- Decision: `{replay_gate.decision}` ({replay_gate.score}/100)",
                *[f"- **{check.label}**: `{check.status}` - {check.evidence}" for check in replay_gate.checks],
            ]
        )
    if dataset_replay_gate:
        markdown_lines.extend(
            [
                "",
                "## Dataset Replay Gate Checks",
                f"- Dataset: `{dataset_replay_gate.traceCount}` trace(s)",
                f"- Decision: `{dataset_replay_gate.decision}` ({dataset_replay_gate.score}/100)",
                f"- Outcomes: {dataset_replay_gate.allowed} allow, {dataset_replay_gate.review} review, {dataset_replay_gate.blocked} block",
                *[f"- **{check.label}**: `{check.status}` - {check.evidence}" for check in dataset_replay_gate.checks],
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
        latestReplayGate=replay_gate,
        latestDatasetReplayGate=dataset_replay_gate,
        summary=summary,
        markdown="\n".join(markdown_lines),
    )
    save_scoped_record("evidence_reports", report.id, report.model_dump())
    return report


def recent_access_audit(limit: int = 20) -> list[AuditEvent]:
    events = [
        AuditEvent.model_validate(item)
        for item in scoped_records("audit")
        if str(item.get("type", "")).startswith(("access.", "workspace."))
    ]
    return sorted(events, key=lambda item: item.createdAt, reverse=True)[:limit]


def render_evidence_pack_markdown(pack_id: str, generated_at: str, evidence: EvidenceReport, readiness: ProductionReadinessReport, gateway: dict[str, Any], access_audit: list[AuditEvent], automation: dict[str, Any]) -> str:
    latest_gate = evidence.latestGate
    gateway_metrics_payload = gateway.get("metrics", {})
    lines = [
        "# NeuralOps Release Evidence Pack",
        "",
        f"- Pack ID: `{pack_id}`",
        f"- Generated: {generated_at}",
        f"- Workspace: `{evidence.status.workspaceId}`",
        f"- Decision: **{readiness.decision.upper()}**",
        f"- Readiness score: `{readiness.score}/100`",
        f"- Storage: `{evidence.status.storage}`",
        f"- Auth required: `{evidence.status.authRequired}`",
        "",
        "## Executive Summary",
        f"- Latest release gate: `{latest_gate.decision if latest_gate else 'not_run'}`",
        f"- Latest dataset replay gate: `{evidence.summary.get('latestDatasetReplayGateDecision', 'not_run')}`",
        f"- Gateway requests: `{gateway_metrics_payload.get('totalRequests', 0)}` total, `{gateway_metrics_payload.get('routedRequests', 0)}` routed",
        f"- Automation rules: `{automation.get('rules', 0)}`, delivery attempts: `{automation.get('deliveries', 0)}`",
        f"- Access audit events: `{len(access_audit)}`",
        "",
        "## Production Readiness",
        *[f"- **{check.label}**: `{check.state}` - {check.detail}" for check in readiness.checks],
        "",
        "## Feature Truth",
        *[f"- **{feature.label}**: `{feature.state}` - {feature.evidence}" for feature in evidence.status.features],
    ]
    if latest_gate:
        lines.extend(
            [
                "",
                "## Release Gate",
                f"- Gate: `{latest_gate.gateName or latest_gate.gateId or latest_gate.id}`",
                f"- Decision: `{latest_gate.decision}`",
                f"- Score: `{latest_gate.score}/100`",
                *[f"- **{check.label}**: `{check.status}` - {check.evidence}" for check in latest_gate.checks],
            ]
        )
    latest_requests = gateway.get("latestRequests", [])
    if latest_requests:
        lines.extend(["", "## Gateway Route Evidence"])
        for request in latest_requests[:5]:
            provider = request.get("selectedProvider") or {}
            lines.append(
                f"- `{request.get('status')}` {request.get('environment')} via `{provider.get('label', 'none')}` "
                f"strategy `{request.get('routingStrategy')}`, cache `{request.get('cacheStatus')}`, budget `{request.get('budgetDecision')}`"
            )
    if access_audit:
        lines.extend(["", "## Access Audit"])
        for event in access_audit[:8]:
            lines.append(f"- `{event.decision}` {event.actor} -> `{event.subject}`: {event.summary}")
    lines.extend(
        [
            "",
            "## Digest",
            "- The JSON pack includes a SHA-256 digest over the generated evidence payload.",
        ]
    )
    return "\n".join(lines)


def build_evidence_export_pack() -> EvidenceExportPack:
    evidence = build_evidence_report()
    readiness = build_production_readiness()
    generated_at = datetime.now().isoformat()
    pack_id = f"evidence_pack_{token_hex(6)}"
    gateway_snapshot = {
        "metrics": gateway_metrics().model_dump(),
        "latestRequests": [request.model_dump() for request in gateway_request_logs(limit=10)],
        "costSuggestions": [suggestion.model_dump() for suggestion in gateway_cost_suggestions()],
    }
    access_audit = recent_access_audit()
    automation_snapshot = {
        "rules": len(list_automation_rules()),
        "events": len(list_automation_events()),
        "deliveries": len(list_connector_deliveries()),
        "recentEvents": [event.model_dump() for event in list_automation_events()[:10]],
    }
    markdown = render_evidence_pack_markdown(
        pack_id,
        generated_at,
        evidence,
        readiness,
        gateway_snapshot,
        access_audit,
        automation_snapshot,
    )
    summary = {
        "readinessDecision": readiness.decision,
        "readinessScore": readiness.score,
        "evidenceDecision": evidence.summary.get("decision", "review"),
        "latestGateDecision": evidence.latestGate.decision if evidence.latestGate else "not_run",
        "latestDatasetReplayGateDecision": evidence.summary.get("latestDatasetReplayGateDecision", "not_run"),
        "gatewayTotalRequests": gateway_snapshot["metrics"]["totalRequests"],
        "gatewayRoutedRequests": gateway_snapshot["metrics"]["routedRequests"],
        "accessAuditEvents": len(access_audit),
        "automationRules": automation_snapshot["rules"],
        "automationDeliveries": automation_snapshot["deliveries"],
    }
    pack_without_digest = {
        "schemaVersion": "neuralops.evidence-pack.v1",
        "id": pack_id,
        "generatedAt": generated_at,
        "workspaceId": evidence.status.workspaceId,
        "subject": "production-ai-release",
        "decision": readiness.decision,
        "score": readiness.score,
        "summary": summary,
        "artifacts": [
            EvidenceExportArtifact(label="Evidence pack JSON", type="json", path="/api/evidence/export").model_dump(),
            EvidenceExportArtifact(label="Evidence pack Markdown", type="markdown", path="download:neuralops-evidence-pack.md").model_dump(),
            EvidenceExportArtifact(label="Live evidence dashboard", type="ui", path="/#Evidence").model_dump(),
        ],
        "evidence": evidence.model_dump(),
        "readiness": readiness.model_dump(),
        "gateway": gateway_snapshot,
        "accessAudit": [event.model_dump() for event in access_audit],
        "automation": automation_snapshot,
        "markdown": markdown,
    }
    digest = "sha256=" + sha256(json.dumps(pack_without_digest, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()
    pack_without_digest["digest"] = digest
    pack = EvidenceExportPack.model_validate(pack_without_digest)
    save_scoped_record("evidence_packs", pack.id, pack.model_dump())
    save_audit_event(
        "evidence_pack.export",
        current_user_email(),
        pack.id,
        pack.decision,
        f"Exported release evidence pack {pack.id}: {pack.decision} ({pack.score}/100).",
    )
    return pack


def api_base_url() -> str:
    return os.getenv("NEURALOPS_PUBLIC_API_URL", "http://localhost:8000").rstrip("/")


def gateway_environment(request: GatewayChatCompletionRequest) -> str:
    value = request.metadata.get("environment") if isinstance(request.metadata, dict) else None
    if value in {"prod", "staging", "dev"}:
        return str(value)
    return "staging"


def gateway_messages_text(messages: list[Any]) -> str:
    parts: list[str] = []
    for message in messages:
        role = getattr(message, "role", None) or (message.get("role") if isinstance(message, dict) else "message")
        content = getattr(message, "content", None) if not isinstance(message, dict) else message.get("content")
        parts.append(f"{role}: {gateway_content_text(content)}")
    return "\n".join(parts).strip()


def gateway_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        values: list[str] = []
        for item in content:
            if isinstance(item, dict):
                values.append(str(item.get("text") or item.get("content") or item))
            else:
                values.append(str(item))
        return " ".join(values)
    return "" if content is None else str(content)


def gateway_providers_for_environment(environment: str) -> list[RuntimeProvider]:
    return [
        provider
        for provider in runtime_providers()
        if provider.environment in ("all", environment)
    ]


GATEWAY_PRICE_TABLE: dict[str, tuple[float, float]] = {
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "claude": (3.00, 15.00),
    "gemini": (0.35, 1.05),
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "llama-3.1-70b": (0.59, 0.79),
    "qwen": (0.30, 0.30),
    "deepseek": (0.27, 1.10),
    "mistral": (2.00, 6.00),
    "local": (0.0, 0.0),
}


def now_iso() -> str:
    return datetime.now().isoformat()


def default_gateway_routing_policy() -> GatewayRoutingPolicy:
    return GatewayRoutingPolicy(id="default", updatedAt=now_iso())


def gateway_routing_policy() -> GatewayRoutingPolicy:
    record = get_scoped_record("gateway_routing_policies", "default")
    if record is None:
        policy = default_gateway_routing_policy()
        save_scoped_record("gateway_routing_policies", "default", policy.model_dump())
        return policy
    return GatewayRoutingPolicy.model_validate(record)


def save_gateway_routing_policy(payload: dict[str, Any]) -> GatewayRoutingPolicy:
    current = gateway_routing_policy().model_dump()
    current.update({key: value for key, value in payload.items() if value is not None})
    current["id"] = "default"
    current["updatedAt"] = now_iso()
    policy = GatewayRoutingPolicy.model_validate(current)
    save_scoped_record("gateway_routing_policies", "default", policy.model_dump())
    return policy


def model_price(model: str | None) -> tuple[float, float] | None:
    normalized = (model or "").lower()
    for marker, price in GATEWAY_PRICE_TABLE.items():
        if marker in normalized:
            return price
    return None


def estimate_gateway_cost_usd(model: str | None, prompt: str, request: GatewayChatCompletionRequest) -> float | None:
    price = model_price(model)
    if price is None:
        return None
    input_tokens = estimate_tokens(prompt)
    output_tokens = request.max_tokens or max(32, min(512, input_tokens))
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1_000_000, 6)


def actual_gateway_cost_usd(model: str | None, usage: dict[str, Any] | None) -> float | None:
    price = model_price(model)
    if price is None or not usage:
        return None
    input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or 0)
    if input_tokens == 0 and output_tokens == 0 and total_tokens:
        input_tokens = total_tokens
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1_000_000, 6)


def provider_latency_score(provider: RuntimeProvider) -> int:
    logs = [
        GatewayRequestLog.model_validate(item)
        for item in scoped_records("gateway_request_logs")
        if item.get("selectedProvider", {}).get("id") == provider.id and item.get("status") == "routed"
    ]
    if not logs:
        return 1_000 + provider.priority
    return max(1, int(sum(item.latencyMs for item in logs) / len(logs)))


def provider_success_rate(provider: RuntimeProvider) -> float:
    logs = [
        GatewayRequestLog.model_validate(item)
        for item in scoped_records("gateway_request_logs")
        if item.get("selectedProvider", {}).get("id") == provider.id
    ]
    if not logs:
        return 1.0
    successes = sum(1 for item in logs if item.status == "routed")
    return successes / len(logs)


def route_candidates(
    providers: list[RuntimeProvider],
    request: GatewayChatCompletionRequest,
    prompt: str,
    policy: GatewayRoutingPolicy,
) -> list[RuntimeProvider]:
    if policy.strategy == "priority":
        return sorted(providers, key=lambda item: (item.priority, item.label.lower()))
    if policy.strategy == "lowest_cost":
        return sorted(
            providers,
            key=lambda item: (
                estimate_gateway_cost_usd(request.model or item.default_model, prompt, request) is None,
                estimate_gateway_cost_usd(request.model or item.default_model, prompt, request) or 999_999,
                item.priority,
            ),
        )
    if policy.strategy == "lowest_latency":
        return sorted(providers, key=lambda item: (provider_latency_score(item), item.priority))
    return sorted(
        providers,
        key=lambda item: (
            (estimate_gateway_cost_usd(request.model or item.default_model, prompt, request) or 1) * 1000
            + provider_latency_score(item) / 1000
            + (1 - provider_success_rate(item)) * 100,
            item.priority,
        ),
    )


def gateway_selected_reason(policy: GatewayRoutingPolicy, selected: RuntimeProvider) -> str:
    if policy.strategy == "lowest_cost":
        return "lowest_cost"
    if policy.strategy == "lowest_latency":
        return "lowest_latency"
    if policy.strategy == "balanced":
        return "balanced_score"
    return "priority"


def gateway_cache_key(request: GatewayChatCompletionRequest, environment: str, prompt: str, policy: GatewayRoutingPolicy) -> str:
    material = f"{environment}|{request.model or ''}|{policy.strategy}|{prompt}|{request.temperature}|{request.max_tokens}"
    return sha256(material.encode("utf-8")).hexdigest()


def gateway_cache_hit(cache_key: str) -> GatewayCacheEntry | None:
    record = get_scoped_record("gateway_cache_entries", cache_key)
    if record is None:
        return None
    entry = GatewayCacheEntry.model_validate(record)
    if datetime.fromisoformat(entry.expiresAt) <= datetime.now():
        delete_scoped_record("gateway_cache_entries", cache_key)
        return None
    entry.hitCount += 1
    save_scoped_record("gateway_cache_entries", cache_key, entry.model_dump())
    return entry


def save_gateway_cache_entry(
    cache_key: str,
    environment: str,
    model: str | None,
    payload: dict[str, Any],
    usage: dict[str, Any] | None,
    cost_usd: float | None,
    policy: GatewayRoutingPolicy,
) -> GatewayCacheEntry:
    entry = GatewayCacheEntry(
        id=cache_key,
        cacheKey=cache_key,
        environment=environment,  # type: ignore[arg-type]
        model=model,
        responsePayload=payload,
        promptTokens=int((usage or {}).get("prompt_tokens") or (usage or {}).get("input_tokens") or 0),
        completionTokens=int((usage or {}).get("completion_tokens") or (usage or {}).get("output_tokens") or 0),
        costUsd=cost_usd or 0,
        expiresAt=(datetime.now() + timedelta(seconds=policy.cacheTtlSeconds)).isoformat(),
        createdAt=now_iso(),
    )
    save_scoped_record("gateway_cache_entries", cache_key, entry.model_dump())
    return entry


def gateway_budgets() -> list[GatewayBudget]:
    budgets = [GatewayBudget.model_validate(item) for item in scoped_records("gateway_budgets")]
    return sorted(budgets, key=lambda item: (item.environment, item.createdAt))


def active_gateway_budget(environment: str) -> GatewayBudget | None:
    candidates = [budget for budget in gateway_budgets() if budget.environment in ("all", environment)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: (item.environment != environment, item.createdAt), reverse=False)[0]


def save_gateway_budget(payload: dict[str, Any]) -> GatewayBudget:
    now = now_iso()
    budget_id = f"gb_{token_hex(5)}"
    limit = float(payload.get("limitUsd", 0))
    budget = GatewayBudget(
        id=budget_id,
        environment=payload.get("environment", "staging"),
        limitUsd=limit,
        softLimitUsd=payload.get("softLimitUsd"),
        hardLimitEnabled=bool(payload.get("hardLimitEnabled", True)),
        period=payload.get("period", "monthly"),
        createdAt=now,
        updatedAt=now,
        remainingUsd=limit,
    )
    save_scoped_record("gateway_budgets", budget.id, budget.model_dump())
    return budget


def patch_gateway_budget(budget_id: str, payload: dict[str, Any]) -> GatewayBudget:
    existing = get_scoped_record("gateway_budgets", budget_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Gateway budget not found")
    existing.update({key: value for key, value in payload.items() if value is not None})
    existing["updatedAt"] = now_iso()
    existing["remainingUsd"] = max(0, float(existing.get("limitUsd", 0)) - float(existing.get("spentUsd", 0)))
    budget = GatewayBudget.model_validate(existing)
    save_scoped_record("gateway_budgets", budget.id, budget.model_dump())
    return budget


def gateway_budget_decision(environment: str, estimated_cost: float | None) -> tuple[str, GatewayBudget | None]:
    budget = active_gateway_budget(environment)
    if budget is None or estimated_cost is None:
        return "allow", budget
    projected = budget.spentUsd + estimated_cost
    if budget.hardLimitEnabled and projected > budget.limitUsd:
        return "hard_limit", budget
    if budget.softLimitUsd is not None and projected > budget.softLimitUsd:
        return "soft_limit", budget
    return "allow", budget


def add_gateway_budget_spend(budget: GatewayBudget | None, amount: float | None) -> None:
    if budget is None or amount is None:
        return
    budget.spentUsd = round(budget.spentUsd + amount, 6)
    budget.remainingUsd = max(0, round(budget.limitUsd - budget.spentUsd, 6))
    budget.updatedAt = now_iso()
    save_scoped_record("gateway_budgets", budget.id, budget.model_dump())


def gateway_rate_limit_key(api_key: dict[str, Any], environment: str) -> str:
    minute = datetime.now().strftime("%Y%m%d%H%M")
    return f"{api_key.get('id', 'unknown')}:{environment}:{minute}"


def check_gateway_rate_limit(api_key: dict[str, Any], environment: str, policy: GatewayRoutingPolicy) -> tuple[bool, int]:
    key = gateway_rate_limit_key(api_key, environment)
    record = get_scoped_record("gateway_rate_limit_events", key) or {"id": key, "count": 0, "environment": environment, "createdAt": now_iso()}
    count = int(record.get("count", 0)) + 1
    record["count"] = count
    record["updatedAt"] = now_iso()
    save_scoped_record("gateway_rate_limit_events", key, record)
    return count <= policy.rateLimitPerMinute, count


def gateway_route_provider(provider: RuntimeProvider) -> GatewayRouteProvider:
    return GatewayRouteProvider(id=provider.id, label=provider.label, source=provider.source, priority=provider.priority)


def sanitize_gateway_error(error: str) -> str:
    sanitized = re.sub(r"(?i)(bearer|authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", error)
    sanitized = re.sub(r"\b(sk|gsk|sb_secret|sb_publishable|nop_sk)_[A-Za-z0-9_\-]{8,}\b", "[redacted-key]", sanitized)
    return sanitized[:240]


def gateway_route_attempt(provider: RuntimeProvider, status: str, latency_ms: int, error: str | None = None) -> GatewayRouteAttempt:
    return GatewayRouteAttempt(
        provider=gateway_route_provider(provider),
        status=status,  # type: ignore[arg-type]
        latencyMs=max(0, latency_ms),
        error=sanitize_gateway_error(error) if error else None,
    )


def gateway_route_response_attempt(attempt: GatewayRouteAttempt) -> dict[str, Any]:
    return {
        "id": attempt.provider.id,
        "label": attempt.provider.label,
        "source": attempt.provider.source,
        "priority": attempt.provider.priority,
        "status": attempt.status,
        "latencyMs": attempt.latencyMs,
        "error": attempt.error,
    }


def save_gateway_route_event(
    *,
    environment: str,
    requested_model: str | None,
    status: str,
    decision: str,
    attempts: list[GatewayRouteAttempt],
    selected_provider: RuntimeProvider | None = None,
    trace_id: str | None = None,
    findings: list[str] | None = None,
    routing_strategy: str = "priority",
    selected_reason: str = "priority",
    cache_status: str = "disabled",
    budget_decision: str = "allow",
    estimated_cost_usd: float | None = None,
    actual_cost_usd: float | None = None,
) -> GatewayRouteEvent:
    event = GatewayRouteEvent(
        id=f"gr_{token_hex(6)}",
        traceId=trace_id,
        environment=environment,  # type: ignore[arg-type]
        requestedModel=requested_model,
        selectedProvider=gateway_route_provider(selected_provider) if selected_provider else None,
        status=status,  # type: ignore[arg-type]
        decision=decision,  # type: ignore[arg-type]
        attempts=attempts,
        routingStrategy=routing_strategy,  # type: ignore[arg-type]
        selectedReason=selected_reason,
        retryCount=max(0, len(attempts) - 1),
        cacheStatus=cache_status,  # type: ignore[arg-type]
        budgetDecision=budget_decision,  # type: ignore[arg-type]
        estimatedCostUsd=estimated_cost_usd,
        actualCostUsd=actual_cost_usd,
        policyFindings=findings or [],
        generatedAt=datetime.now().isoformat(),
    )
    save_scoped_record("gateway_route_events", event.id, event.model_dump())
    return event


def gateway_route_events(limit: int = 25) -> list[GatewayRouteEvent]:
    events = [GatewayRouteEvent.model_validate(item) for item in scoped_records("gateway_route_events")]
    return sorted(events, key=lambda item: item.generatedAt, reverse=True)[:limit]


def save_gateway_request_log(
    *,
    environment: str,
    requested_model: str | None,
    routing_policy: GatewayRoutingPolicy,
    selected_reason: str,
    cache_status: str,
    budget_decision: str,
    status: str,
    latency_ms: int,
    selected_provider: RuntimeProvider | None = None,
    trace_id: str | None = None,
    route_event_id: str | None = None,
    estimated_cost_usd: float | None = None,
    actual_cost_usd: float | None = None,
) -> GatewayRequestLog:
    log = GatewayRequestLog(
        id=f"greq_{token_hex(6)}",
        traceId=trace_id,
        routeEventId=route_event_id,
        environment=environment,  # type: ignore[arg-type]
        requestedModel=requested_model,
        selectedProvider=gateway_route_provider(selected_provider) if selected_provider else None,
        routingStrategy=routing_policy.strategy,
        selectedReason=selected_reason,
        cacheStatus=cache_status,  # type: ignore[arg-type]
        budgetDecision=budget_decision,  # type: ignore[arg-type]
        estimatedCostUsd=estimated_cost_usd,
        actualCostUsd=actual_cost_usd,
        latencyMs=max(0, latency_ms),
        status=status,  # type: ignore[arg-type]
        generatedAt=now_iso(),
    )
    save_scoped_record("gateway_request_logs", log.id, log.model_dump())
    return log


def gateway_request_logs(limit: int = 100) -> list[GatewayRequestLog]:
    logs = [GatewayRequestLog.model_validate(item) for item in scoped_records("gateway_request_logs")]
    return sorted(logs, key=lambda item: item.generatedAt, reverse=True)[:limit]


def gateway_metrics() -> GatewayMetrics:
    logs = gateway_request_logs(limit=10_000)
    routed = [log for log in logs if log.status == "routed" and log.cacheStatus != "hit"]
    failures = [log for log in logs if log.status in {"failed", "not_configured"}]
    blocked = [log for log in logs if log.status in {"blocked", "rate_limited", "budget_exceeded"}]
    provider_rows: dict[str, dict[str, Any]] = {}
    for log in logs:
        provider = log.selectedProvider
        if provider is None:
            continue
        row = provider_rows.setdefault(
            provider.id,
            {"id": provider.id, "label": provider.label, "requests": 0, "failures": 0, "latency": [], "spendUsd": 0.0},
        )
        row["requests"] += 1
        if log.status != "routed":
            row["failures"] += 1
        row["latency"].append(log.latencyMs)
        row["spendUsd"] += log.actualCostUsd or log.estimatedCostUsd or 0
    provider_breakdown = [
        GatewayProviderMetric(
            id=row["id"],
            label=row["label"],
            requests=row["requests"],
            failures=row["failures"],
            avgLatencyMs=int(sum(row["latency"]) / max(1, len(row["latency"]))),
            spendUsd=round(row["spendUsd"], 6),
        )
        for row in provider_rows.values()
    ]
    provider_breakdown.sort(key=lambda item: item.requests, reverse=True)
    return GatewayMetrics(
        totalRequests=len(logs),
        routedRequests=len(routed),
        failedRequests=len(failures),
        blockedRequests=len(blocked),
        cacheHits=sum(1 for log in logs if log.cacheStatus == "hit"),
        estimatedSpendUsd=round(sum(log.estimatedCostUsd or 0 for log in logs), 6),
        actualSpendUsd=round(sum(log.actualCostUsd or 0 for log in logs), 6),
        providerBreakdown=provider_breakdown,
        latestRoutes=gateway_route_events(limit=10),
    )


def gateway_cost_suggestions() -> list[GatewayCostSuggestion]:
    logs = gateway_request_logs(limit=1_000)
    suggestions: list[GatewayCostSuggestion] = []
    if any(log.cacheStatus == "miss" for log in logs) and not any(log.cacheStatus == "hit" for log in logs):
        suggestions.append(
            GatewayCostSuggestion(
                id="enable_cache",
                severity="info",
                title="Enable exact-match cache for repeated safe prompts",
                detail="Repeated gateway calls can avoid provider spend when cache is enabled and policy allows the response.",
            )
        )
    providers = gateway_providers_for_environment("staging")
    if len(providers) >= 2:
        cheapest = sorted(providers, key=lambda item: estimate_gateway_cost_usd(item.default_model, "sample prompt", GatewayChatCompletionRequest(messages=[{"role": "user", "content": "sample"}])) or 999_999)[0]
        suggestions.append(
            GatewayCostSuggestion(
                id="route_low_cost",
                severity="review",
                title=f"Use {cheapest.label} for low-risk staging traffic",
                detail=f"{cheapest.default_model} has the lowest known local price estimate among configured staging providers.",
            )
        )
    return suggestions


def route_gateway_provider(
    providers: list[RuntimeProvider],
    request: GatewayChatCompletionRequest,
    prompt: str,
    policy: GatewayRoutingPolicy,
) -> tuple[RuntimeProvider | None, dict[str, Any] | None, list[GatewayRouteAttempt]]:
    attempts: list[GatewayRouteAttempt] = []
    for provider in route_candidates(providers, request, prompt, policy):
        for attempt_number in range(policy.retryAttempts):
            attempt_started = datetime.now()
            try:
                payload = provider_chat_completion(provider, request)
            except Exception as exc:  # noqa: BLE001 - provider failures are runtime route evidence.
                latency_ms = max(1, int((datetime.now() - attempt_started).total_seconds() * 1000))
                attempts.append(gateway_route_attempt(provider, "failed", latency_ms, str(exc)))
                if attempt_number < policy.retryAttempts - 1:
                    backoff_ms = policy.retryBackoffMs[min(attempt_number, len(policy.retryBackoffMs) - 1)]
                    sleep(backoff_ms / 1000)
                continue
            latency_ms = max(1, int((datetime.now() - attempt_started).total_seconds() * 1000))
            attempts.append(gateway_route_attempt(provider, "succeeded", latency_ms))
            return provider, payload, attempts
    return None, None, attempts


def gateway_policy_mode(policy_id: str) -> str:
    policy = next((item for item in scoped_records("policies") if item.get("id") == policy_id), None)
    if not policy or not policy.get("enabled", True):
        return "monitor"
    return str(policy.get("mode", "monitor"))


def gateway_finding_metadata(finding: str) -> tuple[str, str]:
    if finding == "prompt-injection":
        return "pol_01", "Critical"
    if finding == "credential-language":
        return "pol_02", "Critical"
    return "pol_03", "Major"


def evaluate_gateway_policy(stage: str, prompt: str, output: str = "") -> GatewayPolicyDecision:
    findings = detect_policy_findings(prompt, output)
    if not findings:
        return GatewayPolicyDecision(decision="allow", stage=stage, findings=[], reason="No gateway policy matched.")  # type: ignore[arg-type]

    decision = "allow"
    for finding in findings:
        policy_id, severity = gateway_finding_metadata(finding)
        mode = gateway_policy_mode(policy_id)
        if mode == "monitor":
            continue
        if mode == "block" or (mode == "review" and severity == "Critical"):
            decision = "block"
            break
        if mode == "review":
            decision = "review"
    reason = (
        "Gateway policy blocked critical prompt, credential, or tool-risk content."
        if decision == "block"
        else "Gateway policy matched content that requires review."
        if decision == "review"
        else "Gateway policy matched in monitor mode only."
    )
    return GatewayPolicyDecision(decision=decision, stage=stage, findings=findings, reason=reason)  # type: ignore[arg-type]


def save_gateway_policy_violations(trace: Trace, policy_decision: GatewayPolicyDecision) -> None:
    for finding in policy_decision.findings:
        policy_id, severity = gateway_finding_metadata(finding)
        policy_name = next((item.get("name", policy_id) for item in scoped_records("policies") if item.get("id") == policy_id), policy_id)
        violation = PolicyViolation(
            id=f"vio_gateway_{token_hex(5)}",
            policyId=policy_id,
            policyName=str(policy_name),
            decision="blocked" if policy_decision.decision == "block" else "review" if policy_decision.decision == "review" else "warned",
            severity=severity,  # type: ignore[arg-type]
            subject=trace.id,
            summary=f"Gateway {policy_decision.stage} matched {finding}.",
            time=datetime.now().isoformat(),
        )
        save_scoped_record("policy_violations", violation.id, violation.model_dump())


def gateway_trace(
    *,
    request: GatewayChatCompletionRequest,
    environment: str,
    provider: RuntimeProvider | None,
    prompt: str,
    output: str,
    policy_decision: GatewayPolicyDecision,
    latency_ms: int,
    usage: dict[str, Any] | None,
) -> Trace:
    token_count = int((usage or {}).get("total_tokens") or estimate_tokens(f"{prompt}\n{output}"))
    cost_usd = round(token_count * 0.000015, 5)
    status = "blocked" if policy_decision.decision == "block" else "warning" if policy_decision.decision == "review" else "success"
    model = request.model or provider.default_model if provider is not None else request.model or "gateway-unconfigured"
    trace_id = f"tr_gateway_{token_hex(6)}"
    return Trace(
        id=trace_id,
        timestamp=datetime.now().strftime("%H:%M:%S"),
        session=str(request.metadata.get("session") or request.metadata.get("session_id") or f"gateway-{trace_id[-6:]}"),
        environment=environment,  # type: ignore[arg-type]
        model=model,
        tokens=token_count,
        latency=f"{latency_ms / 1000:.2f}s",
        cost=f"${cost_usd:.3f}",
        status=status,
        score=0.0 if status == "blocked" else 0.74 if status == "warning" else 0.96,
        prompt=prompt,
        output=output,
        toolCalls=f"gateway.openai_chat -> {provider.label}" if provider is not None else "gateway.openai_chat -> policy",
        source="api",
        spanCount=3 if provider is not None else 2,
        riskFlags=policy_decision.findings,
        spans=[
            TraceSpan(id=f"{trace_id}_policy", name=f"gateway.{policy_decision.stage}", operation="policy.evaluate", durationMs=1, status="ok"),
            TraceSpan(id=f"{trace_id}_provider", name="gateway.provider.forward", operation="chat.completions", durationMs=max(1, latency_ms), status="ok" if provider is not None else "unset"),
            TraceSpan(id=f"{trace_id}_audit", name="gateway.audit", operation="audit.persist", durationMs=1, status="ok"),
        ],
    )


def provider_chat_completion(provider: RuntimeProvider, request: GatewayChatCompletionRequest) -> dict[str, Any]:
    payload = request.model_dump(exclude_none=True)
    payload["model"] = request.model or provider.default_model
    payload.pop("metadata", None)
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    with httpx.Client(timeout=30) as client:
        response = client.post(f"{provider.base_url.rstrip('/')}/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        return response.json()


def gateway_response_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if isinstance(message, dict):
        return gateway_content_text(message.get("content"))
    return ""


def persist_gateway_trace(trace: Trace, policy_decision: GatewayPolicyDecision, actor: str) -> None:
    save_scoped_record("traces", trace.id, trace.model_dump())
    save_gateway_policy_violations(trace, policy_decision)
    trigger_trace_automations(trace)
    save_audit_event(
        f"gateway.{policy_decision.stage}",
        actor,
        trace.id,
        policy_decision.decision,
        f"Gateway {policy_decision.stage} decision {policy_decision.decision}: {policy_decision.reason}",
    )


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
            id="batch-js",
            label="Node Batch Ingest",
            language="javascript",
            command="npm install @neuralops/sdk",
            code=(
                "import { NeuralOps } from '@neuralops/sdk';\n\n"
                "const neuralops = new NeuralOps({\n"
                "  apiKey: process.env.NEURALOPS_API_KEY,\n"
                f"  baseUrl: process.env.NEURALOPS_API_URL || '{base_url}'\n"
                "});\n\n"
                "await neuralops.ingestTraces([\n"
                "  {\n"
                "    session: 'checkout-agent-001',\n"
                "    environment: 'staging',\n"
                "    model: 'llama-3.3-70b-versatile',\n"
                "    tokens: 742,\n"
                "    latencyMs: 830,\n"
                "    costUsd: 0.012,\n"
                "    status: 'success',\n"
                "    score: 0.93,\n"
                "    prompt: 'Classify checkout outage ticket',\n"
                "    output: 'P1 incident routed to payments on-call',\n"
                "    idempotencyKey: 'checkout-agent-001:span-0001'\n"
                "  }\n"
                "]);"
            ),
            notes=["Use for production flush/retry loops.", "Repeated idempotency keys do not create duplicate traces."],
        ),
        ConnectSnippet(
            id="gateway-js",
            label="Node Gateway Call",
            language="javascript",
            command="npm install @neuralops/sdk",
            code=(
                "import { NeuralOps } from '@neuralops/sdk';\n\n"
                "const neuralops = new NeuralOps({\n"
                "  apiKey: process.env.NEURALOPS_API_KEY,\n"
                f"  baseUrl: process.env.NEURALOPS_API_URL || '{base_url}'\n"
                "});\n\n"
                "const completion = await neuralops.chatCompletions({\n"
                "  model: 'gpt-4o-mini',\n"
                "  metadata: { environment: 'staging', session: 'checkout-agent-001' },\n"
                "  messages: [\n"
                "    { role: 'system', content: 'Answer safely and do not reveal secrets.' },\n"
                "    { role: 'user', content: 'Summarize this support incident.' }\n"
                "  ]\n"
                "});\n\n"
                "console.log(completion.neuralops.traceId);"
            ),
            notes=["Requires a key with gateway:invoke scope.", "Returns not_configured until a live provider is connected."],
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
            id="gateway-python",
            label="Python Gateway Call",
            language="python",
            command="pip install neuralops-sdk",
            code=(
                "import os\n"
                "from neuralops import NeuralOpsClient\n\n"
                "client = NeuralOpsClient(\n"
                "    api_key=os.environ['NEURALOPS_API_KEY'],\n"
                f"    base_url=os.getenv('NEURALOPS_API_URL', '{base_url}'),\n"
                ")\n\n"
                "completion = client.chat_completions(\n"
                "    model='gpt-4o-mini',\n"
                "    metadata={'environment': 'staging', 'session': 'rag-api-001'},\n"
                "    messages=[\n"
                "        {'role': 'system', 'content': 'Answer from approved context only.'},\n"
                "        {'role': 'user', 'content': 'Explain the support policy.'},\n"
                "    ],\n"
                ")\n\n"
                "print(completion['neuralops']['traceId'])"
            ),
            notes=["Use server-side only.", "Policy checks run before and after the provider call."],
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
        gatewayEndpoint=f"{base_url}/api/gateway/openai/v1/chat/completions",
        authHeader="x-neuralops-key",
        snippets=snippets,
        generatedAt=datetime.now().isoformat(),
    )


def latest_timestamp(records: list[dict[str, Any]], *keys: str) -> str | None:
    values: list[str] = []
    for record in records:
        for key in keys:
            value = record.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
                break
    return max(values) if values else None


def connectivity_status_score(status: str) -> int:
    if status == "ready":
        return 100
    if status == "degraded":
        return 55
    return 0


def connectivity_next_actions(checks: list[ConnectivityCheck]) -> list[ConnectivityAction]:
    action_map = {
        "auth": ConnectivityAction(
            id="enable_auth",
            label="Enable Supabase Auth",
            target="Settings",
            reason="Public SaaS needs authenticated workspace isolation before broad user access.",
            priority="high",
        ),
        "provider_gateway": ConnectivityAction(
            id="connect_provider",
            label="Connect a live model provider",
            target="Settings",
            reason="Gateway calls return not_configured until Groq, NVIDIA, OpenAI-compatible, Ollama, or another provider is configured.",
            priority="high",
        ),
        "ingest_key": ConnectivityAction(
            id="create_ingest_key",
            label="Create an ingest and gateway key",
            target="Connect",
            reason="Applications need a scoped server-side key before sending traces or routing LLM calls.",
            priority="high",
        ),
        "webhook_delivery": ConnectivityAction(
            id="register_webhook",
            label="Register a webhook destination",
            target="Settings",
            reason="Slack, Jira, GitHub, n8n, or generic webhook delivery needs a destination before incident automation can notify people.",
            priority="medium",
        ),
        "automation_worker": ConnectivityAction(
            id="create_automation",
            label="Create an automation rule",
            target="Automations",
            reason="Connector delivery is useful only when rules create events from blocked traces, release gates, or policy violations.",
            priority="medium",
        ),
    }
    actions: list[ConnectivityAction] = []
    action_ids: set[str] = set()
    for check in checks:
        if check.status == "ready":
            continue
        action = action_map.get(check.id)
        if action is not None and action.id not in action_ids:
            action_ids.add(action.id)
            actions.append(action)
    priority_order = {"high": 0, "medium": 1, "low": 2}
    return sorted(actions, key=lambda item: priority_order[item.priority])


def build_connectivity_map() -> ConnectivityMap:
    ensure_workspace_bootstrap()
    settings_payload = settings_payload_or_404()
    api_keys = settings_payload.get("apiKeys", [])
    webhooks = settings_payload.get("webhooks", [])
    providers = [provider for provider in list_providers() if provider.id != "local"]
    configured_provider_count = sum(1 for provider in providers if provider.configured)
    live_provider_count = sum(1 for provider in providers if provider.configured and provider.source in {"env", "connection"})
    gateway_key_count = sum(
        1
        for api_key in api_keys
        if "gateway:invoke" in api_key.get("scopes", []) or "admin" in api_key.get("scopes", [])
    )
    trace_records = scoped_records("traces")
    automation_rules = [AutomationRule.model_validate(item) for item in scoped_records("automation_rules")]
    connector_records = scoped_records("connector_deliveries")

    provider_status = "ready" if live_provider_count else "degraded" if configured_provider_count else "missing"
    provider_action = (
        "Live provider available for NeuralOps Gateway."
        if live_provider_count
        else "Provider presets are visible, but a live key-backed provider is not configured."
        if configured_provider_count
        else "Add a live provider connection or environment key in Settings."
    )
    gateway_status = "ready" if live_provider_count and gateway_key_count else "degraded" if gateway_key_count else "missing"

    checks = [
        ConnectivityCheck(
            id="database",
            label="Database storage",
            category="database",
            status="ready",
            evidence=f"{storage_backend()} backend is active for workspace {current_workspace_id()}.",
            endpoint="/health",
            action="No action required.",
        ),
        ConnectivityCheck(
            id="auth",
            label="Workspace authentication",
            category="auth",
            status="ready" if auth_required() else "missing",
            evidence="Supabase/JWT auth is required for API access." if auth_required() else "Local mode is open; enable auth before public production.",
            endpoint="/api/system/status",
            action="No action required." if auth_required() else "Enable NEURALOPS_AUTH_REQUIRED and Supabase Auth for public SaaS.",
        ),
        ConnectivityCheck(
            id="provider_gateway",
            label="Live provider gateway",
            category="provider",
            status=provider_status,
            evidence=f"{live_provider_count} live provider(s), {configured_provider_count} configured provider surface(s).",
            endpoint="/api/gateway/openai/v1/chat/completions",
            action=provider_action,
        ),
        ConnectivityCheck(
            id="gateway_policy",
            label="Policy gateway route",
            category="gateway",
            status=gateway_status,
            evidence=f"{gateway_key_count} key(s) can invoke the gateway.",
            endpoint="/api/gateway/openai/v1/chat/completions",
            action="Create a gateway-scoped key and connect a provider." if gateway_status != "ready" else "No action required.",
        ),
        ConnectivityCheck(
            id="ingest_key",
            label="Scoped NeuralOps API key",
            category="ingest",
            status="ready" if api_keys else "missing",
            evidence=f"{len(api_keys)} key(s), {gateway_key_count} with gateway:invoke or admin scope.",
            endpoint="/api/settings/api-keys",
            lastSeenAt=latest_timestamp(api_keys, "lastUsedAt", "created"),
            action="Create a scoped server-side key in Connect or Settings." if not api_keys else "Keep keys server-side and rotate after exposure.",
        ),
        ConnectivityCheck(
            id="trace_ingest",
            label="Trace ingestion API",
            category="ingest",
            status="ready" if api_keys and trace_records else "degraded" if api_keys else "missing",
            evidence=f"{len(trace_records)} trace(s) stored from API, OTel, gateway, or local agent runs.",
            endpoint="/api/traces/ingest",
            lastSeenAt=latest_timestamp(trace_records, "createdAt", "timestamp"),
            action="Verify an SDK/REST trace from Connect." if not trace_records else "No action required.",
        ),
        ConnectivityCheck(
            id="otel_ingest",
            label="OpenTelemetry GenAI ingest",
            category="otel",
            status="ready",
            evidence="OTel normalization endpoint is mounted and accepts GenAI span payloads.",
            endpoint="/api/traces/otel",
            action="Point an OTel collector or SDK exporter at the endpoint using a scoped NeuralOps key.",
        ),
        ConnectivityCheck(
            id="webhook_delivery",
            label="Webhook and connector destinations",
            category="webhook",
            status="ready" if webhooks else "missing",
            evidence=f"{len(webhooks)} webhook(s), {len(connector_records)} connector delivery record(s).",
            endpoint="/api/settings/webhooks",
            lastSeenAt=latest_timestamp(webhooks, "createdAt"),
            action="Run the delivery worker from Automations." if webhooks else "Register Slack/Jira/GitHub/n8n or generic webhook endpoints.",
        ),
        ConnectivityCheck(
            id="automation_worker",
            label="Automation worker",
            category="automation",
            status="ready" if any(rule.enabled for rule in automation_rules) else "missing",
            evidence=f"{len(automation_rules)} rule(s), {sum(1 for rule in automation_rules if rule.enabled)} enabled.",
            endpoint="/api/connector-deliveries/process",
            lastSeenAt=latest_timestamp([rule.model_dump() for rule in automation_rules], "lastRunAt", "updatedAt"),
            action="Use Dry Run Worker before enabling external sends." if automation_rules else "Create a rule that records webhook delivery or opens incidents.",
        ),
    ]
    score = round(sum(connectivity_status_score(check.status) for check in checks) / len(checks))
    overall_status = "ready" if score >= 90 else "degraded" if score >= 20 else "missing"
    return ConnectivityMap(
        workspaceId=current_workspace_id(),
        storage=storage_backend(),
        overallStatus=overall_status,
        score=score,
        checks=checks,
        nextActions=connectivity_next_actions(checks),
        generatedAt=datetime.now().isoformat(),
    )


def synthetic_check(
    check_id: str,
    label: str,
    status: str,
    started_at: float,
    evidence: str,
    action: str,
) -> SyntheticCanaryCheck:
    return SyntheticCanaryCheck(
        id=check_id,
        label=label,
        status=status,  # type: ignore[arg-type]
        latencyMs=max(0, round((perf_counter() - started_at) * 1000)),
        evidence=evidence,
        action=action,
    )


def run_synthetic_canary(request: SyntheticCanaryRequest) -> SyntheticCanaryRun:
    run_id = f"syn_{token_hex(6)}"
    checks: list[SyntheticCanaryCheck] = []
    connectivity = build_connectivity_map()

    started = perf_counter()
    probe_id = f"probe_{token_hex(5)}"
    save_scoped_record(
        "synthetic_probes",
        probe_id,
        {
            "id": probe_id,
            "runId": run_id,
            "target": request.target,
            "createdAt": datetime.now().isoformat(),
        },
    )
    probe_payload = get_scoped_record("synthetic_probes", probe_id)
    checks.append(
        synthetic_check(
            "database_write_read",
            "Database write/read",
            "pass" if probe_payload is not None else "fail",
            started,
            f"Wrote and read synthetic probe {probe_id} using {storage_backend()} storage.",
            "Check database credentials and migration state." if probe_payload is None else "No action required.",
        )
    )

    connectivity_checks = {check.id: check for check in connectivity.checks}
    auth_check = connectivity_checks["auth"]
    checks.append(
        synthetic_check(
            "auth_boundary",
            "Auth boundary",
            "pass" if auth_check.status == "ready" else "warn",
            perf_counter(),
            auth_check.evidence,
            auth_check.action,
        )
    )

    ingest_check = connectivity_checks["ingest_key"]
    checks.append(
        synthetic_check(
            "ingest_key",
            "Ingest key scope",
            "pass" if ingest_check.status == "ready" else "fail",
            perf_counter(),
            ingest_check.evidence,
            ingest_check.action,
        )
    )

    started = perf_counter()
    if ingest_check.status == "ready":
        trace = Trace(
            id=f"tr_synth_{token_hex(6)}",
            timestamp=datetime.now().strftime("%H:%M:%S"),
            session=f"synthetic-{request.target}-{token_hex(3)}",
            environment="prod" if request.target == "production" else "staging",
            model="neuralops-synthetic-canary",
            tokens=32,
            latency="0.01s",
            cost="$0.000",
            status="success",
            score=1,
            prompt="Synthetic canary trace. No user prompt captured.",
            output="Synthetic trace roundtrip stored for operational readiness.",
            toolCalls="synthetic.trace_roundtrip",
            source="api",
            riskFlags=["synthetic-canary"],
        )
        save_scoped_record("traces", trace.id, trace.model_dump())
        trace_read = get_scoped_record("traces", trace.id)
        trace_status = "pass" if trace_read is not None else "fail"
        trace_evidence = f"Stored and read synthetic trace {trace.id}."
    else:
        trace_status = "fail"
        trace_evidence = "No scoped API key exists, so external trace ingest cannot be proven."
    checks.append(
        synthetic_check(
            "trace_roundtrip",
            "Trace roundtrip",
            trace_status,
            started,
            trace_evidence,
            "Create an ingest key and verify SDK/REST ingestion." if trace_status != "pass" else "No action required.",
        )
    )

    started = perf_counter()
    try:
        otel_trace, _ = normalize_otel_payload(
            {
                "spans": [
                    {
                        "traceId": f"otel-synthetic-{run_id}",
                        "spanId": "span-synthetic-root",
                        "name": "gen_ai.chat",
                        "operation": "chat",
                        "durationMs": 12,
                        "status": {"code": "ok"},
                        "attributes": {
                            "gen_ai.provider.name": "neuralops",
                            "gen_ai.request.model": "synthetic-canary",
                            "gen_ai.prompt": "Synthetic OTel prompt.",
                            "gen_ai.completion": "Synthetic OTel completion.",
                            "gen_ai.usage.input_tokens": 12,
                            "gen_ai.usage.output_tokens": 8,
                        },
                    }
                ]
            },
            "prod" if request.target == "production" else "staging",
        )
        otel_status = "pass"
        otel_evidence = f"Normalized {otel_trace.spanCount} GenAI span(s) into trace shape."
    except ValueError as exc:
        otel_status = "fail"
        otel_evidence = str(exc)
    checks.append(
        synthetic_check(
            "otel_normalization",
            "OpenTelemetry normalization",
            otel_status,
            started,
            otel_evidence,
            "Review OTel payload mapping and GenAI semantic conventions." if otel_status != "pass" else "No action required.",
        )
    )

    provider_check = connectivity_checks["provider_gateway"]
    checks.append(
        synthetic_check(
            "provider_gateway",
            "Provider gateway readiness",
            "pass" if provider_check.status == "ready" else "fail" if provider_check.status == "missing" else "warn",
            perf_counter(),
            provider_check.evidence,
            provider_check.action,
        )
    )

    webhook_check = connectivity_checks["webhook_delivery"]
    checks.append(
        synthetic_check(
            "webhook_delivery",
            "Webhook delivery readiness",
            "pass" if webhook_check.status == "ready" else "warn",
            perf_counter(),
            webhook_check.evidence,
            webhook_check.action,
        )
    )

    automation_check = connectivity_checks["automation_worker"]
    checks.append(
        synthetic_check(
            "automation_worker",
            "Automation worker readiness",
            "pass" if automation_check.status == "ready" else "warn",
            perf_counter(),
            automation_check.evidence,
            automation_check.action,
        )
    )

    failed = sum(check.status == "fail" for check in checks)
    warned = sum(check.status == "warn" for check in checks)
    passed = sum(check.status == "pass" for check in checks)
    decision = "block" if failed else "review" if warned else "allow"
    score = max(0, 100 - (failed * 24) - (warned * 8))
    result = SyntheticCanaryRun(
        id=run_id,
        target=request.target,
        decision=decision,
        score=score,
        checks=checks,
        summary={"passed": passed, "warned": warned, "failed": failed},
        generatedAt=datetime.now().isoformat(),
    )
    save_scoped_record("synthetic_runs", run_id, result.model_dump())
    save_audit_event(
        "synthetic.canary.run",
        current_workspace_id(),
        run_id,
        decision,
        f"Synthetic canary completed for {request.target}: {passed} pass, {warned} warn, {failed} fail.",
    )
    return result


def latest_synthetic_canary() -> SyntheticCanaryRun | None:
    runs = [SyntheticCanaryRun.model_validate(item) for item in scoped_records("synthetic_runs")]
    if not runs:
        return None
    return sorted(runs, key=lambda item: item.generatedAt, reverse=True)[0]


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "neuralops-api",
        "version": app.version,
        "storage": storage_backend(),
        "routesRevision": "synthetic-canary-v1",
    }


@app.get("/api/system/status", response_model=SystemStatus)
def system_status() -> SystemStatus:
    return build_system_status()


@app.get("/api/connectivity", response_model=ConnectivityMap)
def connectivity_map() -> ConnectivityMap:
    return build_connectivity_map()


@app.post("/api/synthetic/run", response_model=SyntheticCanaryRun)
def synthetic_canary_run(request: SyntheticCanaryRequest) -> SyntheticCanaryRun:
    return run_synthetic_canary(request)


@app.get("/api/synthetic/latest", response_model=SyntheticCanaryRun | None)
def synthetic_canary_latest() -> SyntheticCanaryRun | None:
    return latest_synthetic_canary()


@app.post("/api/release-gate/run", response_model=ReleaseGateResult)
def release_gate(request: ReleaseGateRequest) -> ReleaseGateResult:
    require_permission("release:gate", "release_gate.run")
    return run_release_gate(request)


@app.get("/api/release-gate/latest", response_model=ReleaseGateResult | None)
def release_gate_latest() -> ReleaseGateResult | None:
    return latest_release_gate()


@app.get("/api/release-gates", response_model=list[ReleaseGateDefinition])
def release_gates() -> list[ReleaseGateDefinition]:
    return list_release_gate_definitions()


@app.post("/api/release-gates", response_model=ReleaseGateDefinition)
def create_release_gate(request: ReleaseGateDefinitionCreate) -> ReleaseGateDefinition:
    require_permission("release:gate", "release_gate_definitions.create")
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
    require_permission("release:gate", gate_id)
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
    require_permission("release:gate", gate_id)
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
    require_permission("release:gate", gate_id)
    payload = get_scoped_record("release_gate_definitions", gate_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Release gate definition not found")
    return run_release_gate_definition(ReleaseGateDefinition.model_validate(payload), request)


@app.get("/api/evidence", response_model=EvidenceReport)
def evidence_report() -> EvidenceReport:
    return build_evidence_report()


@app.post("/api/evidence/export", response_model=EvidenceExportPack)
def evidence_export_pack() -> EvidenceExportPack:
    require_permission("release:gate", "evidence.export")
    return build_evidence_export_pack()


@app.post("/api/release-autopilot/run", response_model=ReleaseAutopilotResult)
def release_autopilot_run(request: ReleaseAutopilotRequest) -> ReleaseAutopilotResult:
    require_permission("release:gate", "release_autopilot.run")
    return run_release_autopilot(request)


@app.get("/api/release-autopilot/latest", response_model=ReleaseAutopilotResult | None)
def release_autopilot_latest() -> ReleaseAutopilotResult | None:
    return latest_release_autopilot()


@app.get("/api/automations", response_model=list[AutomationRule])
def automation_rules() -> list[AutomationRule]:
    return list_automation_rules()


@app.post("/api/automations", response_model=AutomationRule)
def create_automation_rule(request: AutomationRuleCreate) -> AutomationRule:
    require_permission("automation:write", "automation_rules.create")
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
    require_permission("automation:write", rule_id)
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
    require_permission("automation:write", rule_id)
    existing = get_scoped_record("automation_rules", rule_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Automation rule not found")
    rule = AutomationRule.model_validate(existing)
    if not rule.enabled:
        raise HTTPException(status_code=409, detail="Automation rule is disabled")
    return run_automation_rule(rule, request.subjectType, request.subjectId, request.decision, request.summary)


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


@app.post("/api/gateway/openai/v1/chat/completions")
def gateway_chat_completions(
    request: GatewayChatCompletionRequest,
    authorization: str | None = Header(default=None),
    neuralops_key: str | None = Header(default=None, alias="x-neuralops-key"),
) -> dict[str, Any]:
    api_key = authenticate_api_key(authorization, neuralops_key, "gateway:invoke")
    if request.stream:
        raise HTTPException(status_code=501, detail={"code": "streaming_not_implemented", "message": "NeuralOps Gateway supports non-streaming chat completions first."})

    environment = gateway_environment(request)
    prompt = gateway_messages_text(request.messages)
    started = datetime.now()
    routing_policy = gateway_routing_policy()
    requested_model = request.model
    estimated_cost = estimate_gateway_cost_usd(requested_model, prompt, request)
    actor = api_key.get("name", api_key.get("id", "gateway-key"))
    pre_policy = evaluate_gateway_policy("pre_policy", prompt)
    if pre_policy.decision == "block":
        trace = gateway_trace(
            request=request,
            environment=environment,
            provider=None,
            prompt=prompt,
            output="Blocked before provider call by NeuralOps Policy Gateway.",
            policy_decision=pre_policy,
            latency_ms=1,
            usage=None,
        )
        persist_gateway_trace(trace, pre_policy, actor)
        save_gateway_route_event(
            environment=environment,
            requested_model=request.model,
            status="blocked",
            decision=pre_policy.decision,
            attempts=[],
            trace_id=trace.id,
            findings=pre_policy.findings,
            routing_strategy=routing_policy.strategy,
            selected_reason="pre_policy",
            cache_status="disabled",
            budget_decision="allow",
            estimated_cost_usd=estimated_cost,
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="pre_policy",
            cache_status="disabled",
            budget_decision="allow",
            status="blocked",
            latency_ms=1,
            trace_id=trace.id,
            estimated_cost_usd=estimated_cost,
        )
        raise HTTPException(status_code=403, detail={"decision": pre_policy.decision, "stage": pre_policy.stage, "findings": pre_policy.findings, "reason": pre_policy.reason, "traceId": trace.id})

    providers = gateway_providers_for_environment(environment)
    if not providers:
        route_event = save_gateway_route_event(
            environment=environment,
            requested_model=requested_model,
            status="not_configured",
            decision="review",
            attempts=[],
            findings=[],
            routing_strategy=routing_policy.strategy,
            selected_reason="not_configured",
            cache_status="disabled",
            budget_decision="allow",
            estimated_cost_usd=estimated_cost,
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="not_configured",
            cache_status="disabled",
            budget_decision="allow",
            status="not_configured",
            latency_ms=1,
            route_event_id=route_event.id,
            estimated_cost_usd=estimated_cost,
        )
        raise HTTPException(status_code=503, detail={"code": "not_configured", "message": "No configured live provider is available for the NeuralOps Gateway."})

    ordered_providers = route_candidates(providers, request, prompt, routing_policy)
    if ordered_providers:
        estimated_cost = estimate_gateway_cost_usd(requested_model or ordered_providers[0].default_model, prompt, request)
    budget_decision, budget = gateway_budget_decision(environment, estimated_cost)
    if budget_decision == "hard_limit":
        route_event = save_gateway_route_event(
            environment=environment,
            requested_model=requested_model,
            status="budget_exceeded",
            decision="block",
            attempts=[],
            routing_strategy=routing_policy.strategy,
            selected_reason="budget_hard_limit",
            cache_status="disabled",
            budget_decision=budget_decision,
            estimated_cost_usd=estimated_cost,
            findings=[],
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="budget_hard_limit",
            cache_status="disabled",
            budget_decision=budget_decision,
            status="budget_exceeded",
            latency_ms=1,
            route_event_id=route_event.id,
            estimated_cost_usd=estimated_cost,
        )
        raise HTTPException(status_code=402, detail={"code": "budget_exceeded", "message": "Gateway budget hard limit would be exceeded before this provider call."})

    rate_allowed, rate_count = check_gateway_rate_limit(api_key, environment, routing_policy)
    if not rate_allowed:
        route_event = save_gateway_route_event(
            environment=environment,
            requested_model=requested_model,
            status="rate_limited",
            decision="block",
            attempts=[],
            routing_strategy=routing_policy.strategy,
            selected_reason="rate_limit",
            cache_status="disabled",
            budget_decision=budget_decision,
            estimated_cost_usd=estimated_cost,
            findings=[],
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="rate_limit",
            cache_status="disabled",
            budget_decision=budget_decision,
            status="rate_limited",
            latency_ms=1,
            route_event_id=route_event.id,
            estimated_cost_usd=estimated_cost,
        )
        raise HTTPException(status_code=429, detail={"code": "rate_limited", "message": "Gateway rate limit exceeded.", "count": rate_count})

    cache_key = gateway_cache_key(request, environment, prompt, routing_policy)
    cache_entry = gateway_cache_hit(cache_key) if routing_policy.cacheEnabled else None
    if cache_entry is not None:
        cached_payload = deepcopy(cache_entry.responsePayload)
        latency_ms = max(1, int((datetime.now() - started).total_seconds() * 1000))
        post_policy = evaluate_gateway_policy("post_policy", prompt, gateway_response_text(cached_payload))
        effective_policy = post_policy if post_policy.decision != "allow" else pre_policy
        trace = gateway_trace(
            request=request,
            environment=environment,
            provider=None,
            prompt=prompt,
            output=gateway_response_text(cached_payload) or "Cached provider response returned no text content.",
            policy_decision=effective_policy,
            latency_ms=latency_ms,
            usage={"total_tokens": cache_entry.promptTokens + cache_entry.completionTokens},
        )
        trace.toolCalls = "gateway.openai_chat -> exact_cache"
        persist_gateway_trace(trace, effective_policy, actor)
        route_event = save_gateway_route_event(
            environment=environment,
            requested_model=requested_model,
            status="routed",
            decision=effective_policy.decision,
            attempts=[],
            trace_id=trace.id,
            findings=effective_policy.findings,
            routing_strategy=routing_policy.strategy,
            selected_reason="cache_hit",
            cache_status="hit",
            budget_decision=budget_decision,
            estimated_cost_usd=0,
            actual_cost_usd=0,
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="cache_hit",
            cache_status="hit",
            budget_decision=budget_decision,
            status="routed",
            latency_ms=latency_ms,
            trace_id=trace.id,
            route_event_id=route_event.id,
            estimated_cost_usd=0,
            actual_cost_usd=0,
        )
        cached_payload["neuralops"] = {
            "decision": effective_policy.decision,
            "stage": effective_policy.stage,
            "findings": effective_policy.findings,
            "traceId": trace.id,
            "provider": {"id": "cache", "label": "Exact Gateway Cache", "source": "cache"},
            "router": {
                "routeEventId": route_event.id,
                "attempts": [],
                "retryCount": 0,
                "routingStrategy": routing_policy.strategy,
                "selectedReason": "cache_hit",
                "cacheStatus": "hit",
                "budgetDecision": budget_decision,
                "estimatedCostUsd": 0,
                "actualCostUsd": 0,
            },
        }
        return cached_payload

    provider, provider_payload, route_attempts = route_gateway_provider(providers, request, prompt, routing_policy)
    if provider is None or provider_payload is None:
        route_event = save_gateway_route_event(
            environment=environment,
            requested_model=requested_model,
            status="failed",
            decision="review",
            attempts=route_attempts,
            findings=[],
            routing_strategy=routing_policy.strategy,
            selected_reason="provider_route_failed",
            cache_status="miss" if routing_policy.cacheEnabled else "disabled",
            budget_decision=budget_decision,
            estimated_cost_usd=estimated_cost,
        )
        save_gateway_request_log(
            environment=environment,
            requested_model=requested_model,
            routing_policy=routing_policy,
            selected_reason="provider_route_failed",
            cache_status="miss" if routing_policy.cacheEnabled else "disabled",
            budget_decision=budget_decision,
            status="failed",
            latency_ms=max(1, int((datetime.now() - started).total_seconds() * 1000)),
            route_event_id=route_event.id,
            estimated_cost_usd=estimated_cost,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "code": "provider_route_failed",
                "message": "All configured NeuralOps Gateway providers failed.",
                "attempts": [gateway_route_response_attempt(attempt) for attempt in route_attempts],
            },
        )

    output = gateway_response_text(provider_payload)
    latency_ms = max(1, int((datetime.now() - started).total_seconds() * 1000))
    post_policy = evaluate_gateway_policy("post_policy", prompt, output)
    usage = provider_payload.get("usage") if isinstance(provider_payload.get("usage"), dict) else None
    actual_cost = actual_gateway_cost_usd(requested_model or provider.default_model, usage)
    trace = gateway_trace(
        request=request,
        environment=environment,
        provider=provider,
        prompt=prompt,
        output=output or "Provider returned no text content.",
        policy_decision=post_policy if post_policy.findings else pre_policy,
        latency_ms=latency_ms,
        usage=usage,
    )
    effective_policy = post_policy if post_policy.decision != "allow" else pre_policy
    persist_gateway_trace(trace, effective_policy, actor)
    selected_reason = gateway_selected_reason(routing_policy, provider)
    route_event = save_gateway_route_event(
        environment=environment,
        requested_model=requested_model,
        status="routed",
        decision=effective_policy.decision,
        attempts=route_attempts,
        selected_provider=provider,
        trace_id=trace.id,
        findings=effective_policy.findings,
        routing_strategy=routing_policy.strategy,
        selected_reason=selected_reason,
        cache_status="miss" if routing_policy.cacheEnabled else "disabled",
        budget_decision=budget_decision,
        estimated_cost_usd=estimated_cost,
        actual_cost_usd=actual_cost,
    )
    save_gateway_request_log(
        environment=environment,
        requested_model=requested_model,
        routing_policy=routing_policy,
        selected_reason=selected_reason,
        cache_status="miss" if routing_policy.cacheEnabled else "disabled",
        budget_decision=budget_decision,
        status="routed",
        latency_ms=latency_ms,
        selected_provider=provider,
        trace_id=trace.id,
        route_event_id=route_event.id,
        estimated_cost_usd=estimated_cost,
        actual_cost_usd=actual_cost,
    )
    add_gateway_budget_spend(budget, actual_cost if actual_cost is not None else estimated_cost)
    if routing_policy.cacheEnabled and effective_policy.decision == "allow":
        save_gateway_cache_entry(cache_key, environment, requested_model or provider.default_model, provider_payload, usage, actual_cost, routing_policy)
    if post_policy.decision == "block":
        raise HTTPException(status_code=403, detail={"decision": post_policy.decision, "stage": post_policy.stage, "findings": post_policy.findings, "reason": post_policy.reason, "traceId": trace.id})

    provider_payload["neuralops"] = {
        "decision": effective_policy.decision,
        "stage": effective_policy.stage,
        "findings": effective_policy.findings,
        "traceId": trace.id,
        "provider": {"id": provider.id, "label": provider.label, "source": provider.source},
        "router": {
            "routeEventId": route_event.id,
            "attempts": [gateway_route_response_attempt(attempt) for attempt in route_attempts],
            "retryCount": route_event.retryCount,
            "routingStrategy": routing_policy.strategy,
            "selectedReason": selected_reason,
            "cacheStatus": "miss" if routing_policy.cacheEnabled else "disabled",
            "budgetDecision": budget_decision,
            "estimatedCostUsd": estimated_cost,
            "actualCostUsd": actual_cost,
        },
    }
    return provider_payload


@app.get("/api/gateway/routes", response_model=list[GatewayRouteEvent])
def gateway_routes() -> list[GatewayRouteEvent]:
    return gateway_route_events()


@app.get("/api/gateway/metrics", response_model=GatewayMetrics)
def gateway_metrics_endpoint() -> GatewayMetrics:
    return gateway_metrics()


@app.get("/api/gateway/requests", response_model=list[GatewayRequestLog])
def gateway_requests() -> list[GatewayRequestLog]:
    return gateway_request_logs()


@app.get("/api/gateway/cost-suggestions", response_model=list[GatewayCostSuggestion])
def gateway_cost_suggestions_endpoint() -> list[GatewayCostSuggestion]:
    return gateway_cost_suggestions()


@app.get("/api/gateway/routing-policy", response_model=GatewayRoutingPolicy)
def get_gateway_routing_policy() -> GatewayRoutingPolicy:
    return gateway_routing_policy()


@app.put("/api/gateway/routing-policy", response_model=GatewayRoutingPolicy)
def update_gateway_routing_policy(request: dict[str, Any]) -> GatewayRoutingPolicy:
    require_permission("gateway:operate", "gateway_routing_policy.update")
    return save_gateway_routing_policy(request)


@app.get("/api/gateway/budgets", response_model=list[GatewayBudget])
def get_gateway_budgets() -> list[GatewayBudget]:
    return gateway_budgets()


@app.post("/api/gateway/budgets", response_model=GatewayBudget)
def create_gateway_budget(request: dict[str, Any]) -> GatewayBudget:
    require_permission("gateway:operate", "gateway_budget.create")
    return save_gateway_budget(request)


@app.patch("/api/gateway/budgets/{budget_id}", response_model=GatewayBudget)
def update_gateway_budget(budget_id: str, request: dict[str, Any]) -> GatewayBudget:
    require_permission("gateway:operate", budget_id)
    return patch_gateway_budget(budget_id, request)


@app.post("/api/gateway/cache/clear")
def clear_gateway_cache() -> dict[str, Any]:
    require_permission("gateway:operate", "gateway_cache.clear")
    entries = scoped_records("gateway_cache_entries")
    for entry in entries:
        delete_scoped_record("gateway_cache_entries", str(entry.get("id")))
    save_audit_event("gateway.cache.clear", "operator", "gateway_cache_entries", "allow", f"Cleared {len(entries)} gateway cache entrie(s).")
    return {"cleared": len(entries)}


@app.get("/api/dashboard", response_model=DashboardSnapshot)
def dashboard() -> DashboardSnapshot:
    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    incidents = [Incident.model_validate(item) for item in scoped_records("incidents")]
    stats = build_stats(traces, incidents)
    return DashboardSnapshot(stats=stats, traces=traces[:50], incidents=incidents)


@app.get("/api/traces", response_model=list[Trace])
def traces() -> list[Trace]:
    return [Trace.model_validate(item) for item in scoped_records("traces")]


def build_ingested_trace(request: TraceIngestRequest) -> Trace:
    now = datetime.now()
    return Trace(
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


def trace_ingest_decision(trace: Trace) -> str:
    return "block" if trace.status == "blocked" else "review" if trace.status in {"warning", "failed"} else "allow"


def ingest_trace_payload(request: TraceIngestRequest) -> TraceIngestResponse:
    if request.idempotencyKey:
        existing = get_scoped_record("trace_idempotency", request.idempotencyKey)
        if existing is not None:
            trace_payload = get_scoped_record("traces", existing["traceId"])
            if trace_payload is not None:
                return TraceIngestResponse(
                    trace=Trace.model_validate(trace_payload),
                    auditId=existing.get("auditId", "duplicate"),
                    accepted=False,
                    idempotencyKey=request.idempotencyKey,
                )

    trace = build_ingested_trace(request)
    save_scoped_record("traces", trace.id, trace.model_dump())
    trigger_trace_automations(trace)
    return TraceIngestResponse(trace=trace, auditId="", accepted=True, idempotencyKey=request.idempotencyKey)


@app.post("/api/traces/batch", response_model=TraceBatchIngestResponse)
def ingest_trace_batch(
    request: TraceBatchIngestRequest,
    authorization: str | None = Header(default=None),
    neuralops_key: str | None = Header(default=None, alias="x-neuralops-key"),
) -> TraceBatchIngestResponse:
    api_key = authenticate_api_key(authorization, neuralops_key)
    items: list[TraceIngestResponse] = []
    seen_by_key: dict[str, TraceIngestResponse] = {}
    for trace_request in request.traces:
        if trace_request.idempotencyKey and trace_request.idempotencyKey in seen_by_key:
            original = seen_by_key[trace_request.idempotencyKey]
            items.append(
                TraceIngestResponse(
                    trace=original.trace,
                    auditId=original.auditId,
                    accepted=False,
                    idempotencyKey=trace_request.idempotencyKey,
                )
            )
            continue
        item = ingest_trace_payload(trace_request)
        items.append(item)
        if trace_request.idempotencyKey and item.accepted:
            seen_by_key[trace_request.idempotencyKey] = item
    accepted = sum(1 for item in items if item.accepted)
    duplicates = len(items) - accepted
    worst_decision = "allow"
    for item in items:
        decision = trace_ingest_decision(item.trace)
        if decision == "block":
            worst_decision = "block"
            break
        if decision == "review":
            worst_decision = "review"
    audit = save_audit_event(
        "trace.batch_ingest",
        api_key.get("name", api_key.get("id", "api-key")),
        f"{accepted} accepted trace(s), {duplicates} duplicate trace(s)",
        worst_decision,
        f"Batch ingested {len(items)} trace envelope(s).",
    )
    for item in items:
        item.auditId = audit.id
        if item.accepted and item.idempotencyKey:
            save_scoped_record(
                "trace_idempotency",
                item.idempotencyKey,
                {
                    "idempotencyKey": item.idempotencyKey,
                    "traceId": item.trace.id,
                    "auditId": audit.id,
                    "workspaceId": current_workspace_id(),
                    "createdAt": datetime.now().isoformat(),
                },
            )
    return TraceBatchIngestResponse(items=items, accepted=accepted, duplicates=duplicates, auditId=audit.id)


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
    result = ingest_trace_payload(request)
    decision = trace_ingest_decision(result.trace)
    audit = save_audit_event(
        "trace.ingest",
        api_key.get("name", api_key.get("id", "api-key")),
        result.trace.id,
        decision,
        f"Ingested {result.trace.model} trace for session {result.trace.session}."
        if result.accepted
        else f"Accepted duplicate retry for trace {result.trace.id}.",
    )
    result.auditId = audit.id
    if result.accepted and request.idempotencyKey:
        save_scoped_record(
            "trace_idempotency",
            request.idempotencyKey,
            {
                "idempotencyKey": request.idempotencyKey,
                "traceId": result.trace.id,
                "auditId": audit.id,
                "workspaceId": current_workspace_id(),
                "createdAt": datetime.now().isoformat(),
            },
        )
    return result


@app.post("/api/traces/{trace_id}/replay", response_model=ReplayResult)
def replay_existing_trace(trace_id: str) -> ReplayResult:
    trace = get_scoped_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return replay_trace(trace)


@app.post("/api/traces/{trace_id}/replay-gate", response_model=ReplayGateResult)
def replay_gate_trace(trace_id: str, request: ReplayGateRequest) -> ReplayGateResult:
    require_permission("release:gate", trace_id)
    trace = get_scoped_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return run_trace_replay_gate(Trace.model_validate(trace), request)


@app.post("/api/replay-gate/dataset/run", response_model=ReplayDatasetGateResult)
def replay_gate_dataset(request: ReplayDatasetGateRequest) -> ReplayDatasetGateResult:
    require_permission("release:gate", "replay_gate.dataset")
    return run_dataset_replay_gate(request)


@app.post("/api/traces/simulate", response_model=Trace)
def simulate_trace() -> Trace:
    raise HTTPException(status_code=410, detail="Random trace simulation is disabled in real-data mode")


def trace_risk_text(trace: Trace) -> str:
    return " ".join(
        [
            trace.prompt,
            trace.output,
            trace.toolCalls or "",
            " ".join(trace.riskFlags),
            trace.status,
        ]
    ).lower()


def classify_detection_trace(trace: Trace) -> dict[str, Any]:
    text = trace_risk_text(trace)
    prompt_injection_terms = ["ignore previous", "ignore standard", "jailbreak", "developer message", "system prompt"]
    secret_terms = ["api key", "password", "secret", "token", "credential", "private key"]
    external_terms = ["webhook", "external", "slack", "email", "http://", "https://", "post"]
    tool_terms = ["shell", "delete", "write", "github", "browser", "tool"]

    matched = {
        "promptInjection": [term for term in prompt_injection_terms if term in text],
        "secretExposure": [term for term in secret_terms if term in text],
        "externalSink": [term for term in external_terms if term in text],
        "toolAction": [term for term in tool_terms if term in text],
        "riskFlags": trace.riskFlags,
    }
    has_prompt_injection = bool(matched["promptInjection"])
    has_secret = bool(matched["secretExposure"])
    has_external_sink = bool(matched["externalSink"])
    has_tool_action = bool(matched["toolAction"])
    low_score = trace.score < 0.8
    failed = trace.status in {"failed", "blocked", "warning"}

    if trace.status == "blocked" or (has_secret and has_external_sink) or (has_prompt_injection and has_tool_action):
        decision = "block"
        severity = "Critical"
    elif failed or low_score or has_external_sink or has_tool_action:
        decision = "review"
        severity = "Major"
    else:
        decision = "allow"
        severity = "Low"

    if has_prompt_injection and has_secret and has_external_sink:
        root_cause = "Prompt injection attempted credential exfiltration through an external sink."
    elif has_secret and has_external_sink:
        root_cause = "Credential exfiltration risk: sensitive data was paired with an external destination."
    elif has_prompt_injection:
        root_cause = "Prompt injection or instruction override attempt was detected in the trace payload."
    elif trace.status in {"failed", "warning"} or low_score:
        root_cause = "Runtime quality, latency, or policy signal requires operator review."
    else:
        root_cause = "No high-risk runtime chain was detected from the available trace evidence."

    blast_radius = ["Agent runtime", f"{trace.environment} traces", f"Model: {trace.model}"]
    if has_external_sink:
        blast_radius.append("External connector or webhook boundary")
    if has_secret:
        blast_radius.append("Credential and API key handling")
    if has_tool_action:
        blast_radius.append("Tool execution policy")
    if has_prompt_injection:
        blast_radius.append("Prompt registry and guardrail policy")

    recommended_actions = []
    if has_secret:
        recommended_actions.append("Rotate any exposed API keys, tokens, or credentials referenced by this workflow.")
    if has_external_sink:
        recommended_actions.append("Disable external connector delivery for this workflow until an owner reviews the trace.")
    if has_prompt_injection:
        recommended_actions.append("Run Release Autopilot with explicit prompt-injection and secret-exfiltration controls.")
    if has_tool_action:
        recommended_actions.append("Require human approval for shell, write, browser, GitHub, and external-post tool calls.")
    if failed or low_score:
        recommended_actions.append("Create or attach an incident and rerun the affected prompt/model through the release gate.")
    if not recommended_actions:
        recommended_actions.append("Keep monitoring the workflow; no containment is required from current evidence.")

    return {
        "decision": decision,
        "severity": severity,
        "rootCause": root_cause,
        "blastRadius": list(dict.fromkeys(blast_radius)),
        "recommendedActions": list(dict.fromkeys(recommended_actions)),
        "matched": matched,
    }


def build_detection_case(trace: Trace, owner: str) -> DetectionCase:
    now = datetime.now().isoformat()
    analysis = classify_detection_trace(trace)
    case_id = f"adr_{sha256(trace.id.encode('utf-8')).hexdigest()[:12]}"
    existing = get_scoped_record("detections", case_id)
    created_at = existing.get("createdAt", now) if existing else now
    status = existing.get("status", "open") if existing else "open"
    containment_actions = existing.get("containmentActions", []) if existing else []
    existing_evidence = existing.get("evidence", {}) if existing else {}
    evidence = {
        **existing_evidence,
        "trace": {
            "id": trace.id,
            "session": trace.session,
            "environment": trace.environment,
            "model": trace.model,
            "status": trace.status,
            "score": trace.score,
            "latency": trace.latency,
            "cost": trace.cost,
            "riskFlags": trace.riskFlags,
            "toolCalls": trace.toolCalls,
        },
        "matchedSignals": analysis["matched"],
        "workspaceId": current_workspace_id(),
    }
    timeline = [
        {
            "time": trace.timestamp,
            "title": "Trace recorded",
            "detail": f"{trace.model} returned {trace.status} with score {trace.score:.2f}.",
        },
        {
            "time": now,
            "title": "Detection analysis completed",
            "detail": analysis["rootCause"],
        },
    ]
    if existing and existing.get("timeline"):
        preserved = [item for item in existing["timeline"] if item.get("title") not in {"Trace recorded", "Detection analysis completed"}]
        timeline.extend(preserved)

    return DetectionCase(
        id=case_id,
        title=f"{analysis['severity']} detection: {analysis['rootCause']}",
        severity=analysis["severity"],
        decision=analysis["decision"],
        status=status,
        sourceType="trace",
        sourceTraceId=trace.id,
        createdAt=created_at,
        updatedAt=now,
        owner=owner,
        rootCause=analysis["rootCause"],
        blastRadius=analysis["blastRadius"],
        timeline=timeline,
        recommendedActions=analysis["recommendedActions"],
        containmentActions=containment_actions,
        evidence=evidence,
    )


def risky_trace_sort_key(trace: Trace) -> tuple[int, float, str]:
    status_weight = {"blocked": 4, "failed": 3, "warning": 2, "success": 1}[trace.status]
    risk_flag_weight = 1 if trace.riskFlags else 0
    return (status_weight + risk_flag_weight, 1 - trace.score, trace.timestamp)


@app.get("/api/detections", response_model=list[DetectionCase])
def detection_cases() -> list[DetectionCase]:
    cases = [DetectionCase.model_validate(item) for item in scoped_records("detections")]
    return sorted(cases, key=lambda item: item.updatedAt, reverse=True)


@app.post("/api/detections/analyze-trace/{trace_id}", response_model=DetectionCase)
def analyze_trace_detection(trace_id: str, request: DetectionCaseCreateRequest) -> DetectionCase:
    trace_payload = get_scoped_record("traces", trace_id)
    if trace_payload is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    trace = Trace.model_validate(trace_payload)
    detection_case = build_detection_case(trace, request.owner)
    save_scoped_record("detections", detection_case.id, detection_case.model_dump())
    save_audit_event(
        "detection.case.create",
        request.owner,
        detection_case.id,
        detection_case.decision,
        f"Analyzed trace {trace.id}: {detection_case.rootCause}",
    )
    return detection_case


@app.post("/api/detections/analyze-latest", response_model=DetectionCase)
def analyze_latest_detection(request: DetectionCaseCreateRequest) -> DetectionCase:
    traces = [Trace.model_validate(item) for item in scoped_records("traces")]
    risky_traces = [
        trace
        for trace in traces
        if trace.status in {"blocked", "failed", "warning"} or trace.score < 0.8 or trace.riskFlags
    ]
    if not risky_traces:
        raise HTTPException(status_code=404, detail="No risky trace is available to analyze")
    trace = sorted(risky_traces, key=risky_trace_sort_key, reverse=True)[0]
    detection_case = build_detection_case(trace, request.owner)
    save_scoped_record("detections", detection_case.id, detection_case.model_dump())
    save_audit_event(
        "detection.case.create",
        request.owner,
        detection_case.id,
        detection_case.decision,
        f"Analyzed latest risky trace {trace.id}: {detection_case.rootCause}",
    )
    return detection_case


@app.patch("/api/detections/{case_id}/action", response_model=DetectionCase)
def detection_case_action(case_id: str, request: DetectionActionRequest) -> DetectionCase:
    require_permission("incident:write", case_id)
    payload = get_scoped_record("detections", case_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Detection case not found")
    detection_case = DetectionCase.model_validate(payload)
    now = datetime.now().isoformat()
    evidence = {**detection_case.evidence}
    containment_actions = list(detection_case.containmentActions)
    timeline = list(detection_case.timeline)

    if request.action == "contain":
        incident_id = evidence.get("containment", {}).get("incidentId") or f"inc_adr_{token_hex(5)}"
        incident = Incident(
            id=incident_id,
            title=f"ADR containment: {detection_case.rootCause}",
            severity=detection_case.severity,
            status="Investigating",
            time="current",
            owner=detection_case.owner,
        )
        save_scoped_record("incidents", incident.id, incident.model_dump())
        note = request.note or "Containment recorded from Detection & Response."
        containment_actions.append(note)
        evidence["containment"] = {
            "incidentId": incident.id,
            "note": note,
            "createdAt": now,
        }
        status = "contained"
        event_type = "detection.case.contain"
        summary = f"Contained detection case and opened incident {incident.id}."
    elif request.action == "close":
        note = request.note or "Case closed by operator."
        containment_actions.append(note)
        evidence["closure"] = {"note": note, "createdAt": now}
        status = "closed"
        event_type = "detection.case.close"
        summary = "Closed detection case."
    else:
        note = request.note or "Case reopened by operator."
        containment_actions.append(note)
        evidence["reopen"] = {"note": note, "createdAt": now}
        status = "open"
        event_type = "detection.case.reopen"
        summary = "Reopened detection case."

    timeline.append(
        {
            "time": now,
            "title": f"Case {status}",
            "detail": containment_actions[-1],
        }
    )
    updated = detection_case.model_copy(
        update={
            "status": status,
            "updatedAt": now,
            "timeline": timeline,
            "containmentActions": containment_actions,
            "evidence": evidence,
        }
    )
    save_scoped_record("detections", updated.id, updated.model_dump())
    save_audit_event(event_type, updated.owner, updated.id, updated.decision, summary)
    return updated


@app.get("/api/incidents", response_model=list[Incident])
def incidents() -> list[Incident]:
    return [Incident.model_validate(item) for item in scoped_records("incidents")]


@app.patch("/api/incidents/{incident_id}", response_model=Incident)
def patch_incident(incident_id: str, patch: IncidentPatch) -> Incident:
    require_permission("incident:write", incident_id)
    updated = update_scoped_record("incidents", incident_id, patch.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return Incident.model_validate(updated)


@app.get("/api/prompts", response_model=list[PromptVersion])
def prompts() -> list[PromptVersion]:
    return [PromptVersion.model_validate(item) for item in scoped_records("prompts")]


@app.post("/api/prompts/{prompt_id}/deploy", response_model=PromptVersion)
def deploy_prompt(prompt_id: str) -> PromptVersion:
    require_permission("release:gate", prompt_id)
    prompt = get_scoped_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["status"] = "Production"
    prompt["canaryPercent"] = 100
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_scoped_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/traffic", response_model=PromptVersion)
def update_prompt_traffic(prompt_id: str, request: PromptTrafficUpdate) -> PromptVersion:
    require_permission("release:gate", prompt_id)
    prompt = get_scoped_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["canaryPercent"] = request.canaryPercent
    prompt["status"] = "Production" if request.canaryPercent == 100 else "Canary"
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_scoped_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/rollback", response_model=PromptVersion)
def rollback_prompt(prompt_id: str) -> PromptVersion:
    require_permission("release:gate", prompt_id)
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
    require_permission("release:gate", "evals.run")
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
    require_permission("release:gate", request.queryId)
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
    require_permission("gateway:operate", "costs.budget")
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
    require_permission("policy:write", policy_id)
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
    require_permission("provider:write", "provider_connections.create")
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
    require_permission("provider:write", connection_id)
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
    require_permission("gateway:operate", "agent_runtime.run")
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
    require_permission("release:gate", "labs.run")
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
    require_permission("gateway:operate", "agent_jobs.submit")
    return AgentJobSubmitResponse(job=submit_job(request))


@app.post("/api/agent-runtime/jobs/process-next", response_model=AgentJobProcessResponse)
def process_next_agent_job() -> AgentJobProcessResponse:
    require_permission("gateway:operate", "agent_jobs.process_next")
    result = process_next_job()
    if result is None:
        raise HTTPException(status_code=404, detail="No queued agent jobs")
    return result


@app.post("/api/agent-runtime/jobs/{job_id}/process", response_model=AgentJobProcessResponse)
def process_agent_job(job_id: str) -> AgentJobProcessResponse:
    require_permission("gateway:operate", job_id)
    result = process_job(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return result


@app.post("/api/agent-runtime/jobs/{job_id}/retry", response_model=AgentJob)
def retry_agent_job(job_id: str) -> AgentJob:
    require_permission("gateway:operate", job_id)
    job = retry_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return job


@app.post("/api/agent-runtime/jobs/{job_id}/cancel", response_model=AgentJob)
def cancel_agent_job(job_id: str) -> AgentJob:
    require_permission("gateway:operate", job_id)
    job = cancel_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Agent job not found")
    return job


@app.get("/api/onboarding", response_model=OnboardingStatus)
def onboarding_status() -> OnboardingStatus:
    return build_onboarding_status()


@app.post("/api/onboarding/bootstrap", response_model=OnboardingStatus)
def onboarding_bootstrap() -> OnboardingStatus:
    ensure_workspace_bootstrap()
    return build_onboarding_status()


@app.get("/api/production/readiness", response_model=ProductionReadinessReport)
def production_readiness() -> ProductionReadinessReport:
    return build_production_readiness()


@app.get("/api/access/policy", response_model=AccessPolicyMatrix)
def access_policy() -> AccessPolicyMatrix:
    ensure_workspace_bootstrap()
    roles = {
        role: AccessRolePolicy(
            role=role,
            permissions=list(permissions),
            description=ROLE_DESCRIPTIONS[role],
        )
        for role, permissions in ROLE_PERMISSIONS.items()
    }
    return AccessPolicyMatrix(
        workspaceId=current_workspace_id(),
        currentUser=current_access_user(),
        roles=roles,
        generatedAt=datetime.now().isoformat(),
    )


@app.post("/api/access/check", response_model=AccessCheckResult)
def access_check(request: AccessCheckRequest) -> AccessCheckResult:
    return access_check_result(request.permission, request.subject)


@app.get("/api/access/audit", response_model=list[AuditEvent])
def access_audit() -> list[AuditEvent]:
    events = [
        AuditEvent.model_validate(item)
        for item in scoped_records("audit")
        if str(item.get("type", "")).startswith("access.")
    ]
    return sorted(events, key=lambda item: item.createdAt, reverse=True)


@app.get("/api/workspace", response_model=WorkspaceProfile)
def workspace_profile() -> WorkspaceProfile:
    return WorkspaceProfile.model_validate(ensure_workspace_bootstrap())


@app.get("/api/workspace/invites", response_model=list[WorkspaceInvite])
def workspace_invites() -> list[WorkspaceInvite]:
    return [
        WorkspaceInvite.model_validate(refresh_invite_status(invite))
        for invite in workspace_invites_payload()
    ]


@app.post("/api/workspace/invites", response_model=WorkspaceInvite)
def create_workspace_invite(request: WorkspaceInviteCreateRequest) -> WorkspaceInvite:
    require_permission("workspace:write", "workspace_invites.create")
    normalized_email = request.email.strip().lower()
    now = datetime.now()
    invite = WorkspaceInvite(
        id=f"wsi_{token_hex(5)}",
        workspaceId=current_workspace_id(),
        email=normalized_email,
        role=request.role,
        token=f"wsi_{token_hex(18)}",
        status="pending",
        invitedBy=current_user_email(),
        createdAt=now.isoformat(),
        expiresAt=(now + timedelta(hours=request.expiresInHours)).isoformat(),
    )
    save_record("workspace_invites", invite.id, invite.model_dump())
    save_audit_event(
        "workspace.invite.create",
        current_user_email(),
        normalized_email,
        "allow",
        f"Invited {normalized_email} as {request.role}.",
    )
    return invite


@app.post("/api/workspace/invites/{invite_token}/accept", response_model=WorkspaceInviteAcceptResult)
def accept_workspace_invite(invite_token: str) -> WorkspaceInviteAcceptResult:
    payload = workspace_invite_by_token(invite_token)
    if payload is None:
        raise HTTPException(status_code=404, detail="Workspace invite not found")
    payload = refresh_invite_status(payload)
    invite = WorkspaceInvite.model_validate(payload)
    if invite.status != "pending":
        raise HTTPException(status_code=409, detail=f"Workspace invite is {invite.status}")
    if invite.email.lower() != current_user_email():
        raise HTTPException(
            status_code=403,
            detail={
                "code": "invite_email_mismatch",
                "message": "This invite belongs to a different authenticated email address.",
            },
        )
    member = workspace_member_from_invite(invite)
    invite.status = "accepted"
    invite.acceptedAt = datetime.now().isoformat()
    save_record("workspace_invites", invite.id, invite.model_dump())
    save_audit_event(
        "workspace.invite.accept",
        current_user_email(),
        invite.workspaceId,
        "allow",
        f"Accepted workspace invite for {invite.workspaceId}.",
    )
    return WorkspaceInviteAcceptResult(workspaceId=invite.workspaceId, member=member, invite=invite)


@app.get("/api/workspace/members", response_model=list[WorkspaceMember])
def workspace_members() -> list[WorkspaceMember]:
    return [WorkspaceMember.model_validate(member) for member in workspace_members_payload()]


@app.post("/api/workspace/members", response_model=WorkspaceMember)
def create_workspace_member(request: WorkspaceMemberCreateRequest) -> WorkspaceMember:
    require_permission("workspace:write", "workspace_members.create")
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
    require_permission("workspace:write", member_id)
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
    require_permission("workspace:write", member_id)
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
    require_permission("settings:write", "settings.api_keys")
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
    require_permission("settings:write", "settings.webhooks")
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
    require_permission("settings:write", "settings.retention")
    with SETTINGS_WRITE_LOCK:
        payload = settings_payload_or_404()
        payload["retentionDays"] = request.retentionDays
        saved = save_record("settings", settings_record_id(), payload)
    return SettingsPayload.model_validate(public_settings_payload(saved))


@app.get("/api/audit", response_model=list[AuditEvent])
def audit_events() -> list[AuditEvent]:
    return [AuditEvent.model_validate(item) for item in scoped_records("audit")]
