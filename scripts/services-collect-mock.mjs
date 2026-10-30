#!/usr/bin/env node
/**
 * scripts/services-collect-mock.mjs — 假 ctx 验证「服务信息收集」，不需要 DSH。
 *
 *   node scripts/services-collect-mock.mjs
 *
 * 覆盖：
 *   · POST /api/services/collect 起会话 → 结束后把候选落成草稿
 *   · 草稿里的 start 统一成 { mac, windows }；url 不合法 / 缺 url 的条目被丢掉
 *   · GET /api/services 带上当前平台，startCommand 按平台解析
 *   · PUT /api/services 只替换 services 字段（校验后原子写），写完草稿清掉
 *   · POST /api/services/probe 真发请求探活
 *   · 模型回非 JSON → 草稿带 error，不写卡片
 *   · 平台缺命令时 start() 给出可读错误，不会拿另一平台的命令硬跑
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 4193);
const BASE = '/rotation';
const home = await mkdtemp(join(tmpdir(), 'rotation-svc-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-svc-ws-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;
// 全局上限调成 2，方便在 mock 里验证第 3 个请求拿到 429
process.env.ROTATION_MAX_CONCURRENT = '2';

const { apply } = await import('../lib/index.js');
const { createServiceRunner, resolvePlatformValue } = await import('../lib/services.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/* ── 假宿主：agents.create 每次 followup 吐一条脚本化回复 ── */
const handlers = new Set();
const replies = [];
const emit = (id, meta, event) => { for (const fn of handlers) fn({ id, header: { cwd: meta?.cwd } }, event); };
const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
  on(event, handler) {
    if (event !== 'session/event') return () => {};
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
  agents: {
    async create({ sessionId, meta }) {
      return {
        agent: {
          id: sessionId,
          async followup() {
            const text = replies.shift() || '';
            setTimeout(() => emit(sessionId, meta, { type: 'turn/start', data: { turn: 1 } }), 40);
            setTimeout(() => emit(sessionId, meta, { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }), 110);
            setTimeout(() => emit(sessionId, meta, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), 170);
          },
          interrupt() {},
        },
      };
    },
  },
  webServer: {
    register(options) {
      routes.push(options);
      return () => { const i = routes.indexOf(options); if (i >= 0) routes.splice(i, 1); };
    },
  },
  effect(fn) { return fn(); },
};
const routes = [];

/* ── 种子：三个没有 services 的项目卡片（验证并发按项目隔离） ── */
const FILE = 'svc.rotation.json';
const FILE_B = 'svcb.rotation.json';
const FILE_C = 'svcc.rotation.json';
const CARD = {
  schema: 'rotation/v1',
  project: { name: '服务收集 Mock', workspace: ws },
  updated: null,
  milestone: {
    id: 'svc-ms', kind: 'milestone', title: '服务信息收集', vision: '自动补齐项目服务',
    acceptance: 'mock 断言全绿', status: 'plan', closed_at: null, children: [],
  },
};
const wsB = await mkdtemp(join(tmpdir(), 'rotation-svc-ws-b-'));
const wsC = await mkdtemp(join(tmpdir(), 'rotation-svc-ws-c-'));
async function seedProject(dir, file, name, loopId) {
  const card = JSON.parse(JSON.stringify(CARD));
  card.project = { name, workspace: dir };
  card.milestone.id = loopId;
  await mkdir(join(dir, '.dsh'), { recursive: true });
  await writeFile(join(dir, '.dsh', 'rotation.json'), JSON.stringify(card, null, 1) + '\n', 'utf8');
  return { id: file.replace('.rotation.json', ''), name, workspace: dir, file };
}
await mkdir(home, { recursive: true });
await writeFile(join(home, 'registry.json'), JSON.stringify([
  await seedProject(ws, FILE, '服务收集 Mock', 'svc-loop'),
  await seedProject(wsB, FILE_B, '服务收集 Mock B', 'svcb-loop'),
  await seedProject(wsC, FILE_C, '服务收集 Mock C', 'svcc-loop'),
], null, 1) + '\n', 'utf8');

