import { serve } from '@hono/node-server';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
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
  getReaderPublicationSession,
  getReaderPublicationSessionByIdentity,
  resolvePublicProgressTarget,
  resolvePublicTarget,
  publicCollectionKey,
  resolvePublicCollectionId,
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
import {
  authenticatePublicApiToken,
  createPublicApiToken,
  listPublicApiTokens,
  revokePublicApiToken,
  publicApiScopes,
  defaultPublicApiScopes,
  type PublicApiScope,
} from './public-pat.js';

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
type PublicPrincipal = Readonly<{
  id: string;
  role: string | null;
  patScopes: readonly PublicApiScope[] | null;
  patId: string | null;
}>;
const PUBLIC_BODY_BYTES = 256 * 1024;
const PUBLIC_MAX_PROPERTIES = 16;
const PUBLIC_MAX_QUERY_BYTES = 8192;
const PUBLIC_MAX_QUERY_PARAMETERS = 16;
const PUBLIC_MAX_CURSOR_BYTES = 4096;
const PUBLIC_TIMEOUT_MS = 10_000;
const PUBLIC_RATE_LIMIT = 60;
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const publicRateBuckets = new Map<string, number[]>();
const publicSeriesId = (value: unknown): string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? value
    : createHash('sha256')
        .update(`series\u0000${String(value)}`)
        .digest('hex');
