#!/usr/bin/env node
/**
 * scripts/closure-mock.mjs — 从 web/index.html 抠出纯状态函数，验证「手动确认」规则（不需要浏览器）。
 *
 *   node scripts/closure-mock.mjs
 *
 * 覆盖：
 *   · 构思：记录全闭环（含一次执行 + 一次反馈）→ 已闭环；只有计划 → 规划中；执行过未闭环 → 进行中
 *   · 目标 / 里程碑：子项全关闭 → 待确认（review），不会自动 closed；里程碑词用「达成」
 *   · autoCloseTree 只补构思，绝不关闭目标 / 里程碑
 *   · syncRawStatus 对 review 写 doing（不能写 done）
 *   · normalizeLegacyCard：旧卡（loop / intent / closed_loops）读入即改名
 *
 * 做法与 stale-run-mock 一致：从面板脚本里按函数名/const 名抠源码，放进 new Function 里跑。
 */
import { readFileSync } from 'node:fs';
import { normalizeLegacyCard } from '../lib/core.mjs';
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
  grabConst('ITEM_RE'),
  grabConst('ORDINAL_PREFIX_RE'),
  grabFunction('stripOrdinalPrefix'),
  grabFunction('parseItems'),
  grabFunction('serializeItems'),
  grabFunction('blockersOf'),
  grabFunction('blockerCountOf'),
  grabFunction('blockerGate'),
  grabFunction('closeLabelOf'),
].join('\n');

const api = new Function(`${SOURCE}
return { walk, workKids, ideaRecordsDone, deriveState, stateOf, autoCloseTree, syncRawStatus, STATE_DEF, parseItems, serializeItems, blockersOf, blockerCountOf, blockerGate, closeLabelOf };`)();

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
const reviewMilestone = N('ms-review', 'milestone', { title: '里程碑', raw: { acceptance: 'x' }, children: [closedGoal] });
check('里程碑：目标全关闭 → 待确认达成', api.deriveState(reviewMilestone) === 'review', api.deriveState(reviewMilestone));
const doingMilestone = N('ms-doing', 'milestone', { title: '里程碑', raw: { acceptance: 'x' }, children: [closedGoal, N('g-open', 'goal', { title: '未完成', raw: { acceptance: 'x' }, children: [] })] });
check('里程碑：还有未完成目标 → 进行中', api.deriveState(doingMilestone) === 'doing', api.deriveState(doingMilestone));

/* 3. autoCloseTree 只补构思 */
const freshDoneIdea = ideaWithRecords('i-auto', [record('p1', 'plan'), record('e1', 'exec'), record('r1', 'reflect')]);
const autoTree = N('ms-auto', 'milestone', { title: '里程碑', raw: { acceptance: 'x' }, children: [
  N('g-auto', 'goal', { title: '目标', raw: { acceptance: 'x' }, children: [freshDoneIdea] }),
] });
api.autoCloseTree(autoTree);
check('autoCloseTree：构思自动闭环', freshDoneIdea.closed === true);
check('autoCloseTree：目标保持待确认', autoTree.children[0].closed === false);
check('autoCloseTree：里程碑保持待确认', autoTree.closed === false);
const planOnlyTree = N('ms2', 'milestone', { title: '里程碑', raw: { acceptance: 'x' }, children: [N('g2', 'goal', { title: '目标', raw: { acceptance: 'x' }, children: [planOnly] })] });
api.autoCloseTree(planOnlyTree);
check('autoCloseTree：只出计划的构思不被自动关', planOnly.closed === false);

/* 4. syncRawStatus：review 只能写 doing */
const sysRoot = N('ms3', 'milestone', { title: '里程碑', raw: { acceptance: 'x', status: 'plan' }, children: [
  N('g3', 'goal', { title: '目标', raw: { acceptance: 'x', status: 'plan' }, children: [doneIdea] }),
] });
api.syncRawStatus(sysRoot);
check('syncRawStatus：review 目标写 doing（不写 done）', sysRoot.children[0].raw.status === 'doing', sysRoot.children[0].raw.status);
check('syncRawStatus：review 里程碑写 doing', sysRoot.raw.status === 'doing', sysRoot.raw.status);

/* 5. 状态文案 */
check('review 文案是「待确认收敛」', api.STATE_DEF.review && api.STATE_DEF.review.label === '待确认收敛', JSON.stringify(api.STATE_DEF.review));
check('stateOf 返回 review 与琥珀色', api.stateOf(reviewGoal).key === 'review' && api.stateOf(reviewGoal).tone.includes('amber'), JSON.stringify(api.stateOf(reviewGoal)));

