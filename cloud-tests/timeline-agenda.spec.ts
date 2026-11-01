import { test, expect, type Page } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { today, plus } from '../src/lib/model';
import { mkdir } from 'node:fs/promises';
async function api(page: Page, path = '/workspace', method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/api' + path, {
        method,
        headers:
          method === 'GET'
            ? {}
            : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, value: await r.json() };
    },
    { path, method, body },
  );
}
for (const width of [1440, 390])
  test(`timeline linked agenda ${width}: same-page create, summaries, moves, deletion and reload`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 1000 });
    const f = await fixtureAccounts();
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const d = fixture();
    d.projects.push({ ...d.projects[0], id: 'timeline-second', name: '联动第二工地' });
    d.notes = [];
    d.purchases = [];
    expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
    await page.reload();
    const cell = (date: string) =>
      page.getByRole('button', { name: `查看 ${date} 事项`, exact: true });
    const locate = async (date: string) => {
      await page.getByLabel('定位日期', { exact: true }).fill(date);
      await cell(date).scrollIntoViewIfNeeded();
    };
    for (const kind of ['采购清单', '事项管理']) {
      await locate(today());
      await cell(today()).click();
      await page.getByRole('button', { name: '新增当天事项', exact: true }).click();
      const entry = page.locator('.agenda-entry-dialog');
      await entry.getByRole('radio', { name: kind, exact: true }).click();
      if (kind === '采购清单') {
        await entry.getByLabel('采购内容 / 事项标题', { exact: true }).fill('时间轴采购灯具');
        await entry.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('.save-state')).toContainText('已保存');
      } else {
        await entry.getByLabel('任务事项', { exact: true }).fill('时间轴检查灯具位置');
        await entry.getByRole('button', { name: '保存记录', exact: true }).click();
      }
      await expect(entry).toHaveCount(0);
      await expect(page.locator('.gantt-scroll')).toBeVisible();
      await expect(page.locator('.purchase-list,.record-board')).toHaveCount(0);
    }
    await locate(today());
    await expect(cell(today()).locator('.agenda-dot')).toHaveCount(1);
    await cell(today()).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveCSS('opacity', '1');
    await expect(tip).toContainText('今日事项');
    await expect(tip).toContainText('今日采购');
    await expect(tip).toContainText('时间轴检查灯具位置');
    await expect(tip).toContainText('时间轴采购灯具');
    await mkdir('/tmp/timeline-screenshots', { recursive: true });
    await page.screenshot({ path: `/tmp/timeline-screenshots/summary-${width}.png` });
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCSS('opacity', '0');
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page.getByRole('button', { name: '打开记录：时间轴检查灯具位置', exact: true }).click();
    const drawer = page.locator('.record-drawer');
    await drawer.getByLabel('记录所属项目', { exact: true }).selectOption(d.projects[1].id);
    await drawer.getByLabel('记录节点日期', { exact: true }).fill(plus(today(), 1));
    await drawer.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await page
      .locator('.purchase-list')
      .getByRole('button', { name: /编辑采购/ })
      .click();
    const edit = page.getByRole('dialog', { name: '编辑采购事项', exact: true });
    await edit.getByLabel('所属项目', { exact: true }).selectOption(d.projects[1].id);
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await locate(today());
    await expect(cell(today()).locator('.agenda-dot')).toHaveCount(0);
    if (width < 700) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: `切换项目${d.projects[1].name}`, exact: true }).click();
    await locate(today());
    await expect(cell(today()).locator('.agenda-dot')).toHaveCount(1);
    await locate(plus(today(), 1));
    await cell(plus(today(), 1)).hover();
    await expect(page.getByRole('tooltip')).toContainText('时间轴检查灯具位置');
    const saved = await api(page);
    const records = (await api(page, '/records')).value.records;
    expect(saved.value.data.purchases).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0].projectId).toBe(d.projects[1].id);
    expect(
      (
        await api(page, '/records/' + records[0].id, 'DELETE', {
          requestId: crypto.randomUUID(),
          version: records[0].version,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(page, '/workspace', 'PUT', {
          revision: saved.value.revision,
          data: { ...saved.value.data, purchases: [] },
        })
      ).status,
    ).toBe(200);
    await page.reload();
    if (width < 700) await page.locator('.mobile-project-toggle').click();
    await page.getByRole('button', { name: `切换项目${d.projects[1].name}`, exact: true }).click();
    await locate(today());
    await expect(cell(today()).locator('.agenda-dot')).toHaveCount(0);
    await locate(plus(today(), 1));
    await expect(cell(plus(today(), 1)).locator('.agenda-dot')).toHaveCount(0);
  });

for (const width of [1440, 390])
  test(`management writes project into timeline ${width}`, async ({ page }) => {
    const f = await fixtureAccounts();
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.getByLabel('登录账号', { exact: true }).fill(f.login);
    await page.getByLabel('登录密码', { exact: true }).fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    const d = fixture();
    d.notes = [];
    d.purchases = [];
    expect((await api(page, '/workspace', 'PUT', { revision: 0, data: d })).status).toBe(200);
    await page.reload();
    const date = plus(today(), 2);
    await page.getByRole('button', { name: '采购管理', exact: true }).click();
    await page.getByRole('button', { name: '新增采购', exact: true }).click();
    const purchase = page.getByRole('dialog', { name: '新建采购事项', exact: true });
    await purchase.getByLabel('采购内容 / 事项标题', { exact: true }).fill('管理页下单五金');
    await purchase.getByLabel('采购截止日期', { exact: true }).fill(date);
    await purchase.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await page.getByRole('button', { name: '事项管理', exact: true }).click();
    await page
      .getByRole('button', { name: `在${d.projects[0].name}新增记录`, exact: true })
      .click();
    const record = page.locator('.record-drawer');
    await record.getByLabel('任务事项', { exact: true }).fill('管理页检查五金安装');
    await record.getByLabel('记录节点日期', { exact: true }).fill(date);
    await record.getByLabel('记录状态', { exact: true }).selectOption('已完成');
    await record.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(record).toHaveCount(0);
    await page.getByRole('button', { name: '项目工作空间', exact: true }).click();
    await page.getByLabel('定位日期', { exact: true }).fill(date);
    const cell = page.getByRole('button', { name: `查看 ${date} 事项`, exact: true });
    await cell.scrollIntoViewIfNeeded();
    await expect(cell.locator('.agenda-dot')).toHaveCount(1);
    await cell.hover();
    await expect(page.getByRole('tooltip')).toContainText('管理页下单五金');
    await expect(page.getByRole('tooltip')).toContainText('管理页检查五金安装');
    await expect(page.getByRole('tooltip')).toContainText('已完成');
    await cell.click();
    const day = page.getByRole('dialog', { name: `${date} · 每日事项`, exact: true });
    await expect(day).toContainText('管理页下单五金');
    await expect(day).toContainText('管理页检查五金安装');
    expect((await api(page)).value.data.purchases).toHaveLength(1);
    expect((await api(page, '/records')).value.records).toHaveLength(1);
  });
