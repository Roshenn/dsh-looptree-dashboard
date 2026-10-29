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

const KIND_LABEL = { loop: '闭环', goal: '目标', idea: '构思', exec: '执行' };
const STATUS_LABEL = { plan: '规划中', ready: '就绪', doing: '进行中', blocked: '阻塞', done: '已完成' };
const CHILD_KIND = { loop: 'goal', goal: 'idea', idea: 'exec' };
const CHILD_LABEL = { goal: '目标', idea: '构思', exec: '执行' };
const FIELD_MAX = 300;

/** 允许的块标签（lint 用它判断「块标签后面必须有内容」） */
export const BLOCK_LABELS = new Set([
  '背景', '当前节点', '任务', '要做什么', '验收', '约束',
  '输出', '验证命令', '步骤', '提交方式', '收尾', '质量要求',
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
/** 超宽的行按标点断成多行（续行缩进），保证气泡里不会出现一条大长线 */
function wrapLine(line, max = 72) {
  const text = String(line);
  if (width(text) <= max) return [line];
  const lead = (text.match(/^\s*/) || [''])[0];
  const pad = lead + '  ';
  const chars = [...text];
  const out = [];
  let rest = chars;
  let first = true;
  while (width(rest.join('')) > max) {
    let acc = 0;
    let cut = 0;
    for (let i = 0; i < rest.length; i += 1) {
      acc += width(rest[i]);
      if (acc > max) break;
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
  if (n.closed_at) return '已闭环';
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
  loop: ['用 Markdown。', '每条一行：标题（8–16 字）+ 验收（可判定）。', '不复述上下文，直接给结论。'],
  goal: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  idea: ['用 Markdown。', '按任务要求给 1 条结果，句短、一条一义。', '不复述上下文。'],
  exec: ['用 Markdown。', '按任务要求给结果，句短、一条一义。', '不复述上下文。'],
};

const T = (id, title, summary, ask, output) => ({ id, title, summary, ask, output });

/** 内置模板：node.prompts > card.prompts[类型] > 这里 */
export const PROMPT_TASKS = {
  loop: [
    T('split', '拆成目标', '闭环 → 3–5 个可验证目标', [
      '把这个闭环拆成 3–5 个目标。',
      '每个目标都要能单独验证，并给出验收方式。',
      '验收优先写成可直接执行的命令。',
    ], ['用 Markdown。', '每条目标一行：标题（8–16 字）+ 验收（可判定）。', '不复述上下文。']),
    T('closed', '检查是否真闭合', '查目标是否都服务于同一意图', [
      '检查这个闭环是否真的闭合。',
      '每个目标是否都服务于同一个闭环意图。',
      '有没有目标其实不属于它；缺了哪一环。',
    ], ['用 Markdown。', '先给结论：真闭合 / 没闭合。', '再列缺口，一条一行。']),
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
  'project', 'loop', 'loop.intent', 'loop.acceptance', 'goal', 'goal.acceptance',
  'idea', 'node', 'node.acceptance',
  'exec.verify', 'exec.proof', 'exec.issues', 'children',
];

const CTX_FIELDS = {
  project: {
    sec: 'ctx',
    r: ({ pname }) => [`- 项目：${pname}`],
  },
  loop: {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] ? [`- 闭环：${oneLine(trail[0].title)}`] : []),
  },
  'loop.intent': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].intent ? [`  - 意图：${oneLine(trail[0].intent)}`] : []),
  },
  'loop.acceptance': {
    sec: 'ctx',
    r: ({ trail }) => (trail[0] && trail[0].acceptance ? [`  - 验收：${oneLine(trail[0].acceptance)}`] : []),
  },
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
      return [`- 同级${label}：${sibs.map((x) => `${x.title}${x.closed_at ? '（已闭环）' : ''}`).join('；')}`];
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
      (node.kind === 'loop' || node.kind === 'goal') && node.acceptance
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
  const root = doc.loop;
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
  const node = findNode(doc.loop, nodeId);
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
  const trail = pathTo(doc.loop, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const idea = trail[trail.length - 1];
  if (idea.kind !== 'idea') throw Object.assign(new Error('只有构思节点能发起动作'), { code: 'NOT_IDEA' });
  const loop = trail[0];
  const goal = trail.find((x) => x.kind === 'goal') || null;
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  return { doc, trail, idea, loop, goal, pname, ws };
}

function projectLine(pname, ws) {
  return ws ? `- 项目：${pname}（${ws}）` : `- 项目：${pname}`;
}

function acceptanceLines(text) {
  const items = splitItems(text);
  if (!items.length) return [];
  return items.map((x) => `- ${x}`);
}

/** 生成计划：走 /plan，正文整体作为命令参数（保留换行） */
export function composePlanPrompt(args) {
  const { doc, idea, loop, goal, pname, ws } = ideaContext(args);
  const background = [projectLine(pname, ws)];
  if (loop) {
    background.push(`- 闭环：${oneLine(loop.title)}`);
    if (loop.intent) background.push(`  - 意图：${oneLine(loop.intent)}`);
  }
  if (goal) {
    background.push(`- 目标：${oneLine(goal.title)}`);
    if (goal.acceptance) background.push(`  - 验收：${oneLine(goal.acceptance)}`);
  }
  background.push(`- 构思：${oneLine(idea.title)}`);
  if (idea.approach) background.push(`  - 方向：${oneLine(idea.approach)}`);

  return renderPrompt(
    `${ACTION_TITLE.plan} · ${nodeLabel(idea)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、产物、最近提交。',
          '2. 不确定就去查，不要凭空编。',
          '3. 产出可执行计划，不要开始改代码。',
        ],
      },
      { label: '验收', lines: acceptanceLines(idea.acceptance || (goal && goal.acceptance) || '') },
      {
        label: '输出',
        lines: [
          '用 Markdown，三节顺序固定：',
          '## 目标',
          '一句话：做完之后能稳定做到什么。',
          '## 验证命令',
          '可直接执行的 bash 命令，一行一条：',
          '```bash',
          'npm run preflight',
          '```',
          '## 步骤',
          '1. 每步一个可验证动作。',
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

/** /goal 的一句话目标：单行、≤240 字（目标面板按一行显示） */
export function composeGoalObjective(args) {
  const { idea, pname, ws } = ideaContext(args);
  const plan = idea.plan || {};
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : [];
  const verify = Array.isArray(plan.verify) ? plan.verify.filter(Boolean) : [];
  const parts = [
    `执行构思「${oneLine(idea.title)}」的计划：${oneLine(plan.goal || idea.title).replace(/[。．.!！?？]+$/u, '')}。`,
  ];
  if (steps.length) parts.push(`步骤 ${steps.length} 条：${steps.slice(0, 4).map((s, i) => `${i + 1}) ${oneLine(s)}`).join('；')}。`);
  if (verify.length) parts.push(`验证：${verify.slice(0, 2).map(oneLine).join('；')}。`);
  parts.push(`项目目录：${ws || '（未填写）'}。做完说明改了什么、验证结果。`);
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

/** 拆目标（闭环节点） */
export function composeSplitPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const node = findNode(doc.loop, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const background = [projectLine(pname, ws)];
  if (node.intent) background.push(`- 闭环目标：${oneLine(node.intent)}`);
  if (node.acceptance) background.push(`- 已有验收：${oneLine(node.acceptance)}`);
  if (node.constraints) background.push(`- 已知约束：${oneLine(node.constraints)}`);
  background.push(...childTitles(node));
  const scenario = clean(node.scenario);
  return renderPrompt(
    `拆目标 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '场景',
        lines: scenario
          ? ['已定的落地场景流程（约束与验收的唯一依据，必须逐条对上）：', ...scenario.split('\n')]
          : [],
      },
      {
        label: '要做什么',
        lines: [
          '1. 先读项目里的文件：README、脚本、配置、最近提交与产物。',
          '2. 给出 3 条候选目标，供人挑选（可能只采纳 1 条）。',
          '3. 不确定就去查，不要凭空编。',
        ],
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字名词短语，说清「做到什么」，不写口号、不写手段。',
          '- 验收写清怎么判定通过（命令 / 文件 / 断言 / 可见结果），能落命令就落命令，单条 ≤ 300 字。',
          '- 3 条互相独立，不要互相包含，不要重复已有目标。',
        ],
      },
      {
        label: '输出',
        lines: ['严格只输出一个 JSON 对象：{"goals":[{"title":"…","acceptance":"…"}]}', '只含这 3 条，不要输出其它文字。'],
      },
    ],
  );
}

/** 拆构思（目标节点） */
export function composeIdeaPrompt({ projectName, workspace, card, nodeId }) {
  const doc = card || {};
  const trail = pathTo(doc.loop, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const node = trail[trail.length - 1];
  const loop = trail[0];
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const background = [projectLine(pname, ws)];
  if (loop && loop !== node && loop.intent) background.push(`- 所属闭环目标：${oneLine(loop.intent)}`);
  background.push(`- 目标：${oneLine(node.title)}`);
  if (node.acceptance) background.push(`- 目标验收：${oneLine(node.acceptance)}`);
  if (node.constraints) background.push(`- 目标约束：${oneLine(node.constraints)}`);
  background.push(...childTitles(node));
  const scenario = loop && loop.scenario ? clean(loop.scenario) : '';
  return renderPrompt(
    `拆构思 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '场景',
        lines: scenario
          ? ['已定的落地场景流程（约束与验收的唯一依据）：', ...scenario.split('\n')]
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
          '- 3 条必须是不同的实现路线，不要重复已有构思。',
        ],
      },
      {
        label: '输出',
        lines: ['严格只输出一个 JSON 对象：{"ideas":[{"title":"…","strength":"…"}]}', '只含这 3 条，不要输出其它文字。'],
      },
    ],
  );
}

