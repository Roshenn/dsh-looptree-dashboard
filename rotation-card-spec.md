# 闭环轮转卡 · 数据规范 v1（`rotation/v1`）

> 一句话：**每个工作区一个 `.dsh/rotation.json`，里面是一棵 `loop → goal → idea → exec` 的树；
> 关闭只能自下而上，`closed_at` 非空即代表「人确认过」。**

## 关键要素（Key Elements）

- **文件位置**：`<workspace>/.dsh/rotation.json` —— 跟项目走，进 git，换机器/换分支不丢。
- **树根**：`loop` 节点唯一，代表「当前闭环」；一个工作区同一时间只有一个活跃闭环。
- **节点类型**：`loop` / `goal` / `idea` / `exec`，四类对应面板四列。
- **关闭状态**：`closed_at`（ISO 时间或 `null`）——**只有它代表关闭**，`status` 不代表。
- **验收字段**：`goal.acceptance` 与 `exec.verify` —— 没有验收方式的节点不允许关闭。
- **证据字段**：`exec.proof` —— 关闭的 `exec` 必须有证据（命令输出 / 文件 / commit）。
- **反馈字段**：`issues[]` —— 只挂在 `exec` 上，`resolved_at` 非空才算处置。

## 最短实现（Shortest Implementation）

1. 在工作区建 `.dsh/rotation.json`，写最小的一个闭环：

```json
{
  "schema": "rotation/v1",
  "project": { "name": "StoryWeft", "workspace": "/abs/path/to/storyweft" },
  "updated": "2026-10-26T23:40:00+08:00",
  "loop": {
    "id": "sw-loop", "kind": "loop",
    "title": "3 情节层渲染可视化",
    "intent": "打开项目就能看到三层情节图，不用读代码",
    "acceptance": "三层各 ≥ 8 节点、可折叠、首屏 < 800ms",
    "status": "doing", "closed_at": null,
    "children": []
  }
}
```

2. 用 `node validate-rotation.mjs .dsh/rotation.json` 校验（零依赖，单文件）。
3. 面板按 `~/.dsh/storages/workspace.json` 的工作区列表，逐个读 `.dsh/rotation.json` 渲染。

## 节点字段

| 字段 | 适用 | 必填 | 说明 |
|---|---|---|---|
| `id` | 全部 | ✅ | `^[a-z0-9][a-z0-9-]*$`，全局唯一，**永不复用** |
| `kind` | 全部 | ✅ | `loop` / `goal` / `idea` / `exec`，必须与深度对应 |
| `title` | 全部 | ✅ | 一句话，≤ 60 字，动词开头更好 |
| `status` | 全部 | ✅ | `plan` / `ready` / `doing` / `blocked` / `done` |
| `closed_at` | 全部 | ✅ | ISO 时间或 `null`；**唯一关闭权威** |
| `started_at` | 全部 | ➖ | 进入执行（首次派发 / status→doing）时写；面板用它算「在途时长」与超期 |
| `intent` | loop | ✅ | 这个闭环完成意味着什么（判断是否真闭环） |
| `acceptance` | loop, goal | ✅ | 可判定的验收方式，最好能落成一条命令 |
| `approach` | idea | ➖ | 方案要点；多个 idea 并存即多方案 |
| `verify` | exec | ✅ | 怎么验，一条可运行命令优先 |
| `proof` | exec | 关闭时必填 | 证据字符串（命令输出摘要 / 路径 / commit） |
| `issues[]` | exec | ➖ | `{ "text", "at", "resolved_at?" }`，未 resolved 即阻塞 |
| `children[]` | loop, goal, idea, exec | ➖ | 顺序即展示顺序 |

## Prompt 模板（可选，存进卡里）

模板可以写进 `rotation.json`，改模板不用改代码。三层优先级：**节点级 > 卡片级（按类型）> 内置**。

```json
{
  "prompts": {
    "idea": [
      { "id": "regen",   "title": "重新生成构思（保留验收）", "ask": "保留闭环意图与目标验收，重新给出 2 个替代构思……" },
      { "id": "contract", "title": "写成接口契约",            "ask": "把这个构思写成可对接的接口契约：输入、输出、错误码……" }
    ]
  },
  "loop": {
    "id": "sw-loop", "kind": "loop", "title": "…",
    "children": [
      { "id": "sw-e4", "kind": "exec", "title": "…",
        "prompts": [ { "id": "repro", "title": "给我最小复现步骤", "ask": "列出最小复现步骤与期望/实际结果。" } ] }
    ]
  }
}
```

| 字段 | 位置 | 说明 |
|---|---|---|
| `prompts` | 卡根 | 按节点类型分组 `loop/goal/idea/exec`，**整组替换**内置模板 |
| `prompts` | 单个节点 | 数组，**整组替换**该节点的模板（优先级最高） |
| `id` | 每条 | 字母数字与 `-` `_`，同类型内唯一 |
| `title` | 每条 | 详情卡上显示的按钮名（≤ 12 字较好） |
| `ask` | 每条 | 任务指令原文；上下文与输出要求由面板自动拼 |

