import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import {
  REMOVE_EXPRESSION,
  buildInjectScript,
  getPortFilePath,
  isAntigravityAppUrl,
  listPages,
  readPort,
} from '../src/cdp.js';
import { MiniWebSocket } from '../src/net.js';
import { injectOnce, parseCliArgs, prepareRuntimePayload, removeOnce, startWatch } from '../src/runner.js';
import { startMockCdpServer } from './helpers/mock-cdp.mjs';
import { createMockAntigravityPage } from './helpers/mock-dom.mjs';

const ROOT = new URL('../', import.meta.url);

test('getPortFilePath 按各平台规则解析 DevToolsActivePort 路径', () => {
  assert.equal(
    getPortFilePath({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
      home: 'C:\\Users\\Alice',
    }),
    join('C:\\Users\\Alice\\AppData\\Roaming', 'Antigravity', 'DevToolsActivePort'),
  );
  assert.equal(
    getPortFilePath({
      platform: 'darwin',
      env: {},
      home: '/Users/alice',
    }),
    join('/Users/alice', 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
  );
  assert.equal(
    getPortFilePath({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/alice/.xdg' },
      home: '/home/alice',
    }),
    join('/home/alice/.xdg', 'Antigravity', 'DevToolsActivePort'),
  );
});

test('readPort 与 parseCliArgs 校验端口、开关与异常参数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dxl-port-'));
  try {
    const portFile = join(dir, 'DevToolsActivePort');
    writeFileSync(portFile, '9229\n/devtools/browser/abc\n', 'utf8');
    assert.equal(readPort(portFile), 9229);
    assert.equal(readPort(join(dir, 'missing'), { port: 9333 }), 9333);

    writeFileSync(portFile, '\n', 'utf8');
    assert.throws(() => readPort(portFile), /为空/);
    assert.throws(() => readPort(join(dir, 'missing')), /未找到 DevToolsActivePort/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(parseCliArgs(['--port', '9222', '--no-avatar', '--no-shift']), {
    port: 9222,
    avatar: false,
    shift: false,
    i18n: true,
    i18nOverride: undefined,
    daemon: false,
    ifNotRunning: false,
    help: false,
  });
  assert.deepEqual(parseCliArgs(['--port=9444', '-h']), {
    port: 9444,
    avatar: true,
    shift: true,
    i18n: true,
    i18nOverride: undefined,
    daemon: false,
    ifNotRunning: false,
    help: true,
  });
  assert.deepEqual(parseCliArgs(['--daemon', '--if-not-running']), {
    port: undefined,
    avatar: true,
    shift: true,
    i18n: true,
    i18nOverride: undefined,
    daemon: true,
    ifNotRunning: true,
    help: false,
  });
  assert.throws(() => parseCliArgs(['--unknown-flag']), /未知参数/);
  assert.throws(() => parseCliArgs(['--port', '70000']), /无效的调试端口号/);
});

test('运行时脚本仅在 theme-light 生效、自动退出深色模式且卸载无残留', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    version: '0.1.0',
  });

  const page = createMockAntigravityPage({ light: true });
  const res = page.evaluate(script);
  assert.equal(res.injected, true);
  assert.equal(res.lightMode, true);
  assert.equal(res.hasStage, true);
  assert.equal(res.hasAvatar, true);

  assert.ok(page.document.getElementById('dxl-antigravity-theme'), '缺少注入样式节点');
  assert.equal(page.elements.docEl.getAttribute('data-dxl-theme'), '0.1.0');
  assert.equal(page.elements.stage.getAttribute('data-dxl-stage'), 'conversation');
  assert.equal(page.elements.dialog.getAttribute('data-dxl-stage'), null, '弹窗不应被标为对话舞台');
  assert.equal(page.elements.userTrack.getAttribute('data-dxl-reading-track'), 'true');
  assert.equal(page.elements.replyTrack.getAttribute('data-dxl-reading-track'), 'true');
  assert.equal(page.elements.composerTrack.getAttribute('data-dxl-reading-track'), 'true');
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar="true"]').length, 1);

  // 切至深色模式并触发 MutationObserver
  page.elements.body.classList.remove('theme-light');
  page.elements.body.classList.add('theme-dark');
  for (const obs of page.observers) {
    obs.trigger();
  }
  assert.equal(page.elements.stage.getAttribute('data-dxl-stage'), null, '深色模式应自动撤销 stage 标记');
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar="true"]').length, 0, '深色模式应隐藏并移除头像');

  // 切回浅色模式自动恢复
  page.elements.body.classList.remove('theme-dark');
  page.elements.body.classList.add('theme-light');
  for (const obs of page.observers) {
    obs.trigger();
  }
  assert.equal(page.elements.stage.getAttribute('data-dxl-stage'), 'conversation');
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar="true"]').length, 1);

  // 测试 --no-avatar 与 --no-shift 重注入幂等覆盖
  const noOptScript = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: false,
    shift: false,
    version: '0.1.0',
  });
  page.evaluate(noOptScript);
  assert.equal(page.elements.docEl.getAttribute('data-dxl-shift'), 'off');
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar="true"]').length, 0);

  // 执行卸载脚本应彻底清理
  const removeSummary = page.evaluate(REMOVE_EXPRESSION);
  assert.equal(removeSummary.removed, true);
  assert.equal(removeSummary.removedStyle, 1);
  assert.equal(page.document.getElementById('dxl-antigravity-theme'), null);
  assert.equal(page.elements.docEl.getAttribute('data-dxl-theme'), null);
  assert.equal(page.elements.docEl.getAttribute('data-dxl-shift'), null);
  assert.equal(page.document.querySelectorAll('[data-dxl-stage]').length, 0);
  assert.equal(page.document.querySelectorAll('[data-dxl-reading-track]').length, 0);
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar]').length, 0);
  assert.equal(page.observers.every((o) => !o.connected), true, '卸载后所有 MutationObserver 应断开');
});

