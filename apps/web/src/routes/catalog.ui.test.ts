import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CatalogPage from './+page.svelte';
import PublicationPage from './publications/[id]/+page.svelte';
import EntityListPage from './[entity=entity]/+page.svelte';
import EntityDetailPage from './[entity=entity]/[id]/+page.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('catalog UI runtime states', () => {
  it('renders the catalog loading and failure states', async () => {
    let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
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
    resolve({ ok: false, json: async () => ({}) });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('カタログを読み込めませんでした'),
    );
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
