#!/usr/bin/env node
/**
 * scripts/stale-run-mock.mjs — 卡片里残留的 running 不能画成「运行中」。
 *
 *   node scripts/stale-run-mock.mjs
 *
 * 背景：`.dsh/rotation.json` 随 git 在机器之间同步，`session.status` 是启动那台机器的
 * 运行时快照。另一台机器没有对应 run，面板只剩 staticRun() 这条路；它若原样信任
 * running，就会显示一个永远在涨的「运行中 · 329m43s」，并按 busy 把动作按钮锁灰。
 *
 * 验证点：
 *   1) starting / running 一律降级成 stale（文案「进程已不在」）
 *   2) 没有 ended_at 就不算 elapsedMs（不再用 Date.now() 追着涨）
 *   3) 终态（done / failed / cancelled）与耗时照旧
 *   4) 源码里不再出现 `(ended || Date.now())` 这种按现在回算的写法
 */
import { readFile } from 'node:fs/promises';

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

/** 从面板源码里抠出 staticRun() 的完整函数体（面板本身跑在浏览器里，这里只取这一个纯函数） */
function extractFn(source, name) {
  const head = `function ${name}(`;
  const at = source.indexOf(head);
  if (at < 0) throw new Error(`web/index.html 里找不到 ${name}()`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {          // 行注释里的括号不算
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${name}() 的括号没有闭合`);
}

const src = extractFn(html, 'staticRun');
ok('staticRun() 已抠出', src.includes('session'));
ok('源码不再按 Date.now() 回算耗时', !src.includes('ended || Date.now()'));

// eslint-disable-next-line no-new-func
const staticRun = new Function(`${src}; return staticRun;`)();
const node = (session) => ({ id: 'n1', raw: { session } });
const HOUR = 3600 * 1000;
const started = '2026-10-29T10:00:00.000Z';
const ended = '2026-10-29T11:00:00.000Z';

const running = staticRun(node({ id: 's1', status: 'running', started_at: started }));
ok('running → stale', running?.status === 'stale', JSON.stringify(running?.status));
ok('running 不报耗时（不涨计时）', running?.elapsedMs === 0, String(running?.elapsedMs));

const starting = staticRun(node({ id: 's2', status: 'starting', started_at: started }));
ok('starting → stale', starting?.status === 'stale', JSON.stringify(starting?.status));

const done = staticRun(node({ id: 's3', status: 'done', started_at: started, ended_at: ended }));
ok('done 保持 done', done?.status === 'done');
ok('done 的耗时按 ended-started 算', done?.elapsedMs === HOUR, String(done?.elapsedMs));

const failed = staticRun(node({ id: 's4', status: 'failed', started_at: started, ended_at: ended }));
ok('failed 保持 failed', failed?.status === 'failed');

const cancelled = staticRun(node({ id: 's5', status: 'cancelled', started_at: started }));
ok('cancelled 保持 cancelled 且不报耗时', cancelled?.status === 'cancelled' && cancelled?.elapsedMs === 0);

ok('没有 session 时返回 null', staticRun({ id: 'n2', raw: {} }) === null);

const failedCount = results.filter((r) => !r.pass).length;
console.log(failedCount ? `\n✗ ${failedCount} 项未通过` : `\n全部 ${results.length} 项通过（卡片里的 running 不会再画成运行中）`);
process.exit(failedCount ? 1 : 0);
