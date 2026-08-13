#!/bin/sh
set -eu
: "${GUTTER_BACKUP_DIR:?set GUTTER_BACKUP_DIR to an existing, operator-owned directory}"
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL (use a secret-managed value)}"
: "${GUTTER_BACKUP_ROLE:?set GUTTER_BACKUP_ROLE to a dedicated read-only backup role}"
case "$GUTTER_BACKUP_ROLE" in gutter_api|gutter_worker|gutter|postgres) echo 'refusing runtime or superuser backup role' >&2; exit 2;; esac
case "$GUTTER_BACKUP_DIR" in /|/tmp|/var|/home) echo 'refusing broad backup directory' >&2; exit 2;; esac
test -d "$GUTTER_BACKUP_DIR" || { echo 'backup directory must already exist' >&2; exit 2; }
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$GUTTER_BACKUP_DIR/gutter-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges --username "$GUTTER_BACKUP_ROLE" --file "$archive" "$GUTTER_DATABASE_URL"
pg_restore --list "$archive" >/dev/null
sha256sum "$archive" > "$archive.sha256"
pg_restore --list "$archive" | awk '/TABLE DATA|TABLE public\./ {print $NF}' | sort -u > "$archive.tables"
printf '%s\n' "$archive"
