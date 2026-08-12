import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiDeps } from '../apps/api/src/index.ts';

// Keep this contract suite hermetic: importing the API also initializes its DB pool and
// Better Auth config, so provide disposable values before the dynamic import. No request,
// server, secret file, or database connection is created by these injected-dependency tests.
process.env.DATABASE_URL ??= 'postgresql://user-state-api-test@127.0.0.1:1/unused';
process.env.BETTER_AUTH_SECRET ??= 'user-state-api-test-secret-0123456789-0123456789';
process.env.GUTTER_READER_CAPABILITY_SECRET ??=
  'user-state-api-reader-secret-0123456789-0123456789';
process.env.GUTTER_AUTH_ORIGIN ??= 'http://localhost:8080';
process.env.PINO_LOG_LEVEL ??= 'silent';

const { createApp, adminUserDirectoryLogFields } = await import('../apps/api/src/index.ts');

const user = { id: 'user-a', role: 'user' } as any;
const admin = { id: 'admin-a', role: 'admin' } as any;
const progressKey = 'source:opaque-key';
const resolvedSourcePath = 'issue.cbz';
const origin = 'http://localhost:8080';
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { origin, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const makeApp = (overrides: Partial<ApiDeps> = {}) => {
  const resource = async (id: string, root: string, kind: string, key: string) =>
    id === user.id &&
    root === 'root-a' &&
    ['source', 'progress'].includes(kind) &&
    key === 'issue.cbz';
  return createApp({
    authenticatedUser: async (request) =>
      request.headers.get('authorization') === 'Bearer user-a' ? user : null,
    trustedMutationOrigin: (request) => request.headers.get('origin') === origin,
    authorizeUserStateResource: resource as any,
    authorizeUserCollection: async (id, collectionId) => id === user.id && collectionId === 7,
    resolveUserProgressKey: async (id, root, key) =>
      id === user.id && root === 'root-a' && key === progressKey ? resolvedSourcePath : null,
    getUserProgress: async () => ({
      rootId: 'root-a',
      sourceKey: resolvedSourcePath,
      pageOrdinal: 2,
      completed: false,
      revision: 1,
      openCount: 1,
    }),
    putUserProgress: async (_id, _root, _key, expected) =>
      expected === 1
        ? {
            ok: true,
            current: {
              rootId: 'root-a',
              sourceKey: resolvedSourcePath,
              pageOrdinal: 3,
              completed: true,
              revision: 2,
              openCount: 2,
            },
          }
        : {
            ok: false,
            current: {
              rootId: 'root-a',
              sourceKey: resolvedSourcePath,
              pageOrdinal: 2,
              completed: false,
              revision: 1,
              openCount: 1,
            },
          },
    setUserTargetState: async () => true,
    addUserBookmark: async () => true,
    deleteUserBookmark: async () => true,
    listUserCollections: async () => ({ items: [], nextCursor: null }),
    listUserCollectionMembers: async () => ({ items: [], nextCursor: null }),
    listUserBookmarks: async () => ({ items: [], nextCursor: null }),
    listUserTargetState: async () => ({ items: [], nextCursor: null }),
    createUserCollection: async () => ({ id: 8, name: 'Favorites' }),
    deleteUserCollection: async () => true,
    setUserCollectionMembership: async () => true,
    exportUserState: async () => ({
      progress: [],
      targetState: [],
      bookmarks: [],
      collections: [],
    }),
    ...overrides,
  } as ApiDeps);
};
const request = (app: ReturnType<typeof makeApp>, path: string, init: RequestInit = {}) =>
  app.fetch(
    new Request(`http://api${path}`, {
      ...init,
      headers: { authorization: 'Bearer user-a', origin, ...(init.headers ?? {}) },
    }),
  );

test('importing createApp is startup-safe and unauthenticated user state is 401', async () => {
  const response = await createApp({ authenticatedUser: async () => null } as ApiDeps).fetch(
    new Request('http://api/user-state/export'),
  );
  assert.equal(response.status, 401);
});

test('admin user directory enforces auth, validates queries, and returns only the safe projection', async () => {
  const listCalls: unknown[] = [];
  const directory = {
    items: [
      {
        id: 'opaque-user',
        name: 'Reader',
        email: 'reader@example.invalid',
        role: 'user',
        banned: false,
      },
    ],
    nextCursor: null,
  };
  const app = makeApp({
    authenticatedUser: async (request) =>
      request.headers.get('authorization') === 'Bearer admin-a' ? admin : user,
    listAdminUsers: async (query) => {
      listCalls.push(query);
      return directory;
    },
  });
  assert.equal(
    (
      await createApp({ authenticatedUser: async () => null } as ApiDeps).fetch(
        new Request('http://api/admin/users'),
      )
    ).status,
    401,
  );
  assert.equal((await request(app, '/admin/users')).status, 404);
  const response = await app.fetch(
    new Request('http://api/admin/users?limit=2&q=Reader', {
      headers: { authorization: 'Bearer admin-a' },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), directory);
  assert.deepEqual(listCalls, [{ q: 'Reader', limit: 2, cursor: undefined }]);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'q=' + 'x'.repeat(257), 'unknown=x']) {
    const invalid = await app.fetch(
      new Request(`http://api/admin/users?${query}`, {
        headers: { authorization: 'Bearer admin-a' },
      }),
    );
    assert.equal(invalid.status, 400, query);
  }
});

