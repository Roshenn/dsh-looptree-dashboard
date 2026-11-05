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
 *   6) 打开服务时先切到面板给的项目会话，再把它开在那条会话的右栏（多项目并行不串台）
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

// 用一份极简 react 替身：createElement 只为断言元素形状，hook 运行时只为
// 把 composer 卡片（useState/useEffect/useRef）渲染出来并驱动状态变化。
let activeRuntime = null;
const reactStub = {
  createElement(type, props, ...children) {
    return { $$type: type, props: props || {}, children };
  },
  useState(init) {
    const rt = activeRuntime;
    const i = rt.index++;
    if (!rt.slots[i]) rt.slots[i] = { value: typeof init === 'function' ? init() : init };
    const slot = rt.slots[i];
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      rt.schedule();
    }];
  },
  useEffect(fn, deps) {
    const rt = activeRuntime;
    const i = rt.index++;
    let slot = rt.slots[i];
    if (!slot) slot = rt.slots[i] = { deps: null, fn, cleanup: null };
    const changed = !deps || !slot.deps || deps.length !== slot.deps.length
      || deps.some((dep, j) => !Object.is(dep, slot.deps[j]));
    slot.fn = fn;
    if (changed) {
      slot.deps = deps ? deps.slice() : null;
      slot.cleanup = null;
      rt.effects.push(slot);
    }
  },
  useRef(init) {
    const rt = activeRuntime;
    const i = rt.index++;
    if (!rt.slots[i]) rt.slots[i] = { ref: { current: init } };
    return rt.slots[i].ref;
  },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
};

/** 每渲染一次组件就换一份 hook 现场；setState 走 setTimeout 重绘，和 React 一样异步 */
function createRuntime(component, props) {
  const rt = { component, props, slots: [], index: 0, effects: [], scheduled: false };
  rt.schedule = () => {
    if (rt.scheduled) return;
    rt.scheduled = true;
    setTimeout(() => { rt.scheduled = false; rt.paint(); }, 0);
  };
  rt.paint = () => {
    activeRuntime = rt;
    rt.index = 0;
    rt.effects = [];
    const tree = component(rt.props);
    for (const slot of rt.effects) {
      try { if (slot.cleanup) slot.cleanup(); } catch { /* noop */ }
      const ret = slot.fn();
      slot.cleanup = typeof ret === 'function' ? ret : null;
    }
    activeRuntime = null;
    return tree;
  };
  return rt;
}

// 面板卡片会注入样式；给一个最小 document 替身，顺带断言样式只注入一次
const styleNodes = [];
globalThis.document = {
  documentElement: { dataset: {} },
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
};

// fetch 替身：session/context 与 services/start-all 两条链路
const fetchCalls = [];
let contextPayload = null;
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), options });
  if (String(url).includes('/session/context')) {
    return { ok: true, status: 200, json: async () => contextPayload };
  }
  if (String(url).includes('/services/start-all')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, started: [{ id: 'web' }], skipped: [], failed: [] }) };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) };
};
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 5)); };

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

// ── 会话绑定：面板带了 sessionId 时，先切会话，再开在那条会话的右栏 ──
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
openCalls.length = 0;
const sessionCalls = [];
services = {
  sidebarRight: {
    openTab: (...args) => openCalls.push(args),
    screen: () => ({ sessionId: 'session-aaaa', surface: { layout: {} } }),
  },
  uiWorkspace: { openSession: (id) => sessionCalls.push(id) },
};
replies = dispatch({
  type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u1b',
  sessionId: 'session-aaaa', project: 'english-chunk',
});
await sleep(80);
ok('带 sessionId 时先切到该会话', sessionCalls[0] === 'session-aaaa', JSON.stringify(sessionCalls));
ok('切完再开右栏 tab', openCalls.length === 1 && replies[0]?.ok === true, JSON.stringify(replies[0]));
ok('回执写清切到了哪个项目', /english-chunk/.test(replies[0]?.note || ''), JSON.stringify(replies[0]));

// 工作区里一条会话都没有：按 workspaceId 新建一条，再开在它的右栏
openCalls.length = 0;
sessionCalls.length = 0;
const connectCalls = [];
services = {
  sidebarRight: {
    openTab: (...args) => openCalls.push(args),
    screen: () => ({ sessionId: 'session-new', surface: { layout: {} } }),
  },
  uiWorkspace: {
    openSession: (id) => sessionCalls.push(id),
    connectWorkspace: async (id) => { connectCalls.push(id); return 'session-new'; },
  },
};
replies = dispatch({
  type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u1c',
  workspaceId: 'ws-english-chunk', project: 'english-chunk',
});
await sleep(120);
ok('没有会话时按 workspaceId 新建', connectCalls[0] === 'ws-english-chunk', JSON.stringify(connectCalls));
ok('新建的会话被选中', sessionCalls[0] === 'session-new', JSON.stringify(sessionCalls));
ok('新建后照样开成右栏 tab', replies[0]?.ok === true && replies[0]?.mode === 'sidebar', JSON.stringify(replies[0]));

