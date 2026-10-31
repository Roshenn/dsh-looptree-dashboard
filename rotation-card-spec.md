# 里程碑树卡 · 数据规范 v1（`rotation/v1`）

> 一句话：**每个工作区一个 `.dsh/rotation.json`，里面是一棵 `milestone → support → exec` 的树；
> 项目用**项目愿景**说清最终要变成什么，里程碑用**里程碑愿景**说它把项目带到哪，用**重要支撑**说清要什么才成立，
> 核心指标只挂在支撑项上（做到什么程度算撑住里程碑），
> 用**重要支撑**说清「要什么才能让愿景成立」；每条支撑项再带自己的**核心指标**（到什么程度算撑住里程碑）与
> **实现思路**，落地过程写成执行记录；关闭只能自下而上、由人确认。**

## 关键要素（Key Elements）

- **文件位置**：`<workspace>/.dsh/rotation.json` —— 跟项目走，进 git，换机器/换分支不丢。
- **树根**：`milestone` 节点唯一，代表「当前里程碑」；一个工作区同一时间只有一个活跃里程碑。
- **节点类型**：`milestone` / `support` / `exec`，三类对应面板三列（里程碑 / 支撑项 / 执行验证反馈）。
  - `milestone`：深度 1，唯一；承载里程碑愿景与重要支撑（核心指标不在这里，在支撑项上）；
  - `support`（支撑项）：深度 2，只挂在里程碑下；是「要什么才能让愿景成立」的承载，后面由它开计划与执行；
  - `exec`（执行验证反馈记录）：深度 3+，只挂在支撑项下；一次会话一条。
  （2026-10-31 由 `milestone → goal → idea → exec` 四层收敛而来：`goal` / `idea` 两种 kind 退役，
  旧卡读入即折叠成 `support`，见「旧卡兼容与迁移」。）
- **关闭状态**：`closed_at`（ISO 时间或 `null`）——**只有它代表关闭**，`status` 不代表。
  面板显示里程碑「已达成」、支撑项「已闭环」= `closed_at` 非空。
  **里程碑必须人工点「确认达成」才写 `closed_at`**；支撑项在已有执行记录时随记录全闭环自动收口，
  还没有执行记录时显示「完成」由人手动收口。
  里程碑「确认达成」的闸门 = **至少 1 个支撑项子节点 + 子项全部闭环**——
  不再看 `supports` 是否非空：重要支撑是规划输入，不是关闭条件（2026-10-31 改）。
- **状态（面板展示，自动流转）**：五种，全部由结构派生，不需要也不允许手改。
  「子节点」分两类：工作子节点（milestone → support）与执行记录（`exec`）；
  支撑项的状态看记录：
  - `未开始`：只有标题，没有任何内容字段；
  - `规划中`：有内容（里程碑愿景 / 重要支撑 / 支撑项核心指标 / 实现思路任一非空），
    但还没有工作子节点 / 执行记录（支撑项只生成过计划、没执行过，仍算规划中）；
  - `进行中`：里程碑有支撑项未全部关闭；或支撑项已出现过执行记录、记录还没全闭环；
  - `待确认达成`：里程碑的子项已全部关闭但人还没确认（**不会自动关闭**）；
  - `已达成 / 已闭环`：`closed_at` 非空（里程碑「已达成」，支撑项「已闭环」）。
  写卡片时 `status` 自动同步为 `plan` / `doing` / `done`：未开始 / 规划中写 `plan`，进行中 / 待确认写 `doing`，
  已关闭写 `done`；仅为兼容 schema，不承载状态语义。
- **里程碑历史**：卡片可选字段 `closed_milestones[]`，存已达成里程碑的**压缩快照**（保留 id / kind / title / status /
  closed_at / vision / metrics / supports / verify / proof / issues / lessons / children；旧快照里的退役字段原样保留；
  丢掉 session、计划全文等运行时字段）。
  最多 10 条（超出丢最旧；单条体积超限也丢最旧）；随项目 git 走；旧卡片若 `milestone.closed_at` 非空但没有对应条目，
  面板进面板时会补一条（下次写盘落下来）。重开当前里程碑会移除同 id 历史条目，开新里程碑则把旧里程碑留在历史。
