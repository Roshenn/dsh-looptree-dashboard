/**
 * lib/prompt.mjs — prompt 的唯一实现（结构规范 + 合成 + 结构 lint）。
 *
 * 纯函数、无 I/O：host 路由、测试脚本共用这一份，面板只负责展示与编辑。
 *
 * 结构规范（docs/prompts.md）：
 *   首行：<动作> · <对象>
 *   空行分块，块标签单独一行（2–4 字）：背景 / 当前节点 / 任务 / 要做什么 /
 *   验收 / 约束 / 输出 / 验证命令 / 步骤 / 提交方式 / 收尾 / 质量要求
 *   块内一行一个事实或动作；键值 `- 键：值`；步骤 `1. `
 *
 * 为什么不用 markdown 标题：DSH 的用户气泡是 white-space:pre-wrap 的纯文本，
 * 不渲染 markdown，`#` / `**` 会原样露出来。唯一例外是「输出」块里要求模型
 * 产出的 markdown 小节（## 目标 / ## 验证命令 / ## 步骤）。
 */

import { LIST_FIELDS } from './core.mjs';

/** 树只有三层：里程碑 → 支撑项 → 执行（执行记录再用 action 区分计划/执行/反馈） */
const KIND_LABEL = { milestone: '里程碑', support: '支撑项', exec: '执行' };
const STATUS_LABEL = { plan: '规划中', ready: '就绪', doing: '进行中', blocked: '阻塞', done: '已完成' };
const CHILD_KIND = { milestone: 'support' };
const CHILD_LABEL = { support: '支撑项', exec: '执行' };
const FIELD_MAX = 300;
/** 愿景是宏大叙事，单独放宽（与 core 的 VISION_MAX 同源） */
const FIELD_MAX_BY_FIELD = { vision: 1000 };
const fieldMaxOf = (field) => FIELD_MAX_BY_FIELD[field] || FIELD_MAX;

/** 允许的块标签（lint 用它判断「块标签后面必须有内容」） */
export const BLOCK_LABELS = new Set([
  '背景', '当前节点', '场景', '任务', '要做什么', '证据要求', '非目标',
  '验收', '约束', '输出', '验证命令', '步骤', '提交方式', '收尾', '质量要求', '示例',
]);

/** 动作 → 中文动词（首行用） */
export const ACTION_TITLE = { plan: '生成计划', exec: '执行计划', reflect: '反馈提炼' };

/* ─────────── 基础工具 ─────────── */

const clean = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
const oneLine = (v) => clean(v).replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s));
const len = (s) => [...String(s)].length;
/** 视觉宽度：CJK / 全角记 2，其余记 1（和气泡里的折行接近） */
const width = (s) => [...String(s)].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1), 0);
const BREAK_CHARS = '，。；、：,.;:)]）」。！？!?';
/**
 * 超宽的行按标点断成多行（续行缩进），保证气泡里不会出现一条大长线。
 * 注意：续行前缀 `pad` 也算进 72 列预算，否则续行会稳定超宽 2–4 列。
 */
