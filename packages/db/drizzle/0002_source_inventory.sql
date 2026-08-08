create table if not exists scan_runs (
  id bigserial primary key, root_id text not null references library_roots(id) on delete cascade, config_generation text not null check (config_generation ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('running','completed','failed','cancelled')), summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists source_items (
  id bigserial primary key, root_id text not null references library_roots(id) on delete cascade, relative_path text not null check (relative_path <> '' and relative_path !~ '(^|/)\.\.(/|$)'),
  kind text not null check (kind in ('directory','cbz')), size_bytes bigint not null check (size_bytes >= 0), mtime_ms double precision not null,
  page_count integer not null check (page_count >= 0), quarantine_reason text, last_seen_run_id bigint references scan_runs(id), active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(root_id, relative_path)
);
create table if not exists source_pages (
  source_item_id bigint not null references source_items(id) on delete cascade, ordinal integer not null check (ordinal >= 0), locator text not null,
  primary key(source_item_id, ordinal), unique(source_item_id, locator)
);
create index if not exists source_items_active_idx on source_items(root_id, active);
insert into gutter_schema (version) values ('0002_source_inventory') on conflict (version) do nothing;
