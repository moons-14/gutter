import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { secret } = await import('../packages/config/src/index.ts');

function testDatabaseUrl() {
  return `postgresql://gutter:${randomUUID()}@db:5432/gutter`;
}

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('M0 documents a stable schema version', () => {
  assert.equal('0000_initial', '0000_initial');
});

test('config accepts a direct secret only', async () => {
  const databaseUrl = testDatabaseUrl();
  await withEnvironment({ DATABASE_URL: databaseUrl, DATABASE_URL_FILE: '' }, async () =>
    assert.equal(await secret('DATABASE_URL'), databaseUrl),
  );
});

test('config accepts a trimmed file secret only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-config-'));
  const path = join(directory, 'database_url');
  const databaseUrl = testDatabaseUrl();
  await writeFile(path, `${databaseUrl}\n`);
  await withEnvironment({ DATABASE_URL: '', DATABASE_URL_FILE: path }, async () =>
    assert.equal(await secret('DATABASE_URL'), databaseUrl),
  );
});

test('config rejects simultaneous direct and file secrets without exposing values', async () => {
  await withEnvironment(
    { DATABASE_URL: testDatabaseUrl(), DATABASE_URL_FILE: '/secret/path' },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'Define exactly one of DATABASE_URL or DATABASE_URL_FILE',
      }),
  );
});

test('config rejects a missing secret', async () => {
  await withEnvironment(
    { DATABASE_URL: '', DATABASE_URL_FILE: '' },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'Define exactly one of DATABASE_URL or DATABASE_URL_FILE',
      }),
  );
});

test('config rejects an empty file secret without exposing its path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-config-'));
  const path = join(directory, 'database_url');
  await writeFile(path, '\n');
  await withEnvironment(
    { DATABASE_URL: '', DATABASE_URL_FILE: path },
    async () =>
      await assert.rejects(secret('DATABASE_URL'), {
        message: 'DATABASE_URL_FILE must reference a readable non-empty file',
      }),
  );
});
