import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  claimValidationIntents,
  completeScanRun,
  completeValidationIntent,
  migrateSchema,
  persistScanItems,
  pool,
  reconcileLibraryRoots,
  releaseValidationIntent,
  renewValidationLease,
  startScanRun,
} from '../../packages/db/src/index.ts';
import type { ScanItem, ScanSummary } from '../../packages/discovery-scanner/src/index.ts';

if (
  process.env.GUTTER_INTEGRATION_TEST !== '1' ||
  new URL(process.env.DATABASE_URL!).pathname !== '/gutter_integration'
)
  throw new Error('page-validation integration requires the sentinel integration database');

const rootId = `page-validation-${randomUUID()}`;
const generation = 'b'.repeat(64);
const summary: ScanSummary = {
  discovered: 1,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  symlinks: 0,
  mixedParents: 0,
  pages: 1,
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
  pages: [{ locator: '1.png', observed: { size: 1, mtimeNs: '0' } }],
  quarantinedReason: null,
};

try {
  await migrateSchema();
  await reconcileLibraryRoots(
    [
      {
        id: rootId,
        configuredPath: '/fixture',
        canonicalPath: '/fixture',
        state: 'ready_empty',
        reasonCode: null,
        checkedAt: new Date(),
      },
    ],
    generation,
  );
  const firstRun = await startScanRun(rootId, generation);
  assert.deepEqual(await persistScanItems(firstRun, rootId, [item]), { updated: 1, unchanged: 0 });
  await completeScanRun(firstRun, rootId, summary);
  const [oldLease] = await claimValidationIntents();
  assert.ok(oldLease);
  assert.equal(await renewValidationLease(oldLease), true);
  await pool.query(
    "update validation_intents set lease_expires_at=now()-interval '1 second' where source_item_id=$1",
    [oldLease.sourceItemId],
  );
  const [newLease] = await claimValidationIntents();
  assert.ok(newLease && newLease.leaseEpoch > oldLease.leaseEpoch);
  assert.equal(await renewValidationLease(oldLease), false);
  await releaseValidationIntent(oldLease);
  assert.equal(await renewValidationLease(newLease), true);
  assert.equal(
    await completeValidationIntent(oldLease, {
      candidateCount: 1,
      validCount: 1,
      skippedCount: 0,
      bytesRead: 1,
      durationMs: 1,
      results: [
        { locator: '1.png', state: 'valid', format: 'png', width: 1, height: 1, bytesRead: 1 },
      ],
    }),
    false,
  );
  assert.equal(
    await completeValidationIntent(newLease, {
      candidateCount: 1,
      validCount: 0,
      skippedCount: 1,
      bytesRead: 1,
      durationMs: 1,
      results: [{ locator: '1.png', state: 'skipped', reasonCode: 'decode_failed', bytesRead: 1 }],
    }),
    true,
  );
  assert.equal(
    (
      await pool.query('select count(*)::int as count from visible_source_items where root_id=$1', [
        rootId,
      ])
    ).rows[0]?.count,
    0,
  );

  // A repeated authoritative full scan only updates its source observation.  Catalog projection
  // rows (including their refresh timestamp) remain byte-for-byte stable when the source inputs
  // and visibility did not change.
  const catalogSnapshotSql = `select (select json_agg(x order by x.id) from (
       select id::text,publication_id::text,source_item_id::text,
         to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
       from catalog_releases where root_id=$1) x) as releases,
       (select json_agg(x order by x.release_id,x.entity_id,x.role) from (
         select release_id::text,entity_id::text,role from catalog_credits
         where release_id in (select id from catalog_releases where root_id=$1)) x) as credits,
       (select json_agg(x order by x.series_id) from (
         select series_id::text,visible_publication_count,
           to_char(refreshed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as refreshed_at
         from catalog_series_list_state where library_id=$1) x) as list_state`;
  const catalogBefore = await pool.query(catalogSnapshotSql, [rootId]);
  const secondRun = await startScanRun(rootId, generation);
  assert.deepEqual(await persistScanItems(secondRun, rootId, [item]), { updated: 0, unchanged: 1 });
  await completeScanRun(secondRun, rootId, summary);
  const catalogAfter = await pool.query(catalogSnapshotSql, [rootId]);
  assert.deepEqual(catalogAfter.rows, catalogBefore.rows);

  // Quarantine changes catalog visibility without changing the source manifest.  It must refresh
  // only the owning catalog projection and never enqueue/restart page validation.
  const toggled: ScanItem = { ...item, relativePath: 'quarantine-toggle' };
  const toggleStart = await startScanRun(rootId, generation);
  await persistScanItems(toggleStart, rootId, [item, toggled]);
  await completeScanRun(toggleStart, rootId, { ...summary, discovered: 2, pages: 2 });
  const toggleId = (
    await pool.query<{ id: string }>(
      "select id from source_items where root_id=$1 and relative_path='quarantine-toggle'",
      [rootId],
    )
  ).rows[0]!.id;
  assert.equal(
    (
      await pool.query(
        "select visible_publication_count from catalog_series_list_state where library_id=$1 and display_name='quarantine-toggle'",
        [rootId],
      )
    ).rows[0]?.visible_publication_count,
    1,
  );
  const quarantineRun = await startScanRun(rootId, generation);
  assert.deepEqual(
    await persistScanItems(quarantineRun, rootId, [
      item,
      { ...toggled, quarantinedReason: 'zero_supported_pages' },
    ]),
    { updated: 0, unchanged: 2 },
  );
  await completeScanRun(quarantineRun, rootId, { ...summary, discovered: 2, pages: 2 });
  assert.equal(
    (
      await pool.query(
        "select visible_publication_count from catalog_series_list_state where library_id=$1 and display_name='quarantine-toggle'",
        [rootId],
      )
    ).rows[0]?.visible_publication_count,
    0,
  );
  assert.deepEqual(
    (
      await pool.query(
        'select validation_generation::text as generation,count(*)::int as intents from source_items i left join validation_intents v on v.source_item_id=i.id where i.id=$1 group by i.validation_generation',
        [toggleId],
      )
    ).rows[0],
    { generation: '1', intents: 1 },
  );
  const restoreRun = await startScanRun(rootId, generation);
  assert.deepEqual(await persistScanItems(restoreRun, rootId, [item, toggled]), {
    updated: 0,
    unchanged: 2,
  });
  await completeScanRun(restoreRun, rootId, { ...summary, discovered: 2, pages: 2 });
  assert.equal(
    (
      await pool.query(
        "select visible_publication_count from catalog_series_list_state where library_id=$1 and display_name='quarantine-toggle'",
        [rootId],
      )
    ).rows[0]?.visible_publication_count,
    1,
  );
  const thirdRun = await startScanRun(rootId, generation);
  await persistScanItems(thirdRun, rootId, [{ ...item, mtimeMs: 1 }]);
  await completeScanRun(thirdRun, rootId, summary);
  const catalogChanged = await pool.query(catalogSnapshotSql, [rootId]);
  assert.notDeepEqual(catalogChanged.rows, catalogBefore.rows);
  const fourthRun = await startScanRun(rootId, generation);
  await persistScanItems(fourthRun, rootId, [item]);
  await completeScanRun(fourthRun, rootId, summary);
  // The M manifest recurs at generation 3. Its generation-1 skipped result is historical and
  // must neither hide the item nor skip its page while generation 3 is pending.
  assert.equal(
    (
      await pool.query('select count(*)::int as count from visible_source_items where root_id=$1', [
        rootId,
      ])
    ).rows[0]?.count,
    1,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from reader_eligible_source_pages p join source_items i on i.id=p.source_item_id where i.root_id=$1',
        [rootId],
      )
    ).rows[0]?.count,
    1,
  );
  const currentLease = (await claimValidationIntents()).find(
    (entry) => entry.sourceItemId === oldLease.sourceItemId,
  );
  assert.ok(currentLease && currentLease.generation === 3);
  assert.equal(await renewValidationLease(currentLease), true);
  assert.equal(
    await completeValidationIntent(currentLease, {
      candidateCount: 1,
      validCount: 1,
      skippedCount: 0,
      bytesRead: 1,
      durationMs: 1,
      results: [
        { locator: '1.png', state: 'valid', format: 'png', width: 1, height: 1, bytesRead: 1 },
      ],
    }),
    true,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from reader_eligible_source_pages p join source_items i on i.id=p.source_item_id where i.root_id=$1',
        [rootId],
      )
    ).rows[0]?.count,
    1,
  );

  const failing: ScanItem = { ...item, relativePath: 'failing', mtimeMs: 7 };
  const failureRun = await startScanRun(rootId, generation);
  await persistScanItems(failureRun, rootId, [item, failing]);
  await completeScanRun(failureRun, rootId, { ...summary, discovered: 2, pages: 2 });
  let terminalLease = (await claimValidationIntents()).find(
    (entry) => entry.sourceItemId !== oldLease.sourceItemId,
  );
  assert.ok(terminalLease);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await renewValidationLease(terminalLease), true);
    await releaseValidationIntent(terminalLease, 'root_unavailable');
    if (attempt < 4) {
      await pool.query(
        'update validation_intents set next_attempt_at=now() where source_item_id=$1',
        [terminalLease.sourceItemId],
      );
      terminalLease = (await claimValidationIntents()).find(
        (entry) => entry.sourceItemId === terminalLease.sourceItemId,
      );
      assert.ok(terminalLease);
    }
  }
  assert.deepEqual(
    (
      await pool.query(
        `select state, candidate_count, valid_count, skipped_count, bytes_read, duration_ms,
                summary->>'failureCode' as failure_code
         from page_validation_runs where source_item_id=$1 and state='failed' order by id desc limit 1`,
        [terminalLease.sourceItemId],
      )
    ).rows[0],
    {
      state: 'failed',
      candidate_count: 0,
      valid_count: 0,
      skipped_count: 0,
      bytes_read: '0',
      duration_ms: '0',
      failure_code: 'root_unavailable',
    },
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from page_validation_results where source_item_id=$1',
        [terminalLease.sourceItemId],
      )
    ).rows[0]?.count,
    0,
  );
  // Inputs outside the fixed failure-code vocabulary never reach durable state verbatim.
  assert.equal(
    (await import('../../packages/db/src/index.ts')).validationFailureCode(
      'sensitive exception detail',
    ),
    'validation_infrastructure_failure',
  );
  const disappearing: ScanItem = { ...item, relativePath: 'disappearing', mtimeMs: 7 };
  const disappearanceRun = await startScanRun(rootId, generation);
  await persistScanItems(disappearanceRun, rootId, [disappearing]);
  await completeScanRun(disappearanceRun, rootId, summary);
  const oldRunning = (await claimValidationIntents()).find(
    (entry) => entry.sourceItemId !== oldLease.sourceItemId,
  );
  assert.ok(oldRunning);
  assert.equal(await renewValidationLease(oldRunning), true);
  const deactivateRun = await startScanRun(rootId, generation);
  await persistScanItems(deactivateRun, rootId, []);
  await completeScanRun(deactivateRun, rootId, { ...summary, discovered: 0, pages: 0 });
  assert.equal(
    (
      await pool.query(
        `select visible_publication_count from catalog_series_list_state
       where library_id=$1 and display_name='disappearing'`,
        [rootId],
      )
    ).rows[0]?.visible_publication_count,
    0,
  );
  assert.equal(
    (
      await pool.query(
        'select count(*)::int as count from validation_intents where source_item_id=$1',
        [oldRunning.sourceItemId],
      )
    ).rows[0]?.count,
    0,
  );
  await releaseValidationIntent(oldRunning, 'stale_after_deactivation');
  assert.equal(
    await completeValidationIntent(oldRunning, {
      candidateCount: 1,
      validCount: 1,
      skippedCount: 0,
      bytesRead: 1,
      durationMs: 1,
      results: [
        { locator: '1.png', state: 'valid', format: 'png', width: 1, height: 1, bytesRead: 1 },
      ],
    }),
    false,
  );
  const reactivateRun = await startScanRun(rootId, generation);
  assert.deepEqual(await persistScanItems(reactivateRun, rootId, [disappearing]), {
    updated: 1,
    unchanged: 0,
  });
  await completeScanRun(reactivateRun, rootId, summary);
  const fresh = (await claimValidationIntents()).find(
    (entry) => entry.sourceItemId === oldRunning.sourceItemId,
  );
  assert.ok(fresh && fresh.generation > oldRunning.generation);
  process.stdout.write('page-validation integration passed\n');
} finally {
  await pool.end();
}
