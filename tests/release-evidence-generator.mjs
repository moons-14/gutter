import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const generator = join(sourceRoot, 'scripts/generate-release-evidence.mjs');
const manifest = JSON.parse(
  await readFile(join(sourceRoot, 'docs/release-gate-manifest.json'), 'utf8'),
);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const subjects = ['api', 'worker', 'web'].map(
  (service, index) => `local/gutter-release-${service}@sha256:${String(index + 1).repeat(64)}`,
);

async function gitFixture(root) {
  await exec('git', ['init', '-q'], { cwd: root });
  await exec(
    'git',
    [
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ],
    { cwd: root },
  );
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gutter-release-generator-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'release-artifacts'), { recursive: true });
  const files = [
    'docs/release-gate-manifest.json',
    'pnpm-lock.yaml',
    ...manifest.requiredArtifacts.map(({ path }) => path),
  ];
  for (const path of new Set(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, path), destination);
  }
  const rows = [];
  for (const id of manifest.requiredGateIds) {
    const command = manifest.gateCommands[id];
    const bytes = Buffer.from(`fixture log for ${id}\n`);
    const logPath = join(root, 'release-artifacts', `${id}.log`);
    await writeFile(logPath, bytes);
    rows.push(
      [id, command, sha256(command), '0', `release-artifacts/${id}.log`, sha256(bytes)].join('\t'),
    );
  }
  await writeFile(join(root, 'runner-results.tsv'), `${rows.join('\n')}\n`);
  await gitFixture(root);
  return root;
}

async function runGenerator(root) {
  return exec(process.execPath, [generator, 'runner-results.tsv', 'release-evidence.json'], {
    cwd: root,
    env: { ...process.env, RELEASE_GATE_ROOT: root, RELEASE_IMAGE_REFS: subjects.join(' ') },
  });
}

async function withFixture(mutator, expected) {
  const root = await makeFixture();
  try {
    await mutator(root);
    await assert.rejects(runGenerator(root), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('generator accepts the canonical six-column runner TSV for all 21 gates', async () => {
  const root = await makeFixture();
  try {
    await runGenerator(root);
    const evidence = JSON.parse(await readFile(join(root, 'release-evidence.json'), 'utf8'));
    assert.equal(evidence.gates.length, 21);
    assert.deepEqual(
      evidence.gates.map(({ id }) => id),
      manifest.requiredGateIds,
    );
    for (const gate of evidence.gates) {
      assert.equal(gate.status, 'pass');
      assert.equal(gate.command, manifest.gateCommands[gate.id]);
      assert.equal(gate.commandHash, sha256(gate.command));
      assert.deepEqual(gate.artifacts[0], {
        path: `release-artifacts/${gate.id}.log`,
        role: gate.id === 'nas-source' ? 'nas-evidence' : 'runner-log',
        gate: gate.id,
        sha256: sha256(Buffer.from(`fixture log for ${gate.id}\n`)),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generator rejects absolute, traversal, and backslash runner log paths', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace(
        'release-artifacts/dependencies.log',
        `${root}/release-artifacts/dependencies.log`,
      ),
    );
  }, /unsafe runner log path/);
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace('release-artifacts/dependencies.log', 'release-artifacts/../dependencies.log'),
    );
  }, /unsafe runner log path/);
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace('release-artifacts/dependencies.log', 'release-artifacts\\dependencies.log'),
    );
  }, /unsafe runner log path/);
});

test('generator rejects symlink logs and mismatched gate/log bindings', async () => {
  await withFixture(async (root) => {
    const log = join(root, 'release-artifacts/dependencies.log');
    const target = join(root, 'outside.log');
    await writeFile(target, await readFile(log));
    await rm(log);
    await symlink(target, log);
  }, /unsafe runner log path/);
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    const unitLog = join(root, 'release-artifacts/unit.log');
    const unitHash = sha256(await readFile(unitLog));
    await writeFile(
      path,
      text.replace(
        /^(dependencies\t[^\n]*\t[^\n]*\t0\t)[^\t]+\t[^\n]+$/m,
        `$1release-artifacts/unit.log\t${unitHash}`,
      ),
    );
  }, /unsafe runner log path/);
});

test('generator rejects duplicate and missing gate rows', async () => {
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text + text.split('\n')[0] + '\n');
  }, /duplicate runner gate ID/);
  await withFixture(async (root) => {
    const path = join(root, 'runner-results.tsv');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      `${text
        .split('\n')
        .filter((line) => !line.startsWith('unit\t'))
        .join('\n')}`,
    );
  }, /runner result missing or failed: unit/);
});

for (const token of ['', ' ', '0x0', '+0', '-0', '0.0', 'NaN', '00', 'not-a-number']) {
  test(`generator rejects malformed runner status token ${JSON.stringify(token)}`, () =>
    withFixture(async (root) => {
      const path = join(root, 'runner-results.tsv');
      const text = await readFile(path, 'utf8');
      const replacement = text.replace(
        /^dependencies\t([^\t]*\t[^\t]*\t)[^\t]*/,
        `dependencies\t$1${token}`,
      );
      await writeFile(path, replacement);
    }, /malformed runner status/));
}

test('release runner writes the canonical six-column TSV log binding', async () => {
  const script = await readFile(join(sourceRoot, 'scripts/run-release-gates.sh'), 'utf8');
  assert.match(script, /"release-artifacts\/\$id\.log"/);
  assert.match(script, /'scale-concurrency'.*'release-artifacts\/scale-concurrency\.log'/);
  assert.match(script, /printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n'/);
  assert.equal((await lstat(join(sourceRoot, 'scripts/run-release-gates.sh'))).isFile(), true);
});
