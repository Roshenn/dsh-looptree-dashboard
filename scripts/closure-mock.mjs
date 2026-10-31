#!/usr/bin/env node
/**
 * scripts/closure-mock.mjs — 从 web/index.html 抠出纯状态函数，验证「手动确认」规则（不需要浏览器）。
 *
 *   node scripts/closure-mock.mjs
 *
 * 树：里程碑 → 支撑项 → 执行记录（plan / exec / reflect）。覆盖：
 *   · 支撑项三态：记录全闭环 → 已闭环；只出计划 → 规划中；执行过未闭环 → 进行中
 *   · 里程碑：子项全关闭 → 待确认达成（review），不会自动 closed
 *   · autoCloseTree 只补支撑项，绝不关闭里程碑
 *   · syncRawStatus：review 写 doing（不能写 done）
 *   · convergeGate：无支撑项 → no-kids；未全关 → hidden；全关 → ready（不再看 supports 文本）
 *   · normalizeLegacyCard：旧 loop / intent / closed_loops 改名；旧 goal+idea+exec 折叠成
 *     一个 support + 上提的 exec（只读三件套与思路不丢）
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
  let quote = '';
  for (let i = brace; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && script[i + 1] === '/') { const nl = script.indexOf('\n', i); i = nl < 0 ? script.length : nl; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
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
    let quote = '';
    for (let j = i; j < script.length; j += 1) {
      const ch = script[j];
      if (quote) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && script[j + 1] === '/') { const nl = script.indexOf('\n', j); j = nl < 0 ? script.length : nl; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
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
  grabFunction('supportRecordsDone'),
  grabFunction('deriveState'),
  grabFunction('stateOf'),
  grabFunction('autoCloseTree'),
  grabFunction('syncRawStatus'),
  grabConst('ITEM_RE'),
  grabConst('ORDINAL_PREFIX_RE'),
  grabFunction('stripOrdinalPrefix'),
  grabFunction('parseItems'),
  grabFunction('serializeItems'),
  grabFunction('closeLabelOf'),
  grabFunction('convergeGate'),
].join('\n');

const api = new Function(`${SOURCE}
return { walk, workKids, supportRecordsDone, deriveState, stateOf, autoCloseTree, syncRawStatus, STATE_DEF, parseItems, serializeItems, closeLabelOf, convergeGate };`)();

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
const supportWith = (id, records, raw = {}) => N(id, 'support', {
  title: `支撑项 ${id}`, raw: { metric: '指标', approach: '思路', ...raw }, children: records,
});

/* 1. 支撑项三态 */
const doneSupport = supportWith('s-done', [record('p1', 'plan'), record('e1', 'exec'), record('r1', 'reflect')]);
check('支撑项：记录全闭环 → 已闭环', api.deriveState(doneSupport) === 'closed', api.deriveState(doneSupport));
const execOpen = supportWith('s-doing', [record('p1', 'plan'), record('e1', 'exec', false)]);
check('支撑项：执行记录未闭环 → 进行中', api.deriveState(execOpen) === 'doing', api.deriveState(execOpen));
const noRecord = supportWith('s-empty', []);
check('支撑项：没有执行记录 → 规划中（有内容）', api.deriveState(noRecord) === 'plan', api.deriveState(noRecord));
check('支撑项：记录全闭环判据为 true', api.supportRecordsDone(doneSupport) === true && api.supportRecordsDone(execOpen) === false);

/* 2. 里程碑：支撑项全关闭 → 待确认达成 */
doneSupport.closed = true;
const reviewMilestone = N('ms-review', 'milestone', { title: '里程碑', raw: { vision: '愿景' }, children: [doneSupport] });
check('里程碑：支撑项全关闭 → 待确认达成', api.deriveState(reviewMilestone) === 'review', api.deriveState(reviewMilestone));
check('里程碑：review 不自动关闭', reviewMilestone.closed === false);
const openSupport = supportWith('s-open', [record('e2', 'exec', false)]);
const doingMilestone = N('ms-doing', 'milestone', { title: '里程碑', raw: { vision: '愿景' }, children: [doneSupport, openSupport] });
check('里程碑：还有未闭环支撑项 → 进行中', api.deriveState(doingMilestone) === 'doing', api.deriveState(doingMilestone));

