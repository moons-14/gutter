import { expect, test, type Page } from '@playwright/test';

const release = {
  progressKey: 'source:playwright',
  revision: 'revision:1',
  validOrdinals: [1, 3, 5],
  validPageCount: 3,
  nextPublicationId: '9',
};

async function stubReader(page: Page, offline = false): Promise<number[]> {
  const pageRequests: number[] = [];
  await page.context().route('**/api/reader/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const publication = /^\/api\/reader\/publications\/([1-9][0-9]*)$/.exec(pathname);
    if (publication) {
      const id = publication[1];
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ session: id === '7'
          ? { releaseId: '42', release }
          : { releaseId: '43', release: { ...release, nextPublicationId: null } } }),
      });
    }
    if (/^\/api\/reader\/releases\/[1-9][0-9]*\/pages\/[0-9]+$/.test(pathname)) {
      pageRequests.push(Date.now());
      if (offline) return route.abort('failed');
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return pageRequests;
}

test('reader opens, is keyboard-accessible, and uses a network-only page request', async ({
  page,
}) => {
  const pageRequests = await stubReader(page);
  await page.goto('/reader/publications/7');
  const surface = page.getByRole('button', { name: 'リーダーのページ操作' });
  await surface.focus();
  await expect(surface).toBeFocused();
  await expect(page.getByRole('button', { name: '次のページ' })).toBeEnabled();
  await surface.press('ArrowLeft');
  await expect(page.getByText('2 / 3')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '表示形式' })).toBeVisible();
  await expect.poll(() => pageRequests.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([]);
});

test('reader reports a page failure honestly while offline', async ({ page }) => {
  await stubReader(page, true);
  await page.goto('/reader/publications/7');
  await expect(page.getByRole('alert')).toContainText('表示できません');
});
