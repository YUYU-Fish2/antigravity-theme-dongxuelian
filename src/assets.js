import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 运行期使用的三项 WebP 资产清单与大小预算（字节）。
 */
export const ASSET_SPECS = Object.freeze({
  avatar: {
    relPath: 'assets/characters/web/avatar.webp',
    budget: 40_000,
    placeholder: '__DXL_AVATAR_URI__',
  },
  reading: {
    relPath: 'assets/scenes/web/reading.webp',
    budget: 550_000,
    placeholder: '__DXL_READING_URI__',
  },
  paper: {
    relPath: 'assets/textures/web/paper.webp',
    budget: 80_000,
    placeholder: '__DXL_PAPER_URI__',
  },
});

const DEFAULT_ROOT = new URL('../', import.meta.url);

/**
 * 校验 WebP 文件头并编码为 Data URI。
 */
export function encodeWebpDataUri(bytes, label = 'asset') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) {
    throw new Error(`${label} 不是有效的 WebP 文件（字节长度不足）`);
  }
  const riff = bytes.toString('ascii', 0, 4);
  const webp = bytes.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    throw new Error(`${label} 文件头不是 RIFF/WEBP`);
  }
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}

/**
 * 读取并编码全部运行期 WebP 资源。
 */
export function loadThemeAssets(rootDir = DEFAULT_ROOT) {
  const result = {};
  for (const [key, spec] of Object.entries(ASSET_SPECS)) {
    const fileUrl = rootDir instanceof URL ? new URL(spec.relPath, rootDir) : join(rootDir, spec.relPath);
    const bytes = readFileSync(fileUrl);
    if (bytes.length >= spec.budget) {
      throw new Error(`${spec.relPath} 超出独立资源预算 ${spec.budget} B（当前 ${bytes.length} B）`);
    }
    result[key] = {
      bytes,
      size: bytes.length,
      dataUri: encodeWebpDataUri(bytes, spec.relPath),
    };
  }
  return result;
}

/**
 * 读取样式模板并内联纸纹与抱书场景资源，生成完整注入 CSS。
 */
export function buildThemeCss({ rootDir = DEFAULT_ROOT, cssPath } = {}) {
  const assets = loadThemeAssets(rootDir);
  const resolvedCssPath =
    cssPath ??
    (rootDir instanceof URL ? new URL('src/theme.css', rootDir) : join(rootDir, 'src/theme.css'));
  let css = readFileSync(resolvedCssPath, 'utf8');

  css = css.replaceAll(ASSET_SPECS.paper.placeholder, assets.paper.dataUri);
  css = css.replaceAll(ASSET_SPECS.reading.placeholder, assets.reading.dataUri);

  const leftover = css.match(/__DXL_[A-Z0-9_]+__/g);
  if (leftover) {
    throw new Error(`样式模板存在未替换占位符: ${[...new Set(leftover)].join(', ')}`);
  }
  return css;
}
