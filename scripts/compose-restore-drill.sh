#!/bin/sh
set -eu

# End-to-end recovery oracle.  This deliberately uses two isolated Compose projects:
# A is seeded and backed up, then destroyed; B restores the durable state into a new
# database, starts every runtime service, and rebuilds the catalog from a read-only root.
run_id=$(date -u +%Y%m%d%H%M%S)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
case "$run_id" in *[!0-9a-f-]*|'') echo 'invalid drill run identity' >&2; exit 2;; esac
project_a="gutter-issue27-drill-a-$run_id"
project_b="gutter-issue27-drill-b-$run_id"
case "${COMPOSE_PROJECT_NAME:-}" in gutter|gutter-issue27-drill-*) echo 'refusing shared/default Compose project' >&2; exit 2;; esac
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-issue27-restore-drill.XXXXXX")
mkdir -p "$root/secrets" "$root/source/title" "$root/source/visible" "$root/artifacts"
chmod 0770 "$root/artifacts"
cleanup() { if [ "${DRILL_DEBUG:-0}" = 1 ]; then docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" logs migrate || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" logs migrate || true; fi; docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT INT TERM
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project_a")" || { echo 'project A resources already exist; refusing stale cleanup' >&2; exit 2; }
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project_b")" || { echo 'project B resources already exist; refusing stale cleanup' >&2; exit 2; }

printf 'drill-db-password\n' > "$root/secrets/api_db_password"
printf 'drill-db-password\n' > "$root/secrets/worker_db_password"
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
    environment: { POSTGRES_PASSWORD: drill-db-password }
    volumes:
      - ./scripts:/drill-scripts:ro
      - $root/artifacts:/drill-artifacts
  migrate:
    environment: { DATABASE_URL: postgresql://gutter:drill-db-password@db:5432/gutter }
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
networks:
  internal: !override
    internal: true
secrets:
  api_db_password: { file: $root/secrets/api_db_password }
  worker_db_password: { file: $root/secrets/worker_db_password }
  better_auth_secret: { file: $root/secrets/better_auth_secret }
  reader_capability_secret: { file: $root/secrets/reader_capability_secret }
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
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" up -d db migrate
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
insert into user_progress(user_id,root_id,source_key,page_ordinal,completed,revision) values ('drill-user','drill-root','title',1,true,3);
insert into user_target_state(user_id,root_id,target_kind,target_key,favorite,rating,note,hidden) values ('drill-user','drill-root','source','title',true,5,'drill note',false);
insert into user_bookmarks(user_id,root_id,source_key,page_ordinal,label) values ('drill-user','drill-root','title',1,'drill bookmark');
insert into user_collections(user_id,name,name_key) values ('drill-user','Drill Collection','drill collection');
insert into user_collection_members(collection_id,user_id,root_id,target_kind,target_key) values ((select id from user_collections where name_key='drill collection'),'drill-user','drill-root','source','title');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','title','directory',0,0,1,null,true,repeat('0',64));
insert into global_source_suppressions(source_item_id,reason) values ((select id from source_items where relative_path='title'),'drill-suppression');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','visible','directory',0,0,1,null,true,repeat('0',64));
insert into catalog_preferred_release_overrides(root_id,publication_identity_key,preferred_source_item_id) values ('drill-root',repeat('a',64),(select id from source_items where relative_path='visible'));
insert into user_target_state(user_id,root_id,target_kind,target_key,favorite,rating,note,hidden) values ('drill-user','drill-root','source','visible',false,null,'hidden drill source',true);
insert into gutter_user_state_audit(actor_user_id,subject_user_id,action,request_id) values ('drill-admin','drill-user','permanent_delete','drill-user-state-audit');
insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,quarantine_reason,active,manifest_sha256) values ('drill-root','retired','directory',0,0,1,'drill-tombstone',false,repeat('1',64));
insert into source_metadata_issues(source_item_id,code,rule,detail) values ((select id from source_items where relative_path='visible'),'drill-error','drill-rule','drill metadata error');
SQL
pre_digest=$(docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select concat_ws('|',(select count(*) from library_roots),(select count(*) from \"user\"),(select count(*) from session),(select count(*) from account),(select count(*) from library_access_grants),(select count(*) from gutter_acl_revisions),(select count(*) from gutter_acl_audit),(select count(*) from gutter_user_state_revisions),(select count(*) from user_progress),(select count(*) from user_target_state),(select count(*) from user_bookmarks),(select count(*) from user_collections),(select count(*) from user_collection_members),(select count(*) from gutter_user_state_audit),(select count(*) from catalog_preferred_release_overrides),(select count(*) from global_source_suppressions),(select count(*) from source_items where not active),(select count(*) from source_metadata_issues))")
# Create a dedicated non-superuser read-only backup actor and prove every manifest table is readable.
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='drill_backup') then create role drill_backup login; end if; end \$\$; grant connect on database gutter to drill_backup; grant usage on schema public to drill_backup; grant select on all tables in schema public to drill_backup; alter role drill_backup login nosuperuser noreplication;"
for table in $expected_tables; do
  privilege=$(docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select has_table_privilege('drill_backup', to_regclass(format('%I','$table')), 'SELECT')" | tr -d '\r')
  [ "$privilege" = t ] || { echo "backup_role_missing_select:$table:$privilege" >&2; exit 1; }
done
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db sh -c "GUTTER_BACKUP_DIR=/drill-artifacts GUTTER_DATABASE_URL=postgresql://gutter@127.0.0.1:5432/gutter GUTTER_BACKUP_ROLE=drill_backup GUTTER_BACKUP_MANIFEST=/drill-scripts/backup-table-manifest.v1 sh /drill-scripts/backup-postgres.sh" >/dev/null
archive=$(find "$root/artifacts" -maxdepth 1 -name 'gutter-*.dump' -type f | sort | tail -1)
test -n "$archive"
cp "$archive" "$root/artifacts/backup.dump"
sha256sum "$root/artifacts/backup.dump" > "$root/artifacts/backup.dump.sha256"
sed -i "s#${root}/artifacts/backup.dump#backup.dump#" "$root/artifacts/backup.dump.sha256"
cp "$archive.manifest" "$root/artifacts/backup.dump.manifest"
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans

docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" up -d db
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db pg_isready -U gutter -d gutter >/dev/null 2>&1 && break
  [ "$attempt" = 12 ] && exit 1
  sleep 2
done
# pg_restore carries the schema and grants, but PostgreSQL roles are cluster-global and are not
# included in a database dump. Create the two runtime identities before restoring those grants;
# the restored schema is then the roll-forward target for API/worker startup.
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='gutter_api') then create role gutter_api login password 'drill-db-password'; end if; if not exists (select 1 from pg_roles where rolname='gutter_worker') then create role gutter_worker login password 'drill-db-password'; end if; end \$\$;"
(cd "$root/artifacts" && sha256sum -c backup.dump.sha256)
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db sh -c "GUTTER_RESTORE_CONFIRM=YES GUTTER_RESTORE_CONFIRMATION=$project_b GUTTER_RESTORE_TARGET_IDENTITY=$project_b GUTTER_RESTORE_EXPECTED_DATABASE=gutter GUTTER_BACKUP_ARCHIVE=/drill-artifacts/backup.dump GUTTER_DATABASE_URL=postgresql://gutter@127.0.0.1:5432/gutter GUTTER_BACKUP_MANIFEST=/drill-scripts/backup-table-manifest.v1 sh /drill-scripts/restore-postgres.sh"
post_digest=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select concat_ws('|',(select count(*) from library_roots),(select count(*) from \"user\"),(select count(*) from session),(select count(*) from account),(select count(*) from library_access_grants),(select count(*) from gutter_acl_revisions),(select count(*) from gutter_acl_audit),(select count(*) from gutter_user_state_revisions),(select count(*) from user_progress),(select count(*) from user_target_state),(select count(*) from user_bookmarks),(select count(*) from user_collections),(select count(*) from user_collection_members),(select count(*) from gutter_user_state_audit),(select count(*) from catalog_preferred_release_overrides),(select count(*) from global_source_suppressions),(select count(*) from source_items where not active),(select count(*) from source_metadata_issues))")
test "$post_digest" = "$pre_digest"
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" up -d api worker web
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -fsS http://localhost:8080/ >/dev/null 2>&1 && docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker wget -q -O- http://127.0.0.1:9090/ready >/dev/null 2>&1 && break
  [ "$attempt" = 15 ] && exit 1
  sleep 2
done
# Drop only rebuildable projections/inventory. The worker must recreate them by reading the mount.
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c "delete from catalog_series_list_state; delete from catalog_releases; delete from catalog_publications; delete from catalog_series; delete from catalog_libraries;"
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx src/scan.ts scan enqueue --root drill-root >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do state=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx src/scan.ts scan status --root drill-root | tr -d '\r' | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' | head -1); [ "$state" = completed ] && break; [ "$state" = failed ] && exit 1; sleep 2; done
[ "${state:-}" = completed ]
validation_state=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select coalesce((select state from page_validation_runs v join source_items i on i.id=v.source_item_id where i.relative_path='visible' order by v.id desc limit 1),'missing')" | tr -d '\r')
test "$validation_state" = completed
validation_valid=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select coalesce((select valid_count from page_validation_runs v join source_items i on i.id=v.source_item_id where i.relative_path='visible' order by v.id desc limit 1),0)" | tr -d '\r')
test "$validation_valid" -gt 0
release_id=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select r.id from catalog_releases r join source_items i on i.id=r.source_item_id where i.relative_path='visible' order by r.id limit 1" | tr -d '\r')
reader_path="/api/reader/releases/$release_id/pages/1"
reader_token=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker node --import tsx --input-type=module -e "import { readFileSync } from 'node:fs'; import { signReaderCapability } from '@gutter/reader-stream'; process.stdout.write(signReaderCapability(readFileSync('/run/secrets/reader_capability_secret','utf8').trim(),{userId:'drill-user',rootId:'drill-root',path:'$reader_path',aclRevision:7}));" | tr -d '\r')
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c "wget -q --header='x-gutter-reader-capability: $reader_token' -O /tmp/drill-reader-page http://127.0.0.1:3001$reader_path"
cache_after=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json | wc -l' | tr -d '\r')
[ "$cache_after" -gt 0 ]
cache_sha=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -print0 | sort -z | xargs -0 sha256sum | sha256sum' | tr -d '\r')
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -delete'
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c "wget -q --header='x-gutter-reader-capability: $reader_token' -O /tmp/drill-reader-page-2 http://127.0.0.1:3001$reader_path"
cache_regenerated=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json | wc -l' | tr -d '\r')
test "$cache_regenerated" -gt 0
cache_sha_regenerated=$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'find /cache/derived -type f -not -name .operator-status.json -print0 | sort -z | xargs -0 sha256sum | sha256sum' | tr -d '\r')
test -n "$cache_sha"; test -n "$cache_sha_regenerated"
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from source_items where root_id='drill-root' and relative_path='title'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from global_source_suppressions s join source_items i on i.id=s.source_item_id where i.relative_path='title' and s.reason='drill-suppression'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from catalog_releases r join source_items i on i.id=r.source_item_id where i.relative_path='visible'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from user_progress where user_id='drill-user' and revision=3")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'test -d /drill-source && test ! -w /drill-source && test -d /cache/derived')"
test "$(sha256sum "$root/source/title/001.png" | cut -d' ' -f1)" = "$source_sha"
curl -fsS http://localhost:8080/ >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:8080/api/metrics)" = 404
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'wget -q -O- http://127.0.0.1:9090/ready >/dev/null && wget -q -O- http://127.0.0.1:9090/metrics | grep -q gutter_worker_cache_used_bytes'
echo "restore drill passed: project=$project_b durable_user=1 acl_audit=1 user_state=1 source_sha256=$source_sha cache_sha_before=$cache_sha cache_sha_after=$cache_sha_regenerated source=read-only validation=$validation_state/$validation_valid"
