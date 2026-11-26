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
import { createServer as createNetServer } from 'node:net';
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
  serializeAsciiJson,
  stripDebugArguments,
} from '../src/launch.js';
import {
  PLUGIN_ID,
  buildPluginPanelHtml,
  buildSidecarManifest,
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
  const isolatedEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  let sidecarChild = null;

  try {
    const installRes = await installPlugin({
      rootDir: ROOT,
      home,
      platform: 'win32',
      env: isolatedEnv,
      logger: silentLogger,
    });
    assert.equal(installRes.installed, true);

    const paths = getPluginPaths({ home, env: isolatedEnv });
    assert.equal(existsSync(paths.manifestFile), true);
    assert.equal(existsSync(paths.sidecarManifestFile), true);
    assert.equal(existsSync(paths.sidecarEntryFile), true);
    assert.equal(existsSync(paths.panelHtmlFile), true);
    assert.equal(existsSync(paths.payloadCacheFile), true, '安装应预热生成 payload-cache.json');
    assert.ok(buildSidecarManifest().args.includes('--max-semi-space-size=8'), 'Sidecar 新生代堆应放宽至 8MB');

    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(cfg.plugins[PLUGIN_ID].enabled, true);
    assert.equal(cfg.plugins['antigravity-pulse'].enabled, true, '安装不应破坏其他已有插件开关');
    assert.equal(cfg.userSettings.themeMode, 'THEME_MODE_INHERIT');

    const status = getPluginStatus({ home, platform: 'win32', env: isolatedEnv });
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);
    assert.equal(status.launch.configured, true);

    // 验证 sidecars/theme/main.mjs 在真实 Node 子进程与回退 HTTP UI 服务模式下正常启动（port=0 动态分配）和响应
    let sidecarStderr = '';
    sidecarChild = spawn(process.execPath, [paths.sidecarEntryFile], {
      cwd: paths.sidecarDir,
      env: {
        ...isolatedEnv,
        ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: 'test-token-123',
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.dataDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    sidecarChild.stderr.on('data', (chunk) => {
      sidecarStderr += chunk.toString('utf8');
    });

    const deadline = Date.now() + 4000;
    let webPort = null;
    let stateJson = null;
    while (Date.now() < deadline) {
      if (sidecarChild.exitCode !== null) {
        assert.fail(`Sidecar 子进程提前退出（exitCode=${sidecarChild.exitCode}）：${sidecarStderr}`);
      }
      if (!webPort && existsSync(paths.statusFile)) {
        try {
          const st = JSON.parse(readFileSync(paths.statusFile, 'utf8'));
          if (Number.isInteger(st.webPort) && st.webPort > 0) {
            webPort = st.webPort;
          }
        } catch {}
      }
      if (webPort) {
        try {
          const res = await fetch(`http://127.0.0.1:${webPort}/api/state`);
          if (res.ok) {
            stateJson = await res.json();
            break;
          }
        } catch {
          // 继续轮询
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(webPort, 'Sidecar 应在 integration-state.json 中写入动态分配的 webPort');
    assert.ok(stateJson, 'Sidecar 回退控制面板服务应成功响应 /api/state');
    assert.equal(stateJson.settings.avatar, true);
    assert.equal(existsSync(paths.sidecarPidFile), true, 'Sidecar 应写入独立的 .sidecar.pid');

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

    // 验证畸形 JSON 返回 400、超限 body 返回 413
    const badJsonPost = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test-token-123' },
      body: '{invalid-json',
    });
    assert.equal(badJsonPost.status, 400);

    const bigPost = await fetch(`http://127.0.0.1:${webPort}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sidecar-token': 'test-token-123' },
      body: JSON.stringify({ pad: 'a'.repeat(17000) }),
    });
    assert.equal(bigPost.status, 413);

    sidecarChild.kill('SIGTERM');
    await new Promise((resolveExit) => sidecarChild.once('exit', resolveExit));
    sidecarChild = null;

    const uninstallRes = await uninstallPlugin({
      home,
      platform: 'win32',
      env: isolatedEnv,
      portFile: join(dir, 'missing-port'),
      logger: silentLogger,
    });
    assert.equal(uninstallRes.uninstalled, true);
    assert.equal(uninstallRes.removedPluginDir, true);
    assert.equal(existsSync(paths.pluginDir), false);
    assert.equal(existsSync(paths.sidecarPidFile), false);
    assert.equal(existsSync(paths.payloadCacheFile), false);
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

test('回归测试：launch 解析边界、Sidecar 空 token 保护/端口冲突容错、getPluginStatus 与 uninstallPlugin 竞态清理', async () => {
  // 1. serializeAsciiJson 将非 ASCII 路径转为纯 ASCII \uXXXX
  const asciiJson = serializeAsciiJson([{ path: 'C:\\Users\\冬雪莲\\Antigravity.lnk', args: '--lang=中文' }]);
  assert.equal(/^[\x20-\x7e]+$/.test(asciiJson), true);
  assert.deepEqual(JSON.parse(asciiJson), [{ path: 'C:\\Users\\冬雪莲\\Antigravity.lnk', args: '--lang=中文' }]);

  // 2. tokenizeArgs / hasDebugFlags / mergeDebugArguments 支持转义引号与单引号带空格参数
  const quotedArgs = `--label="a \\"b\\" c" --dir='C:\\My Data\\dir' --remote-debugging-port=0`;
  assert.deepEqual(hasDebugFlags(quotedArgs), { hasPort: true, hasAddress: false });
  const completedArgs = mergeDebugArguments(quotedArgs);
  assert.deepEqual(completedArgs.added, [DEBUG_ADDRESS_FLAG]);
  assert.equal(
    stripDebugArguments(completedArgs.args, [DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG]),
    `--label="a \\"b\\" c" --dir='C:\\My Data\\dir'`,
  );

  // 3. Linux .desktop：引号感知 % 占位符、--remote-debugging-address 检查与无尾部空行累积
  const quotedFieldDesktop = [
    '[Desktop Entry]',
    'Name=Antigravity',
    'Exec="/opt/My %f/antigravity" %U',
    '',
  ].join('\n');
  const mergedDesktop = mergeDesktopEntry(quotedFieldDesktop);
  assert.ok(
    mergedDesktop.includes('Exec="/opt/My %f/antigravity" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 %U'),
  );
  assert.equal(mergeDesktopEntry(mergedDesktop), mergedDesktop, '重复调用 mergeDesktopEntry 不应累积尾部空行');

  const partialDesktop = '[Desktop Entry]\nExec=/opt/antigravity --remote-debugging-port=0\n';
  const completedDesktop = mergeDesktopEntry(partialDesktop);
  assert.ok(completedDesktop.includes('--remote-debugging-port=0 --remote-debugging-address=127.0.0.1'));
  assert.equal((completedDesktop.match(/--remote-debugging-port/g) || []).length, 1);

  const dir = mkdtempSync(join(tmpdir(), 'dxl-plugin-hardening-'));
  const home = join(dir, 'home');
  const isolatedEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  let occupant = null;
  let sidecarEmptyToken = null;
  let sidecarPortBusy = null;
  let sidecarReal = null;

  try {
    // 验证 inspectDesktopLaunch 在 Linux 缺少 --remote-debugging-address 时判定未就绪
    const linuxDesktopDir = join(home, '.local', 'share', 'applications');
    mkdirSync(linuxDesktopDir, { recursive: true });
    writeFileSync(join(linuxDesktopDir, 'antigravity.desktop'), partialDesktop, 'utf8');
    assert.equal(inspectDesktopLaunch({ platform: 'linux', home, env: isolatedEnv }).configured, false);

    // 4. parseLnkBuffer 拼接非空 CommonPathSuffixUnicode
    const header = Buffer.alloc(76);
    header.writeUInt32LE(0x4c, 0);
    header.writeUInt32LE(0x02 | 0x80, 0x14);
    const baseUni = Buffer.from('C:\\Program Files\\Antigravity\0', 'utf16le');
    const suffixUni = Buffer.from('Antigravity.exe\0', 'utf16le');
    const infoHdrLen = 0x24;
    const infoBuf = Buffer.alloc(infoHdrLen + baseUni.length + suffixUni.length);
    infoBuf.writeUInt32LE(infoBuf.length, 0);
    infoBuf.writeUInt32LE(infoHdrLen, 4);
    infoBuf.writeUInt32LE(0x01, 8);
    infoBuf.writeUInt32LE(infoHdrLen, 28);
    infoBuf.writeUInt32LE(infoHdrLen + baseUni.length, 32);
    baseUni.copy(infoBuf, infoHdrLen);
    suffixUni.copy(infoBuf, infoHdrLen + baseUni.length);
    const lnkWithSuffix = parseLnkBuffer(Buffer.concat([header, infoBuf]));
    assert.equal(lnkWithSuffix?.target, 'C:\\Program Files\\Antigravity\\Antigravity.exe');

    // 5. getPluginStatus enabled 与 readPluginEnabled 对缺省本插件但有其他插件的一致性
    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
    await installPlugin({ rootDir: ROOT, home, platform: 'win32', env: isolatedEnv, logger: silentLogger });
    const paths = getPluginPaths({ home, env: isolatedEnv });
    writeFileSync(
      paths.configFile,
      JSON.stringify({ plugins: { 'antigravity-pulse': { enabled: true } } }),
      'utf8',
    );
    const missingSelfStatus = getPluginStatus({ home, platform: 'win32', env: isolatedEnv });
    assert.equal(missingSelfStatus.installed, true);
    assert.equal(missingSelfStatus.enabled, false, 'config.plugins 含其他插件但缺省本插件时应为 false');

    // 6. Sidecar 未设置 UI_TOKEN 时生成随机临时 token 保护写接口，且监听端口占用时不静默崩溃
    writeFileSync(
      paths.configFile,
      JSON.stringify({ plugins: { [PLUGIN_ID]: { enabled: true } } }),
      'utf8',
    );
    sidecarEmptyToken = spawn(process.execPath, [paths.sidecarEntryFile], {
      cwd: paths.sidecarDir,
      env: {
        ...isolatedEnv,
        ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
        ANTIGRAVITY_SIDECAR_UI_TOKEN: '',
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.dataDir,
      },
      stdio: 'ignore',
    });
    const waitPortDeadline = Date.now() + 4000;
    let dynPort = null;
    while (Date.now() < waitPortDeadline) {
      if (existsSync(paths.statusFile)) {
        try {
          const st = JSON.parse(readFileSync(paths.statusFile, 'utf8'));
          if (Number.isInteger(st.webPort) && st.webPort > 0) {
            dynPort = st.webPort;
            break;
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(dynPort);
    const getStateRes = await fetch(`http://127.0.0.1:${dynPort}/api/state`);
    assert.equal(getStateRes.status, 200);
    const noTokenPost = await fetch(`http://127.0.0.1:${dynPort}/api/reinject`, { method: 'POST', body: '{}' });
    assert.equal(noTokenPost.status, 401, '空 UI_TOKEN 时也应生成临时 token 保护写接口');
    sidecarEmptyToken.kill('SIGTERM');
    await new Promise((r) => sidecarEmptyToken.once('exit', r));
    sidecarEmptyToken = null;

    // 端口占用时 Sidecar 不崩溃并记录错误日志
    occupant = createNetServer();
    await new Promise((r) => occupant.listen(0, '127.0.0.1', r));
    const busyPort = occupant.address().port;
    sidecarPortBusy = spawn(process.execPath, [paths.sidecarEntryFile], {
      cwd: paths.sidecarDir,
      env: {
        ...isolatedEnv,
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(busyPort),
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.dataDir,
      },
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sidecarPortBusy.exitCode, null, 'Web UI 端口占用时 Sidecar 主守护不应崩溃退出');
    sidecarPortBusy.kill('SIGTERM');
    await new Promise((r) => sidecarPortBusy.once('exit', r));
    sidecarPortBusy = null;
    await new Promise((r) => occupant.close(r));
    occupant = null;

    // 7. 真实 Sidecar 运行时执行 uninstallPlugin()：能通过 .sidecar.pid 彻底停机，并清理空 launch-state.json
    writeFileSync(paths.launchStateFile, '{}\n', 'utf8');
    sidecarReal = spawn(process.execPath, [paths.sidecarEntryFile], {
      cwd: paths.sidecarDir,
      env: {
        ...isolatedEnv,
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: paths.dataDir,
      },
      stdio: 'ignore',
    });
    const pidWait = Date.now() + 3000;
    while (Date.now() < pidWait) {
      if (existsSync(paths.sidecarPidFile) && readFileSync(paths.sidecarPidFile, 'utf8').trim() === String(sidecarReal.pid)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const realExitP = new Promise((r) => sidecarReal.once('exit', r));
    const unRes = await uninstallPlugin({
      home,
      platform: 'win32',
      env: isolatedEnv,
      portFile: join(dir, 'missing-port'),
      logger: silentLogger,
    });
    await realExitP;
    sidecarReal = null;
    assert.equal(unRes.removedPluginDir, true);
    assert.equal(existsSync(paths.sidecarPidFile), false);
    assert.equal(existsSync(paths.launchStateFile), false, '空的 launch-state.json 应在卸载后一并清理');
  } finally {
    for (const proc of [sidecarEmptyToken, sidecarPortBusy, sidecarReal]) {
      if (proc && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }
    if (occupant) {
      try {
        await new Promise((r) => occupant.close(r));
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
