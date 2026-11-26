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

test('新版 Antigravity 词典、动态模板、属性专用动作与文件树/分支/转写排除保护均准确生效且可还原', () => {
  const css = buildThemeCss({ rootDir: ROOT });
  const { baseCount, dict } = loadI18nDictionary({ rootDir: ROOT });
  assert.ok(baseCount >= 3000, `基础词典应至少包含 3000 词条（实际 ${baseCount}）`);

  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { stage } = elements;

  const samples = [
    ['Enable', '启用'],
    ['GitHub Policies', 'GitHub 访问策略'],
    ['Match Condition (CEL)', '匹配条件 (CEL)'],
    ['Commit staged changes', '提交已暂存更改'],
    ['Generation Steps (', '生成步骤 ('],
    ['  tokens (', '  Token ('],
    ['Unfold lines 12-48', '展开第 12–48 行'],
    ['Started "playwright".', '已启动“playwright”。'],
    ['Failed to save project settings: permission denied', '保存项目设置失败：permission denied'],
    ['Playback speed 1.5x', '播放速度 1.5x'],
    ['Zoom 125%, reset to fit', '缩放 125%，点击恢复适应窗口'],
    ['Build with Gemini Plugins', '使用 Gemini 插件构建'],
    ['This window\'s agents, files, and terminals are on devbox.', '此窗口中的 Agent、文件与终端均运行于 devbox。'],
  ];

  const nodes = samples.map(([raw]) => {
    const sp = document.createElement('span');
    const tn = appendText(document, sp, raw);
    stage.appendChild(sp);
    return tn;
  });

  // 通用属性动作规则与正文区别验证：按钮属性应翻译，正文句子不误翻
  const openBtn = document.createElement('button');
  openBtn.setAttribute('aria-label', 'Open README.md');
  openBtn.setAttribute('title', 'Delete legacy-cache');
  const openBtnSkill = document.createElement('button');
  openBtnSkill.setAttribute('aria-label', 'Open ppt-master skill');
  const openProse = document.createElement('span');
  const openProseText = appendText(document, openProse, 'Open Source Contribution');
  stage.appendChild(openBtn);
  stage.appendChild(openBtnSkill);
  stage.appendChild(openProse);

  // 文件树、文件标题、Git 分支名、语音实时转写应严格排除，不得把同名单词误翻
  const treeRow = document.createElement('div');
  const treeIcon = document.createElement('div');
  treeIcon.setAttribute('data-testid', 'file-tree-node-icon');
  const treeLabel = document.createElement('div');
  const treeText = appendText(document, treeLabel, 'Enable');
  treeRow.appendChild(treeIcon);
  treeRow.appendChild(treeLabel);
  stage.appendChild(treeRow);

  const fileTitle = document.createElement('span');
  fileTitle.setAttribute('data-testid', 'file-title-name');
  const fileTitleText = appendText(document, fileTitle, 'Settings');
  stage.appendChild(fileTitle);

  const branchOpt = document.createElement('div');
  branchOpt.setAttribute('data-testid', 'branch-option');
  const branchText = appendText(document, branchOpt, 'Active');
  stage.appendChild(branchOpt);

  const transcript = document.createElement('ol');
  transcript.setAttribute('data-testid', 'live-transcript');
  const transcriptText = appendText(document, transcript, 'Commit');
  stage.appendChild(transcript);

  const script = buildInjectScript(css, {
    avatar: false,
    shift: true,
    i18n: true,
    i18nDict: dict,
    version: '0.1.0',
  });
  page.evaluate(script);

  samples.forEach(([, expected], idx) => {
    assert.equal(nodes[idx].nodeValue, expected);
  });
  assert.equal(openBtn.getAttribute('aria-label'), '打开 README.md');
  assert.equal(openBtn.getAttribute('title'), '删除 legacy-cache');
  assert.equal(openBtnSkill.getAttribute('aria-label'), '打开 ppt-master 技能');
  assert.equal(openProseText.nodeValue, 'Open Source Contribution', '正文内普通 Open 开头文本不应套用属性兜底规则');

  assert.equal(treeText.nodeValue, 'Enable', '文件树节点名应保持原文');
  assert.equal(fileTitleText.nodeValue, 'Settings', '文件标题名应保持原文');
  assert.equal(branchText.nodeValue, 'Active', 'Git 分支名应保持原文');
  assert.equal(transcriptText.nodeValue, 'Commit', '实时语音转写文本应保持原文');

  page.evaluate(REMOVE_EXPRESSION);
  samples.forEach(([raw], idx) => {
    assert.equal(nodes[idx].nodeValue, raw);
  });
  assert.equal(openBtn.getAttribute('aria-label'), 'Open README.md');
  assert.equal(openBtn.getAttribute('title'), 'Delete legacy-cache');
  assert.equal(openBtnSkill.getAttribute('aria-label'), 'Open ppt-master skill');
});

