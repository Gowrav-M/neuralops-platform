from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from hashlib import sha1

import httpx

from .config import load_local_env
from .provider_catalog import RuntimeProvider, list_provider_statuses, runtime_providers
from .schemas import (
    AgentDefinition,
    AgentEvalCheck,
    AgentRunRecord,
    AgentRunRequest,
    ProviderStatus,
    Trace,
    TraceSpan,
)

load_local_env()

AGENT_DEFINITIONS: list[AgentDefinition] = [
    AgentDefinition(
        id="support_triage",
        name="Support Triage Agent",
        role="Classifies enterprise tickets, detects urgency, assigns owner, and blocks unsafe instructions.",
        industrySignal="Customer operations agent with policy controls, evals, cost, and trace evidence.",
        defaultModel="gpt-4o-mini",
        capabilities=["ticket classification", "policy detection", "owner routing", "incident summary"],
        riskControls=["prompt-injection replay", "credential exfiltration guard", "human-review routing"],
    ),
    AgentDefinition(
        id="rag_answer",
        name="RAG Answer Agent",
        role="Answers from a small controlled knowledge pack and scores groundedness.",
        industrySignal="Production RAG workflow with faithfulness checks and traceable context.",
        defaultModel="gpt-4o-mini",
        capabilities=["retrieval", "answer synthesis", "faithfulness scoring", "source citation"],
        riskControls=["context-grounding check", "missing-evidence review", "PII guard"],
    ),
    AgentDefinition(
        id="cost_anomaly",
        name="AI FinOps Analyst",
        role="Investigates model spend spikes and recommends budget controls.",
        industrySignal="AI cost governance and operational anomaly workflow.",
        defaultModel="nvidia-nim-qwen3-coder",
        capabilities=["spend analysis", "budget risk scoring", "root-cause summary", "remediation plan"],
        riskControls=["budget envelope check", "blast-radius summary", "approval gate"],
    ),
    AgentDefinition(
        id="code_review",
        name="Code Review Agent",
        role="Reviews code snippets for correctness, security, maintainability, and test gaps.",
        industrySignal="Developer productivity agent with deterministic review evidence.",
        defaultModel="nvidia-nim-qwen3-coder",
        capabilities=["code review", "security finding detection", "test-gap analysis", "patch recommendation"],
        riskControls=["dangerous-command detection", "secret scan", "sandbox recommendation"],
    ),
]


KNOWLEDGE_PACK = {
    "billing": "Enterprise API keys are billed monthly by workspace usage, retention tier, and support plan.",
    "support": "Support agents may access billing data only through scoped billing tools after policy approval.",
    "retention": "Default trace retention is 30 days for developer workspaces and 180 days for regulated workspaces.",
    "incident": "Critical AI incidents require an on-call owner, customer impact note, policy result, and replay artifact.",
}


def list_providers() -> list[ProviderStatus]:
    return list_provider_statuses()


def get_agent(agent_id: str) -> AgentDefinition | None:
    return next((agent for agent in AGENT_DEFINITIONS if agent.id == agent_id), None)


def run_agent(request: AgentRunRequest) -> tuple[AgentRunRecord, Trace]:
    agent = get_agent(request.agentId)
    if agent is None:
        raise ValueError(f"Unknown agentId: {request.agentId}")

    started = time.perf_counter()
    provider, model, output = _execute(agent, request)
    latency_ms = max(1, int((time.perf_counter() - started) * 1000))
    policy_findings = detect_policy_findings(request.input, output)
    evals = evaluate_agent_output(agent.id, request.input, output, policy_findings)
    decision = _decision(policy_findings, evals)
    score = _score(evals, decision)
    tokens = estimate_tokens(request.input + "\n" + output)
    cost_usd = round(tokens * 0.000015, 5)
    run_id = f"run_{_stable_id(agent.id + request.input + output + str(time.time()))[:12]}"
    trace_id = f"trace_{run_id[-12:]}"
    created_at = datetime.now(timezone.utc).isoformat()

    run = AgentRunRecord(
        id=run_id,
        agentId=agent.id,
        agentName=agent.name,
        provider=provider,
        model=model,
        input=request.input,
        output=output,
        decision=decision,
        score=score,
        evals=evals,
        policyFindings=policy_findings,
        latencyMs=latency_ms,
        tokens=tokens,
        costUsd=cost_usd,
        traceId=trace_id,
        createdAt=created_at,
    )
    trace = _run_to_trace(run, request.environment)
    return run, trace


def detect_policy_findings(user_input: str, output: str) -> list[str]:
    text = f"{user_input}\n{output}".lower()
    findings: list[str] = []
    if any(pattern in text for pattern in ("ignore previous", "ignore standard", "system prompt", "developer message")):
        findings.append("prompt-injection")
    if any(pattern in text for pattern in ("api key", "password", "secret", "token", "credential")):
        findings.append("credential-language")
    if any(pattern in text for pattern in ("webhook", "external url", "post to", "send to slack", "email")):
        findings.append("external-sink")
    if any(pattern in text for pattern in ("rm -rf", "curl | sh", "invoke-webrequest", "powershell", "shell exec")):
        findings.append("dangerous-command")
    return sorted(set(findings))


