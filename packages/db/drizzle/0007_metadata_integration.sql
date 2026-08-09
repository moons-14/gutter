-- Provider observations and operator decisions are intentionally outside source metadata and catalog identity.
create table if not exists metadata_provider_candidates (
  root_id text not null references library_roots(id) on delete cascade,
  canonical_identity_key text not null check (canonical_identity_key ~ '^[0-9a-f]{64}$'),
  provider_id text not null check (provider_id ~ '^[a-z][a-z0-9_-]{0,62}$'),
  provider_priority integer not null,
  config_order integer not null check (config_order >= 0),
  values jsonb not null,
  provenance jsonb not null,
  observed_at timestamptz not null default now(),
  primary key(root_id, canonical_identity_key, provider_id)
);
create table if not exists metadata_decisions (
  root_id text not null references library_roots(id) on delete cascade,
  canonical_identity_key text not null check (canonical_identity_key ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('approved','rejected','pending_reapproval')),
  approved_snapshot jsonb,
  approved_provenance jsonb,
  approved_manifest_sha256 text check (approved_manifest_sha256 is null or approved_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(root_id, canonical_identity_key),
  check ((state = 'approved' and approved_snapshot is not null and approved_provenance is not null) or state <> 'approved')
);
create index if not exists metadata_candidates_identity_idx on metadata_provider_candidates(root_id, canonical_identity_key);
insert into gutter_schema (version) values ('0007_metadata_integration') on conflict (version) do nothing;
