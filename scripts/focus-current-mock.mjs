#!/usr/bin/env node
/**
 * scripts/focus-current-mock.mjs — 「当前闭环」定位判定的断言。
 *
 *   node scripts/focus-current-mock.mjs
 *
 * 背景：composer 卡片的「闭环」按钮要把面板滚到项目的当前节点，
 * 判定顺序写在 web/index.html 的纯函数 currentNodeOf(p) 里：
 *   运行中 → 可开工（强高亮分支）→ 里程碑根；执行记录不算「闭环」，跳过。
 * 这里把纯函数抠出来跑断言，不需要浏览器。
 *
 * 验证点：
 *   1) 有运行中节点时，不管有没有空闲分支，都定位它
 *   2) 没有运行中 → 定位第一个可开工的能力闭环
 *   3) 可开工集合里只有执行记录时，退回里程碑根
 *   4) 全部关闭 / 没有 idle 模型 → 里程碑根
 *   5) 空项目 → 空串
 *   6) 判定函数不碰 DOM（可离线跑）
 *   7) 源码接线：面板认 rotation-focus、有 focusCurrentLoop / is-current / 回会话按钮
 */
import { readFile } from 'node:fs/promises';

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');

/** 从面板源码里抠出一个完整函数（面板跑在浏览器里，这里只取纯函数） */
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

const src = extractFn(html, 'currentNodeOf');
ok('currentNodeOf() 已抠出', src.includes('idleIds'));
ok('判定函数不碰 DOM（可离线跑）', !/\bdocument\b|\bwindow\b/.test(src));

const walk = (node, fn) => { fn(node); (node.children || []).forEach((c) => walk(c, fn)); };
// eslint-disable-next-line no-new-func
const make = (live) => new Function('walk', 'isLiveNode', `${src}\nreturn currentNodeOf;`)(walk, (p, n) => live.has(n.id));

/* ─── 构造节点：closed / kind / children，够判定用 ─── */
const node = (id, kind, { closed = false, kids = [] } = {}) => ({ id, kind, closed, children: kids });
const project = (root, idleIds = []) => ({ root, idle: { idleIds: new Set(idleIds) } });

/* ─── 1) 运行中优先 ─── */
{
  const cap = node('cap-1', 'capability');
  const exec = node('exec-1', 'exec');
  cap.children = [exec];
  const p = project(node('m', 'milestone', { kids: [cap] }), ['cap-1']);
  ok('运行中节点优先于可开工分支', make(new Set(['exec-1']))(p) === 'exec-1', make(new Set(['exec-1']))(p));
}

/* ─── 2) 无运行中 → 第一个可开工能力闭环 ─── */
{
  const cap1 = node('cap-1', 'capability');
  const cap2 = node('cap-2', 'capability');
  const p = project(node('m', 'milestone', { kids: [cap1, cap2] }), ['cap-2']);
  ok('无运行中 → 定位第一个可开工分支', make(new Set())(p) === 'cap-2', make(new Set())(p));
}

/* ─── 3) 可开工集合只剩执行记录 → 里程碑根 ─── */
{
  const cap = node('cap-1', 'capability', { closed: true });
  const exec = node('exec-1', 'exec');
  cap.children = [exec];
  const p = project(node('m', 'milestone', { kids: [cap] }), ['exec-1']);
  ok('只剩执行记录可开工 → 退回里程碑根', make(new Set())(p) === 'm', make(new Set())(p));
}

/* ─── 4) 全部关闭 → 里程碑根 ─── */
{
  const cap = node('cap-1', 'capability', { closed: true });
  const p = project(node('m', 'milestone', { closed: true, kids: [cap] }), []);
  ok('全部关闭 → 里程碑根', make(new Set())(p) === 'm', make(new Set())(p));
}

/* ─── 5) 空项目 ─── */
{
  ok('没有项目 → 空串', make(new Set())(null) === '', make(new Set())(null));
}

/* ─── 7) 源码接线（实际运行时三条入口都靠这些） ─── */
ok('面板监听 rotation-focus', html.includes("msg.type === 'rotation-focus'"));
ok('?current=1 会定位当前节点', /qs\.get\('current'\)\s*===\s*'1'/.test(html) && html.includes('focusCurrentLoop()'));
ok('当前节点有高亮样式 .is-current', html.includes('.tnode.is-current'));
ok('嵌入态有「← 回会话」按钮', html.includes('id="back-to-session"') && html.includes("'rotation-back-to-conversation'"));

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\n当前闭环判定全部通过');
process.exit(failed ? 1 : 0);
