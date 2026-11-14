# 首页 V3.1 修复与验收（2026-11-14）

状态：源码、隔离数据库、真实 Chromium 浏览器及生产构建已验证；**未替用户部署生产，也尚未取得修复后的生产保存回执**。线上版本以用户最后一次 Workbench 诊断为准：`e81284ae04a5acdc10a75fff67911f87cf68f0a3`。

## 保存失败的实际原因

用户执行固定版本 `f6a76458cb9d27408c3dad8e10a20f585c841f96` 的只读诊断后返回：

- 原网站、API、小程序拍照和工作台四个服务均运行。
- 015 已安装，SHA-256 为 `d505a4398e6562f44f3b47cd420c6cf7999b6038eebed9f28ff29d3bd377e523`，与源码相同。
- `studio_daily` 有 SELECT/INSERT/UPDATE，无 DELETE；回执表有 SELECT/INSERT，无 UPDATE/DELETE。
- 回执不可变触发器为启用状态，类型 27，使用 `immutable_audit_event`。
- 运行账号 `cm_stg_app` 不是超级用户，也没有 BYPASSRLS。
- 设置保存及轮换保存日志均出现 SQLSTATE `42501`。诊断中的 `ready: true` 只覆盖旧版检查项，不能证明所有共享写入依赖就绪。
- API 文件 SHA-256：`e8aa388758529248d2f66b278d5da4722c8c428a659d03b4ebb59b247ebb37b5`。
- 备份目录存在；此结果不能证明目录中的备份可恢复。

旧保存事务执行 `SELECT id FROM cloud_workspace ... FOR UPDATE`。部署授权中，应用账号对此表仅有 SELECT；行级写锁需要 UPDATE 权限，因此即使 015 正确也会失败。隔离数据库用相同的关键表授权复现了 `42501`；真实 HTTP 测试确认改用已有 `workspace_state` 行锁后，创始人保存成功。它不执行对该状态行的 UPDATE，测试也核对保存前后完整状态行未变。

此修复不扩大数据库或员工权限。最高负责人校验、Cookie、CSRF、事务、版本 CAS、幂等回执、审计及历史保护继续保留。普通管理员角色不能取得创始人权限。

启动检查补齐 015、校验值、必需列、逐项最小权限、共享锁表、审计 INSERT 和不可变回执触发器。运行期健康接口新增 `capabilities.studioDaily`，避免仅凭 SELECT 1 误判模块可用；新增启动时确定的 API `release` 标识，避免切换链接后旧进程冒充新版本。

## 界面修复及兼容

- 工作室日常采用同一 Grid 行等高，标题、内边距和底部操作区统一；窄窗口自然上下排列。
- 今日／明日采用明确的标题、日期、内容、操作区布局，不再把空余高度分配给标题或日期。
- 默认展开；收起保留按实际宽度计算的完整第一排；两侧独立控制，菜单返回保留，F5 重置。两侧同状态等高，混合状态允许收起侧自然缩短，总数不变。
- 关联员工使用单一列表；全体员工与指定员工互斥。停用或未识别的旧人员关联继续保留，不因新界面自动清除。
- 值日统一人员选择和排序；首次设置、调整计划、记录完成、修正历史各显示本次必要字段。调整计划只显示当前计划日期，保留原首次日期。3／7 天轮换和完成后重算不变。
- 实际查看截图时发现长要求在左侧列表互相挤压，已改为两行摘要和完整编辑正文，并增加不重叠断言。
- 旧 enabled、weekdays、from/to 等字段及已完成记录继续兼容；未添加 SQL 迁移，未改生产授权，未清空草稿。
- 未修改微信小程序、手机网页组件、Android、鸿蒙和迁移文件。共享后端只做本次必要的修复和就绪检查。

## 真实浏览器与像素测量

使用真实 Chromium 和隔离测试 API，不使用静态设计稿。每个宽度测试 8/8、10/6、0/6、10/0 四种记录分布，以及全部展开、混合、全部收起三种状态，共 48 组测量。

| 桌面宽度 | 日常卡片顶部／底部最大差 | 提醒标题／日期／首排顶部最大差 | 同排卡片高度最大差 | 同状态提醒底部／操作区最大差 | 横向溢出 |
| -------- | ------------------------ | ------------------------------ | ------------------ | ---------------------------- | -------- |
| 1280     | 0 px                     | 0 px                           | 0 px               | 0 px                         | 无       |
| 1440     | 0 px                     | 0 px                           | 0 px               | 0 px                         | 无       |
| 1920     | 0 px                     | 0 px                           | 0 px               | 0 px                         | 无       |
| 2560     | 0 px                     | 0 px                           | 0 px               | 0 px                         | 无       |

混合展开状态底部差异是预期行为，不计作等高断言。另测试空／长工作要求、未排班／已排班、创始人／员工、90% 视口缩放、1024 宽度堆叠、弹窗可视范围和按钮遮挡。90% 视口变化不等于所有系统原生 DPI／浏览器缩放组合均已实测。

原始测量：[1280](screenshots/home-v31/geometry-1280.json)、[1440](screenshots/home-v31/geometry-1440.json)、[1920](screenshots/home-v31/geometry-1920.json)、[2560](screenshots/home-v31/geometry-2560.json)。

真实截图均已打开查看。截图含隔离测试人员／项目，不代表生产记录：

