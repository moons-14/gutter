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

export const schemaVersion = '0001_library_roots';
