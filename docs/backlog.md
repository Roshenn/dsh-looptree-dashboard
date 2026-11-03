# 待办清单（backlog）

> 来源：2026-11-03 三轮只读审计 —— host 半（`lib/*`）、面板（`web/index.html`）、
> prompt 与执行记录层（`docs/prompts.md`、`docs/execution-records.md`、`docs/prompt-audit.md`、`rotation-card-spec.md`）。
>
> 分组口径是**闭环**：一组 = 从触发到验收的一整条回路，不是按文件切。
> 每条给证据位置（行号会漂，函数名不会）与一句现状。末尾标 **必须现在 / 可延后**。
> 已落地的组不删，标成「已落地」——防止以后重复排期。

---

## 〇、已落地

- **零散但确定的小修（0.22.0）**：第五节 10 条全部完成（计划书校验的 support 残留、失败提示可回看、
  顶栏时间、刷新进行态、候选池三态、会话入口、全局搜索、失败处理块 + 三方标签断言、写接口令牌、删除撤销）。
- **回流闭环（0.21.0）**：`milestone.lessons` 与上一次执行记录进 plan / exec / reflect 的背景，
  `prompt_context.reflux` 可关。见 [prompts.md](prompts.md) 的「回流」节与 `CHANGELOG.md` 0.21.0。
- 会话崩溃恢复（动作记录）：`resume` / `rebound` / `retry` / `abandon` + 启动对账（0.17.0 → 0.20.8）。
- 服务控制：探活、四态动效、坏命令 1.2s 复核、端口冲突整批拒绝（fail closed）。
- 会话完成后自动刷新 + 「新」角标 + 卡片 mtime 跨窗口同步。
- 空闲分支高亮 + 右下待处理托盘 + 页脚「建议下一个轮转」。
- 「查看会话」跳 DSH 对话页（`data-open-session`）——README「面板没有会话列表与对话历史」这条**已过期**。

---

## 一、收口闭环：让「关闭」有实测证据

**断点**：执行记录判成功的判据是「模型这一回合正常结束」，不是验证命令跑通。

| # | 证据 | 现状 | 标注 |
|---|---|---|---|
| 1 | `lib/index.js` `applyActionResult` 的 exec 分支 | `snap.status === 'done'` 就 `closeRecord`，随即 `autoCloseDoneCapability`；`record.verify` 缺失时兜底成一句文案（`capability.metric` 或「按计划执行（计划未列验证命令）」） | 必须现在 |
| 2 | 全仓 `spawn` 只在 `lib/services.mjs`（start 与 build） | 没有任何路由执行 `exec.verify`；`/api/verify` 不存在 | 必须现在 |
| 3 | `lib/index.js` `parsePlanMarkdown` | 模型交的计划没有 `## 验证命令` 时 `verify=[]` 且不报错，`capability.plan` 照收；`renderPrompt` 再把空块整块省掉 | 必须现在 |
| 4 | `web/index.html` 关闭记录的分支 | 无证据关闭会写占位「（面板关闭，未附证据）」，闸门可绕 | 必须现在 |
| 5 | `rotation-card-spec.md` §最短实现的第 3 条 | 已把 `exec.verify` 的 `{cmd, expect}` 结构写进规范，标「可延后」 | 可延后 |

**闭环**：生成计划产出逐条验证命令 → 执行时一条条跑 → 记录写 `{cmd, expect, actual, exit}` →
全绿才允许收口；正常结束但没跑过验证的记录落成 `failed`，进「重跑 / 放弃」出口。

**最短实现**：新增 `POST /api/verify`，复用 `services.mjs` 的「spawn → 等退出 → 退出码 + 输出尾巴」；
把收口判据从「回合结束」改成「有实测证据」。

---

## 二、回写闭环：每个会话的结果都有归宿

**断点**：同一条记录上有两条发起路径，只有一条有回写口。

| # | 证据 | 现状 | 标注 |
|---|---|---|---|
| 1 | `lib/index.js` `persistSession` | `if (node.action) return` —— 记录卡上「补齐证据 / 定位阻塞」发起的普通会话，结果永不落卡 | 必须现在 |
| 2 | `lib/index.js` `reconcileOrphans` | 判定被限死在 `kind === 'exec' && action && !closed_at`；普通节点上的 `session.status='running'` 崩溃后永不自愈 | 必须现在 |
| 3 | `lib/index.js` 的 `PENDING_FILLS` / `PENDING_SPLITS` / `PENDING_CANDIDATES` / `PENDING_SERVICES` | 全是模块级 Map，插件重载即蒸发；进行中的补全/候选/收集会话，结果没有落盘归宿 | 可延后 |
| 4 | `lib/runner.mjs` `finish` 与 `cancel` | 会话在 `settling` 窗口内被取消时 `finish` 直接 return，`cancel` 仍回 `status: 'cancelled'`——卡片写成 cancelled，run 实际还在跑，收尾后又被覆盖 | 必须现在 |
| 5 | `docs/execution-records.md` §三 `plan` 形状 | 计划只有生成没有修订：执行中偏离只落在 `session.result`，没有写回 `capability.plan` 的动作，下次 `/goal` 指针读到的还是旧计划 | 可延后 |
| 6 | `docs/execution-records.md` §二 动作表 | 只有 `done` 的记录触发反馈提炼；`failed` / `abandoned` 只写原因关闭，同一个坑下次还会踩 | 可延后 |

