# 春茉 UI V1.0 本地验收

预览使用真实网页、现有 API 和独立测试工作室。示例工地、事项及轮值通过测试接口录入本机 `chunmo_test`。需要 Node.js 22.12+、npm 和 Docker，Windows 上启动 Docker Desktop 的 Linux 容器。

在升级分支的项目目录打开 PowerShell，准备一次本地预览数据。

```powershell
npm ci
npm run db:test
npx playwright install chromium
$env:CHUNMO_UI_V1_SCREENSHOTS = Join-Path $env:TEMP 'chunmo-ui-v1'
npm run test:cloud:e2e -- cloud-tests/desktop-ui-v1.spec.ts
Get-Content (Join-Path $env:CHUNMO_UI_V1_SCREENSHOTS 'local-login.txt')
```

从同一目录分别开两个 PowerShell 窗口。先启动已存在的测试 API。

```powershell
$env:APP_ORIGIN = 'http://127.0.0.1:5180'
npm run api:test
```

再启动预览网页。

```powershell
$env:CHUNMO_API_TARGET = 'http://127.0.0.1:4001'
npm run dev -- --host 127.0.0.1 --port 5180 --strictPort
```

用浏览器打开 `http://127.0.0.1:5180/`，输入前面生成的本地账号。可以查看项目详情，打开值日或事项编辑弹窗，测试今日与明日的收起和展开。对照旧版时打开 `http://127.0.0.1:5180/?ui=legacy`。
