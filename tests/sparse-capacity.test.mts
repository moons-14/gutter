import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  probeSparseCapacity,
  SPARSE_FILE_COUNT,
  SPARSE_FILE_LOGICAL_BYTES,
  SPARSE_LOGICAL_BYTES,
} from './sparse-capacity.mts';

test('sparse capacity probe splits 20 TiB across portable large files', async () => {
  const resized: Array<{ path: string; length: number }> = [];
  const evidence = await probeSparseCapacity('/virtual', {
    create: async () => undefined,
    resize: async (path, length) => {
      resized.push({ path, length });
    },
    inspect: async () => ({ size: SPARSE_FILE_LOGICAL_BYTES, blocks: 0 }),
  });

  assert.deepEqual(
    resized,
    Array.from({ length: SPARSE_FILE_COUNT }, (_, index) => ({
      path: join('/virtual', `capacity-${index}.bin`),
      length: SPARSE_FILE_LOGICAL_BYTES,
    })),
  );
  assert.deepEqual(evidence, {
    logicalBytes: SPARSE_LOGICAL_BYTES,
    allocatedBlocks: 0,
    fileCount: SPARSE_FILE_COUNT,
    maxFileLogicalBytes: SPARSE_FILE_LOGICAL_BYTES,
  });
});

test('sparse capacity probe fails closed without retrying a smaller file', async () => {
  const attemptedLengths: number[] = [];
  const error = Object.assign(new Error('file too large'), { code: 'EFBIG' });
  await assert.rejects(
    probeSparseCapacity('/virtual', {
      create: async () => undefined,
      resize: async (_path, length) => {
        attemptedLengths.push(length);
        throw error;
      },
      inspect: async () => {
        throw new Error('inspect must not run after resize failure');
      },
    }),
    error,
  );
  assert.deepEqual(attemptedLengths, [SPARSE_FILE_LOGICAL_BYTES]);
});

test('real sparse capacity probe retains 20 TiB without allocating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-sparse-capacity-test-'));
  try {
    const evidence = await probeSparseCapacity(root);
    assert.equal(evidence.logicalBytes, SPARSE_LOGICAL_BYTES);
    assert.equal(evidence.fileCount, SPARSE_FILE_COUNT);
    assert.equal(evidence.maxFileLogicalBytes, SPARSE_FILE_LOGICAL_BYTES);
    assert.ok(evidence.allocatedBlocks < 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