test('新版 Antigravity 布局优先将 [data-main-content-body] > .flex-1.min-h-0 标为舞台而非 .mx-auto，并挂载左侧栏首行头像', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    version: '0.1.0',
  });

  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { body } = elements;
  document.getElementById('root')?.remove();

  const root = document.createElement('div');
  root.id = 'root';
  body.appendChild(root);

  const sidebarSplit = document.createElement('div');
  sidebarSplit.setAttribute('data-testid', 'sidebar-split');
  const sidebarCol = document.createElement('div');
  sidebarCol.setAttribute('class', 'bg-sidebar flex-col');
  const sidebarTopBar = document.createElement('div');
  sidebarTopBar.setAttribute('class', 'flex items-center');
  sidebarCol.appendChild(sidebarTopBar);
  sidebarSplit.appendChild(sidebarCol);

  const mainBody = document.createElement('div');
  mainBody.setAttribute('data-main-content-body', 'true');
  const fullStage = document.createElement('div');
  fullStage.setAttribute('class', 'flex-1 min-h-0');
  const scrollArea = document.createElement('div');
  scrollArea.setAttribute('class', 'overflow-y-auto');
  const narrowCol = document.createElement('div');
  narrowCol.setAttribute('class', 'mx-auto w-full');
  const userStep = document.createElement('div');
  userStep.setAttribute('data-testid', 'user-input-step');
  narrowCol.appendChild(userStep);
  const agentCol = document.createElement('div');
  agentCol.setAttribute('class', 'mx-auto w-full');
  const agentResp = document.createElement('div');
  agentResp.setAttribute('data-testid', 'agent-response');
  agentCol.appendChild(agentResp);
  scrollArea.appendChild(narrowCol);
  scrollArea.appendChild(agentCol);

  const composerWrap = document.createElement('div');
  composerWrap.setAttribute('class', 'mx-auto w-full');
  const inputBox = document.createElement('div');
  inputBox.id = 'antigravity.agentSidePanelInputBox';
  composerWrap.appendChild(inputBox);

  fullStage.appendChild(scrollArea);
  fullStage.appendChild(composerWrap);
  mainBody.appendChild(fullStage);
  root.appendChild(sidebarSplit);
  root.appendChild(mainBody);

  const res = page.evaluate(script);
  assert.equal(res.hasStage, true);
  assert.equal(res.hasAvatar, true);
  assert.equal(fullStage.getAttribute('data-dxl-stage'), 'conversation', '主舞台应落在不随消息滚动的 .flex-1.min-h-0');
  assert.equal(narrowCol.getAttribute('data-dxl-stage'), null, '.mx-auto 阅读列不应被标为主舞台');
  assert.equal(narrowCol.getAttribute('data-dxl-reading-track'), 'true', '聊天阅读列应被标记左移轨道');
  assert.equal(agentCol.getAttribute('data-dxl-reading-track'), 'true', '包含 agent-response 的回复列应被标记左移轨道');
  assert.equal(composerWrap.getAttribute('data-dxl-reading-track'), 'true', '输入框包裹层应被标记左移轨道');
  assert.equal(sidebarTopBar.firstElementChild?.getAttribute('data-dxl-avatar'), 'true', '无顶部品牌按钮时应回退至左侧栏首个子节点');

  // 加入原生 app-icon-new-conversation-button 浮层按钮后，触发变更应迁移至该按钮内部并清理回退槽
  const appIconBtn = document.createElement('button');
  appIconBtn.setAttribute('data-testid', 'app-icon-new-conversation-button');
  const nativeSvg = document.createElement('svg');
  appIconBtn.appendChild(nativeSvg);
  root.prepend(appIconBtn);
  for (const obs of page.observers) {
    obs.trigger();
  }
  assert.equal(appIconBtn.firstElementChild?.getAttribute('data-dxl-avatar'), 'true', '头像应原地替换挂载在 app-icon-new-conversation-button 内');
  assert.equal(sidebarTopBar.querySelectorAll('[data-dxl-avatar]').length, 0, '旧回退占位槽内不应残留重复头像');
  assert.equal(document.querySelectorAll('[data-dxl-avatar="true"]').length, 1);
});

