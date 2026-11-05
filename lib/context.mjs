/**
 * lib/context.mjs — 「这个会话属于哪个项目」的只读推导（host 半）
 *
 * composer 启动器每次渲染会话都要问一次上下文，所以这里不探活、不拉起进程、
 * 不发网络请求：只读注册表 + 工作区存储，能推导多少算多少，失败一律降级不抛。
 *
 *   pickProjectForPath(projects, cwd)   纯函数：cwd 落在哪个项目 workspace 里（最长匹配）
 *   cwdForSession(ctx, sessionId, ...) 会话 → 工作目录（DSH 的几个服务都可能是空的）
 *   summarizeServices(card, platform)  卡片里的服务配置概览（startable 按当前平台算）
 *   createSessionContext(...)          上面三者的组合，给 GET /session/context 用
 */
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { listProjects, readCard } from './store.mjs';
import { resolvePlatformValue } from './services.mjs';

/** 服务概览的空值（卡片读不到时也用它，形状始终一致） */
function emptyServices() {
  return { total: 0, startable: 0, hasUrl: false };
}

/** 路径归一化：空值 / 非法值返回 ''（path.resolve('') 会变成 cwd，必须先挡掉） */
function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  try { return resolve(text); } catch { return ''; }
}

/** 服务方法可能同步也可能异步、可能不存在；统一取值并吞掉异常 */
async function getValue(service, arg) {
  try {
    if (!service || typeof service.get !== 'function') return undefined;
    const value = service.get(arg);
    return value && typeof value.then === 'function' ? await value : value;
  } catch {
    return undefined;
  }
}

/** 工作目录可能是字符串，也可能是带 path 的对象；取不到返回 '' */
function pathOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['path', 'cwd', 'dir']) {
      const text = typeof value[key] === 'string' ? value[key].trim() : '';
      if (text) return text;
    }
  }
  return '';
}

/**
 * cwd 落在哪个项目的 workspace 里——纯函数，最长（最具体）的那个赢。
 *
 * 用 path.relative 而不是 startsWith：`/a/foo` 不能匹配 `/a/foobar`；
 * relative 结果是 `..` / `../x` / 绝对路径（Windows 换盘符）都说明不是祖先。
 */
export function pickProjectForPath(projects, cwd) {
  const target = normalizePath(cwd);
  if (!target) return null;
  let best = null;
  let bestLen = -1;
  for (const project of Array.isArray(projects) ? projects : []) {
    const workspace = normalizePath(project && project.workspace);
    if (!workspace) continue;
    let rel;
    try { rel = relative(workspace, target); } catch { continue; }
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    // 嵌套项目（/a 与 /a/foo）取路径更长的那个；同长时先登记的赢
    if (workspace.length > bestLen) { best = project; bestLen = workspace.length; }
  }
  return best;
}

/**
 * 会话 → 工作目录；解析顺序按「越直接越先」：
 *   ctx.sessions.get(id) → ctx.workingDirectory.get(session) → session.header.cwd → 工作区存储
 * 任一步拿到就返回，全都拿不到返回 ''（绝不抛）。
 */
export async function cwdForSession(ctx, sessionId, options = {}) {
  const { readWorkspacePath } = options || {};
  try {
    const id = String(sessionId || '');
    const session = await getValue(ctx?.sessions, id);
    // 没有会话对象就不调 workingDirectory.get——传 undefined 可能拿到默认目录，误判成别的项目
    const fromWorkingDirectory = session ? pathOf(await getValue(ctx?.workingDirectory, session)) : '';
    if (fromWorkingDirectory) return fromWorkingDirectory;
    const fromHeader = pathOf(session?.header?.cwd);
    if (fromHeader) return fromHeader;
    if (typeof readWorkspacePath === 'function') {
      const fromStore = pathOf(await readWorkspacePath(id));
      if (fromStore) return fromStore;
    }
  } catch { /* 所有来源都不可用时当未知会话处理 */ }
  return '';
}

/**
 * 卡片里的服务概览：只数配置，不探网络、不读进程。
 * startable = 当前平台有非空启动命令的服务数；hasUrl = 是否配了任意服务地址。
 */
export function summarizeServices(card, platform = process.platform) {
  const list = Array.isArray(card?.services) ? card.services : [];
  let startable = 0;
  let hasUrl = false;
  for (const svc of list) {
    if (!svc || typeof svc !== 'object') continue;
    if (resolvePlatformValue(svc.start, platform)) startable += 1;
    if (String(svc.url || '').trim()) hasUrl = true;
  }
  return { total: list.length, startable, hasUrl };
}

/**
 * 组装 GET /session/context 的响应体；返回的函数不会抛，失败也回结构化结果。
 *
 *   opts.ctx              宿主 ctx（sessions / workingDirectory 全部可选）
 *   opts.readWorkspacePath (sessionId) => Promise<string>，DSH 工作区存储查询
 *   opts.platform         平台，默认 process.platform
 *
 * 成功：{ ok:true, sessionId, cwd, project:{id,name,file,workspace}|null, services, token, panelId }
 *   panelId：面板里的项目 key（`card-<里程碑根 id>`），composer 卡片靠它定位聚焦视图；
 *   面板的项目 id 不是注册表 id，拿错会静默落回第一个项目。
 * 失败：{ ok:false, sessionId, error }
 */
export function createSessionContext({ ctx, readWorkspacePath, platform = process.platform } = {}) {
  // token 是否可用只看「宿主有没有 tapIndex」——apply() 用同一个判据决定是否注入 DSH 首页
  const token = typeof ctx?.webServer?.tapIndex === 'function';
  return async function sessionContext(sessionId) {
    const id = String(sessionId || '').trim();
    try {
      if (!id) return { ok: false, sessionId: '', error: '缺 sessionId' };
      const cwd = await cwdForSession(ctx, id, { readWorkspacePath });
      const project = pickProjectForPath(await listProjects(), cwd);
      if (!project) {
        return { ok: true, sessionId: id, cwd, project: null, services: emptyServices(), token, panelId: '' };
      }
      let services = emptyServices();
      let panelId = '';
      try {
        // 卡片坏了不影响「这个会话属于哪个项目」——只把服务概览与面板 key 降级成空
        const card = await readCard(project);
        services = summarizeServices(card, platform);
        const rootId = card && card.milestone && card.milestone.id;
        if (rootId) panelId = 'card-' + rootId;
      } catch (error) {
        ctx?.logger?.warn?.('[rotation] session context: read card failed: ' + ((error && error.message) || error));
      }
      return {
        ok: true,
        sessionId: id,
        cwd,
        project: { id: project.id, name: project.name, file: project.file, workspace: project.workspace },
        services,
        token,
        panelId,
      };
    } catch (error) {
      return { ok: false, sessionId: id, error: (error && error.message) || String(error) };
    }
  };
}
