import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFile(resolve(root, file), 'utf8');
const safeArtifact = async (file) => {
  if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..'))
    throw new Error(`unsafe artifact path: ${file}`);
  const target = resolve(root, file);
  const rootReal = await realpath(root);
  const parts = relative(rootReal, target).split(sep).filter(Boolean);
  let current = rootReal;
  for (const part of parts) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error(`artifact symlink component is not allowed: ${file}`);
  }
  const targetReal = await realpath(target);
  if (relative(rootReal, targetReal).startsWith('..'))
    throw new Error(`artifact escapes tree: ${file}`);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`artifact symlink is not allowed: ${file}`);
  if (!info.isFile()) throw new Error(`artifact is not a regular file: ${file}`);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error(`artifact changed while reading: ${file}`);
    return bytes;
  } finally {
    await handle.close();
  }
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validateScaleEvidence = async (artifact) => {
  if (!artifact.path.startsWith('release-artifacts/scale-evidence.json'))
    throw new Error('scale evidence must be under release-artifacts');
  const report = JSON.parse(await safeArtifact(artifact.path));
  assert.equal(report.schemaVersion, 'gutter.scale-oracle.v1');
  assert.equal(report.status, 'pass');
  assert.ok(report.seed && report.runId);
  assert.equal(report.dataset.books, 100000);
  assert.equal(report.dataset.pages, 2000000);
  assert.equal(report.worker.queueCompletedRuns, 3);
  for (const key of ['first', 'noChange', 'changed']) {
    const run = report.worker.runs?.[key];
    assert.ok(run?.requestId && run?.id && run?.pgBossJobId, `missing observed worker run: ${key}`);
    assert.equal(run.state, 'completed');
  }
  assert.equal(report.worker.runs.first.summary.updated, 1000);
  assert.equal(report.worker.runs.noChange.summary.unchanged, 1000);
  assert.equal(report.worker.runs.changed.summary.updated, 1);
  assert.equal(report.cache.coldProducers, 1);
  assert.equal(report.cache.warmHit, true);
  assert.equal(report.cache.pressure.protectedLiveEntry, true);
  assert.equal(report.cache.pressure.reclaimedBytes > 0, true);
  assert.equal(report.sparse.logicalBytes, 20 * 1024 ** 4);
  assert.equal(report.sparse.allocatedBlocks < 1024, true);
  assert.equal(report.environment.setupDatabaseRole, 'gutter');
  assert.equal(report.environment.workerDatabaseRole, 'gutter_worker');
  assert.equal(report.environment.sourceMount, 'read-only');
  for (const timing of Object.values(report.timingsMs)) {
    assert.ok(Number.isFinite(timing.p50) && Number.isFinite(timing.p95));
  }
  assert.equal(report.baselineComparison.portable, 'pass');
  return report;
};
const validateNasEvidence = async (artifact) => {
  const lines = (await safeArtifact(artifact.path)).toString().trim().split('\n');
  const records = lines.map((line) => JSON.parse(line));
  const byName = new Map(records.map((record) => [record.name, record]));
  assert.deepEqual([...byName.keys()].sort(), ['linux-local-source', 'nfs', 'smb']);
  const linux = byName.get('linux-local-source');
  assert.equal(linux.status, 'pass');
  assert.equal(linux.outageObserved, true);
  assert.equal(linux.projectionReadable, true);
  assert.match(linux.projectionHashBefore, /^[0-9a-f]{64}$/);
  assert.equal(linux.projectionHashBefore, linux.projectionHashDuring);
  assert.match(linux.sourceHash, /^[0-9a-f]{64}$/);
  for (const name of ['nfs', 'smb']) {
    const record = byName.get(name);
    assert.ok(['pass', 'unavailable'].includes(record.status));
    if (record.status === 'unavailable') assert.match(record.reason, /.+/);
    assert.match(record.command, /.+/);
  }
};
const assertKeys = (value, allowed, label) => {
  for (const key of Object.keys(value ?? {}))
    if (!allowed.includes(key)) throw new Error(`unexpected ${label} property: ${key}`);
};
const mode = process.argv[2] ?? 'contract';
if (!['contract', 'final'].includes(mode))
  throw new Error('usage: verify-release-gate.mjs [contract|final] [evidence.json]');
