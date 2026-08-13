import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  compareManifestAndToc,
  parseManifest,
  parseToc,
} from '../scripts/compare-backup-manifest.mjs';

const execFileAsync = promisify(execFile);

// Realistic pg_restore --list output: data rows are numeric entries, while comments
// begin with ';'. Reserved identifiers may be quoted (notably the Better Auth "user" table).
const fixture = `;
; Archive created at 2026-08-13
215; 1259 16385 TABLE public user postgres
216; 1259 16386 TABLE public "session" postgres
217; 1259 16387 TABLE public library_roots postgres
218; 0 0 COMMENT public TABLE user postgres
`;

test('parses numeric TOC rows and quoted identifiers, ignoring comments', () => {
  assert.deepEqual(parseToc(fixture), ['library_roots', 'session', 'user']);
});

test('rejects an empty table set before manifest comparison', () => {
  assert.throws(() => parseToc('; only comments\n'), /no public table/);
});

test('accepts the versioned manifest with one terminal newline and compares exact sorted sets', () => {
  const manifest = 'user\nsession\nlibrary_roots\n';
  assert.deepEqual(parseManifest(manifest), ['library_roots', 'session', 'user']);
  assert.deepEqual(compareManifestAndToc(manifest, fixture), ['library_roots', 'session', 'user']);
});

test('rejects blank, duplicate, empty, and mismatched manifest/table sets', () => {
  assert.throws(() => parseManifest('user\n\nsession\n'), /blank/);
  assert.throws(() => parseManifest('user\nuser\n'), /duplicate/);
  assert.throws(() => parseManifest(''), /blank|empty/);
  assert.throws(() => compareManifestAndToc('user\nsession\n', fixture), /mismatch/);
});

test('accepts the checked-in current manifest and rejects a TOC that omits one required table', async () => {
  const manifest = await readFile(
    new URL('../scripts/backup-table-manifest.v1', import.meta.url),
    'utf8',
  );
  const expected = parseManifest(manifest);
  assert.ok(expected.length > 20);
  assert.throws(() => compareManifestAndToc(manifest, fixture), /mismatch/);
});

test('executes the POSIX comparator used inside the postgres image, including quoted names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gutter-backup-toc-'));
  try {
    const manifest = join(root, 'manifest');
    const toc = join(root, 'toc');
    await writeFile(manifest, '"a b"\nuser\n');
    await writeFile(toc, '1; 0 0 TABLE public user owner\n2; 0 0 TABLE public "a b" owner\n');
    await execFileAsync('sh', ['scripts/compare-backup-manifest.sh', manifest, toc]);
    await writeFile(toc, '1; 0 0 TABLE public user owner\n1; 0 0 TABLE public user owner\n');
    await assert.rejects(
      execFileAsync('sh', ['scripts/compare-backup-manifest.sh', manifest, toc]),
      /duplicate/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checksum sidecars remain valid after moving the archive', async () => {
  const source = await mkdtemp(join(tmpdir(), 'gutter-backup-checksum-'));
  const moved = await mkdtemp(join(tmpdir(), 'gutter-backup-moved-'));
  try {
    await writeFile(join(source, 'backup.dump'), 'synthetic archive');
    const { stdout } = await execFileAsync('sha256sum', ['backup.dump'], { cwd: source });
    await writeFile(join(source, 'backup.dump.sha256'), stdout);
    await execFileAsync('cp', [join(source, 'backup.dump'), join(moved, 'backup.dump')]);
    await execFileAsync('cp', [
      join(source, 'backup.dump.sha256'),
      join(moved, 'backup.dump.sha256'),
    ]);
    await execFileAsync('sha256sum', ['--check', 'backup.dump.sha256'], { cwd: moved });
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
