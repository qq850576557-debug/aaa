import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { pool, privatePool } from '../server/db';
import { readFile } from 'node:fs/promises';
test.afterAll(async () => {
  if (!pool.ended) await pool.end();
  if (!privatePool.ended) await privatePool.end();
});
async function api(c: BrowserContext, path: string, method = 'GET', data?: unknown) {
  const s = await (await c.request.get('/api/auth/session')).json();
  return c.request.fetch('/api' + path, {
    method,
    headers: { Origin: 'http://127.0.0.1:5180', 'X-CSRF-Token': s.csrf },
    ...(data === undefined ? {} : { data }),
  });
}
async function enter(p: Page, login: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(login);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
async function confirm(p: Page) {
  await p.getByRole('button', { name: '核对并保存', exact: true }).click();
  await p
    .getByRole('dialog', { name: '确认材料操作？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(p.getByRole('dialog', { name: '确认材料操作？', exact: true })).toHaveCount(0);
  await expect(p.locator('.material-notice')).toContainText('服务端已保存');
}
for (const width of [1440, 390])
  test(`materials ${width}: real stock/consumption, count reconciliation, analysis, trace, CSV and refresh`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      c = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const p = await c.newPage();
      await enter(p, f.login, f.password);
      const d = fixture();
      const write = await api(c, '/workspace', 'PUT', { revision: 0, data: d });
      expect(write.ok()).toBe(true);
      await p.reload();
      await p.getByRole('button', { name: '材料资产管理', exact: true }).click();
      const panel = p.getByRole('region', { name: '材料资产管理', exact: true });
      await expect(panel).toContainText('请先选择工地');
      await panel.getByLabel('材料项目', { exact: true }).selectOption(d.projects[0].id);
      const nav = panel.getByRole('navigation', { name: '材料子页面' });
      const layout = await nav.evaluate((e) => ({
        direction: getComputedStyle(e).flexDirection,
        height: e.getBoundingClientRect().height,
      }));
      expect(layout.direction).toBe('row');
      expect(layout.height).toBeLessThan(width === 1440 ? 100 : 240);
      await panel.getByRole('button', { name: '新增材料规格', exact: true }).click();
      let modal = p.getByRole('dialog', { name: '材料规格', exact: true });
      for (const [label, value] of [
        ['材料名称', '测试防滑砖'],
        ['材料类别', '瓷砖'],
        ['基准计量单位', 'm²'],
        ['规格型号', '600×600'],
        ['材料性能/等级', '防滑A'],
      ])
        await modal.getByLabel(label, { exact: true }).fill(value);
      await confirm(p);
      const made = await (await api(c, '/materials')).json(),
        materialId = made.materials[0].id;
      await panel.getByRole('button', { name: '工地材料台账', exact: true }).click();
      await panel.getByRole('button', { name: '项目比较条件', exact: true }).click();
      modal = p.getByRole('dialog', { name: '项目比较条件', exact: true });
      for (const [label, value] of [
        ['建筑面积 m²', '100'],
        ['实际施工面积 m²', '80'],
        ['项目类型', '住宅'],
        ['户型特征', '三房'],
        ['装修档次', '中档'],
        ['设计方案/可比条件', '直铺'],
      ])
        await modal.getByLabel(label, { exact: true }).fill(value);
      await confirm(p);
      await panel.getByRole('button', { name: '新增核算阶段', exact: true }).click();
      modal = p.getByRole('dialog', { name: '施工阶段与核算基数', exact: true });
      await modal.getByLabel('核算所属项目', { exact: true }).selectOption(d.projects[0].id);
      await modal.getByLabel('核算材料规格', { exact: true }).selectOption(materialId);
      for (const [label, value] of [
        ['施工阶段', '铺贴'],
        ['施工区域标识（同阶段不重复）', '客厅'],
        ['班组名称', '铺贴一组'],
        ['实际基数数值', '10'],
        ['施工工艺', '薄贴'],
        ['铺贴/布线/涂刷方式', '直铺'],
        ['预算用量（材料基准单位）', '10'],
        ['预算单价 元/基准单位', '10'],
        ['监理确认实际进度 %', '50'],
      ])
        await modal.getByLabel(label, { exact: true }).fill(value);
      await confirm(p);
      const ctx = (await (await api(c, '/materials')).json()).contexts[0].id;
      await panel.getByRole('button', { name: '采购、领用及库存流水', exact: true }).click();
      async function event(kind: string, q: string, reference = '') {
        await panel.getByRole('button', { name: '登记材料流水', exact: true }).click();
        modal = p.getByRole('dialog', { name: '材料库存流水', exact: true });
        await modal.getByLabel('流水类型', { exact: true }).selectOption(kind);
        await modal.getByLabel('流水所属项目', { exact: true }).selectOption(d.projects[0].id);
        await modal.getByLabel('流水材料规格', { exact: true }).selectOption(materialId);
        if (['issue', 'use', 'loss_site'].includes(kind))
          await modal
            .getByLabel('施工阶段/班组（使用及损耗必选）', { exact: true })
            .selectOption(ctx);
        await modal.getByLabel('数量/盘点实存（清仓、重开、冲销填0）', { exact: true }).fill(q);
        await modal.getByLabel('入账单价 元/基准单位（其他操作填0）', { exact: true }).fill('10');
        if (reference)
          await modal.getByLabel('盘点核销或冲销原流水', { exact: true }).selectOption(reference);
        await modal.getByLabel('原始凭据/操作原因（必填）', { exact: true }).fill('现场核对凭据');
        await confirm(p);
      }
      await event('receipt', '30');
      await event('issue', '20');
      await event('use', '15');
      await event('count_site', '8');
      let state = await (await api(c, '/materials')).json();
      const count = state.events.find((e: any) => e.kind === 'count_site');
      await event('loss_site', '2', count.id);
      await panel.getByRole('button', { name: '材料消耗分析', exact: true }).click();
      await expect(panel).toContainText('已使用 15.000');
      await expect(panel).toContainText('总耗 17.000');
      await expect(panel).toContainText('不足5个');
      await panel.getByRole('button', { name: '异常预警与处理记录', exact: true }).click();
      const alert = panel.locator('.material-risk').filter({ hasText: '超过预算用量' });
      await expect(alert).toContainText('待核查');
      await alert.getByRole('button', { name: '记录核查与复核', exact: true }).click();
      modal = p.getByRole('dialog', { name: '材料异常核查', exact: true });
      await modal.getByLabel('处理状态', { exact: true }).selectOption('核查中');
      await modal
        .getByLabel('核查/处理/复核原因（必填）', { exact: true })
        .fill('正在核对现场铺贴面积');
      await confirm(p);
      await expect(alert).toContainText('核查中');
      await alert.getByRole('button', { name: '处理历史', exact: true }).click();
      await expect(p.getByRole('dialog', { name: '异常处理历史', exact: true })).toContainText(
        '正在核对现场铺贴面积',
      );
      await p
        .getByRole('dialog', { name: '异常处理历史', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await panel.getByRole('button', { name: '历史统计及 CSV 导出', exact: true }).click();
      const dl = p.waitForEvent('download');
      await panel.getByRole('button', { name: '导出原始流水 CSV', exact: true }).click();
      const download = await dl;
      const csv = await readFile((await download.path())!, 'utf8');
      expect(csv).toContain(materialId);
      expect(csv).toContain('现场核对凭据');
      const stat = p.waitForEvent('download');
      await panel.getByRole('button', { name: '导出统计 CSV', exact: true }).click();
      expect(await readFile((await (await stat).path())!, 'utf8')).toContain('17.000');
      const chart = panel.locator('.material-chart').first();
      await expect(chart).toContainText('17.000 m²');
      await chart.getByRole('button').click();
      await expect(panel.getByLabel('项目类型筛选', { exact: true })).toHaveValue('住宅');
      await panel.getByRole('button', { name: '历史统计及 CSV 导出', exact: true }).click();
      await panel.getByRole('button', { name: '查看原始记录', exact: true }).click();
      await expect(panel.getByLabel('项目类型筛选', { exact: true })).toHaveValue('住宅');
      await expect(panel.getByLabel('流水起始日期', { exact: true })).toHaveValue(
        new Date().toISOString().slice(0, 7) + '-01',
      );
      await p.reload();
      await p.getByRole('button', { name: '材料资产管理', exact: true }).click();
      await panel.getByRole('button', { name: '工地材料台账', exact: true }).click();
      state = await (await api(c, '/materials')).json();
      expect(state.events.length).toBe(5);
      expect(state.analysis.stocks[0].siteQty).toBe('8.000');
      expect(state.analysis.stocks[0].crewQty).toBe('5.000');
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await p.screenshot({ path: `/tmp/chunmo-materials-${width}.png` });
    } finally {
      await c.close();
    }
  });
