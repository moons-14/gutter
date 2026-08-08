import type { LibraryRootSnapshot } from '@gutter/library-roots';
import type { BatchedScanOptions, ScanItem, ScanSummary } from '@gutter/discovery-scanner';
import { PgBoss, type Job } from 'pg-boss';

export { PgBoss } from 'pg-boss';

export const discoveryQueueName = 'catalog.discovery.v1';
export const reconciliationQueueName = 'catalog.reconciliation.v1';
export type DiscoveryJob = Readonly<{ rootId: string; observedGeneration?: string }>;
export type ReconciliationJob = Readonly<{ requestId: string }>;
type ReadyRoot = LibraryRootSnapshot & { canonicalPath: string };

export type DiscoveryQueueDependencies = Readonly<{
  boss: PgBoss;
  queueName?: string;
  readyRoots: ReadonlyMap<string, ReadyRoot>;
  configGeneration: string;
  signal: AbortSignal;
  scanRoot: (
    root: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly ScanItem[]; summary: ScanSummary }>;
  startScanRun: (rootId: string, generation: string) => Promise<number>;
  persistScanItems: (
    runId: number,
    rootId: string,
    items: readonly ScanItem[],
  ) => Promise<{ updated: number; unchanged: number }>;
  completeScanRun: (runId: number, rootId: string, summary: ScanSummary) => Promise<void>;
  failScanRun: (runId: number, summary: ScanSummary) => Promise<void>;
  cancelScanRun: (runId: number, summary: ScanSummary) => Promise<void>;
  log: {
    info: (data: object, message: string) => void;
    error: (data: object, message: string) => void;
  };
  retryDelay?: number;
}>;

const failedSummary = (): ScanSummary => ({
  discovered: 0,
  skipped: 0,
  quarantined: 0,
  failed: 1,
  symlinks: 0,
  mixedParents: 0,
  pages: 0,
  reasons: {},
  metadataIssues: {},
  updated: 0,
  unchanged: 0,
});

function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

/**
 * Queue payloads deliberately identify only a configured root. The ready-root map is immutable for
 * this worker process; rolling configuration changes require a worker rollout and are outside M1.
 */
export async function startDiscoveryQueue(deps: DiscoveryQueueDependencies): Promise<void> {
  const queueName = deps.queueName ?? discoveryQueueName;
  await deps.boss.createQueue(queueName, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: deps.retryDelay ?? 60,
    retryBackoff: true,
    expireInSeconds: 21_600,
    retentionSeconds: 21_600,
    deleteAfterSeconds: 86_400,
    heartbeatSeconds: 60,
  });
  await deps.boss.work<DiscoveryJob>(
    queueName,
    { localConcurrency: 1 },
    async (jobs: Job<DiscoveryJob>[]) => {
      const job = jobs[0];
      if (!job) return;
      const root = deps.readyRoots.get(job.data.rootId);
      if (!root) {
        deps.log.info({ rootId: job.data.rootId }, 'discovery job root unavailable; skipped');
        return;
      }
      if (job.data.observedGeneration && job.data.observedGeneration !== deps.configGeneration)
        deps.log.info(
          { rootId: root.id, observedGeneration: job.data.observedGeneration },
          'discovery job rebound to current root snapshot',
        );

      const runId = await deps.startScanRun(root.id, deps.configGeneration);
      try {
        const scanned = await deps.scanRoot(root.canonicalPath, deps.signal);
        const outcome = await deps.persistScanItems(runId, root.id, scanned.items);
        const summary = { ...scanned.summary, ...outcome };
        await deps.completeScanRun(runId, root.id, summary);
        deps.log.info({ rootId: root.id, summary }, 'discovery scan completed');
      } catch (error) {
        const operation = aborted(error, deps.signal) ? deps.cancelScanRun : deps.failScanRun;
        try {
          await operation(runId, failedSummary());
        } catch (markError) {
          deps.log.error(
            {
              rootId: root.id,
              code: (markError as NodeJS.ErrnoException).code ?? 'RUN_MARK_FAILED',
            },
            'discovery scan run state could not be recorded',
          );
        }
        deps.log.error(
          { rootId: root.id, code: (error as NodeJS.ErrnoException).code ?? 'SCAN_FAILED' },
          aborted(error, deps.signal) ? 'discovery scan cancelled' : 'discovery scan failed',
        );
        throw error;
      }
    },
  );
}

export async function enqueueDiscovery(
  boss: PgBoss,
  rootId: string,
  observedGeneration: string,
  queueName = discoveryQueueName,
): Promise<string | null> {
  return boss.send(queueName, { rootId, observedGeneration }, { singletonKey: rootId });
}

/**
 * Request IDs, rather than paths or root configuration, cross the queue boundary. The database
 * claim is the authority, so duplicate pg-boss delivery and dispatch crash windows are benign.
 */
