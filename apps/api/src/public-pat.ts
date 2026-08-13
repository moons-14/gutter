import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from '@gutter/db';

const prefix = 'gtr_pat_v1_';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest();
export const publicApiScopes = [
  'catalog:read',
  'search:read',
  'page:read',
  'reading-state:read',
  'reading-state:write',
  'collections:read',
  'collections:write',
] as const;
export type PublicApiScope = (typeof publicApiScopes)[number];
export const defaultPublicApiScopes: readonly PublicApiScope[] = [...publicApiScopes];

const validExpiry = (expiresAt: string | null | undefined): Date | null => {
  if (expiresAt === undefined || expiresAt === null) return null;
  const parsed = new Date(expiresAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now())
    throw new Error('invalid_token_expiry');
  if (parsed.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000)
    throw new Error('invalid_token_expiry');
  return parsed;
};

export async function createPublicApiToken(
  userId: string,
  label: string,
  scopes: readonly string[] = defaultPublicApiScopes,
  expiresAt?: string | null,
) {
  if (!/^[^\x00-\x1f\x7f]{1,128}$/.test(label)) throw new Error('invalid_token_label');
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > publicApiScopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !(publicApiScopes as readonly string[]).includes(scope))
  )
    throw new Error('invalid_token_scopes');
  const expiry = validExpiry(expiresAt);
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  await pool.query(
    'insert into gutter_public_api_tokens(id,user_id,token_hash,label,scopes,expires_at) values($1,$2,$3,$4,$5,$6)',
    [id, userId, hash(token), label, scopes, expiry],
  );
  return { id, token, scopes, expiresAt: expiry?.toISOString() ?? null };
}

export async function revokePublicApiToken(userId: string, id: string) {
  const result = await pool.query(
    'update gutter_public_api_tokens set revoked_at=coalesce(revoked_at,now()) where id=$1 and user_id=$2 and revoked_at is null',
    [id, userId],
  );
  return result.rowCount === 1;
}

export async function listPublicApiTokens(userId: string) {
  const result = await pool.query(
    'select id,label,scopes,expires_at as "expiresAt",created_at as "createdAt",last_used_at as "lastUsedAt",revoked_at as "revokedAt" from gutter_public_api_tokens where user_id=$1 order by created_at desc limit 100',
    [userId],
  );
  return result.rows;
}

export async function authenticatePublicApiToken(value: string | undefined) {
  if (!value?.startsWith(prefix)) return null;
  const presented = hash(value.slice(0));
  const result = await pool.query<{
    id: string;
    user_id: string;
    token_hash: Buffer;
    scopes: PublicApiScope[];
    expires_at: Date | null;
  }>(
    'select id,user_id,token_hash,scopes,expires_at from gutter_public_api_tokens where revoked_at is null and (expires_at is null or expires_at>now()) and token_hash=$1',
    [presented],
  );
  const match = result.rows[0];
  if (!match || !timingSafeEqual(Buffer.from(match.token_hash), presented)) return null;
  await pool.query('update gutter_public_api_tokens set last_used_at=now() where id=$1', [
    match.id,
  ]);
  return { userId: match.user_id, tokenId: match.id, scopes: match.scopes };
}
