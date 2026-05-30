from __future__ import annotations

from .schemas import Incident, Stats, Trace


def build_stats(traces: list[Trace], incidents: list[Incident]) -> Stats:
    if not traces:
        return Stats(
            totalRequests=0,
            avgLatency="0.00s",
            p95Latency="0.00s",
            errorRate="0.0%",
            totalCost="$0.00",
            evalPassRate="0.0%",
            policyViolations=0,
            activeIncidents=sum(incident.status != "Resolved" for incident in incidents),
        )

    latencies = sorted(_seconds(trace.latency) for trace in traces)
    costs = [_money(trace.cost) for trace in traces]
    failed = sum(trace.status == "failed" for trace in traces)
    passed = sum(trace.score >= 0.8 and trace.status == "success" for trace in traces)
    violations = sum(trace.status in ("blocked", "warning") or bool(trace.riskFlags) for trace in traces)
    p95_index = min(len(latencies) - 1, int(round((len(latencies) - 1) * 0.95)))

    return Stats(
        totalRequests=len(traces),
        avgLatency=f"{sum(latencies) / len(latencies):.2f}s",
        p95Latency=f"{latencies[p95_index]:.2f}s",
        errorRate=f"{failed / len(traces) * 100:.1f}%",
        totalCost=f"${sum(costs):.2f}",
        evalPassRate=f"{passed / len(traces) * 100:.1f}%",
        policyViolations=violations,
        activeIncidents=sum(incident.status != "Resolved" for incident in incidents),
    )


def _seconds(value: str) -> float:
    try:
        return float(value.strip().lower().replace("s", ""))
    except ValueError:
        return 0.0


def _money(value: str) -> float:
    try:
        return float(value.strip().replace("$", ""))
    except ValueError:
        return 0.0
