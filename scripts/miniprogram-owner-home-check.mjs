// Load the real home Page and compiled WXML in Chromium for layout and interaction checks.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const tools = process.env.CHUNMO_WECHAT_TOOLS;
if (!tools)
  throw Error('Set CHUNMO_WECHAT_TOOLS to the existing miniprogram-compiler installation');
const { wxmlToJs, wxssToJs } = createRequire(join(resolve(tools), 'package.json'))(
  'miniprogram-compiler',
);
const { chromium } = require(process.env.CHUNMO_PLAYWRIGHT || 'playwright');
const root = resolve(process.env.CHUNMO_MINI_ROOT || 'miniprogram/chunmo-photo');
const out = resolve(process.env.CHUNMO_MINI_EVIDENCE || '/tmp/chunmo-owner-home-check');
const home = 'owner-login/pages/home/index',
  nav = 'owner-login/components/owner-nav/index';
const wxml = wxmlToJs(root);
assert.ok(wxml.includes(home + '.wxml') && wxssToJs(root).includes(home + '.wxss'));

async function inlineWxss(file) {
  const source = await readFile(file, 'utf8');
  return (
    await Promise.all(
      source.split(/(@import\s+['"][^'"]+['"];)/g).map((part) => {
        const imported = /^@import\s+['"]([^'"]+)['"];/.exec(part);
        return imported ? inlineWxss(resolve(dirname(file), imported[1])) : part;
      }),
    )
  ).join('\n');
}
const styles = await Promise.all(
  ['app', home, nav].map((path) => inlineWxss(join(root, path + '.wxss'))),
);
const assets = {};
for (const name of [
  'cart.svg',
  'chevron.svg',
  'home.svg',
  'ordered.svg',
  'overdue.svg',
  'person.svg',
  'xiaokui-peek.png',
]) {
  const path = 'owner-login/assets/home-v1/' + name;
  const mime = name.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  assets['/' + path] =
    'data:' + mime + ';base64,' + (await readFile(join(root, path))).toString('base64');
}

let definition, component, auth, records, status, capsuleLeft;
const events = [];
const store = require(join(root, 'owner-login/fixture-store'));
const owner = require(join(root, 'owner-login/owner-session'));
const fixtureDate = Date.parse('2026-10-31T09:00:00+08:00');
Date.now = () => fixtureDate;
globalThis.Page = (page) => {
  definition = page;
};
globalThis.Component = (value) => {
  component = value;
};
globalThis.wx = {
  getAccountInfoSync: () => ({
    miniProgram: { envVersion: 'trial', appId: require(join(root, 'project.config.json')).appid },
  }),
  getWindowInfo: () => ({ statusBarHeight: status }),
  getMenuButtonBoundingClientRect: () => ({ left: capsuleLeft }),
  navigateTo: ({ url, complete }) => {
    events.push(url);
    complete?.();
  },
  reLaunch: ({ url }) => events.push(url),
  stopPullDownRefresh: () => events.push('refresh-finished'),
  nextTick: (callback) => callback(),
  pageScrollTo: ({ scrollTop }) => events.push('restored-scroll:' + scrollTop),
};
owner.session = async () => auth;
owner.purchases = async (id) => ({ items: records[id] });
require(join(root, home));
require(join(root, nav));

function setup({ title, multi = false, empty = false, counts = [3, 12] }) {
  const projects = [{ id: 'example', title, phase: '施工中' }];
  if (multi) projects.push({ id: 'second', title: '第二套授权住宅', phase: '已到货' });
  auth = { owner: { id: 'fixture-owner', name: '联调业主' }, projects, purchasesEnabled: true };
  const examples = [
    ['地板', '确认品牌、颜色及数量', '2026-11-02'],
    ['厨房水龙头', '型号确认后下单', '2026-11-05'],
    ['射灯', '确认开孔尺寸与数量', '2026-11-08'],
  ];
  records = {
    example: empty
      ? []
      : ['pending', 'bought'].flatMap((state, group) =>
          Array.from({ length: counts[group] }, (_, index) => {
            const [item, description, due] = examples[index % 3];
            return {
              id: state + '-' + String(index).padStart(4, '0'),
              title: item,
              description,
              due,
              state,
            };
          }),
        ),
    second: [
      {
        id: 'second-only',
        title: '第二套住宅专属采购',
        description: '复核尺寸',
        due: '2027-01-08',
        state: 'pending',
      },
    ],
  };
  store.end();
  store.beginVerified(auth);
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = (values) => Object.assign(page.data, values);
  page.onLoad();
  return page;
}

