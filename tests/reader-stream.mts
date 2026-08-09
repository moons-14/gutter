import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { lstat, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  ReaderStreamError,
  ReaderStreamLimiter,
  openReaderStream,
  type ReaderPage,
  type ReaderSource,
} from '../packages/reader-stream/src/index.ts';

async function source(
  root: string,
  relativePath: string,
  kind: ReaderSource['kind'],
): Promise<ReaderSource> {
  const stat = await lstat(join(root, relativePath), { bigint: true });
  return {
    root,
    relativePath,
    kind,
    observed: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs },
  };
}
async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function storedZip(name: string, data: Buffer): Buffer {
  // Deterministic real ZIP fixture: one stored UTF-8 entry, fixed DOS timestamp, valid central CRC.
  const filename = Buffer.from(name);
  const checksum = crc32(data) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
function centralOffset(name: string, data: Buffer): number {
  return 30 + Buffer.byteLength(name) + data.length;
}
function page(locator: string, data: Buffer): ReaderPage {
  return {
    locator,
    observed: {
      size: data.length,
      uncompressedSize: data.length,
      compressedSize: data.length,
      crc32: crc32(data) >>> 0,
    },
  };
}
const zip64Cbz = Buffer.from(
  'UEsDBC0AAAgIAN2eCF1GE6D2//////////8PABQA56ysMeipsS8wMDEuanBnAQAQABUAAAAAAAAAFwAAAAAAAAArycyr1M0qSE3XLchJTE7NyM9JSS0CAFBLAQItAy0AAAgIAN2eCF1GE6D2//////////8PABQAAAAAAAAAAACAAQAAAADnrKwx6KmxLzAwMS5qcGcBABAAFQAAAAAAAAAXAAAAAAAAAFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAABRAAAAAAAAAFgAAAAAAAAAUEsGBwAAAACpAAAAAAAAAAEAAABQSwUGAAAAAP///////////////wAA',
  'base64',
);
const encryptedCbz = Buffer.from(
  'UEsDBAoACQAAAIVOCF2vkRsVIQAAABUAAAAIABwAcGFnZS5qcGdVVAkAA0r8dmpK/HZqdXgLAAEE6AMAAARkAAAADs+a2joAGpSwmOXBRggO4AmBwyUoGVsL/3/bZ+ZlJe4kUEsHCK+RGxUhAAAAFQAAAFBLAQIeAwoACQAAAIVOCF2vkRsVIQAAABUAAAAIABgAAAAAAAEAAACkgQAAAABwYWdlLmpwZ1VUBQADSvx2anV4CwABBOgDAAAEZAAAAFBLBQYAAAAAAQABAE4AAABzAAAAAAA=',
  'base64',
);
async function expectCode(input: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    input,
    (error: unknown) => error instanceof ReaderStreamError && error.code === code,
  );
}

test('directory streams use no-follow observations, bounded chunks, and preserve source bytes and snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-directory-'));
  const data = Buffer.alloc(150_000, 7);
  await writeFile(join(root, '001.jpg'), data);
  const before = await lstat(join(root, '001.jpg'), { bigint: true });
  const directory = await source(root, '.', 'directory');
  const opened = await openReaderStream({
    source: directory,
    page: { locator: '001.jpg', observed: { size: data.length, mtimeNs: before.mtimeNs } },
    limits: { chunkBytes: 16 * 1024 },
  });
  assert.deepEqual(await bytes(opened.stream), data);
  const after = await lstat(join(root, '001.jpg'), { bigint: true });
  assert.deepEqual(
    { size: after.size, mtimeNs: after.mtimeNs, ino: after.ino },
    { size: before.size, mtimeNs: before.mtimeNs, ino: before.ino },
  );
  assert.deepEqual(await readFile(join(root, '001.jpg')), data);

  await symlink(join(root, '001.jpg'), join(root, 'link.jpg'));
  const currentDirectory = await source(root, '.', 'directory');
  await expectCode(
    openReaderStream({
      source: currentDirectory,
      page: { locator: 'link.jpg', observed: { size: data.length } },
    }),
    'source_unavailable',
  );
  await expectCode(
    openReaderStream({
      source: currentDirectory,
      page: { locator: '../001.jpg', observed: { size: data.length } },
    }),
    'locator_unsafe',
  );
  await expectCode(
    openReaderStream({
      source: currentDirectory,
      page: { locator: '001.txt', observed: { size: data.length } },
    }),
    'unsupported_media',
  );
});

