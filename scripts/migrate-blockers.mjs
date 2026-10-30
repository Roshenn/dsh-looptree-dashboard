#!/usr/bin/env node
/**
 * scripts/migrate-blockers.mjs — 闭环「约束」退役：`loop.constraints` → 阻碍项字段腾位。
 *
 *   node scripts/migrate-blockers.mjs                  # 干跑：只打印每张卡会怎么改
 *   node scripts/migrate-blockers.mjs --write          # 真正写盘（先备份，回滚用 git + 备份）
 *   node scripts/migrate-blockers.mjs --file <card>    # 只处理一张卡
 *   node scripts/migrate-blockers.mjs --samples        # 处理仓库 samples/*.rotation.json
 *   ROTATION_HOME=/tmp/rot-home node scripts/migrate-blockers.mjs --write
 *
 * 规则（2026-10-29 口径）：闭环的「约束」效用低，改为「阻碍项」回答
 * 「现在就实现这个闭环，缺哪个模块/功能才跑通」。旧约束文本**不搬到新字段**——
 * 先原样追加进 `<卡片>.blockers-backup.json`，再把 `loop.constraints` 删掉，
 * 卡片里阻碍项留空，由面板「生成」按新 prompt 重新产出。
 *
 * 目标上的 `goal.constraints`（约束）不动：它管的是「选题材的边界」，不是阻碍。
 * 幂等：没有 `loop.constraints` 的卡片直接跳过。
 */
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCard } from '../lib/core.mjs';
import { listProjects, readCard, writeCard, cardPathOf } from '../lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const WRITE = has('--write');

/** 摘掉闭环上的 constraints（返回被摘掉的条目；目标上的不动） */
function planCard(card) {
  const removed = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'milestone' && typeof n.constraints === 'string' && n.constraints.trim()) {
      removed.push({ nodeId: n.id, title: n.title || '', constraints: n.constraints });
      delete n.constraints;
    }
    (Array.isArray(n.children) ? n.children : []).forEach(walk);
  };
  walk(card.milestone);
  return removed;
}

/** 旧文本追加进卡片旁的备份文件（可重复跑，不覆盖历史） */
async function appendBackup(cardPath, cardName, removed) {
  const backupPath = cardPath + '.blockers-backup.json';
  let prev = [];
  try {
    const parsed = JSON.parse(await readFile(backupPath, 'utf8'));
    if (Array.isArray(parsed)) prev = parsed;
  } catch { /* 没有备份文件就从空开始 */ }
  prev.push({ at: new Date().toISOString(), card: cardName, removed });
  await writeFile(backupPath, JSON.stringify(prev, null, 1) + '\n', 'utf8');
  return backupPath;
}

/** 不走注册表的卡片（--file / --samples）：校验 → 原子写 */
async function writePlain(cardPath, card) {
  const { errors } = validateCard(card, { lenient: true });
  if (errors.length) throw new Error(`校验未通过：${errors[0]}`);
  card.updated = new Date().toISOString();
  const tmp = join(dirname(cardPath), `.rotation.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
  await rename(tmp, cardPath);
}

// ── 目标清单：--file / --samples / 注册表 ──
const single = valueOf('--file');
let targets = [];
if (single) {
  targets = [{ name: basename(single), path: single, entry: null }];
} else if (has('--samples')) {
  const dir = join(ROOT, 'samples');
  targets = (await readdir(dir)).filter((f) => f.endsWith('.rotation.json')).sort()
    .map((f) => ({ name: f, path: join(dir, f), entry: null }));
} else {
  targets = (await listProjects()).map((p) => ({ name: p.file || p.id, path: cardPathOf(p), entry: p }));
}

if (!targets.length) {
  console.log('没有可处理的项目（注册表为空？）');
  process.exit(0);
}

let cards = 0;
let loops = 0;
for (const t of targets) {
  let card;
  try {
    card = t.entry ? await readCard(t.entry) : JSON.parse(await readFile(t.path, 'utf8'));
  } catch (error) {
    console.log(`skip  ${t.name}：读不到卡片（${error.message}）`);
    continue;
  }
  const removed = planCard(card);
  if (!removed.length) {
    console.log(`keep  ${t.name}（没有 loop.constraints）`);
    continue;
  }
  cards += 1;
  loops += removed.length;
  const list = removed.map((r) => `${r.nodeId}「${r.title}」${r.constraints.length} 字`).join('；');
  if (!WRITE) {
    console.log(`dry   ${t.name}：会摘掉 ${list}`);
    continue;
  }
  const backup = await appendBackup(t.path, t.name, removed);
  try {
    if (t.entry) await writeCard(t.entry, card, { lenient: true });
    else await writePlain(t.path, card);
  } catch (error) {
    console.log(`fail  ${t.name}：${error.message}（备份已写，卡片未改）`);
    continue;
  }
  console.log(`write ${t.name}：摘掉 ${list}`);
  console.log(`      backup → ${backup}`);
}

if (!WRITE) {
  console.log(`\n干跑：${cards} 张卡 / ${loops} 个闭环会摘掉 constraints。加 --write 执行（先备份后写盘）。`);
} else {
  console.log(`\n完成：${cards} 张卡 / ${loops} 个闭环。旧约束文本都在 <卡片>.blockers-backup.json。`);
  console.log('提示：闭环阻碍项现在是空的，刷新面板点详情卡的「生成 N 项」按新 prompt 重新产出。');
}
