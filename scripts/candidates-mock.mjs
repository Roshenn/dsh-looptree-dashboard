#!/usr/bin/env node
/**
 * scripts/candidates-mock.mjs — 候选池全链路（host 级，不需要 DSH）。
 *
 *   node scripts/candidates-mock.mjs
 *   PORT=4193 node scripts/candidates-mock.mjs
 *
 * 仿 dev-session-mock：假 ctx + 真 http + fetch，用临时 ROTATION_HOME / 工作区，
 * 让真实候选池路由跑一遍。覆盖：
 *   · POST /candidates/generate：无重要支撑 → 409 SUPPORTS_REQUIRED
 *   · 假 agent 返回候选 JSON 数组 → 池文件按 importance 降序、字段完整（title/support/
 *     necessity/causal/evidence/importance）、缺 necessity / causal 的条目被丢弃
 *   · POST /candidates/adopt：写出 support 节点，只读三件套（support/necessity/causal）
 *     从候选带过来，status=plan、closed_at=null、children=[]，且不清空候选池
 * 退出码 0 = 全部通过。
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4193);
const BASE = '/rotation';

const home = await mkdtemp(join(tmpdir(), 'rotation-cand-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-cand-ws-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');
const store = await import('../lib/store.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/* ── 假 agent：一次 followup 吐一段候选 JSON 数组，再 turn/end ── */
const CANDIDATE_REPLY = JSON.stringify([
  // 重要性 2，字段完整
  { title: '统一索引层', support: '章节→情节两层索引', necessity: '三层图没有共享 id 就对不上', causal: '没有索引 → 三层图无法按章节重组 → 切换章节错位', importance: 2, evidence: 'src/plot/index.ts 不存在' },
  // 重要性 5，字段完整（应排第一）
  { title: '分层渲染管线', support: '分层 SVG 绘制', necessity: '三层要独立更新又必须叠加对齐', causal: '不分层 → 改一层整图重绘 → 首屏 800ms 达不到', importance: 5, evidence: 'src/render/layer.ts:12' },
  // 缺 causal → 丢弃
  { title: '缺因果的候选', support: '章节→情节两层索引', necessity: '这条必要性写了', importance: 4, evidence: 'x' },
  // 重要性 3，字段完整
  { title: '缓存命中率', support: '章节 id 缓存与首屏测量', necessity: '不缓存就重复绘制', causal: '每次切章节重画三层 → 首屏 1.1s → 需要缓存', importance: 3, evidence: 'bench/first-paint.log' },
  // 缺 necessity → 丢弃
  { title: '缺必要性的候选', support: '分层 SVG 绘制', causal: '只有因果没有必要性', importance: 5, evidence: 'y' },
]);

const handlers = new Map();
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
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
    async create({ sessionId }) {
      const emit = (event) => {
        for (const fn of handlers.get('session/event') || []) fn({ sessionId, ...event });
      };
      const agent = {
        id: sessionId,
        cwd: ws,
        async followup() {
          setTimeout(() => emit({ type: 'turn/start', data: { turn: 1 } }), 10);
          setTimeout(() => emit({ type: 'step/start', data: { turn: 1, step: 1 } }), 20);
          setTimeout(() => emit({
            type: 'assistant/message',
            data: { content: [{ type: 'text', text: CANDIDATE_REPLY }] },
          }), 30);
          setTimeout(() => emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), 40);
        },
        interrupt() {},
      };
      return { agent };
    },
  },
};
apply(ctx, { basePath: BASE });

/* ── 建项目 + 写一张带重要支撑的里程碑卡 ── */
const project = await store.addProject({ id: 'candmock', name: '候选 mock', workspace: ws });
const NODE_ID = 'candmock-milestone';
const cardPath = store.cardPathOf(project);
const card = JSON.parse(await readFile(cardPath, 'utf8'));
card.project.vision = '打开项目就能看到三层情节图，不用读代码。';
card.milestone = {
  id: NODE_ID,
  kind: 'milestone',
  title: '3 情节层渲染可视化',
  vision: '打开项目就能看到三层情节图，不用读代码。',
  supports: '1)章节→情节两层索引\n2)分层 SVG 绘制\n3)章节 id 缓存与首屏测量',
  metrics: '1)首屏渲染 < 800ms\n2)三层图各 ≥8 节点，可折叠',
  status: 'plan',
  closed_at: null,
  children: [],
};
await store.writeCard(project, card, { lenient: true });

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
const post = (path, body) => fetchJson(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等候选池落地（onFinish 是异步的） */
async function waitPool(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchJson(`/candidates?file=${encodeURIComponent(project.file)}&nodeId=${NODE_ID}`);
    if (res.status === 200 && Array.isArray(res.body?.candidates) && res.body.candidates.length) return res.body.candidates;
    await sleep(40);
  }
  return [];
}

