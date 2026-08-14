#!/bin/sh
set -eu

# Build a disposable PostgreSQL 18.1 database at the recorded prior release boundary and
# execute the real compatibility oracle against its custom-format dump. Keeping fixture
# provisioning separate prevents the operator-facing oracle from accepting a synthetic pass.
root=$(mktemp -d "${TMPDIR:-/tmp}/gutter-migration-fixture.XXXXXX")
container="gutter-migration-fixture-$$-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="fixture-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
image='postgres:18.1@sha256:1090bc3a8ccfb0b55f78a494d76f8d603434f7e4553543d6e807bc7bd6bbd17f'
prior_tag=0014_qualified_progress_digest
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run --detach --rm --name "$container" \
  --env POSTGRES_DB=gutter --env POSTGRES_USER=gutter --env POSTGRES_PASSWORD="$password" \
  --publish 127.0.0.1::5432 "$image" >/dev/null
port=''
attempt=1
ready=0
while [ "$attempt" -le 60 ]; do
  port=$(docker port "$container" 5432/tcp 2>/dev/null | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -1)
  # The official image starts a temporary server during init. pg_isready can report that
  # server ready before POSTGRES_DB exists, so require the final PID 1 and a real query against
  # the target database before provisioning the fixture.
  if [ -n "$port" ] &&
    docker exec "$container" sh -ec 'test "$(cat /proc/1/comm)" = postgres' >/dev/null 2>&1 &&
    docker exec "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 -Atqc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
    echo 'migration fixture container exited before readiness' >&2
    docker logs "$container" >&2 || true
    exit 1
  fi
  sleep 1
  attempt=$((attempt + 1))
done
if [ "$ready" -ne 1 ]; then
  echo 'migration fixture database did not become ready' >&2
  docker logs "$container" >&2 || true
  exit 1
fi
docker exec "$container" sh -ec 'test "$(cat /proc/1/comm)" = postgres' >/dev/null
docker exec "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 -Atqc 'select 1' >/dev/null
database_url="postgresql://gutter:$password@127.0.0.1:$port/gutter"

# Read the canonical Drizzle journal rather than inventing migration timestamps. The fixture
# deliberately stops at the v1 prior boundary, and refuses to run if that boundary is missing
# or has accidentally become the current migration.
journal="$root/prior-migrations.tsv"
node - "$prior_tag" >"$journal" <<'NODE'
const { readFileSync } = require('node:fs');
const priorTag = process.argv[2];
const journal = JSON.parse(readFileSync('packages/db/drizzle/meta/_journal.json', 'utf8'));
const priorIndex = journal.entries.findIndex((entry) => entry.tag === priorTag);
if (priorIndex < 0 || priorIndex === journal.entries.length - 1) {
  throw new Error(`invalid prior migration boundary: ${priorTag}`);
}
for (const entry of journal.entries.slice(0, priorIndex + 1)) {
  if (!/^[0-9]{4}_[a-z0-9_]+$/.test(entry.tag) || !Number.isSafeInteger(entry.when)) {
    throw new Error(`invalid migration journal entry: ${entry.tag}`);
  }
  process.stdout.write(`${entry.tag}\t${entry.when}\n`);
}
NODE

tab=$(printf '\t')
docker exec "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c \
  'create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);' >/dev/null
while IFS="$tab" read -r migration_tag migration_when; do
  migration="packages/db/drizzle/$migration_tag.sql"
  test -f "$migration"
  docker exec -i "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 <"$migration" >/dev/null
  hash=$(sha256sum "$migration" | cut -d' ' -f1)
  docker exec "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 -c \
    "insert into drizzle.__drizzle_migrations(hash, created_at) values ('$hash', $migration_when);" >/dev/null
done <"$journal"

# Preserve representative durable source rows through the roll-forward migration.
docker exec -i "$container" psql -U gutter -d gutter -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into library_roots
  (id, configured_path, canonical_path, state, checked_at, config_generation)
values
  ('fixture-root', '/fixture', '/fixture', 'ready_empty', now(), repeat('a', 64));
insert into source_items
  (root_id, relative_path, kind, size_bytes, mtime_ms, page_count)
values
  ('fixture-root', 'fixture.cbz', 'cbz', 42, 1, 0);
SQL

docker exec "$container" pg_dump --format=custom --no-owner --no-privileges \
  --username gutter --file /tmp/prior-schema.dump gutter
dump="$root/prior-schema.dump"
docker cp "$container:/tmp/prior-schema.dump" "$dump" >/dev/null
printf 'fixture-api-password\n' >"$root/api-password"
printf 'fixture-worker-password\n' >"$root/worker-password"
GUTTER_DATABASE_URL="$database_url" \
GUTTER_MIGRATION_DUMP="$dump" \
GUTTER_MIGRATION_CONFIRM=YES \
GUTTER_PGTOOLS_IMAGE="$image" \
GUTTER_API_DB_PASSWORD_FILE="$root/api-password" \
GUTTER_WORKER_DB_PASSWORD_FILE="$root/worker-password" \
  ./scripts/migration-compatibility-oracle.sh
