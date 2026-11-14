/**
 * 冬雪莲主题 · 纯前端实时生成脉搏与输出流速模块（MIT 原创，零外部服务探测）。
 *
 * 仅观察页面渲染层 DOM 对话输出增量，计算首响耗时（TTFT）、渲染字速与估算 token/s，
 * 视觉上采用冬雪莲暖纸白（#FFFDF8）+ 靛蓝墨（#2C4268 / #536B9E）和谐风格；
 * 当检测到独立指标插件（如 antigravity-pulse）已挂载时自动退避避免重复显示。
 */

export const PULSE_WRAP_ID = 'dxl-pulse-wrap';
export const PULSE_PILL_ID = 'dxl-pulse-pill';
export const PULSE_POPOVER_ID = 'dxl-pulse-popover';

/**
 * 估算中英文混排文本的大致 Token 数（仅用于页面渲染增量显示，非计费精确值）。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  let cjkCount = 0;
  let otherNonSpace = 0;
  let spaceCount = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      spaceCount += 1;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkCount += 1;
    } else {
      otherNonSpace += 1;
    }
  }

  // 中文字符约 1.5 字/token，英文及代码符号约 3.8 字符/token
  const rawEstimate = cjkCount / 1.5 + (otherNonSpace + spaceCount * 0.25) / 3.8;
  return Math.max(1, Math.round(rawEstimate));
}

/**
 * 根据时间节点与输出增量计算首响耗时（TTFT）与平均输出速率。
 * 为避免瞬时单批渲染产生失真峰值，仅当连续输出窗口 >= minWindowMs 且字符增量 >= minChars 时输出速率。
 * @param {object} params
 * @param {number|null} [params.startedAt]
 * @param {number|null} [params.firstDeltaAt]
 * @param {number|null} [params.lastDeltaAt]
 * @param {number} [params.deltaChars]
 * @param {number} [params.deltaTokens]
 * @param {number} [params.minWindowMs]
 * @param {number} [params.minChars]
 */
export function computeRateMetrics({
  startedAt = null,
  firstDeltaAt = null,
  lastDeltaAt = null,
  deltaChars = 0,
  deltaTokens = 0,
  minWindowMs = 250,
  minChars = 4,
} = {}) {
  const safeChars = Number.isFinite(deltaChars) && deltaChars > 0 ? deltaChars : 0;
  const safeTokens = Number.isFinite(deltaTokens) && deltaTokens > 0 ? deltaTokens : 0;

  const ttftMs =
    typeof startedAt === 'number' &&
    typeof firstDeltaAt === 'number' &&
    firstDeltaAt >= startedAt
      ? Math.round(firstDeltaAt - startedAt)
      : null;

  const streamMs =
    typeof firstDeltaAt === 'number' &&
    typeof lastDeltaAt === 'number' &&
    lastDeltaAt >= firstDeltaAt
      ? Math.round(lastDeltaAt - firstDeltaAt)
      : 0;

  const anchorStart = typeof startedAt === 'number' ? startedAt : firstDeltaAt;
  const totalMs =
    typeof anchorStart === 'number' &&
    typeof lastDeltaAt === 'number' &&
    lastDeltaAt >= anchorStart
      ? Math.round(lastDeltaAt - anchorStart)
      : null;

  const roundOne = (val) => Math.round(val * 10) / 10;
  const hasStableWindow = streamMs >= minWindowMs && safeChars >= minChars;
  const secs = hasStableWindow ? streamMs / 1000 : 0;

  return {
    ttftMs,
    streamMs,
    totalMs,
    deltaChars: safeChars,
    deltaTokens: safeTokens,
    tokPerSec: hasStableWindow && safeTokens > 0 ? roundOne(safeTokens / secs) : null,
    charsPerSec: hasStableWindow ? roundOne(safeChars / secs) : null,
  };
}

/**
 * 格式化底部胶囊展示的紧凑中文标签。
 * @param {object} snapshot
 * @returns {string}
 */
