import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { pool, privatePool } from '../server/db';
import { PNG } from 'pngjs';
import { randomUUID } from 'node:crypto';
import { today } from '../src/lib/model';
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
async function login(p: Page, name: string, password: string) {
  await p.goto('/');
  await p.getByLabel('登录账号', { exact: true }).fill(name);
  await p.getByLabel('登录密码', { exact: true }).fill(password);
  await p.getByRole('button', { name: '登录', exact: true }).click();
  await expect(p.locator('.save-state')).toContainText('已保存');
}
for (const width of [1440, 390]) {
  test(`V1.1 cloud ${width}: purchase provenance survives complete/reopen/re-login/delete and stock is independent`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      c = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const p = await c.newPage();
      await login(p, f.login, f.password);
      const d = fixture();
      d.purchases = [];
      d.notes = [];
      await api(c, '/workspace', 'PUT', { revision: 0, data: d });
      await p.reload();
      await p.getByRole('button', { name: '采购管理', exact: true }).click();
      await p.getByRole('button', { name: '新增采购', exact: true }).click();
      let modal = p.getByRole('dialog', { name: '新增采购事项', exact: true });
      if (!(await modal.count())) modal = p.getByRole('dialog', { name: /新建采购事项/ });
      await modal.getByLabel('采购内容 / 事项标题', { exact: true }).fill('V11测试采购');
      await modal.getByLabel('采购截止日期', { exact: true }).fill(today());
      await modal.getByRole('button', { name: '保存', exact: true }).click();
      await p.getByLabel('采购记录筛选', { exact: true }).selectOption('待采购');
      const panel = p.locator('.purchase-list');
      await expect(panel).toContainText('V11测试采购');
      await panel.getByRole('button', { name: '完成采购V11测试采购', exact: true }).click();
      await expect(panel).not.toContainText('V11测试采购');
      await p.getByRole('button', { name: '采购管理', exact: true }).click();
      await p.getByLabel('采购记录筛选', { exact: true }).selectOption('已完成');
      const row = p.locator('.purchase-list .purchase-row');
      await expect(row).toContainText('V11测试采购');
      // The compact card intentionally omits provenance controls. Verify the
      // same trustworthy server history remains, rather than dropping coverage.
      const completed = (await (await api(c, '/workspace')).json()).data.purchases[0];
      await expect
        .poll(async () => {
          const records = (await (await api(c, '/purchase-records')).json()).records;
          return records.find((r: any) => r.id === completed.id)?.completedAt;
        })
        .toBeTruthy();
      const completedHistory = await (
        await api(c, '/purchase-records/' + completed.id + '/history')
      ).json();
      expect(completedHistory.events.at(-1)).toMatchObject({ operation: '完成', actorId: f.id });
      expect(completedHistory.events.at(-1).actorName).toBeTruthy();
      expect(completedHistory.events.at(-1).at).toBeTruthy();
      await expect(row.locator('.purchase-trace')).toHaveCount(0);
      await expect(row.getByRole('button', { name: '采购历史', exact: true })).toHaveCount(0);
      await row.getByLabel('采购状态V11测试采购', { exact: true }).selectOption('待采购');
      await p.getByLabel('采购记录筛选', { exact: true }).selectOption('待采购');
      await expect(row).toContainText('V11测试采购');
      await p.reload();
      await p.getByRole('button', { name: '采购管理', exact: true }).click();
      await expect(p.locator('.purchase-list')).toContainText('V11测试采购');
      const saved = (await (await api(c, '/workspace')).json()).data.purchases[0];
      await p
        .locator('.purchase-list')
        .getByRole('button', { name: '删除采购V11测试采购', exact: true })
        .click();
      await p.getByRole('button', { name: '确认操作', exact: true }).click();
      await expect(p.locator('.purchase-list')).not.toContainText('V11测试采购');
      await expect
        .poll(async () =>
          (await (await api(c, '/purchase-records/' + saved.id + '/history')).json()).events.map(
            (e: any) => e.operation,
          ),
        )
        .toEqual(['创建', '完成', '恢复待采购', '删除']);
      const hist = await (await api(c, '/purchase-records/' + saved.id + '/history')).json();
      expect(hist.events.map((e: any) => e.operation)).toEqual([
        '创建',
        '完成',
        '恢复待采购',
        '删除',
      ]);
      expect((await (await api(c, '/materials')).json()).events).toHaveLength(0);
    } finally {
      await c.close();
    }
  });
  test(`V1.1 cloud ${width}: select site first, staged transfer UI, independent avatars, no-overlap online row and card settings`, async ({
    browser,
  }) => {
    const f = await fixtureAccounts(),
      c = await browser.newContext({ viewport: { width, height: 950 } }),
      peer = await browser.newContext({ viewport: { width, height: 950 } });
    try {
      const p = await c.newPage(),
        b = await peer.newPage();
      await login(p, f.login, f.password);
      await login(b, f.employee, f.password);
      const d = fixture();
      d.projects.push({ ...d.projects[0], id: 'target-' + randomUUID(), name: '调入工地B' });
      await api(c, '/workspace', 'PUT', { revision: 0, data: d });
      await p.reload();
      await expect.poll(() => p.locator('.online-accounts .online-member').count()).toBe(2);
      const rects = await p.locator('.online-accounts .online-member').evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, height: r.height };
        }),
      );
      expect(rects[1].left - rects[0].right).toBeGreaterThanOrEqual(7);
      expect(rects[1].height).toBe(rects[0].height);
      expect(rects[1].top).toBe(rects[0].top);
      await p.getByRole('button', { name: '材料资产管理', exact: true }).click();
      const material = p.getByRole('region', { name: '材料资产管理', exact: true });
      await expect(material).toContainText('请先选择工地');
      await expect(
        material.getByRole('button', { name: '新增材料规格', exact: true }),
      ).toBeHidden();
      await material.getByLabel('材料项目', { exact: true }).selectOption(d.projects[0].id);
      await expect(material).toContainText('当前操作工地：' + d.projects[0].name);
      let r = await api(c, '/materials/items', 'PUT', {
        id: '',
        version: 0,
        value: {
          name: '测试水泥',
          category: '泥工',
          unit: 'kg',
          specification: 'P42.5',
          performance: '通用',
          active: true,
          conversions: [],
        },
      });
      expect(r.status()).toBe(200);
      const item = await r.json();
      r = await api(c, '/materials/events', 'POST', {
        requestId: randomUUID(),
        kind: 'opening',
        projectId: d.projects[0].id,
        targetProjectId: '',
        materialId: item.id,
        contextId: '',
        purchaseId: '',
        date: today(),
        quantity: '100',
        inputUnit: 'kg',
        unitPrice: '2',
        referenceId: '',
        reason: '现场期初核验',
      });
      expect(r.status()).toBe(200);
      await material.getByRole('button', { name: '刷新核算与预警', exact: true }).click();
      await material.getByRole('button', { name: '跨工地余料调拨', exact: true }).click();
      await material.getByRole('button', { name: '申请跨工地调拨', exact: true }).click();
      let m = p.getByRole('dialog', { name: '申请调拨', exact: true });
      await m.getByLabel('调入工地', { exact: true }).selectOption(d.projects[1].id);
      await m.getByLabel('调拨材料', { exact: true }).selectOption(item.id);
      await m.getByLabel('经手账号', { exact: true }).selectOption(f.id);
      await m.getByLabel('调拨本次数量', { exact: true }).fill('60');
      await m.getByLabel('调拨原因', { exact: true }).fill('核验规格、质量和运输成本');
      await m.getByRole('button', { name: '确认申请调拨', exact: true }).click();
      await expect(m).toHaveCount(0);
      const ticket = material.locator('.transfer-card').filter({ hasText: '单号' });
      async function act(label: string, q?: string) {
        await ticket.getByRole('button', { name: label, exact: true }).click();
        const dialog = p.getByRole('dialog', { name: label, exact: true });
        if (q) await dialog.getByLabel('调拨本次数量', { exact: true }).fill(q);
        await dialog.getByLabel('调拨原因', { exact: true }).fill('现场核查交接 ' + label);
        await dialog
          .getByRole('button', {
            name: label.startsWith('确认') ? label : '确认' + label,
            exact: true,
          })
          .click();
        await expect(dialog).toHaveCount(0);
      }
      await act('批准待发出');
      await act('确认发出');
      let s = await (await api(c, '/materials')).json();
      expect(s.analysis.stocks.find((x: any) => x.projectId === d.projects[1].id).siteQty).toBe(
        '0.000',
      );
      await act('确认接收', '40');
      await expect(ticket).toContainText('部分接收');
      await act('在途退回', '20');
      await expect(ticket).toContainText('差异关闭');
      s = await (await api(c, '/materials')).json();
      expect(s.analysis.stocks.find((x: any) => x.projectId === d.projects[0].id).siteQty).toBe(
        '60.000',
      );
      expect(s.analysis.stocks.find((x: any) => x.projectId === d.projects[1].id).siteQty).toBe(
        '40.000',
      );
      await p.screenshot({ path: `/tmp/chunmo-v11-transfer-${width}.png`, animations: 'disabled' });
      const png = (n: number) => {
        const image = new PNG({ width: 1080, height: 1080 });
        image.data.fill(n);
        return PNG.sync.write(image);
      };
      await p.getByRole('button', { name: '账号管理', exact: true }).click();
      m = p.getByRole('dialog', { name: '账号管理', exact: true });
      await m.getByText('头像设置', { exact: true }).click();
      await m
        .getByLabel('选择头像', { exact: true })
        .setInputFiles({ name: 'system.png', mimeType: 'image/png', buffer: png(100) });
      await m.getByRole('button', { name: '保存头像', exact: true }).click();
      await expect(m).toContainText('头像已保存');
      await m.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      const system = await p.locator('.current-account img').getAttribute('src');
      await p.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      m = p.getByRole('dialog', { name: '我的个人名片', exact: true });
      await expect(m.getByText('名片头像设置', { exact: true })).toHaveCount(0);
      await m
        .getByLabel('选择名片头像', { exact: true })
        .setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: png(220) });
      await m.getByRole('button', { name: '保存头像', exact: true }).click();
      await expect(m.locator('.member-card-photo img')).toHaveAttribute('src', /card-avatar/);
      const card = await m.locator('.member-card-photo img').getAttribute('src');
      await expect(p.locator('.current-account img')).toHaveAttribute('src', system!);
      await m.getByRole('button', { name: '账号设置', exact: true }).click();
      await expect(p.getByRole('dialog', { name: '账号管理', exact: true })).toBeVisible();
      await p.getByRole('button', { name: '关闭浮窗', exact: true }).click();
      await api(c, '/auth/logout', 'POST', {});
      await login(p, f.login, f.password);
      await expect(p.locator('.current-account img')).toHaveAttribute('src', system!);
      await p.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      m = p.getByRole('dialog', { name: '我的个人名片', exact: true });
      await expect(m.locator('.member-card-photo img')).toHaveAttribute('src', card!);
      await p.reload();
      await p.getByRole('button', { name: '打开我的个人名片', exact: true }).click();
      await expect(
        p
          .getByRole('dialog', { name: '我的个人名片', exact: true })
          .locator('.member-card-photo img'),
      ).toHaveAttribute('src', card!);
      await p.screenshot({ path: `/tmp/chunmo-v11-profile-${width}.png`, animations: 'disabled' });
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await c.close();
      await peer.close();
    }
  });
}
