# 品牌字体接入与验证

本次基于 `feat/chunmo-project-manager`，起始 HEAD `08dba4b`、工作区干净。实际修改字体资源、应用组件、CSS 与 HTML，未修改业务模型或 IndexedDB，不切换、合并或修改 main。

## 原始字体与实际代码

上传文件 `方正启体简体.ttf` 可读取，大小 6,570,960 字节。完整原文件保存在 `public/fonts/fangzheng-qiti.ttf`，与附件逐字节一致，SHA-256：

`2ea685171d352183049d70d8cca8419990e8c347071ebdc30b7e7997ceb9ec4e`

从该字体生成 `public/fonts/chunmo-brand.woff`，只包含“春茉空间设计”六字，3,260 字节。逐一比较六字轮廓坐标及字宽，与上传原字体一致，没有重绘或使用近似字体。旧 `chunmo-brand.ttf` 子集保留，避免删除已有资源。

`src/style.css` 的 `@font-face` 优先使用 WOFF，无法加载时使用完整原 TTF，限定对应六字的 Unicode 范围。`index.html` 使用带 crossorigin 的字体预加载。生产页面正常情况下只请求约 3.2KB 的 WOFF，不下载完整大字体；Vite 开发模式可能因 no-cache 出现一次 200 和一次 304 校验，不是重复下载两份字体内容。

`src/App.tsx` 为桌面与手机中文品牌名使用 `.brand-name`，共用 `BRAND_NAME`；英文使用 `.brand-initials` 和 `BRAND_INITIALS`，保持 SJD。CSS 将中文品牌字重固定为 400、禁止合成粗体，明确行高、字距及响应式尺寸。SJD 单独用 Segoe UI / Helvetica Neue / Arial 无衬线字体；正文、标题、表单与业务按钮不使用品牌字体。

没有更换 Logo 图形、重绘图形或改变图形尺寸与 object-fit。当前 `BRAND_LOGO_SRC` 仍为 null：原始图形仅以聊天内联图片提供，没有可读取的本地 PNG/SVG，不能声称原图组合已经核验。品牌名称字体成功接入与原始 Logo 图形待接入是两件独立事项。

如需重新生成 WOFF，可在具有 fontTools 的开发环境执行：

```sh
pyftsubset public/fonts/fangzheng-qiti.ttf --text='春茉空间设计' --flavor=woff --output-file=public/fonts/chunmo-brand.woff
```

该命令是维护资源时使用，不是运行应用所需步骤；用户运行不需要 Python 或安装系统字体。

## 实际浏览器与生产验证

执行了 Chromium 的 `CSS.getPlatformFontsForNode`，检测实际渲染字体，而不是只检查 CSS font-family 字符串：

| 视口           | 字体报告                                        | 字号/字重                       | 结果                               |
| -------------- | ----------------------------------------------- | ------------------------------- | ---------------------------------- |
| 桌面 1440×1000 | FZQiTi-S14S / FZQTJW--GB1-0，自定义字体，6 字形 | 28px / 400，font-synthesis none | 六字均由原字体渲染，无系统字体回退 |
| 手机 390×1000  | 同上，自定义字体，6 字形                        | 22px / 400，font-synthesis none | 中文完整，SJD 保留，页面不横向溢出 |

另行检查 SJD 使用的实际平台字体不是自定义品牌字体，业务标题与按钮的字体栈不含 ChunmoBrand。通过拦截 WOFF 让其无法加载，实际验证完整原 TTF 回退仍渲染全部六字。不是用一个相近系统字体让失败测试通过。

执行 `npm run build` 后，在端口 4173 启动生产预览并重新检查：HTTP 200，桌面和手机实际字体仍为 FZQiTi-S14S，无页面 JS 错误，正常加载只请求 WOFF。`dist/fonts/fangzheng-qiti.ttf` 与原文件逐字节一致。

生产验证证据位于本次云工作区：

- `/workspace/chunmo-brand-validation/production-fonts.json`
- `/workspace/chunmo-brand-validation/production-1440.png`
- `/workspace/chunmo-brand-validation/production-390.png`

