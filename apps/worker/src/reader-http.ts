import { lstat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openReaderStream, ReaderStreamError, ReaderStreamLimiter } from '@gutter/reader-stream';

export type AuthorizedPage = Readonly<{
  rootId: string;
  relativePath: string;
  kind: 'directory' | 'cbz';
  ordinal: number;
  locator: string;
  observed: {
    size: number;
    mtimeNs?: string;
    compressedSize?: number;
    uncompressedSize?: number;
    crc32?: number;
  };
  sourceSize: number;
  sourceMtimeMs: number;
}>;
export type ReaderHttpDependencies = Readonly<{
  roots: ReadonlyMap<string, { canonicalPath: string }>;
  authorize: (releaseId: string, ordinal: number) => Promise<AuthorizedPage | null>;
  limiter?: ReaderStreamLimiter;
  shutdownSignal?: AbortSignal;
}>;

const route = /^\/api\/reader\/releases\/([1-9][0-9]*)\/pages\/([0-9]+)$/;
function range(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value || !/^bytes=/.test(value) || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;
  const [, first, last] = match;
  let start: number;
  let end: number;
  if (!first && last) {
    const length = Number(last);
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(first);
    end = last ? Number(last) : size - 1;
  }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { start, end: Math.min(end, size - 1) }
    : null;
}
function errorStatus(error: unknown): number {
  if (error instanceof ReaderStreamError)
    return error.code === 'queue_full' ? 503 : error.code === 'cancelled' ? 499 : 409;
  if (['EACCES', 'EIO', 'ENOENT', 'ESTALE'].includes((error as NodeJS.ErrnoException).code ?? ''))
    return 409;
  return 500;
}
function send(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
  response.end();
}
function notModified(request: IncomingMessage, etag: string, modifiedAt: number): boolean {
  const tags = request.headers['if-none-match'];
  if (tags)
    return (
      tags
        .split(',')
        .map((tag) => tag.trim())
        .includes(etag) || tags.trim() === '*'
    );
  const since = request.headers['if-modified-since'];
  const parsed = since && Date.parse(since);
  return typeof parsed === 'number' && Number.isFinite(parsed) && modifiedAt <= parsed + 999;
}
async function* selectedDirectoryBytes(
  source: Readable,
  selected: { start: number; end: number },
): AsyncGenerator<Buffer> {
  let offset = 0;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    const begin = Math.max(0, selected.start - offset);
    const end = Math.min(chunk.length, selected.end + 1 - offset);
    offset += chunk.length;
    if (end > begin) yield chunk.subarray(begin, end);
    if (offset > selected.end) {
      source.destroy();
      return;
    }
  }
}

/** Internal-only worker listener.  The proxy route, not source paths, is the public contract. */
export function createReaderHttpServer(deps: ReaderHttpDependencies): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (deps.shutdownSignal?.aborted) return send(response, 503);
    const match = request.url && route.exec(new URL(request.url, 'http://worker').pathname);
    if (!match || !['GET', 'HEAD'].includes(request.method ?? '')) return send(response, 404);
    const ordinal = Number(match[2]);
    const authorized = await deps.authorize(match[1]!, ordinal).catch(() => null);
    const root = authorized && deps.roots.get(authorized.rootId);
    if (!authorized || !root) return send(response, 404);
    const etagValue = [match[1], ordinal, authorized.observed.size, authorized.sourceMtimeMs].join(
      '-',
    );
    const etag = `W/\"${etagValue}\"`;
    const lastModified = new Date(authorized.sourceMtimeMs).toUTCString();
    const abort = new AbortController();
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    const signal = deps.shutdownSignal
      ? AbortSignal.any([abort.signal, deps.shutdownSignal])
      : abort.signal;
    try {
      const sourcePath = join(root.canonicalPath, authorized.relativePath);
      const sourceStat = await lstat(sourcePath, { bigint: true });
      const sourceMatches =
        Number(sourceStat.size) === authorized.sourceSize &&
        Number(sourceStat.mtimeNs / 1_000_000n) === Math.trunc(authorized.sourceMtimeMs) &&
        (authorized.kind === 'directory' ? sourceStat.isDirectory() : sourceStat.isFile());
      if (!sourceMatches) return send(response, 409);
      const opened = await openReaderStream({
        source: {
          root: root.canonicalPath,
          relativePath: authorized.relativePath,
          kind: authorized.kind,
          observed: {
            dev: sourceStat.dev,
            ino: sourceStat.ino,
            size: sourceStat.size,
            mtimeNs: sourceStat.mtimeNs,
          },
        },
        page: {
          locator: authorized.locator,
          observed: {
            ...authorized.observed,
            mtimeNs: authorized.observed.mtimeNs ? BigInt(authorized.observed.mtimeNs) : undefined,
          },
        },
        signal,
        limiter: deps.limiter,
      });
      if (notModified(request, etag, authorized.sourceMtimeMs)) {
        opened.stream.destroy();
        response.writeHead(304, {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'private, no-cache',
        });
        return response.end();
      }
      const requested = request.headers.range;
      if (authorized.kind === 'cbz' && requested) {
        // Entries are decompressed streams: deliberately no byte-range contract for CBZ pages.
        response.setHeader('Accept-Ranges', 'none');
      }
      const selected =
        authorized.kind === 'directory' && requested ? range(requested, opened.size) : undefined;
      if (authorized.kind === 'directory' && requested && !selected) {
        opened.stream.destroy();
        response.writeHead(416, {
          'Content-Range': `bytes */${opened.size}`,
          ETag: etag,
          'Cache-Control': 'private, no-cache',
        });
        return response.end();
      }
      const headers: Record<string, string | number> = {
        'Content-Type': opened.mediaType,
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'Last-Modified': lastModified,
        Vary: 'Range',
        'Accept-Ranges': authorized.kind === 'directory' ? 'bytes' : 'none',
      };
      if (selected) {
        headers['Content-Range'] = `bytes ${selected.start}-${selected.end}/${opened.size}`;
        headers['Content-Length'] = selected.end - selected.start + 1;
      } else headers['Content-Length'] = opened.size;
      response.writeHead(selected ? 206 : 200, headers);
      if (request.method === 'HEAD') {
        opened.stream.destroy();
        return response.end();
      }
      if (selected) {
        await pipeline(Readable.from(selectedDirectoryBytes(opened.stream, selected)), response, {
          signal,
        });
      } else await pipeline(opened.stream, response, { signal });
    } catch (error) {
      if (!response.headersSent) send(response, errorStatus(error));
      else response.destroy();
    }
  });
}

export function startReaderHttpServer(deps: ReaderHttpDependencies, port = 3001): Server {
  const server = createReaderHttpServer(deps);
  server.listen(port, '0.0.0.0');
  return server;
}