test('admin directory structured read event is bounded and contains no query or PII', () => {
  const event = adminUserDirectoryLogFields('request-1', true, 1000);
  assert.deepEqual(event, {
    requestId: 'request-1',
    action: 'admin_user_directory_read',
    admin: true,
    filtered: true,
    resultCount: 100,
  });
  assert.doesNotMatch(JSON.stringify(event), /Reader|reader@example|secret|cursor|q=/);
});

test('permanent user-state deletion uses the exact empty body and admin-only route', async () => {
  const calls: unknown[] = [];
  const app = makeApp({
    authenticatedUser: async (request) =>
      request.headers.get('authorization') === 'Bearer admin-a' ? admin : user,
    permanentlyDeleteUser: async (...args) => {
      calls.push(args);
      return { session: 1 };
    },
  });
  const denied = await app.fetch(
    new Request('http://api/admin/users/user-a/user-state', {
      method: 'DELETE',
      headers: { authorization: 'Bearer user-a', origin, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(denied.status, 404);
  const response = await app.fetch(
    new Request('http://api/admin/users/subject-a/user-state', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer admin-a',
        origin,
        'content-type': 'application/json',
        'x-request-id': 'delete-request-1',
      },
      body: '{}',
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: { session: 1 } });
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as unknown[])[0], 'admin-a');
  assert.equal((calls[0] as unknown[])[1], 'subject-a');
  assert.equal((calls[0] as unknown[])[2], 'delete-request-1');
  const generated = await app.fetch(
    new Request('http://api/admin/users/subject-b/user-state', {
      method: 'DELETE',
      headers: { authorization: 'Bearer admin-a', origin, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  assert.equal(generated.status, 200);
  assert.match(String((calls[1] as unknown[])[2]), /^[0-9a-f-]{36}$/);
  const invalidId = await app.fetch(
    new Request('http://api/admin/users/subject-a/user-state', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer admin-a',
        origin,
        'content-type': 'application/json',
        'x-request-id': 'bad id',
      },
      body: '{}',
    }),
  );
  assert.equal(invalidId.status, 400);
  for (const body of ['{"extra":true}', 'null', '[]', 'not-json']) {
    const invalidBody = await app.fetch(
      new Request('http://api/admin/users/subject-a/user-state', {
        method: 'DELETE',
        headers: { authorization: 'Bearer admin-a', origin, 'content-type': 'application/json' },
        body,
      }),
    );
    assert.equal(invalidBody.status, 400, body);
  }
  const invalidOrigin = await app.fetch(
    new Request('http://api/admin/users/subject-a/user-state', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer admin-a',
        origin: 'http://foreign.invalid',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  assert.equal(invalidOrigin.status, 403);
});

test('admin user directory preserves deterministic pages and rejects cursor/filter mutations', async () => {
  const calls: unknown[] = [];
  const app = makeApp({
    authenticatedUser: async () => admin,
    listAdminUsers: async (query) => {
      calls.push(query);
      if (query.cursor === 'mutated') throw new Error('invalid_cursor');
      return query.cursor
        ? { items: [], nextCursor: null }
        : {
            items: [{ id: 'u-2', name: 'B', email: 'b', role: null, banned: false }],
            nextCursor: 'opaque.cursor.mac',
          };
    },
  });
  const first = await app.fetch(
    new Request('http://api/admin/users?limit=1', { headers: { authorization: 'Bearer admin-a' } }),
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).nextCursor, 'opaque.cursor.mac');
  const second = await app.fetch(
    new Request('http://api/admin/users?limit=1&cursor=opaque.cursor.mac', {
      headers: { authorization: 'Bearer admin-a' },
    }),
  );
  assert.equal(second.status, 200);
  const invalid = await app.fetch(
    new Request('http://api/admin/users?cursor=mutated', {
      headers: { authorization: 'Bearer admin-a' },
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 3);
});

test('resume validates bounded limits and returns only opaque user-scoped entries', async () => {
  const calls: Array<[string, number]> = [];
  const app = makeApp({
    getUserResume: async (userId, limit) => {
      calls.push([userId, limit ?? -1]);
      return [{ rootId: 'root-a', progressKey: 'source:opaque-key', pageOrdinal: 4 }];
    },
  });
  for (const limit of ['0', '-1', '101', '1.5', 'nope']) {
    const response = await request(app, `/user-state/resume?limit=${limit}`);
    assert.equal(response.status, 400, limit);
  }
  assert.deepEqual(calls, []);
  const response = await request(app, '/user-state/resume?limit=7');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [{ rootId: 'root-a', progressKey: 'source:opaque-key', pageOrdinal: 4 }],
  });
  assert.deepEqual(calls, [['user-a', 7]]);
  assert.doesNotMatch(
    JSON.stringify(await (await request(app, '/user-state/resume?limit=7')).json()),
    /sourceKey|relativePath|path/,
  );
});

test('paginated user-state reads expose typed opaque pages and reject invalid cursors', async () => {
  const calls: string[] = [];
  const invalidCursors = new Set([
    'tampered',
    'endpoint-mismatch',
    'collection-mismatch',
    'scope-mismatch',
    'revision-mismatch',
    'user-mismatch',
  ]);
  const page = (endpoint: string, item: Record<string, unknown>) => {
    const read = (cursor: string | undefined) => {
      calls.push(`${endpoint}:${cursor ?? 'first'}`);
      if (cursor && invalidCursors.has(cursor)) throw new Error('invalid_pagination_cursor');
      return {
        items: [{ ...item, sourceKey: 'redact-me', relativePath: 'redact-me', sourceItemId: '9' }],
        nextCursor: 'opaque-next',
      };
    };
    return read;
  };
  const app = makeApp({
    listUserCollections: async (_userId, _limit, cursor) =>
      page('collections', { id: '7', name: 'Favorites' })(cursor),
    listUserCollectionMembers: async (_userId, _collectionId, _limit, cursor) =>
      page('members', { rootId: 'root-a', targetKind: 'source', targetKey: progressKey })(cursor),
    listUserBookmarks: async (_userId, _limit, cursor) =>
      page('bookmarks', { rootId: 'root-a', progressKey, pageOrdinal: 3 })(cursor),
    listUserTargetState: async (_userId, _limit, cursor) =>
      page('targets', { rootId: 'root-a', targetKind: 'source', targetKey: progressKey })(cursor),
  });
  const endpoints = [
    '/user-state/collections?limit=1',
    '/user-state/collections/7/members?limit=1',
    '/user-state/bookmarks?limit=1',
    '/user-state/targets?limit=1',
  ];
  for (const endpoint of endpoints) {
    const response = await request(app, endpoint);
    assert.equal(response.status, 200, endpoint);
    const body = await response.json();
    assert.equal(body.nextCursor, 'opaque-next', endpoint);
    assert.equal(body.items.length, 1, endpoint);
    assert.doesNotMatch(JSON.stringify(body), /sourceKey|relativePath|sourceItemId/, endpoint);
  }
  for (const endpoint of endpoints) {
    for (const cursor of invalidCursors) {
      const response = await request(
        app,
        `${endpoint.split('?')[0]}?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      assert.equal(response.status, 400, `${endpoint} ${cursor}`);
      assert.deepEqual(await response.json(), { error: 'invalid_cursor' });
    }
  }
  assert.equal(calls.filter((call) => call.endsWith(':first')).length, 4);
  const unauthenticated = makeApp({ authenticatedUser: async () => null });
  for (const endpoint of endpoints)
    assert.equal((await request(unauthenticated, endpoint)).status, 401, endpoint);
});

test('malformed progress keys fail with 400 before resource lookup', async () => {
  let resolverCalls = 0;
  const app = makeApp({
    resolveUserProgressKey: async () => {
      resolverCalls += 1;
      return resolvedSourcePath;
    },
  });
  const get = await request(app, '/user-state/progress?rootId=root-a&progressKey=issue.cbz');
  assert.equal(get.status, 400);
  const put = await request(app, '/user-state/progress', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      progressKey: 'issue.cbz',
      expectedRevision: 1,
      pageOrdinal: 1,
      completed: false,
    }),
  });
  assert.equal(put.status, 400);
  assert.equal(resolverCalls, 0);
});

test('all state mutations reject foreign origins before invoking dependencies', async () => {
  const calls: string[] = [];
  const app = makeApp({
    resolveUserProgressKey: async () => (calls.push('resolver'), resolvedSourcePath),
    setUserTargetState: async () => (calls.push('target'), true),
  });
  const cases: Array<[string, string, unknown]> = [
    [
      '/user-state/progress',
      'PUT',
      {
        rootId: 'root-a',
        progressKey,
        expectedRevision: 1,
        pageOrdinal: 1,
        completed: false,
      },
    ],
    [
      '/user-state/target',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, favorite: true },
    ],
    ['/user-state/bookmarks', 'POST', { rootId: 'root-a', progressKey, pageOrdinal: 1 }],
    ['/user-state/collections', 'POST', { name: 'x' }],
    ['/user-state/collections/7', 'DELETE', {}],
    [
      '/user-state/collections/7/members',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, member: true },
    ],
    [
      '/user-state/collections/7/members',
      'DELETE',
      { rootId: 'root-a', targetKind: 'source', targetKey: progressKey },
    ],
  ];
  for (const [path, method, body] of cases) {
    const response = await request(app, path, {
      method,
      headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.deepEqual(calls, []);
});

test('collection source and check mutations resolve opaque keys before persistence', async () => {
  const resolverCalls: Array<[string, string]> = [];
  const memberCalls: Array<[string, string, string, string, boolean]> = [];
  const app = makeApp({
    resolveUserProgressKey: async (_userId, rootId, key) => {
      resolverCalls.push([rootId, key]);
      return key === 'source:first' ? 'first.cbz' : key === 'source:second' ? 'second.cbz' : null;
    },
    authorizeUserStateResource: async (_userId, rootId, kind, key) =>
      rootId === 'root-a' &&
      (kind === 'source' || kind === 'check') &&
      (key === 'first.cbz' || key === 'second.cbz'),
    setUserCollectionMembership: async (_userId, _collectionId, rootId, kind, key, member) => {
      memberCalls.push([rootId, kind, key, key, member]);
      return true;
    },
  });
  const put = await request(app, '/user-state/collections/7/members', {
    method: 'PUT',
    ...json({ rootId: 'root-a', targetKind: 'source', targetKey: 'source:first', member: true }),
  });
  const remove = await request(app, '/user-state/collections/7/members', {
    method: 'DELETE',
    ...json({ rootId: 'root-a', targetKind: 'check', targetKey: 'source:second' }),
  });
  assert.equal(put.status, 200);
  assert.equal(remove.status, 200);
  assert.deepEqual(resolverCalls, [
    ['root-a', 'source:first'],
    ['root-a', 'source:second'],
  ]);
  assert.deepEqual(memberCalls, [
    ['root-a', 'source', 'first.cbz', 'first.cbz', true],
    ['root-a', 'check', 'second.cbz', 'second.cbz', false],
  ]);
});

test('unknown or removed collection progress keys return non-enumerating 404', async () => {
  let membershipCalls = 0;
  const app = makeApp({
    resolveUserProgressKey: async () => null,
    setUserCollectionMembership: async () => {
      membershipCalls += 1;
      return true;
    },
  });
  for (const [method, body] of [
    ['PUT', { rootId: 'root-a', targetKind: 'source', targetKey: 'source:removed', member: true }],
    ['DELETE', { rootId: 'root-a', targetKind: 'check', targetKey: 'source:removed' }],
  ] as const) {
    const response = await request(app, '/user-state/collections/7/members', {
      method,
      ...json(body),
    });
    assert.equal(response.status, 404, method);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  }
  assert.equal(membershipCalls, 0);
});

test('denied and unknown resources are consistently 404, including collection membership', async () => {
  const app = makeApp({
    authorizeUserStateResource: async () => false,
    authorizeUserCollection: async () => false,
  });
  const cases: Array<[string, string, unknown]> = [
    [
      `/user-state/progress?rootId=root-a&progressKey=${encodeURIComponent(progressKey)}`,
      'GET',
      undefined,
    ],
    [
      '/user-state/progress',
      'PUT',
      {
        rootId: 'root-a',
        progressKey,
        expectedRevision: 1,
        pageOrdinal: 1,
        completed: false,
      },
    ],
    [
      '/user-state/target',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, favorite: true },
    ],
    ['/user-state/bookmarks', 'POST', { rootId: 'root-a', progressKey, pageOrdinal: 1 }],
    ['/user-state/collections/7', 'DELETE', undefined],
    [
      '/user-state/collections/7/members',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, member: true },
    ],
  ];
  for (const [path, method, body] of cases)
    assert.equal(
      (await request(app, path, { method, ...(body === undefined ? {} : json(body)) })).status,
      404,
      `${method} ${path}`,
    );
});

test('successful collection and progress CAS responses expose required statuses and current state', async () => {
  const app = makeApp();
  const collection = await request(app, '/user-state/collections', {
    method: 'POST',
    ...json({ name: 'Favorites' }),
  });
  assert.equal(collection.status, 201);
  const success = await request(app, '/user-state/progress', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      progressKey,
      expectedRevision: 1,
      pageOrdinal: 3,
      completed: true,
    }),
  });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).progress.revision, 2);
  const conflict = await request(app, '/user-state/progress', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      progressKey,
      expectedRevision: 0,
      pageOrdinal: 3,
      completed: true,
    }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).progress.revision, 1);
});

test('target accepts explicit null clears and rejects invalid scalars, kinds, and unknown keys', async () => {
  const calls: unknown[] = [];
  const app = makeApp({
    setUserTargetState: async (...args: any[]) => (calls.push(args[4]), true),
  });
  const valid = await request(app, '/user-state/target', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      targetKind: 'source',
      targetKey: progressKey,
      rating: null,
      note: null,
    }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(calls[0], { rating: null, note: null });
  for (const body of [
    { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, favorite: 'yes' },
    { rootId: 'root-a', targetKind: 'bad', targetKey: progressKey },
    { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, rating: '5' },
    { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, note: 5 },
    { rootId: 'root-a', targetKind: 'source', targetKey: progressKey, clientId: 'device-1' },
  ]) {
    const response = await request(app, '/user-state/target', { method: 'PUT', ...json(body) });
    assert.equal(response.status, 400);
  }
});
