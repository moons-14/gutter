import { constants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, posix, relative as relativePath } from 'node:path';
import { maxComicInfoBytes, parseComicInfo, type ComicInfoParseResult } from '@gutter/comic-info';
import yauzl from 'yauzl';

export const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export const defaultArchiveQuotas = {
  entries: 100_000,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024 * 1024,
  compressionRatio: 200,
} as const;

export type ScanReason =
  | 'archive_compression_ratio'
  | 'archive_entry_limit'
  | 'archive_entry_too_large'
  | 'archive_path_traversal'
  | 'archive_total_too_large'
  | 'duplicate_page_locator'
  | 'encrypted_archive'
  | 'malformed_archive'
  | 'zero_supported_pages';

export type ScanIssue = Readonly<{ code: string; rule: string; detail?: string }>;

export type ScanItem = Readonly<{
  relativePath: string;
  displayName?: string;
  kind: 'directory' | 'cbz';
  size: number;
  mtimeMs: number;
  pages: readonly (ScanPage | string)[];
  /** A digest of discovery observations, not a content hash. */
  manifestSha256?: string;
  comicInfo?: ComicInfoParseResult | null;
  scanIssues?: readonly ScanIssue[];
  quarantinedReason: ScanReason | null;
}>;
type CbzInspection = Pick<ScanItem, 'pages' | 'comicInfo' | 'scanIssues' | 'quarantinedReason'> & {
  deferredReason?: 'unstable';
  source?: Readonly<{ size: number; mtimeMs: number }>;
};
export type FileObservation = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}>;

function observation(stat: BigIntStats): FileObservation {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}

function sameObservation(left: FileObservation, right: FileObservation): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

export type ScanPage = Readonly<{
  locator: string;
  /** ZIP central-directory facts or a no-follow directory-file observation. */
  observed: Readonly<{
    compressedSize?: number;
    crc32?: number;
    mtimeNs?: string;
    size: number;
    uncompressedSize?: number;
  }>;
}>;

export function scanPage(page: ScanPage | string): ScanPage {
  return typeof page === 'string' ? { locator: page, observed: { size: 0 } } : page;
}

export type ScanSummary = {
  discovered: number;
  skipped: number;
  quarantined: number;
  failed: number;
  symlinks: number;
  mixedParents: number;
  pages: number;
  reasons: Partial<Record<ScanReason, number>>;
  metadataIssues: Partial<Record<string, number>>;
  /** Database-derived classification; filesystem discovery must not guess these values. */
  updated: number;
  unchanged: number;
};

export type ScanResult = Readonly<{ items: readonly ScanItem[]; summary: ScanSummary }>;
export type BatchedScanOptions = Readonly<{
  signal?: AbortSignal;
  batchSize?: number;
  stableGraceMs?: number;
  /** Called during DFS, before traversal completion. The callback must not retain the array. */
  onItems?: (items: readonly ScanItem[]) => Promise<void> | void;
  onProtected?: (paths: readonly string[]) => Promise<void> | void;
  /** A child subtree could not be read; preserve its prior active descendants for this run. */
  onProtectedPrefix?: (prefix: string) => Promise<void> | void;
  /** Bounded cancellation/lease pulse; invoked at least once per second during traversal. */
  pulse?: (force?: boolean) => Promise<void> | void;
  /** Disable compatibility collection for worker streaming scans. */
  collect?: boolean;
  /** Test seam for simulating a page that becomes unreadable after directory enumeration. */
  openPage?: (path: string) => ReturnType<typeof open>;
}>;
export type ArchiveQuotas = Partial<typeof defaultArchiveQuotas>;

const collator = new Intl.Collator('und', { numeric: true, sensitivity: 'base' });
const maxDepth = 128;

function isImage(name: string): boolean {
  return imageExtensions.has(posix.extname(name).toLowerCase());
}

function comparePages(a: string, b: string): number {
  const normalized = collator.compare(
    a.normalize('NFC').normalize('NFKC'),
    b.normalize('NFC').normalize('NFKC'),
  );
  return normalized || (a < b ? -1 : a > b ? 1 : 0);
}

