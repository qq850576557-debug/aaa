# 小程序源码网站下载

沿用现有APK的 `/download/releases/` 持久下载映射，仅新增一个不可变目录，不改Nginx、下载首页、APK更新信息、网站版本、API或数据库；不重启服务。

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

脚本仅支持已存在且匹配的APK下载环境，否则停止，不擅自修复未知Nginx配置。同名目录不同字节则拒绝覆盖。正常重跑只验证同一文件。

Codex环境没有Aliyun SSH权限，不能据本地测试声称网站已发布；需要Workbench实际打印PASS后才是已核验网站下载。仅为源码文件发布，本轮不会启用小程序后端、部署管理系统或操作公众号。
