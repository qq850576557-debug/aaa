// Measure real production builds, using only guarded local test fixtures.
import { chromium, request } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { prepareWorkspace, copyProject } from '../src/lib/model';
import { mkdir, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const url = process.env.UPGRADE_BENCH_URL ?? 'http://127.0.0.1:5180',
  phase = process.env.BENCH_PHASE ?? 'after';
assert(new URL(url).hostname === '127.0.0.1' && ['before', 'after'].includes(phase));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const output = '/tmp/chunmo-upgrade-performance';
await mkdir(output, { recursive: true });
try {
  const f = await fixtureAccounts(),
    api = await request.newContext({ baseURL: url, extraHTTPHeaders: { Origin: url } });
  assert(
    (await api.post('/api/auth/login', { data: { login: f.login, password: f.password } })).ok(),
  );
  const session = await (await api.get('/api/auth/session')).json(),
    base = fixture(),
    d = prepareWorkspace(copyProject(base, base.projects[0]).data);
  assert(
    (
      await api.put('/api/workspace', {
        headers: { 'X-CSRF-Token': session.csrf },
        data: { revision: 0, data: d },
      })
    ).ok(),
  );
  const storageState = await api.storageState(),
    samples = [];
  for (const network of ['loopback', '150ms-1.6Mbps'])
    for (let i = 0; i < 5; i++) {
      const c = await browser.newContext({
          baseURL: url,
          storageState,
          viewport: { width: 1440, height: 1000 },
        }),
        p = await c.newPage();
      const cdp = await c.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (network !== 'loopback')
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 150,
          downloadThroughput: 200000,
          uploadThroughput: 100000,
        });
      await p.goto('/', { waitUntil: 'domcontentloaded' });
      await p.locator('.task-bar').first().waitFor();
      await p.waitForFunction(() =>
        document.querySelector('.save-state')?.textContent?.includes('已保存'),
      );
      const ready = await p.evaluate(() => performance.now());
      const timings: Record<string, number> = { firstReadyMs: Math.round(ready) };
      const measure = async (name: string, run: () => Promise<void>) => {
        const start = Date.now();
        await run();
        timings[name] = Date.now() - start;
      };
      await measure('accountMs', async () => {
        await p.getByRole('button', { name: '账号管理', exact: true }).click();
        await p
          .getByRole('dialog', { name: '账号管理', exact: true })
          .locator('.account-identity')
          .waitFor();
      });
      await p
        .getByRole('dialog', { name: '账号管理', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await measure('projectSwitchMs', async () => {
        await p.locator('.project-card').last().click();
        await p.locator('.task-bar').first().waitFor();
      });
      await measure('purchaseMs', async () => {
        await p.getByRole('button', { name: '采购管理', exact: true }).click();
        await p.locator('.purchase-card').first().waitFor();
      });
      await measure('recordMs', async () => {
        await p.getByRole('button', { name: '事项管理', exact: true }).click();
        await p.locator('.record-board').waitFor();
      });
      await measure('refreshMs', async () => {
        await p.reload({ waitUntil: 'domcontentloaded' });
        await p.waitForFunction(() =>
          document.querySelector('.save-state')?.textContent?.includes('已保存'),
        );
        await p.locator('.task-bar').first().waitFor();
      });
      const resources = await p.evaluate(() =>
        (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((r) => ({
          path: new URL(r.name).pathname,
          startMs: Math.round(r.startTime),
          durationMs: Math.round(r.duration),
          bytes: r.encodedBodySize,
        })),
      );
      samples.push({ network, ...timings, resources });
      await c.close();
    }
  const contexts = await Promise.all(
      Array.from({ length: 4 }, () => browser.newContext({ baseURL: url, storageState })),
    ),
    starts = Date.now();
  await Promise.all(
    contexts.map(async (c) => {
      const p = await c.newPage();
      await p.goto('/');
      await p.waitForFunction(() =>
        document.querySelector('.save-state')?.textContent?.includes('已保存'),
      );
      await p.locator('.task-bar').first().waitFor();
    }),
  );
  const fourSessionsReadyMs = Date.now() - starts;
  await Promise.all(contexts.map((c) => c.close()));
  await writeFile(
    `${output}/${phase}.json`,
    JSON.stringify(
      {
        phase,
        baseCommit: 'e7062e72fe114c9dd70aafb8011c786efe4b6672',
        samplesPerNetwork: 5,
        fixture: {
          projects: d.projects.length,
          tasks: d.tasks.length,
          purchases: d.purchases.length,
        },
        samples,
        fourSessionsReadyMs,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase,
      samples: samples.map(({ resources, ...s }) => s),
      fourSessionsReadyMs,
    }),
  );
  await api.dispose();
} finally {
  await browser.close();
  await pool.end();
  await privatePool.end();
}
