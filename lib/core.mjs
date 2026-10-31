/**
 * rotation-core.mjs — rotation/v1 的校验与树工具（零依赖）
 * 被 validate-rotation.mjs（CLI）与 serve.mjs（写回服务）共用。
 */

/**
 * 树形：里程碑 → 支撑项 → 执行记录（2026-10-31 由 milestone→goal→idea→exec 收敛而来）。
 * 支撑项是「想要什么、什么最需要」的承载：只读承接候选池的三件套，可写核心指标与实现思路。
 * 旧卡的 goal / idea 读入即折叠成 support，见 foldLegacySupportTree。
 */
const KINDS_BY_DEPTH = { 1: 'milestone', 2: 'support', 3: 'exec' };
const STATUS = new Set(['plan', 'ready', 'doing', 'blocked', 'done']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const iso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const KINDS = ['milestone', 'support', 'exec'];
const ACTIONS = new Set(['plan', 'exec', 'reflect']);
const SESSION_STATUS = new Set(['idle','starting','running','done','failed','cancelled','stale']);
/** 动作记录里 plan / reflect 不强制 verify（它们没有「验证命令」这一职责） */
const VERIFY_OPTIONAL_ACTIONS = new Set(['plan', 'reflect']);
const LESSON_MAX = 200;
/** 愿景是宏大叙事，比其它长字段放宽（3–6 句） */
export const VISION_MAX = 1000;

/** 构思的计划书：{ goal, verify[], steps[], doc, at, session }（action-records/v1 新增，可选） */
function checkPlan(plan, at, errors, warnings) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) { errors.push(`${at}: 必须是对象`); return; }
  if (plan.goal != null && typeof plan.goal !== 'string') errors.push(`${at}.goal: 必须是字符串`);
  if (typeof plan.goal === 'string' && plan.goal.length > 300) {
    warnings.push(`${at}.goal: ${plan.goal.length} 字，超过 300 字建议压成一句话`);
  }
  ['verify', 'steps'].forEach((k) => {
    if (plan[k] == null) return;
    if (!Array.isArray(plan[k])) { errors.push(`${at}.${k}: 必须是数组`); return; }
    plan[k].forEach((v, i) => {
      if (typeof v !== 'string' || !v.trim()) errors.push(`${at}.${k}[${i}]: 必须是非空字符串`);
    });
  });
  ['doc', 'session'].forEach((k) => {
    if (plan[k] != null && typeof plan[k] !== 'string') errors.push(`${at}.${k}: 必须是字符串`);
  });
  if (plan.at != null && !iso(plan.at)) errors.push(`${at}.at: 必须是 ISO 时间`);
}

/** 闭环的经验积累：[{ text, from?, at? }]（也兼容纯字符串数组） */
function checkLessons(list, at, errors, warnings) {
  if (!Array.isArray(list)) { errors.push(`${at}: 必须是数组`); return; }
  list.forEach((item, i) => {
    const a = `${at}[${i}]`;
    const text = typeof item === 'string' ? item : (item && item.text);
    if (typeof text !== 'string' || !text.trim()) { errors.push(`${a}: 缺 text`); return; }
    if (text.length > LESSON_MAX) warnings.push(`${a}.text: ${text.length} 字，超过 ${LESSON_MAX} 字建议压缩`);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (item.from != null && typeof item.from !== 'string') errors.push(`${a}.from: 必须是字符串`);
      if (item.at != null && !iso(item.at)) errors.push(`${a}.at: 必须是 ISO 时间`);
    }
  });
}

/**
 * 命令 / 路径字段：字符串（全平台共用）或平台映射
 * （{ mac, windows, linux, default }）；映射的每一项都必须是字符串。
 */
