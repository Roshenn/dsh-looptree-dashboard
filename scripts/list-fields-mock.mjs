#!/usr/bin/env node
/**
 * scripts/list-fields-mock.mjs — 「一条一行」在生成端与编辑端的口径断言（不需要浏览器）。
 *
 *   node scripts/list-fields-mock.mjs
 *
 * 背景（2026-10-30 用户反馈）：补全列表字段时，模型用 `○` 前缀 + 单换行写了 5 条，
 * 而条目编辑器只认「1) / A. / -」这类标记，认不出 `○` 就退回 plain 模式（只按空行切），
 * 整段被当成一条融合块。两处一起修：
 *   生成端：列表字段（重要支撑 supports 等）改 JSON 数组契约，
 *           host 侧 normalizeListValue() 拼成「一条一行、每行带序号」
 *   编辑端：ITEM_RE 扩到 ○ ◯ · • ▪ ◦ ①②③，打开编辑器就能把旧融合块拆开（不改存量数据）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_FIELDS, normalizeListValue } from '../lib/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const script = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/** ITEM_RE / ORDINAL_PREFIX_RE 都是单行声明：按行取整行，别用括号配对（正则字符类里有 ) 和 ]） */
function grabConst(name) {
  const at = script.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`web/index.html 里找不到 const ${name}`);
  const nl = script.indexOf('\n', at);
  return script.slice(at, nl < 0 ? script.length : nl).trim();
}
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

