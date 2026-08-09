import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export async function secret(name: string): Promise<string> {
  const direct = process.env[name];
  const file = process.env[`${name}_FILE`];
  const hasDirect = Boolean(direct?.trim());
  const hasFile = Boolean(file?.trim());

  if (hasDirect === hasFile) {
    throw new Error(`Define exactly one of ${name} or ${name}_FILE`);
  }

  if (hasDirect) {
    return direct as string;
  }

  try {
    const contents = await (await import('node:fs/promises')).readFile(file as string, 'utf8');
    const trimmed = contents.trim();
    if (trimmed) return trimmed;
  } catch {
    // Never include a secret value or secret-file path in configuration errors.
  }

  throw new Error(`${name}_FILE must reference a readable non-empty file`);
}

export async function databaseUrl(): Promise<string> {
  return z
    .string()
    .url()
    .parse(await secret('DATABASE_URL'));
}

/** Authentication is intentionally local-only: an explicit public origin and file-backed secret are required. */
export async function authConfig(): Promise<
  Readonly<{
    secret: string;
    origin: string;
    trustedProxies: readonly string[];
    secureCookies: boolean;
  }>
> {
  const origin = z
    .string()
    .url()
    .parse(process.env.GUTTER_AUTH_ORIGIN ?? 'http://localhost:8080');
  const url = new URL(origin);
  if (url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol))
    throw new Error('GUTTER_AUTH_ORIGIN must be an origin URL');
  let trustedProxies: unknown;
  try {
    trustedProxies = JSON.parse(process.env.GUTTER_AUTH_TRUSTED_PROXIES_JSON ?? '[]');
  } catch {
    throw new Error('invalid GUTTER_AUTH_TRUSTED_PROXIES_JSON');
  }
  const proxies = z.array(z.string().min(1).max(128)).max(16).safeParse(trustedProxies);
  if (!proxies.success) throw new Error('invalid GUTTER_AUTH_TRUSTED_PROXIES_JSON');
  const localhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !localhost)
    throw new Error('GUTTER_AUTH_ORIGIN must use https outside localhost');
  return {
    secret: await secret('BETTER_AUTH_SECRET'),
    origin: url.origin,
    trustedProxies: proxies.data,
    secureCookies: url.protocol === 'https:',
  };
}

export function allowedRootsJson(): string {
  return process.env.GUTTER_ALLOWED_ROOTS_JSON ?? '[]';
}

/** Disposable worker-local bytes; this is deliberately not database configuration. */
export function derivedCacheConfig(): Readonly<{ root: string; quotaBytes: number }> {
  const root = z
    .string()
    .min(1)
    .safeParse(process.env.GUTTER_DERIVED_CACHE_ROOT ?? '/cache/derived');
  const quota = z.coerce
    .number()
    .int()
    .min(1)
    .max(50_000_000_000)
    .safeParse(process.env.GUTTER_DERIVED_CACHE_QUOTA_BYTES ?? '10737418240');
  if (!root.success || !root.data.startsWith('/'))
    throw new Error('GUTTER_DERIVED_CACHE_ROOT must be an absolute path');
  if (!quota.success) throw new Error('GUTTER_DERIVED_CACHE_QUOTA_BYTES must be 1..50000000000');
  return { root: root.data, quotaBytes: quota.data };
}

export const schemaVersion = '0008_auth_foundation';

/** Local sidecars only; the worker never accepts a provider endpoint from a job payload. */
export type MetadataSidecar = Readonly<{
  id: string;
  endpoint: string;
  token: string;
  priority: number;
  order: number;
}>;

export type MetadataProviderConfig = Readonly<{
  timeoutMs: number;
  retries: number;
  concurrency: number;
  payloadBytes: number;
  sidecars: readonly MetadataSidecar[];
}>;

/** Resolve both paths before reading so a secret mount cannot be escaped by traversal or symlink. */
export async function sidecarToken(
  tokenFile: string,
  secretsDirectory = '/run/secrets',
): Promise<string> {
  try {
    const root = await realpath(secretsDirectory);
    const candidate = await realpath(tokenFile);
    const pathFromRoot = relative(root, candidate);
    if (
      !pathFromRoot ||
      pathFromRoot === '..' ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    )
      throw new Error('outside_secrets');
    const token = (await readFile(candidate, 'utf8')).trim();
    if (token) return token;
  } catch {
    // Never include a token or secret-file path in configuration errors.
  }
  throw new Error('invalid GUTTER_METADATA_SIDECARS_JSON');
}

