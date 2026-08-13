import { authConfig, databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  canonicalIdentity,
  cursorFilterHash,
  decodeCatalogCursor,
  encodeCatalogCursor,
  identityText,
  integerOrNull,
  normalizeCatalogFilters,
  publicationKind,
  searchKey,
  sortKey,
  type CatalogDirection,
  type CatalogSort,
} from '@gutter/catalog-domain';
import { basename, dirname, extname } from 'node:path';
import { Pool } from 'pg';
import {
  mergeCandidates,
  validCandidate,
  type Candidate,
  type MergedMetadata,
} from '@gutter/metadata-provider';
import {
  manifestSha256,
  scanPage,
  type ScanItem,
  type ScanSummary,
} from '@gutter/discovery-scanner';

export const pool = new Pool({ connectionString: await databaseUrl() });
export const db = drizzle(pool);

const canonicalIdentityKey = /^[0-9a-f]{64}$/;
const publicationTargetKey = /^[0-9a-f]{64}:[0-9a-f]{64}$/;
export type LibraryAccessScope = Readonly<{
  userId: string;
  isAdmin: boolean;
  rootIds: readonly string[];
  revision: number;
  scopeHash: string;
  userStateRevision?: number;
}>;

export type AdminUser = Readonly<{
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean;
}>;

type AdminUsersCursor = Readonly<{
  endpoint: 'admin-users';
  createdAt: string;
  id: string;
  filter: string;
}>;
const adminUsersCursorFilter = (q: string) => createHash('sha256').update(q, 'utf8').digest('hex');
let adminUsersCursorKey: Promise<Buffer> | undefined;
const getAdminUsersCursorKey = () => {
  adminUsersCursorKey ??= authConfig().then(({ secret }) =>
    createHash('sha256').update(secret, 'utf8').digest(),
  );
  return adminUsersCursorKey;
};
const encodeAdminUsersCursor = async (cursor: AdminUsersCursor): Promise<string> => {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const mac = createHmac('sha256', await getAdminUsersCursorKey())
    .update(payload, 'ascii')
    .digest('base64url');
  return `${payload}.${mac}`;
};
const decodeAdminUsersCursor = async (value: string, q: string): Promise<AdminUsersCursor> => {
  try {
    const [payload, encodedMac] = value.split('.');
    if (
      !payload ||
      !encodedMac ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]+$/.test(encodedMac)
    )
      throw new Error('invalid_cursor');
    const expectedMac = createHmac('sha256', await getAdminUsersCursorKey())
      .update(payload, 'ascii')
      .digest();
    const receivedMac = Buffer.from(encodedMac, 'base64url');
    if (receivedMac.length !== expectedMac.length || !timingSafeEqual(receivedMac, expectedMac))
      throw new Error('invalid_cursor');
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<AdminUsersCursor>;
    if (
      decoded.endpoint !== 'admin-users' ||
      typeof decoded.createdAt !== 'string' ||
      !decoded.id ||
      typeof decoded.id !== 'string' ||
      decoded.filter !== adminUsersCursorFilter(q) ||
      Number.isNaN(Date.parse(decoded.createdAt))
    )
      throw new Error('invalid_cursor');
    return decoded as AdminUsersCursor;
  } catch {
    throw new Error('invalid_cursor');
  }
};

