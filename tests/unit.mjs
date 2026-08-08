import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { schemaVersion, secret } = await import('../packages/config/src/index.ts');
const {
  LibraryRootConfigError,
  LibraryRootStructuralError,
  parseAllowedRoots,
  validateLibraryRoots,
} = await import('../packages/library-roots/src/index.ts');

function testDatabaseUrl() {
  return `postgresql://gutter:${randomUUID()}@db:5432/gutter`;
}

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('M1 documents the library roots schema version', () => {
  assert.equal(schemaVersion, '0001_library_roots');
});

test('config accepts a direct secret only', async () => {
  const databaseUrl = testDatabaseUrl();
  await withEnvironment({ DATABASE_URL: databaseUrl, DATABASE_URL_FILE: '' }, async () =>
    assert.equal(await secret('DATABASE_URL'), databaseUrl),
  );
});

test('config accepts a trimmed file secret only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-config-'));
  const path = join(directory, 'database_url');
  const databaseUrl = testDatabaseUrl();
  await writeFile(path, `${databaseUrl}\n`);
  await withEnvironment({ DATABASE_URL: '', DATABASE_URL_FILE: path }, async () =>
    assert.equal(await secret('DATABASE_URL'), databaseUrl),
  );
});

test('config rejects simultaneous direct and file secrets without exposing values', async () => {
  await withEnvironment(
    { DATABASE_URL: testDatabaseUrl(), DATABASE_URL_FILE: '/secret/path' },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'Define exactly one of DATABASE_URL or DATABASE_URL_FILE',
      }),
  );
});

test('config rejects a missing secret', async () => {
  await withEnvironment(
    { DATABASE_URL: '', DATABASE_URL_FILE: '' },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'Define exactly one of DATABASE_URL or DATABASE_URL_FILE',
      }),
  );
});

test('config rejects an empty file secret without exposing its path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-config-'));
  const path = join(directory, 'database_url');
  await writeFile(path, '\n');
  await withEnvironment(
    { DATABASE_URL: '', DATABASE_URL_FILE: path },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'DATABASE_URL_FILE must reference a readable non-empty file',
      }),
  );
});

test('library-root parser normalizes paths and produces a stable generation', () => {
  const parsed = parseAllowedRoots(
    '[{"id":"zeta","path":"/library/zeta/../zeta/"},{"id":"alpha","path":"/library/alpha"}]',
  );
  assert.deepEqual(parsed.roots, [
    { id: 'alpha', path: '/library/alpha' },
    { id: 'zeta', path: '/library/zeta' },
  ]);
  assert.equal(parsed.generation.length, 64);
  const reordered = parseAllowedRoots(
    '[{"id":"zeta","path":"/library/zeta"},{"id":"alpha","path":"/library/alpha"}]',
  );
  assert.equal(parsed.canonicalJson, reordered.canonicalJson);
  assert.equal(parsed.generation, reordered.generation);
});

test('library-root canonical generation uses deterministic code-unit id ordering', () => {
  const first = parseAllowedRoots(
    '[{"id":"ab","path":"/library/ab"},{"id":"a-b","path":"/library/a-b"}]',
  );
  const second = parseAllowedRoots(
    '[{"id":"a-b","path":"/library/a-b"},{"id":"ab","path":"/library/ab"}]',
  );
  assert.deepEqual(
    first.roots.map((root) => root.id),
    ['a-b', 'ab'],
  );
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.generation, second.generation);
});

test('library-root parser rejects malformed, unknown, Unicode, oversized, and overlapping input', () => {
  for (const value of [
    '{',
    '[{"id":"ok","path":"/library","extra":true}]',
    '[{"id":"é","path":"/library"}]',
    '[{"id":"root","path":"/"}]',
    '[{"id":"one","path":"/library"},{"id":"two","path":"/library/sub"}]',
    JSON.stringify(
      Array.from({ length: 65 }, (_, index) => ({
        id: `root-${index}`,
        path: `/library/${index}`,
      })),
    ),
  ])
    assert.throws(() => parseAllowedRoots(value), LibraryRootConfigError);
});

test('library-root parser rejects line terminators in IDs and NUL in paths', () => {
  for (const value of [
    '[{"id":"valid\\n","path":"/library"}]',
    '[{"id":"valid\\u2028","path":"/library"}]',
    '[{"id":"valid","path":"/library\\u0000suffix"}]',
  ])
    assert.throws(() => parseAllowedRoots(value), LibraryRootConfigError);
});

test('library-root validation classifies real empty, nonempty, missing, and non-directory paths without writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-roots-'));
  const empty = join(directory, 'empty');
  const nonempty = join(directory, 'nonempty');
  const file = join(directory, 'file');
  await mkdir(empty);
  await mkdir(nonempty);
  await writeFile(join(nonempty, 'comic.cbz'), 'fixture');
  await writeFile(file, 'fixture');
  const before = await lstat(file);
  const snapshots = await validateLibraryRoots([
    { id: 'empty', path: empty },
    { id: 'nonempty', path: nonempty },
    { id: 'missing', path: join(directory, 'missing') },
    { id: 'file', path: file },
  ]);
  assert.deepEqual(
    snapshots.map(({ id, state }) => ({ id, state })),
    [
      { id: 'empty', state: 'ready_empty' },
      { id: 'nonempty', state: 'ready_nonempty' },
      { id: 'missing', state: 'missing' },
      { id: 'file', state: 'not_directory' },
    ],
  );
  assert.equal((await lstat(file)).mtimeMs, before.mtimeMs);
});

test('library-root validation rejects root and parent symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-roots-'));
  const target = join(directory, 'target');
  const parent = join(directory, 'parent');
  await mkdir(target);
  await symlink(target, join(directory, 'root-link'));
  await symlink(target, parent);
  await assert.rejects(
    validateLibraryRoots([{ id: 'root', path: join(directory, 'root-link') }]),
    LibraryRootStructuralError,
  );
  await assert.rejects(
    validateLibraryRoots([{ id: 'parent', path: join(parent, '.') }]),
    LibraryRootStructuralError,
  );
});

test('library-root validation rejects canonical overlap and maps injected permission errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-roots-'));
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  await mkdir(first);
  await mkdir(second);
  const fakeDirectory = { read: async () => null, close: async () => undefined };
  const fs = {
    lstat,
    realpath: async (path) => (path === first ? '/canonical/library' : '/canonical/library/nested'),
    opendir: async () => fakeDirectory,
  };
  await assert.rejects(
    validateLibraryRoots(
      [
        { id: 'first', path: first },
        { id: 'second', path: second },
      ],
      fs,
    ),
    LibraryRootStructuralError,
  );
  const denied = await validateLibraryRoots([{ id: 'denied', path: '/library/denied' }], {
    lstat: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
    realpath: fs.realpath,
    opendir: fs.opendir,
  });
  assert.deepEqual(denied[0].state, 'unreadable');
  assert.deepEqual(denied[0].reasonCode, 'EACCES');
});
