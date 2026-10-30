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

/* ─────────── 全部服务批量控制：端口解析 / 冲突检测 / 按端口杀进程 ─────────── */

/**
 * 服务配置的 url → 实际监听端口（http 缺省 80、https 缺省 443）。
 * 只认 http(s)；解析不了或越界返回 null（调用方据此排除出冲突检测）。
 * 批量杀进程只用这里解析出的整数端口，绝不把 url 或用户输入拼进 shell 命令。
 */
export function portOf(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '').trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** 端口取值：只接受 1–65535 的整数，其余返回 0（挡住任何拼接进来的非端口文本） */
function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

/**
 * 同一端口被 ≥2 个服务占用 → 一组冲突。
 * items: [{ port, host?, projectId, projectName, serviceId, serviceName, url }]
 * port 为 null / 非法的条目直接排除；host 取组内第一条的域名，仅供面板显示。
 */
export function findPortConflicts(items) {
  const byPort = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const port = validPort(item && item.port);
    if (!port) continue;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(item);
  }
  const out = [];
  for (const [port, list] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    out.push({
      port,
      host: list[0].host || '',
      services: list.map((x) => ({
        projectId: x.projectId, projectName: x.projectName,
        serviceId: x.serviceId, serviceName: x.serviceName, url: x.url,
      })),
    });
  }
  return out;
}

/**
 * url 的 hostname 是否算「本机回环」：
 * localhost / 127.*（含 127.0.0.1）/ ::1 / 0.0.0.0 / :: 及其带方括号写法。
 * 远程域名（https://example.com → 443）与内网 IP 都不算——本机 443 上可能是别的系统服务。
 */
export function isLocalServiceHost(hostname) {
  const raw = String(hostname || '').trim().toLowerCase();
  if (!raw) return false;
  const host = raw.replace(/^\[|\]$/g, '');   // URL.hostname 的 IPv6 带方括号
  if (host === 'localhost' || host === '0.0.0.0') return true;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv4 回环整段 127.0.0.0/8，以及 IPv4-mapped 写法
  return /^127(?:\.\d{1,3}){3}$/.test(host) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * 批量关闭的目标规划：只保留本机回环地址的端口；远程 / 内网地址不参与杀进程，
 * 记进 skipped（reason=remote-host），由面板提示「这条只是配置，不在本机」。
 */
export function splitStopTargets(rows) {
  const ports = new Set();
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const port = validPort(row && row.port);
    if (!port) continue;   // url 解析不出端口：不是可杀目标
    const host = String((row && row.host) || '');
    if (!isLocalServiceHost(host)) {
      skipped.push({ port, host, url: row.url, reason: 'remote-host' });
      continue;
    }
    ports.add(port);
  }
  return { ports: [...ports].sort((a, b) => a - b), skipped };
}

/**
 * 命令执行封装（可注入：自测时不真的调系统命令）。
 * 返回 { code, stdout, stderr }；spawn 失败（如命令不存在）时 reject，交由调用方回退。
 */
