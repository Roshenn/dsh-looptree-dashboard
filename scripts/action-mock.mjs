#!/usr/bin/env node
/**
 * scripts/action-mock.mjs — 动作链路端到端烟测（不装 DSH）。
 *
 *   node scripts/action-mock.mjs
 *
 * 用假 ctx 驱动真实的 lib/index.js：
 *   POST /api/action/plan  → 假命令服务 /plan + 假 agent 交 exit_plan_mode 计划
 *                          → 卡片写入 idea.plan，记录 p1 关闭
 *   POST /api/action/exec  → 同一 session 走 /goal，goal phase 由 active → complete
 *                          → 执行记录关闭，并自动起一次反馈提炼
 *   反馈提炼               → 假 agent 返回 JSON lessons → 写入 loop.lessons，记录 r1 关闭
 *
 * 临时 ROTATION_HOME / 工作区，跑完清理；退出码 0 = 全链路通过。
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 注册表目录在 store.mjs 模块加载时定死，必须先指到临时目录再动态 import
const HOME = await mkdtemp(join(tmpdir(), 'rotation-action-home-'));
const WS = await mkdtemp(join(tmpdir(), 'rotation-action-ws-'));
process.env.ROTATION_HOME = HOME;
const { apply } = await import('../lib/index.js');
const { addProject, readCard, writeCard } = await import('../lib/store.mjs');

const PORT = Number(process.env.PORT || 4191);
const BASE = '/rotation';
const routes = [];
const handlers = new Map();          // event name → Set<fn>
const sessions = new Map();          // sessionId → { agent, planMode, goal, emits }

const PLAN_MD = [
  '# 执行列改成会话记录',
  '',
  '## 目标',
  '构思卡只留生成计划与执行计划两个动作，执行列只显示会话记录。',
  '',
  '## 验证命令',
  '```bash',
  'npm run preflight',
  '```',
  '',
  '## 步骤',
  '1. 改 lib/runner.mjs 支持同会话续跑',
  '2. 改 web/index.html 的动作按钮',
  '3. 跑 npm run preflight',
  '',
].join('\n');

const REFLECT_JSON = JSON.stringify({
  lessons: ['先定记录 JSON 形状再写两侧，避免 host 与面板字段对不上'],
});

function emitFor(sessionId, event) {
  for (const fn of handlers.get('session/event') || []) {
    fn({ id: sessionId, header: { cwd: '' } }, event);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (message) => {
  const blocks = message?.content ?? message?.message?.content;
  return Array.isArray(blocks)
    ? blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    : '';
};

/** 一次普通回合：turn/start → assistant/message → turn/end */
async function runTurn(sessionId, text, extra = {}) {
  emitFor(sessionId, { type: 'turn/start', data: { turn: 1 } });
  emitFor(sessionId, { type: 'step/start', data: { turn: 1, step: 1 } });
  await wait(30);
  emitFor(sessionId, { type: 'assistant/message', data: { content: [{ type: 'text', text }] } });
  for (const ev of extra.events || []) emitFor(sessionId, ev);
  emitFor(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
}

/** 计划回合：研究后调用 exit_plan_mode 交计划 */
async function runPlanTurn(sessionId) {
  emitFor(sessionId, { type: 'turn/start', data: { turn: 1 } });
  await wait(20);
  emitFor(sessionId, { type: 'tool/call', data: { name: 'exit_plan_mode', input: { plan: PLAN_MD } } });
  emitFor(sessionId, {
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: '计划已提交，等待确认。' }] },
  });
  emitFor(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
}

/** /goal 创建后由轮次驱动：active → 一轮执行 → complete */
async function runGoalRounds(sessionId) {
  const sess = sessions.get(sessionId);
  await wait(60);
  await runTurn(sessionId, 'MOCK：按计划改完，验证命令全绿。');
  await wait(60);
  if (sess) sess.goal = { ...(sess.goal || {}), phase: 'complete' };
}