function wrapLine(line, max = 72) {
  const text = String(line);
  if (width(text) <= max) return [line];
  const lead = (text.match(/^\s*/) || [''])[0];
  const pad = lead + '  ';
  const padW = width(pad);
  const chars = [...text];
  const out = [];
  let rest = chars;
  let first = true;
  while (true) {
    const limit = first ? max : max - padW;
    if (width(rest.join('')) <= limit) break;
    let acc = 0;
    let cut = 0;
    for (let i = 0; i < rest.length; i += 1) {
      acc += width(rest[i]);
      if (acc > limit) break;
      cut = i + 1;
    }
    // 在窗口后半段找一个断点：优先标点，其次空格（别把路径/单词拦腰截断）
    let at = -1;
    for (let i = cut; i > Math.floor(cut / 2); i -= 1) {
      if (BREAK_CHARS.includes(rest[i - 1])) { at = i; break; }
    }
    if (at < 0) {
      for (let i = cut; i > Math.floor(cut / 2); i -= 1) {
        if (rest[i - 1] === ' ') { at = i; break; }
      }
    }
    const take = at > 0 ? at : cut;
    const piece = rest.slice(0, take).join('').replace(/\s+$/u, '');
    out.push((first ? '' : pad) + piece);
    rest = rest.slice(take);
    first = false;
  }
  out.push((first ? '' : pad) + rest.join(''));
  return out;
}
/** 代码块 / JSON 契约行不折行（折了会破坏可复制的字面量） */
const noWrap = (line) => /^\s*(```|## |[\[{])/.test(line);

function statusLabel(n) {
  if (!n) return '—';
  if (n.closed_at) return n.kind === 'milestone' ? '已达成' : '已闭环';
  return STATUS_LABEL[n.status] || '规划中';
}

function isRecord(n) {
  return !!n && n.kind === 'exec' && ['plan', 'exec', 'reflect'].includes(n.action);
}

function findNode(node, id) {
  if (!node || !id) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** 根 → 目标节点 的路径（含两端）；找不到返回 null */
function pathTo(root, id) {
  const trail = [];
  const walk = (node) => {
    if (!node) return false;
    trail.push(node);
    if (node.id === id) return true;
    for (const child of node.children || []) {
      if (walk(child)) return true;
    }
    trail.pop();
    return false;
  };
  return walk(root) ? trail.slice() : null;
}

/** 把一段可能带换行/分号的文本拆成一行一条 */
function splitItems(text) {
  return clean(text)
    .split(/\n+|(?<=[；;])/u)
    .map((x) => x.replace(/^[-*+]\s*/, '').replace(/[；;]\s*$/, '').trim())
    .filter(Boolean);
}

/**
 * 长字段注入前裁剪：保头部，尾巴标「全文见卡片」。
 * 里程碑愿景 / 重要支撑在真实卡片里可能几百字；动作 prompt 有 1500 字上限，
 * 照抄就超。全文本来就在 rotation.json 里，执行者需要时能自己读。
 */
const CLIP_NOTE = '…（全文见卡片）';
function clipText(text, n) {
  const s = oneLine(text);
  return len(s) > n ? `${[...s].slice(0, n).join('')}${CLIP_NOTE}` : s;
}

/** 列表字段压成一行：条目之间用「；」，别让两条指标粘成一句话 */
function listInline(text, n) {
  const items = clean(text).split('\n').map((x) => x.trim()).filter(Boolean);
  return clipText(items.join('；'), n);
}

/** 重要支撑原文自带「1)」编号：去掉，免得和注入的序号叠成「1) 1)缺…」 */
const stripItemNo = (item) => String(item).replace(/^\s*(?:\d+\s*[).、．]|[①-⑳]|[-*+])\s*/u, '');

/**
 * 重要支撑注入：卡片里是「一条一行」，注入时保持一条一行（缩进由调用方给）。
 * 有预算，超出部分的全文留在卡片里。
 */
function supportLines(supports, budget = 200) {
  const items = clean(supports).split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let used = 0;
  for (const item of items) {
    const cost = len(item);
    if (out.length && used + cost > budget) break;
    out.push(`- ${item}`);
    used += cost;
  }
  if (out.length < items.length) out.push('- …（其余重要支撑见卡片）');
  return out;
}

/** 候选要从重要支撑里逐条认领：编号是模型对齐条目的锚，不随条目写进卡片 */
function numberedItems(supports, budget = 320) {
  const items = clean(supports).split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let used = 0;
  for (const item of items) {
    const cost = len(item);
    if (out.length && used + cost > budget) break;
    out.push(`${out.length + 1}) ${clipText(stripItemNo(item), 110)}`);
    used += cost;
  }
  return out;
}

/** 合成：首行标题 + 空行分块的正文；空块自动丢掉；超宽行折成多行 */
function renderPrompt(title, blocks) {
  const out = [title];
  for (const block of blocks) {
    const lines = (block.lines || [])
      .flatMap((x) => String(x == null ? '' : x).split('\n'))
      .map((x) => x.replace(/[ \t]+$/g, ''))
      .filter((x) => x.trim() !== '')
      .flatMap((x) => (noWrap(x) ? [x] : wrapLine(x)));
    if (!lines.length) continue;
    out.push('', block.label, ...lines);
  }
  return out.join('\n');
}

function nodeLabel(node) {
  const title = clip(oneLine(node && node.title) || '（未命名）', 24);
  return `${KIND_LABEL[node.kind] || '节点'}「${title}」`;
}

/* ─────────── 内置任务模板（按节点类型） ─────────── */

const OUTPUT_DEFAULT = {
  milestone: ['用 Markdown。', '每条一行：一条重要支撑（按重要性排序）。', '不复述上下文，直接给结论。'],
  support: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  exec: ['用 Markdown。', '按任务要求给结果，句短、一条一义。', '不复述上下文。'],
};

const T = (id, title, summary, ask, output) => ({ id, title, summary, ask, output });

/** 内置模板：node.prompts > card.prompts[类型] > 这里 */
export const PROMPT_TASKS = {
  milestone: [
    T('split', '拆出重要支撑', '里程碑 → 3–5 条重要支撑', [
      '拆出这个里程碑的重要支撑：要让里程碑愿景成立，必须有哪些东西存在。',
      '从第一性原理问：少了它，愿景的哪一步就立不住。',
      '按重要性从高到低排序，每条一句话说清「要什么」。',
    ], ['用 Markdown。', '每条一行：一条重要支撑，按重要性排序。', '不写解法、工期与验收。']),
    T('closed', '检查是否真的达成', '查支撑项是否都服务于同一愿景', [
      '检查这个里程碑是否真的达成。',
      '每个支撑项是否都服务于同一个里程碑愿景。',
      '有没有支撑项其实不属于它；离愿景还差哪一环。',
    ], ['用 Markdown。', '先给结论：真达成 / 没达成。', '再列缺口，一条一行。']),
  ],
  support: [
    T('plan', '梳理执行计划', '支撑项 → 3–6 个动作', [
      '把这个支撑项拆成执行计划：3–6 个可执行动作。',
      '每个动作给出验证方式与预期证据。',
      '标注依赖顺序；做完要让核心指标达标。',
    ], ['用 Markdown。', '按依赖顺序列 3–6 个动作，每个动作带验证方式与证据。']),
    T('risk', '预演失败点', '列 3 个失败点与早期信号', [
      '预演这个支撑项落地会遇到什么。',
      '列出 3 个最可能的失败点。',
      '每个失败点给出早期信号。',
    ], ['用 Markdown。', '3 个失败点，每个一行：失败点 + 早期信号。']),
  ],
  exec: [
    T('steps', '给出执行步骤', '执行项 → 可操作步骤', [
      '把这条执行项拆成具体可执行的操作步骤。',
      '每一步给出验证命令与通过标准。',
    ], ['用 Markdown。', '每个步骤：操作 + 验证命令 + 通过标准。']),
    T('proof', '补齐证据', '列该采集什么证据', [
      '这条执行项准备关闭但证据不足。',
      '列出应该采集哪些证据（命令、输出、截图）。',
      '给出每条的采集方式。',
    ], ['用 Markdown。', '每条证据一行：采什么 + 怎么采。']),
    T('blocker', '定位阻塞', '3 个原因与验证方法', [
      '这条执行项当前阻塞。',
      '给出 3 个可能原因与各自的验证方法。',
      '按最可能优先排序。',
    ], ['用 Markdown。', '3 个原因按可能性排序，每个给验证方法。']),
  ],
};

/* ─────────── 上下文（详情模板用） ─────────── */

const CTX_DEFAULT_FIELDS = [
  'project', 'milestone', 'milestone.vision', 'milestone.metrics', 'milestone.supports',
  'support', 'support.text', 'support.necessity', 'support.causal',
  'support.metric', 'support.approach',
  'node', 'node.metric', 'node.approach',
  'exec.verify', 'exec.proof', 'exec.issues', 'children',
];

/** 路径上离当前节点最近的那条支撑项；当前节点自己就是支撑项时返回 null */
function supportOf(trail, node) {
  return trail.find((x) => x.kind === 'support' && x !== node) || null;
}

const CTX_FIELDS = {
  project: {
    sec: 'ctx',
    r: ({ pname }) => [`- 项目：${pname}`],
  },
  milestone: {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] ? [`- 里程碑：${oneLine(trail[0].title)}`] : []),
  },
  'milestone.vision': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].vision ? [`  - 里程碑愿景：${clipText(trail[0].vision, 200)}`] : []),
  },
  'milestone.metrics': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].metrics
      ? [`  - 核心指标：${clipText(trail[0].metrics, 200)}`]
      : []),
  },
  // 里程碑验收已退役（达成效果改用核心指标）：旧卡里的 acceptance 不再注入，键名保留只为旧 prompt_context 不报未知字段
  'milestone.acceptance': {
    sec: 'ctx',
    r: (ctx) => CTX_FIELDS['milestone.metrics'].r(ctx),
  },
  // 重要支撑：一条一行，逐条编号注入（与旧阻碍项同一套渲染）
  'milestone.supports': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].supports
      ? ['  - 重要支撑：', ...supportLines(trail[0].supports, 200).map((x) => `    ${x}`)]
      : []),
  },
  // 旧字段名兜底：读入已由 core.normalizeLegacyCard 改名，这里只为手写 prompt_context 不报未知字段
  'milestone.blockers': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.supports'].r(ctx) },
  loop: { sec: 'ctx', r: (ctx) => CTX_FIELDS.milestone.r(ctx) },
  'loop.intent': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.vision'].r(ctx) },
  'loop.acceptance': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.metrics'].r(ctx) },
  'loop.blockers': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.supports'].r(ctx) },
  support: {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support ? [`- 支撑项：${oneLine(support.title)}`] : [];
    },
  },
  'support.text': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support && support.support ? [`  - 承接支撑项：${clipText(support.support, 80)}`] : [];
    },
  },
  'support.necessity': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support && support.necessity ? [`  - 必要性：${clipText(support.necessity, 200)}`] : [];
    },
  },
  'support.causal': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support && support.causal ? [`  - 因果：${clipText(support.causal, 200)}`] : [];
    },
  },
  'support.metric': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support && support.metric ? [`  - 核心指标：${clipText(support.metric, 200)}`] : [];
    },
  },
  'support.approach': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const support = supportOf(trail, node);
      return support && support.approach ? [`  - 实现思路：${clipText(support.approach, 200)}`] : [];
    },
  },
  // 旧键别名：goal / idea 都是支撑项的前身，旧 prompt_context 仍拿到同一份内容
  goal: { sec: 'ctx', r: (ctx) => CTX_FIELDS.support.r(ctx) },
  'goal.acceptance': { sec: 'ctx', r: (ctx) => CTX_FIELDS['support.metric'].r(ctx) },
  // 落地场景流程已退役：留在 JSON 里，但不显示、不校验、不进 prompt
  'goal.scenario': { sec: 'ctx', r: () => [] },
  idea: { sec: 'ctx', r: (ctx) => CTX_FIELDS.support.r(ctx) },
  'idea.approach': { sec: 'ctx', r: (ctx) => CTX_FIELDS['support.approach'].r(ctx) },
  siblings: {
    sec: 'ctx',
    r: ({ trail, node, cfg }) => {
      const parent = trail[trail.length - 2];
      if (!parent) return [];
      const sibs = (parent.children || []).filter((x) => x.id !== node.id).slice(0, cfg.siblings || 3);
      if (!sibs.length) return [];
      const label = CHILD_LABEL[sibs[0].kind] || '节点';
      return [`- 同级${label}：${sibs.map((x) => `${x.title}${x.closed_at ? '（已关闭）' : ''}`).join('；')}`];
    },
  },
  refs: {
    sec: 'ctx',
    r: ({ root, cfg }) => {
      const ids = Array.isArray(cfg.refs) ? cfg.refs : [];
      if (!ids.length) return [];
      const lines = [];
      ids.forEach((id) => {
        const x = findNode(root, id);
        if (!x) return;
        lines.push(`- 引用：${KIND_LABEL[x.kind] || '节点'}「${x.title}」(${x.id})`);
        lines.push(`  - 状态：${statusLabel(x)}`);
        if (x.kind === 'exec' && !isRecord(x)) {
          if (x.verify) lines.push(`  - 验证：${oneLine(x.verify)}`);
          if (x.proof) lines.push(`  - 证据：${oneLine(x.proof)}`);
        }
        if (x.kind === 'exec') {
          const open = (x.issues || []).filter((i) => !i.resolved_at).map((i) => i.text);
          if (open.length) lines.push(`  - 未处置反馈：${open.join('；')}`);
        } else if (x.kind === 'support' && x.metric) {
          lines.push(`  - 核心指标：${oneLine(x.metric)}`);
        }
      });
      return lines;
    },
  },
  node: {
    sec: 'node',
    r: ({ node }) => [`- id：${node.id}`, `- 状态：${statusLabel(node)}`],
  },
  'node.metric': {
    sec: 'node',
    r: ({ node }) => (
      node.kind === 'support' && node.metric
        ? [`- 核心指标：${oneLine(node.metric)}`]
        : []
    ),
  },
  'node.approach': {
    sec: 'node',
    r: ({ node }) => (node.kind === 'support' && node.approach ? [`- 实现思路：${oneLine(node.approach)}`] : []),
  },
  // 旧键别名：验收已退役，节点级验收统一映射到核心指标
  'node.acceptance': { sec: 'node', r: (ctx) => CTX_FIELDS['node.metric'].r(ctx) },
  'exec.verify': {
    sec: 'node',
    r: ({ node }) => (node.kind === 'exec' && !isRecord(node) && node.verify ? [`- 验证方式：${oneLine(node.verify)}`] : []),
  },
  'exec.proof': {
    sec: 'node',
    r: ({ node }) => (node.kind === 'exec' && !isRecord(node) ? [`- 证据：${clean(node.proof) || '（未填写）'}`] : []),
  },
  'exec.issues': {
    sec: 'node',
    r: ({ node }) => {
      const open = ((node.issues || []).filter((i) => !i.resolved_at)).map((i) => i.text);
      return open.length ? [`- 未处置反馈：${open.join('；')}`] : [];
    },
  },
  children: {
    sec: 'node',
    r: ({ node }) => {
      const kids = (node.children || []).filter((k) => !isRecord(k)).slice(0, 6)
        .map((k) => `${CHILD_LABEL[k.kind] || '节点'}·${k.title}`);
      return childLine('- 已有子节点', kids);
    },
  },
};

/** 子节点一行放得下就一行；放不下就标题占一行、每个子节点一行 */
function childLine(label, items) {
  if (!items.length) return [];
  const joined = items.join('；');
  if (len(joined) <= 48) return [`${label}：${joined}`];
  return [`${label}：`, ...items.map((x) => `  - ${x}`)];
}

function contextConf(card, node) {
  const fromNode = node && node.prompt_context;
  const fromCard = card && card.prompt_context;
  const cfg = fromNode || fromCard || {};
  const refs = Array.isArray(cfg.refs) ? cfg.refs.filter((x) => typeof x === 'string') : [];
  let fields = Array.isArray(cfg.fields) && cfg.fields.length ? cfg.fields.slice() : CTX_DEFAULT_FIELDS.slice();
  if (refs.length && !fields.includes('refs')) fields = fields.concat(['refs']);
  return {
    fields,
    siblings: Number.isFinite(cfg.siblings) ? cfg.siblings : 0,
    refs,
  };
}

/** 模板来源：节点自定义 > 卡片按类型 > 内置 */
export function taskListFor(card, node) {
  const nodePrompts = node && node.prompts;
  if (Array.isArray(nodePrompts) && nodePrompts.length) return { list: nodePrompts, from: '节点自定义' };
  const cardPrompts = card && card.prompts;
  if (cardPrompts && Array.isArray(cardPrompts[node.kind]) && cardPrompts[node.kind].length) {
    return { list: cardPrompts[node.kind], from: 'rotation.json' };
  }
  return { list: PROMPT_TASKS[node.kind] || [], from: '内置' };
}

/** 自定义任务可能只写了一句 ask：拆行后放「任务」块 */
function askLines(task) {
  if (Array.isArray(task.ask)) return task.ask.map((x) => String(x));
  return splitItems(task.ask).map((line) => line); // 自定义模板可能是一整句，原样保留（lint 会提示过长）
}

function taskSummary(task) {
  if (task.summary) return task.summary;
  const text = Array.isArray(task.ask) ? task.ask.join(' / ') : String(task.ask || '');
  return clip(oneLine(text), 24);
}

/* ─────────── 详情卡模板 prompt ─────────── */

/**
 * 合成某个节点某条模板的 prompt。
 * @returns {string}
 */
export function composeTaskPrompt({ projectName, card, nodeId, taskId }) {
  const doc = card || {};
  const root = doc.milestone;
  const trail = pathTo(root, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const node = trail[trail.length - 1];
  const tasks = taskListFor(doc, node);
  const task = tasks.list.find((t) => t.id === taskId) || tasks.list[0];
  if (!task) throw Object.assign(new Error('这个节点没有可用的 prompt 模板'), { code: 'NO_TASKS' });

  const cfg = contextConf(doc, node);
  const ctx = { pname: projectName || (doc.project && doc.project.name) || '项目', root, trail, node, cfg };
  const ctxLines = [];
  const nodeLines = [];
  for (const key of cfg.fields) {
    const field = CTX_FIELDS[key];
    if (!field) continue;
    let lines = [];
    try { lines = field.r(ctx) || []; } catch { lines = []; }
    (field.sec === 'ctx' ? ctxLines : nodeLines).push(...lines);
  }

  return renderPrompt(
    `${oneLine(task.title)} · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: ctxLines },
      { label: '当前节点', lines: nodeLines },
      { label: '任务', lines: askLines(task) },
      { label: '输出', lines: Array.isArray(task.output) ? task.output : (OUTPUT_DEFAULT[node.kind] || []) },
    ],
  );
}

