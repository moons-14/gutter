import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  ValidationAttemptError,
  validateSourceItem,
} from '../packages/page-validator/src/index.ts';
import { inspectCbz, type ScanItem } from '../packages/discovery-scanner/src/index.ts';
import {
  classifyValidationFailure,
  startValidationQueue,
} from '../apps/worker/src/validation-queue.ts';
import type { ValidationIntent } from '../packages/db/src/index.ts';

function tinyCbz(name: string, bytes: Buffer, deflated: boolean, wrongCentralCrc = false): Buffer {
  const payload = deflated ? deflateRawSync(bytes) : bytes;
  const encodedName = Buffer.from(name);
  const crc = crc32(bytes) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflated ? 8 : 0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(deflated ? 8 : 0, 10);
  central.writeUInt32LE(wrongCentralCrc ? (crc ^ 0xffffffff) >>> 0 : crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  const directoryOffset = local.length + encodedName.length + payload.length;
  const directory = Buffer.concat([central, encodedName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, encodedName, payload, directory, end]);
}

async function fixture(root: string, name: string, contents: Buffer): Promise<ScanItem> {
  const chapter = join(root, 'chapter');
  const path = join(chapter, name);
  await writeFile(path, contents);
  const observed = await stat(path, { bigint: true });
  return {
    relativePath: 'chapter',
    kind: 'directory',
    size: 0,
    mtimeMs: 0,
    pages: [
      {
        locator: name,
        observed: { size: Number(observed.size), mtimeNs: observed.mtimeNs.toString() },
      },
    ],
    quarantinedReason: null,
  };
}

test('page validator performs a real sharp decode, preserves files, and reports bounded skips', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-page-validator-'));
  const chapter = join(root, 'chapter');
  await mkdir(chapter);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const valid = await fixture(root, '1.png', png);
  assert.equal((await validateSourceItem(root, valid)).results[0]?.state, 'valid');
  assert.deepEqual(await readFile(join(chapter, '1.png')), png);

  const mismatch = await fixture(root, '2.jpg', png);
  assert.equal(
    (await validateSourceItem(root, mismatch)).results[0]?.reasonCode,
    'extension_format_mismatch',
  );
  const truncated = await fixture(root, '3.png', png.subarray(0, 12));
  assert.equal((await validateSourceItem(root, truncated)).results[0]?.reasonCode, 'decode_failed');
  assert.equal(
    (
      await validateSourceItem(root, valid, undefined, {
        limits: { pageBytes: 1, totalBytes: 1024, pixels: 100 },
      })
    ).results[0]?.reasonCode,
    'page_byte_limit',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateSourceItem(root, valid, controller.signal), { name: 'AbortError' });

  for (const [name, format] of [
    ['4.jpg', 'jpeg'],
    ['5.webp', 'webp'],
    ['6.gif', 'gif'],
  ] as const) {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'green' } })
      .toFormat(format)
      .toBuffer();
    const candidate = await fixture(root, name, bytes);
    const result = (await validateSourceItem(root, candidate)).results[0];
    assert.equal(result?.state, 'valid');
    assert.equal(result?.format, format);
  }
});

test('CBZ validator accepts stored and deflated bytes but enforces the scanned central CRC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-page-validator-cbz-'));
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
  for (const [name, deflated, wrong] of [
    ['stored.cbz', false, false],
    ['deflated.cbz', true, false],
    ['wrong-crc.cbz', true, true],
  ] as const) {
    const source = tinyCbz('001.png', png, deflated, wrong);
    const path = join(root, name);
    await writeFile(path, source);
    const found = await inspectCbz(path);
    const sourceStat = await stat(path, { bigint: true });
    const item: ScanItem = {
      relativePath: name,
      kind: 'cbz',
      size: Number(sourceStat.size),
      mtimeMs: Number(sourceStat.mtimeNs / 1_000_000n),
      pages: found.pages,
      quarantinedReason: null,
    };
    const result = await validateSourceItem(root, item);
    assert.equal(result.results[0]?.reasonCode, wrong ? 'crc_mismatch' : undefined);
    assert.equal(result.results[0]?.state, wrong ? 'skipped' : 'valid');
    assert.deepEqual(await readFile(path), source);
  }
});