详情卡会标出来源：`内置` / `rotation.json` / `节点自定义`。

## 不变量（validator 会拦）

1. `schema` 必须为 `rotation/v1`。
2. `id` 唯一且匹配正则。
3. 深度 1–4 分别是 `loop` / `goal` / `idea` / `exec`；深度 ≥ 5 只允许 `exec`（面板折叠显示）。
4. `closed_at` 非空 ⇒ 所有子节点 `closed_at` 也非空（不许越级关闭）。
5. 非叶子节点的 `status` 由子节点推导，写进去也不生效（避免两处真源）。
6. `exec` 的 `verify` 不能为空；`closed_at` 非空时 `proof` 不能为空。
7. `loop`、`goal` 的 `acceptance` 不能为空。
8. `issues` 只能出现在 `exec` 上。
9. `started_at` 必须是 ISO 或 `null`，且**不能晚于** `closed_at`（否则在途为负）。
10. `status: doing` 且未关闭时建议带 `started_at`（缺了只警告：面板算不出在途）。
11. `prompts` 每条必须有 `id`（字母数字 `-_`）、`title`、`ask`；未知节点类型的 `prompts.<kind>` 只警告。

## 最短实现遇到的问题与增量改进（Problems & Incremental Changes）

1. **人不想手写 JSON** → 触发条件：每次拆解都要手写嵌套结构，写错一处整棵读不出来 → 最小改动：给 agent 一个 `rotation` 工具（`add` / `close` / `reopen` / `issue_add`），人只说「目标加一个」→ **必须现在（写插件时第一件事）**。
2. **一个工作区只能有一个活跃闭环** → 触发条件：项目同时推进两条不相关闭环时 → 最小改动：`loop` 改为 `loops[]` + `active: "<id>"`，面板顶部加切换 → **可延后**。
3. **验收方式写成文字无法自动判定** → 触发条件：想把 `closed_at` 变成自动 → 最小改动：`verify` 允许 `{"cmd": "...", "expect": "exit 0"}` 结构，agent 跑完写 `proof` → **可延后**。
4. **跨会话上下文恢复还不够** → 触发条件：新会话不知道上一次关到哪 → 最小改动：会话首步注入「当前闭环 + 阻塞 + 可关闭节点」摘要（学 `dsh-plugin-focus` 的 `agent/pre-step`）→ **必须现在**。

## 与原型面板的对应

| 规范字段 | 面板位置 |
|---|---|
| `loop` 根 | 第 1 列卡片，泳道标题旁显示「N/M 目标关闭」 |
| `goal.children` | 第 2 列，贝塞尔分支 |
| `idea` | 第 3 列 |
| `exec` | 第 4 列；`issues` 渲染成卡片内红色条目 |
| 深度 ≥ 5 | 第 4 列卡片内的缩进折叠行 |
| `closed_at` 非空 | 卡片变灰 + 「重开」按钮 |
| 可关闭（子节点全关且自身未关） | 出现「确认关闭 / 确认收敛」按钮 |
| `loop.closed_at` 非空 | 移入底部「已收敛」区 |
| `started_at` | 信息列「在途 / 最长在途 / 平均在途」；超过 7 天在卡片上打「⏳ 在途 N 天」 |

## 面板如何读取（原型已接通）

1. `node bundle-data.mjs` 扫描 `samples/*.rotation.json`，生成 `cards.js`（`window.ROTATION_CARDS`）。
2. `index.html` 启动时若存在 `ROTATION_CARDS`，就按 `rotation/v1` 渲染；否则回落到内置 mock。
3. 缺的工作区信息（会话列表、轮转轨迹）留空，面板显示占位——它们在真实插件里由 DSH 会话数据补。
4. 工具栏「载入 JSON」可直接拖入任意 `rotation/v1` 文件，即时校验 schema 并追加到泳道。
5. 关闭前弹二次确认：显示类型、上级、验证/证据、未处置反馈数；取消不改变任何状态。

## 写回（双向）

```bash
node serve.mjs          # http://127.0.0.1:4173/
```
- `GET /api/cards` 直接读 `samples/*.rotation.json`（不再需要 bundle）。
- `PUT /api/cards/<file>`：先跑同一套校验，**校验不过返回 422 并拒绝落盘**；通过则写临时文件再 `rename` 原子替换。
- 面板每次关闭 / 重开 / 加节点都会写回，工具栏显示「已写入 xxx.rotation.json · 时间」。
- `file://` 打开时没有保存服务，工具栏提示「未连接保存服务 · 用「导出 JSON」保存」，导出兜底仍然可用。
