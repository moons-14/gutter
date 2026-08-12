import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  signIn: { email: vi.fn(), passkey: vi.fn() },
  twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
}));
vi.mock('$lib/auth-client', () => ({ authClient: authMocks }));
import { session, signOut, safeNext, loginHref } from '$lib/session';
import Layout from './+layout.svelte';
import LoginPage from './login/+page.svelte';
import SetupPage from './setup/+page.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.set({ loading: true, user: null });
});

beforeEach(() => {
  authMocks.getSession.mockResolvedValue({ data: null, error: null });
  authMocks.signOut.mockResolvedValue({ data: null, error: null });
  authMocks.signIn.email.mockResolvedValue({ data: null, error: null });
  authMocks.signIn.passkey.mockResolvedValue({ data: null, error: null });
  authMocks.twoFactor.verifyTotp.mockResolvedValue({ data: null, error: null });
  authMocks.twoFactor.verifyBackupCode.mockResolvedValue({ data: null, error: null });
});

describe('safe auth destinations', () => {
  it('keeps canonical local paths and rejects open redirects and auth loops', () => {
    expect(safeNext('/reader/releases/42?resume=3#page')).toBe('/reader/releases/42?resume=3#page');
    expect(safeNext('https://evil.invalid/steal')).toBe('/');
    expect(safeNext('//evil.invalid/steal')).toBe('/');
    expect(safeNext('/\\evil.invalid')).toBe('/');
    expect(safeNext('/%0Aevil')).toBe('/');
    expect(safeNext('/login?next=%2Freader')).toBe('/');
    expect(safeNext('/setup')).toBe('/');
    expect(safeNext('/api')).toBe('/');
    expect(safeNext('/api?next=%2Freader')).toBe('/');
    expect(loginHref('/reader/releases/42')).toBe('/login?next=%2Freader%2Freleases%2F42');
  });
});

describe('login and setup UI', () => {
  it('does not expose backend sign-in details on failure', async () => {
    authMocks.signIn.email.mockResolvedValueOnce({
      data: null,
      error: { status: 401, message: 'database detail must not render' },
    });
    render(LoginPage);
    await fireEvent.input(screen.getByLabelText('メールアドレス'), {
      target: { value: 'user@example.invalid' },
    });
    await fireEvent.input(screen.getByLabelText('パスワード'), {
      target: { value: 'correct horse battery staple' },
    });
    await fireEvent.submit(screen.getByRole('button', { name: 'ログイン' }).closest('form')!);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('確認してください'),
    );
    expect(screen.getByRole('alert').textContent).not.toContain('database detail');
  });

  it('shows the required TOTP/recovery challenge after password sign-in', async () => {
    authMocks.signIn.email.mockResolvedValueOnce({
      data: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      error: null,
    });
    render(LoginPage);
    await fireEvent.input(screen.getByLabelText('メールアドレス'), {
      target: { value: 'user@example.invalid' },
    });
    await fireEvent.input(screen.getByLabelText('パスワード'), {
      target: { value: 'correct horse battery staple' },
    });
    await fireEvent.submit(screen.getByRole('button', { name: 'ログイン' }).closest('form')!);
    await waitFor(() =>
      expect(screen.getByText('二要素認証コードを入力してください。')).toBeTruthy(),
    );
    expect(screen.getByLabelText('認証アプリのコード')).toBeTruthy();
    expect(screen.getByLabelText('回復コードを使う')).toBeTruthy();
  });

  it('reports an already-configured bootstrap without inferring a new auth state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'bootstrap_unavailable' }),
      })),
    );
    render(SetupPage);
    await fireEvent.input(screen.getByLabelText('表示名'), { target: { value: 'Admin' } });
    await fireEvent.input(screen.getByLabelText('メールアドレス'), {
      target: { value: 'admin@example.invalid' },
    });
    await fireEvent.input(screen.getByLabelText('パスワード'), {
      target: { value: 'correct horse battery staple' },
    });
    await fireEvent.input(screen.getByLabelText('パスワード（確認）'), {
      target: { value: 'correct horse battery staple' },
    });
    await fireEvent.submit(screen.getByRole('button', { name: '管理者を作成' }).closest('form')!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('すでに完了'));
    expect(screen.getByRole('link', { name: 'ログインへ' }).getAttribute('href')).toBe('/login');
  });
});

describe('session shell', () => {
  it('shows the session and clears it only after successful sign-out', async () => {
    authMocks.getSession.mockResolvedValueOnce({
      data: { user: { id: 'opaque-user', name: 'Reader', email: 'reader@example.invalid' } },
      error: null,
    });
    render(Layout);
    await waitFor(() => expect(screen.getByText('Reader')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('ログアウトしました'),
    );
    expect(get(session)).toEqual({ loading: false, user: null });
    expect(screen.getByRole('link', { name: 'ログイン' })).toBeTruthy();
  });

  it('retains the session if the server rejects sign-out', async () => {
    session.set({ loading: false, user: { id: 'opaque-user', name: 'Reader' } });
    authMocks.signOut.mockResolvedValueOnce({
      data: null,
      error: { status: 403, message: 'denied' },
    });
    await expect(signOut()).rejects.toThrow('sign_out_failed');
    expect(get(session)).toEqual({ loading: false, user: { id: 'opaque-user', name: 'Reader' } });
  });
});
