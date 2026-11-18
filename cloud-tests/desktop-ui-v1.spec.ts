import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { fixtureAccounts, fixtureQuery } from '../server/test-fixtures';
import { emptyStudio, studioDay } from '../src/lib/studio-daily';
import { plus } from '../src/lib/model';
import { fixture } from '../tests/helpers';

test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const result = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!result.ok) throw Error('Fixture API ' + result.status);
      return result.json();
    },
    { path, method, body },
  );
}

async function setup(page: Page) {
  const account = await fixtureAccounts(3);
  const names = ['林晓', '周然', '马宁'];
  for (const [index, staff] of account.employees.entries())
    await fixtureQuery('UPDATE account SET display_name=$1 WHERE id=$2', [names[index], staff.id]);
  await page.goto('/');
  await page.getByLabel('登录账号', { exact: true }).fill(account.login);
  await page.getByLabel('登录密码', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const day = studioDay(),
    data = fixture();
  data.projects = ['梧桐里 · 03 栋', '云栖花园 · 02 栋', '南山公馆 · 05 栋'].map((name, index) => ({
    ...data.projects[0],
    id: 'preview-' + index,
    name,
    status: '施工中',
    start: plus(day, -10),
    end: plus(day, 30),
  }));
  data.tasks = [];
  data.trades = [];
  const titles = ['检查门窗及成品保护', '复核柜体现场尺寸', '确认现场水电点位'];
  data.notes = data.projects.flatMap((project, index) =>
    [-1, 0, 1].map((offset) => ({
      ...data.notes[0],
      id: crypto.randomUUID(),
      projectId: project.id,
      title: titles[(index + offset + 3) % 3],
      done: false,
      date: plus(day, offset),
      reminder: plus(day, offset),
    })),
  );
  data.purchases = data.projects.flatMap((project, index) =>
    [0, 1].map((offset) => ({
      ...data.purchases[0],
      id: crypto.randomUUID(),
      projectId: project.id,
      taskId: '',
      name: ['客厅轨道灯', '橱柜五金', '卫生间地砖'][index],
      deadlineMode: 'fixed' as const,
      due: plus(day, offset),
      status: '待采购',
    })),
  );
  const workspace = await api(page, '/workspace');
  await api(page, '/workspace', 'PUT', { revision: workspace.revision, data });
  const studio = await api(page, '/studio-daily');
  const daily = await api(page, '/studio-daily', 'PUT', {
    requestId: crypto.randomUUID(),
    version: studio.version,
    value: {
      ...emptyStudio(),
      rules: ['离场前检查现场水电、门窗和成品保护。', '与现场负责人同步当天进度及待确认事项。'].map(
        (text) => ({
          id: crypto.randomUUID(),
          text,
          people: [],
          enabled: true,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          from: '',
          to: '',
        }),
      ),
    },
  });
  await api(page, '/studio-daily/rotation', 'POST', {
    requestId: crypto.randomUUID(),
    version: daily.version ?? studio.version + 1,
    value: {
      action: 'configure',
      people: account.employees.map(({ id }) => id),
      interval: 7,
      start: day,
      currentDate: day,
    },
  });
  await page.reload();
  await expect(page.locator('.sd-duty')).toContainText(names[0]);
  return account;
}

type Region = [left: number, top: number, right: number, bottom: number];
function pixels(a: PNG, b: PNG, [left, top, right, bottom]: Region) {
  let difference = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const offset = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) difference += Math.abs(a.data[offset + c] - b.data[offset + c]);
    }
  return difference / ((right - left) * (bottom - top) * 3);
}

