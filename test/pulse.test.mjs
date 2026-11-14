import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import { REMOVE_EXPRESSION, buildInjectScript } from '../src/cdp.js';
import {
  PULSE_PILL_ID,
  PULSE_POPOVER_ID,
  PULSE_WRAP_ID,
  computeRateMetrics,
  createPulseController,
  estimateTokens,
  formatPulsePillLabel,
} from '../src/pulse.js';
import { MockElement, createMockAntigravityPage } from './helpers/mock-dom.mjs';

const ROOT = new URL('../', import.meta.url);

function attachEventSupport(el) {
  const listeners = new Map();
  el.addEventListener = (type, fn, capture = false) => {
    const key = `${type}:${capture ? '1' : '0'}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };
  el.removeEventListener = (type, fn, capture = false) => {
    const key = `${type}:${capture ? '1' : '0'}`;
    const list = listeners.get(key);
    if (!list) return;
    listeners.set(
      key,
      list.filter((item) => item !== fn),
    );
  };
  el.dispatch = (type, evt, capture = false) => {
    const key = `${type}:${capture ? '1' : '0'}`;
    for (const fn of listeners.get(key) || []) {
      fn(evt);
    }
  };
  return el;
}

function createInteractivePulseHarness() {
  const docEl = attachEventSupport(new MockElement('html'));
  const head = attachEventSupport(new MockElement('head'));
  const body = attachEventSupport(new MockElement('body', { class: 'theme-light' }));
  docEl.appendChild(head);
  docEl.appendChild(body);

  const stage = attachEventSupport(new MockElement('div', { 'data-testid': 'conversation-view' }));
  const composerWrap = attachEventSupport(
    new MockElement('div', { id: 'antigravity.agentSidePanelInputBox', 'data-testid': 'agent-input-box' }),
  );
  const sendBtn = attachEventSupport(new MockElement('button', { 'data-testid': 'send-button' }));
  composerWrap.appendChild(sendBtn);
  stage.appendChild(composerWrap);
  body.appendChild(stage);

  const docListeners = new Map();
  const fakeDoc = {
    documentElement: docEl,
    body,
    createElement: (tag) => attachEventSupport(new MockElement(tag)),
    getElementById: (id) => {
      const queue = [docEl];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur.id === id) return cur;
        queue.push(...cur.children);
      }
      return null;
    },
    querySelector: (selector) => docEl.querySelector(selector),
    querySelectorAll: (selector) => docEl.querySelectorAll(selector),
    addEventListener: (type, fn, capture = false) => {
      const key = `${type}:${Boolean(capture)}`;
      if (!docListeners.has(key)) docListeners.set(key, []);
      docListeners.get(key).push(fn);
    },
    removeEventListener: (type, fn, capture = false) => {
      const key = `${type}:${Boolean(capture)}`;
      const list = docListeners.get(key);
      if (!list) return;
      docListeners.set(
        key,
        list.filter((item) => item !== fn),
      );
    },
  };

  const emitDoc = (type, evt) => {
    for (const capture of [true, false]) {
      const key = `${type}:${capture}`;
      for (const fn of [...(docListeners.get(key) || [])]) {
        fn(evt);
      }
    }
  };

  return { docEl, body, stage, composerWrap, sendBtn, fakeDoc, emitDoc };
}

test('estimateTokens 分别估算中英文、数字与混合文本的 Token 数', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('Hello, world!'), 3);
  assert.equal(estimateTokens('冬雪莲主题生成脉搏'), 6);
  const mixed = estimateTokens('Antigravity 冬雪莲 2026');
  assert.ok(mixed >= 5 && mixed <= 8, `混合文本估算应在合理区间，实际 ${mixed}`);
});

test('computeRateMetrics 在最小采样阈值内外正确计算与抑制失真峰值', () => {
  const burst = computeRateMetrics({
    startedAt: 1000,
    firstDeltaAt: 1300,
    lastDeltaAt: 1400,
    deltaChars: 40,
    deltaTokens: 16,
  });
  assert.equal(burst.ttftMs, 300);
  assert.equal(burst.tokPerSec, null, '输出窗口不足 250ms 不应返回失真速率');
  assert.equal(burst.charsPerSec, null);

  const tiny = computeRateMetrics({
    startedAt: 1000,
    firstDeltaAt: 1200,
    lastDeltaAt: 1800,
    deltaChars: 2,
    deltaTokens: 1,
  });
  assert.equal(tiny.tokPerSec, null, '字符增量不足 4 个字不应输出速率');

  const stable = computeRateMetrics({
    startedAt: 1000,
    firstDeltaAt: 1500,
    lastDeltaAt: 2500,
    deltaChars: 120,
    deltaTokens: 48,
  });
  assert.equal(stable.ttftMs, 500);
  assert.equal(stable.streamMs, 1000);
  assert.equal(stable.totalMs, 1500);
  assert.equal(stable.tokPerSec, 48);
  assert.equal(stable.charsPerSec, 120);

  const fallbackStream = computeRateMetrics({
    startedAt: null,
    firstDeltaAt: 2000,
    lastDeltaAt: 3000,
    deltaChars: 50,
    deltaTokens: 20,
  });
  assert.equal(fallbackStream.ttftMs, null, '未捕捉发送动作时不应伪造首响耗时');
  assert.equal(fallbackStream.tokPerSec, 20);
});

test('formatPulsePillLabel 在不同状态下格式化胶囊文案', () => {
  assert.equal(formatPulsePillLabel({ state: 'idle' }), '冬雪莲 · 脉搏');
  assert.equal(formatPulsePillLabel({ state: 'waiting' }), '等待首响…');
  assert.equal(formatPulsePillLabel({ state: 'waiting', totalMs: 1200 }), '首响等待 1.2s');
  assert.equal(
    formatPulsePillLabel({ state: 'streaming', tokPerSec: 36.4, charsPerSec: 88, ttftMs: 620, totalMs: 1400 }),
    '~36.4 tok/s · 1.4s',
  );
  assert.equal(
    formatPulsePillLabel({ state: 'done', tokPerSec: 41.2, charsPerSec: 95, ttftMs: 840 }),
    '首响 0.8s · ~41.2 tok/s',
  );
  assert.equal(formatPulsePillLabel({ state: 'done', yielded: true }), '');
});

test('buildInjectScript 默认注入生成脉搏胶囊、支持避让外部插件、响应 --no-pulse 并彻底卸载', () => {
  const assets = loadThemeAssets(ROOT);
  const css = buildThemeCss({ rootDir: ROOT });
  const script = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    pulse: true,
    version: '0.1.0',
  });

  const page = createMockAntigravityPage({ light: true });
  const result = page.evaluate(script);
  assert.equal(result.hasPulse, true);

  const wrap = page.document.getElementById(PULSE_WRAP_ID);
  const pill = page.document.getElementById(PULSE_PILL_ID);
  const popover = page.document.getElementById(PULSE_POPOVER_ID);
  assert.ok(wrap && pill && popover, '应创建脉搏胶囊与详情浮层节点');
  assert.equal(pill.textContent, '冬雪莲 · 脉搏');
  assert.equal(wrap.hasAttribute('hidden'), false);
  assert.equal(popover.hasAttribute('hidden'), true);

  // 检测到 antigravity-pulse 时自动退让隐藏
  const extBar = new MockElement('div', { id: 'ag-pulse-status-bar' });
  page.elements.body.appendChild(extBar);
  for (const obs of page.observers) obs.trigger();
  assert.equal(wrap.getAttribute('data-dxl-pulse-yielded'), 'true');
  assert.equal(wrap.hasAttribute('hidden'), true);

  // 移除外部插件后恢复显示
  extBar.remove();
  for (const obs of page.observers) obs.trigger();
  assert.equal(wrap.getAttribute('data-dxl-pulse-yielded'), null);
  assert.equal(wrap.hasAttribute('hidden'), false);

  // 内置浏览器打孔激活时隐藏，防止遮挡 WebContentsView
  page.elements.body.setAttribute('data-has-browser-hole', 'true');
  for (const obs of page.observers) obs.trigger();
  assert.equal(wrap.hasAttribute('hidden'), true);
  page.elements.body.removeAttribute('data-has-browser-hole');
  for (const obs of page.observers) obs.trigger();
  assert.equal(wrap.hasAttribute('hidden'), false);

  // 使用 --no-pulse 重新注入时应移除脉搏节点
  const disabledScript = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    pulse: false,
    version: '0.1.0',
  });
  const disabledRes = page.evaluate(disabledScript);
  assert.equal(disabledRes.hasPulse, false);
  assert.equal(page.document.getElementById(PULSE_WRAP_ID), null);

  // 重新开启并执行 REMOVE_EXPRESSION 彻底卸载
  page.evaluate(script);
  assert.ok(page.document.getElementById(PULSE_WRAP_ID));
  const removed = page.evaluate(REMOVE_EXPRESSION);
  assert.equal(removed.removed, true);
  assert.equal(removed.removedPulse, 1);
  assert.equal(page.document.getElementById(PULSE_WRAP_ID), null);
});

test('createPulseController 端到端跟踪流式响应、详情弹窗重置与切换会话防尖峰', async () => {
  const harness = createInteractivePulseHarness();
  let fakeTime = 1000;
  let fakePath = '/c/first';

  const origDoc = globalThis.document;
  globalThis.document = harness.fakeDoc;
  let ctrl = null;
  try {
    ctrl = createPulseController({
      estimateTokens,
      computeRateMetrics,
      formatPulsePillLabel,
      now: () => fakeTime,
      getPath: () => fakePath,
      settleMs: 35,
    });

    ctrl.ensureStarted();
    const wrap = harness.fakeDoc.getElementById(PULSE_WRAP_ID);
    const pill = harness.fakeDoc.getElementById(PULSE_PILL_ID);
    const popover = harness.fakeDoc.getElementById(PULSE_POPOVER_ID);
    assert.ok(wrap && pill && popover);

    // 模拟点击发送按钮
    fakeTime = 2000;
    harness.emitDoc('click', { target: harness.sendBtn });
    assert.equal(wrap.getAttribute('data-dxl-pulse-state'), 'waiting');
    assert.equal(pill.textContent, '等待首响…');

    // 400ms 后首段回复渲染
    fakeTime = 2400;
    const userStep = attachEventSupport(new MockElement('div', { 'data-testid': 'user-input-step' }));
    userStep.textContent = '请介绍一下冬雪莲主题的设计理念';
    const resp = attachEventSupport(new MockElement('div', { 'data-testid': 'planner-response-text' }));
    resp.textContent = '冬雪莲主题采用宣纸暖白打底';
    harness.stage.appendChild(userStep);
    harness.stage.appendChild(resp);
    ctrl.syncDom();

    // 继续流式追加 1000ms
    fakeTime = 3400;
    resp.textContent =
      '冬雪莲主题采用宣纸暖白打底，并搭配黛青蓝与低对比度排版，使长对话拥有如纸质书页般的柔和视觉层次。';
    ctrl.syncDom();

    const liveSnap = ctrl.getSnapshot();
    assert.equal(liveSnap.state, 'streaming');
    assert.equal(liveSnap.ttftMs, 400);
    assert.ok(liveSnap.tokPerSec > 0, '流式阶段应计算出有效渲染 tok/s');
    assert.match(pill.textContent, /^~\d+(\.\d+)? tok\/s · \d+\.\ds$/);

    // 等待自动收口进入 done
    await new Promise((r) => setTimeout(r, 60));
    ctrl.syncDom();
    assert.equal(wrap.getAttribute('data-dxl-pulse-state'), 'done');
    assert.match(pill.textContent, /^首响 0\.4s · ~\d+(\.\d+)? tok\/s$/);

    // 点击胶囊打开详情浮层并校验统计与历史
    let stopped = false;
    pill.dispatch('click', {
      target: pill,
      stopPropagation: () => {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
    assert.equal(popover.hasAttribute('hidden'), false);
    assert.match(popover.textContent, /冬雪莲 · 生成脉搏/);
    assert.match(popover.textContent, /基于页面 DOM 渲染增量估算 · 零外部服务探测/);
    assert.match(popover.textContent, /#1/);

    // 点击重置按钮清空历史与状态
    const resetBtn = popover.querySelector('#dxl-pulse-reset');
    assert.ok(resetBtn, '浮层中应包含重置按钮');
    resetBtn.dispatch('click', { target: resetBtn, stopPropagation: () => {} });
    assert.equal(ctrl.getSnapshot().state, 'idle');
    assert.match(popover.textContent, /发送消息后将记录最近 5 轮速率/);

    // 点击外部空白处关闭浮层
    harness.emitDoc('click', { target: harness.body });
    assert.equal(popover.hasAttribute('hidden'), true);

    // 切换会话并注入大段历史回复时，冷却期应吸收基线，不误计入速率
    fakeTime = 5000;
    fakePath = '/c/second';
    const histResp1 = attachEventSupport(new MockElement('div', { 'data-testid': 'planner-response-text' }));
    histResp1.textContent = '历史会话中的超长回复文本内容 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const histResp2 = attachEventSupport(new MockElement('div', { 'data-testid': 'planner-response-text' }));
    histResp2.textContent = '历史会话中的超长回复文本内容 BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    harness.stage.appendChild(histResp1);
    harness.stage.appendChild(histResp2);
    ctrl.syncDom();

    assert.equal(ctrl.getSnapshot().state, 'idle', '切换会话后加载历史内容不应触发虚假流式计数');
  } finally {
    ctrl?.stop?.();
    globalThis.document = origDoc;
  }
});
