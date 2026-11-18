import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';

export const DEBUG_PORT_FLAG = '--remote-debugging-port=0';
export const DEBUG_ADDRESS_FLAG = '--remote-debugging-address=127.0.0.1';
export const DEBUG_ARGS = Object.freeze([DEBUG_PORT_FLAG, DEBUG_ADDRESS_FLAG]);
export const DESKTOP_MANAGED_MARKER = 'X-Dongxuelian-Theme-Managed=true';

function isSymlinkQuietly(targetPath) {
  try {
    return lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function tokenizeArgs(argsText) {
  return String(argsText || '').match(/"[^"]*"|\S+/g) || [];
}

function stripQuotes(token) {
  return token.replace(/^["']|["']$/g, '');
}

/**
 * 解析 Windows Shell Link (`.lnk`) 二进制结构中的目标程序与参数字段，仅用于识别快捷方式。
 * @param {Buffer} data
 * @returns {{ target: string|null, args?: string, icon?: string, workdir?: string, name?: string, rel?: string }|null}
 */
export function parseLnkBuffer(data) {
  if (!Buffer.isBuffer(data) || data.length < 76 || data.length > 1024 * 1024 || data.readUInt32LE(0) !== 0x4c) {
    return null;
  }
  const flags = data.readUInt32LE(0x14);
  const unicodeStr = Boolean(flags & 0x80);
  let pos = 76;
  if (flags & 0x01) {
    if (pos + 2 > data.length) return null;
    pos += 2 + data.readUInt16LE(pos);
  }
  if (pos > data.length) return null;

  let target = null;
  if (flags & 0x02) {
    if (pos + 12 > data.length) return null;
    const infoLen = data.readUInt32LE(pos);
    const infoHdrLen = data.readUInt32LE(pos + 4);
    const infoFlags = data.readUInt32LE(pos + 8);
    if (infoLen < 12 || pos + infoLen > data.length) return null;
    if ((infoFlags & 0x01) && infoLen >= 20) {
      const lbOff = data.readUInt32LE(pos + 16);
      if (lbOff > 0 && lbOff < infoLen) {
        let end = data.indexOf(0, pos + lbOff);
        if (end === -1 || end > pos + infoLen) end = pos + infoLen;
        target = data.subarray(pos + lbOff, end).toString('latin1');
      }
      if (infoHdrLen >= 0x24 && infoLen >= 32) {
        const ubOff = data.readUInt32LE(pos + 28);
        if (ubOff > 0 && ubOff < infoLen) {
          const raw = data.subarray(pos + ubOff, pos + infoLen);
          let uend = raw.length;
          for (let i = 0; i + 1 < raw.length; i += 2) {
            if (raw[i] === 0 && raw[i + 1] === 0) {
              uend = i;
              break;
            }
          }
          target = raw.subarray(0, uend).toString('utf16le');
        }
      }
    }
    pos += infoLen;
  }

  const strings = {};
  for (const [flag, key] of [
    [0x04, 'name'],
    [0x08, 'rel'],
    [0x10, 'workdir'],
    [0x20, 'args'],
    [0x40, 'icon'],
  ]) {
    if (flags & flag) {
      if (pos + 2 > data.length) return null;
      const count = data.readUInt16LE(pos);
      pos += 2;
      const byteLen = count * (unicodeStr ? 2 : 1);
      if (pos + byteLen > data.length) return null;
      strings[key] = data.subarray(pos, pos + byteLen).toString(unicodeStr ? 'utf16le' : 'latin1');
      pos += byteLen;
    }
  }
  return { target, ...strings };
}

/**
 * 判断启动参数字符串是否已包含回环调试端口与地址参数。
 * @param {string} [argsText]
 * @returns {{ hasPort: boolean, hasAddress: boolean }}
 */
export function hasDebugFlags(argsText = '') {
  const clean = tokenizeArgs(argsText).map(stripQuotes);
  return {
    hasPort: clean.some((item) => item === '--remote-debugging-port' || item.startsWith('--remote-debugging-port=')),
    hasAddress: clean.some(
      (item) => item === '--remote-debugging-address' || item.startsWith('--remote-debugging-address='),
    ),
  };
}

/**
 * 判断 Windows 快捷方式是否指向 Antigravity 桌面客户端（自动排除 `--ide` 入口）。
 * @param {string} shortcutPath
 * @param {{ target?: string|null, args?: string, icon?: string }|null} info
 * @returns {boolean}
 */
export function isAntigravityDesktopShortcut(shortcutPath, info) {
  if (!info || !info.target) return false;
  const tokens = tokenizeArgs(info.args || '').map((t) => stripQuotes(t).toLowerCase());
  if (tokens.some((t) => t === '--ide' || t.startsWith('--ide='))) {
    return false;
  }
  const targetName = win32.basename(info.target).toLowerCase();
  if (targetName === 'antigravity.exe') {
    return true;
  }
  if (targetName === 'antigravityproxy.exe') {
    const lnkName = win32.basename(shortcutPath).toLowerCase();
    const iconName = info.icon ? win32.basename(info.icon).toLowerCase() : '';
    return lnkName === 'antigravity.lnk' || iconName === 'antigravity.exe';
  }
  return false;
}

/**
 * 在保留既有参数与 `--` 分隔符的前提下追加缺失的回环调试参数。
 * @param {string} [argsText]
 * @returns {{ args: string, added: string[] }}
 */
export function mergeDebugArguments(argsText = '') {
  const tokens = tokenizeArgs(argsText);
  const clean = tokens.map(stripQuotes);
  const { hasPort, hasAddress } = hasDebugFlags(argsText);
  const added = [];
  if (!hasPort) added.push(DEBUG_PORT_FLAG);
  if (!hasAddress) added.push(DEBUG_ADDRESS_FLAG);
  if (added.length === 0) {
    return { args: argsText || '', added: [] };
  }
  const ddIndex = clean.indexOf('--');
  const next =
    ddIndex >= 0
      ? [...tokens.slice(0, ddIndex), ...added, ...tokens.slice(ddIndex)]
      : [...tokens, ...added];
  return { args: next.join(' '), added };
}

/**
 * 仅移除指定列表中由插件添加的启动参数。
 * @param {string} [argsText]
 * @param {readonly string[]} [removeFlags]
 * @returns {string}
 */
export function stripDebugArguments(argsText = '', removeFlags = DEBUG_ARGS) {
  const targetSet = new Set(removeFlags);
  return tokenizeArgs(argsText)
    .filter((token) => !targetSet.has(stripQuotes(token)))
    .join(' ');
}

/**
 * 为 Linux `.desktop` 文件注入回环调试参数并标记托管段落。
 * @param {string} text
 * @returns {string}
 */
export function mergeDesktopEntry(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inEntry = false;
  let markerWritten = lines.some((line) => line.trim() === DESKTOP_MANAGED_MARKER);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inEntry && !markerWritten) {
        out.push(DESKTOP_MANAGED_MARKER);
        markerWritten = true;
      }
      inEntry = trimmed === '[Desktop Entry]';
      out.push(line);
      continue;
    }
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (execMatch) {
      let rhs = execMatch[2].trimEnd();
      if (!rhs.includes('--remote-debugging-port')) {
        const field = rhs.match(/\s+%[fFuUdDnNickvm]/);
        const flags = `${DEBUG_PORT_FLAG} ${DEBUG_ADDRESS_FLAG}`;
        rhs = field
          ? `${rhs.slice(0, field.index)} ${flags}${rhs.slice(field.index)}`
          : `${rhs} ${flags}`;
      }
      out.push(execMatch[1] + rhs);
      continue;
    }
    out.push(line);
  }
  if (inEntry && !markerWritten) {
    out.push(DESKTOP_MANAGED_MARKER);
  }
  return `${out.join('\n')}\n`;
}

function getWindowsShortcutRoots({ home = homedir(), env = process.env } = {}) {
  const isRealHome = resolve(home) === resolve(homedir());
  const appData = isRealHome && env.APPDATA ? env.APPDATA : join(home, 'AppData', 'Roaming');
  return [
    join(home, 'Desktop'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}

function iterLnkFiles(roots) {
  const results = [];
  const seen = new Set();
  const walk = (dir) => {
    if (!existsSync(dir) || isSymlinkQuietly(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink() || isSymlinkQuietly(full)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        const key = full.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push(full);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return results;
}

function getLinuxDesktopPaths({ home = homedir(), env = process.env, systemDirs } = {}) {
  const isRealHome = resolve(home) === resolve(homedir());
  const dataHome = isRealHome && env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  const sysRoots = systemDirs || ['/usr/share/applications', '/usr/local/share/applications'];
  return {
    userFile: join(dataHome, 'applications', 'antigravity.desktop'),
    sysCandidates: sysRoots.map((dir) => join(dir, 'antigravity.desktop')),
  };
}

function defaultExecPowerShell(updates) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$ws = New-Object -ComObject WScript.Shell',
    'foreach ($u in @($payload)) {',
    '  $item = Get-Item -LiteralPath $u.path',
    "  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked shortcut' }",
    '  $s = $ws.CreateShortcut($u.path)',
    '  $s.Arguments = [string]$u.args',
    '  $s.Save()',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 10000 },
      (error) => (error ? rejectPromise(error) : resolvePromise()),
    );
    child.stdin.end(JSON.stringify(updates), 'utf8');
  });
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function readJsonQuietly(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 检查用户桌面快捷方式或 `.desktop` 入口是否均已配置回环 CDP 调试参数。
 * @param {object} [options]
 * @returns {{ configured: boolean, supported: boolean, entrypoints: string[] }}
 */
export function inspectDesktopLaunch({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  if (platform === 'win32') {
    const entrypoints = [];
    let allReady = true;
    for (const lnk of iterLnkFiles(getWindowsShortcutRoots({ home, env }))) {
      try {
        const info = parseLnkBuffer(readFileSync(lnk));
        if (!isAntigravityDesktopShortcut(lnk, info)) continue;
        entrypoints.push(lnk);
        const { hasPort, hasAddress } = hasDebugFlags(info.args || '');
        if (!hasPort || !hasAddress) allReady = false;
      } catch {
        // 忽略无权限或损坏的快捷方式
      }
    }
    return { configured: entrypoints.length > 0 && allReady, supported: true, entrypoints };
  }

  if (platform === 'linux') {
    const { userFile } = getLinuxDesktopPaths({ home, env });
    if (isSymlinkQuietly(userFile) || !existsSync(userFile)) {
      return { configured: false, supported: true, entrypoints: [] };
    }
    try {
      const content = readFileSync(userFile, 'utf8');
      const execLines = content.split(/\r?\n/).filter((line) => /^\s*Exec\s*=/.test(line));
      const configured = execLines.length > 0 && execLines.every((line) => line.includes('--remote-debugging-port'));
      return { configured, supported: true, entrypoints: [userFile] };
    } catch {
      return { configured: false, supported: true, entrypoints: [] };
    }
  }

  return { configured: false, supported: false, entrypoints: [] };
}

/**
 * 自动修复当前用户拥有的 Antigravity 桌面入口参数，确保跨客户端更新自愈。
 * @param {object} [options]
 * @returns {Promise<{ configured: boolean, repaired: boolean, supported: boolean, entrypoints: string[] }>}
 */
export async function ensureDesktopLaunchConfig({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  stateFile,
  execPowerShell = defaultExecPowerShell,
  systemDirs,
} = {}) {
  const status = inspectDesktopLaunch({ platform, home, env });
  if (status.configured) {
    return { ...status, repaired: false };
  }

  if (platform === 'win32') {
    const updates = [];
    const entrypoints = [];
    for (const lnk of iterLnkFiles(getWindowsShortcutRoots({ home, env }))) {
      try {
        const info = parseLnkBuffer(readFileSync(lnk));
        if (!isAntigravityDesktopShortcut(lnk, info)) continue;
        entrypoints.push(lnk);
        const merged = mergeDebugArguments(info.args || '');
        if (merged.added.length > 0) {
          updates.push({ path: lnk, args: merged.args, added: merged.added });
        }
      } catch {
        // 跳过不可读快捷方式
      }
    }
    if (updates.length === 0) {
      return { configured: entrypoints.length > 0, repaired: false, supported: true, entrypoints };
    }
    try {
      await execPowerShell(updates.map(({ path, args }) => ({ path, args })));
      if (stateFile) {
        const state = readJsonQuietly(stateFile);
        const tracked =
          state.windowsShortcuts && typeof state.windowsShortcuts === 'object'
            ? { ...state.windowsShortcuts }
            : {};
        for (const item of updates) {
          const existing = Array.isArray(tracked[item.path])
            ? tracked[item.path].filter((f) => DEBUG_ARGS.includes(f))
            : [];
          for (const flag of item.added) {
            if (!existing.includes(flag)) existing.push(flag);
          }
          tracked[item.path] = existing;
        }
        state.windowsShortcuts = tracked;
        atomicWriteJson(stateFile, state);
      }
      return { configured: true, repaired: true, supported: true, entrypoints };
    } catch {
      return { configured: false, repaired: false, supported: true, entrypoints };
    }
  }

  if (platform === 'linux') {
    const { userFile, sysCandidates } = getLinuxDesktopPaths({ home, env, systemDirs });
    if (isSymlinkQuietly(userFile) || isSymlinkQuietly(dirname(userFile))) {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
    let source = null;
    if (existsSync(userFile)) {
      try {
        const existing = readFileSync(userFile, 'utf8');
        if (!existing.includes(DESKTOP_MANAGED_MARKER)) {
          const execLines = existing.split(/\r?\n/).filter((line) => /^\s*Exec\s*=/.test(line));
          const configured = execLines.length > 0 && execLines.every((line) => line.includes('--remote-debugging-port'));
          return { configured, repaired: false, supported: true, entrypoints: [userFile] };
        }
        source = existing;
      } catch {
        return { configured: false, repaired: false, supported: true, entrypoints: [] };
      }
    } else {
      for (const candidate of sysCandidates) {
        if (isSymlinkQuietly(candidate) || !existsSync(candidate)) continue;
        try {
          source = readFileSync(candidate, 'utf8');
          break;
        } catch {
          // 尝试下一个系统模板
        }
      }
    }
    if (source === null) {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
    const updated = mergeDesktopEntry(source);
    try {
      mkdirSync(dirname(userFile), { recursive: true });
      const tmp = `${userFile}.${process.pid}.tmp`;
      writeFileSync(tmp, updated, { encoding: 'utf8', mode: 0o644 });
      renameSync(tmp, userFile);
      if (stateFile) {
        const state = readJsonQuietly(stateFile);
        state.linuxDesktopFile = userFile;
        atomicWriteJson(stateFile, state);
      }
      return { configured: true, repaired: true, supported: true, entrypoints: [userFile] };
    } catch {
      return { configured: false, repaired: false, supported: true, entrypoints: [] };
    }
  }

  return { configured: false, supported: false, entrypoints: [] };
}

/**
 * 仅撤回此前由本工具记录添加到用户启动入口中的调试参数。
 * @param {object} [options]
 * @returns {Promise<{ revertedCount: number }>}
 */
export async function removeDesktopLaunchConfig({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  stateFile,
  execPowerShell = defaultExecPowerShell,
} = {}) {
  if (!stateFile || !existsSync(stateFile)) {
    return { revertedCount: 0 };
  }
  const state = readJsonQuietly(stateFile);
  let revertedCount = 0;

  if (platform === 'win32' && state.windowsShortcuts && typeof state.windowsShortcuts === 'object') {
    const updates = [];
    for (const [lnkPath, flags] of Object.entries(state.windowsShortcuts)) {
      if (!Array.isArray(flags) || isSymlinkQuietly(lnkPath) || !existsSync(lnkPath)) continue;
      try {
        const info = parseLnkBuffer(readFileSync(lnkPath));
        if (!isAntigravityDesktopShortcut(lnkPath, info)) continue;
        const allowed = flags.filter((f) => DEBUG_ARGS.includes(f));
        const stripped = stripDebugArguments(info.args || '', allowed);
        if (stripped !== (info.args || '')) {
          updates.push({ path: lnkPath, args: stripped });
        }
      } catch {
        // 忽略单条失败
      }
    }
    if (updates.length > 0) {
      await execPowerShell(updates).catch(() => {});
      revertedCount = updates.length;
    }
    delete state.windowsShortcuts;
    atomicWriteJson(stateFile, state);
    return { revertedCount };
  }

  if (platform === 'linux' && typeof state.linuxDesktopFile === 'string') {
    const target = state.linuxDesktopFile;
    if (!isSymlinkQuietly(target) && existsSync(target)) {
      try {
        if (readFileSync(target, 'utf8').includes(DESKTOP_MANAGED_MARKER)) {
          unlinkSync(target);
          revertedCount = 1;
        }
      } catch {
        // 忽略删除失败
      }
    }
    delete state.linuxDesktopFile;
    atomicWriteJson(stateFile, state);
    return { revertedCount };
  }

  return { revertedCount };
}
