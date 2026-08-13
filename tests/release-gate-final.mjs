import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const verifier = join(sourceRoot, 'scripts/verify-release-gate.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = (hex) => `sha256:${hex}`;

const copyPaths = [
  'Caddyfile',
  'Dockerfile',
  'Dockerfile.web',
  'compose.yaml',
  'compose.production.example.yaml',
  'compose.library.example.yaml',
  'package.json',
  'pnpm-lock.yaml',
  'docs/release-gate-manifest.json',
  'docs/release-tool-refs.json',
  'docs/release-gate.md',
  'docs/scale-oracle-evidence.schema.json',
  'docs/scale-oracle-baseline.json',
  'scripts/verify-release-gate.mjs',
  'tests/validate-scale-evidence.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

const manifest = JSON.parse(
  await readFile(join(sourceRoot, 'docs/release-gate-manifest.json'), 'utf8'),
);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: sourceRoot,
  encoding: 'utf8',
}).trim();

async function copyFixtureTree(root) {
  for (const path of copyPaths) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, path), destination);
  }
  for (const artifact of manifest.requiredArtifacts) {
    const destination = join(root, artifact.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, artifact.path), destination);
  }
}

function scaleEvidence(baselineSha256) {
  const run = (name, updated, unchanged) => ({
    id: `${name}-run`,
    requestId: `${name}-request`,
    pgBossJobId: `${name}-job`,
    state: 'completed',
    summary: { updated, unchanged, discovered: 1000, pages: 20000 },
  });
  return {
    schemaVersion: 'gutter.scale-oracle.v1',
    status: 'pass',
    unavailablePlatformReason: null,
    seed: 'fixture-seed',
    runId: 'fixture-run-0001',
    dataset: { books: 100000, pages: 2000000, sourceFixtureBooks: 1000, sourceFixturePages: 1000 },
    thresholds: {
      sourceFixtureBooks: 1000,
      sourceFixturePages: 1000,
      readerCount: 5,
      coldProducerCount: 1,
      sparseAllocatedBlocksMax: 1024,
      advisoryCatalogP95Ms: 10,
      advisorySearchP95Ms: 10,
      advisoryScanP95Ms: 10,
    },
    environment: {
      node: '24.19.0',
      postgres: { version: '17' },
      setupDatabaseRole: 'gutter',
      workerDatabaseRole: 'gutter_worker',
      sourceMount: 'read-only',
    },
    timingsMs: Object.fromEntries(
      ['catalog', 'search', 'noChangeScan', 'changedScan'].map((key) => [
        key,
        { p50: 1, p95: 2, count: 3 },
      ]),
    ),
    plans: {
      queryShape: 'fixture',
      list: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan' } }] }],
      search: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan' } }] }],
    },
    cache: {
      readers: 5,
      coldProducers: 1,
      warmHit: true,
      gc: true,
      pressure: { quotaBytes: 1000, reclaimedBytes: 1, protectedLiveEntry: true },
    },
    worker: {
      queueCompletedRuns: 3,
      runs: {
        first: run('first', 1000, 0),
        noChange: run('no-change', 0, 1000),
        changed: run('changed', 1, 0),
      },
    },
    sparse: {
      logicalBytes: 20 * 1024 ** 4,
      allocatedBlocks: 1,
      fileCount: 2,
      maxFileLogicalBytes: 10 * 1024 ** 4,
    },
    baselineComparison: {
      baseline: 'docs/scale-oracle-baseline.json',
      baselineSha256,
      portable: 'pass',
      hardwareAdvisory: {},
    },
  };
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), 'gutter-release-final-'));
  await copyFixtureTree(root);
  const baselineSha256 = sha256(await readFile(join(root, 'docs/scale-oracle-baseline.json')));
  await mkdir(join(root, 'release-artifacts/logs'), { recursive: true });
  const artifacts = [];
  const addArtifact = async (path, role, gate, content) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await writeFile(target, bytes);
    artifacts.push({ path, role, gate, sha256: sha256(bytes) });
  };
  for (const gate of manifest.requiredGateIds)
    await addArtifact(`release-artifacts/logs/${gate}.log`, 'runner-log', gate, `${gate}: pass\n`);
  for (const required of manifest.requiredArtifacts) {
    const bytes = await readFile(join(root, required.path));
    artifacts.push({ ...required, sha256: sha256(bytes) });
  }
  const subjects = ['api', 'worker', 'web'].map((service, index) => {
    const hex = String(index + 1).repeat(64);
    return {
      service,
      reference: `ghcr.io/moons-14/gutter/${service}@${digest(hex)}`,
      digest: digest(hex),
    };
  });
  for (const subject of subjects) {
    const sbomPath = `release-artifacts/${subject.service}.sbom.json`;
    const provenancePath = `release-artifacts/${subject.service}.provenance.json`;
    const payload = {
      subject: subject.reference,
      image: subject.reference,
      digest: subject.digest,
      components: [{ bomRef: subject.digest, name: subject.service }],
    };
    await addArtifact(
      sbomPath,
      'sbom-report',
      'sbom',
      JSON.stringify({ bomFormat: 'CycloneDX', ...payload }),
    );
    await addArtifact(
      provenancePath,
      'provenance-attestation',
      'provenance',
      JSON.stringify([
        {
          verificationResult: {
            statement: {
              predicateType: 'https://slsa.dev/provenance/v1',
              subject: [
                {
                  name: subject.reference.slice(0, subject.reference.indexOf('@')),
                  digest: { sha256: subject.digest.slice('sha256:'.length) },
                },
              ],
            },
            signature: {
              certificate: {
                issuer: 'https://token.actions.githubusercontent.com',
                subjectAlternativeName:
                  'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/heads/main',
                githubWorkflowRepository: 'moons-14/gutter',
                githubWorkflowSHA: commit,
                sourceRepositoryDigest: commit,
              },
            },
            verifiedTimestamps: [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev' }],
          },
        },
      ]),
    );
  }
  const scalePath = 'release-artifacts/scale-evidence.json';
  await addArtifact(
    scalePath,
    'scale-evidence',
    'scale-concurrency',
    JSON.stringify(scaleEvidence(baselineSha256)),
  );
  await addArtifact(
    'release-artifacts/nas-evidence.ndjson',
    'nas-evidence',
    'nas-source',
    [
      {
        name: 'linux-local-source',
        status: 'pass',
        outageObserved: true,
        projectionReadable: true,
        projectionHashBefore: 'a'.repeat(64),
        projectionHashDuring: 'a'.repeat(64),
        sourceHash: 'b'.repeat(64),
        command: 'fixture',
      },
      { name: 'nfs', status: 'unavailable', reason: 'fixture unavailable', command: 'fixture' },
      { name: 'smb', status: 'unavailable', reason: 'fixture unavailable', command: 'fixture' },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const gateArtifacts = new Map(manifest.requiredGateIds.map((id) => [id, []]));
  for (const artifact of artifacts) gateArtifacts.get(artifact.gate).push(artifact);
  const evidence = {
    schemaVersion: 'gutter.release-evidence.v1',
    exactTree: { commit, lockfileSha256: sha256(await readFile(join(root, 'pnpm-lock.yaml'))) },
    images: subjects.map(({ reference, digest: imageDigest }) => ({
      reference,
      digest: imageDigest,
    })),
    gates: manifest.requiredGateIds.map((id) => ({
      id,
      status: 'pass',
      command: manifest.gateCommands[id],
      commandHash: sha256(manifest.gateCommands[id]),
      artifacts: gateArtifacts.get(id),
    })),
    platforms: manifest.requiredPlatformNames.map((name) => ({
      name,
      status: 'pass',
      command: `fixture ${name}`,
      reason: '',
    })),
    references: { issue26: 'scale oracle fixture', issue27: 'compose-restore-drill fixture' },
    threatClaims: manifest.threatClaims,
  };
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  return { root, evidence, subjects };
}

async function runFinal(root, testMode = true) {
  return exec(process.execPath, [verifier, 'final', 'evidence.json'], {
    cwd: root,
    env: {
      ...process.env,
      RELEASE_GATE_ROOT: root,
      RELEASE_GATE_COMMIT: commit,
      ...(testMode ? { RELEASE_GATE_TEST_MODE: '1' } : {}),
    },
  });
}

async function withFixture(mutator, expected) {
  const fixture = await buildFixture();
  try {
    await mutator(fixture);
    await assert.rejects(runFinal(fixture.root), expected);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test('final mode accepts a complete isolated release fixture', async () => {
  const fixture = await buildFixture();
  try {
    const { stdout } = await runFinal(fixture.root);
    assert.match(stdout, /release gate final evidence passed \(21 gates, 3 platforms\)/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('final mode rejects an evil application registry', () =>
  withFixture(async ({ root }) => {
    const path = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    evidence.images[0].reference = evidence.images[0].reference.replace(
      'ghcr.io/moons-14/gutter',
      'evil.example/gutter',
    );
    await writeFile(path, JSON.stringify(evidence));
  }, /evidence image is not an immutable application subject/));

test('final mode rejects swapped SBOM subjects', () =>
  withFixture(async ({ root, subjects }) => {
    const path = join(root, `release-artifacts/${subjects[0].service}.sbom.json`);
    const other = await readFile(
      join(root, `release-artifacts/${subjects[1].service}.sbom.json`),
      'utf8',
    );
    await writeFile(path, other);
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const artifact = evidence.gates
      .find((gate) => gate.id === 'sbom')
      .artifacts.find(
        (entry) => entry.path === `release-artifacts/${subjects[0].service}.sbom.json`,
      );
    artifact.sha256 = sha256(Buffer.from(other));
    await writeFile(evidencePath, JSON.stringify(evidence));
  }, /sha256:1111111111111111111111111111111111111111111111111111111111111111/));

test('final mode rejects swapped provenance subjects', () =>
  withFixture(async ({ root, subjects }) => {
    const path = join(root, `release-artifacts/${subjects[0].service}.provenance.json`);
    const other = await readFile(
      join(root, `release-artifacts/${subjects[1].service}.provenance.json`),
      'utf8',
    );
    await writeFile(path, other);
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const artifact = evidence.gates
      .find((gate) => gate.id === 'provenance')
      .artifacts.find(
        (entry) => entry.path === `release-artifacts/${subjects[0].service}.provenance.json`,
      );
    artifact.sha256 = sha256(Buffer.from(other));
    await writeFile(evidencePath, JSON.stringify(evidence));
  }, /sha256:1111111111111111111111111111111111111111111111111111111111111111/));

test('final mode rejects missing artifacts', () =>
  withFixture(async ({ root }) => {
    await rm(join(root, 'release-artifacts/logs/unit.log'));
  }, /ENOENT|no such file/));

test('final mode rejects wrong image digests', () =>
  withFixture(async ({ root }) => {
    const path = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    evidence.images[0].digest = digest('f'.repeat(64));
    await writeFile(path, JSON.stringify(evidence));
  }, /image digest mismatch/));

test('final mode rejects a cross-subject provenance reference even with updated checksum', () =>
  withFixture(async ({ root, subjects }) => {
    const path = join(root, `release-artifacts/${subjects[0].service}.provenance.json`);
    const payload = JSON.parse(
      await readFile(
        join(root, `release-artifacts/${subjects[1].service}.provenance.json`),
        'utf8',
      ),
    );
    payload[0].verificationResult.statement.subject[0] = {
      name: subjects[1].reference.slice(0, subjects[1].reference.indexOf('@')),
      digest: { sha256: subjects[0].digest.slice('sha256:'.length) },
    };
    await writeFile(path, JSON.stringify(payload));
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const artifact = evidence.gates
      .find((gate) => gate.id === 'provenance')
      .artifacts.find(
        (entry) => entry.path === `release-artifacts/${subjects[0].service}.provenance.json`,
      );
    artifact.sha256 = sha256(Buffer.from(JSON.stringify(payload)));
    await writeFile(evidencePath, JSON.stringify(evidence));
  }, /expected: \/api\//));

test('final mode rejects provenance from a different workflow commit', () =>
  withFixture(async ({ root, subjects }) => {
    const path = join(root, `release-artifacts/${subjects[0].service}.provenance.json`);
    const payload = JSON.parse(await readFile(path, 'utf8'));
    payload[0].verificationResult.signature.certificate.githubWorkflowSHA = 'f'.repeat(40);
    await writeFile(path, JSON.stringify(payload));
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const artifact = evidence.gates
      .find((gate) => gate.id === 'provenance')
      .artifacts.find(
        (entry) => entry.path === `release-artifacts/${subjects[0].service}.provenance.json`,
      );
    artifact.sha256 = sha256(Buffer.from(JSON.stringify(payload)));
    await writeFile(evidencePath, JSON.stringify(evidence));
  }, /Expected values to be strictly equal/));
