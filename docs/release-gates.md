# Release Gates

NeuralOps release gates turn production AI requirements into a repeatable approval check.

The gate reads current backend evidence:

- trace volume
- failure/block rate
- latency budget
- eval pass rate
- prompt registry evidence
- RAG grounding evidence
- live provider readiness
- auth readiness

## UI Flow

1. Open Evidence & Release Gate.
2. Configure thresholds.
3. Save a gate definition.
4. Run the saved gate.
5. Use the generated gate ID in CLI or GitHub Actions.

## CLI

Run an ad hoc gate:

```powershell
cmd /c npm run release:gate -- --base-url http://localhost:8000 --target ci --require-auth false --fail-on block
```

Run a saved gate:

```powershell
node sdk\javascript\bin\neuralops.mjs release-gate run `
  --base-url http://localhost:8000 `
  --gate-id rg_your_gate_id `
  --fail-on review
```

Exit codes:

- `0`: decision is below the fail threshold.
- `1`: gate decision failed the requested threshold.
- `2`: CLI/API usage error.

## GitHub Actions

This repository includes a local action in `action.yml` and example workflow in `.github/workflows/release-gate.yml`.

```yaml
- name: Run NeuralOps gate
  uses: ./
  with:
    base-url: http://127.0.0.1:8000
    target: ci
    require-auth: "false"
    fail-on: block
```

For public production gates, set `NEURALOPS_AUTH_REQUIRED=true`, configure Postgres/Supabase storage, connect a live provider, and ingest trace/eval/RAG evidence before the gate runs.