/** 详情卡模板列表（面板「查看」用；每条带 summary 与 prompt） */
export function listTaskPrompts({ projectName, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const tasks = taskListFor(doc, node);
  const list = tasks.list.map((task) => {
    const prompt = composeTaskPrompt({ projectName, card: doc, nodeId, taskId: task.id });
    return {
      id: task.id,
      title: oneLine(task.title),
      summary: taskSummary(task),
      prompt,
      warnings: lintPrompt(prompt).warnings,
    };
  });
  return { from: tasks.from, list };
}

/* ─────────── 支撑项动作：计划 / 执行 / 反馈 ─────────── */

function supportContext({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const trail = pathTo(doc.milestone, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const support = trail[trail.length - 1];
  if (support.kind !== 'support') throw Object.assign(new Error('只有支撑项能发起动作'), { code: 'NOT_SUPPORT' });
  const milestone = trail[0];
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  return { doc, trail, support, milestone, pname, ws };
}

function projectLine(pname, ws) {
  return ws ? `- 项目：${pname}（${ws}）` : `- 项目：${pname}`;
}

/**
 * 卡片文件路径（/goal 计划指针用）。
 * 与 lib/store.mjs 的 `join(workspace, '.dsh/rotation.json')` 同源；
 * 这里只做字符串拼接，不做 I/O，也统一成 `/` 免得分隔符混用。
 */
function cardFilePath(ws) {
  const base = String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return base ? `${base}/.dsh/rotation.json` : '';
}

/** 生成计划：走 /plan，正文整体作为命令参数（保留换行） */
export function composePlanPrompt(args) {
  const { doc, support, milestone, pname, ws } = supportContext(args);
  const metric = clean(support.metric);
  const approach = clean(support.approach);
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  if (milestone) {
    background.push(`- 里程碑：${oneLine(milestone.title)}`);
    if (milestone.vision) background.push(`  - 里程碑愿景：${clipText(milestone.vision, 200)}`);
    if (milestone.metrics) background.push(`  - 里程碑核心指标：${listInline(milestone.metrics, 160)}`);
  }
  background.push(`- 支撑项：${oneLine(support.title)}`);
  if (support.support) background.push(`  - 承接支撑项：${clipText(support.support, 80)}`);
  if (support.necessity) background.push(`  - 必要性：${clipText(support.necessity, 160)}`);
  if (support.causal) background.push(`  - 因果：${clipText(support.causal, 160)}`);
  if (metric) background.push(`  - 核心指标：${clipText(metric, 160)}`);
  if (approach) background.push(`  - 实现思路：${clipText(approach, 160)}`);
  const plan = support.plan || {};
  const priorSteps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  if (plan.goal || priorSteps.length) {
    background.push(`- 已有计划：${oneLine(plan.goal || '（无目标行）')}（${priorSteps.length} 步）`);
  }
  const cfg = contextConf(doc, support);
  if (cfg.refs.length) background.push(...CTX_FIELDS.refs.r({ root: doc.milestone, cfg }));
  // 要做什么：计划输入只吃这三样——承接支撑项、核心指标、实现思路
  const claim = oneLine(support.support) || oneLine(support.title);
  const metricText = metric ? clipText(metric, 120) : '（未填写，先按承接支撑项兜底）';
  const approachText = approach ? clipText(approach, 120) : '（未填写，按承接支撑项与核心指标自行收窄）';

  return renderPrompt(
    `${ACTION_TITLE.plan} · ${nodeLabel(support)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          `1. 承接支撑项：${claim}。`,
          `2. 核心指标：${metricText}。`,
          `3. 实现思路：${approachText}。`,
          '4. 按这三条产出可执行计划，改动点落到文件与动作，别停在方向。',
        ],
      },
      {
        label: '证据要求',
        lines: [
          '1. 先读：README、package.json 与脚本、相关源码与测试、最近提交、产物。',
          '2. 给出 3–5 条可核对事实，每条带 path:line 或命令输出。',
          '3. 先复现或确认当前行为；复现不了就写清卡在哪。',
          '4. 列出未决问题；查不到就写假设，不要猜 API / 字段 / 命令。',
        ],
      },
      {
        label: '任务',
        lines: [
          `产出可执行计划，做完能让核心指标「${clipText(metric || support.title, 30)}」达标。`,
          '成功标准：',
          '- 每个改动点有文件路径与具体动作。',
          '- 每一步有可执行验证命令与预期结果。',
          '- 完成判定对齐核心指标，别用「能跑」代替「指标达标」。',
          '- 覆盖边界与失败模式；写明非目标。',
        ],
      },
      {
        label: '非目标',
        lines: [
          '- 不重构无关代码；不升级依赖。',
          '- 不改公开契约：API、JSON 字段、命令格式。',
        ],
      },
      {
        label: '输出',
        lines: [
          '用 Markdown，三节顺序固定：',
          '## 目标',
          '一句话：做完之后能稳定做到什么（对齐核心指标）。',
          '## 验证命令',
          '可直接执行的 bash 命令，一行一条；每条写清预期结果。',
          '## 步骤',
          '1. 改哪些文件 / 做什么 / 验证命令 / 预期结果 / 对应指标。',
          '2. …',
        ],
      },
      {
        label: '提交方式',
        lines: [
          '- 写完用 exit_plan_mode 提交，plan 传完整 markdown。',
          '- 不要直接开始执行。',
        ],
      },
    ],
  );
}

/** 执行计划：/goal 的正文（命令不可用时退回这段） */
export function composeExecPrompt(args) {
  const { support, milestone, pname, ws } = supportContext(args);
  const plan = support.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];

  const background = [projectLine(pname, ws)];
  if (milestone) {
    background.push(`- 里程碑：${oneLine(milestone.title)}`);
    if (milestone.metrics) background.push(`  - 里程碑核心指标：${listInline(milestone.metrics, 160)}`);
  }
  background.push(`- 支撑项：${oneLine(support.title)}`);
  if (support.support) background.push(`  - 承接支撑项：${clipText(support.support, 80)}`);
  if (support.metric) background.push(`  - 核心指标：${clipText(support.metric, 160)}`);
  if (support.approach) background.push(`  - 实现思路：${clipText(support.approach, 160)}`);
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  if (steps.length) background.push(`- 步骤：${steps.length} 条`);
  if (verify.length) background.push(`- 验证：${verify.length} 条`);

  return renderPrompt(
    `${ACTION_TITLE.exec} · ${nodeLabel(support)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 按下面的计划执行，直到核心指标达标，不要停在「打算做」。',
          '2. 每完成一步跑一次验证；失败就修到通过。',
          '3. 全部通过后给一段简短总结。',
        ],
      },
      { label: '验证命令', lines: verify.map((x) => `- ${oneLine(x)}`) },
      { label: '步骤', lines: steps.map((x, i) => `${i + 1}. ${oneLine(x)}`) },
      { label: '收尾', lines: ['- 只写两件事：改了什么、怎么验证的（命令与结果）。'] },
    ],
  );
}

/**
 * /goal 的一句话目标：单行、≤240 字（目标面板按一行显示）。
 *
 * 常态发「计划指针」：240 字只用来交代「计划在哪、怎么执行」，完整 steps/verify
 * 留在卡片文件里，agent 用读文件工具取。实测把 25 步压进 240 字会在命令中间截断，
 * 执行者拿不到完整计划——信息通道问题，压缩措辞解决不了。
 * 没有 workspace 时退回内联压缩版。
 */
export function composeGoalObjective(args) {
  const { support, ws } = supportContext(args);
  const plan = support.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];
  const title = oneLine(support.title);
  const metric = oneLine(support.metric);
  const file = cardFilePath(ws);

  if (file) {
    return clip(
      `执行支撑项「${title}」的计划：读 ${file} 中 id=${support.id} 节点的 plan`
      + '（goal/steps/verify），按步骤执行，先跑验证命令；失败修到过；'
      + `核心指标「${metric || title}」达标才算完；发现计划有错先说明再调整。`
      + '收尾：写改动+命令结果。',
      240,
    );
  }

  const parts = [
    `执行支撑项「${title}」的计划：${oneLine(plan.goal || metric || title).replace(/[。．.!！?？]+$/u, '')}。`,
  ];
  if (steps.length) parts.push(`步骤 ${steps.length} 条：${steps.slice(0, 4).map((s, i) => `${i + 1}) ${oneLine(s)}`).join('；')}。`);
  if (verify.length) parts.push(`验证：${verify.slice(0, 2).map(oneLine).join('；')}。`);
  parts.push('做完说明改了什么、验证结果。');
  return clip(parts.join(''), 240);
}

