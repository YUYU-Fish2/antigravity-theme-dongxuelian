# antigravity-theme-dongxuelian

面向 Google Antigravity 2.x 桌面客户端的「冬雪莲涂鸦主题（暖纸白 + 灰蓝/靛蓝墨）」外部无损主题注入工具，视觉风格与响应式抱书构图移植自原生 DSH 主题项目 `dsh-theme-dongxuelian`（`0.1.0-preview.6`）。

## 方案说明（方案 A：无损外部 CDP 注入）

Google Antigravity 桌面客户端当前仅开放技能（Skills）、规则（Rules）、代理（Agents）、MCP 与侧栏 Aux Pane Webview，未提供可覆盖主聊天界面的官方主题 API。因此本项目采用 **外部 CDP（Chrome DevTools Protocol）运行时注入**：

- **不修改安装包**：不解包、不改写 `resources/app.asar` 或桌面可执行文件，版本更新后不会破坏客户端签名。
- **不侵入官方配置**：不修改 `~/.gemini/config/config.json`、插件清单、账号或模型配置。
- **零第三方运行依赖**：仅使用 `Node.js >= 22` 内置 `fetch`、`WebSocket` 与 `node:*` 标准库，无需 `npm install`。
- **完整可逆**：运行 `remove` 或重启 Antigravity 即可立刻恢复原状。

## 视觉特性

- **仅浅色模式生效**：全部颜色令牌与场景覆盖严格限定在 `html:has(> body.theme-light)` 与 `body.theme-light` 作用域内；将 Antigravity 切换至深色模式（`body.theme-dark`）时自动退出，不残留任何覆盖。
- **暖纸白与蓝墨色板**：以 `#F7F3EB` 纸底、`#FFFDF8` 卡片、`#EDECE9` 侧栏与 `#2C4268` / `#5C6578` 蓝墨正文为核心，配套 `#536B9E` / `#435882` 靛蓝交互高亮与 `#DDE4EF` / `#DDE8FA` 用户气泡及选中行。
- **全页连续纸面**：使用 `paper.webp`（640px 平铺 + 35% 暖纸白柔光层）贯通侧栏、顶栏与对话画布，消除竖直纸板接缝，并修正对话列表顶/底部渐隐条底色。
- **彩铅抱书场景舞台**：将 `reading.webp` 锚定在主对话舞台（`[data-dxl-stage="conversation"]::before`）负层级，配合 `@container dxl-reading` 容器查询在宽屏（`>=1100px`）、窗口（`900–1099px`）与窄栏（`<900px`）自动调整位置与交集渐隐遮罩，并在打开弹窗/下拉菜单时保持实色 `#FFFDF8` 卡片不透底，同时不硬编码字号、不使用 `backdrop-filter`。
- **可选侧栏头像徽标**：浅色模式下在 `.bg-sidebar` 顶部展示 24px `avatar.webp` 徽标（可通过 `--no-avatar` 关闭）。

## 环境要求

1. **Node.js `>= 22.0.0`**（提供原生全局 `WebSocket` 与 `fetch`）。
2. **已启动的 Google Antigravity 桌面客户端**：
   - 默认读取各平台调试端口文件 `DevToolsActivePort`：
     - Windows：`%APPDATA%\Antigravity\DevToolsActivePort`
     - macOS：`~/Library/Application Support/Antigravity/DevToolsActivePort`
     - Linux：`${XDG_CONFIG_HOME:-~/.config}/Antigravity/DevToolsActivePort`
   - 若你的客户端通过独立参数开启了远程调试（例如 `--remote-debugging-port=9222`），可使用 `--port 9222` 手动指定。

## 快速使用

### 1. 单次注入（适合快速试用）

```bash
npm run inject
# 或在 Windows 上直接双击：inject.bat
```

向当前打开的 Antigravity 页面立即注入样式与 `MutationObserver`，并通过 `Page.addScriptToEvaluateOnNewDocument` 在当前会话刷新时保持生效。客户端完全退出重启后会恢复原生外观。

