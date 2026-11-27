// Run the compiled personal-center templates and the real Page controllers in Chromium.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const tools = process.env.CHUNMO_WECHAT_TOOLS;
if (!tools) throw Error('Set CHUNMO_WECHAT_TOOLS to the miniprogram-compiler installation');
const { wxmlToJs, wxssToJs } = createRequire(join(resolve(tools), 'package.json'))(
  'miniprogram-compiler',
);
const { chromium } = require(process.env.CHUNMO_PLAYWRIGHT || 'playwright');
const root = resolve(process.env.CHUNMO_MINI_ROOT || 'miniprogram/chunmo-photo');
const out = resolve(process.env.CHUNMO_MINI_EVIDENCE || '/tmp/chunmo-profile-check');
const ownerPage = 'owner-login/pages/profile/index';
const staffPage = 'pages/me/index';
const navigation = 'owner-login/components/owner-nav/index';
const notice = 'components/notice/index';
const appConfig = require(join(root, 'app.json'));
assert.equal(appConfig.pages.includes(ownerPage), false);
assert.ok(
  appConfig.subPackages.some(({ root, pages }) => pages.some((p) => root + '/' + p === ownerPage)),
);
const wxml = wxmlToJs(root);
const wxss = wxssToJs(root);

const appId = require(join(root, 'project.config.json')).appid;
Object.assign(require(join(root, 'owner-login/owner-live-config')), {
  appId,
  deployment: 'isolated',
  origin: 'https://owner-test.chmsj.cn',
  unified: true,
  terms: { version: 'test', text: '隔离测试' },
});
const storage = new Map();
const events = [];
const photo = await readFile(join(root, 'owner-login/assets/brand-logo.png'));
let statusBar, auth, allowedDesign, definitions, component, uploaded, staffAvatar, confirmLogout;
const canvas = {
  createImage: () => ({
    width: 960,
    height: 720,
    set src(value) {
      assert.equal(value, '/sandbox/album.png');
      queueMicrotask(() => this.onload());
    },
  }),
  getContext: () => ({ fillRect() {}, drawImage() {} }),
};
const identity = { id: 'test-staff', workspaceId: 'test-workspace', name: '林工' };
const drafts = { pending: [{ id: 'draft' }], archive: [{ id: 'archive' }], drafts: {} };
const staffApp = {
  api: {
    identity,
    async personalAvatar(value) {
      if (value) uploaded = value;
      return staffAvatar;
    },
    personalProfile: async () => ({ name: '林芷晴', department: '设计部', jobTitle: '室内设计师' }),
    logout: async () => events.push('员工退出'),
  },
};
globalThis.getApp = () => staffApp;
globalThis.getCurrentPages = () => [
  { route: 'owner-login/pages/home/index' },
  { route: ownerPage },
];
globalThis.Page = (page) => (definitions = page);
globalThis.Component = (value) => (component = value);
globalThis.wx = {
  env: { USER_DATA_PATH: '/sandbox' },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial', appId } }),
  getWindowInfo: () => ({ statusBarHeight: statusBar }),
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, data) => storage.set(key, data),
  removeStorageSync: (key) => storage.delete(key),
  navigateTo: ({ url, complete }) => {
    events.push(url);
    complete?.();
  },
  navigateBack: ({ complete }) => {
    events.push('返回');
    complete?.();
  },
  reLaunch: ({ url }) => events.push(url),
  stopPullDownRefresh: () => events.push('刷新完成'),
  openPrivacyContract: () => events.push('隐私保护指引'),
  showModal: ({ success }) => success({ confirm: confirmLogout }),
  showToast: ({ title }) => events.push(title),
  setClipboardData: ({ data, success }) => {
    events.push(JSON.parse(data));
    success({});
  },
  chooseMedia: async ({ sourceType }) => {
    assert.deepEqual(sourceType, ['album']);
    return { tempFiles: [{ tempFilePath: '/sandbox/album.png' }] };
  },
  createSelectorQuery: () => ({
    select(selector) {
      assert.equal(selector, '#avatar-canvas');
      return this;
    },
    fields() {
      return this;
    },
    exec(callback) {
      callback([{ node: canvas, width: 200 }]);
    },
  }),
  canvasToTempFilePath: async () => ({ tempFilePath: '/sandbox/crop.jpg' }),
  getImageInfo: async () => ({ width: 512, height: 512 }),
  getFileSystemManager: () => ({
    readFile: ({ success }) => success({ data: photo.toString('base64') }),
    writeFile: ({ success }) => success(),
    unlink() {},
  }),
};
const owners = require(join(root, 'owner-login/owner-session'));
const store = require(join(root, 'owner-login/fixture-store'));
const unified = require(join(root, 'lib/unified-login'));
owners.session = async () => auth;
owners.purchases = async () => ({ items: [] });
owners.projectDesign = async (id) => {
  assert.ok(auth.projects.some((project) => project.id === id));
  return allowedDesign[id] || {};
};
owners.logout = async () => events.push('业主退出');
const pages = {};
for (const route of [ownerPage, staffPage]) {
  require(join(root, route));
  pages[route] = definitions;
}
require(join(root, navigation));

