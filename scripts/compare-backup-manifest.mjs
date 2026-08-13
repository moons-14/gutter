import { readFile } from 'node:fs/promises';

function parseIdentifier(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2)
      throw new Error(`invalid quoted identifier: ${value}`);
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) throw new Error(`invalid identifier: ${value}`);
  return trimmed;
}

export function parseManifest(text) {
  const names = text
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (names.some((name) => name === '')) throw new Error('manifest contains a blank entry');
  const parsed = names.map(parseIdentifier);
  if (parsed.length === 0) throw new Error('manifest is empty');
  if (new Set(parsed).size !== parsed.length)
    throw new Error('manifest contains duplicate entries');
  return parsed.sort();
}

export function parseToc(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\d+;\s+\d+\s+\d+\s+TABLE\s+public\s+(.+?)\s+\S+\s*$/.exec(line);
    if (!match) continue;
    names.push(parseIdentifier(match[1]));
  }
  if (names.length === 0) throw new Error('TOC contains no public table entries');
  if (new Set(names).size !== names.length) throw new Error('TOC contains duplicate table entries');
  return names.sort();
}

export function compareManifestAndToc(manifestText, tocText) {
  const expected = parseManifest(manifestText);
  const observed = parseToc(tocText);
  if (expected.length !== observed.length || expected.some((name, i) => name !== observed[i])) {
    throw new Error(
      `table set mismatch: expected=${expected.join(',')} observed=${observed.join(',')}`,
    );
  }
  return expected;
}

if (process.argv[1]?.endsWith('compare-backup-manifest.mjs')) {
  const [, , manifestPath, tocPath] = process.argv;
  if (!manifestPath || !tocPath) throw new Error('usage: compare-backup-manifest.mjs MANIFEST TOC');
  compareManifestAndToc(await readFile(manifestPath, 'utf8'), await readFile(tocPath, 'utf8'));
}
