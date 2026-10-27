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
import { listProjects, readAllCards, findProject, readCard, writeCard, addProject, removeProject, findNode, REGISTRY_PATH } from './store.mjs';
import { createRunner } from './runner.mjs';
import { createServiceRunner } from './services.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-rotation-dashboard';
// cordis 要求把用到的服务全部声明；agents / agentDefaultModel 用于节点会话
export const inject = ['webServer', 'agents', 'agentDefaultModel'];

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

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, relPath) {
  const rel = relPath === '/' || relPath === '' ? '/index.html' : relPath;
  const abs = resolve(WEB, '.' + rel);
  if (!abs.startsWith(WEB + sep) && abs !== WEB) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
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
function createHandler(base, runner, services) {
  return async function rotationHandler(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' });
    }

    const api = `${base}/api`;

    if (pathname === `${api}/health`) {
      return sendJson(res, 200, {
        ok: true, name, version: VERSION, base, web: WEB,
        registry: REGISTRY_PATH, time: new Date().toISOString(),
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
        const { warnings, stats } = await writeCard(entry, card);
        return sendJson(res, 200, { ok: true, id: entry.id, file: entry.file, updated: card.updated, warnings, stats });
      } catch (error) {
        return sendJson(res, error.status || 500, {
          ok: false, error: error.message, errors: error.errors, warnings: error.warnings,
        });
      }
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
    if (pathname === `${api}/run` && req.method === 'POST') {
      if (!runner) return sendJson(res, 503, { ok: false, error: '会话服务不可用' });
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { file, nodeId, prompt, taskId } = body || {};
      if (!nodeId || !prompt) return sendJson(res, 400, { ok: false, error: '缺 nodeId / prompt' });
      const entry = await findProject(file || body.id);
      if (!entry) return sendJson(res, 404, { ok: false, error: `找不到项目：${file || body.id}` });
      const active = runner.list().filter((r) => r.status === 'starting' || r.status === 'running').length;
      if (active >= MAX_CONCURRENT) return sendJson(res, 429, { ok: false, error: `并发已达上限 ${MAX_CONCURRENT}` });
      try {
        const run = await runner.start({
          project: entry, nodeId, prompt: String(prompt), taskId,
        });
        return sendJson(res, 200, { ok: true, run });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.message });
      }
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
      return serveStatic(res, rel);
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

  let runner = null;
  try {
    runner = createRunner(ctx, {
      provider: config.provider,
      model: config.model,
      onFinish: async (run, snap) => {
        const entry = await findProject(run.projectId);
        if (entry) await persistSession(entry, run.nodeId, snap);
      },
    });
  } catch (error) {
    ctx.logger?.warn?.('[rotation] runner disabled: ' + error.message);
  }

  const services = createServiceRunner({ logger: ctx.logger || console });
  const handler = createHandler(base, runner, services);
  ctx.effect(() => () => services.dispose(), 'dsh-rotation-dashboard: service procs');

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: base, handler }),
    'dsh-rotation-dashboard: mount panel and api',
  );

  ctx.logger?.info?.(`[rotation] mounted ${base}/app/ (web: ${WEB}, version ${VERSION})`);
}
