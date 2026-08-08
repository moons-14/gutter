import { databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export const pool = new Pool({ connectionString: await databaseUrl() });
export const db = drizzle(pool);

export async function migrateSchema(): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
}

export async function assertSchema(): Promise<void> {
  const result = await pool.query<{ version: string }>(
    'select version from gutter_schema where version = $1 limit 1',
    [schemaVersion],
  );
  if (!result.rows[0])
    throw new Error(`database schema is incompatible; expected ${schemaVersion}`);
}

export async function reconcileLibraryRoots(
  roots: readonly LibraryRootSnapshot[],
  configGeneration: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('update library_roots set active = false, updated_at = now() where active');
    for (const root of roots) {
      await client.query(
        `insert into library_roots
          (id, configured_path, canonical_path, state, reason_code, checked_at, config_generation, active)
         values ($1, $2, $3, $4, $5, $6, $7, true)
         on conflict (id) do update set
           configured_path = excluded.configured_path,
           canonical_path = excluded.canonical_path,
           state = excluded.state,
           reason_code = excluded.reason_code,
           checked_at = excluded.checked_at,
           config_generation = excluded.config_generation,
           active = true,
           updated_at = now()`,
        [
          root.id,
          root.configuredPath,
          root.canonicalPath,
          root.state,
          root.reasonCode,
          root.checkedAt,
          configGeneration,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
