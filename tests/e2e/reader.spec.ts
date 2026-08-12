import { expect, test, type Page } from '@playwright/test';

const release = {
  rootId: 'root-playwright',
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
        body: JSON.stringify({
          session:
            id === '7'
              ? { releaseId: '42', release }
              : { releaseId: '43', release: { ...release, nextPublicationId: null } },
        }),
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

test('signed-in reader resumes, persists progress, and bookmarks the current page', async ({
  page,
}) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'user-playwright', name: 'Reader', email: 'reader@example.test' },
        session: { id: 'session-playwright', userId: 'user-playwright' },
      }),
    }),
  );
  await stubReader(page);

  const progressPutBodies: Record<string, unknown>[] = [];
  await page.route('**/api/user-state/progress**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      expect(url.searchParams.get('rootId')).toBe('root-playwright');
      expect(url.searchParams.get('progressKey')).toBe('source:playwright');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          progress: {
            rootId: 'root-playwright',
            progressKey: 'source:playwright',
            pageOrdinal: 3,
            completed: false,
            revision: 4,
          },
        }),
      });
    }
    expect(request.method()).toBe('PUT');
    const body = request.postDataJSON() as Record<string, unknown>;
    progressPutBodies.push(body);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        progress: {
          rootId: 'root-playwright',
          progressKey: 'source:playwright',
          pageOrdinal: body.pageOrdinal,
          completed: body.completed,
          revision: 5,
        },
      }),
    });
  });

  let bookmarkBody: Record<string, unknown> | null = null;
  await page.route('**/api/user-state/bookmarks', async (route) => {
    expect(route.request().method()).toBe('POST');
    bookmarkBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ changed: true }),
    });
  });

  await page.goto('/reader/publications/7');
  await expect(page.getByRole('button', { name: '続きから読む' })).toBeVisible();
  await expect(page.getByText('1 / 3')).toBeVisible();
  await page.getByRole('button', { name: '続きから読む' }).click();
  await expect(page.getByText('2 / 3')).toBeVisible();
  await page.getByRole('button', { name: '次のページ' }).click();
  await expect(page.getByText('3 / 3')).toBeVisible();
  await expect
    .poll(() => progressPutBodies)
    .toContainEqual({
      rootId: 'root-playwright',
      progressKey: 'source:playwright',
      expectedRevision: 4,
      pageOrdinal: 5,
      completed: true,
    });

  await page.getByRole('button', { name: 'しおりを保存' }).click();
  await expect(page.getByRole('status')).toContainText('保存');
  expect(bookmarkBody).toEqual({
    rootId: 'root-playwright',
    progressKey: 'source:playwright',
    pageOrdinal: 5,
    label: null,
  });
});
