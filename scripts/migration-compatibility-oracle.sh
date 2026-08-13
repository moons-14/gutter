#!/bin/sh
set -eu

# Contract oracle: this target is disposable. Restore the supplied prior-schema artifact,
# record representative durable rows, then migrate forward and verify preservation.
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL to a disposable prior-schema database}"
: "${GUTTER_MIGRATION_DUMP:?set GUTTER_MIGRATION_DUMP to a pre-upgrade dump file}"
[ "${GUTTER_MIGRATION_CONFIRM:-}" = YES ] || { echo 'set GUTTER_MIGRATION_CONFIRM=YES for a disposable target' >&2; exit 2; }
test -f "$GUTTER_MIGRATION_DUMP"
test ! -L "$GUTTER_MIGRATION_DUMP"
dump_dir=$(cd "$(dirname "$GUTTER_MIGRATION_DUMP")" && pwd)
dump_name=$(basename "$GUTTER_MIGRATION_DUMP")
case "$dump_name" in ''|.|..|*/*) echo 'invalid migration dump name' >&2; exit 2 ;; esac

if [ -n "${GUTTER_PGTOOLS_IMAGE:-}" ]; then
  case "$GUTTER_PGTOOLS_IMAGE" in
    *@sha256:*) pgtools_digest=${GUTTER_PGTOOLS_IMAGE##*@sha256:} ;;
    *) echo 'GUTTER_PGTOOLS_IMAGE must be digest-pinned' >&2; exit 2 ;;
  esac
  if [ "${#pgtools_digest}" -ne 64 ]; then
    echo 'GUTTER_PGTOOLS_IMAGE must use a 64-character sha256 digest' >&2
    exit 2
  fi
  case "$pgtools_digest" in
    *[!0-9a-f]*) echo 'GUTTER_PGTOOLS_IMAGE sha256 digest must be lowercase hexadecimal' >&2; exit 2 ;;
  esac
  pg_restore_list() {
    docker run --rm --network host -v "$dump_dir:/fixture:ro" "$GUTTER_PGTOOLS_IMAGE" \
      pg_restore --list "/fixture/$dump_name"
  }
  pg_restore_apply() {
    docker run --rm --network host -v "$dump_dir:/fixture:ro" "$GUTTER_PGTOOLS_IMAGE" \
      pg_restore --clean --if-exists --no-owner --no-privileges \
      --dbname "$GUTTER_DATABASE_URL" "/fixture/$dump_name"
  }
  psql_tool() { docker run --rm --network host "$GUTTER_PGTOOLS_IMAGE" psql "$@"; }
else
  pg_restore_list() { pg_restore --list "$GUTTER_MIGRATION_DUMP"; }
  pg_restore_apply() { pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_MIGRATION_DUMP"; }
  psql_tool() { psql "$@"; }
fi

current_version=$(node -e "const j=require('./packages/db/drizzle/meta/_journal.json'); const e=j.entries.at(-1); if(!e||!/^\\d{4}_[a-z0-9_]+$/.test(e.tag)) process.exit(1); process.stdout.write(e.tag)")
pg_restore_list >/dev/null
pg_restore_apply
legacy_roots=$(psql_tool "$GUTTER_DATABASE_URL" -Atc 'select count(*) from library_roots')
legacy_source_items=$(psql_tool "$GUTTER_DATABASE_URL" -Atc 'select count(*) from source_items')
test "$(psql_tool "$GUTTER_DATABASE_URL" -Atc "select count(*) from gutter_schema where version='$current_version'")" -eq 0
DATABASE_URL="$GUTTER_DATABASE_URL" DB_URL= PGDATABASE= PGHOST= PGPORT= PGUSER= PGPASSWORD= \
  corepack pnpm --filter @gutter/db migrate
test "$(psql_tool "$GUTTER_DATABASE_URL" -Atc 'select count(*) from library_roots')" -eq "$legacy_roots"
test "$(psql_tool "$GUTTER_DATABASE_URL" -Atc 'select count(*) from source_items')" -eq "$legacy_source_items"
test "$(psql_tool "$GUTTER_DATABASE_URL" -Atc "select count(*) from gutter_schema where version='$current_version'")" -eq 1
psql_tool "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select to_regclass('public.gutter_schema'), to_regclass('public.library_roots'), to_regclass('public.source_items');" >/dev/null
echo "pre-upgrade restore+migrate row-preservation oracle passed; current=$current_version preserved library_roots=$legacy_roots source_items=$legacy_source_items; rollback boundary is restore prior dump then roll forward"