test('CBZ streams a real Zip64 fixture and rejects central CRC mismatch without source mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cbz-'));
  const data = Buffer.from('real CBZ page fixture');
  const archive = storedZip('001.jpg', data);
  await writeFile(join(root, 'comic.cbz'), archive);
  const before = await lstat(join(root, 'comic.cbz'), { bigint: true });
  const pageObservation = page('001.jpg', data);
  const opened = await openReaderStream({
    source: await source(root, 'comic.cbz', 'cbz'),
    page: pageObservation,
  });
  assert.deepEqual(await bytes(opened.stream), data);
  await expectCode(
    openReaderStream({
      source: await source(root, 'comic.cbz', 'cbz'),
      page: { ...pageObservation, observed: { ...pageObservation.observed, crc32: 0 } },
    }),
    'source_stale',
  );
  const after = await lstat(join(root, 'comic.cbz'), { bigint: true });
  assert.deepEqual(
    { size: after.size, mtimeNs: after.mtimeNs, ino: after.ino },
    { size: before.size, mtimeNs: before.mtimeNs, ino: before.ino },
  );
  assert.deepEqual(await readFile(join(root, 'comic.cbz')), archive);

  await writeFile(join(root, 'zip64.cbz'), zip64Cbz);
  assert.equal(zip64Cbz.includes(Buffer.from('PK\x06\x06')), true);
  const zip64 = await openReaderStream({
    source: await source(root, 'zip64.cbz', 'cbz'),
    page: { locator: '第1話/001.jpg', observed: { size: 21 } },
  });
  assert.equal((await bytes(zip64.stream)).length, 21);
});

test('CBZ rejects unsafe, encrypted, and quota-exceeding central directory entries with stable codes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cbz-policy-'));
  const data = Buffer.from('page');
  await writeFile(join(root, 'unsafe.cbz'), storedZip('../001.jpg', data));
  await expectCode(
    openReaderStream({
      source: await source(root, 'unsafe.cbz', 'cbz'),
      page: { locator: '001.jpg', observed: { size: data.length } },
    }),
    'archive_path_unsafe',
  );
  await writeFile(join(root, 'encrypted.cbz'), encryptedCbz);
  await expectCode(
    openReaderStream({
      source: await source(root, 'encrypted.cbz', 'cbz'),
      page: { locator: 'page.jpg', observed: { size: 21 } },
    }),
    'archive_encrypted',
  );
  await writeFile(join(root, 'quota.cbz'), storedZip('001.jpg', data));
  await expectCode(
    openReaderStream({
      source: await source(root, 'quota.cbz', 'cbz'),
      page: { locator: '001.jpg', observed: { size: data.length } },
      limits: { archiveEntries: 0 },
    }),
    'archive_entry_limit',
  );
});

test('CBZ detects stream-time payload corruption and releases the permit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cbz-crc-'));
  const data = Buffer.from('central CRC stays unchanged');
  const archive = storedZip('001.jpg', data);
  archive[30 + Buffer.byteLength('001.jpg')]! ^= 1;
  await writeFile(join(root, 'corrupt.cbz'), archive);
  const limiter = new ReaderStreamLimiter(1, 0);
  const opened = await openReaderStream({
    source: await source(root, 'corrupt.cbz', 'cbz'),
    page: { locator: '001.jpg', observed: { size: data.length } },
    limiter,
  });
  await expectCode(bytes(opened.stream), 'archive_corrupt');
  assert.equal(limiter.active, 0);
});

