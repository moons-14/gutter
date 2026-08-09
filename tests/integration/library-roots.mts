import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  assertSchema,
  approveMetadata,
  cancelScanRun,
  clearGlobalSourceSuppression,
  completeScanRun,
  failScanRun,
  migrateSchema,
  listCatalogSeries,
  catalogPublicationDetail,
  pool,
  metadataStatus,
  persistScanItems,
  recordMetadataCandidate,
  rebuildCatalogSeriesListStateForIntegration,
  rebuildCatalogProjectionForIntegration,
  reconcileLibraryRoots,
  rejectMetadata,
  setGlobalSourceSuppression,
  startScanRun,
} from '../../packages/db/src/index.ts';
import {
  PgBoss,
  enqueueDiscovery,
  startReconciliationQueue,
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
  metadataIssues: {},
  updated: 0,
  unchanged: 0,
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

async function clearCatalogRoots(rootIds: readonly string[]): Promise<void> {
  await pool.query('delete from catalog_series_list_state where library_id=any($1::text[])', [
    rootIds,
  ]);
  await pool.query(
    'delete from catalog_credits where release_id in (select id from catalog_releases where root_id=any($1::text[]))',
    [rootIds],
  );
  await pool.query('delete from catalog_releases where root_id=any($1::text[])', [rootIds]);
  await pool.query(
    'delete from catalog_publications where series_id in (select id from catalog_series where library_id=any($1::text[]))',
    [rootIds],
  );
  await pool.query('delete from catalog_series where library_id=any($1::text[])', [rootIds]);
  await pool.query(
    'delete from catalog_preferred_release_overrides where root_id=any($1::text[])',
    [rootIds],
  );
  await pool.query('delete from catalog_libraries where id=any($1::text[])', [rootIds]);
}

try {
  assertIntegrationDatabase();
  integrationDatabaseVerified = true;
  await migrateSchema();
  await migrateSchema();
  await assertSchema();
  await clearCatalogRoots(ids);
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
  assert.deepEqual(
    (
      await pool.query(
        'select id,display_name from catalog_libraries where id = any($1::text[]) order by id',
        [['integration-alpha', 'integration-bravo']],
      )
    ).rows,
    [
      { id: 'integration-alpha', display_name: 'integration-alpha' },
      { id: 'integration-bravo', display_name: 'integration-bravo' },
    ],
  );
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
  const canonicalIdentities = (
    await pool.query(`select s.identity_canonical_json as series, p.publication_identity_canonical_json as publication
      from catalog_releases r join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
      join source_items i on i.id=r.source_item_id where i.relative_path='stale-b'`)
  ).rows[0]!;
  assert.deepEqual(
    {
      series:
        typeof canonicalIdentities.series === 'string'
          ? JSON.parse(canonicalIdentities.series)
          : canonicalIdentities.series,
      publication:
        typeof canonicalIdentities.publication === 'string'
          ? JSON.parse(canonicalIdentities.publication)
          : canonicalIdentities.publication,
    },
    {
      series: [1, 'stale-b'],
      publication: [
        1,
        (
          await pool.query(
            `select s.identity_key from catalog_releases r join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id join source_items i on i.id=r.source_item_id where i.relative_path='stale-b'`,
          )
        ).rows[0].identity_key,
        'volume',
        null,
        null,
        'stale-b',
        null,
      ],
    },
  );
  assert.deepEqual(
    (
      await pool.query(
        "select display_name,search_document,visible_publication_count from catalog_series_list_state where library_id='integration-alpha'",
      )
    ).rows,
    [{ display_name: 'stale-b', search_document: 'stale-b stale-b', visible_publication_count: 1 }],
  );
  assert.equal(
    (
      await pool.query(
        "select visible_publication_count from catalog_series_list_state where library_id='integration-alpha'",
      )
    ).rows[0]?.visible_publication_count,
    1,
  );
  assert.deepEqual(
    (await listCatalogSeries({ q: 'stale-b', limit: 10 })).items.map((row) => row.displayName),
    ['stale-b'],
  );
  const staleSource = await pool.query<{ id: string }>(
    "select id from source_items where root_id='integration-alpha' and relative_path='stale-b'",
  );
  await pool.query(`update source_metadata set effective=$2::jsonb where source_item_id=$1`, [
    staleSource.rows[0]!.id,
    JSON.stringify({ title: 'stale-b', series: 'stale-b', writers: ['Writer'] }),
  ]);
  // Deliberately destroy the disposable hierarchy. Rebuild must retain source truth and the
  // stable-key override, then recreate the release, list row, and creator credit.
  await rebuildCatalogProjectionForIntegration();
  const rebuiltPublication = await pool.query<{ id: string }>(
    `select p.id from catalog_publications p join catalog_series s on s.id=p.series_id
     where s.library_id='integration-alpha' and p.display_name='stale-b'`,
  );
  const rebuiltDetail = await catalogPublicationDetail(rebuiltPublication.rows[0]!.id);
  assert.equal(rebuiltDetail?.releases.length, 1);
  assert.deepEqual(
    rebuiltDetail?.credits.map((credit: { displayName: string }) => credit.displayName),
    ['Writer'],
  );
  assert.deepEqual(
    (await listCatalogSeries({ q: 'stale-b', limit: 10 })).items.map((row) => row.displayName),
    ['stale-b'],
  );
  // A full projection rebuild is disposable: suppression/inactivity make the durable preferred
  // choice dormant, never delete it, and reactivation makes the same choice effective again.
  const staleRelease = await pool.query<{ source_item_id: string; identity_key: string }>(
    `select r.source_item_id,p.identity_key from catalog_releases r join catalog_publications p on p.id=r.publication_id
     join source_items i on i.id=r.source_item_id where i.root_id=$1 and i.relative_path='stale-b'`,
    ['integration-alpha'],
  );
  const staleSourceId = staleRelease.rows[0]!.source_item_id;
  await pool.query(
    `insert into catalog_preferred_release_overrides(root_id,publication_identity_key,preferred_source_item_id)
    values($1,$2,$3)`,
    ['integration-alpha', staleRelease.rows[0]!.identity_key, staleSourceId],
  );
  await setGlobalSourceSuppression(Number(staleSourceId), 'test-dormant');
  await rebuildCatalogSeriesListStateForIntegration();
  assert.deepEqual((await listCatalogSeries({ q: 'stale-b', limit: 10 })).items, []);
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from catalog_preferred_release_overrides where preferred_source_item_id=$1',
        [staleSourceId],
      )
    ).rows[0]?.count,
    1,
  );
  await clearGlobalSourceSuppression(Number(staleSourceId));
  await pool.query('update source_items set active=false where id=$1', [staleSourceId]);
  await rebuildCatalogSeriesListStateForIntegration();
  assert.deepEqual((await listCatalogSeries({ q: 'stale-b', limit: 10 })).items, []);
  await pool.query('update source_items set active=true where id=$1', [staleSourceId]);
  await rebuildCatalogSeriesListStateForIntegration();
  assert.deepEqual(
    (await listCatalogSeries({ q: 'stale-b', limit: 10 })).items.map((row) => row.displayName),
    ['stale-b'],
  );

  await reconcileLibraryRoots(
    [snapshot('queue-root', '/queue-current', 'ready_empty')],
    generation,
  );

  // Reconciliation metadata dispatch is post-persist, once per canonical identity, and lease-bound.
  let reconciliationWorker:
    | ((jobs: readonly { id?: string; data: { requestId: string } }[]) => Promise<void>)
    | undefined;
  const reconciliationEvents: string[] = [];
  let forwardedLease: AbortSignal | undefined;
  let reconciliationCancelled = false;
  const reconciliationBoss = {
    createQueue: async () => undefined,
    work: async (
      _queue: string,
      _options: unknown,
      handler: (jobs: readonly { id?: string; data: { requestId: string } }[]) => Promise<void>,
    ) => {
      reconciliationWorker = handler;
    },
  } as unknown as PgBoss;
  await startReconciliationQueue({
    boss: reconciliationBoss,
    readyRoots: new Map([
      [
        'queue-root',
        { ...snapshot('queue-root', '/queue-current')!, canonicalPath: '/queue-current' },
      ],
    ]),
    configGeneration: generation,
    signal: new AbortController().signal,
    claimRequest: async () => ({ runId: 1, rootId: 'queue-root' }),
    scanRootBatched: async (_root, options) => {
      await options.onItems?.([queueItem, { ...queueItem, relativePath: 'queue-duplicate' }]);
      return { items: [], summary };
    },
    persist: async () => {
      reconciliationEvents.push('persist');
      return { updated: 2, unchanged: 0 };
    },
    metadataLookupIntents: async () => {
      reconciliationEvents.push('lookup');
      return [
        { canonicalIdentity: 'd'.repeat(64), searchTerms: ['queue'], publicIds: [] },
        { canonicalIdentity: 'd'.repeat(64), searchTerms: ['duplicate'], publicIds: [] },
      ];
    },
    dispatchMetadata: async (_root, identity, _terms, _ids, signal) => {
      reconciliationEvents.push(`dispatch:${identity}`);
      forwardedLease = signal;
      reconciliationCancelled = true;
    },
    cancelled: async () => reconciliationCancelled,
    complete: async () => reconciliationEvents.push('complete'),
    fail: async () => undefined,
    cancel: async () => reconciliationEvents.push('cancel'),
    log: quietLog(),
  });
  assert.ok(reconciliationWorker);
  await assert.rejects(
    reconciliationWorker!([{ id: 'reconciliation-test', data: { requestId: 'request-test' } }]),
    { name: 'AbortError' },
  );
  assert.deepEqual(reconciliationEvents, [
    'persist',
    'lookup',
    `dispatch:${'d'.repeat(64)}`,
    'cancel',
  ]);
  assert.ok(forwardedLease?.aborted);

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

  const metadataIdentity = (
    await pool.query<{ identity_key: string }>(
      `select p.identity_key from catalog_releases r join catalog_publications p on p.id=r.publication_id
       join source_items i on i.id=r.source_item_id where i.root_id=$1 and i.relative_path=$2`,
      ['integration-alpha', 'chapter'],
    )
  ).rows[0]!.identity_key;
  const sourceProjection = await pool.query<{ display_name: string; series_name: string }>(
    `select p.display_name,s.display_name as series_name from catalog_releases r
     join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
     where r.root_id=$1 and p.identity_key=$2`,
    ['integration-alpha', metadataIdentity],
  );
  await recordMetadataCandidate('integration-alpha', metadataIdentity, {
    providerId: 'integration-sidecar',
    providerPriority: 0,
    configOrder: 0,
    values: { title: 'Approved provider title' },
    provenance: { title: 'integration-sidecar' },
  });
  await approveMetadata('integration-alpha', metadataIdentity);
  assert.equal(
    (await metadataStatus('integration-alpha', metadataIdentity)).rows[0]?.state,
    'approved',
  );
  const approvedProjection = await pool.query<{
    identity_key: string;
    display_name: string;
    series_name: string;
  }>(
    `select p.identity_key,p.display_name,s.display_name as series_name from catalog_releases r
     join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
     where r.root_id=$1 and p.identity_key=$2`,
    ['integration-alpha', metadataIdentity],
  );
  assert.deepEqual(approvedProjection.rows[0], {
    identity_key: metadataIdentity,
    display_name: 'Approved provider title',
    series_name: sourceProjection.rows[0]!.series_name,
  });
  await rebuildCatalogProjectionForIntegration();
  assert.equal(
    (
      await pool.query<{ display_name: string }>(
        'select display_name from catalog_publications where identity_key=$1',
        [metadataIdentity],
      )
    ).rows[0]?.display_name,
    'Approved provider title',
  );
  const changedManifestRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(changedManifestRun, 'integration-alpha', [{ ...item, mtimeMs: 1 }]);
  await completeScanRun(changedManifestRun, 'integration-alpha', summary);
  assert.equal(
    (await metadataStatus('integration-alpha', metadataIdentity)).rows[0]?.state,
    'pending_reapproval',
  );
  assert.equal(
    (
      await pool.query<{ display_name: string }>(
        'select display_name from catalog_publications where identity_key=$1',
        [metadataIdentity],
      )
    ).rows[0]?.display_name,
    sourceProjection.rows[0]!.display_name,
  );
  await recordMetadataCandidate('integration-alpha', metadataIdentity, {
    providerId: 'integration-sidecar',
    providerPriority: 0,
    configOrder: 0,
    values: { title: 'Approved provider title' },
    provenance: { title: 'integration-sidecar' },
  });
  await approveMetadata('integration-alpha', metadataIdentity);
  assert.equal(
    (
      await pool.query<{ display_name: string }>(
        'select display_name from catalog_publications where identity_key=$1',
        [metadataIdentity],
      )
    ).rows[0]?.display_name,
    'Approved provider title',
  );

  const orphanIdentity = 'b'.repeat(64);
  await recordMetadataCandidate('integration-alpha', orphanIdentity, {
    providerId: 'orphan-sidecar',
    providerPriority: 0,
    configOrder: 0,
    values: { title: 'Orphan candidate' },
    provenance: { title: 'orphan-sidecar' },
  });
  await rejectMetadata('integration-alpha', orphanIdentity);
  const cleanupRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(cleanupRun, 'integration-alpha', [{ ...item, mtimeMs: 1 }]);
  await completeScanRun(cleanupRun, 'integration-alpha', summary);
  const orphanStatus = (await metadataStatus('integration-alpha', orphanIdentity)).rows[0];
  assert.equal(orphanStatus?.state, 'rejected');
  assert.deepEqual(orphanStatus?.candidates, []);

  const metadataRun = await startScanRun('integration-alpha', generation);
  const metadataItem: ScanItem = {
    ...item,
    comicInfo: {
      document: {
        fields: { title: 'Local title' },
        pageAnnotations: [{ image: 0, type: 'FrontCover' }],
        claimedPageCount: 7,
        sha256: 'a'.repeat(64),
      },
      issues: [{ code: 'test_metadata_warning', rule: 'test-rule' }],
    },
  };
  const cappedMetadataItem: ScanItem = {
    ...item,
    relativePath: 'issue-cap',
    scanIssues: Array.from({ length: 98 }, (_, index) => ({
      code: `test_capped_warning_${index}`,
      rule: 'test-rule',
      detail: 'd'.repeat(300),
    })),
    comicInfo: {
      document: {
        fields: {},
        pageAnnotations: [{ image: 9, type: 'FrontCover' }],
        claimedPageCount: 7,
        sha256: 'b'.repeat(64),
      },
      issues: [],
    },
  };
  const rootLevelDirectoryItem: ScanItem = {
    ...item,
    relativePath: '.',
    displayName: 'library-root-images',
  };
  await persistScanItems(metadataRun, 'integration-alpha', [
    metadataItem,
    cappedMetadataItem,
    rootLevelDirectoryItem,
  ]);
  await completeScanRun(metadataRun, 'integration-alpha', summary);
  const metadataId = (
    await pool.query<{ id: number }>(
      'select id from source_items where root_id=$1 and relative_path=$2',
      ['integration-alpha', 'chapter'],
    )
  ).rows[0]!.id;
  assert.equal(
    (
      await pool.query('select annotation from source_page_annotations where source_item_id=$1', [
        metadataId,
      ])
    ).rowCount,
    1,
  );
  const cappedIssues = await pool.query<{
    count: number;
    longest_detail: number;
    codes: string[];
  }>(
    `select count(*)::int as count, max(length(detail))::int as longest_detail,
       array_agg(code order by code, rule, detail) as codes
     from source_metadata_issues e join source_items i on i.id=e.source_item_id
     where i.root_id=$1 and i.relative_path=$2`,
    ['integration-alpha', 'issue-cap'],
  );
  assert.equal(cappedIssues.rows[0]?.count, 100);
  assert.equal(cappedIssues.rows[0]?.longest_detail, 256);
  assert.equal(cappedIssues.rows[0]?.codes.includes('page_count_mismatch'), true);
  assert.equal(cappedIssues.rows[0]?.codes.includes('page_image_out_of_range'), true);
  const rootLevelMetadata = await pool.query<{ title: string; series: string }>(
    `select m.effective->>'title' as title, m.effective->>'series' as series
     from source_metadata m join source_items i on i.id=m.source_item_id
     where i.root_id=$1 and i.relative_path=$2`,
    ['integration-alpha', '.'],
  );
  assert.deepEqual(rootLevelMetadata.rows[0], {
    title: 'library-root-images',
    series: 'library-root-images',
  });
  const capRepeatRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(capRepeatRun, 'integration-alpha', [
    metadataItem,
    cappedMetadataItem,
    rootLevelDirectoryItem,
  ]);
  await completeScanRun(capRepeatRun, 'integration-alpha', summary);
  const cappedIssuesRepeated = await pool.query<{ codes: string[] }>(
    `select array_agg(code order by code, rule, detail) as codes
     from source_metadata_issues e join source_items i on i.id=e.source_item_id
     where i.root_id=$1 and i.relative_path=$2`,
    ['integration-alpha', 'issue-cap'],
  );
  assert.deepEqual(cappedIssuesRepeated.rows[0]?.codes, cappedIssues.rows[0]?.codes);
  assert.equal(
    (
      await pool.query(
        'select root_id, relative_path, code, detected_at, last_seen_at, retry_state from source_metadata_error_list where root_id=$1 and relative_path=$2 and code=$3',
        ['integration-alpha', 'chapter', 'test_metadata_warning'],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (await pool.query('select * from visible_source_items where id=$1', [metadataId])).rowCount,
    0,
  );
  await setGlobalSourceSuppression(metadataId, 'test');
  assert.equal(
    (await pool.query('select * from visible_source_items where id=$1', [metadataId])).rowCount,
    0,
  );
  const deactivateSuppressedRun = await startScanRun('integration-alpha', generation);
  await completeScanRun(deactivateSuppressedRun, 'integration-alpha', {
    ...summary,
    discovered: 0,
    pages: 0,
  });
  assert.equal(
    (await pool.query('select active from source_items where id=$1', [metadataId])).rows[0]?.active,
    false,
  );
  assert.equal(
    (
      await pool.query('select * from global_source_suppressions where source_item_id=$1', [
        metadataId,
      ])
    ).rowCount,
    1,
  );
  const replacementRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(replacementRun, 'integration-alpha', [item]);
  await completeScanRun(replacementRun, 'integration-alpha', summary);
  assert.equal(
    (await pool.query('select * from visible_source_items where id=$1', [metadataId])).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query('select * from source_page_annotations where source_item_id=$1', [
        metadataId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        `select * from source_metadata_error_list
         where root_id=$1 and relative_path=$2 and code=$3`,
        ['integration-alpha', 'chapter', 'test_metadata_warning'],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        `select * from source_metadata_issues e join source_items i on i.id=e.source_item_id
         where i.root_id=$1 and i.relative_path=$2 and e.code=$3 and e.resolved_at is not null`,
        ['integration-alpha', 'chapter', 'test_metadata_warning'],
      )
    ).rowCount,
    1,
  );
  await clearGlobalSourceSuppression(metadataId);
  assert.equal(
    (await pool.query('select * from visible_source_items where id=$1', [metadataId])).rowCount,
    0,
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

  const inactiveIssueRun = await startScanRun('integration-alpha', generation);
  const inactiveIssueItem: ScanItem = {
    ...item,
    relativePath: 'inactive-issue',
    scanIssues: [{ code: 'inactive_warning', rule: 'test-rule', detail: 'kept in history' }],
  };
  await persistScanItems(inactiveIssueRun, 'integration-alpha', [item, inactiveIssueItem]);
  await completeScanRun(inactiveIssueRun, 'integration-alpha', summary);
  const deactivateInactiveIssueRun = await startScanRun('integration-alpha', generation);
  await persistScanItems(deactivateInactiveIssueRun, 'integration-alpha', [item]);
  await completeScanRun(deactivateInactiveIssueRun, 'integration-alpha', summary);
  assert.equal(
    (
      await pool.query(
        `select * from source_metadata_error_list
         where root_id=$1 and relative_path=$2 and code=$3`,
        ['integration-alpha', 'inactive-issue', 'inactive_warning'],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        `select * from source_metadata_issues e join source_items i on i.id=e.source_item_id
         where i.root_id=$1 and i.relative_path=$2 and e.code=$3 and e.resolved_at is null`,
        ['integration-alpha', 'inactive-issue', 'inactive_warning'],
      )
    ).rowCount,
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
    if (integrationDatabaseVerified) {
      await clearCatalogRoots(ids);
      await pool.query('delete from library_roots where id = any($1::text[])', [ids]);
    }
  } finally {
    await pool.end();
  }
}