function pageOrder(a: ScanPage, b: ScanPage): number {
  return comparePages(a.locator, b.locator);
}

export function manifestSha256(
  kind: ScanItem['kind'],
  size: number,
  mtimeMs: number,
  pages: readonly ScanPage[],
): string {
  const hash = createHash('sha256');
  hash.update(`${kind}\u0000${size}\u0000${mtimeMs}\u0000`);
  for (const page of pages) {
    const value = page.observed;
    hash.update(
      `${page.locator.normalize('NFC')}\u0000${value.size}\u0000${value.mtimeNs ?? ''}\u0000${value.compressedSize ?? ''}\u0000${value.uncompressedSize ?? ''}\u0000${value.crc32 ?? ''}\u0000`,
    );
  }
  return hash.digest('hex');
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('scan aborted', 'AbortError');
}

function transientFilesystemError(error: unknown): boolean {
  return ['EACCES', 'EIO', 'ESTALE', 'ENOENT', 'EPERM'].includes(
    (error as NodeJS.ErrnoException)?.code ?? '',
  );
}

function relative(root: string, path: string): string {
  const value = path
    .slice(root.length + 1)
    .split('\\')
    .join('/');
  return value || '.';
}

function unsafeZipPath(path: string): boolean {
  return path.startsWith('/') || path.split('/').some((segment) => segment === '..');
}

function archiveErrorReason(error: Error): ScanReason {
  if (/encrypted/i.test(error.message)) return 'encrypted_archive';
  if (/relative path|traversal/i.test(error.message)) return 'archive_path_traversal';
  return 'malformed_archive';
}

