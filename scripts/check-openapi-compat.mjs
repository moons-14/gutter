import { readFile } from 'node:fs/promises';
const [basePath, candidatePath] = process.argv.slice(2);
if (!basePath || !candidatePath) process.exit(2);
const parse = async (path) => {
  const text = await readFile(path, 'utf8');
  return new Set([...text.matchAll(/^  (\/[^:]+):|^    (get|post|put|patch|delete):/gm)].map((m) => m[1] ?? m[2]));
};
const [base, candidate] = await Promise.all([parse(basePath), parse(candidatePath)]);
const removed = [...base].filter((entry) => !candidate.has(entry));
if (removed.length) { console.error(`Breaking public API change: ${removed.join(', ')}`); process.exit(1); }
console.log(`OpenAPI compatibility OK (${candidate.size} entries)`);
