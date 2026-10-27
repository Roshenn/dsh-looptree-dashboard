/**
 * lib/services.mjs — 项目服务探活与一键拉起（host 半，M3）
 *
 * 卡片里配置（rotation/v1 的 services 字段）：
 *   { id, name, url, health?, start?, stop?, cwd? }
 *
 * 行为：
 *   - 探活：GET url(+health)，1.2s 超时，HTTP <500 视为在线
 *   - 拉起：在 cwd（缺省 project.workspace）下 spawn(start, { shell:true, detached:true })
 *   - 停止：SIGTERM 整个进程组，3s 后 SIGKILL
 */
import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = Number(process.env.ROTATION_PROBE_TIMEOUT_MS || 1200);
const STARTING_WINDOW_MS = 30_000;

/** health 以 / 开头时按「相对当前路径」拼接，而不是覆盖到域名根 */
export function joinHealth(base, health) {
  if (!health) return base;
  try {
    const b = base.endsWith('/') ? base : base + '/';
    return new URL(String(health).replace(/^\//, ''), b).toString();
  } catch {
    return base;
  }
}

export async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { ok: res.status < 500, httpStatus: res.status, latencyMs: Date.now() - t0 };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'timeout' : error.message, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export function createServiceRunner({ logger = console } = {}) {
  /** `${projectId}::${serviceId}` → { child, pid, startedAt, stopped, exitCode, output } */
  const procs = new Map();

  function view(projectId, svc, probeRes) {
    const runtime = procs.get(`${projectId}::${svc.id}`) || null;
    const age = runtime ? Date.now() - Date.parse(runtime.startedAt) : null;
    let status = probeRes.ok ? 'up' : 'down';
    if (!probeRes.ok && runtime && runtime.stopped) status = 'down';
    else if (!probeRes.ok && runtime && runtime.exitCode != null && runtime.exitCode !== 0) status = 'failed';
    else if (!probeRes.ok && runtime && runtime.exitCode == null && age < STARTING_WINDOW_MS) status = 'starting';
    return {
      id: svc.id, name: svc.name || svc.id, url: svc.url, health: svc.health || '',
      start: svc.start || '', stop: svc.stop || '',
      status, httpStatus: probeRes.httpStatus, latencyMs: probeRes.latencyMs, error: probeRes.error,
      pid: runtime?.pid ?? null, startedAt: runtime?.startedAt ?? null,
      uptimeMs: runtime && runtime.exitCode == null ? Date.now() - Date.parse(runtime.startedAt) : null,
      checkedAt: new Date().toISOString(),
      output: runtime?.output?.slice(-1500) || '',
    };
  }

  async function list(projectId, card) {
    const list = Array.isArray(card?.services) ? card.services : [];
    const out = [];
    for (const svc of list) {
      const url = joinHealth(svc.url, svc.health);
      out.push(view(projectId, svc, await probe(url)));
    }
    return out;
  }

  function start(projectId, card, serviceId, workspace) {
    const svc = (card?.services || []).find((s) => s.id === serviceId);
    if (!svc) return { ok: false, status: 404, error: `找不到服务 ${serviceId}` };
    if (!svc.start) return { ok: false, status: 400, error: '该服务没有配置 start 命令' };
    const key = `${projectId}::${serviceId}`;
    const prev = procs.get(key);
    if (prev && prev.exitCode == null && !prev.stopped) {
      return { ok: false, status: 409, error: `已在运行（pid ${prev.pid}）` };
    }
    const cwd = svc.cwd || workspace;
    try {
      const child = spawn(svc.start, {
        cwd, shell: true, detached: true,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const runtime = { child, pid: child.pid, startedAt: new Date().toISOString(), stopped: false, exitCode: null, output: '' };
      const push = (chunk) => { runtime.output = (runtime.output + String(chunk)).slice(-4000); };
      child.stdout?.on('data', push);
      child.stderr?.on('data', push);
      child.on('exit', (code, signal) => { runtime.exitCode = code == null ? -1 : code; runtime.signal = signal; });
      child.on('error', (error) => { push('spawn error: ' + error.message); runtime.exitCode = -1; });
      procs.set(key, runtime);
      logger?.info?.(`[rotation] service ${serviceId} started (pid ${child.pid}) in ${cwd}`);
      return { ok: true, service: { id: serviceId, pid: child.pid, cwd, command: svc.start } };
    } catch (error) {
      return { ok: false, status: 500, error: error.message };
    }
  }

  function stop(projectId, serviceId) {
    const key = `${projectId}::${serviceId}`;
    const runtime = procs.get(key);
    if (!runtime) return { ok: false, status: 404, error: '没有在跑的服务' };
    runtime.stopped = true;
    try { process.kill(-runtime.pid, 'SIGTERM'); }
    catch { try { runtime.child.kill('SIGTERM'); } catch { /* noop */ } }
    setTimeout(() => {
      try { process.kill(-runtime.pid, 'SIGKILL'); } catch { /* noop */ }
    }, 3000).unref?.();
    return { ok: true };
  }

  function dispose() {
    for (const runtime of procs.values()) {
      if (runtime.exitCode == null) { try { process.kill(-runtime.pid, 'SIGKILL'); } catch { /* noop */ } }
    }
    procs.clear();
  }

  return { list, start, stop, dispose, procs };
}
