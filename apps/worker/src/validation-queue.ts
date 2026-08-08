import type { ValidationFailureCode, ValidationIntent } from '@gutter/db';
import type { ScanItem, ScanPage } from '@gutter/discovery-scanner';
import { ValidationAttemptError } from '@gutter/page-validator';
import { PgBoss, type Job } from 'pg-boss';

export const validationQueueName = 'catalog.page-validation.v1';
export type ValidationJob = Readonly<{
  sourceItemId: number;
  manifestSha256: string;
  generation: number;
  leaseEpoch: number;
}>;

type Source = Readonly<{
  rootId: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  size: number;
  mtimeMs: number;
  pages: ScanPage[];
}>;
type Summary = Readonly<{
  candidateCount: number;
  validCount: number;
  skippedCount: number;
  bytesRead: number;
  results: readonly {
    locator: string;
    state: 'valid' | 'skipped';
    reasonCode?: string;
    format?: string;
    width?: number;
    height?: number;
    bytesRead: number;
  }[];
}>;

export async function startValidationQueue(deps: {
  boss: PgBoss;
  readyRoots: ReadonlyMap<string, { canonicalPath: string }>;
  getSource: (intent: ValidationIntent) => Promise<Source | null>;
  renew: (intent: ValidationIntent) => Promise<boolean>;
  release: (intent: ValidationIntent, failureCode?: ValidationFailureCode) => Promise<void>;
  complete: (
    intent: ValidationIntent,
    summary: Summary & { durationMs: number },
  ) => Promise<boolean>;
  validate: (root: string, item: ScanItem, signal: AbortSignal) => Promise<Summary>;
  signal: AbortSignal;
  itemTimeoutMs?: number;
  /** Test-only seam; production always renews at the fixed two-minute cadence. */
  heartbeatMs?: number;
}): Promise<void> {
  await deps.boss.createQueue(validationQueueName, {
    policy: 'exclusive',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 21_600,
    heartbeatSeconds: 60,
  });
  await deps.boss.work<ValidationJob>(
    validationQueueName,
    { localConcurrency: 1 },
    async (jobs: Job<ValidationJob>[]) => {
      const job = jobs[0];
      if (!job) return;
      const intent: ValidationIntent = job.data;
      if (!(await deps.renew(intent))) return;
      const source = await deps.getSource(intent);
      const root = source && deps.readyRoots.get(source.rootId);
      if (!source || !root) {
        await deps.release(intent, source ? 'root_unavailable' : 'source_manifest_changed');
        return;
      }
      const started = performance.now();
      const timeout = AbortSignal.timeout(deps.itemTimeoutMs ?? 900_000);
      const leaseLost = new AbortController();
      const signal = AbortSignal.any([deps.signal, timeout, leaseLost.signal]);
      // A failed renewal fences this worker immediately. Completion/release are epoch-guarded,
      // but aborting also stops source I/O instead of allowing a stale decoder to keep reading.
      let heartbeatBusy = false;
      const heartbeat = setInterval(() => {
        if (heartbeatBusy || leaseLost.signal.aborted) return;
        heartbeatBusy = true;
        void deps
          .renew(intent)
          .then((owned) => {
            if (!owned) leaseLost.abort(new DOMException('validation lease lost', 'AbortError'));
          })
          .catch(() => leaseLost.abort(new DOMException('validation lease lost', 'AbortError')))
          .finally(() => {
            heartbeatBusy = false;
          });
      }, deps.heartbeatMs ?? 120_000);
      try {
        const summary = await deps.validate(
          root.canonicalPath,
          { ...source, pages: source.pages, quarantinedReason: null },
          signal,
        );
        if (
          !(await deps.complete(intent, {
            ...summary,
            durationMs: Math.round(performance.now() - started),
          }))
        )
          return;
      } catch (error) {
        await deps.release(
          intent,
          classifyValidationFailure(error, { timeout, leaseLost, signal: deps.signal }),
        );
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    },
  );
}

/** Maps every queue failure to a durable, bounded operator-facing code. */
export function classifyValidationFailure(
  error: unknown,
  signals: Readonly<{ timeout: AbortSignal; leaseLost: AbortController; signal: AbortSignal }>,
): ValidationFailureCode {
  if (signals.signal.aborted) return 'validation_cancelled';
  if (signals.timeout.aborted) return 'validation_timeout';
  if (signals.leaseLost.signal.aborted) return 'lease_lost';
  // The validator can be loaded through a workspace source path in tests and through its package
  // export in the worker, so use its explicit stable name as well as the class identity.
  const validationAttempt =
    error instanceof ValidationAttemptError ||
    (error instanceof Error && error.name === 'ValidationAttemptError');
  if (validationAttempt && /^(root_unavailable|root_or_page_unavailable)$/.test(error.message))
    return 'root_unavailable';
  if (validationAttempt && /source_manifest|archive_page_unavailable/.test(error.message))
    return 'source_manifest_changed';
  return 'validation_infrastructure_failure';
}

/** Dispatch is idempotent; durable pending leases are recovered by claimValidationIntents after crashes. */
export async function dispatchValidationIntents(
  boss: PgBoss,
  claim: (limit?: number) => Promise<ValidationIntent[]>,
): Promise<void> {
  for (const intent of await claim())
    await boss.send(validationQueueName, intent, {
      singletonKey: `${intent.sourceItemId}:${intent.generation}`,
    });
}