export function formatPulsePillLabel(snapshot = {}) {
  const {
    state = 'idle',
    tokPerSec = null,
    charsPerSec = null,
    ttftMs = null,
    totalMs = null,
    deltaTokens = 0,
    yielded = false,
  } = snapshot;

  if (yielded) return '';

  const fmtSec = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

  if (state === 'waiting') {
    return typeof totalMs === 'number' && totalMs >= 100
      ? `首响等待 ${fmtSec(totalMs)}`
      : '等待首响…';
  }

  if (state === 'streaming') {
    if (typeof tokPerSec === 'number') {
      const durPart = typeof totalMs === 'number' ? ` · ${fmtSec(totalMs)}` : '';
      return `~${tokPerSec.toFixed(1)} tok/s${durPart}`;
    }
    if (typeof charsPerSec === 'number') {
      return `${Math.round(charsPerSec)} 字/s`;
    }
    return deltaTokens > 0 ? `生成中 ~${deltaTokens} tok` : '生成中…';
  }

  if (state === 'done') {
    const ttftPart = typeof ttftMs === 'number' ? `首响 ${fmtSec(ttftMs)} · ` : '';
    if (typeof tokPerSec === 'number') {
      return `${ttftPart}~${tokPerSec.toFixed(1)} tok/s`;
    }
    if (deltaTokens > 0) {
      return `${ttftPart}输出 ~${deltaTokens} tok`;
    }
  }

  return '冬雪莲 · 脉搏';
}

/**
 * 清理页面内挂载的脉搏胶囊与浮窗 DOM（用于卸载或关闭 `--no-pulse`）。
 */
export function cleanupPulseDom() {
  const wrap = document.getElementById('dxl-pulse-wrap');
  if (wrap) wrap.remove();
  for (const node of document.querySelectorAll('[data-dxl-pulse]')) {
    node.remove();
  }
}

/**
 * 在浏览器页面上下文中创建纯 DOM 实时生成流速控制器（零外部闭包，兼容序列化注入）。
 * @param {object} helpers
 * @param {Function} helpers.estimateTokens
 * @param {Function} helpers.computeRateMetrics
 * @param {Function} helpers.formatPulsePillLabel
 */