export async function listAdminUsers(
  query: Readonly<{ q?: string; limit: number; cursor?: string }>,
): Promise<{ items: AdminUser[]; nextCursor: string | null }> {
  const q = query.q?.trim().toLocaleLowerCase('en-US') ?? '';
  const cursor = query.cursor ? await decodeAdminUsersCursor(query.cursor, q) : null;
  const params: unknown[] = [];
  const filters: string[] = [];
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (value) => `\\${value}`);
    params.push(`%${escaped}%`);
    filters.push(
      `(u.name ilike $${params.length} escape '\\' or u.email ilike $${params.length} escape '\\')`,
    );
  }
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    filters.push(`(u."createdAt",u.id)<($${params.length - 1},$${params.length})`);
  }
  params.push(query.limit + 1);
  const result = await pool.query<AdminUser & { createdAt: string }>(
    `select u.id,u.name,u.email,u.role,coalesce(u.banned,false) as banned,u."createdAt" as "createdAt" from "user" u
     ${filters.length ? `where ${filters.join(' and ')}` : ''}
     order by u."createdAt" desc,u.id desc limit $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(({ createdAt: _createdAt, ...user }) => user),
    nextCursor:
      result.rows.length > query.limit && last
        ? await encodeAdminUsersCursor({
            endpoint: 'admin-users',
            createdAt: last.createdAt,
            id: last.id,
            filter: adminUsersCursorFilter(q),
          })
        : null,
  };
}

export async function libraryAccessScope(userId: string): Promise<LibraryAccessScope> {
  const user = await pool.query<{ role: string | null }>('select role from "user" where id=$1', [
    userId,
  ]);
  if (!user.rows[0]) throw new Error('user_not_found');
  const isAdmin = user.rows[0].role === 'admin';
  const grants = isAdmin
    ? []
    : (
        await pool.query<{ root_id: string }>(
          'select root_id from library_access_grants where user_id=$1 order by root_id',
          [userId],
        )
      ).rows.map((row) => row.root_id);
  const revision = isAdmin
    ? 0
    : Number(
        (
          await pool.query<{ revision: string }>(
            'select revision from gutter_acl_revisions where user_id=$1',
            [userId],
          )
        ).rows[0]?.revision ?? 0,
      );
  const userStateRevision = Number(
    (
      await pool.query<{ revision: string }>(
        'select revision from gutter_user_state_revisions where user_id=$1',
        [userId],
      )
    ).rows[0]?.revision ?? 0,
  );
  const scopeHash = createHash('sha256')
    .update(JSON.stringify({ userId, isAdmin, grants, revision, userStateRevision }), 'utf8')
    .digest('hex');
  return { userId, isAdmin, rootIds: grants, revision, scopeHash, userStateRevision };
}

export function canAccessLibrary(scope: LibraryAccessScope, rootId: string): boolean {
  return scope.isAdmin || scope.rootIds.includes(rootId);
}
/** Authorizes a durable state key against the current ACL and rebuildable catalog/source view. */
export async function authorizeUserStateResource(
  userId: string,
  rootId: string,
  kind: UserTargetKind | 'progress',
  key: string,
  options: { includeHidden?: boolean } = {},
): Promise<boolean> {
  const scope = await libraryAccessScope(userId);
  if (!canAccessLibrary(scope, rootId)) return false;
  const releaseVisibility = (userParameter: string) =>
    options.includeHidden
      ? `and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)`
      : `and gutter_user_can_read_release(${userParameter},r.id)`;
  if (kind === 'progress' || kind === 'check' || kind === 'source')
    return Boolean(
      (
        await pool.query(
          `select 1 from visible_source_items i join catalog_releases r on r.source_item_id=i.id
             where i.root_id=$1 and i.relative_path=$2 and i.active and i.quarantine_reason is null ${releaseVisibility('$3')} limit 1`,
          options.includeHidden
            ? [rootId, normalizeUserSourceKey(key)]
            : [rootId, normalizeUserSourceKey(key), userId],
        )
      ).rowCount,
    );
  if (kind === 'series')
    return Boolean(
      (
        await pool.query(
          `select 1 from catalog_series s where s.library_id=$1 and s.identity_key=$2 and exists (select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where p.series_id=s.id ${releaseVisibility('$3')})`,
          options.includeHidden ? [rootId, key] : [rootId, key, userId],
        )
      ).rowCount,
    );
  const split = key.split(':');
  if (split.length !== 2) return false;
  return Boolean(
    (
      await pool.query(
        `select 1 from catalog_publications p join catalog_series s on s.id=p.series_id where s.library_id=$1 and s.identity_key=$2 and p.identity_key=$3 and exists (select 1 from catalog_releases r join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where r.publication_id=p.id ${releaseVisibility('$4')})`,
        options.includeHidden ? [rootId, split[0], split[1]] : [rootId, split[0], split[1], userId],
      )
    ).rowCount,
  );
}

/** Resolve collection ownership before any membership mutation (404-safe). */
export async function authorizeUserCollection(
  userId: string,
  collectionId: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(collectionId) || collectionId < 1) return false;
  return Boolean(
    (
      await pool.query('select 1 from user_collections where id=$1 and user_id=$2', [
        collectionId,
        userId,
      ])
    ).rowCount,
  );
}

export type UserProgress = Readonly<{
  userId: string;
  rootId: string;
  sourceKey: string;
  pageOrdinal: number;
  completed: boolean;
  revision: number;
  firstReadAt: Date;
  lastReadAt: Date;
  openCount: number;
  updatedAt: Date;
}>;
export type UserTargetKind = 'check' | 'series' | 'publication' | 'source';
type ProgressRow = {
  user_id: string;
  root_id: string;
  source_key: string;
  page_ordinal: number;
  completed: boolean;
  revision: string;
  first_read_at: Date;
  last_read_at: Date;
  open_count: string;
  updated_at: Date;
};
const progressFromRow = (row: ProgressRow): UserProgress => ({
  userId: row.user_id,
  rootId: row.root_id,
  sourceKey: row.source_key,
  pageOrdinal: row.page_ordinal,
  completed: row.completed,
  revision: Number(row.revision),
  firstReadAt: row.first_read_at,
  lastReadAt: row.last_read_at,
  openCount: Number(row.open_count),
  updatedAt: row.updated_at,
});

export function normalizeUserSourceKey(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0'))
    throw new Error('invalid_user_source_key');
  const normalized = value.normalize('NFC').replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('invalid_user_source_key');
  return normalized;
}
export function normalizeCollectionName(value: string): { name: string; nameKey: string } {
  if (typeof value !== 'string') throw new Error('invalid_collection_name');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 128) throw new Error('invalid_collection_name');
  return { name, nameKey: name.toLocaleLowerCase('und') };
}
function validateOrdinal(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000)
    throw new Error('invalid_page_ordinal');
}
function validateTarget(kind: UserTargetKind, key: string): string {
  if (!['check', 'series', 'publication', 'source'].includes(kind))
    throw new Error('invalid_user_target');
  if (kind === 'series') {
    if (!canonicalIdentityKey.test(key)) throw new Error('invalid_user_target');
    return key;
  }
  if (kind === 'publication') {
    if (!publicationTargetKey.test(key)) throw new Error('invalid_user_target');
    return key;
  }
  return normalizeUserSourceKey(key);
}
async function bumpUserStateRevision(
  client: { query: typeof pool.query },
  userId: string,
): Promise<number> {
  const result = await client.query<{ revision: string }>(
    `insert into gutter_user_state_revisions(user_id,revision) values($1,1)
    on conflict(user_id) do update set revision=gutter_user_state_revisions.revision+1,updated_at=now() returning revision`,
    [userId],
  );
  return Number(result.rows[0].revision);
}
export async function userStateScope(
  userId: string,
): Promise<{ revision: number; scopeHash: string }> {
  const result = await pool.query<{ revision: string }>(
    'select revision from gutter_user_state_revisions where user_id=$1',
    [userId],
  );
  const revision = Number(result.rows[0]?.revision ?? 0);
  return {
    revision,
    scopeHash: createHash('sha256').update(`${userId}\0${revision}`).digest('hex'),
  };
}
export async function getUserProgress(
  userId: string,
  rootId: string,
  sourceKey: string,
): Promise<UserProgress | null> {
  const result = await pool.query<ProgressRow>(
    'select * from user_progress where user_id=$1 and root_id=$2 and source_key=$3',
    [userId, rootId, normalizeUserSourceKey(sourceKey)],
  );
  return result.rows[0] ? progressFromRow(result.rows[0]) : null;
}

/** Resolve a browser progress key only against visible candidates in the requester's scope. */
export async function resolveUserProgressKey(
  userId: string,
  rootId: string,
  progressKey: string,
  options: { includeHidden?: boolean } = {},
): Promise<string | null> {
  if (typeof progressKey !== 'string' || !/^source:[A-Za-z0-9_-]+$/.test(progressKey)) return null;
  const scope = await libraryAccessScope(userId);
  if (!canAccessLibrary(scope, rootId)) return null;
  // PostgreSQL 18 provides sha256(bytea), so resolve the opaque identity in SQL
  // while the path remains server-side. The view plus ACL/root predicates are
  // deliberately repeated here: a progress key is valid only for a current,
  // readable source candidate.
  const hiddenPredicate = options.includeHidden
    ? ''
    : `
        and not exists (
          select 1 from user_target_state h
           where h.user_id=$3 and h.root_id=i.root_id and h.hidden
             and h.target_kind in ('source','check') and h.target_key=i.relative_path
        )`;
  const rows = await pool.query<{ relative_path: string }>(
    `select i.relative_path
       from visible_source_items i
      where i.root_id=$1
        and i.active and i.quarantine_reason is null
        and exists (select 1 from library_roots r where r.id=i.root_id and r.active)
        and (exists (select 1 from library_access_grants g where g.user_id=$3 and g.root_id=i.root_id)
             or exists (select 1 from "user" u where u.id=$3 and u.role='admin'))
        and not exists (
          select 1 from global_source_suppressions x where x.source_item_id=i.id
        )
        ${hiddenPredicate}
        and 'source:' || rtrim(translate(
          encode(sha256(convert_to(i.root_id,'UTF8') || decode('00','hex') || convert_to(i.relative_path,'UTF8')),'base64'),
          '+/','-_'),'=') = $2
      limit 1`,
    [rootId, progressKey, userId],
  );
  return rows.rows[0]?.relative_path ?? null;
}

/** Returns authenticated resume entries without exposing source paths or inventory metadata. */
export async function getUserResume(
  userId: string,
  limit = 30,
): Promise<Record<string, unknown>[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return (
    await pool.query(
      `select r.id::text as "releaseId",up.root_id as "rootId",up.page_ordinal as "pageOrdinal",up.completed,up.revision,
      up.last_read_at as "lastReadAt",i.relative_path as "relativePath"
     from user_progress up join catalog_releases r on r.root_id=up.root_id
     join visible_source_items i on i.id=r.source_item_id and i.relative_path=up.source_key
     join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
     where up.user_id=$1 and i.active and i.quarantine_reason is null
       and exists (select 1 from library_roots lr where lr.id=i.root_id and lr.active)
       and gutter_user_can_read_release($1,r.id)
       and not exists (select 1 from user_target_state h where h.user_id=$1 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
     order by up.last_read_at desc limit $2`,
      [userId, bounded],
    )
  ).rows.map(({ relativePath, ...row }) => ({
    ...row,
    progressKey: readerProgressKey(row.rootId ?? '', relativePath),
  }));
}

export type UserStatePage<T> = Readonly<{ items: T[]; nextCursor: string | null }>;
const userStatePage = (value: unknown, fallback = 30): number => {
  const n = typeof value === 'number' ? value : Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new Error('invalid_pagination');
  return n;
};
type UserStateCursor = Readonly<{
  userId: string;
  endpoint: string;
  collectionId?: number;
  scopeHash: string;
  userStateRevision: number;
  key: readonly string[];
  digest: string;
}>;
const cursorText = (value: Omit<UserStateCursor, 'digest'>): string => {
  const payload = JSON.stringify(value);
  return Buffer.from(
    JSON.stringify({ ...value, digest: createHash('sha256').update(payload).digest('hex') }),
    'utf8',
  ).toString('base64url');
};
// This is an unkeyed integrity checksum for opaque transport, not a signature
// or authentication token. Every bound field is revalidated against live scope.
const readUserStateCursor = async (
  userId: string,
  endpoint: string,
  collectionId: number | undefined,
  cursor: string | undefined,
  keyLength: number,
): Promise<readonly string[] | null> => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<UserStateCursor>;
    const { digest, ...payload } = value;
    if (
      typeof digest !== 'string' ||
      digest !== createHash('sha256').update(JSON.stringify(payload)).digest('hex') ||
      payload.userId !== userId ||
      payload.endpoint !== endpoint ||
      payload.collectionId !== collectionId ||
      typeof payload.scopeHash !== 'string' ||
      !Number.isSafeInteger(payload.userStateRevision) ||
      !Array.isArray(payload.key) ||
      payload.key.length !== keyLength ||
      payload.key.some((v) => typeof v !== 'string')
    )
      throw new Error();
    const scope = await libraryAccessScope(userId);
    if (
      payload.scopeHash !== scope.scopeHash ||
      payload.userStateRevision !== (scope.userStateRevision ?? 0)
    )
      throw new Error();
    return payload.key;
  } catch {
    throw new Error('invalid_pagination_cursor');
  }
};
const userStateCursorFor = async (
  userId: string,
  endpoint: string,
  collectionId: number | undefined,
  key: readonly string[],
): Promise<string> => {
  const scope = await libraryAccessScope(userId);
  return cursorText({
    userId,
    endpoint,
    ...(collectionId === undefined ? {} : { collectionId }),
    scopeHash: scope.scopeHash,
    userStateRevision: scope.userStateRevision ?? 0,
    key,
  });
};

export async function listUserCollections(
  userId: string,
  limit = 30,
  cursor?: string,
): Promise<UserStatePage<Record<string, unknown>>> {
  const size = userStatePage(limit),
    after = await readUserStateCursor(userId, 'collections', undefined, cursor, 1);
  const rows = (
    await pool.query(
      `select id::text as "id",name,name_key as "nameKey",created_at as "createdAt",updated_at as "updatedAt" from user_collections where user_id=$1 ${after ? 'and id>$2' : ''} order by id limit $${after ? 3 : 2}`,
      after ? [userId, after[0], size + 1] : [userId, size + 1],
    )
  ).rows;
  return {
    items: rows.slice(0, size),
    nextCursor:
      rows.length > size
        ? await userStateCursorFor(userId, 'collections', undefined, [rows[size - 1].id])
        : null,
  };
}
export async function listUserCollectionMembers(
  userId: string,
  collectionId: number,
  limit = 30,
  cursor?: string,
): Promise<UserStatePage<Record<string, unknown>> | null> {
  const size = userStatePage(limit),
    after = await readUserStateCursor(userId, 'collection-members', collectionId, cursor, 3);
  if (!(await authorizeUserCollection(userId, collectionId))) return null;
  const predicate = `(m.root_id,m.target_kind,m.target_key)>($3,$4,$5)`;
  const rows = (
    await pool.query(
      `select m.root_id as "rootId",m.target_kind as "targetKind",m.target_key as "targetKey",m.created_at as "createdAt" from user_collection_members m where m.user_id=$1 and m.collection_id=$2 and (exists(select 1 from library_roots r where r.id=m.root_id and r.active) and (exists(select 1 from library_access_grants g where g.user_id=$1 and g.root_id=m.root_id) or exists(select 1 from "user" u where u.id=$1 and u.role='admin'))) and (m.target_kind in ('source','check') and exists(select 1 from visible_source_items i join catalog_releases r on r.source_item_id=i.id where i.root_id=m.root_id and i.relative_path=m.target_key and i.quarantine_reason is null and gutter_user_can_read_release($1,r.id)) or m.target_kind='series' and exists(select 1 from catalog_series s join catalog_publications p on p.series_id=s.id join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where s.library_id=m.root_id and s.identity_key=m.target_key and gutter_user_can_read_release($1,r.id)) or m.target_kind='publication' and exists(select 1 from catalog_publications p join catalog_series s on s.id=p.series_id join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where s.library_id=m.root_id and p.identity_key=split_part(m.target_key,':',2) and s.identity_key=split_part(m.target_key,':',1) and gutter_user_can_read_release($1,r.id))) ${after ? `and ${predicate}` : ''} order by m.root_id,m.target_kind,m.target_key limit $${after ? 6 : 3}`,
      after ? [userId, collectionId, ...after, size + 1] : [userId, collectionId, size + 1],
    )
  ).rows;
  const items = rows
    .slice(0, size)
    .map((item) =>
      item.targetKind === 'source' || item.targetKind === 'check'
        ? { ...item, targetKey: readerProgressKey(item.rootId, item.targetKey) }
        : item,
    );
  return {
    items,
    nextCursor:
      rows.length > size
        ? await userStateCursorFor(userId, 'collection-members', collectionId, [
            rows[size - 1].rootId,
            rows[size - 1].targetKind,
            rows[size - 1].targetKey,
          ])
        : null,
  };
}
export async function listUserBookmarks(
  userId: string,
  limit = 30,
  cursor?: string,
): Promise<UserStatePage<Record<string, unknown>>> {
  const size = userStatePage(limit),
    after = await readUserStateCursor(userId, 'bookmarks', undefined, cursor, 1);
  const rows = (
    await pool.query(
      `select b.id,b.root_id as "rootId",b.source_key as "sourceKey",b.page_ordinal as "pageOrdinal",b.label,b.created_at as "createdAt",b.updated_at as "updatedAt"
         from user_bookmarks b
        where b.user_id=$1
          and exists(select 1 from library_roots r where r.id=b.root_id and r.active)
          and (exists(select 1 from library_access_grants g where g.user_id=$1 and g.root_id=b.root_id)
               or exists(select 1 from "user" u where u.id=$1 and u.role='admin'))
          and exists(select 1 from visible_source_items i join catalog_releases r on r.source_item_id=i.id where i.root_id=b.root_id and i.relative_path=b.source_key and i.quarantine_reason is null and gutter_user_can_read_release($1,r.id))
          ${after ? 'and b.id>$2' : ''}
        order by b.id limit $${after ? 3 : 2}`,
      after ? [userId, after[0], size + 1] : [userId, size + 1],
    )
  ).rows;
  const items = rows.slice(0, size).map(({ rootId, sourceKey, ...item }) => ({
    ...item,
    rootId,
    progressKey: readerProgressKey(rootId, sourceKey),
  }));
  return {
    items,
    nextCursor:
      rows.length > size
        ? await userStateCursorFor(userId, 'bookmarks', undefined, [String(rows[size - 1].id)])
        : null,
  };
}
export async function listUserTargetState(
  userId: string,
  limit = 30,
  cursor?: string,
): Promise<UserStatePage<Record<string, unknown>>> {
  const size = userStatePage(limit),
    after = await readUserStateCursor(userId, 'targets', undefined, cursor, 3);
  const rows = (
    await pool.query(
      `select s.root_id as "rootId",s.target_kind as "targetKind",s.target_key as "targetKey",s.favorite,s.hidden,s.rating,s.note,s.updated_at as "updatedAt" from user_target_state s where s.user_id=$1 and exists(select 1 from library_roots r where r.id=s.root_id and r.active) and (exists(select 1 from library_access_grants g where g.user_id=$1 and g.root_id=s.root_id) or exists(select 1 from "user" u where u.id=$1 and u.role='admin')) and (s.hidden or (s.target_kind in ('source','check') and exists(select 1 from visible_source_items i join catalog_releases r on r.source_item_id=i.id where i.root_id=s.root_id and i.relative_path=s.target_key and i.quarantine_reason is null and gutter_user_can_read_release($1,r.id))) or (s.target_kind='series' and exists(select 1 from catalog_series x join catalog_publications p on p.series_id=x.id join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where x.library_id=s.root_id and x.identity_key=s.target_key and gutter_user_can_read_release($1,r.id))) or (s.target_kind='publication' and exists(select 1 from catalog_publications p join catalog_series x on x.id=p.series_id join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id and i.quarantine_reason is null where x.library_id=s.root_id and x.identity_key=split_part(s.target_key,':',1) and p.identity_key=split_part(s.target_key,':',2) and gutter_user_can_read_release($1,r.id)))) ${after ? 'and (s.root_id,s.target_kind,s.target_key)>($2,$3,$4)' : ''} order by s.root_id,s.target_kind,s.target_key limit $${after ? 5 : 2}`,
      after ? [userId, ...after, size + 1] : [userId, size + 1],
    )
  ).rows;
  const items = rows
    .slice(0, size)
    .map((item) =>
      item.targetKind === 'source' || item.targetKind === 'check'
        ? { ...item, targetKey: readerProgressKey(item.rootId, item.targetKey) }
        : item,
    );
  return {
    items,
    nextCursor:
      rows.length > size
        ? await userStateCursorFor(userId, 'targets', undefined, [
            rows[size - 1].rootId,
            rows[size - 1].targetKind,
            rows[size - 1].targetKey,
          ])
        : null,
  };
}
export async function putUserProgress(
  userId: string,
  rootId: string,
  sourceKey: string,
  expectedRevision: number,
  value: { pageOrdinal: number; completed: boolean },
): Promise<{ ok: true; current: UserProgress } | { ok: false; current: UserProgress | null }> {
  const key = normalizeUserSourceKey(sourceKey);
  validateOrdinal(value.pageOrdinal);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('invalid_expected_revision');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query<ProgressRow>(
      'select * from user_progress where user_id=$1 and root_id=$2 and source_key=$3 for update',
      [userId, rootId, key],
    );
    const row = current.rows[0];
    if ((row ? Number(row.revision) : 0) !== expectedRevision) {
      await client.query('commit');
      return { ok: false, current: row ? progressFromRow(row) : null };
    }
    const changed = row
      ? await client.query<ProgressRow>(
          'update user_progress set page_ordinal=$4,completed=$5,revision=revision+1,last_read_at=now(),open_count=open_count+1,updated_at=now() where user_id=$1 and root_id=$2 and source_key=$3 returning *',
          [userId, rootId, key, value.pageOrdinal, value.completed],
        )
      : await client.query<ProgressRow>(
          'insert into user_progress(user_id,root_id,source_key,page_ordinal,completed,revision) values($1,$2,$3,$4,$5,1) returning *',
          [userId, rootId, key, value.pageOrdinal, value.completed],
        );
    await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return { ok: true, current: progressFromRow(changed.rows[0]) };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function setUserTargetState(
  userId: string,
  rootId: string,
  targetKind: UserTargetKind,
  targetKey: string,
  value: { favorite?: boolean; rating?: number | null; note?: string | null; hidden?: boolean },
): Promise<boolean> {
  const key = validateTarget(targetKind, targetKey);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query<{
      favorite: boolean;
      rating: number | null;
      note: string | null;
      hidden: boolean;
    }>(
      'select favorite,rating,note,hidden from user_target_state where user_id=$1 and root_id=$2 and target_kind=$3 and target_key=$4 for update',
      [userId, rootId, targetKind, key],
    );
    const existing = current.rows[0];
    const favorite = Object.hasOwn(value, 'favorite')
      ? value.favorite!
      : (existing?.favorite ?? false);
    const rating = Object.hasOwn(value, 'rating') ? value.rating! : (existing?.rating ?? null);
    const note = Object.hasOwn(value, 'note') ? value.note! : (existing?.note ?? null);
    const hidden = Object.hasOwn(value, 'hidden') ? value.hidden! : (existing?.hidden ?? false);
    if (
      (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) ||
      (note !== null && note.length > 10000)
    )
      throw new Error('invalid_user_target_state');
    const changed =
      !favorite && rating === null && note === null && !hidden
        ? await client.query(
            'delete from user_target_state where user_id=$1 and root_id=$2 and target_kind=$3 and target_key=$4 returning user_id',
            [userId, rootId, targetKind, key],
          )
        : await client.query(
            `insert into user_target_state(user_id,root_id,target_kind,target_key,favorite,rating,note,hidden) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(user_id,root_id,target_kind,target_key) do update set favorite=excluded.favorite,rating=excluded.rating,note=excluded.note,hidden=excluded.hidden,updated_at=now() where (user_target_state.favorite,user_target_state.rating,user_target_state.note,user_target_state.hidden) is distinct from (excluded.favorite,excluded.rating,excluded.note,excluded.hidden) returning user_id`,
            [userId, rootId, targetKind, key, favorite, rating, note, hidden],
          );
    if (changed.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return Boolean(changed.rowCount);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function addUserBookmark(
  userId: string,
  rootId: string,
  sourceKey: string,
  pageOrdinal: number,
  label: string | null = null,
): Promise<boolean> {
  const key = normalizeUserSourceKey(sourceKey);
  validateOrdinal(pageOrdinal);
  if (label !== null && label.length > 256) throw new Error('invalid_bookmark_label');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const changed = await client.query(
      'insert into user_bookmarks(user_id,root_id,source_key,page_ordinal,label) values($1,$2,$3,$4,$5) on conflict(user_id,root_id,source_key,page_ordinal) do nothing returning id',
      [userId, rootId, key, pageOrdinal, label],
    );
    if (changed.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return Boolean(changed.rowCount);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function deleteUserBookmark(
  userId: string,
  rootId: string,
  sourceKey: string,
  pageOrdinal: number,
): Promise<boolean> {
  validateOrdinal(pageOrdinal);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const changed = await client.query(
      'delete from user_bookmarks where user_id=$1 and root_id=$2 and source_key=$3 and page_ordinal=$4 returning id',
      [userId, rootId, normalizeUserSourceKey(sourceKey), pageOrdinal],
    );
    if (changed.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return Boolean(changed.rowCount);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function createUserCollection(
  userId: string,
  name: string,
): Promise<{ id: number; name: string; nameKey: string } | null> {
  const normalized = normalizeCollectionName(name);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const created = await client.query<{ id: string }>(
      'insert into user_collections(user_id,name,name_key) values($1,$2,$3) on conflict(user_id,name_key) do nothing returning id',
      [userId, normalized.name, normalized.nameKey],
    );
    if (created.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return created.rows[0] ? { id: Number(created.rows[0].id), ...normalized } : null;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function deleteUserCollection(userId: string, collectionId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const changed = await client.query(
      'delete from user_collections where id=$1 and user_id=$2 returning id',
      [collectionId, userId],
    );
    if (changed.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return Boolean(changed.rowCount);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function setUserCollectionMembership(
  userId: string,
  collectionId: number,
  rootId: string,
  targetKind: UserTargetKind,
  targetKey: string,
  member: boolean,
): Promise<boolean> {
  const key = validateTarget(targetKind, targetKey);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const changed = member
      ? await client.query(
          `insert into user_collection_members(collection_id,user_id,root_id,target_kind,target_key) select $1,$2,$3,$4,$5 where exists(select 1 from user_collections where id=$1 and user_id=$2) on conflict do nothing returning collection_id`,
          [collectionId, userId, rootId, targetKind, key],
        )
      : await client.query(
          'delete from user_collection_members where collection_id=$1 and user_id=$2 and root_id=$3 and target_kind=$4 and target_key=$5 returning collection_id',
          [collectionId, userId, rootId, targetKind, key],
        );
    if (changed.rowCount) await bumpUserStateRevision(client, userId);
    await client.query('commit');
    return Boolean(changed.rowCount);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function exportUserState(userId: string): Promise<{
  schemaVersion: 1;
  exportedAt: Date;
  progress: unknown[];
  targetState: unknown[];
  bookmarks: unknown[];
  collections: unknown[];
}> {
  const client = await pool.connect();
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    const [progress, targetState, bookmarks, collections] = await Promise.all([
      client.query(
        'select root_id as "rootId",source_key as "sourceKey",page_ordinal as "pageOrdinal",completed,revision,first_read_at as "firstReadAt",last_read_at as "lastReadAt",open_count as "openCount",updated_at as "updatedAt" from user_progress where user_id=$1 order by root_id,source_key',
        [userId],
      ),
      client.query(
        'select root_id as "rootId",target_kind as "targetKind",target_key as "targetKey",favorite,rating,note,hidden,updated_at as "updatedAt" from user_target_state where user_id=$1 order by root_id,target_kind,target_key',
        [userId],
      ),
      client.query(
        'select root_id as "rootId",source_key as "sourceKey",page_ordinal as "pageOrdinal",label,created_at as "createdAt",updated_at as "updatedAt" from user_bookmarks where user_id=$1 order by id',
        [userId],
      ),
      client.query(
        "select c.id,c.name,c.created_at as \"createdAt\",c.updated_at as \"updatedAt\",coalesce((select json_agg(json_build_object('rootId',m.root_id,'targetKind',m.target_kind,'targetKey',m.target_key,'createdAt',m.created_at) order by m.root_id,m.target_kind,m.target_key) from user_collection_members m where m.collection_id=c.id),'[]'::json) as members from user_collections c where c.user_id=$1 order by c.id",
        [userId],
      ),
    ]);
    await client.query('commit');
    return {
      schemaVersion: 1,
      exportedAt: new Date(),
      progress: progress.rows,
      targetState: targetState.rows,
      bookmarks: bookmarks.rows,
      collections: collections.rows,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function permanentlyDeleteUser(
  actorUserId: string,
  subjectUserId: string,
  requestId: string,
): Promise<Record<string, number>> {
  if (!requestId || requestId.length > 128) throw new Error('invalid_request_id');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const actor = await client.query<{ role: string | null }>(
      'select role from "user" where id=$1 for update',
      [actorUserId],
    );
    if (actor.rows[0]?.role !== 'admin') throw new Error('admin_required');
    if (actorUserId === subjectUserId) throw new Error('self_deletion_forbidden');
    const subject = await client.query<{ email: string }>(
      'select email from "user" where id=$1 for update',
      [subjectUserId],
    );
    if (!subject.rows[0]) throw new Error('user_not_found');
    const deletions = [
      ['user_progress', 'user_progress', 'user_id'],
      ['user_target_state', 'user_target_state', 'user_id'],
      ['user_bookmarks', 'user_bookmarks', 'user_id'],
      ['user_collections', 'user_collections', 'user_id'],
      ['user_collection_members', 'user_collection_members', 'user_id'],
      ['"session"', 'session', '"userId"'],
      ['account', 'account', '"userId"'],
      ['"twoFactor"', 'twoFactor', '"userId"'],
      ['passkey', 'passkey', '"userId"'],
      ['library_access_grants', 'library_access_grants', 'user_id'],
      ['gutter_user_state_revisions', 'gutter_user_state_revisions', 'user_id'],
    ] as const;
    const counts: Record<string, number> = {};
    for (const [table, countKey, column] of deletions) {
      const result = await client.query(`delete from ${table} where ${column}=$1`, [subjectUserId]);
      counts[countKey] = result.rowCount ?? 0;
    }
    const verification = await client.query(
      `with linked as (select identifier from "verification" where value=$1) delete from "verification" v where v.identifier=$2 or v.value=$1 or exists (select 1 from linked where v.identifier='2fa-attempts-' || linked.identifier)`,
      [subjectUserId, subject.rows[0].email],
    );
    counts.verification = verification.rowCount ?? 0;
    await client.query(
      'update "user" set email=$2,name=\'Deleted user\',image=null,role=null,banned=true,"banReason"=\'permanent_deletion\',"banExpires"=null,"twoFactorEnabled"=false,"updatedAt"=now() where id=$1',
      [subjectUserId, `deleted-${randomUUID()}@invalid`],
    );
    await client.query(
      'insert into gutter_user_state_audit(actor_user_id,subject_user_id,action,request_id) values($1,$2,$3,$4)',
      [actorUserId, subjectUserId, 'permanent_delete', requestId],
    );
    await client.query('commit');
    return counts;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function changeLibraryAccess(
  actorUserId: string,
  subjectUserId: string,
  rootId: string,
  action: 'grant' | 'revoke',
  requestId: string,
): Promise<number> {
  if (!requestId || requestId.length > 128) throw new Error('invalid_request_id');
  const result = await pool.query<{ revision: string }>(
    'select gutter_change_library_access($1,$2,$3,$4,$5)::text as revision',
    [actorUserId, subjectUserId, rootId, action, requestId],
  );
  return Number(result.rows[0]?.revision ?? 0);
}
export async function metadataStatus(rootId: string, canonicalIdentity: string) {
  if (!canonicalIdentityKey.test(canonicalIdentity)) throw new Error('invalid_canonical_identity');
  return pool.query(
    `select d.state,d.approved_snapshot,d.approved_provenance,d.approved_manifest_sha256,d.decided_at,d.updated_at,
            coalesce(jsonb_agg(jsonb_build_object('providerId',c.provider_id,'providerPriority',c.provider_priority,'configOrder',c.config_order,'values',c.values,'provenance',c.provenance) order by c.provider_priority,c.config_order,c.provider_id) filter (where c.provider_id is not null),'[]'::jsonb) as candidates
       from metadata_decisions d full join metadata_provider_candidates c using(root_id,canonical_identity_key)
      where coalesce(d.root_id,c.root_id)=$1 and coalesce(d.canonical_identity_key,c.canonical_identity_key)=$2
      group by d.state,d.approved_snapshot,d.approved_provenance,d.approved_manifest_sha256,d.decided_at,d.updated_at`,
    [rootId, canonicalIdentity],
  );
}
export async function approveMetadata(
  rootId: string,
  canonicalIdentity: string,
): Promise<MergedMetadata> {
  const status = await metadataStatus(rootId, canonicalIdentity);
  const row = status.rows[0];
  const candidates = (row?.candidates ?? []) as Candidate[];
  const merged = mergeCandidates(candidates);
  if (!Object.keys(merged.values).length) throw new Error('metadata_candidate_not_found');
  const manifest = await pool.query<{ manifest_sha256: string | null }>(
    `select i.manifest_sha256 from catalog_releases r join catalog_publications p on p.id=r.publication_id join source_items i on i.id=r.source_item_id where r.root_id=$1 and p.identity_key=$2 and i.active order by i.updated_at desc limit 1`,
    [rootId, canonicalIdentity],
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into metadata_decisions(root_id,canonical_identity_key,state,approved_snapshot,approved_provenance,approved_manifest_sha256)
     values($1,$2,'approved',$3::jsonb,$4::jsonb,$5)
     on conflict(root_id,canonical_identity_key) do update set state='approved',approved_snapshot=excluded.approved_snapshot,approved_provenance=excluded.approved_provenance,approved_manifest_sha256=excluded.approved_manifest_sha256,decided_at=now(),updated_at=now()`,
      [
        rootId,
        canonicalIdentity,
        JSON.stringify(merged.values),
        JSON.stringify(merged.provenance),
        manifest.rows[0]?.manifest_sha256 ?? null,
      ],
    );
    const sources = await client.query<{ id: CatalogId; effective: CatalogMetadata }>(
      `select i.id,m.effective from catalog_releases r join catalog_publications p on p.id=r.publication_id
       join source_items i on i.id=r.source_item_id join source_metadata m on m.source_item_id=i.id
       where r.root_id=$1 and p.identity_key=$2 and i.active`,
      [rootId, canonicalIdentity],
    );
    const affected = await Promise.all(
      sources.rows.map((source) =>
        reconcileCatalogItem(client, rootId, source.id, source.effective),
      ),
    );
    await refreshCatalogSeriesListStateTx(client, affected);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return merged;
}
export async function rejectMetadata(rootId: string, canonicalIdentity: string): Promise<void> {
  if (!canonicalIdentityKey.test(canonicalIdentity)) throw new Error('invalid_canonical_identity');
  await pool.query(
    `insert into metadata_decisions(root_id,canonical_identity_key,state) values($1,$2,'rejected') on conflict(root_id,canonical_identity_key) do update set state='rejected',decided_at=now(),updated_at=now()`,
    [rootId, canonicalIdentity],
  );
}
export async function recordMetadataCandidate(
  rootId: string,
  canonicalIdentity: string,
  candidate: Candidate,
): Promise<void> {
  if (!canonicalIdentityKey.test(canonicalIdentity) || !validCandidate(candidate))
    throw new Error('invalid_metadata_candidate');
  await pool.query(
    `insert into metadata_provider_candidates(root_id,canonical_identity_key,provider_id,provider_priority,config_order,values,provenance)
     values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
     on conflict(root_id,canonical_identity_key,provider_id) do update set provider_priority=excluded.provider_priority,config_order=excluded.config_order,values=excluded.values,provenance=excluded.provenance,observed_at=now()`,
    [
      rootId,
      canonicalIdentity,
      candidate.providerId,
      candidate.providerPriority,
      candidate.configOrder,
      JSON.stringify(candidate.values),
      JSON.stringify(candidate.provenance),
    ],
  );
}

