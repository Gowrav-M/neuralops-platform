from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


DecisionStatus = Literal["success", "warning", "failed", "blocked"]
IncidentStatus = Literal["Open", "Investigating", "Resolved"]
Severity = Literal["Critical", "Major", "Minor", "Low"]


class Stats(BaseModel):
    totalRequests: int = Field(ge=0)
    avgLatency: str
    p95Latency: str
    errorRate: str
    totalCost: str
    evalPassRate: str
    policyViolations: int = Field(ge=0)
    activeIncidents: int = Field(ge=0)


class Trace(BaseModel):
    id: str
    timestamp: str
    session: str
    environment: Literal["prod", "staging", "dev"]
    model: str
    tokens: int = Field(ge=0)
    latency: str
    cost: str
    status: DecisionStatus
    score: float = Field(ge=0, le=1)
    prompt: str
    output: str
    toolCalls: str | None = None
    source: Literal["api", "otel", "local"] = "api"
    spanCount: int = Field(default=0, ge=0)
    riskFlags: list[str] = Field(default_factory=list)
    spans: list["TraceSpan"] = Field(default_factory=list)


class TraceSpan(BaseModel):
    id: str
    parentId: str | None = None
    name: str
    operation: str
    durationMs: float = Field(ge=0)
    status: Literal["ok", "error", "unset"] = "unset"
    attributes: dict[str, Any] = Field(default_factory=dict)


class Incident(BaseModel):
    id: str
    title: str
    severity: Severity
    status: IncidentStatus
    time: str
    owner: str


class PromptVersion(BaseModel):
    id: str
    name: str
    version: str
    status: Literal["Production", "Canary", "Draft", "Archived"]
    canaryPercent: int = Field(ge=0, le=100)
    evalScore: float = Field(ge=0, le=1)
    updatedAt: str
    owner: str = "AI Platform"
    template: str = ""
    history: list["PromptHistoryEntry"] = Field(default_factory=list)


class PromptHistoryEntry(BaseModel):
    version: str
    date: str
    owner: str
    score: float = Field(ge=0, le=1)
    status: str


class Evaluator(BaseModel):
    id: str
    name: str
    status: Literal["passing", "warning", "failing"]
    passRate: float = Field(ge=0, le=1)
    lastRun: str
    type: str = "Deterministic"
    testCount: int = Field(default=0, ge=0)
    dataset: str = "backend_trace_set"


class RagQuery(BaseModel):
    id: str
    query: str
    expected: str
    actual: str
    faithfulness: float = Field(ge=0, le=1)
    relevance: float = Field(ge=0, le=1)
    precision: float = Field(default=0, ge=0, le=1)
    recall: float = Field(default=0, ge=0, le=1)
    chunks: list["RagChunk"] = Field(default_factory=list)


class RagChunk(BaseModel):
    id: str
    doc: str
    score: float = Field(ge=0, le=1)
    text: str


class CostSummary(BaseModel):
    mtdSpend: float = Field(ge=0)
    budgetLimit: int = Field(ge=0)
    projectedSpend: float = Field(ge=0)
    costPerThousand: float = Field(ge=0)


class Policy(BaseModel):
    id: str
    name: str
    mode: Literal["block", "review", "monitor"]
    enabled: bool
    matches: int = Field(ge=0)
    severity: Severity


class PolicyPatch(BaseModel):
    mode: Literal["block", "review", "monitor"] | None = None
    enabled: bool | None = None


class PolicyViolation(BaseModel):
    id: str
    policyId: str
    policyName: str
    decision: Literal["blocked", "review", "warned"]
    severity: Severity
    subject: str
    summary: str
    time: str


class PromptTrafficUpdate(BaseModel):
    canaryPercent: int = Field(ge=0, le=100)


class RagRetrievalTestRequest(BaseModel):
    queryId: str
    topK: int = Field(ge=1, le=10)
    chunkSize: int = Field(ge=128, le=2048)
    embeddingModel: str = Field(min_length=1)
    reranker: str = Field(min_length=1)


class AgentRuntime(BaseModel):
    id: str
    name: str
    status: Literal["healthy", "degraded", "blocked"]
    model: str
    activeSessions: int = Field(ge=0)
    risk: Severity


class AgentDefinition(BaseModel):
    id: str
    name: str
    role: str
    industrySignal: str
    defaultModel: str
    capabilities: list[str]
    riskControls: list[str]


class ProviderStatus(BaseModel):
    id: str
    label: str
    configured: bool
    baseUrl: str | None = None
    defaultModel: str


