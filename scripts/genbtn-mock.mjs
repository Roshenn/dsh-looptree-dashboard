#!/usr/bin/env node
/**
 * scripts/genbtn-mock.mjs — 「生成 N 项」按钮的位置、判据与高亮断言（不需要浏览器）。
 *
 *   node scripts/genbtn-mock.mjs
 *
 * 背景（2026-10-30 用户要求）：补齐缺失项原来只挂在详情卡标题行右侧，节点刚生成时
 * 在卡片上完全看不见。现在按钮落到节点卡 footer，紧跟确认收敛 / 确认达成右侧，
 * 且「缺项 > 0 就高亮」——刚生成的节点天然字段全空，所以亮；补完自动变灰「无缺项」。
 *
 * 做法与 closure-mock 一致：从 web/index.html 抠出纯函数与常量，放进 new Function 里跑。
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

/** 花括号 / 圆括号配对，跳过行注释与字符串——够抠这几个纯函数 */
function grabBlock(source, start) {
  let depth = 0;
  let i = start;
  let quote = '';
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('括号没有闭合');
}

/** 从 `=` 之后扫到深度 0 的分号：箭头函数里的 `;` 在花括号内，不会被当成结尾 */
function scanToSemicolon(source, from) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(from, i + 1);
  }
  throw new Error('没找到结尾分号');
}

/** 按名字抠 `function name(){}` 或 `const name = ...;` */
function grab(name) {
  const fnAt = script.indexOf(`function ${name}(`);
  if (fnAt >= 0) {
    const open = script.indexOf('{', fnAt);
    const block = grabBlock(script, open);
    return script.slice(fnAt, open + block.length);   // 从 open 起算长度，别用 fnAt 加
  }
  const at = script.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`web/index.html 里找不到 ${name}`);
  return `const ${name} =` + scanToSemicolon(script, at + `const ${name} =`.length);
}

// esc 里带正则字面量 /[&<>"']/g，抠源码时容易和字符串引号缠住 → 这里直接给同一实现的替身
const ESC_STUB = `const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');`;

const src = [
  ESC_STUB, grab('isRecord'), grab('isBlankTitle'), grab('FIELD_LABEL'),
  grab('GEN_FIELDS_CLIENT'), grab('genStateOf'), grab('genBtnMarkup'),
].join('\n');
check('genStateOf / genBtnMarkup 已抠出', src.includes('function genStateOf') && src.includes('function genBtnMarkup'));
check('按钮逻辑不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));

const api = new Function(`${src}
return { genStateOf, genBtnMarkup, GEN_FIELDS_CLIENT };`)();
const { genBtnMarkup, GEN_FIELDS_CLIENT } = api;

const node = (kind, raw = {}, title = '示例节点') => ({ id: 'n1', kind, title, raw });
const p = { id: 'p1' };
const msFull = { vision: '愿景', blockers: '1)缺 X', metrics: '1)指标' };
const goalFull = { scenario: '1)操作', constraints: '不改 API', acceptance: 'GET /x 200' };

/* 1. 缺项 → 「生成 N 项」+ 高亮 */
const msEmpty = genBtnMarkup(p, node('milestone', {}));
check('里程碑全空 → 生成 3 项', msEmpty.includes('生成 3 项'), msEmpty);
check('有缺项 → 高亮（is-hot）', msEmpty.includes('genbtn is-hot'), msEmpty);
check('有缺项 → 可点（不带 disabled）', !msEmpty.includes('disabled'), msEmpty);
check('里程碑缺项顺序 = 愿景 / 阻碍 / 指标', /里程碑愿景、阻碍项、核心指标/.test(msEmpty), msEmpty);
const goalHalf = genBtnMarkup(p, node('goal', { scenario: '1)操作' }));
check('目标缺 2 项 → 生成 2 项且高亮', goalHalf.includes('生成 2 项') && goalHalf.includes('is-hot'), goalHalf);

/* 2. 补完 → 灰显「无缺项」、不再高亮 */
const msDone = genBtnMarkup(p, node('milestone', msFull));
check('里程碑补完 → 无缺项', msDone.includes('无缺项'), msDone);
check('补完 → 不亮', !msDone.includes('is-hot'), msDone);
check('补完 → disabled', msDone.includes('disabled'), msDone);
check('目标补完 → 无缺项', genBtnMarkup(p, node('goal', goalFull)).includes('无缺项'));

/* 3. 没标题 → 灰「生成」；没有可补字段的节点 → 不出现 */
const noTitle = genBtnMarkup(p, { id: 'n1', kind: 'goal', title: '新目标（待命名）', raw: {} });
check('标题是占位名 → 灰「生成」', noTitle.includes('>生成<') && noTitle.includes('disabled'), noTitle);
check('构思没有可补字段 → 不出按钮', genBtnMarkup(p, node('idea', {})) === '');
check('执行记录不出按钮', genBtnMarkup(p, { id: 'r1', kind: 'exec', title: '执行', raw: { action: 'plan' } }) === '');
check('字段表：构思没有可补字段、执行记录只补 verify', GEN_FIELDS_CLIENT.idea.length === 0 && GEN_FIELDS_CLIENT.exec.join() === 'verify', JSON.stringify(GEN_FIELDS_CLIENT));

/* 4. 源码结构：卡片 footer 里「确认收敛 → 生成 N 项」的顺序、详情标题行不再挂它 */
const leadAt = script.indexOf('const leadKids = [closeBtn, genBtn]');
check('节点卡 footer：生成项紧跟确认收敛右侧', leadAt > 0, String(leadAt));
const detailHead = script.slice(script.indexOf('<div class="detail-path-row">'), script.indexOf('</div>', script.indexOf('<div class="detail-path-row">')) + 6);
check('详情卡标题行不再挂「生成」按钮', !detailHead.includes('genBtn'), detailHead.slice(0, 120));
const actsAt = script.indexOf('const acts = [');
const actsBlock = script.slice(actsAt, script.indexOf("].filter(Boolean).join('')", actsAt));
check('详情卡动作行保留「生成」按钮（紧跟确认）',
  actsBlock.includes('convergeBtnMarkup') && actsBlock.includes('genBtn,')
  && actsBlock.indexOf('convergeBtnMarkup') < actsBlock.indexOf('genBtn,'), actsBlock.slice(0, 140));
check('节点卡只给容器卡挂这个按钮', script.includes('const genBtn = (isContainer && p) ? genBtnMarkup(p, n) : \'\''), '');
check('高亮样式 .genbtn.is-hot 已定义', /\.genbtn\.is-hot\{/.test(html), '');

/* 5. 生成完成后按钮换挡：generateMissing 写卡片后会整页 render()，按钮按新字段重算 */
check('generateMissing 写入后触发 render()', /fillApplied[\s\S]{0,1200}render\(\)/.test(script), '');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
