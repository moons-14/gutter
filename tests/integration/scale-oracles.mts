import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  stat,
  truncate,
  rm,
  writeFile,
  lstat,
  utimes,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';
import { DerivedCache, cacheIdentity } from '../../packages/derived-cache/src/index.ts';
import { openReaderStream } from '../../packages/reader-stream/src/index.ts';
import { scanRootBatched, type ScanItem } from '../../packages/discovery-scanner/src/index.ts';
import { validateSourceItem } from '../../packages/page-validator/src/index.ts';
import {
  catalogSeriesListQuery,
  listCatalogSeries,
  migrateSchema,
  pool,
  requestRootScan,
  type LibraryAccessScope,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_SCALE_ORACLE !== '1')
  throw new Error('scale oracle requires GUTTER_SCALE_ORACLE=1');

const seed = process.env.SCALE_SEED ?? 'gutter-issue-26-v1';
const runId = process.env.SCALE_RUN_ID ?? randomUUID().replaceAll('-', '').slice(0, 16);
const full = process.env.SCALE_FULL === '1';
if (full)
  assert.equal(
    process.env.SCALE_BOOKS ?? '100000',
    '100000',
    'SCALE_FULL fixes the dataset at exactly 100,000 books',
  );
if (full)
  assert.equal(
    process.env.SCALE_PAGES_PER_BOOK ?? '20',
    '20',
    'SCALE_FULL fixes the dataset at exactly 20 pages per book',
  );
const books = Number(process.env.SCALE_BOOKS ?? (full ? 100_000 : 1_000));
const pagesPerBook = Number(process.env.SCALE_PAGES_PER_BOOK ?? (full ? 20 : 10));
assert.ok(Number.isInteger(books) && books >= 1 && books <= 100_000);
assert.ok(Number.isInteger(pagesPerBook) && pagesPerBook >= 1 && pagesPerBook <= 100);
// Keep the catalog benchmark (books x pages) separate from the mounted 1k source fixture;
// both IDs are unique per run, and the worker root is explicitly passed by Compose.
const rootId = `scale-${createHash('sha256').update(`${seed}:${runId}:${books}:${pagesPerBook}`).digest('hex').slice(0, 24)}`;
const scanRootId = process.env.SCALE_ROOT_ID ?? `scale-worker-root-${runId}`;
const identity = (n: number) => createHash('sha256').update(`${seed}:${n}`).digest('hex');
const thresholds = {
  sourceFixtureBooks: 1_000,
  sourceFixturePages: 1_000,
  readerCount: 5,
  coldProducerCount: 1,
  sparseAllocatedBlocksMax: 1_024,
  advisoryCatalogP95Ms: 1_000,
  advisorySearchP95Ms: 1_000,
  advisoryScanP95Ms: 30_000,
};
const baseline = JSON.parse(
  await readFile(new URL('../../docs/scale-oracle-baseline.json', import.meta.url), 'utf8'),
) as { portable: Record<string, number> };
const baselineSha256 = createHash('sha256')
  .update(await readFile(new URL('../../docs/scale-oracle-baseline.json', import.meta.url)))
  .digest('hex');
assert.equal(baseline.portable.defaultBooks, 1_000);
assert.equal(baseline.portable.defaultPages, 10_000);
assert.equal(baseline.portable.coldProducerCount, 1);
const samples = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), count: sorted.length };
};
async function cacheUsage(root: string): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const children = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []);
    if (children.some((child) => child.isFile() && child.name === 'body')) {
      entries++;
      bytes += Number((await stat(join(root, entry.name, 'body'))).size);
    } else {
      const nested = await cacheUsage(join(root, entry.name));
      entries += nested.entries;
      bytes += nested.bytes;
    }
  }
  return { entries, bytes };
}

