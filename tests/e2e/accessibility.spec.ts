import { expect, test } from '@playwright/test';

function parseColor(value: string): [number, number, number] {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => part + part)
            .join('')
        : hex;
    return [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  const match = value.match(/\d+(?:\.\d+)?/g);
  if (!match || match.length < 3) throw new Error(`Unsupported color: ${value}`);
  if (value.startsWith('rgba') && Number(match[3]) !== 1) {
    throw new Error(`Alpha colors require compositing: ${value}`);
  }
  return match.slice(0, 3).map(Number) as [number, number, number];
}

function luminance(color: [number, number, number]): number {
  return color.reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear =
      normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

test('shell exposes named landmarks and keyboard-visible focus', async ({ page }) => {
  await page.route('**/api/catalog/series?**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'メインナビゲーション' })).toBeVisible();
  const login = page.getByRole('link', { name: 'ログイン', exact: true });
  await expect(login).toBeVisible();
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press('Tab');
    if (await login.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(login).toBeFocused();
  await expect
    .poll(() =>
      login.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
        };
      }),
    )
    .toMatchObject({ outlineStyle: 'solid' });
  await expect
    .poll(() => login.evaluate((node) => Number.parseFloat(getComputedStyle(node).outlineWidth)))
    .toBeGreaterThan(0);
  const focusColors = await login.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outline: style.outlineColor,
      backdrop: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(focusColors.outline).not.toBe('transparent');
  expect(focusColors.outline).not.toBe('rgba(0, 0, 0, 0)');
  const focusContrast =
    (Math.max(
      luminance(parseColor(focusColors.outline)),
      luminance(parseColor(focusColors.backdrop)),
    ) +
      0.05) /
    (Math.min(
      luminance(parseColor(focusColors.outline)),
      luminance(parseColor(focusColors.backdrop)),
    ) +
      0.05);
  expect(focusContrast).toBeGreaterThanOrEqual(3);
});

test('primary text and action colors meet a stable basic contrast floor', async ({ page }) => {
  await page.route('**/api/catalog/series?**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.goto('/');
  await expect(page.locator('.account-action')).toBeVisible();
  const contrast = await page.evaluate(() => {
    const button = document.querySelector<HTMLAnchorElement>('.account-action');
    if (!button) throw new Error('account action missing');
    const style = getComputedStyle(button);
    const bodyStyle = getComputedStyle(document.body);
    const result = {
      foreground: style.color,
      background: style.backgroundColor,
      body: bodyStyle.color,
      backdrop: bodyStyle.backgroundColor,
    };
    return result;
  });
  const bodyRatio =
    (Math.max(luminance(parseColor(contrast.body)), luminance(parseColor(contrast.backdrop))) +
      0.05) /
    (Math.min(luminance(parseColor(contrast.body)), luminance(parseColor(contrast.backdrop))) +
      0.05);
  const actionRatio =
    (Math.max(
      luminance(parseColor(contrast.foreground)),
      luminance(parseColor(contrast.background)),
    ) +
      0.05) /
    (Math.min(
      luminance(parseColor(contrast.foreground)),
      luminance(parseColor(contrast.background)),
    ) +
      0.05);
  expect(bodyRatio).toBeGreaterThanOrEqual(4.5);
  expect(actionRatio).toBeGreaterThanOrEqual(4.5);
});
