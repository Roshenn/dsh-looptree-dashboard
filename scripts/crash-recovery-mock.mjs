#!/usr/bin/env node
/**
 * scripts/crash-recovery-mock.mjs — DSH 崩溃/重启后的恢复链路（不装 DSH）。
 *
 *   node scripts/crash-recovery-mock.mjs
 *
 * 假 ctx + 真 http + 真 lib/index.js，覆盖：
 *   1) 会话已存在 → 自动 resume 重接（sessionSource=resumed，卡片 session.id 不变）
 *   2) resume 不可用 + create 撞 already exists → 换新会话（sessionSource=rebound，
 *      capability.plan.session 与 record.session.rebound_from 都写新 id）
 *   3) 失败 → 记录保持打开（失败必须人工处理），error 写进卡片
 *   4) 原地重跑：复用同一 record id，换新会话；成功后 outcome=success 且记录关闭
 *   5) 人工放弃：outcome=abandoned、closed_at 非空、proof 写原因
 *   6) 崩溃对账：本机遗留的 running 记录判失败关闭；别的机器（host 不同）一律不动
 * 退出码 0 = 全部通过。
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'rotation-crash-home-'));
const WS = await mkdtemp(join(tmpdir(), 'rotation-crash-ws-'));
process.env.ROTATION_HOME = HOME;
process.env.DSH_HOME = HOME;

const { apply } = await import('../lib/index.js');
const store = await import('../lib/store.mjs');

const PORT = Number(process.env.PORT || 4195);
const BASE = '/rotation';
const HOST = hostname();
const routes = [];
const handlers = new Map();
const sessions = new Map();
/** 已落盘、可 resume 的会话 id（崩溃前跑过的）；live 里的是本进程还活着的 agent */
const persisted = new Set();
/** resume 是否可用：true → 重接成功；false → 抛错（模拟宿主没有 persistence） */
let resumeWorks = true;

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function emitFor(sessionId, event) {
  for (const fn of handlers.get('session/event') || []) fn({ id: sessionId, header: { cwd: '' } }, event);
}

/** 一次普通回合：turn/start → assistant/message → turn/end（reason 可指定失败） */
async function runTurn(sessionId, reason = 'completed') {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  emitFor(sessionId, { type: 'turn/start', data: { turn: 1 } });
  await wait(20);
  emitFor(sessionId, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'MOCK：做完了。' }] } });
  emitFor(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } });
}

function makeAgent(sessionId, mode = 'ok') {
  const agent = {
    id: sessionId,
    async followup() {
      const sess = sessions.get(sessionId);
      if (sess) sess.followups = (sess.followups || 0) + 1;
      await runTurn(sessionId, mode === 'fail' ? 'error' : 'completed');
    },
    interrupt() {},
    cancel() {},
  };
  return agent;
}

function registerSession(sessionId, mode = 'ok') {
  const sess = { agent: makeAgent(sessionId, mode), mode, goal: null, planMode: false };
  sessions.set(sessionId, sess);
  return sess;
}

const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
  webServer: { register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); } },
  effect(fn) { return fn(); },
  get(name) { return name === 'agentPresets' ? agentPresets : undefined; },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
  goals: {
    get(agent) {
      const sess = sessions.get(agent?.id);
      return sess && sess.goal ? { ...sess.goal } : undefined;
    },
  },
  commands: {
    async execute(agent, line) {
      const sess = sessions.get(agent.id);
      if (!sess) return undefined;
      const text = String(line || '');
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(text);
      if (!match) return undefined;
      const name = match[1];
      const rawInput = text.slice(match[0].length).trim();
      if (name === 'plan') {
        if (rawInput === 'off') { sess.planMode = false; return { kind: 'success', text: 'Plan mode off.' }; }
        sess.planMode = true;
        return { kind: 'success', text: 'Plan mode on.' };
      }
      if (name === 'goal') {
        sess.goal = { objective: rawInput, phase: 'active', roundsStarted: 1, maxGoalRounds: 10, activation: 'armed' };
        // 一轮执行后 goal 完成（runner 每秒读一次 goals phase）
        setTimeout(async () => {
          await runTurn(agent.id, sess.mode === 'fail' ? 'error' : 'completed');
          const cur = sessions.get(agent.id);
          if (cur) cur.goal = { ...(cur.goal || {}), phase: sess.mode === 'fail' ? 'blocked' : 'complete', blockerReason: sess.mode === 'fail' ? 'MOCK：执行失败' : undefined };
        }, 30);
        return { kind: 'success', text: 'Goal created.' };
      }
      return undefined;
    },
  },
  agents: {
    get(sessionId) { return sessions.get(sessionId)?.agent; },
    async create({ sessionId, setup }) {
      if (sessions.has(sessionId) || persisted.has(sessionId)) throw new Error(`session "${sessionId}" already exists`);
      persisted.add(sessionId);
      const sess = registerSession(sessionId, 'ok');
      if (typeof setup === 'function') await setup({ agent: sess.agent }, sess.agent);
      return { agent: sess.agent, dispose: async () => { sessions.delete(sessionId); } };
    },
    async resume({ resumeSessionId, setup }) {
      if (!resumeWorks) throw new Error('cannot resume: session persistence is not configured');
      if (!persisted.has(resumeSessionId)) throw new Error(`session "${resumeSessionId}" is not persisted`);
      // 崩溃重启：磁盘上有会话，但内存里没有 agent → 重新构造一个（模拟 resume）
      const sess = sessions.get(resumeSessionId) || registerSession(resumeSessionId, 'ok');
      sess.resumed = true;
      if (typeof setup === 'function') await setup({ agent: sess.agent }, sess.agent);
      return { agent: sess.agent, dispose: async () => {} };
    },
  },
};

