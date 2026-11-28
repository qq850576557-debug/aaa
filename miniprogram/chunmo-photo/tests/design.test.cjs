const assert = require('node:assert/strict');
const { test } = require('node:test');
const store = require('../owner-login/fixture-store');
const owner = require('../owner-login/owner-session');

test('design viewer only opens a current authenticated residence, clears stale content and handles empty or failed links', async (t) => {
  const saved = { wx: global.wx, Page: global.Page, projectDesign: owner.projectDesign };
  let next = {},
    calls = [],
    title;
  global.wx = {
    setNavigationBarTitle(options) {
      title = options.title;
    },
  };
  let page;
  global.Page = (definition) => {
    page = definition;
  };
  const entry = '../owner-login/pages/design/index';
  t.after(() => {
    owner.projectDesign = saved.projectDesign;
    global.wx = saved.wx;
    global.Page = saved.Page;
    store.end();
    delete require.cache[require.resolve(entry)];
  });
  owner.projectDesign = async (id) => {
    calls.push(id);
    return next;
  };
  require(entry);
  page.data = { ...page.data };
  page.setData = (patch) => Object.assign(page.data, patch);
  page.onLoad({ kind: 'rendering', project: 'p1' });
  assert.equal(title, '效果图');
  await page.onShow();
  assert.equal(calls.length, 0);
  store.beginVerified({
    owner: { id: 'test', name: '测试业主' },
    projects: [
      { id: 'p1', title: '住宅一' },
      { id: 'p2', title: '住宅二' },
    ],
  });
  await page.onShow();
  assert.equal(page.data.feedback, '暂未发布');
  next = { rendering: '', renderingUnavailable: true };
  await page.onShow();
  assert.equal(page.data.src, '');
  assert.match(page.data.feedback, /暂不能在微信内打开/);
  next.renderingIssue = 'domain_unconfigured';
  await page.onShow();
  assert.match(page.data.feedback, /域名尚未配置/);
  next.renderingIssue = 'invalid_link';
  await page.onShow();
  assert.match(page.data.feedback, /链接格式不正确/);
  next.renderingIssue = 'preview_link';
  await page.onShow();
  assert.match(page.data.feedback, /预览或编辑链接/);
  const share = '/pano/page/publik/pklimit?inf=sample@@demo&sig=a%2Fb#scene';
  next = { rendering: 'https://vr.shinewonder.com' + share };
  await page.retry();
  assert.equal(page.data.src, '');
  assert.match(page.data.feedback, /域名尚未配置/);
  next = { rendering: 'https://8ec387dc.shinewonder.com' + share };
  await page.onShow();
  assert.equal(page.data.src, next.rendering);
  page.failed();
  assert.equal(page.data.src, '');
  assert.match(page.data.feedback, /加载失败/);
  await page.retry();
  page.failed({ detail: { statusCode: 410 } });
  assert.match(page.data.feedback, /链接已失效/);
  await page.retry();
  page.failed({ detail: { errMsg: 'web-view:fail url not in domain list' } });
  assert.match(page.data.feedback, /域名尚未配置/);
  next = { rendering: 'http://outside.example.com/render' };
  await page.retry();
  assert.equal(page.data.src, '');
  page.onLoad({ kind: 'panorama', project: 'p1' });
  assert.equal(title, '水电图');
  next = { panorama: 'https://8ec387dc.shinewonder.com' + share };
  await page.onShow();
  assert.equal(page.data.src, next.panorama);
  store.choose('p2');
  const before = calls.length;
  await page.onShow();
  assert.equal(calls.length, before);
  assert.match(page.data.feedback, /当前授权住宅/);
});