/* 5.5 状态词：里程碑「达成」，目标 / 构思保持「闭环 / 收敛」 */
check('里程碑 review 文案是「待确认达成」', api.stateOf(reviewMilestone).label === '待确认达成', api.stateOf(reviewMilestone).label);
check('里程碑 closed 文案是「已达成」', api.stateOf({ ...reviewMilestone, closed: true }).label === '已达成', api.stateOf({ ...reviewMilestone, closed: true }).label);
check('目标 review 文案仍是「待确认收敛」', api.stateOf(reviewGoal).label === '待确认收敛', api.stateOf(reviewGoal).label);
check('按钮文案：里程碑确认达成 / 目标确认收敛 / 叶子完成',
  api.closeLabelOf({ kind: 'milestone' }) === '确认达成'
  && api.closeLabelOf({ kind: 'goal' }) === '确认收敛'
  && api.closeLabelOf({ kind: 'exec' }) === '完成', '');

/* 5.6 旧卡兼容：loop → milestone、intent → vision、closed_loops → closed_milestones */
const legacyCard = {
  schema: 'rotation/v1', project: { name: '旧卡', workspace: '/tmp/x' },
  closed_loops: [{ id: 'l1', title: '旧', closed_at: '2026-10-01T00:00:00Z', snapshot: { kind: 'loop', id: 'l1', title: '旧' } }],
  prompt_context: { fields: ['project', 'loop', 'loop.intent'] },
  loop: { id: 'l1', kind: 'loop', title: '旧里程碑', intent: '旧意图', scenario: '1) 旧场景', acceptance: '旧验收', status: 'plan', closed_at: null, children: [] },
};
const normalized = normalizeLegacyCard(JSON.parse(JSON.stringify(legacyCard)));
check('旧卡根字段 loop → milestone', !!normalized.milestone && !('loop' in normalized));
check('旧卡 kind → milestone', normalized.milestone.kind === 'milestone');
check('旧卡 intent → vision（id 不变）', normalized.milestone.vision === '旧意图' && normalized.milestone.id === 'l1' && !('intent' in normalized.milestone));
check('旧卡 closed_loops → closed_milestones', Array.isArray(normalized.closed_milestones) && normalized.closed_milestones[0].snapshot.kind === 'milestone' && !('closed_loops' in normalized));
check('旧卡 prompt_context keys 改名', normalized.prompt_context.fields.join(',') === 'project,milestone,milestone.vision');
check('旧卡 scenario 保留（由迁移脚本备份后删）', normalized.milestone.scenario === '1) 旧场景');

/* 6. 阻碍项：清空条目要存成空串（否则编号模式留 "1)2)"，闸门永远清不掉） */
const itemsEmpty = api.serializeItems(api.parseItems('1) 缺 A\n2) 缺 B'), [{ content: ' ' }, { content: '' }]);
check('清空全部条目 → 空串（阻碍项能清掉）', itemsEmpty === '', JSON.stringify(itemsEmpty));
const itemsPartial = api.serializeItems(api.parseItems('1) 缺 A\n2) 缺 B'), [{ content: '缺 A' }, { content: '' }]);
check('只留一条时按新序号重排', itemsPartial === '1)缺 A', JSON.stringify(itemsPartial));

/* 7. 收敛闸门：阻碍项非空且未闭合 → 拦；清空 / 已闭环 → 放行 */
const gateLoop = N('ms-gate', 'milestone', { title: '里程碑', raw: { acceptance: 'x', blockers: '1)缺 A\n2)缺 B' }, children: [] });
check('阻碍项非空 → 拦截达成', api.blockerGate(gateLoop) === true && api.blockerCountOf(gateLoop) === 2, JSON.stringify({ gate: api.blockerGate(gateLoop), n: api.blockerCountOf(gateLoop) }));
check('阻碍项清空 → 放行', api.blockerGate(N('ms-clear', 'milestone', { title: '里程碑', raw: { acceptance: 'x', blockers: '' }, children: [] })) === false);
const gateClosed = N('ms-done', 'milestone', { title: '里程碑', closed: true, raw: { acceptance: 'x', blockers: '1) 缺 A', closed_at: '2026-10-29T00:00:00Z' }, children: [] });
check('已达成的里程碑不再拦（闸门只管未闭合）', api.blockerGate(gateClosed) === false);
check('非里程碑节点不拦（闸门只管里程碑）', api.blockerGate(N('g1', 'goal', { title: '目标', raw: { acceptance: 'x', blockers: '1) 缺 A' }, children: [] })) === false);

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\n手动确认规则全部通过');
process.exit(failed ? 1 : 0);
