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
: "${GUTTER_DATABASE_PASSWORD_FILE:?set GUTTER_DATABASE_PASSWORD_FILE to the target database secret file}"
: "${GUTTER_DATABASE_USER:=gutter}"
test -f "$GUTTER_BACKUP_ARCHIVE" || { echo 'backup archive not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_ARCHIVE.manifest" || { echo 'archive table manifest not found' >&2; exit 2; }
test -f "$GUTTER_BACKUP_MANIFEST" || { echo 'backup table manifest not found' >&2; exit 2; }
test -s "$GUTTER_DATABASE_PASSWORD_FILE" || { echo 'target database password file is empty' >&2; exit 2; }
umask 077
pgpass=$(mktemp "${TMPDIR:-/tmp}/gutter-restore-pgpass.XXXXXX")
toc=''
restore_log=''
cleanup_restore() { rm -f "$pgpass" ${toc:+"$toc"} ${restore_log:+"$restore_log"}; }
trap cleanup_restore EXIT INT TERM
printf '*:*:*:%s:%s\n' "$GUTTER_DATABASE_USER" "$(tr -d '\r\n' < "$GUTTER_DATABASE_PASSWORD_FILE")" > "$pgpass"
export PGPASSFILE="$pgpass"
case "$GUTTER_BACKUP_ARCHIVE" in *.dump) ;; *) echo 'archive must use .dump extension' >&2; exit 2;; esac
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" >/dev/null
test -f "$GUTTER_BACKUP_ARCHIVE.sha256" || { echo 'archive checksum manifest not found' >&2; exit 2; }
archive_dir=$(dirname "$GUTTER_BACKUP_ARCHIVE")
archive_name=$(basename "$GUTTER_BACKUP_ARCHIVE")
(cd "$archive_dir" && sha256sum --check "$archive_name.sha256")
diff -u "$GUTTER_BACKUP_MANIFEST" "$GUTTER_BACKUP_ARCHIVE.manifest"
toc=$(mktemp "${TMPDIR:-/tmp}/gutter-restore-toc.XXXXXX")
pg_restore --list "$GUTTER_BACKUP_ARCHIVE" > "$toc"
sh "$(dirname "$GUTTER_RUNTIME_ACL_SCRIPT")/compare-backup-manifest.sh" "$GUTTER_BACKUP_MANIFEST" "$toc"
observed_database=$(psql "$GUTTER_DATABASE_URL" -AtX -c 'select current_database()')
test "$observed_database" = "$GUTTER_RESTORE_EXPECTED_DATABASE" || {
  echo "restore target database mismatch: observed=$observed_database expected=$GUTTER_RESTORE_EXPECTED_DATABASE" >&2
  exit 2
}
test "$GUTTER_RESTORE_CONFIRMATION" = "$GUTTER_RESTORE_TARGET_IDENTITY" || {
  echo 'restore confirmation does not match the observed target identity' >&2
  exit 2
}
# Never clean or drop a target schema during an operator restore.  A restore is
# permitted only into a fresh database whose public schema contains no
# application-owned relations/functions; the default plpgsql and migration-
# required pg_trgm extensions are the only pre-existing extension state allowed.
target_relations=$(psql "$GUTTER_DATABASE_URL" -AtX -v ON_ERROR_STOP=1 -c "
select count(*)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  and not exists (
    select 1
    from pg_depend d
    where d.classid = 'pg_class'::regclass
      and d.objid = c.oid
      and d.deptype = 'e'
  )")
target_functions=$(psql "$GUTTER_DATABASE_URL" -AtX -v ON_ERROR_STOP=1 -c "
select count(*)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (
    select 1
    from pg_depend d
    where d.classid = 'pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
  )")
unexpected_extensions=$(psql "$GUTTER_DATABASE_URL" -AtX -v ON_ERROR_STOP=1 -c "
select count(*)
from pg_extension
where extname not in ('plpgsql', 'pg_trgm')")
if [ "$target_relations" -ne 0 ] || [ "$target_functions" -ne 0 ] || [ "$unexpected_extensions" -ne 0 ]; then
  echo "restore target is not fresh: relations=$target_relations functions=$target_functions unexpected_extensions=$unexpected_extensions" >&2
  exit 2
fi
# The archive is schema-scoped, so extension objects are not guaranteed to be
# present in its TOC. Create migration-owned dependencies before restore and
# before the canonical ACL policy references pgcrypto's digest function.
psql "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'create extension if not exists pg_trgm'
psql "$GUTTER_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'create extension if not exists pgcrypto'
restore_log=$(mktemp "${TMPDIR:-/tmp}/gutter-restore-log.XXXXXX")
set +e
pg_restore --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" "$GUTTER_BACKUP_ARCHIVE" 2>"$restore_log"
restore_status=$?
set -e
if [ "$restore_status" -ne 0 ]; then
  # Empty serial tables are valid in the durable manifest. PostgreSQL emits a
  # benign setval(0,false) failure for those empty sequences; all other restore
  # errors remain fatal without echoing archive contents into the log.
  if ! grep -Eq '^pg_restore: error:' "$restore_log" \
    || grep -E '^pg_restore: error:' "$restore_log" | grep -Ev 'setval: value 0 is out of bounds|schema "public" already exists' | grep -q .; then
    nonbenign_error=$(grep -E '^pg_restore: error:' "$restore_log" | grep -Ev 'setval: value 0 is out of bounds|schema "public" already exists' | head -1 || true)
    echo "restore failed with non-benign archive error: $nonbenign_error" >&2
    exit 1
  fi
fi
while IFS= read -r table; do
  test -n "$table"
  test "$(psql "$GUTTER_DATABASE_URL" -AtX -c "select to_regclass('public.\"$table\"')")" != '' || { echo "restored table missing: $table" >&2; exit 1; }
done < "$GUTTER_BACKUP_MANIFEST"
GUTTER_DATABASE_URL="$GUTTER_DATABASE_URL" sh "$GUTTER_RUNTIME_ACL_SCRIPT"
post_restore_digest=$(pg_dump --data-only --no-owner --no-privileges --dbname "$GUTTER_DATABASE_URL" | sha256sum | cut -d' ' -f1)
test -n "$post_restore_digest"
printf '%s\n' "restore complete; target_database=$observed_database post_restore_digest=$post_restore_digest; run pnpm migrate and the isolated restore/rebuild drill before startup"
