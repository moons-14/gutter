import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('final mode rejects symlink evidence paths before parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-release-gate-'));
  try {
    const link = join(root, 'evidence.json');
    await symlink(join(process.cwd(), 'docs/release-gate-manifest.json'), link);
    await assert.rejects(
      exec(process.execPath, ['scripts/verify-release-gate.mjs', 'final', link]),
      /unsafe artifact path|symlink|absolute/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tree references remain digest and commit pinned', async () => {
  const { stdout } = await exec(process.execPath, ['scripts/verify-release-gate.mjs', 'contract']);
  assert.match(stdout, /contract structure passed/);
});

test('evidence generator rejects missing runner results instead of inventing pass', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/generate-release-evidence.mjs', 'missing-runner.tsv', 'missing-evidence.json']),
    /ENOENT|runner result missing/,
  );
});
