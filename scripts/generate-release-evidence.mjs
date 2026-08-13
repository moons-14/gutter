import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const [resultsPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !outputPath)
  throw new Error('usage: generate-release-evidence.mjs RESULTS.tsv OUTPUT.json');
const root = resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(
  await readFile(resolve(root, 'docs/release-gate-manifest.json'), 'utf8'),
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const lines = (await readFile(resolve(root, resultsPath), 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean);
const results = new Map(
  lines.map((line) => {
    const [id, command, commandHash, status, log, logHash] = line.split('\t');
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
      path: result.log,
      role: result.id === 'nas-source' ? 'nas-evidence' : 'runner-log',
      gate: result.id,
      sha256: result.logHash,
    },
  ],
}));
for (const artifact of requiredArtifacts)
  gates.find((gate) => gate.id === artifact.gate).artifacts.push(artifact);
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
const images = (process.env.RELEASE_IMAGE_REFS ?? '')
  .split(/\s+/)
  .filter(Boolean)
  .map((reference) => ({ reference, digest: reference.slice(reference.indexOf('@') + 1) }));
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
      reason: 'not available on Linux runner',
    },
    {
      name: 'windows-docker',
      status: 'unavailable',
      command: 'release workflow',
      reason: 'not available on Linux runner',
    },
  ],
  references: {
    issue26: 'pending #26 scale evidence',
    issue27: 'scripts/compose-restore-drill.sh',
  },
  threatClaims: manifest.threatClaims,
};
await writeFile(resolve(root, outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