export async function inspectCbz(
  path: string,
  quotaOverrides: ArchiveQuotas = {},
  signal?: AbortSignal,
  pulse?: (force?: boolean) => Promise<void> | void,
  stableGraceMs = 0,
  expected?: FileObservation,
): Promise<CbzInspection> {
  const quotas = { ...defaultArchiveQuotas, ...quotaOverrides };
  checkAborted(signal);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (transientFilesystemError(error))
      return {
        pages: [],
        comicInfo: null,
        scanIssues: [],
        quarantinedReason: null,
        deferredReason: 'unstable',
      };
    return {
      pages: [],
      comicInfo: null,
      scanIssues: [],
      quarantinedReason: archiveErrorReason(error as Error),
    };
  }
  let initial: BigIntStats;
  try {
    initial = await handle.stat({ bigint: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (transientFilesystemError(error))
      return {
        pages: [],
        comicInfo: null,
        scanIssues: [],
        quarantinedReason: null,
        deferredReason: 'unstable',
      };
    return {
      pages: [],
      comicInfo: null,
      scanIssues: [],
      quarantinedReason: 'malformed_archive',
      source: expected ? { size: Number(expected.size), mtimeMs: Number(expected.mtimeNs) / 1_000_000 } : undefined,
    };
  }
  if (!initial.isFile() || (expected && !sameObservation(expected, observation(initial)))) {
    await handle.close().catch(() => undefined);
    return {
      pages: [],
      comicInfo: null,
      scanIssues: [],
      quarantinedReason: null,
      deferredReason: 'unstable',
    };
  }
  const descriptorSource = { size: Number(initial.size), mtimeMs: Number(initial.mtimeMs) };
  if (signal?.aborted) {
    await handle.close();
    checkAborted(signal);
  }
  return new Promise((resolve, reject) => {
    let zip: yauzl.ZipFile | undefined;
    let settled = false;
    let onAbort: (() => void) | undefined;
    const finish = (result?: CbzInspection, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      try {
        zip?.close();
      } finally {
        void handle
          .close()
          .catch(() => undefined)
          .then(() => (error ? reject(error) : resolve(result!)));
      }
    };
    const abort = () => finish(undefined, new DOMException('scan aborted', 'AbortError'));
    onAbort = abort;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return abort();
    try {
      yauzl.fromFd(
        handle.fd,
        { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: false },
        (openError, zipFile) => {
          if (signal?.aborted) return abort();
          if (openError || !zipFile) {
            finish({
              pages: [],
              comicInfo: null,
              scanIssues: [],
              quarantinedReason: openError ? archiveErrorReason(openError) : 'malformed_archive',
              source: descriptorSource,
            });
            return;
          }
          zip = zipFile;
          const archive = zipFile;
          const pages: ScanPage[] = [];
          const scanIssues: ScanIssue[] = [];
          let comicInfo: ComicInfoParseResult | null = null;
          const comicInfoEntries: yauzl.Entry[] = [];
          let entries = 0;
          let total = 0;
          let reason: ScanReason | null = null;
          const advance = async (force = false) => {
            checkAborted(signal);
            await pulse?.(force);
            checkAborted(signal);
            archive.readEntry();
          };
          const readComicInfo = (entry: yauzl.Entry) =>
            new Promise<Uint8Array>((resolve, reject) => {
              if (entry.uncompressedSize > maxComicInfoBytes) {
                resolve(new Uint8Array(maxComicInfoBytes + 1));
                return;
              }
              archive.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream) {
                  reject(streamError ?? new Error('ComicInfo stream unavailable'));
                  return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                let settled = false;
                const settle = (value: Uint8Array) => {
                  if (!settled) {
                    settled = true;
                    resolve(value);
                  }
                };
                stream.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > maxComicInfoBytes) {
                    stream.destroy();
                    settle(new Uint8Array(maxComicInfoBytes + 1));
                  } else chunks.push(chunk);
                });
                stream.on('error', (error) => {
                  if (!settled) reject(error);
                });
                stream.on('end', () => settle(Buffer.concat(chunks)));
              });
            });
          const complete = async () => {
            const exact = comicInfoEntries.filter((entry) => entry.fileName === 'ComicInfo.xml');
            if (exact.length === 1) {
              try {
                comicInfo = parseComicInfo(await readComicInfo(exact[0]!));
              } catch {
                scanIssues.push({ code: 'comicinfo_read_failed', rule: 'comicinfo-filename-v1' });
              }
            } else if (exact.length > 1 || (exact.length === 0 && comicInfoEntries.length > 1)) {
              scanIssues.push({ code: 'comicinfo_ambiguous_name', rule: 'comicinfo-filename-v1' });
            } else if (comicInfoEntries.length === 1) {
              scanIssues.push({
                code: 'comicinfo_noncanonical_name',
                rule: 'comicinfo-filename-v1',
              });
              try {
                comicInfo = parseComicInfo(await readComicInfo(comicInfoEntries[0]!));
              } catch {
                scanIssues.push({ code: 'comicinfo_read_failed', rule: 'comicinfo-filename-v1' });
              }
            }
            if (!reason && pages.length === 0) reason = 'zero_supported_pages';
            if (!reason) {
              const locators = new Set<string>();
              for (const page of pages) {
                const locator = page.locator.normalize('NFC');
                if (locators.has(locator)) {
                  reason = 'duplicate_page_locator';
                  break;
                }
                locators.add(locator);
              }
            }
            // This intentionally follows ComicInfo streaming/parsing: metadata is source input too.
            const final = await handle.stat({ bigint: true }).catch(() => null);
            if (
              !final ||
              !final.isFile() ||
              !sameObservation(observation(initial), observation(final)) ||
              Number(final.mtimeMs) > Date.now() - stableGraceMs
            ) {
              finish({
                pages: [],
                comicInfo: null,
                scanIssues: [],
                quarantinedReason: null,
                deferredReason: 'unstable',
              });
              return;
            }
            finish({
              pages: reason ? [] : pages.sort(pageOrder),
              comicInfo: reason ? null : comicInfo,
              scanIssues,
              quarantinedReason: reason,
              source: descriptorSource,
            });
          };
          archive.on('error', (error: Error) => {
            reason ||= archiveErrorReason(error);
            complete();
          });
          archive.on('entry', (entry) => {
            void (async () => {
              if (signal?.aborted) return abort();
              entries += 1;
              total += entry.uncompressedSize;
              if (entries > quotas.entries) reason = 'archive_entry_limit';
              else if (entry.generalPurposeBitFlag & 1) reason = 'encrypted_archive';
              else if (unsafeZipPath(entry.fileName)) reason = 'archive_path_traversal';
              else if (entry.uncompressedSize > quotas.entryBytes)
                reason = 'archive_entry_too_large';
              else if (total > quotas.totalBytes) reason = 'archive_total_too_large';
              else if (
                entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
                quotas.compressionRatio
              )
                reason = 'archive_compression_ratio';
              else if (
                !entry.fileName.includes('/') &&
                entry.fileName.toLowerCase() === 'comicinfo.xml'
              )
                comicInfoEntries.push(entry);
              else if (!entry.fileName.endsWith('/') && isImage(basename(entry.fileName)))
                pages.push({
                  locator: entry.fileName,
                  observed: {
                    compressedSize: entry.compressedSize,
                    crc32: entry.crc32 >>> 0,
                    size: entry.uncompressedSize,
                    uncompressedSize: entry.uncompressedSize,
                  },
                });
              if (reason) await complete();
              else await advance(entries % 64 === 0);
            })().catch((error) => finish(undefined, error));
          });
          archive.on('end', () => void complete());
          if (signal?.aborted) abort();
          else void advance().catch((error) => finish(undefined, error));
        },
      );
    } catch (error) {
      finish({
        pages: [],
        comicInfo: null,
        scanIssues: [],
        quarantinedReason: archiveErrorReason(error as Error),
        source: descriptorSource,
      });
    }
  });
}

