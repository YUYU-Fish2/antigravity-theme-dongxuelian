import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getPortFilePath, listPages, readPort } from './cdp.js';
import {
  cleanupExitedPidFile,
  isProcessAlive,
  prepareRuntimePayload,
  readLiveWatcherPid,
  readPackageVersion,
  removeOnce,
  resolveRootPath,
  rotateLogIfNeeded,
  tryStopWatcherByPidFile,
  unlinkQuietly,
} from './runner.js';

const execFileAsync = promisify(execFile);

export const WINDOWS_TASK_NAME = 'DongxuelianAntigravityTheme';
export const WINDOWS_REG_KEY_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_REG_VALUE = 'DongxuelianAntigravityTheme';
export const MACOS_LAUNCHD_LABEL = 'io.dongxuelian.antigravity-theme';
export const LINUX_DESKTOP_FILENAME = 'antigravity-theme-dongxuelian.desktop';
export const RUNTIME_DIR_NAME = '.runtime';
export const INSTALL_STATE_FILENAME = 'install-state.json';
export const VBS_LAUNCHER_FILENAME = 'launch-watch.vbs';

function escapePsSingleQuote(value) {
  return String(value).replaceAll("'", "''");
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function quoteShellArg(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(s)) {
    return s;
  }
  return `"${s.replaceAll('"', '\\"')}"`;
}

/**
 * 将 PowerShell 脚本文本编码为 UTF-16LE Base64，避免命令行与非 ASCII 路径转义问题。
 * @param {string} script
 * @returns {string}
 */
export function buildPowerShellEncodedCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * 规范化安装配置，并将相对路径形式的 `--i18n-override` 解析为绝对路径以便跨重启复用。
 * @param {object} [options]
 * @param {string} [cwd]
 */
export function normalizeInstallOptions(options = {}, cwd = process.cwd()) {
  const overrideRaw = typeof options.i18nOverride === 'string' ? options.i18nOverride.trim() : '';
  return {
    port: options.port !== undefined && options.port !== null ? Number(options.port) : undefined,
    avatar: options.avatar !== false,
    shift: options.shift !== false,
    i18n: options.i18n !== false,
    pulse: options.pulse !== false,
    i18nOverride: overrideRaw ? resolve(cwd, overrideRaw) : undefined,
  };
}

/**
 * 根据安装选项构造后台监听守护进程的参数列表。
 * @param {object} [options]
 * @param {boolean} [includeIfNotRunning]
 * @returns {string[]}
 */
export function buildWatchDaemonArgs(options = {}, { includeIfNotRunning = true } = {}) {
  const args = ['--daemon'];
  if (includeIfNotRunning) {
    args.push('--if-not-running');
  }
  if (options.port !== undefined && options.port !== null) {
    args.push('--port', String(options.port));
  }
  if (options.avatar === false) {
    args.push('--no-avatar');
  }
  if (options.shift === false) {
    args.push('--no-shift');
  }
  if (options.i18n === false) {
    args.push('--no-i18n');
  }
  if (options.pulse === false) {
    args.push('--no-pulse');
  }
  if (options.i18nOverride) {
    args.push('--i18n-override', String(options.i18nOverride));
  }
  return args;
}

/**
 * 生成 Windows 无窗口 VBScript 启动器内容（需以 UTF-16LE + BOM 写入以支持中文路径）。
 * @param {object} params
 * @returns {string}
 */
export function buildWindowsVbsScript({ nodePath, watchScriptPath, rootDir, daemonArgs }) {
  const cmdParts = [nodePath, watchScriptPath, ...daemonArgs].map(
    (part) => `"${String(part).replaceAll('"', '""')}"`,
  );
  const fullCmd = cmdParts.join(' ');
  const vbsCmd = fullCmd.replaceAll('"', '""');
  const vbsDir = String(rootDir).replaceAll('"', '""');
  return [
    'Option Explicit',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${vbsDir}"`,
    `shell.Run "${vbsCmd}", 0, False`,
    '',
  ].join('\r\n');
}

/**
 * 生成 macOS LaunchAgent plist 内容。
 */
