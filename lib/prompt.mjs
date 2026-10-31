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

/** 树只有三层：里程碑 → 能力闭环 → 执行（执行记录再用 action 区分计划/执行/反馈） */
const KIND_LABEL = { milestone: '里程碑', capability: '能力闭环', exec: '执行' };
const STATUS_LABEL = { plan: '规划中', ready: '就绪', doing: '进行中', blocked: '阻塞', done: '已完成' };
const CHILD_KIND = { milestone: 'capability' };
const CHILD_LABEL = { capability: '能力闭环', exec: '执行' };
/** module_mode（改造还是新增）在 prompt 与面板上的中文说法 */
export const MODULE_MODE_LABEL = { existing: '改造现有', new: '新增' };
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
 * 里程碑愿景 / 主要能力闭环在真实卡片里可能几百字；动作 prompt 有 1500 字上限，
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

/** 主要能力闭环原文自带「1)」编号：去掉，免得和注入的序号叠成「1) 1)缺…」 */
const stripItemNo = (item) => String(item).replace(/^\s*(?:\d+\s*[).、．]|[①-⑳]|[-*+])\s*/u, '');

/**
 * 主要能力闭环注入：卡片里是「一条一行」，注入时保持一条一行（缩进由调用方给）。
 * 有预算，超出部分的全文留在卡片里。
 */
function capabilityLines(capabilities, budget = 200) {
  const items = clean(capabilities).split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let used = 0;
  for (const item of items) {
    const cost = len(item);
    if (out.length && used + cost > budget) break;
    out.push(`- ${item}`);
    used += cost;
  }
  if (out.length < items.length) out.push('- …（其余主要能力闭环见卡片）');
  return out;
}

/** 候选要从主要能力闭环里逐条认领：编号是模型对齐条目的锚，不随条目写进卡片 */
function numberedItems(capabilities, budget = 320) {
  const items = clean(capabilities).split('\n').map((x) => x.trim()).filter(Boolean);
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
  milestone: ['用 Markdown。', '每条一行：一条主要能力闭环（按重要性排序）。', '不复述上下文，直接给结论。'],
  capability: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  exec: ['用 Markdown。', '按任务要求给结果，句短、一条一义。', '不复述上下文。'],
};

const T = (id, title, summary, ask, output) => ({ id, title, summary, ask, output });

