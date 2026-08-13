import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat, truncate, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DerivedCache } from '../../packages/derived-cache/src/index.ts';
import { migrateSchema, pool } from '../../packages/db/src/index.ts';

if (process.env.GUTTER_SCALE_ORACLE !== '1')
  throw new Error('scale oracle requires GUTTER_SCALE_ORACLE=1');

const seed = process.env.SCALE_SEED ?? 'gutter-issue-26-v1';
const full = process.env.SCALE_FULL === '1';
const books = Number(process.env.SCALE_BOOKS ?? (full ? 100_000 : 1_000));
const pagesPerBook = Number(process.env.SCALE_PAGES_PER_BOOK ?? (full ? 20 : 10));
assert.ok(Number.isInteger(books) && books >= 1 && books <= 100_000);
assert.ok(Number.isInteger(pagesPerBook) && pagesPerBook >= 1 && pagesPerBook <= 100);
const rootId = `scale-${createHash('sha256').update(`${seed}:${books}:${pagesPerBook}`).digest('hex').slice(0, 24)}`;
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

let cacheRoot: string | undefined;
try {
  await migrateSchema();
  await pool.query('begin');
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/scale/${rootId}`, identity(0)],
  );
  await pool.query('insert into catalog_libraries(id,display_name) values($1,$1)', [rootId]);
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

  const counts = await pool.query<{ books: string; pages: string }>(
    `select (select count(*) from source_items where root_id=$1)::text as books,
            (select count(*) from source_pages p join source_items i on i.id=p.source_item_id where i.root_id=$1)::text as pages`,
    [rootId],
  );
  assert.deepEqual(counts.rows[0], { books: String(books), pages: String(books * pagesPerBook) });

  await pool.query('set enable_seqscan=off');
  await pool.query('set enable_bitmapscan=off');
  const listPlan = await pool.query(
    `explain (format json, costs false) select series_id from catalog_series_list_state
      where library_id=$1 and visible_publication_count>0
      order by sort_key collate "C",series_id limit 100`,
    [rootId],
  );
  await pool.query('reset enable_bitmapscan');
  const searchPlan = await pool.query(
    `explain (format json, costs false) select series_id from catalog_series_list_state
      where library_id=$1 and search_document collate "C" like '%scale book 42%' limit 100`,
    [rootId],
  );
  await pool.query('reset enable_seqscan');
  const plans = `${JSON.stringify(listPlan.rows)}${JSON.stringify(searchPlan.rows)}`;
  assert.match(plans, /catalog_series_list_state_library_name_idx/);
  assert.match(plans, /catalog_series_list_state_search_trgm_idx/);

  const listTimes: number[] = [];
  const searchTimes: number[] = [];
  const noChangeTimes: number[] = [];
  const changedTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    listTimes.push(
      (
        await timedQuery(
          `select series_id from catalog_series_list_state where library_id=$1 and visible_publication_count>0 order by sort_key collate "C",series_id limit 100`,
          [rootId],
        )
      ).elapsedMs,
    );
    searchTimes.push(
      (
        await timedQuery(
          `select series_id from catalog_series_list_state where library_id=$1 and search_document collate "C" like '%scale book 42%' limit 100`,
          [rootId],
        )
      ).elapsedMs,
    );
    noChangeTimes.push(
      (
        await timedQuery(`select count(*) from source_items where root_id=$1 and mtime_ms <= $2`, [
          rootId,
          books + 1,
        ])
      ).elapsedMs,
    );
  }
  assert.equal(
    (
      await pool.query(`select count(*) from source_items where root_id=$1 and mtime_ms <= $2`, [
        rootId,
        books + 1,
      ])
    ).rows[0].count,
    String(books),
  );
  await pool.query(
    `update source_items set mtime_ms=$2 where root_id=$1 and relative_path='scale-1.cbz'`,
    [rootId, books + 2],
  );
  for (let i = 0; i < 5; i++)
    changedTimes.push(
      (
        await timedQuery(`select count(*) from source_items where root_id=$1 and mtime_ms > $2`, [
          rootId,
          books + 1,
        ])
      ).elapsedMs,
    );
  assert.equal(
    (
      await pool.query(`select count(*) from source_items where root_id=$1 and mtime_ms > $2`, [
        rootId,
        books + 1,
      ])
    ).rows[0].count,
    '1',
  );

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
        return Buffer.from('scale-reader-page');
      }),
    ),
  );
  assert.equal(producers, 1, 'five concurrent readers coalesce to one cold producer');
  assert.ok(concurrent.every((entry) => entry.body.toString() === 'scale-reader-page'));
  concurrent.forEach((entry) => entry.release());
  const warm = await cache.getOrCreate(descriptor(1), async () => {
    throw new Error('warm cache unexpectedly produced');
  });
  assert.equal(warm.hit, true);
  await cache.gc();

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
      list: 'catalog_series_list_state_library_name_idx',
      search: 'catalog_series_list_state_search_trgm_idx',
    },
    timingsMs: {
      catalog: samples(listTimes),
      search: samples(searchTimes),
      noChangeScan: samples(noChangeTimes),
      changedScan: samples(changedTimes),
    },
    cache: { readers: 5, coldProducers: producers, warmHit: warm.hit, gc: 'completed' },
    sparse: { logicalBytes: sparse.size, allocatedBlocks: sparse.blocks },
  };
  console.log(`SCALE_ORACLE_RESULT ${JSON.stringify(report)}`);
} finally {
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined);
  await pool.query('rollback').catch(() => undefined);
  await pool
    .query('delete from catalog_series_list_state where library_id=$1', [rootId])
    .catch(() => undefined);
  await pool
    .query('delete from catalog_series where library_id=$1', [rootId])
    .catch(() => undefined);
  await pool.query('delete from source_items where root_id=$1', [rootId]).catch(() => undefined);
  await pool.query('delete from catalog_libraries where id=$1', [rootId]).catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [rootId]).catch(() => undefined);
  await pool.end();
}