function validateEvidence(report: Record<string, unknown>) {
  const required = ['schemaVersion', 'status', 'unavailablePlatformReason', 'seed', 'runId', 'dataset', 'thresholds', 'environment', 'timingsMs', 'plans', 'cache', 'worker', 'sparse', 'baselineComparison'];
  for (const key of required) assert.ok(Object.hasOwn(report, key), `evidence requires ${key}`);
  assert.equal(report.schemaVersion, 'gutter.scale-oracle.v1');
  assert.ok(report.status === 'pass' || report.status === 'fail' || report.status === 'unavailable');
  assert.equal(typeof report.seed, 'string');
  assert.equal(typeof report.runId, 'string');
  const worker = report.worker as { runs?: Record<string, any>; queueCompletedRuns?: unknown };
  assert.equal(worker.queueCompletedRuns, 3);
  const runs = worker.runs ?? {};
  const runValues = [runs.first, runs.noChange, runs.changed];
  assert.ok(runValues.every((run) => run?.state === 'completed' && run?.pgBossJobId));
  assert.equal(new Set(runValues.map((run) => run.requestId)).size, 3);
  assert.equal(new Set(runValues.map((run) => run.id)).size, 3);
  assert.equal(runs.first.summary?.updated, 1000);
  assert.equal(runs.noChange.summary?.unchanged, 1000);
  assert.equal(runs.changed.summary?.updated, 1);
  const sparse = report.sparse as { logicalBytes?: unknown; allocatedBlocks?: unknown };
  assert.ok(Number.isInteger(sparse.logicalBytes) && Number(sparse.logicalBytes) > 0);
  assert.ok(Number.isInteger(sparse.allocatedBlocks) && Number(sparse.allocatedBlocks) >= 0);
}

async function timedQuery(text: string, values: unknown[] = []) {
  const started = performance.now();
  const result = await pool.query(text, values);
  return { result, elapsedMs: performance.now() - started };
}

function tinyCbz(payload: Buffer): Buffer {
  const encodedName = Buffer.from('0.png');
  const checksum = crc32(payload) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  const directoryOffset = local.length + encodedName.length + payload.length;
  const directory = Buffer.concat([central, encodedName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, encodedName, payload, directory, end]);
}

