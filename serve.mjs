#!/usr/bin/env node
/**
 * serve.mjs — 面板 + 读写服务（零依赖）
 *   node serve.mjs            # http://127.0.0.1:4173/
 *   PORT=5000 node serve.mjs
 *
 * 接口：
 *   GET  /api/cards               列出 samples/*.rotation.json
 *   PUT  /api/cards/<file>        校验后原子写回
 * 静态资源：本目录下的文件（禁止路径穿越）
 */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { validateCard } from './rotation-core.mjs';

const ROOT = process.cwd();
const DIR = join(ROOT, 'samples');
const PORT = Number(process.env.PORT || 4173);
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

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, fail) => {
  let buf = '';
  req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy(); });
  req.on('end', () => ok(buf));
  req.on('error', fail);
});

const SAFE_FILE = /^[A-Za-z0-9._-]+\.rotation\.json$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── API ──
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
    const file = decodeURIComponent(url.pathname.slice('/api/cards/'.length));
    if (!SAFE_FILE.test(file)) return send(res, 400, { ok: false, error: '文件名不合法' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, { ok: false, error: 'JSON 解析失败: ' + e.message }); }

    const card = payload.card;
    const { errors, warnings, stats } = validateCard(card);
    if (errors.length) return send(res, 422, { ok: false, error: '校验未通过', errors, warnings });

    card.updated = new Date().toISOString();
    const tmp = join(DIR, `.${file}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
    await rename(tmp, join(DIR, file));
    return send(res, 200, { ok: true, file, updated: card.updated, warnings, stats });
  }

  // ── 静态 ──
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'method' });
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const abs = resolve(ROOT, '.' + p);
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  try {
    const buf = await readFile(abs);
    return send(res, 200, buf, MIME[extname(abs)] || 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`闭环轮转面板: http://127.0.0.1:${PORT}/`);
  console.log(`读写目录: ${DIR}`);
});