test('内置浏览器地址栏与下拉排除区保持原文，且双计数临时摘要正确翻译并可还原', () => {
  const css = buildThemeCss({ rootDir: ROOT });
  const { dict } = loadI18nDictionary({ rootDir: ROOT });
  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { stage } = elements;

  const urlDisplay = document.createElement('span');
  urlDisplay.setAttribute('data-testid', 'browser-url-display');
  const urlText = appendText(document, urlDisplay, 'Settings');
  stage.appendChild(urlDisplay);

  const secOrigin = document.createElement('span');
  secOrigin.setAttribute('data-testid', 'url-security-origin');
  const originText = appendText(document, secOrigin, 'Open');
  stage.appendChild(secOrigin);

  const autoOpt = document.createElement('div');
  autoOpt.setAttribute('data-testid', 'browser-autocomplete-option');
  const optText = appendText(document, autoOpt, 'Done');
  stage.appendChild(autoOpt);

  const dual1 = document.createElement('span');
  const dual1Text = appendText(document, dual1, 'Explored 2 files and 1 artifact');
  stage.appendChild(dual1);

  const dual2 = document.createElement('span');
  const dual2Text = appendText(document, dual2, 'Edited 3 files and 2 artifacts');
  stage.appendChild(dual2);

  const script = buildInjectScript(css, {
    avatar: false,
    shift: true,
    i18n: true,
    i18nDict: dict,
    version: '0.1.0',
  });
  page.evaluate(script);

  assert.equal(urlText.nodeValue, 'Settings');
  assert.equal(originText.nodeValue, 'Open');
  assert.equal(optText.nodeValue, 'Done');
  assert.equal(dual1Text.nodeValue, '已探索 2 个文件与 1 个 Artifact');
  assert.equal(dual2Text.nodeValue, '已编辑 3 个文件与 2 个 Artifact');

  page.evaluate(REMOVE_EXPRESSION);
  assert.equal(dual1Text.nodeValue, 'Explored 2 files and 1 artifact');
  assert.equal(dual2Text.nodeValue, 'Edited 3 files and 2 artifacts');
});

