import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import { REMOVE_EXPRESSION, buildInjectScript } from '../src/cdp.js';
import { loadI18nDictionary, normalizeOverrideDict, restoreI18nDom } from '../src/i18n.js';
import { injectOnce, parseCliArgs, prepareRuntimePayload, startWatch } from '../src/runner.js';
import { startMockCdpServer } from './helpers/mock-cdp.mjs';
import { createMockAntigravityPage } from './helpers/mock-dom.mjs';

const ROOT = new URL('../', import.meta.url);

function appendText(doc, parent, text) {
  const tn = doc.createTextNode(text);
  parent.appendChild(tn);
  return tn;
}

test('normalizeOverrideDict 与 loadI18nDictionary 正确加载基础词典、跳过注释键并按顺序合并覆盖', () => {
  const loaded = loadI18nDictionary({ rootDir: ROOT });
  assert.ok(loaded.baseCount >= 1600, `基础词条数应不少于 1600（实际 ${loaded.baseCount}）`);
  assert.equal(loaded.dict['New Conversation'], '新建对话');
  assert.equal(loaded.dict.Settings, '系统设置');

  assert.deepEqual(
    normalizeOverrideDict({
      _comment: '注释应忽略',
      exact: {
        _nested: '内部注释也忽略',
        Settings: '偏好设置',
        Custom: '自定义词条',
        invalidNum: 123,
      },
    }),
    Object.assign(Object.create(null), {
      Settings: '偏好设置',
      Custom: '自定义词条',
    }),
  );

  const dir = mkdtempSync(join(tmpdir(), 'dxl-i18n-dict-'));
  try {
    mkdirSync(join(dir, 'assets', 'i18n'), { recursive: true });
    mkdirSync(join(dir, 'user'), { recursive: true });
    writeFileSync(
      join(dir, 'assets', 'i18n', 'zh-CN.json'),
      JSON.stringify({ Settings: '系统设置', Automations: '自动化任务' }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'user', 'i18n.override.json'),
      JSON.stringify({ _comment: 'default user override', Settings: '用户设置' }),
      'utf8',
    );
    const cliOverridePath = join(dir, 'extra-override.json');
    writeFileSync(
      cliOverridePath,
      JSON.stringify({ exact: { Settings: 'CLI覆盖设置', Extra: '额外词条' } }),
      'utf8',
    );

    const merged = loadI18nDictionary({ rootDir: dir, overridePath: cliOverridePath });
    assert.equal(merged.baseCount, 2);
    assert.equal(merged.dict.Automations, '自动化任务');
    assert.equal(merged.dict.Settings, 'CLI覆盖设置');
    assert.equal(merged.dict.Extra, '额外词条');

    assert.throws(
      () => loadI18nDictionary({ rootDir: dir, overridePath: join(dir, 'missing.json') }),
      /未找到指定汉化覆盖词典/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCliArgs 与 formatUsage 正确解析 --no-i18n 与 --i18n-override 参数', () => {
  assert.deepEqual(parseCliArgs(['--no-i18n', '--i18n-override', 'custom.json']), {
    port: undefined,
    avatar: true,
    shift: true,
    i18n: false,
    i18nOverride: 'custom.json',
    daemon: false,
    ifNotRunning: false,
    help: false,
  });
  assert.deepEqual(parseCliArgs(['--i18n-override=./user/my.json']), {
    port: undefined,
    avatar: true,
    shift: true,
    i18n: true,
    i18nOverride: './user/my.json',
    daemon: false,
    ifNotRunning: false,
    help: false,
  });
  assert.throws(() => parseCliArgs(['--i18n-override']), /需要传入覆盖词典文件路径/);
  assert.throws(() => parseCliArgs(['--i18n-override=']), /需要传入有效的覆盖词典文件路径/);

  const withI18n = prepareRuntimePayload({ rootDir: ROOT, i18n: true });
  const withoutI18n = prepareRuntimePayload({ rootDir: ROOT, i18n: false });
  assert.ok(withI18n.script.length - withoutI18n.script.length > 50000);
});

test('运行时汉化支持精确词条、动态规则、保护排除区、深色保持及可逆还原', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const { dict } = loadI18nDictionary({ rootDir: ROOT });

  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { sidebar, stage, body, docEl } = elements;

  // 1. 应被汉化的按钮、状态与动态文案
  const btnNew = document.createElement('button');
  const txtNew = appendText(document, btnNew, 'New Conversation');
  sidebar.appendChild(btnNew);

  const btnWithDot = document.createElement('span');
  const txtWithDot = appendText(document, btnWithDot, 'Settings.');
  sidebar.appendChild(btnWithDot);

  const btnLowerCi = document.createElement('span');
  const txtLowerCi = appendText(document, btnLowerCi, 'settings');
  sidebar.appendChild(btnLowerCi);

  const btnCapCi = document.createElement('span');
  const txtCapCi = appendText(document, btnCapCi, 'SETTINGS');
  sidebar.appendChild(btnCapCi);

  const curlySpan = document.createElement('span');
  const txtCurly = appendText(document, curlySpan, 'What\u2019s next');
  stage.appendChild(curlySpan);

  const workedSpan = document.createElement('span');
  const txtWorked = appendText(document, workedSpan, 'Worked for 12s');
  stage.appendChild(workedSpan);

  const agoSpan = document.createElement('span');
  const txtAgo = appendText(document, agoSpan, '3m ago');
  stage.appendChild(agoSpan);

  const filesSpan = document.createElement('span');
  const txtFiles = appendText(document, filesSpan, '5 files changed');
  stage.appendChild(filesSpan);

  const summarySpan = document.createElement('span');
  const txtSummary = appendText(document, summarySpan, 'Explored 3 files, ran 2 commands');
  stage.appendChild(summarySpan);

  // 2. 属性汉化与 aria-label="Cancel" 安全豁免
  const searchInput = document.createElement('input');
  searchInput.setAttribute('placeholder', 'Ask anything');
  searchInput.setAttribute('aria-label', 'Sidebar');
  searchInput.setAttribute('title', 'Settings');
  stage.appendChild(searchInput);

  const modelBtn = document.createElement('button');
  modelBtn.setAttribute('aria-label', 'Model, current: Gemini 4 (High)');
  stage.appendChild(modelBtn);

  const branchBtn = document.createElement('button');
  branchBtn.setAttribute('aria-label', 'Branch, current: Select branch');
  stage.appendChild(branchBtn);

  const loadOlderBtn = document.createElement('button');
  loadOlderBtn.setAttribute('aria-label', 'Load 5 older turns');
  stage.appendChild(loadOlderBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.setAttribute('aria-label', 'Cancel');
  const txtCancel = appendText(document, cancelBtn, 'Cancel');
  stage.appendChild(cancelBtn);

  // 3. 应严格跳过的排除区域
  const codeEl = document.createElement('code');
  const txtCode = appendText(document, codeEl, 'Settings');
  stage.appendChild(codeEl);

  const preEl = document.createElement('pre');
  const txtPre = appendText(document, preEl, 'New Conversation');
  stage.appendChild(preEl);

  const userMsgEl = document.createElement('div');
  userMsgEl.setAttribute('data-testid', 'user-message-content');
  const txtUserMsg = appendText(document, userMsgEl, 'Worked for 12s');
  stage.appendChild(userMsgEl);

  const mdRootEl = document.createElement('div');
  mdRootEl.setAttribute('data-markdown-root', '');
  mdRootEl.setAttribute('class', 'md-divider-spacing');
  const txtMdRoot = appendText(document, mdRootEl, 'New Conversation');
  stage.appendChild(mdRootEl);

  const monacoEl = document.createElement('div');
  monacoEl.setAttribute('class', 'monaco-editor');
  const txtMonaco = appendText(document, monacoEl, 'Settings');
  stage.appendChild(monacoEl);

  const convRow = document.createElement('div');
  convRow.setAttribute('data-testid', 'conversation-row-sidebar');
  const convLink = document.createElement('a');
  convLink.setAttribute('href', '/c/abc');
  convLink.setAttribute('aria-label', 'Settings');
  const txtConvTitle = appendText(document, convLink, 'Settings');
  convRow.appendChild(convLink);
  sidebar.appendChild(convRow);

  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    i18n: true,
    i18nDict: Object.assign({}, dict, { "What's next": '接下来做什么' }),
    version: '0.1.0',
  });

  const res = page.evaluate(script);
  assert.equal(res.injected, true);
  assert.equal(res.hasI18n, true);

  assert.equal(txtNew.nodeValue, '新建对话');
  assert.equal(txtWithDot.nodeValue, '系统设置。');
  assert.equal(txtLowerCi.nodeValue, 'settings', '小写字母开头的普通文本不应大小写模糊匹配');
  assert.equal(txtCapCi.nodeValue, '系统设置');
  assert.equal(txtCurly.nodeValue, '接下来做什么');
  assert.equal(txtWorked.nodeValue, '已工作 12s');
  assert.equal(txtAgo.nodeValue, '3 分钟前');
  assert.equal(txtFiles.nodeValue, '5 个文件变更');
  assert.equal(txtSummary.nodeValue, '已探索 3 个文件、已运行 2 条命令');

  assert.equal(searchInput.getAttribute('placeholder'), '向 Agent 提问');
  assert.equal(searchInput.getAttribute('data-dxl-orig-placeholder'), 'Ask anything');
  assert.equal(searchInput.getAttribute('aria-label'), '侧边栏');
  assert.equal(searchInput.getAttribute('title'), '系统设置');
  assert.equal(modelBtn.getAttribute('aria-label'), '模型，当前：Gemini 4 (高)');
  assert.equal(branchBtn.getAttribute('aria-label'), '分支，当前：选择分支');
  assert.equal(loadOlderBtn.getAttribute('aria-label'), '加载更早的 5 轮对话');

  // 权限编辑器硬编码 aria-label="Cancel" 豁免；按钮内部文本可正常汉化
  assert.equal(cancelBtn.getAttribute('aria-label'), 'Cancel');
  assert.equal(cancelBtn.hasAttribute('data-dxl-orig-aria-label'), false);
  assert.equal(txtCancel.nodeValue, '取消');

  // 排除区域纹丝不动
  assert.equal(txtCode.nodeValue, 'Settings');
  assert.equal(txtPre.nodeValue, 'New Conversation');
  assert.equal(txtUserMsg.nodeValue, 'Worked for 12s');
  assert.equal(txtMdRoot.nodeValue, 'New Conversation');
  assert.equal(txtMonaco.nodeValue, 'Settings');
  assert.equal(txtConvTitle.nodeValue, 'Settings');
  assert.equal(convLink.getAttribute('aria-label'), 'Settings');

  // 切换至深色模式：CSS 舞台撤回，但简体中文界面继续保持生效
  body.classList.remove('theme-light');
  body.classList.add('theme-dark');
  for (const obs of page.observers) {
    obs.trigger();
  }
  assert.equal(stage.getAttribute('data-dxl-stage'), null);
  assert.equal(txtNew.nodeValue, '新建对话', '深色模式下仍应保持简体中文汉化');
  assert.equal(searchInput.getAttribute('placeholder'), '向 Agent 提问');

  // 使用 --no-i18n 重新注入应完整还原原文与属性
  const noI18nScript = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    i18n: false,
    version: '0.1.0',
  });
  const noI18nRes = page.evaluate(noI18nScript);
  assert.equal(noI18nRes.hasI18n, false);
  assert.equal(txtNew.nodeValue, 'New Conversation');
  assert.equal(txtWorked.nodeValue, 'Worked for 12s');
  assert.equal(searchInput.getAttribute('placeholder'), 'Ask anything');
  assert.equal(modelBtn.getAttribute('aria-label'), 'Model, current: Gemini 4 (High)');
  assert.equal(
    document.querySelectorAll('[data-dxl-orig-title], [data-dxl-orig-placeholder], [data-dxl-orig-aria-label]').length,
    0,
  );

  // 切回浅色并重新开启汉化后执行 REMOVE_EXPRESSION，同样应无损还原
  body.classList.remove('theme-dark');
  body.classList.add('theme-light');
  page.evaluate(script);
  assert.equal(txtNew.nodeValue, '新建对话');
  assert.equal(modelBtn.getAttribute('aria-label'), '模型，当前：Gemini 4 (高)');

  const removeRes = page.evaluate(REMOVE_EXPRESSION);
  assert.equal(removeRes.removed, true);
  assert.ok(removeRes.removedI18nAttrs >= 4);
  assert.equal(docEl.getAttribute('data-dxl-theme'), null);
  assert.equal(txtNew.nodeValue, 'New Conversation');
  assert.equal(txtAgo.nodeValue, '3m ago');
  assert.equal(txtSummary.nodeValue, 'Explored 3 files, ran 2 commands');
  assert.equal(searchInput.getAttribute('placeholder'), 'Ask anything');
  assert.equal(searchInput.getAttribute('title'), 'Settings');
  assert.equal(modelBtn.getAttribute('aria-label'), 'Model, current: Gemini 4 (High)');
  assert.equal(
    document.querySelectorAll('[data-dxl-orig-title], [data-dxl-orig-placeholder], [data-dxl-orig-aria-label]').length,
    0,
  );
  assert.equal(page.observers.every((o) => !o.connected), true);
});

