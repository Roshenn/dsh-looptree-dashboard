/**
 * lib/index.js — host 半：把面板与数据接口挂到 DSH 自己的 web server 上。
 *
 * 路由（base 默认 /rotation）：
 *   GET  /rotation/api/health        冒烟
 *   GET  /rotation/app/*             面板静态资源（web/ 目录）
 *
 * 数据接口（M1 起）与 M2/M3 的会话、服务接口都挂在同一个 base 下，
 * 因此 client 半只需要拿到 base 就能打开面板。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DSH_HOME, listProjects, readAllCards, findProject, readCard, writeCard, addProject, removeProject, findNode, listDshWorkspaces, REGISTRY_PATH, REGISTRY_DIR } from './store.mjs';
import { createRunner } from './runner.mjs';
import { createServiceRunner, joinHealth, normalizeServices, platformLabel, probe } from './services.mjs';
import { actionCommand, actionFallbackPrompt, composeActionPrompt, composeCandidatePrompt, composeCollectServicesPrompt, composeFillPrompt, composeGoalObjective, composeIdeaPrompt, composeSplitPrompt, composeTaskPrompt, lintPrompt, listTaskPrompts } from './prompt.mjs';
import { readFile, readdir, readFile as readFileRaw, stat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-looptree-dashboard';
// cordis 要求把用到的服务全部声明；agents / agentDefaultModel 用于节点会话，
// commands / goals 用于「/plan、/goal」驱动（脚本里的假 ctx 没有它们，代码全部可选链）
export const inject = ['webServer', 'agents', 'agentDefaultModel', 'workspaceRegistry', 'commands', 'goals'];

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = resolve(HERE, '..', 'web');
const VERSION = readPkgVersion();

function readPkgVersion() {
  try {
    // 只在模块加载时读一次，避免 apply 变成异步
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

async function readJsonBody(req, limit = 4e6) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-rotation-token',
  'access-control-max-age': '600',
  // Chromium 私有网络访问预检（dsh-app:// 页面访问 127.0.0.1 时可能要求）
  'access-control-allow-private-network': 'true',
};

function sendJson(res, code, body) {
  res.writeHead(code, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** 运行时收集的监听端口与 webServer 暴露面（供注入与 health 诊断） */
const SERVER_INFO = { port: 0, keys: [], address: null };

function detectServerPort(ctx) {
  const ws = ctx && ctx.webServer;
  if (!ws) return 0;
  const candidates = [
    ws.port,
    ws.listeningPort,
    ws.address?.()?.port,
    ws.server?.address?.()?.port,
    ws.httpServer?.address?.()?.port,
  ];
  for (const v of candidates) if (Number.isFinite(v) && v > 0) return Number(v);
  return 0;
}