function isCommandOrMap(value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function checkServices(list, at, errors) {
  if (!Array.isArray(list)) { errors.push(`${at}: 必须是数组`); return; }
  const seen = new Set();
  list.forEach((svc, i) => {
    const a = `${at}[${i}]`;
    if (!svc || typeof svc !== 'object') { errors.push(`${a}: 不是对象`); return; }
    if (!svc.id || !/^[A-Za-z0-9_-]+$/.test(String(svc.id))) errors.push(`${a}.id: 只允许字母数字与 -_`);
    else if (seen.has(svc.id)) errors.push(`${a}.id: 重复`);
    else seen.add(svc.id);
    if (!svc.name || !String(svc.name).trim()) errors.push(`${a}.name: 必填`);
    if (!svc.url || !/^https?:\/\/[^\s]+$/.test(String(svc.url))) errors.push(`${a}.url: 必须是 http(s) 地址`);
    if (svc.health != null && typeof svc.health !== 'string') errors.push(`${a}.health: 必须是字符串路径`);
    // start / stop / cwd：字符串，或 { mac, windows, linux, default } 平台映射
    if (svc.start != null && !isCommandOrMap(svc.start)) errors.push(`${a}.start: 必须是命令字符串或 { mac, windows, linux, default } 映射`);
    if (svc.stop != null && !isCommandOrMap(svc.stop)) errors.push(`${a}.stop: 必须是命令字符串或平台映射`);
    if (svc.cwd != null && !isCommandOrMap(svc.cwd)) errors.push(`${a}.cwd: 必须是路径字符串或平台映射`);
    ['confidence', 'evidence'].forEach((key) => {
      if (svc[key] != null && typeof svc[key] !== 'string') errors.push(`${a}.${key}: 必须是字符串`);
    });
  });
}
function checkSession(sess, at, errors) {
  if (typeof sess !== 'object' || Array.isArray(sess)) { errors.push(`${at}: 必须是对象`); return; }
  if (!sess.id || typeof sess.id !== 'string') errors.push(`${at}.id: 必填`);
  if (sess.status != null && !SESSION_STATUS.has(sess.status)) errors.push(`${at}.status: 非法（${sess.status}）`);
  ['started_at', 'ended_at'].forEach(k => {
    if (sess[k] != null && !iso(sess[k])) errors.push(`${at}.${k}: 必须是 ISO 时间`);
  });
  if (sess.exit_code != null && !Number.isInteger(sess.exit_code)) errors.push(`${at}.exit_code: 必须是整数`);
}
const CTX_KEYS = new Set([
  'project','milestone','milestone.vision','milestone.metrics','milestone.supports',
  'support','support.necessity','support.causal','support.metric','support.approach',
  'siblings','node','node.metric','node.approach','node.necessity','node.causal',
  'exec.verify','exec.proof','exec.issues','children','refs',
  // 旧键：读入即改名（见 CTX_ALIAS），这里保留是为了手写配置不报未知字段
  'milestone.acceptance','milestone.blockers','goal','goal.acceptance','goal.scenario',
  'idea','idea.approach','node.acceptance',
]);
/** 旧上下文字段名 → 新名（旧卡 prompt_context 里的 loop.* / goal.* / idea.* 读入即改名） */
const CTX_ALIAS = {
  loop: 'milestone',
  'loop.intent': 'milestone.vision',
  'loop.acceptance': 'milestone.metrics',
  'loop.blockers': 'milestone.supports',
  'milestone.blockers': 'milestone.supports',
  'milestone.acceptance': 'milestone.metrics',
  goal: 'support',
  'goal.acceptance': 'support.metric',
  'goal.scenario': 'support.approach',
  idea: 'support',
  'idea.approach': 'support.approach',
  'node.acceptance': 'node.metric',
};
/**
 * 里程碑历史（closed_milestones）：面板手动达成后写进卡片的已达成快照。
 * 只做浅校验——快照里的树结构不重复递归校验，避免整卡校验两次。
 */
const CLOSED_MILESTONES_MAX = 10;
function checkClosedMilestones(list, errors) {
  if (!Array.isArray(list)) { errors.push('closed_milestones: 必须是数组'); return; }
  if (list.length > CLOSED_MILESTONES_MAX) errors.push(`closed_milestones: 最多 ${CLOSED_MILESTONES_MAX} 条，实际 ${list.length}`);
  list.forEach((entry, i) => {
    const at = `closed_milestones[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${at}: 不是对象`); return; }
    if (!entry.id || typeof entry.id !== 'string') errors.push(`${at}.id: 必填`);
    if (!entry.title || typeof entry.title !== 'string') errors.push(`${at}.title: 必填`);
    if (!iso(entry.closed_at)) errors.push(`${at}.closed_at: 必须是 ISO 时间`);
    if (entry.archived_at != null && !iso(entry.archived_at)) errors.push(`${at}.archived_at: 必须是 ISO 时间`);
    if (entry.goals != null && !Number.isInteger(entry.goals)) errors.push(`${at}.goals: 必须是整数（旧计数，读时兼容）`);
    if (entry.supports != null && !Number.isInteger(entry.supports)) errors.push(`${at}.supports: 必须是整数`);
    if (entry.execs != null && !Number.isInteger(entry.execs)) errors.push(`${at}.execs: 必须是整数`);
    const snap = entry.snapshot;
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) { errors.push(`${at}.snapshot: 必须是对象`); return; }
    if (snap.kind !== 'milestone') errors.push(`${at}.snapshot.kind: 必须是 milestone`);
    if (!snap.id || typeof snap.id !== 'string') errors.push(`${at}.snapshot.id: 必填`);
  });
}
/**
 * 旧四层折叠成三层（2026-10-31「目标和构思两列合并成支撑项」）：
 * - 深度 2 的 `goal` / `idea` 一律改成 `support`；
 * - `goal.blocker` → `support.support`（承接的重要支撑条目）；
 * - `goal` 下的 `idea` 折叠进这个 support：`approach` / `plan` / `support` 在空时继承，
 *   `idea.children`（执行记录）全部上提为支撑项的子节点；
 * - 只改名与搬运，不丢内容（退役的 `scenario` / `constraints` / `acceptance` 原样留在 JSON）。
 * 幂等：已经是 support 的节点只递归、不改写。
 */
