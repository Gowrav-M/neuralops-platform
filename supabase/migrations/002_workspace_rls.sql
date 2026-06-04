create or replace function neuralops_private.current_workspace_id()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'neuralops_workspace_id', ''),
    nullif(auth.jwt() -> 'app_metadata' ->> 'workspace_id', ''),
    case
      when auth.uid() is not null then 'user-' || auth.uid()::text
      else null
    end
  )
$$;

create or replace function neuralops_private.record_workspace_id(record_payload jsonb)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(record_payload ->> 'workspaceId', ''),
    nullif(record_payload -> 'workspace' ->> 'id', '')
  )
$$;

alter table neuralops_private.records enable row level security;

drop policy if exists records_workspace_select on neuralops_private.records;
drop policy if exists records_workspace_insert on neuralops_private.records;
drop policy if exists records_workspace_update on neuralops_private.records;
drop policy if exists records_workspace_delete on neuralops_private.records;

create policy records_workspace_select
on neuralops_private.records
for select
to authenticated
using (
  domain = 'policies'
  or neuralops_private.record_workspace_id(payload) = neuralops_private.current_workspace_id()
);

create policy records_workspace_insert
on neuralops_private.records
for insert
to authenticated
with check (
  domain <> 'policies'
  and neuralops_private.record_workspace_id(payload) = neuralops_private.current_workspace_id()
);

create policy records_workspace_update
on neuralops_private.records
for update
to authenticated
using (
  domain <> 'policies'
  and neuralops_private.record_workspace_id(payload) = neuralops_private.current_workspace_id()
)
with check (
  domain <> 'policies'
  and neuralops_private.record_workspace_id(payload) = neuralops_private.current_workspace_id()
);

create policy records_workspace_delete
on neuralops_private.records
for delete
to authenticated
using (
  domain <> 'policies'
  and neuralops_private.record_workspace_id(payload) = neuralops_private.current_workspace_id()
);

comment on function neuralops_private.current_workspace_id() is
  'Returns the trusted NeuralOps workspace id from Supabase Auth app_metadata, falling back to user-scoped subject.';

comment on function neuralops_private.record_workspace_id(jsonb) is
  'Extracts workspaceId from NeuralOps JSONB records for RLS checks.';

comment on policy records_workspace_select on neuralops_private.records is
  'Authenticated users can read global policy definitions and records whose workspaceId matches trusted app_metadata.';
