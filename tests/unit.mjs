import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { authConfig, schemaVersion, secret } = await import('../packages/config/src/index.ts');
const {
  LibraryRootConfigError,
  LibraryRootStructuralError,
  parseAllowedRoots,
  validateLibraryRoots,
} = await import('../packages/library-roots/src/index.ts');
const { inspectCbz, scanRoot, scanRootBatched } =
  await import('../packages/discovery-scanner/src/index.ts');
const { parseComicInfo } = await import('../packages/comic-info/src/index.ts');
const {
  canonicalIdentity,
  decodeCatalogCursor,
  encodeCatalogCursor,
  identityHash,
  identityText,
  normalizeCatalogFilters,
  publicationKind,
  searchKey,
} = await import('../packages/catalog-domain/src/index.ts');
const { startWatcherHints } = await import('../apps/worker/src/watcher-hints.ts');
const { assertCacheReady } = await import('../apps/worker/src/cache-status.ts');
const { dispatchReconciliationRequests } = await import('../apps/worker/src/discovery-queue.ts');
const { signReaderCapability, verifyReaderCapability } =
  await import('../packages/reader-stream/src/index.ts');
const encryptedCbz = Buffer.from(
  'UEsDBAoACQAAAIVOCF2vkRsVIQAAABUAAAAIABwAcGFnZS5qcGdVVAkAA0r8dmpK/HZqdXgLAAEE6AMAAARkAAAADs+a2joAGpSwmOXBRggO4AmBwyUoGVsL/3/bZ+ZlJe4kUEsHCK+RGxUhAAAAFQAAAFBLAQIeAwoACQAAAIVOCF2vkRsVIQAAABUAAAAIABgAAAAAAAEAAACkgQAAAABwYWdlLmpwZ1VUBQADSvx2anV4CwABBOgDAAAEZAAAAFBLBQYAAAAAAQABAE4AAABzAAAAAAA=',
  'base64',
);
const zip64Cbz = Buffer.from(
  'UEsDBC0AAAgIAN2eCF1GE6D2//////////8PABQA56ysMeipsS8wMDEuanBnAQAQABUAAAAAAAAAFwAAAAAAAAArycyr1M0qSE3XLchJTE7NyM9JSS0CAFBLAQItAy0AAAgIAN2eCF1GE6D2//////////8PABQAAAAAAAAAAACAAQAAAADnrKwx6KmxLzAwMS5qcGcBABAAFQAAAAAAAAAXAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAABRAAAAAAAAAFgAAAAAAAAAUEsGBwAAAACpAAAAAAAAAAEAAABQSwUGAAAAAP///////////////wAA',
  'base64',
);

test('catalog identity is deterministic, exact, and separate from search normalization', () => {
  assert.equal(identityText('  Ａ\u3000Ｂ  '), 'A B');
  assert.equal(identityText(' \t '), null);
  assert.notEqual(identityText('Alpha'), identityText('alpha'));
  assert.equal(searchKey('ＡLPHA'), 'alpha');
  assert.equal(publicationKind('Art Book'), 'artbook');
  assert.equal(publicationKind('OneShot'), 'special');
  assert.equal(publicationKind('Comic'), 'issue');
  assert.equal(publicationKind('unrecognized'), 'volume');
  assert.notEqual(identityHash([1, '01']), identityHash([1, '1']));
  assert.deepEqual(canonicalIdentity([1, 'Series']).canonicalJson, '[1,"Series"]');
});