test('CBZ cancellation during central-directory enumeration closes the archive and releases its permit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cbz-cancel-'));
  const data = Buffer.from('cancel while enumerating');
  await writeFile(join(root, 'comic.cbz'), storedZip('001.jpg', data));
  const controller = new AbortController();
  const limiter = new ReaderStreamLimiter(1, 0);
  await expectCode(
    openReaderStream({
      source: await source(root, 'comic.cbz', 'cbz'),
      page: page('001.jpg', data),
      signal: controller.signal,
      limiter,
      afterOpen: () => {
        setImmediate(() => controller.abort());
      },
    }),
    'cancelled',
  );
  assert.equal(limiter.active, 0);
});

test('CBZ rejects unsupported media before archive resource acquisition and applies ratios to zero-byte entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-cbz-prebody-'));
  const data = Buffer.from('page');
  await writeFile(join(root, 'comic.cbz'), storedZip('001.jpg', data));
  const limiter = new ReaderStreamLimiter(1, 0);
  await expectCode(
    openReaderStream({
      source: await source(root, 'comic.cbz', 'cbz'),
      page: { locator: '001.txt', observed: { size: data.length } },
      limiter,
    }),
    'unsupported_media',
  );
  assert.equal(limiter.active, 0);
  const valid = await openReaderStream({
    source: await source(root, 'comic.cbz', 'cbz'),
    page: page('001.jpg', data),
    limiter,
  });
  assert.deepEqual(await bytes(valid.stream), data);

  const oversized = Buffer.alloc(201, 5);
  const ratio = storedZip('metadata.bin', oversized);
  ratio.writeUInt16LE(8, 8);
  ratio.writeUInt16LE(8, centralOffset('metadata.bin', oversized) + 10);
  ratio.writeUInt32LE(0, centralOffset('metadata.bin', oversized) + 20);
  await writeFile(join(root, 'ratio.cbz'), ratio);
  await expectCode(
    openReaderStream({
      source: await source(root, 'ratio.cbz', 'cbz'),
      page: { locator: '001.jpg', observed: { size: data.length } },
    }),
    'archive_ratio_limit',
  );
});

test('reader limiter holds permits through actual streams, bounds the queue, and releases on cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-limiter-'));
  const data = Buffer.alloc(32 * 1024, 9);
  await writeFile(join(root, '001.jpg'), data);
  const item = await source(root, '.', 'directory');
  const candidate = () =>
    openReaderStream({
      source: item,
      page: { locator: '001.jpg', observed: { size: data.length } },
      limiter,
      afterOpen: () => barrier,
    });
  const limiter = new ReaderStreamLimiter(2, 1);
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const first = candidate();
  const second = candidate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(limiter.active, 2);
  const third = candidate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(limiter.waiting, 1);
  await expectCode(candidate(), 'queue_full');
  releaseBarrier();
  const firstTwo = await Promise.all([first, second]);
  await Promise.all(firstTwo.map((entry) => bytes(entry.stream)));
  await bytes((await third).stream);
  assert.equal(limiter.active, 0);

  let releaseCancelled!: () => void;
  const cancelledBarrier = new Promise<void>((resolve) => {
    releaseCancelled = resolve;
  });
  const controller = new AbortController();
  const pending = openReaderStream({
    source: item,
    page: { locator: '001.jpg', observed: { size: data.length } },
    limiter,
    signal: controller.signal,
    afterOpen: () => cancelledBarrier,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseCancelled();
  await expectCode(pending, 'cancelled');
  assert.equal(limiter.active, 0);
});

test('pinned directory descriptor prevents mixed bytes when the path is atomically replaced after the barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-reader-replace-'));
  const original = Buffer.from('old source bytes');
  const replacement = Buffer.from('new source bytes');
  await writeFile(join(root, '001.jpg'), original);
  const opened = await openReaderStream({
    source: await source(root, '.', 'directory'),
    page: { locator: '001.jpg', observed: { size: original.length } },
    afterOpen: async () => {
      await writeFile(join(root, 'replacement.jpg'), replacement);
      await rename(join(root, 'replacement.jpg'), join(root, '001.jpg'));
    },
  });
  assert.deepEqual(await bytes(opened.stream), original);
  assert.deepEqual(await readFile(join(root, '001.jpg')), replacement);
});
