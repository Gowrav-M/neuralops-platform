from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from hashlib import sha256
from secrets import compare_digest, token_hex
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .database import get_record, init_db, list_records, save_record, storage_backend, update_record
from .agent_runtime import AGENT_DEFINITIONS, list_providers, run_agent
from .job_queue import cancel_job, get_job, list_jobs, process_job, process_next_job, queue_summary, retry_job, submit_job
from .metrics import build_stats
from .otel import normalize_otel_payload, replay_trace
from .schemas import (
    AgentJob,
    AgentJobProcessResponse,
    AgentJobSubmitRequest,
    AgentJobSubmitResponse,
    AgentRuntime,
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    AuditEvent,
    AgentDefinition,
    AgentRunRecord,
    AgentRunRequest,
    AgentRunResponse,
    DashboardSnapshot,
    Evaluator,
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
    PromptTrafficUpdate,
    ProviderStatus,
    PromptVersion,
    RagRetrievalTestRequest,
    RagQuery,
    ReplayResult,
    SettingsPayload,
    Stats,
    Trace,
    TraceIngestRequest,
    TraceIngestResponse,
    RetentionUpdateRequest,
    WebhookCreateRequest,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="NeuralOps Platform API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def hash_token(token: str) -> str:
    return sha256(token.encode("utf-8")).hexdigest()


def settings_payload_or_404() -> dict[str, Any]:
    payload = get_record("settings", "current")
    if payload is None:
        raise HTTPException(status_code=404, detail="Settings not found")
    return payload


def public_settings_payload(payload: dict[str, Any]) -> dict[str, Any]:
    public_payload = {**payload}
    public_payload["apiKeys"] = [
        {key: value for key, value in api_key.items() if key != "tokenHash"}
        for api_key in payload.get("apiKeys", [])
    ]
    return public_payload


def token_from_headers(authorization: str | None, neuralops_key: str | None) -> str:
    if neuralops_key:
        return neuralops_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    raise HTTPException(status_code=401, detail="Missing NeuralOps API key")


def authenticate_api_key(authorization: str | None, neuralops_key: str | None) -> dict[str, Any]:
    token = token_from_headers(authorization, neuralops_key)
    token_hash = hash_token(token)
    settings_payload = settings_payload_or_404()
    for api_key in settings_payload.get("apiKeys", []):
        stored_hash = api_key.get("tokenHash")
        if stored_hash and compare_digest(stored_hash, token_hash):
            return api_key
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
    save_record("audit", event.id, event.model_dump())
    return event


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "neuralops-api", "version": app.version, "storage": storage_backend()}


@app.get("/api/dashboard", response_model=DashboardSnapshot)
def dashboard() -> DashboardSnapshot:
    traces = [Trace.model_validate(item) for item in list_records("traces")]
    incidents = [Incident.model_validate(item) for item in list_records("incidents")]
    stats = build_stats(traces, incidents)
    return DashboardSnapshot(stats=stats, traces=traces[:50], incidents=incidents)


@app.get("/api/traces", response_model=list[Trace])
def traces() -> list[Trace]:
    return [Trace.model_validate(item) for item in list_records("traces")]


@app.get("/api/traces/{trace_id}", response_model=Trace)
def trace_detail(trace_id: str) -> Trace:
    trace = get_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return Trace.model_validate(trace)


