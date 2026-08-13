import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const [resultsPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !outputPath)
  throw new Error('usage: generate-release-evidence.mjs RESULTS.tsv OUTPUT.json');
const root = resolve(process.env.RELEASE_GATE_ROOT ?? new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(
  await readFile(resolve(root, 'docs/release-gate-manifest.json'), 'utf8'),
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const safeRepoPath = (value) => {
  const candidate = value.startsWith('/') ? relative(root, value) : value;
  if (!candidate || candidate.startsWith('..') || candidate.includes('\\'))
    throw new Error(`unsafe evidence path: ${value}`);
  return candidate;
};
const safeRunnerLogPath = (value, gateId) => {
  const candidate = safeRepoPath(value);
  if (candidate !== `release-artifacts/${gateId}.log`)
    throw new Error(`unsafe runner log path: ${value}`);
  return candidate;
};
const lines = (await readFile(resolve(root, resultsPath), 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean);
const results = new Map(
  lines.map((line) => {
    const [id, command, commandHash, status, log, logHash] = line.split('\t');
    if (!/^\d+$/.test(status)) throw new Error(`malformed runner status: ${id}`);
    return [id, { id, command, commandHash, status: Number(status), log, logHash }];
  }),
);
for (const id of results.keys())
  if (!(id in manifest.gateCommands)) throw new Error(`unknown runner gate ID: ${id}`);
for (const result of results.values()) {
  if (!/^[0-9a-f]{64}$/.test(result.commandHash) || !/^[0-9a-f]{64}$/.test(result.logHash))
    throw new Error(`malformed runner hash: ${result.id}`);
  if (!/^(0|[1-9][0-9]*)$/.test(String(result.status)))
    throw new Error(`malformed runner status: ${result.id}`);
  if (
    !result.log ||
    result.log.includes('\\') ||
    result.log.startsWith('/') ||
    result.log.split('/').includes('..')
  )
    throw new Error(`unsafe runner log path: ${result.id}`);
}
if (lines.some((line) => line.split('\t').length !== 6))
  throw new Error('malformed runner TSV field count');
if (new Set(lines.map((line) => line.split('\t')[0])).size !== lines.length)
  throw new Error('duplicate runner gate ID');
for (const [id, command] of Object.entries(manifest.gateCommands)) {
  const result = results.get(id);
  if (!result || result.command !== command || result.commandHash !== sha(command))
    throw new Error(`runner result missing or failed: ${id}`);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const lockfileSha256 = sha(await readFile(resolve(root, 'pnpm-lock.yaml')));
const requiredArtifacts = await Promise.all(
  manifest.requiredArtifacts.map(async ({ path, role, gate }) => ({
    path,
    role,
    gate,
    sha256: sha(await readFile(resolve(root, path))),
  })),
);
const gates = [...results.values()].map((result) => ({
  id: result.id,
  status: result.status === 0 ? 'pass' : result.status === 99 ? 'blocked' : 'fail',
  command: result.command,
  commandHash: result.commandHash,
  artifacts: [
    {
      path: safeRunnerLogPath(result.log, result.id),
      role: result.id === 'nas-source' ? 'nas-evidence' : 'runner-log',
      gate: result.id,
      sha256: result.logHash,
    },
  ],
}));
for (const artifact of requiredArtifacts)
  gates.find((gate) => gate.id === artifact.gate).artifacts.push(artifact);
const artifactDir = resolve(root, process.env.RELEASE_ARTIFACT_DIR ?? 'release-artifacts');
for (const name of await readdir(artifactDir).catch(() => [])) {
  const gateId = name.endsWith('.sbom.json')
    ? 'sbom'
    : name.endsWith('.provenance.json')
      ? 'provenance'
      : null;
  if (!gateId) continue;
  const bytes = await readFile(resolve(artifactDir, name));
  gates
    .find((gate) => gate.id === gateId)
    .artifacts.push({
      path: safeRepoPath(resolve(artifactDir, name)),
      role: gateId === 'sbom' ? 'sbom-report' : 'provenance-attestation',
      gate: gateId,
      sha256: sha(bytes),
    });
}
const scaleEvidencePath = 'release-artifacts/scale-evidence.json';
try {
  const scaleGate = gates.find((gate) => gate.id === 'scale-concurrency');
  scaleGate.artifacts.push({
    path: scaleEvidencePath,
    role: 'scale-evidence',
    gate: 'scale-concurrency',
    sha256: sha(await readFile(resolve(root, scaleEvidencePath))),
  });
} catch {
  // Pre-#26 runs intentionally remain blocked and cannot fabricate scale evidence.
}
const mappingPath = process.env.RELEASE_APPLICATION_SUBJECTS;
const mappings = mappingPath
  ? JSON.parse(await readFile(mappingPath, 'utf8'))
  : (process.env.RELEASE_IMAGE_REFS ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((subject) => ({ subject }));
if (!Array.isArray(mappings) || mappings.length !== 3)
  throw new Error('three application subjects are required');
const images = mappings.map((entry) => ({
  reference: entry.subject,
  digest: entry.subject.slice(entry.subject.indexOf('@') + 1),
}));
const evidence = {
  schemaVersion: 'gutter.release-evidence.v1',
  exactTree: { commit, lockfileSha256 },
  images,
  gates,
  platforms: [
    { name: 'linux', status: 'pass', command: 'release workflow' },
    {
      name: 'macos-docker',
      status: 'unavailable',
      command: 'release workflow',
      reason: 'Docker Desktop macOS runner is not available on this Linux runner',
    },
    {
      name: 'windows-docker',
      status: 'unavailable',
      command: 'release workflow',
      reason: 'Docker Desktop Windows runner is not available on this Linux runner',
    },
  ],
  references: {
    issue26: 'release-artifacts/scale-evidence.json',
    issue27: 'scripts/compose-restore-drill.sh',
  },
  threatClaims: manifest.threatClaims,
};
await writeFile(resolve(root, outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
