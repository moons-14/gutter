import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
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
  pages: readonly string[];
  comicInfo?: ComicInfoParseResult | null;
  scanIssues?: readonly ScanIssue[];
  quarantinedReason: ScanReason | null;
}>;

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
};

export type ScanResult = Readonly<{ items: readonly ScanItem[]; summary: ScanSummary }>;
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

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('scan aborted', 'AbortError');
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
): Promise<Pick<ScanItem, 'pages' | 'comicInfo' | 'scanIssues' | 'quarantinedReason'>> {
  const quotas = { ...defaultArchiveQuotas, ...quotaOverrides };
  checkAborted(signal);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return {
      pages: [],
      comicInfo: null,
      scanIssues: [],
      quarantinedReason: archiveErrorReason(error as Error),
    };
  }
  if (signal?.aborted) {
    await handle.close();
    checkAborted(signal);
  }
  return new Promise((resolve, reject) => {
    let zip: yauzl.ZipFile | undefined;
    let settled = false;
    let onAbort: (() => void) | undefined;
    const finish = (
      result?: Pick<ScanItem, 'pages' | 'comicInfo' | 'scanIssues' | 'quarantinedReason'>,
      error?: unknown,
    ) => {
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
            });
            return;
          }
          zip = zipFile;
          const archive = zipFile;
          const pages: string[] = [];
          const scanIssues: ScanIssue[] = [];
          let comicInfo: ComicInfoParseResult | null = null;
          const comicInfoEntries: yauzl.Entry[] = [];
          let entries = 0;
          let total = 0;
          let reason: ScanReason | null = null;
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
                const locator = page.normalize('NFC');
                if (locators.has(locator)) {
                  reason = 'duplicate_page_locator';
                  break;
                }
                locators.add(locator);
              }
            }
            finish({
              pages: reason ? [] : pages.sort(comparePages),
              comicInfo: reason ? null : comicInfo,
              scanIssues,
              quarantinedReason: reason,
            });
          };
          archive.on('error', (error: Error) => {
            reason ||= archiveErrorReason(error);
            complete();
          });
          archive.on('entry', (entry) => {
            if (signal?.aborted) return abort();
            entries += 1;
            total += entry.uncompressedSize;
            if (entries > quotas.entries) reason = 'archive_entry_limit';
            else if (entry.generalPurposeBitFlag & 1) reason = 'encrypted_archive';
            else if (unsafeZipPath(entry.fileName)) reason = 'archive_path_traversal';
            else if (entry.uncompressedSize > quotas.entryBytes) reason = 'archive_entry_too_large';
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
              pages.push(entry.fileName);
            if (reason) void complete();
            else if (signal?.aborted) abort();
            else archive.readEntry();
          });
          archive.on('end', () => void complete());
          if (signal?.aborted) abort();
          else archive.readEntry();
        },
      );
    } catch (error) {
      finish({
        pages: [],
        comicInfo: null,
        scanIssues: [],
        quarantinedReason: archiveErrorReason(error as Error),
      });
    }
  });
}

async function inspectDirectoryComicInfo(
  directory: string,
  names: readonly string[],
): Promise<{ comicInfo: ComicInfoParseResult | null; scanIssues: readonly ScanIssue[] }> {
  const candidates = names.filter((name) => name.toLowerCase() === 'comicinfo.xml');
  if (candidates.length === 0) return { comicInfo: null, scanIssues: [] };
  const exact = candidates.filter((name) => name === 'ComicInfo.xml');
  if (exact.length > 1 || (exact.length === 0 && candidates.length > 1))
    return {
      comicInfo: null,
      scanIssues: [{ code: 'comicinfo_ambiguous_name', rule: 'comicinfo-filename-v1' }],
    };
  const name = exact[0] ?? candidates[0]!;
  try {
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const bytes = Buffer.alloc(Math.min(stat.size, maxComicInfoBytes + 1));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) throw new Error('ComicInfo short read');
      return {
        comicInfo: parseComicInfo(bytes),
        scanIssues:
          name === 'ComicInfo.xml'
            ? []
            : [{ code: 'comicinfo_noncanonical_name', rule: 'comicinfo-filename-v1' }],
      };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      comicInfo: null,
      scanIssues: [{ code: 'comicinfo_read_failed', rule: 'comicinfo-filename-v1' }],
    };
  }
}

export async function scanRoot(root: string, signal?: AbortSignal): Promise<ScanResult> {
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
  };
  const items: ScanItem[] = [];
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
    if (depth > maxDepth) {
      summary.skipped += 1;
      return 'unknown-cutoff';
    }
    const canonicalDirectory = await realpath(directory);
    if (!contained(canonicalDirectory)) throw new Error('directory escaped validated root');
    const children: string[] = [];
    const direct: string[] = [];
    const files: string[] = [];
    // Re-realpath and containment are best-effort against host filesystem mutation races.
    const handle = await opendir(canonicalDirectory);
    try {
      for await (const entry of handle) {
        checkAborted(signal);
        const path = join(canonicalDirectory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) {
          summary.symlinks += 1;
        } else if (stat.isDirectory()) {
          children.push(path);
        } else if (stat.isFile()) {
          files.push(entry.name);
          if (isImage(entry.name)) direct.push(entry.name);
          else if (posix.extname(entry.name).toLowerCase() === '.cbz') {
            const inspected = await inspectCbz(path, {}, signal);
            items.push({
              relativePath: relative(canonicalRoot, path),
              kind: 'cbz',
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ...inspected,
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
      const childState = await visit(child, depth + 1);
      if (childState === 'candidate') descendant = 'candidate';
      else if (childState === 'unknown-cutoff' && descendant === 'none')
        descendant = 'unknown-cutoff';
    }
    if (direct.length && descendant === 'none') {
      const stat = await lstat(canonicalDirectory);
      const pages = direct.sort(comparePages);
      const comicInfo = await inspectDirectoryComicInfo(canonicalDirectory, files);
      items.push({
        relativePath: relative(canonicalRoot, canonicalDirectory),
        displayName:
          relative(canonicalRoot, canonicalDirectory) === '.' ? basename(canonicalRoot) : undefined,
        kind: 'directory',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        pages,
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
  return { items, summary };
}
