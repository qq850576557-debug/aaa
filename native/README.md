# 春茉工地拍照 · 独立原生客户端

基线：`3f46936be0cf7fceb7b89e08d6f6777b8eddcd9c`，开发分支 `feat/chunmo-project-manager`。

这里是独立原生工程，不替换React管理系统，不迁移网页照片，不增加业务数据库或云端照片库。

- [Android工程及安装](android/README.md)：Kotlin、CameraX、WorkManager、MediaStore，最低Android 10 / API29。
- [Harmony工程与SDK门槛](harmony/README.md)：ArkTS、ArkUI、Camera Kit、Media Library Kit。SDK、证书及6.1实际API尚需目标环境核验，不能把APK当HAP。
- [共享接口和品牌指纹](shared/protocol-v1.json)：现有Cookie/CSRF/Origin、GPS90秒/100米、服务端高德2公里签名地点，原始Logo字节一致。

## 边界和数据映射

| 现有模块                                              | 原生客户端                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `/api/auth/login`、`/api/auth/session`                | 使用已有账号；Origin及CSRF保留，不新增Token登录接口                   |
| `/api/site-photos/config`                             | 使用服务端返回的账号ID及姓名，表单不允许填写拍摄人                    |
| `/api/site-photos/location`、`/api/site-photos/place` | GPS由设备提供，原始WGS84交给服务端转换/筛选；地图Key继续只在服务端    |
| `photo-layout.ts`、原始Logo                           | 独立原生绘图，复用尺寸、圆形Logo、55%底色、上海时区及每行26字符的规格 |
| PWA `chunmo-photo-batches`、`chunmo-site-photos`      | 完全不读写；原生应用沙箱与浏览器不共享，本次不导入或清理              |
| 原有PostgreSQL、照片目录及上传队列                    | 不变；不调用业务编辑或照片上传接口                                    |
| 新拍摄失败恢复                                        | 仅原生App私有目录内文件与原子任务账本；相册回执确认前保留源文件       |

未连接生产数据和员工手机，实际项目/照片数量与来源未盘点；测试资料不能代替真实盘点。旧PWA仍可独立使用，安装APK不会带走或清除PWA待保存照片。不自动部署阿里云。

## 保存可靠性

Android逐张使用随机任务ID和稳定文件名，先保存原始捕获，再串行合成完整像素水印；MediaStore插入 `IS_PENDING=1`，写入同步、流式SHA256校验、发布和再次读回确认后，才落盘成功回执并清理对应私有临时文件。保存中断先按原URI/文件名核查，不能盲目重复插入。任务账本读写序列化，相机写文件与恢复线程通过锁隔离。

Harmony保留同样的私有文件/账本边界。已取得系统写相册授权时使用原生保存；否则使用系统授权保存对话框，不冒称静默写入。创建回执不明确时停止重复创建，提供用户选择已保存照片后的字节核查路径，只有一致才确认成功。

系统空间确实耗尽、相机尚未完成捕获或应用在原始字节落盘前被系统终止时，不能承诺有一张不存在的完整文件；失败会明确显示，不计入成功保存。已经可靠落盘的原始/水印文件保留用于恢复。卸载App、清除应用数据会清除私有待存文件，未确认相册结果前不要进行这些操作。

## 构建和验证

```bash
# 不依赖任何移动端SDK的共享协议验证（实际执行ArkTS纯协议部分）
node --import tsx --test scripts/native/contracts.test.ts

# Android可独立执行的JVM协议测试、APK和lint
cd native/android
./gradlew -PprotocolOnly testDebugUnitTest assembleDebug lintDebug

# 完整Android图形/恢复测试需要Robolectric运行时依赖
./gradlew testDebugUnitTest
```

`protocolOnly`只选择测试源，不改变App实现或权限。另有严格限制在`ranchu/goldfish`模拟器运行的Android instrumentation测试：生成合成JPEG、处理20张、验证系统媒体库、旋转、回执和恢复，不登录生产账号，不作为真实摄像头或工地摄影验收。详见本轮[交付记录](native-v1-delivery.md)。

签名私钥、密码和开发者账号不提交Git，也不在聊天发送。Android长期内部分发需工作室固定签名；Harmony需在受控DevEco环境完成目标SDK、设备UDID及签名配置。
