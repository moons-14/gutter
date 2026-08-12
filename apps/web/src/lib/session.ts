import { writable } from 'svelte/store';
import { authClient } from '$lib/auth-client';

export type SessionUser = Readonly<{
  id?: string;
  name?: string;
  email?: string;
  role?: string;
}>;

export type SessionState = Readonly<{ loading: boolean; user: SessionUser | null }>;

const APP_ORIGIN = 'http://gutter.local';
const AUTH_PATHS = ['/login', '/setup'];

export const session = writable<SessionState>({ loading: true, user: null });

/**
 * Accept only same-origin application paths. In particular, protocol-relative URLs,
 * API paths, and auth pages cannot become post-auth redirect targets.
 */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
    const target = new URL(value, APP_ORIGIN);
    if (
      target.origin !== APP_ORIGIN ||
      target.pathname === '/api' ||
      target.pathname.startsWith('/api/') ||
      target.pathname.includes('\\')
    )
      return fallback;
    if (
      AUTH_PATHS.some((path) => target.pathname === path || target.pathname.startsWith(`${path}/`))
    )
      return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

export function loginHref(next: string | null | undefined): string {
  const destination = safeNext(next);
  return destination === '/' ? '/login' : `/login?next=${encodeURIComponent(destination)}`;
}

export function currentDestination(): string {
  if (typeof window === 'undefined') return '/';
  return safeNext(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

export function intendedDestination(): string {
  if (typeof window === 'undefined') return '/';
  return safeNext(new URL(window.location.href).searchParams.get('next'));
}

export function redirectAfterAuth(destination: string): void {
  if (typeof window !== 'undefined') window.location.assign(safeNext(destination));
}

export async function refreshSession(): Promise<void> {
  session.set({ loading: true, user: null });
  try {
    const response = await authClient.getSession();
    session.set({ loading: false, user: response.data?.user ?? null });
  } catch {
    session.set({ loading: false, user: null });
  }
}

export async function signOut(): Promise<void> {
  const response = await authClient.signOut();
  if (response.error) throw new Error('sign_out_failed');
  session.set({ loading: false, user: null });
}
