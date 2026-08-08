import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  assertSchema,
  cancelScanRun,
  completeScanRun,
  failScanRun,
  migrateSchema,
  pool,
  persistScanItems,
  reconcileLibraryRoots,
  startScanRun,
} from '../../packages/db/src/index.ts';
import {
  PgBoss,
  enqueueDiscovery,
  startDiscoveryQueue,
} from '../../apps/worker/src/discovery-queue.ts';
import type { LibraryRootSnapshot } from '../../packages/library-roots/src/index.ts';
import type { ScanItem, ScanSummary } from '../../packages/discovery-scanner/src/index.ts';

const ids = ['integration-alpha', 'integration-bravo', 'queue-root'];
const generation = 'a'.repeat(64);
const summary: ScanSummary = {
  discovered: 1,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  symlinks: 0,
  mixedParents: 0,
  pages: 2,
  reasons: {},
};
const item: ScanItem = {
  relativePath: 'chapter',
  kind: 'directory',
  size: 0,
  mtimeMs: 0,
  pages: ['1.jpg', '2.jpg'],
  quarantinedReason: null,
};

const queueItem: ScanItem = { ...item, relativePath: 'queue-chapter' };

async function eventually(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function quietLog() {
  return { info: () => undefined, error: () => undefined };
}

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

  const staleA = await startScanRun('integration-alpha', generation);
  const staleB = await startScanRun('integration-alpha', generation);
  const staleAItem: ScanItem = { ...item, relativePath: 'stale-a', pages: ['a.jpg'] };
  const staleBItem: ScanItem = { ...item, relativePath: 'stale-b', pages: ['b.jpg'] };
  await assert.rejects(persistScanItems(staleA, 'integration-alpha', [staleAItem]), {
    code: 'stale_scan_run',
  });
  await assert.rejects(completeScanRun(staleA, 'integration-alpha', summary), {
    code: 'stale_scan_run',
  });
  await persistScanItems(staleB, 'integration-alpha', [staleBItem]);
  await completeScanRun(staleB, 'integration-alpha', { ...summary, pages: 1 });
  assert.deepEqual(
    (
      await pool.query(
        'select relative_path, active from source_items where root_id=$1 order by relative_path',
        ['integration-alpha'],
      )
    ).rows,
    [{ relative_path: 'stale-b', active: true }],
  );
  assert.deepEqual(
    (
      await pool.query(
        `select p.locator from source_pages p join source_items i on i.id=p.source_item_id
         where i.root_id=$1 and i.relative_path='stale-b'`,
        ['integration-alpha'],
      )
    ).rows,
    [{ locator: 'b.jpg' }],
  );

  await reconcileLibraryRoots(
    [snapshot('queue-root', '/queue-current', 'ready_empty')],
    generation,
  );
  const queueName = `catalog.discovery.integration.${randomUUID()}`;
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  const queueEvents: string[] = [];
  let scanCalls = 0;
  let activeScans = 0;
  let maxActiveScans = 0;
  try {
    await boss.start();
    await startDiscoveryQueue({
      boss,
      queueName,
      readyRoots: new Map([
        [
          'queue-root',
          { ...snapshot('queue-root', '/queue-current')!, canonicalPath: '/queue-current' },
        ],
      ]),
      configGeneration: 'b'.repeat(64),
      signal: new AbortController().signal,
      scanRoot: async (canonicalPath) => {
        assert.equal(canonicalPath, '/queue-current');
        scanCalls += 1;
        activeScans += 1;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        try {
          if (scanCalls === 1) throw new Error('forced first scan failure');
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { items: [queueItem], summary };
        } finally {
          activeScans -= 1;
        }
      },
      startScanRun,
      persistScanItems,
      completeScanRun,
      failScanRun,
      cancelScanRun,
      log: {
        info: (_data, message) => queueEvents.push(message),
        error: (_data, message) => queueEvents.push(message),
      },
      retryDelay: 1,
    });
    const firstJob = await enqueueDiscovery(boss, 'queue-root', 'a'.repeat(64), queueName);
    const duplicateJob = await enqueueDiscovery(boss, 'queue-root', 'c'.repeat(64), queueName);
    assert.equal(typeof firstJob, 'string');
    assert.equal(duplicateJob, null);
    await eventually(async () => {
      const runs = await pool.query<{ state: string }>(
        'select state from scan_runs where root_id=$1 order by id',
        ['queue-root'],
      );
      return runs.rows.map((run) => run.state).join(',') === 'failed,completed';
    }, 'discovery retry did not complete');
    assert.equal(scanCalls, 2);
    assert.equal(maxActiveScans, 1);
    assert.ok(queueEvents.includes('discovery job rebound to current root snapshot'));
    assert.equal(
      (
        await pool.query<{ active: boolean }>(
          'select active from source_items where root_id=$1 and relative_path=$2',
          ['queue-root', 'queue-chapter'],
        )
      ).rows[0]?.active,
      true,
    );
    assert.equal(
      typeof (await enqueueDiscovery(boss, 'queue-removed', generation, queueName)),
      'string',
    );
    await eventually(
      () => queueEvents.includes('discovery job root unavailable; skipped'),
      'removed root was not skipped',
    );
    assert.equal(scanCalls, 2);
  } finally {
    await boss.stop();
  }

  const cancellationQueueName = `catalog.discovery.integration.${randomUUID()}`;
  const cancellation = new AbortController();
  const cancellationBoss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  try {
    await cancellationBoss.start();
    await startDiscoveryQueue({
      boss: cancellationBoss,
      queueName: cancellationQueueName,
      readyRoots: new Map([
        [
          'queue-root',
          { ...snapshot('queue-root', '/queue-current')!, canonicalPath: '/queue-current' },
        ],
      ]),
      configGeneration: 'b'.repeat(64),
      signal: cancellation.signal,
      scanRoot: async () => {
        cancellation.abort();
        throw new DOMException('cancelled', 'AbortError');
      },
      startScanRun,
      persistScanItems,
      completeScanRun,
      failScanRun,
      cancelScanRun,
      log: quietLog(),
      retryDelay: 1,
    });
    assert.equal(
      (await enqueueDiscovery(
        cancellationBoss,
        'queue-root',
        generation,
        cancellationQueueName,
      )) !== null,
      true,
    );
    await eventually(async () => {
      const result = await pool.query<{ state: string }>(
        "select state from scan_runs where root_id=$1 and state='cancelled' limit 1",
        ['queue-root'],
      );
      return result.rowCount === 1;
    }, 'aborted discovery run was not cancelled');
    assert.equal(
      (
        await pool.query<{ active: boolean }>(
          'select active from source_items where root_id=$1 and relative_path=$2',
          ['queue-root', 'queue-chapter'],
        )
      ).rows[0]?.active,
      true,
    );
  } finally {
    await cancellationBoss.stop();
  }

  const firstRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(firstRun, 'integration-alpha', [item]);
  await completeScanRun(firstRun, 'integration-alpha', summary);
  assert.deepEqual(
    (
      await pool.query(
        'select active, page_count from source_items where root_id=$1 and relative_path=$2',
        ['integration-alpha', 'chapter'],
      )
    ).rows[0],
    { active: true, page_count: 2 },
  );
  assert.deepEqual(
    (
      await pool.query(
        `select p.locator from source_pages p join source_items i on i.id=p.source_item_id
         where i.root_id=$1 and i.relative_path=$2 and i.last_seen_run_id=$3 order by p.ordinal`,
        ['integration-alpha', 'chapter', firstRun],
      )
    ).rows,
    [{ locator: '1.jpg' }, { locator: '2.jpg' }],
  );

  const secondRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(secondRun, 'integration-alpha', [item]);
  await completeScanRun(secondRun, 'integration-alpha', summary);
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from source_items where root_id=$1 and relative_path=$2 and last_seen_run_id=$3',
        ['integration-alpha', 'chapter', secondRun],
      )
    ).rows[0]?.count,
    1,
  );

  const failedRun = await startScanRun('integration-alpha', generation);
  await failScanRun(failedRun, { ...summary, failed: 1 });
  assert.equal(
    (
      await pool.query('select active from source_items where root_id=$1 and relative_path=$2', [
        'integration-alpha',
        'chapter',
      ])
    ).rows[0]?.active,
    true,
  );

  const emptyRun = await startScanRun('integration-alpha', generation);
  await completeScanRun(emptyRun, 'integration-alpha', { ...summary, discovered: 0, pages: 0 });
  assert.equal(
    (
      await pool.query('select active from source_items where root_id=$1 and relative_path=$2', [
        'integration-alpha',
        'chapter',
      ])
    ).rows[0]?.active,
    false,
  );

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
