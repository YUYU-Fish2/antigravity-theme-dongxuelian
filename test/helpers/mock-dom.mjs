import vm from 'node:vm';

/**
 * 极简内存 DOM 实现，用于在 `node:vm` 中真实执行 `buildInjectScript` 与 `REMOVE_EXPRESSION`，
 * 验证样式标签、浅/深色切换、对话舞台定位、弹窗排除与彻底清理，不依赖任何第三方 DOM 库。
 */
export class MockElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.src = '';
    this.alt = '';
    this.width = 0;
    this.height = 0;
    this.draggable = true;
    this.classList = createClassList(this);

    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'className' || key === 'class') {
        this.setAttribute('class', val);
      } else {
        this.setAttribute(key, String(val));
      }
    }
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(val) {
    this.setAttribute('id', String(val));
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(val) {
    this.setAttribute('class', String(val));
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    if (child.parentElement) {
      child.remove();
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    if (child.parentElement) {
      child.remove();
    }
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSimpleSelector(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const parts = splitSelectorList(selector);
    const seen = new Set();
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (parts.some((sel) => matchesComplexSelector(child, sel)) && !seen.has(child)) {
          seen.add(child);
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

function createClassList(el) {
  const getTokens = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  return {
    contains: (token) => getTokens().includes(token),
    add: (...tokens) => {
      const set = new Set(getTokens());
      for (const t of tokens) set.add(t);
      el.setAttribute('class', Array.from(set).join(' '));
    },
    remove: (...tokens) => {
      const next = getTokens().filter((t) => !tokens.includes(t));
      el.setAttribute('class', next.join(' '));
    },
  };
}

function splitSelectorList(selector) {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesSimpleSelector(el, token) {
  const normalized = token.replace(/\\\\\./g, '\\.');
  if (normalized === '.bg-sidebar') return el.classList.contains('bg-sidebar');
  if (normalized === '.outline-none') return el.classList.contains('outline-none');
  if (normalized === '.outline-none[style*="container-type"]') {
    return (
      el.classList.contains('outline-none') &&
      (el.getAttribute('style') || '').includes('container-type')
    );
  }
  if (normalized === 'div:first-child') {
    return el.tagName === 'DIV' && el.parentElement?.firstElementChild === el;
  }
  if (normalized === '#antigravity\\.agentSidePanelInputBox') {
    return el.id === 'antigravity.agentSidePanelInputBox';
  }
  const attrEq = normalized.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
  if (attrEq) {
    return el.getAttribute(attrEq[1]) === attrEq[2];
  }
  const attrPresent = normalized.match(/^\[([a-zA-Z0-9_-]+)\]$/);
  if (attrPresent) {
    return el.hasAttribute(attrPresent[1]);
  }
  if (normalized.startsWith('.')) {
    return el.classList.contains(normalized.slice(1));
  }
  return el.tagName === normalized.toUpperCase();
}

function matchesComplexSelector(el, selector) {
  const parts = selector.split(/\s*>\s*/);
  if (parts.length === 1) {
    return matchesSimpleSelector(el, parts[0]);
  }
  if (parts.length === 2) {
    return (
      matchesSimpleSelector(el, parts[1]) &&
      Boolean(el.parentElement) &&
      matchesSimpleSelector(el.parentElement, parts[0])
    );
  }
  return false;
}

/**
 * 构造仿 Antigravity DOM 树与隔离 `vm` 上下文。
 * @param {object} [options]
 * @param {boolean} [options.light]
 */
export function createMockAntigravityPage({ light = true } = {}) {
  const observers = [];
  const docEl = new MockElement('html');
  const head = new MockElement('head');
  const body = new MockElement('body', { class: light ? 'theme-light' : 'theme-dark' });
  docEl.appendChild(head);
  docEl.appendChild(body);

  const root = new MockElement('div', { id: 'root' });
  const sidebar = new MockElement('div', { class: 'bg-sidebar' });
  const sidebarHeader = new MockElement('div', { 'data-testid': 'sidebar-header' });
  const sidebarRow = new MockElement('div', { 'data-testid': 'conversation-row-sidebar' });
  sidebar.appendChild(sidebarHeader);
  sidebar.appendChild(sidebarRow);

  const shell = new MockElement('div', {
    class: 'outline-none',
    style: 'container-type: inline-size',
  });
  const stage = new MockElement('div', { class: 'flex-col overflow-y-auto' });
  const userTrack = new MockElement('div', { class: 'mx-auto max-w-3xl' });
  const userStep = new MockElement('div', { 'data-testid': 'user-input-step' });
  userTrack.appendChild(userStep);

  const replyTrack = new MockElement('div', { class: 'mx-auto max-w-3xl' });
  const replyText = new MockElement('div', { 'data-testid': 'planner-response-text' });
  replyTrack.appendChild(replyText);

  const composerTrack = new MockElement('div', { class: 'mx-auto max-w-3xl' });
  const inputBox = new MockElement('div', { id: 'antigravity.agentSidePanelInputBox' });
  const sendBtn = new MockElement('button', { 'data-testid': 'send-button' });
  inputBox.appendChild(sendBtn);
  composerTrack.appendChild(inputBox);

  stage.appendChild(userTrack);
  stage.appendChild(replyTrack);
  stage.appendChild(composerTrack);
  shell.appendChild(stage);

  const dialog = new MockElement('div', { role: 'dialog', 'aria-modal': 'true' });
  const dialogText = new MockElement('div', { 'data-testid': 'planner-response-text' });
  dialog.appendChild(dialogText);

  root.appendChild(sidebar);
  root.appendChild(shell);
  root.appendChild(dialog);
  body.appendChild(root);

  const document = {
    readyState: 'complete',
    documentElement: docEl,
    head,
    body,
    createElement: (tag) => new MockElement(tag),
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
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.connected = false;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
    trigger() {
      if (this.connected) {
        this.cb([]);
      }
    }
  }

  const windowObj = {
    document,
    MutationObserver: MockMutationObserver,
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  const sandbox = vm.createContext({
    window: windowObj,
    document,
    MutationObserver: MockMutationObserver,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  });

  return {
    document,
    window: windowObj,
    elements: { docEl, head, body, sidebar, sidebarHeader, stage, userTrack, replyTrack, composerTrack, dialog, dialogText },
    observers,
    evaluate: (expression) => vm.runInContext(expression, sandbox),
  };
}