const sizes = [
  [320, 568, 20, 223, 12],
  [375, 812, 44, 278, 34],
  [390, 844, 47, 289, 34],
  [430, 932, 59, 330, 34],
];
const name = '元都新景 12-1-1001室';
const results = [];
const browser = await chromium.launch({
  executablePath: process.env.CHUNMO_CHROMIUM || '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
await mkdir(out, { recursive: true });
try {
  for (const [width, height, statusBar, capsule, safeBottom] of sizes) {
    status = statusBar;
    capsuleLeft = capsule;
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      const navInstance = { ...component.methods, data: { active: 'home' } };
      const instance = setup({ title: name });
      await instance.onShow();
      await page.exposeFunction('tapMini', (handler, dataset) => {
        const event = { currentTarget: { dataset } };
        return handler === 'switchTab' ? navInstance.switchTab(event) : instance[handler](event);
      });
      await page.exposeFunction('miniPageScroll', (scrollTop) => {
        instance.onPageScroll({ scrollTop });
        return instance.data.scrolled;
      });
      const render = async () => {
        await page.setContent(
          '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
        );
        await page.evaluate(
          ({ assets, styles, width, safeBottom, statusBar, capsule, source, data, home, nav }) => {
            const generate = new Function('global', source)({});
            const style = document.createElement('style');
            style.textContent =
              'html,body{margin:0}button{cursor:pointer}img{object-fit:contain}view{display:block}button,text,view{box-sizing:border-box}' +
              styles
                .join('\n')
                .replace(/\bpage\s*\{/g, 'body {')
                .replace(/(-?[\d.]+)rpx/g, (_, n) => String((Number(n) * width) / 750) + 'px')
                .replace(/env\(safe-area-inset-bottom\)/g, safeBottom + 'px');
            document.head.append(style);
            function mount(node) {
              if (typeof node === 'string' || typeof node === 'number')
                return document.createTextNode(String(node));
              if (node.tag === 'wx-owner-nav')
                return mount(generate(nav + '.wxml')({ active: 'home' }));
              const tag =
                { 'wx-image': 'img', 'wx-button': 'button', 'wx-text': 'text' }[node.tag] || 'view';
              const el = document.createElement(tag);
              let tap = '';
              for (const [key, value] of Object.entries(node.attr || {})) {
                if (key === 'src') el.src = assets[value] || '';
                else if (key === 'bindtap') tap = value;
                else if (key !== 'style' && typeof value !== 'object') el.setAttribute(key, value);
                else if (key === 'style') el.style.cssText += ';' + value;
              }
              for (const child of node.children || []) el.append(mount(child));
              if (tap) el.addEventListener('click', () => window.tapMini(tap, { ...el.dataset }));
              return el;
            }
            document.body.append(mount(generate(home + '.wxml')(data)));
            window.onscroll = async () => {
              const scrolled = await window.miniPageScroll(scrollY);
              document.querySelector('.owner-home')?.classList.toggle('home-scrolled', scrolled);
            };
            // The platform chrome is simulated separately to check the real page uses its reported bounds.
            const chrome = document.createElement('div');
            chrome.style.cssText =
              'position:fixed;inset:0 0 auto;pointer-events:none;font:600 14px system-ui;color:#191919';
            chrome.innerHTML =
              '<span style="position:absolute;left:9%;top:calc(' +
              statusBar +
              'px / 2)">08:59</span>' +
              '<span style="position:absolute;left:' +
              capsule +
              'px;top:' +
              (statusBar + 4) +
              'px;width:' +
              (width - capsule - 8) +
              'px;height:30px;border:1px solid #eee9e6;border-radius:17px;display:grid;place-items:center">•••　◎</span>';
            document.body.append(chrome);
          },
          {
            assets,
            styles,
            width,
            safeBottom,
            statusBar,
            capsule,
            source: wxml,
            data: instance.data,
            home,
            nav,
          },
        );
        await page.evaluate(() =>
          Promise.all([
            document.fonts.ready,
            ...Array.from(document.images, (image) => image.decode()),
          ]),
        );
      };
      await render();
      assert.equal(await page.locator('.home-title').textContent(), name);
      assert.deepEqual(await page.locator('.home-stat-count').allTextContents(), ['0', '12']);
      assert.equal(await page.locator('.home-total').textContent(), '/ 共15项');
      assert.equal(await page.locator('.home-date').first().textContent(), '预计 11月02日');
      assert.equal(await page.locator('.home-switch').count(), 0);
      const geometry = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          plaque: rect('.home-plaque'),
          mascot: rect('.home-mascot'),
          pending: rect('.home-pending'),
          schedule: rect('.home-schedule'),
          nav: rect('.owner-nav-home'),
          overflow: document.documentElement.scrollWidth > innerWidth,
          mascotPointerEvents: getComputedStyle(document.querySelector('.home-mascot'))
            .pointerEvents,
        };
      });
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.mascotPointerEvents, 'none');
      assert.ok(Math.abs(geometry.mascot.width / geometry.mascot.height - 870 / 988) < 0.002);
      assert.ok(
        Math.abs(geometry.mascot.top + (geometry.mascot.height * 808) / 988 - geometry.plaque.top) <
          0.5,
      );
      assert.ok(geometry.mascot.right <= capsule - 3 && geometry.mascot.top >= statusBar + 3);
      assert.ok(
        Math.abs(geometry.schedule.left - geometry.plaque.left) < 1 &&
          geometry.schedule.width === geometry.pending.width,
      );
      assert.equal(geometry.nav.bottom, height);
      await page.screenshot({ path: join(out, width + 'px-首页.png') });
      if (width === 390) {
        events.length = 0;
        await page.locator('.home-pending').click();
        await page.locator('.home-stat').first().click();
        await page.locator('.home-stat').last().click();
        await page.locator('.home-row').first().click();
        await page.getByText('我的', { exact: true }).click();
        assert.deepEqual(events, [
          '/owner-login/pages/purchases/index?state=pending',
          '/owner-login/pages/purchases/index?overdue=1',
          '/owner-login/pages/purchases/index?state=bought',
          '/owner-login/pages/purchase/index?id=pending-0000',
          '/owner-login/pages/profile/index',
        ]);
      }
      if (width === 320) {
        const long = setup({
          title: '春茉联合设计场景·观澜山水东区住宅超长项目名称 12-2-1802室',
          multi: true,
          counts: [12, 150],
        });
        // The existing page event bridge keeps the same Page object while its test data changes.
        Object.assign(instance, long);
        records.example[0].due = '2026-10-21';
        await instance.onShow();
        await render();
        assert.ok((await page.locator('.home-title').boundingBox()).height > 2 * 20);
        assert.equal(await page.locator('.home-row').count(), 12);
        assert.equal(await page.locator('.home-late').textContent(), '已逾期');
        events.length = 0;
        await page.locator('.home-switch').click();
        assert.deepEqual(events, ['/owner-login/pages/profile/index?switch=1']);
        await page.screenshot({ path: join(out, '320px-长住宅名和多住宅.png') });
        await page.evaluate(
          () =>
            new Promise((done) => {
              window.scrollTo(0, document.documentElement.scrollHeight);
              requestAnimationFrame(() => requestAnimationFrame(done));
            }),
        );
        const row = await page.locator('.home-row').last().boundingBox();
        const tab = await page.locator('.owner-nav-home').boundingBox();
        assert.ok(
          row.y > 0 && row.y + row.height < tab.y,
          JSON.stringify({
            row,
            tab,
            scroll: await page.evaluate(() => [
              scrollY,
              document.documentElement.scrollHeight,
              getComputedStyle(document.querySelector('.owner-home')).paddingBottom,
            ]),
          }),
        );
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.owner-home'), '::before').position ===
            'fixed',
        );
        await page.screenshot({ path: join(out, '320px-滚动到底.png') });
        const before = instance.data.pendingCount;
        records.example.push({
          id: 'after-refresh',
          title: '下拉刷新新采购',
          due: '2026-11-19',
          state: 'pending',
        });
        await instance.onPullDownRefresh();
        assert.equal(instance.data.pendingCount, before + 1);
        assert.equal(events.at(-1), 'refresh-finished');
        store.choose('second');
        await instance.onShow();
        assert.deepEqual(
          instance.data.recent.map(({ id }) => id),
          ['second-only'],
        );
        assert.equal(instance.data.recent[0].homeDate, '预计 2027年01月08日');
      }
      if (width === 375) {
        Object.assign(instance, setup({ title: '无采购的住宅', empty: true }));
        await instance.onShow();
        await render();
        assert.equal(await page.locator('.home-empty').textContent(), '近期暂无采购安排');
        assert.equal(await page.locator('.home-row').count(), 0);
        await page.screenshot({ path: join(out, '375px-空数据.png') });
      }
      results.push({ width, height, safeBottom, statusBar, geometry });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(join(out, 'layout-results.json'), JSON.stringify(results, null, 2));
console.log(
  'PASS four layouts, PNG contact, safe areas, long/empty/multiple residences, scrolling, routes and refresh',
);