- **项目愿景字段**：`project.vision` —— 项目层的第一字段（≤1000 字）：这个项目最终要变成什么样，里程碑愿景都要能挂上来。
  入口是面板项目名右侧 **⋯ → 项目信息**，弹窗里就地编辑；只进里程碑「生成」的 prompt 背景，不进其它节点。
- **里程碑愿景字段**：`milestone.vision` —— 里程碑的**第一字段、最重要的信息**：这个里程碑之后项目/用户变成什么样
  （3–6 句宏大叙事，≤1000 字；不写功能清单、不写工期、不写实现手段）。
- **重要支撑字段**：`milestone.supports` —— 回答「要什么才能让这个里程碑愿景成立」：3–5 条、一条一行、共 ≤300 字，
  **按重要性排序**，从第一性原理写必需要素（不是待办清单、不是功能清单）。
  它是候选生成与「拆出重要支撑」的唯一输入；为空时不能生成候选支撑项（`409 SUPPORTS_REQUIRED`）。
- **支撑项（`support`）字段**：
  - `support`：承接的重要支撑条目原文（≤80 字，只读）——从 `milestone.supports` 里照抄一条，说明这条支撑项在撑什么；
  - `necessity`：必要性（≤200 字，只读）——为什么它能帮里程碑达成；
  - `causal`：因果（≤200 字，只读）——做了 A → 里程碑哪一步成立；
  - `metric`：支撑项核心指标（≤300 字，可写）——**到什么程度算这条支撑撑住了里程碑**；
  - `approach`：实现思路（≤300 字，可写）——核心思路，通俗简短；
  - `plan`：计划书（生成计划后由服务写入）；
  - `children[]`：只放 `exec` 执行记录。
  「只读三件套 + 可写两项」的分工：`support` / `necessity` / `causal` 是候选生成（或拆解）给出的**论证**，
  采纳后不改；`metric` / `approach` 是人的**判断**，采纳时留空，用「生成 2 项」补齐后才能「生成计划」。
- **核心指标只在支撑项上**（2026-10-31 从里程碑下移）：`support.metric` 衡量**这条支撑**——它做到什么程度算把里程碑撑住了。
  里程碑层不再有指标：里程碑是否达成由「重要支撑全部闭环」表达。核心指标不写测试命令；执行层面的验证命令归 `exec.verify`。
- **执行记录字段**：`exec` 不变——`action`（plan / exec / reflect）、`verify`（怎么验，一条可运行命令优先）、
  `proof`（关闭时必填的证据）、`issues[]`（问题反馈，`resolved_at` 非空才算处置）、`session`。
  只有支撑项能「生成计划 / 执行计划」：plan 前置核心指标 + 实现思路（`409 FILL_REQUIRED`）、
  exec 前置 `support.plan`（`409 PLAN_MISSING`）；执行完自动反馈提炼，把经验写进 `milestone.lessons`。
- **退役字段**：`scenario` / `constraints` / `acceptance` / `milestone.metrics` 已退役（2026-10-31 按愿景驱动收敛，
  核心指标只留支撑项 `metric`）。它们**允许留在 JSON 里**——校验器只给警告、面板不显示、不校验、不进 prompt。`goal` / `idea` 两种 kind 同样退役，旧卡读入即折叠成 `support`。
- **候选池**：`~/.dsh/rotation/candidates/<卡片文件>__<节点 id>.json`（运行时数据，不进项目 git）。
  形状 `[{ title, support, necessity, causal, importance, evidence }]`，落盘按 `importance`（1–5）降序稳定排序。
  只有里程碑能生成「候选支撑项」；采纳只写只读三件套（`support` / `necessity` / `causal`），
  `metric` / `approach` 留空，用「生成 2 项」补。候选池每行悬浮出详情卡，展示承接支撑项 / 必要性 / 因果 / 证据 / 重要性。

## 最短实现（Shortest Implementation）

1. 在工作区建 `.dsh/rotation.json`，写最小的一个里程碑 + 一条支撑项：

