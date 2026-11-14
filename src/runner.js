import { existsSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  getPortFilePath,
  listPages,
  readPort,
  validatePort,
} from './cdp.js';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读取项目版本号，失败时回退到 `0.1.0`。
 * @param {string} rootDir
 * @returns {string}
 */
export function readPackageVersion(rootDir = DEFAULT_ROOT) {
  try {
    const pkgPath = join(rootDir, 'package.json');
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
 * @returns {{ port: number|undefined, avatar: boolean, shift: boolean, i18n: boolean, i18nOverride: string|undefined, help: boolean }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    port: undefined,
    avatar: true,
    shift: true,
    i18n: true,
    i18nOverride: undefined,
    help: false,
  };

  const validateOverridePath = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      throw new Error('--i18n-override 需要传入有效的覆盖词典文件路径');
    }
    return trimmed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
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
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('--i18n-override 需要传入覆盖词典文件路径');
      }
      options.i18nOverride = validateOverridePath(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--i18n-override=')) {
      options.i18nOverride = validateOverridePath(arg.slice('--i18n-override='.length));
      continue;
    }
    if (arg === '--port') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('--port 需要传入 1~65535 的整数端口号');
      }
      options.port = validatePort(next);
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
  return [
    `冬雪莲 Antigravity 桌面端主题工具 (${commandName})`,
    '',
    '用法：',
    `  npm run ${commandName} -- [选项]`,
    `  node bin/${commandName}.js [选项]`,
    '',
    '选项：',
    '  --port <端口>             手动指定 Antigravity CDP 端口（默认读取 DevToolsActivePort）',
    '  --no-avatar               不注入侧边栏 24px 冬雪莲头像徽标',
    '  --no-shift                关闭对话流居中阅读偏移微调',
    '  --no-i18n                 关闭界面简体中文汉化（若已汉化则自动还原英文）',
    '  --i18n-override <路径>    指定额外的用户覆盖词典 JSON 文件',
    '  -h, --help                显示此帮助信息',
  ].join('\n');
}

/**
 * 构建当前配置对应的 CSS 与完整注入脚本。
 * @param {object} [options]
 * @param {string} [options.rootDir]
 * @param {boolean} [options.avatar]
 * @param {boolean} [options.shift]
 * @param {boolean} [options.i18n]
 * @param {string} [options.i18nOverride]
 * @returns {{ css: string, script: string, version: string }}
 */
export function prepareRuntimePayload({
  rootDir = DEFAULT_ROOT,
  avatar = true,
  shift = true,
  i18n = true,
  i18nOverride,
} = {}) {
  const assets = loadThemeAssets(rootDir);
  const css = buildThemeCss({ rootDir });
  const version = readPackageVersion(rootDir);
  const i18nDict = i18n ? loadI18nDictionary({ rootDir, overridePath: i18nOverride }).dict : null;
  const script = buildInjectScript(css, {
    avatarDataUri: avatar ? assets.avatar.dataUri : '',
    avatar,
    shift,
    i18n,
    i18nDict,
    version,
  });
  return { css, script, version };
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
  await session.send('Page.enable');
  const evalResult = await session.evaluate(script);
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
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 5000,
    logger = console,
  } = options;

  const targetPort = readPort(portFile, { port });
  const pages = await listPages(targetPort, { fetchImpl, timeoutMs });
  if (pages.length === 0) {
    logger.warn(`[冬雪莲] 在端口 ${targetPort} 未发现可注入的 Antigravity 页面窗口。`);
    return { port: targetPort, injectedCount: 0, results: [] };
  }

  const { script, version } = prepareRuntimePayload({ rootDir, avatar, shift, i18n, i18nOverride });
  const results = [];

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
    } finally {
      await session.close();
    }
  }

  logger.log(
    `[冬雪莲 v${version}] 已向 ${results.length} 个 Antigravity 页面注入主题（端口 ${targetPort}）。`,
  );
  return { port: targetPort, injectedCount: results.length, results };
}

function tryStopWatcherByPidFile(pidFile, logger) {
  if (!pidFile || !existsSync(pidFile)) {
    return false;
  }
  let signaled = false;
  try {
    const pidText = readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      process.kill(pid, 'SIGTERM');
      signaled = true;
      logger?.log?.(`[冬雪莲] 已向监听进程 (PID ${pid}) 发送停止信号。`);
    }
  } catch (err) {
    if (err?.code === 'ESRCH') {
      try {
        unlinkSync(pidFile);
      } catch {
        // 忽略清理过期 PID 文件异常
      }
    }
  }
  return signaled;
}

/**
 * 停止可能运行中的监听进程，并从已打开的页面中移除全部注入样式、属性与头像。
 * 若 Antigravity 未运行，则优雅退出而不报错。
 * @param {object} [options]
 * @returns {Promise<{ running: boolean, port: number|null, stoppedWatcher: boolean, removedCount: number, results: Array<any> }>}
 */
export async function removeOnce(options = {}) {
  const {
    rootDir = DEFAULT_ROOT,
    port,
    portFile = getPortFilePath(),
    pidFile = join(rootDir, '.watch.pid'),
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 5000,
    logger = console,
  } = options;

  const stoppedWatcher = tryStopWatcherByPidFile(pidFile, logger);
  if (stoppedWatcher) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
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
    } finally {
      await session.close();
    }
  }

  logger.log(`[冬雪莲] 已从 ${results.length} 个 Antigravity 页面移除主题样式与 DOM 标记。`);
  return {
    running: true,
    port: targetPort,
    stoppedWatcher,
    removedCount: results.length,
    results,
  };
}

