#!/usr/bin/env node
/**
 * scripts/migrate-capabilities.mjs — 把旧结构收敛成「里程碑 → 能力闭环 → 执行记录」。
 *
 *   node scripts/migrate-capabilities.mjs                  # 干跑：只打印每张卡会怎么改
 *   node scripts/migrate-capabilities.mjs --write          # 真正写盘（先备份，回滚用 git + 备份）
 *   node scripts/migrate-capabilities.mjs --file <card>    # 只处理一张卡
 *   node scripts/migrate-capabilities.mjs --samples        # 处理仓库 samples/*.rotation.json
 *   node scripts/migrate-capabilities.mjs --help           # 用法
 *   ROTATION_HOME=~/.dsh/rotation node scripts/migrate-capabilities.mjs --write
 *
 * 改什么（口径见 rotation-card-spec.md「里程碑 / 能力闭环」）：
 *   1. `milestone.blockers`（阻碍项）/ `milestone.supports`（上一版）→ `milestone.capabilities`（主要能力闭环）
 *   2. 深度 2 的 `goal` / `idea` / `support` → `capability`（id / title / status / closed_at 保留）
 *   3. `goal.blocker` / `support` → `capability.capability`（承接的能力闭环条目）
 *   4. `goal` 下的 `idea` 折叠进能力闭环：approach / plan 空时填充，
 *      所有 idea 的 children（执行记录）全部上提，idea 本身删除
 *   5. `loop` → `milestone`、`kind: loop → milestone`（旧旧卡兜底）
 *
 * 新增字段（module / module_mode / collaboration / gap）留空：它们是候选阶段产出的，
 * 迁移后由面板「生成 N 项」按第一性原理补齐。
 *
 * 不改什么：`scenario` / `constraints` / `acceptance` / `milestone.metrics` 是已退役字段，
 * **留在 JSON、由校验器给警告**，迁移脚本不删除。
 *
 * 备份：`--write` 时先把原卡整张写进 `<卡片>.capabilities-backup.json` 再原子写回。
 * 幂等：已经是三层能力闭环结构、且没有 blockers / supports / goal / idea 的卡片直接跳过。
 * 逐卡处理：单张卡失败只报错，不中断其它卡。
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

const HELP = `用法：node scripts/migrate-capabilities.mjs [选项]

把旧的三层卡片（里程碑 → 目标 → 构思 → 执行记录）迁移成新三层
（里程碑 → 能力闭环 → 执行记录）。

选项：
  --write            真正写盘（默认只打印计划）。写前先把原卡备份成
                     <卡片>.capabilities-backup.json，再原子写回。
  --file <card>      只处理一张卡（路径）
  --samples          处理仓库 samples/*.rotation.json（不碰注册表）
  --help             显示本帮助

环境变量：
  ROTATION_HOME      注册表根目录（默认 ~/.dsh），--file / --samples 时不用

迁移规则：
  milestone.blockers            → milestone.capabilities（一条一行）
  深度 2 的 goal                → support（id / title / status 保留）
  goal.blocker                  → capability.capability（承接能力闭环，≤80 字）
  goal 下的 idea                → 折叠进 support：approach / plan 空时填充，
                                  children 全部上提为 support 的子节点
  scenario / constraints /
  acceptance                    → 退役字段，保留在 JSON，只由校验器警告

幂等：已经是三层能力闭环结构、且没有 blockers / goal / idea 的卡片直接跳过。
逐卡处理：单张卡失败只报错，不中断其它卡。
`;

/** 行首序号/符号归一：列表字段统一成「N)一条」 */
const ITEM_PREFIX_RE = /^\s*(?:\d{1,3}\s*[)）、]\s*|\d{1,3}\.\s+|[-A-Za-z]\s*[.、)]\s*|[A-Za-z][.、)]\s*|[一二三四五六七八九十]+[、.]\s*|[-•*○◯·∙▪◦]+\s*|[①-⑳]\s*|[-•*○◯·∙▪◦][)）、]\s*)+/;
function normalizeLines(text) {
  const items = String(text == null ? '' : text)
    .split('\n')
    .map((x) => x.replace(ITEM_PREFIX_RE, '').trim())
    .filter(Boolean);
  return items.map((x, i) => `${i + 1})${x}`).join('\n');
}

/** 把 goal 下的 idea 折叠进能力闭环：approach / plan 空时填充，children 全部上提 */
function foldIdeas(node, label, changed) {
  const kids = Array.isArray(node.children) ? node.children : [];
  const ideas = kids.filter((c) => c && c.kind === 'idea');
  if (!ideas.length) return;
  const first = ideas[0];
  if (!String(node.approach || '').trim() && String(first.approach || '').trim()) {
    node.approach = first.approach;
    changed.push(`${label}: idea.approach → capability.approach`);
  }
  if (node.plan == null && first.plan != null) {
    node.plan = first.plan;
    changed.push(`${label}: idea.plan → capability.plan`);
  }
  const kept = [];
  let lifted = 0;
  for (const kid of kids) {
    if (kid && kid.kind === 'idea') {
      const grand = Array.isArray(kid.children) ? kid.children : [];
      lifted += grand.length;
      kept.push(...grand);
    } else {
      kept.push(kid);
    }
  }
  node.children = kept;
  changed.push(`${label}: 折叠 ${ideas.length} 个构思，上提 ${lifted} 个执行记录`);
}

