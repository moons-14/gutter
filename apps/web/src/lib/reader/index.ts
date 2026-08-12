export type ReaderMode = 'paged' | 'spread' | 'vertical' | 'webtoon';
export type ReadingDirection = 'rtl' | 'ltr';

export type Presentation = Readonly<{
  mode: ReaderMode;
  direction: ReadingDirection;
  fit: 'contain' | 'width';
  zoom: number;
}>;

export type ReaderDescriptor = Readonly<{
  rootId: string;
  progressKey: string;
  revision: string;
  validOrdinals: number[];
  validPageCount: number;
  nextPublicationId: string | null;
}>;

export type ReaderState = Readonly<{
  releaseId: string;
  descriptor: ReaderDescriptor;
  ordinal: number;
  presentation: Presentation;
  persistProgress: boolean;
}>;

export const defaultPresentation: Presentation = {
  mode: 'paged',
  direction: 'rtl',
  fit: 'contain',
  zoom: 1,
};

const modes = new Set<ReaderMode>(['paged', 'spread', 'vertical', 'webtoon']);
const directions = new Set<ReadingDirection>(['rtl', 'ltr']);
const fits = new Set<Presentation['fit']>(['contain', 'width']);

export function validPresentation(value: unknown): Presentation {
  if (!value || typeof value !== 'object') return defaultPresentation;
  const input = value as Partial<Presentation>;
  return {
    mode: modes.has(input.mode as ReaderMode)
      ? (input.mode as ReaderMode)
      : defaultPresentation.mode,
    direction: directions.has(input.direction as ReadingDirection)
      ? (input.direction as ReadingDirection)
      : defaultPresentation.direction,
    fit: fits.has(input.fit as Presentation['fit'])
      ? (input.fit as Presentation['fit'])
      : defaultPresentation.fit,
    zoom:
      typeof input.zoom === 'number' && Number.isFinite(input.zoom)
        ? Math.min(3, Math.max(1, input.zoom))
        : 1,
  };
}

/** The descriptor's validated ordinal list is the only navigation authority. */
export function visibleOrdinals(state: ReaderState): number[] {
  const { validOrdinals } = state.descriptor;
  const index = validOrdinals.indexOf(state.ordinal);
  if (index < 0) return [];
  if (state.presentation.mode === 'vertical' || state.presentation.mode === 'webtoon') {
    // A small virtual window supports continuous scrolling without retaining every page URL.
    return validOrdinals.slice(Math.max(0, index - 1), Math.min(validOrdinals.length, index + 2));
  }
  if (state.presentation.mode !== 'spread') return [state.ordinal];
  const adjacent = validOrdinals[index + 1];
  const pages = adjacent === undefined ? [state.ordinal] : [state.ordinal, adjacent];
  return state.presentation.direction === 'rtl' ? pages.reverse() : pages;
}

/** Priority order for the bounded in-memory byte window. */
export function retainedResourceKeys(state: ReaderState, direction: -1 | 1): string[] {
  const ordinals = state.descriptor.validOrdinals;
  const index = ordinals.indexOf(state.ordinal);
  if (index < 0) return [];
  const pageKey = (ordinal: number) => `page:${ordinal}`;
  const visible = visibleOrdinals(state);
  const forwardVisible = visible
    .filter((ordinal) => ordinal !== state.ordinal && ordinals.indexOf(ordinal) >= index)
    .map(pageKey);
  const remainingVisible = visible
    .filter((ordinal) => ordinal !== state.ordinal && !forwardVisible.includes(pageKey(ordinal)))
    .map(pageKey);
  const ahead = ordinals[index + direction];
  const next =
    index >= ordinals.length - 2 && state.descriptor.nextPublicationId
      ? `next:${state.descriptor.nextPublicationId}`
      : null;
  return [
    ...new Set([
      pageKey(state.ordinal),
      ...forwardVisible,
      ...(next ? [next] : []),
      ...(ahead === undefined ? [] : [pageKey(ahead)]),
      ...remainingVisible,
    ]),
  ].slice(0, 3);
}

/** Foreground dispatch is deliberately current-first, independent of visual page order. */
export function foregroundResourceKeys(state: ReaderState, direction: -1 | 1): string[] {
  const retained = retainedResourceKeys(state, direction);
  const current = `page:${state.ordinal}`;
  return [current, ...retained.filter((key) => key.startsWith('page:'))].filter(
    (key, index, keys) => keys.indexOf(key) === index,
  );
}

export function move(state: ReaderState, step: -1 | 1): ReaderState {
  const ordinals = state.descriptor.validOrdinals;
  const index = ordinals.indexOf(state.ordinal);
  if (index < 0) return state;
  const stride = state.presentation.mode === 'spread' ? 2 : 1;
  const next = ordinals[index + step * stride];
  return next === undefined ? state : { ...state, ordinal: next };
}

