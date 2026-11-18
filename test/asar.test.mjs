import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  ASAR_BACKUP_SUFFIX,
  ASAR_HOOK_FILENAME,
  ASAR_META_FILENAME,
  ASAR_PAYLOAD_FILENAME,
  buildAsarArchive,
  computeAsarIntegrity,
  getAppAsarStatus,
  isMainJsPatched,
  parseAsarArchive,
  patchAppAsar,
  patchMainJsSource,
  readAsarEntryBuffer,
  unpatchAppAsar,
  unpatchMainJsSource,
} from '../src/asar.js';
import { parseCliArgs } from '../src/runner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 在测试中构造最小可用的 Electron .asar 二进制缓冲，支持 unpacked 与 executable 条目 */
function createSyntheticAsar(filesMap, { unpackedEntries = new Set(), executableEntries = new Set() } = {}) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [relPath, content] of Object.entries(filesMap)) {
    const parts = relPath.split('/');
    const fileName = parts.pop();
    let dirNode = header;
    for (const part of parts) {
      if (!dirNode.files[part]) dirNode.files[part] = { files: {} };
      dirNode = dirNode.files[part];
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    if (unpackedEntries.has(relPath)) {
      dirNode.files[fileName] = {
        size: buf.length,
        unpacked: true,
        integrity: computeAsarIntegrity(buf),
      };
      continue;
    }
    const entry = {
      size: buf.length,
      offset: String(offset),
      integrity: computeAsarIntegrity(buf),
    };
    if (executableEntries.has(relPath)) {
      entry.executable = true;
    }
    dirNode.files[fileName] = entry;
    chunks.push(buf);
    offset += buf.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const alignedLen = jsonBuf.length + pad;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedLen, 4);
  headerBuf.writeUInt32LE(4 + alignedLen, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);
  return Buffer.concat([headerBuf, ...chunks]);
}

test('ASAR 解析与重打包保留 unpacked/executable 元数据并计算对齐 Pickle 头部', () => {
  const sampleRaw = Buffer.concat([
    createSyntheticAsar(
      {
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.33.0', main: 'dist/main.js' }),
        'dist/main.js': '"use strict";\nconst electron_1 = require("electron");\nelectron_1.app\n    .whenReady();\n',
        'bin/tool': '#!/bin/sh\necho ok\n',
        'unpacked/helper.js': 'module.exports = 1;\n',
      },
      {
        unpackedEntries: new Set(['unpacked/helper.js']),
        executableEntries: new Set(['bin/tool']),
      },
    ),
  ]);

  const parsed = parseAsarArchive(sampleRaw);
  assert.equal(readAsarEntryBuffer(parsed, 'unpacked/helper.js'), null);
  assert.equal(readAsarEntryBuffer(parsed, 'bin/tool').toString('utf8'), '#!/bin/sh\necho ok\n');

  const repacked = buildAsarArchive(
    parsed,
    new Map([['dist/extra.txt', Buffer.from('hello asar', 'utf8')]]),
  );
  const reParsed = parseAsarArchive(repacked);
  assert.equal(reParsed.dataStart % 4, 0);
  assert.equal(reParsed.header.files.unpacked.files['helper.js'].unpacked, true);
  assert.equal(reParsed.header.files.unpacked.files['helper.js'].offset, undefined);
  assert.equal(reParsed.header.files.bin.files.tool.executable, true);
  assert.equal(readAsarEntryBuffer(reParsed, 'dist/extra.txt').toString('utf8'), 'hello asar');

  // 校验 > 4 MiB 分块完整性计算
  const large = Buffer.alloc(4 * 1024 * 1024 + 17, 0x61);
  const integrity = computeAsarIntegrity(large);
  assert.equal(integrity.algorithm, 'SHA256');
  assert.equal(integrity.blocks.length, 2);
});

