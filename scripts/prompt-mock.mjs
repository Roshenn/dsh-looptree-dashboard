#!/usr/bin/env node
/**
 * scripts/prompt-mock.mjs — prompt 结构烟测（不装 DSH、不起服务）。
 *
 *   node scripts/prompt-mock.mjs
 *
 * 用样例卡合成全部 8 类 prompt，断言结构规范（docs/prompts.md）：
 *   首行「动作 · 对象」、空行分块、块不空、单行 ≤72 字、
 *   计划三节、/goal 单行、JSON 契约不变、编辑覆盖优先。
 * 退出码 0 = 全部通过。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actionCommand,
  composeActionPrompt,
  composeCandidatePrompt,
  composeCollectServicesPrompt,
  composeFillPrompt,
  composeGoalObjective,
  composeIdeaPrompt,
  composePlanPrompt,
  composeSplitPrompt,
  composeTaskPrompt,
  lintPrompt,
  listTaskPrompts,
} from '../lib/prompt.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SAMPLES = join(ROOT, 'samples');
const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
};

const readCard = (name) => JSON.parse(readFileSync(join(SAMPLES, name), 'utf8'));
const walk = (node, out = []) => {
  out.push(node);
  (node.children || []).forEach((child) => walk(child, out));
  return out;
};
const lineOf = (text, index) => String(text).split('\n')[index] || '';
const titleOk = (text) => /^.{2,40} · (里程碑|目标|构思|执行)「.+」$/.test(lineOf(text, 0));
const blocksOk = (text) => {
  const lines = String(text).split('\n');
  return lines[1] === '' && lines.filter((line, i) => i > 1 && line.trim() === '').length > 0;
};

/* ── 1. 样例卡：每一类 prompt 都过结构 lint ── */
const files = readdirSync(SAMPLES).filter((f) => f.endsWith('.rotation.json'));
const cards = files.map((f) => ({ f, card: readCard(f) }));
let taskCount = 0;
let actionCount = 0;
let nodeCount = 0;

for (const { f, card } of cards) {
  const name = card.project && card.project.name;
  const workspace = card.project && card.project.workspace;
  for (const node of walk(card.milestone)) {
    nodeCount += 1;
    let list;
    try {
      list = listTaskPrompts({ projectName: name, card, nodeId: node.id });
    } catch (error) {
      check(`${f}/${node.id} 合成模板`, false, error.message);
      continue;
    }
    check(`${f}/${node.id} 模板来源非空`, typeof list.from === 'string' && list.from.length > 0, JSON.stringify(list.from));
    for (const task of list.list) {
      taskCount += 1;
      const label = `${f}/${node.id}/${task.id}`;
      check(`${label} 首行格式`, titleOk(task.prompt), lineOf(task.prompt, 0));
      check(`${label} 有空行分块`, blocksOk(task.prompt), JSON.stringify(task.prompt.slice(0, 60)));
      check(`${label} summary 非空`, !!task.summary, '');
      check(`${label} lint`, task.warnings.length === 0, JSON.stringify(task.warnings.slice(0, 3)));
      check(`${label} 无 markdown 粗体`, !task.prompt.includes('**'), '');
    }
    if (node.kind === 'idea') {
      for (const action of ['plan', 'exec', 'reflect']) {
        actionCount += 1;
        const prompt = composeActionPrompt({ action, projectName: name, workspace, card, nodeId: node.id });
        const label = `${f}/${node.id}/action-${action}`;
        check(`${label} 首行格式`, titleOk(prompt), lineOf(prompt, 0));
        check(`${label} 有空行分块`, blocksOk(prompt), '');
        check(`${label} lint`, lintPrompt(prompt).warnings.length === 0, JSON.stringify(lintPrompt(prompt).warnings.slice(0, 3)));
        check(`${label} ≤1500 字`, [...prompt].length <= 1500, String([...prompt].length));
      }
      const objective = composeGoalObjective({ projectName: name, workspace, card, nodeId: node.id });
      check(`${f}/${node.id} /goal 单行`, !objective.includes('\n'), objective.slice(0, 40));
      check(`${f}/${node.id} /goal ≤240 字`, [...objective].length <= 240, String([...objective].length));
    }
  }
}