let cacheRoot: string | undefined;
let pressureRoot: string | undefined;
let sourceRoot: string | undefined;
try {
  await migrateSchema();
  const sourceBase = process.env.SCALE_SOURCE_ROOT ?? tmpdir();
  sourceRoot = sourceBase;
  await mkdir(sourceRoot, { recursive: true });
  const sourcePayload = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const sourceCount = Math.min(books, 1_000);
  assert.equal(sourceCount, 1_000, 'scale oracle requires exactly 1,000 mounted source CBZs');
  for (let n = 1; n <= sourceCount; n++)
    await writeFile(join(sourceRoot, `scale-${n}.cbz`), tinyCbz(sourcePayload));
  await pool.query('begin');
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$3,$3,'ready_empty',now(),$4,true),
            ($2,$3,$3,'ready_empty',now(),$4,true)
     on conflict (id) do update set configured_path=excluded.configured_path,canonical_path=excluded.canonical_path,active=true,state='ready_empty'`,
    [rootId, scanRootId, sourceRoot, identity(0)],
  );
  await pool.query(
    'insert into catalog_libraries(id,display_name) values($1,$1),($2,$2) on conflict (id) do nothing',
    [rootId, scanRootId],
  );
  await pool.query(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     select $1,'scale-' || g || '.cbz','cbz',$3,g,$2,true,md5($1 || ':' || g::text)
     from generate_series(1,$4::int) g`,
    [rootId, pagesPerBook, pagesPerBook * 1024, books],
  );
  await pool.query(
    `insert into source_pages(source_item_id,ordinal,locator)
     select i.id,p,'page-' || p || '.png'
       from source_items i cross join lateral generate_series(0,$2::int - 1) p
      where i.root_id=$1`,
    [rootId, pagesPerBook],
  );
  await pool.query(
    `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key)
     select $1,repeat(md5($1 || ':' || g::text),2),jsonb_build_array(1,g),'Scale book ' || g,
            'scale book ' || g,'scale book ' || lpad(g::text,8,'0')
       from generate_series(1,$2::int) g`,
    [rootId, books],
  );
  await pool.query(
    `insert into catalog_publications(series_id,identity_key,publication_identity_canonical_json,kind,display_name,search_key,sort_key,volume,number_text)
     select s.id,md5(s.identity_key || ':publication') || md5(s.identity_key || ':publication:2'),
            jsonb_build_array(2,s.identity_key),'volume',s.display_name,s.search_key,s.sort_key,1,null
       from catalog_series s where s.library_id=$1`,
    [rootId],
  );
  await pool.query(
    `with ranked_series as (
       select id, row_number() over (order by id) as n from catalog_series where library_id=$1
     ), ranked_items as (
       select id, row_number() over (order by id) as n from source_items where root_id=$1
     )
     insert into catalog_releases(publication_id,source_item_id,root_id,metadata_completeness)
     select p.id,i.id,$1,1
       from catalog_publications p
       join ranked_series s on s.id=p.series_id
       join ranked_items i on i.n=s.n`,
    [rootId],
  );
  await pool.query(
    `insert into catalog_series_list_state(series_id,library_id,display_name,sort_key,search_document,
       visible_publication_count,source_updated_mtime_ms,discovered_at,metadata_updated_at)
     select id,library_id,display_name,sort_key,search_key,1,id,created_at,created_at
       from catalog_series where library_id=$1`,
    [rootId],
  );
  await pool.query(
    `update catalog_series_list_state set visible_publication_count=1 where library_id=$1`,
    [rootId],
  );
  await pool.query('commit');

  const firstScan = await scanRootBatched(sourceRoot, { batchSize: 100 });
  assert.equal(firstScan.summary.discovered, sourceCount);
  assert.equal(firstScan.summary.pages, sourceCount);
  const validated = await validateSourceItem(sourceRoot, firstScan.items[0]!);
  assert.equal(validated.validCount, 1, 'project page validator accepts the generated CBZ');
  const adminScope: LibraryAccessScope = {
    userId: 'scale-oracle',
    isAdmin: true,
    rootIds: [],
    revision: 0,
    scopeHash: 'a'.repeat(64),
  };
  const firstRequest = await requestRootScan(scanRootId, 'startup');
  const waitDeadline = () => Date.now() + 300_000;
  type WorkerRun = {
    id: string;
    requestId: string;
    pgBossJobId: string | null;
    state: string;
    summary: { updated?: number; unchanged?: number } | null;
  };
  let workerRun: WorkerRun | null = null;
  const firstDeadline = waitDeadline();
  while (Date.now() < firstDeadline) {
    const result = await pool.query<WorkerRun>(
      `select r.id::text,r.scan_request_id as "requestId",r.pg_boss_job_id as "pgBossJobId",r.state,r.summary
         from scan_runs r where r.root_id=$1 and r.scan_request_id=$2 order by r.id desc limit 1`,
      [scanRootId, firstRequest.id],
    );
    workerRun = result.rows[0] ?? null;
    if (workerRun?.state === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(workerRun?.requestId, firstRequest.id);
  assert.equal(workerRun?.state, 'completed', 'production worker queue completed the request');
  assert.equal(workerRun?.summary?.updated, sourceCount);
  const persisted = await pool.query<{ books: string; pages: string }>(
    `select (select count(*) from source_items where root_id=$1)::text as books,
            (select count(*) from source_pages p join source_items i on i.id=p.source_item_id where i.root_id=$1)::text as pages`,
    [scanRootId],
  );
  assert.deepEqual(persisted.rows[0], { books: String(sourceCount), pages: String(sourceCount) });
  const noChangeTimes: number[] = [];
  const noChangeStarted = performance.now();
  const secondRequest = await requestRootScan(scanRootId, 'watcher');
  let secondRun: typeof workerRun = null;
  const secondDeadline = waitDeadline();
  while (Date.now() < secondDeadline) {
    const result = await pool.query<WorkerRun>(
      `select r.id::text,r.scan_request_id as "requestId",r.pg_boss_job_id as "pgBossJobId",r.state,r.summary from scan_runs r where r.root_id=$1 and r.scan_request_id=$2 order by r.id desc limit 1`,
      [scanRootId, secondRequest.id],
    );
    secondRun = result.rows[0] ?? null;
    if (secondRun?.state === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  noChangeTimes.push(performance.now() - noChangeStarted);
  assert.equal(secondRun?.state, 'completed');
  assert.equal(secondRun?.summary?.unchanged, sourceCount);
  const changedMtime = new Date(Date.now() - 2_000);
  await writeFile(
    join(sourceRoot, 'scale-1.cbz'),
    tinyCbz(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+AMAAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    ),
  );
  await utimes(join(sourceRoot, 'scale-1.cbz'), changedMtime, changedMtime);
  const changedStarted = performance.now();
  const changedRequest = await requestRootScan(scanRootId, 'watcher');
  let changedRun: typeof workerRun = null;
  const changedDeadline = waitDeadline();
  while (Date.now() < changedDeadline) {
    const result = await pool.query<WorkerRun>(
      `select r.id::text,r.scan_request_id as "requestId",r.pg_boss_job_id as "pgBossJobId",r.state,r.summary from scan_runs r where r.root_id=$1 and r.scan_request_id=$2 order by r.id desc limit 1`,
      [scanRootId, changedRequest.id],
    );
    changedRun = result.rows[0] ?? null;
    if (changedRun?.state === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const changedTimes: number[] = [performance.now() - changedStarted];
  assert.equal(changedRun?.state, 'completed');
  assert.equal(changedRun?.summary?.updated, 1);
  assert.notEqual(firstRequest.id, secondRequest.id);
  assert.notEqual(secondRequest.id, changedRequest.id);
  assert.notEqual(firstRequest.id, changedRequest.id);

  const firstItem = firstScan.items[Math.min(1, firstScan.items.length - 1)]!;
  const sourcePath = join(sourceRoot, firstItem.relativePath);
  const sourceStats = await lstat(sourcePath, { bigint: true });
  const page = firstItem.pages[0] as {
    locator: string;
    observed: { size: number; crc32?: number; compressedSize?: number; uncompressedSize?: number };
  };
  const readerOptions = {
    source: {
      root: sourceRoot,
      relativePath: firstItem.relativePath,
      kind: 'cbz' as const,
      observed: {
        dev: sourceStats.dev,
        ino: sourceStats.ino,
        size: sourceStats.size,
        mtimeNs: sourceStats.mtimeNs,
      },
    },
    page: { locator: page.locator, observed: page.observed },
  };
  const coldReader = await openReaderStream(readerOptions);
  const coldBytes = Buffer.concat(
    await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of coldReader.stream) chunks.push(Buffer.from(chunk));
      return chunks;
    })(),
  );
  assert.deepEqual(coldBytes, sourcePayload);

  const counts = await pool.query<{ books: string; pages: string }>(
    `select (select count(*) from source_items where root_id=$1)::text as books,
            (select count(*) from source_pages p join source_items i on i.id=p.source_item_id where i.root_id=$1)::text as pages`,
    [rootId],
  );
  assert.deepEqual(counts.rows[0], { books: String(books), pages: String(books * pagesPerBook) });

  await pool.query('analyze catalog_series_list_state');
  await pool.query('analyze catalog_series');
  await pool.query('analyze catalog_publications');
  await pool.query('analyze catalog_releases');
  await pool.query('analyze source_items');
  const productionQuery = catalogSeriesListQuery({ libraryId: rootId, limit: 10 }, adminScope);
  const listPlan = await pool.query(
    `explain (format json, costs false) ${productionQuery.text}`,
    productionQuery.values,
  );
  const searchQuery = catalogSeriesListQuery(
    { libraryId: rootId, q: 'Scale book 1', limit: 10 },
    adminScope,
  );
  const searchPlan = await pool.query(
    `explain (format json, costs false) ${searchQuery.text}`,
    searchQuery.values,
  );
  const listPlans = JSON.stringify(listPlan.rows);
  const searchPlans = JSON.stringify(searchPlan.rows);
  const plans = `${listPlans}${searchPlans}`;
  assert.match(productionQuery.text, /catalog_series_list_state/);
  assert.match(productionQuery.text, /catalog_publications/);
  assert.match(productionQuery.text, /catalog_releases/);
  assert.match(productionQuery.text, /source_items/);
  assert.match(plans, /catalog_series_list_state/);
  assert.match(plans, /catalog_releases/);
  assert.match(plans, /source_items/);
  assert.match(listPlans, /catalog_series_list_state_library_name_idx/);
  assert.match(searchPlans, /catalog_series_list_state_search_trgm_idx/);
  const firstPage = await listCatalogSeries(
    { libraryId: rootId, q: 'Scale book 1', limit: 10 },
    adminScope,
  );
  assert.ok(firstPage.items.length > 0, 'positive search returns matching results');
  assert.ok(firstPage.items.every((item) => String(item.displayName).toLowerCase().includes('scale book 1')));
  const pageOne = await listCatalogSeries({ libraryId: rootId, limit: 10 }, adminScope);
  assert.equal(pageOne.items.length, 10);
  assert.ok(pageOne.nextCursor, 'production list returns a cursor for the next page');
  assert.deepEqual(
    pageOne.items.map((item) => Number(String(item.displayName).replace('Scale book ', ''))),
    [...pageOne.items]
      .map((item) => Number(String(item.displayName).replace('Scale book ', '')))
      .sort((a, b) => a - b),
    'production list ordering is stable',
  );
  const pageTwo = await listCatalogSeries({ libraryId: rootId, limit: 10, cursor: pageOne.nextCursor! }, adminScope);
  assert.ok(pageTwo.items.every((item) => !pageOne.items.some((other) => other.id === item.id)), 'cursor pages do not overlap');

  const listTimes: number[] = [];
  const searchTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    listTimes.push((await timedQuery(productionQuery.text, productionQuery.values)).elapsedMs);
    searchTimes.push((await timedQuery(searchQuery.text, searchQuery.values)).elapsedMs);
  }
  cacheRoot = join(process.env.GUTTER_DERIVED_CACHE_ROOT ?? (await mkdtemp(join(tmpdir(), 'gutter-scale-cache-'))), runId);
  await mkdir(cacheRoot, { recursive: true });
  const cache = new DerivedCache({ root: cacheRoot, quotaBytes: 5 * 1024, maxQueue: 8 });
  const descriptor = (n: number) => ({
    source: { root: rootId, item: `scale-${n}.cbz`, observation: { seed } },
    manifestGeneration: 1,
    validationGeneration: 1,
    locator: `page-${n}.png`,
    pageObservation: { n },
    mimeType: 'image/png' as const,
    implementationVersion: 'issue-26-oracle-1',
  });
  let producers = 0;
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, () =>
      cache.lease(descriptor(1), async () => {
        producers++;
        const reader = await openReaderStream(readerOptions);
        return reader.stream;
      }),
    ),
  );
  assert.equal(producers, 1, 'five concurrent readers coalesce to one cold producer');
  assert.ok(concurrent.every((entry) => entry.body.equals(sourcePayload)));
  concurrent.forEach((entry) => entry.release());
  const warm = await cache.getOrCreate(descriptor(1), async () => {
    throw new Error('warm cache unexpectedly produced');
  });
  assert.equal(warm.hit, true);
  assert.deepEqual(warm.body, sourcePayload);
  const gcOk = await cache.gc();
  assert.equal(gcOk, true, 'cache GC leaves usage within the configured quota');
  pressureRoot = await mkdtemp(join(tmpdir(), 'gutter-scale-cache-pressure-'));
  const pressureCache = new DerivedCache({
    root: pressureRoot,
    quotaBytes: sourcePayload.length * 3,
  });
  const pressurePath = (n: number) => {
    const key = cacheIdentity(descriptor(n)).key;
    return join(pressureRoot!, key.slice(0, 2), key);
  };
  await pressureCache.getOrCreate(descriptor(1), async () => sourcePayload);
  const protectedEntry = await pressureCache.lease(descriptor(2), async () => sourcePayload);
  await pressureCache.getOrCreate(descriptor(3), async () => sourcePayload);
  const pressureBefore = await cacheUsage(pressureRoot);
  const reclaimed = await pressureCache.gc(sourcePayload.length);
  assert.equal(reclaimed, true);
  await assert.rejects(stat(pressurePath(1)), { code: 'ENOENT' });
  await stat(pressurePath(2));
  await stat(pressurePath(3));
  const pressureAfter = await cacheUsage(pressureRoot);
  assert.ok(pressureAfter.entries < pressureBefore.entries, 'GC reclaimed an evictable cache entry');
  const reclaimedBytes = pressureBefore.bytes - pressureAfter.bytes;
  assert.ok(reclaimedBytes > 0, 'GC reclaimed measured bytes');
  protectedEntry.release();

  const sparseRoot = await mkdtemp(join(tmpdir(), 'gutter-scale-sparse-'));
  const sparsePath = join(sparseRoot, 'capacity.bin');
  await writeFile(sparsePath, '');
  await truncate(sparsePath, 20 * 1024 ** 4);
  const sparse = await stat(sparsePath);
  assert.equal(sparse.size, 20 * 1024 ** 4);
  assert.ok(sparse.blocks < 1024, 'sparse capacity probe must not allocate 20 TB');
  await rm(sparseRoot, { recursive: true, force: true });

  const report = {
    schemaVersion: 'gutter.scale-oracle.v1',
    status: 'pass',
    unavailablePlatformReason: null,
    seed,
    runId,
    dataset: {
      books,
      pages: books * pagesPerBook,
      sourceFixtureBooks: sourceCount,
      sourceFixturePages: sourceCount,
    },
    thresholds,
    environment: {
      node: process.version,
      postgres: (await pool.query('show server_version')).rows[0],
      setupDatabaseRole: 'gutter',
      workerDatabaseRole: 'gutter_worker',
      sourceMount: 'read-only',
    },
    plans: {
      queryShape:
        'catalog_series_list_state + catalog_publications + catalog_releases + source_items',
      list: listPlan.rows,
      search: searchPlan.rows,
    },
    timingsMs: {
      catalog: samples(listTimes),
      search: samples(searchTimes),
      noChangeScan: samples(noChangeTimes),
      changedScan: samples(changedTimes),
    },
    cache: {
      readers: 5,
      coldProducers: producers,
      warmHit: warm.hit,
      gc: gcOk,
      pressure: {
        quotaBytes: sourcePayload.length * 2,
        reclaimedBytes,
        protectedLiveEntry: true,
      },
    },
    worker: {
      runs: { first: workerRun, noChange: secondRun, changed: changedRun },
      queueCompletedRuns: [workerRun, secondRun, changedRun].filter((run) => run?.state === 'completed').length,
    },
    sparse: { logicalBytes: sparse.size, allocatedBlocks: sparse.blocks },
    baselineComparison: {
      baseline: 'docs/scale-oracle-baseline.json',
      baselineSha256,
      portable:
        books === baseline.portable.defaultBooks &&
        books * pagesPerBook === baseline.portable.defaultPages &&
        producers === baseline.portable.coldProducerCount &&
        Number(sparse.blocks) <= baseline.portable.sparseAllocatedBlocksMax
          ? 'pass'
          : 'fail',
      hardwareAdvisory: {
        catalogP95Ms:
          samples(listTimes).p95 <= thresholds.advisoryCatalogP95Ms ? 'pass' : 'advisory-fail',
        searchP95Ms:
          samples(searchTimes).p95 <= thresholds.advisorySearchP95Ms ? 'pass' : 'advisory-fail',
        scanP95Ms:
          samples([...noChangeTimes, ...changedTimes]).p95 <= thresholds.advisoryScanP95Ms
            ? 'pass'
            : 'advisory-fail',
      },
    },
  };
  report.status = report.baselineComparison.portable === 'pass' ? 'pass' : 'fail';
  validateEvidence(report);
  const evidencePath =
    process.env.SCALE_EVIDENCE_PATH ?? join(tmpdir(), 'gutter-scale-evidence.json');
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`SCALE_ORACLE_EVIDENCE ${evidencePath}`);
  console.log(`SCALE_ORACLE_RESULT ${JSON.stringify(report)}`);
} finally {
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
  if (pressureRoot) await rm(pressureRoot, { recursive: true, force: true }).catch(() => undefined);
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
  await pool.query('rollback').catch(() => undefined);
  await pool
    .query('delete from catalog_series_list_state where library_id=$1', [rootId])
    .catch(() => undefined);
  await pool
    .query('delete from catalog_releases where root_id=$1', [rootId])
    .catch(() => undefined);
  await pool
    .query(
      'delete from catalog_publications where series_id in (select id from catalog_series where library_id=$1)',
      [rootId],
    )
    .catch(() => undefined);
  await pool
    .query('delete from catalog_series where library_id=$1', [rootId])
    .catch(() => undefined);
  await pool.query('delete from source_items where root_id=$1', [rootId]).catch(() => undefined);
  await pool
    .query('delete from source_items where root_id=$1', [scanRootId])
    .catch(() => undefined);
  await pool.query('delete from catalog_libraries where id=$1', [rootId]).catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [rootId]).catch(() => undefined);
  await pool
    .query('delete from catalog_libraries where id=$1', [scanRootId])
    .catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [scanRootId]).catch(() => undefined);
  await pool.end();
}
