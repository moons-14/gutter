import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';

const count = Number(process.env.SCALE_TINY_CBZ_COUNT ?? 10_000);
if (process.env.SCALE_TINY_CBZ !== '1')
  throw new Error('tiny CBZ benchmark requires SCALE_TINY_CBZ=1');
assert.equal(count, 10_000, 'named tiny-CBZ benchmark always proves exactly 10,000 archives');
const root = await mkdtemp(join(tmpdir(), 'gutter-tiny-cbz-'));
const body = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const started = performance.now();
function tinyCbz(payload) {
  const encodedName = Buffer.from('0.png');
  const checksum = crc32(payload) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  const directory = Buffer.concat([central, encodedName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + encodedName.length + payload.length, 16);
  return Buffer.concat([local, encodedName, payload, directory, end]);
}
try {
  for (let i = 0; i < count; i++) {
    await writeFile(join(root, `tiny-${String(i).padStart(5, '0')}.cbz`), tinyCbz(body));
  }
  const files = await readdir(root);
  assert.equal(files.length, count);
  assert.equal((await stat(join(root, files[0]))).size, 30 + 5 + body.length + 46 + 5 + 22);
  const { scanRootBatched } = await import('../packages/discovery-scanner/src/index.ts');
  const scanned = await scanRootBatched(root, { batchSize: 100, stableGraceMs: 0 });
  assert.equal(scanned.summary.discovered, count);
  assert.equal(scanned.summary.pages, count);
  assert.equal(scanned.summary.quarantined, 0);
  const { validateSourceItem } = await import('../packages/page-validator/src/index.ts');
  async function validateWithRetry(item) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await validateSourceItem(root, item);
      } catch (error) {
        if (error?.message !== 'archive_unavailable' || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  let validated = 0;
  const concurrency = 4;
  for (let offset = 0; offset < scanned.items.length; offset += concurrency) {
    const batch = scanned.items.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map((item) => validateWithRetry(item)));
    validated += results.reduce((sum, result) => sum + result.validCount, 0);
  }
  assert.equal(validated, count, 'all 10,000 CBZ pages validated');
  const bytesPerFile = 30 + 5 + body.length + 46 + 5 + 22;
  console.log(
    `TINY_CBZ_RESULT ${JSON.stringify({ count, bytesPerFile, discovered: scanned.summary.discovered, pages: scanned.summary.pages, elapsedMs: performance.now() - started })}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
