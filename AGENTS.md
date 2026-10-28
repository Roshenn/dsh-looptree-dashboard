# AGENTS.md — 本仓库的 agent 工作约定

面向在这个仓库里干活的 agent（含 DSH 里跑的会话）。规则只约束本仓库；
与用户当次明确指令冲突时，以用户指令为准。

---

## 1. 每次改动后立即提交（硬规则）

**触发**：只要动了仓库里的文件（`lib/`、`web/`、`scripts/`、`docs/`、配置、文档），
验证通过后**立刻 commit**，不要等用户说「提交」、也不要攒到一轮结束再一起提。

**粒度**：一个逻辑改动一个 commit。改两件事就提两次；同一个 feature 的多个文件可以一起提。

**格式**：Conventional Commits，标题 <72 字符，正文写清「为什么」：

```
<type>(<scope>): <一句话说清做了什么>

- 改了什么（文件 / 行为）
- 为什么（触发的问题或需求）
- 验证方式（跑了什么命令、结果如何）
```

`type` 只用：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `chore`。
`scope` 常用：`panel`（web/）、`host`（lib/）、`scripts`、`dev`、`docs`。

**提交前必做**：

1. `npm run preflight` 必须绿（约 20 秒；只改文档可跳过，但 commit 里要写明跳过原因）。
2. `git status --short` 看一眼改动清单。
3. **只 `git add` 自己动过的文件**，不要 `git add -A` / `git add .`——
   本机可能有并发会话在同一仓库里改东西，全量 add 会把别人的半成品裹进你的提交。

**明确不做**：

- 不 `git push`（推到 gitee 会同步到另一台 Mac，属对外动作；等用户明确要求再推）。
- 不改写已推送的历史：不 `--amend` 已 push 的 commit、不 `force push`。
- 不提交产物与依赖：`*.tgz`、`node_modules`、`.env`、凭据（`.gitignore` 已覆盖，别绕开）。

---

## 2. 不要用 checkout/reset 清工作区

`git checkout -- <file>`、`git reset --hard` 会**直接抹掉未提交改动**，且不可恢复。
要丢弃某处改动时：先把文件复制到仓库外备份，再改；不确定就留着别动。

（教训：2026-10-28 一次 `git checkout -- web/index.html` 抹掉了 220 行未提交改动，
靠临时副本 + 逐段重建才救回来。）

---

## 3. 改完先自检，再提交

| 改了什么 | 最低自检 |
|---|---|
| `web/*`（面板） | 刷新面板看交互；能跑 `npm run preflight` 最好 |
| `lib/*`（host 半） | 重启 DSH 让模块重新加载，再 `npm run check` |
| `scripts/*` | 直接跑那个脚本 |
| 只改文档 | 人工过一遍；可跳过 preflight |

`npm run check` 需要正在跑的 DSH：`$env:DSH_URL="http://127.0.0.1:<端口>"; npm run check`。

---

## 4. 提交示例

```bash
git add web/index.html
git commit -m "feat(panel): 「+ 目标」改为二级菜单，AI 拆目标先预览再写入

- 闭环节点「+ 目标」弹菜单：AI 拆出目标 / 手动添加
- AI 结果先预览勾选，确认后才 PUT /api/cards
- 验证：npm run preflight 绿；Playwright 6 项断言通过"

git add scripts/preflight.mjs scripts/verify-tarball.mjs
git commit -m "fix(scripts): 让 npm 调用在 Windows 上可用

- Windows 的 npm 是 .cmd，Node 22 下 spawn 需 shell
- verify-tarball 兼容 CRLF 输出"
```