const sizes = [
  [320, 568, 20, 12],
  [375, 812, 44, 34],
  [390, 844, 47, 34],
  [430, 932, 59, 34],
];
const residence = '元都新景 12-1-1001室';
const longResidence = '观澜山水东区云栖花园·南区景观住宅 12-2-1802室';
const origin = 'https://chunmo-preview.test';
async function open(route, { multi = false, dual = false } = {}) {
  const instance = { ...pages[route], data: structuredClone(pages[route].data) };
  instance.setData = (values, ready) => {
    for (const [key, value] of Object.entries(values)) {
      const [outer, inner] = key.split('.');
      if (inner) instance.data[outer][inner] = value;
      else instance.data[outer] = value;
    }
    ready?.();
  };
  unified.setDual(dual ? ['employee', 'owner'] : [route === ownerPage ? 'owner' : 'employee']);
  if (route === ownerPage) {
    const projects = [{ id: 'one', title: multi ? longResidence : residence }];
    if (multi) projects.push({ id: 'two', title: '云栖花园二期 5-1-702室' });
    auth = {
      owner: { id: 'test-owner', name: multi ? '欧阳林如意' : '马先生' },
      projects,
      purchasesEnabled: true,
    };
    allowedDesign = { one: { rendering: true, panorama: true }, two: {} };
    store.end();
    store.beginVerified(auth);
    instance.onLoad();
  } else {
    staffAvatar = undefined;
    staffApp.engine = { active: true, store: { identity } };
    storage.set('chunmo-workbench-v1:' + identity.workspaceId + ':' + identity.id, {
      ...drafts,
      actor: identity.id,
      workspace: identity.workspaceId,
    });
  }
  await instance.onShow();
  return instance;
}

