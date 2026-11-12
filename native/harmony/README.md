# Harmony原生ArkTS工程 · API24目标，待SDK编译

这是ArkTS/ArkUI、Camera Kit、Image Kit、ArkGraphics2D及Media Library Kit工程，不是Android APK或WebView封装。当前环境没有DevEco Studio、HarmonyOS SDK、HAP签名证书或鸿蒙设备，**未编译HAP，未确认HarmonyOS6.1安装与运行；目标Pura70的设备/API信息见 DEVICE-TARGET.md**。

## 已核查与明确限制

已读取并记录官方OpenHarmony公开声明与保存指南，链接、版本和下载指纹见`../shared/protocol-v1.json`：

- `CameraManager.createPhotoOutput`、`PhotoOutput.photoAvailable`与`Photo.main.getComponent(JPEG)`；API12已有预览/照片旋转接口。
- `PhotoAccessHelper.createAsset`受`WRITE_IMAGEVIDEO`约束。官方指南建议第三方也可使用SaveButton或授权保存弹窗，不能把“原生”当作免授权静默写入。
- `showAssetsCreationDialog`自API12提供，单次最多100张，空列表表示取消，返回的是写入授权URI；本工程会写入、同步并比对内容后确认。
- 原生HTTP的`maxRedirects:0`在所读声明中自API23提供。工程在登录前检查该能力门槛，SDK低于23会明确拒绝发送账号密码。**不能从OpenHarmony的API编号推断当前HarmonyOS6.1 SDK映射。** 该映射及更低SDK安全网络替代绑定，必须在目标SDK中核验后再分发。

`build-profile.json5`已按用户提供的Pura70（HBP-AL00）关于本机信息，调整为`6.1.1(24)`。这是已确认的设备目标配置，不是SDK编译结果。实际设备API24满足所查网络API23门槛，但当前环境未安装相应官方SDK、Hvigor配套和HAP签名。`node sdk-preflight.mjs`明确退出2；不能用ArkTS纯协议测试代替工程编译或图库验收。

## 现有实现

登录复用Cookie、Origin和CSRF；会话只在内存，不存密码。精确定位获取真实WGS84，再走同一服务端附近地点和续期接口。无手填地点、无客户端高德Key。

原生后置相机会话提供静态JPEG，预览及合成使用共同的水印规格和原稿Logo。保存队列逐张处理，保留原始/水印私有文件；创建项目、写入和成功阶段落本机账本。若当前设备实际授予相册写入权限，逐张尝试原生自动保存；否则完成后使用系统授权批量保存。没有权限时不会宣称自动入相册。

创建相册项目后进程中断、未得到明确URI时标记待核查，不直接重建。可选取实际相册图片并比对字节确认；拒绝、错误或未确认不会删除私有源文件。不新增云端照片库，不接触旧PWA的IndexedDB。

## 构建、签名、安装

1. 在目标电脑安装与设备HarmonyOS6.1匹配的DevEco Studio及官方SDK，选择与已确认API24对应的SDK，确认ArkTS版本、Camera/Media能力和HTTP禁重定向API。
2. 打开本目录，使用IDE实际提供的Hvigor及ohpm同步，保留Stage模型。根据安装的真实SDK选择产品版本；需要SDK类型检查，不可用`tsc`或Node纯协议测试冒充HAP构建。
3. 修复目标SDK编译/设备差异，尤其是相册授权、HTTP、EXIF方向、XComponent旋转和中文字体。当前源文件尚未经ArkTS全工程编译，这些是明确待验项。
4. 登录工作室受控的开发者账号，在Signing Config使用自动或正式开发签名，按该平台要求登记测试设备UDID和profile。私钥、证书密码、p12/p7b不入Git、不在聊天发送。不得擅自申请付费账号。
5. 用DevEco Build HAP或IDE附带的Hvigor `assembleHap`。仅在文件实际存在且签名核验通过后，通过IDE Run或`hdc install`安装；未签名HAP不承诺可安装。
6. 真机核验登录、GPS/相机授权拒绝、地点90秒过期、20张连拍、横竖屏/像素、自动或授权保存实际结果、空间不足、强退恢复及不重复创建。普通第三方若无法取得持续写权限，必须接受系统确认保存或取得合规平台授权，不能伪造静默自动保存。

本轮的Node测试只执行`Protocol.ets`中的纯协议/布局函数，不测试ArkUI、Camera Kit、媒体库或设备权限。没有HarmonyOS6.1实测记录或HAP文件。


## V2增量整改

统一Brand主题、原稿Logo、登录与地点卡片、固定确认按钮、全屏相机和设置恢复入口；未加入管理系统其他业务模块。搜索复用有效GPS并保留服务端2公里签名规则；无手填地点。

照片暂存与相册复制改用异步文件接口，账本持久成功后更新内存索引；格式不迁移、旧文件不清理。JPEG完整性检查先于解码。系统批量授权期间使用同一串行队列锁，避免定时drain把仍在显示的授权窗口误判成创建中断；二次点击会重新读取账本状态，已保存的项目不重建。明确权限拒绝可重试，创建回执未知仍保留文件并停止自动重建。

这些是实际源码整改，尚待目标SDK全量类型检查、签名和Pura70原生图库实测；没有HAP安装包。
