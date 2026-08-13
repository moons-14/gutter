import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = process.argv[2];
assert.ok(path, 'usage: node tests/validate-scale-evidence.mjs evidence.json');
const report = JSON.parse(await readFile(path, 'utf8'));
const schema = JSON.parse(await readFile(new URL('../docs/scale-oracle-evidence.schema.json', import.meta.url), 'utf8'));
assert.equal(schema.additionalProperties, false);
for (const key of schema.required) assert.ok(Object.hasOwn(report, key), `missing ${key}`);
assert.equal(report.schemaVersion, 'gutter.scale-oracle.v1');
assert.ok(['pass', 'fail', 'unavailable'].includes(report.status));
assert.equal(typeof report.seed, 'string');
assert.equal(typeof report.runId, 'string');
if (report.status === 'unavailable') {
  assert.equal(typeof report.unavailablePlatformReason, 'string');
  assert.ok(report.unavailablePlatformReason.length > 0);
  console.log('SCALE_EVIDENCE_SCHEMA_RESULT pass');
  process.exit(0);
}
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