function foldLegacyChild(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const kids = Array.isArray(node.children) ? node.children : [];
  const legacy = node.kind === 'goal' || node.kind === 'idea';
  if (!legacy) {
    node.children = kids.map(foldLegacyChild).flat().filter(Boolean);
    return [node];
  }
  node.kind = 'support';
  if (node.support == null && node.blocker != null) node.support = String(node.blocker);
  delete node.blocker;
  const kept = [];
  for (const kid of kids) {
    const nested = kid && typeof kid === 'object' && (kid.kind === 'goal' || kid.kind === 'idea');
    if (!nested) { kept.push(...foldLegacyChild(kid)); continue; }
    // 构思（或更深的旧目标）折叠进当前支撑项
    foldLegacyChild(kid).forEach((folded) => {
      if (folded && folded.kind === 'support') {
        if (!node.approach && folded.approach) node.approach = folded.approach;
        if (!node.plan && folded.plan) node.plan = folded.plan;
        if (!node.support && folded.support) node.support = folded.support;
        kept.push(...(Array.isArray(folded.children) ? folded.children : []));
      } else if (folded) {
        kept.push(folded);
      }
    });
  }
  node.children = kept;
  return [node];
}

/** 旧卡兼容（读入归一）：改名 + 把 goal/idea 折叠成 support。原地修改、幂等。 */
export function normalizeLegacyCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return card;
  const doc = card;
  if (!doc.milestone && doc.loop) { doc.milestone = doc.loop; delete doc.loop; }
  const root = doc.milestone;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    if (root.kind === 'loop') root.kind = 'milestone';
    if (root.vision == null && root.intent != null) { root.vision = root.intent; delete root.intent; }
    // 阻碍项 → 重要支撑（内容不丢，只是换语义与名字）
    if (root.blockers != null) {
      if (root.supports == null) root.supports = root.blockers;
      delete root.blockers;
    }
    if (Array.isArray(root.children)) {
      root.children = root.children.map(foldLegacyChild).flat().filter(Boolean);
    }
  }
  if (!doc.closed_milestones && Array.isArray(doc.closed_loops)) {
    doc.closed_milestones = doc.closed_loops;
    delete doc.closed_loops;
  }
  if (Array.isArray(doc.closed_milestones)) {
    doc.closed_milestones.forEach((entry) => {
      const snap = entry && entry.snapshot;
      if (snap && snap.kind === 'loop') snap.kind = 'milestone';
    });
  }
  const mapFields = (cfg) => {
    if (!cfg || !Array.isArray(cfg.fields)) return;
    cfg.fields = cfg.fields.map((k) => CTX_ALIAS[k] || k);
  };
  mapFields(doc.prompt_context);
  if (root && typeof root === 'object') mapFields(root.prompt_context);
  return doc;
}
const ID_RE_CORE = /^[a-z0-9][a-z0-9-]*$/;
function checkPromptContext(cfg, at, errors, warnings) {
  if (typeof cfg !== 'object' || Array.isArray(cfg)) { errors.push(`${at}: 必须是对象`); return; }
  if (cfg.fields != null) {
    if (!Array.isArray(cfg.fields)) errors.push(`${at}.fields: 必须是数组`);
    else cfg.fields.forEach((k, i) => {
      if (!CTX_KEYS.has(k)) warnings.push(`${at}.fields[${i}]: 未知上下文字段 ${JSON.stringify(k)}，会被忽略`);
    });
  }
  if (cfg.siblings != null && (!Number.isInteger(cfg.siblings) || cfg.siblings < 0 || cfg.siblings > 10)) {
    errors.push(`${at}.siblings: 需为 0–10 的整数`);
  }
  if (cfg.refs != null) {
    if (!Array.isArray(cfg.refs)) errors.push(`${at}.refs: 必须是数组（节点 id 列表）`);
    else cfg.refs.forEach((id, i) => {
      if (typeof id !== 'string' || !ID_RE_CORE.test(id)) errors.push(`${at}.refs[${i}]: 需为节点 id 字符串`);
    });
  }
}
function checkPromptList(list, at, errors, warnings) {
  if (!Array.isArray(list)) { errors.push(`${at}: 必须是数组`); return; }
  if (!list.length) { warnings.push(`${at}: 空数组，等同不使用自定义模板`); return; }
  list.forEach((t, i) => {
    const a = `${at}[${i}]`;
    if (!t || typeof t !== 'object') { errors.push(`${a}: 不是对象`); return; }
    if (!t.id || !/^[A-Za-z0-9_-]+$/.test(String(t.id))) errors.push(`${a}: id 只允许字母数字与 -_`);
    if (!String(t.title || '').trim()) errors.push(`${a}: 缺 title`);
    if (!String(t.ask || '').trim()) errors.push(`${a}: 缺 ask（任务指令）`);
  });
}

