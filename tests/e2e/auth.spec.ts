import { expect, test, type Page } from '@playwright/test';

type AuthStub = {
  signedIn: boolean;
  bootstrapAvailable: boolean;
  requests: string[];
};

async function stubAuth(page: Page, options: Partial<AuthStub> = {}): Promise<AuthStub> {
  const state: AuthStub = {
    signedIn: false,
    bootstrapAvailable: true,
    requests: [],
    ...options,
  };

  await page.route('**/api/auth/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.requests.push(`${request.method()} ${path}`);

    if (path === '/api/auth/bootstrap' && request.method() === 'POST') {
      if (!state.bootstrapAvailable) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'bootstrap_unavailable' }),
        });
      }
      state.bootstrapAvailable = false;
      state.signedIn = true;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'bootstrap-user', name: 'Admin' } }),
      });
    }

    if (path === '/api/auth/sign-in/email' && request.method() === 'POST') {
      const body = request.postDataJSON() as { email?: string; password?: string };
      if (
        body.email !== 'reader@example.invalid' ||
        body.password !== 'correct horse battery staple'
      ) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'invalid credentials' }),
        });
      }
      state.signedIn = true;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'reader-user', name: 'Reader', email: body.email },
          session: { id: 'opaque-session' },
        }),
      });
    }

    if (path === '/api/auth/get-session' && request.method() === 'GET') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          state.signedIn
            ? { user: { id: 'reader-user', name: 'Reader', email: 'reader@example.invalid' } }
            : null,
        ),
      });
    }

    if (path === '/api/auth/sign-out' && request.method() === 'POST') {
      state.signedIn = false;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  return state;
}

async function gotoAndWaitForHydration(page: Page, auth: AuthStub, url: string): Promise<void> {
  const sessionRequestCount = () =>
    auth.requests.filter((request) => request === 'GET /api/auth/get-session').length;
  const previousSessionRequestCount = sessionRequestCount();
  await page.goto(url);
  await expect.poll(sessionRequestCount).toBeGreaterThan(previousSessionRequestCount);
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
}

async function fillSetup(page: Page) {
  await page.getByLabel('表示名').fill('Admin');
  await page.getByLabel('メールアドレス').fill('admin@example.invalid');
  await page.getByLabel('パスワード', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('パスワード（確認）').fill('correct horse battery staple');
  await page.getByRole('button', { name: '管理者を作成' }).click();
}

test('first-time setup succeeds and the one-time endpoint becomes unavailable', async ({
  page,
}) => {
  const auth = await stubAuth(page);
  await gotoAndWaitForHydration(page, auth, '/setup');
  await fillSetup(page);
  await expect(page).toHaveURL(/\/$/);
  expect(auth.requests).toContain('POST /api/auth/bootstrap');
  await expect(page.getByText('Reader')).toBeVisible();

  await gotoAndWaitForHydration(page, auth, '/setup');
  await fillSetup(page);
  await expect(page.getByRole('alert')).toContainText('すでに完了');
  await expect(page.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
});

test('setup reports an already-configured 403 without changing the anonymous presentation', async ({
  page,
}) => {
  const auth = await stubAuth(page, { bootstrapAvailable: false });
  await gotoAndWaitForHydration(page, auth, '/setup');
  await fillSetup(page);
  await expect(page.getByRole('alert')).toContainText('すでに完了');
  await expect(page.getByRole('link', { name: 'ログインへ' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ログイン', exact: true })).toBeVisible();
  expect(auth.signedIn).toBe(false);
});

test('successful email/password sign-in preserves a safe intended destination', async ({
  page,
}) => {
  const auth = await stubAuth(page);
  await gotoAndWaitForHydration(
    page,
    auth,
    '/login?next=%2Freader%2Fpublications%2F7%3Fresume%3D3%23page',
  );
  await fillLogin(page, 'reader@example.invalid', 'correct horse battery staple');
  await expect(page).toHaveURL(/\/reader\/publications\/7\?resume=3#page$/);
  await expect(page.getByText('Reader')).toBeVisible();
});

test('failed email/password sign-in does not create a session', async ({ page }) => {
  const auth = await stubAuth(page);
  await gotoAndWaitForHydration(page, auth, '/login?next=%2Freader%2Fpublications%2F7');
  await fillLogin(page, 'reader@example.invalid', 'wrong password');
  await expect(page.getByRole('alert')).toContainText('確認してください');
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(auth.signedIn).toBe(false);
});

test('external and auth-page destinations fall back without redirect loops', async ({ page }) => {
  const auth = await stubAuth(page);
  await gotoAndWaitForHydration(page, auth, '/login?next=https%3A%2F%2Fevil.invalid%2Fsteal');
  await fillLogin(page, 'reader@example.invalid', 'correct horse battery staple');
  await expect(page).toHaveURL(/\/$/);

  await gotoAndWaitForHydration(page, auth, '/login?next=%2Fsetup');
  await expect(page).toHaveURL(/\/login\?next=%2Fsetup$/);
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
});

test('sign-out returns the shell to anonymous state and keeps auth presentation browser-local', async ({
  page,
}) => {
  const auth = await stubAuth(page, { signedIn: true });
  await gotoAndWaitForHydration(page, auth, '/');
  await expect(page.getByText('Reader')).toBeVisible();
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('status')).toContainText('ログアウトしました');
  await expect(page.getByRole('link', { name: 'ログイン' })).toBeVisible();
  await expect(page.getByText('Reader')).not.toBeVisible();

  // The session store only controls presentation; no client-side credential is persisted.
  await expect(
    page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).resolves.toEqual({ local: 0, session: 0 });
});
