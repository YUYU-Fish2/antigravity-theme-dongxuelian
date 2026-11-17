import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveRootDir(rootDir) {
  if (rootDir instanceof URL) {
    return fileURLToPath(rootDir);
  }
  return rootDir ? String(rootDir) : DEFAULT_ROOT;
}

export const DEFAULT_I18N_RELATIVE_PATH = 'assets/i18n/zh-CN.json';
export const DEFAULT_OVERRIDE_RELATIVE_PATH = 'user/i18n.override.json';

function readJsonFile(filePath, label) {
  let rawText;
  try {
    rawText = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new Error(`读取${label}失败（${filePath}）：${err.message}`);
  }
  try {
    return JSON.parse(rawText);
  } catch (err) {
    throw new Error(`解析${label} JSON 失败（${filePath}）：${err.message}`);
  }
}

/**
 * 规范化汉化词典或用户覆盖 JSON，支持顶层扁平映射与 `{ exact: {...} }` 写法。
 * 自动跳过以 `_` 开头的注释字段，仅保留字符串词条。
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {Record<string, string>}
 */
export function normalizeOverrideDict(raw, label = '汉化覆盖词典') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  const hasExact = Object.prototype.hasOwnProperty.call(raw, 'exact');
  let source = raw;
  if (hasExact) {
    if (!raw.exact || typeof raw.exact !== 'object' || Array.isArray(raw.exact)) {
      throw new Error(`${label}中的 exact 字段必须是 JSON 对象`);
    }
    source = raw.exact;
  }
  const clean = Object.create(null);
  for (const [key, val] of Object.entries(source)) {
    if (key.startsWith('_')) continue;
    if (typeof val === 'string') {
      clean[key] = val;
    }
  }
  return clean;
}

/**
 * 加载内置基础简体中文词典并按顺序合并默认用户覆盖（`user/i18n.override.json`）及命令行指定覆盖文件。
 * @param {object} [options]
 * @param {string|URL} [options.rootDir]
 * @param {string} [options.overridePath]
 * @returns {{ dict: Record<string, string>, baseCount: number, overrideCount: number, totalCount: number, overrideFiles: string[] }}
 */
export function loadI18nDictionary({ rootDir = DEFAULT_ROOT, overridePath } = {}) {
  const rootPath = resolveRootDir(rootDir);
  const basePath = join(rootPath, DEFAULT_I18N_RELATIVE_PATH);
  if (!existsSync(basePath)) {
    throw new Error(`未找到内置汉化基础词典：${basePath}`);
  }
  const baseParsed = readJsonFile(basePath, '内置汉化词典');
  const merged = normalizeOverrideDict(baseParsed, '内置汉化词典');
  const baseCount = Object.keys(merged).length;
  if (baseCount === 0) {
    throw new Error(`内置汉化词典不含任何有效字符串词条：${basePath}`);
  }

  const overrideFiles = [];
  let overrideCount = 0;
  const applyOverrideFile = (candidatePath, mustExist, label) => {
    if (!candidatePath) return;
    if (!existsSync(candidatePath)) {
      if (mustExist) {
        throw new Error(`未找到${label}：${candidatePath}`);
      }
      return;
    }
    const parsed = readJsonFile(candidatePath, label);
    const entries = normalizeOverrideDict(parsed, label);
    const count = Object.keys(entries).length;
    Object.assign(merged, entries);
    overrideCount += count;
    overrideFiles.push(candidatePath);
  };

  const defaultOverridePath = join(rootPath, DEFAULT_OVERRIDE_RELATIVE_PATH);
  applyOverrideFile(defaultOverridePath, false, '默认汉化覆盖词典');

  if (typeof overridePath === 'string' && overridePath.trim()) {
    const resolvedOverride = resolve(process.cwd(), overridePath.trim());
    const isSameFile =
      process.platform === 'win32'
        ? resolvedOverride.toLowerCase() === defaultOverridePath.toLowerCase()
        : resolvedOverride === defaultOverridePath;
    if (!isSameFile) {
      applyOverrideFile(resolvedOverride, true, '指定汉化覆盖词典');
    } else if (!existsSync(resolvedOverride)) {
      throw new Error(`未找到指定汉化覆盖词典：${resolvedOverride}`);
    }
  }

  return {
    dict: merged,
    baseCount,
    overrideCount,
    totalCount: Object.keys(merged).length,
    overrideFiles,
  };
}

/**
 * 在页面 DOM 中将已汉化的文本节点与属性安全还原为原始英文，并清理所有 `data-dxl-orig-*` 痕迹。
 * 设计为零外部闭包依赖的独立函数，可同时用于运行时控制器停用与 `REMOVE_EXPRESSION` 卸载兜底。
 * @param {Element} [root]
 * @returns {{ restoredText: number, restoredAttrs: number }}
 */
export function restoreI18nDom(root = typeof document !== 'undefined' ? document.body : null) {
  let restoredText = 0;
  let restoredAttrs = 0;
  if (!root || typeof document === 'undefined') {
    return { restoredText, restoredAttrs };
  }

  const origTextMap =
    typeof window !== 'undefined' && window.__dxlOrigTextMap instanceof WeakMap
      ? window.__dxlOrigTextMap
      : null;

  try {
    if (origTextMap && typeof document.createTreeWalker === 'function') {
      const showText = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
      const walker = document.createTreeWalker(root, showText);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const rec = origTextMap.get(node);
        if (rec) {
          if (node.nodeValue === rec.lastVal) {
            node.nodeValue = rec.origRaw;
            restoredText += 1;
          }
          origTextMap.delete(node);
        }
      }
    }

    const attrNames = ['title', 'placeholder', 'aria-label'];
    const selector = attrNames
      .flatMap((attr) => [`[data-dxl-orig-${attr}]`, `[data-dxl-orig-${attr}-last]`])
      .join(', ');
    const attrEls = [];
    if (root.nodeType === 1 && root.matches && root.matches(selector)) {
      attrEls.push(root);
    }
    if (root.querySelectorAll) {
      const descendants = root.querySelectorAll(selector);
      for (let i = 0; i < descendants.length; i++) {
        attrEls.push(descendants[i]);
      }
    }
    for (let i = 0; i < attrEls.length; i++) {
      const el = attrEls[i];
      for (let j = 0; j < attrNames.length; j++) {
        const attr = attrNames[j];
        const origAttr = `data-dxl-orig-${attr}`;
        const lastAttr = `${origAttr}-last`;
        if (el.hasAttribute(origAttr) || el.hasAttribute(lastAttr)) {
          const savedOrig = el.getAttribute(origAttr);
          const savedLast = el.getAttribute(lastAttr);
          const cur = el.getAttribute(attr);
          if (savedOrig !== null && (savedLast === null || cur === savedLast)) {
            el.setAttribute(attr, savedOrig);
            restoredAttrs += 1;
          }
          el.removeAttribute(origAttr);
          el.removeAttribute(lastAttr);
          delete el[`__dxl_attr_ver_${attr}`];
        }
      }
    }
  } catch {
    // 忽略还原过程中的偶发只读节点或断连 DOM 异常
  }

  return { restoredText, restoredAttrs };
}

/**
 * 浏览器端 UI 汉化运行时控制器工厂（独立自包含，便于通过 `.toString()` 序列化注入）。
 * @param {Record<string, string>} dict
 * @param {string} version
 * @param {Function} restoreDomFn
 */
