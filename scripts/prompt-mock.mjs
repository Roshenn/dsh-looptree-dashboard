#!/usr/bin/env node
/**
 * scripts/prompt-mock.mjs — prompt 结构烟测（不装 DSH、不起服务）。
 *
 *   node scripts/prompt-mock.mjs
 *
 * 树：里程碑 → 支撑项 → 执行。用样例卡合成全部 prompt，断言结构规范（docs/prompts.md）：
 *   首行「动作 · 对象」、空行分块、块不空、单行 ≤72 列、
 *   计划三节、/goal 单行、JSON 契约（候选 / 补全 / 拆重要支撑）、编辑覆盖优先。
 * 新契约（2026-10-31）：
 *   · 候选支撑项只从「重要支撑」长出来：按重要性排序、necessity + causal、无支撑时
 *     SUPPORTS_REQUIRED、JSON 数组契约、lint 全绿；
 *   · 补全：里程碑只出愿景 / 重要支撑 / 核心指标，支撑项只出核心指标 + 实现思路；
 *   · 拆重要支撑输出 {"supports":[...]}。
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
const titleOk = (text) => /^.{2,40} · (里程碑|能力闭环|执行)「.+」$/.test(lineOf(text, 0));
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
    // 动作只挂在支撑项上：计划 / 执行 / 反馈
    if (node.kind === 'support') {
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

/* ── 3. 输出契约（下游解析依赖这些字面量） ── */
const planText = composePlanPrompt(fxArgs);
check('计划含 ## 目标', planText.includes('## 目标'));
check('计划含 ## 验证命令', planText.includes('## 验证命令'));
check('计划含 ## 步骤', planText.includes('## 步骤'));
check('计划要求 exit_plan_mode', planText.includes('exit_plan_mode'));
check('计划要「证据要求」块', planText.includes('\n证据要求\n'), '');
check('计划要 path:line 证据', planText.includes('path:line'), '');
check('计划要「非目标」块', planText.includes('\n非目标\n'), '');
check('计划步骤要文件+命令+预期+指标', planText.includes('改哪些文件 / 做什么 / 验证命令 / 预期结果 / 对应指标'), '');
check('计划吃能力闭环的只读字段与落点', planText.includes('- 承接能力闭环：') && planText.includes('  - 与闭环的关系：') && planText.includes('  - 功能模块：'), '');
check('计划不出现已退役的验收判据', !planText.includes('## 验收') && !planText.includes('达成判据'), '');
const reflectText = composeActionPrompt({ ...fxArgs, action: 'reflect' });
check('反馈提炼要 JSON lessons', reflectText.includes('{"lessons"'));

/* ── 3.5 拆主要能力闭环：只输出 {"capabilities":[...]} ── */
const splitText = composeSplitPrompt({ ...fxArgs, nodeId: 'sw-loop' });
check('拆主要能力闭环输出 {"capabilities"', splitText.includes('{"capabilities"'));
check('拆主要能力闭环注入已有条目', splitText.includes('- 已有主要能力闭环：') && splitText.includes('章节→情节两层索引'), '');
check('拆主要能力闭环按重要性排序', splitText.includes('按重要性'), '');
check('拆主要能力闭环不写模块路径 / 解法 / 验收', splitText.includes('不写模块路径、解法、步骤、工期、验收、指标'), '');
check('拆重要支撑 lint', lintPrompt(splitText).warnings.length === 0, JSON.stringify(lintPrompt(splitText).warnings.slice(0, 2)));
let splitOnSupport = null;
try { composeSplitPrompt({ ...fxArgs, nodeId: 'sw-i1' }); } catch (error) { splitOnSupport = error; }
check('能力闭环不能再拆（NOT_MILESTONE）', !!splitOnSupport && splitOnSupport.code === 'NOT_MILESTONE', String(splitOnSupport && splitOnSupport.code));

/* ── 3.6 候选能力闭环：模块归属 / 缺失影响 / 协同面 + CAPABILITIES_REQUIRED ── */
const candText = composeCandidatePrompt({ ...fxArgs, nodeId: 'sw-loop', count: 3 });
check('候选含「按重要性」', candText.includes('按重要性'), '');
check('候选要求必要性', candText.includes('必要性') && candText.includes('"necessity"'), '');
check('候选要求与闭环的关系', candText.includes('与闭环的关系') && candText.includes('"causal"'), '');
check('候选要求缺失影响', candText.includes('缺失影响') && candText.includes('"gap"'), '');
check('候选要求功能模块', candText.includes('功能模块') && candText.includes('"module"'), '');
check('候选要求改造还是新增', candText.includes('改造还是新增') && candText.includes('"module_mode"'), '');
check('候选要求协同面', candText.includes('协同面') && candText.includes('"collaboration"'), '');
check('候选要承接能力闭环条目', candText.includes('"capability"') && candText.includes('照抄'),
  candText.split('\n').filter((x) => x.includes('capability')).slice(0, 2).join(' | '));