apply(ctx, { basePath: BASE });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => pathname.startsWith(r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${PORT}${BASE}`;

const getJson = async (path) => {
  const res = await fetch(origin + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sendJson = async (method, path, body) => {
  const res = await fetch(origin + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cardOnDisk = async () => JSON.parse(await readFile(join(ws, '.dsh', 'rotation.json'), 'utf8'));

try {
  const GOOD = JSON.stringify({
    services: [
      { id: 'web', name: '本地预览 5273', url: 'http://127.0.0.1:5273', health: '/',
        start: { mac: 'pnpm dev', windows: 'pnpm.cmd dev' }, evidence: 'vite.config.ts:12', confidence: 'high' },
      { id: 'api', name: 'API 8786', url: 'http://127.0.0.1:8786', health: '/api/health',
        start: { mac: 'PORT=8786 pnpm --filter @echo/server dev', windows: 'set PORT=8786 && pnpm --filter @echo/server dev' } },
      { name: '没有 url 的服务' },
      { id: 'bad', name: '坏地址', url: 'not-a-url', start: 'x' },
    ],
  });
  replies.push(GOOD, GOOD);   // A、B 各一次会话

  /* 1. 并发：不同项目可同时收集；同项目串行；全局受上限约束 */
  const started = await sendJson('POST', '/api/services/collect', { file: FILE });
  check('收集会话已发起', started.status === 200 && started.body?.ok === true, JSON.stringify(started.body));
  check('返回 run.key', typeof started.body?.run?.key === 'string', JSON.stringify(started.body?.run?.key));
  const startedB = await sendJson('POST', '/api/services/collect', { file: FILE_B });
  check('另一个项目可同时收集（不再全局 409）', startedB.status === 200 && startedB.body?.ok === true, JSON.stringify(startedB.body));
  const againA = await sendJson('POST', '/api/services/collect', { file: FILE });
  check('同一项目第二次仍 409', againA.status === 409, JSON.stringify(againA.body));
  const startedC = await sendJson('POST', '/api/services/collect', { file: FILE_C });
  check('超过 ROTATION_MAX_CONCURRENT 返回 429', startedC.status === 429, JSON.stringify(startedC.body));

  /* 2. 等两份草稿（A、B 各一份，互不覆盖） */
  let draft = null, draftB = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    if (!draft || !Array.isArray(draft.services) || !draft.services.length) {
      draft = (await getJson('/api/services/collect?file=' + encodeURIComponent(FILE))).body?.draft || draft;
    }
    if (!draftB || !Array.isArray(draftB.services) || !draftB.services.length) {
      draftB = (await getJson('/api/services/collect?file=' + encodeURIComponent(FILE_B))).body?.draft || draftB;
    }
    if (draft?.services?.length && draftB?.services?.length) break;
  }
  check('草稿已落盘', !!draft && Array.isArray(draft.services), JSON.stringify(draft));
  check('B 项目草稿独立落盘', !!draftB && draftB.file === FILE_B && draftB.services?.length === 2, JSON.stringify(draftB));
  check('只保留合法 url 的条目', draft?.services?.length === 2, `got ${draft?.services?.length}`);
  check('start 归一成 mac/windows', JSON.stringify(draft?.services?.[0]?.start) === JSON.stringify({ mac: 'pnpm dev', windows: 'pnpm.cmd dev' }),
    JSON.stringify(draft?.services?.[0]?.start));
  check('保留证据与置信度', draft?.services?.[0]?.evidence === 'vite.config.ts:12' && draft?.services?.[0]?.confidence === 'high',
    JSON.stringify(draft?.services?.[0]));

  /* 3. 探活：拿 mock 服务自己的 health 当目标 */
  const probed = await sendJson('POST', '/api/services/probe', { url: origin + '/api/health' });
  check('探活接口可用', probed.status === 200 && probed.body?.probe?.ok === true, JSON.stringify(probed.body));
  const probeBad = await sendJson('POST', '/api/services/probe', { url: 'ftp://x' });
  check('非法 url 被拒', probeBad.status === 400, JSON.stringify(probeBad.body));

  /* 4. 写回：只替换 services，草稿随后清掉 */
  const edited = draft.services.map((s, i) => (i === 0 ? { ...s, name: '本地预览（改名）' } : s));
  const put = await sendJson('PUT', '/api/services', { file: FILE, services: edited });
  check('写回成功', put.status === 200 && put.body?.ok === true, JSON.stringify(put.body));
  const disk = await cardOnDisk();
  check('卡片里有了 services', Array.isArray(disk.services) && disk.services.length === 2, JSON.stringify(disk.services));
  check('写回的是平台映射', JSON.stringify(disk.services?.[0]?.start) === JSON.stringify({ mac: 'pnpm dev', windows: 'pnpm.cmd dev' }),
    JSON.stringify(disk.services?.[0]?.start));
  check('改名生效', disk.services?.[0]?.name === '本地预览（改名）', disk.services?.[0]?.name);
  const afterPut = await getJson('/api/services/collect?file=' + encodeURIComponent(FILE));
  check('写回后草稿已清', afterPut.body?.draft === null, JSON.stringify(afterPut.body?.draft));

  /* 5. GET /api/services：写回后再读，按当前平台解析 start */
  const listed = await getJson('/api/services?file=' + encodeURIComponent(FILE));
  const platform = listed.body?.platform;
  check('返回当前平台', !!platform && typeof platform.label === 'string', JSON.stringify(platform));
  const firstSvc = listed.body?.services?.[0];
  const wantCommand = resolvePlatformValue({ mac: 'pnpm dev', windows: 'pnpm.cmd dev' }, process.platform);
  check('startCommand 按平台解析', firstSvc?.startCommand === wantCommand, `${firstSvc?.startCommand} vs ${wantCommand}`);
  check('startPlatforms 标出两端', (firstSvc?.startPlatforms || []).includes('mac') && (firstSvc?.startPlatforms || []).includes('windows'),
    JSON.stringify(firstSvc?.startPlatforms));

  /* 6. 清空 / 非法请求 */
  const cleared = await sendJson('PUT', '/api/services', { file: FILE, services: [] });
  check('传空数组清空 services', cleared.status === 200 && (await cardOnDisk()).services === undefined, JSON.stringify(await cardOnDisk()));
  const badPut = await sendJson('PUT', '/api/services', { file: FILE, services: 'nope' });
  check('非数组被拒 400', badPut.status === 400, JSON.stringify(badPut.body));

  /* 7. 模型回非 JSON：草稿带 error，不写卡片 */
  replies.push('我觉得有三个服务：web、api、db。');
  const started2 = await sendJson('POST', '/api/services/collect', { file: FILE });
  check('第二次收集已发起', started2.status === 200, JSON.stringify(started2.body));
  let draft2 = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    const got = await getJson('/api/services/collect?file=' + encodeURIComponent(FILE));
    draft2 = got.body?.draft;
    if (draft2 && (draft2.error || (draft2.services || []).length)) break;
  }
  check('非 JSON 结果落到 error', !!draft2 && !!draft2.error, JSON.stringify(draft2));
  check('解析失败不动卡片', (await cardOnDisk()).services === undefined, JSON.stringify((await cardOnDisk()).services));

  /* 8. 平台缺命令：不拿别的平台的命令硬跑 */
  const runner = createServiceRunner({ logger: { info() {} } });
  const onlyMac = { services: [{ id: 'web', name: 'web', url: 'http://127.0.0.1:1', start: { mac: 'pnpm dev' } }] };
  const linuxStart = runner.start('p', onlyMac, 'web', ws, 'linux');
  check('linux 缺命令时拒绝启动', linuxStart.ok === false && /linux/.test(linuxStart.error || ''), JSON.stringify(linuxStart));
  check('平台解析：win32 拿 windows 命令',
    resolvePlatformValue({ mac: 'a', windows: 'b' }, 'win32') === 'b');
} catch (error) {
  check('mock 未抛异常', false, error.stack || error.message);
} finally {
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
