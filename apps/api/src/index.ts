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
  canAccessLibrary,
  changeLibraryAccess,
  libraryAccessScope,
  listCatalogEntities,
  listCatalogLibraries,
  listCatalogSeries,
  pool,
  readerRootForRequestPath,
  type LibraryAccessScope,
} from '@gutter/db';
import { readerCapabilitySecret } from '@gutter/config';
import { signReaderCapability } from '@gutter/reader-stream';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import pino from 'pino';
import { reconciliationMetricLabels } from './metrics.js';
import { authenticatedUser, authHandler, trustedMutationOrigin } from './auth.js';

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
const readerCapabilityKey = await readerCapabilitySecret();

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
app.post('/api/auth/bootstrap', async (c) => {
  const client = await pool.connect();
  try {
    // This session lock fences CLI recovery from an in-flight bootstrap request.
    await client.query("select pg_advisory_lock(hashtext('gutter_auth_bootstrap'))");
    const claim = await client.query(
      'update gutter_auth_bootstrap set claimed_at=now() where id=true and claimed_at is null returning id',
    );
    if (claim.rowCount !== 1) return c.json({ error: 'bootstrap_unavailable' }, 403);
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      await client.query('update gutter_auth_bootstrap set claimed_at=null where id=true');
      return c.json({ error: 'invalid_bootstrap_request' }, 400);
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-gutter-bootstrap', '1');
    const request = new Request(new URL('/api/auth/sign-up/email', c.req.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const response = await authHandler(request);
    if (!response.ok)
      await client.query('update gutter_auth_bootstrap set claimed_at=null where id=true');
    return response;
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('gutter_auth_bootstrap'))")
      .catch(() => undefined);
    client.release();
  }
});
app.all('/api/auth/sign-up/email', (c) => c.json({ error: 'public_signup_disabled' }, 403));
app.all('/api/auth/*', (c) => authHandler(c.req.raw));
app.all('/api/reader/*', async (c) => {
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.body(null, 404);
  const user = await authenticatedUser(c.req.raw);
  if (!user) return c.json({ error: 'not_found' }, 404);
  const scope = await libraryAccessScope(user.id);
  const pathname = new URL(c.req.url).pathname;
  const rootId = await readerRootForRequestPath(pathname);
  if (!rootId || !canAccessLibrary(scope, rootId)) return c.json({ error: 'not_found' }, 404);
  const headers = new Headers();
  for (const name of ['range', 'if-none-match', 'if-modified-since']) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    'x-gutter-reader-capability',
    signReaderCapability(readerCapabilityKey, {
      userId: user.id,
      rootId,
      path: pathname,
      aclRevision: scope.revision,
    }),
  );
  const upstream = await fetch(`http://worker:3001${pathname}`, {
    method: c.req.method,
    headers,
    signal: c.req.raw.signal,
  });
  const responseHeaders = new Headers();
  for (const name of [
    'accept-ranges',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
});
const requestAccess = new WeakMap<Request, LibraryAccessScope>();
app.use('/catalog/*', async (c, next) => {
  const user = await authenticatedUser(c.req.raw);
  if (!user) return c.json({ error: 'authentication_required' }, 401);
  requestAccess.set(c.req.raw, await libraryAccessScope(user.id));
  await next();
});
for (const [method, action] of [
  ['put', 'grant'],
  ['delete', 'revoke'],
] as const)
  app[method]('/admin/library-access/:userId/:rootId', async (c) => {
    if (!trustedMutationOrigin(c.req.raw)) return c.json({ error: 'invalid_origin' }, 403);
    const actor = await authenticatedUser(c.req.raw);
    if (!actor) return c.json({ error: 'authentication_required' }, 401);
    if (actor.role !== 'admin') return c.json({ error: 'not_found' }, 404);
    try {
      const revision = await changeLibraryAccess(
        actor.id,
        c.req.param('userId'),
        c.req.param('rootId'),
        action,
        c.req.header('x-request-id') ?? crypto.randomUUID(),
      );
      return c.json({ revision }, 200);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === '23503')
        return c.json({ error: 'not_found' }, 404);
      throw error;
    }
  });
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
  c.json(
    { items: await listCatalogLibraries(requestAccess.get(c.req.raw)!), nextCursor: null },
    200,
  ),
);
app.openapi(catalogSeriesRoute, async (c) => {
  const query = c.req.valid('query');
  try {
    const scope = requestAccess.get(c.req.raw)!;
    const page = await listCatalogSeries(query, scope);
    return c.json({ ...page, libraries: await listCatalogLibraries(scope) }, 200);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_catalog_cursor')
      return c.json({ error: 'invalid_cursor' }, 400);
    throw error;
  }
});
app.openapi(catalogSeriesDetailRoute, async (c) => {
  const item = await catalogSeriesDetail(c.req.valid('param').id, requestAccess.get(c.req.raw)!);
  return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
});
app.openapi(catalogPublicationDetailRoute, async (c) => {
  const item = await catalogPublicationDetail(
    c.req.valid('param').id,
    requestAccess.get(c.req.raw)!,
  );
  return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
});
for (const [path, kind] of [
  ['/catalog/creators/{id}', 'creator'],
  ['/catalog/groups/{id}', 'group'],
  ['/catalog/publishers/{id}', 'publisher'],
] as const)
  app.openapi(catalogEntityRoute(path), async (c) => {
    const item = await catalogEntityDetail(
      kind,
      c.req.valid('param').id,
      requestAccess.get(c.req.raw)!,
    );
    return item ? c.json(item, 200) : c.json({ error: 'not_found' }, 404);
  });
for (const [path, kind] of [
  ['/catalog/creators', 'creator'],
  ['/catalog/groups', 'group'],
  ['/catalog/publishers', 'publisher'],
] as const)
  app.openapi(catalogEntitiesRoute(path), async (c) =>
    c.json(
      {
        items: await listCatalogEntities(kind, requestAccess.get(c.req.raw)!, c.req.valid('query')),
      },
      200,
    ),
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