const FILL_LABEL = {
  title: '标题', intent: '闭环目标', scenario: '落地场景流程', constraints: '约束',
  acceptance: '验收', verify: '验证', proof: '证据',
};

/** 候选子节点（生成候选池用） */
export function composeCandidatePrompt({ projectName, workspace, card, nodeId, count = 3 }) {
  const doc = card || {};
  const node = findNode(doc.loop, nodeId);
  if (!node) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const childKind = CHILD_KIND[node.kind];
  const childLabel = CHILD_LABEL[childKind] || '子节点';
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const background = [projectLine(pname, ws), `- 当前节点：${nodeLabel(node)}`];
  if (node.intent) background.push(`- 意图：${oneLine(node.intent)}`);
  if (node.acceptance) background.push(`- 验收：${oneLine(node.acceptance)}`);
  background.push(...childTitles(node, 8));
  const forIdea = childKind === 'idea';
  return renderPrompt(
    `候选生成 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      {
        label: '要做什么',
        lines: [
          `1. 先读项目里的文件（README、脚本、配置、产物）再作答。`,
          `2. 给出 ${count} 条互不重复的候选${childLabel}，每条都要能独立验证。`,
          forIdea ? '3. 这 3 条是同一目标的互斥路线，最终只会采纳 1 条。' : '',
        ].filter(Boolean),
      },
      {
        label: '约束',
        lines: [
          '- 标题 8–16 字，说清「做到什么」（构思写「走哪条路」）。',
          forIdea ? '- 每条先写一句优势（strength）：为什么比其它候选更强，要能横向比较，不写空话。' : '',
          '- 每条给一句验收（可判定的检查、命令或判据）。',
        ].filter(Boolean),
      },
      {
        label: '输出',
        lines: [forIdea
          ? '严格只输出 JSON 数组：[{"title":"…","strength":"…","acceptance":"…"}]'
          : '严格只输出 JSON 数组：[{"title":"…","acceptance":"…"}]', '不要输出其它文字。'],
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

/** 按标题补全缺失字段 */
export function composeFillPrompt({ projectName, workspace, card, nodeId, fields = [] }) {
  const doc = card || {};
  const trail = pathTo(doc.loop, nodeId);
  if (!trail) throw Object.assign(new Error(`找不到节点：${nodeId}`), { code: 'NODE_NOT_FOUND' });
  const node = trail[trail.length - 1];
  const loop = doc.loop || {};
  const pname = projectName || (doc.project && doc.project.name) || '项目';
  const ws = workspace || (doc.project && doc.project.workspace) || '';
  const wanted = fields.map((f) => FILL_LABEL[f] || f).join('、');
  const derive = fields.includes('constraints') || fields.includes('acceptance');
  const isLoop = node.kind === 'loop';

  const background = [projectLine(pname, ws)];
  if (!isLoop && loop.intent) background.push(`- 所属闭环目标：${oneLine(loop.intent)}`);
  if (isLoop && node.intent) background.push(`- 闭环目标：${oneLine(node.intent)}`);
  if (isLoop && node.scenario) background.push(`- 已定场景流程：见下`);
  const scenario = clean(isLoop ? node.scenario : (loop.scenario || ''));

  const siblings = (node.children || []).filter((x) => !isRecord(x)).slice(0, 10)
    .map((x) => `${CHILD_LABEL[x.kind] || '节点'}·${oneLine(x.title)}`);
  const nodeLines = [
    `- 正在补：${nodeLabel(node)}`,
    node.constraints ? `- 已有约束：${oneLine(node.constraints)}` : '',
    node.acceptance ? `- 已有验收：${oneLine(node.acceptance)}` : '',
    node.verify ? `- 已有验证：${oneLine(node.verify)}` : '',
    siblings.length ? `- 同级其它节点：${siblings.join('；')}` : '',
  ].filter(Boolean);

  return renderPrompt(
    `补全 · ${nodeLabel(node)}`,
    [
      { label: '背景', lines: background },
      { label: '场景', lines: scenario ? ['（约束与验收的唯一依据，必须逐条对上）', ...scenario.split('\n')] : [] },
      { label: '当前节点', lines: nodeLines },
      {
        label: '要做什么',
        lines: [`1. 先读项目里的文件（README、脚本、配置、最近提交与产物）再作答。`, `2. 只补这几项：${wanted}。`, '3. 不确定就去查，不要凭空编。'],
      },
      {
        label: '约束',
        lines: [
          `- 每个字段 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`,
          '- 落地场景流程 3–5 步；约束 3–5 条；验收 3–5 条（含总验收）。',
          fields.includes('title') ? '- 标题：8–16 字名词短语，说清「做到什么」，不要口号、不要写手段。' : '',
          fields.includes('intent') ? '- 闭环目标：写做完之后能稳定做到什么，不写手段。' : '',
          fields.includes('verify') ? '- 验证：一条可直接执行的命令，或可观察的判定步骤（含期望输出）。' : '',
        ].filter(Boolean),
      },
      {
        label: '质量要求',
        lines: [
          derive ? '- 验收每条对应流程里的某一步，写清怎么判定通过（命令 / 文件 / 断言 / 可见结果）。' : '',
          derive ? '- 约束来自流程中的边界与前提（来源、时长、范围、合规、中断规则），能落数字就落数字。' : '',
          fields.includes('scenario') ? '- 场景流程用编号步骤，每步写：操作 / 预期 / 体验，只写 3–5 步。' : '',
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
