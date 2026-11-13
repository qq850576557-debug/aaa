# 春茉移动工作台开发候选

**不是生产更新包，不要对该分支运行chunmo-update，不要覆盖/撤回正在审核的1.2.2。**

当前独立分支feat/chunmo-miniprogram-workbench，基线c140cc5。工作台仍使用原AppID wxb48a7abb3858a252，不是第二个小程序。生产网站、API、1.2.2下载ZIP、已安装sidecar及旧PWA均未部署变更。新候选源码位于miniprogram/chunmo-photo；微信工具项目名增加candidate标识。导入候选只用于开发，不点击上传/提交审核，直至创始人批准。

## 功能与对照

| 功能 | 电脑/旧手机真实来源 | 小程序候选 |
|---|---|---|
| 今日、明日 | categorizedAgenda、采购purchaseDue/Complete | 相同业务函数生成日期投影，另提供逾期；今日/明日遵守原手机端未完成+精确日期规则，逾期单列，不自行创造15天截断 |
| 项目 | workspace_state.data.projects、唯一ID | 项目筛选使用ID，重排后不按名称/旧索引错配 |
| 采购 | workspace_state.data.purchases；原savePurchase/makeWorkspaceDelta；原purchase_record/purchase_action审计 | 查看、期限/剩余天数、规格/数量、负责人、四状态、新增/编辑；不复制成事项；已有mentionIds保留 |
| 事项 | work_record；/api/records和history | 项目/日期筛选、新增/编辑、跟进/备注、完成状态、原版本校验与处理历史；旧状态可读不批量重写 |
| 与我相关 | 既有owner及mentionIds | 视图筛选，不当作授权边界；实际协作权限与原工作室一致，不擅自新增项目ACL |
| 工地拍照 | 1.2.2现有照片页面/PhotoStore/PhotoQueue | 保持原GPS、高德、像素、水印、相册回执和恢复；仅增加进入照片功能的tab页，不重写相机 |
| 我的 | 原身份与账号空间 | 当前账号、待同步数量、本机草稿/冲突归档复制、旧照片恢复、退出不清数据 |
| 离线与保存 | 原事务/签名基线/请求回执 | 命令先本机持久化，再发送；待同步不冒充云端成功；网络恢复/重开重试同一requestId；400/403/404/409等阻止自动重放，草稿可复制和保留归档后核对 |
| 会话 | 原Cookie/CSRF/身份接口 | 内存中会话可重新核验；不把员工Cookie/密码放wx永久存储，冷启动可能仍需登录；不是第二套账号 |

旧notes、legacy_record_link不迁移、不删除。与原手机管理列表一致，工作台采购/事项列表不自动把legacy notes转换成新事项。完整甘特图、人员档案、权限设置、版本管理仍属于电脑端；src/mobile全部保留，其余未引用候选PhotoAssistant也暂不删除，因为旧恢复路径尚未盘点验收。

## 结构与单一规则来源

src/lib/mini-workbench.ts薄组合层直接导入model/procurement/agenda/records/workspace-delta；scripts/build-mini-workbench.mjs构建为微信可require的shared-workbench.js，manifest记录源文件和输出哈希；check脚本可检测共享包过期。不要手工编辑生成包，不另抄状态/日期规则。平台相机及文件API仍留在各自适配代码中，不强行把浏览器/微信设备代码混用。

server/miniprogram-photo及sidecar仅新增显式白名单转发：GET/PUT工作空间（PUT仅一条采购record delta且不允许删除）、GET/POST事项、PUT单条事项、GET事项history。不开放账号管理、整空间快照写入、项目/工期修改或任意代理。六个原拍照接口保持兼容。

新增能力默认关闭，需独立sidecar的CHUNMO_MINI_WORKBENCH_ENABLED=1；微信proof之后仍必须有原员工Cookie和CSRF，所有写操作实际进入原权限/事务/CAS/审计及SSE通道。适配器没有数据库连接凭据，没有新表或迁移。工作空间读取沿用原受权接口，当前内存响应上限16MiB；大工作室实际规模需隔离副本验证，不能用小夹具证明无限规模。

工作草稿存储键chunmo-workbench-v1:<workspace>:<account>。不存会话密钥，不清理照片。多个表单草稿分别保留；冲突提交须用户确认归档后才能解除该记录的队列锁，归档可从“我的”复制；无网络/错误JSON/缺失回执时保留原提交。切账号时旧队列不自动发送给新账号；微信凭据刷新前后均检查身份。未做全量业务离线缓存，冷启动断网只能保留已有草稿/命令，不保证离线读取尚未加载的数据。

## 开发和验证

依赖沿用现有package-lock，不新增npm包。使用隔离_test数据库（本地测试配置，绝不填生产连接）：

```bash
npm run build:mini-workbench
npm run check:mini-workbench
npm run build
npm test
npm run test:api
npm run test:deploy
npm test --prefix miniprogram/chunmo-photo
npm run test:workbench:api
node scripts/test-mini-workbench-legacy.mjs
npx playwright test --config playwright.cloud.config.ts cloud-tests/mini-workbench.spec.ts
npm run test:mobile
npm run build:workbench-sidecar
```

候选独立服务产物仅在忽略目录dist-workbench/sidecar.cjs及manifest.json，默认不安装、不启用功能；**不要执行build-miniprogram-sidecar覆盖旧runtime.cjs**。原deploy/miniprogram/runtime.*与source-download发行常量保持原字节，旧首装脚本不能拿来更新新候选。

实际验证细节见validation.md，发布前事项见release-plan.md；审计和文件删除/迁移记录见audit.md、retired-files.txt；源码体积与构建测量见measurement.json。screenshots下模板图片来自实际WXML/WXSS的Chromium测试渲染，不是微信/相机实机；desktop-closed-loop.png是实际电脑浏览器闭环截图。

## 回退

所有变更分阶段提交在独立分支。现阶段放弃候选只需不合并/不部署；原开发分支和审核1.2.2不动。需要取回退役工程可从基线git restore指定源文件或revert退役提交，不reset/改写历史。未执行任何服务器回滚，因为没有执行服务器变更。将来候选服务先独立部署、保留旧路由和旧服务，再经审批切换，关闭候选开关不删除已提交到同一数据库的真实业务记录。
