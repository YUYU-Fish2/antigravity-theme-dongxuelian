import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getAppAsarStatus } from './asar.js';
import { getPortFilePath } from './cdp.js';
import {
  ensureDesktopLaunchConfig,
  inspectDesktopLaunch,
  removeDesktopLaunchConfig,
} from './launch.js';
import {
  prepareRuntimePayload,
  readLiveWatcherPid,
  readPackageVersion,
  removeOnce,
  resolveRootPath,
  unlinkQuietly,
} from './runner.js';

export const PLUGIN_ID = 'antigravity-theme-dongxuelian';
export const PLUGIN_SIDECAR_NAME = 'theme';
export const PLUGIN_DISPLAY_NAME = '冬雪莲主题 (Dongxuelian Theme)';

const BUNDLED_SRC_FILES = Object.freeze([
  'assets.js',
  'cdp.js',
  'i18n.js',
  'launch.js',
  'net.js',
  'runner.js',
  'theme.css',
]);

const BUNDLED_ASSET_FILES = Object.freeze([
  join('characters', 'web', 'avatar.webp'),
  join('scenes', 'web', 'reading.webp'),
  join('textures', 'web', 'paper.webp'),
  join('i18n', 'zh-CN.json'),
]);

function readJsonObject(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * 解析 Antigravity 插件部署与状态文件路径。
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.pluginDir]
 * @param {string} [options.configFile]
 * @param {string} [options.dataDir]
 */
export function getPluginPaths({
  home = homedir(),
  env = process.env,
  pluginDir,
  configFile,
  dataDir,
} = {}) {
  const pluginsRoot = join(home, '.gemini', 'config', 'plugins');
  const resolvedPluginDir = pluginDir || join(pluginsRoot, PLUGIN_ID);
  const resolvedConfigFile = configFile || join(home, '.gemini', 'config', 'config.json');
  const resolvedDataDir =
    dataDir ||
    env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    join(home, '.gemini', 'antigravity', 'sidecar_data', PLUGIN_ID, PLUGIN_SIDECAR_NAME, 'data');
  const sidecarDir = join(resolvedPluginDir, 'sidecars', PLUGIN_SIDECAR_NAME);
  return {
    pluginsRoot,
    pluginDir: resolvedPluginDir,
    configFile: resolvedConfigFile,
    dataDir: resolvedDataDir,
    sidecarDir,
    manifestFile: join(resolvedPluginDir, 'plugin.json'),
    sidecarManifestFile: join(sidecarDir, 'sidecar.json'),
    sidecarEntryFile: join(sidecarDir, 'main.mjs'),
    panelHtmlFile: join(sidecarDir, 'panel.html'),
    settingsFile: join(resolvedDataDir, 'settings.json'),
    launchStateFile: join(resolvedDataDir, 'launch-state.json'),
    statusFile: join(resolvedDataDir, 'integration-state.json'),
    pidFile: join(resolvedDataDir, '.watch.pid'),
    logFile: join(resolvedDataDir, 'sidecar.log'),
  };
}

/**
 * 生成插件 SVG 图标，沿用冬雪莲暖纸白与靛蓝墨调色。
 */
export function buildPluginLogoSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">',
    '  <rect x="4" y="4" width="56" height="56" rx="14" fill="#F7F3EB" stroke="#435882" stroke-width="3"/>',
    '  <path d="M32 14L35.8 25.2L47 29L35.8 32.8L32 44L28.2 32.8L17 29L28.2 25.2L32 14Z" fill="#536B9E"/>',
    '  <circle cx="46" cy="18" r="3.5" fill="#7D96C9"/>',
    '</svg>',
    '',
  ].join('\n');
}

/**
 * 生成 Antigravity 宿主读取的 `sidecar.json` 声明。
 */
