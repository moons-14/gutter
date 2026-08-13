-- Canonical runtime least-privilege policy.
-- This migration is also executed by scripts/bootstrap-runtime-acl.sh after a --no-privileges
-- restore and once more by migrate.ts after pg-boss creates its queue schema. Keep all runtime
-- role grants/revokes here; do not maintain a second policy in an operator script.
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

revoke all on schema public from gutter_api, gutter_worker;
grant usage on schema public to gutter_api, gutter_worker;
revoke all on all tables in schema public from gutter_api, gutter_worker;
revoke all on all sequences in schema public from gutter_api, gutter_worker;
revoke all on all functions in schema public from gutter_api, gutter_worker;

-- API: authentication, user-state writes, catalog/read-model reads, and mediated ACL changes.
grant select on
  gutter_schema, library_roots, scan_requests, scan_runs,
  source_items, global_source_suppressions, page_validation_runs, page_validation_results,
  catalog_libraries, catalog_series, catalog_publications, catalog_releases, catalog_entities,
  catalog_credits, catalog_preferred_release_overrides, catalog_series_list_state,
  visible_source_items,
  public_progress_source_items, public_reader_source_pages,
  "user", "session", account, verification, "twoFactor", passkey,
  gutter_auth_bootstrap, library_access_grants, gutter_acl_revisions,
  gutter_public_api_tokens, gutter_user_state_revisions, user_progress, user_target_state, user_bookmarks,
  user_collections, user_collection_members
to gutter_api;
grant insert, update on gutter_public_api_tokens to gutter_api;
grant insert, update, delete on "user", "session", account, verification, "twoFactor", passkey
to gutter_api;
grant update on gutter_auth_bootstrap to gutter_api;
grant insert, update, delete on
  gutter_user_state_revisions, user_progress, user_target_state, user_bookmarks,
  user_collections, user_collection_members
to gutter_api;
grant insert on gutter_user_state_audit to gutter_api;
grant usage, select on user_bookmarks_id_seq, user_collections_id_seq,
  gutter_user_state_audit_id_seq to gutter_api;
grant execute on function gutter_user_can_read_release(text, bigint) to gutter_api;
grant execute on function gutter_change_library_access(text, text, text, text, text) to gutter_api;

-- Worker: source inventory, validation, metadata, rebuildable catalog projections, and queue.
-- No auth, ACL, or durable user-state table is granted below; reader authorization is the
-- SECURITY DEFINER predicate above, which exposes only its boolean result.
grant select, insert, update on library_roots, scan_requests, scan_runs to gutter_worker;
grant select, insert, update on source_items, source_metadata, source_metadata_issues,
  global_source_suppressions, validation_intents to gutter_worker;
grant delete on validation_intents to gutter_worker;
grant select, insert, update, delete on source_pages, source_page_annotations to gutter_worker;
grant select, insert, update, delete on page_validation_runs, page_validation_results to gutter_worker;
grant select, insert, update, delete on
  catalog_libraries, catalog_series, catalog_publications, catalog_releases,
  catalog_entities, catalog_credits, catalog_series_list_state,
  metadata_provider_candidates, metadata_decisions
to gutter_worker;
grant select on gutter_schema, catalog_preferred_release_overrides, visible_source_items,
  reader_eligible_source_pages to gutter_worker;
grant execute on function gutter_user_can_read_release(text, bigint) to gutter_worker;
grant usage, select on scan_runs_id_seq, source_items_id_seq, page_validation_runs_id_seq,
  catalog_series_id_seq, catalog_publications_id_seq, catalog_releases_id_seq,
  catalog_entities_id_seq to gutter_worker;

-- pg-boss is the worker's queue boundary. Its schema may not exist during migration, so this
-- block is intentionally conditional; migrate.ts reruns this same file after pg-boss starts.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'pgboss') then
    execute 'revoke all on schema pgboss from gutter_api, gutter_worker';
    execute 'grant usage on schema pgboss to gutter_worker';
    execute 'revoke all on all tables in schema pgboss from gutter_api, gutter_worker';
    execute 'grant select, insert, update, delete on all tables in schema pgboss to gutter_worker';
    execute 'revoke all on all sequences in schema pgboss from gutter_api, gutter_worker';
    execute 'grant usage, select, update on all sequences in schema pgboss to gutter_worker';
    execute 'revoke all on all functions in schema pgboss from gutter_api, gutter_worker';
    execute 'grant execute on all functions in schema pgboss to gutter_worker';
  end if;
end $$;

insert into gutter_schema (version) values ('0013_runtime_acl_bootstrap') on conflict (version) do nothing;
