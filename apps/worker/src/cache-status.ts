import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { W_OK } from 'node:constants';
import { join } from 'node:path';

const stateName = '.operator-status.json';
type AdvisoryState = Readonly<{
  hits: number;
  misses: number;
  evictions: number;
  failures: number;
  lastGcAt: string | null;
}>;

const emptyState = (): AdvisoryState => ({
  hits: 0,
  misses: 0,
  evictions: 0,
  failures: 0,
  lastGcAt: null,
});

async function safeRoot(root: string, create = false): Promise<boolean> {
  if (create) await mkdir(root, { recursive: true });
  try {
    const details = await lstat(root);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error('unsafe_cache_status_root');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Readiness is strict about the disposable cache: it must already be a writable directory. */
export async function assertCacheReady(root: string): Promise<void> {
  const details = await lstat(root).catch(() => null);
  if (!details || details.isSymbolicLink() || !details.isDirectory())
    throw new Error('cache_root_missing_or_not_directory');
  await access(root, W_OK);
  const probe = join(root, `.readiness-${process.pid}`);
  await writeFile(probe, 'ready', { flag: 'wx', mode: 0o600 });
  await unlink(probe);
}

async function bytesAt(path: string): Promise<number> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) return 0;
  if (details.isFile()) return Number(details.size);
  if (!details.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path)) total += await bytesAt(join(path, name));
  return total;
}

async function state(root: string): Promise<AdvisoryState> {
  try {
    const parsed = JSON.parse(await readFile(join(root, stateName), 'utf8')) as AdvisoryState;
    if (
      [parsed.hits, parsed.misses, parsed.evictions, parsed.failures].every(Number.isSafeInteger) &&
      (parsed.lastGcAt === null || typeof parsed.lastGcAt === 'string')
    )
      return parsed;
  } catch {
    // Advisory state is disposable, just like the cache itself.
  }
  return emptyState();
}

export async function cacheStatus(
  root: string,
  quotaBytes: number,
): Promise<
  AdvisoryState & {
    root: string;
    quotaBytes: number;
    usedBytes: number;
    fsAuthoritative: true;
    advisory: true;
  }
> {
  let usedBytes = 0;
  if (await safeRoot(root)) {
    for (const name of await readdir(root))
      if (name !== stateName) usedBytes += await bytesAt(join(root, name));
  }
  const current = (await safeRoot(root)) ? await state(root) : emptyState();
  return {
    ...current,
    root,
    quotaBytes,
    usedBytes,
    fsAuthoritative: true,
    advisory: true,
  };
}

export async function recordCacheStatus(
  root: string,
  event: 'hit' | 'miss' | 'failure' | 'gc',
  evictions = 0,
): Promise<void> {
  await safeRoot(root, true);
  const previous = await state(root);
  const next: AdvisoryState = {
    hits: previous.hits + Number(event === 'hit'),
    misses: previous.misses + Number(event === 'miss'),
    evictions: previous.evictions + evictions,
    failures: previous.failures + Number(event === 'failure'),
    lastGcAt: event === 'gc' ? new Date().toISOString() : previous.lastGcAt,
  };
  const temporary = join(root, `${stateName}.tmp-${process.pid}`);
  await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await rename(temporary, join(root, stateName));
}
