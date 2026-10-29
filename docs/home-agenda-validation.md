# 全局 UI 一致性与首页事项：实现及验证

日期：2026-10-29（北京时间）。在 `feat/chunmo-project-manager` 开发；开始时工作区干净，本地HEAD及远程跟踪引用为 `3b0b74910a73d24e9d186db8da6236a30b836dc0`。本轮不操作ECS、生产数据库或生产迁移，不清空浏览器资料。

## 实现范围

### 统一布局与工地归属

- 将此前只对首页生效的侧栏、顶栏和原业务编辑器规范共享给子页面，复用现有组件；不另建路由或账号系统。
- 统一内容区桌面边距/宽度、主标题24px及起始位置、字体层级、工具栏和移动触控规则。页面切换回顶部；项目内切换继续保留原行为。
- `ProjectContext` 提供统一绿色细边框、圆角和19px桌面/18px手机工地名称。材料选定工地后也复用此组件；未选工地仍禁止操作。
- 采购的项目列表不再逐条重复工地名；全工作室提醒保留工地标签。看板按项目分组时仅列头显示工地，按状态分组时各卡片仍显示所属工地。调拨的来源/目标等业务必要字段保留。
- 手机偏移经实际测量定位：原首页保存状态行24px、其他页面20px，相差4px。统一最小高度及行高，并固定标题的对齐方式；严格检查所有主要页面的标题坐标、容器宽度、字体和内边距。

### 三个首页事项框

“今日事项、明日提醒、项目备忘”均复用 `BriefPanel`，替代旧的四个首页框。默认三条预览，更多内容原地展开并在内部滚动。桌面基础高度224px、手机236px，三框等宽；空/单条/长列表不会改变列宽、标题位置或相邻卡片对齐。展开按统一上限增加高度。

首页事项区及事项列表不再复制采购卡片。采购原始数据、完成/删除/恢复权限、15天提醒、采购统计、工期关联及日期标记均保留在采购模块、提醒中心、统计入口和每日详情中。没有通过删除业务数据来精简首页。

原“添加每日事项”曾转向采购表单，本轮恢复为真正的事项表单：标题、当前工地、计划日期及可选备注；采购继续使用独立表单和原定截止日期保护。

## 明日提醒的数据规则

不新增表、字段或迁移。使用现有 `Data.notes`：

| 字段            | 用途                               |
| --------------- | ---------------------------------- |
| id / projectId  | 原记录ID及工地归属                 |
| title / content | 事项内容和详细备注                 |
| date            | 用户选择的计划日期                 |
| kind            | 新建沿用施工安排；项目备忘单独展示 |
| done / pinned   | 现有完成和置顶状态                 |

`projectAgenda` 是纯查询：

- 今日：计划日期为当天的记录（含已完成）及尚未完成的逾期事项。
- 明日：计划日期等于当前日期加一个自然日的记录，已完成保留勾选状态。
- 备忘：项目备忘只在备忘框展示，即便旧数据带日期，也不再同时出现在今日。
- 更远日期仍保存在“事项与备忘”，到对应日期再自然进入明日/今日；不复制、不改ID、不自动修改计划日期。
- 新增明日默认下一天；编辑计划日期后，视图同步重新筛选。完成、取消完成、置顶及确认删除均沿用原保存逻辑。
- 旧记录的类别、备注、负责人、独立提醒日期、关联任务等字段继续保留；表单未编辑的字段不会被清除。

沿用现有浏览器当地日历及日期监听：每30秒检查一次，切回页面/获得焦点立即检查。跨月、跨年及闰日通过日历计算，不以固定毫秒数移动数据。关闭页面后不会在后台生成记录，重新打开仍按同一保存数据筛选。

## 安全、数据及权限

未修改服务端API、认证、角色、隐私接口、数据库结构、部署配置、依赖或备份机制。云端仍使用已有workspace API及服务器权限、CSRF、版本冲突检查、审计和15天历史；本地模式仍保存在原IndexedDB结构中。新增记录由用户操作产生，不从采购、库存或考核记录自动复制。

删除前使用原确认组件，取消不写入；确认只移除对应事项，原有审计/15天历史按原规则保留，不删除项目、采购、库存或施工任务。跨天未触发任何保存或删除，已完成记录也不因跨天丢失。

所有测试在本机隔离数据库及新浏览器上下文内进行，不重置原有数据库或用户浏览器数据。旧版本截图/校验清单保持原样；原回归截图改写入临时目录，避免每次测试覆盖已归档的交付证据。

## 实际测试

