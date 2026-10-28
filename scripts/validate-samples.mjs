#!/usr/bin/env node
/**
 * 校验 samples/*.rotation.json —— 跨平台版本（替代 bash for 循环）
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCard } from '../lib/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(ROOT, 'samples');
const files = (await readdir(dir)).filter((f) => f.endsWith('.rotation.json')).sort();
let failed = 0;
for (const file of files) {
  const card = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const { errors, warnings } = validateCard(card);
  const label = file.padEnd(28);
  if (errors.length) {
    failed += 1;
    console.log(`✗ ${label} ${errors[0]}${errors.length > 1 ? `（共 ${errors.length} 条）` : ''}`);
  } else {
    console.log(`✓ ${label}${warnings.length ? ` · ${warnings.length} 条警告` : ''}`);
  }
}
console.log(failed ? `\n${failed} 个样例未通过` : `\n全部 ${files.length} 个样例通过`);
process.exit(failed ? 1 : 0);
