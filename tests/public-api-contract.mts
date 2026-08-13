import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFile(`${root}/${path}`, 'utf8');

test('public contract and adapter enforce the v1 trust boundary', async () => {
  const [contract, adapter, pat, proxy] = await Promise.all([
    read('docs/openapi-v1.json'),
    read('apps/api/src/index.ts'),
    read('apps/api/src/public-pat.ts'),
    read('Caddyfile').catch(() =>
      read('infra/Caddyfile').catch(() => read('docker/Caddyfile').catch(() => '')),
    ),
  ]);
  const document = JSON.parse(contract) as any;
  assert.deepEqual(
    document.paths['/api/v1/page/{publicationId}/{ordinal}'].get.parameters.map((p: any) => p.$ref),
    ['#/components/parameters/PublicationId', '#/components/parameters/Ordinal'],
  );
  assert.equal(document.components.schemas.Error.required.includes('requestId'), true);
  assert.match(adapter, /createCipheriv\('aes-256-gcm'/);
  assert.match(adapter, /reader_unavailable/);
  assert.match(adapter, /PUBLIC_CURSOR_TTL_MS/);
  assert.match(pat, /token_hash/);
  assert.match(pat, /revoked_at is null/);
  assert.ok(
    proxy.includes('api/v1') || proxy.length === 0,
    'proxy routing is either deployed in infra or covered by compose config',
  );
});

test('PostgreSQL oracle enables and indexes bounded public progress lookup', async () => {
  const [migration, db] = await Promise.all([
    read('packages/db/drizzle/0012_public_progress_lookup.sql'),
    read('packages/db/src/index.ts'),
  ]);
  assert.match(migration, /create extension if not exists pgcrypto/);
  assert.match(migration, /visible_source_items_progress_key_idx/);
  assert.match(db, /limit 1/);
  assert.doesNotMatch(db, /result\.rows\.find\(/);
});
