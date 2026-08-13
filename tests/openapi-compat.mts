import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const run = (candidate: string, served?: string) =>
  new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        'scripts/check-openapi-compat.mjs',
        'docs/openapi-v1.baseline.json',
        candidate,
        ...(served ? [served] : []),
      ],
      { cwd: root },
    );
    child.on('close', (code) => resolve(code ?? 1));
  });

test('committed OpenAPI contract is compatible and served JSON is exact', async () => {
  const servedText = await readFile(join(root, 'docs/openapi-v1.json'), 'utf8');
  assert.doesNotThrow(() => parse(servedText, { uniqueKeys: true }));
  assert.equal(await run('docs/openapi-v1.yaml', 'docs/openapi-v1.json'), 0);
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

test('compatibility rejects each requiredness and header regression independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gutter-openapi-required-'));
  try {
    const source = JSON.parse(await readFile(join(root, 'docs/openapi-v1.json'), 'utf8')) as any;
    const mutations = [
      (d: any) => {
        d.paths['/api/v1/search'].get.parameters[0].required = false;
      },
      (d: any) => {
        delete d.paths['/api/v1/search'].get.parameters[0].required;
      },
      (d: any) => {
        d.paths['/api/v1/progress'].put.requestBody.required = false;
      },
      (d: any) => {
        d.components.schemas.Progress.required.pop();
      },
      (d: any) => {
        d.paths['/api/v1/catalog'].get.responses['405'] = {
          description: 'method',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          headers: {},
        };
      },
      (d: any) => {
        d.components.parameters.Limit.schema.maximum = 101;
      },
      (d: any) => {
        d.components.parameters.OptionalQuery.required = true;
      },
      (d: any) => {
        d.paths['/api/v1/catalog'].get.responses['405'] = {
          description: 'method',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          headers: { Allow: { schema: { type: 'string' }, required: true } },
        };
      },
      (d: any) => {
        d.components.schemas.Progress.properties.pageOrdinal.type = 'string';
      },
      (d: any) => {
        d.components.responses.MethodNotAllowed.headers.Allow.required = true;
      },
      (d: any) => {
        d.paths['/api/v1/catalog'].get.requestBody = {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        };
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const candidate = join(dir, `candidate-${index}.json`);
      const document = structuredClone(source);
      mutate(document);
      await writeFile(candidate, JSON.stringify(document));
      assert.notEqual(await run(candidate), 0, `mutation ${index} must fail compatibility`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
