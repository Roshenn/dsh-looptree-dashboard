#!/usr/bin/env node
/**
 * scripts/context-mock.mjs — 「会话属于哪个项目」的断言（不需要 DSH）。
 *
 *   node scripts/context-mock.mjs
 *
 * 背景：composer 卡片的「服务 / 闭环」两个按钮都先问一句 host：
 * 这个会话落在哪个已登记项目里？host 侧由 lib/context.mjs 回答，
 * 而答案的第一跳是「会话 → 工作目录」，第二跳是「工作目录 → 项目」。
 *
 * 覆盖：
 *   · 路径匹配：同路径 / 子目录 / 兄弟前缀陷阱 / 嵌套取最长 / 无匹配 / 空值
 *   · 会话 → 目录的四级回退：sessions+workingDirectory → header.cwd → 工作区存储
 *   · 服务概览按当前平台数 start 命令，不碰网络
 *   · /session/context 的映射、未映射、缺 sessionId 三种响应；token 只看 tapIndex
 *   · 工作区存储回退（workspacePathOfSession）与 readWorkspacePath 注入点
 */
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'rotation-context-home-'));
const dshHome = await mkdtemp(join(tmpdir(), 'rotation-context-dsh-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-context-ws-'));
const wsNested = join(ws, 'nested');
await mkdir(join(wsNested, '.dsh'), { recursive: true });
await mkdir(join(ws, '.dsh'), { recursive: true });
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = dshHome;

