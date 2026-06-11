# NeuralOps Production Onboarding + Proof Loop Design

Date: 2026-06-11
Status: Proposed
Owner: NeuralOps

## Executive Summary

NeuralOps already contains strong enterprise-grade pieces: gateway routing, trace ingestion, evals, replay gates, RAG checks, policies, incidents, cost, evidence, SLOs, estate graph, SDKs, auth, and governance pages.

The next product problem is not another standalone module. The product needs a sharper adoption loop that makes a new user successful quickly:

> Connect one real AI app, route or ingest one real request, prove NeuralOps caught something useful, and produce release evidence.

This design adds a guided Production Onboarding + Proof Loop that turns the existing platform into a coherent product journey.

## Real Problem

Enterprise AI teams do not adopt an AI ops platform because it has many dashboards. They adopt it when it gives them fast operational proof:

- Their real app can connect without confusion.
- Their model calls can be observed or routed.
- Risky prompts and outputs can be blocked or reviewed.
- Costs and latency can be measured honestly.
- Release readiness can be proven before production.
- Security and platform teams can export evidence.

Current NeuralOps has most of the technical pieces, but the first-use path is still too spread out across many screens. A user may see the product as powerful but not immediately know what to do first.

## Goals

1. Make the first 5 minutes of NeuralOps obvious and useful.
2. Convert existing features into one visible proof loop.
3. Ensure every onboarding step is backed by real backend state.
4. Remove fake-looking claims and replace them with explicit state:
   - `not_configured`
   - `configured`
   - `persisted`
   - `live_provider`
   - `blocked`
   - `ready`
5. Give enterprise users a readiness score they can trust.
6. Preserve advanced features while making the default path simpler.

## Non-Goals

- Do not add a desktop app.
- Do not add mobile apps.
- Do not add another broad dashboard tab.
- Do not invent fake provider responses.
- Do not require paid APIs for the basic proof loop.
- Do not deploy before local and deployed checks pass.
- Do not replace the current FastAPI/React/Supabase architecture.

## Target Users

### AI Engineer

Needs to connect an app, send traces, test prompts, and route model calls.

### Platform Engineer

Needs to enforce policy, track latency/cost, and verify production readiness.

### Security/Governance Reviewer

Needs evidence showing what was tested, what was blocked, and why a release is allowed or blocked.

### Startup Founder/Builder

Needs a credible production AI control plane demo that shows real integrations, not static mock dashboards.

## Product Positioning

New primary positioning:

> NeuralOps is the production readiness loop for AI apps: connect, observe, gate, route, and prove every release.

Short version:

> CI/CD, gateway, and evidence for production AI.

## Proposed User Journey

### Step 1: Create Or Enter Workspace

The user lands on Home and sees a Production Launch Checklist.

Required state:

- Auth session exists.
- Workspace exists.
- API key exists or can be generated.
- Backend health is visible.
- Database mode is visible: SQLite, Supabase Postgres, or unavailable.

### Step 2: Connect First App

The Connect page shows one primary path:

1. Generate NeuralOps ingest key.
2. Copy SDK or curl snippet.
3. Send a test trace.
4. Confirm trace persisted.

The user should not have to understand every advanced feature first.

### Step 3: Route First Gateway Call

If a provider is configured:

- Send a real OpenAI-compatible gateway request.
- Store route decision.
- Store trace.
- Store cost/latency/policy metadata.
- Show provider path.

If no provider is configured:

- Show `not_configured`.
- Offer deterministic local policy proof instead.
- Do not fake model output.

### Step 4: Trigger Proof Event

NeuralOps should provide a safe built-in proof drill:

- Prompt injection attempt.
- Secret exfiltration attempt.
- Cost spike simulation.
- Latency failure simulation.

These are clearly labeled as local drills. They should create persisted traces, policy decisions, incidents, or evidence records.

### Step 5: Run Release Readiness

The user runs one release gate:

- eval checks
- policy checks
- latency/cost thresholds
- gateway readiness
- trace coverage
- evidence export

