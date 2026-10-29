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
const { addProject, readCard, writeCard, findNode } = await import('../lib/store.mjs');

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
      if (!sess) return undefined;
      // 真实语义（@deepseek-ai/dsh-commands#parseCommand）：只切命令名，rawInput 保留换行
      const text = String(line || '');
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(text);
      if (!match) return undefined;
      const name = match[1];
      const rawInput = text.slice(match[0].length).trim();
      sess.commandLines.push(text);
      if (name === 'plan') {
        if (rawInput === 'off') {
          sess.planMode = false;
          return { kind: 'success', text: 'Plan mode off.' };
        }
        sess.planMode = true;
        sess.lastPlanPrompt = rawInput;
        if (rawInput) runPlanTurn(agent.id);
        return { kind: 'success', text: 'Plan mode on.' };
      }
      if (name === 'goal') {
        sess.lastGoalObjective = rawInput;
        sess.goal = { objective: rawInput, phase: 'active', roundsStarted: 0, maxGoalRounds: 10, activation: 'armed' };
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
        commandLines: [], followups: [], lastPlanPrompt: '', lastGoalObjective: '',
      };
      const agent = {
        id: sessionId,
        async followup(message) {
          const text = textOf(message);
          sess.followups.push(text);
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

/** 等指定的那条 run（同名 taskId 可能有多条，用 key 精确定位） */
const waitRunKey = async (key, timeoutMs = 6000) => {
  if (!key) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await api('/runs');
    const run = (body?.runs || []).find((r) => r.key === key);
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
    }, {
      id: 'am-i2', kind: 'idea', title: '回退路径', approach: '命令服务不可用时退回提示词',
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
  // 回归：/plan 带的是多行结构化正文，不是被压成一行的糊墙
  const planPrompt = planSess?.lastPlanPrompt || '';
  check('/plan 带多行正文', planPrompt.split('\n').length > 8, String(planPrompt.split('\n').length));
  check('/plan 正文首行是任务标题', /^生成计划 · 构思「/.test(planPrompt.split('\n')[0]), planPrompt.split('\n')[0]);
  check('/plan 正文有空行分块', planPrompt.includes('\n\n背景\n'), '');
  check('/plan 正文不含 markdown 粗体', !planPrompt.includes('**'), '');

  let after = await readCard(project);
  const idea = after.loop.children[0].children[0];
  check('idea.plan 写入目标', !!idea?.plan && /执行列/.test(idea.plan.goal || ''), JSON.stringify(idea?.plan?.goal || null));
  check('idea.plan 有验证命令', Array.isArray(idea?.plan?.verify) && idea.plan.verify.includes('npm run preflight'), JSON.stringify(idea?.plan?.verify || []));
  check('idea.plan 有步骤', Array.isArray(idea?.plan?.steps) && idea.plan.steps.length >= 2, JSON.stringify(idea?.plan?.steps || []));
  const pRec = (idea?.children || []).find((n) => n.action === 'plan');
  check('计划记录已关闭', !!pRec && !!pRec.closed_at && !!pRec.session, pRec?.id || 'missing');
  check('只出计划不自动闭环构思', !idea?.closed_at, JSON.stringify(idea?.closed_at || null));

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
  // 回归：/goal 只带单行目标，且先 /plan off 再 /goal（同一会话里会累积多条命令，取最后一次）
  const execCmds = execSess?.commandLines || [];
  const offIndex = execCmds.lastIndexOf('/plan off');
  const goalIndex = execCmds.findIndex((line, i) => i > offIndex && line.startsWith('/goal '));
  check('执行先关计划模式', offIndex >= 0 && goalIndex > offIndex, JSON.stringify(execCmds.slice(-2)));
  const goalObjective = execSess?.lastGoalObjective || '';
  check('执行发单行 /goal 目标', !!goalObjective && !goalObjective.includes('\n'), goalObjective.slice(0, 40));
  check('/goal 目标以「执行构思」开头', goalObjective.startsWith('执行构思「'), goalObjective.slice(0, 20));

  // ── 3. 反馈提炼（自动） ──
  const reflectRun = await waitRun((r) => r.taskId === 'action-reflect');
  check('执行完成自动触发提炼', !!reflectRun && reflectRun.status === 'done', reflectRun?.status || 'timeout');

  after = await readCard(project);
  const idea2 = after.loop.children[0].children[0];
  const eRec = (idea2.children || []).find((n) => n.action === 'exec');
  const rRec = (idea2.children || []).find((n) => n.action === 'reflect');
  check('执行记录已关闭', !!eRec && !!eRec.closed_at, eRec?.id || 'missing');
  check('反馈记录已关闭', !!rRec && !!rRec.closed_at, rRec?.id || 'missing');
  check('记录全闭环后构思自动闭环', !!idea2?.closed_at && idea2.status === 'done', JSON.stringify({ closed_at: idea2?.closed_at || null, status: idea2?.status }));
  check('同级构思未完成，目标不提前闭环', !after.loop.children[0].closed_at, JSON.stringify(after.loop.children[0].closed_at || null));
  check('loop.lessons 写入', Array.isArray(after.loop.lessons) && after.loop.lessons.some((l) => /JSON/.test(l.text)), JSON.stringify(after.loop.lessons || []));

  // ── 4. 发送预览里改过的正文：原样发出去 ──
  const overrideText = '# 我改过的计划\n\n## 目标\n用改过的正文跑一次';
  const overridden = await api('/action/plan', { file: project.file, nodeId: 'am-i1', prompt: overrideText });
  check('POST /action/plan 接受 prompt 覆盖', overridden.status === 200, JSON.stringify(overridden.body?.error || ''));
  const overrideRun = await waitRunKey(overridden.body?.run?.key);
  check('覆盖的正文原样进 /plan', (sessions.get(overrideRun?.sessionId)?.lastPlanPrompt || '') === overrideText, '');

  // ── 5. 命令服务不可用：退回同一份结构化正文 ──
  const savedCommands = ctx.commands;
  ctx.commands = undefined;
  const fallbackRes = await api('/action/plan', { file: project.file, nodeId: 'am-i2' });
  const fallbackRun = await waitRunKey(fallbackRes.body?.run?.key);
  ctx.commands = savedCommands;
  const fallbackText = (sessions.get(fallbackRun?.sessionId)?.followups || [])[0] || '';
  check('命令不可用时退回正文', fallbackText.startsWith('生成计划 · 构思「回退路径」'), fallbackText.slice(0, 30));
  check('退回正文同样分块', fallbackText.includes('\n\n背景\n'), '');
  check('退回正文由会话完成', !!fallbackRun && fallbackRun.status === 'done', fallbackRun?.status || 'timeout');

  // ── 6. prompt 模板发起（POST /run）：要挂 preset，且不能覆盖记录节点的动作会话 ──
  const beforeRun = await readCard(project);
  const planRec2 = (findNode(beforeRun.loop, 'am-i2')?.children || []).find((n) => n.action === 'plan');
  const planRecSession = planRec2?.session?.id || '';
  const mountedBefore = mountedPresets;
  const plainRes = await api('/run', {
    file: project.file, nodeId: planRec2?.id, prompt: '给出执行步骤 · 刷新回原句且不写重复进度', taskId: 'steps',
  });
  check('POST /run 接受模板发起', plainRes.status === 200, JSON.stringify(plainRes.body?.error || ''));
  const plainRun = await waitRunKey(plainRes.body?.run?.key);
  check('模板会话跑完', !!plainRun && plainRun.status === 'done', plainRun?.status || 'timeout');
  // 回归：模板会话也要能读仓库（bash / read / write 都在 preset 里，不挂就只剩记忆）
  check('模板会话挂了 agent preset', sessions.get(plainRun?.sessionId)?.createdWith === 'mock-preset',
    sessions.get(plainRun?.sessionId)?.createdWith || 'none');
  check('模板会话真的 mount 了 preset', mountedPresets > mountedBefore, `${mountedBefore} → ${mountedPresets}`);
  // 回归：普通会话不覆盖记录节点的 session 位（否则计划记录会显示一条从没发过 /plan 的会话）
  const afterRun = await readCard(project);
  const planRec2b = findNode(afterRun.loop, planRec2?.id);
  check('记录节点 session 不被普通会话覆盖', (planRec2b?.session?.id || '') === planRecSession,
    `${planRecSession || 'none'} vs ${planRec2b?.session?.id || 'none'}`);
  check('记录节点保持动作会话的结论', planRec2b?.status === 'done' && !!planRec2b?.closed_at, planRec2b?.status || '?');

  // ── 7. host 不级联：目标 / 闭环必须由面板手动「确认收敛」 ──
  // 把同级构思补成已关闭，让目标满足「子项全闭环」，再跑一次动作确认 host 不会顺手关目标
  const cascadeSeed = await readCard(project);
  const goalSeed = cascadeSeed.loop.children[0];
  const sibling = (goalSeed.children || []).find((k) => k.id === 'am-i2');
  sibling.closed_at = new Date().toISOString();
  sibling.status = 'done';
  await writeCard(project, cascadeSeed, { lenient: true });
  const cascadeRes = await api('/action/plan', { file: project.file, nodeId: 'am-i1', prompt: '# 再跑一次\n\n## 目标\n验证 host 不级联' });
  check('级联验证：动作可再次发起', cascadeRes.status === 200, JSON.stringify(cascadeRes.body?.error || ''));
  await waitRunKey(cascadeRes.body?.run?.key);
  const cascadeAfter = await readCard(project);
  const cascadeIdea = findNode(cascadeAfter.loop, 'am-i1');
  check('级联验证：构思仍自动闭环', !!cascadeIdea?.closed_at, JSON.stringify(cascadeIdea?.closed_at || null));
  check('级联验证：目标不被 host 自动闭环', !cascadeAfter.loop.children[0].closed_at,
    JSON.stringify(cascadeAfter.loop.children[0].closed_at || null));
  check('级联验证：闭环不被 host 自动闭环', !cascadeAfter.loop.closed_at,
    JSON.stringify(cascadeAfter.loop.closed_at || null));
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
