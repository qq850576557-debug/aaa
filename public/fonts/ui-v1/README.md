# 春茉 UI V1.0 本地字体

| 文件                    | 来源与范围                                                                  | 授权                 |
| ----------------------- | --------------------------------------------------------------------------- | -------------------- |
| `inter-latin.woff2`     | Fontsource Inter 5.2.8，Latin 可变字体的 400–650 字重段                     | `Inter-OFL.txt`      |
| `noto-sans-sc-ui.woff2` | Google Fonts Noto Sans SC，可变字重 400–650，保留仓库界面常用文字与常用姓氏 | `NotoSansSC-OFL.txt` |

本地使用 WOFF2，浏览器以 `font-display: swap` 加载。字形未包含时按 `src/ui-v1/tokens.css` 中的中文字体顺序回退。
