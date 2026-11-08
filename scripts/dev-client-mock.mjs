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
  removeEventListener() { /* noop */ },
  innerWidth: 1280,
  innerHeight: 800,
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

// 面板卡片会注入样式；给一个最小 document 替身，顺带断言样式只注入一次。
// 菜单要挂 document 级监听（点外面 / Esc 收菜单），所以这里也收着 listener。
const styleNodes = [];
const docListeners = [];
globalThis.document = {
  documentElement: { dataset: {} },
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  addEventListener(type, fn) { docListeners.push([type, fn]); },
  removeEventListener(type, fn) {
    const hit = docListeners.findIndex(([t, f]) => t === type && f === fn);
    if (hit >= 0) docListeners.splice(hit, 1);
  },
};
const dispatchDoc = (type, event) => {
  for (const [kind, fn] of docListeners.slice()) if (kind === type) fn(event);
};

// fetch 替身：session/context 与 services/start-all 两条链路
const fetchCalls = [];
const stopAllCalls = [];
let contextPayload = null;
let serviceRows = [];            // GET /services?file 的替身：up / down / watch 行
let statusDeferred = null;       // 挂起状态请求，用来验证「缓存先行」
let startAllPayload = () => ({ ok: true, started: [{ id: 'web' }], skipped: [], failed: [] });
let stopAllPayload = () => ({ ok: true, killed: [{ port: 8080, pids: [1] }], failed: [], skipped: [], managedStopped: [] });
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), options });
  if (String(url).includes('/session/context')) {
    return { ok: true, status: 200, json: async () => contextPayload };
  }
  if (String(url).includes('/api/health')) {
    // 宿主能力位：没有它 client 会禁用「重启 / 全部关闭」（旧宿主会全局关停）
    return { ok: true, status: 200, json: async () => ({ ok: true, client: { servicesScoped: true } }) };
  }
  if (String(url).includes('/services?file=')) {
    if (statusDeferred) await statusDeferred.promise;
    return { ok: true, status: 200, json: async () => ({ ok: true, services: serviceRows }) };
  }
  if (String(url).includes('/services/stop-all')) {
    stopAllCalls.push(JSON.parse(options.body || '{}'));
    // 关闭后一律先不在线；重启流程里的 start-all 再把它们拉回来
    serviceRows = [];
    return { ok: true, status: 200, json: async () => stopAllPayload() };
  }
  if (String(url).includes('/services/start-all')) {
    return { ok: true, status: 200, json: async () => startAllPayload() };
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
await flush();
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
await flush();
ok('拿不到 sidebar 服务时回失败', replies[0]?.ok === false && /sidebarRight\.openTab/.test(replies[0].error || ''),
  JSON.stringify(replies[0]));
ok('拿不到 sidebar 时不调用 openTab', openCalls.length === 0);

// 关键回归：不再用 sidebarRightTabs 做前置判断，而是把 DSH 自己的报错原样带回面板
openCalls.length = 0;
services = {
  sidebarRight: { openTab: () => { throw new Error('sidebarRight: no tab type is registered as "browser"'); } },
};
replies = dispatch({ type: 'rotation-open-url', url: 'http://127.0.0.1:40100/', reqId: 'u2b' });
await flush();
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
const labelOf = (btn) => (((btn && btn.children) || [])[1]?.children || []).join('');
const iconOf = (btn) => {
  const first = (((btn && btn.children) || [])[0]);
  if (!first) return null;
  return typeof first.$$type === 'function' ? first.$$type(first.props) : first;
};

fetchCalls.length = 0;
const rt = createRuntime(launcher.component, cellProps);
rt.paint();
await flush();
let tree = rt.paint();
ok('有项目时渲染「服务 + 小三角 + 闭环」三个按钮', !!tree && (tree.children || []).filter(Boolean).length === 3,
  tree ? String((tree.children || []).length) : 'null');
ok('先读 session 上下文', fetchCalls.some((c) => c.url.includes('/session/context?sessionId=session-1')),
  fetchCalls.map((c) => c.url).join(','));
ok('探测宿主能力位（stop-all 是否支持按项目收窄）',
  fetchCalls.some((c) => c.url.includes('/api/health')), fetchCalls.map((c) => c.url).join(','));
ok('三颗按钮文案是「服务 / 空 / 闭环」', labelOf(tree.children[0]) === '服务' && labelOf(tree.children[2]) === '闭环',
  labelOf(tree.children[0]) + '/' + labelOf(tree.children[1]) + '/' + labelOf(tree.children[2]));

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
tree.children[2].props.onClick();
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
ok('没有写令牌时「闭环」仍可用', tree3?.children?.[2]?.props?.disabled !== true);

// ── 已在线服务：按钮变「打开服务」，点击在右栏逐个开 tab ──
const railCalls = [];
services = {
  layout: { selectPanel: (key) => panelCalls.push(key), openRightbar: () => {} },
  sidebarRight: { openTab: (kind, opts) => railCalls.push([kind, opts]) },
};
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'up', startCommand: 'pnpm dev:h5' },
];
contextPayload = {
  ok: true, sessionId: 'session-4', project: PROJECT,
  services: { total: 2, startable: 0, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rt4 = createRuntime(launcher.component, { sessionId: 'session-4', usePanelInfo: (select) => select({ activePanelId: null }) });
rt4.paint();
await flush();
let tree4 = rt4.paint();
ok('有在线服务时按钮变「打开服务」', labelOf(tree4.children[0]) === '打开服务', labelOf(tree4.children[0]));
const openIcon = iconOf(tree4.children[0]);
ok('打开态用面板图标（与拉起态形状不同）',
  !!openIcon && openIcon.$$type === 'svg' && (openIcon.children || []).length > 0
  && openIcon.children.some((c) => c.$$type === 'rect'),
  openIcon ? openIcon.children.map((c) => c.$$type).join(',') : 'none');
ok('打开态用浅色状态色 data-tone=open', tree4.children[0].props['data-tone'] === 'open',
  String(tree4.children[0].props['data-tone']));
const launcherCss = String(styleNodes[0].textContent || '');
ok('状态色走低饱和混色，不是纯主题色',
  launcherCss.includes('[data-tone="open"]{color:color-mix')
  && !launcherCss.includes('[data-tone="open"]{color:var(--dsw-alias-brand-primary)}'));
railCalls.length = 0;
fetchCalls.length = 0;
tree4.children[0].props.onClick();
await flush(12);
ok('点「打开服务」不调 start-all', !fetchCalls.some((c) => c.url.includes('/services/start-all')),
  fetchCalls.map((c) => c.url).join(','));
ok('主按钮只打开选中的那条（默认第一条）', railCalls.length === 1 && /:8080/.test(railCalls[0]?.[1]?.params?.url || ''),
  JSON.stringify(railCalls.map((c) => c[1]?.params?.url)));

// ── 服务菜单：小三角 = 选择器 + 两个动作（重启 / 全部关闭）──
// 菜单只负责「选哪个」，主按钮消费这个选择；服务行是 menuitemradio，不是点击即打开的动作。
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'down', startCommand: 'pnpm dev:h5' },
];
startAllPayload = () => {
  serviceRows = [
    { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
    { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'up', startCommand: 'pnpm dev:h5' },
  ];
  return { ok: true, started: [{ id: 'api' }, { id: 'h5' }], skipped: [], failed: [] };
};
contextPayload = {
  ok: true, sessionId: 'session-menu', project: PROJECT,
  services: { total: 2, startable: 2, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
railCalls.length = 0;
fetchCalls.length = 0;
const rtMenu = createRuntime(launcher.component, { sessionId: 'session-menu', usePanelInfo: (select) => select({ activePanelId: null }) });
rtMenu.paint();
await flush();
let treeMenu = rtMenu.paint();
const caret = treeMenu.children[1];
ok('主按钮右侧是小三角（aria-haspopup=menu）',
  caret?.props?.['aria-haspopup'] === 'menu' && caret?.props?.['aria-expanded'] === 'false',
  String(caret?.props?.['aria-haspopup']));
ok('菜单默认收起', (treeMenu.children || []).filter(Boolean).length === 3);
caret.props.onClick();
treeMenu = rtMenu.paint();
const menuNode = treeMenu.children[3];
ok('点小三角展开菜单', !!menuNode && menuNode.$$type === 'div' && menuNode.props.role === 'menu',
  menuNode ? String(menuNode.$$type) : 'null');
const textOf = (n) => (typeof n === 'string' ? n : ((n && n.children) || []).map(textOf).join(''));
const menuKidsOf = (node) => ((node && Array.isArray(node.children[0]) ? node.children[0] : (node && node.children) || [])
  .filter(Boolean));
const pickLabelOf = (node) => {
  const label = ((node && node.children) || [])
    .find((c) => c && c.props && c.props.className === 'dsh-rll-pick-label');
  return label ? textOf(label) : '';
};
let menuKids = menuKidsOf(menuNode);
const actionItems = menuKids.filter((n) => n.props?.role === 'menuitem');
let pickItems = menuKids.filter((n) => n.props?.role === 'menuitemradio');
ok('动作项仍是点击即执行：拉起全部 / 重启 / 全部关闭',
  JSON.stringify(actionItems.map(textOf))
    === JSON.stringify(['拉起全部服务', '关闭并重新打开服务', '关闭所有服务']),
  JSON.stringify(actionItems.map(textOf)));
ok('服务行是选择项（menuitemradio），顺序跟 GET /services 一致',
  JSON.stringify(pickItems.map(pickLabelOf)) === JSON.stringify(['API 8080', 'H5 10086']),
  JSON.stringify(pickItems.map(pickLabelOf)));
ok('默认选中第一条（没选过就落到服务列表第一项）',
  pickItems[0]?.props?.['aria-checked'] === 'true' && pickItems[1]?.props?.['aria-checked'] === 'false',
  pickItems.map((n) => n.props?.['aria-checked']).join(','));
ok('离线服务也能选，只是标出「未在线」',
  pickItems[1]?.props?.disabled !== true && textOf(pickItems[1]).includes('未在线'),
  textOf(pickItems[1]));

// 点服务行 = 只改选中态，不发请求、不开 tab
railCalls.length = 0;
fetchCalls.length = 0;
pickItems[1].props.onClick();
await flush();
ok('点服务行只改选中，不开 tab 也不发请求',
  railCalls.length === 0 && !fetchCalls.some((c) => /start-all|service\/(start|stop)/.test(c.url)),
  fetchCalls.map((c) => c.url).join(','));
ok('选完菜单收起', (rtMenu.paint().children || []).filter(Boolean).length === 3);
rtMenu.paint().children[1].props.onClick();
treeMenu = rtMenu.paint();
pickItems = menuKidsOf(treeMenu.children[3]).filter((n) => n.props?.role === 'menuitemradio');
ok('选中态落到 H5 并持久到下一次打开菜单',
  pickItems[1]?.props?.['aria-checked'] === 'true' && pickItems[0]?.props?.['aria-checked'] === 'false',
  pickItems.map((n) => n.props?.['aria-checked']).join(','));

// 选中的那条没在线：主按钮回落到「把本项目全部拉起」
fetchCalls.length = 0;
railCalls.length = 0;
rtMenu.paint().children[0].props.onClick();
await flush(150);
ok('选中的服务未在线时主按钮回落 start-all',
  fetchCalls.some((c) => c.url.includes('/services/start-all')), fetchCalls.map((c) => c.url).join(','));
ok('回落拉起时不开 tab', railCalls.length === 0, JSON.stringify(railCalls.length));

// 拉起后选中的 H5 在线了：主按钮只打开 H5，不再开全部
railCalls.length = 0;
fetchCalls.length = 0;
rtMenu.paint().children[0].props.onClick();
await flush(90);
ok('主按钮只打开选中的 H5', railCalls.length === 1 && /:10086/.test(railCalls[0]?.[1]?.params?.url || ''),
  JSON.stringify(railCalls.map((c) => c[1]?.params?.url)));
ok('打开选中的服务不调 start-all', !fetchCalls.some((c) => c.url.includes('/services/start-all')),
  fetchCalls.map((c) => c.url).join(','));

// 「关闭所有服务」：第一次点只翻成确认文案，第二次才真发请求
rtMenu.paint().children[1].props.onClick();
treeMenu = rtMenu.paint();
menuKids = menuKidsOf(treeMenu.children[3]);
fetchCalls.length = 0;
menuKids.find((n) => n.props?.role === 'menuitem' && textOf(n) === '关闭所有服务').props.onClick();
treeMenu = rtMenu.paint();
menuKids = menuKidsOf(treeMenu.children[3]);
const confirmItem = menuKids.find((n) => n.props?.role === 'menuitem' && /确认关闭/.test(textOf(n)));
ok('「关闭所有服务」第一次点击只要求确认',
  !!confirmItem && !fetchCalls.some((c) => c.url.includes('/services/stop-all')), textOf(confirmItem));
confirmItem.props.onClick();
await flush(16);
const stopCall = fetchCalls.find((c) => c.url.includes('/services/stop-all'));
ok('确认后发 stop-all', !!stopCall, stopCall?.url);
ok('stop-all 带本项目 file（不误关别的项目）',
  (() => { try { return JSON.parse(stopCall.options.body).file === PROJECT.file; } catch { return false; } })(),
  stopCall?.options?.body);

// 「关闭并重新打开服务」：先 stop-all 再 start-all，两个都限定本项目
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'up', startCommand: 'pnpm dev:h5' },
];
contextPayload = {
  ok: true, sessionId: 'session-restart', project: PROJECT,
  services: { total: 2, startable: 2, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rtRestart = createRuntime(launcher.component, { sessionId: 'session-restart', usePanelInfo: (select) => select({ activePanelId: null }) });
rtRestart.paint();
await flush();
let treeRestart = rtRestart.paint();
treeRestart.children[1].props.onClick();
treeRestart = rtRestart.paint();
fetchCalls.length = 0;
stopAllCalls.length = 0;
menuKidsOf(treeRestart.children[3]).find((n) => textOf(n) === '关闭并重新打开服务').props.onClick();
await flush(40);
const restartSeq = fetchCalls
  .map((c) => c.url)
  .filter((u) => u.includes('/services/stop-all') || u.includes('/services/start-all'))
  .map((u) => (u.includes('stop-all') ? 'stop' : 'start'));
ok('重启 = 先 stop-all 再 start-all', JSON.stringify(restartSeq) === JSON.stringify(['stop', 'start']), JSON.stringify(restartSeq));
ok('重启的 stop-all 也带本项目 file', stopAllCalls[0]?.file === PROJECT.file, JSON.stringify(stopAllCalls));
ok('重启后回到「打开服务」', labelOf(rtRestart.paint().children[0]) === '打开服务', labelOf(rtRestart.paint().children[0]));

// Esc 收菜单：菜单挂在 document 监听上，键盘要能关
treeRestart = rtRestart.paint();
treeRestart.children[1].props.onClick();
await flush();
ok('Esc 前菜单是展开的', !!rtRestart.paint().children[3]);
dispatchDoc('keydown', { key: 'Escape' });
await flush();
ok('Esc 收起菜单', !rtRestart.paint().children[3]);

// ── 菜单顶部「拉起全部服务」：服务挂了不用进面板，一键把没在线的拉起来 ──
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'up', startCommand: 'pnpm dev:h5' },
];
contextPayload = {
  ok: true, sessionId: 'session-all', project: PROJECT,
  services: { total: 2, startable: 2, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rtAll = createRuntime(launcher.component, { sessionId: 'session-all', usePanelInfo: (select) => select({ activePanelId: null }) });
rtAll.paint();
await flush();
let treeAll = rtAll.paint();
treeAll.children[1].props.onClick();
treeAll = rtAll.paint();
const startAllItem = menuKidsOf(treeAll.children[3])[0];
ok('全部在线时「拉起全部服务」置灰', startAllItem?.props?.disabled === true
  && textOf(startAllItem) === '拉起全部服务', textOf(startAllItem) + '/' + startAllItem?.props?.disabled);

// 掉了一个：菜单顶部那颗就能点，点了走 start-all、不开 tab
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'down', startCommand: 'pnpm dev:h5' },
];
contextPayload = {
  ok: true, sessionId: 'session-all2', project: PROJECT,
  services: { total: 2, startable: 2, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rtAll2 = createRuntime(launcher.component, { sessionId: 'session-all2', usePanelInfo: (select) => select({ activePanelId: null }) });
rtAll2.paint();
await flush();
let treeAll2 = rtAll2.paint();
treeAll2.children[1].props.onClick();
treeAll2 = rtAll2.paint();
const startAllLive = menuKidsOf(treeAll2.children[3])[0];
ok('有一个掉线时「拉起全部服务」可点', startAllLive?.props?.disabled !== true, String(startAllLive?.props?.disabled));
fetchCalls.length = 0;
railCalls.length = 0;
startAllLive.props.onClick();
await flush(150);
const allCall = fetchCalls.find((c) => c.url.includes('/services/start-all'));
ok('「拉起全部服务」发 start-all 且带本项目 file', !!allCall
  && (() => { try { return JSON.parse(allCall.options.body).file === PROJECT.file; } catch { return false; } })(),
  allCall?.options?.body);
ok('「拉起全部服务」不开 tab', railCalls.length === 0, JSON.stringify(railCalls.length));
ok('拉起后主按钮回到「打开服务」', labelOf(rtAll2.paint().children[0]) === '打开服务', labelOf(rtAll2.paint().children[0]));

// ── 启动报「已在运行」但端口已在听：不显示失败，直接变「打开服务」──
serviceRows = [];
startAllPayload = () => {
  serviceRows = [{ id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' }];
  return {
    ok: true, started: [], skipped: [],
    failed: [{ serviceId: 'site', serviceName: 'site', error: '已在运行（pid 1）' }],
  };
};
contextPayload = {
  ok: true, sessionId: 'session-5', project: PROJECT,
  services: { total: 2, startable: 2, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rt5 = createRuntime(launcher.component, { sessionId: 'session-5', usePanelInfo: (select) => select({ activePanelId: null }) });
rt5.paint();
await flush();
let tree5 = rt5.paint();
ok('没有在线服务时按钮是「服务」', labelOf(tree5.children[0]) === '服务', labelOf(tree5.children[0]));
const startIcon = iconOf(tree5.children[0]);
ok('拉起态用电源图标（两条 path，无 rect）',
  !!startIcon && startIcon.$$type === 'svg' && (startIcon.children || []).length === 2
  && startIcon.children.every((c) => c.$$type === 'path'),
  startIcon ? startIcon.children.map((c) => c.$$type).join(',') : 'none');
ok('拉起态不带状态色', !tree5.children[0].props['data-tone'], String(tree5.children[0].props['data-tone']));
tree5.children[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 720));
await flush();
tree5 = rt5.paint();
ok('「已在运行」但探到在线时不再显示失败', labelOf(tree5.children[0]) !== '失败', labelOf(tree5.children[0]));
ok('并且切回「打开服务」', labelOf(tree5.children[0]) === '打开服务', labelOf(tree5.children[0]));

// ── 项目没有服务配置：只留「闭环」，不给永远禁用的按钮 ──
serviceRows = [];
startAllPayload = () => ({ ok: true, started: [], skipped: [], failed: [] });
contextPayload = {
  ok: true, sessionId: 'session-6', project: PROJECT,
  services: { total: 0, startable: 0, hasUrl: false }, token: true, panelId: 'card-proj-milestone',
};
const rt6 = createRuntime(launcher.component, { sessionId: 'session-6', usePanelInfo: (select) => select({ activePanelId: null }) });
rt6.paint();
await flush();
const tree6 = rt6.paint();
const tree6Buttons = (tree6.children || []).filter(Boolean);
ok('项目没有服务时只留「闭环」', tree6Buttons.length === 1 && labelOf(tree6Buttons[0]) === '闭环',
  JSON.stringify(tree6Buttons.map(labelOf)));

// ── 切会话：先用缓存出正确状态（<100ms 目标），状态请求未回也不闪 ──
serviceRows = [
  { id: 'api', name: 'API 8080', url: 'http://127.0.0.1:8080', status: 'up', startCommand: 'make api' },
  { id: 'h5', name: 'H5 10086', url: 'http://127.0.0.1:10086', status: 'up', startCommand: 'pnpm dev:h5' },
];
contextPayload = {
  ok: true, sessionId: 'session-8', project: PROJECT,
  services: { total: 2, startable: 0, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rtWarm = createRuntime(launcher.component, { sessionId: 'session-8', usePanelInfo: (select) => select({ activePanelId: null }) });
rtWarm.paint();
await flush();
ok('预热缓存：查到两个在线服务', labelOf(rtWarm.paint().children[0]) === '打开服务', labelOf(rtWarm.paint().children[0]));

// 状态请求挂起、实际状态改成空：新会话仍应先用缓存画出「打开服务」
serviceRows = [];
let releaseStatus;
statusDeferred = { promise: new Promise((resolve) => { releaseStatus = resolve; }) };
contextPayload = {
  ok: true, sessionId: 'session-9', project: PROJECT,
  services: { total: 2, startable: 0, hasUrl: true }, token: true, panelId: 'card-proj-milestone',
};
const rtSwitch = createRuntime(launcher.component, { sessionId: 'session-9', usePanelInfo: (select) => select({ activePanelId: null }) });
rtSwitch.paint();
await flush();
const treeSwitch = rtSwitch.paint();
ok('切会话首帧用缓存（状态请求还没回）', labelOf(treeSwitch.children[0]) === '打开服务', labelOf(treeSwitch.children[0]));
releaseStatus();
statusDeferred = null;
await flush();
ok('后台复核后按实际状态更新', labelOf(rtSwitch.paint().children[0]) === '服务', labelOf(rtSwitch.paint().children[0]));

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
