# 小程序源码网站下载

兼容服务器Python3.6及以上。创建仅匹配这个ZIP文件的独立 `/var/lib/chunmo-downloads/routes/source.conf`，不依赖旧APK发布成功或 `apk.conf`存在，也不改动原APK配置。先备份、按现有服务身份执行 `nginx -t`、HUP平滑重载，验证失败自动回滚。不更新网站版本、APK、API或数据库，不重启API，不开放新端口。

已核对源码提交：`b9a97ff0c996c616733affd7cd21030e4ff1f817`，包含注册中的公开AppID `wxb48a7abb3858a252`。不包含AppSecret、代码上传私钥或员工资料。

- 目录：`/var/lib/chunmo-downloads/releases/wechat-photo-source-b9a97ff/`
- 文件：`chunmo-wechat-photo-v1-b9a97ff.zip`
- 大小：663752字节
- SHA-256：`70e69a53df9b30667b4bbdfd768db8383a94f1d2a3169d3bf250ad0ab3b37e0b`
- 发布后地址：`https://chmsj.cn/download/releases/wechat-photo-source-b9a97ff/chunmo-wechat-photo-v1-b9a97ff.zip`

ZIP采用固定时间和无压缩存储以避免不同服务器Git/zlib版本造成校验值变化。664KB适合浏览器直接下载。解压后在微信开发者工具导入 `chunmo-wechat-photo/miniprogram/chunmo-photo`。

本地只生成及检查（无服务器操作）：

```bash
python3 deploy/source-download/publish.py --repo . --output /tmp/chunmo-wechat-photo-v1.zip
python3 -m unittest discover -s deploy/source-download -p 'test_*.py' -v
```

阿里云Workbench读取本脚本后执行 `python3 publish.py --repo /opt/chunmo-source --publish`。可以通过Git fetch及git show将脚本放入临时目录，不需要checkout/pull/reset源代码，也不运行chunmo-update。发布前后核对原网站、API、服务运行状态、TLS、GET/HEAD/Range、字节数及SHA；不使用curl -k。

支持已确认的春茉原生部署目录和HTTPS服务器块，不尝试改写未知站点。缺失时创建持久源码目录及精确文件路由，复制原有安全响应头，仅为该HTTPS服务器补独立下载include。不放宽存放数据库/签名密钥的 `/etc/chunmo-staging` 私有目录权限。部署配置生成器保留同一可选include，后续正常升级不会丢掉下载入口。旧Service Worker若会将ZIP误存为离线首页，仅补下载路径排除，不删除CacheStorage/IndexedDB、照片或草稿。备份位于 `/var/lib/chunmo-downloads/backups/source-route-*`，包含原Nginx/Service Worker及既有source.conf（若有）。同名发布目录不同字节则拒绝覆盖；其他人在检查期间修改配置时停止而不覆盖。

针对截图问题，已在真实Python3.6.15容器验证ZIP/SHA、subprocess、旧SW和缺失配置处理；7项测试包含失败回滚。隔离Nginx测试从“ZIP地址返回网页、无apk.conf”的状态出发，实际增加精确ZIP路由、执行nginx -t/HUP并核对GET/HEAD/Range、完整字节和安全响应头；原网站/API/既有APK测试入口保持正常。这些不是阿里云实测，仍需Workbench执行后打印PASS。

Codex环境没有Aliyun SSH权限，不能据本地测试声称网站已发布；需要Workbench实际打印PASS后才是已核验网站下载。仅为源码文件发布，本轮不会启用小程序后端、部署管理系统或操作公众号。


新版1.1源码待发布：源码提交fc8bf26dccf87c230c2d8fd8b586236011d197ee，文件chunmo-wechat-photo-v11-fc8bf26.zip，665931字节，SHA256 40224203c18b062106f51ebcbd7ad0a7860113e58178943714f208809ed7c6dd。当前脚本发布新版独立路径；旧源码文件不删除。上文旧版信息仅作历史记录。未在阿里云执行发布，不可将新地址视为已可下载。


1.2源码待发布：76737c345ec4abc4d0445e69b660162609003eec，chunmo-wechat-photo-v12-76737c3.zip，674485字节，SHA256 9d0e3240fde98799395b4050a07da95c26076ea349f27ce3eb4bab5987d46aae。包含1.2发布说明及账号输入/快门定格修复。需阿里云PASS才确认发布，本地测试不证明高清真机效果。