const ctx = {
  logger: console,
  webServer: { register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); } },
  effect(fn) { return fn(); },
  /** 真实宿主上 sessionController / agentPresets 都挂在 ctx 上；runner 走 ctx.get 取 preset */
  get(name) {
    if (name === 'agentPresets') return agentPresets;
    return undefined;
  },
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
      return sess?.goal ? { ...sess.goal } : undefined;
    },
  },
  commands: {
    async execute(agent, line) {
      const sess = sessions.get(agent.id);
      const raw = String(line || '').trim();
      if (!sess) return undefined;
      if (raw === '/plan' || raw.startsWith('/plan ')) {
        const message = raw.slice('/plan'.length).trim();
        sess.planMode = true;
        if (message) runPlanTurn(agent.id);
        return { kind: 'success', text: 'Plan mode on.' };
      }
      if (raw === '/plan off') {
        sess.planMode = false;
        return { kind: 'success', text: 'Plan mode off.' };
      }
      if (raw.startsWith('/goal ')) {
        sess.goal = { objective: raw.slice('/goal'.length).trim(), phase: 'active', roundsStarted: 0, maxGoalRounds: 10, activation: 'armed' };
        runGoalRounds(agent.id);
        return { kind: 'success', text: 'Goal created.' };
      }
      return undefined;
    },
  },
  agents: {
    async create({ sessionId, meta, setup }) {
      // 会话头要带 agentPreset；preset 的 setup 要真的被调（工具 / 命令都在里面挂）
      const sess = {
        agent: null, planMode: false, goal: null,
        createCount: 0, createdWith: meta?.agentPreset || '', setupCalled: false, cancelCalls: 0,
      };
      const agent = {
        id: sessionId,
        async followup(message) {
          const text = textOf(message);
          if (/lessons|复盘|经验/i.test(text)) {
            await runTurn(sessionId, REFLECT_JSON);
            return;
          }
          await runPlanTurn(sessionId);
        },
        interrupt() {},
        cancel() { sess.cancelCalls += 1; },
      };
      sess.agent = agent;
      sess.createCount += 1;
      if (typeof setup === 'function') {
        await setup({ agent }, agent);
        sess.setupCalled = true;
      }
      sessions.set(sessionId, sess);
      return { agent };
    },
  },
};

/** 假的 agentPresets：runner 用 resolve 取默认 preset、mount 挂到 agent ctx */
const agentPresets = {
  async resolve() { return { id: 'mock-preset' }; },
  async mount() { mountedPresets += 1; return { id: 'mock-preset' }; },
};
let mountedPresets = 0;

apply(ctx, { basePath: BASE });

const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
});

const api = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${BASE}/api${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const waitRun = async (match, timeoutMs = 6000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await api('/runs');
    const run = (body?.runs || []).find(match);
    if (run && ['done', 'failed', 'cancelled'].includes(run.status)) return run;
    await wait(80);
  }
  return null;
};

