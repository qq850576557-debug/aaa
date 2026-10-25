# ECS 原生内部测试部署

2026-10-25；分支 `feat/chunmo-project-manager`。延续已完成的后端和昨日部署文件，不重建前端。本方案使用现有PostgreSQL17及原生Node/Nginx，**不使用Docker/Podman、不运行initdb、不删除数据库、不自动导入IndexedDB、不修改main或安全组**。

## Workbench最简执行

以有sudo权限的账号登录Workbench；下面将源码放在专用目录，不覆盖其他项目目录：

```bash
sudo -i
set -e
if [ ! -d /opt/chunmo-source ]; then
  git clone --single-branch --branch feat/chunmo-project-manager https://github.com/qq850576557-debug/aaa.git /opt/chunmo-source
fi
cd /opt/chunmo-source
test "$(git branch --show-current)" = feat/chunmo-project-manager
git pull --ff-only origin feat/chunmo-project-manager
bash deploy/native/deploy.sh
```

若已有源码含未提交修改，先保留并处理，部署器会拒绝覆盖。GitHub私库如认证失败，先配置只读deploy key，并使用干净的`git@github.com:qq850576557-debug/aaa.git` origin；不要在URL、脚本或命令里写Token。脚本不切换/重置/合并分支。

支持Alibaba Cloud Linux3、systemd、已运行的PostgreSQL17（包括用户的17.11）、Node22.12+（包括22.23.4）或Node24。优先寻找`/usr/pgsql-17/bin`客户端，不安装/初始化PostgreSQL。缺少Nginx时仅通过现有dnf仓库安装Nginx，不启用全局`nginx.service`。

### 会安全停止的前置情况

- PostgreSQL不是17、没有可用的本机5432 Unix socket或peer管理连接、已有HBA错误。
- PostgreSQL监听公网/非loopback地址，或现有host规则含`trust`。部署器不会擅自改变现有实例的全局监听和认证策略；需先由管理员确认修正。
- SELinux为Enforcing：需先审查Nginx所需文件标签/代理策略，不自动禁用SELinux或全局放宽网络权限。
- Node只装在`/root`私有目录、服务账号无法执行；空间不足；同名库/账号/服务不属于此部署；配置残缺或已有密钥丢失。

这些错误会停止并给出原因；不要通过清库、关闭TLS或开放公网端口解决。部署器并非绕过任意服务器现有安全策略的脚本。

## 执行内容与保留边界

1. 检查系统、现有PostgreSQL、源码与分支，并取得互斥锁。
2. 使用无登录权限的独立构建账号，在新目录安装锁定依赖、仅重建已审查的argon2/esbuild、验证原生模块、运行单元测试、构建前后端及部署工具；移除发行目录的开发依赖。构建不使用root，也接触不到运行时密钥。
3. 创建独立`chunmo_staging`数据库，以及`cm_stg_migrator`、`cm_stg_app`、`cm_stg_private`、`cm_stg_backup`四个分离账号。只迁移此库；同名但无管理标记的既有库/账号拒绝接管。应用不是postgres超级用户。
4. 只为该新库在现有HBA前添加loopback SCRAM规则，保留其余文件内容并保存原副本，校验后reload PostgreSQL配置，不重启实例。运行时服务隔离本机Unix socket目录，避免绕过TCP密码认证。
5. 首次生成强随机凭据、私密资料加密密钥、独立备份密钥与初始负责人密码；重跑复用它们。新配置原子发布，已有残缺配置拒绝自动重生成。
6. 使用现有校验和/事务迁移。部署另有`approved-migrations.json`精确文件哈希清单；未经审查的新迁移拒绝执行，没有自动向下迁移。
7. 原子切换固定提交发行目录，安装并启用独立systemd API/HTTPS服务；接口仅监听`127.0.0.1:4000`，HTTPS仅`127.0.0.1:8443`，数据库维持loopback。
8. 通过真实TLS请求创建独立合成验收工作室和两账号，验证登录、私密API拒绝、导出不泄露、CAS冲突、SSE和退出；重启API，验证会话及业务持久化，再撤销验收账号。不会在真实负责人工作室插入演示项目。
9. 生成一致性加密备份，并实际恢复到新建的`chunmo_restorecheck_*`隔离库，核对全部表行数、恢复时外键/约束及私密密钥认证。源库不覆盖、不删除。通过后启用备份/健康检查timer。

