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

test('workflow attestation identity and trigger guard are exact', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  const identity = workflow.match(/RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP: '([^']+)'/)?.[1];
  assert.ok(identity);
  const regexp = new RegExp(identity);
  assert.match(
    'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/heads/main',
    regexp,
  );
  assert.match(
    'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/tags/v1.2.3',
    regexp,
  );
  for (const ref of [
    'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/heads/feature',
    'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/tags/v1.2',
    'https://github.com/moons-14/gutter/.github/workflows/release.yml@refs/tags/v1.2.3-evil',
  ])
    assert.doesNotMatch(ref, regexp);
  assert.match(workflow, /if:.*github\.event_name == 'workflow_dispatch'.*refs\/heads\/main/);
  assert.match(workflow, /Validate release trigger/);
  assert.match(workflow, /tags: \['v\*'\]/);
});

test('container scan preserves colon-tag local image input', async () => {
  const runner = await readFile('scripts/run-release-gates.sh', 'utf8');
  assert.match(runner, /docker save \"\$scan_ref\" -o \"\$archive\"/);
  assert.match(runner, /--input \/scan\.tar/);
  assert.match(runner, /gutter-release-\$service:local/);
  assert.doesNotMatch(runner, /docker run[^\n]+\$scan_ref['\"];/);
});

test('custom Caddy build inputs are immutable and narrowly patched', async () => {
  const dockerfile = await readFile('Dockerfile.web', 'utf8');
  const refs = JSON.parse(await readFile('docs/release-tool-refs.json', 'utf8'));
  assert.match(dockerfile, /golang:1\.26\.5-alpine3\.23@sha256:[0-9a-f]{64}/);
  assert.match(
    dockerfile,
    /ADD --checksum=sha256:[0-9a-f]{64} https:\/\/github\.com\/caddyserver\/caddy\/archive\/refs\/tags\/v2\.11\.4\.tar\.gz/,
  );
  assert.match(dockerfile, /go mod verify/);
  assert.match(dockerfile, /-tags='nobadger nomysql nopgx'/);
  assert.match(
    dockerfile,
    /-ldflags='-s -w -X github\.com\/caddyserver\/caddy\/v2\.CustomVersion=v2\.11\.4'/,
  );
  assert.match(dockerfile, /apk --no-network del curl/);
  assert.doesNotMatch(dockerfile, /apk (?:upgrade|add|update|fix|--no-cache)/);
  assert.ok(
    dockerfile.indexOf('COPY --from=caddy-build --chown=root:root /out/caddy /usr/bin/caddy') <
      dockerfile.indexOf('apk --no-network del curl'),
  );
  assert.ok(
    dockerfile.indexOf('apk --no-network del curl') <
      dockerfile.indexOf('setcap cap_net_bind_service=+ep /usr/bin/caddy'),
  );
  assert.ok(
    dockerfile.indexOf('setcap cap_net_bind_service=+ep /usr/bin/caddy') <
      dockerfile.indexOf('caddy validate --config /etc/caddy/Caddyfile'),
  );
  assert.equal(refs.caddySource.customVersion, 'v2.11.4');
  assert.deepEqual(refs.caddySource.moduleRequirements, {
    'golang.org/x/net': 'v0.56.0',
    'golang.org/x/text': 'v0.39.0',
    'google.golang.org/grpc': 'v1.82.1',
  });
  assert.match(refs.caddySource.builderImage, /^golang:1\.26\.5-alpine3\.23@sha256:[0-9a-f]{64}$/);
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
