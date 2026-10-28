#!/usr/bin/env node
/**
 * serve.mjs — 面板 + 读写服务 + 会话执行器（零依赖）
 *   node serve.mjs            # http://127.0.0.1:4173/
 *   PORT=5000 node serve.mjs
 *
 * 接口：
 *   GET    /api/run-config             运行器配置（token / 并发 / 超时）
 *   GET    /api/cards                  列出 samples/*.rotation.json
 *   PUT    /api/cards/<file>           校验后原子写回（保护 session 字段不被前端覆盖）
 *   POST   /api/run                    { file, nodeId, prompt, taskId } 发起会话
 *   GET    /api/runs                   所有运行快照
 *   POST   /api/run/cancel             { file, nodeId } 取消
 *
 * 安全：写接口要求同源 + X-Rotation-Token（token 只在同源页面里拿得到）。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { validateCard } from './lib/core.mjs';

const ROOT = process.cwd();
const DIR = join(ROOT, 'samples');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4173);
const RUN_TOKEN = randomBytes(12).toString('hex');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 15 * 60 * 1000);
const STALE_MS = Number(process.env.STALE_MS || 60 * 1000);
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const RUNS_FILE = join(ROOT, 'runs.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SAFE_FILE = /^[A-Za-z0-9._-]+\.rotation\.json$/;

/** key = `<file>::<nodeId>` */
const runs = new Map();
/** key = `<file>::<serviceId>` → { child, pid, startedAt, stopped, output, exitCode } */
const services = new Map();
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 1200);

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { ok: res.status < 500, httpStatus: res.status, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - t0 };
  } finally { clearTimeout(t); }
}
function svcRuntime(file, id) { return services.get(`${file}::${id}`) || null; }
function svcView(file, svc, probeRes, runtime) {
  const age = runtime ? Date.now() - Date.parse(runtime.startedAt) : null;
  let status = probeRes.ok ? 'up' : 'down';
  if (!probeRes.ok && runtime && !runtime.stopped && runtime.exitCode == null && age < 30000) status = 'starting';
  if (!probeRes.ok && runtime && runtime.stopped) status = 'down';
  else if (!probeRes.ok && runtime && runtime.exitCode != null && runtime.exitCode !== 0) status = 'failed';
  return {
    id: svc.id, name: svc.name || svc.id, url: svc.url, health: svc.health || '',
    start: svc.start || '', stop: svc.stop || '',
    status, httpStatus: probeRes.httpStatus, latencyMs: probeRes.latencyMs, error: probeRes.error,
    pid: runtime ? runtime.pid : null,
    startedAt: runtime ? runtime.startedAt : null,
    uptimeMs: runtime && !runtime.exitCode ? Date.now() - Date.parse(runtime.startedAt) : null,
    checkedAt: new Date().toISOString(),
    output: runtime ? (runtime.output || '').slice(-1500) : '',
  };
}
async function servicesFor(file) {
  const card = await loadCard(file);
  const list = Array.isArray(card.services) ? card.services : [];
  const out = [];
  for (const svc of list) {
    const url = String(svc.health ? new URL(svc.health, svc.url).toString() : svc.url);
    const probeRes = await probe(url);
    out.push(svcView(file, svc, probeRes, svcRuntime(file, svc.id)));
  }
  return out;
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, fail) => {
  let buf = '';
  req.on('data', (c) => { buf += c; if (buf.length > 4e6) req.destroy(); });
  req.on('end', () => ok(buf));
  req.on('error', fail);
});
const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl / 本机脚本：只靠 token
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
};
const authed = (req) => sameOrigin(req) && req.headers['x-rotation-token'] === RUN_TOKEN;