```json
{
  "schema": "rotation/v1",
  "project": {
    "name": "StoryWeft",
    "workspace": "/abs/path/to/storyweft",
    "vision": "作者只改情节，就能看到三层情节图同步更新，不用再读代码或对截图。"
  },
  "updated": "2026-10-31T09:00:00+08:00",
  "milestone": {
    "id": "sw-ms",
    "kind": "milestone",
    "title": "三层情节图成为唯一生产视图",
    "vision": "打开项目就能看到三层情节图，不用读代码；作者改一段情节，视觉与结构同时更新，评审不再截图对稿。",
    "supports": "1)章节→情节索引\n2)三层联动渲染\n3)首屏性能 ≤ 800ms",
    "started_at": "2026-10-31T09:10:00+08:00",
    "status": "doing",
    "closed_at": null,
    "children": [
      {
        "id": "sw-s1",
        "kind": "support",
        "title": "章节→情节索引",
        "support": "章节→情节索引",
        "necessity": "没有索引，情节图只能读内存里的临时数据，打开项目看不到真实情节，「打开即见」就不成立。",
        "causal": "索引落地后，情节图第一次能挂在真实章节上，第一层图才成立。",
        "metric": "全部章节都能被索引到，任一情节节点能双向查到所属章节，缺索引章节为 0。",
        "approach": "扫一遍章节文件生成索引，按章节 id 建双向映射，先只支持当前这一种格式。",
        "started_at": "2026-10-31T09:15:00+08:00",
        "status": "doing",
        "closed_at": null,
        "children": [
          {
            "id": "sw-s1-e1",
            "kind": "exec",
            "action": "exec",
            "title": "跑通章节索引脚本",
            "verify": "node scripts/plot-index.mjs --check",
            "started_at": "2026-10-31T09:20:00+08:00",
            "status": "doing",
            "closed_at": null
          }
        ]
      }
    ]
  }
}
```

2. 用 `node validate-rotation.mjs .dsh/rotation.json` 校验（零依赖）。
3. 面板按 `~/.dsh/storages/workspace.json` 的工作区列表，逐个读 `.dsh/rotation.json` 渲染。

## 节点字段

| 字段 | 适用 | 必填 | 说明 |
|---|---|---|---|
| `id` | 全部 | ✅ | `^[a-z0-9][a-z0-9-]*$`，全局唯一，**永不复用**（旧 id 里的 `-loop` 不改名） |
| `kind` | 全部 | ✅ | `milestone` / `support` / `exec`，必须与深度对应（1 / 2 / 3+） |
| `title` | 全部 | ✅ | 一句话，≤ 60 字，动词开头更好 |
| `status` | 全部 | ✅ | 兼容字段：`plan` / `ready` / `doing` / `blocked` / `done`；面板写入时按结构自动同步，**不要手改** |
| `closed_at` | 全部 | ✅ | ISO 时间或 `null`；**唯一关闭权威** |
| `started_at` | 全部 | ➖ | 进入执行时写；面板用它算「在途时长」与超期 |
| `project.vision` | 卡根 | ➖ | **项目愿景**：这个项目最终要变成什么样，≤1000 字；里程碑愿景要能挂上来 |
| `vision` | milestone | ✅ | **里程碑愿景**（第一字段）：这个里程碑之后项目/用户变成什么样，3–6 句宏大叙事，≤1000 字，不写功能清单与手段 |
| `supports` | milestone | ➖ | **重要支撑**：3–5 条「要什么才能让愿景成立」，一条一行、共 ≤300 字，按重要性排序，从第一性原理写 |
| `support` | support | ➖ | **承接的重要支撑条目**：照抄 `milestone.supports` 的一条原文，≤80 字，只读 |
| `necessity` | support | ➖ | **必要性**：为什么这条支撑能帮里程碑达成，≤200 字，只读 |
| `causal` | support | ➖ | **因果**：做了 A → 里程碑哪一步成立，≤200 字，只读 |
| `metric` | support | ➖ | **支撑项核心指标**：到什么程度算这条支撑撑住里程碑，≤300 字，可写 |
| `approach` | support | ➖ | **实现思路**：核心思路，通俗简短，≤300 字，可写 |
| `plan` | support | ➖ | 计划书 `{ goal, verify[], steps[], doc, at, session }`，生成计划后由服务写入 |
| `lessons` | milestone | ➖ | 经验积累 `[{ text, from?, at? }]`，执行完自动反馈提炼写入 |
| `verify` | exec | ✅ | 怎么验，一条可运行命令优先；`action: plan/reflect` 的记录例外，可不填 |
| `proof` | exec | 关闭时必填 | 证据字符串（命令输出摘要 / 路径 / commit） |
| `issues[]` | exec | ➖ | `{ "text", "at", "resolved_at?" }`，未 resolved 即阻塞 |
| `action` | exec | ➖ | `plan` / `exec` / `reflect`，一次动作会话一条记录 |
| `session` | 全部 | ➖ | 节点对应的 DSH 会话（见「节点会话」） |
| `children[]` | milestone / support | ➖ | 顺序即展示顺序；milestone 下只能放 support，support 下只能放 exec |
| `scenario` / `constraints` / `acceptance` | 已退役 | ➖ | 允许留在 JSON；只警告、不显示、不校验、不进 prompt，业务语义改用核心指标 + 实现思路 |
| `blockers` / `blocker` | 已退役 | ➖ | 读入即改名：`blockers → supports`、`blocker → support`（见迁移） |
| `goal` / `idea`（kind） | 已退役 | ➖ | 读入即折叠成 `support`（见迁移） |

