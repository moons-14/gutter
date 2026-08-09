import { approveMetadata, assertSchema, metadataStatus, pool, rejectMetadata } from '@gutter/db';

const rootId = /^[a-z][a-z0-9-]{0,62}$/;
const identity = /^[0-9a-f]{64}$/;
function usage(): never {
  throw new Error('usage: metadata approve|reject|status --root <root-id> --identity <canonical-identity-sha256>');
}
const [, , action, rootFlag, root, identityFlag, canonicalIdentity] = process.argv;
if (!['approve', 'reject', 'status'].includes(action ?? '') || rootFlag !== '--root' || identityFlag !== '--identity' || !root || !canonicalIdentity || !rootId.test(root) || !identity.test(canonicalIdentity)) usage();
await assertSchema();
if (action === 'approve') process.stdout.write(`${JSON.stringify({ approved: await approveMetadata(root, canonicalIdentity) })}\n`);
else if (action === 'reject') {
  await rejectMetadata(root, canonicalIdentity);
  process.stdout.write('{"rejected":true}\n');
} else process.stdout.write(`${JSON.stringify((await metadataStatus(root, canonicalIdentity)).rows[0] ?? null)}\n`);
await pool.end();
