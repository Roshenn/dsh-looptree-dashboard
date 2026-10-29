/**
 * lib/services.mjs — 项目服务探活与一键拉起（host 半，M3）
 *
 * 卡片里配置（rotation/v1 的 services 字段）：
 *   { id, name, url, health?, start?, stop?, cwd? }
 *
 * start / stop / cwd 支持两种写法：
 *   1) 字符串：所有平台共用同一条命令（旧写法，仍兼容）
 *   2) 平台映射：{ "mac": "pnpm dev", "windows": "pnpm dev", "linux": "…", "default": "…" }
 *      同一份 rotation.json 会在多台机器间同步，点「一键拉起」时按当前平台挑命令，
 *      避免把 mac 的写法拿到 Windows 上执行（或反过来）。
 *
 * 行为：
 *   - 探活：GET url(+health)，1.2s 超时，HTTP <500 视为在线
 *   - 拉起：在 cwd（缺省 project.workspace）下 spawn(start, { shell:true, detached:true })
 *   - 停止：SIGTERM 整个进程组，3s 后 SIGKILL
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const PROBE_TIMEOUT_MS = Number(process.env.ROTATION_PROBE_TIMEOUT_MS || 1200);
const STARTING_WINDOW_MS = 30_000;
const MAX_SERVICES = 8;

/** process.platform → 面板里显示的短名 */
const PLATFORM_LABEL = { darwin: 'mac', win32: 'windows', linux: 'linux' };
/** 允许的平台写法（大小写、分隔符、常见别名都收） */
const PLATFORM_KEY = {
  mac: 'mac', darwin: 'mac', macos: 'mac', macosx: 'mac', osx: 'mac', macintosh: 'mac',
  win: 'windows', win32: 'windows', win64: 'windows', windows: 'windows', win10: 'windows', win11: 'windows', winnt: 'windows',
  linux: 'linux', unix: 'linux',
  default: 'default', any: 'default', all: 'default',
};
const PLATFORM_ORDER = ['mac', 'windows', 'linux', 'default'];
/** 当前平台优先匹配的别名（按规范化后的 key） */
const PLATFORM_ALIASES = {
  darwin: ['mac', 'darwin', 'macos', 'osx', 'macintosh'],
  win32: ['windows', 'win', 'win32', 'win64', 'win10', 'win11'],
  linux: ['linux', 'unix'],
};

/** 'darwin' → 'mac'；未知平台原样返回，便于提示 */
export function platformLabel(platform = process.platform) {
  return PLATFORM_LABEL[platform] || String(platform || '');
}

/** 任意平台写法 → mac / windows / linux / default；不认识返回 '' */
export function canonicalPlatformKey(key) {
  const norm = String(key || '').toLowerCase().replace(/[-_\s]/g, '');
  return PLATFORM_KEY[norm] || '';
}

/**
 * 从「字符串或平台映射」里挑当前平台要用的值。
 * 顺序：当前平台别名 → default / any / all；都没有返回 ''。
 */
export function resolvePlatformValue(value, platform = process.platform) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const wanted = new Set((PLATFORM_ALIASES[platform] || [platform]).map(canonicalPlatformKey).filter(Boolean));
  for (const [key, raw] of Object.entries(value)) {
    if (!wanted.has(canonicalPlatformKey(key))) continue;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return text;
  }
  for (const key of ['default', 'any', 'all']) {
    const text = typeof value[key] === 'string' ? value[key].trim() : '';
    if (text) return text;
  }
  return '';
}

/** 配置里出现了哪些平台（面板用来提示「有 mac 没 windows」） */
export function platformKeysOf(value) {
  if (typeof value === 'string') return value.trim() ? ['all'] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const key of Object.keys(value)) {
    const canon = canonicalPlatformKey(key);
    if (canon && !out.includes(canon)) out.push(canon);
  }
  return out.sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
}

/** cwd：空 → 项目根；相对路径按项目根拼；`~` 展开成 home */
export function resolveCwd(cwd, workspace, platform = process.platform) {
  const raw = resolvePlatformValue(cwd, platform);
  if (!raw) return workspace || '';
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  if (isAbsolute(expanded)) return expanded;
  return workspace ? join(workspace, expanded) : expanded;
}

/** 字符串或平台映射归一化：去掉空值、别名键统一成 mac / windows / linux / default */
function normalizeCommand(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const map = {};
  for (const [key, raw] of Object.entries(value)) {
    const canon = canonicalPlatformKey(key);
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (canon && text && !map[canon]) map[canon] = text;
  }
  const keys = Object.keys(map);
  if (!keys.length) return '';
  // 只写了 default 的收成字符串，rotation.json 里更好读
  if (keys.length === 1 && keys[0] === 'default') return map.default;
  return map;
}

