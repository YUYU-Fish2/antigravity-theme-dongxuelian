# Third-party references

- 本项目的视觉配色、纸纹平铺与抱书构图设计移植自原生 DSH 主题项目 `dsh-theme-dongxuelian`（MIT）。
- Antigravity 2.x 桌面端的 CDP 运行时注入思路及部分 CSS 变量 / 选择器结构参考了以下公开 MIT 项目中的公开资料：
  - [AlexByoung/Claudized-Antigravity](https://github.com/AlexByoung/Claudized-Antigravity)（`html:has(> body.theme-light)` 覆盖内联样式机制、组件选择器及 `node >= 22` 内置 `fetch` / `WebSocket` CDP 方案）
  - [Cmochance/agent-theme](https://github.com/Cmochance/agent-theme)（Antigravity 滚动渐隐条、`blockquote` / `code` / `pre` 等兼容细节）
- 内置界面简体中文词典（`assets/i18n/zh-CN.json`）与可逆 TreeWalker 汉化引擎思路移植并致谢原独立补丁项目 `chuanban-antigravity-theme-patch`。
- 本项目不引入任何第三方运行依赖。角色素材来源与非官方声明见 `assets/characters/README.md`、`assets/scenes/README.md` 与 `assets/textures/README.md`。
