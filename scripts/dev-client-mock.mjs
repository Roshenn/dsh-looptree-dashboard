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
services = {};
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40150/', reqId: 'u2' });
ok('拿不到 sidebar 服务时回失败', replies[0]?.ok === false && /sidebarRight\.openTab/.test(replies[0].error || ''),
  JSON.stringify(replies[0]));
ok('拿不到 sidebar 时不调用 openTab', openCalls.length === 0);

// 关键回归：不再用 sidebarRightTabs 做前置判断，而是把 DSH 自己的报错原样带回面板
openCalls.length = 0;
services = {
  sidebarRight: { openTab: () => { throw new Error('sidebarRight: no tab type is registered as "browser"'); } },
};
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u2b' });
ok('没有主区兜底位时回失败', replies[0]?.ok === false
  && /no tab type is registered as "browser"/.test(replies[0].error || ''), JSON.stringify(replies[0]));
ok('不因 sidebarRightTabs 缺失就提前拒绝', openCalls.length === 0);

// 真机报错（2026-11-02）：主区被面板占着 → sidebarRight 没有 on-screen 会话。
// 先切回对话 + 拉起右栏，再重试开 tab（用户要的是「左对话 / 右页面」并排）
openCalls.length = 0;
const layoutCalls = [];
let sidebarThrows = 1;
services = {
  sidebarRight: { openTab: () => {
    if (sidebarThrows > 0) { sidebarThrows -= 1; throw new Error('sidebarRight: no session surface is mounted'); }
    openCalls.push(['browser']);
  } },
  layout: {
    selectPanel: (key) => layoutCalls.push(key),
    openRightbar: (track, fullscreen) => layoutCalls.push(['rail', track, fullscreen]),
  },
};
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u2c' });
await new Promise((resolve) => setTimeout(resolve, 400));
ok('失败后先切回对话并拉起右栏',
  layoutCalls.includes(null) && layoutCalls.some((c) => Array.isArray(c) && c[0] === 'rail'), JSON.stringify(layoutCalls));
ok('重试后开成右栏 tab', replies[0]?.ok === true && replies[0]?.mode === 'sidebar', JSON.stringify(replies[0]));

// 一直抛：三次重试后落主区内嵌页，仍然不丢给系统浏览器
openCalls.length = 0;
const panelSelections = [];
services = {
  sidebarRight: { openTab: () => { throw new Error('sidebarRight: no session surface is mounted'); } },
  layout: {
    selectPanel: (key) => panelSelections.push(key),
    openRightbar: () => { /* noop */ },
  },
};
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u2d' });
await new Promise((resolve) => setTimeout(resolve, 1600));
ok('重试都失败时落主区内嵌页', replies[0]?.ok === true && replies[0]?.mode === 'panel', JSON.stringify(replies[0]));
ok('切到 rotation-service 主区页', panelSelections.includes('rotation-service'), JSON.stringify(panelSelections));

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
