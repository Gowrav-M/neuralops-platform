# Trace Replay Gate

Replay Gate answers one release question:

> If this production trace happened again under the candidate release, should we allow, review, or block promotion?

Run it from the API:

```powershell
Invoke-RestMethod -Method Post http://localhost:8000/api/traces/<trace_id>/replay-gate `
  -ContentType "application/json" `
  -Body '{"target":"production","providerMode":"local","maxLatencyMs":2500,"maxCostUsd":1,"minScore":0.85}'
```

Run it from the SDK CLI:

```powershell
node sdk/javascript/bin/neuralops.mjs replay-gate run --trace <trace_id> --fail-on review
```

Replay Gate checks:

- deterministic replay policy decision
- prompt injection and secret exfiltration paths
- latency regression budget
- cost budget
- minimum eval score
- blocked phrases from `.neuralops/policies.yaml`
- provider readiness when `providerMode=live`

Local replay is deterministic and does not invent model output. Live replay is blocked as `not_configured` until a real provider connection exists.

Results are persisted under `replay_gates`, written to audit, and included in `/api/evidence`.
