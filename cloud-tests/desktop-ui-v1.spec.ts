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
      rules: [
        '离场前检查现场水电、门窗和成品保护。',
        '与现场负责人同步当天进度及待确认事项。',
        '更新施工现场问题记录。',
      ].map((text) => ({
        id: crypto.randomUUID(),
        text,
        people: [],
        enabled: true,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        from: '',
        to: '',
      })),
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

async function statAlignment(page: Page) {
  return page.locator('.overview-stat').evaluateAll((cards) =>
    cards.map((card) => {
      const number = card.querySelector('strong')!,
        label = card.querySelector('span')!;
      const points = [number, label].map((item) => {
        const baseline = document.createElement('i');
        baseline.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        item.prepend(baseline);
        const y = baseline.getBoundingClientRect().top;
        baseline.remove();
        return y;
      });
      return {
        delta: Math.abs(points[0] - points[1]),
        gap: label.getBoundingClientRect().left - number.getBoundingClientRect().right,
        bar: getComputedStyle(card, '::after').backgroundColor,
      };
    }),
  );
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
  const alignment = await past.evaluate((date) => {
    const status = date.previousElementSibling!.getBoundingClientRect();
    const due = date.getBoundingClientRect();
    const today = date.closest('.agenda-item')!.getBoundingClientRect();
    const tomorrow = document
      .querySelector('[data-testid=tomorrow-panel] .agenda-item')!
      .getBoundingClientRect();
    return Math.max(
      Math.abs((status.top + status.bottom - due.top - due.bottom) / 2),
      Math.abs(today.height - tomorrow.height),
      Math.abs(today.top - tomorrow.top),
    );
  });
  expect(alignment).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const wide = await page.locator('.app-shell').evaluate((shell) => {
    const rect = shell.getBoundingClientRect();
    const nav = shell.querySelector('.sidebar nav')!;
    const row = nav.querySelector('button')!.getBoundingClientRect();
    return {
      width: rect.width,
      frame: rect.left,
      navHeight: row.height,
      navGap: parseFloat(getComputedStyle(nav).gap),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(wide.width).toBeGreaterThan(1840);
  expect(wide.frame).toBeGreaterThanOrEqual(14);
  expect(wide.navHeight).toBeGreaterThanOrEqual(42);
  expect(wide.navGap).toBeGreaterThanOrEqual(8);
  expect(wide.overflow).toBe(false);
  const statGeometry = await statAlignment(page);
  expect(statGeometry).toHaveLength(5);
  for (const { delta, gap, bar } of statGeometry) {
    expect(delta).toBeLessThanOrEqual(2);
    expect(gap).toBeGreaterThanOrEqual(13);
    expect(bar).toBe('rgb(223, 229, 220)');
  }
  const rules = page.getByTestId('studio-rules');
  await expect(rules.locator('.sd-rule-line')).toHaveCount(2);
  await expect(rules).not.toContainText('更新施工现场问题记录');
  await expect(rules.getByRole('button', { name: /收起/ })).toHaveCount(0);
  await expect(rules).toHaveCSS('background-image', /gradient/);
  expect(
    Math.abs(
      (await rules.boundingBox())!.height - (await page.locator('.sd-duty').boundingBox())!.height,
    ),
  ).toBeLessThanOrEqual(2);
  await page.screenshot({ path: join(output, 'home-wide.png'), fullPage: true });
  await page.locator('.overview-stats').screenshot({ path: join(output, 'statistics.png') });
  await page.locator('.sd-grid').screenshot({ path: join(output, 'studio-daily.png') });
  const readRules = rules.getByRole('button', { name: '展开查看', exact: true });
  await readRules.click();
  const allRules = page.getByRole('dialog', { name: '每日必做', exact: true });
  await expect(allRules.locator('.sd-rule-line')).toHaveCount(3);
  await expect(allRules.getByRole('button', { name: '管理每日必做' })).toHaveCount(0);
  await page.screenshot({ path: join(output, 'daily-rules-expanded.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(readRules).toBeFocused();
  await page.locator('.sidebar').screenshot({ path: join(output, 'sidebar.png') });
  await page.locator('.sd-duty').screenshot({ path: join(output, 'duty-light.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const open = page.getByRole('button', { name: '编辑值日', exact: true });
  const dialog = page.getByRole('dialog', { name: '编辑值日' });
  const layer = page.locator('.cm-glass-layer[data-kind=blocking]');
  await open.evaluate((button) => {
    button.addEventListener(
      'click',
      () => {
        const start = performance.now();
        const samples: { time: number; paper: string; scene: string; opacity: number }[] = [];
        function frame(now: number) {
          const modal = document.querySelector('dialog.sd-modal:modal');
          if (modal) {
            const style = getComputedStyle(modal);
            samples.push({
              time: now - start,
              paper: style.backgroundColor,
              scene: getComputedStyle(document.body, '::after').backdropFilter,
              opacity: Number(style.opacity),
            });
          }
          if (now - start < 450) requestAnimationFrame(frame);
          else performance.mark('stable-glass', { detail: samples });
        }
        requestAnimationFrame(frame);
      },
      { once: true },
    );
  });
  await open.click();
  await expect(dialog).toHaveAttribute('data-cm-glass', 'frosted');
  await expect(layer).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByName('stable-glass').length))
    .toBe(1);
  const samples = await page.evaluate(
    () =>
      (performance.getEntriesByName('stable-glass')[0] as PerformanceMark).detail as {
        time: number;
        paper: string;
        scene: string;
        opacity: number;
      }[],
  );
  expect(new Set(samples.map(({ paper }) => paper))).toEqual(new Set(['rgba(254, 252, 244, 0.9)']));
  expect(new Set(samples.map(({ scene }) => scene))).toEqual(new Set(['blur(5px)']));
  const firstVisible = samples.find(({ opacity }) => opacity > 0.1)?.time ?? Infinity;
  expect(firstVisible, JSON.stringify(samples)).toBeLessThan(400);
  const largestFrameGap = Math.max(
    ...samples.slice(1).map(({ time }, index) => time - samples[index].time),
  );
  await page.screenshot({ path: join(output, 'stable-glass.png') });
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();

  await page.goto('/?glass=enhanced');
  const timings = [];
  for (let i = 0; i < 4; i++) {
    await open.evaluate((button) => {
      button.addEventListener(
        'click',
        () => {
          performance.mark('ui-v1-open');
          const start = performance.now();
          const frames: number[] = [];
          let firstVisible = 0,
            last = start;
          function tick(now: number) {
            frames.push(Math.max(0, now - last));
            last = now;
            const dialog = document.querySelector<HTMLDialogElement>('dialog.sd-modal[open]');
            if (!firstVisible && dialog && Number(getComputedStyle(dialog).opacity) > 0.1)
              firstVisible = performance.now() - start;
            if (now - start < 310) requestAnimationFrame(tick);
            else
              for (const [name, detail] of Object.entries({ frames, firstVisible }))
                performance.mark('ui-v1-' + name, { detail });
          }
          requestAnimationFrame(tick);
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
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByName('ui-v1-frames').length))
      .toBe(i + 1);
    timings.push(
      await page.evaluate(() => ({
        layer: performance.getEntriesByName('ui-v1-liquid').at(-1)!.duration,
        frame: performance.getEntriesByName('ui-v1-frame').at(-1)!.duration,
        initial: (performance.getEntriesByName('ui-v1-firstVisible').at(-1)! as PerformanceMark)
          .detail as number,
        maxGap: Math.max(
          ...((performance.getEntriesByName('ui-v1-frames').at(-1)! as PerformanceMark)
            .detail as number[]),
        ),
      })),
    );
    if (i < 3) {
      await page.keyboard.press('Escape');
      await expect(open).toBeFocused();
    }
  }
  expect(Math.max(...timings.map(({ layer }) => layer)), JSON.stringify(timings)).toBeLessThan(500);
  expect(Math.max(...timings.map(({ frame }) => frame)), JSON.stringify(timings)).toBeLessThan(700);
  expect(timings.every(({ initial }) => initial > 0)).toBe(true);
  await expect(dialog).toHaveCSS('animation-duration', '0.14s');
  await expect(layer.locator('feDisplacementMap')).toHaveCount(1);
  await expect(layer.locator('.app-shell')).toHaveCount(0);
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
  await expect(layer.locator('.cm-glass-optic')).toHaveCSS('opacity', '1');
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
  expect(edgeDelta).toBeGreaterThan(0.12);
  expect(coreDelta).toBeLessThan(0.16);

  const blur = await page.addStyleTag({
    content:
      ":root[data-desktop-ui='v1']:has(.modal.cm-glass:modal) body::after { backdrop-filter: blur(22px); }",
  });
  const blurred = await shot();
  const sceneDelta = pixels(liquid, blurred, [32, 95, 208, 408]);
  expect(sceneDelta).toBeGreaterThan(0.6);
  await blur.evaluate((style) => style.parentNode?.removeChild(style));

  // Changes to the real page must propagate without a copied scene.
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
  await expect(dialog).toHaveAttribute('data-cm-glass', 'frosted');
  await expect(dialog).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.main-shell')).toHaveCSS('filter', 'none');
  expect(await page.evaluate(() => getComputedStyle(document.body, '::after').backdropFilter)).toBe(
    'blur(5px)',
  );
  await expect(layer.locator('.cm-glass-optic')).toHaveCount(0);
  await page.screenshot({ path: join(output, 'frosted-fallback.png') });
  await page.keyboard.press('Escape');

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await open.click();
  await expect(dialog).toHaveCSS('background-color', 'rgb(251, 250, 244)');
  await expect(dialog).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('.main-shell')).toHaveCSS('filter', 'none');
  expect(await page.evaluate(() => getComputedStyle(document.body, '::after').backdropFilter)).toBe(
    'none',
  );
  await page.keyboard.press('Escape');

  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await page.goto('/?glass=lite');
  await open.click();
  await expect(dialog).toHaveAttribute('data-cm-glass', 'frosted');
  await expect(layer.locator('.cm-glass-optic')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/?ui=legacy');
  await expect(page.locator('.app-shell')).not.toHaveClass(/ui-v1/);
  await expect(page.locator('.page-heading h1')).toBeVisible();
  await page.getByRole('button', { name: '提醒中心' }).click();
  await expect(page).toHaveURL(/ui=legacy/);
  await expect(page.locator('.app-shell')).not.toHaveClass(/ui-v1/);

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveClass(/ui-v1/);
  const compact = await page.locator('.overview-stat').evaluateAll((cards) => ({
    rows: new Set(cards.map((card) => card.getBoundingClientRect().top)).size,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  expect(compact).toEqual({ rows: 1, overflow: false });
  for (const { delta, gap } of await statAlignment(page)) {
    expect(delta).toBeLessThanOrEqual(2);
    expect(gap).toBeGreaterThanOrEqual(13);
  }
  const clipped = await page
    .locator('.sidebar-save-status > button')
    .evaluate((button) => button.scrollWidth > button.clientWidth);
  expect(clipped).toBe(false);

  expect(errors).toEqual([]);
  await writeFile(
    join(output, 'browser-check.json'),
    JSON.stringify(
      {
        faces,
        wide,
        statGeometry,
        stableMs: {
          firstVisible: Math.round(firstVisible),
          largestFrameGap: Math.round(largestFrameGap),
          samples: samples.length,
        },
        timingsMs: timings.map(({ layer, frame, initial, maxGap }) => ({
          layer: Math.round(layer),
          frame: Math.round(frame),
          initial: Math.round(initial),
          maxGap: Math.round(maxGap),
        })),
        edgeDelta,
        coreDelta,
        sceneDelta,
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
