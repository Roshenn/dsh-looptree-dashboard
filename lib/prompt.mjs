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

const KIND_LABEL = { milestone: '里程碑', goal: '目标', idea: '构思', exec: '执行' };
const STATUS_LABEL = { plan: '规划中', ready: '就绪', doing: '进行中', blocked: '阻塞', done: '已完成' };
const CHILD_KIND = { milestone: 'goal', goal: 'idea', idea: 'exec' };
const CHILD_LABEL = { goal: '目标', idea: '构思', exec: '执行' };
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
 * 场景流程 / 里程碑阻碍项在真实卡片里可能几百字；动作 prompt 有 1500 字上限，
 * 照抄就超。全文本来就在 rotation.json 里，执行者需要时能自己读。
 */
const CLIP_NOTE = '…（全文见卡片）';
function clipText(text, n) {
  const s = oneLine(text);
  return len(s) > n ? `${[...s].slice(0, n).join('')}${CLIP_NOTE}` : s;
}

/** 多行场景按字符预算取前几步；超了标「其余步骤见卡片」 */
function scenarioLines(scenario, budget = 200) {
  const lines = clean(scenario).split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let used = 0;
  for (const line of lines) {
    const cost = len(line);
    if (out.length && used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  if (out.length < lines.length) out.push('…（其余步骤见卡片）');
  return out;
}

/**
 * 阻碍项注入：卡片里是「一条一行」的编号文本，注入时保持一条一行（缩进由调用方给）。
 * 与 scenarioLines 同样有预算，超出部分的全文留在卡片里。
 */
function blockerLines(blockers, budget = 200) {
  const items = clean(blockers).split('\n').map((x) => x.trim()).filter(Boolean);
  const out = [];
  let used = 0;
  for (const item of items) {
    const cost = len(item);
    if (out.length && used + cost > budget) break;
    out.push(`- ${item}`);
    used += cost;
  }
  if (out.length < items.length) out.push('- …（其余阻碍见卡片）');
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
  milestone: ['用 Markdown。', '每条一行：标题（8–16 字）+ 验收（可判定）。', '不复述上下文，直接给结论。'],
  goal: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  idea: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  exec: ['用 Markdown。', '按任务要求给结果，句短、一条一义。', '不复述上下文。'],
};

const T = (id, title, summary, ask, output) => ({ id, title, summary, ask, output });

/** 内置模板：node.prompts > card.prompts[类型] > 这里 */
export const PROMPT_TASKS = {
  milestone: [
    T('split', '拆成目标', '里程碑 → 3–5 个可验证目标', [
      '把这个里程碑拆成 3–5 个目标。',
      '每个目标都要能单独验证，并给出验收方式。',
      '验收优先写成可直接执行的命令。',
    ], ['用 Markdown。', '每条目标一行：标题（8–16 字）+ 验收（可判定）。', '不复述上下文。']),
    T('closed', '检查是否真的达成', '查目标是否都服务于同一愿景', [
      '检查这个里程碑是否真的达成。',
      '每个目标是否都服务于同一个里程碑愿景。',
      '有没有目标其实不属于它；离愿景还差哪一环。',
    ], ['用 Markdown。', '先给结论：真达成 / 没达成。', '再列缺口，一条一行。']),
  ],
  goal: [
    T('ideas', '拆出构思', '目标 → 1 条实现路径', [
      '针对这个目标给出 1 条最合适的实现路径（一个目标只落地一个构思）。',
      '先用一句写清它为什么优于其它可能路线（省时 / 好验证 / 复用现有资产 / 风险低）。',
      '再给方向标题；不要铺开做法细节与验收建议。',
    ], ['用 Markdown。', '只给 1 条：优势一句 + 方向标题。', '不写做法细节与验收建议。']),
    T('verify', '验收可判定性', '查验收能不能判定', [
      '检查这个目标的验收方式是否可判定。',
      '不可判定就改写为可执行的检查步骤或命令。',
    ], ['用 Markdown。', '先给结论：可判定 / 不可判定。', '不可判定就给改写后的验收（可直接执行）。']),
  ],
  idea: [
    T('regen', '重新生成构思', '保留目标，换一条路径', [
      '保留目标与约束，重新给出 1 条替代构思。',
      '只给方向标题。',
      '说明它相对原构思的优势与代价（一个目标只保留一个构思）。',
    ], ['用 Markdown。', '只给 1 条：方向标题 + 优势 + 代价。']),
    T('plan', '梳理执行计划', '构思 → 3–6 个动作', [
      '把这个构思拆成执行计划：3–6 个可执行动作。',
      '每个动作给出验证方式与预期证据。',
      '标注依赖顺序。',
    ], ['用 Markdown。', '按依赖顺序列 3–6 个动作，每个动作带验证方式与证据。']),
    T('risk', '预演失败点', '列 3 个失败点与早期信号', [
      '预演这个构思落地会遇到什么。',
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
  'project', 'milestone', 'milestone.vision', 'milestone.metrics', 'milestone.blockers',
  'goal', 'goal.acceptance', 'goal.scenario',
  'idea', 'node', 'node.acceptance',
  'exec.verify', 'exec.proof', 'exec.issues', 'children',
];

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
  'milestone.blockers': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].blockers
      ? ['  - 阻碍：', ...blockerLines(trail[0].blockers, 160).map((x) => `    ${x}`)]
      : []),
  },
  // 旧字段名兜底：读入已由 core.normalizeLegacyCard 改名，这里只为手写 prompt_context 不报未知字段
  loop: { sec: 'ctx', r: (ctx) => CTX_FIELDS.milestone.r(ctx) },
  'loop.intent': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.vision'].r(ctx) },
  'loop.acceptance': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.metrics'].r(ctx) },
  'loop.blockers': { sec: 'ctx', r: (ctx) => CTX_FIELDS['milestone.blockers'].r(ctx) },
  goal: {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const goal = trail.find((x) => x.kind === 'goal');
      return goal && goal !== node ? [`- 目标：${oneLine(goal.title)}`] : [];
    },
  },
  'goal.acceptance': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const goal = trail.find((x) => x.kind === 'goal');
      return goal && goal !== node && goal.acceptance ? [`  - 验收：${oneLine(goal.acceptance)}`] : [];
    },
  },
  'goal.scenario': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const goal = trail.find((x) => x.kind === 'goal');
      return goal && goal !== node && goal.scenario
        ? ['  - 落地场景流程：', ...scenarioLines(goal.scenario, 160).map((x) => `    ${x}`)]
        : [];
    },
  },
  idea: {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const idea = trail.find((x) => x.kind === 'idea');
      return idea && idea !== node ? [`- 构思：${oneLine(idea.title)}`] : [];
    },
  },
  'idea.approach': {
    sec: 'ctx',
    r: ({ trail, node }) => {
      const idea = trail.find((x) => x.kind === 'idea');
      return idea && idea !== node && idea.approach ? [`  - 方向：${oneLine(idea.approach)}`] : [];
    },
  },
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
        } else if (x.acceptance) {
          lines.push(`  - 验收：${oneLine(x.acceptance)}`);
        }
      });
      return lines;
    },
  },
  node: {
    sec: 'node',
    r: ({ node }) => [`- id：${node.id}`, `- 状态：${statusLabel(node)}`],
  },
  'node.acceptance': {
    sec: 'node',
    r: ({ node }) => (
      node.kind === 'goal' && node.acceptance
        ? [`- 验收：${oneLine(node.acceptance)}`]
        : []
    ),
  },
  'node.approach': {
    sec: 'node',
    r: ({ node }) => (node.kind === 'idea' && node.approach ? [`- 方向：${oneLine(node.approach)}`] : []),
  },
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