/**
 * 启动长期监听会话控制器：自动附加新窗口并热重载 `src/theme.css`。
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
  const {
    rootDir = DEFAULT_ROOT,
    port,
    portFile = getPortFilePath(),
    pidFile = join(rootDir, '.watch.pid'),
    avatar = true,
    shift = true,
    i18n = true,
    i18nOverride,
    pollIntervalMs = 2000,
    cssDebounceMs = 150,
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 5000,
    logger = console,
  } = options;

  let currentPayload = prepareRuntimePayload({ rootDir, avatar, shift, i18n, i18nOverride });
  const attached = new Map();
  let stopped = false;
  let syncing = false;
  let cssTimer = null;
  let pollTimer = null;
  const fsWatchers = [];
  let waitErrorLogged = false;

  try {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  } catch (err) {
    logger.warn(`[冬雪莲] 写入 PID 文件失败（${pidFile}）：${err.message}`);
  }

  const syncNow = async () => {
    if (stopped || syncing) {
      return attached.size;
    }
    syncing = true;
    try {
      const targetPort = readPort(portFile, { port });
      const pages = await listPages(targetPort, { fetchImpl, timeoutMs });
      waitErrorLogged = false;

      for (const page of pages) {
        if (stopped || attached.has(page.id)) {
          continue;
        }
        const session = new CdpSession(page.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
        try {
          await session.connect();
          const { scriptId } = await injectPageSession(session, currentPayload.script, {
            pageLabel: page.title || page.id,
            logger,
          });
          session.on('close', () => {
            attached.delete(page.id);
          });
          attached.set(page.id, { session, scriptId, title: page.title || '' });
          logger.log(`[冬雪莲] 已挂载并注入页面：${page.title || page.id}`);
        } catch (err) {
          await session.close().catch(() => {});
          logger.warn(`[冬雪莲] 注入页面失败（${page.id}）：${err.message}`);
        }
      }
    } catch (err) {
      if (!waitErrorLogged) {
        waitErrorLogged = true;
        logger.log(`[冬雪莲] 等待 Antigravity CDP 就绪：${err.message}`);
      }
    } finally {
      syncing = false;
    }
    return attached.size;
  };

  const reinjectNow = async () => {
    if (stopped) {
      return 0;
    }
    try {
      currentPayload = prepareRuntimePayload({ rootDir, avatar, shift, i18n, i18nOverride });
    } catch (err) {
      logger.warn(`[冬雪莲] 运行时载荷重新编译失败：${err.message}`);
      return 0;
    }

    let updated = 0;
    for (const [pageId, entry] of Array.from(attached.entries())) {
      try {
        if (entry.scriptId) {
          await entry.session
            .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
            .catch(() => {});
        }
        const registered = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
          source: currentPayload.script,
        });
        entry.scriptId = registered?.identifier ?? null;
        await entry.session.evaluate(currentPayload.script);
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

  const watchCandidates = [join(rootDir, 'src', 'theme.css')];
  if (i18n) {
    watchCandidates.push(
      join(rootDir, DEFAULT_I18N_RELATIVE_PATH),
      join(rootDir, DEFAULT_OVERRIDE_RELATIVE_PATH),
    );
    if (typeof i18nOverride === 'string' && i18nOverride.trim()) {
      watchCandidates.push(resolve(process.cwd(), i18nOverride.trim()));
    }
  }
  const uniqueWatchPaths = Array.from(new Set(watchCandidates.map((p) => resolve(p))));
  for (const targetPath of uniqueWatchPaths) {
    if (!existsSync(targetPath)) continue;
    try {
      const watcher = watch(targetPath, () => {
        if (stopped) return;
        clearTimeout(cssTimer);
        cssTimer = setTimeout(() => {
          void reinjectNow();
        }, cssDebounceMs);
      });
      fsWatchers.push(watcher);
    } catch (err) {
      logger.warn(`[冬雪莲] 启动文件监听失败（${targetPath}）：${err.message}`);
    }
  }

  await syncNow();
  pollTimer = setInterval(() => {
    void syncNow();
  }, pollIntervalMs);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(cssTimer);
    clearInterval(pollTimer);
    for (const watcher of fsWatchers) {
      try {
        watcher.close();
      } catch {
        // 忽略关闭监听异常
      }
    }
    fsWatchers.length = 0;
    for (const entry of attached.values()) {
      await entry.session.close().catch(() => {});
    }
    attached.clear();
    if (existsSync(pidFile)) {
      try {
        unlinkSync(pidFile);
      } catch {
        // 忽略删除 PID 文件异常
      }
    }
  };

  return {
    stop,
    syncNow,
    reinjectNow,
    getAttachedCount: () => attached.size,
    pidFile,
  };
}

/**
 * 以阻塞守护模式运行监听循环，收到 `SIGINT`/`SIGTERM` 后优雅清理退出。
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export async function watchLoop(options = {}) {
  const logger = options.logger ?? console;
  const controller = await startWatch(options);
  logger.log('[冬雪莲] 监听模式已启动（自动追踪新窗口并热重载样式与汉化配置），按 Ctrl+C 退出。');

  await new Promise((resolveLoop) => {
    let finishing = false;
    const shutdown = () => {
      if (finishing) return;
      finishing = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
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
 * @param {'inject'|'watch'|'remove'} commandName
 * @param {(options: { port?: number, avatar: boolean, shift: boolean }) => Promise<any>} action
 * @param {string[]} [argv]
 */
export async function runCli(commandName, action, argv = process.argv.slice(2)) {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isNaN(major) || major < 22) {
    console.error(`[冬雪莲] 需要 Node.js >= 22.0.0（当前版本：v${process.versions.node}）。`);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`[冬雪莲] 参数错误：${err.message}`);
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
    console.error(`[冬雪莲] 执行失败：${err.message}`);
    process.exitCode = 1;
  }
}
