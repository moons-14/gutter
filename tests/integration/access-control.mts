import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  canAccessLibrary,
  changeLibraryAccess,
  libraryAccessScope,
  migrateSchema,
  pool,
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
  await assert.rejects(
    pool.query('delete from gutter_acl_audit where subject_user_id=$1', [userId]),
    /append-only/,
  );

  await pool.query('begin');
  await pool.query('set local role gutter_api');
  await assert.rejects(
    pool.query('update library_roots set active=false where id=$1', [rootId]),
    /permission denied/,
  );
  await pool.query('rollback');

  await pool.query('begin');
  await pool.query('set local role gutter_worker');
  await assert.rejects(pool.query('select id from "user" limit 1'), /permission denied/);
  await pool.query('rollback');
} finally {
  await pool.end();
}