const slugOf = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

/**
 * 把外部输入（AI 收集 / 手写）归一化成合法的 services 数组：
 * url 必须是 http(s)、id 小写唯一、平台命令只留字符串、最多 8 条。
 * 额外保留 confidence / evidence 两个收集时用的说明字段。
 */
export function normalizeServices(input) {
  if (!Array.isArray(input)) return [];
  const taken = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const url = String(raw.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
    const baseId = slugOf(raw.id || raw.name) || 'svc';
    let id = baseId;
    let seq = 2;
    while (taken.has(id)) id = `${baseId}-${seq++}`;
    taken.add(id);
    const svc = { id, name: String(raw.name || id).trim().slice(0, 40) || id, url };
    const health = String(raw.health || '').trim();
    if (health) svc.health = health;
    const start = normalizeCommand(raw.start);
    if (start) svc.start = start;
    const stop = normalizeCommand(raw.stop);
    if (stop) svc.stop = stop;
    const cwd = normalizeCommand(raw.cwd);
    if (cwd) svc.cwd = cwd;
    const confidence = String(raw.confidence || '').trim().toLowerCase();
    if (confidence === 'high' || confidence === 'low') svc.confidence = confidence;
    const evidence = String(raw.evidence || '').trim().slice(0, 160);
    if (evidence) svc.evidence = evidence;
    out.push(svc);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

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

  function view(projectId, svc, probeRes, platform = process.platform, workspace = '') {
    const runtime = procs.get(`${projectId}::${svc.id}`) || null;
    const age = runtime ? Date.now() - Date.parse(runtime.startedAt) : null;
    let status = probeRes.ok ? 'up' : 'down';
    if (!probeRes.ok && runtime && runtime.stopped) status = 'down';
    else if (!probeRes.ok && runtime && runtime.exitCode != null && runtime.exitCode !== 0) status = 'failed';
    else if (!probeRes.ok && runtime && runtime.exitCode == null && age < STARTING_WINDOW_MS) status = 'starting';
    const startCommand = resolvePlatformValue(svc.start, platform);
    return {
      id: svc.id, name: svc.name || svc.id, url: svc.url, health: svc.health || '',
      // raw：rotation.json 原样（字符串或平台映射）；*Command：当前平台真正会执行的命令
      start: svc.start || '', stop: svc.stop || '',
      startCommand, stopCommand: resolvePlatformValue(svc.stop, platform),
      startPlatform: platformLabel(platform), startPlatforms: platformKeysOf(svc.start),
      cwd: resolveCwd(svc.cwd, workspace, platform),
      confidence: svc.confidence || '', evidence: svc.evidence || '',
      status, httpStatus: probeRes.httpStatus, latencyMs: probeRes.latencyMs, error: probeRes.error,
      pid: runtime?.pid ?? null, startedAt: runtime?.startedAt ?? null,
      uptimeMs: runtime && runtime.exitCode == null ? Date.now() - Date.parse(runtime.startedAt) : null,
      checkedAt: new Date().toISOString(),
      output: runtime?.output?.slice(-1500) || '',
    };
  }

  async function list(projectId, card, workspace = '', platform = process.platform) {
    const list = Array.isArray(card?.services) ? card.services : [];
    const out = [];
    for (const svc of list) {
      const url = joinHealth(svc.url, svc.health);
      out.push(view(projectId, svc, await probe(url), platform, workspace));
    }
    return out;
  }

  function start(projectId, card, serviceId, workspace, platform = process.platform) {
    const svc = (card?.services || []).find((s) => s.id === serviceId);
    if (!svc) return { ok: false, status: 404, error: `找不到服务 ${serviceId}` };
    if (!svc.start) return { ok: false, status: 400, error: '该服务没有配置 start 命令' };
    const command = resolvePlatformValue(svc.start, platform);
    const label = platformLabel(platform);
    if (!command) {
      const platforms = platformKeysOf(svc.start).filter((x) => x !== 'all');
      return {
        ok: false,
        status: 400,
        error: `该服务没有 ${label} 的启动命令（配置里只有 ${platforms.join(' / ') || '空'}）`,
      };
    }
    const key = `${projectId}::${serviceId}`;
    const prev = procs.get(key);
    if (prev && prev.exitCode == null && !prev.stopped) {
      return { ok: false, status: 409, error: `已在运行（pid ${prev.pid}）` };
    }
    const cwd = resolveCwd(svc.cwd, workspace, platform);
    try {
      const child = spawn(command, {
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
      logger?.info?.(`[rotation] service ${serviceId} started (pid ${child.pid}) in ${cwd} [${label}]`);
      return { ok: true, service: { id: serviceId, pid: child.pid, cwd, command, platform: label } };
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
