/**
 * rotation-core.mjs — rotation/v1 的校验与树工具（零依赖）
 * 被 validate-rotation.mjs（CLI）与 serve.mjs（写回服务）共用。
 */

const KINDS_BY_DEPTH = { 1: 'loop', 2: 'goal', 3: 'idea', 4: 'exec' };
const STATUS = new Set(['plan', 'ready', 'doing', 'blocked', 'done']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const iso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const KINDS = ['loop', 'goal', 'idea', 'exec'];
const SESSION_STATUS = new Set(['idle','starting','running','done','failed','cancelled','stale']);
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
    if (svc.start != null && typeof svc.start !== 'string') errors.push(`${a}.start: 必须是命令字符串`);
    if (svc.cwd != null && typeof svc.cwd !== 'string') errors.push(`${a}.cwd: 必须是路径字符串`);
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
  'project','loop','loop.intent','loop.acceptance','goal','goal.acceptance',
  'idea','idea.approach','siblings','node','node.acceptance','node.approach',
  'exec.verify','exec.proof','exec.issues','children','refs',
]);
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

    if (Array.isArray(n.issues) && n.kind !== 'exec') errors.push(`${at}: issues 只能挂在 exec 上`);
    if (depth <= 2 && !String(n.acceptance || '').trim()) pushError(`${at}: ${n.kind} 必须有 acceptance（验收方式）`);
    if (n.kind === 'exec' && !String(n.verify || '').trim()) pushError(`${at}: exec 必须有 verify`);

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
    // 文本字段长度提示（不阻断，只提醒收敛表达）
    ['intent', 'scenario', 'constraints', 'acceptance'].forEach((k) => {
      const v = n[k];
      if (typeof v === 'string' && v.length > 300) {
        warnings.push(`${at}.${k}: ${v.length} 字，超过 300 字建议压缩（卡片会变长、不好扫）`);
      }
    });
    if (n.scenario != null) {
      if (typeof n.scenario !== 'string') errors.push(`${at}.scenario: 必须是字符串`);
      else if (n.kind !== 'loop') warnings.push(`${at}.scenario: 只有闭环应该写场景闭环验证，这一项会被忽略`);
    }
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
  if (doc.services != null) checkServices(doc.services, 'services', errors);
  if (doc.prompt_context != null) checkPromptContext(doc.prompt_context, 'prompt_context', errors, warnings);
  if (doc.prompts != null) {
    if (typeof doc.prompts !== 'object' || Array.isArray(doc.prompts)) errors.push('prompts 必须是对象（按节点类型分组）');
    else Object.entries(doc.prompts).forEach(([k, list]) => {
      if (!KINDS.includes(k)) warnings.push(`prompts.${k}: 未知节点类型，会被忽略`);
      checkPromptList(list, `prompts.${k}`, errors, warnings);
    });
  }
  if (!doc.loop) errors.push('缺少 loop 根节点');
  else walk(doc.loop, 1, 'loop');

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

const K = { loop: '闭环', goal: '目标', idea: '构思', exec: '执行' };

export function treeLines(loop) {
  const out = [];
  (function render(n, depth) {
    const mark = n.closed_at ? '✓' : n.status === 'blocked' ? '✗' : '·';
    out.push(`${'  '.repeat(depth - 1)}${mark} [${K[n.kind] ?? n.kind}] ${n.title}  ${n.id}`);
    (n.children || []).forEach((c) => render(c, depth + 1));
  })(loop, 1);
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