let ok = true;
try {
  const project = await addProject({ id: 'actionmock', name: 'ActionMock', workspace: WS });
  const card = await readCard(project);
  card.project = { ...(card.project || {}), name: 'ActionMock', workspace: WS };
  card.loop.title = '动作链路烟测';
  card.loop.intent = '验证生成计划 → 执行计划 → 反馈提炼';
  card.loop.acceptance = '三条记录关闭、idea.plan 与 loop.lessons 写入';
  card.loop.children = [{
    id: 'am-g1', kind: 'goal', title: '动作链路可跑通', acceptance: '链路断言全绿',
    status: 'doing', closed_at: null,
    children: [{
      id: 'am-i1', kind: 'idea', title: '构思动作与记录列', approach: '面板动作交给 DSH 会话',
      status: 'ready', closed_at: null, children: [],
    }],
  }];
  await writeCard(project, card, { lenient: true });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  // ── 1. 生成计划 ──
  const planned = await api('/action/plan', { file: project.file, nodeId: 'am-i1' });
  check('POST /action/plan 起会话', planned.status === 200 && planned.body?.run?.status !== undefined, JSON.stringify(planned.body?.error || ''));
  const planRun = await waitRun((r) => r.taskId === 'action-plan');
  check('计划会话跑完', !!planRun && planRun.status === 'done', planRun?.status || 'timeout');
  // 回归：命令 / exit_plan_mode 都在 agent preset 里，不挂 preset 时会话根本进不了 plan 模式
  const planSess = sessions.get(planRun?.sessionId);
  check('计划会话挂了 agent preset', planSess?.createdWith === 'mock-preset', planSess?.createdWith || 'none');
  check('preset setup 已执行', !!planSess?.setupCalled);
  // 计划拿到就收手：exit_plan_mode 的审批回合要中断，别让它批准后直接开跑
  check('计划拿到后中断审批回合', (planSess?.cancelCalls || 0) >= 1, String(planSess?.cancelCalls || 0));

  let after = await readCard(project);
  const idea = after.loop.children[0].children[0];
  check('idea.plan 写入目标', !!idea?.plan && /执行列/.test(idea.plan.goal || ''), JSON.stringify(idea?.plan?.goal || null));
  check('idea.plan 有验证命令', Array.isArray(idea?.plan?.verify) && idea.plan.verify.includes('npm run preflight'), JSON.stringify(idea?.plan?.verify || []));
  check('idea.plan 有步骤', Array.isArray(idea?.plan?.steps) && idea.plan.steps.length >= 2, JSON.stringify(idea?.plan?.steps || []));
  const pRec = (idea?.children || []).find((n) => n.action === 'plan');
  check('计划记录已关闭', !!pRec && !!pRec.closed_at && !!pRec.session, pRec?.id || 'missing');

  // ── 2. 执行计划（同会话） ──
  const planSession = pRec?.session?.id;
  const execRes = await api('/action/exec', { file: project.file, nodeId: 'am-i1' });
  check('POST /action/exec 起会话', execRes.status === 200, JSON.stringify(execRes.body?.error || ''));
  const execRun = await waitRun((r) => r.taskId === 'action-exec');
  check('执行会话等 goal 完成才结束', !!execRun && execRun.status === 'done', execRun?.status || 'timeout');
  check('执行复用同一 session', !!planSession && execRun?.sessionId === planSession, `${planSession} vs ${execRun?.sessionId}`);
  const execSess = sessions.get(execRun?.sessionId);
  check('执行复用已挂 preset 的 agent', execSess?.createCount === 1 && execSess?.createdWith === 'mock-preset',
    `create=${execSess?.createCount || 0} preset=${execSess?.createdWith || 'none'}`);

  // ── 3. 反馈提炼（自动） ──
  const reflectRun = await waitRun((r) => r.taskId === 'action-reflect');
  check('执行完成自动触发提炼', !!reflectRun && reflectRun.status === 'done', reflectRun?.status || 'timeout');

  after = await readCard(project);
  const idea2 = after.loop.children[0].children[0];
  const eRec = (idea2.children || []).find((n) => n.action === 'exec');
  const rRec = (idea2.children || []).find((n) => n.action === 'reflect');
  check('执行记录已关闭', !!eRec && !!eRec.closed_at, eRec?.id || 'missing');
  check('反馈记录已关闭', !!rRec && !!rRec.closed_at, rRec?.id || 'missing');
  check('loop.lessons 写入', Array.isArray(after.loop.lessons) && after.loop.lessons.some((l) => /JSON/.test(l.text)), JSON.stringify(after.loop.lessons || []));
} catch (error) {
  ok = false;
  console.error('[action-mock] 异常：', error);
} finally {
  server.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => {});
  await rm(WS, { recursive: true, force: true }).catch(() => {});
}
const failed = results.filter((r) => !r.pass).length;
if (failed) ok = false;
console.log(failed ? `\n${failed} 项失败` : '\n动作链路全部通过');
process.exit(ok ? 0 : 1);
