import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildThemeCss, loadThemeAssets } from './assets.js';
import {
  DEFAULT_I18N_RELATIVE_PATH,
  DEFAULT_OVERRIDE_RELATIVE_PATH,
  loadI18nDictionary,
} from './i18n.js';
import {
  CdpSession,
  REMOVE_EXPRESSION,
  buildInjectScript,
  fetchBrowserWsUrl,
  getPortFilePath,
  isAntigravityAppUrl,
  listPages,
  readBrowserEndpoint,
  readPort,
  validatePort,
} from './cdp.js';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveRootPath(rootDir = DEFAULT_ROOT) {
  if (rootDir instanceof URL) {
    return fileURLToPath(rootDir);
  }
  return rootDir ? String(rootDir) : DEFAULT_ROOT;
}

/**
 * 读取项目版本号，失败时回退到 `0.1.0`。
 * @param {string} rootDir
 * @returns {string}
 */
export function readPackageVersion(rootDir = DEFAULT_ROOT) {
  try {
    const pkgPath = join(resolveRootPath(rootDir), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    // 忽略读取异常并返回默认版本
  }
  return '0.1.0';
}

/**
 * 解析命令行参数。
 * @param {string[]} [argv]
 * @returns {{ port: number|undefined, avatar: boolean, shift: boolean, i18n: boolean, i18nOverride: string|undefined, daemon: boolean, ifNotRunning: boolean, help: boolean }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    port: undefined,
    avatar: true,
    shift: true,
    i18n: true,
    i18nOverride: undefined,
    daemon: false,
    ifNotRunning: false,
    help: false,
  };

  const validateNonEmptyPath = (value, message) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      throw new Error(message);
    }
    return trimmed;
  };

  const readNextOptionValue = (index, missingMessage) => {
    const next = argv[index + 1];
    // 仅把 `--xxx` / `-h` 视为下一个选项，允许以单个 `-` 开头的路径值
    if (next === undefined || next.startsWith('--') || next === '-h') {
      throw new Error(missingMessage);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--daemon') {
      options.daemon = true;
      continue;
    }
    if (arg === '--if-not-running') {
      options.ifNotRunning = true;
      continue;
    }
    if (arg === '--no-avatar') {
      options.avatar = false;
      continue;
    }
    if (arg === '--no-shift') {
      options.shift = false;
      continue;
    }
    if (arg === '--no-i18n') {
      options.i18n = false;
      continue;
    }
    if (arg === '--i18n-override') {
      options.i18nOverride = validateNonEmptyPath(
        readNextOptionValue(i, '--i18n-override 需要传入覆盖词典文件路径'),
        '--i18n-override 需要传入有效的覆盖词典文件路径',
      );
      i += 1;
      continue;
    }
    if (arg.startsWith('--i18n-override=')) {
      options.i18nOverride = validateNonEmptyPath(
        arg.slice('--i18n-override='.length),
        '--i18n-override 需要传入有效的覆盖词典文件路径',
      );
      continue;
    }
    if (arg === '--app-asar') {
      options.appAsar = validateNonEmptyPath(
        readNextOptionValue(i, '--app-asar 需要传入有效的 app.asar 文件路径'),
        '--app-asar 需要传入有效的 app.asar 文件路径',
      );
      i += 1;
      continue;
    }
    if (arg.startsWith('--app-asar=')) {
      options.appAsar = validateNonEmptyPath(
        arg.slice('--app-asar='.length),
        '--app-asar 需要传入有效的 app.asar 文件路径',
      );
      continue;
    }
    if (arg === '--port') {
      options.port = validatePort(
        readNextOptionValue(i, '--port 需要传入 1~65535 的整数端口号'),
      );
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = validatePort(arg.slice('--port='.length));
      continue;
    }
    throw new Error(`未知参数：${arg}。可使用 --help 查看帮助。`);
  }

  return options;
}

/**
 * 生成 CLI 帮助文本。
 * @param {string} [commandName]
 * @returns {string}
 */
export function formatUsage(commandName = 'inject') {
  const npmScriptName =
    commandName === 'install'
      ? 'install-theme'
      : commandName === 'uninstall'
        ? 'uninstall-theme'
        : commandName;
  return [
    `冬雪莲 Antigravity 桌面端主题工具 (${commandName})`,
    '',
    '用法：',
    `  npm run ${npmScriptName} -- [选项]`,
    `  node bin/${commandName}.js [选项]`,
    '',
    '选项：',
    '  --port <端口>             手动指定 Antigravity CDP 端口（默认读取 DevToolsActivePort）',
    '  --no-avatar               不注入侧边栏 24px 冬雪莲头像徽标',
    '  --no-shift                关闭对话流居中阅读偏移微调',
    '  --no-i18n                 关闭界面简体中文汉化（若已汉化则自动还原英文）',
    '  --i18n-override <路径>    指定额外的用户覆盖词典 JSON 文件',
    '  --app-asar <路径>         手动指定 Antigravity resources/app.asar 路径（用于 patch-app/unpatch-app）',
    '  --daemon                  以无交互后台日志模式运行监听（主要用于自启守护）',
    '  --if-not-running          仅在当前无运行中监听进程时启动（避免重复守护）',
    '  -h, --help                显示此帮助信息',
  ].join('\n');
}

const PAYLOAD_FINGERPRINT_FILES = Object.freeze([
  'package.json',
  'src/theme.css',
  'src/cdp.js',
  'src/i18n.js',
  'src/assets.js',
  'assets/characters/web/avatar.webp',
  'assets/scenes/web/reading.webp',
  'assets/textures/web/paper.webp',
]);

function statFingerprint(filePath) {
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function computePayloadFingerprint({ resolvedRoot, avatar, shift, i18n, i18nOverride }) {
  const overridePath =
    typeof i18nOverride === 'string' && i18nOverride.trim()
      ? resolve(process.cwd(), i18nOverride.trim())
      : '';
  const files = {};
  for (const rel of PAYLOAD_FINGERPRINT_FILES) {
    files[rel] = statFingerprint(join(resolvedRoot, rel));
  }
  if (i18n) {
    files[DEFAULT_I18N_RELATIVE_PATH] = statFingerprint(join(resolvedRoot, DEFAULT_I18N_RELATIVE_PATH));
    files[DEFAULT_OVERRIDE_RELATIVE_PATH] = statFingerprint(
      join(resolvedRoot, DEFAULT_OVERRIDE_RELATIVE_PATH),
    );
    if (overridePath) {
      files[`override:${overridePath}`] = statFingerprint(overridePath);
    }
  }
  return JSON.stringify({
    resolvedRoot,
    avatar: Boolean(avatar),
    shift: Boolean(shift),
    i18n: Boolean(i18n),
    overridePath,
    files,
  });
}

/**
 * 构建当前配置对应的 CSS 与完整注入脚本（传入 `cacheFile` 时自动复用预编译指纹缓存）。
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {boolean} [options.avatar]
 * @param {boolean} [options.shift]
 * @param {boolean} [options.i18n]
 * @param {string} [options.i18nOverride]
 * @param {string} [options.cacheFile]
 * @returns {{ css: string, script: string, version: string, fromCache: boolean }}
 */
export function prepareRuntimePayload({
  rootDir = DEFAULT_ROOT,
  avatar = true,
  shift = true,
  i18n = true,
  i18nOverride,
  cacheFile,
} = {}) {
  const resolvedRoot = resolveRootPath(rootDir);
  let fingerprint = '';
  if (cacheFile) {
    fingerprint = computePayloadFingerprint({ resolvedRoot, avatar, shift, i18n, i18nOverride });
    try {
      if (existsSync(cacheFile)) {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
        if (
          cached &&
          cached.fingerprint === fingerprint &&
          typeof cached.script === 'string' &&
          typeof cached.version === 'string'
        ) {
          return { css: '', script: cached.script, version: cached.version, fromCache: true };
        }
      }
    } catch {
      // 缓存损坏时回退重新编译
    }
  }

  const assets = loadThemeAssets(resolvedRoot);
  const css = buildThemeCss({ rootDir: resolvedRoot, assets });
  const version = readPackageVersion(resolvedRoot);
  const i18nDict = i18n ? loadI18nDictionary({ rootDir: resolvedRoot, overridePath: i18nOverride }).dict : null;
  const script = buildInjectScript(css, {
    avatarDataUri: avatar ? assets.avatar.dataUri : '',
    avatar,
    shift,
    i18n,
    i18nDict,
    version,
  });

  if (cacheFile) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fingerprint, version, script }), 'utf8');
      renameSync(tmp, cacheFile);
    } catch {
      // 写入缓存失败不影响正常注入流程
    }
  }

  return { css, script, version, fromCache: false };
}