test('Antigravity 2.35.0 新增词典、动态模板、属性文案与高危防误译保护区回归验证', () => {
  const css = buildThemeCss({ rootDir: ROOT });
  const { baseCount, dict } = loadI18nDictionary({ rootDir: ROOT });
  assert.ok(baseCount >= 3400, `基础词典应至少包含 3400 词条（实际 ${baseCount}）`);

  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { stage } = elements;

  const samples = [
    ['Plugin permissions', '插件权限'],
    ['Dictation languages', '听写语言'],
    ['Reset to auto', '重置为自动'],
    ['Yes, allow for this task', '是，在当前任务中允许'],
    ['Orchestrator Settings', 'Orchestrator 设置'],
    ['Inbox Mode', '收件箱模式'],
    ['Fold Working', '折叠进行中'],
    ['Auto-detect (browser defaults)', '自动检测（浏览器默认）'],
    ['Right-click image to save, or open in a new tab.', '右键点击图片即可保存，或在新标签页中打开。'],
    ['Working · 12s', '正在处理 · 12s'],
    ['Using browser · Clicking button (9s)', '正在操作浏览器 · Clicking button (9s)'],
    ['Waiting for approval to read: /etc/hosts', '正在等待批准读取：/etc/hosts'],
    ['Allowed in my-project', '已在 my-project 中允许'],
    ['Your plan: Google AI Pro', '当前方案：Google AI Pro'],
    ['Set up GitHub', '设置 GitHub'],
    ['My Project archived', 'My Project 已归档'],
    ['Allow GitHub?', '是否允许 GitHub？'],
    ['Set up your API key in Settings to continue.', 'Set up your API key in Settings to continue.'],
    ['Allow this plugin to read your files?', 'Allow this plugin to read your files?'],
    ['This project has been archived', 'This project has been archived'],
    ['All 3 will be revoked. The plugin will ask before doing this again.', '全部 3 项权限将被撤销。此后该插件执行相关操作前将重新询问您。'],
    ['Loading earlier posts… (15 older)', '正在加载更早的发言…（还有 15 条）'],
    ['Show 10 earlier posts (25 older)', '显示前 10 条更早发言（共 25 条）'],
  ];

  const textNodes = samples.map(([raw]) => {
    const sp = document.createElement('span');
    const tn = appendText(document, sp, raw);
    stage.appendChild(sp);
    return tn;
  });

  // 2.35.0 新增属性（aria-label / title / placeholder）
  const orchSel = document.createElement('button');
  orchSel.setAttribute('aria-label', 'Orchestrator model selection');
  const revokeAllBtn = document.createElement('button');
  revokeAllBtn.setAttribute('aria-label', 'Revoke all: github');
  const revokeOneBtn = document.createElement('button');
  revokeOneBtn.setAttribute('aria-label', 'Revoke: Read files');
  const applyThemeBtn = document.createElement('button');
  applyThemeBtn.setAttribute('aria-label', 'Applied Dark Paper');
  const dismissBtn = document.createElement('button');
  dismissBtn.setAttribute('aria-label', 'Dismiss: Confirm action');
  const stopRowBtn = document.createElement('button');
  stopRowBtn.setAttribute('data-testid', 'running-row-stop');
  stopRowBtn.setAttribute('aria-label', 'Stop worker-1');
  const permHeading = document.createElement('div');
  permHeading.setAttribute('title', 'Plugin permissions');
  const reconnectHeading = document.createElement('div');
  reconnectHeading.setAttribute('title', 'Reconnecting to devbox…');
  const customInput = document.createElement('input');
  customInput.setAttribute('placeholder', 'Type your own answer');
  const identityInput = document.createElement('input');
  identityInput.setAttribute('placeholder', 'Search by name or username');
  stage.appendChild(orchSel);
  stage.appendChild(revokeAllBtn);
  stage.appendChild(revokeOneBtn);
  stage.appendChild(applyThemeBtn);
  stage.appendChild(dismissBtn);
  stage.appendChild(stopRowBtn);
  stage.appendChild(permHeading);
  stage.appendChild(reconnectHeading);
  stage.appendChild(customInput);
  stage.appendChild(identityInput);

  // 1) conversation-row-history（动态前缀 conversation-row-*）及同级非 truncate 文案
  const histRow = document.createElement('div');
  histRow.setAttribute('data-testid', 'conversation-row-history');
  const histLink = document.createElement('a');
  histLink.setAttribute('href', '/c/hist-1');
  histLink.setAttribute('aria-label', 'Settings');
  const histLinkText = appendText(document, histLink, 'Settings');
  const histTrunc = document.createElement('span');
  histTrunc.setAttribute('class', 'truncate');
  const histTruncText = appendText(document, histTrunc, 'Open');
  const histAction = document.createElement('span');
  const histActionText = appendText(document, histAction, 'Archive');
  histRow.appendChild(histLink);
  histRow.appendChild(histTrunc);
  histRow.appendChild(histAction);
  stage.appendChild(histRow);

  // 2) 面包屑仅保护 /c/ 对话链接，固定页如 /settings 正常汉化
  const convBreadcrumb = document.createElement('a');
  convBreadcrumb.setAttribute('data-testid', 'breadcrumb-segment');
  convBreadcrumb.setAttribute('href', '/c/conv-1');
  convBreadcrumb.setAttribute('aria-label', 'Settings');
  const convBreadcrumbText = appendText(document, convBreadcrumb, 'Settings');
  const settingsBreadcrumb = document.createElement('a');
  settingsBreadcrumb.setAttribute('data-testid', 'breadcrumb-segment');
  settingsBreadcrumb.setAttribute('href', '/settings');
  const settingsBreadcrumbText = appendText(document, settingsBreadcrumb, 'Settings');
  stage.appendChild(convBreadcrumb);
  stage.appendChild(settingsBreadcrumb);

  // 3) 精确子选择器保护与同级可汉化 UI 共存验证
  const siteItem = document.createElement('li');
  siteItem.setAttribute('data-testid', 'browser-site-data-site');
  const siteDomain = document.createElement('span');
  siteDomain.setAttribute('class', 'truncate');
  const siteDomainText = appendText(document, siteDomain, 'Settings');
  const siteCookies = document.createElement('span');
  const siteCookiesText = appendText(document, siteCookies, '3 cookies');
  siteItem.appendChild(siteDomain);
  siteItem.appendChild(siteCookies);
  stage.appendChild(siteItem);

  const sidecarLogs = document.createElement('div');
  sidecarLogs.setAttribute('data-testid', 'sidecar-logs-content');
  const logsLoading = document.createElement('p');
  const logsLoadingText = appendText(document, logsLoading, 'Loading logs...');
  const logsPre = document.createElement('pre');
  const logsPreText = appendText(document, logsPre, 'Settings');
  sidecarLogs.appendChild(logsLoading);
  sidecarLogs.appendChild(logsPre);
  stage.appendChild(sidecarLogs);

  const termSurface = document.createElement('div');
  termSurface.setAttribute('data-testid', 'terminal-surface');
  const xtermDiv = document.createElement('div');
  xtermDiv.setAttribute('class', 'xterm');
  const xtermText = appendText(document, xtermDiv, 'Settings');
  const termCwd = document.createElement('span');
  termCwd.setAttribute('data-testid', 'terminal-cwd-1');
  const termCwdText = appendText(document, termCwd, 'Open');
  const termEmpty = document.createElement('div');
  termEmpty.setAttribute('data-testid', 'terminal-empty');
  const termEmptyText = appendText(document, termEmpty, 'No active terminals');
  termSurface.appendChild(xtermDiv);
  termSurface.appendChild(termCwd);
  termSurface.appendChild(termEmpty);
  stage.appendChild(termSurface);

  const permTriggerCmd = document.createElement('div');
  permTriggerCmd.setAttribute('data-testid', 'permission-trigger-command');
  const permCmdPrefix = appendText(document, permTriggerCmd, 'Command: ');
  const permCmdMono = document.createElement('span');
  permCmdMono.setAttribute('class', 'font-mono');
  const permCmdMonoText = appendText(document, permCmdMono, 'Settings');
  permTriggerCmd.appendChild(permCmdMono);
  stage.appendChild(permTriggerCmd);

  const mcpRow = document.createElement('div');
  mcpRow.setAttribute('data-testid', 'mcp-server-row');
  const mcpName = document.createElement('span');
  mcpName.setAttribute('class', 'font-medium');
  const mcpNameText = appendText(document, mcpName, 'Settings');
  const mcpCfgBtn = document.createElement('button');
  const mcpCfgBtnText = appendText(document, mcpCfgBtn, 'Configure');
  mcpRow.appendChild(mcpName);
  mcpRow.appendChild(mcpCfgBtn);
  stage.appendChild(mcpRow);

  // 4) 其余高危保护容器全保持原文
  const protectedCases = [
    ['div', { 'data-testid': 'external-link-confirm-uri' }, 'Settings'],
    ['span', { 'data-testid': 'url-security-host' }, 'Open'],
    ['span', { 'data-testid': 'webview-prompt-origin' }, 'Done'],
    ['p', { 'data-testid': 'webview-prompt-message' }, 'Cancel'],
    ['div', { 'data-testid': 'pdf-text-layer' }, 'Settings'],
    ['td', { 'data-testid': 'csv-data-row-0' }, 'Open'],
    ['th', { 'data-testid': 'csv-header-0' }, 'Done'],
    ['div', { 'data-testid': 'voice-user-message' }, 'Archive'],
    ['div', { 'data-testid': 'side-question-followup-user' }, 'Cancel'],
    ['div', { 'data-testid': 'project-selector-github-repo-item' }, 'Open'],
    ['span', { 'data-testid': 'jj-worktree-selector-label' }, 'Settings'],
    ['pre', { 'data-testid': 'setup-script-output' }, 'Done'],
    ['div', { 'data-testid': 'markdown-frontmatter' }, 'Draft'],
    ['div', { 'data-testid': 'swarm-member-chip' }, 'Running'],
  ].map(([tag, attrs, raw]) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    const tn = appendText(document, el, raw);
    stage.appendChild(el);
    return [tn, raw];
  });

  const script = buildInjectScript(css, {
    avatar: false,
    shift: true,
    i18n: true,
    i18nDict: dict,
    version: '0.1.0',
  });
  page.evaluate(script);

  samples.forEach(([, expected], idx) => {
    assert.equal(textNodes[idx].nodeValue, expected);
  });

  assert.equal(orchSel.getAttribute('aria-label'), 'Orchestrator 模型选择');
  assert.equal(revokeAllBtn.getAttribute('aria-label'), '全部撤销：github');
  assert.equal(revokeOneBtn.getAttribute('aria-label'), '撤销：Read files');
  assert.equal(applyThemeBtn.getAttribute('aria-label'), '已应用 Dark Paper');
  assert.equal(dismissBtn.getAttribute('aria-label'), '忽略：Confirm action');
  assert.equal(stopRowBtn.getAttribute('aria-label'), '停止 worker-1');
  assert.equal(permHeading.getAttribute('title'), '插件权限');
  assert.equal(reconnectHeading.getAttribute('title'), '正在重新连接至 devbox…');
  assert.equal(customInput.getAttribute('placeholder'), '输入自定义回答');
  assert.equal(identityInput.getAttribute('placeholder'), '按姓名或用户名搜索');

  assert.equal(histLinkText.nodeValue, 'Settings');
  assert.equal(histLink.getAttribute('aria-label'), 'Settings');
  assert.equal(histTruncText.nodeValue, 'Open');
  assert.equal(histActionText.nodeValue, '归档');

  assert.equal(convBreadcrumbText.nodeValue, 'Settings');
  assert.equal(convBreadcrumb.getAttribute('aria-label'), 'Settings');
  assert.equal(settingsBreadcrumbText.nodeValue, '系统设置');

  assert.equal(siteDomainText.nodeValue, 'Settings');
  assert.equal(siteCookiesText.nodeValue, '3 个 Cookie');

  assert.equal(logsLoadingText.nodeValue, '正在加载日志...');
  assert.equal(logsPreText.nodeValue, 'Settings');

  assert.equal(xtermText.nodeValue, 'Settings');
  assert.equal(termCwdText.nodeValue, 'Open');
  assert.equal(termEmptyText.nodeValue, '暂无活动终端');

  assert.equal(permCmdPrefix.nodeValue, '命令： ');
  assert.equal(permCmdMonoText.nodeValue, 'Settings');

  assert.equal(mcpNameText.nodeValue, 'Settings');
  assert.equal(mcpCfgBtnText.nodeValue, '配置');

  protectedCases.forEach(([tn, raw]) => {
    assert.equal(tn.nodeValue, raw, `高危保护区域应保持原文：${raw}`);
  });

  page.evaluate(REMOVE_EXPRESSION);
  samples.forEach(([raw], idx) => {
    assert.equal(textNodes[idx].nodeValue, raw);
  });
  assert.equal(orchSel.getAttribute('aria-label'), 'Orchestrator model selection');
  assert.equal(revokeAllBtn.getAttribute('aria-label'), 'Revoke all: github');
  assert.equal(reconnectHeading.getAttribute('title'), 'Reconnecting to devbox…');
  assert.equal(customInput.getAttribute('placeholder'), 'Type your own answer');
  assert.equal(siteCookiesText.nodeValue, '3 cookies');
  assert.equal(termEmptyText.nodeValue, 'No active terminals');
});