test('Mock CDP 端到端验证 --i18n-override 注入与热重载字典更新', async () => {
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

  const dir = mkdtempSync(join(tmpdir(), 'dxl-i18n-e2e-'));
  const portFile = join(dir, 'DevToolsActivePort');
  const pidFile = join(dir, '.watch.pid');
  const overridePath = join(dir, 'override.json');
  writeFileSync(portFile, `${server.port}\n`, 'utf8');
  writeFileSync(overridePath, JSON.stringify({ 'New Conversation': '开始新对话' }), 'utf8');

  try {
    server.addPage({ id: 'win-1', title: 'Antigravity', url: 'https://127.0.0.1:50000/c/1' });
    const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

    const injectRes = await injectOnce({ portFile, i18nOverride: overridePath, logger: silentLogger });
    assert.equal(injectRes.injectedCount, 1);
    const page1 = domMap.get('win-1');
    assert.equal(page1.customLabel.textContent, '开始新对话');

    const watcher = await startWatch({
      portFile,
      pidFile,
      i18nOverride: overridePath,
      pollIntervalMs: 5000,
      logger: silentLogger,
    });
    try {
      writeFileSync(overridePath, JSON.stringify({ 'New Conversation': '热重载新对话' }), 'utf8');
      const reloaded = await watcher.reinjectNow();
      assert.equal(reloaded, 1);
      assert.equal(page1.customLabel.textContent, '热重载新对话');
    } finally {
      await watcher.stop();
    }
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('带前后空白的正则动态文案保留空白并正确汉化与还原，且免疫原型链键污染', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const { dict } = loadI18nDictionary({ rootDir: ROOT });
  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { stage } = elements;

  const paddedCases = [
    ['  Worked for 12s  ', '  已工作 12s  '],
    ['\n  5 files changed\n', '\n  5 个文件变更\n'],
    ['  +2 attachments  ', '  +2 个附件  '],
    ['  Still thinking, 4 seconds  ', '  仍在思考（4 秒）  '],
    ['  Thought for 3s  ', '  已思考 3s  '],
    ['  See all (8)  ', '  查看全部 (8)  '],
    ['  Weekly limit, resets in 2d 3h  ', '  每周限额，2 天 3 小时后重置  '],
    ['  Deleted 2 recordings (1.5 MB)  ', '  已删除 2 条录音 (1.5 MB)  '],
    ['  Enter Sends immediately  ', '  Enter 立即发送  '],
  ];

  const textNodes = paddedCases.map(([rawText]) => {
    const span = document.createElement('span');
    const tn = appendText(document, span, rawText);
    stage.appendChild(span);
    return tn;
  });

  const protoSpan = document.createElement('span');
  const protoText = appendText(document, protoSpan, 'constructor');
  stage.appendChild(protoSpan);

  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    i18n: true,
    i18nDict: dict,
    version: '0.1.0',
  });

  page.evaluate(script);

  paddedCases.forEach(([_, expected], idx) => {
    assert.equal(textNodes[idx].nodeValue, expected);
  });
  assert.equal(protoText.nodeValue, 'constructor', '原型链属性名不应命中词典查找');

  page.evaluate(REMOVE_EXPRESSION);
  paddedCases.forEach(([rawText], idx) => {
    assert.equal(textNodes[idx].nodeValue, rawText);
  });

  // 单独传入带属性的元素根节点给 restoreI18nDom 时，根节点自身属性也应恢复
  const directEl = document.createElement('button');
  directEl.setAttribute('title', '系统设置');
  directEl.setAttribute('data-dxl-orig-title', 'Settings');
  directEl.setAttribute('data-dxl-orig-title-last', '系统设置');
  const origDoc = globalThis.document;
  globalThis.document = document;
  try {
    const restored = restoreI18nDom(directEl);
    assert.equal(restored.restoredAttrs, 1);
    assert.equal(directEl.getAttribute('title'), 'Settings');
    assert.equal(directEl.hasAttribute('data-dxl-orig-title'), false);
  } finally {
    globalThis.document = origDoc;
  }
});