test('catalog cursors keep database IDs and microsecond timestamps lossless', () => {
  const filters = normalizeCatalogFilters({
    q: ' Ａ ',
    sort: 'metadata_updated',
    direction: 'desc',
    limit: 999,
  });
  assert.equal(filters.q, 'a');
  assert.equal(filters.limit, 100);
  const cursor = {
    v: 1,
    scope: 'series',
    sort: 'metadata_updated',
    direction: 'desc',
    filterHash: 'a'.repeat(64),
    tuple: ['2026-08-09T12:34:56.123456Z', '9007199254740993'],
  };
  assert.deepEqual(decodeCatalogCursor(encodeCatalogCursor(cursor)), cursor);
  assert.equal(
    decodeCatalogCursor(encodeCatalogCursor({ ...cursor, tuple: ['not-a-timestamp', '1'] })),
    null,
  );
  assert.equal(
    decodeCatalogCursor(
      encodeCatalogCursor({ ...cursor, sort: 'source_updated', tuple: ['1.5', '1'] }),
    ),
    null,
  );
});

test('reader capabilities are short-lived and bound to the exact internal route', () => {
  const secret = 'reader-capability-unit-secret-at-least-32-bytes';
  const now = 1_800_000_000_000;
  const path = '/api/reader/releases/42/pages/3';
  const token = signReaderCapability(
    secret,
    { userId: 'user-a', rootId: 'root-a', path, aclRevision: 7 },
    now,
  );
  const verified = verifyReaderCapability(secret, token, path, now + 9_000);
  assert.equal(verified?.userId, 'user-a');
  assert.equal(verified?.rootId, 'root-a');
  assert.equal(verified?.aclRevision, 7);
  assert.match(verified?.nonce ?? '', /^[A-Za-z0-9_-]{22}$/);
  assert.equal(verifyReaderCapability(secret, token, '/api/reader/releases/42/pages/4', now), null);
  assert.equal(verifyReaderCapability(`${secret}x`, token, path, now), null);
  assert.equal(verifyReaderCapability(secret, `${token}x`, path, now), null);
  assert.equal(verifyReaderCapability(secret, token, path, now + 11_000), null);
});

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
  assert.deepEqual(
    (await inspectCbz(archive)).pages.map((page) => page.locator),
    ['１.png', '2.jpg', '10.JPG'],
  );
  assert.equal(
    (await scanRoot(directory)).items.some((item) => item.relativePath === 'comic.CBZ'),
    true,
  );

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

