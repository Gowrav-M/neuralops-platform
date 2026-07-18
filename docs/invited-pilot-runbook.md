# NeuralOps Invited Pilot Runbook

This runbook is the operating contract for the 5-20 team Agent Command Center pilot. It covers onboarding, access, credentials, cold starts, emergency controls, incidents, privacy, and offboarding.

## Pilot boundaries

- Access is invitation-only. Public self-service billing is not enabled.
- The backend may sleep on the Render free tier. The product reports `checking`, `warming`, `ready`, or `unavailable` and waits at most 90 seconds.
- High-risk actions fail closed. No approval is inferred from a timeout or unavailable backend.
- Raw prompts, outputs, tool arguments, files, provider secrets, and agent credentials are not retained in metadata-only mode.
- Do not use the pilot for safety-critical, regulated production workloads without a separate written review.

## Roles

| Role | Pilot responsibility |
| --- | --- |
| Owner | Accept commercial terms, approve production agent access, own incidents |
| Admin | Onboard identities, approve high-risk actions, rotate credentials |
| Security | Block or revoke approvals and operate emergency stop |
| Developer | Integrate agents and request access; cannot self-approve |

## Team onboarding

1. Confirm the team's Owner, security contact, intended agents, environments, providers, and retention requirement.
2. Invite named users only. Do not use shared user accounts.
3. Register each agent identity separately with the smallest required provider, tool, environment, and permission boundaries.
4. Deliver the one-time agent credential through the team's approved secret manager. NeuralOps cannot retrieve it later.
5. Run a staging metadata-read canary and confirm an active short-lived lease is issued.
6. Run a staging shell canary and confirm it enters review rather than being allowed.
7. If production access is needed, require a current Owner or Admin approval before switching the agent to production.
8. Record pilot start date, retention selection, escalation contact, and success metric in the internal pilot record.

## Credential rotation

Rotate immediately when a credential may have been exposed, an operator leaves, the integration boundary changes, or at the team's agreed rotation interval.

1. Open the identity in Agent Command Center and select **Rotate credential**.
2. Save the newly displayed one-time credential directly into the integration's secret manager.
3. Update and restart the agent integration.
4. Run a low-risk staging authorization canary.
5. Confirm the previous credential is rejected and no unexpected authorization failures remain.

Never paste a credential into tickets, chat, logs, screenshots, or source control.

## Emergency shutdown

Use emergency stop for suspected compromise, runaway execution, policy bypass, or unsafe external communication.

1. Select the affected identity and activate **Emergency stop** with a specific reason.
2. Confirm queued jobs and active authorization leases are revoked and new runs are denied.
3. If scope is uncertain, stop every identity sharing the credential, provider account, or automation path.
4. Revoke the provider-side key independently when provider access may be compromised.
5. Preserve audit and evidence metadata by placing affected records on legal hold when required.
6. Open an incident record and notify the pilot Owner and security contact.

Emergency stop is not reversible by an agent. Re-enable only after containment, credential rotation, boundary review, and Owner or Admin approval.

## Incident response

### Severity

- **SEV-1:** unauthorized production action, secret exposure, cross-tenant access, or destructive execution.
- **SEV-2:** repeated policy bypass attempts, incorrect approval/lease state, or material audit loss.
- **SEV-3:** cold start beyond 90 seconds, degraded UI, or non-sensitive telemetry delay.

### Response

1. Contain: emergency-stop identities and revoke provider credentials as needed.
2. Preserve: retain audit events, evidence hashes, approval records, lease metadata, and deployment evidence. Do not copy raw customer content into the incident record.
3. Assess: identify workspace, identity, action, provider, environment, actor, timestamps, approval, and lease.
4. Eradicate: rotate credentials, narrow boundaries, revoke stale approvals, and patch the control path.
5. Recover: run low-risk and high-risk canaries before production is restored.
6. Review: deliver a timeline, root cause, impact, corrective actions, and retention decision to the pilot Owner.

## Cold-start handling

- `GET /health` proves the API process is reachable and reports the configured storage backend.
- `GET /ready` proves startup completed and the Postgres database can answer a bounded query.
- The UI preserves an idempotent intended action while warming and retries with bounded backoff for no more than 90 seconds.
- At 90 seconds, report `unavailable`; never report the action as successful.
- Do not send artificial keep-alive traffic to bypass free-tier sleeping.

High-risk requests are never approved from a cached UI state. If NeuralOps is unavailable, they remain blocked.

## Privacy, retention, and legal hold

The default record contains identity and action IDs, tool category, environment, timing, model/provider, token/cost totals, status, policy findings, and content hashes. It excludes raw prompts, outputs, arguments, secrets, and files.

- Apply the workspace retention policy to identities, approvals, leases, agent jobs, pilot applications, and audit events.
- A legal hold prevents expiry for the selected records until an authorized operator releases it.
- Export or deletion requests must be scoped to one workspace and logged.
- Encrypted content capture is outside the default pilot path and requires an explicit workspace decision and security review.

## Deployment acceptance

Every main deployment must retain evidence showing:

- frontend returns successfully;
- backend becomes ready within 90 seconds;
- `/health` and `/ready` report Postgres readiness;
- Supabase RLS verification passes;
- authenticated private API access succeeds;
- a cross-workspace request is denied;
- a synthetic low-risk agent receives a scoped lease;
- a high-risk shell action without approval is not allowed;
- dependency audit, lint, build, SDK, backend, and desktop/mobile browser tests pass.

Do not invite a new pilot team while this gate is failing.

## Offboarding

1. Emergency-stop or revoke every team identity.
2. Revoke outstanding approvals, leases, invitations, API keys, and provider credentials.
3. Remove user membership after confirming no required evidence ownership is lost.
4. Apply the contracted retention/deletion decision and preserve legal holds.
5. Export the agreed pilot outcome report without raw content.
6. Record the offboarding date and commercial disposition: converted, paused, or closed.

## Required production configuration

- `NEURALOPS_AUTH_REQUIRED=true`
- Supabase connection and JWT verification settings
- `NEURALOPS_QA_AUTH_TOKEN` and `NEURALOPS_QA_WORKSPACE_ID` for deployment acceptance
- `NEURALOPS_PILOT_OPERATIONS_WORKSPACE_ID` for internal pilot application ownership
- A stable `NEURALOPS_PILOT_RATE_LIMIT_SALT`
- Render `RENDER_API_KEY` and database URL stored only as protected GitHub/Render secrets

Never commit these values. Rotate any value that appears in CI output or a support transcript.
