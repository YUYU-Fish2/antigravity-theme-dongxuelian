import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThemeCss } from '../src/assets.js';

const ROOT = new URL('../', import.meta.url);
const css = buildThemeCss({ rootDir: ROOT });

test('样式严格限定于浅色模式且不含禁用属性', () => {
  assert.ok(css.includes('html:has(> body.theme-light)'), '缺少 html:has(> body.theme-light) 令牌作用域');
  assert.ok(css.includes('body.theme-light'), '缺少 body.theme-light 作用域');
  assert.ok(!/theme-dark/i.test(css), '不应包含 theme-dark 规则');
  assert.ok(!/backdrop-filter\s*:/i.test(css), '不应使用 backdrop-filter');
  assert.ok(!/font-size\s*:/i.test(css), '不应写死字号 font-size');
});

test('包含冬雪莲预览版 6 核心调色板与连续纸面规则', () => {
  for (const hex of [
    '#F7F3EB',
    '#FFFDF8',
    '#EDECE9',
    '#2C4268',
    '#5C6578',
    '#536B9E',
    '#435882',
    '#DDE4EF',
    '#DDE8FA',
  ]) {
    assert.ok(css.includes(hex), `缺少核心色值 ${hex}`);
  }
  assert.ok(css.includes('640px 640px'), '缺少 640px 纸纹平铺尺寸');
  assert.ok(css.includes('rgb(250 245 235 / 0.35)'), '缺少暖纸白 35% 柔和蒙层');
});

test('包含 @container 响应式抱书构图、防穿透卡片、渐隐条修正与偏移开关', () => {
  assert.ok(css.includes('@container dxl-reading'), '缺少 @container dxl-reading 容器查询');
  assert.ok(css.includes('(max-width: 899.98px)'), '缺少窄列媒体/容器断点');
  assert.ok(css.includes('(max-width: 640px)'), '缺少极窄列断点');
  assert.ok(css.includes('(min-width: 900px) and (max-width: 1099.98px)'), '缺少窗口模式断点');
  assert.ok(css.includes('(min-width: 1100px)'), '缺少宽屏断点');
  assert.ok(css.includes('mask-composite: intersect'), '缺少边缘交集渐隐遮罩');
  assert.ok(css.includes('html:not([data-dxl-shift="off"])'), '缺少 --no-shift 禁用开关');
  assert.ok(css.includes('[class*="after:from-background"]::after'), '缺少顶部分组 sticky 渐隐覆盖');
  assert.ok(
    css.includes('[data-dxl-stage="conversation"] .bottom-0.pointer-events-none') &&
      css.includes('[data-testid="autoscroll-viewport"]'),
    '缺少底部实色渐隐条清空及滚动视口 mask-image 柔边规则',
  );
  assert.ok(css.includes('[role="menu"]'), '缺少实色纸白弹窗/菜单规则');
  assert.ok(css.includes('body.theme-light [data-dxl-avatar]'), '缺少侧栏头像浅色展示规则');
  assert.ok(
    css.includes('[data-testid="app-icon-new-conversation-button"]:has([data-dxl-avatar="true"]) > svg') &&
      css.includes('[data-testid="app-icon-new-conversation-button"] > [data-dxl-avatar]'),
    '缺少左上角原生图标原地替换规则',
  );
  assert.ok(css.includes('--shell: #F7F3EB !important'), '缺少 --shell 暖纸底覆盖');
  assert.ok(css.includes('--onyx-raised: #FFFDF8 !important'), '缺少 --onyx-raised 纸白卡片覆盖');
  assert.ok(
    css.includes('.agy-shell') && css.includes('.agy-inset-shell') && css.includes('[data-main-content-body]'),
    '缺少 Antigravity 外壳与主画布透明穿透规则',
  );
  assert.ok(
    css.includes('opacity: 1 !important;') && css.includes('clip-path: none !important;'),
    '缺少对 Antigravity 原生 ::before 遮罩隐藏的显式覆盖',
  );
  assert.ok(
    css.includes('.surface-composer-card') &&
      css.includes('--onyx-frame: #F1EDE5 !important') &&
      !/#antigravity\\\.agentSidePanelInputBox:focus-within\s*\{[^}]*background-color:\s*var\(--dxl-accent\)/s.test(css) &&
      css.includes('margin-left: clamp(28px, calc(12cqi - 92px), 220px) !important') &&
      css.includes('right: clamp(-144px, calc(-312px + 17cqi), -28px) !important') &&
      css.includes('max-width: min(768px, max(520px, 55cqi)) !important') &&
      css.includes('@container dxl-reading (min-width: 1700px)') &&
      css.includes('right: clamp(0px, calc(47cqi - 800px), 340px) !important'),
    '缺少输入框纸白卡片、人物右移与超宽全屏内收平衡规则',
  );
  assert.ok(
    css.includes(':not([data-has-browser-hole="true"]):not([data-has-drawer-browser-hole="true"])'),
    '缺少内置浏览器 WebContentsView 透明打孔豁免规则',
  );
});
