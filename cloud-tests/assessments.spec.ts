import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { pool, privatePool } from '../server/db';
import { assessmentToday } from '../src/lib/assessments';
import { plus } from '../src/lib/model';
const origin = 'http://127.0.0.1:5180';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: origin, 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function login(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
function dataset() {
  const d = fixture();
  d.people = [
    { id: 'worker-a', name: '王师傅', role: '施工人员', active: true, trade: '水电', notes: '甲' },
    { id: 'worker-b', name: '王师傅', role: '施工人员', active: true, trade: '水电', notes: '乙' },
    { id: 'worker-c', name: '李师傅', role: '施工人员', active: true, trade: '木工', notes: '' },
    { id: 'worker-d', name: '赵师傅', role: '施工人员', active: true, trade: '木工', notes: '' },
  ];
  d.trades[0].staffIds = ['worker-a', 'worker-b'];
  d.projects.push({ ...d.projects[0], id: 'second-site', name: '第二工地', status: '施工中' });
  return d;
}
const card = (p: Page, project = 'p-home') =>
  p.locator(`.assessment-site-pair[data-project-id="${project}"] .assessment-site-card`);
const row = (p: Page, id: string, project = 'p-home') =>
  card(p, project).locator(`.assessment-day-row[data-person-id="${id}"]`);
async function choose(p: Page, id: string, project = 'p-home') {
  await card(p, project).locator('.assessment-choose-person').first().click();
  await p
    .getByRole('listbox', { name: '已有师傅档案' })
    .locator(`[data-person-id="${id}"]`)
    .click();
  await expect(row(p, id, project)).toBeVisible();
}
async function records(c: BrowserContext, date = assessmentToday()) {
  return (await (await api(c, `/assessments?from=${date}&to=${date}`)).json()).records;
}
async function enter(p: Page) {
  await p.getByRole('button', { name: '人员管理', exact: true }).click();
  await expect(p.getByRole('region', { name: '师傅每日考核', exact: true })).toBeVisible();
}
for (const width of [1280, 1440])
  test(`daily project cards ${width}: Shanghai dates, three slots, searchable identities, extra rows, side summary and cross-project saved statistics`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const f = await fixtureAccounts(),
      c = await browser.newContext({
        viewport: { width, height: 1000 },
        timezoneId: 'America/Los_Angeles',
      });
    try {
      const p = await c.newPage();
      await login(p, f.login, f.password);
      const d = dataset();
      expect((await api(c, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
      await p.reload();
      await enter(p);
      const panel = p.getByRole('region', { name: '师傅每日考核', exact: true });
      await expect(panel.getByLabel('打卡日期', { exact: true })).toHaveValue(assessmentToday());
      expect((await panel.boundingBox())!.y).toBeLessThan(
        (await p.locator('.personnel-directory').boundingBox())!.y,
      );
      await expect(
        p.locator('.personnel-directory').getByRole('button', { name: '新增人员', exact: true }),
      ).toBeVisible();
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(3);
      await expect(card(p, 'second-site').locator('.assessment-day-row')).toHaveCount(3);
      expect(await card(p).locator('.assessment-check:not(:disabled)').count()).toBe(0);
      await card(p).locator('.assessment-remove-empty').first().click();
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(2);
      await card(p).getByRole('button', { name: '＋ 添加人员', exact: true }).click();
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(3);
      expect(await records(c)).toHaveLength(0);

      await panel.getByLabel('打卡日期', { exact: true }).fill(plus(assessmentToday(), 1));
      await expect(panel.getByRole('alert')).toContainText('不能记录未来日期');
      await expect(card(p).locator('.assessment-choose-person').first()).toBeDisabled();
      const date = plus(assessmentToday(), -2);
      await panel.getByLabel('打卡日期', { exact: true }).fill(date);
      await card(p).locator('.assessment-choose-person').first().click();
      const menu = p.getByRole('listbox', { name: '已有师傅档案' });
      await expect(menu.getByRole('option').first()).toContainText('已分配');
      await p.getByLabel('搜索师傅姓名', { exact: true }).fill('王');
      await expect(menu.getByRole('option')).toHaveCount(2);
      await menu.locator('[data-person-id="worker-a"]').click();
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅签到已完成', exact: true })
        .click();
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅拍照未完成', exact: true })
        .click();
      await expect
        .poll(async () => (await records(c, date)).find((r: any) => r.personId === 'worker-a'))
        .toMatchObject({ attendance: 'yes', photo: 'no', cleaning: 'pending' });
      await card(p).locator('.assessment-choose-person').first().click();
      await expect(p.getByRole('listbox').locator('[data-person-id="worker-a"]')).toHaveCount(0);
      await p.getByRole('listbox').locator('[data-person-id="worker-b"]').click();
      await expect.poll(async () => (await records(c, date)).length).toBe(2);
      const before = (await card(p).boundingBox())!;
      await card(p).getByRole('button', { name: '数据小结', exact: true }).click();
      const summary = p.getByRole('complementary', {
        name: d.projects[0].name + '工地数据小结',
        exact: true,
      });
      await expect(summary).toBeVisible();
      const after = (await card(p).boundingBox())!,
        side = (await summary.boundingBox())!;
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      expect(side.x).toBeGreaterThanOrEqual(after.x + after.width);
      await expect(summary.locator('tbody tr')).toHaveCount(2);
      await expect(summary.locator('[data-person-id="worker-a"] td')).toHaveText([
        '1天',
        '0天',
        '0天',
      ]);
      await card(p).getByRole('button', { name: '＋ 添加人员', exact: true }).click();
      await choose(p, 'worker-c');
      await choose(p, 'worker-d');
      await expect.poll(async () => (await records(c, date)).length).toBe(4);
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(4);
      await choose(p, 'worker-a', 'second-site');
      await row(p, 'worker-a', 'second-site')
        .getByRole('button', { name: '王师傅签到已完成', exact: true })
        .click();
      await row(p, 'worker-a', 'second-site')
        .getByRole('button', { name: '王师傅拍照已完成', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await records(c, date)).find((r: any) => r.projectId === 'second-site')?.photo,
        )
        .toBe('yes');
      await panel.getByLabel('师傅跨工地查询', { exact: true }).selectOption('worker-a');
      const stats = p.getByRole('region', { name: '王师傅跨工地统计', exact: true });
      await expect(stats).toContainText('签到 2');
      await expect(stats).toContainText('覆盖 1 个自然日');
      await expect(stats.locator('.assessment-person-projects > article')).toHaveCount(2);
      await stats.getByText('每日明细 · 1天', { exact: true }).first().click();
      await expect(stats.locator('table').first()).toContainText(date);
      await panel.getByLabel('打卡日期', { exact: true }).fill(plus(date, -1));
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(3);
      await expect(card(p).locator('.assessment-day-row[data-person-id]')).toHaveCount(0);
      await panel.getByLabel('打卡日期', { exact: true }).fill(date);
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅卫生已完成', exact: true })
        .click();
      await expect(summary.locator('[data-person-id="worker-a"] td')).toHaveText([
        '1天',
        '0天',
        '1天',
      ]);
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅卫生未记录', exact: true })
        .click();
      await expect(summary.locator('[data-person-id="worker-a"] td')).toHaveText([
        '1天',
        '0天',
        '0天',
      ]);
      await expect
        .poll(
          async () =>
            (await records(c, date)).find(
              (r: any) => r.personId === 'worker-a' && r.projectId === 'p-home',
            )?.cleaning,
        )
        .toBe('pending');
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅卫生未完成', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await records(c, date)).find(
              (r: any) => r.personId === 'worker-a' && r.projectId === 'p-home',
            )?.cleaning,
        )
        .toBe('no');
      await row(p, 'worker-a')
        .getByRole('button', { name: '王师傅卫生已完成', exact: true })
        .click();
      await expect(summary.locator('[data-person-id="worker-a"] td')).toHaveText([
        '1天',
        '0天',
        '1天',
      ]);
      await expect(row(p, 'worker-a').locator('.assessment-remove-empty')).toHaveCount(0);
      const saved = (await records(c, date)).find(
        (r: any) => r.personId === 'worker-a' && r.projectId === 'p-home',
      );
      expect(saved.date).toBe(date);
      expect(Math.abs(Date.now() - Date.parse(saved.createdAt))).toBeLessThan(90000);
      await row(p, 'worker-a').getByRole('button', { name: '王师傅', exact: true }).click();
      await expect(p.getByRole('dialog', { name: '考核历史 · 王师傅', exact: true })).toContainText(
        '实际首次录入',
      );
      await p.getByRole('button', { name: '关闭', exact: true }).click();
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await p.screenshot({ path: `/tmp/daily-assessment-${width}.png`, fullPage: true });
      await p.reload();
      await enter(p);
      await p.getByLabel('打卡日期', { exact: true }).fill(date);
      await expect(
        row(p, 'worker-a').getByRole('button', { name: '王师傅卫生已完成', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(card(p).locator('.assessment-day-row')).toHaveCount(4);
      expect((await records(c, date)).length).toBe(5);
    } finally {
      await c.close();
    }
  });

test('daily collaboration: separate sites, exact conflict review, offline refresh and re-login preserve all confirmed checks', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await fixtureAccounts(),
    ca = await browser.newContext(),
    cb = await browser.newContext();
  try {
    const a = await ca.newPage(),
      b = await cb.newPage();
    await login(a, f.login, f.password);
    await login(b, f.employee, f.password);
    expect((await api(ca, '/workspace', 'PUT', { revision: 0, data: dataset() })).status()).toBe(
      200,
    );
    expect(
      (await api(ca, '/assessments/recorders/' + f.employeeId, 'PUT', { enabled: true })).status(),
    ).toBe(200);
    await a.reload();
    await b.reload();
    await enter(a);
    await enter(b);
    await choose(a, 'worker-a');
    await choose(b, 'worker-a', 'second-site');
    await Promise.all([
      row(a, 'worker-a').getByRole('button', { name: '王师傅签到已完成', exact: true }).click(),
      row(b, 'worker-a', 'second-site')
        .getByRole('button', { name: '王师傅签到已完成', exact: true })
        .click(),
    ]);
    await expect
      .poll(async () => (await records(ca)).filter((r: any) => r.attendance === 'yes').length)
      .toBe(2);
    await expect(row(b, 'worker-a')).toBeVisible({ timeout: 10000 });
    await expect(
      row(b, 'worker-a').getByRole('button', { name: '王师傅签到已完成', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    let held = false,
      release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await a.route('**/api/assessments/batch', async (route) => {
      if (!held) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await row(a, 'worker-a').getByRole('button', { name: '王师傅拍照已完成', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await row(b, 'worker-a').getByRole('button', { name: '王师傅拍照未完成', exact: true }).click();
    await expect
      .poll(async () => (await records(ca)).find((r: any) => r.projectId === 'p-home').photo)
      .toBe('no');
    release();
    await expect(row(a, 'worker-a').locator('.assessment-conflict')).toBeVisible();
    await expect(row(a, 'worker-a').locator('.assessment-conflict')).toContainText(
      '本地选择仍保留',
    );
    await row(a, 'worker-a')
      .getByRole('button', { name: '核对后按最新版本重试本行', exact: true })
      .click();
    await expect
      .poll(async () => (await records(ca)).find((r: any) => r.projectId === 'p-home').photo)
      .toBe('yes');
    await expect(row(a, 'worker-a').locator('.assessment-conflict')).toHaveCount(0);
    await a.unroute('**/api/assessments/batch');
    let offline = true;
    const receipts: string[] = [];
    await a.route('**/api/assessments/batch', async (route) => {
      receipts.push(route.request().postDataJSON().requestId);
      if (offline) await route.abort('failed');
      else await route.continue();
    });
    await row(a, 'worker-a').getByRole('button', { name: '王师傅卫生已完成', exact: true }).click();
    await expect(a.locator('.assessment-sync-status')).toContainText('本地已保存');
    await expect.poll(() => receipts.length).toBeGreaterThan(0);
    const receipt = receipts[0];
    await a.reload();
    await enter(a);
    await expect(
      row(a, 'worker-a').getByRole('button', { name: '王师傅卫生已完成', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(a.locator('.assessment-sync-status')).toContainText('本地已保存');
    expect((await records(ca)).find((r: any) => r.projectId === 'p-home').cleaning).toBe('pending');
    offline = false;
    await a.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect
      .poll(async () => (await records(ca)).find((r: any) => r.projectId === 'p-home').cleaning)
      .toBe('yes');
    await expect(a.locator('.assessment-sync-status')).toHaveCount(0);
    expect(new Set(receipts)).toEqual(new Set([receipt]));
    const saved = await records(ca);
    expect(saved).toHaveLength(2);
    expect(saved.find((r: any) => r.projectId === 'p-home')).toMatchObject({
      attendance: 'yes',
      photo: 'yes',
      cleaning: 'yes',
    });
    await api(ca, '/auth/logout', 'POST', {});
    await login(a, f.login, f.password);
    await enter(a);
    await expect(
      row(a, 'worker-a').getByRole('button', { name: '王师傅卫生已完成', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(await records(ca)).toEqual(saved);
  } finally {
    await ca.close();
    await cb.close();
  }
});

test('assessment recorder authorization is explicit, scoped, live-revocable and keeps the actual employee author', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const f = await fixtureAccounts(),
    owner = await browser.newContext(),
    monitor = await browser.newContext();
  try {
    const a = await owner.newPage(),
      b = await monitor.newPage();
    await login(a, f.login, f.password);
    await login(b, f.employee, f.password);
    await api(monitor, '/auth/profile', 'PATCH', { displayName: '监理小陈' });
    const d = dataset();
    await api(owner, '/workspace', 'PUT', { revision: 0, data: d });
    await a.reload();
    await b.reload();
    for (const p of [a, b]) await p.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(b.getByText('考核记录仅向负责人及其授权的记录人开放。')).toBeVisible();
    expect((await api(monitor, '/assessments/export')).status()).toBe(403);
    await a.getByRole('button', { name: '考核记录人授权', exact: true }).click();
    const grants = a.getByRole('dialog', { name: '考核记录人授权', exact: true });
    await grants.getByRole('checkbox', { name: `监理小陈（${f.employee}）`, exact: true }).click();
    await a
      .getByRole('dialog', { name: '修改考核授权？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(grants.getByRole('checkbox')).toBeChecked();
    await expect(b.getByRole('region', { name: '师傅每日考核', exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(b.getByRole('button', { name: '考核记录人授权', exact: true })).toHaveCount(0);
    await choose(b, 'worker-a');
    await row(b, 'worker-a').getByRole('button', { name: '王师傅拍照已完成', exact: true }).click();
    await expect
      .poll(async () => (await records(monitor)).find((r: any) => r.personId === 'worker-a')?.photo)
      .toBe('yes');
    expect((await records(monitor))[0].createdName).toBe('监理小陈');
    await grants.getByRole('checkbox').click();
    await a
      .getByRole('dialog', { name: '修改考核授权？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(grants.getByRole('checkbox')).not.toBeChecked();
    expect((await api(monitor, '/assessments')).status()).toBe(403);
    await expect(b.getByText('考核记录仅向负责人及其授权的记录人开放。')).toBeVisible({
      timeout: 10000,
    });
    await expect(b.locator('.assessment-site-card')).toHaveCount(0);
    expect(
      (
        await api(monitor, '/assessments/recorders/' + f.employeeId, 'PUT', { enabled: true })
      ).status(),
    ).toBe(403);
  } finally {
    await owner.close();
    await monitor.close();
  }
});
