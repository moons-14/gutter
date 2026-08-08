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

export const schemaVersion = '0004_page_validation';

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