| 验证               | 实际结果                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| 单元测试           | 99/99，17个文件；包含日期分组、跨年/闰日、项目隔离、旧备忘置顶顺序及源数据不变                  |
| PostgreSQL/API     | 44/44，现有认证、隐私、并发、采购、材料、历史及迁移兼容回归                                     |
| 本地浏览器完整回归 | 87/87，覆盖所有旧功能及新增事项布局/跨天                                                        |
| 云端浏览器完整回归 | 40/40，含三个屏宽下所有主要页面坐标/字体/宽度、真实员工/负责人会话、保存及重新登录              |
| 最终补充浏览器检查 | 4/4；明日计划日期改到今日、再改回明日、跨年继续使用同一个ID，同时重验空/有/长内容               |
| 类型检查及生产构建 | 前后端TypeScript、Vite及API打包通过；保留现有大chunk和Zod注释构建提示，未新增依赖               |
| 差异/资料保护      | 未修改server、deploy、迁移、package/lock或env；旧截图清单保持原样，新截图另存；未部署或操作生产 |

当前没有尚未解决的自动化测试失败。不将实体设备和生产环境尚未执行的验收算作通过。执行日志：`/tmp/chunmo-agenda-delivery-unit.log`、`/tmp/chunmo-agenda-api.log`、`/tmp/chunmo-agenda-final-local.log`、`/tmp/chunmo-agenda-final-cloud.log`、`/tmp/chunmo-agenda-dateedit.log`、`/tmp/chunmo-agenda-build-delivery.log`。

新增覆盖：三个屏宽下空/单条/长列表、同高同宽及标题不跳动、内部滚动和末条编辑、确认删除/取消、完成/恢复、2026年末跨入2027年、闰日、相同ID不复制、采购数据不变、跨项目隔离、员工保存及重新登录、负责人读取、所有主要页面坐标/宽度/字体及弹窗边界。

旧采购测试的入口从首页转到采购管理和提醒中心，仍保留截止日期禁止普通延期、完整历史、统计、15天边界、跨日倒计时、完成保留、项目隔离、工期拖动联动和权限断言。没有通过修改业务结果来制造通过。

本轮遇到并处理的验证问题：

1. 测试最初比较原始旧采购fixture与实际保存数据，原保存逻辑会补齐originalDue/deadlineMode。改为比较前后实际保存的完整采购数据。
2. 标题文本长短不同，自然宽度不应相等；改为检查内容区宽度及标题坐标、字号。
3. 页面标题对齐方式和手机保存状态行高不同造成真实偏移，修复共享样式，不放宽位置断言。
4. 三列CSS网格存在不足一个像素的舍入差异，宽度检查使用小于1px的容差；仍检查同高及内容变化时几何稳定。
5. 原采购编辑/历史回归仍寻找已移除的首页重复卡片；移至真实保留入口后继续验证相同业务规则。

## 截图与人工验收

[打开截图验收页](screenshots/home-agenda/index.html)。均为真实Chromium截图、合成测试资料，不包含生产项目或人员隐私。

- [桌面空状态](screenshots/home-agenda/home-empty-1440.png)、[有事项](screenshots/home-agenda/home-filled-1440.png)、[长列表](screenshots/home-agenda/home-long-1440.png)。
- [手机空状态](screenshots/home-agenda/home-empty-390.png)、[有事项](screenshots/home-agenda/home-filled-390.png)、[长列表](screenshots/home-agenda/home-long-390.png)。
- [采购子页](screenshots/home-agenda/page-purchases-1440.png)、[事项子页](screenshots/home-agenda/page-notes-1440.png)、[记录看板](screenshots/home-agenda/page-records-1440.png)、[提醒中心](screenshots/home-agenda/page-reminders-1440.png)、[材料管理](screenshots/home-agenda/page-materials-1440.png)、[人员管理](screenshots/home-agenda/page-people-1440.png)、[已完工](screenshots/home-agenda/page-completed-1440.png)。
- [手机明日事项表单](screenshots/home-agenda/tomorrow-editor-390.png)。

负责人验收：切换各主页面检查标题/边距；检查绿色工地框与跨工地标签；分别在空/有/长内容中展开、滚动、编辑、完成、确认删除；为明日录一条后刷新/重新登录；切工地确认隔离；次日核对同一个ID进入今日，采购及库存不变。

尚需人工确认品牌观感及实体Windows、iPhone/Android、Safari/微信浏览器。自动化含真实Chromium手机尺寸及原有触控回归，不冒充实体设备验收。本轮不部署，上线后的最终效果需负责人确认后另行安排。

## 文件清单

业务/组件：`src/App.tsx`、`src/lib/agenda.ts`、`src/components/ProjectContext.tsx`、`BriefPanel.tsx`、`Forms.tsx`、`PurchaseCard.tsx`、`MaterialsPanel.tsx`、`RecordBoard.tsx`。

共享样式：`src/homepage.css`、`src/workbench.css`。

测试：`src/lib/agenda.test.ts`、`tests/agenda-layout.spec.ts`、`homepage.spec.ts`、`history.spec.ts`、`stage2.spec.ts`、`stage4.spec.ts`、`ui-refinement.spec.ts`、`v11-workflows.spec.ts`、`v4-layout.spec.ts`；`cloud-tests/home-agenda.spec.ts`、`experience-v11.spec.ts`、`record-board.spec.ts`、`workbench-visual.spec.ts`。

说明/证据：本说明、`PROJECT_GUIDE.md`、`docs/screenshots/home-agenda/`。
