/**
 * lib/store.mjs — 项目注册表与卡片读写（host 半的数据层）
 *
 * 数据布局：
 *   ~/.dsh/rotation/registry.json      [{ id, name, workspace, file }]
 *   <workspace>/.dsh/rotation.json     卡片真身（rotation/v1）
 *
 * 约定：registry 只存指针，卡片跟着项目走，可随项目仓库一起版本化。
 */
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { validateCard, normalizeLegacyCard } from './core.mjs';

export const REGISTRY_DIR = process.env.ROTATION_HOME || join(homedir(), '.dsh', 'rotation');
export const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json');
export const CARD_REL = join('.dsh', 'rotation.json');
// DSH_HOME 在部分环境里是「.dsh 的父目录」，也可能是 `.dsh` 本身；两种都兼容
export const DSH_HOME = (() => {
  const env = process.env.DSH_HOME;
  if (!env) return join(homedir(), '.dsh');
  return env.replace(/\/$/, '').endsWith('/.dsh') ? env.replace(/\/$/, '') : join(env, '.dsh');
})();
export const DSH_WORKSPACES = (() => {
  const direct = join(DSH_HOME, 'storages', 'workspace.json');
  if (existsSync(direct)) return direct;
  const alt = join(homedir(), '.dsh', 'storages', 'workspace.json');
  return existsSync(alt) ? alt : direct;
})();
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const TEMPLATE = {
  schema: 'rotation/v1',
  project: { name: '新项目', workspace: '' },
  updated: null,
  milestone: {
    id: 'milestone', kind: 'milestone', title: '待命名里程碑',
    vision: '一段宏大叙事：这个里程碑之后，项目/用户变成什么样（3–6 句，不写功能清单）',
    blockers: '', acceptance: '可判定的达成标准（怎么判定愿景达成）',
    status: 'plan', closed_at: null, children: [],
  },
};

