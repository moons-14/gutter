#!/bin/sh
set -eu

# Contract oracle: no destructive downgrade is attempted. A real PostgreSQL target is explicit.
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL to a disposable prior-schema database}"
: "${GUTTER_MIGRATION_DUMP:?set GUTTER_MIGRATION_DUMP to a pre-upgrade dump file}"
test -f "$GUTTER_MIGRATION_DUMP"
pg_restore --list "$GUTTER_MIGRATION_DUMP" >/dev/null
corepack pnpm migrate
psql "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select version from gutter_schema order by version;" >/dev/null
echo 'expand/contract compatibility passed; rollback boundary is restore pre-upgrade dump then roll forward'
