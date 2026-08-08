import { databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname } from 'node:path';
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

function metadataFor(item: ScanItem): {
  effective: Record<string, unknown>;
  provenance: Record<string, 'inference' | 'comicinfo'>;
  ruleSet: string;
  sha256: string | null;
  annotations: readonly { locator: string; annotation: unknown }[];
  issues: readonly { code: string; rule: string; detail?: string }[];
} {
  const normalizeIssues = (source: readonly { code: string; rule: string; detail?: string }[]) => {
    const unique = new Map<string, { code: string; rule: string; detail?: string }>();
    for (const entry of source) {
      const detail = entry.detail?.trim().slice(0, 256);
      const normalized = {
        code: entry.code.slice(0, 128),
        rule: entry.rule.slice(0, 128),
        ...(detail ? { detail } : {}),
      };
      unique.set(
        `${normalized.code}\u0000${normalized.rule}\u0000${normalized.detail ?? ''}`,
        normalized,
      );
      if (unique.size >= 100) break;
    }
    return [...unique.values()];
  };
  const base =
    item.displayName ??
    basename(item.relativePath, item.kind === 'cbz' ? extname(item.relativePath) : undefined);
  const parent = basename(dirname(item.relativePath));
  const effective: Record<string, unknown> = {
    title: base,
    series: parent === '.' ? base : parent,
  };
  const provenance: Record<string, 'inference' | 'comicinfo'> = {
    title: 'inference',
    series: 'inference',
  };
  const issues = [...(item.scanIssues ?? [])];
  const document = item.comicInfo?.document;
  if (item.comicInfo) issues.push(...item.comicInfo.issues);
  if (!document)
    return {
      effective,
      provenance,
      ruleSet: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      sha256: null,
      annotations: [],
      issues: normalizeIssues(issues),
    };
  for (const [key, value] of Object.entries(document.fields)) {
    effective[key] = value;
    provenance[key] = 'comicinfo';
  }
  if (document.claimedPageCount !== null && document.claimedPageCount !== item.pages.length)
    issues.push({ code: 'page_count_mismatch', rule: 'comicinfo-anansi-v2.1-draft-compatible-v1' });
  const annotations: { locator: string; annotation: unknown }[] = [];
  const annotatedLocators = new Set<string>();
  for (const annotation of document.pageAnnotations) {
    const locator = item.pages[annotation.image];
    if (!locator)
      issues.push({
        code: 'page_image_out_of_range',
        rule: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      });
    else if (annotatedLocators.has(locator))
      issues.push({
        code: 'page_duplicate_image',
        rule: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      });
    else {
      annotatedLocators.add(locator);
      annotations.push({ locator, annotation });
    }
  }
  return {
    effective,
    provenance,
    ruleSet: 'comicinfo-anansi-v2.1-draft-compatible-v1',
    sha256: document.sha256,
    annotations,
    issues: normalizeIssues(issues),
  };
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
        const metadata = metadataFor(item);
        await client.query(
          `insert into source_metadata (source_item_id, effective, provenance, rule_set, comicinfo_sha256)
           values ($1,$2,$3,$4,$5)
           on conflict (source_item_id) do update set effective=excluded.effective, provenance=excluded.provenance,
             rule_set=excluded.rule_set, comicinfo_sha256=excluded.comicinfo_sha256, updated_at=now()`,
          [
            itemId,
            JSON.stringify(metadata.effective),
            JSON.stringify(metadata.provenance),
            metadata.ruleSet,
            metadata.sha256,
          ],
        );
        await client.query('delete from source_page_annotations where source_item_id=$1', [itemId]);
        for (const annotation of metadata.annotations)
          await client.query(
            'insert into source_page_annotations (source_item_id, locator, annotation) values ($1,$2,$3)',
            [itemId, annotation.locator, JSON.stringify(annotation.annotation)],
          );
        await client.query(
          'update source_metadata_issues set resolved_at=now(), retry_state=$2 where source_item_id=$1 and resolved_at is null',
          [itemId, 'resolved'],
        );
        for (const issue of metadata.issues)
          await client.query(
            `insert into source_metadata_issues (source_item_id, code, rule, detail, detected_at, last_seen_at, resolved_at, retry_state)
             values ($1,$2,$3,$4,now(),now(),null,'pending')
             on conflict (source_item_id, code, rule, detail) do update set last_seen_at=now(), resolved_at=null, retry_state='pending'`,
            [itemId, issue.code, issue.rule, issue.detail ?? ''],
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
