import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { drizzle } from '../../packages/db/node_modules/drizzle-orm/node-postgres/index.js';
import { migrate } from '../../packages/db/node_modules/drizzle-orm/node-postgres/migrator.js';

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = resolve(process.cwd(), 'packages/db/drizzle');
const skipReason = 'real PostgreSQL migration oracle requires DATABASE_URL';

async function withDatabase<T>(fn: (url: string, pool: Pool) => Promise<T>): Promise<T> {
  assert.ok(databaseUrl);
  const base = new URL(databaseUrl);
  const admin = new URL(base);
  admin.pathname = '/postgres';
  const name = `gutter_public_api_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: admin.toString() });
  await adminPool.query(`create database "${name}"`);
  await adminPool.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try {
    return await fn(target.toString(), pool);
  } finally {
    await pool.end();
    const cleanup = new Pool({ connectionString: admin.toString() });
    await cleanup.query(`drop database "${name}" with (force)`);
    await cleanup.end();
  }
}

async function applyMigrations(url: string, folder: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

async function assertLookupOracle(pool: Pool): Promise<void> {
  const rootId = `oracle-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await pool.query(
    `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
     values($1,$2,$2,'ready_empty',now(),$3,true)`,
    [rootId, `/oracle/${rootId}`, 'a'.repeat(64)],
  );
  await pool.query(
    `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
     select $1,'source-'||g||'.cbz','cbz',1,g,1,true,$2 from generate_series(1,2500) g`,
    [rootId, 'b'.repeat(64)],
  );
  const sourceKey = `source:${Buffer.from(
    await (async () => {
      const crypto = await import('node:crypto');
      return crypto.createHash('sha256').update(`${rootId}\u0000source-137.cbz`).digest();
    })(),
  ).toString('base64url')}`;
  await pool.query('set enable_seqscan=off');
  const plan = await pool.query(
    `explain (format json)
       select i.root_id,i.relative_path
       from source_items i
       join library_roots root on root.id=i.root_id and root.active
       where i.public_progress_key = $1
         and i.active and i.quarantine_reason is null
         and not exists (select 1 from global_source_suppressions s where s.source_item_id=i.id)
       limit 1`,
    [sourceKey],
  );
  const explain = JSON.stringify(plan.rows[0]?.['QUERY PLAN']);
  assert.match(
    explain,
    /source_items_progress_key_idx/,
    'bounded lookup uses the base-table index',
  );
  const match = await pool.query(
    `select i.root_id,i.relative_path
       from source_items i
       join library_roots root on root.id=i.root_id and root.active
       where i.public_progress_key = $1
         and i.active and i.quarantine_reason is null
         and not exists (select 1 from global_source_suppressions s where s.source_item_id=i.id)
       limit 1`,
    [sourceKey],
  );
  assert.deepEqual(match.rows[0], { root_id: rootId, relative_path: 'source-137.cbz' });
  await pool.query('reset enable_seqscan');
}

const migrationOptions = databaseUrl ? {} : { skip: skipReason };

test(
  'fresh migration registers 0012, creates pgcrypto and a real source_items index',
  migrationOptions,
  async () => {
    await withDatabase(async (url, pool) => {
      await applyMigrations(url, migrationsFolder);
      const versions = await pool.query<{ version: string }>(
        `select version from gutter_schema where version in ('0011_public_api_tokens','0012_public_progress_lookup') order by version`,
      );
      assert.deepEqual(
        versions.rows.map((row) => row.version),
        ['0011_public_api_tokens', '0012_public_progress_lookup'],
      );
      assert.equal(
        (await pool.query(`select 1 from pg_extension where extname='pgcrypto'`)).rowCount,
        1,
      );
      const relation = await pool.query<{ relkind: string; indexdef: string }>(
        `select c.relkind,pg_get_indexdef(i.indexrelid) as indexdef
       from pg_class c join pg_index i on i.indexrelid=c.oid
       where c.relname='source_items_progress_key_idx'`,
      );
      assert.deepEqual(relation.rows[0]?.relkind, 'i');
      assert.match(relation.rows[0]?.indexdef ?? '', /source_items/);
      assert.equal(
        (await pool.query(`select relkind from pg_class where relname='visible_source_items'`))
          .rows[0]?.relkind,
        'v',
      );
      await assertLookupOracle(pool);
    });
  },
);

test(
  '0011 to 0012 upgrade applies through the committed Drizzle journal',
  migrationOptions,
  async () => {
    const temporary = await mkdtemp('/tmp/gutter-migrations-');
    try {
      await cp(migrationsFolder, temporary, { recursive: true });
      const journalPath = resolve(temporary, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 12);
      await writeFile(journalPath, JSON.stringify(journal));
      await withDatabase(async (url, pool) => {
        await applyMigrations(url, temporary);
        assert.equal(
          (await pool.query(`select 1 from pg_extension where extname='pgcrypto'`)).rowCount,
          0,
        );
        await applyMigrations(url, migrationsFolder);
        assert.equal(
          (await pool.query(`select 1 from pg_extension where extname='pgcrypto'`)).rowCount,
          1,
        );
        assert.equal(
          (
            await pool.query(
              `select count(*)::int as count from "drizzle"."__drizzle_migrations" where created_at=1787094000000`,
            )
          ).rows[0]?.count,
          1,
        );
        await assertLookupOracle(pool);
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
