// Runs the *actual compiled WXML* through a browser layout adapter and the actual
// watermark drawing function through Canvas2D. This is NOT a WeChat emulator,
// CameraContext performance test, or proof of a phone's gallery save result.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import sharp from 'sharp';
const tools = process.env.CHUNMO_WECHAT_TOOLS;
if (!tools) throw Error('设置 CHUNMO_WECHAT_TOOLS（参见小程序README）');
const require = createRequire(join(resolve(tools), 'package.json'));
const { wxmlToJs } = require('miniprogram-compiler');
const root = resolve('miniprogram/chunmo-photo'),
  out = resolve(process.env.CHUNMO_MINI_EVIDENCE || '/tmp/chunmo-wechat-evidence');
await mkdir(out, { recursive: true });
const wxml = wxmlToJs(root),
  watermark = await readFile(join(root, 'lib/watermark.js'), 'utf8');
const { layout } = require(join(root, 'lib/watermark.js'));
const logo =
  'data:image/jpeg;base64,' +
  (await readFile(join(root, 'assets/chunmo-original.jpg'))).toString('base64');
const appCss = await readFile(join(root, 'app.wxss'), 'utf8');
const task = {
  place: { placeName: '演示地点（排版测试）' },
  actorName: '测试监理',
  capturedAt: '2026-11-13T02:00:00Z',
};
const browser = await chromium.launch({
  executablePath: process.env.CHUNMO_CHROMIUM || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const results = {
  environment: 'Linux Chromium; compiled WXML browser adapter, NOT WeChat',
  physicalDevice: false,
  layouts: [],
  pixels: [],
  serial20: {},
};
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let thumbnail = '';
  for (const [width, height] of [
    [4000, 3000],
    [3000, 4000],
  ]) {
    const rendered = await page.evaluate(
      async ({ watermark, logo, task, width, height }) => {
        const module = { exports: {} };
        new Function('module', watermark)(module);
        const image = new Image();
        image.src = logo;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#c1ccc6';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#8faba0';
        ctx.fillRect(0, 0, width / 2, height / 2);
        module.exports.drawWatermark(ctx, image, width, height, task);
        const bytes = Array.from(
          new Uint8Array(
            await (await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer(),
          ),
        );
        const small = document.createElement('canvas');
        small.width = 240;
        small.height = Math.round((240 * height) / width);
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
        const thumbnail = small.toDataURL('image/jpeg', 0.72);
        canvas.width = canvas.height = 1;
        return { bytes, thumbnail };
      },
      { watermark, logo, task, width, height },
    );
    const buffer = Buffer.from(rendered.bytes),
      metadata = await sharp(buffer).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    await writeFile(join(out, `watermark-${width}x${height}.jpg`), buffer);
    results.pixels.push({
      width,
      height,
      bytes: buffer.length,
      kind: 'synthetic Canvas image, not a phone capture',
    });
    thumbnail = rendered.thumbnail;
  }
  results.serial20 = await page.evaluate(
    async ({ watermark, logo, task }) => {
      const module = { exports: {} };
      new Function('module', watermark)(module);
      const img = new Image();
      img.src = logo;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 4000;
      canvas.height = 3000;
      const ctx = canvas.getContext('2d'),
        times = [];
      for (let i = 0; i < 20; i++) {
        const at = performance.now();
        ctx.fillStyle = '#c1ccc6';
        ctx.fillRect(0, 0, 4000, 3000);
        module.exports.drawWatermark(ctx, img, 4000, 3000, task);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95));
        if (!blob.size) throw Error('Empty JPEG');
        times.push(performance.now() - at);
      }
      canvas.width = canvas.height = 1;
      return {
        completed: times.length,
        width: 4000,
        height: 3000,
        timesMs: times,
        kind: 'Chromium synthetic draw+JPEG; no camera / WeChat / album timings',
      };
    },
    { watermark, logo, task },
  );
  const places = Array.from({ length: 30 }, (_, i) => ({
    id: 'demo-' + i,
    name: '演示地点 ' + (i + 1),
    address: '仅用于检查页面排版',
    distance: 20 + i * 70,
  }));
  const sizes = [320, 360, 390, 430].map((width) => ({
    width,
    height: 844,
    names: ['login', 'places', 'camera', 'results'],
  }));
  sizes.push({ width: 844, height: 390, names: ['camera'] });
  for (const { width, height, names } of sizes) {
    await page.setViewportSize({ width, height });
    const mark = layout(width, height, task);
    for (const name of names) {
      const css = appCss + '\n' + (await readFile(join(root, `pages/${name}/index.wxss`), 'utf8'));
      const data =
        name === 'login'
          ? { login: '', password: '', busy: false }
          : name === 'places'
            ? {
                places,
                selectedId: 'demo-0',
                status: '定位精度约±20米',
                query: '',
                more: true,
                busy: false,
                entering: false,
                accountName: '测试监理',
              }
            : name === 'camera'
              ? {
                  mounted: true,
                  ready: true,
                  top: width > height ? 40 : 64,
                  placeName: task.place.placeName,
                  captured: 20,
                  saved: 20,
                  failed: 0,
                  lines: mark.lines,
                  wm: {
                    x: mark.x,
                    bottom: width > height ? 16 : 148,
                    width: mark.boxW,
                    pad: mark.pad,
                    radius: 14 * mark.scale,
                    logo: mark.logoSize,
                    brand: mark.brandFont,
                    font: mark.font,
                    gap: mark.gap,
                  },
                }
              : {
                  recover: false,
                  stats: { captured: 20, saved: 20, failed: 0 },
                  selectedCount: 20,
                  allSelected: true,
                  busy: false,
                  photos: Array.from({ length: 20 }, (_, i) => ({
                    id: 'photo-' + i,
                    selected: true,
                    label: '相册已保存',
                    thumbnail,
                    dimensions: '4000×3000',
                  })),
                };
      await page.setContent(
        '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',
      );
      await page.evaluate(
        ({ wxml, css, data, name, logo }) => {
          const generate = new Function('global', wxml)({});
          const tree = generate('pages/' + name + '/index.wxml')(data);
          const tags = {
            'wx-page': 'main',
            'wx-view': 'div',
            'wx-cover-view': 'div',
            'wx-text': 'span',
            'wx-scroll-view': 'section',
            'wx-image': 'img',
            'wx-cover-image': 'img',
            'wx-input': 'input',
            'wx-button': 'button',
            'wx-camera': 'div',
          };
          function element(node) {
            if (typeof node === 'string' || typeof node === 'number')
              return document.createTextNode(String(node));
            if (!node || !tags[node.tag]) return document.createTextNode('');
            const el = document.createElement(tags[node.tag]);
            if (node.tag === 'wx-page') el.className = 'wxpage';
            for (const [key, value] of Object.entries(node.attr || {})) {
              if (key === 'src')
                el.setAttribute(
                  'src',
                  value === '/assets/chunmo-original.jpg' ? logo : String(value),
                );
              else if (key === 'password') el.setAttribute('type', 'password');
              else if (
                ['class', 'style', 'placeholder', 'value', 'disabled'].includes(key) &&
                value !== false &&
                value != null
              )
                el.setAttribute(key, String(value));
            }
            if (node.tag === 'wx-scroll-view') el.style.overflow = 'auto';
            if (node.tag === 'wx-image' || node.tag === 'wx-cover-image')
              el.style.objectFit = node.attr?.mode === 'aspectFill' ? 'cover' : 'contain';
            if (node.tag === 'wx-camera')
              el.style.background = 'linear-gradient(145deg,#365349,#172e24)';
            (node.children || []).forEach((c) => el.appendChild(element(c)));
            return el;
          }
          const style = document.createElement('style');
          style.textContent =
            'html,body{margin:0;height:100%;}.wxpage{min-height:100vh}input{font-family:inherit;font-size:15px}button{font-family:inherit;display:block}.bottom>button,.footer>button,.panel>button{width:100%}' +
            css.replace(/\bpage\{/g, '.wxpage{');
          document.head.appendChild(style);
          document.body.appendChild(element(tree));
        },
        { wxml, css, data, name, logo },
      );
      await page.evaluate(() =>
        Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => {}))),
      );
      const info = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        primary: Array.from(document.querySelectorAll('button.primary')).map((e) => ({
          y: e.getBoundingClientRect().y,
          bottom: e.getBoundingClientRect().bottom,
          width: e.getBoundingClientRect().width,
        })),
      }));
      assert.ok(info.scrollWidth <= width + 1, name + ' horizontal overflow at ' + width);
      if (name === 'places' || name === 'results')
        assert.ok(
          info.primary.every((r) => r.bottom <= height && r.width > 200),
          name + ' ' + width + ': ' + JSON.stringify(info),
        );
      if (name === 'camera') {
        const overlap = await page.evaluate(() => {
          const a = document.querySelector('.watermark').getBoundingClientRect(),
            b = document.querySelector('.controls').getBoundingClientRect();
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        });
        assert.equal(
          overlap,
          false,
          'camera watermark overlaps controls at ' + width + 'x' + height,
        );
      }
      results.layouts.push({
        page: name,
        width,
        height,
        pass: true,
        scope: 'browser layout adapter',
      });
      if (width === 390) await page.screenshot({ path: join(out, name + '-390.png') });
      if (width > height) await page.screenshot({ path: join(out, 'camera-landscape.png') });
    }
  }
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        output: out,
        layouts: results.layouts.length,
        pixels: results.pixels,
        synthetic20: results.serial20.completed,
        physicalDevices: 'not verified',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
