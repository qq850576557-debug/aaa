import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { pool, privatePool } from '../server/db';
import { readFile } from 'node:fs/promises';
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
    { id: 'worker-a', name: '王师傅', role: '施工人员', active: true, trade: '水电', notes: '' },
    { id: 'worker-b', name: '李师傅', role: '施工人员', active: true, trade: '水电', notes: '' },
  ];
  d.trades[0].staffIds = ['worker-a', 'worker-b'];
  const p = {
    ...d.projects[0],
    id: 'completed-project',
    name: '完工工地',
    status: '已完工' as const,
  };
  d.projects.push(p);
  d.trades.push({ ...d.trades[0], id: 'completed-trade', projectId: p.id, staffIds: ['worker-a'] });
  return d;
}
for (const width of [1440, 390])
  test(`assessment ${width}: real daily states, confirmed batch, history, month/year stats, complete CSV and isolated dates/projects`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      c = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const p = await c.newPage();
      await login(p, f.login, f.password);
      const d = dataset();
      expect((await api(c, '/workspace', 'PUT', { revision: 0, data: d })).status()).toBe(200);
      await p.reload();
      await p.getByRole('button', { name: '人员管理', exact: true }).click();
      const panel = p.getByRole('region', { name: '师傅日常考核', exact: true });
      await panel.getByLabel('考核日期', { exact: true }).fill('2026-10-27');
      await panel.getByLabel('考核项目', { exact: true }).selectOption(d.projects[0].id);
      const daily = panel.getByRole('table', { name: '师傅每日考核', exact: true });
      await expect(daily.locator('tbody tr')).toHaveCount(2);
      await expect(daily.getByRole('button', { name: /：待记录$/ })).toHaveCount(6);
      await daily
        .getByRole('button', { name: '王师傅·现场拆改·下班拍照：待记录', exact: true })
        .click();
      let editor = p.getByRole('dialog', { name: '记录师傅考核', exact: true });
      await editor.getByLabel('记录今日签到', { exact: true }).selectOption('yes');
      await editor.getByLabel('记录下班拍照', { exact: true }).selectOption('yes');
      await editor.getByLabel('记录下班卫生', { exact: true }).selectOption('no');
      await editor.getByRole('button', { name: '核对并保存', exact: true }).click();
      let confirm = p.getByRole('dialog', { name: '确认保存考核？', exact: true });
      await expect(confirm).toContainText('王师傅');
      expect(
        (await (await api(c, '/assessments?from=2026-10-27&to=2026-10-27')).json()).records,
      ).toHaveLength(0);
      await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
      await expect(
        daily.getByRole('button', { name: '王师傅·现场拆改·下班拍照：已拍照', exact: true }),
      ).toBeVisible();
      await p.reload();
      await p.getByRole('button', { name: '人员管理', exact: true }).click();
      await panel.getByLabel('考核日期', { exact: true }).fill('2026-10-27');
      await panel.getByLabel('考核项目', { exact: true }).selectOption(d.projects[0].id);
      await expect(daily.getByRole('button', { name: /王师傅.*下班卫生：未打扫/ })).toBeVisible();
      for (const name of ['王师傅', '李师傅'])
        await daily
          .getByRole('checkbox', {
            name: `选择${name}·${d.projects[0].name}·现场拆改`,
            exact: true,
          })
          .check();
      await panel.getByRole('button', { name: '批量记录（2）', exact: true }).click();
      editor = p.getByRole('dialog', { name: '批量记录 2 条', exact: true });
      await expect(editor).toContainText('王师傅');
      await expect(editor).toContainText('李师傅');
      await editor.getByLabel('记录下班卫生', { exact: true }).selectOption('yes');
      await editor.getByRole('button', { name: '核对并保存', exact: true }).click();
      confirm = p.getByRole('dialog', { name: '确认保存考核？', exact: true });
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      expect(
        (await (await api(c, '/assessments?from=2026-10-27&to=2026-10-27')).json()).records,
      ).toHaveLength(1);
      await editor.getByRole('button', { name: '核对并保存', exact: true }).click();
      await p
        .getByRole('dialog', { name: '确认保存考核？', exact: true })
        .getByRole('button', { name: '确认操作', exact: true })
        .click();
      await expect(daily.getByRole('button', { name: /下班卫生：已打扫$/ })).toHaveCount(2);
      await expect(daily.getByRole('button', { name: /李师傅.*下班拍照：待记录$/ })).toBeVisible();
      await daily
        .locator('tbody tr')
        .filter({ hasText: '王师傅' })
        .getByRole('button', { name: '修改历史', exact: true })
        .click();
      let h = p.getByRole('dialog', { name: '考核历史 · 王师傅', exact: true });
      await expect(h.locator('article')).toHaveCount(2);
      await expect(h).toContainText('未打扫 → 已打扫');
      await h.getByRole('button', { name: '关闭', exact: true }).click();
      await panel.getByRole('button', { name: '师傅考核统计', exact: true }).click();
      await panel.getByLabel('统计基准日期', { exact: true }).fill('2026-10-27');
      const stats = panel.getByRole('table', { name: '师傅考核统计', exact: true });
      await expect(stats.locator('tbody tr')).toHaveCount(2);
      await expect(
        stats.locator('tbody tr').filter({ hasText: '王师傅' }).locator('td'),
      ).toHaveText(['1', '1', '0', '0', '1', '0', '0']);
      await panel.getByLabel('统计周期', { exact: true }).selectOption('year');
      await expect(panel).toContainText('2026-01-01 — 2026-12-31');
      const download = p.waitForEvent('download');
      await panel.getByRole('button', { name: '导出考核明细 CSV', exact: true }).click();
      const file = await download;
      const csv = await readFile((await file.path())!, 'utf8');
      expect(csv).toContain('王师傅');
      expect(csv).toContain('李师傅');
      expect(csv).toContain('待记录');
      await panel.getByLabel('考核师傅', { exact: true }).selectOption('worker-a');
      await expect(stats.locator('tbody tr')).toHaveCount(1);
      await panel.getByRole('button', { name: '返回每日记录', exact: true }).click();
      await panel.getByLabel('考核日期', { exact: true }).fill('2026-10-26');
      await expect(daily.getByRole('button', { name: /：待记录$/ })).toHaveCount(3);
      await panel.getByLabel('考核项目', { exact: true }).selectOption('completed-project');
      await panel.getByLabel('考核日期', { exact: true }).fill('2026-10-27');
      await expect(daily.getByRole('button', { name: /：待记录$/ })).toHaveCount(3);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await c.close();
    }
  });
