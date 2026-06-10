from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


DecisionStatus = Literal["success", "warning", "failed", "blocked"]
IncidentStatus = Literal["Open", "Investigating", "Resolved"]
Severity = Literal["Critical", "Major", "Minor", "Low"]
WorkspaceRole = Literal["Owner", "Admin", "Developer", "Security", "Viewer"]
AccessPermission = Literal[
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
]
DetectionDecision = Literal["allow", "review", "block"]
DetectionStatus = Literal["open", "contained", "closed"]
RiskExceptionStatus = Literal["active", "expired", "revoked"]
RiskExceptionScope = Literal["release", "slo", "gateway", "estate", "detection", "incident", "policy", "other"]
ControlStatus = Literal["pass", "review", "block"]
ControlDomain = Literal["governance", "security", "reliability", "operations", "cost", "access"]
ApiKeyScope = Literal["trace:ingest", "trace:read", "gateway:invoke", "admin"]
AutomationTrigger = Literal[
    "release_gate.blocked",
    "release_gate.review",
    "trace.blocked",
    "trace.failed",
    "policy.violation",
    "cost.budget_risk",
]
AutomationAction = Literal["audit_only", "create_incident", "webhook_record"]
EstateSystemKind = Literal["app", "agent", "prompt", "model", "provider", "dataset", "policy", "gateway", "evidence"]
EstateSystemSource = Literal["trace", "otel", "gateway", "agent", "provider", "prompt", "rag", "policy", "evidence"]
EstateHealthStatus = Literal["healthy", "review", "blocked"]
EstateEdgeType = Literal["calls", "routes_to", "uses", "evaluated_by", "guarded_by", "released_by", "observed_as", "owns"]


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


class EstateSystem(BaseModel):
    id: str
    name: str
    kind: EstateSystemKind
    owner: str = "Unassigned"
    environment: Literal["prod", "staging", "dev", "all"] = "all"
    source: EstateSystemSource
    firstSeen: str
    lastSeen: str
    risk: Severity = "Low"
    riskScore: int = Field(default=0, ge=0, le=100)
    costUsd: float = Field(default=0, ge=0)
    avgLatencyMs: int = Field(default=0, ge=0)
    evalScore: float | None = Field(default=None, ge=0, le=1)
    incidentCount: int = Field(default=0, ge=0)
    latestTraceId: str | None = None
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EstateEdge(BaseModel):
    id: str
    sourceId: str
    targetId: str
    type: EstateEdgeType
    label: str
    evidence: str
    latestSeen: str


class EstateHealth(BaseModel):
    systemId: str
    status: EstateHealthStatus
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    reasons: list[str] = Field(default_factory=list)


class EstateSummary(BaseModel):
    workspaceId: str
    generatedAt: str
    totalSystems: int = Field(ge=0)
    riskySystems: int = Field(ge=0)
    totalSpendUsd: float = Field(ge=0)
    avgLatencyMs: int = Field(ge=0)
    counts: dict[str, int]
    latestSystem: EstateSystem | None = None


class EstateGraph(BaseModel):
    workspaceId: str
    generatedAt: str
    systems: list[EstateSystem]
    edges: list[EstateEdge]
    health: list[EstateHealth]


class EstateSystemPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    owner: str | None = Field(default=None, min_length=1, max_length=120)
    tags: list[str] | None = Field(default=None, max_length=20)


class EstateSystemDetail(BaseModel):
    system: EstateSystem
    health: EstateHealth
    incoming: list[EstateEdge]
    outgoing: list[EstateEdge]
    relatedTraces: list[Trace] = Field(default_factory=list)


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


class DetectionCaseCreateRequest(BaseModel):
    owner: str = Field(default="AI Platform Oncall", min_length=1)


class DetectionActionRequest(BaseModel):
    action: Literal["contain", "close", "reopen"]
    note: str = Field(default="", max_length=1000)


class DetectionCase(BaseModel):
    id: str
    title: str
    severity: Severity
    decision: DetectionDecision
    status: DetectionStatus
    sourceType: Literal["trace", "policy_violation", "manual"]
    sourceTraceId: str | None = None
    createdAt: str
    updatedAt: str
    owner: str
    rootCause: str
    blastRadius: list[str]
    timeline: list[dict[str, Any]]
    recommendedActions: list[str]
    containmentActions: list[str]
    evidence: dict[str, Any]


class PromptTrafficUpdate(BaseModel):
    canaryPercent: int = Field(ge=0, le=100)


class RagRetrievalTestRequest(BaseModel):
    queryId: str
    topK: int = Field(ge=1, le=10)
    chunkSize: int = Field(ge=128, le=2048)
    embeddingModel: str = Field(min_length=1)
    reranker: str = Field(min_length=1)


