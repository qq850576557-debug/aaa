import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { assessmentToday } from '../src/lib/assessments';
async function api(p: Page, path: string, method = 'GET', data?: unknown) {
  const s = await (await p.request.get('/api/auth/session')).json();
  return p.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data ? { data } : {}),
  });
}
async function enter(p: Page) {
  const f = await fixtureAccounts();
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(f.login);
  await p.getByLabel('登录密码', { exact: true }).fill(f.password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
  const d = fixture();
  d.people = ['甲师傅', '乙师傅', '丙师傅'].map((name, index) => ({
    id: 'quiet-' + index,
    name,
    role: '施工人员' as const,
    trade: '木工',
    notes: '',
    active: true,
  }));
  d.projects.push({ ...d.projects[0], id: 'quiet-site', name: '另一工地' });
  await api(p, '/workspace', 'PUT', { revision: 0, data: d });
  await p.reload();
  await p.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(p.locator('.daily-assessment')).toBeVisible();
  return d;
}
const card = (p: Page) =>
  p.locator('.assessment-site-pair[data-project-id="p-home"] .assessment-site-card');
async function choose(p: Page, index: number, id: string) {
  await card(p).locator('.assessment-choose-person').nth(index).click();
  await p.getByRole('listbox').locator(`[data-person-id="${id}"]`).click();
}
async function saved(p: Page) {
  return (
    await (await api(p, `/assessments?from=${assessmentToday()}&to=${assessmentToday()}`)).json()
  ).records;
}
for (const width of [1280, 1440])
  test(`quiet desktop ${width}: stable sidebar and toolbars, uniform dropdowns, no animated saving feedback`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await enter(page);
    await expect(card(page).locator('.assessment-day-row')).toHaveCount(3);
    const area = page.locator('.daily-assessment');
    await expect(area.locator('.assessment-remove-empty,.assessment-history-link')).toHaveCount(0);
    const snapshot = () =>
      page.evaluate(() => ({
        sidebar: document.querySelector('.sidebar-project-list')?.getBoundingClientRect().toJSON(),
        save: document.querySelector('.sidebar-save-status')!.getBoundingClientRect().toJSON(),
        toolbar: document
          .querySelector('.daily-assessment > .section-heading .toolbar')!
          .getBoundingClientRect()
          .toJSON(),
        site: document.querySelector('.assessment-site-card')!.getBoundingClientRect().toJSON(),
      }));
    await choose(page, 0, 'quiet-0');
    await expect(
      card(page).getByRole('combobox', { name: '甲师傅签到', exact: true }),
    ).toBeEnabled();
    await expect.poll(async () => (await saved(page)).length).toBe(1);
    const before = await snapshot();
    const confirmedAt = await page.locator('.save-confirmed-time').getAttribute('datetime');
    await page
      .locator('.sidebar-project-list .project-card')
      .first()
      .evaluate((el) => ((window as any).__quietSidebar = el));
    await card(page)
      .locator('.assessment-day-row[data-person-id="quiet-0"]')
      .evaluate((el) => ((window as any).__quietRow = el));
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/assessments/batch', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await card(page)
        .getByRole('combobox', { name: '甲师傅签到', exact: true })
        .selectOption('yes');
      await expect(
        card(page).getByRole('combobox', { name: '甲师傅签到', exact: true }),
      ).toHaveValue('yes');
      await expect(area.locator('.assessment-sync-status')).toHaveText('统计以云端确认记录为准。');
      await expect(area.getByRole('button', { name: '导出待同步副本' })).toHaveCount(0);
      const during = await snapshot();
      expect(await page.locator('.save-confirmed-time').getAttribute('datetime')).toBe(confirmedAt);
      expect(during).toEqual(before);
      expect(
        await card(page)
          .locator('.assessment-day-row[data-person-id="quiet-0"]')
          .evaluate((el) => el === (window as any).__quietRow),
      ).toBe(true);
      expect(await area.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
      expect(
        await page
          .locator('.sidebar-project-list')
          .evaluate((el) => el.getAnimations({ subtree: true }).length),
      ).toBe(0);
      expect(
        await page
          .locator('.sidebar-project-list .project-card')
          .first()
          .evaluate((el) => el === (window as any).__quietSidebar),
      ).toBe(true);
      const time = page.locator('.save-confirmed-time');
      expect(await time.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(22);
      await expect(page.locator('.save-label')).toHaveText('最新保存：');
      release();
      await expect.poll(async () => (await saved(page))[0].attendance).toBe('yes');
      await expect(page.locator('.sidebar-save-status .save-current-state')).toHaveCSS(
        'visibility',
        'hidden',
      );
      expect(await snapshot()).toEqual(before);
      await card(page).getByRole('button', { name: '数据小结', exact: true }).click();
      await expect(
        page.locator('.assessment-summary').getByRole('button', { name: '查看甲师傅打卡历史' }),
      ).toBeVisible();
      await page
        .locator('.assessment-summary')
        .getByRole('button', { name: '查看甲师傅打卡历史' })
        .click();
      await expect(page.getByRole('dialog', { name: '考核历史 · 甲师傅' })).toContainText(
        '实际首次录入',
      );
      await page.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await page.screenshot({ path: `/tmp/quiet-assessments-${width}.png`, fullPage: true });
    } finally {
      release();
    }
  });
test('names can be replaced or cleared without marks; any previously recorded content requires confirmation and preserves history', async ({
  page,
}) => {
  await enter(page);
  await choose(page, 1, 'quiet-0');
  await expect.poll(async () => (await saved(page)).length).toBe(1);
  const width = (await card(page).boundingBox())!.width;
  await choose(page, 1, 'quiet-1');
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('乙师傅');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () => (await saved(page)).find((r: any) => r.personId === 'quiet-0')?.withdrawn)
    .toBe(true);
  await choose(page, 1, '');
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('选择师傅');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card(page).locator('.assessment-day-row')).toHaveCount(3);
  await choose(page, 1, 'quiet-0');
  const state = card(page).getByRole('combobox', { name: '甲师傅拍照', exact: true });
  await expect(state).toBeEnabled();
  await state.selectOption('yes');
  await expect
    .poll(async () => (await saved(page)).find((r: any) => r.personId === 'quiet-0')?.photo)
    .toBe('yes');
  await state.selectOption('pending');
  await expect
    .poll(async () => (await saved(page)).find((r: any) => r.personId === 'quiet-0')?.photo)
    .toBe('pending');
  await choose(page, 1, 'quiet-1');
  const dialog = page.getByRole('dialog', { name: '确认更换打卡人员' });
  await expect(dialog).toContainText('已有打卡记录，是否确认更换打卡人员？');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('甲师傅');
  await choose(page, 1, 'quiet-1');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('乙师傅');
  await expect(card(page).getByRole('combobox', { name: '乙师傅拍照', exact: true })).toHaveValue(
    'pending',
  );
  expect((await card(page).boundingBox())!.width).toBe(width);
  const old = (await saved(page)).find((r: any) => r.personId === 'quiet-0');
  expect(old.withdrawn).toBe(true);
  const history = await (await api(page, `/assessments/${old.id}/history`)).json();
  expect(history.events.some((e: any) => e.after.photo === 'yes')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(card(page).getByRole('combobox', { name: '乙师傅拍照', exact: true })).toHaveValue(
    'pending',
  );
  await expect(card(page).locator('.assessment-day-row')).toHaveCount(3);
});

