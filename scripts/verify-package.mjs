#!/usr/bin/env node
/**
 * scripts/verify-package.mjs — 验证「真正会被安装的那份文件集」，且不产出 tgz。
 *
 *   node scripts/verify-package.mjs
 *
 * 做法：按 package.json 的 files 白名单把文件复制到临时目录的
 * `node_modules/dsh-looptree-dashboard`（等价于 npm / 市场安装拿到的内容），然后：
 *   1) 读 package.json 的 main / exports / dsh 清单
 *   2) 动态 import host 半，用假 ctx 挂路由，跑 health / panel / registry 三个请求
 *   3) 用假 window 加载 client 半，断言 __ModuleLoader__ 契约与插槽注册
 *
 * 为什么不 `npm pack`：仓库不再产出 tgz（安装/更新走 link 或 GitHub 仓库），
 * 但「仓库里能跑、装进去缺文件」这类事故仍然要拦（files 白名单漏项、相对路径错位、ESM 互操作）。
 *
 * 这一步能抓到 files 白名单漏项的典型事故，和 npm 安装读的是同一份白名单。
 */
import { mkdtemp, readFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const pkgSrc = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const files = Array.isArray(pkgSrc.files) ? pkgSrc.files : [];
check('package.json 声明了 files 白名单', files.length > 0, files.join(','));
check('files 白名单里没有 tgz / .git / node_modules',
  !files.some((f) => /\.tgz$|^\.git|node_modules/.test(f)), files.join(','));

const work = await mkdtemp(join(tmpdir(), 'rotation-pkg-'));
const pkgDir = join(work, 'node_modules', 'dsh-looptree-dashboard');
await mkdir(pkgDir, { recursive: true });
for (const entry of files) {
  await cp(join(ROOT, entry), join(pkgDir, entry), { recursive: true, force: true });
}
await cp(join(ROOT, 'package.json'), join(pkgDir, 'package.json'));   // npm 总是会带上它

const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
check('包名正确', pkg.name === 'dsh-looptree-dashboard', pkg.name);
check('main 指向 lib/index.js', pkg.main === 'lib/index.js', pkg.main);
check('dsh.bundle.patch 存在', Boolean(pkg.dsh?.bundle?.patch), pkg.dsh?.bundle?.patch);

// ── host 半：用「装进去的那份路径」import ──
const host = await import(pathToFileURL(join(pkgDir, pkg.main)).href);
check('host 导出 apply', typeof host.apply === 'function');
check('host 导出 name', typeof host.name === 'string', host.name);
check('host 声明 inject', Array.isArray(host.inject) && host.inject.includes('webServer'), JSON.stringify(host.inject));

const routes = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: { register(options) { routes.push(options); return () => {}; } },
  effect(fn) { return fn(); },
};
host.apply(ctx, { basePath: '/rotation' });
check('apply 后注册了 prefix 路由', routes.some((r) => r.kind === 'prefix' && r.path === '/rotation'), routes.map((r) => r.path).join(','));

// 起一个临时 server 走真实请求
const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => pathname.startsWith(r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, text: await res.text() };
};

const health = await get('/rotation/api/health');
check('GET /api/health 200', health.status === 200, String(health.status));
try { check('health 返回 ok:true', JSON.parse(health.text).ok === true); } catch { check('health 返回 ok:true', false); }

const panel = await get('/rotation/app/');
check('GET /app/ 200 且是 HTML', panel.status === 200 && panel.text.includes('<html'), `${panel.status} ${panel.text.length}B`);

const cards = await get('/rotation/api/cards');
check('GET /api/cards 200', cards.status === 200, String(cards.status));

server.close();

// ── client 半：假 window 加载 ──
let captured = null;
globalThis.window = { __ModuleLoader__: { load(options) { captured = options; } } };
await import(pathToFileURL(join(pkgDir, 'lib/client.js')).href + `?t=${Date.now()}`);
const clientModule = captured?.factory((name) => ({ createElement: () => ({}) }));
check('client bundle 被 ModuleLoader 接收', Boolean(captured), captured?.id);
check('client 导出 apply', typeof clientModule?.apply === 'function');
const registered = [];
clientModule.apply({
  logger: {},
  slots: { register: (descriptor) => { registered.push(descriptor.name); return () => {}; }, inject: (name, fn) => fn() },
});
check('client 注册右栏插槽', registered.includes('sidebar.right.pane.tab'), registered.join(','));

await rm(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n安装文件集验证通过（files 白名单就是会装进去的内容）');
process.exit(failed.length ? 1 : 0);
