import { allowedRootsJson, databaseUrl } from '@gutter/config';
import { assertSchema, pool, reconcileLibraryRoots } from '@gutter/db';
import { parseAllowedRoots, validateLibraryRoots } from '@gutter/library-roots';
import { PgBoss } from 'pg-boss';
import pino from 'pino';

const log = pino({ redact: ['*.password', '*.token'] });
await assertSchema();
const rootConfig = parseAllowedRoots(allowedRootsJson());
const rootSnapshots = await validateLibraryRoots(rootConfig.roots);
await reconcileLibraryRoots(rootSnapshots, rootConfig.generation);
const boss = new PgBoss({
  connectionString: await databaseUrl(),
});
await boss.start();
log.info(
  { libraryRoots: rootSnapshots.length, configGeneration: rootConfig.generation },
  'worker started; no M0 jobs registered',
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    log.info({ signal }, 'worker stopping');
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