class CostBudgetUpdateRequest(BaseModel):
    budgetLimit: int = Field(ge=1, le=1_000_000)


class AiSloTarget(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=120)
    environment: Literal["prod", "staging", "dev", "all"] = "prod"
    serviceFilter: str | None = Field(default=None, max_length=120)
    maxP95LatencyMs: int = Field(default=2500, ge=1)
    minSuccessRate: float = Field(default=0.98, ge=0, le=1)
    minEvalScore: float = Field(default=0.85, ge=0, le=1)
    maxPolicyViolationRate: float = Field(default=0.02, ge=0, le=1)
    maxCostUsd: float = Field(default=25, ge=0)
    windowTraceLimit: int = Field(default=200, ge=1, le=5000)
    enabled: bool = True
    createdAt: str
    updatedAt: str


class AiSloTargetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    environment: Literal["prod", "staging", "dev", "all"] = "prod"
    serviceFilter: str | None = Field(default=None, max_length=120)
    maxP95LatencyMs: int = Field(default=2500, ge=1)
    minSuccessRate: float = Field(default=0.98, ge=0, le=1)
    minEvalScore: float = Field(default=0.85, ge=0, le=1)
    maxPolicyViolationRate: float = Field(default=0.02, ge=0, le=1)
    maxCostUsd: float = Field(default=25, ge=0)
    windowTraceLimit: int = Field(default=200, ge=1, le=5000)
    enabled: bool = True


class AiSloTargetPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    environment: Literal["prod", "staging", "dev", "all"] | None = None
    serviceFilter: str | None = Field(default=None, max_length=120)
    maxP95LatencyMs: int | None = Field(default=None, ge=1)
    minSuccessRate: float | None = Field(default=None, ge=0, le=1)
    minEvalScore: float | None = Field(default=None, ge=0, le=1)
    maxPolicyViolationRate: float | None = Field(default=None, ge=0, le=1)
    maxCostUsd: float | None = Field(default=None, ge=0)
    windowTraceLimit: int | None = Field(default=None, ge=1, le=5000)
    enabled: bool | None = None


