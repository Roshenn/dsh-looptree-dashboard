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
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-rotation-dashboard';
export const inject = ['webServer'];

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

/** 面板与接口共用一个 prefix 路由，按 path 分流。 */
function createHandler(base) {
  return async function rotationHandler(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' });
    }

    if (pathname === `${base}/api/health`) {
      return sendJson(res, 200, {
        ok: true,
        name,
        version: VERSION,
        base,
        web: WEB,
        time: new Date().toISOString(),
      });
    }

    if (pathname === `${base}/api` || pathname.startsWith(`${base}/api/`)) {
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
  const handler = createHandler(base);

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: base, handler }),
    'dsh-rotation-dashboard: mount panel and api',
  );

  ctx.logger?.info?.(`[rotation] mounted ${base}/app/ (web: ${WEB}, version ${VERSION})`);
}
