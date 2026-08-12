import { expect, test } from '@playwright/test';

test('Chrome admin settings selects a user and grants then revokes library access', async ({
  page,
}) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'admin-a', name: 'Admin', role: 'admin' } }),
    }),
  );
  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
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
    }),
  );
  await page.route('**/api/catalog/libraries', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'root-a', displayName: 'Main' }] }),
    }),
  );
  const mutations: string[] = [];
  await page.route('**/api/admin/library-access/**', (route) => {
    mutations.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ revision: 1 }),
    });
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/settings/admin');
  await page.getByRole('button', { name: /Reader/ }).click();
  await page.getByRole('combobox').selectOption('root-a');
  await page.getByRole('button', { name: '付与' }).click();
  await page.getByRole('button', { name: '取り消し' }).click();
  await expect(page.getByRole('status')).toContainText('取り消しました');
  expect(mutations).toEqual([
    'PUT /api/admin/library-access/opaque-user/root-a',
    'DELETE /api/admin/library-access/opaque-user/root-a',
  ]);
  await expect(page.getByLabel(/ユーザーID|内部ID/)).toHaveCount(0);
});
