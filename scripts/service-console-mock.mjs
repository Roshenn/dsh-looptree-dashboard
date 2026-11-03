#!/usr/bin/env node
/**
 * scripts/service-console-mock.mjs — 假 spawn 验证「Windows 拉起不再弹控制台窗口、停止按整树杀」。
 *
 *   node scripts/service-console-mock.mjs
 *
 * 覆盖：
 *   · start()：win32 → windowsHide + 不 detached + 仍走 shell/管道；darwin → detached 保留
 *   · build()：win32 → windowsHide + 不 detached，退出码照常回
 *   · stop()：win32 → taskkill /PID <pid> /T /F，且不发 POSIX 信号；
 *             darwin → 先 SIGTERM(-pid)（进程组），不碰 taskkill
 *   · dispose()：win32 → 对存活子进程逐个 taskkill /T /F
 * 全程注入 spawn / spawnSync / signal，不真的拉起进程、不真的杀进程。
 */
import { EventEmitter } from 'node:events';

const { createServiceRunner } = await import('../lib/services.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/** 假 child：只要有 pid + stdout/stderr + EventEmitter 就能被 start/build 当进程用 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = 0;
  child.kill = () => { child.killed += 1; return true; };
  return child;
}

const CARD = {
  services: [{
    id: 'web', name: 'Web', url: 'http://127.0.0.1:40100',
    start: 'pnpm dev', build: 'pnpm build',
  }],
};

/* ── 1. Windows：start 的 spawn 选项 ── */
const winCalls = [];
const winSignals = [];
const winSync = [];
const winChild = fakeChild(4242);
const winRunner = createServiceRunner({
  logger: { info() {} },
  platform: 'win32',
  spawnFn: (command, options) => { winCalls.push({ command, options }); return winChild; },
  spawnSyncFn: (command, args, options) => { winSync.push({ command, args, options }); return { status: 0 }; },
  signal: (pid, sig) => { winSignals.push([pid, sig]); },
});

const started = winRunner.start('proj', CARD, 'web', 'C:/ws', 'win32');
check('win32 start 返回 ok', started.ok === true && started.service?.pid === 4242, JSON.stringify(started));
const winOpts = winCalls[0]?.options || {};
check('win32 start 带 windowsHide（不再弹控制台）', winOpts.windowsHide === true, JSON.stringify(winOpts));
check('win32 start 不 detached（进程组在 Windows 无意义）', winOpts.detached === false, JSON.stringify(winOpts));
check('start 仍走 shell + 管道（日志还能回面板）',
  winOpts.shell === true && winOpts.stdio?.[0] === 'ignore' && winOpts.stdio?.[1] === 'pipe',
  JSON.stringify(winOpts));
check('start 依然把 NO_COLOR 传给服务', winOpts.env?.NO_COLOR === '1');

/* ── 2. Windows：stop 走 taskkill /T /F，不发 POSIX 信号 ── */
const stopped = winRunner.stop('proj', 'web');
check('win32 stop 返回 ok', stopped.ok === true, JSON.stringify(stopped));
const killCall = winSync.find((call) => call.command === 'taskkill');
check('win32 stop 调 taskkill /PID <pid> /T /F',
  killCall && killCall.args.join(' ') === '/PID 4242 /T /F', JSON.stringify(winSync));
check('win32 stop 不发 POSIX 信号（-pid 在那边必然失败）', winSignals.length === 0, JSON.stringify(winSignals));

/* ── 3. macOS：detached + 进程组信号照旧 ── */
const macCalls = [];
const macSignals = [];
const macChild = fakeChild(5151);
const macRunner = createServiceRunner({
  logger: { info() {} },
  platform: 'darwin',
  spawnFn: (command, options) => { macCalls.push({ command, options }); return macChild; },
  spawnSyncFn: () => { throw new Error('darwin 不该调 spawnSync'); },
  signal: (pid, sig) => { macSignals.push([pid, sig]); },
});
macRunner.start('proj', CARD, 'web', '/ws', 'darwin');
check('darwin start 保留 detached（进程组整组可杀）', macCalls[0]?.options?.detached === true, JSON.stringify(macCalls[0]?.options));
check('darwin start 也带 windowsHide（POSIX 忽略该选项）', macCalls[0]?.options?.windowsHide === true);
const macStopped = macRunner.stop('proj', 'web');
check('darwin stop 返回 ok', macStopped.ok === true);
check('darwin stop 先 SIGTERM 到进程组',
  macSignals[0]?.[0] === -5151 && macSignals[0]?.[1] === 'SIGTERM', JSON.stringify(macSignals));

/* ── 4. Windows：build 也隐藏控制台，且退出码照常回 ── */
let buildOpts = null;
let buildChild = null;
const buildRunner = createServiceRunner({
  logger: { info() {} },
  platform: 'win32',
  spawnFn: (command, options) => { buildOpts = options; buildChild = fakeChild(6262); return buildChild; },
  spawnSyncFn: () => ({ status: 0 }),
});
const buildPromise = buildRunner.build('proj', CARD, 'web', 'C:/ws', 'win32');
setImmediate(() => buildChild.emit('close', 0));
const built = await buildPromise;
check('win32 build 带 windowsHide', buildOpts?.windowsHide === true, JSON.stringify(buildOpts));
check('win32 build 不 detached（detached + 管道会吞输出）', buildOpts?.detached === false);
check('win32 build 拿到退出码与输出', built.ok === true && built.code === 0, JSON.stringify(built));

/* ── 5. Windows：dispose 把还活着的服务整树杀掉 ── */
const disposeQueue = [fakeChild(7001), fakeChild(7002)];
const disposeSync = [];
const disposeRunner = createServiceRunner({
  logger: { info() {} },
  platform: 'win32',
  spawnFn: () => disposeQueue.shift(),
  spawnSyncFn: (command, args) => { disposeSync.push(args.join(' ')); return { status: 0 }; },
  signal: () => { throw new Error('win32 dispose 不该发 POSIX 信号'); },
});
disposeRunner.start('proj-a', CARD, 'web', 'C:/ws', 'win32');
disposeRunner.start('proj-b', CARD, 'web', 'C:/ws', 'win32');
disposeRunner.dispose();
check('win32 dispose 对每个存活服务 taskkill /T /F',
  disposeSync.length === 2 && disposeSync.every((args) => /^\/PID \d+ \/T \/F$/.test(args)),
  JSON.stringify(disposeSync));

/* ── 6. 没有在跑的服务：stop 仍是 404 ── */
check('未知服务 stop → 404', macRunner.stop('proj', 'nope')?.status === 404);

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? '，失败：' + failed.map((x) => x.label).join(' / ') : ''}`);
process.exit(failed.length ? 1 : 0);
