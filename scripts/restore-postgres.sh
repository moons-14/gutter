#!/bin/sh
set -eu
[ "${GUTTER_RESTORE_CONFIRM:-}" = YES ] || { echo 'set GUTTER_RESTORE_CONFIRM=YES after stopping API and worker' >&2; exit 2; }
: "${GUTTER_BACKUP_ARCHIVE:?set GUTTER_BACKUP_ARCHIVE to one .dump file}"
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL (use a secret-managed value)}"
test -f "$GUTTER_BACKUP_ARCHIVE" || { echo 'backup archive not found' >&2; exit 2; }
case "$GUTTER_BACKUP_ARCHIVE" in *.dump) ;; *) echo 'archive must use .dump extension' >&2; exit 2;; esac
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" >/dev/null
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_BACKUP_ARCHIVE"
printf '%s\n' 'restore complete; run pnpm migrate and the isolated restore/rebuild drill before startup'