export async function startReconciliationQueue(
  deps: Readonly<{
    boss: PgBoss;
    readyRoots: ReadonlyMap<string, ReadyRoot>;
    configGeneration: string;
    signal: AbortSignal;
    claimRequest: (
      requestId: string,
      generation: string,
      jobId?: string,
    ) => Promise<{ runId: number; rootId: string } | null>;
    scanRootBatched: (
      root: string,
      options: BatchedScanOptions,
    ) => Promise<{ items: readonly ScanItem[]; summary: ScanSummary }>;
    persist: (
      runId: number,
      rootId: string,
      items: readonly ScanItem[],
    ) => Promise<{ updated: number; unchanged: number }>;
    complete: (runId: number, rootId: string, summary: ScanSummary) => Promise<void>;
    fail: (runId: number, summary: ScanSummary) => Promise<void>;
    cancel: (runId: number, summary: ScanSummary) => Promise<void>;
    heartbeat?: (runId: number, progress: Record<string, number>) => Promise<boolean>;
    cancelled?: (runId: number) => Promise<boolean>;
    protect?: (runId: number, rootId: string, paths: readonly string[]) => Promise<void>;
    protectPrefix?: (runId: number, rootId: string, prefix: string) => Promise<void>;
    stableGraceMs?: number;
    log: DiscoveryQueueDependencies['log'];
  }>,
): Promise<void> {
  await deps.boss.createQueue(reconciliationQueueName, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 21_600,
    retentionSeconds: 21_600,
    deleteAfterSeconds: 86_400,
    heartbeatSeconds: 60,
  });
  await deps.boss.work<ReconciliationJob>(
    reconciliationQueueName,
    { localConcurrency: 1 },
    async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      const claimed = await deps.claimRequest(job.data.requestId, deps.configGeneration, job.id);
      if (!claimed) return;
      const root = deps.readyRoots.get(claimed.rootId);
      if (!root) {
        await deps.fail(claimed.runId, failedSummary());
        return;
      }
      try {
        const lease = new AbortController();
        const relayAbort = () => lease.abort(deps.signal.reason);
        deps.signal.addEventListener('abort', relayAbort, { once: true });
        let outcome = { updated: 0, unchanged: 0 };
        const progress = () => ({
          discovered: outcome.updated + outcome.unchanged,
          updated: outcome.updated,
          unchanged: outcome.unchanged,
        });
        const pulse = async () => {
          if (lease.signal.aborted) throw new DOMException('scan lease lost', 'AbortError');
          if (await deps.cancelled?.(claimed.runId)) {
            lease.abort(new DOMException('scan cancelled', 'AbortError'));
            throw new DOMException('scan cancelled', 'AbortError');
          }
          if (deps.heartbeat && !(await deps.heartbeat(claimed.runId, progress()))) {
            lease.abort(new DOMException('scan ownership lost', 'AbortError'));
            throw new DOMException('scan ownership lost', 'AbortError');
          }
        };
        let heartbeatBusy = false;
        const heartbeat = setInterval(() => {
          if (heartbeatBusy || lease.signal.aborted) return;
          heartbeatBusy = true;
          void pulse()
            .catch(() => undefined)
            .finally(() => {
              heartbeatBusy = false;
            });
        }, 30_000);
        let result: { items: readonly ScanItem[]; summary: ScanSummary };
        try {
          await pulse();
          result = await deps.scanRootBatched(root.canonicalPath, {
            signal: lease.signal,
            stableGraceMs: deps.stableGraceMs,
            collect: false,
            pulse,
            onItems: async (items) => {
              await pulse();
              const batch = await deps.persist(claimed.runId, root.id, items);
              outcome = {
                updated: outcome.updated + batch.updated,
                unchanged: outcome.unchanged + batch.unchanged,
              };
              await pulse();
            },
            onProtected: async (paths) => deps.protect?.(claimed.runId, root.id, paths),
            onProtectedPrefix: async (prefix) =>
              deps.protectPrefix?.(claimed.runId, root.id, prefix),
          });
        } finally {
          clearInterval(heartbeat);
          deps.signal.removeEventListener('abort', relayAbort);
        }
        await deps.complete(claimed.runId, root.id, { ...result.summary, ...outcome });
      } catch (error) {
        await (aborted(error, deps.signal) ? deps.cancel : deps.fail)(
          claimed.runId,
          failedSummary(),
        );
        throw error;
      }
    },
  );
}

export async function dispatchReconciliationRequests(
  boss: PgBoss,
  claim: (limit?: number) => Promise<readonly { id: string }[]>,
  requeue?: (id: string) => Promise<void>,
): Promise<number> {
  const requests = await claim();
  let sent = 0;
  for (const [index, request] of requests.entries())
    try {
      await boss.send(
        reconciliationQueueName,
        { requestId: request.id },
        { singletonKey: request.id },
      );
      sent += 1;
    } catch (error) {
      await Promise.all(requests.slice(index).map((unsent) => requeue?.(unsent.id)));
      throw error;
    }
  return sent;
}
