import { databaseUrl, schemaVersion } from '@gutter/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export const pool = new Pool({ connectionString: await databaseUrl() });
export const db = drizzle(pool);
export async function assertSchema(): Promise<void> {
  const result = await pool.query<{ version: string }>('select version from gutter_schema limit 1');
  if (result.rows[0]?.version !== schemaVersion)
    throw new Error(`database schema is incompatible; expected ${schemaVersion}`);
}
