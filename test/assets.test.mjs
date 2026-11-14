import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSET_SPECS, buildThemeCss, encodeWebpDataUri, loadThemeAssets } from '../src/assets.js';

const ROOT = new URL('../', import.meta.url);

test('WebP 资源均存在且符合字节预算与 RIFF/WEBP 头校验', () => {
  const assets = loadThemeAssets(ROOT);
  for (const [key, spec] of Object.entries(ASSET_SPECS)) {
    const item = assets[key];
    assert.ok(item, `缺少资源: ${key}`);
    assert.ok(item.size > 100 && item.size < spec.budget, `${key} 大小异常: ${item.size}`);
    assert.match(item.dataUri, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
  }
});

test('encodeWebpDataUri 拒绝无效或非 WebP 缓冲区', () => {
  assert.throws(() => encodeWebpDataUri(Buffer.from('short'), 'bad'), /字节长度不足/);
  assert.throws(() => encodeWebpDataUri(Buffer.from('PNG_NOT_WEBP_DATA'), 'bad'), /RIFF\/WEBP/);
});

test('buildThemeCss 完成全部占位符替换且不留残留占位符', () => {
  const css = buildThemeCss({ rootDir: ROOT });
  assert.ok(!css.includes('__DXL_'), '构建后 CSS 仍含未替换占位符');
  assert.ok(css.includes('data:image/webp;base64,'), '构建后 CSS 未内联 WebP Data URI');
});

test('buildThemeCss 在模板存在未知占位符时抛错', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dxl-css-test-'));
  try {
    const tempCss = join(tempDir, 'broken.css');
    writeFileSync(tempCss, 'body.theme-light { background: url("__DXL_UNKNOWN_URI__"); }', 'utf8');
    assert.throws(
      () => buildThemeCss({ rootDir: ROOT, cssPath: tempCss }),
      /未替换占位符: __DXL_UNKNOWN_URI__/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
