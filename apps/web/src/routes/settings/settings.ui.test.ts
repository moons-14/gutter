import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './+page.svelte';
import { session } from '$lib/session';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.set({ loading: true, user: null });
});

describe('settings surface', () => {
  it('shows current profile, loads collections, and downloads export with URL cleanup', async () => {
    session.set({
      loading: false,
      user: { id: 'user-a', name: 'Reader', email: 'reader@example.invalid', role: 'user' },
    });
    const revoke = vi.fn();
    const create = vi.fn(() => 'blob:state');
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const fetcher = vi.fn(async (input: string) =>
      input.includes('/export')
        ? new Response('{"schemaVersion":1}', { headers: { 'content-type': 'application/json' } })
        : new Response(
            JSON.stringify({ items: [{ id: '7', name: 'Favorites' }], nextCursor: null }),
          ),
    );
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    expect(await screen.findByText('Reader')).toBeTruthy();
    expect(await screen.findByText('Favorites')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'データを書き出す' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:state'));
    expect(fetcher.mock.calls.some(([url]) => String(url) === '/api/user-state/export')).toBe(true);
  });

  it('sends exact collection create/delete requests and reloads the collection page', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === '/api/user-state/collections' && init?.method === 'POST')
        return new Response(JSON.stringify({ collection: { id: '8', name: 'New' } }), {
          status: 201,
        });
      if (input.endsWith('/8')) return new Response(JSON.stringify({ changed: true }));
      return new Response(JSON.stringify({ items: [{ id: '8', name: 'New' }], nextCursor: null }));
    });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    render(SettingsPage);
    await screen.findByText('New');
    await fireEvent.input(screen.getByLabelText('新しいコレクション名'), {
      target: { value: 'New' },
    });
    await fireEvent.submit(screen.getByLabelText('新しいコレクション名').closest('form')!);
    await waitFor(() =>
      expect(
        calls.some(
          ([url, init]) =>
            url === '/api/user-state/collections' &&
            init?.method === 'POST' &&
            init.body === JSON.stringify({ name: 'New' }),
        ),
      ).toBe(true),
    );
    await fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(
      calls.some(
        ([url, init]) =>
          url === '/api/user-state/collections/8' && init?.method === 'DELETE' && !init.body,
      ),
    ).toBe(true);
  });

  it('ignores an older same-session collection response after a create reload', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    let resolveOldCollections!: (value: Response) => void;
    let resolveNewCollections!: (value: Response) => void;
    let collectionGets = 0;
    const fetcher = vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/user-state/collections' && init?.method === 'POST')
        return Promise.resolve(new Response('{}', { status: 201 }));
      if (input.includes('/collections?'))
        return new Promise<Response>((resolve) => {
          collectionGets++;
          if (collectionGets === 1) resolveOldCollections = resolve;
          else resolveNewCollections = resolve;
        });
      return Promise.resolve(new Response('{}'));
    });
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    await waitFor(() => expect(collectionGets).toBe(1));
    await fireEvent.input(screen.getByLabelText('新しいコレクション名'), {
      target: { value: 'Created' },
    });
    await fireEvent.submit(screen.getByLabelText('新しいコレクション名').closest('form')!);
    await waitFor(() => expect(collectionGets).toBe(2));
    resolveNewCollections(
      new Response(JSON.stringify({ items: [{ id: '2', name: 'New' }], nextCursor: null })),
    );
    await screen.findByText('New');
    resolveOldCollections(
      new Response(JSON.stringify({ items: [{ id: '1', name: 'Old' }], nextCursor: null })),
    );
    await waitFor(() => {
      expect(screen.queryByText('Old')).toBeNull();
      expect(screen.getByText('New')).toBeTruthy();
    });
  });

  it('allows export to finish while a same-session collection reload starts', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    const create = vi.fn(() => 'blob:export');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    let resolveExport!: (value: Response) => void;
    let createDone = false;
    const fetcher = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('/export'))
        return new Promise<Response>((resolve) => {
          resolveExport = resolve;
        });
      if (input === '/api/user-state/collections' && init?.method === 'POST') {
        createDone = true;
        return Promise.resolve(new Response('{}', { status: 201 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: createDone ? [{ id: '8', name: 'Created' }] : [],
            nextCursor: null,
          }),
        ),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole('button', { name: 'データを書き出す' }));
    await fireEvent.input(screen.getByLabelText('新しいコレクション名'), {
      target: { value: 'Created' },
    });
    await fireEvent.submit(screen.getByLabelText('新しいコレクション名').closest('form')!);
    await waitFor(() => expect(screen.getByText('Created')).toBeTruthy());
    resolveExport(new Response('{}'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:export'));
  });

  it('does not delete a collection when confirmation is cancelled and reports failures', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    const fetcher = vi.fn(async (input: string) =>
      input.includes('/collections?')
        ? new Response(
            JSON.stringify({ items: [{ id: '7', name: 'Favorites' }], nextCursor: null }),
          )
        : new Response('{}', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    render(SettingsPage);
    await screen.findByText('Favorites');
    await fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/collections/7'))).toBe(false);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    await fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect((await screen.findByRole('alert')).textContent).toContain('削除できませんでした');
  });

  it('reports an export failure without creating a download', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    const fetcher = vi.fn(async (input: string) =>
      input.includes('/collections?')
        ? new Response(JSON.stringify({ items: [], nextCursor: null }))
        : new Response('{}', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    await screen.findByText('コレクションはありません。');
    await fireEvent.click(screen.getByRole('button', { name: 'データを書き出す' }));
    expect((await screen.findByRole('alert')).textContent).toContain('書き出せませんでした');
  });

  it('performs exactly one initial collection GET for an authenticated empty or failed response', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      }),
    );
    render(SettingsPage);
    await screen.findByText('コレクションはありません。');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);
  });

  it('retries a failed initial collection load without showing an empty state', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'Reader' } });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response('{}', { status: 503 })
          : new Response(
              JSON.stringify({ items: [{ id: 'retry', name: 'Recovered' }], nextCursor: null }),
            );
      }),
    );
    render(SettingsPage);
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toContain('コレクションを読み込めませんでした');
    expect(screen.queryByText('コレクションはありません。')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByText('Recovered');
    expect(calls).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: '再試行' })).toBeNull();
  });

  it('gates anonymous sessions without making user-state requests', async () => {
    session.set({ loading: false, user: null });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    expect(await screen.findByText('設定を見るにはログインしてください。')).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clears A state and ignores its late response after switching to B', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'A' } });
    let resolveAdminACollections!: (value: Response) => void;
    let resolveAdminBCollections!: (value: Response) => void;
    let collectionRequests = 0;
    const fetcher = vi.fn((input: string) =>
      input.includes('/collections?')
        ? new Promise<Response>((resolve) => {
            collectionRequests++;
            if (collectionRequests === 1) resolveAdminACollections = resolve;
            else resolveAdminBCollections = resolve;
          })
        : Promise.resolve(new Response('{}')),
    );
    vi.stubGlobal('fetch', fetcher);
    render(SettingsPage);
    await waitFor(() => expect(collectionRequests).toBe(1));
    session.set({ loading: false, user: { id: 'user-b', name: 'B' } });
    await waitFor(() => expect(collectionRequests).toBe(2));
    resolveAdminBCollections(
      new Response(JSON.stringify({ items: [{ id: '9', name: 'B private' }], nextCursor: null })),
    );
    await screen.findByText('B private');
    resolveAdminACollections(
      new Response(JSON.stringify({ items: [{ id: '8', name: 'A private' }], nextCursor: null })),
    );
    await waitFor(() => {
      expect(screen.queryByText('A private')).toBeNull();
      expect(screen.getByText('B private')).toBeTruthy();
    });
  });

  it('clears a previous error when the session switches', async () => {
    session.set({ loading: false, user: { id: 'user-a', name: 'A' } });
    let collectionCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        collectionCalls++;
        return collectionCalls === 1
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ items: [], nextCursor: null }));
      }),
    );
    render(SettingsPage);
    await screen.findByRole('alert');
    session.set({ loading: false, user: { id: 'user-b', name: 'B' } });
    await waitFor(() => expect(collectionCalls).toBe(2));
    await screen.findByText('コレクションはありません。');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
