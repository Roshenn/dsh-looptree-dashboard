#!/usr/bin/env node
/**
 * scripts/awaiting-mock.mjs — 「会话等你选择」的判定、托盘列表与接线断言（不需要浏览器）。
 *
 *   node scripts/awaiting-mock.mjs
 *
 * 背景（2026-11-02 用户要求）：会话卡在 ask_user_question 这类交互上时，面板要立刻看得见——
 * 节点呼吸高亮、「查看会话」变主色、右下角「待处理 N」托盘可一键切进那条会话。
 *
 * 判据只有一条：host 的 runner 在 tool/call 里看到 INTERACTIVE_TOOLS 的工具调用就标 awaiting。
 * 不做「安静太久」的启发式（宁可漏报，不把长任务误标成在等人）。
 *
 * 做法沿用 refresh-mock：从 web/index.html 抠出纯函数跑断言，再看 runner.mjs / index.html 的源码文本。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const script = html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];
const runner = readFileSync(join(ROOT, 'lib', 'runner.mjs'), 'utf8');

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

function grab(name) {
  const fnAt = script.indexOf(`function ${name}(`);
  if (fnAt < 0) throw new Error(`web/index.html 里找不到 ${name}`);
  const open = script.indexOf('{', fnAt);
  return script.slice(fnAt, open + grabBlock(script, open).length);
}

const src = [grab('awaitingRuns'), grab('waitText')].join('\n');
check('awaitingRuns / waitText 已抠出', src.includes('function awaitingRuns') && src.includes('function waitText'));
check('判定函数不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));

// findNode 是页面里的树查找；这里给个等价的最小实现，避免把整棵树搬进来
const tree = { id: 'root', title: '里程碑', children: [{ id: 'cap-1', title: '小红书风控规避', children: [] }] };
const findNode = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  for (const kid of node.children || []) { const hit = findNode(kid, id); if (hit) return hit; }
  return null;
};
const api = new Function('findNode', `${src}
return { awaitingRuns, waitText };`)(findNode);

const projects = [{ id: 'p1', file: 'xiaohongshu.rotation.json', name: '需求收集闭环', root: tree }];
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const run = (extra = {}) => ({
  key: 'xiaohongshu.rotation.json::cap-1', file: 'xiaohongshu.rotation.json', projectId: 'p1',
  nodeId: 'cap-1', sessionId: 'session-abc', status: 'running', awaiting: true,
  startedAt: iso(600000), ask: { tool: 'ask_user_question', at: iso(120000), question: '「登录态复用」这一层用哪种实现？', options: ['保留 CDP', 'storageState', 'CDP + 兜底'], questions: 1 },
  ...extra,
});

/* ── 1. 过滤：只有 awaiting 的活跃 run 进托盘 ── */
check('awaiting + running → 进托盘', api.awaitingRuns([run()], projects).length === 1);
check('没有 awaiting 的不进', api.awaitingRuns([run({ awaiting: false })], projects).length === 0);
check('awaiting 但会话已终态 → 不进', api.awaitingRuns([run({ status: 'done' })], projects).length === 0);
check('stale（进程已不在）→ 不进', api.awaitingRuns([run({ status: 'stale' })], projects).length === 0);
check('starting 也算活跃', api.awaitingRuns([run({ status: 'starting' })], projects).length === 1);

/* ── 2. 同一会话去重 + 标题兜底 ── */
check('同一 sessionId 只留一条', api.awaitingRuns([run(), run({ key: 'dup' })], projects).length === 1);
const row = api.awaitingRuns([run()], projects)[0];
check('项目名取卡片名', row.projectName === '需求收集闭环', row.projectName);
check('节点标题取节点 title', row.nodeTitle === '小红书风控规避', row.nodeTitle);
check('问题与选项数透传', row.question.includes('登录态复用') && row.options === 3, `${row.question} / ${row.options}`);
check('节点已被删时用 nodeId 兜底', api.awaitingRuns([run({ nodeId: 'gone' })], projects)[0].nodeTitle === 'gone');

