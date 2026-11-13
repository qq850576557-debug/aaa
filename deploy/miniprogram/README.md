# 微信拍照小程序｜独立服务器接入准备

本目录交付的是**待负责人确认后执行**的接入工具。没有连接阿里云执行安装，没有运行`chunmo-update`，没有替换`/opt/chunmo-staging/current`、原API运行包、数据库、账号或旧照片。此前阿里云只读结果显示运行版本为`2756068e6ce7f6f39a90c75610d24e9479b13f0d`，其API尚无小程序适配；安装前必须重新核对实际状态，不能把旧截图视为当前事实。

## 可审查的变更范围

| 项目               | 内容                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 独立运行包         | `/opt/chunmo-mini-photo/releases/<运行包SHA前16位>/runtime.cjs`及开源许可；本地构建、全依赖打包，无服务器npm安装或整站构建 |
| 独立Linux用户/服务 | `chunmo-mini-photo`，非root、不可登录、无额外组和低端口能力，systemd单元`/etc/systemd/system/chunmo-mini-photo.service`    |
| 监听               | 仅`127.0.0.1`，现场检查4011–4020空闲候选，不开放公网端口，不修改安全组/防火墙                                              |
| HTTPS入口          | 仅`/api/mini-photo/`，代理到该本机端口；其他`/api/`、网页、下载等保持原路由                                                |
| Nginx配置          | `/opt/chunmo-mini-photo/routes/api.conf`，仅向已核对的chmsj.cn公网443服务器块补可选include；nginx -t后HUP，不restart API   |
| 私有配置           | `/etc/chunmo-mini-photo.env`，root:600；不复制原数据库凭据、高德Key、PRIVATE_DATA_KEY或原runtime.env                       |
| 备份及状态         | `/var/lib/chunmo-mini-photo/`，root:700；含原配置快照和回滚日志，不得发送这些文件到聊天                                    |

运行包主SHA-256：`6ce608ae9d9e1071c33b51f21c0f47f9efe3e9166c01f749bb5ed9c53ec38a7c`。运行包清单见`runtime-manifest.json`，源代码为`server/miniprogram-sidecar-main.ts`、`server/miniprogram-sidecar.ts`和`server/miniprogram-photo.ts`；`scripts/build-miniprogram-sidecar.mjs`可重新构建。运行包是JavaScript代码，不含真实AppSecret或员工资料。

## A. 现在可以执行：只读核验

使用最终交付回复中固定完整SHA的Workbench命令，以`--check`运行`workbench.sh`。Git fetch仅取得代码对象，不checkout/pull/reset或更新运行中的网站。

该阶段核对：

- 现有API和Nginx服务正常；公网/本机HTTPS证书及旧站、旧API健康。
- 原API实际PID和Node可执行路径/版本，原API运行包SHA及当前release。
- 私有旧配置里的API端口、可信Origin、高德启用标志；**不输出私有值**。
- 公网Nginx `/api/`实际上游确实与API端口一致，避免误用另一个服务器块。
- 候选本机端口是否被占用；新服务/目录/私有配置是否与未知已有内容冲突。
- Node需22.12+，systemd需231+；SELinux Enforcing时停止，不放宽或关闭SELinux，不安装/升级系统组件。

输出`approvalToken`是**非秘密的部署核验指纹**，由当前配置/版本/端口/运行包信息计算。可以与检查结果一起审查；它不是微信AppSecret、Cookie或登录令牌。`--check`不录入AppSecret、不安装服务、不修改业务配置。

先把检查结果交给负责人确认本表范围和实际端口。**未确认时不要运行安装段。**

## B. 负责人确认后：安装

用同一固定SHA执行`workbench.sh <SHA> --install`。完整可复制命令在最终交付回复中。

1. 工具要求粘贴刚才的`approvalToken`，重新核验现场；配置、端口或原API PID发生变化时停止，要求重新核验。
2. 在私有目录保存原Nginx、原小程序配置（若由本工具管理）、systemd文件等快照，输出`install-...`备份编号。
3. 在Workbench**交互Shell**内提示粘贴AppSecret，输入不显示。代码只接受`/dev/tty`隐藏输入；无TTY或不能关闭回显时停止，绝不退回可见stdin。不要把密钥放进命令参数、export、Git、客户端源码或聊天。此工具没有`--secret`参数。
4. 生成独立传输签名Key，只写root私有配置。创建非登录服务用户，校验无额外权限，安装经过SHA核对的运行包及单元。
5. 启动仅绑定loopback的新进程，验证本机就绪后才补新路由。原Nginx语法检查通过才HUP。
6. 检查本机和公网小程序健康JSON、未验证请求应返回专用401、旧站/API正常、原release及API字节未变，最后才enable新服务并输出`PASS`。

`PASS`表示安装/路由/旧站保护检查成功，**不代表真实微信code交换、定位准入或三类手机相机/相册已通过**。AppSecret未用真实wx.login code验证时不能宣称登录成功。

