import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const dir = await mkdtemp('/tmp/gutter-scale-schema-');
const baseline = createHash('sha256')
  .update(await (await import('node:fs/promises')).readFile('docs/scale-oracle-baseline.json'))
  .digest('hex');
const samples = () => ({ p50: 1, p95: 2, count: 1 });
const common = () => ({
  schemaVersion: 'gutter.scale-oracle.v1',
  status: 'unavailable',
  unavailablePlatformReason: 'docker:DockerUnavailable',
  seed: 'schema-test-seed',
  runId: 'schema-test-run',
  dataset: { books: 1000, pages: 10000, sourceFixtureBooks: 1000, sourceFixturePages: 1000 },
  thresholds: {
    sourceFixtureBooks: 1000,
    sourceFixturePages: 1000,
    readerCount: 5,
    coldProducerCount: 1,
    sparseAllocatedBlocksMax: 1024,
    advisoryCatalogP95Ms: 1000,
    advisorySearchP95Ms: 1000,
    advisoryScanP95Ms: 30000,
  },
  environment: {
    node: 'test',
    postgres: {},
    setupDatabaseRole: 'gutter',
    workerDatabaseRole: 'gutter_worker',
    sourceMount: 'read-only',
  },
  timingsMs: {
    catalog: samples(),
    search: samples(),
    noChangeScan: samples(),
    changedScan: samples(),
  },
  plans: { queryShape: 'unavailable', list: [], search: [] },
  cache: {
    readers: 5,
    coldProducers: 1,
    warmHit: false,
    gc: false,
    pressure: { quotaBytes: 0, reclaimedBytes: 0, protectedLiveEntry: true },
  },
  worker: { queueCompletedRuns: 0, runs: {} },
  sparse: { logicalBytes: 21990232555520, allocatedBlocks: 0 },
  baselineComparison: {
    baseline: 'docs/scale-oracle-baseline.json',
    baselineSha256: '0'.repeat(64),
    portable: 'fail',
    hardwareAdvisory: {},
  },
});
const runValidator = async (name, value, expected) => {
  const path = `${dir}/${name}.json`;
  await writeFile(path, JSON.stringify(value));
  let ok = true;
  try {
    await run(process.execPath, ['tests/validate-scale-evidence.mjs', path]);
  } catch {
    ok = false;
  }
  assert.equal(ok, expected, name);
};

const unavailable = common();
await runValidator('unavailable', unavailable, true);
await runValidator(
  'unavailable-queue-three',
  { ...unavailable, worker: { queueCompletedRuns: 3, runs: {} } },
  false,
);
await runValidator(
  'unavailable-with-run',
  { ...unavailable, worker: { queueCompletedRuns: 0, runs: { first: {} } } },
  false,
);
await runValidator(
  'unknown-nested-key',
  { ...unavailable, cache: { ...unavailable.cache, extra: true } },
  false,
);

const pass = common();
pass.status = 'pass';
pass.unavailablePlatformReason = null;
pass.baselineComparison.baselineSha256 = baseline;
pass.baselineComparison.portable = 'pass';
pass.worker = { queueCompletedRuns: 3, runs: {} };
for (const name of ['first', 'noChange', 'changed'])
  pass.worker.runs[name] = {
    id: name,
    requestId: `${name}-request`,
    pgBossJobId: `${name}-job`,
    state: 'completed',
    summary: {
      updated: name === 'changed' ? 1 : 1000,
      unchanged: name === 'noChange' ? 1000 : 0,
      discovered: 1000,
      pages: 1000,
    },
  };
await runValidator('pass', pass, true);
await runValidator('pass-mutated-status', { ...pass, status: 'fail' }, false);
await runValidator(
  'zero-branches',
  { ...pass, status: 'fail', worker: { queueCompletedRuns: 1, runs: {} } },
  false,
);
await rm(dir, { recursive: true, force: true });
console.log('SCALE_EVIDENCE_SCHEMA_FIXTURES pass (7 cases)');
