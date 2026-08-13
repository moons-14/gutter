import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareManifestAndToc, parseManifest, parseToc } from '../scripts/compare-backup-manifest.mjs';

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
  const manifest = await readFile(new URL('../scripts/backup-table-manifest.v1', import.meta.url), 'utf8');
  const expected = parseManifest(manifest);
  assert.ok(expected.length > 20);
  assert.throws(() => compareManifestAndToc(manifest, fixture), /mismatch/);
});
