import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  catalogPublicationDetail,
  addUserBookmark,
  createUserCollection,
  getReaderReleaseDescriptor,
  clearGlobalSourceSuppression,
  isReaderPathVisible,
  libraryAccessScope,
  listCatalogEntities,
  listCatalogSeries,
  listUserBookmarks,
  listUserCollectionMembers,
  listUserCollections,
  listUserTargetState,
  migrateSchema,
  pool,
  putUserProgress,
  readerProgressKey,
  resolveUserProgressKey,
  rebuildCatalogProjectionForIntegration,
  setGlobalSourceSuppression,
  setUserCollectionMembership,
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
const unicodeRoot = `unicode-${suffix}`;

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

  // Keep a Unicode-only source outside the catalog projection so the resolver
  // exercises the PostgreSQL byte hashing path directly (including UTF-8 path data).
  const unicodePath = '漫画/épisode-日本.cbz';
  const rootUnicodePath = '図書館/巻一.cbz';
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [unicodeRoot, `/unicode/${suffix}`, 'b'.repeat(64)],
  );
  await pool.query(
    `insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$1)`,
    [userId, unicodeRoot],
  );
  const unicodeSource = await pool.query<{ id: string }>(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     values($1,$2,'cbz',1,1,1,true,$3) returning id`,
    [unicodeRoot, unicodePath, 'c'.repeat(64)],
  );
  sourceIds.push(unicodeSource.rows[0]!.id);
  const rootUnicodeSource = await pool.query<{ id: string }>(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     values($1,$2,'cbz',1,1,1,true,$3) returning id`,
    [rootId, rootUnicodePath, 'd'.repeat(64)],
  );
  sourceIds.push(rootUnicodeSource.rows[0]!.id);
  await pool.query(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,quarantine_reason,manifest_sha256)
     values($1,'quarantined.cbz','cbz',1,1,1,true,'bad_archive',$2)`,
    [rootId, 'e'.repeat(64)],
  );

  const vectors = [
    [rootId, sourceA],
    [rootId, rootUnicodePath],
    [unicodeRoot, unicodePath],
  ] as const;
  for (const [vectorRoot, path] of vectors) {
    const key = readerProgressKey(vectorRoot, path);
    assert.equal(
      await resolveUserProgressKey(userId, vectorRoot, key),
      path,
      `SQL resolver matches readerProgressKey for ${vectorRoot}/${path}`,
    );
  }
  await pool.query(
    'update source_items set quarantine_reason=$2 where root_id=$1 and relative_path=$3',
    [unicodeRoot, 'bad_archive', unicodePath],
  );
  assert.equal(
    await resolveUserProgressKey(userId, unicodeRoot, readerProgressKey(unicodeRoot, unicodePath)),
    null,
    'quarantined source cannot resolve',
  );
  await pool.query('update source_items set quarantine_reason=null,active=false where root_id=$1', [
    unicodeRoot,
  ]);
  assert.equal(
    await resolveUserProgressKey(userId, unicodeRoot, readerProgressKey(unicodeRoot, unicodePath)),
    null,
    'inactive source cannot resolve',
  );
  await pool.query('update source_items set active=true where root_id=$1', [unicodeRoot]);
  await pool.query('update library_roots set active=false where id=$1', [unicodeRoot]);
  assert.equal(
    await resolveUserProgressKey(userId, unicodeRoot, readerProgressKey(unicodeRoot, unicodePath)),
    null,
    'inactive root cannot resolve',
  );
  await pool.query('update library_roots set active=true where id=$1', [unicodeRoot]);
  await setGlobalSourceSuppression(unicodeSource.rows[0]!.id, 'resolver-test');
  assert.equal(
    await resolveUserProgressKey(userId, unicodeRoot, readerProgressKey(unicodeRoot, unicodePath)),
    null,
    'globally suppressed source cannot resolve',
  );
  await clearGlobalSourceSuppression(unicodeSource.rows[0]!.id);
  await pool.query('delete from library_access_grants where user_id=$1 and root_id=$2', [
    userId,
    unicodeRoot,
  ]);
  assert.equal(
    await resolveUserProgressKey(userId, unicodeRoot, readerProgressKey(unicodeRoot, unicodePath)),
    null,
    'revoked source cannot resolve',
  );
  await pool.query(
    'insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$1)',
    [userId, unicodeRoot],
  );

  // Durable lists expose opaque reader keys only and filter every inaccessible row.
  for (const [n, path] of [
    [0, sourceA],
    [1, sourceB],
    [2, sourceSibling],
  ] as const)
    assert.equal(await addUserBookmark(userId, rootId, path, n, `bookmark-${n}`), true);
  await pool.query(
    `insert into user_bookmarks(user_id,root_id,source_key,page_ordinal,label)
     values($1,$2,'missing.cbz',0,'inaccessible')`,
    [userId, rootId],
  );
  await setUserTargetState(userId, rootId, 'source', sourceA, { favorite: true });
  await setUserTargetState(userId, rootId, 'source', sourceB, { favorite: true });
  await setUserTargetState(userId, rootId, 'source', sourceSibling, { favorite: true });
  await pool.query(
    `insert into user_target_state(user_id,root_id,target_kind,target_key,favorite)
     values($1,$2,'source','missing.cbz',true)`,
    [userId, rootId],
  );
  const collection = await createUserCollection(userId, 'Integration list');
  assert.ok(collection);
  for (const path of [sourceA, sourceB, sourceSibling, 'missing.cbz'])
    await setUserCollectionMembership(userId, collection!.id, rootId, 'source', path, true);
  await pool.query(
    `insert into user_bookmarks(user_id,root_id,source_key,page_ordinal,label)
     values($1,$2,'quarantined.cbz',0,'quarantined')`,
    [userId, rootId],
  );
  await pool.query(
    `insert into user_target_state(user_id,root_id,target_kind,target_key,favorite)
     values($1,$2,'source','quarantined.cbz',true)`,
    [userId, rootId],
  );
  await setUserCollectionMembership(
    userId,
    collection!.id,
    rootId,
    'source',
    'quarantined.cbz',
    true,
  );
  const checkOpaque = (item: Record<string, unknown>) => {
    assert.equal('sourceKey' in item, false);
    assert.equal('sourceItemId' in item, false);
    if ('progressKey' in item) assert.match(String(item.progressKey), /^source:[A-Za-z0-9_-]+$/);
    if (item.targetKind === 'source')
      assert.match(String(item.targetKey), /^source:[A-Za-z0-9_-]+$/);
  };
  const bookmarkPages: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await listUserBookmarks(userId, 1, cursor);
    page.items.forEach(checkOpaque);
    bookmarkPages.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(bookmarkPages.length, 3);
  assert.deepEqual(
    bookmarkPages.map((x) => x.pageOrdinal),
    [0, 1, 2],
  );
  assert.equal(
    (await listUserBookmarks(userId, 20)).items.some((x) => x.label === 'quarantined'),
    false,
  );
  assert.equal(
    (await listUserTargetState(userId, 20)).items.some((x) => x.targetKey === 'quarantined.cbz'),
    false,
  );
  assert.equal(
    (await listUserCollectionMembers(userId, collection!.id, 20))!.items.some(
      (x) => x.targetKey === 'quarantined.cbz',
    ),
    false,
  );
  const targetPages: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await listUserTargetState(userId, 1, cursor);
    page.items.forEach(checkOpaque);
    targetPages.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(targetPages.length, 3);
  const memberPages: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await listUserCollectionMembers(userId, collection!.id, 1, cursor);
    assert.ok(page);
    page.items.forEach(checkOpaque);
    memberPages.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(memberPages.length, 3);
  assert.deepEqual(
    memberPages.map((x) => x.targetKey),
    [sourceA, sourceB, sourceSibling].map((p) => readerProgressKey(rootId, p)),
  );

  const collections = await listUserCollections(userId, 1);
  assert.equal(collections.items.length, 1);
  assert.equal((collections.items[0] as any).name, 'Integration list');
  const collectionCursor = (
    await listUserCollections(userId, 1, collections.nextCursor ?? undefined)
  ).nextCursor;
  assert.equal(collectionCursor, null, 'collection keyset terminates deterministically');

  // Cursor bindings cover endpoint, user, collection, scope, revision, and tamper cases.
  const bookmarkCursor = (await listUserBookmarks(userId, 1)).nextCursor!;
  await assert.rejects(listUserTargetState(userId, 1, bookmarkCursor), /invalid_pagination_cursor/);
  const otherCollection = await createUserCollection(otherId, 'Other list');
  assert.ok(otherCollection);
  const secondUserCollection = await createUserCollection(userId, 'Second list');
  assert.ok(secondUserCollection);
  await assert.rejects(
    listUserCollectionMembers(userId, secondUserCollection!.id, 1, bookmarkCursor),
    /invalid_pagination_cursor/,
  );
  await assert.rejects(
    listUserCollectionMembers(otherId, collection!.id, 1, bookmarkCursor),
    /invalid_pagination_cursor/,
  );
  await assert.rejects(
    listUserBookmarks(userId, 1, `${bookmarkCursor.slice(0, -1)}x`),
    /invalid_pagination_cursor/,
  );
  const revisionCursor = (await listUserBookmarks(userId, 1)).nextCursor!;
  await setUserTargetState(userId, rootId, 'source', sourceA, { note: 'revision bump' });
  await assert.rejects(listUserBookmarks(userId, 1, revisionCursor), /invalid_pagination_cursor/);
  const aclCursor = (await listUserBookmarks(userId, 1)).nextCursor!;
  await pool.query('delete from library_access_grants where user_id=$1 and root_id=$2', [
    userId,
    rootId,
  ]);
  await assert.rejects(listUserBookmarks(userId, 1, aclCursor), /invalid_pagination_cursor/);
  assert.deepEqual((await listUserBookmarks(userId, 1)).items, []);
  assert.deepEqual(await listUserCollectionMembers(userId, collection!.id, 1), {
    items: [],
    nextCursor: null,
  });
  await pool.query(
    'insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$1)',
    [userId, rootId],
  );

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
  const publicationTargetKey = `${seriesA}:${pubA}`;
  await setUserTargetState(userId, rootId, 'series', seriesA, { favorite: true });
  await setUserTargetState(userId, rootId, 'publication', publicationTargetKey, { favorite: true });
  await setUserCollectionMembership(userId, collection!.id, rootId, 'series', seriesA, true);
  await setUserCollectionMembership(
    userId,
    collection!.id,
    rootId,
    'publication',
    publicationTargetKey,
    true,
  );
  const targetIdentityRows = (await listUserTargetState(userId, 20)).items;
  assert.ok(
    targetIdentityRows.some((item) => item.targetKind === 'series' && item.targetKey === seriesA),
  );
  assert.ok(
    targetIdentityRows.some(
      (item) => item.targetKind === 'publication' && item.targetKey === publicationTargetKey,
    ),
  );
  const identityMemberRows = (await listUserCollectionMembers(userId, collection!.id, 20))!.items;
  assert.ok(
    identityMemberRows.some((item) => item.targetKind === 'series' && item.targetKey === seriesA),
  );
  assert.ok(
    identityMemberRows.some(
      (item) => item.targetKind === 'publication' && item.targetKey === publicationTargetKey,
    ),
  );
  const pagedIdentityTargets: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await listUserTargetState(userId, 1, cursor);
    page.items.forEach(checkOpaque);
    pagedIdentityTargets.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pagedIdentityTargets.length, 5);
  const pagedIdentityMembers: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = (await listUserCollectionMembers(userId, collection!.id, 1, cursor))!;
    page.items.forEach(checkOpaque);
    pagedIdentityMembers.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pagedIdentityMembers.length, 5);
  const detailBefore = (await catalogPublicationDetail(pubAId, userScope)) as any;
  assert.equal(detailBefore.releases.length, 1);
  assert.equal(detailBefore.credits.length, 1, 'credits are hydrated from visible releases');
  const entity = await listCatalogEntities('creator', userScope, { q: 'Shared Writer' });
  assert.equal(entity.length, 1);

  const cursorPage = await listCatalogSeries({ libraryId: rootId, limit: 1 }, userScope);
  assert.ok(cursorPage.nextCursor);
  await setUserTargetState(userId, rootId, 'source', sourceA, { hidden: true });
  await setUserTargetState(userId, rootId, 'source', sourceB, { hidden: true });
  const hiddenIdentityTargets = await listUserTargetState(userId, 20);
  assert.equal(
    hiddenIdentityTargets.items.some((item) => item.targetKey === seriesA),
    false,
  );
  assert.equal(
    hiddenIdentityTargets.items.some((item) => item.targetKey === publicationTargetKey),
    false,
  );
  const hiddenIdentityMembers = (await listUserCollectionMembers(userId, collection!.id, 20))!;
  assert.equal(
    hiddenIdentityMembers.items.some((item) => item.targetKey === seriesA),
    false,
  );
  assert.equal(
    hiddenIdentityMembers.items.some((item) => item.targetKey === publicationTargetKey),
    false,
  );
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
  await setUserTargetState(userId, rootId, 'source', sourceB, { hidden: false });
  const restored = await catalogPublicationDetail(pubAId, await libraryAccessScope(userId));
  assert.ok(restored, 'unhide restores the source-backed publication');
  assert.equal(await isReaderPathVisible(userId, readerPath), true);
  assert.ok(await getReaderReleaseDescriptor(releases.rows[0]!.id, userId));
  const pubKey = publicationTargetKey;
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
  await pool
    .query('delete from source_items where root_id=$1', [unicodeRoot])
    .catch(() => undefined);
  await pool.query('delete from catalog_libraries where id=$1', [rootId]).catch(() => undefined);
  await pool
    .query('delete from "user" where id=any($1::text[])', [[userId, otherId]])
    .catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [rootId]).catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [unicodeRoot]).catch(() => undefined);
  await pool.end();
}
