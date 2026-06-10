# AI SLOs and Error Budgets

NeuralOps AI SLOs turn observed AI traffic into production contracts. Instead of only showing traces, the platform can answer: can this AI workflow be promoted without violating reliability, quality, policy, latency, or cost limits?

## What An AI SLO Measures

Each SLO is evaluated against persisted backend traces. NeuralOps does not fabricate health when there is no data.

- `p95 latency`: parsed from trace latency values.
- `success rate`: successful traces divided by matched traces.
- `average eval score`: average non-zero trace score.
- `policy violation rate`: blocked, failed, warning, or risk-flagged traces divided by matched traces.
- `cost window`: summed trace costs for the configured window.
- `error budget remaining`: how much failure budget remains based on the success-rate target.

## Workflow

1. Send real traces through the SDK, gateway, OpenTelemetry ingest, or agent runtime.
2. Create an SLO for an environment such as `prod` or `staging`.
3. Optionally set a service filter such as an app name, session prefix, or model identifier.
4. Evaluate the SLO.
5. Use the decision in release review:
   - `allow`: all checks pass.
   - `review`: at least one warning or no matching trace coverage.
   - `block`: at least one hard failure.

## API

```http
GET /api/slos
POST /api/slos
PATCH /api/slos/{slo_id}
POST /api/slos/evaluate
POST /api/slos/{slo_id}/evaluate
```

Write and evaluate actions require the same backend permission system as other release controls.

## Why This Matters

Enterprise AI teams need SRE-style control, not only dashboards. AI SLOs make release safety measurable: prompt changes, gateway routes, agent runs, and provider changes can be judged against a clear contract before production rollout.