**闭环**：任何会话（动作或普通）结束时都有确定写回位置；中断能被对账；取消与收尾互斥可见。

---

## 三、窄栏闭环：右栏 iframe 里读得下去

**断点**：面板的主要打开形态是右栏 iframe（`lib/client.js` 的 `sidebar.right.pane.tab`），
但画布按宽屏设计。

| # | 证据 | 现状 | 标注 |
|---|---|---|---|
| 1 | `web/index.html` `.matrix{min-width:1200px}` + `--lane-head:224px` + `--info-col:272px`；紧凑模式只改工具栏 | 右栏里要横向拖约 900px 才看到右侧「信息 · 操作」列 | 必须现在 |
| 2 | `web/index.html` `detailMarkup` 的 `.detail-acts` 在卡片末尾 | 详情卡先滚过编辑行、计划、记录、会话、prompt 才看见「发起 / 确认达成」 | 必须现在 |
| 3 | `web/index.html` `renderMatrix()` | 筛选到空集时直接渲染空数组，只剩表头，像坏了 | 必须现在 |
| 4 | `web/index.html` boot 段 | `await resolveApiBase()` 最多 4 个候选 × 1.5s，期间不切 `#empty` / `#matrix`，无骨架 | 可延后 |
| 5 | `web/index.html` 节点与详情卡 | 节点是 `div` 靠点击委托，不可聚焦；详情卡 `role=dialog` 但打开不移焦、关闭不还焦 | 可延后 |

**闭环**：400px 宽 iframe 里不横滚就能看到「节点 → 状态 → 主操作」一屏；
筛选空态有文案能清筛选；首屏有骨架而不是白屏。

**最短实现**：窄宽度切单列纵向流（泳道头 → 节点 → 风险 → 操作），详情卡主操作置顶。

---

## 四、不丢闭环：写路径设防

**断点**：并发写同一份文件时互相覆盖，且没有统一的失败出口。

| # | 证据 | 现状 | 标注 |
|---|---|---|---|
| 1 | `lib/store.mjs` `writeRegistry` | 临时文件名固定成 `.registry.${process.pid}.tmp`；`addProject` / `removeProject` 都是「读整表 → 改 → 写整表」——并发加/删项目互相覆盖，丢一条等于整个项目从面板消失 | 必须现在（三人以上或脚本化时才痛） |
| 2 | `lib/index.js` `PUT /api/cards`、`candidates/adopt`、`applyFillResult`、`abandonAction`、`reconcileOrphans` | 都直接 `writeCard`，绕开 `CARD_QUEUES`；`store.mjs` 的临时名只精确到毫秒 | 必须现在 |
| 3 | `lib/index.js` `createHandler` | async handler 无 try/catch，注册处也无 catch——坏 JSON 或 EACCES 会让请求变成无人接的 rejected promise，既无 500 也无日志 | 必须现在 |
| 4 | `lib/runner.mjs` 的 `runs` / `agents` 两个 Map | 全书无 `runs.delete` / `agents.delete`，只有整体 clear；`/api/runs` 返回全量含终态 | 可延后 |
| 5 | `lib/services.mjs` 的 `procs` | 只在内存：DSH 重启后面板自己拉起的服务仍在跑，「停止」永远 404，只能靠「关闭全部」按端口杀 | 可延后 |
| 6 | `lib/index.js` 的 `MAX_CONCURRENT` | 只有 `/api/run` 与 `/api/services/collect` 检查；`/action/plan|exec|reflect`、`/fill`、`/candidates/generate` 全程不查 | 可延后 |

**闭环**：并发发 4 个加项目请求，`registry.json` 最终 4 条俱在、无残留 tmp；
并发保存 + 会话收尾时卡片不丢字段，冲突返回 409 而不是覆盖。

---

## 五、零散但确定的小修（2026-11-03 全部完成，见 CHANGELOG 0.22.0）

