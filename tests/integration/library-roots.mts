import assert from 'node:assert/strict';
import {
  assertSchema,
  migrateSchema,
  pool,
  reconcileLibraryRoots,
} from '../../packages/db/src/index.ts';
import type { LibraryRootSnapshot } from '../../packages/library-roots/src/index.ts';

const ids = ['integration-alpha', 'integration-bravo'];
const generation = 'a'.repeat(64);

function assertIntegrationDatabase(): void {
  if (process.env.GUTTER_INTEGRATION_TEST !== '1')
    throw new Error('library-root integration requires GUTTER_INTEGRATION_TEST=1');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('library-root integration requires DATABASE_URL');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('library-root integration requires a valid DATABASE_URL');
  }
  if (database.pathname !== '/gutter_integration')
    throw new Error('library-root integration requires the gutter_integration database');
}

function snapshot(
  id: string,
  configuredPath: string,
  state: LibraryRootSnapshot['state'] = 'ready_empty',
  canonicalPath: string | null = configuredPath,
): LibraryRootSnapshot {
  return {
    id,
    configuredPath,
    canonicalPath,
    state,
    reasonCode: state.startsWith('ready_') ? null : 'ENOENT',
    checkedAt: new Date('2026-08-08T00:00:00.000Z'),
  };
}

async function root(id: string) {
  const result = await pool.query<{
    id: string;
    configured_path: string;
    active: boolean;
  }>('select id, configured_path, active from library_roots where id = $1', [id]);
  return result.rows[0];
}

let integrationDatabaseVerified = false;

try {
  assertIntegrationDatabase();
  integrationDatabaseVerified = true;
  await migrateSchema();
  await migrateSchema();
  await assertSchema();
  await pool.query('delete from library_roots where id = any($1::text[])', [ids]);

  await reconcileLibraryRoots(
    [
      snapshot('integration-alpha', '/libraries/alpha'),
      snapshot('integration-bravo', '/libraries/bravo', 'missing', null),
    ],
    generation,
  );
  assert.deepEqual(await root('integration-alpha'), {
    id: 'integration-alpha',
    configured_path: '/libraries/alpha',
    active: true,
  });
  assert.equal((await root('integration-bravo'))?.active, true);

  await reconcileLibraryRoots(
    [snapshot('integration-alpha', '/libraries/alpha-renamed', 'ready_nonempty')],
    generation,
  );
  assert.equal((await root('integration-alpha'))?.configured_path, '/libraries/alpha-renamed');
  assert.equal((await root('integration-alpha'))?.active, true);
  assert.equal((await root('integration-bravo'))?.active, false);

  await reconcileLibraryRoots(
    [snapshot('integration-bravo', '/libraries/bravo', 'ready_empty')],
    generation,
  );
  assert.equal((await root('integration-bravo'))?.active, true);

  await assert.rejects(
    reconcileLibraryRoots(
      [snapshot('integration-bravo', '/libraries/bravo', 'ready_empty', null)],
      generation,
    ),
  );
  assert.equal((await root('integration-bravo'))?.active, true);
} finally {
  try {
    if (integrationDatabaseVerified)
      await pool.query('delete from library_roots where id = any($1::text[])', [ids]);
  } finally {
    await pool.end();
  }
}