/**
 * Sidecars are worker-owned Compose services: their internal HTTP endpoints and mounted token
 * files are configured once at startup, never accepted from a queued lookup payload.
 */
export async function metadataProviderConfig(): Promise<MetadataProviderConfig> {
  const values = {
    timeoutMs: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .safeParse(process.env.GUTTER_METADATA_TIMEOUT_MS ?? '5000'),
    retries: z.coerce
      .number()
      .int()
      .min(0)
      .max(3)
      .safeParse(process.env.GUTTER_METADATA_RETRIES ?? '1'),
    concurrency: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .safeParse(process.env.GUTTER_METADATA_CONCURRENCY ?? '2'),
    payloadBytes: z.coerce
      .number()
      .int()
      .min(1024)
      .max(1_000_000)
      .safeParse(process.env.GUTTER_METADATA_PAYLOAD_BYTES ?? '65536'),
  };
  if (
    !values.timeoutMs.success ||
    !values.retries.success ||
    !values.concurrency.success ||
    !values.payloadBytes.success
  )
    throw new Error('invalid GUTTER_METADATA_* bounds');
  let rawSidecars: unknown;
  try {
    rawSidecars = JSON.parse(process.env.GUTTER_METADATA_SIDECARS_JSON ?? '[]');
  } catch {
    throw new Error('invalid GUTTER_METADATA_SIDECARS_JSON');
  }
  const parsed = z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
          endpoint: z.string().url(),
          'token-file': z.string().startsWith('/run/secrets/').min('/run/secrets/x'.length),
          priority: z.number().int(),
          order: z.number().int().min(0),
        })
        .strict(),
    )
    .safeParse(rawSidecars);
  if (!parsed.success) throw new Error('invalid GUTTER_METADATA_SIDECARS_JSON');
  const seen = new Set<string>();
  const sidecars: MetadataSidecar[] = [];
  for (const entry of parsed.data) {
    const endpoint = new URL(entry.endpoint);
    if (
      endpoint.protocol !== 'http:' ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash ||
      seen.has(entry.id)
    )
      throw new Error('invalid GUTTER_METADATA_SIDECARS_JSON');
    seen.add(entry.id);
    const token = await sidecarToken(entry['token-file']);
    sidecars.push({
      id: entry.id,
      endpoint: endpoint.toString(),
      token,
      priority: entry.priority,
      order: entry.order,
    });
  }
  return {
    timeoutMs: values.timeoutMs.data,
    retries: values.retries.data,
    concurrency: values.concurrency.data,
    payloadBytes: values.payloadBytes.data,
    sidecars,
  };
}

/** Reconciliation is deliberately durable DB state, not a pg-boss cron schedule. */
export function reconciliationConfig(): Readonly<{
  intervalSeconds: number;
  stableGraceMs: number;
}> {
  const interval = z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .safeParse(process.env.GUTTER_RECONCILIATION_INTERVAL_SECONDS ?? '900');
  const grace = z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .safeParse(process.env.GUTTER_STABLE_GRACE_MS ?? '2000');
  if (!interval.success)
    throw new Error('GUTTER_RECONCILIATION_INTERVAL_SECONDS must be 60..86400');
  if (!grace.success) throw new Error('GUTTER_STABLE_GRACE_MS must be 0..60000');
  return { intervalSeconds: interval.data, stableGraceMs: grace.data };
}

export function watcherHintsConfig(): Readonly<{ enabled: boolean; debounceMs: number }> {
  const enabled = z
    .enum(['true', 'false'])
    .safeParse(process.env.GUTTER_WATCHER_HINTS_ENABLED ?? 'false');
  const debounce = z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .safeParse(process.env.GUTTER_WATCHER_HINT_DEBOUNCE_MS ?? '5000');
  if (!enabled.success) throw new Error('GUTTER_WATCHER_HINTS_ENABLED must be true or false');
  if (!debounce.success) throw new Error('GUTTER_WATCHER_HINT_DEBOUNCE_MS must be 100..60000');
  return { enabled: enabled.data === 'true', debounceMs: debounce.data };
}

/** Bounded worker-only deadlines; values are deliberately not accepted from job payloads. */
export function validationTimeouts(): Readonly<{ itemMs: number }> {
  const parsed = z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .safeParse(process.env.GUTTER_VALIDATION_ITEM_TIMEOUT_MS ?? '900000');
  if (!parsed.success) throw new Error('GUTTER_VALIDATION_ITEM_TIMEOUT_MS must be 1000..3600000');
  return { itemMs: parsed.data };
}
