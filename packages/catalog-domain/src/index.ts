import { createHash } from 'node:crypto';

export function identityText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized || null;
}

export function searchKey(value: unknown): string | null {
  return identityText(value)?.toLocaleLowerCase('und') ?? null;
}
export const sortKey = searchKey;

export type CatalogSort = 'name' | 'source_updated' | 'discovered' | 'metadata_updated';
export type CatalogDirection = 'asc' | 'desc';
export type CatalogCursor = Readonly<{
  v: 1;
  scope: 'series';
  sort: CatalogSort;
  direction: CatalogDirection;
  filterHash: string;
  tuple: readonly [string, string];
}>;
export type CatalogFilters = Readonly<{
  q: string | null;
  libraryId: string | null;
  kind: string | null;
  creator: string | null;
  group: string | null;
  publisher: string | null;
  sort: CatalogSort;
  direction: CatalogDirection;
  limit: number;
}>;
const catalogSorts = ['name', 'source_updated', 'discovered', 'metadata_updated'] as const;
const catalogDirections = ['asc', 'desc'] as const;
const decimalId = /^[1-9][0-9]*$/;
const timestampCursor = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
export function normalizeCatalogFilters(value: {
  q?: string;
  libraryId?: string;
  kind?: string;
  creator?: string;
  group?: string;
  publisher?: string;
  sort?: CatalogSort;
  direction?: CatalogDirection;
  limit?: number;
}): CatalogFilters {
  const text = (item: string | undefined) => identityText(item);
  return Object.freeze({
    q: searchKey(value.q),
    libraryId: text(value.libraryId),
    kind: text(value.kind),
    creator: searchKey(value.creator),
    group: searchKey(value.group),
    publisher: searchKey(value.publisher),
    sort: value.sort ?? 'name',
    direction: value.direction ?? 'asc',
    limit: Math.min(Math.max(value.limit ?? 30, 1), 100),
  });
}
export function cursorFilterHash(filters: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(filters), 'utf8').digest('hex');
}
export function encodeCatalogCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
export function decodeCatalogCursor(value: string): CatalogCursor | null {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const c = parsed as Record<string, unknown>;
    if (
      c.v !== 1 ||
      c.scope !== 'series' ||
      !catalogSorts.includes(c.sort as CatalogSort) ||
      !catalogDirections.includes(c.direction as CatalogDirection) ||
      typeof c.filterHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(c.filterHash) ||
      !Array.isArray(c.tuple) ||
      c.tuple.length !== 2 ||
      typeof c.tuple[0] !== 'string' ||
      typeof c.tuple[1] !== 'string' ||
      !decimalId.test(c.tuple[1])
    )
      return null;
    if (c.sort === 'name' && c.tuple[0].length > 4096) return null;
    if (c.sort === 'source_updated' && (!/^\d+$/.test(c.tuple[0]) || c.tuple[0].length > 20))
      return null;
    if (
      (c.sort === 'discovered' || c.sort === 'metadata_updated') &&
      !timestampCursor.test(c.tuple[0])
    )
      return null;
    return c as unknown as CatalogCursor;
  } catch {
    return null;
  }
}

export function identityHash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}
export function canonicalIdentity(
  parts: readonly unknown[],
): Readonly<{ canonicalJson: string; hash: string }> {
  const canonicalJson = JSON.stringify(parts);
  return { canonicalJson, hash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex') };
}

export type PublicationKind = 'artbook' | 'special' | 'chapter' | 'issue' | 'volume';
export function publicationKind(format: unknown): PublicationKind {
  const normalized = identityText(format)?.toLocaleLowerCase('und') ?? '';
  if (normalized === 'artbook' || normalized === 'art book') return 'artbook';
  if (['special', 'one shot', 'oneshot'].includes(normalized)) return 'special';
  if (normalized === 'chapter') return 'chapter';
  if (normalized === 'issue' || normalized === 'comic') return 'issue';
  return 'volume';
}

export function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
