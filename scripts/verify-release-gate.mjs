import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFile(resolve(root, file), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] ?? 'contract';
if (!['contract', 'final'].includes(mode))
  throw new Error('usage: verify-release-gate.mjs [contract|final] [evidence.json]');
const manifest = JSON.parse(await read('docs/release-gate-manifest.json'));
assert.equal(manifest.schemaVersion, 'gutter.release-gate.v1');
for (const file of manifest.requiredArtifacts) await read(file);

const compose = await read('compose.yaml');
const production = await read('compose.production.example.yaml');
const library = await read('compose.library.example.yaml');
const docs = await read('docs/release-gate.md');
const dockerfile = await read('Dockerfile');
const webDockerfile = await read('Dockerfile.web');
const pkg = JSON.parse(await read('package.json'));
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
for (const name of manifest.requiredImageNames)
  if (!allImages.some((image) => image.startsWith(`${name}:`) || image.includes(`/${name}:`)))
    throw new Error(`required image missing: ${name}`);

if (mode === 'contract') {
  console.log(
    `release gate contract structure passed (${manifest.requiredGateIds.length} gate IDs)`,
  );
  process.exit(0);
}

const evidencePath = process.argv[3];
if (!evidencePath) throw new Error('final mode requires evidence.json');
const evidence = JSON.parse(await read(evidencePath));
assert.equal(evidence.schemaVersion, 'gutter.release-evidence.v1');
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
  if (gate.status !== 'pass')
    throw new Error(`release gate is not pass: ${gate.id}=${gate.status}`);
  for (const artifact of gate.artifacts) {
    if (artifact.path.startsWith('/') || artifact.path.split('/').includes('..'))
      throw new Error(`artifact path escapes tree: ${artifact.path}`);
    const bytes = await read(artifact.path);
    assert.equal(sha256(bytes), artifact.sha256, `artifact checksum mismatch: ${artifact.path}`);
  }
}
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