export function createPulseController(helpers) {
  const estTokens = helpers.estimateTokens;
  const calcMetrics = helpers.computeRateMetrics;
  const formatLabel = helpers.formatPulsePillLabel;

  const WRAP_ID = 'dxl-pulse-wrap';
  const PILL_ID = 'dxl-pulse-pill';
  const POPOVER_ID = 'dxl-pulse-popover';
  const TURN_SETTLE_MS = typeof helpers.settleMs === 'number' ? helpers.settleMs : 1600;
  const ROUTE_COOLDOWN_MS = 500;
  const MAX_HISTORY = 5;

  const now =
    typeof helpers.now === 'function'
      ? helpers.now
      : () =>
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
  const getPath =
    typeof helpers.getPath === 'function'
      ? helpers.getPath
      : () => (typeof location === 'object' && location ? location.pathname : '');

  let started = false;
  let popoverOpen = false;
  let state = 'idle'; // 'idle' | 'waiting' | 'streaming' | 'done'
  let lastPath = getPath();
  let cooldownUntil = 0;

  let baselineUserCount = 0;
  let baselineRespEl = null;
  let baselineRespLen = 0;

  let turnStartedAt = null;
  let firstDeltaAt = null;
  let lastDeltaAt = null;
  let turnStartTextLen = 0;
  let activeRespEl = null;
  let accumulatedDeltaText = '';
  let lastObservedLen = 0;
  let settledSnapshot = null;
  let history = [];

  let settleTimer = null;
  let tickTimer = null;
  let clickHandler = null;
  let keyHandler = null;
  let docClickHandler = null;
  let resizeHandler = null;

  const hasExternalTelemetry = () =>
    Boolean(
      document.getElementById('ag-pulse-status-bar') ||
        document.getElementById('ag-live-metrics-pill'),
    );

  const findComposerElement = () =>
    document.getElementById('antigravity.agentSidePanelInputBox') ||
    document.querySelector('[data-testid="agent-input-box"]') ||
    document.querySelector('[data-testid="send-button"]');

  const isVisibleElement = (el) => {
    if (!el || el.isConnected === false) return false;
    if (el.closest && el.closest('[hidden], [inert], [role="dialog"], [aria-modal="true"]')) {
      return false;
    }
    return true;
  };

  const isBrowserHoleActive = () =>
    Boolean(
      document.body &&
        (document.body.getAttribute('data-has-browser-hole') === 'true' ||
          document.body.getAttribute('data-has-drawer-browser-hole') === 'true'),
    );

  const getStageRoot = () =>
    document.querySelector('[data-dxl-stage="conversation"]') ||
    document.querySelector('[data-testid="conversation-view"]') ||
    document.body;

  const getUserSteps = () => {
    const root = getStageRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll('[data-testid="user-input-step"]')).filter(isVisibleElement);
  };

  const getAssistantBlocks = () => {
    const root = getStageRoot();
    if (!root) return [];
    const selector = '[data-testid="planner-response-text"], [data-testid="agent-response"]';
    const blocks = Array.from(root.querySelectorAll(selector)).filter((el) => {
      if (!isVisibleElement(el)) return false;
      if (el.closest && el.closest('.bg-sidebar, [data-testid="user-input-step"]')) return false;
      return true;
    });
    if (blocks.length > 0) return blocks;
    return Array.from(root.querySelectorAll('[data-markdown-root]')).filter((el) => {
      if (!isVisibleElement(el)) return false;
      if (el.closest && el.closest('.bg-sidebar, [data-testid="user-input-step"]')) return false;
      return true;
    });
  };

  const getLatestAssistantBlock = () => {
    const list = getAssistantBlocks();
    return list.length > 0 ? list[list.length - 1] : null;
  };

  const clearTimers = () => {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  const captureBaseline = () => {
    baselineUserCount = getUserSteps().length;
    baselineRespEl = getLatestAssistantBlock();
    baselineRespLen = baselineRespEl ? (baselineRespEl.textContent || '').length : 0;
  };

  const getCurrentMetrics = () => {
    if (state === 'done' && settledSnapshot) {
      return settledSnapshot;
    }
    const deltaChars = accumulatedDeltaText.length;
    const deltaTokens = estTokens(accumulatedDeltaText);
    const effectiveEnd =
      state === 'waiting'
        ? now()
        : lastDeltaAt ?? now();
    const metrics = calcMetrics({
      startedAt: turnStartedAt,
      firstDeltaAt,
      lastDeltaAt: state === 'waiting' ? effectiveEnd : lastDeltaAt,
      deltaChars,
      deltaTokens,
    });
    return {
      state,
      ...metrics,
    };
  };

  const renderPopoverDom = (popover, snap) => {
    const fmtNum = (val, unit = '') =>
      typeof val === 'number' && Number.isFinite(val) ? `${val}${unit}` : '—';
    const fmtSec = (ms) =>
      typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '—';

    const makeEl = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.setAttribute('class', className);
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    };

    const stateMap = {
      idle: '待机中',
      waiting: '等待首字响应…',
      streaming: '正在流式输出…',
      done: '本轮已完成',
    };
    const rateVal =
      typeof snap.tokPerSec === 'number'
        ? `~${snap.tokPerSec.toFixed(1)} tok/s${typeof snap.charsPerSec === 'number' ? ` (${Math.round(snap.charsPerSec)} 字/s)` : ''}`
        : typeof snap.charsPerSec === 'number'
          ? `${Math.round(snap.charsPerSec)} 字/s`
          : '—';

    const rows = [
      ['状态', stateMap[snap.state] || '待机中'],
      ['渲染估算速率', rateVal],
      ['首响耗时 (TTFT)', fmtSec(snap.ttftMs)],
      ['输出量', snap.deltaChars > 0 ? `${snap.deltaChars} 字 · ~${fmtNum(snap.deltaTokens, ' tok')}` : '—'],
      ['输出总耗时', fmtSec(snap.totalMs)],
    ];

    popover.textContent = '';

    const head = makeEl('div', 'dxl-pulse-pop-head');
    head.appendChild(makeEl('span', '', '冬雪莲 · 生成脉搏'));
    const resetBtn = makeEl('button', '', '重置');
    resetBtn.id = 'dxl-pulse-reset';
    resetBtn.type = 'button';
    resetBtn.setAttribute('type', 'button');
    head.appendChild(resetBtn);
    popover.appendChild(head);

    const grid = makeEl('div', 'dxl-pulse-pop-grid');
    for (const [k, v] of rows) {
      const rowEl = makeEl('div', 'dxl-pulse-kv');
      rowEl.appendChild(makeEl('span', '', k));
      rowEl.appendChild(makeEl('strong', '', v));
      grid.appendChild(rowEl);
    }
    popover.appendChild(grid);

    const histBox = makeEl('div', 'dxl-pulse-hist');
    if (history.length > 0) {
      for (let idx = 0; idx < history.length; idx += 1) {
        const item = history[idx];
        const rowEl = makeEl('div', 'dxl-pulse-hist-row');
        rowEl.appendChild(makeEl('span', '', `#${history.length - idx}`));
        const summary = `${
          typeof item.tokPerSec === 'number'
            ? `~${item.tokPerSec.toFixed(1)} tok/s`
            : `${item.deltaChars} 字`
        } · 首响 ${fmtSec(item.ttftMs)}`;
        rowEl.appendChild(makeEl('span', '', summary));
        histBox.appendChild(rowEl);
      }
    } else {
      histBox.appendChild(makeEl('div', 'dxl-pulse-hist-empty', '发送消息后将记录最近 5 轮速率'));
    }
    popover.appendChild(histBox);
    popover.appendChild(makeEl('div', 'dxl-pulse-foot', '基于页面 DOM 渲染增量估算 · 零外部服务探测'));
    return resetBtn;
  };

  const ensureUi = () => {
    if (!document.body) return null;
    let wrap = document.getElementById(WRAP_ID);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = WRAP_ID;
      wrap.setAttribute('data-dxl-pulse', 'true');

      const popover = document.createElement('div');
      popover.id = POPOVER_ID;
      popover.setAttribute('class', 'text-xs');
      popover.setAttribute('data-dxl-pulse-popover', 'true');
      popover.setAttribute('hidden', 'true');

      const pill = document.createElement('button');
      pill.id = PILL_ID;
      pill.type = 'button';
      pill.setAttribute('type', 'button');
      pill.setAttribute('class', 'text-xs');
      pill.setAttribute('aria-expanded', 'false');
      pill.setAttribute('title', '冬雪莲前端输出流速统计（点击展开详情）');

      const dot = document.createElement('span');
      dot.setAttribute('class', 'dxl-pulse-dot');
      const labelEl = document.createElement('span');
      labelEl.setAttribute('class', 'dxl-pulse-label');
      labelEl.textContent = '冬雪莲 · 脉搏';

      pill.appendChild(dot);
      pill.appendChild(labelEl);
      wrap.appendChild(popover);
      wrap.appendChild(pill);
      document.body.appendChild(wrap);

      pill.addEventListener?.('click', (evt) => {
        evt?.stopPropagation?.();
        popoverOpen = !popoverOpen;
        render();
      });
    }
    return wrap;
  };

  const syncPosition = (wrap) => {
    if (!wrap || !wrap.style) return;
    const composer =
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="agent-input-box"]');
    if (composer && typeof composer.getBoundingClientRect === 'function') {
      const rect = composer.getBoundingClientRect();
      if (
        rect &&
        rect.width > 120 &&
        rect.height > 20 &&
        typeof window !== 'undefined' &&
        typeof window.innerWidth === 'number'
      ) {
        const rightPx = Math.max(12, Math.round(window.innerWidth - rect.right));
        const spaceBelow =
          (typeof window.innerHeight === 'number' ? window.innerHeight : 800) - rect.bottom;
        const nextBottom = spaceBelow >= 34 ? `${Math.max(6, Math.round(spaceBelow - 28))}px` : '10px';
        const nextRight = `${rightPx}px`;
        if (wrap.style.right !== nextRight) wrap.style.right = nextRight;
        if (wrap.style.bottom !== nextBottom) wrap.style.bottom = nextBottom;
        return;
      }
    }
    if (wrap.style.right !== '18px') wrap.style.right = '18px';
    if (wrap.style.bottom !== '10px') wrap.style.bottom = '10px';
  };

  const render = () => {
    const wrap = ensureUi();
    if (!wrap) return;

    const composerPresent = Boolean(
      findComposerElement() || document.querySelector('[data-dxl-stage="conversation"]'),
    );
    const yielded = hasExternalTelemetry() || isBrowserHoleActive() || !composerPresent;
    if (yielded) {
      if (wrap.getAttribute('data-dxl-pulse-yielded') !== 'true') {
        wrap.setAttribute('data-dxl-pulse-yielded', 'true');
      }
      if (!wrap.hasAttribute('hidden')) {
        wrap.setAttribute('hidden', 'true');
      }
      popoverOpen = false;
      return;
    }
    if (wrap.hasAttribute('data-dxl-pulse-yielded')) {
      wrap.removeAttribute('data-dxl-pulse-yielded');
    }
    if (wrap.hasAttribute('hidden')) {
      wrap.removeAttribute('hidden');
    }

    syncPosition(wrap);

    const snap = getCurrentMetrics();
    if (wrap.getAttribute('data-dxl-pulse-state') !== snap.state) {
      wrap.setAttribute('data-dxl-pulse-state', snap.state);
    }

    const pill = document.getElementById(PILL_ID);
    const popover = document.getElementById(POPOVER_ID);
    if (pill) {
      const labelEl = pill.querySelector('.dxl-pulse-label');
      const nextText = formatLabel(snap);
      if (labelEl && labelEl.textContent !== nextText) {
        labelEl.textContent = nextText;
      }
      pill.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
    }
    if (popover) {
      if (popoverOpen) {
        popover.removeAttribute('hidden');
        const resetBtn = renderPopoverDom(popover, snap);
        resetBtn?.addEventListener?.('click', (evt) => {
          evt?.stopPropagation?.();
          history = [];
          settledSnapshot = null;
          if (state === 'done') state = 'idle';
          render();
        });
      } else {
        popover.setAttribute('hidden', 'true');
      }
    }
  };

  const finalizeTurn = () => {
    clearTimers();
    if (state === 'idle' || state === 'done') return;

    const snap = getCurrentMetrics();
    if (snap.deltaChars >= 4) {
      settledSnapshot = { ...snap, state: 'done' };
      history.unshift(settledSnapshot);
      if (history.length > MAX_HISTORY) {
        history.length = MAX_HISTORY;
      }
      state = 'done';
    } else {
      settledSnapshot = null;
      state = 'idle';
    }
    captureBaseline();
    render();
  };

  const scheduleSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(finalizeTurn, TURN_SETTLE_MS);
  };

  const startLiveTick = () => {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (state === 'waiting' || state === 'streaming') {
        render();
      } else {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }, 250);
  };

  const beginWaitingTurn = ({ withTtf = true } = {}) => {
    if (hasExternalTelemetry()) return;
    clearTimers();
    captureBaseline();
    state = 'waiting';
    turnStartedAt = withTtf ? now() : null;
    firstDeltaAt = null;
    lastDeltaAt = null;
    activeRespEl = null;
    turnStartTextLen = 0;
    accumulatedDeltaText = '';
    lastObservedLen = 0;
    settledSnapshot = null;
    startLiveTick();
    scheduleSettle();
    render();
  };

  const syncDom = () => {
    if (!started || !document.body) return;
    const currentPath = getPath();
    if (currentPath !== lastPath) {
      lastPath = currentPath;
      cooldownUntil = now() + ROUTE_COOLDOWN_MS;
      clearTimers();
      state = 'idle';
      settledSnapshot = null;
      captureBaseline();
      render();
      return;
    }

    if (hasExternalTelemetry()) {
      if (state === 'waiting' || state === 'streaming') {
        clearTimers();
        state = 'idle';
      }
      render();
      return;
    }

    const t = now();
    const userCount = getUserSteps().length;
    const latestResp = getLatestAssistantBlock();
    const latestText = latestResp ? latestResp.textContent || '' : '';
    const latestLen = latestText.length;

    if (t < cooldownUntil) {
      captureBaseline();
      render();
      return;
    }

    // 切换对话时 React 一次性整树替换，避免把整段历史误算为输出速率
    if ((state === 'idle' || state === 'done') && Math.abs(userCount - baselineUserCount) > 1) {
      captureBaseline();
      render();
      return;
    }

    if ((state === 'idle' || state === 'done') && userCount === baselineUserCount + 1) {
      clearTimers();
      baselineUserCount = userCount;
      state = 'waiting';
      turnStartedAt = t;
      firstDeltaAt = null;
      lastDeltaAt = null;
      activeRespEl = null;
      turnStartTextLen = 0;
      accumulatedDeltaText = '';
      lastObservedLen = 0;
      settledSnapshot = null;
      startLiveTick();
      scheduleSettle();
    } else if ((state === 'waiting' || state === 'streaming') && userCount > baselineUserCount) {
      baselineUserCount = userCount;
    }

    if (state === 'waiting') {
      const switchedToNewBlock = latestResp && latestResp !== baselineRespEl && latestLen > 0;
      const grewSameBlock = latestResp && latestResp === baselineRespEl && latestLen > baselineRespLen;
      if (switchedToNewBlock || grewSameBlock) {
        activeRespEl = latestResp;
        turnStartTextLen = switchedToNewBlock ? 0 : baselineRespLen;
        accumulatedDeltaText = latestText.slice(turnStartTextLen);
        lastObservedLen = latestLen;
        firstDeltaAt = t;
        lastDeltaAt = t;
        state = 'streaming';
        scheduleSettle();
        render();
        return;
      }
    } else if (state === 'streaming') {
      if (latestResp === activeRespEl && latestLen > lastObservedLen) {
        accumulatedDeltaText = latestText.slice(turnStartTextLen);
        lastObservedLen = latestLen;
        lastDeltaAt = t;
        scheduleSettle();
        render();
        return;
      }
      if (latestResp && latestResp !== activeRespEl && latestLen > 0 && latestLen < 1200) {
        // 工具调用之后切换到了新回复段落，平滑续算本轮增量
        activeRespEl = latestResp;
        turnStartTextLen = 0;
        accumulatedDeltaText += `\n${latestText}`;
        lastObservedLen = latestLen;
        lastDeltaAt = t;
        scheduleSettle();
        render();
        return;
      }
    } else if (
      (state === 'idle' || state === 'done') &&
      latestResp &&
      latestResp === baselineRespEl &&
      latestLen > baselineRespLen &&
      latestLen - baselineRespLen <= 400
    ) {
      // 兜底捕获未经过发送按钮点击的新生成流（不伪造 TTFT）
      clearTimers();
      state = 'streaming';
      turnStartedAt = null;
      firstDeltaAt = t;
      lastDeltaAt = t;
      activeRespEl = latestResp;
      turnStartTextLen = baselineRespLen;
      accumulatedDeltaText = latestText.slice(turnStartTextLen);
      lastObservedLen = latestLen;
      settledSnapshot = null;
      startLiveTick();
      scheduleSettle();
      render();
      return;
    }

    if (state === 'idle' || state === 'done') {
      baselineUserCount = userCount;
      baselineRespEl = latestResp;
      baselineRespLen = latestLen;
    }
    render();
  };

  const attachInputListeners = () => {
    if (!document.addEventListener || clickHandler) return;
    clickHandler = (evt) => {
      const target = evt?.target;
      const sendBtn = target?.closest?.('[data-testid="send-button"]');
      if (sendBtn && !sendBtn.disabled) {
        beginWaitingTurn({ withTtf: true });
      }
    };
    keyHandler = (evt) => {
      if (!evt || evt.key !== 'Enter' || evt.shiftKey || evt.ctrlKey || evt.altKey || evt.metaKey || evt.isComposing) {
        return;
      }
      const inComposer = evt.target?.closest?.('#antigravity\\.agentSidePanelInputBox, [data-testid="agent-input-box"]');
      if (inComposer) {
        beginWaitingTurn({ withTtf: true });
      }
    };
    docClickHandler = (evt) => {
      if (!popoverOpen) return;
      const wrap = document.getElementById(WRAP_ID);
      if (!wrap) return;
      let inside = false;
      if (typeof wrap.contains === 'function') {
        inside = wrap.contains(evt?.target);
      } else {
        let cur = evt?.target;
        while (cur) {
          if (cur === wrap) {
            inside = true;
            break;
          }
          cur = cur.parentElement || cur.parentNode || null;
        }
      }
      if (!inside) {
        popoverOpen = false;
        render();
      }
    };
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keyHandler, true);
    document.addEventListener('click', docClickHandler, false);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      resizeHandler = () => {
        const wrap = document.getElementById(WRAP_ID);
        if (wrap) syncPosition(wrap);
      };
      window.addEventListener('resize', resizeHandler);
    }
  };

  const ensureStarted = () => {
    if (!document.body) return;
    if (!started) {
      started = true;
      cooldownUntil = now() + 300;
      captureBaseline();
      attachInputListeners();
    }
    syncDom();
  };

  const stop = () => {
    started = false;
    clearTimers();
    if (document.removeEventListener) {
      if (clickHandler) document.removeEventListener('click', clickHandler, true);
      if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
      if (docClickHandler) document.removeEventListener('click', docClickHandler, false);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function' && resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
    }
    clickHandler = null;
    keyHandler = null;
    docClickHandler = null;
    resizeHandler = null;
  };

  return {
    ensureStarted,
    syncDom,
    stop,
    getSnapshot: getCurrentMetrics,
  };
}