/* ── 2. 发送编排：/plan 带多行正文，/goal 单行 ── */
const fx = readCard('storyweft.rotation.json');
const fxArgs = { projectName: fx.project.name, workspace: fx.project.workspace, card: fx, nodeId: 'sw-i1' };
const planCmd = actionCommand({ ...fxArgs, action: 'plan' });
check('/plan 是一条命令', Array.isArray(planCmd) && planCmd.length === 1, JSON.stringify(planCmd.slice(0, 1)).slice(0, 60));
check('/plan 后接换行而不是空格', planCmd[0].startsWith('/plan\n'), JSON.stringify(planCmd[0].slice(0, 12)));
check('/plan 正文保留多行', planCmd[0].split('\n').length > 8, String(planCmd[0].split('\n').length));
check('/plan 正文首行是任务标题', titleOk(planCmd[0].replace(/^\/plan\n/, '')), lineOf(planCmd[0], 1));
const execCmd = actionCommand({ ...fxArgs, action: 'exec' });
check('/goal 是两条命令', Array.isArray(execCmd) && execCmd.length === 2, '');
check('/goal 先关计划模式', execCmd[0] === '/plan off', execCmd[0]);
check('/goal 目标单行', execCmd[1].startsWith('/goal ') && !execCmd[1].includes('\n'), execCmd[1].slice(0, 40));
check('reflect 不发命令', actionCommand({ ...fxArgs, action: 'reflect' }) === undefined, '');
const editedPlan = '# 我改过的计划\n\n## 目标\n改过的';
check('改过的计划原文发送', actionCommand({ ...fxArgs, action: 'plan', prompt: editedPlan })[0] === `/plan\n${editedPlan}`, '');
check('改过的目标原文发送', actionCommand({ ...fxArgs, action: 'exec', objective: '一句话目标' })[1] === '/goal 一句话目标', '');

/* ── 3. 输出契约不变（下游解析依赖这些字面量） ── */
const planText = composePlanPrompt(fxArgs);
check('计划含 ## 目标', planText.includes('## 目标'));
check('计划含 ## 验证命令', planText.includes('## 验证命令'));
check('计划含 ## 步骤', planText.includes('## 步骤'));
check('计划要求 exit_plan_mode', planText.includes('exit_plan_mode'));
const reflectText = composeActionPrompt({ ...fxArgs, action: 'reflect' });
check('反馈提炼要 JSON lessons', reflectText.includes('{"lessons"'));
const splitText = composeSplitPrompt({ ...fxArgs, nodeId: 'sw-loop' });
check('拆目标要 JSON goals', splitText.includes('{"goals"'));
const ideaText = composeIdeaPrompt({ ...fxArgs, nodeId: 'sw-g1' });
check('拆构思要 JSON ideas', ideaText.includes('{"ideas"'));
const candText = composeCandidatePrompt({ ...fxArgs, nodeId: 'sw-i1', count: 3 });
check('候选要 JSON 数组', candText.includes('[{"title"'));
const fillText = composeFillPrompt({ ...fxArgs, nodeId: 'sw-g1', fields: ['acceptance'] });
check('补全要 JSON 对象', fillText.includes('{"acceptance": "..."'));
check('补全带字段上限', fillText.includes('≤300 字'));