export function validateCard(doc, opts = {}) {
  normalizeLegacyCard(doc);
  const errors = [];
  const warnings = [];
  // 渐进填写：卡片还没写完时允许落盘，把「文本必填」类错误降级成警告
  const TEXT_REQUIRED = /必须有 acceptance|必须有 verify|必须有 proof|缺少 title/;
  const pushError = (msg) => {
    if (opts.lenient && TEXT_REQUIRED.test(msg)) warnings.push(msg + '（未填完，已按草稿保存）');
    else errors.push(msg);
  };
  const ids = new Set();
  const nodes = [];

  function walk(n, depth, path) {
    if (!n || typeof n !== 'object') { errors.push(`${path}: 不是对象`); return; }
    const at = `${path}(${n.id ?? '?'})`;
    nodes.push({ node: n, depth, path });

    if (!n.id) errors.push(`${at}: 缺少 id`);
    else if (!ID_RE.test(n.id)) errors.push(`${at}: id 需匹配 ${ID_RE}`);
    else if (ids.has(n.id)) errors.push(`${at}: id 重复`);
    else ids.add(n.id);

    if (!n.title || !String(n.title).trim()) errors.push(`${at}: 缺少 title`);

    const expectKind = KINDS_BY_DEPTH[depth];
    if (!expectKind) {
      if (n.kind !== 'exec') errors.push(`${at}: 深度 ${depth} 只能是 exec（面板会折叠显示）`);
    } else if (n.kind !== expectKind) {
      errors.push(`${at}: 深度 ${depth} 应为 ${expectKind}，实际 ${n.kind}`);
    }

    // 空数组沿用旧数据/面板的写法，不该把整张卡拦下来；只有真的挂了问题才算错
    if (Array.isArray(n.issues) && n.issues.length && n.kind !== 'exec') errors.push(`${at}: issues 只能挂在 exec 上`);
    // 动作记录（action-records/v1）：action 只挂在 exec 上，plan / reflect 不写验证命令
    if (n.action != null) {
      if (!ACTIONS.has(n.action)) errors.push(`${at}.action: 非法（${n.action}），只能是 plan / exec / reflect`);
      else if (n.kind !== 'exec') warnings.push(`${at}.action: 只有执行记录用 action，这一项会被忽略`);
    }
    if (n.kind === 'exec' && !VERIFY_OPTIONAL_ACTIONS.has(n.action) && !String(n.verify || '').trim()) {
      pushError(`${at}: exec 必须有 verify`);
    }
    // 验收已退役（2026-10-31）：支撑项用「核心指标」说清到什么程度算撑住里程碑，不再有验收字段
    // 闭环经验积累 / 支撑项计划书（action-records/v1）
    if (n.lessons != null) {
      if (n.kind !== 'milestone') warnings.push(`${at}.lessons: 只有里程碑积累经验，这一项会被忽略`);
      else checkLessons(n.lessons, `${at}.lessons`, errors, warnings);
    }
    if (n.plan != null) {
      if (n.kind !== 'support') warnings.push(`${at}.plan: 只有支撑项挂计划书，这一项会被忽略`);
      else checkPlan(n.plan, `${at}.plan`, errors, warnings);
    }

    if (n.status != null && !STATUS.has(n.status)) errors.push(`${at}: status 非法（${n.status}）`);
    if (n.closed_at != null && !iso(n.closed_at)) errors.push(`${at}: closed_at 必须是 ISO 时间或 null`);
    if (n.closed_at != null && n.kind === 'exec' && !String(n.proof || '').trim()) {
      pushError(`${at}: 已关闭的 exec 必须有 proof（证据）`);
    }
    if (n.started_at != null) {
      if (!iso(n.started_at)) errors.push(`${at}: started_at 必须是 ISO 时间或 null`);
      else if (n.closed_at != null && Date.parse(n.started_at) > Date.parse(n.closed_at)) {
        errors.push(`${at}: started_at 晚于 closed_at（在途时长为负）`);
      }
    }
    // 文本字段长度提示（不阻断，只提醒收敛表达）；vision 放宽到 1000，必要性/因果各 200
    const LEN_LIMIT = { vision: VISION_MAX, necessity: 200, causal: 200 };
    ['vision', 'metrics', 'supports', 'necessity', 'causal', 'metric', 'approach'].forEach((k) => {
      const limit = LEN_LIMIT[k] || 300;
      const v = n[k];
      if (typeof v === 'string' && v.length > limit) {
        warnings.push(`${at}.${k}: ${v.length} 字，超过 ${limit} 字建议压缩（卡片会变长、不好扫）`);
      }
    });
    // 愿景只挂在里程碑上：这个里程碑要把项目带到哪（宏大叙事，不写功能清单）
    if (n.vision != null) {
      if (typeof n.vision !== 'string') errors.push(`${at}.vision: 必须是字符串`);
      else if (n.kind !== 'milestone') warnings.push(`${at}.vision: 只有里程碑写愿景，这一项会被忽略`);
    }
    // 重要支撑只挂在里程碑上：要让这个愿景成立，必须存在哪些东西（按重要性排序）
    if (n.supports != null) {
      if (typeof n.supports !== 'string') errors.push(`${at}.supports: 必须是字符串（一条一行）`);
      else if (n.kind !== 'milestone') warnings.push(`${at}.supports: 只有里程碑写重要支撑，这一项会被忽略`);
    }
    // 核心指标只挂在里程碑上：从里程碑愿景反推的 2–5 条「愿景达成的证据」，
    // 与支撑项的 support.metric（这条支撑撑没撑住里程碑）是两回事
    if (n.metrics != null) {
      if (typeof n.metrics !== 'string') errors.push(`${at}.metrics: 必须是字符串`);
      else if (n.kind !== 'milestone') warnings.push(`${at}.metrics: 只有里程碑写核心指标，这一项会被忽略`);
    }
    // 支撑项的四件套：承接支撑项 / 必要性 / 因果（只读）+ 核心指标 / 实现思路（可写）
    if (n.support != null) {
      if (typeof n.support !== 'string') errors.push(`${at}.support: 必须是字符串`);
      else if (n.kind !== 'support') warnings.push(`${at}.support: 只有支撑项承接重要支撑，这一项会被忽略`);
      else if (n.support.length > 80) warnings.push(`${at}.support: ${n.support.length} 字，超过 80 字建议只留支撑项短名`);
    }
    [['necessity', 200], ['causal', 200], ['metric', 300], ['approach', 300]].forEach(([k, limit]) => {
      if (n[k] == null) return;
      if (typeof n[k] !== 'string') { errors.push(`${at}.${k}: 必须是字符串`); return; }
      if (n.kind !== 'support') warnings.push(`${at}.${k}: 只有支撑项写${k === 'metric' ? '核心指标' : k === 'approach' ? '实现思路' : k === 'necessity' ? '必要性' : '因果'}，这一项会被忽略`);
      else if (n[k].length > limit) warnings.push(`${at}.${k}: ${n[k].length} 字，超过 ${limit} 字建议压缩`);
    });
    // 已退役字段（2026-10-31 按愿景驱动收敛）：旧卡里的内容原样留在 JSON，面板不显示、不进 prompt
    [['scenario', '落地场景流程'], ['constraints', '约束'], ['acceptance', '验收']].forEach(([k, label]) => {
      if (n[k] == null) return;
      if (typeof n[k] !== 'string') errors.push(`${at}.${k}: 必须是字符串`);
      else warnings.push(`${at}.${k}: ${label}已退役（改用核心指标 + 实现思路），这一项会被忽略`);
    });
    if (n.blockers != null) warnings.push(`${at}.blockers: 已改名为 supports（重要支撑），读入即改名`);
    if (n.blocker != null) warnings.push(`${at}.blocker: 已改名为 support（承接的重要支撑），读入即改名`);
    if (n.prompts != null) checkPromptList(n.prompts, `${at}.prompts`, errors, warnings);
    if (n.prompt_context != null) checkPromptContext(n.prompt_context, `${at}.prompt_context`, errors, warnings);
    if (n.session != null) checkSession(n.session, `${at}.session`, errors);
    if (n.status === 'doing' && n.closed_at == null && n.started_at == null) {
      warnings.push(`${at}: doing 但缺 started_at，面板算不出在途时长`);
    }

    const kids = Array.isArray(n.children) ? n.children : [];
    kids.forEach((k, i) => walk(k, depth + 1, `${path} > ${i}`));

    if (n.closed_at != null) {
      const openKids = kids.filter((k) => k.closed_at == null);
      if (openKids.length) {
        errors.push(`${at}: 已关闭但仍有 ${openKids.length} 个子节点未关闭（${openKids.map((k) => k.id).join(', ')}）`);
      }
    }
    if (n.status === 'done' && kids.length) warnings.push(`${at}: 非叶子写入 status=done，将由子节点推导`);
  }

  if (!doc || typeof doc !== 'object') return { errors: ['根节点不是对象'], warnings, nodes, stats: {} };
  if (doc.schema !== 'rotation/v1') errors.push(`schema 必须是 rotation/v1，实际 ${doc.schema}`);
  if (!doc.project || !doc.project.name) errors.push('缺少 project.name');
  if (!doc.project?.workspace) warnings.push('缺少 project.workspace（面板按路径匹配工作区会失败）');
  // 项目愿景：项目层的第一字段，说明这个项目最终要变成什么样（里程碑愿景要能挂上来）
  if (doc.project && doc.project.vision != null) {
    if (typeof doc.project.vision !== 'string') errors.push('project.vision: 必须是字符串');
    else if (doc.project.vision.length > VISION_MAX) {
      warnings.push(`project.vision: ${doc.project.vision.length} 字，超过 ${VISION_MAX} 字建议压缩`);
    }
  }
  if (doc.services != null) checkServices(doc.services, 'services', errors);
  if (doc.prompt_context != null) checkPromptContext(doc.prompt_context, 'prompt_context', errors, warnings);
  if (doc.prompts != null) {
    if (typeof doc.prompts !== 'object' || Array.isArray(doc.prompts)) errors.push('prompts 必须是对象（按节点类型分组）');
    else Object.entries(doc.prompts).forEach(([k, list]) => {
      if (!KINDS.includes(k)) warnings.push(`prompts.${k}: 未知节点类型，会被忽略`);
      checkPromptList(list, `prompts.${k}`, errors, warnings);
    });
  }
  if (doc.closed_milestones != null) checkClosedMilestones(doc.closed_milestones, errors);
  if (!doc.milestone) errors.push('缺少 milestone 根节点');
  else walk(doc.milestone, 1, 'milestone');

  const known = new Set(nodes.map(x => x.node.id));
  const checkRefsIds = (cfg, at) => {
    if (!cfg || !Array.isArray(cfg.refs)) return;
    cfg.refs.forEach((id, i) => {
      if (typeof id === 'string' && !known.has(id)) errors.push(`${at}.refs[${i}]: 找不到节点 ${JSON.stringify(id)}`);
    });
  };
  checkRefsIds(doc.prompt_context, 'prompt_context');
  nodes.forEach(x => checkRefsIds(x.node.prompt_context, `${x.path}.prompt_context`));

  const leaves = nodes.filter((x) => !(x.node.children || []).length);
  const stats = {
    nodes: nodes.length,
    maxDepth: Math.max(0, ...nodes.map((x) => x.depth)),
    leaves: leaves.length,
    closedLeaves: leaves.filter((x) => x.node.closed_at).length,
    blocked: nodes.filter((x) => x.node.status === 'blocked' && !x.node.closed_at).length,
    closable: nodes.filter((x) => {
      const kids = x.node.children || [];
      return !x.node.closed_at && kids.length && kids.every((k) => k.closed_at);
    }).length,
  };
  return { errors, warnings, nodes, stats };
}

