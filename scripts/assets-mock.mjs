#!/usr/bin/env node
/**
 * scripts/assets-mock.mjs — 附件上传 / 读取 / 校验的 host 级断言（不需要 DSH）。
 *
 *   node scripts/assets-mock.mjs
 *   PORT=4211 node scripts/assets-mock.mjs
 *
 * 口径（详见 rotation-card-spec.md「附件」节）：
 *   · 上传走 dataUrl → 内容寻址存 <workspace>/.dsh/rotation-assets/<sha>.<ext>；
 *   · 同字节去重；GET 只认 sha，不接收路径；只认 png / jpeg / webp；
 *   · 卡片校验：path 必须由 sha + mime 推出，条数 ≤ 12，超大 / 非图 / 越界一律拦住。
 * 仿 stamp-mock：假 ctx + 真 http + 临时 ROTATION_HOME / 工作区。
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4211);
const BASE = '/rotation';
const ORIGIN = `http://127.0.0.1:${PORT}`;

const home = await mkdtemp(join(tmpdir(), 'rotation-assets-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-assets-ws-'));
process.env.ROTATION_HOME = home;
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');
const store = await import('../lib/store.mjs');

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

const handlers = new Map();
const routes = [];
const ctx = {
  logger: { info() {}, warn() {}, error: () => {} },
  /** 真宿主上由 connection 服务做 Host/Origin 校验 + 浏览器会话；假宿主一律视为已授权 */
  connection: { requestRejection: () => undefined },
  webServer: { register(options) { routes.push(options); return () => routes.splice(routes.indexOf(options), 1); } },
  effect(fn) { return fn(); },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event).delete(handler);
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-model' }) },
  sessions: { get: () => null },
};
apply(ctx, { basePath: BASE });

const project = await store.addProject({ id: 'assetsmock', name: '附件 mock', workspace: ws });
const cardPath = store.cardPathOf(project);
const file = project.file;

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch((e) => { res.writeHead(500); res.end(String(e)); });
});

const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const postAsset = async (body) => {
  const res = await fetch(`${ORIGIN}${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const getAsset = (sha, key = file) => fetch(
  `${ORIGIN}${BASE}/api/assets?file=${encodeURIComponent(key)}&sha=${encodeURIComponent(sha)}`,
);
const putCard = async (card) => {
  const res = await fetch(`${ORIGIN}${BASE}/api/cards/${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card, allowIncomplete: true }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });

  /* 1. 上传：内容寻址 + 落盘 */
  const up = await postAsset({ file, nodeId: 'cap-1', name: 'dot.png', dataUrl: PNG_1X1 });
  const att = (up.body && up.body.attachment) || {};
  check('POST /api/assets → 200', up.status === 200 && up.body?.ok === true, JSON.stringify(up.body));
  check(
    '返回内容寻址元数据（sha / path / bytes）',
    /^[a-f0-9]{64}$/.test(String(att.sha || ''))
      && att.path === `.dsh/rotation-assets/${att.sha}.png`
      && att.bytes > 0,
    JSON.stringify(att),
  );
  const assetDir = join(ws, '.dsh', 'rotation-assets');
  const disk = await readFile(join(ws, att.path || '')).catch(() => null);
  check('文件落在 .dsh/rotation-assets/', !!disk && disk.length === att.bytes, join(ws, att.path || ''));

  /* 2. 去重 */
  const dup = await postAsset({ file, name: 'dot-again.png', dataUrl: PNG_1X1 });
  check('重复上传同字节 → 同 sha', dup.status === 200 && dup.body?.attachment?.sha === att.sha, JSON.stringify(dup.body?.attachment));
  const files = await readdir(assetDir).catch(() => []);
  check('去重后只存一份文件', files.length === 1, files.join(','));

  /* 3. 读取 */
  const got = await getAsset(att.sha);
  const buf = Buffer.from(await got.arrayBuffer());
  check('GET /api/assets → 200 image/png', got.status === 200 && got.headers.get('content-type') === 'image/png', `${got.status} ${got.headers.get('content-type')}`);
  check(
    '字节一致 + immutable 缓存',
    buf.length === att.bytes && /immutable/.test(got.headers.get('cache-control') || ''),
    `${buf.length} / ${got.headers.get('cache-control')}`,
  );

  /* 4. 非法 sha / 路径穿越 */
  const badSha = await getAsset('../x');
  check('GET 非法 sha → 400', badSha.status === 400, `HTTP ${badSha.status}`);
  const badSha2 = await getAsset('z'.repeat(64));
  check('GET 非 hex 的 64 位串 → 400', badSha2.status === 400, `HTTP ${badSha2.status}`);

  /* 5. 文件不存在 */
  const missing = await getAsset('a'.repeat(64));
  check('GET 不存在的附件 → 404 JSON', missing.status === 404 && (await missing.json().catch(() => null))?.ok === false, `HTTP ${missing.status}`);

  /* 6. 非白名单类型 */
  const gif = await postAsset({ file, name: 'x.gif', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' });
  check('POST GIF → 415', gif.status === 415, JSON.stringify(gif.body));

  /* 7. 超过 8MB */
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8 * 1024 * 1024)]);
  const tooBig = await postAsset({ file, name: 'big.png', dataUrl: 'data:image/png;base64,' + big.toString('base64') });
  check('POST > 8MB → 413', tooBig.status === 413, JSON.stringify(tooBig.body));

  /* 8. 卡片校验：合法附件 / 伪造 path */
  const card = JSON.parse(await readFile(cardPath, 'utf8'));
  card.milestone.children = [{
    id: 'cap-1', kind: 'capability', title: '图片能力', status: 'doing', closed_at: null,
    children: [], attachments: [att],
  }];
  const put = await putCard(card);
  check('PUT 卡带合法附件 → 200', put.status === 200 && put.body?.ok === true, JSON.stringify(put.body?.errors || put.body?.error));
  const bad = JSON.parse(JSON.stringify(card));
  bad.milestone.children[0].attachments[0].path = '.dsh/rotation-assets/../../evil.png';
  const badPut = await putCard(bad);
  check('PUT 伪造 path → 422', badPut.status === 422 && /path/.test(JSON.stringify(badPut.body?.errors || '')), `HTTP ${badPut.status} ${JSON.stringify(badPut.body?.errors)}`);

  /* 9. 里程碑挂附件：放行但警告 */
  const msCard = JSON.parse(await readFile(cardPath, 'utf8'));
  msCard.milestone.attachments = [att];
  const msPut = await putCard(msCard);
  check(
    '里程碑挂附件 → 200 + 警告',
    msPut.status === 200 && String((msPut.body?.warnings || []).join(' ')).includes('只有能力闭环与执行记录挂附件'),
    `HTTP ${msPut.status} ${JSON.stringify(msPut.body?.warnings)}`,
  );

  /* 10. 未注册项目 */
  const unknown = await postAsset({ file: 'nope.rotation.json', dataUrl: PNG_1X1 });
  check('未注册项目上传 → 404', unknown.status === 404, `HTTP ${unknown.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `\n${failed.length} 项失败` : '\n附件接口全部通过');
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error('[mock] 失败：' + (error && error.stack ? error.stack : error));
  server.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