/** 内置模板：node.prompts > card.prompts[类型] > 这里 */
export const PROMPT_TASKS = {
  milestone: [
    T('split', '拆出主要能力闭环', '里程碑 → 3–5 条主要能力闭环', [
      '拆出这个里程碑的主要能力闭环：要让里程碑愿景成立，必须有哪些东西存在。',
      '从第一性原理问：少了它，愿景的哪一步就立不住。',
      '按重要性从高到低排序，每条一句话说清「要什么」。',
    ], ['用 Markdown。', '每条一行：一条主要能力闭环，按重要性排序。', '不写解法、工期与验收。']),
    T('closed', '检查是否真的达成', '查能力闭环是否都服务于同一愿景', [
      '检查这个里程碑是否真的达成。',
      '每个能力闭环是否都服务于同一个里程碑愿景。',
      '有没有能力闭环其实不属于它；离愿景还差哪一环。',
    ], ['用 Markdown。', '先给结论：真达成 / 没达成。', '再列缺口，一条一行。']),
  ],
  capability: [
    T('plan', '梳理执行计划', '能力闭环 → 3–6 个动作', [
      '把这个能力闭环拆成执行计划：3–6 个可执行动作。',
      '每个动作给出验证方式与预期证据。',
      '标注依赖顺序；做完要让核心指标达标。',
    ], ['用 Markdown。', '按依赖顺序列 3–6 个动作，每个动作带验证方式与证据。']),
    T('risk', '预演失败点', '列 3 个失败点与早期信号', [
      '预演这个能力闭环落地会遇到什么。',
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
  'project', 'milestone', 'milestone.vision', 'milestone.capabilities',
  'capability', 'capability.text', 'capability.necessity', 'capability.causal',
  'capability.gap', 'capability.module', 'capability.collaboration',
  'capability.metric', 'capability.approach',
  'node', 'node.metric', 'node.approach',
  'exec.verify', 'exec.proof', 'exec.issues', 'children',
];

/** 路径上离当前节点最近的那条能力闭环；当前节点自己就是能力闭环时返回 null */
function capabilityOf(trail, node) {
  return trail.find((x) => x.kind === 'capability' && x !== node) || null;
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
  // 里程碑核心指标已退役（2026-10-31）：核心指标只挂在能力闭环上，
  // 里程碑的达成由「能力闭环全部闭环」表达。键名保留只为旧 prompt_context 不报未知字段。
  'milestone.metrics': {
    sec: 'ctx',
    r: () => [],
  },
  // 里程碑验收同样退役：旧卡里的 acceptance 不再注入，键名保留只为旧 prompt_context 兼容
  'milestone.acceptance': {
    sec: 'ctx',
    r: (ctx) => CTX_FIELDS['milestone.metrics'].r(ctx),
  },
  // 主要能力闭环：一条一行，逐条编号注入（与旧阻碍项同一套渲染）
  'milestone.capabilities': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].capabilities
      ? ['  - 主要能力闭环：', ...capabilityLines(trail[0].capabilities, 200).map((x) => `    ${x}`)]
      : []),
  },
  // 旧字段名兜底：读入已由 core.normalizeLegacyCard 改名，这里只为手写 prompt_context 不报未知字段
  'milestone.blockers': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.capabilities'].r(ctx) },
  loop: { sec: 'ctx', r: (ctx) => CTX_FIELDS.milestone.r(ctx) },
  'loop.intent': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.vision'].r(ctx) },
  'loop.acceptance': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.metrics'].r(ctx) },
  'loop.blockers': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.capabilities'].r(ctx) },
  capability: {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability ? [`- 能力闭环：${oneLine(capability.title)}`] : [];
    },
  },
  'capability.text': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.capability ? [`  - 承接能力闭环：${clipText(capability.capability, 80)}`] : [];
    },
  },
  'capability.necessity': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.necessity ? [`  - 必要性：${clipText(capability.necessity, 200)}`] : [];
    },
  },
  'capability.causal': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.causal ? [`  - 与闭环的关系：${clipText(capability.causal, 200)}`] : [];
    },
  },
  'capability.gap': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.gap ? [`  - 缺失影响：${clipText(capability.gap, 200)}`] : [];
    },
  },
  'capability.module': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      if (!capability) return [];
      const mode = MODULE_MODE_LABEL[capability.module_mode] || '';
      const mod = capability.module ? clipText(capability.module, 120) : '';
      if (!mod && !mode) return [];
      return [`  - 功能模块：${mode ? mode + ' · ' : ''}${mod || '（未标注模块）'}`];
    },
  },
  'capability.collaboration': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.collaboration ? [`  - 协同面：${clipText(capability.collaboration, 200)}`] : [];
    },
  },
  'capability.metric': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.metric ? [`  - 核心指标：${clipText(capability.metric, 200)}`] : [];
    },
  },
  'capability.approach': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const capability = capabilityOf(trail, node);
      return capability && capability.approach ? [`  - 实现思路：${clipText(capability.approach, 200)}`] : [];
    },
  },
  // 旧键别名：goal / idea 都是能力闭环的前身，旧 prompt_context 仍拿到同一份内容
  goal: { sec: 'ctx', r: (ctx) => CTX_FIELDS.capability.r(ctx) },
  'goal.acceptance': { sec: 'ctx', r: (ctx) => CTX_FIELDS['capability.metric'].r(ctx) },
  // 落地场景流程已退役：留在 JSON 里，但不显示、不校验、不进 prompt
  'goal.scenario': { sec: 'ctx', r: () => [] },
  idea: { sec: 'ctx', r: (ctx) => CTX_FIELDS.capability.r(ctx) },
  'idea.approach': { sec: 'ctx', r: (ctx) => CTX_FIELDS['capability.approach'].r(ctx) },
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
        } else if (x.kind === 'capability' && x.metric) {
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
      node.kind === 'capability' && node.metric
        ? [`- 核心指标：${oneLine(node.metric)}`]
        : []
    ),
  },
  'node.approach': {
    sec: 'node',
    r: ({ node }) => (node.kind === 'capability' && node.approach ? [`- 实现思路：${oneLine(node.approach)}`] : []),
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

/* ─────────── 能力闭环动作：计划 / 执行 / 反馈 ─────────── */

function capabilityContext({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const trail = pathTo(doc.milestone, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const capability = trail[trail.length - 1];
  if (capability.kind !== 'capability') throw Object.assign(new Error('只有能力闭环能发起动作'), { code: 'NOT_CAPABILITY' });
  const milestone = trail[0];
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  return { doc, trail, capability, milestone, pname, ws };
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
  const { doc, capability, milestone, pname, ws } = capabilityContext(args);
  const metric = clean(capability.metric);
  const approach = clean(capability.approach);
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  if (milestone) {
    background.push(`- 里程碑：${oneLine(milestone.title)}`);
    if (milestone.vision) background.push(`  - 里程碑愿景：${clipText(milestone.vision, 200)}`);
  }
  background.push(`- 能力闭环：${oneLine(capability.title)}`);
  if (capability.capability) background.push(`  - 承接能力闭环：${clipText(capability.capability, 80)}`);
  if (capability.necessity) background.push(`  - 必要性：${clipText(capability.necessity, 160)}`);
  if (capability.causal) background.push(`  - 与闭环的关系：${clipText(capability.causal, 160)}`);
  if (capability.gap) background.push(`  - 缺失影响：${clipText(capability.gap, 160)}`);
  if (capability.module || capability.module_mode) {
    const mode = MODULE_MODE_LABEL[capability.module_mode] || '未标注改造/新增';
    background.push(`  - 功能模块：${mode} · ${capability.module ? clipText(capability.module, 120) : '（未标注模块）'}`);
  }
  if (capability.collaboration) background.push(`  - 协同面：${clipText(capability.collaboration, 160)}`);
  if (metric) background.push(`  - 核心指标：${clipText(metric, 160)}`);
  if (approach) background.push(`  - 实现思路：${clipText(approach, 160)}`);
  const plan = capability.plan || {};
  const priorSteps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  if (plan.goal || priorSteps.length) {
    background.push(`- 已有计划：${oneLine(plan.goal || '（无目标行）')}（${priorSteps.length} 步）`);
  }
  const cfg = contextConf(doc, capability);
  if (cfg.refs.length) background.push(...CTX_FIELDS.refs.r({ root: doc.milestone, cfg }));
  // 要做什么：计划输入只吃这三样——承接能力闭环、核心指标、实现思路
  const claim = oneLine(capability.capability) || oneLine(capability.title);
  const metricText = metric ? clipText(metric, 120) : '（未填写，先按承接能力闭环兜底）';
  const approachText = approach ? clipText(approach, 120) : '（未填写，按承接能力闭环与核心指标自行收窄）';

  return renderPrompt(
    `${ACTION_TITLE.plan} · ${nodeLabel(capability)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          `1. 承接能力闭环：${claim}。`,
          `2. 核心指标：${metricText}。`,
          `3. 实现思路：${approachText}。`,
          capability.module
            ? `4. 落点：${MODULE_MODE_LABEL[capability.module_mode] || '未标注改造/新增'} · ${clipText(capability.module, 80)}；改动点必须落在这个模块内。`
            : '4. 落点未标注：先在计划里说清落在哪个模块，再给改动点。',
          capability.collaboration ? `5. 协同面：${clipText(capability.collaboration, 120)}；计划里要写清跨组件怎么对接。` : '',
          '6. 按上面几条产出可执行计划，改动点落到文件与动作，别停在方向。',
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
          `产出可执行计划，做完能让核心指标「${clipText(metric || capability.title, 30)}」达标。`,
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
  const { capability, milestone, pname, ws } = capabilityContext(args);
  const plan = capability.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];

  const background = [projectLine(pname, ws)];
  if (milestone) {
    background.push(`- 里程碑：${oneLine(milestone.title)}`);
  }
  background.push(`- 能力闭环：${oneLine(capability.title)}`);
  if (capability.capability) background.push(`  - 承接能力闭环：${clipText(capability.capability, 80)}`);
  if (capability.module || capability.module_mode) {
    const mode = MODULE_MODE_LABEL[capability.module_mode] || '未标注改造/新增';
    background.push(`  - 功能模块：${mode} · ${capability.module ? clipText(capability.module, 120) : '（未标注模块）'}`);
  }
  if (capability.collaboration) background.push(`  - 协同面：${clipText(capability.collaboration, 160)}`);
  if (capability.metric) background.push(`  - 核心指标：${clipText(capability.metric, 160)}`);
  if (capability.approach) background.push(`  - 实现思路：${clipText(capability.approach, 160)}`);
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  if (steps.length) background.push(`- 步骤：${steps.length} 条`);
  if (verify.length) background.push(`- 验证：${verify.length} 条`);

  return renderPrompt(
    `${ACTION_TITLE.exec} · ${nodeLabel(capability)}`,
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
  const { capability, ws } = capabilityContext(args);
  const plan = capability.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];
  const title = oneLine(capability.title);
  const metric = oneLine(capability.metric);
  const file = cardFilePath(ws);

  if (file) {
    return clip(
      `执行能力闭环「${title}」的计划：读 ${file} 中 id=${capability.id} 节点的 plan`
      + '（goal/steps/verify），按步骤执行，先跑验证命令；失败修到过；'
      + `核心指标「${metric || title}」达标才算完；发现计划有错先说明再调整。`
      + '收尾：写改动+命令结果。',
      240,
    );
  }

  const parts = [
    `执行能力闭环「${title}」的计划：${oneLine(plan.goal || metric || title).replace(/[。．.!！?？]+$/u, '')}。`,
  ];
  if (steps.length) parts.push(`步骤 ${steps.length} 条：${steps.slice(0, 4).map((s, i) => `${i + 1}) ${oneLine(s)}`).join('；')}。`);
  if (verify.length) parts.push(`验证：${verify.slice(0, 2).map(oneLine).join('；')}。`);
  parts.push('做完说明改了什么、验证结果。');
  return clip(parts.join(''), 240);
}

/** 反馈提炼：同一会话里的普通追问，只输出 JSON */
export function composeReflectPrompt(args) {
  const { capability, pname, ws } = capabilityContext(args);
  const plan = capability.plan || {};
  const background = [projectLine(pname, ws), `- 能力闭环：${oneLine(capability.title)}`];
  if (capability.metric) background.push(`- 核心指标：${clipText(capability.metric, 120)}`);
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  return renderPrompt(
    `${ACTION_TITLE.reflect} · ${nodeLabel(capability)}`,
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
 * 拆主要能力闭环（里程碑节点）：依据项目愿景 + 里程碑愿景 + 已有主要能力闭环，按第一性原理问
 * 「要让愿景成立，必须有哪些东西存在」，不在这里写解法与验收。
 */
export function composeSplitPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  if (node.kind !== 'milestone') {
    throw Object.assign(new Error('只有里程碑能拆主要能力闭环'), { code: 'NOT_MILESTONE' });
  }
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const vision = clean(node.vision);
  const capabilities = clean(node.capabilities);
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  background.push(`- 里程碑：${oneLine(node.title)}`);
  if (vision) {
    // 里程碑愿景可到 1000 字：拆支撑只需要「要变成什么样」，超长部分留在卡片里
    background.push(`- 里程碑愿景：${clipText(vision, 300)}`);
  }
  if (capabilities) {
    background.push('- 已有主要能力闭环：');
    capabilityLines(node.capabilities, 220).forEach((x) => background.push(`  ${x}`));
  }
  background.push(...childTitles(node));
  return renderPrompt(
    `拆能力闭环 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、最近提交与产物。',
          '2. 从第一性原理问：要让这个里程碑的愿景成立，必须形成哪几段能自己跑通、能单独验证的能力。',
          '3. 给出 3 条候选主要能力闭环（可能只采纳 1 条），按重要性从高到低排序。',
          '4. 每条写成「<能力闭环> → 它让愿景哪一步成立」，不写落在哪个模块。',
          '5. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 每条 ≤80 字：说清要形成哪段能力 + 它让愿景哪一步成立，不是要做的事。',
          '- 能力 ≠ 功能点；允许 UI 展示 / UX 动画 / 布局审美 / 内容管线这类非代码能力域。',
          '- 按重要性排序：少了它，愿景的哪一步就立不住。',
          '- 不写模块路径、解法、步骤、工期、验收、指标，那些是候选与能力闭环之后的活。',
          '- 不写功能清单凑数；证明不了必要的宁少勿多。',
          '- 3 条互不重复、不互相包含，不要重复已有主要能力闭环。',
        ],
      },
      {
        label: '输出',
        lines: [
          '严格只输出一个 JSON 对象，字段 capabilities 是字符串数组：',
          '{"capabilities":["…","…","…"]}',
          '字符串按重要性从高到低排列，只含这 3 条，不要输出其它文字。',
        ],
      },
    ],
  );
}

