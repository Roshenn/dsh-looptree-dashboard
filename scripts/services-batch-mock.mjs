#!/usr/bin/env node
/**
 * scripts/services-batch-mock.mjs — 假项目 / 假卡片验证「全部服务批量控制」，不需要 DSH。
 *
 *   node scripts/services-batch-mock.mjs
 *
 * 覆盖：
 *   · 端口解析：http→80、https→443、显式端口、非法 url / 越界端口 → null
 *   · 冲突检测：同端口 ≥2 个服务才报冲突；无端口条目被排除
 *   · GET /api/services/all：聚合全部项目的服务、status/pid/port、summary
 *   · POST /api/services/start-all：端口冲突整批 409（用 echo 标记确认「一个都没拉」）、
 *     在线 / 缺当前平台命令的服务跳过、file 限定范围、找不到项目 404
 *   · POST /api/services/stop-all：没有配置端口时返回空结果（不碰本机进程）
 *   · 按端口杀进程的解析器（注入假输出）：PowerShell / netstat / lsof / ss / netstat -ltnp
 *   · 杀进程策略：win32 taskkill、darwin 先 SIGTERM 后 SIGKILL、macOS 无 lsof 的降级提示、
 *     linux 回退 ss / netstat、非法端口被拒、不杀当前宿主进程
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = '/rotation';
const home = await mkdtemp(join(tmpdir(), 'rotation-batch-home-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');
const {
  createPortKiller, createServiceRunner, findPortConflicts, isLocalServiceHost,
  parseNetstatPids, parseNetstatLnpPids, parsePidLines, parseSsPids, portOf, splitStopTargets,
} = await import('../lib/services.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/* ── 假宿主：批量服务接口不需要会话，只要 webServer.register 能挂上路由 ── */
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
  on() { return () => {}; },
  effect(fn) { return fn(); },
  sessions: { get: () => null },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
  agents: { async create() { throw new Error('批量服务 mock 不开会话'); } },
  webServer: {
    register(options) {
      routes.push(options);
      return () => { const i = routes.indexOf(options); if (i >= 0) routes.splice(i, 1); };
    },
  },
};

apply(ctx, { basePath: BASE });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => pathname.startsWith(r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const origin = `http://127.0.0.1:${PORT}${BASE}`;
const mockPeer = `http://127.0.0.1:${PORT}`;

/**
 * 额外假服务：给「同一端口，一个在线一个离线」「同一端口两个都在线」两个场景用。
 * /down 返回 500 → 探活判成离线（probe 只把 <500 当在线），其它路径 200。
 */
async function startMockPeer() {
  const peer = createServer((req, res) => {
    const down = String(req.url || '').startsWith('/down');
    res.writeHead(down ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: !down }));
  });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  return { peer, port: peer.address().port };
}
const clashPeer = await startMockPeer();    // 同端口：一个在线 + 一个离线
const onlinePeer = await startMockPeer();   // 同端口：两个都在线

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

/* ── 种子：六个假项目（卡片直接落盘，绕过写接口的校验，模拟旧卡/手写卡） ── */
const CARD = {
  schema: 'rotation/v1',
  project: { name: '批量服务 Mock', workspace: '' },
  updated: null,
  milestone: {
    id: 'batch-ms', kind: 'milestone', title: '批量服务', vision: '一键拉起/关闭全部服务',
    acceptance: 'mock 断言全绿', status: 'plan', closed_at: null, children: [],
  },
};
const marker = join(home, 'spawned.txt');
// 冲突发生时用这条命令写标记文件：只要文件没出现，就证明「一个都没拉」
const spawnCommand = `echo spawned>"${marker}"`;
const workspaces = [];
async function seedProject({ id, name, services }) {
  const ws = await mkdtemp(join(tmpdir(), `rotation-batch-${id}-`));
  workspaces.push(ws);
  const card = JSON.parse(JSON.stringify(CARD));
  card.project = { name, workspace: ws };
  card.milestone.id = `${id}-ms`;
  if (services) card.services = services;
  await mkdir(join(ws, '.dsh'), { recursive: true });
  await writeFile(join(ws, '.dsh', 'rotation.json'), JSON.stringify(card, null, 1) + '\n', 'utf8');
  return { id, name, workspace: ws, file: `${id}.rotation.json` };
}

