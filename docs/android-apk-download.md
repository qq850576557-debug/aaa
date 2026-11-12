# Android 测试 APK：网站下载交付

2026-11-12。本轮仅交付原已测试包，**没有重新构建 APK 或整套管理系统，没有连接或部署生产服务器**。

## 已取得并核验的 APK

- 版本：`1.0.0-internal`，versionCode `1`，包名 `cn.chmsj.photo`。
- Android 10 / API29 及以上；Debug 测试签名，不是正式发行版，不是 HarmonyOS 原生 HAP。
- 字节数：`11030504`（11.03 MB / 10.52 MiB）。
- SHA-256：`f6a1046dbd7b66125971573b16b435d31b34bc1f45e1d12543d0d8b7859a4d8d`。
- 签名证书 SHA-256：`011aa52c0ad4ee183a42fc34542d312ff924f6ef2ed22ec6bb340451f8ba6501`。
- 开发环境原文件：`native/android/app/build/outputs/apk/debug/app-debug.apk`。
- [实际取得并完整下载核验的过渡来源](https://raw.githubusercontent.com/qq850576557-debug/aaa/2756068e6ce7f6f39a90c75610d24e9479b13f0d/native/releases/chunmo-photo-1.0.0-debug.apk)。固定旧提交中的原字节，不是重新构建。公网响应 200、长度正确，完整 GET 后 SHA 与本机测试 APK 相同；raw 来源 MIME 为 `application/octet-stream`，阿里云正式下载入口配置专用 APK MIME。

当前分支停止追踪 APK 二进制，忽略后续 `native/releases/*.apk`；没有重写旧 Git 历史。过渡来源保留在既有提交中，后续包宜作为受控 Release 资产分发，不能继续往源码历史新增二进制。当前环境 GitHub CLI 登录不可用，未创建或冒称已创建 GitHub Release。

## 当前边界

当前环境无阿里云 SSH 身份或连接配置。访问 `https://chmsj.cn/` 被开发环境出站代理拒绝（CONNECT 403），该响应**不是网站返回的状态，不能据此判断网站故障**。当前无法核实该站实际证书、运行配置及健康状态，也没有在服务器发布文件。

下面是待 Workbench 执行的实际方案。脚本从服务器现有 `/etc/chunmo-staging/public-https.json` 读取域名，并核对运行中 Nginx 的配置路径、真实 DNS、现有 443 TLS server、证书有效期、系统 CA 信任与域名校验、原网站首页及 `/api/health`。不凭 App 的默认 API 地址认定域名可用。布局、证书或健康检查不符合时停止，不购买或开通任何资源。

## 在阿里云 Workbench 执行

使用已有 ECS 的 root 终端。以下只 fetch 和读取 Git 对象，不 checkout、pull、重置工作区，也不执行 `/usr/local/sbin/chunmo-update`。默认源码库来自现有更新脚本：`/opt/chunmo-source`；自定义安装可通过 `CHUNMO_SOURCE_REPO` 指定实际路径。

```bash
set -Eeuo pipefail
repo=${CHUNMO_SOURCE_REPO:-/opt/chunmo-source}
git -C "$repo" fetch origin refs/heads/feat/chunmo-project-manager:refs/remotes/origin/feat/chunmo-project-manager
delivery_commit=$(git -C "$repo" rev-parse refs/remotes/origin/feat/chunmo-project-manager)
task_dir=$(mktemp -d /tmp/chunmo-apk-delivery.XXXXXXXX)
git -C "$repo" archive "$delivery_commit" deploy/apk-download public/brand/source/chunmo-original-circle.png | tar -x -C "$task_dir"
CHUNMO_SOURCE_REPO="$repo" bash "$task_dir/deploy/apk-download/workbench.sh"
```

最终聊天中的命令将 `delivery_commit` 固定为实际交付 SHA，便于审核和复现。若希望先做只读检查，可在最后一行末尾加 `--check-only`；本次已授权发布下载，不必为了重复批准而停在检查模式。

脚本优先通过现有 Git 对象提取已测试 APK。若对象不可得，才使用上面的固定 HTTPS 来源；必须核对大小和 SHA 才发布。如服务器无法访问 GitHub，使用 Workbench 安全文件传输上传原 APK，随后运行已提取目录的 `publish.py --apk /实际上传路径/app-debug.apk --logo "$task_dir/public/brand/source/chunmo-original-circle.png"`。不能拿新构建或未知包替换通过校验的包。

## 服务器变更范围与持久目录

| 路径                                                           | 用途                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `/var/lib/chunmo-downloads/releases/1.0.0-debug-f6a1046dbd7b/` | 原 APK、原稿圆形 Logo、手机页、CSS、校验和、非敏感发布信息 |
| `/var/lib/chunmo-downloads/current`                            | 原子切换的下载目录指针；独立于管理系统发行目录             |
| `/var/lib/chunmo-downloads/backups/时间戳/`                    | 仅 root 可读的本次 Nginx、SW、旧下载配置和旧指针备份       |
| `/etc/chunmo-staging/downloads/apk.conf`                       | 仅 `/download` 路由的静态配置                              |
| `/opt/chunmo-staging/nginx.conf`                               | 在现有公网 443 server 增加可选 include；保留原路由和头部   |
| `/opt/chunmo-staging/current/dist/sw.js`                       | 仅增加 `/download` 路径排除，避免下载页污染 PWA 首页缓存   |

Nginx 生成器也包含同一可选 wildcard include，后续正常更新不会因重生成配置而丢掉下载入口。未安装下载功能的旧服务器上，空 wildcard 不改变现有行为。

发布前沿用现有部署锁，避免与更新脚本并发。不读写账号、数据库、API 逻辑、用户照片、IndexedDB 或本地草稿。不变更端口、TLS 协议、证书或私钥、防火墙及安全组，不重启 API。Nginx 以原服务身份先 `-t`，然后只 HUP 平滑重载。新增 location 显式保留原有效安全响应头，防止 Nginx `add_header` 继承规则意外丢失 CSP/HSTS 等配置。

发布或验证失败时自动恢复这次修改的配置、SW 与下载指针，再检查和重载旧配置；新 APK 文件仍保留。终端输出备份目录。如进程被强杀或机器断电导致未完成自动回滚，应先检查备份及现行文件，按具体差异恢复，不能覆盖之后其他人的新配置。

## 成功后的验收地址

若服务器实际配置仍为 `https://chmsj.cn`，成功后地址为：

- 手机下载页：`https://chmsj.cn/download/`
- APK：`https://chmsj.cn/download/chunmo-photo-test.apk`
- 校验和：`https://chmsj.cn/download/SHA256SUMS`

**这些是待发布目标，尚未由 Codex 验证公网可达，不能作为“已经部署”的结果。** 以脚本最终 `PASS` 后输出的实际地址为准；脚本检测到其他有效域名会使用该域名。

脚本通过服务器本地解析和公网 DNS 两条路径实际下载 APK，验证 SHA、GET/HEAD、MIME、长度、206 Range、页面和原网站/API 健康。服务器自身的公网访问不等于手机网络验证，执行成功后还需在手机移动网络打开下载页、下载和安装测试。可人工复核：

```bash
curl -fSI https://chmsj.cn/download/chunmo-photo-test.apk
curl -fS --range 0-31 -D - https://chmsj.cn/download/chunmo-photo-test.apk -o /tmp/chunmo-apk-first32
curl -fS https://chmsj.cn/download/chunmo-photo-test.apk -o /tmp/chunmo-photo-downloaded.apk
sha256sum /tmp/chunmo-photo-downloaded.apk
stat -c '%s' /tmp/chunmo-photo-downloaded.apk
systemctl is-active chunmo-staging-api
systemctl is-active chunmo-staging-web
curl -fS https://chmsj.cn/api/health
```

安装：在安卓系统浏览器打开下载页 → 下载 → 打开 APK → 仅按系统提示允许该浏览器安装应用 → 安装后使用原账号登录。不要关闭全局安全防护。微信内下载受限时用系统浏览器。更新应覆盖安装，不卸载旧应用或清除其数据，避免删除待保存照片。

## 签名一致性

本脚本只接受已核验 SHA 的这个测试包，未知包不能覆盖上线。同一 App 后续升级必须保留包名 `cn.chmsj.photo`、同一签名证书及相应私钥，递增 versionCode。常规新环境自动生成的 debug key **不能**代替当前 key。现有私钥已保留到工作区被 Git 忽略的 `native/android/signing/existing-internal-debug.keystore`（目录0700、文件0600），未上传网站、Git 或聊天；应另行通过工作室受控密钥保管渠道备份，后续构建显式使用这一签名。**本页及安装包发布脚本不会复制 signing 目录。** 切换正式签名不能直接替换已经分发的签名。

## 本轮实际验证

- 原包 apksigner 验证通过，固定来源实际 GET 后字节与 SHA 一致。
- Python 发布边界测试：10 项，覆盖错误 APK 拒绝、只改目标 TLS server、重复执行、原安全头、原子文件权限、缓存排除、只读前检、平滑重载后的全套检查重试，以及注入失败后的配置/SW/指针回滚。
- 原 HTTPS/部署回归：15 项通过。
- 独立 Nginx 1.28 容器：使用测试 CA 正常校验证书，验证静态 APK 下载 MIME、Content-Disposition、长度、SHA、HEAD、Range 206、安全头和原首页/API 测试路由不变。没有使用 `curl -k`。
- Chromium 手机视口 320 / 390 / 768：无横向溢出，点击下载取得真实文件并核对 SHA；原始 Logo，无重绘。
- 未重新构建 APK 或管理系统。没有阿里云配置/健康检查结果，没有安卓实机浏览器安装验收；上述隔离测试不冒充生产或实机结果。

复现：`python3 -m unittest discover -s deploy/apk-download -p 'test_*.py' -v`；`node --import tsx --test deploy/native/deploy.test.ts deploy/native/domain.test.ts deploy/native/public.test.ts`；已有本地 Docker 镜像 `nginx:1.28-alpine` 时执行 `python3 deploy/apk-download/integration.py`。
