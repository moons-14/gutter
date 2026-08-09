import {
  allowedRootsJson,
  databaseUrl,
  reconciliationConfig,
  validationTimeouts,
  watcherHintsConfig,
} from '@gutter/config';
import {
  assertSchema,
  completeScanRun,
  cancelScanRun,
  claimValidationIntents,
  completeValidationIntent,
  claimScanRequestsForDispatch,
  dueReconciliationRequests,
  heartbeatScanRun,
  isScanCancellationRequested,
  failScanRun,
  persistScanItems,
  protectSeenPaths,
  protectSeenPrefix,
  pool,
  getValidationSource,
  getAuthorizedReaderPage,
  releaseValidationIntent,
  reconcileLibraryRoots,
  renewValidationLease,
  startRequestedScan,
  requestRootScan,
  recoverStaleScanRequests,
  requeueDispatchedScanRequest,
} from '@gutter/db';
import { scanRootBatched } from '@gutter/discovery-scanner';
import { parseAllowedRoots, validateLibraryRoots } from '@gutter/library-roots';
import { PgBoss } from 'pg-boss';
import pino from 'pino';
import { dispatchReconciliationRequests, startReconciliationQueue } from './discovery-queue.js';
import { validateSourceItem } from '@gutter/page-validator';
import { dispatchValidationIntents, startValidationQueue } from './validation-queue.js';
import { startWatcherHints } from './watcher-hints.js';
import { startReaderHttpServer } from './reader-http.js';

const log = pino({ redact: ['*.password', '*.token'] });
await assertSchema();
const rootConfig = parseAllowedRoots(allowedRootsJson());
const rootSnapshots = await validateLibraryRoots(rootConfig.roots);
await reconcileLibraryRoots(rootSnapshots, rootConfig.generation);
const boss = new PgBoss({ connectionString: await databaseUrl() });
await boss.start();
await recoverStaleScanRequests();
const readyRoots = new Map(
  rootSnapshots
    .filter(
      (root): root is typeof root & { canonicalPath: string } =>
        root.state.startsWith('ready_') && root.canonicalPath !== null,
    )
    .map((root) => [root.id, root]),
);
const shutdown = new AbortController();
const readerServer = startReaderHttpServer({
  roots: readyRoots,
  authorize: getAuthorizedReaderPage,
  shutdownSignal: shutdown.signal,
});
const reconciliation = reconciliationConfig();
const watcherHints = watcherHintsConfig();
await startReconciliationQueue({
  boss,
  readyRoots,
  configGeneration: rootConfig.generation,
  signal: shutdown.signal,
  scanRootBatched,
  claimRequest: startRequestedScan,
  persist: persistScanItems,
  complete: completeScanRun,
  fail: failScanRun,
  cancel: cancelScanRun,
  heartbeat: heartbeatScanRun,
  cancelled: isScanCancellationRequested,
  protect: protectSeenPaths,
  protectPrefix: protectSeenPrefix,
  stableGraceMs: reconciliation.stableGraceMs,
  log,
});
await startValidationQueue({
  boss,
  readyRoots,
  getSource: getValidationSource,
  renew: renewValidationLease,
  release: releaseValidationIntent,
  complete: completeValidationIntent,
  validate: validateSourceItem,
  signal: shutdown.signal,
  itemTimeoutMs: validationTimeouts().itemMs,
});
await dispatchValidationIntents(boss, claimValidationIntents);
const validationDispatcher = setInterval(
  () => void dispatchValidationIntents(boss, claimValidationIntents),
  30_000,
);
for (const root of readyRoots.values())
  await requestRootScan(root.id, 'startup', reconciliation.intervalSeconds);
await dispatchReconciliationRequests(
  boss,
  claimScanRequestsForDispatch,
  requeueDispatchedScanRequest,
);
const watcher = startWatcherHints({
  roots: readyRoots,
  enabled: watcherHints.enabled,
  debounceMs: watcherHints.debounceMs,
  request: async (rootId) => {
    await requestRootScan(rootId, 'watcher');
  },
  log,
});
const reconciliationCoordinator = setInterval(() => {
  void recoverStaleScanRequests()
    .then(() => dueReconciliationRequests(reconciliation.intervalSeconds))
    .then(() =>
      dispatchReconciliationRequests(
        boss,
        claimScanRequestsForDispatch,
        requeueDispatchedScanRequest,
      ),
    )
    .catch((error) =>
      log.error(
        { code: (error as NodeJS.ErrnoException).code ?? 'RECONCILE_FAILED' },
        'reconciliation coordinator failed',
      ),
    );
}, 30_000);
log.info(
  { libraryRoots: rootSnapshots.length, configGeneration: rootConfig.generation },
  'worker started; discovery jobs queued',
);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker stopping');
    shutdown.abort();
    clearInterval(validationDispatcher);
    clearInterval(reconciliationCoordinator);
    await new Promise<void>((resolve, reject) =>
      readerServer.close((error) => (error ? reject(error) : resolve())),
    );
    await watcher.close();
    try {
      await boss.stop();
      await pool.end();
    } catch (error) {
      log.error(
        { code: (error as NodeJS.ErrnoException).code ?? 'SHUTDOWN_FAILED' },
        'worker stop failed',
      );
      process.exitCode = 1;
    }
  });
