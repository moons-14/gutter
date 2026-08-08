create table if not exists library_roots (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{0,62}$'),
  configured_path text not null check (configured_path <> '/' and configured_path like '/%'),
  canonical_path text,
  state text not null check (state in ('ready_nonempty', 'ready_empty', 'missing', 'unreadable', 'not_directory', 'unavailable')),
  reason_code text,
  checked_at timestamptz not null,
  config_generation text not null check (config_generation ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state in ('ready_nonempty', 'ready_empty')) = (canonical_path is not null)),
  check ((state in ('ready_nonempty', 'ready_empty')) = (reason_code is null))
);
create index if not exists library_roots_active_idx on library_roots (active, id);
insert into gutter_schema (version) values ('0001_library_roots') on conflict (version) do nothing;