export function createCommandRunner({ spawnFn = spawn, timeoutMs = 8000 } = {}) {
  return function run(command, args = []) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { reject(error); return; }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`${command} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code == null ? -1 : code, stdout, stderr });
      });
    });
  };
}

/** 每行一个 pid：PowerShell 的 Select-Object -ExpandProperty 与 `lsof -ti` 都是这个格式 */
export function parsePidLines(text) {
  const pids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const hit = /^\s*(\d{1,7})\s*$/.exec(line);
    if (hit && Number(hit[1]) > 0) pids.push(Number(hit[1]));
  }
  return [...new Set(pids)];
}

/** Windows netstat -ano：只认 LISTENING 且本地端口匹配的行，PID 在最后一列 */
export function parseNetstatPids(text, port) {
  const want = validPort(port);
  if (!want) return [];
  const pids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP$/i.test(cols[0])) continue;
    const state = cols[3].toUpperCase();
    if (state !== 'LISTENING') continue;
    const local = cols[1];
    const hit = /(?:^|:)(\d+)$/.exec(local);
    if (!hit || Number(hit[1]) !== want) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

/** Linux ss -ltnp：LISTEN 行里 `users:(("node",pid=1234,fd=20))` 的 pid= */
export function parseSsPids(text, port) {
  const want = validPort(port);
  if (!want) return [];
  const pids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^\s*LISTEN/i.test(line)) continue;
    // 本地地址列：proto 无关，取包含 `:port` 的那一列
    const hasPort = line.split(/\s+/).some((col) => new RegExp(`:${want}$`).test(col));
    if (!hasPort) continue;
    for (const hit of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(hit[1]);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** Linux netstat -ltnp：状态 LISTEN 行的最后一列是 `1234/node` */
export function parseNetstatLnpPids(text, port) {
  const want = validPort(port);
  if (!want) return [];
  const pids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    if (!/^tcp/i.test(cols[0])) continue;
    const hit = /(?:^|:)(\d+)$/.exec(cols[3]);
    if (!hit || Number(hit[1]) !== want) continue;
    if (!/LISTEN/i.test(cols[5])) continue;
    const pid = Number((/^(\d+)\//.exec(cols[6]) || [])[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return [...new Set(pids)];
}

/** 默认发信号：测试里注入假实现，避免真的动本机进程 */
const defaultSignal = (pid, signal) => process.kill(pid, signal);

/** 进程是否还活着：ESRCH = 已退出；EPERM = 存在但没权限 */
function isAlive(sendSignal, pid) {
  try { sendSignal(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** lsof 的绝对路径优先：从 GUI 外壳启动时 PATH 可能没有 /usr/sbin */
const LSOF_PATHS = ['/usr/sbin/lsof', 'lsof'];

async function pidsViaLsof(run, port) {
  const args = ['-nP', '-ti', `tcp:${port}`, '-sTCP:LISTEN'];
  let lastError = null;
  for (const bin of LSOF_PATHS) {
    let res;
    try { res = await run(bin, args); }
    catch (error) { lastError = error; continue; }   // 没装 / PATH 不可达 → 换下一个
    // lsof 没有匹配时退出码是 1（不是失败），按「没有监听」处理
    if (res.code === 0 || res.code === 1) return parsePidLines(res.stdout);
    lastError = new Error(`lsof 退出码 ${res.code}${res.stderr ? '：' + res.stderr.trim() : ''}`);
  }
  throw lastError || new Error('lsof 不可用');
}

async function pidsViaPowershell(run, port) {
  const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
  const res = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (res.code !== 0) throw new Error(`powershell 退出码 ${res.code}${res.stderr ? '：' + res.stderr.trim() : ''}`);
  return parsePidLines(res.stdout);
}

async function pidsViaSs(run, port) {
  const res = await run('ss', ['-ltnp']);
  if (res.code !== 0) throw new Error(`ss 退出码 ${res.code}`);
  return parseSsPids(res.stdout, port);
}

async function pidsViaNetstat(run, port, platform) {
  const res = await run('netstat', platform === 'win32' ? ['-ano', '-p', 'TCP'] : ['-ltnp']);
  if (res.code !== 0) throw new Error(`netstat 退出码 ${res.code}`);
  return platform === 'win32' ? parseNetstatPids(res.stdout, port) : parseNetstatLnpPids(res.stdout, port);
}

/**
 * 按端口杀进程（Windows / macOS / Linux）：
 *   - win32：优先 PowerShell Get-NetTCPConnection，失败回退 netstat -ano；taskkill /F /T
 *   - darwin：lsof -ti tcp:<p>（绝对路径优先），先 SIGTERM，等待后还活着再 SIGKILL
 *   - linux：lsof → ss -ltnp → netstat -ltnp，信号同 darwin
 * 命令 / 信号执行器都可注入，自测不会真杀进程。
 */
export function createPortKiller({
  run, platform = process.platform, logger = console, termWaitMs = 2000, signal,
} = {}) {
  const exec = typeof run === 'function' ? run : createCommandRunner();
  const sendSignal = typeof signal === 'function' ? signal : defaultSignal;
  const family = platform === 'win32' ? 'windows' : (platform === 'darwin' ? 'mac' : 'linux');

  async function pidsOnPort(rawPort) {
    const port = validPort(rawPort);
    if (!port) throw new Error(`端口不合法：${rawPort}`);
    const errors = [];
    if (family === 'windows') {
      try { return await pidsViaPowershell(exec, port); } catch (error) { errors.push(error); }
      try { return await pidsViaNetstat(exec, port, 'win32'); } catch (error) { errors.push(error); }
    } else {
      try { return await pidsViaLsof(exec, port); } catch (error) { errors.push(error); }
      if (family === 'linux') {
        try { return await pidsViaSs(exec, port); } catch (error) { errors.push(error); }
        try { return await pidsViaNetstat(exec, port, 'linux'); } catch (error) { errors.push(error); }
      }
    }
    const detail = errors.map((error) => error.message).filter(Boolean).join('；');
    const hint = family === 'mac'
      // macOS 系统自带的 netstat 取不到 pid，没有 lsof 就没法按端口定位进程
      ? 'macOS 找不到 lsof（/usr/sbin/lsof 与 PATH 都不可用），无法按端口定位进程'
      : '端口定位命令（lsof / ss / netstat）都不可用';
    throw new Error(detail ? `${hint}（${detail}）` : hint);
  }

  async function killPort(rawPort) {
    const port = validPort(rawPort);
    if (!port) throw new Error(`端口不合法：${rawPort}`);
    let pids = await pidsOnPort(port);
    // 永不杀自己：服务 url 若恰好指着 DSH 自己的端口，误杀 host 等于把面板一起关掉
    pids = pids.filter((pid) => pid !== process.pid);
    if (!pids.length) return { port, pids: [] };

    if (family === 'windows') {
      const killed = [];
      for (const pid of pids) {
        const res = await exec('taskkill', ['/PID', String(pid), '/F', '/T']);
        if (res.code === 0 || !isAlive(sendSignal, pid)) { killed.push(pid); continue; }
        throw new Error(`taskkill ${pid} 失败（退出码 ${res.code}${res.stderr ? '：' + res.stderr.trim() : ''}）`);
      }
      logger?.info?.(`[rotation] kill port ${port}: ${killed.join(', ')}`);
      return { port, pids: killed };
    }

    for (const pid of pids) {
      try { sendSignal(pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (termWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, termWaitMs));
    // 2s 内没退出的顽固进程补一刀 SIGKILL
    for (const pid of pids.filter((pid) => isAlive(sendSignal, pid))) {
      try { sendSignal(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    logger?.info?.(`[rotation] kill port ${port}: ${pids.join(', ')}`);
    return { port, pids };
  }

  return { pidsOnPort, killPort, platform, family };
}

export function createServiceRunner({ logger = console, platform = process.platform, run, termWaitMs = 2000, signal } = {}) {
  /** `${projectId}::${serviceId}` → { child, pid, startedAt, stopped, exitCode, output } */
  const procs = new Map();
  // 批量关闭共用同一套「按端口定位 + 杀进程」实现（依赖可注入，自测不碰真进程）
  const portKiller = createPortKiller({ run, platform, logger, termWaitMs, signal });

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

  return { list, start, stop, dispose, procs, pidsOnPort: portKiller.pidsOnPort, killPort: portKiller.killPort };
}
