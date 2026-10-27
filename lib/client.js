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

    function openPanel() {
      window.open(BASE + '/app/', '_blank', 'noopener');
    }

    /** 固定在右下角的入口按钮：DSH 右栏标签条只列运行时 pane，插件静态 tab 不显示，
     *  所以这里给一个与框架无关的常驻入口（点开新标签打开面板）。 */
    function mountLauncher() {
      if (document.getElementById('dsh-rotation-launcher')) return () => {};
      const btn = document.createElement('button');
      btn.id = 'dsh-rotation-launcher';
      btn.type = 'button';
      btn.title = '闭环轮转面板';
      btn.textContent = '轮转';
      Object.assign(btn.style, {
        position: 'fixed', right: '18px', bottom: '74px', zIndex: '2147483000',
        height: '28px', padding: '0 12px', borderRadius: '8px',
        border: '1px solid #ffffff29', background: '#232324', color: '#f9fafb',
        font: '12px/1 -apple-system,system-ui,sans-serif', cursor: 'pointer',
        boxShadow: '0 2px 10px #00000059',
      });
      btn.addEventListener('click', () => window.open('/rotation/app/', '_blank', 'noopener'));
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
    exports.inject = ['slots'];   // 右栏入口要用到的客户端服务
    exports.apply = apply;
    exports.openPanel = openPanel;
    return module.exports;
  },
});
