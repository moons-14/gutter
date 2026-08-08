alter table source_items add column if not exists manifest_sha256 text;
alter table source_items add column if not exists validation_generation bigint not null default 0 check (validation_generation >= 0);
alter table source_pages add column if not exists observed jsonb not null default '{}'::jsonb;

create table if not exists validation_intents (
  source_item_id bigint primary key references source_items(id) on delete cascade,
  desired_manifest_sha256 text not null check (desired_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  generation bigint not null check (generation > 0),
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  state text not null check (state in ('pending','queued','running','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_failure_code text,
  failed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists validation_intents_claim_idx on validation_intents(state, next_attempt_at, lease_expires_at);
alter table validation_intents add column if not exists lease_epoch bigint not null default 0 check (lease_epoch >= 0);

create table if not exists page_validation_runs (
  id bigserial primary key, source_item_id bigint not null references source_items(id) on delete cascade,
  manifest_sha256 text not null, generation bigint not null, state text not null check (state in ('completed','failed','cancelled')),
  candidate_count integer not null, valid_count integer not null, skipped_count integer not null,
  bytes_read bigint not null default 0, duration_ms bigint not null default 0, summary jsonb not null default '{}'::jsonb,
  completed_at timestamptz not null default now()
);
create table if not exists page_validation_results (
  source_item_id bigint not null references source_items(id) on delete cascade,
  locator text not null, manifest_sha256 text not null, generation bigint not null check (generation > 0), state text not null check (state in ('valid','skipped')),
  reason_code text, format text, width integer, height integer, bytes_read bigint,
  checked_at timestamptz not null default now(),
  primary key (source_item_id, locator, manifest_sha256, generation),
  check ((state='valid' and reason_code is null and format is not null and width is not null and height is not null)
      or (state='skipped' and reason_code is not null and format is null and width is null and height is null))
);
create index if not exists page_validation_runs_authority_idx
  on page_validation_runs(source_item_id, manifest_sha256, generation, state);
create index if not exists page_validation_results_authority_idx
  on page_validation_results(source_item_id, locator, manifest_sha256, generation, state);

create or replace view visible_source_items as
  select i.* from source_items i
  where i.active
    and i.quarantine_reason is null
    and not exists (select 1 from global_source_suppressions s where s.source_item_id=i.id)
    and not exists (
      select 1 from page_validation_runs v
      where v.source_item_id=i.id and v.manifest_sha256=i.manifest_sha256
        and v.generation=i.validation_generation and v.state='completed'
        and v.valid_count=0
    );
create or replace view reader_eligible_source_pages as
  select p.* from source_pages p join visible_source_items i on i.id=p.source_item_id
  where not exists (
    select 1 from page_validation_runs v
    where v.source_item_id=i.id and v.manifest_sha256=i.manifest_sha256
      and v.generation=i.validation_generation and v.state='completed'
      and v.valid_count=0
  ) and not exists (
    select 1 from page_validation_results r
    where r.source_item_id=p.source_item_id and r.locator=p.locator and r.manifest_sha256=i.manifest_sha256
      and r.generation=i.validation_generation
      and r.state='skipped'
  );
insert into gutter_schema (version) values ('0004_page_validation') on conflict (version) do nothing;
