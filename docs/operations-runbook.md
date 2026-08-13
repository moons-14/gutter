# Operations runbook (M6-2)

This is the recovery contract for the local Compose deployment. API and worker are internal
services; only `web` is published. Stop API and worker before database maintenance. Never mount a
backup destination into a source library, and never let a recovery command write to a source mount.

## What is data and what is disposable

PostgreSQL is the durable system of record. Back up the Better Auth tables (`user`, `session`,
`account`, `verification`, `twoFactor`, `passkey`), ACL/grant and revision tables, user progress,
bookmarks, collections, overrides/suppressions, scan/audit history, and deletion tombstones. Keep
the current Better Auth secret and any retained previous secret with the encrypted backup; without
the matching secret, sessions and encrypted recovery material may be unusable. ACL and user-state
audit rows are append-only and must survive restore.

The read-only source inventory (NAS or local source mount) is externally backed up by the operator.
The derived reader cache (`cache-data`) contains only content-addressed source-derived bytes and
is disposable: loss, eviction, or corruption must trigger a source read and projection rebuild.
Cache counters are advisory and may reset. Do not include cache bytes in the PostgreSQL backup.
Catalog tables are rebuildable projections; a restore is not complete until the source is mounted
and a reconciliation scan has completed.

## Backup and restore

Use an existing, restricted backup directory and secret-managed `GUTTER_DATABASE_URL`:

```sh
GUTTER_BACKUP_DIR=/secure/gutter-backups GUTTER_DATABASE_URL="$DATABASE_URL" \
  ./scripts/backup-postgres.sh
```

The script creates a timestamped custom-format dump, checks its table-of-contents, uses mode 0600,
and refuses broad directories. Encrypt/copy that dump and the Better Auth secret through the
operator's external backup system. Verify restore archives with `pg_restore --list`; retain at
least the last successful backup and test one on every release.

For a fresh, isolated Compose project, provision a new database and secret, stop API/worker, then:

```sh
GUTTER_RESTORE_CONFIRM=YES GUTTER_BACKUP_ARCHIVE=/secure/gutter-backups/gutter-<stamp>.dump \
  GUTTER_DATABASE_URL="$ISOLATED_DATABASE_URL" ./scripts/restore-postgres.sh
pnpm migrate
docker compose -p gutter-restore -f compose.yaml up -d db migrate api worker web
curl -fsS http://localhost:8080/api/health
curl -fsS http://localhost:8080/api/ready
docker compose -p gutter-restore exec worker node --import tsx src/scan.ts scan status
```

Mount a read-only copy of the externally backed-up source library into the worker, configure the
same stable root ID, and enqueue `scan enqueue --root <root-id>`. Assert that a previously visible
catalog item reappears, while user state, ACLs, overrides, audit rows, and tombstones remain. This
is the required fresh-Compose restore/rebuild drill; record the dump checksum, schema version,
scan request/run IDs, and command output in the release evidence. Destroy the isolated project
only after its evidence is copied to the incident/release record.

## Upgrade and rollback boundaries

Every schema change is one numbered Drizzle SQL migration applied only by `pnpm migrate`; never
edit an applied migration. Use expand/contract: (1) expand with nullable/additive columns, tables,
indexes, or dual-write compatibility; (2) deploy code that reads old and new forms and backfills
in bounded batches; (3) verify counts and application metrics; (4) contract only in a later release
after the minimum rollback window. Avoid destructive renames, type narrowing, or dropping columns
in the same release as the code that first uses them.

The executable migration boundary check is `scripts/migration-compatibility-oracle.sh`. It creates
a disposable prior-schema database, applies the current migrations, checks that representative
legacy rows remain readable, and records rollback as restore of the pre-upgrade dump followed by
roll-forward. A downgrade that requires destructive SQL is unsupported; the oracle must pass before
publishing a migration.

Supported upgrade is one release at a time from the prior recorded schema. Take and verify a
backup, run migrations, then readiness and scan smoke checks. Rollback is supported only before a
contract migration or while the old binary remains compatible with the expanded schema. If a
migration has changed durable data or dropped a compatibility path, restore the pre-upgrade dump
into a fresh project and roll forward; do not downgrade production by hand. Keep source mounts
read-only throughout.

## Health, readiness, metrics, and logs

`GET /api/health` means the API process is alive. `GET /api/ready` checks the database schema and
returns 503 until migrations are complete. `GET /api/metrics` is internal and emits bounded
Prometheus metrics: `gutter_queue_lag_seconds`, `gutter_scan_runs{state}`,
`gutter_reconciliation_requests{trigger,state}`, and `gutter_database_size_bytes`, plus bounded
process defaults. States/triggers are allow-listed; no user, root path, source path, archive name,
email, request payload, host path, or secret is a label. Queue lag is the age of the oldest queued
request; scan state is bounded to running/completed/failed/cancelled. Alert on readiness failure,
queue lag above the local SLO, failed scans, and database size approaching the database volume
limit. The cache-owning worker exposes internal-only `:9090/health`, `:9090/ready`, and
`:9090/metrics` endpoints (`expose`, never a published port). Its bounded metrics report cache
used/quota/free bytes and scan requests by allow-listed state. The worker's `scan status` and
`cache.ts status` remain the detailed operator views; cache status reports filesystem bytes/quota
and advisory counters.

Logs are structured and redact authorization, cookies, passwords, tokens, and secrets. Do not add
source paths, host paths, email addresses, archive contents, or request bodies to logs or metrics.
Ship logs to an access-controlled sink with a 30-day default retention; shorten where local policy
requires it. Keep ACL/user-state audit rows and tombstones indefinitely unless a documented legal
retention policy authorizes an append-only archival transfer. Retain scan errors for 30 days and
rebuildable catalog/cache state only as needed for operations. Purge logs through the sink, never
by deleting audit rows.

## Incident diagnostics

- **NAS unavailable:** do not mark sources deleted or delete projections. Check host mount and
  `scan status`; the root should become `unavailable`. Restore NAS connectivity, verify the mount
  is read-only, then enqueue a root reconciliation.
- **Corrupt archive:** preserve the source and inspect the bounded scan error code. Replace the
  source externally, then enqueue a new scan; never quarantine by writing into the library.
- **Stuck jobs:** inspect queue lag, `scan status`, and worker logs for bounded error codes. Cancel
  only the request/run ID, then enqueue one bounded retry after confirming the source and DB are up.
- **Database exhaustion:** stop workers first, capture `pg_database_size` and PostgreSQL logs,
  ensure backups are current, expand storage, and restart through `migrate`; do not delete audit,
  tombstone, ACL, or user-state rows as an emergency shortcut.
- **Full cache disk:** stop the worker or run its bounded cache GC, inspect `cache.ts status`,
  and expand/replace the disposable cache volume. Never delete source files or database data to
  make cache space. A completely empty cache is safe; the next read regenerates it.

Run `node scripts/verify-operations.mjs` in CI to ensure this contract and metric names remain
present. A synthetic, guarded oracle is available as `scripts/compose-restore-drill.sh`; it uses
only uniquely named projects, fresh volumes, generated test secrets, and a temporary source
fixture, and prints the durable-row count and source checksum. Run it in a Docker-enabled CI lane
before declaring an operational release. The focused API typecheck and unit suite are the minimum
pre-release checks; the isolated Compose restore/rebuild drill above is required before declaring
an operational release.
