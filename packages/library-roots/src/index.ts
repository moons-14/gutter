import { createHash } from 'node:crypto';
import { opendir, lstat, realpath } from 'node:fs/promises';
import { posix } from 'node:path';

const idPattern = /[a-z][a-z0-9-]{0,62}/;
const maxRoots = 64;
const maxPathLength = 4096;

export type LibraryRoot = Readonly<{ id: string; path: string }>;
export type LibraryRootState =
  | 'ready_nonempty'
  | 'ready_empty'
  | 'missing'
  | 'unreadable'
  | 'not_directory'
  | 'unavailable';
export type LibraryRootSnapshot = Readonly<{
  id: string;
  configuredPath: string;
  canonicalPath: string | null;
  state: LibraryRootState;
  reasonCode: string | null;
  checkedAt: Date;
}>;

export class LibraryRootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryRootConfigError';
  }
}

export class LibraryRootStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryRootStructuralError';
  }
}

export type AllowedRootsConfig = Readonly<{
  roots: readonly LibraryRoot[];
  canonicalJson: string;
  generation: string;
}>;

function normalizePath(value: string): string {
  if (
    value.includes('\0') ||
    value.length === 0 ||
    value.length > maxPathLength ||
    !value.startsWith('/')
  )
    throw new LibraryRootConfigError(
      'library root path must be an absolute POSIX path up to 4096 characters',
    );
  const normalizedPath = posix.normalize(value);
  if (normalizedPath === '/') throw new LibraryRootConfigError('library root path must not be /');
  const normalized = normalizedPath.replace(/\/+$/, '');
  return normalized;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseAllowedRoots(value: string): AllowedRootsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LibraryRootConfigError('GUTTER_ALLOWED_ROOTS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > maxRoots)
    throw new LibraryRootConfigError(
      'GUTTER_ALLOWED_ROOTS_JSON must be an array of at most 64 roots',
    );
  const roots = parsed.map((entry): LibraryRoot => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new LibraryRootConfigError('each library root must be an object with only id and path');
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, 'id') ||
      !Object.hasOwn(record, 'path') ||
      typeof record.id !== 'string' ||
      typeof record.path !== 'string'
    )
      throw new LibraryRootConfigError('each library root must be an object with only id and path');
    if (idPattern.exec(record.id)?.[0] !== record.id)
      throw new LibraryRootConfigError('library root id is invalid');
    return { id: record.id, path: normalizePath(record.path) };
  });
  roots.sort((left, right) => compareIds(left.id, right.id));
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (roots[index].id === roots[other].id)
        throw new LibraryRootConfigError('library root ids must be unique');
      if (overlaps(roots[index].path, roots[other].path))
        throw new LibraryRootConfigError('library root paths must not overlap');
    }
  }
  const canonicalJson = JSON.stringify(roots);
  return {
    roots,
    canonicalJson,
    generation: createHash('sha256').update(canonicalJson).digest('hex'),
  };
}

export type LibraryRootFileSystem = Readonly<{
  lstat: typeof lstat;
  realpath: typeof realpath;
  opendir: typeof opendir;
}>;

const fileSystem: LibraryRootFileSystem = { lstat, realpath, opendir };

function availability(error: unknown): Pick<LibraryRootSnapshot, 'state' | 'reasonCode'> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return { state: 'missing', reasonCode: 'ENOENT' };
  if (code === 'EACCES' || code === 'EPERM') return { state: 'unreadable', reasonCode: code };
  if (code === 'ENOTDIR') return { state: 'not_directory', reasonCode: 'ENOTDIR' };
  return { state: 'unavailable', reasonCode: typeof code === 'string' ? code : 'UNKNOWN' };
}

export async function validateLibraryRoots(
  roots: readonly LibraryRoot[],
  fs: LibraryRootFileSystem = fileSystem,
): Promise<LibraryRootSnapshot[]> {
  const snapshots: LibraryRootSnapshot[] = [];
  const canonicalPaths: string[] = [];
  for (const root of roots) {
    const checkedAt = new Date();
    try {
      const metadata = await fs.lstat(root.path);
      if (metadata.isSymbolicLink())
        throw new LibraryRootStructuralError(`library root ${root.id} is a symlink`);
      if (!metadata.isDirectory()) {
        snapshots.push({
          id: root.id,
          configuredPath: root.path,
          canonicalPath: null,
          state: 'not_directory',
          reasonCode: 'ENOTDIR',
          checkedAt,
        });
        continue;
      }
      const canonicalPath = await fs.realpath(root.path);
      if (canonicalPath !== root.path)
        throw new LibraryRootStructuralError(`library root ${root.id} contains a symlinked parent`);
      if (canonicalPaths.some((path) => overlaps(path, canonicalPath)))
        throw new LibraryRootStructuralError('canonical library root paths must not overlap');
      canonicalPaths.push(canonicalPath);
      const directory = await fs.opendir(root.path);
      try {
        const firstEntry = await directory.read();
        snapshots.push({
          id: root.id,
          configuredPath: root.path,
          canonicalPath,
          state: firstEntry === null ? 'ready_empty' : 'ready_nonempty',
          reasonCode: null,
          checkedAt,
        });
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (error instanceof LibraryRootStructuralError) throw error;
      const result = availability(error);
      snapshots.push({
        id: root.id,
        configuredPath: root.path,
        canonicalPath: null,
        checkedAt,
        ...result,
      });
    }
  }
  return snapshots;
}
