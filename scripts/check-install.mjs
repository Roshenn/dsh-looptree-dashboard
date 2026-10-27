#!/usr/bin/env node
/**
 * scripts/check-install.mjs — 装完插件后一条命令自检。
 *
 *   node scripts/check-install.mjs                       # 默认 http://127.0.0.1:64517
 *   DSH_URL=http://127.0.0.1:64517 node scripts/check-install.mjs
 *
 * 检查：health 路由、面板静态资源、注册表是否可读。任一项失败退出码 1。
 */
const BASE = (process.env.DSH_URL || 'http://127.0.0.1:64517').replace(/\/$/, '');
const checks = [
  ['health', `${BASE}/rotation/api/health`, (body) => body && body.ok === true],
  ['panel', `${BASE}/rotation/app/`, () => true],
  ['registry', `${BASE}/rotation/api/projects`, (body) => body && Array.isArray(body.projects)],
];

let failed = 0;
for (const [name, url, validate] of checks) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html */ }
    const ok = res.ok && validate(body);
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(9)} ${res.status} ${url}`);
    if (!ok) failed++;
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
