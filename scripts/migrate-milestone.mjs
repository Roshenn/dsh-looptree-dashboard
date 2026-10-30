#!/usr/bin/env node
/**
 * scripts/migrate-milestone.mjs — 「闭环」升级成「里程碑」的数据迁移（一次性）。
 *
 *   node scripts/migrate-milestone.mjs                  # 干跑：只打印每张卡会怎么改
 *   node scripts/migrate-milestone.mjs --write          # 真正写盘（先备份，回滚用 git + 备份）
 *   node scripts/migrate-milestone.mjs --file <card>    # 只处理一张卡
 *   node scripts/migrate-milestone.mjs --samples        # 处理仓库 samples/*.rotation.json
 *   ROTATION_HOME=/tmp/rot-home node scripts/migrate-milestone.mjs --write
 *
 * 改什么（口径见 rotation-card-spec.md「里程碑 / 愿景」）：
 *   1. 根节点 `loop` → `milestone`，`kind: "loop"` → `"milestone"`（id 永不复用，不重命名）
 *   2. `intent`（闭环目标）→ `vision`（愿景）：文本原样保留，之后按宏大叙事口径改写
 *   3. `scenario`（落地场景流程）→ **不迁移**：旧文本写进 `<卡片>.milestone-backup.json` 后删除；
 *      旧场景描述的是「整个项目走一遍」，落到单个目标会错位，交给目标「生成」按目标重写
 *   4. `closed_loops` → `closed_milestones`（含快照里的 `kind`）
 *   5. `prompt_context.fields` 的 `loop.*` keys → `milestone.*`
 *
 * 幂等：已经是新结构且没有旧字段的卡片直接跳过。
 */
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCard } from '../lib/core.mjs';
import { listProjects, cardPathOf } from '../lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const WRITE = has('--write');

const CTX_ALIAS = {
  loop: 'milestone',
  'loop.intent': 'milestone.vision',
  'loop.acceptance': 'milestone.acceptance',
  'loop.blockers': 'milestone.blockers',
};

/** 摘掉旧字段、返回迁移计划（不改外部的原始 JSON 文本；这里改读入的对象） */
function planCard(card) {
  const changed = [];
  const backup = {};
  // 根节点
  if (card.loop && !card.milestone) {
    card.milestone = card.loop;
    delete card.loop;
    changed.push('loop → milestone');
  }
  const root = card.milestone;
  if (!root) return { changed, backup };
  if (root.kind === 'loop') {
    root.kind = 'milestone';
    changed.push('kind: loop → milestone');
  }
  // intent → vision
  if (root.intent != null) {
    if (root.vision == null && String(root.intent).trim()) {
      root.vision = root.intent;
      changed.push('intent → vision');
    } else {
      backup.intent = root.intent;
      changed.push('intent → 备份（vision 已存在）');
    }
    delete root.intent;
  }
  // scenario 不迁移
  if (root.scenario != null) {
    if (String(root.scenario).trim()) {
      backup.scenario = root.scenario;
      changed.push('scenario → 备份后删除');
    }
    delete root.scenario;
  }
  // 历史
  if (Array.isArray(card.closed_loops)) {
    const merged = Array.isArray(card.closed_milestones) ? card.closed_milestones : [];
    const seen = new Set(merged.map((x) => x && x.id));
    card.closed_milestones = merged.concat(card.closed_loops.filter((x) => x && !seen.has(x.id)));
    delete card.closed_loops;
    changed.push('closed_loops → closed_milestones');
  }
  if (Array.isArray(card.closed_milestones)) {
    card.closed_milestones.forEach((entry) => {
      const snap = entry && entry.snapshot;
      if (snap && snap.kind === 'loop') {
        snap.kind = 'milestone';
        changed.push(`历史快照 ${snap.id || entry.id}: kind → milestone`);
      }
    });
  }
  // prompt_context keys
  const mapFields = (cfg, label) => {
    if (!cfg || !Array.isArray(cfg.fields)) return;
    const next = cfg.fields.map((k) => CTX_ALIAS[k] || k);
    if (next.join('|') !== cfg.fields.join('|')) {
      cfg.fields = next;
      changed.push(`${label}.prompt_context.fields 改名`);
    }
  };
  mapFields(card.prompt_context, '卡片');
  mapFields(root.prompt_context, '里程碑');
  return { changed, backup };
}

async function appendBackup(cardPath, cardName, backup) {
  const backupPath = cardPath + '.milestone-backup.json';
  let prev = [];
  try {
    const parsed = JSON.parse(await readFile(backupPath, 'utf8'));
    if (Array.isArray(parsed)) prev = parsed;
  } catch { /* 没有备份文件就从空开始 */ }
  prev.push({ at: new Date().toISOString(), card: cardName, ...backup });
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
  targets = [{ name: basename(single), path: single }];
} else if (has('--samples')) {
  const dir = join(ROOT, 'samples');
  targets = (await readdir(dir)).filter((f) => f.endsWith('.rotation.json')).sort()
    .map((f) => ({ name: f, path: join(dir, f) }));
} else {
  targets = (await listProjects()).map((p) => ({ name: p.file || p.id, path: cardPathOf(p) }));
}

if (!targets.length) {
  console.log('没有可处理的项目（注册表为空？）');
  process.exit(0);
}

let cards = 0;
for (const t of targets) {
  let raw;
  try {
    raw = await readFile(t.path, 'utf8');
  } catch (error) {
    console.log(`skip  ${t.name}：读不到卡片（${error.message}）`);
    continue;
  }
  let card;
  try {
    card = JSON.parse(raw);
  } catch (error) {
    console.log(`skip  ${t.name}：JSON 解析失败（${error.message}）`);
    continue;
  }
  const before = JSON.stringify(card);
  const { changed, backup } = planCard(card);
  if (JSON.stringify(card) === before) {
    console.log(`keep  ${t.name}（已是里程碑结构）`);
    continue;
  }
  cards += 1;
  if (!WRITE) {
    console.log(`dry   ${t.name}：${changed.join('；')}`);
    continue;
  }
  const backupPath = (backup.intent || backup.scenario) ? await appendBackup(t.path, t.name, backup) : null;
  try {
    await writePlain(t.path, card);
  } catch (error) {
    console.log(`fail  ${t.name}：${error.message}（备份已写，卡片未改）`);
    continue;
  }
  console.log(`write ${t.name}：${changed.join('；')}`);
  if (backupPath) console.log(`      backup → ${backupPath}`);
}

if (!WRITE) {
  console.log(`\n干跑：${cards} 张卡会迁移。加 --write 执行（先备份后写盘）。`);
} else {
  console.log(`\n完成：${cards} 张卡已迁移。旧愿景 / 场景流程文本都在 <卡片>.milestone-backup.json。`);
  console.log('提示：目标里的落地场景流程现在是空的，刷新面板后在目标详情点「生成」按目标重写。');
}
