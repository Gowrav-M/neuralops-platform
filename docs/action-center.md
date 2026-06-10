# Action Center

The Action Center is NeuralOps' evidence-driven operator queue. It answers the practical enterprise question: what should the AI platform team fix first?

## Why It Exists

AI operations products can become a wall of dashboards. Enterprise teams need a prioritized queue that connects signals to owners and next actions.

The Action Center synthesizes backend evidence from:

- production readiness checks
- release gates
- AI SLO evaluations
- AI Estate Graph risk
- incidents
- detection and response cases
- provider calibration
- gateway/provider setup
- feature truth state

It does not create fake work. If the backend has no evidence, the queue shows setup or no-data actions.

## API

```http
GET /api/action-center
```

The response contains:

- `summary`: critical/high/medium/low counts and readiness score.
- `executiveBrief`: short leadership-readable summary lines.
- `items`: prioritized actions with owner, impact, evidence, next step, and destination page.

## Operator Flow

1. Open Action Center.
2. Review critical and high actions first.
3. Select an action.
4. Open the owning surface such as Readiness, Evidence, SLOs, Estate, Gateway, Detection, or Settings.
5. Fix the underlying system, then refresh the queue.

This turns NeuralOps from separate observability pages into a practical operations workflow.