Result:

- `allow`
- `review`
- `block`

The result links to exact evidence.

### Step 6: Export Evidence

The Evidence page exports:

- JSON report
- Markdown report
- readiness summary
- failed checks
- latest trace IDs
- gateway route events
- policy decisions
- audit events

## Information Architecture

Keep the consolidated workflow model:

- Home
- Connect
- Observe
- Test & Release
- Govern
- Admin

Add stronger first-use emphasis:

### Home

Primary content:

- Production Launch Checklist
- Readiness Score
- Current Blockers
- Latest Proof Events
- Next Best Action

Secondary:

- Action Center
- High-level metrics

### Connect

Primary content:

- API key generation
- SDK snippets
- curl test trace
- Gateway first call
- Provider readiness
- OTel ingest setup

### Observe

Primary content:

- Traces
- Estate Graph
- Incidents
- Cost

### Test & Release

Primary content:

- Replay Gate
- Eval Center
- Prompt Registry
- RAG Quality
- Agent Labs

### Govern

Primary content:

- Policies
- SLOs
- Risk Register
- Control Center
- Evidence
- Detections
- Automations

### Admin

Primary content:

- Access
- Workspace settings
- Provider metadata
- Audit
- Deployment readiness

## Backend Design

Add or consolidate a `production_readiness` layer that aggregates existing persisted records.

### New/Updated API Endpoints

```text
GET  /api/onboarding/status
POST /api/onboarding/send-test-trace
POST /api/onboarding/run-proof-drill
POST /api/onboarding/recheck
GET  /api/readiness/score
POST /api/readiness/run
GET  /api/readiness/latest
GET  /api/evidence/latest-proof-loop
```

### `GET /api/onboarding/status`

Returns the truth state for setup:

```json
{
  "workspace": { "state": "configured" },
  "database": { "state": "persisted", "mode": "supabase_postgres" },
  "auth": { "state": "configured" },
  "ingestKey": { "state": "configured" },
  "firstTrace": { "state": "persisted", "traceId": "tr_..." },
  "provider": { "state": "not_configured" },
  "gateway": { "state": "not_configured" },
  "policy": { "state": "configured" },
  "evidence": { "state": "persisted" }
}
```

### `POST /api/onboarding/send-test-trace`

Creates one clearly labeled test trace:

- source: `onboarding_test`
- environment: `sandbox`
- no provider call
- stored in database
- visible in Trace Explorer
- creates audit event

### `POST /api/onboarding/run-proof-drill`

Allowed drill types:

- `prompt_injection`
- `secret_exfiltration`
- `latency_regression`
- `cost_spike`
- `unsafe_tool_request`

Each drill must:

- be labeled as local drill
- store trace or event
- run policy engine
- create evidence
- never claim live provider behavior

### `GET /api/readiness/score`

Calculates a score from real state:

- auth configured
- database persisted
- trace ingestion present
- gateway configured or honestly unavailable
- provider configured or honestly unavailable
- policy engine active
- release gate has run
- evidence export exists
- critical incidents open
- SLO status

Example:

```json
{
  "score": 72,
  "decision": "review",
  "blockers": [
    "No live provider configured",
    "No successful gateway route yet"
  ],
  "ready": [
    "Auth configured",
    "Database persisted",
    "Trace ingestion verified",
    "Policy engine active"
  ]
}
```

## Frontend Design

### Production Launch Checklist Component

Each item shows:

- title
- state badge
- short explanation
- CTA
- linked destination
- last checked time

States:

- `complete`
- `blocked`
- `not_configured`
- `optional`
- `running`

Checklist items:

1. Workspace exists.
2. Database connected.
3. Auth enabled.
4. Ingest key generated.
5. First trace received.
6. Provider configured.
7. Gateway call routed.
8. Policy proof drill completed.
9. Release gate completed.
10. Evidence exported.

### Readiness Score Card

The score must not look like a vanity number. It should explain exactly why it is not 100.

