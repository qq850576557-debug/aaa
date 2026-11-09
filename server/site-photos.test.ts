import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from './app';
import { config } from './config';
import { fixtureAccounts, fixtureQuery } from './test-fixtures';
import { pool, privatePool } from './db';
import { fixture } from '../tests/helpers';
import { PHOTO_CHUNK } from '../src/lib/site-photo';
let server: Server, base: string, dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chunmo-private-photos-'));
  process.env.CHUNMO_PHOTO_DIR = dir;
  server = createServer(createApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await privatePool.end();
});
type Client = { cookie: string; csrf: string; user: any };
async function req(path: string, method = 'GET', body?: unknown, c?: Client) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: config.APP_ORIGIN,
      ...(c ? { Cookie: c.cookie, 'X-CSRF-Token': c.csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function login(name: string, password: string) {
  const r = await req('/auth/login', 'POST', { login: name, password });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!.split(';')[0],
    s = await (await fetch(base + '/auth/session', { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: s.csrf, user: s.user } as Client;
}
test('private photos: authenticated identity, original bytes, 12MP output, chunk retry, quota, workspace isolation and disabled production feature', async () => {
  const f = await fixtureAccounts(),
    other = await fixtureAccounts();
  const owner = await login(f.login, f.password),
    staff = await login(f.employee, f.password),
    stranger = await login(other.login, other.password);
  const data = fixture();
  assert.equal((await req('/workspace', 'PUT', { revision: 0, data }, owner)).status, 200);
  assert.equal((await req('/site-photos/config')).status, 401);
  const original = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: '#c1ccc6' },
  })
    .jpeg({ quality: 98 })
    .toBuffer();
  const input = {
    requestId: crypto.randomUUID(),
    projectId: data.projects[0].id,
    capturedAt: '2026-11-09T06:36:00.000Z',
    captureSource: 'camera-request',
    originalName: 'original.jpg',
    originalSize: original.length,
    outputWidth: 4000,
    outputHeight: 3000,
    location: null,
  };
  assert.equal(
    (await req('/site-photos', 'POST', { ...input, actorId: 'fake' }, staff)).status,
    400,
  );
  assert.equal(
    (await req('/site-photos', 'POST', { ...input, projectId: 'unavailable' }, staff)).status,
    403,
  );
  const created = await req('/site-photos', 'POST', input, staff);
  assert.equal(created.status, 200, await created.clone().text());
  const m = await created.json();
  assert.equal(m.actorId, staff.user.id);
  assert.equal(m.actorName, staff.user.displayName);
  assert.equal(m.complete, false);
  assert.equal(
    (await req(`/site-photos/${input.requestId}/complete`, 'POST', {}, staff)).status,
    409,
  );
  assert.equal(
    (await req('/site-photos', 'POST', { ...input, originalName: 'different' }, staff)).status,
    409,
  );
  for (let i = 0; i < Math.ceil(original.length / PHOTO_CHUNK); i++) {
    const body = {
      data: original.subarray(i * PHOTO_CHUNK, (i + 1) * PHOTO_CHUNK).toString('base64'),
    };
    assert.equal(
      (await req(`/site-photos/${input.requestId}/chunks/${i}`, 'PUT', body, staff)).status,
      200,
    );
    assert.equal(
      (await req(`/site-photos/${input.requestId}/chunks/${i}`, 'PUT', body, staff)).status,
      200,
    );
  }
  const completed = await req(`/site-photos/${input.requestId}/complete`, 'POST', {}, staff);
  assert.equal(completed.status, 200, await completed.clone().text());
  const result = await completed.json();
  assert.equal(result.complete, true);
  assert.equal(result.originalWidth, 4000);
  assert.equal(result.originalHeight, 3000);
  assert.ok(result.uploadedAt);
  assert.notEqual(result.uploadedAt, result.capturedAt);
  const again = await (
    await req(`/site-photos/${input.requestId}/complete`, 'POST', {}, staff)
  ).json();
  assert.equal(again.uploadedAt, result.uploadedAt);
  assert.equal(again.watermarkedHash, result.watermarkedHash);
  assert.equal(
    (
      await fixtureQuery(
        "SELECT count(*)::int AS n FROM audit_event WHERE workspace_id=$1 AND entity_type='site-photo' AND entity_id=$2",
        [f.workspaceId, input.requestId],
      )
    ).rows[0].n,
    1,
  );
  const source = await req(
    `/site-photos/${staff.user.id}/${input.requestId}/original`,
    'GET',
    undefined,
    owner,
  );
  assert.equal(source.status, 200);
  assert.equal(source.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), original);
  const marked = await req(
    `/site-photos/${staff.user.id}/${input.requestId}/watermarked`,
    'GET',
    undefined,
    owner,
  );
  const markedBytes = Buffer.from(await marked.arrayBuffer());
  const meta = await sharp(markedBytes).metadata();
  assert.equal(meta.width, 4000);
  assert.equal(meta.height, 3000);
  assert.notDeepEqual(markedBytes, original);
  assert.equal(
    (
      await req(
        `/site-photos/${staff.user.id}/${input.requestId}/watermarked`,
        'GET',
        undefined,
        stranger,
      )
    ).status,
    404,
  );
  assert.equal((await req(`/site-photos/${input.requestId}`, 'GET', undefined, owner)).status, 404);
  process.env.CHUNMO_PHOTO_QUOTA_BYTES = '1';
  assert.equal(
    (await req('/site-photos', 'POST', { ...input, requestId: crypto.randomUUID() }, staff)).status,
    507,
  );
  delete process.env.CHUNMO_PHOTO_QUOTA_BYTES;
  delete process.env.CHUNMO_PHOTO_DIR;
  assert.equal(
    (await req('/site-photos', 'POST', { ...input, requestId: crypto.randomUUID() }, staff)).status,
    503,
  );
  assert.equal(
    (await (await req('/site-photos/config', 'GET', undefined, staff)).json()).enabled,
    false,
  );
});

test('orientation is corrected without modifying stored original; invalid enlargement is rejected', async () => {
  process.env.CHUNMO_PHOTO_DIR = dir;
  const f = await fixtureAccounts(),
    c = await login(f.login, f.password),
    data = fixture();
  await req('/workspace', 'PUT', { revision: 0, data }, c);
  const image = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#e8d5c4' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  async function upload(width: number, height: number) {
    const input = {
      requestId: crypto.randomUUID(),
      projectId: data.projects[0].id,
      capturedAt: new Date().toISOString(),
      captureSource: 'file-selection',
      originalName: 'portrait.jpg',
      originalSize: image.length,
      outputWidth: width,
      outputHeight: height,
      location: null,
    };
    await req('/site-photos', 'POST', input, c);
    await req(
      `/site-photos/${input.requestId}/chunks/0`,
      'PUT',
      { data: image.toString('base64') },
      c,
    );
    return { input, r: await req(`/site-photos/${input.requestId}/complete`, 'POST', {}, c) };
  }
  const { r, input } = await upload(800, 1200);
  assert.equal(r.status, 200, await r.clone().text());
  const output = await req(
    `/site-photos/${c.user.id}/${input.requestId}/watermarked`,
    'GET',
    undefined,
    c,
  );
  const m = await sharp(Buffer.from(await output.arrayBuffer())).metadata();
  assert.equal(m.width, 800);
  assert.equal(m.height, 1200);
  assert.ok(!m.orientation || m.orientation === 1);
  assert.equal((await upload(1600, 2400)).r.status, 400);
});
