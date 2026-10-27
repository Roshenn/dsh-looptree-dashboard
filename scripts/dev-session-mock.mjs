#!/usr/bin/env node
/**
 * scripts/dev-session-mock.mjs — 用假 ctx 驱动 M2 会话执行器（不需要 DSH）。
 *
 *   ROTATION_HOME=/tmp/rot-run node scripts/dev-session-mock.mjs
 *
 * 验证链路：POST /api/run → 假 agent 依次吐 turn/start、assistant/message、turn/end
 * → GET /api/runs 变 done 且带 result → 卡片文件里出现 session 字段。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { apply } from '../lib/index.js';
import { addProject, cardPathOf, listProjects } from '../lib/store.mjs';

const PORT = Number(process.env.PORT || 4181);
const MODE = process.env.MOCK_MODE || 'ok';   // ok | fail | hang
const BASE = '/rotation';
const handlers = new Map(); // event name -> Set<fn>
const routes = [];

const ctx = {
  logger: console,
  webServer: {
    register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); },
  },
  effect(fn) { return fn(); },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
  agents: {
    async create({ sessionId, meta }) {
      const emit = (event) => {
        for (const fn of handlers.get('session/event') || []) fn({ sessionId, ...event });
      };
      const agent = {
        id: sessionId,
        cwd: meta?.cwd,
        async followup() {
          setTimeout(() => emit({ type: 'turn/start', data: { turn: 1 } }), 20);
          setTimeout(() => emit({ type: 'step/start', data: { turn: 1, step: 1 } }), 40);
          setTimeout(() => emit({
            type: 'assistant/message',
            data: { content: [{ type: 'text', text: 'MOCK 回答：已按 prompt 生成 2 个替代构思。' }] },
          }), 60);
          if (MODE === 'hang') return;
          setTimeout(() => emit({
            type: 'turn/end',
            data: { turn: 1, reason: { kind: MODE === 'fail' ? 'error' : 'completed' } },
          }), 90);
        },
        interrupt() {},
      };
      return { agent };
    },
  },
};

apply(ctx, { basePath: BASE });

const WS = process.env.MOCK_WS || '/tmp/ws-mockrun';
const project = await addProject({ id: 'mockrun', name: 'MockRun', workspace: WS })
  .catch(async (error) => {
    if (error.status !== 409) throw error;
    const { findProject } = await import('../lib/store.mjs');
    return findProject('mockrun');
  });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)); });
});

const fetchJson = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${BASE}/api${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[mock] ${project.id} → ${project.workspace}`);

  const started = await fetchJson('/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: project.id, nodeId: project.id + '-loop', prompt: '给我 2 个替代构思', taskId: 'plan' }),
  });
  console.log('[mock] POST /run →', started.status, started.body?.run?.status, started.body?.run?.sessionId);

  await new Promise((r) => setTimeout(r, 250));
  const runs = await fetchJson('/runs');
  const run = runs.body.runs[0];
  console.log('[mock] GET /runs →', run.status, JSON.stringify(run.result).slice(0, 60));

  await new Promise((r) => setTimeout(r, 120));
  const card = JSON.parse(await readFile(cardPathOf(project), 'utf8'));
  const node = card.loop.id === project.id + '-loop' ? card.loop : null;
  console.log('[mock] card session →', JSON.stringify(node?.session || null));

  let ok;
  if (MODE === 'fail') {
    ok = run.status === 'failed' && /turn 结束原因/.test(run.error || '') && node?.session?.status === 'failed';
  } else if (MODE === 'hang') {
    const cancelled = await fetchJson('/run/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: project.id, nodeId: project.id + '-loop' }),
    });
    ok = cancelled.body?.run?.status === 'cancelled';
  } else {
    ok = run.status === 'done' && /MOCK 回答/.test(run.result || '') && node?.session?.status === 'done';
  }
  console.log(ok ? '[mock] PASS' : '[mock] FAIL');
  server.close();
  process.exit(ok ? 0 : 1);
});
