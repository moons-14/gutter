-- ACLs are durable policy state keyed only by stable configured library/root identifiers.
create table library_access_grants (
  user_id text not null references "user"(id) on delete cascade,
  root_id text not null references library_roots(id) on delete restrict,
  granted_by_user_id text not null references "user"(id) on delete restrict,
  granted_at timestamptz not null default now(),
  primary key (user_id, root_id)
);
create table gutter_acl_revisions (
  user_id text primary key references "user"(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
create table gutter_acl_audit (
  id bigserial primary key,
  actor_user_id text not null references "user"(id) on delete restrict,
  subject_user_id text not null references "user"(id) on delete restrict,
  root_id text not null references library_roots(id) on delete restrict,
  action text not null check (action in ('grant','revoke')),
  occurred_at timestamptz not null default now(),
  request_id text not null
);
create index library_access_grants_root_user_idx on library_access_grants(root_id,user_id);
create index gutter_acl_audit_subject_occurred_idx on gutter_acl_audit(subject_user_id,occurred_at);

-- Audit history is immutable even if an application query is compromised.
create function gutter_reject_acl_audit_mutation() returns trigger
language plpgsql as $$ begin raise exception 'gutter_acl_audit is append-only'; end $$;
create trigger gutter_acl_audit_immutable before update or delete on gutter_acl_audit
for each statement execute function gutter_reject_acl_audit_mutation();

-- Runtime identities exist without login until the migration entrypoint installs rotated
-- deployment passwords.  The migrator remains the only schema owner.
do $$
begin
  if not exists (select 1 from pg_roles where rolname='gutter_api') then
    create role gutter_api nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname='gutter_worker') then
    create role gutter_worker nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  execute format('grant connect on database %I to gutter_api, gutter_worker', current_database());
end $$;
grant usage on schema public to gutter_api, gutter_worker;

grant select on
  gutter_schema, library_roots, scan_requests, visible_source_items, source_metadata,
  catalog_libraries, catalog_series, catalog_publications, catalog_releases,
  catalog_entities, catalog_credits, catalog_preferred_release_overrides,
  catalog_series_list_state,
  "user", "session", account, verification, "twoFactor", passkey,
  gutter_auth_bootstrap, library_access_grants, gutter_acl_revisions
to gutter_api;
grant insert, update, delete on "user", "session", account, verification, "twoFactor", passkey
to gutter_api;
grant select, update on gutter_auth_bootstrap to gutter_api;
grant insert, delete on library_access_grants to gutter_api;
grant insert, update on gutter_acl_revisions to gutter_api;
grant insert on gutter_acl_audit to gutter_api;
grant usage, select on sequence gutter_acl_audit_id_seq to gutter_api;

grant select, insert, update, delete on all tables in schema public to gutter_worker;
grant usage, select, update on all sequences in schema public to gutter_worker;
revoke all on
  "user", "session", account, verification, "twoFactor", passkey,
  gutter_auth_bootstrap, library_access_grants, gutter_acl_revisions, gutter_acl_audit
from gutter_worker;
revoke all on sequence gutter_acl_audit_id_seq from gutter_worker;
insert into gutter_schema (version) values ('0009_access_control') on conflict (version) do nothing;