const manifest = JSON.parse(await read('docs/release-gate-manifest.json'));
const toolRefs = JSON.parse(await read('docs/release-tool-refs.json'));
assert.equal(manifest.schemaVersion, 'gutter.release-gate.v1');
for (const artifact of manifest.requiredArtifacts) await read(artifact.path);

const compose = await read('compose.yaml');
const production = await read('compose.production.example.yaml');
const library = await read('compose.library.example.yaml');
const docs = await read('docs/release-gate.md');
const dockerfile = await read('Dockerfile');
const webDockerfile = await read('Dockerfile.web');
const pkg = JSON.parse(await read('package.json'));
const composeModel = parseYaml(compose);
const libraryModel = parseYaml(library);
if (!composeModel?.services?.api || !composeModel?.services?.worker)
  throw new Error('api/worker services missing');
if (!composeModel.networks?.internal?.internal)
  throw new Error('internal network must be internal');
for (const service of ['api', 'worker'])
  if (composeModel.services[service].ports) throw new Error(`${service} must not publish ports`);
const libraryVolumes = libraryModel?.services?.worker?.volumes ?? [];
if (!libraryVolumes.some((volume) => String(volume).endsWith(':ro')))
  throw new Error('library example must contain a read-only bind mount');
for (const secret of [
  'api_db_password',
  'worker_db_password',
  'better_auth_secret',
  'reader_capability_secret',
])
  if (!composeModel.secrets?.[secret]?.file) throw new Error(`secret file missing: ${secret}`);
assert.equal(pkg.packageManager, 'pnpm@11.20.0');
assert.match(library, /:\/libraries\/comics:ro/);
assert.match(production, /GUTTER_READER_CAPABILITY_SECRET_FILE/);
assert.match(docs, /unavailable/);
assert.match(docs, /SBOM/);
assert.match(docs, /provenance/);
assert.match(docs, /source mounts are `:ro`/);
if (/\b(?:provider|redis|otel|upload)\b/i.test(compose))
  throw new Error('out-of-scope service in Compose');
if (!/api\/metrics/.test(docs) || !/respond 404/.test(await read('Caddyfile')))
  throw new Error('public metrics denial is not documented/enforced');

