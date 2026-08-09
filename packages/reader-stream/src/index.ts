import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, realpath } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';

export const defaultReaderStreamLimits = {
  chunkBytes: 64 * 1024,
  pageBytes: 128 * 1024 * 1024,
  archiveEntries: 100_000,
  archiveTotalBytes: 2 * 1024 * 1024 * 1024,
  archiveCompressionRatio: 200,
  concurrency: 2,
  queue: 8,
} as const;

export type SourceObservation = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;
export type PageObservation = Readonly<{
  size: number;
  mtimeNs?: bigint;
  compressedSize?: number;
  uncompressedSize?: number;
  crc32?: number;
}>;
export type ReaderSource = Readonly<{
  root: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  observed: SourceObservation;
}>;
export type ReaderPage = Readonly<{ locator: string; observed: PageObservation }>;
export type ReaderStreamLimits = Readonly<Partial<typeof defaultReaderStreamLimits>>;
export type ReaderStreamOptions = Readonly<{
  source: ReaderSource;
  page: ReaderPage;
  signal?: AbortSignal;
  limits?: ReaderStreamLimits;
  limiter?: ReaderStreamLimiter;
  /** Test-only barrier after the source descriptor is pinned and verified. */
  afterOpen?: () => Promise<void> | void;
}>;

export class ReaderStreamError extends Error {
  override readonly name = 'ReaderStreamError';
  constructor(readonly code: ReaderStreamCode) {
    super(code);
  }
}
export type ReaderStreamCode =
  | 'archive_corrupt'
  | 'archive_encrypted'
  | 'archive_entry_limit'
  | 'archive_entry_too_large'
  | 'archive_path_unsafe'
  | 'archive_ratio_limit'
  | 'archive_total_limit'
  | 'cancelled'
  | 'locator_unsafe'
  | 'page_missing'
  | 'queue_full'
  | 'source_stale'
  | 'source_unavailable'
  | 'unsupported_media';

const mediaTypes: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function fail(code: ReaderStreamCode): never {
  throw new ReaderStreamError(code);
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail('cancelled');
}
function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}
function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')
  );
}
function sameObservation(actual: SourceObservation, expected: SourceObservation): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs
  );
}
function observation(stat: BigIntStats): SourceObservation {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}
function limitsFor(partial: ReaderStreamLimits = {}) {
  return { ...defaultReaderStreamLimits, ...partial };
}

export class ReaderStreamLimiter {
  #active = 0;
  #waiters: Array<() => void> = [];
  constructor(
    readonly concurrency = defaultReaderStreamLimits.concurrency,
    readonly queue = defaultReaderStreamLimits.queue,
  ) {}
  get active(): number {
    return this.#active;
  }
  get waiting(): number {
    return this.#waiters.length;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    aborted(signal);
    if (this.#active < this.concurrency) {
      this.#active++;
      return this.release();
    }
    if (this.#waiters.length >= this.queue) fail('queue_full');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
        reject(new ReaderStreamError('cancelled'));
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(wake);
    });
    aborted(signal);
    this.#active++;
    return this.release();
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#waiters.shift()?.();
    };
  }
}

