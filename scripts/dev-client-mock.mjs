#!/usr/bin/env node
/**
 * scripts/dev-client-mock.mjs — 不装 DSH 也能验证 client 半的模块契约。
 *
 *   node scripts/dev-client-mock.mjs
 *
 * 验证点：
 *   1) lib/client.js 以 window.__ModuleLoader__.load({id, factory}) 形态注册
 *   2) factory(require) 返回 { apply, name }
 *   3) apply(ctx) 在提供 slots 时会注册 sidebar.right.pane.tab 与 .title
 *   4) 插槽的名字 / key / 组件形状符合现有插件的写法
 *   5) 没有 slots 时静默降级，不抛错
 */
import { readFile } from 'node:fs/promises';

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) { captured = options; },
  },
};

// 用一份极简 react 替身，只为断言组件能创建出元素
const reactStub = {
  createElement(type, props, ...children) {
    return { $$type: type, props: props || {}, children };
  },
};

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

await import('../lib/client.js');

ok('ModuleLoader 被调用', !!captured, captured?.id || '');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
ok('bundle id 等于包名（loader 按包名注册）', captured?.id === pkg.name, captured?.id);

const module = captured.factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
});
ok('factory 返回 apply', typeof module?.apply === 'function');
ok('导出 name', typeof module?.name === 'string', module?.name);
ok('导出 inject=slots', Array.isArray(module?.inject) && module.inject.includes('slots'), JSON.stringify(module?.inject));

// ── 正常路径：提供 slots ──
const registered = [];
const injected = [];
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  slots: {
    register(descriptor, component) { registered.push({ descriptor, component }); return () => {}; },
    inject(name, fn) { injected.push(name); return fn(); },
  },
};

module.apply(ctx);
const tab = registered.find((r) => r.descriptor.name === 'sidebar.right.pane.tab');
const title = registered.find((r) => r.descriptor.name === 'sidebar.right.pane.tab.title');
ok('注册了右栏 tab', !!tab, tab?.descriptor.key);
ok('注册了 tab 标题', !!title, title?.descriptor.key);
ok('inject 声明了两类插槽', injected.includes('sidebar.right.pane.tab') && injected.includes('sidebar.right.pane.tab.title'), injected.join(','));
ok('tab 组件可渲染', (() => {
  try {
    const el = tab.component({});
    return !!el && el.$$type === 'div';
  } catch { return false; }
})());

// ── 降级路径：没有 slots ──
let degraded = false;
try {
  module.apply({ logger: { info: () => {}, warn: () => {} } });
  degraded = true;
} catch {
  degraded = false;
}
ok('无 slots 时静默降级', degraded);

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\nclient 半契约全部通过');
process.exit(failed ? 1 : 0);
