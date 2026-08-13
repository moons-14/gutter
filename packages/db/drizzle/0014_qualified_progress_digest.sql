-- Runtime roles use a restricted search_path. Keep the existing progress-key trigger
-- compatible with those roles by resolving the pgcrypto function explicitly and by
-- including the extension schema in the trigger function's execution path.
create or replace function gutter_set_source_progress_key() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.public_progress_key := 'source:' || translate(
    rtrim(replace(encode(public.digest(
      convert_to(new.root_id, 'UTF8') || decode('00', 'hex') || convert_to(new.relative_path, 'UTF8'),
      'sha256'
    ), 'base64'), E'\\n', ''), '='), '+/', '-_'
  );
  return new;
end;
$$;

-- pgcrypto installs digest in public. Runtime roles have a deliberately narrow
-- function ACL, so grant only the exact overload used by this trigger.
grant execute on function public.digest(bytea, text) to gutter_worker;
revoke insert, update, delete on global_source_suppressions from gutter_worker;

update source_items
set public_progress_key = 'source:' || translate(
  rtrim(replace(encode(public.digest(
    convert_to(root_id, 'UTF8') || decode('00', 'hex') || convert_to(relative_path, 'UTF8'),
    'sha256'
  ), 'base64'), E'\\n', ''), '='), '+/', '-_'
);

insert into gutter_schema (version) values ('0014_qualified_progress_digest') on conflict (version) do nothing;