let publicRateLastCleanup = 0;
const publicRateAllowed = (key: string, now = Date.now()): { ok: boolean; retryAfter: number } => {
  if (now - publicRateLastCleanup >= PUBLIC_RATE_WINDOW_MS) {
    publicRateLastCleanup = now;
    for (const [bucketKey, timestamps] of publicRateBuckets) {
      const recent = timestamps.filter((timestamp) => timestamp > now - PUBLIC_RATE_WINDOW_MS);
      if (recent.length) publicRateBuckets.set(bucketKey, recent);
      else publicRateBuckets.delete(bucketKey);
    }
    while (publicRateBuckets.size > 4096) {
      const oldest = publicRateBuckets.keys().next().value;
      if (oldest === undefined) break;
      publicRateBuckets.delete(oldest);
    }
  }
  const timestamps = (publicRateBuckets.get(key) ?? []).filter(
    (timestamp) => timestamp > now - PUBLIC_RATE_WINDOW_MS,
  );
  if (timestamps.length >= PUBLIC_RATE_LIMIT) {
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((timestamps[0] + PUBLIC_RATE_WINDOW_MS - now) / 1000)),
    };
  }
  timestamps.push(now);
  publicRateBuckets.set(key, timestamps);
  return { ok: true, retryAfter: 0 };
};
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
  getReaderPublicationSessionByIdentity?: typeof getReaderPublicationSessionByIdentity;
  resolvePublicProgressTarget?: typeof resolvePublicProgressTarget;
  resolvePublicTarget?: typeof resolvePublicTarget;
  resolvePublicCollectionId?: typeof resolvePublicCollectionId;
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
  getReaderPublicationSessionByIdentity,
  resolvePublicProgressTarget,
  resolvePublicTarget,
  resolvePublicCollectionId,
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
    getReaderPublicationSessionByIdentity,
    resolvePublicProgressTarget,
    resolvePublicTarget,
    resolvePublicCollectionId,
  } = resolved;
  const publicCursorSecret = async () =>
    resolved.readerCapabilityKey || (await readerCapabilitySecret());
  const encodePublicCursor = async (principal: PublicPrincipal, path: string, internal: string) => {
    const key = createHash('sha256')
      .update(await publicCursorSecret())
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload = JSON.stringify({
      v: 1,
      user: principal.id,
      path,
      exp: Date.now() + PUBLIC_CURSOR_TTL_MS,
      internal,
    });
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  };
  const decodePublicCursor = async (principal: PublicPrincipal, path: string, value: string) => {
    try {
      const raw = Buffer.from(value, 'base64url');
      if (raw.length < 29) throw new Error();
      const key = createHash('sha256')
        .update(await publicCursorSecret())
        .digest();
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const payload = JSON.parse(
        Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'),
      ) as Record<string, unknown>;
      if (
        payload.v !== 1 ||
        payload.user !== principal.id ||
        payload.path !== path ||
        typeof payload.internal !== 'string' ||
        typeof payload.exp !== 'number' ||
        payload.exp < Date.now()
      )
        throw new Error();
      return payload.internal;
    } catch {
      throw new Error('invalid_public_cursor');
    }
  };
  const app = new OpenAPIHono();
  // Delegated public requests must retain the already-authenticated principal. A new Request
  // object is required for the internal alias, so a private in-process map carries authority
  // without trusting spoofable client headers.
  const delegatedPrincipals = new WeakMap<Request, PublicPrincipal | null>();
  const requestPrincipal = async (
    request: Request,
    allowBearer = false,
  ): Promise<PublicPrincipal | null> => {
    const delegated = delegatedPrincipals.get(request);
    if (delegated !== undefined) return delegated;
    const authorization = request.headers.get('authorization')?.trim();
    if (authorization) {
      // Direct internal routes can only use the browser session. A public bearer is accepted
      // exclusively by the versioned adapter and then carried in the delegated context.
      if (/^Bearer\s+gtr_pat_v1_[A-Za-z0-9_-]+$/i.test(authorization)) {
        if (!allowBearer) return null;
        const pat = await authenticatePublicApiToken(authorization.replace(/^Bearer\s+/i, ''));
        return pat
          ? { id: pat.userId, role: null, patScopes: pat.scopes, patId: pat.tokenId }
          : null;
      }
      // Better Auth owns cookie/session authentication. Non-PAT authorization headers are
      // ignored by production Better Auth, while retaining deterministic injected test sessions.
      if (allowBearer) return null;
    }
    const session = await authenticatedUser(request);
    return session ? { ...session, patScopes: null, patId: null } : null;
  };
  const publicError = (
    c: any,
    error: string,
    status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 429 | 500 | 503 | 504,
  ) =>
    c.json(
      {
        error,
        // The request-id middleware synthesizes an id for requests that did not provide one.
        // Read the response context so validation/auth failures carry that same stable id.
        requestId: c.res.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? '',
      },
      status,
    );
  const publicClientKey = (request: Request, principal: PublicPrincipal): string => {
    if (principal.patId) return `pat:${principal.patId}`;
    const forwarded = request.headers.get('x-forwarded-for');
    const trusted = request.headers.get('x-gutter-proxy') === '1';
    return `client:${trusted && forwarded ? forwarded.split(',')[0]!.trim() : 'direct'}`;
  };
  const withPublicTimeout = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error('public_timeout')), PUBLIC_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const normalizePublicResponse = async (
    c: any,
    response: Response,
    publicPath: string,
    principal: PublicPrincipal,
  ): Promise<Response> => {
    if (!response.ok && publicPath.startsWith('/api/v1/page/')) {
      const error =
        response.status === 404
          ? 'not_found'
          : response.status === 504
            ? 'timeout'
            : response.status === 503
              ? 'reader_unavailable'
              : response.status === 409
                ? 'reader_conflict'
                : 'reader_error';
      return new Response(
        JSON.stringify({
          error,
          requestId: c.res.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? '',
        }),
        {
          status: response.status,
          headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        },
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json')) return response;
    const text = await response.text();
    const body = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return new Response(text, { status: response.status, headers: response.headers });
    let projected: Record<string, unknown> = body as Record<string, unknown>;
    if (response.ok && (publicPath === '/api/v1/catalog' || publicPath === '/api/v1/search')) {
      const page = body as {
        items?: readonly Record<string, unknown>[];
        nextCursor?: string | null;
      };
      projected = {
        items: (page.items ?? []).map((item) => ({
          seriesId: publicSeriesId(item.identityKey ?? item.id),
          displayName: item.displayName,
          publicationCount: item.publicationCount,
        })),
        nextCursor: page.nextCursor
          ? await encodePublicCursor(principal, publicPath, page.nextCursor)
          : null,
      };
    } else if (publicPath === '/api/v1/progress' && Object.hasOwn(body, 'progress')) {
      const progress = (body as { progress?: Record<string, unknown> | null }).progress;
      if (progress) {
        const { rootId: _rootId, sourceKey: _sourceKey, userId: _userId, ...safe } = progress;
        projected = { progress: safe };
      } else projected = { progress: null };
    } else if (response.ok && publicPath === '/api/v1/favorites') {
      const page = body as {
        items?: readonly Record<string, unknown>[];
        nextCursor?: string | null;
      };
      projected = {
        items: (page.items ?? [])
          .filter(
            (item) =>
              item.favorite === true && ['series', 'publication'].includes(String(item.targetKind)),
          )
          .map((item) => {
            return {
              targetKind: item.targetKind,
              targetId: item.targetKey,
              favorite: true,
              ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
            };
          }),
        nextCursor: page.nextCursor
          ? await encodePublicCursor(principal, publicPath, page.nextCursor)
          : null,
      };
    } else if (response.ok && publicPath === '/api/v1/collections') {
      const page = body as {
        items?: readonly Record<string, unknown>[];
        nextCursor?: string | null;
      };
      if (Array.isArray(page.items)) {
        projected = {
          items: page.items.map((item) => {
            const { id, name, createdAt, updatedAt } = item;
            return {
              collectionId: publicCollectionKey(principal.id, String(id)),
              name,
              createdAt,
              updatedAt,
            };
          }),
          nextCursor: page.nextCursor
            ? await encodePublicCursor(principal, publicPath, page.nextCursor)
            : null,
        };
      } else if (body.collection && typeof body.collection === 'object') {
        const collection = body.collection as Record<string, unknown>;
        projected = {
          collection: {
            collectionId: publicCollectionKey(principal.id, String(collection.id)),
            name: collection.name,
          },
        };
      }
    }
    if ('error' in projected)
      projected = {
        ...projected,
        requestId: c.res.headers.get('x-request-id') ?? c.req.header('x-request-id') ?? '',
      };
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(projected), {
      status: response.status,
      headers,
    });
  };
  const requiredScope: Record<string, PublicApiScope> = {
    '/api/v1/catalog': 'catalog:read',
    '/api/v1/search': 'search:read',
    '/api/v1/page/': 'page:read',
    '/api/v1/progress:GET': 'reading-state:read',
    '/api/v1/progress:PUT': 'reading-state:write',
    '/api/v1/favorites:GET': 'reading-state:read',
    '/api/v1/favorites:PUT': 'reading-state:write',
    '/api/v1/ratings:PUT': 'reading-state:write',
    '/api/v1/collections:GET': 'collections:read',
    '/api/v1/collections:POST': 'collections:write',
  };
  // Establish the request identifier before any public routing or validation can return an error.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.header('x-request-id', requestId);
    await next();
  });
  app.get('/user-state/pats', async (c) => {
    const user = await requestPrincipal(c.req.raw);
    if (!user) return c.json({ error: 'authentication_required' as const }, 401);
    return c.json({ items: await listPublicApiTokens(user.id) }, 200);
  });
  app.post('/user-state/pats', async (c) => {
    const user = await requestPrincipal(c.req.raw);
    if (!user) return c.json({ error: 'authentication_required' as const }, 401);
    if (!trustedMutationOrigin(c.req.raw)) return c.json({ error: 'invalid_origin' as const }, 403);
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.label !== 'string' ||
      body.label.length > 128 ||
      (body.scopes !== undefined &&
        (!Array.isArray(body.scopes) || body.scopes.length > publicApiScopes.length)) ||
      (body.expiresAt !== undefined &&
        body.expiresAt !== null &&
        typeof body.expiresAt !== 'string')
    )
      return c.json({ error: 'invalid_request' as const }, 400);
    try {
      return c.json(
        await createPublicApiToken(
          user.id,
          body.label,
          body.scopes ?? defaultPublicApiScopes,
          body.expiresAt,
        ),
        201,
      );
    } catch {
      return c.json({ error: 'invalid_request' as const }, 400);
    }
  });
  app.delete('/user-state/pats/:id', async (c) => {
    const user = await requestPrincipal(c.req.raw);
    if (!user) return c.json({ error: 'authentication_required' as const }, 401);
    if (!trustedMutationOrigin(c.req.raw)) return c.json({ error: 'invalid_origin' as const }, 403);
    return c.json({ revoked: await revokePublicApiToken(user.id, c.req.param('id')) }, 200);
  });
  // Public v1 is a strict allow-list of aliases to existing authorization-safe handlers.
  // Internal routes remain available only under their original, unstable namespaces.
  app.use('/api/v1/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const aliases: Record<string, string> = {
      '/api/v1/catalog': '/catalog/series',
      '/api/v1/search': '/catalog/series',
      '/api/v1/progress': '/user-state/progress',
      '/api/v1/favorites': '/user-state/targets',
      '/api/v1/ratings': '/user-state/targets',
      '/api/v1/collections': '/user-state/collections',
    };
    if (path === '/api/v1/openapi.json') return next();
    const method = c.req.method.toUpperCase();
    const allowedMethods: Record<string, readonly string[]> = {
      '/api/v1/catalog': ['GET'],
      '/api/v1/search': ['GET'],
      '/api/v1/progress': ['GET', 'PUT'],
      '/api/v1/favorites': ['GET', 'PUT'],
      '/api/v1/ratings': ['PUT'],
      '/api/v1/collections': ['GET', 'POST'],
    };
    if (path.startsWith('/api/v1/page/')) {
      if (!['GET', 'HEAD'].includes(method)) {
        c.header('allow', 'GET, HEAD');
        return publicError(c, 'method_not_allowed', 405);
      }
    } else if (allowedMethods[path] && !allowedMethods[path].includes(method)) {
      c.header('allow', allowedMethods[path]!.join(', '));
      return publicError(c, 'method_not_allowed', 405);
    }
    if (!path.startsWith('/api/v1/page/') && !aliases[path])
      return publicError(c, 'not_found', 404);
    const url = new URL(c.req.url);
    if (Buffer.byteLength(url.search, 'utf8') > PUBLIC_MAX_QUERY_BYTES)
      return publicError(c, 'invalid_query', 400);
    const params = [...url.searchParams.entries()];
    if (
      params.length > PUBLIC_MAX_QUERY_PARAMETERS ||
      params.some(
        ([key, value]) =>
          Buffer.byteLength(key, 'utf8') > 128 || Buffer.byteLength(value, 'utf8') > 4096,
      )
    )
      return publicError(c, 'invalid_query', 400);
    const cursor = url.searchParams.get('cursor');
    if (cursor && Buffer.byteLength(cursor, 'utf8') > PUBLIC_MAX_CURSOR_BYTES)
      return publicError(c, 'invalid_cursor', 400);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > PUBLIC_BODY_BYTES)
      return publicError(c, 'body_too_large', 413);
    const principal = await requestPrincipal(c.req.raw, true);
    const scope =
      requiredScope[path.startsWith('/api/v1/page/') ? '/api/v1/page/' : `${path}:${method}`] ??
      requiredScope[path];
    if (!principal) return publicError(c, 'authentication_required', 401);
    if (!['GET', 'HEAD'].includes(method) && !principal.patId && !trustedMutationOrigin(c.req.raw))
      return publicError(c, 'invalid_origin', 403);
    if (principal.patScopes && scope && !principal.patScopes.includes(scope))
      return publicError(c, 'insufficient_scope', 403);
    const rate = publicRateAllowed(publicClientKey(c.req.raw, principal));
    if (!rate.ok) {
      c.header('retry-after', String(rate.retryAfter));
      return publicError(c, 'rate_limited', 429);
    }
    if (path.startsWith('/api/v1/page/')) {
      const match = /^\/api\/v1\/page\/([0-9a-f]{64}:[0-9a-f]{64})\/([0-9]+)$/.exec(path);
      if (!match || Number(match[2]) > 1000000) return publicError(c, 'not_found', 404);
      const publication = await withPublicTimeout(
        getReaderPublicationSessionByIdentity(match[1], principal.id),
      ).catch((error) => {
        if (error instanceof Error && error.message === 'public_timeout') return null;
        throw error;
      });
      if (!publication || !publication.release.validOrdinals.includes(Number(match[2])))
        return publicError(c, 'not_found', 404);
      url.pathname = `/api/reader/releases/${publication.releaseId}/pages/${match[2]}`;
      const delegated = new Request(url, {
        method,
        headers: c.req.raw.headers,
        signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
      });
      delegatedPrincipals.set(delegated, principal);
      return withPublicTimeout(Promise.resolve(app.fetch(delegated)))
        .then((response) => normalizePublicResponse(c, response, path, principal))
        .catch((error) => {
          if (error instanceof Error && error.message === 'public_timeout')
            return publicError(c, 'timeout', 504);
          throw error;
        });
    }
    const target = aliases[path]!;
    const allowedQuery =
      path === '/api/v1/search'
        ? new Set(['q', 'limit', 'cursor'])
        : path === '/api/v1/catalog' ||
            path === '/api/v1/favorites' ||
            path === '/api/v1/collections'
          ? new Set(['q', 'limit', 'cursor'])
          : path === '/api/v1/progress' && method === 'GET'
            ? new Set(['progressKey'])
            : new Set<string>();
    if (params.some(([key]) => !allowedQuery.has(key))) return publicError(c, 'invalid_query', 400);
    if (
      path === '/api/v1/search' &&
      (!url.searchParams.get('q') || url.searchParams.get('q')!.trim().length < 1)
    )
      return publicError(c, 'invalid_query', 400);
    const limit = url.searchParams.get('limit');
    if (limit !== null && (!/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100))
      return publicError(c, 'invalid_pagination', 400);
    if (
      url.searchParams.get('progressKey') &&
      !/^source:[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('progressKey')!)
    )
      return publicError(c, 'invalid_request', 400);
    let internalCursor: string | undefined;
    if (cursor) {
      try {
        internalCursor = await decodePublicCursor(principal, path, cursor);
      } catch {
        return publicError(c, 'invalid_cursor', 400);
      }
    }
    const rewrittenParams = new URLSearchParams();
    for (const key of allowedQuery) {
      const value = url.searchParams.get(key);
      if (value !== null && key !== 'cursor') rewrittenParams.set(key, value);
    }
    if (internalCursor) rewrittenParams.set('cursor', internalCursor);
    if (path === '/api/v1/progress' && method === 'GET') {
      if (!url.searchParams.get('progressKey')) return publicError(c, 'invalid_request', 400);
      const progressTarget = await withPublicTimeout(
        resolvePublicProgressTarget(principal.id, url.searchParams.get('progressKey') ?? ''),
      ).catch((error) => {
        if (error instanceof Error && error.message === 'public_timeout') return null;
        throw error;
      });
      if (!progressTarget) return publicError(c, 'not_found', 404);
      rewrittenParams.set('rootId', progressTarget.rootId);
      rewrittenParams.set('progressKey', url.searchParams.get('progressKey')!);
    }
    url.search = rewrittenParams.toString();
    url.pathname = target;
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const rawBody = await c.req.raw.clone().text();
      if (Buffer.byteLength(rawBody, 'utf8') > PUBLIC_BODY_BYTES)
        return publicError(c, 'body_too_large', 413);
      try {
        const parsed = JSON.parse(rawBody) as Record<string, unknown>;
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length > PUBLIC_MAX_PROPERTIES
        )
          return publicError(c, 'invalid_request', 400);
        let adapted: Record<string, unknown> = parsed;
        if (path === '/api/v1/progress') {
          if (
            !Object.keys(parsed).every((key) =>
              ['progressKey', 'expectedRevision', 'pageOrdinal', 'completed'].includes(key),
            ) ||
            typeof parsed.progressKey !== 'string' ||
            !Number.isSafeInteger(parsed.expectedRevision) ||
            (parsed.expectedRevision as number) < 0 ||
            !Number.isSafeInteger(parsed.pageOrdinal) ||
            (parsed.pageOrdinal as number) < 0 ||
            (parsed.pageOrdinal as number) > 1000000 ||
            typeof parsed.completed !== 'boolean'
          )
            return publicError(c, 'invalid_request', 400);
          const progressTarget = await withPublicTimeout(
            resolvePublicProgressTarget(principal.id, parsed.progressKey),
          ).catch((error) => {
            if (error instanceof Error && error.message === 'public_timeout') return null;
            throw error;
          });
          if (!progressTarget) return publicError(c, 'not_found', 404);
          adapted = { ...parsed, rootId: progressTarget.rootId };
        } else if (path === '/api/v1/favorites' || path === '/api/v1/ratings') {
          const allowed =
            path === '/api/v1/favorites'
              ? ['targetKind', 'targetId', 'favorite']
              : ['targetKind', 'targetId', 'rating'];
          if (
            !Object.keys(parsed).every((key) => allowed.includes(key)) ||
            typeof parsed.targetKind !== 'string' ||
            typeof parsed.targetId !== 'string'
          )
            return publicError(c, 'invalid_request', 400);
          if (path === '/api/v1/favorites' && typeof parsed.favorite !== 'boolean')
            return publicError(c, 'invalid_request', 400);
          if (
            (path === '/api/v1/ratings' &&
              parsed.rating !== null &&
              !Number.isSafeInteger(parsed.rating)) ||
            (path === '/api/v1/ratings' &&
              parsed.rating !== null &&
              ((parsed.rating as number) < 1 || (parsed.rating as number) > 5))
          )
            return publicError(c, 'invalid_request', 400);
          if (!['series', 'publication'].includes(parsed.targetKind))
            return publicError(c, 'invalid_request', 400);
          const target = await withPublicTimeout(
            resolvePublicTarget(
              principal.id,
              parsed.targetKind as 'series' | 'publication',
              parsed.targetId,
            ),
          ).catch((error) => {
            if (error instanceof Error && error.message === 'public_timeout') return null;
            throw error;
          });
          if (!target) return publicError(c, 'not_found', 404);
          adapted = { ...parsed, rootId: target.rootId, targetKey: target.targetKey };
          delete adapted.targetId;
        } else if (path === '/api/v1/collections') {
          if (
            !Object.keys(parsed).every((key) => key === 'name') ||
            typeof parsed.name !== 'string' ||
            parsed.name.length < 1 ||
            parsed.name.length > 128
          )
            return publicError(c, 'invalid_request', 400);
        }
        body = JSON.stringify(adapted);
      } catch {
        return publicError(c, 'invalid_request', 400);
      }
    }
    const delegatedHeaders = new Headers(c.req.raw.headers);
    delegatedHeaders.delete('content-length');
    delegatedHeaders.delete('host');
    const delegated = new Request(url, {
      method,
      headers: delegatedHeaders,
      body,
      signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
    });
    delegatedPrincipals.set(delegated, principal);
    return withPublicTimeout(Promise.resolve(app.fetch(delegated)))
      .then((response) => normalizePublicResponse(c, response, path, principal))
      .catch((error) => {
        if (error instanceof Error && error.message === 'public_timeout')
          return publicError(c, 'timeout', 504);
        throw error;
      });
  });
  app.get('/api/v1/openapi.json', async (c) => {
    const document = await readFile(resolve(process.cwd(), 'docs/openapi-v1.json'), 'utf8');
    c.header('content-type', 'application/json; charset=utf-8');
    return c.body(document, 200);
  });
  const readerKey = resolved.readerCapabilityKey || null;

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')!;
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
    const user = await requestPrincipal(c.req.raw);
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
  const userStateUser = async (request: Request) => requestPrincipal(request);
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
    const { sourceKey, rootId: _rootId, userId: _userId, ...safe } = progress;
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
    const delegated = delegatedPrincipals.get(c.req.raw);
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !delegated?.patId &&
      !trustedMutationOrigin(c.req.raw)
    )
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
    const user = await requestPrincipal(c.req.raw);
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
