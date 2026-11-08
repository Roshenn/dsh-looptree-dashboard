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

      /**
       * 宿主能力探测：`/services/stop-all` 是否支持按项目收窄（带 file）。
       * 旧宿主会忽略 body 直接全局关停，所以拿不到这个信号时客户端禁用「重启 / 全部关闭」——
       * 页面刷新拿到新 client、但 host 半还没重启时，「关掉本项目」不能变成「关掉所有项目」。
       * 结果在本次页面生命周期内缓存，最多一次网络请求。
       */
      let scopedServicesCapable = null;
      const probeScopedServices = async () => {
        if (scopedServicesCapable !== null) return scopedServicesCapable;
        try {
          const res = await rotationFetch('/health');
          const body = await res.json().catch(() => null);
          scopedServicesCapable = !!(body && body.ok && body.client && body.client.servicesScoped === true);
        } catch {
          scopedServicesCapable = false;
        }
        return scopedServicesCapable;
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
      // 状态色一律「状态色 62% + 次级文字色」混成低饱和，再配 7% 的极浅底色：
      // 只做状态提示，不跟模型选择器/发送按钮抢注意力（暗色主题下同样成立）。
      // 注意 brand-primary 在这套主题里是「黑白对比色」（浅色=近黑、深色=近白），不能当蓝色用；
      // 打开服务用 success（= 服务已在跑），拉起前是中性灰。
      const toneColor = (name) => `color-mix(in srgb, var(--dsw-alias-${name}) 62%, var(--dsw-alias-label-secondary))`;
      const toneWash = (name, pct) => `color-mix(in srgb, var(--dsw-alias-${name}) ${pct}%, transparent)`;
      const LAUNCHER_CSS = [
        '.dsh-rll{display:inline-flex;align-items:center;gap:1px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
        '.dsh-rll-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;cursor:pointer;white-space:nowrap;transition:color .16s ease,background-color .16s ease}',
        '.dsh-rll-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
        '.dsh-rll-btn:not([data-tone]):hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
        '.dsh-rll-btn:disabled{opacity:.45;cursor:default}',
        '.dsh-rll-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dsh-rll-btn[data-tone="open"]{color:' + toneColor('state-success-primary') + ';background:' + toneWash('state-success-primary', 7) + '}',
        '.dsh-rll-btn[data-tone="busy"]{color:var(--dsw-alias-label-secondary);background:' + toneWash('label-secondary', 8) + '}',
        '.dsh-rll-btn[data-tone="ok"]{color:' + toneColor('state-success-primary') + ';background:' + toneWash('state-success-primary', 7) + '}',
        '.dsh-rll-btn[data-tone="error"]{color:' + toneColor('state-error-primary') + ';background:' + toneWash('state-error-primary', 7) + '}',
        '.dsh-rll-btn[data-tone]:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}',
        '.dsh-rll-spin{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:dsh-rll-spin .7s linear infinite}',
        '@keyframes dsh-rll-spin{to{transform:rotate(360deg)}}',
        '.dsh-rll-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
        // 小三角：分裂按钮的菜单半。右边缘与 .dsh-rll 对齐，配色跟着主按钮的 tone 走
        '.dsh-rll-caret{display:inline-flex;align-items:center;justify-content:center;width:16px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,background-color .16s ease}',
        '.dsh-rll-caret:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
        '.dsh-rll-caret:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dsh-rll-caret[data-tone="open"],.dsh-rll-caret[data-tone="ok"]{color:' + toneColor('state-success-primary') + ';background:' + toneWash('state-success-primary', 7) + '}',
        '.dsh-rll-caret[data-tone="busy"]{color:var(--dsw-alias-label-secondary);background:' + toneWash('label-secondary', 8) + '}',
        '.dsh-rll-caret[data-tone="error"]{color:' + toneColor('state-error-primary') + ';background:' + toneWash('state-error-primary', 7) + '}',
        '.dsh-rll-caret[data-tone]:hover{background:color-mix(in srgb,currentColor 9%,transparent)}',
        // 菜单：position:fixed + 打开时提升到 top layer（popover），不会被 composer 的
        // overflow / transform 裁剪；左对齐右边缘对齐整个按钮组，向上展开
        '.dsh-rll-menu{position:fixed;min-width:190px;max-width:268px;margin:0;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:1px;font:500 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;z-index:2147483000}',
        '.dsh-rll-mi{display:flex;align-items:center;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dsh-rll-mi:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
        '.dsh-rll-mi:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
        '.dsh-rll-mi:disabled{color:var(--dsw-alias-label-secondary);opacity:.55;cursor:default}',
        '.dsh-rll-mi.is-muted{color:var(--dsw-alias-label-secondary);cursor:default}',
        '.dsh-rll-mi[data-danger="1"]{color:' + toneColor('state-error-primary') + ';background:' + toneWash('state-error-primary', 8) + '}',
        // 服务行 = 选择项：左侧勾选槽位固定宽，右侧可带「未在线」标记
        '.dsh-rll-pick{display:flex;align-items:center;gap:6px}',
        '.dsh-rll-tick{display:inline-flex;align-items:center;justify-content:center;width:14px;flex:0 0 auto;color:transparent}',
        '.dsh-rll-pick[aria-checked="true"] .dsh-rll-tick{color:' + toneColor('state-success-primary') + '}',
        '.dsh-rll-pick-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-rll-pick[aria-checked="true"] .dsh-rll-pick-label{font-weight:600}',
        '.dsh-rll-pick-meta{flex:0 0 auto;margin-left:8px;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
        '.dsh-rll-sep{height:1px;margin:3px 2px;background:var(--dsw-alias-border-l1)}',
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

      // 拉起态：电源图标（把进程起起来）；打开态：右栏面板图标（把页面开进内嵌浏览器）。
      // 两个状态形状不同，颜色也是低饱和的，扫一眼就能分开，不需要读文字。
      const PowerIcon = () => h('svg', {
        width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', { d: 'M8 2.2v5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M4.7 4.4a5 5 0 1 0 6.6 0', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));
      // 选中勾：菜单里的服务行是选择器，勾在左边固定槽位，文字不会左右跳
      const CheckIcon = () => h('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('path', {
          d: 'M3.2 8.4 6.3 11.5 12.8 4.6',
          stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
      const OpenIcon = () => h('svg', {
        width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        style: { flex: '0 0 auto' },
      },
        h('rect', { x: 2.2, y: 2.8, width: 11.6, height: 10.4, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M9.8 2.8v10.4', stroke: 'currentColor', strokeWidth: 1.4 }));

      const SERVICE_OK_MS = 2200;
      const SERVICE_ERR_MS = 6000;
      const SERVICE_MIN_SPIN_MS = 600;
      const OPEN_MIN_SPIN_MS = 350;
      const STATUS_POLL_MS = 5000;
      const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || ''));

      // 服务实况缓存：切会话时 composer cell 会重建，先把上一次的结果画出来（毫秒级），
      // 再后台复核；挂载期间每 5s 探一次，让下一次切会话的缓存尽量新鲜。
      // 键是卡片文件名，同一项目的所有会话共用。
      const statusCache = new Map();      // file → { rows, at }
      const statusInflight = new Map();   // file → Promise<rows>
      // 服务选中态：菜单是选择器，主按钮消费这个选择（每个项目各记一条，切会话不丢，刷新页面重置）
      const serviceSelection = new Map(); // file → serviceId
      const readServiceStatus = (file) => {
        if (!file) return Promise.resolve([]);
        const running = statusInflight.get(file);
        if (running) return running;
        const task = (async () => {
          try {
            const res = await rotationFetch('/services?file=' + encodeURIComponent(file));
            const body = await res.json().catch(() => null);
            const list = body && body.ok && Array.isArray(body.services) ? body.services : [];
            statusCache.set(file, { rows: list, at: Date.now() });
            return list;
          } catch (error) {
            const cached = statusCache.get(file);
            return cached ? cached.rows : [];
          } finally {
            statusInflight.delete(file);
          }
        })();
        statusInflight.set(file, task);
        return task;
      };
      const cachedStatusOf = (file) => {
        const hit = file ? statusCache.get(file) : null;
        return hit ? hit.rows : null;
      };
      /** 只比较影响渲染的字段，避免每 5s 轮询都触发一次无意义的重渲染 */
      const sameStatus = (left, right) => {
        if (left === right) return true;
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let i = 0; i < left.length; i += 1) {
          const a = left[i] || {};
          const b = right[i] || {};
          if (a.id !== b.id || a.name !== b.name || a.url !== b.url
            || a.status !== b.status || a.startCommand !== b.startCommand) return false;
        }
        return true;
      };

      function Launcher(props) {
        const sessionId = props && props.sessionId;
        // 标准 props 里有 usePanelInfo（选中主区面板）；mock / 老宿主里可能没有
        const usePanelInfo = (props && props.usePanelInfo) || (() => null);
        const activePanelId = usePanelInfo((info) => (info && info.activePanelId) || null);
        const [info, setInfo] = React.useState(null);      // { project, services, token, panelId }
        const [rows, setRows] = React.useState(null);      // GET /services?file 的结果；null = 还没查到
        const [phase, setPhase] = React.useState('idle');  // idle | checking | starting | opening | stopping | restarting | ok | error
        const [note, setNote] = React.useState('');
        const [refresh, setRefresh] = React.useState(0);
        // 主按钮右侧的小三角：服务级菜单（重启 / 按服务打开 / 全部关闭）
        const [menuOpen, setMenuOpen] = React.useState(false);
        const [menuPos, setMenuPos] = React.useState(null);       // { right, bottom }，视口坐标
        const [confirmStop, setConfirmStop] = React.useState(false); // 「关闭所有服务」的二次确认
        const [scopedOk, setScopedOk] = React.useState(scopedServicesCapable === true);
        const wrapRef = React.useRef(null);
        const menuRef = React.useRef(null);
        const timer = React.useRef(null);
        const mounted = React.useRef(true);
        React.useEffect(() => () => { mounted.current = false; }, []);

        // 旧宿主（没重启过）没有按项目收窄的 stop-all：探到就把项目级动作禁掉
        React.useEffect(() => {
          if (scopedServicesCapable !== null) return undefined;
          let alive = true;
          probeScopedServices()
            .then((ok) => { if (alive) setScopedOk(ok === true); })
            .catch(() => { if (alive) setScopedOk(false); });
          return () => { alive = false; };
        }, []);

        const projectFile = info && info.project ? String(info.project.file || '') : '';
        // 关键：缓存命中时首帧就用它，不等 /services 返回
        const shownRows = rows !== null ? rows : cachedStatusOf(projectFile);

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

        // 服务实况：首帧用缓存（切会话 0ms 出正确状态），后台复核 + 5s 轮询保鲜
        React.useEffect(() => {
          if (!projectFile) { setRows(null); return undefined; }
          let cancelled = false;
          const applyRows = (next) => {
            if (cancelled || !mounted.current) return;
            setRows((prev) => (sameStatus(prev, next) ? prev : next));
          };
          const cached = cachedStatusOf(projectFile);
          if (cached) applyRows(cached);
          readServiceStatus(projectFile).then(applyRows).catch(() => {});
          const poll = setInterval(() => {
            readServiceStatus(projectFile).then(applyRows).catch(() => {});
          }, STATUS_POLL_MS);
          return () => { cancelled = true; clearInterval(poll); };
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

        /**
         * 当前选中项：菜单是选择器，服务列表来自 GET /services。
         * 没选过、选中的服务被删掉、或者只配了一个——都落到第一条，保证主按钮永远有明确对象。
         */
        const pickSelectedRow = (list) => {
          const rows = Array.isArray(list) ? list : [];
          if (!rows.length) return null;
          const id = projectFile ? serviceSelection.get(projectFile) : '';
          return rows.find((row) => row && row.id === id) || rows[0];
        };

        const onServiceAction = async () => {
          if (!info || !info.project || phase === 'starting' || phase === 'opening' || phase === 'checking') return;
          closeMenu();
          setNote('');
          // 实况过期（>10s）或还没查过：点击时先补一次，避免拿旧状态做错事
          let current = shownRows;
          const cachedAt = (statusCache.get(projectFile) || {}).at || 0;
          if (current === null || Date.now() - cachedAt > 10000) {
            setPhase('checking');
            current = await readServiceStatus(projectFile);
            if (mounted.current) setRows((prev) => (sameStatus(prev, current) ? prev : current));
            if (!mounted.current) return;
          }
          // 菜单只负责「选哪个」，主按钮才执行：选中的能开就只开它
          const picked = pickSelectedRow(current);
          if (picked && picked.status === 'up' && isHttpUrl(picked.url)) {
            await openServiceRow(picked);
            return;
          }

          // 选中的没在线（或没有可选）：回落到「把本项目全部拉起」
          const startable = (info.services && info.services.startable) || 0;
          if (!startable || !info.token) return;
          await startAllServices();
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

        // ── 服务菜单 ──────────────────────────────────────────────
        // 主按钮 = 一键（全部打开 / 全部拉起）；小三角 = 按服务粒度操作。
        // 菜单是分裂按钮的右半，所以只有主按钮也用同一套 tone 与禁用口径。
        const busyNow = () => phase === 'starting' || phase === 'opening'
          || phase === 'checking' || phase === 'stopping' || phase === 'restarting';

        const closeMenu = () => { setMenuOpen(false); setConfirmStop(false); };

        const toggleMenu = () => {
          if (menuOpen) { closeMenu(); return; }
          let box = null;
          try {
            const el = wrapRef.current;
            box = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
          } catch { box = null; }
          const vw = (() => { try { return Number(window.innerWidth) || 0; } catch { return 0; } })();
          const vh = (() => { try { return Number(window.innerHeight) || 0; } catch { return 0; } })();
          setMenuPos({
            right: box && vw ? Math.max(8, Math.round(vw - box.right)) : 12,
            bottom: box && vh ? Math.max(8, Math.round(vh - box.top + 6)) : 56,
          });
          setConfirmStop(false);
          setMenuOpen(true);
        };

        // 点外面 / Esc / 窗口变化都收菜单：菜单挂在 top layer，宁可多关不可悬空
        React.useEffect(() => {
          if (!menuOpen) return undefined;
          const inside = (node, target) => {
            try { return !!(node && typeof node.contains === 'function' && target && node.contains(target)); } catch { return false; }
          };
          const onDown = (event) => {
            const target = event && event.target;
            if (inside(wrapRef.current, target) || inside(menuRef.current, target)) return;
            closeMenu();
          };
          const onKey = (event) => {
            const key = event && event.key;
            if (key === 'Escape' || key === 'Esc') closeMenu();
          };
          const onResize = () => closeMenu();
          try {
            document.addEventListener('mousedown', onDown, true);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', onResize);
          } catch { /* noop */ }
          return () => {
            try {
              document.removeEventListener('mousedown', onDown, true);
              document.removeEventListener('keydown', onKey, true);
              window.removeEventListener('resize', onResize);
            } catch { /* noop */ }
          };
        }, [menuOpen]);

        // 提升到 top layer：composer 任意祖先上的 overflow / transform 都不会裁掉菜单。
        // 浏览器没有 popover API 时保持普通 fixed 定位，位置一样只是少了层级保证。
        React.useEffect(() => {
          if (!menuOpen) return;
          const el = menuRef.current;
          if (!el || typeof el.setAttribute !== 'function') return;
          try {
            el.setAttribute('popover', 'manual');
            if (typeof el.showPopover === 'function') el.showPopover();
            else el.removeAttribute('popover');
          } catch {
            try { el.removeAttribute('popover'); } catch { /* noop */ }
          }
        }, [menuOpen]);

        const postJson = async (path, payload) => {
          const res = await rotationFetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {}),
          });
          const body = await res.json().catch(() => null);
          return { res, body };
        };
        /** 重新探一次并落状态；返回最新 rows */
        const probeNow = async () => {
          const fresh = await readServiceStatus(projectFile);
          if (mounted.current) setRows((prev) => (sameStatus(prev, fresh) ? prev : fresh));
          return fresh;
        };
        /** 等端口真的空出来：stop-all 杀进程后立刻 start-all 会把自己的端口算成冲突 */
        const waitAllDown = async (budgetMs) => {
          const deadline = Date.now() + budgetMs;
          for (;;) {
            const fresh = await probeNow();
            if (!openTargetsOf(fresh).length) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        };
        const startAllNow = async () => {
          const { res, body } = await postJson('/services/start-all', { file: info.project.file });
          return { res, body, started: (body && body.started) || [], failed: (body && body.failed) || [] };
        };

        /**
         * 拉起本项目全部「没在线」的服务（start-all 自己会跳过在线的那些）。
         * 两处共用：主按钮在选中项离线时的回落，以及菜单顶部的「拉起全部服务」。
         */
        const startAllServices = async () => {
          if (!info || !info.project || busyNow() || !info.token) return;
          closeMenu();
          setPhase('starting');
          const t0 = Date.now();
          try {
            const { res, body, started, failed } = await startAllNow();
            // 启动后再探一次：报「已在运行」但端口已经在听的，算在线，不显示失败
            const fresh = await probeNow();
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

        /** 主按钮执行的那一下：在右栏打开选中的那一个服务 */
        const openServiceRow = async (row) => {
          if (!row || busyNow()) return;
          setPhase('opening');
          const t0 = Date.now();
          const result = await openServiceUrl(row.url);
          const rest = OPEN_MIN_SPIN_MS - (Date.now() - t0);
          if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
          if (!mounted.current) return;
          if (result.ok) {
            setPhase('ok');
            setNote('已在右栏打开 ' + (row.name || row.id || '服务'));
            schedule(SERVICE_OK_MS);
          } else {
            setPhase('error');
            setNote(result.error || '打开服务失败');
            schedule(SERVICE_ERR_MS);
          }
        };

        /** 菜单里的服务行 = 选中（不执行动作）：只记下选中项并收菜单 */
        const pickService = (row) => {
          if (!row || !projectFile) return;
          serviceSelection.set(projectFile, row.id);
          closeMenu();
        };

        /** 菜单项：关闭本项目全部服务（二次确认：第一次只翻文案） */
        const stopAllServices = async () => {
          if (!info || !info.project || busyNow() || !scopedOk) return;
          if (!confirmStop) { setConfirmStop(true); return; }
          closeMenu();
          setPhase('stopping');
          setNote('正在关闭服务…');
          try {
            const { res, body } = await postJson('/services/stop-all', { file: info.project.file });
            const killed = (body && body.killed) || [];
            const failed = (body && body.failed) || [];
            const managed = (body && body.managedStopped) || [];
            await probeNow();
            if (!mounted.current) return;
            if (killed.length || managed.length) {
              setPhase('ok');
              setNote('已关闭 ' + Math.max(killed.length, managed.length) + ' 个服务');
              schedule(SERVICE_OK_MS);
            } else if (failed.length) {
              setPhase('error');
              setNote((failed[0] && failed[0].error) || '关闭失败');
              schedule(SERVICE_ERR_MS);
            } else if (!res.ok || !body || body.ok === false) {
              setPhase('error');
              setNote((body && body.error) || ('关闭失败（HTTP ' + res.status + '）'));
              schedule(SERVICE_ERR_MS);
            } else {
              setPhase('ok');
              setNote('没有需要关闭的服务');
              schedule(SERVICE_OK_MS);
            }
            setRefresh((n) => n + 1);
          } catch (error) {
            if (!mounted.current) return;
            setPhase('error');
            setNote('关闭请求失败：' + ((error && error.message) || String(error)));
            schedule(SERVICE_ERR_MS);
          }
        };

        /** 菜单项：关闭后重新拉起本项目的服务（= 重启） */
        const restartAllServices = async () => {
          if (!info || !info.project || busyNow() || !info.token || !scopedOk) return;
          closeMenu();
          setPhase('restarting');
          setNote('正在重启服务…');
          try {
            const stopped = await postJson('/services/stop-all', { file: info.project.file });
            if (!stopped.res.ok || (stopped.body && stopped.body.ok === false)) {
              if (!mounted.current) return;
              setPhase('error');
              setNote((stopped.body && stopped.body.error) || ('关闭失败（HTTP ' + stopped.res.status + '）'));
              schedule(SERVICE_ERR_MS);
              return;
            }
            // 端口释放要点时间，否则 start-all 会把自己的端口判成冲突（409 整批拒绝）
            const freed = await waitAllDown(5000);
            if (!mounted.current) return;
            if (!freed) {
              setPhase('error');
              setNote('关闭后端口仍被占用，重启已中止');
              schedule(SERVICE_ERR_MS);
              setRefresh((n) => n + 1);
              return;
            }
            let attempt = await startAllNow();
            // 409 = 端口冲突：等一拍再试一次，别让用户自己再点一遍
            if (attempt.res.status === 409) {
              await new Promise((resolve) => setTimeout(resolve, 900));
              attempt = await startAllNow();
            }
            const fresh = await probeNow();
            if (!mounted.current) return;
            const upAfter = openTargetsOf(fresh);
            if (upAfter.length) {
              setPhase('ok');
              setNote(attempt.started.length ? ('已重启 ' + attempt.started.length + ' 个服务') : '服务已在线');
              schedule(SERVICE_OK_MS);
            } else if (attempt.failed.length || attempt.body?.conflicts) {
              setPhase('error');
              setNote((attempt.failed[0] && attempt.failed[0].error)
                || (attempt.body && attempt.body.error) || '重启失败');
              schedule(SERVICE_ERR_MS);
            } else {
              setPhase('ok');
              setNote('已提交重启');
              schedule(SERVICE_OK_MS);
            }
            setRefresh((n) => n + 1);
          } catch (error) {
            if (!mounted.current) return;
            setPhase('error');
            setNote('重启请求失败：' + ((error && error.message) || String(error)));
            schedule(SERVICE_ERR_MS);
          }
        };

        if (!info || !info.project) return null;
        const services = info.services || {};
        const known = shownRows !== null;
        const openTargets = openTargetsOf(shownRows);
        const pendingStart = pendingOf(shownRows);
        // 项目没有任何服务配置时只留「闭环」，不给一个永远禁用的按钮
        const hasServices = (services.total > 0) || (known && shownRows.length > 0);
        // 主按钮的对象 = 菜单里选中的那个服务（没选过 / 服务没了就落到第一条）
        const selectedRow = pickSelectedRow(shownRows);
        const selectedOpenable = !!(selectedRow && selectedRow.status === 'up' && isHttpUrl(selectedRow.url));
        const mode = selectedOpenable ? 'open' : 'start';
        const busy = phase === 'starting' || phase === 'opening'
          || phase === 'checking' || phase === 'stopping' || phase === 'restarting';
        const canStart = !!info.token && ((services.startable > 0) || pendingStart.length > 0);
        const disabled = busy || (mode === 'start' && !canStart);

        const serviceLabel = phase === 'starting' ? '拉起中'
          : phase === 'opening' ? '打开中'
            : phase === 'checking' ? '检查中'
              : phase === 'stopping' ? '关闭中'
                : phase === 'restarting' ? '重启中'
                  : phase === 'error' ? '失败'
                    : phase === 'ok' && mode === 'start' ? '已在线'
                      : mode === 'open' ? '打开服务'
                        : '服务';
        const selectedName = selectedRow ? (selectedRow.name || selectedRow.id) : '';
        const serviceTitle = phase === 'starting' ? '正在拉起服务…'
          : phase === 'opening' ? ('正在右栏打开：' + selectedName)
            : phase === 'checking' ? '正在检查服务是否在线…'
              : phase === 'stopping' ? '正在关闭本项目的服务…'
                : phase === 'restarting' ? '正在关闭并重新拉起本项目的服务…'
                  : phase === 'ok' ? note
                    : phase === 'error' ? note
                      : mode === 'open'
                        ? ('在右栏打开：' + selectedName
                          + (pendingStart.length ? ('；另有 ' + pendingStart.length + ' 个服务未在线') : ''))
                        : !(services.total > 0) ? '该项目还没有登记服务（先在面板里收集一次）'
                          : !info.token ? '宿主要先注入写令牌才能拉起服务（DSH 版本较旧）'
                            : !(services.startable > 0) ? '当前平台没有可用的启动命令'
                              : ('一键拉起当前项目的 ' + services.startable + ' 个服务');
        const tone = busy ? 'busy'
          : phase === 'ok' ? 'ok'
            : phase === 'error' ? 'error'
              : mode === 'open' ? 'open' : '';
        const loopTitle = '展开「' + info.project.name + '」的闭环视图';
        const caretTitle = menuOpen ? '收起服务菜单' : '选择要打开的服务 / 重启 / 全部关闭';

        // 菜单内容：重启 → 每个服务一条打开 → 全部关闭。顺序与用户给的清单一致。
        const canRestart = !!info.token && scopedOk && (openTargets.length > 0 || pendingStart.length > 0);
        const scopedHint = !scopedOk ? '宿主要先重启才能按项目重启 / 关闭（当前宿主不支持按项目收窄）' : '';
        // 顶部动作：一键拉起本项目全部没在线的服务（start-all 自己跳过在线的那些）
        const canStartAll = !!info.token && pendingStart.length > 0;
        const startAllHint = !info.token ? '宿主要先注入写令牌才能拉起服务（DSH 版本较旧）'
          : !known ? '正在读取服务状态…'
            : pendingStart.length ? ('拉起本项目没在线的 ' + pendingStart.length + ' 个服务')
              : '所有服务都在线，没有要拉起的';
        const menuItems = [
          h('button', {
            key: 'start-all',
            type: 'button',
            role: 'menuitem',
            className: 'dsh-rll-mi',
            disabled: busy || !canStartAll,
            title: startAllHint,
            onClick: startAllServices,
          }, '拉起全部服务'),
          h('button', {
            key: 'restart',
            type: 'button',
            role: 'menuitem',
            className: 'dsh-rll-mi',
            disabled: busy || !canRestart,
            title: scopedHint || (!info.token ? '宿主要先注入写令牌才能重启服务（DSH 版本较旧）'
              : (openTargets.length || pendingStart.length) ? '关闭本项目的服务后重新拉起'
                : '本项目当前没有可重启的服务'),
            onClick: restartAllServices,
          }, '关闭并重新打开服务'),
          h('div', { key: 'sep-1', className: 'dsh-rll-sep', role: 'separator' }),
          ...(shownRows === null
            ? [h('div', { key: 'pending', className: 'dsh-rll-mi is-muted', role: 'menuitem', 'aria-disabled': 'true' }, '正在读取服务…')]
            : shownRows.length === 0
              ? [h('div', { key: 'empty', className: 'dsh-rll-mi is-muted', role: 'menuitem', 'aria-disabled': 'true' }, '本项目还没有登记服务')]
              : shownRows.map((row) => {
                const name = (row && (row.name || row.id)) || '服务';
                const active = !!selectedRow && !!row && row.id === selectedRow.id;
                const offline = !(row && row.status === 'up' && isHttpUrl(row.url));
                return h('button', {
                  key: 'pick:' + (row.id || name),
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': active ? 'true' : 'false',
                  className: 'dsh-rll-mi dsh-rll-pick',
                  title: active ? ('当前选中：' + name + '（主按钮只打开它）')
                    : ('选中 ' + name + '，再用左侧主按钮打开'),
                  onClick: () => pickService(row),
                },
                h('span', { className: 'dsh-rll-tick', 'aria-hidden': 'true' }, active ? h(CheckIcon, null) : null),
                h('span', { className: 'dsh-rll-pick-label' }, name),
                offline ? h('span', { className: 'dsh-rll-pick-meta' }, '未在线') : null);
              })),
          h('div', { key: 'sep-2', className: 'dsh-rll-sep', role: 'separator' }),
          h('button', {
            key: 'stop-all',
            type: 'button',
            role: 'menuitem',
            className: 'dsh-rll-mi',
            'data-danger': confirmStop ? '1' : undefined,
            disabled: busy || !info.token || !scopedOk,
            title: scopedHint || (!info.token ? '宿主要先注入写令牌才能关闭服务（DSH 版本较旧）'
              : confirmStop ? '再点一次确认关闭本项目的全部服务'
                : '关闭本项目的全部服务（可在重启里拉回来）'),
            onClick: stopAllServices,
          }, confirmStop ? '再点一次确认关闭' : '关闭所有服务'),
        ];

        return h('div', { className: 'dsh-rll', ref: wrapRef },
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
              : h(mode === 'open' ? OpenIcon : PowerIcon, null),
            h('span', null, serviceLabel),
            note ? h('span', { className: 'dsh-rll-sr', role: 'status' }, note) : null)
            : null,
          // 分裂按钮的菜单半：主操作在左，菜单在右
          hasServices
            ? h('button', {
              type: 'button',
              className: 'dsh-rll-caret',
              title: caretTitle,
              'aria-label': caretTitle,
              'aria-haspopup': 'menu',
              'aria-expanded': menuOpen ? 'true' : 'false',
              'data-tone': tone || undefined,
              onClick: toggleMenu,
            },
            h('svg', {
              width: 10, height: 10, viewBox: '0 0 16 16', 'aria-hidden': 'true',
              style: { flex: '0 0 auto' },
            }, h('path', { d: 'M3.8 6.4h8.4L8 10.9z', fill: 'currentColor' })))
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
          h('span', null, '闭环')),
          menuOpen
            ? h('div', {
              ref: menuRef,
              className: 'dsh-rll-menu',
              role: 'menu',
              'aria-label': '选择服务与操作',
              style: {
                position: 'fixed',
                top: 'auto',
                left: 'auto',
                right: (menuPos && menuPos.right) || 12,
                bottom: (menuPos && menuPos.bottom) || 56,
                margin: 0,
                zIndex: 2147483000,
              },
            }, menuItems)
            : null);
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
