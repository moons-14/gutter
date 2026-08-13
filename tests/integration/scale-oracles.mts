import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat, truncate, rm, writeFile, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';
import { DerivedCache } from '../../packages/derived-cache/src/index.ts';
import { openReaderStream } from '../../packages/reader-stream/src/index.ts';
import { scanRootBatched, type ScanItem } from '../../packages/discovery-scanner/src/index.ts';
import { validateSourceItem } from '../../packages/page-validator/src/index.ts';
import {
  catalogSeriesListQuery,
  migrateSchema,
  pool,
  persistScanItems,
  startScanRun,
  completeScanRun,
  type LibraryAccessScope,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_SCALE_ORACLE !== '1')
  throw new Error('scale oracle requires GUTTER_SCALE_ORACLE=1');

const seed = process.env.SCALE_SEED ?? 'gutter-issue-26-v1';
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
const rootId = `scale-${createHash('sha256').update(`${seed}:${books}:${pagesPerBook}`).digest('hex').slice(0, 24)}`;
const scanRootId = `${rootId.slice(0, 25)}-scan`;
const identity = (n: number) => createHash('sha256').update(`${seed}:${n}`).digest('hex');
const samples = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: percentile(0.5), p95: percentile(0.95), count: sorted.length };
};

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
let sourceRoot: string | undefined;
try {
  await migrateSchema();
  const sourceBase = process.env.SCALE_SOURCE_ROOT ?? tmpdir();
  sourceRoot = await mkdtemp(join(sourceBase, 'gutter-scale-source-'));
  const sourcePayload = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const sourceCount = Math.min(books, 1_000);
  for (let n = 1; n <= sourceCount; n++)
    await writeFile(join(sourceRoot, `scale-${n}.cbz`), tinyCbz(sourcePayload));
  await pool.query('begin');
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$3,$3,'ready_empty',now(),$4,true),
            ($2,$3,$3,'ready_empty',now(),$4,true)`,
    [rootId, scanRootId, sourceRoot, identity(0)],
  );
  await pool.query('insert into catalog_libraries(id,display_name) values($1,$1),($2,$2)', [
    rootId,
    scanRootId,
  ]);
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
    `insert into catalog_series_list_state(series_id,library_id,display_name,sort_key,search_document,
       visible_publication_count,source_updated_mtime_ms,discovered_at,metadata_updated_at)
     select id,library_id,display_name,sort_key,search_key,1,id,created_at,created_at
       from catalog_series where library_id=$1`,
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
  const scanAndPersist = async (items: readonly ScanItem[]) => {
    const runId = await startScanRun(scanRootId, identity(0));
    const outcome = await persistScanItems(runId, scanRootId, items);
    await completeScanRun(runId, scanRootId, { ...firstScan.summary, ...outcome });
    return outcome;
  };
  const firstOutcome = await scanAndPersist(firstScan.items);
  assert.equal(firstOutcome.updated, sourceCount);
  const noChangeTimes: number[] = [];
  const secondScan = await scanRootBatched(sourceRoot, { batchSize: 100 });
  const noChangeStarted = performance.now();
  const secondOutcome = await scanAndPersist(secondScan.items);
  noChangeTimes.push(performance.now() - noChangeStarted);
  assert.equal(secondOutcome.unchanged, sourceCount);
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
  const changedScan = await scanRootBatched(sourceRoot, { batchSize: 100 });
  const changedOutcome = await scanAndPersist(changedScan.items);
  const changedTimes: number[] = [performance.now() - changedStarted];
  assert.equal(
    changedOutcome.updated,
    1,
    JSON.stringify({ changedSummary: changedScan.summary, changedOutcome }),
  );

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

  await pool.query('set enable_seqscan=off');
  await pool.query('set enable_bitmapscan=off');
  const productionQuery = catalogSeriesListQuery(
    { libraryId: rootId, q: 'scale book 42', limit: 100 },
    adminScope,
  );
  const listPlan = await pool.query(
    `explain (format json, costs false) ${productionQuery.text}`,
    productionQuery.values,
  );
  await pool.query('reset enable_bitmapscan');
  const searchQuery = catalogSeriesListQuery(
    { libraryId: rootId, q: 'scale book 42', limit: 100 },
    adminScope,
  );
  const searchPlan = await pool.query(
    `explain (format json, costs false) ${searchQuery.text}`,
    searchQuery.values,
  );
  await pool.query('reset enable_seqscan');
  const plans = `${JSON.stringify(listPlan.rows)}${JSON.stringify(searchPlan.rows)}`;
  assert.match(productionQuery.text, /catalog_series_list_state/);
  assert.match(productionQuery.text, /catalog_publications/);
  assert.match(productionQuery.text, /catalog_releases/);
  assert.match(productionQuery.text, /source_items/);
  assert.match(plans, /catalog_series_list_state/);
  assert.match(plans, /catalog_releases/);
  assert.match(plans, /source_items/);

  const listTimes: number[] = [];
  const searchTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    listTimes.push((await timedQuery(productionQuery.text, productionQuery.values)).elapsedMs);
    searchTimes.push((await timedQuery(searchQuery.text, searchQuery.values)).elapsedMs);
  }
  cacheRoot = await mkdtemp(join(tmpdir(), 'gutter-scale-cache-'));
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

  const sparseRoot = await mkdtemp(join(tmpdir(), 'gutter-scale-sparse-'));
  const sparsePath = join(sparseRoot, 'capacity.bin');
  await writeFile(sparsePath, '');
  await truncate(sparsePath, 20 * 1024 ** 4);
  const sparse = await stat(sparsePath);
  assert.equal(sparse.size, 20 * 1024 ** 4);
  assert.ok(sparse.blocks < 1024, 'sparse capacity probe must not allocate 20 TB');
  await rm(sparseRoot, { recursive: true, force: true });

  const report = {
    seed,
    books,
    pages: books * pagesPerBook,
    environment: {
      node: process.version,
      postgres: (await pool.query('show server_version')).rows[0],
    },
    plans: {
      queryShape:
        'catalog_series_list_state + catalog_publications + catalog_releases + source_items',
      listAndSearchExplain: 'both plans include production joins and indexed predicates',
    },
    timingsMs: {
      catalog: samples(listTimes),
      search: samples(searchTimes),
      noChangeScan: samples(noChangeTimes),
      changedScan: samples(changedTimes),
    },
    cache: { readers: 5, coldProducers: producers, warmHit: warm.hit, gc: gcOk },
    sparse: { logicalBytes: sparse.size, allocatedBlocks: sparse.blocks },
  };
  console.log(`SCALE_ORACLE_RESULT ${JSON.stringify(report)}`);
} finally {
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
  await pool.query('rollback').catch(() => undefined);
  await pool
    .query('delete from catalog_series_list_state where library_id=$1', [rootId])
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
