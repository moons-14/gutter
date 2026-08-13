import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
assert.ok(path, 'usage: node tests/validate-scale-evidence.mjs evidence.json');
const report = JSON.parse(await readFile(path, 'utf8'));
const schema = JSON.parse(await readFile(new URL('../docs/scale-oracle-evidence.schema.json', import.meta.url), 'utf8'));
function validate(value, rule, path = '$', root = schema) {
  if (rule.$ref) return validate(value, root.$defs[rule.$ref.split('/').pop()], path, root);
  if (rule.const !== undefined) assert.deepEqual(value, rule.const, `${path} const`);
  if (rule.enum) assert.ok(rule.enum.includes(value), `${path} enum`);
  if (rule.type) {
    const ok = rule.type === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : rule.type === 'array' ? Array.isArray(value) : rule.type === 'integer' ? Number.isInteger(value) : rule.type === 'number' ? typeof value === 'number' : typeof value === rule.type;
    assert.ok(ok, `${path} type`);
  }
  if (rule.minimum !== undefined) assert.ok(value >= rule.minimum, `${path} minimum`);
  if (rule.pattern) assert.match(value, new RegExp(rule.pattern), `${path} pattern`);
  if (rule.required) for (const key of rule.required) assert.ok(Object.hasOwn(value, key), `${path}.${key} required`);
  if (rule.type === 'object' && rule.properties) {
    if (rule.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(rule.properties, key), `${path}.${key} unknown`);
    for (const [key, child] of Object.entries(rule.properties)) if (Object.hasOwn(value, key)) validate(value[key], child, `${path}.${key}`, root);
  }
  if (rule.type === 'array' && rule.items) for (const [i, child] of value.entries()) validate(child, rule.items, `${path}[${i}]`, root);
}
assert.equal(report.schemaVersion, 'gutter.scale-oracle.v1');
if (report.status === 'unavailable') {
  assert.equal(typeof report.unavailablePlatformReason, 'string');
  assert.ok(report.unavailablePlatformReason.length > 0);
  console.log('SCALE_EVIDENCE_SCHEMA_RESULT pass');
  process.exit(0);
}
validate(report, schema);
assert.equal(report.dataset.sourceFixtureBooks, 1000);
assert.equal(report.dataset.sourceFixturePages, 1000);
assert.equal(report.thresholds.readerCount, 5);
assert.equal(report.thresholds.coldProducerCount, 1);
assert.equal(report.worker.queueCompletedRuns, 3);
for (const name of ['first', 'noChange', 'changed']) {
  const run = report.worker.runs[name];
  assert.equal(run.state, 'completed');
  assert.equal(typeof run.requestId, 'string');
  assert.equal(typeof run.pgBossJobId, 'string');
}
assert.equal(report.sparse.logicalBytes, 20 * 1024 ** 4);
assert.ok(report.sparse.allocatedBlocks <= report.thresholds.sparseAllocatedBlocksMax);
assert.match(report.baselineComparison.baselineSha256, /^[0-9a-f]{64}$/);
console.log('SCALE_EVIDENCE_SCHEMA_RESULT pass');
