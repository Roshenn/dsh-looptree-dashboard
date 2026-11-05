/**
 * lib/client.js — client 半：在 DSH Web 里注册「轮转」入口。
 *
 * 打包形态与其它 DSH 客户端插件一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 里用 require 拿宿主提供的共享模块（react 等），返回 `{ apply(ctx) }`。
 *
 * 兜底策略：插槽 API 若在将来的版本里改名，这里静默降级为「只提供 URL」，
 * 不会因为 UI 注册失败把整个插件树带崩。
 */
window.__ModuleLoader__.load({
  id: 'dsh-looptree-dashboard',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const BASE = '/rotation';

    /** 打开面板：桌面端可能拦截 window.open（返回 null），此时退化为同标签跳转，
     *  保证「点了有反应」。 */
    function openPanel() {
      const url = BASE + '/app/';
      let win = null;
      try { win = window.open(url, '_blank', 'noopener'); } catch { win = null; }
      if (!win) {
        try { window.location.assign(url); } catch { window.location.href = url; }
      }
    }

    function apply(ctx) {
      const logger = ctx.logger;
      const slots = ctx.slots;

      // 激活标记：便于安装后自检（也方便用户确认插件真的跑起来了）
      try { document.documentElement.dataset.dshRotation = '1'; } catch { /* noop */ }

      // ── 面板 → DSH：切到某条会话 ──
      // 面板在 iframe 里，点「查看会话」只能发 postMessage，由宿主这一半把主区切到
      // 对应会话；缺这段监听时面板点了没反应（旧版就是这个假成功）。
      const onPanelMessage = (event) => {
        const data = event && event.data;
        if (!data || typeof data !== 'object') return;
        // 只认同源消息：面板由本服务同源提供，跨源页面无权切会话 / 切主区
        try { if (event.origin !== window.location.origin) return; } catch { return; }
        // 面板里的「← 回会话」：主区切回对话（composer 卡片只有对话里才有，回程按钮在面板里）
        if (data.type === 'rotation-back-to-conversation') {
          try {
            const layout = (typeof ctx.get === 'function' ? ctx.get('layout') : undefined) || ctx.layout;
            if (!layout || typeof layout.selectPanel !== 'function') throw new Error('DSH 未暴露 layout.selectPanel');
            layout.selectPanel(null);
            logger?.info?.('[rotation] back to conversation');
          } catch (error) {
            logger?.warn?.('[rotation] back to conversation failed: ' + ((error && error.message) || error));
          }
          return;
        }
        if (data.type !== 'rotation-open-session' || !data.sessionId) return;
        let ok = true;
        let error = '';
        try {
          const workspace = ctx.get('uiWorkspace');
          if (!workspace || typeof workspace.openSession !== 'function') {
            throw new Error('DSH 未提供 uiWorkspace.openSession');
          }
          workspace.openSession(String(data.sessionId));
          logger?.info?.('[rotation] switched to ' + data.sessionId);
        } catch (caught) {
          ok = false;
          error = (caught && caught.message) || String(caught);
          logger?.warn?.('[rotation] open session failed: ' + error);
        }
        try {
          (event.source || window).postMessage(
            { type: 'rotation-open-session-result', reqId: data.reqId, ok, error }, '*');
        } catch { /* noop */ }
      };
      try { window.addEventListener('message', onPanelMessage); } catch { /* noop */ }

      // ── 面板 → DSH：在内嵌浏览器打开服务地址 ──
      // 面板在 iframe 里建不了 sidebar tab，只能把 URL 交给宿主这一半。
      // 落点优先级：右栏 browser tab（对话在左、页面在右）→ 主区自己的内嵌页。
      let openServiceInMain = null;   // 主区页在 React 就绪后赋值

      const getLayout = () => (typeof ctx.get === 'function' ? ctx.get('layout') : undefined) || ctx.layout;
      const getSidebar = () => (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined) || ctx.sidebarRight;

      /**
       * openTab 要两个前置条件，缺一就抛 'no session surface is mounted'：
       *   1) 主区当前是对话（sidebarRight 只在这时登记 on-screen 会话）；
       *   2) 右栏被渲染过（store 才被 adopt）。
       * 右栏先拉起来（并退出全屏），让页面和对话并排；还开不了再切回对话重试。
       */
      const ensureRail = (why) => {
        const layout = getLayout();
        if (!layout || typeof layout.openRightbar !== 'function') return false;
        try {
          // true = 显示右栏，false = 非全屏：用户要的是「左对话 / 右页面」并排
          layout.openRightbar(true, false);
          logger?.info?.('[rotation] right rail shown for ' + why);
          return true;
        } catch (error) {
          logger?.warn?.('[rotation] open right rail failed: ' + ((error && error.message) || error));
          return false;
        }
      };
      const ensureConversation = (why) => {
        const layout = getLayout();
        if (!layout || typeof layout.selectPanel !== 'function') return false;
        try {
          // null = 回到对话；sidebarRight 只在这时把当前会话登记为 on-screen
          layout.selectPanel(null);
          logger?.info?.('[rotation] switched back to conversation for ' + why);
          return true;
        } catch (error) {
          logger?.warn?.('[rotation] select conversation failed: ' + ((error && error.message) || error));
          return false;
        }
      };

      /** 当前右栏挂载的会话（sidebarRight.screen()）：{ sessionId, surface } 或 undefined */
      const mountedSession = () => {
        const sidebar = getSidebar();
        if (!sidebar || typeof sidebar.screen !== 'function') return undefined;
        try { return sidebar.screen(); } catch { return undefined; }
      };
      const getUiWorkspace = () => (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) || ctx.uiWorkspace;
      /** 把主区切到目标会话；页面得开在「这条会话」的右栏里，才跟工作区对得上 */
      const switchToSession = (sessionId) => {
        const uiWorkspace = getUiWorkspace();
        if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
          throw new Error('DSH 未提供 uiWorkspace.openSession');
        }
        uiWorkspace.openSession(String(sessionId));
      };
      /** 工作区里还没有会话：先建一条（connectWorkspace 返回它的 id）再切过去 */
      const createWorkspaceSession = async (workspaceId) => {
        const uiWorkspace = getUiWorkspace();
        if (!uiWorkspace || typeof uiWorkspace.connectWorkspace !== 'function') {
          throw new Error('DSH 未提供 uiWorkspace.connectWorkspace');
        }
        const created = await uiWorkspace.connectWorkspace(String(workspaceId));
        if (!created) throw new Error('新建会话没有返回 id');
        switchToSession(created);
        return String(created);
      };
      /**
       * 等主区真的落到目标会话再开 tab：openSession 只是发了一个导航意图，
       * 早一帧调 openTab 会开在旧会话的右栏（多项目并行时就是串台）。
       * 宿主没暴露 screen() 时不等，交给后面的重试阶梯兜。
       */
      const waitForSession = (sessionId, timeoutMs = 1800) => new Promise((resolve) => {
        const id = String(sessionId || '');
        const sidebar = getSidebar();
        if (!id || !sidebar || typeof sidebar.screen !== 'function') return resolve(false);
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          const screen = mountedSession();
          // 只认「主区已经是这条会话」：surface 还没 adopt 也没关系，openTab 的重试阶梯会等它
          if (screen && String(screen.sessionId) === id) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(tick, 60);
        };
        tick();
      });

      /**
       * 把服务地址开进 DSH 内嵌浏览器：优先右栏 browser tab（对话在左、页面在右），
       * 右栏不可用时退到主区内嵌页，绝不弹系统浏览器。
       * 面板消息通道与 composer 卡片共用这一份落点逻辑。
       * 返回 Promise<{ ok, mode: 'sidebar'|'panel'|'', error }>。
       */
      const openServiceUrl = (rawUrl) => new Promise((resolve) => {
        let target = '';
        try {
          // 只放行 http(s)：file: / javascript: 一律拒
          const parsed = new URL(String(rawUrl));
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('只支持 http/https 地址');
          }
          target = parsed.toString();
        } catch (caught) {
          const error = (caught && caught.message) || '地址无法解析';
          logger?.warn?.('[rotation] open url rejected: ' + error);
          resolve({ ok: false, mode: '', error });
          return;
        }

        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        const openInSidebar = () => {
          const sidebar = getSidebar();
          if (!sidebar || typeof sidebar.openTab !== 'function') {
            throw new Error('DSH 未暴露 sidebarRight.openTab（client 半拿不到 sidebar 服务）');
          }
          sidebar.openTab('browser', { params: { url: target } });
        };
        const finishFailure = (error) => {
          // 右栏实在开不了：退到主区自己的内嵌页，页面仍在 DSH 里，不弹系统浏览器
          try {
            if (openServiceInMain && openServiceInMain(target)) {
              logger?.info?.('[rotation] opened in main-area panel: ' + target);
              finish({ ok: true, mode: 'panel' });
              return;
            }
          } catch (inner) {
            logger?.warn?.('[rotation] main-area open failed: ' + ((inner && inner.message) || inner));
          }
          finish({ ok: false, mode: '', error });
        };
        /** 先把右栏拉起来（非全屏），页面和对话并排而不是全屏盖住会话 */
        const openTabNow = () => {
          ensureRail(target);
          try {
            openInSidebar();
            logger?.info?.('[rotation] opened in sidebar browser: ' + target);
            finish({ ok: true, mode: 'sidebar' });
            return;
          } catch (caught) {
            const first = (caught && caught.message) || String(caught);
            logger?.warn?.('[rotation] sidebar browser open failed: ' + first);
            // 主区还被面板占着：切回对话，on-screen 会话才会登记；右栏 store 的 adopt 也要等渲染
            if (!ensureConversation(target) && !ensureRail(target)) return finishFailure(first);
            // 右栏可能只是「挂载了但仍收起」（surface.layout.expanded === false）：补一次展开
            const nudgeRail = () => {
              const sidebar = getSidebar();
              if (!sidebar) return;
              try {
                if (typeof sidebar.isExpanded === 'function' && sidebar.isExpanded() === false
                  && typeof sidebar.toggleExpanded === 'function') {
                  sidebar.toggleExpanded();
                  logger?.info?.('[rotation] right rail expanded for ' + target);
                }
              } catch { /* 还没 adopt 时会抛，留给下一轮重试 */ }
            };
            // 切面板 + 起右栏要等 React 渲染与 store adopt，按 120/260/500ms 重试三次
            const delays = [120, 260, 500];
            let attempt = 0;
            const retry = () => {
              nudgeRail();
              try {
                openInSidebar();
                logger?.info?.('[rotation] opened in sidebar browser (after prepare): ' + target);
                finish({ ok: true, mode: 'sidebar' });
              } catch (error) {
                if (attempt < delays.length) {
                  const wait = delays[attempt];
                  attempt += 1;
                  setTimeout(retry, wait);
                  return;
                }
                logger?.warn?.('[rotation] sidebar browser still failing: ' + ((error && error.message) || error));
                finishFailure((error && error.message) || first);
              }
            };
            setTimeout(retry, delays[attempt]);
            attempt += 1;
          }
        };
        openTabNow();
      });

      const onPanelOpenUrl = (event) => {
        const data = event && event.data;
        if (!data || data.type !== 'rotation-open-url' || !data.url) return;
        try { if (event.origin !== window.location.origin) return; } catch { return; }
        const reply = (ok, error, mode, note) => {
          try {
            (event.source || window).postMessage(
              { type: 'rotation-open-url-result', reqId: data.reqId, ok, error, mode, note }, '*');
          } catch { /* noop */ }
        };
        let target = '';
        try {
          // 这条通道能把地址塞进宿主浏览器，只放行 http(s)：file: / javascript: 一律拒
          const parsed = new URL(String(data.url));
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('只支持 http/https 地址');
          }
          target = parsed.toString();
        } catch (caught) {
          const error = (caught && caught.message) || '地址无法解析';
          logger?.warn?.('[rotation] open url rejected: ' + error);
          reply(false, error);
          return;
        }

        // 面板带了会话 / 工作区：先切过去再开；没带就是老行为（开在当前会话）
        const run = async () => {
          const wantedSession = data.sessionId ? String(data.sessionId) : '';
          const workspaceId = data.workspaceId ? String(data.workspaceId) : '';
          const projectName = typeof data.project === 'string' ? data.project : '';
          let note = '';
          let landed = '';
          if (wantedSession || workspaceId) {
            try {
              landed = wantedSession || await createWorkspaceSession(workspaceId);
              if (wantedSession) switchToSession(wantedSession);
              note = projectName ? `已切到「${projectName}」的会话` : '已切到该项目的会话';
              logger?.info?.(`[rotation] switched to ${landed} before opening ${target}`);
            } catch (error) {
              const why = (error && error.message) || String(error);
              logger?.warn?.('[rotation] session switch failed: ' + why);
              note = `切换会话失败（${why}），用当前会话打开`;
              landed = '';
            }
          }
          if (landed) {
            // 先把右栏拉起来：右栏只为「当前会话」adopt store，不提前起会白等 screen()
            ensureRail(target);
            await waitForSession(landed);
          }
          const result = await openServiceUrl(target);
          if (result.ok) logger?.info?.('[rotation] opened ' + target + ' in ' + result.mode);
          reply(result.ok, result.ok ? '' : (result.error || ''), result.mode, note);
        };
        run();
      };
      try { window.addEventListener('message', onPanelOpenUrl); } catch { /* noop */ }

      if (!slots || typeof slots.register !== 'function') {
        logger?.info?.('[rotation] slots unavailable, panel reachable at ' + BASE + '/app/');
        return;
      }

      const React = require('react');
      const h = React.createElement;

      // ── 侧边栏条目 + 主区页面（iframe 承载现有面板）──
      const PANEL_ID = 'rotation';
      const PANEL_LABEL = '轮转闭环树';

      // ── composer 卡片 → 面板导航 ──
      // 面板是主区 iframe：每次切过去都会重新挂载，所以「聚焦哪个项目」要挂在 URL 上；
      // 已经停在面板上时改走 postMessage，不为换项目再重载一次 iframe。
      const panelNav = { project: '', seq: 0, listeners: new Set() };
      const focusPanel = (project) => {
        panelNav.project = String(project || '');
        panelNav.seq += 1;
        for (const listener of panelNav.listeners) {
          try { listener(panelNav.seq); } catch { /* noop */ }
        }
      };
      const panelQuery = () => {
        const qs = new URLSearchParams();
        qs.set('theme', hostTheme());
        if (panelNav.project) {
          qs.set('view', 'focus');
          qs.set('project', panelNav.project);
          qs.set('current', '1');
        }
        return BASE + '/app/?' + qs.toString();
      };

      // ── composer 卡片 → host 接口 ──
      // 写令牌由 host 用 webServer.tapIndex 注入 DSH 首页（跨源页面读不到，写接口的
      // 同源校验不变）。拿不到令牌时只禁用「服务」，不藏整张卡片。
      const clientToken = () => {
        try { return String(window.__ROTATION_TOKEN__ || ''); } catch { return ''; }
      };
      const apiBase = () => {
        try {
          const injected = String(window.__ROTATION_API_ABS__ || '').replace(/\/+$/, '');
          if (injected) return injected;
        } catch { /* noop */ }
        return BASE + '/api';
      };
      const rotationFetch = (path, options) => {
        const opts = options || {};
        const headers = Object.assign({}, opts.headers || {});
        const token = clientToken();
        if (token) headers['x-rotation-token'] = token;
        return fetch(apiBase() + path, Object.assign({}, opts, { headers }));
      };

      /** 当前宿主主题：优先 html[data-theme]，其次系统偏好 */
      function hostTheme() {
        try {
          const attr = document.documentElement.dataset.theme;
          if (attr === 'light' || attr === 'dark') return attr;
        } catch { /* noop */ }
        try {
          return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } catch { return 'dark'; }
      }

      const Page = () => {
        const frameRef = React.useRef(null);
        // 首次挂载时按当前导航目标算 URL；之后只发消息，不重载 iframe
        const srcRef = React.useRef(null);
        if (srcRef.current === null) srcRef.current = panelQuery();
        const [navSeq, setNavSeq] = React.useState(panelNav.seq);
        React.useEffect(() => {
          const listener = (next) => setNavSeq(next);
          panelNav.listeners.add(listener);
          return () => { panelNav.listeners.delete(listener); };
        }, []);
        React.useEffect(() => {
          const push = () => {
            const f = frameRef.current;
            if (!f || !f.contentWindow) return;
            try { f.contentWindow.postMessage({ type: 'rotation-theme', theme: hostTheme() }, '*'); } catch { /* noop */ }
            if (panelNav.project) {
              try { f.contentWindow.postMessage({ type: 'rotation-focus', project: panelNav.project, current: true }, '*'); } catch { /* noop */ }
            }
          };
          push();
          const onLoad = () => push();
          const f = frameRef.current;
          f && f.addEventListener('load', onLoad);
          let observer = null;
          try {
            observer = new MutationObserver(push);
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
          } catch { /* noop */ }
          let mq = null;
          try {
            mq = window.matchMedia('(prefers-color-scheme: light)');
            mq.addEventListener?.('change', push);
          } catch { /* noop */ }
          return () => {
            f && f.removeEventListener('load', onLoad);
            observer?.disconnect();
            try { mq?.removeEventListener?.('change', push); } catch { /* noop */ }
          };
        }, [navSeq]);
        return h('div', { style: { position: 'relative', height: '100%', minHeight: 0, flex: 1 } },
          h('iframe', {
            ref: frameRef,
            src: srcRef.current,
            title: PANEL_LABEL,
            style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: 'transparent' },
          }));
      };
      // 图标：左→右展开的树（根节点在左，两根分叉到右侧子节点）
      const Icon = () => h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', style: { flex: '0 0 auto' },
      },
        // 主干 + 两根分叉（左根右叶，读法即「展开」）
        h('path', {
          d: 'M4.6 8h2.6M7.2 4.4v7.2M7.2 4.4h2.6M7.2 11.6h2.6',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('circle', { cx: 3, cy: 8, r: 1.7, fill: 'currentColor' }),
        h('circle', { cx: 11.8, cy: 4.4, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 11.8, cy: 11.6, r: 1.5, fill: 'currentColor' }));

      // ── composer 卡片：模型选择器左边的两个按钮（服务拉起 / 展开闭环）──
      // 落点是宿主的 conversation.input.right（在 model 座位之前渲染），只加一个 cell，
      // 不替换任何自带控件；工作区没登记成项目时整张卡不渲染。
      const LAUNCHER_CSS = [
        '.dsh-rll{display:inline-flex;align-items:center;gap:1px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
        '.dsh-rll-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;cursor:pointer;white-space:nowrap}',
        '.dsh-rll-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
        '.dsh-rll-btn:disabled{opacity:.45;cursor:default}',
        '.dsh-rll-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dsh-rll-btn[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
        '.dsh-rll-btn[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
        '.dsh-rll-btn[data-tone="busy"]{color:var(--dsw-alias-brand-primary)}',
        '.dsh-rll-btn[data-tone="open"]{color:var(--dsw-alias-brand-primary)}',
        '.dsh-rll-spin{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:dsh-rll-spin .7s linear infinite}',
        '@keyframes dsh-rll-spin{to{transform:rotate(360deg)}}',
        '.dsh-rll-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      ].join('');
      const ensureLauncherStyle = () => {
        try {
          const id = 'dsh-looptree-dashboard/launcher.css';
          if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-looptree-dashboard';
          style.dataset.pluginCss = id;
          style.textContent = LAUNCHER_CSS;
          (document.head || document.documentElement).appendChild(style);
        } catch { /* noop */ }
      };

      // 电源图标：给「服务」按钮，与闭环的树图标区分
      const PowerIcon = () => h('svg', {
        width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M8 2.2v5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M4.7 4.4a5 5 0 1 0 6.6 0', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));

      const SERVICE_OK_MS = 2200;
      const SERVICE_ERR_MS = 6000;
      const SERVICE_MIN_SPIN_MS = 600;
      const OPEN_MIN_SPIN_MS = 350;
      const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || ''));

      function Launcher(props) {
        const sessionId = props && props.sessionId;
        // 标准 props 里有 usePanelInfo（选中主区面板）；mock / 老宿主里可能没有
        const usePanelInfo = (props && props.usePanelInfo) || (() => null);
        const activePanelId = usePanelInfo((info) => (info && info.activePanelId) || null);
        const [info, setInfo] = React.useState(null);      // { project, services, token, panelId }
        const [rows, setRows] = React.useState(null);      // GET /services?file 的结果；null = 还没查到
        const [phase, setPhase] = React.useState('idle');  // idle | checking | starting | opening | ok | error
        const [note, setNote] = React.useState('');
        const [refresh, setRefresh] = React.useState(0);
        const timer = React.useRef(null);
        const mounted = React.useRef(true);
        const rowsAt = React.useRef(0);
        React.useEffect(() => () => { mounted.current = false; }, []);

        const projectFile = info && info.project ? String(info.project.file || '') : '';

        /** 服务实况：探活一次拿 status（up / down / starting / watch），失败当空表 */
        const fetchServiceRows = async (file) => {
          if (!file) return [];
          try {
            const res = await rotationFetch('/services?file=' + encodeURIComponent(file));
            const body = await res.json().catch(() => null);
            const list = body && body.ok && Array.isArray(body.services) ? body.services : [];
            rowsAt.current = Date.now();
            return list;
          } catch { return []; }
        };
        const refreshRows = async () => {
          const next = await fetchServiceRows(projectFile);
          if (mounted.current) setRows(next);
          return next;
        };

        // 上下文：session → 工作区 → 项目 + 服务配置概览（host 不探活，首屏不卡）
        React.useEffect(() => {
          if (!sessionId) { setInfo({ project: null }); return undefined; }
          let alive = true;
          let ctrl = null;
          try { ctrl = typeof AbortController === 'function' ? new AbortController() : null; } catch { ctrl = null; }
          (async () => {
            try {
              const res = await rotationFetch('/session/context?sessionId=' + encodeURIComponent(String(sessionId)), {
                signal: ctrl ? ctrl.signal : undefined,
              });
              const body = await res.json().catch(() => null);
              if (!alive) return;
              if (!body || body.ok !== true || !body.project) { setInfo({ project: null }); return; }
              setInfo({ project: body.project, services: body.services || {}, token: !!body.token, panelId: String(body.panelId || '') });
            } catch (error) {
              if (!alive) return;
              // 网络/宿主异常：已有信息就保留，首帧失败才隐藏，绝不把 composer 带崩
              setInfo((prev) => prev || { project: null });
            }
          })();
          return () => { alive = false; try { ctrl && ctrl.abort(); } catch { /* noop */ } };
        }, [sessionId, refresh]);

        // 服务实况独立异步查：先让卡片出现，查到在线就把「服务」切成「打开服务」
        React.useEffect(() => {
          if (!projectFile) { setRows(null); return undefined; }
          let cancelled = false;
          (async () => {
            const next = await fetchServiceRows(projectFile);
            if (!cancelled && mounted.current) setRows(next);
          })();
          return () => { cancelled = true; };
        }, [projectFile, refresh]);

        React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
        const schedule = (ms) => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => { setPhase('idle'); setNote(''); }, ms);
        };

        /** 在线且能打开的服务（有 http(s) 地址）；watch 服务在线也没有页面可开 */
        const openTargetsOf = (list) => (Array.isArray(list) ? list : [])
          .filter((row) => row && row.status === 'up' && isHttpUrl(row.url));
        /** 还没在线、但当前平台有启动命令的服务 */
        const pendingOf = (list) => (Array.isArray(list) ? list : [])
          .filter((row) => row && row.status !== 'up' && row.startCommand);

        const onServiceAction = async () => {
          if (!info || !info.project || phase === 'starting' || phase === 'opening' || phase === 'checking') return;
          setNote('');
          // 实况过期（>10s）或还没查过：点击时先补一次，避免拿旧状态做错事
          let current = rows;
          if (current === null || Date.now() - rowsAt.current > 10000) {
            setPhase('checking');
            current = await refreshRows();
            if (!mounted.current) return;
          }
          const upNow = openTargetsOf(current);
          if (upNow.length) {
            // 已经在线：不重复拉起，直接在右栏逐个打开（用户选的「全部在线服务各开一个 tab」）
            setPhase('opening');
            const t0 = Date.now();
            let opened = 0;
            let lastError = '';
            for (const row of upNow) {
              const result = await openServiceUrl(row.url);
              if (result.ok) opened += 1;
              else lastError = result.error || '';
            }
            const rest = OPEN_MIN_SPIN_MS - (Date.now() - t0);
            if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
            if (!mounted.current) return;
            if (opened) {
              setPhase('ok');
              setNote('已在右栏打开 ' + opened + ' 个服务');
              schedule(SERVICE_OK_MS);
            } else {
              setPhase('error');
              setNote(lastError || '打开服务失败');
              schedule(SERVICE_ERR_MS);
            }
            return;
          }

          // 没有在线服务：拉起未在线的
          const startable = (info.services && info.services.startable) || 0;
          if (!startable || !info.token) return;
          setPhase('starting');
          const t0 = Date.now();
          try {
            const res = await rotationFetch('/services/start-all', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ file: info.project.file }),
            });
            const body = await res.json().catch(() => null);
            const started = (body && body.started) || [];
            const failed = (body && body.failed) || [];
            // 启动后再探一次：报「已在运行」但端口已经在听的，算在线，不显示失败
            const fresh = await refreshRows();
            if (!mounted.current) return;
            const upAfter = openTargetsOf(fresh);
            const rest = SERVICE_MIN_SPIN_MS - (Date.now() - t0);
            if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
            if (upAfter.length) {
              setPhase('ok');
              setNote(started.length ? ('已拉起 ' + started.length + ' 个服务') : '服务已在线');
              schedule(SERVICE_OK_MS);
            } else if (failed.length) {
              setPhase('error');
              setNote((failed[0] && failed[0].error) || '启动失败');
              schedule(SERVICE_ERR_MS);
            } else if (!res.ok || !body || body.ok === false) {
              setPhase('error');
              setNote((body && body.error) || ('启动失败（HTTP ' + res.status + '）'));
              schedule(SERVICE_ERR_MS);
            } else {
              setPhase('ok');
              setNote('已提交启动');
              schedule(SERVICE_OK_MS);
            }
            setRefresh((n) => n + 1);
          } catch (error) {
            if (!mounted.current) return;
            setPhase('error');
            setNote('启动请求失败：' + ((error && error.message) || String(error)));
            schedule(SERVICE_ERR_MS);
          }
        };

        const openLoop = () => {
          if (!info || !info.project) return;
          const layout = getLayout();
          try {
            if (activePanelId === PANEL_ID) { layout.selectPanel(null); return; }
            // 先把目标记进导航，再切面板：新挂载的 iframe 会带着 ?view=focus&project=…&current=1
            focusPanel(info.panelId || info.project.id);
            layout.selectPanel(PANEL_ID);
          } catch (error) {
            logger?.warn?.('[rotation] focus panel failed: ' + ((error && error.message) || error));
            try { openPanel(); } catch { /* noop */ }
          }
        };

        if (!info || !info.project) return null;
        const services = info.services || {};
        const known = rows !== null;
        const openTargets = openTargetsOf(rows);
        const pendingStart = pendingOf(rows);
        // 项目没有任何服务配置时只留「闭环」，不给一个永远禁用的按钮
        const hasServices = (services.total > 0) || (known && rows.length > 0);
        const mode = openTargets.length ? 'open' : 'start';
        const busy = phase === 'starting' || phase === 'opening' || phase === 'checking';
        const canStart = !!info.token && ((services.startable > 0) || pendingStart.length > 0);
        const disabled = busy || (mode === 'start' && !canStart);

        const serviceLabel = phase === 'starting' ? '拉起中'
          : phase === 'opening' ? '打开中'
            : phase === 'checking' ? '检查中'
              : phase === 'error' ? '失败'
                : phase === 'ok' && mode === 'start' ? '已在线'
                  : mode === 'open' ? '打开服务'
                    : '服务';
        const openNames = openTargets.map((row) => row.name || row.id).join('、');
        const serviceTitle = phase === 'starting' ? '正在拉起服务…'
          : phase === 'opening' ? ('正在右栏打开：' + openNames)
            : phase === 'checking' ? '正在检查服务是否在线…'
              : phase === 'ok' ? note
                : phase === 'error' ? note
                  : mode === 'open'
                    ? ('在右栏打开：' + openNames
                      + (pendingStart.length ? ('；另有 ' + pendingStart.length + ' 个服务未在线，可在面板里处理') : ''))
                    : !(services.total > 0) ? '该项目还没有登记服务（先在面板里收集一次）'
                      : !info.token ? '宿主要先注入写令牌才能拉起服务（DSH 版本较旧）'
                        : !(services.startable > 0) ? '当前平台没有可用的启动命令'
                          : ('一键拉起当前项目的 ' + services.startable + ' 个服务');
        const tone = busy ? 'busy'
          : phase === 'ok' ? 'ok'
            : phase === 'error' ? 'error'
              : mode === 'open' ? 'open' : '';
        const loopTitle = '展开「' + info.project.name + '」的闭环视图';

        return h('div', { className: 'dsh-rll' },
          hasServices
            ? h('button', {
              type: 'button',
              className: 'dsh-rll-btn',
              title: serviceTitle,
              'aria-label': serviceTitle,
              'data-tone': tone || undefined,
              disabled,
              onClick: onServiceAction,
            },
            busy
              ? h('span', { className: 'dsh-rll-spin', 'aria-hidden': 'true' })
              : h(PowerIcon, null),
            h('span', null, serviceLabel),
            note ? h('span', { className: 'dsh-rll-sr', role: 'status' }, note) : null)
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-rll-btn',
            title: loopTitle,
            'aria-label': loopTitle,
            'data-tone': activePanelId === PANEL_ID ? 'busy' : undefined,
            onClick: openLoop,
          },
          h(Icon, null),
          h('span', null, '闭环')));
      }

      try {
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: undefined }, Page));
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => PANEL_LABEL,
        }, Icon));
        logger?.info?.('[rotation] sidebar entry + main page registered');
      } catch (error) {
        logger?.warn?.('[rotation] panel registration failed: ' + (error && error.message));
      }

      // composer 右下角的双按钮卡片：宿主声明 conversation.input.right 之前先登记 effect，
      // 声明一到就挂上；宿主版本没有这个座位时静默跳过，不影响其余入口。
      try {
        ensureLauncherStyle();
        slots.inject('conversation.input.right', () => slots.register({
          name: 'conversation.input.right', id: 'rotation-launch', order: 20,
        }, Launcher));
        logger?.info?.('[rotation] composer launcher registered');
      } catch (error) {
        logger?.warn?.('[rotation] composer launcher registration failed: ' + (error && error.message));
      }

      // ── 主区内嵌页：右栏没挂载时把服务页面留在 DSH 里 ──
      // sidebarRight.openTab 要求右栏为当前会话 adopt 过 store（否则抛
      // 'no session surface is mounted'）；用户从没展开右栏时就会走到这里。
      const SERVICE_ID = 'rotation-service';
      const serviceNav = { url: '', seq: 0, listeners: new Set() };
      const pushServiceUrl = (url) => {
        serviceNav.url = url;
        serviceNav.seq += 1;
        for (const listener of serviceNav.listeners) {
          try { listener(serviceNav.seq); } catch { /* noop */ }
        }
      };
      const selectMainPanel = (key) => {
        const layout = (typeof ctx.get === 'function' ? ctx.get('layout') : undefined) || ctx.layout;
        if (!layout || typeof layout.selectPanel !== 'function') return false;
        layout.selectPanel(key);
        return true;
      };
      const ServicePage = () => {
        const [seq, setSeq] = React.useState(serviceNav.seq);
        React.useEffect(() => {
          const listener = (next) => setSeq(next);
          serviceNav.listeners.add(listener);
          return () => { serviceNav.listeners.delete(listener); };
        }, []);
        const url = serviceNav.url;
        const barButton = (label, onClick) => h('button', {
          type: 'button',
          onClick,
          style: {
            height: '24px', padding: '0 10px', borderRadius: '6px', cursor: 'pointer',
            border: '1px solid #ffffff29', background: 'transparent', color: '#f9fafb', fontSize: '12px',
          },
        }, label);
        return h('div', { style: { position: 'relative', height: '100%', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' } },
          h('div', {
            style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #ffffff1a', flex: '0 0 auto' },
          },
          barButton('← 里程碑树', () => { try { selectMainPanel(PANEL_ID); } catch { /* noop */ } }),
          h('span', { style: { flex: 1, minWidth: 0, color: '#979da6', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, url),
          barButton('系统浏览器', () => { try { window.open(url, '_blank', 'noopener'); } catch { /* noop */ } })),
          h('iframe', {
            key: String(seq),
            src: url || 'about:blank',
            title: '服务页面',
            style: { flex: 1, width: '100%', border: 0, background: '#fff' },
          }));
      };
      try {
        slots.inject('main', () => slots.register({ name: 'main', key: SERVICE_ID, locale: undefined }, ServicePage));
      } catch (error) {
        logger?.warn?.('[rotation] service panel registration failed: ' + (error && error.message));
      }
      openServiceInMain = (url) => {
        if (!url) return false;
        pushServiceUrl(url);
        return selectMainPanel(SERVICE_ID);
      };

      const body = () => h(
        'div',
        { style: { padding: '14px 12px', font: '12px/1.6 -apple-system,system-ui,sans-serif', color: '#cfd3d6' } },
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: '#f9fafb', marginBottom: '4px' } }, '轮转闭环树'),
        h('div', { style: { color: '#979da6', marginBottom: '10px' } }, '多项目的闭环 / 目标 / 构思 / 执行泳道视图'),
        h('button', {
          type: 'button',
          onClick: openPanel,
          style: {
            height: '26px', padding: '0 10px', borderRadius: '6px', cursor: 'pointer',
            border: '1px solid #ffffff29', background: '#232324', color: '#f9fafb', fontSize: '12px',
          },
        }, '打开面板'),
        h('div', { style: { marginTop: '10px', color: '#6f757c', fontSize: '11px' } },
          '数据写在各自 workspace 的 .dsh/rotation.json'),
      );

      const title = () => h('span', null, '轮转闭环树');

      // 激活标记：便于安装后自检（也方便用户确认插件真的跑起来了）
      try { document.documentElement.dataset.dshRotation = '1'; } catch { /* noop */ }

      try {
        slots.inject('sidebar.right.pane.tab', () =>
          slots.register({ name: 'sidebar.right.pane.tab', key: 'rotation-dashboard', inject: () => ({}) }, body));
        slots.inject('sidebar.right.pane.tab.title', () =>
          slots.register({ name: 'sidebar.right.pane.tab.title', key: 'rotation-dashboard', inject: () => ({}) }, title));
        logger?.info?.('[rotation] sidebar tab registered');
      } catch (error) {
        logger?.warn?.('[rotation] slot registration failed: ' + (error && error.message));
      }
    }

    exports.name = 'dsh-looptree-dashboard-client';
    exports.inject = ['slots', 'layout'];
    exports.apply = apply;
    exports.openPanel = openPanel;
    return module.exports;
  },
});
