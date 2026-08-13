import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFile(resolve(root, file), 'utf8');
const safeArtifact = async (file) => {
  if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..'))
    throw new Error(`unsafe artifact path: ${file}`);
  const target = resolve(root, file);
  const rootReal = await realpath(root);
  const targetReal = await realpath(target);
  if (relative(rootReal, targetReal).startsWith('..'))
    throw new Error(`artifact escapes tree: ${file}`);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`artifact symlink is not allowed: ${file}`);
  return readFile(target);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? 'contract';
if (!['contract', 'final'].includes(mode))
  throw new Error('usage: verify-release-gate.mjs [contract|final] [evidence.json]');
const manifest = JSON.parse(await read('docs/release-gate-manifest.json'));
const toolRefs = JSON.parse(await read('docs/release-tool-refs.json'));
assert.equal(manifest.schemaVersion, 'gutter.release-gate.v1');
for (const file of manifest.requiredArtifacts) await read(file);

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
const allImages = [...imageRefs, ...fromRefs.filter((image) => image.includes(':'))];
for (const image of allImages)
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`image is not digest pinned: ${image}`);
const imageName = (image) => image.slice(0, image.indexOf('@')).split('/').at(-1).split(':')[0];
assert.deepEqual(
  [...new Set(allImages.map(imageName))].sort(),
  [...manifest.requiredImageNames].sort(),
  'image set is incomplete or mutable',
);
const actionWorkflow = `${await read('.github/workflows/ci.yml')}\n${await read('.github/workflows/release.yml')}`;
for (const ref of actionWorkflow.matchAll(/uses:\s*([^\s]+)/g))
  if (!/@[0-9a-f]{40}$/.test(ref[1]))
    throw new Error(`GitHub Action is not commit pinned: ${ref[1]}`);
for (const [name, ref] of Object.entries(toolRefs.images))
  if (!/@sha256:[0-9a-f]{64}$/.test(ref))
    throw new Error(`release tool is not digest pinned: ${name}`);

if (mode === 'contract') {
  console.log(
    `release gate contract structure passed (${manifest.requiredGateIds.length} gate IDs)`,
  );
  process.exit(0);
}

const evidencePath = process.argv[3];
if (!evidencePath) throw new Error('final mode requires evidence.json');
const evidence = JSON.parse(await safeArtifact(evidencePath));
assert.equal(evidence.schemaVersion, 'gutter.release-evidence.v1');
assert.ok(Array.isArray(evidence.images) && evidence.images.length > 0, 'images are required');
assert.ok(Array.isArray(evidence.gates) && evidence.gates.length > 0, 'gates are required');
assert.ok(
  Array.isArray(evidence.platforms) && evidence.platforms.length > 0,
  'platforms are required',
);
assert.deepEqual(
  [...new Set(evidence.images.map((image) => imageName(image.reference)))].sort(),
  [...manifest.requiredImageNames].sort(),
  'evidence image set is incomplete or duplicated',
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
  assert.ok(
    gate.id && gate.command.trim() && Array.isArray(gate.artifacts) && gate.artifacts.length > 0,
    `gate evidence incomplete: ${gate.id}`,
  );
  if (gate.status !== 'pass')
    throw new Error(`release gate is not pass: ${gate.id}=${gate.status}`);
  for (const artifact of gate.artifacts) {
    const bytes = await safeArtifact(artifact.path);
    assert.equal(sha256(bytes), artifact.sha256, `artifact checksum mismatch: ${artifact.path}`);
  }
}
const represented = new Set(
  evidence.gates.flatMap((gate) => gate.artifacts.map((artifact) => artifact.path)),
);
for (const required of manifest.requiredArtifacts) {
  if (!represented.has(required))
    throw new Error(`required artifact is not represented: ${required}`);
  const artifact = evidence.gates
    .flatMap((gate) => gate.artifacts)
    .find((entry) => entry.path === required);
  assert.equal(
    sha256(await safeArtifact(required)),
    artifact.sha256,
    `required artifact checksum mismatch: ${required}`,
  );
}
if (evidence.platforms.find((platform) => platform.name === 'linux')?.status !== 'pass')
  throw new Error('Linux platform must pass');
for (const platform of evidence.platforms) {
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
const hasScaleSchema = await Promise.all(
  ['docs/scale-oracle-evidence.schema.json', 'docs/scale-oracle-baseline.json'].map(
    async (file) => {
      try {
        await read(file);
        return true;
      } catch {
        return false;
      }
    },
  ),
).then((values) => values.every(Boolean));
if (manifest.deferredUntil['scale-concurrency'] && (!hasScaleSchema || scaleGate.status !== 'pass'))
  throw new Error('scale-concurrency cannot pass until #26 schema, baseline, and evidence exist');
if (!evidence.references.issue27.includes('compose-restore-drill'))
  throw new Error('issue27 backup/restore evidence reference is required');
if (hasScaleSchema && !evidence.references.issue26.includes('scale'))
  throw new Error('issue26 scale evidence reference is required');
for (const platform of evidence.platforms) {
  if (platform.status === 'fail') throw new Error(`platform gate failed: ${platform.name}`);
  if (platform.status === 'unavailable' && !platform.reason)
    throw new Error(`unavailable platform has no reason: ${platform.name}`);
}
for (const image of evidence.images) {
  assert.match(image.reference, /@sha256:[0-9a-f]{64}$/);
  assert.match(image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(
    allImages.includes(image.reference),
    `evidence image is not pinned in tree: ${image.reference}`,
  );
  assert.equal(
    image.reference.slice(image.reference.indexOf('@') + 1),
    image.digest,
    `image digest mismatch: ${image.reference}`,
  );
}
console.log(
  `release gate final evidence passed (${evidence.gates.length} gates, ${evidence.platforms.length} platforms)`,
);
