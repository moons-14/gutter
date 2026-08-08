import { serve } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  catalogEntitiesRoute,
  catalogEntityRoute,
  catalogLibrariesRoute,
  catalogPublicationDetailRoute,
  catalogSeriesDetailRoute,
  catalogSeriesRoute,
  healthRoute,
  readinessRoute,
} from '@gutter/api-contract';
import {
  assertSchema,
  catalogEntityDetail,
  catalogPublicationDetail,
  catalogSeriesDetail,
  listCatalogEntities,
  listCatalogLibraries,
  listCatalogSeries,
  pool,
} from '@gutter/db';
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
app.openapi(catalogLibrariesRoute, async (c) =>
  c.json({ items: await listCatalogLibraries(), nextCursor: null }, 200),
);
app.openapi(catalogSeriesRoute, async (c) => {
  const query = c.req.valid('query');
  try {
    const page = await listCatalogSeries(query);
    return c.json({ ...page, libraries: await listCatalogLibraries() }, 200);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_catalog_cursor')
      return c.json({ error: 'invalid_cursor' }, 400);
    throw error;
  }
});
app.openapi(catalogSeriesDetailRoute, async (c) => {
  const item = await catalogSeriesDetail(c.req.valid('param').id);
  return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
});
app.openapi(catalogPublicationDetailRoute, async (c) => {
  const item = await catalogPublicationDetail(c.req.valid('param').id);
  return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
});
for (const [path, kind] of [
  ['/catalog/creators/{id}', 'creator'],
  ['/catalog/groups/{id}', 'group'],
  ['/catalog/publishers/{id}', 'publisher'],
] as const)
  app.openapi(catalogEntityRoute(path), async (c) => {
    const item = await catalogEntityDetail(kind, c.req.valid('param').id);
    return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
  });
for (const [path, kind] of [
  ['/catalog/creators', 'creator'],
  ['/catalog/groups', 'group'],
  ['/catalog/publishers', 'publisher'],
] as const)
  app.openapi(catalogEntitiesRoute(path), async (c) =>
    c.json({ items: await listCatalogEntities(kind, c.req.valid('query')) }, 200),
  );
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
