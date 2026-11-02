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
// 面板 → 宿主的 message 监听：记下来，测试里手动派发事件
const windowListeners = [];
globalThis.window = {
  location: { origin: 'http://127.0.0.1:64533', assign() { /* noop */ }, href: '' },
  addEventListener(type, fn) { if (type === 'message') windowListeners.push(fn); },
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
let services = {};   // 宿主服务替身：单个 ctx 复用，避免重复注册 message 监听
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  get: (name) => services[name],
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

// ── 内嵌浏览器通道：rotation-open-url → sidebarRight.openTab('browser') ──
const ORIGIN = 'http://127.0.0.1:64533';

const dispatch = (data, origin = ORIGIN) => {
  const replies = [];
  const source = { postMessage: (msg) => replies.push(msg) };
  for (const fn of windowListeners) fn({ data, origin, source });
  return replies;
};
const openCalls = [];
const browserServices = () => ({
  sidebarRightTabs: { get: (kind) => (kind === 'browser' ? { title: () => 'Browser' } : undefined) },
  sidebarRight: { openTab: (...args) => openCalls.push(args) },
});

services = browserServices();
let replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u1' });
ok('内嵌浏览器可用时开 browser tab', openCalls.length === 1 && openCalls[0][0] === 'browser',
  JSON.stringify(openCalls[0]));
ok('带原地址与 params', openCalls[0]?.[1]?.params?.url === 'http://127.0.0.1:40100/',
  JSON.stringify(openCalls[0]?.[1]));
ok('成功回执 ok=true', replies.length === 1 && replies[0].ok === true, JSON.stringify(replies[0]));

openCalls.length = 0;
services = { sidebarRightTabs: { get: () => undefined } };
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40150/', reqId: 'u2' });
ok('没启用内嵌浏览器时回失败', replies[0]?.ok === false && /内嵌浏览器/.test(replies[0].error || ''),
  JSON.stringify(replies[0]));
ok('没启用时不调用 openTab', openCalls.length === 0);

openCalls.length = 0;
services = browserServices();
replies = dispatch({ type: 'rotation-open-url', url: 'javascript:alert(1)', reqId: 'u3' });
ok('非 http(s) 地址被拒', replies[0]?.ok === false && openCalls.length === 0, JSON.stringify(replies[0]));

replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/' }, 'http://evil.example.com');
ok('跨源消息被忽略', replies.length === 0, JSON.stringify(replies));

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