test('after another tab changes a person, replacing the visible row uses that actual ID and keeps other rows fixed', async ({
  page,
}) => {
  await enter(page);
  await choose(page, 0, 'quiet-0');
  await choose(page, 1, 'quiet-1');
  await expect.poll(async () => (await saved(page)).length).toBe(2);
  const a = (await saved(page)).find((r: any) => r.personId === 'quiet-0');
  expect(
    (
      await api(page, '/assessments/batch', 'POST', {
        requestId: crypto.randomUUID(),
        confirmed: true,
        edits: [
          {
            date: a.date,
            projectId: a.projectId,
            personId: a.personId,
            tradeId: a.tradeId,
            version: a.version,
            changes: { withdrawn: true, correctionReason: '隔离测试：另一标签页更换人员' },
          },
          {
            date: a.date,
            projectId: a.projectId,
            personId: 'quiet-2',
            tradeId: 'daily',
            version: 0,
            changes: { attendance: 'pending', photo: 'pending', cleaning: 'pending' },
          },
        ],
      })
    ).status(),
  ).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event('chunmo-assessments-changed')));
  await expect(card(page).locator('.assessment-choose-person').nth(0)).toContainText('丙师傅');
  await choose(page, 0, '');
  await expect(card(page).locator('.assessment-choose-person').nth(0)).toContainText('选择师傅');
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('乙师傅');
  await expect
    .poll(async () => (await saved(page)).find((r: any) => r.personId === 'quiet-2').withdrawn)
    .toBe(true);
  await choose(page, 0, 'quiet-0');
  await expect(card(page).locator('.assessment-day-row[data-person-id="quiet-0"]')).toHaveCount(1);
  await expect(card(page).locator('.assessment-choose-person').nth(1)).toContainText('乙师傅');
  await expect
    .poll(async () =>
      (await saved(page))
        .filter((r: any) => !r.withdrawn)
        .map((r: any) => r.personId)
        .sort(),
    )
    .toEqual(['quiet-0', 'quiet-1']);
});
