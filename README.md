# 闭环轮转面板 · DSH 插件

把「多项目闭环轮转」做成 DSH 插件：一个泳道视图里同时看多个项目的
`闭环 → 目标 → 构思 → 执行`，每个节点带可复制的结构化 prompt、可发起的会话、
可一键拉起的项目服务。

## 当前形态（M0 已跑通）

```
package.json          插件清单：dsh.bundle.patch + dsh.client
cordis.patch.yml      安装后由 profile 自动挂载 host 半
lib/index.js          host 半：/rotation/app/*（面板）、/rotation/api/*（数据/会话/服务）
lib/store.mjs         注册表 + 卡片读写（validate → .bak → tmp+rename）
lib/runner.mjs        节点会话执行器（ctx.agents + session/event）
lib/services.mjs      服务探活 / 一键拉起 / 停止
lib/client.js         client 半：DSH Web 右栏「轮转」入口（__ModuleLoader__ 形态）
lib/core.mjs          rotation/v1 校验与树工具（host 与 CLI 共用）
web/                  面板本体：index.html + cards.js（file:// 兜底数据）
samples/              5 张示例卡（M1 会迁到各项目 workspace 的 .dsh/rotation.json）
scripts/dev-host.mjs  不装 DSH 也能验证 host 半的假宿主
serve.mjs             旧开发服务器（:4173，M3 后退役）
```

本地验证 host 半：

```bash
npm run dev            # http://127.0.0.1:4180/rotation/app/
curl -s localhost:4180/rotation/api/health
```

装进 DSH（M0 之后）：市场 UI 安装本目录打包产物；按本机规则插件只走市场 UI，
用 CLI 前先核对 `node_modules/.modules.yaml` 的 `storeDir` 与 `pnpm store path` 一致。

## M1 数据层（已完成）

```
~/.dsh/rotation/registry.json     项目注册表 [{id,name,workspace,file}]
<workspace>/.dsh/rotation.json    卡片真身（rotation/v1，跟着项目走）
```

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/rotation/api/projects` | 注册表 + 卡片是否存在 |
| POST | `/rotation/api/projects` | `{name, workspace}` 注册项目，自动建 `.dsh/rotation.json` 模板 |
| GET | `/rotation/api/cards` | 所有项目的卡片 |
| PUT | `/rotation/api/cards/<id或文件名>` | 校验 → `.bak` → 原子写；校验不过 422 |

面板变化：工具栏多了「+ 项目」；数据源文案改成「项目 .dsh/rotation.json（可写回）」；
所有请求走 `api()` 前缀，插件下是 `/rotation/api`，旧 `:4173` 服务下是 `/api`。

迁移样例：`npm run migrate`（干跑），`npm run migrate -- --write` 真正写入，幂等（目标已存在就跳过）。

## M2 会话（已完成，等待真机验证）

执行器 `lib/runner.mjs` 走 **DSH 进程内 agent 服务**，不再 spawn `dsh --profile headless`：

```
ctx.agentDefaultModel.currentSelection()      → { provider, model }（GUI 里选的那套）
ctx.agents.create({ sessionId, agentOptions, meta:{cwd}, setup })
agent.followup(<user message>)
ctx.on('session/event', …)                    → turn/start · assistant/message · turn/end
```

- 事件映射：`turn/start` → 运行中；`assistant/message` → 结果预览；`turn/end(completed)` → 完成；其它 reason → 失败
- 结束后把 `session{ id,status,cwd,task_id,started_at,ended_at,result,error }` 写回卡片
- 15 分钟超时自动中断；同节点单运行；全局并发上限 3
- 接口：`GET /rotation/api/run-config`、`POST /rotation/api/run`、`GET /rotation/api/runs`、`POST /rotation/api/run/cancel`

因为走进程内服务，凭据、provider 路由、模型选择都沿用 GUI 配置——这同时满足「模型调用必须走网关」的本机铁律。

验证：`scripts/dev-session-mock.mjs` 用假 ctx 跑三种路径（done / failed / cancelled），全部 PASS。

## M3 服务（已完成）

`lib/services.mjs`：探活（1.2s 超时，HTTP <500 算在线）、一键拉起（shell + 独立进程组）、
停止（SIGTERM → 3s 后 SIGKILL）。`health` 以 `/` 开头时按「相对卡片 url 的路径」拼接。

接口：`GET /rotation/api/services?file=<id>`、`POST /rotation/api/service/start`、`POST /rotation/api/service/stop`。

实测：`host` 探活 200·9ms；`web` 从 down → 拉起后 up·200ms（pid 8444）→ 停止后 down 且端口释放。

## M4 准备（进行中）

- **联调宿主**：`MOCK_AGENTS=1 node scripts/dev-host.mjs` 会在假 ctx 里挂一个 mock agent，
  于是面板的「发起会话」可以真的被点下去，状态点会走 运行中 → 完成
- **client 契约**：`npm run mock:client`（9 项断言，含无 slots 降级）
- **调试钩子**：页面里 `window.__rotation.refreshRuns()` / `.runs` / `.state` 可手动触发刷新与查状态
- **后台标签页也会刷新**：切走再切回立刻同步一次，不再显示过期状态
- **服务日志**：服务块里出现「日志」按钮（有输出时），弹窗看最近 1500 字符
- **打包自检**：`npm run lint:plugin`（27 项：清单字段、patch、files、host/client 契约）
- **一条命令全跑**：`npm run preflight`


- 空注册表时面板显示引导卡片（「添加第一个项目」），不再退回样例数据：
  服务端能应答就算连上，空注册表是「还没有项目」而不是「连不上」
- `dsh.engines.dsh >= 0.2.1-rc.3`：把插件依赖的宿主版本写进清单
- runner 在拿不到 provider/model 时不传 agentOptions，交给宿主默认选择
- `npm run mock:client`：用假浏览器环境验证 client 半契约（9 项断言）

---
# 闭环轮转面板（原型 v0.6 · 可读写 rotation/v1）

> 一个工作区一张闭环卡：`闭环 → 目标 → 构思 → 执行`，自下而上确认关闭，全部关闭后闭环收敛归档。

## 每天怎么用（3 步）

1. 双击 `start.command`（或 `node serve.mjs`），浏览器打开 http://127.0.0.1:4173/
2. 在这个面板上做三件事：看哪条闭环有阻塞、点「完成 / 确认关闭」自下而上收口、收敛后它自动进底部「已收敛」区
3. 改完就落盘了 —— 工具栏会显示 `已写入 xxx.rotation.json · 时间`

## 加一个新项目（2 分钟）

```bash
cp templates/card.rotation.json samples/我的项目.rotation.json
node validate-rotation.mjs samples/我的项目.rotation.json   # 先改 id/title 再校验
```
刷新页面即出现新泳道。文件名必须以 `.rotation.json` 结尾。

## 服务：访问方式 + 一键拉起

**第一列（项目/阶段）**自上而下分两段：

```
项目名 / 路径 / 收敛进度        ← 靠上
────────────────
服务                          ← 项目名下方
● 轮转面板 4173  运行中 · 0ms
  127.0.0.1:4173
  [打开][复制地址]
