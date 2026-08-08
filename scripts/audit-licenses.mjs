import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as prettier from 'prettier';

const allowedLicenses = new Set([
  '(MIT OR CC0-1.0)',
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PostgreSQL',
  'Unlicense',
]);
const approvedExceptions = new Set(['@img/sharp-libvips-linux-x64@1.3.2:LGPL-3.0-or-later']);
const forbiddenCopyleft = /(?:^|[^A-Z])(?:A?GPL)(?:-|\s|$)/i;

const output = execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'licenses', 'list', '--json'],
  {
    encoding: 'utf8',
  },
);
const licenses = JSON.parse(output);
const packages = [];

for (const [licenseLabel, entries] of Object.entries(licenses)) {
  if (!Array.isArray(entries)) throw new Error(`invalid license list entries for ${licenseLabel}`);

  for (const entry of entries) {
    if (!entry?.name || entry.license !== licenseLabel || !Array.isArray(entry.versions)) {
      throw new Error(`invalid license list record for ${licenseLabel}`);
    }

    for (const version of entry.versions) {
      const exception = `${entry.name}@${version}:${entry.license}`;
      if (forbiddenCopyleft.test(entry.license) && !approvedExceptions.has(exception)) {
        throw new Error(`forbidden GPL/AGPL license: ${exception}`);
      }
      if (!allowedLicenses.has(entry.license) && !approvedExceptions.has(exception)) {
        throw new Error(`unapproved license: ${exception}`);
      }
      packages.push({ name: entry.name, version, license: entry.license });
    }
  }
}

packages.sort(
  (left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.license.localeCompare(right.license),
);
const report = { packages };
const prettierConfig = await prettier.resolveConfig('docs/license-audit.json');
const formattedReport = await prettier.format(JSON.stringify(report), {
  ...prettierConfig,
  filepath: 'docs/license-audit.json',
});
await writeFile('docs/license-audit.json', formattedReport);
console.log(`license audit passed: ${packages.length} dependency records`);
