import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  catalogEntitiesRoute,
  catalogEntityRoute,
  catalogLibrariesRoute,
  catalogPublicationDetailRoute,
  catalogSeriesDetailRoute,
  catalogSeriesRoute,
  healthRoute,
  adminUsersRoute,
  adminUserStateDeleteRoute,
  readinessRoute,
  userStateBookmarkDeleteRoute,
  userStateBookmarkPostRoute,
  userStateBookmarksRoute,
  userStateCollectionDeleteRoute,
  userStateCollectionMemberDeleteRoute,
  userStateCollectionMemberPutRoute,
  userStateCollectionMembersRoute,
  userStateCollectionPostRoute,
  userStateCollectionsRoute,
  userStateProgressGetRoute,
  userStateProgressPutRoute,
  userStateTargetPutRoute,
  userStateTargetsRoute,
} from '@gutter/api-contract';
import {
  assertSchema,
  catalogEntityDetail,
  catalogPublicationDetail,
  catalogSeriesDetail,
  canAccessLibrary,
  changeLibraryAccess,
  listAdminUsers,
  addUserBookmark,
  createUserCollection,
  deleteUserBookmark,
  deleteUserCollection,
  exportUserState,
  getUserProgress,
  getUserResume,
  resolveUserProgressKey,
  readerProgressKey,
  listUserCollections,
  listUserCollectionMembers,
  listUserBookmarks,
  listUserTargetState,
  isReaderPathVisible,
  authorizeUserStateResource,
  authorizeUserCollection,
  libraryAccessScope,
  listCatalogEntities,
  listCatalogLibraries,
  listCatalogSeries,
  permanentlyDeleteUser,
  pool,
  putUserProgress,
  readerRootForRequestPath,
  setUserCollectionMembership,
  setUserTargetState,
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
export function adminUserDirectoryLogFields(
  requestId: string | undefined,
  filtered: boolean,
  resultCount: number,
) {
  return {
    requestId,
    action: 'admin_user_directory_read' as const,
    admin: true as const,
    filtered,
    resultCount: Math.max(0, Math.min(100, resultCount)),
  };
}
const metrics = new Registry();
collectDefaultMetrics({ register: metrics });
const reconciliationRequests = new Gauge({
  name: 'gutter_reconciliation_requests',
  help: 'Durable reconciliation requests by bounded trigger and state.',
  labelNames: ['trigger', 'state'],
  registers: [metrics],
});
const queueLagSeconds = new Gauge({
  name: 'gutter_queue_lag_seconds',
  help: 'Age in seconds of the oldest queued scan request (zero when empty).',
  registers: [metrics],
});
const scanRuns = new Gauge({
  name: 'gutter_scan_runs',
  help: 'Historical scan runs by bounded state.',
  labelNames: ['state'],
  registers: [metrics],
});
const databaseSizeBytes = new Gauge({
  name: 'gutter_database_size_bytes',
  help: 'PostgreSQL database size in bytes.',
  registers: [metrics],
});
export type ApiDeps = Readonly<{
  authenticatedUser?: typeof authenticatedUser;
  trustedMutationOrigin?: typeof trustedMutationOrigin;
  authHandler?: typeof authHandler;
  authorizeUserStateResource?: typeof authorizeUserStateResource;
  authorizeUserCollection?: typeof authorizeUserCollection;
  getUserProgress?: typeof getUserProgress;
  getUserResume?: typeof getUserResume;
  resolveUserProgressKey?: typeof resolveUserProgressKey;
  listUserCollections?: typeof listUserCollections;
  listUserCollectionMembers?: typeof listUserCollectionMembers;
  listUserBookmarks?: typeof listUserBookmarks;
  listUserTargetState?: typeof listUserTargetState;
  isReaderPathVisible?: typeof isReaderPathVisible;
  putUserProgress?: typeof putUserProgress;
  setUserTargetState?: typeof setUserTargetState;
  addUserBookmark?: typeof addUserBookmark;
  deleteUserBookmark?: typeof deleteUserBookmark;
  createUserCollection?: typeof createUserCollection;
  deleteUserCollection?: typeof deleteUserCollection;
  setUserCollectionMembership?: typeof setUserCollectionMembership;
  exportUserState?: typeof exportUserState;
  permanentlyDeleteUser?: typeof permanentlyDeleteUser;
  changeLibraryAccess?: typeof changeLibraryAccess;
  listAdminUsers?: typeof listAdminUsers;
  readerCapabilityKey?: string;
}>;
export const productionDeps: Required<ApiDeps> = {
  authenticatedUser,
  trustedMutationOrigin,
  authHandler,
  authorizeUserStateResource,
  getUserProgress,
  getUserResume,
  resolveUserProgressKey,
  listUserCollections,
  listUserCollectionMembers,
  listUserBookmarks,
  listUserTargetState,
  isReaderPathVisible,
  putUserProgress,
  setUserTargetState,
  authorizeUserCollection,
  addUserBookmark,
  deleteUserBookmark,
  createUserCollection,
  deleteUserCollection,
  setUserCollectionMembership,
  exportUserState,
  permanentlyDeleteUser,
  changeLibraryAccess,
  listAdminUsers,
  readerCapabilityKey: '',
};
/** Build a fresh application. Importing this module has no schema/serve side effects. */
export function createApp(deps: ApiDeps = productionDeps): OpenAPIHono {
  const resolved = { ...productionDeps, ...deps };
  const {
    authenticatedUser,
    trustedMutationOrigin,
    authHandler,
    authorizeUserStateResource,
    getUserProgress,
    getUserResume,
    resolveUserProgressKey,
    listUserCollections,
    listUserCollectionMembers,
    listUserBookmarks,
    listUserTargetState,
    isReaderPathVisible,
    putUserProgress,
    setUserTargetState,
    authorizeUserCollection,
    addUserBookmark,
    deleteUserBookmark,
    createUserCollection,
    deleteUserCollection,
    setUserCollectionMembership,
    exportUserState,
    permanentlyDeleteUser,
    changeLibraryAccess,
    listAdminUsers,
  } = resolved;
  const app = new OpenAPIHono();
  const readerKey = resolved.readerCapabilityKey || null;

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
  app.openapi(adminUsersRoute, async (c) => {
    const actor = await authenticatedUser(c.req.raw);
    if (!actor) return c.json({ error: 'authentication_required' as const }, 401);
    if (actor.role !== 'admin') return c.json({ error: 'not_found' as const }, 404);
    const parsed = c.req.valid('query');
    const q = parsed.q?.trim() ?? '';
    if (q.length > 256) return c.json({ error: 'invalid_request' as const }, 400);
    try {
      const result = await listAdminUsers({ q, limit: parsed.limit, cursor: parsed.cursor });
      log.info(
        adminUserDirectoryLogFields(c.req.header('x-request-id'), Boolean(q), result.items.length),
        'admin directory read',
      );
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_cursor')
        return c.json({ error: 'invalid_cursor' as const }, 400);
      throw error;
    }
  });
  app.openapi(healthRoute, (c) => c.json({ status: 'ok' }, 200));
  app.post('/api/auth/bootstrap', async (c) => {
    if (!trustedMutationOrigin(c.req.raw)) return c.json({ error: 'invalid_origin' as const }, 403);
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
    if (
      !rootId ||
      !canAccessLibrary(scope, rootId) ||
      !(await isReaderPathVisible(user.id, pathname))
    )
      return c.json({ error: 'not_found' }, 404);
    const headers = new Headers();
    for (const name of ['range', 'if-none-match', 'if-modified-since']) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set(
      'x-gutter-reader-capability',
      signReaderCapability(readerKey ?? (await readerCapabilitySecret()), {
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
  const userStateUser = async (request: Request) => authenticatedUser(request);
  const userStateBody = async (c: any): Promise<Record<string, unknown> | null> => {
    const body = await c.req.json().catch(() => null);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  };
  const hasOnlyKeys = (body: Record<string, unknown> | null, allowed: readonly string[]): boolean =>
    body === null || Object.keys(body).every((key) => allowed.includes(key));
  const userStateError = (c: any, error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (message === 'invalid_pagination_cursor') return c.json({ error: 'invalid_cursor' }, 400);
    if (message.startsWith('invalid_')) return c.json({ error: message }, 400);
    if (message === 'user_not_found') return c.json({ error: 'not_found' }, 404);
    throw error;
  };
  const targetKinds = new Set(['check', 'series', 'publication', 'source']);
  const validTargetKind = (
    value: unknown,
  ): value is 'check' | 'series' | 'publication' | 'source' =>
    typeof value === 'string' && targetKinds.has(value);
  const publicProgress = (progress: any) => {
    if (!progress) return null;
    const { sourceKey, userId: _userId, ...safe } = progress;
    return {
      ...safe,
      progressKey:
        sourceKey && progress.rootId ? readerProgressKey(progress.rootId, sourceKey) : undefined,
    };
  };
  const publicUserStatePage = (page: {
    items: readonly Record<string, unknown>[];
    nextCursor: string | null;
  }) => ({
    items: page.items.map((item) => {
      const {
        sourceKey: _sourceKey,
        relativePath: _relativePath,
        sourceItemId: _sourceItemId,
        ...safe
      } = item;
      return safe;
    }),
    nextCursor: page.nextCursor,
  });
  app.use('/user-state/*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) && !trustedMutationOrigin(c.req.raw))
      return c.json({ error: 'invalid_origin' }, 403);
    if (!(await userStateUser(c.req.raw))) return c.json({ error: 'authentication_required' }, 401);
    await next();
  });
  app.get('/user-state/export', async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    return c.json(await exportUserState(user.id), 200);
  });
  app.get('/user-state/resume', async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const raw = c.req.query('limit');
    const limit = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json({ error: 'invalid_resume_limit' }, 400);
    return c.json({ items: await getUserResume(user.id, limit) }, 200);
  });
  const readPage = (c: any) => {
    const limit = Number(c.req.query('limit') ?? 30);
    const cursor = c.req.query('cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return { error: 'invalid_pagination' as const };
    return { limit, cursor };
  };
  app.openapi(userStateCollectionsRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      page = readPage(c);
    if ('error' in page) return c.json(page, 400);
    try {
      return c.json(
        publicUserStatePage(await listUserCollections(user.id, page.limit, page.cursor)),
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateCollectionMembersRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      id = Number(c.req.param('id')),
      page = readPage(c);
    if (!Number.isSafeInteger(id) || id < 1 || 'error' in page)
      return c.json({ error: 'invalid_pagination' }, 400);
    try {
      const result = await listUserCollectionMembers(user.id, id, page.limit, page.cursor);
      return result
        ? c.json(publicUserStatePage(result), 200)
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateBookmarksRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      page = readPage(c);
    if ('error' in page) return c.json(page, 400);
    try {
      return c.json(
        publicUserStatePage(await listUserBookmarks(user.id, page.limit, page.cursor)),
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateTargetsRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      page = readPage(c);
    if ('error' in page) return c.json(page, 400);
    try {
      return c.json(
        publicUserStatePage(await listUserTargetState(user.id, page.limit, page.cursor)),
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateProgressGetRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const rootId = c.req.query('rootId');
    const progressKey = c.req.query('progressKey');
    if (!rootId || !progressKey) return c.json({ error: 'invalid_user_progress_request' }, 400);
    const sourceKey = await resolveUserProgressKey(user.id, rootId, progressKey);
    if (!sourceKey || !(await authorizeUserStateResource(user.id, rootId, 'progress', sourceKey)))
      return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(
        { progress: publicProgress(await getUserProgress(user.id, rootId, sourceKey)) },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateProgressPutRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const body = await userStateBody(c);
    if (
      !body ||
      !hasOnlyKeys(body, [
        'rootId',
        'progressKey',
        'expectedRevision',
        'pageOrdinal',
        'completed',
      ]) ||
      typeof body.rootId !== 'string' ||
      typeof body.progressKey !== 'string' ||
      typeof body.expectedRevision !== 'number' ||
      typeof body.pageOrdinal !== 'number' ||
      typeof body.completed !== 'boolean'
    )
      return c.json({ error: 'invalid_user_progress_request' }, 400);
    const sourceKey = await resolveUserProgressKey(user.id, body.rootId, body.progressKey);
    if (
      !sourceKey ||
      !(await authorizeUserStateResource(user.id, body.rootId, 'progress', sourceKey))
    )
      return c.json({ error: 'not_found' }, 404);
    try {
      const result = await putUserProgress(user.id, body.rootId, sourceKey, body.expectedRevision, {
        pageOrdinal: body.pageOrdinal,
        completed: body.completed,
      });
      return result.ok
        ? c.json({ progress: publicProgress(result.current) }, 200)
        : c.json({ error: 'progress_conflict', progress: publicProgress(result.current) }, 409);
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateTargetPutRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const body = await userStateBody(c);
    if (
      !body ||
      !hasOnlyKeys(body, [
        'rootId',
        'targetKind',
        'targetKey',
        'favorite',
        'hidden',
        'rating',
        'note',
      ]) ||
      typeof body.rootId !== 'string' ||
      !validTargetKind(body.targetKind) ||
      typeof body.targetKey !== 'string'
    )
      return c.json({ error: 'invalid_user_target_request' }, 400);
    for (const key of ['favorite', 'hidden'] as const)
      if (key in body && typeof body[key] !== 'boolean')
        return c.json({ error: 'invalid_user_target_state' }, 400);
    if ('rating' in body && body.rating !== null && typeof body.rating !== 'number')
      return c.json({ error: 'invalid_user_target_state' }, 400);
    if ('note' in body && body.note !== null && typeof body.note !== 'string')
      return c.json({ error: 'invalid_user_target_state' }, 400);
    try {
      const { rootId, targetKind, targetKey, ...value } = body;
      const includeHidden = value.hidden === false;
      const resolvedTargetKey =
        targetKind === 'source' || targetKind === 'check'
          ? await resolveUserProgressKey(user.id, rootId as string, targetKey as string, {
              includeHidden,
            })
          : (targetKey as string);
      if (
        !resolvedTargetKey ||
        !(await authorizeUserStateResource(
          user.id,
          rootId as string,
          targetKind as any,
          resolvedTargetKey,
          { includeHidden },
        ))
      )
        return c.json({ error: 'not_found' }, 404);
      return c.json(
        {
          changed: await setUserTargetState(
            user.id,
            rootId,
            targetKind as any,
            resolvedTargetKey,
            value as any,
          ),
        },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateBookmarkPostRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const body = await userStateBody(c);
    if (
      !body ||
      !hasOnlyKeys(body, ['rootId', 'progressKey', 'pageOrdinal', 'label']) ||
      typeof body.rootId !== 'string' ||
      typeof body.progressKey !== 'string' ||
      typeof body.pageOrdinal !== 'number' ||
      ('label' in body && body.label !== null && typeof body.label !== 'string')
    )
      return c.json({ error: 'invalid_bookmark_request' }, 400);
    const sourceKey = await resolveUserProgressKey(user.id, body.rootId, body.progressKey);
    if (
      !sourceKey ||
      !(await authorizeUserStateResource(user.id, body.rootId, 'progress', sourceKey))
    )
      return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(
        {
          changed: await addUserBookmark(
            user.id,
            body.rootId,
            sourceKey,
            body.pageOrdinal,
            typeof body.label === 'string' ? body.label : null,
          ),
        },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateBookmarkDeleteRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!;
    const rootId = c.req.query('rootId'),
      progressKey = c.req.query('progressKey'),
      ordinal = Number(c.req.query('pageOrdinal'));
    if (!rootId || !progressKey || !Number.isInteger(ordinal))
      return c.json({ error: 'invalid_bookmark_request' }, 400);
    const sourceKey = await resolveUserProgressKey(user.id, rootId, progressKey);
    if (!sourceKey || !(await authorizeUserStateResource(user.id, rootId, 'progress', sourceKey)))
      return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(
        { changed: await deleteUserBookmark(user.id, rootId, sourceKey, ordinal) },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateCollectionPostRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      body = await userStateBody(c);
    if (!body || !hasOnlyKeys(body, ['name']) || typeof body.name !== 'string')
      return c.json({ error: 'invalid_collection_name' }, 400);
    try {
      return c.json({ collection: await createUserCollection(user.id, body.name) }, 201);
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateCollectionDeleteRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      id = Number(c.req.param('id'));
    const body = await userStateBody(c);
    if (!hasOnlyKeys(body, [])) return c.json({ error: 'invalid_collection_request' }, 400);
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: 'invalid_collection_id' }, 400);
    if (!(await authorizeUserCollection(user.id, id))) return c.json({ error: 'not_found' }, 404);
    return c.json({ changed: await deleteUserCollection(user.id, id) }, 200);
  });
  app.openapi(userStateCollectionMemberPutRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      id = Number(c.req.param('id')),
      body = await userStateBody(c);
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !body ||
      !hasOnlyKeys(body, ['rootId', 'targetKind', 'targetKey', 'member']) ||
      typeof body.rootId !== 'string' ||
      !validTargetKind(body.targetKind) ||
      typeof body.targetKey !== 'string' ||
      typeof body.member !== 'boolean'
    )
      return c.json({ error: 'invalid_collection_member_request' }, 400);
    if (!(await authorizeUserCollection(user.id, id))) return c.json({ error: 'not_found' }, 404);
    const resolvedTargetKey =
      body.targetKind === 'source' || body.targetKind === 'check'
        ? await resolveUserProgressKey(user.id, body.rootId, body.targetKey)
        : body.targetKey;
    if (
      !resolvedTargetKey ||
      !(await authorizeUserStateResource(user.id, body.rootId, body.targetKind, resolvedTargetKey))
    )
      return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(
        {
          changed: await setUserCollectionMembership(
            user.id,
            id,
            body.rootId,
            body.targetKind,
            resolvedTargetKey,
            body.member,
          ),
        },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
  });
  app.openapi(userStateCollectionMemberDeleteRoute, async (c) => {
    const user = (await userStateUser(c.req.raw))!,
      id = Number(c.req.param('id')),
      body = await userStateBody(c);
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !body ||
      !hasOnlyKeys(body, ['rootId', 'targetKind', 'targetKey']) ||
      typeof body.rootId !== 'string' ||
      !validTargetKind(body.targetKind) ||
      typeof body.targetKey !== 'string'
    )
      return c.json({ error: 'invalid_collection_member_request' }, 400);
    if (!(await authorizeUserCollection(user.id, id))) return c.json({ error: 'not_found' }, 404);
    const resolvedTargetKey =
      body.targetKind === 'source' || body.targetKind === 'check'
        ? await resolveUserProgressKey(user.id, body.rootId, body.targetKey)
        : body.targetKey;
    if (
      !resolvedTargetKey ||
      !(await authorizeUserStateResource(user.id, body.rootId, body.targetKind, resolvedTargetKey))
    )
      return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(
        {
          changed: await setUserCollectionMembership(
            user.id,
            id,
            body.rootId,
            body.targetKind,
            resolvedTargetKey,
            false,
          ),
        },
        200,
      );
    } catch (error) {
      return userStateError(c, error);
    }
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
  app.openapi(adminUserStateDeleteRoute, async (c) => {
    if (!trustedMutationOrigin(c.req.raw)) return c.json({ error: 'invalid_origin' as const }, 403);
    const actor = await authenticatedUser(c.req.raw);
    if (!actor) return c.json({ error: 'authentication_required' as const }, 401);
    if (actor.role !== 'admin') return c.json({ error: 'not_found' as const }, 404);
    const body = await userStateBody(c);
    if (!body || !hasOnlyKeys(body, [])) return c.json({ error: 'invalid_request' as const }, 400);
    const suppliedRequestId = c.req.header('x-request-id');
    if (suppliedRequestId && !/^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId))
      return c.json({ error: 'invalid_request' as const }, 400);
    try {
      return c.json(
        {
          deleted: await permanentlyDeleteUser(
            actor.id,
            c.req.param('id'),
            suppliedRequestId ?? crypto.randomUUID(),
          ),
        },
        200,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'admin_required')
        return c.json({ error: 'not_found' as const }, 404);
      if (error instanceof Error && error.message === 'user_not_found')
        return c.json({ error: 'not_found' as const }, 404);
      if (error instanceof Error && error.message === 'self_deletion_forbidden')
        return c.json({ error: 'invalid_request' as const }, 400);
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
          items: await listCatalogEntities(
            kind,
            requestAccess.get(c.req.raw)!,
            c.req.valid('query'),
          ),
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
    const lag = await pool.query<{ seconds: string | null }>(
      "select extract(epoch from (now() - min(created_at)))::text as seconds from scan_requests where state='queued'",
    );
    queueLagSeconds.set(Math.max(0, Number(lag.rows[0]?.seconds ?? 0)));
    const runs = await pool.query<{ state: string; count: string }>(
      "select state,count(*) from scan_runs where state in ('running','completed','failed','cancelled') group by state",
    );
    scanRuns.reset();
    for (const row of runs.rows) scanRuns.set({ state: row.state }, Number(row.count));
    const size = await pool.query<{ bytes: string }>(
      'select pg_database_size(current_database())::text as bytes',
    );
    databaseSizeBytes.set(Number(size.rows[0]?.bytes ?? 0));
    return c.text(await metrics.metrics(), 200, { 'content-type': metrics.contentType });
  });
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'gutter internal API', version: '0.0.0' },
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
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
}
