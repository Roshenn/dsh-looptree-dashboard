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

      if (!slots || typeof slots.register !== 'function') {
        logger?.info?.('[rotation] slots unavailable, panel reachable at ' + BASE + '/app/');
        return;
      }

      const React = require('react');
      const h = React.createElement;

      // ── 侧边栏条目 + 主区页面（iframe 承载现有面板）──
      const PANEL_ID = 'rotation';
      const PANEL_LABEL = '闭环树';

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
      const Icon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4.2 8h3.2M7.4 4.2v7.6M7.4 4.2h3.4M7.4 11.8h3.4',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        h('circle', { cx: 3, cy: 8, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 4.2, r: 1.4, fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 11.8, r: 1.4, fill: 'currentColor' }));

      try {
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID, locale: undefined }, Page));
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => PANEL_LABEL,
        }, Icon));
        logger?.info?.('[rotation] sidebar entry + main page registered');
      } catch (error) {
        logger?.warn?.('[rotation] panel registration failed: ' + (error && error.message));
      }

      const body = () => h(
        'div',
        { style: { padding: '14px 12px', font: '12px/1.6 -apple-system,system-ui,sans-serif', color: '#cfd3d6' } },
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: '#f9fafb', marginBottom: '4px' } }, '闭环树'),
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

      const title = () => h('span', null, '轮转');

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