const K = { milestone: '里程碑', support: '支撑项', goal: '目标', idea: '构思', exec: '执行' };

export function treeLines(milestone) {
  const out = [];
  (function render(n, depth) {
    const mark = n.closed_at ? '✓' : n.status === 'blocked' ? '✗' : '·';
    out.push(`${'  '.repeat(depth - 1)}${mark} [${K[n.kind] ?? n.kind}] ${n.title}  ${n.id}`);
    (n.children || []).forEach((c) => render(c, depth + 1));
  })(milestone, 1);
  return out;
}

/** 由子节点推导父节点状态；close 时写回用 */
export function deriveStatus(node) {
  const kids = node.children || [];
  if (!kids.length) return node.status || 'plan';
  const all = (ns) => ns.flatMap((n) => (n.children?.length ? all(n.children) : [n]));
  const leaves = all(kids);
  if (leaves.some((l) => l.status === 'blocked' && !l.closed_at)) return 'blocked';
  if (kids.every((k) => k.closed_at)) return 'done';
  if (kids.some((k) => k.closed_at) || leaves.some((l) => l.status === 'doing')) return 'doing';
  return 'ready';
}

/**
 * 列表型字段：阻碍项 / 核心指标 / 验收 / 约束 / 场景流程。
 * 它们共用一条口径：**一条一行、每行一个语义单位**——卡片 chips、拆目标注入、
 * 候选生成、条目编辑器全靠这个约定切分。
 */