const agentPresets = { async resolve() { return { id: 'mock-preset' }; }, async mount() { return { id: 'mock-preset' }; } };

apply(ctx, { basePath: BASE });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
});
server.listen(PORT, '127.0.0.1');

const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${BASE}/api${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const cardFile = (entry) => join(entry.workspace, '.dsh', 'rotation.json');
const readCardFile = async (entry) => JSON.parse(await readFile(cardFile(entry), 'utf8'));
const waitSettled = async (runKey, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await api('/runs');
    const hit = (body?.runs || []).find((r) => r.key === runKey && !r.settling && ['done', 'failed', 'cancelled'].includes(r.status));
    if (hit) return hit;
    await wait(60);
  }
  return null;
};

/** 建一张卡：一条能力闭环（带计划）+ 一条计划记录；planSession 预置成「已存在」 */
async function seedProject(id, { planSession, nodeId }) {
  const ws = join(WS, id);
  await mkdir(join(ws, '.dsh'), { recursive: true });
  const entry = await store.addProject({ id, name: id, workspace: ws });
  const card = await store.readCard(entry);
  card.project.workspace = join(WS, id);
  card.milestone.vision = '把闭环做完';
  card.milestone.capabilities = '1)候选池能排序';
  card.milestone.children = [{
    id: nodeId, kind: 'capability', title: '候选池排序',
    capability: '候选池能排序', necessity: '不排就靠猜', causal: '排完第一条就能做',
    gap: '缺它只能凭感觉挑', module: 'web/index.html', module_mode: 'existing',
    collaboration: '读候选池文件', metric: '首条采纳率 ≥ 70%', approach: '先排序再展示',
    plan: { goal: '排好序', verify: ['npm run preflight'], steps: ['改排序'], session: planSession, at: new Date().toISOString() },
    status: 'doing', closed_at: null, children: [],
  }];
  await store.writeCard(entry, card, { lenient: true });
  return entry;
}

