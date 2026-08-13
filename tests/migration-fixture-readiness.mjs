import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const sourceRoot = resolve(new URL('..', import.meta.url).pathname);

test('migration fixture waits for a real query on the final PostgreSQL server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-migration-readiness-'));
  const bin = join(root, 'bin');
  const dockerLog = join(root, 'docker.log');
  const readinessState = join(root, 'readiness-count');
  const oracleLog = join(root, 'oracle.log');
  try {
    await mkdir(bin);
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'packages/db'), { recursive: true });
    await cp(
      join(sourceRoot, 'scripts/prepare-migration-compatibility-fixture.sh'),
      join(root, 'scripts/prepare-migration-compatibility-fixture.sh'),
    );
    await cp(join(sourceRoot, 'packages/db/drizzle'), join(root, 'packages/db/drizzle'), {
      recursive: true,
    });

    const oracle = join(root, 'scripts/migration-compatibility-oracle.sh');
    await writeFile(
      oracle,
      `#!/bin/sh
set -eu
test -s "$GUTTER_MIGRATION_DUMP"
printf '%s\n' "$GUTTER_DATABASE_URL" >"$MIGRATION_ORACLE_LOG"
`,
    );
    await chmod(oracle, 0o755);

    const docker = join(bin, 'docker');
    await writeFile(
      docker,
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MIGRATION_DOCKER_LOG"
command_name=\${1:-}
shift || true
case "$command_name" in
  run) exit 0 ;;
  port) printf '127.0.0.1:65432\n' ;;
  inspect) printf 'true\n' ;;
  logs|rm) exit 0 ;;
  cp)
    destination=''
    for argument in "$@"; do destination=$argument; done
    mkdir -p "$(dirname "$destination")"
    printf 'fixture dump\n' >"$destination"
    ;;
  exec)
    arguments="$*"
    case "$arguments" in
      *' sh -ec '*) exit 0 ;;
      *' pg_isready '*) exit 0 ;;
      *' psql '*'-Atqc select 1'*)
        count=0
        if [ -f "$MIGRATION_READINESS_STATE" ]; then count=$(cat "$MIGRATION_READINESS_STATE"); fi
        count=$((count + 1))
        printf '%s\n' "$count" >"$MIGRATION_READINESS_STATE"
        if [ "$count" -eq 1 ]; then
          printf 'readiness-fail\n' >>"$MIGRATION_DOCKER_LOG"
          exit 1
        fi
        printf 'readiness-pass\n' >>"$MIGRATION_DOCKER_LOG"
        ;;
      *' psql '*)
        test "$(cat "$MIGRATION_READINESS_STATE" 2>/dev/null || printf 0)" -ge 2
        printf 'fixture-sql\n' >>"$MIGRATION_DOCKER_LOG"
        ;;
      *' pg_dump '*) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(docker, 0o755);

    await exec('sh', ['scripts/prepare-migration-compatibility-fixture.sh'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MIGRATION_DOCKER_LOG: dockerLog,
        MIGRATION_READINESS_STATE: readinessState,
        MIGRATION_ORACLE_LOG: oracleLog,
      },
      timeout: 15_000,
    });

    assert.equal(await readFile(readinessState, 'utf8'), '3\n');
    assert.match(await readFile(oracleLog, 'utf8'), /^postgresql:\/\/gutter:fixture-/);
    const calls = await readFile(dockerLog, 'utf8');
    assert.match(calls, /sh -ec test .*\/proc\/1\/comm.*postgres/);
    assert.doesNotMatch(calls, /pg_isready/);
    assert.ok(calls.indexOf('readiness-pass') < calls.indexOf('fixture-sql'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
