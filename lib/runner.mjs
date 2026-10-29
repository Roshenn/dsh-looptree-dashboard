/**
 * lib/runner.mjs — 节点会话执行器（host 半，M2 + action-records）
 *
 * 走 DSH 进程内的 agent 服务，因此模型凭据 / provider 路由沿用 GUI 已配置的那套，
 * 不再 spawn `dsh --profile headless`（那条路会绕过网关，且 headless profile 没有凭据插件）。
 *
 * 用到的接口：
 *   ctx.agentDefaultModel.currentSelection() -> { provider, model }
 *   ctx.agents.create({ sessionId, agentOptions, meta:{cwd}, setup }) -> { agent }
 *   agent.followup(createUserMessage({ content, source }))
 *   ctx.commands.execute(agent, line, submittedAttachments, signal) -> CommandExecution | undefined
 *   ctx.goals.get(agent) -> { phase:'active'|'paused'|'blocked'|'complete', blockerReason? }
 *   ctx.on('session/event', handler)   // 事件流
 *
 * 两种驱动方式：
 *   1) 提示词（补全 / 候选 / 拆目标 / 反馈）：一次 followup，turn/end 即结束；
 *   2) 斜杠命令（生成计划 / 执行计划）：ctx.commands.execute(agent, line, [], signal)，
 *      宿主没提供命令服务、命令返回 undefined 时退回 followup 提示词。
 *
 * 同 sessionId 复用同一个 agent：计划 → 执行 → 反馈 走同一个会话，上下文不断。
 * 事件 → 状态：turn/start → running；tool/call(exit_plan_mode) → planText；
 * turn/end → done/failed；mode='goal' 时改看 goals phase：active/paused 等
 * goal-round-driver 续轮，complete → done，blocked → failed（另有 3s 轮询兜底）。
 */
import { randomUUID } from 'node:crypto';

/** 页面用卡片文件名做 key（p.file），host 侧统一成 `<file>::<nodeId>`（动作会话用记录 id） */
const KEY = (project, nodeId) => `${(project && (project.file || project.id)) || ''}::${nodeId}`;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_STATUS = new Set(['starting', 'running']);
/** goal 模式的 phase 轮询间隔（turn/end 之外的第二条兜底） */
const GOAL_POLL_MS = 3000;
/** 读不到目标状态多久后判定 /goal 没生效（避免白白挂到超时） */
const GOAL_PROBE_FAIL_MS = 30000;

const EVENT_LABEL = {
  'turn/start': '回合开始', 'turn/end': '回合结束',
  'step/start': '步骤开始', 'step/end': '步骤结束',
  'assistant/message': '模型回复', 'tool/call': '工具调用', 'tool/result': '工具结果',
  'user/message': '用户消息',
};

/** 把事件压成一句可读摘要，给面板「最后」一行用 */
function briefOf(type, event) {
  const label = EVENT_LABEL[type];
  if (!label) return null;
  const name = event?.data?.name || event?.data?.tool;
  return name ? `${label} · ${name}` : label;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** 从 tool/call 里抠出 exit_plan_mode 提交的计划 markdown（字段名 plan，兼容 markdown / content） */
function planTextOf(event) {
  const name = event?.data?.name || event?.data?.tool;
  if (name !== 'exit_plan_mode') return '';
  let input = event?.data?.input ?? event?.data?.arguments;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return ''; }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const text = input.plan ?? input.markdown ?? input.content;
  return typeof text === 'string' ? text.trim() : '';
}

const goalPhaseOf = (goal) => (goal && typeof goal === 'object' ? String(goal.phase || '') : '');