// 宿主拿不到 uiWorkspace：不阻断，退回当前会话打开，并把原因写回面板
openCalls.length = 0;
services = {
  sidebarRight: {
    openTab: (...args) => openCalls.push(args),
    screen: () => ({ sessionId: 'session-other', surface: { layout: {} } }),
  },
};
replies = dispatch({
  type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u1d',
  sessionId: 'session-aaaa', project: 'english-chunk',
});
await sleep(80);
ok('切不了会话时仍用当前会话打开', openCalls.length === 1 && replies[0]?.ok === true,
  JSON.stringify(replies[0]));
ok('失败原因随回执带回面板', /切换会话失败/.test(replies[0]?.note || ''), JSON.stringify(replies[0]));

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

// ── composer 卡片：服务拉起 + 展开闭环 ──
const launcher = registered.find((r) => r.descriptor.name === 'conversation.input.right');
ok('注册了 composer 卡片', !!launcher && launcher.descriptor.id === 'rotation-launch', launcher?.descriptor?.id);
ok('卡片样式只注入一次', styleNodes.length === 1
  && String(styleNodes[0].dataset.pluginCss || '').includes('launcher.css'), String(styleNodes.length));

const PROJECT = { id: 'proj', name: 'proj', file: 'proj.rotation.json', workspace: '/tmp/proj' };
const panelCalls = [];
services = { layout: { selectPanel: (key) => panelCalls.push(key) } };
window.__ROTATION_TOKEN__ = 'test-token';
contextPayload = {
  ok: true, sessionId: 'session-1', cwd: '/tmp/proj',
  project: PROJECT, services: { total: 2, startable: 2, hasUrl: true }, token: true,
  panelId: 'card-proj-milestone',
};
const cellProps = { sessionId: 'session-1', usePanelInfo: (select) => select({ activePanelId: null }) };
const labelOf = (btn) => ((btn.children || [])[1]?.children || []).join('');

fetchCalls.length = 0;
const rt = createRuntime(launcher.component, cellProps);
rt.paint();
await flush();
let tree = rt.paint();
ok('有项目时渲染两个按钮', !!tree && (tree.children || []).length === 2,
  tree ? String((tree.children || []).length) : 'null');
ok('先读 session 上下文', fetchCalls.some((c) => c.url.includes('/session/context?sessionId=session-1')),
  fetchCalls.map((c) => c.url).join(','));
ok('两颗按钮文案是「服务 / 闭环」', labelOf(tree.children[0]) === '服务' && labelOf(tree.children[1]) === '闭环',
  labelOf(tree.children[0]) + '/' + labelOf(tree.children[1]));

fetchCalls.length = 0;
tree.children[0].props.onClick();
tree = rt.paint();
ok('点「服务」先进入拉起中', labelOf(tree.children[0]) === '拉起中', labelOf(tree.children[0]));
await new Promise((resolve) => setTimeout(resolve, 720));
await flush();
tree = rt.paint();
const startCall = fetchCalls.find((c) => c.url.includes('/services/start-all'));
ok('拉起请求打到 start-all', !!startCall, startCall?.url);
ok('带写令牌请求头', startCall?.options?.headers?.['x-rotation-token'] === 'test-token',
  JSON.stringify(startCall?.options?.headers || {}));
ok('只拉起当前项目的服务', (() => {
  try { return JSON.parse(startCall.options.body).file === 'proj.rotation.json'; } catch { return false; }
})(), startCall?.options?.body);
ok('成功后按钮变「已在线」', labelOf(tree.children[0]) === '已在线', labelOf(tree.children[0]));

panelCalls.length = 0;
tree.children[1].props.onClick();
ok('点「闭环」切到面板主区', panelCalls.includes('rotation'), JSON.stringify(panelCalls));

// 未登记成项目：整张卡片不渲染
contextPayload = { ok: true, sessionId: 'session-2', project: null };
const rt2 = createRuntime(launcher.component, { sessionId: 'session-2', usePanelInfo: (select) => select({ activePanelId: null }) });
rt2.paint();
await flush();
ok('未登记工作区不渲染卡片', rt2.paint() === null);

// 宿主要无法注入写令牌（旧版 DSH）：服务禁用，闭环仍可用
contextPayload = {
  ok: true, sessionId: 'session-3', project: PROJECT,
  services: { total: 1, startable: 1, hasUrl: true }, token: false,
};
const rt3 = createRuntime(launcher.component, { sessionId: 'session-3', usePanelInfo: (select) => select({ activePanelId: null }) });
rt3.paint();
await flush();
const tree3 = rt3.paint();
ok('没有写令牌时禁用「服务」', tree3?.children?.[0]?.props?.disabled === true);
ok('没有写令牌时「闭环」仍可用', tree3?.children?.[1]?.props?.disabled !== true);

// 面板里的「← 回会话」
window.__ROTATION_TOKEN__ = 'test-token';
panelCalls.length = 0;
dispatch({ type: 'rotation-back-to-conversation' });
ok('面板「回会话」切回对话', panelCalls.includes(null), JSON.stringify(panelCalls));

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