test('validation queue aborts work after a lost heartbeat or timeout without completing it', async () => {
  let handler: ((jobs: readonly { data: ValidationIntent }[]) => Promise<void>) | undefined;
  const boss = {
    createQueue: async () => undefined,
    work: async (_name: string, _options: unknown, callback: typeof handler) => {
      handler = callback;
    },
  };
  const intent: ValidationIntent = {
    sourceItemId: 1,
    manifestSha256: 'a'.repeat(64),
    generation: 1,
    leaseEpoch: 1,
  };
  const source = {
    rootId: 'root',
    relativePath: 'chapter',
    kind: 'directory' as const,
    size: 0,
    mtimeMs: 0,
    pages: [],
  };
  let releaseCount = 0;
  let releasedCode: string | undefined;
  let completeCount = 0;
  let renewCount = 0;
  await startValidationQueue({
    boss: boss as never,
    readyRoots: new Map([['root', { canonicalPath: '/fixture' }]]),
    getSource: async () => source,
    renew: async () => ++renewCount === 1,
    release: async (_intent, code) => {
      releaseCount++;
      releasedCode = code;
    },
    complete: async () => (completeCount++, true),
    validate: async (_root, _item, signal) =>
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
    signal: new AbortController().signal,
    heartbeatMs: 1,
  });
  assert.ok(handler);
  await assert.rejects(handler([{ data: intent }]), { name: 'AbortError' });
  assert.equal(releaseCount, 1);
  assert.equal(releasedCode, 'lease_lost');
  assert.equal(completeCount, 0);

  releaseCount = 0;
  releasedCode = undefined;
  renewCount = 0;
  await startValidationQueue({
    boss: boss as never,
    readyRoots: new Map([['root', { canonicalPath: '/fixture' }]]),
    getSource: async () => source,
    renew: async () => (++renewCount, true),
    release: async (_intent, code) => {
      releaseCount++;
      releasedCode = code;
    },
    complete: async () => false,
    validate: async (_root, _item, signal) =>
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
    signal: new AbortController().signal,
    itemTimeoutMs: 1,
    heartbeatMs: 60_000,
  });
  assert.ok(handler);
  await assert.rejects(handler([{ data: intent }]), { name: 'TimeoutError' });
  assert.equal(releaseCount, 1);
  assert.equal(releasedCode, 'validation_timeout');

  releaseCount = 0;
  releasedCode = undefined;
  await startValidationQueue({
    boss: boss as never,
    readyRoots: new Map([['root', { canonicalPath: '/fixture' }]]),
    getSource: async () => source,
    renew: async () => true,
    release: async (_intent, code) => {
      releaseCount++;
      releasedCode = code;
    },
    complete: async () => false,
    validate: async () => {
      throw new ValidationAttemptError('root_unavailable');
    },
    signal: new AbortController().signal,
  });
  assert.ok(handler);
  await assert.rejects(handler([{ data: intent }]), ValidationAttemptError);
  assert.equal(releaseCount, 1);
  assert.equal(releasedCode, 'root_unavailable');
  assert.equal(
    classifyValidationFailure(new Error('unbounded exception detail'), {
      timeout: new AbortController().signal,
      leaseLost: new AbortController(),
      signal: new AbortController().signal,
    }),
    'validation_infrastructure_failure',
  );
  assert.equal(
    classifyValidationFailure(new ValidationAttemptError('root_or_page_unavailable'), {
      timeout: new AbortController().signal,
      leaseLost: new AbortController(),
      signal: new AbortController().signal,
    }),
    'root_unavailable',
  );
});
