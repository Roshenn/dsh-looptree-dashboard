# 里程碑树卡 · 数据规范 v1（`rotation/v1`）

> 一句话：**每个工作区一个 `.dsh/rotation.json`，里面是一棵 `milestone → goal → idea → exec` 的树；
> 里程碑用**愿景**描述要变成什么，用**阻碍项**说清现在还差什么；关闭只能自下而上、由人确认。**

## 关键要素（Key Elements）

- **文件位置**：`<workspace>/.dsh/rotation.json` —— 跟项目走，进 git，换机器/换分支不丢。
- **树根**：`milestone` 节点唯一，代表「当前里程碑」；一个工作区同一时间只有一个活跃里程碑。
- **节点类型**：`milestone` / `goal` / `idea` / `exec`，四类对应面板四列。
  （2026-10-30 由 `loop` 改名而来；旧卡由 `normalizeLegacyCard` 读入即改，见「旧卡兼容与迁移」。）
- **关闭状态**：`closed_at`（ISO 时间或 `null`）——**只有它代表关闭**，`status` 不代表。
  面板显示里程碑「已达成」= `closed_at` 非空；目标 / 构思仍叫「已闭环」。
  **里程碑必须人工点「确认达成」，目标必须人工点「确认收敛」才写 `closed_at`**；构思由会话记录全闭环自动收口
  （计划 / 执行 / 反馈都关闭且至少一次执行）。
- **状态（面板展示，自动流转）**：五种，全部由结构派生，不需要也不允许手改。
  「子节点」分两类：工作子节点（milestone → goal → idea）与会话记录（`exec` 带 `action`）；
  构思只有记录，所以它的状态看记录：
  - `未开始`：只有标题，没有任何内容字段；
  - `规划中`：有内容（愿景/阻碍项/验收/场景流程/约束任一非空），但还没有工作子节点/执行记录
    （构思只生成过计划、没执行过，仍算规划中）；
  - `进行中`：有工作子节点未全部关闭；或构思已出现过执行记录、记录还没全关闭；
  - `待确认`：里程碑叫「待确认达成」、目标叫「待确认收敛」，子项已全部关闭但人还没确认（**不会自动关闭**）；
  - `已达成 / 已闭环`：`closed_at` 非空（里程碑「已达成」，目标与构思「已闭环」）。
  写卡片时 `status` 自动同步为 `plan` / `doing` / `done`：未开始 / 规划中写 `plan`，进行中 / 待确认写 `doing`，
  已关闭写 `done`；仅为兼容 schema，不承载状态语义。
- **里程碑历史**：卡片可选字段 `closed_milestones[]`，存已达成里程碑的**压缩快照**（保留 id / kind / title / status /
  closed_at / vision / blockers / acceptance / verify / proof / issues / lessons / children；丢掉 session、计划全文等运行时字段）。
  最多 10 条（超出丢最旧；单条体积超限也丢最旧）；随项目 git 走；旧卡片若 `milestone.closed_at` 非空但没有对应条目，
  面板进面板时会补一条（下次写盘落下来）。重开当前里程碑会移除同 id 历史条目，开新里程碑则把旧里程碑留在历史。
- **愿景字段**：`milestone.vision` —— 里程碑的**第一字段、最重要的信息**：这个里程碑之后项目/用户变成什么样
  （3–6 句宏大叙事，≤500 字；不写功能清单、不写工期、不写实现手段）。
- **阻碍项字段**：`milestone.blockers` —— 回答「现在就达成这个里程碑，离愿景还差哪一步、缺什么才能跑通」，
  一条一行、3–5 条、共 ≤300 字。**非空 = 里程碑还没打通**：面板会把「确认达成」置灰（卡片 / 详情 / 泳道三处），
  清空后才放行。它不是执行层的 `issues[]`（那是单个执行项的问题反馈）。
- **落地场景流程字段**：`goal.scenario` —— 挂在**目标**上（2026-10-30 从里程碑下沉）：这个目标跑通后，
  用户从头到尾能走通的完整操作流程，三步式每步「操作 / 预期 / 体验」三行，编号 1)–N)，3–5 步；
  它是**目标验收的唯一依据**，也是拆构思的边界。
