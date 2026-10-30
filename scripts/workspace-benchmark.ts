// Local, production-build benchmark. fixtureAccounts refuses non-test databases.
import { chromium, request } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { prepareWorkspace } from '../src/lib/model';

const baseURL = 'http://127.0.0.1:5180';
const phase = process.env.BENCH_PHASE || 'before';
assert(['before', 'after'].includes(phase), 'BENCH_PHASE must be before or after');
const captureOnly = process.env.BENCH_CAPTURE_ONLY === 'true';
const output = `/tmp/chunmo-purchase-${phase}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
try {
  const f = await fixtureAccounts();
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const login = await api.post('/api/auth/login', {
    data: { login: f.login, password: f.password },
  });
  if (!login.ok()) throw Error(`Test login: ${login.status()}`);
  const session = await (await api.get('/api/auth/session')).json();
  const data = fixture();
  data.purchases = Array.from({ length: 12 }, (_, i) => ({
    ...data.purchases[0],
    id: `purchase-${i}`,
    name: ['电线及线管', '开关面板', '墙面乳胶漆'][i % 3] + ` ${i + 1}`,
    status: i % 4 === 0 ? ('已完成' as const) : ('待采购' as const),
  }));
  const saved = await api.put('/api/workspace', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { revision: 0, data: prepareWorkspace(data) },
  });
  if (!saved.ok()) throw Error(`Test seed: ${saved.status()}`);
  const storageState = await api.storageState();
  const results = [];
  for (const network of captureOnly ? [] : ['loopback', 'controlled-150ms-1.6Mbps']) {
    for (let i = 0; i < 5; i++) {
      const c = await browser.newContext({
        baseURL,
        storageState,
        viewport: { width: 1440, height: 1000 },
      });
      const p = await c.newPage();
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
      await p.waitForFunction(
        () =>
          document.querySelector('.save-state')?.textContent?.includes('已保存') &&
          document.querySelectorAll('.task-bar').length > 0,
      );
      const result = await p.evaluate(
        (network) => ({
          network,
          readyMs: Math.round(performance.now()),
          resources: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(
            (e) => ({
              name: new URL(e.name).pathname,
              startMs: Math.round(e.startTime),
              durationMs: Math.round(e.duration),
              bytes: e.encodedBodySize,
            }),
          ),
        }),
        network,
      );
      if (phase === 'after') {
        for (const endpoint of ['/api/auth/session', '/api/workspace'])
          assert.equal(result.resources.filter((r) => r.name === endpoint).length, 1);
        assert(!result.resources.some((r) => r.name === '/api/purchase-records'));
        assert(
          !result.resources.some((r) => /(?:PeoplePanel|MaterialsPanel|RecordBoard)-/.test(r.name)),
        );
      }
      results.push(result);
      await c.close();
    }
  }
  const layouts = [];
  for (const width of [1440, 1280, 390, 320]) {
    const c = await browser.newContext({
      baseURL,
      storageState,
      viewport: { width, height: 1000 },
    });
    const p = await c.newPage();
    await p.goto('/');
    await p.waitForFunction(() =>
      document.querySelector('.save-state')?.textContent?.includes('已保存'),
    );
    await p.getByRole('button', { name: '采购管理', exact: true }).click();
    await p.locator('.purchase-card').first().waitFor();
    // Wait for the noncritical provenance request in the old UI, for a fair layout comparison.
    await p.waitForTimeout(350);
    layouts.push({
      width,
      card: await p.locator('.purchase-card').first().boundingBox(),
      toolbar: await p.locator('.records-section').boundingBox(),
    });
    if (!captureOnly)
      await p.screenshot({ path: `${output}/purchases-${width}.png`, fullPage: true });
    await p.locator('.records-section').evaluate((e) => {
      window.scrollTo(0, e.getBoundingClientRect().top + scrollY - (innerWidth < 700 ? 125 : 90));
    });
    await p.screenshot({ path: `${output}/viewport-${width}.png` });
    await c.close();
  }
  await writeFile(
    `${output}/${captureOnly ? 'captures' : 'metrics'}.json`,
    JSON.stringify(
      {
        phase,
        baseline: '7bcf668a25c71942df244492790cfe6e42b85959',
        captureOnly,
        samplesPerNetwork: captureOnly ? 0 : 5,
        data: {
          projects: data.projects.length,
          tasks: data.tasks.length,
          purchases: data.purchases.length,
        },
        results,
        layouts,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase,
      results: results.map(({ network, readyMs }) => ({ network, readyMs })),
      layouts,
    }),
  );
  await api.dispose();
} finally {
  await browser.close();
  await pool.end();
  await privatePool.end();
}
