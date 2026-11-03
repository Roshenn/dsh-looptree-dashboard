#!/usr/bin/env node
/**
 * scripts/auth-mock.mjs — 写接口令牌闸门（不需要 DSH）。
 *
 *   node scripts/auth-mock.mjs
 *
 * 背景（docs/backlog.md 五-9）：CORS 原本是 `*`，`x-rotation-token` 只写在声明里，
 * 全仓没有一处读它——本机任意网页都能跨源调 stop-all（按端口杀进程）/ probe / run。
 *
 * 现在的口径：
 *   · 面板 HTML 由插件自己托管，令牌注入那一份 HTML；跨源页面读不到（同源策略）。
 *   · **浏览器发起的 http(s) 跨源写**必须带对令牌，否则 403。
 *   · 非浏览器客户端（CLI / mock，不带 Origin）与 dsh-app:// 外壳放行——
 *     它们本来就能直接跑 shell，拦它们只会把合法路径一起关掉。
 *
 * 起一个真的 dev-host，用真的 HTTP 打，不 mock 路由。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.AUTH_MOCK_PORT || 4317);
const BASE = '/rotation';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-host.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), BASE },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => { stderr += String(c); });

/** 找不到卡片时路由回 404：那代表闸门放行了，只是业务上没这条 */
const notBlocked = (res) => res.status !== 403;

try {
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    await wait(200);
    try {
      const r = await fetch(`${ORIGIN}${BASE}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
  }
  check('dev-host 起来了', ready, ready ? ORIGIN : (stderr.slice(0, 200) || '超时'));

  if (ready) {
    const html = await (await fetch(`${ORIGIN}${BASE}/app/`)).text();
    const m = html.match(/window\.__ROTATION_TOKEN__=("(?:[^"\\]|\\.)*")/);
    const token = m ? JSON.parse(m[1]) : '';
    check('面板 HTML 注入令牌', !!token, token ? token.slice(0, 8) + '…' : '没找到 __ROTATION_TOKEN__');
    check('令牌不出现在 health 响应里', !(await (await fetch(`${ORIGIN}${BASE}/api/health`)).text()).includes(token), '');

    const write = (headers) => fetch(`${ORIGIN}${BASE}/api/candidates/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ file: 'no-such.rotation.json', nodeId: 'x', all: true }),
    });

    const evil = await write({ origin: 'http://evil.local' });
    check('跨源写（无令牌）→ 403', evil.status === 403, `HTTP ${evil.status}`);
    const evilBody = await evil.json().catch(() => ({}));
    check('403 说明原因', /x-rotation-token/.test(String(evilBody.error || '')), String(evilBody.error || ''));

    const wrong = await write({ origin: 'http://evil.local', 'x-rotation-token': 'not-the-token' });
    check('跨源写（错令牌）→ 403', wrong.status === 403, `HTTP ${wrong.status}`);

    const cli = await write({});
    check('无 Origin 的本机客户端放行', notBlocked(cli), `HTTP ${cli.status}`);

    const good = await write({ origin: ORIGIN, 'x-rotation-token': token });
    check('同源写 + 正确令牌放行', notBlocked(good), `HTTP ${good.status}`);

    const shellOrigin = await write({ origin: 'dsh-app://app' });
    check('dsh-app:// 外壳写放行（非 http 来源）', notBlocked(shellOrigin), `HTTP ${shellOrigin.status}`);

    const read = await fetch(`${ORIGIN}${BASE}/api/cards`);
    check('GET 读接口不受影响', read.ok, `HTTP ${read.status}`);
  }
} finally {
  child.kill();
  await wait(300);
}

const failed = results.filter((r) => !r.pass);
console.log('');
if (failed.length) {
  console.error(`写令牌闸门 ${failed.length} 项失败`);
  process.exit(1);
}
console.log(`写令牌闸门全部通过（${results.length} 项）`);
