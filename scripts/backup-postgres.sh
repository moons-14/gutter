#!/bin/sh
set -eu
: "${GUTTER_BACKUP_DIR:?set GUTTER_BACKUP_DIR to an existing, operator-owned directory}"
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL (use a secret-managed value)}"
: "${GUTTER_BACKUP_ROLE:?set GUTTER_BACKUP_ROLE to a dedicated read-only backup role}"
: "${GUTTER_BACKUP_MANIFEST:=$(dirname "$0")/backup-table-manifest.v1}"
case "$GUTTER_BACKUP_ROLE" in gutter_api|gutter_worker|gutter|postgres) echo 'refusing runtime or superuser backup role' >&2; exit 2;; esac
case "$GUTTER_BACKUP_DIR" in /|/tmp|/var|/home) echo 'refusing broad backup directory' >&2; exit 2;; esac
test -d "$GUTTER_BACKUP_DIR" || { echo 'backup directory must already exist' >&2; exit 2; }
test -f "$GUTTER_BACKUP_MANIFEST" || { echo 'backup table manifest not found' >&2; exit 2; }
role_flags=$(psql "$GUTTER_DATABASE_URL" -AtX -v ON_ERROR_STOP=1 -c "select rolcanlogin, rolsuper, rolreplication from pg_roles where rolname='${GUTTER_BACKUP_ROLE}'")
test "$role_flags" = 't|f|f' || { echo "backup role must be login-enabled, non-superuser, and non-replication: $GUTTER_BACKUP_ROLE" >&2; exit 1; }
while IFS= read -r table; do
  test -n "$table"
  test "$(psql "$GUTTER_DATABASE_URL" -AtX -c "select has_table_privilege('$GUTTER_BACKUP_ROLE', 'public.\"$table\"', 'SELECT')")" = t || { echo "backup role lacks SELECT on $table" >&2; exit 1; }
done < "$GUTTER_BACKUP_MANIFEST"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$GUTTER_BACKUP_DIR/gutter-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges --username "$GUTTER_BACKUP_ROLE" --file "$archive" "$GUTTER_DATABASE_URL"
pg_restore --list "$archive" >/dev/null
sha256sum "$archive" > "$archive.sha256"
pg_restore --list "$archive" | awk '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 == "public" { name=$6; sub(/^\"/,"",name); sub(/\"$/,"",name); print name }' | sort -u > "$archive.tables"
test -s "$archive.tables" || { echo 'backup archive TOC contains no public table entries' >&2; exit 1; }
diff -u "$GUTTER_BACKUP_MANIFEST" "$archive.tables" || {
  echo 'backup archive table set does not match the versioned manifest' >&2
  exit 1
}
cp "$GUTTER_BACKUP_MANIFEST" "$archive.manifest"
printf '%s\n' "$archive"
