#!/usr/bin/env node
/**
 * scripts/candtip-mock.mjs — 候选池「悬浮详情卡」内容断言（不需要浏览器）。
 *
 *   node scripts/candtip-mock.mjs
 *
 * 候选行在面板上只留 序号 + 重要性 + 标题 + 承接条目 + 模块徽标；其余字段
 * 放进 body 级悬浮卡 #cand-tip，避免把弹窗撑爆。这里沿用 genbtn/list-fields 的手法：
 * 从 web/index.html 抠出 candTipHtml / candImpOf / candRowHtml 纯函数，放进 new Function 跑。
 *
 * 断言：
 *   · candTipHtml 含 承接能力闭环 / 必要性 / 与闭环的关系 / 缺失影响 / 功能模块 / 协同面 / 证据；
 *   · 所有字段都过 esc：<script> 标签不会原样进 HTML；
 *   · 空字段降级成「（未生成）」，重要性缺失同样降级；
 *   · candRowHtml 不再展示 acceptance / strength，缺承接支撑项时给降级文案；
 *   · 悬浮卡是 body 级单例（#cand-tip，position:fixed、z-index:51），悬停 / 聚焦有委托。
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
    return script.slice(fnAt, open + block.length);
  }
  const at = script.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`web/index.html 里找不到 ${name}`);
  return `const ${name} =` + scanToSemicolon(script, at + `const ${name} =`.length);
}

// esc 里带正则字面量 /[&<>"']/g，抠源码时容易和字符串引号缠住 → 这里给同一实现的替身
const ESC_STUB = `const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));`;
// candRowHtml 只依赖 candUid 生成行内唯一 id，这里给等价替身（原实现是模块级计数器）
const UID_STUB = `let CAND_UID = 0;
const candUid = (c) => c.__uid || (c.__uid = ++CAND_UID);
const MODULE_MODE_LABEL = { existing: '改造现有', new: '新增' };`;

const rowSrc = [
  ESC_STUB, UID_STUB, grab('candImpOf'), grab('candTipHtml'), grab('candRowHtml'),
].join('\n');
check('candTipHtml / candRowHtml 已抠出', rowSrc.includes('function candTipHtml') && rowSrc.includes('const candRowHtml ='));
check('悬浮卡逻辑不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(rowSrc));

const api = new Function(`${rowSrc}
return { candTipHtml, candRowHtml, candImpOf };`)();

/* ── 1. 内容：承接 / 必要性 / 与闭环的关系 / 缺失影响 / 功能模块 / 协同面 / 证据 ── */
const full = {
  title: '统一索引层',
  capability: '章节→情节两层索引',
  necessity: '没有索引，情节图只能读临时数据',
  causal: '索引落地后，情节图第一次能挂在真实章节上',
  gap: '缺它三层图没有数据源，评审只能看截图',
  module: 'src/plot/index.ts（情节索引层）',
  module_mode: 'existing',
  collaboration: '读章节源文件；向渲染层提供 plot tree',
  evidence: 'src/plot/index.ts:1',
  importance: 4,
};
const tip = api.candTipHtml(full);
check('悬浮卡含「承接能力闭环」', tip.includes('承接能力闭环'), tip.slice(0, 120));
check('悬浮卡含「必要性」', tip.includes('必要性'), '');
check('悬浮卡含「与闭环的关系」', tip.includes('与闭环的关系'), '');
check('悬浮卡含「缺失影响」', tip.includes('缺失影响'), '');
check('悬浮卡含「功能模块」与改造/新增', tip.includes('功能模块') && tip.includes('改造现有'), '');
check('悬浮卡含「协同面」', tip.includes('协同面'), '');
check('悬浮卡含「证据」', tip.includes('证据'), '');
check('悬浮卡显示重要度 4 / 5（并写明越大越先做）', tip.includes('重要度') && tip.includes('4 / 5') && tip.includes('越大越先做'), tip.slice(0, 140));
check('缺失影响与模块原文都进了卡', tip.includes('缺它三层图没有数据源') && tip.includes('src/plot/index.ts'), '');

/* ── 2. XML 转义：标签不会原样进 HTML ── */
const nasty = {
  title: '<script>alert(1)</script>',
  capability: '<b>能力</b>',
  necessity: 'need <img src=x onerror=alert(1)>',
  causal: 'cause & "quote"',
  gap: '<i>gap</i>',
  module: '<u>mod</u>',
  collaboration: '<s>col</s>',
  evidence: '<i>ev</i>',
  importance: 2,
};
const nastyTip = api.candTipHtml(nasty);
check('标题里的 <script> 被转义', nastyTip.includes('&lt;script&gt;') && !nastyTip.includes('<script>'), nastyTip.slice(0, 160));
check('正文里的 <b> 被转义', !nastyTip.includes('<b>') && !nastyTip.includes('<img') && !nastyTip.includes('<i>'), nastyTip);
check('& 与引号也被转义', nastyTip.includes('&amp;') && nastyTip.includes('&quot;'), nastyTip);

/* ── 3. 空字段降级：「（未生成）」── */
const sparse = api.candTipHtml({ title: '只有标题' });
check('空字段降级成「（未生成）」', (sparse.match(/（未生成）/g) || []).length >= 4, String((sparse.match(/（未生成）/g) || []).length));
check('重要度缺失降级成「（未评分）」', /重要度\s*（未评分）/.test(sparse), sparse.slice(0, 120));
check('只传空对象也不崩', api.candTipHtml(null).includes('（未生成）') && api.candTipHtml({}).includes('（未命名）'), api.candTipHtml(null).slice(0, 80));

/* ── 4. 候选行：瘦身 + 不再含退役字段 ── */
const row = api.candRowHtml(full, { id: 'p1' }, { id: 'n1' }, 0);
check('候选行含重要度 / 标题 / 承接条目 / 模块徽标', row.includes('重要度 4') && !row.includes('cand-idx') && row.includes('统一索引层') && row.includes('章节→情节两层索引') && row.includes('cand-mod'), row.slice(0, 260));
check('候选行不再显示名次（避免两个数字叠在一起）', !/cand-idx|>1<\/span>\s*<span class="cand-imp"/.test(row), row.slice(0, 200));
check('候选行含添加 / 删除操作', row.includes('data-cand-adopt') && row.includes('data-cand-del'), '');
check('候选行不再含退役的 acceptance / strength', !row.includes('acceptance') && !row.includes('strength'), row);
check('候选行标题同样过 esc', !api.candRowHtml(nasty, { id: 'p' }, { id: 'n' }, 0).includes('<script>'), '');
const rowSparse = api.candRowHtml({ title: 'x' }, { id: 'p' }, { id: 'n' }, 0);
check('候选行缺承接条目 → 降级文案', rowSparse.includes('承接能力闭环未生成'), rowSparse.slice(0, 160));
check('候选行缺模块 → 降级文案', rowSparse.includes('模块未标注'), rowSparse.slice(0, 200));

/* ── 5. 结构：body 级单例 + 悬停 / 聚焦委托 ── */
check('页面有 #cand-tip 单例', /id="cand-tip"/.test(html), '');
check('#cand-tip 是 fixed + z-index 51（不被弹窗裁掉）', /#cand-tip\{[^}]*position:fixed[^}]*z-index:51/.test(html), '');
check('悬停 / 聚焦有委托', script.includes("addEventListener('mouseover'") && script.includes("addEventListener('focusin'") && script.includes('hideCandTip'), '');
check('悬浮卡显隐走 data-show 过渡', html.includes('#cand-tip[data-show="true"]'), '');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