@app.post("/api/traces/otel", response_model=OtelIngestResult)
def ingest_otel_trace(request: OtelIngestRequest) -> OtelIngestResult:
    try:
        trace, findings = normalize_otel_payload(request.payload, request.environment)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    save_record("traces", trace.id, trace.model_dump())
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
    save_record("traces", trace.id, trace.model_dump())
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
    trace = get_record("traces", trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return replay_trace(trace)


@app.post("/api/traces/simulate", response_model=Trace)
def simulate_trace() -> Trace:
    raise HTTPException(status_code=410, detail="Random trace simulation is disabled in real-data mode")


@app.get("/api/incidents", response_model=list[Incident])
def incidents() -> list[Incident]:
    return [Incident.model_validate(item) for item in list_records("incidents")]


@app.patch("/api/incidents/{incident_id}", response_model=Incident)
def patch_incident(incident_id: str, patch: IncidentPatch) -> Incident:
    updated = update_record("incidents", incident_id, patch.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return Incident.model_validate(updated)


@app.get("/api/prompts", response_model=list[PromptVersion])
def prompts() -> list[PromptVersion]:
    return [PromptVersion.model_validate(item) for item in list_records("prompts")]


@app.post("/api/prompts/{prompt_id}/deploy", response_model=PromptVersion)
def deploy_prompt(prompt_id: str) -> PromptVersion:
    prompt = get_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["status"] = "Production"
    prompt["canaryPercent"] = 100
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/traffic", response_model=PromptVersion)
def update_prompt_traffic(prompt_id: str, request: PromptTrafficUpdate) -> PromptVersion:
    prompt = get_record("prompts", prompt_id)
    if prompt is None:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt["canaryPercent"] = request.canaryPercent
    prompt["status"] = "Production" if request.canaryPercent == 100 else "Canary"
    prompt["updatedAt"] = datetime.now().isoformat()
    return PromptVersion.model_validate(save_record("prompts", prompt_id, prompt))


@app.post("/api/prompts/{prompt_id}/rollback", response_model=PromptVersion)
def rollback_prompt(prompt_id: str) -> PromptVersion:
    prompt = get_record("prompts", prompt_id)
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
    return PromptVersion.model_validate(save_record("prompts", prompt_id, prompt))


@app.get("/api/evals", response_model=list[Evaluator])
def evals() -> list[Evaluator]:
    return [Evaluator.model_validate(item) for item in list_records("evals")]


@app.post("/api/evals/run", response_model=list[Evaluator])
def run_evals() -> list[Evaluator]:
    records = []
    for evaluator in list_records("evals"):
        evaluator["lastRun"] = "just now"
        evaluator["passRate"] = min(0.99, round(float(evaluator["passRate"]) + 0.01, 2))
        records.append(save_record("evals", evaluator["id"], evaluator))
    return [Evaluator.model_validate(item) for item in records]


@app.get("/api/rag", response_model=list[RagQuery])
def rag() -> list[RagQuery]:
    return [RagQuery.model_validate(item) for item in list_records("rag")]


@app.post("/api/rag/test", response_model=RagQuery)
def test_rag_retrieval(request: RagRetrievalTestRequest) -> RagQuery:
    query = get_record("rag", request.queryId)
    if query is None:
        raise HTTPException(status_code=404, detail="RAG query not found")

    reranker_bonus = 0.03 if request.reranker != "none" else -0.02
    chunk_penalty = abs(request.chunkSize - 512) / 4096
    top_k_penalty = abs(request.topK - len(query.get("chunks", []))) / 50
    model_bonus = 0.02 if "large" in request.embeddingModel else 0
    adjustment = reranker_bonus + model_bonus - chunk_penalty - top_k_penalty

    for metric in ("faithfulness", "relevance", "precision", "recall"):
        query[metric] = max(0.0, min(0.99, round(float(query.get(metric, 0)) + adjustment, 2)))

    save_record("rag", request.queryId, query)
    return RagQuery.model_validate(query)


@app.get("/api/costs")
def costs() -> dict[str, Any]:
    return get_record("costs", "current") or {}


@app.patch("/api/costs/budget")
def update_cost_budget(request: CostBudgetUpdateRequest) -> dict[str, Any]:
    payload = get_record("costs", "current") or {}
    summary = payload.setdefault("summary", {})
    summary["budgetLimit"] = request.budgetLimit
    summary.setdefault("mtdSpend", 0)
    summary.setdefault("projectedSpend", summary["mtdSpend"])
    saved = save_record("costs", "current", payload)
    save_audit_event(
        "cost.budget_update",
        "local-workspace",
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
    return [PolicyViolation.model_validate(item) for item in list_records("policy_violations")]


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
    return [AgentRuntime.model_validate(item) for item in list_records("agents")]


@app.get("/api/agent-runtime/definitions", response_model=list[AgentDefinition])
def agent_definitions() -> list[AgentDefinition]:
    return AGENT_DEFINITIONS


@app.get("/api/agent-runtime/providers", response_model=list[ProviderStatus])
def provider_status() -> list[ProviderStatus]:
    return list_providers()


@app.get("/api/agent-runtime/runs", response_model=list[AgentRunRecord])
def agent_runs() -> list[AgentRunRecord]:
    return [AgentRunRecord.model_validate(item) for item in list_records("agent_runs")]


@app.get("/api/agent-runtime/runs/{run_id}", response_model=AgentRunRecord)
def agent_run_detail(run_id: str) -> AgentRunRecord:
    run = get_record("agent_runs", run_id)
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

    save_record("agent_runs", run.id, run.model_dump())
    save_record("traces", trace.id, trace.model_dump())
    return AgentRunResponse(run=run, trace=trace)


@app.get("/api/labs/experiments", response_model=list[LabExperiment])
def lab_experiments() -> list[LabExperiment]:
    experiments = [LabExperiment.model_validate(item) for item in list_records("lab_experiments")]
    return sorted(experiments, key=lambda item: item.createdAt, reverse=True)


@app.get("/api/labs/experiments/{experiment_id}", response_model=LabExperiment)
def lab_experiment_detail(experiment_id: str) -> LabExperiment:
    experiment = get_record("lab_experiments", experiment_id)
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

        save_record("agent_runs", run.id, run.model_dump())
        save_record("traces", trace.id, trace.model_dump())
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
    save_record("lab_experiments", experiment.id, experiment.model_dump())
    save_audit_event(
        "lab.experiment",
        "local-workspace",
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


@app.get("/api/settings", response_model=SettingsPayload)
def settings() -> SettingsPayload:
    return SettingsPayload.model_validate(public_settings_payload(settings_payload_or_404()))


@app.post("/api/settings/api-keys", response_model=ApiKeyCreateResponse)
def create_api_key(request: ApiKeyCreateRequest) -> ApiKeyCreateResponse:
    payload = settings_payload_or_404()
    key_id = f"key_{token_hex(4)}"
    token = f"nop_sk_{token_hex(18)}"
    payload.setdefault("apiKeys", []).insert(
        0,
        {
            "id": key_id,
            "name": request.name,
            "role": request.role,
            "created": datetime.now().strftime("%Y-%m-%d"),
            "prefix": token[:10],
            "tokenHash": hash_token(token),
        },
    )
    saved_payload = save_record("settings", "current", payload)
    settings_payload = SettingsPayload.model_validate(public_settings_payload(saved_payload))
    save_audit_event("api_key.create", request.role, key_id, "allow", f"Created API key record {request.name}.")
    return ApiKeyCreateResponse(settings=settings_payload, token=token)


@app.post("/api/settings/webhooks", response_model=SettingsPayload)
def create_webhook(request: WebhookCreateRequest) -> SettingsPayload:
    payload = settings_payload_or_404()
    payload.setdefault("webhooks", []).append(
        {
            "id": f"wh_{token_hex(4)}",
            "name": request.name,
            "url": request.url,
            "status": "active",
        }
    )
    return SettingsPayload.model_validate(public_settings_payload(save_record("settings", "current", payload)))


@app.patch("/api/settings/retention", response_model=SettingsPayload)
def update_retention(request: RetentionUpdateRequest) -> SettingsPayload:
    payload = settings_payload_or_404()
    payload["retentionDays"] = request.retentionDays
    return SettingsPayload.model_validate(public_settings_payload(save_record("settings", "current", payload)))


@app.get("/api/audit", response_model=list[AuditEvent])
def audit_events() -> list[AuditEvent]:
    return [AuditEvent.model_validate(item) for item in list_records("audit")]
