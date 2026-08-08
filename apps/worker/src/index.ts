import { databaseUrl } from '@gutter/config';
import { assertSchema, pool } from '@gutter/db';
import { PgBoss } from 'pg-boss';
import pino from 'pino';

const log = pino({ redact: ['*.password', '*.token'] });
await assertSchema();
const boss = new PgBoss({
  connectionString: await databaseUrl(),
});
await boss.start();
log.info('worker started; no M0 jobs registered');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    log.info({ signal }, 'worker stopping');
    await boss.stop();
    await pool.end();
    process.exit(0);
  });
