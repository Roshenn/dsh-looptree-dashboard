#!/usr/bin/env node
/**
 * scripts/gc-assets.mjs — 清理没人引用的附件文件（默认 dry-run）。
 *
 *   node scripts/gc-assets.mjs                 # 只打印会删什么
 *   node scripts/gc-assets.mjs --write         # 真删
 *   node scripts/gc-assets.mjs --write --file proj.rotation.json
 *
 * 口径：
 *   · 保留集 = 每张注册卡片（含 closed_milestones 快照）里所有合法 sha；
 *   · 只删 <workspace>/.dsh/rotation-assets/ 下、文件名是 <64 hex>.<png|jpg|webp>、
 *     且 mtime 超过 24h 的文件；
 *   · 任何一张卡读不出来就整体退出、不删——避免把暂时读不到的卡片的图删光。
 *
 * 为什么要它：附件存项目里、随 git 走；删节点 / 换图只删卡片引用，文件会留下来。
 */
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { listProjects, readCard, REGISTRY_PATH } from '../lib/store.mjs';
import { collectAttachmentShas, listAssetFiles, ASSET_REL_DIR } from '../lib/assets.mjs';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const fileIdx = argv.indexOf('--file');
const only = fileIdx >= 0 ? String(argv[fileIdx + 1] || '') : '';
const AGE_MS = 24 * 60 * 60 * 1000;

const projects = await listProjects();
const scoped = only
  ? projects.filter((p) => p.file === only || p.id === only)
  : projects;

if (!scoped.length) {
  console.log(`没有可清理的项目（注册表：${REGISTRY_PATH}${only ? `，过滤：${only}` : ''}）`);
  process.exit(0);
}

const rows = [];
let aborted = false;
for (const p of scoped) {
  let card;
  try {
    card = await readCard(p);
  } catch (error) {
    console.error(`读不到卡片 ${p.file}：${error.message}`);
    console.error('为安全起见，这次不删任何文件。修好卡片后重跑。');
    aborted = true;
    break;
  }
  const refs = collectAttachmentShas(card);
  const files = await listAssetFiles(p.workspace);
  const now = Date.now();
  const stale = files.filter((f) => !refs.has(f.sha) && now - f.mtimeMs > AGE_MS);
  rows.push({ p, refs, files, stale });
}

if (aborted) process.exit(1);

let totalStale = 0;
let totalFiles = 0;
for (const { p, refs, files, stale } of rows) {
  totalStale += stale.length;
  totalFiles += files.length;
  console.log(`\n${p.name || p.id}（${p.file}）`);
  console.log(`  附件目录：${join(p.workspace, ASSET_REL_DIR)}`);
  console.log(`  文件 ${files.length} 个 · 卡片引用 ${refs.size} 个 · 可清理 ${stale.length} 个${write ? '' : '（dry-run）'}`);
  if (stale.length) {
    for (const f of stale.slice(0, 5)) console.log(`    - ${f.name}`);
    if (stale.length > 5) console.log(`    … 另外 ${stale.length - 5} 个`);
  }
  if (!write) continue;
  for (const f of stale) {
    try {
      await unlink(f.abs);
      console.log(`    已删除 ${f.name}`);
    } catch (error) {
      console.error(`    删除失败 ${f.name}：${error.message}`);
    }
  }
}

console.log(`\n${write ? '完成' : 'dry-run 完成'}：文件 ${totalFiles} 个，可清理 ${totalStale} 个。`);
if (!write && totalStale) console.log('确认无误后加 --write 真删（不会碰仍被卡片引用的文件）。');