test('patchMainJsSource 与 unpatchMainJsSource 对多行 whenReady 锚点幂等且可逆', () => {
  const original = [
    '"use strict";',
    'const electron_1 = require("electron");',
    'electron_1.app',
    '    .whenReady()',
    '    .then(() => {});',
    '',
  ].join('\r\n');

  const once = patchMainJsSource(original);
  assert.equal(isMainJsPatched(once), true);
  assert.ok(once.includes(`require('./${ASAR_HOOK_FILENAME}')`));
  assert.ok(once.indexOf('/* __DXL_THEME_PATCH_START__ */') < once.indexOf('electron_1.app'));

  // 二次注入不会重复插入
  const twice = patchMainJsSource(once);
  assert.equal(twice, once);

  // 剥离后应与原始源码逐字节一致
  assert.equal(unpatchMainJsSource(once), original);
});

test('patchAppAsar 与 unpatchAppAsar 完整闭环并验证钩子安全隔离外部页与 webview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dxl-asar-test-'));
  const asarPath = join(dir, 'app.asar');
  const mainJsSource = [
    '"use strict";',
    'const electron_1 = require("electron");',
    'electron_1.app',
    '    .whenReady()',
    '    .then(() => {});',
    '',
  ].join('\n');
  const origAsar = createSyntheticAsar({
    'package.json': JSON.stringify({ name: 'antigravity', version: '2.33.0', main: 'dist/main.js' }),
    'dist/main.js': mainJsSource,
    'node_modules/native/helper.node': Buffer.from([1, 2, 3, 4]),
  }, { unpackedEntries: new Set(['node_modules/native/helper.node']) });

  writeFileSync(asarPath, origAsar);
  const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

  try {
    assert.deepEqual(parseCliArgs(['--app-asar', asarPath, '--no-avatar']), {
      port: undefined,
      avatar: false,
      shift: true,
      i18n: true,
      i18nOverride: undefined,
      appAsar: asarPath,
      daemon: false,
      ifNotRunning: false,
      help: false,
    });

    const beforeStatus = getAppAsarStatus({ appAsar: asarPath });
    assert.equal(beforeStatus.found, true);
    assert.equal(beforeStatus.patched, false);
    assert.equal(beforeStatus.appVersion, '2.33.0');

    const patchRes = await patchAppAsar({ rootDir: ROOT, appAsar: asarPath, logger: silentLogger });
    assert.equal(patchRes.patched, true);
    assert.equal(patchRes.alreadyPatched, false);
    assert.equal(existsSync(`${asarPath}${ASAR_BACKUP_SUFFIX}`), true);

    const patchedStatus = getAppAsarStatus({ appAsar: asarPath });
    assert.equal(patchedStatus.patched, true);
    assert.equal(patchedStatus.backupExists, true);
    assert.equal(patchedStatus.meta.options.avatar, true);

    // 校验写入归档内全部模块语法合法并验证 Electron 钩子行为
    const patchedArchive = parseAsarArchive(readFileSync(asarPath));
    const patchedMain = readAsarEntryBuffer(patchedArchive, 'dist/main.js').toString('utf8');
    const hookSource = readAsarEntryBuffer(patchedArchive, `dist/${ASAR_HOOK_FILENAME}`).toString('utf8');
    const payloadSource = readAsarEntryBuffer(patchedArchive, `dist/${ASAR_PAYLOAD_FILENAME}`).toString('utf8');
    const metaJson = JSON.parse(readAsarEntryBuffer(patchedArchive, `dist/${ASAR_META_FILENAME}`).toString('utf8'));
    assert.equal(metaJson.appVersion, '2.33.0');

    new vm.Script(patchedMain, { filename: 'dist/main.js' });
    new vm.Script(hookSource, { filename: ASAR_HOOK_FILENAME });
    new vm.Script(payloadSource, { filename: ASAR_PAYLOAD_FILENAME });

    const executed = [];
    const createMockContents = (type, url) => {
      const listeners = new Map();
      return {
        getType: () => type,
        getURL: () => url,
        isDestroyed: () => false,
        on: (evt, fn) => {
          if (!listeners.has(evt)) listeners.set(evt, []);
          listeners.get(evt).push(fn);
        },
        emit: (evt) => {
          for (const fn of listeners.get(evt) || []) fn();
        },
        executeJavaScript: async (code) => {
          executed.push({ type, url, codeLength: code.length });
        },
      };
    };

    const payloadMod = { exports: {} };
    vm.runInNewContext(payloadSource, { module: payloadMod, exports: payloadMod.exports });

    const appListeners = {};
    const existingUi = createMockContents('window', 'https://127.0.0.1:53385/c/existing');
    const mockElectron = {
      webContents: { getAllWebContents: () => [existingUi] },
    };
    const hookMod = { exports: {} };
    vm.runInNewContext(hookSource, {
      module: hookMod,
      exports: hookMod.exports,
      URL,
      Promise,
      require: (id) => {
        if (id === 'electron') return mockElectron;
        if (id === `./${ASAR_PAYLOAD_FILENAME}`) return payloadMod.exports;
        throw new Error(`Unexpected require: ${id}`);
      },
    });
    const mockApp = {
      on: (evt, fn) => {
        appListeners[evt] = fn;
      },
    };
    hookMod.exports.install(mockApp);
    existingUi.emit('dom-ready');

    const foreignWebview = createMockContents('webview', 'https://127.0.0.1:53385/c/spoof');
    const foreignTab = createMockContents('window', 'https://example.com/');
    const newUi = createMockContents('window', 'vscode-file://vscode-app/workbench.html');
    for (const wc of [foreignWebview, foreignTab, newUi]) {
      appListeners['web-contents-created']({}, wc);
      wc.emit('dom-ready');
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(executed.length, 2, '仅应注入 Antigravity 自身窗体，不得注入 webview 或外部 URL');
    assert.equal(executed[0].url, 'https://127.0.0.1:53385/c/existing');
    assert.equal(executed[1].url, 'vscode-file://vscode-app/workbench.html');

    // 二次打补丁保持幂等并更新选项，不覆盖原始干净备份
    const repatchRes = await patchAppAsar({
      rootDir: ROOT,
      appAsar: asarPath,
      avatar: false,
      logger: silentLogger,
    });
    assert.equal(repatchRes.alreadyPatched, true);
    assert.equal(getAppAsarStatus({ appAsar: asarPath }).meta.options.avatar, false);

    // 1. 通过备份还原应与原始归档逐字节一致并清理备份
    const restoreBackupRes = await unpatchAppAsar({ appAsar: asarPath, logger: silentLogger });
    assert.equal(restoreBackupRes.restoredFrom, 'backup');
    assert.equal(existsSync(`${asarPath}${ASAR_BACKUP_SUFFIX}`), false);
    assert.equal(Buffer.compare(readFileSync(asarPath), origAsar), 0);

    // 2. 删除备份后同样能从归档内部干净剥离补丁并保留其他所有文件
    await patchAppAsar({ rootDir: ROOT, appAsar: asarPath, logger: silentLogger });
    rmSync(`${asarPath}${ASAR_BACKUP_SUFFIX}`, { force: true });
    const stripRes = await unpatchAppAsar({ appAsar: asarPath, logger: silentLogger });
    assert.equal(stripRes.restoredFrom, 'strip');
    const strippedArchive = parseAsarArchive(readFileSync(asarPath));
    assert.equal(readAsarEntryBuffer(strippedArchive, 'dist/main.js').toString('utf8'), mainJsSource);
    assert.equal(readAsarEntryBuffer(strippedArchive, `dist/${ASAR_HOOK_FILENAME}`), null);
    assert.equal(readAsarEntryBuffer(strippedArchive, `dist/${ASAR_PAYLOAD_FILENAME}`), null);
    assert.equal(strippedArchive.header.files.node_modules.files.native.files['helper.node'].unpacked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
