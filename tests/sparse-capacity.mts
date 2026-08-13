import assert from 'node:assert/strict';
import { stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SPARSE_LOGICAL_BYTES = 20 * 1024 ** 4;
export const SPARSE_FILE_COUNT = 2;
export const SPARSE_FILE_LOGICAL_BYTES = SPARSE_LOGICAL_BYTES / SPARSE_FILE_COUNT;

type SparseStat = { size: number; blocks: number };

type SparseCapacityOperations = {
  create: (path: string) => Promise<unknown>;
  resize: (path: string, length: number) => Promise<unknown>;
  inspect: (path: string) => Promise<SparseStat>;
};

const defaultOperations: SparseCapacityOperations = {
  create: (path) => writeFile(path, '', { flag: 'wx' }),
  resize: truncate,
  inspect: async (path) => {
    const result = await stat(path);
    return { size: result.size, blocks: result.blocks };
  },
};

export async function probeSparseCapacity(
  root: string,
  operations: SparseCapacityOperations = defaultOperations,
) {
  const files: SparseStat[] = [];
  for (let index = 0; index < SPARSE_FILE_COUNT; index++) {
    const path = join(root, `capacity-${index}.bin`);
    await operations.create(path);
    await operations.resize(path, SPARSE_FILE_LOGICAL_BYTES);
    const result = await operations.inspect(path);
    assert.equal(
      result.size,
      SPARSE_FILE_LOGICAL_BYTES,
      `sparse capacity file ${index} must retain its exact logical size`,
    );
    assert.ok(
      Number.isInteger(result.blocks) && result.blocks >= 0,
      `sparse capacity file ${index} must report allocated blocks`,
    );
    files.push(result);
  }

  const logicalBytes = files.reduce((total, file) => total + file.size, 0);
  const allocatedBlocks = files.reduce((total, file) => total + file.blocks, 0);
  assert.equal(logicalBytes, SPARSE_LOGICAL_BYTES, 'sparse probe must cover 20 TiB in total');
  return {
    logicalBytes,
    allocatedBlocks,
    fileCount: files.length,
    maxFileLogicalBytes: Math.max(...files.map((file) => file.size)),
  };
}