export function buildMacLaunchAgentPlist({
  label = MACOS_LAUNCHD_LABEL,
  nodePath,
  watchScriptPath,
  rootDir,
  daemonArgs,
  logFile,
}) {
  const argsXml = [nodePath, watchScriptPath, ...daemonArgs]
    .map((item) => `    <string>${escapeXml(item)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argsXml,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(rootDir)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * 生成 Linux XDG Autostart `.desktop` 文件内容。
 */
export function buildLinuxDesktopEntry({ nodePath, watchScriptPath, rootDir, daemonArgs }) {
  const execLine = [nodePath, watchScriptPath, ...daemonArgs].map(quoteShellArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Antigravity 冬雪莲主题守护',
    'Comment=后台自动监听 Antigravity 桌面端并无损注入冬雪莲主题与汉化',
    `Exec=${execLine}`,
    `Path=${rootDir}`,
    'Terminal=false',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function getRuntimePaths(rootDir) {
  const runtimeDir = join(rootDir, RUNTIME_DIR_NAME);
  return {
    runtimeDir,
    stateFile: join(runtimeDir, INSTALL_STATE_FILENAME),
    vbsFile: join(runtimeDir, VBS_LAUNCHER_FILENAME),
    pidFile: join(rootDir, '.watch.pid'),
    logFile: join(rootDir, 'watch.log'),
    watchBin: join(rootDir, 'bin', 'watch.js'),
  };
}

function getPlatformAutostartPaths({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'LaunchAgents');
    return { plistFile: join(dir, `${MACOS_LAUNCHD_LABEL}.plist`), dir };
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
    const dir = join(configHome, 'autostart');
    return { desktopFile: join(dir, LINUX_DESKTOP_FILENAME), dir };
  }
  return {};
}

async function runPowerShell(script, { execFileImpl = execFileAsync } = {}) {
  const encoded = buildPowerShellEncodedCommand(script);
  return execFileImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
}

function readInstallState(stateFile) {
  if (!existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function registerAutostart({
  rootDir,
  normalizedOptions,
  nodePath,
  version,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  execFileImpl = execFileAsync,
}) {
  const paths = getRuntimePaths(rootDir);
  mkdirSync(paths.runtimeDir, { recursive: true });
  const daemonArgs = buildWatchDaemonArgs(normalizedOptions, { includeIfNotRunning: true });

  if (platform === 'win32') {
    const vbsContent = buildWindowsVbsScript({
      nodePath,
      watchScriptPath: paths.watchBin,
      rootDir,
      daemonArgs,
    });
    writeFileSync(paths.vbsFile, Buffer.from(`\uFEFF${vbsContent}`, 'utf16le'));

    const sysRoot = env.SystemRoot || 'C:\\Windows';
    const wscriptExe = join(sysRoot, 'System32', 'wscript.exe');
    const hasWscript = existsSync(wscriptExe);
    const launchExe = hasWscript ? wscriptExe : 'powershell.exe';
    const psFallbackCmd = `& '${escapePsSingleQuote(nodePath)}' '${escapePsSingleQuote(paths.watchBin)}' ${daemonArgs
      .map((a) => `'${escapePsSingleQuote(a)}'`)
      .join(' ')}`;
    const launchArgs = hasWscript
      ? `//B //Nologo "${paths.vbsFile}"`
      : `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${buildPowerShellEncodedCommand(psFallbackCmd)}`;
    const regCommand = hasWscript
      ? `"${wscriptExe}" //B //Nologo "${paths.vbsFile}"`
      : `powershell.exe ${launchArgs}`;

    let method = 'windows-task-scheduler';
    const taskPs = [
      "$userId = if ($env:USERDOMAIN) { \"$env:USERDOMAIN\\$env:USERNAME\" } else { $env:USERNAME }",
      `$action = New-ScheduledTaskAction -Execute '${escapePsSingleQuote(launchExe)}' -Argument '${escapePsSingleQuote(launchArgs)}' -WorkingDirectory '${escapePsSingleQuote(rootDir)}'`,
      '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId',
      '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable',
      `Register-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Description 'Antigravity 冬雪莲主题后台守护' -Force | Out-Null`,
    ].join('\n');

    try {
      await runPowerShell(taskPs, { execFileImpl });
      // 若此前降级写过 Run 键则清理，避免登录时重复拉起
      const cleanupRunPs = `Remove-ItemProperty -Path '${WINDOWS_REG_KEY_PS}' -Name '${WINDOWS_REG_VALUE}' -ErrorAction SilentlyContinue`;
      await runPowerShell(cleanupRunPs, { execFileImpl }).catch(() => {});
    } catch {
      method = 'windows-registry-run';
      const regPs = [
        `if (-not (Test-Path '${WINDOWS_REG_KEY_PS}')) { New-Item -Path '${WINDOWS_REG_KEY_PS}' -Force | Out-Null }`,
        `Set-ItemProperty -Path '${WINDOWS_REG_KEY_PS}' -Name '${WINDOWS_REG_VALUE}' -Value '${escapePsSingleQuote(regCommand)}' -Type String`,
      ].join('\n');
      await runPowerShell(regPs, { execFileImpl });
    }

    const state = {
      version,
      platform,
      method,
      taskName: WINDOWS_TASK_NAME,
      regValueName: WINDOWS_REG_VALUE,
      launcherPath: paths.vbsFile,
      nodePath,
      options: normalizedOptions,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }

  if (platform === 'darwin') {
    const { plistFile, dir } = getPlatformAutostartPaths({ platform, env, home });
    mkdirSync(dir, { recursive: true });
    const plist = buildMacLaunchAgentPlist({
      label: MACOS_LAUNCHD_LABEL,
      nodePath,
      watchScriptPath: paths.watchBin,
      rootDir,
      daemonArgs,
      logFile: paths.logFile,
    });
    writeFileSync(plistFile, plist, 'utf8');
    await execFileImpl('launchctl', ['unload', plistFile]).catch(() => {});
    await execFileImpl('launchctl', ['load', '-w', plistFile]).catch(() => {});
    const state = {
      version,
      platform,
      method: 'macos-launchagent',
      plistFile,
      nodePath,
      options: normalizedOptions,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }

  const { desktopFile, dir } = getPlatformAutostartPaths({ platform, env, home });
  mkdirSync(dir, { recursive: true });
  const desktop = buildLinuxDesktopEntry({
    nodePath,
    watchScriptPath: paths.watchBin,
    rootDir,
    daemonArgs,
  });
  writeFileSync(desktopFile, desktop, 'utf8');
  const state = {
    version,
    platform,
    method: 'linux-xdg-autostart',
    desktopFile,
    nodePath,
    options: normalizedOptions,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

async function unregisterAutostart({
  rootDir,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  execFileImpl = execFileAsync,
}) {
  const paths = getRuntimePaths(rootDir);
  let removedAutostart = false;

  if (platform === 'win32') {
    const taskPs = [
      `$t = Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue`,
      'if ($t) {',
      `  Unregister-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -Confirm:$false`,
      "  Write-Output 'TASK_REMOVED'",
      '}',
    ].join('\n');
    try {
      const { stdout = '' } = await runPowerShell(taskPs, { execFileImpl });
      if (stdout.includes('TASK_REMOVED')) {
        removedAutostart = true;
      }
    } catch {
      // 忽略计划任务查询/卸载异常并继续清理注册表
    }

    const regPs = [
      `$item = Get-ItemProperty -Path '${WINDOWS_REG_KEY_PS}' -Name '${WINDOWS_REG_VALUE}' -ErrorAction SilentlyContinue`,
      'if ($null -ne $item) {',
      `  Remove-ItemProperty -Path '${WINDOWS_REG_KEY_PS}' -Name '${WINDOWS_REG_VALUE}' -ErrorAction SilentlyContinue`,
      "  Write-Output 'REG_REMOVED'",
      '}',
    ].join('\n');
    try {
      const { stdout = '' } = await runPowerShell(regPs, { execFileImpl });
      if (stdout.includes('REG_REMOVED')) {
        removedAutostart = true;
      }
    } catch {
      // 忽略注册表清理异常
    }
  } else if (platform === 'darwin') {
    const { plistFile } = getPlatformAutostartPaths({ platform, env, home });
    if (existsSync(plistFile)) {
      await execFileImpl('launchctl', ['unload', plistFile]).catch(() => {});
      unlinkQuietly(plistFile);
      removedAutostart = true;
    }
  } else {
    const { desktopFile } = getPlatformAutostartPaths({ platform, env, home });
    if (existsSync(desktopFile)) {
      unlinkQuietly(desktopFile);
      removedAutostart = true;
    }
  }

  if (existsSync(paths.runtimeDir)) {
    rmSync(paths.runtimeDir, { recursive: true, force: true });
  }
  return { removedAutostart };
}

async function queryAutostart({
  rootDir,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  execFileImpl = execFileAsync,
}) {
  const paths = getRuntimePaths(rootDir);
  const state = readInstallState(paths.stateFile);

  if (platform === 'win32') {
    let taskRegistered = false;
    let taskState = null;
    let regRegistered = false;
    try {
      const { stdout = '' } = await runPowerShell(
        `$t = Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { Write-Output $t.State }`,
        { execFileImpl },
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        taskRegistered = true;
        taskState = trimmed;
      }
    } catch {
      // 忽略计划任务探测失败
    }

    try {
      const { stdout = '' } = await runPowerShell(
        `$item = Get-ItemProperty -Path '${WINDOWS_REG_KEY_PS}' -Name '${WINDOWS_REG_VALUE}' -ErrorAction SilentlyContinue; if ($null -ne $item) { Write-Output 'PRESENT' }`,
        { execFileImpl },
      );
      if (stdout.includes('PRESENT')) {
        regRegistered = true;
      }
    } catch {
      // 忽略注册表探测失败
    }

    return {
      installed: taskRegistered || regRegistered,
      method: taskRegistered ? 'windows-task-scheduler' : regRegistered ? 'windows-registry-run' : null,
      detail: taskRegistered ? `${WINDOWS_TASK_NAME} (${taskState})` : regRegistered ? WINDOWS_REG_VALUE : null,
      state,
    };
  }

  if (platform === 'darwin') {
    const { plistFile } = getPlatformAutostartPaths({ platform, env, home });
    const installed = existsSync(plistFile);
    return {
      installed,
      method: installed ? 'macos-launchagent' : null,
      detail: installed ? plistFile : null,
      state,
    };
  }

  const { desktopFile } = getPlatformAutostartPaths({ platform, env, home });
  const installed = existsSync(desktopFile);
  return {
    installed,
    method: installed ? 'linux-xdg-autostart' : null,
    detail: installed ? desktopFile : null,
    state,
  };
}

async function stopExistingWatcher(pidFile, logger, isAliveImpl = isProcessAlive) {
  const { signaled, pid } = tryStopWatcherByPidFile(pidFile, logger);
  if (!signaled || !pid) {
    return false;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && isAliveImpl(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  cleanupExitedPidFile(pidFile, pid);
  return true;
}

function readLogTail(logFile, maxLines = 10) {
  if (!existsSync(logFile)) return '';
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

async function startBackgroundDaemon({
  rootDir,
  watchBin,
  daemonArgs,
  pidFile,
  logFile,
  nodePath = process.execPath,
  spawnImpl = nodeSpawn,
  isAliveImpl = isProcessAlive,
  startupTimeoutMs = 3000,
}) {
  rotateLogIfNeeded(logFile);
  let earlyExitCode = null;
  let spawnError = null;

  const child = spawnImpl(nodePath, [watchBin, ...daemonArgs], {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.on?.('error', (err) => {
    spawnError = err;
  });
  child.on?.('exit', (code) => {
    earlyExitCode = code ?? 0;
  });
  child.unref?.();

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`启动后台监听守护失败：${spawnError.message}`);
    }
    if (earlyExitCode !== null) {
      const tail = readLogTail(logFile);
      throw new Error(
        `后台监听守护提前退出（退出码 ${earlyExitCode}）${tail ? `：\n${tail}` : ''}`,
      );
    }
    if (existsSync(pidFile)) {
      try {
        const pidNum = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (pidNum === child.pid && isAliveImpl(pidNum)) {
          return { pid: pidNum };
        }
      } catch {
        // 等待文件写入完整
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (child.pid && isAliveImpl(child.pid)) {
    return { pid: child.pid };
  }
  const tail = readLogTail(logFile);
  throw new Error(`等待后台监听守护就绪超时${tail ? `：\n${tail}` : ''}`);
}

/**
 * 在 Windows 任务计划程序可用时优先通过 Scheduled Task 独立拉起守护进程，
 * 使其脱离当前终端或宿主服务的 Job Object（防止集成终端/宿主服务重启时连带杀掉守护）。
 */
async function tryStartViaScheduledTask({
  pidFile,
  logFile,
  isAliveImpl = isProcessAlive,
  execFileImpl = execFileAsync,
  startupTimeoutMs = 3000,
}) {
  rotateLogIfNeeded(logFile);
  try {
    await runPowerShell(`Start-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}'`, { execFileImpl });
  } catch {
    return null;
  }

  const deadline = Date.now() + Math.max(1500, startupTimeoutMs);
  while (Date.now() < deadline) {
    let pidNum = null;
    if (isAliveImpl === isProcessAlive) {
      pidNum = readLiveWatcherPid(pidFile);
    } else if (existsSync(pidFile)) {
      try {
        const candidate = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(candidate) && candidate > 0 && isAliveImpl(candidate)) {
          pidNum = candidate;
        }
      } catch {
        // 等待 PID 文件写入完整
      }
    }
    if (pidNum) {
      return { pid: pidNum, launchedVia: 'windows-task-scheduler' };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function probeCdpPages({ port, portFile, fetchImpl = fetch, timeoutMs = 1500 }) {
  try {
    const targetPort = readPort(portFile, { port });
    const pages = await listPages(targetPort, { fetchImpl, timeoutMs });
    return { cdpReachable: true, port: targetPort, pageCount: pages.length };
  } catch {
    return { cdpReachable: false, port: port ?? null, pageCount: 0 };
  }
}

/**
 * 一键永久安装：校验载荷、注册登录自启并立即启动无窗口后台监听守护。
 * 安装一次后，重启 Antigravity、退出再登录账号或重启电脑均会自动保持生效。
 * @param {object} [options]
 */
export async function installTheme(options = {}) {
  const rootDir = resolveRootPath(options.rootDir);
  const paths = getRuntimePaths(rootDir);
  const normalizedOptions = normalizeInstallOptions(options);
  const nodePath = options.nodePath || process.execPath;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  const portFile = options.portFile || getPortFilePath({ platform, env, home });
  const logger = options.logger ?? console;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const isAliveImpl = options.isAliveImpl || isProcessAlive;
  const fetchImpl = options.fetchImpl || fetch;

  // 预先校验资源、CSS 与词典，参数或文件异常时快速失败且不污染系统自启项
  const { version } = prepareRuntimePayload({
    rootDir,
    avatar: normalizedOptions.avatar,
    shift: normalizedOptions.shift,
    i18n: normalizedOptions.i18n,
    pulse: normalizedOptions.pulse,
    i18nOverride: normalizedOptions.i18nOverride,
  });

  await stopExistingWatcher(paths.pidFile, logger, isAliveImpl);

  const autostart = await registerAutostart({
    rootDir,
    normalizedOptions,
    nodePath,
    version: readPackageVersion(rootDir),
    platform,
    env,
    home,
    execFileImpl,
  });

  const daemonArgs = buildWatchDaemonArgs(normalizedOptions, { includeIfNotRunning: false });
  let daemon = null;
  if (platform === 'win32' && autostart.method === 'windows-task-scheduler' && !options.spawnImpl) {
    daemon = await tryStartViaScheduledTask({
      pidFile: paths.pidFile,
      logFile: paths.logFile,
      isAliveImpl,
      execFileImpl,
      startupTimeoutMs: options.startupTimeoutMs ?? 3000,
    });
  }
  if (!daemon) {
    daemon = await startBackgroundDaemon({
      rootDir,
      watchBin: paths.watchBin,
      daemonArgs,
      pidFile: paths.pidFile,
      logFile: paths.logFile,
      nodePath,
      spawnImpl,
      isAliveImpl,
      startupTimeoutMs: options.startupTimeoutMs ?? 3000,
    });
  }

  // 留给后台守护完成首轮 /json/list 与页面注入的缓冲时间
  const settleDelayMs = options.settleDelayMs ?? 350;
  if (settleDelayMs > 0) {
    await new Promise((r) => setTimeout(r, settleDelayMs));
  }
  const cdpInfo = await probeCdpPages({
    port: normalizedOptions.port,
    portFile,
    fetchImpl,
    timeoutMs: options.timeoutMs ?? 1500,
  });

  logger.log(`[冬雪莲 v${version}] 永久安装完成！`);
  logger.log(`  - 后台监听守护：运行中 (PID ${daemon.pid})，日志见 watch.log`);
  logger.log(`  - 登录自动启动：已启用 (${autostart.method})`);
  if (cdpInfo.cdpReachable) {
    logger.log(
      `  - 当前客户端：已连接端口 ${cdpInfo.port}（共 ${cdpInfo.pageCount} 个 Antigravity 页面），重启/重登后会自动重注。`,
    );
  } else {
    logger.log('  - 当前客户端：未检测到运行中的 Antigravity，启动客户端后将自动注入。');
  }

  return {
    installed: true,
    version,
    pid: daemon.pid,
    autostart,
    cdp: cdpInfo,
    options: normalizedOptions,
  };
}

/**
 * 彻底卸载：移除登录自启、停止后台监听守护并清理当前已打开页面的注入痕迹。
 * @param {object} [options]
 */
export async function uninstallTheme(options = {}) {
  const rootDir = resolveRootPath(options.rootDir);
  const paths = getRuntimePaths(rootDir);
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  const logger = options.logger ?? console;
  const execFileImpl = options.execFileImpl || execFileAsync;

  const { removedAutostart } = await unregisterAutostart({
    rootDir,
    platform,
    env,
    home,
    execFileImpl,
  });

  const removeRes = await removeOnce({
    ...options,
    rootDir,
    pidFile: paths.pidFile,
    logger,
    skipAutostartHint: true,
  });

  logger.log(
    `[冬雪莲] 卸载完成：${removedAutostart ? '已移除登录自启，' : ''}${removeRes.stoppedWatcher ? '已停止后台监听，' : ''}已清理页面注入。`,
  );

  return {
    uninstalled: true,
    removedAutostart,
    ...removeRes,
  };
}

/**
 * 查询冬雪莲主题自启注册状态、后台守护状态与当前客户端 CDP 连接状态。
 * @param {object} [options]
 */
export async function getInstallStatus(options = {}) {
  const rootDir = resolveRootPath(options.rootDir);
  const paths = getRuntimePaths(rootDir);
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  const portFile = options.portFile || getPortFilePath({ platform, env, home });
  const logger = options.logger ?? console;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const fetchImpl = options.fetchImpl || fetch;

  const autostart = await queryAutostart({ rootDir, platform, env, home, execFileImpl });
  const watcherPid = readLiveWatcherPid(paths.pidFile);
  const effectivePort = options.port ?? autostart.state?.options?.port;
  const cdp = await probeCdpPages({
    port: effectivePort,
    portFile,
    fetchImpl,
    timeoutMs: options.timeoutMs ?? 1500,
  });

  if (!options.silent) {
    logger.log('[冬雪莲] 运行状态报告：');
    logger.log(
      `  - 登录自动启动：${autostart.installed ? `已启用 (${autostart.method}: ${autostart.detail})` : '未安装'}`,
    );
    logger.log(`  - 后台监听守护：${watcherPid ? `运行中 (PID ${watcherPid})` : '未运行'}`);
    logger.log(
      `  - Antigravity CDP：${cdp.cdpReachable ? `已就绪（端口 ${cdp.port}，${cdp.pageCount} 个页面）` : '未检测到运行中实例'}`,
    );
  }

  return {
    autostartInstalled: autostart.installed,
    autostartMethod: autostart.method,
    autostartDetail: autostart.detail,
    watcherRunning: Boolean(watcherPid),
    watcherPid,
    options: autostart.state?.options ?? null,
    cdp,
  };
}
