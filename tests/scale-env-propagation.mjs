import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = new URL('..', import.meta.url).pathname;

test('run-scale-oracle propagates SCALE_FULL dataset defaults to Compose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-scale-env-'));
  const bin = join(root, 'bin');
  const record = join(root, 'compose-env.txt');
  const evidence = join(root, 'evidence.json');
  await mkdir(bin);
  const docker = join(bin, 'docker');
  await writeFile(
    docker,
    `#!/bin/sh
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *' run '*) ;;
    *) exit 0 ;;
  esac
  printf 'books=%s pages=%s\\n' "\${SCALE_BOOKS:-}" "\${SCALE_PAGES_PER_BOOK:-}" >"$SCALE_RECORD"
  mkdir -p "$SCALE_EVIDENCE_DIR"
  printf '{"schemaVersion":"test"}\\n' >"$SCALE_EVIDENCE_DIR/evidence.json"
fi
`,
  );
  await chmod(docker, 0o755);

  try {
    await execFileAsync('sh', ['scripts/run-scale-oracle.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCALE_DOCKER_PREFLIGHT: '0',
        SCALE_FULL: '1',
        SCALE_RECORD: record,
        SCALE_RUN_ID: 'test-scale-env',
        SCALE_EVIDENCE_PATH: evidence,
      },
    });
    assert.equal(await readFile(record, 'utf8'), 'books=100000 pages=20\n');
    assert.equal(await readFile(evidence, 'utf8'), '{"schemaVersion":"test"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
