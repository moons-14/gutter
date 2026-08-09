import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReaderHttpServer } from '../apps/worker/src/reader-http.ts';

async function listening(server: ReturnType<typeof createReaderHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('internal reader HTTP route authorizes opaque release ordinal and has finite conditional/range semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-http-'));
  const data = Buffer.from('0123456789');
  await writeFile(join(root, '001.jpg'), data);
  const sourceStat = await lstat(root, { bigint: true });
  const calls: Array<[string, number]> = [];
  const server = createReaderHttpServer({
    roots: new Map([['library', { canonicalPath: root }]]),
    authorize: async (release, ordinal) => {
      calls.push([release, ordinal]);
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
    assert.deepEqual(calls.at(-1), ['42', 1]);
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