○ 本地预览 5800  未启动
  127.0.0.1:5800
  [打开][一键拉起][复制地址]
        ⋮（行高撑开，中间留白）
时间                          ← 贴底（margin-top:auto）
关闭跨度 / 关闭速率 / 在途 / 最长在途 / 平均在途 / 超期 / 最近关闭 / ETA
```

「怎么用」（服务地址、拉起）在上，「跑了多久 / 还要多久」（时间维度）在下。

**右侧「信息 · 操作」列**以**收敛健康度 + 节点构成**开头，后面接 收敛趋势 → 下一步 → 风险 → 操作按钮。

配置写在 `rotation.json` 的 `services`：

```json
"services": [
  { "id": "panel",   "name": "轮转面板 4173", "url": "http://127.0.0.1:4173", "health": "/api/run-config" },
  { "id": "web5800", "name": "本地预览 5800", "url": "http://127.0.0.1:5800",
    "start": "python3 -m http.server 5800", "cwd": "/tmp/rt-workspace" }
]
```

- 状态由服务端每 5s 探活（首次 1.2s 超时），显示 `运行中 · 2ms / 未启动 / 启动中 / 启动失败`。
- 「一键拉起」会先弹窗显示**将执行的命令与工作目录**，确认后才 `spawn`；进程独立成组，可「停止」。
- 「打开」直接新开标签；「复制地址」复制 `url`。
- 没配 `services` 的卡会显示提示，不影响其它功能。

接口：`GET /api/services?file=`、`POST /api/service/start`、`POST /api/service/stop`。

## 节点 ↔ 会话（发起 / 等待 / 处理结果）

详情卡的「会话」段可以直接驱动一次真实 DSH 会话：

每条 prompt 模板行尾是 **复制 / 发起** 两个按钮；**改内容不用额外按钮**——点模板名就在下面展开可编辑的完整 prompt。

| 动作 | 行为 |
|---|---|
| 点模板名 | 卡片内展开 textarea（预填完整 prompt，可直接改），旁边有「重置」回到默认 |
| 复制 | 复制**当前**内容（改过就复制改后的） |
| 发起 | 用这条模板预填 → 弹窗里仍可再改 → 发起；在 `project.workspace` 下跑 `dsh --profile headless --json` |
| 再跑一轮 | 会话段里，复用上次的模板与运行记录 |

改动只存在页面内存（关掉页面即丢），不会被写进 `rotation.json`——避免把临时试验写进卡里。
| 等待 | 节点卡片显示状态点（启动中 / 运行中 · 12s / 完成 / 失败 / 进程已不在），面板每 2s 拉一次状态 |
| 取消 | 杀子进程，状态置「已取消」 |
| 处理结果 | 结果预览 + 「写进证据」（exec 节点写入 `proof`）+「再跑一轮」 |

状态来源是**子进程事件流**（`session` / `step/*` / `tool/*` / `turn/end` / `final`），不是解析日志文件；离开页面再回来靠卡片里的 `session.status` 兜底，超过 60s 无心跳判「进程已不在」。

> ⚠️ 运行器需要模型凭据：headless profile 没有 credentials 插件，服务进程环境里要有 `DEEPSEEK_API_KEY`，否则发起必然失败（面板会在确认弹窗里提前警告）。启动示例：`DEEPSEEK_API_KEY=... node serve.mjs`

接口：`POST /api/run`、`GET /api/runs`、`POST /api/run/cancel`，写接口要求同源 + `X-Rotation-Token`。

## 已关闭节点自动折叠（XMind 式）

已关闭的子节点默认不占版面，收成父卡片上的一行小 chip：

```
构思 sw-i1  章节 → 情节两层索引
  ▸ 已关闭 1                      ← 点一下展开那一项，chip 变成「▾ 收起已关闭 1」
```

- 默认折叠，省版面也省注意力；点 chip 展开、再点收起，状态在当前会话内保持
- 折起来的是**整棵已关闭子树**（一个已关闭目标连同它下面全部执行项一起收）
- 从详情卡/深链打开一个被折叠的节点时，会自动把它的祖先展开，不会出现「点了没反应」
- 折叠只影响渲染，收敛进度、健康度、节点统计仍按完整树计算

## 点节点看详情卡

点任意节点（卡片空白处，不是按钮）会弹出详情卡：

| 区域 | 内容 |
|---|---|
| 头 | 类型 · id · 状态 · 关闭按钮 |
| 标题 | 节点 title |
| 面包屑 | 项目 › 闭环 › … › 当前节点，任意一级可点回 |
| 字段 | 意图 / 验收 / 方案 / 验证 / 证据 / 开始 / 关闭 / 在途（有哪个显示哪个） |
| 问题反馈 | 该节点的 `issues`，已处置的会标注 |
| 子节点 | 可点的 chips，点一下切到那个节点 |
| 操作 | 确认关闭 / 重开 / 复制 JSON / 聚焦项目 |

- 关闭方式：点卡片外的任意位置（空白、泳道、工具栏）、按 Esc、或点右上角 ✕
- 点另一个节点会直接切到那个节点的详情（不关闭再开，是一次切换）
- 点别的节点上的操作按钮（完成/重开/+目标）会先关掉详情，再弹对应确认
### Prompt 模板（复制即用）

详情卡底部按节点类型给出可复制的结构化 prompt，点「复制」直接拿走，不必自己组织上下文。

固定结构：

```
# 上下文            ← 自动填充：项目 / 当前待闭环（意图+验收）/ 当前目标（验收）/ 当前构思（方案）
# 当前节点          ← 类型、id、标题、状态；goal 附验收与已有子节点；exec 附验证/证据/未处置反馈
# 任务              ← 选中的那条任务指令
# 输出要求          ← 统一：Markdown、小节标题固定、不复述上下文
```

按节点类型提供的任务：

| 类型 | 提供的模板 |
|---|---|
| 闭环 | 拆成目标 / 检查是否真闭合 |
| 目标 | 拆出构思 / 验收可判定性 |
| 构思 | 重新生成构思 / 梳理执行计划 / 预演失败点 |
| 执行 | 给出执行步骤 / 补齐证据 / 定位阻塞 |

- 模板可写进 `rotation.json`：卡根 `prompts.<类型>` 或节点上 `prompts` 数组，**节点级 > 卡片级 > 内置**；详情卡标注来源。
- 上下文段可配：`prompt_context.fields` 决定带哪些行（可加 `siblings` 带同级兄弟节点），`siblings` 控制条数。
- `prompt_context.refs` 可按 id 引用树里任意节点（跨目标/跨层），自动拼出「引用·类型「标题」(id)：状态 + 要点」。
- 点模板名 = 展开完整 prompt 预览；点「复制」= 写入剪贴板。
- 剪贴板被拒（无用户激活 / 无权限）时自动展开并选中原文，提示按 ⌘C。

### 字段就地编辑

详情卡里的 **标题 / 状态 / 意图 / 验收 / 方案 / 验证 / 证据** 都可以直接点开改：

| 操作 | 行为 |
|---|---|
| 点标题或字段值 | 变成输入框 / 多行框 |
| ⌘/Ctrl+Enter 或「保存」 | 写回 `rotation.json`（走同一个 PUT，服务端会再校验） |
| Esc 或「取消」 | 放弃修改，卡回读模式 |
| 状态下拉 | 改 `status` 后立即写回；已关闭节点禁用 |

- 校验不过（例如清空 `exec.verify`）会被服务端 422 拒绝，界面回滚并提示原因。
- 有警告时照样保存，但 toast 会带出第一条警告（例如「非叶子写入 status=done 不生效」）。
- 保存后卡片与泳道都会重渲染，详情卡自动挂回同一节点。

- 分享某个具体节点：`?open=<nodeId>`，例如 `/?open=sw-e4`。
- 窗口 resize 或切主题后详情卡会自动挂回原节点。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 面板本体（双击可看，但只读；写回需要服务） |
| `serve.mjs` | 静态服务 + `GET /api/cards`、`PUT /api/cards/<file>`（校验不过 422 拒写，原子写盘） |
| `rotation-core.mjs` | 校验与树工具，CLI 与 server 共用同一份规则 |
| `validate-rotation.mjs` | 命令行校验：`node validate-rotation.mjs <file>` |
| `rotation-card-spec.md` | 数据规范 `rotation/v1`：字段、不变量、与面板映射 |
| `samples/` | 5 张示例卡（竞品知识图谱那张是已收敛状态） |
| `templates/card.rotation.json` | 新项目模板（已验证可过校验） |
| `bundle-data.mjs` | 可选：把 samples 打包成 `cards.js`，供不启服务时只读查看 |

## 这几天重点观察（决定下一步做什么）

1. **闭环粒度**：一条闭环拆到 3–5 个目标是顺手，还是 8–10 个才够？这决定以后要不要支持「目标分组」。
2. **第 5 层折叠**：执行项下面还要拆子步骤的频率高不高？频繁的话要改成「执行项也开列」或「折叠行可展开」。
3. **验收字段会不会被空着**：`acceptance` / `verify` 是不是经常写成「待补」。空着就说明该在关闭时强制填。
4. **一个工作区够不够**：会不会出现「同一项目两条并行闭环」的需求 → 决定要不要 `loops[]`。
5. **切换动作够不够**：现在只显示各项目的闭环状态，不做真实会话跳转。

## 已知限制

- 会话列表 / 轮转轨迹在 `rotation/v1` 里没有，聚焦视图那块是空的（要等插件读 DSH 会话数据）。
- 服务只监听 `127.0.0.1`，没有鉴权——本机自用可以，别暴露到局域网。
- 服务写盘前会重新校验，**校验不过的改动会被拒绝**（例如给没有证据的执行项点关闭，会补占位证据后放行）。
- 默认全展开 4 条泳道；15 个项目时用每行「收起」折叠成目标 chips。

## 信息 · 操作列的口径（可复算，不是拍脑袋）

| 指标 | 公式 |
|---|---|
| 收敛健康度 | `完成度×62 + (1−阻塞比)×23 + 验收完整比×15`，四舍五入 0–100；未起步且无阻塞显示「起步」，≥75 健康 / ≥45 偏紧 / 其余危险 |
| 完成度 | 已关闭的执行节点 ÷ 全部执行节点（含第 5 层折叠节点） |
| 收口 | 已关闭目标 ÷ 全部目标 |
| 关闭跨度 | 最早 `closed_at` → 最近 `closed_at` 的自然时长 |
| 关闭速率 | 已关闭节点数 ÷ 关闭跨度（跨度 < 1.2 小时不估算） |
| 预计收敛 | 剩余执行节点 ÷ 关闭速率；置信度：已关闭 ≥6 高 / ≥3 中 / 其余低 |
| 在途 & 平均在途 | 未关闭执行节点的 `now − started_at`；只统计执行节点（父节点会虚高） |
| 超期 | 在途 > 7 天的执行节点数，卡片上同时打「⏳ 在途 N 天」（阈值统一 7 天） |
| 收敛趋势 | 近 14 天按**本地日期**分桶：柱 = 当日关闭节点数；绿线 = 执行节点累计关闭占比；另给关闭总数、峰值日、执行收敛比例 |
| 风险 | 阻塞执行项数、未处置 `issues` 条数、缺 `verify` / 已关闭但缺 `proof` 的节点数 |
| 下一步 | 取第一条：解阻断 → 可确认关闭 → 继续执行（doing 优先，其次 plan） |
