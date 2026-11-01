#!/usr/bin/env node
/**
 * scripts/hide-closed-mock.mjs — 「隐藏已闭环」显示风格的可见性断言（不需要浏览器）。
 *
 *   node scripts/hide-closed-mock.mjs
 *
 * 背景（2026-10-30 用户要求）：显示风格里加一个「隐藏已闭环」。已闭环节点原来靠折叠行
 * （▸ 已闭环 N）收在画布外，点 chip 才展开；开关打开后整颗不渲染、折叠行也不再出，
 * 数量上提到卡片 chips（目标 / 构思层级；已达成里程碑仍留主管）。
 *
 * 做法与 closure-mock / idle-branch-mock 一致：从 web/index.html 抠纯函数，放进 new Function 跑。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const script = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/** 按函数名截出 `function name(...) { ... }`（花括号配对，跳过注释与模板串） */
function grabFn(name) {
  const at = script.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`web/index.html 里找不到 ${name}()`);
  const open = script.indexOf('{', at);
  let depth = 0;
  let quote = '';
  for (let i = open; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && script[i + 1] === '/') { const nl = script.indexOf('\n', i); i = nl < 0 ? script.length : nl; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return script.slice(at, i + 1); }
  }
  throw new Error(`${name}() 花括号没闭合`);
}
/** 按 const 名截出到深度 0 的分号（isRecord 这类单行箭头函数） */
function grabConst(name) {
  const at = script.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`web/index.html 里找不到 const ${name}`);
  const from = at + `const ${name} =`.length;
  let depth = 0;
  let quote = '';
  for (let i = from; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && script[i + 1] === '/') { const nl = script.indexOf('\n', i); i = nl < 0 ? script.length : nl; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ';' && depth === 0) return `const ${name} =` + script.slice(from, i + 1);
  }
  throw new Error(`const ${name} 没有结尾分号`);
}

const src = [grabConst('isRecord'), grabFn('visibleRoot'), grabFn('cardChips')].join('\n');
check('visibleRoot / cardChips 已抠出', src.includes('function visibleRoot') && src.includes('function cardChips'));
check('可见性逻辑不碰 DOM（可离线跑）', !/\bdocument\b/.test(src));

const state = { hideClosed: false };
const foldedClosed = new Set();
const revealedClosed = new Set();
const api = new Function('state', 'foldedClosed', 'revealedClosed', `${src}
return { visibleRoot, cardChips };`)(state, foldedClosed, revealedClosed);
const { visibleRoot, cardChips } = api;

const mkTree = () => ({
  id: 'ms', kind: 'milestone', closed: false, chips: ['6 目标'],
  children: [
    { id: 'g1', kind: 'goal', closed: true, chips: [], children: [{ id: 'i1', kind: 'idea', closed: true, children: [] }] },
    { id: 'g2', kind: 'goal', closed: false, chips: [], children: [] },
    { id: 'r1', kind: 'exec', action: 'plan', closed: true, raw: { action: 'plan' }, children: [] },
  ],
});
const ids = (root) => (root.children || []).map((k) => k.id);
const idsDeep = (root, out = []) => { (root.children || []).forEach((k) => { out.push(k.id); idsDeep(k, out); }); return out; };

/* 1. 开关关闭：保持原来的折叠行为 */
state.hideClosed = false;
foldedClosed.clear();
revealedClosed.clear();
let v = visibleRoot(mkTree());
check('折叠默认：已闭环目标收起', !ids(v).includes('g1') && ids(v).includes('g2'), JSON.stringify(ids(v)));
check('折叠默认：出「▸ 已闭环 N」的计数', v.hiddenClosed === 1, String(v.hiddenClosed));
check('折叠默认：执行记录已完成的也常驻', ids(v).includes('r1'));
check('折叠默认：chips 不追加已闭环计数', !cardChips(v).some((c) => /已闭环/.test(c)), JSON.stringify(cardChips(v)));

foldedClosed.add('ms');
v = visibleRoot(mkTree());
check('展开折叠行：已闭环目标回来', ids(v).includes('g1'), JSON.stringify(ids(v)));
check('展开折叠行：closedShown 计数', v.closedShown === 1, String(v.closedShown));