try {
  /* ── 1. 会话已存在 → resume 重接 ── */
  resumeWorks = true;
  const p1 = await seedProject('crash-resume', { planSession: 'session-existing-1', nodeId: 'c1' });
  persisted.add('session-existing-1');
  const exec1 = await api('/action/exec', { file: p1.file, nodeId: 'c1' });
  check('执行计划 → 200', exec1.status === 200 && exec1.body?.ok === true, JSON.stringify(exec1.body?.error));
  check('已存在的会话被 resume 重接', exec1.body?.run?.sessionSource === 'resumed', JSON.stringify(exec1.body?.run?.sessionSource));
  check('重接后 sessionId 不变', exec1.body?.run?.sessionId === 'session-existing-1', JSON.stringify(exec1.body?.run?.sessionId));
  await waitSettled(exec1.body?.run?.key);

  /* ── 2. resume 不可用 + create 撞 id → 换新会话 ── */
  resumeWorks = false;
  const p2 = await seedProject('crash-rebound', { planSession: 'session-existing-2', nodeId: 'c2' });
  persisted.add('session-existing-2');
  const exec2 = await api('/action/exec', { file: p2.file, nodeId: 'c2' });
  const reboundId = exec2.body?.run?.sessionId || '';
  check('create 撞已存在 → 换新会话继续', exec2.status === 200 && exec2.body?.run?.sessionSource === 'rebound'
    && reboundId && reboundId !== 'session-existing-2', JSON.stringify({ source: exec2.body?.run?.sessionSource, id: reboundId }));
  const card2 = await readCardFile(p2);
  const cap2 = store.findNode(card2.milestone, 'c2');
  const rec2 = (cap2.children || []).find((n) => n.action === 'exec');
  check('卡片 plan.session 换成新 id', cap2.plan?.session === reboundId, JSON.stringify(cap2.plan?.session));
  check('记录标了 rebound_from', rec2?.session?.rebound_from === 'session-existing-2', JSON.stringify(rec2?.session));
  await waitSettled(exec2.body?.run?.key);

  /* ── 3. 失败：记录保持打开（失败必须人工处理） ── */
  resumeWorks = true;
  const p3 = await seedProject('crash-fail', { planSession: 'session-fail-3', nodeId: 'c3' });
  persisted.add('session-fail-3');
  registerSession('session-fail-3', 'fail');
  const exec3 = await api('/action/exec', { file: p3.file, nodeId: 'c3' });
  await waitSettled(exec3.body?.run?.key);
  const card3 = await readCardFile(p3);
  const cap3 = store.findNode(card3.milestone, 'c3');
  const failRec = (cap3.children || []).find((n) => n.action === 'exec');
  check('失败记录保持打开（不自动关闭）', failRec && failRec.closed_at == null, JSON.stringify(failRec?.closed_at));
  check('失败原因写进记录', !!failRec?.error, JSON.stringify(failRec?.error));

  /* ── 4. 原地重跑：同一个 record id，成功后被关闭 ── */
  sessions.get('session-fail-3').mode = 'ok';
  const retry = await api('/action/retry', { file: p3.file, recordId: failRec.id });
  check('重跑 → 200', retry.status === 200 && retry.body?.ok === true, JSON.stringify(retry.body?.error));
  check('重跑复用同一条记录 id', retry.body?.record?.id === failRec.id, JSON.stringify(retry.body?.record));
  const retriedRun = retry.body?.run;
  check('重跑换了新会话', !!retriedRun && retriedRun.sessionId !== 'session-fail-3', JSON.stringify(retriedRun?.sessionId));
  await waitSettled(retriedRun?.key);
  const card3b = await readCardFile(p3);
  const retriedRec = store.findNode(card3b.milestone, failRec.id);
  check('重跑成功后记录关闭且 outcome=success',
    retriedRec?.closed_at != null && retriedRec?.outcome === 'success', JSON.stringify({ closed: retriedRec?.closed_at, outcome: retriedRec?.outcome }));

  /* ── 5. 人工放弃：关闭并写原因 ── */
  const p4 = await seedProject('crash-abandon', { planSession: 'session-ab-4', nodeId: 'c4' });
  persisted.add('session-ab-4');
  registerSession('session-ab-4', 'fail');
  const exec4 = await api('/action/exec', { file: p4.file, nodeId: 'c4' });
  await waitSettled(exec4.body?.run?.key);
  const card4 = await readCardFile(p4);
  const cap4 = store.findNode(card4.milestone, 'c4');
  const abRec = (cap4.children || []).find((n) => n.action === 'exec');
  const abandon = await api('/action/abandon', { file: p4.file, recordId: abRec.id, reason: '会话失效，不再重跑' });
  check('放弃 → 200', abandon.status === 200 && abandon.body?.ok === true, JSON.stringify(abandon.body));
  const card4b = await readCardFile(p4);
  const abandoned = store.findNode(card4b.milestone, abRec.id);
  check('放弃后 outcome=abandoned 且已关闭',
    abandoned?.outcome === 'abandoned' && abandoned?.closed_at != null, JSON.stringify({ o: abandoned?.outcome, c: abandoned?.closed_at }));
  check('放弃原因写进 proof', String(abandoned?.proof || '').includes('放弃'), JSON.stringify(abandoned?.proof));

  /* ── 6. 崩溃对账：只收本机孤儿，别的机器不动 ── */
  const p5 = await seedProject('crash-reconcile', { planSession: 'session-r5', nodeId: 'c5' });
  const card5 = await readCardFile(p5);
  const cap5 = store.findNode(card5.milestone, 'c5');
  cap5.children = [
    { id: 'e-local', kind: 'exec', action: 'exec', title: '本机遗留', status: 'doing', closed_at: null,
      verify: 'npm t', session: { id: 'session-gone', status: 'running', host: HOST, started_at: new Date().toISOString() } },
    { id: 'e-remote', kind: 'exec', action: 'exec', title: '别的机器在跑', status: 'doing', closed_at: null,
      verify: 'npm t', session: { id: 'session-remote', status: 'running', host: 'other-machine', started_at: new Date().toISOString() } },
  ];
  await store.writeCard(p5, card5, { lenient: true });
  await api('/cards');
  const card5b = await readCardFile(p5);
  const local = store.findNode(card5b.milestone, 'e-local');
  const remote = store.findNode(card5b.milestone, 'e-remote');
  check('本机遗留记录判失败并关闭', local?.outcome === 'failed' && local?.closed_at != null, JSON.stringify({ o: local?.outcome, c: local?.closed_at }));
  check('别的机器的记录原样不动', remote?.closed_at == null && remote?.outcome == null && remote?.session?.status === 'running', JSON.stringify(remote?.session));

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} 项失败` : '\n崩溃恢复链路全部通过');
  server.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => {});
  await rm(WS, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error('[mock] 失败：' + (error && error.stack ? error.stack : error));
  server.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => {});
  await rm(WS, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
