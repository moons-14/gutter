import { expect, test } from '@playwright/test';

test.describe('catalog detail states', () => {
  for (const [label, status, message] of [
    ['not found', 404, '作品が見つかりません。'],
    ['unavailable', 503, '作品は現在利用できません。'],
  ] as const) {
    test(`reports ${label}`, async ({ page }) => {
      await page.route('**/api/catalog/series/404', (route) => route.fulfill({ status }));
      await page.goto('/series/404');
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(page.getByRole('button', { name: '再試行' })).toBeVisible();
    });
  }

  test('reports an empty detail collection', async ({ page }) => {
    await page.route('**/api/catalog/series/1', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ displayName: '空の作品', publications: [] }),
      }),
    );
    await page.goto('/series/1');
    await expect(page.getByRole('heading', { name: '空の作品' })).toBeVisible();
    await expect(page.getByText('関連する作品はまだありません。')).toBeVisible();
  });

  test('reports a generic entity not found with neutral wording', async ({ page }) => {
    await page.route('**/api/catalog/creators/404', (route) => route.fulfill({ status: 404 }));
    await page.goto('/creators/404');
    await expect(page.getByRole('alert')).toContainText('情報が見つかりません。');
  });
});