/** 反馈提炼：同一会话里的普通追问，只输出 JSON */
export function composeReflectPrompt(args) {
  const { support, pname, ws } = supportContext(args);
  const plan = support.plan || {};
  const background = [projectLine(pname, ws), `- 支撑项：${oneLine(support.title)}`];
  if (support.metric) background.push(`- 核心指标：${clipText(support.metric, 120)}`);
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  return renderPrompt(
    `${ACTION_TITLE.reflect} · ${nodeLabel(support)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 复盘刚才这次执行。',
          '2. 只输出 JSON 对象：{"lessons": ["…"]}',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 每条 ≤ 200 字，最多 5 条。',
          '- 写可复用的经验：踩坑、口径、验证方式、协作约定。',
          '- 不写过程流水账。',
          '- 没有新经验就输出 {"lessons": []}。',
        ],
      },
    ],
  );
}

/** 动作 → 结构化 prompt */
export function composeActionPrompt({ action, ...args }) {
  if (action === 'plan') return composePlanPrompt(args);
  if (action === 'exec') return composeExecPrompt(args);
  if (action === 'reflect') return composeReflectPrompt(args);
  throw Object.assign(new Error(`未知动作：${action}`), { code: 'BAD_ACTION' });
}

/**
 * 动作 → 要发的斜杠命令（可能就是一段带换行的正文）。
 * - plan：`/plan\n<正文>`（parseCommand 只切命令名，rawInput 保留换行）
 * - exec：`['/plan off', '/goal <单行目标>']`
 * - reflect：没有命令，返回 undefined（当普通追问发）
 */
export function actionCommand({ action, prompt, objective, ...args }) {
  if (action === 'plan') {
    const text = clean(prompt) || composePlanPrompt(args);
    return [`/plan\n${text}`];
  }
  if (action === 'exec') {
    const oneLineObjective = oneLine(objective) || composeGoalObjective(args);
    return ['/plan off', `/goal ${oneLineObjective}`];
  }
  return undefined;
}

/** 命令没走通时退回的正文 */
export function actionFallbackPrompt({ action, prompt, ...args }) {
  if (action === 'plan') return clean(prompt) || composePlanPrompt(args);
  if (action === 'exec') return composeExecPrompt(args);
  return composeReflectPrompt(args);
}

/* ─────────── 拆分 / 候选 / 补全（后台生成） ─────────── */

function childTitles(node, limit = 6) {
  const items = (node.children || []).filter((x) => !isRecord(x)).slice(0, limit)
    .map((x) => `${CHILD_LABEL[x.kind] || '节点'}·${oneLine(x.title)}`);
  return childLine('- 已有', items);
}

/**
 * 拆重要支撑（里程碑节点）：依据里程碑愿景 + 核心指标，按第一性原理问
 * 「要让愿景成立，必须有哪些东西存在」，不在这里写解法与验收。
 */
export function composeSplitPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  if (node.kind !== 'milestone') {
    throw Object.assign(new Error('只有里程碑能拆重要支撑'), { code: 'NOT_MILESTONE' });
  }
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const vision = clean(node.vision);
  const supports = clean(node.supports);
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  background.push(`- 里程碑：${oneLine(node.title)}`);
  if (vision) {
    // 里程碑愿景可到 1000 字：拆支撑只需要「要变成什么样」，超长部分留在卡片里
    background.push(`- 里程碑愿景：${clipText(vision, 300)}`);
  }
  if (node.metrics) background.push(`- 核心指标：${listInline(node.metrics, 200)}`);
  if (supports) {
    background.push('- 已有重要支撑：');
    supportLines(node.supports, 220).forEach((x) => background.push(`  ${x}`));
  }
  background.push(...childTitles(node));
  return renderPrompt(
    `拆支撑项 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、最近提交与产物。',
          '2. 从第一性原理问：要让这个里程碑的愿景成立，必须有哪些东西存在。',
          '3. 给出 3 条候选重要支撑（可能只采纳 1 条），按重要性从高到低排序。',
          '4. 每条一句话说清「要什么」，不写怎么做。',
          '5. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 每条 ≤80 字，一句话：说清必须存在的那个东西，不是要做的事。',
          '- 按重要性排序：少了它，愿景的哪一步就立不住。',
          '- 不写解法、步骤、工期、验收、指标，那些是支撑项之后的活。',
          '- 不写功能清单凑数；证明不了必要的宁少勿多。',
          '- 3 条互不重复、不互相包含，不要重复已有重要支撑。',
        ],
      },
      {
        label: '输出',
        lines: [
          '严格只输出一个 JSON 对象，字段 supports 是字符串数组：',
          '{"supports":["…","…","…"]}',
          '字符串按重要性从高到低排列，只含这 3 条，不要输出其它文字。',
        ],
      },
    ],
  );
}

