import { readFile } from 'node:fs/promises';

const [path] = process.argv.slice(2);
const allowLocal = process.argv.includes('--allow-local');
if (!path) throw new Error('usage: validate-application-subjects.mjs mapping.json');
const raw = await readFile(path, 'utf8');
if (
  raw.length === 0 ||
  raw.length > 64 * 1024 ||
  /[\u0000-\u001f\u007f]/.test(raw.replace(/\r?\n$/, ''))
)
  throw new Error('application subject mapping contains control characters or is too large');
let entries;
try {
  entries = JSON.parse(raw);
} catch {
  throw new Error('application subject mapping is not valid JSON');
}
if (!Array.isArray(entries) || entries.length !== 3)
  throw new Error('exactly three application subjects are required');
const expected = ['api', 'worker', 'web'];
const subjects = new Map();
for (const entry of entries) {
  if (!entry || Object.keys(entry).some((key) => !['service', 'localTag', 'subject'].includes(key)))
    throw new Error('unexpected application subject property');
  if (
    typeof entry.service !== 'string' ||
    typeof entry.subject !== 'string' ||
    typeof entry.localTag !== 'string'
  )
    throw new Error('application subject fields must be strings');
  if (!expected.includes(entry.service) || subjects.has(entry.service))
    throw new Error('application services must be unique');
  const subjectPattern = allowLocal
    ? new RegExp(
        `^(?:ghcr\\.io/moons-14/gutter|local/gutter-release)/${entry.service}@sha256:[0-9a-f]{64}$`,
      )
    : new RegExp(`^ghcr\\.io/moons-14/gutter/${entry.service}@sha256:[0-9a-f]{64}$`);
  if (
    entry.subject.includes('\n') ||
    entry.subject.trim() !== entry.subject ||
    !subjectPattern.test(entry.subject)
  )
    throw new Error(`invalid application subject for ${entry.service}`);
  subjects.set(entry.service, entry.subject);
}
if (expected.some((service) => !subjects.has(service)))
  throw new Error('application services are incomplete');
process.stdout.write(
  JSON.stringify(expected.map((service) => ({ service, subject: subjects.get(service) }))),
);
