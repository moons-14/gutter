import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createReaderHttpServer as createInternalReaderHttpServer,
  type ReaderHttpDependencies,
} from '../apps/worker/src/reader-http.ts';
import { DerivedCache } from '../packages/derived-cache/src/index.ts';
import { cacheStatus } from '../apps/worker/src/cache-status.ts';
import { ReaderStreamLimiter } from '../packages/reader-stream/src/index.ts';

const createReaderHttpServer = (deps: Omit<ReaderHttpDependencies, 'verifyCapability'>) =>
  createInternalReaderHttpServer({
    ...deps,
    verifyCapability: (_token, path) => ({
      v: 1,
      aud: 'gutter-worker',
      userId: 'test-user',
      rootId: 'library',
      path,
      aclRevision: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 10,
      nonce: 'a'.repeat(22),
    }),
  });

async function listening(server: ReturnType<typeof createReaderHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('internal reader rejects missing or forged capability before DB or source access', async () => {
  let accessed = false;
  const path = '/api/reader/releases/42/pages/0';
  const server = createInternalReaderHttpServer({
    roots: new Map(),
    verifyCapability: (token, actualPath) =>
      token === 'valid' && actualPath === path
        ? {
            v: 1,
            aud: 'gutter-worker',
            userId: 'user-a',
            rootId: 'library',
            path,
            aclRevision: 1,
            expiresAt: Math.floor(Date.now() / 1000) + 10,
            nonce: 'a'.repeat(22),
          }
        : null,
    authorize: async () => {
      accessed = true;
      return null;
    },
  });
  const base = await listening(server);
  try {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
    assert.equal(
      (await fetch(`${base}${path}`, { headers: { 'x-gutter-reader-capability': 'forged' } }))
        .status,
      404,
    );
    assert.equal(accessed, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('internal reader HTTP route authorizes opaque release ordinal and has finite conditional/range semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-http-'));
  const data = Buffer.from('0123456789');
  await writeFile(join(root, '001.jpg'), data);
  const sourceStat = await lstat(root, { bigint: true });
  const calls: Array<[string, number, string]> = [];
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    authorize: async (release, ordinal, userId) => {
      calls.push([release, ordinal, userId]);
      return release === '42' && ordinal === 0
        ? {
            rootId: 'library',
            relativePath: '.',
            kind: 'directory',
            ordinal,
            locator: '001.jpg',
            observed: { size: data.length },
            sourceSize: Number(sourceStat.size),
            sourceMtimeMs: Number(sourceStat.mtimeNs / 1_000_000n),
          }
        : null;
    },
  });
  const base = await listening(server);
  try {
    const first = await fetch(`${base}/api/reader/releases/42/pages/0`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(await first.text(), data.toString());
    assert.equal(first.headers.get('accept-ranges'), 'bytes');
    const etag = first.headers.get('etag');
    assert.ok(etag?.startsWith('W/'));
    const conditional = await fetch(`${base}/api/reader/releases/42/pages/0`, {
      headers: { 'If-None-Match': etag! },
    });
    assert.equal(conditional.status, 304);
    const modified = await fetch(`${base}/api/reader/releases/42/pages/0`, {
      headers: { 'If-Modified-Since': first.headers.get('last-modified')! },
    });
    assert.equal(modified.status, 304);
    const partial = await fetch(`${base}/api/reader/releases/42/pages/0`, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), '2345');
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(
      (
        await fetch(`${base}/api/reader/releases/42/pages/0`, {
          headers: { Range: 'bytes=50-60' },
        })
      ).status,
      416,
    );
    assert.equal((await fetch(`${base}/api/reader/releases/42/pages/1`)).status, 404);
    assert.deepEqual(calls.at(-1), ['42', 1, 'test-user']);
    await writeFile(join(root, '001.jpg'), Buffer.from('source changed after validation'));
    const staleConditional = await fetch(`${base}/api/reader/releases/42/pages/0`, {
      headers: { 'If-None-Match': etag! },
    });
    assert.equal(staleConditional.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('reader descriptor exposes only ready opaque navigation authority', async () => {
  const descriptorUsers: string[] = [];
  const server = createReaderHttpServer({
    roots: new Map(),
    authorize: async () => null,
    describe: async (releaseId, userId) => {
      descriptorUsers.push(userId);
      return releaseId === '42'
        ? {
            rootId: 'root-1',
            progressKey: 'source:opaque-stable-key',
            revision: 'a'.repeat(64) + ':7',
            validOrdinals: [0, 2, 5],
            validPageCount: 3,
            nextPublicationId: null,
          }
        : null;
    },
  });
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/reader/releases/42`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      release: {
        rootId: 'root-1',
        progressKey: 'source:opaque-stable-key',
        revision: 'a'.repeat(64) + ':7',
        validOrdinals: [0, 2, 5],
        validPageCount: 3,
        nextPublicationId: null,
      },
    });
    assert.deepEqual(descriptorUsers, ['test-user']);
    assert.equal((await fetch(`${base}/api/reader/releases/43`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('publication reader session returns only the selected opaque release descriptor', async () => {
  const publicationUsers: string[] = [];
  const server = createReaderHttpServer({
    roots: new Map(),
    authorize: async () => null,
    describePublication: async (publicationId, userId) => {
      publicationUsers.push(userId);
      return publicationId === '42'
        ? {
            releaseId: '9',
            release: {
              rootId: 'root-1',
              progressKey: 'source:opaque-stable-key',
              revision: 'a'.repeat(64) + ':7',
              validOrdinals: [0, 2],
              validPageCount: 2,
              nextPublicationId: null,
            },
          }
        : null;
    },
  });
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/reader/publications/42`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      session: {
        releaseId: '9',
        release: {
          rootId: 'root-1',
          progressKey: 'source:opaque-stable-key',
          revision: 'a'.repeat(64) + ':7',
          validOrdinals: [0, 2],
          validPageCount: 2,
          nextPublicationId: null,
        },
      },
    });
    assert.deepEqual(publicationUsers, ['test-user']);
    assert.equal((await fetch(`${base}/api/reader/publications/9`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('reader capability denial is uniform for descriptor, publication session, and page', async () => {
  let descriptorCalls = 0;
  let publicationCalls = 0;
  let pageCalls = 0;
  const server = createInternalReaderHttpServer({
    roots: new Map(),
    verifyCapability: (token, path) =>
      token === 'valid'
        ? {
            v: 1,
            aud: 'gutter-worker',
            userId: 'user-hidden',
            rootId: 'hidden-root',
            path,
            aclRevision: 4,
            expiresAt: Math.floor(Date.now() / 1000) + 10,
            nonce: 'b'.repeat(22),
          }
        : null,
    describe: async () => (descriptorCalls++, null),
    describePublication: async () => (publicationCalls++, null),
    authorize: async () => (pageCalls++, null),
  });
  const base = await listening(server);
  try {
    const paths = [
      '/api/reader/releases/42',
      '/api/reader/publications/42',
      '/api/reader/releases/42/pages/0',
    ];
    for (const path of paths) {
      assert.equal(
        (await fetch(`${base}${path}`, { headers: { 'x-gutter-reader-capability': 'valid' } }))
          .status,
        404,
      );
      assert.equal((await fetch(`${base}${path}`)).status, 404);
      assert.equal(
        (await fetch(`${base}${path}`, { headers: { 'x-gutter-reader-capability': 'forged' } }))
          .status,
        404,
      );
    }
    assert.equal(descriptorCalls, 1);
    assert.equal(publicationCalls, 1);
    assert.equal(pageCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('worker shutdown aborts an active reader stream before closing its listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-shutdown-'));
  const data = Buffer.alloc(16 * 1024 * 1024, 7);
  await writeFile(join(root, '001.jpg'), data);
  const sourceStat = await lstat(root, { bigint: true });
  const shutdown = new AbortController();
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    shutdownSignal: shutdown.signal,
    authorize: async () => ({
      rootId: 'library',
      relativePath: '.',
      kind: 'directory',
      ordinal: 0,
      locator: '001.jpg',
      observed: { size: data.length },
      sourceSize: Number(sourceStat.size),
      sourceMtimeMs: Number(sourceStat.mtimeNs / 1_000_000n),
    }),
  });
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/reader/releases/7/pages/0`);
    assert.equal(response.status, 200);
    shutdown.abort();
    await assert.rejects(response.arrayBuffer());
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('reader cache is disposable, source-authorized, and reports advisory filesystem state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-source-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-bytes-'));
  const data = Buffer.from('cacheable source bytes');
  await writeFile(join(root, '001.jpg'), data);
  const before = await lstat(join(root, '001.jpg'), { bigint: true });
  const source = await lstat(root, { bigint: true });
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    cache: new DerivedCache({ root: cacheRoot, quotaBytes: 1024 * 1024 }),
    authorize: async () => ({
      rootId: 'library',
      relativePath: '.',
      kind: 'directory',
      ordinal: 0,
      locator: '001.jpg',
      observed: { size: data.length },
      sourceSize: Number(source.size),
      sourceMtimeMs: Number(source.mtimeNs / 1_000_000n),
      manifestSha256: 'a'.repeat(64),
      validationGeneration: 1,
    }),
  });
  const base = await listening(server);
  try {
    assert.equal(
      await (await fetch(`${base}/api/reader/releases/42/pages/0`)).text(),
      data.toString(),
    );
    assert.ok((await cacheStatus(cacheRoot, 1024 * 1024)).usedBytes > 0);
    await rm(cacheRoot, { recursive: true, force: true });
    assert.equal(
      await (await fetch(`${base}/api/reader/releases/42/pages/0`)).text(),
      data.toString(),
    );
    const shard = (await readdir(cacheRoot)).find((name) => /^[a-f0-9]{2}$/.test(name));
    assert.ok(shard);
    const entry = (await readdir(join(cacheRoot, shard!)))[0]!;
    await writeFile(join(cacheRoot, shard!, entry, 'body'), 'corrupt');
    assert.equal(
      await (await fetch(`${base}/api/reader/releases/42/pages/0`)).text(),
      data.toString(),
    );
    const after = await lstat(join(root, '001.jpg'), { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    const status = await cacheStatus(cacheRoot, 1024 * 1024);
    assert.equal(status.fsAuthoritative, true);
    assert.equal(status.advisory, true);
    assert.ok(status.misses >= 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('reader fails open to its pinned source when cache generation is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-fail-open-source-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-fail-open-cache-'));
  const data = Buffer.from('pinned source remains readable');
  await writeFile(join(root, '001.jpg'), data);
  const source = await lstat(root, { bigint: true });
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    cache: new DerivedCache({ root: cacheRoot, quotaBytes: 1024 * 1024, maxQueue: 0 }),
    authorize: async () => ({
      rootId: 'library',
      relativePath: '.',
      kind: 'directory',
      ordinal: 0,
      locator: '001.jpg',
      observed: { size: data.length },
      sourceSize: Number(source.size),
      sourceMtimeMs: Number(source.mtimeNs / 1_000_000n),
    }),
  });
  const base = await listening(server);
  try {
    const response = await fetch(`${base}/api/reader/releases/42/pages/0`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), data.toString());
    assert.equal((await cacheStatus(cacheRoot, 1024 * 1024)).failures, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('concurrent cache misses release primary reader permits before a subsequent miss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-limiter-source-'));
  const cacheRoot = await mkdtemp(join(tmpdir(), 'gutter-reader-cache-limiter-cache-'));
  const pages = new Map([
    ['42', ['001.jpg', Buffer.from('one')]],
    ['43', ['002.jpg', Buffer.from('two')]],
    ['44', ['003.jpg', Buffer.from('three')]],
  ] as const);
  await Promise.all([...pages.values()].map(([name, body]) => writeFile(join(root, name), body)));
  const source = await lstat(root, { bigint: true });
  const limiter = new ReaderStreamLimiter(2, 0);
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    cache: new DerivedCache({ root: cacheRoot, quotaBytes: 1024 * 1024 }),
    limiter,
    authorize: async (release) => {
      const page = pages.get(release as '42' | '43' | '44');
      if (!page) return null;
      return {
        rootId: 'library',
        relativePath: '.',
        kind: 'directory',
        ordinal: 0,
        locator: page[0],
        observed: { size: page[1].length },
        sourceSize: Number(source.size),
        sourceMtimeMs: Number(source.mtimeNs / 1_000_000n),
      };
    },
  });
  const base = await listening(server);
  try {
    const first = await Promise.all(
      ['42', '43'].map(async (release) => {
        const response = await fetch(`${base}/api/reader/releases/${release}/pages/0`);
        return [response.status, await response.text()] as const;
      }),
    );
    assert.deepEqual(first, [
      [200, 'one'],
      [200, 'two'],
    ]);
    assert.equal(limiter.active, 0);
    const third = await fetch(`${base}/api/reader/releases/44/pages/0`);
    assert.equal(third.status, 200);
    assert.equal(await third.text(), 'three');
    assert.equal(limiter.active, 0);
    assert.equal(limiter.waiting, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('topology keeps source mounts worker-only and routes reader before generic API', async () => {
  const compose = await readFile(
    new URL('../compose.library.example.yaml', import.meta.url),
    'utf8',
  );
  const baseCompose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const caddy = await readFile(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.match(compose, /worker:[\s\S]*volumes:[\s\S]*:ro/);
  assert.doesNotMatch(
    baseCompose.match(/  api:[\s\S]*?(?=\n  \w|\nvolumes:)/)?.[0] ?? '',
    /\/libraries/,
  );
  assert.ok(caddy.indexOf('handle /api/reader/*') < caddy.indexOf('handle_path /api/*'));
});
