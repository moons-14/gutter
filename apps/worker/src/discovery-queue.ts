import type { LibraryRootSnapshot } from '@gutter/library-roots';
import type { ScanItem, ScanSummary } from '@gutter/discovery-scanner';
import { PgBoss, type Job } from 'pg-boss';

export { PgBoss } from 'pg-boss';

export const discoveryQueueName = 'catalog.discovery.v1';
export type DiscoveryJob = Readonly<{ rootId: string; observedGeneration?: string }>;
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
  persistScanItems: (runId: number, rootId: string, items: readonly ScanItem[]) => Promise<void>;
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
        await deps.persistScanItems(runId, root.id, scanned.items);
        await deps.completeScanRun(runId, root.id, scanned.summary);
        deps.log.info({ rootId: root.id, summary: scanned.summary }, 'discovery scan completed');
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
