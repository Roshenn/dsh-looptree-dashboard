# 执行验证反馈记录（action-records/v1）

> 一句话：**构思列不再抽候选，直接开「生成计划 / 执行计划」两个手动动作；「执行验证反馈记录」列
> 只用来看落地过程——每次会话一条记录、带实时状态；任务跑完自动提炼经验写进闭环。**

## 一、为什么改

原来「构思」节点的下缘是 `生成候选 / 候选池`：先让模型吐一批候选执行项，人挑一个写进树。
构思本身就是**实现的核心思路**，执行记录是它落地的过程，中间那层候选池只是多一次点击。

落地过程不再由面板自建编排器（波次、重试、tasks.json）驱动，而是**交给 DSH 自己的
`/plan` 与 `/goal`**：面板只负责

1. 建会话、把动作翻译成斜杠命令；
2. 记录会话状态；
3. 会话结束后回写计划与经验。

## 二、三个动作

| 动作 | 触发 | 对 DSH 做的事 | 产出 |
|---|---|---|---|
| 生成计划 | 手动（构思卡） | 起会话（挂 DSH 默认 agent preset）→ `/plan` → 发计划任务；agent 用 exit_plan_mode 交计划，**拿到计划就中断审批回合（不执行）** | `idea.plan`（目标 / 验证命令 / 步骤 / 全文） |
| 执行计划 | 手动（构思卡） | 同一会话 `/plan off` → `/goal <objective>`，由 goal 轮次驱动执行 | 执行记录 + 会话结果 |
| 反馈提炼 | 自动（执行记录 done 后） | 同一会话追问「复盘踩坑，只输出 JSON」 | `loop.lessons[]`（闭环经验积累） |

### 会话 preset：`/plan`、`/goal`、`exit_plan_mode` 从哪来

它们都是 DSH 挂在 **agent preset** 里的插件，不是 profile 根上的全局工具。所以 runner 建
plan / exec 会话时必须挂 preset（`ctx.get('agentPresets').resolve()` 取默认 preset，再
`mount()` 到 agent ctx，同时把 `agentPreset` 写进会话头 meta）；不挂的会话只有 profile 根上的插件工具
（记忆、IM、agent-team 之类），`ctx.commands.execute(agent, '/plan …')` 查不到命令会返回
`undefined`，于是静默退回提示词——表现就是「会话开头没有 `/plan`、没有 plan 徽标、
模型说工具集里没有 exit_plan_mode」。

补全 / 候选 / 拆目标 / 反馈提炼这类提示词会话：走 `POST /api/run` 的（给出执行步骤、
补齐证据、定位阻塞、拆目标）现在**也挂 preset**——它们要读仓库，不挂就只有记忆可用；
`candidates` / `fill` / `services-collect` 三个端点仍按轻量工具集跑。
同一个 `sessionId` 的计划 → 执行 → 反馈复用同一个 agent，preset 只在建 agent 时挂一次。

### 记录节点的 `session` 位归动作会话独占

记录节点（带 `action` 的 `kind:"exec"`）上的 `session` 只能由动作回写
（`applyActionResult`）写。普通会话结束时的 `persistSession` 遇到记录节点直接返回，
否则卡片上会出现「计划 · 会话交回计划」配一条 `task_id: "steps"`、从没发过 `/plan`
的普通会话（2026-10-29 实测：p1 的 `proof` 时间 19:59:08，被指向的会话 19:59:17 才开始）。

## 三、数据形状

`rotation/v1` 只新增三个可选字段，老卡不用改：

```json
// 构思：计划书
"plan": {
  "goal": "一句话目标",
  "verify": ["npm run preflight"],
  "steps": ["改 lib/core.mjs 校验", "改面板动作"],
  "doc": "# 计划标题\n……完整 markdown……",
  "at": "2026-10-29T12:40:00+08:00",
  "session": "session-…"
}
```

```json
// 闭环：经验积累（反馈提炼写入，去重）
"lessons": [
  { "text": "面板与 host 共用口径时先定 JSON 形状，再写两侧", "from": "idea-id/record-id", "at": "…" }
]
```

```json
// 执行记录：构思的 exec 子节点，一次会话一条
{
  "id": "idea-id-p1",          // p=plan / e=exec / r=reflect，序号自增
  "kind": "exec",
  "action": "plan",            // plan | exec | reflect
  "title": "计划 · <构思标题>",
  "status": "doing",           // 开始时 doing；成功 done 并写 closed_at
  "started_at": "…",
  "closed_at": null,
  "proof": "…",                // 完成时写摘要（关闭时校验要求）
  "verify": "…",               // exec 记录写计划的第一条验证命令
  "session": { "id": "session-…", "status": "running", "started_at": "…", "ended_at": "…", "result": "…" }
}
```

校验放宽（`lib/core.mjs`）：`action` 记录（plan/reflect）不强制 `verify`；其余规则不变。

## 四、接口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/rotation/api/action/plan` | `{file,nodeId}` 构思 id → 建记录 + 起会话出计划 |
| POST | `/rotation/api/action/exec` | `{file,nodeId}` 需要已有 `idea.plan` → 同会话 `/goal` 执行 |
| POST | `/rotation/api/action/reflect` | `{file,nodeId}` 手动补跑一次反馈提炼 |

返回 `{ ok, run, record }`；失败 `{ ok:false, error }`。

| 情况 | 状态码 / code |
|---|---|
| 同一构思已有会话在跑（含回写中 `settling`） | 409 `RUN_ACTIVE` |
| 执行计划时还没有 `idea.plan` | 409 `PLAN_MISSING` |
| 面板数据与磁盘不一致，找不到节点 | 409 `NODE_NOT_FOUND` |
| 给非构思节点发起动作 | 400 |

超时：计划 20 分钟、执行 60 分钟、反馈提炼 15 分钟。goal 模式 30 秒内读不到目标状态即判失败
（说明 `/goal` 没生效）；命令服务不可用或返回 `undefined` 时自动退回提示词，
`exec` 的 goal 语义同时降级为单回合（回合结束即完成）。

## 六、面板行为

- 构思卡下缘：`生成计划`（无计划时）/ `执行计划`（有计划且空闲时）；运行中显示实时状态。
- 构思状态跟着记录走：只生成过计划 = `规划中`；出现过执行记录 = `进行中`；
  计划 / 执行 / 反馈都关闭且至少有一次执行 = `已闭环`（host 记录收尾时只自动收口构思本身）。
  记录还没全闭环时构思不显示「完成」按钮；已闭环的构思再次发起动作会先重开它和上级。
- 目标 / 闭环**不自动闭环**：子项全部闭环后状态是 `待确认收敛`，卡片泳道头出现「确认收敛」，人点了才写 `closed_at`；
  之后目标折叠成「已闭环 N」chip、闭环项目留在主泳道，可从「闭环历史」只读回看或开新闭环。
- 目标卡 / 闭环卡：仍保留 `生成候选 / 候选池`（拆目标、拆构思不变）。
- 「执行验证反馈记录」列：记录卡显示动作类型（计划 / 执行 / 反馈）+ 会话状态
  （启动中 / 运行中 / 完成 / 失败 / 已取消），完成的可折叠。
- 构思详情卡：计划书三块（目标 / 验证命令 / 步骤）+ 两个动作按钮。
- 闭环详情卡与信息栏：经验积累列表。

## 七、验证方式

```bash
npm run preflight          # lint + 契约 + 会话 mock + 样例校验 + 打包
node scripts/action-mock.mjs   # 假 agent 走通 计划→执行→提炼 三条链路
```
