import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import AdminSettings from './+page.svelte';
import { session } from '$lib/session';

afterEach(() => {
  cleanup();
  session.set({ loading: true, user: null });
  vi.restoreAllMocks();
});

test('selects a directory user and grants/revokes access without a typed user id', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/admin/users'))
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'opaque-user',
              name: 'Reader',
              email: 'reader@example.invalid',
              role: 'user',
              banned: false,
            },
          ],
          nextCursor: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (url === '/api/catalog/libraries')
      return new Response(JSON.stringify({ items: [{ id: 'root-a', displayName: 'Main' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  session.set({ loading: false, user: { id: 'admin', role: 'admin' } });
  render(AdminSettings);
  await screen.findByText('Reader');
  await fireEvent.click(screen.getByRole('button', { name: /Reader/ }));
  await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'root-a' } });
  await fireEvent.click(screen.getByRole('button', { name: '付与' }));
  await fireEvent.click(screen.getByRole('button', { name: '取り消し' }));
  const mutations = fetcher.mock.calls.filter(([url]) =>
    String(url).includes('/api/admin/library-access/'),
  );
  expect(mutations.map(([url, init]) => [String(url), (init as RequestInit).method])).toEqual([
    ['/api/admin/library-access/opaque-user/root-a', 'PUT'],
    ['/api/admin/library-access/opaque-user/root-a', 'DELETE'],
  ]);
  expect(screen.queryByLabelText(/ユーザーID|内部ID/)).toBeNull();
});

test('renders empty and error states and sends bounded search/pagination requests', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/catalog/libraries') return new Response(JSON.stringify({ items: [] }));
    if (url.includes('cursor=next'))
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    return new Response(JSON.stringify({ items: [], nextCursor: 'next' }));
  });
  session.set({ loading: false, user: { id: 'admin', role: 'admin' } });
  render(AdminSettings);
  expect(await screen.findByText('ユーザーが見つかりません。')).toBeTruthy();
  await fireEvent.input(screen.getByLabelText('ユーザー検索'), { target: { value: 'Reader' } });
  await fireEvent.submit(screen.getByRole('button', { name: '検索' }).closest('form')!);
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('q=Reader'))).toBe(true),
  );
});

test('direct route gates anonymous and non-admin sessions without network requests', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  session.set({ loading: false, user: null });
  render(AdminSettings);
  expect(await screen.findByText('管理者としてログインしてください。')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
  cleanup();
  session.set({ loading: false, user: { id: 'reader', role: 'user' } });
  render(AdminSettings);
  expect(await screen.findByText('管理者のみ利用できます。')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

test('new search aborts an older request and prevents stale results', async () => {
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/catalog/libraries') return new Response(JSON.stringify({ items: [] }));
    if (url.includes('q=old')) return old;
    return new Response(
      JSON.stringify({
        items: [
          { id: 'new', name: 'Fresh', email: 'fresh@example.invalid', role: 'user', banned: false },
        ],
        nextCursor: null,
      }),
    );
  });
  session.set({ loading: false, user: { id: 'admin', role: 'admin' } });
  render(AdminSettings);
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/api/admin/users'))).toBe(true),
  );
  const input = screen.getByLabelText('ユーザー検索');
  await fireEvent.input(input, { target: { value: 'old' } });
  await fireEvent.submit(input.closest('form')!);
  await fireEvent.input(input, { target: { value: 'new' } });
  await fireEvent.submit(input.closest('form')!);
  resolveOld(
    new Response(
      JSON.stringify({
        items: [
          { id: 'old', name: 'Stale', email: 'stale@example.invalid', role: 'user', banned: false },
        ],
        nextCursor: null,
      }),
    ),
  );
  expect(await screen.findByText('Fresh')).toBeTruthy();
  expect(screen.queryByText('Stale')).toBeNull();
});

test('switching admin identity clears A state and ignores A responses while loading B fresh', async () => {
  let calls = 0;
  let resolveA!: (response: Response) => void;
  const pendingA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    calls++;
    if (url === '/api/catalog/libraries') return new Response(JSON.stringify({ items: [] }));
    if (calls === 1)
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'a',
              name: 'Admin A private',
              email: 'a@example.invalid',
              role: 'user',
              banned: false,
            },
          ],
          nextCursor: 'a-next',
        }),
      );
    if (url.includes('q=second')) return pendingA;
    return new Response(
      JSON.stringify({
        items: [
          {
            id: 'b',
            name: 'Admin B only',
            email: 'b@example.invalid',
            role: 'user',
            banned: false,
          },
        ],
        nextCursor: null,
      }),
    );
  });
  session.set({ loading: false, user: { id: 'admin-a', role: 'admin' } });
  render(AdminSettings);
  expect(await screen.findByText('Admin A private')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: /Admin A private/ }));
  const input = screen.getByLabelText('ユーザー検索');
  await fireEvent.input(input, { target: { value: 'second' } });
  await fireEvent.submit(input.closest('form')!);
  session.set({ loading: false, user: { id: 'admin-b', role: 'admin' } });
  expect(await screen.findByText('Admin B only')).toBeTruthy();
  resolveA(
    new Response(
      JSON.stringify({
        items: [
          {
            id: 'a-stale',
            name: 'Admin A stale',
            email: 'a-stale@example.invalid',
            role: 'user',
            banned: false,
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByText('Admin A private')).toBeNull());
  expect(screen.queryByText('Admin A stale')).toBeNull();
  expect(screen.getByText('Admin B only')).toBeTruthy();
});
