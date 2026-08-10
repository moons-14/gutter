import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  catalogPublicationDetail,
  getReaderReleaseDescriptor,
  clearGlobalSourceSuppression,
  isReaderPathVisible,
  libraryAccessScope,
  listCatalogEntities,
  listCatalogSeries,
  migrateSchema,
  pool,
  putUserProgress,
  rebuildCatalogProjectionForIntegration,
  setGlobalSourceSuppression,
  setUserTargetState,
  getUserResume,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_INTEGRATION_TEST !== '1')
  throw new Error('catalog user-state integration requires GUTTER_INTEGRATION_TEST=1');

const suffix = randomUUID();
const rootId = `hide-${suffix}`;
const userId = `hide-user-${suffix}`;
const otherId = `hide-other-${suffix}`;
const sourceA = 'a.cbz';
const sourceB = 'b.cbz';
const sourceSibling = 'sibling.cbz';

const sourceIds: string[] = [];
try {
  await migrateSchema();
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/hide/${rootId}`, 'a'.repeat(64)],
  );
  await pool.query(
    `insert into "user"(id,name,email,"createdAt","updatedAt",role)
     values($1,$1,$2,now(),now(),'user'),($3,$3,$4,now(),now(),'user')`,
    [userId, `${userId}@example.invalid`, otherId, `${otherId}@example.invalid`],
  );
  await pool.query(
    `insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$3),($4,$2,$3)`,
    [userId, rootId, userId, otherId],
  );
  await pool.query('insert into catalog_libraries(id,display_name) values($1,$1)', [rootId]);

  const sources = await pool.query<{ id: string }>(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     values($1,$2,'cbz',100,101,2,true,$5),($1,$3,'cbz',200,202,2,true,$5),($1,$4,'cbz',300,303,2,true,$5)
     returning id`,
    [rootId, sourceA, sourceB, sourceSibling, 'a'.repeat(64)],
  );
  sourceIds.push(...sources.rows.map((row) => row.id));
  for (const [id, title, series, number] of [
    [sourceIds[0]!, 'A', 'A', '1'],
    [sourceIds[1]!, 'B', 'A', '2'],
    [sourceIds[2]!, 'Sibling', 'B', '1'],
  ] as const)
    await pool.query(
      `insert into source_metadata(source_item_id,effective,provenance,rule_set)
       values($1,$2,'{}','integration')`,
      [id, JSON.stringify({ title, series, number, writers: ['Shared Writer'] })],
    );
  await pool.query(
    `insert into source_pages(source_item_id,ordinal,locator) values($1,0,'0.png')`,
    [sourceIds[0]],
  );
  await pool.query('update source_items set validation_generation=1 where id=$1', [sourceIds[0]]);
  await pool.query(
    `insert into page_validation_runs(source_item_id,manifest_sha256,generation,state,candidate_count,valid_count,skipped_count)
       values($1,$2,1,'completed',1,1,0)`,
    [sourceIds[0], 'a'.repeat(64)],
  );
  await pool.query(
    `insert into page_validation_results(source_item_id,locator,manifest_sha256,generation,state,format,width,height,bytes_read)
       values($1,'0.png',$2,1,'valid','png',1,1,1)`,
    [sourceIds[0], 'a'.repeat(64)],
  );
  await rebuildCatalogProjectionForIntegration();
  const releases = await pool.query<{ id: string; source_item_id: string; publication_id: string }>(
    `select r.id,r.source_item_id,r.publication_id from catalog_releases r where r.source_item_id=any($1::bigint[]) order by r.source_item_id`,
    [sourceIds],
  );
  assert.equal(releases.rows.length, 3);

  const userScope = await libraryAccessScope(userId);
  const otherScope = await libraryAccessScope(otherId);
  const initial = await listCatalogSeries({ libraryId: rootId, limit: 10 }, userScope);
  assert.equal(initial.items.length, 2, 'both series are visible before hide');
  assert.ok(initial.items.every((item: any) => item.publicationCount >= 1));

  const pubAId = releases.rows[0]!.publication_id;
  const pubSuppressedId = releases.rows[1]!.publication_id;
  const pubSiblingId = releases.rows[2]!.publication_id;
  const identities = await pool.query<{ series_key: string; publication_key: string }>(
    `select s.identity_key as series_key,p.identity_key as publication_key
       from catalog_publications p join catalog_series s on s.id=p.series_id where p.id=$1`,
    [pubAId],
  );
  const seriesA = identities.rows[0]!.series_key;
  const pubA = identities.rows[0]!.publication_key;
  const detailBefore = (await catalogPublicationDetail(pubAId, userScope)) as any;
  assert.equal(detailBefore.releases.length, 1);
  assert.equal(detailBefore.credits.length, 1, 'credits are hydrated from visible releases');
  const entity = await listCatalogEntities('creator', userScope, { q: 'Shared Writer' });
  assert.equal(entity.length, 1);

  const cursorPage = await listCatalogSeries({ libraryId: rootId, limit: 1 }, userScope);
  assert.ok(cursorPage.nextCursor);
  await setUserTargetState(userId, rootId, 'source', sourceA, { hidden: true });
  const hiddenSource = (await catalogPublicationDetail(
    pubAId,
    await libraryAccessScope(userId),
  )) as any;
  assert.equal(hiddenSource, null, 'source hide removes an otherwise single-release publication');
  const readerPath = `/api/reader/releases/${releases.rows[0]!.id}`;
  assert.equal(await isReaderPathVisible(userId, readerPath), false);
  assert.equal(await isReaderPathVisible(otherId, readerPath), true);
  assert.equal(await getReaderReleaseDescriptor(releases.rows[0]!.id, userId), null);
  assert.ok(await getReaderReleaseDescriptor(releases.rows[0]!.id, otherId));
  assert.equal(
    (await listCatalogSeries({ libraryId: rootId, limit: 10 }, otherScope)).items.length,
    2,
  );
  await assert.rejects(
    listCatalogSeries(
      { libraryId: rootId, limit: 1, cursor: cursorPage.nextCursor! },
      await libraryAccessScope(userId),
    ),
    /invalid_catalog_cursor/,
    'user-state revision invalidates prior cursors',
  );

  await setUserTargetState(userId, rootId, 'source', sourceA, { hidden: false });
  const restored = await catalogPublicationDetail(pubAId, await libraryAccessScope(userId));
  assert.ok(restored, 'unhide restores the source-backed publication');
  assert.equal(await isReaderPathVisible(userId, readerPath), true);
  assert.ok(await getReaderReleaseDescriptor(releases.rows[0]!.id, userId));
  const pubKey = `${seriesA}:${pubA}`;
  await setUserTargetState(userId, rootId, 'publication', pubKey, { hidden: true });
  assert.equal(await catalogPublicationDetail(pubAId, await libraryAccessScope(userId)), null);
  assert.ok(
    await catalogPublicationDetail(pubSiblingId, await libraryAccessScope(userId)),
    'sibling publication remains visible',
  );
  await setUserTargetState(userId, rootId, 'publication', pubKey, { hidden: false });
  await setUserTargetState(userId, rootId, 'series', seriesA, { hidden: true });
  assert.equal(
    (await listCatalogSeries({ libraryId: rootId, limit: 10 }, await libraryAccessScope(userId)))
      .items.length,
    1,
  );
  assert.equal(await catalogPublicationDetail(pubAId, await libraryAccessScope(userId)), null);
  assert.equal(
    (await listCatalogEntities('creator', await libraryAccessScope(userId), { q: 'Shared Writer' }))
      .length,
    1,
    'sibling series keeps entity facet visible',
  );
  await setUserTargetState(userId, rootId, 'series', seriesA, { hidden: false });

  await setGlobalSourceSuppression(sourceIds[1]!, 'global-test');
  const suppressed = (await catalogPublicationDetail(
    pubSuppressedId,
    await libraryAccessScope(userId),
  )) as any;
  assert.equal(suppressed, null, 'global suppression is independent of user hide');
  const suppressedPath = `/api/reader/releases/${releases.rows[1]!.id}`;
  assert.equal(await isReaderPathVisible(userId, suppressedPath), false);
  assert.equal(await isReaderPathVisible(otherId, suppressedPath), false);
  await clearGlobalSourceSuppression(sourceIds[1]!);
  assert.ok(await catalogPublicationDetail(pubSuppressedId, await libraryAccessScope(userId)));

  const before = await pool.query<{ size_bytes: string; mtime_ms: number }>(
    'select size_bytes::text,mtime_ms from source_items where id=any($1::bigint[]) order by id',
    [sourceIds],
  );
  await putUserProgress(userId, rootId, sourceA, 0, { pageOrdinal: 1, completed: false });
  assert.equal((await getUserResume(userId)).length, 1);
  await pool.query('delete from library_access_grants where user_id=$1 and root_id=$2', [
    userId,
    rootId,
  ]);
  assert.deepEqual(await getUserResume(userId), [], 'revoked active root cannot resume');
  await pool.query(
    'insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$1)',
    [userId, rootId],
  );
  assert.equal((await getUserResume(userId)).length, 1, 'regrant restores resume on active root');
  await pool.query('update "user" set banned=true where id=$1', [userId]);
  await pool.query('update library_roots set active=false where id=$1', [rootId]);
  assert.deepEqual(await getUserResume(userId), [], 'banned/revoked root cannot resume');
  const exported = await pool.query(
    'select count(*)::int as count from user_progress where user_id=$1',
    [userId],
  );
  assert.equal(exported.rows[0]?.count, 1, 'durable state survives inactive root');
  await rebuildCatalogProjectionForIntegration();
  const after = await pool.query<{ size_bytes: string; mtime_ms: number }>(
    'select size_bytes::text,mtime_ms from source_items where id=any($1::bigint[]) order by id',
    [sourceIds],
  );
  assert.deepEqual(
    after.rows,
    before.rows,
    'projection rebuild never mutates source bytes or mtime',
  );
} finally {
  await pool
    .query('delete from user_progress where user_id=any($1::text[])', [[userId, otherId]])
    .catch(() => undefined);
  await pool
    .query('delete from user_target_state where user_id=any($1::text[])', [[userId, otherId]])
    .catch(() => undefined);
  await pool
    .query('delete from library_access_grants where user_id=any($1::text[])', [[userId, otherId]])
    .catch(() => undefined);
  await pool
    .query('delete from catalog_series_list_state where library_id=$1', [rootId])
    .catch(() => undefined);
  await pool
    .query(
      'delete from catalog_credits where release_id in (select id from catalog_releases where root_id=$1)',
      [rootId],
    )
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
  await pool
    .query(
      'delete from catalog_entities where not exists (select 1 from catalog_credits c where c.entity_id=catalog_entities.id)',
    )
    .catch(() => undefined);
  await pool
    .query(
      'delete from source_metadata where source_item_id in (select id from source_items where root_id=$1)',
      [rootId],
    )
    .catch(() => undefined);
  await pool.query('delete from source_items where root_id=$1', [rootId]).catch(() => undefined);
  await pool.query('delete from catalog_libraries where id=$1', [rootId]).catch(() => undefined);
  await pool
    .query('delete from "user" where id=any($1::text[])', [[userId, otherId]])
    .catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [rootId]).catch(() => undefined);
  await pool.end();
}
