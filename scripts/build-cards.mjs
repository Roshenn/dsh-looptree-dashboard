#!/usr/bin/env node
/**
 * build-cards.mjs — 把 samples/*.rotation.json 打包成 web/cards.js
 * （供面板 file:// 直接加载；npm run build:cards 从仓库根跑）
 *
 * 用法：node scripts/build-cards.mjs [样节目录] [输出文件]
 * 默认路径按仓库根解析，不依赖当前工作目录（以前默认 '../web/cards.js' 会写到仓库外）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] || join(ROOT, 'samples');
const out = process.argv[3] || join(ROOT, 'web', 'cards.js');
if (!existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(2); }
const label = relative(ROOT, dir) || dir;

const files = readdirSync(dir).filter((f) => f.endsWith('.rotation.json')).sort();
const cards = [];
for (const f of files) {
  try {
    cards.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  } catch (e) {
    console.error(`跳过 ${f}: ${e.message}`);
  }
}
writeFileSync(out, `/* 由 build-cards.mjs 生成，勿手改。源：${label}/ */\nwindow.ROTATION_CARDS = ${JSON.stringify(cards, null, 1)};\n`);
console.log(`${out}: ${cards.length} 张卡（${files.join(', ')}）`);
