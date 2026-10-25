# 阶段 B 第一部分：本地可测试的真实云端协作闭环

2026-10-24；分支 `feat/chunmo-project-manager`。本轮在开发机的两个独立 PostgreSQL 数据库验证，不连接阿里云、不部署、不迁移用户真实资料。保留原 React/TypeScript 页面和 IndexedDB，不自动上传本地记录。

## 已实现与实际边界

- Node.js/Express/TypeScript API、PostgreSQL 17、带校验和及事务锁的递增 SQL 迁移；服务启动拒绝数据库超级用户连接。新环境先执行迁移，不在服务启动时自动改表。
- 真实负责人/普通员工账号，Argon2id（64 MiB、3轮）、随机服务端会话、令牌哈希存库、8小时绝对过期、退出/停用/重置密码撤销会话。限制并发密码计算和登录频率。生产配置强制 HTTPS/Secure Cookie；开发仅允许 loopback HTTP。
- HttpOnly/SameSite=Strict Cookie、Origin/CSRF 校验、逐请求工作室归属与负责人身份校验。负责人由数据库 `owner_account_id` 确认，客户端角色/施工人员类别不能提升权限。无公开注册或默认密码。
- 项目、工种、任务、人员分配、采购、事项备忘、字典和15天历史由真实 PostgreSQL 保存；原有纯函数继续用于日期、关联、快照与恢复，不复制一份独立的前端云业务逻辑。
- 整个工作室版本号 CAS：旧版本写入返回409，不自动重试覆盖；前端保留草稿，提示备份及明确重新读取。编辑面板打开、工期拖动或尚未保存时暂缓远端刷新，避免旧表单借用新版本号覆盖他人修改。
- SSE只发送版本号，客户端重新请求经授权的业务状态。当前采用每连接1秒查询数据库版本/会话，最多8连接/账号；事务还发出 PostgreSQL NOTIFY，未来可切换 LISTEN。不是CRDT、自动字段合并、光标协作或在线头像。预期4–5人，生产负载尚待验证。
- 私密手机号/出生日期独立加密表与专用 API；普通 SQL 角色不能读私密表。公共业务、JSON导出、可恢复历史及SSE不含这些字段。错误/审计不记录私密正文、密码或令牌。当前两个私密字段均采用负责人专用端点，生日没有授予员工；可委派的独立生日权限尚未开放。
- 采购原定期限/审批历史由服务端保护；普通保存不能伪造期限或审批。负责人明确填写原因调用专用 API，服务端生成期限历史并保留最初日期。
- 本地备份导入必须负责人先预览再确认；保持稳定ID，只合并相同或未存在的数据，同ID不同内容拒绝，绝不整库覆盖。预览10分钟过期、绑定账号/工作室/基准版本；同一备份哈希导入幂等。16 MiB请求限制。版本历史校验并移除伪造身份，差异从有效快照重新计算，导入操作者显示“身份未核验”。无效历史数量在预览显示；业务主体无效则拒绝。

### 权限矩阵（当前代码，而非远期承诺）

| 操作                                           | 负责人 | 普通员工         |
| ---------------------------------------------- | ------ | ---------------- |
| 本工作室公共项目/工期/采购/人员分配/备忘读写   | 是     | 是               |
| 公共业务导出、历史查看、SSE                    | 是     | 是；不含私密信息 |
| 删除项目、恢复历史、导入本地备份、采购延期确认 | 是     | 否               |
| 创建员工、停用账号、重置员工密码               | 是     | 否               |
| 手机号/生日私密API                             | 是     | 否，响应403      |
| 其他工作室数据                                 | 否     | 否               |

当前所有员工共享本工作室公共业务权限。`project_permission` 仅预留，**未启用细分项目ACL**。内部五星评价仍未开放，不因本轮有登录就提前公开。私密资料当前通过API验证，尚无生产人员私密资料编辑页面。账号停用/密码重置API已实现，后台账号列表/管理页面尚未扩展。没有负责人转移、MFA、自助找回密码、空闲会话超时、委派生日权限或完整合规审计。

