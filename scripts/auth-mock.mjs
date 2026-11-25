#!/usr/bin/env node
/**
 * scripts/auth-mock.mjs — 接口访问闸门 + 写接口令牌（不需要 DSH）。
 *
 *   node scripts/auth-mock.mjs
 *
 * 背景（docs/backlog.md 五-9）：CORS 原本是 `*`，`x-rotation-token` 只写在声明里，
 * 全仓没有一处读它——本机任意网页都能跨源调 stop-all（按端口杀进程）/ probe / run。
 *
 * 现在的口径（两层，先栅栏后令牌）：
 *   · **第一层：宿主 connection 栅栏**。`/rotation/api/*` 先过 `requestRejection`
 *     （Host/Origin 校验 + 浏览器会话 cookie），没有栅栏就 503，绝不裸奔。
 *   · **第二层：自己的写令牌**。浏览器发起的 http(s) 跨源写必须带对令牌，否则 403。
 *   · 第一方非浏览器客户端（CLI / `dsh-app://` 外壳）拿不到 http 的 cookie，
 *     用 `x-rotation-token` 过闸门——令牌只注入插件托管的 HTML 与 DSH 首页，
 *     跨源页面读不到（同源策略）。
 *
 * 起一个真的 dev-host，用真的 HTTP 打，不 mock 路由。MOCK_FENCE=strict 那一轮
 * 用的是按真实 connection 语义写的替身，所以栅栏接没接上能在这里看出来。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.AUTH_MOCK_PORT || 4317);
const STRICT_PORT = PORT + 1;
const BASE = '/rotation';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STRICT_ORIGIN = `http://127.0.0.1:${STRICT_PORT}`;
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

// 同一份代码 + 严格栅栏替身：闸门是否真的接上了，只有这一轮能证明。
const strictChild = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-host.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(STRICT_PORT), BASE, MOCK_FENCE: 'strict' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let strictStderr = '';
strictChild.stderr.on('data', (c) => { strictStderr += String(c); });

/** 找不到卡片时路由回 404：那代表闸门放行了，只是业务上没这条 */
const notBlocked = (res) => res.status !== 403 && res.status !== 401;

/** 轮询一下 /health 直到假宿主起来（这一轮闸门是放行的） */
async function waitReady(origin, errRef) {
  for (let i = 0; i < 60; i += 1) {
    await wait(200);
    try {
      const r = await fetch(`${origin}${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
  }
  return errRef();
}

try {
  const ready = await waitReady(ORIGIN, () => stderr.slice(0, 200) || '超时');
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

    // ── 第二层：严格栅栏替身下的闸门 ────────────────────────────────────────
    const strictReady = await waitReady(STRICT_ORIGIN, () => strictStderr.slice(0, 200) || '超时');
    check('严格栅栏的 dev-host 起来了', strictReady, strictReady ? STRICT_ORIGIN : (strictStderr.slice(0, 200) || '超时'));

    if (strictReady) {
      const strictGet = (path, headers) => fetch(`${STRICT_ORIGIN}${BASE}${path}`, { headers });
      const strictWrite = (headers) => fetch(`${STRICT_ORIGIN}${BASE}/api/candidates/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ file: 'no-such.rotation.json', nodeId: 'x', all: true }),
      });

      const noSession = await strictGet('/api/cards');
      check('闸门：没有会话 cookie 的读 → 401', noSession.status === 401, `HTTP ${noSession.status}`);
      await noSession.text();

      const crossOrigin = await strictGet('/api/cards', { origin: 'http://evil.local' });
      check('闸门：跨源读（篡改 Origin）→ 403', crossOrigin.status === 403, `HTTP ${crossOrigin.status}`);
      await crossOrigin.text();

      const rebound = await strictGet('/api/cards', { 'sec-fetch-site': 'cross-site' });
      check('闸门：跨站标记的读 → 403', rebound.status === 403, `HTTP ${rebound.status}`);
      await rebound.text();

      const rejectedWrite = await strictWrite({ origin: 'http://evil.local' });
      check('闸门：跨源写也不放行', rejectedWrite.status === 403, `HTTP ${rejectedWrite.status}`);
      await rejectedWrite.text();

      // 严格栅栏 + 正确令牌 = 第一方（CLI／dsh-app:// 外壳这条通道）。
      // 令牌每个进程随机一次，所以要从严格那一份 HTML 里取它自己的令牌。
      const strictHtml = await (await fetch(`${STRICT_ORIGIN}${BASE}/app/`)).text();
      const strictToken = (() => {
        const hit = strictHtml.match(/window\.__ROTATION_TOKEN__=("(?:[^"\\]|\\.)*")/);
        return hit ? JSON.parse(hit[1]) : '';
      })();
      check('严格栅栏的 HTML 也注入了令牌', !!strictToken, strictToken ? strictToken.slice(0, 8) + '…' : '没找到');

      const withTokenStrict = await strictGet('/api/health', { 'x-rotation-token': strictToken });
      check('闸门：带正确令牌的第一方调用放行', withTokenStrict.ok, `HTTP ${withTokenStrict.status}`);
      await withTokenStrict.text();

      const withCookie = await strictGet('/api/health', { cookie: 'dsht-session=stub' });
      check('闸门：带会话 cookie 的同源调用放行', withCookie.ok, `HTTP ${withCookie.status}`);
      await withCookie.text();

      const preflight = await fetch(`${STRICT_ORIGIN}${BASE}/api/cards`, {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.local', 'access-control-request-method': 'POST' },
      });
      check('闸门：CORS 预检仍然回 204（预检带不了自定义头）', preflight.status === 204, `HTTP ${preflight.status}`);
      await preflight.text();
    }
  }
} finally {
  child.kill();
  strictChild.kill();
  await wait(300);
}

const failed = results.filter((r) => !r.pass);
console.log('');
if (failed.length) {
  console.error(`写令牌闸门 ${failed.length} 项失败`);
  process.exit(1);
}
console.log(`写令牌闸门全部通过（${results.length} 项）`);
