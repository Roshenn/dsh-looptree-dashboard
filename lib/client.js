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
  id: 'dsh-rotation-dashboard',
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

    /** 固定在右下角的入口按钮：DSH 右栏标签条只列运行时 pane，插件静态 tab 不显示，
     *  所以这里给一个与框架无关的常驻入口（点开新标签打开面板）。 */
    function mountLauncher() {
      if (document.getElementById('dsh-rotation-launcher')) return () => {};
      // 用 <a> 而不是 <button>：即使 JS 被外壳拦，a 的原生导航也能兜底
      function showHint(url) {
        document.getElementById('dsh-rotation-hint')?.remove();
        const box = document.createElement('div');
        box.id = 'dsh-rotation-hint';
        Object.assign(box.style, {
          position: 'fixed', right: '18px', bottom: '112px', zIndex: '2147483001',
          padding: '8px 10px', borderRadius: '8px', border: '1px solid #ffffff29',
          background: '#232324', color: '#cfd3d6', font: '12px/1.5 -apple-system,system-ui,sans-serif',
          boxShadow: '0 4px 16px #00000066', maxWidth: '240px',
        });
        box.innerHTML = '已尝试在新标签打开面板。<br>没看到？<a href="' + url + '" style="color:#93c5fd;text-decoration:underline">点这里</a>（当前标签打开）';
        document.body.appendChild(box);
        setTimeout(() => box.remove(), 8000);
      }

      const btn = document.createElement('a');
      btn.id = 'dsh-rotation-launcher';
      btn.href = '/rotation/app/';
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.title = '闭环轮转面板（新标签打开；被拦时同标签打开）';
      btn.textContent = '轮转';
      Object.assign(btn.style, {
        position: 'fixed', right: '18px', bottom: '74px', zIndex: '2147483000',
        height: '28px', padding: '0 12px', borderRadius: '8px',
        border: '1px solid #ffffff29', background: '#232324', color: '#f9fafb',
        font: '12px/1 -apple-system,system-ui,sans-serif', cursor: 'pointer',
        boxShadow: '0 2px 10px #00000059',
      });
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
            ctx.layout.selectPanel(PANEL_ID);
            return;
          }
        } catch { /* fall through */ }
        const url = '/rotation/app/';
        let win = null;
        try { win = window.open(url, '_blank', 'noopener'); } catch { win = null; }
        if (!win) { window.location.assign(url); return; }
        showHint(url);
      });
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#ffffff52'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#ffffff29'; });
      document.body.appendChild(btn);
      return () => btn.remove();
    }

    function apply(ctx) {
      const logger = ctx.logger;
      const slots = ctx.slots;
      try {
        if (typeof ctx.effect === 'function') ctx.effect(() => mountLauncher(), 'dsh-rotation-dashboard: launcher');
        else { mountLauncher(); }
      } catch { try { mountLauncher(); } catch { /* noop */ } }
      if (!slots || typeof slots.register !== 'function') {
        logger?.info?.('[rotation] slots unavailable, panel reachable at ' + BASE + '/app/');
        return;
      }

      const React = require('react');
      const h = React.createElement;

      // ── 侧边栏条目 + 主区页面（iframe 承载现有面板）──
      const PANEL_ID = 'rotation';
      const PANEL_LABEL = '闭环轮转';
      const Page = () => h('div', { style: { position: 'relative', height: '100%', minHeight: 0, flex: 1 } },
        h('iframe', {
          src: BASE + '/app/',
          title: PANEL_LABEL,
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#151517' },
        }));
      const Icon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.46-3.54', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M13 2.5V5h-2.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }));

      // 面板处于激活状态时把右下角浮标藏起来，避免和侧边栏入口重复
      try {
        if (ctx.layout && ctx.layout.panelInfo && typeof ctx.layout.panelInfo.subscribe === 'function') {
          const sync = () => {
            const el = document.getElementById('dsh-rotation-launcher');
            if (!el) return;
            const active = ctx.layout.panelInfo.getSnapshot && ctx.layout.panelInfo.getSnapshot().activePanelId;
            el.style.display = active === PANEL_ID ? 'none' : '';
          };
          const dispose = ctx.layout.panelInfo.subscribe(sync);
          if (typeof dispose === 'function') ctx.effect?.(() => dispose, 'dsh-rotation: launcher sync');
        }
      } catch { /* noop */ }

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
        h('div', { style: { fontSize: '13px', fontWeight: 600, color: '#f9fafb', marginBottom: '4px' } }, '闭环轮转'),
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

    exports.name = 'dsh-rotation-dashboard-client';
    exports.inject = ['slots', 'layout'];
    exports.apply = apply;
    exports.openPanel = openPanel;
    return module.exports;
  },
});