## 数据结构与事务

| 表                                | 用途                                                 |
| --------------------------------- | ---------------------------------------------------- |
| schema_migration                  | 顺序迁移、文件校验和、执行时间                       |
| cloud_workspace / account         | 工作室、唯一负责人关联、真实账号/角色/密码哈希       |
| auth_session / login_limit        | 可撤销会话与数据库登录限流                           |
| workspace_state                   | 当前业务聚合JSONB、历史JSONB、全工作室revision       |
| project / trade / task            | 项目工种及施工段；任务起止为DATE，复合外键确保同项目 |
| person / assignment               | 非私密人员、项目/工种/任务范围的稳定ID分配           |
| purchase / memo                   | 采购与事项备忘，项目/可选任务复合外键                |
| person_private                    | 独立AES-256-GCM密文，不进入公共聚合或快照            |
| project_permission                | 未来细分项目权限预留，当前未启用                     |
| audit_event                       | 可信账号、动作、版本与时间，不保存正文               |
| import_preview / imported_archive | 受控预览与幂等导入凭据                               |

为保留已有前端业务，当前采用**聚合读写 + 同事务关系投影**，不是每个字段独立CRUD。一次保存锁定工作室版本、校验完整数据和期限规则、写入关系投影/历史/新revision/审计并发出通知，整体提交或回滚。字典、前序关系等保留在经共享模型校验的JSONB内；关联投影用外键和延迟触发器补充检查。恢复同样走事务。删除仍有私密资料的人员会被外键保护并回滚，不会孤立或隐式删除私密资料；此类人员应先停用。

版本粒度是全工作室，两个员工即使修改不同项目也可能409；这是保守保护，后续可增量细化，不能省略版本检查。15天历史读取时过滤，每小时清理过期历史、会话、预览和限流项；清理事务不改当前业务数据/版本。真实审计与可恢复业务历史分开。业务历史不包含账号/会话/私密资料，恢复项目不会重新启用已撤销账号或覆盖私密字段。

## 独立开发和测试数据库

需要 Node.js 22.12+（本轮24）、npm、Docker（Windows使用Docker Desktop Linux容器）。脚本仅操作当前机器loopback Docker daemon，不使用远程 Docker endpoint。

```sh
npm ci
npm run db:development
npm run db:test
```

- 开发：容器/卷 `chunmo-b-development`，`127.0.0.1:55432`，库 `chunmo_development`。
- 测试：容器/卷 `chunmo-b-test`，`127.0.0.1:55433`，库 `chunmo_test`。
- 各自生成随机密码及密钥，写到被Git忽略的 `.env.development.local` / `.env.test.local`。没有通用默认账号。数据库仅绑定loopback。
- `chunmo_app` 为普通业务SQL角色，`chunmo_private` 仅私密表及审计插入；迁移管理连接单独保存。测试拒绝非loopback或非`_test`数据库。测试为每次运行创建隔离工作室和随机账号，不清空、截断或复用用户数据。
- 脚本重跑保留配置、密码和卷；容器/配置只存在一边时拒绝重建。没有自动清理或重置数据库命令。初次启动等待数据库就绪。
- `.env.example` 仅占位说明，不能用其中占位值运行。不要把密钥、连接串、Cookie、备份或浏览器trace提交Git。生产API只应取得两个运行时连接和加密密钥，不应得到迁移超级用户凭据。

### 首次创建开发负责人

账号只能初次由受控命令创建；数据库已有账号时拒绝覆盖。登录名3–80位小写字母/数字/`_.@-`，密码8–128位。Windows PowerShell中输入密码时避免明文留在命令历史：

```powershell
$env:OWNER_LOGIN = Read-Host '负责人登录名'
$secret = Read-Host '负责人密码（8–128位）' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:OWNER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  npm run owner:create
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Item Env:OWNER_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:OWNER_LOGIN -ErrorAction SilentlyContinue
}
```