Display:

- Score
- Decision: allow/review/block
- top blockers
- last successful proof event
- export evidence button

### Proof Timeline

Show the latest persisted events:

- test trace sent
- risky prompt blocked
- replay gate run
- gateway route created
- evidence exported

Each item links to its record.

### Honest Empty States

Examples:

- "No traces yet. Send one trace from Connect."
- "Gateway is not configured. Add a provider key server-side to route live calls."
- "No evidence yet. Run a proof drill or release gate."
- "No provider data. NeuralOps will not invent model output."

## SDK And CLI Design

The SDK should support the onboarding path.

### JavaScript CLI

```powershell
node sdk/javascript/bin/neuralops.mjs onboarding status
node sdk/javascript/bin/neuralops.mjs onboarding send-test-trace
node sdk/javascript/bin/neuralops.mjs onboarding proof-drill prompt-injection
node sdk/javascript/bin/neuralops.mjs readiness run --fail-on block
```

### Python CLI/Module

```powershell
python -m neuralops_sdk.onboarding status
python -m neuralops_sdk.onboarding send_test_trace
python -m neuralops_sdk.readiness run
```

## Data Truth Rules

Every user-facing feature must fit one of these categories:

- `persisted`: backed by database record
- `live_provider`: produced by configured provider
- `local_drill`: deterministic local proof
- `not_configured`: unavailable until setup is complete
- `derived`: computed from persisted records

Forbidden states:

- fake production
- fake provider result
- fake cost savings
- fake healthy status when no evidence exists

## Security Requirements

- Never expose provider keys in browser.
- Never log full NeuralOps keys.
- Readiness exports must redact secrets.
- API keys must be scoped.
- Workspace isolation must be enforced.
- Local drills must not send data externally.
- Supabase RLS verification remains required for production.

## Testing Plan

### Backend Tests

- empty onboarding status is truthful
- send-test-trace creates persisted trace
- proof drill creates policy/evidence records
- readiness score is derived from real records
- missing provider does not block local proof but marks gateway not configured
- provider configured enables gateway readiness
- workspace isolation applies to onboarding and readiness APIs
- redaction works in evidence export

### Frontend Tests

- Home shows launch checklist
- checklist CTA opens correct route
- send test trace updates checklist
- proof drill appears in timeline
- readiness score updates after release gate
- no clipped text in light/dark mode
- mobile layout remains usable

### SDK Tests

- onboarding status command redacts keys
- send-test-trace command calls backend correctly
- proof-drill command records expected decision
- readiness run exits non-zero for block when configured

### Full Verification

```powershell
python -m pytest backend
cmd /c npm run test:sdk
cmd /c npm run lint
cmd /c npm run build
cmd /c npx playwright test
cmd /c npm audit --audit-level=moderate
```

## Rollout Plan

### Phase 1: Backend Truth Layer

- Add onboarding/readiness APIs.
- Derive state from existing records.
- Add backend tests.

### Phase 2: Product UI Loop

- Upgrade Home and Connect around the checklist.
- Add readiness score and proof timeline.
- Add CTAs to existing pages.

### Phase 3: SDK/CLI Support

- Add onboarding commands.
- Add readiness command.
- Redaction tests.

### Phase 4: E2E Proof

- Playwright completes first-use flow.
- Screenshot proof generated.
- Deployed smoke tests remain skipped unless deployed env credentials exist.

## Open Questions

1. Should live provider setup be required for a score above 80, or can local deterministic proof reach 80?
2. Should production readiness score be visible to all workspace users or only admins?
3. Should exported readiness evidence include raw prompts by default, or redact by default with an admin override?

## Recommendation

Proceed with this design before adding more standalone features.

This upgrade is the right next step because it turns NeuralOps from a large set of advanced capabilities into a product with a clear enterprise adoption path:

```text
Connect -> Prove -> Gate -> Monitor -> Govern
```

That is the loop a real AI platform team can understand, demo, test, and deploy.
