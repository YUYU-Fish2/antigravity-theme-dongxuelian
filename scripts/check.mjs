import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildThemeCss, loadThemeAssets } from '../src/assets.js';
import { REMOVE_EXPRESSION, buildInjectScript } from '../src/cdp.js';
import { loadI18nDictionary } from '../src/i18n.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function collectJsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (extname(name) === '.js' || extname(name) === '.mjs') {
      out.push(full);
    }
  }
  return out;
}

function stripCssCommentsAndStrings(css) {
  let out = '';
  let i = 0;
  let inComment = false;
  let quote = '';
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function assertCssIntegrity(css) {
  const clean = stripCssCommentsAndStrings(css);

  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new Error('CSS 存在多余闭合花括号 "}"');
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`CSS 花括号未闭合（净深度 ${depth}）`);
  }

  if (/backdrop-filter\s*:/i.test(clean)) {
    throw new Error('CSS 不得包含 backdrop-filter（避免 Chromium 截图死锁与磨砂伪影）');
  }
  if (/font-size\s*:/i.test(clean)) {
    throw new Error('CSS 不得写死字号 font-size（遵循原生字号策略）');
  }
  if (/theme-dark/i.test(clean)) {
    throw new Error('CSS 不得污染深色模式（禁止包含 theme-dark 覆盖规则）');
  }

  const requiredHooks = [
    'html:has(> body.theme-light)',
    'body.theme-light',
    '@container dxl-reading',
    '[data-dxl-stage="conversation"]',
    '[data-dxl-reading-track="true"]',
    '[data-dxl-avatar]',
  ];
  for (const hook of requiredHooks) {
    if (!css.includes(hook)) {
      throw new Error(`CSS 缺少关键选择器或容器钩子：${hook}`);
    }
  }
}

function assertPackageContract() {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.type !== 'module') {
    throw new Error('package.json 必须启用 "type": "module"');
  }
  if (pkg.dependencies || pkg.devDependencies) {
    throw new Error('本项目承诺零第三方依赖，package.json 不应包含 dependencies 或 devDependencies');
  }
  for (const scriptName of [
    'inject',
    'watch',
    'remove',
    'install-plugin',
    'uninstall-plugin',
    'install-theme',
    'uninstall-theme',
    'patch-app',
    'unpatch-app',
    'status',
    'test',
    'check',
  ]) {
    if (!pkg.scripts?.[scriptName]) {
      throw new Error(`package.json 缺少脚本：${scriptName}`);
    }
  }
}

function assertBatchWrappers() {
  const expected = [
    ['inject.bat', 'bin\\inject.js'],
    ['watch.bat', 'bin\\watch.js'],
    ['remove.bat', 'bin\\remove.js'],
    ['install-plugin.bat', 'bin\\install-plugin.js'],
    ['uninstall-plugin.bat', 'bin\\uninstall-plugin.js'],
    ['install.bat', 'bin\\install.js'],
    ['uninstall.bat', 'bin\\uninstall.js'],
    ['patch-app.bat', 'bin\\patch-app.js'],
    ['unpatch-app.bat', 'bin\\unpatch-app.js'],
    ['status.bat', 'bin\\status.js'],
  ];
  for (const [batName, binTarget] of expected) {
    const batPath = join(ROOT, batName);
    if (!existsSync(batPath)) {
      throw new Error(`缺少 Windows 启动脚本：${batName}`);
    }
    const content = readFileSync(batPath, 'utf8');
    if (/[^\x00-\x7F]/.test(content)) {
      throw new Error(`${batName} 包含非 ASCII 字符，可能导致 cmd.exe 编码异常`);
    }
    if (!content.includes(binTarget)) {
      throw new Error(`${batName} 未调用目标脚本：${binTarget}`);
    }
    if (!/ERRORLEVEL/i.test(content) || !/pause/i.test(content)) {
      throw new Error(`${batName} 缺少失败兜底（ERRORLEVEL + pause）`);
    }
  }
}

function main() {
  assertPackageContract();

  const jsFiles = ['src', 'bin', 'scripts', 'test'].flatMap((dir) => collectJsFiles(join(ROOT, dir)));
  for (const file of jsFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }

  const assets = loadThemeAssets(ROOT);
  const totalBytes = assets.avatar.size + assets.reading.size + assets.paper.size;

  const i18n = loadI18nDictionary({ rootDir: ROOT });

  const css = buildThemeCss({ rootDir: ROOT, assets });
  assertCssIntegrity(css);

  const compiledInject = buildInjectScript(css, {
    avatarDataUri: assets.avatar.dataUri,
    avatar: true,
    shift: true,
    i18n: true,
    i18nDict: i18n.dict,
  });
  new vm.Script(compiledInject, { filename: 'dxl-inject.compiled.js' });
  new vm.Script(REMOVE_EXPRESSION, { filename: 'dxl-remove.compiled.js' });

  assertBatchWrappers();

  console.log(
    `PASS: JS 语法(${jsFiles.length} 文件)、WebP 资产(${totalBytes} B)、汉化词典(${i18n.baseCount} 词条)、CSS 作用域与 .bat 检查通过 (${relative(ROOT, ROOT) || '.'})`,
  );
}

main();