关键位置：

| 内容                 | 位置/边界                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| 发行版本、当前软链接 | `/opt/chunmo-staging/releases/<commit>`、`/opt/chunmo-staging/current`；root所有，运行账号不可写    |
| 业务服务配置         | `/etc/chunmo-staging/runtime.env`，root600，只有业务/私密SQL运行时连接，不含迁移/备份凭据           |
| 部署管理配置         | `/etc/chunmo-staging/control.json`，root600，管理目录700                                            |
| 初始负责人           | `/etc/chunmo-staging/owner.env`，root600；首次`studio_owner`，密码随机生成，不打印到日志            |
| 独立备份密钥         | `/etc/chunmo-staging/backup.key`，root600                                                           |
| TLS证书/密钥         | `/etc/pki/chunmo-staging`；CA私钥root600，服务私钥仅HTTPS服务组可读                                 |
| 可下载的公共信任证书 | `/opt/chunmo-staging/chunmo-staging-ca.crt`，只包含公共证书                                         |
| 备份文件             | `/var/backups/chunmo-staging`，root700，文件600                                                     |
| 验收结果             | `/etc/chunmo-staging/verification.json`（API/重启检查），备份旁`.restore-verified.json`（恢复检查） |

管理员仅在Workbench私下查看首次凭据：

```bash
sudo cat /etc/chunmo-staging/owner.env
```

不要粘贴密码/配置到聊天或Git。该文件是**初始**凭据；以后在API重置密码不会重写它，也不会因重跑部署恢复旧密码。

## 仅修复现有TLS证书

若旧CA因系统OpenSSL默认扩展与`-addext`叠加而出现重复Basic Constraints，先更新功能分支源码，再执行：

```bash
sudo bash /opt/chunmo-source/deploy/native/deploy.sh --repair-tls
```

该模式在数据库、构建和服务部署前退出，不访问PostgreSQL、不修改安全组。必须保留原`ca.key`、`server.key`；脚本不会重建或删除这些私钥。显式OpenSSL配置签发候选证书，检查重复扩展、私钥匹配、CA自签名、localhost/IP SAN、服务端用途和至少14天有效期。验证失败保留当前证书；成功后先把旧文件备份到TLS目录内root专用`backup-*`目录，再用同一证书版本指针原子激活CA和服务器证书，旧版本保留。

CA证书指纹可能改变，即使CA私钥没变，也应重新核对并在已信任旧证书的Windows账号导入新的公共CA。不要分发私钥，不关闭HTTPS验证。修复完成后运行源码中的`deploy.sh`继续原部署并加载新证书。新增TLS测试复现已签名的重复扩展根证书，检查修复、失败不替换、错误私钥/缺SAN/有效期不足及真实HTTPS验证握手；测试不连接ECS。

## Windows私有访问

本阶段先用已有SSH管理通道转发，不依赖额外VPN连通性。不新增安全组规则。若SSH目前只通过Workbench可达而没有Windows可用路径，先由用户明确批准私有接入配置，不擅自开放端口。

管理员从已有SSH通道下载公共CA，核对与Workbench部署输出一致的SHA256指纹，只在授权Windows账号信任此CA；不要下载/分发`ca.key`或`server.key`。

```powershell
scp 管理员SSH账号@ECS地址:/opt/chunmo-staging/chunmo-staging-ca.crt .
certutil -dump .\chunmo-staging-ca.crt
# 核对指纹并明确接受信任后：
certutil -user -addstore Root .\chunmo-staging-ca.crt
ssh -N -L 127.0.0.1:8443:127.0.0.1:8443 管理员SSH账号@ECS地址
```