test('assessment recorder authorization is explicit, scoped and immediately revocable; employee records server identity', async ({
  browser,
}) => {
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
    let grants = a.getByRole('dialog', { name: '考核记录人授权', exact: true });
    await grants.getByRole('checkbox', { name: `监理小陈（${f.employee}）`, exact: true }).click();
    await a
      .getByRole('dialog', { name: '修改考核授权？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(grants.getByRole('checkbox')).toBeChecked();
    await b.reload();
    await b.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(b.getByRole('table', { name: '师傅每日考核', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: '考核记录人授权', exact: true })).toHaveCount(0);
    const key = {
      date: '2026-10-27',
      personId: 'worker-a',
      projectId: d.projects[0].id,
      tradeId: d.trades[0].id,
      version: 0,
      changes: { photo: 'yes' },
    };
    const made = await api(monitor, '/assessments/batch', 'POST', {
      requestId: crypto.randomUUID(),
      confirmed: true,
      edits: [key],
    });
    expect(made.status()).toBe(200);
    expect((await made.json()).records[0].createdName).toBe('监理小陈');
    await grants.getByRole('checkbox').click();
    await a
      .getByRole('dialog', { name: '修改考核授权？', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(grants.getByRole('checkbox')).not.toBeChecked();
    expect((await api(monitor, '/assessments')).status()).toBe(403);
    expect(
      (
        await api(monitor, '/assessments/recorders/' + f.employeeId, 'PUT', { enabled: true })
      ).status(),
    ).toBe(403);
    await b.reload();
    await b.getByRole('button', { name: '人员管理', exact: true }).click();
    await expect(b.getByRole('table', { name: '师傅每日考核', exact: true })).toHaveCount(0);
  } finally {
    await owner.close();
    await monitor.close();
  }
});
