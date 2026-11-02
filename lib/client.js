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
        if (!data || data.type !== 'rotation-open-session' || !data.sessionId) return;
        // 只认同源消息：面板由本服务同源提供，跨源页面无权切会话
        try { if (event.origin !== window.location.origin) return; } catch { return; }
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

      const onPanelOpenUrl = (event) => {
        const data = event && event.data;
        if (!data || data.type !== 'rotation-open-url' || !data.url) return;
        try { if (event.origin !== window.location.origin) return; } catch { return; }
        const reply = (ok, error, mode) => {
          try {
            (event.source || window).postMessage(
              { type: 'rotation-open-url-result', reqId: data.reqId, ok, error, mode }, '*');
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
              reply(true, '', 'panel');
              return;
            }
          } catch (inner) {
            logger?.warn?.('[rotation] main-area open failed: ' + ((inner && inner.message) || inner));
          }
          reply(false, error);
        };

        // 先把右栏拉起来（非全屏），页面才会和对话并排，而不是全屏盖住会话
        ensureRail(target);
        try {
          openInSidebar();
          logger?.info?.('[rotation] opened in sidebar browser: ' + target);
          reply(true, '', 'sidebar');
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
              reply(true, '', 'sidebar');
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
        React.useEffect(() => {
          const push = () => {
            const f = frameRef.current;
            if (!f || !f.contentWindow) return;
            try { f.contentWindow.postMessage({ type: 'rotation-theme', theme: hostTheme() }, '*'); } catch { /* noop */ }
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
        }, []);
        return h('div', { style: { position: 'relative', height: '100%', minHeight: 0, flex: 1 } },
          h('iframe', {
            ref: frameRef,
            src: BASE + '/app/?theme=' + hostTheme(),
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

      try {
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: undefined }, Page));
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => PANEL_LABEL,
        }, Icon));
        logger?.info?.('[rotation] sidebar entry + main page registered');
      } catch (error) {
        logger?.warn?.('[rotation] panel registration failed: ' + (error && error.message));
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