const FILL_LABEL = {
  title: '标题', vision: '里程碑愿景', capabilities: '主要能力闭环',
  capability: '承接能力闭环', necessity: '必要性', causal: '与闭环的关系',
  gap: '缺失影响', module: '功能模块', module_mode: '改造还是新增', collaboration: '协同面',
  metric: '核心指标', approach: '实现思路', verify: '验证', proof: '证据',
};

/** 列表字段（一条一行）走 JSON 数组契约；清单以 core 的 LIST_FIELDS 为唯一来源 */
const LIST_FIELDS_ALL = LIST_FIELDS;

/**
 * 候选能力闭环（生成候选池用）。
 *
 * 里程碑 → 能力闭环：候选只能从「主要能力闭环」长出来。2026-10-30 用户反馈「生成的节点脱离
 * 里程碑、比较抽象」，根因是任务块奖励「覆盖广」，模型就产出与愿景无关的功能清单。
 * 现在**一条能力闭环对应一条候选（1:1）**，条数完全由能力闭环条数决定：
 * 不默认 3 条、不设 6 条硬上限、不按能力条数二次夹取（2026-10-31 用户要求）。
 * 允许同一能力闭环出多条候选会把顺序与比较复杂化，明确禁止。
 * 没有主要能力闭环直接拒绝生成，避免又产出一批空节点。
 */
