import { expect, test } from '@playwright/test';

test('catalog navigation reaches a permitted reader entry', async ({ page }) => {
  await page.route('**/api/reader/releases/42', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        release: {
          rootId: 'root',
          progressKey: 'source:x',
          revision: 'r',
          validOrdinals: [1],
          validPageCount: 1,
        },
      }),
    }),
  );
  await page.route('**/api/catalog/series?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: '1', displayName: 'Series', libraryId: 'library', publicationCount: 1 }],
      }),
    }),
  );
  await page.route('**/api/catalog/series/1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        displayName: 'Series',
        publications: [{ id: '9', displayName: 'Volume 1', kind: 'volume' }],
      }),
    }),
  );
  await page.route('**/api/catalog/publications/9', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        seriesId: '1',
        seriesName: 'Series',
        displayName: 'Volume 1',
        credits: [],
        releases: [{ id: '42', relativePath: 'volume.cbz', pageCount: 3 }],
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Series' })).toBeVisible();
  await page.getByRole('link', { name: 'Series' }).click();
  await expect(page.getByRole('heading', { name: 'Series' })).toBeVisible();
  await page.getByRole('link', { name: /Volume 1/ }).click();
  await expect(page.getByRole('heading', { name: 'Volume 1' })).toBeVisible();
  await page.getByRole('link', { name: '読む' }).click();
  await expect(page).toHaveURL(/\/reader\/releases\/42$/);
});

test('catalog exposes an explicit empty state', async ({ page }) => {
  await page.route('**/api/catalog/series?**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '作品はまだありません' })).toBeVisible();
});

test('signed-in catalog exposes resume entries that open the release reader', async ({ page }) => {
  let sessionRequests = 0;
  await page.route('**/api/auth/get-session**', (route) => {
    sessionRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'resume-user', name: 'Reader' },
        session: { id: 'session' },
      }),
    });
  });
  await page.route('**/api/catalog/series?**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route('**/api/user-state/resume?**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ releaseId: '42', pageOrdinal: 3, completed: false }] }),
    }),
  );
  await page.goto('/');
  await expect.poll(() => sessionRequests).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: /リリース 42/ })).toHaveAttribute(
    'href',
    '/reader/releases/42',
  );
});