/** Worker-local dispatch input. Source paths are resolved here and never leave this boundary. */
export async function metadataLookupIntents(
  rootId: string,
  relativePaths: readonly string[],
): Promise<
  readonly {
    canonicalIdentity: string;
    searchTerms: readonly string[];
    publicIds: readonly string[];
  }[]
> {
  if (!relativePaths.length) return [];
  const rows = await pool.query<{ identity_key: string; effective: CatalogMetadata }>(
    `select distinct p.identity_key,m.effective from source_items i join source_metadata m on m.source_item_id=i.id
     join catalog_releases r on r.source_item_id=i.id join catalog_publications p on p.id=r.publication_id
     where i.root_id=$1 and i.active and i.relative_path=any($2::text[])`,
    [rootId, [...new Set(relativePaths)].slice(0, 100)],
  );
  return rows.rows.map(({ identity_key, effective }) => ({
    canonicalIdentity: identity_key,
    searchTerms: [identityText(effective.title), identityText(effective.series)]
      .filter((value): value is string => value !== null)
      .slice(0, 8),
    publicIds: [],
  }));
}

export class StaleScanRunError extends Error {
  override readonly name = 'StaleScanRunError';
  readonly code = 'stale_scan_run';

  constructor() {
    super('stale_scan_run');
  }
}

function metadataFor(item: ScanItem): {
  effective: Record<string, unknown>;
  provenance: Record<string, 'inference' | 'comicinfo'>;
  ruleSet: string;
  sha256: string | null;
  annotations: readonly { locator: string; annotation: unknown }[];
  issues: readonly { code: string; rule: string; detail?: string }[];
} {
  const normalizeIssues = (source: readonly { code: string; rule: string; detail?: string }[]) => {
    const unique = new Map<string, { code: string; rule: string; detail?: string }>();
    for (const entry of source) {
      const detail = entry.detail?.trim().slice(0, 256);
      const normalized = {
        code: entry.code.slice(0, 128),
        rule: entry.rule.slice(0, 128),
        ...(detail ? { detail } : {}),
      };
      unique.set(
        `${normalized.code}\u0000${normalized.rule}\u0000${normalized.detail ?? ''}`,
        normalized,
      );
      if (unique.size >= 100) break;
    }
    return [...unique.values()];
  };
  const base =
    item.displayName ??
    basename(item.relativePath, item.kind === 'cbz' ? extname(item.relativePath) : undefined);
  const parent = basename(dirname(item.relativePath));
  const effective: Record<string, unknown> = {
    title: base,
    series: parent === '.' ? base : parent,
  };
  const provenance: Record<string, 'inference' | 'comicinfo'> = {
    title: 'inference',
    series: 'inference',
  };
  const issues = [...(item.scanIssues ?? [])];
  const document = item.comicInfo?.document;
  if (item.comicInfo) issues.push(...item.comicInfo.issues);
  if (!document)
    return {
      effective,
      provenance,
      ruleSet: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      sha256: null,
      annotations: [],
      issues: normalizeIssues(issues),
    };
  for (const [key, value] of Object.entries(document.fields)) {
    effective[key] = value;
    provenance[key] = 'comicinfo';
  }
  if (document.claimedPageCount !== null && document.claimedPageCount !== item.pages.length)
    issues.push({ code: 'page_count_mismatch', rule: 'comicinfo-anansi-v2.1-draft-compatible-v1' });
  const annotations: { locator: string; annotation: unknown }[] = [];
  const annotatedLocators = new Set<string>();
  for (const annotation of document.pageAnnotations) {
    const locator = item.pages[annotation.image] && scanPage(item.pages[annotation.image]!).locator;
    if (!locator)
      issues.push({
        code: 'page_image_out_of_range',
        rule: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      });
    else if (annotatedLocators.has(locator))
      issues.push({
        code: 'page_duplicate_image',
        rule: 'comicinfo-anansi-v2.1-draft-compatible-v1',
      });
    else {
      annotatedLocators.add(locator);
      annotations.push({ locator, annotation });
    }
  }
  return {
    effective,
    provenance,
    ruleSet: 'comicinfo-anansi-v2.1-draft-compatible-v1',
    sha256: document.sha256,
    annotations,
    issues: normalizeIssues(issues),
  };
}

