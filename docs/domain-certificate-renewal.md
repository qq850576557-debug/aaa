# chmsj.cn 免费证书自动续期

当前唯一登录入口为 `https://chmsj.cn`，旧 IP 入口不再作为第二个登录入口；业务记录及账号仍使用原数据库。切换前未同步的浏览器草稿仍属于旧来源，不应清除旧站点浏览器数据。

已有证书由 `/root/chunmo-acme-venv/bin/certbot` 管理，证书谱系名为 `chmsj.cn`。安装续期前必须先通过现有更新入口发布新版，使 HTTP 80 上的 `/.well-known/acme-challenge/` 使用 `/var/lib/chunmo-acme` 提供验证文件；其他 HTTP 请求仍跳转到固定域名 HTTPS。保留 80、443 入方向规则和域名解析。

服务器操作：

```bash
sudo bash <<'SH'
set -Eeuo pipefail
/usr/local/sbin/chunmo-update
bash /opt/chunmo-staging/current/deploy/native/renew-certificate.sh --install
systemctl start chunmo-certificate-renew.service
systemctl list-timers --all chunmo-certificate-renew.timer
SH
```

安装先调用 Certbot `reconfigure`，通过测试环境进行 webroot 验证，成功后保存续期方式，再安装专用 systemd service/timer。验证失败不启用新定时任务。无需 API 密钥、不需要额外购买证书。

每天按服务器时区 03:20、15:20 加随机 0—30 分钟检查，Certbot 判断是否需要续期。验证时不停止网站；证书变化后通过现有公网激活器校验、备份配置并加载，期间短暂重启服务。证书链和私钥仍保留在服务器。不是每次检查都申请，也不是每次检查都重启。

续期成功但激活失败时，下一次任务会比较签发证书与已加载证书指纹，再次尝试激活。没有关闭 CA 校验、到期检查或公网激活回滚。定时任务和运行脚本独立保存，不随代码目录切换消失。

故障检查：

```bash
sudo systemctl status chunmo-certificate-renew.service chunmo-certificate-renew.timer
sudo journalctl -u chunmo-certificate-renew.service -n 60 --no-pager
```

网络持续失败、DNS 或安全组变化仍可能导致续期失败。任务日志和现有健康检查是本机检查，不代表已配置短信或邮件通知。

本地验证：44 项隔离部署测试通过、部署工具构建通过、Shell 语法和差异检查通过。涵盖普通网页跳转与挑战路由、无证书变化不激活、证书变化激活、续期/激活失败阻断及安装验证失败不写定时任务。未在本地访问生产数据库或代替服务器执行真实 ACME 验证；真实 webroot 签发测试和定时任务启用需以上服务器命令完成。
