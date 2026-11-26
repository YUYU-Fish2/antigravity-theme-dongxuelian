import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { isAntigravityAppUrl } from './cdp.js';
import {
  prepareRuntimePayload,
  resolveRootPath,
  unlinkQuietly,
} from './runner.js';

export const ASAR_BACKUP_SUFFIX = '.dxl-backup';
export const ASAR_PATCH_START = '/* __DXL_THEME_PATCH_START__ */';
export const ASAR_PATCH_END = '/* __DXL_THEME_PATCH_END__ */';
export const ASAR_HOOK_FILENAME = 'dongxuelian-theme.js';
export const ASAR_PAYLOAD_FILENAME = 'dongxuelian-payload.js';
export const ASAR_META_FILENAME = 'dongxuelian-meta.json';
const ASAR_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 计算符合 Electron `@electron/asar` 规范的文件 SHA-256 分块完整性清单。
 * @param {Buffer} data
 * @param {number} [blockSize]
 * @returns {{ algorithm: 'SHA256', hash: string, blockSize: number, blocks: string[] }}
 */
export function computeAsarIntegrity(data, blockSize = ASAR_INTEGRITY_BLOCK_SIZE) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = sha256Hex(buf);
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(hash);
  } else {
    for (let offset = 0; offset < buf.length; offset += blockSize) {
      const end = Math.min(offset + blockSize, buf.length);
      blocks.push(sha256Hex(buf.subarray(offset, end)));
    }
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize,
    blocks,
  };
}

/**
 * 解析 Electron `.asar` 归档头部与数据区起始偏移。
 * @param {Buffer} buffer
 * @returns {{ header: { files: Record<string, any> }, dataStart: number, buffer: Buffer }}
 */
export function parseAsarArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new Error('无效的 ASAR 文件：体积过小。');
  }
  const sizePickleLen = buffer.readUInt32LE(0);
  const headerSize = buffer.readUInt32LE(4);
  const jsonLen = buffer.readUInt32LE(12);
  const dataStart = 8 + headerSize;
  if (sizePickleLen !== 4 || headerSize < 8 || dataStart > buffer.length || 16 + jsonLen > dataStart) {
    throw new Error('无效的 ASAR 文件：Chromium Pickle 头部格式异常。');
  }
  let header;
  try {
    header = JSON.parse(buffer.subarray(16, 16 + jsonLen).toString('utf8'));
  } catch (err) {
    throw new Error(`解析 ASAR 目录头 JSON 失败：${err.message}`);
  }
  if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
    throw new Error('无效的 ASAR 目录头：缺少 files 根节点。');
  }
  return { header, dataStart, buffer };
}

function normalizeAsarEntryPath(rawPath) {
  return String(rawPath || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function findAsarFileNode(header, relPath) {
  const parts = normalizeAsarEntryPath(relPath).split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) {
      return null;
    }
    node = node.files[part];
  }
  return node && !node.files ? node : null;
}

/**
 * 从已解析的 `.asar` 归档中读取单个打包文件的原始内容；不存在或为 unpacked 返回 `null`。
 * @param {{ header: { files: Record<string, any> }, dataStart: number, buffer: Buffer }} archive
 * @param {string} relPath
 * @returns {Buffer|null}
 */
export function readAsarEntryBuffer(archive, relPath) {
  const node = findAsarFileNode(archive.header, relPath);
  if (!node || node.unpacked || typeof node.link === 'string') {
    return null;
  }
  const offset = Number(node.offset);
  const size = Number(node.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
    throw new Error(`ASAR 条目偏移或大小无效：${relPath}`);
  }
  const start = archive.dataStart + offset;
  const end = start + size;
  if (end > archive.buffer.length) {
    throw new Error(`ASAR 条目超出文件范围：${relPath}`);
  }
  return archive.buffer.subarray(start, end);
}

/**
 * 基于原 `.asar` 归档与应用文件覆写/删除表（`null` 表示删除），无损重打包生成新的 `.asar` 二进制缓冲区。
 * 严格保留未修改条目的原始字节、`unpacked: true` 与 `executable: true` 属性。
 * @param {{ header: { files: Record<string, any> }, dataStart: number, buffer: Buffer }} archive
 * @param {Map<string, Buffer|null>} [overrides]
 * @returns {Buffer}
 */