function warnIfConflicts(evalResult, pageLabel, logger) {
  const conflicts = evalResult?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    logger?.warn?.(
      `[冬雪莲] 警告：页面「${pageLabel}」检测到同时启用其他 CDP 主题（${conflicts.join(', ')}），可能产生样式互相覆盖；请先停用或卸载冲突主题后再注入。`,
    );
  }
}

async function injectPageSession(session, script, { pageLabel = '', logger } = {}) {
  // 优先执行首屏注入同时启用 Page 域，缩短首次视觉切换等待
  const [evalResult] = await Promise.all([
    session.evaluate(script),
    session.send('Page.enable'),
  ]);
  warnIfConflicts(evalResult, pageLabel, logger);
  const registered = await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: script,
  });
  return {
    evalResult,
    scriptId: registered?.identifier ?? null,
  };
}

/**
 * 单次连接所有已打开的 Antigravity 页面并注入冬雪莲主题。
 * @param {object} [options]
 * @returns {Promise<{ port: number, injectedCount: number, results: Array<any> }>}
 */
export async function injectOnce(options = {}) {
  const {
    rootDir = DEFAULT_ROOT,
    port,
    portFile = getPortFilePath(),
    avatar = true,
    shift = true,
    i18n = true,
    i18nOverride,
    fetchImpl,
    WebSocketImpl,
    timeoutMs = 5000,
    logger = console,
  } = options;

  const targetPort = readPort(portFile, { port });
  const pages = await listPages(targetPort, { fetchImpl, timeoutMs });
  if (pages.length === 0) {
    logger.warn(`[冬雪莲] 在端口 ${targetPort} 未发现可注入的 Antigravity 页面窗口。`);
    return { port: targetPort, injectedCount: 0, results: [], failures: [] };
  }

  const { script, version } = prepareRuntimePayload({ rootDir, avatar, shift, i18n, i18nOverride });
  const results = [];
  const failures = [];

  for (const page of pages) {
    const session = new CdpSession(page.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
    try {
      await session.connect();
      const { evalResult, scriptId } = await injectPageSession(session, script, {
        pageLabel: page.title || page.id,
        logger,
      });
      results.push({
        id: page.id,
        title: page.title || '',
        url: page.url || '',
        scriptId,
        evalResult,
      });
    } catch (err) {
      // 单个页面失败不影响其余窗口
      failures.push({ id: page.id, title: page.title || '', error: err.message });
      logger.warn(`[冬雪莲] 注入页面失败（${page.title || page.id}）：${err.message}`);
    } finally {
      await session.close().catch(() => {});
    }
  }

  if (results.length === 0) {
    throw new Error(`全部 ${failures.length} 个页面注入失败：${failures.map((f) => f.error).join('；')}`);
  }
  logger.log(
    `[冬雪莲 v${version}] 已向 ${results.length} 个 Antigravity 页面注入主题（端口 ${targetPort}）${failures.length ? `，${failures.length} 个页面失败` : ''}。`,
  );
  return { port: targetPort, injectedCount: results.length, results, failures };
}

export function unlinkQuietly(filePath) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // 忽略清理文件异常
  }
}

