import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { scanPage, type ScanItem, type ScanPage } from '@gutter/discovery-scanner';

export const defaultValidationLimits = {
  pageBytes: 128 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  pixels: 100_000_000,
} as const;
export type ValidationLimits = Readonly<{
  pageBytes: number;
  totalBytes: number;
  pixels: number;
}>;
export type ValidationOptions = Readonly<{ limits?: ValidationLimits }>;

export type PageValidation = Readonly<{
  locator: string;
  state: 'valid' | 'skipped';
  reasonCode?: string;
  format?: 'jpeg' | 'png' | 'webp' | 'gif';
  width?: number;
  height?: number;
  bytesRead: number;
}>;
export type ValidationSummary = Readonly<{
  candidateCount: number;
  validCount: number;
  skippedCount: number;
  bytesRead: number;
  results: readonly PageValidation[];
}>;

const expected: Record<string, PageValidation['format']> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.gif': 'gif',
};
const supported = new Set<PageValidation['format']>(['jpeg', 'png', 'webp', 'gif']);

export class ValidationAttemptError extends Error {
  override readonly name = 'ValidationAttemptError';
}
class PageLimitError extends Error {
  override readonly name = 'PageLimitError';
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('validation aborted', 'AbortError');
}
function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}
function sameMtime(actual: bigint, expectedMtimeMs: number): boolean {
  // Discovery records milliseconds. A changed sub-millisecond timestamp cannot be represented there.
  return Number(actual / 1_000_000n) === Math.trunc(expectedMtimeMs);
}
type Destroyable = { destroy(error?: Error): void };
function destroyAll(streams: readonly (Destroyable | undefined)[], error: Error): void {
  for (const stream of streams) stream?.destroy(error);
}

class CountingCrcTransform extends Transform {
  bytes = 0;
  checksum = 0;
  constructor(
    private readonly pageLimit: number,
    private readonly aggregate: { value: number },
    private readonly aggregateLimit: number,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    try {
      checkAbort(this.signal);
      this.bytes += chunk.length;
      // Charge before deciding: corrupt and oversized pages cannot bypass the item cap.
      this.aggregate.value += chunk.length;
      if (this.aggregate.value > this.aggregateLimit)
        throw new PageLimitError('aggregate_byte_limit');
      if (this.bytes > this.pageLimit) throw new PageLimitError('page_byte_limit');
      this.checksum = crc32(chunk, this.checksum);
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }
}

async function validateStream(
  page: ScanPage,
  input: Readable,
  total: { value: number },
  signal?: AbortSignal,
  limits: ValidationLimits = defaultValidationLimits,
): Promise<PageValidation> {
  checkAbort(signal);
  if (total.value >= limits.totalBytes)
    return {
      locator: page.locator,
      state: 'skipped',
      reasonCode: 'aggregate_byte_limit',
      bytesRead: 0,
    };
  const counter = new CountingCrcTransform(limits.pageBytes, total, limits.totalBytes, signal);
  const decoder = sharp({
    failOn: 'warning',
    limitInputPixels: limits.pixels,
    sequentialRead: true,
    pages: 1,
  });
  const abortListener = () =>
    destroyAll([input, counter, decoder], new DOMException('validation aborted', 'AbortError'));
  signal?.addEventListener('abort', abortListener, { once: true });
  try {
    // Clones are created before data flows: metadata only recognizes the header, stats forces a full first-frame decode.
    const metadata = decoder
      .clone()
      .metadata()
      .catch(() => null);
    // Attach rejection handling immediately: a malformed header can reject this clone before
    // pipeline rejects, and must be reported as a skipped page rather than an unhandled rejection.
    const statistics = decoder
      .clone()
      .stats()
      .catch(() => null);
    await pipeline(input, counter, decoder);
    const [header, decoded] = await Promise.all([metadata, statistics]);
    if (page.observed.crc32 !== undefined && counter.checksum !== page.observed.crc32 >>> 0)
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'crc_mismatch',
        bytesRead: counter.bytes,
      };
    if (!header)
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'decode_failed',
        bytesRead: counter.bytes,
      };
    const format = header.format as PageValidation['format'] | undefined;
    if (!format || !supported.has(format))
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'decoder_format_unsupported',
        bytesRead: counter.bytes,
      };
    if (expected[extname(basename(page.locator)).toLowerCase()] !== format)
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'extension_format_mismatch',
        bytesRead: counter.bytes,
      };
    // `stats()` above is intentionally awaited for full-frame decode; dimensions come from metadata.
    if (!decoded || !header.width || !header.height)
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'decode_failed',
        bytesRead: counter.bytes,
      };
    return {
      locator: page.locator,
      state: 'valid',
      format,
      width: header.width,
      height: header.height,
      bytesRead: counter.bytes,
    };
  } catch (error) {
    destroyAll([input, counter, decoder], error as Error);
    if (signal?.aborted || error instanceof DOMException || error instanceof ValidationAttemptError)
      throw error;
    if (error instanceof PageLimitError)
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: error.message,
        bytesRead: counter.bytes,
      };
    const message = error instanceof Error ? error.message : '';
    if (/unsupported image format|not supported/i.test(message))
      return {
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'decoder_unavailable',
        bytesRead: counter.bytes,
      };
    return {
      locator: page.locator,
      state: 'skipped',
      reasonCode: 'decode_failed',
      bytesRead: counter.bytes,
    };
  } finally {
    signal?.removeEventListener('abort', abortListener);
  }
}

