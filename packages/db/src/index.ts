import { databaseUrl, schemaVersion } from '@gutter/config';
import type { LibraryRootSnapshot } from '@gutter/library-roots';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
  manifestSha256,
  scanPage,
  type ScanItem,
  type ScanSummary,
} from '@gutter/discovery-scanner';

export const pool = new Pool({ connectionString: await databaseUrl() });
export const db = drizzle(pool);

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
  const publication = await client.query<{ id: CatalogId }>(
    `insert into catalog_publications(series_id,identity_key,publication_identity_canonical_json,kind,display_name,search_key,sort_key,volume,number_text)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict(series_id,identity_key) do update set publication_identity_canonical_json=excluded.publication_identity_canonical_json,display_name=excluded.display_name,search_key=excluded.search_key,sort_key=excluded.sort_key,updated_at=now() returning id`,
    [
      series.rows[0]!.id,
      publicationIdentity.hash,
      publicationIdentity.canonicalJson,
      kind,
      title,
      searchKey(title) ?? '',
      sortKey(title) ?? '',
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
}>;
/** Keyset selection is performed against the rebuildable list state before hydrating at most 101
 * series rows. The entity/kind predicates only decide membership; no aggregate is computed on read. */
export function catalogSeriesListQuery(options: CatalogListOptions = {}): CatalogListQuery {
  const filters = normalizeCatalogFilters(options);
  const { sort, direction } = filters;
  const cursor = options.cursor ? decodeCatalogCursor(options.cursor) : null;
  if (
    options.cursor &&
    (!cursor ||
      cursor.sort !== sort ||
      cursor.direction !== direction ||
      cursor.filterHash !== cursorFilterHash(filters))
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
  return {
    text: `with selected as (
       select ls.series_id,${key} as cursor_key
       from catalog_series_list_state ls join library_roots root on root.id=ls.library_id and root.active
       where ls.visible_publication_count > 0
         and ($1::text is null or ls.library_id=$1)
         and ($2::text is null or exists(
           select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id where p.series_id=ls.series_id and p.kind=$2))
         and ($3::text is null or ls.search_document collate "C" like '%' || $3 || '%')
         and ($4::text is null or exists(
           select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id join catalog_credits c on c.release_id=r.id
           join catalog_entities e on e.id=c.entity_id where p.series_id=ls.series_id and e.kind='creator' and e.search_key=$4))
         and ($5::text is null or exists(
           select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id join catalog_credits c on c.release_id=r.id
           join catalog_entities e on e.id=c.entity_id where p.series_id=ls.series_id and e.kind='group' and e.search_key=$5))
         and ($6::text is null or exists(
           select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id
           join visible_source_items i on i.id=r.source_item_id join catalog_credits c on c.release_id=r.id
           join catalog_entities e on e.id=c.entity_id where p.series_id=ls.series_id and e.kind='publisher' and e.search_key=$6))
         and ${cursorPredicate}
       order by ${key} ${order},ls.series_id ${order} limit $9
     )
     select s.id,s.display_name as "displayName",ls.library_id as "libraryId",ls.visible_publication_count::int as "publicationCount",
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
    ],
    filters,
    cursor,
  };
}
export async function listCatalogSeries(
  options: CatalogListOptions = {},
): Promise<CatalogListResult> {
  const query = catalogSeriesListQuery(options);
  const result = await pool.query<{
    id: string;
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
            filterHash: cursorFilterHash(query.filters),
            tuple: [last.cursor_key, String(last.id)],
          })
        : null,
  };
}
export async function listCatalogLibraries(): Promise<Record<string, unknown>[]> {
  return (
    await pool.query(`select l.id,l.display_name as "displayName",r.state,r.reason_code as "reasonCode",r.checked_at as "checkedAt"
    from catalog_libraries l join library_roots r on r.id=l.id where r.active order by l.id collate "C"`)
  ).rows;
}
export async function catalogSeriesDetail(id: string): Promise<Record<string, unknown> | null> {
  const series = await pool.query(
    `select s.id,s.display_name as "displayName",s.library_id as "libraryId" from catalog_series s
    where s.id=$1 and exists (select 1 from catalog_publications p join catalog_releases r on r.publication_id=p.id join visible_source_items i on i.id=r.source_item_id where p.series_id=s.id)`,
    [id],
  );
  if (!series.rows[0]) return null;
  const publications = await pool.query(
    `select p.id,p.display_name as "displayName",p.kind,p.volume,p.number_text as "number",
    count(r.id)::int as "releaseCount" from catalog_publications p join catalog_releases r on r.publication_id=p.id
    join visible_source_items i on i.id=r.source_item_id where p.series_id=$1 group by p.id order by p.sort_key collate "C",p.id`,
    [id],
  );
  return { ...series.rows[0], publications: publications.rows };
}
export async function catalogPublicationDetail(
  id: string,
): Promise<Record<string, unknown> | null> {
  const publication = await pool.query(
    `select p.id,p.display_name as "displayName",p.kind,p.volume,p.number_text as "number",s.id as "seriesId",s.display_name as "seriesName"
    from catalog_publications p join catalog_series s on s.id=p.series_id where p.id=$1
    and exists (select 1 from catalog_releases r join visible_source_items i on i.id=r.source_item_id where r.publication_id=p.id)`,
    [id],
  );
  if (!publication.rows[0]) return null;
  const releases = await pool.query(
    `select r.id,i.id as "sourceItemId",i.relative_path as "relativePath",i.mtime_ms as "mtimeMs",i.page_count as "pageCount",
    coalesce(o.preferred_source_item_id=i.id,false) as "isPreferred"
    from catalog_releases r join visible_source_items i on i.id=r.source_item_id join catalog_publications p on p.id=r.publication_id
    left join catalog_preferred_release_overrides o on o.root_id=r.root_id and o.publication_identity_key=p.identity_key and o.preferred_source_item_id=i.id
    where r.publication_id=$1 order by coalesce(o.preferred_source_item_id=i.id,false) desc,r.metadata_completeness desc,
    (select count(*) from reader_eligible_source_pages ep where ep.source_item_id=i.id) desc,i.mtime_ms desc,i.relative_path collate "C" asc,r.id asc`,
    [id],
  );
  const selected = releases.rows.find((release) => release.isPreferred) ?? releases.rows[0] ?? null;
  const credits = await pool.query(
    `select e.id,e.kind,e.display_name as "displayName",c.role
    from catalog_credits c join catalog_releases r on r.id=c.release_id join catalog_entities e on e.id=c.entity_id
    join visible_source_items i on i.id=r.source_item_id where r.publication_id=$1
    group by e.id,e.kind,e.display_name,c.role order by e.kind,e.display_name collate "C",c.role`,
    [id],
  );
  return {
    ...publication.rows[0],
    releases: releases.rows,
    selectedReleaseId: selected?.id ?? null,
    credits: credits.rows,
  };
}
export async function catalogEntityDetail(
  kind: 'creator' | 'group' | 'publisher',
  id: string,
): Promise<Record<string, unknown> | null> {
  const entity = await pool.query(
    `select e.id,e.kind,e.display_name as "displayName" from catalog_entities e where e.id=$1 and e.kind=$2
    and exists (select 1 from catalog_credits c join catalog_releases r on r.id=c.release_id join visible_source_items i on i.id=r.source_item_id where c.entity_id=e.id)`,
    [id, kind],
  );
  if (!entity.rows[0]) return null;
  const publications = await pool.query(
    `select distinct p.id,p.display_name as "displayName",p.kind,s.id as "seriesId",s.display_name as "seriesName"
    from catalog_credits c join catalog_releases r on r.id=c.release_id join catalog_publications p on p.id=r.publication_id
    join catalog_series s on s.id=p.series_id join visible_source_items i on i.id=r.source_item_id
    where c.entity_id=$1 order by p.display_name,p.id`,
    [id],
  );
  return { ...entity.rows[0], publications: publications.rows };
}
export async function listCatalogEntities(
  kind: 'creator' | 'group' | 'publisher',
  options: { q?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const query = searchKey(options.q) ?? null;
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  return (
    await pool.query(
      `select e.id,e.kind,e.display_name as "displayName",count(distinct p.id)::int as "publicationCount"
     from catalog_entities e join catalog_credits c on c.entity_id=e.id join catalog_releases r on r.id=c.release_id
     join catalog_publications p on p.id=r.publication_id join visible_source_items i on i.id=r.source_item_id
     where e.kind=$1 and ($2::text is null or e.search_key like '%' || $2 || '%')
     group by e.id order by e.display_name collate "C",e.id limit $3`,
      [kind, query, limit],
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
          );
          await refreshCatalogSeriesListStateTx(
            client,
            oldSeriesId === null ? [newSeriesId] : [oldSeriesId, newSeriesId],
          );
        }
      }
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

export async function getAuthorizedReaderPage(
  releaseId: string,
  ordinal: number,
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
       join source_items i on i.id=r.source_item_id
       join source_pages p on p.source_item_id=i.id and p.ordinal=$2
       join page_validation_results vr on vr.source_item_id=i.id and vr.locator=p.locator
         and vr.manifest_sha256=i.manifest_sha256 and vr.generation=i.validation_generation
         and vr.state='valid'
      where r.id=$1 and i.active and i.quarantine_reason is null
        and exists (select 1 from library_roots lr where lr.id=i.root_id and lr.active)
        and exists (
          select 1 from page_validation_runs run
           where run.source_item_id=i.id and run.manifest_sha256=i.manifest_sha256
             and run.generation=i.validation_generation and run.state='completed'
        )`,
    [releaseId, ordinal],
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
