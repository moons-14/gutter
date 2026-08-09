import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lookupSidecar,
  mergeCandidates,
  metadataProtocolVersion,
  validLookupResponse,
} from '../packages/metadata-provider/src/index.ts';
import { sidecarToken } from '../packages/config/src/index.ts';
import { dispatchConfiguredSidecars } from '../apps/worker/src/metadata-dispatcher.ts';

const request = { version: metadataProtocolVersion, canonicalIdentity: 'a'.repeat(64), searchTerms: ['title'], publicIds: [] } as const;
const candidate = { providerId: 'sidecar', values: { title: 'Title' }, provenance: { title: 'sidecar' } };

function mockFetch(respond: (url: URL) => Response): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => respond(new URL(String(input)));
  return () => { globalThis.fetch = previous; };
}

test('metadata provider rejects incompatible capabilities and bounds every response body', async () => {
  let restore = mockFetch((url) => new Response(JSON.stringify(url.pathname === '/v1/health' ? {} : { version: 999 })));
  await assert.rejects(lookupSidecar('http://metadata-sidecar', request, { token: 'token', timeoutMs: 1000, payloadBytes: 1024 }), /sidecar_incompatible/);
  restore();

  restore = mockFetch(() => new Response('x'.repeat(512)));
  await assert.rejects(lookupSidecar('http://metadata-sidecar', request, { token: 'token', timeoutMs: 1000, payloadBytes: 256 }), /sidecar_payload_too_large/);
  restore();
});

test('metadata provider rejects malformed candidates and an already-aborted request never fetches', async () => {
  assert.equal(validLookupResponse({ version: 1, candidates: [{ ...candidate, values: [] }] }), false);
  assert.equal(validLookupResponse({ version: 1, candidates: [{ ...candidate, provenance: JSON.parse('{"__proto__":"unsafe"}') }] }), false);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const restore = mockFetch(() => { throw new Error('must not fetch'); });
  await assert.rejects(lookupSidecar('http://metadata-sidecar', request, { token: 'token', timeoutMs: 1000, payloadBytes: 1024, signal: controller.signal }), /cancelled/);
  restore();
});

test('metadata provider rejects invalid or extra request fields before fetch', async () => {
  let fetches = 0;
  const restore = mockFetch(() => { fetches++; throw new Error('must not fetch'); });
  await assert.rejects(lookupSidecar('http://metadata-sidecar', { ...request, canonicalIdentity: 'A'.repeat(64) }, { token: 'token', timeoutMs: 1000, payloadBytes: 1024 }), /invalid_lookup_request/);
  await assert.rejects(lookupSidecar('http://metadata-sidecar', { ...request, searchTerms: ['../../private'] }, { token: 'token', timeoutMs: 1000, payloadBytes: 1024 }), /invalid_lookup_request/);
  await assert.rejects(lookupSidecar('http://metadata-sidecar', { ...request, extra: true } as typeof request, { token: 'token', timeoutMs: 1000, payloadBytes: 1024 }), /invalid_lookup_request/);
  assert.equal(fetches, 0);
  restore();
});

test('metadata provider cancels oversized streams and non-OK bodies', async () => {
  let cancelled = false;
  let restore = mockFetch((url) => {
    if (url.pathname === '/v1/health') return new Response(null);
    if (url.pathname === '/v1/capabilities') return new Response(JSON.stringify({ version: 1 }));
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(300)); }, cancel() { cancelled = true; } }));
  });
  await assert.rejects(lookupSidecar('http://metadata-sidecar', request, { token: 'token', timeoutMs: 1000, payloadBytes: 256 }), /sidecar_payload_too_large/);
  assert.equal(cancelled, true);
  restore();

  cancelled = false;
  restore = mockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }));
  await assert.rejects(lookupSidecar('http://metadata-sidecar', request, { token: 'token', timeoutMs: 1000, payloadBytes: 1024 }), /sidecar_unavailable/);
  assert.equal(cancelled, true);
  restore();
});

test('sidecar token paths stay inside the canonical secrets directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gutter-secrets-'));
  const secrets = join(directory, 'secrets');
  const prefixedSecrets = join(directory, 'secrets-other');
  const outside = join(directory, 'outside-token');
  await mkdir(secrets);
  await mkdir(prefixedSecrets);
  await writeFile(join(secrets, 'token'), 'token\n');
  await writeFile(join(prefixedSecrets, 'token'), 'prefixed\n');
  await writeFile(outside, 'outside\n');
  await symlink(outside, join(secrets, 'escape'));
  assert.equal(await sidecarToken(join(secrets, 'token'), secrets), 'token');
  await assert.rejects(sidecarToken(join(secrets, '..', 'outside-token'), secrets), /invalid GUTTER_METADATA_SIDECARS_JSON/);
  await assert.rejects(sidecarToken(join(prefixedSecrets, 'token'), secrets), /invalid GUTTER_METADATA_SIDECARS_JSON/);
  await assert.rejects(sidecarToken(join(secrets, 'escape'), secrets), /invalid GUTTER_METADATA_SIDECARS_JSON/);
});

test('dispatcher retries only until abort and bounds all sidecars', async () => {
  const config = { timeoutMs: 1000, retries: 2, concurrency: 2, payloadBytes: 1024, sidecars: [
    { id: 'one', endpoint: 'http://one/', token: 'one', priority: 1, order: 0 },
    { id: 'two', endpoint: 'http://two/', token: 'two', priority: 2, order: 1 },
    { id: 'three', endpoint: 'http://three/', token: 'three', priority: 3, order: 2 },
  ] } as const;
  const abort = new AbortController();
  let attempts = 0;
  await assert.rejects(dispatchConfiguredSidecars({ ...config, sidecars: [config.sidecars[0]] }, 'root', request.canonicalIdentity, request, abort.signal, async () => {
    attempts++; abort.abort(new Error('stop')); throw abort.signal.reason;
  }, async () => undefined), /stop/);
  assert.equal(attempts, 1);

  let active = 0;
  let maximum = 0;
  const recorded: unknown[] = [];
  await dispatchConfiguredSidecars(config, 'root', request.canonicalIdentity, request, undefined, async (endpoint) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, endpoint.includes('one') ? 20 : 1));
    active--;
    return { version: 1, candidates: [{ ...candidate, providerId: 'untrusted' }] };
  }, async (_root, _identity, value) => { recorded.push(value); });
  assert.equal(maximum, 2);
  assert.deepEqual(recorded.map((value: any) => value.providerId).sort(), ['one', 'three', 'two']);
  assert.equal(mergeCandidates(recorded as any).values.title, 'Title');
});

test('metadata precedence is stable and null or malformed values never erase a selected field', () => {
  const merged = mergeCandidates([
    { providerId: 'later', providerPriority: 2, configOrder: 0, values: { title: 'later', keep: null }, provenance: { title: 'later' } },
    { providerId: 'first', providerPriority: 1, configOrder: 1, values: { title: 'first', keep: 'kept' }, provenance: { title: 'first', keep: 'first' } },
    { providerId: 'tie-break', providerPriority: 1, configOrder: 2, values: { title: 'ignored', keep: 'ignored' }, provenance: {} },
  ]);
  assert.deepEqual(merged, { values: { title: 'first', keep: 'kept' }, provenance: { title: 'first', keep: 'first' } });
});
