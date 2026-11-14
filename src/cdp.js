import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 根据操作系统与环境变量推导 Antigravity 的 `DevToolsActivePort` 路径。
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {string}
 */
export function getPortFilePath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Antigravity', 'DevToolsActivePort');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'Antigravity', 'DevToolsActivePort');
}

/**
 * 校验端口号是否合法。
 * @param {number|string} value
 * @returns {number}
 */
export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效的调试端口号：${value}`);
  }
  return port;
}

/**
 * 从 `DevToolsActivePort` 文件或显式参数读取 CDP 调试端口。
 * @param {string} [portFile]
 * @param {object} [options]
 * @param {number|string} [options.port]
 * @returns {number}
 */
export function readPort(portFile = getPortFilePath(), options = {}) {
  if (options?.port !== undefined && options?.port !== null) {
    return validatePort(options.port);
  }
  if (!existsSync(portFile)) {
    throw new Error(
      `未找到 DevToolsActivePort 文件：${portFile}。请确认 Antigravity 桌面端已启动，或通过 --port <端口> 手动指定。`,
    );
  }
  const raw = readFileSync(portFile, 'utf8');
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    throw new Error(`DevToolsActivePort 文件为空：${portFile}`);
  }
  return validatePort(firstLine);
}

/**
 * 查询本地 CDP `/json/list`，仅保留可注入的前端页面目标。
 * @param {number} port
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Array<{id: string, type: string, title?: string, url?: string, webSocketDebuggerUrl: string}>>}
 */
export async function listPages(port, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const validPort = validatePort(port);
  const url = `http://127.0.0.1:${validPort}/json/list`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`无法连接本地 CDP 接口 ${url}：${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`CDP /json/list 返回异常状态码：${response.status}`);
  }
  const list = await response.json();
  if (!Array.isArray(list)) {
    throw new Error('CDP /json/list 返回格式不是数组');
  }
  return list.filter((item) => {
    if (!item || item.type !== 'page') {
      return false;
    }
    if (typeof item.webSocketDebuggerUrl !== 'string' || !item.webSocketDebuggerUrl) {
      return false;
    }
    const pageUrl = String(item.url || '');
    return !pageUrl.startsWith('devtools://') && !pageUrl.startsWith('data:');
  });
}

async function decodeWsData(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof data.text === 'function') {
    return data.text();
  }
  return String(data);
}

/**
 * 基于 Node 原生 `WebSocket` 的轻量 CDP 会话客户端，零第三方依赖。
 */
