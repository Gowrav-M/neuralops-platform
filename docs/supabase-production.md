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
NEURALOPS_DATABASE_URL=postgresql://...
NEURALOPS_POSTGRES_SCHEMA=neuralops_private
NEURALOPS_POSTGRES_TABLE=records
```

Frontend/client-only:

```env
VITE_SUPABASE_URL=https://cjcsinixideeqiwzdvna.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

The publishable key is safe for frontend auth and client reads governed by RLS, but it cannot run migrations and should not be used as the backend storage credential.

## Migration

The migration file is:

```text
supabase/migrations/001_neuralops_records.sql
```

It creates:

- private schema `neuralops_private`
- table `records`
- JSONB payload storage
- primary key on `(domain, id)`
- domain/time and JSONB GIN indexes
- RLS enabled
- revoked access from `anon` and `authenticated`
- updated-at trigger

## Verification

Run:

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