export function slugify(text) {
  const ascii = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // 中文名 → 没有可用 ASCII 时退回随机 id，显示名仍用 project.name
  return ascii || `project-${Math.random().toString(36).slice(2, 6)}`;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/**
 * 本机登记判定：workspace 目录在本机存在，这条登记才是「这台机器上的项目」。
 * ~/.dsh 会被多台机器同步（git），注册表里的绝对路径是各自机器的写法：
 * 另一台机器写进来的路径在这里读不到，既不该显示，也不该占住 id / 目录。
 */
async function isLocalEntry(entry) {
  if (!entry || !entry.workspace) return false;
  try { return (await stat(entry.workspace)).isDirectory(); } catch { return false; }
}

/** 把注册表拆成「本机可见」与「另一台机器的」两半；写回时两半都要保留 */
async function partitionRegistry(list) {
  const local = [];
  const foreign = [];
  for (const entry of list) ((await isLocalEntry(entry)) ? local : foreign).push(entry);
  return { local, foreign };
}

export async function readRegistry() {
  try {
    const raw = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function writeRegistry(list) {
  await mkdir(REGISTRY_DIR, { recursive: true });
  const tmp = join(REGISTRY_DIR, `.registry.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(list, null, 1) + '\n', 'utf8');
  await rename(tmp, REGISTRY_PATH);
}

export function cardPathOf(entry) {
  return join(entry.workspace, CARD_REL);
}

/** 本机可见的项目（workspace 不在本机的登记属于另一台机器，不显示） */
export async function listProjects() {
  const { local } = await partitionRegistry(await readRegistry());
  const out = [];
  for (const entry of local) {
    const cardPath = cardPathOf(entry);
    out.push({ ...entry, cardPath, exists: await exists(cardPath) });
  }
  return out;
}

/** 读取 DSH 自己的工作区列表（storages/workspace.json → tables.workspaces） */
export async function listDshWorkspaces() {
  const raw = JSON.parse(await readFile(DSH_WORKSPACES, 'utf8'));
  const table = raw?.tables?.workspaces || {};
  const items = Object.entries(table).map(([id, rec]) => ({
    id,
    title: rec?.title || (rec?.path || '').split('/').filter(Boolean).pop() || id,
    path: rec?.path || '',
    sessions: Array.isArray(rec?.sessionIds) ? rec.sessionIds.length : 0,
    updatedAt: rec?.updatedAt || rec?.createdAt || null,
  })).filter((w) => w.path);
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

/** 在卡片树里找节点 */
export function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** 按 id 或卡片文件名找项目 */
export async function findProject(key) {
  const list = await listProjects();
  return list.find((p) => p.id === key || p.file === key || basename(p.cardPath) === key) || null;
}

export async function readCard(entry) {
  const text = await readFile(cardPathOf(entry), 'utf8');
  // 旧卡（loop / intent / closed_loops）读入即改名，写盘落新结构
  return normalizeLegacyCard(JSON.parse(text));
}

export async function readAllCards() {
  const projects = await listProjects();
  const cards = [];
  for (const p of projects) {
    try {
      cards.push({ id: p.id, name: p.name, file: p.file, card: await readCard(p) });
    } catch (error) {
      cards.push({ id: p.id, name: p.name, file: p.file, error: error.message });
    }
  }
  return cards;
}

/** 校验后原子写（tmp + rename）；不另留 .bak，历史版本交给 git */
export async function writeCard(entry, card, opts = {}) {
  const { errors, warnings, stats } = validateCard(card, { lenient: !!opts.lenient });
  if (errors.length) {
    const err = new Error('校验未通过');
    err.status = 422;
    err.errors = errors;
    err.warnings = warnings;
    throw err;
  }
  const target = cardPathOf(entry);
  await mkdir(dirname(target), { recursive: true });
  card.updated = new Date().toISOString();
  const tmp = join(dirname(target), `.rotation.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
  await rename(tmp, target);
  return { warnings, stats };
}

/** 从注册表移除本机项目（只取消登记，不动项目里的卡片文件；别的机器的登记不动） */
export async function removeProject(key) {
  const list = await readRegistry();
  const { local } = await partitionRegistry(list);
  const idx = list.findIndex((p) => local.includes(p) && (p.id === key || p.file === key));
  if (idx < 0) { const e = new Error(`找不到项目：${key}`); e.status = 404; throw e; }
  const [removed] = list.splice(idx, 1);
  await writeRegistry(list);
  return removed;
}

/** 注册一个项目；workspace 不存在时创建卡片模板 */
export async function addProject({ id, name, workspace, provider, model }) {
  const ws = String(workspace || '').trim();
  if (!ws) { const e = new Error('workspace 必填'); e.status = 400; throw e; }
  const st = await stat(ws).catch(() => null);
  if (!st || !st.isDirectory()) { const e = new Error(`目录不存在：${ws}`); e.status = 400; throw e; }
  const list = await readRegistry();
  const pid = id || slugify(name || basename(ws));
  if (!ID_RE.test(pid)) { const e = new Error(`项目 id 不合法：${pid}`); e.status = 400; throw e; }
  // 查重只看本机可见的登记：别的机器同步进来的条目（workspace 不在本机）不占 id / 目录，
  // 否则同一台机器换个路径就永远加不进来（409 项目 id 已存在）
  const { local } = await partitionRegistry(list);
  const live = [];
  const stale = [];   // 本机登记但卡片已丢：接管掉，免得注册表里留下重复 id
  for (const p of local) ((await exists(cardPathOf(p))) ? live : stale).push(p);
  if (live.some((p) => p.id === pid)) { const e = new Error(`项目 id 已存在：${pid}`); e.status = 409; throw e; }
  if (live.some((p) => p.workspace === ws)) { const e = new Error(`该目录已登记：${ws}`); e.status = 409; throw e; }
  const entry = { id: pid, name: String(name || pid), workspace: ws, file: `${pid}.rotation.json` };
  // 可选：把该项目钉到指定 provider/model（例如网关），不填则用 DSH 默认选择
  if (provider) entry.provider = String(provider);
  if (model) entry.model = String(model);
  const target = cardPathOf(entry);
  if (!(await exists(target))) {
    const tpl = JSON.parse(JSON.stringify(TEMPLATE));
    tpl.milestone.id = pid + '-milestone';
    tpl.project = { ...(tpl.project || {}), name: entry.name, workspace: ws };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(tpl, null, 1) + '\n', 'utf8');
  }
  const takeOver = stale.filter((p) => p.id === pid || p.workspace === ws);
  const next = list.filter((p) => !takeOver.includes(p));
  next.push(entry);
  await writeRegistry(next);
  return entry;
}