保持隧道窗口打开，浏览器访问 **https://localhost:8443**，与服务端Origin精确一致；不使用HTTP或绕过证书错误。每台成员电脑可以使用相同本机端口，但各用独立的应用员工账号。原本地IndexedDB按原网址保留；云空间不自动导入它，仍需用户自行备份、预览和确认导入。

**不能把ECS管理员/root SSH权限发给普通员工。** 昨日已提供的可选`add-tunnel-key.sh`仅在管理员明确执行时，创建转发专用身份，限制shell/SFTP/远端及Unix socket转发，只允许TCP转发到8443。它会备份、验证并reload SSH配置，不修改安全组，默认部署不会调用它：

```bash
# 文件必须是该员工自己生成的单行Ed25519公共密钥，绝不能上传私钥。
sudo bash /opt/chunmo-staging/current/deploy/native/add-tunnel-key.sh /path/to/employee.pub
```

随后员工使用自己的密钥和`chunmo-tunnel@ECS地址`建立同样的隧道。此辅助脚本当前仅做语法/策略检查，尚未在用户ECS的真实sshd/PAM组合验收；首次使用需保留Workbench管理会话，确认受限账号只能转发，不能拿到shell。将来采用VPN时仍保留应用账号及服务端权限。

## 更新、诊断与回退

```bash
sudo bash /opt/chunmo-staging/current/deploy/native/update.sh
```

只fetch功能分支，构建独立固定提交版本；不修改源码工作区、main或远程历史。新版本先构建，再对已有服务库备份、迁移、切换及验收。运行/验收失败时尝试恢复前一代码软链接并重启应用，**不自动倒退数据库、删表或恢复覆盖数据库**；若迁移将来不向后兼容，需人工判断。旧发行目录不自动删除。

```bash
systemctl status chunmo-staging-api chunmo-staging-web
journalctl -u chunmo-staging-api -u chunmo-staging-web -n 60
systemctl list-timers 'chunmo-staging-*'
sudo bash /opt/chunmo-staging/current/deploy/native/health.sh
```

API错误/保存状态仍由应用报告；Nginx关闭访问日志，进程输出进入journal。内存限制API640MiB/Node堆384MiB、Nginx96MiB，构建堆768MiB且顺序执行。健康timer每分钟检查真实HTTPS、数据库可用性及证书至少14天有效期；失败进入systemd状态/journal，不会擅自重置数据或无限重启。系统journal总体保留策略沿用现有系统，不改全局日志配置。叶证书365天，续期必须使用保留的CA并验证，不自动更换信任根。

## 定时备份与恢复演练

每天北京时间03:10左右（随机延迟最多10分钟）以最小只读备份角色执行。pg_dump17 custom格式通过AES-256-GCM流式加密，一致性快照用于dump及表计数；密钥与文件分开，包含文件SHA256和身份清单。损坏/错误密钥会在创建恢复库前拒绝。

```bash
sudo bash /opt/chunmo-staging/current/deploy/native/backup.sh
sudo bash /opt/chunmo-staging/current/deploy/native/backup.sh verify /var/backups/chunmo-staging/实际文件.cmbackup
```

verify只新建隔离恢复库，绝不覆盖现有库。核对`.restore-verified.json`、table counts与私密GCM认证；真正接管正式库不在自动化步骤中，需另行批准。昨日失败项是pg_restore未显式指定`--dbname`，现已修正并在真实PG17.11客户端上验证。

默认达到14个本脚本备份或磁盘余量不足1GiB即停止并报错，**不自动删除任何备份、旧发行或恢复库**。管理员必须定期导出验证后的副本，审查保留/清理策略。隔离恢复库也会保留，占用磁盘；正式上线前需确定配额与经确认的清理办法。

