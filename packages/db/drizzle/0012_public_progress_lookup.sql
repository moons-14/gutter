-- Public progress identity resolution uses a materialized digest in a bounded indexed-join
-- predicate. The digest is populated by a trigger because PostgreSQL's convert_to() is STABLE
-- (not legal in an index expression), while the public key must preserve the JS NUL delimiter.
-- pgcrypto is the maintained PostgreSQL implementation of digest and is safe to enable
-- idempotently during both fresh installs and upgrades from 0011.
create extension if not exists pgcrypto;
-- visible_source_items is intentionally an ordinary view and cannot be indexed. Index the
-- materialized identity on its source_items base relation; the view remains the ACL and
-- visibility boundary in the resolver query.
alter table source_items add column if not exists public_progress_key text;
create or replace function gutter_set_source_progress_key() returns trigger
language plpgsql as $$
begin
  new.public_progress_key := 'source:' || translate(
    rtrim(replace(encode(digest(
      convert_to(new.root_id, 'UTF8') || decode('00', 'hex') || convert_to(new.relative_path, 'UTF8'),
      'sha256'
    ), 'base64'), E'\\n', ''), '='), '+/', '-_'
  );
  return new;
end;
$$;
drop trigger if exists source_items_progress_key_trigger on source_items;
create trigger source_items_progress_key_trigger
before insert or update of root_id,relative_path on source_items
for each row execute function gutter_set_source_progress_key();
update source_items
set public_progress_key = 'source:' || translate(
  rtrim(replace(encode(digest(
    convert_to(root_id, 'UTF8') || decode('00', 'hex') || convert_to(relative_path, 'UTF8'),
    'sha256'
  ), 'base64'), E'\\n', ''), '='), '+/', '-_'
);
alter table source_items alter column public_progress_key set not null;
create index if not exists source_items_progress_key_idx on source_items (public_progress_key);
-- Keep the existing visible_source_items contract unchanged while giving the bounded resolver
-- a projected view that includes the materialized key. The API role gets the view, not the raw
-- inventory table; the underlying indexed source_items lookup remains server-side.
create or replace view public_progress_source_items as
  select i.id,i.root_id,i.relative_path,i.public_progress_key
    from source_items i
    join library_roots r on r.id=i.root_id
   where i.active and r.active and i.quarantine_reason is null
     and not exists (select 1 from global_source_suppressions s where s.source_item_id=i.id)
     and not exists (
       select 1 from page_validation_runs v
        where v.source_item_id=i.id and v.manifest_sha256=i.manifest_sha256
          and v.generation=i.validation_generation and v.state='completed' and v.valid_count=0
     );
grant select on public_progress_source_items to gutter_api;
-- Reader authorization needs only current, validated page locators. Keep validation tables and
-- raw source pages behind an owner-owned projection; the API role never receives their tables.
create or replace view public_reader_source_pages as
  select i.id as source_item_id,i.manifest_sha256,i.validation_generation,
         p.ordinal,p.locator,p.observed
    from visible_source_items i
    join source_pages p on p.source_item_id=i.id
    join page_validation_runs run on run.source_item_id=i.id
      and run.manifest_sha256=i.manifest_sha256
      and run.generation=i.validation_generation and run.state='completed'
    join page_validation_results result on result.source_item_id=i.id
      and result.locator=p.locator and result.manifest_sha256=i.manifest_sha256
      and result.generation=i.validation_generation and result.state='valid';
grant select on public_reader_source_pages to gutter_api;
insert into gutter_schema (version) values ('0012_public_progress_lookup') on conflict (version) do nothing;
