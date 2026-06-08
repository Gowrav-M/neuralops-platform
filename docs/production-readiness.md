# NeuralOps Production Readiness

NeuralOps should not be deployed publicly until the local release gate and E2E tests pass.

## Required Environments

- Frontend: Vercel Vite React deployment.
- Backend: Render FastAPI web service.
- Database/Auth: Supabase Postgres and Supabase Auth.

## Required Production Variables

Vercel:

```env
VITE_API_BASE_URL=https://<render-service>.onrender.com
VITE_REQUIRE_AUTH=true
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

Render:

```env
NEURALOPS_ENVIRONMENT=production
NEURALOPS_DATABASE_URL=<supabase-pooled-postgres-url>
NEURALOPS_CORS_ORIGINS=https://<vercel-domain>
NEURALOPS_AUTH_REQUIRED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWT_SECRET=<only-if-legacy-HS256-project>
NEURALOPS_SECRET_KEY=<random-long-secret-for-provider-key-encryption>
NEURALOPS_DELIVERY_SEND_ENABLED=false
NEURALOPS_GITHUB_SEND_ENABLED=false
GITHUB_TOKEN=<optional-github-fine-grained-token-for-pr-comments>
GROQ_API_KEY=<optional-env-provider>
NVIDIA_API_KEY=<optional-env-provider>
OPENAI_API_KEY=<optional-env-provider>
OPENROUTER_API_KEY=<optional-env-provider>
VERCEL_AI_GATEWAY_API_KEY=<optional-env-provider>
```

## Deployment Gate

Run before deployment:

```powershell
python -m pytest backend
cmd /c npm run lint
cmd /c npm run build
cmd /c npm audit --audit-level=moderate
cmd /c npm run test:e2e
```

Then open the Evidence page and run **Run Production Gate**. Public deployment is blocked until auth is enabled, CORS is restricted to the Vercel domain, and the backend reports `storage: postgres`.

For CI or a deployment terminal, run the backend readiness gate directly:

```powershell
$env:NEURALOPS_API_URL = "https://<render-service>.onrender.com"
$env:NEURALOPS_QA_AUTH_TOKEN = "<deployment-qa-token>"
cmd /c npm run production:ready -- --fail-on review
```

You can also use a real Supabase session token:

```powershell
node sdk/javascript/bin/neuralops.mjs production ready `
  --base-url "https://<render-service>.onrender.com" `
  --auth-token "<supabase-session-jwt>" `
  --workspace-id "<workspace-id>" `
  --fail-on review
```

The command calls `/api/production/readiness`, prints every deployment check, and exits non-zero when the decision meets the threshold. Use `--fail-on block` to allow review warnings during staging; use `--fail-on review` for final production launch.

Before sharing the public URL, open Settings and configure at least one real workspace operator. Workspace profile and member records are persisted through `/api/workspace/*`, and create/update/delete actions write audit events so the deployment has a basic ownership trail.

For live model calls, use Settings -> AI Provider Gateway Connections or inject provider env vars on Render. The product supports OpenRouter, Vercel AI Gateway, Groq, NVIDIA NIM, OpenAI, Together, Fireworks, Mistral, DeepSeek, Ollama, vLLM, LM Studio, and custom OpenAI-compatible endpoints. Provider API keys are encrypted server-side with `NEURALOPS_SECRET_KEY`; rotate keys before public deployment if any were pasted into local tooling or chat.

In authenticated mode, NeuralOps derives the active workspace from the verified Supabase JWT. Put `neuralops_workspace_id` or `workspace_id` in Supabase `app_metadata`; do not use user-editable metadata for authorization. If no workspace claim exists, the backend falls back to a user-scoped workspace id based on the token subject.

Workspace settings, API keys, webhooks, members, traces, release gates, evidence reports, agent runs, lab experiments, costs, and audit events are stored per workspace. This protects private operator data at the API layer, and `supabase/migrations/002_workspace_rls.sql` adds database-side RLS policies for defense in depth.

## Real Data Contract

Every visible feature must be one of:

- `persisted`: stored in Supabase/Postgres or local SQLite during development.
- `live_provider`: connected through a provider gateway record or server env provider.
- `local_drill`: deterministic local behavior for testing only.
- `not_configured`: unavailable until setup is complete.

The `/api/system/status` and `/api/evidence` endpoints are the source of truth for this contract.

## Connector Delivery Worker

Automation rules can create signed delivery attempts for Slack incoming webhooks, Jira/Atlassian webhooks, generic webhooks, and GitHub PR comments. Delivery attempts are stored in the backend first so operators have an audit trail before any external request leaves the system.

- `POST /api/connector-deliveries/process` with `sendExternal:false` performs a dry run and reports queued attempts.
- `POST /api/connector-deliveries/process` with `sendExternal:true` sends pending Slack/Jira/generic webhook attempts only when `NEURALOPS_DELIVERY_SEND_ENABLED=true`.
- `POST /api/github/pr-comment` records a dry-run PR comment by default. It posts to GitHub only when `sendExternal:true`, `NEURALOPS_GITHUB_SEND_ENABLED=true`, and `GITHUB_TOKEN` is set on the backend.

Use a fine-grained GitHub token scoped only to the target repository. Rotate any token that was pasted into local tooling before deploying publicly.
