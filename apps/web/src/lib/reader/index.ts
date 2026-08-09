export type ReaderMode = 'paged' | 'spread' | 'vertical' | 'webtoon';
export type ReadingDirection = 'rtl' | 'ltr';

export type Presentation = Readonly<{
  mode: ReaderMode;
  direction: ReadingDirection;
  fit: 'contain' | 'width';
  zoom: number;
}>;

export type ReaderDescriptor = Readonly<{
  progressKey: string;
  revision: string;
  validOrdinals: number[];
  validPageCount: number;
  nextPublicationId: string | null;
}>;

export type ReaderState = Readonly<{
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