def evaluate_agent_output(agent_id: str, user_input: str, output: str, findings: list[str]) -> list[AgentEvalCheck]:
    checks = [
        AgentEvalCheck(
            name="Policy safety",
            status="fail" if {"credential-language", "external-sink"}.issubset(findings) else "warn" if findings else "pass",
            score=0.2 if {"credential-language", "external-sink"}.issubset(findings) else 0.72 if findings else 0.97,
            reason="Detected risky instruction or secret/sink language." if findings else "No local policy pattern matched.",
        ),
        AgentEvalCheck(
            name="Actionability",
            status="pass" if len(output) > 120 and any(word in output.lower() for word in ("recommend", "next", "owner", "action", "block", "review")) else "warn",
            score=0.9 if len(output) > 120 else 0.65,
            reason="Output includes operational next steps." if len(output) > 120 else "Output is short; review before production use.",
        ),
    ]

    if agent_id == "rag_answer":
        grounded = any(key in user_input.lower() or key in output.lower() for key in KNOWLEDGE_PACK)
        checks.append(
            AgentEvalCheck(
                name="Groundedness",
                status="pass" if grounded else "fail",
                score=0.93 if grounded else 0.25,
                reason="Answer cites controlled knowledge pack." if grounded else "No matching controlled context found.",
            )
        )
    elif agent_id == "code_review":
        checks.append(
            AgentEvalCheck(
                name="Security review",
                status="fail" if "dangerous-command" in findings else "pass",
                score=0.3 if "dangerous-command" in findings else 0.91,
                reason="Dangerous command pattern requires sandbox review." if "dangerous-command" in findings else "No dangerous command detected.",
            )
        )
    return checks


