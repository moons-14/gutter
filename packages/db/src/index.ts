import { databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { ScanItem, ScanSummary } from '@gutter/discovery-scanner';

export const pool = new Pool({ connectionString: await databaseUrl() });
export const db = drizzle(pool);

export class StaleScanRunError extends Error {
  override readonly name = 'StaleScanRunError';
  readonly code = 'stale_scan_run';

  constructor() {
    super('stale_scan_run');
  }
}

export async function migrateSchema(): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
}

export async function assertSchema(): Promise<void> {
  const result = await pool.query<{ version: string }>(
    'select version from gutter_schema where version = $1 limit 1',
    [schemaVersion],
  );
  if (!result.rows[0])
    throw new Error(`database schema is incompatible; expected ${schemaVersion}`);
}

export async function reconcileLibraryRoots(
  roots: readonly LibraryRootSnapshot[],
  configGeneration: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('update library_roots set active = false, updated_at = now() where active');
    for (const root of roots) {
      await client.query(
        `insert into library_roots
          (id, configured_path, canonical_path, state, reason_code, checked_at, config_generation, active)
         values ($1, $2, $3, $4, $5, $6, $7, true)
         on conflict (id) do update set
           configured_path = excluded.configured_path,
           canonical_path = excluded.canonical_path,
           state = excluded.state,
           reason_code = excluded.reason_code,
           checked_at = excluded.checked_at,
           config_generation = excluded.config_generation,
           active = true,
           updated_at = now()`,
        [
          root.id,
          root.configuredPath,
          root.canonicalPath,
          root.state,
          root.reasonCode,
          root.checkedAt,
          configGeneration,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function startScanRun(rootId: string, configGeneration: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const root = await client.query('select id from library_roots where id=$1 for update', [
      rootId,
    ]);
    if (root.rowCount !== 1) throw new Error('library root does not exist');
    const result = await client.query<{ id: number }>(
      `insert into scan_runs (root_id, config_generation, state) values ($1, $2, 'running') returning id`,
      [rootId, configGeneration],
    );
    await client.query('commit');
    return result.rows[0].id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function assertCurrentRun(
  client: import('pg').PoolClient,
  runId: number,
  rootId: string,
): Promise<void> {
  const root = await client.query('select id from library_roots where id=$1 for update', [rootId]);
  if (root.rowCount !== 1) throw new StaleScanRunError();
  const run = await client.query<{ id: number }>(
    "select id from scan_runs where id=$1 and root_id=$2 and state='running'",
    [runId, rootId],
  );
  const newest = await client.query<{ id: number }>(
    'select max(id) as id from scan_runs where root_id=$1',
    [rootId],
  );
  if (run.rowCount !== 1 || run.rows[0].id !== newest.rows[0].id) throw new StaleScanRunError();
}

/** Database work is deliberately short; callers perform all filesystem and ZIP I/O first. */
export async function persistScanItems(
  runId: number,
  rootId: string,
  items: readonly ScanItem[],
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 100) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await assertCurrentRun(client, runId, rootId);
      for (const item of items.slice(offset, offset + 100)) {
        const upsert = await client.query<{ id: number }>(
          `insert into source_items (root_id, relative_path, kind, size_bytes, mtime_ms, page_count, quarantine_reason, last_seen_run_id, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true)
         on conflict (root_id, relative_path) do update set kind=excluded.kind, size_bytes=excluded.size_bytes,
           mtime_ms=excluded.mtime_ms, page_count=excluded.page_count, quarantine_reason=excluded.quarantine_reason,
           last_seen_run_id=excluded.last_seen_run_id, active=true, updated_at=now() returning id`,
          [
            rootId,
            item.relativePath,
            item.kind,
            item.size,
            item.mtimeMs,
            item.pages.length,
            item.quarantinedReason,
            runId,
          ],
        );
        const itemId = upsert.rows[0].id;
        await client.query('delete from source_pages where source_item_id = $1', [itemId]);
        for (const [ordinal, locator] of item.pages.entries())
          await client.query(
            'insert into source_pages (source_item_id, ordinal, locator) values ($1,$2,$3)',
            [itemId, ordinal, locator],
          );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function completeScanRun(
  runId: number,
  rootId: string,
  summary: ScanSummary,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCurrentRun(client, runId, rootId);
    const finished = await client.query(
      `update scan_runs set state='completed', summary=$2, completed_at=now()
       where id=$1 and root_id=$3 and state='running'`,
      [runId, JSON.stringify(summary), rootId],
    );
    if (finished.rowCount !== 1) throw new StaleScanRunError();
    await client.query(
      'update source_items set active=false, updated_at=now() where root_id=$1 and active and last_seen_run_id is distinct from $2',
      [rootId, runId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function failScanRun(runId: number, summary: ScanSummary): Promise<void> {
  await pool.query(
    `update scan_runs set state='failed', summary=$2, completed_at=now() where id=$1 and state='running'`,
    [runId, JSON.stringify(summary)],
  );
}

export async function cancelScanRun(runId: number, summary: ScanSummary): Promise<void> {
  await pool.query(
    `update scan_runs set state='cancelled', summary=$2, completed_at=now() where id=$1 and state='running'`,
    [runId, JSON.stringify(summary)],
  );
}