type CatalogMetadata = Record<string, unknown>;
/** PostgreSQL bigint identifiers cross the catalog boundary as decimal strings.  Never coerce
 * them through JavaScript numbers: source inventories may legitimately exceed 2^53-1. */
type CatalogId = string;
const creatorRoles = [
  ['writers', 'writer'],
  ['pencillers', 'penciller'],
  ['inkers', 'inker'],
  ['colorists', 'colorist'],
  ['letterers', 'letterer'],
  ['coverArtists', 'cover_artist'],
  ['editors', 'editor'],
] as const;

/** Rebuilds the one release projection owned by a source item. Durable choices are intentionally
 * outside this projection, keyed by root plus canonical publication identity. */
async function reconcileCatalogItem(
  client: import('pg').PoolClient,
  rootId: string,
  sourceItemId: CatalogId,
  effective: CatalogMetadata,
  invalidateApprovedManifest: string | null = null,
): Promise<CatalogId> {
  await client.query(
    'insert into catalog_libraries(id,display_name) values($1,$1) on conflict(id) do nothing',
    [rootId],
  );
  const suppliedTitle = identityText(effective.title);
  const title = suppliedTitle ?? 'Untitled';
  const seriesName = identityText(effective.series) ?? title;
  const seriesIdentity = canonicalIdentity([1, seriesName]);
  const series = await client.query<{ id: CatalogId }>(
    `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key) values($1,$2,$3,$4,$5,$6)
     on conflict(library_id,identity_key) do update set identity_canonical_json=excluded.identity_canonical_json,display_name=excluded.display_name,search_key=excluded.search_key,sort_key=excluded.sort_key,updated_at=now() returning id`,
    [
      rootId,
      seriesIdentity.hash,
      seriesIdentity.canonicalJson,
      seriesName,
      searchKey(seriesName) ?? '',
      sortKey(seriesName) ?? '',
    ],
  );
  const kind = publicationKind(effective.format);
  const volume = integerOrNull(effective.volume);
  const number = identityText(effective.number);
  const sourceDisambiguator =
    volume === null && number === null && suppliedTitle === null ? sourceItemId : null;
  const publicationIdentity = canonicalIdentity([
    1,
    seriesIdentity.hash,
    kind,
    volume,
    number,
    title,
    sourceDisambiguator,
  ]);
  // Approval is a display-only overlay. Identity and relationships above are always source-derived.
  if (invalidateApprovedManifest !== null)
    await client.query(
      `update metadata_decisions set state='pending_reapproval',updated_at=now()
       where root_id=$1 and canonical_identity_key=$2 and state='approved'
         and approved_manifest_sha256 is distinct from $3`,
      [rootId, publicationIdentity.hash, invalidateApprovedManifest],
    );
  const decision = await client.query<{ title: unknown }>(
    `select approved_snapshot->'title' as title from metadata_decisions
     where root_id=$1 and canonical_identity_key=$2 and state='approved'`,
    [rootId, publicationIdentity.hash],
  );
  const displayTitle = identityText(decision.rows[0]?.title) ?? title;
  const publication = await client.query<{ id: CatalogId }>(
    `insert into catalog_publications(series_id,identity_key,publication_identity_canonical_json,kind,display_name,search_key,sort_key,volume,number_text)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict(series_id,identity_key) do update set publication_identity_canonical_json=excluded.publication_identity_canonical_json,display_name=excluded.display_name,search_key=excluded.search_key,sort_key=excluded.sort_key,updated_at=now() returning id`,
    [
      series.rows[0]!.id,
      publicationIdentity.hash,
      publicationIdentity.canonicalJson,
      kind,
      displayTitle,
      searchKey(displayTitle) ?? '',
      sortKey(displayTitle) ?? '',
      volume,
      number,
    ],
  );
  await client.query(
    'delete from catalog_credits where release_id in (select id from catalog_releases where source_item_id=$1)',
    [sourceItemId],
  );
  const release = await client.query<{ id: CatalogId }>(
    `insert into catalog_releases(publication_id,source_item_id,root_id,metadata_completeness)
     values($1,$2,$3,$4) on conflict(source_item_id) do update set publication_id=excluded.publication_id,root_id=excluded.root_id,metadata_completeness=excluded.metadata_completeness,updated_at=now() returning id`,
    [publication.rows[0]!.id, sourceItemId, rootId, Object.keys(effective).length],
  );
  const credit = async (
    kindValue: 'creator' | 'group' | 'publisher',
    role: string,
    value: unknown,
  ) => {
    const text = identityText(value);
    if (!text) return;
    const entity = await client.query<{ id: CatalogId }>(
      `insert into catalog_entities(kind,identity_text,search_key,display_name) values($1,$2,$3,$2)
       on conflict(kind,identity_text) do update set display_name=excluded.display_name returning id`,
      [kindValue, text, searchKey(text) ?? ''],
    );
    await client.query(
      'insert into catalog_credits(release_id,entity_id,role) values($1,$2,$3) on conflict do nothing',
      [release.rows[0]!.id, entity.rows[0]!.id, role],
    );
  };
  for (const [field, role] of creatorRoles)
    for (const value of Array.isArray(effective[field]) ? effective[field] : [])
      await credit('creator', role, value);
  await credit('group', 'group', effective.seriesGroup);
  await credit('publisher', 'publisher', effective.publisher);
  await credit('publisher', 'imprint', effective.imprint);
  return series.rows[0]!.id;
}

/**
 * Refreshes the bounded, rebuildable list read model from the current visible projection.
 * Callers own the surrounding short transaction so a release move never leaves either series
 * with an aggregate calculated from an intermediate state.
 */
export async function refreshCatalogSeriesListStateTx(
  client: import('pg').PoolClient,
  inputSeriesIds: readonly CatalogId[],
): Promise<void> {
  const seriesIds = [...new Set(inputSeriesIds.filter((id) => /^[1-9][0-9]*$/.test(id)))];
  if (!seriesIds.length) return;
  if (seriesIds.length > 1_000) throw new Error('catalog_refresh_series_limit');
  await client.query(
    `insert into catalog_series_list_state
       (series_id,library_id,display_name,sort_key,search_document,visible_publication_count,
        source_updated_mtime_ms,discovered_at,metadata_updated_at,refreshed_at)
     select s.id,s.library_id,s.display_name,s.sort_key,
       concat_ws(' ',s.search_key,v.publication_search_document),
       coalesce(v.publication_count,0)::integer,coalesce(v.source_updated_mtime_ms,0),s.created_at,
       coalesce(v.metadata_updated_at,s.created_at),now()
     from catalog_series s
     left join lateral (
       select count(distinct p.id) as publication_count,max(i.mtime_ms)::bigint as source_updated_mtime_ms,
         string_agg(distinct p.search_key,' ' order by p.search_key) as publication_search_document,
         max(m.updated_at) as metadata_updated_at
       from catalog_publications p join catalog_releases r on r.publication_id=p.id
       join visible_source_items i on i.id=r.source_item_id
       left join source_metadata m on m.source_item_id=i.id
       where p.series_id=s.id
     ) v on true
     where s.id=any($1::bigint[])
     on conflict(series_id) do update set library_id=excluded.library_id,display_name=excluded.display_name,
       sort_key=excluded.sort_key,search_document=excluded.search_document,
       visible_publication_count=excluded.visible_publication_count,
       source_updated_mtime_ms=excluded.source_updated_mtime_ms,discovered_at=excluded.discovered_at,
       metadata_updated_at=excluded.metadata_updated_at,refreshed_at=excluded.refreshed_at`,
    [seriesIds],
  );
}

async function catalogSeriesForSourceItem(
  client: import('pg').PoolClient,
  sourceItemId: CatalogId,
): Promise<CatalogId | null> {
  const row = await client.query<{ series_id: CatalogId }>(
    `select p.series_id from catalog_releases r join catalog_publications p on p.id=r.publication_id
     where r.source_item_id=$1`,
    [sourceItemId],
  );
  return row.rows[0]?.series_id ?? null;
}

/** Test/repair boundary only: rebuild the disposable list projection from catalog/source truth.
 * It intentionally never reads, deletes, or rewrites durable release preference overrides. */
export async function rebuildCatalogSeriesListStateForIntegration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ids = await client.query<{ id: CatalogId }>('select id from catalog_series order by id');
    await client.query('delete from catalog_series_list_state');
    for (let offset = 0; offset < ids.rows.length; offset += 1_000)
      await refreshCatalogSeriesListStateTx(
        client,
        ids.rows.slice(offset, offset + 1_000).map((row) => row.id),
      );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Integration-only disaster-recovery probe. Catalog tables are derived state: rebuild their
 * hierarchy from the active source inventory and stored effective metadata, while leaving every
 * durable source/user record (including preferred-release overrides) untouched. */
export async function rebuildCatalogProjectionForIntegration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Provider observations are disposable projections; operator decisions are durable and survive rebuild.
    await client.query('delete from metadata_provider_candidates');
    await client.query('delete from catalog_series_list_state');
    await client.query('delete from catalog_credits');
    await client.query('delete from catalog_releases');
    await client.query('delete from catalog_publications');
    await client.query('delete from catalog_series');
    await client.query('delete from catalog_entities');
    // Libraries are derived too. Recreate every configured root, including roots that are
    // currently empty, before replaying source-backed releases below.
    await client.query('delete from catalog_libraries');
    await client.query(`insert into catalog_libraries(id,display_name)
      select id,id from library_roots`);
    const sources = await client.query<{ id: string; root_id: string; effective: CatalogMetadata }>(
      `select i.id,i.root_id,m.effective from source_items i join source_metadata m on m.source_item_id=i.id
       where i.active order by i.root_id collate "C",i.id`,
    );
    const affected: CatalogId[] = [];
    for (const source of sources.rows)
      affected.push(
        await reconcileCatalogItem(client, source.root_id, source.id, source.effective),
      );
    for (let offset = 0; offset < affected.length; offset += 1_000)
      await refreshCatalogSeriesListStateTx(client, affected.slice(offset, offset + 1_000));
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Internal mutation boundary for durable global suppression. There is intentionally no HTTP
 * route in M2; callers must refresh the affected rebuildable read-model in the same transaction. */
