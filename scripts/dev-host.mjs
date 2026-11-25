#!/usr/bin/env node
/**
 * scripts/dev-host.mjs — 不装进 DSH 也能验证 host 半的最小假宿主。
 *
 *   node scripts/dev-host.mjs            # http://127.0.0.1:4180/rotation/app/
 *   PORT=5000 BASE=/rotation node scripts/dev-host.mjs
 *
 * 它只用真实的 lib/index.js，配一个假的 ctx（webServer.register + effect + logger），
 * 所以这里跑通的路由在 DSH 里就是同一份代码。
 */
import { createServer } from 'node:http';
import { apply } from '../lib/index.js';

const PORT = Number(process.env.PORT || 4180);
const BASE = process.env.BASE || '/rotation';

const routes = [];
const eventHandlers = new Set();
const MOCK_AGENTS = process.env.MOCK_AGENTS === '1';

const ctx = {
  logger: console,
  on(event, handler) {
    if (event === 'session/event') eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
  agents: MOCK_AGENTS ? {
    async create({ sessionId, meta }) {
      const emit = (event) => { for (const fn of eventHandlers) fn({ id: sessionId, header: { cwd: meta?.cwd } }, event); };
      return {
        agent: {
          id: sessionId,
          async followup() {
            setTimeout(() => emit({ type: 'turn/start', data: { turn: 1 } }), 150);
            setTimeout(() => emit({ type: 'step/start', data: { turn: 1, step: 1 } }), 300);
            setTimeout(() => emit({
              type: 'assistant/message',
              data: { content: [{ type: 'text', text: 'MOCK：这里是一段会话结果，用来验证面板的状态与写回。' }] },
            }), 900);
            setTimeout(() => emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), 1400);
          },
          interrupt() {},
        },
      };
    },
  } : undefined,
  /**
   * 真宿主上由 connection 服务做 Host/Origin 校验 + 浏览器会话；假宿主默认一律放行，
   * 因为这里的 mock 验的是路由行为，不是鉴权。
   *
   * `MOCK_FENCE=strict` 时换成一份按真实语义写的替身（Host 已在假宿主里固定为
   * 127.0.0.1，所以只复现「Origin 必须同 host」「跨站标记拒绝」「没有会话 cookie
   * 就是 401」三条），供 auth-mock 验证闸门确实接上了。
   */
  connection: {
    requestRejection(req) {
      if (process.env.MOCK_FENCE !== 'strict') return undefined;
      const host = String(req.headers.host || '');
      const origin = String(req.headers.origin || '');
      if (origin) {
        try {
          if (new URL(origin).host !== host) return 403;
        } catch {
          return 403;
        }
      }
      if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return 403;
      return req.headers.cookie ? undefined : 401;
    },
  },
  webServer: {
    register(options) {
      routes.push(options);
      return () => {
        const i = routes.indexOf(options);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  },
  effect(fn, label) {
    const dispose = fn();
    if (typeof dispose === 'function') process.on('exit', dispose);
    return dispose;
  },
};

apply(ctx, { basePath: BASE });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no route: ' + pathname);
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('handler error: ' + error.message);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-host] panel  http://127.0.0.1:${PORT}${BASE}/app/`);
  console.log(`[dev-host] health http://127.0.0.1:${PORT}${BASE}/api/health`);
});