/** 事件里的回合序号（不同版本字段名可能是 turn / turnIndex / turnNumber），没有就返回 null */
function turnOf(event) {
  const data = event?.data || {};
  const value = data.turn ?? data.turnIndex ?? data.turnNumber;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createRunner(ctx, options = {}) {
  const runs = new Map();
  /** sessionId → agent：同一会话续跑（计划 → 执行 → 反馈）复用同一个 agent */
  const agents = new Map();
  const log = ctx.logger || console;
  const onFinish = typeof options.onFinish === 'function' ? options.onFinish : null;

  function snapshot(run) {
    return {
      key: run.key, file: run.file, projectId: run.projectId, nodeId: run.nodeId,
      recordId: run.recordId || '', sessionId: run.sessionId, mode: run.mode,
      cwd: run.cwd, taskId: run.taskId,
      // 卡片回写还没落盘时对外仍报 running（settling=true）：面板/调用方要等回写完成再读卡片
      status: run.settling ? 'running' : run.status,
      settling: !!run.settling,
      startedAt: run.startedAt, endedAt: run.endedAt,
      elapsedMs: (run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt),
      result: run.result, error: run.error,
      // 计划模式捕获到的计划全文；goal 模式最后一次读到的 phase
      planText: (run.planText || '').slice(0, 20000),
      goalPhase: run.goalPhase || '',
      // 填充类任务：写卡片的结果（面板据此判断「真的写进去了」）
      fillApplied: run.fillApplied || null, fillError: run.fillError || null,
      candidatesAdded: run.candidatesAdded || null, candidatesError: run.candidatesError || null,
      tail: run.tail.slice(-5),
    };
  }

  function finish(run, status, extra = {}) {
    if (TERMINAL.has(run.status) || run.settling) return;
    run.status = status;
    run.endedAt = new Date().toISOString();
    Object.assign(run, extra);
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    if (run.goalTimer) { clearInterval(run.goalTimer); run.goalTimer = null; }
    try { run.unsubscribe && run.unsubscribe(); } catch { /* noop */ }
    run.unsubscribe = null;
    // 成功收尾时别 abort：计划拿到后还要 /plan off 收尾，命令仍在飞
    if (status !== 'done') { try { run.abort.abort(); } catch { /* noop */ } }
    log?.info?.(`[rotation] run ${run.sessionId} → ${status}`);
    if (!onFinish) return;
    // 先回写卡片、再对外报终态：否则面板/脚本会抢在回写前读到旧卡（计划还没写进去）
    run.settling = true;
    Promise.resolve()
      .then(() => onFinish(run, { ...snapshot(run), status }))
      .catch((error) => log?.warn?.('[rotation] onFinish failed: ' + error.message))
      .finally(() => { run.settling = false; });
  }

  /**
   * 读目标状态：ctx.goals.get(agent) → undefined | { phase, roundsStarted, maxGoalRounds, activation, blockerReason? }
   * available=false 表示宿主没有目标服务 / 读不到（调用方退回旧行为：turn/end 即完成）。
   */
  async function readGoal(run) {
    const goals = ctx.goals;
    if (!goals || typeof goals.get !== 'function') return { available: false, goal: null };
    let sawReadable = false;
    for (const who of [run.agent, run.sessionId]) {
      if (!who) continue;
      try {
        const goal = await goals.get(who);
        sawReadable = true;
        if (goal) return { available: true, goal };
      } catch { /* 换个参数再试 */ }
    }
    return { available: sawReadable, goal: null };
  }

  /** mode='goal' 的回合结束：只有 active/paused 才继续等下一轮 */
  async function settleGoal(run) {
    if (TERMINAL.has(run.status)) return;
    const { available, goal } = await readGoal(run);
    if (!available) { finish(run, 'done'); return; }
    const phase = goalPhaseOf(goal);
    if (phase === 'complete') { finish(run, 'done'); return; }
    if (phase === 'blocked') {
      finish(run, 'failed', { error: `目标被阻塞：${goal?.blockerReason || '未给出原因'}` });
      return;
    }
    if (phase === 'active' || phase === 'paused') {
      run.sawGoal = true;
      run.goalPhase = phase;
      run.status = 'running';
      log?.info?.(`[rotation] goal ${run.sessionId} ${phase}，等 goal-round-driver 续轮`);
      return;
    }
    // 目标记录没了：见过目标说明已经收尾；没见过就按旧行为收尾
    finish(run, 'done');
  }

  /** 3s 轮询兜底：turn/end 丢事件或 driver 只在后台推进时也能收尾 */
  async function pollGoal(run) {
    if (TERMINAL.has(run.status) || run.mode !== 'goal') return;
    const { available, goal } = await readGoal(run);
    if (!available) return;   // 没有目标服务：交给 turn/end
    const phase = goalPhaseOf(goal);
    if (phase === 'complete') { finish(run, 'done'); return; }
    if (phase === 'blocked') {
      finish(run, 'failed', { error: `目标被阻塞：${goal?.blockerReason || '未给出原因'}` });
      return;
    }
    if (phase === 'active' || phase === 'paused') {
      run.sawGoal = true;
      run.goalPhase = phase;
      if (run.status === 'starting') run.status = 'running';
      return;
    }
    if (run.sawGoal) { finish(run, 'done'); return; }
    if (Date.now() - Date.parse(run.startedAt) > GOAL_PROBE_FAIL_MS) {
      finish(run, 'failed', { error: '/goal 没有生效：30 秒内读不到目标状态' });
    }
  }

  /** 计划拿到后顺手退出计划模式：不然会话会一直挂在「等批准」（失败也无所谓） */
  async function exitPlanMode(run) {
    const execute = ctx.commands && typeof ctx.commands.execute === 'function'
      ? ctx.commands.execute.bind(ctx.commands)
      : null;
    if (!execute || !run.agent) return;
    try { await execute(run.agent, '/plan off', [], run.abort.signal); }
    catch (error) { log?.warn?.('[rotation] exit plan mode failed: ' + error.message); }
  }

  function observe(run) {
    // 真实插件里 ctx.on('session/event', (session, event) => …) 是**两个参数**；
    // 这里同时兼容单参数事件（mock / 旧版）。
    const handler = (first, second) => {
      if (TERMINAL.has(run.status)) return;
      const session = second ? first : null;
      const event = second ? second : first;
      if (!event || typeof event !== 'object') return;
      const sessionId = session?.id || event.sessionId || event.data?.sessionId;
      if (sessionId && sessionId !== run.sessionId) return;
      const type = event.type;
      run.lastEventAt = new Date().toISOString();
      if (type) run.tail.push({ at: run.lastEventAt, type, brief: briefOf(type, event) });
      if (run.tail.length > 60) run.tail.shift();

      if (type === 'turn/start') {
        run.turnSeen = true;
        const turn = turnOf(event);
        if (turn != null) run.turn = turn;
        run.status = 'running';
        return;
      }
      if (type === 'step/start' || type === 'step/end') { run.status = 'running'; return; }

      // 同一会话续跑时可能收到上一段会话的尾巴事件：回合序号对不上就不是本回合
      const eventTurn = turnOf(event);
      const staleTurn = eventTurn != null && run.turn != null && eventTurn !== run.turn;

      // 计划模式：agent 用 exit_plan_mode 交计划，入参里带计划 markdown
      if (type === 'tool/call') {
        const planText = planTextOf(event);
        if (planText && !run.planText) {
          run.planText = planText;
          run.status = 'running';
          if (run.mode === 'plan') {
            // 计划已拿到，计划动作到此完成；后台退出计划模式，不阻塞状态回写
            void exitPlanMode(run);
            finish(run, 'done');
          }
        }
        return;
      }

      if (type === 'assistant/message') {
        const blocks = event.data?.content
          || event.data?.message?.content
          || event.content
          || event.message?.content;
        const text = textOf(blocks);
        if (text) run.result = text.slice(0, 8000);
        return;
      }

      if (type === 'turn/end') {
        const reason = event.data?.reason || {};
        // 同一会话续跑（计划 → 执行 → 反馈）时，上一段会话可能还有尾巴回合的 turn/end；
        // 本 run 的回合一定先有 turn/start，没见到就先当遗留事件忽略，免得把新会话误判完成。
        if (run.reused && !run.turnSeen) {
          log?.info?.(`[rotation] run ${run.sessionId} 忽略未观察到起点的 turn/end`);
          return;
        }
        if (run.reused && staleTurn) {
          log?.info?.(`[rotation] run ${run.sessionId} 忽略旧回合 turn/end#${eventTurn}`);
          return;
        }
        if (reason.kind && reason.kind !== 'completed') {
          const detail = reason.error?.message || reason.failure?.message || reason.message || '';
          const text = !detail
            ? `turn 结束原因：${reason.kind}`
            : (reason.kind === 'error' ? detail : `${reason.kind}：${detail}`);
          finish(run, 'failed', { error: text });
          return;
        }
        if (run.mode === 'goal') { void settleGoal(run); return; }
        finish(run, 'done');
        return;
      }

      if (type === 'error') {
        finish(run, 'failed', { error: String(event.message || event.data?.message || 'unknown error') });
      }
    };

    try {
      const dispose = ctx.on('session/event', handler);
      run.unsubscribe = typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      log?.warn?.('[rotation] cannot subscribe session/event: ' + error.message);
    }
  }

  async function followup(agent, text) {
    const message = options.createUserMessage
      ? options.createUserMessage(text)
      : { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
    await agent.followup(message);
  }

  /** 命令 / 提示词二选一：有命令服务就发斜杠命令，否则（或命令没生效）退回提示词 */
  async function dispatch(run, agent, { command, prompt, fallbackPrompt }) {
    const lines = (command == null ? [] : (Array.isArray(command) ? command : [command]))
      .map((line) => String(line == null ? '' : line).trim())
      .filter(Boolean);
    const execute = ctx.commands && typeof ctx.commands.execute === 'function'
      ? ctx.commands.execute.bind(ctx.commands)
      : null;
    const plain = fallbackPrompt || prompt || lines.join('\n');
    const fallback = async () => {
      // 命令没走通时 goal 不会存在：退回「回合结束即完成」的旧语义，别挂着等目标
      if (run.mode === 'goal') run.mode = 'message';
      await followup(agent, plain || '继续');
    };

    if (!lines.length || !execute) { await fallback(); return; }

    for (const line of lines) {
      let result;
      try {
        result = await execute(agent, line, [], run.abort.signal);
      } catch (error) {
        if (run.abort.signal.aborted) throw error;
        log?.warn?.(`[rotation] command failed（${line.slice(0, 40)}）：${error.message}，退回提示词`);
        await fallback();
        return;
      }
      if (result === undefined) {
        log?.warn?.(`[rotation] command 未生效（${line.slice(0, 40)}），退回提示词`);
        await fallback();
        return;
      }
    }
  }

  async function start({
    project, nodeId, recordId, command, prompt, fallbackPrompt,
    mode = 'message', taskId, sessionId, timeoutMs = 15 * 60 * 1000,
  }) {
    // 优先用项目卡片上的路由覆盖（便于把某个项目钉到网关），其次插件 config，最后宿主默认
    const override = (project && project.provider)
      ? { provider: project.provider, model: project.model }
      : (options.provider ? { provider: options.provider, model: options.model } : null);
    if (!ctx.agents || typeof ctx.agents.create !== 'function') {
      const error = new Error('会话服务不可用：DSH 没有提供 ctx.agents');
      error.status = 503;
      throw error;
    }
    // 动作会话一条记录一个 key（同一构思可以先后跑计划 / 执行 / 反馈）；
    // 普通会话仍按节点 id，保持原有「同节点只许一个会话」的语义。
    const key = KEY(project, recordId || nodeId);
    const prev = runs.get(key);
    if (prev && (ACTIVE_STATUS.has(prev.status) || prev.settling)) {
      const error = new Error('该节点已有会话在运行');
      error.status = 409;
      throw error;
    }

    const cwd = project.workspace;
    const selection = override || ctx.agentDefaultModel?.currentSelection?.() || {};
    const run = {
      key, file: project.file || project.id, projectId: project.id, nodeId,
      recordId: recordId || '',
      sessionId: sessionId || `session-${randomUUID()}`,
      mode, cwd, taskId: taskId || '',
      status: 'starting', startedAt: new Date().toISOString(), endedAt: null,
      result: '', error: '', planText: '', goalPhase: '',
      // 同会话续跑（计划 → 执行 → 反馈）才需要防上一段会话的尾巴事件；普通会话保持旧行为
      reused: !!sessionId,
      sawGoal: false, turnSeen: false, turn: null, settling: false, agent: null,
      tail: [], lastEventAt: null, unsubscribe: null, timer: null, goalTimer: null,
      abort: new AbortController(),
    };
    runs.set(key, run);

    let agent = agents.get(run.sessionId) || null;
    run.reused = !!sessionId || !!agent;
    if (!agent) {
      try {
        const composed = ctx.agents.composeAgent ? await ctx.agents.composeAgent(options.presetId) : undefined;
        const agentOptions = (selection && (selection.provider || selection.model))
          ? { provider: selection.provider, model: selection.model }
          : undefined;
        const created = await ctx.agents.create({
          sessionId: run.sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          meta: { cwd, ...(composed?.agentPreset ? { agentPreset: composed.agentPreset } : {}) },
          setup: composed?.setup,
        });
        agent = created.agent;
        agents.set(run.sessionId, agent);
      } catch (error) {
        finish(run, 'failed', { error: '创建会话失败：' + error.message });
        throw Object.assign(new Error(run.error), { status: 500 });
      }

      // 把会话挂到 DSH 的工作区上：这样它在 DSH 侧栏里和普通会话一样可见、可点开
      try {
        const registry = ctx.workspaceRegistry;
        if (registry && typeof registry.resolveByPath === 'function') {
          const workspace = await registry.resolveByPath(cwd);
          if (workspace && typeof workspace.attachSession === 'function') {
            try {
              await workspace.attachSession(run.sessionId);
            } catch (error) {
              // 会话头可能还没落盘，稍后重试一次
              await new Promise((r) => setTimeout(r, 1500));
              await workspace.attachSession(run.sessionId).catch((retryError) => {
                log?.warn?.('[rotation] attach session failed: ' + retryError.message);
              });
            }
            run.attachedTo = workspace.id || workspace.path || '';
          }
        }
      } catch (error) {
        log?.warn?.('[rotation] workspace attach skipped: ' + error.message);
      }
    }
    run.agent = agent;

    observe(run);

    run.timer = setTimeout(() => {
      if (!TERMINAL.has(run.status)) {
        try { agent?.interrupt?.(); } catch { /* noop */ }
        finish(run, 'failed', { error: `超时 ${Math.round(timeoutMs / 60000)} 分钟未完成，已中断` });
      }
    }, timeoutMs);
    if (run.timer.unref) run.timer.unref();

    try {
      await dispatch(run, agent, { command, prompt, fallbackPrompt });
      // 假 agent / 快命令可能在 dispatch 里就把整个回合跑完了：别把已终态改回 running
      if (!TERMINAL.has(run.status)) run.status = 'running';
    } catch (error) {
      finish(run, 'failed', { error: '发送失败：' + error.message });
      throw Object.assign(new Error(run.error), { status: 500 });
    }

    // goal 模式：turn/end 之外再定时看 phase（complete 即完成）
    if (run.mode === 'goal' && !TERMINAL.has(run.status)) {
      run.goalTimer = setInterval(() => { void pollGoal(run); }, GOAL_POLL_MS);
      if (run.goalTimer.unref) run.goalTimer.unref();
    }

    return snapshot(run);
  }

  function list() {
    return [...runs.values()].map(snapshot);
  }

  /** 按节点找 run：先按 key（普通会话 / 记录 id），再按 nodeId / recordId 反查（动作会话） */
  function findRun(project, nodeId) {
    const direct = runs.get(KEY(project, nodeId));
    if (direct) return direct;
    const file = (project && (project.file || project.id)) || '';
    return [...runs.values()].reverse()
      .find((run) => run.file === file && (run.nodeId === nodeId || run.recordId === nodeId)) || null;
  }

  function cancel(project, nodeId) {
    const run = findRun(project, nodeId);
    if (!run) return null;
    if (TERMINAL.has(run.status)) return { ...snapshot(run), status: run.status };
    try { run.agent?.interrupt?.(); } catch { /* noop */ }
    finish(run, 'cancelled', { error: '用户取消' });
    return { ...snapshot(run), status: 'cancelled' };
  }

  return { start, list, cancel };
}
