import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from './releases/[id]/+page.svelte';
import { clearNextHandoff } from '$lib/reader';

const release = {
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