### 旧卡兼容与迁移

- **读入**：`lib/core.mjs` 的 `normalizeLegacyCard`（`store.readCard` / `validateCard` / 面板 `cardToProject` 都会先跑）
  把 `loop` → `milestone`、`kind: loop` → `milestone`、`intent` → `vision`、`closed_loops` → `closed_milestones`、
  `milestone.blockers` → `milestone.supports`；`goal` / `idea` 两种 kind 折叠成 `support`：
  `goal.blocker → support.support`（承接条目），`goal` 下的 `idea` 的 `approach` / `plan` 在空时继承，
  `idea.children`（执行记录）全部上提为支撑项的子节点，`idea` 节点本身删除。
  只改名与搬运，**不丢内容**：退役的 `scenario` / `constraints` / `acceptance` 原样留在 JSON。
- **写盘**：`npm run migrate:supports` 是唯一迁移入口（默认 dry-run，只打印每张卡会怎么改；
  `--write` 才写盘）。写盘前先把**原卡整张**追加进 `<卡片>.supports-backup.json`，再原子写回；幂等——
  已经是三层支撑项结构、且没有 `blockers` / `goal` / `idea` 的卡片直接跳过。
- **`--write` 之后**：退役字段不会被删（`scenario` / `constraints` / `acceptance` 仍在 JSON 里），
  校验器只警告。需要按新口径重写时，用里程碑「生成」补 `supports`、用支撑项「生成 2 项」补
  `metric` / `approach`，旧文本（含已退役的 `metrics`）从备份文件里取。
- 更旧的 `migrate:milestone` / `migrate:blockers` / `migrate:single-idea` 保留给 0.13 之前的卡，
  正常顺序是先跑旧脚本再跑 `migrate:supports`。

### 列表字段的「一条一行」口径

`supports` 是**列表字段**：一个语义单位占一行，行首带 `1) 2) 3)` 这类序号。
三条链路共用这一条口径：

- **生成端**：`composeFillPrompt` 对这些字段的输出契约是 **JSON 字符串数组**
  （`{"supports": ["…", "…"]}`），不是一段用符号分隔的文本；prompt 同时禁止 `○ · •` 前缀与元素内换行。
- **落盘**：`lib/core.mjs` 的 `normalizeListValue()`（`lib/index.js` 回填时调用）把数组拼成
  「一条一行、每行 `N)`」，旧字符串结果也走这里兜底——元素内换行压成空格，缺序号补 `N)`。
- **编辑端**：面板 `parseItems()` 认的标记扩到 `1) A. 一、 - • ○ ◯ · ∙ ▪ ◦ ①`，
  打开编辑器会把历史上用符号写的融合块拆成多条；保存时按条目重编号。

