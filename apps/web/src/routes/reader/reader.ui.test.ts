import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Reader from './[id]/+page.svelte';

const release = {
  progressKey: 'opaque-key',
  revision: 'sha:1',
  validOrdinals: [1, 3, 5],
  validPageCount: 3,
  nextPublicationId: '12',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('reader interaction UI', () => {
  it('renders labelled controls and only navigates valid ordinals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ release }) })),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    expect(screen.getByText('1 / 3')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: '次のページ' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'ページ 2' }).getAttribute('src')).toContain('/pages/3');
    expect(screen.getByRole('combobox', { name: '表示形式' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '全画面表示' })).toBeTruthy();
  });

  it('offers revision-matched resume and keeps navigation after a page error', async () => {
    localStorage.setItem(
      'gutter.reader.progress.v1',
      JSON.stringify({ 'opaque-key': { revision: 'sha:1', ordinal: 3 } }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ release }) })),
    );
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ release }) })),
    );
    render(Reader, { data: { id: '7' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '次のページ' })).toBeTruthy());
    expect(observer).not.toHaveBeenCalled();
  });

  it('does not turn synthesized keyboard clicks into tap-zone navigation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ release }) })),
    );
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ release }) })),
    );
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