const FILL_LABEL = {
  title: '标题', vision: '里程碑愿景', supports: '重要支撑', metrics: '核心指标',
  support: '承接支撑项', necessity: '必要性', causal: '因果',
  metric: '核心指标', approach: '实现思路', verify: '验证', proof: '证据',
};

/** 列表字段（一条一行）走 JSON 数组契约；supports 先在本地扩展，等 core 的 LIST_FIELDS 跟上 */
const LIST_FIELDS_ALL = new Set([...LIST_FIELDS, 'supports']);

/**
 * 候选支撑项（生成候选池用）。
 *
 * 里程碑 → 支撑项：候选只能从「重要支撑」长出来。2026-10-30 用户反馈「生成的节点脱离
 * 里程碑、比较抽象」，根因是任务块奖励「覆盖广」，模型就产出与愿景无关的功能清单。
 * 现在每条候选认领一条不同的重要支撑，从第一性原理回答「要什么 → 它让愿景的哪一步
 * 成立」；没有重要支撑直接拒绝生成，避免又产出一批空节点。
 */
export function composeCandidatePrompt({ projectName, workspace, card, nodeId, count = 3 }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  if (node.kind !== 'milestone') {
    throw Object.assign(new Error('只有里程碑能生成支撑项候选'), { code: 'NOT_MILESTONE' });
  }
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  // 一条重要支撑一行：模型要能逐条认领，不能压成一段再自己切
  const supportItems = clean(node.supports).split('\n').map((x) => x.trim()).filter(Boolean);
  if (!supportItems.length) {
    throw Object.assign(
      new Error('里程碑还没有重要支撑：先在「重要支撑」里写清要让愿景成立必须存在什么（3–5 条），再生成支撑项候选'),
      { code: 'SUPPORTS_REQUIRED' },
    );
  }
  // 条数不能超过重要支撑条数：每条候选必须认领一条不同的支撑，多出来的只能是凑数
  const want = Math.min(Math.max(Number(count) || 3, 1), supportItems.length);
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  background.push(`- 里程碑：${oneLine(node.title)}`);
  if (node.vision) background.push(`- 里程碑愿景：${clipText(node.vision, 240)}`);
  if (node.metrics) background.push(`- 核心指标：${listInline(node.metrics, 200)}`);
  background.push('- 重要支撑（每条候选只认领其中一条）：');
  numberedItems(node.supports, 320).forEach((x) => background.push(`  ${x}`));
  background.push(...childTitles(node, 8));

  return renderPrompt(
    `候选生成 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '证据要求',
        lines: [
          '- 先读 README、脚本、配置、产物；不确定就查，不编。',
          '- evidence 指到文件 / 命令 / 产物，不写「已确认」「目前缺失」这类空话。',
        ],
      },
      {
        label: '任务',
        lines: [
          `给出 ${want} 条候选支撑项，按重要性从高到低，最终只采纳 1 条。`,
          '每条从第一性原理回答「要什么 → 它让愿景的哪一步成立」：',
          '- support 先照抄它认领的那条重要支撑原文（去掉编号）。',
          '- 必要性（necessity）：说清缺了它，里程碑愿景卡在哪一步。',
          '- 因果（causal）：写成「做了 A → 里程碑哪一步成立」，一句话读通。',
          '每条候选都要写清必要性与因果，缺一个这条就站不住。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字名词短语，说清「要什么存在」，不写口号、不写手段。',
          '- support 照抄重要支撑原文，≤80 字，不概括、不改写。',
          '- 必要性（necessity）≤80 字；因果（causal）≤80 字，要一句读通。',
          '- importance 是 1–5 的整数（5 = 少了它愿景就立不住），按它从高到低排。',
          '- evidence ≤200 字，指到文件 / 命令 / 产物。',
          '- 禁止用功能清单凑数：写「必须存在什么」，不写「做几个功能」。',
          '- 不写约束、验收、工期、实现步骤，那些是支撑项之后的活。',
          '- 每条挂不同的重要支撑项；证明不了必要的宁少勿多。',
        ],
      },
      {
        label: '输出',
        lines: [
          '严格只输出 JSON 数组，字段固定为：',
          'title / support / necessity / causal / importance / evidence',
          '[{"title":"…","support":"…","necessity":"…",',
          '  "causal":"…","importance":3,"evidence":"…"}]',
          `只含这 ${want} 条，按 importance 降序，不要输出其它文字。`,
        ],
      },
    ],
  );
}

/**
 * 服务信息收集：让模型读项目文件，给出「本地能启动、能用 URL 打开」的服务清单。
 * 面板拿到结果先预览（可改、可探活），确认后才写回 rotation.json。
 * start 要求 mac / windows 各写一条：同一份卡片会在两台机器间同步。
 */
export function composeCollectServicesPrompt({ projectName, workspace, platform = process.platform, existing = [] } = {}) {
  const pname = projectName || (workspace ? String(workspace).split(/[\\/]/).filter(Boolean).pop() : '项目');
  const label = platform === 'darwin' ? 'mac' : (platform === 'win32' ? 'windows' : String(platform || ''));
  const known = (Array.isArray(existing) ? existing : []).map((svc) => {
    if (!svc || typeof svc !== 'object') return '';
    const raw = svc.start;
    const command = typeof raw === 'string'
      ? raw
      : (raw && typeof raw === 'object' ? Object.values(raw).find((x) => typeof x === 'string') || '' : '');
    return `- ${svc.name || svc.id || '未命名'}：${svc.url || '无 url'}${command ? `（启动：${command}）` : ''}`;
  }).filter(Boolean);
  return renderPrompt(
    `收集服务 · 项目「${clip(oneLine(pname), 20)}」`,
    [
      {
        label: '背景',
        lines: [
          projectLine(pname, workspace),
          `- 当前机器：${label}（${platform}）；同一份 rotation.json 会在另一台机器上用`,
          ...(known.length ? ['- 已有 services：', ...known] : ['- 已有 services：无']),
        ],
      },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目文件：package.json 的 scripts、vite/next/webpack 配置、docker-compose、.env*、README 的启动段。',
          '2. 找出「本地能启动、能用 URL 打开」的服务：开发服务器、API、静态预览都算。',
          '3. 每个服务给出 id、name、url、health、start（mac 与 windows 各一条）、cwd（可选）、证据。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 最多 4 条；一次性脚本、测试、构建命令不算服务。',
          '- 端口必须来自配置文件或 README，不要凭空猜；猜的写 low 置信度并说明。',
          '- start 必须同时写 mac 与 windows；两边相同也各写一条，说不清用 default。',
          '- 命令在项目根目录执行；服务在子目录时才写相对路径 cwd。',
          '- id 用小写字母、数字、连字符；url 用 http://127.0.0.1:<端口>。',
          '- health 可选，填可探活的路径（以 / 开头）；没有就不写。',
        ],
      },
      {
        label: '输出',
        lines: [
          '严格只输出一个 JSON 对象：',
          '{"services":[{"id":"web","name":"本地预览 5273",',
          '  "url":"http://127.0.0.1:5273",',
          '  "start":{"mac":"pnpm dev","windows":"pnpm dev"},',
          '  "evidence":"vite.config.ts:12"}]}',
          'confidence 填 high 或 low；不要输出其它文字。',
        ],
      },
    ],
  );
}

/**
 * 按标题补全缺失字段。
 *
 * 三种口径：
 * - 里程碑：里程碑愿景（宏大叙事，≤1000 字）→ 重要支撑（第一性原理：要让愿景成立
 *   必须存在什么，按重要性排序，不写解法/工期/验收）→ 核心指标（愿景达成的证据）；
 * - 支撑项：核心指标（到什么程度算撑住里程碑，通俗讲清因果 ≤120 字）+ 实现思路
 *   （核心思路 ≤120 字，不写步骤清单）；承接支撑项 / 必要性 / 因果是只读依据；
 * - 执行：标题与验证（执行记录不参与补齐）。
 * 里程碑不写场景流程，支撑项不写愿景；场景 / 约束 / 验收已退役，不再注入。
 */
export function composeFillPrompt({ projectName, workspace, card, nodeId, fields = [] }) {
  const doc = card || {};
  const trail = pathTo(doc.milestone, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const node = trail[trail.length - 1];
  const milestone = doc.milestone || {};
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const wanted = fields.map((f) => FILL_LABEL[f] || f).join('、');
  const isMilestone = node.kind === 'milestone';
  const isSupport = node.kind === 'support';
  const wants = (...names) => names.some((n) => fields.includes(n));
  // 列表字段（重要支撑 / 核心指标）走 JSON 数组契约
  const listWanted = fields.filter((f) => LIST_FIELDS_ALL.has(f));
  const wantsList = listWanted.length > 0;
  const listLabels = listWanted.map((f) => FILL_LABEL[f] || f).join('、');

  const background = [projectLine(pname, ws)];
  // 项目愿景是里程碑愿景的上位约束：里程碑愿景要能挂到项目愿景上
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  if (isMilestone) {
    background.push(`- 里程碑：${oneLine(node.title)}`);
  } else {
    if (milestone.title) background.push(`- 里程碑：${oneLine(milestone.title)}`);
    if (milestone.vision) background.push(`  - 里程碑愿景：${clipText(milestone.vision, 160)}`);
    if (milestone.metrics) background.push(`  - 里程碑核心指标：${listInline(milestone.metrics, 160)}`);
    if (milestone.supports) {
      background.push('  - 里程碑重要支撑：');
      supportLines(milestone.supports, 160).forEach((x) => background.push(`    ${x}`));
    }
    if (isSupport) {
      background.push(`- 支撑项：${oneLine(node.title)}`);
      if (node.support) background.push(`  - 承接支撑项：${clipText(node.support, 80)}`);
      if (node.necessity) background.push(`  - 必要性：${clipText(node.necessity, 160)}`);
      if (node.causal) background.push(`  - 因果：${clipText(node.causal, 160)}`);
    } else {
      background.push(`- 执行项：${oneLine(node.title)}`);
    }
  }

  const siblings = (node.children || []).filter((x) => !isRecord(x)).slice(0, 10)
    .map((x) => `${CHILD_LABEL[x.kind] || '节点'}·${oneLine(x.title)}`);
  const nodeLines = [
    `- 正在补：${nodeLabel(node)}`,
    isMilestone && node.vision ? `- 已有里程碑愿景：${clipText(node.vision, 120)}` : '',
    isMilestone && node.metrics ? `- 已有核心指标：${listInline(node.metrics, 120)}` : '',
    isMilestone && node.supports ? `- 已有重要支撑：${listInline(node.supports, 160)}` : '',
    isSupport && node.metric ? `- 已有核心指标：${clipText(node.metric, 120)}` : '',
    isSupport && node.approach ? `- 已有实现思路：${clipText(node.approach, 120)}` : '',
    node.verify ? `- 已有验证：${oneLine(node.verify)}` : '',
    siblings.length ? `- 同级其它节点：${siblings.join('；')}` : '',
  ].filter(Boolean);

  return renderPrompt(
    `补全 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      { label: '当前节点', lines: nodeLines },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件（README、脚本、配置、最近提交与产物）再作答。',
          `2. 只补这几项：${wanted}。`,
          '3. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '证据要求',
        lines: wants('supports')
          ? [
            '- 每条重要支撑先在项目里核对：确实没有，才写「缺」。',
            '- 落到模块：缺的文件 / 入口 / 接口 / 命令，能给 path:line 就给。',
            '- 核对不了就写「未确认：缺什么证据」，不要猜。',
          ]
          : [],
      },
      {
        label: '约束',
        lines: [
          wants('vision')
            ? `- 里程碑愿景 ≤${fieldMaxOf('vision')} 字，其它字段 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`
            : `- 每个字段 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`,
          wants('vision') ? '- 里程碑愿景 3–6 句、一段话，不写编号。' : '',
          wants('supports') ? '- 重要支撑 3–5 条，每条 ≤60 字，整段 ≤300 字，按重要性排序。' : '',
          wants('metrics') ? '- 核心指标 2–5 条，每条 ≤60 字，整段 ≤300 字。' : '',
          wants('metric') ? '- 核心指标 ≤120 字：一句通俗的话，讲清「到什么程度算撑住这个里程碑」。' : '',
          wants('approach') ? '- 实现思路 ≤120 字：核心思路一句话，不写步骤清单。' : '',
          // 列表字段一律走 JSON 数组：模型不用再选分隔符，也就不会把 5 条挤成一段
          wantsList
            ? `- 列表字段（${listLabels}）用 JSON 数组，一条一个元素；元素内不要换行，行首不要加 ○ · • 这类符号，序号由面板补。`
            : '',
          wants('title') ? '- 标题：8–16 字名词短语，说清「做到什么」，不要口号、不要写手段。' : '',
          wants('verify') ? '- 验证：一条可直接执行的命令，或可观察的判定步骤（含期望输出）。' : '',
        ].filter(Boolean),
      },
      {
        label: '质量要求',
        lines: [
          wants('vision') ? '- 里程碑愿景写成宏大叙事：这个里程碑之后项目/用户变成什么样、谁会因此不同；不写功能清单、不写工期、不写实现手段。' : '',
          wants('vision') ? '- 里程碑愿景要挂到项目愿景上：它是项目愿景里的一步，不是另一个方向。' : '',
          wants('vision') ? '- 里程碑愿景写「变成什么样」而不是「做了什么功能」——功能清单和判定方式是核心指标的活。' : '',
          wants('supports') ? '- 重要支撑从第一性原理问：要让里程碑愿景成立，必须有哪些东西存在；是「要什么」，不是「做什么功能」。' : '',
          wants('supports') ? '- 按重要性从高到低排序，并写清缺了它愿景卡在哪一步；愿景里已写明的前提不重复写。' : '',
          wants('supports') ? '- 只写现在真的必须存在的；解法、工期、验收、指标都不算重要支撑。' : '',
          wants('supports') ? '- 证明不了必要的宁少勿多，别拿功能清单凑数。' : '',
          wants('metrics') ? '- 核心指标衡量「里程碑愿景是否达成」：从标题与愿景反推，用什么可观察的结果证明愿景已经实现。' : '',
          wants('metrics') ? '- 2–5 条，按对愿景的支撑强度排序；一条一个维度，互不重复。' : '',
          wants('metrics') ? '- 只写结果状态（数值 / 覆盖率 / 状态），不写测试命令、用例名、验收步骤。' : '',
          wants('metrics') ? '- 指标要能长期对比：同一张卡复看时看得出是变好还是变差。' : '',
          wants('metric') ? '- 支撑项的核心指标衡量「这条支撑撑没撑住里程碑」：通俗、讲清因果，别人一眼能判断到没到。' : '',
          wants('metric') ? '- 只写结果状态，不写测试命令、用例名、验收步骤。' : '',
          wants('approach') ? '- 实现思路讲核心思路：先做什么、为什么它能撑住指标；不写步骤清单、不写工期。' : '',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: [
          '严格只输出一个 JSON 对象，下面是字段形状，值换成你的结果：',
          '{',
          ...fields.map((f, i) => {
            const value = LIST_FIELDS_ALL.has(f) ? '["…", "…"]' : '"…"';
            return `  "${f}": ${value}${i < fields.length - 1 ? ',' : ''}`;
          }),
          '}',
          wantsList ? '列表字段必须是字符串数组（一条一个元素），不要输出成一段用符号分隔的文本。' : '',
          '只包含被要求的字段，不要输出其它文字。',
        ].filter(Boolean),
      },
    ],
  );
}

