#!/bin/sh
set -eu

# End-to-end recovery oracle.  This deliberately uses two isolated Compose projects:
# A is seeded and backed up, then destroyed; B restores the durable state into a new
# database, starts every runtime service, and rebuilds the catalog from a read-only root.
project_a="gutter-issue27-drill-a"
project_b="gutter-issue27-drill-b"
case "${COMPOSE_PROJECT_NAME:-}" in gutter|gutter-issue27-drill-a|gutter-issue27-drill-b) echo 'refusing shared/default Compose project' >&2; exit 2;; esac
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-issue27-restore-drill.XXXXXX")
mkdir -p "$root/secrets" "$root/source/title" "$root/source/visible"
cleanup() { if [ "${DRILL_DEBUG:-0}" = 1 ]; then docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" logs migrate || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" logs migrate || true; fi; docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT INT TERM

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
if grep -Eq '(^|[[:space:]])(ipv4_address|subnet):' "$merged_config"; then
  echo 'restore drill preflight failed: fixed network address or subnet detected' >&2
  exit 1
fi
if ! grep -Eq '^networks:[[:space:]]*$' "$merged_config" \
  || ! grep -Eq '^  internal:[[:space:]]*$' "$merged_config" \
  || ! grep -Eq '^    internal: true[[:space:]]*$' "$merged_config"; then
  echo 'restore drill preflight failed: internal network must be defined and internal' >&2
  exit 1
fi
[ "${DRILL_CONFIG_ONLY:-0}" = 1 ] && exit 0
expected_tables='user session account verification twoFactor passkey gutter_auth_bootstrap library_roots library_access_grants gutter_acl_revisions gutter_acl_audit gutter_user_state_revisions user_progress user_target_state user_bookmarks user_collections user_collection_members gutter_user_state_audit gutter_acl_request_claims'
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
insert into gutter_schema(version) values ('drill-scan-archive-error') on conflict do nothing;
SQL
# Prove the backup actor can read the complete durable manifest, then record explicit counts/digests.
for table in $expected_tables; do
  privilege=$(docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select has_table_privilege('gutter', to_regclass(format('%I','$table')), 'SELECT')" | tr -d '\r')
  [ "$privilege" = t ] || { echo "backup_role_missing_select:$table:$privilege" >&2; exit 1; }
done
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db pg_dump -U gutter -d gutter -Fc > "$root/backup.dump"
sha256sum "$root/backup.dump" > "$root/backup.dump.sha256"
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
sha256sum -c "$root/backup.dump.sha256"
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db pg_restore -U gutter -d gutter --clean --if-exists < "$root/backup.dump"
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
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from source_items where root_id='drill-root' and relative_path='title'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from global_source_suppressions s join source_items i on i.id=s.source_item_id where i.relative_path='title' and s.reason='drill-suppression'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from catalog_releases r join source_items i on i.id=r.source_item_id where i.relative_path='visible'")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from user_progress where user_id='drill-user' and revision=3")" -eq 1
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'test -d /drill-source && test ! -w /drill-source && test -d /cache/derived')"
test "$(sha256sum "$root/source/title/001.png" | cut -d' ' -f1)" = "$source_sha"
curl -fsS http://localhost:8080/ >/dev/null
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T worker sh -c 'wget -q -O- http://127.0.0.1:9090/ready >/dev/null && wget -q -O- http://127.0.0.1:9090/metrics | grep -q gutter_worker_cache_used_bytes'
echo "restore drill passed: project=$project_b durable_user=1 acl_audit=1 user_state=1 source_sha256=$source_sha cache=regenerated source=read-only"
