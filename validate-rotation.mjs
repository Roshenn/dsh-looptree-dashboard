#!/usr/bin/env node
/**
 * validate-rotation.mjs — rotation/v1 命令行校验（零依赖）
 * 用法：node validate-rotation.mjs <file.json> [--quiet]
 * 退出码：0 通过 / 1 有错误 / 2 读不出来
 */
import { readFileSync } from 'node:fs';
import { validateCard, treeLines } from './rotation-core.mjs';

const file = process.argv[2];
const quiet = process.argv.includes('--quiet');
if (!file) { console.error('用法: node validate-rotation.mjs <file.json>'); process.exit(2); }

let doc;
try { doc = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`无法读取 ${file}: ${e.message}`); process.exit(2); }

const { errors, warnings, stats } = validateCard(doc);

if (!quiet) {
  if (doc.loop) console.log(treeLines(doc.loop).join('\n'));
  console.log('');
  console.log(`节点 ${stats.nodes} · 最大深度 ${stats.maxDepth} · 叶子 ${stats.leaves} · 已关闭 ${stats.closedLeaves}/${stats.leaves}`);
  console.log(`阻塞 ${stats.blocked} · 可关闭 ${stats.closable}`);
}
if (warnings.length) {
  console.log(`\n⚠ 警告 ${warnings.length}`);
  warnings.slice(0, 10).forEach((w) => console.log('  - ' + w));
  if (warnings.length > 10) console.log(`  …还有 ${warnings.length - 10} 条`);
}
if (errors.length) {
  console.log(`\n✗ 错误 ${errors.length}`);
  errors.forEach((e) => console.log('  - ' + e));
  process.exit(1);
}
console.log('\n✓ 通过 rotation/v1 校验');
process.exit(0);
