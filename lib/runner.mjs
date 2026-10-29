/**
 * lib/runner.mjs — 节点会话执行器（host 半，M2）
 *
 * 走 DSH 进程内的 agent 服务，因此模型凭据 / provider 路由沿用 GUI 已配置的那套，
 * 不再 spawn `dsh --profile headless`（那条路会绕过网关，且 headless profile 没有凭据插件）。
 *
 * 用到的接口（已在 dsh-api-session-controller 里核实过调用形态）：
 *   ctx.agentDefaultModel.currentSelection() -> { provider, model }
 *   ctx.agents.create({ sessionId, agentOptions, meta:{cwd}, setup }) -> { agent }
 *   agent.followup(createUserMessage({ content, source }))
 *   ctx.on('session/event', handler)   // 事件流
 *   ctx.sessions.get(id).snapshotEvents()  // 兜底快照
 *
 * 事件 → 状态：turn/start → running；tool/call → running(最后事件)；turn/end → done/failed。
 */
import { randomUUID } from 'node:crypto';

/** 页面用卡片文件名做 key（p.file），host 侧统一成 `<file>::<nodeId>` */
const KEY = (project, nodeId) => `${(project && (project.file || project.id)) || ''}::${nodeId}`;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

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

export function createRunner(ctx, options = {}) {
  const runs = new Map();
  const log = ctx.logger || console;
  const onFinish = typeof options.onFinish === 'function' ? options.onFinish : null;

  function snapshot(run) {
    return {
      key: run.key, file: run.file, projectId: run.projectId, nodeId: run.nodeId, sessionId: run.sessionId,
      cwd: run.cwd, taskId: run.taskId, status: run.status,
      startedAt: run.startedAt, endedAt: run.endedAt,
      elapsedMs: (run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt),
      result: run.result, error: run.error,
      // 填充类任务：写卡片的结果（面板据此判断「真的写进去了」）
      fillApplied: run.fillApplied || null, fillError: run.fillError || null,
      candidatesAdded: run.candidatesAdded || null, candidatesError: run.candidatesError || null,
      tail: run.tail.slice(-5),
    };
  }

  function finish(run, status, extra = {}) {
    if (TERMINAL.has(run.status) && run.status === status) return;
    run.status = status;
    run.endedAt = new Date().toISOString();
    Object.assign(run, extra);
    if (run.timer) { clearTimeout(run.timer); run.timer = null; }
    try { run.unsubscribe && run.unsubscribe(); } catch { /* noop */ }
    run.unsubscribe = null;
    log?.info?.(`[rotation] run ${run.sessionId} → ${status}`);
    if (onFinish) {
      Promise.resolve(onFinish(run, snapshot(run))).catch((error) => log?.warn?.('[rotation] onFinish failed: ' + error.message));
    }
  }

  function observe(run) {
    // 真实插件里 ctx.on('session/event', (session, event) => …) 是**两个参数**；
    // 这里同时兼容单参数事件（mock / 旧版）。
    const handler = (first, second) => {
      const session = second ? first : null;
      const event = second ? second : first;
      if (!event || typeof event !== 'object') return;
      const sessionId = session?.id || event.sessionId || event.data?.sessionId;
      if (sessionId && sessionId !== run.sessionId) return;
      const type = event.type;
      run.lastEventAt = new Date().toISOString();
      if (type) run.tail.push({ at: run.lastEventAt, type, brief: briefOf(type, event) });
      if (run.tail.length > 60) run.tail.shift();

      if (type === 'turn/start' || type === 'step/start' || type === 'step/end') run.status = 'running';
      if (type === 'assistant/message') {
        const blocks = event.data?.content
          || event.data?.message?.content
          || event.content
          || event.message?.content;
        const text = textOf(blocks);
        if (text) run.result = text.slice(0, 8000);
      }
      if (type === 'turn/end') {
        const reason = event.data?.reason || {};
        if (!reason.kind || reason.kind === 'completed') { finish(run, 'done'); return; }
        const detail = reason.error?.message || reason.failure?.message || reason.message || '';
        const text = !detail
          ? `turn 结束原因：${reason.kind}`
          : (reason.kind === 'error' ? detail : `${reason.kind}：${detail}`);
        finish(run, 'failed', { error: text });
      }
      if (type === 'error') finish(run, 'failed', { error: String(event.message || event.data?.message || 'unknown error') });
    };

    try {
      const dispose = ctx.on('session/event', handler);
      run.unsubscribe = typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      log?.warn?.('[rotation] cannot subscribe session/event: ' + error.message);
    }
  }

  async function start({ project, nodeId, prompt, taskId, timeoutMs = 15 * 60 * 1000 }) {
    // 优先用项目卡片上的路由覆盖（便于把某个项目钉到网关），其次插件 config，最后宿主默认
    const override = (project && project.provider)
      ? { provider: project.provider, model: project.model }
      : (options.provider ? { provider: options.provider, model: options.model } : null);
    if (!ctx.agents || typeof ctx.agents.create !== 'function') {
      const error = new Error('会话服务不可用：DSH 没有提供 ctx.agents');
      error.status = 503;
      throw error;
    }
    const key = KEY(project, nodeId);
    const prev = runs.get(key);
    if (prev && !TERMINAL.has(prev.status)) {
      const error = new Error('该节点已有会话在运行');
      error.status = 409;
      throw error;
    }

    const cwd = project.workspace;
    const selection = override || ctx.agentDefaultModel?.currentSelection?.() || {};
    const sessionId = `session-${randomUUID()}`;
    const run = {
      key, file: project.file || project.id, projectId: project.id, nodeId, sessionId, cwd, taskId: taskId || '',
      status: 'starting', startedAt: new Date().toISOString(), endedAt: null,
      result: '', error: '', tail: [], lastEventAt: null, unsubscribe: null, timer: null,
    };
    runs.set(key, run);

    let agent;
    try {
      const composed = ctx.agents.composeAgent ? await ctx.agents.composeAgent(options.presetId) : undefined;
      const agentOptions = (selection && (selection.provider || selection.model))
        ? { provider: selection.provider, model: selection.model }
        : undefined;
      const created = await ctx.agents.create({
        sessionId,
        ...(agentOptions ? { agentOptions } : {}),
        meta: { cwd, ...(composed?.agentPreset ? { agentPreset: composed.agentPreset } : {}) },
        setup: composed?.setup,
      });
      agent = created.agent;
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
            await workspace.attachSession(sessionId);
          } catch (error) {
            // 会话头可能还没落盘，稍后重试一次
            await new Promise((r) => setTimeout(r, 1500));
            await workspace.attachSession(sessionId).catch((retryError) => {
              log?.warn?.('[rotation] attach session failed: ' + retryError.message);
            });
          }
          run.attachedTo = workspace.id || workspace.path || '';
        }
      }
    } catch (error) {
      log?.warn?.('[rotation] workspace attach skipped: ' + error.message);
    }

    observe(run);

    run.timer = setTimeout(() => {
      if (!TERMINAL.has(run.status)) {
        try { agent?.interrupt?.(); } catch { /* noop */ }
        finish(run, 'failed', { error: `超时 ${Math.round(timeoutMs / 60000)} 分钟未完成，已中断` });
      }
    }, timeoutMs);
    if (run.timer.unref) run.timer.unref();

    try {
      const message = options.createUserMessage
        ? options.createUserMessage(prompt)
        : { role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } };
      await agent.followup(message);
      run.status = 'running';
    } catch (error) {
      finish(run, 'failed', { error: '发送失败：' + error.message });
      throw Object.assign(new Error(run.error), { status: 500 });
    }

    return snapshot(run);
  }

  function list() {
    return [...runs.values()].map(snapshot);
  }

  function cancel(project, nodeId) {
    const run = runs.get(KEY(project, nodeId));
    if (!run) return null;
    if (TERMINAL.has(run.status)) return snapshot(run);
    finish(run, 'cancelled', { error: '用户取消' });
    return snapshot(run);
  }

  return { start, list, cancel };
}
