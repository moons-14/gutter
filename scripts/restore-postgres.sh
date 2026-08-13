#!/bin/sh
set -eu
[ "${GUTTER_RESTORE_CONFIRM:-}" = YES ] || { echo 'set GUTTER_RESTORE_CONFIRM=YES after stopping API and worker' >&2; exit 2; }
: "${GUTTER_BACKUP_ARCHIVE:?set GUTTER_BACKUP_ARCHIVE to one .dump file}"
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL (use a secret-managed value)}"
: "${GUTTER_RESTORE_CONFIRMATION:?set GUTTER_RESTORE_CONFIRMATION to the isolated target identity}"
: "${GUTTER_RESTORE_TARGET_IDENTITY:?set GUTTER_RESTORE_TARGET_IDENTITY to the isolated target identity}"
: "${GUTTER_BACKUP_MANIFEST:=$(dirname "$0")/backup-table-manifest.v1}"
test -f "$GUTTER_BACKUP_ARCHIVE" || { echo 'backup archive not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_ARCHIVE.manifest" || { echo 'archive table manifest not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_MANIFEST" || { echo 'backup table manifest not found' >&2; exit 2; }
case "$GUTTER_BACKUP_ARCHIVE" in *.dump) ;; *) echo 'archive must use .dump extension' >&2; exit 2;; esac
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" >/dev/null
test -f "$GUTTER_BACKUP_ARCHIVE.sha256" || { echo 'archive checksum manifest not found' >&2; exit 2; }
sha256sum --check "$GUTTER_BACKUP_ARCHIVE.sha256"
diff -u "$GUTTER_BACKUP_MANIFEST" "$GUTTER_BACKUP_ARCHIVE.manifest"
archive_tables=$(mktemp "${TMPDIR:-/tmp}/gutter-restore-tables.XXXXXX")
trap 'rm -f "$archive_tables"' EXIT INT TERM
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" | sed -n 's/^;.*TABLE public \([^ ]*\).*/\1/p' | sort -u > "$archive_tables"
diff -u "$GUTTER_BACKUP_MANIFEST" "$archive_tables"
test "$GUTTER_RESTORE_CONFIRMATION" = "$GUTTER_RESTORE_TARGET_IDENTITY" || {
  echo 'restore confirmation does not match the observed target identity' >&2
  exit 2
}
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_BACKUP_ARCHIVE"
printf '%s\n' 'restore complete; run pnpm migrate and the isolated restore/rebuild drill before startup'