test('ComicInfo is bounded, UTF-8-only, and preserves source page authority', async () => {
  const benign = parseComicInfo(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><ComicInfo><Title>A &amp; B</Title><Writer>One, Two</Writer><Pages><Page Image="0" Type="FrontCover"/></Pages></ComicInfo>',
    ),
  );
  assert.equal(benign.document?.fields.title, 'A & B');
  assert.deepEqual(benign.document?.fields.writers, ['One', 'Two']);
  assert.equal(benign.document?.pageAnnotations[0]?.type, 'FrontCover');
  const edgeCases = parseComicInfo(
    Buffer.from(
      '<ComicInfo><Title> </Title><Writer>One, , One, Two</Writer><Pages><Page Image="0"/><Page Image="0"/></Pages></ComicInfo>',
    ),
  );
  assert.equal(edgeCases.document?.fields.title, undefined);
  assert.deepEqual(edgeCases.document?.fields.writers, ['One', 'Two']);
  assert.equal(edgeCases.document?.pageAnnotations.length, 1);
  assert.equal(
    edgeCases.issues.some((entry) => entry.code === 'page_duplicate_image'),
    true,
  );
  const longScalar = parseComicInfo(
    Buffer.from(`<ComicInfo><Title>${'a'.repeat(4097)}</Title></ComicInfo>`),
  );
  assert.equal(longScalar.document?.fields.title.length, 4097);
  const tooLongScalar = parseComicInfo(
    Buffer.from(`<ComicInfo><Title>${'a'.repeat(64 * 1024 + 1)}</Title></ComicInfo>`),
  );
  assert.equal(tooLongScalar.document?.fields.title, undefined);
  for (const xml of [
    '<!DOCTYPE ComicInfo [<!ENTITY x "x">]><ComicInfo/>',
    '<x:ComicInfo xmlns:x="urn:x"/>',
    '<ComicInfo xmlns:x="urn:x"><Title>ok</Title></ComicInfo>',
    '<ComicInfo><Title x:flag="1">ok</Title></ComicInfo>',
  ])
    assert.equal(parseComicInfo(Buffer.from(xml)).document, null);
  assert.equal(
    parseComicInfo(
      Buffer.from('<ComicInfo><Notes><![CDATA[literal <!DOCTYPE text]]></Notes></ComicInfo>'),
    ).document?.fields.notes,
    'literal <!DOCTYPE text',
  );
  assert.equal(
    parseComicInfo(
      Buffer.from(
        '<ComicInfo><!-- literal <!DOCTYPE text --><Title>comment-safe</Title></ComicInfo>',
      ),
    ).document?.fields.title,
    'comment-safe',
  );
  for (const [field, value] of [
    ['Manga', 'Unknown'],
    ['BlackAndWhite', 'Unknown'],
    ['AgeRating', 'Unknown'],
    ['CommunityRating', '1'],
  ])
    assert.equal(
      parseComicInfo(
        Buffer.from(
          `<ComicInfo><${field}>${value}</${field}><${field}>${value}</${field}></ComicInfo>`,
        ),
      ).document,
      null,
    );

  const directory = await mkdtemp(join(tmpdir(), 'gutter-comicinfo-'));
  await mkdir(join(directory, 'chapter'));
  await writeFile(join(directory, 'chapter', '1.jpg'), 'page');
  const comicInfoPath = join(directory, 'chapter', 'comicinfo.xml');
  await writeFile(
    comicInfoPath,
    '<ComicInfo><Title>Metadata title</Title><Pages><Page Image="7"/></Pages></ComicInfo>',
  );
  const stableTime = new Date(Date.now() - 5_000);
  await utimes(comicInfoPath, stableTime, stableTime);
  const scanned = await scanRoot(directory);
  assert.equal(scanned.items[0]?.comicInfo?.document?.fields.title, 'Metadata title');
  assert.equal(scanned.items[0]?.comicInfo?.document?.pageAnnotations[0]?.image, 7);
  assert.equal(
    scanned.items[0]?.scanIssues?.some((entry) => entry.code === 'comicinfo_noncanonical_name'),
    true,
  );

  const archive = join(directory, 'metadata.cbz');
  await writeFile(
    archive,
    zip([
      {
        name: 'ComicInfo.xml',
        data: Buffer.from('<ComicInfo><Title>CBZ metadata</Title></ComicInfo>'),
      },
      { name: '001.jpg' },
    ]),
  );
  assert.equal((await inspectCbz(archive)).comicInfo?.document?.fields.title, 'CBZ metadata');
  const oversized = join(directory, 'oversized.cbz');
  await writeFile(
    oversized,
    zip([{ name: 'ComicInfo.xml', data: Buffer.alloc(1024 * 1024 + 1, 65) }, { name: '001.jpg' }]),
  );
  assert.equal((await inspectCbz(oversized)).comicInfo?.document, null);
  assert.equal((await inspectCbz(oversized)).comicInfo?.issues[0]?.code, 'document_too_large');
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

test('CBZ outer observation mismatch is deferred instead of quarantined', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-scanner-snapshot-'));
  const archive = join(directory, 'comic.cbz');
  await writeFile(archive, zip([{ name: '1.jpg' }]));
  const stat = await lstat(archive, { bigint: true });
  const result = await inspectCbz(archive, {}, undefined, undefined, 0, {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size + 1n,
    mtimeNs: stat.mtimeNs,
  });
  assert.equal(result.deferredReason, 'unstable');
  assert.equal(result.quarantinedReason, null);
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
  assert.deepEqual(
    inspected.pages.map((page) => page.locator),
    ['第1話/001.jpg'],
  );
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

test('streaming discovery emits bounded candidate batches without retaining worker results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-stream-'));
  for (let index = 0; index < 101; index += 1) {
    const chapter = join(root, `chapter-${index}`);
    await mkdir(chapter);
    await writeFile(join(chapter, '1.jpg'), 'page');
  }
  const batches = [];
  const result = await scanRootBatched(root, {
    collect: false,
    onItems: (items) => batches.push(items.length),
  });
  assert.deepEqual(batches, [100, 1]);
  assert.deepEqual(result.items, []);
});

