#!/bin/sh
set -eu

# Synthetic, isolated oracle. It refuses the default project and uses only explicit drill names.
project_a="gutter-issue27-drill-a"
project_b="gutter-issue27-drill-b"
case "${COMPOSE_PROJECT_NAME:-}" in gutter|gutter-issue27-drill-a|gutter-issue27-drill-b) echo 'refusing shared/default Compose project' >&2; exit 2;; esac
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-issue27-restore-drill.XXXXXX")
mkdir -p "$root/secrets" "$root/source"
printf 'drill-db-password\n' > "$root/secrets/api_db_password"
printf 'drill-db-password\n' > "$root/secrets/worker_db_password"
printf 'drill-auth-secret-012345678901234567890123\n' > "$root/secrets/better_auth_secret"
printf 'drill-reader-secret-0123456789012345678901\n' > "$root/secrets/reader_capability_secret"
printf 'synthetic source fixture\n' > "$root/source/fixture.txt"
chmod 600 "$root/secrets"/*
checksum=$(sha256sum "$root/source/fixture.txt" | cut -d' ' -f1)
cat > "$root/override.yaml" <<EOF
services:
  web:
    networks:
      internal: !override {}
  db:
    environment: { POSTGRES_PASSWORD: drill-db-password }
  migrate:
    environment: { DATABASE_URL: postgresql://gutter:drill-db-password@db:5432/gutter }
  api:
    environment: { DATABASE_HOST: db, DATABASE_NAME: gutter, DATABASE_USER: gutter_api, DATABASE_PASSWORD_FILE: /run/secrets/api_db_password, BETTER_AUTH_SECRET_FILE: /run/secrets/better_auth_secret, GUTTER_READER_CAPABILITY_SECRET_FILE: /run/secrets/reader_capability_secret }
    networks:
      internal: !override {}
  worker:
    environment: { DATABASE_HOST: db, DATABASE_NAME: gutter, DATABASE_USER: gutter_worker, DATABASE_PASSWORD_FILE: /run/secrets/worker_db_password, GUTTER_ALLOWED_ROOTS_JSON: '[]' }
secrets:
  api_db_password: { file: $root/secrets/api_db_password }
  worker_db_password: { file: $root/secrets/worker_db_password }
  better_auth_secret: { file: $root/secrets/better_auth_secret }
  reader_capability_secret: { file: $root/secrets/reader_capability_secret }
networks:
  internal: !override
    internal: true
EOF
if [ "${DRILL_CONFIG_ONLY:-}" = 1 ]; then
  docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" config
  exit 0
fi
cleanup() { docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" up -d db migrate
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" wait migrate
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c "insert into gutter_schema(version) values ('drill-durable-row') on conflict do nothing;"
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" exec -T db pg_dump -U gutter -d gutter -Fc > "$root/backup.dump"
docker compose -p "$project_a" -f compose.yaml -f "$root/override.yaml" down -v --remove-orphans
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" up -d db
docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db pg_restore -U gutter -d gutter --clean --if-exists < "$root/backup.dump"
test "$(docker compose -p "$project_b" -f compose.yaml -f "$root/override.yaml" exec -T db psql -U gutter -d gutter -Atc "select count(*) from gutter_schema where version='drill-durable-row';")" -eq 1
test "$(sha256sum "$root/source/fixture.txt" | cut -d' ' -f1)" = "$checksum"
echo "restore drill passed: project=$project_b durable_rows=1 source_sha256=$checksum cache=disposable"
