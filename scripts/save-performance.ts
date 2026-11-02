// Only isolated local fixtures; never invoke against production.
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import pg from 'pg';
import { chromium, request } from '@playwright/test';
import { createApp } from '../server/app';
import { config } from '../server/config';
import { pool, privatePool } from '../server/db';
import { fixtureAccounts } from '../server/test-fixtures';
import { fixture } from '../tests/helpers';
import { copyProject, prepareWorkspace } from '../src/lib/model';
assert(config.APP_ENV === 'test');
const phase = process.env.BENCH_PHASE ?? 'before';
assert(['before', 'after'].includes(phase));
type Metrics = {
  serverMs: number;
  dbMs: number;
  dbWriteMs: number;
  queries: number;
  graphRows: number;
  ingressMs?: number;
};
const stats = new AsyncLocalStorage<Metrics>();
const query = pg.Client.prototype.query;
(pg.Client.prototype as any).query = function (...args: any[]) {
  const m = stats.getStore();
  const start = performance.now();
  const sql = String(typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? ''));
  const done = (r: any) => {
    if (m) {
      const ms = performance.now() - start;
      m.dbMs += ms;
      m.queries++;
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) m.dbWriteMs += ms;
      if (
        /^\s*(INSERT INTO|UPDATE|DELETE FROM) (project|person|trade|task|purchase|memo|assignment)\b/i.test(
          sql,
        )
      )
        m.graphRows += r?.rowCount ?? 0;
    }
  };
  const last = args.length - 1;
  if (typeof args[last] === 'function') {
    const callback = args[last];
    args[last] = (e: any, r: any) => {
      done(r);
      callback(e, r);
    };
    return (query as any).apply(this, args);
  }
  const result = (query as any).apply(this, args);
  return result.then(
    (r: any) => {
      done(r);
      return r;
    },
    (e: any) => {
      done(null);
      throw e;
    },
  );
};
const app = createApp();
const apiServer = createServer((req, res) => {
  const start = performance.now();
  const m: Metrics = { serverMs: 0, dbMs: 0, dbWriteMs: 0, queries: 0, graphRows: 0 };
  let bodyDone = start;
  req.once('end', () => {
    bodyDone = performance.now();
    m.ingressMs = bodyDone - start;
  });
  const end = res.end;
  res.end = function (...args: any[]) {
    m.serverMs = performance.now() - bodyDone;
    if (!res.headersSent) res.setHeader('X-Bench-Metrics', JSON.stringify(m));
    return (end as any).apply(this, args);
  };
  stats.run(m, () => app(req, res));
});
await new Promise<void>((r) => apiServer.listen(4001, '127.0.0.1', r));
const preview = spawn(
  'node_modules/.bin/vite',
  ['preview', '--host', '127.0.0.1', '--port', '5180', '--strictPort'],
  { stdio: 'ignore', env: { ...process.env, CHUNMO_API_TARGET: 'http://127.0.0.1:4001' } },
);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:5180')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const f = await fixtureAccounts();
  const api = await request.newContext({
    baseURL: 'http://127.0.0.1:5180',
    extraHTTPHeaders: { Origin: config.APP_ORIGIN },
  });
  assert(
    (await api.post('/api/auth/login', { data: { login: f.login, password: f.password } })).ok(),
  );
  const session = await (await api.get('/api/auth/session')).json();
  let data = fixture();
  for (let i = 1; i < 20; i++) data = copyProject(data, data.projects[0]).data;
  data.purchases = data.projects.flatMap((p) =>
    Array.from({ length: 10 }, (_, i) => ({
      ...data.purchases.find((x) => x.projectId === p.id)!,
      id: 'bench-' + p.id + '-' + i,
      name: '核查采购' + i,
      notes: '保留完整的采购及项目关联数据。',
    })),
  );
  data = prepareWorkspace(data);
  let revision = 0;
  for (let step = 0; step < 5; step++) {
    data.projects = data.projects.map((p) => ({
      ...p,
      notes: '第' + step + '次现场核查，材料、工期与保护完整保留。',
    }));
    const r = await api.put('/api/workspace', {
      headers: { 'X-CSRF-Token': session.csrf },
      data: { revision, data },
    });
    assert(r.ok(), await r.text());
    const s = await r.json();
    revision = s.revision;
    data = s.data;
  }
  const state = await (await api.get('/api/workspace')).json();
  const storageState = await api.storageState();
  const samples = [];
  for (const network of ['loopback', '60ms-10Mbps', '150ms-1.6Mbps'])
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:5180',
        storageState,
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.waitForFunction(() =>
        document.querySelector('.save-state')?.textContent?.includes('已保存'),
      );
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      if (network !== 'loopback')
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: network.startsWith('60') ? 60 : 150,
          downloadThroughput: network.startsWith('60') ? 1250000 : 200000,
          uploadThroughput: network.startsWith('60') ? 1250000 : 125000,
        });
      await page.getByRole('button', { name: '编辑当前项目', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
      await dialog
        .getByLabel('项目备注', { exact: true })
        .fill(`${phase} ${network} ${i} 保留其他项目和原始历史`);
      await page.evaluate(() => {
        const w = window as any;
        w.benchLocal = [];
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args: any[]) {
          const tx = (original as any).apply(this, args);
          const start = performance.now();
          if (this.name === 'chunmo-cloud-drafts' && tx.mode === 'readwrite')
            tx.addEventListener('complete', () =>
              w.benchLocal.push({ end: performance.now(), duration: performance.now() - start }),
            );
          return tx;
        };
        w.benchStart = performance.now();
        window.addEventListener(
          'click',
          () => {
            w.benchStart = performance.now();
          },
          { once: true, capture: true },
        );
      });
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/api/workspace') && r.request().method() === 'PUT',
      );
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      const r = await response;
      assert(r.ok(), await r.text());
      await r.finished();
      await page.waitForFunction(() =>
        document.querySelector('.save-state')?.textContent?.includes('已保存'),
      );
      const local = await page.evaluate(() => {
        const w = window as any;
        return {
          overallMs: performance.now() - w.benchStart,
          localFeedbackMs: w.benchLocal[0]?.end - w.benchStart,
          indexedDbMs: w.benchLocal[0]?.duration,
        };
      });
      const timing = r.request().timing();
      samples.push({
        network,
        ...local,
        requestBytes: Buffer.byteLength(r.request().postData() ?? ''),
        responseWireBytes: Number(r.headers()['content-length']),
        requestMs: timing.responseEnd - timing.requestStart,
        ...JSON.parse(r.headers()['x-bench-metrics']),
      });
      await context.close();
    }
  const result = {
    phase,
    environment:
      'isolated localhost test DB, production build, Chromium; 3 sequential samples/network; not Aliyun',
    fixture: {
      projects: 20,
      tasks: data.tasks.length,
      purchases: 200,
      historyNodes: state.history.records.length,
    },
    samples,
  };
  await mkdir('docs/performance/save', { recursive: true });
  await writeFile(`docs/performance/save/${phase}.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  await api.dispose();
} finally {
  preview.kill('SIGTERM');
  await browser.close();
  apiServer.closeAllConnections();
  await new Promise<void>((r) => apiServer.close(() => r()));
  await pool.end();
  await privatePool.end();
}