> 2026-10-30 踩过：模型用 `○` + 单换行写了 5 条，编辑器只认编号/短横线 → 退回 plain 模式（只按空行切）
> → 5 条被当成 1 个融合块，而卡片 chips 按行数仍显示「5 条」。判据靠行数，写法必须统一。

## 服务（可选，面板用于探活与一键拉起）

```json
"services": [
  { "id": "panel",   "name": "轮转面板 4173", "url": "http://127.0.0.1:4173", "health": "/api/run-config",
    "start": { "mac": "node serve.mjs", "windows": "node serve.mjs" } },
  { "id": "web5800", "name": "本地预览 5800", "url": "http://127.0.0.1:5800",
    "start": { "mac": "python3 -m http.server 5800", "windows": "python -m http.server 5800" },
    "cwd": "/tmp/rt-workspace", "confidence": "high", "evidence": "README.md:18" }
]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 字母数字与 `-_`，卡内唯一 |
| `name` | ✅ | 信息栏里显示的名字 |
| `url` | ✅ | `http(s)://host:port/...`，**就是访问方式**；信息栏里点一下即在浏览器打开 |
| `health` | ➖ | 相对路径，探活用（拼在 url 后），缺省直接探测 url 本身 |
| `start` | ➖ | 一键拉起的命令（shell），在 `cwd` 或 `project.workspace` 下执行。字符串＝全平台共用；也可写成 `{ "mac", "windows", "linux", "default" }` |
| `stop` | ➖ | 停止命令（预留），形状同 `start` |
| `cwd` | ➖ | 启动目录，缺省用 `project.workspace`；相对路径按项目根拼，也支持平台映射 |
| `confidence` | ➖ | 仅「服务信息收集」写的出处置信度（`high` / `low`），面板展示用 |
| `evidence` | ➖ | 仅「服务信息收集」写的证据（`文件:行`），面板展示用 |

平台映射的键大小写、分隔符都收：`mac` / `darwin` / `macos`、`windows` / `win32` / `win`、`linux`、`default`。

面板侧的语义（服务块与统计都在**第一列项目列**）：

- **状态**：每 5s 由服务端探测一次（1.2s 超时）→ `运行中 / 未启动 / 启动中 / 启动失败`，带延迟毫秒。
- **打开**：直接用浏览器打开 `url`（有 `health` 时打开 `url + health`）。
- **一键拉起**：弹窗确认**平台、命令与工作目录**后 `spawn(shell)`，进程组独立，可「停止」。
- **复制地址**：复制 `url`，方便贴到别处验证。
- **项目菜单（`⋯`）**：**服务信息收集**（AI 会话读项目 → 预览探活 → 确认后写回 `services`；草稿在 `~/.dsh/rotation/services/`）
  与**移除项目**（只取消注册表登记，保留 `rotation.json`）。

## 节点会话（可选，面板写入）

节点上可挂 `session`，记录「这个节点对应的 DSH 会话」：

```json
"session": {
  "id": "session-12409905-c4cd-408b-8471-22726a34ba44",
  "status": "done",                     // idle|starting|running|done|failed|cancelled|stale
  "cwd": "/Users/julian/agentic/projects/storyweft",
  "task_id": "plan",                    // 用了哪条 prompt 模板
  "started_at": "2026-10-27T18:19:08+08:00",
  "ended_at": "2026-10-27T18:19:09+08:00",
  "exit_code": 0,
  "result": "final.text 的前 4000 字",
  "error": "失败原因（仅 failed/stale）"
}
```

- 由面板/服务写入，人不需要手写；缺这个字段的卡行为完全不变。
- `status` 非终态（starting/running）时，面板会按心跳判 `stale`（进程不在了）。
- 执行器 = `dsh --profile headless --json`，`cwd` 固定取 `project.workspace`。

## Prompt 模板（可选，存进卡里）

模板可以写进 `rotation.json`，改模板不用改代码。三层优先级：**节点级 > 卡片级（按类型）> 内置**。

```json
{
  "prompts": {
    "support": [
      { "id": "regen",   "title": "重新问这条支撑", "ask": "保留核心指标与实现思路，重新论证这条支撑为什么能撑住里程碑……" }
    ]
  },
  "milestone": {
    "id": "sw-ms", "kind": "milestone", "title": "…",
    "children": [
      { "id": "sw-s1-e1", "kind": "exec", "title": "…",
        "prompts": [ { "id": "repro", "title": "给我最小复现步骤", "ask": "列出最小复现步骤与期望/实际结果。" } ] }
    ]
  }
}
```