async function cardPath(file) {
  if (!SAFE_FILE.test(file)) throw new Error('文件名不合法');
  return join(DIR, file);
}
async function loadCard(file) {
  const raw = JSON.parse(await readFile(await cardPath(file), 'utf8'));
  return raw;
}
function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}
async function writeCard(file, card) {
  const { errors } = validateCard(card);
  if (errors.length) throw new Error('校验未通过: ' + errors[0]);
  card.updated = new Date().toISOString();
  const target = await cardPath(file);
  const tmp = join(DIR, `.${file}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
  await rename(tmp, target);
}
async function persistRuns() {
  const snap = [...runs.values()].map(({ child, ...rest }) => rest);
  await writeFile(RUNS_FILE, JSON.stringify(snap, null, 1) + '\n', 'utf8');
}
function runView(r) {
  return {
    key: r.key, file: r.file, nodeId: r.nodeId, sessionId: r.sessionId, cwd: r.cwd,
    taskId: r.taskId, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
    exitCode: r.exitCode, result: r.result, error: r.error,
    elapsedMs: (r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt),
    lastEventAt: r.lastEventAt, tail: (r.tail || []).slice(-5),
  };
}

async function writeSessionToCard(file, nodeId, patch) {
  try {
    const card = await loadCard(file);
    const node = findNode(card.loop, nodeId);
    if (!node) return;
    node.session = { ...(node.session || {}), ...patch };
    await writeCard(file, card);
  } catch (e) {
    console.error('[run] 写回 session 失败:', e.message);
  }
}

function startRun({ file, nodeId, prompt, taskId, workspace, card }) {
  const key = `${file}::${nodeId}`;
  const startedAt = new Date().toISOString();
  const run = {
    key, file, nodeId, taskId: taskId || '', sessionId: '', cwd: workspace,
    status: 'starting', startedAt, endedAt: null, exitCode: null,
    result: '', error: '', tail: [], lastEventAt: startedAt, child: null,
  };
  runs.set(key, run);

  const child = spawn(DSH_BIN, ['--profile', 'headless', '--json', prompt], {
    cwd: workspace,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;

  const timer = setTimeout(() => {
    if (run.status === 'running' || run.status === 'starting') {
      run.error = `超时 ${Math.round(RUN_TIMEOUT_MS / 60000)} 分钟未完成，已取消`;
      try { child.kill('SIGTERM'); } catch {}
    }
  }, RUN_TIMEOUT_MS);

  let buf = '';
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    run.lastEventAt = new Date().toISOString();
    const brief = ev.type === 'tool/call' ? `tool/call ${ev.name || ev.tool || ''}`
      : ev.type === 'tool/result' ? `tool/result ${ev.status || ''}`
      : ev.type;
    run.tail.push({ at: run.lastEventAt, type: ev.type, brief: String(brief).trim() });
    if (run.tail.length > 40) run.tail.shift();

    if (ev.type === 'session') {
      run.sessionId = ev.sessionId || run.sessionId;
      run.cwd = ev.cwd || run.cwd;
      run.status = 'running';
      if (!run.persisted){
        run.persisted = true;
        writeSessionToCard(file, nodeId, {
          id: run.sessionId, status: 'running', cwd: run.cwd,
          task_id: run.taskId, started_at: run.startedAt,
        });
      }
    } else if (ev.type === 'final') {
      run.result = String(ev.text || '').slice(0, 8000);
    } else if (ev.type === 'turn/end') {
      const reason = ev?.data?.reason?.kind;
      if (reason && reason !== 'completed'){
        run.status = 'failed';
        run.error = `turn 结束原因：${reason}`;
      }
    } else if (ev.type === 'error') {
      run.error = String(ev.message || ev.error || 'unknown error');
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    const text = String(c).trim();
    if (text) run.stderrTail = (run.stderrTail || '').slice(-2000) + text;
  });

  const finish = (code, signal) => {
    clearTimeout(timer);
    run.child = null;
    run.endedAt = new Date().toISOString();
    run.exitCode = code;
    if (run.status === 'cancelled') { /* 保持 cancelled */ }
    else if (signal === 'SIGTERM' && run.error) run.status = 'failed';
    else if (code === 0 && run.status !== 'failed') run.status = 'done';
    else if (run.status !== 'failed') { run.status = 'failed'; run.error = run.error || `进程退出码 ${code}${signal ? ' / ' + signal : ''}`; }
    if (run.status === 'failed' && !run.result && run.stderrTail) run.error += ' · ' + run.stderrTail.slice(-300);

    writeSessionToCard(file, nodeId, {
      id: run.sessionId || undefined, status: run.status, cwd: run.cwd,
      task_id: run.taskId, started_at: run.startedAt, ended_at: run.endedAt,
      exit_code: code, result: run.result.slice(0, 4000), error: run.error || undefined,
    });
    persistRuns().catch(() => {});
  };
  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => { run.error = 'spawn 失败: ' + err.message; finish(-1, null); });

  return run;
}

/** 运行中但进程已不在（服务重启 / 崩溃）→ stale */
function sweepStale() {
  for (const r of runs.values()) {
    if (r.status !== 'running' && r.status !== 'starting') continue;
    if (r.child) continue;
    if (Date.now() - Date.parse(r.lastEventAt || r.startedAt) > STALE_MS) {
      r.status = 'stale';
      r.error = r.error || '进程已不在（服务重启或会话被中断）';
      r.endedAt = r.endedAt || new Date().toISOString();
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── 运行器配置 ──
  if (url.pathname === '/api/run-config' && req.method === 'GET') {
    return send(res, 200, {
      ok: true, token: RUN_TOKEN, maxConcurrent: MAX_CONCURRENT, timeoutMs: RUN_TIMEOUT_MS, dshBin: DSH_BIN,
      hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY),
    });
  }

  // ── 卡片 ──
  if (url.pathname === '/api/cards' && req.method === 'GET') {
    const files = (await readdir(DIR)).filter((f) => f.endsWith('.rotation.json')).sort();
    const cards = [];
    for (const f of files) {
      try { cards.push({ file: f, card: JSON.parse(await readFile(join(DIR, f), 'utf8')) }); }
      catch (e) { cards.push({ file: f, error: e.message }); }
    }
    return send(res, 200, { ok: true, dir: DIR, cards });
  }

  if (url.pathname.startsWith('/api/cards/') && req.method === 'PUT') {
    if (!authed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    const file = decodeURIComponent(url.pathname.slice('/api/cards/'.length));
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, { ok: false, error: 'JSON 解析失败: ' + e.message }); }
    const card = payload.card;
    // 保护 session 字段：前端不编辑它，磁盘上的更新更权威
    try {
      const disk = await loadCard(file);
      (function merge(node) {
        if (!node) return;
        const d = findNode(disk.loop, node.id);
        if (d && d.session && !node.session) node.session = d.session;
        (node.children || []).forEach(merge);
      })(card.loop);
    } catch {}
    const { errors, warnings, stats } = validateCard(card);
    if (errors.length) return send(res, 422, { ok: false, error: '校验未通过', errors, warnings });
    await writeCard(file, card);
    return send(res, 200, { ok: true, file, updated: card.updated, warnings, stats });
  }

  // ── 会话执行 ──
  if (url.pathname === '/api/runs' && req.method === 'GET') {
    sweepStale();
    return send(res, 200, { ok: true, runs: [...runs.values()].map(runView) });
  }

  if (url.pathname === '/api/services' && req.method === 'GET') {
    const file = url.searchParams.get('file') || '';
    if (!SAFE_FILE.test(file || '')) return send(res, 400, { ok: false, error: 'file 不合法' });
    try { return send(res, 200, { ok: true, services: await servicesFor(file) }); }
    catch (e) { return send(res, 404, { ok: false, error: e.message }); }
  }

  if (url.pathname === '/api/service/start' && req.method === 'POST') {
    if (!authed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
    const { file, id } = body || {};
    if (!SAFE_FILE.test(file || '') || !id) return send(res, 400, { ok: false, error: '缺 file / id' });
    let card; try { card = await loadCard(file); } catch (e) { return send(res, 404, { ok: false, error: e.message }); }
    const svc = (card.services || []).find(x => x.id === id);
    if (!svc) return send(res, 404, { ok: false, error: '找不到服务 ' + id });
    if (!svc.start) return send(res, 400, { ok: false, error: '这个服务没有配置 start 命令' });
    const key = `${file}::${id}`;
    const prev = services.get(key);
    if (prev && prev.exitCode == null && !prev.stopped) return send(res, 409, { ok: false, error: '该服务已在运行（pid ' + prev.pid + '）' });
    const cwd = svc.cwd || (card.project && card.project.workspace) || ROOT;
    try {
      const child = spawn(svc.start, {
        cwd, shell: true, detached: true,
        env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const rt = { child, pid: child.pid, startedAt: new Date().toISOString(), stopped: false, output: '', exitCode: null };
      const push = (c) => { rt.output = (rt.output + String(c)).slice(-4000); };
      child.stdout.on('data', push); child.stderr.on('data', push);
      child.on('exit', (code, signal) => { rt.exitCode = code == null ? -1 : code; rt.exitedAt = new Date().toISOString(); rt.signal = signal; });
      child.on('error', (e) => { push('spawn error: ' + e.message); rt.exitCode = -1; });
      services.set(key, rt);
      return send(res, 200, { ok: true, service: { id, pid: child.pid, cwd, command: svc.start } });
    } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }

  if (url.pathname === '/api/service/stop' && req.method === 'POST') {
    if (!authed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
    const { file, id } = body || {};
    const key = `${file}::${id}`;
    const rt = services.get(key);
    if (!rt) return send(res, 404, { ok: false, error: '没有在跑的服务' });
    rt.stopped = true;
    try { process.kill(-rt.pid, 'SIGTERM'); } catch { try { rt.child.kill('SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-rt.pid, 'SIGKILL'); } catch {} }, 3000);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    if (!authed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, { ok: false, error: 'JSON 解析失败' }); }
    const { file, nodeId, prompt, taskId } = body || {};
    if (!file || !nodeId || !prompt) return send(res, 400, { ok: false, error: '缺 file / nodeId / prompt' });
    if (String(prompt).length > 20000) return send(res, 400, { ok: false, error: 'prompt 过长（>20k）' });

    let card;
    try { card = await loadCard(file); } catch (e) { return send(res, 404, { ok: false, error: '读不到卡片: ' + e.message }); }
    const node = findNode(card.loop, nodeId);
    if (!node) return send(res, 404, { ok: false, error: '找不到节点 ' + nodeId });
    const workspace = card.project && card.project.workspace;
    if (!workspace) return send(res, 400, { ok: false, error: '卡片缺少 project.workspace，无法确定会话工作目录' });
    try {
      const st = await stat(workspace);
      if (!st.isDirectory()) throw new Error('不是目录');
    } catch (e) {
      return send(res, 400, { ok: false, error: `project.workspace 不可用：${workspace}` });
    }

    const key = `${file}::${nodeId}`;
    const existing = runs.get(key);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return send(res, 409, { ok: false, error: '该节点已有会话在运行' });
    }
    const active = [...runs.values()].filter(r => r.status === 'running' || r.status === 'starting').length;
    if (active >= MAX_CONCURRENT) {
      return send(res, 429, { ok: false, error: `并发已达上限 ${MAX_CONCURRENT}` });
    }

    const run = startRun({ file, nodeId, prompt: String(prompt), taskId, workspace, card });
    // 等首个 session 事件（或失败）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (run.sessionId) break;
      if (run.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    persistRuns().catch(() => {});
    if (run.status === 'failed') return send(res, 500, { ok: false, error: run.error || '启动失败' });
    return send(res, 200, { ok: true, run: runView(run) });
  }

  if (url.pathname === '/api/run/cancel' && req.method === 'POST') {
    if (!authed(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false }); }
    const key = `${body.file}::${body.nodeId}`;
    const run = runs.get(key);
    if (!run) return send(res, 404, { ok: false, error: '没有该运行' });
    if (run.status !== 'running' && run.status !== 'starting') return send(res, 409, { ok: false, error: '已结束' });
    run.status = 'cancelled';
    run.error = '用户取消';
    try { run.child && run.child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { run.child && run.child.kill('SIGKILL'); } catch {} }, 3000);
    return send(res, 200, { ok: true, run: runView(run) });
  }

  // ── 静态 ──
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'method' });
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const abs = resolve(WEB, '.' + p);
  if (!abs.startsWith(WEB + sep) && abs !== WEB) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  try {
    const buf = await readFile(abs);
    return send(res, 200, buf, MIME[extname(abs)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`轮转闭环树面板: http://127.0.0.1:${PORT}/`);
  console.log(`读写目录: ${DIR}`);
  console.log(`执行器: ${DSH_BIN} --profile headless --json（并发 ${MAX_CONCURRENT}，超时 ${Math.round(RUN_TIMEOUT_MS / 60000)} 分钟）`);
});
