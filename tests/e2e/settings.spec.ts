import { expect, test } from '@playwright/test';

test('Chrome user settings exposes profile, collection controls, and export', async ({ page }) => {
  let sessionRequests = 0;
  await page.route('**/api/auth/get-session**', (route) => {
    sessionRequests++;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-a', name: 'Reader', email: 'reader@example.invalid', role: 'user' },
        session: { id: 'session-user-a', userId: 'user-a' },
      }),
    });
  });
  await page.route('**/api/user-state/collections?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: '7', name: 'Favorites' }], nextCursor: null }),
    }),
  );
  await page.route('**/api/user-state/export', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        progress: [],
        targetState: [],
        bookmarks: [],
        collections: [],
      }),
    }),
  );
  await page.goto('/settings');
  await expect.poll(() => sessionRequests).toBeGreaterThan(0);
  const account = page.getByRole('region', { name: 'アカウント' });
  await expect(account.locator('dd').filter({ hasText: /^Reader$/ })).toBeVisible();
  await expect(page.getByText('Favorites')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'データを書き出す' }).click();
  await expect((await download).suggestedFilename()).toBe('gutter-user-state.json');
});