/** 从进程参数里拿 --port（桌面外壳与 `dsh web --port` 都传这个） */
function argvPort() {
  const argv = process.argv || [];
  const i = argv.indexOf('--port');
  if (i >= 0 && argv[i + 1] && /^\d+$/.test(argv[i + 1])) return Number(argv[i + 1]);
  const j = argv.findIndex((a) => typeof a === 'string' && a.startsWith('--port='));
  if (j >= 0) {
    const n = Number(argv[j].slice('--port='.length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function injectApiBase(html, req, base) {
  // 桌面外壳把面板跑在 dsh-app://app 里，相对路径/协议内代理都可能到不了 HTTP 服务。
  // 这里注入「候选 API 地址」，面板按顺序探测，第一个 /health 通的就用。
  const host = req.headers.host || '';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const port = SERVER_INFO.port || argvPort();
  const candidates = [];
  if (host && /^(?![a-z][a-z0-9+.-]*:)/i.test(host)) candidates.push(`${proto}://${host}${base}/api`);
  if (port) candidates.push(`http://127.0.0.1:${port}${base}/api`);
  candidates.push(`${base}/api`);
  const uniq = [...new Set(candidates)];
  const lit = JSON.stringify(uniq).replace(/</g, '\\u003c');       // 防 Host 头注入 </script>
  const first = JSON.stringify(uniq[0]).replace(/</g, '\\u003c');
  const ver = JSON.stringify(VERSION).replace(/</g, '\\u003c');
  const tag = `<script>window.__ROTATION_API_CANDIDATES__=${lit};window.__ROTATION_API_ABS__=${first};window.__ROTATION_VERSION__=${ver};</script>`;
  return html.includes('</head>') ? html.replace('</head>', tag + '</head>') : tag + html;
}

async function serveStatic(res, relPath, req, base) {
  const rel = relPath === '/' || relPath === '' ? '/index.html' : relPath;
  const abs = resolve(WEB, '.' + rel);
  if (!abs.startsWith(WEB + sep) && abs !== WEB) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const isHtml = (MIME[extname(abs)] || '').startsWith('text/html');
    if (isHtml) {
      const html = injectApiBase(await readFile(abs, 'utf8'), req || { headers: {} }, base);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const MAX_CONCURRENT = Number(process.env.ROTATION_MAX_CONCURRENT || 3);

/** 找到从 root 到 targetId 的路径（包含两端），找不到返回 null */
function pathToNode(root, targetId) {
  if (!root) return null;
  if (root.id === targetId) return [root];
  for (const child of root.children || []) {
    const sub = pathToNode(child, targetId);
    if (sub) return [root, ...sub];
  }
  return null;
}

/** 该节点是否有「上游（祖先）正在跑会话」——有则不允许它再发起 */
function runningAncestorOf(runner, card, nodeId) {
  if (!runner) return null;
  const active = runner.list().filter((r) => r.status === 'starting' || r.status === 'running');
  if (!active.length) return null;
  const path = pathToNode(card.loop, nodeId) || [];
  const ancestors = new Set(path.slice(0, -1).map((x) => x.id));
  if (!ancestors.size) return null;
  return active.find((r) => ancestors.has(r.nodeId)) || null;
}

/** 会话快照 → 卡片上的 session 字段（动作记录与普通节点共用） */
function sessionOf(snap) {
  return {
    id: snap.sessionId,
    status: snap.status,
    cwd: snap.cwd,
    task_id: snap.taskId || undefined,
    started_at: snap.startedAt,
    ended_at: snap.endedAt || undefined,
    result: (snap.result || '').slice(0, 4000) || undefined,
    error: snap.error || undefined,
  };
}

/**
 * 把运行结果写回卡片的节点 session 字段。
 * 动作会话写到记录节点（run.recordId），不覆盖构思节点上的 session。
 *
 * 记录节点（带 `action`）不接受普通会话覆盖：那个 session 位属于「生成计划 / 执行计划 /
 * 反馈提炼」自己的动作会话，只由 applyActionResult 写。以前这里会把 prompt 模板发起的
 * 普通会话快照盖上去，卡上于是出现一条从没发过 `/plan`、task_id 是 `steps` 的会话顶着
 * 「计划 · 会话交回计划」的标题（2026-10-29 定位）。
 */
async function persistSession(entry, snap, nodeId) {
  return enqueueCardWrite(entry.file, async () => {
    const card = await readCard(entry);
    const node = findNode(card.loop, nodeId || snap.recordId || snap.nodeId);
    if (!node) return;
    if (node.action) return;
    node.session = sessionOf(snap);
    await writeCard(entry, card);
  });
}

/* ─────────── 动作会话：生成计划 / 执行计划 / 反馈提炼 ─────────── */
const ACTIONS = {
  plan: { prefix: 'p', label: '计划' },
  exec: { prefix: 'e', label: '执行' },
  reflect: { prefix: 'r', label: '反馈' },
};
const ACTION_TIMEOUT = { plan: 20 * 60 * 1000, exec: 60 * 60 * 1000, reflect: 15 * 60 * 1000 };
const isActiveRun = (run) => !!run && (run.status === 'starting' || run.status === 'running');

/**
 * 同一张卡的写串行化：动作会话「启动中 → running」的回写会和 onFinish 收尾回写并发，
 * 而 store.writeCard 的临时文件名只精确到毫秒，并发 rename 会撞（ENOENT 丢写）。
 * 同一个构思的动作也串行：连点两下不会建出两条并行的记录。
 */
const CARD_QUEUES = new Map();
const IDEA_LOCKS = new Map();
function serialize(map, key, task) {
  const k = String(key || '');
  const prev = map.get(k) || Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  map.set(k, run.catch(() => {}));
  return run;
}
const enqueueCardWrite = (file, task) => serialize(CARD_QUEUES, file, task);
const flushCardWrites = (file) => (CARD_QUEUES.get(String(file || '')) || Promise.resolve()).catch(() => {});
const withIdeaLock = (file, ideaId, task) => serialize(IDEA_LOCKS, `${file}::${ideaId}`, task);

/** 同一个构思是否已有会话在跑（动作会话的 run.nodeId 就是构思 id） */
function activeRunOfIdea(runner, ideaId) {
  if (!runner) return null;
  return runner.list().find((run) => isActiveRun(run) && run.nodeId === ideaId) || null;
}

const reEscape = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 记录节点 id：<ideaId>-p1 / -e1 / -r1，同一动作按已有记录自增，避免重复 id */
function nextRecordId(idea, action, taken) {
  const prefix = ACTIONS[action].prefix;
  const re = new RegExp(`^${reEscape(idea.id)}-${prefix}(\\d+)$`);
  let seq = 0;
  for (const kid of idea.children || []) {
    const hit = re.exec(String(kid?.id || ''));
    if (hit) seq = Math.max(seq, Number(hit[1]));
  }
  let id = `${idea.id}-${prefix}${seq + 1}`;
  while (taken.has(id)) { seq += 1; id = `${idea.id}-${prefix}${seq + 1}`; }
  return id;
}

function collectIds(root) {
  const seen = new Set();
  (function walk(n) { if (!n) return; seen.add(n.id); (n.children || []).forEach(walk); })(root);
  return seen;
}

/** 最近一次带会话的记录（执行 / 手动反馈续用同一会话） */
function lastSessionOf(idea) {
  const records = (idea.children || []).filter((kid) => kid && kid.kind === 'exec' && kid.session && kid.session.id);
  records.sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  return (records[0] && records[0].session.id) || '';
}

/** 创建一条执行记录节点（id 由调用方按全树已用 id 补上） */
function makeRecord(idea, action, sessionId, now) {
  const meta = ACTIONS[action];
  const record = {
    id: '', kind: 'exec', action,
    title: `${meta.label} · ${idea.title || '（未命名构思）'}`,
    status: 'doing', started_at: now, closed_at: null,
    session: { id: sessionId, status: 'starting', started_at: now },
    children: [],
  };
  // exec 记录写计划的第一条验证命令（core 对 exec 的 verify 要求）
  if (action === 'exec') {
    const verify = idea.plan && Array.isArray(idea.plan.verify) ? idea.plan.verify[0] : '';
    if (verify) record.verify = verify;
  }
  return record;
}

function closeRecord(record, now, proof) {
  record.status = 'done';
  record.closed_at = now;
  record.proof = String(proof || '会话完成').slice(0, 300);
}

const firstLine = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';

/* ── 动作 prompt / 斜杠命令：统一由 lib/prompt.mjs 生成（见 docs/prompts.md） ── */

/** 动作会话的合成参数：entry 是注册表条目，card 是刚读到的卡片 */
function promptArgs(entry, card, action, nodeId) {
  return {
    action,
    projectName: entry.name,
    workspace: (card.project && card.project.workspace) || entry.workspace,
    card,
    nodeId,
  };
}

/* ── 计划 markdown 解析：## 目标 / ## 验证命令（bash 代码块）/ ## 步骤（列表项） ── */
function splitPlanSections(doc) {
  const sections = new Map();
  let current = '';
  let buf = [];
  for (const line of String(doc || '').split(/\r?\n/)) {
    const hit = /^#{2,3}\s*(.+?)\s*$/.exec(line);
    if (hit) {
      if (current) sections.set(current, buf.join('\n'));
      current = hit[1].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (current) sections.set(current, buf.join('\n'));
  return sections;
}

function sectionOf(sections, names) {
  for (const [title, body] of sections) {
    if (names.some((name) => title.includes(name))) return body;
  }
  return '';
}

const stripListMark = (line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();

function parsePlanMarkdown(text) {
  const doc = String(text || '').trim();
  const sections = splitPlanSections(doc);

  let goal = '';
  const goalLine = sectionOf(sections, ['目标'])
    .split(/\r?\n/).map((x) => stripListMark(x)).find(Boolean) || '';
  if (goalLine) goal = goalLine.replace(/^[#>*\s]+/, '').slice(0, 300).trim();

  const verifyBody = sectionOf(sections, ['验证命令', '验证']);
  const verify = [];
  for (const block of verifyBody.matchAll(/```(?:bash|sh|shell)?\s*\n?([\s\S]*?)```/gi)) {
    for (const line of block[1].split(/\r?\n/)) {
      const cmd = line.replace(/^\s*\$\s*/, '').trim();
      if (cmd) verify.push(cmd);
    }
  }
  if (!verify.length) {
    for (const line of verifyBody.split(/\r?\n/)) {
      const cmd = stripListMark(line);
      if (cmd && !cmd.startsWith('#') && !cmd.startsWith('```')) verify.push(cmd);
    }
  }

  const steps = [];
  for (const line of sectionOf(sections, ['步骤', '执行步骤']).split(/\r?\n/)) {
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
    const step = stripListMark(line);
    if (step) steps.push(step);
  }

  // 解析不到结构就退化：goal 取首段，其余空数组，不报错
  if (!goal && doc) {
    const first = doc.split(/\n\s*\n/).map((p) => p.trim()).find(Boolean) || '';
    goal = stripListMark(first.replace(/^#+\s*/, '')).slice(0, 300).trim();
  }

  return { goal, verify: verify.slice(0, 20), steps: steps.slice(0, 30), doc };
}

/* ── 反馈提炼解析：接受 {"lessons":[…]} 或数组；每条 ≤200 字、最多 5 条、按 text 去重 ── */
function parseLessons(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let data = null;
  try { data = JSON.parse(body); } catch { /* 再试抠 JSON */ }
  if (data == null) {
    const object = body.match(/\{[\s\S]*\}/);
    const array = body.match(/\[[\s\S]*\]/);
    try {
      if (object) data = JSON.parse(object[0]);
      else if (array) data = JSON.parse(array[0]);
    } catch { data = null; }
  }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.lessons) ? data.lessons : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const value = typeof item === 'string' ? item : (item && (item.text ?? item.lesson)) || '';
    let lesson = String(value).replace(/\s+/g, ' ').trim();
    if (!lesson) continue;
    if (lesson.length > 200) lesson = lesson.slice(0, 200).trim();
    if (seen.has(lesson)) continue;
    seen.add(lesson);
    out.push(lesson);
    if (out.length >= 5) break;
  }
  return out;
}

/** 动作记录写完统一用宽松校验落盘（记录里个别字段残缺不该把整张卡拦下来） */
async function writeActionCard(entry, card) {
  await writeCard(entry, card, { lenient: true });
}

/**
 * 动作会话结束后的回写：
 *   plan done → idea.plan 三块 + 全文，关闭记录；
 *   exec done → 关闭记录（并返回 reflect 标记，由调用方自动起反馈）；
 *   reflect done → loop.lessons 追加 + 关闭记录；
 *   失败 / 取消 → 记录保持打开，只写 session 快照（不写 closed_at）。
 * 返回 { card, idea, record, reflect }；节点找不到时返回 null。
 */
async function applyActionResult(entry, run, snap) {
  return enqueueCardWrite(entry.file, async () => {
    const card = await readCard(entry);
    const idea = findNode(card.loop, run.nodeId);
    const record = run.recordId ? findNode(card.loop, run.recordId) : null;
    if (!idea || !record) return null;
    const now = new Date().toISOString();
    const action = record.action || 'plan';
    record.session = sessionOf(snap);

    let reflect = null;
    if (snap.status === 'done') {
      if (action === 'plan') {
        const parsed = parsePlanMarkdown(run.planText || snap.planText || snap.result);
        idea.plan = { ...parsed, at: now, session: run.sessionId };
        closeRecord(record, now, `计划已生成：${parsed.goal || record.title}`);
      } else if (action === 'exec') {
        if (!record.verify) {
          record.verify = (idea.plan && Array.isArray(idea.plan.verify) && idea.plan.verify[0])
            || idea.acceptance || '按计划执行（计划未列验证命令）';
        }
        closeRecord(record, now, firstLine(snap.result) || '执行会话完成');
        // 执行结束后自动追问一次反馈提炼（同一 sessionId）
        reflect = { ideaId: idea.id, sessionId: run.sessionId };
      } else {
        const lessons = parseLessons(snap.result || run.result);
        const loop = card.loop || {};
        const existing = Array.isArray(loop.lessons) ? loop.lessons : [];
        const seen = new Set(existing.map((x) => (typeof x === 'string' ? x : String(x?.text || '')).trim()));
        const added = [];
        for (const lesson of lessons) {
          if (seen.has(lesson)) continue;
          seen.add(lesson);
          existing.push({ text: lesson, from: `${idea.id}/${record.id}`, at: now });
          added.push(lesson);
        }
        if (existing.length) loop.lessons = existing;
        run.lessonsAdded = added;
        closeRecord(record, now, added.length ? `提炼 ${added.length} 条经验` : '本轮没有新经验（与已有去重后为空）');
      }
    } else {
      // 失败 / 取消：记录保持打开，等下次重跑；只落 session 快照
      record.status = 'doing';
      record.closed_at = null;
      record.session = sessionOf(snap);
    }

    await writeActionCard(entry, card);
    return { card, idea, record, reflect };
  });
}

/**
 * 起一条动作会话：先写记录节点（id 自增），再发命令。
 * 会话起不来时把这根记录撤掉，免得卡片上留一条永远 starting 的记录。
 */
async function startActionSession(runner, entry, card, idea, action, sessionId, override = {}) {
  const now = new Date().toISOString();
  const sid = sessionId || `session-${randomUUID()}`;
  const record = makeRecord(idea, action, sid, now);
  record.id = nextRecordId(idea, action, collectIds(card.loop));
  idea.children = idea.children || [];
  idea.children.push(record);
  await enqueueCardWrite(entry.file, () => writeActionCard(entry, card));

  // 预览里改过就用改后的正文；没改就用统一合成的那份（lib/prompt.mjs）
  const args = promptArgs(entry, card, action, idea.id);
  let run;
  try {
    run = await runner.start({
      project: entry,
      nodeId: idea.id,
      recordId: record.id,
      command: actionCommand({ ...args, prompt: override.prompt, objective: override.objective }),
      fallbackPrompt: actionFallbackPrompt({ ...args, prompt: override.prompt }),
      mode: action === 'plan' ? 'plan' : (action === 'exec' ? 'goal' : 'message'),
      taskId: `action-${action}`,
      sessionId: sid,
      timeoutMs: ACTION_TIMEOUT[action],
    });
  } catch (error) {
    try {
      await enqueueCardWrite(entry.file, async () => {
        const fresh = await readCard(entry);
        const parent = findNode(fresh.loop, idea.id);
        if (!parent) return;
        parent.children = (parent.children || []).filter((kid) => kid.id !== record.id);
        await writeActionCard(entry, fresh);
      });
    } catch { /* 回滚失败不影响主错误 */ }
    throw error;
  }

  // 后台把「启动中」更新成真实状态；记录已 close 或 run 还在回写（settling）就不动，
  // 交给 onFinish 写权威状态，避免拿旧状态覆盖失败/关闭结果
  try {
    await enqueueCardWrite(entry.file, async () => {
      if (run.settling) return;
      const fresh = await readCard(entry);
      const node = findNode(fresh.loop, record.id);
      if (!node || node.closed_at != null) return;
      node.session = {
        ...(node.session || {}),
        status: run.status,
        started_at: run.startedAt || (node.session || {}).started_at,
      };
      await writeActionCard(entry, fresh);
    });
  } catch { /* noop */ }

  return { run, record };
}

/** 面板与接口共用一个 prefix 路由，按 path 分流。 */
const DSH_SESSIONS_DIR = join(DSH_HOME, 'sessions');

/** 「据此填充」的待办：run.key → { file, nodeId, fields } */
const PENDING_FILLS = new Map();

/**
 * 「AI 拆目标」的草稿：面板中途切走/关掉时，会话仍会跑完；
 * 结果落盘到 <registry>/splits/，下次打开面板还能捞回来继续挑。
 */
const SPLIT_TASK = 'split-goals';
const SPLIT_DIR = join(REGISTRY_DIR, 'splits');
const PENDING_SPLITS = new Map();   // run.key → { file, nodeId }
const PENDING_CANDIDATES = new Map();   // run.key → { file, nodeId }（生成候选）
const splitSafe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
const splitPathOf = (file, nodeId) => join(SPLIT_DIR, `${splitSafe(file)}__${splitSafe(nodeId)}.json`);

async function saveSplitDraft(file, nodeId, result) {
  await mkdir(SPLIT_DIR, { recursive: true });
  const payload = { file, nodeId, at: new Date().toISOString(), result: String(result || '') };
  await writeFile(splitPathOf(file, nodeId), JSON.stringify(payload, null, 1) + '\n', 'utf8');
}

async function listSplitDrafts(file) {
  let names = [];
  try { names = await readdir(SPLIT_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const draft = JSON.parse(await readFile(join(SPLIT_DIR, name), 'utf8'));
      if (!draft || !draft.result) continue;
      if (file && draft.file !== file) continue;
      out.push({ file: draft.file, nodeId: draft.nodeId, at: draft.at, result: draft.result });
    } catch { /* 跳过坏文件 */ }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

async function dropSplitDraft(file, nodeId) {
  try { await unlink(splitPathOf(file, nodeId)); } catch { /* 不存在就算了 */ }
}

/**
 * 「服务信息收集」：AI 会话读项目 → JSON 候选 → 落成草稿 → 面板预览探活、
 * 用户确认后才 PUT 写回 rotation.json。草稿也落盘，面板关掉回来还能接着挑。
 * run.key → { file }
 */
const COLLECT_TASK = 'collect-services';
const SERVICE_DRAFT_DIR = join(REGISTRY_DIR, 'services');
const PENDING_SERVICES = new Map();
const serviceDraftPath = (file) => join(SERVICE_DRAFT_DIR, `${splitSafe(file || 'project')}.json`);

async function saveServiceDraft(file, draft) {
  await mkdir(SERVICE_DRAFT_DIR, { recursive: true });
  const payload = { file, at: new Date().toISOString(), ...draft };
  await writeFile(serviceDraftPath(file), JSON.stringify(payload, null, 1) + '\n', 'utf8');
  return payload;
}

async function readServiceDraft(file) {
  try { return JSON.parse(await readFile(serviceDraftPath(file), 'utf8')); } catch { return null; }
}

async function dropServiceDraft(file) {
  try { await unlink(serviceDraftPath(file)); } catch { /* 不存在就算了 */ }
}

/** 模型输出 → 合法 services（数组、对象包 services 都认；不合法的条目直接丢） */
function parseCollectedServices(resultText) {
  const data = extractJson(resultText);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.services) ? data.services : []);
  return normalizeServices(list);
}

/**
 * 每种节点「允许补全」的字段：标题是唯一必需项，其余空着就可生成。
 * 顺序即 prompt 里的顺序；title 只在标题为空/占位时才补。
 */
const FILLABLE_BY_KIND = {
  loop: ['title', 'intent', 'scenario', 'constraints', 'acceptance'],
  goal: ['title', 'constraints', 'acceptance'],
  idea: ['title'],
  exec: ['title', 'verify'],
};
// 执行记录（计划 / 执行 / 反馈）是会话日志，不参与「按标题生成补齐」：只留标题与只读信息
const FIELDS_OF = (node) => (node && node.action ? [] : (FILLABLE_BY_KIND[node.kind] || []));
const isBlankTitle = (value) => {
  const s = String(value || '').trim();
  // 空串、手工新建的占位标题（新目标（待命名））、或直接以待命名/未命名开头，都算没有标题
  return !s || /^(待命名|未命名)/.test(s) || /[（(]待命名[)）]/.test(s);
};
const isBlankField = (node, field) => (field === 'title' ? isBlankTitle(node.title) : !String(node[field] || '').trim());
const blankFieldsOf = (node) => FIELDS_OF(node).filter((f) => isBlankField(node, f));

/** 从模型输出里抠出 JSON 对象 */
const FIELD_MAX = 300;

/** 按字数上限截断：优先在句号/分号/换行处断开，避免半句话 */
function capText(text, limit = FIELD_MAX) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('\n'), head.lastIndexOf(';'));
  return (cut > limit * 0.5 ? head.slice(0, cut + 1) : head).trim();
}

function extractJsonArray(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (raw.match(/\[[\s\S]*\]/) || [])[0];
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : (raw.match(/\{[\s\S]*\}/) || [])[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

/** 会话结束后把结果写进卡片（与面板是否还开着无关） */
async function applyFillResult(entry, nodeId, resultText) {
  const card = await readCard(entry);
  const node = findNode(card.loop, nodeId);
  if (!node) throw new Error(`找不到节点 ${nodeId}`);
  const patch = extractJson(resultText);
  if (!patch) throw new Error('模型没有返回可解析的 JSON');
  const applied = [];
  for (const field of blankFieldsOf(node)) {
    const value = patch[field] == null ? '' : String(patch[field]).trim();
    if (!value) continue;
    const capped = capText(value, field === 'title' ? 40 : FIELD_MAX);
    if (field === 'title') node.title = capped;
    else node[field] = capped;
    applied.push(field);
  }
  if (!applied.length) throw new Error('没有可回填的内容');
  await writeCard(entry, card, { lenient: true });
  return applied;
}

/* ─────────── 候选池（子节点候选） ─────────── */
const CAND_DIR = join(DSH_HOME, 'rotation', 'candidates');
const CHILD_KIND = { loop: 'goal', goal: 'idea', idea: 'exec' };
/**
 * 一个目标只能有一个构思：采纳第一条后该目标锁定，之后「生成候选 / 采纳」都在这里被拦。
 * 候选池里仍然可以有 3 条互斥备选——它们是同一个构思槽位的对比，不是多个构思。
 */
const ideaChildrenOf = (node) => (node && Array.isArray(node.children) ? node.children : []).filter((k) => k && k.kind === 'idea');
const ideaLockMessage = (node) => {
  const first = ideaChildrenOf(node)[0];
  const name = (first && (first.title || first.id)) || '未命名构思';
  return `该目标已有构思「${name}」，一个目标只能有一个构思`;
};
/** goal id → 构思子节点数；PUT 时比对新旧卡片，拦「给目标加第二个构思」 */
function ideaCountsByGoal(loop) {
  const out = new Map();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'goal') out.set(n.id, ideaChildrenOf(n).length);
    (Array.isArray(n.children) ? n.children : []).forEach(walk);
  };
  walk(loop);
  return out;
}
const candFile = (file, nodeId) => join(CAND_DIR, `${String(file).replace(/[^\w.-]/g, '_')}__${String(nodeId)}.json`);

async function readCandidates(file, nodeId) {
  try { return JSON.parse(await readFile(candFile(file, nodeId), 'utf8')); } catch { return []; }
}
async function writeCandidates(file, nodeId, list) {
  await mkdir(CAND_DIR, { recursive: true });
  await writeFile(candFile(file, nodeId), JSON.stringify(list, null, 1) + '\n', 'utf8');
  return list;
}

/** 一次返回整个项目所有节点的候选条数：面板渲染节点卡时用它，避免每节点一个请求 */
async function readCandidateCounts(file) {
  const counts = {};
  const prefix = `${String(file).replace(/[^\w.-]/g, '_')}__`;
  let names = [];
  try { names = await readdir(CAND_DIR); } catch { return counts; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const nodeId = name.slice(prefix.length, -'.json'.length);
    try {
      const list = JSON.parse(await readFile(join(CAND_DIR, name), 'utf8'));
      if (Array.isArray(list) && list.length) counts[nodeId] = list.length;
    } catch {}
  }
  return counts;
}

/** 工作区编码：/Users/a/b → --Users-a-b--（与 DSH 落盘目录一致，找不到时再扫一遍） */
function workspaceDirNames(workspace) {
  const flat = String(workspace || '').replace(/\/+$/, '').replace(/\//g, '-');
  return [`-${flat}-`, `--${flat.replace(/^-/, '')}--`];
}

/** 列出某工作区最近的会话（按目录 mtime 倒序，最多 20 条） */
async function listWorkspaceSessions(workspace) {
  const root = DSH_SESSIONS_DIR;
  let dirs = [];
  try { dirs = await readdir(root); } catch { return []; }
  let target = '';
  for (const guess of workspaceDirNames(workspace)) {
    if (dirs.includes(guess)) { target = guess; break; }
  }
  if (!target) {
    // 兜底：找名字里包含工作区末段目录名的那个
    const tail = String(workspace || '').split('/').filter(Boolean).pop() || '';
    target = dirs.find((d) => tail && d.includes(tail)) || '';
  }
  if (!target) return [];
  const base = join(root, target);
  const names = await readdir(base);
  const items = [];
  for (const name of names) {
    if (!/^session-[A-Za-z0-9-]+$/.test(name)) continue;
    try {
      const info = await stat(join(base, name));
      items.push({ id: name, mtime: info.mtimeMs });
    } catch { /* skip */ }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, 20).map((x) => ({ id: x.id, updatedAt: new Date(x.mtime).toISOString() }));
}

/** 读 DSH 落盘的会话全文：~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd */
async function readSessionTranscript(sessionId) {
  const root = join(DSH_SESSIONS_DIR);
  let dirs = [];
  try { dirs = await readdir(root); } catch (error) { throw new Error('读不到 sessions 目录：' + error.message); }
  let found = '';
  for (const name of dirs) {
    const candidate = join(root, name, sessionId);
    try { const files = await readdir(candidate); if (files.length) { found = candidate; break; } } catch { /* not here */ }
  }
  if (!found) throw new Error('找不到会话文件：' + sessionId);
  const target = join(found, 'session.v4.jsonl.zstd');
  let text = '';
  try {
    const buf = await readFileRaw(target);
    const zlib = await import('node:zlib');
    if (typeof zlib.zstdDecompressSync === 'function') text = zlib.zstdDecompressSync(buf).toString('utf8');
  } catch { /* 交给 zstd CLI 兜底 */ }
  // 追加写会产生多个 zstd frame，node 只解第一帧：行数不足时改用 zstd CLI
  const lineCount = (value) => value.split('\n').filter((x) => x.trim()).length;
  if (lineCount(text) < 2) {
    try {
      text = await new Promise((resolve, reject) => {
        const child = spawn('zstd', ['-dc', target]);
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('zstd 解压失败'))));
      });
    } catch (error) {
      throw new Error(
        '这个会话是多帧 zstd 写入的，需要本机有 zstd 才能解压'
        + '（macOS: brew install zstd · Windows: winget install zstd · Linux: apt install zstd）。'
        + `原始错误：${error.message}`,
      );
    }
  }
  const entries = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    const type = event.type || '';
    const at = event.at || event.timestamp || event.createdAt || null;
    const blocks = (event.data && (event.data.content || (event.data.message && event.data.message.content))) || event.content || [];
    const textOf = (list) => (Array.isArray(list) ? list : [])
      .filter((b) => b && (b.type === 'text' ? typeof b.text === 'string' : false))
      .map((b) => b.text).join('\n').trim();
    if (type === 'user/message') {
      const t = textOf(blocks);
      if (t) entries.push({ kind: 'user', role: '你', text: t, at });
    } else if (type === 'assistant/message') {
      const t = textOf(blocks);
      if (t) entries.push({ kind: 'assistant', role: '模型', text: t, at });
    } else if (type === 'tool/call') {
      const name = (event.data && (event.data.name || event.data.tool)) || 'tool';
      const input = event.data && (event.data.input || event.data.arguments);
      entries.push({ kind: 'tool', role: String(name), text: typeof input === 'string' ? input : JSON.stringify(input || {}, null, 1).slice(0, 1200), at });
    } else if (type === 'tool/result') {
      const out = event.data && (event.data.output || event.data.result || event.data.content);
      const t = typeof out === 'string' ? out : JSON.stringify(out || '', null, 1);
      entries.push({ kind: 'tool-result', role: '结果', text: String(t).slice(0, 4000), at });
    } else if (type === 'turn/end') {
      const reason = (event.data && event.data.reason) || {};
      entries.push({ kind: 'turn-end', role: '回合', text: reason.kind || 'end', at });
    }
  }
  return { id: sessionId, dir: found, entries, bytes: text.length };
}

/**
 * 动作会话的统一入口（/action/plan|exec|reflect）：
 * 找构思 → 409 检查（已有会话 / 缺计划）→ 建记录 + 起会话。
 */
async function runAction(runner, action, req, res) {
  if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
  let body;
  try { body = await readJsonBody(req); }
  catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败: ' + error.message }); }
  const file = body.file || body.id;
  const ideaId = body.nodeId;
  if (!ideaId) return sendJson(res, 400, { ok: false, error: '缺 nodeId' });
  const entry = await findProject(file);
  if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file || ''}` });
  // 同一个构思的动作串行处理：连点两下不会建出两条并行记录
  return withIdeaLock(entry.file, ideaId, async () => {
    // 上一轮动作可能还在回写（run.settling）：等它落盘再读，否则会读到「计划还没写进去」的旧卡
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 30; i += 1) {
      if (!runner.list().some((run) => run.nodeId === ideaId && run.settling)) break;
      await sleep(100);
    }
    await flushCardWrites(entry.file);
    const card = await readCard(entry);
    const idea = findNode(card.loop, ideaId);
    if (!idea) {
      return sendJson(res, 409, {
        ok: false, code: 'NODE_NOT_FOUND',
        error: `找不到节点：${ideaId}（面板数据与磁盘不一致，请刷新）`,
      });
    }
    if (idea.kind !== 'idea') return sendJson(res, 400, { ok: false, error: '只有构思节点能发起动作' });

    const active = activeRunOfIdea(runner, ideaId);
    if (active) {
      return sendJson(res, 409, {
        ok: false, code: 'RUN_ACTIVE',
        error: `这个构思已有会话在跑（${active.status}），先等它结束`,
        run: active,
      });
    }
    if (action === 'exec' && !idea.plan) {
      return sendJson(res, 409, { ok: false, code: 'PLAN_MISSING', error: '这个构思还没有计划，先生成计划' });
    }
    // 位置并发：上游节点正在会话时，子节点不允许再发起（沿用旧规则）
    const blockedBy = runningAncestorOf(runner, card, ideaId);
    if (blockedBy) {
      const owner = findNode(card.loop, blockedBy.nodeId);
      return sendJson(res, 409, {
        ok: false,
        error: `上游节点「${(owner && owner.title) || blockedBy.nodeId}」正在生成，先等它结束`,
        blockedBy: blockedBy.nodeId,
      });
    }

    // 会话选择：计划每轮开新会话；执行 / 反馈续用同一会话
    let sessionId = '';
    if (action === 'exec') sessionId = (idea.plan && idea.plan.session) || lastSessionOf(idea);
    else if (action === 'reflect') sessionId = lastSessionOf(idea);

    // 面板「发送预览」里改过的正文 / 目标（没改就留空，用统一合成的那份）
    const override = {
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      objective: typeof body.objective === 'string' ? body.objective : '',
    };

    try {
      const { run, record } = await startActionSession(runner, entry, card, idea, action, sessionId, override);
      return sendJson(res, 200, { ok: true, run, record });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message });
    }
  });
}

function createHandler(base, runner, services) {
  return async function rotationHandler(req, res) {
    let pathname;
    let query;
    try {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      pathname = decodeURIComponent(parsed.pathname);
      query = parsed.searchParams;
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' });
    }

    const api = `${base}/api`;

    if (req.method === 'OPTIONS' && (pathname === api || pathname.startsWith(`${api}/`))) {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (pathname === `${api}/health`) {
      return sendJson(res, 200, {
        ok: true, name, version: VERSION, base, web: WEB,
        registry: REGISTRY_PATH, time: new Date().toISOString(),
        server: { port: SERVER_INFO.port, argvPort: argvPort(), keys: SERVER_INFO.keys, address: SERVER_INFO.address },
      });
    }

    // ── 项目注册表 ──
    if (pathname === `${api}/projects` && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, registry: REGISTRY_PATH, projects: await listProjects() });
    }
    if (pathname === `${api}/projects` && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const entry = await addProject(body || {});
        return sendJson(res, 200, { ok: true, project: entry });
      } catch (error) {
        return sendJson(res, error.status || 400, { ok: false, error: error.message });
      }
    }

    if (pathname.startsWith(`${api}/projects/`) && req.method === 'DELETE') {
      const key = decodeURIComponent(pathname.slice(`${api}/projects/`.length));
      try {
        const removed = await removeProject(key);
        return sendJson(res, 200, { ok: true, removed, note: '只取消登记，项目里的 .dsh/rotation.json 未删除' });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
    }

    // ── 卡片 ──
    if (pathname === `${api}/cards` && req.method === 'GET') {
      const cards = await readAllCards();
      return sendJson(res, 200, { ok: true, cards });
    }
    if (pathname.startsWith(`${api}/cards/`) && req.method === 'PUT') {
      const key = decodeURIComponent(pathname.slice(`${api}/cards/`.length));
      const entry = await findProject(key);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${key}` });
      let payload;
      try { payload = await readJsonBody(req); }
      catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败: ' + error.message }); }
      const card = payload && payload.card ? payload.card : payload;
      // 一个目标一个构思：只拦「新增第二个构思」；旧卡里已经有多条的仍可保存，跑迁移脚本清理
      try {
        const before = ideaCountsByGoal((await readCard(entry)).loop);
        for (const [goalId, count] of ideaCountsByGoal(card.loop)) {
          if (count <= 1) continue;
          if (count > Math.max(before.get(goalId) || 0, 1)) {
            return sendJson(res, 422, {
              ok: false, code: 'IDEA_EXISTS',
              error: `目标「${goalId}」只能有一个构思（这次要写入 ${count} 个）`,
            });
          }
        }
      } catch { /* 读不到旧卡（首次写入）就不拦，交给卡片校验 */ }
      try {
        // 面板的渐进填写默认宽松：缺验收/验证/证据 只给警告，仍可落盘
        const lenient = payload.allowIncomplete !== false;
        const { warnings, stats } = await writeCard(entry, card, { lenient });
        return sendJson(res, 200, { ok: true, id: entry.id, file: entry.file, updated: card.updated, warnings, stats });
      } catch (error) {
        return sendJson(res, error.status || 500, {
          ok: false, error: error.message, errors: error.errors, warnings: error.warnings,
        });
      }
    }

    // ── 某项目的最近会话列表（磁盘上的 DSH 会话）──
    if (pathname === `${api}/sessions` && req.method === 'GET') {
      const key = query.get('file') || query.get('id') || '';
      const entry = key ? await findProject(key) : null;
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${key}` });
      try {
        return sendJson(res, 200, { ok: true, sessions: await listWorkspaceSessions(entry.workspace) });
      } catch (error) {
        return sendJson(res, 200, { ok: false, sessions: [], error: error.message });
      }
    }

    // ── 会话全文（面板里「查看会话」用）──
    if (pathname === `${api}/session` && req.method === 'GET') {
      const id = query.get('id') || '';
      if (!/^session-[A-Za-z0-9-]{8,}$/.test(id)) return sendJson(res, 400, { ok: false, error: '会话 id 不合法' });
      try {
        return sendJson(res, 200, { ok: true, session: await readSessionTranscript(id) });
      } catch (error) {
        return sendJson(res, 404, { ok: false, error: error.message });
      }
    }

    // ── DSH 工作区列表（添加项目时直接选）──
    if (pathname === `${api}/workspaces` && req.method === 'GET') {
      try {
        const all = await listDshWorkspaces();
        const registered = new Set((await listProjects()).map((p) => p.workspace));
        const available = all.filter((w) => !registered.has(w.path));
        return sendJson(res, 200, {
          ok: true,
          workspaces: available,
          total: all.length,
          registeredCount: all.length - available.length,
        });
      } catch (error) {
        return sendJson(res, 500, { ok: false, workspaces: [], error: error.message });
      }
    }

    // ── 目录选择（添加项目用；面板在桌面外壳里会优先用宿主自带的 picker）──
    if (pathname === `${api}/pick-directory` && req.method === 'POST') {
      if (process.platform !== 'darwin') {
        return sendJson(res, 501, { ok: false, error: '原生目录选择仅支持 macOS' });
      }
      const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.on('error', (error) => sendJson(res, 500, { ok: false, error: error.message }));
      child.on('exit', (code) => {
        const picked = out.trim().replace(/\/$/, '');
        if (code === 0 && picked) return sendJson(res, 200, { ok: true, path: picked });
        return sendJson(res, 400, { ok: false, error: code === 0 ? '已取消' : '选择失败' });
      });
      return;
    }

    // ── 项目服务（M3）──
    if (pathname === `${api}/services` && req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = await findProject(url.searchParams.get('file') || '');
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      try {
        const card = await readCard(entry);
        const list = await services.list(entry.id, card, entry.workspace, process.platform);
        return sendJson(res, 200, {
          ok: true, services: list,
          platform: { id: process.platform, label: platformLabel(process.platform) },
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }

    // ── 服务信息收集：AI 会话读项目 → 草稿 → 面板预览探活 → 确认后写回 ──
    if (pathname === `${api}/services/collect` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const entry = await findProject(body.file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${body.file || body.id}` });
      // 并发口径：不同项目可以同时收集（草稿 / 卡片各写各的）；同一项目仍串行。
      // 全局仍受 ROTATION_MAX_CONCURRENT（默认 3）限制，与 /api/run 同一口径。
      const file = entry.file || entry.id;
      const sameProject = runner.list().find((r) => isActiveRun(r) && r.file === file && PENDING_SERVICES.has(r.key));
      if (sameProject) {
        return sendJson(res, 409, { ok: false, error: `「${entry.name}」正在收集服务信息，先等它结束` });
      }
      const active = runner.list().filter(isActiveRun).length;
      if (active >= MAX_CONCURRENT) {
        return sendJson(res, 429, { ok: false, error: `并发已达上限 ${MAX_CONCURRENT}（有会话在跑），先等一个结束` });
      }
      let card;
      try { card = await readCard(entry); }
      catch (error) { return sendJson(res, 400, { ok: false, error: `读卡片失败：${error.message}` }); }
      const prompt = composeCollectServicesPrompt({
        projectName: entry.name,
        workspace: entry.workspace,
        platform: process.platform,
        existing: Array.isArray(card.services) ? card.services : [],
      });
      try {
        const run = await runner.start({ project: entry, nodeId: 'services-collect', prompt, taskId: COLLECT_TASK });
        PENDING_SERVICES.set(run.key, { file: entry.file || entry.id });
        return sendJson(res, 200, { ok: true, run });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
    }
    if (pathname === `${api}/services/collect` && req.method === 'GET') {
      const file = query.get('file') || '';
      if (!file) return sendJson(res, 400, { ok: false, error: '缺 file' });
      return sendJson(res, 200, { ok: true, draft: await readServiceDraft(file) });
    }
    if (pathname === `${api}/services/probe` && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const target = joinHealth(String(body.url || '').trim(), String(body.health || '').trim());
      if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { ok: false, error: 'url 必须是 http(s) 地址' });
      return sendJson(res, 200, { ok: true, probe: await probe(target) });
    }
    // 写回：只替换 services 字段；校验不过 422、原子写、不留 .bak（store.writeCard）
    if (pathname === `${api}/services` && req.method === 'PUT') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      if (!Array.isArray(body.services)) return sendJson(res, 400, { ok: false, error: 'services 必须是数组（清空就传 []）' });
      const entry = await findProject(body.file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${body.file || body.id}` });
      const normalized = normalizeServices(body.services);
      try {
        await enqueueCardWrite(entry.file || entry.id, async () => {
          const card = await readCard(entry);
          if (normalized.length) card.services = normalized;
          else delete card.services;
          await writeCard(entry, card, { lenient: true });
        });
        await dropServiceDraft(entry.file || entry.id);
        return sendJson(res, 200, { ok: true, services: normalized, platform: { id: process.platform, label: platformLabel(process.platform) } });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message, errors: error.errors });
      }
    }
    if (pathname === `${api}/service/start` && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const entry = await findProject(body.file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      const card = await readCard(entry);
      const result = services.start(entry.id, card, body.id || body.serviceId, entry.workspace);
      return sendJson(res, result.ok ? 200 : result.status || 400, result);
    }
    if (pathname === `${api}/service/stop` && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const entry = await findProject(body.file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      const result = services.stop(entry.id, body.id || body.serviceId);
      return sendJson(res, result.ok ? 200 : result.status || 400, result);
    }

    // ── 节点会话（M2）──
    if (pathname === `${api}/run-config` && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true, token: 'in-process', maxConcurrent: MAX_CONCURRENT,
        timeoutMs: 15 * 60 * 1000, hasApiKey: true, runner: 'agents',
      });
    }
    if (pathname === `${api}/runs` && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, runs: runner ? runner.list() : [] });
    }
    // ── 动作会话：生成计划 / 执行计划 / 反馈提炼（构思卡上的两个手动动作 + 自动反馈）──
    if (pathname === `${api}/action/plan` && req.method === 'POST') return runAction(runner, 'plan', req, res);
    if (pathname === `${api}/action/exec` && req.method === 'POST') return runAction(runner, 'exec', req, res);
    if (pathname === `${api}/action/reflect` && req.method === 'POST') return runAction(runner, 'reflect', req, res);
    // ── 据此填充：host 侧起会话并在结束时自动写卡片（关掉面板也不影响）──
    // ── 候选池 ──
    if (pathname === `${api}/candidates` && req.method === 'GET') {
      const file = query.get('file') || '', nodeId = query.get('nodeId') || '';
      if (!file || !nodeId) return sendJson(res, 400, { ok: false, error: '缺 file / nodeId' });
      return sendJson(res, 200, { ok: true, candidates: await readCandidates(file, nodeId) });
    }

    if (pathname === `${api}/candidates/counts` && req.method === 'GET') {
      const file = query.get('file') || '';
      if (!file) return sendJson(res, 400, { ok: false, error: '缺 file' });
      return sendJson(res, 200, { ok: true, counts: await readCandidateCounts(file) });
    }

    if (pathname === `${api}/candidates/generate` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body; try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, count } = body || {};
      const entry = await findProject(file || body?.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file}` });
      const card = await readCard(entry);
      const node = findNode(card.loop, nodeId);
      if (!node) return sendJson(res, 404, { ok: false, error: `找不到节点：${nodeId}`, code: 'NODE_NOT_FOUND' });
      if (!CHILD_KIND[node.kind]) return sendJson(res, 400, { ok: false, error: '这个节点不能再往下拆' });
      if (node.kind === 'goal' && ideaChildrenOf(node).length) {
        return sendJson(res, 409, { ok: false, code: 'IDEA_EXISTS', error: ideaLockMessage(node) });
      }
      const existing = await readCandidates(entry.file, nodeId);
      if (existing.length) return sendJson(res, 409, { ok: false, error: '候选池还有未处理的候选，先处理掉' });
      const blockedBy = runningAncestorOf(runner, card, nodeId);
      if (blockedBy) return sendJson(res, 409, { ok: false, error: `上游节点「${(findNode(card.loop, blockedBy.nodeId) || {}).title || blockedBy.nodeId}」正在生成，先等它结束` });
      const n = Math.min(Math.max(Number(count) || 3, 1), 6);
      const prompt = composeCandidatePrompt({
        projectName: entry.name,
        workspace: (card.project && card.project.workspace) || entry.workspace,
        card,
        nodeId,
        count: n,
      });
      const key = `${entry.file || entry.id}::${nodeId}`;
      PENDING_CANDIDATES.set(key, { file: entry.file, nodeId });
      try {
        const run = await runner.start({ project: entry, nodeId, prompt, taskId: 'candidates' });
        return sendJson(res, 200, { ok: true, run, want: n });
      } catch (error) {
        PENDING_CANDIDATES.delete(key);
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
    }

    if (pathname === `${api}/candidates/adopt` && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, index } = body || {};
      const entry = await findProject(file || body?.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      const card = await readCard(entry);
      const node = findNode(card.loop, nodeId);
      if (!node) return sendJson(res, 404, { ok: false, error: '找不到节点', code: 'NODE_NOT_FOUND' });
      if (node.kind === 'goal' && ideaChildrenOf(node).length) {
        return sendJson(res, 409, { ok: false, code: 'IDEA_EXISTS', error: ideaLockMessage(node) });
      }
      const pool = await readCandidates(entry.file, nodeId);
      const cand = pool[Number(index)];
      if (!cand) return sendJson(res, 404, { ok: false, error: '候选不存在' });
      const childKind = CHILD_KIND[node.kind];
      const taken = new Set();
      const collect = (x) => { taken.add(x.id); (x.children || []).forEach(collect); };
      collect(card.loop);
      let base = String(nodeId + '-c' + (Number(index) + 1)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      let id = base, i = 1;
      while (taken.has(id)) { id = `${base}-${i++}`; }
      node.children = node.children || [];
      node.children.push({ id, kind: childKind, title: cand.title || '（未命名）', ...(cand.acceptance ? { acceptance: cand.acceptance } : {}), status: 'plan', closed_at: null, children: [] });
      await writeCard(entry, card, { lenient: true });
      // 采纳即锁定：目标拿到唯一构思，候选池里其余备选一并清掉（一个目标一个构思）
      const locked = node.kind === 'goal';
      const rest = locked ? [] : pool.filter((_, k) => k !== Number(index));
      await writeCandidates(entry.file, nodeId, rest);
      return sendJson(res, 200, { ok: true, child: { id, title: cand.title }, remaining: rest.length, locked });
    }

    if (pathname === `${api}/candidates/delete` && req.method === 'POST') {
      let body; try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, index, all } = body || {};
      const entry = await findProject(file || body?.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      const pool = await readCandidates(entry.file, nodeId);
      const next = all ? [] : pool.filter((_, k) => k !== Number(index));
      await writeCandidates(entry.file, nodeId, next);
      return sendJson(res, 200, { ok: true, candidates: next });
    }

    if (pathname === `${api}/fill` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId } = body || {};
      if (!nodeId) return sendJson(res, 400, { ok: false, error: '缺 nodeId' });
      const entry = await findProject(file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file || body.id}` });
      const card = await readCard(entry);
      const node = findNode(card.loop, nodeId);
      if (!node) return sendJson(res, 409, { ok: false, code: 'NODE_NOT_FOUND', error: `找不到节点：${nodeId}（面板数据与磁盘不一致，请刷新）` });
      const blockedByFill = runningAncestorOf(runner, card, nodeId);
      if (blockedByFill) {
        const owner = findNode(card.loop, blockedByFill.nodeId);
        return sendJson(res, 409, {
          ok: false,
          error: `上游节点「${(owner && owner.title) || blockedByFill.nodeId}」正在生成，先等它结束`,
          blockedBy: blockedByFill.nodeId,
        });
      }
      const fields = blankFieldsOf(node);
      if (!fields.length) return sendJson(res, 400, { ok: false, error: '没有缺失项' });
      const prompt = composeFillPrompt({
        projectName: entry.name,
        workspace: (card.project && card.project.workspace) || entry.workspace,
        card,
        nodeId,
        fields,
      });
      const key = `${entry.file || entry.id}::${nodeId}`;
      PENDING_FILLS.set(key, { file: entry.file, nodeId, fields });
      try {
        const run = await runner.start({ project: entry, nodeId, prompt, taskId: 'fill' });
        return sendJson(res, 200, { ok: true, run, fields });
      } catch (error) {
        PENDING_FILLS.delete(key);
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
    }

    // ── prompt 合成（面板「查看 / 变更 / 发送」都用这一份，见 lib/prompt.mjs）──
    // GET ?file&nodeId             → 详情卡模板列表（from + list[prompt/summary/warnings]）
    // GET ?file&nodeId&action=plan → 动作预览正文；action=exec → 单行目标 + 退回正文
    if (pathname === `${api}/prompts` && req.method === 'GET') {
      const file = query.get('file') || '';
      const nodeId = query.get('nodeId') || '';
      const action = query.get('action') || '';
      if (!nodeId) return sendJson(res, 400, { ok: false, error: '缺 nodeId' });
      const entry = await findProject(file);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file}` });
      let card;
      try { card = await readCard(entry); }
      catch (error) { return sendJson(res, 404, { ok: false, error: `读卡片失败：${error.message}` }); }
      try {
        if (action) {
          const args = {
            action,
            projectName: entry.name,
            workspace: (card.project && card.project.workspace) || entry.workspace,
            card,
            nodeId,
          };
          const prompt = composeActionPrompt(args);
          const list = [{
            id: action,
            title: { plan: '生成计划', exec: '执行计划', reflect: '反馈提炼' }[action] || action,
            summary: firstLine(prompt),
            prompt,
            warnings: lintPrompt(prompt).warnings,
          }];
          return sendJson(res, 200, {
            ok: true,
            from: '内置',
            list,
            // 命令层面真正发出去的东西：/plan 的正文，或 /goal 的单行目标
            command: actionCommand({ ...args }),
            objective: action === 'exec' ? composeGoalObjective(args) : '',
            fallback: action === 'exec' ? actionFallbackPrompt(args) : '',
          });
        }
        return sendJson(res, 200, { ok: true, ...listTaskPrompts({ projectName: entry.name, card, nodeId }) });
      } catch (error) {
        return sendJson(res, error.code === 'NODE_NOT_FOUND' ? 409 : 400, { ok: false, error: error.message, code: error.code || '' });
      }
    }

    if (pathname === `${api}/run` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, prompt, taskId } = body || {};
      if (!nodeId) return sendJson(res, 400, { ok: false, error: '缺 nodeId' });
      const entry = await findProject(file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file || body.id}` });
      // 位置并发：上游节点正在会话时，子节点不允许再发起（不是数量限制）
      const card = await readCard(entry);
      // 面板没带 prompt（没改过）就在这里合成：拆目标 / 拆构思 / 候选 / 补全 / 详情模板都只有一份实现
      let text = typeof prompt === 'string' ? prompt.trim() : '';
      if (!text) {
        const args = {
          projectName: entry.name,
          workspace: (card.project && card.project.workspace) || entry.workspace,
          card,
          nodeId,
        };
        try {
          if (taskId === SPLIT_TASK) text = composeSplitPrompt(args);
          else if (taskId === 'split-ideas') text = composeIdeaPrompt(args);
          else if (taskId === 'candidates') text = composeCandidatePrompt(args);
          else if (taskId === 'fill') text = composeFillPrompt({ ...args, fields: blankFieldsOf(findNode(card.loop, nodeId) || {}) });
          else text = composeTaskPrompt({ ...args, taskId });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message, code: error.code || '' });
        }
      }
      if (!text) return sendJson(res, 400, { ok: false, error: '这个节点没有可用的 prompt 模板' });
      const blockedBy = runningAncestorOf(runner, card, nodeId);
      if (blockedBy) {
        const owner = findNode(card.loop, blockedBy.nodeId);
        return sendJson(res, 409, {
          ok: false,
          error: `上游节点「${(owner && owner.title) || blockedBy.nodeId}」正在生成，先等它结束`,
          blockedBy: blockedBy.nodeId,
        });
      }
      const active = runner.list().filter((r) => r.status === 'starting' || r.status === 'running').length;
      if (active >= MAX_CONCURRENT) return sendJson(res, 429, { ok: false, error: `并发已达上限 ${MAX_CONCURRENT}` });
      try {
        const run = await runner.start({
          project: entry, nodeId, prompt: text, taskId,
          // 模板会话（给出执行步骤 / 补齐证据 / 定位阻塞 / 拆目标 …）要读仓库：
          // 不挂 preset 就没有 bash / read / write，模型只能凭记忆编（2026-10-29 定位）
          mountPreset: true,
        });
        // 拆目标这类「结果要先给人看」的任务：登记 pending，结束后落盘成草稿
        if (taskId === SPLIT_TASK) {
          PENDING_SPLITS.set(`${entry.file || entry.id}::${nodeId}`, { file: entry.file || entry.id, nodeId });
        }
        return sendJson(res, 200, { ok: true, run });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
    }

    // ── AI 拆目标的草稿：面板切走/关掉后还能捞回上次结果 ──
    if (pathname === `${api}/splits` && req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = url.searchParams.get('file') || '';
      return sendJson(res, 200, { ok: true, drafts: await listSplitDrafts(file) });
    }
    if (pathname === `${api}/splits` && req.method === 'DELETE') {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = {};
      try { body = await readJsonBody(req); } catch { /* 允许只用 query */ }
      const file = url.searchParams.get('file') || body.file;
      const nodeId = url.searchParams.get('nodeId') || body.nodeId;
      if (!file || !nodeId) return sendJson(res, 400, { ok: false, error: '缺 file / nodeId' });
      await dropSplitDraft(file, nodeId);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === `${api}/run/cancel` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const entry = await findProject(body.file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: '找不到项目' });
      const run = runner.cancel(entry, body.nodeId);
      if (!run) return sendJson(res, 404, { ok: false, error: '没有该运行' });
      // 动作会话写到记录节点（run.recordId），普通会话仍写节点本身
      await persistSession(entry, run).catch(() => {});
      return sendJson(res, 200, { ok: true, run });
    }

    if (pathname === api || pathname.startsWith(`${api}/`)) {
      return sendJson(res, 501, { ok: false, error: `not implemented yet: ${pathname}` });
    }

    if (pathname === base || pathname === `${base}/`) {
      res.writeHead(302, { location: `${base}/app/` });
      return res.end();
    }

    if (pathname.startsWith(`${base}/app`)) {
      const rel = pathname.slice(`${base}/app`.length) || '/';
      return serveStatic(res, rel, req, base);
    }

    return sendJson(res, 404, { ok: false, error: 'not found', pathname });
  };
}

/**
 * @param {import('@deepseek-ai/dsh-loader').Context} ctx
 * @param {{ basePath?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const base = String(config.basePath || '/rotation').replace(/\/+$/, '') || '/rotation';
  try {
    SERVER_INFO.port = detectServerPort(ctx);
    SERVER_INFO.keys = Object.keys(ctx?.webServer || {});
    SERVER_INFO.address = typeof ctx?.webServer?.address === 'function' ? ctx.webServer.address() : null;
  } catch { /* noop */ }

  let runner = null;
  try {
    runner = createRunner(ctx, {
      provider: config.provider,
      model: config.model,
      onFinish: async (run, snap) => {
        const entry = await findProject(run.projectId);
        if (!entry) return;
        const pending = PENDING_FILLS.get(run.key);
        if (pending && snap.status === 'done') {
          try {
            const applied = await applyFillResult(entry, pending.nodeId, snap.result);
            run.fillApplied = applied;
            ctx.logger?.info?.(`[rotation] fill applied: ${applied.join(', ')}`);
          } catch (error) {
            run.fillError = error.message;
            ctx.logger?.warn?.('[rotation] fill apply failed: ' + error.message);
          }
        }
        PENDING_FILLS.delete(run.key);

        // 生成候选：跑完把候选写进候选池文件
        const pendCand = PENDING_CANDIDATES.get(run.key);
        if (pendCand && snap.status === 'done') {
          try {
            const cleaned = extractJsonArray(snap.result)
              .filter((x) => x && String(x.title || '').trim())
              .map((x) => ({
                title: String(x.title).trim(),
                strength: String(x.strength || x.edge || '').trim(),
                acceptance: String(x.acceptance || '').trim(),
              }))
              .slice(0, 6);
            if (!cleaned.length) throw new Error('模型没有返回可用的候选（JSON 数组）');
            await writeCandidates(pendCand.file, pendCand.nodeId, cleaned);
            run.candidatesAdded = cleaned.length;
          } catch (error) {
            run.candidatesError = error.message;
            ctx.logger?.warn?.('[rotation] candidates failed: ' + error.message);
          }
        }
        PENDING_CANDIDATES.delete(run.key);

        // 服务信息收集：跑完把候选落成草稿，等面板预览确认后才写回卡片
        const pendSvc = PENDING_SERVICES.get(run.key);
        if (pendSvc) {
          try {
            if (snap.status === 'done') {
              const collected = parseCollectedServices(snap.result);
              if (!collected.length) throw new Error('模型没有返回可解析的 services（JSON 对象）');
              await saveServiceDraft(pendSvc.file, { services: collected });
              run.servicesCollected = collected.length;
              ctx.logger?.info?.(`[rotation] services collected: ${collected.length} (${pendSvc.file})`);
            } else {
              const reason = snap.status === 'cancelled' ? '收集已取消' : `收集失败：${snap.error || snap.status}`;
              await saveServiceDraft(pendSvc.file, { services: [], error: reason });
              run.servicesError = reason;
            }
          } catch (error) {
            run.servicesError = error.message;
            await saveServiceDraft(pendSvc.file, { services: [], error: error.message }).catch(() => {});
            ctx.logger?.warn?.('[rotation] services collect failed: ' + error.message);
          }
          PENDING_SERVICES.delete(run.key);
        }

        // 拆目标：跑完就把结果存成草稿（面板若已切走，下次打开还能看）
        const pendingSplit = PENDING_SPLITS.get(run.key);
        if (pendingSplit) {
          if (snap.status === 'done') {
            try {
              await saveSplitDraft(pendingSplit.file, pendingSplit.nodeId, snap.result);
              ctx.logger?.info?.(`[rotation] split draft saved: ${pendingSplit.nodeId}`);
            } catch (error) {
              ctx.logger?.warn?.('[rotation] split draft save failed: ' + error.message);
            }
          }
          PENDING_SPLITS.delete(run.key);
        }
        // 动作会话：结果写到记录节点（计划回写 / 执行关闭 + 自动反馈 / 反馈提炼），
        // 失败或取消时记录保持打开，只留 session 快照。
        if (run.recordId) {
          try {
            const out = await applyActionResult(entry, run, snap);
            if (out && out.reflect) {
              await startActionSession(runner, entry, out.card, out.idea, 'reflect', out.reflect.sessionId);
            }
          } catch (error) {
            ctx.logger?.warn?.('[rotation] action result failed: ' + error.message);
          }
          return;
        }
        await persistSession(entry, snap);
      },
    });
  } catch (error) {
    ctx.logger?.warn?.('[rotation] runner disabled: ' + error.message);
  }

  const services = createServiceRunner({ logger: ctx.logger || console });
  const handler = createHandler(base, runner, services);
  ctx.effect(() => () => services.dispose(), 'dsh-looptree-dashboard: service procs');

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: base, handler }),
    'dsh-looptree-dashboard: mount panel and api',
  );

  try {
    const ws = ctx.webServer;
    ctx.logger?.info?.('[rotation] webServer keys: ' + Object.keys(ws || {}).join(',') + ' | port=' + (ws?.port ?? 'n/a'));
  } catch { /* noop */ }
  ctx.logger?.info?.(`[rotation] mounted ${base}/app/ (web: ${WEB}, version ${VERSION})`);
}
