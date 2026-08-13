import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
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
  const identity = workflow.match(
    /RELEASE_ATTESTATION_CERTIFICATE_IDENTITY_REGEXP: '([^']+)'/,
  )?.[1];
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
  const runner = await readFile('scripts/run-release-gates.sh', 'utf8');
  assert.match(runner, /--source-digest "\$GITHUB_SHA"/);
  assert.match(runner, /--source-ref "\$GITHUB_REF"/);
  assert.match(runner, /--predicate-type https:\/\/slsa\.dev\/provenance\/v1/);
});

test('container scan preserves colon-tag local image input', async () => {
  const runner = await readFile('scripts/run-release-gates.sh', 'utf8');
  assert.match(runner, /docker save \"\$scan_ref\" -o \"\$archive\"/);
  assert.match(runner, /--input \/scan\.tar/);
  assert.match(runner, /gutter-release-\$service:local/);
  assert.doesNotMatch(runner, /docker run[^\n]+\$scan_ref['\"];/);
});

test('prepared release subjects use portable regular-file and symlink checks', async () => {
  const runner = await readFile('scripts/run-release-gates.sh', 'utf8');
  assert.doesNotMatch(runner, /test -f [^\n]+ ! -L/);
  assert.match(
    runner,
    /test -f \"\$RELEASE_PREPARED_SUBJECTS\"\n\s+test ! -L \"\$RELEASE_PREPARED_SUBJECTS\"/,
  );
  assert.match(
    runner,
    /test -f \"\$\{RELEASE_PREPARED_SUBJECTS%\.json\}\.tsv\"\n\s+test ! -L \"\$\{RELEASE_PREPARED_SUBJECTS%\.json\}\.tsv\"/,
  );
});

test('release runtime gates use readable disposable secrets and isolated Compose state', async () => {
  const runner = await readFile('scripts/run-release-gates.sh', 'utf8');
  const smoke = await readFile('scripts/compose-smoke-release.sh', 'utf8');
  const restore = await readFile('scripts/compose-restore-drill.sh', 'utf8');
  const fixture = await readFile('scripts/prepare-migration-compatibility-fixture.sh', 'utf8');
  const migration = await readFile('scripts/migration-compatibility-oracle.sh', 'utf8');
  assert.match(runner, /chmod 0444 "\$path"/);
  assert.match(
    runner,
    /run_gate migrations '\.\/scripts\/prepare-migration-compatibility-fixture\.sh' \.\/scripts\/prepare-migration-compatibility-fixture\.sh/,
  );
  assert.match(
    runner,
    /run_gate compose-smoke '\.\/scripts\/compose-smoke-release\.sh' \.\/scripts\/compose-smoke-release\.sh/,
  );
  assert.match(smoke, /project="gutter-release-smoke-/);
  assert.match(
    smoke,
    /docker compose -p "\$project" up --build --abort-on-container-exit --exit-code-from test test/,
  );
  assert.match(smoke, /docker compose -p "\$project" down -v --remove-orphans/);
  assert.doesNotMatch(smoke, /docker compose down/);
  assert.doesNotMatch(restore, /trap[^\n]*\bERR\b|\$LINENO/);
  assert.match(restore, /compose_build_flags="--build"/);
  assert.match(
    restore,
    /chmod 0755 "\$root\/source" "\$root\/source\/title" "\$root\/source\/visible"/,
  );
  assert.match(
    restore,
    /chmod 0644 "\$root\/source\/title\/001\.png" "\$root\/source\/visible\/001\.png"/,
  );
  assert.match(restore, /synthetic source fixture is worker-readable/);
  assert.match(restore, /while \[ "\$attempt" -le 45 \]/);
  assert.match(restore, /pgboss\.job where name='catalog\.reconciliation\.v1'/);
  const projectionReset = restore.indexOf('delete from catalog_series_list_state');
  const runtimeStart = restore.indexOf('up $compose_build_flags -d api worker web');
  assert.ok(
    projectionReset >= 0 &&
      restore.lastIndexOf('delete from catalog_series_list_state') < runtimeStart,
  );
  assert.match(restore, /scan enqueue submitted request_id=\$scan_request_id/);
  assert.match(restore, /candidate\.id === process\.env\.DRILL_SCAN_REQUEST_ID/);
  assert.match(restore, /catalog projection is missing after the requested scan completed/);
  assert.match(fixture, /prior_tag=0013_runtime_acl_bootstrap/);
  assert.match(fixture, /meta\/_journal\.json/);
  assert.match(fixture, /postgres:18\.1@sha256:[0-9a-f]{64}/);
  assert.match(migration, /test ! -L "\$GUTTER_MIGRATION_DUMP"/);
  assert.match(migration, /where version='\$current_version'/);
});

test('release Compose smoke preserves failure status and cleans only its random project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-compose-smoke-'));
  const docker = join(root, 'docker');
  const log = join(root, 'docker.log');
  try {
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s\\n' "$*" >>"$GUTTER_DOCKER_LOG"
case " $* " in *' up '*) exit 7 ;; esac
`,
    );
    await chmod(docker, 0o755);
    await assert.rejects(
      exec('sh', ['scripts/compose-smoke-release.sh'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GUTTER_DOCKER_LOG: log },
      }),
      (error) => error.code === 7,
    );
    const commands = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(commands.length, 2);
    const project = commands[0]?.match(/^compose -p (gutter-release-smoke-[0-9a-f]+) up /)?.[1];
    assert.ok(project);
    assert.equal(commands[1], `compose -p ${project} down -v --remove-orphans`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