try {
  server.listen(PORT, '127.0.0.1', async () => {
    try {
      /* 1. 生成候选：假 agent 吐 5 条，2 条缺必要字段被丢，其余按 importance 降序 */
      const gen = await post('/candidates/generate', { file: project.file, nodeId: NODE_ID, count: 3 });
      check('生成候选 → 200', gen.status === 200 && gen.body?.ok === true, JSON.stringify(gen.body));
      check('生成条数不超过重要支撑条数', gen.body?.want === 3, String(gen.body?.want));
      const pool = await waitPool();
      check('候选池落盘 3 条（缺 necessity / causal 的各丢 1 条）', pool.length === 3, JSON.stringify(pool));
      check('按 importance 降序', pool.map((c) => c.importance).join(',') === '5,3,2', pool.map((c) => c.importance).join(','));
      check('池里没有缺 causal 的条目', !pool.some((c) => c.title === '缺因果的候选'), JSON.stringify(pool.map((c) => c.title)));
      check('池里没有缺 necessity 的条目', !pool.some((c) => c.title === '缺必要性的候选'), JSON.stringify(pool.map((c) => c.title)));
      const fieldsOk = pool.every((c) => ['title', 'support', 'necessity', 'causal', 'evidence', 'importance'].every((k) => k in c));
      check('每条候选字段完整', fieldsOk, JSON.stringify(pool[0]));
      const filePool = JSON.parse(await readFile(join(home, '.dsh', 'rotation', 'candidates', `${project.file.replace(/[^\w.-]/g, '_')}__${NODE_ID}.json`), 'utf8'));
      check('池文件与 GET 一致', JSON.stringify(filePool) === JSON.stringify(pool), JSON.stringify(filePool).slice(0, 120));

      /* 2. 采纳 → 写 support 节点（只读三件套），不清池 */
      const chosen = pool[0];
      const adopt = await post('/candidates/adopt', { file: project.file, nodeId: NODE_ID, index: 0 });
      check('采纳候选 → 200', adopt.status === 200 && adopt.body?.ok === true, JSON.stringify(adopt.body));
      const after = JSON.parse(await readFile(cardPath, 'utf8'));
      const child = (after.milestone.children || []).find((n) => n.id === adopt.body?.child?.id);
      check('卡片写入 support 子节点', !!child && child.kind === 'support', JSON.stringify(after.milestone.children));
      check('support 带三件套（承接支撑项 / 必要性 / 因果）',
        child?.support === chosen.support && child?.necessity === chosen.necessity && child?.causal === chosen.causal,
        JSON.stringify(child));
      check('support 初始 status=plan / closed_at=null / children=[]',
        child?.status === 'plan' && child?.closed_at === null && Array.isArray(child?.children) && child.children.length === 0,
        JSON.stringify(child));
      check('采纳后候选池不清空（剩 2 条）', adopt.body?.remaining === 2, String(adopt.body?.remaining));
      const left = (await fetchJson(`/candidates?file=${encodeURIComponent(project.file)}&nodeId=${NODE_ID}`)).body?.candidates || [];
      check('采纳后 pool 剩 2 条', left.length === 2, JSON.stringify(left.map((c) => c.title)));

      /* 3. 里程碑没有重要支撑 → 409 SUPPORTS_REQUIRED */
      await post('/candidates/delete', { file: project.file, nodeId: NODE_ID, all: true });
      const noSupport = JSON.parse(await readFile(cardPath, 'utf8'));
      noSupport.milestone.supports = '';
      await store.writeCard(project, noSupport, { lenient: true });
      const rejected = await post('/candidates/generate', { file: project.file, nodeId: NODE_ID, count: 3 });
      check('无重要支撑 → 409 SUPPORTS_REQUIRED',
        rejected.status === 409 && rejected.body?.code === 'SUPPORTS_REQUIRED',
        JSON.stringify({ status: rejected.status, body: rejected.body }));

      const failed = results.filter((r) => !r.pass);
      console.log(failed.length ? `\n${failed.length} 项失败` : '\n候选池链路全部通过');
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
  });
} catch (error) {
  console.error('[mock] 启动失败：' + error.message);
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
