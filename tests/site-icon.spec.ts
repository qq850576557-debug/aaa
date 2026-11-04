import { test, expect } from '@playwright/test';
test('browser tab and saved-site icons reference the existing Chunmo logo', async ({ page }) => {
  await page.goto('/');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('type', 'image/png');
  const href = (await icon.getAttribute('href'))!;
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', href);
  const response = await page.request.get(href);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('image/png');
  expect((await response.body()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const dimensions = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, href);
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.height).toBeGreaterThan(0);
});
