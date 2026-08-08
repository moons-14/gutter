import { allowedRootsJson, databaseUrl } from '@gutter/config';
import {
  assertSchema,
  completeScanRun,
  cancelScanRun,
  failScanRun,
  persistScanItems,
  pool,
  reconcileLibraryRoots,
  startScanRun,
} from '@gutter/db';
import { scanRoot } from '@gutter/discovery-scanner';
import { parseAllowedRoots, validateLibraryRoots } from '@gutter/library-roots';
import { PgBoss } from 'pg-boss';
import pino from 'pino';
import { enqueueDiscovery, startDiscoveryQueue } from './discovery-queue.js';

const log = pino({ redact: ['*.password', '*.token'] });
await assertSchema();
const rootConfig = parseAllowedRoots(allowedRootsJson());
const rootSnapshots = await validateLibraryRoots(rootConfig.roots);
await reconcileLibraryRoots(rootSnapshots, rootConfig.generation);
const boss = new PgBoss({ connectionString: await databaseUrl() });
await boss.start();
const readyRoots = new Map(
  rootSnapshots
    .filter(
      (root): root is typeof root & { canonicalPath: string } =>
        root.state.startsWith('ready_') && root.canonicalPath !== null,
    )
    .map((root) => [root.id, root]),
);
const shutdown = new AbortController();
await startDiscoveryQueue({
  boss,
  readyRoots,
  configGeneration: rootConfig.generation,
  signal: shutdown.signal,
  scanRoot,
  startScanRun,
  persistScanItems,
  completeScanRun,
  failScanRun,
  cancelScanRun,
  log,
});
for (const root of readyRoots.values())
  await enqueueDiscovery(boss, root.id, rootConfig.generation);
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