Linux bash使用 `read -r OWNER_LOGIN`、`read -rs OWNER_PASSWORD`，`export OWNER_LOGIN OWNER_PASSWORD` 后运行 `npm run owner:create`，完成后 `unset OWNER_LOGIN OWNER_PASSWORD`。不要把密码写入命令参数或仓库。

两个终端：

```sh
# 终端一
npm run api:dev
# 终端二
npm run dev -- --port 5173 --strictPort
```

用 **http://127.0.0.1:5173**（不是localhost，需与APP_ORIGIN精确一致）。前端Vite同源代理`/api`至4000。浏览器初始仍是本地空间；点“连接云空间”，登录后明确“进入云空间”。负责人可在账号面板创建普通员工；用另一个浏览器或独立无痕会话登录员工进行协作。只开两个普通标签页会共享Cookie，不能当两个独立账号。

原本Windows项目的数据在原网站源IndexedDB内。本地同步代码、启动Node或数据库都不会自动导入它；**保留原访问地址**以找到原本地数据，先下载完整业务与版本备份，再从指定云端地址的账号面板选择文件、检查预览并确认。不要因为新端口/localhost与127地址不同而误以为数据被清除。

## API概要

所有写请求需JSON及精确Origin；登录后的写请求还需会话对应CSRF。

- `POST /api/auth/login`、`GET /api/auth/session`、`POST /api/auth/logout`。
- `POST /api/accounts` 创建员工，`PATCH /api/accounts/:id` 停用/重置密码（负责人）。
- `GET|PUT /api/workspace` 公共完整业务；PUT需`{revision,data}`。
- `GET /api/export` 公共业务与15天历史，不包含私密字段/账号/密钥。
- `POST /api/history/restore` `{revision,id}`（负责人，恢复修改前）。
- `POST /api/purchases/:id/deadline` `{revision,date,reason}`（负责人）。
- `GET|PUT /api/people/:id/private`（负责人）；PUT为`{phone,birthDate}`，普通成员禁止读写。
- `POST /api/import/preview` `{archive}`，`POST /api/import/commit` `{id,revision,confirm:true}`（负责人）。
- `GET /api/events` 验证Cookie后的SSE，仅版本元数据；退出/停用立即关闭。

## 测试、构建与本轮验收

```sh
npm run test:all
npm run format:check
npm run build
```

测试使用独立PostgreSQL而非内存模拟权限。云端浏览器套件另启4001/5180并创建负责人和普通员工独立会话；本地套件仍使用5173。不要在这些测试端口另启其他应用。产物为 `dist/` 前端和 `dist-api/server.mjs` 后端；数据库迁移文件仍需随服务发行，不包含在JS bundle。`npm run preview`只验证前端产物，不会启动API。

最终执行结果（2026-10-24）：

| 检查                          | 实际结果                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 原业务单元测试                | 60/60通过                                                                                                                                   |
| 真实PostgreSQL/API集成测试    | 9/9通过；鉴权、撤销、租户隔离、私密字段/SQL权限/导出、CAS、完整关联恢复、幂等导入、异常校验、迁移重跑、服务重启、期限审批及私密档案外键回滚 |
| 原本地浏览器交互              | 50/50通过；包括工期拖动、排序、采购联动、人员、历史、字体与PNG导出                                                                          |
| 真实云端浏览器交互            | 3/3通过；两个独立账号/上下文、双向SSE、旧表单409与草稿保留、授权API、受控导入/重复防护、本地数据保留、退出、采购期限确认                    |
| 前端与后端生产构建            | 通过；`dist/`和`dist-api/server.mjs`生成                                                                                                    |
| 已构建后端启动                | loopback4000、独立开发库，`/api/health`返回成功                                                                                             |
| 格式、差异空白检查            | 通过                                                                                                                                        |
| 开发/测试数据库初始化再次执行 | 通过；保留原配置、卷及业务                                                                                                                  |

新增采购浏览器检查首次因导航按钮带动态数量标记而定位失败；修正为匹配实际可访问名称后，全套重新运行通过，未改弱业务断言。构建仅有Zod依赖的PURE注释提示，不阻塞构建。

