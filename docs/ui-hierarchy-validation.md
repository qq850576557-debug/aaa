# 页面结构与视觉层级优化：交付核验

日期：2026-10-29（北京时间）。分支 `feat/chunmo-project-manager`；开始时工作区干净，基线 `1c6f1a5986d65d2506258c7353107feb92b7088c`。

## 实际实现

- 删除主内容上方的云空间/服务端保存常驻提示及其整个布局容器，标题与内容上移。备份移为顶栏图标，原侧栏入口继续保留。正常保存状态仅供无障碍读取；保存中、失败、冲突及撤销仍可见，原重试、紧急备份和冲突恢复流程不变。
- 看板副标题与标题并排，新增记录后紧接短搜索框，筛选、分组、排序和刷新归入统一工具栏。桌面控件实际高度36px，手机44px，自适应换行。搜索宽度上限210px。
- 六组项目主题依次使用浅绿、浅蓝、浅橙、浅紫、浅青、浅粉。列底色、边框和新增区域同色系，标题标签更深；筛选单个项目后仍保持该项目的主题。
- 删除独立“事项与备忘”导航和页面。旧数据未删除、未自动转换为不同类型：既有今日/明日/备忘记录在“记录状态看板 → 日常记录”中复用原查看、搜索、编辑、完成、置顶及确认删除功能，并支持选择工地。首页“全部事项”和“查看日常记录”直接打开、定位此区域。
- 采购操作组成规整按钮组：状态下拉、描边编辑、绿色完成、低饱和红色删除、轻量历史。采购历史和责任时间保持原入口与权限，完成/删除仍执行原有操作，不产生库存。
- 统计卡片与今日/明日/备忘卡片分别使用浅色圆角分组外框，内层仍保留原卡片、固定基础高度及展开滚动。
- 人员卡片使用圆润细边框、工种色标签和姓名入口。点击姓名打开原人员编辑器，原分配、项目履历及删除入口保留。新增“工种配色”复用原选色器；多工种人员以第一个工种决定外框，各工种标签独立着色。

人员配色保存到 `chunmo-people-card-colors` 浏览器外观偏好中，按工种ID（旧记录按原文字）关联。刷新保留；不会同步给其他设备、写入workspace、改变工期颜色、触发业务历史或修改数据库。不能保存非法颜色；浏览器拒绝存储时明确显示失败，取消不写入。

## 修改文件

应用代码与样式（6个）：

- `src/App.tsx`
- `src/components/RecordBoard.tsx`
- `src/components/record-board.css`
- `src/components/PurchaseCard.tsx`
- `src/components/PeoplePanel.tsx`
- `src/workbench.css`

新增浏览器验收：`tests/ui-hierarchy.spec.ts`、`cloud-tests/ui-hierarchy.spec.ts`。

更新保留功能的原测试入口：`tests/homepage.spec.ts`、`tests/workspace.spec.ts`、`tests/v4-layout.spec.ts`、`cloud-tests/collaboration.spec.ts`、`cloud-tests/v11-accounts.spec.ts`、`cloud-tests/home-agenda.spec.ts`。`tests/agenda-layout.spec.ts` 和云端首页测试的常规截图移至临时输出目录，避免覆盖旧交付证据。

本说明及 `docs/screenshots/ui-hierarchy/` 为本轮验证证据；没有修改服务端、数据库模型/迁移、认证权限、依赖、环境配置或部署脚本。没有操作ECS、生产数据库、已有备份或现有用户的IndexedDB。

## 测试记录

| 项目               | 结果                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| 单元测试           | 99/99，17个文件                                                          |
| 本地浏览器完整回归 | 92/92；涵盖原采购、任务拖动、人员分配、历史、触屏、失败重试等            |
| 最终相关本地浏览器 | 24/24；补充日常记录定位、选色弹窗边界与持久化，业务数据前后相同          |
| PostgreSQL/API     | 执行中                                                                   |
| 云端浏览器完整回归 | 执行中                                                                   |
| 类型检查及生产构建 | 前端TypeScript/Vite与API TypeScript/esbuild通过；保留原大chunk及注释提示 |

新增前端测试验证1440、1280、390、320像素；云端看板测试验证1440、1280、390像素。实际使用Chromium、真实受保护API及隔离的本机测试工作室，未用前端模拟替代权限。原有触屏测试使用移动设备与触控上下文。

本轮定位并处理过的失败：

1. 首轮两套Playwright共用输出目录，造成trace文件被另一套清理，两个测试在上下文关闭时报ENOENT；改用各自临时输出目录后相关测试通过，未修改业务逻辑。
2. 新增严格布局检查发现按钮受继承行高影响，比输入框高约2px；改为明确的统一实际高度。手机搜索框原填满剩余宽度，超过约定的短搜索尺寸，增加210px上限。
3. 新增抽屉测试最初在入场动画中途读取坐标。改为等待动画结束后严格检查右边界，未放宽边界或关闭原动效。

当前无未解决的自动化测试失败。常规回归截图默认写入临时目录；设置 `CHUNMO_UI_VISUAL_OUTPUT=docs/screenshots/ui-hierarchy` 后可重新生成本轮交付截图。

主要日志位于 `/tmp/chunmo-ui-hierarchy-unit.log`、`/tmp/chunmo-ui-hierarchy-local.log`、`/tmp/chunmo-ui-hierarchy-local-final-focused.log`、`/tmp/chunmo-ui-hierarchy-api.log`、`/tmp/chunmo-ui-hierarchy-cloud-final.log`、`/tmp/chunmo-ui-hierarchy-build-final.log`。最终截图复测另有5/5本地及3/3云端测试通过，日志为`/tmp/chunmo-ui-hierarchy-local-capture.log`、`/tmp/chunmo-ui-hierarchy-cloud-capture.log`。

## 截图与人工验收

[打开本轮真实截图](screenshots/ui-hierarchy/index.html)。均为隔离测试中的合成项目、人员及账号，不含生产资料。旧首页与看板截图保留原样；本轮22张PNG均有`manifest.json`和`SHA256SUMS`校验信息。

请确认：六套看板主题的区分度、首页浅色外框强弱、人员卡片比例及当前浏览器配色的保存范围。实体Windows、iPhone/Android、Safari和微信内置浏览器仍需人工体验；Chromium手机尺寸/触控测试不代表实体设备验收。

本轮没有生产部署或生产迁移，不代表线上页面已经改变。