- **验收字段**：`goal.acceptance` 与 `exec.verify` —— 没有验收方式的节点不允许关闭；
  里程碑 `milestone.acceptance` 是「怎么判定愿景达成」（可观察结果 + 判定步骤）。
- **证据字段**：`exec.proof` —— 关闭的 `exec` 必须有证据（命令输出 / 文件 / commit）。
- **反馈字段**：`issues[]` —— 只挂在 `exec` 上，`resolved_at` 非空才算处置。

## 最短实现（Shortest Implementation）

1. 在工作区建 `.dsh/rotation.json`，写最小的一个里程碑：

```json
{
  "schema": "rotation/v1",
  "project": { "name": "StoryWeft", "workspace": "/abs/path/to/storyweft" },
  "updated": "2026-10-30T08:00:00+08:00",
  "milestone": {
    "id": "sw-ms",
    "kind": "milestone",
    "title": "三层情节图成为唯一生产视图",
    "vision": "打开项目就能看到三层情节图，不用读代码；作者改一段情节，视觉与结构同时更新，评审不再截图对稿。",
    "blockers": "1)缺章节→情节索引（src/plot/index.ts 无实现）→ 挡在「打开即见三层图」\n2)缺分层采样 → 挡在「首屏 < 800ms」",
    "acceptance": "三层各 ≥ 8 节点、可折叠、首屏 < 800ms",
    "status": "doing",
    "closed_at": null,
    "children": [
      {
        "id": "sw-g1",
        "kind": "goal",
        "title": "情节数据模型可用",
        "scenario": "1) 操作：改一章情节\n   预期：三层图 300ms 内更新\n   体验：不用刷新\n2) 操作：点开第二层节点\n   预期：展开三层关联\n   体验：一屏看完",
        "blocker": "缺章节→情节索引",
        "acceptance": "章节与情节两层索引可双向查询",
        "status": "doing",
        "closed_at": null,
        "children": []
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
| `kind` | 全部 | ✅ | `milestone` / `goal` / `idea` / `exec`，必须与深度对应 |
| `title` | 全部 | ✅ | 一句话，≤ 60 字，动词开头更好 |
| `status` | 全部 | ✅ | 兼容字段：`plan` / `ready` / `doing` / `blocked` / `done`；面板写入时按结构自动同步，**不要手改** |
| `closed_at` | 全部 | ✅ | ISO 时间或 `null`；**唯一关闭权威** |
| `started_at` | 全部 | ➖ | 进入执行时写；面板用它算「在途时长」与超期 |
| `vision` | milestone | ✅ | **愿景**（第一字段）：这个里程碑之后项目/用户变成什么样，3–6 句宏大叙事，≤500 字，不写功能清单与手段 |
| `blockers` | milestone | ➖ | **阻碍项**（愿景之后）：3–5 条「缺什么 → 挡在愿景哪一步 → 涉及模块/文件」，一条一行、共 ≤300 字；非空时不能「确认达成」 |
| `acceptance` | milestone, goal | ✅ | 里程碑：怎么判定愿景达成；目标：逐条对应场景流程某一步、可判定 |
| `scenario` | goal | ➖ | **落地场景流程**：这个目标跑通后用户从头到尾走一遍的步骤（操作 / 预期 / 体验，3–5 步）；目标验收的唯一依据 |
| `blocker` | goal | ➖ | **对应阻碍**：拆目标时写入的阻碍项短名（≤80 字，照抄 `milestone.blockers` 条目原文），面板只读展示 |
| `constraints` | goal | ➖ | **约束**：目标级边界（不能改的东西、时间/成本/环境限制） |
| `blocker`（旧） | — | — | 概念已并入 `goal.blocker`，没有旧字段 |
| `approach` | idea | ➖ | 方案要点；一个目标只保留一个 idea |
| `verify` | exec | ✅ | 怎么验，一条可运行命令优先 |
| `proof` | exec | 关闭时必填 | 证据字符串（命令输出摘要 / 路径 / commit） |
| `issues[]` | exec | ➖ | `{ "text", "at", "resolved_at?" }`，未 resolved 即阻塞 |
| `children[]` | 全部 | ➖ | 顺序即展示顺序 |

### 旧卡兼容与迁移

- 读入：`lib/core.mjs` 的 `normalizeLegacyCard`（`store.readCard` / `validateCard` / 面板 `cardToProject` 都会先跑）
  把 `loop` → `milestone`、`kind: loop` → `milestone`、`intent` → `vision`、`closed_loops` → `closed_milestones`、
  `prompt_context.fields` 的 `loop.*` → `milestone.*`。旧 `scenario` 保留在文件里但 UI / prompt 不再读。
- 写盘：`npm run migrate:milestone -- --write` 把旧 `scenario` 原样写进 `<卡片>.milestone-backup.json` 后删除；
  已迁移的卡片幂等跳过。**落地场景流程不自动搬到目标**——旧文本描述的是整个项目走一遍，落到单个目标会错位，
  交给目标详情卡「生成」按目标重写。

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
    "idea": [
      { "id": "regen",   "title": "重新生成构思（保留验收）", "ask": "保留里程碑愿景与目标验收，重新给出 2 个替代构思……" }
    ]
  },
  "milestone": {
    "id": "sw-ms", "kind": "milestone", "title": "…",
    "children": [
      { "id": "sw-e4", "kind": "exec", "title": "…",
        "prompts": [ { "id": "repro", "title": "给我最小复现步骤", "ask": "列出最小复现步骤与期望/实际结果。" } ] }
    ]
  }
}
```