const imageRefs = [...`${compose}\n${production}`.matchAll(/\bimage:\s*([^\s]+)/g)].map(
  (m) => m[1],
);
const fromRefs = [...`${dockerfile}\n${webDockerfile}`.matchAll(/^FROM\s+([^\s]+)/gm)].map(
  (m) => m[1],
);
const allImages = [
  ...imageRefs.filter((image) => !image.startsWith('gutter-release-')),
  ...fromRefs.filter((image) => image.includes(':')),
];
for (const image of allImages)
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`image is not digest pinned: ${image}`);
const normalizeImageRef = (image) => image.replace(/^docker\.io\/library\//, '');
const imageName = (image) =>
  normalizeImageRef(image)
    .slice(0, normalizeImageRef(image).indexOf('@'))
    .split('/')
    .at(-1)
    .split(':')[0];
assert.deepEqual(
  [...new Set(allImages.map(imageName))].sort(),
  [...manifest.requiredImageNames].sort(),
  'image set is incomplete or mutable',
);
const actionWorkflow = `${await read('.github/workflows/ci.yml')}\n${await read('.github/workflows/release.yml')}`;
for (const ref of actionWorkflow.matchAll(/uses:\s*([^\s]+)/g))
  if (!/@[0-9a-f]{40}$/.test(ref[1]))
    throw new Error(`GitHub Action is not commit pinned: ${ref[1]}`);
const workflowImageRefs = [...actionWorkflow.matchAll(/RELEASE_IMAGE_REFS:\s*(.+)$/gm)].flatMap(
  (match) => match[1].trim().split(/\s+/),
);
if (
  workflowImageRefs.some(
    (image) => !allImages.map(normalizeImageRef).includes(normalizeImageRef(image)),
  )
)
  throw new Error('workflow image refs do not match digest-pinned tree refs');
for (const [name, ref] of Object.entries(toolRefs.images))
  if (!/@sha256:[0-9a-f]{64}$/.test(ref))
    throw new Error(`release tool is not digest pinned: ${name}`);
assert.equal(
  process.env.RELEASE_TRIVY_DB_REPOSITORY ??
    'ghcr.io/aquasecurity/trivy-db:2@sha256:182c8405cd03caefe80982cf39bf071c9176ca3b1d1018a6ac02706c4597c72e',
  toolRefs.images.trivyDb,
  'Trivy DB repository must match the immutable tool reference',
);
assert.match(
  actionWorkflow,
  new RegExp(
    `RELEASE_IMAGE_REGISTRY:\\s*${manifest.applicationImageRegistry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ),
);
assert.match(
  actionWorkflow,
  new RegExp(toolRefs.images.trivyDb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
);

if (mode === 'contract') {
  console.log(
    `release gate contract structure passed (${manifest.requiredGateIds.length} gate IDs)`,
  );
  process.exit(0);
}

let scaleSchema;
let scaleBaseline;
try {
  scaleSchema = JSON.parse(await read('docs/scale-oracle-evidence.schema.json'));
  scaleBaseline = JSON.parse(await read('docs/scale-oracle-baseline.json'));
  assert.ok(
    scaleSchema.required.includes('schemaVersion') && scaleSchema.required.includes('status'),
  );
  assert.equal(scaleSchema.properties.schemaVersion.const, 'gutter.scale-oracle.v1');
  assert.equal(scaleBaseline.schemaVersion, 'gutter.scale-oracle.v1');
  assert.equal(scaleBaseline.portable.defaultBooks, 1000);
  assert.equal(scaleBaseline.portable.defaultPages, 10000);
  assert.equal(scaleBaseline.portable.tinyCbzCount, 10000);
  for (const value of Object.values(scaleBaseline.portable)) assert.ok(Number.isFinite(value));
} catch (error) {
  if (error?.code === 'ENOENT') {
    scaleSchema = undefined;
    scaleBaseline = undefined;
  } else throw error;
}

const evidencePath = process.argv[3];
if (!evidencePath) throw new Error('final mode requires evidence.json');
let evidence;
try {
  evidence = JSON.parse(await safeArtifact(evidencePath));
} catch (error) {
  // Preserve safeArtifact's path, symlink, and integrity diagnostics. Only malformed
  // JSON is normalized at this boundary so final mode never leaks parser internals.
  if (error instanceof SyntaxError)
    throw new Error('final mode requires evidence.json containing valid JSON');
  throw error;
}
assert.equal(evidence.schemaVersion, 'gutter.release-evidence.v1');
assertKeys(
  evidence,
  ['schemaVersion', 'exactTree', 'images', 'gates', 'platforms', 'references', 'threatClaims'],
  'evidence',
);
assertKeys(evidence.exactTree, ['commit', 'lockfileSha256'], 'exactTree');
assertKeys(evidence.references, ['issue26', 'issue27'], 'references');
assert.ok(Array.isArray(evidence.images) && evidence.images.length > 0, 'images are required');
assert.ok(Array.isArray(evidence.gates) && evidence.gates.length > 0, 'gates are required');
assert.ok(
  Array.isArray(evidence.platforms) && evidence.platforms.length > 0,
  'platforms are required',
);
assert.deepEqual(
  [
    ...new Set(
      evidence.images.map((image) => imageName(image.reference).replace(/^gutter-release-/, '')),
    ),
  ].sort(),
  [...manifest.requiredApplicationImageNames].sort(),
  'evidence application image set is incomplete or duplicated',
);
assert.equal(
  evidence.images.length,
  manifest.requiredImageNames.length,
  'evidence image cardinality mismatch',
);
assert.equal(
  new Set(evidence.images.map((image) => image.reference)).size,
  evidence.images.length,
  'duplicate evidence image reference',
);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const lockHash = sha256(await read('pnpm-lock.yaml'));
assert.equal(evidence.exactTree.commit, head, 'evidence commit does not match HEAD');
assert.equal(evidence.exactTree.lockfileSha256, lockHash, 'evidence lockfile hash does not match');
assert.deepEqual(
  [...new Set(evidence.gates.map((gate) => gate.id))].sort(),
  [...manifest.requiredGateIds].sort(),
  'gate IDs incomplete or duplicated',
);
assert.deepEqual(
  [...new Set(evidence.platforms.map((platform) => platform.name))].sort(),
  [...manifest.requiredPlatformNames].sort(),
  'platform matrix incomplete or duplicated',
);
assert.equal(
  evidence.gates.length,
  manifest.requiredGateIds.length,
  'gate IDs duplicated or incomplete',
);
assert.equal(
  evidence.platforms.length,
  manifest.requiredPlatformNames.length,
  'platform names duplicated or incomplete',
);
assert.equal(evidence.references.issue26.length > 0, true);
assert.equal(evidence.references.issue27.length > 0, true);
for (const gate of evidence.gates) {
  assertKeys(gate, ['id', 'status', 'command', 'commandHash', 'artifacts'], 'gate');
  assert.ok(
    gate.id && gate.command.trim() && Array.isArray(gate.artifacts) && gate.artifacts.length > 0,
    `gate evidence incomplete: ${gate.id}`,
  );
  if (gate.status !== 'pass')
    throw new Error(`release gate is not pass: ${gate.id}=${gate.status}`);
  for (const artifact of gate.artifacts) {
    assertKeys(artifact, ['path', 'role', 'gate', 'sha256'], 'artifact');
    const canonical = manifest.gateCommands[gate.id];
    assert.equal(gate.command, canonical, `non-canonical command: ${gate.id}`);
    assert.equal(gate.commandHash, sha256(gate.command), `command hash mismatch: ${gate.id}`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `invalid artifact checksum: ${gate.id}`);
    const bytes = await safeArtifact(artifact.path);
    assert.equal(sha256(bytes), artifact.sha256, `artifact checksum mismatch: ${artifact.path}`);
  }
}
assert.deepEqual(
  evidence.threatClaims,
  manifest.threatClaims,
  'threat claim mapping is incomplete or altered',
);
for (const [claim, gateId] of Object.entries(manifest.threatClaims)) {
  if (!manifest.requiredGateIds.includes(gateId))
    throw new Error(`threat claim targets unknown gate: ${claim}`);
  if (
    !evidence.gates.find((gate) => gate.id === gateId)?.artifacts.some((artifact) => artifact.role)
  )
    throw new Error(`threat claim has no artifact role: ${claim}`);
}
const represented = new Set(
  evidence.gates.flatMap((gate) => gate.artifacts.map((artifact) => artifact.path)),
);
for (const required of manifest.requiredArtifacts) {
  if (!represented.has(required.path))
    throw new Error(`required artifact is not represented: ${required.path}`);
  const artifact = evidence.gates
    .flatMap((gate) => gate.artifacts)
    .find((entry) => entry.path === required.path);
  assert.equal(artifact.role, required.role, `artifact role mismatch: ${required.path}`);
  assert.equal(artifact.gate, required.gate, `artifact owning gate mismatch: ${required.path}`);
  assert.equal(
    sha256(await safeArtifact(required.path)),
    artifact.sha256,
    `required artifact checksum mismatch: ${required.path}`,
  );
}
if (evidence.platforms.find((platform) => platform.name === 'linux')?.status !== 'pass')
  throw new Error('Linux platform must pass');
for (const platform of evidence.platforms) {
  assertKeys(platform, ['name', 'status', 'command', 'reason'], 'platform');
  assert.ok(
    platform.name && platform.command.trim(),
    'platform evidence requires name and command',
  );
  if (!['pass', 'unavailable'].includes(platform.status))
    throw new Error(`invalid platform status: ${platform.name}`);
  if (platform.status === 'unavailable' && !platform.reason?.trim())
    throw new Error(`unavailable platform has no reason: ${platform.name}`);
}
const scaleGate = evidence.gates.find((gate) => gate.id === 'scale-concurrency');
const hasScaleSchema = Boolean(scaleSchema && scaleBaseline);
if (manifest.deferredUntil['scale-concurrency'] && (!hasScaleSchema || scaleGate.status !== 'pass'))
  throw new Error('scale-concurrency cannot pass until #26 schema, baseline, and evidence exist');
if (
  scaleGate.status === 'pass' &&
  (!scaleGate.artifacts.some((artifact) => artifact.role === 'scale-evidence') ||
    !scaleGate.artifacts.some(
      (artifact) =>
        artifact.role === 'scale-evidence' && artifact.path.includes('scale-evidence.json'),
    ))
)
  throw new Error('scale-concurrency pass requires scale-evidence artifact');
if (scaleGate.status === 'pass') {
  const scaleArtifact = scaleGate.artifacts.find((artifact) => artifact.role === 'scale-evidence');
  const report = await validateScaleEvidence(scaleArtifact);
  execFileSync(process.execPath, ['tests/validate-scale-evidence.mjs', scaleArtifact.path], {
    cwd: root,
    stdio: 'pipe',
  });
  assert.deepEqual(
    [...new Set(['first', 'noChange', 'changed'].map((key) => report.worker.runs[key].requestId))]
      .length,
    3,
    'scale request IDs must be distinct',
  );
  assert.deepEqual(
    [...new Set(['first', 'noChange', 'changed'].map((key) => report.worker.runs[key].id))].length,
    3,
    'scale run IDs must be distinct',
  );
  assert.deepEqual(
    [...new Set(['first', 'noChange', 'changed'].map((key) => report.worker.runs[key].pgBossJobId))]
      .length,
    3,
    'scale PgBoss job IDs must be distinct',
  );
  assert.equal(report.baselineComparison.baseline, 'docs/scale-oracle-baseline.json');
  assert.ok(report.thresholds.advisoryCatalogP95Ms <= scaleBaseline.advisoryHardware.catalogP95Ms);
  assert.ok(report.thresholds.advisorySearchP95Ms <= scaleBaseline.advisoryHardware.searchP95Ms);
  assert.ok(report.thresholds.advisoryScanP95Ms <= scaleBaseline.advisoryHardware.scanP95Ms);
}
const nasGate = evidence.gates.find((gate) => gate.id === 'nas-source');
if (nasGate.status === 'pass')
  await validateNasEvidence(
    nasGate.artifacts.find((artifact) => artifact.role === 'nas-evidence') ?? nasGate.artifacts[0],
  );
if (!evidence.references.issue27.includes('compose-restore-drill'))
  throw new Error('issue27 backup/restore evidence reference is required');
if (hasScaleSchema && !evidence.references.issue26.includes('scale'))
  throw new Error('issue26 scale evidence reference is required');
for (const platform of evidence.platforms) {
  if (platform.status === 'fail') throw new Error(`platform gate failed: ${platform.name}`);
  if (platform.status === 'unavailable' && !platform.reason)
    throw new Error(`unavailable platform has no reason: ${platform.name}`);
}
const validatedSubjects = new Map();
for (const image of evidence.images) {
  assertKeys(image, ['reference', 'digest'], 'image');
  assert.match(image.reference, /@sha256:[0-9a-f]{64}$/);
  assert.match(image.digest, /^sha256:[0-9a-f]{64}$/);
  const appPrefix = manifest.applicationImageRegistry;
  const localSubject = /^local\/gutter-release-(api|worker|web)@sha256:[0-9a-f]{64}$/.exec(
    image.reference,
  );
  const registrySubject = new RegExp(
    `^${appPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/(api|worker|web)@sha256:[0-9a-f]{64}$`,
  ).exec(image.reference);
  assert.ok(
    localSubject || registrySubject,
    `evidence image is not an immutable application subject: ${image.reference}`,
  );
  validatedSubjects.set(image.reference, {
    service: localSubject?.[1] ?? registrySubject?.[1],
    registry: Boolean(registrySubject),
  });
  assert.equal(
    image.reference.slice(image.reference.indexOf('@') + 1),
    image.digest,
    `image digest mismatch: ${image.reference}`,
  );
}
for (const image of evidence.images) {
  const subject = validatedSubjects.get(image.reference)?.service;
  assert.ok(subject, `application subject name missing: ${image.reference}`);
  for (const role of ['sbom-report', 'provenance-attestation']) {
    const gateId = role === 'sbom-report' ? 'sbom' : 'provenance';
    const matching = evidence.gates
      .find((gate) => gate.id === gateId)
      .artifacts.find(
        (artifact) =>
          artifact.role === role &&
          artifact.path.endsWith(
            `${subject}.${role === 'sbom-report' ? 'sbom' : 'provenance'}.json`,
          ),
      );
    assert.ok(matching, `${role} missing for ${image.reference}`);
    const bytes = await safeArtifact(matching.path);
    assert.ok(bytes.length > 0 && bytes.length <= 10 * 1024 * 1024, `${role} size invalid`);
    const parsed = JSON.parse(bytes);
    const serialized = JSON.stringify(parsed);
    const escapedDigest = image.digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(serialized, new RegExp(escapedDigest));
    assert.match(serialized, new RegExp(subject));
    if (validatedSubjects.get(image.reference)?.registry) {
      const escapedSubject = image.reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(serialized, new RegExp(escapedSubject), `${role} subject mismatch`);
    }
  }
}
console.log(
  `release gate final evidence passed (${evidence.gates.length} gates, ${evidence.platforms.length} platforms)`,
);