class BoundedChunks extends Transform {
  #bytes = 0;
  #checksum = 0;
  constructor(
    private readonly maxBytes: number,
    private readonly chunkBytes: number,
    private readonly signal?: AbortSignal,
    private readonly expectedCrc?: number,
  ) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      aborted(this.signal);
      this.#bytes += chunk.length;
      if (this.#bytes > this.maxBytes) fail('archive_entry_too_large');
      if (this.expectedCrc !== undefined) this.#checksum = crc32(chunk, this.#checksum);
      for (let offset = 0; offset < chunk.length; offset += this.chunkBytes)
        this.push(chunk.subarray(offset, offset + this.chunkBytes));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
  override _flush(callback: (error?: Error | null) => void): void {
    callback(
      this.expectedCrc !== undefined && this.#checksum !== this.expectedCrc >>> 0
        ? new ReaderStreamError('archive_corrupt')
        : null,
    );
  }
}

function bindCleanup(
  stream: Readable,
  cleanup: (error?: Error) => void,
  signal?: AbortSignal,
): Readable {
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    cleanup(error);
  };
  const onAbort = () => {
    const error = new ReaderStreamError('cancelled');
    stream.destroy(error);
    finish(error);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  stream.once('end', () => finish());
  stream.once('error', (error) => finish(error));
  stream.once('close', () => finish());
  return stream;
}

function verifyMedia(locator: string): string {
  const mediaType = mediaTypes[extname(locator).toLowerCase()];
  if (!mediaType) fail('unsupported_media');
  return mediaType;
}

async function pinnedTarget(source: ReaderSource): Promise<{ root: string; target: string }> {
  if (source.relativePath !== '.' && !safeRelative(source.relativePath)) fail('locator_unsafe');
  let root: string;
  try {
    root = await realpath(source.root);
  } catch {
    fail('source_unavailable');
  }
  const target = resolve(root, source.relativePath);
  if (!contained(root, target)) fail('locator_unsafe');
  return { root, target };
}

async function openDirectory(
  options: ReaderStreamOptions,
  release: () => void,
): Promise<ReaderStream> {
  const { source, page, signal, afterOpen } = options;
  if (!safeRelative(page.locator)) fail('locator_unsafe');
  const mediaType = verifyMedia(page.locator);
  const { root, target } = await pinnedTarget(source);
  const path = resolve(target, page.locator);
  if (!contained(target, path)) fail('locator_unsafe');
  try {
    if (!contained(root, await realpath(dirname(path)))) fail('locator_unsafe');
    const sourceHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const sourceStat = await sourceHandle.stat({ bigint: true });
      if (!sourceStat.isDirectory() || !sameObservation(observation(sourceStat), source.observed))
        fail('source_stale');
    } finally {
      await sourceHandle.close().catch(() => undefined);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      const expected = page.observed;
      if (
        !stat.isFile() ||
        stat.size !== BigInt(expected.size) ||
        (expected.mtimeNs !== undefined && stat.mtimeNs !== expected.mtimeNs)
      )
        fail('source_stale');
      await afterOpen?.();
      aborted(signal);
      const stream = new BoundedChunks(expected.size, limitsFor(options.limits).chunkBytes, signal);
      const input = handle.createReadStream({
        autoClose: false,
        highWaterMark: limitsFor(options.limits).chunkBytes,
      });
      input.once('error', (error) => stream.destroy(error));
      input.pipe(stream);
      return {
        stream: bindCleanup(
          stream,
          () => {
            input.destroy();
            void handle.close();
            release();
          },
          signal,
        ),
        size: expected.size,
        mediaType,
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    release();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('page_missing');
    if (error instanceof ReaderStreamError) throw error;
    fail('source_unavailable');
  }
}

function unsafeArchivePath(name: string): boolean {
  return !safeRelative(name);
}
function archiveError(error: unknown): ReaderStreamError {
  const message = (error as Error | undefined)?.message ?? '';
  return new ReaderStreamError(
    /relative path|traversal/i.test(message)
      ? 'archive_path_unsafe'
      : /encrypted/i.test(message)
        ? 'archive_encrypted'
        : 'archive_corrupt',
  );
}
function matches(entry: yauzl.Entry, page: ReaderPage): boolean {
  const expected = page.observed;
  return (
    entry.fileName === page.locator &&
    expected.size === entry.uncompressedSize &&
    (expected.uncompressedSize === undefined ||
      entry.uncompressedSize === expected.uncompressedSize) &&
    (expected.compressedSize === undefined || entry.compressedSize === expected.compressedSize) &&
    (expected.crc32 === undefined || entry.crc32 === expected.crc32 >>> 0)
  );
}

async function openCbz(options: ReaderStreamOptions, release: () => void): Promise<ReaderStream> {
  const { source, page, signal, afterOpen } = options;
  if (!safeRelative(page.locator)) fail('locator_unsafe');
  const mediaType = verifyMedia(page.locator);
  const { root, target } = await pinnedTarget(source);
  let handle: FileHandle | undefined;
  try {
    if (!contained(root, await realpath(dirname(target)))) fail('locator_unsafe');
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = handle;
    if (!sameObservation(observation(await file.stat({ bigint: true })), source.observed))
      fail('source_stale');
    await afterOpen?.();
    aborted(signal);
    const found = await new Promise<{ zip: yauzl.ZipFile; entry: yauzl.Entry }>(
      (resolveEntry, reject) => {
        yauzl.fromFd(file.fd, { lazyEntries: true, autoClose: false }, (error, zip) => {
          if (error || !zip) {
            reject(archiveError(error));
            return;
          }
          let entries = 0;
          let total = 0;
          let result: yauzl.Entry | undefined;
          let settled = false;
          const close = (error?: Error) => {
            if (settled) return;
            settled = true;
            error
              ? ((handle = undefined), zip.close(), reject(error))
              : result
                ? resolveEntry({ zip, entry: result })
                : ((handle = undefined),
                  zip.close(),
                  reject(new ReaderStreamError('page_missing')));
          };
          zip.on('error', (error) => close(archiveError(error)));
          zip.on('entry', (entry) => {
            entries++;
            total += entry.uncompressedSize;
            const limits = limitsFor(options.limits);
            if (entries > limits.archiveEntries)
              return close(new ReaderStreamError('archive_entry_limit'));
            if (entry.generalPurposeBitFlag & 1)
              return close(new ReaderStreamError('archive_encrypted'));
            if (unsafeArchivePath(entry.fileName))
              return close(new ReaderStreamError('archive_path_unsafe'));
            if (entry.uncompressedSize > limits.pageBytes)
              return close(new ReaderStreamError('archive_entry_too_large'));
            if (total > limits.archiveTotalBytes)
              return close(new ReaderStreamError('archive_total_limit'));
            if (
              entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
              limits.archiveCompressionRatio
            )
              return close(new ReaderStreamError('archive_ratio_limit'));
            if (entry.fileName === page.locator) {
              if (!matches(entry, page)) return close(new ReaderStreamError('source_stale'));
              result = entry;
            }
            zip.readEntry();
          });
          zip.on('end', () => close());
          zip.readEntry();
        });
      },
    );
    const { zip, entry } = found;
    // yauzl's FdSlicer owns this descriptor once fromFd succeeds.
    handle = undefined;
    const input = await new Promise<Readable>((resolveStream, reject) =>
      zip.openReadStream(entry, (error, stream) =>
        error || !stream ? (zip.close(), reject(archiveError(error))) : resolveStream(stream),
      ),
    );
    const stream = new BoundedChunks(
      page.observed.size,
      limitsFor(options.limits).chunkBytes,
      signal,
      entry.crc32,
    );
    input.once('error', (error) => stream.destroy(archiveError(error)));
    input.pipe(stream);
    return {
      stream: bindCleanup(
        stream,
        () => {
          input.destroy();
          zip.close();
          release();
        },
        signal,
      ),
      size: page.observed.size,
      mediaType,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    release();
    if (error instanceof ReaderStreamError) throw error;
    fail('source_unavailable');
  }
}

export type ReaderStream = Readonly<{ stream: Readable; size: number; mediaType: string }>;

/** Opens an internally-authorized, observed page. It never accepts a public filesystem path. */
export async function openReaderStream(options: ReaderStreamOptions): Promise<ReaderStream> {
  const limits = limitsFor(options.limits);
  const limiter = options.limiter ?? new ReaderStreamLimiter(limits.concurrency, limits.queue);
  const release = await limiter.acquire(options.signal);
  try {
    return await (options.source.kind === 'directory'
      ? openDirectory(options, release)
      : openCbz(options, release));
  } catch (error) {
    // The operation helpers also release after resource acquisition failures; this closure is idempotent.
    release();
    throw error;
  }
}