测试全部使用独立浏览器上下文，未读取、清除或覆盖用户的浏览器数据。

## 回归中的问题与处理

第一轮完整回归为 28/29 通过，原有项目卡片手工鼠标拖放序列出现偶发失败。独立真实事件记录连续 6 次操作成功；没有改项目排序实现或削弱保存断言。将回归操作拆为两步：先保留拖影/目标插入线检查并新增 Escape 取消不写入检查，再使用 Playwright 标准原生 `dragTo` 验证排序、关联记录不变及刷新保存。专项连续 4 次通过。最终全量回归 **29/29 通过**。

最终执行结果：

- `npm test`：26/26 通过。
- `npm run test:e2e`：29/29 通过（含 2 项品牌字体专项及全部已有交互回归）。
- 排序专项加强后重复执行：4/4 通过。
- `npm run build`：TypeScript 和 Vite 生产构建通过；仅有 Zod 上游注释警告。
- `npm run format:check` 与 `git diff --check`：通过。
- 生产预览 4173：HTTP 200、桌面与手机各 6 个实际自定义字形、无页面 JS 错误。

品牌专项包含真实自定义字形检查和 WOFF 失败后原 TTF 回退；旧项目、工期、JSON、PNG、保存失败保护均继续纳入完整回归。

## Windows 实机验收状态

**当前执行环境是 Linux，没有 Windows Chrome/Edge 实机或远程会话，因此尚未完成 Windows 原生字体栅格化、ClearType 和系统缩放的实际验收。** 没有用 Windows User-Agent 模拟结果冒充 Windows 实测。WOFF/TTF 是网页内嵌字体，不依赖 Windows 是否安装该字体；这说明加载方式，不等于 Windows 实机已通过。

在 Windows 上使用当前功能分支的最新代码，在项目目录运行（PowerShell 如受 npm.ps1 执行策略影响可使用 npm.cmd）：

```powershell
npm.cmd ci
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

打开本机 `http://127.0.0.1:5173/`，分别使用 Chrome 和 Edge：

1. 看左上角六字完整、笔画清晰，SJD 不被改成其他缩写；不要把其他位置的系统正文当成品牌字体。
2. DevTools → Elements → 选中 `.brand-name` → Computed → Rendered Fonts，确认字体为 `FZQiTi-S14S`（PostScript 名 `FZQTJW--GB1-0`）。Network 中确认 WOFF 成功加载。无需在 Windows 安装 TTF。
3. 检查 100%、125%、150% 浏览器缩放下的字形、对齐和文字裁切；缩窄窗口核对手机品牌条。系统显示缩放与浏览器缩放是两个不同设置，分别检查。
4. 打开项目表单，确认业务正文、日期、按钮仍为无衬线字体；关闭浮窗后检查原工期和数据仍在。
5. 检查生产构建：

```powershell
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

打开本机 `http://127.0.0.1:4173/` 复验字体。4173 与 5173 是不同网站源，使用不同的 IndexedDB；生产预览初始为空不代表原端口的数据丢失，不要清理浏览器存储。

云端内部的 localhost 不是用户电脑可直接打开的公网预览。本机已有数据时继续使用原来的协议、域名和端口；`localhost` 与 `127.0.0.1` 也是不同网站源。

## 实际修改文件

- `src/App.tsx`：品牌中文/英文专属类名，共用品牌常量。
- `src/style.css`：真实字体来源、Unicode 限定、字重、字距、响应式与 SJD 字体隔离。
- `index.html`：小体积 WOFF 预加载。
- `public/fonts/fangzheng-qiti.ttf`：完整上传原字体。
- `public/fonts/chunmo-brand.woff`：真实六字 WOFF 子集。
- `tests/brand.spec.ts`：实际平台字体及原 TTF 回退验收。
- `tests/stage3.spec.ts`：保留排序数据断言，增加取消检查并改用标准原生拖放动作。
- `README.md`、本记录：资源来源、验证边界和本地运行方法。
