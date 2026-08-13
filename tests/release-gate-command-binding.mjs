import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestPath = 'docs/release-gate-manifest.json';
const runnerPath = 'scripts/run-release-gates.sh';

async function readReleaseContract() {
  const [manifestText, runner] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(runnerPath, 'utf8'),
  ]);
  return { manifest: JSON.parse(manifestText), runner };
}

function declaredRunGates(runner) {
  return [...runner.matchAll(/^\s*run_gate\s+([a-z0-9-]+)\s+'([^']*)'/gm)].map(
    ([, id, command]) => ({ id, command }),
  );
}

test('release runner declares exactly the manifest gate commands', async () => {
  const { manifest, runner } = await readReleaseContract();
  const declarations = declaredRunGates(runner);

  assert.deepEqual(
    declarations.map(({ id }) => id).sort(),
    [...manifest.requiredGateIds].sort(),
    'runner gate membership must match the release manifest',
  );

  for (const { id, command } of declarations) {
    assert.equal(
      command,
      manifest.gateCommands[id],
      `runner command for ${id} must be the manifest canonical command`,
    );
  }
});

test('scale fallback emits the same canonical command as its run_gate row', async () => {
  const { manifest, runner } = await readReleaseContract();
  const expected = manifest.gateCommands['scale-concurrency'];
  const fallback = runner.match(
    /printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n'\s+'scale-concurrency'\s+'([^']*)'/,
  );

  assert.ok(fallback, 'scale fallback must emit a canonical runner-results row');
  assert.equal(fallback[1], expected);
});
