import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiDeps } from '../apps/api/src/index.ts';

process.env.DATABASE_URL ??= 'postgresql://public-page-proxy-test@127.0.0.1:1/unused';
process.env.BETTER_AUTH_SECRET ??= 'public-page-proxy-secret-0123456789-0123456789';
process.env.GUTTER_READER_CAPABILITY_SECRET ??=
  'public-page-proxy-reader-secret-0123456789-0123456789';
process.env.GUTTER_AUTH_ORIGIN ??= 'http://localhost:8080';
process.env.PINO_LOG_LEVEL ??= 'silent';

const { createApp } = await import('../apps/api/src/index.ts');
const publicationId = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
const makeApp = (fetchReader: NonNullable<ApiDeps['fetchReader']>) =>
  createApp({
    authenticatedUser: async () => ({ id: 'reader-user', role: 'user' }),
    trustedMutationOrigin: () => true,
    readerCapabilityKey: 'public-page-proxy-reader-key-0123456789-012345',
    getReaderPublicationSessionByIdentity: async () => ({
      releaseId: '42',
      release: {
        rootId: 'library-a',
        progressKey: 'source:opaque',
        revision: '1',
        validOrdinals: [0],
        validPageCount: 1,
        nextPublicationId: null,
      },
    }),
    libraryAccessScope: async () => ({
      userId: 'reader-user',
      isAdmin: false,
      rootIds: ['library-a'],
      revision: 1,
      scopeHash: 'scope',
    }),
    canAccessLibrary: () => true,
    readerRootForRequestPath: async () => 'library-a',
    isReaderPathVisible: async () => true,
    fetchReader,
  } as ApiDeps);
const request = (app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://api/api/v1/page/${publicationId}/0`, {
      headers: { ...headers },
    }),
  );

test('public page proxy preserves binary success and 304 conditional semantics', async () => {
  let seenCapability = false;
  const app = makeApp(async (_url, init) => {
    seenCapability = Boolean(new Headers(init?.headers).get('x-gutter-reader-capability'));
    return new Response(Buffer.from('image-bytes'), {
      status: 206,
      headers: { 'content-type': 'image/png', etag: 'W/"page"', 'content-range': 'bytes 0-10/11' },
    });
  });
  const success = await request(app);
  assert.equal(success.status, 206);
  assert.equal(success.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await success.arrayBuffer()).toString(), 'image-bytes');
  assert.equal(seenCapability, true);

  const conditional = makeApp(
    async () =>
      new Response(null, {
        status: 304,
        headers: { etag: 'W/"page"', 'last-modified': new Date(0).toUTCString() },
      }),
  );
  const notModified = await request(conditional, { 'x-request-id': 'req-304' });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  assert.equal(notModified.headers.get('etag'), 'W/"page"');
});

test('public page proxy maps reader errors and upstream failures to stable JSON envelopes', async () => {
  const range = makeApp(
    async () =>
      new Response(null, {
        status: 416,
        headers: { 'content-range': 'bytes */11' },
      }),
  );
  const rangeResponse = await request(range, { 'x-request-id': 'req-416' });
  assert.equal(rangeResponse.status, 416);
  assert.deepEqual(await rangeResponse.json(), {
    error: 'range_not_satisfiable',
    requestId: 'req-416',
  });
  assert.equal(rangeResponse.headers.get('content-range'), 'bytes */11');

  const unavailable = makeApp(async () => {
    throw new Error('worker unavailable');
  });
  const unavailableResponse = await request(unavailable, { 'x-request-id': 'req-503' });
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    error: 'reader_unavailable',
    requestId: 'req-503',
  });

  const malformed = makeApp(
    async () =>
      new Response(JSON.stringify({ error: 'internal' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const malformedResponse = await request(malformed, { 'x-request-id': 'req-json' });
  assert.equal(malformedResponse.status, 500);
  assert.deepEqual(await malformedResponse.json(), {
    error: 'reader_error',
    requestId: 'req-json',
  });
});