async function inspectDirectoryComicInfo(
  directory: string,
  names: readonly string[],
  stableGraceMs: number,
): Promise<{
  comicInfo: ComicInfoParseResult | null;
  scanIssues: readonly ScanIssue[];
  deferred: boolean;
}> {
  const candidates = names.filter((name) => name.toLowerCase() === 'comicinfo.xml');
  if (candidates.length === 0) return { comicInfo: null, scanIssues: [], deferred: false };
  const exact = candidates.filter((name) => name === 'ComicInfo.xml');
  if (exact.length > 1 || (exact.length === 0 && candidates.length > 1))
    return {
      comicInfo: null,
      scanIssues: [{ code: 'comicinfo_ambiguous_name', rule: 'comicinfo-filename-v1' }],
      deferred: false,
    };
  const name = exact[0] ?? candidates[0]!;
  try {
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || Number(initial.mtimeMs) > Date.now() - stableGraceMs)
        return { comicInfo: null, scanIssues: [], deferred: true };
      const limit = Number(
        initial.size > BigInt(maxComicInfoBytes) ? maxComicInfoBytes + 1 : initial.size,
      );
      const bytes = Buffer.alloc(limit);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return { comicInfo: null, scanIssues: [], deferred: true };
        offset += bytesRead;
      }
      const parsed = parseComicInfo(bytes);
      const final = await handle.stat({ bigint: true });
      if (
        !final.isFile() ||
        !sameObservation(observation(initial), observation(final)) ||
        Number(final.mtimeMs) > Date.now() - stableGraceMs
      )
        return { comicInfo: null, scanIssues: [], deferred: true };
      return {
        comicInfo: parsed,
        scanIssues:
          name === 'ComicInfo.xml'
            ? []
            : [{ code: 'comicinfo_noncanonical_name', rule: 'comicinfo-filename-v1' }],
        deferred: false,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      comicInfo: null,
      scanIssues: [],
      deferred: true,
    };
  }
}

export async function scanRoot(root: string, signal?: AbortSignal): Promise<ScanResult> {
  return scanRootBatched(root, { signal });
}

