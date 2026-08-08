alter table library_roots add column if not exists next_reconcile_at timestamptz;
alter table library_roots add column if not exists reconcile_interval_seconds integer not null default 900
  check (reconcile_interval_seconds between 60 and 86400);

create table if not exists scan_requests (
  id uuid primary key,
  root_id text not null references library_roots(id) on delete cascade,
  trigger text not null check (trigger in ('startup','periodic','watcher','manual')),
  state text not null check (state in ('queued','dispatched','running','completed','failed','cancelled')),
  pg_boss_job_id uuid,
  scan_run_id bigint references scan_runs(id),
  follow_up_requested boolean not null default false,
  follow_up_trigger text check (follow_up_trigger in ('startup','periodic','watcher','manual')),
  cancel_requested_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz,
  check (error_code is null or error_code ~ '^[a-z0-9_]{1,96}$')
);
create unique index if not exists scan_requests_one_active_root
  on scan_requests(root_id) where state in ('queued','dispatched','running');
create index if not exists scan_requests_dispatch_idx on scan_requests(state, created_at) where state='queued';

alter table scan_runs add column if not exists scan_request_id uuid references scan_requests(id);
alter table scan_runs add column if not exists pg_boss_job_id uuid;
alter table scan_runs add column if not exists trigger text;
alter table scan_runs add column if not exists heartbeat_at timestamptz;
alter table scan_runs add column if not exists cancel_requested_at timestamptz;
alter table scan_runs add column if not exists progress jsonb not null default '{}'::jsonb;

insert into gutter_schema (version) values ('0005_reconciliation_control') on conflict (version) do nothing;