export function buildAsarArchive(archive, overrides = new Map()) {
  const normalizedOverrides = new Map();
  for (const [key, val] of overrides.entries()) {
    normalizedOverrides.set(normalizeAsarEntryPath(key), val);
  }
  const touched = new Set();
  const dataChunks = [];
  let nextOffset = 0;

  const cloneDir = (node, prefix) => {
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      if (key !== 'files') {
        out[key] = val;
      }
    }
    const nextFiles = {};
    for (const [name, child] of Object.entries(node.files || {})) {
      const childPath = prefix ? `${prefix}/${name}` : name;
      if (child && child.files) {
        nextFiles[name] = cloneDir(child, childPath);
        continue;
      }
      if (normalizedOverrides.has(childPath)) {
        touched.add(childPath);
        const replacement = normalizedOverrides.get(childPath);
        if (replacement === null) {
          continue;
        }
        const buf = Buffer.isBuffer(replacement) ? replacement : Buffer.from(replacement);
        nextFiles[name] = {
          size: buf.length,
          offset: String(nextOffset),
          integrity: computeAsarIntegrity(buf),
        };
        if (child?.executable) {
          nextFiles[name].executable = true;
        }
        dataChunks.push(buf);
        nextOffset += buf.length;
        continue;
      }
      if (child?.unpacked || typeof child?.link === 'string') {
        nextFiles[name] = { ...child };
        continue;
      }
      const origOffset = Number(child.offset);
      const size = Number(child.size);
      if (!Number.isFinite(origOffset) || !Number.isFinite(size) || origOffset < 0 || size < 0) {
        throw new Error(`ASAR 源条目偏移或大小无效：${childPath}`);
      }
      const start = archive.dataStart + origOffset;
      const end = start + size;
      if (end > archive.buffer.length) {
        throw new Error(`ASAR 源条目超出文件范围：${childPath}`);
      }
      const slice = archive.buffer.subarray(start, end);
      if (slice.length !== size) {
        throw new Error(`ASAR 源条目读取不完整：${childPath}`);
      }
      nextFiles[name] = {
        ...child,
        size,
        offset: String(nextOffset),
      };
      dataChunks.push(slice);
      nextOffset += size;
    }
    out.files = nextFiles;
    return out;
  };

  const newHeader = cloneDir(archive.header, '');

  // 插入新增文件（支持任意多层父目录）
  for (const [entryPath, value] of normalizedOverrides.entries()) {
    if (touched.has(entryPath) || value === null || !entryPath) {
      continue;
    }
    const parts = entryPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) {
      continue;
    }
    let dirNode = newHeader;
    for (const part of parts) {
      if (!dirNode.files[part]) {
        dirNode.files[part] = { files: {} };
      }
      dirNode = dirNode.files[part];
      if (!dirNode || typeof dirNode !== 'object' || !dirNode.files || typeof dirNode.files !== 'object') {
        throw new Error(`ASAR 覆盖路径冲突：中间节点「${part}」不是目录（${entryPath}）`);
      }
    }
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    dirNode.files[fileName] = {
      size: buf.length,
      offset: String(nextOffset),
      integrity: computeAsarIntegrity(buf),
    };
    dataChunks.push(buf);
    nextOffset += buf.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify(newHeader), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const alignedLen = jsonBuf.length + pad;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedLen, 4);
  headerBuf.writeUInt32LE(4 + alignedLen, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);

  return Buffer.concat([headerBuf, ...dataChunks]);
}

function getHookModulePath(mainEntry) {
  const dir = posix.dirname(normalizeAsarEntryPath(mainEntry));
  const prefix = dir && dir !== '.' ? `${dir}/` : '';
  return {
    hookEntry: `${prefix}${ASAR_HOOK_FILENAME}`,
    payloadEntry: `${prefix}${ASAR_PAYLOAD_FILENAME}`,
    metaEntry: `${prefix}${ASAR_META_FILENAME}`,
  };
}

/**
 * 在 Antigravity 主入口源码中注入幂等的主题引导钩子。
 * @param {string} mainSource
 * @returns {string}
 */