test('Mock CDP 端到端测试：injectOnce、watch 自动挂载/热重载、removeOnce 清理与未运行容错', async () => {
  const domMap = new Map();
  const server = await startMockCdpServer({
    onEvaluate: (pageState, expression) => {
      if (!domMap.has(pageState.id)) {
        domMap.set(pageState.id, createMockAntigravityPage({ light: true }));
      }
      return domMap.get(pageState.id).evaluate(expression);
    },
  });

  const dir = mkdtempSync(join(tmpdir(), 'dxl-e2e-'));
  const portFile = join(dir, 'DevToolsActivePort');
  const pidFile = join(dir, '.watch.pid');
  writeFileSync(portFile, `${server.port}\n`, 'utf8');

  try {
    server.addPage({ id: 'main-win', title: 'Antigravity', url: 'https://127.0.0.1:50000/c/main' });
    server.setRawTargets([
      {
        id: 'devtools-win',
        type: 'page',
        url: 'devtools://devtools/bundled/inspector.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/devtools-win`,
      },
      {
        id: 'ext-web',
        type: 'page',
        title: '中国教育考试网',
        url: 'https://cet.neea.edu.cn/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/ext-web`,
      },
      {
        id: 'blank-tab',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/blank-tab`,
      },
      {
        id: 'bg-worker',
        type: 'background_page',
        url: 'https://127.0.0.1:50000/c/bg',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/bg-worker`,
      },
    ]);

    const pages = await listPages(server.port);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].id, 'main-win');

    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

    // 1. injectOnce
    const injectRes = await injectOnce({ portFile, logger: silentLogger });
    assert.equal(injectRes.injectedCount, 1);
    assert.equal(injectRes.results[0].evalResult.injected, true);
    assert.equal(server.getPageState('main-win').docScripts.size, 1);

    // 2. startWatch：挂载已有窗口、凭 Target.targetCreated 事件自动追踪新开窗口（零轮询）、热重载 CSS
    const watcher = await startWatch({
      portFile,
      pidFile,
      logger: silentLogger,
    });
    try {
      assert.equal(existsSync(pidFile), true, 'startWatch 应写入 .watch.pid');
      assert.equal(watcher.getAttachedCount(), 1);

      server.addPage({ id: 'aux-win', title: 'Antigravity Second Window' });
      const attachDeadline = Date.now() + 500;
      while (watcher.getAttachedCount() < 2 && Date.now() < attachDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(watcher.getAttachedCount(), 2, '应无需手动 syncNow，仅凭 CDP Target 事件推送自动发现并注入新窗口');

      const reloaded = await watcher.reinjectNow();
      assert.equal(reloaded, 2, '应向全部已挂载页面热重载样式');
      assert.equal(server.getPageState('aux-win').docScripts.size, 1, '热重载应替换旧注册脚本而不是叠加');
    } finally {
      await watcher.stop();
    }
    assert.equal(existsSync(pidFile), false, 'stop 后应清理 .watch.pid');

    // 3. removeOnce：移除 DOM 注入内容
    const removeRes = await removeOnce({ portFile, pidFile, logger: silentLogger });
    assert.equal(removeRes.running, true);
    assert.equal(removeRes.removedCount, 2);
    for (const id of ['main-win', 'aux-win']) {
      const mockPage = domMap.get(id);
      assert.equal(mockPage.document.getElementById('dxl-antigravity-theme'), null);
      assert.equal(mockPage.document.querySelectorAll('[data-dxl-avatar]').length, 0);
    }

    // 4. Antigravity 未运行 / 端口不存在时 removeOnce 优雅退出
    const offlineRes = await removeOnce({
      portFile: join(dir, 'non-existent-port-file'),
      pidFile,
      logger: silentLogger,
    });
    assert.equal(offlineRes.running, false);
    assert.equal(offlineRes.removedCount, 0);

    // 5. 若页面存在 #ag-custom-fonts (theme-patch)，injectOnce 应识别并打印警告
    server.addPage({ id: 'conflict-win', title: 'Conflict Window' });
    const conflictPage = createMockAntigravityPage({ light: true });
    const fakeAgStyle = conflictPage.document.createElement('style');
    fakeAgStyle.id = 'ag-custom-fonts';
    conflictPage.elements.head.appendChild(fakeAgStyle);
    domMap.set('conflict-win', conflictPage);

    const warnings = [];
    const conflictRes = await injectOnce({
      portFile,
      logger: {
        log: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
    });
    assert.equal(conflictRes.injectedCount, 3);
    assert.equal(
      warnings.some((w) => w.includes('chuanban-antigravity-theme-patch')),
      true,
      '检测到 #ag-custom-fonts 时应打印冲突警告',
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('document-start 场景下在 head/body 就绪后自动迁移样式至 head 并完成舞台与头像初始化', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    version: '0.1.0',
  });

  const page = createMockAntigravityPage({ light: true });
  const savedHead = page.elements.head;
  const savedBody = page.elements.body;
  savedHead.remove();
  savedBody.remove();
  page.document.head = null;
  page.document.body = null;
  page.document.readyState = 'loading';

  const listeners = new Map();
  page.document.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  page.document.removeEventListener = (type, fn) => {
    listeners.get(type)?.delete(fn);
  };

  const earlyRes = page.evaluate(script);
  assert.equal(earlyRes.injected, true);
  assert.equal(earlyRes.lightMode, false);
  const earlyStyle = page.document.getElementById('dxl-antigravity-theme');
  assert.ok(earlyStyle);
  assert.equal(earlyStyle.parentElement, page.elements.docEl, 'head 尚未出现时样式应暂挂在 html 下');

  page.elements.docEl.appendChild(savedHead);
  page.elements.docEl.appendChild(savedBody);
  page.document.head = savedHead;
  page.document.body = savedBody;
  page.document.readyState = 'complete';
  for (const fn of Array.from(listeners.get('DOMContentLoaded') || [])) {
    listeners.get('DOMContentLoaded').delete(fn);
    fn();
  }

  assert.equal(earlyStyle.parentElement, savedHead, 'DOM 就绪后样式应迁入 document.head');
  assert.equal(page.elements.stage.getAttribute('data-dxl-stage'), 'conversation');
  assert.equal(page.document.querySelectorAll('[data-dxl-avatar="true"]').length, 1);
});

test('startWatch 监听目录变化支持新建 user/i18n.override.json 热重载，removeOnce 终止进程并清理 .watch.pid', async () => {
  const domMap = new Map();
  const server = await startMockCdpServer({
    onEvaluate: (pageState, expression) => {
      if (!domMap.has(pageState.id)) {
        const page = createMockAntigravityPage({ light: true });
        const label = page.document.createElement('button');
        label.appendChild(page.document.createTextNode('New Conversation'));
        page.elements.sidebar.appendChild(label);
        page.customLabel = label;
        domMap.set(pageState.id, page);
      }
      return domMap.get(pageState.id).evaluate(expression);
    },
  });

  const dir = mkdtempSync(join(tmpdir(), 'dxl-watch-dir-'));
  const portFile = join(dir, 'DevToolsActivePort');
  const pidFile = join(dir, '.watch.pid');
  const tempRoot = join(dir, 'workspace');
  mkdirSync(join(tempRoot, 'assets', 'characters', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'scenes', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'textures', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'i18n'), { recursive: true });
  mkdirSync(join(tempRoot, 'src'), { recursive: true });
  mkdirSync(join(tempRoot, 'user'), { recursive: true });

  cpSync(new URL('../assets/characters/web/avatar.webp', import.meta.url), join(tempRoot, 'assets', 'characters', 'web', 'avatar.webp'));
  cpSync(new URL('../assets/scenes/web/reading.webp', import.meta.url), join(tempRoot, 'assets', 'scenes', 'web', 'reading.webp'));
  cpSync(new URL('../assets/textures/web/paper.webp', import.meta.url), join(tempRoot, 'assets', 'textures', 'web', 'paper.webp'));
  cpSync(new URL('../src/theme.css', import.meta.url), join(tempRoot, 'src', 'theme.css'));
  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
  writeFileSync(join(tempRoot, 'assets', 'i18n', 'zh-CN.json'), JSON.stringify({ 'New Conversation': '新建对话' }), 'utf8');
  writeFileSync(portFile, `${server.port}\n`, 'utf8');

  let dummyChild = null;
  try {
    server.addPage({ id: 'win-dir', title: 'Antigravity' });
    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

    const watcher = await startWatch({
      rootDir: tempRoot,
      portFile,
      pidFile,
      pollIntervalMs: 5000,
      cssDebounceMs: 40,
      logger: silentLogger,
    });
    try {
      const page = domMap.get('win-dir');
      assert.equal(page.customLabel.textContent, '新建对话');

      // 在启动时 user/i18n.override.json 并不存在，运行期新建后应自动触发热重载
      writeFileSync(
        join(tempRoot, 'user', 'i18n.override.json'),
        JSON.stringify({ 'New Conversation': '目录监听新建热重载' }),
        'utf8',
      );
      const deadline = Date.now() + 2500;
      while (page.customLabel.textContent !== '目录监听新建热重载' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(page.customLabel.textContent, '目录监听新建热重载');

      const [r1, r2] = await Promise.all([watcher.reinjectNow(), watcher.reinjectNow()]);
      assert.equal(r1, 1);
      assert.equal(r2, 1);
      assert.equal(server.getPageState('win-dir').docScripts.size, 1);
    } finally {
      await watcher.stop();
    }

    // 模拟仍在运行的外部监听进程 + .watch.pid，验证 removeOnce 在终止进程后清理残留 .watch.pid
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    writeFileSync(pidFile, `${dummyChild.pid}\n`, 'utf8');
    const exitPromise = new Promise((resolveExit) => {
      dummyChild.once('exit', resolveExit);
    });

    const removeRes = await removeOnce({ portFile, pidFile, logger: silentLogger });
    assert.equal(removeRes.stoppedWatcher, true);
    await exitPromise;
    assert.equal(existsSync(pidFile), false, 'removeOnce 停止监听进程后应清理 .watch.pid');
  } finally {
    if (dummyChild && dummyChild.exitCode === null) {
      try {
        dummyChild.kill();
      } catch {
        // 忽略清理子进程异常
      }
    }
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isAntigravityAppUrl 与页面端二次防护严格排除外部网页与 iframe，且单页失败不影响其他页面', async () => {
  // 1. URL 白名单判定
  assert.equal(isAntigravityAppUrl('https://127.0.0.1:63587/c/123?project=abc'), true);
  assert.equal(isAntigravityAppUrl('https://localhost:8080/'), true);
  assert.equal(isAntigravityAppUrl('https://[::1]:8443/app'), true);
  assert.equal(isAntigravityAppUrl('vscode-file://vscode-app/workbench/workbench.html'), true);

  assert.equal(isAntigravityAppUrl('https://cet.neea.edu.cn/'), false);
  assert.equal(isAntigravityAppUrl('http://127.0.0.1:8080/'), false);
  assert.equal(isAntigravityAppUrl('about:blank'), false);
  assert.equal(isAntigravityAppUrl('devtools://devtools/bundled/inspector.html'), false);
  assert.equal(isAntigravityAppUrl('data:text/html,hello'), false);

  // 2. 页面端脚本二次防护（外部 URL 与 subframe）
  const css = buildThemeCss({ rootDir: ROOT });
  const script = buildInjectScript(css, { avatar: false, shift: true, i18n: false, version: '0.1.0' });

  const foreignPage = createMockAntigravityPage({ light: true });
  foreignPage.evaluate('globalThis.location = { href: "https://cet.neea.edu.cn/" };');
  const foreignRes = foreignPage.evaluate(script);
  assert.equal(foreignRes.injected, false);
  assert.equal(foreignRes.skipped, 'foreign-url');
  assert.equal(foreignPage.document.getElementById('dxl-antigravity-theme'), null);

  const iframePage = createMockAntigravityPage({ light: true });
  iframePage.evaluate('window.top = {}; globalThis.location = { href: "https://127.0.0.1:63587/c/1" };');
  const iframeRes = iframePage.evaluate(script);
  assert.equal(iframeRes.injected, false);
  assert.equal(iframeRes.skipped, 'subframe');
  assert.equal(iframePage.document.getElementById('dxl-antigravity-theme'), null);

  // 3. 单页故障容错：其中一个 target WebSocket 连接失败时，其余页面仍能正常 injectOnce / removeOnce
  const domMap = new Map();
  const server = await startMockCdpServer({
    onEvaluate: (pageState, expression) => {
      if (!domMap.has(pageState.id)) {
        domMap.set(pageState.id, createMockAntigravityPage({ light: true }));
      }
      return domMap.get(pageState.id).evaluate(expression);
    },
  });
  try {
    server.addPage({ id: 'good-win', title: 'Antigravity Good' });
    server.setRawTargets([
      {
        id: 'dead-win',
        type: 'page',
        title: 'Broken Target',
        url: `https://127.0.0.1:${server.port}/c/dead`,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/nonexistent`,
      },
    ]);

    const warnings = [];
    const logger = { log: () => {}, warn: (m) => warnings.push(m), error: () => {} };

    const injectRes = await injectOnce({ port: server.port, timeoutMs: 500, logger });
    assert.equal(injectRes.injectedCount, 1);
    assert.equal(injectRes.failures.length, 1);
    assert.equal(injectRes.failures[0].id, 'dead-win');
    assert.ok(domMap.get('good-win').document.getElementById('dxl-antigravity-theme'));

    // 必须显式指定隔离的 pidFile，否则会读取仓库根目录 .watch.pid 并误杀本机正在运行的真实守护进程
    const isolatedPidFile = join(tmpdir(), `dxl-test-${process.pid}-${Date.now()}.pid`);
    const removeRes = await removeOnce({ port: server.port, timeoutMs: 500, logger, pidFile: isolatedPidFile });
    assert.equal(removeRes.removedCount, 1);
    assert.equal(removeRes.failures.length, 1);
    assert.equal(domMap.get('good-win').document.getElementById('dxl-antigravity-theme'), null);
    assert.ok(warnings.length >= 2);
  } finally {
    await server.close();
  }
});

test('MiniWebSocket 关闭竞态与缓冲复位安全，startWatch.stop 不误删新进程覆写的 .watch.pid', async () => {
  // 1. 单包多帧中第 1 帧同步关闭连接时，不解析第 2 帧且正确复位 _buffered
  const makeServerTextFrame = (text) => {
    const body = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  };
  const wsSockets = new Set();
  const wsServer = createServer();
  let delayedSocketRef = null;
  wsServer.on('upgrade', (req, socket) => {
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const writeHandshake = () => {
      if (socket.destroyed) return;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    };
    if (req.url === '/multi-frame') {
      writeHandshake();
      socket.write(Buffer.concat([makeServerTextFrame('first'), makeServerTextFrame('second')]));
    } else if (req.url === '/delayed') {
      delayedSocketRef = socket;
      setTimeout(writeHandshake, 40);
    }
  });
  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const wsPort = wsServer.address().port;

  try {
    const received = [];
    await new Promise((resolve, reject) => {
      const ws = new MiniWebSocket(`ws://127.0.0.1:${wsPort}/multi-frame`);
      ws.addEventListener('message', (ev) => {
        received.push(ev.data);
        ws.close();
      });
      ws.addEventListener('error', (ev) => reject(ev.error || new Error(ev.message)));
      ws.addEventListener('close', () => {
        assert.equal(ws._buffered, 0);
        resolve();
      });
    });
    assert.deepEqual(received, ['first']);

    // 握手未完成即 close 时不复活、不触发 open
    let openedAfterClose = false;
    await new Promise((resolve) => {
      const ws2 = new MiniWebSocket(`ws://127.0.0.1:${wsPort}/delayed`);
      ws2.addEventListener('open', () => {
        openedAfterClose = true;
      });
      ws2.addEventListener('close', resolve);
      ws2.close();
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(openedAfterClose, false);
    assert.equal(delayedSocketRef ? delayedSocketRef.destroyed || delayedSocketRef.closed : true, true);
  } finally {
    for (const sock of wsSockets) sock.destroy();
    await new Promise((r) => wsServer.close(r));
  }

  // 2. startWatch.stop 仅清理自己拥有的 .watch.pid
  const dir = mkdtempSync(join(tmpdir(), 'dxl-pid-owner-'));
  const pidFile = join(dir, '.watch.pid');
  const portFile = join(dir, 'DevToolsActivePort');
  try {
    const watcher = await startWatch({
      rootDir: ROOT,
      portFile,
      pidFile,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.equal(readFileSync(pidFile, 'utf8').trim(), String(process.pid));
    writeFileSync(pidFile, '999999\n', 'utf8');
    await watcher.stop();
    assert.equal(existsSync(pidFile), true, '新进程覆写 PID 后，旧进程 stop 不应误删文件');
    assert.equal(readFileSync(pidFile, 'utf8').trim(), '999999');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回归测试：MiniWebSocket UTF-8 关闭原因截断/半开兜底/64位帧长校验，startWatch.stop 竞态与缺失目录重建监听', async () => {
  // 1. MiniWebSocket.close 按 UTF-8 字节截断 reason <= 123 字节，半开 Close 帧兜底销毁，len=127 超限报错
  const wsSockets = new Set();
  let lastClosePayload = null;
  const wsServer = createServer();
  wsServer.on('upgrade', (req, socket) => {
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    if (req.url === '/utf8-close') {
      let rx = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        if (rx.length < 6) return;
        const lenByte = rx[1] & 0x7f;
        if (lenByte >= 126) {
          lastClosePayload = Buffer.alloc(lenByte + 10);
          socket.end();
          return;
        }
        if (rx.length < 6 + lenByte) return;
        const mask = rx.subarray(2, 6);
        const body = Buffer.from(rx.subarray(6, 6 + lenByte));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        lastClosePayload = body;
        socket.end(Buffer.from([0x88, 0x00]));
      });
    } else if (req.url === '/half-open-close') {
      // 服务端发送 Close 帧后故意不关闭 TCP 连接，验证客户端 _closeTimer 兜底
      socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    } else if (req.url === '/oversized-64bit') {
      const badHeader = Buffer.alloc(10);
      badHeader[0] = 0x82;
      badHeader[1] = 127;
      badHeader.writeBigUInt64BE(BigInt(128 * 1024 * 1024), 2);
      socket.write(badHeader);
    }
  });
  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  const wsPort = wsServer.address().port;

  try {
    await new Promise((resolve) => {
      const ws = new MiniWebSocket(`ws://127.0.0.1:${wsPort}/utf8-close`);
      ws.addEventListener('open', () => ws.close(1000, '冬'.repeat(60)));
      ws.addEventListener('close', resolve);
    });
    assert.ok(lastClosePayload);
    assert.ok(lastClosePayload.length <= 125, `Close 帧负载不得超过 125 字节，实际 ${lastClosePayload.length}`);
    assert.equal(lastClosePayload.subarray(2).toString('utf8'), '冬'.repeat(41));

    await new Promise((resolve, reject) => {
      const ws = new MiniWebSocket(`ws://127.0.0.1:${wsPort}/half-open-close`);
      const guard = setTimeout(() => reject(new Error('半开 Close 帧未在预期时间内兜底关闭')), 2200);
      ws.addEventListener('close', () => {
        clearTimeout(guard);
        assert.equal(ws.readyState, MiniWebSocket.CLOSED);
        resolve();
      });
    });

    const errMsg = await new Promise((resolve, reject) => {
      const ws = new MiniWebSocket(`ws://127.0.0.1:${wsPort}/oversized-64bit`);
      let capturedErr = null;
      ws.addEventListener('error', (ev) => {
        capturedErr = ev.message;
      });
      ws.addEventListener('close', () => {
        if (capturedErr) resolve(capturedErr);
        else reject(new Error('超限 64 位帧长未触发 error'));
      });
    });
    assert.match(errMsg, /超出安全上限|非法/);
  } finally {
    for (const sock of wsSockets) sock.destroy();
    await new Promise((r) => wsServer.close(r));
  }

  // 2. startWatch.stop() 与 runSyncPass() 并发竞态不泄漏 CdpSession
  const raceSockets = new Set();
  let releaseDelayedUpgrade = null;
  const raceServer = createServer((req, res) => {
    if (req.url === '/json/list') {
      const addr = raceServer.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'race-page',
            type: 'page',
            title: 'Antigravity Race',
            url: `https://127.0.0.1:${addr.port}/c/race`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/race-page`,
          },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let pageAdded = false;
  raceServer.on('upgrade', (req, socket) => {
    raceSockets.add(socket);
    socket.on('close', () => raceSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const completeHandshake = () => {
      if (socket.destroyed) return;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    };
    if (req.url === '/devtools/page/race-page' && pageAdded) {
      releaseDelayedUpgrade = completeHandshake;
    } else {
      socket.destroy();
    }
  });
  await new Promise((resolve) => raceServer.listen(0, '127.0.0.1', resolve));
  const racePort = raceServer.address().port;

  const raceDir = mkdtempSync(join(tmpdir(), 'dxl-stop-race-'));
  const racePidFile = join(raceDir, '.watch.pid');
  try {
    const watcher = await startWatch({
      rootDir: ROOT,
      port: racePort,
      portFile: join(raceDir, 'missing-port'),
      pidFile: racePidFile,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () =>
          pageAdded
            ? [
                {
                  id: 'race-page',
                  type: 'page',
                  title: 'Antigravity Race',
                  url: `https://127.0.0.1:${racePort}/c/race`,
                  webSocketDebuggerUrl: `ws://127.0.0.1:${racePort}/devtools/page/race-page`,
                },
              ]
            : [],
      }),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    pageAdded = true;
    const syncP = watcher.syncNow();
    const waitDeadline = Date.now() + 1500;
    while (!releaseDelayedUpgrade && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(releaseDelayedUpgrade, 'runSyncPass 应已发起 WebSocket 连接');
    const stopP = watcher.stop();
    releaseDelayedUpgrade();
    await Promise.all([stopP, syncP]);
    assert.equal(watcher.getAttachedCount(), 0, 'stop() 与 syncNow() 并发竞态不得遗留已挂载会话');
  } finally {
    for (const sock of raceSockets) sock.destroy();
    await new Promise((r) => raceServer.close(r));
    rmSync(raceDir, { recursive: true, force: true });
  }

  // 3. 初始缺失嵌套 portDir 与 user/ 目录，运行期创建及删建后仍能自动挂接并触发注入与热重载
  const domMap = new Map();
  const cdpServer = await startMockCdpServer({
    onEvaluate: (pageState, expression) => {
      if (!domMap.has(pageState.id)) {
        const page = createMockAntigravityPage({ light: true });
        const btn = page.document.createElement('button');
        btn.appendChild(page.document.createTextNode('New Conversation'));
        page.elements.sidebar.appendChild(btn);
        page.customLabel = btn;
        domMap.set(pageState.id, page);
      }
      return domMap.get(pageState.id).evaluate(expression);
    },
  });
  const watchDir = mkdtempSync(join(tmpdir(), 'dxl-missing-dir-'));
  const tempRoot = join(watchDir, 'workspace');
  const nestedPortDir = join(watchDir, 'nested', 'cfg', 'Antigravity');
  const nestedPortFile = join(nestedPortDir, 'DevToolsActivePort');
  const watchPidFile = join(watchDir, '.watch.pid');
  mkdirSync(join(tempRoot, 'assets', 'characters', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'scenes', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'textures', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'i18n'), { recursive: true });
  mkdirSync(join(tempRoot, 'src'), { recursive: true });
  cpSync(new URL('../assets/characters/web/avatar.webp', import.meta.url), join(tempRoot, 'assets', 'characters', 'web', 'avatar.webp'));
  cpSync(new URL('../assets/scenes/web/reading.webp', import.meta.url), join(tempRoot, 'assets', 'scenes', 'web', 'reading.webp'));
  cpSync(new URL('../assets/textures/web/paper.webp', import.meta.url), join(tempRoot, 'assets', 'textures', 'web', 'paper.webp'));
  cpSync(new URL('../src/theme.css', import.meta.url), join(tempRoot, 'src', 'theme.css'));
  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
  writeFileSync(join(tempRoot, 'assets', 'i18n', 'zh-CN.json'), JSON.stringify({ 'New Conversation': '新建对话' }), 'utf8');

  try {
    cdpServer.addPage({ id: 'late-dir-win', title: 'Antigravity' });
    const watcher = await startWatch({
      rootDir: tempRoot,
      portFile: nestedPortFile,
      pidFile: watchPidFile,
      cssDebounceMs: 40,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      assert.equal(watcher.getAttachedCount(), 0);
      // 先后创建多层不存在的 portDir 与 DevToolsActivePort
      mkdirSync(nestedPortDir, { recursive: true });
      writeFileSync(nestedPortFile, `${cdpServer.port}\n`, 'utf8');
      const connectDeadline = Date.now() + 2500;
      while (watcher.getAttachedCount() < 1 && Date.now() < connectDeadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(watcher.getAttachedCount(), 1, '缺失的多层 portDir 创建后应自动恢复监听并注入');

      // 启动时不存在 user/ 目录，运行期创建 user/ 并写入 i18n.override.json
      mkdirSync(join(tempRoot, 'user'), { recursive: true });
      writeFileSync(
        join(tempRoot, 'user', 'i18n.override.json'),
        JSON.stringify({ 'New Conversation': '延迟目录热重载' }),
        'utf8',
      );
      const reloadDeadline = Date.now() + 2500;
      const page = domMap.get('late-dir-win');
      while (page.customLabel.textContent !== '延迟目录热重载' && Date.now() < reloadDeadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(page.customLabel.textContent, '延迟目录热重载');
    } finally {
      await watcher.stop();
    }
  } finally {
    await cdpServer.close();
    rmSync(watchDir, { recursive: true, force: true });
  }
});

test('prepareRuntimePayload 预编译指纹缓存命中、配置变更失效与源文件更新失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dxl-payload-cache-'));
  const tempRoot = join(dir, 'repo');
  const cacheFile = join(dir, 'payload-cache.json');
  mkdirSync(join(tempRoot, 'assets', 'characters', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'scenes', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'textures', 'web'), { recursive: true });
  mkdirSync(join(tempRoot, 'assets', 'i18n'), { recursive: true });
  mkdirSync(join(tempRoot, 'src'), { recursive: true });
  cpSync(new URL('../assets/characters/web/avatar.webp', import.meta.url), join(tempRoot, 'assets', 'characters', 'web', 'avatar.webp'));
  cpSync(new URL('../assets/scenes/web/reading.webp', import.meta.url), join(tempRoot, 'assets', 'scenes', 'web', 'reading.webp'));
  cpSync(new URL('../assets/textures/web/paper.webp', import.meta.url), join(tempRoot, 'assets', 'textures', 'web', 'paper.webp'));
  cpSync(new URL('../src/theme.css', import.meta.url), join(tempRoot, 'src', 'theme.css'));
  writeFileSync(join(tempRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
  writeFileSync(join(tempRoot, 'assets', 'i18n', 'zh-CN.json'), JSON.stringify({ 'New Conversation': '新建对话' }), 'utf8');

  try {
    const first = prepareRuntimePayload({ rootDir: tempRoot, cacheFile });
    assert.equal(first.fromCache, false);
    assert.equal(existsSync(cacheFile), true);

    const second = prepareRuntimePayload({ rootDir: tempRoot, cacheFile });
    assert.equal(second.fromCache, true);
    assert.equal(second.script, first.script);
    assert.equal(second.version, first.version);

    const optChanged = prepareRuntimePayload({ rootDir: tempRoot, avatar: false, cacheFile });
    assert.equal(optChanged.fromCache, false);
    assert.notEqual(optChanged.script, first.script);

    writeFileSync(
      join(tempRoot, 'assets', 'i18n', 'zh-CN.json'),
      JSON.stringify({ 'New Conversation': '新建会话缓存失效' }),
      'utf8',
    );
    const srcChanged = prepareRuntimePayload({ rootDir: tempRoot, avatar: false, cacheFile });
    assert.equal(srcChanged.fromCache, false);
    assert.match(srcChanged.script, /新建会话缓存失效/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
