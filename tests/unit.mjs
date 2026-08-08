import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
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
const { inspectCbz, scanRoot } = await import('../packages/discovery-scanner/src/index.ts');
const encryptedCbz = Buffer.from(
  'UEsDBAoACQAAAIVOCF2vkRsVIQAAABUAAAAIABwAcGFnZS5qcGdVVAkAA0r8dmpK/HZqdXgLAAEE6AMAAARkAAAADs+a2joAGpSwmOXBRggO4AmBwyUoGVsL/3/bZ+ZlJe4kUEsHCK+RGxUhAAAAFQAAAFBLAQIeAwoACQAAAIVOCF2vkRsVIQAAABUAAAAIABgAAAAAAAEAAACkgQAAAABwYWdlLmpwZ1VUBQADSvx2anV4CwABBOgDAAAEZAAAAFBLBQYAAAAAAQABAE4AAABzAAAAAAA=',
  'base64',
);
const zip64Cbz = Buffer.from(
  'UEsDBC0AAAgIAN2eCF1GE6D2//////////8PABQA56ysMeipsS8wMDEuanBnAQAQABUAAAAAAAAAFwAAAAAAAAArycyr1M0qSE3XLchJTE7NyM9JSS0CAFBLAQItAy0AAAgIAN2eCF1GE6D2//////////8PABQAAAAAAAAAAACAAQAAAADnrKwx6KmxLzAwMS5qcGcBABAAFQAAAAAAAAAXAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAABRAAAAAAAAAFgAAAAAAAAAUEsGBwAAAACpAAAAAAAAAAEAAABQSwUGAAAAAP///////////////wAA',
  'base64',
);

function zip(entries) {
  let offset = 0;
  const locals = [];
  const central = [];
  for (const entry of entries) {
    const { name, encrypted = false } = entry;
    const data = entry.data ?? Buffer.alloc(encrypted ? 12 : 0);
    const fileName = Buffer.from(name);
    const flags = (encrypted ? 1 : 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const record = Buffer.concat([local, fileName, data]);
    locals.push(record);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(fileName.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([directory, fileName]));
    offset += record.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('discovery scanner recognizes CBZ pages, rejects unsafe archives, and enforces injectable quotas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-scanner-'));
  const archive = join(directory, 'comic.CBZ');
  await writeFile(archive, zip([{ name: '10.JPG' }, { name: '2.jpg' }, { name: '１.png' }]));
  assert.deepEqual((await inspectCbz(archive)).pages, ['１.png', '2.jpg', '10.JPG']);

  await writeFile(join(directory, 'encrypted.cbz'), encryptedCbz);
  assert.equal(
    (await inspectCbz(join(directory, 'encrypted.cbz'))).quarantinedReason,
    'encrypted_archive',
  );
  await writeFile(join(directory, 'traversal.cbz'), zip([{ name: '../1.jpg' }]));
  assert.equal(
    (await inspectCbz(join(directory, 'traversal.cbz'))).quarantinedReason,
    'archive_path_traversal',
  );
  await writeFile(
    join(directory, 'duplicate.cbz'),
    zip([{ name: 'é.jpg' }, { name: 'e\u0301.jpg' }]),
  );
  assert.equal(
    (await inspectCbz(join(directory, 'duplicate.cbz'))).quarantinedReason,
    'duplicate_page_locator',
  );
  assert.equal(
    (await inspectCbz(archive, { entries: 1 })).quarantinedReason,
    'archive_entry_limit',
  );
});

test('CBZ inspection closes its owned descriptor after success and quarantine', async () => {
  if (process.platform !== 'linux') return;
  const directory = await mkdtemp(join(tmpdir(), 'gutter-scanner-fd-'));
  const archive = join(directory, 'comic.cbz');
  await writeFile(archive, zip([{ name: '1.jpg' }]));
  const descriptors = async () => (await readdir('/proc/self/fd')).length;
  const before = await descriptors();
  await inspectCbz(archive);
  await inspectCbz(join(directory, 'missing.cbz'));
  assert.equal(await descriptors(), before);
});

test('CBZ inspection supports Zip64 descriptors and preserves ordered locators', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-scanner-zip64-'));
  const archive = join(directory, 'zip64.cbz');
  await writeFile(archive, zip64Cbz);
  assert.equal(zip64Cbz.includes(Buffer.from('PK\x06\x06')), true);
  assert.equal(zip64Cbz.includes(Buffer.from('PK\x06\x07')), true);
  const ordinaryEocd = zip64Cbz.lastIndexOf(Buffer.from('PK\x05\x06'));
  assert.notEqual(ordinaryEocd, -1);
  assert.deepEqual(
    [...zip64Cbz.subarray(ordinaryEocd + 8, ordinaryEocd + 12)],
    [0xff, 0xff, 0xff, 0xff],
  );
  assert.deepEqual(
    [...zip64Cbz.subarray(ordinaryEocd + 12, ordinaryEocd + 20)],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
  const inspected = await inspectCbz(archive);
  assert.deepEqual(inspected.pages, ['第1話/001.jpg']);
  assert.equal(inspected.pages.length, 1);
  if (process.platform === 'linux') {
    const descriptors = async () => (await readdir('/proc/self/fd')).length;
    const before = await descriptors();
    await inspectCbz(archive);
    assert.equal(await descriptors(), before);
  }
});

test('CBZ inspection aborts mid-central-directory and leaves the source unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-scanner-abort-'));
  const archive = join(directory, 'many.cbz');
  const source = zip(Array.from({ length: 4_000 }, (_, index) => ({ name: `${index}.jpg` })));
  await writeFile(archive, source);
  const controller = new AbortController();
  const inspection = inspectCbz(archive, {}, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  await assert.rejects(inspection, { name: 'AbortError' });
  assert.deepEqual(await readFile(archive), source);
});

test('discovery scanner uses bounded leaf directories, ignores symlinks, and propagates aborts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-'));
  await mkdir(join(root, 'chapter'));
  await mkdir(join(root, 'chapter', 'nested'));
  await writeFile(join(root, 'chapter', '1.jpg'), 'page');
  await writeFile(join(root, 'chapter', 'nested', '2.PNG'), 'page');
  await symlink(join(root, 'chapter'), join(root, 'linked-chapter'));
  const result = await scanRoot(root);
  assert.deepEqual(
    result.items.map((item) => item.relativePath),
    ['chapter/nested'],
  );
  assert.equal(result.summary.mixedParents, 1);
  assert.equal(result.summary.symlinks, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanRoot(root, controller.signal), { name: 'AbortError' });
});

test('discovery scanner treats a depth cutoff as an unknown descendant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-depth-'));
  let parent = root;
  for (let depth = 0; depth < 128; depth += 1) {
    parent = join(parent, 'd');
    await mkdir(parent);
  }
  await writeFile(join(parent, 'direct.jpg'), 'page');
  await mkdir(join(parent, 'below-cutoff'));
  await writeFile(join(parent, 'below-cutoff', 'nested.jpg'), 'page');
  const result = await scanRoot(root);
  assert.equal(
    result.items.some((item) => item.relativePath.endsWith('/d')),
    false,
  );
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.mixedParents, 1);
});

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
  assert.equal(schemaVersion, '0002_source_inventory');
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
