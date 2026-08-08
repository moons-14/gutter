import assert from 'node:assert/strict';
import {
  claimScanRequestsForDispatch,
  cancelScanRun,
  completeScanRun,
  dueReconciliationRequests,
  failScanRun,
  migrateSchema,
  pool,
  protectSeenPaths,
  protectSeenPrefix,
  recoverStaleScanRequests,
  reconcileLibraryRoots,
  requestRootScan,
  requestScanCancellation,
  startRequestedScan,
} from '../../packages/db/src/index.ts';

if (process.env.GUTTER_INTEGRATION_TEST !== '1') throw new Error('integration sentinel required');
await migrateSchema();
const rootId = 'reconcile-control';
await reconcileLibraryRoots(
  [
    {
      id: rootId,
      configuredPath: '/library',
      canonicalPath: '/library',
      state: 'ready_empty',
      reasonCode: null,
      checkedAt: new Date(),
    },
  ],
  'b'.repeat(64),
);
async function resetRequests(): Promise<void> {
  await pool.query('update source_items set last_seen_run_id=null where root_id=$1', [rootId]);
  await pool.query(
    'update scan_requests set scan_run_id=null where root_id=$1 and scan_run_id is not null',
    [rootId],
  );
  await pool.query(
    'delete from scan_runs where scan_request_id in (select id from scan_requests where root_id=$1)',
    [rootId],
  );
  await pool.query('delete from scan_requests where root_id=$1', [rootId]);
}
async function resetSourceItems(): Promise<void> {
  await pool.query('delete from source_items where root_id=$1', [rootId]);
}
const emptySummary = {
  discovered: 0,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  symlinks: 0,
  mixedParents: 0,
  pages: 0,
  reasons: {},
  metadataIssues: {},
  updated: 0,
  unchanged: 0,
};
async function startRequest(trigger: 'startup' | 'periodic' | 'watcher' | 'manual') {
  const requested = await requestRootScan(rootId, trigger);
  const dispatched = await claimScanRequestsForDispatch();
  const claim = dispatched.find((entry) => entry.id === requested.id);
  assert.ok(claim);
  const run = await startRequestedScan(claim.id, 'b'.repeat(64));
  assert.ok(run);
  return { request: requested, run };
}
await resetRequests();

const concurrent = await Promise.all(
  Array.from({ length: 8 }, () => requestRootScan(rootId, 'periodic')),
);
assert.equal(new Set(concurrent.map((request) => request.id)).size, 1);
const manual = await requestRootScan(rootId, 'manual');
assert.equal(manual.trigger, 'manual');
const dispatched = await claimScanRequestsForDispatch();
const request = dispatched.find((entry) => entry.id === manual.id);
assert.ok(request);
const first = await startRequestedScan(request!.id, 'b'.repeat(64));
const duplicate = await startRequestedScan(request!.id, 'b'.repeat(64));
assert.ok(first);
assert.equal(duplicate, null);
await requestRootScan(rootId, 'watcher');
const retainedManual = await pool.query<{ follow_up_trigger: string | null }>(
  'select follow_up_trigger from scan_requests where id=$1',
  [request!.id],
);
assert.equal(retainedManual.rows[0]?.follow_up_trigger, 'manual');
await requestScanCancellation(request!.id);
await completeScanRun(first!.runId, rootId, {
  discovered: 0,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  symlinks: 0,
  mixedParents: 0,
  pages: 0,
  reasons: {},
  metadataIssues: {},
  updated: 0,
  unchanged: 0,
});
const final = await pool.query<{ state: string }>('select state from scan_requests where id=$1', [
  request!.id,
]);
assert.equal(final.rows[0]?.state, 'cancelled');
const followup = await pool.query<{ state: string }>(
  "select state from scan_requests where root_id=$1 and state='queued'",
  [rootId],
);
assert.equal(followup.rowCount, 1);

await resetRequests();
const staleRequest = await requestRootScan(rootId, 'periodic');
const staleDispatched = await claimScanRequestsForDispatch();
const staleClaim = staleDispatched.find((entry) => entry.id === staleRequest.id);
assert.ok(staleClaim);
const staleRun = await startRequestedScan(staleClaim!.id, 'b'.repeat(64));
assert.ok(staleRun);
await requestRootScan(rootId, 'manual');
await pool.query("update scan_runs set heartbeat_at=now()-interval '3 minutes' where id=$1", [
  staleRun!.runId,
]);
assert.equal(await recoverStaleScanRequests(), 1);
const recovered = await pool.query<{ trigger: string; state: string }>(
  "select trigger,state from scan_requests where root_id=$1 and state='queued'",
  [rootId],
);
assert.deepEqual(recovered.rows, [{ trigger: 'manual', state: 'queued' }]);