| 字段 | 位置 | 说明 |
|---|---|---|
| `prompts` | 卡根 | 按节点类型分组 `milestone/goal/idea/exec`，**整组替换**内置模板 |
| `prompts` | 单个节点 | 数组，**整组替换**该节点的模板（优先级最高） |
| `id` | 每条 | 字母数字与 `-` `_`，同类型内唯一 |
| `title` | 每条 | 详情卡上显示的按钮名（≤ 12 字较好） |
| `ask` | 每条 | 任务指令原文；上下文与输出要求由面板自动拼 |

详情卡会标出来源：`内置` / `rotation.json` / `节点自定义`。

### 上下文段也可配（`prompt_context`）

不写就按默认（项目 + 里程碑/愿景/达成判据/阻碍 + 目标/验收/场景 + 构思 + 当前节点字段 + 子节点）。

```json
"prompt_context": {
  "fields": ["project", "milestone", "milestone.vision", "goal", "goal.acceptance", "goal.scenario", "siblings", "node"],
  "siblings": 3,
  "refs": ["sw-e4"]
}
```

| 字段键 | 落在哪段 | 内容 |
|---|---|---|
| `project` | 上下文 | 项目名 |
| `milestone` / `milestone.vision` / `milestone.acceptance` | 上下文 | 里程碑标题 / 愿景 / 达成判据 |
| `milestone.blockers` | 上下文 | 阻碍项（一条一行） |
| `goal` / `goal.acceptance` / `goal.scenario` | 上下文 | 当前目标（当前节点不是目标时才有） |
| `idea` / `idea.approach` | 上下文 | 当前构思 |
| `siblings` | 上下文 | 同级兄弟节点（条数由 `siblings` 控制，默认 0） |
| `node` | 当前节点 | 类型 / id / 标题 / 状态 |
| `node.acceptance` / `node.approach` | 当前节点 | 按节点类型显示验收或方案 |
| `exec.verify` / `exec.proof` / `exec.issues` | 当前节点 | 执行项的验证 / 证据 / 未处置反馈 |
| `children` | 当前节点 | 已有子节点列表（最多 8 条） |
| `refs` | 上下文 | 按 id 引用树里**任意**节点，自动带出状态与该类型的要点 |

- 旧键 `loop` / `loop.intent` / `loop.acceptance` / `loop.blockers` 读入即映射成 `milestone.*`，不会报未知字段。
- `fields` 是**有序列表**，顺序即输出顺序；未知键只警告、直接跳过。
- `refs` 是节点 id 数组；写了 refs 但 fields 没列 `refs` 时，会自动补在上下文末尾。
- `refs` 里出现不存在的 id → validator 报错。

## 不变量（validator 会拦）

