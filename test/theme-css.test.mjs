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
  assert.ok(css.includes('[role="menu"]'), '缺少实色纸白弹窗/菜单规则');
  assert.ok(css.includes('body.theme-light [data-dxl-avatar]'), '缺少侧栏头像浅色展示规则');
});
