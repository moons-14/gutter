import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const path = process.argv[2];
assert.ok(path, 'usage: node tests/validate-scale-evidence.mjs evidence.json');
const report = JSON.parse(await readFile(path, 'utf8'));
const schema = JSON.parse(await readFile(new URL('../docs/scale-oracle-evidence.schema.json', import.meta.url), 'utf8'));
const unavailableMode = report.status === 'unavailable';
function validate(value, rule, path = '$', root = schema) {
  if (rule.$ref) return validate(value, root.$defs[rule.$ref.split('/').pop()], path, root);
  if (rule.const !== undefined) assert.deepEqual(value, rule.const, `${path} const`);
  if (rule.enum) assert.ok(rule.enum.includes(value), `${path} enum`);
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const ok = types.some((type) => type === 'null' ? value === null : type === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : typeof value === type);
    assert.ok(ok, `${path} type`);
  }
  if (rule.minimum !== undefined && !(unavailableMode && path.startsWith('$.worker'))) assert.ok(value >= rule.minimum, `${path} minimum`);
  if (rule.minLength !== undefined) assert.ok(typeof value === 'string' && value.length >= rule.minLength, `${path} minLength`);
  if (rule.pattern) assert.match(value, new RegExp(rule.pattern), `${path} pattern`);
  if (rule.minItems !== undefined) assert.ok(Array.isArray(value) && value.length >= rule.minItems, `${path} minItems`);
  if (rule.required) for (const key of rule.required) if (!(unavailableMode && path !== '$' && !Object.hasOwn(value, key))) assert.ok(Object.hasOwn(value, key), `${path}.${key} required`);
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
  for (const key of ['dataset','thresholds','environment','timingsMs','plans','cache','worker','sparse','baselineComparison']) assert.ok(Object.hasOwn(report, key), `unavailable missing ${key}`);
  assert.equal(report.environment.setupDatabaseRole, 'gutter');
  assert.equal(report.environment.workerDatabaseRole, 'gutter_worker');
  assert.equal(report.environment.sourceMount, 'read-only');
  assert.equal(report.thresholds.readerCount, 5);
  assert.equal(report.cache.pressure.protectedLiveEntry, true);
  assert.equal(typeof report.baselineComparison.baselineSha256, 'string');
}
validate(report, schema);
if (unavailableMode) { console.log('SCALE_EVIDENCE_SCHEMA_RESULT pass'); process.exit(0); }
assert.equal(report.dataset.sourceFixtureBooks, 1000);
assert.equal(report.dataset.sourceFixturePages, 1000);
assert.equal(report.thresholds.readerCount, 5);
assert.equal(report.thresholds.coldProducerCount, 1);
assert.equal(report.worker.queueCompletedRuns, 3);
assert.equal(new Set(['first', 'noChange', 'changed'].map((name) => report.worker.runs[name].pgBossJobId)).size, 3);
for (const name of ['first', 'noChange', 'changed']) {
  const run = report.worker.runs[name];
  assert.equal(run.state, 'completed');
  assert.equal(typeof run.requestId, 'string');
  assert.equal(typeof run.pgBossJobId, 'string');
}
assert.equal(report.sparse.logicalBytes, 20 * 1024 ** 4);
assert.ok(report.sparse.allocatedBlocks <= report.thresholds.sparseAllocatedBlocksMax);
assert.match(report.baselineComparison.baselineSha256, /^[0-9a-f]{64}$/);
const baselineBytes = await readFile(new URL('../docs/scale-oracle-baseline.json', import.meta.url));
if (!unavailableMode) assert.equal(report.baselineComparison.baselineSha256, createHash('sha256').update(baselineBytes).digest('hex'));
console.log('SCALE_EVIDENCE_SCHEMA_RESULT pass');
