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
const ctx = {
  logger: console,
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
