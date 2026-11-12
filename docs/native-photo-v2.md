# 春茉工地拍照 V2 · 原生整改交付

本轮在 V1 原生工程增量修改，基线 `de57984c66ff864b39f3289947879b0d36742b25`。未重建管理系统，未修改 `src`、业务 API、生产数据库、iPhone/PWA 或原稿 Logo；没有生产部署。

## Android 实际实现

- 登录：按电脑版 `#244e42 / #293d34 / #f7f8f4 / #617269 / #e3e8e0` 统一主题，原稿 Logo 加独立相机图标，账号/密码表单、键盘避让、固定构建服务器；普通界面无地址输入。保留原 Cookie、CSRF、身份与 AndroidKeyStore 会话机制。
- 地点：顶部返回/设置、搜索、真实定位状态与重新定位；可独立滚动的卡片列表、最近默认选中、去重排序/分页；底部固定确认。搜索复用尚有效 GPS，过期重取；保留服务端精度、90秒、2km POI与签名规则，无手填地点。
- 相机：全屏后置 CameraX、共享像素水印，竖屏底部/横屏侧边控制。会话复用，旋转仅更换预览表面及目标方向。静态照片请求设备最高可用尺寸，JPEG98，输出保持实际像素，不统一缩为1080P。
- 捕获：默认 `MINIMIZE_LATENCY`；最多3个捕获请求、12个未保存任务。准备文件、捕获锁、落盘和后台水印/相册分层。CameraX的`onCaptureStarted`可能在主线程调用：在回调当刻取时间，再交给专用执行器持久化，不能在此做主线程fsync。
- ZSL：能力标志不等于更快。模拟器的ZSL/系统预览结果不可靠，因此默认关闭；仅受控设备A/B构建可传`-PphotoEnableZsl=true`，仍检查支持和绑定失败回退，不对全部设备强开。
- 保存：原账本/文件格式、MediaStore待发布URI、字节验证和回执保持。原始/水印图在成功回执前保留；失败可重试，同一任务不盲目重建。暂存故障暂停快门，重试前真实写盘/fsync探测，不用动画冒充成功。
- 性能：历史保存记录只缓存基本状态；待处理JSON至多12份，图片逐张解码。状态轮询和新捕获不再反复读取全部历史JSON。重启从原AtomicFile恢复，没有迁移或清理历史。调度合并但保留后续工作，不能用KEEP丢掉运行期间的新照片。
- 诊断：`ChunmoPerf`与本机有界`performance.jsonl`记录准备、首帧、捕获、可靠落盘、编码、水印、图库和帧耗时；不写账号凭证、姓名、GPS或地点签名。

## 检查更新与标准发布

设置→检查更新→版本说明→下载进度→校验→系统安装。HTTPS与原构建域名绑定，不转发Cookie/CSRF到下载；拒绝跳转、站外URL、路径穿越、错误长度/SHA、包名、签名、不递增版本及系统不兼容。

Android平台解析实际APK签名并与**当前已安装应用**比较。FileProvider仅开放`files/updates/`，不开放会话或照片目录。用户仍须在系统允许安装并确认；打开安装界面不等于安装成功。旧数据和旧PWA完全不清理。

当前渠道为Debug内部测试，包名固定`cn.chmsj.photo`，versionCode2，`2.0.0-internal`。签名证书仍为：

`011aa52c0ad4ee183a42fc34542d312ff924f6ef2ed22ec6bb340451f8ba6501`

现有私钥在被Git忽略的`native/android/signing/existing-internal-debug.keystore`，目录0700/文件0600。构建显式使用这一文件，不能在新机器默默生成另一个debug key；私钥不进入Git、聊天或发布包。

以后发布新版本：

```bash
cd native/android
# 示例是下一版本；versionCode须递增。使用现有受控私钥。
./gradlew -PprotocolOnly -PphotoVersionCode=3 -PphotoVersionName=2.0.1-internal testDebugUnitTest assembleDebug lintDebug
cd ../..
python3 native/release-tools/prepare-release.py \
  --apk native/android/app/build/outputs/apk/debug/app-debug.apk \
  --build-tools /实际AndroidSDK/build-tools/35.0.0 \
  --out /Git工作区之外的受控发布目录 \
  --notes '本次更新内容'
```

准备工具实际调用apksigner/aapt2核对证书、包名、版本、大小及SHA。输出APK、`update.json`和`chunmo-photo-update.tar.gz`，不连接服务器。输出目录不能放Git工作区内；APK不进入源码历史。

**创始人审核后**，使用Workbench安全上传该发布包到已有ECS；以下由创始人手动执行，不运行整站更新、不执行数据库命令：

```bash
set -Eeuo pipefail
apk_release_dir=$(mktemp -d /root/chunmo-photo-update.XXXXXXXX)
tar -xzf /root/chunmo-photo-update.tar.gz -C "$apk_release_dir"
bash "$apk_release_dir/chunmo-photo-update/install.sh"
```

发布脚本使用既有部署锁和真实域名/TLS/Nginx前后验证，只更新独立静态下载配置；失败恢复。持久文件位于`/var/lib/chunmo-downloads/releases/`，稳定入口为`/download/update.json`和`/download/`，版本APK路径含versionCode和SHA前缀。保留旧版本，不覆盖同versionCode不同字节，不降级。每版两份APK约22MB加页面/Logo，使用既有ECS磁盘，无新服务或云端照片库。

