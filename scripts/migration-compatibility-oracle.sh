#!/bin/sh
set -eu

# Contract oracle: this target is disposable. Restore the supplied prior-schema artifact,
# record representative durable rows, then migrate forward and verify preservation.
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL to a disposable prior-schema database}"
: "${GUTTER_MIGRATION_DUMP:?set GUTTER_MIGRATION_DUMP to a pre-upgrade dump file}"
[ "${GUTTER_MIGRATION_CONFIRM:-}" = YES ] || { echo 'set GUTTER_MIGRATION_CONFIRM=YES for a disposable target' >&2; exit 2; }
test -f "$GUTTER_MIGRATION_DUMP"
pg_restore --list "$GUTTER_MIGRATION_DUMP" >/dev/null
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_MIGRATION_DUMP"
legacy_roots=$(psql "$GUTTER_DATABASE_URL" -Atc 'select count(*) from library_roots')
legacy_source_items=$(psql "$GUTTER_DATABASE_URL" -Atc 'select count(*) from source_items')
DATABASE_URL="$GUTTER_DATABASE_URL" DB_URL= PGDATABASE= PGHOST= PGPORT= PGUSER= PGPASSWORD= corepack pnpm migrate
test "$(psql "$GUTTER_DATABASE_URL" -Atc 'select count(*) from library_roots')" -eq "$legacy_roots"
test "$(psql "$GUTTER_DATABASE_URL" -Atc 'select count(*) from source_items')" -eq "$legacy_source_items"
psql "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select to_regclass('public.gutter_schema'), to_regclass('public.library_roots'), to_regclass('public.source_items');" >/dev/null
echo "pre-upgrade restore+migrate row-preservation oracle passed; preserved library_roots=$legacy_roots source_items=$legacy_source_items; rollback boundary is restore prior dump then roll forward"
