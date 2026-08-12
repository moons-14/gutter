import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultPresentation,
  clearNextHandoff,
  foregroundResourceKeys,
  gestureStep,
  loadPresentation,
  loadProgress,
  move,
  PageResourceScheduler,
  retainedResourceKeys,
  savePresentation,
  saveProgress,
  setPresentation,
  storeNextHandoff,
  takeNextHandoff,
  visibleOrdinals,
  type ReaderDescriptor,
  type ReaderState,
} from './index';

const descriptor: ReaderDescriptor = {
  rootId: 'root-1',
  progressKey: 'opaque-source-key',
  revision: 'revision:2',
  validOrdinals: [2, 4, 8, 10],
  validPageCount: 4,
  nextPublicationId: null,
};

function state(mode = defaultPresentation.mode): ReaderState {
  return {
    releaseId: '42',
    descriptor,
    ordinal: 4,
    presentation: { ...defaultPresentation, mode },
    persistProgress: true,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  clearNextHandoff();
  vi.unstubAllGlobals();
});

describe('reader state', () => {
  it('navigates exclusively through valid ordinals', () => {
    expect(move(state(), 1).ordinal).toBe(8);
    expect(move({ ...state(), ordinal: 10 }, 1).ordinal).toBe(10);
    expect(move({ ...state(), ordinal: 3 }, 1).ordinal).toBe(3);
  });

  it('groups only validated adjacent ordinals in spread mode', () => {
    expect(visibleOrdinals(state('spread'))).toEqual([8, 4]);
    expect(move(state('spread'), 1).ordinal).toBe(10);
    expect(visibleOrdinals({ ...state('spread'), ordinal: 10 })).toEqual([10]);
  });

  it('keeps continuous modes in a bounded virtual ordinal window', () => {
    expect(visibleOrdinals(state('vertical'))).toEqual([2, 4, 8]);
    expect(visibleOrdinals({ ...state('webtoon'), ordinal: 10 })).toEqual([8, 10]);
  });

  it('prioritizes the next publication inside the final two pages in spread and continuous modes', () => {
    const next = { ...descriptor, nextPublicationId: '99' };
    expect(retainedResourceKeys({ ...state('spread'), descriptor: next, ordinal: 8 }, 1)).toEqual([
      'page:8',
      'page:10',
      'next:99',
    ]);
    const continuous = retainedResourceKeys(
      { ...state('vertical'), descriptor: next, ordinal: 8 },
      1,
    );
    expect(continuous).toEqual(['page:8', 'page:10', 'next:99']);
    expect(continuous).not.toContain('page:4');
  });

  it('dispatches the active ordinal before visible companions in vertical and RTL spread modes', () => {
    expect(foregroundResourceKeys({ ...state('vertical'), ordinal: 8 }, 1)).toEqual([
      'page:8',
      'page:10',
      'page:4',
    ]);
    expect(foregroundResourceKeys({ ...state('spread'), ordinal: 4 }, 1)).toEqual([
      'page:4',
      'page:8',
    ]);
  });

  it('clamps zoom and maps swipe direction', () => {
    expect(setPresentation(state(), { zoom: 20 }).presentation.zoom).toBe(3);
    expect(gestureStep(200, 20, 500, 'ltr')).toBe(1);
    expect(gestureStep(200, 20, 500, 'rtl')).toBe(1);
    expect(gestureStep(200, 190, 500, 'ltr')).toBeNull();
  });
});

describe('browser-local reader state', () => {
  it('validates versioned presentation and exact revision progress', () => {
    localStorage.setItem('gutter.reader.presentation.v1', '{"mode":"unknown","zoom":99}');
    expect(loadPresentation()).toEqual({ ...defaultPresentation, zoom: 3 });
    savePresentation({ ...defaultPresentation, mode: 'webtoon', zoom: 1.5 });
    expect(loadPresentation().mode).toBe('webtoon');

    saveProgress(descriptor, 8);
    expect(loadProgress(descriptor)).toBe(8);
    expect(loadProgress({ ...descriptor, revision: 'revision:3' })).toBeNull();
    expect(loadProgress({ ...descriptor, validOrdinals: [2, 4] })).toBeNull();
    saveProgress({ ...descriptor, progressKey: 'another-source' }, 4);
    expect(loadProgress(descriptor)).toBe(8);
  });
});

