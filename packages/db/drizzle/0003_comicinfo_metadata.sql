create table if not exists source_metadata (
  source_item_id bigint primary key references source_items(id) on delete cascade,
  effective jsonb not null, provenance jsonb not null, rule_set text not null,
  comicinfo_sha256 text, updated_at timestamptz not null default now()
);
create table if not exists source_page_annotations (
  source_item_id bigint not null references source_items(id) on delete cascade,
  locator text not null, annotation jsonb not null,
  primary key (source_item_id, locator)
);
create table if not exists source_metadata_issues (
  source_item_id bigint not null references source_items(id) on delete cascade,
  code text not null, rule text not null, detail text not null default '',
  detected_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), resolved_at timestamptz,
  retry_state text not null default 'pending' check (retry_state in ('pending', 'resolved')),
  primary key (source_item_id, code, rule, detail)
);
create table if not exists global_source_suppressions (
  source_item_id bigint primary key references source_items(id) on delete cascade,
  reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create or replace view visible_source_items as
  select i.* from source_items i
  where i.active and not exists (select 1 from global_source_suppressions s where s.source_item_id = i.id);
create or replace view source_metadata_error_list as
  select i.root_id, i.relative_path, e.code, e.rule, e.detected_at, e.last_seen_at, e.resolved_at, e.retry_state
  from source_metadata_issues e join source_items i on i.id = e.source_item_id
  where i.active and e.resolved_at is null;
insert into gutter_schema (version) values ('0003_comicinfo_metadata') on conflict (version) do nothing;