def estimate_tokens(text: str) -> int:
    return max(1, len(text.split()) + len(text) // 5)


def _execute(agent: AgentDefinition, request: AgentRunRequest) -> tuple[str, str, str]:
    if request.provider == "local":
        if request.providerMode != "local":
            raise RuntimeError("The local provider requires providerMode=local.")
        model = request.model or agent.defaultModel or "local-neuralops-agent"
        return "local", model, _run_local_agent(agent.id, request.input)
    if request.provider is not None:
        if request.providerMode != "live":
            raise RuntimeError("A named live provider requires providerMode=live.")
        live = _try_live_provider(agent, request, request.provider)
        if live is None:
            raise RuntimeError(f"Requested provider {request.provider} is not configured or did not succeed.")
        return live
    if request.providerMode in ("auto", "live"):
        live = _try_live_provider(agent, request)
        if live is not None:
            return live
        if request.providerMode == "live":
            raise RuntimeError("Live provider requested, but no configured provider/API key succeeded.")

    model = request.model or agent.defaultModel or "local-neuralops-agent"
    return "local", model, _run_local_agent(agent.id, request.input)


def _try_live_provider(
    agent: AgentDefinition,
    request: AgentRunRequest,
    selected_provider: str | None = None,
) -> tuple[str, str, str] | None:
    for provider in runtime_providers_for_environment(request.environment):
        if selected_provider is not None and provider.id != selected_provider:
            continue
        model = request.model or provider.default_model
        try:
            output = _call_openai_compatible(provider.base_url, provider.api_key, model, agent, request.input)
            return provider.id, model, output
        except httpx.HTTPError:
            continue
    return None


def runtime_providers_for_environment(environment: str) -> list[RuntimeProvider]:
    return [
        provider
        for provider in runtime_providers()
        if provider.environment in ("all", environment)
    ]


def _call_openai_compatible(base_url: str, api_key: str | None, model: str, agent: AgentDefinition, user_input: str) -> str:
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are NeuralOps agent runtime. Return concise operational analysis with: "
                    "decision, risk, evidence, next actions. Never reveal secrets."
                ),
            },
            {"role": "user", "content": f"Agent: {agent.name}\nRole: {agent.role}\nInput:\n{user_input}"},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    with httpx.Client(timeout=20) as client:
        response = client.post(
            f"{base_url.rstrip('/')}/chat/completions",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
    data = response.json()
    return str(data["choices"][0]["message"]["content"])


def _run_local_agent(agent_id: str, user_input: str) -> str:
    text = user_input.lower()
    local_decision = _input_risk_decision(text)
    if agent_id == "support_triage":
        priority = "P1 Critical" if any(word in text for word in ("down", "breach", "leak", "payment failed", "urgent")) else "P2 Review"
        owner = "Trust Engineering" if any(word in text for word in ("password", "secret", "api key", "ignore previous")) else "Customer Operations"
        return (
            f"Decision: {local_decision if local_decision != 'allow' else 'review'}\nPriority: {priority}\nOwner: {owner}\n"
            "Evidence: ticket language was classified for urgency, security keywords, and routing risk.\n"
            "Next actions: open incident if customer impact is active, block credential exposure, and attach trace replay evidence."
        )
    if agent_id == "rag_answer":
        matches = [value for key, value in KNOWLEDGE_PACK.items() if key in text]
        if not matches:
            return (
                "Decision: review\nAnswer: I do not have enough controlled context to answer this safely.\n"
                "Evidence: no matching knowledge-pack source was retrieved.\nNext actions: add source material or route to a human reviewer."
            )
        return (
            f"Decision: {local_decision}\nAnswer: "
            + " ".join(matches[:2])
            + (
                "\nEvidence: response is grounded in the local controlled knowledge pack, but the input contains safety-sensitive language.\n"
                "Next actions: route through guardrails before sending to a customer."
                if local_decision != "allow"
                else "\nEvidence: response is grounded in the local controlled knowledge pack.\nNext actions: cite the retrieved source in the customer response."
            )
        )
    if agent_id == "cost_anomaly":
        spike = any(word in text for word in ("spike", "increase", "budget", "cost", "$", "expensive"))
        return (
            f"Decision: {'review' if spike else 'allow'}\n"
            "Root cause hypothesis: model mix, retry loops, or long-context RAG calls increased spend.\n"
            "Evidence: request mentions budget/cost pressure and should be compared against model, feature, and workspace spend.\n"
            "Next actions: cap high-cost models, route low-risk traffic to smaller models, and create an incident if projected spend exceeds budget."
        )
    if agent_id == "code_review":
        danger = any(word in text for word in ("rm -rf", "curl | sh", "password", "eval(", "exec("))
        return (
            f"Decision: {'block' if danger else 'review'}\n"
            "Findings: checked correctness, security-sensitive calls, test gaps, and maintainability.\n"
            f"Risk: {'dangerous command or secret pattern detected' if danger else 'no critical local pattern detected'}.\n"
            "Next actions: add regression tests, isolate command execution in a sandbox, and require review before merge."
        )
    return "Decision: review\nEvidence: unknown agent workflow.\nNext actions: configure an agent definition."


def _input_risk_decision(text: str) -> str:
    has_credential = any(pattern in text for pattern in ("api key", "password", "secret", "token", "credential"))
    has_external_sink = any(pattern in text for pattern in ("webhook", "external url", "post to", "send to slack", "email"))
    has_prompt_injection = any(pattern in text for pattern in ("ignore previous", "ignore standard", "system prompt", "developer message"))
    has_dangerous_command = any(pattern in text for pattern in ("rm -rf", "curl | sh", "invoke-webrequest", "powershell", "shell exec"))
    if has_dangerous_command or (has_credential and has_external_sink):
        return "block"
    if has_credential or has_external_sink or has_prompt_injection:
        return "review"
    return "allow"


def _decision(findings: list[str], evals: list[AgentEvalCheck]) -> str:
    if any(check.status == "fail" for check in evals) or {"credential-language", "external-sink"}.issubset(findings):
        return "block"
    if findings or any(check.status == "warn" for check in evals):
        return "review"
    return "allow"


def _score(evals: list[AgentEvalCheck], decision: str) -> float:
    if not evals:
        return 0.5
    base = sum(check.score for check in evals) / len(evals)
    penalty = 0.25 if decision == "block" else 0.08 if decision == "review" else 0
    return round(max(0.0, min(1.0, base - penalty)), 2)


def _run_to_trace(run: AgentRunRecord, environment: str) -> Trace:
    status = "blocked" if run.decision == "block" else "warning" if run.decision == "review" else "success"
    return Trace(
        id=run.traceId,
        timestamp=datetime.now().strftime("%H:%M:%S"),
        session=run.id,
        environment=environment,  # type: ignore[arg-type]
        model=run.model,
        tokens=run.tokens,
        latency=f"{run.latencyMs / 1000:.2f}s",
        cost=f"${run.costUsd:.3f}",
        status=status,
        score=run.score,
        prompt=run.input,
        output=run.output,
        toolCalls=f"{run.agentId}.run",
        source=run.provider if run.provider in ("local",) else "api",
        spanCount=4,
        riskFlags=run.policyFindings,
        spans=[
            TraceSpan(id=f"{run.id}_plan", name="agent.plan", operation="plan", durationMs=max(1, run.latencyMs * 0.12), status="ok"),
            TraceSpan(id=f"{run.id}_policy", name="policy.evaluate", operation="guardrail", durationMs=max(1, run.latencyMs * 0.08), status="ok"),
            TraceSpan(id=f"{run.id}_model", name="model.invoke", operation="chat.completions", durationMs=max(1, run.latencyMs * 0.7), status="ok"),
            TraceSpan(id=f"{run.id}_eval", name="eval.replay", operation="evaluation", durationMs=max(1, run.latencyMs * 0.1), status="ok"),
        ],
    )


def _stable_id(value: str) -> str:
    return sha1(value.encode("utf-8")).hexdigest()