export function canMove(state: ReaderState, step: -1 | 1): boolean {
  return move(state, step) !== state;
}

export function setPresentation(state: ReaderState, update: Partial<Presentation>): ReaderState {
  return { ...state, presentation: validPresentation({ ...state.presentation, ...update }) };
}

export function pagePosition(state: ReaderState): { current: number; total: number } {
  return {
    current: state.descriptor.validOrdinals.indexOf(state.ordinal) + 1,
    total: state.descriptor.validOrdinals.length,
  };
}

export function gestureStep(
  startX: number,
  endX: number,
  width: number,
  direction: ReadingDirection,
): -1 | 1 | null {
  const distance = endX - startX;
  if (Math.abs(distance) < Math.max(32, width * 0.08)) return null;
  // A leftward turn advances in either reading direction; direction changes page placement,
  // not the physical gesture used to turn to the following page.
  return distance < 0 ? 1 : -1;
}

const presentationStorageKey = 'gutter.reader.presentation.v1';
const progressStorageKey = 'gutter.reader.progress.v1';
type Progress = Readonly<{ revision: string; ordinal: number }>;
type ProgressMap = Readonly<Record<string, Progress>>;

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function loadPresentation(): Presentation {
  try {
    const raw = browserStorage()?.getItem(presentationStorageKey);
    return validPresentation(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPresentation;
  }
}

export function savePresentation(presentation: Presentation): void {
  try {
    browserStorage()?.setItem(
      presentationStorageKey,
      JSON.stringify(validPresentation(presentation)),
    );
  } catch {
    /* local preference is optional */
  }
}

export function loadProgress(descriptor: ReaderDescriptor): number | null {
  try {
    const raw = browserStorage()?.getItem(progressStorageKey);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return null;
    const progress = (value as ProgressMap)[descriptor.progressKey];
    return progress?.revision === descriptor.revision &&
      typeof progress.ordinal === 'number' &&
      descriptor.validOrdinals.includes(progress.ordinal)
      ? progress.ordinal
      : null;
  } catch {
    return null;
  }
}

export function saveProgress(descriptor: ReaderDescriptor, ordinal: number): void {
  if (!descriptor.validOrdinals.includes(ordinal)) return;
  try {
    const storage = browserStorage();
    const raw = storage?.getItem(progressStorageKey);
    const existing: unknown = raw ? JSON.parse(raw) : {};
    const entries = existing && typeof existing === 'object' ? (existing as ProgressMap) : {};
    storage?.setItem(
      progressStorageKey,
      JSON.stringify({
        ...entries,
        [descriptor.progressKey]: { revision: descriptor.revision, ordinal } satisfies Progress,
      }),
    );
  } catch {
    /* progress is optional */
  }
}

export type PageResource = Readonly<{ url: string; bytes: number }>;
export type PageLoadFailure = 'offline' | 'unavailable' | 'missing' | 'stale';

/**
 * A deliberately small, route-owned reader byte window.  Page bytes never enter
 * CacheStorage: object URLs are revoked whenever the window, revision, or route
 * changes. There is at most one foreground and one directional speculative request.
 */
export class PageResourceScheduler {
  private readonly resources = new Map<string, PageResource>();
  private readonly foreground = new Map<string, AbortController>();
  private readonly prefetch = new Map<string, AbortController>();
  private readonly queuedForeground = new Set<string>();
  private readonly queuedPrefetch = new Set<string>();
  private readonly failures = new Map<string, PageLoadFailure>();

  constructor(
    private readonly pageUrl: (key: string, signal: AbortSignal) => string | Promise<string>,
    private readonly changed: () => void,
    private readonly stale: () => void,
    private readonly ready?: (key: string) => void,
  ) {}

  get(key: string): PageResource | undefined {
    return this.resources.get(key);
  }
  failure(key: string): PageLoadFailure | undefined {
    return this.failures.get(key);
  }
  usage(): Readonly<{ resources: number; bytes: number; active: number }> {
    return {
      resources: this.resources.size,
      bytes: this.totalBytes(),
      active: this.foreground.size + this.prefetch.size,
    };
  }

  take(key: string): PageResource | undefined {
    const resource = this.resources.get(key);
    if (resource) this.resources.delete(key);
    return resource;
  }

  adopt(key: string, resource: PageResource): boolean {
    if (this.resources.size >= 3 || this.totalBytes() + resource.bytes > 32 * 1024 * 1024)
      return false;
    this.resources.set(key, resource);
    this.changed();
    return true;
  }

  request(key: string, priority: 'foreground' | 'prefetch'): void {
    if (this.resources.has(key) || this.failures.has(key)) return;
    const active = this.foreground.get(key) ?? this.prefetch.get(key);
    if (active && !active.signal.aborted) return;
    (priority === 'foreground' ? this.queuedForeground : this.queuedPrefetch).add(key);
    this.drain();
  }

  retry(key: string, priority: 'foreground' | 'prefetch'): void {
    this.failures.delete(key);
    this.request(key, priority);
  }

  retain(keys: string[]): void {
    const wanted = new Set(keys.slice(0, 3));
    for (const [key, resource] of this.resources) {
      if (!wanted.has(key)) {
        URL.revokeObjectURL(resource.url);
        this.resources.delete(key);
        this.failures.delete(key);
      }
    }
    for (const [key, controller] of [...this.foreground, ...this.prefetch]) {
      if (!wanted.has(key)) {
        controller.abort();
      }
    }
    for (const key of [...this.queuedForeground, ...this.queuedPrefetch]) {
      if (!wanted.has(key)) {
        this.queuedForeground.delete(key);
        this.queuedPrefetch.delete(key);
      }
    }
  }

  clear(): void {
    this.retain([]);
  }

  private drain(): void {
    while (this.foreground.size < 1 && this.queuedForeground.size) {
      const key = this.queuedForeground.values().next().value as string;
      this.queuedForeground.delete(key);
      this.load(key, 'foreground');
    }
    while (this.prefetch.size < 1 && this.queuedPrefetch.size) {
      const key = this.queuedPrefetch.values().next().value as string;
      this.queuedPrefetch.delete(key);
      this.load(key, 'prefetch');
    }
  }

  private async load(key: string, priority: 'foreground' | 'prefetch'): Promise<void> {
    const active = priority === 'foreground' ? this.foreground : this.prefetch;
    const controller = new AbortController();
    active.set(key, controller);
    try {
      let response: Response | undefined;
      // Network/offline and 503 retry once, never indefinitely.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(await this.pageUrl(key, controller.signal), {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.status !== 503 || attempt === 1) break;
        } catch (error) {
          if (controller.signal.aborted || attempt === 1) throw error;
        }
      }
      if (!response) throw new Error('network');
      if (response.status === 404 || response.status === 409) {
        this.stale();
        return;
      }
      if (!response.ok) throw new Error(`http:${response.status}`);
      const blob = await response.blob();
      if (controller.signal.aborted || blob.size + this.totalBytes() > 32 * 1024 * 1024) {
        if (!controller.signal.aborted) {
          this.failures.set(key, 'unavailable');
          this.changed();
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      if (this.resources.size >= 3) {
        URL.revokeObjectURL(url);
        this.failures.set(key, 'unavailable');
        this.changed();
        return;
      }
      this.resources.set(key, { url, bytes: blob.size });
      this.changed();
      this.ready?.(key);
    } catch (error) {
      // The route renders an honest per-page retry affordance for foreground work.
      if (!controller.signal.aborted) {
        this.failures.set(key, navigator.onLine === false ? 'offline' : 'unavailable');
      }
      this.changed();
    } finally {
      if (active.get(key) === controller) active.delete(key);
      this.drain();
    }
  }

  private totalBytes(): number {
    return [...this.resources.values()].reduce((total, resource) => total + resource.bytes, 0);
  }
}

type NextHandoff = Readonly<{
  publicationId: string;
  releaseId: string;
  ordinal: number;
  resource: PageResource;
}>;

let nextHandoff: NextHandoff | null = null;
let nextHandoffExpiry: ReturnType<typeof setTimeout> | null = null;

/** One short-lived, in-memory-only Blob ownership transfer between reader routes. */
export function storeNextHandoff(handoff: NextHandoff): void {
  if (nextHandoff) URL.revokeObjectURL(nextHandoff.resource.url);
  if (nextHandoffExpiry) clearTimeout(nextHandoffExpiry);
  nextHandoff = handoff;
  nextHandoffExpiry = setTimeout(() => {
    if (nextHandoff === handoff) {
      URL.revokeObjectURL(handoff.resource.url);
      nextHandoff = null;
      nextHandoffExpiry = null;
    }
  }, 30_000);
}

export function takeNextHandoff(publicationId: string): NextHandoff | null {
  if (!nextHandoff || nextHandoff.publicationId !== publicationId) return null;
  const handoff = nextHandoff;
  nextHandoff = null;
  if (nextHandoffExpiry) clearTimeout(nextHandoffExpiry);
  nextHandoffExpiry = null;
  return handoff;
}

/** Test/runtime disposal for an unconsumed handoff; route teardown intentionally does not call this. */
export function clearNextHandoff(): void {
  if (nextHandoff) URL.revokeObjectURL(nextHandoff.resource.url);
  nextHandoff = null;
  if (nextHandoffExpiry) clearTimeout(nextHandoffExpiry);
  nextHandoffExpiry = null;
}