| # | 证据 | 当时的问题 | 现在 |
|---|---|---|---|
| 1 | `lib/core.mjs` 的计划书校验 | 仍判 `n.kind !== 'support'`，`support` 已退役——每次写 `capability.plan` 都吐一条假警告，把真告警稀释掉 | ✅ 改成 `capability`；`checkPlan` 这才真正跑起来，`exec.plan` 仍正确告警 |
| 2 | `web/index.html` `toast()` | 单槽、固定 2.4s、圆点恒绿；连续操作前一条被顶掉，失败无处回看 | ✅ 失败标红 + 停 8s + 可点掉，并在顶栏留一条「最近一次失败」直到点开 |
| 3 | `web/index.html` 顶栏「数据 · 时间」 | 初值取 `cards.js` 样例的 `updated`，只有手动刷新才重设——显示的时间既不是数据时间也不随刷新变 | ✅ 改成 `markDataStamp()` 一处口径（首次载入 / 手动刷新 / 自动刷新都走它），没连上显示「—」 |
| 4 | `web/index.html` `#btn-refresh` | 串行三请求，不进「刷新中」禁用态、无 `aria-busy` | ✅ 请求期间 `disabled` + `aria-busy`，连点不再叠请求 |
| 5 | `web/index.html` `openCandidatePool` | 先 `await` 再开窗，失败被吞成 `[]`，标题统一写「已清空」 | ✅ 先开窗给「读取中」，读完分三态：列表 / 空池 / 读取失败 + 重试 |
| 6 | `web/index.html` 信息列「会话 ↗」与聚焦视图会话行 | 只弹「原型未接宿主」，而可用的 `data-open-session` 就在旁边 | ✅ 接上真实 `/api/sessions` 列表；点一条切回该会话（独立打开时退化为看全文） |
| 7 | 全局搜索 | 只有 all / blocked / open 三颗预设筛选，节点多了只能翻或靠页脚随机跳 | ✅ 顶栏搜索框（Ctrl/⌘+K 聚焦、Esc 清空）：按标题 / id / 证据 / 指标 / 实现思路 / 阻塞反馈过滤泳道，命中节点描边，提示条给命中数 |
| 8 | `docs/prompt-audit.md` §5 | 已写出二期方案，标「本阶段不执行」 | ✅ 补 `失败处理` 块并真的写进「生成计划」；三方标签一致性改成**断言**（lib / docs / 面板 `PROMPT_BLOCKS` 直接比对）；退役的 `场景` / `验收` 从允许标签里清掉 |
| 9 | `lib/index.js` CORS 与鉴权 | `access-control-allow-origin: *`，声明了 `x-rotation-token` 但全仓没读它——本机任意网页能跨源调 `stop-all` / `probe` / `run` | ✅ 写接口要令牌：每进程随机生成、只注入插件托管的面板 HTML；http(s) 跨源写无令牌 → 403。非浏览器客户端与 `dsh-app://` 放行，`ROTATION_TOKEN` 可固定。新增 `npm run mock:auth`（10 项）进 preflight |
| 10 | `web/index.html` 长按删除 | `[data-del]` 绑 pointerdown 长按 800ms 且 `preventDefault`，无键盘路径、无撤销 | ✅ 补 Enter/Space 与 Delete/Backspace 两条键盘路径 + 删完可撤销；长按只对树节点生效，字段编辑器的 × 不再被一个删不掉的长按抢事件 |

**顺带修掉的 pre-existing 问题**（不在本清单里，但挡着 preflight 绿）：

- `scripts/registry-mock.mjs` 的把「另一台机器」写死成 `I:\dev\business\english-shadow`，
  本机真有这个目录 → 7 项断言长期连锁失败。改成 tmpdir 下一条从不创建的路径。
- `lib/services.mjs` 的「一键编译」用 `detached: true` + 管道 stdio，Windows 上输出整个丢掉
  （退出码正常、`output` 恒空）。Windows 改不 detach、整组中止走 `taskkill /T`。

---

## 六、读代码时发现的两个系统性问题

1. **读路径带写副作用**：`GET /api/cards` 先跑 `reconcileOrphans` 再全量读所有卡片，
   一次刷新可能触发磁盘写；增量手段只有 mtime 戳，没有版本号 / ETag / 推送。
   `/api/session` 把整份 `session.v4.jsonl.zstd` 解压进内存全量返回。
2. **一处状态拆成六本账**：卡片 + `PENDING_*` 四个进程内 Map + `runs` / `agents` 两个 Map，
   没有任何一本能从另一本重建；插件重载只清空后六本，卡片上的 `session` 还写着 running。
   于是「任务消失」在数据层是默认结果，而不是异常。