export class CdpSession {
  /**
   * @param {string} wsUrl
   * @param {object} [options]
   * @param {typeof WebSocket} [options.WebSocketImpl]
   * @param {number} [options.timeoutMs]
   */
  constructor(wsUrl, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5000 } = {}) {
    if (typeof WebSocketImpl !== 'function') {
      throw new Error('当前 Node 运行时缺少内置 WebSocket，请升级至 Node.js >= 22');
    }
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  /**
   * 建立 WebSocket 连接并开始监听响应与事件。
   * @returns {Promise<this>}
   */
  async connect() {
    if (this.ws && this.ws.readyState === 1) {
      return this;
    }
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.wsUrl);
      this.ws = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // 忽略关闭异常
          }
          reject(new Error(`连接 CDP WebSocket 超时（${this.timeoutMs}ms）：${this.wsUrl}`));
        }
      }, this.timeoutMs);

      ws.addEventListener('open', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      });

      ws.addEventListener('error', (event) => {
        const reason = event?.message || event?.error?.message || 'WebSocket 连接失败';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 错误：${reason}`));
        }
      });

      ws.addEventListener('message', (event) => {
        void this.#handleMessage(event.data);
      });

      ws.addEventListener('close', () => {
        this.closed = true;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`CDP WebSocket 连接在就绪前关闭：${this.wsUrl}`));
        }
        for (const [id, entry] of this.pending.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`CDP 会话已关闭（未完成请求 #${id}: ${entry.method}）`));
        }
        this.pending.clear();
        this.#emit('close', {});
      });
    });
  }

  async #handleMessage(rawData) {
    let payload;
    try {
      const text = await decodeWsData(rawData);
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (payload.id !== undefined) {
      const entry = this.pending.get(payload.id);
      if (!entry) {
        return;
      }
      this.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.error) {
        const msg = payload.error.message || '未知 CDP 错误';
        const code = payload.error.code !== undefined ? ` (${payload.error.code})` : '';
        entry.reject(new Error(`${entry.method} 失败${code}：${msg}`));
      } else {
        entry.resolve(payload.result ?? {});
      }
      return;
    }

    if (payload.method) {
      this.#emit(payload.method, payload.params ?? {});
      this.#emit('*', { method: payload.method, params: payload.params ?? {} });
    }
  }

  #emit(eventName, detail) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) {
      return;
    }
    for (const fn of handlers) {
      try {
        fn(detail);
      } catch {
        // 事件回调异常不影响会话主循环
      }
    }
  }

  /**
   * 订阅 CDP 事件或 `close` 事件。
   * @param {string} eventName
   * @param {(detail: any) => void} handler
   * @returns {() => void}
   */
  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    const set = this.listeners.get(eventName);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * 发送 CDP 命令并等待响应。
   * @param {string} method
   * @param {Record<string, any>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.ws || this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`CDP 会话未连接或已关闭，无法执行 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * 在页面上下文执行 JS 表达式并返回序列化值。
   * @param {string} expression
   * @param {object} [options]
   * @param {boolean} [options.awaitPromise]
   * @param {boolean} [options.returnByValue]
   * @returns {Promise<any>}
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
    });
    if (res?.exceptionDetails) {
      const ex = res.exceptionDetails;
      const detail = ex.exception?.description || ex.text || 'Runtime.evaluate 执行异常';
      throw new Error(detail);
    }
    return res?.result?.value;
  }

  /**
   * 关闭 WebSocket 连接。
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.ws || this.closed || this.ws.readyState >= 2) {
      this.closed = true;
      return;
    }
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.closed = true;
        resolve();
      };
      const timer = setTimeout(done, 400);
      this.ws.addEventListener('close', done, { once: true });
      try {
        this.ws.close(1000, 'dxl-theme-done');
      } catch {
        done();
      }
    });
  }
}

/**
 * 构建注入 Antigravity 页面的幂等运行时脚本。
 * 同时兼容 `Runtime.evaluate`（已加载 DOM）与 `Page.addScriptToEvaluateOnNewDocument`（document-start）。
 * @param {string} css
 * @param {object} [options]
 * @param {string} [options.avatarDataUri]
 * @param {boolean} [options.avatar]
 * @param {boolean} [options.shift]
 * @param {string} [options.version]
 * @returns {string}
 */
export function buildInjectScript(
  css,
  { avatarDataUri = '', avatar = true, shift = true, version = '0.1.0' } = {},
) {
  if (typeof css !== 'string' || !css.trim()) {
    throw new Error('CSS 内容不能为空');
  }
  const config = {
    styleId: 'dxl-antigravity-theme',
    cssText: css,
    avatarUri: avatar && avatarDataUri ? avatarDataUri : '',
    enableAvatar: Boolean(avatar && avatarDataUri),
    enableShift: Boolean(shift),
    version: String(version || '0.1.0'),
  };

  return `(() => {
  const CFG = ${JSON.stringify(config)};
  if (typeof window.__dxlCleanup === 'function') {
    try {
      window.__dxlCleanup();
    } catch {
      // 忽略旧清理句柄异常
    }
  }

  let observer = null;
  let rafId = 0;
  let rafPending = false;
  let mutating = false;
  let domListenerAttached = false;

  const isLightTheme = () => Boolean(document.body && document.body.classList.contains('theme-light'));

  const ensureStyle = () => {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    let styleEl = document.getElementById(CFG.styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = CFG.styleId;
      parent.appendChild(styleEl);
    }
    if (styleEl.textContent !== CFG.cssText) {
      styleEl.textContent = CFG.cssText;
    }
  };

  const syncHtmlAttributes = () => {
    const html = document.documentElement;
    if (!html) return;
    html.setAttribute('data-dxl-theme', CFG.version);
    if (CFG.enableShift) {
      html.removeAttribute('data-dxl-shift');
    } else {
      html.setAttribute('data-dxl-shift', 'off');
    }
  };

  const isExcludedRegion = (el) => {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (el.id === 'root') return true;
    return Boolean(
      el.closest('.bg-sidebar') ||
      el.closest('[role="dialog"]') ||
      el.closest('[aria-modal="true"]') ||
      el.closest('[data-testid="conversation-row-sidebar"]')
    );
  };

  const hasConversationContent = (el) => Boolean(
    el &&
    (el.querySelector('#antigravity\\\\.agentSidePanelInputBox') ||
      el.querySelector('[data-testid="send-button"]') ||
      el.querySelector('[data-testid="user-input-step"]') ||
      el.querySelector('[data-testid="planner-response-text"]'))
  );

  const findConversationStage = () => {
    const candidates = document.querySelectorAll('.outline-none[style*="container-type"] > div:first-child');
    for (const candidate of candidates) {
      if (!isExcludedRegion(candidate) && hasConversationContent(candidate)) {
        return candidate;
      }
    }

    const anchor =
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="planner-response-text"]') ||
      document.querySelector('[data-testid="user-input-step"]') ||
      document.querySelector('[data-testid="send-button"]');

    if (!anchor) return null;

    let current = anchor.parentElement;
    let best = null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.id === 'root') break;
      if (!isExcludedRegion(current) && !current.querySelector('.bg-sidebar')) {
        const styleAttr = current.getAttribute('style') || '';
        const cls = typeof current.className === 'string' ? current.className : '';
        if (
          styleAttr.includes('container-type') ||
          cls.includes('overflow-y-auto') ||
          cls.includes('flex-col')
        ) {
          best = current;
          if (current.parentElement?.classList?.contains('outline-none')) {
            return current;
          }
        }
      }
      current = current.parentElement;
    }
    return best;
  };

  const syncConversationMarkers = () => {
    const active = isLightTheme();
    const targetStage = active ? findConversationStage() : null;

    for (const el of document.querySelectorAll('[data-dxl-stage]')) {
      if (el !== targetStage) {
        el.removeAttribute('data-dxl-stage');
      }
    }

    const desiredTracks = new Set();
    if (targetStage) {
      targetStage.setAttribute('data-dxl-stage', 'conversation');
      const trackHooks = targetStage.querySelectorAll(
        '[data-testid="user-input-step"], [data-testid="planner-response-text"], #antigravity\\\\.agentSidePanelInputBox'
      );
      for (const hook of trackHooks) {
        let node = hook;
        while (node && node !== targetStage) {
          const parent = node.parentElement;
          const cls = typeof node.className === 'string' ? node.className : '';
          if (
            !isExcludedRegion(node) &&
            (cls.includes('mx-auto') || cls.includes('max-w-') || parent === targetStage)
          ) {
            desiredTracks.add(node);
            break;
          }
          node = parent;
        }
      }
    }

    for (const el of document.querySelectorAll('[data-dxl-reading-track]')) {
      if (!desiredTracks.has(el)) {
        el.removeAttribute('data-dxl-reading-track');
      }
    }
    for (const track of desiredTracks) {
      if (track !== targetStage) {
        track.setAttribute('data-dxl-reading-track', 'true');
      }
    }
  };

  const syncSidebarAvatar = () => {
    const existingList = Array.from(document.querySelectorAll('[data-dxl-avatar="true"]'));
    if (!CFG.enableAvatar || !isLightTheme()) {
      for (const node of existingList) {
        node.remove();
      }
      return;
    }

    const sidebar = document.querySelector('.bg-sidebar');
    if (!sidebar) {
      for (const node of existingList) {
        node.remove();
      }
      return;
    }

    const headerHost =
      sidebar.querySelector('[data-testid="sidebar-header"]') ||
      sidebar.firstElementChild ||
      sidebar;

    if (existingList.length === 1 && existingList[0].parentElement === headerHost) {
      return;
    }
    for (const node of existingList) {
      node.remove();
    }

    const badge = document.createElement('span');
    badge.setAttribute('data-dxl-avatar', 'true');
    badge.setAttribute('title', '冬雪莲主题（浅色模式）');

    const img = document.createElement('img');
    img.src = CFG.avatarUri;
    img.alt = '冬雪莲头像';
    img.width = 24;
    img.height = 24;
    img.draggable = false;

    badge.appendChild(img);
    headerHost.prepend(badge);
  };

  const applyAll = () => {
    if (mutating) return;
    mutating = true;
    try {
      ensureStyle();
      syncHtmlAttributes();
      syncConversationMarkers();
      syncSidebarAvatar();
    } finally {
      mutating = false;
    }
  };

  const scheduleApply = () => {
    if (rafPending) return;
    rafPending = true;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    const id = raf(() => {
      rafPending = false;
      rafId = 0;
      applyAll();
    });
    if (rafPending) {
      rafId = id;
    }
  };

  const ensureObserver = () => {
    const target = document.body || document.documentElement;
    if (!target) return;
    if (!observer && typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => {
        if (!mutating) {
          scheduleApply();
        }
      });
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  };

  const cleanup = () => {
    if (rafPending && rafId) {
      const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
      cancel(rafId);
    }
    rafPending = false;
    rafId = 0;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (domListenerAttached) {
      document.removeEventListener('DOMContentLoaded', onDomReady);
      domListenerAttached = false;
    }
    const styleEl = document.getElementById(CFG.styleId);
    if (styleEl) styleEl.remove();
    const html = document.documentElement;
    if (html) {
      html.removeAttribute('data-dxl-theme');
      html.removeAttribute('data-dxl-shift');
    }
    for (const el of document.querySelectorAll('[data-dxl-stage]')) {
      el.removeAttribute('data-dxl-stage');
    }
    for (const el of document.querySelectorAll('[data-dxl-reading-track]')) {
      el.removeAttribute('data-dxl-reading-track');
    }
    for (const el of document.querySelectorAll('[data-dxl-avatar]')) {
      el.remove();
    }
    if (window.__dxlCleanup === cleanup) {
      delete window.__dxlCleanup;
    }
  };

  const onDomReady = () => {
    applyAll();
    ensureObserver();
  };

  window.__dxlCleanup = cleanup;
  applyAll();
  ensureObserver();
  if (document.readyState === 'loading') {
    domListenerAttached = true;
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  }

  const conflicts = [];
  if (document.getElementById('ag-custom-fonts')) {
    conflicts.push('chuanban-antigravity-theme-patch');
  }

  return {
    injected: true,
    version: CFG.version,
    lightMode: isLightTheme(),
    hasStage: Boolean(document.querySelector('[data-dxl-stage="conversation"]')),
    hasAvatar: Boolean(document.querySelector('[data-dxl-avatar="true"]')),
    conflicts,
  };
})();`;
}

/**
 * 卸载脚本表达式：清理样式节点、观察器、舞台属性与侧边栏头像。
 */
export const REMOVE_EXPRESSION = `(() => {
  const removedStyle = document.getElementById('dxl-antigravity-theme') ? 1 : 0;
  const removedStage = document.querySelectorAll('[data-dxl-stage]').length;
  const removedTrack = document.querySelectorAll('[data-dxl-reading-track]').length;
  const removedAvatar = document.querySelectorAll('[data-dxl-avatar]').length;

  if (typeof window.__dxlCleanup === 'function') {
    try {
      window.__dxlCleanup();
    } catch {
      // 忽略清理回调中的异常并继续兜底清扫
    }
  }
  const styleEl = document.getElementById('dxl-antigravity-theme');
  if (styleEl) {
    styleEl.remove();
  }
  const html = document.documentElement;
  if (html) {
    html.removeAttribute('data-dxl-theme');
    html.removeAttribute('data-dxl-shift');
  }
  for (const el of document.querySelectorAll('[data-dxl-stage]')) {
    el.removeAttribute('data-dxl-stage');
  }
  for (const el of document.querySelectorAll('[data-dxl-reading-track]')) {
    el.removeAttribute('data-dxl-reading-track');
  }
  for (const el of document.querySelectorAll('[data-dxl-avatar]')) {
    el.remove();
  }
  delete window.__dxlCleanup;
  return {
    removed: true,
    removedStyle,
    removedStage,
    removedTrack,
    removedAvatar,
  };
})();`;
