#!/usr/bin/env node
/**
 * scripts/migrate-samples.mjs — 把 samples/*.rotation.json 迁到各自的 workspace。
 *
 *   node scripts/migrate-samples.mjs            # 只打印计划（dry-run）
 *   node scripts/migrate-samples.mjs --write    # 真的写：workspace/.dsh/rotation.json + 注册表
 *   node scripts/migrate-samples.mjs --write --create   # workspace 不存在时创建目录
 *   ROTATION_HOME=/tmp/rot-home node scripts/migrate-samples.mjs --write
 *   node scripts/migrate-samples.mjs --samples /tmp/my-cards --write
 *
 * 幂等：目标卡片已存在则跳过（不覆盖你的真实数据）。
 */
import { readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { readRegistry, writeRegistry, cardPathOf } from '../lib/store.mjs';

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const CREATE = args.has('--create');
const SAMPLES = (() => {
  const i = process.argv.indexOf('--samples');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : new URL('../samples/', import.meta.url).pathname;
})();

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const files = (await readdir(SAMPLES)).filter((f) => f.endsWith('.rotation.json')).sort();
const registry = await readRegistry();
const plan = [];

for (const file of files) {
  const card = JSON.parse(await readFile(join(SAMPLES, file), 'utf8'));
  const workspace = card?.project?.workspace;
  const name = card?.project?.name || basename(file, '.rotation.json');
  const id = basename(file, '.rotation.json');
  if (!workspace) { plan.push({ file, id, name, action: 'skip: 卡片没有 project.workspace' }); continue; }
  if (registry.some((p) => p.id === id)) { plan.push({ file, id, name, action: 'skip: 注册表已有同 id' }); continue; }
  const target = join(workspace, '.dsh', 'rotation.json');
  if (await exists(target)) { plan.push({ file, id, name, action: `skip: 目标已存在 ${target}` }); continue; }
  if (!(await exists(workspace)) && !CREATE) { plan.push({ file, id, name, action: `skip: 目录不存在 ${workspace}（加 --create 可创建）` }); continue; }
  plan.push({ file, id, name, workspace, target, card, action: 'migrate' });
}

for (const item of plan) console.log(`${item.action.padEnd(46)} ${item.file}`);

if (!WRITE) {
  console.log(`\n干跑：${plan.filter((p) => p.action === 'migrate').length} 张可迁移。加 --write 执行。`);
  process.exit(0);
}

const next = [...registry];
for (const item of plan) {
  if (item.action !== 'migrate') continue;
  await mkdir(join(item.workspace, '.dsh'), { recursive: true });
  await writeFile(item.target, JSON.stringify(item.card, null, 1) + '\n', 'utf8');
  next.push({ id: item.id, name: item.name, workspace: item.workspace, file: `${item.id}.rotation.json` });
  console.log(`written ${item.target}`);
}
await writeRegistry(next);
console.log(`\nregistry 已更新：${next.length} 个项目 → ${process.env.ROTATION_HOME || '~/.dsh/rotation'}/registry.json`);
console.log('提示：cardPathOf 以 registry 为准，卡片真身仍在各项目 .dsh/rotation.json');
