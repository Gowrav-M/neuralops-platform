# Data Governance, Retention, And Legal Hold

NeuralOps stores operational AI evidence: traces, prompts, outputs, gateway route events, provider metadata, incidents, release gates, SLO results, audit events, and control exports. The Data Governance workflow answers four enterprise questions:

- What AI records exist in this workspace?
- How long should each domain be retained?
- Which records are protected by legal hold?
- What would be deleted, and what was actually deleted?

Data Governance lives in `Admin -> Settings`. It does not add another top-level page.

## Workflow

1. Review the inventory by domain.
2. Save the retention policy and governance mode.
3. Create legal holds for records that must not be deleted.
4. Run a purge simulation.
5. Type the exact confirmation string before running a real purge.
6. Review the governance evidence in the Evidence page.

Simulation is always non-destructive. Legal holds always win over retention rules.

## APIs

```text
GET   /api/data-governance/inventory
GET   /api/data-governance/policy
PUT   /api/data-governance/policy
GET   /api/data-governance/legal-holds
POST  /api/data-governance/legal-holds
PATCH /api/data-governance/legal-holds/{hold_id}
POST  /api/data-governance/purge/simulate
POST  /api/data-governance/purge/run
GET   /api/data-governance/evidence
```

Write actions require a role with `settings:write`. All records are workspace-scoped.

## Retention Policy

The policy defines:

- `retentionDays`: age threshold for deletion eligibility.
- `domains`: record domains included in governance.
- `mode`: `monitor` or `enforced`.

The first saved policy is also a production-readiness signal. Before policy setup and purge simulation, readiness reports governance as blocked.

## Legal Holds

A legal hold contains a name, reason, covered domains, and optional match text. Matching records are reported as protected during inventory and simulation, and are skipped during confirmed purge.

## Purge Safety

`/purge/simulate` returns an exact confirmation string such as:

```text
PURGE purge_sim_abc123
```

`/purge/run` rejects the request unless the confirmation string matches exactly. The backend recomputes eligible records immediately before deletion, so newly protected records are not deleted.

Every policy change, hold change, simulation, and purge execution writes an audit event. Audit records never include provider secrets.