/**
 * 仅在 PID 文件内容确属指定进程时才删除，避免旧进程退出时误删新守护写入的 PID。
 * @param {string} pidFile
 * @param {number} [ownerPid]
 */
export function unlinkPidFileIfOwned(pidFile, ownerPid = process.pid) {
  if (!pidFile || !existsSync(pidFile)) {
    return false;
  }
  try {
    const recorded = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (recorded === ownerPid) {
      unlinkSync(pidFile);
      return true;
    }
  } catch {
    // 忽略读取或清理失败
  }
  return false;
}

/**
 * 检查指定 PID 进程是否存活。
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 探测指定 PID 的进程类型。
 * @param {number} pid
 * @returns {'node'|'other'|'dead'|'unknown'} `unknown` 表示进程存活但无法确认其映像（探测命令失败或超时）
 */
export function getNodeProcessStatus(pid) {
  if (!isProcessAlive(pid)) {
    return 'dead';
  }
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000,
      });
      if (!out.includes(`"${pid}"`)) {
        // tasklist 未列出该 PID：进程已退出
        return isProcessAlive(pid) ? 'unknown' : 'dead';
      }
      return out.toLowerCase().includes('"node.exe"') ? 'node' : 'other';
    }
    if (process.platform === 'linux' && existsSync(`/proc/${pid}/comm`)) {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase();
      return comm.startsWith('node') ? 'node' : 'other';
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return basename(out.trim()).toLowerCase().startsWith('node') ? 'node' : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * 判断指定 PID 是否为存活中的 Node 进程（避免重启后 PID 复用导致误判或误杀）。
 * @param {number} pid
 * @param {object} [options]
 * @param {boolean} [options.assumeOnUnknown] 无法确认进程映像时的返回值（默认 true：保守视为仍在运行）
 * @returns {boolean}
 */
export function isNodeProcessPid(pid, { assumeOnUnknown = true } = {}) {
  const status = getNodeProcessStatus(pid);
  if (status === 'unknown') {
    return assumeOnUnknown;
  }
  return status === 'node';
}

/**
 * 读取 `.watch.pid` 文件中记录的存活 Node 进程 PID；若进程已退出或已被其他程序复用则清理文件。
 * @param {string} pidFile
 * @param {object} [options]
 * @param {boolean} [options.assumeOnUnknown] 无法确认进程映像时是否仍视为守护进程（默认 true，避免重复拉起）
 * @returns {number|null}
 */
export function readLiveWatcherPid(pidFile, { assumeOnUnknown = true } = {}) {
  if (!pidFile || !existsSync(pidFile)) {
    return null;
  }
  let parsedPid = null;
  try {
    const pidText = readFileSync(pidFile, 'utf8').trim();
    const candidate = Number.parseInt(pidText, 10);
    if (Number.isInteger(candidate) && candidate > 0) {
      parsedPid = candidate;
    }
  } catch {
    return null;
  }
  if (!parsedPid) {
    unlinkQuietly(pidFile);
    return null;
  }
  const status = getNodeProcessStatus(parsedPid);
  if (status === 'dead' || status === 'other') {
    unlinkQuietly(pidFile);
    return null;
  }
  if (status === 'unknown' && !assumeOnUnknown) {
    return null;
  }
  return parsedPid;
}

export function tryStopWatcherByPidFile(pidFile, logger) {
  // 发送终止信号前必须确认是 Node 进程：无法确认时宁可不杀，避免误伤复用 PID 的其他程序
  const pid = readLiveWatcherPid(pidFile, { assumeOnUnknown: false });
  if (!pid) {
    if (existsSync(pidFile)) {
      logger?.warn?.('[冬雪莲] 无法确认 .watch.pid 记录的进程身份，已跳过停止操作。');
    }
    return { signaled: false, pid: null };
  }
  let signaled = false;
  // 主动停止前先清理 PID 文件，通知外层 VBScript 守候进程正常退出而不是触发崩溃复活
  unlinkQuietly(pidFile);
  try {
    if (pid !== process.pid) {
      process.kill(pid, 'SIGTERM');
      signaled = true;
      logger?.log?.(`[冬雪莲] 已向监听进程 (PID ${pid}) 发送停止信号。`);
    }
  } catch (err) {
    if (err?.code === 'ESRCH') {
      unlinkQuietly(pidFile);
    }
  }
  return { signaled, pid };
}

export function cleanupExitedPidFile(pidFile, pid) {
  if (!pidFile || !pid || !existsSync(pidFile)) {
    return;
  }
  if (!isProcessAlive(pid)) {
    unlinkQuietly(pidFile);
  }
}

/**
 * 在守护日志超过体积上限时轮转为 `.1` 备份，防止长期驻留无限膨胀。
 * @param {string} logFile
 * @param {number} [maxBytes]
 */
export function rotateLogIfNeeded(logFile, maxBytes = 512 * 1024) {
  try {
    if (existsSync(logFile) && statSync(logFile).size >= maxBytes) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // 忽略日志轮转异常
  }
}

/**
 * 创建写入文件并带时间戳的后台守护日志器。
 * @param {string} logFile
 * @returns {{ log: (msg: any) => void, warn: (msg: any) => void, error: (msg: any) => void }}
 */
export function createDaemonLogger(logFile, { maxBytes = 512 * 1024 } = {}) {
  rotateLogIfNeeded(logFile, maxBytes);
  const writeLine = (level, args) => {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const text = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ');
    try {
      // 守护进程常驻期间也要轮转（日志写入频率很低，逐行 stat 的开销可忽略）
      rotateLogIfNeeded(logFile, maxBytes);
      appendFileSync(logFile, `[${ts}] [${level}] ${text}\n`, 'utf8');
    } catch {
      // 忽略日志写入失败
    }
  };
  return {
    log: (...args) => writeLine('INFO', args),
    warn: (...args) => writeLine('WARN', args),
    error: (...args) => writeLine('ERROR', args),
  };
}

/**
 * 停止可能运行中的监听进程，并从已打开的页面中移除全部注入样式、属性与头像。
 * 若 Antigravity 未运行，则优雅退出而不报错。
 * @param {object} [options]
 * @returns {Promise<{ running: boolean, port: number|null, stoppedWatcher: boolean, removedCount: number, results: Array<any> }>}
 */
export async function removeOnce(options = {}) {
  const resolvedRoot = resolveRootPath(options.rootDir);
  const {
    port,
    portFile = getPortFilePath(),
    pidFile = join(resolvedRoot, '.watch.pid'),
    fetchImpl,
    WebSocketImpl,
    timeoutMs = 5000,
    logger = console,
  } = options;

  const { signaled: stoppedWatcher, pid: watcherPid } = tryStopWatcherByPidFile(pidFile, logger);
  if (stoppedWatcher) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    cleanupExitedPidFile(pidFile, watcherPid);
  }

  let targetPort;
  let pages;
  try {
    targetPort = readPort(portFile, { port });
    pages = await listPages(targetPort, { fetchImpl, timeoutMs });
  } catch (err) {
    logger.log(`[冬雪莲] 未检测到运行中的 Antigravity CDP 实例（${err.message}），无需移除。`);
    return {
      running: false,
      port: targetPort ?? null,
      stoppedWatcher,
      removedCount: 0,
      results: [],
    };
  }

  const results = [];
  const failures = [];
  for (const page of pages) {
    const session = new CdpSession(page.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
    try {
      await session.connect();
      const summary = await session.evaluate(REMOVE_EXPRESSION);
      results.push({
        id: page.id,
        title: page.title || '',
        summary,
      });
    } catch (err) {
      // 单个页面清理失败时继续处理其余页面
      failures.push({ id: page.id, title: page.title || '', error: err.message });
      logger.warn(`[冬雪莲] 清理页面失败（${page.title || page.id}）：${err.message}`);
    } finally {
      await session.close().catch(() => {});
    }
  }

  logger.log(
    `[冬雪莲] 已从 ${results.length} 个 Antigravity 页面移除主题样式与 DOM 标记${failures.length ? `（${failures.length} 个页面失败，可重启客户端彻底还原）` : ''}。`,
  );
  if (!options.skipAutostartHint && existsSync(join(resolvedRoot, '.runtime', 'install-state.json'))) {
    logger.log('[冬雪莲] 提示：当前仍启用开机/登录自启，如需彻底取消请执行 npm run uninstall-theme（或双击 uninstall.bat）。');
  }
  return {
    running: true,
    port: targetPort,
    stoppedWatcher,
    removedCount: results.length,
    results,
    failures,
  };
}

/**
 * 启动长期监听会话控制器：自动附加新窗口并热重载样式与汉化配置。
 * @param {object} [options]
 * @returns {Promise<{
 *   stop: () => Promise<void>,
 *   syncNow: () => Promise<number>,
 *   reinjectNow: () => Promise<number>,
 *   getAttachedCount: () => number,
 *   pidFile: string
 * }>}
 */
export async function startWatch(options = {}) {
  const resolvedRoot = resolveRootPath(options.rootDir);
  const {
    port,
    portFile = getPortFilePath(),
    pidFile = join(resolvedRoot, '.watch.pid'),
    payloadCacheFile,
    avatar = true,
    shift = true,
    i18n = true,
    i18nOverride,
    cssDebounceMs = 150,
    fetchImpl,
    WebSocketImpl,
    timeoutMs = 5000,
    logger = console,
    onSync,
    onWaitError,
    onPidWritten,
  } = options;

  const compilePayload = () =>
    prepareRuntimePayload({
      rootDir: resolvedRoot,
      avatar,
      shift,
      i18n,
      i18nOverride,
      cacheFile: payloadCacheFile,
    });

  // 启动时校验一次资产、CSS 与词典，并在首轮同步后立即释放大字符串（约 1.17 MB），避免常驻内存
  let initialPayload = compilePayload();
  let payloadVersion = 0;
  const attached = new Map();
  let stopped = false;
  let browserSession = null;
  let browserEndpointKey = null;
  let syncInFlight = null;
  let syncQueued = false;
  let lastSyncConnected = false;
  let reinjectInFlight = null;
  let reinjectQueued = false;
  let cssTimer = null;
  let portTimer = null;
  let retryTimer = null;
  let reconnectTimer = null;
  const PORT_READY_BACKOFF_MS = [40, 100, 250, 600, 1500];
  const fsWatchers = [];
  let waitErrorLogged = false;

  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  } catch (err) {
    logger.warn(`[冬雪莲] 写入 PID 文件失败（${pidFile}）：${err.message}`);
  } finally {
    onPidWritten?.();
  }

  const runReinjectPass = async () => {
    if (stopped) {
      return 0;
    }
    initialPayload = null;
    let payload;
    try {
      payload = compilePayload();
      payloadVersion += 1;
    } catch (err) {
      logger.warn(`[冬雪莲] 运行时载荷重新编译失败：${err.message}`);
      return 0;
    }

    let updated = 0;
    for (const [pageId, entry] of Array.from(attached.entries())) {
      if (stopped) {
        break;
      }
      try {
        if (entry.scriptId) {
          await entry.session
            .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
            .catch(() => {});
        }
        const registered = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: payload.script,
        });
        entry.scriptId = registered?.identifier ?? null;
        await entry.session.evaluate(payload.script);
        entry.payloadVersion = payloadVersion;
        updated += 1;
      } catch (err) {
        logger.warn(`[冬雪莲] 热更新页面 ${pageId} 失败：${err.message}`);
        attached.delete(pageId);
        await entry.session.close().catch(() => {});
      }
    }
    logger.log(`[冬雪莲] 检测到配置或样式变更，已热重载 ${updated} 个页面。`);
    return updated;
  };

  const reinjectNow = async () => {
    if (stopped) {
      return 0;
    }
    if (reinjectInFlight) {
      reinjectQueued = true;
      return reinjectInFlight;
    }
    reinjectInFlight = (async () => {
      let lastUpdated = 0;
      do {
        reinjectQueued = false;
        lastUpdated = await runReinjectPass();
      } while (reinjectQueued && !stopped);
      return lastUpdated;
    })().finally(() => {
      reinjectInFlight = null;
    });
    return reinjectInFlight;
  };

  let syncNow;

  const ensureBrowserDiscovery = async (targetPort, browserWsPath) => {
    const endpointKey = `${targetPort}${browserWsPath}`;
    if (stopped || (browserSession && !browserSession.closed && browserEndpointKey === endpointKey)) {
      return;
    }
    if (browserSession) {
      const oldSession = browserSession;
      browserSession = null;
      browserEndpointKey = null;
      await oldSession.close().catch(() => {});
    }

    const bindAndDiscover = async (wsUrl) => {
      const session = new CdpSession(wsUrl, { WebSocketImpl, timeoutMs });
      let discoveryReady = false;
      const onTargetUpdate = (detail) => {
        if (stopped) return;
        const info = detail?.targetInfo;
        if (info?.type === 'page' && isAntigravityAppUrl(info.url) && !attached.has(info.targetId)) {
          void syncNow();
        }
      };
      session.on('Target.targetCreated', onTargetUpdate);
      session.on('Target.targetInfoChanged', onTargetUpdate);
      session.on('Target.targetDestroyed', (detail) => {
        const targetId = detail?.targetId;
        const entry = targetId ? attached.get(targetId) : null;
        if (entry) {
          attached.delete(targetId);
          void entry.session.close().catch(() => {});
        }
      });
      session.on('close', () => {
        if (browserSession === session) {
          browserSession = null;
          browserEndpointKey = null;
        }
        // 已建立长连接后断开（例如客户端瞬间重启），安排一次单次重连探测，不使用周期轮询
        if (discoveryReady && !stopped) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!stopped) void syncNow();
          }, 250);
        }
      });

      try {
        await session.connect();
        await session.send('Target.setDiscoverTargets', { discover: true });
        discoveryReady = true;
        if (stopped) {
          await session.close().catch(() => {});
          return null;
        }
        return session;
      } catch (err) {
        await session.close().catch(() => {});
        throw err;
      }
    };

    let session = null;
    try {
      session = await bindAndDiscover(`ws://127.0.0.1:${targetPort}${browserWsPath}`);
    } catch (err) {
      // 显式 --port 或单行端口文件缺少 Browser UUID 时，退回 /json/version 查询一次完整地址
      if (browserWsPath === '/devtools/browser') {
        const resolvedUrl = await fetchBrowserWsUrl(targetPort, { fetchImpl, timeoutMs }).catch(() => null);
        if (resolvedUrl && !stopped) {
          session = await bindAndDiscover(resolvedUrl);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (session && !stopped) {
      browserSession = session;
      browserEndpointKey = endpointKey;
    }
  };

  const runSyncPass = async () => {
    let needsCatchUp = false;
    try {
      const { port: targetPort, browserWsPath } = readBrowserEndpoint(portFile, { port });
      const pages = await listPages(targetPort, { fetchImpl, timeoutMs });
      lastSyncConnected = true;
      waitErrorLogged = false;

      const unattached = pages.filter((page) => !attached.has(page.id));
      if (!stopped && unattached.length > 0) {
        let payload = initialPayload;
        initialPayload = null;
        if (!payload) {
          try {
            payload = compilePayload();
          } catch (err) {
            logger.warn(`[冬雪莲] 运行时载荷编译失败：${err.message}`);
            return needsCatchUp;
          }
        }
        const versionAtInject = payloadVersion;
        const pendingPageIds = new Set();
        await Promise.all(
          unattached.map(async (page) => {
            if (stopped || attached.has(page.id) || pendingPageIds.has(page.id)) {
              return;
            }
            pendingPageIds.add(page.id);
            const session = new CdpSession(page.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
            try {
              await session.connect();
              if (stopped) {
                await session.close().catch(() => {});
                return;
              }
              const { scriptId } = await injectPageSession(session, payload.script, {
                pageLabel: page.title || page.id,
                logger,
              });
              if (stopped) {
                await session.close().catch(() => {});
                return;
              }
              session.on('close', () => {
                attached.delete(page.id);
              });
              attached.set(page.id, {
                session,
                scriptId,
                title: page.title || '',
                payloadVersion: versionAtInject,
              });
              if (versionAtInject !== payloadVersion) {
                needsCatchUp = true;
              }
              logger.log(`[冬雪莲] 已挂载并注入页面：${page.title || page.id}`);
            } catch (err) {
              await session.close().catch(() => {});
              logger.warn(`[冬雪莲] 注入页面失败（${page.id}）：${err.message}`);
            } finally {
              pendingPageIds.delete(page.id);
            }
          }),
        );
      }
      if (!stopped) {
        await ensureBrowserDiscovery(targetPort, browserWsPath).catch(() => {});
        onSync?.({ connected: true, attachedCount: attached.size, port: targetPort });
      }
    } catch (err) {
      lastSyncConnected = false;
      onWaitError?.(err);
      if (!waitErrorLogged) {
        waitErrorLogged = true;
        logger.log(`[冬雪莲] 等待 Antigravity CDP 就绪：${err.message}`);
      }
    }
    return needsCatchUp;
  };

  syncNow = async () => {
    if (stopped) {
      return attached.size;
    }
    if (syncInFlight) {
      syncQueued = true;
      return syncInFlight;
    }
    syncInFlight = (async () => {
      let needsCatchUp = false;
      do {
        syncQueued = false;
        if (await runSyncPass()) {
          needsCatchUp = true;
        }
      } while (syncQueued && !stopped);
      if (needsCatchUp && !stopped) {
        await reinjectNow();
      }
      return attached.size;
    })().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  };

  const syncPortWithBackoff = async (attempt = 0) => {
    if (stopped) return;
    await syncNow();
    if ((!lastSyncConnected || !browserSession) && !stopped && attempt < PORT_READY_BACKOFF_MS.length) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void syncPortWithBackoff(attempt + 1);
      }, PORT_READY_BACKOFF_MS[attempt]);
    }
  };

  const registerDirWatcher = (dir, targetNames, onChange) => {
    const resolvedDir = resolve(dir);
    let activeWatcher = null;
    let activeWatchDir = null;
    let reattachTimer = null;
    let disposed = false;
    let waitingForDir = false;

    const findAnchor = () => {
      let current = resolvedDir;
      let child = null;
      while (!existsSync(current)) {
        const parent = dirname(current);
        if (!parent || parent === current) {
          return null;
        }
        child = basename(current);
        current = parent;
      }
      return {
        watchDir: current,
        childName: child,
        isTarget: current === resolvedDir,
      };
    };

    const hasAnyTargetFile = () => {
      if (!targetNames || targetNames.size === 0) return true;
      for (const name of targetNames) {
        if (existsSync(join(resolvedDir, name))) {
          return true;
        }
      }
      return false;
    };

    const closeActive = () => {
      if (!activeWatcher) return;
      const w = activeWatcher;
      activeWatcher = null;
      activeWatchDir = null;
      try {
        w.close();
      } catch {
        // 忽略关闭监听异常
      }
    };

    const scheduleAttach = (delayMs = 50) => {
      if (stopped || disposed || reattachTimer) return;
      reattachTimer = setTimeout(() => {
        reattachTimer = null;
        attach();
      }, delayMs);
    };

    const attach = () => {
      if (stopped || disposed) return;
      const anchor = findAnchor();
      if (!anchor) return;
      if (activeWatcher && activeWatchDir === anchor.watchDir) {
        return;
      }
      closeActive();
      try {
        const watcher = watch(anchor.watchDir, (_eventType, filename) => {
          if (stopped || disposed || activeWatcher !== watcher) return;
          if (!existsSync(anchor.watchDir)) {
            waitingForDir = true;
            closeActive();
            scheduleAttach(30);
            return;
          }
          if (!anchor.isTarget) {
            if (
              filename &&
              basename(String(filename)) !== anchor.childName &&
              !existsSync(join(anchor.watchDir, anchor.childName))
            ) {
              return;
            }
            if (existsSync(join(anchor.watchDir, anchor.childName))) {
              attach();
            }
            return;
          }
          if (filename && targetNames && !targetNames.has(basename(String(filename)))) {
            return;
          }
          onChange();
        });
        watcher.on?.('error', (err) => {
          if (stopped || disposed || activeWatcher !== watcher) return;
          logger.warn(`[冬雪莲] 文件监听异常（${anchor.watchDir}）：${err.message}`);
          waitingForDir = true;
          closeActive();
          scheduleAttach(80);
        });
        watcher.on?.('close', () => {
          if (stopped || disposed || activeWatcher !== watcher) return;
          activeWatcher = null;
          activeWatchDir = null;
          waitingForDir = true;
          scheduleAttach(80);
        });
        activeWatcher = watcher;
        activeWatchDir = anchor.watchDir;
        if (anchor.isTarget) {
          const upgraded = waitingForDir;
          waitingForDir = false;
          if (upgraded && hasAnyTargetFile()) {
            onChange();
          }
        } else {
          waitingForDir = true;
        }
      } catch (err) {
        logger.warn(`[冬雪莲] 启动文件监听失败（${anchor.watchDir}）：${err.message}`);
        waitingForDir = true;
        scheduleAttach(150);
      }
    };

    attach();
    const handle = {
      close() {
        disposed = true;
        clearTimeout(reattachTimer);
        reattachTimer = null;
        closeActive();
      },
    };
    fsWatchers.push(handle);
    return handle;
  };

  const watchCandidates = [join(resolvedRoot, 'src', 'theme.css')];
  if (i18n) {
    watchCandidates.push(
      join(resolvedRoot, DEFAULT_I18N_RELATIVE_PATH),
      join(resolvedRoot, DEFAULT_OVERRIDE_RELATIVE_PATH),
    );
    if (typeof i18nOverride === 'string' && i18nOverride.trim()) {
      watchCandidates.push(resolve(process.cwd(), i18nOverride.trim()));
    }
  }
  const uniqueWatchPaths = Array.from(new Set(watchCandidates.map((p) => resolve(p))));
  const dirTargetsMap = new Map();
  for (const targetPath of uniqueWatchPaths) {
    const dir = dirname(targetPath);
    if (!dirTargetsMap.has(dir)) {
      dirTargetsMap.set(dir, new Set());
    }
    dirTargetsMap.get(dir).add(basename(targetPath));
  }
  for (const [dir, targetNames] of dirTargetsMap.entries()) {
    registerDirWatcher(dir, targetNames, () => {
      clearTimeout(cssTimer);
      cssTimer = setTimeout(() => {
        void reinjectNow();
      }, cssDebounceMs);
    });
  }

  // 纯事件驱动监听 DevToolsActivePort：客户端未启动或未变更时不触发任何轮询请求
  const resolvedPortFile = resolve(portFile);
  const portDir = dirname(resolvedPortFile);
  const portBase = basename(resolvedPortFile);

  const triggerPortSync = () => {
    clearTimeout(portTimer);
    clearTimeout(retryTimer);
    portTimer = setTimeout(() => {
      portTimer = null;
      void syncPortWithBackoff(0);
    }, 25);
  };

  const attachPortFileWatcher = () => {
    if (stopped) return;
    registerDirWatcher(portDir, new Set([portBase]), triggerPortSync);
  };

  attachPortFileWatcher();

  await syncNow();
  initialPayload = null;
  if (
    !stopped &&
    (!lastSyncConnected || !browserSession) &&
    (port !== undefined || existsSync(resolvedPortFile))
  ) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void syncPortWithBackoff(0);
    }, PORT_READY_BACKOFF_MS[0]);
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(cssTimer);
    clearTimeout(portTimer);
    clearTimeout(retryTimer);
    clearTimeout(reconnectTimer);
    for (const watcher of fsWatchers) {
      try {
        watcher.close();
      } catch {
        // 忽略关闭监听异常
      }
    }
    fsWatchers.length = 0;
    await Promise.allSettled([syncInFlight, reinjectInFlight].filter(Boolean));
    if (browserSession) {
      await browserSession.close().catch(() => {});
      browserSession = null;
      browserEndpointKey = null;
    }
    for (const entry of attached.values()) {
      await entry.session.close().catch(() => {});
    }
    attached.clear();
    unlinkPidFileIfOwned(pidFile);
  };

  return {
    stop,
    syncNow,
    reinjectNow,
    getAttachedCount: () => attached.size,
    pidFile,
  };
}

