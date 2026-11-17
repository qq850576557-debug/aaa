# 电脑首页局部优化验收 · 2026-11-17

本轮仅修改 `StudioDaily.tsx`、`studio-kit.css`、`studio-daily.css` 及相关浏览器测试／交付证据。业务计算、权限、API、数据库、微信小程序和其他客户端源码均未变更。

- 今日／明日的所有事项及采购卡片复用 `ProjectSurface` 已有的工地主题浅色与边框；内部按钮背景透明，采购四项状态标签及完成弱化不变，无需新建颜色存储或复制数据。
- 编辑值日预览采用统一三列 Grid：姓名、日期、状态。姓名允许换行，日期固定列宽，状态靠右，日期使用等宽数字。
- 查看排班复用 `rotationPreview` 展示当前、下一轮、下下轮及计划日期；不重复显示同一近期轮次，保留原周切换、历史实际完成日期及更远周计划查询。
- 首页值日卡片使用基于 `#244e42` 的深绿线性渐变和柔和径向亮部，白字、半透明按钮、22px 圆角；沿用已有等高 Grid，不写死卡片高度。按钮键盘焦点清晰可见。

## 实际浏览器验收

真实 Chromium + 本机隔离测试数据库。使用三种不同长度的姓名、三个不同主题工地、今日／明日各 15 张事项／采购卡片、四项采购状态、3／7 天轮换预览和员工只读账号。没有向生产写入测试数据。

| 窗口宽度 | 首页双卡顶部差 | 首页双卡底部差 | 预览三列边界最大差 | 三轮排班列边界最大差 | 横向溢出 |
| -------- | -------------- | -------------- | ------------------ | -------------------- | -------- |
| 1280px   | 0px            | 0px            | 0px                | 0px                  | 无       |
| 1440px   | 0px            | 0px            | 0px                | 0px                  | 无       |
| 1920px   | 0px            | 0px            | 0px                | 0px                  | 无       |
| 2560px   | 0px            | 0px            | 0px                | 0px                  | 无       |

[完整坐标记录](screenshots/home-polish/geometry.json)。另外回归原有 V3.1 的空数据／长文本、展开／收起、菜单往返、刷新、保存及员工权限用例。

实际打开检查的截图：

- [首页](screenshots/home-polish/home.png)
- [品牌绿值日卡片及等高布局](screenshots/home-polish/studio-cards.png)
- [三列编辑预览](screenshots/home-polish/duty-editor.png)
- [三轮排班](screenshots/home-polish/schedule.png)
- [不同工地主题事项](screenshots/home-polish/project-colors.png)

## 测试与范围

- 单元测试：48 文件、231 项通过。
- 桌面真实浏览器：11 项通过，包含新验收及原首页／值日／第一排展开收起回归。
- 最后截图捕获方式调整后，新验收再运行一次通过。
- `npm run build` 通过。构建仍有原有非阻断性分包提示。
- 修正旧浏览器用例中的固定日期，改为当前日期的相对日期，避免跨周导致历史记录断言误报。未改业务日期规则。

复测：

```bash
npm test
npm run test:cloud:e2e -- cloud-tests/home-polish.spec.ts cloud-tests/home-v31.spec.ts cloud-tests/brief-first-row.spec.ts cloud-tests/studio-daily.spec.ts
npm run build
```

## 发布状态与操作

本轮已完成源码和隔离环境验收，尚未执行阿里云生产发布。按既有流程提交 `feat/chunmo-project-manager`，交付消息附本次固定完整 SHA 的 Workbench 一行命令，由负责人执行确认发布。

复用上轮 `deploy.sh --ref FULL_SHA --code-only`：固定提交、互斥锁、备份、保留现有配置、跳过迁移和授权修改、只读验收、核对前端及 API 版本；切换后失败尝试恢复旧发行和 Nginx 文件。发布会短暂重启 API。无需重新上传小程序，也不执行 `chunmo-update`。

出现 `ROLLBACK_HEALTH_FAILED` 时停止重复更新并保留备份与脱敏错误，不自行清库或恢复覆盖业务数据库。只有服务器实际输出最终 PASS、刷新后界面和保存检查正常，才视为生产验收完成。
