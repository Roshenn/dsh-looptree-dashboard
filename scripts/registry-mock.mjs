#!/usr/bin/env node
/**
 * scripts/registry-mock.mjs — 验证注册表在多台机器之间同步时不会互相卡死（不需要 DSH）。
 *
 *   node scripts/registry-mock.mjs
 *
 * 背景：~/.dsh 走 git 同步，registry.json 是共享文件，但 workspace 是各机器的绝对路径。
 * 另一台机器写进来的条目在本机读不到——既不该显示，也不该占住 id / 目录。
 *
 * 覆盖：
 *   · 别的机器条目不出现在本机项目列表里
 *   · id 与别的机器条目重名时，本机项目能添加成功（就是「项目 id 已存在」那个硬阻断）
 *   · 写回注册表时保留别的机器条目
 *   · 本机真项目重复 id / 重复目录仍然 409
 *   · 本机登记但卡片丢了 → 接管，注册表不留重复 id
 *   · 移除只删本机条目
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'rotation-registry-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-registry-ws-'));
const ws2 = await mkdtemp(join(tmpdir(), 'rotation-registry-ws2-'));
const deadWs = await mkdtemp(join(tmpdir(), 'rotation-registry-dead-'));
process.env.ROTATION_HOME = home;

const store = await import('../lib/store.mjs');

const FOREIGN = { id: 'english-shadow', name: 'english-shadow', workspace: 'I:\\dev\\business\\english-shadow', file: 'english-shadow.rotation.json' };
const REGISTRY = join(home, 'registry.json');
const readReg = async () => JSON.parse(await readFile(REGISTRY, 'utf8'));
let failed = 0;

function check(ok, label, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed += 1;
}

async function expectError(fn, status, keyword) {
  try {
    await fn();
    return null;
  } catch (error) {
    return { status: error.status, message: error.message, keyword: keyword ? error.message.includes(keyword) : true };
  }
}

// 本机真项目：卡片已经存在（不能被模板覆盖）
await mkdir(join(ws, '.dsh'), { recursive: true });
await writeFile(join(ws, '.dsh', 'rotation.json'), JSON.stringify({
  schema: 'rotation/v1',
  project: { name: '本机 english-shadow', workspace: ws },
  milestone: { id: 'local-milestone', kind: 'milestone', title: '本机卡片', children: [] },
}, null, 1));

await writeFile(REGISTRY, JSON.stringify([FOREIGN], null, 1));

check((await store.listProjects()).length === 0, '别的机器条目不出现在本机项目列表');

const added = await store.addProject({ name: 'english-shadow', workspace: ws }).catch((error) => error);
check(!(added instanceof Error), 'id 与别的机器条目重名时能添加', added instanceof Error ? added.message : '');
check(added && added.id === 'english-shadow', '添加后的项目 id 正确');

const reg = await readReg();
check(reg.some((p) => p.workspace === FOREIGN.workspace), '写回时保留别的机器条目');
check(reg.some((p) => p.workspace === ws), '本机条目已写入');

const card = JSON.parse(await readFile(join(ws, '.dsh', 'rotation.json'), 'utf8'));
check(card.milestone.id === 'local-milestone', '已有卡片没有被模板覆盖');

const local = await store.listProjects();
check(local.length === 1 && local[0].workspace === ws, '本机项目列表只留本机条目');

const dupId = await expectError(() => store.addProject({ name: 'english-shadow', workspace: ws2 }), 409, '项目 id 已存在');
check(dupId && dupId.status === 409 && dupId.keyword, '本机真项目重复 id 仍然 409');

const dupWs = await expectError(() => store.addProject({ name: 'whatever', workspace: ws }), 409, '该目录已登记');
check(dupWs && dupWs.status === 409 && dupWs.keyword, '同目录重复注册仍然 409');

// 本机登记但卡片丢了：同 id 重新注册应当接管，不留两条
await writeFile(REGISTRY, JSON.stringify((await readReg()).concat([{ id: 'old-dead', name: 'old-dead', workspace: deadWs, file: 'old-dead.rotation.json' }]), null, 1));
await store.addProject({ name: 'old-dead', workspace: deadWs }).catch((error) => error);
const regAfter = await readReg();
check(regAfter.filter((p) => p.id === 'old-dead').length === 1, '卡片丢失的本机条目被接管，不留重复 id');

const beforeRemove = (await readReg()).length;
await store.removeProject('english-shadow').catch((error) => error);
const regRemoved = await readReg();
check(regRemoved.length === beforeRemove - 1, '移除本机项目后条目数减一');
check(regRemoved.some((p) => p.workspace === FOREIGN.workspace), '移除不动别的机器条目');

if (failed) {
  console.error(`\n注册表 mock 失败 ${failed} 项`);
  process.exit(1);
}
console.log('\n注册表 mock 全部通过');