本机卷与备份不是异地灾备。另行安全保管配置、私密密钥、独立备份密钥及CA；不要把它们与可公开取得的数据库文件放一起。本轮未配置OSS/异地存储凭据、告警通知或自动清理，不能宣称完整生产灾备已就绪。

## 本轮验证与未验证项

原生测试实验室使用已有本地测试PG集群上的**新建隔离库**，不重建任何原库；本机原生Nginx1.26.3和pg_dump/pg_restore17.11。测试包括：重复建库/迁移/最小权限/引导、TLS两账号API、真正构建前端的两独立浏览器会话双向SSE、API重启、加密备份、篡改拒绝、隔离恢复、还原库实际承接保留的登录会话与项目。没有Docker部署步骤，未连接ECS。

浏览器实验室仅信任该次生成证书的SPKI，不使用全局ignoreHTTPSErrors；HTTPS API客户端单独使用实验CA验证完整证书链和主机名。ECS/Windows按上面正式信任证书流程操作，不使用测试参数。

最终执行记录见下方。当前Codex主机是非root的Debian环境，**无法冒充已在Alibaba Cloud Linux3执行dnf、systemd开机启动、SELinux及真实SSH策略验收**。部署器会在ECS上再次验证实际前置条件、unit文件、TLS、业务和恢复；只有最终输出`PASS INTERNAL deployment`才代表该次服务器内部部署成功，仍需用户检查后决定正式上线。

### 2026-10-25最终执行记录

| 检查                       | 实际结果                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| 部署安全测试               | 5/5通过；密钥复用/残缺拒绝、HBA保留、加密篡改拒绝、私有HTTPS及配置边界           |
| 原有业务单元测试           | 60/60通过                                                                        |
| PostgreSQL/API集成测试     | 9/9通过                                                                          |
| 原有本地/云端浏览器测试    | 50/50、3/3通过                                                                   |
| 原生部署实验室             | 通过；真实Nginx HTTPS、两个独立浏览器、双向同步、API重启、加密备份及新隔离库恢复 |
| 恢复后的实际服务           | 通过；还原库实际承接原账号会话和项目，不仅检查pg_restore退出码                   |
| 篡改备份                   | 在创建恢复库之前拒绝，源数据库未改动                                             |
| 前后端/部署工具构建        | 通过                                                                             |
| shell语法、systemd离线验证 | 通过；未在Codex主机安装/启动系统服务                                             |
| 非root运行部署器           | 按预期在preflight安全拒绝，未修改系统                                            |
| npm audit                  | 0项已知漏洞                                                                      |
| 格式与git差异检查          | 通过                                                                             |

保留昨日已完成文件，未新增业务功能。除明确修复pg_restore目标库参数外，确认Nginx临时目录全部位于服务私有可写目录；HTTPS unit不因后端短暂重启被Requires连带停止，避免重启持久化验收中断。ECS真实执行、systemd开机与Windows接入仍由上述Workbench流程验收，未宣称已经远程部署。

## Optional public HTTPS on TCP 15001

This is an explicit opt-in; pulling/building the code does not activate public access. No ECS service was changed during development. The loopback 8443 endpoint remains for diagnostics, PostgreSQL remains loopback and Node remains `127.0.0.1:4000`. Public activation changes the **one allowed browser Origin** to the supplied HTTPS origin. The old internal page is then diagnostic-only, rather than a second login origin. Existing Secure/HttpOnly/SameSite=Strict cookies, CSRF tokens and server permissions remain enforced. Nginx preserves Origin and overwrites X-Forwarded-For; Express trusts only loopback proxies. SSE remains unbuffered.

### Public CA mode (default)

