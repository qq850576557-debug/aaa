# 依赖安全整改与安装脚本验证

2026-10-24（北京时间）；当前功能分支 `feat/chunmo-project-manager`，起点 `d0706ef`。本轮仅变更测试依赖、安装脚本授权、依赖验证工具及说明文档，不变更应用业务、数据库迁移或数据结构，不访问阿里云、不清理IndexedDB或项目记录。

## 实际审计与修复依据

原锁文件为 Vitest 3.2.7，`package.json` 范围为 `^3.2.4`。实测 `npm audit`：3个受影响依赖节点（1中危、2严重/critical），涉及下列公告；Vitest节点的严重级别包含其传递依赖风险，并非三个彼此独立的生产漏洞。

| 公告                                                                                                                                               | 原依赖链与影响                                                                  | 本轮处理                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)                                                                           | vitest → @vitest/mocker：redirect mock路径穿越/任意文件读取，修复边界4.1.11     | 升级整套Vitest至4.1.12                            |
| [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)                                                                           | @vitest/mocker：未认证手动mock注册的代码注入，修复边界4.1.12                    | mocker随Vitest固定4.1.12                          |
| [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)、[GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | vitest → tinypool 1.1.1：worker/run选项的原型污染利用链可导致RCE，修复边界2.1.2 | Vitest4已经不依赖tinypool，锁文件与实际安装均移除 |

这些依赖全部标记为dev，只供测试运行；mock服务器暴露、执行不可信测试输入等开发/CI场景仍有风险，不能以“仅开发依赖”为由忽略。原生产依赖审计已为0，整改后仍为0。

选择**精确版本 `vitest: 4.1.12`**。目前3.x最高3.2.7仍在影响范围内，无可用3.x安全补丁；4.1.12支持当前Vite7.3.7及项目Node22.12+/当前Node24，未引入Vite8升级。3→4属于显式大版本变更，已用原有测试及构建验证兼容；未修改测试断言或业务代码。没有强制覆盖旧Vitest内部依赖，也没有接受audit默认推荐的Vitest5.0.5。未运行 `npm audit fix --force`。

生产依赖的版本与integrity相较原锁文件全部保持不变，仅更新Vitest配套开发依赖链。构建用Vite/esbuild不会作为运行中Node API所需依赖；生产运行应使用 `node dist-api/server.mjs` 配合受控环境配置，不使用Vite或tsx开发服务代替生产服务。

## argon2 / esbuild 最小脚本授权

检查了锁定版本的脚本及其执行入口：

- `argon2@0.45.1`：`install` 为 `cross-env ZERO_AR_DATE=1 node-gyp-build`，检测/装载包内本机预编译N-API模块，无法使用时才尝试本机源码编译。包中有Windows x64预编译文件；这不等同于已在Windows运行验证。不把它替换为模拟密码算法。
- `esbuild@0.28.2`：`postinstall` 为 `node install.js`，选取对应操作系统的可选二进制包、验证版本；缺少可选包时有官方npm安装/下载回退逻辑。保留锁文件完整性校验、可选平台包及TLS校验。
- `fsevents`是macOS可选开发依赖，本轮Windows/Linux不需要其安装脚本，没有批准。

`package.json` 新增 npm12支持的精确版本白名单：

```json
"allowScripts": {
  "argon2@0.45.1": true,
  "esbuild@0.28.2": true
}
```

根据实际npm12.0.1发布包的脚本授权实现确认格式，并在临时解包的npm12 CLI中执行了干净 `ci --foreground-scripts`：仅出现上述两个安装脚本，成功完成。没有全局安装/升级npm，没有使用`approve-scripts --all`、无限制版本批准或全局关闭脚本保护。升级这两个包时必须重新审查新版本并更新精确授权，不自动扩大权限。

npm11等旧版本不支持此白名单，不能声称旧npm已执行逐包授权。已另用当前npm11.9.0验证指定两包的rebuild流程。跨版本保守安装方法是先忽略所有依赖脚本，再仅重建这两个包；`--ignore-scripts=false`只作用于本次指定包命令，不修改用户全局配置。

新增 `npm run verify:native`，使用随机临时输入实际验证Argon2id的算法、参数、正确密码通过、错误密码拒绝，以及esbuild的TypeScript打包。不打印密码、哈希、数据库配置，不连接数据库，也不写入项目数据。PHC参数按键解析，不假定序列化顺序。`--production`只验证argon2，适用于没有开发依赖的运行环境。

## Windows同步与检查

先停止当前本地开发服务，保留所有 `.env.*.local` 文件和浏览器数据。在仓库目录确认分支及本地修改；若有自己的未提交修改，先保留并处理，不运行重置或清理。

```powershell
git branch --show-current
# 必须是 feat/chunmo-project-manager
git status --short
git pull --ff-only origin feat/chunmo-project-manager
npm.cmd ci --ignore-scripts
npm.cmd rebuild argon2 esbuild --ignore-scripts=false --foreground-scripts
npm.cmd run verify:native
npm.cmd audit
npm.cmd audit --omit=dev
npm.cmd run build
```

期望依赖验证输出为 `PASS argon2` 和 `PASS esbuild`，审计均为0项已知漏洞。npm12也可直接 `npm.cmd ci --foreground-scripts` 使用仓库白名单。如果用户自己设置了 `ignore-scripts=true`，该配置仍然优先阻止脚本，请使用上面的指定包重建方式；不要用全局允许全部脚本来消除提示。

`npm.cmd run dev -- --port 5173 --strictPort` 可恢复本地前端；云空间另一个终端运行 `npm.cmd run api:dev`。沿用原来的浏览器访问地址以读取原IndexedDB，不新建/清空数据库。无须重新导入已有云数据或更换密钥。

若Windows验证失败，应保留错误输出、`node --version`、`npm.cmd --version`、`node -p "process.platform + '/' + process.arch"` 后诊断平台/二进制问题。当前云环境为Linux x64，本轮不能冒充Windows实机验收；非x64架构/无匹配预编译包时可能需要该平台编译工具，不能以关闭验证代替修复。

## 实际验证结果

| 检查                              | 实际结果                                           |
| --------------------------------- | -------------------------------------------------- |
| 整改前完整npm audit               | 3项：1中危、2 critical                             |
| 整改后完整npm audit               | 0项；最终重新审计通过                              |
| 生产npm audit --omit=dev（前/后） | 0项 / 0项                                          |
| 原有单元测试（Vitest4.1.12）      | 60/60通过，未改测试用例                            |
| 真实PostgreSQL/API测试            | 9/9通过，包括真实密码认证、会话和私密API权限       |
| 原有本地浏览器交互测试            | 50/50通过                                          |
| 两账号云端浏览器交互测试          | 3/3通过                                            |
| 前端 + 后端生产构建               | 通过；仅原有Zod依赖PURE注释提示                    |
| npm12精确白名单干净安装           | 通过；只运行argon2/esbuild两个已审查脚本           |
| npm11指定两包重建                 | 通过，未更改全局配置                               |
| 原生依赖实际检查                  | Argon2id参数与正/误密码校验、esbuild真实打包均通过 |
| 格式、git差异空白                 | 通过                                               |

首次新增原生检查把PHC参数顺序写死，识别出库按键排序后的合法输出；已改为解析参数键后严格核对算法、版本和全部参数，重新验证通过。原业务测试和认证代码均未改变。

当前没有遗留的npm已知漏洞；该结论范围是本次npm公告数据库与锁文件，不是完整安全审计或生产部署认证。Windows实机原生模块检查仍需在本地执行上面的命令，本轮Linux验证不能代替它。

另外在独立临时目录实际执行npm12 `ci --omit=dev`：成功，仅运行argon2脚本；Argon2id验证通过，`vitest`、`@vitest/mocker`、`tinypool`、`esbuild`均不在运行时安装目录中。未修改工作区数据库或浏览器存储。

本轮修改文件：`package.json`、`package-lock.json`、`scripts/verify-native.mjs`、`README.md`、本文档。
