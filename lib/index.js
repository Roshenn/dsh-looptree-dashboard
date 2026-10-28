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
import { spawn } from 'node:child_process';
import { DSH_HOME, listProjects, readAllCards, findProject, readCard, writeCard, addProject, removeProject, findNode, listDshWorkspaces, REGISTRY_PATH, REGISTRY_DIR } from './store.mjs';
import { createRunner } from './runner.mjs';
import { createServiceRunner } from './services.mjs';
import { readFile, readdir, readFile as readFileRaw, stat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-looptree-dashboard';
// cordis 要求把用到的服务全部声明；agents / agentDefaultModel 用于节点会话
export const inject = ['webServer', 'agents', 'agentDefaultModel', 'workspaceRegistry'];

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

/** 把运行结果写回卡片的节点 session 字段 */
async function persistSession(entry, nodeId, snap) {
  const card = await readCard(entry);
  const node = findNode(card.loop, nodeId);
  if (!node) return;
  node.session = {
    id: snap.sessionId,
    status: snap.status,
    cwd: snap.cwd,
    task_id: snap.taskId || undefined,
    started_at: snap.startedAt,
    ended_at: snap.endedAt || undefined,
    result: (snap.result || '').slice(0, 4000) || undefined,
    error: snap.error || undefined,
  };
  await writeCard(entry, card);
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
 * 每种节点「允许补全」的字段：标题是唯一必需项，其余空着就可生成。
 * 顺序即 prompt 里的顺序；title 只在标题为空/占位时才补。
 */
const FILLABLE_BY_KIND = {
  loop: ['title', 'intent', 'scenario', 'constraints', 'acceptance'],
  goal: ['title', 'constraints', 'acceptance'],
  idea: ['title', 'approach'],
  exec: ['title', 'verify'],
};
const FIELDS_OF = (node) => FILLABLE_BY_KIND[node.kind] || [];
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

/** 构造补全 prompt：标题是唯一锚点，缺什么补什么（按节点类型给上下文，不堆规范） */
function buildFillPrompt(entry, card, node, fields) {
  const LABEL = { title: '标题', intent: '闭环目标', scenario: '落地场景流程', constraints: '约束', acceptance: '验收', approach: '方案', verify: '验证', proof: '证据' };
  const KIND_LABEL = { loop: '闭环', goal: '目标', idea: '构思', exec: '执行项' };
  const wanted = fields.map((f) => LABEL[f] || f).join('、');
  const loop = card.loop || {};
  const isLoop = node.kind === 'loop';
  const siblings = (loop.children || [])
    .filter((k) => k.id !== node.id)
    .map((k) => `- ${k.title || '（未命名）'}`).join('\n') || '（暂无）';
  const derive = fields.includes('constraints') || fields.includes('acceptance');
  return [
    `你在完善「${entry.name}」这个项目的一张闭环卡片。项目目录：${entry.workspace}`,
    '先按需读项目里的文件（README、脚本、配置、最近的提交与产物）再作答；不确定就去查，不要凭空编。',
    '',
    `正在补的是：${KIND_LABEL[node.kind] || node.kind}「${node.title || '（未命名）'}」`,
    !isLoop && loop.intent ? `所属闭环目标：${loop.intent}` : '',
    !isLoop && loop.scenario ? `闭环的落地场景流程（约束与验收的依据）：\n${loop.scenario}` : '',
    isLoop ? `闭环目标：${node.intent || '（还没写，需要你补：一句话说清这个闭环要做到什么，方向要能判定）'}` : '',
    isLoop && node.scenario ? `已定的落地场景流程（这是「约束」与「验收」的唯一依据，必须逐条对上）：\n${node.scenario}` : '',
    node.constraints ? `已有约束：${node.constraints}` : '',
    node.acceptance ? `已有验收：${node.acceptance}` : '',
    node.approach ? `已有方案：${node.approach}` : '',
    node.verify ? `已有验证：${node.verify}` : '',
    `同级的其它节点：\n${siblings}`,
    '',
    `请只补这几项：${wanted}。`,
    '硬性限制（务必遵守，超了会被截断）：',
    `- 每个字段总字数 ≤${FIELD_MAX} 字（含编号、标点）；宁短勿长，一条一义。`,
    '- 落地场景流程 3–5 步；约束 3–5 条；验收 3–5 条（含总验收）。',
    '',
    '质量要求：',
    fields.includes('title') ? '- 标题：8–16 字的名词短语，说清「做到什么」，不要口号、不要写手段。' : '',
    fields.includes('intent') ? [
      '- 闭环目标：一句话说清「做完之后，用户/我能稳定做到什么」，要能被后面的流程与验收判定；不要写手段（用什么技术），写结果。',
      node.scenario ? '  已有的落地场景流程是它的具体化，两者必须一致。' : '',
    ].join('\n') : '',
    fields.includes('scenario') ? [
      '落地场景流程（最重要的一项，先写它）：写「这个闭环真正跑通之后，用户从头到尾能做成的完整操作流程」。',
      '用编号步骤，每步三行且固定前缀：',
      '1) 操作：用户在哪个界面做什么（点名按钮/入口）',
      '   预期：这一步应该看到什么（页面/数据/提示），要可观察',
      '   体验：这一步的体感标准（点击次数、耗时上限、是否需要滚动/记路径）',
      '只写 3–5 步，覆盖主流程即可；不写实现细节，每步都要能照着走一遍。',
    ].join('\n') : '',
    derive ? [
      '约束与验收必须从「落地场景流程」推出来，不要脱离它另起一套：',
      '- 验收：每条对应流程里的某一步，写清这一步怎么判定通过（命令/文件/断言/可见结果）；',
      '  整条闭环的总验收写成「几步全部通过即算达成」，并说明怎么数步。',
      '- 约束：来自流程中的边界与前提（素材来源与时长、单步时间盒、范围、合规、中断与变更规则），能落数字就落数字。',
      node.scenario ? '以已定的流程为准；某一步缺关键信息就按最合理的方式补齐，再据此写验收与约束。' : '',
    ].join('\n') : '',
    fields.includes('approach') ? '- 方案：写清怎么做（步骤 / 技术选择 / 代价与风险），不要复述目标。' : '',
    fields.includes('verify') ? '- 验证：一条可直接执行的命令，或可观察的判定步骤（含期望输出）。' : '',
    `严格只输出一个 JSON 对象：{${fields.map((f) => `"${f}": "..."`).join(', ')}}，只包含被要求的字段，不要输出其它文字。`,
  ].filter(Boolean).join('\n');
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
        return sendJson(res, 200, { ok: true, services: await services.list(entry.id, card) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
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
    // ── 据此填充：host 侧起会话并在结束时自动写卡片（关掉面板也不影响）──
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
      const prompt = buildFillPrompt(entry, card, node, fields);
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

    if (pathname === `${api}/run` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, prompt, taskId } = body || {};
      if (!nodeId || !prompt) return sendJson(res, 400, { ok: false, error: '缺 nodeId / prompt' });
      const entry = await findProject(file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file || body.id}` });
      // 位置并发：上游节点正在会话时，子节点不允许再发起（不是数量限制）
      const card = await readCard(entry);
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
          project: entry, nodeId, prompt: String(prompt), taskId,
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
      await persistSession(entry, body.nodeId, run).catch(() => {});
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
        await persistSession(entry, run.nodeId, snap);
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