test('scanner pulse cancellation is observed while traversing flat files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-pulse-'));
  for (let index = 0; index < 1_000; index += 1) await writeFile(join(root, `${index}.txt`), 'x');
  let pulses = 0;
  await assert.rejects(
    scanRootBatched(root, {
      pulse: () => {
        pulses += 1;
        if (pulses >= 2) throw new DOMException('cancelled', 'AbortError');
      },
    }),
    { name: 'AbortError' },
  );
  assert.ok(pulses >= 2);
});

test('directory page scanning bounds lease pulses while checking cancellation locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-directory-pulse-'));
  const chapter = join(root, 'chapter');
  await mkdir(chapter);
  for (let index = 0; index < 1_000; index += 1)
    await writeFile(join(chapter, `${index}.jpg`), 'page');
  let pulses = 0;
  const scanned = await scanRootBatched(root, {
    pulse: () => {
      pulses += 1;
    },
  });
  assert.equal(scanned.summary.pages, 1_000);
  assert.ok(pulses < 100, `expected bounded pulses, received ${pulses}`);
});

test('unreadable directory page candidates are protected with bounded attempt-ordinal pulses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scanner-unreadable-pages-'));
  const chapter = join(root, 'chapter');
  await mkdir(chapter);
  for (let index = 0; index < 1_000; index += 1)
    await writeFile(join(chapter, `${index}.jpg`), 'page');
  let pulses = 0;
  const protectedPaths = [];
  await scanRootBatched(root, {
    collect: false,
    pulse: () => {
      pulses += 1;
    },
    openPage: async () => {
      const error = new Error('transient page read failure');
      Object.assign(error, { code: 'EIO' });
      throw error;
    },
    onProtected: (paths) => protectedPaths.push(...paths),
  });
  assert.deepEqual(protectedPaths, ['chapter']);
  assert.ok(pulses < 50, `expected bounded pulses, received ${pulses}`);
});

