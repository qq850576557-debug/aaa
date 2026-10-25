import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditDevice, businessAuditChanges, safeActorDisplayName } from './audit';
import { emptyData, newProject, defaultTrades, type Data } from '../src/lib/model';

test('device metadata is bounded, conservative, and never stores raw UA or invented iPhone model', () => {
  const iphone = auditDevice(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1 token-secret',
  );
  assert.equal(iphone.category, 'mobile');
  assert.equal(iphone.model, 'iPhone（具体型号不可识别）');
  assert.equal(iphone.browser, 'Safari');
  assert.equal(iphone.os, 'iOS / iPadOS');
  assert.ok(!JSON.stringify(iphone).includes('token-secret'));
  assert.equal(
    auditDevice('Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit Safari/604.1').category,
    'tablet',
  );
  assert.equal(
    auditDevice(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1 Version/17.0 Mobile/15E148 Safari/604.1',
    ).category,
    'tablet',
  );
  assert.equal(
    auditDevice(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36 Edg/128.0',
    ).browser,
    'Edge',
  );
  assert.equal(
    auditDevice(
      'Mozilla/5.0 (Linux; Android 13; SM-S9180 Build/TP1A.220624.014) Chrome/128 Mobile Safari/537.36',
    ).model,
    'SM-S9180（浏览器报告，未验证）',
  );
  assert.equal(
    auditDevice('Mozilla/5.0 (Linux; Android 10; K) Chrome/128 Mobile Safari/537.36').model,
    'Android设备（具体型号不可识别）',
  );
  assert.equal(auditDevice('unrecognized-user-value').category, 'unknown');
});

test('per-object audit tracks lifecycle, dates, personnel links, project ordering and redacted text changes', () => {
  const before = emptyData(),
    p = newProject();
  before.projects = [p];
  before.trades = defaultTrades(p.id);
  const after = structuredClone(before);
  after.projects[0].notes = 'sensitive client demand +8613800000000';
  after.trades[0].staffIds = ['person-1'];
  after.trades[0].order = 3;
  after.tasks.push({
    id: 'task-1',
    projectId: p.id,
    tradeId: after.trades[0].id,
    name: 'secret task name',
    start: p.start,
    end: p.end,
    owner: 'secret person',
    status: '未开始',
    notes: 'secret task notes',
  });
  const changes = businessAuditChanges(before, after);
  assert.equal(changes.length, 3);
  assert.equal(changes.find((x) => x.entityType === 'project')?.operation, 'update');
  assert.ok(changes.find((x) => x.entityType === 'project')?.changedFields.includes('notes'));
  assert.match(
    String((changes.find((x) => x.entityType === 'trade')?.after?.staffIds as string[])[0]),
    /^obj_[a-f0-9]{24}$/,
  );
  assert.equal(changes.find((x) => x.entityType === 'task')?.operation, 'create');
  assert.equal(changes.find((x) => x.entityType === 'task')?.before, null);
  assert.ok(!JSON.stringify(changes).includes('secret'));
  assert.ok(!JSON.stringify(changes).includes('13800000000'));
  const removed = businessAuditChanges(after, before).find((x) => x.entityType === 'task');
  assert.equal(removed?.operation, 'delete');
  assert.equal(removed?.after, null);
  const q = { ...newProject(), id: 'second-project' };
  before.projects.push(q);
  const swapped = structuredClone(before);
  swapped.projects.reverse();
  assert.ok(
    businessAuditChanges(before, swapped)
      .filter((x) => x.entityType === 'project')
      .every((x) => x.changedFields.includes('position')),
  );
  assert.deepEqual(businessAuditChanges(before, structuredClone(before)), []);
});

test('audit whitelist never copies unsafe free text, unknown fields, or arbitrary values under structured fields', () => {
  const p = newProject();
  const d = emptyData();
  d.projects = [
    {
      ...p,
      name: 'phone +8613800000000',
      owner: 'private owner',
      address: 'private address',
      notes: 'private notes',
      phone: 'private phone',
      password: 'private password',
      token: 'private token',
    } as Data['projects'][0],
  ];
  const event = businessAuditChanges(emptyData(), d)[0];
  const output = JSON.stringify(event);
  assert.ok(!output.includes('private'));
  assert.ok(!output.includes('phone'));
  assert.ok(!output.includes('password'));
  assert.ok(!output.includes('token'));
  const rogue = structuredClone(d);
  (rogue.projects[0] as unknown as Record<string, unknown>).status = { password: 'private value' };
  const unsafe = businessAuditChanges(d, rogue)[0];
  assert.equal(unsafe.after?.status, undefined);
});

test('audit IDs are deterministic domain-separated keyed references, never raw identifiers that may contain secrets', () => {
  const d = emptyData(),
    p = newProject();
  p.id = 'phone-13800000000-token-secret-0123456789';
  d.projects = [p];
  d.trades = defaultTrades(p.id);
  d.trades[0].id = 'trade-secret-token-13800000000';
  d.trades[0].staffIds = ['person-secret-13800000000'];
  d.tasks = [
    {
      id: 'task-secret-token-13800000000',
      projectId: p.id,
      tradeId: d.trades[0].id,
      name: 'private name',
      start: p.start,
      end: p.end,
      owner: '',
      status: '未开始',
      notes: '',
      staffIds: ['person-secret-13800000000'],
      dependsOn: [],
    },
  ];
  const key = 'test-real-key-12345678901234567890';
  const first = businessAuditChanges(emptyData(), d, key);
  assert.deepEqual(first, businessAuditChanges(emptyData(), d, key));
  assert.notDeepEqual(first, businessAuditChanges(emptyData(), d, key + 'rotated'));
  for (const record of first) assert.match(record.entityId, /^obj_[a-f0-9]{24}$/);
  assert.equal(
    first.find((x) => x.entityType === 'task')?.after?.projectId,
    first.find((x) => x.entityType === 'project')?.entityId,
  );
  assert.equal(
    first.find((x) => x.entityType === 'task')?.after?.tradeId,
    first.find((x) => x.entityType === 'trade' && x.after?.staffIds)?.entityId,
  );
  const serialized = JSON.stringify(first);
  for (const secret of ['13800000000', 'secret', 'token', 'private name', p.id])
    assert.ok(!serialized.includes(secret));
  assert.throws(() => businessAuditChanges(emptyData(), d, ''), /reference key/);
});

test('actor snapshot preserves intended display names but masks obvious misplaced phone numbers and credentials', () => {
  assert.equal(safeActorDisplayName('马春旭'), '马春旭');
  assert.equal(safeActorDisplayName('studio_owner'), 'studio_owner');
  assert.equal(safeActorDisplayName('  张三\u0000  '), '张三');
  assert.ok(!safeActorDisplayName('张三 +86 (138) 0000-0000').includes('138'));
  assert.ok(!safeActorDisplayName('token=abcd-secret-value').includes('abcd-secret-value'));
  assert.ok(!safeActorDisplayName('a'.repeat(64)).includes('a'.repeat(32)));
  assert.ok(!safeActorDisplayName('1990-01-01').includes('1990'));
});