The internal self-signed CA cannot deliver browser-trusted access without installing that CA. Obtain a **public CA certificate whose SAN covers `39.105.64.188`**, plus its complete intermediate chain and matching private key, or use a domain resolving to this ECS with a public domain certificate. IP certificate availability depends on the CA and ACME client's support. Public ACME IP certificates may be very short-lived and require automated renewal. Neither a different port nor another self-signed certificate solves browser trust. No claim is made that an IP certificate has already been obtained.

Certificate issuance may require publicly reachable 80/443 for validation (or DNS validation for a domain); port 15001 alone does not satisfy HTTP-01/TLS-ALPN-01. The scripts do not open these ports, install an ACME client, purchase a domain or request a certificate on the user's behalf. Chinese mainland public hosting may also require provider/filing review; check applicable requirements before public launch. HTTPS on 15001 does not bypass those requirements.

After putting the issued files in root-protected locations, run in Workbench:

```bash
sudo -i
set -e
cd /opt/chunmo-source
test "$(git branch --show-current)" = feat/chunmo-project-manager
git pull --ff-only origin feat/chunmo-project-manager
bash deploy/native/deploy.sh
bash deploy/native/public-https.sh https://39.105.64.188:15001 /root/chunmo-cert/fullchain.pem /root/chunmo-cert/privkey.pem
```

Use the domain origin instead if the certificate covers a domain. Only after verification, review and allow inbound **TCP 15001** in the existing ECS security group and host firewall; never disable the firewall or expose 4000/5432. From a different network open the exact HTTPS origin and confirm no certificate warning, owner/employee login, permissions, two-browser updates and persistence. Local checks cannot prove external security-group reachability or public browser root trust.

`public-https.sh` uses the existing deployment lock, validates the leaf/key/SAN/current validity (>=24 hours), strict server certificate chain against OS trust (or the explicit private CA in the opt-in mode below), copies/revalidates an immutable certificate bundle, checks Nginx as the service user, and backs up runtime/Nginx/public config under `/etc/chunmo-staging/public-before.*`. It atomically replaces each config file and restarts services; any activation/health/account-smoke failure restores all previous config files and restarts the previous configuration. It never deletes old key bundles or changes database schema/data, except existing isolated deployment-canary accounts/records created by the established smoke tests. Failed/old certificate bundles are retained for investigation. Backups include runtime secrets: keep root-only and never upload them.

Repeat the same `public-https.sh` command with newly issued files to renew/rotate; integrate this command into the chosen ACME client's successful-renewal hook. Issuance/renewal scheduling is **not yet automated by this repository**. Existing health timer verifies both endpoints every minute and warns/fails if the public leaf has less than 24 hours remaining. That systemd failure is local, not an off-server alert. Do not launch publicly until a working renewal schedule and monitoring are configured. Normal updates retain public config and revalidate its certificate; expired/near-expiry certificates fail closed rather than downgrading to HTTP. Renew first if needed.

Validation in this workspace uses an isolated local database and a synthetic loopback public listener (`CHUNMO_LAB_PUBLIC=1 npm run test:native-lab`), with certificate-specific browser trust only in the test harness. It does not obtain or install a production certificate, modify ECS, or prove public Internet reachability.

Verified in this workspace (2026-10-25): 17/17 deployment/TLS tests, including real certificates, untrusted/wrong-SAN/wrong-key/near-expiry rejection and mocked activation rollback; 60/60 unit tests; 9/9 PostgreSQL/API tests; 3/3 cloud browser regression tests; frontend/API/deployment production builds. The preserved private HTTPS native lab also passed. Public-listener native lab passed real owner/employee browser login, cookie flags, hostile-Origin rejection, two-session SSE updates, restart persistence, encrypted backup tamper rejection, isolated restore and serving restored state. No real public certificate, public Internet reachability or ECS service changes are included in these results.

Changing browser origin also changes its IndexedDB namespace. Existing local browser data is retained at the old origin; it is not automatically copied or imported. Log in to the existing cloud workspace at the new origin to access already-saved server data. Use the established explicit backup/import workflow for any remaining local-only data.

