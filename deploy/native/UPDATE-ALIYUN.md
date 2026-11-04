# 阿里云：一次安装，以后一条命令更新

适用现有托管部署：Alibaba Cloud Linux 3、systemd、PostgreSQL 17，目录 `/opt/chunmo-staging`、源码克隆 `/opt/chunmo-source`。本次仅交付并在隔离环境验证脚本，没有连接阿里云执行。不同目录或非托管服务应先核对路径及服务归属，不能保证未知主机无条件更新成功。

## 首次一次性执行

在阿里云终端复制以下整个代码块。它只从指定仓库和开发分支取脚本，不运行 `git pull`、`reset --hard`、清理 stash 或修改 main；源码目录中的本地修改、已有提交及 stash 均保留。源码目录不是 `/opt/chunmo-source` 时，只修改 `repo=` 这一行。

```bash
sudo bash <<'SH'
set -Eeuo pipefail
umask 077
repo=/opt/chunmo-source
remote=$(git -C "$repo" remote get-url origin)
case "$remote" in
  https://github.com/qq850576557-debug/aaa.git|git@github.com:qq850576557-debug/aaa.git) ;;
  *) echo '仓库地址不匹配，已停止。' >&2; exit 1 ;;
esac
branch=feat/chunmo-project-manager
git -C "$repo" fetch origin "refs/heads/$branch:refs/remotes/origin/$branch"
entry=$(mktemp /tmp/chunmo-update-entry.XXXXXXXX)
trap 'rm -f -- "$entry"' EXIT
git -C "$repo" show "refs/remotes/origin/$branch:deploy/native/update.sh" > "$entry"
CHUNMO_SOURCE_REPO="$repo" bash "$entry" --install
SH
```

安装后，标准路径每次只执行：

```bash
sudo /usr/local/sbin/chunmo-update
```

自定义源码路径则执行：

```bash
sudo env CHUNMO_SOURCE_REPO=/实际源码路径 /usr/local/sbin/chunmo-update
```

无需先手动拉代码。固定入口每次取 GitHub 最新部署脚本，再固定到完整 SHA 构建；不会一直执行 `/current` 中旧版本的安装逻辑。失败会返回非零退出码，只有现有部署的备份、构建、权限、健康和持久化等检查全部完成后才输出 `PASS update <完整SHA>`。备份额度、网络下载、磁盘、证书、非托管服务或前置依赖异常仍会明确停止，不通过清数据、关闭校验或重置密码“强行成功”。

生产依赖审计始终使用官方 `https://registry.npmjs.org`，不受交互终端中下载镜像源的影响。网络较慢时，每次审计请求允许等待120秒，npm子进程上限150秒；最多尝试3次。`npm ping` 成功只代表该请求可达，不代表审计已通过。持续超时、无效报告或发现漏洞仍会阻止更新，不跳过审计。看到 `Production audit unavailable` 时，可等待网络恢复后重新运行同一更新命令；应以 `PASS production dependency audit: 0 vulnerabilities.` 和后续 `PASS update <完整SHA>` 分别判断审计与整体更新完成。

## 截图问题对应的处理

| 截图中的问题                             | 更新流程                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 源码分叉、脏文件                         | 从远端固定提交 `git archive` 构建，保留服务器本地提交及修改，不需要 hard reset                                                             |
| current 仍指向旧版本                     | 验证新 release 后原子切换 current，失败沿用原回滚逻辑                                                                                      |
| node_modules 漏拷、架构不匹配            | 新 release 独立 npm ci；原生模块验证 argon2/esbuild/sharp/rollup；裁剪后再验证生产依赖，不复用源码目录 node_modules                        |
| MIME 文件缺失                            | nginx 使用 release 内自带 `deploy/native/mime.types`，不依赖系统 `/etc/mime.types`                                                         |
| body/proxy/fastcgi/scgi/uwsgi 属主不一致 | 部署及每次托管 web 服务启动前，修复这五个专用临时目录及内部文件，保留内容；通过文件描述符操作，不跟随符号链接，拒绝特殊文件及硬链接        |
| PID 权限                                 | 沿用 systemd 专用非 root 用户，PID 位于专用 state 目录，不手写系统 PID 文件                                                                |
| systemd 内存/启动频率限制                | 更新渲染托管 unit，已有 API `MemoryMax=640M`、Node堆384MiB及启动频率限制继续保留，不在截图基础上盲目改成512M                               |
| SQL 复制嵌套、遗漏                       | 迁移从 release 原始 `server/migrations` 读取，不复制进 dist-api；逐个核对审批清单和SHA256，发现异常停止，不删除旧SQL或生产数据             |
| Origin 403                               | 现有自检请求携带部署配置中的 Origin，公网配置保留；不关闭Origin/CSRF验证。手工配置与托管配置不一致时须核对真实origin，不使用任意Origin放行 |
| 不知道员工登录密码                       | 自检沿用独立自动化账号机制，不改员工密码，不使用截图里的明文密码，也不重建员工账号                                                         |

发布仍保留旧 release、既有数据库备份、配置、密钥、审计和历史；不自动删除旧 release、备份或 stash，不新增数据库迁移。不执行数据库回滚或恢复覆盖现有数据。生产端首次运行前应确认正常业务已有可用备份；部署过程本身会按既有机制创建备份并检查。

成功后可以核对：

```bash
readlink -f /opt/chunmo-staging/current
sudo systemctl is-active chunmo-staging-api chunmo-staging-web
sudo bash /opt/chunmo-staging/current/deploy/native/health.sh
```

这些命令不输出员工凭据。不要把 `/etc/chunmo-staging` 的配置、密钥或 owner.env 粘贴到聊天。正在编辑的浏览器仍沿用 IndexedDB 待同步日志、幂等重试及版本冲突保护；服务切换可能短暂断线，不应反复刷新或清理网站数据。