### 2. 监听模式（多窗口跟踪 + CSS 实时热重载）

```bash
npm run watch
# 或在 Windows 上直接双击：watch.bat
```

持续监听端口与新开窗口（每 2 秒轮询一次 `/json/list`），并监听 [`src/theme.css`](src/theme.css) 文件变化自动热重载，适合日常长驻或调整样式细节；按 `Ctrl+C` 停止。

### 3. 一键移除与还原

```bash
npm run remove
# 或在 Windows 上直接双击：remove.bat
```

若监听进程正在运行则先通过 `.watch.pid` 发送停止信号，随后连接已打开页面清理 `<style id="dxl-antigravity-theme">`、`data-dxl-*` 属性、观察器及侧栏头像；若 Antigravity 未运行则会安全提示并正常退出。

## 命令行选项

所有入口均支持以下参数（通过 `npm run` 传参时请加上 `--`）：

| 参数 | 说明 |
| --- | --- |
| `--port <端口>` | 手动指定本地 CDP 端口（1~65535），跳过 `DevToolsActivePort` 读取 |
| `--no-avatar` | 禁用侧栏顶部 24px 冬雪莲头像徽标 |
| `--no-shift` | 关闭 `>=1100px` 宽屏下对话/输入列的左移微调 |
| `-h`, `--help` | 打印帮助信息 |

示例：

```bash
npm run inject -- --no-avatar --no-shift
npm run watch -- --port 9222
```

## 目录结构

```text
antigravity-theme-dongxuelian/
├─ assets/                    # 沿用自 dsh-theme-dongxuelian 的 WebP 资源与来源说明
│  ├─ characters/web/avatar.webp
│  ├─ scenes/web/reading.webp
│  └─ textures/web/paper.webp
├─ bin/                       # CLI 入口（inject.js / watch.js / remove.js）
├─ src/
│  ├─ assets.js               # 资源预算校验、Base64 Data URI 编码与 CSS 组装
│  ├─ cdp.js                  # 零依赖 CDP 会话客户端与幂等页面注入/卸载脚本
│  ├─ runner.js               # injectOnce / startWatch / watchLoop / removeOnce
│  └─ theme.css               # Antigravity 浅色令牌、连续纸面与响应式抱书舞台样式
├─ scripts/check.mjs          # JS 语法、WebP 资源预算与 CSS 完整性静态校验
├─ test/                      # 资产、CSS 与本地 Mock CDP WebSocket 自动化测试
├─ inject.bat / watch.bat / remove.bat
├─ LICENSE
└─ THIRD_PARTY_NOTICES.md
```

## 本地校验与实窗验收清单

开发与交付前可运行本地自动化测试与静态检查：

```bash
npm test
npm run check
```

> **测试边界说明**：仓库内 `npm test` 与 `npm run check` 使用本地临时 HTTP + RFC 6455 WebSocket 模拟服务端（`test/helpers/mock-cdp.mjs`），**不会触碰或连接你本机正在运行的 Antigravity 实例**。实际客户端外观与布局请由你在本地客户端执行 `inject` / `watch` 后目视确认以下要点：

1. **浅/深色切换**：浅色模式切换至深色模式后，界面应完整恢复原生深色，无残留暖纸底或头像；切回浅色后自动恢复冬雪莲主题。
2. **连续纸面与滚动条**：侧栏与主聊天区呈连续暖纸白纹理、无明显竖切线；聊天列表顶部与底部渐隐区融合自然。
3. **抱书构图与 Aux Pane**：宽屏与打开右侧辅助面板（Aux Pane）缩小聊天栏宽度时，正文可读性清晰、右侧插画柔和退让且不遮挡按钮。
4. **弹窗与菜单**：打开模型选择下拉框、设置弹窗或斜杠命令菜单时，卡片背景保持 `#FFFDF8` 实色且无插画穿透。
5. **无损移除**：执行 `npm run remove` 后页面恢复原生浅色外观且无遗留 DOM 节点。

## 许可与致谢

本项目采用 [MIT License](LICENSE)，第三方公开项目思路参考与素材版权说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