本轮没有执行以上服务器命令。源码中的下载地址是**待发布目标**，不是已上线验证的V2链接。当前没有有效GitHub Release API凭据或阿里云SSH身份；不伪造Release上传或公网部署。

## 验证与边界

详见`native/validation/v2-results.json`及真实窗口截图。验证分开记录：

- SDK35/Kotlin编译、JVM协议/更新规则与容量并发测试、lint、debug签名及16KB对齐。
- 实际V1→V2 `adb install -r`：一张待保存照片逐字节保留，原AndroidKeyStore加密会话可解密；只删除了明确创建的模拟会话，未清空数据。
- Android平台验证更新候选：相同证书的下一版本APK通过；另一个测试证书、错误SHA、降级拒绝，安装提供器只开放updates路径。
- 真正Android图形/MediaStore回归：20张合成图、4000×3000及EXIF旋转、不重复创建、拒绝/空间失败、重启回执、捕获预留锁、状态读取不扫描磁盘。这不是20张真实手机连拍。
- 软件模拟器的实时相机：确有完整像素拍摄和图库字节结果。但20张连拍的候选测试在640.574秒内仅接受7次，未通过；有系统UI/启动器ANR和极慢虚拟图像处理。所有测试文件保留，不能把它报告为真机20张通过或宣称已达到系统相机速度。
- 窗口截图使用Android官方`UiAutomation.takeScreenshot(Window)`，是真实运行原生窗口，排除模拟器系统弹窗遮挡；不是网页重画。身份、GPS与地点为明确标注的模拟测试资料，不作为真实定位验收。
- 相机首帧/捕获时间包含软件模拟器和测试负载。不同候选配置与积压不同，不计算虚假的V1→V2手机加速百分比。Pura/vivo/OPPO/小米的10/20张、冷热启动、横竖屏、最高像素、相册可见、故障恢复及系统交互安装仍需真机。

## HarmonyOS 6.1 / API24

目标来自用户提供的Pura70 HBP-AL00，软件6.1.0.146，API6.1.1(24)。只记录开发必要型号/版本，不记录序列号或IMEI。

统一原生主题和三页UI；目标产品改为6.1.1(24)，校准网络能力门槛；异步暂存/复制与账本缓存，JPEG完整性检查，单队列水印。普通App无持续写图库权限时，完成后一次系统批量创建授权，再写入和字节核查；授权窗口期间锁住队列，防止定时任务把“正在等待授权”误判成进程中断；二次点击重新检查状态。未确认的创建禁止自动重建，权限明确拒绝可修正后重试。处理队列12，已完成水印等待授权不占处理槽，批次待存上限100，避免普通权限下只能拍12张。

**当前没有DevEco、API24 SDK、HAP签名/profile及鸿蒙设备连接，未编译、未签名、没有HAP。** `sdk-preflight.mjs`退出2。共享纯协议测试不覆盖ArkUI/CameraKit/图库。按[目标设备与验收](../native/harmony/DEVICE-TARGET.md)在配套DevEco中全量编译并修复实际SDK差异后才可交付HAP。

APK在Pura70可以运行不表示写入了鸿蒙系统图库；本Android包不冒称修复所有HarmonyOS图库问题。原APK与未来HAP的私有文件不自动共享，旧照片结果未核实前不要卸载APK或清除数据。

## 本轮实际文件与运行截图

- 安装包：`/workspace/artifacts/chunmo-photo-v2-final/chunmo-photo-2.0.0-internal.apk`，11,031,250字节。
- SHA-256：`b56c96d268928336ac40130d5e80fcd6e8c051e8ab9985cb6a4025f9f58ec597`。
- 手动发布包：`/workspace/artifacts/chunmo-photo-v2-final/chunmo-photo-update.tar.gz`。这些文件实际存在，但尚未上传官网，不能把清单中的URL当作已经上线。
- [登录页](../native/validation/v2-ui/login.png)、[地点页](../native/validation/v2-ui/places.png)、[相机页](../native/validation/v2-ui/camera.png)、[横屏](../native/validation/v2-ui/camera-landscape.png)。均为Android模拟器真正运行窗口，明确使用测试身份/地点。

最终单张虚拟相机实测：首帧11,436ms、快门到捕获开始4,352ms、可靠原图落盘10,311ms（其中raw fsync22ms）、水印57,676ms（含编码6,295ms）、图库写入/核查5,341ms，输出1392×1856。软件模拟器不是实机，以上结果**未达到手机相机流畅度验收**；不据此承诺设备速度或报告虚假提速比例。最终包单张完成且成功读回；20张真实连拍仍列为未通过/待实机。

本轮已完成可核查的代码、内部APK、同签名覆盖验证和测试证据；HarmonyOS签名HAP、普通安卓及Pura70真实相机/图库、厂家系统安装界面仍需配套SDK/证书和实机。调试签名文件目前保存在工作区受限目录，工作室外部受控备份尚未核实；在环境更换前需通过安全渠道备份，不能把私钥加入发布包。