const results = [];
const browser = await chromium.launch({
  executablePath: process.env.CHUNMO_CHROMIUM || '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
await mkdir(out, { recursive: true });
try {
  for (const [width, height, top, bottom] of sizes) {
    statusBar = top;
    for (const route of [ownerPage, staffPage]) {
      const owner = route === ownerPage;
      const multi = owner && width === 320;
      const instance = await open(route, { multi, dual: width === 390 });
      const nav = { ...component.methods, data: { active: 'profile' } };
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      try {
        await page.route(origin + '/**', async (request) => {
          const path = new URL(request.request().url()).pathname;
          if (path === '/')
            return request.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><body></body></html>',
            });
          if (path.startsWith('/sandbox/'))
            return request.fulfill({ contentType: 'image/png', body: photo });
          return request.fulfill({ path: join(root, path) });
        });
        await page.goto(origin);
        await page.exposeFunction('tapMini', (handler, dataset) => {
          const event = { currentTarget: { dataset }, target: { dataset } };
          return handler === 'switchTab' ? nav.switchTab(event) : instance[handler](event);
        });
        await page.evaluate(
          ({ wxml, wxss, width, top, bottom, route, navigation, notice, owner }) => {
            const template = new Function('global', wxml)({});
            const css = new Function(wxss)();
            for (const file of ['app', route, notice, ...(owner ? [navigation] : [])]) {
              css(file + '.wxss')('', { deviceWidth: width });
            }
            const tags = {
              'wx-image': 'img',
              'wx-button': 'button',
              'wx-text': 'text',
              'wx-canvas': 'canvas',
              'wx-slider': 'input',
              'wx-view': 'view',
            };
            for (const style of document.head.querySelectorAll('style')) {
              style.textContent = style.textContent
                .replace(/wx-(?:button|text|image|canvas|slider|view)\b/g, (value) => tags[value])
                .replace(/env\(safe-area-inset-bottom\)/g, bottom + 'px');
            }
            document.head.insertAdjacentHTML(
              'beforeend',
              '<style>html,body{margin:0}view{display:block}button{cursor:pointer}</style>',
            );
            const frame = document.createElement('main');
            document.body.append(frame);
            function mount(node) {
              if (typeof node !== 'object') return document.createTextNode(String(node));
              if (node.tag === 'wx-owner-nav')
                return mount(template(navigation + '.wxml')(node.attr));
              if (node.tag === 'wx-spring-notice')
                return mount(template(notice + '.wxml')({ tone: 'info', ...node.attr }));
              const el = document.createElement(tags[node.tag] || 'view');
              for (const [key, value] of Object.entries(node.attr || {})) {
                if (key === 'mode')
                  el.style.objectFit = value === 'aspectFill' ? 'cover' : 'contain';
                else if (key === 'bindtap' || key === 'binderror')
                  el.addEventListener(key === 'bindtap' ? 'click' : 'error', () => {
                    window.lastMiniTap = window.tapMini(value, { ...el.dataset });
                  });
                else if (key === 'disabled' || key === 'hidden') {
                  if (value) el.setAttribute(key, '');
                } else if (key === 'ariaRole') el.setAttribute('role', value);
                else
                  el.setAttribute(
                    key.replace(/^aria([A-Z])/, (_, letter) => 'aria-' + letter.toLowerCase()),
                    value,
                  );
              }
              for (const child of node.children || []) el.append(mount(child));
              return el;
            }
            window.renderMini = (data) => {
              frame.replaceChildren(mount(template(route + '.wxml')(data)));
              if (!owner) {
                frame.querySelector('.employee-profile').style.minHeight =
                  'calc(100vh - ' + (top + 44 + bottom + 47) + 'px)';
                frame.style.paddingTop = top + 44 + 'px';
              }
            };
            // Show the platform bars at their reported sizes while leaving page WXML intact.
            const chrome = document.createElement('div');
            chrome.style.cssText =
              'position:fixed;inset:0 0 auto;z-index:4;pointer-events:none;color:#1A201A;font:600 14px system-ui' +
              (owner ? '' : ';background:#F8F5F3');
            chrome.innerHTML =
              '<span style="position:absolute;left:8%;top:' +
              Math.round(top * 0.38) +
              'px">08:59</span>' +
              '<span style="position:absolute;right:8%;top:' +
              Math.round(top * 0.38) +
              'px">••• ▰</span>' +
              '<span style="position:absolute;right:8px;top:' +
              (top + 5) +
              'px;border:1px solid #ECE7E4;border-radius:16px;width:81px;height:29px;display:grid;place-items:center">•••　◎</span>' +
              (owner
                ? ''
                : '<span style="display:grid;place-items:center;height:44px;margin-top:' +
                  top +
                  'px;color:#254437">个人中心</span>');
            document.body.append(chrome);
            if (!owner) {
              const nativeTab = document.createElement('div');
              nativeTab.className = 'native-tab-preview';
              nativeTab.style.cssText =
                'position:fixed;inset:auto 0 0;z-index:3;display:flex;justify-content:space-around;align-items:center;background:#f7f8f4;color:#617269;border-top:1px solid #e2eae1;font:13px system-ui;height:46px;padding-bottom:' +
                bottom +
                'px';
              nativeTab.innerHTML =
                '<span>工作台</span><span>工地拍照</span><b style="color:#244e42">我的</b>';
              document.body.append(nativeTab);
            }
            if (bottom >= 30) {
              const safeIndicator = document.createElement('div');
              safeIndicator.style.cssText =
                'position:fixed;z-index:4;pointer-events:none;width:32%;height:4px;border-radius:3px;bottom:7px;left:34%;background:#232323';
              document.body.append(safeIndicator);
            }
          },
          { wxml, wxss, width, top, bottom, route, navigation, notice, owner },
        );
        const render = async () => {
          await page.evaluate((data) => window.renderMini(data), instance.data);
          await page.evaluate(() =>
            Promise.all([
              document.fonts.ready,
              ...Array.from(document.images, (img) => img.decode()),
            ]),
          );
        };
        const tap = async (locator) => {
          await locator.click();
          await page.evaluate(() => window.lastMiniTap);
        };
        await render();
        assert.equal(
          await page.locator('.profile-name').textContent(),
          owner ? auth.owner.name : '林芷晴',
        );
        assert.equal(
          await page.locator('.profile-subtitle').textContent(),
          owner ? auth.projects[0].title : '设计部 · 室内设计师',
        );
        assert.equal(await page.locator('.profile-avatar-icon').count(), 1);
        assert.equal(
          await page.getByText('切换身份', { exact: true }).count(),
          Number(width === 390),
        );
        assert.equal(await page.getByText('切换住宅', { exact: true }).count(), Number(multi));
        const geom = await page.evaluate(() => {
          const rect = (selector) =>
            document.querySelector(selector)?.getBoundingClientRect().toJSON();
          const frame = document.querySelector('.profile-frame');
          const mascot = document.querySelector('.svip-mascot');
          const badge = document.querySelector('.svip-badge');
          return {
            card: rect('.profile-card'),
            avatar: rect('.profile-avatar'),
            name: rect('.profile-name'),
            detail: rect('.profile-detail'),
            frame: rect('.profile-frame'),
            emblem: rect('.svip-emblem'),
            badge: rect('.svip-badge'),
            mascot: rect('.svip-mascot'),
            nav: rect('.owner-nav, .native-tab-preview'),
            footer: rect('.profile-footer-logo'),
            frameSize: frame && [frame.naturalWidth, frame.naturalHeight],
            mascotSize: mascot && [mascot.naturalWidth, mascot.naturalHeight],
            mascotFit: mascot && getComputedStyle(mascot).objectFit,
            badgeLayer: badge && getComputedStyle(badge).zIndex,
            activeTab: document.querySelector('.owner-nav .selected')?.textContent.trim(),
            scrollWidth: document.documentElement.scrollWidth,
            designs: Array.from(document.querySelectorAll('.design-card'), (element) =>
              element.getBoundingClientRect().toJSON(),
            ),
          };
        });
        assert.equal(geom.scrollWidth, width, 'Document has horizontal overflow at ' + width);
        assert.ok(Math.abs(geom.card.width / geom.card.height - 750 / 290) < 0.002);
        assert.ok(Math.abs(geom.avatar.width - geom.avatar.height) < 0.5);
        assert.ok(geom.avatar.right < geom.name.left && geom.detail.bottom < geom.card.bottom);
        assert.ok(geom.card.top >= top + 44);
        assert.equal(geom.nav.bottom, height);
        if (!owner || width > 320)
          assert.ok(geom.footer.bottom < geom.nav.top, 'Navigation overlaps the footer');
        if (owner) {
          assert.deepEqual(geom.frameSize, [750, 290]);
          assert.deepEqual(geom.mascotSize, [967, 1060]);
          assert.equal(geom.mascotFit, 'contain');
          assert.equal(geom.badgeLayer, '1');
          assert.equal(geom.activeTab, '我的');
          assert.ok(geom.emblem.left > geom.name.right && geom.emblem.right < geom.card.right);
          assert.ok(geom.mascot.bottom > geom.badge.top && geom.mascot.bottom < geom.badge.bottom);
          assert.ok(geom.designs.every((tile) => Math.abs(tile.width - tile.height) < 0.5));
          assert.equal(await page.getByRole('img', { name: 'SVIP｜屋主', exact: true }).count(), 1);
        } else {
          assert.equal(geom.emblem, undefined);
          assert.equal(geom.frame, undefined);
          assert.deepEqual(geom.designs, []);
        }
        results.push({ width, height, role: owner ? '屋主' : '员工', ...geom });
        await page.screenshot({
          path: join(out, width + 'px-' + (owner ? '屋主' : '员工') + '.png'),
        });

        if (multi) {
          await tap(page.getByText('切换住宅', { exact: true }));
          await render();
          assert.equal(await page.locator('.residence-option').count(), 2);
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          const footer = await page.locator('.profile-footer-logo').boundingBox();
          assert.ok(footer.y > 0 && footer.y + footer.height < geom.nav.top);
          await page.screenshot({ path: join(out, '320px-切换住宅与底部滚动.png') });
          await tap(page.getByText(auth.projects[1].title, { exact: true }));
          await instance.onShow();
          await render();
          assert.equal(
            await page.locator('.profile-subtitle').textContent(),
            auth.projects[1].title,
          );
          assert.equal(await page.getByText('暂未发布', { exact: true }).count(), 2);
          allowedDesign.two = { panorama: true };
          await instance.onPullDownRefresh();
          await render();
          assert.equal(events.at(-1), '刷新完成');
          assert.equal(await page.getByText('暂未发布', { exact: true }).count(), 1);
        }

        if (width === 390) {
          events.length = 0;
          if (owner) {
            await tap(page.getByText('效果图', { exact: true }));
            await tap(page.getByText('水电图', { exact: true }));
            await tap(page.getByText('用户协议', { exact: true }));
            await tap(page.getByText('隐私保护指引', { exact: true }));
            await tap(page.getByText('事项', { exact: true }));
            assert.deepEqual(events.slice(0, 5), [
              '/owner-login/pages/design/index?kind=rendering&project=one',
              '/owner-login/pages/design/index?kind=panorama&project=one',
              '/owner-login/pages/terms/index',
              '隐私保护指引',
              '返回',
            ]);
          } else {
            await tap(page.getByText('复制本机工作草稿与归档', { exact: true }));
            await tap(page.getByText('本机照片与恢复', { exact: true }));
            assert.deepEqual(events.slice(0, 2), [drafts, '/pages/results/index?recover=1']);
            staffAvatar = photo;
            await instance.onShow();
            await new Promise(setImmediate);
            assert.match(instance.data.profile.avatar, /^\/sandbox\/employee-avatar-/);
            await render();
            assert.equal(await page.locator('.profile-avatar-photo').count(), 1);
          }
          await tap(page.getByText('切换身份', { exact: true }));
          assert.equal(events.at(-1), unified.entry + '?choose=1');
          await tap(page.getByRole('button', { name: '更换头像' }));
          assert.equal(instance.data.cropReady, true);
          await render();
          await tap(page.getByText('保存头像', { exact: true }));
          await render();
          assert.equal(await page.locator('.profile-avatar-photo').count(), 1);
          if (!owner) assert.match(uploaded, /^data:image\/jpeg;base64,/);
          await page.locator('.profile-avatar-photo').dispatchEvent('error');
          await page.evaluate(() => window.lastMiniTap);
          await render();
          assert.equal(await page.locator('.profile-avatar-icon').count(), 1);
          confirmLogout = !owner;
          await tap(page.getByText('退出登录', { exact: true }));
          assert.deepEqual(events.slice(-2), [owner ? '业主退出' : '员工退出', unified.entry]);
        }
        instance.onUnload();
      } finally {
        await page.close();
      }
    }
    const [owner, staff] = results.slice(-2);
    assert.equal(owner.card.width, staff.card.width);
    assert.equal(owner.card.height, staff.card.height);
    assert.equal(owner.avatar.width, staff.avatar.width);
    assert.equal(owner.name.left, staff.name.left);
  }
  await writeFile(join(out, 'layout-results.json'), JSON.stringify(results, null, 2));
  console.log(
    'PASS compiled WXML/WXSS for 8 profile layouts, assets, navigation, residence refresh, avatar, policy, drafts and logout',
  );
} finally {
  await browser.close();
}