check('候选要 importance 排序字段', candText.includes('"importance"'), '');
check('候选要证据要求块', candText.includes('\n证据要求\n'), '');
check('候选是 JSON 数组契约', candText.includes('[{"title"'), '');
check('候选没有旧的 strength / 差异轴口径', !candText.includes('"strength"') && !candText.includes('差异轴'), '');
check('候选 lint 全绿', lintPrompt(candText).warnings.length === 0, JSON.stringify(lintPrompt(candText).warnings.slice(0, 2)));
const candClamped = composeCandidatePrompt({ ...fxArgs, nodeId: 'sw-loop', count: 6 });
check('候选条数不超过主要能力闭环条数', candClamped.includes('给出 4 条'), candClamped.split('\n').find((x) => x.includes('给出')) || '');
const noSupportCard = JSON.parse(JSON.stringify(fx));
noSupportCard.milestone.capabilities = '';
let noSupportErr = null;
try { composeCandidatePrompt({ ...fxArgs, card: noSupportCard, nodeId: 'sw-loop' }); } catch (error) { noSupportErr = error; }
check('无主要能力闭环 → CAPABILITIES_REQUIRED', !!noSupportErr && noSupportErr.code === 'CAPABILITIES_REQUIRED', String(noSupportErr && noSupportErr.code));
let candOnSupport = null;
try { composeCandidatePrompt({ ...fxArgs, nodeId: 'sw-i1' }); } catch (error) { candOnSupport = error; }
check('能力闭环不能再生成候选（NOT_MILESTONE）', !!candOnSupport && candOnSupport.code === 'NOT_MILESTONE', String(candOnSupport && candOnSupport.code));

/* ── 3.7 补全：里程碑出 capabilities，能力闭环只出 metric + approach ── */
const msFill = composeFillPrompt({ ...fxArgs, nodeId: 'sw-loop', fields: ['vision', 'capabilities'] });
check('里程碑补全带愿景规则', msFill.includes('里程碑愿景 3–6 句'), '');
check('里程碑补全愿景上限 1000', msFill.includes('里程碑愿景 ≤1000 字'), '');
check('里程碑补全愿景要宏大叙事', msFill.includes('宏大叙事') && msFill.includes('不写功能清单'), '');
check('里程碑补全要主要能力闭环 3–5 条', msFill.includes('主要能力闭环 3–5 条'), '');
check('主要能力闭环按第一性原理', msFill.includes('第一性原理') && msFill.includes('必须形成哪几段'), '');
check('主要能力闭环按重要性排序', msFill.includes('按重要性排序'), '');
check('主要能力闭环要「证据要求」块', msFill.includes('\n证据要求\n') && msFill.includes('确实不存在'), '');
check('里程碑补全不再要核心指标', !msFill.includes('核心指标 2–5 条') && !msFill.includes('"metrics"'), '');
check('里程碑补全不再产出阻碍项 / 验收', !msFill.includes('阻碍项 3–5 条') && !msFill.includes('验收 3–5 条'), '');
check('里程碑补全 JSON 契约：愿景字符串、主要能力闭环数组',
  msFill.includes('"vision": "…"') && msFill.includes('"capabilities": ["…", "…"]'),
  msFill.split('\n').filter((x) => x.includes('capabilities')).join(' | '));
check('列表字段写明「一条一个元素」', msFill.includes('一条一个元素'), '');
check('列表字段禁止符号前缀', msFill.includes('行首不要加 ○ · • 这类符号'), '');
check('里程碑补全 lint', lintPrompt(msFill).warnings.length === 0, JSON.stringify(lintPrompt(msFill).warnings.slice(0, 2)));

const supFill = composeFillPrompt({ ...fxArgs, nodeId: 'sw-i1', fields: ['metric', 'approach'] });
check('能力闭环补全只出核心指标 + 实现思路', supFill.includes('只补这几项：核心指标、实现思路'), supFill.split('\n').find((x) => x.includes('只补')) || '');
check('能力闭环核心指标要到什么程度算撑住', supFill.includes('到什么程度算撑住'), '');
check('能力闭环实现思路不写步骤清单', supFill.includes('实现思路') && supFill.includes('不写步骤清单'), '');
check('能力闭环补全注入只读字段', supFill.includes('- 承接能力闭环：') && supFill.includes('  - 必要性：') && supFill.includes('  - 与闭环的关系：'), '');
check('能力闭环补全不再要主要能力闭环 / 里程碑愿景', !supFill.includes('主要能力闭环 3–5 条') && !supFill.includes('里程碑愿景 3–6 句'), '');
check('能力闭环补全 JSON 契约', supFill.includes('"metric": "…"') && supFill.includes('"approach": "…"'), '');
check('能力闭环补全 lint', lintPrompt(supFill).warnings.length === 0, JSON.stringify(lintPrompt(supFill).warnings.slice(0, 2)));