### 内部 CA 模式：公网 IP + 15001（本次选定方案）

员工首次使用前，需通过安全渠道核验并安装现有 **Chunmo Internal Staging CA 公共证书**。这不是公开 CA 证书；未安装该 CA 的浏览器仍会报警，不应跳过警告。公网 HTTPS 的 Secure Cookie、Origin、CSRF、SSE 和服务端权限保持原有保护。

Workbench 完整命令：

```bash
sudo -i
set -e
cd /opt/chunmo-source
test "$(git branch --show-current)" = feat/chunmo-project-manager
git pull --ff-only origin feat/chunmo-project-manager
test -s /etc/pki/chunmo-staging/ca.crt
test -s /etc/pki/chunmo-staging/ca.key
bash deploy/native/deploy.sh
bash deploy/native/public-https.sh --private-ca https://39.105.64.188:15001
```

新增的 `--private-ca` 模式仅使用现有 `/etc/pki/chunmo-staging/ca.crt` 和 `ca.key`，不重新签发根证书、不重新生成 CA 私钥，也不修改 localhost 的证书和私钥。若 CA 缺失、无效、私钥不匹配或有效期不足，安全停止。使用受控 OpenSSL 配置创建独立服务器私钥及证书，SAN 为 `IP:39.105.64.188`，有效期最多 365 天且不超出 CA 剩余有效期。使用随机序列号，不写入现有 CA 序列文件。

启用前，以明确指定的 CA 为唯一 OpenSSL 信任锚，严格验证链、用途、IP SAN、有效期及私钥匹配。CA 公共证书快照保存在新证书 bundle 中，并通过 `mode: private-ca` 和 `ca` 路径记入受保护的 `public-https.json`；后续部署、健康检查及本地 HTTPS 探测均沿用该信任锚，不要求把内部 CA 加入 ECS 系统全局信任库。不会关闭 TLS 验证或使用 `curl -k`。原有备份、启用前 Nginx 校验、配置回滚及内部 8443 入口继续保留。

确认 `PASS public HTTPS local verification` 后，仅在现有安全组和主机防火墙中审核放行 TCP 15001，不能关闭防火墙或开放 4000/5432；脚本不会修改这些规则。员工访问 `https://39.105.64.188:15001`，登录已有云空间。数据库、后端继续只监听本机；原浏览器 IndexedDB 不会被导入或删除。

安全分发 `/opt/chunmo-staging/chunmo-staging-ca.crt`（仅公共证书）给员工，通过独立可信渠道比对脚本输出的 CA SHA-256 指纹；Windows 可用 `certutil -dump -v chunmo-staging-ca.crt` 查看证书的 SHA-256 证书指纹（不是 PEM 文件哈希），然后导入当前用户的“受信任的根证书颁发机构”。管理员也可在可信 Workbench 中重新执行 `openssl x509 -in /etc/pki/chunmo-staging/ca.crt -noout -fingerprint -sha256`。不得分发 `ca.key`、`server.key` 或包含密钥的目录/备份。

续签时重新执行相同 `public-https.sh --private-ca ...` 命令，旧证书 bundle 和配置备份保留；不会轮换 CA 或要求员工重复安装未变更的根证书。自动续签定时任务暂未加入，需在到期前主动执行；现有健康检查在剩余不足 24 小时时报错。

本轮私有 CA 模式实际验证：19/19 部署/TLS 测试、60/60 单元测试、9/9 PostgreSQL/API 测试通过，前端/API/部署工具生产构建通过。`CHUNMO_LAB_PRIVATE_CA=1 npm run test:native-lab` 通过真实 Nginx、严格 CA/IP 验证、两个独立浏览器账号、SSE、权限、重启持久化及隔离恢复；并逐字节确认 CA 私钥、CA 公共证书和 localhost 证书/私钥未变。公有/私有两种模式的失败回滚均已测试。本轮没有连接 ECS、修改其服务或实际操作 Windows 信任库。
