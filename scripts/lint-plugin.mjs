#!/usr/bin/env node
/**
 * scripts/lint-plugin.mjs — 打包前自检：把「装不上」的常见原因在本地拦掉。
 *
 *   node scripts/lint-plugin.mjs
 *   npm run lint:plugin
 *
 * 检查项：
 *   1) package.json 必备字段（name/version/type/main/exports/files/dsh）
 *   2) dsh.bundle.patch 指向的文件存在且能被 YAML 解析、insert 行 name 与包名一致
 *   3) dsh.client.inject 是数组且平台是 web
 *   4) files 里列出的每个路径存在
 *   5) lib/index.js 导出 apply / name / inject（host 半的契约）
 *   6) lib/client.js 内含 __ModuleLoader__.load 与 exports.apply（client 半的契约）
 *   7) web/index.html 存在（面板本体）
 */
import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

for (const field of ['name', 'version', 'type', 'main', 'exports', 'files', 'dsh']) {
  check(`package.json 有 ${field}`, pkg[field] !== undefined);
}

// ── dsh.bundle.patch ──
const patchRel = pkg.dsh?.bundle?.patch;
check('dsh.bundle.patch 已声明', typeof patchRel === 'string', patchRel || '');
if (patchRel) {
  const patchPath = join(ROOT, patchRel);
  const hasPatch = await exists(patchPath);
  check('patch 文件存在', hasPatch, patchRel);
  if (hasPatch) {
    const text = await readFile(patchPath, 'utf8');
    // 不引入 yaml 依赖：只做结构性检查
    check('patch 含 insert 行', /^\s*-\s*insert:/m.test(text));
    check('patch 里写了包名', text.includes(pkg.name), pkg.name);
  }
}

// ── dsh.client ──
check('dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));
check('dsh.client.inject 是数组', Array.isArray(pkg.dsh?.client?.inject), JSON.stringify(pkg.dsh?.client?.inject || null));

// ── files ──
if (Array.isArray(pkg.files)) {
  for (const entry of pkg.files) {
    check(`files 里的 ${entry} 存在`, await exists(join(ROOT, entry)));
  }
}

// ── host 半导出 ──
const host = await readFile(join(ROOT, pkg.main || 'lib/index.js'), 'utf8');
check('host 导出 apply', /export\s+(async\s+)?function\s+apply|export\s*\{[^}]*\bapply\b/.test(host));
check('host 导出 name', /export\s+const\s+name\s*=/.test(host));
check('host 声明 inject（webServer）', /export\s+const\s+inject\s*=/.test(host) && host.includes('webServer'));
check('host 用 ctx.webServer.register', host.includes('ctx.webServer.register'));
check('host 用 ctx.effect 托管路由', host.includes('ctx.effect'));

// ── client 半 ──
const client = await readFile(join(ROOT, 'lib/client.js'), 'utf8');
check('client 用 __ModuleLoader__.load', client.includes('__ModuleLoader__.load'));
check('client 有 factory(require)', /factory\s*:\s*\(?\s*require/.test(client));
check('client 导出 apply', /exports\.apply\s*=/.test(client));
check('client 注册右栏插槽', client.includes('sidebar.right.pane.tab'));

// ── 面板本体 ──
check('web/index.html 存在', await exists(join(ROOT, 'web/index.html')));

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n打包自检全部通过');
process.exit(failed.length ? 1 : 0);