/** 深度 2 节点：goal / idea / support → capability，并承接能力闭环条目 */
function foldCapability(node, label, changed) {
  if (!node || typeof node !== 'object') return;
  const legacy = node.kind === 'goal' || node.kind === 'idea' || node.kind === 'support';
  if (legacy) {
    changed.push(`${label}(${node.id}): ${node.kind} → capability`);
    node.kind = 'capability';
  } else if (node.kind !== 'capability') {
    changed.push(`${label}(${node.id}): kind ${node.kind} → capability`);
    node.kind = 'capability';
  }
  // 上一版的承接字段 support / 更早的 goal.blocker → capability.capability
  if (node.capability == null && node.support != null) {
    node.capability = String(node.support);
    changed.push(`${label}(${node.id}): support → capability.capability`);
  }
  if (node.blocker != null) {
    const blocker = String(node.blocker).trim();
    if (blocker && !String(node.capability || '').trim()) {
      node.capability = blocker.length > 80 ? blocker.slice(0, 79) + '…' : blocker;
      changed.push(`${label}(${node.id}): blocker → capability.capability`);
    } else if (blocker) {
      changed.push(`${label}(${node.id}): blocker 丢弃（capability.capability 已有值）`);
    }
    delete node.blocker;
  }
  delete node.support;
  if (legacy) foldIdeas(node, `${label}(${node.id})`, changed);
  // 能力闭环的子节点只应是执行记录：旧卡里残留的其它 kind 统一矫正
  (Array.isArray(node.children) ? node.children : []).forEach((kid, i) => {
    if (!kid || typeof kid !== 'object') return;
    if (kid.kind !== 'exec') {
      changed.push(`${label}(${node.id}).children[${i}](${kid.id}): kind ${kid.kind} → exec`);
      kid.kind = 'exec';
    }
  });
}

/** 摘掉旧结构、返回迁移计划（原地改读入对象） */
function planCard(card) {
  const changed = [];
  const root = card && card.milestone;
  if (!root || typeof root !== 'object') return { changed, reason: '缺少 milestone 根节点，跳过' };
  if (root.kind === 'loop') {
    root.kind = 'milestone';
    changed.push('kind: loop → milestone');
  }
  // 阻碍项 / 上一版的 supports → 主要能力闭环
  for (const [from, to] of [['blockers', 'capabilities'], ['supports', 'capabilities']]) {
    if (root[from] == null) continue;
    const text = String(root[from]).trim();
    if (text) {
      const current = String(root.capabilities || '').trim();
      root.capabilities = current ? current + '\n' + normalizeLines(text) : normalizeLines(text);
      changed.push(`${from} → capabilities`);
    } else {
      changed.push(`${from} 为空 → 删除`);
    }
    delete root[from];
  }
  const kids = Array.isArray(root.children) ? root.children : [];
  kids.forEach((kid, i) => foldCapability(kid, `milestone.children[${i}]`, changed));
  return { changed };
}

/** 整张原卡追加进卡片旁的备份文件（可重复跑，不覆盖历史） */
async function appendBackup(cardPath, cardName, original) {
  const backupPath = cardPath + '.capabilities-backup.json';
  let prev = [];
  try {
    const parsed = JSON.parse(await readFile(backupPath, 'utf8'));
    if (Array.isArray(parsed)) prev = parsed;
  } catch { /* 没有备份文件就从空开始 */ }
  prev.push({ at: new Date().toISOString(), card: cardName, original });
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

if (has('--help') || has('-h')) {
  console.log(HELP);
  process.exit(0);
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
let skipped = 0;
let failed = 0;
for (const t of targets) {
  let card;
  let original;
  try {
    // 必须读磁盘上的原卡：store.readCard 会把 goal/idea 归一成 support，
    // 拿归一后的对象做计划会永远判「已是最新」，--write 就什么都不写（2026-10-31 踩过）
    const raw = await readFile(t.path, 'utf8');
    card = JSON.parse(raw);
    original = JSON.parse(JSON.stringify(card));
  } catch (error) {
    failed += 1;
    console.log(`skip  ${t.name}：读不到卡片（${error.message}）`);
    continue;
  }
  let changed = [];
  try {
    const plan = planCard(card);
    if (plan.reason) {
      skipped += 1;
      console.log(`keep  ${t.name}（${plan.reason}）`);
      continue;
    }
    changed = plan.changed;
  } catch (error) {
    failed += 1;
    console.log(`fail  ${t.name}：迁移计划出错（${error.message}），卡片未改`);
    continue;
  }
  if (!changed.length) {
    skipped += 1;
    console.log(`keep  ${t.name}（已是能力闭环结构）`);
    continue;
  }
  cards += 1;
  if (!WRITE) {
    console.log(`dry   ${t.name}：${changed.join('；')}`);
    continue;
  }
  const backupPath = await appendBackup(t.path, t.name, original);
  try {
    if (t.entry) await writeCard(t.entry, card, { lenient: true });
    else await writePlain(t.path, card);
  } catch (error) {
    failed += 1;
    console.log(`fail  ${t.name}：${error.message}（备份已写，卡片未改）`);
    continue;
  }
  console.log(`write ${t.name}：${changed.join('；')}`);
  console.log(`      backup → ${backupPath}`);
}

if (!WRITE) {
  console.log(`\n干跑：${cards} 张卡会迁移，${skipped} 张已是最新${failed ? `，${failed} 张读不了` : ''}。加 --write 执行（先备份后写盘）。`);
} else {
  console.log(`\n完成：${cards} 张卡已迁移，${skipped} 张跳过${failed ? `，${failed} 张失败（卡片未改）` : ''}。`);
  console.log('原卡整张备份在 <卡片>.capabilities-backup.json。');
  console.log('提示：退役字段 scenario / constraints / acceptance 仍留在卡片里，校验器只警告；需要人工按新口径改写。');
}
process.exit(failed ? 1 : 0);
