import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
const root = resolve('miniprogram/chunmo-photo');
const tools = process.env.CHUNMO_WECHAT_TOOLS;
if (!tools)
  throw Error(
    '设置 CHUNMO_WECHAT_TOOLS 为已安装 miniprogram-compiler@0.2.3 和 miniprogram-api-typings@5.3.1 的隔离工具目录；不需要AppSecret',
  );
const require = createRequire(join(resolve(tools), 'package.json'));
const compiler = require('miniprogram-compiler');
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'tests') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const files = await walk(root);
for (const p of files.filter((p) => p.endsWith('.json'))) JSON.parse(await readFile(p, 'utf8'));
for (const p of files.filter((p) => p.endsWith('.js') || p.endsWith('.cjs')))
  new Script(await readFile(p, 'utf8'), { filename: p });
const wxml = compiler.wxmlToJs(root);
new Function('global', wxml);
// Call wcsc directly as the npm wrapper can accidentally swallow a nonzero exit.
const compilerRoot = resolve(require.resolve('miniprogram-compiler'), '..');
const wxssFiles = files.filter((p) => p.endsWith('.wxss')).map((p) => p.slice(root.length + 1));
const css = spawnSync(join(compilerRoot, 'bin/linux/wcsc'), ['-db', ...wxssFiles], {
  cwd: root,
  encoding: 'utf8',
});
if (css.error || css.status !== 0) throw Error(css.stderr || String(css.error));
const logo = await readFile(join(root, 'assets/chunmo-original.jpg'));
if (
  createHash('sha256').update(logo).digest('hex') !==
  '611a63cc6e1e5f8e4271f94e55b449e1f48f074648c7996fa5d1878afcffb831'
)
  throw Error('品牌Logo与原稿不一致');
const typeCheck = spawnSync(
  resolve('node_modules/.bin/tsc'),
  [
    '--allowJs',
    '--checkJs',
    '--noEmit',
    '--skipLibCheck',
    '--strict',
    'false',
    '--target',
    'ES2022',
    '--module',
    'commonjs',
    '--types',
    join(resolve(tools), 'node_modules/miniprogram-api-typings'),
    ...files.filter((p) => p.endsWith('.js')),
  ],
  { encoding: 'utf8' },
);
if (typeCheck.error || typeCheck.status !== 0) throw Error(typeCheck.stdout + typeCheck.stderr);
console.log(
  JSON.stringify(
    {
      jsonAndJavaScript: 'pass',
      wxmlFiles: files.filter((p) => p.endsWith('.wxml')).length,
      wxssFiles: wxssFiles.length,
      officialApiTypeCheck: 'pass',
      originalLogo: 'unchanged',
      wechatDevTools: 'not installed / not verified',
      physicalDevices: 'not verified',
    },
    null,
    2,
  ),
);
