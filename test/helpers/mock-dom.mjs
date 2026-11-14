import vm from 'node:vm';

const NodeFilter = {
  SHOW_ALL: -1,
  SHOW_ELEMENT: 1,
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
};

/**
 * 极简内存文本节点实现，配合 `MockElement` 与 `createTreeWalker` 测试文本汉化与还原。
 */
export class MockTextNode {
  constructor(value = '') {
    this.nodeType = 3;
    this.nodeValue = String(value);
    this.parentElement = null;
  }

  get parentNode() {
    return this.parentElement;
  }

  get isConnected() {
    let cur = this;
    while (cur.parentElement) {
      cur = cur.parentElement;
    }
    return cur.tagName === 'HTML';
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
    this.parentElement = null;
  }
}

/**
 * 极简内存 DOM 实现，用于在 `node:vm` 中真实执行 `buildInjectScript` 与 `REMOVE_EXPRESSION`，
 * 验证样式标签、浅/深色切换、对话舞台定位、弹窗排除、界面汉化与彻底清理，不依赖任何第三方 DOM 库。
 */
export class MockElement {
  constructor(tagName, attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentElement = null;
    this._textContent = '';
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

  get parentNode() {
    return this.parentElement;
  }

  get isConnected() {
    let cur = this;
    while (cur.parentElement) {
      cur = cur.parentElement;
    }
    return cur.tagName === 'HTML';
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get textContent() {
    if (this.childNodes.length === 0) {
      return this._textContent;
    }
    return this.childNodes
      .map((node) => (node.nodeType === 3 ? node.nodeValue : node.textContent))
      .join('');
  }

  set textContent(val) {
    for (const child of this.childNodes) {
      child.parentElement = null;
    }
    this.childNodes = [];
    this._textContent = String(val ?? '');
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    if (child.parentElement) {
      child.remove();
    }
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  prepend(child) {
    if (child.parentElement) {
      child.remove();
    }
    child.parentElement = this;
    this.childNodes.unshift(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
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

  matches(selector) {
    const parts = splitSelectorList(selector);
    return parts.some((sel) => matchesComplexSelector(this, sel, this));
  }

  closest(selector) {
    const parts = splitSelectorList(selector);
    let cur = this;
    while (cur) {
      if (parts.some((sel) => matchesComplexSelector(cur, sel, cur))) return cur;
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
        if (parts.some((sel) => matchesComplexSelector(child, sel, this)) && !seen.has(child)) {
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
  const parts = [];
  let cur = '';
  let bracketDepth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      cur += ch;
      if (ch === quote && selector[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[') {
      bracketDepth += 1;
      cur += ch;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      cur += ch;
    } else if (ch === ',' && bracketDepth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function matchSingleAtom(el, atom, scopeEl = null) {
  if (atom === ':scope') return el === scopeEl;
  if (atom === ':first-child') {
    return el.parentElement?.firstElementChild === el;
  }
  if (atom.startsWith('#')) {
    return el.id === atom.slice(1).replace(/\\\./g, '.');
  }
  if (atom.startsWith('.')) {
    return el.classList.contains(atom.slice(1));
  }
  const attrMatch = atom.match(/^\[([a-zA-Z0-9_-]+)(?:(=|\^=|\*=)"([^"]*)")?\]$/);
  if (attrMatch) {
    const [, attrName, op, expected] = attrMatch;
    const actual = el.getAttribute(attrName);
    if (actual === null) return false;
    if (!op) return true;
    if (op === '=') return actual === expected;
    if (op === '^=') return actual.startsWith(expected);
    if (op === '*=') return actual.includes(expected);
    return false;
  }
  return el.tagName === atom.toUpperCase();
}

function matchesSimpleSelector(el, token, scopeEl = null) {
  if (!el || el.nodeType !== 1) return false;
  const normalized = token.replace(/\\\\\./g, '\\.');
  if (normalized === ':scope') return el === scopeEl;
  if (normalized === '#antigravity\\.agentSidePanelInputBox') {
    return el.id === 'antigravity.agentSidePanelInputBox';
  }
  const atoms = [];
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '[') {
      const close = normalized.indexOf(']', i);
      if (close === -1) return false;
      atoms.push(normalized.slice(i, close + 1));
      i = close + 1;
    } else if (ch === ':' && normalized.startsWith(':first-child', i)) {
      atoms.push(':first-child');
      i += ':first-child'.length;
    } else if (ch === '.' || ch === '#') {
      let j = i + 1;
      while (j < normalized.length && !'.#[:'.includes(normalized[j])) {
        j += 1;
      }
      atoms.push(normalized.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < normalized.length && !'.#[:'.includes(normalized[j])) {
        j += 1;
      }
      atoms.push(normalized.slice(i, j));
      i = j;
    }
  }
  return atoms.length > 0 && atoms.every((atom) => matchSingleAtom(el, atom, scopeEl));
}

function tokenizeSelector(selector) {
  const tokens = [];
  let current = '';
  let bracketDepth = 0;
  let quote = '';
  for (const ch of selector.trim()) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '[') {
      bracketDepth += 1;
      current += ch;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += ch;
    } else if (bracketDepth === 0 && (ch === '>' || /\s/.test(ch))) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      if (ch === '>') {
        if (tokens[tokens.length - 1] === ' ') tokens.pop();
        if (tokens[tokens.length - 1] !== '>') tokens.push('>');
      } else if (
        tokens.length > 0 &&
        tokens[tokens.length - 1] !== '>' &&
        tokens[tokens.length - 1] !== ' '
      ) {
        tokens.push(' ');
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  while (tokens[tokens.length - 1] === ' ') tokens.pop();
  return tokens;
}

function matchTokensFromRight(el, tokens, idx, scopeEl) {
  if (!matchesSimpleSelector(el, tokens[idx], scopeEl)) return false;
  if (idx === 0) return true;
  const comb = tokens[idx - 1];
  if (comb === '>') {
    return Boolean(el.parentElement) && matchTokensFromRight(el.parentElement, tokens, idx - 2, scopeEl);
  }
  let anc = el.parentElement;
  while (anc) {
    if (matchTokensFromRight(anc, tokens, idx - 2, scopeEl)) return true;
    anc = anc.parentElement;
  }
  return false;
}

function matchesComplexSelector(el, selector, scopeEl = null) {
  const tokens = tokenizeSelector(selector);
  if (tokens.length === 0) return false;
  return matchTokensFromRight(el, tokens, tokens.length - 1, scopeEl);
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
    createTextNode: (text) => new MockTextNode(text),
    createTreeWalker: (rootNode, whatToShow = NodeFilter.SHOW_ALL, filter = null) => {
      const collect = (node, out) => {
        if (!node || !Array.isArray(node.childNodes)) return;
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          const typeMatches =
            whatToShow === NodeFilter.SHOW_ALL ||
            (child.nodeType === 1 && (whatToShow & NodeFilter.SHOW_ELEMENT) !== 0) ||
            (child.nodeType === 3 && (whatToShow & NodeFilter.SHOW_TEXT) !== 0);

          let verdict = NodeFilter.FILTER_ACCEPT;
          if (!typeMatches) {
            verdict = NodeFilter.FILTER_SKIP;
          } else if (filter && typeof filter.acceptNode === 'function') {
            verdict = filter.acceptNode(child);
          }

          if (verdict === NodeFilter.FILTER_REJECT) {
            continue;
          }
          if (verdict === NodeFilter.FILTER_ACCEPT) {
            out.push(child);
          }
          if (child.nodeType === 1) {
            collect(child, out);
          }
        }
      };

      let list = null;
      let idx = -1;
      const walker = {
        currentNode: rootNode,
        nextNode() {
          if (list === null) {
            list = [];
            collect(rootNode, list);
          }
          idx += 1;
          if (idx >= list.length) {
            return null;
          }
          walker.currentNode = list[idx];
          return walker.currentNode;
        },
      };
      return walker;
    },
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
    NodeFilter,
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
