# Android Studio工程

应用名称：春茉工地拍照；包名：`cn.chmsj.photo`。最低Android 10（API29），compile/target SDK35，CameraX1.4.1，Gradle8.9，AGP8.7.3，Kotlin2.0.21。需要完整JDK17或21（不能只有JRE）。本轮不支持Android9及更旧系统，HarmonyOS原生设备不能用APK替代HAP。

## 使用

1. 打开本目录，用Android Studio安装SDK35及对应构建工具。`local.properties`只记录本机SDK路径，不入Git。
2. 使用`./gradlew -PprotocolOnly testDebugUnitTest assembleDebug lintDebug`构建debug包。APK在`app/build/outputs/apk/debug/app-debug.apk`。
3. 将已核验的APK传到公司测试手机，允许该安装来源后安装。已有相同包名时仅用相同签名覆盖更新，不要为解决签名冲突卸载尚有待存照片的App。
4. 登录页默认`https://chmsj.cn`。只支持HTTPS根地址，不携带路径或URL用户名密码；使用现有系统账号登录。
5. 允许使用期间的相机、精确定位并开启GPS，选择服务端返回的地点后拍照。没有常驻后台定位，不申请读取整个相册权限，也不申请Android旧版存储写权限。
6. Android10以上创建本应用的新图片走MediaStore自有媒体能力。相册文件位于`Pictures/春茉工地拍照`。必须收到发布、读取校验回执才计入已保存；失败可重试，原私有文件保留。

## 实现

- 一次相机会话持续复用后置CameraX预览/静态拍照；预览采用完整画面适配，不将预览截图放大作照片。
- 优先较高静态拍照分辨率，实际输出来自设备；EXIF方向归正后全像素合成。没有统一缩至1080P。过大的图像内存不足时保留原文件并显示失败，不伪造成功。
- 水印和预览共用原生布局/绘制函数，原始品牌图在nodpi资源中，受控解码并缓存，防止高DPI设备反复扩大Logo占用内存。
- WorkManager单一队列、文件锁及原子任务账本处理保存。最多积压约12个待处理任务后暂停快门；磁盘剩余不足200MiB时不接受新拍摄。
- Cookie由AndroidKeyStore AES-GCM加密保存，无密码存储，无TLS验证绕过，无HTTP重定向。备份/设备迁移排除私有文件及会话资料。服务器会话仍按原8小时及权限规则失效。
- 本机保存恢复不上传照片，不修改服务器账号/业务记录。拍摄时采用服务端姓名和地点签名；本地文件不是防修改的司法级考勤凭证。

## 测试与签名

`-PprotocolOnly`运行独立JVM协议测试。默认完整图形测试在`app/src/graphicsTest`，使用Robolectric；本轮对应Maven重定向依赖的网络放行仍待环境设置处理。

`app/src/androidTest`是模拟器限定的合成图片测试，使用真正Android图形库和MediaStore。仅在独立测试模拟器执行：

```bash
./gradlew -PprotocolOnly assembleDebug assembleDebugAndroidTest
adb -s emulator-5556 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5556 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5556 shell am instrument -w cn.chmsj.photo.test/androidx.test.runner.AndroidJUnitRunner
```

debug签名仅用于内部验证，不等于工作室长期release签名。**已经安装本测试包的设备，后续覆盖更新必须继续使用包名`cn.chmsj.photo`及同一签名私钥**，不能重新生成debug key或直接换release key；签名证书指纹见构建记录。应先将现有私钥备份到工作室受控密钥库，不得上传下载网站、Git或聊天。未来正式签名切换需另行安排受控迁移或不同包名，不能让监理为更新而卸载含待保存照片的旧版。本工程不自动购买账号、上传商店或部署服务器。

实机门槛：vivo/小米/OPPO/安卓兼容设备的权限拒绝、GPS室内精度、20张实际相机连拍、横竖屏预览/成图一致、原始实际像素、Gallery中全部可见、空间不足、强退恢复和更新不丢待存文件。模拟器输出与纯协议测试不能替代这些验收。


## V2

当前默认`2.0.0-internal`/versionCode2，增量界面、低延迟/后台保存、安全检查更新及签名保留见[交付说明](../../docs/native-photo-v2.md)。`-PphotoVersionCode`和`-PphotoVersionName`用于受控递增发布；ZSL仅在受控A/B测试中传`-PphotoEnableZsl=true`，默认关闭，不用能力标志冒充实测收益。

状态读取使用重启可重建的账本索引；捕获开始回调只取实际时刻，落盘转专用执行器。原账本路径与保存协议不变。测试证据分为JVM、Android真实图形/MediaStore、软件虚拟相机、真实手机，不把合成20张或原生窗口截图当真机连拍20张。