await resetRequests();
const startup = await requestRootScan(rootId, 'startup', 900);
const scheduled = await pool.query<{ due: boolean }>(
  "select next_reconcile_at > now()+interval '14 minutes' and next_reconcile_at < now()+interval '16 minutes' as due from library_roots where id=$1",
  [rootId],
);
assert.equal(scheduled.rows[0]?.due, true);
assert.equal(await dueReconciliationRequests(900), 0);
assert.equal(
  (await pool.query('select count(*)::int as count from scan_requests where root_id=$1', [rootId]))
    .rows[0]?.count,
  1,
);
const startupDispatched = await claimScanRequestsForDispatch();
const startupClaim = startupDispatched.find((entry) => entry.id === startup.id);
assert.ok(startupClaim);
const startupRun = await startRequestedScan(startupClaim!.id, 'b'.repeat(64));
assert.ok(startupRun);
await completeScanRun(startupRun!.runId, rootId, {
  discovered: 0,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  symlinks: 0,
  mixedParents: 0,
  pages: 0,
  reasons: {},
  metadataIssues: {},
  updated: 0,
  unchanged: 0,
});
await pool.query(
  "update library_roots set next_reconcile_at=now()-interval '1 second' where id=$1",
  [rootId],
);
assert.equal(await dueReconciliationRequests(900), 1);
const periodic = await pool.query<{ trigger: string; state: string }>(
  "select trigger,state from scan_requests where root_id=$1 and state='queued'",
  [rootId],
);
assert.deepEqual(periodic.rows, [{ trigger: 'periodic', state: 'queued' }]);

await resetRequests();
await resetSourceItems();
await pool.query(
  `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
   values($1,'exact.cbz','cbz',1,1,1,true,$2),($1,'folder/child.cbz','cbz',1,1,1,true,$2),
     ($1,'folder/inactive.cbz','cbz',1,1,1,false,$2),($1,'other.cbz','cbz',1,1,1,true,$2)`,
  [rootId, 'a'.repeat(64)],
);
const protectedRun = await startRequest('manual');
await protectSeenPaths(protectedRun.run.runId, rootId, ['exact.cbz']);
await protectSeenPrefix(protectedRun.run.runId, rootId, 'folder');
await completeScanRun(protectedRun.run.runId, rootId, emptySummary);
const protectedState = await pool.query<{ relative_path: string; active: boolean }>(
  'select relative_path,active from source_items where root_id=$1 order by relative_path',
  [rootId],
);
assert.deepEqual(protectedState.rows, [
  { relative_path: 'exact.cbz', active: true },
  { relative_path: 'folder/child.cbz', active: true },
  { relative_path: 'folder/inactive.cbz', active: false },
  { relative_path: 'other.cbz', active: false },
]);

await resetRequests();
await resetSourceItems();
await pool.query(
  `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
   values($1,'prior.cbz','cbz',1,1,1,true,$2)`,
  [rootId, 'b'.repeat(64)],
);
const failedRun = await startRequest('periodic');
await failScanRun(failedRun.run.runId, emptySummary);
const failedState = await pool.query<{ active: boolean }>(
  "select active from source_items where root_id=$1 and relative_path='prior.cbz'",
  [rootId],
);
assert.equal(failedState.rows[0]?.active, true);
const failedRequest = await pool.query<{ request: string; run: string }>(
  `select r.state as request,s.state as run from scan_requests r join scan_runs s on s.id=r.scan_run_id
   where r.id=$1`,
  [failedRun.request.id],
);
assert.deepEqual(failedRequest.rows, [{ request: 'failed', run: 'failed' }]);

await resetRequests();
const cancelledRun = await startRequest('periodic');
await cancelScanRun(cancelledRun.run.runId, emptySummary);
const cancelledState = await pool.query<{ active: boolean }>(
  "select active from source_items where root_id=$1 and relative_path='prior.cbz'",
  [rootId],
);
assert.equal(cancelledState.rows[0]?.active, true);
const cancelledRequest = await pool.query<{ request: string; run: string }>(
  `select r.state as request,s.state as run from scan_requests r join scan_runs s on s.id=r.scan_run_id
   where r.id=$1`,
  [cancelledRun.request.id],
);
assert.deepEqual(cancelledRequest.rows, [{ request: 'cancelled', run: 'cancelled' }]);
await pool.end();
