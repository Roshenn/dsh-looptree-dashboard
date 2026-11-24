# UI 用户评审（六席）

用 6 个互斥、挑剔的「用户」盲评同一份证据，出排序结论 + 台账，按「审 → 修 top 3 → 复检」闭环推进。机制本身在全局 skill：`~/.dsh/skills/ui-user-panel/`（`SKILL.md` 是入口）。

## 1. 跑一轮

```bash
# 取证（起 serve.mjs + agent-browser + ffmpeg，约 1–2 分钟）
npm run evidence:ui -- --slug panel

# 若已有服务：直接给 URL
node scripts/ui-evidence.mjs --url http://127.0.0.1:4173/ --slug panel
```

产物在 `~/.dsh/outbox/gate/<YYYY-MM-DD>-panel/`：`shots/`、`state/`、`motion/`、`motion/frames/`、`snapshot/`、`metrics.json`、`MANIFEST.json`。

> 脚本永远退 0：证据是否完整以 `MANIFEST.json` 的 `failures` 与 `notes` 为准。取证失败时不许用旧图、不许脑补。

## 2. 评审与合成

按 `~/.dsh/skills/ui-user-panel/SKILL.md` §2 调 `workflow`；合成后把 `panel.json` 与 `REPORT.md` 放在

```
docs/ui-review/<YYYY-MM-DD>-panel/
├── REPORT.md            # 人读：结论 / top3 / 全表 / 冲突 / 覆盖 / 正交审计 / 复检
├── panel.json           # 机器：六席原始输出 + audit
├── metrics.json         # 取证快照（从 outbox 复制，供报告引用稳定）
└── shots/               # 只放 top3 改前改后裁剪图（大图留在 outbox）
```

## 3. 台账

- 文件：`docs/ui-review/ledger.json`，schema 见 `~/.dsh/skills/ui-user-panel/contracts/ledger.schema.json`。
- `key = sha1(region|locus|fact)` 跨轮稳定，`id` 一经分配不改。
- 状态只有：`open` / `fixed` / `wontfix` / `waived`；`waived` 到期自动回 `open`。
- 没修又不想修 = `wontfix` 或 `waived`，**不许从台账里删掉**。

## 4. 修复规则

| 类别 | 判据 | 流程 |
| --- | --- | --- |
| `defect-fix` | 命中可测标准（对比度/目标尺寸/焦点/320px 溢出/假动效/reduced-motion 缺口）或文案与行为矛盾 | 直接修 + 改前改后同视口同状态对照图 |
| `design-change` | 改布局骨架、配色语言、动效性格 | 必须走 `界面与动效.md` §0.1 三套方案 + 用户选定 |

修完 `npm run preflight` 必须绿；一次逻辑改动一个 commit，不 `git add -A`，不 push。

## 5. 成本

- 取证 1–2 分钟（一次性）。
- 六席盲评 5–10 分钟；合成 10 分钟；复检 10 分钟。
- 单轮 token 以实际记录为准：每席 brief ≤1200 字 + ≤4 张图；超限就裁剪，不加图。