export function patchMainJsSource(mainSource) {
  const clean = unpatchMainJsSource(mainSource);
  const eol = clean.includes('\r\n') ? '\r\n' : '\n';
  const hookBlock = [
    ASAR_PATCH_START,
    `try { require('./${ASAR_HOOK_FILENAME}').install(require('electron').app); } catch {}`,
    ASAR_PATCH_END,
  ].join(eol);

  const whenReadyAnchor = /^[ \t]*[A-Za-z_$][\w$]*(?:\.app)?\s*(?:\r?\n[ \t]*)?\.whenReady\s*\(/m;
  const match = clean.match(whenReadyAnchor);
  if (match && typeof match.index === 'number') {
    return `${clean.slice(0, match.index)}${hookBlock}${eol}${clean.slice(match.index)}`;
  }

  const useStrictMatch = clean.match(/^\s*(['"])use strict\1;[ \t]*(?:\r?\n)?/);
  if (useStrictMatch) {
    const insertAt = useStrictMatch[0].length;
    return `${clean.slice(0, insertAt)}${hookBlock}${eol}${clean.slice(insertAt)}`;
  }
  return `${hookBlock}${eol}${clean}`;
}

/**
 * 移除主入口源码中已注入的冬雪莲主题引导钩子。
 * @param {string} mainSource
 * @returns {string}
 */
export function unpatchMainJsSource(mainSource) {
  const escapedStart = ASAR_PATCH_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = ASAR_PATCH_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`, 'g');
  return String(mainSource || '').replace(pattern, '');
}

/**
 * 判断主入口源码是否已包含冬雪莲补丁标记。
 * @param {string} mainSource
 * @returns {boolean}
 */
export function isMainJsPatched(mainSource) {
  return String(mainSource || '').includes(ASAR_PATCH_START);
}

/**
 * 生成写入 `app.asar` 内部的 CommonJS 主进程注入模块源码。
 * 复用 `isAntigravityAppUrl` 限制目标，禁止注入内置浏览器访问的外站网页。
 * @returns {string}
 */
export function buildAsarHookModuleSource() {
  return [
    "'use strict';",
    "const { webContents } = require('electron');",
    `const payloadScript = require('./${ASAR_PAYLOAD_FILENAME}');`,
    '',
    isAntigravityAppUrl.toString(),
    '',
    'function attachContents(contents) {',
    "  if (!contents || typeof contents.on !== 'function' || contents.isDestroyed?.()) {",
    '    return;',
    '  }',
    "  if (typeof contents.getType === 'function' && contents.getType() === 'webview') {",
    '    return;',
    '  }',
    '  const tryInject = () => {',
    '    if (contents.isDestroyed?.()) return;',
    "    const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';",
    '    if (!isAntigravityAppUrl(currentUrl)) return;',
    '    try {',
    '      Promise.resolve(contents.executeJavaScript(payloadScript, false)).catch(() => {});',
    '    } catch {',
    '      // 忽略页面关闭/重构时的执行异常',
    '    }',
    '  };',
    "  contents.on('dom-ready', tryInject);",
    "  contents.on('did-finish-load', tryInject);",
    "  contents.on('did-navigate-in-page', tryInject);",
    '}',
    '',
    'function install(app) {',
    '  if (!app || app.__dxlThemeInstalled) return;',
    '  app.__dxlThemeInstalled = true;',
    "  app.on('web-contents-created', (_event, contents) => {",
    '    attachContents(contents);',
    '  });',
    "  if (typeof webContents?.getAllWebContents === 'function') {",
    '    for (const contents of webContents.getAllWebContents()) {',
    '      attachContents(contents);',
    '    }',
    '  }',
    '}',
    '',
    'module.exports = { install, isAntigravityAppUrl };',
    '',
  ].join('\n');
}

/**
 * 查找本机 Antigravity 客户端的 `resources/app.asar` 默认路径（支持显式覆盖）。
 * @param {object} [options]
 * @param {string} [options.appAsar]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {{ path: string|null, candidates: string[] }}
 */
export function findAntigravityAsarPath({
  appAsar,
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (typeof appAsar === 'string' && appAsar.trim()) {
    const trimmed = appAsar.trim();
    return { path: existsSync(trimmed) ? trimmed : null, candidates: [trimmed] };
  }
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      join(programFiles, 'Antigravity', 'resources', 'app.asar'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
    );
  } else {
    candidates.push(
      '/opt/Antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      join(home, '.local', 'share', 'Antigravity', 'resources', 'app.asar'),
    );
  }
  const unique = Array.from(new Set(candidates));
  const matched = unique.find((candidate) => existsSync(candidate)) || null;
  return { path: matched, candidates: unique };
}

function readAsarPackageMeta(archive) {
  const pkgBuf = readAsarEntryBuffer(archive, 'package.json');
  if (!pkgBuf) {
    return { mainEntry: 'dist/main.js', appVersion: null };
  }
  try {
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    return {
      mainEntry: normalizeAsarEntryPath(pkg.main || 'dist/main.js'),
      appVersion: pkg.version || null,
    };
  } catch {
    return { mainEntry: 'dist/main.js', appVersion: null };
  }
}

function wrapAsarWriteError(err, asarPath) {
  if (err?.code === 'EBUSY') {
    return new Error(
      `无法写入 ${asarPath}：Antigravity 正在运行并锁定了安装包文件。请先完全退出 Antigravity 桌面客户端后再重试。`,
    );
  }
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    return new Error(
      `写入 ${asarPath} 权限受限或文件正被占用（${err.code}）。请先完全退出 Antigravity，若客户端位于系统目录请以管理员身份运行。`,
    );
  }
  return err;
}

function writeAsarSafely(asarPath, nextBuffer) {
  const dir = dirname(asarPath);
  const tmpPath = join(dir, `.dxl-app-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, nextBuffer);
    // 回读校验一次 Pickle 头部与全部文件边界，确保落盘内容完整
    parseAsarArchive(readFileSync(tmpPath));
    renameSync(tmpPath, asarPath);
  } catch (err) {
    unlinkQuietly(tmpPath);
    throw wrapAsarWriteError(err, asarPath);
  }
}

/**
 * 查询指定（或自动发现的）`app.asar` 当前是否已打入冬雪莲直注补丁。
 * @param {object} [options]
 */
export function getAppAsarStatus(options = {}) {
  const { path: foundPath } = findAntigravityAsarPath(options);
  if (!foundPath) {
    return {
      found: false,
      asarPath: null,
      patched: false,
      backupExists: false,
      appVersion: null,
      meta: null,
    };
  }
  try {
    const archive = parseAsarArchive(readFileSync(foundPath));
    const { mainEntry, appVersion } = readAsarPackageMeta(archive);
    const { metaEntry } = getHookModulePath(mainEntry);
    const mainBuf = readAsarEntryBuffer(archive, mainEntry);
    const metaBuf = readAsarEntryBuffer(archive, metaEntry);
    let meta = null;
    if (metaBuf) {
      try {
        meta = JSON.parse(metaBuf.toString('utf8'));
      } catch {
        meta = null;
      }
    }
    return {
      found: true,
      asarPath: foundPath,
      patched: Boolean(mainBuf && isMainJsPatched(mainBuf.toString('utf8'))),
      backupExists: existsSync(`${foundPath}${ASAR_BACKUP_SUFFIX}`),
      appVersion,
      meta,
    };
  } catch (err) {
    return {
      found: true,
      asarPath: foundPath,
      patched: false,
      backupExists: existsSync(`${foundPath}${ASAR_BACKUP_SUFFIX}`),
      appVersion: null,
      meta: null,
      error: err.message,
    };
  }
}

/**
 * 将冬雪莲浅色主题与离线汉化直接写入 Antigravity 的 `resources/app.asar`，
 * 在客户端更新关闭默认 CDP 调试端口后仍可免调试端口、免后台进程自动生效。
 * @param {object} [options]
 */
export async function patchAppAsar(options = {}) {
  const resolvedRoot = resolveRootPath(options.rootDir);
  const logger = options.logger ?? console;
  const avatar = options.avatar !== false;
  const shift = options.shift !== false;
  const i18n = options.i18n !== false;
  const i18nOverride = options.i18nOverride;

  const { path: foundPath, candidates } = findAntigravityAsarPath(options);
  if (!foundPath) {
    throw new Error(
      `未找到 Antigravity 安装包 app.asar（已检索：${candidates.join('、')}）。可通过 --app-asar <路径> 手动指定。`,
    );
  }

  const rawBuffer = readFileSync(foundPath);
  const archive = parseAsarArchive(rawBuffer);
  const { mainEntry, appVersion } = readAsarPackageMeta(archive);
  const mainBuf = readAsarEntryBuffer(archive, mainEntry);
  if (!mainBuf) {
    throw new Error(`无法在 ${foundPath} 中定位主入口文件 ${mainEntry}`);
  }
  const mainSource = mainBuf.toString('utf8');
  const alreadyPatched = isMainJsPatched(mainSource);

  const backupPath = `${foundPath}${ASAR_BACKUP_SUFFIX}`;
  const backupExisted = existsSync(backupPath);
  // 仅当当前 app.asar 未打补丁（首次打补丁或客户端刚自动更新为新版原包）时刷新备份
  if (!alreadyPatched) {
    try {
      copyFileSync(foundPath, backupPath);
    } catch (err) {
      throw wrapAsarWriteError(err, backupPath);
    }
  }

  const payload = prepareRuntimePayload({
    rootDir: resolvedRoot,
    avatar,
    shift,
    i18n,
    i18nOverride,
  });

  const { hookEntry, payloadEntry, metaEntry } = getHookModulePath(mainEntry);
  const patchedMain = patchMainJsSource(mainSource);
  const payloadSource = `'use strict';\nmodule.exports = ${JSON.stringify(payload.script)};\n`;
  const hookSource = buildAsarHookModuleSource();
  const meta = {
    themeVersion: payload.version,
    appVersion,
    patchedAt: new Date().toISOString(),
    options: { avatar, shift, i18n },
  };

  const overrides = new Map([
    [mainEntry, Buffer.from(patchedMain, 'utf8')],
    [hookEntry, Buffer.from(hookSource, 'utf8')],
    [payloadEntry, Buffer.from(payloadSource, 'utf8')],
    [metaEntry, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8')],
  ]);

  const nextAsar = buildAsarArchive(archive, overrides);
  try {
    writeAsarSafely(foundPath, nextAsar);
  } catch (err) {
    if (!alreadyPatched && !backupExisted) {
      unlinkQuietly(backupPath);
    }
    throw err;
  }

  logger.log(`[冬雪莲 v${payload.version}] 已完成 Antigravity 安装包直注补丁！`);
  logger.log(`  - 目标安装包：${foundPath}${appVersion ? ` (Antigravity ${appVersion})` : ''}`);
  logger.log(`  - 原始备份：${backupPath}`);
  logger.log('  - 下一步：重启 Antigravity 桌面客户端即可立即生效（无需开启调试端口，也无需后台守护进程）。');

  return {
    patched: true,
    alreadyPatched,
    asarPath: foundPath,
    backupPath,
    appVersion,
    themeVersion: payload.version,
    mainEntry,
  };
}

/**
 * 还原 `resources/app.asar` 至未打补丁前的原始状态。
 * 优先使用同版本干净备份文件；若备份缺失或版本已变，则从归档内精准剥离补丁代码。
 * @param {object} [options]
 */
export async function unpatchAppAsar(options = {}) {
  const logger = options.logger ?? console;
  const { path: foundPath, candidates } = findAntigravityAsarPath(options);
  if (!foundPath) {
    throw new Error(
      `未找到 Antigravity 安装包 app.asar（已检索：${candidates.join('、')}）。可通过 --app-asar <路径> 手动指定。`,
    );
  }

  const backupPath = `${foundPath}${ASAR_BACKUP_SUFFIX}`;
  const currentArchive = parseAsarArchive(readFileSync(foundPath));
  const { mainEntry, appVersion } = readAsarPackageMeta(currentArchive);
  const currentMain = readAsarEntryBuffer(currentArchive, mainEntry)?.toString('utf8') || '';
  const patchedNow = isMainJsPatched(currentMain);

  if (!patchedNow) {
    const removedBackup = existsSync(backupPath);
    if (removedBackup) {
      unlinkQuietly(backupPath);
      logger.log(`[冬雪莲] ${foundPath} 未检测到补丁痕迹，已清理残留备份文件：${backupPath}`);
    } else {
      logger.log(`[冬雪莲] ${foundPath} 未检测到补丁痕迹，无需还原。`);
    }
    return { unpatched: true, restoredFrom: 'none', asarPath: foundPath, removedBackup };
  }

  let restoredFrom = 'strip';
  if (existsSync(backupPath)) {
    try {
      const backupBuf = readFileSync(backupPath);
      const backupArchive = parseAsarArchive(backupBuf);
      const backupMeta = readAsarPackageMeta(backupArchive);
      const backupMain = readAsarEntryBuffer(backupArchive, backupMeta.mainEntry)?.toString('utf8') || '';
      if (!isMainJsPatched(backupMain) && (!appVersion || backupMeta.appVersion === appVersion)) {
        writeAsarSafely(foundPath, backupBuf);
        restoredFrom = 'backup';
      }
    } catch {
      // 备份损坏时退回从当前归档精准剥离
    }
  }

  if (restoredFrom !== 'backup' && patchedNow) {
    const { hookEntry, payloadEntry, metaEntry } = getHookModulePath(mainEntry);
    const cleanMain = unpatchMainJsSource(currentMain);
    const overrides = new Map([
      [mainEntry, Buffer.from(cleanMain, 'utf8')],
      [hookEntry, null],
      [payloadEntry, null],
      [metaEntry, null],
    ]);
    writeAsarSafely(foundPath, buildAsarArchive(currentArchive, overrides));
  }

  const removedBackup = existsSync(backupPath);
  unlinkQuietly(backupPath);

  logger.log(`[冬雪莲] 已还原 Antigravity 安装包：${foundPath}（方式：${restoredFrom === 'backup' ? '原始备份还原' : '补丁剥离'}）。`);
  logger.log('  - 请重启 Antigravity 桌面客户端以恢复原生未修改状态。');

  return {
    unpatched: true,
    restoredFrom,
    asarPath: foundPath,
    removedBackup,
  };
}
