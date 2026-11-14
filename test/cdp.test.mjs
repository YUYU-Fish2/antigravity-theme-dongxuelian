import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import {
  REMOVE_EXPRESSION,
  buildInjectScript,
  getPortFilePath,
  listPages,
  readPort,
} from '../src/cdp.js';
import { injectOnce, parseCliArgs, removeOnce, startWatch } from '../src/runner.js';
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
    help: false,
  });
  assert.deepEqual(parseCliArgs(['--port=9444', '-h']), {
    port: 9444,
    avatar: true,
    shift: true,
    help: true,
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
  scrollArea.appendChild(narrowCol);

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
  assert.equal(composerWrap.getAttribute('data-dxl-reading-track'), 'true', '输入框包裹层应被标记左移轨道');
  assert.equal(sidebarTopBar.firstElementChild?.getAttribute('data-dxl-avatar'), 'true', '头像应挂载在左侧栏顶部栏首个子节点');
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
    server.addPage({ id: 'main-win', title: 'Antigravity', url: 'https://antigravity.local/main' });
    server.setRawTargets([
      {
        id: 'devtools-win',
        type: 'page',
        url: 'devtools://devtools/bundled/inspector.html',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/devtools-win`,
      },
      {
        id: 'bg-worker',
        type: 'background_page',
        url: 'https://antigravity.local/bg',
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

    // 2. startWatch：挂载已有窗口、追踪新开窗口、热重载 CSS
    const watcher = await startWatch({
      portFile,
      pidFile,
      pollIntervalMs: 5000,
      logger: silentLogger,
    });
    try {
      assert.equal(existsSync(pidFile), true, 'startWatch 应写入 .watch.pid');
      assert.equal(watcher.getAttachedCount(), 1);

      server.addPage({ id: 'aux-win', title: 'Antigravity Second Window' });
      const countAfterNew = await watcher.syncNow();
      assert.equal(countAfterNew, 2, '应自动发现并注入新窗口');

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