const results = [];
const ok = (label, pass, detail = '') => {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

// 工作区存储：session-a 落在 ws，session-b 落在 nested
await mkdir(join(dshHome, '.dsh', 'storages'), { recursive: true });
await writeFile(join(dshHome, '.dsh', 'storages', 'workspace.json'), JSON.stringify({
  tables: {
    workspaces: {
      'ws-1': { path: ws, sessionIds: ['session-a'] },
      'ws-2': { path: wsNested, sessionIds: ['session-b'] },
    },
  },
}), 'utf8');

// 注册表 + 卡片：两个项目，nested 是 ws 的子目录（验证最长匹配）
const entry = (id, workspace) => ({ id, name: id, workspace, file: `${id}.rotation.json` });
await writeFile(join(home, 'registry.json'), JSON.stringify([entry('outer', ws), entry('inner', wsNested)]), 'utf8');
await writeFile(join(ws, '.dsh', 'rotation.json'), JSON.stringify({
  schema: 'rotation/v1',
  project: { name: 'outer', workspace: ws },
  milestone: { id: 'outer-milestone', kind: 'milestone', children: [] },
  services: [
    { id: 'web', name: 'web', url: 'http://127.0.0.1:4100', start: { mac: 'node serve.mjs', windows: 'node serve.mjs' } },
    { id: 'watch', name: 'watch', kind: 'watch', start: 'pnpm dev' },
  ],
}), 'utf8');
await writeFile(join(wsNested, '.dsh', 'rotation.json'), JSON.stringify({
  schema: 'rotation/v1',
  project: { name: 'inner', workspace: wsNested },
  milestone: { id: 'inner-milestone', kind: 'milestone', children: [] },
  services: [{ id: 'n', name: 'n', url: 'http://127.0.0.1:4200', start: { linux: 'true' } }],
}), 'utf8');

const store = await import('../lib/store.mjs');
const context = await import('../lib/context.mjs');

// ── 1) 路径匹配 ──
const projects = await store.listProjects();
ok('注册表读到两个本机项目', projects.length === 2, projects.map((p) => p.id).join(','));
ok('同路径命中', context.pickProjectForPath(projects, ws)?.id === 'outer');
ok('子目录命中父项目', context.pickProjectForPath(projects, join(ws, 'src', 'deep'))?.id === 'outer');
ok('嵌套项目取最长匹配', context.pickProjectForPath(projects, join(wsNested, 'src'))?.id === 'inner');
ok('兄弟前缀不误命中', context.pickProjectForPath(projects, ws + '-sibling') === null);
ok('无匹配返回 null', context.pickProjectForPath(projects, join(tmpdir(), 'elsewhere')) === null);
ok('空 cwd 返回 null', context.pickProjectForPath(projects, '') === null);
ok('空项目表返回 null', context.pickProjectForPath(null, ws) === null);

// ── 2) 会话 → 目录的四级回退 ──
const ctxFull = {
  sessions: { get: (id) => (id === 'session-a' ? { header: { cwd: '/from/header' } } : undefined) },
  workingDirectory: { get: () => '/from/working-dir' },
};
ok('sessions+workingDirectory 优先', await context.cwdForSession(ctxFull, 'session-a') === '/from/working-dir');
ok('没有会话对象时不调 workingDirectory', await context.cwdForSession({
  sessions: { get: () => undefined },
  workingDirectory: { get: () => '/wrong' },
}, 'session-x') === '');
ok('退回 header.cwd', await context.cwdForSession({
  sessions: { get: () => ({ header: { cwd: '/from/header' } }) },
}, 'session-a') === '/from/header');
ok('退回工作区存储', await context.cwdForSession({}, 'session-b', { readWorkspacePath: store.workspacePathOfSession }) === wsNested);
ok('注入的 readWorkspacePath 生效', await context.cwdForSession({}, 'session-c', {
  readWorkspacePath: async (id) => (id === 'session-c' ? '/from/store' : ''),
}) === '/from/store');
ok('服务抛错时不炸', await context.cwdForSession({
  sessions: { get: () => { throw new Error('boom'); } },
}, 'session-a') === '');
ok('未知会话返回空串', await context.cwdForSession({}, 'session-unknown') === '');

// ── 3) 服务概览（不探网络） ──
const card = JSON.parse(await (await import('node:fs/promises')).readFile(join(ws, '.dsh', 'rotation.json'), 'utf8'));
const darwin = context.summarizeServices(card, 'darwin');
ok('mac 上两个服务都能启动', darwin.total === 2 && darwin.startable === 2, JSON.stringify(darwin));
ok('有 url 记为 hasUrl', darwin.hasUrl === true);
const linuxInner = context.summarizeServices(
  JSON.parse(await (await import('node:fs/promises')).readFile(join(wsNested, '.dsh', 'rotation.json'), 'utf8')), 'linux');
ok('平台映射只算当前平台', linuxInner.startable === 1, JSON.stringify(linuxInner));
ok('空卡片返回空概览', JSON.stringify(context.summarizeServices(null, 'darwin')) === JSON.stringify({ total: 0, startable: 0, hasUrl: false }));

// ── 4) /session/context 响应 ──
const fakeLogger = { warn: () => {}, info: () => {} };
const withTap = { webServer: { tapIndex: () => () => {} }, logger: fakeLogger };
const noTap = { webServer: {}, logger: fakeLogger };

const sessionContext = context.createSessionContext({ ctx: withTap, readWorkspacePath: store.workspacePathOfSession });
const mapped = await sessionContext('session-a');
ok('映射成功：project 指向 outer', mapped.ok === true && mapped.project?.id === 'outer', JSON.stringify(mapped.project));
ok('映射成功：services 概览带出来', mapped.services.total === 2 && mapped.services.startable === 2, JSON.stringify(mapped.services));
ok('映射成功：token 反映 tapIndex 可用', mapped.token === true);
ok('映射成功：panelId 是面板里的项目 key', mapped.panelId === 'card-outer-milestone', mapped.panelId);

const unmapped = await sessionContext('session-unknown');
ok('未映射：project=null 且 ok=true', unmapped.ok === true && unmapped.project === null, JSON.stringify(unmapped));
ok('未映射：services 归零', unmapped.services.total === 0 && unmapped.services.startable === 0);
ok('未映射：panelId 为空', unmapped.panelId === '');

const missing = await sessionContext('');
ok('缺 sessionId：ok=false', missing.ok === false && /sessionId/.test(missing.error), JSON.stringify(missing));

const noTapContext = context.createSessionContext({ ctx: noTap, readWorkspacePath: async () => '' });
ok('没有 tapIndex 时 token=false', (await noTapContext('session-a')).token === false);

const nested = await sessionContext('session-b');
ok('工作区存储回退也能映射到嵌套项目', nested.project?.id === 'inner', JSON.stringify(nested.project));

// 卡片坏掉不该把项目判丢
await writeFile(join(wsNested, '.dsh', 'rotation.json'), '{ broken', 'utf8');
const broken = await sessionContext('session-b');
ok('卡片坏掉仍保留 project，只是服务与 panelId 归零', broken.ok === true && broken.project?.id === 'inner'
  && broken.services.total === 0 && broken.panelId === '', JSON.stringify(broken));

await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(dshHome, { recursive: true, force: true }).catch(() => {});
await rm(ws, { recursive: true, force: true }).catch(() => {});

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} 项失败` : '\n会话上下文判定全部通过');
process.exit(failed ? 1 : 0);
