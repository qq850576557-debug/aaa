# 紧凑界面、团队名片与材料模块验收（2026-10-28）

## 变更

- `src/compact.css`、`src/main.tsx`：缩减桌面留白、面板、按钮及弹层尺寸，主要表面约缩30%，保留可读字体、手机输入16px及触摸尺寸，未对甘特几何使用全局zoom。
- `AssessmentPanel.tsx`：授权勾选框与两行账号文字同一栅格居中；日期及其他筛选字段等高对齐。
- `MemberCards.tsx`、`member-cards.css`、`src/lib/member-cards.ts`、`server/member-cards.ts`：通讯录团队卡片，沿用真实头像上传，中文名/英文名/双语部门、SJD春茉页脚；部门负责人维护、停用保留与引用删除保护。入职日期本人可设置，仅本人及负责人API返回，其他员工接口不返回字段，业务JSON/普通操作日志不含日期值。
- `MaterialsPanel.tsx`、`materials.css`、`src/lib/materials.ts`、`server/materials.ts`、`App.tsx`：7个材料子页面、精确库存及成本核算、同类历史统计、预警闭环、可追溯趋势图和CSV，详情见[材料规则](material-assets-v1.md)。
- `CloudControl.tsx`：名片挂载及会话展示名称同步、说明完整备份边界。
- `server/app.ts`：受真实认证保护的路由及审计类别注册。
- 增量迁移007/008、`scripts/cloud-provision.ts`、`deploy/native/admin.ts`及批准校验表：测试及正式部署最小权限/迁移；没有修改现有HTTPS15001、Nginx、PostgreSQL监听或部署/回滚步骤。
- `src/lib/materials.test.ts`、`server/cloud.test.ts`、`cloud-tests/cards-compact.spec.ts`、`cloud-tests/materials.spec.ts`、`cloud-tests/account-grants.spec.ts`：数量/成本、并发、权限、隐私、项目恢复及真实浏览器保存/导出；旧`tests/workspace.spec.ts`仅增加拖放前hover确保元素在可操作视口，所有业务断言保留。

## 实际运行结果

| 检查                                                             | 实际结果                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                       | 14个文件、88/88通过，含12项材料数量/成本/比较与恢复规则测试                                                    |
| `npm run test:api`                                               | 39/39通过：真实PostgreSQL、认证/权限/会话、并发、隐私及增量迁移；最后材料权限/筛选调整后3项材料API定向再验通过 |
| `npm run test:e2e -- --output=/tmp/chunmo-local-validated`       | 73/73通过，覆盖原工期拖动/排序/合并、采购、持久化、PNG和手机触摸                                               |
| `npm run test:cloud:e2e -- --output=/tmp/chunmo-cloud-validated` | 22/22通过，含1440px桌面及390px手机名片、考核、材料全流程与双会话同步                                           |
| 上传头像在团队名片显示定向再验                                   | 桌面、手机2/2通过，图片地址与本人已保存头像一致                                                                |
| 最终材料趋势图/统计表追溯再验                                    | 桌面、手机2/2通过；点击图表与统计行使用同样的项目类型、规格及月份筛选，CSV、刷新持久化均通过                   |
| `npm run build` / `npm run build:deploy`                         | 前后端TypeScript、Vite、API和部署工具均构建成功                                                                |
| `npm run test:deploy`                                            | 21/21通过，含HTTPS证书验证、配置保留、备份前置与回滚测试                                                       |
| 加密数据库备份/新隔离库恢复                                      | 两轮成功，9张新表正样本、私密入职日期、精确数量/微元成本、授权、追加历史及表行数均核对一致；原库和恢复库保留   |
| Prettier定向检查 / `git diff --check`                            | 通过                                                                                                           |

首次并行运行两套浏览器测试时，默认输出目录相同造成追踪文件互删，分别改用上表独立输出目录后全量通过。考核授权两行排版曾改变无障碍名称，已在组件补明确label，原权限断言保留并通过。浏览器还捕获了材料表单选择规格时混入无关字段的真实保存错误，已修复并实际保存、刷新及下载验证，没有只修改断言。

本轮观察过桌面/手机页面截图。构建保留非阻断提示：已有Zod注释注解警告、主JS约585kB（gzip约184kB）大小提示；没有为了消除提示扩展架构或加入新依赖。未执行ECS部署，不将生产检查算作通过。

## 限制

- 桌面和390px手机尺寸使用实际Chromium自动化，并非实体Windows/iPhone设备；需上线前再由真实设备查看。头像复用原256px处理，不宣称高清人像存储。
- 本地/IndexedDB模式不实现名片/材料权限；仅云端使用真实账号和PostgreSQL。
- 统计由人工核实进度、基数、单价及凭据决定；样本不足不产生精确概率，不自动处罚、扣款或改人员评价。
- 未开发经历史校准概率模型、跨工作室仓库或成本退款财务模块；未接入微信、PWA或现场拍照。
- 原生产系统、历史备份和本地项目数据均未接触或清空。
