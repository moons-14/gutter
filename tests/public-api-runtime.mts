import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

const base = process.env.PUBLIC_API_BASE_URL;
const origin = process.env.PUBLIC_API_ORIGIN ?? 'http://localhost:8080';
const databaseUrl = process.env.DATABASE_URL;
const runtimeOptions =
  base && databaseUrl
    ? {}
    : { skip: 'real Caddy/PostgreSQL runtime requires PUBLIC_API_BASE_URL and DATABASE_URL' };

class CookieJar {
  #cookies = new Map<string, string>();
  constructor(private readonly host: string) {}
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('host', this.host);
    if (this.#cookies.size)
      headers.set(
        'cookie',
        [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    const response = await fetch(`${base}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';', 1);
      const [name, value] = pair.split('=', 2);
      if (name && value) this.#cookies.set(name, value);
    }
    return response;
  }
}
const post = (jar: CookieJar, path: string, body: unknown) =>
  jar.fetch(path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
test(
  'PAT lifecycle, scopes, expiry, owner isolation, aliases, Caddy routing, and lookup/page ACLs',
  runtimeOptions,
  async () => {
    assert.ok(base && databaseUrl);
    const host = new URL(origin).host;
    const admin = new CookieJar(host);
    const database = new Pool({ connectionString: databaseUrl });
    const suffix = randomBytes(8).toString('hex');
    const email = `public-api-admin-${suffix}@example.invalid`;
    const password = `public-api-${randomBytes(24).toString('base64url')}`;
    const ownerEmail = `public-api-owner-${suffix}@example.invalid`;
    const ownerPassword = `public-api-owner-${randomBytes(24).toString('base64url')}`;
    let adminId: string | undefined;
    let ownerId: string | undefined;
    let tokenId: string | undefined;
    let expiringId: string | undefined;
    let lookupId: string | undefined;
    let rootId: string | undefined;
    try {
      assert.equal(
        (await post(admin, '/api/auth/bootstrap', { name: 'Public API admin', email, password }))
          .status,
        200,
      );
      assert.equal((await post(admin, '/api/auth/sign-in/email', { email, password })).status, 200);
      adminId = (
        (await (await admin.fetch('/api/auth/get-session')).json()) as { user?: { id?: string } }
      ).user?.id;
      assert.ok(adminId);
      const created = await post(admin, '/api/auth/admin/create-user', {
        name: 'Public API other owner',
        email: ownerEmail,
        password: ownerPassword,
        role: 'user',
      });
      assert.equal(created.status, 200);
      const createdBody = (await created.json()) as { user?: { id?: string } };
      assert.ok(createdBody.user?.id);
      ownerId = createdBody.user.id;

      const issued = await post(admin, '/api/user-state/pats', {
        label: `runtime-${suffix}`,
        scopes: ['catalog:read', 'reading-state:read'],
      });
      assert.equal(issued.status, 201);
      const issuedBody = (await issued.json()) as { id: string; token: string };
      tokenId = issuedBody.id;
      assert.match(issuedBody.token, /^gtr_pat_v1_[A-Za-z0-9_-]+$/);
      const stored = await database.query<{ token_hash: Buffer }>(
        'select token_hash from gutter_public_api_tokens where id=$1 and user_id=$2',
        [tokenId, adminId],
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(
        stored.rows[0]!.token_hash.toString('hex'),
        createHash('sha256').update(issuedBody.token).digest('hex'),
      );
      const listed = await admin.fetch('/api/user-state/pats');
      assert.equal(listed.status, 200);
      assert.doesNotMatch(JSON.stringify(await listed.json()), new RegExp(issuedBody.token));

      const patHeaders = (requestId: string) => ({
        authorization: `Bearer ${issuedBody.token}`,
        'x-request-id': requestId,
      });
      const catalog = await fetch(`${base}/api/v1/catalog`, {
        headers: { ...patHeaders('pat-catalog') },
      });
      assert.equal(catalog.status, 200);
      const catalogBody = (await catalog.json()) as { items?: unknown[]; nextCursor?: unknown };
      assert.ok(Array.isArray(catalogBody.items));
      assert.ok(Object.hasOwn(catalogBody, 'nextCursor'));
      const invalid = await fetch(`${base}/api/v1/catalog?limit=0`, {
        headers: { ...patHeaders('pat-invalid') },
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), {
        error: 'invalid_pagination',
        requestId: 'pat-invalid',
      });
      const insufficient = await fetch(`${base}/api/v1/search?q=missing`, {
        headers: { ...patHeaders('pat-scope') },
      });
      assert.equal(insufficient.status, 403);
      assert.deepEqual(await insufficient.json(), {
        error: 'insufficient_scope',
        requestId: 'pat-scope',
      });
      assert.equal(
        (await admin.fetch('/api/catalog/libraries')).status,
        200,
        'legacy Caddy facade routes to the API',
      );
      assert.equal(
        (await fetch(`${base}/api/v1/openapi.json`)).status,
        200,
        'v1 Caddy route serves OpenAPI',
      );

      const other = new CookieJar(host);
      assert.equal(
        (
          await post(other, '/api/auth/sign-in/email', {
            email: ownerEmail,
            password: ownerPassword,
          })
        ).status,
        200,
      );
      const ownerRevoke = await other.fetch(`/api/user-state/pats/${tokenId}`, {
        method: 'DELETE',
        headers: { origin, 'x-request-id': 'pat-owner' },
      });
      assert.equal(ownerRevoke.status, 200);
      assert.deepEqual(await ownerRevoke.json(), { revoked: false });

      const expiring = await post(admin, '/api/user-state/pats', {
        label: `expiry-${suffix}`,
        scopes: ['catalog:read'],
        expiresAt: new Date(Date.now() + 1_500).toISOString(),
      });
      assert.equal(expiring.status, 201);
      const expiringBody = (await expiring.json()) as { id: string; token: string };
      expiringId = expiringBody.id;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const expired = await fetch(`${base}/api/v1/catalog`, {
        headers: { authorization: `Bearer ${expiringBody.token}`, 'x-request-id': 'pat-expired' },
      });
      assert.equal(expired.status, 401);
      assert.deepEqual(await expired.json(), {
        error: 'authentication_required',
        requestId: 'pat-expired',
      });

      const revoked = await admin.fetch(`/api/user-state/pats/${tokenId}`, {
        method: 'DELETE',
        headers: { origin, 'x-request-id': 'pat-revoke' },
      });
      assert.equal(revoked.status, 200);
      assert.deepEqual(await revoked.json(), { revoked: true });
      const revokedUse = await fetch(`${base}/api/v1/catalog`, {
        headers: { authorization: `Bearer ${issuedBody.token}`, 'x-request-id': 'pat-revoked' },
      });
      assert.equal(revokedUse.status, 401);

      rootId = `public-${suffix}`;
      const seriesKey = 'c'.repeat(64);
      const publicationKey = 'd'.repeat(64);
      await database.query(
        `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
       values($1,$2,$2,'ready_empty',now(),$3,true)`,
        [rootId, `/public/${rootId}`, 'a'.repeat(64)],
      );
      const source = await database.query<{ id: string }>(
        `insert into source_items(root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256,validation_generation)
       values($1,'runtime-page.cbz','cbz',10,1,1,true,$2,1) returning id`,
        [rootId, 'b'.repeat(64)],
      );
      await database.query(
        `insert into catalog_libraries(id,display_name) values($1,'Public runtime')
       on conflict (id) do nothing`,
        [rootId],
      );
      const series = await database.query<{ id: string }>(
        `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key)
       values($1,$2,'{}','Public runtime series','public runtime series','public runtime series') returning id`,
        [rootId, seriesKey],
      );
      const publication = await database.query<{ id: string }>(
        `insert into catalog_publications(series_id,identity_key,publication_identity_canonical_json,kind,display_name,search_key,sort_key)
       values($1,$2,'{}','volume','Public runtime publication','public runtime publication','public runtime publication') returning id`,
        [series.rows[0]!.id, publicationKey],
      );
      await database.query(
        `insert into catalog_releases(publication_id,source_item_id,root_id,metadata_completeness)
       values($1,$2,$3,100)`,
        [publication.rows[0]!.id, source.rows[0]!.id, rootId],
      );
      await database.query(
        "insert into source_pages(source_item_id,ordinal,locator) values($1,0,'0.png')",
        [source.rows[0]!.id],
      );
      await database.query(
        `insert into page_validation_runs(source_item_id,manifest_sha256,generation,state,candidate_count,valid_count,skipped_count)
       values($1,$2,1,'completed',1,1,0)`,
        [source.rows[0]!.id, 'b'.repeat(64)],
      );
      await database.query(
        `insert into page_validation_results(source_item_id,locator,manifest_sha256,generation,state,format,width,height,bytes_read)
       values($1,'0.png',$2,1,'valid','png',1,1,10)`,
        [source.rows[0]!.id, 'b'.repeat(64)],
      );
      const lookupKey = `source:${createHash('sha256').update(`${rootId}\u0000runtime-page.cbz`).digest('base64url')}`;
      const lookupTokenResponse = await post(admin, '/api/user-state/pats', {
        label: `lookup-${suffix}`,
        scopes: ['reading-state:read', 'page:read'],
      });
      assert.equal(lookupTokenResponse.status, 201);
      const lookupToken = (await lookupTokenResponse.json()) as { id: string; token: string };
      lookupId = lookupToken.id;
      const sourceIdentity = await database.query<{
        id: string;
        root_id: string;
        relative_path: string;
        public_progress_key: string;
      }>(
        `select id::text,root_id,relative_path,public_progress_key
           from source_items where id=$1`,
        [source.rows[0]!.id],
      );
      assert.equal(sourceIdentity.rowCount, 1);
      assert.equal(sourceIdentity.rows[0]!.public_progress_key, lookupKey);
      const tokenIdentity = await database.query<{
        user_id: string;
        scopes: unknown;
        revoked_at: string | null;
        expires_at: string | null;
      }>(
        `select user_id,scopes,revoked_at,expires_at
           from gutter_public_api_tokens where id=$1`,
        [lookupId],
      );
      assert.equal(tokenIdentity.rowCount, 1);
      assert.equal(tokenIdentity.rows[0]!.user_id, adminId);
      assert.deepEqual(tokenIdentity.rows[0]!.scopes, ['reading-state:read', 'page:read']);
      assert.equal(tokenIdentity.rows[0]!.revoked_at, null);
      const progressView = await database.query<{
        id: string;
        root_id: string;
        relative_path: string;
        public_progress_key: string;
      }>(
        `select id::text,root_id,relative_path,public_progress_key
           from public_progress_source_items where public_progress_key=$1`,
        [lookupKey],
      );
      assert.deepEqual(progressView.rows[0], {
        id: source.rows[0]!.id,
        root_id: rootId,
        relative_path: 'runtime-page.cbz',
        public_progress_key: lookupKey,
      });
      const releaseAcl = await database.query<{
        release_id: string;
        source_item_id: string;
        allowed: boolean;
      }>(
        `select r.id::text as release_id,r.source_item_id::text,
                gutter_user_can_read_release($1,r.id) as allowed
           from catalog_releases r where r.source_item_id=$2`,
        [adminId, source.rows[0]!.id],
      );
      assert.equal(releaseAcl.rowCount, 1);
      assert.equal(releaseAcl.rows[0]!.allowed, true);
      const internalResolution = await database.query<{ relative_path: string }>(
        `select i.relative_path
           from visible_source_items i
          where i.root_id=$1 and i.active and i.quarantine_reason is null
            and exists (
              select 1 from library_access_grants g where g.user_id=$3 and g.root_id=i.root_id
              union all
              select 1 from "user" u where u.id=$3 and u.role='admin'
            )
            and not exists (
              select 1 from user_target_state h
               where h.user_id=$3 and h.root_id=i.root_id and h.hidden
                 and h.target_kind in ('source','check') and h.target_key=i.relative_path
            )
            and 'source:' || rtrim(translate(
              encode(sha256(convert_to(i.root_id,'UTF8') || decode('00','hex') || convert_to(i.relative_path,'UTF8')),'base64'),
              '+/','-_'),'=') = $2
          limit 1`,
        [rootId, lookupKey, adminId],
      );
      assert.deepEqual(internalResolution.rows[0], { relative_path: 'runtime-page.cbz' });
      const apiRoleClient = await database.connect();
      try {
        await apiRoleClient.query('set role gutter_api');
        const apiRoleResolution = await apiRoleClient.query<{ relative_path: string }>(
          `select i.relative_path
             from public_progress_source_items i
             join catalog_releases r on r.source_item_id=i.id
            where gutter_user_can_read_release($1,r.id) and i.public_progress_key=$2
            limit 1`,
          [adminId, lookupKey],
        );
        assert.deepEqual(apiRoleResolution.rows[0], { relative_path: 'runtime-page.cbz' });
      } finally {
        await apiRoleClient.query('reset role');
        apiRoleClient.release();
      }
      const lookup = await fetch(
        `${base}/api/v1/progress?progressKey=${encodeURIComponent(lookupKey)}`,
        {
          headers: { authorization: `Bearer ${lookupToken.token}`, 'x-request-id': 'lookup' },
        },
      );
      assert.equal(
        lookup.status,
        200,
        'public progress lookup resolves through the migrated bounded query',
      );
      const page = await fetch(`${base}/api/v1/page/${seriesKey}:${publicationKey}/0`, {
        headers: { authorization: `Bearer ${lookupToken.token}`, 'x-request-id': 'page-acl' },
      });
      assert.equal(
        page.status,
        404,
        'page ACL/worker visibility remains non-enumerable through Caddy',
      );
    } finally {
      if (rootId) {
        await database.query(
          `delete from catalog_credits where release_id in
             (select id from catalog_releases where root_id=$1)`,
          [rootId],
        );
        await database.query('delete from catalog_releases where root_id=$1', [rootId]);
        await database.query('delete from catalog_series_list_state where library_id=$1', [rootId]);
        await database.query(
          `delete from catalog_publications where series_id in
             (select id from catalog_series where library_id=$1)`,
          [rootId],
        );
        await database.query('delete from catalog_series where library_id=$1', [rootId]);
        await database.query('delete from catalog_libraries where id=$1', [rootId]);
        await database.query('delete from source_items where root_id=$1', [rootId]);
        await database.query('delete from library_roots where id=$1', [rootId]);
      }
      if (expiringId)
        await database.query('delete from gutter_public_api_tokens where id=$1', [expiringId]);
      if (lookupId)
        await database.query('delete from gutter_public_api_tokens where id=$1', [lookupId]);
      if (ownerId) await database.query('delete from "user" where id=$1', [ownerId]);
      if (adminId) await database.query('delete from "user" where id=$1', [adminId]);
      await database.end();
    }
  },
);
