// Visual checks of actual WXML/WXSS templates in Chromium, NOT WeChat or phone
// screenshots. Native camera/picker behavior still needs DevTools/real devices.
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
const root = 'miniprogram/chunmo-photo/';
const logo =
  'data:image/jpeg;base64,' +
  (await readFile(root + 'assets/chunmo-original.jpg')).toString('base64');
await mkdir('docs/workbench/screenshots', { recursive: true });
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const cases = [
    ['login', { login: '', busy: false, error: '' }],
    ['password', { login: '测试监理', password: '', busy: false, error: '' }],
    [
      'workbench',
      {
        tab: 'today',
        tabs: ['今日', '明日', '逾期', '采购', '事项'],
        tabKeys: ['today', 'tomorrow', 'overdue', 'purchases', 'records'],
        projects: [{ name: '全部工地' }],
        projectIndex: 0,
        mine: false,
        date: '',
        day: '2026-11-13',
        pending: [],
        items: [
          {
            id: 'sample-purchase',
            kind: 'purchase',
            title: '电线采购确认',
            projectName: '隔离样例工地',
            date: '2026-11-13',
            status: '待采购',
            owner: '测试监理',
            remainingLabel: '今日到期',
          },
          {
            id: 'sample-record',
            kind: 'record',
            title: '墙面复核',
            projectName: '隔离样例工地',
            date: '2026-11-13',
            status: '持续跟进',
            owner: '测试监理',
            remainingLabel: '今日到期',
          },
        ],
      },
    ],
    [
      'work-edit',
      {
        kind: 'purchase',
        projects: [{ name: '隔离样例工地' }],
        projectIndex: 0,
        statuses: ['待采购', '已下单', '已到货', '已完成'],
        statusIndex: 1,
        form: {
          name: '电线采购确认',
          projectId: 'sample',
          due: '2026-11-14',
          status: '已下单',
          owner: '测试监理',
          notes: '样例备注',
          quantity: '2卷',
          specification: '2.5平方',
        },
        history: [],
      },
    ],
    [
      'work-edit',
      {
        kind: 'record',
        projects: [{ name: '隔离样例工地' }],
        projectIndex: 0,
        statuses: ['持续跟进', '已完成'],
        statusIndex: 0,
        form: {
          title: '墙面复核',
          projectId: 'sample',
          nodeDate: '2026-11-13',
          status: '持续跟进',
          owner: '测试监理',
          notes: '样例备注',
          followUp: '现场复核后记录',
        },
        history: [],
      },
    ],
    ['photo', { pending: 2 }],
    [
      'camera',
      {
        mounted: true,
        frame: { left: 0, top: 130, width: 390, height: 560 },
        top: 60,
        placeName: '隔离样例地点',
        wm: {
          x: 12,
          y: 520,
          width: 280,
          pad: 10,
          radius: 8,
          logo: 24,
          brand: 16,
          font: 11,
          gap: 16,
        },
        lines: ['工地定位：隔离样例地点', '拍摄时间：2026.11.13 17:00', '拍摄人员：测试监理'],
        captured: 2,
        saved: 2,
        ready: true,
      },
    ],
  ];
  for (const [name, data] of cases) {
    let css = await readFile(root + 'app.wxss', 'utf8');
    let local = await readFile(root + 'pages/' + name + '/index.wxss', 'utf8');
    if (name === 'password')
      local = local.replace(
        /@import\s+["']\.\.\/login\/index\.wxss["'];/,
        await readFile(root + 'pages/login/index.wxss', 'utf8'),
      );
    css += local;
    css = css.replace(/\bpage\s*\{/g, 'body {');
    const wxml = await readFile(root + 'pages/' + name + '/index.wxml', 'utf8');
    await page.setContent(
      '<html><head><meta charset="utf-8"><style>body{margin:0}div{box-sizing:border-box}button{cursor:pointer}input,textarea{font:inherit}img{object-fit:cover}' +
        css +
        '</style></head><body></body></html>',
    );
    await page.evaluate(
      ({ wxml, data, logo }) => {
        const normalized = wxml.replace(/<([a-z][\w:-]*)([^<>]*?)\/\s*>/g, '<$1$2></$1>');
        const doc = new DOMParser().parseFromString(normalized, 'text/html');
        function expr(s, scope) {
          try {
            return Function('s', 'with(s){return (' + s + ')}')(scope);
          } catch {
            return undefined;
          }
        }
        function value(s, scope) {
          if (/^{{[\s\S]*}}$/.test(s) && s.indexOf('}}') === s.length - 2)
            return expr(s.slice(2, -2), scope);
          return s.replace(/{{([\s\S]*?)}}/g, (_, e) => expr(e, scope) ?? '');
        }
        function children(source, target, scope) {
          let matched = false;
          for (const node of source.childNodes) {
            if (node.nodeType === 3) {
              target.appendChild(document.createTextNode(value(node.textContent, scope)));
              continue;
            }
            if (node.nodeType !== 1) continue;
            if (node.hasAttribute('wx:if')) {
              matched = !!value(node.getAttribute('wx:if'), scope);
              if (!matched) continue;
            } else if (node.hasAttribute('wx:else')) {
              if (matched) continue;
            } else matched = false;
            if (node.hasAttribute('wx:for')) {
              const items = value(node.getAttribute('wx:for'), scope) || [];
              items.forEach((item, index) => {
                const clone = node.cloneNode(true);
                clone.removeAttribute('wx:for');
                const wrap = document.createElement('div');
                wrap.appendChild(clone);
                children(wrap, target, { ...scope, item, index });
              });
              continue;
            }
            const tag = node.tagName.toLowerCase();
            if (['privacy-dialog', 'photo-renderer'].includes(tag)) continue;
            if (tag === 'block') {
              children(node, target, scope);
              continue;
            }
            const mapped =
              {
                view: 'div',
                text: 'span',
                'cover-view': 'div',
                'cover-image': 'img',
                image: 'img',
                picker: 'div',
                camera: 'div',
                switch: 'input',
              }[tag] || tag;
            const el = document.createElement(mapped);
            for (const a of node.attributes) {
              if (
                a.name.startsWith('wx:') ||
                a.name.startsWith('bind') ||
                a.name.startsWith('catch')
              )
                continue;
              let v = value(a.value, scope);
              if (a.name === 'disabled' && !v) continue;
              if (v !== undefined) el.setAttribute(a.name, String(v));
            }
            if (mapped === 'img') el.src = logo;
            if (tag === 'switch') {
              el.type = 'checkbox';
              el.checked = !!scope.mine;
            }
            if (mapped === 'input') el.value = value(node.getAttribute('value') || '', scope) || '';
            if (mapped === 'textarea')
              el.value = value(node.getAttribute('value') || '', scope) || '';
            if (tag === 'camera') {
              el.style.background = '#273e32';
              el.textContent = '';
            }
            children(node, el, scope);
            target.appendChild(el);
          }
        }
        children(doc.body, document.body, { ...data, privacyVisible: false });
      },
      { wxml, data, logo },
    );
    await page.screenshot({
      path:
        'docs/workbench/screenshots/' +
        (name === 'work-edit' ? data.kind + '-editor' : name) +
        '-template.png',
      fullPage: true,
    });
  }
} finally {
  await browser.close();
}
