const fs = require('node:fs');
const path = require('node:path');
const appid = process.argv[2];
if (!/^wx[a-zA-Z0-9]{16}$/.test(appid || '')) {
  console.error('用法：node tools/configure-appid.cjs wx开头的小程序AppID（不是AppSecret）');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'project.config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.appid = appid;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log('AppID 已写入公开项目配置。不要在此工程填写 AppSecret。');
