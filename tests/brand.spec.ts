import { test, expect, type Page } from '@playwright/test';
import { boot } from './helpers';

async function renderedFonts(page: Page, selector: string) {
  // Chromium's actual platform-font report detects silent fallback, unlike a CSS-family assertion.
  const session = await page.context().newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const result = await session.send('CSS.getPlatformFontsForNode', { nodeId });
  await session.detach();
  return result.fonts;
}

test('brand: desktop/mobile render custom brand glyphs, sidebar stacks logo/name/motto without SJD', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/fonts/')) requests.push(r.url());
  });
  await boot(page);
  await page.evaluate(() => document.fonts.load('28px ChunmoBrand', '春茉空间设计'));
  for (const [width, selector] of [[1440, '.brand .brand-name']] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(selector)).toHaveText('春茉空间设计');
    await expect(page.locator(selector)).toHaveCSS('font-weight', '400');
    await expect(page.locator(selector)).toHaveCSS('font-synthesis', 'none');
    const fonts = await renderedFonts(page, selector);
    expect(fonts.filter((f) => f.isCustomFont).reduce((sum, f) => sum + f.glyphCount, 0)).toBe(6);
    expect(fonts.filter((f) => !f.isCustomFont).reduce((sum, f) => sum + f.glyphCount, 0)).toBe(0);
    await expect(page.locator('.brand .brand-initials,.mobile-brand .brand-initials')).toHaveCount(
      0,
    );
    expect(await page.locator('h1').evaluate((e) => getComputedStyle(e).fontFamily)).not.toContain(
      'ChunmoBrand',
    );
    expect(
      await page
        .locator('button.primary')
        .first()
        .evaluate((e) => getComputedStyle(e).fontFamily),
    ).not.toContain('ChunmoBrand');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 1440) {
      const logo = (await page.locator('.brand img').boundingBox())!;
      const text = (await page.locator(selector).boundingBox())!;
      const motto = (await page.locator('.brand-slogan').boundingBox())!;
      expect(logo.y + logo.height).toBeLessThanOrEqual(text.y);
      expect(text.y + text.height).toBeLessThanOrEqual(motto.y);
      await expect(page.locator('.brand-slogan')).toHaveText('功能与美×共生');
    }
    const r = (await page.locator(selector).boundingBox())!;
    expect(r.width).toBeLessThan(208);
    await page.screenshot({ path: `test-results/brand-${width}.png`, animations: 'disabled' });
  }
  // Vite dev uses no-cache: preloading may be followed by a 304 cache validation.
  expect(requests.some((url) => url.endsWith('/fonts/chunmo-brand.woff'))).toBe(true);
  expect(requests.some((url) => url.endsWith('/fonts/fangzheng-qiti.ttf'))).toBe(false);
});

test('brand: unsupported WOFF falls back to the exact uploaded TTF, without using a substitute font', async ({
  page,
}) => {
  await page.route('**/fonts/chunmo-brand.woff', (route) => route.abort());
  const original = page.waitForResponse((r) => r.url().endsWith('/fonts/fangzheng-qiti.ttf'));
  await boot(page);
  await page.evaluate(() => document.fonts.load('28px ChunmoBrand', '春茉空间设计'));
  expect((await original).ok()).toBe(true);
  const fonts = await renderedFonts(page, '.brand .brand-name');
  expect(fonts.filter((f) => f.isCustomFont).reduce((sum, f) => sum + f.glyphCount, 0)).toBe(6);
});