class AiSloCheck(BaseModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    target: str
    actual: str
    evidence: str


class AiSloEvaluation(BaseModel):
    id: str
    sloId: str
    sloName: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    traceCount: int = Field(ge=0)
    burnRate: float = Field(ge=0)
    errorBudgetRemaining: float = Field(ge=0, le=1)
    checks: list[AiSloCheck]
    generatedAt: str


class AiSloDashboard(BaseModel):
    workspaceId: str
    generatedAt: str
    slos: list[AiSloTarget]
    evaluations: list[AiSloEvaluation]
    summary: dict[str, Any]


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
    source: Literal["local", "env", "connection", "preset"] = "preset"
    environment: Literal["prod", "staging", "dev", "all"] = "all"
    priority: int = Field(default=100, ge=1, le=999)
    supportsChat: bool = True
    supportsEmbeddings: bool = False
    supportsVision: bool = False
    status: Literal["configured", "not_configured", "healthy", "failed"] | None = None


class ProviderPreset(BaseModel):
    id: str
    label: str
    category: Literal["frontier", "gateway", "cloud", "open-source", "local", "custom"]
    baseUrl: str
    defaultModel: str
    authType: Literal["bearer", "none"] = "bearer"
    supportsChat: bool = True
    supportsEmbeddings: bool = False
    supportsVision: bool = False
    notes: list[str] = Field(default_factory=list)


class ProviderConnectionCreate(BaseModel):
    providerId: str = Field(min_length=1)
    label: str = Field(min_length=1)
    baseUrl: str = Field(min_length=1)
    defaultModel: str = Field(min_length=1)
    apiKey: str | None = Field(default=None)
    environment: Literal["prod", "staging", "dev", "all"] = "staging"
    priority: int = Field(default=100, ge=1, le=999)
    supportsChat: bool = True
    supportsEmbeddings: bool = False
    supportsVision: bool = False


class ProviderConnection(BaseModel):
    id: str
    providerId: str
    label: str
    baseUrl: str
    defaultModel: str
    environment: Literal["prod", "staging", "dev", "all"]
    priority: int = Field(ge=1, le=999)
    configured: bool
    keyPreview: str | None = None
    supportsChat: bool = True
    supportsEmbeddings: bool = False
    supportsVision: bool = False
    lastTestedAt: str | None = None
    lastStatus: Literal["untested", "healthy", "failed", "not_configured"] = "untested"
    lastError: str | None = None
    createdAt: str
    updatedAt: str


class ProviderConnectionTestResult(BaseModel):
    ok: bool
    connection: ProviderConnection
    latencyMs: int = Field(ge=0)
    message: str


class ProviderCalibrationRequest(BaseModel):
    environment: Literal["prod", "staging", "dev"] = "staging"
    prompt: str = Field(
        default="Summarize this production AI incident in one sentence with safe operational wording.",
        min_length=1,
        max_length=2000,
    )
    maxLatencyMs: int = Field(default=2500, ge=1, le=120_000)
    maxEstimatedCostUsd: float | None = Field(default=None, ge=0)
    includeProviders: list[str] = Field(default_factory=list, max_length=25)


class ProviderCalibrationResult(BaseModel):
    providerId: str
    providerLabel: str
    source: str
    model: str
    status: Literal["passed", "failed", "not_configured"]
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    latencyMs: int = Field(ge=0)
    estimatedCostUsd: float | None = Field(default=None, ge=0)
    actualCostUsd: float | None = Field(default=None, ge=0)
    traceId: str | None = None
    routeEventId: str | None = None
    findings: list[str] = Field(default_factory=list)
    outputPreview: str = ""
    error: str | None = None


class ProviderCalibrationRun(BaseModel):
    id: str
    environment: Literal["prod", "staging", "dev"]
    prompt: str
    decision: Literal["allow", "review", "block"]
    recommendedProviderId: str | None = None
    recommendedProviderLabel: str | None = None
    summary: dict[str, Any]
    results: list[ProviderCalibrationResult]
    generatedAt: str


class FeatureTruth(BaseModel):
    id: str
    label: str
    state: Literal["persisted", "live_provider", "local_drill", "not_configured"]
    evidence: str
    action: str


class SystemStatus(BaseModel):
    storage: Literal["sqlite", "postgres"]
    environment: str
    authRequired: bool
    workspaceId: str
    recordCounts: dict[str, int]
    providers: list[ProviderStatus]
    features: list[FeatureTruth]
    readinessScore: int = Field(ge=0, le=100)
    blockers: list[str]
    generatedAt: str


class ActionCenterItem(BaseModel):
    id: str
    title: str
    severity: Literal["critical", "high", "medium", "low"]
    category: Literal["connect", "govern", "operate", "secure", "release", "cost"]
    owner: str
    impact: str
    evidence: str
    nextStep: str
    destinationTab: str
    source: str
    generatedAt: str


class ActionCenterSummary(BaseModel):
    critical: int = Field(ge=0)
    high: int = Field(ge=0)
    medium: int = Field(ge=0)
    low: int = Field(ge=0)
    total: int = Field(ge=0)
    readinessScore: int = Field(ge=0, le=100)
    topCategory: str | None = None


class ActionCenterResponse(BaseModel):
    workspaceId: str
    generatedAt: str
    summary: ActionCenterSummary
    items: list[ActionCenterItem]
    executiveBrief: list[str]


class RiskExceptionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    scope: RiskExceptionScope = "release"
    sourceId: str = Field(default="", max_length=160)
    severity: Severity = "Major"
    owner: str = Field(default="AI Platform Owner", min_length=1, max_length=120)
    approver: str = Field(default="Security Reviewer", min_length=1, max_length=120)
    reason: str = Field(min_length=12, max_length=2000)
    compensatingControls: list[str] = Field(default_factory=list, max_length=12)
    expiresInDays: int = Field(default=14, ge=1, le=365)


class RiskExceptionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    severity: Severity | None = None
    owner: str | None = Field(default=None, min_length=1, max_length=120)
    approver: str | None = Field(default=None, min_length=1, max_length=120)
    reason: str | None = Field(default=None, min_length=12, max_length=2000)
    compensatingControls: list[str] | None = Field(default=None, max_length=12)
    status: RiskExceptionStatus | None = None


class RiskException(BaseModel):
    id: str
    title: str
    scope: RiskExceptionScope
    sourceId: str = ""
    severity: Severity
    status: RiskExceptionStatus
    owner: str
    approver: str
    reason: str
    compensatingControls: list[str] = Field(default_factory=list)
    createdAt: str
    updatedAt: str
    expiresAt: str
    revokedAt: str | None = None


class RiskRegisterSummary(BaseModel):
    total: int = Field(ge=0)
    active: int = Field(ge=0)
    expired: int = Field(ge=0)
    revoked: int = Field(ge=0)
    criticalActive: int = Field(ge=0)
    expiringSoon: int = Field(ge=0)
    generatedAt: str


class RiskRegisterResponse(BaseModel):
    workspaceId: str
    summary: RiskRegisterSummary
    exceptions: list[RiskException]


class ControlEvidence(BaseModel):
    id: str
    label: str
    source: str
    count: int = Field(ge=0)
    detail: str


class ControlCheck(BaseModel):
    id: str
    title: str
    domain: ControlDomain
    status: ControlStatus
    owner: str
    requirement: str
    evidence: list[ControlEvidence] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    nextStep: str
    mappedFrameworks: list[str] = Field(default_factory=list)


class ControlCenterSummary(BaseModel):
    total: int = Field(ge=0)
    passing: int = Field(ge=0)
    review: int = Field(ge=0)
    blocked: int = Field(ge=0)
    coverageScore: int = Field(ge=0, le=100)
    generatedAt: str


class ControlCenterReport(BaseModel):
    workspaceId: str
    summary: ControlCenterSummary
    controls: list[ControlCheck]
    markdown: str


class ControlCenterExport(BaseModel):
    id: str
    generatedAt: str
    report: ControlCenterReport
    artifacts: list[dict[str, str]] = Field(default_factory=list)


class ReleaseGateRequest(BaseModel):
    target: str = Field(default="production", min_length=1)
    traceEnvironment: Literal["prod", "staging", "dev", "all"] | None = None
    promptId: str | None = None
    maxLatencyMs: int = Field(default=2500, ge=1)
    maxErrorRate: float = Field(default=0.05, ge=0, le=1)
    minEvalPassRate: float = Field(default=0.85, ge=0, le=1)
    requireLiveProvider: bool = False
    requireAuth: bool = True
    requireSyntheticCanary: bool = False
    syntheticCanaryMaxAgeMinutes: int = Field(default=60, ge=1, le=1440)
    includeSyntheticTraces: bool = False


class ReleaseGateDefinitionCreate(BaseModel):
    name: str = Field(min_length=1)
    target: str = Field(default="production", min_length=1)
    traceEnvironment: Literal["prod", "staging", "dev", "all"] | None = None
    promptId: str | None = None
    maxLatencyMs: int = Field(default=2500, ge=1)
    maxErrorRate: float = Field(default=0.05, ge=0, le=1)
    minEvalPassRate: float = Field(default=0.85, ge=0, le=1)
    requireLiveProvider: bool = False
    requireAuth: bool = True
    requireSyntheticCanary: bool = False
    syntheticCanaryMaxAgeMinutes: int = Field(default=60, ge=1, le=1440)
    includeSyntheticTraces: bool = False
    description: str = ""


class ReleaseGateDefinitionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    target: str | None = Field(default=None, min_length=1)
    traceEnvironment: Literal["prod", "staging", "dev", "all"] | None = None
    promptId: str | None = None
    maxLatencyMs: int | None = Field(default=None, ge=1)
    maxErrorRate: float | None = Field(default=None, ge=0, le=1)
    minEvalPassRate: float | None = Field(default=None, ge=0, le=1)
    requireLiveProvider: bool | None = None
    requireAuth: bool | None = None
    requireSyntheticCanary: bool | None = None
    syntheticCanaryMaxAgeMinutes: int | None = Field(default=None, ge=1, le=1440)
    includeSyntheticTraces: bool | None = None
    description: str | None = None


class ReleaseGateDefinition(ReleaseGateDefinitionCreate):
    id: str
    createdAt: str
    updatedAt: str
    lastRunId: str | None = None
    lastDecision: Literal["allow", "review", "block"] | None = None
    lastScore: int | None = Field(default=None, ge=0, le=100)


class ReleaseGateRunRequest(BaseModel):
    gateId: str | None = None
    target: str | None = None
    failOn: Literal["review", "block"] = "block"


class ReleaseGateCheck(BaseModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    reason: str
    evidence: str


class ReleaseGateResult(BaseModel):
    id: str
    gateId: str | None = None
    gateName: str | None = None
    target: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    checks: list[ReleaseGateCheck]
    recommendations: list[str]
    generatedAt: str


class EvidenceReport(BaseModel):
    id: str
    generatedAt: str
    status: SystemStatus
    latestGate: ReleaseGateResult | None = None
    latestReplayGate: "ReplayGateResult | None" = None
    latestDatasetReplayGate: "ReplayDatasetGateResult | None" = None
    summary: dict[str, Any]
    markdown: str


class EvidenceExportArtifact(BaseModel):
    label: str
    type: Literal["json", "markdown", "api", "ui"]
    path: str
    digest: str | None = None


class EvidenceExportPack(BaseModel):
    schemaVersion: Literal["neuralops.evidence-pack.v1"] = "neuralops.evidence-pack.v1"
    id: str
    generatedAt: str
    workspaceId: str
    subject: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    summary: dict[str, Any]
    artifacts: list[EvidenceExportArtifact]
    evidence: EvidenceReport
    readiness: ProductionReadinessReport
    gateway: dict[str, Any]
    accessAudit: list[AuditEvent]
    automation: dict[str, Any]
    markdown: str
    digest: str


class ReleaseAutopilotRequest(BaseModel):
    candidateName: str = Field(min_length=1)
    candidateInstructions: str = Field(min_length=1)
    target: str = Field(default="production", min_length=1)
    traceLimit: int = Field(default=5, ge=1, le=25)
    requireLiveProvider: bool = False
    requireAuth: bool = False


class ReleaseAutopilotComparison(BaseModel):
    traceId: str
    currentStatus: DecisionStatus
    currentScore: float = Field(ge=0, le=1)
    replayDecision: Literal["allow", "review", "block"]
    candidateDecision: Literal["allow", "review", "block"]
    candidateScore: float = Field(ge=0, le=1)
    improvement: float
    requiredControls: list[str]
    missingControls: list[str]
    recommendation: str


class ReleaseAutopilotResult(BaseModel):
    id: str
    candidateName: str
    target: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    mode: Literal["deterministic_policy_replay", "live_provider_replay"] = "deterministic_policy_replay"
    comparisons: list[ReleaseAutopilotComparison]
    gate: ReleaseGateResult
    summary: dict[str, Any]
    prCommentMarkdown: str
    generatedAt: str


class AutomationRuleCreate(BaseModel):
    name: str = Field(min_length=1)
    trigger: AutomationTrigger
    action: AutomationAction
    enabled: bool = True
    severity: Severity = "Major"
    owner: str = Field(default="AI Platform Oncall", min_length=1)
    description: str = ""


class AutomationRulePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    trigger: AutomationTrigger | None = None
    action: AutomationAction | None = None
    enabled: bool | None = None
    severity: Severity | None = None
    owner: str | None = Field(default=None, min_length=1)
    description: str | None = None


class AutomationRule(AutomationRuleCreate):
    id: str
    createdAt: str
    updatedAt: str
    lastRunAt: str | None = None
    runCount: int = Field(default=0, ge=0)


class AutomationEvent(BaseModel):
    id: str
    ruleId: str
    ruleName: str
    trigger: AutomationTrigger
    action: AutomationAction
    subjectType: str
    subjectId: str
    decision: Literal["allow", "review", "block"]
    summary: str
    status: Literal["recorded", "skipped", "failed"]
    result: dict[str, Any]
    createdAt: str


class ConnectorDelivery(BaseModel):
    id: str
    connectorType: Literal["webhook", "github", "slack", "jira"]
    connectorId: str
    connectorName: str
    subjectType: str
    subjectId: str
    eventId: str | None = None
    status: Literal["pending", "delivered", "failed", "skipped"]
    attempt: int = Field(ge=1)
    url: str | None = None
    signature: str
    payload: dict[str, Any]
    lastError: str | None = None
    createdAt: str
    nextRetryAt: str | None = None


class ConnectorDeliveryProcessRequest(BaseModel):
    limit: int = Field(default=10, ge=1, le=100)
    sendExternal: bool = False


class ConnectorDeliveryProcessResult(BaseModel):
    processed: int = Field(ge=0)
    delivered: int = Field(ge=0)
    failed: int = Field(ge=0)
    skipped: int = Field(ge=0)
    mode: Literal["dry_run", "external_send"]
    deliveries: list[ConnectorDelivery]


class GitHubPrCommentRequest(BaseModel):
    owner: str = Field(min_length=1)
    repo: str = Field(min_length=1)
    issueNumber: int = Field(ge=1)
    body: str = Field(min_length=1)
    sendExternal: bool = False


class GitHubPrCommentResult(BaseModel):
    posted: bool
    delivery: ConnectorDelivery
    url: str | None = None
    message: str


class AutomationRunTestRequest(BaseModel):
    subjectId: str = Field(default="manual-test", min_length=1)
    subjectType: str = Field(default="manual", min_length=1)
    decision: Literal["allow", "review", "block"] = "review"
    summary: str = Field(default="Manual automation test from NeuralOps.", min_length=1)


class ConnectSnippet(BaseModel):
    id: str
    label: str
    language: str
    command: str | None = None
    code: str
    notes: list[str] = Field(default_factory=list)


class ConnectGuide(BaseModel):
    apiBaseUrl: str
    ingestEndpoint: str
    otelEndpoint: str
    gatewayEndpoint: str
    authHeader: str
    snippets: list[ConnectSnippet]
    generatedAt: str


class ConnectVerifyRequest(BaseModel):
    serviceName: str = Field(default="neuralops-connected-app", min_length=1)
    environment: Literal["prod", "staging", "dev"] = "staging"
    sdk: Literal["javascript", "python", "curl", "otel", "manual"] = "manual"


class ConnectVerifyResponse(BaseModel):
    ok: bool
    trace: Trace
    auditId: str
    message: str


ConnectivityStatus = Literal["ready", "degraded", "missing"]
ConnectivityCategory = Literal["database", "auth", "ingest", "gateway", "otel", "webhook", "automation", "provider"]


class ConnectivityCheck(BaseModel):
    id: str
    label: str
    category: ConnectivityCategory
    status: ConnectivityStatus
    evidence: str
    endpoint: str | None = None
    lastSeenAt: str | None = None
    action: str


class ConnectivityAction(BaseModel):
    id: str
    label: str
    target: str
    reason: str
    priority: Literal["high", "medium", "low"]


class ConnectivityMap(BaseModel):
    workspaceId: str
    storage: Literal["sqlite", "postgres"]
    overallStatus: ConnectivityStatus
    score: int = Field(ge=0, le=100)
    checks: list[ConnectivityCheck]
    nextActions: list[ConnectivityAction]
    generatedAt: str


class SyntheticCanaryRequest(BaseModel):
    target: str = Field(default="production", min_length=1)
    includeLiveProvider: bool = False


class SyntheticCanaryCheck(BaseModel):
    id: str
    label: str
    status: Literal["pass", "warn", "fail"]
    latencyMs: int = Field(ge=0)
    evidence: str
    action: str


class SyntheticCanaryRun(BaseModel):
    id: str
    target: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    checks: list[SyntheticCanaryCheck]
    summary: dict[str, int]
    generatedAt: str


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
    provider: str
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


class LabRunRequest(BaseModel):
    name: str = Field(default="Untitled experiment", min_length=1)
    input: str = Field(min_length=1)
    agentIds: list[str] = Field(default_factory=lambda: ["support_triage"], min_length=1)
    providerMode: Literal["local", "auto", "live"] = "auto"
    environment: Literal["prod", "staging", "dev"] = "staging"
    model: str | None = None


class LabVariantResult(BaseModel):
    agentId: str
    agentName: str
    runId: str
    traceId: str
    provider: str
    model: str
    decision: Literal["allow", "review", "block"]
    score: float = Field(ge=0, le=1)
    latencyMs: int = Field(ge=0)
    tokens: int = Field(ge=0)
    costUsd: float = Field(ge=0)
    output: str
    policyFindings: list[str]


class LabExperiment(BaseModel):
    id: str
    name: str
    input: str
    providerMode: Literal["local", "auto", "live"]
    environment: Literal["prod", "staging", "dev"]
    createdAt: str
    decision: Literal["allow", "review", "block"]
    winnerRunId: str | None = None
    variants: list[LabVariantResult]
    summary: dict[str, Any]


class LabRunResponse(BaseModel):
    experiment: LabExperiment
    traces: list[Trace]


class SettingsPayload(BaseModel):
    retentionDays: int = Field(ge=1)
    apiKeys: list[dict[str, Any]]
    webhooks: list[dict[str, Any]]
    teamMembers: list[dict[str, Any]]
    ssoStatus: str = "Not configured"
    billingPlan: str = "Local development"
    nextInvoice: str | None = None


class WorkspaceMember(BaseModel):
    id: str
    workspaceId: str
    name: str = Field(min_length=1)
    email: str = Field(min_length=3)
    role: WorkspaceRole
    access: Literal["All Workspace", "Read Only"]
    createdAt: str
    updatedAt: str


class WorkspaceMemberCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    email: str = Field(min_length=3)
    role: WorkspaceRole


class WorkspaceMemberPatchRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    email: str | None = Field(default=None, min_length=3)
    role: WorkspaceRole | None = None


WorkspaceInviteStatus = Literal["pending", "accepted", "expired", "revoked"]


class WorkspaceInviteCreateRequest(BaseModel):
    email: str = Field(min_length=3)
    role: WorkspaceRole = "Developer"
    expiresInHours: int = Field(default=72, ge=1, le=720)


class WorkspaceInvite(BaseModel):
    id: str
    workspaceId: str
    email: str
    role: WorkspaceRole
    token: str
    status: WorkspaceInviteStatus
    invitedBy: str
    createdAt: str
    expiresAt: str
    acceptedAt: str | None = None


class WorkspaceInviteAcceptResult(BaseModel):
    workspaceId: str
    member: WorkspaceMember
    invite: WorkspaceInvite


class WorkspaceProfile(BaseModel):
    id: str
    name: str
    storage: Literal["sqlite", "postgres"]
    authRequired: bool
    memberCount: int = Field(ge=0)
    createdAt: str
    updatedAt: str


class OnboardingStep(BaseModel):
    id: str
    label: str
    state: Literal["complete", "action_required", "not_configured"]
    detail: str


class OnboardingStatus(BaseModel):
    workspace: WorkspaceProfile
    progress: int = Field(ge=0, le=100)
    nextAction: str
    steps: list[OnboardingStep]
    generatedAt: str


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    role: str = Field(min_length=1)
    environment: Literal["prod", "staging", "dev", "all"] = "all"
    scopes: list[ApiKeyScope] = Field(default_factory=lambda: ["trace:ingest"], min_length=1)


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


class GatewayChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: str = Field(min_length=1)
    content: Any


class GatewayChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str | None = None
    messages: list[GatewayChatMessage] = Field(min_length=1)
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, ge=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class GatewayPolicyDecision(BaseModel):
    decision: Literal["allow", "review", "block"]
    stage: Literal["pre_policy", "post_policy"]
    findings: list[str]
    reason: str


GatewayRoutingStrategy = Literal["priority", "lowest_cost", "lowest_latency", "balanced"]
GatewayCacheStatus = Literal["disabled", "miss", "hit", "stored"]
GatewayBudgetDecision = Literal["allow", "soft_limit", "hard_limit"]


class GatewayRoutingPolicy(BaseModel):
    id: str = "default"
    strategy: GatewayRoutingStrategy = "priority"
    retryAttempts: int = Field(default=3, ge=1, le=5)
    retryBackoffMs: list[int] = Field(default_factory=lambda: [100, 400, 1600])
    cacheEnabled: bool = False
    cacheTtlSeconds: int = Field(default=1800, ge=60, le=86_400)
    rateLimitPerMinute: int = Field(default=60, ge=1, le=100_000)
    maxEstimatedCostUsd: float | None = Field(default=None, ge=0)
    updatedAt: str | None = None


class GatewayBudget(BaseModel):
    id: str
    environment: Literal["prod", "staging", "dev", "all"] = "staging"
    limitUsd: float = Field(ge=0)
    softLimitUsd: float | None = Field(default=None, ge=0)
    spentUsd: float = Field(default=0, ge=0)
    hardLimitEnabled: bool = True
    period: Literal["daily", "weekly", "monthly"] = "monthly"
    createdAt: str
    updatedAt: str
    remainingUsd: float = Field(ge=0)


class GatewayRequestLog(BaseModel):
    id: str
    traceId: str | None = None
    routeEventId: str | None = None
    environment: Literal["prod", "staging", "dev"]
    requestedModel: str | None = None
    selectedProvider: GatewayRouteProvider | None = None
    routingStrategy: GatewayRoutingStrategy
    selectedReason: str
    cacheStatus: GatewayCacheStatus
    budgetDecision: GatewayBudgetDecision
    estimatedCostUsd: float | None = Field(default=None, ge=0)
    actualCostUsd: float | None = Field(default=None, ge=0)
    latencyMs: int = Field(ge=0)
    status: Literal["routed", "blocked", "not_configured", "failed", "rate_limited", "budget_exceeded"]
    generatedAt: str


class GatewayCacheEntry(BaseModel):
    id: str
    cacheKey: str
    environment: Literal["prod", "staging", "dev"]
    model: str | None = None
    responsePayload: dict[str, Any]
    promptTokens: int = Field(default=0, ge=0)
    completionTokens: int = Field(default=0, ge=0)
    costUsd: float = Field(default=0, ge=0)
    expiresAt: str
    createdAt: str
    hitCount: int = Field(default=0, ge=0)


class GatewayProviderMetric(BaseModel):
    id: str
    label: str
    requests: int = Field(ge=0)
    failures: int = Field(ge=0)
    avgLatencyMs: int = Field(ge=0)
    spendUsd: float = Field(ge=0)


class GatewayMetrics(BaseModel):
    totalRequests: int = Field(ge=0)
    routedRequests: int = Field(ge=0)
    failedRequests: int = Field(ge=0)
    blockedRequests: int = Field(ge=0)
    cacheHits: int = Field(ge=0)
    estimatedSpendUsd: float = Field(ge=0)
    actualSpendUsd: float = Field(ge=0)
    providerBreakdown: list[GatewayProviderMetric]
    latestRoutes: list["GatewayRouteEvent"]


class GatewayCostSuggestion(BaseModel):
    id: str
    severity: Literal["info", "review", "high"]
    title: str
    detail: str
    estimatedSavingsUsd: float | None = Field(default=None, ge=0)


class GatewayRouteProvider(BaseModel):
    id: str
    label: str
    source: str
    priority: int


class GatewayRouteAttempt(BaseModel):
    provider: GatewayRouteProvider
    status: Literal["failed", "succeeded"]
    latencyMs: int = Field(ge=0)
    error: str | None = None


class GatewayRouteEvent(BaseModel):
    id: str
    traceId: str | None = None
    environment: Literal["prod", "staging", "dev"]
    requestedModel: str | None = None
    selectedProvider: GatewayRouteProvider | None = None
    status: Literal["routed", "blocked", "not_configured", "failed", "rate_limited", "budget_exceeded"]
    decision: Literal["allow", "review", "block"]
    attempts: list[GatewayRouteAttempt]
    routingStrategy: GatewayRoutingStrategy = "priority"
    selectedReason: str = "priority"
    retryCount: int = Field(default=0, ge=0)
    cacheStatus: GatewayCacheStatus = "disabled"
    budgetDecision: GatewayBudgetDecision = "allow"
    estimatedCostUsd: float | None = Field(default=None, ge=0)
    actualCostUsd: float | None = Field(default=None, ge=0)
    policyFindings: list[str] = Field(default_factory=list)
    generatedAt: str


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


class ReplayGateRequest(BaseModel):
    target: str = Field(default="production", min_length=1)
    providerMode: Literal["local", "auto", "live"] = "local"
    maxLatencyMs: int = Field(default=2500, ge=1)
    maxCostUsd: float = Field(default=1.0, ge=0)
    minScore: float = Field(default=0.85, ge=0, le=1)
    blockedPhrases: list[str] = Field(default_factory=list)
    requireLiveProvider: bool = False


class ReplayGateResult(BaseModel):
    id: str
    traceId: str
    target: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    providerMode: Literal["local", "auto", "live"]
    replay: ReplayResult
    checks: list[ReleaseGateCheck]
    originalOutput: str
    replayedOutput: str
    recommendations: list[str]
    generatedAt: str


class ReplayDatasetGateRequest(ReplayGateRequest):
    traceIds: list[str] = Field(default_factory=list, max_length=100)
    traceEnvironment: Literal["prod", "staging", "dev", "all"] = "all"
    limit: int = Field(default=25, ge=1, le=100)


class ReplayDatasetGateResult(BaseModel):
    id: str
    target: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    providerMode: Literal["local", "auto", "live"]
    traceCount: int = Field(ge=0)
    allowed: int = Field(ge=0)
    review: int = Field(ge=0)
    blocked: int = Field(ge=0)
    traceEnvironment: Literal["prod", "staging", "dev", "all"]
    results: list[ReplayGateResult]
    checks: list[ReleaseGateCheck]
    recommendations: list[str]
    generatedAt: str


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
    idempotencyKey: str | None = Field(default=None, min_length=1, max_length=200)


class TraceIngestResponse(BaseModel):
    trace: Trace
    auditId: str
    accepted: bool = True
    idempotencyKey: str | None = None


class TraceBatchIngestRequest(BaseModel):
    traces: list[TraceIngestRequest] = Field(min_length=1, max_length=100)


class TraceBatchIngestResponse(BaseModel):
    items: list[TraceIngestResponse]
    accepted: int = Field(ge=0)
    duplicates: int = Field(ge=0)
    auditId: str


class AuditEvent(BaseModel):
    id: str
    type: str
    actor: str
    subject: str
    decision: Literal["allow", "review", "block"]
    summary: str
    createdAt: str


class AccessRolePolicy(BaseModel):
    role: WorkspaceRole
    permissions: list[AccessPermission]
    description: str


class AccessCurrentUser(BaseModel):
    email: str
    role: WorkspaceRole
    permissions: list[AccessPermission]
    workspaceId: str


class AccessPolicyMatrix(BaseModel):
    workspaceId: str
    currentUser: AccessCurrentUser
    roles: dict[str, AccessRolePolicy]
    generatedAt: str


class AccessCheckRequest(BaseModel):
    permission: AccessPermission
    subject: str = Field(default="manual-check", min_length=1, max_length=200)


class AccessCheckResult(BaseModel):
    allowed: bool
    decision: Literal["allow", "block"]
    role: WorkspaceRole
    permission: AccessPermission
    subject: str
    reason: str


class ProductionReadinessCheck(BaseModel):
    id: str
    label: str
    state: Literal["pass", "review", "block"]
    detail: str


class ProductionReadinessReport(BaseModel):
    workspaceId: str
    decision: Literal["allow", "review", "block"]
    score: int = Field(ge=0, le=100)
    checks: list[ProductionReadinessCheck]
    blockers: list[str]
    generatedAt: str


class ApiEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    data: Any
