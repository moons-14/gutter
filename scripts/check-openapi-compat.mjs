import { readFile } from 'node:fs/promises';
const [basePath, candidatePath] = process.argv.slice(2);
if (!basePath || !candidatePath) process.exit(2);
const parse = async (path) => {
  const text = await readFile(path, 'utf8');
  const entries = new Set();
  let currentPath = '';
  for (const line of text.split('\n')) {
    const pathMatch = line.match(/^  (\/[^:]+):$/);
    if (pathMatch) { currentPath = pathMatch[1]; continue; }
    const methodMatch = line.match(/^    (get|post|put|patch|delete):/);
    if (methodMatch && currentPath) entries.add(`${currentPath} ${methodMatch[1]}`);
  }
  return entries;
};
const [base, candidate] = await Promise.all([parse(basePath), parse(candidatePath)]);
const removed = [...base].filter((entry) => !candidate.has(entry));
if (removed.length) {
  console.error(`Breaking public API change: ${removed.join(', ')}`);
  process.exit(1);
}
console.log(`OpenAPI compatibility OK (${candidate.size} entries)`);
