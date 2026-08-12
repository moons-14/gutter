import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  changeLibraryAccess,
  listAdminUsers,
  migrateSchema,
  pool,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_INTEGRATION_TEST !== '1')
  throw new Error('admin-users integration requires GUTTER_INTEGRATION_TEST=1');
const suffix = randomUUID(),
  rootId = `users-${suffix}`,
  adminId = `admin-${suffix}`;
const ids = Array.from({ length: 4 }, (_, index) => `user-${index}-${suffix}`);
try {
  await migrateSchema();
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active) values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/users/${rootId}`, 'a'.repeat(64)],
  );
  await pool.query(
    `insert into "user"(id,name,email,"createdAt","updatedAt",role) values($1,$1,$2,now() - interval '1 day',$3,'admin')`,
    [adminId, `${adminId}@invalid`, new Date()],
  );
  for (const [index, id] of ids.entries())
    await pool.query(
      `insert into "user"(id,name,email,"createdAt","updatedAt",role) values($1,$2,$3,now() - make_interval(mins => $4),now(),'user')`,
      [id, `User ${index}`, `user${index}@invalid`, index],
    );
  const first = await listAdminUsers({ limit: 2 });
  assert.deepEqual(
    first.items.map((user) => user.id),
    [ids[0], ids[1]],
  );
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['banned', 'email', 'id', 'name', 'role']);
  assert.ok(first.nextCursor);
  const second = await listAdminUsers({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(
    second.items.map((user) => user.id),
    [ids[2], ids[3]],
  );
  assert.deepEqual((await listAdminUsers({ q: '%', limit: 10 })).items, []);
  assert.deepEqual((await listAdminUsers({ q: '_', limit: 10 })).items, []);
  await assert.rejects(
    () => listAdminUsers({ limit: 2, cursor: `${first.nextCursor!.slice(0, -1)}x` }),
    /invalid_cursor/,
  );
  await assert.rejects(
    () => listAdminUsers({ q: 'different', limit: 2, cursor: first.nextCursor! }),
    /invalid_cursor/,
  );
  assert.deepEqual((await listAdminUsers({ q: 'missing', limit: 10 })).items, []);
  const beforeAudit = await pool.query('select count(*)::int as count from gutter_acl_audit');
  await listAdminUsers({ limit: 10 });
  const afterRead = await pool.query('select count(*)::int as count from gutter_acl_audit');
  assert.equal(afterRead.rows[0].count, beforeAudit.rows[0].count);
  await changeLibraryAccess(adminId, ids[0], rootId, 'grant', `request-${suffix}`);
  await changeLibraryAccess(adminId, ids[0], rootId, 'revoke', `request-${suffix}-2`);
  const audit = await pool.query(
    `select action from gutter_acl_audit where subject_user_id=$1 order by occurred_at`,
    [ids[0]],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ['grant', 'revoke'],
  );
  process.stdout.write('admin-users integration passed\n');
} finally {
  await pool
    .query('delete from "user" where id=any($1::text[])', [[adminId, ...ids]])
    .catch(() => undefined);
  await pool.query('delete from library_roots where id=$1', [rootId]).catch(() => undefined);
  await pool.end();
}
