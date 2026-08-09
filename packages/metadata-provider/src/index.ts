/** Versioned, dependency-free sidecar wire contract. */
export const metadataProtocolVersion = 1 as const;
export type MetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly MetadataValue[]
  | { readonly [key: string]: MetadataValue };
export type LookupRequest = Readonly<{
  version: typeof metadataProtocolVersion;
  canonicalIdentity: string;
  searchTerms: readonly string[];
  publicIds: readonly string[];
}>;
export type LookupResponse = Readonly<{
  version: typeof metadataProtocolVersion;
  candidates: readonly Readonly<{
    providerId: string;
    values: Readonly<Record<string, MetadataValue>>;
    provenance: Readonly<Record<string, string>>;
  }>[];
}>;
export type ProtocolError = Readonly<{
  version: typeof metadataProtocolVersion;
  code: 'invalid_request' | 'unavailable' | 'timeout' | 'internal_error';
  message: string;
}>;
export type Candidate = Readonly<{
  providerId: string;
  providerPriority: number;
  configOrder: number;
  values: Readonly<Record<string, MetadataValue>>;
  provenance: Readonly<Record<string, string>>;
}>;
export type MergedMetadata = Readonly<{
  values: Readonly<Record<string, MetadataValue>>;
  provenance: Readonly<Record<string, string>>;
}>;

const dangerousKey = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeRecord(
  value: unknown,
  leaf: (entry: unknown) => boolean,
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    Object.keys(value).every((key) => !dangerousKey.has(key) && leaf(value[key]))
  );
}

function validMetadataValue(value: unknown): value is MetadataValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validMetadataValue);
  return safeRecord(value, validMetadataValue);
}

export function validLookupRequest(value: unknown): value is LookupRequest {
  if (!isPlainRecord(value)) return false;
  const v = value;
  if (
    Object.keys(v).length !== 4 ||
    !['version', 'canonicalIdentity', 'searchTerms', 'publicIds'].every((key) => key in v)
  )
    return false;
  return (
    v.version === metadataProtocolVersion &&
    typeof v.canonicalIdentity === 'string' &&
    /^[0-9a-f]{64}$/.test(v.canonicalIdentity) &&
    Array.isArray(v.searchTerms) &&
    v.searchTerms.length <= 8 &&
    v.searchTerms.every(
      (x) => typeof x === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} .,'’!&:;()/_-]{0,127}$/u.test(x),
    ) &&
    Array.isArray(v.publicIds) &&
    v.publicIds.length <= 8 &&
    v.publicIds.every(
      (x) =>
        typeof x === 'string' &&
        /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(x),
    )
  );
}
export function validLookupResponse(value: unknown): value is LookupResponse {
  if (!isPlainRecord(value)) return false;
  const v = value;
  return (
    v.version === metadataProtocolVersion &&
    Array.isArray(v.candidates) &&
    v.candidates.every((candidate) => {
      if (!isPlainRecord(candidate)) return false;
      return (
        typeof candidate.providerId === 'string' &&
        /^[a-z][a-z0-9_-]{0,62}$/.test(candidate.providerId) &&
        safeRecord(candidate.values, validMetadataValue) &&
        safeRecord(candidate.provenance, (provenance) => typeof provenance === 'string')
      );
    })
  );
}

/** Runtime guard for the only durable provider-observation write boundary. */
export function validCandidate(value: unknown): value is Candidate {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.providerId === 'string' &&
    /^[a-z][a-z0-9_-]{0,62}$/.test(value.providerId) &&
    typeof value.providerPriority === 'number' &&
    Number.isInteger(value.providerPriority) &&
    typeof value.configOrder === 'number' &&
    Number.isInteger(value.configOrder) &&
    value.configOrder >= 0 &&
    safeRecord(value.values, validMetadataValue) &&
    safeRecord(value.provenance, (provenance) => typeof provenance === 'string')
  );
}

async function boundedJson(response: Response, payloadBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > payloadBytes)) {
    await response.body?.cancel();
    throw new Error('sidecar_payload_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_sidecar_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > payloadBytes) {
        await reader.cancel();
        throw new Error('sidecar_payload_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_sidecar_response');
  }
}
/** The worker-side-only HTTP client enforces the sidecar capability/health handshake and bounds. */
export async function lookupSidecar(
  endpoint: string,
  request: LookupRequest,
  options: Readonly<{
    token: string;
    timeoutMs: number;
    payloadBytes: number;
    signal?: AbortSignal;
  }>,
): Promise<LookupResponse> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('sidecar_aborted');
  if (!validLookupRequest(request)) throw new Error('invalid_lookup_request');
  const payload = JSON.stringify({
    version: request.version,
    canonicalIdentity: request.canonicalIdentity,
    searchTerms: [...request.searchTerms],
    publicIds: [...request.publicIds],
  });
  if (new TextEncoder().encode(payload).byteLength > options.payloadBytes)
    throw new Error('invalid_lookup_request');
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    throw new Error('invalid_sidecar_endpoint');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const headers = {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
    };
    const health = await fetch(new URL('/v1/health', base), { headers, signal: controller.signal });
    if (!health.ok) {
      await health.body?.cancel();
      throw new Error('sidecar_unavailable');
    }
    await health.body?.cancel();
    const capability = await fetch(new URL('/v1/capabilities', base), {
      headers,
      signal: controller.signal,
    });
    if (!capability.ok) {
      await capability.body?.cancel();
      throw new Error('sidecar_incompatible');
    }
    const capabilities = await boundedJson(capability, options.payloadBytes);
    if (!isPlainRecord(capabilities) || capabilities.version !== metadataProtocolVersion)
      throw new Error('sidecar_incompatible');
    const response = await fetch(new URL('/v1/lookup', base), {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('sidecar_lookup_failed');
    }
    const parsed = await boundedJson(response, options.payloadBytes);
    if (!validLookupResponse(parsed)) throw new Error('invalid_sidecar_response');
    return parsed;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Field selection is deterministic; null and malformed values never replace prior values. */
export function mergeCandidates(
  candidates: readonly Candidate[],
  approved?: MergedMetadata | null,
): MergedMetadata {
  const values: Record<string, MetadataValue> = { ...(approved?.values ?? {}) };
  const provenance: Record<string, string> = { ...(approved?.provenance ?? {}) };
  for (const candidate of [...candidates].sort(
    (a, b) =>
      a.providerPriority - b.providerPriority ||
      a.configOrder - b.configOrder ||
      a.providerId.localeCompare(b.providerId),
  )) {
    for (const [field, value] of Object.entries(candidate.values)) {
      if (field in values || value === null || !isMetadataValue(value)) continue;
      values[field] = value;
      provenance[field] = candidate.provenance[field] ?? candidate.providerId;
    }
  }
  return { values, provenance };
}
function isMetadataValue(value: unknown): value is MetadataValue {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isMetadataValue);
  return safeRecord(value, isMetadataValue);
}