| 字段 | 位置 | 说明 |
|---|---|---|
| `prompts` | 卡根 | 按节点类型分组 `milestone/support/exec`，**整组替换**内置模板 |
| `prompts` | 单个节点 | 数组，**整组替换**该节点的模板（优先级最高） |
| `id` | 每条 | 字母数字与 `-` `_`，同类型内唯一 |
| `title` | 每条 | 详情卡上显示的按钮名（≤ 12 字较好） |
| `ask` | 每条 | 任务指令原文；上下文与输出要求由面板自动拼 |

详情卡会标出来源：`内置` / `rotation.json` / `节点自定义`。

### 上下文段也可配（`prompt_context`）

不写就按默认（项目 + 里程碑 / 里程碑愿景 / 核心指标 / 重要支撑 + 支撑项 / 必要性 / 因果 / 指标 / 思路 + 当前节点字段 + 子节点）。

```json
"prompt_context": {
  "fields": ["project", "milestone", "milestone.vision", "milestone.supports",
             "support", "support.necessity", "support.causal", "support.metric", "support.approach",
             "siblings", "node"],
  "siblings": 3,
  "refs": ["sw-s1-e1"]
}
```

| 字段键 | 落在哪段 | 内容 |
|---|---|---|
| `project` | 上下文 | 项目名 |
| `milestone` / `milestone.vision` / `milestone.supports` | 上下文 | 里程碑标题 / 里程碑愿景 / 重要支撑 |
| `milestone.supports` | 上下文 | 重要支撑（一条一行） |
| `support` / `support.necessity` / `support.causal` | 上下文 | 当前支撑项 / 必要性 / 因果 |
| `support.metric` / `support.approach` | 上下文 | 支撑项核心指标 / 实现思路 |
| `siblings` | 上下文 | 同级兄弟节点（条数由 `siblings` 控制，默认 0） |
| `node` | 当前节点 | 类型 / id / 标题 / 状态 |
| `node.metric` / `node.approach` / `node.necessity` / `node.causal` | 当前节点 | 当前支撑项的核心指标 / 实现思路 / 必要性 / 因果 |
| `exec.verify` / `exec.proof` / `exec.issues` | 当前节点 | 执行项的验证 / 证据 / 未处置反馈 |
| `children` | 当前节点 | 已有子节点列表（最多 8 条） |
| `refs` | 上下文 | 按 id 引用树里**任意**节点，自动带出状态与该类型的要点 |

- 旧键 `loop` / `loop.intent` / `loop.blockers` / `goal` / `goal.acceptance` / `goal.scenario` / `idea` /
  `idea.approach` / `node.acceptance` 读入即映射成 `milestone.*` / `support.*` / `node.metric`，不会报未知字段。
- `fields` 是**有序列表**，顺序即输出顺序；未知键只警告、直接跳过。
- `refs` 是节点 id 数组；写了 refs 但 fields 没列 `refs` 时，会自动补在上下文末尾。
- `refs` 里出现不存在的 id → validator 报错。

## 不变量（validator 会拦）

1. `schema` 必须为 `rotation/v1`。
2. `id` 唯一且匹配正则。
3. 深度 1 = `milestone`，深度 2 = `support`，深度 3+ 只允许 `exec`（面板折叠显示）。
4. `closed_at` 非空 ⇒ 所有子节点 `closed_at` 也非空（不许越级关闭）。
5. 非叶子节点的 `status` 由子节点推导，写进去也不生效（避免两处真源）。
6. `exec` 的 `verify` 不能为空（`action: plan/reflect` 的记录例外）；`closed_at` 非空时 `proof` 不能为空。
7. `milestone` 必须有人类的第一字段 `vision`；`support` 的 `title` 必填。退役的 `scenario` / `constraints` / `acceptance` 不再必填。
8. `issues` 只能出现在 `exec` 上。
9. 字段归属：`vision` / `supports` / `lessons` 只能挂在 `milestone`；
   `support` / `necessity` / `causal` / `metric` / `approach` / `plan` 只能挂在 `support`；
   `verify` / `proof` / `action` 只能挂在 `exec`。挂错只警告并忽略。
   长度超限只警告：`vision` >1000 字、`supports` / `metric` / `approach` >300 字、`necessity` / `causal` >200 字、`support` >80 字。