/* 3. autoCloseTree 只补支撑项（执行记录 plan + exec + reflect 全闭环） */
const freshDone = supportWith('s-auto', [record('p1', 'plan'), record('e1', 'exec'), record('r1', 'reflect')]);
const autoTree = N('ms-auto', 'milestone', { title: '里程碑', raw: { vision: '愿景' }, children: [freshDone] });
api.autoCloseTree(autoTree);
check('autoCloseTree：支撑项自动闭环', freshDone.closed === true);
check('autoCloseTree：里程碑保持待确认', autoTree.closed === false);
// 契约：支撑项无执行记录时给「完成」按钮手动收口，autoCloseTree 不关它
const noRecTree = N('ms-no-rec', 'milestone', { title: '里程碑', raw: { vision: '愿景' }, children: [noRecord] });
api.autoCloseTree(noRecTree);
check('autoCloseTree：无执行记录的支撑项不自动关（手动完成）', noRecord.closed === false, JSON.stringify(noRecord.closed));

/* 4. syncRawStatus：review 只能写 doing */
const sysRoot = N('ms3', 'milestone', { title: '里程碑', raw: { vision: '愿景', status: 'plan' }, children: [doneSupport] });
api.syncRawStatus(sysRoot);
check('syncRawStatus：review 里程碑写 doing（不写 done）', sysRoot.raw.status === 'doing', sysRoot.raw.status);

/* 5. 状态文案：里程碑「达成」，支撑项 / 执行记录「闭环」 */
check('review 文案是「待确认收敛」', api.STATE_DEF.review && api.STATE_DEF.review.label === '待确认收敛', JSON.stringify(api.STATE_DEF.review));
check('stateOf 返回 review 与琥珀色', api.stateOf(reviewMilestone).key === 'review' && api.stateOf(reviewMilestone).tone.includes('amber'), JSON.stringify(api.stateOf(reviewMilestone)));
check('里程碑 review 文案是「待确认达成」', api.stateOf(reviewMilestone).label === '待确认达成', api.stateOf(reviewMilestone).label);
check('里程碑 closed 文案是「已达成」', api.stateOf({ ...reviewMilestone, closed: true }).label === '已达成', api.stateOf({ ...reviewMilestone, closed: true }).label);
check('支撑项 closed 文案是「已闭环」', api.stateOf({ ...doneSupport, closed: true }).label === '已闭环', api.stateOf({ ...doneSupport, closed: true }).label);
check('按钮文案：里程碑确认达成 / 支撑项与记录完成',
  api.closeLabelOf({ kind: 'milestone' }) === '确认达成'
  && api.closeLabelOf({ kind: 'support' }) === '完成'
  && api.closeLabelOf({ kind: 'exec' }) === '完成', '');

/* 6. 旧卡兼容：loop → milestone、intent → vision、closed_loops → closed_milestones */
const legacyCard = {
  schema: 'rotation/v1', project: { name: '旧卡', workspace: '/tmp/x' },
  closed_loops: [{ id: 'l1', title: '旧', closed_at: '2026-10-01T00:00:00Z', snapshot: { kind: 'loop', id: 'l1', title: '旧' } }],
  prompt_context: { fields: ['project', 'loop', 'loop.intent'] },
  loop: {
    id: 'l1', kind: 'loop', title: '旧里程碑', intent: '旧意图', status: 'plan', closed_at: null,
    children: [{
      id: 'g1', kind: 'goal', title: '旧目标', acceptance: '旧验收', blocker: '缺章节→情节索引',
      status: 'doing', closed_at: null,
      children: [{
        id: 'i1', kind: 'idea', title: '旧构思', approach: '先建索引再渲染', status: 'ready', closed_at: null,
        children: [{ id: 'e1', kind: 'exec', title: '旧执行', verify: 'npm test', status: 'done', closed_at: '2026-10-01T00:00:00Z', issues: [] }],
      }],
    }],
  },
};
const normalized = normalizeLegacyCard(JSON.parse(JSON.stringify(legacyCard)));
check('旧卡根字段 loop → milestone', !!normalized.milestone && !('loop' in normalized));
check('旧卡 kind → milestone', normalized.milestone.kind === 'milestone');
check('旧卡 intent → vision（id 不变）', normalized.milestone.vision === '旧意图' && normalized.milestone.id === 'l1' && !('intent' in normalized.milestone));
check('旧卡 closed_loops → closed_milestones', Array.isArray(normalized.closed_milestones) && normalized.closed_milestones[0].snapshot.kind === 'milestone' && !('closed_loops' in normalized));
check('旧卡 prompt_context keys 改名', normalized.prompt_context.fields.join(',') === 'project,milestone,milestone.vision');