export function buildSidecarManifest() {
  return {
    command: 'node',
    args: ['--max-semi-space-size=1', '--max-old-space-size=48', 'main.mjs'],
    restart_policy: 'always',
    display_name: '冬雪莲主题',
    description: '由 Antigravity 宿主托管生命周期并零轮询注入暖纸白浅色主题与简体中文汉化',
    has_web_ui: true,
    ui_config: {
      display_name: '冬雪莲主题',
      views: [
        {
          path: '/',
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
          title: '冬雪莲主题',
        },
      ],
    },
  };
}

/**
 * 生成右侧辅助栏 (`Aux Pane`) 中展示的冬雪莲主题轻量控制面板 HTML。
 */
export function buildPluginPanelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>冬雪莲主题控制面板</title>
  <script src="preload.js"></script>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; padding: 0;
      background: var(--background, #F7F3EB);
      color: var(--foreground, #2C4268);
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .panel { padding: 14px; }
    .card {
      background: var(--card, #FFFDF8);
      border: 1px solid rgba(83, 107, 158, 0.22);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    h1 { font-size: 15px; margin: 0 0 6px; }
    .muted { color: var(--muted-foreground, #5C6578); font-size: 12px; margin: 0; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600;
      background: rgba(83, 107, 158, 0.14); color: var(--primary, #435882);
      margin-bottom: 8px;
    }
    label.row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 0; cursor: pointer;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    button {
      border: 1px solid rgba(83, 107, 158, 0.3);
      background: var(--primary, #536B9E); color: #FFFDF8;
      border-radius: 7px; padding: 6px 12px; font-size: 12px; cursor: pointer;
    }
    button.secondary { background: transparent; color: inherit; }
  </style>
</head>
<body>
  <main class="panel">
  <div class="card">
    <div id="badge" class="badge">正在连接...</div>
    <h1>冬雪莲涂鸦主题</h1>
    <p id="summary" class="muted">等待宿主状态...</p>
  </div>
  <div class="card">
    <label class="row"><span>显示侧栏 24px 头像</span><input id="opt-avatar" type="checkbox" /></label>
    <label class="row"><span>宽屏（>=1100px）对话左移微调</span><input id="opt-shift" type="checkbox" /></label>
    <label class="row"><span>全界面简体中文汉化</span><input id="opt-i18n" type="checkbox" /></label>
    <div class="actions">
      <button id="btn-reinject" type="button">立即重新注入</button>
      <button id="btn-repair" type="button" class="secondary">自检快捷方式参数</button>
    </div>
  </div>
  </main>
  <script>
    const apiFetch = (url, init) => (window.sidecar && typeof window.sidecar.fetch === 'function') ? window.sidecar.fetch(url, init) : fetch(url, init);
    const badgeEl = document.getElementById('badge');
    const summaryEl = document.getElementById('summary');
    const opts = ['avatar', 'shift', 'i18n'];

    function render(data) {
      const s = data.status || {};
      badgeEl.textContent = s.state === 'active' ? ('运行中 · 已挂载 ' + (s.attachedCount || 0) + ' 个窗口') : (s.state === 'disabled' ? '已停用' : '等待窗口或调试端口');
      const launchText = s.launchConfigured ? '快捷方式参数正常' : '快捷方式未配置（点击自检可修复）';
      summaryEl.textContent = (s.message || '') + (s.message ? ' ｜ ' : '') + launchText;
      for (const k of opts) {
        const el = document.getElementById('opt-' + k);
        if (el && data.settings) el.checked = data.settings[k] !== false;
      }
    }

    async function refresh() {
      try {
        const res = await apiFetch('api/state');
        if (res.ok) render(await res.json());
      } catch {}
    }

    for (const k of opts) {
      document.getElementById('opt-' + k).addEventListener('change', async (e) => {
        await apiFetch('api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [k]: Boolean(e.target.checked) }),
        });
        await refresh();
      });
    }
    document.getElementById('btn-reinject').addEventListener('click', async () => {
      await apiFetch('api/reinject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await refresh();
    });
    document.getElementById('btn-repair').addEventListener('click', async () => {
      await apiFetch('api/repair-launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await refresh();
    });
    refresh();
  </script>
</body>
</html>
`;
}

/**
 * 生成插件侧 `sidecars/theme/main.mjs` 守护进程脚本内容。
 * 由 Antigravity 宿主自动拉起与退出，内置快捷方式自愈、事件驱动注入与轻量 Web 控制面板。
 */
export function buildSidecarEntrySource() {
  return `import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPortFilePath } from '../../src/cdp.js';
import { ensureDesktopLaunchConfig, inspectDesktopLaunch } from '../../src/launch.js';
import { createDaemonLogger, removeOnce, startWatch } from '../../src/runner.js';

const PLUGIN_ID = '${PLUGIN_ID}';
const SIDECAR_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(SIDECAR_DIR, '..', '..');
const HOME = homedir();
const DATA_DIR =
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
  join(HOME, '.gemini', 'antigravity', 'sidecar_data', PLUGIN_ID, '${PLUGIN_SIDECAR_NAME}', 'data');
const CONFIG_FILE = join(HOME, '.gemini', 'config', 'config.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const LAUNCH_STATE_FILE = join(DATA_DIR, 'launch-state.json');
const STATUS_FILE = join(DATA_DIR, 'integration-state.json');
const PID_FILE = join(DATA_DIR, '.watch.pid');
const LOG_FILE = join(DATA_DIR, 'sidecar.log');
const PANEL_HTML_PATH = join(SIDECAR_DIR, 'panel.html');

mkdirSync(DATA_DIR, { recursive: true });
// Windows 下宿主从 plugin 子目录拉起进程会占用目录句柄，主动切换到数据目录避免影响插件升级与卸载
try { process.chdir(DATA_DIR); } catch {}

const logger = createDaemonLogger(LOG_FILE);

function readJson(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function atomicJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = \`\${filePath}.\${process.pid}.tmp\`;
  writeFileSync(tmp, \`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8');
  renameSync(tmp, filePath);
}

function readPluginEnabled() {
  if (!existsSync(join(PLUGIN_ROOT, 'plugin.json'))) return false;
  if (!existsSync(CONFIG_FILE)) return true;
  const cfg = readJson(CONFIG_FILE, {});
  if (cfg.plugins && typeof cfg.plugins === 'object') {
    if (!Object.prototype.hasOwnProperty.call(cfg.plugins, PLUGIN_ID)) {
      return false;
    }
    return cfg.plugins[PLUGIN_ID]?.enabled !== false;
  }
  return true;
}

function readSettings() {
  const s = readJson(SETTINGS_FILE, {});
  return {
    avatar: s.avatar !== false,
    shift: s.shift !== false,
    i18n: s.i18n !== false,
    i18nOverride: typeof s.i18nOverride === 'string' && s.i18nOverride.trim() ? s.i18nOverride.trim() : undefined,
    port: Number.isInteger(s.port) ? s.port : undefined,
    repoRoot: typeof s.repoRoot === 'string' ? s.repoRoot : '',
  };
}

function resolveActiveRoot(settings) {
  if (settings.repoRoot && existsSync(join(settings.repoRoot, 'src', 'theme.css'))) {
    return settings.repoRoot;
  }
  return PLUGIN_ROOT;
}

let currentState = {
  state: 'waiting',
  attachedCount: 0,
  launchConfigured: false,
  message: '正在初始化',
  checkedAt: new Date().toISOString(),
};

function writeStatus(patch) {
  currentState = { ...currentState, ...patch, checkedAt: new Date().toISOString() };
  try {
    atomicJson(STATUS_FILE, currentState);
  } catch {
    // 状态写入失败不影响主流程
  }
}

let lastRepairAt = 0;
let repairInFlight = null;
async function repairShortcuts(force = false) {
  if (repairInFlight) return repairInFlight;
  if (!force && Date.now() - lastRepairAt < 60000) {
    const inspected = inspectDesktopLaunch({ home: HOME });
    writeStatus({ launchConfigured: Boolean(inspected.configured) });
    return inspected;
  }
  lastRepairAt = Date.now();
  repairInFlight = ensureDesktopLaunchConfig({ home: HOME, stateFile: LAUNCH_STATE_FILE })
    .then((res) => {
      writeStatus({ launchConfigured: Boolean(res.configured) });
      if (res.repaired) {
        logger.log('[冬雪莲] 已自动修复 Antigravity 快捷方式调试参数，重启客户端后即可连接。');
      }
      return res;
    })
    .finally(() => {
      repairInFlight = null;
    });
  return repairInFlight;
}

let watcher = null;
let lastKey = '';
let applying = Promise.resolve();
let stopping = false;

async function syncController() {
  if (stopping) return;
  const enabled = readPluginEnabled();
  const settings = readSettings();
  const rootDir = resolveActiveRoot(settings);
  const overridePath =
    settings.i18nOverride && existsSync(settings.i18nOverride) ? settings.i18nOverride : undefined;
  const nextKey = JSON.stringify({ enabled, rootDir, ...settings, i18nOverride: overridePath });
  if (nextKey === lastKey && ((enabled && watcher) || (!enabled && !watcher))) {
    return;
  }
  lastKey = nextKey;

  if (watcher) {
    await watcher.stop().catch(() => {});
    watcher = null;
  }

  if (!enabled) {
    await removeOnce({
      rootDir,
      port: settings.port,
      portFile: getPortFilePath({ home: HOME }),
      pidFile: PID_FILE,
      logger,
      skipAutostartHint: true,
    }).catch(() => {});
    writeStatus({ state: 'disabled', attachedCount: 0, message: '插件已停用' });
    return;
  }

  await repairShortcuts(false);
  watcher = await startWatch({
    rootDir,
    port: settings.port,
    portFile: getPortFilePath({ home: HOME }),
    pidFile: PID_FILE,
    avatar: settings.avatar,
    shift: settings.shift,
    i18n: settings.i18n,
    i18nOverride: overridePath,
    logger,
    onSync: ({ attachedCount }) => {
      writeStatus({
        state: attachedCount > 0 ? 'active' : 'waiting',
        attachedCount,
        message: attachedCount > 0 ? '主题已挂载至客户端窗口' : '已连接，等待可注入窗口',
      });
    },
    onWaitError: (err) => {
      writeStatus({
        state: 'waiting',
        attachedCount: 0,
        message: err?.message || '等待 Antigravity CDP 就绪',
      });
      if (String(err?.message || '').includes('DevToolsActivePort')) {
        void repairShortcuts(false);
      }
    },
  });
}

const scheduleSync = () => {
  applying = applying.then(() => syncController()).catch((err) => {
    logger.warn(\`[冬雪莲] 同步状态异常：\${err.message}\`);
  });
};

const watchers = [];
const watchTargetFile = (filePath) => {
  const dir = dirname(filePath);
  const base = basename(filePath);
  if (!existsSync(dir)) return;
  try {
    const w = watch(dir, (_evt, filename) => {
      if (!stopping && (!filename || basename(String(filename)) === base)) {
        scheduleSync();
      }
    });
    w.on?.('error', () => {});
    watchers.push(w);
  } catch {}
};

watchTargetFile(CONFIG_FILE);
watchTargetFile(SETTINGS_FILE);

async function startWebUiServer() {
  const portStr = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  if (!portStr) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1) return null;
  const token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

  const getPanelHtml = () => readFileSync(PANEL_HTML_PATH, 'utf8');
  const handleGetState = () => ({ status: currentState, settings: readSettings() });
  const handleUpdateSettings = async (body) => {
    const next = { ...readJson(SETTINGS_FILE, {}) };
    for (const k of ['avatar', 'shift', 'i18n']) {
      if (typeof body?.[k] === 'boolean') next[k] = body[k];
    }
    atomicJson(SETTINGS_FILE, next);
    scheduleSync();
    await applying;
    return handleGetState();
  };
  const handleReinject = async () => {
    const count = watcher ? await watcher.reinjectNow() : 0;
    return { ok: true, updated: count };
  };
  const handleRepairLaunch = async () => repairShortcuts(true);

  try {
    const sdk = await import('sidecar_sdk');
    const app = new sdk.SidecarApp();
    app.page('/', getPanelHtml);
    app.api('/api/state', handleGetState, 'GET');
    app.api('/api/settings', handleUpdateSettings, 'POST');
    app.api('/api/reinject', handleReinject, 'POST');
    app.api('/api/repair-launch', handleRepairLaunch, 'POST');
    await app.run();
    return app;
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') {
      logger.warn(\`[冬雪莲] sidecar_sdk 初始化失败，启用内置轻量面板服务：\${err.message}\`);
    }
  }

  // 当 Windows 未设置 NODE_PATH 解析 sidecar_sdk 时，启用标准库回退 HTTP 服务（仅监听 127.0.0.1）
  const preloadScript =
    "(function(){const p=new URLSearchParams(location.search);const t=p.get('token');" +
    "window.sidecar={fetch:(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),...(t?{'x-sidecar-token':t}:{})}})};})();";
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', \`http://127.0.0.1:\${port}\`);
    if (req.method !== 'GET' && token) {
      const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
      if (provided !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getPanelHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadScript);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(handleGetState()));
      return;
    }
    if (req.method === 'POST' && ['/api/settings', '/api/reinject', '/api/repair-launch'].includes(url.pathname)) {
      let raw = '';
      let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        raw += c;
        if (raw.length > 16384) {
          aborted = true;
          req.pause();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"error":"payload too large"}', () => req.destroy());
        }
      });
      req.on('end', async () => {
        if (aborted) return;
        try {
          const payload = raw ? JSON.parse(raw) : {};
          const out =
            url.pathname === '/api/settings'
              ? await handleUpdateSettings(payload)
              : url.pathname === '/api/reinject'
                ? await handleReinject()
                : await handleRepairLaunch();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  return { close: () => new Promise((r) => server.close(r)) };
}

const serverHandle = await startWebUiServer();
scheduleSync();
await applying;
logger.log('[冬雪莲] Antigravity 插件 Sidecar 已启动（宿主托管，零系统自启与轮询）。');

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers.length = 0;
  if (watcher) {
    await watcher.stop().catch(() => {});
    watcher = null;
  }
  writeStatus({ state: 'stopped', attachedCount: 0, message: 'Sidecar 已停止' });
  if (serverHandle && typeof serverHandle.close === 'function') {
    await Promise.resolve(serverHandle.close()).catch(() => {});
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
`;
}

/**
 * 安装冬雪莲为标准 Antigravity 插件（Sidecar 宿主托管模式）并配置快捷方式回环参数自愈。
 * 客户端更新时仅覆盖安装包自身，不会覆盖用户插件目录，实现免重装跨更新生效。
 * @param {object} [options]
 */
export async function installPlugin(options = {}) {
  const rootDir = resolveRootPath(options.rootDir);
  const home = options.home || homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const logger = options.logger ?? console;
  const avatar = options.avatar !== false;
  const shift = options.shift !== false;
  const i18n = options.i18n !== false;
  const i18nOverride =
    typeof options.i18nOverride === 'string' && options.i18nOverride.trim()
      ? resolve(process.cwd(), options.i18nOverride.trim())
      : undefined;

  const { version } = prepareRuntimePayload({
    rootDir,
    avatar,
    shift,
    i18n,
    i18nOverride,
  });

  const paths = getPluginPaths({
    home,
    env,
    pluginDir: options.pluginDir,
    configFile: options.configFile,
    dataDir: options.dataDir,
  });

  const resolvedPluginsRoot = resolve(paths.pluginsRoot);
  const resolvedPluginDir = resolve(paths.pluginDir);
  if (dirname(resolvedPluginDir) !== resolvedPluginsRoot) {
    // 若测试传入了自定义路径则允许，默认目录必须落在 plugins 根下且不能是符号链接
  } else if (existsSync(resolvedPluginDir) && lstatSync(resolvedPluginDir).isSymbolicLink()) {
    throw new Error(`插件目标路径不得为符号链接：${resolvedPluginDir}`);
  }

  mkdirSync(paths.sidecarDir, { recursive: true });
  mkdirSync(join(paths.pluginDir, 'src'), { recursive: true });
  mkdirSync(join(paths.pluginDir, 'assets'), { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });

  for (const name of BUNDLED_SRC_FILES) {
    cpSync(join(rootDir, 'src', name), join(paths.pluginDir, 'src', name));
  }
  for (const relAsset of BUNDLED_ASSET_FILES) {
    const dest = join(paths.pluginDir, 'assets', relAsset);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(rootDir, 'assets', relAsset), dest);
  }
  const userOverrideFile = join(rootDir, 'user', 'i18n.override.json');
  if (existsSync(userOverrideFile)) {
    mkdirSync(join(paths.pluginDir, 'user'), { recursive: true });
    cpSync(userOverrideFile, join(paths.pluginDir, 'user', 'i18n.override.json'));
  }

  writeFileSync(
    join(paths.pluginDir, 'package.json'),
    `${JSON.stringify({ name: PLUGIN_ID, version, type: 'module', private: true }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(paths.pluginDir, 'assets', 'logo.svg'), buildPluginLogoSvg(), 'utf8');
  writeFileSync(
    paths.manifestFile,
    `${JSON.stringify(
      {
        name: PLUGIN_ID,
        display_name: PLUGIN_DISPLAY_NAME,
        description: '面向 Google Antigravity 2.x 的冬雪莲暖纸白浅色主题与离线简体中文汉化插件',
        version,
        logo: 'assets/logo.svg',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    paths.sidecarManifestFile,
    `${JSON.stringify(buildSidecarManifest(), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(paths.panelHtmlFile, buildPluginPanelHtml(), 'utf8');
  writeFileSync(paths.sidecarEntryFile, buildSidecarEntrySource(), 'utf8');

  atomicWriteJson(paths.settingsFile, {
    version,
    repoRoot: rootDir,
    avatar,
    shift,
    i18n,
    ...(i18nOverride ? { i18nOverride } : {}),
    ...(options.port ? { port: options.port } : {}),
    installedAt: new Date().toISOString(),
  });

  const config = readJsonObject(paths.configFile);
  const plugins = config.plugins && typeof config.plugins === 'object' ? { ...config.plugins } : {};
  const existingEntry = plugins[PLUGIN_ID] && typeof plugins[PLUGIN_ID] === 'object' ? { ...plugins[PLUGIN_ID] } : {};
  plugins[PLUGIN_ID] = { ...existingEntry, enabled: true };
  config.plugins = plugins;
  atomicWriteJson(paths.configFile, config);

  const launch = await ensureDesktopLaunchConfig({
    platform,
    home,
    env,
    stateFile: paths.launchStateFile,
    execPowerShell: options.execPowerShell,
    systemDirs: options.systemDirs,
  });

  const appPatch = getAppAsarStatus({ appAsar: options.appAsar, platform, env, home });

  logger.log(`[冬雪莲 v${version}] Antigravity 插件模式安装完成！`);
  logger.log(`  - 插件目录：${paths.pluginDir}`);
  logger.log(`  - Sidecar 声明：${paths.sidecarManifestFile}`);
  logger.log(
    `  - 快捷方式自愈：${launch.configured ? `已就绪（${launch.entrypoints.length} 个入口已带回环调试参数）` : '未检测到支持自动修改的桌面快捷方式'}`,
  );
  if (appPatch.patched) {
    logger.log(
      '  - 提示：检测到客户端 app.asar 当前已有直注补丁，插件可与之共存；也可退出客户端后运行 npm run unpatch-app 还原原版安装包。',
    );
  }
  logger.log('  - 下一步：完全退出并从快捷方式重开一次 Antigravity，宿主将自动托管启动主题 Sidecar。');

  return {
    installed: true,
    version,
    pluginDir: paths.pluginDir,
    configFile: paths.configFile,
    settingsFile: paths.settingsFile,
    launch,
  };
}

/**
 * 卸载冬雪莲 Antigravity 插件：撤回自设的快捷方式调试参数、清理配置登记并删除插件目录。
 * @param {object} [options]
 */
export async function uninstallPlugin(options = {}) {
  const home = options.home || homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const logger = options.logger ?? console;
  const paths = getPluginPaths({
    home,
    env,
    pluginDir: options.pluginDir,
    configFile: options.configFile,
    dataDir: options.dataDir,
  });

  const revertRes = await removeDesktopLaunchConfig({
    platform,
    home,
    env,
    stateFile: paths.launchStateFile,
    execPowerShell: options.execPowerShell,
  });

  if (existsSync(paths.configFile)) {
    const config = readJsonObject(paths.configFile);
    if (config.plugins && Object.prototype.hasOwnProperty.call(config.plugins, PLUGIN_ID)) {
      delete config.plugins[PLUGIN_ID];
    }
    if (config.sidecars && Object.prototype.hasOwnProperty.call(config.sidecars, `${PLUGIN_ID}/${PLUGIN_SIDECAR_NAME}`)) {
      delete config.sidecars[`${PLUGIN_ID}/${PLUGIN_SIDECAR_NAME}`];
    }
    atomicWriteJson(paths.configFile, config);
  }

  const portFile = options.portFile || getPortFilePath({ platform, env, home });
  const removeRes = await removeOnce({
    ...options,
    portFile,
    pidFile: paths.pidFile,
    logger,
    skipAutostartHint: true,
  }).catch(() => ({ stoppedWatcher: false }));
  if (removeRes?.stoppedWatcher) {
    await new Promise((r) => setTimeout(r, 150));
  }

  let removedPluginDir = false;
  if (existsSync(paths.pluginDir)) {
    if (lstatSync(paths.pluginDir).isSymbolicLink()) {
      unlinkQuietly(paths.pluginDir);
      removedPluginDir = true;
    } else {
      rmSync(paths.pluginDir, { recursive: true, force: true });
      removedPluginDir = true;
    }
  }

  unlinkQuietly(paths.statusFile);
  unlinkQuietly(paths.pidFile);

  logger.log(
    `[冬雪莲] 插件模式卸载完成：${removedPluginDir ? '已删除插件目录，' : ''}${revertRes.revertedCount > 0 ? `已撤回 ${revertRes.revertedCount} 个快捷方式参数，` : ''}已清理配置项。`,
  );

  return {
    uninstalled: true,
    removedPluginDir,
    revertedShortcuts: revertRes.revertedCount,
  };
}

/**
 * 查询冬雪莲 Antigravity 插件与 Sidecar 当前运行状态。
 * @param {object} [options]
 */
export function getPluginStatus(options = {}) {
  const home = options.home || homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = getPluginPaths({
    home,
    env,
    pluginDir: options.pluginDir,
    configFile: options.configFile,
    dataDir: options.dataDir,
  });

  const installed = existsSync(paths.manifestFile) && existsSync(paths.sidecarManifestFile);
  const config = readJsonObject(paths.configFile);
  const pluginEntry = config.plugins?.[PLUGIN_ID];
  const enabled = installed && pluginEntry?.enabled !== false;
  const settings = existsSync(paths.settingsFile) ? readJsonObject(paths.settingsFile) : null;
  const sidecarPid = readLiveWatcherPid(paths.pidFile);
  const rawIntegration = existsSync(paths.statusFile) ? readJsonObject(paths.statusFile) : null;
  const integration =
    !sidecarPid && rawIntegration && rawIntegration.state === 'active'
      ? { ...rawIntegration, state: 'stopped', attachedCount: 0, message: 'Sidecar 未运行' }
      : rawIntegration;
  const launch = inspectDesktopLaunch({ platform, home, env });

  return {
    installed,
    enabled,
    running: Boolean(sidecarPid),
    pid: sidecarPid,
    version: settings?.version || (installed ? readJsonObject(paths.manifestFile).version : null) || null,
    pluginDir: paths.pluginDir,
    settings,
    integration,
    launch,
  };
}