10. 退役字段（`scenario` / `constraints` / `acceptance`）与旧名字（`blockers` / `blocker` / `goal` / `idea`）：
    读入即改名或给警告，不阻断保存。
11. `started_at` 必须是 ISO 或 `null`，且**不能晚于** `closed_at`（否则在途为负）。
12. `status: doing` 且未关闭时建议带 `started_at`（缺了只警告）。
13. `prompts` 每条必须有 `id`、`title`、`ask`；未知节点类型的 `prompts.<kind>` 只警告。
14. `prompt_context.fields` 必须是已知键数组（未知键只警告）；`siblings` 需为 0–10 的整数。
15. `prompt_context.refs` 必须是节点 id 数组，且每个 id 都要能在同一张卡里找到。
16. `session.status` 必须是枚举之一；`started_at` / `ended_at` 必须是 ISO；`exit_code` 必须是整数。

## 最短实现遇到的问题与增量改进（Problems & Incremental Changes）

1. **人不想手写 JSON** → 触发条件：每次拆解都要手写嵌套结构，写错一处整棵读不出来 → 最小改动：给 agent 一个 `rotation` 工具（`add` / `close` / `reopen` / `issue_add`），人只说「加一条支撑」→ **必须现在（写插件时第一件事）**。
2. **一个工作区只能有一个活跃里程碑** → 触发条件：项目同时推进两条不相关里程碑时 → 最小改动：`milestone` 改为 `milestones[]` + `active: "<id>"`，面板顶部加切换 → **可延后**。
3. **核心指标写成文字无法自动判定** → 触发条件：想把 `closed_at` 变成自动 → 最小改动：`exec.verify` 允许 `{"cmd": "...", "expect": "exit 0"}` 结构，agent 跑完写 `proof` → **可延后**。
4. **跨会话上下文恢复还不够** → 触发条件：新会话不知道上一次关到哪 → 最小改动：会话首步注入「当前里程碑 + 重要支撑 + 可开工支撑项」摘要 → **必须现在**。
5. **拆重要支撑只出标题与承接关系** → 触发条件：拆完还要逐条补必要性 / 因果 → 最小改动：拆解输出加 `necessity` / `causal` 字段并扩预览 → **可延后**（先看支撑项候选的质量）。

## 与原型面板的对应