class AgentRunRequest(BaseModel):
    agentId: str
    input: str = Field(min_length=1)
    providerMode: Literal["local", "auto", "live"] = "auto"
    model: str | None = None
    environment: Literal["prod", "staging", "dev"] = "staging"


JobStatus = Literal["queued", "running", "succeeded", "blocked", "failed", "cancelled"]


class AgentJob(BaseModel):
    id: str
    status: JobStatus
    request: AgentRunRequest
    attempts: int = Field(ge=0)
    maxAttempts: int = Field(default=2, ge=1)
    runId: str | None = None
    traceId: str | None = None
    error: str | None = None
    createdAt: str
    updatedAt: str
    startedAt: str | None = None
    finishedAt: str | None = None


class AgentJobSubmitRequest(AgentRunRequest):
    maxAttempts: int = Field(default=2, ge=1, le=5)


class AgentJobSubmitResponse(BaseModel):
    job: AgentJob


class AgentJobProcessResponse(BaseModel):
    job: AgentJob
    run: "AgentRunRecord | None" = None
    trace: Trace | None = None


class AgentEvalCheck(BaseModel):
    name: str
    status: Literal["pass", "warn", "fail"]
    score: float = Field(ge=0, le=1)
    reason: str


class AgentRunRecord(BaseModel):
    id: str
    agentId: str
    agentName: str
    provider: Literal["local", "groq", "nvidia", "openai", "custom"]
    model: str
    input: str
    output: str
    decision: Literal["allow", "review", "block"]
    score: float = Field(ge=0, le=1)
    evals: list[AgentEvalCheck]
    policyFindings: list[str]
    latencyMs: int = Field(ge=0)
    tokens: int = Field(ge=0)
    costUsd: float = Field(ge=0)
    traceId: str
    createdAt: str


class AgentRunResponse(BaseModel):
    run: AgentRunRecord
    trace: Trace


class SettingsPayload(BaseModel):
    retentionDays: int = Field(ge=1)
    apiKeys: list[dict[str, Any]]
    webhooks: list[dict[str, Any]]
    teamMembers: list[dict[str, Any]]
    ssoStatus: str = "Not configured"
    billingPlan: str = "Local development"
    nextInvoice: str | None = None


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    role: str = Field(min_length=1)


class ApiKeyCreateResponse(BaseModel):
    settings: SettingsPayload
    token: str


class WebhookCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    url: str = Field(min_length=1)


class RetentionUpdateRequest(BaseModel):
    retentionDays: int = Field(ge=1, le=365)


class DashboardSnapshot(BaseModel):
    stats: Stats
    traces: list[Trace]
    incidents: list[Incident]


class IncidentPatch(BaseModel):
    status: IncidentStatus | None = None
    owner: str | None = None


class PolicyTestRequest(BaseModel):
    input: str = Field(min_length=1)
    policyId: str | None = None


class PolicyTestResult(BaseModel):
    decision: Literal["allow", "review", "block"]
    severity: Severity | None = None
    reason: str
    matchedPatterns: list[str]


class OtelIngestRequest(BaseModel):
    payload: dict[str, Any]
    environment: Literal["prod", "staging", "dev"] = "prod"


class OtelIngestResult(BaseModel):
    decision: Literal["allow", "review", "block"]
    trace: Trace
    spanCount: int = Field(ge=0)
    findings: list[str]


class ReplayCheck(BaseModel):
    name: str
    status: Literal["pass", "warn", "fail"]
    reason: str


class ReplayResult(BaseModel):
    traceId: str
    decision: Literal["allow", "review", "block"]
    score: float = Field(ge=0, le=1)
    checks: list[ReplayCheck]
    recommendation: str


class TraceIngestRequest(BaseModel):
    session: str = Field(min_length=1)
    environment: Literal["prod", "staging", "dev"] = "prod"
    model: str = Field(min_length=1)
    tokens: int = Field(ge=0)
    latencyMs: int = Field(ge=0)
    costUsd: float = Field(default=0, ge=0)
    status: DecisionStatus = "success"
    score: float = Field(default=1, ge=0, le=1)
    prompt: str = Field(min_length=1)
    output: str = Field(min_length=1)
    toolCalls: str | None = None
    riskFlags: list[str] = Field(default_factory=list)


class TraceIngestResponse(BaseModel):
    trace: Trace
    auditId: str
    accepted: bool = True


class AuditEvent(BaseModel):
    id: str
    type: str
    actor: str
    subject: str
    decision: Literal["allow", "review", "block"]
    summary: str
    createdAt: str


class ApiEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    data: Any
