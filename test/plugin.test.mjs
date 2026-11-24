import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import { buildInjectScript } from '../src/cdp.js';
import {
  DEBUG_ADDRESS_FLAG,
  DEBUG_PORT_FLAG,
  ensureDesktopLaunchConfig,
  hasDebugFlags,
  inspectDesktopLaunch,
  isAntigravityDesktopShortcut,
  mergeDebugArguments,
  mergeDesktopEntry,
  parseLnkBuffer,
  removeDesktopLaunchConfig,
  stripDebugArguments,
} from '../src/launch.js';
import {
  PLUGIN_ID,
  buildPluginPanelHtml,
  getPluginPaths,
  getPluginStatus,
  installPlugin,
  uninstallPlugin,
} from '../src/plugin.js';
import { createMockAntigravityPage } from './helpers/mock-dom.mjs';

const ROOT = new URL('../', import.meta.url);

/** 构造最小可用的 MS-SHLLINK (.lnk) 二进制测试样本（含 Unicode LinkInfo 与 args） */
function createSyntheticLnk({ target, args = '', icon = '' }) {
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  // HasLinkInfo(0x02) + HasArguments(0x20) + IsUnicode(0x80) + optional HasIconLocation(0x40)
  const flags = 0x02 | 0x20 | 0x80 | (icon ? 0x40 : 0);
  header.writeUInt32LE(flags, 0x14);

  const targetAnsi = Buffer.from(`${target}\0`, 'latin1');
  const targetUni = Buffer.from(`${target}\0`, 'utf16le');
  const infoHdrLen = 0x24;
  const infoBuf = Buffer.alloc(infoHdrLen + targetAnsi.length + targetUni.length);
  infoBuf.writeUInt32LE(infoBuf.length, 0);
  infoBuf.writeUInt32LE(infoHdrLen, 4);
  infoBuf.writeUInt32LE(0x01, 8);
  infoBuf.writeUInt32LE(infoHdrLen, 16);
  infoBuf.writeUInt32LE(infoHdrLen + targetAnsi.length, 28);
  targetAnsi.copy(infoBuf, infoHdrLen);
  targetUni.copy(infoBuf, infoHdrLen + targetAnsi.length);

  const encodeStr = (val) => {
    const strBuf = Buffer.from(val, 'utf16le');
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(val.length, 0);
    return Buffer.concat([lenBuf, strBuf]);
  };

  const parts = [header, infoBuf, encodeStr(args)];
  if (icon) parts.push(encodeStr(icon));
  return Buffer.concat(parts);
}

