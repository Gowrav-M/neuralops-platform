# Supabase Production Setup

NeuralOps supports two storage modes:

- `sqlite`: default local development and test mode.
- `postgres`: production mode using Supabase Postgres.

## Current Project

Configured MCP project:

```text
cjcsinixideeqiwzdvna
```

MCP server URL:

```text
https://mcp.supabase.com/mcp?project_ref=cjcsinixideeqiwzdvna
```

The production table is intentionally created in a private schema:

```text
neuralops_private.records
```

This schema is not granted to Supabase `anon` or `authenticated` Data API roles. The FastAPI backend should access it through a server-side Postgres connection string.

## Required Environment

Backend-only:

```env
NEURALOPS_DATABASE_URL=postgresql://postgres.cjcsinixideeqiwzdvna:<password>@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require
NEURALOPS_POSTGRES_SCHEMA=neuralops_private
NEURALOPS_POSTGRES_TABLE=records
```

Use the Supabase **Shared Pooler / Transaction pooler** URI for local and deployed FastAPI services on IPv4 networks. The direct host `db.cjcsinixideeqiwzdvna.supabase.co:5432` is IPv6-only for this project and may time out on IPv4 networks.

Frontend/client-only:

```env
VITE_SUPABASE_URL=https://cjcsinixideeqiwzdvna.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

The publishable key is safe for frontend auth and client reads governed by RLS, but it cannot run migrations and should not be used as the backend storage credential.

## Migration

The migration files are:

```text
supabase/migrations/001_neuralops_records.sql
supabase/migrations/002_workspace_rls.sql
```

They create:

- private schema `neuralops_private`
- table `records`
- JSONB payload storage
- primary key on `(domain, id)`
- domain/time and JSONB GIN indexes
- RLS enabled
- revoked access from `anon` and `authenticated`
- updated-at trigger
- trusted workspace helper using Supabase JWT `app_metadata`
- select/insert/update/delete RLS policies for authenticated workspace rows

The table remains private by default. Do not grant Data API access unless you intentionally want browser/client access. If you later grant `authenticated` access, the second migration makes rows visible only when `payload.workspaceId` matches `app_metadata.neuralops_workspace_id` or `app_metadata.workspace_id`. It never uses user-editable metadata for authorization.

Apply migrations only after reviewing the SQL:

```powershell
supabase db push
```

or paste the reviewed SQL into Supabase SQL Editor.

## Verification

Run the packaged verification command:

```powershell
cmd /c npm run db:verify-rls
```

Expected:

```text
rls_verified=neuralops_private.records
```

Or verify manually:

```sql
select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'neuralops_private' and c.relname = 'records';
```

Expected:

```text
rls_enabled = true
```

Check RLS policy names:

```sql
select policyname, cmd, roles
from pg_policies
where schemaname = 'neuralops_private' and tablename = 'records'
order by policyname;
```

Expected policies:

```text
records_workspace_delete
records_workspace_insert
records_workspace_select
records_workspace_update
```

Start the API with `NEURALOPS_DATABASE_URL` set, then call:

```powershell
Invoke-RestMethod http://localhost:8000/health
```

Expected:

```json
{
  "ok": true,
  "storage": "postgres"
}
```
