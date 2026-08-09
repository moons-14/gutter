import { PgBoss } from 'pg-boss';
import { databaseUrl, secret } from '@gutter/config';
import { migrateSchema, pool } from './index.js';

await migrateSchema();

// Schema creation belongs to the migrator.  The worker can operate its queue but cannot create
// or own database objects.
const boss = new PgBoss({ connectionString: await databaseUrl() });
await boss.start();
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
await pool.query(`grant usage on schema pgboss to gutter_worker`);
await pool.query(
  `grant select, insert, update, delete on all tables in schema pgboss to gutter_worker`,
);
await pool.query(`grant usage, select, update on all sequences in schema pgboss to gutter_worker`);
await pool.query(`grant execute on all functions in schema pgboss to gutter_worker`);
await pool.query(`grant select on gutter_schema to gutter_api`);
await pool.end();