describe('ephemeral page scheduler', () => {
  it('limits work to one foreground plus one prefetch and revokes evicted Blob URLs', async () => {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve({ ok: true, status: 200, blob: async () => new Blob(['page']) } as Response);
          });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const create = vi.fn((blob: Blob) => `blob:${blob.size}:${create.mock.calls.length}`);
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const scheduler = new PageResourceScheduler(
      (page) => `/pages/${page}`,
      () => {},
      () => {},
    );

    try {
      scheduler.request('page:2', 'foreground');
      scheduler.request('page:4', 'foreground');
      scheduler.request('page:8', 'prefetch');
      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(maximumInFlight).toBeLessThanOrEqual(2);
      pending.shift()?.();
      // Completion crosses response, Blob, resource ownership, finally, and drain microtasks.
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(maximumInFlight).toBeLessThanOrEqual(2);
      pending.forEach((resolve) => resolve());
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      expect(scheduler.usage().resources).toBeLessThanOrEqual(3);
      expect(scheduler.usage().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      scheduler.retain(['page:2']);
      expect(revoke).toHaveBeenCalled();
    } finally {
      scheduler.clear();
      pending.forEach((resolve) => resolve());
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    }
  });

  it('queues an immediately re-requested aborted page without opening a third request', async () => {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            pending.push(() => {
              inFlight -= 1;
              resolve({ ok: true, status: 200, blob: async () => new Blob(['page']) } as Response);
            });
          }),
      ),
    );
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:page'), revokeObjectURL: vi.fn() });
    const scheduler = new PageResourceScheduler(
      (key) => `/pages/${key}`,
      () => {},
      () => {},
    );
    scheduler.request('page:4', 'foreground');
    await Promise.resolve();
    scheduler.retain([]);
    scheduler.request('page:4', 'foreground');
    expect(maximumInFlight).toBe(1);
    pending.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(maximumInFlight).toBeLessThanOrEqual(1);
    pending.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    scheduler.clear();
  });

  it('starts the active page before a retained continuous-mode prior page', async () => {
    const started: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options: RequestInit) => {
        started.push(url);
        return new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }),
    );
    const scheduler = new PageResourceScheduler(
      (key) => `/pages/${key}`,
      () => {},
      () => {},
    );
    for (const key of foregroundResourceKeys({ ...state('vertical'), ordinal: 8 }, 1))
      scheduler.request(key, 'foreground');
    await Promise.resolve();
    expect(started).toEqual(['/pages/page:8']);
    scheduler.clear();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.usage()).toEqual({ resources: 0, bytes: 0, active: 0 });
  });

  it('transfers one next-publication Blob URL into the destination without a second byte fetch', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:page'), revokeObjectURL: revoke });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    storeNextHandoff({
      publicationId: '9',
      releaseId: '43',
      ordinal: 1,
      resource: { url: 'blob:next', bytes: 4 },
    });
    const handoff = takeNextHandoff('9');
    expect(handoff?.resource.url).toBe('blob:next');
    const scheduler = new PageResourceScheduler(
      (key) => `/pages/${key}`,
      () => {},
      () => {},
    );
    expect(scheduler.adopt('page:1', handoff!.resource)).toBe(true);
    scheduler.request('page:1', 'foreground');
    expect(fetcher).not.toHaveBeenCalled();
    scheduler.clear();
    expect(revoke).toHaveBeenCalledWith('blob:next');
  });

  it('clears an unconsumed handoff timer and its owned Blob URL', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: revoke });
    storeNextHandoff({
      publicationId: '9',
      releaseId: '43',
      ordinal: 1,
      resource: { url: 'blob:pending', bytes: 4 },
    });
    clearNextHandoff();
    expect(revoke).toHaveBeenCalledWith('blob:pending');
    expect(takeNextHandoff('9')).toBeNull();
  });

  it('quiesces a failed retained prefetch until an explicit retry', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetcher);
    const scheduler = new PageResourceScheduler(
      (key) => `/pages/${key}`,
      () => {},
      () => {},
    );
    scheduler.request('next:9', 'prefetch');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(scheduler.failure('next:9')).toBe('unavailable');
    scheduler.request('next:9', 'prefetch');
    expect(fetcher).toHaveBeenCalledTimes(2);
    scheduler.retry('next:9', 'prefetch');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(4);
    scheduler.clear();
  });

  it('publishes an unavailable failure when the Blob budget is exhausted', async () => {
    let changed = 0;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:over-budget'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array(3 * 1024 * 1024)]),
      })),
    );
    const scheduler = new PageResourceScheduler(
      (key) => `/pages/${key}`,
      () => (changed += 1),
      () => {},
    );
    for (const key of ['page:1', 'page:2', 'page:3'])
      expect(scheduler.adopt(key, { url: `blob:${key}`, bytes: 10 * 1024 * 1024 })).toBe(true);
    scheduler.request('page:4', 'foreground');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(scheduler.failure('page:4')).toBe('unavailable');
    expect(changed).toBeGreaterThan(3);
    scheduler.clear();
  });
});
