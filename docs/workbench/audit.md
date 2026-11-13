# 代码审计与分阶段变更范围

基线 c140cc5a4a5cc4cf71ae0262929a2c238de880a5（已核对远程开发分支）。本轮独立分支feat/chunmo-miniprogram-workbench，用户本轮独立分支要求优先于AGENTS.md原分支约定。1.2.2提交76eff49及其源码ZIP保持固定，不修改source-download发布常量、不执行服务器安装、不上传审核。

## 审计证据及处理

| 路径 | 实际用途/引用核查 | 决定及影响 | 回退 |
|---|---|---|---|
| native/android | Gradle/CameraX/MediaStore独立工程；src、server、miniprogram均无运行时导入；scripts/native/contracts有品牌/API静态比较 | 按本轮授权删除跟踪工程。原始Logo与已验收样本保留；不删除忽略的本地构建缓存、不卸载手机、不删服务器APK | 从基线git恢复或revert退役提交 |
| native/harmony | 独立ArkTS工程；其纯Protocol.ets被contracts动态编译比较 | 先迁移纯协议比较夹具，再删除独立工程 | 同上 |
| native/shared、samples、validation、releases | 协议指纹、截图、构建结果及SHA，是历史验证依据 | 分别迁至shared/photo、docs/archive/native；保留真实历史，不将模拟器结果宣称真机验收 | git mv逆转 |
| native/release-tools、deploy/apk-download/workbench.sh | 旧原生客户端专用打包及提取旧APK脚本，无新运行时引用 | 删除专属源脚本，既有网站下载文件不动 | 基线恢复 |
| deploy/apk-download/publish.py | source-download/publish.py、miniprogram/install.py通过固定git show动态复用configure解析器 | 保留！它不仅是APK脚本；以后可独立抽取解析器，但本轮不破坏已验证安装脚本 | 无变更 |
| deploy/native | package scripts build:deploy/test:deploy、服务器备份恢复工具引用 | 保留，是服务器原生部署工具，与退役App无关 | 无变更 |
| scripts/verify-native.mjs | 验证argon2、esbuild、sharp的原生依赖，生产发布仍需要 | 保留，不按native关键词删除 | 无变更 |
| src/mobile、photo-*、public/sw.js | MobileAssistant动态import QuickPhoto；旧PWA恢复/暂存/导出有真实入口 | 全保留，未验收新工作台前不切换入口，不清理IndexedDB或照片 | 无变更 |
| server/miniprogram-* | 原员工Cookie/CSRF/Origin之上的微信凭据及回环适配 | 默认保持拍照白名单；新工作台能力必须显式启用，复用原API，不新增业务表 | 关闭新开关/回退新适配源码 |
| src/lib/model、procurement、agenda、records、workspace-delta | 电脑及手机版已有真实业务定义、期限计算和CAS协议 | 抽成可构建的小程序公共业务包，源定义不重复；不改业务口径 | 回退新入口/生成器 |
| public/brand/source、miniprogram/assets | 四份原稿SHA相同611a63cc...（baseline.json及品牌测试） | 原稿保留，App专属副本随退役工程移除；包内副本仍用于微信离线水印 | 基线恢复 |
| docs历史、发行记录 | 审核/迁移依据；文件时间旧不代表无用 | 仅归档退役原生记录，其他不批量删除 | git mv逆转 |
| package.json | 13运行依赖、15开发依赖；React/pg/idb/sharp等仍有源代码导入或构建脚本 | 暂不删依赖，无证据判定未用的不删 | 无变更 |

搜索范围包括src/server/miniprogram的运行时导入、package scripts、deploy中git show动态引用、scripts测试入口。跟踪文件中发现Gradle wrapper JAR（随工程移除），未发现当前跟踪APK/HAP/签名证书。历史Git对象可能仍有早期二进制，不重写历史。未通过打印env/密钥文件做“审计”。

## 数据映射与保护

- 项目、采购仍在workspace_state.data；采购审计purchase_record/purchase_action继续由原workspace保存事务维护。
- 事项仍在work_record/record_history/record_submission；旧notes及legacy_record_link继续保留和读取，不自动转换。
- 新客户端仅映射既有API和record IDs；不新建业务表，不执行迁移。服务器实际业务数量、旧PWA照片/草稿数量不可访问，标记未核查，测试数据不代表生产盘点。
- 已安装App沙箱、员工相册、旧浏览器IndexedDB均不受仓库git rm影响；旧入口只有创始人验收通过后另行调整。

## 目录边界

src/电脑完整界面及旧mobile兼容入口；miniprogram/chunmo-photo/同AppID候选原生工作台；server/现有API和传输适配；shared/photo/保留照片协议及测试夹具；src/lib/共享业务源；public/brand/品牌源；server/migrations/原迁移；deploy/服务器工具；docs/workbench/本轮报告；docs/archive/native/退役历史证据。

测量基准见baseline.json。源码与资源仅统计git跟踪的实际字节，不等于压缩传输、Git对象或服务器可释放空间。新旧构建输出另记结果，不借清缓存制造节省数字。
