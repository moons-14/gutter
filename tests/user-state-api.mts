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

const { createApp } = await import('../apps/api/src/index.ts');

const user = { id: 'user-a', role: 'user' } as any;
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
    getUserProgress: async () => ({ pageOrdinal: 2, completed: false, revision: 1, openCount: 1 }),
    putUserProgress: async (_id, _root, _key, expected) =>
      expected === 1
        ? { ok: true, current: { pageOrdinal: 3, completed: true, revision: 2, openCount: 2 } }
        : { ok: false, current: { pageOrdinal: 2, completed: false, revision: 1, openCount: 1 } },
    setUserTargetState: async () => true,
    addUserBookmark: async () => true,
    deleteUserBookmark: async () => true,
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
    new Request('http://api/api/user-state/export'),
  );
  assert.equal(response.status, 401);
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
    const response = await request(app, `/api/user-state/resume?limit=${limit}`);
    assert.equal(response.status, 400, limit);
  }
  assert.deepEqual(calls, []);
  const response = await request(app, '/api/user-state/resume?limit=7');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [{ rootId: 'root-a', progressKey: 'source:opaque-key', pageOrdinal: 4 }],
  });
  assert.deepEqual(calls, [['user-a', 7]]);
  assert.doesNotMatch(
    JSON.stringify(await (await request(app, '/api/user-state/resume?limit=7')).json()),
    /sourceKey|relativePath|path/,
  );
});

test('all state mutations reject foreign origins before invoking dependencies', async () => {
  const calls: string[] = [];
  const app = makeApp({ setUserTargetState: async () => (calls.push('target'), true) });
  const cases: Array<[string, string, unknown]> = [
    [
      '/api/user-state/progress',
      'PUT',
      {
        rootId: 'root-a',
        sourceKey: 'issue.cbz',
        expectedRevision: 1,
        pageOrdinal: 1,
        completed: false,
      },
    ],
    [
      '/api/user-state/target',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', favorite: true },
    ],
    [
      '/api/user-state/bookmarks',
      'POST',
      { rootId: 'root-a', sourceKey: 'issue.cbz', pageOrdinal: 1 },
    ],
    ['/api/user-state/collections', 'POST', { name: 'x' }],
    ['/api/user-state/collections/7', 'DELETE', {}],
    [
      '/api/user-state/collections/7/members',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', member: true },
    ],
    [
      '/api/user-state/collections/7/members',
      'DELETE',
      { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz' },
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

test('denied and unknown resources are consistently 404, including collection membership', async () => {
  const app = makeApp({
    authorizeUserStateResource: async () => false,
    authorizeUserCollection: async () => false,
  });
  const cases: Array<[string, string, unknown]> = [
    ['/api/user-state/progress?rootId=root-a&sourceKey=issue.cbz', 'GET', undefined],
    [
      '/api/user-state/progress',
      'PUT',
      {
        rootId: 'root-a',
        sourceKey: 'issue.cbz',
        expectedRevision: 1,
        pageOrdinal: 1,
        completed: false,
      },
    ],
    [
      '/api/user-state/target',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', favorite: true },
    ],
    [
      '/api/user-state/bookmarks',
      'POST',
      { rootId: 'root-a', sourceKey: 'issue.cbz', pageOrdinal: 1 },
    ],
    ['/api/user-state/collections/7', 'DELETE', undefined],
    [
      '/api/user-state/collections/7/members',
      'PUT',
      { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', member: true },
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
  const collection = await request(app, '/api/user-state/collections', {
    method: 'POST',
    ...json({ name: 'Favorites' }),
  });
  assert.equal(collection.status, 201);
  const success = await request(app, '/api/user-state/progress', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      sourceKey: 'issue.cbz',
      expectedRevision: 1,
      pageOrdinal: 3,
      completed: true,
    }),
  });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).progress.revision, 2);
  const conflict = await request(app, '/api/user-state/progress', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      sourceKey: 'issue.cbz',
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
  const valid = await request(app, '/api/user-state/target', {
    method: 'PUT',
    ...json({
      rootId: 'root-a',
      targetKind: 'source',
      targetKey: 'issue.cbz',
      rating: null,
      note: null,
    }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(calls[0], { rating: null, note: null });
  for (const body of [
    { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', favorite: 'yes' },
    { rootId: 'root-a', targetKind: 'bad', targetKey: 'issue.cbz' },
    { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', rating: '5' },
    { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', note: 5 },
    { rootId: 'root-a', targetKind: 'source', targetKey: 'issue.cbz', clientId: 'device-1' },
  ]) {
    const response = await request(app, '/api/user-state/target', { method: 'PUT', ...json(body) });
    assert.equal(response.status, 400);
  }
});