async function acquirePidLock(pidFile, { timeoutMs = 5000 } = {}) {
  const lockFile = `${pidFile}.lock`;
  mkdirSync(dirname(pidFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  const createLock = () => {
    const fd = openSync(lockFile, 'wx');
    try {
      writeSync(fd, `${process.pid}\n`, null, 'utf8');
    } finally {
      closeSync(fd);
    }
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      process.off('exit', cleanup);
      unlinkPidFileIfOwned(lockFile, process.pid);
    };
    process.once('exit', cleanup);
    return cleanup;
  };

  while (true) {
    try {
      return createLock();
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
    }

    let stale = false;
    try {
      const raw = readFileSync(lockFile, 'utf8').trim();
      const lockPid = Number.parseInt(raw, 10);
      const ageMs = Date.now() - statSync(lockFile).mtimeMs;
      if (Number.isInteger(lockPid) && lockPid > 0) {
        if (lockPid !== process.pid) {
          const status = getNodeProcessStatus(lockPid);
          if (status === 'dead' || status === 'other' || (status === 'unknown' && ageMs > 10000)) {
            stale = true;
          }
        }
      } else if (ageMs > 1500) {
        stale = true;
      }
    } catch (readErr) {
      if (readErr?.code === 'ENOENT') {
        continue;
      }
      stale = true;
    }

    if (stale) {
      unlinkQuietly(lockFile);
      continue;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * 以阻塞守护模式运行监听循环，收到 `SIGINT`/`SIGTERM` 后优雅清理退出。
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export async function watchLoop(options = {}) {
  const resolvedRoot = resolveRootPath(options.rootDir);
  const pidFile = options.pidFile ?? join(resolvedRoot, '.watch.pid');
  const logFile = options.logFile ?? join(resolvedRoot, 'watch.log');
  const isDaemon = Boolean(options.daemon);
  const logger = options.logger ?? (isDaemon ? createDaemonLogger(logFile) : console);

  let releasePidLock = null;
  let controller;
  try {
    if (options.ifNotRunning) {
      releasePidLock = await acquirePidLock(pidFile);
      const livePid = readLiveWatcherPid(pidFile);
      if (livePid && livePid !== process.pid) {
        logger.log(`[冬雪莲] 监听进程已在运行 (PID ${livePid})，跳过重复启动。`);
        return;
      }
      if (!releasePidLock) {
        logger.warn(`[冬雪莲] 获取守护进程锁超时（${pidFile}.lock），跳过重复启动。`);
        return;
      }
    }

    controller = await startWatch({
      ...options,
      rootDir: resolvedRoot,
      pidFile,
      logger,
      onPidWritten: () => {
        releasePidLock?.();
        releasePidLock = null;
      },
    });
  } finally {
    releasePidLock?.();
    releasePidLock = null;
  }
  logger.log(
    isDaemon
      ? '[冬雪莲] 后台守护监听已启动（自动追踪窗口、客户端重启重连及热重载）。'
      : '[冬雪莲] 监听模式已启动（自动追踪新窗口并热重载样式与汉化配置），按 Ctrl+C 退出。',
  );

  // 守护模式下无控制台可见，未处理的 Promise 拒绝只记录日志不退出；未捕获异常记录后退出，交由看门狗复活
  const onUnhandledRejection = (reason) => {
    try {
      logger.error(`[冬雪莲] 未处理的异步异常（已忽略）：${reason?.stack || reason}`);
    } catch {
      // 忽略日志写入异常
    }
  };
  const onUncaughtException = (err) => {
    try {
      logger.error(`[冬雪莲] 未捕获异常，守护进程退出：${err?.stack || err}`);
    } catch {
      // 忽略日志写入异常
    }
    // 故意保留 .watch.pid 以便外层阻塞守候进程识别非正常退出并自动拉起
    process.exit(1);
  };
  if (isDaemon) {
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
  }

  await new Promise((resolveLoop) => {
    let finishing = false;
    const shutdown = () => {
      if (finishing) return;
      finishing = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
      void controller.stop().finally(() => {
        logger.log('[冬雪莲] 监听模式已退出。');
        resolveLoop();
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

/**
 * CLI 统一入口执行器：负责 Node 版本检查、参数解析、帮助输出与错误兜底。
 * @param {'inject'|'watch'|'remove'|'install'|'uninstall'|'status'} commandName
 * @param {(options: { port?: number, avatar: boolean, shift: boolean, i18n: boolean, i18nOverride?: string, daemon: boolean, ifNotRunning: boolean, help: boolean }) => Promise<any>} action
 * @param {string[]} [argv]
 */
export async function runCli(commandName, action, argv = process.argv.slice(2)) {
  const isDaemonArg = argv.includes('--daemon');
  const reportFatal = (msg) => {
    if (isDaemonArg) {
      createDaemonLogger(join(DEFAULT_ROOT, 'watch.log')).error(msg);
    } else {
      console.error(msg);
    }
  };

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isNaN(major) || major < 22) {
    reportFatal(`[冬雪莲] 需要 Node.js >= 22.0.0（当前版本：v${process.versions.node}）。`);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    reportFatal(`[冬雪莲] 参数错误：${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    console.log(formatUsage(commandName));
    return;
  }

  try {
    await action(parsed);
  } catch (err) {
    reportFatal(`[冬雪莲] 执行失败：${err.message}`);
    process.exitCode = 1;
  }
}
