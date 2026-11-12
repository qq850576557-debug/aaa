# 原生拍照 V1.0 开发交付记录

日期：2026-11-12，Asia/Shanghai。基线 `3f46936be0cf7fceb7b89e08d6f6777b8eddcd9c`。

## 实际交付

**Android：已构建并签名校验debug APK，在独立Android15模拟器安装成功。** 源码实现已有账号登录、真实GPS/服务端地点、CameraX连续静态拍摄、共享原稿水印、WorkManager串行恢复队列及MediaStore相册回执。最低Android10，包含arm64-v8a、armeabi-v7a、x86、x86_64。不是release长期签名版本，不能冒称真机已经验收。

安装包实际位置：[版本1 debug APK](releases/chunmo-photo-1.0.0-debug.apk)，另复制到`/workspace/artifacts/chunmo-native-v1/chunmo-photo-1.0.0-debug.apk`。构建位置`native/android/app/build/outputs/apk/debug/app-debug.apk`。完整校验和与签名见[构建核验](validation/build-results.json)和[校验和文件](releases/SHA256SUMS)。本次在开发分支保留实际APK用于试装；签名私钥不进Git。

**Harmony：已建立独立ArkTS/ArkUI原生工程源码，但尚未完成6.1 SDK适配、编译、签名和设备安装；没有HAP文件。** 公开API核查和纯协议测试不能替代DevEco编译。API12模板与HTTP API23门槛的实际6.1映射未确认，见[具体SDK门槛](harmony/README.md)。普通相册权限不可得时使用系统确认保存，不能承诺静默自动入相册。

## 主要修改文件

- `native/android`：Gradle工程/wrapper、Manifest、AndroidKeyStore会话、接口协议、前台GPS、CameraX界面、水印与EXIF处理、原子任务账本、WorkManager与MediaStore、权限/备份策略、7项JVM协议测试、独立图形测试及模拟器instrumentation测试。
- `native/harmony`：Stage工程、资源/权限、EntryAbility、ArkUI页面、HTTP协议、GPS/地点续期、Camera Kit、原生水印、相册授权/核查及失败恢复队列、HAP构建前置检查。
- `native/shared`、`scripts/native/contracts.test.ts`：共享协议、品牌指纹、官方API引用和跨端规格校验。
- `native/validation`、`native/samples`：实际构建/模拟器结果与合成样图；不含生产资料、账号密码或签名私钥。
- 根目录仅补充Git/格式规则，排除SDK缓存、构建输出、证书和本机配置，并规范Gradle启动脚本在Windows/Linux的换行。

`src`、`server`、`public`、原有依赖清单均未改动。没有新增业务数据库、生产迁移、生产部署、网页照片清理或收费服务。iPhone继续使用V3.2。新App私有文件与旧IndexedDB独立，不自动导入或清空旧队列。

## 编译和测试证据

| 验证类型                       | 结果    | 实际覆盖与边界                                                                                                                                      |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android Kotlin/Java、APK、lint | 通过    | API35编译、min29检查、debug签名校验；lint无错误，少量图标/风格/保守空间检查建议不等于功能失败                                                       |
| JVM协议                        | 7项通过 | 登录成功/失败、禁止重定向与不安全地址、Cookie/CSRF、服务端姓名、地点过期/精度、同名不同ID、上海时间、旧会话不得清掉新登录                           |
| 跨端纯协议                     | 4项通过 | 实际执行ArkTS纯协议函数，几何/换行/时间与V3.2一致，Logo字节一致，客户端接口边界                                                                     |
| 原服务端照片/地点              | 4项通过 | 独立测试库中的认证、账号隔离、地点凭据/半径与历史兼容；没有操作生产数据库                                                                           |
| Android instrumentation        | 6项通过 | 实际Android图形、EXIF和MediaStore；20张合成图、持久回执、重试不重复、创建/发布中断注入、权限/磁盘错误注入、发布后URI字节核对、AndroidKeyStore加解密 |
| 原网站生产构建                 | 通过    | 前端及API类型检查/构建，不表示有部署动作                                                                                                            |
| Robolectric独立图形套件        | 未执行  | Maven重定向到`gcp.mirrors.maven.org`被当前网络策略拒绝；已保存网络草稿但未自动应用。不能标为通过                                                    |
| Harmony全工程/HAP              | 未执行  | 没有DevEco SDK/工具、签名或设备；运行构建前检明确退出，未生成虚假包                                                                                 |

instrumentation不是摄像头连拍：输入是代码生成的JPEG，真正调用了Android图形和系统MediaStore。二十张包含4000×3000及1200×800，EXIF6归正到800×1200。每张发布、读回和回执后才清理私有临时文件；重启队列后每个任务只对应一个媒体库行。

通过应用自己的ContentResolver读取的[4000×3000原生水印样图](samples/emulator-watermark-4000x3000.jpg)与任务SHA256一致，方向归正为1。图中明确写“模拟器测试现场”，不是实拍工地。受Android作用域存储保护，不能用shell直接读取共享目录代替App媒体URI验收。

## 性能记录

[实际模拟器记录](validation/emulator-results.json)：Android15 x86_64、TCG软件CPU、SwiftShader、无KVM。20张合成JPEG的生成、原生水印、媒体发布及解码核对中位约5.20秒/张，第一张4000×3000约23.12秒；首次离线登录Activity冷启动约16.43秒。软件模拟极慢，这些数字只用于可重复功能验证，**不是手机连拍/快门/首帧性能，也不代表已达成现场速度目标**。

没有真实Android手机或HarmonyOS6.1设备，没有真实工地拍摄样本；镜头初始化、GPS获取、实际快门、连续10/20张、预览帧率、温升、真实最大分辨率和相册App可见性均待实机验收。未用PWA旧测试数字替代原生性能。

## 设备、签名及待完成项

1. 安排至少一台vivo/OPPO/小米或仍支持APK的设备，确认Android版本为10以上，验证登录、权限拒绝、GPS实际精度、持续拍摄20张、横竖屏、相册全部可见、空间不足、强退恢复及覆盖升级。
2. Android长期发行使用工作室受控固定签名。debug证书指纹在核验记录中；换签名可能无法覆盖安装，未保存照片保管前不要卸载。私钥和密码不提交Git或聊天。
3. 提供HarmonyOS6.1完整版本/API号和匹配DevEco/SDK环境，完成真实SDK类型检查及网络适配；再配置开发者账号、设备UDID、证书/profile并生成签名HAP。当前不能把APK作为6.1原生包。
4. 核验Harmony相册持续写入授权能否授予普通内部App；不能授予时保留系统确认路径，自动保存目标需平台允许的授权，不能伪装实现。
5. 如需运行Robolectric额外图形套件或直接阅读鸿蒙官方文档，审阅并发布环境网络草稿（新增Maven镜像和`developer.huawei.com`）；草稿不会自己改变当前环境。

本轮无需更新服务器。生产网站仍是原V3.2运行版本，开发分支的原生代码不会自动部署。
