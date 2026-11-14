import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cleanupExitedPidFile,
  isNodeProcessPid,
  parseCliArgs,
  readLiveWatcherPid,
  rotateLogIfNeeded,
  watchLoop,
} from '../src/runner.js';
import {
  LINUX_DESKTOP_FILENAME,
  MACOS_LAUNCHD_LABEL,
  WINDOWS_REG_VALUE,
  WINDOWS_TASK_NAME,
  buildLinuxDesktopEntry,
  buildMacLaunchAgentPlist,
  buildPowerShellEncodedCommand,
  buildWatchDaemonArgs,
  buildWindowsVbsScript,
  getInstallStatus,
  installTheme,
  normalizeInstallOptions,
  uninstallTheme,
} from '../src/service.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

function tryDecodeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const data = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < data.length; i++) {
      data[i] ^= maskKey[i % 4];
    }
  }
  return {
    opcode,
    payload: data.toString('utf8'),
    bytesConsumed: offset + length,
  };
}

/** 启动轻量本地 Mock CDP 服务端，用于隔离验证真实 daemon 注入与卸载流程 */
async function startMockCdpServer() {
  const calls = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'page-service-test',
            type: 'page',
            title: 'Antigravity',
            url: 'vscode-file://vscode-app/workbench/workbench.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/service`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );

    sockets.add(socket);
    socket.on('error', () => {});
    let recvBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);
      while (true) {
        const frame = tryDecodeWsFrame(recvBuffer);
        if (!frame) break;
        recvBuffer = recvBuffer.subarray(frame.bytesConsumed);
        if (frame.opcode === 0x8) {
          socket.end();
          break;
        }
        if (frame.opcode === 0x1) {
          const msg = JSON.parse(frame.payload);
          calls.push(msg);
          socket.write(
            encodeWsTextFrame(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    type: 'object',
                    value: {
                      applied: true,
                      removed: true,
                      styleRemoved: true,
                      attrCount: 2,
                      i18nRestored: 1,
                    },
                  },
                },
              })
            )
          );
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    calls,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitForCondition(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return predicate();
}

/** 创建隔离临时工作区，避免测试污染仓库目录与宿主机配置 */
function createIsolatedRepoCopy(prefix = 'dxl-service-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(REPO_ROOT, 'package.json'), join(tempRoot, 'package.json'));
  cpSync(join(REPO_ROOT, 'bin'), join(tempRoot, 'bin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'src'), join(tempRoot, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'assets'), join(tempRoot, 'assets'), { recursive: true });
  return tempRoot;
}

/** 构造隔离 Windows execFileImpl 模拟器，精准解析 PowerShell EncodedCommand */
function createWindowsExecMock({ failTaskRegister = false, onStartTask = null } = {}) {
  const invocations = [];
  const state = {
    taskRegistered: false,
    taskStarted: false,
    regValue: null,
  };

  async function execFileImpl(file, args = []) {
    invocations.push({ file, args: [...args] });
    const lower = String(file).toLowerCase();

    if (lower.includes('powershell')) {
      const encodedIdx = args.indexOf('-EncodedCommand');
      const script =
        encodedIdx >= 0
          ? Buffer.from(args[encodedIdx + 1], 'base64').toString('utf16le')
          : '';

      if (script.includes('Register-ScheduledTask')) {
        if (failTaskRegister) {
          throw new Error('Access is denied (simulated)');
        }
        state.taskRegistered = true;
        return { stdout: '', stderr: '' };
      }
      if (script.includes('Start-ScheduledTask')) {
        if (typeof onStartTask === 'function' && state.taskRegistered) {
          state.taskStarted = true;
          onStartTask();
          return { stdout: '', stderr: '' };
        }
        throw new Error('Task start skipped (mock)');
      }
      if (script.includes('Unregister-ScheduledTask')) {
        if (!state.taskRegistered) {
          return { stdout: '', stderr: '' };
        }
        state.taskRegistered = false;
        return { stdout: 'TASK_REMOVED\r\n', stderr: '' };
      }
      if (script.includes('Get-ScheduledTask')) {
        return { stdout: state.taskRegistered ? 'Ready\r\n' : '', stderr: '' };
      }
      if (script.includes('Set-ItemProperty')) {
        const match = script.match(/-Value '((?:[^']|'')*)'/);
        state.regValue = match ? match[1].replaceAll("''", "'") : 'registered';
        return { stdout: '', stderr: '' };
      }
      if (script.includes('REG_REMOVED')) {
        const existed = Boolean(state.regValue);
        state.regValue = null;
        return { stdout: existed ? 'REG_REMOVED\r\n' : '', stderr: '' };
      }
      if (script.includes('Remove-ItemProperty')) {
        state.regValue = null;
        return { stdout: '', stderr: '' };
      }
      if (script.includes('Get-ItemProperty') && script.includes('PRESENT')) {
        return { stdout: state.regValue ? 'PRESENT\r\n' : '', stderr: '' };
      }
    }

    throw new Error(`未预期的外部命令模拟调用: ${file} ${args.join(' ')}`);
  }

  return { execFileImpl, invocations, state };
}

