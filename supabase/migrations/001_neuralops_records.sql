create schema if not exists neuralops_private;

create table if not exists neuralops_private.records (
  domain text not null,
  id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain, id)
);

create index if not exists records_domain_updated_at_idx
  on neuralops_private.records (domain, updated_at desc);

create index if not exists records_payload_gin_idx
  on neuralops_private.records using gin (payload);

alter table neuralops_private.records enable row level security;

revoke all on schema neuralops_private from anon, authenticated;
revoke all on all tables in schema neuralops_private from anon, authenticated;

create or replace function neuralops_private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists records_touch_updated_at on neuralops_private.records;

create trigger records_touch_updated_at
before update on neuralops_private.records
for each row
execute function neuralops_private.touch_updated_at();

comment on schema neuralops_private is 'Private NeuralOps operational evidence schema. Not exposed to Supabase anon/authenticated Data API roles.';
comment on table neuralops_private.records is 'Domain-keyed JSONB evidence records for traces, agent runs, lab experiments, policies, incidents, audit events, and settings.';
