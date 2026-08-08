import { z } from 'zod';

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

export function allowedRootsJson(): string {
  return process.env.GUTTER_ALLOWED_ROOTS_JSON ?? '[]';
}

export const schemaVersion = '0006_catalog_domain';

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