export async function setGlobalSourceSuppression(
  sourceItemId: CatalogId,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const seriesId = await catalogSeriesForSourceItem(client, sourceItemId);
    await client.query(
      `insert into global_source_suppressions(source_item_id,reason) values($1,$2)
       on conflict(source_item_id) do update set reason=excluded.reason`,
      [sourceItemId, reason.trim().slice(0, 512) || 'suppressed'],
    );
    if (seriesId !== null) await refreshCatalogSeriesListStateTx(client, [seriesId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function clearGlobalSourceSuppression(sourceItemId: CatalogId): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const seriesId = await catalogSeriesForSourceItem(client, sourceItemId);
    await client.query('delete from global_source_suppressions where source_item_id=$1', [
      sourceItemId,
    ]);
    if (seriesId !== null) await refreshCatalogSeriesListStateTx(client, [seriesId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateSchema(): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
}

export async function assertSchema(): Promise<void> {
  const result = await pool.query<{ version: string }>(
    'select version from gutter_schema where version = $1 limit 1',
    [schemaVersion],
  );
  if (!result.rows[0])
    throw new Error(`database schema is incompatible; expected ${schemaVersion}`);
}

export type CatalogListOptions = Readonly<{
  q?: string;
  libraryId?: string;
  kind?: string;
  creator?: string;
  group?: string;
  publisher?: string;
  sort?: CatalogSort;
  direction?: CatalogDirection;
  limit?: number;
  cursor?: string;
}>;
export type CatalogListResult = Readonly<{
  items: Record<string, unknown>[];
  nextCursor: string | null;
}>;
export type CatalogListQuery = Readonly<{
  text: string;
  values: unknown[];
  filters: ReturnType<typeof normalizeCatalogFilters>;
  cursor: ReturnType<typeof decodeCatalogCursor>;
  filterHash: string;
}>;
/** Keyset selection is performed against the rebuildable list state before hydrating at most 101
 * series rows. The entity/kind predicates only decide membership; no aggregate is computed on read. */
export function catalogSeriesListQuery(
  options: CatalogListOptions,
  scope: LibraryAccessScope,
): CatalogListQuery {
  const filters = normalizeCatalogFilters(options);
  const filterHash = cursorFilterHash({ ...filters, accessScope: scope.scopeHash });
  const { sort, direction } = filters;
  const cursor = options.cursor ? decodeCatalogCursor(options.cursor) : null;
  if (
    options.cursor &&
    (!cursor ||
      cursor.sort !== sort ||
      cursor.direction !== direction ||
      cursor.filterHash !== filterHash)
  )
    throw new Error('invalid_catalog_cursor');
  const order = direction === 'asc' ? 'asc' : 'desc';
  const op = direction === 'asc' ? '>' : '<';
  // The cursor key expression, predicate and ordering deliberately share one state-table column.
  // Timestamp cursors are PostgreSQL text formatted to microseconds, never a JS Date/number.
  const key =
    sort === 'name'
      ? 'ls.sort_key collate "C"'
      : sort === 'source_updated'
        ? 'ls.source_updated_mtime_ms'
        : sort === 'discovered'
          ? 'ls.discovered_at'
          : 'ls.metadata_updated_at';
  const cursorPredicate = cursor
    ? sort === 'name'
      ? `(${key}, ls.series_id) ${op} ($7::text collate "C", $8::bigint)`
      : sort === 'source_updated'
        ? `(${key}, ls.series_id) ${op} ($7::bigint, $8::bigint)`
        : `(${key}, ls.series_id) ${op} ($7::timestamptz, $8::bigint)`
    : // Keep unused prepared-statement parameters typed on the first page; PostgreSQL otherwise
      // cannot infer $7/$8 before a cursor is supplied.
      '($7::text is null and $8::text is null)';
  const visibleJoins = `join catalog_releases r on r.publication_id=p.id
       join visible_source_items vi on vi.id=r.source_item_id
       join catalog_series vs on vs.id=p.series_id`;
  const visiblePredicate = `not exists (select 1 from global_source_suppressions gs where gs.source_item_id=vi.id)
         and not exists (select 1 from user_target_state vh where vh.user_id=$12 and vh.root_id=vs.library_id and vh.hidden and
           ((vh.target_kind='series' and vh.target_key=vs.identity_key) or
            (vh.target_kind='publication' and vh.target_key=vs.identity_key || ':' || p.identity_key) or
            (vh.target_kind in ('source','check') and vh.target_key=vi.relative_path)))`;
  return {
    text: `with selected as (
       select ls.series_id,${key} as cursor_key
       from catalog_series_list_state ls join library_roots root on root.id=ls.library_id and root.active
       where ls.visible_publication_count>0
         and exists (select 1 from catalog_publications p ${visibleJoins} where p.series_id=ls.series_id and ${visiblePredicate} limit 1 offset 0)
         and ($1::text is null or ls.library_id=$1)
         and ($2::text is null or exists(select 1 from catalog_publications p ${visibleJoins} where p.series_id=ls.series_id and p.kind=$2 and ${visiblePredicate} limit 1 offset 0))
         and ($3::text is null or ls.search_document collate "C" like '%' || $3 || '%')
         and ($4::text is null or exists(
           select 1 from catalog_publications p ${visibleJoins}
           join catalog_credits c on c.release_id=r.id
           join catalog_entities e on e.id=c.entity_id where p.series_id=ls.series_id and e.kind='creator' and e.search_key=$4 and ${visiblePredicate} limit 1 offset 0))
         and ($5::text is null or exists(
           select 1 from catalog_publications p ${visibleJoins}
           join catalog_credits c on c.release_id=r.id join catalog_entities e on e.id=c.entity_id
           where p.series_id=ls.series_id and e.kind='group' and e.search_key=$5 and ${visiblePredicate} limit 1 offset 0))
         and ($6::text is null or exists(
           select 1 from catalog_publications p ${visibleJoins}
           join catalog_credits c on c.release_id=r.id join catalog_entities e on e.id=c.entity_id
           where p.series_id=ls.series_id and e.kind='publisher' and e.search_key=$6 and ${visiblePredicate} limit 1 offset 0))
         and ($10::boolean or ls.library_id=any($11::text[]))
         and ${cursorPredicate}
       order by ${key} ${order},ls.series_id ${order} limit $9
     )
     select s.id,s.identity_key as "identityKey",s.display_name as "displayName",ls.library_id as "libraryId",(select count(distinct p.id)::int from catalog_publications p ${visibleJoins} where p.series_id=s.id and ${visiblePredicate}) as "publicationCount",
       ${sort === 'discovered' || sort === 'metadata_updated' ? 'to_char(selected.cursor_key at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')' : 'selected.cursor_key::text'} as cursor_key
     from selected join catalog_series_list_state ls on ls.series_id=selected.series_id
       join catalog_series s on s.id=selected.series_id
     order by selected.cursor_key${sort === 'name' ? ' collate "C"' : ''} ${order},s.id ${order}`,
    values: [
      filters.libraryId,
      filters.kind,
      filters.q,
      filters.creator,
      filters.group,
      filters.publisher,
      cursor?.tuple[0] ?? null,
      cursor?.tuple[1] ?? null,
      filters.limit + 1,
      scope.isAdmin,
      [...scope.rootIds],
      scope.userId,
    ],
    filters,
    cursor,
    filterHash,
  };
}
export async function listCatalogSeries(
  options: CatalogListOptions,
  scope: LibraryAccessScope,
): Promise<CatalogListResult> {
  const query = catalogSeriesListQuery(options, scope);
  const result = await pool.query<{
    id: string;
    identityKey: string;
    cursor_key: string;
    displayName: string;
    libraryId: string;
    publicationCount: number;
  }>(query.text, query.values);
  const rows = result.rows.slice(0, query.filters.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(({ cursor_key: _key, ...row }) => row),
    nextCursor:
      result.rows.length > rows.length && last
        ? encodeCatalogCursor({
            v: 1,
            scope: 'series',
            sort: query.filters.sort,
            direction: query.filters.direction,
            filterHash: query.filterHash,
            tuple: [last.cursor_key, String(last.id)],
          })
        : null,
  };
}
export async function listCatalogLibraries(
  scope: LibraryAccessScope,
): Promise<Record<string, unknown>[]> {
  return (
    await pool.query(
      `select l.id,l.display_name as "displayName",r.state,r.reason_code as "reasonCode",r.checked_at as "checkedAt"
       from catalog_libraries l join library_roots r on r.id=l.id
       where r.active and ($1::boolean or l.id=any($2::text[]))
       order by l.id collate "C"`,
      [scope.isAdmin, [...scope.rootIds]],
    )
  ).rows;
}
export async function catalogSeriesDetail(
  id: string,
  scope: LibraryAccessScope,
): Promise<Record<string, unknown> | null> {
  const series = await pool.query(
    `with visible as (
      select distinct p.id as publication_id,p.series_id,r.id as release_id,i.id as source_item_id
      from catalog_publications p join catalog_releases r on r.publication_id=p.id
      join visible_source_items i on i.id=r.source_item_id join catalog_series vs on vs.id=p.series_id
      where not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
        and not exists (select 1 from user_target_state h where h.user_id=$4 and h.root_id=vs.library_id and h.hidden and
          ((h.target_kind='series' and h.target_key=vs.identity_key) or
           (h.target_kind='publication' and h.target_key=vs.identity_key || ':' || p.identity_key) or
           (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
    )
    select s.id,s.display_name as "displayName",s.library_id as "libraryId" from catalog_series s
    where s.id=$1 and ($2::boolean or s.library_id=any($3::text[]))
    and exists (select 1 from visible v where v.series_id=s.id)`,
    [id, scope.isAdmin, [...scope.rootIds], scope.userId],
  );
  if (!series.rows[0]) return null;
  const publications = await pool.query(
    `with visible as (
      select distinct p.id as publication_id,p.series_id,r.id as release_id,i.id as source_item_id
      from catalog_publications p join catalog_releases r on r.publication_id=p.id
      join visible_source_items i on i.id=r.source_item_id join catalog_series s on s.id=p.series_id
      where not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
        and not exists (select 1 from user_target_state h where h.user_id=$2 and h.root_id=s.library_id and h.hidden and
          ((h.target_kind='series' and h.target_key=s.identity_key) or
           (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or
           (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
    )
    select p.id,p.display_name as "displayName",p.kind,p.volume,p.number_text as "number",
    count(distinct v.release_id)::int as "releaseCount" from visible v join catalog_publications p on p.id=v.publication_id
    where p.series_id=$1 group by p.id order by p.sort_key collate "C",p.id`,
    [id, scope.userId],
  );
  return { ...series.rows[0], publications: publications.rows };
}
export async function catalogPublicationDetail(
  id: string,
  scope: LibraryAccessScope,
): Promise<Record<string, unknown> | null> {
  const publication = await pool.query(
    `select p.id,p.display_name as "displayName",p.kind,p.volume,p.number_text as "number",s.id as "seriesId",s.display_name as "seriesName"
    from catalog_publications p join catalog_series s on s.id=p.series_id where p.id=$1
    and ($2::boolean or s.library_id=any($3::text[]))
    and exists (select 1 from catalog_releases r join visible_source_items i on i.id=r.source_item_id where r.publication_id=p.id
      and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
      and not exists (select 1 from user_target_state h where h.user_id=$4 and h.root_id=s.library_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path))))`,
    [id, scope.isAdmin, [...scope.rootIds], scope.userId],
  );
  if (!publication.rows[0]) return null;
  const releases = await pool.query(
    `select r.id,i.root_id as "rootId",i.relative_path as "relativePath",i.mtime_ms as "mtimeMs",i.page_count as "pageCount",
    coalesce(o.preferred_source_item_id=i.id,false) as "isPreferred"
    from catalog_releases r join visible_source_items i on i.id=r.source_item_id join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
    left join catalog_preferred_release_overrides o on o.root_id=r.root_id and o.publication_identity_key=p.identity_key and o.preferred_source_item_id=i.id
    where r.publication_id=$1 and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
      and not exists (select 1 from user_target_state h where h.user_id=$2 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path))) order by coalesce(o.preferred_source_item_id=i.id,false) desc,r.metadata_completeness desc,
    (select count(*) from reader_eligible_source_pages ep where ep.source_item_id=i.id) desc,i.mtime_ms desc,i.relative_path collate "C" asc,r.id asc`,
    [id, scope.userId],
  );
  const selected = releases.rows.find((release) => release.isPreferred) ?? releases.rows[0] ?? null;
  const credits = await pool.query(
    `select e.id,e.kind,e.display_name as "displayName",c.role
    from catalog_credits c join catalog_releases r on r.id=c.release_id join catalog_entities e on e.id=c.entity_id
    join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id
    join visible_source_items i on i.id=r.source_item_id where r.publication_id=$1
      and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
      and not exists (select 1 from user_target_state h where h.user_id=$2 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
    group by e.id,e.kind,e.display_name,c.role order by e.kind,e.display_name collate "C",c.role`,
    [id, scope.userId],
  );
  return {
    ...publication.rows[0],
    releases: releases.rows.map(({ rootId, relativePath, ...release }) => ({
      ...release,
      rootId,
      progressKey: readerProgressKey(rootId, relativePath),
    })),
    selectedReleaseId: selected?.id ?? null,
    credits: credits.rows,
  };
}
export async function catalogEntityDetail(
  kind: 'creator' | 'group' | 'publisher',
  id: string,
  scope: LibraryAccessScope,
): Promise<Record<string, unknown> | null> {
  const entity = await pool.query(
    `select e.id,e.kind,e.display_name as "displayName" from catalog_entities e where e.id=$1 and e.kind=$2
    and exists (select 1 from catalog_credits c join catalog_releases r on r.id=c.release_id
    join visible_source_items i on i.id=r.source_item_id where c.entity_id=e.id
    and ($3::boolean or r.root_id=any($4::text[]))
    and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
    and not exists (select 1 from user_target_state h join catalog_publications hp on hp.id=r.publication_id join catalog_series hs on hs.id=hp.series_id
      where h.user_id=$5 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=hs.identity_key) or (h.target_kind='publication' and h.target_key=hs.identity_key || ':' || hp.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path))))`,
    [id, kind, scope.isAdmin, [...scope.rootIds], scope.userId],
  );
  if (!entity.rows[0]) return null;
  const publications = await pool.query(
    `select distinct p.id,p.display_name as "displayName",p.kind,s.id as "seriesId",s.display_name as "seriesName"
    from catalog_credits c join catalog_releases r on r.id=c.release_id join catalog_publications p on p.id=r.publication_id
    join catalog_series s on s.id=p.series_id join visible_source_items i on i.id=r.source_item_id
    where c.entity_id=$1 and ($2::boolean or r.root_id=any($3::text[]))
      and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
      and not exists (select 1 from user_target_state h where h.user_id=$4 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
    order by p.display_name,p.id`,
    [id, scope.isAdmin, [...scope.rootIds], scope.userId],
  );
  return { ...entity.rows[0], publications: publications.rows };
}
export async function listCatalogEntities(
  kind: 'creator' | 'group' | 'publisher',
  scope: LibraryAccessScope,
  options: { q?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const query = searchKey(options.q) ?? null;
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  return (
    await pool.query(
      `select e.id,e.kind,e.display_name as "displayName",count(distinct p.id)::int as "publicationCount"
     from catalog_entities e join catalog_credits c on c.entity_id=e.id join catalog_releases r on r.id=c.release_id
     join catalog_publications p on p.id=r.publication_id join catalog_series s on s.id=p.series_id join visible_source_items i on i.id=r.source_item_id
     where e.kind=$1 and ($2::text is null or e.search_key like '%' || $2 || '%')
     and ($3::boolean or r.root_id=any($4::text[]))
     and not exists (select 1 from global_source_suppressions gs where gs.source_item_id=i.id)
     and not exists (select 1 from user_target_state h where h.user_id=$5 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
     group by e.id order by e.display_name collate "C",e.id limit $6`,
      [kind, query, scope.isAdmin, [...scope.rootIds], scope.userId, limit],
    )
  ).rows;
}

export async function reconcileLibraryRoots(
  roots: readonly LibraryRootSnapshot[],
  configGeneration: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('update library_roots set active = false, updated_at = now() where active');
    for (const root of roots) {
      await client.query(
        `insert into library_roots
          (id, configured_path, canonical_path, state, reason_code, checked_at, config_generation, active)
         values ($1, $2, $3, $4, $5, $6, $7, true)
         on conflict (id) do update set
           configured_path = excluded.configured_path,
           canonical_path = excluded.canonical_path,
           state = excluded.state,
           reason_code = excluded.reason_code,
           checked_at = excluded.checked_at,
           config_generation = excluded.config_generation,
           active = true,
           updated_at = now()`,
        [
          root.id,
          root.configuredPath,
          root.canonicalPath,
          root.state,
          root.reasonCode,
          root.checkedAt,
          configGeneration,
        ],
      );
      // Catalog libraries represent configured snapshots, including empty/unavailable roots.
      await client.query(
        `insert into catalog_libraries(id,display_name) values($1,$1)
         on conflict(id) do update set updated_at=now()`,
        [root.id],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function startScanRun(rootId: string, configGeneration: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const root = await client.query('select id from library_roots where id=$1 for update', [
      rootId,
    ]);
    if (root.rowCount !== 1) throw new Error('library root does not exist');
    const result = await client.query<{ id: number }>(
      `insert into scan_runs (root_id, config_generation, state) values ($1, $2, 'running') returning id`,
      [rootId, configGeneration],
    );
    await client.query('commit');
    return result.rows[0].id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export const scanTriggers = ['startup', 'periodic', 'watcher', 'manual'] as const;
export type ScanTrigger = (typeof scanTriggers)[number];
export type ScanRequestState =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ScanRequest = Readonly<{
  id: string;
  rootId: string;
  trigger: ScanTrigger;
  state: ScanRequestState;
  scanRunId: number | null;
  followUpRequested: boolean;
}>;

const triggerRank: Record<ScanTrigger, number> = { periodic: 0, startup: 1, watcher: 2, manual: 3 };
function scanTrigger(value: string): ScanTrigger {
  return (scanTriggers as readonly string[]).includes(value) ? (value as ScanTrigger) : 'periodic';
}
function safeScanError(value: string | undefined): string {
  return (
    (value ?? 'scan_failed')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 96) || 'scan_failed'
  );
}

/**
 * Coalesces at the database boundary. A running request never receives a second active row; its
 * one durable follow-up is created only when the current request becomes terminal.
 */
/**
 * Startup callers pass their configured interval so queue coalescing and the first due time share
 * the same root lock. This prevents the coordinator from immediately adding a periodic follow-up.
 */
export async function requestRootScan(
  rootId: string,
  trigger: ScanTrigger,
  scheduleIntervalSeconds?: number,
): Promise<ScanRequest> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const root = await client.query('select id from library_roots where id=$1 for update', [
      rootId,
    ]);
    if (root.rowCount !== 1) throw new Error('library_root_not_found');
    if (scheduleIntervalSeconds !== undefined)
      await client.query(
        `update library_roots set next_reconcile_at=now()+($2 * interval '1 second'),
         reconcile_interval_seconds=$2,updated_at=now() where id=$1`,
        [rootId, scheduleIntervalSeconds],
      );
    const active = await client.query<{
      id: string;
      trigger: string;
      state: ScanRequestState;
      scan_run_id: string | null;
      follow_up_requested: boolean;
      follow_up_trigger: string | null;
    }>(
      `select id,trigger,state,scan_run_id,follow_up_requested,follow_up_trigger from scan_requests
         where root_id=$1 and state in ('queued','dispatched','running') for update`,
      [rootId],
    );
    if (!active.rows[0]) {
      const created = await client.query<{ id: string }>(
        `insert into scan_requests(id,root_id,trigger,state) values($1,$2,$3,'queued') returning id`,
        [randomUUID(), rootId, trigger],
      );
      await client.query('commit');
      return {
        id: created.rows[0]!.id,
        rootId,
        trigger,
        state: 'queued',
        scanRunId: null,
        followUpRequested: false,
      };
    }
    const row = active.rows[0];
    const existingTrigger = scanTrigger(row.follow_up_trigger ?? row.trigger);
    const chosen = triggerRank[trigger] > triggerRank[existingTrigger] ? trigger : existingTrigger;
    if (row.state === 'running') {
      await client.query(
        `update scan_requests set follow_up_requested=true, follow_up_trigger=$2, updated_at=now() where id=$1`,
        [row.id, chosen],
      );
      await client.query('commit');
      return {
        id: row.id,
        rootId,
        trigger: chosen,
        state: row.state,
        scanRunId: row.scan_run_id ? Number(row.scan_run_id) : null,
        followUpRequested: true,
      };
    }
    await client.query('update scan_requests set trigger=$2, updated_at=now() where id=$1', [
      row.id,
      chosen,
    ]);
    await client.query('commit');
    return {
      id: row.id,
      rootId,
      trigger: chosen,
      state: row.state,
      scanRunId: row.scan_run_id ? Number(row.scan_run_id) : null,
      followUpRequested: row.follow_up_requested,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Claims queued rows before sending. A crash after this claim is recovered by recoverStaleScanRequests. */
export async function claimScanRequestsForDispatch(limit = 20): Promise<ScanRequest[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<{ id: string; root_id: string; trigger: string }>(
      `with candidates as (select id from scan_requests where state='queued' order by created_at for update skip locked limit $1)
       update scan_requests r set state='dispatched',updated_at=now() from candidates c where r.id=c.id
       returning r.id,r.root_id,r.trigger`,
      [limit],
    );
    await client.query('commit');
    return result.rows.map((row) => ({
      id: row.id,
      rootId: row.root_id,
      trigger: scanTrigger(row.trigger),
      state: 'dispatched',
      scanRunId: null,
      followUpRequested: false,
    }));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function requeueDispatchedScanRequest(id: string): Promise<void> {
  await pool.query(
    "update scan_requests set state='queued',updated_at=now(),pg_boss_job_id=null where id=$1 and state='dispatched'",
    [id],
  );
}

/** Duplicate pg-boss deliveries are harmless: only a dispatched request can be claimed once. */
export async function startRequestedScan(
  requestId: string,
  configGeneration: string,
  jobId?: string,
): Promise<{ runId: number; rootId: string; trigger: ScanTrigger } | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const requested = await client.query<{ root_id: string; trigger: string }>(
      "select root_id,trigger from scan_requests where id=$1 and state='dispatched' for update",
      [requestId],
    );
    if (!requested.rows[0]) {
      await client.query('commit');
      return null;
    }
    const row = requested.rows[0];
    const run = await client.query<{ id: number }>(
      `insert into scan_runs(root_id,config_generation,state,scan_request_id,pg_boss_job_id,trigger,heartbeat_at)
       values($1,$2,'running',$3,$4,$5,now()) returning id`,
      [row.root_id, configGeneration, requestId, jobId ?? null, row.trigger],
    );
    await client.query(
      `update scan_requests set state='running',scan_run_id=$2,pg_boss_job_id=$3,started_at=now(),updated_at=now() where id=$1`,
      [requestId, run.rows[0]!.id, jobId ?? null],
    );
    await client.query('commit');
    return { runId: run.rows[0]!.id, rootId: row.root_id, trigger: scanTrigger(row.trigger) };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatScanRun(
  runId: number,
  progress: Record<string, number>,
): Promise<boolean> {
  const safe = Object.fromEntries(
    Object.entries(progress)
      .slice(0, 16)
      .map(([key, value]) => [key.slice(0, 64), Math.max(0, Math.floor(value))]),
  );
  const result = await pool.query(
    "update scan_runs set heartbeat_at=now(),progress=$2 where id=$1 and state='running' and cancel_requested_at is null",
    [runId, JSON.stringify(safe)],
  );
  return result.rowCount === 1;
}

export async function protectSeenPaths(
  runId: number,
  rootId: string,
  paths: readonly string[],
): Promise<void> {
  if (!paths.length) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCurrentRun(client, runId, rootId);
    await client.query(
      `update source_items set last_seen_run_id=$1,updated_at=now() where root_id=$2 and active
         and relative_path = any($3::text[])`,
      [runId, rootId, paths.slice(0, 100)],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Protect a transiently unreadable subtree without treating SQL LIKE metacharacters as paths. */
export async function protectSeenPrefix(
  runId: number,
  rootId: string,
  prefix: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCurrentRun(client, runId, rootId);
    await client.query(
      `update source_items set last_seen_run_id=$1,updated_at=now() where root_id=$2 and active
       and ($3='.' or relative_path=$3 or left(relative_path,length($3)+1)=$3 || '/')`,
      [runId, rootId, prefix],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function requestScanCancellation(id: string): Promise<boolean> {
  const result = await pool.query(
    `update scan_requests set state=case when state in ('queued','dispatched') then 'cancelled' else state end,
       cancel_requested_at=now(),finished_at=case when state in ('queued','dispatched') then now() else finished_at end,updated_at=now()
     where id=$1 and state in ('queued','dispatched','running')`,
    [id],
  );
  if (result.rowCount)
    await pool.query(
      `update scan_runs set cancel_requested_at=now() where scan_request_id=$1 and state='running'`,
      [id],
    );
  return result.rowCount === 1;
}

export async function isScanCancellationRequested(runId: number): Promise<boolean> {
  const result = await pool.query<{ cancelled: boolean }>(
    `select r.cancel_requested_at is not null as cancelled from scan_runs s join scan_requests r on r.id=s.scan_request_id where s.id=$1`,
    [runId],
  );
  return result.rows[0]?.cancelled ?? false;
}

export async function dueReconciliationRequests(intervalSeconds: number): Promise<number> {
  const roots = await pool.query<{ id: string }>(
    `update library_roots set next_reconcile_at=now()+($1 * interval '1 second'), reconcile_interval_seconds=$1,updated_at=now()
     where active and state like 'ready_%' and (next_reconcile_at is null or next_reconcile_at <= now()) returning id`,
    [intervalSeconds],
  );
  for (const root of roots.rows) await requestRootScan(root.id, 'periodic');
  return roots.rowCount ?? 0;
}

/** Only an expired heartbeat is reclaimable; a live worker is never pre-empted. */
export async function recoverStaleScanRequests(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const stale = await client.query<{
      id: string;
      root_id: string;
      trigger: string;
      follow_up_requested: boolean;
      follow_up_trigger: string | null;
      cancel_requested_at: Date | null;
    }>(
      `select r.id,r.root_id,r.trigger,r.follow_up_requested,r.follow_up_trigger,r.cancel_requested_at
       from scan_requests r join scan_runs s on s.id=r.scan_run_id
       where r.state='running' and s.state='running' and s.heartbeat_at < now()-interval '2 minutes' for update skip locked`,
    );
    for (const row of stale.rows) {
      const state = row.cancel_requested_at ? 'cancelled' : 'failed';
      await client.query(
        "update scan_runs set state=$2,completed_at=now() where scan_request_id=$1 and state='running'",
        [row.id, state],
      );
      await client.query(
        "update scan_requests set state=$2,finished_at=now(),updated_at=now(),error_code=case when $2='failed' then 'interrupted' else null end where id=$1",
        [row.id, state],
      );
      const retryTrigger = row.follow_up_requested
        ? scanTrigger(row.follow_up_trigger ?? row.trigger)
        : row.cancel_requested_at
          ? null
          : scanTrigger(row.trigger ?? 'periodic');
      if (retryTrigger)
        await client.query(
          "insert into scan_requests(id,root_id,trigger,state) values($1,$2,$3,'queued') on conflict do nothing",
          [randomUUID(), row.root_id, retryTrigger],
        );
    }
    const redispatched = await client.query(
      "update scan_requests set state='queued',updated_at=now(),pg_boss_job_id=null where state='dispatched' and updated_at < now()-interval '2 minutes'",
    );
    await client.query('commit');
    return (stale.rowCount ?? 0) + (redispatched.rowCount ?? 0);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function assertCurrentRun(
  client: import('pg').PoolClient,
  runId: number,
  rootId: string,
): Promise<void> {
  const root = await client.query('select id from library_roots where id=$1 for update', [rootId]);
  if (root.rowCount !== 1) throw new StaleScanRunError();
  const run = await client.query<{ id: number }>(
    "select id from scan_runs where id=$1 and root_id=$2 and state='running'",
    [runId, rootId],
  );
  const newest = await client.query<{ id: number }>(
    'select max(id) as id from scan_runs where root_id=$1',
    [rootId],
  );
  if (run.rowCount !== 1 || run.rows[0].id !== newest.rows[0].id) throw new StaleScanRunError();
}

/** Database work is deliberately short; callers perform all filesystem and ZIP I/O first. */
export async function persistScanItems(
  runId: number,
  rootId: string,
  items: readonly ScanItem[],
): Promise<{ updated: number; unchanged: number }> {
  const outcome = { updated: 0, unchanged: 0 };
  for (let offset = 0; offset < items.length; offset += 100) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await assertCurrentRun(client, runId, rootId);
      for (const item of items.slice(offset, offset + 100)) {
        const pages = item.pages.map(scanPage);
        const itemManifest =
          item.manifestSha256 ?? manifestSha256(item.kind, item.size, item.mtimeMs, pages);
        const previous = await client.query<{
          manifest_sha256: string | null;
          active: boolean;
          quarantine_reason: string | null;
        }>(
          'select manifest_sha256, active, quarantine_reason from source_items where root_id=$1 and relative_path=$2 for update',
          [rootId, item.relativePath],
        );
        const upsert = await client.query<{ id: CatalogId }>(
          `insert into source_items (root_id, relative_path, kind, size_bytes, mtime_ms, page_count, quarantine_reason, last_seen_run_id, active, manifest_sha256)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
         on conflict (root_id, relative_path) do update set kind=excluded.kind, size_bytes=excluded.size_bytes,
           mtime_ms=excluded.mtime_ms, page_count=excluded.page_count, quarantine_reason=excluded.quarantine_reason,
           last_seen_run_id=excluded.last_seen_run_id, active=true, manifest_sha256=excluded.manifest_sha256, updated_at=now() returning id`,
          [
            rootId,
            item.relativePath,
            item.kind,
            item.size,
            item.mtimeMs,
            item.pages.length,
            item.quarantinedReason,
            runId,
            itemManifest,
          ],
        );
        const itemId = upsert.rows[0].id;
        // This is a read-only existence/old-owner check.  It lets a recovery/rebuild gap heal on
        // the next scan without treating every unchanged item as a catalog update.
        const oldSeriesId = await catalogSeriesForSourceItem(client, itemId);
        const metadata = metadataFor(item);
        const storedMetadata = await client.query<{ changed: boolean }>(
          `select effective is distinct from $2::jsonb or provenance is distinct from $3::jsonb
             or rule_set is distinct from $4 or comicinfo_sha256 is distinct from $5 as changed
           from source_metadata where source_item_id=$1`,
          [
            itemId,
            JSON.stringify(metadata.effective),
            JSON.stringify(metadata.provenance),
            metadata.ruleSet,
            metadata.sha256,
          ],
        );
        const metadataChanged = !storedMetadata.rows[0] || storedMetadata.rows[0].changed;
        // A reactivated item must be revalidated even when its discovery manifest is unchanged.
        const sourceChanged =
          previous.rows[0]?.manifest_sha256 !== itemManifest || previous.rows[0]?.active === false;
        // Quarantine is a catalog visibility input, but does not invalidate otherwise identical
        // source pages. Keep it separate from content/manifest revalidation.
        const visibilityChanged = previous.rows[0]?.quarantine_reason !== item.quarantinedReason;
        if (sourceChanged) outcome.updated += 1;
        else outcome.unchanged += 1;
        if (sourceChanged || metadataChanged || visibilityChanged || oldSeriesId === null) {
          // A changed source is the only scan path that can change its catalog inputs.  Keeping
          // this boundary here prevents an otherwise no-op full scan from rewriting releases,
          // credits, or list-state timestamps for the entire library.
          if (sourceChanged) {
            await client.query('delete from source_pages where source_item_id = $1', [itemId]);
            for (const [ordinal, page] of pages.entries())
              await client.query(
                'insert into source_pages (source_item_id, ordinal, locator, observed) values ($1,$2,$3,$4)',
                [itemId, ordinal, page.locator, JSON.stringify(page.observed)],
              );
            const generation = await client.query<{ validation_generation: number }>(
              'update source_items set validation_generation=validation_generation+1 where id=$1 returning validation_generation',
              [itemId],
            );
            await client.query(
              `insert into validation_intents (source_item_id, desired_manifest_sha256, generation, state)
               values ($1,$2,$3,'pending')
               on conflict (source_item_id) do update set desired_manifest_sha256=excluded.desired_manifest_sha256,
                 generation=excluded.generation, state='pending', lease_expires_at=null, next_attempt_at=now(),
                 attempt_count=0, last_failure_code=null, failed_at=null, updated_at=now()`,
              [itemId, itemManifest, Number(generation.rows[0].validation_generation)],
            );
          }
          await client.query(
            `insert into source_metadata (source_item_id, effective, provenance, rule_set, comicinfo_sha256)
           values ($1,$2,$3,$4,$5)
           on conflict (source_item_id) do update set effective=excluded.effective, provenance=excluded.provenance,
             rule_set=excluded.rule_set, comicinfo_sha256=excluded.comicinfo_sha256,
             updated_at=case when source_metadata.effective is distinct from excluded.effective
               or source_metadata.provenance is distinct from excluded.provenance
               or source_metadata.rule_set is distinct from excluded.rule_set
               or source_metadata.comicinfo_sha256 is distinct from excluded.comicinfo_sha256
               then now() else source_metadata.updated_at end`,
            [
              itemId,
              JSON.stringify(metadata.effective),
              JSON.stringify(metadata.provenance),
              metadata.ruleSet,
              metadata.sha256,
            ],
          );
          await client.query('delete from source_page_annotations where source_item_id=$1', [
            itemId,
          ]);
          for (const annotation of metadata.annotations)
            await client.query(
              'insert into source_page_annotations (source_item_id, locator, annotation) values ($1,$2,$3)',
              [itemId, annotation.locator, JSON.stringify(annotation.annotation)],
            );
          await client.query(
            'update source_metadata_issues set resolved_at=now(), retry_state=$2 where source_item_id=$1 and resolved_at is null',
            [itemId, 'resolved'],
          );
          for (const issue of metadata.issues)
            await client.query(
              `insert into source_metadata_issues (source_item_id, code, rule, detail, detected_at, last_seen_at, resolved_at, retry_state)
             values ($1,$2,$3,$4,now(),now(),null,'pending')
             on conflict (source_item_id, code, rule, detail) do update set last_seen_at=now(), resolved_at=null, retry_state='pending'`,
              [itemId, issue.code, issue.rule, issue.detail ?? ''],
            );
          const newSeriesId = await reconcileCatalogItem(
            client,
            rootId,
            itemId,
            metadata.effective,
            sourceChanged ? itemManifest : null,
          );
          await refreshCatalogSeriesListStateTx(
            client,
            oldSeriesId === null ? [newSeriesId] : [oldSeriesId, newSeriesId],
          );
        }
      }
      await client.query(
        `delete from metadata_provider_candidates c
          where c.root_id=$1 and not exists (
            select 1 from metadata_decisions d where d.root_id=c.root_id and d.canonical_identity_key=c.canonical_identity_key and d.state='approved'
          ) and not exists (
            select 1 from catalog_releases r join catalog_publications p on p.id=r.publication_id join source_items i on i.id=r.source_item_id
             where r.root_id=c.root_id and p.identity_key=c.canonical_identity_key and i.active
          )`,
        [rootId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return outcome;
}

export async function completeScanRun(
  runId: number,
  rootId: string,
  summary: ScanSummary,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await assertCurrentRun(client, runId, rootId);
    // The request row is locked in the same authority transaction as tombstoning. A cancellation
    // that wins this race is terminal without changing catalog visibility.
    const request = await client.query<{ cancel_requested_at: Date | null }>(
      'select cancel_requested_at from scan_requests where scan_run_id=$1 for update',
      [runId],
    );
    if (request.rows[0]?.cancel_requested_at) {
      await client.query(
        "update scan_runs set state='cancelled',summary=$2,completed_at=now() where id=$1 and state='running'",
        [runId, JSON.stringify(summary)],
      );
      await finalizeRequestedScan(client, runId, 'cancelled');
      await client.query('commit');
      return;
    }
    const finished = await client.query(
      `update scan_runs set state='completed', summary=$2, completed_at=now()
       where id=$1 and root_id=$3 and state='running'`,
      [runId, JSON.stringify(summary), rootId],
    );
    if (finished.rowCount !== 1) throw new StaleScanRunError();
    // Identify only releases whose source item actually became invisible.  A no-change full
    // scan must not sweep every series in the root just to recompute identical aggregates.
    const tombstoned = await client.query<{ id: CatalogId }>(
      `update source_items set active=false, updated_at=now()
       where root_id=$1 and active and last_seen_run_id is distinct from $2 returning id`,
      [rootId, runId],
    );
    // A completed full scan is authoritative: inactive items retain history but no desired work.
    // Removing a running intent fences its old owner just like a reclaimed lease epoch would.
    await client.query(
      `delete from validation_intents v using source_items i
       where v.source_item_id=i.id and i.root_id=$1 and not i.active`,
      [rootId],
    );
    await client.query(
      `delete from metadata_provider_candidates c
        where c.root_id=$1 and not exists (
          select 1 from metadata_decisions d where d.root_id=c.root_id and d.canonical_identity_key=c.canonical_identity_key and d.state='approved'
        ) and not exists (
          select 1 from catalog_releases r join catalog_publications p on p.id=r.publication_id join source_items i on i.id=r.source_item_id
           where r.root_id=c.root_id and p.identity_key=c.canonical_identity_key and i.active
        )`,
      [rootId],
    );
    const affected = new Set<CatalogId>();
    for (const source of tombstoned.rows) {
      const seriesId = await catalogSeriesForSourceItem(client, source.id);
      if (seriesId) affected.add(seriesId);
    }
    const ids = [...affected];
    for (let offset = 0; offset < ids.length; offset += 1_000)
      await refreshCatalogSeriesListStateTx(client, ids.slice(offset, offset + 1_000));
    await finalizeRequestedScan(client, runId, 'completed');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function failScanRun(runId: number, summary: ScanSummary): Promise<void> {
  await finishUnsuccessfulScan(runId, summary, 'failed');
}

export async function cancelScanRun(runId: number, summary: ScanSummary): Promise<void> {
  await finishUnsuccessfulScan(runId, summary, 'cancelled');
}

async function finishUnsuccessfulScan(
  runId: number,
  summary: ScanSummary,
  state: 'failed' | 'cancelled',
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update scan_runs set state=$2,summary=$3,completed_at=now() where id=$1 and state='running'`,
      [runId, state, JSON.stringify(summary)],
    );
    if (result.rowCount) await finalizeRequestedScan(client, runId, state);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeRequestedScan(
  client: import('pg').PoolClient,
  runId: number,
  state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const request = await client.query<{
    id: string;
    root_id: string;
    follow_up_requested: boolean;
    follow_up_trigger: string | null;
    cancel_requested_at: Date | null;
  }>(
    `select id,root_id,follow_up_requested,follow_up_trigger,cancel_requested_at from scan_requests
     where scan_run_id=$1 for update`,
    [runId],
  );
  const row = request.rows[0];
  if (!row) return; // legacy M1 queue run
  const terminal = row.cancel_requested_at ? 'cancelled' : state;
  await client.query(
    `update scan_requests set state=$2,finished_at=now(),updated_at=now(),error_code=case when $2='failed' then 'scan_failed' else null end where id=$1`,
    [row.id, terminal],
  );
  // Cancellation applies to this request/run only. A coalesced request is explicit operator work
  // and must survive, whereas a lone cancelled request creates no surprise retry.
  if (row.follow_up_requested)
    await client.query(
      `insert into scan_requests(id,root_id,trigger,state) values($1,$2,$3,'queued') on conflict do nothing`,
      [randomUUID(), row.root_id, scanTrigger(row.follow_up_trigger ?? 'periodic')],
    );
}

export type ValidationIntent = Readonly<{
  sourceItemId: CatalogId;
  manifestSha256: string;
  generation: number;
  leaseEpoch: number;
}>;

export const validationFailureCodes = [
  'root_unavailable',
  'source_manifest_changed',
  'validation_timeout',
  'lease_lost',
  'validation_cancelled',
  'validation_infrastructure_failure',
] as const;
export type ValidationFailureCode = (typeof validationFailureCodes)[number];

export function validationFailureCode(value: string | undefined): ValidationFailureCode {
  return (validationFailureCodes as readonly string[]).includes(value ?? '')
    ? (value as ValidationFailureCode)
    : 'validation_infrastructure_failure';
}

/** Claims only durable desired state; queue sends happen after this short transaction. */
export async function claimValidationIntents(limit = 20): Promise<ValidationIntent[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await client.query<{
      source_item_id: CatalogId;
      desired_manifest_sha256: string;
      generation: number;
      lease_epoch: number;
    }>(
      `with candidates as (
         select source_item_id from validation_intents
         where (state='pending' and next_attempt_at <= now()) or (state in ('queued','running') and lease_expires_at < now())
         order by updated_at for update skip locked limit $1
       ) update validation_intents i set state='queued', lease_expires_at=now()+interval '10 minutes',
         lease_epoch=i.lease_epoch+1, attempt_count=i.attempt_count+1, updated_at=now() from candidates c
       where i.source_item_id=c.source_item_id
       returning i.source_item_id, i.desired_manifest_sha256, i.generation, i.lease_epoch`,
      [limit],
    );
    await client.query('commit');
    return claimed.rows.map((row) => ({
      sourceItemId: row.source_item_id,
      manifestSha256: row.desired_manifest_sha256,
      generation: Number(row.generation),
      leaseEpoch: Number(row.lease_epoch),
    }));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getValidationSource(intent: ValidationIntent): Promise<{
  rootId: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  size: number;
  mtimeMs: number;
  pages: import('@gutter/discovery-scanner').ScanPage[];
} | null> {
  const item = await pool.query<{
    root_id: string;
    relative_path: string;
    kind: 'directory' | 'cbz';
    size_bytes: string;
    mtime_ms: number;
  }>(
    `select i.root_id,i.relative_path,i.kind,i.size_bytes,i.mtime_ms from source_items i join validation_intents v on v.source_item_id=i.id
     where i.id=$1 and i.active and i.manifest_sha256=$2 and i.validation_generation=$3
       and v.generation=$3 and v.lease_epoch=$4 and v.desired_manifest_sha256=$2
       and v.state in ('queued','running') and v.lease_expires_at > now()`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
  );
  if (!item.rows[0]) return null;
  const pages = await pool.query<{
    locator: string;
    observed: import('@gutter/discovery-scanner').ScanPage['observed'];
  }>('select locator, observed from source_pages where source_item_id=$1 order by ordinal', [
    intent.sourceItemId,
  ]);
  return {
    rootId: item.rows[0].root_id,
    relativePath: item.rows[0].relative_path,
    kind: item.rows[0].kind,
    size: Number(item.rows[0].size_bytes),
    mtimeMs: item.rows[0].mtime_ms,
    pages: pages.rows,
  };
}

/**
 * Internal reader authorization boundary.  A page is readable only when its release still points
 * at an active, non-quarantined source with a completed *current* validation run and the exact
 * ordinal has a valid result from that same run.  Source paths never cross this boundary.
 */
export type ReaderPageAuthorization = Readonly<{
  rootId: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  ordinal: number;
  locator: string;
  observed: import('@gutter/discovery-scanner').ScanPage['observed'];
  sourceSize: number;
  sourceMtimeMs: number;
  manifestSha256: string;
  validationGeneration: number;
}>;

/**
 * Opaque reader session authority.  The web client receives only the revision-scoped progress
 * identity and ordinals proven valid by the current completed validation run; pageCount is never
 * navigation authority.
 */
export type ReaderReleaseDescriptor = Readonly<{
  rootId: string;
  progressKey: string;
  revision: string;
  validOrdinals: number[];
  validPageCount: number;
  nextPublicationId: string | null;
}>;

/** Stable browser-local identity for one configured root/source without exposing its path. */
export function readerProgressKey(rootId: string, relativePath: string): string {
  return `source:${createHash('sha256').update(`${rootId}\u0000${relativePath}`).digest('base64url')}`;
}

/** Resolve the opaque public progress identity without accepting a root or filesystem path. */
export async function resolvePublicProgressTarget(
  userId: string,
  progressKey: string,
): Promise<Readonly<{ rootId: string; sourceKey: string }> | null> {
  if (!/^source:[A-Za-z0-9_-]{1,128}$/.test(progressKey)) return null;
  const result = await pool.query<{ root_id: string; relative_path: string }>(
    `select i.root_id,i.relative_path
       from public_progress_source_items i
       join catalog_releases r on r.source_item_id=i.id
       where gutter_user_can_read_release($1,r.id)
         and i.public_progress_key = $2
       limit 1`,
    [userId, progressKey],
  );
  const match = result.rows[0];
  return match ? { rootId: match.root_id, sourceKey: match.relative_path } : null;
}

/** Resolve a public identity target to an internal root/key only after ACL filtering. */
export async function resolvePublicTarget(
  userId: string,
  targetKind: 'source' | 'check' | 'series' | 'publication',
  targetId: string,
): Promise<Readonly<{ rootId: string; targetKey: string }> | null> {
  if (targetKind === 'source' || targetKind === 'check') {
    const progress = await resolvePublicProgressTarget(userId, targetId);
    return progress ? { rootId: progress.rootId, targetKey: progress.sourceKey } : null;
  }
  if (
    (targetKind === 'series' && !/^[0-9a-f]{64}$/.test(targetId)) ||
    (targetKind === 'publication' && !/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(targetId))
  )
    return null;
  const result = await pool.query<{ root_id: string; target_key: string }>(
    targetKind === 'series'
      ? `select s.library_id as root_id,s.identity_key as target_key
           from catalog_series s join catalog_publications p on p.series_id=s.id
           join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id
          where s.identity_key=$2 and gutter_user_can_read_release($1,r.id) limit 1`
      : `select s.library_id as root_id,s.identity_key || ':' || p.identity_key as target_key
           from catalog_publications p join catalog_series s on s.id=p.series_id
           join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id
          where s.identity_key=split_part($2,':',1) and p.identity_key=split_part($2,':',2)
            and gutter_user_can_read_release($1,r.id) limit 1`,
    [userId, targetId],
  );
  const row = result.rows[0];
  return row ? { rootId: row.root_id, targetKey: row.target_key } : null;
}

/** Stable opaque per-user collection identity; the numeric storage id never crosses the API. */
export function publicCollectionKey(userId: string, collectionId: string | number): string {
  return `collection:${createHash('sha256').update(`${userId}\u0000${collectionId}`).digest('base64url')}`;
}

export async function resolvePublicCollectionId(
  userId: string,
  collectionKey: string,
): Promise<number | null> {
  if (!/^collection:[A-Za-z0-9_-]{1,128}$/.test(collectionKey)) return null;
  const rows = await pool.query<{ id: string }>(
    'select id::text as id from user_collections where user_id=$1 order by id limit 1000',
    [userId],
  );
  const match = rows.rows.find((row) => publicCollectionKey(userId, row.id) === collectionKey);
  return match ? Number(match.id) : null;
}

export async function readerRootForRequestPath(pathname: string): Promise<string | null> {
  const release = /^\/api\/reader\/releases\/([1-9][0-9]*)(?:\/pages\/[0-9]+)?$/.exec(pathname);
  if (release) {
    const result = await pool.query<{ root_id: string }>(
      `select r.root_id from catalog_releases r join visible_source_items i on i.id=r.source_item_id
       join library_roots root on root.id=r.root_id and root.active where r.id=$1 limit 1`,
      [release[1]],
    );
    return result.rows[0]?.root_id ?? null;
  }
  const publication = /^\/api\/reader\/publications\/([1-9][0-9]*)$/.exec(pathname);
  if (!publication) return null;
  const result = await pool.query<{ library_id: string }>(
    `select s.library_id from catalog_publications p join catalog_series s on s.id=p.series_id
     join library_roots root on root.id=s.library_id and root.active where p.id=$1
     and exists(select 1 from catalog_releases r join visible_source_items i on i.id=r.source_item_id
       where r.publication_id=p.id) limit 1`,
    [publication[1]],
  );
  return result.rows[0]?.library_id ?? null;
}

/** User hide predicate for API-mediated reader requests; returns false without leaking identity. */
export async function isReaderPathVisible(userId: string, pathname: string): Promise<boolean> {
  const release = /^\/api\/reader\/releases\/([1-9][0-9]*)(?:\/pages\/[0-9]+)?$/.exec(pathname);
  const publication = /^\/api\/reader\/publications\/([1-9][0-9]*)$/.exec(pathname);
  if (!release && !publication) return false;
  const result = await pool.query(
    `select 1 from catalog_releases r join catalog_publications p on p.id=r.publication_id
      join catalog_series s on s.id=p.series_id join visible_source_items i on i.id=r.source_item_id
     where ${release ? 'r.id=$2' : 'p.id=$2'} and i.active and i.quarantine_reason is null
       and gutter_user_can_read_release($1,r.id)
       and not exists (select 1 from user_target_state h where h.user_id=$1 and h.root_id=r.root_id and h.hidden and ((h.target_kind='series' and h.target_key=s.identity_key) or (h.target_kind='publication' and h.target_key=s.identity_key || ':' || p.identity_key) or (h.target_kind in ('source','check') and h.target_key=i.relative_path)))
     limit 1`,
    [userId, (release ?? publication)![1]],
  );
  return Boolean(result.rowCount);
}

export async function getReaderReleaseDescriptor(
  releaseId: string,
  userId: string,
): Promise<ReaderReleaseDescriptor | null> {
  if (!/^[1-9][0-9]*$/.test(releaseId)) return null;
  const result = await pool.query<{
    manifest_sha256: string;
    validation_generation: number;
    root_id: string;
    relative_path: string;
    valid_ordinals: number[];
    next_publication_id: string | null;
  }>(
    `select i.manifest_sha256,i.validation_generation,i.root_id,i.relative_path,
      array_agg(sp.ordinal order by sp.ordinal) as valid_ordinals,
      (
        select next_publication.id::text
        from catalog_publications next_publication
        where next_publication.series_id=p.series_id
          and (
            next_publication.sort_key collate "C" > p.sort_key collate "C"
            or (next_publication.sort_key = p.sort_key and next_publication.id > p.id)
          )
          and exists (
            select 1 from catalog_releases next_release
            join visible_source_items next_item on next_item.id=next_release.source_item_id
            join public_reader_source_pages next_page on next_page.source_item_id=next_item.id
              and next_page.manifest_sha256=next_item.manifest_sha256
              and next_page.validation_generation=next_item.validation_generation
            where next_release.publication_id=next_publication.id
              and gutter_user_can_read_release($2,next_release.id)
              and next_item.active
              and next_item.quarantine_reason is null
              and exists (select 1 from library_roots next_root where next_root.id=next_item.root_id and next_root.active)
          )
        order by next_publication.sort_key collate "C",next_publication.id
        limit 1
      ) as next_publication_id
     from catalog_releases r
     join catalog_publications p on p.id=r.publication_id
     join visible_source_items i on i.id=r.source_item_id
     join public_reader_source_pages sp on sp.source_item_id=i.id
       and sp.manifest_sha256=i.manifest_sha256 and sp.validation_generation=i.validation_generation
     where r.id=$1 and gutter_user_can_read_release($2,r.id) and i.active and i.quarantine_reason is null
       and exists (select 1 from library_roots root where root.id=i.root_id and root.active)
     group by i.manifest_sha256,i.validation_generation,i.root_id,i.relative_path,p.series_id,p.sort_key,p.id`,
    [releaseId, userId],
  );
  const row = result.rows[0];
  return row
    ? {
        rootId: row.root_id,
        progressKey: readerProgressKey(row.root_id, row.relative_path),
        revision: `${row.manifest_sha256}:${row.validation_generation}`,
        validOrdinals: row.valid_ordinals,
        validPageCount: row.valid_ordinals.length,
        nextPublicationId: row.next_publication_id,
      }
    : null;
}

/** Resolve a publication to its current reader-ready release without exposing source metadata. */
export async function getReaderPublicationSession(
  publicationId: string,
  userId: string,
): Promise<Readonly<{ releaseId: string; release: ReaderReleaseDescriptor }> | null> {
  if (!/^[1-9][0-9]*$/.test(publicationId)) return null;
  const result = await pool.query<{ id: string }>(
    `select r.id::text as id
     from catalog_releases r
     join catalog_publications p on p.id=r.publication_id
     join visible_source_items i on i.id=r.source_item_id
     join public_reader_source_pages sp on sp.source_item_id=i.id
       and sp.manifest_sha256=i.manifest_sha256 and sp.validation_generation=i.validation_generation
     left join catalog_preferred_release_overrides o on o.root_id=r.root_id
       and o.publication_identity_key=p.identity_key and o.preferred_source_item_id=i.id
     where p.id=$1 and gutter_user_can_read_release($2,r.id) and i.active and i.quarantine_reason is null
       and exists (select 1 from library_roots root where root.id=i.root_id and root.active)
     group by r.id,o.preferred_source_item_id,i.id,r.metadata_completeness,i.mtime_ms,i.relative_path
     order by coalesce(o.preferred_source_item_id=i.id,false) desc,r.metadata_completeness desc,
       count(sp.ordinal) desc,i.mtime_ms desc,i.relative_path collate "C" asc,r.id asc
     limit 1`,
    [publicationId, userId],
  );
  const releaseId = result.rows[0]?.id;
  if (!releaseId) return null;
  const release = await getReaderReleaseDescriptor(releaseId, userId);
  return release ? { releaseId, release } : null;
}

/** Resolve a stable series/publication identity pair for the public page route. */
export async function getReaderPublicationSessionByIdentity(
  publicationKey: string,
  userId: string,
): Promise<Readonly<{ releaseId: string; release: ReaderReleaseDescriptor }> | null> {
  const match = /^([0-9a-f]{64}):([0-9a-f]{64})$/.exec(publicationKey);
  if (!match) return null;
  const result = await pool.query<{ id: string }>(
    `select p.id::text as id
       from catalog_publications p join catalog_series s on s.id=p.series_id
       join catalog_releases r on r.publication_id=p.id
      where s.identity_key=$1 and p.identity_key=$2 and gutter_user_can_read_release($3,r.id)
      order by r.id limit 1`,
    [match[1], match[2], userId],
  );
  const id = result.rows[0]?.id;
  return id ? getReaderPublicationSession(id, userId) : null;
}

export async function getAuthorizedReaderPage(
  releaseId: string,
  ordinal: number,
  userId: string,
): Promise<ReaderPageAuthorization | null> {
  if (!/^[1-9][0-9]*$/.test(releaseId) || !Number.isSafeInteger(ordinal) || ordinal < 0)
    return null;
  const result = await pool.query<{
    root_id: string;
    relative_path: string;
    kind: 'directory' | 'cbz';
    ordinal: number;
    locator: string;
    observed: import('@gutter/discovery-scanner').ScanPage['observed'];
    size_bytes: string;
    mtime_ms: number;
    manifest_sha256: string;
    validation_generation: number;
  }>(
    `select i.root_id,i.relative_path,i.kind,p.ordinal,p.locator,p.observed,i.size_bytes,i.mtime_ms,
            i.manifest_sha256,i.validation_generation
       from catalog_releases r
       join visible_source_items i on i.id=r.source_item_id
       join public_reader_source_pages p on p.source_item_id=i.id and p.ordinal=$2
         and p.manifest_sha256=i.manifest_sha256 and p.validation_generation=i.validation_generation
      where r.id=$1 and gutter_user_can_read_release($3,r.id) and i.active and i.quarantine_reason is null
        and exists (select 1 from library_roots lr where lr.id=i.root_id and lr.active)`,
    [releaseId, ordinal, userId],
  );
  const row = result.rows[0];
  return row
    ? {
        rootId: row.root_id,
        relativePath: row.relative_path,
        kind: row.kind,
        ordinal: row.ordinal,
        locator: row.locator,
        observed: row.observed,
        sourceSize: Number(row.size_bytes),
        sourceMtimeMs: row.mtime_ms,
        manifestSha256: row.manifest_sha256,
        validationGeneration: row.validation_generation,
      }
    : null;
}

/** A worker owns an intent only while this exact generation and monotonically claimed lease epoch remain unexpired. */
export async function renewValidationLease(intent: ValidationIntent): Promise<boolean> {
  const result = await pool.query(
    `update validation_intents set state='running', lease_expires_at=now()+interval '10 minutes', updated_at=now()
     where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$4
       and state in ('queued','running') and lease_expires_at > now()`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
  );
  return result.rowCount === 1;
}

export async function releaseValidationIntent(
  intent: ValidationIntent,
  failureCode?: string,
): Promise<void> {
  const safeCode = validationFailureCode(failureCode);
  // Infrastructure failures never create page results. Only the final bounded attempt receives a
  // durable run row so operators can distinguish terminal validation failure from missing work.
  await pool.query(
    `with released as (
       update validation_intents set
         state=case when attempt_count >= 5 then 'failed' else 'pending' end,
         lease_expires_at=null, last_failure_code=$4,
         failed_at=case when attempt_count >= 5 then now() else null end,
         next_attempt_at=now() + (least(3600, 30 * power(2, least(attempt_count, 7))) * interval '1 second'),
         updated_at=now()
       where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$5
         and state in ('queued','running') and lease_expires_at > now()
       returning source_item_id, desired_manifest_sha256, generation, state, attempt_count
     ) insert into page_validation_runs
       (source_item_id, manifest_sha256, generation, state, candidate_count, valid_count, skipped_count, bytes_read, duration_ms, summary)
     select source_item_id, desired_manifest_sha256, generation, 'failed', 0, 0, 0, 0, 0,
       jsonb_build_object('failureCode', $4, 'attemptCount', attempt_count)
     from released where state='failed'`,
    [intent.sourceItemId, intent.manifestSha256, intent.generation, safeCode, intent.leaseEpoch],
  );
}

export type CompletedValidation = Readonly<{
  candidateCount: number;
  validCount: number;
  skippedCount: number;
  bytesRead: number;
  durationMs: number;
  results: readonly {
    locator: string;
    state: 'valid' | 'skipped';
    reasonCode?: string;
    format?: string;
    width?: number;
    height?: number;
    bytesRead: number;
  }[];
}>;

/**
 * The generation fence is checked while locking both the intent and source row. A stale worker
 * therefore cannot replace results that a newer scan made authoritative.
 */
export async function completeValidationIntent(
  intent: ValidationIntent,
  summary: CompletedValidation,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const current = await client.query<{ source_item_id: CatalogId }>(
      `select v.source_item_id from validation_intents v join source_items i on i.id=v.source_item_id
     where v.source_item_id=$1 and v.desired_manifest_sha256=$2 and v.generation=$3 and v.lease_epoch=$4
         and v.state='running' and v.lease_expires_at > now() and i.active and i.manifest_sha256=$2
         and i.validation_generation=$3 for update of v, i`,
      [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
    );
    if (current.rowCount !== 1) {
      await client.query('rollback');
      return false;
    }
    await client.query(
      `insert into page_validation_runs (source_item_id,manifest_sha256,generation,state,candidate_count,valid_count,skipped_count,bytes_read,duration_ms,summary)
       values ($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9)`,
      [
        intent.sourceItemId,
        intent.manifestSha256,
        intent.generation,
        summary.candidateCount,
        summary.validCount,
        summary.skippedCount,
        summary.bytesRead,
        summary.durationMs,
        JSON.stringify({
          candidateCount: summary.candidateCount,
          validCount: summary.validCount,
          skippedCount: summary.skippedCount,
        }),
      ],
    );
    await client.query(
      'delete from page_validation_results where source_item_id=$1 and manifest_sha256=$2 and generation=$3',
      [intent.sourceItemId, intent.manifestSha256, intent.generation],
    );
    for (const result of summary.results)
      await client.query(
        `insert into page_validation_results (source_item_id,locator,manifest_sha256,generation,state,reason_code,format,width,height,bytes_read)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          intent.sourceItemId,
          result.locator,
          intent.manifestSha256,
          intent.generation,
          result.state,
          result.reasonCode ?? null,
          result.format ?? null,
          result.width ?? null,
          result.height ?? null,
          result.bytesRead,
        ],
      );
    await client.query(
      "delete from validation_intents where source_item_id=$1 and desired_manifest_sha256=$2 and generation=$3 and lease_epoch=$4 and state='running' and lease_expires_at > now()",
      [intent.sourceItemId, intent.manifestSha256, intent.generation, intent.leaseEpoch],
    );
    const seriesId = await catalogSeriesForSourceItem(client, intent.sourceItemId);
    if (seriesId !== null) await refreshCatalogSeriesListStateTx(client, [seriesId]);
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
