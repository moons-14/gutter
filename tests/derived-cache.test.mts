import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const { DerivedCache, cacheIdentity } = await import('../packages/derived-cache/src/index.ts');

const descriptor = (suffix = 'a') => ({
  source: { root: '/library', item: 'book.cbz', observation: { ino: 1, mtimeNs: '2' } },
  manifestGeneration: 3,
  validationGeneration: 4,
  locator: `001-${suffix}.jpg`,
  pageObservation: { size: 3, crc32: 5 },
  mimeType: 'image/jpeg' as const,
  implementationVersion: 'm3-cache-1',
});

test('derived cache canonical identity is stable and changes for source revision', () => {
  const first = cacheIdentity(descriptor());
  assert.equal(first.key, cacheIdentity({ ...descriptor(), params: {} }).key);
  assert.notEqual(
    first.key,
    cacheIdentity({ ...descriptor(), source: { ...descriptor().source, observation: { ino: 2 } } })
      .key,
  );
  assert.throws(() => cacheIdentity({ ...descriptor(), pageObservation: { value: Number.NaN } }));
  assert.throws(() => cacheIdentity({ ...descriptor(), pageObservation: { value: -0 } }));
  assert.throws(() => cacheIdentity({ ...descriptor(), pageObservation: { value: [, 1] } }));
  assert.throws(() => cacheIdentity({ ...descriptor(), pageObservation: new Date() }));
});

test('derived cache repairs malformed metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    const cache = new DerivedCache({ root, quotaBytes: 100 });
    const first = await cache.getOrCreate(descriptor(), async () => Buffer.from('body'));
    await writeFile(
      join(root, first.key.slice(0, 2), first.key, 'manifest.json'),
      '{"bytes":"nope"}',
    );
    const repaired = await cache.getOrCreate(descriptor(), async () => Buffer.from('body'));
    assert.equal(repaired.body.toString(), 'body');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache preserves live staging, recovers only stale crash staging, and serializes quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    let now = 1_000_000;
    const cache = new DerivedCache({ root, quotaBytes: 4, now: () => now, staleStagingMs: 10 });
    const secondInstance = new DerivedCache({
      root,
      quotaBytes: 4,
      now: () => now,
      staleStagingMs: 10,
    });
    const live = join(root, '.staging-live');
    const stale = join(root, '.staging-stale');
    await mkdir(live);
    await mkdir(stale);
    await utimes(stale, 0, 0);
    await cache.getOrCreate(descriptor('one'), async () => Buffer.from('1234'));
    assert.equal((await stat(live)).isDirectory(), true);
    assert.equal((await readdir(root)).includes('.staging-stale'), false);
    now++;
    const [one, two] = await Promise.all([
      cache.getOrCreate(descriptor('two'), async () => Buffer.from('1234')),
      secondInstance.getOrCreate(descriptor('three'), async () => Buffer.from('1234')),
    ]);
    assert.equal(one.body.length, 4);
    assert.equal(two.body.length, 4);
    const bodies = await Promise.all(
      (await readdir(root))
        .filter((p) => /^[0-9a-f]{2}$/.test(p))
        .map(async (shard) => (await readdir(join(root, shard))).length),
    );
    assert.equal(
      bodies.reduce((a, b) => a + b, 0),
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache charges fresh non-active staging against quota pressure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    const staging = join(root, '.staging-fresh');
    await mkdir(staging);
    await writeFile(join(staging, 'body'), 'hold');
    const cache = new DerivedCache({ root, quotaBytes: 4, staleStagingMs: 60_000 });
    const entry = await cache.getOrCreate(descriptor('pressure'), async () => Buffer.from('next'));
    assert.equal(entry.body.toString(), 'next');
    assert.equal(
      (await readdir(root)).some((name) => /^[0-9a-f]{2}$/.test(name)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache rejects symlink cache paths without writing outside the cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  const outside = await mkdtemp(join(tmpdir(), 'gutter-outside-'));
  try {
    const key = cacheIdentity(descriptor()).key;
    await symlink(outside, join(root, key.slice(0, 2)));
    const cache = new DerivedCache({ root, quotaBytes: 100 });
    await assert.rejects(cache.getOrCreate(descriptor(), async () => Buffer.from('body')));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('derived cache coalesces producers and respects leases across instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    const first = new DerivedCache({ root, quotaBytes: 4 });
    const second = new DerivedCache({ root, quotaBytes: 4 });
    let producers = 0;
    const produce = async () => {
      producers++;
      await Promise.resolve();
      return Buffer.from('hold');
    };
    const [lease, hit] = await Promise.all([
      first.lease(descriptor('lease'), produce),
      second.getOrCreate(descriptor('lease'), produce),
    ]);
    assert.equal(producers, 1);
    assert.equal(hit.body.toString(), 'hold');
    await second.getOrCreate(descriptor('other'), async () => Buffer.from('next'));
    assert.equal(
      (await readFile(join(root, lease.key.slice(0, 2), lease.key, 'body'))).toString(),
      'hold',
    );
    lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache coalesces, validates hits, repairs corruption, and is disposable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    const cache = new DerivedCache({ root, quotaBytes: 1000 });
    let generated = 0;
    const produce = async () => {
      generated++;
      await Promise.resolve();
      return Readable.from([Buffer.from('source-bytes')]);
    };
    const [a, b] = await Promise.all([
      cache.getOrCreate(descriptor(), produce),
      cache.getOrCreate(descriptor(), produce),
    ]);
    assert.equal(generated, 1);
    assert.equal(a.body.toString(), 'source-bytes');
    assert.equal(b.body.toString(), 'source-bytes');
    const path = join(root, a.key.slice(0, 2), a.key, 'body');
    await writeFile(path, 'broken');
    const repaired = await cache.getOrCreate(descriptor(), produce);
    assert.equal(generated, 2);
    assert.equal(repaired.body.toString(), 'source-bytes');
    await rm(root, { recursive: true, force: true });
    await cache.getOrCreate(descriptor(), produce);
    assert.equal(generated, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache keeps leased entries during deterministic GC and bypasses when quota cannot fit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  try {
    const cache = new DerivedCache({ root, quotaBytes: 5 });
    const lease = await cache.lease(descriptor('old'), async () => Buffer.from('old!'));
    const newer = await cache.getOrCreate(descriptor('new'), async () => Buffer.from('new!'));
    assert.equal(newer.body.toString(), 'new!');
    assert.equal(
      (await readFile(join(root, lease.key.slice(0, 2), lease.key, 'body'))).toString(),
      'old!',
    );
    lease.release();
    await cache.gc();
    const huge = await cache.getOrCreate(descriptor('huge'), async () =>
      Buffer.from('larger-than-quota'),
    );
    assert.equal(huge.body.toString(), 'larger-than-quota');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived cache never changes the source file bytes or mtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-'));
  const source = join(root, 'source.jpg');
  try {
    await writeFile(source, 'immutable');
    await utimes(source, 10, 10);
    const before = await stat(source, { bigint: true });
    const cache = new DerivedCache({ root: join(root, 'cache'), quotaBytes: 1000 });
    await cache.getOrCreate(descriptor(), async () => Readable.from([await readFile(source)]));
    const after = await stat(source, { bigint: true });
    assert.equal((await readFile(source)).toString(), 'immutable');
    assert.equal(after.mtimeNs, before.mtimeNs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
