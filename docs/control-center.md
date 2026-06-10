# Control Center

The Control Center turns NeuralOps records into an audit-ready control matrix.

It is not a certification engine and it does not invent compliance status. Each control is derived from persisted backend evidence such as traces, release gates, replay gates, AI SLO evaluations, gateway route events, estate graph records, access audit events, incidents, provider calibrations, and risk exceptions.

## What It Solves

Enterprise AI teams often have working traces, policies, evals, and dashboards, but still cannot answer procurement or security review questions quickly:

- Which AI controls are covered by evidence?
- Which controls are blocked?
- Which records prove the answer?
- What should the team fix next?
- Can we export one review packet?

Control Center gives a single evidence matrix for those questions.

## API

```powershell
Invoke-RestMethod http://localhost:8000/api/control-center
Invoke-RestMethod -Method Post http://localhost:8000/api/control-center/export
```

## Control Areas

- AI traffic observability
- Release gate evidence
- Gateway policy enforcement
- AI SLO and error-budget evaluation
- AI estate ownership
- Accepted-risk workflow
- Access audit
- Incident and detection response
- Provider cost and health measurement

## Decisions

- `pass`: stored evidence exists and no blocking condition is active.
- `review`: evidence is missing or incomplete, but not actively blocking.
- `block`: active evidence indicates a high-risk condition, such as blocked release gate, critical accepted risk, critical incident, or unresolved unsafe traces.

## Export

`POST /api/control-center/export` stores a control export record and writes an audit event. The export contains JSON and Markdown representations so teams can attach it to release reviews, security reviews, or procurement evidence packets.
