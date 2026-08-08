import { assertSchema, pool, requestRootScan, requestScanCancellation } from '@gutter/db';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rootId = /^[a-z][a-z0-9-]{0,62}$/;
function usage(): never {
  throw new Error(
    'usage: scan enqueue --root <root-id> | scan cancel --request <request-uuid> | scan cancel --run <run-bigint> | scan status [--root <root-id>]',
  );
}
const [, , command, action, flag, value] = process.argv;
await assertSchema();
if (command !== 'scan') usage();
if (action === 'enqueue' && flag === '--root' && value && rootId.test(value)) {
  const request = await requestRootScan(value, 'manual');
  process.stdout.write(`${JSON.stringify({ requestId: request.id, state: request.state })}\n`);
} else if (action === 'cancel' && (flag === '--request' || flag === '--run') && value) {
  let requestId = value;
  if (flag === '--request' && !uuid.test(value)) usage();
  if (flag === '--run') {
    if (!/^\d+$/.test(value)) usage();
    const row = await pool.query<{ scan_request_id: string | null }>(
      'select scan_request_id from scan_runs where id=$1',
      [value],
    );
    if (!row.rows[0]?.scan_request_id) throw new Error('scan_request_not_found');
    requestId = row.rows[0].scan_request_id;
  }
  process.stdout.write(
    `${JSON.stringify({ cancelled: await requestScanCancellation(requestId) })}\n`,
  );
} else if (action === 'status' && (!flag || flag === '--root')) {
  if (value && !rootId.test(value)) usage();
  const rows = await pool.query(
    `select id,root_id,trigger,state,scan_run_id,follow_up_requested,error_code,created_at,started_at,finished_at
     from scan_requests where ($1::text is null or root_id=$1) order by created_at desc limit 100`,
    [value ?? null],
  );
  process.stdout.write(`${JSON.stringify(rows.rows)}\n`);
} else usage();
await pool.end();
