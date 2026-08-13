import { expect, test } from '@playwright/test';

function channelColor(value: string): [number, number, number] {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!match) throw new Error(`Expected opaque rgb color, got ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  return [r, g, b].reduce((sum, value, index) => {
    const c = value / 255;
    const linear = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

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

test('anonymous settings is gated without user-state requests', async ({ page }) => {
  await page.route('**/api/auth/get-session**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(null) }),
  );
  let userStateRequests = 0;
  await page.route('**/api/user-state/**', (route) => {
    userStateRequests += 1;
    return route.fulfill({ status: 500 });
  });
  await page.goto('/settings');
  const gate = page.getByRole('main').getByRole('heading', { name: '設定' });
  await expect(gate).toBeVisible();
  await expect(page.getByText('設定を見るにはログインしてください。')).toBeVisible();
  await expect.poll(() => userStateRequests).toBe(0);
});

test('settings reports collection failure, retries, and exposes empty state', async ({ page }) => {
  await page.route('**/api/auth/get-session**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'user-a', name: 'Reader' } }),
    }),
  );
  let collectionRequests = 0;
  await page.route('**/api/user-state/collections?**', (route) => {
    collectionRequests += 1;
    return route.fulfill(
      collectionRequests === 1
        ? { status: 503 }
        : {
            contentType: 'application/json',
            body: JSON.stringify({ items: [], nextCursor: null }),
          },
    );
  });
  await page.goto('/settings');
  await expect(page.getByRole('alert')).toContainText('コレクションを読み込めませんでした。');
  await page.getByRole('button', { name: '再試行' }).click();
  await expect(page.getByText('コレクションはありません。')).toBeVisible();
  expect(collectionRequests).toBe(2);
});

test('settings controls have labels, landmarks, keyboard focus, and contrast', async ({ page }) => {
  await page.route('**/api/auth/get-session**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'user-a', name: 'Reader' } }),
    }),
  );
  await page.route('**/api/user-state/collections?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.goto('/settings');
  const main = page.getByRole('main');
  await expect(main.getByRole('region', { name: 'アカウント' })).toBeVisible();
  const exportButton = main.getByRole('button', { name: 'データを書き出す' });
  await expect(exportButton).toBeVisible();
  await exportButton.focus();
  await expect(exportButton).toBeFocused();
  await expect
    .poll(() =>
      exportButton.evaluate((node) => Number.parseFloat(getComputedStyle(node).outlineWidth)),
    )
    .toBeGreaterThan(0);
  const colors = await exportButton.evaluate((node) => {
    const style = getComputedStyle(node);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const foreground = channelColor(colors.foreground);
  const background = channelColor(colors.background);
  const ratio =
    (Math.max(luminance(foreground), luminance(background)) + 0.05) /
    (Math.min(luminance(foreground), luminance(background)) + 0.05);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