/* ── 3. 排序 + 等待时长 ── */
const older = run({ sessionId: 's-old', ask: { at: iso(300000), question: 'A' } });
const newer = run({ sessionId: 's-new', ask: { at: iso(10000), question: 'B' } });
const sorted = api.awaitingRuns([newer, older], projects);
check('等得久的排前面', sorted[0].sessionId === 's-old', sorted.map((x) => x.sessionId).join(','));
check('等待时长按 ask.at 算', sorted[0].waitedMs > 280000 && sorted[0].waitedMs < 320000, String(sorted[0].waitedMs));
check('ask.at 缺失时退回 startedAt', api.awaitingRuns([run({ ask: { question: 'Q' } })], projects)[0].waitedMs > 500000);

/* ── 4. 时长文案 ── */
check('45 秒', api.waitText(45000) === '等 45 秒', api.waitText(45000));
check('2 分 13 秒', api.waitText(133000) === '等 2 分 13 秒', api.waitText(133000));
check('1 小时 5 分', api.waitText(3900000) === '等 1 小时 5 分', api.waitText(3900000));

/* ── 5. host 半：判定与清除 ── */
check('runner 只认 ask_user_question 这一族工具', /INTERACTIVE_TOOLS = new Set\(\['ask_user_question'\]\)/.test(runner));
check('tool/call 命中就标 pendingAsk', /if \(type === 'tool\/call'\)\s*\{[\s\S]{0,200}run\.pendingAsk = ask/.test(runner));
check('askOf 抠问题与选项（字段缺就留空）', /function askOf\(/.test(runner) && /questions\[0\]/.test(runner) && /options\.slice\(0, 6\)/.test(runner));
check('用户回话 / 新回合 / 回合结束都清除', /type === 'user\/message' \|\| type === 'turn\/start' \|\| type === 'turn\/end'/.test(runner));
check('工具结果按 callId 匹配才清', /type === 'tool\/result' && \(!run\.pendingAsk\.callId/.test(runner));
check('会话收尾也清除（finish）', /run\.pendingAsk = null;\s+\/\/ 会话收尾了/.test(runner));
check('snapshot 暴露 awaiting / ask', /awaiting: !!run\.pendingAsk && !TERMINAL\.has\(run\.status\)/.test(runner) && /ask: run\.pendingAsk \|\| null/.test(runner));

/* ── 6. 面板半：高亮与托盘的接线 ── */
check('节点呼吸高亮样式（data-ask）', /\.tnode\[data-ask="1"\]\{/.test(html) && /@keyframes askBreathe/.test(html));
check('「查看会话」等你选择时变主色', /data-ask-btn="1"/.test(html) && /\.tbtn\[data-ask-btn="1"\]/.test(html));
check('reduced-motion 下不呼吸', /@media \(prefers-reduced-motion:reduce\)\{[\s\S]{0,160}\.tnode\[data-ask="1"\]/.test(html));
check('卡片徽标「等你选择」', /askbad/.test(html) && /⏳ 等你选择/.test(html));
check('轮询只改属性、不重建 DOM', /if \(r && r\.awaiting\) el\.dataset\.ask = '1'; else delete el\.dataset\.ask;/.test(script));
check('托盘 DOM 存在且默认隐藏', /<aside class="asktray" id="ask-tray" hidden/.test(html));
check('托盘随 run 快照刷新', /paintIdle\(\);[\s\S]{0,160}paintAskTray\(\)/.test(script));
check('重绘后托盘标题跟着更新', /paintUpdatedMarkers\(\);[\s\S]{0,140}paintAskTray\(\)/.test(script));
check('首帧没 run 时补出「查看会话」按钮', /if \(r && r\.awaiting && !sessBtn\)\{[\s\S]{0,320}data-ask-btn="1"/.test(script));
check('点托盘行直接切会话', /\[data-ask-jump\][\s\S]{0,120}openInDsh\(askJump\.dataset\.askJump\)/.test(script));
check('折叠状态持久化', /rotation\.askTray\.collapsed/.test(script) && /applyAskTrayCollapsed\(\)/.test(script));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