/* ─────────── 构思动作：计划 / 执行 / 反馈 ─────────── */

function ideaContext({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const trail = pathTo(doc.milestone, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const idea = trail[trail.length - 1];
  if (idea.kind !== 'idea') throw Object.assign(new Error('只有构思节点能发起动作'), { code: 'NOT_IDEA' });
  const milestone = trail[0];
  const goal = trail.find((x) => x.kind === 'goal') || null;
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  return { doc, trail, idea, milestone, goal, pname, ws };
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

function acceptanceLines(text) {
  const items = splitItems(text);
  if (!items.length) return [];
  return items.map((x) => `- ${x}`);
}

/** 生成计划：走 /plan，正文整体作为命令参数（保留换行） */
export function composePlanPrompt(args) {
  const { doc, idea, milestone, goal, pname, ws } = ideaContext(args);
  const goalTitle = oneLine((goal && goal.title) || idea.title);
  const background = [projectLine(pname, ws)];
  if (milestone) {
    background.push(`- 里程碑：${oneLine(milestone.title)}`);
    if (milestone.vision) background.push(`  - 里程碑愿景：${clipText(milestone.vision, 200)}`);
    if (milestone.blockers) {
      background.push('  - 阻碍：');
      blockerLines(milestone.blockers, 160).forEach((x) => background.push(`    ${x}`));
    }
  }
  if (goal) {
    background.push(`- 目标：${oneLine(goal.title)}`);
    if (goal.acceptance) background.push(`  - 验收：${clipText(goal.acceptance, 140)}`);
    if (goal.blocker) background.push(`  - 对应阻碍：${oneLine(goal.blocker)}`);
    if (goal.scenario) {
      background.push('  - 落地场景流程：');
      scenarioLines(goal.scenario, 120).forEach((x) => background.push(`    ${x}`));
    }
  }
  background.push(`- 构思：${oneLine(idea.title)}`);
  if (idea.approach) background.push(`  - 方向：${oneLine(idea.approach)}`);
  const plan = idea.plan || {};
  const priorSteps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  if (plan.goal || priorSteps.length) {
    background.push(`- 已有计划：${oneLine(plan.goal || '（无目标行）')}（${priorSteps.length} 步）`);
  }
  const cfg = contextConf(doc, idea);
  if (cfg.refs.length) background.push(...CTX_FIELDS.refs.r({ root: doc.milestone, cfg }));
  // 验收只补「构思自己那条」：与背景里的目标验收相同时不再重复出块
  const acceptance = idea.acceptance && idea.acceptance !== (goal && goal.acceptance) ? idea.acceptance : '';

  return renderPrompt(
    `${ACTION_TITLE.plan} · ${nodeLabel(idea)}`,
    [
      { label: '背景', lines: background },
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
          `产出可执行计划，做完能稳定达到「${clip(goalTitle, 20)}」。`,
          '成功标准：',
          '- 每个改动点有文件路径与具体动作。',
          '- 每一步有可执行验证命令与预期结果。',
          '- 覆盖边界与失败模式；写明非目标。',
          '- 每个验收项都能追溯到某一步。',
        ],
      },
      {
        label: '非目标',
        lines: [
          '- 不重构无关代码；不升级依赖。',
          '- 不改公开契约：API、JSON 字段、命令格式。',
        ],
      },
      { label: '验收', lines: acceptanceLines(acceptance) },
      {
        label: '输出',
        lines: [
          '用 Markdown，三节顺序固定：',
          '## 目标',
          '一句话：做完之后能稳定做到什么。',
          '## 验证命令',
          '可直接执行的 bash 命令，一行一条；每条写清预期结果。',
          '## 步骤',
          '1. 改哪些文件 / 做什么 / 验证命令 / 预期结果 / 对应验收项。',
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
  const { doc, idea, goal, pname, ws } = ideaContext(args);
  const plan = idea.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];

  const background = [projectLine(pname, ws)];
  if (goal) background.push(`- 目标：${oneLine(goal.title)}`);
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  if (steps.length) background.push(`- 步骤：${steps.length} 条`);
  if (verify.length) background.push(`- 验证：${verify.length} 条`);

  return renderPrompt(
    `${ACTION_TITLE.exec} · ${nodeLabel(idea)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 按下面的计划执行，直到目标达成，不要停在「打算做」。',
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
  const { idea, ws } = ideaContext(args);
  const plan = idea.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];
  const title = oneLine(idea.title);
  const file = cardFilePath(ws);

  if (file) {
    return clip(
      `执行构思「${title}」的计划：读 ${file} 中 id=${idea.id} 节点的 plan`
      + '（goal/steps/verify），按步骤执行，先跑验证命令；失败修到过；'
      + '发现计划有错先说明再调整。收尾：写改动+命令结果。',
      240,
    );
  }

  const parts = [
    `执行构思「${title}」的计划：${oneLine(plan.goal || idea.title).replace(/[。．.!！?？]+$/u, '')}。`,
  ];
  if (steps.length) parts.push(`步骤 ${steps.length} 条：${steps.slice(0, 4).map((s, i) => `${i + 1}) ${oneLine(s)}`).join('；')}。`);
  if (verify.length) parts.push(`验证：${verify.slice(0, 2).map(oneLine).join('；')}。`);
  parts.push('做完说明改了什么、验证结果。');
  return clip(parts.join(''), 240);
}

/** 反馈提炼：同一会话里的普通追问，只输出 JSON */
export function composeReflectPrompt(args) {
  const { idea, pname, ws } = ideaContext(args);
  const plan = idea.plan || {};
  const background = [projectLine(pname, ws), `- 构思：${oneLine(idea.title)}`];
  if (plan.goal) background.push(`- 计划目标：${oneLine(plan.goal)}`);
  return renderPrompt(
    `${ACTION_TITLE.reflect} · ${nodeLabel(idea)}`,
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

/** 拆目标（里程碑节点）：依据里程碑愿景 + 核心指标 + 阻碍项，不在这里产出场景流程（场景由目标「生成」） */
export function composeSplitPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const vision = clean(node.vision);
  const blockers = clean(node.blockers);
  const background = [projectLine(pname, ws)];
  background.push(`- 里程碑：${oneLine(node.title)}`);
  if (vision) {
    // 里程碑愿景可到 1000 字：拆目标只需要「要变成什么样」，超长部分留在卡片里
    background.push(`- 里程碑愿景：${clipText(vision, 300)}`);
  }
  if (node.metrics) background.push(`- 核心指标：${clipText(node.metrics, 200)}`);
  if (blockers) {
    background.push('- 已知阻碍项：');
    blockerLines(node.blockers, 220).forEach((x) => background.push(`  ${x}`));
  }
  background.push(...childTitles(node));
  return renderPrompt(
    `拆目标 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、最近提交与产物。',
          '2. 对照里程碑愿景与阻碍项，给出 3 条候选目标（可能只采纳 1 条）。',
          blockers
            ? '3. 每条目标对应一条阻碍项：说清这条目标消除或推进哪条阻碍。'
            : '3. 阻碍项为空时，按「离愿景还差什么」拆目标，别按功能清单拆。',
          '4. 目标的验收要能判定：先想好怎么验，再写目标。',
          '5. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字名词短语，说清「做到什么」，不写口号、不写手段。',
          '- 验收写清怎么判定通过（命令 / 文件 / 断言 / 可见结果），能落命令就落命令，单条 ≤ 300 字。',
          '- 3 条互相独立，不要互相包含，不要重复已有目标。',
          blockers ? '- 3 条目标各自对应不同阻碍；对应不上就按愿景缺口拆。' : '',
          blockers ? '- blocker 照抄阻碍项原文的短名（≤80 字），不要改写；对应不上就填空串。' : '',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: [
          blockers
            ? '严格只输出一个 JSON 对象：{"goals":[{"title":"…","acceptance":"…","blocker":"…"}]}'
            : '严格只输出一个 JSON 对象：{"goals":[{"title":"…","acceptance":"…"}]}',
          '只含这 3 条，不要输出其它文字。',
        ],
      },
    ],
  );
}

/** 拆构思（目标节点） */
export function composeIdeaPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const trail = pathTo(doc.milestone, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const node = trail[trail.length - 1];
  const milestone = trail[0];
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const background = [projectLine(pname, ws)];
  if (milestone && milestone !== node && milestone.vision) background.push(`- 所属里程碑愿景：${clipText(milestone.vision, 160)}`);
  background.push(`- 目标：${oneLine(node.title)}`);
  if (node.acceptance) background.push(`- 目标验收：${oneLine(node.acceptance)}`);
  if (node.blocker) background.push(`- 对应阻碍：${oneLine(node.blocker)}`);
  if (node.constraints) background.push(`- 目标约束：${oneLine(node.constraints)}`);
  background.push(...childTitles(node));
  const scenario = clean(node.scenario);
  return renderPrompt(
    `拆构思 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '场景',
        lines: scenario
          ? ['目标已定的落地场景流程（约束与验收的唯一依据）：', ...scenario.split('\n')]
          : [],
      },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、最近提交与产物。',
          '2. 给出 3 条候选构思：同一目标的互斥路线，最终只写入 1 条。',
          '3. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 6–14 字名词短语，说清「走哪条路」，不写口号、不写成任务清单。',
          '- 每条先写一句优势（strength）：省时 / 好验证 / 复用现有资产 / 风险更低，要能横向比较。',
          '- 只给方向，不写实现细节（做法、步骤、风险、验收留给后面的计划）。',
          scenario ? '- 每条构思都要能落进目标场景流程的步骤里，别铺超出场景的手段。' : '',
          '- 3 条必须是不同的实现路线，不要重复已有构思。',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: ['严格只输出一个 JSON 对象：{"ideas":[{"title":"…","strength":"…"}]}', '只含这 3 条，不要输出其它文字。'],
      },
    ],
  );
}

const FILL_LABEL = {
  title: '标题', vision: '里程碑愿景', scenario: '落地场景流程', blockers: '阻碍项',
  metrics: '核心指标', acceptance: '验收', constraints: '约束', verify: '验证', proof: '证据',
};

/**
 * 候选子节点（生成候选池用）。
 *
 * 候选的质量不是「每条多好」，而是「几条合起来覆盖不覆盖决策空间」：
 * 所以任务块要求每条落在不同差异轴，构思候选的 strength 必须显式对比另两条。
 * pilot 实测：只写「优势要能横向比较」还不够，模型会产出「最小 / 最易」这类
 * 没有对比对象的自夸，必须点出反例。
 */
export function composeCandidatePrompt({ projectName, workspace, card, nodeId, count = 3 }) {
  const doc = card || {};
  const node = findNode(doc.milestone, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const childKind = CHILD_KIND[node.kind];
  const childLabel = CHILD_LABEL[childKind] || '子节点';
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const milestone = doc.milestone || {};
  const trail = pathTo(doc.milestone, nodeId) || [node];
  const scenarioGoal = node.kind === 'goal' ? node : (trail.find((x) => x.kind === 'goal') || null);
  const background = [projectLine(pname, ws), `- 当前节点：${nodeLabel(node)}`];
  if (node.kind === 'milestone' && node.vision) background.push(`- 里程碑愿景：${clipText(node.vision, 160)}`);
  if (node.kind === 'milestone' && node.metrics) background.push(`- 核心指标：${clipText(node.metrics, 200)}`);
  if (node.kind !== 'milestone' && node.acceptance) background.push(`- 验收：${clipText(node.acceptance, 200)}`);
  const limits = node.kind === 'milestone' ? clean(node.blockers) : clean(node.constraints);
  if (limits) background.push(`${node.kind === 'milestone' ? '- 阻碍' : '- 约束'}：${clipText(limits, 120)}`);
  const milestoneBlockers = node.kind === 'milestone' ? '' : clean(milestone.blockers);
  if (milestoneBlockers) background.push(`- 里程碑阻碍：${clipText(milestoneBlockers, 120)}`);
  background.push(...childTitles(node, 8));
  const scenario = clean(node.kind === 'milestone' ? '' : (scenarioGoal && scenarioGoal.scenario));
  const forIdea = childKind === 'idea';
  return renderPrompt(
    `候选生成 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '场景',
        lines: scenario
          ? ['已定的落地场景流程（候选不能越出这些步骤）：', ...scenarioLines(scenario, 160)]
          : [],
      },
      {
        label: '证据要求',
        lines: ['先读 README、脚本、配置、产物；不确定就查，不编。'],
      },
      {
        label: '任务',
        lines: [
          `给出 ${count} 条互不重复的候选${childLabel}，每条都能独立验证。`,
          '成功标准：',
          '- 每条落在不同的差异轴：机制 / 数据流 / 复用资产 / 验证方式 / 范围边界。',
          '- 标题能一眼看出走的是哪条路；不要两条只差措辞。',
          '- 无重复、无包含，可独立采纳。',
          '- 每条验收是命令 / 断言 / 可观察结果。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字，说清「做到什么」（构思写「走哪条路」）。',
          '- 每条给一句验收（可判定的检查、命令或判据）。',
          forIdea
            ? '- strength 显式对比另两条候选，写清强在哪（少几次写 / 少几个状态 / 少一轮返工），不要用「最小 / 最强」这类没有对比对象的词。'
            : '',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: [
          forIdea ? '严格只输出 JSON 数组：[{"title":"…","strength":"…","acceptance":"…"}]' : '严格只输出 JSON 数组：[{"title":"…","acceptance":"…"}]',
          `只含这 ${count} 条，不要输出其它文字。`,
        ],
      },
      {
        label: '示例',
        lines: [forIdea
          ? '[{"title":"…","strength":"比另两条少一轮回填","acceptance":"…"}]'
          : '[{"title":"素材入库可追溯","acceptance":"GET /api/lessons 有该素材"}]'],
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
 * 两种口径：
 * - 里程碑：里程碑愿景（宏大叙事，≤1000 字）→ 阻碍项（对照愿景与项目现状）→ 核心指标
 *   （从愿景反推的 2–5 条「愿景达成的证据」，不是验收参数）；项目愿景作为上位约束注入背景；
 * - 目标：落地场景流程（操作/预期/体验 3–5 步）→ 约束 → 验收。
 * 里程碑不写场景流程（已下沉到目标），目标不写愿景；里程碑不再有验收字段（旧卡 acceptance 只作遗留）。
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
  const wantsVision = fields.includes('vision');
  const wantsMetrics = fields.includes('metrics');
  const wantsAcceptance = fields.includes('acceptance');
  const wantsConstraints = fields.includes('constraints');
  const wantsBlockers = fields.includes('blockers');
  const wantsScenario = fields.includes('scenario');

  const background = [projectLine(pname, ws)];
  if (isMilestone) {
    background.push(`- 里程碑：${oneLine(node.title)}`);
    // 项目愿景是里程碑愿景的上位约束：里程碑愿景要能挂到项目愿景上
    const projectVision = clean(doc.project && doc.project.vision);
    if (projectVision) background.push(`- 项目愿景：${clipText(projectVision, 160)}`);
  } else {
    if (milestone.vision) background.push(`- 所属里程碑愿景：${clipText(milestone.vision, 160)}`);
    if (milestone.blockers) background.push(`- 里程碑阻碍：${clipText(milestone.blockers, 120)}`);
    background.push(`- 目标：${oneLine(node.title)}`);
    if (node.blocker) background.push(`- 对应阻碍：${oneLine(node.blocker)}`);
  }
  const scenario = isMilestone ? '' : clean(node.scenario);

  const siblings = (node.children || []).filter((x) => !isRecord(x)).slice(0, 10)
    .map((x) => `${CHILD_LABEL[x.kind] || '节点'}·${oneLine(x.title)}`);
  const nodeLines = [
    `- 正在补：${nodeLabel(node)}`,
    isMilestone
      ? (node.vision ? `- 已有里程碑愿景：${clipText(node.vision, 120)}` : '')
      : (node.constraints ? `- 已有约束：${oneLine(node.constraints)}` : ''),
    isMilestone
      ? (node.blockers ? `- 已有阻碍项：${oneLine(node.blockers)}` : '')
      : (node.scenario ? `- 已有场景流程：${clipText(node.scenario, 120)}` : ''),
    node.metrics ? `- 已有核心指标：${clipText(node.metrics, 120)}` : '',
    !isMilestone && node.acceptance ? `- 已有验收：${oneLine(node.acceptance)}` : '',
    node.verify ? `- 已有验证：${oneLine(node.verify)}` : '',
    siblings.length ? `- 同级其它节点：${siblings.join('；')}` : '',
  ].filter(Boolean);

  return renderPrompt(
    `补全 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '场景',
        lines: scenario
          ? ['（目标验收的唯一依据，必须逐条对上）', ...scenario.split('\n')]
          : (wantsScenario
            ? ['（还没有落地场景流程：按这个目标 + 对应阻碍写 3–5 步，别写整个项目走一遍）']
            : []),
      },
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
        lines: wantsBlockers
          ? [
            '- 每条阻碍先在项目里核对：确实没有，才写「缺」。',
            '- 落到模块：缺的文件 / 入口 / 接口 / 命令，能给 path:line 就给。',
            '- 核对不了就写「未确认：缺什么证据」，不要猜。',
          ]
          : [],
      },
      {
        label: '约束',
        lines: [
          wantsVision
            ? `- 里程碑愿景 ≤${fieldMaxOf('vision')} 字，其它字段 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`
            : `- 每个字段 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`,
          wantsVision ? '- 里程碑愿景 3–6 句、一段话，不写编号。' : '',
          wantsScenario ? '- 落地场景流程 3–5 步。' : '',
          wantsConstraints ? '- 约束 3–5 条。' : '',
          wantsAcceptance ? '- 验收 3–5 条（含总验收）。' : '',
          wantsMetrics ? '- 核心指标 2–5 条，一条一行，每条 ≤60 字，整段 ≤300 字。' : '',
          wantsBlockers ? '- 阻碍项 3–5 条，一条一行，每条 ≤60 字，整段 ≤300 字。' : '',
          fields.includes('title') ? '- 标题：8–16 字名词短语，说清「做到什么」，不要口号、不要写手段。' : '',
          fields.includes('verify') ? '- 验证：一条可直接执行的命令，或可观察的判定步骤（含期望输出）。' : '',
        ].filter(Boolean),
      },
      {
        label: '质量要求',
        lines: [
          wantsVision ? '- 里程碑愿景写成宏大叙事：这个里程碑之后项目/用户变成什么样、谁会因此不同；不写功能清单、不写工期、不写实现手段。' : '',
          wantsVision ? '- 里程碑愿景要挂到项目愿景上：它是项目愿景里的一步，不是另一个方向。' : '',
          wantsVision ? '- 里程碑愿景写「变成什么样」而不是「做了什么功能」——功能清单和判定方式是核心指标的活。' : '',
          wantsBlockers ? '- 阻碍项回答「现在就达成这个里程碑，离愿景还差哪一步、缺什么才能跑通」。' : '',
          wantsBlockers ? '- 每条写清：缺什么 → 挡在愿景的哪一步 → 涉及模块或文件。' : '',
          wantsBlockers ? '- 只写现在真的挡路的；解法、工期、愿望清单都不算阻碍。' : '',
          wantsBlockers ? '- 一条一个阻碍，按挡路程度排序；愿景里已写明的前提不重复写。' : '',
          wantsMetrics ? '- 核心指标从里程碑标题与里程碑愿景反推，对齐项目愿景：问「用什么可观察的结果证明这个愿景已经实现」。' : '',
          wantsMetrics ? '- 2–5 条，按对愿景的支撑强度排序；一条一个维度，互不重复。' : '',
          wantsMetrics ? '- 只写结果状态（数值 / 覆盖率 / 状态），不写测试命令、用例名、验收步骤——验收另有流程。' : '',
          wantsMetrics ? '- 指标要能长期对比：同一张卡复看时看得出是变好还是变差。' : '',
          wantsScenario ? '- 场景流程只覆盖这个目标：用户从头到尾走一遍，每步写操作 / 预期 / 体验。' : '',
          wantsAcceptance && !isMilestone ? '- 目标验收每条对应场景流程里的某一步，写清怎么判定通过（命令 / 文件 / 断言 / 可见结果）。' : '',
          wantsConstraints ? '- 约束来自目标场景里的边界与前提（来源、时长、范围、合规、中断规则），能落数字就落数字。' : '',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: [`严格只输出一个 JSON 对象：{${fields.map((f) => `"${f}": "..."`).join(', ')}}`, '只包含被要求的字段，不要输出其它文字。'],
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
