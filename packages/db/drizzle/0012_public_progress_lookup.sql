-- Public progress identity resolution uses digest() in a bounded indexed-join predicate.
-- pgcrypto is the maintained PostgreSQL implementation of digest and is safe to enable
-- idempotently during both fresh installs and upgrades from 0011.
create extension if not exists pgcrypto;
create index if not exists visible_source_items_progress_key_idx on visible_source_items
  (('source:' || translate(rtrim(replace(encode(digest(root_id || chr(0) || relative_path, 'sha256'), 'base64'), E'\\n', ''), '='), '+/', '-_')));
insert into gutter_schema (version) values ('0012_public_progress_lookup') on conflict (version) do nothing;
