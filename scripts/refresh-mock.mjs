#!/usr/bin/env node
/**
 * scripts/refresh-mock.mjs — 「会话完成 → 自动刷新 + 新角标」的纯函数与接线断言（不需要浏览器）。
 *
 *   node scripts/refresh-mock.mjs
 *
 * 背景（2026-10-31 用户反馈）：会话跑完面板不刷新，要切走插件再切回来才更新。
 * 现在由全局 /api/runs 快照对比驱动：首次进入终态的 run → 重拉卡片 + 打「新」角标。
 * 这里沿用 genbtn/list-fields 的手法，从 web/index.html 抠出 diffRuns / diffStamps 跑断言，
 * 再用源码文本确认「谁在什么时候调用了刷新」。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const script = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/** 花括号配对，跳过行注释与字符串 */
function grabBlock(source, start) {
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i += 1) {
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

/** 从 `=` 之后扫到深度 0 的分号 */
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

const src = [grab('TERMINAL_RUN'), grab('runIdOf'), grab('diffRuns'), grab('diffStamps')].join('\n');
check('diffRuns / diffStamps 已抠出', src.includes('function diffRuns') && src.includes('function diffStamps'));
check('判定函数不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));

const api = new Function(`${src}
return { TERMINAL_RUN, runIdOf, diffRuns, diffStamps };`)();

/* ── 1. diffRuns：只报首次进入终态的 run ── */
const run = (key, status, extra = {}) => ({ key, status, nodeId: 'n-' + key, settling: false, startedAt: '2026-10-31T14:00:00.000Z', sessionId: 's-' + key, ...extra });
const prevWith = (pairs) => new Map(pairs.map(([r, status]) => [api.runIdOf(r), status]));
const before = (status, extra = {}) => prevWith([[run('a', status, extra), status]]);
check('running → done 报一次', api.diffRuns(before('running'), [run('a', 'done')]).length === 1);
check('同一个终态不重复报', api.diffRuns(prevWith([[run('a', 'done'), 'done']]), [run('a', 'done')]).length === 0);
check('settling 期间不报（卡片还没写完）', api.diffRuns(before('running'), [run('a', 'done', { settling: true })]).length === 0);
check('failed 也算终态', api.diffRuns(before('running'), [run('a', 'failed')]).length === 1);
check('cancelled 也算终态', api.diffRuns(before('starting'), [run('a', 'cancelled')]).length === 1);
check('仍在跑的不报', api.diffRuns(before('running'), [run('a', 'running')]).length === 0);
check('同一节点起第二次会话（key 复用）不算重复', (() => {
  const first = run('a', 'done', { startedAt: '2026-10-31T14:00:00.000Z', sessionId: 's1' });
  const second = run('a', 'done', { startedAt: '2026-10-31T14:05:00.000Z', sessionId: 's2' });
  return api.diffRuns(prevWith([[first, 'done']]), [second]).length === 1;
})());
check('多条里只挑转终态的', api.diffRuns(prevWith([[run('a', 'running'), 'running'], [run('b', 'done', { sessionId: 's-b' }), 'done']]), [run('a', 'done'), run('b', 'done', { sessionId: 's-b' })]).length === 1);

/* ── 2. diffStamps：外部改动检测 ── */
check('空基线 → 全部报（首次只建基线，由调用方决定）', api.diffStamps(new Map(), { a: 1, b: 2 }).length === 2);
check('mtime 相同 → 不报', api.diffStamps(new Map([['a', 1]]), { a: 1 }).length === 0);
check('mtime 变了 → 报那个 file', JSON.stringify(api.diffStamps(new Map([['a', 1], ['b', 2]]), { a: 9, b: 2 })) === '["a"]');
check('新出现的卡也算变化', api.diffStamps(new Map([['a', 1]]), { a: 1, c: 3 }).length === 1);

/* ── 3. 接线：谁触发刷新 ── */
check('快照对比后调 scheduleCardRefresh', /const settled = diffRuns\(PREV_RUN_STATUS, list\)[\s\S]{0,900}scheduleCardRefresh\(ids, tone\)/.test(script));
check('首帧只建基线（历史终态不闪角标）', /if \(!runBaselineReady\)\{[\s\S]{0,400}SETTLED_SEEN\.add\(runIdOf\(r\)\)/.test(script));
check('切回前台会重拉卡片', /addEventListener\('visibilitychange'[\s\S]{0,500}reloadProjects\(\)/.test(script));
check('自己写盘后对齐 stamp 基线', /markSave\([\s\S]{0,300}syncStampBaseline\(\)/.test(script));
check('空闲 10s 轮询 stamp', /setInterval\(pollStamps, 10000\)/.test(script));
check('host 注册了 /cards/stamp', host.includes("`${api}/cards/stamp`"));
check('页脚有「已更新」入口', /id="fresh-jump"/.test(html) && /function refreshFooterFresh\(/.test(script));
check('已更新标记保留到点开（markNodeRead）', /function markNodeRead\(/.test(script) && /markNodeRead\(nodeEl\.dataset\.nid\)/.test(script));
check('高亮样式在卡片上（data-updated）', /\.tnode\[data-updated="ok"\]/.test(html) && /@media \(prefers-reduced-motion:reduce\)\{[\s\S]{0,120}data-updated/.test(html));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
