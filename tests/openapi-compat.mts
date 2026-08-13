import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const run = (candidate: string) =>
  new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/check-openapi-compat.mjs',
        'docs/openapi-v1.baseline.json',
        candidate,
        'docs/openapi-v1.json',
      ],
      { cwd: root },
    );
    child.on('close', (code) => resolve(code ?? 1));
  });

test('committed OpenAPI contract is compatible and served JSON is exact', async () => {
  assert.equal(await run('docs/openapi-v1.yaml'), 0);
});

test('compatibility rejects method, parameter, response, schema, and bound removals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gutter-openapi-'));
  try {
    const document = JSON.parse(await readFile(join(root, 'docs/openapi-v1.json'), 'utf8')) as any;
    delete document.paths['/api/v1/catalog'].get;
    delete document.paths['/api/v1/search'].get.parameters[0];
    delete document.paths['/api/v1/page/{publicationId}/{ordinal}'].get.responses['404'];
    document.components.schemas.Progress.properties.pageOrdinal.minimum = 1;
    document.components.schemas.Progress.required.pop();
    const candidate = join(dir, 'candidate.json');
    await writeFile(candidate, JSON.stringify(document));
    assert.notEqual(await run(candidate), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