/* ─────────── 结构 lint ─────────── */

/**
 * 检查一段 prompt 是否符合结构规范（面板提示 + 测试断言共用）。
 * @param {string} text
 * @param {{maxLength?: number}} [opts]
 * @returns {{ok: boolean, warnings: Array<{line:number, code:string, message:string}>}}
 */
export function lintPrompt(text, opts = {}) {
  const warnings = [];
  const push = (line, code, message) => warnings.push({ line, code, message });
  const lines = String(text == null ? '' : text).split('\n');

  if (!lines.length || !lines[0].trim()) push(1, 'missing-title', '首行必须是「动作 · 对象」');
  else if (!lines[0].includes(' · ')) push(1, 'bad-title', '首行写成「动作 · 对象」（中间是空格 · 空格）');

  if (lines.length > 1 && lines[1].trim() !== '') push(2, 'missing-blank', '首行后要空一行');

  let blankRun = 0;
  lines.forEach((line, index) => {
    const n = index + 1;
    const trimmed = line.trim();
    if (!trimmed) {
      blankRun += 1;
      if (blankRun > 1) push(n, 'double-blank', '连续两个空行');
      return;
    }
    blankRun = 0;
    if (width(line) > 72) push(n, 'line-too-long', `这一行 ${width(line)} 列宽，超过 72 列，拆成两行`);
    if (/\*\*|__/.test(line)) push(n, 'markdown-bold', '气泡不渲染 markdown，** 会原样露出来');
    if (/\t/.test(line)) push(n, 'tab', '用空格缩进，不要用 tab');
    if (/[ \t]+$/.test(line)) push(n, 'trailing-space', '行尾多了空格');
  });

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!BLOCK_LABELS.has(trimmed)) return;
    const next = lines[index + 1];
    if (next == null || !next.trim()) push(index + 1, 'empty-block', `「${trimmed}」块下面没有内容`);
  });

  if (opts.maxLength && len(text) > opts.maxLength) {
    push(lines.length, 'too-long', `共 ${len(text)} 字，超过上限 ${opts.maxLength}`);
  }
  return { ok: warnings.length === 0, warnings };
}