/* 2. 开关打开：整颗不渲染，折叠行也不再出，计数上提到 chips */
state.hideClosed = true;
foldedClosed.clear();
revealedClosed.clear();
v = visibleRoot(mkTree());
check('隐藏态：已闭环目标消失', !ids(v).includes('g1'), JSON.stringify(ids(v)));
check('隐藏态：不再出折叠行（hiddenClosed=0）', v.hiddenClosed === 0, String(v.hiddenClosed));
check('隐藏态：执行记录仍常驻', ids(v).includes('r1'));
check('隐藏态：数量上提到卡片 chips', cardChips(v).includes('已闭环 1'), JSON.stringify(cardChips(v)));
check('隐藏态：chips 保留原有条目', cardChips(v).includes('6 目标'));
check('隐藏态：已达成里程碑的根仍返回（泳道主管不消失）', visibleRoot({ ...mkTree(), closed: true }).id === 'ms');

/* 2.5 隐藏态点「已闭环 N」→ 展开这一颗（复用 foldedClosed，等价于开关关闭时的折叠行） */
state.hideClosed = true;
foldedClosed.clear();
revealedClosed.clear();
foldedClosed.add('ms');
v = visibleRoot(mkTree());
check('隐藏态手动展开：已闭环目标回来', ids(v).includes('g1'), JSON.stringify(ids(v)));
check('隐藏态手动展开：仍不出折叠行（计数留在 chips）', v.hiddenClosed === 0, String(v.hiddenClosed));
check('隐藏态展开后 chips 仍带计数（渲染成收起按钮）', cardChips(v).includes('已闭环 1'), JSON.stringify(cardChips(v)));
foldedClosed.clear();

/* 3. 跳转到已闭环节点：临时放行那一颗 */
state.hideClosed = true;
foldedClosed.clear();
revealedClosed.clear();
revealedClosed.add('g1');
v = visibleRoot(mkTree());
check('跳转目标：即使在隐藏态也露出来', ids(v).includes('g1'), JSON.stringify(ids(v)));
check('跳转目标：不把折叠行带回来', v.hiddenClosed === 0, String(v.hiddenClosed));
check('跳转目标：不影响其它闭环节点', !idsDeep(v).includes('i1'), JSON.stringify(idsDeep(v)));

/* 4. 源码结构：工具栏 chip、持久化、点击行为、关闭后的提示口径 */
check('工具栏有「隐藏已闭环」chip', /id="hide-closed"[^>]*aria-pressed="false"/.test(html), '');
check('chip 与「紧凑」同组（显示风格并列）',
  html.indexOf('id="density"') > 0 && html.indexOf('id="density"') < html.indexOf('id="hide-closed"')
  && html.indexOf('id="hide-closed"') < html.indexOf('id="back-to-dsh"'), '');
check('偏好写到 localStorage（rotation.display）', /const PREFS_KEY = 'rotation\.display'/.test(script), '');
check('隐藏已闭环状态存进偏好', /savePrefs\(\{ hideClosed: state\.hideClosed \}\)/.test(script), '');
check('紧凑也进同一份偏好', /savePrefs\(\{ density: on \? 'compact' : 'comfort' \}\)/.test(script), '');
check('启动时从偏好恢复', /state\.hideClosed = !!PREFS\.hideClosed/.test(script) && /dataset\.density = PREFS\.density === 'comfort'/.test(script), '');
check('点击开关后重绘', /#hide-closed'\)\.addEventListener\('click'[\s\S]{0,400}render\(\)/.test(script), '');
check('关掉开关清掉临时放行', /revealedClosed\.clear\(\)/.test(script), '');
/* 5. 已闭环 chip 是按钮：点它展开 / 收起 */
check('已闭环 chip 渲染成按钮（data-reveal）', /data-reveal="\$\{n\.id\}"/.test(script), '');
check('按钮带 aria-expanded 状态', /aria-expanded="\$\{chipsExpanded/.test(script), '');
check('点它切换 foldedClosed 并重绘', /closest\('\[data-reveal\]'\)/.test(script) && /foldedClosed\.add\(nid\)/.test(script) && /foldedClosed\.delete\(nid\)/.test(script), '');
check('可点 chip 有 cursor/hover 样式', /button\.tchip\{font:inherit/.test(html), '');
check('关闭动作的提示区分隐藏态', /已按「隐藏已闭环」收进卡片 chips/.test(script), '');
check('可见树按开关分叉（隐藏态也认 foldedClosed 手动展开）',
  /if \(!forced && !foldedClosed\.has\(n\.id\)\)/.test(script) && !/state\.hideClosed\)\{ hidden\+\+; continue; \}/.test(script), '');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
