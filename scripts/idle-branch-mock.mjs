#!/usr/bin/env node
/**
 * scripts/idle-branch-mock.mjs — 「空闲分支」（可开工）判定的断言。
 *
 *   node scripts/idle-branch-mock.mjs
 *
 * 背景：并行规范里已经有一条「上游节点在跑时，下游节点起不了会话」。面板要把同一条判定
 * 翻过来用：没在跑、祖先也没在跑的分支高亮成「可开工」。判定逻辑是 web/index.html 里的
 * 纯函数 idleModelOf()，这里把它抠出来跑断言，不需要浏览器。
 *
 * 验证点：
 *   1) 单条分支的项目：在跑 → none，空闲 → modest（永远不做强高亮）
 *   2) ≥2 条分支：空闲的强高亮（strong），在跑的不进空闲集合
 *   3) 祖先在跑 → 后代 frozen，不算空闲（子集不能接活）
 *   4) 已关闭节点、执行记录不算分支
 *   5) 有未处置 issues → blocked，不算空闲（红边已经在提示）
 *   6) 全部关闭 → 0 条分支
 *   7) 两个项目各自判定，互不影响
 *   8) 源码结构：卡片带 data-idle、泳道带 lane-live、paintRunBadges 会刷新空闲状态
 */
import { readFile } from 'node:fs/promises';

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

