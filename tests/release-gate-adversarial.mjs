import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
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

test('workflow image refs normalize docker.io/library and contract passes', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.doesNotMatch(workflow, /RELEASE_IMAGE_REFS:/);
  assert.match(
    await readFile('scripts/run-release-gates.sh', 'utf8'),
    /docker compose build api worker web/,
  );
  const { stdout } = await exec(process.execPath, ['scripts/verify-release-gate.mjs', 'contract']);
  assert.match(stdout, /contract structure passed/);
});

test('workflow final reaches evidence validation after image membership', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/verify-release-gate.mjs', 'final', 'missing-evidence.json']),
    /final mode requires evidence|ENOENT/,
  );
});

test('final mode normalizes malformed evidence JSON without leaking parser details', async () => {
  const relative = `tests/.release-gate-malformed-${process.pid}.json`;
  try {
    await writeFile(relative, 'not-json');
    await assert.rejects(
      exec(process.execPath, ['scripts/verify-release-gate.mjs', 'final', relative]),
      (error) =>
        /final mode requires evidence\.json containing valid JSON/.test(error.message) &&
        !/SyntaxError|Unexpected token/.test(error.message),
    );
  } finally {
    await rm(relative, { force: true });
  }
});

test('manifest requires exact image cardinality and threat ownership', async () => {
  const manifest = JSON.parse(await readFile('docs/release-gate-manifest.json', 'utf8'));
  assert.equal(manifest.requiredImageNames.length, 3);
  assert.equal(Object.keys(manifest.threatClaims).length, 6);
  assert.equal(
    manifest.requiredArtifacts.every((artifact) => artifact.role && artifact.gate),
    true,
  );
});

test('evidence generator rejects missing runner results instead of inventing pass', async () => {
  await assert.rejects(
    exec(process.execPath, [
      'scripts/generate-release-evidence.mjs',
      'missing-runner.tsv',
      'missing-evidence.json',
    ]),
    /ENOENT|runner result missing/,
  );
});
