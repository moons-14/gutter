import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  catalogPublicationDetail,
  catalogSeriesListQuery,
  clearGlobalSourceSuppression,
  listCatalogLibraries,
  listCatalogSeries,
  migrateSchema,
  pool,
  rebuildCatalogProjectionForIntegration,
  setGlobalSourceSuppression,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_INTEGRATION_TEST !== '1')
  throw new Error('catalog integration requires GUTTER_INTEGRATION_TEST=1');
const rootId = `catalog-perf-${randomUUID()}`;
const indexFor = {
  name: 'catalog_series_list_state_(library_)?name_idx',
  source_updated: 'catalog_series_list_state_(library_)?source_updated_idx',
  discovered: 'catalog_series_list_state_(library_)?discovered_idx',
  metadata_updated: 'catalog_series_list_state_(library_)?metadata_updated_idx',
} as const;

async function explain(options: Parameters<typeof catalogSeriesListQuery>[0]) {
  const query = catalogSeriesListQuery(options);
  const result = await pool.query(`explain (analyze,format json) ${query.text}`, query.values);
  return JSON.stringify(result.rows[0]);
}

try {
  await migrateSchema();
  // The migration is intentionally edited before release; make an already-migrated local test
  // database exercise its final index definitions too.
  await pool.query(`drop index if exists catalog_series_list_state_name_idx,
    catalog_series_list_state_library_name_idx,catalog_series_list_state_source_updated_idx,
    catalog_series_list_state_library_source_updated_idx,catalog_series_list_state_discovered_idx,
    catalog_series_list_state_library_discovered_idx,catalog_series_list_state_metadata_updated_idx,
    catalog_series_list_state_library_metadata_updated_idx`);
  await pool.query(`create index catalog_series_list_state_name_idx on catalog_series_list_state(sort_key collate "C",series_id) where visible_publication_count>0;
    create index catalog_series_list_state_library_name_idx on catalog_series_list_state(library_id,sort_key collate "C",series_id) where visible_publication_count>0;
    create index catalog_series_list_state_source_updated_idx on catalog_series_list_state(source_updated_mtime_ms,series_id) where visible_publication_count>0;
    create index catalog_series_list_state_library_source_updated_idx on catalog_series_list_state(library_id,source_updated_mtime_ms,series_id) where visible_publication_count>0;
    create index catalog_series_list_state_discovered_idx on catalog_series_list_state(discovered_at,series_id) where visible_publication_count>0;
    create index catalog_series_list_state_library_discovered_idx on catalog_series_list_state(library_id,discovered_at,series_id) where visible_publication_count>0;
    create index catalog_series_list_state_metadata_updated_idx on catalog_series_list_state(metadata_updated_at,series_id) where visible_publication_count>0;
    create index catalog_series_list_state_library_metadata_updated_idx on catalog_series_list_state(library_id,metadata_updated_at,series_id) where visible_publication_count>0`);
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
    values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/catalog/${rootId}`, 'a'.repeat(64)],
  );
  await pool.query('insert into catalog_libraries(id,display_name) values($1,$1)', [rootId]);
  await pool.query(
    `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key)
    select $1,lpad(to_hex(g),64,'0'),jsonb_build_array(1,g),'series-' || g,'series-' || g,'series-' || g
    from generate_series(1,100000) g`,
    [rootId],
  );
  await pool.query(
    `insert into catalog_series_list_state(series_id,library_id,display_name,sort_key,search_document,visible_publication_count,source_updated_mtime_ms,discovered_at,metadata_updated_at)
    select id,library_id,display_name,sort_key,search_key,1,id,created_at + (id || ' microseconds')::interval,created_at + (id || ' microseconds')::interval from catalog_series where library_id=$1`,
    [rootId],
  );
  await pool.query(
    `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key) values
    ($1,repeat('b',64),jsonb_build_array(1,'漫画一'),'漫画一','漫画一','漫画一'),($1,repeat('c',64),jsonb_build_array(1,'漫画二'),'漫画二','漫画二','漫画二'),($1,repeat('d',64),jsonb_build_array(1,'異世界漫画'),'異世界漫画','異世界漫画','異世界漫画')`,
    [rootId],
  );
  await pool.query(
    `insert into catalog_series_list_state(series_id,library_id,display_name,sort_key,search_document,visible_publication_count,source_updated_mtime_ms,discovered_at,metadata_updated_at)
    select id,library_id,display_name,sort_key,search_key,1,id,created_at,created_at from catalog_series where library_id=$1 and (display_name like '漫画%' or display_name='異世界漫画')`,
    [rootId],
  );
  await pool.query('analyze catalog_series_list_state');

  for (const sort of ['name', 'source_updated', 'discovered', 'metadata_updated'] as const)
    for (const direction of ['asc', 'desc'] as const) {
      const plan = await explain({ libraryId: rootId, sort, direction, limit: 100 });
      assert.match(plan, new RegExp(indexFor[sort]));
      assert.doesNotMatch(plan, /"Offset"/);
      const firstPage = await listCatalogSeries({ libraryId: rootId, sort, direction, limit: 2 });
      assert.ok(firstPage.nextCursor);
      const cursorPlan = await explain({
        libraryId: rootId,
        sort,
        direction,
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      assert.match(cursorPlan, new RegExp(indexFor[sort]));
      assert.doesNotMatch(cursorPlan, /"Offset"/);
      const expected = await pool.query<{ id: string }>(
        `select series_id as id from catalog_series_list_state
          where library_id=$1 and visible_publication_count>0 and search_document like '%漫画%'
          order by ${sort === 'name' ? 'sort_key collate "C"' : sort === 'source_updated' ? 'source_updated_mtime_ms' : sort === 'discovered' ? 'discovered_at' : 'metadata_updated_at'} ${direction},series_id ${direction}`,
        [rootId],
      );
      const actual: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await listCatalogSeries({
          libraryId: rootId,
          q: '漫画',
          sort,
          direction,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        actual.push(...page.items.map((item) => String(item.id)));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(
        actual,
        expected.rows.map((row) => row.id),
      );
      assert.equal(new Set(actual).size, actual.length);
    }
  for (const q of ['漫', '漫画', '異世界'] as const) {
    const page = await listCatalogSeries({ libraryId: rootId, q, limit: 100 });
    assert.ok(page.items.some((item) => String(item.displayName).includes(q)));
  }
  const trigramPlan = await explain({ q: '異世界', limit: 100 });
  assert.match(trigramPlan, /catalog_series_list_state_search_trgm_idx/);
  assert.doesNotMatch(trigramPlan, /"Offset"/);
  const concurrent = await Promise.all(
    Array.from({ length: 5 }, () =>
      listCatalogSeries({ libraryId: rootId, sort: 'name', limit: 10 }),
    ),
  );
  assert.ok(concurrent.every((page) => page.items.length === 10));

  // Exercise durable preference semantics through the public catalog/suppression boundaries.
  // The hierarchy itself is disposable, so a projection rebuild must not rewrite this override.
  const behaviorRoot = `catalog-behavior-${randomUUID()}`;
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
    values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [behaviorRoot, `/catalog/${behaviorRoot}`, 'b'.repeat(64)],
  );
  const sources = await pool.query<{ id: string }>(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
    values($1,'first.cbz','cbz',1,10,1,true,repeat('1',64)),($1,'second.cbz','cbz',1,20,1,true,repeat('2',64)) returning id`,
    [behaviorRoot],
  );
  for (const id of sources.rows.map((row) => row.id))
    await pool.query(
      `insert into source_metadata(source_item_id,effective,provenance,rule_set,comicinfo_sha256)
     values($1,$2,'{}','test',null)`,
      [
        id,
        JSON.stringify({
          title: 'Volume 1',
          series: 'Behavior series',
          number: '1',
          writers: ['Writer'],
          seriesGroup: 'Circle',
          publisher: 'Press',
        }),
      ],
    );
  await rebuildCatalogProjectionForIntegration();
  const firstPublication = await pool.query<{ id: string; identity_key: string }>(
    `select p.id,p.identity_key from catalog_publications p join catalog_releases r on r.publication_id=p.id
      where r.source_item_id=$1`,
    [sources.rows[0]!.id],
  );
  assert.ok(firstPublication.rows[0]);
  await pool.query(
    `insert into catalog_preferred_release_overrides(root_id,publication_identity_key,preferred_source_item_id)
    values($1,$2,$3)`,
    [behaviorRoot, firstPublication.rows[0]!.identity_key, sources.rows[0]!.id],
  );
  const selected = async () =>
    (await catalogPublicationDetail(firstPublication.rows[0]!.id)) as {
      selectedReleaseId: string;
      releases: { sourceItemId: string; isPreferred: boolean }[];
    } | null;
  assert.equal((await selected())?.releases[0]?.sourceItemId, sources.rows[0]!.id);
  await setGlobalSourceSuppression(sources.rows[0]!.id, 'integration');
  assert.equal((await selected())?.releases[0]?.sourceItemId, sources.rows[1]!.id);
  await clearGlobalSourceSuppression(sources.rows[0]!.id);
  assert.equal((await selected())?.releases[0]?.sourceItemId, sources.rows[0]!.id);
  await pool.query('update library_roots set active=false where id=$1', [behaviorRoot]);
  assert.equal(await selected(), null);
  await pool.query('update library_roots set active=true where id=$1', [behaviorRoot]);
  assert.equal((await selected())?.releases[0]?.sourceItemId, sources.rows[0]!.id);
  await pool.query(`update source_metadata set effective=$2 where source_item_id=$1`, [
    sources.rows[0]!.id,
    JSON.stringify({ title: 'Volume 2', series: 'Behavior series', number: '2' }),
  ]);
  await rebuildCatalogProjectionForIntegration();
  const movedPublication = await pool.query<{ id: string }>(
    `select p.id from catalog_publications p join catalog_releases r on r.publication_id=p.id where r.source_item_id=$1`,
    [sources.rows[1]!.id],
  );
  const moved = (await catalogPublicationDetail(movedPublication.rows[0]!.id)) as {
    releases: { sourceItemId: string }[];
  } | null;
  assert.equal(moved?.releases[0]?.sourceItemId, sources.rows[1]!.id);
  await pool.query(`update source_metadata set effective=$2 where source_item_id=$1`, [
    sources.rows[0]!.id,
    JSON.stringify({
      title: 'Volume 1',
      series: 'Behavior series',
      number: '1',
      writers: ['Writer'],
      seriesGroup: 'Circle',
      publisher: 'Press',
    }),
  ]);
  await rebuildCatalogProjectionForIntegration();
  const restoredPublication = await pool.query<{ id: string }>(
    `select p.id from catalog_publications p join catalog_releases r on r.publication_id=p.id where r.source_item_id=$1`,
    [sources.rows[0]!.id],
  );
  const restored = (await catalogPublicationDetail(restoredPublication.rows[0]!.id)) as {
    releases: { sourceItemId: string }[];
  } | null;
  assert.equal(restored?.releases[0]?.sourceItemId, sources.rows[0]!.id);
  await pool.query('delete from catalog_preferred_release_overrides where root_id=$1', [
    behaviorRoot,
  ]);
  await pool.query('delete from catalog_series_list_state where library_id=$1', [behaviorRoot]);
  await pool.query(
    'delete from catalog_credits where release_id in (select id from catalog_releases where root_id=$1)',
    [behaviorRoot],
  );
  await pool.query('delete from catalog_releases where root_id=$1', [behaviorRoot]);
  await pool.query(
    'delete from catalog_publications where series_id in (select id from catalog_series where library_id=$1)',
    [behaviorRoot],
  );
  await pool.query('delete from catalog_series where library_id=$1', [behaviorRoot]);
  await pool.query('delete from catalog_libraries where id=$1', [behaviorRoot]);
  await pool.query('delete from source_items where root_id=$1', [behaviorRoot]);
  await pool.query('delete from library_roots where id=$1', [behaviorRoot]);

  // PostgreSQL bigint values are intentionally exposed as decimal strings.  Force every new
  // catalog sequence above Number.MAX_SAFE_INTEGER and prove rebuild/detail paths never round.
  const bigintRoot = `catalog-bigint-${randomUUID()}`;
  await pool.query(`select setval('source_items_id_seq',9007199254741999,false),
    setval('catalog_series_id_seq',9007199254742999,false),
    setval('catalog_publications_id_seq',9007199254743999,false),
    setval('catalog_releases_id_seq',9007199254744999,false),
    setval('catalog_entities_id_seq',9007199254745999,false)`);
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [bigintRoot, `/catalog/${bigintRoot}`, 'f'.repeat(64)],
  );
  const hugeSource = await pool.query<{ id: string }>(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     values($1,'huge.cbz','cbz',1,1,1,true,repeat('f',64)) returning id`,
    [bigintRoot],
  );
  assert.equal(hugeSource.rows[0]?.id, '9007199254741999');
  await pool.query(
    `insert into source_metadata(source_item_id,effective,provenance,rule_set,comicinfo_sha256)
     values($1,$2,'{}','test',null)`,
    [
      hugeSource.rows[0]!.id,
      JSON.stringify({ title: 'Huge', series: 'Huge series', writers: ['Huge writer'] }),
    ],
  );
  await rebuildCatalogProjectionForIntegration();
  const hugeRelease = await pool.query<{
    series_id: string;
    publication_id: string;
    release_id: string;
    source_item_id: string;
  }>(
    `select s.id as series_id,p.id as publication_id,r.id as release_id,r.source_item_id
       from catalog_releases r join catalog_publications p on p.id=r.publication_id
       join catalog_series s on s.id=p.series_id where r.source_item_id=$1`,
    [hugeSource.rows[0]!.id],
  );
  assert.deepEqual(hugeRelease.rows[0], {
    series_id: '9007199254742999',
    publication_id: '9007199254743999',
    release_id: '9007199254744999',
    source_item_id: '9007199254741999',
  });
  const hugeDetail = await catalogPublicationDetail(hugeRelease.rows[0]!.publication_id);
  assert.equal(hugeDetail?.releases[0]?.sourceItemId, '9007199254741999');
  await setGlobalSourceSuppression(hugeSource.rows[0]!.id, 'bigint');
  assert.equal(await catalogPublicationDetail(hugeRelease.rows[0]!.publication_id), null);
  await clearGlobalSourceSuppression(hugeSource.rows[0]!.id);
  assert.equal(
    (await catalogPublicationDetail(hugeRelease.rows[0]!.publication_id))?.releases[0]
      ?.sourceItemId,
    '9007199254741999',
  );
  await pool.query('delete from catalog_series_list_state where library_id=$1', [bigintRoot]);
  await pool.query(
    'delete from catalog_credits where release_id in (select id from catalog_releases where root_id=$1)',
    [bigintRoot],
  );
  await pool.query('delete from catalog_releases where root_id=$1', [bigintRoot]);
  await pool.query(
    'delete from catalog_publications where series_id in (select id from catalog_series where library_id=$1)',
    [bigintRoot],
  );
  await pool.query('delete from catalog_series where library_id=$1', [bigintRoot]);
  await pool.query('delete from catalog_libraries where id=$1', [bigintRoot]);
  await pool.query('delete from source_items where root_id=$1', [bigintRoot]);
  await pool.query('delete from library_roots where id=$1', [bigintRoot]);

  // The catalog library table is fully rebuildable: an empty configured root survives even
  // after every catalog projection table is discarded.
  const emptyRoot = `catalog-empty-${randomUUID()}`;
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
    values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [emptyRoot, `/catalog/${emptyRoot}`, 'e'.repeat(64)],
  );
  await pool.query('delete from catalog_series_list_state');
  await pool.query('delete from catalog_credits');
  await pool.query('delete from catalog_releases');
  await pool.query('delete from catalog_publications');
  await pool.query('delete from catalog_series');
  await pool.query('delete from catalog_entities');
  await pool.query('delete from catalog_libraries');
  await rebuildCatalogProjectionForIntegration();
  assert.ok((await listCatalogLibraries()).some((library) => library.id === emptyRoot));
  await pool.query('delete from catalog_libraries where id=$1', [emptyRoot]);
  await pool.query('delete from library_roots where id=$1', [emptyRoot]);
} finally {
  await pool.query('delete from catalog_series_list_state where library_id=$1', [rootId]);
  await pool.query('delete from catalog_series where library_id=$1', [rootId]);
  await pool.query('delete from catalog_libraries where id=$1', [rootId]);
  await pool.query('delete from library_roots where id=$1', [rootId]);
  await pool.end();
}