| 规范字段 | 面板位置 |
|---|---|
| `milestone` 根 | 第 1 列「里程碑」卡片；卡片摘要显示里程碑愿景首句，chips 显示「核心指标 N 项 / 重要支撑 N 条」 |
| `milestone.supports` | 里程碑卡 / 详情卡的只读列表；是「拆出重要支撑」与候选生成的依据 |
| `support` | 第 2 列「支撑项」，贝塞尔分支；卡片 chips 显示核心指标 / 实现思路是否已填 |
| `support.metric` / `support.approach` | 支撑项详情卡的「生成 2 项」补齐目标；缺任意一项时「生成计划」不可点（`409 FILL_REQUIRED`） |
| `support.children[]` | 第 3 列「执行验证反馈」，动作记录按 `action` 渲染成计划 / 执行 / 反馈 |
| `exec` / `issues` | 第 3 列记录卡；`issues` 渲染成卡片内红色条目 |
| 深度 ≥ 4 | 第 3 列卡片内的缩进折叠行 |
| `closed_at` 非空 | 卡片变灰 + 「重开」按钮；同级的已闭环支撑项默认折叠成「▸ 已闭环 N」；显示风格打开「隐藏已闭环」后**整颗不渲染、折叠行也不再出现**，被藏掉的数量上提成卡片 chips「已闭环 N」（已达成里程碑仍留主管）。跳转过去的那一颗临时放行（`revealedClosed`） |
| 可关闭 | 支撑项：记录全闭环自动收口；没有记录时卡上有「完成」。里程碑：「确认达成」固定在卡片 footer **左端**，与右侧「生成候选 / 候选池」同屏但分开；**都不会自动关闭** |
| 缺描述字段（`vision` / `supports`；支撑项 `metric` / `approach`） | 「生成 N 项」紧跟「确认达成 / 完成」按钮**右侧**（同一 lead 组）：**缺项 > 0 就高亮**（描边强调，不是实底橙——别和「生成候选」抢焦点），补完变灰「无缺项」。里程碑缺 2 项、支撑项缺 2 项；标题是唯一必需项，占位名（待命名）时按钮灰、只能先写标题；执行记录没有可补字段，整颗按钮不出现。详情卡同一按钮放在底部动作行 |
| 从没衍生过子节点（`children` 为空） | 里程碑「确认达成」**置灰不可点**（点一下只弹 toast 说明原因）：没有支撑项就没有可收口的分支；想结束里程碑请先进详情页删子节点。支撑项没有执行记录时显示「完成」，允许人直接结束 |
| 里程碑子项全关闭但自身未确认 | 状态「待确认达成」+ 泳道头 CTA；**闸门 = 至少 1 个支撑项子节点 + 子项全部闭环**，与 `supports` 是否非空无关 |
| `milestone.closed_at` 非空 | **留在主泳道**，lane 头显示「已达成」；菜单/泳道头可「里程碑历史 / 开新里程碑 / 重开」 |
| `closed_milestones[]` | 项目菜单 / 泳道头「里程碑历史」只读回看（列表 + 缩进树） |
| `started_at` | 信息列「在途 / 最长在途 / 平均在途」；超过 7 天在卡片上打「⏳ 在途 N 天」 |

## 悬浮详情卡展示哪些字段（候选池）

候选池每行默认只显示 `序号 + 重要性徽标 + 标题 + 承接支撑项`，悬浮（或键盘 focus）时在行旁弹出详情卡：

| 展示项 | 来源字段 | 说明 |
|---|---|---|
| 标题 | `title` | 与行内标题一致，便于对照 |
| 承接支撑项 | `support` | 照抄 `milestone.supports` 的一条，说明这条候选在撑什么 |
| 必要性 | `necessity` | 为什么它能帮里程碑达成 |
| 因果 | `causal` | 做了 A → 里程碑哪一步成立 |
| 证据 | `evidence` | 生成时对现状的复现（文件:行 / 命令输出摘要） |
| 重要性 | `importance` | 1–5，徽标显示；也是候选池的落盘排序依据（降序） |

- 详情卡是 `position: fixed`、跟随行定位，滚动 / 窗口缩放时收起。
- 字段缺失时给降级文案（例如「暂无证据」），不空白、不报错。
- 采纳后只写只读三件套 `support` / `necessity` / `causal`（空值不伪造），`metric` / `approach` 留空。

## 面板如何读取（原型已接通）

1. `node scripts/build-cards.mjs` 扫描 `samples/*.rotation.json`，生成 `cards.js`（`window.ROTATION_CARDS`）。
2. `index.html` 启动时若存在 `ROTATION_CARDS`，就按 `rotation/v1` 渲染；否则回落到内置 mock。
3. 缺的工作区信息（会话列表、轮转轨迹）留空，面板显示占位——它们在真实插件里由 DSH 会话数据补。
4. 工具栏「载入 JSON」可直接拖入任意 `rotation/v1` 文件，即时校验 schema 并追加到泳道。
5. 关闭前弹二次确认：显示类型、上级、验证/证据、未处置反馈数；取消不改变任何状态。

## 写回（双向）

- `GET /api/cards` 直接读各项目 `.dsh/rotation.json`。
- `PUT /api/cards/<file>`：先跑同一套校验，**校验不过返回 422 并拒绝落盘**；通过则写临时文件再 `rename` 原子替换。
- 面板每次关闭 / 重开 / 加节点都会写回，工具栏显示「已写入 xxx.rotation.json · 时间」。
- `file://` 打开时没有保存服务，工具栏提示「未连接保存服务 · 用「导出 JSON」保存」，导出兜底仍然可用。