function entryMatches(page: ScanPage, entry: yauzl.Entry): boolean {
  const o = page.observed;
  return (
    o.compressedSize === entry.compressedSize &&
    o.uncompressedSize === entry.uncompressedSize &&
    o.size === entry.uncompressedSize &&
    o.crc32 === entry.crc32 >>> 0
  );
}

async function validateCbz(
  target: string,
  item: ScanItem,
  pages: readonly ScanPage[],
  signal?: AbortSignal,
  limits: ValidationLimits = defaultValidationLimits,
): Promise<PageValidation[]> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) !== item.size || !sameMtime(stat.mtimeNs, item.mtimeMs))
      throw new ValidationAttemptError('source_manifest_mismatch');
    return await new Promise<PageValidation[]>((resolveResult, reject) => {
      yauzl.fromFd(
        handle.fd,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true },
        (openError, zip) => {
          if (openError || !zip) {
            reject(new ValidationAttemptError('archive_unavailable'));
            return;
          }
          const targets = new Map(pages.map((page) => [page.locator, page]));
          const seen = new Set<string>();
          const results: PageValidation[] = [];
          const total = { value: 0 };
          let done = false;
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            zip.close();
            error ? reject(error) : resolveResult(results);
          };
          const onAbort = () => finish(new DOMException('validation aborted', 'AbortError'));
          signal?.addEventListener('abort', onAbort, { once: true });
          const close = (error?: Error) => {
            signal?.removeEventListener('abort', onAbort);
            finish(error);
          };
          zip.on('error', () => close(new ValidationAttemptError('archive_stream_failed')));
          zip.on('end', () => {
            if (seen.size !== targets.size) {
              close(new ValidationAttemptError('source_manifest_mismatch'));
              return;
            }
            close();
          });
          zip.on('entry', (entry) => {
            void (async () => {
              try {
                checkAbort(signal);
                const page = targets.get(entry.fileName);
                if (!page) {
                  zip.readEntry();
                  return;
                }
                if (!entryMatches(page, entry))
                  throw new ValidationAttemptError('source_manifest_mismatch');
                seen.add(page.locator);
                if (total.value >= limits.totalBytes) {
                  results.push({
                    locator: page.locator,
                    state: 'skipped',
                    reasonCode: 'aggregate_byte_limit',
                    bytesRead: 0,
                  });
                  zip.readEntry();
                  return;
                }
                await new Promise<void>((resolveStream, rejectStream) =>
                  zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                      rejectStream(new ValidationAttemptError('archive_page_unavailable'));
                      return;
                    }
                    validateStream(page, stream, total, signal, limits).then((result) => {
                      results.push(result);
                      resolveStream();
                    }, rejectStream);
                  }),
                );
                zip.readEntry();
              } catch (error) {
                close(error as Error);
              }
            })();
          });
          zip.readEntry();
        },
      );
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function validateDirectory(
  target: string,
  pages: readonly ScanPage[],
  signal?: AbortSignal,
  limits: ValidationLimits = defaultValidationLimits,
): Promise<PageValidation[]> {
  const results: PageValidation[] = [];
  const total = { value: 0 };
  for (const page of pages) {
    checkAbort(signal);
    if (total.value >= limits.totalBytes) {
      results.push({
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'aggregate_byte_limit',
        bytesRead: 0,
      });
      continue;
    }
    const path = resolve(target, page.locator);
    if (!contained(target, path)) {
      results.push({
        locator: page.locator,
        state: 'skipped',
        reasonCode: 'unsafe_locator',
        bytesRead: 0,
      });
      continue;
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        results.push({
          locator: page.locator,
          state: 'skipped',
          reasonCode: 'missing_page',
          bytesRead: 0,
        });
        continue;
      }
      throw new ValidationAttemptError('root_or_page_unavailable');
    }
    try {
      const stat = await handle.stat({ bigint: true });
      const observed = page.observed;
      if (
        !stat.isFile() ||
        Number(stat.size) !== observed.size ||
        (observed.mtimeNs && stat.mtimeNs.toString() !== observed.mtimeNs)
      )
        throw new ValidationAttemptError('source_manifest_mismatch');
      const stream = handle.createReadStream({ autoClose: false });
      results.push(await validateStream(page, stream, total, signal, limits));
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return results;
}

/** Validates streams only; source/lease failures deliberately reject so no stale completion is recorded. */
export async function validateSourceItem(
  root: string,
  item: ScanItem,
  signal?: AbortSignal,
  options: ValidationOptions = {},
): Promise<ValidationSummary> {
  checkAbort(signal);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new ValidationAttemptError('root_unavailable');
  }
  const target = resolve(canonicalRoot, item.relativePath);
  if (!contained(canonicalRoot, target)) throw new ValidationAttemptError('source_escaped_root');
  const pages = item.pages.map(scanPage);
  const limits = options.limits ?? defaultValidationLimits;
  const results =
    item.kind === 'cbz'
      ? await validateCbz(target, item, pages, signal, limits)
      : await validateDirectory(target, pages, signal, limits);
  return {
    candidateCount: pages.length,
    validCount: results.filter((r) => r.state === 'valid').length,
    skippedCount: results.filter((r) => r.state === 'skipped').length,
    bytesRead: results.reduce((n, r) => n + r.bytesRead, 0),
    results,
  };
}