const entries = await Promise.all([
  // A：两个服务抢同一端口（触发批量拒绝）+ 一个 https 缺省端口 + 没有启动命令
  seedProject({
    id: 'proj-a', name: '项目 A',
    services: [
      { id: 'web', name: 'Web 59123', url: 'http://127.0.0.1:59123', health: '/', start: spawnCommand },
      { id: 'api', name: 'API 59123', url: 'http://127.0.0.1:59123', start: spawnCommand },
      { id: 'docs', name: 'Docs 443', url: 'https://127.0.0.1/' },
    ],
  }),
  // B：一个在线（指向 mock 自己）+ 缺命令 + 只有 mac 命令（当前平台缺命令）
  seedProject({
    id: 'proj-b', name: '项目 B',
    services: [
      { id: 'health', name: 'Mock Health', url: `${mockPeer}${BASE}/api/health` },
      { id: 'nocmd', name: 'NoCmd 59124', url: 'http://127.0.0.1:59124' },
      { id: 'maconly', name: 'MacOnly 59125', url: 'http://127.0.0.1:59125', start: { mac: 'pnpm dev' } },
    ],
  }),
  // C：只用来验证「在线 / 缺命令全部跳过」的干净项目
  seedProject({
    id: 'proj-c', name: '项目 C',
    services: [
      { id: 'up', name: 'Up', url: `${mockPeer}${BASE}/api/health` },
      { id: 'nocmd', name: 'NoCmd 59126', url: 'http://127.0.0.1:59126' },
      { id: 'maconly', name: 'MacOnly 59127', url: 'http://127.0.0.1:59127', start: { mac: 'pnpm dev' } },
    ],
  }),
  // D：url 解析不了 → port null，且不参与冲突检测
  seedProject({
    id: 'proj-d', name: '项目 D',
    services: [{ id: 'ghost', name: 'Ghost', url: 'not-a-url' }],
  }),
  // E：同一端口，一个服务在线、另一个离线且配了启动命令 → 仍算冲突（端口没空出来）
  seedProject({
    id: 'proj-e', name: '项目 E',
    services: [
      { id: 'e-up', name: 'E 在线', url: `http://127.0.0.1:${clashPeer.port}/health` },
      { id: 'e-down', name: 'E 离线', url: `http://127.0.0.1:${clashPeer.port}/down`, start: spawnCommand },
    ],
  }),
  // F：同一端口两个服务都在线 → 不算冲突（这次没有启动动作）
  seedProject({
    id: 'proj-f', name: '项目 F',
    services: [
      { id: 'f1', name: 'F 在线 1', url: `http://127.0.0.1:${onlinePeer.port}/a` },
      { id: 'f2', name: 'F 在线 2', url: `http://127.0.0.1:${onlinePeer.port}/b` },
    ],
  }),
]);
await writeFile(join(home, 'registry.json'), JSON.stringify(entries, null, 1) + '\n', 'utf8');

