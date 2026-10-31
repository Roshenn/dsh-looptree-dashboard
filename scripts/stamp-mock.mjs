#!/usr/bin/env node
/**
 * scripts/stamp-mock.mjs — GET /api/cards/stamp（卡片 mtime 轻量戳）的 host 级断言。
 *
 *   node scripts/stamp-mock.mjs
 *   PORT=4203 node scripts/stamp-mock.mjs
 *
 * 面板靠这个接口每 10s 发现「别处改了卡片」，所以它必须：
 *   · 只回 { file: mtimeMs }，不解析卡片；
 *   · 写卡之后 mtime 变大；
 *   · 注册表里读不到的卡记 0 而不是整体 500。
 * 仿 candidates-mock：假 ctx + 真 http + fetch，临时 ROTATION_HOME / 工作区。
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4203);
const BASE = '/rotation';

const home = await mkdtemp(join(tmpdir(), 'rotation-stamp-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-stamp-ws-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');
const store = await import('../lib/store.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

const handlers = new Map();
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error: () => {} },
  webServer: { register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); } },
  effect(fn) { return fn(); },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
};
apply(ctx, { basePath: BASE });

const project = await store.addProject({ id: 'stampmock', name: '戳 mock', workspace: ws });
const cardPath = store.cardPathOf(project);

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)); });
});

const getStamp = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}${BASE}/api/cards/stamp`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });

  /* 1. 基本形状 */
  const first = await getStamp();
  check('GET /cards/stamp → 200', first.status === 200 && first.body?.ok === true, JSON.stringify(first.body));
  const fileKey = project.file || project.id;
  check('返回该卡的 mtime', Number(first.body?.stamps?.[fileKey]) > 0, JSON.stringify(first.body?.stamps));
  check('不返回卡片正文（只有戳）', !JSON.stringify(first.body).includes('"milestone"'), JSON.stringify(first.body).slice(0, 120));

  /* 2. 写卡后 mtime 变大 */
  const before = Number(first.body.stamps[fileKey]);
  const card = JSON.parse(await readFile(cardPath, 'utf8'));
  card.milestone.title = '改过标题的里程碑';
  await new Promise((r) => setTimeout(r, 12));   // 确保 mtime 有变化（部分文件系统 1s 粒度）
  await store.writeCard(project, card, { lenient: true });
  const second = await getStamp();
  const after = Number(second.body?.stamps?.[fileKey]);
  check('写卡后 mtime 变大（面板据此发现改动）', after > before, `${before} → ${after}`);

  /* 3. 卡片丢了 → 记 0，不 500 */
  await writeFile(cardPath, '{}\n', 'utf8');   // 写坏不是删掉；这里直接删文件更贴近「卡丢了」
  await rm(cardPath, { force: true });
  const third = await getStamp();
  check('卡片文件不存在 → 该卡记 0', third.status === 200 && Number(third.body?.stamps?.[fileKey]) === 0, JSON.stringify(third.body?.stamps));

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} 项失败` : '\n卡片 mtime 戳全部通过');
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error('[mock] 失败：' + (error && error.stack ? error.stack : error));
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
