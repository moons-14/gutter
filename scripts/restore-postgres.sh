#!/bin/sh
set -eu
[ "${GUTTER_RESTORE_CONFIRM:-}" = YES ] || { echo 'set GUTTER_RESTORE_CONFIRM=YES after stopping API and worker' >&2; exit 2; }
: "${GUTTER_BACKUP_ARCHIVE:?set GUTTER_BACKUP_ARCHIVE to one .dump file}"
: "${GUTTER_DATABASE_URL:?set GUTTER_DATABASE_URL (use a secret-managed value)}"
: "${GUTTER_RESTORE_CONFIRMATION:?set GUTTER_RESTORE_CONFIRMATION to the isolated target identity}"
: "${GUTTER_RESTORE_TARGET_IDENTITY:?set GUTTER_RESTORE_TARGET_IDENTITY to the isolated target identity}"
: "${GUTTER_RESTORE_EXPECTED_DATABASE:?set GUTTER_RESTORE_EXPECTED_DATABASE to the expected database name}"
: "${GUTTER_BACKUP_MANIFEST:=$(dirname "$0")/backup-table-manifest.v1}"
: "${GUTTER_RUNTIME_ACL_SCRIPT:=$(dirname "$0")/bootstrap-runtime-acl.sh}"
test -f "$GUTTER_BACKUP_ARCHIVE" || { echo 'backup archive not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_ARCHIVE.manifest" || { echo 'archive table manifest not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_MANIFEST" || { echo 'backup table manifest not found' >&2; exit 2; }
case "$GUTTER_BACKUP_ARCHIVE" in *.dump) ;; *) echo 'archive must use .dump extension' >&2; exit 2;; esac
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" >/dev/null
test -f "$GUTTER_BACKUP_ARCHIVE.sha256" || { echo 'archive checksum manifest not found' >&2; exit 2; }
sha256sum --check "$GUTTER_BACKUP_ARCHIVE.sha256"
diff -u "$GUTTER_BACKUP_MANIFEST" "$GUTTER_BACKUP_ARCHIVE.manifest"
toc=$(mktemp "${TMPDIR:-/tmp}/gutter-restore-toc.XXXXXX")
trap 'rm -f "$toc"' EXIT INT TERM
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" > "$toc"
node "$(dirname "$GUTTER_RUNTIME_ACL_SCRIPT")/compare-backup-manifest.mjs" "$GUTTER_BACKUP_MANIFEST" "$toc"
observed_database=$(psql "$GUTTER_DATABASE_URL" -AtX -c 'select current_database()')
test "$observed_database" = "$GUTTER_RESTORE_EXPECTED_DATABASE" || {
  echo "restore target database mismatch: observed=$observed_database expected=$GUTTER_RESTORE_EXPECTED_DATABASE" >&2
  exit 2
}
test "$GUTTER_RESTORE_CONFIRMATION" = "$GUTTER_RESTORE_TARGET_IDENTITY" || {
  echo 'restore confirmation does not match the observed target identity' >&2
  exit 2
}
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_BACKUP_ARCHIVE"
while IFS= read -r table; do
  test -n "$table"
  test "$(psql "$GUTTER_DATABASE_URL" -AtX -c "select to_regclass('public.\"$table\"')")" != '' || { echo "restored table missing: $table" >&2; exit 1; }
done < "$GUTTER_BACKUP_MANIFEST"
GUTTER_DATABASE_URL="$GUTTER_DATABASE_URL" sh "$GUTTER_RUNTIME_ACL_SCRIPT"
post_restore_digest=$(pg_dump --data-only --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" | sha256sum | cut -d' ' -f1)
test -n "$post_restore_digest"
printf '%s\n' "restore complete; target_database=$observed_database post_restore_digest=$post_restore_digest; run pnpm migrate and the isolated restore/rebuild drill before startup"