/** Bounded DFS emits at most 100 candidates at a time while retaining the compatibility result. */
export async function scanRootBatched(
  root: string,
  options: BatchedScanOptions = {},
): Promise<ScanResult> {
  const signal = options.signal;
  const batchSize = Math.min(100, Math.max(1, options.batchSize ?? 100));
  const stableGraceMs = Math.max(0, options.stableGraceMs ?? 0);
  const collect = options.collect ?? true;
  let lastPulse = 0;
  const pulse = async (force = false): Promise<void> => {
    if (!force && Date.now() - lastPulse < 1_000) return;
    lastPulse = Date.now();
    await options.pulse?.();
  };
  const summary: ScanSummary = {
    discovered: 0,
    skipped: 0,
    quarantined: 0,
    failed: 0,
    symlinks: 0,
    mixedParents: 0,
    pages: 0,
    reasons: {},
    metadataIssues: {},
    updated: 0,
    unchanged: 0,
  };
  const items: ScanItem[] = [];
  let pending: ScanItem[] = [];
  let protectedPaths: string[] = [];
  const protect = async (path: string): Promise<void> => {
    protectedPaths.push(path);
    if (protectedPaths.length >= batchSize) {
      const batch = protectedPaths;
      protectedPaths = [];
      await options.onProtected?.(batch);
    }
  };
  const protectPrefix = async (path: string): Promise<void> => {
    await options.onProtectedPrefix?.(path);
  };
  const stable = (mtimeMs: number): boolean => mtimeMs <= Date.now() - stableGraceMs;
  const recordItem = async (item: ScanItem): Promise<void> => {
    if (collect) items.push(item);
    pending.push(item);
    if (pending.length >= batchSize) {
      const batch = pending;
      pending = [];
      await options.onItems?.(batch);
    }
  };
  const recordMetadataIssues = (issues: readonly ScanIssue[]): void => {
    for (const entry of issues)
      summary.metadataIssues[entry.code] = (summary.metadataIssues[entry.code] ?? 0) + 1;
  };
  const canonicalRoot = await realpath(root);

  function contained(path: string): boolean {
    const value = relativePath(canonicalRoot, path);
    return value === '' || (!value.startsWith('..') && !value.startsWith(`..${posix.sep}`));
  }

  type DescendantState = 'candidate' | 'none' | 'unknown-cutoff';

  async function visit(directory: string, depth: number): Promise<DescendantState> {
    checkAborted(signal);
    await pulse();
    if (depth > maxDepth) {
      summary.skipped += 1;
      return 'unknown-cutoff';
    }
    const canonicalDirectory = await realpath(directory);
    if (!contained(canonicalDirectory)) throw new Error('directory escaped validated root');
    const children: string[] = [];
    const direct: { name: string; initial: FileObservation }[] = [];
    const files: string[] = [];
    let observedEntries = 0;
    let unreadableDirect = false;
    // Re-realpath and containment are best-effort against host filesystem mutation races.
    const handle = await opendir(canonicalDirectory);
    try {
      for await (const entry of handle) {
        checkAborted(signal);
        await pulse(++observedEntries % 64 === 0);
        const path = join(canonicalDirectory, entry.name);
        let stat: BigIntStats;
        try {
          stat = await lstat(path, { bigint: true });
        } catch {
          if (posix.extname(entry.name).toLowerCase() === '.cbz')
            await protect(relative(canonicalRoot, path));
          else if (entry.isDirectory()) await protectPrefix(relative(canonicalRoot, path));
          else if (isImage(entry.name)) unreadableDirect = true;
          continue;
        }
        if (stat.isSymbolicLink()) {
          summary.symlinks += 1;
        } else if (stat.isDirectory()) {
          children.push(path);
        } else if (stat.isFile()) {
          files.push(entry.name);
          if (isImage(entry.name)) direct.push({ name: entry.name, initial: observation(stat) });
          else if (posix.extname(entry.name).toLowerCase() === '.cbz') {
            if (!stable(Number(stat.mtimeMs))) {
              await protect(relative(canonicalRoot, path));
              continue;
            }
            const inspected = await inspectCbz(
              path,
              {},
              signal,
              pulse,
              stableGraceMs,
              observation(stat),
            );
            if (inspected.deferredReason) {
              await protect(relative(canonicalRoot, path));
              continue;
            }
            await recordItem({
              relativePath: relative(canonicalRoot, path),
              kind: 'cbz',
              size: inspected.source!.size,
              mtimeMs: inspected.source!.mtimeMs,
              ...inspected,
              manifestSha256: manifestSha256(
                'cbz',
                inspected.source!.size,
                inspected.source!.mtimeMs,
                inspected.pages.map(scanPage),
              ),
            });
            recordMetadataIssues([
              ...(inspected.scanIssues ?? []),
              ...(inspected.comicInfo?.issues ?? []),
            ]);
            if (inspected.quarantinedReason) {
              summary.quarantined += 1;
              summary.reasons[inspected.quarantinedReason] =
                (summary.reasons[inspected.quarantinedReason] ?? 0) + 1;
            } else {
              summary.discovered += 1;
              summary.pages += inspected.pages.length;
            }
          }
        }
      }
    } finally {
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    let descendant: DescendantState = 'none';
    for (const child of children.sort()) {
      let childState: DescendantState;
      try {
        childState = await visit(child, depth + 1);
      } catch (error) {
        if (!transientFilesystemError(error)) throw error;
        await protectPrefix(relative(canonicalRoot, child));
        childState = 'candidate';
      }
      if (childState === 'candidate') descendant = 'candidate';
      else if (childState === 'unknown-cutoff' && descendant === 'none')
        descendant = 'unknown-cutoff';
    }
    if (direct.length && descendant === 'none') {
      const beforeDirectory = await lstat(canonicalDirectory);
      const pages: ScanPage[] = [];
      let unstable = unreadableDirect || !stable(beforeDirectory.mtimeMs);
      let attemptedPages = 0;
      for (const entry of direct.sort((left, right) => comparePages(left.name, right.name))) {
        const name = entry.name;
        checkAborted(signal);
        attemptedPages += 1;
        await pulse(attemptedPages % 64 === 0);
        const path = join(canonicalDirectory, name);
        let handle;
        try {
          handle = await (
            options.openPage ?? ((value) => open(value, constants.O_RDONLY | constants.O_NOFOLLOW))
          )(path);
        } catch {
          unstable = true;
          continue;
        }
        try {
          const stat = await handle.stat({ bigint: true });
          if (!stat.isFile() || !sameObservation(entry.initial, observation(stat))) unstable = true;
          if (Number(stat.mtimeMs) > Date.now() - stableGraceMs) unstable = true;
          pages.push({
            locator: name,
            observed: { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() },
          });
        } finally {
          await handle.close();
        }
      }
      if (unstable) {
        await protect(relative(canonicalRoot, canonicalDirectory));
        return 'candidate';
      }
      const comicInfo = await inspectDirectoryComicInfo(canonicalDirectory, files, stableGraceMs);
      if (comicInfo.deferred) {
        await protect(relative(canonicalRoot, canonicalDirectory));
        return 'candidate';
      }
      const directoryStat = await lstat(canonicalDirectory);
      if (
        directoryStat.dev !== beforeDirectory.dev ||
        directoryStat.ino !== beforeDirectory.ino ||
        directoryStat.mtimeMs !== beforeDirectory.mtimeMs ||
        directoryStat.size !== beforeDirectory.size
      ) {
        await protect(relative(canonicalRoot, canonicalDirectory));
        return 'candidate';
      }
      await recordItem({
        relativePath: relative(canonicalRoot, canonicalDirectory),
        displayName:
          relative(canonicalRoot, canonicalDirectory) === '.' ? basename(canonicalRoot) : undefined,
        kind: 'directory',
        size: directoryStat.size,
        mtimeMs: directoryStat.mtimeMs,
        pages,
        manifestSha256: manifestSha256(
          'directory',
          directoryStat.size,
          directoryStat.mtimeMs,
          pages,
        ),
        ...comicInfo,
        quarantinedReason: null,
      });
      recordMetadataIssues([
        ...(comicInfo.scanIssues ?? []),
        ...(comicInfo.comicInfo?.issues ?? []),
      ]);
      summary.discovered += 1;
      summary.pages += pages.length;
      return 'candidate';
    }
    if (direct.length && descendant !== 'none') summary.mixedParents += 1;
    return descendant;
  }

  await visit(root, 0);
  if (pending.length) await options.onItems?.(pending);
  if (protectedPaths.length) await options.onProtected?.(protectedPaths);
  return { items, summary };
}