/* 6.5 旧 goal + idea + exec 折叠：一个 support + 上提的执行记录 */
const folded = normalized.milestone.children;
const sup = folded[0];
check('旧 goal → support（id 保留）', folded.length === 1 && sup.kind === 'support' && sup.id === 'g1', JSON.stringify(folded.map((x) => [x.id, x.kind])));
check('goal.blocker → support.support', sup.support === '缺章节→情节索引', JSON.stringify(sup.support));
check('idea.approach → support.approach（空时填充）', sup.approach === '先建索引再渲染', JSON.stringify(sup.approach));
check('idea 的执行记录上提为 support 子节点', (sup.children || []).length === 1 && sup.children[0].id === 'e1' && sup.children[0].kind === 'exec', JSON.stringify((sup.children || []).map((x) => [x.id, x.kind])));
const kinds = [];
api.walk(normalized.milestone, (n) => kinds.push(n.kind));
check('树里不再有 goal / idea', !kinds.includes('goal') && !kinds.includes('idea'), JSON.stringify(kinds));
check('退役字段 acceptance 原样保留（只警告不删除）', sup.acceptance === '旧验收', JSON.stringify(sup.acceptance));
const again = normalizeLegacyCard(JSON.parse(JSON.stringify(normalized)));
check('normalizeLegacyCard 幂等', JSON.stringify(again) === JSON.stringify(normalized), '');

/* 7. 编辑端：清空条目的序列化仍要能清掉（支撑项 / 核心指标共用） */
const itemsEmpty = api.serializeItems(api.parseItems('1) 缺 A\n2) 缺 B'), [{ content: ' ' }, { content: '' }]);
check('清空全部条目 → 空串', itemsEmpty === '', JSON.stringify(itemsEmpty));
const itemsPartial = api.serializeItems(api.parseItems('1) 缺 A\n2) 缺 B'), [{ content: '缺 A' }, { content: '' }]);
check('只留一条时按新序号重排', itemsPartial === '1)缺 A', JSON.stringify(itemsPartial));

/* 8. 达成闸门：只对里程碑生效，至少 1 个支撑项子节点 + 全部闭环 */
const gateEmpty = N('ms-empty', 'milestone', { title: '空里程碑', raw: { vision: '愿景' }, children: [] });
check('里程碑没有支撑项子节点 → 置灰（no-kids）', api.convergeGate(gateEmpty).state === 'no-kids', JSON.stringify(api.convergeGate(gateEmpty)));
check('置灰文案指向加支撑项 / 移除项目', /支撑项/.test(api.convergeGate(gateEmpty).tip) && /移除/.test(api.convergeGate(gateEmpty).tip), api.convergeGate(gateEmpty).tip);
check('里程碑还有支撑项没关完 → 不显示按钮（hidden）', api.convergeGate(doingMilestone).state === 'hidden', JSON.stringify(api.convergeGate(doingMilestone)));
check('支撑项全关闭 → 可点（ready）', api.convergeGate(reviewMilestone).state === 'ready', JSON.stringify(api.convergeGate(reviewMilestone)));
// 闸门不再看 supports 文本：重要支撑是规划输入，不是关闭条件
const noSupportsText = { ...reviewMilestone, raw: { ...reviewMilestone.raw, supports: '' } };
check('support 文本为空也放行（不再看 supports）', api.convergeGate(noSupportsText).state === 'ready', JSON.stringify(api.convergeGate(noSupportsText)));
const foldedClone = { ...reviewMilestone, children: [], src: reviewMilestone };
check('折叠克隆（可见 kids 空、原节点有 kids）→ 仍可点', api.convergeGate(foldedClone).state === 'ready', JSON.stringify(api.convergeGate(foldedClone)));
check('已关闭的里程碑不显示达成按钮', api.convergeGate({ ...reviewMilestone, closed: true }).state === 'hidden');
check('支撑项 / 执行记录不走达成闸门（hidden）',
  api.convergeGate(N('s1', 'support', { title: '支撑项', children: [] })).state === 'hidden'
  && api.convergeGate(N('e1', 'exec', { title: '记录', children: [] })).state === 'hidden');

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\n手动确认规则全部通过');
process.exit(failed ? 1 : 0);
