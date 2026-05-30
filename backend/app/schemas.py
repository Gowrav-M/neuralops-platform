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


class Evaluator(BaseModel):
    id: str
    name: str
    status: Literal["passing", "warning", "failing"]
    passRate: float = Field(ge=0, le=1)
    lastRun: str


class RagQuery(BaseModel):
    id: str
    query: str
    expected: str
    actual: str
    faithfulness: float = Field(ge=0, le=1)
    relevance: float = Field(ge=0, le=1)


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


class AgentRuntime(BaseModel):
    id: str
    name: str
    status: Literal["healthy", "degraded", "blocked"]
    model: str
    activeSessions: int = Field(ge=0)
    risk: Severity


class SettingsPayload(BaseModel):
    retentionDays: int = Field(ge=1)
    apiKeys: list[dict[str, Any]]
    webhooks: list[dict[str, Any]]
    teamMembers: list[dict[str, Any]]


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


class ApiEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    data: Any
