import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from './releases/[id]/+page.svelte';
import { clearNextHandoff } from '$lib/reader';
import { session } from '$lib/session';

const release = {
  rootId: 'root-1',
  progressKey: 'opaque-key',
  revision: 'sha:1',
  validOrdinals: [1, 3, 5],
  validPageCount: 3,
  nextPublicationId: '12',
};

afterEach(() => {
  cleanup();
  clearNextHandoff();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  session.set({ loading: true, user: null });
});

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:reader-page'),
    revokeObjectURL: vi.fn(),
  });
});

function readerFetch() {
  return vi.fn(async (input: string) =>
    input.includes('/pages/')
      ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
      : { ok: true, status: 200, json: async () => ({ release }) },
  );
}

describe('reader interaction UI', () => {
  it('makes access denial and empty-source failures actionable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    render(Reader, { data: { id: 'denied' } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('アクセスが許可されていません'),
    );
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ release: { ...release, validOrdinals: [], validPageCount: 0 } }),
      })),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('読めるページがありません'),
    );
  });

  it('renders labelled controls and only navigates valid ordinals', async () => {
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    expect(screen.getByText('1 / 3')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'ページ 2' }).getAttribute('src')).toContain(
        'blob:reader-page',
      ),
    );
    expect(screen.getByRole('combobox', { name: '表示形式' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全画面表示' })).toBeTruthy();
  });

  it('starts at a valid explicit resume ordinal and rejects invalid page requests', async () => {
    window.history.replaceState({}, '', '/reader/releases/7?resume=3');
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '続きから読む' })).toBeNull();

    cleanup();
    window.history.replaceState({}, '', '/reader/releases/7?resume=2');
    localStorage.setItem(
      'gutter.reader.progress.v1',
      JSON.stringify({ 'opaque-key': { revision: 'sha:1', ordinal: 5 } }),
    );
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '続きから読む' })).toBeNull();

    cleanup();
    localStorage.clear();
    window.history.replaceState({}, '', '/reader/releases/7?resume=0');
    const zeroBasedRelease = { ...release, validOrdinals: [0, 2], validPageCount: 2 };
    const zeroFetcher = vi.fn(async (input: string) =>
      input.includes('/pages/')
        ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
        : { ok: true, status: 200, json: async () => ({ release: zeroBasedRelease }) },
    );
    vi.stubGlobal('fetch', zeroFetcher);
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByText('1 / 2')).toBeTruthy());
    expect(zeroFetcher.mock.calls.some(([url]) => String(url).includes('/pages/0'))).toBe(true);
  });

  it('keeps publication and release identities separate when their numeric IDs collide', async () => {
    const fetcher = vi.fn(async (input: string) =>
      input.includes('/publications/42')
        ? { ok: true, status: 200, json: async () => ({ session: { releaseId: '9', release } }) }
        : input.includes('/pages/')
          ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
          : { ok: false, status: 404, json: async () => ({ release: null }) },
    );
    vi.stubGlobal('fetch', fetcher);
    render(Reader, { data: { id: '42' }, publication: true });
    await waitFor(() => expect(screen.getByRole('img', { name: 'ページ 1' })).toBeTruthy());
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/releases/42'))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/releases/9/pages/1'))).toBe(
      true,
    );
  });

  it('rejects malformed publication session release IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('/publications/')
          ? { ok: true, status: 200, json: async () => ({ session: { releaseId: '-1', release } }) }
          : { ok: true, status: 200, blob: async () => new Blob(['page']) },
      ),
    );
    render(Reader, { data: { id: '42' }, publication: true });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('見つからないか'));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does not interpolate malformed speculative next-release IDs', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls.push(input);
        if (input.includes('/publications/12'))
          return {
            ok: true,
            status: 200,
            json: async () => ({ session: { releaseId: '-9', release } }),
          };
        if (input.includes('/pages/'))
          return { ok: true, status: 200, blob: async () => new Blob(['page']) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ release: { ...release, nextPublicationId: '12' } }),
        };
      }),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('img', { name: 'ページ 1' })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.some((input) => input.includes('/releases/-9/'))).toBe(false);
  });

  it('maps descriptor statuses and retry recovery without exposing source details', async () => {
    for (const [status, message] of [
      [401, 'アクセスが許可されていません'],
      [404, '見つからないか'],
      [502, '現在利用できません'],
      [503, '現在利用できません'],
      [504, '現在利用できません'],
    ] as const) {
      cleanup();
      let attempt = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          attempt++ === 0
            ? { ok: false, status, json: async () => ({}) }
            : { ok: true, status: 200, json: async () => ({ release }) },
        ),
      );
      render(Reader, { data: { id: '7' } });
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
      await fireEvent.click(screen.getByRole('button', { name: '再試行' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    }
    cleanup();
    let networkAttempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/pages/'))
          return { ok: false, status: 0, blob: async () => new Blob() };
        if (networkAttempt++ === 0) throw new Error('offline');
        return { ok: true, status: 200, json: async () => ({ release }) };
      }),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('現在利用できません'),
    );
    await fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
  });

  it('hands a completed next-page Blob to the destination reader without a second byte fetch', async () => {
    const finalRelease = {
      ...release,
      validOrdinals: [1, 3],
      validPageCount: 2,
      nextPublicationId: '9',
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        calls.push(input);
        if (input.includes('/publications/9'))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              session: { releaseId: '43', release: { ...finalRelease, nextPublicationId: null } },
            }),
          };
        if (input.includes('/releases/42') && !input.includes('/pages/'))
          return { ok: true, status: 200, json: async () => ({ release: finalRelease }) };
        return { ok: true, status: 200, blob: async () => new Blob(['page']) };
      }),
    );
    render(Reader, { data: { id: '42' } });
    await waitFor(() =>
      expect(calls.some((url) => url.includes('/releases/43/pages/1'))).toBe(true),
    );
    cleanup();
    render(Reader, { data: { id: '9' }, publication: true });
    await waitFor(() => expect(screen.getByRole('img', { name: 'ページ 1' })).toBeTruthy());
    expect(calls.filter((url) => url.includes('/releases/43/pages/1'))).toHaveLength(1);
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-page');
  });

  it('offers revision-matched resume and keeps navigation after a page error', async () => {
    localStorage.setItem(
      'gutter.reader.progress.v1',
      JSON.stringify({ 'opaque-key': { revision: 'sha:1', ordinal: 3 } }),
    );
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '続きから読む' })).toBeTruthy());
    expect(screen.getByText('1 / 3')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: '続きから読む' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();
    await fireEvent.error(screen.getByRole('img', { name: 'ページ 2' }));
    expect(screen.getByRole('alert').textContent).toContain('表示できません');
    expect(screen.getByRole('button', { name: '前のページ' })).toBeTruthy();
  });

  it('loads authenticated remote progress once and preserves it as the resume choice', async () => {
    session.set({ loading: false, user: { id: 'user-1' } });
    const fetcher = vi.fn(async (input: string) =>
      input.includes('/user-state/progress?')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ progress: { revision: 4, pageOrdinal: 3 } }),
          }
        : input.includes('/pages/')
          ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
          : { ok: true, status: 200, json: async () => ({ release }) },
    );
    vi.stubGlobal('fetch', fetcher);
    render(Reader, { data: { id: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'リーダーのページ操作' })).toBeTruthy(),
    );
    const surface = screen.getByRole('button', { name: 'リーダーのページ操作' });
    surface.focus();
    await waitFor(() => expect(screen.getByRole('button', { name: '続きから読む' })).toBeTruthy());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '続きから読む' })),
    );
    await fireEvent.click(screen.getByRole('button', { name: '続きから読む' }));
    expect(document.activeElement).toBe(surface);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('/user-state/progress?')),
    ).toHaveLength(1);
  });

  it('does not call remote user state while anonymous', async () => {
    session.set({ loading: false, user: null });
    const fetcher = readerFetch();
    vi.stubGlobal('fetch', fetcher);
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/user-state/'))).toBe(false);
  });

  it('sends debounced CAS progress and bookmark requests with server-confirmed status', async () => {
    session.set({ loading: false, user: { id: 'user-1' } });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ url: input, init });
        if (input.includes('/user-state/progress?'))
          return {
            ok: true,
            status: 200,
            json: async () => ({ progress: { revision: 2, pageOrdinal: 1 } }),
          };
        if (input === '/api/user-state/progress')
          return {
            ok: true,
            status: 200,
            json: async () => ({ progress: { revision: 3, pageOrdinal: 5 } }),
          };
        if (input === '/api/user-state/bookmarks')
          return { ok: true, status: 200, json: async () => ({ changed: true }) };
        return input.includes('/pages/')
          ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
          : { ok: true, status: 200, json: async () => ({ release }) };
      }),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    await fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    await waitFor(() =>
      expect(calls.some(({ url }) => url === '/api/user-state/progress')).toBe(true),
    );
    const progress = calls.find(({ url }) => url === '/api/user-state/progress')!;
    expect(JSON.parse(String(progress.init?.body))).toMatchObject({
      expectedRevision: 2,
      pageOrdinal: 5,
      completed: true,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'しおりを保存' }));
    await waitFor(() => expect(screen.getByText('しおりを保存しました。')).toBeTruthy());
    const bookmark = calls.find(({ url }) => url === '/api/user-state/bookmarks')!;
    expect(JSON.parse(String(bookmark.init?.body))).toEqual({
      rootId: 'root-1',
      progressKey: 'opaque-key',
      pageOrdinal: 5,
      label: null,
    });
  });

  it('aborts a pending remote GET when the reader unmounts', async () => {
    session.set({ loading: false, user: { id: 'user-1' } });
    let remoteSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/user-state/progress?')) {
        remoteSignal = init?.signal as AbortSignal;
        return await new Promise<never>(() => {});
      }
      return input.includes('/pages/')
        ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
        : { ok: true, status: 200, json: async () => ({ release }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const view = render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(remoteSignal).toBeTruthy());
    view.unmount();
    expect(remoteSignal?.aborted).toBe(true);
  });

  it('adopts a valid 409 conflict and uses its revision on the next PUT', async () => {
    session.set({ loading: false, user: { id: 'user-1' } });
    const progressBodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/user-state/progress?'))
        return {
          ok: true,
          status: 200,
          json: async () => ({ progress: { revision: 1, pageOrdinal: 3 } }),
        };
      if (input === '/api/user-state/progress') {
        progressBodies.push(JSON.parse(String(init?.body)));
        if (progressBodies.length === 1)
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: 'progress_conflict',
              progress: { revision: 9, pageOrdinal: 5 },
            }),
          };
        return {
          ok: true,
          status: 200,
          json: async () => ({ progress: { revision: 10, pageOrdinal: 5 } }),
        };
      }
      return input.includes('/pages/')
        ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
        : { ok: true, status: 200, json: async () => ({ release }) };
    });
    vi.stubGlobal('fetch', fetcher);
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: '続きから読む' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: '最初から読む' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy());
    await waitFor(() => expect(progressBodies).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: '続きから読む' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: '続きから読む' }));
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeTruthy());
    await waitFor(() => expect(progressBodies).toHaveLength(2));
    expect(progressBodies[1]).toMatchObject({ expectedRevision: 9, pageOrdinal: 5 });
  });

  it('does not show bookmark success when the server reports changed:false', async () => {
    session.set({ loading: false, user: { id: 'user-1' } });
    const fetcher = vi.fn(async (input: string) => {
      if (input.includes('/user-state/progress?'))
        return {
          ok: true,
          status: 200,
          json: async () => ({ progress: { revision: 1, pageOrdinal: 1 } }),
        };
      if (input === '/api/user-state/bookmarks')
        return { ok: true, status: 200, json: async () => ({ changed: false }) };
      return input.includes('/pages/')
        ? { ok: true, status: 200, blob: async () => new Blob(['page']) }
        : { ok: true, status: 200, json: async () => ({ release }) };
    });
    vi.stubGlobal('fetch', fetcher);
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'しおりを保存' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'しおりを保存' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url === '/api/user-state/bookmarks')).toBe(true),
    );
    expect(screen.queryByText('しおりを保存しました。')).toBeNull();
  });

  it('does not create an observer for paged or spread navigation', async () => {
    const observer = vi.fn();
    vi.stubGlobal('IntersectionObserver', observer);
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    expect(observer).not.toHaveBeenCalled();
  });

  it('does not turn synthesized keyboard clicks into tap-zone navigation', async () => {
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'リーダーのページ操作' })).toBeTruthy(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'リーダーのページ操作' }), {
      detail: 0,
    });
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  it('cancels the deferred pointer tap when a double-tap zooms', async () => {
    vi.stubGlobal('fetch', readerFetch());
    render(Reader, { data: { id: '7' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'リーダーのページ操作' })).toBeTruthy(),
    );
    const surface = screen.getByRole('button', { name: 'リーダーのページ操作' });
    await fireEvent.pointerDown(surface, { isPrimary: true, clientX: 1 });
    await fireEvent.pointerUp(surface, { isPrimary: true, clientX: 1 });
    await fireEvent.click(surface, { detail: 1, clientX: 1 });
    await fireEvent.dblClick(surface, { detail: 2, clientX: 1 });
    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });
});
