import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from '@gutter/db';

const prefix = 'gtr_pat_v1_';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest();

export async function createPublicApiToken(userId: string, label: string) {
  if (!/^[^\x00-\x1f\x7f]{1,128}$/.test(label)) throw new Error('invalid_token_label');
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  await pool.query(
    'insert into gutter_public_api_tokens(id,user_id,token_hash,label) values($1,$2,$3,$4)',
    [id, userId, hash(token), label],
  );
  return { id, token, scopes: ['api:v1'] as const };
}

export async function revokePublicApiToken(userId: string, id: string) {
  const result = await pool.query(
    'update gutter_public_api_tokens set revoked_at=coalesce(revoked_at,now()) where id=$1 and user_id=$2 and revoked_at is null',
    [id, userId],
  );
  return result.rowCount === 1;
}

export async function authenticatePublicApiToken(value: string | undefined) {
  if (!value?.startsWith(prefix)) return null;
  const presented = hash(value.slice(0));
  const result = await pool.query<{ id: string; user_id: string; token_hash: Buffer }>(
    'select id,user_id,token_hash from gutter_public_api_tokens where revoked_at is null and token_hash=$1',
    [presented],
  );
  const match = result.rows[0];
  if (!match || !timingSafeEqual(Buffer.from(match.token_hash), presented)) return null;
  await pool.query('update gutter_public_api_tokens set last_used_at=now() where id=$1', [match.id]);
  return { userId: match.user_id, scope: 'api:v1' as const };
}
