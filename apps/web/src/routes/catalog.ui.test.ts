import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CatalogPage from './+page.svelte';
import PublicationPage from './publications/[id]/+page.svelte';
import EntityListPage from './[entity=entity]/+page.svelte';
import EntityDetailPage from './[entity=entity]/[id]/+page.svelte';
import { session } from '$lib/session';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.set({ loading: true, user: null });
});

describe('catalog UI runtime states', () => {
  it('shows authenticated resume entries and routes directly to their release reader', async () => {
    session.set({ loading: false, user: { id: 'reader-1' } });
    const fetchMock = vi.fn(async (input: string) =>
      input.includes('/user-state/resume')
        ? {
            ok: true,
            json: async () => ({ items: [{ releaseId: '42', pageOrdinal: 7, completed: false }] }),
          }
        : { ok: true, json: async () => ({ items: [], nextCursor: null }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    render(CatalogPage);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /リリース 42/ }).getAttribute('href')).toBe(
        '/reader/releases/42',
      ),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/user-state/resume?limit=6')),
    ).toBe(true);
  });

  it('binds resume requests to the current user and ignores stale responses', async () => {
    session.set({ loading: false, user: { id: 'user-a' } });
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(async (input: string) =>
      input.includes('/user-state/resume')
        ? new Promise<Response>((resolve) => pending.push(resolve))
        : ({ ok: true, json: async () => ({ items: [], nextCursor: null }) } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(CatalogPage);
    await waitFor(() => expect(pending).toHaveLength(1));
    session.set({ loading: false, user: null });
    session.set({ loading: false, user: { id: 'user-b' } });
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!({
      ok: true,
      json: async () => ({ items: [{ releaseId: '999', pageOrdinal: 1, completed: false }] }),
    } as Response);
    pending[1]!({
      ok: true,
      json: async () => ({ items: [{ releaseId: '42', pageOrdinal: 3, completed: false }] }),
    } as Response);
    await waitFor(() => expect(screen.getByRole('link', { name: /リリース 42/ })).toBeTruthy());
    expect(screen.queryByRole('link', { name: /999/ })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/user-state/resume')),
    ).toHaveLength(2);
  });

  it('filters malformed resume release IDs before rendering links', async () => {
    session.set({ loading: false, user: { id: 'reader-1' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('/user-state/resume')
          ? {
              ok: true,
              json: async () => ({
                items: [
                  { releaseId: '-1', pageOrdinal: 1, completed: false },
                  { releaseId: '0', pageOrdinal: 1, completed: false },
                ],
              }),
            }
          : { ok: true, json: async () => ({ items: [], nextCursor: null }) },
      ),
    );
    render(CatalogPage);
    await waitFor(() => expect(screen.getByText('続きから読める作品はありません。')).toBeTruthy());
    expect(screen.queryByRole('link', { name: /-1|0/ })).toBeNull();
  });

  it('keeps loading separate from successful empty and offers retry after failure', async () => {
    let resolve!: (value: { ok: boolean; status?: number; json: () => Promise<unknown> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    render(CatalogPage);
    expect(screen.getByText('読み込み中…')).toBeTruthy();
    resolve({ ok: false, status: 503, json: async () => ({}) });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('利用できません'));
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    } as Response);
    await screen.getByRole('button', { name: '再試行' }).click();
    await waitFor(() => expect(screen.getByText('作品はまだありません')).toBeTruthy());
  });

  it('distinguishes not-found from an unavailable catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    render(CatalogPage);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('見つかりません'));
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy();
  });

  it('serializes creator, group, and publisher catalog filters', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], nextCursor: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(CatalogPage);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const inputs = screen.getAllByRole('textbox');
    await fireEvent.input(inputs[2], { target: { value: 'Writer' } });
    await fireEvent.input(inputs[3], { target: { value: 'Circle' } });
    await fireEvent.input(inputs[4], { target: { value: 'Press' } });
    await fireEvent.submit(screen.getByRole('button', { name: '検索' }).closest('form')!);
    const request = new URL(
      (fetchMock.mock.calls as unknown[][]).at(-1)?.[0] as string,
      'http://localhost',
    );
    expect(request.searchParams.get('creator')).toBe('Writer');
    expect(request.searchParams.get('group')).toBe('Circle');
    expect(request.searchParams.get('publisher')).toBe('Press');
  });

  it('serializes entity search and page-size controls', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(EntityListPage, { data: { entity: 'creators' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await fireEvent.input(screen.getByPlaceholderText('名前'), { target: { value: 'Writer' } });
    await fireEvent.change(screen.getByRole('combobox'), { target: { value: '60' } });
    await fireEvent.submit(screen.getByRole('button', { name: '検索' }).closest('form')!);
    const request = new URL(
      (fetchMock.mock.calls as unknown[][]).at(-1)?.[0] as string,
      'http://localhost',
    );
    expect(request.searchParams.get('q')).toBe('Writer');
    expect(request.searchParams.get('limit')).toBe('60');
  });

  it('renders creator, group, and publisher credits as navigable links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          displayName: 'Volume 1',
          seriesId: '1',
          seriesName: 'Series',
          releases: [],
          credits: [
            { id: '11', kind: 'creator', displayName: 'Writer', role: 'writer' },
            { id: '12', kind: 'group', displayName: 'Circle', role: 'group' },
            { id: '13', kind: 'publisher', displayName: 'Press', role: 'publisher' },
          ],
        }),
      })),
    );
    render(PublicationPage, { data: { id: '9' } });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Writer' }).getAttribute('href')).toBe(
        '/creators/11',
      ),
    );
    expect(screen.getByRole('link', { name: 'Circle' }).getAttribute('href')).toBe('/groups/12');
    expect(screen.getByRole('link', { name: 'Press' }).getAttribute('href')).toBe('/publishers/13');
  });

  it('renders entity list and detail navigation after successful fetches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ items: [{ id: '11', displayName: 'Writer', publicationCount: 1 }] }),
      })),
    );
    render(EntityListPage, { data: { entity: 'creators' } });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Writer' }).getAttribute('href')).toBe(
        '/creators/11',
      ),
    );
    cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          displayName: 'Writer',
          publications: [{ id: '9', displayName: 'Volume 1', seriesName: 'Series' }],
        }),
      })),
    );
    render(EntityDetailPage, { data: { entity: 'creators', id: '11' } });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Volume 1' }).getAttribute('href')).toBe(
        '/publications/9',
      ),
    );
  });
});
