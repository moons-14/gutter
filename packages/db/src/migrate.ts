import { PgBoss } from 'pg-boss';
import { databaseUrl, secret } from '@gutter/config';
import { migrateSchema, pool } from './index.js';
import { readFile } from 'node:fs/promises';

await migrateSchema();

// Schema creation belongs to the migrator.  The worker can operate its queue but cannot create
// or own database objects.
const boss = new PgBoss({ connectionString: await databaseUrl() });
await boss.start();
// Reapply the canonical policy after pg-boss has created its queue schema. The same SQL file is
// applied by Drizzle and by the post-restore bootstrap script.
const runtimeAclPolicy = await readFile(
  new URL('../drizzle/0011_runtime_acl_bootstrap.sql', import.meta.url),
  'utf8',
);
await pool.query(runtimeAclPolicy);
await boss.stop({ graceful: true, timeout: 30_000 });

const apiPassword = await secret('GUTTER_API_DB_PASSWORD');
const workerPassword = await secret('GUTTER_WORKER_DB_PASSWORD');
for (const [role, password] of [
  ['gutter_api', apiPassword],
  ['gutter_worker', workerPassword],
] as const) {
  const formatted = await pool.query<{ statement: string }>(
    `select format('alter role %I login password %L', $1::text, $2::text) statement`,
    [role, password],
  );
  await pool.query(formatted.rows[0]!.statement);
}
await pool.end();
