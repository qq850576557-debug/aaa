// Guarded backend login measurement; keep the existing two-worker hashing limit.
import { createServer } from 'node:http';
import { createApp } from '../server/app';
import { fixtureAccounts } from '../server/test-fixtures';
import { pool, privatePool } from '../server/db';
import { config } from '../server/config';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
assert(config.APP_ENV === 'test');
const server = createServer(createApp());
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api`;
try {
  const f = await fixtureAccounts();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { Origin: config.APP_ORIGIN, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const signed = await post('/auth/login', { login: f.login, password: f.password });
  assert.equal(signed.status, 200);
  const cookie = signed.headers.get('set-cookie')!.split(';')[0];
  const session = await (
    await fetch(base + '/auth/session', { headers: { Cookie: cookie } })
  ).json();
  const names = [f.login, f.employee];
  for (let i = 0; i < 2; i++) {
    const login = 'perf_' + randomUUID().replaceAll('-', '');
    assert.equal(
      (
        await post(
          '/accounts',
          { login, password: f.password },
          { Cookie: cookie, 'X-CSRF-Token': session.csrf },
        )
      ).status,
      201,
    );
    names.push(login);
  }
  const start = performance.now();
  const first = await Promise.all(
    names.map(async (login) => {
      const began = performance.now();
      const r = await post('/auth/login', { login, password: f.password });
      return { status: r.status, ms: Math.round(performance.now() - began) };
    }),
  );
  const final = await Promise.all(
    names.map(async (login, i) => {
      let status = first[i].status,
        attempts = 1;
      while (status === 429 && attempts < 4) {
        await new Promise((r) => setTimeout(r, 200));
        status = (await post('/auth/login', { login, password: f.password })).status;
        attempts++;
      }
      assert.equal(status, 200);
      return { status, attempts };
    }),
  );
  const result = {
    environment:
      'local isolated test API; four different registered accounts; no shared login cookie',
    first,
    final,
    totalIncludingTestRetriesMs: Math.round(performance.now() - start),
    note: 'Existing hashing parallelism limit of two is unchanged; retries here are performed by the measurement script, not a new frontend behavior.',
  };
  await mkdir('/tmp/chunmo-upgrade-performance', { recursive: true });
  await writeFile(
    '/tmp/chunmo-upgrade-performance/concurrent-login.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await privatePool.end();
}
