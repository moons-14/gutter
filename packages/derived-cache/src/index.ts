import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

/** The cache is disposable: its descriptor is the complete source-derived identity.
 * Root-wide maps coordinate cache instances in this worker process only; durable cross-process
 * coordination is intentionally outside this package. */
export type CacheDescriptor = Readonly<{
  source: Readonly<{ root: string; item: string; observation: unknown }>;
  manifestGeneration: string | number;
  validationGeneration: string | number;
  locator: string;
  pageObservation: unknown;
  params?: Readonly<Record<string, never>>;
  mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  implementationVersion: string;
}>;
export type CacheProducer = (
  signal?: AbortSignal,
) => Promise<
  | Readable
  | Buffer
  | Uint8Array
  | { body: Readable | Buffer | Uint8Array; mimeType?: CacheDescriptor['mimeType'] }
>;
export type CacheEntry = Readonly<{
  key: string;
  body: Buffer;
  mimeType: CacheDescriptor['mimeType'];
  hit: boolean;
}>;
export type CacheLease = CacheEntry & Readonly<{ release(): void }>;
export type DerivedCacheOptions = Readonly<{
  root: string;
  quotaBytes?: number;
  maxEntryBytes?: number;
  maxQueue?: number;
  /** Injectable for deterministic tests. */
  capacityBytes?: () => Promise<number>;
  now?: () => number;
  staleStagingMs?: number;
}>;

export const defaultCacheLimits = { maxEntryBytes: 128 * 1024 * 1024, maxQueue: 8 } as const;
export class DerivedCacheError extends Error {
  override readonly name = 'DerivedCacheError';
  constructor(readonly code: 'cancelled' | 'entry_too_large' | 'queue_full' | 'unsafe_cache') {
    super(code);
  }
}