test('normalizeInstallOptions 与 buildWatchDaemonArgs 正确标准化选项并生成参数', () => {
  const normalized = normalizeInstallOptions(
    {
      port: 9333,
      avatar: false,
      shift: false,
      i18n: false,
      pulse: false,
      i18nOverride: './custom/i18n.json',
    },
    'E:\\示例\\主题目录'
  );

  assert.equal(normalized.port, 9333);
  assert.equal(normalized.avatar, false);
  assert.equal(normalized.shift, false);
  assert.equal(normalized.i18n, false);
  assert.equal(normalized.pulse, false);
  assert.equal(normalized.i18nOverride, join('E:\\示例\\主题目录', './custom/i18n.json'));

  const args = buildWatchDaemonArgs(normalized);
  assert.deepEqual(args, [
    '--daemon',
    '--if-not-running',
    '--port',
    '9333',
    '--no-avatar',
    '--no-shift',
    '--no-i18n',
    '--no-pulse',
    '--i18n-override',
    join('E:\\示例\\主题目录', './custom/i18n.json'),
  ]);

  const noGuardArgs = buildWatchDaemonArgs(
    { avatar: true, shift: true, i18n: true, pulse: true },
    { includeIfNotRunning: false }
  );
  assert.deepEqual(noGuardArgs, ['--daemon']);
});

test('脚本模板生成函数正确处理中文路径与特殊字符转义', () => {
  const script = `$target = 'E:\\AGY_workspace\\主题开发\\run.vbs'`;
  const encoded = buildPowerShellEncodedCommand(script);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);

  const vbs = buildWindowsVbsScript({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    watchScriptPath: 'E:\\AGY_workspace\\主题开发\\bin\\watch.js',
    rootDir: 'E:\\AGY_workspace\\主题开发',
    daemonArgs: ['--daemon', '--if-not-running', '--i18n-override', 'E:\\A "B"\\override.json'],
  });
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
  assert.ok(vbs.includes('shell.CurrentDirectory = "E:\\AGY_workspace\\主题开发"'));
  assert.ok(vbs.includes('""C:\\Program Files\\nodejs\\node.exe""'));
  assert.ok(vbs.includes('""E:\\AGY_workspace\\主题开发\\bin\\watch.js""'));
  assert.ok(vbs.includes('""--daemon""'));
  assert.ok(vbs.includes('shell.Run "'));
  assert.ok(vbs.includes(', 0, False'));

  const plist = buildMacLaunchAgentPlist({
    label: MACOS_LAUNCHD_LABEL,
    nodePath: '/usr/local/bin/node',
    watchScriptPath: '/Users/test/theme & co/bin/watch.js',
    rootDir: '/Users/test/theme & co',
    daemonArgs: ['--daemon'],
    logFile: '/Users/test/theme & co/watch.log',
  });
  assert.ok(plist.includes('<key>RunAtLoad</key>\n  <true/>'));
  assert.ok(plist.includes('/Users/test/theme &amp; co/bin/watch.js'));
  assert.ok(plist.includes(`<string>${MACOS_LAUNCHD_LABEL}</string>`));

  const desktop = buildLinuxDesktopEntry({
    nodePath: '/usr/bin/node',
    watchScriptPath: '/home/u/antigravity theme/bin/watch.js',
    rootDir: '/home/u/antigravity theme',
    daemonArgs: ['--daemon', '--port', '9222'],
  });
  assert.ok(desktop.includes('[Desktop Entry]'));
  assert.ok(desktop.includes('X-GNOME-Autostart-enabled=true'));
  assert.ok(desktop.includes('Path=/home/u/antigravity theme'));
  assert.ok(
    desktop.includes(
      '/usr/bin/node "/home/u/antigravity theme/bin/watch.js" --daemon --port 9222'
    )
  );
});

