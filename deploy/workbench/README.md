# 工作台独立接入工具（2026-11-13）

创始人要求提供Shell接入代码。本工具只新增候选服务与独立小程序路径，保留原网站、手机版 https://chmsj.cn/?mobile=1、/api/mini-photo/及1.2.2服务。不是整站更新，不运行chunmo-update、不改数据库、不删除旧照片。网站/手机版源码本轮未改，不需要为接入工作台重新发布。

install.py从同一固定SHA加载旧安装事务，新增profile：/opt/chunmo-mini-workbench、/var/lib/chunmo-mini-workbench、/etc/chunmo-mini-workbench.env、chunmo-mini-workbench.service及独立非登录用户；仅监听探测出的127.0.0.1空闲端口。Nginx只新增/api/mini-photo-candidate/，上游重写为/api/mini-photo/。原入口不替换。运行包runtime.cjs是可审计JS代码，不含真实密钥；SHA256固定f8239017b153720290242ad442d67674a4504292750b905dea138eb52c379c8a。

只兼容已验证API SHA603d2549...（2756068源码）；实际检查不同则停止，不自动升级网站。AppSecret优先从root:600的既有小程序env安全复用（不复制旧签名Key或数据库凭据），缺失时仅允许终端隐藏输入，不发送聊天。新增独立签名Key，只放root私有env。服务工作台开关只在新服务启用。审核中的1.2.2继续使用旧前缀。

## 使用

固定完整Git SHA从/opt/chunmo-source读取本文件及脚本：

- python3 install.py --repo /opt/chunmo-source --commit SHA --check 只读核验，不录入密钥。
- --install 会显示实际核验指纹，需在终端粘贴确认后才安装；原始配置先备份，输出install-...编号；故障自动回滚。重复安装只验证、不重启原服务。
- --rollback install-...：恢复本工具备份的路由和私有配置，只停止新服务，不操作原服务或数据库。回滚不依赖check通过，失败状态也可重试回滚；若检测他人改动拒绝覆盖。

候选健康地址https://chmsj.cn/api/mini-photo-candidate/health必须返回features含workbench-v1的JSON；原https://chmsj.cn/api/mini-photo/health及/api/health继续正常。PASS表示部署/路由及旧入口保护检查，不能代替真实微信登录/采购/相册验收。

## 验证

原首装工具14项回归通过；候选profile继承相同事务测试14项通过，且在Python3.6容器通过；CHUNMO_WORKBENCH_LAB=1 python3 deploy/miniprogram/integration.py使用真实Node22/Nginx HTTPS、loopback、HUP，模拟systemctl，验证候选接入、旧路径保留、重跑、实际Nginx语法故障及自动回滚。不是阿里云PID1或微信实机验收。

完整浏览器回归的旧失败仍见docs/workbench/validation.md，未宣称已经修复。此工具不把本分支的桌面/手机版整个部署到生产。不能以安装PASS宣称已完成整站升级或正式微信发布。

## 一段式接入与下载

run.py --repo /opt/chunmo-source --commit <完整SHA> --stage install：显示现场计划，要求粘贴本次approvalToken确认，安装候选服务，再发布独立源码下载（workbench-source.conf），不覆盖1.2.2的source.conf。源码ZIP的固定源提交为8cd3efe；大小1183731字节，SHA256 a7a73e15aebf880ce409fbadd76d3f54dfcc2e4bbd8be389c9a8505c5c2ee559。

如果仅下载发布失败而候选已健康，改--stage source重试即可。回滚为--stage rollback --backup install-...；回滚只撤销候选服务接入，不删除源码ZIP、原入口或共享数据库里的真实业务修改。

PASS后导入下载包chunmo-workbench/miniprogram/chunmo-photo，AppID保持原值，接口前缀已配置候选路径。先真机完成采购闭环和照片保存，再上传版本2.0.0；1.2.2仍在审核时不撤回或覆盖。待原审核处理完成后，再按微信后台允许流程提交下一版。Shell不提交审核、不发布微信、不修改公众号菜单。审核期间旧手机版继续使用。

源码下载profile复用已验证Python3.6兼容发布事务：只读计划、备份、nginx -t/HUP、HTTPS GET/HEAD/Range和全量SHA验证，10项候选ZIP测试通过。候选安装14项Python测试及真实Node/Nginx隔离故障回滚已通过；实际阿里云仍以Workbench执行PASS为准。