/** 从面板源码里抠出一个完整函数（面板跑在浏览器里，这里只取纯函数） */
function extractFn(source, name) {
  const head = `function ${name}(`;
  const at = source.indexOf(head);
  if (at < 0) throw new Error(`web/index.html 里找不到 ${name}()`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {          // 行注释里的括号不算
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${name}() 的括号没有闭合`);
}

const kindsLine = /const IDLE_KINDS = \[[^\]]*\];/.exec(html);
ok('IDLE_KINDS 已定义（里程碑 / 支撑项）', !!kindsLine && kindsLine[0].includes("'support'"), kindsLine ? kindsLine[0] : '未找到');

const src = extractFn(html, 'idleModelOf');
ok('idleModelOf() 已抠出', src.includes('ancestorBusy'));
ok('判定函数不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));

// eslint-disable-next-line no-new-func
const idleModelOf = new Function(`${kindsLine[0]}\n${src}\nreturn idleModelOf;`)();

/* ─── 构造节点：closed / issues / children，够判定用 ─── */
const node = (id, kind, { closed = false, issues = 0, kids = [] } = {}) => ({
  id, kind, closed, children: kids,
  issues: Array.from({ length: issues }, (_, i) => ({ text: `issue-${i}` })),
});
const project = (root) => ({ root });
const none = () => false;
const hasIssue = (n) => (n.issues || []).length > 0;
const ids = (rows) => rows.map((r) => r.node.id).join(',');

/* ─── 1) 单条分支：在跑 ＝ 完全不亮 ─── */
const single = project(node('m', 'milestone'));
const mBusy = idleModelOf(single, () => true, none);
ok('单条分支在跑 → mode=none', mBusy.mode === 'none', mBusy.mode);
ok('单条分支在跑 → 空闲 0 条', mBusy.idle.length === 0, ids(mBusy.idle));
ok('单条分支在跑 → 记录为 running', mBusy.running.length === 1 && mBusy.running[0].node.id === 'm');

/* ─── 2) 单条分支：空闲 ＝ 弱强调 ─── */
const mIdle = idleModelOf(single, none, none);
ok('单条分支空闲 → mode=modest', mIdle.mode === 'modest', mIdle.mode);
ok('单条分支空闲 → 空闲 1 条且是里程碑', mIdle.idle.length === 1 && mIdle.idleIds.has('m'));

/* ─── 3) 两条分支：一条在跑，另一条强高亮 ─── */
const pair = project(node('m', 'milestone', { kids: [node('s1', 'support'), node('s2', 'support')] }));
const mPair = idleModelOf(pair, (n) => n.id === 's2', none);
ok('两条分支 → mode=strong', mPair.mode === 'strong', mPair.mode);
ok('在跑的 s2 记 running，且不在空闲集合', mPair.running.length === 1 && !mPair.idleIds.has('s2'));
ok('有子节点在跑 → 里程碑不算空闲（只剩 s1）', !mPair.idleIds.has('m') && mPair.idleIds.has('s1'), [...mPair.idleIds].join(','));
ok('父节点记 descendant-running', mPair.rows.find((r) => r.node.id === 'm').state === 'descendant-running');

/* ─── 3b) 子节点在跑时，父节点不再出现「可开工」（否则一边可开工、一边子集在跑，自相矛盾） ─── */
const runningKid = project(node('m', 'milestone', { kids: [node('s1', 'support'), node('s2', 'support')] }));
const mRunningKid = idleModelOf(runningKid, (n) => n.id === 's1', none);
ok('一个子节点在跑 → 父节点 descendant-running', mRunningKid.rows.find((r) => r.node.id === 'm').state === 'descendant-running');
ok('另一个没跑的子节点仍可开工', mRunningKid.idleIds.has('s2') && !mRunningKid.idleIds.has('m'), [...mRunningKid.idleIds].join(','));

/* ─── 3c) 更深一层在跑 → 祖先也不算可开工（执行记录不在分支里，但会把忙碌往上带） ─── */
const nested = project(node('m', 'milestone', { kids: [node('s1', 'support', { kids: [node('e1', 'exec')] })] }));
const mNested = idleModelOf(nested, (n) => n.id === 'e1', none);
ok('执行记录在跑 → 支撑项 descendant-running', mNested.rows.find((r) => r.node.id === 's1').state === 'descendant-running');
ok('执行记录在跑 → 里程碑 descendant-running', mNested.rows.find((r) => r.node.id === 'm').state === 'descendant-running');
ok('子孙在跑 → 整条链都不算空闲', mNested.idle.length === 0 && mNested.mode === 'none', [...mNested.idleIds].join(','));

/* ─── 3d) 子节点跑完 → 父节点重新变回可开工 ─── */
const mKidDone = idleModelOf(runningKid, none, none);
ok('子节点全部跑完 → 父节点重新 idle', mKidDone.idleIds.has('m') && mKidDone.mode === 'strong', [...mKidDone.idleIds].join(','));

/* ─── 4) 祖先在跑 → 后代 frozen，不算空闲（并行规范的核心） ─── */
const mFrozen = idleModelOf(pair, (n) => n.id === 'm', none);
ok('里程碑在跑 → 支撑项全部 frozen', mFrozen.rows.filter((r) => r.state === 'frozen').length === 2, JSON.stringify(mFrozen.rows.map((r) => r.state)));
ok('里程碑在跑 → 空闲 0 条（子集起不了会话）', mFrozen.idle.length === 0 && mFrozen.mode === 'none');

/* ─── 5) 已关闭节点 / 执行记录不算分支 ─── */
const mixed = project(node('m', 'milestone', {
  kids: [
    node('s1', 'support', { closed: true }),
    node('s2', 'support', { kids: [node('e1', 'exec')] }),
  ],
}));
const mMixed = idleModelOf(mixed, none, none);
ok('已关闭支撑项不算分支', !mMixed.rows.some((r) => r.node.id === 's1'), ids(mMixed.rows));
ok('执行记录不算分支', !mMixed.rows.some((r) => r.node.id === 'e1'), ids(mMixed.rows));
ok('里程碑 + 支撑项各算一条分支', mMixed.rows.length === 2 && mMixed.mode === 'strong', ids(mMixed.rows));

/* ─── 6) 有未处置 issues → blocked，不算空闲 ─── */
const withIssues = project(node('m', 'milestone', { kids: [node('s1', 'support', { issues: 1 }), node('s2', 'support')] }));
const mIssues = idleModelOf(withIssues, none, hasIssue);
ok('有 issues 的分支记 blocked', mIssues.rows.find((r) => r.node.id === 's1').state === 'blocked');
ok('blocked 不进空闲集合', !mIssues.idleIds.has('s1') && mIssues.idleIds.has('s2'), [...mIssues.idleIds].join(','));

/* ─── 7) 全部关闭 → 0 条分支 ─── */
const mClosed = idleModelOf(project(node('m', 'milestone', { closed: true })), none, none);
ok('全部关闭 → 0 条分支且 mode=none', mClosed.rows.length === 0 && mClosed.mode === 'none');

/* ─── 8) 两个项目各自判定，互不影响 ─── */
const pA = project(node('ma', 'milestone'));
const pB = project(node('mb', 'milestone', { kids: [node('sb1', 'support'), node('sb2', 'support')] }));
const mA = idleModelOf(pA, none, none);
const mB = idleModelOf(pB, none, none);
ok('A 项目单分支空闲 → modest', mA.mode === 'modest', mA.mode);
ok('B 项目两分支空闲 → strong', mB.mode === 'strong', mB.mode);
ok('两个项目的空闲集合互不含对方节点', !mA.idleIds.has('mb') && !mB.idleIds.has('ma'));

/* ─── 9) 源码结构：三处接入都在 ─── */
ok('卡片渲染带 data-idle', html.includes('data-idle="${idleMode}"'));
ok('卡片带「可开工」文字标签（不只靠颜色）', html.includes('class="idle-pill"') && html.includes('可开工'));
ok('泳道头带 lane-live', html.includes('data-lane-live') && html.includes('class="lane-live'));
const runBadges = extractFn(html, 'paintRunBadges');
ok('paintRunBadges 会刷新空闲状态', runBadges.includes('paintIdle()'));
ok('页脚是按钮并带 next-jump', html.includes('id="next-jump"') && html.includes('jumpToNextTarget'));
ok('浅色 / 暗色各有一套 --ready', (html.match(/--ready:#/g) || []).length === 2);

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n✗ ${failed} 项未通过` : `\n全部 ${results.length} 项通过（空闲分支按项目数，单条只做弱强调）`);
process.exit(failed ? 1 : 0);
