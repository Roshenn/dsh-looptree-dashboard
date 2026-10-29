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
const titleOk = (text) => /^.{2,40} · (闭环|目标|构思|执行)「.+」$/.test(lineOf(text, 0));
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
  for (const node of walk(card.loop)) {
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

/* ── 4. 模板优先级与 prompt_context 配置 ── */
const custom = JSON.parse(JSON.stringify(fx));
custom.loop.children[0].children[0].prompts = [{ id: 'mine', title: '我的模板', ask: '只输出一句话结论。' }];
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
