#!/usr/bin/env node
/**
 * 提交前的完整自检（跨平台）：
 * lint → client 契约 → 会话 mock → 动作链路 mock（/plan → /goal → 提炼）→ 面板 stale 会话 → 样例校验 → 打包含内容
 * 用临时 ROTATION_HOME / MOCK_WS 与随机端口，避免污染真实注册表。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Windows 上 npm 是 .cmd，Node 22 起不允许不带 shell 直接 spawn（EINVAL）
const shell = process.platform === 'win32';
const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell, env: { ...process.env, ...env } });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
});
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const home = await mkdtemp(join(tmpdir(), 'rotation-home-'));
const ws = await mkdtemp(join(tmpdir(), 'rotation-ws-'));
const port = String(4100 + Math.floor(Math.random() * 800));
let ok = true;
try {
  console.log('── lint:plugin ──');
  await run(npm, ['run', 'lint:plugin']);
  console.log('── mock:client ──');
  await run(npm, ['run', 'mock:client']);
  console.log('── mock:session ──');
  await run('node', ['scripts/dev-session-mock.mjs'], { ROTATION_HOME: home, MOCK_WS: ws, PORT: port });
  console.log('── mock:idea-lock ──');
  await run('node', ['scripts/idea-lock-mock.mjs'], { PORT: String(Number(port) + 2) });
  console.log('── mock:action ──');
  await run(npm, ['run', 'mock:action'], { PORT: String(Number(port) + 1) });
  console.log('── mock:prompt ──');
  await run(npm, ['run', 'mock:prompt']);
  console.log('── mock:registry ──');
  await run(npm, ['run', 'mock:registry']);
  console.log('── mock:services ──');
  await run(npm, ['run', 'mock:services'], { PORT: String(Number(port) + 3) });
  console.log('── mock:stale-run ──');
  await run(npm, ['run', 'mock:stale-run']);
  console.log('── validate:samples ──');
  await run(npm, ['run', 'validate:samples']);
  console.log('── verify:tarball ──');
  await run(npm, ['run', 'verify:tarball']);
  console.log('\n全部通过：可以提交/打包');
} catch (error) {
  ok = false;
  console.error('\n自检失败：' + error.message);
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(ws, { recursive: true, force: true }).catch(() => {});
}
process.exit(ok ? 0 : 1);
