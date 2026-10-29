#!/usr/bin/env node
/**
 * scripts/migrate-single-idea.mjs — 把「一个目标下多个构思」的旧卡收敛成只留第一条构思。
 *
 *   node scripts/migrate-single-idea.mjs                  # 干跑：只打印每个目标会怎么改
 *   node scripts/migrate-single-idea.mjs --write          # 真正写盘（原子替换，回滚用 git）
 *   node scripts/migrate-single-idea.mjs --file <card>    # 只处理一张卡
 *   node scripts/migrate-single-idea.mjs --samples        # 处理仓库里的 samples/*.rotation.json
 *
 * 规则：每个 goal 只保留 children 里的第一条 idea（连同它的子树），其余整体移出、
 * 追加进 `<卡片>.single-idea-backup.json`，不删数据。迁移前先干跑看一眼。
 */
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCard } from '../lib/core.mjs';
import { listProjects, readCard, writeCard } from '../lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const WRITE = has('--write');

/** 每个目标只留第一条构思；返回被移出的条目（不修改入参之外的东西） */
function planCard(card) {
  const moved = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'goal' && Array.isArray(n.children)) {
      const ideas = n.children.filter((k) => k && k.kind === 'idea');
      if (ideas.length > 1) {
        const drop = ideas.slice(1);
        n.children = n.children.filter((k) => !drop.includes(k));
        moved.push(...drop.map((idea) => ({ goalId: n.id, goalTitle: n.title || '', idea })));
      }
    }
    (Array.isArray(n.children) ? n.children : []).forEach(walk);
  };
  walk(card.loop);
  return moved;
}

/** 移出的构思追加到卡片旁边的备份文件里（可重复跑，不会覆盖历史） */
async function appendBackup(cardPath, moved) {
  const backupPath = cardPath + '.single-idea-backup.json';
  let prev = [];
  try {
    const parsed = JSON.parse(await readFile(backupPath, 'utf8'));
    if (Array.isArray(parsed)) prev = parsed;
  } catch { /* 没有备份文件就从空开始 */ }
  prev.push({ at: new Date().toISOString(), card: basename(cardPath), moved });
  await writeFile(backupPath, JSON.stringify(prev, null, 1) + '\n', 'utf8');
  return backupPath;
}

/** 不走注册表的卡片（--file / --samples）：校验 → 原子写（不留 .bak，历史交给 git） */
async function writeCardAtPath(cardPath, card) {
  const { errors } = validateCard(card);
  if (errors.length) throw new Error(`校验未通过：${errors[0]}${errors.length > 1 ? `（共 ${errors.length} 条）` : ''}`);
  card.updated = new Date().toISOString();
  const tmp = join(dirname(cardPath), `.rotation.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
  await rename(tmp, cardPath);
}

function report(label, moved) {
  const byGoal = new Map();
  for (const m of moved) {
    if (!byGoal.has(m.goalId)) byGoal.set(m.goalId, { title: m.goalTitle, ideas: [] });
    byGoal.get(m.goalId).ideas.push(m.idea.title || m.idea.id || '（未命名）');
  }
  const parts = [...byGoal.entries()].map(([gid, g]) =>
    `  · 目标「${g.title || gid}」：移出 ${g.ideas.length} 条（${g.ideas.join('、')}），保留第一条`);
  console.log(`✓ ${label}\n${parts.join('\n')}`);
}

const targets = [];
const onlyFile = valueOf('--file');
if (onlyFile) {
  targets.push({ label: onlyFile, cardPath: onlyFile, read: async () => JSON.parse(await readFile(onlyFile, 'utf8')) });
} else if (has('--samples')) {
  const dir = join(ROOT, 'samples');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.rotation.json')).sort();
  for (const name of files) {
    const cardPath = join(dir, name);
    targets.push({ label: name, cardPath, read: async () => JSON.parse(await readFile(cardPath, 'utf8')) });
  }
} else {
  for (const entry of await listProjects()) {
    if (!entry.exists) continue;
    targets.push({
      label: `${entry.name || entry.id}（${entry.cardPath}）`,
      entry,
      cardPath: entry.cardPath,
      read: () => readCard(entry),
    });
  }
}

let touched = 0;
let backupPath = null;
for (const target of targets) {
  let card;
  try { card = await target.read(); } catch (error) {
    console.log(`✗ ${target.label} 读取失败：${error.message}`);
    continue;
  }
  const moved = planCard(card);
  if (!moved.length) continue;
  touched += 1;
  report(target.label, moved);
  if (!WRITE) continue;
  try {
    if (target.entry) await writeCard(target.entry, card);
    else await writeCardAtPath(target.cardPath, card);
    backupPath = await appendBackup(target.cardPath, moved);
    console.log(`  ↳ 已写入（备份：${backupPath}）`);
  } catch (error) {
    console.log(`  ✗ 写入失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (!touched) {
  console.log('没有需要迁移的卡片：每个目标都只有 0–1 个构思');
} else if (!WRITE) {
  console.log(`\n共 ${touched} 张卡需要迁移；加 --write 才真正写盘`);
} else {
  console.log(`\n已迁移 ${touched} 张卡`);
}