const src = [grabConst('ITEM_RE'), grabConst('ORDINAL_PREFIX_RE'), grabFn('stripOrdinalPrefix'), grabFn('parseItems'), grabFn('serializeItems')].join('\n');
check('parseItems / ITEM_RE 已抠出', src.includes('function parseItems') && src.includes('const ITEM_RE'));
check('解析逻辑不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));
const { parseItems, serializeItems } = new Function(`${src}
return { parseItems, serializeItems };`)();

/* ── 1. 生成端：列表字段 → 一条一行、每行带序号 ── */
check('列表字段清单含重要支撑 supports、不再含里程碑 metrics', LIST_FIELDS.has('supports') && !LIST_FIELDS.has('metrics'), JSON.stringify([...LIST_FIELDS]));

const arr = ['缺分层采样（无 LOD 计算）→ 挡在「首屏 < 800ms」', '缺章节索引（src/plot/index.ts 无实现）→ 挡在「打开即见三层图」'];
check('数组 → 一条一行且补序号', normalizeListValue(arr) === '1)缺分层采样（无 LOD 计算）→ 挡在「首屏 < 800ms」\n2)缺章节索引（src/plot/index.ts 无实现）→ 挡在「打开即见三层图」', normalizeListValue(arr));
check('supports（重要支撑）走同一条一条一行口径',
  normalizeListValue(['章节→情节两层索引（src/plot/index.ts）→ 挡住「打开即见三层图」', '分层 SVG 绘制（每层一个 <g>）→ 挡住「首屏 < 800ms」'])
  === '1)章节→情节两层索引（src/plot/index.ts）→ 挡住「打开即见三层图」\n2)分层 SVG 绘制（每层一个 <g>）→ 挡住「首屏 < 800ms」',
  JSON.stringify(normalizeListValue(['章节→情节两层索引（src/plot/index.ts）→ 挡住「打开即见三层图」', '分层 SVG 绘制（每层一个 <g>）→ 挡住「首屏 < 800ms」'])));
check('元素内换行被压平（一条一行）', !normalizeListValue(['缺 A，\n确实没有', '缺 B']).includes('\n\n') && normalizeListValue(['缺 A，\n确实没有', '缺 B']).split('\n').length === 2, JSON.stringify(normalizeListValue(['缺 A，\n确实没有', '缺 B'])));
check('已带序号/符号的元素统一重编号', normalizeListValue(['1) 缺 A', '○缺 B']) === '1)缺 A\n2)缺 B', JSON.stringify(normalizeListValue(['1) 缺 A', '○缺 B'])));
check('混用 ○ 与 1) 不会漏成「○缺…\\n2)…」', !/○/.test(normalizeListValue(['○缺 A', '2)缺 B'])), JSON.stringify(normalizeListValue(['○缺 A', '2)缺 B'])));
check('小数开头不被当成序号', normalizeListValue(['1.5 倍性能差距', '缺 B']) === '1)1.5 倍性能差距\n2)缺 B', JSON.stringify(normalizeListValue(['1.5 倍性能差距', '缺 B'])));
check('以数字开头的正文不被误剥', normalizeListValue(['89 份存量语料仍 legacy']) === '1)89 份存量语料仍 legacy', JSON.stringify(normalizeListValue(['89 份存量语料仍 legacy'])));
check('旧字符串多行无标记 → 按行补号（防融合）', normalizeListValue('缺 A\n缺 B\n缺 C') === '1)缺 A\n2)缺 B\n3)缺 C', normalizeListValue('缺 A\n缺 B\n缺 C'));
check('空值 → 空串', normalizeListValue('') === '' && normalizeListValue([]) === '' && normalizeListValue(null) === '');
check('单行字符串补号（列表字段统一带序号）', normalizeListValue('缺 A') === '1)缺 A', normalizeListValue('缺 A'));

/* ── 2. 编辑端：符号标记也要能拆条目 ── */
const fused = '○89 份存量语料仍 legacy: 阅读/词频顺序 503\n○全局词频数据集未发布 (report.json:18 BLOCKED)\n○小程序无真机证据 (A11/A15 INCOMPLETE)\n○FREQUENCY_BUILD_ENABLED=false: 派生不入队\n○A05/A14 缺 OSS 故障注入与回滚演练';
const parsedFused = parseItems(fused);
check('○ 前缀 + 单换行 → 拆成 5 条', parsedFused.mode === 'numbered' && parsedFused.items.length === 5, `${parsedFused.mode}/${parsedFused.items.length}`);
check('○ 前缀被剥掉，条目不残留符号', parsedFused.items[0].content.startsWith('89 份存量语料'), parsedFused.items[0].content);
check('保存时按原符号风格归一（○ → 短横线）', serializeItems(parsedFused, parsedFused.items).split('\n')[1].startsWith('- '), serializeItems(parsedFused, parsedFused.items).split('\n')[1]);
check('① 前缀也算标记', parseItems('①缺 A\n②缺 B').items.length === 2, String(parseItems('①缺 A\n②缺 B').items.length));
check('· / ▪ 前缀也算标记', parseItems('·缺 A\n▪缺 B').items.length === 2, String(parseItems('·缺 A\n▪缺 B').items.length));
check('无任何标记的换行仍是 plain（不误拆手写长条目）', parseItems('缺 A\n缺 B').items.length === 1, String(parseItems('缺 A\n缺 B').items.length));
check('1) 2) 3) 仍是 numbered 三条', parseItems('1)缺 A\n2)缺 B\n3)缺 C').items.length === 3);
check('CRLF 也被拆成多条', parseItems('○缺 A\r\n○缺 B').items.length === 2, String(parseItems('○缺 A\r\n○缺 B').items.length));
const round = parseItems(serializeItems(parseItems(fused), parseItems(fused).items));
check('round-trip 条数不变', round.items.length === 5, String(round.items.length));

/* ── 3. 接线：host 回填走 normalizeListValue，prompt 契约是数组 ── */
const index = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const prompt = readFileSync(join(ROOT, 'lib', 'prompt.mjs'), 'utf8');
check('host 回填对列表字段（含 supports）做归一', /LIST_FIELDS\.has\(field\)[\s\S]{0,40}?normalizeListValue\(patch\[field\]\)/.test(index), '');
check('fill prompt 用数组契约（列表字段）', prompt.includes('["…", "…"]') && prompt.includes('LIST_FIELDS_ALL.has(f)'), '');
check('fill prompt 的列表字段集合包含 supports', prompt.includes('LIST_FIELDS_ALL') && /supports/.test(prompt), '');
check('fill prompt 写明一条一个元素', prompt.includes('一条一个元素'), '');
check('fill prompt 禁止符号前缀', prompt.includes('行首不要加 ○ · • 这类符号'), '');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
