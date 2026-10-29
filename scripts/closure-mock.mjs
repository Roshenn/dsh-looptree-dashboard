#!/usr/bin/env node
/**
 * scripts/closure-mock.mjs — 从 web/index.html 抠出纯状态函数，验证「手动闭环」规则（不需要浏览器）。
 *
 *   node scripts/closure-mock.mjs
 *
 * 覆盖：
 *   · 构思：记录全闭环（含一次执行 + 一次反馈）→ 已闭环；只有计划 → 规划中；执行过未闭环 → 进行中
 *   · 目标 / 闭环：子项全闭环 → 待确认收敛（review），不会自动 closed
 *   · autoCloseTree 只补构思，绝不关闭目标 / 闭环
 *   · syncRawStatus 对 review 写 doing（不能写 done）
 *
 * 做法与 stale-run-mock 一致：从面板脚本里按函数名/const 名抠源码，放进 new Function 里跑。
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

/** 按函数名截出 `function name(...) { ... }`（花括号配对） */
function grabFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不配对`);
}
/** 按 const 名截出声明（支持对象字面量与箭头函数） */
function grabConst(name) {
  const start = script.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`找不到 const ${name}`);
  let i = start + `const ${name} =`.length;
  while (i < script.length && /\s/.test(script[i])) i += 1;
  if (script[i] === '{' || script[i] === '[') {
    const open = script[i], close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let j = i; j < script.length; j += 1) {
      if (script[j] === open) depth += 1;
      else if (script[j] === close) {
        depth -= 1;
        if (depth === 0) {
          const semi = script.indexOf(';', j);
          return script.slice(start, semi + 1);
        }
      }
    }
    throw new Error(`const ${name} 括号不配对`);
  }
  const semi = script.indexOf(';', i);
  return script.slice(start, semi + 1);
}

const SOURCE = [
  grabFunction('walk'),
  grabConst('isRecord'),
  grabConst('recordActionOf'),
  grabFunction('workKids'),
  grabConst('INFO_FIELDS'),
  grabConst('PLACEHOLDER_RE'),
  grabFunction('isFilled'),
  grabFunction('hasInfo'),
  grabConst('STATE_DEF'),
  grabFunction('ideaRecordsDone'),
  grabFunction('deriveState'),
  grabFunction('stateOf'),
  grabFunction('autoCloseTree'),
  grabFunction('syncRawStatus'),
].join('\n');

const api = new Function(`${SOURCE}
return { walk, workKids, ideaRecordsDone, deriveState, stateOf, autoCloseTree, syncRawStatus, STATE_DEF };`)();

/* ── 造节点（和面板 conv() 后的形状一致：记录靠 raw.action 识别） ── */
const N = (id, kind, opts = {}) => ({
  id, kind, title: opts.title || id, closed: !!opts.closed,
  raw: { id, kind, title: opts.title || id, ...(opts.action ? { action: opts.action } : {}), ...(opts.raw || {}) },
  children: opts.children || [],
});
const record = (id, action, closed = true) => N(id, 'exec', {
  action, closed,
  raw: action === 'plan'
    ? { plan_steps: 3 }
    : (action === 'exec' ? { verify: 'pnpm test' } : { lessons: ['x'] }),
});
const ideaWithRecords = (id, records) => N(id, 'idea', { title: `构思 ${id}`, raw: { acceptance: 'x', plan: { goal: 'g' } }, children: records });

/* 1. 构思三态 */
const doneIdea = ideaWithRecords('i-done', [record('p1', 'plan'), record('e1', 'exec'), record('r1', 'reflect')]);
check('构思：记录全闭环 → 已闭环', api.deriveState(doneIdea) === 'closed', api.deriveState(doneIdea));
const planOnly = ideaWithRecords('i-plan', [record('p1', 'plan')]);
check('构思：只出计划 → 规划中', api.deriveState(planOnly) === 'plan', api.deriveState(planOnly));
const execOpen = ideaWithRecords('i-doing', [record('p1', 'plan'), record('e1', 'exec', false)]);
check('构思：执行记录未闭环 → 进行中', api.deriveState(execOpen) === 'doing', api.deriveState(execOpen));

/* 2. 目标 / 闭环：子项全闭环 → 待确认收敛（doneIdea 先按构思自动闭环的结果置 closed） */
doneIdea.closed = true;
const reviewGoal = N('g-review', 'goal', { title: '目标', raw: { acceptance: 'x' }, children: [doneIdea] });
check('目标：子项全闭环 → 待确认收敛', api.deriveState(reviewGoal) === 'review', api.deriveState(reviewGoal));
check('目标：review 不自动关闭', reviewGoal.closed === false);
const closedGoal = { ...reviewGoal, closed: true };
const reviewLoop = N('loop-review', 'loop', { title: '闭环', raw: { acceptance: 'x' }, children: [closedGoal] });
check('闭环：目标全闭环 → 待确认收敛', api.deriveState(reviewLoop) === 'review', api.deriveState(reviewLoop));
const doingLoop = N('loop-doing', 'loop', { title: '闭环', raw: { acceptance: 'x' }, children: [closedGoal, N('g-open', 'goal', { title: '未完成', raw: { acceptance: 'x' }, children: [] })] });
check('闭环：还有未完成目标 → 进行中', api.deriveState(doingLoop) === 'doing', api.deriveState(doingLoop));

/* 3. autoCloseTree 只补构思 */
const freshDoneIdea = ideaWithRecords('i-auto', [record('p1', 'plan'), record('e1', 'exec'), record('r1', 'reflect')]);
const autoTree = N('loop-auto', 'loop', { title: '闭环', raw: { acceptance: 'x' }, children: [
  N('g-auto', 'goal', { title: '目标', raw: { acceptance: 'x' }, children: [freshDoneIdea] }),
] });
api.autoCloseTree(autoTree);
check('autoCloseTree：构思自动闭环', freshDoneIdea.closed === true);
check('autoCloseTree：目标保持待确认', autoTree.children[0].closed === false);
check('autoCloseTree：闭环保持待确认', autoTree.closed === false);
const planOnlyTree = N('loop2', 'loop', { title: '闭环', raw: { acceptance: 'x' }, children: [N('g2', 'goal', { title: '目标', raw: { acceptance: 'x' }, children: [planOnly] })] });
api.autoCloseTree(planOnlyTree);
check('autoCloseTree：只出计划的构思不被自动关', planOnly.closed === false);

/* 4. syncRawStatus：review 只能写 doing */
const sysRoot = N('loop3', 'loop', { title: '闭环', raw: { acceptance: 'x', status: 'plan' }, children: [
  N('g3', 'goal', { title: '目标', raw: { acceptance: 'x', status: 'plan' }, children: [doneIdea] }),
] });
api.syncRawStatus(sysRoot);
check('syncRawStatus：review 目标写 doing（不写 done）', sysRoot.children[0].raw.status === 'doing', sysRoot.children[0].raw.status);
check('syncRawStatus：review 闭环写 doing', sysRoot.raw.status === 'doing', sysRoot.raw.status);

/* 5. 状态文案 */
check('review 文案是「待确认收敛」', api.STATE_DEF.review && api.STATE_DEF.review.label === '待确认收敛', JSON.stringify(api.STATE_DEF.review));
check('stateOf 返回 review 与琥珀色', api.stateOf(reviewGoal).key === 'review' && api.stateOf(reviewGoal).tone.includes('amber'), JSON.stringify(api.stateOf(reviewGoal)));

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\n闭环规则全部通过');
process.exit(failed ? 1 : 0);