1. `schema` 必须为 `rotation/v1`。
2. `id` 唯一且匹配正则。
3. 深度 1–4 分别是 `milestone` / `goal` / `idea` / `exec`；深度 ≥ 5 只允许 `exec`（面板折叠显示）。
4. `closed_at` 非空 ⇒ 所有子节点 `closed_at` 也非空（不许越级关闭）。
5. 非叶子节点的 `status` 由子节点推导，写进去也不生效（避免两处真源）。
6. `exec` 的 `verify` 不能为空；`closed_at` 非空时 `proof` 不能为空。
7. `milestone`、`goal` 的 `acceptance` 不能为空。
8. `issues` 只能出现在 `exec` 上。
9. `vision` 只能挂在 `milestone`、`scenario` 只能挂在 `goal`、`blockers` 只能挂在 `milestone`、`blocker` 只能挂在 `goal`
   （挂错只警告并忽略；`vision` >500 字、`blocker` >80 字给警告）。
10. `started_at` 必须是 ISO 或 `null`，且**不能晚于** `closed_at`（否则在途为负）。
11. `status: doing` 且未关闭时建议带 `started_at`（缺了只警告）。
12. `prompts` 每条必须有 `id`、`title`、`ask`；未知节点类型的 `prompts.<kind>` 只警告。
13. `prompt_context.fields` 必须是已知键数组（未知键只警告）；`siblings` 需为 0–10 的整数。
14. `prompt_context.refs` 必须是节点 id 数组，且每个 id 都要能在同一张卡里找到。
15. `session.status` 必须是枚举之一；`started_at` / `ended_at` 必须是 ISO；`exit_code` 必须是整数。

## 最短实现遇到的问题与增量改进（Problems & Incremental Changes）

1. **人不想手写 JSON** → 触发条件：每次拆解都要手写嵌套结构，写错一处整棵读不出来 → 最小改动：给 agent 一个 `rotation` 工具（`add` / `close` / `reopen` / `issue_add`），人只说「目标加一个」→ **必须现在（写插件时第一件事）**。
2. **一个工作区只能有一个活跃里程碑** → 触发条件：项目同时推进两条不相关里程碑时 → 最小改动：`milestone` 改为 `milestones[]` + `active: "<id>"`，面板顶部加切换 → **可延后**。
3. **验收方式写成文字无法自动判定** → 触发条件：想把 `closed_at` 变成自动 → 最小改动：`verify` 允许 `{"cmd": "...", "expect": "exit 0"}` 结构，agent 跑完写 `proof` → **可延后**。
4. **跨会话上下文恢复还不够** → 触发条件：新会话不知道上一次关到哪 → 最小改动：会话首步注入「当前里程碑 + 阻碍项 + 可关闭节点」摘要 → **必须现在**。
5. **拆目标同时产出场景流程** → 触发条件：拆完目标还要逐个点「生成」补场景 → 最小修改：拆目标输出加 `scenario` 字段并扩预览 → **可延后**（先看目标生成的质量）。

## 与原型面板的对应

| 规范字段 | 面板位置 |
|---|---|
| `milestone` 根 | 第 1 列「里程碑」卡片，泳道标题旁显示「N/M 目标」；卡片摘要显示愿景首句，chips 显示「阻碍 N 条」 |
| `goal.children` | 第 2 列，贝塞尔分支；卡片 chips 显示「场景 N 步」 |
| `idea` | 第 3 列 |
| `exec` | 第 4 列；`issues` 渲染成卡片内红色条目 |
| 深度 ≥ 5 | 第 4 列卡片内的缩进折叠行 |
| `closed_at` 非空 | 卡片变灰 + 「重开」按钮；同级的已闭环节点默认折叠成「▸ 已闭环 N」 |
| 可关闭（叶子 / 目标与里程碑子项全关闭） | 叶子「完成」；目标「确认收敛」；里程碑「确认达成」（**都不会自动关**） |
| 子项全关闭但自身未确认 | 状态「待确认达成」/「待确认收敛」+ 泳道头 CTA |
| `milestone.blockers` 非空 | 三处「确认达成」置灰，拦到清空为止 |
| `milestone.closed_at` 非空 | **留在主泳道**，lane 头显示「已达成」；菜单/泳道头可「里程碑历史 / 开新里程碑 / 重开」 |
| `closed_milestones[]` | 项目菜单 / 泳道头「里程碑历史」只读回看（列表 + 缩进树） |
| `started_at` | 信息列「在途 / 最长在途 / 平均在途」；超过 7 天在卡片上打「⏳ 在途 N 天」 |

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