| 内容                   | 本轮实际截图                                                    |
| ---------------------- | --------------------------------------------------------------- |
| 完整首页及提醒全部展开 | [展开首页](screenshots/home-v31/home-expanded.png)              |
| 完整首页及提醒收起     | [收起首页](screenshots/home-v31/home-collapsed.png)             |
| 每日必做／卫生值日局部 | [等高卡片](screenshots/home-v31/studio-cards.png)               |
| 提醒第一排保留         | [收起局部](screenshots/home-v31/agenda-collapsed.png)           |
| 每日必做管理           | [统一人员多选区与正文](screenshots/home-v31/daily-editor.png)   |
| 值日管理               | [单日期与排班预览](screenshots/home-v31/duty-editor.png)        |
| 查看排班               | [居中排班弹窗](screenshots/home-v31/schedule.png)               |
| 员工只读               | [无管理按钮的员工首页](screenshots/home-v31/staff-readonly.png) |

旧版真实本地截图用于前后比较：[旧首页](screenshots/studio-home-v3/home-all-cards.png)、[旧每日必做](screenshots/studio-home-v3/rules-manager.png)、[旧值日编辑](screenshots/studio-home-v3/duty-manager.png)。旧图来自先前版本的隔离浏览器验收，不冒充本轮线上截图。

## 测试结果

- Vitest：48 文件、231 项通过。
- API／数据库回归：91 项通过，包含真实 HTTP 最小关键权限复现、负责人新增／修改、关联员工、值日设置、重登持久化及员工拒绝编辑。
- API 启动版本缓存：1 项通过，切换发行标记不改变旧进程上报的版本。
- 真实桌面浏览器回归：17 项通过；最终截图和兼容细节调整后，V3.1 四个宽度再次全部通过。
- 部署测试：56 项通过，包括只更新代码的数据库只读检查、故障注入、旧版本和 Nginx 恢复、恢复失败显式报错、实际健康脚本拒绝模块未就绪／旧 API／错误前端 HTML。
- 只读诊断测试：2 项通过；日志输出限制为路由和错误码，无员工资料或密钥。
- `npm run build`、`npm run build:deploy` 通过；Shell 语法检查通过。

主要复测命令（API 使用已有隔离 `.env.test.local`，不得替换成生产连接）：

```bash
npm test
node --env-file=.env.test.local --import tsx --test --test-concurrency=1 server/cloud.test.ts server/audit.test.ts server/migration.test.ts server/site-photos.test.ts server/studio-daily.test.ts server/studio-production-role.test.ts server/release.test.ts
npm run test:cloud:e2e -- cloud-tests/home-v31.spec.ts cloud-tests/brief-first-row.spec.ts cloud-tests/studio-daily.spec.ts cloud-tests/workspace-overview.spec.ts
npm run test:deploy
node --env-file=.env.test.local --test deploy/studio-daily/diagnose.test.mjs
npm run build
npm run build:deploy
```

## 修改文件

- 后端：`server/studio-daily.ts`、`database-readiness.ts`、`app.ts`、新增 `release.ts`。
- 首页与控件：`src/components/StudioDaily.tsx`、`StudioKit.tsx`、`BriefPanel.tsx`、`studio-kit.css`、`studio-daily.css`、`brief-row.css`。
- 验收：`cloud-tests/home-v31.spec.ts`、`brief-first-row.spec.ts`、`server/migration.test.ts`、新增 `studio-production-role.test.ts`、`release.test.ts`、截图及几何报告。
- 安全上线：`deploy/native/deploy.sh`、`ops.ts`、`health.sh`、新增 `studio-health.ts` 与相应部署测试；`deploy/studio-daily/diagnose.mjs` 补共享写入依赖检查。
- 开发约束：`AGENTS.md` 新增真实浏览器、几何、数据库权限和交付状态规范。

## 本轮安全更新与回滚

交付消息提供固定本次完整提交 SHA 的一行 Workbench 命令。它从 Git 提取该 SHA 的安装脚本，执行 `deploy.sh --ref FULL_SHA --code-only`，**不调用 `chunmo-update`**。

`--code-only` 要求现有安装、配置、服务账号和证书已存在；若数据库尚不满足要求就停止，不能自行迁移或补权限。跳过数据库配置、HBA、迁移及创建负责人，保留现有 HTTPS 配置。自动使用只读验收，不在生产创建虚构人员、项目、工作要求或照片。保留持久的小程序和下载路由 include。

既有部署机制继续执行互斥锁、固定 SHA 和构建核验、发布前备份、切换发行、服务重启、只读模块检查、备份可恢复性验证。备份恢复测试使用独立校验数据库，不覆盖业务数据库。健康验收核对私有及已配置公网 HTTPS、实际运行 API SHA、模块能力和首页 HTML SHA-256；全部通过后才输出 PASS。不会把原目录存在当作备份验证成功。

切换后的任何失败进入自动回滚：恢复旧 `current` 链接与发布前 Nginx 文件，重启并检查服务和 HTTPS。不会反向迁移、恢复覆盖生产数据库或删除业务记录。恢复失败明确输出 `ROLLBACK_HEALTH_FAILED`，此时保留备份，停止重复更新并发送脱敏错误。Shell 故障注入已验证成功恢复和恢复失败两种情况；**实际阿里云发布／回滚尚未执行**。

更新前建议先保存正在编辑的草稿。代码更新会重启 API，连接会短暂重连；不承诺零停机。更新完成后浏览器 Ctrl+F5，由现有创始人新增／编辑真实工作要求、设定真实值日并刷新及重登，再用员工账号确认只读。只有这些生产操作也成功，才可认定线上问题闭环。若报错，保留页面草稿，发送末尾脱敏错误和实际版本，不发送环境文件、Cookie、员工信息或密钥。