/* ── 3.8 上下文注入：主要能力闭环 / 能力闭环只读项 / 同级 ── */
const withCtx = JSON.parse(JSON.stringify(fx));
withCtx.prompt_context = { fields: ['project', 'node', 'refs'], refs: ['sw-e4'] };
const ctxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('prompt_context.fields 生效', ctxText.includes('- 项目：X') && !ctxText.includes('- 里程碑：'), ctxText.slice(0, 80));
check('prompt_context.refs 生效', ctxText.includes('- 引用：') && ctxText.includes('sw-e4'), '');
withCtx.prompt_context = { fields: ['node', 'siblings'], siblings: 1 };
const sibText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('siblings 条数生效', sibText.includes('- 同级能力闭环：') && sibText.includes('分层 SVG 绘制'), sibText.split('\n').find((l) => l.includes('同级')) || '');
withCtx.prompt_context = { fields: ['milestone', 'milestone.vision', 'milestone.capabilities', 'milestone.metrics'] };  // 旧键保留只为不报未知字段
const msCtxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-i1', taskId: 'plan' });
check('里程碑愿景进上下文', msCtxText.includes('- 里程碑愿景：'), '');
check('主要能力闭环进上下文', msCtxText.includes('- 主要能力闭环：') && msCtxText.includes('章节→情节两层索引'), '');
check('里程碑核心指标已退役：旧键不再注入', !msCtxText.includes('里程碑核心指标') && !msCtxText.includes('三层图各 ≥8 节点'), '');
withCtx.prompt_context = { fields: ['capability', 'capability.necessity', 'capability.causal', 'capability.gap', 'capability.module', 'capability.metric', 'capability.approach'] };
const supCtxText = composeTaskPrompt({ projectName: 'X', card: withCtx, nodeId: 'sw-e1', taskId: 'plan' });
check('能力闭环只读项 + 指标思路进下级上下文',
  supCtxText.includes('- 能力闭环：章节 → 情节两层索引')
  && supCtxText.includes('  - 必要性：') && supCtxText.includes('  - 与闭环的关系：')
  && supCtxText.includes('  - 缺失影响：') && supCtxText.includes('  - 功能模块：')
  && supCtxText.includes('  - 核心指标：章节与情节两层索引可双向查询')
  && supCtxText.includes('  - 实现思路：章节表 + 情节表'),
  supCtxText.split('\n').filter((l) => /能力闭环|必要性|与闭环|缺失影响|功能模块|核心指标|实现思路/.test(l)).join(' | '));
check('node.metric / node.approach 进能力闭环上下文',
  composeTaskPrompt({ projectName: 'X', card: { ...fx, prompt_context: { fields: ['node.metric', 'node.approach'] } }, nodeId: 'sw-i1', taskId: 'plan' }).includes('- 核心指标：章节与情节两层索引可双向查询'));

/* ── 4. 模板优先级 ── */
const custom = JSON.parse(JSON.stringify(fx));
custom.milestone.children[0].prompts = [{ id: 'mine', title: '我的模板', ask: '只输出一句话结论。' }];
const nodeList = listTaskPrompts({ projectName: 'X', card: custom, nodeId: 'sw-i1' });
check('节点自定义模板优先', nodeList.from === '节点自定义' && nodeList.list[0].id === 'mine', nodeList.from);
const cardPrompts = listTaskPrompts({ projectName: 'X', card: fx, nodeId: 'sw-i1' });
check('卡片按 kind 的模板生效', cardPrompts.from === 'rotation.json' && cardPrompts.list[0].id === 'regen', cardPrompts.from);

/* ── 5. lint 能抓到反例 ── */
const bad = [
  { text: '为「x」项目生成计划。项目目录：/w 先读文件。', code: 'bad-title' },
  { text: '生成计划 · 支撑项「x」\n背景\n- 项目：x', code: 'missing-blank' },
  { text: '生成计划 · 支撑项「x」\n\n背景\n' + '很长的行'.repeat(20), code: 'line-too-long' },
  { text: '生成计划 · 支撑项「x」\n\n背景\n- **加粗**', code: 'markdown-bold' },
  { text: '生成计划 · 支撑项「x」\n\n背景\n\n\n任务\n1. a', code: 'double-blank' },
  { text: '生成计划 · 支撑项「x」\n\n任务\n\n输出\n- a', code: 'empty-block' },
];
for (const item of bad) {
  const codes = lintPrompt(item.text).warnings.map((w) => w.code);
  check(`lint 抓到 ${item.code}`, codes.includes(item.code), JSON.stringify(codes));
}
const clean = lintPrompt(planText);
check('合规 prompt lint 无警告', clean.ok, JSON.stringify(clean.warnings.slice(0, 2)));
check('上限检查生效', lintPrompt(planText, { maxLength: 10 }).warnings.some((w) => w.code === 'too-long'), '');

/* ── 6. 服务信息收集：项目级 prompt，要求平台化 start + JSON 契约 ── */
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

/* ── 结果 ── */
const failed = results.filter((r) => !r.pass);
console.log(`\n共 ${nodeCount} 个节点 / ${taskCount} 条模板 / ${actionCount} 条动作 prompt`);
console.log(failed.length ? `${failed.length} 项失败` : 'prompt 结构全部通过');
process.exit(failed.length ? 1 : 0);