export function composeCandidatePrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  if (node.kind !== 'milestone') {
    throw Object.assign(new Error('只有里程碑能生成能力闭环候选'), { code: 'NOT_MILESTONE' });
  }
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  // 一条主要能力闭环一行：模型要能逐条认领，不能压成一段再自己切
  const capabilityItems = clean(node.capabilities).split('\n').map((x) => x.trim()).filter(Boolean);
  if (!capabilityItems.length) {
    throw Object.assign(
      new Error('里程碑还没有主要能力闭环：先在「主要能力闭环」里写清要让愿景成立必须形成哪几段能力（3–5 条），再生成能力闭环候选'),
      { code: 'CAPABILITIES_REQUIRED' },
    );
  }
  // 1:1：每条主要能力闭环各出一条候选，条数不再受任何数字限制（能力几条就几条）
  const want = capabilityItems.length;
  const background = [projectLine(pname, ws)];
  const projectVision = clean(doc.project && doc.project.vision);
  if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  background.push(`- 里程碑：${oneLine(node.title)}`);
  if (node.vision) background.push(`- 里程碑愿景：${clipText(node.vision, 240)}`);
  background.push('- 主要能力闭环（每条候选只认领其中一条）：');
  numberedItems(node.capabilities, 320).forEach((x) => background.push(`  ${x}`));
  background.push(...childTitles(node, 8));

  return renderPrompt(
    `候选生成 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '证据要求',
        lines: [
          '- 先读 README、目录、现有模块与产物，弄清这个仓库已经有哪些东西；不确定就查，不编。',
          '- 判断「改造现有」必须能在项目里指到模块名或路径；指不到就按「新增」写。',
          '- evidence 指到文件 / 命令 / 产物，不写「已确认」「目前缺失」这类空话。',
        ],
      },
      {
        label: '任务',
        lines: [
          `为每一条主要能力闭环各给 1 条候选，共 ${want} 条；按重要性从高到低排列。`,
          '严格 1:1：一条能力闭环只出一条候选，不要给同一条能力闭环出多条替代方案。',
          '每条候选认领一条不同的主要能力闭环，并回答这几件事：',
          '- 标题：形成哪段能力闭环（动词短语，8–16 字）。',
          '- 承接（capability）：照抄它认领的那条主要能力闭环原文，去掉编号。',
          '- 必要性（necessity）：为什么这个里程碑需要它——缺了它，愿景卡在哪一步。',
          '- 与闭环的关系（causal）：它让这个能力闭环的哪一步成立，一句话读通。',
          '- 缺失影响（gap）：缺了这块能力，闭环断在哪、谁受影响；写后果，不写愿望。',
          '- 功能模块（module）：落在哪。代码模块写模块名或路径；非代码能力写能力域',
          '  （UI 展示 / UX 动画 / 布局审美 / 内容管线 / 数据接入 都可以）。',
          '- 改造还是新增（module_mode）：existing = 在现有模块上改造；new = 现在没有、要新增。',
          '- 协同面（collaboration）：和哪些组件协同、通过什么接口 / 事件 / 数据。',
          '模块归属、缺失影响、协同面缺一个，这条候选就不成立。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字动词短语，说清「形成哪段能力」，不写口号、不写实现手段。',
          '- capability 照抄主要能力闭环原文，≤80 字，不概括、不改写。',
          '- 必要性（necessity）≤80 字；与闭环的关系（causal）≤80 字，一句读通。',
          '- 缺失影响（gap）≤80 字，只写后果：断在哪一步、谁受影响。',
          '- 功能模块（module）≤120 字；允许能力域，不必是代码模块。',
          '- 改造还是新增（module_mode）只能是 existing / new；existing 要给证据。',
          '- 协同面（collaboration）≤120 字；没有跨组件协同就写「无，独立闭环」。',
          '- importance 是 1–5 的整数（5 = 少了它愿景立不住），按它从高到低排。',
          '- evidence ≤200 字，指到文件 / 命令 / 产物。',
          '- 不写约束、验收、工期、实现步骤，那些是能力闭环之后的活。',
          '- 候选条数 = 主要能力闭环条数，不许多也不许少；同一条能力闭环只能出现一次。',
        ],
      },
      {
        label: '输出',
        lines: [
          '严格只输出 JSON 数组，字段固定为：',
          'title / capability / necessity / causal / gap / module / module_mode /',
          'collaboration / importance / evidence',
          '[{"title":"…","capability":"…","necessity":"…","causal":"…","gap":"…",',
          '  "module":"…","module_mode":"existing","collaboration":"…",',
          '  "importance":4,"evidence":"…"}]',
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
 * - 里程碑：里程碑愿景（宏大叙事，≤1000 字）+ 主要能力闭环（第一性原理：要让愿景成立
 *   必须存在什么，按重要性排序，不写解法/工期/验收）；里程碑不再有核心指标；
 * - 能力闭环：核心指标（到什么程度算撑住里程碑，通俗讲清因果 ≤120 字）+ 实现思路
 *   （核心思路 ≤120 字，不写步骤清单）；承接条目 / 必要性 / 与闭环的关系 / 缺失影响 /
 *   功能模块 / 改造还是新增 / 协同面都是只读依据；
 * - 执行：标题与验证（执行记录不参与补齐）。
 * 里程碑不写场景流程，能力闭环不写愿景；场景 / 约束 / 验收已退役，不再注入。
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
  const isSupport = node.kind === 'capability';
  const wants = (...names) => names.some((n) => fields.includes(n));
  // 列表字段（主要能力闭环 / 核心指标）走 JSON 数组契约
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
    if (milestone.capabilities) {
      background.push('  - 里程碑主要能力闭环：');
      capabilityLines(milestone.capabilities, 160).forEach((x) => background.push(`    ${x}`));
    }
    if (isSupport) {
      background.push(`- 能力闭环：${oneLine(node.title)}`);
      if (node.capability) background.push(`  - 承接能力闭环：${clipText(node.capability, 80)}`);
      if (node.necessity) background.push(`  - 必要性：${clipText(node.necessity, 160)}`);
      if (node.causal) background.push(`  - 与闭环的关系：${clipText(node.causal, 160)}`);
      if (node.gap) background.push(`  - 缺失影响：${clipText(node.gap, 160)}`);
      if (node.module || node.module_mode) {
        const mode = MODULE_MODE_LABEL[node.module_mode] || '未标注改造/新增';
        background.push(`  - 功能模块：${mode} · ${node.module ? clipText(node.module, 120) : '（未标注模块）'}`);
      }
      if (node.collaboration) background.push(`  - 协同面：${clipText(node.collaboration, 160)}`);
    } else {
      background.push(`- 执行项：${oneLine(node.title)}`);
    }
  }

  const siblings = (node.children || []).filter((x) => !isRecord(x)).slice(0, 10)
    .map((x) => `${CHILD_LABEL[x.kind] || '节点'}·${oneLine(x.title)}`);
  const nodeLines = [
    `- 正在补：${nodeLabel(node)}`,
    isMilestone && node.vision ? `- 已有里程碑愿景：${clipText(node.vision, 120)}` : '',
    isMilestone && node.capabilities ? `- 已有主要能力闭环：${listInline(node.capabilities, 160)}` : '',
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
        lines: wants('capabilities')
          ? [
            '- 每条主要能力闭环先在项目里核对：这条支撑现在确实不存在、或还不足。',
            '- 落到模块或状态：缺的文件 / 入口 / 接口 / 命令，能给 path:line 就给。',
            '- 核对不了就写「未确认：缺什么证据」，不要猜；不要写成缺陷清单。',
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
          wants('capabilities') ? '- 主要能力闭环 3–5 条，每条 ≤60 字，整段 ≤300 字，按重要性排序。' : '',
          wants('capabilities') ? '- 一条一个能力闭环，格式：<能力闭环> → 它让愿景哪一步成立。' : '',
          wants('necessity') ? '- 必要性 ≤120 字：为什么这个里程碑需要它。' : '',
          wants('causal') ? '- 与闭环的关系 ≤120 字：它让这个能力闭环的哪一步成立。' : '',
          wants('gap') ? '- 缺失影响 ≤120 字：缺了这块能力，闭环断在哪一步、谁受影响。' : '',
          wants('module') ? '- 功能模块 ≤120 字：代码模块写模块名或路径；非代码能力写能力域（UI 展示 / UX 动画 / 布局审美 / 内容管线）。' : '',
          wants('module_mode') ? '- 改造还是新增只能是 existing（改造现有）或 new（新增）；existing 必须指到项目里的模块，指不到就写 new。' : '',
          wants('collaboration') ? '- 协同面 ≤120 字：和哪些组件协同、通过什么接口 / 事件 / 数据；没有就写「无，独立闭环」。' : '',
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
          wants('vision') ? '- 里程碑愿景写「变成什么样」而不是「做了什么功能」——「做到什么程度算撑住」是能力闭环核心指标的活。' : '',
          wants('capabilities') ? '- 主要能力闭环从第一性原理回答：要让里程碑愿景成立，必须形成哪几段「能自己跑通、能单独验证」的能力。' : '',
          wants('capabilities') ? '- 是能力，不是功能点、不是待办任务；一段能力通常跨多个功能、能独立交付。' : '',
          wants('capabilities') ? '- 允许非代码能力域：UI 展示、UX 动画、布局与审美、内容管线、数据接入都算。' : '',
          wants('capabilities') ? '- 按重要性从高到低排序，并写清缺了它愿景卡在哪一步；愿景里已写明的前提不重复写。' : '',
          wants('capabilities') ? '- 不写模块路径与实现手段——落在哪个模块是候选阶段的事。' : '',
          wants('capabilities') ? '- 证明不了必要的宁少勿多，别拿功能清单凑数。' : '',
          wants('gap') ? '- 缺失影响只写后果：断在闭环的哪一步、谁受影响；不写「很重要」「影响体验」这类空话。' : '',
          wants('module') ? '- 功能模块是落点，不是动作：写「情节渲染层 / UX 动画层」这类归属，不要写「优化一下界面」。' : '',
          wants('module_mode') ? '- 改造还是新增按证据判断：项目里已经有的模块写 existing，确实没有才写 new。' : '',
          wants('metric') ? '- 能力闭环的核心指标衡量「这条能力撑没撑住里程碑」：通俗、讲清因果，别人一眼能判断到没到。' : '',
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
