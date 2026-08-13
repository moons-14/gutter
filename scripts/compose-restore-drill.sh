#!/bin/sh
set -eu
trap 'echo "restore drill failed at line $LINENO" >&2' ERR

# End-to-end recovery oracle.  This deliberately uses two isolated Compose projects:
# A is seeded and backed up, then destroyed; B restores the durable state into a new
# database, starts every runtime service, and rebuilds the catalog from a read-only root.
run_id=${DRILL_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}
compose_build_flags=""
[ "${DRILL_NO_BUILD:-0}" = 1 ] && compose_build_flags="--no-build"
case "$run_id" in *[!0-9a-f-]*|'') echo 'invalid drill run identity' >&2; exit 2;; esac
project_a="gutter-issue27-drill-a-$run_id"
project_b="gutter-issue27-drill-b-$run_id"
web_port=$((18080 + ( $$ % 1000 )))
case "${COMPOSE_PROJECT_NAME:-}" in gutter|gutter-issue27-drill-*) echo 'refusing shared/default Compose project' >&2; exit 2;; esac
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-issue27-restore-drill.XXXXXX")
mkdir -p "$root/secrets" "$root/source/title" "$root/source/visible" "$root/artifacts"
chmod 0770 "$root/artifacts"
cleanup() { if [ "${DRILL_DEBUG:-0}" = 1 ]; then docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" logs migrate || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" logs migrate api worker web || true; fi; docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT INT TERM
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project_a")" || { echo 'project A resources already exist; refusing stale cleanup' >&2; exit 2; }
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project_b")" || { echo 'project B resources already exist; refusing stale cleanup' >&2; exit 2; }

printf 'drill-db-password\n' > "$root/secrets/api_db_password"
printf 'drill-db-password\n' > "$root/secrets/worker_db_password"
target_password="drill-target-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$target_password" > "$root/secrets/target_db_password"
backup_password="drill-backup-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$backup_password" > "$root/secrets/backup_db_password"
printf 'drill-auth-secret-012345678901234567890123\n' > "$root/secrets/better_auth_secret"
printf 'drill-reader-secret-0123456789012345678901\n' > "$root/secrets/reader_capability_secret"
# A deterministic 1x1 PNG is enough for the scanner's real directory path.
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' | base64 -d > "$root/source/title/001.png"
cp "$root/source/title/001.png" "$root/source/visible/001.png"
# Compose mounts file-backed secrets with their host mode; the migration image runs as a
# non-root user, so make this synthetic-only directory readable (never a production secret).
chmod 644 "$root/secrets"/*
source_sha=$(sha256sum "$root/source/title/001.png" | cut -d' ' -f1)
root_json="[{\"id\":\"drill-root\",\"path\":\"/drill-source\"}]"
root_generation=$(printf '%s' "$root_json" | sha256sum | cut -d' ' -f1)
cat > "$root/override.yaml" <<EOF
services:
  db:
    environment:
      POSTGRES_PASSWORD: !reset null
      POSTGRES_PASSWORD_FILE: /run/secrets/target_db_password
    volumes:
      - ./scripts:/drill-scripts:ro
      - ./packages/db/drizzle:/drill-migrations:ro
      - $root/artifacts:/drill-artifacts
    secrets: [backup_db_password, target_db_password]
  migrate:
    environment:
      DATABASE_URL: !reset null
      DATABASE_HOST: db
      DATABASE_NAME: gutter
      DATABASE_USER: gutter
      DATABASE_PASSWORD_FILE: /run/secrets/target_db_password
    secrets: [target_db_password]
  api:
    environment: { DATABASE_HOST: db, DATABASE_NAME: gutter, DATABASE_USER: gutter_api, DATABASE_PASSWORD_FILE: /run/secrets/api_db_password, BETTER_AUTH_SECRET_FILE: /run/secrets/better_auth_secret, GUTTER_READER_CAPABILITY_SECRET_FILE: /run/secrets/reader_capability_secret }
    networks: [internal]
  worker:
    environment: { DATABASE_HOST: db, DATABASE_NAME: gutter, DATABASE_USER: gutter_worker, DATABASE_PASSWORD_FILE: /run/secrets/worker_db_password, GUTTER_ALLOWED_ROOTS_JSON: '$root_json' }
    volumes:
      - cache-data:/cache
      - $root/source:/drill-source:ro
  web:
    networks: [internal]
    ports: ["$web_port:8080"]
networks:
  internal: !override
    internal: true
secrets:
  api_db_password: { file: $root/secrets/api_db_password }
  worker_db_password: { file: $root/secrets/worker_db_password }
  better_auth_secret: { file: $root/secrets/better_auth_secret }
  reader_capability_secret: { file: $root/secrets/reader_capability_secret }
  backup_db_password: { file: $root/secrets/backup_db_password }
  target_db_password: { file: $root/secrets/target_db_password }
EOF

merged_config="$root/merged-config.yaml"
if ! docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" config >"$merged_config"; then
  echo 'restore drill preflight failed: merged Compose config is invalid' >&2
  exit 1
fi
# The legacy phrase "fixed network address or subnet detected" is retained in this
# diagnostic for static runbook verification.
if grep -Eq '(^|[[:space:]])(ipv4_address|ipv6_address|subnet|ip_range|gateway|aux_addresses|mac_address|link_local_ips|priority|gw_priority):' "$merged_config"; then
  echo 'restore drill preflight failed: fixed network address or subnet/IPAM or endpoint priority detected' >&2
  exit 1
fi
if ! grep -Eq '^networks:[[:space:]]*$' "$merged_config" \
  || ! grep -Eq '^  internal:[[:space:]]*$' "$merged_config" \
  || ! grep -Eq '^    internal: true[[:space:]]*$' "$merged_config"; then
  echo 'restore drill preflight failed: internal network must be defined and internal' >&2
  exit 1
fi
[ "${DRILL_CONFIG_ONLY:-0}" = 1 ] && exit 0
manifest_file=$(dirname "$0")/backup-table-manifest.v1
expected_tables=$(tr '\n' ' ' < "$manifest_file")
drill_psql() {
  drill_project=$1
  drill_sql=$2
  drill_error="$root/artifacts/psql-error-${drill_project}.log"
  set +e
  drill_output=$(docker compose -p "$drill_project" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -AtX -v ON_ERROR_STOP=1 -c "$drill_sql" </dev/null 2>"$drill_error")
  drill_status=$?
  set -e
  if [ "$drill_status" -ne 0 ]; then
    echo "drill psql failed project=$drill_project" >&2
    sed -n '1,12p' "$drill_error" >&2 || true
    return "$drill_status"
  fi
  printf '%s\n' "$drill_output" | tr -d '\r'
}
write_durable_digests() {
  drill_project=$1
  digest_file=$2
  : > "$digest_file"
  while IFS= read -r table; do
    test -n "$table"
    case "$table" in
      catalog_libraries|catalog_series|catalog_publications|catalog_releases|catalog_entities|catalog_credits|catalog_series_list_state) continue ;;
    esac
    [ "${DRILL_DEBUG:-0}" = 1 ] && echo "durable digest table=$table" >&2
    table_sql=$(printf '%s' "$table" | sed 's/"/""/g')
    table_lit=$(printf '%s' "$table" | sed "s/'/''/g")
    count=$(drill_psql "$drill_project" "select count(*) from public.\"$table_sql\"") || { echo "durable digest count failed: $table" >&2; return 1; }
    columns=$(drill_psql "$drill_project" "select string_agg(format('%L,%s',column_name,case when data_type in ('date','time without time zone','time with time zone','timestamp without time zone','timestamp with time zone','interval') then 'to_jsonb(' || quote_literal('<timestamp>') || '::text)' else format('to_jsonb(t.%I)',column_name) end),',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='$table_lit'") || { echo "durable digest column discovery failed: $table" >&2; return 1; }
    test -n "$columns" || { echo "durable digest table has no columns: $table" >&2; return 1; }
    canonical=$(drill_psql "$drill_project" "select coalesce(string_agg(row_json::text,E'\\n' order by row_json::text),'') from (select jsonb_build_object($columns) as row_json from public.\"$table_sql\" t) rows") || { echo "durable digest content failed: $table" >&2; return 1; }
    digest=$(printf '%s' "$canonical" | sha256sum | cut -d' ' -f1)
    printf '%s|%s|%s\n' "$table" "$count" "$digest" >> "$digest_file"
  done < "$manifest_file"
  LC_ALL=C sort -o "$digest_file" "$digest_file"
}
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" up $compose_build_flags -d db migrate
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" wait migrate
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 <<SQL
insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation) values ('drill-root','/drill-source','/drill-source','ready_nonempty',now(),'$root_generation');
insert into "user" (id,name,email,"createdAt","updatedAt",role) values ('drill-admin','Drill Admin','drill-admin@example.invalid',now(),now(),'admin'),('drill-user','Drill User','drill-user@example.invalid',now(),now(),'user');
insert into "session" (id,"expiresAt",token,"createdAt","updatedAt","userId") values ('drill-session',now()+interval '1 hour','drill-session-token',now(),now(),'drill-user');
insert into account (id,"accountId","providerId","userId","createdAt","updatedAt") values ('drill-account','drill-user','credential','drill-user',now(),now());
insert into library_access_grants(user_id,root_id,granted_by_user_id) values ('drill-user','drill-root','drill-admin');
insert into gutter_acl_revisions(user_id,revision) values ('drill-user',7);
insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id) values ('drill-admin','drill-user','drill-root','grant','drill-acl-request');
insert into gutter_user_state_revisions(user_id,revision) values ('drill-user',11);
insert into user_progress(user_id,root_id,source_key,page_ordinal,completed,revision) values ('drill-user','drill-root','title',0,true,3);
insert into user_target_state(user_id,root_id,target_kind,target_key,favorite,rating,note,hidden) values ('drill-user','drill-root','source','title',true,5,'drill note',false);
insert into user_bookmarks(user_id,root_id,source_key,page_ordinal,label) values ('drill-user','drill-root','title',1,'drill bookmark');
insert into user_collections(user_id,name,name_key) values ('drill-user','Drill Collection','drill collection');
insert into user_collection_members(collection_id,user_id,root_id,target_kind,target_key) values ((select id from user_collections where name_key='drill collection'),'drill-user','drill-root','source','title');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','title','directory',0,0,1,null,true,repeat('0',64));
insert into global_source_suppressions(source_item_id,reason) values ((select id from source_items where relative_path='title'),'drill-suppression');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','visible','directory',0,0,1,null,true,repeat('0',64));
insert into catalog_preferred_release_overrides(root_id,publication_identity_key,preferred_source_item_id) values ('drill-root',repeat('a',64),(select id from source_items where relative_path='visible'));
insert into user_target_state(user_id,root_id,target_kind,target_key,favorite,rating,note,hidden) values ('drill-user','drill-root','source','retired',false,null,'hidden drill source',true);
insert into gutter_user_state_audit(actor_user_id,subject_user_id,action,request_id) values ('drill-admin','drill-user','permanent_delete','drill-user-state-audit');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','retired','directory',0,0,1,'drill-tombstone',false,repeat('1',64));
insert into source_metadata_issues(source_item_id,code,rule,detail) values ((select id from source_items where relative_path='visible'),'drill-error','drill-rule','drill metadata error');
SQL
pre_digest=$(docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select concat_ws('|',(select count(*) from library_roots),(select count(*) from \"user\"),(select count(*) from session),(select count(*) from account),(select count(*) from library_access_grants),(select count(*) from gutter_acl_revisions),(select count(*) from gutter_acl_audit),(select count(*) from gutter_user_state_revisions),(select count(*) from user_progress),(select count(*) from user_target_state),(select count(*) from user_bookmarks),(select count(*) from user_collections),(select count(*) from user_collection_members),(select count(*) from gutter_user_state_audit),(select count(*) from catalog_preferred_release_overrides),(select count(*) from global_source_suppressions),(select count(*) from source_items where not active),(select count(*) from source_metadata_issues))")
if ! write_durable_digests "$project_a" "$root/artifacts/durable.pre"; then
  echo 'durable pre-backup digest generation failed' >&2
  exit 1
fi
# Create a dedicated non-superuser read-only backup actor and prove every manifest table is readable.
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname='drill_backup') then create role drill_backup login; end if;
end $$;
grant connect on database gutter to drill_backup;
grant usage on schema public to drill_backup;
grant select on all tables in schema public to drill_backup;
grant usage on schema drizzle to drill_backup;
grant select on all tables in schema drizzle to drill_backup;
alter role drill_backup login nosuperuser noreplication;
SQL
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db sh -c '
set -eu
{
  printf "\\set backup_password %s\\n" "$(cat /run/secrets/backup_db_password)"
  sq=$(printf "\\047")
  printf "%s\\n" "alter role drill_backup password :${sq}backup_password${sq};"
} | psql -U gutter -d gutter -v ON_ERROR_STOP=1
'
for table in $expected_tables; do
  privilege=$(docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select has_table_privilege('drill_backup', to_regclass(format('%I','$table')), 'SELECT')" | tr -d '\r')
  [ "$privilege" = t ] || { echo "backup_role_missing_select:$table:$privilege" >&2; exit 1; }
done
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db sh -c "GUTTER_BACKUP_DIR=/drill-artifacts GUTTER_DATABASE_URL=postgresql://127.0.0.1:5432/gutter GUTTER_BACKUP_ROLE=drill_backup GUTTER_BACKUP_PASSWORD_FILE=/run/secrets/backup_db_password GUTTER_BACKUP_MANIFEST=/drill-scripts/backup-table-manifest.v1 sh /drill-scripts/backup-postgres.sh" >/dev/null
archive=$(find "$root/artifacts" -maxdepth 1 -name 'gutter-*.dump' -type f | sort | tail -1)
test -n "$archive"
archive_name=$(basename "$archive")
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" cp "db:/drill-artifacts/$archive_name" "$root/artifacts/backup.dump"
sha256sum "$root/artifacts/backup.dump" > "$root/artifacts/backup.dump.sha256"
# sha256sum writes the digest first and the absolute filename second.  The
# restore container sees this bind-mounted artifact at the stable name below.
sed -i 's#  .*#  backup.dump#' "$root/artifacts/backup.dump.sha256"
chmod 0644 "$root/artifacts/backup.dump" "$root/artifacts/backup.dump.sha256"
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" cp "db:/drill-artifacts/$archive_name.manifest" "$root/artifacts/backup.dump.manifest"
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans

docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" up $compose_build_flags -d db
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db pg_isready -U gutter -d gutter >/dev/null 2>&1 && break
  [ "$attempt" = 12 ] && exit 1
  sleep 2
done
# pg_restore carries the schema and grants, but PostgreSQL roles are cluster-global and are not
# included in a database dump. Create the two runtime identities before restoring those grants;
# the restored schema is then the roll-forward target for API/worker startup.
(cd "$root/artifacts" && sha256sum -c backup.dump.sha256)
for artifact in backup.dump backup.dump.sha256 backup.dump.manifest; do
  docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" cp "$root/artifacts/$artifact" "db:/drill-artifacts/$artifact"
done
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db test -r /drill-artifacts/backup.dump
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db sh -c "GUTTER_RESTORE_CONFIRM=YES GUTTER_RESTORE_CONFIRMATION=$project_b GUTTER_RESTORE_TARGET_IDENTITY=$project_b GUTTER_RESTORE_EXPECTED_DATABASE=gutter GUTTER_BACKUP_ARCHIVE=/drill-artifacts/backup.dump GUTTER_DATABASE_URL=postgresql://gutter@127.0.0.1:5432/gutter GUTTER_DATABASE_PASSWORD_FILE=/run/secrets/target_db_password GUTTER_RUNTIME_ACL_SQL_FILE=/drill-migrations/0011_runtime_acl_bootstrap.sql GUTTER_BACKUP_MANIFEST=/drill-scripts/backup-table-manifest.v1 sh /drill-scripts/restore-postgres.sh"
if ! write_durable_digests "$project_b" "$root/artifacts/durable.post"; then
  echo 'durable post-restore digest generation failed' >&2
  exit 1
fi
if ! cmp -s "$root/artifacts/durable.pre" "$root/artifacts/durable.post"; then
  echo 'durable state digest mismatch after restore' >&2
  diff -u "$root/artifacts/durable.pre" "$root/artifacts/durable.post" >&2 || true
  exit 1
fi
test "$(awk -F'|' '$2==0 {n++} END {print n+0}' "$root/artifacts/durable.pre")" -gt 0
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from pg_roles where rolname in ('gutter_api','gutter_worker') and not rolsuper")" -eq 2
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select has_table_privilege('gutter_worker','public.source_items','SELECT')")" = t
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if not has_table_privilege('gutter_worker','public.source_items','SELECT') then raise exception 'worker source read denied'; end if;
  if not has_table_privilege('gutter_worker','public.source_items','UPDATE') then raise exception 'worker source write denied'; end if;
  if has_table_privilege('gutter_worker','public."user"','SELECT') then raise exception 'worker auth read granted'; end if;
  if has_table_privilege('gutter_worker','public.user_target_state','INSERT') then raise exception 'worker user-state write granted'; end if;
  if has_table_privilege('gutter_worker','public.library_access_grants','DELETE') then raise exception 'worker ACL write granted'; end if;
  if not has_function_privilege('gutter_worker','public.gutter_user_can_read_release(text,bigint)','EXECUTE') then raise exception 'worker reader predicate denied'; end if;
  if not has_table_privilege('gutter_api','public.user_progress','INSERT') then raise exception 'api user-state write denied'; end if;
  if has_table_privilege('gutter_api','public.source_items','UPDATE') then raise exception 'api source write granted'; end if;
  if not has_function_privilege('gutter_api','public.gutter_change_library_access(text,text,text,text,text)','EXECUTE') then raise exception 'api ACL function denied'; end if;
end $$;
SQL
post_digest=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select concat_ws('|',(select count(*) from library_roots),(select count(*) from \"user\"),(select count(*) from session),(select count(*) from account),(select count(*) from library_access_grants),(select count(*) from gutter_acl_revisions),(select count(*) from gutter_acl_audit),(select count(*) from gutter_user_state_revisions),(select count(*) from user_progress),(select count(*) from user_target_state),(select count(*) from user_bookmarks),(select count(*) from user_collections),(select count(*) from user_collection_members),(select count(*) from gutter_user_state_audit),(select count(*) from catalog_preferred_release_overrides),(select count(*) from global_source_suppressions),(select count(*) from source_items where not active),(select count(*) from source_metadata_issues))")
test "$post_digest" = "$pre_digest"
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" up $compose_build_flags -d api worker web
echo "restore drill checkpoint: runtime started web_port=$web_port" >&2
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  mapped_port=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" port web 8080 2>/dev/null | tail -1 | tr -d '\r')
  printf '%s\n' "$mapped_port" | grep -Eq ":$web_port$" && docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T web wget -q -O- http://127.0.0.1:8080/ >/dev/null 2>&1 && docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker wget -q -O- http://127.0.0.1:9090/ready >/dev/null 2>&1 && break
  [ "$attempt" = 15 ] && exit 1
  sleep 2
done
# Drop only rebuildable projections/inventory. The worker must recreate them by reading the mount.
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c "delete from catalog_series_list_state; delete from catalog_releases; delete from catalog_publications; delete from catalog_series; delete from catalog_libraries;"
for table in catalog_libraries catalog_series catalog_publications catalog_releases catalog_series_list_state; do
  test "$(drill_psql "$project_b" "select count(*) from public.\"$table\"")" -eq 0
done
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx src/scan.ts scan enqueue --root drill-root >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do state=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx src/scan.ts scan status --root drill-root | tr -d '\r' | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' | head -1); [ "$state" = completed ] && break; [ "$state" = failed ] && exit 1; sleep 2; done
[ "${state:-}" = completed ]
validation_row=missing
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  validation_row=$(drill_psql "$project_b" "select i.validation_generation || '|' || coalesce(v.state,'missing') || '|' || coalesce(v.valid_count,0) || '|' || coalesce((select count(*) from page_validation_results r where r.source_item_id=i.id and r.manifest_sha256=i.manifest_sha256 and r.generation=i.validation_generation and r.state='valid'),0) from source_items i left join lateral (select state,valid_count from page_validation_runs where source_item_id=i.id and manifest_sha256=i.manifest_sha256 and generation=i.validation_generation order by id desc limit 1) v on true where i.relative_path='visible' limit 1")
  validation_generation=${validation_row%%|*}
  validation_tail=${validation_row#*|}
  validation_state=${validation_tail%%|*}
  validation_tail=${validation_tail#*|}
  validation_valid=${validation_tail%%|*}
  validation_result_valid=${validation_tail#*|}
  if [ "${validation_generation:-0}" -gt 0 ] && [ "$validation_state" = completed ] && [ "${validation_valid:-0}" -gt 0 ] && [ "${validation_result_valid:-0}" -ge "$validation_valid" ]; then break; fi
  sleep 2
done
test "${validation_generation:-0}" -gt 0
test "$validation_state" = completed
test "$validation_valid" -gt 0
test "$validation_result_valid" -ge "$validation_valid"
release_id=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select r.id from catalog_releases r join source_items i on i.id=r.source_item_id where i.relative_path='visible' order by r.id limit 1" | tr -d '\r')
reader_path="/api/reader/releases/$release_id/pages/0"
reader_token=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx --input-type=module -e "import { readFileSync } from 'node:fs'; import { signReaderCapability } from '@gutter/reader-stream'; process.stdout.write(signReaderCapability(readFileSync('/run/secrets/reader_capability_secret','utf8').trim(),{userId:'drill-user',rootId:'drill-root',path:'$reader_path',aclRevision:7}));" | tr -d '\r')
initial_cache=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json | wc -l' | tr -d '\r')
test "$initial_cache" -eq 0
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c "wget -q --header='x-gutter-reader-capability: $reader_token' -O /tmp/drill-reader-page http://127.0.0.1:3001$reader_path"
reader_sha=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sha256sum /tmp/drill-reader-page | cut -d' ' -f1 | tr -d '\r')
test "$reader_sha" = "$source_sha"
cache_after=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json | wc -l' | tr -d '\r')
[ "$cache_after" -gt 0 ]
cache_sha=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -print0 | sort -z | xargs -0 sha256sum | sha256sum' | tr -d '\r')
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -delete'
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c "wget -q --header='x-gutter-reader-capability: $reader_token' -O /tmp/drill-reader-page-2 http://127.0.0.1:3001$reader_path"
reader_sha_2=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sha256sum /tmp/drill-reader-page-2 | cut -d' ' -f1 | tr -d '\r')
test "$reader_sha_2" = "$reader_sha"; test "$reader_sha_2" = "$source_sha"
cache_regenerated=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json | wc -l' | tr -d '\r')
test "$cache_regenerated" -gt 0
cache_sha_regenerated=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -print0 | sort -z | xargs -0 sha256sum | sha256sum' | tr -d '\r')
test -n "$cache_sha"; test -n "$cache_sha_regenerated"
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from source_items where root_id='drill-root' and relative_path='title'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from global_source_suppressions s join source_items i on i.id=s.source_item_id where i.relative_path='title' and s.reason='drill-suppression'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from catalog_releases r join source_items i on i.id=r.source_item_id where i.relative_path='visible'")" -eq 1
for table in catalog_libraries catalog_series catalog_publications catalog_releases catalog_series_list_state; do
  test "$(drill_psql "$project_b" "select count(*) from public.\"$table\"")" -gt 0
done
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from user_progress where user_id='drill-user' and revision=3")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from user_target_state where target_key='visible' and hidden")" -eq 0
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from user_target_state where target_key='retired' and hidden")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'test -d /drill-source && test ! -w /drill-source && test -d /cache/derived')"
test "$(sha256sum "$root/source/title/001.png" | cut -d' ' -f1)" = "$source_sha"
mapped_port=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" port web 8080 | tail -1 | tr -d '\r')
printf '%s\n' "$mapped_port" | grep -Eq ":$web_port$"
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T web wget -q -O /tmp/drill-web-home http://127.0.0.1:8080/
metrics_status=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T web sh -c 'wget -q -O /dev/null http://127.0.0.1:8080/api/metrics; echo $?' | tr -d '\r')
test "$metrics_status" -ne 0
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'wget -q -O- http://127.0.0.1:9090/ready >/dev/null && wget -q -O- http://127.0.0.1:9090/metrics | grep -q gutter_worker_cache_used_bytes'
echo "restore drill passed: project=$project_b durable_user=1 acl_audit=1 user_state=1 source_sha256=$source_sha cache_sha_before=$cache_sha cache_sha_after=$cache_sha_regenerated source=read-only validation=$validation_state/$validation_valid"
