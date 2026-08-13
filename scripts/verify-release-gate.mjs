import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFile(resolve(root, file), 'utf8');
const manifest = JSON.parse(await read('docs/release-gate-manifest.json'));
assert.equal(manifest.schemaVersion, 'gutter.release-gate.v1');
for (const file of manifest.requiredArtifacts) await read(file);

const compose = await read('compose.yaml');
const production = await read('compose.production.example.yaml');
const library = await read('compose.library.example.yaml');
const docs = await read('docs/release-gate.md');
const dockerfile = await read('Dockerfile');
const webDockerfile = await read('Dockerfile.web');
const pkg = JSON.parse(await read('package.json'));

assert.equal(pkg.packageManager, 'pnpm@11.20.0');
assert.match(dockerfile, /node:24\.19\.0-bookworm-slim/);
assert.match(webDockerfile, /caddy:2\.10\.2-alpine/);
assert.match(compose, /postgres:18\.1/);
assert.match(library, /:\/libraries\/comics:ro/);
assert.match(production, /GUTTER_ALLOWED_ROOTS_JSON|GUTTER_READER_CAPABILITY_SECRET_FILE/);
assert.match(docs, /unavailable/);
assert.match(docs, /SBOM/);
assert.match(docs, /provenance/);
assert.match(docs, /external SaaS dependency/);
assert.match(docs, /source mounts are `:ro`/);
if (/image:\s*[^\s]+:(?:latest|main|master)(?:\s|$)/m.test(compose + production))
  throw new Error('floating image tag detected');
if (!/api\/metrics/.test(docs) || !/respond 404/.test(await read('Caddyfile')))
  throw new Error('public metrics denial is not documented/enforced');
if (/\b(?:provider|redis|otel|upload)\b/i.test(compose))
  throw new Error('out-of-scope external/provider service in Compose');
console.log(`release gate contract passed (${manifest.requiredArtifacts.length} artifacts)`);
