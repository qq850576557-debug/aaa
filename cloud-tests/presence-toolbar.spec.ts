import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';

async function api(p: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return p.evaluate(
    async ({ path, method, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function seed(p: Page) {
  const d = fixture();
  expect((await api(p, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
  await p.reload();
  await expect(p.locator('.task-bar').first()).toBeVisible();
  return d;
}
for (const width of [1280, 1440])
  test(`conflict chip ${width}: title/chip/date order, full detail, controls remain accessible and data unchanged`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await enter(page, f.login, f.password);
    const d = await seed(page);
    d.people = [
      { id: 'staff-one', name: '梅勇', role: '施工人员', trade: '木工', notes: '', active: true },
    ];
    d.projects.push({ ...d.projects[0], id: 'other-site', name: '元都新景' });
    d.trades.push({ ...d.trades[0], id: 'other-trade', projectId: 'other-site', name: '木工阶段' });
    const first = d.tasks[0];
    first.staffIds = ['staff-one'];
    first.staffAssignment = 'explicit';
    first.start = '2026-11-01';
    first.end = '2026-11-10';
    d.tasks.push({
      ...first,
      id: 'other-task',
      projectId: 'other-site',
      tradeId: 'other-trade',
      name: '木工吊顶',
      start: '2026-11-03',
      end: '2026-11-10',
    });
    const s = (await api(page)).value;
    expect((await api(page, '/workspace', 'PUT', { revision: s.revision, data: d })).status).toBe(
      200,
    );
    await page.reload();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const heading = page.locator('.schedule-section > .section-heading'),
      chip = heading.locator('.conflict-compact');
    await expect(chip).toContainText('梅勇');
    await expect(page.locator('main > .conflict-panel')).toHaveCount(0);
    await heading.scrollIntoViewIfNeeded();
    const box = (await chip.boundingBox())!,
      toolbar = (await heading.locator('.toolbar').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(toolbar.x);
    expect(box.width).toBeLessThan(300);
    expect(Math.abs(box.y - toolbar.y)).toBeLessThan(65);
    const buttons = await heading.locator('.toolbar > button').all();
    for (const b of buttons) await expect(b).toBeVisible();
    const before = (await api(page)).value.data;
    await chip.locator(':scope > summary').click();
    await expect(chip.locator('.conflict-popover')).toBeVisible();
    await expect(chip).toContainText('8天');
    await expect(chip).toContainText('木工吊顶');
    await page.screenshot({ path: `/tmp/conflict-toolbar-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(chip).not.toHaveAttribute('open', '');
    expect((await api(page)).value.data).toEqual(before);
    if (width === 1440) {
      const multi = structuredClone(before);
      multi.tasks.push({
        ...multi.tasks.find((x: any) => x.id === 'other-task'),
        id: 'another-overlap',
      });
      const live = (await api(page)).value;
      expect(
        (await api(page, '/workspace', 'PUT', { revision: live.revision, data: multi })).status,
      ).toBe(200);
      await page.reload();
      await expect(chip.locator(':scope > summary')).toHaveText('⚠ 人员冲突 × 2');
      await chip.locator(':scope > summary').click();
      await expect(chip.locator('.conflict-entry')).toHaveCount(2);
      await chip.locator('.conflict-entry > summary').first().hover();
      await expect(chip.locator('.conflict-entry > summary').first()).toHaveAttribute(
        'title',
        /8天/,
      );
      await chip.locator('.conflict-entry > summary').first().click();
      await expect(chip.locator('.conflict-entry').first().locator('div')).toBeVisible();
      const clean = structuredClone(multi);
      for (const t of clean.tasks) {
        t.staffIds = [];
        t.staffAssignment = 'explicit';
      }
      const latest = (await api(page)).value;
      expect(
        (await api(page, '/workspace', 'PUT', { revision: latest.revision, data: clean })).status,
      ).toBe(200);
      await page.reload();
      await expect(chip).toHaveCount(0);
    }
  });
test('presence: visibility/focus signals, idle clock, interaction recovery, multi-tab aggregation, cards and logout', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const f = await fixtureAccounts();
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  try {
    await enter(a, f.login, f.password);
    await seed(a);
    await enter(b, f.employee, f.password);
    await b.bringToFront();
    await b.mouse.move(340, 250);
    const state = async () =>
      (await api(a, '/presence')).value.accounts.find((x: any) => x.login === f.employee)?.status;
    await expect.poll(state).toBe('active');
    const member = a.getByRole('button', { name: `查看${f.employee}的在线名片`, exact: true });
    await expect(member.locator('.presence-active')).toHaveCount(1);
    const signal = async (visible: boolean, focused: boolean) =>
      b.evaluate(
        ({ visible, focused }) => {
          const w = window as any;
          w.presenceFixture = { visible, focused };
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (w.presenceFixture.visible ? 'visible' : 'hidden'),
          });
          document.hasFocus = () => w.presenceFixture.focused;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
        },
        { visible, focused },
      );
    const away = await cb.newPage();
    await away.goto('about:blank');
    await away.bringToFront();
    await signal(false, false); // headless Chromium does not hide background tabs itself
    await expect.poll(state).toBe('busy');
    await expect(member.locator('.presence-busy')).toHaveCount(1);
    await away.close();
    await b.bringToFront();
    await signal(true, true);
    await expect.poll(state).toBe('busy'); // foreground alone is not an interaction
    await b.mouse.move(350, 265);
    await expect.poll(state).toBe('active');
    await signal(true, false);
    await expect.poll(state).toBe('busy');
    await signal(true, true);
    await b.keyboard.press('Shift');
    await expect.poll(state).toBe('active');
    await signal(false, false);
    const tab = await cb.newPage();
    await tab.goto('/');
    await expect(tab.locator('.save-state')).toContainText('已保存');
    await tab.bringToFront();
    await tab.mouse.move(340, 260);
    await expect.poll(state).toBe('active'); // first tab hidden, second tab active
    await tab.close();
    await b.bringToFront();
    await signal(true, true);
    await b.mouse.move(350, 270);
    await expect.poll(state).toBe('active');
    await b.clock.install();
    await b.clock.fastForward(300001);
    await expect.poll(state).toBe('busy');
    await expect(member.locator('.presence-busy')).toHaveCount(1);
    await b.mouse.move(355, 275);
    await b.clock.runFor(1000);
    await expect.poll(state).toBe('active');
    await member.click();
    await expect(a.getByRole('dialog', { name: '在线人员名片', exact: true })).toBeVisible();
    await b.close();
    await expect.poll(state).toBeUndefined();
    const reconnected = await cb.newPage();
    await reconnected.goto('/');
    await expect(reconnected.locator('.save-state')).toContainText('已保存');
    await reconnected.bringToFront();
    await reconnected.mouse.move(350, 260);
    await expect.poll(state).toBe('active');
    const session = (await api(reconnected, '/auth/session')).value;
    expect(session.user).toBeTruthy();
    await api(reconnected, '/auth/logout', 'POST', {});
    await expect.poll(state).toBeUndefined();
    await expect(member).toHaveCount(0);
  } finally {
    await ca.close();
    await cb.close();
  }
});
