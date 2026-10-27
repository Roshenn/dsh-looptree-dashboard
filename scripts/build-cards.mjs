#!/usr/bin/env node
/**
 * bundle-data.mjs — 把 samples/*.rotation.json 打包成 cards.js（供面板 file:// 直接加载）
 * 用法：node bundle-data.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const dir = process.argv[2] || 'samples';
const out = process.argv[3] || '../web/cards.js';
if (!existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(2); }

const files = readdirSync(dir).filter((f) => f.endsWith('.rotation.json')).sort();
const cards = [];
for (const f of files) {
  try {
    cards.push(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
  } catch (e) {
    console.error(`跳过 ${f}: ${e.message}`);
  }
}
writeFileSync(out, `/* 由 bundle-data.mjs 生成，勿手改。源：${dir}/ */\nwindow.ROTATION_CARDS = ${JSON.stringify(cards, null, 1)};\n`);
console.log(`${out}: ${cards.length} 张卡（${files.join(', ')}）`);
