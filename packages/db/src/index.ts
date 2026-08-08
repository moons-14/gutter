import { databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname } from 'node:path';
import { Pool } from 'pg';
import {
  manifestSha256,
  scanPage,
  type ScanItem,
  type ScanSummary,
} from '@gutter/discovery-scanner';

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
    const locator = item.pages[annotation.image] && scanPage(item.pages[annotation.image]!).locator;
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
): Promise<{ updated: number; unchanged: number }> {
  const outcome = { updated: 0, unchanged: 0 };
  for (let offset = 0; offset < items.length; offset += 100) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await assertCurrentRun(client, runId, rootId);
      for (const item of items.slice(offset, offset + 100)) {
        const pages = item.pages.map(scanPage);
        const itemManifest =
          item.manifestSha256 ?? manifestSha256(item.kind, item.size, item.mtimeMs, pages);
        const previous = await client.query<{ manifest_sha256: string | null; active: boolean }>(
          'select manifest_sha256, active from source_items where root_id=$1 and relative_path=$2 for update',
          [rootId, item.relativePath],
        );
        const upsert = await client.query<{ id: number }>(
          `insert into source_items (root_id, relative_path, kind, size_bytes, mtime_ms, page_count, quarantine_reason, last_seen_run_id, active, manifest_sha256)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
         on conflict (root_id, relative_path) do update set kind=excluded.kind, size_bytes=excluded.size_bytes,
           mtime_ms=excluded.mtime_ms, page_count=excluded.page_count, quarantine_reason=excluded.quarantine_reason,
           last_seen_run_id=excluded.last_seen_run_id, active=true, manifest_sha256=excluded.manifest_sha256, updated_at=now() returning id`,
          [
            rootId,
            item.relativePath,
            item.kind,
            item.size,
            item.mtimeMs,
            item.pages.length,
            item.quarantinedReason,
            runId,
            itemManifest,
          ],
        );
        const itemId = upsert.rows[0].id;
        await client.query('delete from source_pages where source_item_id = $1', [itemId]);
        for (const [ordinal, page] of pages.entries())
          await client.query(
            'insert into source_pages (source_item_id, ordinal, locator, observed) values ($1,$2,$3,$4)',
            [itemId, ordinal, page.locator, JSON.stringify(page.observed)],
          );
        // A reactivated item must be revalidated even when its discovery manifest is unchanged.
        const changed =
          previous.rows[0]?.manifest_sha256 !== itemManifest || previous.rows[0]?.active === false;
        if (changed) outcome.updated += 1;
        else outcome.unchanged += 1;
        if (changed) {
          const generation = await client.query<{ validation_generation: number }>(
            'update source_items set validation_generation=validation_generation+1 where id=$1 returning validation_generation',
            [itemId],
          );
          await client.query(
            `insert into validation_intents (source_item_id, desired_manifest_sha256, generation, state)
             values ($1,$2,$3,'pending')
             on conflict (source_item_id) do update set desired_manifest_sha256=excluded.desired_manifest_sha256,
               generation=excluded.generation, state='pending', lease_expires_at=null, next_attempt_at=now(),
               attempt_count=0, last_failure_code=null, failed_at=null, updated_at=now()`,
            [itemId, itemManifest, Number(generation.rows[0].validation_generation)],
          );
        }
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
  return outcome;
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
    // A completed full scan is authoritative: inactive items retain history but no desired work.
    // Removing a running intent fences its old owner just like a reclaimed lease epoch would.
    await client.query(
      `delete from validation_intents v using source_items i
       where v.source_item_id=i.id and i.root_id=$1 and not i.active`,
      [rootId],
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

export type ValidationIntent = Readonly<{
  sourceItemId: number;
  manifestSha256: string;
  generation: number;
  leaseEpoch: number;
}>;

export const validationFailureCodes = [
  'root_unavailable',
  'source_manifest_changed',
  'validation_timeout',
  'lease_lost',
  'validation_cancelled',
  'validation_infrastructure_failure',
] as const;
export type ValidationFailureCode = (typeof validationFailureCodes)[number];

export function validationFailureCode(value: string | undefined): ValidationFailureCode {
  return (validationFailureCodes as readonly string[]).includes(value ?? '')
    ? (value as ValidationFailureCode)
    : 'validation_infrastructure_failure';
}

/** Claims only durable desired state; queue sends happen after this short transaction. */
export async function claimValidationIntents(limit = 20): Promise<ValidationIntent[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await client.query<{
      source_item_id: number;
      desired_manifest_sha256: string;
      generation: number;
      lease_epoch: number;
    }>(
      `with candidates as (
         select source_item_id from validation_intents
         where (state='pending' and next_attempt_at <= now()) or (state in ('queued','running') and lease_expires_at < now())
         order by updated_at for update skip locked limit $1
       ) update validation_intents i set state='queued', lease_expires_at=now()+interval '10 minutes',
         lease_epoch=i.lease_epoch+1, attempt_count=i.attempt_count+1, updated_at=now() from candidates c
       where i.source_item_id=c.source_item_id
       returning i.source_item_id, i.desired_manifest_sha256, i.generation, i.lease_epoch`,
      [limit],
    );
    await client.query('commit');
    return claimed.rows.map((row) => ({
      sourceItemId: row.source_item_id,
      manifestSha256: row.desired_manifest_sha256,
      generation: Number(row.generation),
      leaseEpoch: Number(row.lease_epoch),
    }));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getValidationSource(intent: ValidationIntent): Promise<{
  rootId: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  size: number;
  mtimeMs: number;
  pages: import('@gutter/discovery-scanner').ScanPage[];
} | null> {
  const item = await pool.query<{
    root_id: string;
    relative_path: string;
    kind: 'directory' | 'cbz';
    size_bytes: string;
    mtime_ms: number;
  }>(
    `select i.root_id,i.relative_path,i.kind,i.size_bytes,i.mtime_ms from source_items i join validation_intents v on v.source_item_id=i.id
     where i.id=$1 and i.active and i.manifest_sha256=$2 and i.validation_generation=$3
       and v.generation=$3 and v.lease_epoch=$4 and v.desired_manifest_sha256=$2
       and v.state in ('queued','running') and v.lease_expires_at > now()`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
  );
  if (!item.rows[0]) return null;
  const pages = await pool.query<{
    locator: string;
    observed: import('@gutter/discovery-scanner').ScanPage['observed'];
  }>('select locator, observed from source_pages where source_item_id=$1 order by ordinal', [
    intent.sourceItemId,
  ]);
  return {
    rootId: item.rows[0].root_id,
    relativePath: item.rows[0].relative_path,
    kind: item.rows[0].kind,
    size: Number(item.rows[0].size_bytes),
    mtimeMs: item.rows[0].mtime_ms,
    pages: pages.rows,
  };
}

/** A worker owns an intent only while this exact generation and monotonically claimed lease epoch remain unexpired. */
export async function renewValidationLease(intent: ValidationIntent): Promise<boolean> {
  const result = await pool.query(
    `update validation_intents set state='running', lease_expires_at=now()+interval '10 minutes', updated_at=now()
     where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$4
       and state in ('queued','running') and lease_expires_at > now()`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
  );
  return result.rowCount === 1;
}

export async function releaseValidationIntent(
  intent: ValidationIntent,
  failureCode?: string,
): Promise<void> {
  const safeCode = validationFailureCode(failureCode);
  // Infrastructure failures never create page results. Only the final bounded attempt receives a
  // durable run row so operators can distinguish terminal validation failure from missing work.
  await pool.query(
    `with released as (
       update validation_intents set
         state=case when attempt_count >= 5 then 'failed' else 'pending' end,
         lease_expires_at=null, last_failure_code=$4,
         failed_at=case when attempt_count >= 5 then now() else null end,
         next_attempt_at=now() + (least(3600, 30 * power(2, least(attempt_count, 7))) * interval '1 second'),
         updated_at=now()
       where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$5
         and state in ('queued','running') and lease_expires_at > now()
       returning source_item_id, desired_manifest_sha256, generation, state, attempt_count
     ) insert into page_validation_runs
       (source_item_id, manifest_sha256, generation, state, candidate_count, valid_count, skipped_count, bytes_read, duration_ms, summary)
     select source_item_id, desired_manifest_sha256, generation, 'failed', 0, 0, 0, 0, 0,
       jsonb_build_object('failureCode', $4, 'attemptCount', attempt_count)
     from released where state='failed'`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, safeCode, intent.leaseEpoch],
  );
}

export type CompletedValidation = Readonly<{
  candidateCount: number;
  validCount: number;
  skippedCount: number;
  bytesRead: number;
  durationMs: number;
  results: readonly {
    locator: string;
    state: 'valid' | 'skipped';
    reasonCode?: string;
    format?: string;
    width?: number;
    height?: number;
    bytesRead: number;
  }[];
}>;

/**
 * The generation fence is checked while locking both the intent and source row. A stale worker
 * therefore cannot replace results that a newer scan made authoritative.
 */
export async function completeValidationIntent(
  intent: ValidationIntent,
  summary: CompletedValidation,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query<{ source_item_id: number }>(
      `select v.source_item_id from validation_intents v join source_items i on i.id=v.source_item_id
     where v.source_item_id=$1 and v.desired_manifest_sha256=$2 and v.generation=$3 and v.lease_epoch=$4
         and v.state='running' and v.lease_expires_at > now() and i.active and i.manifest_sha256=$2
         and i.validation_generation=$3 for update of v, i`,
      [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
    );
    if (current.rowCount !== 1) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      `insert into page_validation_runs (source_item_id,manifest_sha256,generation,state,candidate_count,valid_count,skipped_count,bytes_read,duration_ms,summary)
       values ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9)`,
      [
        intent.sourceItemId,
        intent.manifestSha256,
        intent.generation,
        summary.candidateCount,
        summary.validCount,
        summary.skippedCount,
        summary.bytesRead,
        summary.durationMs,
        JSON.stringify({
          candidateCount: summary.candidateCount,
          validCount: summary.validCount,
          skippedCount: summary.skippedCount,
        }),
      ],
    );
    await client.query(
      'delete from page_validation_results where source_item_id=$1 and manifest_sha256=$2 and generation=$3',
      [intent.sourceItemId, intent.manifestSha256, intent.generation],
    );
    for (const result of summary.results)
      await client.query(
        `insert into page_validation_results (source_item_id,locator,manifest_sha256,generation,state,reason_code,format,width,height,bytes_read)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          intent.sourceItemId,
          result.locator,
          intent.manifestSha256,
          intent.generation,
          result.state,
          result.reasonCode ?? null,
          result.format ?? null,
          result.width ?? null,
          result.height ?? null,
          result.bytesRead,
        ],
      );
    await client.query(
      "delete from validation_intents where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$4 and state='running' and lease_expires_at > now()",
      [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
    );
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
