#!/usr/bin/env node
/**
 * scripts/check-install.mjs — 装完插件后一条命令自检。
 *
 *   node scripts/check-install.mjs                       # 默认 http://127.0.0.1:64517
 *   DSH_URL=http://127.0.0.1:64517 node scripts/check-install.mjs
 *   ROTATION_TOKEN=… node scripts/check-install.mjs      # 宿主启动时固定过令牌就必须带上
 *
 * 检查：health 路由、面板静态资源、注册表是否可读。任一项失败退出码 1。
 *
 * 接口现在过宿主的 connection 栅栏（Host/Origin + 浏览器会话 cookie），命令行没有那份
 * cookie，被拦下来时是 401 —— 带上 `x-rotation-token` 即等同第一方调用者。
 */
const BASE = (process.env.DSH_URL || 'http://127.0.0.1:64517').replace(/\/$/, '');
const TOKEN = String(process.env.ROTATION_TOKEN || '');
const headers = TOKEN ? { 'x-rotation-token': TOKEN } : {};
const checks = [
  ['health', `${BASE}/rotation/api/health`, (body) => body && body.ok === true],
  ['panel', `${BASE}/rotation/app/`, () => true],
  ['registry', `${BASE}/rotation/api/projects`, (body) => body && Array.isArray(body.projects)],
];

let failed = 0;
for (const [name, url, validate] of checks) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html */ }
    const ok = res.ok && validate(body);
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(9)} ${res.status} ${url}`);
    if (!ok) {
      failed++;
      if (res.status === 401) {
        console.log('   401 = 宿主要求 DSH 应用里的浏览器会话；命令行自检请用 ROTATION_TOKEN 固定令牌后重试。');
      }
    }
  } catch (error) {
    console.log(`✗ ${name.padEnd(9)} 请求失败 ${url} — ${error.message}`);
    failed++;
  }
}

if (failed) {
  console.log(`\n${failed} 项失败：见 INSTALL.md 的「故障排查」。`);
  process.exit(1);
}
console.log('\n全部通过：插件已挂载，面板可访问。');