test('desktop V1 local typography, real optical sampling, form and fallback', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const output = process.env.CHUNMO_UI_V1_SCREENSHOTS ?? info.outputDir;
  await mkdir(output, { recursive: true });
  const fonts = new Set<string>();
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.add(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const account = await setup(page);
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  async function renderedFont(selector: string, family: RegExp) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    expect(fonts.some((font) => font.isCustomFont && family.test(font.familyName))).toBe(true);
    return fonts.filter(({ isCustomFont }) => isCustomFont).map(({ familyName }) => familyName);
  }
  const faces = {
    number: await renderedFont('.overview-stat strong', /Inter/),
    chinese: await renderedFont('[data-testid=today-panel] h2', /Noto Sans SC/),
    brand: await renderedFont('.brand-name', /FZ|方正|QiTi/i),
  };
  expect([...fonts].every((src) => new URL(src).origin === new URL(page.url()).origin)).toBe(true);
  expect([...fonts].filter((src) => src.includes('/fonts/ui-v1/'))).toHaveLength(2);
  await expect(page.locator('.overview-stat strong').first()).toHaveCSS('font-size', '29px');
  await expect(page.locator('.overview-stat strong').first()).toHaveCSS(
    'font-variant-numeric',
    /tabular-nums/,
  );
  const past = page.getByTestId('today-panel').locator('.agenda-item-actions time').first();
  await expect(past).toBeVisible();
  await expect(past).toHaveText(plus(studioDay(), -1));
  await page.screenshot({ path: join(output, 'home.png'), fullPage: true });

  const open = page.getByRole('button', { name: '编辑值日', exact: true });
  const dialog = page.getByRole('dialog', { name: '编辑值日' });
  const layer = page.locator('.cm-glass-layer[data-kind=blocking]');
  const timings = [];
  for (let i = 0; i < 4; i++) {
    await open.evaluate((button) => {
      button.addEventListener(
        'click',
        () => {
          performance.mark('ui-v1-open');
          const observer = new MutationObserver(() => {
            if (!document.querySelector('dialog[data-cm-glass="liquid"]')) return;
            observer.disconnect();
            performance.measure('ui-v1-liquid', 'ui-v1-open');
            requestAnimationFrame(() => performance.measure('ui-v1-frame', 'ui-v1-open'));
          });
          observer.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['data-cm-glass'],
          });
        },
        { once: true },
      );
    });
    await open.click();
    await expect(dialog).toHaveAttribute('data-cm-glass', 'liquid');
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByName('ui-v1-frame').length))
      .toBe(i + 1);
    timings.push(
      await page.evaluate(() => ({
        layer: performance.getEntriesByName('ui-v1-liquid').at(-1)!.duration,
        frame: performance.getEntriesByName('ui-v1-frame').at(-1)!.duration,
      })),
    );
    if (i < 3) {
      await page.keyboard.press('Escape');
      await expect(open).toBeFocused();
    }
  }
  expect(Math.max(...timings.map(({ layer }) => layer)), JSON.stringify(timings)).toBeLessThan(500);
  expect(Math.max(...timings.map(({ frame }) => frame)), JSON.stringify(timings)).toBeLessThan(700);
  await expect(dialog.locator('select').first()).toHaveCSS(
    'background-color',
    'rgba(255, 254, 250, 0.94)',
  );
  const box = (await dialog.boundingBox())!;
  const x = Math.ceil(box.x),
    y = Math.ceil(box.y);
  const right = Math.floor(box.x + box.width),
    bottom = Math.floor(box.y + box.height);
  const rim: Region = [right - 27, y + 66, right - 3, bottom - 45];
  const core: Region = [x + 49, y + 81, right - 53, bottom - 75];
  const shot = async (path?: string) => PNG.sync.read(await page.screenshot({ path }));
  const liquid = await shot(join(output, 'liquid-glass.png'));
  const scales = await layer.locator('feDisplacementMap').evaluateAll((filters) =>
    filters.map((filter) => {
      const scale = filter.getAttribute('scale')!;
      filter.setAttribute('scale', '0');
      return scale;
    }),
  );
  const flat = await shot();
  await layer
    .locator('feDisplacementMap')
    .evaluateAll(
      (filters, originals) =>
        filters.forEach((filter, i) => filter.setAttribute('scale', originals[i])),
      scales,
    );
  const edgeDelta = pixels(liquid, flat, rim);
  const coreDelta = pixels(liquid, flat, core);
  expect(edgeDelta).toBeGreaterThan(0.45);
  expect(coreDelta).toBeLessThan(0.16);

  const blur = await page.addStyleTag({
    content: '.cm-glass-layer { --cm-glass-scene-blur: 22px; }',
  });
  const blurred = await shot();
  const sceneDelta = pixels(liquid, blurred, [32, 95, 208, 408]);
  const rimDelta = pixels(liquid, blurred, rim);
  expect(sceneDelta).toBeGreaterThan(0.6);
  expect(rimDelta).toBeLessThan(0.15);
  await blur.evaluate((style) => style.parentNode?.removeChild(style));

  // Change only the real app shell. The visual copy must follow the altered scene.
  await page.locator('#root .sd-duty').evaluate((card) => {
    (card as HTMLElement).style.setProperty(
      '--cm-duty-glow',
      'linear-gradient(90deg, #2c594f, #d2aa71)',
    );
  });
  const changed = await shot();
  const colorDelta = pixels(liquid, changed, rim);
  expect(colorDelta).toBeGreaterThan(1);
  await page.locator('#root .sd-duty').evaluate((card) => {
    (card as HTMLElement).style.removeProperty('--cm-duty-glow');
  });

  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  await expect(open).toBeFocused();

  // Exercise the browser capability path without disabling ordinary backdrop blur.
  await page.evaluate(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args: [string] | [string, string]) =>
      args[1]?.startsWith('url(') ? false : supports(...(args as [string, string]));
  });
  await open.click();
  await expect(dialog).toHaveCSS('backdrop-filter', 'blur(18px) saturate(1.05)');
  await expect(layer).toHaveCount(0);
  await page.screenshot({ path: join(output, 'frosted-fallback.png') });
  await page.keyboard.press('Escape');

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await open.click();
  await expect(dialog).toHaveCSS('background-color', 'rgb(251, 250, 244)');
  await expect(dialog).toHaveCSS('backdrop-filter', 'none');
  await page.keyboard.press('Escape');

  await page.goto('/?ui=legacy');
  await expect(page.locator('.app-shell')).not.toHaveClass(/ui-v1/);
  await expect(page.locator('.page-heading h1')).toBeVisible();
  await page.getByRole('button', { name: '提醒中心' }).click();
  await expect(page).toHaveURL(/ui=legacy/);
  await expect(page.locator('.app-shell')).not.toHaveClass(/ui-v1/);

  expect(errors).toEqual([]);
  await writeFile(
    join(output, 'browser-check.json'),
    JSON.stringify(
      {
        faces,
        timingsMs: timings.map(({ layer, frame }) => ({
          layer: Math.round(layer),
          frame: Math.round(frame),
        })),
        edgeDelta,
        coreDelta,
        sceneDelta,
        rimDelta,
        colorDelta,
        fallback: 'ordinary and reduced transparency',
        legacy: 'navigation preserved',
      },
      null,
      2,
    ) + '\n',
  );
  if (process.env.CHUNMO_UI_V1_SCREENSHOTS) {
    await writeFile(
      join(output, 'local-login.txt'),
      '本地隔离预览账号\n网址 http://127.0.0.1:5180/\n账号 ' +
        account.login +
        '\n密码 ' +
        account.password +
        '\n',
      { mode: 0o600 },
    );
  }
});