export const LIST_FIELDS = new Set(['supports', 'metrics', 'acceptance', 'constraints', 'scenario', 'blockers']);

/** 行首序号/符号（1) A. 一、 1. - • ○ ①）：统一去掉后重新编号，避免混出「○缺…\n2)缺…」 */
const ITEM_PREFIX_RE = /^\s*(?:\d{1,3}\s*[)）、]\s*|\d{1,3}\.\s+|[-A-Za-z]\s*[.、)]\s*|[A-Za-z][.、)]\s*|[一二三四五六七八九十]+[、.]\s*|[-•*○◯·∙▪◦]+\s*|[①-⑳]\s*|[-•*○◯·∙▪◦][)）、]\s*)+/;

/**
 * 补全结果里的列表字段 → 卡片口径（一条一行、每行带序号）。
 *
 * 2026-10-30 用户反馈「多条条目融合在一起」：模型把 5 条阻碍写成 `○` 前缀 + 单换行，
 * 而条目编辑器只认编号/短横线，认不出 `○` 就把整段当成一条。两处一起改：
 * - 生成端契约改成 JSON 数组（`{"blockers":["…","…"]}`），这里负责拼回多条；
 * - 元素内换行压成空格（保证一条一行），缺序号补「N)」，让所有既有消费者
 *   （卡片 chips 计数、拆目标注入、条目编辑器）不用改也能正确切分。
 * 旧字符串结果同样走这里：多行且没有任何序号标记时按行补序号。
 */
export function normalizeListValue(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split('\n');
  const items = raw
    .map((x) => String(x == null ? '' : x).replace(/\s*\n\s*/g, ' ').replace(ITEM_PREFIX_RE, '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  // 统一重编号：模型给的 ○ · ① 1) 全部收敛成「N)」，混用不会漏进卡片
  return items.map((x, i) => `${i + 1})${x}`).join('\n');
}
