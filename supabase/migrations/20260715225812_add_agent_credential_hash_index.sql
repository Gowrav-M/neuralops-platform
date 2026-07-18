create index if not exists records_agent_identity_credential_hash_idx
  on neuralops_private.records ((payload ->> 'credentialHash'))
  where domain = 'agent_identities';

comment on index neuralops_private.records_agent_identity_credential_hash_idx is
  'Supports bounded agent credential resolution without scanning identities across workspaces.';
