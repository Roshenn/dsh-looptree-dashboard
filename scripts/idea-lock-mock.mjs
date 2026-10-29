#!/usr/bin/env node
/**
 * scripts/idea-lock-mock.mjs — 用假 ctx 验证「一个目标只能有一个构思」（不需要 DSH）。
 *
 *   node scripts/idea-lock-mock.mjs
 *
 * 覆盖：
 *   · 候选池采纳 1 条后目标锁定，其余候选被清空
 *   · 锁定后再采纳 / 再生成候选 → 409 IDEA_EXISTS
 *   · PUT 给目标加第二个构思 → 422；旧卡里已有的多条原地保存不拦
 *   · 迁移脚本保留第一条，其余进 <卡片>.single-idea-backup.json
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4191);
const BASE = '/rotation';

const home = await mkdtemp(join(tmpdir(), 'rotation-idea-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-idea-ws-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');
const store = await import('../lib/store.mjs');

const handlers = new Map();
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
  webServer: { register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); } },
  effect(fn) { return fn(); },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
  agents: {
    async create({ sessionId }) {
      return { agent: { id: sessionId, async followup() {}, interrupt() {} } };
    },
  },
};
apply(ctx, { basePath: BASE });

const cardPathOf = (entry) => store.cardPathOf(entry);
const candidatePath = (file, nodeId) => join(store.DSH_HOME, 'rotation', 'candidates', `${String(file).replace(/[^\w.-]/g, '_')}__${nodeId}.json`);
const seedCandidates = async (file, nodeId, list) => {
  const path = candidatePath(file, nodeId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(list, null, 1) + '\n', 'utf8');
  return path;
};
const baseCard = () => ({
  schema: 'rotation/v1',
  project: { name: 'IdeaMock', workspace: ws },
  updated: null,
  loop: {
    id: 'im-loop', kind: 'loop', title: '验证一个目标一个构思',
    intent: '一个目标只能有一个构思', acceptance: 'CLI 断言全绿',
    status: 'plan', closed_at: null,
    children: [{
      id: 'im-g1', kind: 'goal', title: '目标一', acceptance: '命令通过',
      status: 'plan', closed_at: null, children: [],
    }],
  },
});
const ideaOf = (id, title) => ({ id, kind: 'idea', title, status: 'plan', closed_at: null, children: [] });

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); });
});

const fetchJson = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${BASE}/api${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const putCard = async (entry, card) => fetchJson(`/cards/${encodeURIComponent(entry.id)}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }),
});

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

server.listen(PORT, '127.0.0.1', async () => {
  try {
    const project = await store.addProject({ id: 'ideamock', name: 'IdeaMock', workspace: ws });
    const file = project.file;

    // 1) 初始：目标下没有构思；候选池 3 条互斥备选，每条带 strength
    const init = await putCard(project, baseCard());
    check('初始卡片可写', init.status === 200, JSON.stringify(init.body));
    await seedCandidates(file, 'im-g1', [
      { title: '路线 A', strength: '上手最快，今天就能验证', acceptance: 'npm run preflight 绿' },
      { title: '路线 B', strength: '复用现有校验器，改动面最小', acceptance: 'validate:samples 绿' },
      { title: '路线 C', strength: '风险最低，不碰写入路径', acceptance: '断点写盘测试通过' },
    ]);

    // 2) 采纳第一条 → 锁定，其余候选清空
    const adopted = await fetchJson('/candidates/adopt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, nodeId: 'im-g1', index: 0 }),
    });
    check('采纳第一条返回 200 + locked', adopted.status === 200 && adopted.body?.locked === true, JSON.stringify(adopted.body));
    check('采纳后 candidate 池清空（remaining=0）', adopted.body?.remaining === 0);
    const after = JSON.parse(await readFile(cardPathOf(project), 'utf8'));
    const goal = after.loop.children[0];
    check('目标下只有 1 个构思', (goal.children || []).filter((k) => k.kind === 'idea').length === 1, JSON.stringify(goal.children?.map((k) => k.kind)));
    const poolAfter = JSON.parse(await readFile(candidatePath(file, 'im-g1'), 'utf8'));
    check('候选文件清空', Array.isArray(poolAfter) && poolAfter.length === 0);

    // 3) 锁定后再采纳 / 再生成 → 409 IDEA_EXISTS
    await seedCandidates(file, 'im-g1', [{ title: '路线 B', strength: '晚到的一条' }]);
    const adoptAgain = await fetchJson('/candidates/adopt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, nodeId: 'im-g1', index: 0 }),
    });
    check('锁定后再采纳 → 409 IDEA_EXISTS', adoptAgain.status === 409 && adoptAgain.body?.code === 'IDEA_EXISTS', JSON.stringify(adoptAgain.body));
    const genAgain = await fetchJson('/candidates/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, nodeId: 'im-g1' }),
    });
    check('锁定后再生成候选 → 409 IDEA_EXISTS', genAgain.status === 409 && genAgain.body?.code === 'IDEA_EXISTS', JSON.stringify(genAgain.body));

    // 4) PUT 加第二个构思 → 422；旧卡原地保存不拦
    const withSecond = JSON.parse(await readFile(cardPathOf(project), 'utf8'));
    withSecond.loop.children[0].children.push(ideaOf('im-g1-i2', '路线 B'));
    const putSecond = await putCard(project, withSecond);
    check('PUT 加第二个构思 → 422 IDEA_EXISTS', putSecond.status === 422 && putSecond.body?.code === 'IDEA_EXISTS', JSON.stringify(putSecond.body));

    const legacy = JSON.parse(await readFile(cardPathOf(project), 'utf8'));
    legacy.loop.children[0].children.push(ideaOf('im-g1-l1', '旧构思一'), ideaOf('im-g1-l2', '旧构思二'));
    await store.writeCard(project, legacy, { lenient: true });
    const putLegacy = await putCard(project, JSON.parse(await readFile(cardPathOf(project), 'utf8')));
    check('旧卡（已有多条构思）原地保存不拦', putLegacy.status === 200, JSON.stringify(putLegacy.body));

    // 5) 迁移脚本：保留第一条，其余进备份文件
    const migrate = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts/migrate-single-idea.mjs'), '--write'], {
        cwd: ROOT,
        env: { ...process.env, ROTATION_HOME: home, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
    const migrated = JSON.parse(await readFile(cardPathOf(project), 'utf8'));
    const ideasNow = (migrated.loop.children[0].children || []).filter((k) => k.kind === 'idea');
    check('迁移脚本退出码 0', migrate.code === 0, migrate.out.trim().slice(0, 300));
    check('迁移后目标只剩 1 个构思', ideasNow.length === 1, ideasNow.map((k) => k.title).join(','));
    const backup = JSON.parse(await readFile(cardPathOf(project) + '.single-idea-backup.json', 'utf8'));
    check('移出的构思进备份文件', Array.isArray(backup) && backup[0]?.moved?.length === 2, JSON.stringify(backup).slice(0, 200));
  } catch (error) {
    failures += 1;
    console.error('[idea-lock-mock] 异常：' + (error && error.stack || error));
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(ws, { recursive: true, force: true }).catch(() => {});
    console.log(failures ? `\n[idea-lock-mock] FAIL（${failures} 项）` : '\n[idea-lock-mock] PASS');
    process.exit(failures ? 1 : 0);
  }
});