test('watcher hints are optional, trailing, pathless, and error-isolated', async () => {
  let created = 0;
  const disabled = startWatcherHints({
    roots: new Map([['root', { canonicalPath: '/library' }]]),
    enabled: false,
    debounceMs: 5_000,
    request: async () => undefined,
    log: { error: () => undefined },
    watchFactory: () => {
      created += 1;
      throw new Error('should not watch');
    },
  });
  await disabled.close();
  assert.equal(created, 0);

  const handlers = new Map();
  const timers = [];
  const requested = [];
  const errors = [];
  const watcher = {
    on(event, listener) {
      handlers.set(event, listener);
      return this;
    },
    close: async () => {
      throw new Error('close');
    },
  };
  const active = startWatcherHints({
    roots: new Map([['root', { canonicalPath: '/library' }]]),
    enabled: true,
    debounceMs: 5_000,
    request: async (id) => requested.push(id),
    log: { error: (data) => errors.push(data.code) },
    watchFactory: () => watcher,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'])
    handlers.get(event)('/library/a');
  handlers.get('error')(new Error('watcher'));
  assert.equal(timers.length, 1);
  timers[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, ['root']);
  await active.close();
  assert.ok(errors.includes('WATCHER_FAILED'));
  assert.ok(errors.includes('WATCHER_CLOSE_FAILED'));
});

test('dispatcher immediately requeues failed and unsent request claims', async () => {
  const sent = [];
  const requeued = [];
  await assert.rejects(
    dispatchReconciliationRequests(
      {
        send: async (_queue, payload) => {
          sent.push(payload.requestId);
          if (payload.requestId === 'two') throw new Error('send');
          return 'job';
        },
      },
      async () => [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
      async (id) => requeued.push(id),
    ),
  );
  assert.deepEqual(sent, ['one', 'two']);
  assert.deepEqual(requeued.sort(), ['three', 'two']);
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

test('M5 documents the access-control schema version', () => {
  assert.equal(schemaVersion, '0014_qualified_progress_digest');
});

test('catalog UI exposes entity discovery and publication credit links', async () => {
  const [catalog, publication, entities] = await Promise.all([
    readFile(join(process.cwd(), 'apps/web/src/routes/+page.svelte'), 'utf8'),
    readFile(join(process.cwd(), 'apps/web/src/routes/publications/[id]/+page.svelte'), 'utf8'),
    readFile(join(process.cwd(), 'apps/web/src/routes/[entity=entity]/+page.svelte'), 'utf8'),
  ]);
  assert.match(catalog, /href="\/creators"/);
  assert.match(catalog, /href="\/groups"/);
  assert.match(catalog, /href="\/publishers"/);
  assert.match(publication, /credit\.kind/);
  assert.match(entities, /\/api\/catalog\/\$\{data\.entity\}/);
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
  await withEnvironment(
    {
      BETTER_AUTH_SECRET: 'test-auth-secret-not-a-production-secret',
      BETTER_AUTH_SECRET_FILE: '',
      GUTTER_AUTH_ORIGIN: 'https://gutter.example.test',
      GUTTER_AUTH_TRUSTED_PROXIES_JSON: '["172.30.0.20"]',
    },
    async () => assert.equal((await authConfig()).secureCookies, true),
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

test('auth config permits insecure cookies only on localhost and binds the exact proxy', async () => {
  await withEnvironment(
    {
      BETTER_AUTH_SECRET: 'test-auth-secret-not-a-production-secret',
      BETTER_AUTH_SECRET_FILE: '',
      GUTTER_AUTH_ORIGIN: 'http://localhost:8080',
      GUTTER_AUTH_TRUSTED_PROXIES_JSON: '["172.30.0.20"]',
    },
    async () =>
      assert.deepEqual(await authConfig(), {
        secret: 'test-auth-secret-not-a-production-secret',
        origin: 'http://localhost:8080',
        trustedProxies: ['172.30.0.20'],
        secureCookies: false,
      }),
  );
  await withEnvironment(
    {
      BETTER_AUTH_SECRET: 'test-auth-secret-not-a-production-secret',
      BETTER_AUTH_SECRET_FILE: '',
      GUTTER_AUTH_ORIGIN: 'http://lan.example.test',
      GUTTER_AUTH_TRUSTED_PROXIES_JSON: '[]',
    },
    async () =>
      await assert.rejects(authConfig(), {
        message: 'GUTTER_AUTH_ORIGIN must use https outside localhost',
      }),
  );
});

test('auth proxy preserves the Better Auth path without stale fixed network identities', async () => {
  const [caddy, compose] = await Promise.all([
    readFile(join(process.cwd(), 'Caddyfile'), 'utf8'),
    readFile(join(process.cwd(), 'compose.yaml'), 'utf8'),
  ]);
  assert.match(caddy, /handle \/api\/auth\/\*/);
  assert.match(caddy, /handle \/api\/reader\/\*[\s\S]*?reverse_proxy api:3000/);
  assert.doesNotMatch(caddy, /handle \/api\/reader\/\*[\s\S]*?reverse_proxy worker:3001/);
  assert.match(compose, /GUTTER_AUTH_TRUSTED_PROXIES_JSON: '\[\]'/);
  assert.match(compose, /DATABASE_USER: gutter_api/);
  assert.match(compose, /DATABASE_USER: gutter_worker/);
  assert.match(compose, /GUTTER_READER_CAPABILITY_SECRET_FILE/);
  assert.doesNotMatch(compose, /ipv4_address:|subnet:/);
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

test('worker cache readiness requires an existing writable directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-cache-ready-'));
  await assertCacheReady(root);
  await assert.rejects(assertCacheReady(join(root, 'missing')));
  const file = join(root, 'file');
  await writeFile(file, 'not a directory');
  await assert.rejects(assertCacheReady(file));
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
