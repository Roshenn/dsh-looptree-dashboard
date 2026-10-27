/**
 * lib/store.mjs — 项目注册表与卡片读写（host 半的数据层）
 *
 * 数据布局：
 *   ~/.dsh/rotation/registry.json      [{ id, name, workspace, file }]
 *   <workspace>/.dsh/rotation.json     卡片真身（rotation/v1）
 *
 * 约定：registry 只存指针，卡片跟着项目走，可随项目仓库一起版本化。
 */
import { readFile, writeFile, rename, mkdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { validateCard } from './core.mjs';

export const REGISTRY_DIR = process.env.ROTATION_HOME || join(homedir(), '.dsh', 'rotation');
export const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json');
export const CARD_REL = join('.dsh', 'rotation.json');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const TEMPLATE = {
  schema: 'rotation/v1',
  project: { name: '新项目', workspace: '' },
  updated: null,
  loop: {
    id: 'loop', kind: 'loop', title: '待命名闭环',
    intent: '一句话说清这个闭环要解决什么', acceptance: '可判定的收敛标准',
    status: 'plan', closed_at: null, children: [],
  },
};

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
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

export async function listProjects() {
  const list = await readRegistry();
  const out = [];
  for (const entry of list) {
    const cardPath = cardPathOf(entry);
    out.push({ ...entry, cardPath, exists: await exists(cardPath) });
  }
  return out;
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
  return JSON.parse(text);
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

/** 校验后原子写；写前留一份 .bak */
export async function writeCard(entry, card) {
  const { errors, warnings, stats } = validateCard(card);
  if (errors.length) {
    const err = new Error('校验未通过');
    err.status = 422;
    err.errors = errors;
    err.warnings = warnings;
    throw err;
  }
  const target = cardPathOf(entry);
  await mkdir(dirname(target), { recursive: true });
  if (await exists(target)) await copyFile(target, target + '.bak').catch(() => {});
  card.updated = new Date().toISOString();
  const tmp = join(dirname(target), `.rotation.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(card, null, 1) + '\n', 'utf8');
  await rename(tmp, target);
  return { warnings, stats };
}

/** 从注册表移除项目（只取消登记，不动项目里的卡片文件） */
export async function removeProject(key) {
  const list = await readRegistry();
  const idx = list.findIndex((p) => p.id === key || p.file === key);
  if (idx < 0) { const e = new Error(`找不到项目：${key}`); e.status = 404; throw e; }
  const [removed] = list.splice(idx, 1);
  await writeRegistry(list);
  return removed;
}

/** 注册一个项目；workspace 不存在时创建卡片模板 */
export async function addProject({ id, name, workspace }) {
  const ws = String(workspace || '').trim();
  if (!ws) { const e = new Error('workspace 必填'); e.status = 400; throw e; }
  const st = await stat(ws).catch(() => null);
  if (!st || !st.isDirectory()) { const e = new Error(`目录不存在：${ws}`); e.status = 400; throw e; }
  const list = await readRegistry();
  const pid = id || slugify(name || basename(ws));
  if (!ID_RE.test(pid)) { const e = new Error(`项目 id 不合法：${pid}`); e.status = 400; throw e; }
  if (list.some((p) => p.id === pid)) { const e = new Error(`项目 id 已存在：${pid}`); e.status = 409; throw e; }
  const entry = { id: pid, name: String(name || pid), workspace: ws, file: `${pid}.rotation.json` };
  const target = cardPathOf(entry);
  if (!(await exists(target))) {
    const tpl = JSON.parse(JSON.stringify(TEMPLATE));
    tpl.loop.id = pid + '-loop';
    tpl.project = { ...(tpl.project || {}), name: entry.name, workspace: ws };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(tpl, null, 1) + '\n', 'utf8');
  }
  list.push(entry);
  await writeRegistry(list);
  return entry;
}
