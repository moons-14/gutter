import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  canAccessLibrary,
  changeLibraryAccess,
  createUserCollection,
  exportUserState,
  addUserBookmark,
  libraryAccessScope,
  permanentlyDeleteUser,
  getUserProgress,
  migrateSchema,
  normalizeUserSourceKey,
  pool,
  putUserProgress,
  setUserCollectionMembership,
  setUserTargetState,
  userStateScope,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_INTEGRATION_TEST !== '1')
  throw new Error('access-control integration requires GUTTER_INTEGRATION_TEST=1');

const suffix = randomUUID();
const rootId = `acl-${suffix}`;
const adminId = `admin-${suffix}`;
const userId = `user-${suffix}`;
const otherId = `other-${suffix}`;
const userIds = [adminId, userId, otherId];

try {
  await migrateSchema();
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/acl/${rootId}`, 'f'.repeat(64)],
  );
  for (const [id, role] of [
    [adminId, 'admin'],
    [userId, 'user'],
    [otherId, 'user'],
  ] as const)
    await pool.query(
      `insert into "user"(id,name,email,"createdAt","updatedAt",role)
       values($1,$1,$2,now(),now(),$3)`,
      [id, `${id}@example.invalid`, role],
    );

  const denied = await libraryAccessScope(userId);
  assert.equal(denied.revision, 0);
  assert.equal(canAccessLibrary(denied, rootId), false, 'ordinary users are denied by default');
  assert.equal(
    canAccessLibrary(await libraryAccessScope(adminId), rootId),
    true,
    'admin bypasses grants',
  );

  await assert.rejects(
    changeLibraryAccess(otherId, userId, rootId, 'grant', `denied-${suffix}`),
    /admin_required/,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from library_access_grants where user_id=$1',
        [userId],
      )
    ).rows[0]?.count,
    0,
    'failed non-admin mutation rolls back',
  );

  assert.equal(await changeLibraryAccess(adminId, userId, rootId, 'grant', `grant-${suffix}`), 1);
  const granted = await libraryAccessScope(userId);
  assert.equal(canAccessLibrary(granted, rootId), true);
  assert.notEqual(granted.scopeHash, denied.scopeHash, 'grant changes the ACL cursor/cache scope');
  assert.equal(
    await changeLibraryAccess(adminId, userId, rootId, 'grant', `duplicate-${suffix}`),
    1,
    'duplicate grants are idempotent',
  );

  assert.equal(await changeLibraryAccess(adminId, userId, rootId, 'revoke', `revoke-${suffix}`), 2);
  const revoked = await libraryAccessScope(userId);
  assert.equal(canAccessLibrary(revoked, rootId), false);
  assert.notEqual(
    revoked.scopeHash,
    granted.scopeHash,
    'revocation invalidates scoped cursors/caches',
  );
  const audit = await pool.query<{ action: string; request_id: string }>(
    `select action,request_id from gutter_acl_audit where subject_user_id=$1 order by id`,
    [userId],
  );
  assert.deepEqual(audit.rows, [
    { action: 'grant', request_id: `grant-${suffix}` },
    { action: 'revoke', request_id: `revoke-${suffix}` },
  ]);
  // Released 0009 permits duplicate request IDs in its append-only history. The 0010
  // upgrade must preserve that history; idempotency is tracked in a separate claim table.
  await pool.query(
    `insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id)
     values ($1,$2,$3,'grant',$4),($1,$2,$3,'grant',$4)`,
    [adminId, userId, rootId, `legacy-duplicate-${suffix}`],
  );
  assert.equal(
    (
      await pool.query('select count(*)::int as count from gutter_acl_audit where request_id=$1', [
        `legacy-duplicate-${suffix}`,
      ])
    ).rows[0]?.count,
    2,
    'upgrade preserves duplicate released audit history',
  );
  // 0009 also allowed malformed legacy request IDs.  A forward NOT VALID check
  // preserves those immutable rows while enforcing the contract for new inserts.
  const upgradeFixture = await pool.connect();
  try {
    await upgradeFixture.query('begin');
    await upgradeFixture.query(
      'alter table gutter_acl_audit drop constraint if exists gutter_acl_audit_request_id_length',
    );
    const oversizedLegacyRequestId = 'x'.repeat(129);
    await upgradeFixture.query(
      `insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id)
       values ($1,$2,$3,'grant',$4),($1,$2,$3,'grant',$5)`,
      [adminId, userId, rootId, '', oversizedLegacyRequestId],
    );
    await upgradeFixture.query(
      `alter table gutter_acl_audit add constraint gutter_acl_audit_request_id_length
       check (length(request_id) between 1 and 128) not valid`,
    );
    assert.deepEqual(
      (
        await upgradeFixture.query<{ convalidated: boolean }>(
          `select convalidated from pg_constraint where conrelid='gutter_acl_audit'::regclass
           and conname='gutter_acl_audit_request_id_length'`,
        )
      ).rows[0]?.convalidated,
      false,
      'legacy audit constraint remains NOT VALID after upgrade',
    );
    for (const invalidRequestId of ['', oversizedLegacyRequestId]) {
      await upgradeFixture.query('savepoint invalid_audit_insert');
      await assert.rejects(
        upgradeFixture.query(
          `insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id)
           values ($1,$2,$3,'grant',$4)`,
          [adminId, userId, rootId, invalidRequestId],
        ),
        /gutter_acl_audit_request_id_length|check constraint/,
      );
      await upgradeFixture.query('rollback to savepoint invalid_audit_insert');
    }
    await upgradeFixture.query('commit');
  } finally {
    await upgradeFixture.query('rollback').catch(() => undefined);
    upgradeFixture.release();
  }
  await assert.rejects(
    changeLibraryAccess(adminId, userId, rootId, 'grant', ''),
    /invalid_request_id/,
  );
  await assert.rejects(
    changeLibraryAccess(adminId, userId, rootId, 'grant', 'x'.repeat(129)),
    /invalid_request_id/,
  );
  const idempotentRequest = `idempotent-${suffix}`;
  const concurrent = await Promise.all([
    changeLibraryAccess(adminId, userId, rootId, 'grant', idempotentRequest),
    changeLibraryAccess(adminId, userId, rootId, 'grant', idempotentRequest),
  ]);
  assert.deepEqual(concurrent, [3, 3], 'concurrent request claim is idempotent');
  assert.equal(
    await changeLibraryAccess(adminId, userId, rootId, 'grant', idempotentRequest),
    3,
    'retry returns the original revision without another mutation',
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from gutter_acl_request_claims where request_id=$1',
        [idempotentRequest],
      )
    ).rows[0]?.count,
    1,
  );
  await assert.rejects(
    changeLibraryAccess(adminId, userId, rootId, 'revoke', idempotentRequest),
    /request_id_conflict/,
  );
  await assert.rejects(
    pool.query('delete from gutter_acl_audit where subject_user_id=$1', [userId]),
    /append-only/,
  );
  const apiClient = await pool.connect();
  try {
    await apiClient.query('begin');
    await apiClient.query('set local role gutter_api');
    const suppressionPrivileges = await apiClient.query<{
      select_allowed: boolean;
      insert_allowed: boolean;
      update_allowed: boolean;
      delete_allowed: boolean;
    }>(`select
      has_table_privilege(current_user, 'public.global_source_suppressions', 'SELECT') as select_allowed,
      has_table_privilege(current_user, 'public.global_source_suppressions', 'INSERT') as insert_allowed,
      has_table_privilege(current_user, 'public.global_source_suppressions', 'UPDATE') as update_allowed,
      has_table_privilege(current_user, 'public.global_source_suppressions', 'DELETE') as delete_allowed`);
    assert.deepEqual(
      suppressionPrivileges.rows[0],
      {
        select_allowed: true,
        insert_allowed: false,
        update_allowed: false,
        delete_allowed: false,
      },
      'API suppression access is read-only',
    );
    await assert.rejects(
      apiClient.query(
        'insert into global_source_suppressions(source_item_id,reason) values(1,$1)',
        [`api-denied-${suffix}`],
      ),
      /permission denied/,
    );
    await apiClient.query('rollback');
    await apiClient.query('begin');
    await apiClient.query('set local role gutter_api');
    await apiClient.query('savepoint denied_grant');
    await assert.rejects(
      apiClient.query(
        'insert into library_access_grants(user_id,root_id,granted_by_user_id) values($1,$2,$3)',
        [userId, rootId, adminId],
      ),
      /permission denied/,
      'API cannot bypass the security-definer ACL function',
    );
    await apiClient.query('rollback to savepoint denied_grant');
    await apiClient.query('savepoint denied_audit');
    await assert.rejects(
      apiClient.query(
        'insert into gutter_acl_audit(actor_user_id,subject_user_id,root_id,action,request_id) values($1,$2,$3,$4,$5)',
        [adminId, userId, rootId, 'grant', `direct-${suffix}`],
      ),
      /permission denied/,
    );
    await apiClient.query('rollback to savepoint denied_audit');
    await apiClient.query('rollback');
    await apiClient.query('begin');
    await apiClient.query('set local role gutter_api');
    const functionResult = await apiClient.query<{ revision: string }>(
      'select gutter_change_library_access($1,$2,$3,$4,$5)::text as revision',
      [adminId, otherId, rootId, 'grant', `api-function-${suffix}`],
    );
    assert.equal(functionResult.rows[0]?.revision, '1');
    assert.equal(
      (
        await apiClient.query('select revision from gutter_acl_revisions where user_id=$1', [
          otherId,
        ])
      ).rows[0]?.revision,
      '1',
    );
    await apiClient.query('commit');
    assert.deepEqual(
      (
        await pool.query(
          'select subject_user_id,request_id from gutter_acl_audit where request_id=$1',
          [`api-function-${suffix}`],
        )
      ).rows,
      [{ subject_user_id: otherId, request_id: `api-function-${suffix}` }],
    );
  } finally {
    await apiClient.query('rollback').catch(() => undefined);
    apiClient.release();
  }

  assert.equal(normalizeUserSourceKey('folder\\issue.cbz'), 'folder/issue.cbz');
  assert.throws(() => normalizeUserSourceKey('../issue.cbz'), /invalid_user_source_key/);
  await assert.rejects(
    putUserProgress(userId, rootId, 'issue.cbz', 0, { pageOrdinal: 1_000_001, completed: false }),
    /invalid_page_ordinal/,
  );
  const inserted = await putUserProgress(userId, rootId, 'issue.cbz', 0, {
    pageOrdinal: 3,
    completed: false,
  });
  assert.equal(inserted.ok, true);
  if (!inserted.ok) throw new Error('expected progress insert');
  assert.equal(inserted.current.revision, 1);
  const beforeStale = await getUserProgress(userId, rootId, 'issue.cbz');
  const stale = await putUserProgress(userId, rootId, 'issue.cbz', 0, {
    pageOrdinal: 4,
    completed: true,
  });
  assert.equal(stale.ok, false, 'stale CAS is immutable');
  assert.deepEqual(await getUserProgress(userId, rootId, 'issue.cbz'), beforeStale);
  const updated = await putUserProgress(userId, rootId, 'issue.cbz', 1, {
    pageOrdinal: 4,
    completed: true,
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) throw new Error('expected progress update');
  const retried = await putUserProgress(userId, rootId, 'issue.cbz', updated.current.revision, {
    pageOrdinal: 4,
    completed: true,
  });
  assert.equal(retried.ok, true, 'an exact-current retry is recorded as another read');
  if (!retried.ok) throw new Error('expected exact-current progress retry');
  assert.equal(retried.current.revision, updated.current.revision + 1);
  assert.equal(retried.current.openCount, updated.current.openCount + 1);
  assert.equal((await userStateScope(userId)).revision, 3);
  assert.equal(await getUserProgress(otherId, rootId, 'issue.cbz'), null, 'state is user isolated');

  assert.equal(
    await setUserTargetState(userId, rootId, 'source', 'issue.cbz', {
      favorite: true,
      note: 'keep',
    }),
    true,
  );
  const seriesKey = 'a'.repeat(64);
  const publicationKey = 'b'.repeat(64);
  assert.equal(
    await setUserTargetState(userId, rootId, 'series', seriesKey, { favorite: true }),
    true,
  );
  assert.equal(
    await setUserTargetState(userId, rootId, 'publication', seriesKey + ':' + publicationKey, {
      favorite: true,
    }),
    true,
  );
  await assert.rejects(
    setUserTargetState(userId, rootId, 'publication', publicationKey, { favorite: true }),
    /invalid_user_target/,
  );
  assert.equal(
    await setUserTargetState(userId, rootId, 'source', 'issue.cbz', { rating: 4 }),
    true,
  );
  const collection = await createUserCollection(userId, 'Favorites');
  if (!collection) throw new Error('expected collection');
  assert.equal(
    await setUserCollectionMembership(userId, collection.id, rootId, 'source', 'issue.cbz', true),
    true,
  );
  assert.equal(await addUserBookmark(userId, rootId, 'issue.cbz', 4, 'final page'), true);
  const exported = await exportUserState(userId);
  assert.deepEqual(
    exported.targetState
      .filter((state: any) => state.targetKind === 'source')
      .map((state: any) => ({ favorite: state.favorite, rating: state.rating, note: state.note })),
    [{ favorite: true, rating: 4, note: 'keep' }],
    'partial target updates preserve omitted fields',
  );
  assert.equal(exported.bookmarks.length, 1);
  assert.equal(exported.collections.length, 1);

  await pool.query('begin');
  await pool.query('set local role gutter_api');
  await assert.rejects(
    pool.query('update library_roots set active=false where id=$1', [rootId]),
    /permission denied/,
  );
  await pool.query('rollback');

  const trustIdentifier = `trust-device-${suffix}`;
  const challengeIdentifier = `2fa-challenge-${suffix}`;
  await pool.query(
    `insert into verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
     values
       ($1,$2,$3,now()+interval '1 hour',now(),now()),
       ($4,$5,$6,now()+interval '1 hour',now(),now()),
       ($7,$8,$9,now()+interval '1 hour',now(),now()),
       ($10,$11,$12,now()+interval '1 hour',now(),now()),
       ($13,$14,$15,now()+interval '1 hour',now(),now()),
       ($16,$17,$18,now()+interval '1 hour',now(),now()),
       ($19,$20,$21,now()+interval '1 hour',now(),now())`,
    [
      `verification-${suffix}-trust`,
      trustIdentifier,
      userId,
      `verification-${suffix}-trust-companion`,
      `2fa-attempts-${trustIdentifier}`,
      'unused',
      `verification-${suffix}-challenge`,
      challengeIdentifier,
      userId,
      `verification-${suffix}-challenge-companion`,
      `2fa-attempts-${challengeIdentifier}`,
      'unused',
      `verification-${suffix}-email`,
      `${userId}@example.invalid`,
      'reset/delete',
      `verification-${suffix}-other`,
      `verification-${suffix}-other`,
      otherId,
      `verification-${suffix}-other-companion`,
      `2fa-attempts-other-${suffix}`,
      'unused',
    ],
  );
  await pool.query(
    `insert into "twoFactor"(id,secret,"backupCodes","userId") values($1,$2,$3,$4)`,
    [`two-factor-${suffix}`, 'secret', '[]', userId],
  );
  const deletionRequestId = `integration-permanent-delete-${suffix}`;
  const deletion = await permanentlyDeleteUser(adminId, userId, deletionRequestId);
  assert.equal(
    deletion.verification,
    5,
    'all subject verification rows and exact companions deleted',
  );
  assert.equal(deletion.twoFactor, 1, 'two-factor material deleted by user id');
  assert.deepEqual(
    (
      await pool.query(
        'select actor_user_id,subject_user_id,action,request_id from gutter_user_state_audit where request_id=$1',
        [deletionRequestId],
      )
    ).rows,
    [
      {
        actor_user_id: adminId,
        subject_user_id: userId,
        action: 'permanent_delete',
        request_id: deletionRequestId,
      },
    ],
  );
  await assert.rejects(permanentlyDeleteUser(adminId, userId, ''), /invalid_request_id/);
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from gutter_user_state_audit where subject_user_id=$1',
        [userId],
      )
    ).rows[0]?.count,
    1,
    'invalid deletion request rolls back without a second audit',
  );
  assert.deepEqual(
    (
      await pool.query<{ identifier: string; value: string }>(
        'select identifier,value from verification where identifier like $1 order by identifier',
        [`%${suffix}%`],
      )
    ).rows,
    [
      { identifier: `2fa-attempts-other-${suffix}`, value: 'unused' },
      { identifier: `verification-${suffix}-other`, value: otherId },
    ],
    'unrelated verification rows are preserved',
  );

  const workerUserClient = await pool.connect();
  try {
    await workerUserClient.query('begin');
    await workerUserClient.query('set local role gutter_worker');
    await workerUserClient.query('savepoint denied_user_read');
    await assert.rejects(
      workerUserClient.query('select id from "user" limit 1'),
      /permission denied/,
    );
    await workerUserClient.query('rollback to savepoint denied_user_read');
    await workerUserClient.query('savepoint denied_suppression_read');
    await assert.rejects(
      workerUserClient.query('select source_item_id from global_source_suppressions limit 1'),
      /permission denied/,
      'worker cannot bypass API-mediated suppression policy',
    );
    await workerUserClient.query('rollback to savepoint denied_suppression_read');
  } finally {
    await workerUserClient.query('rollback');
    workerUserClient.release();
  }

  const workerProgressClient = await pool.connect();
  try {
    await workerProgressClient.query('begin');
    await workerProgressClient.query('set local role gutter_worker');
    await assert.rejects(
      workerProgressClient.query('select user_id from user_progress limit 1'),
      /permission denied/,
    );
  } finally {
    await workerProgressClient.query('rollback');
    workerProgressClient.release();
  }
} finally {
  await pool.end();
}
