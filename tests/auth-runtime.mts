import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { Pool } from 'pg';

const base = process.env.AUTH_BASE_URL;
const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
const databaseUrl = process.env.DATABASE_URL;
if (!base || !publicOrigin || !databaseUrl)
  throw new Error('auth runtime requires AUTH_BASE_URL, AUTH_PUBLIC_ORIGIN, and DATABASE_URL');
const publicHost = new URL(publicOrigin).host;
const exec = promisify(execFile);

class CookieJar {
  #cookies = new Map<string, string>();
  entries(): Array<[string, string]> {
    return [...this.#cookies];
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('host', publicHost);
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
const post = (jar: CookieJar, path: string, body: unknown, origin = publicOrigin) =>
  jar.fetch(path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function expectStatus(
  label: string,
  response: Promise<Response>,
  expected: number,
): Promise<void> {
  assert.equal((await response).status, expected, label);
}
async function expectNoSession(label: string, response: Promise<Response>): Promise<void> {
  const result = await response;
  assert.equal(result.status, 200, label);
  const body: unknown = await result.json();
  if (body !== null && (!body || typeof body !== 'object' || 'user' in body))
    throw new Error(`${label}: session remains present`);
}
async function recovery(action: 'disable-user' | 'enable-user', email: string): Promise<void> {
  const result = await exec('pnpm', ['--filter', '@gutter/api', 'auth', action, email], {
    timeout: 30_000,
  });
  assert.match(
    result.stdout,
    new RegExp(`^${action === 'disable-user' ? 'disabled' : 'enabled'}_users=1\\s*$`),
  );
}
function totp(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('TOTP URI omitted secret');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('auth bootstrap, origin, proxy rate limit, revocation, disable, and logout', async () => {
  const email = `admin-${randomBytes(6).toString('hex')}@example.invalid`;
  const password = `test-${randomBytes(24).toString('base64url')}`;
  const jar = new CookieJar();
  const database = new Pool({ connectionString: databaseUrl });
  try {
    await expectStatus(
      'public signup denied',
      post(new CookieJar(), '/api/auth/sign-up/email', { name: 'blocked', email, password }),
      403,
    );
    await expectStatus(
      'first bootstrap accepted',
      post(jar, '/api/auth/bootstrap', { name: 'admin', email, password }),
      200,
    );
    await expectStatus(
      'second bootstrap denied',
      post(new CookieJar(), '/api/auth/bootstrap', {
        name: 'second',
        email: `second-${email}`,
        password,
      }),
      403,
    );
    await expectStatus(
      'foreign-origin sign-in denied',
      post(
        new CookieJar(),
        '/api/auth/sign-in/email',
        { email, password },
        'http://foreign.invalid',
      ),
      403,
    );
    await expectStatus(
      'password login accepted',
      post(jar, '/api/auth/sign-in/email', { email, password }),
      200,
    );
    const ordinaryEmail = `reader-${randomBytes(6).toString('hex')}@example.invalid`;
    const ordinaryPassword = `test-${randomBytes(24).toString('base64url')}`;
    const createdUser = await post(jar, '/api/auth/admin/create-user', {
      name: 'reader',
      email: ordinaryEmail,
      password: ordinaryPassword,
      role: 'user',
    });
    assert.equal(createdUser.status, 200, 'admin creates an ordinary user');
    const ordinaryId = ((await createdUser.json()) as { user?: { id?: string } }).user?.id;
    assert.ok(ordinaryId, 'created user returns an opaque id');
    const rootId = `runtime-${randomBytes(6).toString('hex')}`;
    await database.query(
      `insert into library_roots(id,configured_path,canonical_path,state,checked_at,config_generation,active)
       values($1,$2,$2,'ready_empty',now(),$3,true)`,
      [rootId, `/runtime/${rootId}`, 'a'.repeat(64)],
    );
    await database.query(
      `insert into catalog_libraries(id,display_name) values($1,'Runtime library')`,
      [rootId],
    );
    const inserted = await database.query<{ id: string }>(
      `insert into catalog_series(library_id,identity_key,identity_canonical_json,display_name,search_key,sort_key)
       select $1,repeat(substr(md5(value::text),1,32),2),jsonb_build_array(value),
         'Runtime series '||value,'runtime series '||value,'runtime series '||value
       from generate_series(1,2) value returning id`,
      [rootId],
    );
    for (const [index, row] of inserted.rows.entries()) {
      const source = await database.query<{ id: string }>(
        `insert into source_items(
           root_id,relative_path,kind,size_bytes,mtime_ms,page_count,active,manifest_sha256)
         values($1,$2,'cbz',1024,$3,1,true,$4)
         returning id`,
        [rootId, `runtime-${index + 1}.cbz`, index + 1, 'a'.repeat(64)],
      );
      const publication = await database.query<{ id: string }>(
        `insert into catalog_publications(
           series_id,identity_key,publication_identity_canonical_json,kind,
           display_name,search_key,sort_key,volume,number_text)
         values($1,$2,$3,'volume',$4,$5,$5,1,'1')
         returning id`,
        [
          row.id,
          (index + 1).toString(16).padStart(64, '0'),
          JSON.stringify(['runtime-publication', index + 1]),
          `Runtime publication ${index + 1}`,
          `runtime publication ${index + 1}`,
        ],
      );
      await database.query(
        `insert into catalog_releases(publication_id,source_item_id,root_id,metadata_completeness)
         values($1,$2,$3,100)`,
        [publication.rows[0]!.id, source.rows[0]!.id, rootId],
      );
      await database.query(
        `insert into catalog_series_list_state(
          series_id,library_id,display_name,sort_key,search_document,visible_publication_count,
          source_updated_mtime_ms,discovered_at,metadata_updated_at)
         values($1,$2,$3,$3,$3,1,$4,now(),now())`,
        [row.id, rootId, `Runtime series ${index + 1}`, index + 1],
      );
    }
    const ordinary = new CookieJar();
    await expectStatus(
      'ordinary user login accepted',
      post(ordinary, '/api/auth/sign-in/email', {
        email: ordinaryEmail,
        password: ordinaryPassword,
      }),
      200,
    );
    assert.deepEqual(
      ((await (await ordinary.fetch('/api/catalog/libraries')).json()) as { items: unknown[] })
        .items,
      [],
      'deny-default catalog list is empty',
    );
    assert.equal(
      (
        await jar.fetch(`/api/admin/library-access/${ordinaryId}/${rootId}`, {
          method: 'PUT',
          headers: { origin: 'http://foreign.invalid' },
        })
      ).status,
      403,
      'foreign-origin grant mutation is denied',
    );
    const grant = await jar.fetch(`/api/admin/library-access/${ordinaryId}/${rootId}`, {
      method: 'PUT',
      headers: { origin: publicOrigin, 'x-request-id': `grant-${rootId}` },
    });
    assert.equal(grant.status, 200, 'admin grants library access');
    const firstPage = await ordinary.fetch('/api/catalog/series?limit=1');
    assert.equal(firstPage.status, 200, 'granted user can list the library');
    const firstPageBody = (await firstPage.json()) as {
      items: Array<{ id: string }>;
      nextCursor?: string | null;
    };
    assert.equal(firstPageBody.items.length, 1);
    assert.ok(firstPageBody.nextCursor, 'granted list emits an ACL-scoped cursor');
    const revoke = await jar.fetch(`/api/admin/library-access/${ordinaryId}/${rootId}`, {
      method: 'DELETE',
      headers: { origin: publicOrigin, 'x-request-id': `revoke-${rootId}` },
    });
    assert.equal(revoke.status, 200, 'admin revokes library access');
    assert.equal(
      (
        await ordinary.fetch(
          `/api/catalog/series?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`,
        )
      ).status,
      400,
      'revocation immediately invalidates an issued catalog cursor',
    );
    assert.deepEqual(
      ((await (await ordinary.fetch('/api/catalog/libraries')).json()) as { items: unknown[] })
        .items,
      [],
      'revocation immediately removes the library from list hydration',
    );
    assert.equal(
      (await ordinary.fetch('/api/reader/releases/999999')).status,
      404,
      'revoked reader request is non-enumerable',
    );
    assert.equal(
      (await new CookieJar().fetch('/api/reader/releases/999999')).status,
      404,
      'anonymous reader request is non-enumerable',
    );
    await expectStatus(
      'foreign-origin logout denied',
      post(jar, '/api/auth/sign-out', {}, 'http://foreign.invalid'),
      403,
    );
    const browser = await chromium.launch({
      headless: true,
      args: ['--host-resolver-rules=MAP localhost web'],
    });
    try {
      const context = await browser.newContext();
      await context.addCookies(
        jar.entries().map(([name, value]) => ({ name, value, url: publicOrigin })),
      );
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto(publicOrigin);
      const registration = await page.evaluate(async () => {
        const optionsResponse = await fetch(
          '/api/auth/passkey/generate-register-options?name=Test%20Key',
          { credentials: 'include' },
        );
        const options = await optionsResponse.json();
        const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
        const credential = (await navigator.credentials.create({
          publicKey,
        })) as PublicKeyCredential | null;
        if (!credential) throw new Error('virtual authenticator omitted registration credential');
        const response = credential.toJSON();
        const verified = await fetch('/api/auth/passkey/verify-registration', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response, name: 'Test Key' }),
        });
        const replay = await fetch('/api/auth/passkey/verify-registration', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response, name: 'Test Key' }),
        });
        return {
          optionsStatus: optionsResponse.status,
          rpId: options.rp?.id,
          verifiedStatus: verified.status,
          replayStatus: replay.status,
        };
      });
      assert.deepEqual(
        registration,
        { optionsStatus: 200, rpId: 'localhost', verifiedStatus: 200, replayStatus: 400 },
        'passkey registration and challenge replay contract',
      );
      await context.clearCookies();
      const authentication = await page.evaluate(async () => {
        const optionsResponse = await fetch('/api/auth/passkey/generate-authenticate-options', {
          credentials: 'include',
        });
        const options = await optionsResponse.json();
        const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
        const credential = (await navigator.credentials.get({
          publicKey,
        })) as PublicKeyCredential | null;
        if (!credential) throw new Error('virtual authenticator omitted authentication credential');
        const response = credential.toJSON();
        const verified = await fetch('/api/auth/passkey/verify-authentication', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response }),
        });
        const replay = await fetch('/api/auth/passkey/verify-authentication', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response }),
        });
        const session = await fetch('/api/auth/get-session', { credentials: 'include' });
        const sessionBody = await session.json();
        const wrongOptionsResponse = await fetch(
          '/api/auth/passkey/generate-authenticate-options',
          { credentials: 'include' },
        );
        const wrongOptions = await wrongOptionsResponse.json();
        const wrongPublicKey = PublicKeyCredential.parseRequestOptionsFromJSON(wrongOptions);
        const wrongCredential = (await navigator.credentials.get({
          publicKey: wrongPublicKey,
        })) as PublicKeyCredential | null;
        if (!wrongCredential)
          throw new Error('virtual authenticator omitted wrong-origin credential');
        const altered = structuredClone(wrongCredential.toJSON()) as {
          response: { clientDataJSON: string };
        };
        const encoded = altered.response.clientDataJSON.replace(/-/g, '+').replace(/_/g, '/');
        const client = JSON.parse(atob(encoded)) as Record<string, unknown>;
        client.origin = 'http://evil.invalid';
        altered.response.clientDataJSON = btoa(JSON.stringify(client))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const wrongOrigin = await fetch('/api/auth/passkey/verify-authentication', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response: altered }),
        });
        return {
          optionsStatus: optionsResponse.status,
          verifiedStatus: verified.status,
          replayStatus: replay.status,
          sessionStatus: session.status,
          hasUser: Boolean(sessionBody?.user),
          wrongOriginStatus: wrongOrigin.status,
        };
      });
      assert.equal(authentication.optionsStatus, 200, 'passkey authentication options returned');
      assert.equal(authentication.verifiedStatus, 200, 'passkey authentication accepted');
      assert.equal(
        authentication.replayStatus,
        400,
        'passkey authentication challenge replay denied',
      );
      assert.equal(
        authentication.sessionStatus,
        200,
        'passkey authentication session endpoint returned',
      );
      assert.equal(authentication.hasUser, true, 'passkey authentication established session');
      assert.ok(authentication.wrongOriginStatus >= 400, 'passkey wrong-origin client data denied');
      await cdp.detach();
      await context.close();
    } finally {
      await browser.close();
    }
    const enabled = await post(jar, '/api/auth/two-factor/enable', { password });
    assert.equal(enabled.status, 200, 'TOTP enrollment enabled');
    const enrollment = (await enabled.json()) as { totpURI?: string; backupCodes?: string[] };
    assert.ok(
      enrollment.totpURI && enrollment.backupCodes?.[0],
      'TOTP enrollment returns only required setup material',
    );
    await expectStatus(
      'TOTP enrollment verified',
      post(jar, '/api/auth/two-factor/verify-totp', {
        code: totp(enrollment.totpURI),
        trustDevice: false,
      }),
      200,
    );
    await expectStatus(
      'logout before two-factor sign-in',
      post(jar, '/api/auth/sign-out', {}),
      200,
    );
    const challenge = await post(jar, '/api/auth/sign-in/email', { email, password });
    assert.equal(challenge.status, 200, 'password sign-in creates two-factor challenge');
    const challengeBody = (await challenge.json()) as { twoFactorRedirect?: boolean };
    assert.equal(challengeBody.twoFactorRedirect, true, 'two-factor challenge required');
    await expectStatus(
      'TOTP challenge accepted',
      post(jar, '/api/auth/two-factor/verify-totp', {
        code: totp(enrollment.totpURI),
        trustDevice: false,
      }),
      200,
    );
    await expectStatus(
      'logout before recovery-code challenge',
      post(jar, '/api/auth/sign-out', {}),
      200,
    );
    await expectStatus(
      'password creates recovery-code challenge',
      post(jar, '/api/auth/sign-in/email', { email, password }),
      200,
    );
    await expectStatus(
      'recovery code accepted once',
      post(jar, '/api/auth/two-factor/verify-backup-code', {
        code: enrollment.backupCodes![0],
        trustDevice: false,
      }),
      200,
    );
    await expectStatus(
      'logout before recovery-code replay',
      post(jar, '/api/auth/sign-out', {}),
      200,
    );
    await expectStatus(
      'password creates replay challenge',
      post(jar, '/api/auth/sign-in/email', { email, password }),
      200,
    );
    const replay = await post(jar, '/api/auth/two-factor/verify-backup-code', {
      code: enrollment.backupCodes![0],
      trustDevice: false,
    });
    assert.ok([401, 409].includes(replay.status), 'recovery code replay denied');
    await database.query(
      'delete from "session" where "userId"=(select id from "user" where email=$1)',
      [email],
    );
    const sessions = await database.query<{ count: string }>(
      'select count(*)::text as count from "session" where "userId"=(select id from "user" where email=$1)',
      [email],
    );
    assert.equal(sessions.rows[0]?.count, '0', 'revocation removes session row');
    await expectNoSession('revoked session is anonymous', jar.fetch('/api/auth/get-session'));
    await expectStatus(
      'login restored after revocation',
      post(jar, '/api/auth/sign-in/email', { email, password }),
      200,
    );
    await recovery('disable-user', email);
    await expectNoSession(
      'disabled account session is anonymous',
      jar.fetch('/api/auth/get-session'),
    );
    const afterDisable = await database.query<{ count: string }>(
      'select count(*)::text as count from "session" where "userId"=(select id from "user" where email=$1)',
      [email],
    );
    assert.equal(afterDisable.rows[0]?.count, '0', 'disable revokes every session row');
    await expectStatus(
      'disabled account cannot sign in',
      post(new CookieJar(), '/api/auth/sign-in/email', { email, password }),
      403,
    );
    await recovery('enable-user', email);
    await expectNoSession(
      'enable does not resurrect a session',
      jar.fetch('/api/auth/get-session'),
    );
    await expectStatus('logout accepted', post(jar, '/api/auth/sign-out', {}), 200);
    // This in-memory limiter is deliberately exercised last: foreign-origin rejection above did
    // not consume it, and no later auth flow needs to share its synthetic client bucket.
    for (let index = 0; index < 11; index++) {
      const response = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          host: publicHost,
          origin: publicOrigin,
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${index}`,
        },
        body: JSON.stringify({ email, password: 'wrong-password-value' }),
      });
      if (index === 10)
        assert.equal(response.status, 429, 'spoofed XFF does not bypass sign-in rate limit');
    }
  } finally {
    await database.end();
  }
});