test('审计回归：React 文本节点复用清理、单数删除提示与动态模板防误拼', () => {
  const css = buildThemeCss({ rootDir: ROOT });
  const { dict } = loadI18nDictionary({ rootDir: ROOT });
  const page = createMockAntigravityPage({ light: true });
  const { document, elements } = page;
  const { stage } = elements;

  // 1. React 复用同一 Text 节点（更新为非翻译值 / 清空）后不应残留旧 origTextMap 记录导致 restoreI18nDom 误篡改
  const reusedUpdateEl = document.createElement('span');
  const reusedUpdateText = appendText(document, reusedUpdateEl, 'Settings');
  const reusedClearEl = document.createElement('span');
  const reusedClearText = appendText(document, reusedClearEl, 'Settings');
  stage.appendChild(reusedUpdateEl);
  stage.appendChild(reusedClearEl);

  // 2. 单数活跃对话删除提示与常见会话操作模板、泛指代词/介词防误拼
  const cases = [
    ['Permanently delete MyProject including 1 active conversation.', '永久删除 MyProject 及 1 个进行中的对话。'],
    ['Failed to archive conversation', '归档对话失败'],
    ['Failed to archive MyProject', '归档 MyProject 失败'],
    ['Couldn\u2019t pin conversation', '无法置顶对话'],
    ["Couldn't archive conversation", '无法归档对话'],
    ['Failed to pin conversation', '置顶对话失败'],
    ['Failed to delete cache-dir: EBUSY', '删除 cache-dir 失败：EBUSY'],
    ['Allow this?', 'Allow this?'],
    ['Allow access?', 'Allow access?'],
    ['Set up in Settings', 'Set up in Settings'],
    ['Allow GitHub?', '是否允许 GitHub？'],
    ['Set up GitHub', '设置 GitHub'],
  ];
  const caseNodes = cases.map(([raw]) => {
    const sp = document.createElement('span');
    const tn = appendText(document, sp, raw);
    stage.appendChild(sp);
    return tn;
  });

  const script = buildInjectScript(css, {
    avatar: false,
    shift: true,
    i18n: true,
    i18nDict: dict,
    version: '0.1.0',
  });
  page.evaluate(script);

  assert.equal(reusedUpdateText.nodeValue, '系统设置');
  assert.equal(reusedClearText.nodeValue, '系统设置');
  cases.forEach(([, expected], idx) => {
    assert.equal(caseNodes[idx].nodeValue, expected);
  });

  // 模拟 React 先更新为不可翻译内容 / 清空为空串，再复用到与旧译文相同的字面量
  reusedUpdateText.nodeValue = 'my-branch';
  reusedClearText.nodeValue = '';
  for (const obs of page.observers) {
    obs.trigger();
  }
  assert.equal(reusedUpdateText.nodeValue, 'my-branch');
  assert.equal(reusedClearText.nodeValue, '');

  reusedUpdateText.nodeValue = '系统设置';
  reusedClearText.nodeValue = '系统设置';
  for (const obs of page.observers) {
    obs.trigger();
  }

  // 卸载还原时，已被 React 复用覆写过的节点不得被旧记录误改回 "Settings"
  page.evaluate(REMOVE_EXPRESSION);
  assert.equal(reusedUpdateText.nodeValue, '系统设置');
  assert.equal(reusedClearText.nodeValue, '系统设置');
  cases.forEach(([raw], idx) => {
    assert.equal(caseNodes[idx].nodeValue, raw);
  });
});
