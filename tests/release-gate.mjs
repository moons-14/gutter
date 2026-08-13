import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('contract mode passes structure without claiming release evidence', async () => {
  const { stdout } = await exec(process.execPath, ['scripts/verify-release-gate.mjs', 'contract']);
  assert.match(stdout, /contract structure passed/);
});

test('final mode fails closed when evidence is absent', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/verify-release-gate.mjs', 'final']),
    /final mode requires evidence/,
  );
});
