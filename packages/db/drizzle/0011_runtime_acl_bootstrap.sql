do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gutter_api') then
    create role gutter_api nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gutter_worker') then
    create role gutter_worker nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  execute format('grant connect on database %I to gutter_api, gutter_worker', current_database());
end $$;
grant usage on schema public to gutter_api, gutter_worker;
grant select, insert, update, delete on all tables in schema public to gutter_worker;
grant usage, select, update on all sequences in schema public to gutter_worker;
grant select on all tables in schema public to gutter_api;
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'pgboss') then
    execute 'grant usage on schema pgboss to gutter_worker';
    execute 'grant select, insert, update, delete on all tables in schema pgboss to gutter_worker';
    execute 'grant usage, select, update on all sequences in schema pgboss to gutter_worker';
    execute 'grant execute on all functions in schema pgboss to gutter_worker';
  end if;
end $$;
insert into gutter_schema (version) values ('0011_runtime_acl_bootstrap') on conflict (version) do nothing;
