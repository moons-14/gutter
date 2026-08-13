import assert from 'node:assert/strict';
import test from 'node:test';

// Realistic pg_restore --list output: data rows are numeric entries, while comments
// begin with ';'. Reserved identifiers may be quoted (notably the Better Auth "user" table).
const fixture = `;
; Archive created at 2026-08-13
215; 1259 16385 TABLE public user postgres
216; 1259 16386 TABLE public "session" postgres
217; 1259 16387 TABLE public library_roots postgres
218; 0 0 COMMENT public TABLE user postgres
`;

function parsePublicTables(toc) {
  return toc
    .split('\n')
    .filter((line) => /^\s*\d+;\s+\d+\s+\d+\s+TABLE\s+public\s+/.test(line))
    .map((line) => line.trim().split(/\s+/)[5].replace(/^"|"$/g, ''))
    .sort();
}

test('parses numeric TOC rows and quoted identifiers, ignoring comments', () => {
  assert.deepEqual(parsePublicTables(fixture), ['library_roots', 'session', 'user']);
});

test('rejects an empty table set before manifest comparison', () => {
  assert.deepEqual(parsePublicTables('; only comments\n'), []);
});