try {
  /* 1. 端口解析（只从 url 取，http 80 / https 443） */
  check('http 缺省端口 → 80', portOf('http://127.0.0.1/') === 80, String(portOf('http://127.0.0.1/')));
  check('https 缺省端口 → 443', portOf('https://127.0.0.1/') === 443, String(portOf('https://127.0.0.1/')));
  check('显式端口按 url 解析', portOf('http://127.0.0.1:5273/index?x=1') === 5273, String(portOf('http://127.0.0.1:5273/index?x=1')));
  check('非法 url / 非 http(s) → null', portOf('not-a-url') === null && portOf('ftp://x:21/') === null);
  check('越界端口 → null', portOf('http://127.0.0.1:99999/') === null, String(portOf('http://127.0.0.1:99999/')));

  /* 2. 冲突检测：同端口 ≥2 个才算；无端口条目排除 */
  const conflictItems = [
    { port: 5273, host: '127.0.0.1', projectId: 'a', projectName: 'A', serviceId: 'web', serviceName: 'Web', url: 'http://127.0.0.1:5273' },
    { port: 5273, host: '127.0.0.1', projectId: 'b', projectName: 'B', serviceId: 'api', serviceName: 'API', url: 'http://127.0.0.1:5273' },
    { port: 8786, host: 'localhost', projectId: 'a', projectName: 'A', serviceId: 'admin', serviceName: 'Admin', url: 'http://localhost:8786' },
    { port: null, host: '', projectId: 'c', projectName: 'C', serviceId: 'ghost', serviceName: 'Ghost', url: 'not-a-url' },
  ];
  const pureConflicts = findPortConflicts(conflictItems);
  check('同端口 ≥2 个服务才报冲突', pureConflicts.length === 1 && pureConflicts[0].port === 5273, JSON.stringify(pureConflicts));
  check('冲突组只带约定字段', pureConflicts[0].services.length === 2
    && Object.keys(pureConflicts[0].services[0]).sort().join(',') === 'projectId,projectName,serviceId,serviceName,url',
  JSON.stringify(pureConflicts[0].services[0]));
  check('无端口服务被排除出冲突检测', !pureConflicts.some((group) => group.port == null));

  /* 3. 命令输出解析器（注入假输出，不碰本机进程） */
  const winNetstat = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:59123        0.0.0.0:0              LISTENING       4321',
    '  TCP    [::]:59123             [::]:0                 LISTENING       4321',
    '  TCP    127.0.0.1:59123        127.0.0.1:51000        ESTABLISHED     4321',
    '  TCP    127.0.0.1:59124        0.0.0.0:0              LISTENING       777',
  ].join('\r\n');
  const ssText = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511          0.0.0.0:59123       0.0.0.0:*    users:(("node",pid=4321,fd=23))',
    'LISTEN 0      511             [::]:59123          [::]:*    users:(("node",pid=4321,fd=24))',
    'LISTEN 0      511          0.0.0.0:59124       0.0.0.0:*    users:(("node",pid=777,fd=20))',
  ].join('\n');
  const netstatLnp = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:59123           0.0.0.0:*               LISTEN      4321/node',
    'tcp6       0      0 :::59123                :::*                    LISTEN      4321/node',
    'tcp        0      0 0.0.0.0:59124           0.0.0.0:*               LISTEN      777/node',
  ].join('\n');
  check('netstat -ano 只取匹配端口的 LISTENING pid', parseNetstatPids(winNetstat, 59123).join(',') === '4321', JSON.stringify(parseNetstatPids(winNetstat, 59123)));
  check('pid 行解析去重（PowerShell / lsof -ti）', parsePidLines('4321\n4321\n777\n').join(',') === '4321,777');
  check('ss -ltnp 从 users:(pid=) 取端口对应的 pid', parseSsPids(ssText, 59123).join(',') === '4321', JSON.stringify(parseSsPids(ssText, 59123)));
  check('netstat -ltnp 解析 PID/Program name', parseNetstatLnpPids(netstatLnp, 59123).join(',') === '4321', JSON.stringify(parseNetstatLnpPids(netstatLnp, 59123)));

  /* 4. Windows：优先 PowerShell，失败回退 netstat；杀进程用 taskkill /F /T */
  const winCalls = [];
  const winRun = async (cmd, args) => {
    winCalls.push({ cmd, args });
    if (cmd === 'powershell') return { code: 0, stdout: '4321\r\n', stderr: '' };
    if (cmd === 'taskkill') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: winNetstat, stderr: '' };
  };
  const winKiller = createPortKiller({ run: winRun, platform: 'win32' });
  const winPids = await winKiller.pidsOnPort(59123);
  check('win32 优先 PowerShell 定位端口', winCalls[0]?.cmd === 'powershell' && winPids.join(',') === '4321', JSON.stringify(winCalls[0]));
  check('PowerShell 只接收解析出的整数端口', (winCalls[0]?.args || []).join(' ').includes('-LocalPort 59123'));
  const winKilled = await winKiller.killPort(59123);
  check('win32 用 taskkill /PID <pid> /F /T', winCalls.some((call) => call.cmd === 'taskkill' && call.args.join(' ') === '/PID 4321 /F /T'), JSON.stringify(winCalls.map((c) => c.cmd)));
  check('win32 killPort 返回被杀的 pid', winKilled.port === 59123 && winKilled.pids.join(',') === '4321', JSON.stringify(winKilled));

  const fallbackCalls = [];
  const fallbackRun = async (cmd) => {
    fallbackCalls.push(cmd);
    if (cmd === 'powershell') throw Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' });
    return { code: 0, stdout: winNetstat, stderr: '' };
  };
  const fallbackPids = await createPortKiller({ run: fallbackRun, platform: 'win32' }).pidsOnPort(59123);
  check('PowerShell 不可用回退 netstat -ano', fallbackPids.join(',') === '4321' && fallbackCalls.includes('netstat'), JSON.stringify(fallbackCalls));

  /* 5. macOS / Linux：lsof → ss / netstat，SIGTERM 后补 SIGKILL */
  const macCalls = [];
  const macSignals = [];
  const macAlive = new Set([4321]);
  const macSignal = (pid, sig) => {
    macSignals.push(sig === 0 ? `check:${pid}` : `${sig}:${pid}`);
    if (sig === 0) {
      if (macAlive.has(pid)) return true;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    if (sig === 'SIGTERM') return true;          // 模拟忽略 SIGTERM 的顽固进程
    if (sig === 'SIGKILL') { macAlive.delete(pid); return true; }
    throw new Error('unexpected signal ' + sig);
  };
  const macRun = async (cmd, args) => {
    macCalls.push({ cmd, args });
    if (cmd === '/usr/sbin/lsof') return { code: 0, stdout: '4321\n', stderr: '' };
    throw Object.assign(new Error('spawn ' + cmd + ' ENOENT'), { code: 'ENOENT' });
  };
  const macKiller = createPortKiller({ run: macRun, platform: 'darwin', termWaitMs: 0, signal: macSignal });
  const macOut = await macKiller.killPort(59123);
  check('darwin 优先 /usr/sbin/lsof（GUI 启动 PATH 里可能没有 lsof）', macCalls[0]?.cmd === '/usr/sbin/lsof', JSON.stringify(macCalls[0]));
  check('lsof 参数用 tcp:<port> + LISTEN 过滤', (macCalls[0]?.args || []).join(' ') === '-nP -ti tcp:59123 -sTCP:LISTEN', JSON.stringify(macCalls[0]?.args));
  check('darwin 先 SIGTERM、还活着补 SIGKILL', macSignals.join(',') === 'SIGTERM:4321,check:4321,SIGKILL:4321', macSignals.join(','));
  check('killPort 返回端口与 pid', macOut.port === 59123 && macOut.pids.join(',') === '4321', JSON.stringify(macOut));

  const emptyLsof = await createPortKiller({ run: async () => ({ code: 1, stdout: '', stderr: '' }), platform: 'darwin' }).pidsOnPort(59123);
  check('lsof 退出码 1 视为「没有监听」（不报错）', emptyLsof.length === 0, JSON.stringify(emptyLsof));

  let noLsofError = null;
  try {
    await createPortKiller({
      run: async () => { throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }); },
      platform: 'darwin',
    }).pidsOnPort(59123);
  } catch (error) { noLsofError = error; }
  check('macOS 无 lsof 时给出降级提示', !!noLsofError && /macOS/.test(noLsofError.message) && /lsof/.test(noLsofError.message), noLsofError?.message);

  const linuxCalls = [];
  const linuxRun = async (cmd) => {
    linuxCalls.push(cmd);
    if (cmd.endsWith('lsof')) throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    if (cmd === 'ss') return { code: 0, stdout: ssText, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const linuxPids = await createPortKiller({ run: linuxRun, platform: 'linux' }).pidsOnPort(59123);
  check('linux 无 lsof 回退 ss 并解析 pid=', linuxPids.join(',') === '4321' && linuxCalls.includes('ss'), JSON.stringify(linuxCalls));

  const netstatRun = async (cmd) => {
    if (cmd.endsWith('lsof')) throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    if (cmd === 'ss') return { code: 1, stdout: '', stderr: 'ss: not found' };
    return { code: 0, stdout: netstatLnp, stderr: '' };
  };
  const netstatPids = await createPortKiller({ run: netstatRun, platform: 'linux' }).pidsOnPort(59123);
  check('ss 不可用再回退 netstat -ltnp', netstatPids.join(',') === '4321', JSON.stringify(netstatPids));

  let badPortError = null;
  try {
    await createPortKiller({ run: async () => ({ code: 0, stdout: '', stderr: '' }), platform: 'linux' }).killPort('5912x');
  } catch (error) { badPortError = error; }
  check('非法端口被拒（防注入）', !!badPortError && /端口不合法/.test(badPortError.message), badPortError?.message);

  const selfRun = async (cmd) => (cmd.endsWith('lsof')
    ? { code: 0, stdout: `${process.pid}\n`, stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const selfOut = await createPortKiller({ run: selfRun, platform: 'darwin', termWaitMs: 0 }).killPort(59123);
  check('killPort 不会杀当前宿主进程', selfOut.pids.length === 0, JSON.stringify(selfOut));

  /* 5b. 一键关闭的目标规划：只杀本机回环端口，远程 / 内网地址只记 skipped */
  const localHosts = ['localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]', '0.0.0.0', '::', '[::]'];
  const remoteHosts = ['example.com', '192.168.1.5', '10.0.0.2', ''];
  check('本机回环 host 判定', localHosts.every(isLocalServiceHost) && remoteHosts.every((host) => !isLocalServiceHost(host)),
    JSON.stringify([localHosts.map(isLocalServiceHost), remoteHosts.map(isLocalServiceHost)]));

  const remoteRows = [
    { port: 443, host: 'example.com', url: 'https://example.com/' },
    { port: 59123, host: '127.0.0.1', url: 'http://127.0.0.1:59123' },
    { port: 59124, host: '192.168.1.5', url: 'http://192.168.1.5:59124' },
    { port: null, host: '', url: 'not-a-url' },
  ];
  const stopPlan = splitStopTargets(remoteRows);
  check('远程 / 内网地址不参与杀进程，记 skipped reason=remote-host',
    stopPlan.ports.join(',') === '59123'
    && stopPlan.skipped.length === 2
    && stopPlan.skipped.every((item) => item.reason === 'remote-host')
    && stopPlan.skipped[0].host === 'example.com', JSON.stringify(stopPlan));

  // 只对规划出的本机端口杀进程：远程 443 永远不会走到 taskkill（假 run 记录调用）
  const batchCalls = [];
  const batchRunner = createServiceRunner({
    logger: { info() {} },
    platform: 'win32',
    run: async (cmd, args = []) => {
      batchCalls.push([cmd, ...args]);
      return cmd === 'powershell'
        ? { code: 0, stdout: '4321\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    },
  });
  for (const port of stopPlan.ports) await batchRunner.killPort(port);
  check('远程 443 不会调 taskkill（只有本机端口被处理）',
    batchCalls.some((call) => call[0] === 'taskkill')
    && !batchCalls.some((call) => call.join(' ').includes('443')), JSON.stringify(batchCalls));

  /* 6. GET /api/services/all：聚合 + 探活 + 冲突 + summary */
  const all = await getJson('/api/services/all');
  check('GET /api/services/all 返回 200', all.status === 200 && all.body?.ok === true, JSON.stringify(all.body));
  check('带上当前平台', all.body?.platform?.id === process.platform && typeof all.body?.platform?.label === 'string', JSON.stringify(all.body?.platform));
  const allRows = all.body?.services || [];
  check('聚合了全部项目的服务', allRows.length === 14, `got ${allRows.length}`);
  const rowOf = (projectId, id) => allRows.find((row) => row.projectId === projectId && row.id === id);
  check('服务行带 projectId / projectName / file', rowOf('proj-a', 'web')?.projectName === '项目 A' && rowOf('proj-a', 'web')?.file === 'proj-a.rotation.json', JSON.stringify(rowOf('proj-a', 'web')));
  check('port 从 url 解析（显式端口）', rowOf('proj-a', 'web')?.port === 59123, JSON.stringify(rowOf('proj-a', 'web')?.port));
  check('https 缺省端口按 443', rowOf('proj-a', 'docs')?.port === 443, JSON.stringify(rowOf('proj-a', 'docs')?.port));
  check('url 解析不了 → port null', rowOf('proj-d', 'ghost')?.port === null, JSON.stringify(rowOf('proj-d', 'ghost')?.port));
  check('在线服务 status=up', rowOf('proj-b', 'health')?.status === 'up', JSON.stringify(rowOf('proj-b', 'health')?.status));
  check('服务行带 host（面板据此标出远程地址）',
    rowOf('proj-a', 'web')?.host === '127.0.0.1' && rowOf('proj-b', 'health')?.host === '127.0.0.1',
    JSON.stringify([rowOf('proj-a', 'web')?.host, rowOf('proj-b', 'health')?.host]));
  check('summary.total / up 正确', all.body?.summary?.total === 14 && all.body?.summary?.up === 5, JSON.stringify(all.body?.summary));
  const macMissing = process.platform === 'darwin' ? 0 : 2;   // 只有 mac 命令的服务：在 mac 上不算缺命令
  check('summary.missingCommand 统计缺当前平台命令的服务', all.body?.summary?.missingCommand === 9 + macMissing, JSON.stringify(all.body?.summary));
  const conflictOf = (list, port) => (list || []).find((group) => group.port === port);
  check('冲突包含「同端口两个离线服务」（A 的 59123）',
    conflictOf(all.body?.conflicts, 59123)?.services.length === 2, JSON.stringify(all.body?.conflicts));
  check('同端口一个在线一个离线也算冲突（在线那条只是被跳过）',
    (conflictOf(all.body?.conflicts, clashPeer.port)?.services || []).map((svc) => svc.serviceId).sort().join(',') === 'e-down,e-up',
    JSON.stringify(all.body?.conflicts));
  check('同端口两个服务都在线不算冲突（这次没有启动动作）',
    (all.body?.conflicts || []).length === 2 && !conflictOf(all.body?.conflicts, onlinePeer.port), JSON.stringify(all.body?.conflicts));

  /* 6b. ?probe=0：静态枚举（面板「一键关闭」确认弹窗只取端口清单，不逐个探活） */
  const staticAll = await getJson('/api/services/all?probe=0');
  check('probe=0 返回 200', staticAll.status === 200 && staticAll.body?.ok === true, JSON.stringify(staticAll.body));
  check('probe=0 全部 status=unknown（不探活）',
    (staticAll.body?.services || []).length === 14 && staticAll.body.services.every((svc) => svc.status === 'unknown'),
    JSON.stringify((staticAll.body?.services || []).map((svc) => svc.status)));
  check('probe=0 不带探活耗时', staticAll.body.services.every((svc) => svc.latencyMs === null));
  check('probe=0 端口清单不变', staticAll.body.services.filter((svc) => Number.isInteger(svc.port)).length === 13, JSON.stringify(staticAll.body.services.map((svc) => svc.port)));
  check('probe=0 conflicts 同口径', (staticAll.body?.conflicts || []).length === 2
    && !!conflictOf(staticAll.body?.conflicts, clashPeer.port), JSON.stringify(staticAll.body?.conflicts));
  check('probe=0 summary 按静态 startCommand 统计', staticAll.body?.summary?.up === 0
    && staticAll.body?.summary?.missingCommand === 9 + macMissing, JSON.stringify(staticAll.body?.summary));

  /* 7. 既有单项目接口行为不变 */
  const perProject = await getJson('/api/services?file=proj-a');
  check('原 GET /api/services 仍按项目返回', perProject.status === 200 && perProject.body?.services?.length === 3, JSON.stringify(perProject.body?.services?.length));

  /* 8. POST /api/services/start-all：冲突整批 409，一个都不拉 */
  const refused = await sendJson('POST', '/api/services/start-all', {});
  check('start-all 端口冲突 → 409', refused.status === 409 && refused.body?.ok === false, JSON.stringify(refused.body));
  check('409 带全部冲突分组', (refused.body?.conflicts || []).length === 2
    && !!conflictOf(refused.body.conflicts, 59123) && !!conflictOf(refused.body.conflicts, clashPeer.port), JSON.stringify(refused.body?.conflicts));
  check('409 有可读错误文案', /端口冲突/.test(refused.body?.error || ''), refused.body?.error);
  check('409 不带 started（没有拉任何服务）', refused.body?.started === undefined, JSON.stringify(refused.body));
  await sleep(400);
  check('冲突时一个都没拉起（spawn 标记文件不存在）', !existsSync(marker));

  const scopedConflict = await sendJson('POST', '/api/services/start-all', { file: 'proj-a' });
  check('file 限定范围内冲突同样 409', scopedConflict.status === 409, JSON.stringify(scopedConflict.body));

  /* 8b. 在线 + 离线同端口：范围限定到 E 也要 409（在线那条被跳过 ≠ 端口空着） */
  const onlineConflict = await sendJson('POST', '/api/services/start-all', { file: 'proj-e' });
  check('同端口在线 + 离线（离线那条要拉）→ 409', onlineConflict.status === 409, JSON.stringify(onlineConflict.body));
  check('该冲突组同时列出在线与离线服务',
    (conflictOf(onlineConflict.body?.conflicts, clashPeer.port)?.services || []).map((svc) => svc.serviceId).sort().join(',') === 'e-down,e-up',
    JSON.stringify(onlineConflict.body?.conflicts));
  await sleep(300);
  check('在线+离线冲突也没有 spawn', !existsSync(marker));

  /* 9. 在线 / 缺命令跳过，不 spawn */
  const clean = await sendJson('POST', '/api/services/start-all', { file: 'proj-c' });
  const skippedOf = (id) => (clean.body?.skipped || []).find((item) => item.serviceId === id);
  check('干净项目返回 200', clean.status === 200 && clean.body?.ok === true, JSON.stringify(clean.body));
  check('在线服务跳过 reason=up', skippedOf('up')?.reason === 'up', JSON.stringify(clean.body?.skipped));
  check('缺命令服务跳过 reason=no-command', skippedOf('nocmd')?.reason === 'no-command', JSON.stringify(clean.body?.skipped));
  check('只有 mac 命令的服务在本平台跳过', skippedOf('maconly')?.reason === 'no-command', JSON.stringify(clean.body?.skipped));
  check('没拉起任何服务', (clean.body?.started || []).length === 0 && (clean.body?.failed || []).length === 0, JSON.stringify(clean.body));
  await sleep(300);
  check('跳过场景也没有 spawn 标记', !existsSync(marker));

  const bothOnline = await sendJson('POST', '/api/services/start-all', { file: 'proj-f' });
  check('同端口两个都在线：不 409、全部跳过', bothOnline.status === 200
    && (bothOnline.body?.skipped || []).length === 2
    && bothOnline.body.skipped.every((item) => item.reason === 'up'), JSON.stringify(bothOnline.body));

  const ghost = await sendJson('POST', '/api/services/start-all', { file: 'proj-d' });
  check('url 解析不了的服务只跳过、不拉、不算冲突', ghost.status === 200 && (ghost.body?.skipped || [])[0]?.reason === 'no-command', JSON.stringify(ghost.body));

  const missing = await sendJson('POST', '/api/services/start-all', { file: 'proj-nope' });
  check('找不到项目 → 404', missing.status === 404 && missing.body?.ok === false, JSON.stringify(missing.body));

  /* 10. POST /api/services/stop-all：远程地址只进 skipped（不碰本机 443），本机端口清空后不杀进程 */
  // 远程服务放在最后登记：GET 探活阶段不会真的去请求外网（这里只需要静态枚举）。
  const remoteEntry = await seedProject({
    id: 'proj-g', name: '项目 G',
    services: [{ id: 'site', name: '远程站点', url: 'https://example.com/' }],
  });
  const registry = JSON.parse(await readFile(join(home, 'registry.json'), 'utf8'));
  registry.push(remoteEntry);
  await writeFile(join(home, 'registry.json'), JSON.stringify(registry, null, 1) + '\n', 'utf8');

  for (const entry of entries) {
    if (entry.id === 'proj-d') continue;   // D 的 url 不合法，走写接口会被卡片校验拦下
    await sendJson('PUT', '/api/services', { file: entry.id, services: [] });
  }
  const stopped = await sendJson('POST', '/api/services/stop-all', {});
  check('stop-all 返回 200', stopped.status === 200 && stopped.body?.ok === true, JSON.stringify(stopped.body));
  check('远程地址进 skipped（reason=remote-host，不参与杀进程）',
    (stopped.body?.skipped || []).length === 1
    && stopped.body.skipped[0].port === 443
    && stopped.body.skipped[0].host === 'example.com'
    && stopped.body.skipped[0].reason === 'remote-host', JSON.stringify(stopped.body?.skipped));
  check('本机端口清空后没有可杀进程', Array.isArray(stopped.body?.killed) && stopped.body.killed.length === 0, JSON.stringify(stopped.body?.killed));
  check('failed / managedStopped 都是数组', Array.isArray(stopped.body?.failed) && Array.isArray(stopped.body?.managedStopped), JSON.stringify(stopped.body));
} catch (error) {
  check('mock 未抛异常', false, error.stack || error.message);
} finally {
  server.close();
  clashPeer.peer.close();
  onlinePeer.peer.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  for (const ws of workspaces) await rm(ws, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
