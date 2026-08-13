import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const count = Number(process.env.SCALE_TINY_CBZ_COUNT ?? 10_000);
if (process.env.SCALE_TINY_CBZ !== '1')
  throw new Error('tiny CBZ benchmark requires SCALE_TINY_CBZ=1');
assert.ok(Number.isInteger(count) && count >= 1 && count <= 10_000);
const root = await mkdtemp(join(tmpdir(), 'gutter-tiny-cbz-'));
const body = Buffer.from('tiny-cbz-fixture');
const started = performance.now();
try {
  for (let i = 0; i < count; i++) {
    const name = Buffer.from('0.png');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    await writeFile(
      join(root, `tiny-${String(i).padStart(5, '0')}.cbz`),
      Buffer.concat([local, body]),
    );
  }
  const files = await readdir(root);
  assert.equal(files.length, count);
  assert.equal((await stat(join(root, files[0]))).size, 30 + 5 + body.length);
  console.log(
    `TINY_CBZ_RESULT ${JSON.stringify({ count, bytesPerFile: 30 + 5 + body.length, elapsedMs: performance.now() - started })}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