测试使用合成数据，没有导入用户真实项目，没有清空原浏览器数据。Windows字体/实机效果与ECS负载不在本轮Linux浏览器验证范围。

## 备份与后续部署门槛

公共JSON备份不是完整服务器灾备：账号、会话、私密密文和审计需受限的PostgreSQL备份，`PRIVATE_DATA_KEY`需单独加密保管。没有密钥不能解密手机号。Docker命名卷只是持久化，不是异地备份；禁止删卷恢复“干净环境”。正式部署前必须完成数据库备份与异地副本、密钥恢复演练、私网HTTPS/VPN、安全组、服务管理、监控/磁盘容量、限流与4–5人负载验收。

本轮不连接ECS、不安装生产服务、不提供默认生产密码，不把loopback开发HTTP当作生产安全。2核2GB架构仍沿用[阶段B方案](phase-b-architecture.md)，部署需用户检查本轮后再开始。

## 本轮实际修改文件

- `.env.example`
- `.gitignore`
- `PROJECT_GUIDE.md`
- `README.md`
- `cloud-tests/collaboration.spec.ts`
- `docs/phase-b-architecture.md`
- `docs/phase-b-cloud.md`
- `package-lock.json`
- `package.json`
- `playwright.cloud.config.ts`
- `scripts/cloud-db.mjs`
- `scripts/cloud-owner.ts`
- `scripts/cloud-provision.ts`
- `server/app.ts`
- `server/auth.ts`
- `server/cloud.test.ts`
- `server/config.ts`
- `server/db.ts`
- `server/index.ts`
- `server/maintenance.ts`
- `server/migrate.ts`
- `server/migrations/001_cloud.sql`
- `server/migrations/002_assignment_scope.sql`
- `server/store.ts`
- `server/test-fixtures.ts`
- `src/App.tsx`
- `src/components/CloudControl.tsx`
- `src/components/PurchaseDeadlineDialog.tsx`
- `src/lib/cloud.ts`
- `src/lib/history.ts`
- `src/lib/useCloudWorkspace.ts`
- `src/lib/useWorkspace.ts`
- `src/lib/useWorkspaceMode.ts`
- `src/style.css`
- `tsconfig.json`
- `tsconfig.server.json`
- `vite.config.ts`

账号密码统一为8–128位，不要求字符组合，不接受空白密码；前端、API和初始负责人创建命令共用校验。账号面板提供“修改我的密码”，负责人和员工均须验证当前密码并确认新密码。负责人通过“员工账号管理”加载本工作室员工，选择后重置；不需要员工原密码，也不改变角色、启用状态或项目记录。员工无账号列表/重置权限，忘记密码由负责人重置。

密码仍为Argon2id存储。修改或重置密码的事务同时撤销目标账号所有会话，本进程SSE立即关闭，其他进程在下次会话检查时关闭；必须重新登录。自行修改成功不刷新或清空当前页面数据，避免丢失草稿；有未保存云端更改时先处理保存/备份。密码操作按操作者每分钟最多5次，共享PostgreSQL计数，并限制最多两个并发密码计算。登录和密码更新按账号行锁串行化，防止旧密码在重置后创建新会话。没有数据库迁移或部署配置变更。

首次部署的 `owner.env` 仅是初始凭据，账号改密后不会写入新密码；后续部署不会用初始凭据覆盖已更改的账号密码。

本轮验证（2026-10-25）：62/62 单元测试、14/14 PostgreSQL/API 测试、19/19 部署/TLS 测试、50/50 原有本地浏览器测试及4/4云端浏览器测试通过；前端/API/部署工具构建通过。云端浏览器验证包含负责人和员工自行改密、错误当前密码、确认不一致、负责人选择员工重置、旧会话失效以及真实云空间重新登录。接口另覆盖8/128位边界、跨工作室拒绝、账号/业务记录保持、全部会话及SSE撤销、Argon2id参数、共享限流和并发登录/重置。私有CA原生Nginx双浏览器、重启持久化、加密备份及隔离恢复验收通过。没有连接或部署真实ECS，没有修改或清空原有浏览器存储。