## C. 自动及手动回滚

- 故障自动恢复本次配置；先恢复并确认原路由HUP/旧站健康，再停止新服务。不会停止或重启原API。
- 若回滚HUP失败，新服务暂不停止，备份保留，明确报“回滚未完全确认”，防止仍有指向它的worker请求。再次回滚会重试HUP，即使磁盘文件已经恢复。
- 操作期间其他管理员修改了文件，CAS校验会拒绝覆盖，不强行恢复快照。此时需人工审查，不视为回滚成功。
- 手动恢复：同一SHA执行`workbench.sh <SHA> --rollback`，粘贴安装输出的备份编号。不要直接删除私有文件/服务目录。派生运行包、受控非登录用户和私有备份保留，便于审计或重试；不删除任何业务资料。
- 已安装且健康时重复`--install`仅验证，无重启、无重写、无再次录入密钥；检测到人为改动则停止。升级到不同运行包不属于该首装脚本的自动覆盖范围。

## D. 安装后的健康检查

```bash
systemctl is-active chunmo-mini-photo chunmo-staging-api chunmo-staging-web
curl --fail --silent --show-error https://chmsj.cn/api/mini-photo/health
curl --fail --silent --show-error https://chmsj.cn/api/health
```

第一项应返回三个active；新接口应为`{"ok":true,"protocol":1,"mode":"sidecar"}`，不能是网站HTML。第二个health是原API，仍应`ok:true`。

错误排查仅查看新组件日志：`journalctl -u chunmo-mini-photo -n 40 --no-pager`。不要cat或发送`/etc/chunmo-mini-photo.env`、原runtime.env、备份record.json、请求Cookie/CSRF、密码或微信code。

## E. 微信开发者工具与手机

1. 导入已下载源码的`chunmo-wechat-photo/miniprogram/chunmo-photo`。AppID为`wxb48a7abb3858a252`，`config.js`保持`https://chmsj.cn`；无需为本服务修改手机代码，不开通云开发。
2. 微信后台request合法域名为`https://chmsj.cn`（无/api/端口）；保留合法域名校验，不用游客AppID。AppSecret只属于服务端，与代码上传私钥不同。
3. 确认后台隐私声明、定位接口准入及开发/体验成员权限按当前平台要求开放。认证中可先联调允许使用的功能，不能保证定位资格已获批。
4. 编译后用**原工地管理系统员工账号密码**登录。微信管理员扫码登录工具不等于员工账号登录。
5. 手机预览：先登录、定位、选择2公里内地点，拍两张并在系统相册核对，再按iPhone、vivo/其他安卓、鸿蒙微信分别执行20张连拍、权限拒绝、补录/恢复和实际像素验收。
6. 若登录提示微信验证失败，检查服务器AppID/AppSecret是否对应、小程序真实登录code及平台权限；不要关闭CSRF/来源校验或把AppSecret贴到聊天。发截图时遮住密码、Cookie、code和令牌。

## 验证范围

Python安装事务覆盖：未确认不安装、私有文件权限与不复制数据库凭据、端口冲突探测、TTY不可用/回显失败拒绝读密钥、HTTPS公网API上游核对、故障自动回滚、回滚重载失败保留服务、二次回滚重发HUP、外部改动不覆盖、重复执行不重载。

`scripts/test-miniprogram-legacy.mjs`用**实际2756068旧API源码**及专用localhost `_test`数据库，验证员工登录、Cookie/CSRF、身份、高德签名地点（供应商响应模拟）、跨账号拒绝、停用账号和注销；未访问生产数据库。

`deploy/miniprogram/integration.py`运行真实Node22独立子进程、loopback监听和Nginx HTTPS/TLS，模拟systemctl/用户管理接口，实际执行安装事务、转发、nginx -t/HUP、重复执行、真实语法故障及自动回滚；原网站/API测试入口保持正常。**不是阿里云真实systemd安装或真实微信调用**。systemd单元另以官方分析器校验；阿里云仍需只读现场核验及负责人确认后安装。

可复现：

```bash
node scripts/build-miniprogram-sidecar.mjs
python3 -m unittest discover -s deploy/miniprogram -p 'test_*.py' -v
node scripts/test-miniprogram-legacy.mjs
python3 deploy/miniprogram/integration.py
```

测试不需要真实AppSecret；不要为了测试把它写入环境示例或源码。

终端兼容性回归：Linux `/dev/tty` 不支持文本 `r+` 模式所要求的seek，因此提示流采用只写模式，输入继续交给getpass独立TTY描述符。真实伪终端测试同时把stdin重定向到/dev/null，核验Workbench/heredoc场景下可以输入且不回显；Python 3.6容器中14项安装测试通过。无TTY、无法关闭回显时仍直接拒绝读取密钥。