/* ── 3.5 新块与两个信息通道（docs/prompt-audit §3.3 / §3.4 / §3.6） ── */
// 生成计划：证据先行 + 文件级步骤 + 验收追溯 + 非目标
check('计划要「证据要求」块', planText.includes('\n证据要求\n'), '');
check('计划要 path:line 证据', planText.includes('path:line'), '');
check('计划要「非目标」块', planText.includes('\n非目标\n'), '');
check('计划步骤要文件+命令+预期+验收项', planText.includes('改哪些文件 / 做什么 / 验证命令 / 预期结果 / 对应验收项'), '');
check('计划要求验收可追溯', planText.includes('每个验收项都能追溯到某一步'), '');
// 验收去重：样例卡的构思没有自己的 acceptance，背景已有目标验收，不再重复出块
check('计划不重复目标验收', !planText.includes('\n验收\n'), planText.split('\n').filter((x) => x.trim() === '验收').join('|'));
// 候选：差异轴 + count 文案 + 契约分支
const candIdeaText = composeCandidatePrompt({ ...fxArgs, nodeId: 'sw-g1', count: 4 });
check('候选要差异轴要求', candText.includes('不同的差异轴'), '');
check('候选 count 进文案', candIdeaText.includes('给出 4 条'), '');
check('构思候选带 strength 契约', candIdeaText.includes('"strength"') && candIdeaText.includes('不要用「最小 / 最强」'), '');
check('执行候选不带 strength', !candText.includes('"strength"'), '');
check('候选有示例块', candText.includes('\n示例\n'), '');
// 场景 / 阻碍注入：样例卡里有里程碑阻碍项 + 目标的落地场景流程
const withCtxFields = JSON.parse(JSON.stringify(fx));
withCtxFields.project.vision = '作者改一段情节，视觉与结构同时更新，评审不用再截图对稿。';
withCtxFields.milestone.metrics = '1)任意一章改完，三层图同步刷新且无残影\n2)首屏渲染 < 800ms';
withCtxFields.milestone.blockers = '1)缺进度持久化（无 POST /api/progress）→ 挡在「练完可恢复」\n2)缺逐句对齐（无 timecode 解析）→ 挡在「逐句跟读」';
const scPlan = composePlanPrompt({ ...fxArgs, card: withCtxFields });
check('计划注入里程碑阻碍', scPlan.includes('- 阻碍：') && scPlan.includes('缺进度持久化'), '');
check('计划注入目标场景流程', scPlan.includes('- 落地场景流程：') && scPlan.includes('章节编辑区'), '');
const scCand = composeCandidatePrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-i1' });
check('执行候选注入目标场景', scCand.includes('\n场景\n') && scCand.includes('候选不能越出'), '');
const scCandGoal = composeCandidatePrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-g1' });
check('构思候选注入里程碑阻碍', scCandGoal.includes('- 里程碑阻碍：') && scCandGoal.includes('缺进度持久化'), '');
// 里程碑候选：完全由阻碍项驱动（2026-10-30 用户反馈「目标脱离里程碑、抽象」）
const msCand = composeCandidatePrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-loop' });
check('里程碑候选逐条注入阻碍项', msCand.includes('- 阻碍项（每条候选只认领其中一条）：') && msCand.includes('缺进度持久化'), '');
check('里程碑候选去掉差异轴要求', !msCand.includes('差异轴'), '');
check('里程碑候选每条只解决一条阻碍', msCand.includes('每条只解决一条阻碍项') && msCand.includes('认领一条不同的阻碍项'), '');
check('里程碑候选条数受阻碍条数约束', msCand.includes('给出 2 条候选目标'), msCand.split('\n').find((x) => x.includes('给出')) || '');
check('里程碑候选 count 不超过阻碍条数', composeCandidatePrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-loop', count: 6 }).includes('给出 2 条候选目标'), '');
check('里程碑候选要复现阻碍证据', msCand.includes('复现阻碍现状') && msCand.includes('"evidence"'), '');
check('里程碑候选验收＝阻碍消除判据', msCand.includes('阻碍消除后能观察到的判据'), '');
check('里程碑候选 blocker 照抄短名', msCand.includes('照抄阻碍项原文的短名'), '');
check('里程碑候选去掉原文编号叠号', !msCand.includes('1) 1)') && !msCand.includes('2) 2)'), '');
check('里程碑候选 lint', lintPrompt(msCand).warnings.length === 0, JSON.stringify(lintPrompt(msCand).warnings.slice(0, 2)));
// 阻碍项为空：直接拒绝，不退化成「按愿景缺口」编抽象目标
const msNoBlockerCard = JSON.parse(JSON.stringify(fx));
delete msNoBlockerCard.milestone.blockers;
let msNoBlockerErr = null;
try { composeCandidatePrompt({ ...fxArgs, card: msNoBlockerCard, nodeId: 'sw-loop' }); } catch (error) { msNoBlockerErr = error; }
check('无阻碍项时拒绝生成目标候选', !!msNoBlockerErr && msNoBlockerErr.code === 'BLOCKERS_REQUIRED', String(msNoBlockerErr && msNoBlockerErr.message));
const ideaVision = composeIdeaPrompt({ ...fxArgs, nodeId: 'sw-g1' });
check('拆构思注入里程碑愿景', ideaVision.includes('- 所属里程碑愿景：'), '');
check('拆构思注入目标场景', ideaVision.includes('目标已定的落地场景流程'), '');
// 里程碑补全：里程碑愿景（宏大叙事 / ≤1000 字）+ 阻碍项 + 核心指标（2–5 条，不是验收）+ JSON 契约
const msFill = composeFillPrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-loop', fields: ['vision', 'blockers', 'metrics'] });
check('里程碑补全带愿景规则', msFill.includes('里程碑愿景 3–6 句'), '');
check('里程碑补全愿景上限 1000', msFill.includes('里程碑愿景 ≤1000 字'), '');
check('里程碑补全愿景要宏大叙事', msFill.includes('宏大叙事') && msFill.includes('不写功能清单'), '');
check('里程碑阻碍项要「证据要求」块', msFill.includes('\n证据要求\n'), '');
check('里程碑阻碍项格式：缺什么 → 挡在愿景哪一步 → 模块', msFill.includes('缺什么 → 挡在愿景的哪一步 → 涉及模块或文件'), '');
check('里程碑阻碍项要 3–5 条', msFill.includes('阻碍项 3–5 条'), '');
check('里程碑补全注入项目愿景', msFill.includes('- 项目愿景：') && msFill.includes('视觉与结构同时更新'), '');
check('里程碑补全要核心指标 2–5 条', msFill.includes('核心指标 2–5 条'), '');
check('核心指标从里程碑愿景反推', msFill.includes('从里程碑标题与里程碑愿景反推'), '');
check('核心指标不写验收命令', msFill.includes('不写测试命令') && msFill.includes('验收另有流程'), '');
check('核心指标可长期对比', msFill.includes('看得出是变好还是变差'), '');
check('里程碑补全不再产出验收', !msFill.includes('达成判据') && !msFill.includes('验收 3–5 条'), '');
check('里程碑补全 JSON 契约', msFill.includes('{"vision": "..."') && msFill.includes('"blockers": "..."') && msFill.includes('"metrics": "..."'), '');
check('里程碑补全 lint', lintPrompt(msFill).warnings.length === 0, JSON.stringify(lintPrompt(msFill).warnings.slice(0, 2)));
// 目标补全：场景流程（操作 / 预期 / 体验 3–5 步），不出现愿景
const goalFill = composeFillPrompt({ ...fxArgs, nodeId: 'sw-g1', fields: ['scenario', 'constraints', 'acceptance'] });
check('目标补全带场景流程', goalFill.includes('落地场景流程 3–5 步') && goalFill.includes('操作 / 预期 / 体验'), '');
check('目标补全不出现愿景', !goalFill.includes('愿景 ≤500'), '');
check('目标补全 lint', lintPrompt(goalFill).warnings.length === 0, JSON.stringify(lintPrompt(goalFill).warnings.slice(0, 2)));
// 拆目标：愿景 + 阻碍项（不再有场景块），blocker 契约
const splitBlockers = composeSplitPrompt({ ...fxArgs, card: withCtxFields, nodeId: 'sw-loop' });
check('拆目标注入里程碑愿景', splitBlockers.includes('- 里程碑愿景：'), '');
check('拆目标注入核心指标', splitBlockers.includes('- 核心指标：') && splitBlockers.includes('三层图同步刷新'), '');
check('拆目标不再注入验收判据', !splitBlockers.includes('达成判据'), '');
check('拆目标注入已知阻碍', splitBlockers.includes('- 已知阻碍项：') && splitBlockers.includes('缺进度持久化'), '');
check('拆目标不再出场景块', !splitBlockers.includes('\n场景\n'), '');
check('拆目标要每条对应阻碍', splitBlockers.includes('每条目标对应一条阻碍项'), '');
check('拆目标 blocker 契约', splitBlockers.includes('"blocker":"…"'), '');
check('拆目标照抄阻碍短名', splitBlockers.includes('照抄阻碍项原文的短名'), '');
check('拆目标 lint（带阻碍）', lintPrompt(splitBlockers).warnings.length === 0, JSON.stringify(lintPrompt(splitBlockers).warnings.slice(0, 2)));
// 愿景可到 1000 字：拆目标只取「要变成什么样」，超长部分裁剪并标「全文见卡片」
const longVisionCard = JSON.parse(JSON.stringify(fx));
longVisionCard.milestone.vision = '愿景很长的一句话。'.repeat(80);   // ≈ 800 字
const splitLongVision = composeSplitPrompt({ ...fxArgs, card: longVisionCard, nodeId: 'sw-loop' });
check('拆目标愿景超长时裁剪并标全文见卡片',
  splitLongVision.includes('全文见卡片') && [...splitLongVision].length < 1600, String([...splitLongVision].length));
const noBlockerCard = JSON.parse(JSON.stringify(fx));
delete noBlockerCard.milestone.blockers;
const splitNoBlockers = composeSplitPrompt({ ...fxArgs, card: noBlockerCard, nodeId: 'sw-loop' });
check('无阻碍时拆目标不带 blocker 契约', !splitNoBlockers.includes('"blocker"'), '');
check('无阻碍时拆目标按愿景缺口拆', splitNoBlockers.includes('离愿景还差什么'), '');
// 目标仍有「约束」：补全与拆构思都按约束口径，不混成阻碍
const goalConstraintsFill = composeFillPrompt({ ...fxArgs, nodeId: 'sw-g1', fields: ['constraints'] });
check('目标补全仍是约束口径', goalConstraintsFill.includes('- 约束 3–5 条') && !goalConstraintsFill.includes('阻碍项'), '');
const withGoalLimits = JSON.parse(JSON.stringify(fx));
withGoalLimits.milestone.children[0].constraints = '不改公开 API';
const ideaLimited = composeIdeaPrompt({ ...fxArgs, card: withGoalLimits, nodeId: 'sw-g1' });
check('拆构思仍注入目标约束', ideaLimited.includes('- 目标约束：不改公开 API'), '');
const accIdea = JSON.parse(JSON.stringify(fx));
accIdea.milestone.children[0].children[0].acceptance = '章节与情节可双向查询';
const accPlan = composePlanPrompt({ ...fxArgs, card: accIdea });
check('构思自己的验收单独成块', accPlan.includes('\n验收\n- 章节与情节可双向查询'), '');
// 长字段卡片（真实卡可能几百字场景/阻碍/验收）：裁剪预算必须兜住 1500 字 + 72 列
const longCard = JSON.parse(JSON.stringify(fx));
longCard.milestone.children[0].scenario = Array.from({ length: 6 }, (_, i) => `${i + 1})操作：打开面板选择项目\n预期：看到预览\n体验：10 秒内完成`).join('\n');
longCard.milestone.blockers = Array.from({ length: 5 }, (_, i) => `${i + 1})缺第${i + 1}个模块（src/mod${i + 1}.ts 无实现）→ 挡在「练完可恢复」这一步`).join('\n');
longCard.milestone.children[0].acceptance = Array.from({ length: 5 }, (_, i) => `${i + 1})步骤${i + 1}：pnpm test:e2e 用例全绿且新增断言可复现`).join('；');
const longPlan = composePlanPrompt({ ...fxArgs, card: longCard });
const longWarn = lintPrompt(longPlan, { maxLength: 1500 }).warnings;
check('长字段卡片：计划仍 ≤1500 字', [...longPlan].length <= 1500, String([...longPlan].length));
check('长字段卡片：计划 lint 无警告（含 72 列）', longWarn.length === 0, JSON.stringify(longWarn.slice(0, 2)));
check('长字段裁掉后有「全文见卡片」提示', longPlan.includes('（全文见卡片）'), '');

// /goal 计划指针：240 字用来写「计划在哪」，不内联步骤
const pointerXr = composeGoalObjective({ ...fxArgs, card: readCard('execution-records.rotation.json'), nodeId: 'xr-i1' });
check('/goal 指向卡片文件', pointerXr.includes('/.dsh/rotation.json'), pointerXr.slice(0, 60));
check('/goal 带构思 id 与 plan 字段', pointerXr.includes('id=xr-i1') && pointerXr.includes('plan'), pointerXr.slice(0, 60));
check('/goal 指针单行 ≤240 字', !pointerXr.includes('\n') && [...pointerXr].length <= 240, String([...pointerXr].length));
check('/goal 指针不出现 markdown 粗体', !pointerXr.includes('**'), '');
const noWsCard = JSON.parse(JSON.stringify(fx));
noWsCard.project.workspace = '';
const inline = composeGoalObjective({ projectName: 'X', card: noWsCard, nodeId: 'sw-i1' });
check('/goal 无 workspace 退回内联目标', !inline.includes('rotation.json') && inline.startsWith('执行构思「'), inline.slice(0, 40));
check('/goal 内联目标仍 ≤240 字', [...inline].length <= 240, String([...inline].length));

/* 服务信息收集：项目级 prompt，要求平台化 start + JSON 契约 */
const collectText = composeCollectServicesPrompt({
  projectName: 'X', workspace: '/w', platform: 'darwin',
  existing: [{ id: 'web', name: '本地预览', url: 'http://127.0.0.1:5273', start: 'pnpm dev' }],
});
check('收集服务首行是「动作 · 对象」', collectText.startsWith('收集服务 · 项目「X」'), collectText.split('\n')[0]);
check('收集服务要求 mac 与 windows 两条', collectText.includes('mac') && collectText.includes('windows'));
check('收集服务要 JSON services', collectText.includes('{"services":[{"id":"web"'));
check('收集服务带已有 services 作为参考', collectText.includes('已有 services') && collectText.includes('http://127.0.0.1:5273'));
check('收集服务 lint 无警告', lintPrompt(collectText).warnings.length === 0, JSON.stringify(lintPrompt(collectText).warnings.slice(0, 2)));
check('收集服务：无已有服务时写「无」',
  composeCollectServicesPrompt({ projectName: 'Y', workspace: '/w' }).includes('- 已有 services：无'));

/* ── 4. 模板优先级与 prompt_context 配置 ── */
const custom = JSON.parse(JSON.stringify(fx));
custom.milestone.children[0].children[0].prompts = [{ id: 'mine', title: '我的模板', ask: '只输出一句话结论。' }];
const nodeList = listTaskPrompts({ projectName: 'X', card: custom, nodeId: 'sw-i1' });
check('节点自定义模板优先', nodeList.from === '节点自定义' && nodeList.list[0].id === 'mine', nodeList.from);
const withCtx = JSON.parse(JSON.stringify(fx));
withCtx.prompt_context = { fields: ['project', 'node', 'refs'], refs: ['sw-e4'] };
const ctxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('prompt_context.fields 生效', ctxText.includes('- 项目：X') && !ctxText.includes('- 闭环：'), ctxText.slice(0, 80));
check('prompt_context.refs 生效', ctxText.includes('- 引用：') && ctxText.includes('sw-e4'), '');
withCtx.prompt_context = { fields: ['node', 'siblings'], siblings: 1 };
const sibText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('siblings 条数生效', sibText.includes('- 同级构思：分层 SVG 绘制'), sibText.split('\n').find((l) => l.includes('同级')) || '');
// 里程碑愿景 / 核心指标是可注入的上下文字段（旧键 milestone.acceptance 保留但不输出幽灵验收）
withCtx.prompt_context = { fields: ['milestone', 'milestone.vision', 'milestone.metrics'] };
const msCtxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('里程碑愿景进上下文', msCtxText.includes('- 里程碑愿景：'), '');
check('核心指标进上下文', msCtxText.includes('- 核心指标：') && msCtxText.includes('三层图各 ≥8 节点'), '');
withCtx.prompt_context = { fields: ['milestone.acceptance'] };
const legacyCtxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('旧 milestone.acceptance 不再注入达成判据', !legacyCtxText.includes('达成判据'), '');

/* ── 5. lint 能抓到反例 ── */
const bad = [
  { text: '为「x」项目生成计划。项目目录：/w 先读文件。', code: 'bad-title' },
  { text: '生成计划 · 构思「x」\n背景\n- 项目：x', code: 'missing-blank' },
  { text: '生成计划 · 构思「x」\n\n背景\n' + '很长的行'.repeat(20), code: 'line-too-long' },
  { text: '生成计划 · 构思「x」\n\n背景\n- **加粗**', code: 'markdown-bold' },
  { text: '生成计划 · 构思「x」\n\n背景\n\n\n任务\n1. a', code: 'double-blank' },
  { text: '生成计划 · 构思「x」\n\n任务\n\n输出\n- a', code: 'empty-block' },
];
for (const item of bad) {
  const codes = lintPrompt(item.text).warnings.map((w) => w.code);
  check(`lint 抓到 ${item.code}`, codes.includes(item.code), JSON.stringify(codes));
}
const clean = lintPrompt(planText);
check('合规 prompt lint 无警告', clean.ok, JSON.stringify(clean.warnings.slice(0, 2)));
check('上限检查生效', lintPrompt(planText, { maxLength: 10 }).warnings.some((w) => w.code === 'too-long'), '');

/* ── 结果 ── */
const failed = results.filter((r) => !r.pass);
console.log(`\n共 ${nodeCount} 个节点 / ${taskCount} 条模板 / ${actionCount} 条动作 prompt`);
console.log(failed.length ? `${failed.length} 项失败` : 'prompt 结构全部通过');
process.exit(failed.length ? 1 : 0);
