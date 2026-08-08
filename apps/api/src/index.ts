import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { healthRoute, readinessRoute } from '@gutter/api-contract';
import { assertSchema, pool } from '@gutter/db';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import pino from 'pino';
import { reconciliationMetricLabels } from './metrics.js';

const log = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
});
const metrics = new Registry();
collectDefaultMetrics({ register: metrics });
const reconciliationRequests = new Gauge({
  name: 'gutter_reconciliation_requests',
  help: 'Durable reconciliation requests by bounded trigger and state.',
  labelNames: ['trigger', 'state'],
  registers: [metrics],
});
const app = new OpenAPIHono();

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.header('x-request-id', requestId);
  const started = performance.now();
  await next();
  log.info(
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: performance.now() - started,
    },
    'request',
  );
});
app.openapi(healthRoute, (c) => c.json({ status: 'ok' }, 200));
app.openapi(readinessRoute, async (c) => {
  try {
    await assertSchema();
    return c.json({ status: 'ready' }, 200);
  } catch (error) {
    log.warn({ err: error }, 'readiness failed');
    return c.json({ status: 'not-ready' }, 503);
  }
});
app.get('/metrics', async (c) => {
  const rows = await pool.query<{ trigger: string; state: string; count: string }>(
    'select trigger,state,count(*) from scan_requests group by trigger,state',
  );
  reconciliationRequests.reset();
  for (const row of rows.rows) {
    const labels = reconciliationMetricLabels(row.trigger, row.state);
    if (labels) reconciliationRequests.set(labels, Number(row.count));
  }
  return c.text(await metrics.metrics(), 200, { 'content-type': metrics.contentType });
});
app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'gutter internal API', version: '0.0.0' },
});

try {
  await assertSchema();
} catch (error) {
  log.fatal({ err: error }, 'API startup schema check failed');
  await pool.end();
  process.exit(1);
}
const server = serve(
  { fetch: app.fetch, port: Number(process.env.PORT ?? 3000), hostname: '0.0.0.0' },
  () => log.info('api started'),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    }),
  );