test('launch 快捷方式解析、参数合并/剥离与 Windows/Linux 自愈可逆闭环', async () => {
  assert.deepEqual(hasDebugFlags('--foo "--remote-debugging-port=0"'), {
    hasPort: true,
    hasAddress: false,
  });
  const merged = mergeDebugArguments('--profile-directory=Default -- workspace');
  assert.equal(merged.args, '--profile-directory=Default --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 -- workspace');
  assert.equal(
    stripDebugArguments(merged.args, [DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG]),
    '--profile-directory=Default -- workspace',
  );

  // 合成 .lnk 解析与 IDE 快捷方式过滤
  const desktopLnkBytes = createSyntheticLnk({
    target: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
    args: '--existing',
  });
  const ideLnkBytes = createSyntheticLnk({
    target: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
    args: '--ide --foo',
  });
  const parsed = parseLnkBuffer(desktopLnkBytes);
  assert.equal(isAntigravityDesktopShortcut('C:\\Desktop\\Antigravity.lnk', parsed), true);
  assert.equal(isAntigravityDesktopShortcut('C:\\Desktop\\Antigravity IDE.lnk', parseLnkBuffer(ideLnkBytes)), false);

  const dir = mkdtempSync(join(tmpdir(), 'dxl-launch-'));
  try {
    const desktopDir = join(dir, 'Desktop');
    mkdirSync(desktopDir, { recursive: true });
    const lnkPath = join(desktopDir, 'Antigravity.lnk');
    writeFileSync(lnkPath, desktopLnkBytes);
    const stateFile = join(dir, 'launch-state.json');

    const updates = [];
    const execPowerShell = async (items) => {
      for (const item of items) {
        updates.push(item);
        writeFileSync(
          item.path,
          createSyntheticLnk({
            target: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
            args: item.args,
          }),
        );
      }
    };

    const res = await ensureDesktopLaunchConfig({
      platform: 'win32',
      home: dir,
      env: { ...process.env, APPDATA: join(dir, 'AppData', 'Roaming') },
      stateFile,
      execPowerShell,
    });
    assert.equal(res.configured, true);
    assert.equal(res.repaired, true);
    assert.equal(updates.length, 1);
    assert.ok(updates[0].args.includes(DEBUG_PORT_FLAG));
    assert.ok(updates[0].args.includes(DEBUG_ADDRESS_FLAG));
    assert.equal(inspectDesktopLaunch({ platform: 'win32', home: dir }).configured, true);

    const rev = await removeDesktopLaunchConfig({
      platform: 'win32',
      home: dir,
      stateFile,
      execPowerShell,
    });
    assert.equal(rev.revertedCount, 1);
    assert.equal(parseLnkBuffer(readFileSync(lnkPath)).args, '--existing');

    // Linux .desktop 插入与撤回
    const linuxHome = join(dir, 'linux-home');
    const sysDir = join(dir, 'sys-apps');
    mkdirSync(sysDir, { recursive: true });
    writeFileSync(
      join(sysDir, 'antigravity.desktop'),
      '[Desktop Entry]\nName=Antigravity\nExec=/opt/Antigravity/antigravity %U\n',
      'utf8',
    );
    const linuxState = join(dir, 'linux-state.json');
    const linuxEnsure = await ensureDesktopLaunchConfig({
      platform: 'linux',
      home: linuxHome,
      env: {},
      stateFile: linuxState,
      systemDirs: [sysDir],
    });
    assert.equal(linuxEnsure.configured, true);
    assert.equal(linuxEnsure.repaired, true);
    const desktopOut = readFileSync(join(linuxHome, '.local', 'share', 'applications', 'antigravity.desktop'), 'utf8');
    assert.ok(desktopOut.includes('--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 %U'));
    assert.ok(mergeDesktopEntry('[Desktop Entry]\nExec=antigravity\n').includes('X-Dongxuelian-Theme-Managed=true'));
    const linuxRev = await removeDesktopLaunchConfig({
      platform: 'linux',
      home: linuxHome,
      env: {},
      stateFile: linuxState,
    });
    assert.equal(linuxRev.revertedCount, 1);
    assert.equal(existsSync(join(linuxHome, '.local', 'share', 'applications', 'antigravity.desktop')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installPlugin -> getPluginStatus -> uninstallPlugin 完整隔离闭环并验证 Sidecar Web UI 与退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dxl-plugin-test-'));
  const home = join(dir, 'home');
  const configFile = join(home, '.gemini', 'config', 'config.json');
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  mkdirSync(join(home, 'Desktop'), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      plugins: {
        'antigravity-pulse': { enabled: true },
      },
      userSettings: { themeMode: 'THEME_MODE_INHERIT' },
    }),
    'utf8',
  );
  writeFileSync(
    join(home, 'Desktop', 'Antigravity.lnk'),
    createSyntheticLnk({
      target: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
      args: '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1',
    }),
  );

  const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
  let sidecarChild = null;

  try {
    const installRes = await installPlugin({
      rootDir: ROOT,
      home,
      platform: 'win32',
      env: { ...process.env, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
      logger: silentLogger,
    });
    assert.equal(installRes.installed, true);

    const paths = getPluginPaths({ home });
    assert.equal(existsSync(paths.manifestFile), true);
    assert.equal(existsSync(paths.sidecarManifestFile), true);
    assert.equal(existsSync(paths.sidecarEntryFile), true);
    assert.equal(existsSync(paths.panelHtmlFile), true);

    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(cfg.plugins[PLUGIN_ID].enabled, true);
    assert.equal(cfg.plugins['antigravity-pulse'].enabled, true, '安装不应破坏其他已有插件开关');
    assert.equal(cfg.userSettings.themeMode, 'THEME_MODE_INHERIT');

    const status = getPluginStatus({ home, platform: 'win32', env: { USERPROFILE: home } });
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);
    assert.equal(status.launch.configured, true);

    // 验证 sidecars/theme/main.mjs 在真实 Node 子进程与回退 HTTP UI 服务模式下正常启动和响应
    const webPort = 47000 + (process.pid % 10000);
    sidecarChild = spawn(process.execPath, [paths.sidecarEntryFile], {
      cwd: paths.sidecarDir,
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(webPort),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test-token-123',
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.dataDir,
      },
      stdio: 'ignore',
    });

    const deadline = Date.now() + 4000;
    let stateJson = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}/api/state`);
        if (res.ok) {
          stateJson = await res.json();
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    assert.ok(stateJson, 'Sidecar 回退控制面板服务应成功响应 /api/state');
    assert.equal(stateJson.settings.avatar, true);

    const unauthPost = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: false }),
    });
    assert.equal(unauthPost.status, 401, '未带 sidecar token 的 POST 应拒绝');

    const authPost = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test-token-123' },
      body: JSON.stringify({ avatar: false }),
    });
    assert.equal(authPost.status, 200);
    const updatedState = await authPost.json();
    assert.equal(updatedState.settings.avatar, false);

    sidecarChild.kill('SIGTERM');
    await new Promise((resolveExit) => sidecarChild.once('exit', resolveExit));
    sidecarChild = null;

    const uninstallRes = await uninstallPlugin({
      home,
      platform: 'win32',
      env: { ...process.env, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
      portFile: join(dir, 'missing-port'),
      logger: silentLogger,
    });
    assert.equal(uninstallRes.uninstalled, true);
    assert.equal(uninstallRes.removedPluginDir, true);
    assert.equal(existsSync(paths.pluginDir), false);
    const cfgAfter = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(cfgAfter.plugins[PLUGIN_ID], undefined);
    assert.equal(cfgAfter.plugins['antigravity-pulse'].enabled, true);
  } finally {
    if (sidecarChild && sidecarChild.exitCode === null) {
      sidecarChild.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('i18n 排除列表兼容 Antigrative Dashboard v0.9.5 的 #ag-pulse-status-bar 与 [data-ag-pulse-bar]', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const page = createMockAntigravityPage({ light: true });
  const bar = page.document.createElement('div');
  bar.id = 'ag-pulse-status-bar';
  bar.setAttribute('data-ag-pulse-bar', 'true');
  const label = page.document.createElement('span');
  const textNode = page.document.createTextNode('Settings');
  label.appendChild(textNode);
  bar.appendChild(label);
  page.document.body.appendChild(bar);

  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: false,
    shift: true,
    i18n: true,
    i18nDict: { Settings: '设置' },
    version: '0.1.0',
  });
  const res = page.evaluate(script);
  assert.equal(res.injected, true);
  assert.equal(textNode.nodeValue, 'Settings', '不应修改插件状态条内文案');
});

test('回归测试：uninstallPlugin 先停进程再删目录、过期状态修正、带引号参数往返、撤回失败保留状态与 panel 内边距隔离', async () => {
  // 1. mergeDebugArguments / stripDebugArguments 保持带引号空格参数完整
  const rawArgs = '--user-data-dir="C:\\My Data\\dir" -- --flag';
  const merged = mergeDebugArguments(rawArgs);
  assert.equal(merged.added.length, 2);
  assert.equal(stripDebugArguments(merged.args, merged.added), rawArgs);

  // 2. buildPluginPanelHtml 使用 .panel 承载 padding 而非 body，防止被 preload.js 覆盖
  const panelHtml = buildPluginPanelHtml();
  assert.ok(panelHtml.includes('.panel { padding: 14px; }'));
  assert.ok(panelHtml.includes('<main class="panel">'));
  assert.ok(/body\s*\{[^}]*padding:\s*0;/s.test(panelHtml));

  // 3. removeDesktopLaunchConfig 在 execPowerShell 失败时返回 0 并保留 state.windowsShortcuts
  const dir = mkdtempSync(join(tmpdir(), 'dxl-plugin-reg-'));
  const home = join(dir, 'home');
  let dummySidecar = null;
  try {
    mkdirSync(join(home, 'Desktop'), { recursive: true });
    const lnkPath = join(home, 'Desktop', 'Antigravity.lnk');
    writeFileSync(
      lnkPath,
      createSyntheticLnk({
        target: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        args: '--remote-debugging-port=0 --remote-debugging-address=127.0.0.1',
      }),
    );
    const stateFile = join(dir, 'launch-state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({ windowsShortcuts: { [lnkPath]: [DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG] } }),
      'utf8',
    );
    const failRev = await removeDesktopLaunchConfig({
      platform: 'win32',
      home,
      stateFile,
      execPowerShell: async () => {
        throw new Error('powershell failed');
      },
    });
    assert.equal(failRev.revertedCount, 0);
    const preservedState = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(preservedState.windowsShortcuts[lnkPath], '失败时应保留追踪记录以便后续重试撤回');

    // 4. getPluginStatus 修正残留 active 状态，uninstallPlugin 能停止存活中的 Sidecar 进程后再删目录
    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
    await installPlugin({
      rootDir: ROOT,
      home,
      platform: 'win32',
      env: { ...process.env, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
      logger: silentLogger,
    });
    const paths = getPluginPaths({ home });
    writeFileSync(paths.statusFile, JSON.stringify({ state: 'active', attachedCount: 2 }), 'utf8');
    writeFileSync(paths.pidFile, '99999999\n', 'utf8');
    const staleStatus = getPluginStatus({ home, platform: 'win32', env: { USERPROFILE: home } });
    assert.equal(staleStatus.running, false);
    assert.equal(staleStatus.integration.state, 'stopped');
    assert.equal(staleStatus.integration.attachedCount, 0);

    dummySidecar = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    const exitPromise = new Promise((resolveExit) => dummySidecar.once('exit', resolveExit));
    writeFileSync(paths.pidFile, `${dummySidecar.pid}\n`, 'utf8');
    writeFileSync(paths.statusFile, JSON.stringify({ state: 'active', attachedCount: 1 }), 'utf8');
    const liveStatus = getPluginStatus({ home, platform: 'win32', env: { USERPROFILE: home } });
    assert.equal(liveStatus.running, true);
    assert.equal(liveStatus.integration.state, 'active');

    const unRes = await uninstallPlugin({
      home,
      platform: 'win32',
      env: { ...process.env, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
      portFile: join(dir, 'missing-port'),
      logger: silentLogger,
    });
    await exitPromise;
    assert.equal(unRes.removedPluginDir, true);
    assert.equal(existsSync(paths.pluginDir), false);
    assert.equal(existsSync(paths.pidFile), false);
  } finally {
    if (dummySidecar && dummySidecar.exitCode === null) {
      try {
        dummySidecar.kill();
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