test('rotateLogIfNeeded 正确轮转超限日志，--if-not-running 不重复启动已有守护进程', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'dxl-log-rotate-'));
  let dummyChild = null;
  try {
    const logFile = join(tempDir, 'watch.log');
    const rotatedFile = `${logFile}.1`;

    writeFileSync(logFile, 'A'.repeat(200), 'utf8');
    rotateLogIfNeeded(logFile, 100);
    assert.equal(existsSync(logFile), false);
    assert.equal(readFileSync(rotatedFile, 'utf8'), 'A'.repeat(200));

    writeFileSync(logFile, 'B'.repeat(150), 'utf8');
    rotateLogIfNeeded(logFile, 100);
    assert.equal(existsSync(logFile), false);
    assert.equal(readFileSync(rotatedFile, 'utf8'), 'B'.repeat(150));

    // --if-not-running 验证：当 pidFile 指向另一个存活 Node 进程时，watchLoop 立即跳过并安全返回
    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const pidFile = join(tempDir, '.watch.pid');
    writeFileSync(pidFile, `${dummyChild.pid}\n`, 'utf8');
    const logs = [];
    await watchLoop({
      rootDir: tempDir,
      pidFile,
      logFile,
      daemon: true,
      ifNotRunning: true,
      logger: {
        log: (msg) => logs.push(msg),
        warn: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
      },
    });
    assert.ok(
      logs.some((line) => line.includes(`PID ${dummyChild.pid}`) && line.includes('跳过重复启动'))
    );
    assert.equal(readLiveWatcherPid(pidFile), dummyChild.pid);

    // 验证不存在的 PID 不会被误判存活且能清理过期 PID 文件
    const fakePid = 99999999;
    writeFileSync(pidFile, `${fakePid}\n`, 'utf8');
    assert.equal(isNodeProcessPid(fakePid), false);
    cleanupExitedPidFile(pidFile, fakePid);
    assert.equal(existsSync(pidFile), false);

    assert.deepEqual(parseCliArgs(['--daemon', '--if-not-running', '--port=9229']), {
      port: 9229,
      avatar: true,
      shift: true,
      i18n: true,
      pulse: true,
      i18nOverride: undefined,
      daemon: true,
      ifNotRunning: true,
      help: false,
    });
  } finally {
    if (dummyChild?.pid) {
      try {
        process.kill(dummyChild.pid, 'SIGKILL');
      } catch {}
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Windows 主路径（任务计划程序）：installTheme -> getInstallStatus -> uninstallTheme 完整闭环（含中文路径与真实后台进程）', async () => {
  const tempBase = mkdtempSync(join(tmpdir(), 'dxl-win-中文路径-'));
  const tempRoot = join(tempBase, '主题工作区');
  cpSync(join(REPO_ROOT, 'package.json'), join(tempRoot, 'package.json'));
  cpSync(join(REPO_ROOT, 'bin'), join(tempRoot, 'bin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'src'), join(tempRoot, 'src'), { recursive: true });
  cpSync(join(REPO_ROOT, 'assets'), join(tempRoot, 'assets'), { recursive: true });

  const cdp = await startMockCdpServer();
  const portFile = join(tempBase, 'cdp.port');
  writeFileSync(portFile, String(cdp.port), 'utf8');
  const testEnv = {
    ...process.env,
    USERDOMAIN: 'TESTPC',
    USERNAME: 'Tester',
    APPDATA: tempBase,
    LOCALAPPDATA: tempBase,
  };
  const mockExec = createWindowsExecMock({ failTaskRegister: false });
  const logs = [];
  const logger = {
    log: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
  };

  let installedPid = null;
  try {
    const installRes = await installTheme({
      rootDir: tempRoot,
      port: cdp.port,
      portFile,
      platform: 'win32',
      env: testEnv,
      home: tempBase,
      execFileImpl: mockExec.execFileImpl,
      logger,
      startupTimeoutMs: 6000,
    });

    installedPid = installRes.pid;
    assert.equal(installRes.installed, true);
    assert.ok(Number.isInteger(installedPid) && installedPid > 0);
    assert.equal(mockExec.state.taskRegistered, true);
    assert.equal(installRes.autostart.method, 'windows-task-scheduler');
    assert.equal(existsSync(join(tempRoot, '.runtime', 'install-state.json')), true);

    // 验证 UTF-16LE BOM 编码的 launch-watch.vbs 能正确保留中文路径、--if-not-running 与端口参数
    const vbsPath = join(tempRoot, '.runtime', 'launch-watch.vbs');
    assert.equal(existsSync(vbsPath), true);
    const vbsBytes = readFileSync(vbsPath);
    assert.equal(vbsBytes[0], 0xff);
    assert.equal(vbsBytes[1], 0xfe);
    const vbsText = vbsBytes.subarray(2).toString('utf16le');
    assert.ok(vbsText.includes('主题工作区'));
    assert.ok(vbsText.includes('--daemon'));
    assert.ok(vbsText.includes('--if-not-running'));
    assert.ok(vbsText.includes(`""${cdp.port}""`) || vbsText.includes(String(cdp.port)));

    // 等待真实 daemon 进程对 Mock CDP 完成注册与首轮注入
    await waitForCondition(
      () =>
        cdp.calls.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument') &&
        cdp.calls.some((c) => c.method === 'Runtime.evaluate'),
      3000
    );
    assert.ok(
      cdp.calls.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'),
      'daemon 应通过 Mock CDP 注册新文档注入脚本'
    );
    assert.ok(
      cdp.calls.some((c) => c.method === 'Runtime.evaluate'),
      'daemon 应通过 Mock CDP 执行页面注入脚本'
    );

    const status = await getInstallStatus({
      rootDir: tempRoot,
      port: cdp.port,
      portFile,
      platform: 'win32',
      env: testEnv,
      home: tempBase,
      execFileImpl: mockExec.execFileImpl,
      logger,
      silent: true,
    });
    assert.equal(status.autostartInstalled, true);
    assert.equal(status.autostartMethod, 'windows-task-scheduler');
    assert.equal(status.autostartDetail, `${WINDOWS_TASK_NAME} (Ready)`);
    assert.equal(status.watcherRunning, true);
    assert.equal(status.watcherPid, installedPid);
    assert.equal(status.cdp.cdpReachable, true);
    assert.equal(status.cdp.port, cdp.port);
    assert.equal(status.cdp.pageCount, 1);

    const callsBeforeUninstall = cdp.calls.length;
    const uninstallRes = await uninstallTheme({
      rootDir: tempRoot,
      port: cdp.port,
      portFile,
      platform: 'win32',
      env: testEnv,
      home: tempBase,
      execFileImpl: mockExec.execFileImpl,
      logger,
    });
    assert.equal(uninstallRes.uninstalled, true);
    assert.equal(uninstallRes.removedAutostart, true);
    assert.equal(mockExec.state.taskRegistered, false);
    assert.equal(existsSync(vbsPath), false);
    assert.equal(existsSync(join(tempRoot, '.runtime', 'install-state.json')), false);
    assert.ok(
      cdp.calls.slice(callsBeforeUninstall).some((c) => c.method === 'Runtime.evaluate'),
      'uninstallTheme 应通过 Mock CDP 触发页面样式清理'
    );

    // 等待子进程退出并释放文件锁
    await waitForCondition(() => readLiveWatcherPid(join(tempRoot, '.watch.pid')) === null, 2000);
    assert.equal(readLiveWatcherPid(join(tempRoot, '.watch.pid')), null);

    const statusAfter = await getInstallStatus({
      rootDir: tempRoot,
      port: cdp.port,
      portFile,
      platform: 'win32',
      env: testEnv,
      home: tempBase,
      execFileImpl: mockExec.execFileImpl,
      logger,
      silent: true,
    });
    assert.equal(statusAfter.autostartInstalled, false);
    assert.equal(statusAfter.watcherRunning, false);
  } finally {
    if (installedPid) {
      try {
        process.kill(installedPid, 'SIGKILL');
      } catch {}
    }
    await cdp.close();
    rmSync(tempBase, { recursive: true, force: true });
  }
});

test('Windows 回退路径（注册表 HKCU Run）：任务计划失败时自动回退并可完整卸载', async () => {
  const tempRoot = createIsolatedRepoCopy('dxl-win-fallback-');
  const mockExec = createWindowsExecMock({ failTaskRegister: true });
  const logs = [];
  const logger = {
    log: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
  };

  let spawnedArgs = null;
  let alive = true;
  const fakePid = 424242;

  try {
    const installRes = await installTheme({
      rootDir: tempRoot,
      platform: 'win32',
      env: { ...process.env, USERDOMAIN: 'TESTPC', USERNAME: 'Tester' },
      home: tempRoot,
      execFileImpl: mockExec.execFileImpl,
      spawnImpl: (_cmd, args) => {
        spawnedArgs = args;
        return { pid: fakePid, unref() {} };
      },
      isAliveImpl: (pid) => pid === fakePid && alive,
      fetchImpl: async () => {
        throw new Error('no cdp in fallback test');
      },
      logger,
      settleDelayMs: 10,
      startupTimeoutMs: 500,
    });

    assert.equal(installRes.installed, true);
    assert.equal(installRes.autostart.method, 'windows-registry-run');
    assert.ok(mockExec.state.regValue?.includes('launch-watch.vbs'));
    assert.ok(Array.isArray(spawnedArgs) && spawnedArgs.includes('--daemon'));

    const status = await getInstallStatus({
      rootDir: tempRoot,
      platform: 'win32',
      execFileImpl: mockExec.execFileImpl,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      silent: true,
      logger,
    });
    assert.equal(status.autostartInstalled, true);
    assert.equal(status.autostartMethod, 'windows-registry-run');
    assert.equal(status.autostartDetail, WINDOWS_REG_VALUE);

    alive = false;
    const uninstallRes = await uninstallTheme({
      rootDir: tempRoot,
      platform: 'win32',
      execFileImpl: mockExec.execFileImpl,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger,
    });

    assert.equal(uninstallRes.uninstalled, true);
    assert.equal(uninstallRes.removedAutostart, true);
    assert.equal(mockExec.state.regValue, null);
    assert.equal(existsSync(join(tempRoot, '.runtime', 'launch-watch.vbs')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('macOS (LaunchAgent plist) 与 Linux (XDG .desktop) 开机自启安装、状态检查与卸载', async () => {
  const macHome = mkdtempSync(join(tmpdir(), 'dxl-mac-home-'));
  const macRoot = createIsolatedRepoCopy('dxl-mac-root-');
  const linuxHome = mkdtempSync(join(tmpdir(), 'dxl-linux-home-'));
  const linuxRoot = createIsolatedRepoCopy('dxl-linux-root-');
  const quietLogger = { log() {}, warn() {}, error() {} };
  const launchdCalls = [];

  try {
    // 1. macOS
    const macExec = async (file, args = []) => {
      launchdCalls.push({ file, args: [...args] });
      if (file === 'launchctl' && (args[0] === 'unload' || args[0] === 'load')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    };

    const macInstall = await installTheme({
      rootDir: macRoot,
      platform: 'darwin',
      home: macHome,
      execFileImpl: macExec,
      spawnImpl: () => ({ pid: 10001, unref() {} }),
      isAliveImpl: (p) => p === 10001,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
      settleDelayMs: 10,
      startupTimeoutMs: 200,
    });
    const plistPath = join(macHome, 'Library', 'LaunchAgents', `${MACOS_LAUNCHD_LABEL}.plist`);
    assert.equal(macInstall.autostart.method, 'macos-launchagent');
    assert.equal(existsSync(plistPath), true);
    assert.ok(launchdCalls.some((c) => c.file === 'launchctl' && c.args[0] === 'load'));

    const macStatus = await getInstallStatus({
      rootDir: macRoot,
      platform: 'darwin',
      home: macHome,
      execFileImpl: macExec,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
      silent: true,
    });
    assert.equal(macStatus.autostartInstalled, true);
    assert.equal(macStatus.autostartMethod, 'macos-launchagent');
    assert.equal(macStatus.autostartDetail, plistPath);

    await uninstallTheme({
      rootDir: macRoot,
      platform: 'darwin',
      home: macHome,
      execFileImpl: macExec,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
    });
    assert.equal(existsSync(plistPath), false);
    assert.ok(launchdCalls.some((c) => c.file === 'launchctl' && c.args[0] === 'unload'));

    // 2. Linux
    const xdgConfig = join(linuxHome, 'xdg-config');
    const linuxInstall = await installTheme({
      rootDir: linuxRoot,
      platform: 'linux',
      home: linuxHome,
      env: { XDG_CONFIG_HOME: xdgConfig },
      spawnImpl: () => ({ pid: 10002, unref() {} }),
      isAliveImpl: (p) => p === 10002,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
      settleDelayMs: 10,
      startupTimeoutMs: 200,
    });
    const desktopPath = join(xdgConfig, 'autostart', LINUX_DESKTOP_FILENAME);
    assert.equal(linuxInstall.autostart.method, 'linux-xdg-autostart');
    assert.equal(existsSync(desktopPath), true);

    const linuxStatus = await getInstallStatus({
      rootDir: linuxRoot,
      platform: 'linux',
      home: linuxHome,
      env: { XDG_CONFIG_HOME: xdgConfig },
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
      silent: true,
    });
    assert.equal(linuxStatus.autostartInstalled, true);
    assert.equal(linuxStatus.autostartMethod, 'linux-xdg-autostart');
    assert.equal(linuxStatus.autostartDetail, desktopPath);

    await uninstallTheme({
      rootDir: linuxRoot,
      platform: 'linux',
      home: linuxHome,
      env: { XDG_CONFIG_HOME: xdgConfig },
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
    });
    assert.equal(existsSync(desktopPath), false);
  } finally {
    rmSync(macHome, { recursive: true, force: true });
    rmSync(macRoot, { recursive: true, force: true });
    rmSync(linuxHome, { recursive: true, force: true });
    rmSync(linuxRoot, { recursive: true, force: true });
  }
});

test('Windows 任务计划程序可用时优先通过 Start-ScheduledTask 独立拉起守护进程脱离终端进程树', async () => {
  const tempRoot = createIsolatedRepoCopy('dxl-win-taskrun-');
  const expectedPid = 787878;
  const mockExec = createWindowsExecMock({
    onStartTask: () => {
      writeFileSync(join(tempRoot, '.watch.pid'), `${expectedPid}\n`, 'utf8');
    },
  });
  const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

  try {
    const installRes = await installTheme({
      rootDir: tempRoot,
      platform: 'win32',
      env: { ...process.env, USERDOMAIN: 'TESTPC', USERNAME: 'Tester' },
      home: tempRoot,
      execFileImpl: mockExec.execFileImpl,
      isAliveImpl: (pid) => pid === expectedPid,
      fetchImpl: async () => {
        throw new Error('no cdp');
      },
      logger: quietLogger,
      settleDelayMs: 10,
      startupTimeoutMs: 500,
    });

    assert.equal(installRes.installed, true);
    assert.equal(mockExec.state.taskStarted, true);
    assert.equal(installRes.pid, expectedPid);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