export function createI18nController(dict, version, restoreDomFn) {
  const DICT = dict && typeof dict === 'object' ? dict : {};
  const VERSION = String(version || '0.1.0');
  const RE_CURLY_APOS = /[\u2018\u2019]/g;
  const DICT_OWN = Object.create(null);
  const DICT_APOS = new Map();
  const DICT_CI = new Map();

  for (const k in DICT) {
    if (!Object.prototype.hasOwnProperty.call(DICT, k)) continue;
    const v = DICT[k];
    if (typeof v !== 'string') continue;
    DICT_OWN[k] = v;
    const kNorm =
      k.indexOf('\u2019') !== -1 || k.indexOf('\u2018') !== -1
        ? k.replace(RE_CURLY_APOS, "'")
        : k;
    if (kNorm !== k && !Object.prototype.hasOwnProperty.call(DICT, kNorm) && !DICT_APOS.has(kNorm)) {
      DICT_APOS.set(kNorm, v);
    }
    const lk = kNorm.toLowerCase();
    if (!DICT_CI.has(lk)) DICT_CI.set(lk, v);
  }

  const dictLookup = (s) => {
    if (!s) return undefined;
    const exact = DICT_OWN[s];
    if (typeof exact === 'string') return exact;
    const sNorm =
      s.indexOf('\u2019') !== -1 || s.indexOf('\u2018') !== -1
        ? s.replace(RE_CURLY_APOS, "'")
        : s;
    if (sNorm !== s) {
      const exactNorm = DICT_OWN[sNorm];
      if (typeof exactNorm === 'string') return exactNorm;
    }
    const aposAlias = DICT_APOS.get(sNorm);
    if (typeof aposAlias === 'string') return aposAlias;
    const c0 = sNorm.charCodeAt(0);
    if (c0 < 65 || c0 > 90) return undefined;
    return DICT_CI.get(sNorm.toLowerCase());
  };

  if (!(window.__dxlOrigTextMap instanceof WeakMap)) {
    window.__dxlOrigTextMap = new WeakMap();
  }
  const origTextMap = window.__dxlOrigTextMap;

  // 保护用户输入、Markdown AI 正文、代码块、终端、编辑器与会话标题不被汉化改写
  const CONTAINER_EXCLUDE_SELECTOR =
    'code, pre, kbd, samp, style, script, noscript, [data-markdown-root], .md-divider-spacing, [data-testid="user-message-content"], .agy-user-bubble, .monaco-editor, .monaco-diff-editor, .xterm, [class*="onyx-key"], .prose, .markdown, [class*="chat-message"], [class*="group/file-title"], [data-testid="conversation-row-sidebar"] a[href^="/c/"], [data-testid="conversation-row-sidebar"] span.truncate, .msg-body, #raw, [data-testid="swarm-raw"], #swarm-title, #ag-live-metrics-pill, #ag-live-metrics-tooltip';
  const TEXT_EXCLUDE_SELECTOR =
    `textarea, input, [contenteditable="true"], [data-testid="conversation-navigator-turn"], ${CONTAINER_EXCLUDE_SELECTOR}`;

  // 客户端权限编辑器在 onBlur 中硬编码校验 aria-label === "Cancel"，必须保持原文
  const SKIP_ARIA_LABEL_VALUES = new Set(['Cancel']);

  const RE_HAS_CJK = /[\u4e00-\u9fa5]/;
  const RE_PURE_ALPHA = /^\s*[a-zA-Z]+\s*$/;
  const RE_HAS_ALPHA = /[a-zA-Z]/;
  const RE_REL_TIME = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y|yr|yrs)\s+ago$/i;
  const REL_UNIT_MAP = {
    s: '秒',
    sec: '秒',
    secs: '秒',
    m: '分钟',
    min: '分钟',
    mins: '分钟',
    h: '小时',
    hr: '小时',
    hrs: '小时',
    d: '天',
    w: '周',
    mo: '个月',
    y: '年',
    yr: '年',
    yrs: '年',
  };
  const UNIT_MAP_SHORT = { s: '秒', m: '分钟', h: '小时', d: '天', w: '周', mo: '个月', y: '年', yr: '年' };
  const NAMED_PERIOD_MAP = { weekly: '每周', daily: '每日', monthly: '每月' };
  const LIMIT_TYPE_MAP = { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' };
  const MONTH_SHORT_MAP = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const MONTH_FULL_MAP = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  const EFFORT_MAP = {
    low: '低',
    medium: '中',
    high: '高',
    extra: '超高',
    'extra high': '超高',
    xhigh: '超高',
    max: '最高',
  };

  const DIGIT_TEMPLATE_RULES = [
    [/^(\d+(?:\.\d+)?)%\s*left$/i, '$1% 剩余'],
    [/^(\d+)\s+updates?$/i, '$1 条进展'],
    [/^(\d+)\s+files?\s+changed$/i, '$1 个文件变更'],
    [/^(\d+)\s+tools?$/i, '$1 个工具'],
    [/^(\d+)\s+demoted$/i, '$1 项已降级'],
    [/^(\d+)\s+excluded$/i, '$1 项已排除'],
    [/^(\d+)\s+tools?\s+excluded$/i, '$1 个工具已排除'],
    [/^(\d+)\s+active\s+conversations?$/i, '$1 个进行中的对话'],
    [/^(\d+)\s+archived\s+conversations?$/i, '$1 个已归档对话'],
    [/^(\d+)\s+pinned(?:\s+tabs?)?$/i, '$1 个已固定标签页'],
    [/^(\d+)\s+models?\s+selected$/i, '已选择 $1 个模型'],
    [/^(\d+)\s+browser\s+steps?$/i, '$1 个浏览器步骤'],
    [/^(\d+)\s+attachments?$/i, '$1 个附件'],
    [/^(\d+)\s+comments?$/i, '$1 条评论'],
    [/^(\d+)\s+installed$/i, '已安装 $1 项'],
    [/^(\d+)\s+accounts?$/i, '$1 个账号'],
    [/^(\d+)\s+projects?$/i, '$1 个项目'],
    [/^(\d+)\s+calls?\s*·\s*([\d.]+\s*MB)$/i, '$1 次通话 · $2'],
    [/^(\d+)\s+of\s+(\d+)\s+tasks?\s+done$/i, '已完成 $1 / $2 项任务'],
    [/^(\d+)\s+posts?$/i, '$1 条发言'],
    [/^(\d+)\s+members?$/i, '$1 名成员'],
    [/^(\d+)\s+MCP servers?\s+failed to start$/i, '$1 个 MCP 服务器启动失败'],
  ];

  const RE_WINDOW_LIMIT_COMBINED = /^(\d+)\s*([smhd])\s+limit,\s*resets in\s+(.+)$/i;
  const RE_WINDOW_LIMIT = /^(\d+)\s*([smhd])\s+limit$/i;
  const RE_MEDIA_ATTACHMENTS = /^(\d+)\s+(image|audio|video)\s+attachments?$/i;
  const RE_PLUS_ATTACHMENTS = /^\+(\d+)\s+attachments?$/i;
  const RE_PLUS_MORE = /^\+(\d+)\s+more(\s*\(Show all\))?$/i;
  const RE_NAMED_LIMIT_RESETS = /^(Weekly|Daily|Monthly)\s+limit,\s*resets in\s+(.+)$/i;
  const RE_RESETS_IN = /^Resets in\s+(.+)$/i;
  const RE_SEARCH_GOOGLE = /^Search Google for "(.+)"$/;
  const RE_UPDATED_AT =
    /^Updated\s+(?:((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{1,2}月\d{1,2}日),\s*)?((?:上午|下午)?\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)$/;
  const RE_SEE_ALL = /^See all\s*\((\d+)\)$/i;
  const RE_SHOW_BREAKDOWNS = /^Show\s+(\d+)\s+breakdowns?$/i;
  const RE_SHOW_MORE_SUBAGENTS = /^Show\s+(\d+)\s+more\s+subagents?$/i;
  const RE_SHOW_EARLIER_STEPS = /^Show\s+(\d+)\s+earlier\s+steps?$/i;
  const RE_SORT_FILTER_ACTIVE = /^Sort and filter conversations\s*\((\d+)\s+active\)$/i;
  const RE_STILL_THINKING_SEC = /^Still thinking,\s*(\d+)\s*seconds?$/i;
  const RE_MARKED_READ = /^Marked\s+(\d+)\s+conversations?\s+as\s+read$/i;
  const RE_ZIPPING_FOLDER = /^Zipping\s+(.+?)(?:…|\.\.\.)$/i;
  const RE_PERM_DELETE = /^Permanently delete\s+(.*)\s+including\s+(\d+)\s+active\s+conversations\.?$/i;
  const RE_WORKED_FOR_UPDATES = /^Worked for\s+([<0-9smhd\s]+?)\s*·\s*(\d+)\s+updates?$/i;
  const RE_WORKED_FOR = /^Worked for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const RE_WAITING_CMD_SEC = /^Waiting for command completion\s*\(up to\s+(\d+)\s+seconds?\)$/i;
  const RE_HOME_HEY_NAME = /^Hey\s+([^\r\n]{1,40}?),\s+what should we build today\?$/i;
  const RE_HOME_WELCOME_NAME = /^Welcome back,\s*([^\r\n]{1,40}?)\.\s+Where should we pick up\?$/i;
  const RE_HOME_GOOD_SEE_NAME = /^Good to see you,\s*([^\r\n]{1,40}?)\.\s+What['\u2019]s next\?$/i;
  const RE_WORK_LOCALLY_ON = /^Work locally on\s+([^\r\n]{1,80})$/;
  const RE_WORK_IN_TARGET = /^Work in\s+(?!a New Worktree$)([^\r\n]{1,80})$/;
  const RE_WORKTREE_FROM = /^Worktree from\s+([^\r\n,]{1,80}?)(?:,\s*and reuse\s+([^\r\n]{1,80}))?$/;
  const RE_AUTO_FIG_WORKSPACE =
    /^Automatically create a new\s+(Fig|Piper|JJ)\s+workspace when the conversation starts(?:,\s*Worktree from\s+([^\r\n,]{1,80}?))?(?:,\s*and reuse\s+([^\r\n]{1,80}))?$/;
  const RE_THOUGHT_FOR = /^Thought for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const RE_THINKING_FOR = /^Thinking for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const RE_USING_BROWSER_SEC = /^Using browser\s*\((\d+)s\)$/i;
  const RE_RUNNING_FOR = /^Running\s+for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
  const RE_KEY_QUEUES_AFTER = /^(\S+)\s+Queues after the turn$/i;
  const RE_KEY_SENDS_IMMEDIATELY = /^(\S+)\s+Sends immediately$/i;
  const RE_KEY_EMPTY_NEXT_QUEUE = /^(\S+)\s+On empty prompt,\s*sends next in queue$/i;
  const RE_EPHEMERAL_SUMMARY =
    /^(Explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|Ran\s+(?:\d+\s+)?commands?|Edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?)(?:,\s*(explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|ran\s+(?:\d+\s+)?commands?|edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?))*$/i;
  const EPHEMERAL_CLAUSE_MAP = {
    explored: '已探索',
    'explored file': '已探索文件',
    'explored files': '已探索文件',
    'explored artifact': '已探索 Artifact',
    'explored artifacts': '已探索 Artifact',
    'explored file and artifact': '已探索文件与 Artifact',
    'explored files and artifact': '已探索文件与 Artifact',
    'explored file and artifacts': '已探索文件与 Artifact',
    'explored files and artifacts': '已探索文件与 Artifact',
    'ran command': '已运行命令',
    'ran commands': '已运行命令',
    edited: '已编辑',
    'edited file': '已编辑文件',
    'edited files': '已编辑文件',
    'edited artifact': '已编辑 Artifact',
    'edited artifacts': '已编辑 Artifact',
    'edited file and artifact': '已编辑文件与 Artifact',
    'edited files and artifact': '已编辑文件与 Artifact',
    'edited file and artifacts': '已编辑文件与 Artifact',
    'edited files and artifacts': '已编辑文件与 Artifact',
  };
  const RE_EPHEMERAL_COUNT_CLAUSE = /^(explored|edited|ran)\s+(\d+)\s+(files?|artifacts?|commands?)$/i;
  const RE_EPHEMERAL_ACTIVE = /^(Editing|Reading|Listing|Searching)\s+(.+)$/;
  const EPHEMERAL_VERB_MAP = { Editing: '正在编辑', Reading: '正在读取', Listing: '正在列出', Searching: '正在搜索' };
  const EPHEMERAL_NOUN_MAP = {
    file: '文件',
    files: '文件',
    artifact: 'Artifact',
    artifacts: 'Artifact',
    'file and artifact': '文件与 Artifact',
    'files and artifact': '文件与 Artifact',
    'file and artifacts': '文件与 Artifact',
    'files and artifacts': '文件与 Artifact',
  };
  const RE_RUNNING_CMD = /^Running\s+(?!commands?\b|processes\b|for\b|\(Dev\b)(.+)$/;
  const RE_DELETED_RECORDINGS = /^Deleted\s+(\d+)\s+recordings?\s*\(([\d.]+\s*MB)\)$/i;
  const RE_DELETE_RECORDINGS_CONFIRM =
    /^This deletes\s+(\d+)\s+call recordings?\s*\(([\d.]+\s*MB)\)\s+from your machine\.\s*You can't undo this\.$/i;
  const RE_USED_LIMIT = /^You have used (some|all|most) of your (weekly|5-hour|five-hour|daily) limit,?\s*it will fully refresh in (.*)\.?$/i;
  const RE_NOT_USED_LIMIT = /^You have not used any of your (weekly|5-hour|five-hour|daily) limit\.?$/i;
  const RE_ORCHESTRATOR_MODEL = /^Orchestrator\s*\(([^)]+)\)$/i;
  const RE_MODEL_OFFLOAD_DESC =
    /^([A-Za-z0-9 .+-]+?)\s+that may offload routine steps to\s+([A-Za-z0-9 .+-]+?)\.\s*Same\s+([A-Za-z0-9 .+-]+?)-level quality,\s*fewer tokens used\.?$/i;
  const RE_MODEL_REMOVED_ON = /^(.+?)\s+will be removed from Antigravity on\s+(.+?)\.?$/i;
  const RE_MODEL_PERIOD_LIMIT =
    /^(Gemini\b[\w .+-]*|Claude\b[\w .+-]*|GPT\b[\w .+-]*|Orchestrator\b[\w .+()-]*)\s+(Weekly|Daily|Monthly)\s+Limit$/i;
  const RE_QUOTA_RESET_SWITCH =
    /^Your quota for\s+(.+?)\s+will reset on\s+(.+?)\.\s*Switch to another available model to continue\.?$/i;
  const RE_QUOTA_REACHED_SWITCH =
    /^Your quota for\s+(.+?)\s+has been reached\.\s*Switch to another available model to continue\.?$/i;
  const RE_NEED_CREDITS_MODEL =
    /^You need\s+(?:at least\s+(\d+)|more)\s+AI Credits to send messages\.\s*To continue using\s+(.+?)\s+now,\s*purchase more AI Credits\.(?:\s*Your plan's baseline quota will refresh on\s+(.+?)\.)?(?:\s*To continue using this model now,\s*enable AI Credit overages\.)?$/i;
  const RE_BASELINE_QUOTA_REFRESH = /^Your plan's baseline quota will refresh on\s+(.+?)\.?$/i;
  const RE_UP_NEXT_COUNT = /^Up next\s*·\s*(\d+)$/i;
  const RE_USES_LOCAL_CLONE = /^Uses your local clone,\s+([^\r\n]{1,100})$/;

  const RE_ARIA_BRANCH = /^Branch, current:\s*(.*)$/i;
  const RE_ARIA_PROJECT = /^Select project(?:, current)?:\s*(.*)$/i;
  const RE_ARIA_LOCATION = /^(?:Where the agent runs, current|Select location(?:, current)?):\s*(.*)$/i;
  const RE_ARIA_VERSION = /^Version\s+(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\s*·\s*[^\r\n]{1,32})?)$/i;
  const RE_ARIA_MODEL = /^(?:Select model|Model(?:\s+selector)?)(?:,\s*current)?:\s*(.*)$/i;
  const RE_ARIA_PERM_SEL =
    /^(?:(?:Permission mode|Agent permissions preset)\s+selector(?:,\s*current)?|(?:Permission mode|Agent permissions preset),\s*current):\s*(.*)$/i;
  const RE_ARIA_PERM_FIXED =
    /^(?:Permission mode|Agent permissions preset):\s*(.+?)(?:\s*,\s*(.+?)|\s+\((cannot be changed[^)]*)\))?$/i;
  const RE_ARIA_TURN = /^(?:Conversation turn\s+(\d+)\s+by\s+(User|Agent|Assistant)|Turn\s+(\d+)\s+of\s+(\d+))$/i;
  const RE_ARIA_GOTO_TURN = /^Go to turn\s+(\d+)\s+of\s+(\d+)$/i;
  const RE_ARIA_LOAD_OLDER = /^(?:Load\s+(\d+)\s+older\s+turns?.*|(Load|No more) older messages,\s*showing\s+(\d+)\s+of\s+(\d+))$/i;
  const RE_EFFORT_SUFFIX =
    /^(.*?)\s*(?:\((Extra\s+High|Low|Medium|High|Extra|XHigh|Max)(?:\s+thinking)?\)|\b(Extra\s+High|Low|Medium|High|Extra|XHigh|Max))(?:\s*·\s*(.+))?\s*$/i;

  const formatEnglishDateZh = (dateStr) => {
    const s = String(dateStr || '').trim().replace(/\.$/, '');
    const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (m) {
      const mon = MONTH_FULL_MAP[m[1].toLowerCase()] || MONTH_SHORT_MAP[m[1].slice(0, 3).toLowerCase()];
      if (mon) return `${m[3]} 年 ${mon} 月 ${m[2]} 日`;
    }
    return `${s} `;
  };

  const formatCompactDurationZh = (str) => {
    const s = String(str || '').trim();
    if (s === '<1m' || s === '< 1m') return '不到 1 分钟';
    return s
      .replace(/(\d+)\s*d\b/gi, '$1 天')
      .replace(/(\d+)\s*h\b/gi, '$1 小时')
      .replace(/(\d+)\s*m\b/gi, '$1 分钟')
      .replace(/(\d+)\s*s\b/gi, '$1 秒')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const formatUpdatedAtZh = (datePart, timePart) => {
    if (!datePart) return `更新于 ${timePart.trim()}`;
    const mEnDate = datePart.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
    if (mEnDate) {
      const mNum = MONTH_SHORT_MAP[mEnDate[1].toLowerCase()];
      if (mNum) return `更新于 ${mNum}月${mEnDate[2]}日 ${timePart.trim()}`;
    }
    return `更新于 ${datePart.trim()} ${timePart.trim()}`;
  };

  const translateEphemeralClause = (clause) => {
    const low = clause.trim().toLowerCase();
    if (EPHEMERAL_CLAUSE_MAP[low]) return EPHEMERAL_CLAUSE_MAP[low];
    const mCount = low.match(RE_EPHEMERAL_COUNT_CLAUSE);
    if (mCount) {
      const vMap = { explored: '已探索', edited: '已编辑', ran: '已运行' };
      const nMap = {
        file: '个文件',
        files: '个文件',
        artifact: '个 Artifact',
        artifacts: '个 Artifact',
        command: '条命令',
        commands: '条命令',
      };
      return `${vMap[mCount[1]]} ${mCount[2]} ${nMap[mCount[3]]}`;
    }
    return clause.trim();
  };

  const formatActiveEphemeral = (match) => {
    const noun = EPHEMERAL_NOUN_MAP[match[2].toLowerCase()];
    const verbZh = EPHEMERAL_VERB_MAP[match[1]];
    if (!noun) return `${verbZh} ${match[2]}`;
    return /^[A-Za-z0-9]/.test(noun) ? `${verbZh} ${noun}` : `${verbZh}${noun}`;
  };

  const isFormAttrTarget = (el) =>
    Boolean(
      el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          (el.getAttribute &&
            (el.getAttribute('contenteditable') === 'true' ||
              el.getAttribute('data-testid') === 'conversation-navigator-turn'))),
    );

  const immutableTextExclCache = new WeakMap();
  const immutableContainerExclCache = new WeakMap();

  const isExcludedElement = (el, batchSafeSet) => {
    if (!el || el.nodeType !== 1) return true;
    if (immutableTextExclCache.get(el) === true) return true;
    if (batchSafeSet && batchSafeSet.has(el)) return false;
    if (el.closest && el.closest(TEXT_EXCLUDE_SELECTOR)) {
      if (el.isConnected) immutableTextExclCache.set(el, true);
      return true;
    }
    if (batchSafeSet) batchSafeSet.add(el);
    return false;
  };

  const canTranslateElementAttrs = (el, batchSafeSet) => {
    if (!el || el.nodeType !== 1) return false;
    if (isFormAttrTarget(el)) {
      if (immutableContainerExclCache.get(el) === true) return false;
      if (el.closest && el.closest(CONTAINER_EXCLUDE_SELECTOR)) {
        if (el.isConnected) immutableContainerExclCache.set(el, true);
        return false;
      }
      return true;
    }
    return !isExcludedElement(el, batchSafeSet);
  };

  const isInHeaderOrBreadcrumb = (el) =>
    Boolean(el && el.closest && el.closest('header, [data-testid="breadcrumb-segment"]'));

  const replaceTrimmed = (raw, trimmed, next) => (raw === trimmed ? next : raw.replace(trimmed, () => next));

  const matchRuleList = (trimmed, rules) => {
    for (let i = 0; i < rules.length; i++) {
      const [re, tpl] = rules[i];
      if (re.test(trimmed)) return trimmed.replace(re, tpl);
    }
    return null;
  };

  const formatNamedLimitResets = (trimmed) => {
    const mNamed = trimmed.match(RE_NAMED_LIMIT_RESETS);
    if (!mNamed) return null;
    const pZh = NAMED_PERIOD_MAP[mNamed[1].toLowerCase()] || mNamed[1];
    return `${pZh}限额，${formatCompactDurationZh(mNamed[2])}后重置`;
  };

  const S_PREFIX_RULES = [
    [RE_SEE_ALL, '查看全部 ($1)'],
    [RE_SHOW_BREAKDOWNS, '展开明细 ($1 项)'],
    [RE_SHOW_MORE_SUBAGENTS, '显示另外 $1 个子 Agent'],
    [RE_SHOW_EARLIER_STEPS, '展开前 $1 个步骤'],
    [RE_SORT_FILTER_ACTIVE, '排序与筛选对话（已启用 $1 项）'],
    [RE_STILL_THINKING_SEC, '仍在思考（$1 秒）'],
    [RE_SEARCH_GOOGLE, (_, q) => `使用 Google 搜索“${q}”`],
  ];

  const KEY_SHORTCUT_RULES = [
    [RE_KEY_QUEUES_AFTER, '$1 当前轮次结束后排队发送'],
    [RE_KEY_SENDS_IMMEDIATELY, '$1 立即发送'],
    [RE_KEY_EMPTY_NEXT_QUEUE, '$1 输入为空时发送队列下一条'],
  ];

  const computeTextTranslation = (raw, contextEl) => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let replacement = dictLookup(trimmed);
    if (typeof replacement !== 'string' && trimmed.endsWith('.')) {
      const withoutDot = dictLookup(trimmed.slice(0, -1));
      if (typeof withoutDot === 'string') {
        replacement = withoutDot.endsWith('。') ? withoutDot : `${withoutDot}。`;
      }
    }
    if (typeof replacement === 'string') {
      if (RE_HAS_CJK.test(replacement) && RE_PURE_ALPHA.test(raw)) {
        return replacement;
      }
      return replaceTrimmed(raw, trimmed, replacement);
    }

    if (!RE_HAS_ALPHA.test(trimmed)) return null;

    const c0 = trimmed.charCodeAt(0);
    if (c0 >= 48 && c0 <= 57) {
      const mWinComb = trimmed.match(RE_WINDOW_LIMIT_COMBINED);
      if (mWinComb) {
        const u = UNIT_MAP_SHORT[mWinComb[2].toLowerCase()] || mWinComb[2];
        return replaceTrimmed(raw, trimmed, `${mWinComb[1]} ${u}限额，${formatCompactDurationZh(mWinComb[3])}后重置`);
      }
      const mWin = trimmed.match(RE_WINDOW_LIMIT);
      if (mWin) {
        const u = UNIT_MAP_SHORT[mWin[2].toLowerCase()] || mWin[2];
        return replaceTrimmed(raw, trimmed, `${mWin[1]} ${u}限额`);
      }
      const mRel = trimmed.match(RE_REL_TIME);
      if (mRel) {
        const unit = REL_UNIT_MAP[mRel[2].toLowerCase()] || mRel[2];
        return replaceTrimmed(raw, trimmed, `${mRel[1]} ${unit}前`);
      }
      const mMediaAtt = trimmed.match(RE_MEDIA_ATTACHMENTS);
      if (mMediaAtt) {
        const mediaMap = { image: '图片', audio: '音频', video: '视频' };
        const mediaZh = mediaMap[mMediaAtt[2].toLowerCase()] || mMediaAtt[2];
        return replaceTrimmed(raw, trimmed, `${mMediaAtt[1]} 个${mediaZh}附件`);
      }
      const digitHit = matchRuleList(trimmed, DIGIT_TEMPLATE_RULES);
      return digitHit !== null ? replaceTrimmed(raw, trimmed, digitHit) : null;
    }

    if (c0 === 43) {
      if (RE_PLUS_ATTACHMENTS.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_PLUS_ATTACHMENTS, '+$1 个附件'));
      }
      const mPlusMore = trimmed.match(RE_PLUS_MORE);
      if (mPlusMore) {
        return replaceTrimmed(
          raw,
          trimmed,
          mPlusMore[2] ? `+${mPlusMore[1]} 更多（显示全部）` : `+${mPlusMore[1]} 更多`,
        );
      }
      return null;
    }

    const firstUpper = trimmed[0].toUpperCase();
    if (firstUpper === 'S') {
      const sHit = matchRuleList(trimmed, S_PREFIX_RULES);
      if (sHit !== null) return replaceTrimmed(raw, trimmed, sHit);
      if (!isInHeaderOrBreadcrumb(contextEl)) {
        const mSearch = trimmed.match(RE_EPHEMERAL_ACTIVE);
        if (mSearch) return replaceTrimmed(raw, trimmed, formatActiveEphemeral(mSearch));
      }
    } else if (firstUpper === 'P') {
      if (RE_PERM_DELETE.test(trimmed)) {
        return replaceTrimmed(
          raw,
          trimmed,
          trimmed.replace(RE_PERM_DELETE, (_, target, cnt) => `永久删除 ${target} 及 ${cnt} 个进行中的对话。`),
        );
      }
    } else if (firstUpper === 'W' || firstUpper === 'M') {
      const namedHit = formatNamedLimitResets(trimmed);
      if (namedHit !== null) return replaceTrimmed(raw, trimmed, namedHit);
      if (firstUpper === 'W') {
        if (RE_WORKED_FOR_UPDATES.test(trimmed)) {
          return replaceTrimmed(
            raw,
            trimmed,
            trimmed.replace(RE_WORKED_FOR_UPDATES, (_, dur, cnt) => `已工作 ${dur.trim()} · ${cnt} 条进展`),
          );
        }
        if (RE_WORKED_FOR.test(trimmed)) {
          return replaceTrimmed(raw, trimmed, trimmed.replace(RE_WORKED_FOR, '已工作 $1'));
        }
        if (RE_WAITING_CMD_SEC.test(trimmed)) {
          return replaceTrimmed(raw, trimmed, trimmed.replace(RE_WAITING_CMD_SEC, '正在等待命令完成（最多 $1 秒）'));
        }
        const mWel = trimmed.match(RE_HOME_WELCOME_NAME);
        if (mWel) return replaceTrimmed(raw, trimmed, `欢迎回来，${mWel[1].trim()}。我们从哪里继续？`);
        const mWorkLocal = trimmed.match(RE_WORK_LOCALLY_ON);
        if (mWorkLocal) return replaceTrimmed(raw, trimmed, `在本地 ${mWorkLocal[1].trim()} 中工作`);
        const mWorkFrom = trimmed.match(RE_WORKTREE_FROM);
        if (mWorkFrom) {
          return replaceTrimmed(
            raw,
            trimmed,
            mWorkFrom[2]
              ? `从 ${mWorkFrom[1].trim()} 创建 Worktree，并复用 ${mWorkFrom[2].trim()}`
              : `从 ${mWorkFrom[1].trim()} 创建 Worktree`,
          );
        }
        const mWorkIn = trimmed.match(RE_WORK_IN_TARGET);
        if (mWorkIn) return replaceTrimmed(raw, trimmed, `在 ${mWorkIn[1].trim()} 中工作`);
      } else if (RE_MARKED_READ.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_MARKED_READ, '已将 $1 个对话标为已读'));
      }
    } else if (firstUpper === 'T') {
      if (RE_THOUGHT_FOR.test(trimmed)) return replaceTrimmed(raw, trimmed, trimmed.replace(RE_THOUGHT_FOR, '已思考 $1'));
      if (RE_THINKING_FOR.test(trimmed)) return replaceTrimmed(raw, trimmed, trimmed.replace(RE_THINKING_FOR, '已思考 $1'));
      if (RE_DELETE_RECORDINGS_CONFIRM.test(trimmed)) {
        return replaceTrimmed(
          raw,
          trimmed,
          trimmed.replace(
            RE_DELETE_RECORDINGS_CONFIRM,
            '这将从您的设备中删除 $1 条通话录音（$2），此操作无法撤销。',
          ),
        );
      }
    } else if (firstUpper === 'E' || firstUpper === 'R' || firstUpper === 'L') {
      if (firstUpper === 'R') {
        const mResets = trimmed.match(RE_RESETS_IN);
        if (mResets) return replaceTrimmed(raw, trimmed, `${formatCompactDurationZh(mResets[1])}后重置`);
      }
      if (RE_EPHEMERAL_SUMMARY.test(trimmed)) {
        const translatedSummary = trimmed
          .split(/,\s*/)
          .map((part) => translateEphemeralClause(part))
          .join('、');
        return replaceTrimmed(raw, trimmed, translatedSummary);
      }
      const inHdr = isInHeaderOrBreadcrumb(contextEl);
      if (!inHdr) {
        const mActive = trimmed.match(RE_EPHEMERAL_ACTIVE);
        if (mActive) return replaceTrimmed(raw, trimmed, formatActiveEphemeral(mActive));
      }
      if (firstUpper === 'R') {
        if (RE_RUNNING_FOR.test(trimmed)) return replaceTrimmed(raw, trimmed, trimmed.replace(RE_RUNNING_FOR, '已运行 $1'));
        if (!inHdr && RE_RUNNING_CMD.test(trimmed)) {
          return replaceTrimmed(raw, trimmed, trimmed.replace(RE_RUNNING_CMD, (_, cmd) => `正在运行 ${cmd}`));
        }
      }
    } else if (firstUpper === 'D') {
      const namedHit = formatNamedLimitResets(trimmed);
      if (namedHit !== null) return replaceTrimmed(raw, trimmed, namedHit);
      if (RE_DELETED_RECORDINGS.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_DELETED_RECORDINGS, '已删除 $1 条录音 ($2)'));
      }
    } else if (firstUpper === 'U') {
      if (RE_USING_BROWSER_SEC.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_USING_BROWSER_SEC, '正在操作浏览器 ($1s)'));
      }
      if (RE_UP_NEXT_COUNT.test(trimmed)) return replaceTrimmed(raw, trimmed, trimmed.replace(RE_UP_NEXT_COUNT, '接下来 · $1'));
      const mLocalClone = trimmed.match(RE_USES_LOCAL_CLONE);
      if (mLocalClone) return replaceTrimmed(raw, trimmed, `使用本地克隆：${mLocalClone[1].trim()}`);
      const mUpd = trimmed.match(RE_UPDATED_AT);
      if (mUpd) return replaceTrimmed(raw, trimmed, formatUpdatedAtZh(mUpd[1], mUpd[2]));
    } else if (firstUpper === 'V') {
      const mVer = trimmed.match(RE_ARIA_VERSION);
      if (mVer) return replaceTrimmed(raw, trimmed, `版本 ${mVer[1].trim()}`);
    } else if (firstUpper === 'Z') {
      if (RE_ZIPPING_FOLDER.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_ZIPPING_FOLDER, (_, folder) => `正在打包 ${folder}…`));
      }
    } else if (firstUpper === 'N') {
      if (trimmed === 'New' || trimmed === 'NEW') {
        const btn = contextEl && contextEl.closest && contextEl.closest('button');
        const isActionBtn = Boolean(
          btn &&
            !btn.hasAttribute('data-model-label') &&
            !(contextEl && contextEl.closest && contextEl.closest('[data-testid*="model-selector"]')) &&
            (btn.textContent || '').replace(/\badd\b|\+/gi, '').trim() === trimmed,
        );
        return replaceTrimmed(raw, trimmed, isActionBtn ? '新建' : '新');
      }
    } else if (firstUpper === 'O') {
      if (RE_ORCHESTRATOR_MODEL.test(trimmed)) {
        return replaceTrimmed(raw, trimmed, trimmed.replace(RE_ORCHESTRATOR_MODEL, '编排器 ($1)'));
      }
    } else if (firstUpper === 'Y') {
      const mUsed = trimmed.match(RE_USED_LIMIT);
      if (mUsed) {
        const degreeMap = { some: '部分', all: '全部', most: '大部分' };
        const degree = degreeMap[mUsed[1].toLowerCase()] || mUsed[1];
        const type = LIMIT_TYPE_MAP[mUsed[2].toLowerCase()] || mUsed[2];
        const timeStr = mUsed[3]
          .replace(/\.$/, '')
          .replace(/(\d+)\s*days?/gi, '$1 天')
          .replace(/(\d+)\s*hours?/gi, '$1 小时')
          .replace(/(\d+)\s*minutes?/gi, '$1 分钟')
          .replace(/(\d+)\s*seconds?/gi, '$1 秒')
          .replace(/,\s*/g, ' ')
          .trim();
        return replaceTrimmed(raw, trimmed, `您已消耗${degree}${type}额度，将在 ${timeStr} 后完全重置。`);
      }
      const mNotUsed = trimmed.match(RE_NOT_USED_LIMIT);
      if (mNotUsed) {
        const type = LIMIT_TYPE_MAP[mNotUsed[1].toLowerCase()] || mNotUsed[1];
        return replaceTrimmed(raw, trimmed, `您尚未消耗任何${type}额度。`);
      }
      if (RE_QUOTA_RESET_SWITCH.test(trimmed)) {
        return replaceTrimmed(
          raw,
          trimmed,
          trimmed.replace(
            RE_QUOTA_RESET_SWITCH,
            (_, m, dt) => `您的 ${dictLookup(m.trim()) || m.trim()} 配额将于 ${dt} 重置，请切换至其他可用模型以继续。`,
          ),
        );
      }
      if (RE_QUOTA_REACHED_SWITCH.test(trimmed)) {
        return replaceTrimmed(
          raw,
          trimmed,
          trimmed.replace(
            RE_QUOTA_REACHED_SWITCH,
            (_, m) => `您的 ${dictLookup(m.trim()) || m.trim()} 配额已用尽，请切换至其他可用模型以继续。`,
          ),
        );
      }
      const mNeedCred = trimmed.match(RE_NEED_CREDITS_MODEL);
      if (mNeedCred) {
        const amtPart = mNeedCred[1] ? `至少 ${mNeedCred[1]} 点` : '更多';
        const modName = mNeedCred[2].trim() === 'this model' ? '该模型' : dictLookup(mNeedCred[2].trim()) || mNeedCred[2].trim();
        let out = `发送消息需要${amtPart} AI 点数。若需立即继续使用 ${modName}，请购买更多 AI 点数。`;
        if (mNeedCred[3]) out += ` 您套餐的基础配额将于 ${mNeedCred[3]} 刷新。`;
        if (/enable AI Credit overages/i.test(trimmed)) out += ' 若需立即继续使用该模型，请开启 AI 点数超额使用。';
        return replaceTrimmed(raw, trimmed, out);
      }
      if (RE_BASELINE_QUOTA_REFRESH.test(trimmed)) {
        return replaceTrimmed(
          raw,
          trimmed,
          trimmed.replace(RE_BASELINE_QUOTA_REFRESH, '您套餐的基础配额将于 $1 刷新。'),
        );
      }
    } else if (firstUpper === 'H') {
      const mHey = trimmed.match(RE_HOME_HEY_NAME);
      if (mHey) return replaceTrimmed(raw, trimmed, `嗨，${mHey[1].trim()}，今天想做点什么？`);
    } else if (firstUpper === 'G') {
      const mGood = trimmed.match(RE_HOME_GOOD_SEE_NAME);
      if (mGood) return replaceTrimmed(raw, trimmed, `很高兴见到你，${mGood[1].trim()}。接下来做什么？`);
    } else if (firstUpper === 'A') {
      const mAutoFig = trimmed.match(RE_AUTO_FIG_WORKSPACE);
      if (mAutoFig) {
        return replaceTrimmed(
          raw,
          trimmed,
          `对话开始时自动新建 ${mAutoFig[1]} 工作区${mAutoFig[2] ? `，从 ${mAutoFig[2].trim()} 创建 Worktree` : ''}${mAutoFig[3] ? `，并复用 ${mAutoFig[3].trim()}` : ''}`,
        );
      }
    }

    if (trimmed.length < 220 && trimmed.includes('offload routine steps')) {
      const mOffload = trimmed.match(RE_MODEL_OFFLOAD_DESC);
      if (mOffload) {
        return replaceTrimmed(
          raw,
          trimmed,
          `可将常规步骤分流至 ${mOffload[2]} 执行的 ${mOffload[1]} 编排模型。保持 ${mOffload[3]} 同等质量，消耗更少 Token。`,
        );
      }
    }
    if (trimmed.length < 160 && trimmed.includes('removed from Antigravity')) {
      const mRemoved = trimmed.match(RE_MODEL_REMOVED_ON);
      if (mRemoved) {
        return replaceTrimmed(raw, trimmed, `${mRemoved[1].trim()} 将于 ${formatEnglishDateZh(mRemoved[2])}从 Antigravity 下线。`);
      }
    }
    if (trimmed.length < 80 && (firstUpper === 'G' || firstUpper === 'C' || firstUpper === 'O')) {
      const mPeriodLim = trimmed.match(RE_MODEL_PERIOD_LIMIT);
      if (mPeriodLim) {
        const pZh = NAMED_PERIOD_MAP[mPeriodLim[2].toLowerCase()] || mPeriodLim[2];
        return replaceTrimmed(raw, trimmed, `${mPeriodLim[1].trim()} ${pZh}限额`);
      }
    }
    if (trimmed.length < 64) {
      const keyHit = matchRuleList(trimmed, KEY_SHORTCUT_RULES);
      if (keyHit !== null) return replaceTrimmed(raw, trimmed, keyHit);
    }

    return null;
  };

  const resolveAttrTranslation = (atrim, el) => {
    const directHit = dictLookup(atrim);
    if (typeof directHit === 'string') return directHit;

    const mModel = atrim.match(RE_ARIA_MODEL);
    if (mModel) {
      let mName = mModel[1].trim();
      if (mName === 'Select model' || mName === 'Select Model') return '模型，当前：选择模型';
      const directModelZh = dictLookup(mName) || computeTextTranslation(mName, el);
      if (directModelZh) {
        mName = directModelZh;
      } else {
        const mEff = mName.match(RE_EFFORT_SUFFIX);
        if (mEff) {
          const effRaw = mEff[2] || mEff[3];
          const effZh = EFFORT_MAP[effRaw.replace(/\s+/g, ' ').toLowerCase()] || effRaw;
          const baseRaw = mEff[1].trim();
          const baseZh = dictLookup(baseRaw) || computeTextTranslation(baseRaw, el) || baseRaw;
          const ctxTail = mEff[4] ? ` · ${mEff[4].trim()}` : '';
          mName = baseZh + (mEff[2] ? ` (${effZh})` : ` · ${effZh}`) + ctxTail;
        }
      }
      return `模型，当前：${mName}`;
    }

    const lookupPerm = (s) => dictLookup(s) || dictLookup(s.charAt(0).toUpperCase() + s.slice(1)) || s;
    const mPermSel = atrim.match(RE_ARIA_PERM_SEL);
    if (mPermSel) return `权限模式，当前：${lookupPerm(mPermSel[1].trim())}`;

    const mPermFixed = atrim.match(RE_ARIA_PERM_FIXED);
    if (mPermFixed) {
      const pMode = mPermFixed[1].trim();
      const rawNote = (mPermFixed[2] || mPermFixed[3] || '').trim();
      if (!rawNote) return `权限模式：${lookupPerm(pMode)}`;
      const mappedNote =
        rawNote.toLowerCase() === 'cannot be changed mid-conversation'
          ? '对话中途无法更改'
          : dictLookup(rawNote) || computeTextTranslation(rawNote, el) || rawNote;
      return `权限模式：${lookupPerm(pMode)}（${mappedNote}）`;
    }

    const mGoTurn = atrim.match(RE_ARIA_GOTO_TURN);
    if (mGoTurn) return `跳转至第 ${mGoTurn[1]} / ${mGoTurn[2]} 轮对话`;

    const mTurn = atrim.match(RE_ARIA_TURN);
    if (mTurn) {
      if (mTurn[3] && mTurn[4]) return `第 ${mTurn[3]} / ${mTurn[4]} 轮对话`;
      const roleZh = mTurn[2].toLowerCase() === 'user' ? '用户' : 'Agent';
      return `第 ${mTurn[1]} 轮对话（${roleZh}）`;
    }

    const mOlder = atrim.match(RE_ARIA_LOAD_OLDER);
    if (mOlder) {
      if (mOlder[3] && mOlder[4]) {
        return `${/^no/i.test(mOlder[2]) ? '没有更早的消息' : '加载更早的消息'}（当前显示 ${mOlder[3]} / ${mOlder[4]}）`;
      }
      return `加载更早的 ${mOlder[1]} 轮对话`;
    }

    const mBranch = atrim.match(RE_ARIA_BRANCH);
    if (mBranch) {
      const bName = mBranch[1].trim();
      return `分支，当前：${bName === 'Select branch' ? '选择分支' : bName}`;
    }

    const mProj = atrim.match(RE_ARIA_PROJECT);
    if (mProj) {
      const pName = mProj[1].trim();
      return `选择项目，当前：${pName === 'No project' || pName === 'No Project' ? '未关联项目' : pName}`;
    }

    const mLoc = atrim.match(RE_ARIA_LOCATION);
    if (mLoc) {
      const locName = mLoc[1].trim();
      const mappedLoc =
        locName === 'This Computer' ? '本机' : locName === 'Remote' ? '远程' : dictLookup(locName) || locName;
      return `Agent 运行位置，当前：${mappedLoc}`;
    }

    const mVer = atrim.match(RE_ARIA_VERSION);
    if (mVer) return `版本 ${mVer[1].trim()}`;

    if (atrim === 'File' && el && el.classList && el.classList.contains('segmented')) {
      return '文件';
    }

    if (
      el &&
      el.getAttribute &&
      el.getAttribute('data-testid') === 'running-row-stop' &&
      /^Stop\s+(.+)$/i.test(atrim)
    ) {
      return `停止 ${atrim.replace(/^Stop\s+/i, '')}`;
    }

    return computeTextTranslation(atrim, el);
  };

  const translateTextNode = (node) => {
    const currentVal = node.nodeValue;
    if (!currentVal) return;

    const rec = origTextMap.get(node);
    if (rec && rec.lastVal === currentVal && rec.ver === VERSION) {
      return;
    }
    const origRaw = rec && rec.lastVal === currentVal ? rec.origRaw : currentVal;

    const nextVal = computeTextTranslation(origRaw, node.parentElement);
    if (nextVal !== null) {
      origTextMap.set(node, { origRaw, lastVal: nextVal, ver: VERSION });
      if (node.nodeValue !== nextVal) {
        node.nodeValue = nextVal;
      }
    } else if (rec && rec.lastVal === currentVal) {
      node.nodeValue = origRaw;
      origTextMap.delete(node);
    }
  };

  const translateSingleAttr = (el, attrName) => {
    const origDataAttr = `data-dxl-orig-${attrName}`;
    const lastDataAttr = `${origDataAttr}-last`;
    const verProp = `__dxl_attr_ver_${attrName}`;
    const cur = el.getAttribute(attrName);
    if (!cur) {
      if (el.hasAttribute(origDataAttr)) el.removeAttribute(origDataAttr);
      if (el.hasAttribute(lastDataAttr)) el.removeAttribute(lastDataAttr);
      delete el[verProp];
      return;
    }
    const savedOrig = el.getAttribute(origDataAttr);
    const savedLast = el.getAttribute(lastDataAttr);
    if (savedOrig !== null && savedLast === cur && el[verProp] === VERSION) {
      return;
    }
    const origVal = savedOrig !== null && savedLast === cur ? savedOrig : cur;
    const trimmed = origVal.trim();
    const shouldSkipAttr = attrName === 'aria-label' && SKIP_ARIA_LABEL_VALUES.has(trimmed);
    const nextVal = shouldSkipAttr ? null : resolveAttrTranslation(trimmed, el);

    if (typeof nextVal === 'string') {
      if (savedOrig !== origVal) el.setAttribute(origDataAttr, origVal);
      if (savedLast !== nextVal) el.setAttribute(lastDataAttr, nextVal);
      el[verProp] = VERSION;
      if (cur !== nextVal) {
        el.setAttribute(attrName, nextVal);
      }
    } else {
      if (savedOrig !== null && savedLast === cur) {
        el.setAttribute(attrName, savedOrig);
      }
      if (savedOrig !== null) el.removeAttribute(origDataAttr);
      if (savedLast !== null) el.removeAttribute(lastDataAttr);
      el[verProp] = VERSION;
    }
  };

  const ATTR_NAMES = ['title', 'placeholder', 'aria-label'];
  const hasAnyTranslatableAttr = (el) =>
    Boolean(el.hasAttribute && ATTR_NAMES.some((attr) => el.hasAttribute(attr)));
  const translateElementAttrs = (el) => {
    if (!el || el.nodeType !== 1) return;
    for (let i = 0; i < ATTR_NAMES.length; i++) {
      translateSingleAttr(el, ATTR_NAMES[i]);
    }
  };

  const SHOW_EL = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_ELEMENT : 1;
  const SHOW_TXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
  const ACCEPT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_ACCEPT : 1;
  const REJECT = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_REJECT : 2;
  const SKIP = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_SKIP : 3;

  const walkerFilter = {
    acceptNode(node) {
      if (node.nodeType === 1) {
        if (node.matches && node.matches(TEXT_EXCLUDE_SELECTOR)) {
          if (node.isConnected) {
            immutableTextExclCache.set(node, true);
          }
          if (isFormAttrTarget(node) && canTranslateElementAttrs(node) && hasAnyTranslatableAttr(node)) {
            translateElementAttrs(node);
          }
          return REJECT;
        }
        if (hasAnyTranslatableAttr(node)) {
          translateElementAttrs(node);
        }
        return SKIP;
      }
      return ACCEPT;
    },
  };

  const scanAndTranslate = (root = document.body) => {
    if (!root) return;
    if (root.nodeType === 3) {
      if (root.parentElement && !isExcludedElement(root.parentElement)) {
        translateTextNode(root);
      }
      return;
    }
    if (root.nodeType !== 1) return;
    if (isExcludedElement(root)) {
      if (isFormAttrTarget(root) && canTranslateElementAttrs(root) && hasAnyTranslatableAttr(root)) {
        translateElementAttrs(root);
      }
      return;
    }
    if (hasAnyTranslatableAttr(root)) {
      translateElementAttrs(root);
    }
    const walker = document.createTreeWalker(root, SHOW_EL | SHOW_TXT, walkerFilter);
    while (walker.nextNode()) {
      translateTextNode(walker.currentNode);
    }
  };

  const OBS_OPTS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'placeholder'],
  };

  const dirtyRoots = new Set();
  let observer = null;
  let observedBody = null;
  let rafId = 0;
  let fallbackTimer = 0;
  let pending = false;

  const flush = () => {
    pending = false;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = 0;
    }
    rafId = 0;
    if (dirtyRoots.size === 0) return;

    if (dirtyRoots.size > 200) {
      dirtyRoots.clear();
      if (document.body) scanAndTranslate(document.body);
      return;
    }

    const roots = Array.from(dirtyRoots);
    const rootSet = new Set(roots);
    dirtyRoots.clear();

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (!r || !r.isConnected) continue;
      let covered = false;
      for (let p = r.parentNode; p; p = p.parentNode) {
        if (rootSet.has(p)) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        scanAndTranslate(r);
      }
    }
  };

  const scheduleFlush = () => {
    if (pending) return;
    pending = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    rafId = raf(flush);
    if (pending) {
      fallbackTimer = setTimeout(flush, 80);
    }
  };

  const ensureStarted = () => {
    if (!document.body) return;
    if (observedBody !== document.body) {
      scanAndTranslate(document.body);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver((mutations) => {
          const list = Array.isArray(mutations) ? mutations : [];
          if (list.length === 0) {
            dirtyRoots.add(document.body);
            scheduleFlush();
            return;
          }
          const batchSafeSet = new Set();
          for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (m.type === 'characterData') {
              const t = m.target;
              if (t) {
                const rec = origTextMap.get(t);
                if (rec && rec.lastVal === t.nodeValue && rec.ver === VERSION) {
                  continue;
                }
                if (t.parentElement && !isExcludedElement(t.parentElement, batchSafeSet)) {
                  dirtyRoots.add(t);
                }
              }
            } else if (m.type === 'attributes') {
              const el = m.target;
              if (el && el.nodeType === 1 && canTranslateElementAttrs(el, batchSafeSet)) {
                translateElementAttrs(el);
              }
            } else if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) {
              if (m.target && m.target.nodeType === 1 && isExcludedElement(m.target, batchSafeSet)) {
                continue;
              }
              for (let j = 0; j < m.addedNodes.length; j++) {
                const n = m.addedNodes[j];
                if (n && (n.nodeType === 1 || n.nodeType === 3)) {
                  dirtyRoots.add(n);
                }
              }
            }
          }
          if (dirtyRoots.size > 0) {
            scheduleFlush();
          }
        });
        observer.observe(document.body, OBS_OPTS);
        observedBody = document.body;
      }
    }
  };

  const stop = ({ restore = true } = {}) => {
    if (pending && rafId) {
      const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
      cancel(rafId);
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
    pending = false;
    rafId = 0;
    fallbackTimer = 0;
    dirtyRoots.clear();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observedBody = null;
    if (restore && document.body && typeof restoreDomFn === 'function') {
      return restoreDomFn(document.body);
    }
    return { restoredText: 0, restoredAttrs: 0 };
  };

  return {
    ensureStarted,
    scanAndTranslate,
    stop,
  };
}