const allowedMime = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const rootLocks = new Map<string, Promise<void>>();
const activeStagingByRoot = new Map<string, Set<string>>();
const runningByRootKey = new Map<string, Promise<CacheEntry>>();
const leasesByRootKey = new Map<string, number>();

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new DerivedCacheError('unsafe_cache');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      if (!(index in value)) throw new DerivedCacheError('unsafe_cache');
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new DerivedCacheError('unsafe_cache');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}
export function cacheIdentity(descriptor: CacheDescriptor): { key: string; canonicalJson: string } {
  if (
    !allowedMime.has(descriptor.mimeType) ||
    (descriptor.params && Object.keys(descriptor.params).length)
  )
    throw new DerivedCacheError('unsafe_cache');
  const normalized = { ...descriptor, params: {} };
  const canonicalJson = canonical(normalized);
  return { canonicalJson, key: createHash('sha256').update(canonicalJson).digest('hex') };
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DerivedCacheError('cancelled');
}
async function noSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new DerivedCacheError('unsafe_cache');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function writeNoFollow(path: string, body: string | Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readBounded(
  input: Awaited<ReturnType<CacheProducer>>,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const value = input && typeof input === 'object' && 'body' in input ? input.body : input;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length > maximum) throw new DerivedCacheError('entry_too_large');
    return Buffer.from(value);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of value as Readable) {
    aborted(signal);
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) {
      (value as Readable).destroy();
      throw new DerivedCacheError('entry_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class DerivedCache {
  readonly root: string;
  readonly maxEntryBytes: number;
  readonly maxQueue: number;
  readonly quotaBytes?: number;
  readonly #capacity: () => Promise<number>;
  readonly #now: () => number;
  readonly #staleStagingMs: number;
  #queued = 0;
  constructor(options: DerivedCacheOptions) {
    this.root = resolve(options.root);
    this.maxEntryBytes = options.maxEntryBytes ?? defaultCacheLimits.maxEntryBytes;
    this.maxQueue = options.maxQueue ?? defaultCacheLimits.maxQueue;
    this.quotaBytes = options.quotaBytes;
    this.#now = options.now ?? Date.now;
    this.#staleStagingMs = options.staleStagingMs ?? 60_000;
    this.#capacity =
      options.capacityBytes ??
      (async () => {
        const info = await statfs(this.root);
        return Math.min(
          Math.floor((Number(info.blocks) * Number(info.bsize)) / 10),
          50_000_000_000,
        );
      });
  }
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DerivedCacheError('unsafe_cache');
    return join(this.root, key.slice(0, 2), key);
  }
  private leaseKey(key: string): string {
    return `${this.root}\0${key}`;
  }
  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await noSymlink(this.root);
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!name.startsWith('.staging-')) continue;
      const path = join(this.root, name);
      if (activeStagingByRoot.get(this.root)?.has(path)) continue;
      try {
        const details = await lstat(path);
        if (!details.isDirectory() || this.#now() - details.mtimeMs >= this.#staleStagingMs)
          await rm(path, { recursive: true, force: true });
      } catch {
        /* raced with recovery */
      }
    }
  }
  private async valid(key: string, canonicalJson?: string): Promise<CacheEntry | null> {
    const dir = this.path(key);
    const manifestPath = join(dir, 'manifest.json');
    const bodyPath = join(dir, 'body');
    try {
      await noSymlink(join(this.root, key.slice(0, 2)));
      await noSymlink(dir);
      await noSymlink(manifestPath);
      await noSymlink(bodyPath);
      const manifest = JSON.parse((await readNoFollow(manifestPath)).toString('utf8')) as {
        key: string;
        canonicalJson: string;
        sha256: string;
        mimeType: CacheDescriptor['mimeType'];
        bytes: number;
        created: number;
      };
      const body = await readNoFollow(bodyPath);
      const digest = createHash('sha256').update(body).digest('hex');
      if (
        manifest.key !== key ||
        (canonicalJson !== undefined && manifest.canonicalJson !== canonicalJson) ||
        manifest.bytes !== body.length ||
        !Number.isSafeInteger(manifest.bytes) ||
        !Number.isFinite(manifest.created) ||
        manifest.sha256 !== digest ||
        !allowedMime.has(manifest.mimeType)
      )
        throw new Error('invalid');
      return { key, body, mimeType: manifest.mimeType, hit: true };
    } catch (error) {
      if (error instanceof DerivedCacheError && error.code === 'unsafe_cache') throw error;
      await rm(dir, { recursive: true, force: true });
      return null;
    }
  }
  private async collect(): Promise<Array<{ key: string; bytes: number; created: number }>> {
    const entries: Array<{ key: string; bytes: number; created: number }> = [];
    for (const shard of await readdir(this.root).catch(() => [])) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      const shardPath = join(this.root, shard);
      try {
        if ((await lstat(shardPath)).isSymbolicLink()) {
          await rm(shardPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      for (const key of await readdir(shardPath).catch(() => [])) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue;
        try {
          const entryPath = this.path(key);
          if ((await lstat(entryPath)).isSymbolicLink())
            throw new DerivedCacheError('unsafe_cache');
          const entry = await this.valid(key);
          if (!entry) continue;
          const m = JSON.parse(
            (await readNoFollow(join(entryPath, 'manifest.json'))).toString('utf8'),
          );
          if (!Number.isSafeInteger(m.bytes) || !Number.isFinite(m.created))
            throw new Error('invalid');
          entries.push({ key, bytes: m.bytes, created: m.created });
        } catch {
          await rm(this.path(key), { recursive: true, force: true });
        }
      }
    }
    return entries;
  }
  private async freshStagingBytes(): Promise<number> {
    let total = 0;
    const active = activeStagingByRoot.get(this.root) ?? new Set<string>();
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!name.startsWith('.staging-')) continue;
      const path = join(this.root, name);
      if (active.has(path)) continue;
      try {
        if (!(await lstat(path)).isDirectory()) continue;
        const body = join(path, 'body');
        if ((await lstat(body)).isSymbolicLink()) throw new DerivedCacheError('unsafe_cache');
        total += Number((await lstat(body)).size);
      } catch {
        /* incomplete staging has no quota-bearing body */
      }
    }
    return total;
  }
  async gc(requiredBytes = 0): Promise<boolean> {
    return this.withRootLock(() => this.gcUnlocked(requiredBytes));
  }
  private async gcUnlocked(requiredBytes = 0): Promise<boolean> {
    await this.prepare();
    const quota = this.quotaBytes ?? (await this.#capacity());
    const entries = await this.collect();
    let used = entries.reduce((sum, e) => sum + e.bytes, 0) + (await this.freshStagingBytes());
    for (const entry of entries.sort(
      (a, b) => a.created - b.created || a.key.localeCompare(b.key),
    )) {
      if (used + requiredBytes <= quota) break;
      if ((leasesByRootKey.get(this.leaseKey(entry.key)) ?? 0) !== 0) continue;
      await rm(this.path(entry.key), { recursive: true, force: true });
      used -= entry.bytes;
    }
    return used + requiredBytes <= quota;
  }
  async getOrCreate(
    descriptor: CacheDescriptor,
    producer: CacheProducer,
    signal?: AbortSignal,
  ): Promise<CacheEntry> {
    aborted(signal);
    const { key, canonicalJson } = cacheIdentity(descriptor);
    await this.prepare();
    const hit = await this.valid(key, canonicalJson);
    if (hit) return hit;
    const rootKey = this.leaseKey(key);
    const existing = runningByRootKey.get(rootKey);
    if (existing) return existing;
    if (this.#queued >= this.maxQueue) throw new DerivedCacheError('queue_full');
    this.#queued++;
    const task = this.generate(key, canonicalJson, descriptor, producer, signal).finally(() => {
      runningByRootKey.delete(rootKey);
      this.#queued--;
    });
    runningByRootKey.set(rootKey, task);
    return task;
  }
  private async generate(
    key: string,
    canonicalJson: string,
    descriptor: CacheDescriptor,
    producer: CacheProducer,
    signal?: AbortSignal,
  ): Promise<CacheEntry> {
    const raced = await this.valid(key, canonicalJson);
    if (raced) return raced;
    const source = await producer(signal);
    aborted(signal);
    const body = await readBounded(source, this.maxEntryBytes, signal);
    return this.withRootLock(async () => {
      const committed = await this.valid(key, canonicalJson);
      if (committed) return committed;
      if (!(await this.gcUnlocked(body.length)))
        return { key, body, mimeType: descriptor.mimeType, hit: false };
      const destination = this.path(key);
      const staging = join(this.root, `.staging-${randomUUID()}`);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await noSymlink(staging);
      const active = activeStagingByRoot.get(this.root) ?? new Set<string>();
      activeStagingByRoot.set(this.root, active);
      active.add(staging);
      try {
        const digest = createHash('sha256').update(body).digest('hex');
        await writeNoFollow(join(staging, 'body'), body);
        await writeNoFollow(
          join(staging, 'manifest.json'),
          canonical({
            key,
            canonicalJson,
            sha256: digest,
            bytes: body.length,
            mimeType: descriptor.mimeType,
            created: this.#now(),
          }),
        );
        const stagingDirectory = await open(staging, constants.O_RDONLY);
        await stagingDirectory.sync();
        await stagingDirectory.close();
        await mkdir(join(this.root, key.slice(0, 2)), { recursive: true });
        await noSymlink(join(this.root, key.slice(0, 2)));
        try {
          await rename(staging, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await rm(staging, { recursive: true, force: true });
        }
        const directory = await open(join(this.root, key.slice(0, 2)), constants.O_RDONLY);
        await directory.sync();
        await directory.close();
        const published = await this.valid(key, canonicalJson);
        return published ?? { key, body, mimeType: descriptor.mimeType, hit: false };
      } finally {
        active.delete(staging);
        if (!active.size) activeStagingByRoot.delete(this.root);
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  private async withRootLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = rootLocks.get(this.root) ?? Promise.resolve();
    let unlock!: () => void;
    const next = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const chain = prior.then(() => next);
    rootLocks.set(this.root, chain);
    await prior;
    try {
      return await operation();
    } finally {
      unlock();
      if (rootLocks.get(this.root) === chain) rootLocks.delete(this.root);
    }
  }
  async lease(
    descriptor: CacheDescriptor,
    producer: CacheProducer,
    signal?: AbortSignal,
  ): Promise<CacheLease> {
    const entry = await this.getOrCreate(descriptor, producer, signal);
    const rootKey = this.leaseKey(entry.key);
    leasesByRootKey.set(rootKey, (leasesByRootKey.get(rootKey) ?? 0) + 1);
    let released = false;
    return {
      ...entry,
      release: () => {
        if (!released) {
          released = true;
          const count = (leasesByRootKey.get(rootKey) ?? 1) - 1;
          if (count) leasesByRootKey.set(rootKey, count);
          else leasesByRootKey.delete(rootKey);
        }
      },
    };
  }
}
