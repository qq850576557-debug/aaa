// Compare both builds against exactly the same guarded synthetic workspace.
import { chromium, request } from '@playwright/test';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { fixture } from '../tests/helpers';
import { copyProject, prepareWorkspace } from '../src/lib/model';
import { canonical } from '../src/lib/history';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const before = 'http://127.0.0.1:5184',
  after = 'http://127.0.0.1:5180';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
try {
  const f = await fixtureAccounts(),
    api = await request.newContext({ baseURL: before, extraHTTPHeaders: { Origin: before } });
  assert(
    (await api.post('/api/auth/login', { data: { login: f.login, password: f.password } })).ok(),
  );
  const s = await (await api.get('/api/auth/session')).json();
  let d = fixture();
  for (let i = 1; i < 20; i++) d = copyProject(d, d.projects[0]).data;
  d = prepareWorkspace(d);
  let revision = 0;
  for (let step = 0; step < 20; step++) {
    d = {
      ...d,
      projects: d.projects.map((p, i) => ({
        ...p,
        notes: `第${step + 1}次现场核查：工地${i + 1}已核对施工尺寸、材料到货与成品保护，等待下一次现场确认。`,
      })),
    };
    const r = await api.put('/api/workspace', {
      headers: { 'X-CSRF-Token': s.csrf },
      data: { revision, data: d },
    });
    assert(r.ok(), await r.text());
    const state = await r.json();
    revision = state.revision;
    d = state.data;
  }
  const expected = await (await api.get('/api/workspace')).json(),
    digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex'),
    expectedHash = digest(expected),
    storageState = await api.storageState();
  const samples = [];
  for (const [phase, url] of [
    ['before', before],
    ['after', after],
  ]) {
    const c = await browser.newContext({ baseURL: url, storageState }),
      p = await c.newPage();
    await p.goto('/');
    await p.waitForFunction(() =>
      document.querySelector('.save-state')?.textContent?.includes('已保存'),
    );
    const cdp = await c.newCDPSession(p);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 200000,
      uploadThroughput: 100000,
    });
    for (let i = 0; i < 3; i++) {
      const measurement = await p.evaluate(async (sample) => {
        const start = performance.now();
        const response = await fetch('/api/workspace?measurement=' + sample);
        const value = await response.json();
        return {
          elapsedMs: Math.round(performance.now() - start),
          encoding: response.headers.get('content-encoding'),
          wireBytes: Number(response.headers.get('content-length')),
          value,
        };
      }, i);
      assert.equal(
        digest(measurement.value),
        expectedHash,
        'every business field, history node and signed CAS baseline must be identical',
      );
      samples.push({
        phase,
        elapsedMs: measurement.elapsedMs,
        encoding: measurement.encoding,
        wireBytes: measurement.wireBytes,
      });
    }
    await c.close();
  }
  const result = {
    environment:
      'localhost, production builds, 150ms latency / 1.6Mbps, identical fixture and session',
    fixture: {
      projects: d.projects.length,
      tasks: d.tasks.length,
      purchases: d.purchases.length,
      historyNodes: expected.history.records.length,
    },
    decodedBytes: Buffer.byteLength(JSON.stringify(expected)),
    verifiedIdenticalState: true,
    samples,
  };
  await mkdir('/tmp/chunmo-upgrade-performance', { recursive: true });
  await writeFile(
    '/tmp/chunmo-upgrade-performance/large-workspace.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  await api.dispose();
} finally {
  await browser.close();
  await pool.end();
  await privatePool.end();
}
