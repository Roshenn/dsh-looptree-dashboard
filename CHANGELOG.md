# CHANGELOG

## 0.9.1 — 注册表按「本机可见」解析：另一台机器登记的项目不再挡住添加

- **根因**：`~/.dsh` 走 git 同步，`rotation/registry.json` 是共享文件，但 `workspace` 是各机器的绝对路径。
  2026-10-28 一次「同步本机注册表」把 Windows 的 `I:\dev\business\english-shadow` 写进来、覆盖了 Mac 的两条登记：
  卡片路径读不到 → `/api/cards` 返回 error 条目 → 面板按 `x.card` 过滤 → 显示「还没有项目」；
  但 `POST /api/projects` 仍拿整份注册表查重 → 添加同 id 项目永远 409「项目 id 已存在」，两个视图各说各话
- **修复**（`lib/store.mjs`）：新增 `isLocalEntry` / `partitionRegistry`——`workspace` 目录不在本机的条目视为
  「另一台机器的登记」：`listProjects` 不返回（面板、`/api/workspaces` 已登记集合、`findProject` 只认本机），
  `addProject` 的 id / 目录查重只看本机，`removeProject` 只删本机；写回时整份列表保留别的机器条目，
  git 同步不再互相冲掉。本机登记但卡片已丢的条目改为「接管」，不再 409
- **数据**：本机两条真实项目（english-shadow / demand-collection）按新口径重新登记（复用原卡片，不写模板）；
  Windows 的 `I:\` 残留条目已从本机注册表移除（`git show ed5b20b:rotation/registry.json` 可查，
  另一台机器升级后点一次「+ 项目」即可重新登记）；`~/.dsh` 里 `rotation/registry.json` 的改动留给用户自己提交
- **测试**：新增 `scripts/registry-mock.mjs`（12 项断言：别的机器条目不显示 / 不占 id、写回保留、真重复仍 409、
  死卡片接管、移除只删本机），并入 `npm run preflight`
- 验证：`npm run preflight` 全绿；dev-host 复现原场景（注册表只有 Windows 条目）→ POST 添加 200、
  `GET /api/cards` 返回 1 张卡、注册表两条并存；真机面板刷新后 english-shadow / demand-collection 两泳道回归；版本 0.9.1

## 0.9.0 — prompt 结构统一：首行任务、空行分块、先看再发

- **根因**：动作 prompt 被 `oneLine()` 压成一行塞进 `/plan`，人和模型都只看到一段糊墙；
  host 的 `buildPlanTask / buildExecPrompt` 与面板的 `composePrompt` 各写一份格式、先后漂移
- **唯一实现** `lib/prompt.mjs`：`composeTaskPrompt` / `composePlanPrompt` / `composeExecPrompt` /
  `composeReflectPrompt` / `composeGoalObjective` / `composeSplitPrompt` / `composeIdeaPrompt` /
  `composeCandidatePrompt` / `composeFillPrompt` / `actionCommand` / `lintPrompt`；
  host 与面板不再各拼一份
- **格式规范**（`docs/prompts.md`）：首行 `<动作> · <对象>`、空行分块（背景 / 当前节点 / 任务 /
  验收 / 约束 / 输出 / 提交方式）、一行一个事实、单行 ≤72 列超宽自动折行；不用 `#` / `**`
  （DSH 用户气泡是 `white-space:pre-wrap` 纯文本，不渲染 markdown）
- **发送编排**：`/plan\n<多行正文>`（`parseCommand` 只切命令名，换行保留，气泡里就是分段的样子）；
  `/goal` 仍单行；命令不可用或失败时退回同一份正文
- **面板**：Prompt 段每行 = 标题 + 摘要；点标题展开结构视图，可切「编辑原文」；
  「发起」「生成计划」「执行计划」都先开**发送预览**（结构视图 + 可编辑 + 会发出去的命令），
  确认后才发送，取消不发任何东西；执行预览可改单行目标
- **接口**：`GET /rotation/api/prompts?file=&nodeId=[&action=plan|exec]`（只读）；
  `POST /api/run` 的 `prompt` 改为可选（缺省由 host 按 taskId 合成）；
  `POST /api/action/plan|exec` 接受 `prompt` / `objective` 覆盖，原样发送
- **测试**：新增 `scripts/prompt-mock.mjs`（样例卡 53 节点 / 139 模板 / 42 动作 prompt 的结构 lint、
  `/plan` 多行与 `/goal` 单行、JSON 契约字面量、模板优先级、lint 反例），并入 `npm run preflight`；
  `action-mock` 补多行正文、覆盖发送、命令退路断言
- 验证：`npm run preflight` 全绿；dev-host + Playwright 走通 查看 / 编辑 / 计划预览 / 执行预览 /
  发送，控制台零错误；版本 0.9.0

## 0.8.3 — 「查看会话」挪到节点卡下缘，点了直接切到 DSH 会话页

- 详情卡的「查看会话」与「在 DSH 打开」合并成一个按钮，移到每张节点卡的下缘（`.tfootline`），
  只在卡片有会话时出现：运行中的优先，其次卡片落盘的 `session.id`，最后构思的 `plan.session`
- 点击不再只弹面板内全文：面板把 `{type:'rotation-open-session', sessionId, reqId}` postMessage 给宿主，
  `lib/client.js` 收到后调 `ctx.get('uiWorkspace').openSession(id)`，DSH 主区直接切到那条会话
- 宿主侧回执 `rotation-open-session-result`：失败或 1.5s 无响应时，面板退化为弹会话全文并提示原因
  （旧版「在 DSH 打开」只发消息、宿主没监听，点了是假成功）
- 独立打开（非 iframe）时明确退化：直接弹全文，不再声称「已在 DSH 中切换」
- 验证：`npm run preflight` 全绿；Playwright 断言 9 张卡里 7 张带按钮、详情卡动作行只剩
  「再跑一轮 / 最近会话」、独立打开点击退化弹全文、模拟宿主回执 ok / 失败两条路都按预期；
  `lib/client.js` 用 stub ctx 单测：同源消息转发到 `openSession`、跨源忽略、缺 `uiWorkspace` 回 `ok:false`

## 0.8.2 — 生成计划 / 执行计划真的进 plan 模式（会话挂 agent preset）

- 根因：`lib/runner.mjs` 取 preset 组合用的是 `ctx.agents.composeAgent`，可这个方法在 DSH 的
  `agents` 服务上不存在（组合入口是 `agentPresets` 注册表），`composed` 恒为 `undefined` →
  计划/执行会话没挂任何 preset。`/plan`、`/goal`、`exit_plan_mode` 都挂在 preset 里，
  命令不存在时 `ctx.commands.execute` 返回 `undefined`，于是静默退回纯提示词：
  会话开头没有 `/plan`、没有 plan 徽标、工具集里也没有 `bash/read/exit_plan_mode`
- 修法：`composeSessionPreset()` 走 `ctx.get('agentPresets')`：`resolve()` 取默认 preset 再
  `mount()` 到 agent ctx（`sessionController.composeAgent` 在服务对象上不可见，试过但不是入口）；
  **只有 plan / exec 会话挂 preset**（补全 / 候选 / 拆目标 / 反馈继续用轻量工具集），
  `meta.agentPreset` 一并写进会话头
- 计划拿到就收手：捕获 `exit_plan_mode` 的计划后中断还挂在「计划审批」上的回合，
  计划只落盘、不执行；执行仍走「执行计划」按钮（同会话 `/plan off` + `/goal`）
- 停回合改用真实的 `agent.cancel()`（原来的 `agent.interrupt()` 在 DSH 上不存在，
  超时 / 取消其实没停掉会话）
- `scripts/action-mock.mjs` 补 4 项断言：计划会话挂了 preset、preset setup 执行、
  拿到计划后中断回合、执行复用已挂 preset 的同一 agent（17 项）
- 版本 0.8.2；验证：`npm run preflight` 全绿；用 `rotationtest` profile 起独立 DSH 实例
  真跑一次「生成计划」，会话日志里有 `command/run plan`、`plan/mode active`、
  `exit_plan_mode` 工具，计划写回 `idea.plan`

## 0.8.1 — 构思去掉「方案」字段；执行记录只留只读信息

- 构思节点不再有「方案」：详情卡的可填行、「生成 N 项」入口、节点卡摘要、AI 拆构思（prompt / 预览 / 写入）
  与 host 补全字段（`FILLABLE_BY_KIND.idea`）全部去掉；构思只留标题，做法交给「生成计划」
- prompt 模板：「拆出构思」「重新生成构思」不再要求写方案要点，改成只给方向标题
- prompt 上下文：移除 `idea.approach` / `node.approach`（旧 rotation.json 里写了这两个键会被安静忽略，
  `lib/core.mjs` 的 `CTX_KEYS` 不动，旧配置不报错）
- 执行记录（`action=plan|exec|reflect`）只留动作 / 会话 / 耗时 / 结果：去掉「验证」「证据」可填行、
  记录上的「生成」入口和「写进证据」按钮；节点卡也不再显示 `验证：…` 摘要
- 旧数据里的 `approach` 原样留在 JSON 里，面板不再展示，不做迁移
- 版本 0.8.1；实测：`npm run preflight` 全绿；Playwright 打开构思 / 计划记录 / 闭环 / 目标四张详情卡断言
  （构思无「方案」行、记录无「验证/证据」行与生成按钮；闭环与目标的字段、生成按钮不变）

## 0.8.0 — 构思动作化：生成计划 / 执行计划，执行列改为会话记录

- 构思卡移除「生成候选 / 候选池」，改为「生成计划 / 执行计划」两个手动动作；目标卡与闭环卡保留候选池
- 生成计划：起普通 DSH 会话 → `/plan` → agent 调研后用 `exit_plan_mode` 交计划，落到
  `idea.plan{goal,verify[],steps[],doc,at,session}`；面板计划书区只读展示目标 / 验证 / 步骤 + 全文弹窗
- 执行计划：同一 `sessionId` 上先 `/plan off` 再 `/goal <objective>`；runner 按 `ctx.goals.get(agent).phase`
  判定终态（active/paused 等 goal 续轮、complete → done、blocked → failed），另有 3s 轮询兜底
- 反馈提炼：执行记录 done 后自动在同一会话追问一次，解析 JSON 写入 `loop.lessons[]`（按 text 去重、≤5 条）
- 「执行 · 验证 · 反馈」列改名「执行验证反馈记录」：一次会话一条 exec 记录
  （`action=plan|exec|reflect`，带会话状态徽标与失败错误摘要）；**已完成记录常驻显示，不参与「已关闭 n」折叠**
- host：runner 支持同会话续跑、斜杠命令下发（`ctx.commands.execute`，服务缺失时退回提示词）、
  `exit_plan_mode` 计划捕获、goal phase 轮询；新增 `POST /api/action/plan|exec|reflect`；记录回写落到记录节点
- 校验：`rotation/v1` 新增可选 `idea.plan` / `loop.lessons` / `exec.action`；`action=plan|reflect` 的记录不强制 `verify`
- 样例：新增 `samples/execution-records.rotation.json`；新增 `npm run mock:action`（假命令服务 + 假 agent
  走通 计划 → 执行 → 提炼，13 项断言），并纳入 `npm run preflight`
- 面板：构思详情加计划书；闭环详情与「信息 · 操作」栏加经验积累；统计 / 进度 / 自动闭环都排除记录节点
- 版本 0.8.0；实测：`npm run preflight` 全绿；Edge headless 渲染 + 生成计划 / 执行失败点击链路通过

## 0.7.2 — 候选池：点完「添加」行内立刻变「已添加」，确认后自己退场

- 点「添加」后该行立刻切成绿色 `✓ 已添加`、正文降透明度、按钮禁用（防连点重复提交），
  0.5s 后整行收缩消失，不再留在列表里占注意力
- 行内只认前端一次性 uid，服务器索引在每次操作时现算：连加两条不会错位写成别的候选
- 标题计数与「清空候选池 / 关闭」按钮跟着剩余条数实时换挡；空池显示「本次已加入 N 条子节点」，
  并藏掉无意义的「取消」
- 删除同样按行退场，不再整窗重开
- 修：从详情卡打开候选池后点「添加」，按钮点击冒泡到全局 handler 会把详情卡关掉，
  看起来像「什么都没发生」；现在 `#ask` 内的点击不再触发关详情
- 版本 0.7.2
- 实测：Playwright 16 项断言全过——行即时带 `data-added`、按钮文案 `✓ 已添加`、退场后剩 2 行、
  连加两条写成 `候选甲 / 候选乙`（无索引错位）、空池文案与按钮换挡、详情卡保持打开、无 JS 报错

## 0.7.1 — 「生成候选 / 候选池」下放到节点卡，两处都能点

- 节点卡底部操作行新增 `生成候选` / `候选池 n`（与详情卡同一套动作），
  不用点开详情就能发起候选生成、挑候选；详情卡里的两个按钮保持不变
- 候选条数按项目批量取：host 新增 `GET /api/candidates/counts?file=`，
  面板渲染前一次灌好，节点卡首帧就显示 `候选池 n`，不是每节点一个请求
- 计数槽位定宽（`.cand-n`），数字变化不改变按钮宽度，节点卡不会因刷新换行长高
- 候选池为空时按钮置灰；置灰按钮不吃点击，点它等于点卡片 → 打开详情
- 候选生成完成 / 加入 / 删除 / 清空后，节点卡与详情卡同步换挡
- 版本 0.7.1
- 实测：`GET /candidates/counts` 返回 `{gmvrxyo8h1:2, gmvrxyo8h2:1}`；
  节点卡 footer 顺序 `完成 / 生成候选 / 候选池 2`；点节点上的「候选池 2」弹出 2 条；
  详情卡仍是 `生成候选(置灰) / 候选池 2`；布局漂移 0；页面无 JS 报错

## 0.7.0 — 候选池：先看候选，再决定落哪个子节点

- 节点卡片上不再有增删按钮（`+ 目标 / + 构思 / 长按删除` 全部移除），
  增删改只在详情卡里做，操作更保守
- 详情卡动作行改为：`生成候选` / `候选池 n` / `手动添加子节点` / `复制 JSON` / `删除节点`
- `生成候选`：闭环/目标/构思三级可用；调会话产出 3–6 条候选目标，
  结束时写入候选池；候选池非空时按钮置灰
- `候选池`（为空时置灰）：逐条「添加」（写入为真实子节点）或「删除」，
  底部可「清空候选池」
- host 新增 `GET /api/candidates`、`POST /api/candidates/{generate,adopt,delete}`；
  候选存在 `~/.dsh/rotation/candidates/<file>__<node>.json`，不污染用户卡片
- runner snapshot 增加 `candidatesAdded` / `candidatesError`
- 版本 0.7.0
- 实测：生成 3 条 → 候选池 3 → 加入 1 条（自动生成唯一 id `c-loop-c1`）→ 删 1 → 清空；
  手动添加子节点写盘成功


## 0.6.19 — 生成后能真正看到填充

- 修「点生成，内容不填充」：会话状态变 done 时，host 的 onFinish 还在写卡片，
  面板却已经 reload → 拿到的是旧卡片，之后再没有刷新
- runner snapshot 增加 `fillApplied` / `fillError`；host 在 onFinish 里把回填结果挂到 run 上
- 面板改为等到 `fillApplied`（或 `fillError`）出现才 reload 并提示：
  成功「已生成并写入：约束」，失败「生成结果没写进卡片：…」
- 版本 0.6.19
- 实测：清空目标 constraints → 点「生成 1 项」→ 详情卡约束即刻出现内容，
  toast「已生成并写入：约束」


## 0.6.18 — 位置并发：上游生成时冻结子节点

- 并发不再只看数量，更看位置：某节点有会话在跑（starting/running）时，
  **它的所有后代**都不允许再发起会话或「生成」
- host 侧硬约束：`/run`、`/fill` 命中祖先在跑 → 409 并说明是哪个上游在生成
- 面板侧：后代卡片淡化（opacity .46 + 灰度）并显示「⏸ 上游生成中」，
  点发起/生成会 toast 提示；轮询 runs 后增量刷新冻结态（不重建 DOM）
- 版本 0.6.18
- 实测：父节点发起后，子节点 `data-frozen=1 / opacity 0.46 / ⏸ 上游生成中`；
  对子节点 POST /run 与 /fill 均返回 409「上游节点「…」正在生成」


## 0.6.18 — 删除按钮移到详情卡

- 从矩阵节点卡里彻底移除删除按钮（含头部小 × 形态）
- 改到「点击节点后弹出的详情卡」头部：位置在关闭按钮 ✕ 左侧，🗑 图标，
  默认半透明，悬停变红底；长按 0.8 秒蓄力填充，满格删除，松手归零
- 只有叶子节点（非闭环根）才出现；删除后详情卡自动关闭并刷新卡片


## 0.6.17 — 删除按钮收进卡片

- 「长按删除」从卡片 footer 挪到**卡片头部右上角**，做成 16px 圆形图标（×），
  默认 `opacity:0`，卡片悬停 / 键盘聚焦时才显形，不再出现在操作区里
- 蓄力填充沿用同一套逻辑（红色从左往右，满格删除，松手归零）


## 0.6.16 — 构思也有「抽卡」：AI 拆出 3 条候选再挑

- 目标节点的 `+ 构思` 改成二级菜单：`AI 拆出构思`（生成 3 条供挑选）/ `手动添加构思`
- 拆构思 prompt 给足上下文：目标标题与验收、目标约束、所属闭环意图、落地场景流程、
  已有构思/执行项；要求 3 条**不同实现路线**，各带「方案要点 + 差异 + 代价」，
  只输出 `{"ideas":[{"title","approach"}]}`
- 预览弹窗：默认全选，标题与方案都可改，取消勾选的不写入；
  沿用 `split` 草稿机制（关掉面板也能恢复），支持「重新生成」
- 写入：按选中条数创建 idea 子节点（带 approach），并把已闭环的祖先链重新打开


## 0.6.17 — 详情卡移除「聚焦项目」

- 聚焦是全局视角操作，不属于单个节点卡片：动作行去掉「聚焦项目」，
  只保留「完成 / 重开 / 复制 JSON」等与节点本身相关的动作
- 项目聚焦入口仍可从项目信息栏（右栏「聚焦」）进入


## 0.6.16 — 叶子节点长按删除

- 没有子节点、且不是闭环根的节点卡片，footer 多一个「长按删除」按钮
- 交互：按住 0.8 秒蓄力，红色从**左往右**填满 100% 才真正删除；
  中途松手 / 移出按钮 / 失焦 → 立刻回退到 0，什么都不发生
- 删除走现有写回路径（`{card, allowIncomplete:true}`），删父节点最后一个子节点时整条 children 收掉
- 闭环根节点不允许删除（避免卡片失去 loop）；有子节点的节点也拒绝，并给 toast 提示


## 0.6.16 — 详情卡贴着被点的节点出现

- 修「聚焦视图里点子节点，卡片飞到很远」：`_openDetail` 原来用 `querySelector` 取第一个
  `.tnode[data-nid]`，可能是矩阵里那个**隐藏**节点（rect 全 0），于是卡片被摆到左上角
- 现在按可见性挑锚点（宽高、上下、左右都在视口内），都不可见时退回**点击坐标**定位
- 节点点击时把 `{x,y}` 传进 openDetail，作为不可见锚点的兜底
- 版本 0.6.16
- 实测：把锚点节点隐藏后带 (900,500) 打开详情，卡片落在 (912,493)


## 0.6.15 — 标题改为行内编辑

- 标题很短，不再弹大编辑框：点击原地变成输入框（宽度铺满标题行），
  Enter / 失焦保存，Esc 取消，保存后详情卡与矩阵卡片同步
- 其它长字段（约束/验收/落地场景流程等）仍走大编辑器


## 0.6.15 — 所有字段都用可拖拽条目

- 不再区分「有没有编号」：编辑器**始终**用条目卡（左标签栏 + 右内容）
- 无编号文本：按空行切段，每段一张卡，标头只有 `⠿` **不带序号**；
  单段无编号也照样是一张可拖拽卡
- 无编号的序列化：用原来的空行分隔拼回去，不改动正文内容
- 有编号的（`1) A. 一、 -`）保持原行为：标头带序号、拖拽后重排 1)2)3)


## 0.6.14 — 标题可编辑（修）

- 详情卡标题（`h3.detail-title`）点击无反应：`startEdit` 只从 `.detail-row` 取节点，
  而标题不在行内 → 直接 return。改为优先读元素自身 `data-nid/data-proj`，行内元素走原路径
- `FIELD_LABEL` 补 `title:'标题'`，否则编辑器标题栏显示英文键名 `title`


## 0.6.14 — 去掉正文里的重复序号

- 条目正文里自带的「步骤3:」「第2步」「③」「(4)」这类前缀在进入条目模式时被剥掉，
  顺序只由左侧序号表达；拖拽重排后不会再出现「编号变了、正文还写着步骤3」的错位
- 只剥前缀，不动正文其余内容（「总验收：1)-4) 全过…」这种非前缀序号保留）
- 取消（Esc / 取消按钮 / 点外面放弃）不会写回，原文保持不变；只有保存才落盘


## 0.6.13 — 条目卡改为左右两段

- 每条改成「左侧标签栏 + 右侧内容区」：左栏 86px，放拖拽把手 `⠿` 与序号，**垂直居中**
- 右侧内容换行时左侧序号依然上下居中（grid `align-items:stretch` + head 内部 flex 居中）
- 修正文自适应高度：先前在浮层还是 hidden 时量 `scrollHeight`（得到 0），
  内容被裁成一行；现在显示后量一次 + rAF 再量一次，输入时按需重算


## 0.6.12 — 字段编辑器：条目化 + 拖拽排序

- 多条目文本（`1) 2) A. 一、 -` 开头）自动切换成**条目卡**：每条一块马卡龙浅色底，
  标头显示拖拽把手 `⠿` + 序号 + 首句摘要，正文是独立文本区（自动增高）
- 拖拽标头即可重排，松开后自动重排序号（阿拉伯数字 / 字母 / 中文序号按原风格）
- 单段文本（没有编号）仍用原来的整块文本框；两条及以上才进入条目模式
- 修「一次点击关两层」：关编辑器的点击用消费式标记 + 600ms 兜底，不再穿透关详情卡；
  条目间切换焦点不再误判为「点了外面」


## 0.6.11 — 四种状态自动流转（未开始 / 规划中 / 进行中 / 已闭环）

- 详情面板移除「状态」下拉；状态按结构自动派生：只有标题→未开始；有内容且无子节点→规划中；
  有子节点未全闭环→进行中；子节点全闭环→已闭环
- 子节点全闭环时**自动向上闭环**（自动写 `closed_at`，不再需要点「确认关闭」）；叶子点「完成」即闭环
- 已闭环的节点被加子节点 / 重开时，该节点与祖先自动回到进行中
- 阻塞不再靠手动状态位：`issues` 非空即标红，「仅看阻塞」筛选同源
- 打开面板时把旧数据里「子节点全闭环但父节点没关」的结构补正；落盘时 `status` 自动同步为 `plan/doing/done`
- KPI 与归档区文案统一为「已闭环」
- 验证：Playwright 10 项断言（四态显示、阻塞标记、无状态下拉、关子节点→父自动闭环并落盘、
  级联到整条闭环自动收口、移入归档、零前端异常）全过

## 0.6.10 — 修复「写入失败：校验未通过」

- 根因：面板新建/AI 拆出的节点都带 `issues: []`，而校验器把「非 exec 节点上有 issues 字段」判成错误，
  空数组也拦 → 整卡 422；节点只活在面板内存里，重载后消失（也就是之前「找不到节点：…」的来源）
- 校验器：只有 issues **非空**且节点不是 exec 才报错（兼容旧面板与旧卡片）
- 面板：新建目标不再带 issues；写入失败时把具体校验错误带进提示（不再只说「校验未通过」）
- 验证：单测 3 项 + PUT 集成 2 项 + Playwright 端到端 6 项全过（隔离 fixture，未碰真实卡片）

## 0.6.9 — 「生成」按钮替代「据此填充」：按标题补齐空字段

- 移除字段行里的「据此填充」；详情面板标题/路径右侧改为一个「生成 N 项」按钮，一次补齐该节点所有空字段
- 规则：**标题是唯一必需项**——有标题就能生成其余空字段；标题为空或占位（`新目标（待命名）`）时按钮禁用并提示先写标题
- host：补全字段按节点类型计算（loop: 目标/场景流程/约束/验收；goal: 约束/验收；idea: 方案；exec: 验证），
  prompt 按节点类型给上下文；节点在磁盘上不存在时返回 `409 + code=NODE_NOT_FOUND`
- 面板：遇到 `NODE_NOT_FOUND` 自动刷新卡片并提示重试，不再只弹「找不到节点」
- 修复 `isBlankTitle`：把 `新目标（待命名）` 这类占位标题也算作空标题
- 验证：`/api/fill` 字段计算 5 项断言通过；Playwright 按钮交互 7 项断言通过

## 0.6.8 — AI 拆目标结果不再丢（切走 / 重开后可恢复）

- 根因：预览结果只存在面板内存；切到别处或重开时 iframe 卸载，轮询循环终止，
  会话在宿主侧跑完了却没人接住结果
- host：`taskId=split-goals` 的会话结束后，结果落盘到
  `~/.dsh/rotation/splits/<file>__<node>.json`；新增 `GET /api/splits?file=`、
  `DELETE /api/splits?file=&nodeId=`
- 面板：打开时提示「N 条 AI 拆解结果待确认」；点「+ 目标」→「AI 拆出目标」优先恢复草稿
  （不再重复烧一次会话），预览里多一个「重新生成」；确认写入后自动清掉草稿
- 验证：dev-host 上跑完后落盘/列出/删除 3 项通过；Playwright 恢复流程 7 项断言通过

## 0.6.7 — 修复嵌入 DSH 主区时的布局塌陷

- 根因：工具栏末尾那条长说明（`#toolbar-hint`）是可压缩的 flex 项，在 DSH 主区 iframe
  （约 920px 宽）里被压到 35px，文字逐字竖排，把工具栏撑到 **253px 高**，树区被推到下半屏
- 修复：工具栏内 `.hint` 一律单行 + 省略号截断（不再逐字换行）；嵌入模式直接隐藏这条长说明
- 验证：Playwright 在真实 iframe（920×700）复现，修复后工具栏 253px → 33px、
  首个泳道 y=355 → 135；非嵌入 1280/1500 宽下工具栏单行、无横向溢出

## 0.6.6 — 字段字数上限 200 → 300

- 长文本字段（闭环目标 / 落地场景流程 / 约束 / 验收）上限放宽到 **300 字**
- 同步五处限制：填充 prompt 的硬性约束、host 落盘截断（`FIELD_MAX`）、
  校验器超限警告阈值、面板大编辑器计数器、AI 拆目标 prompt 的验收字数
- 标题仍单独限长（规范建议 ≤60 字；「据此填充」时截到 40 字），避免标题撑破卡片布局

## 0.6.5 — 改名「轮转闭环树」+ 刷新真实拉取

- 插件显示名 闭环树 → **轮转闭环树**：左栏入口、面板标题、浏览器标签、文档与市场描述同步
  （包名 `dsh-looptree-dashboard`、路由 `/rotation`、插件 id 均未变）
- 顶部「刷新」按钮改为**真的重新拉取**：`GET /api/cards` 重载项目 + 刷新服务/会话状态，
  提示改为「已刷新 · N 个项目」；失败时提示「刷新失败：连不上本地服务」
  （旧版只重绘内存，提示还写着「原型：数据仍是 mock」）

## 0.6.4 — 字段对齐与字数收敛

- 详情卡标签列固定 74px 宽、不换行、顶部对齐：闭环目标 / 落地场景流程 / 约束 / 验收 现在左对齐成一列
- 工具栏改为单行 + 横向滚动，窄窗口不再把按钮拆成两行
- 每个字段收敛到 **≤200 字**；落地场景流程 **3–5 步**、约束 **3–5 条**、验收 **3–5 条**
  - 填充 prompt 里写成硬性限制
  - host 落盘前按上限截断（优先在句号/分号处断，避免半句话）
  - 校验器对 >200 字给警告（不阻断，手写的长文也能存）
  - 大编辑器底部显示实时计数「N / 200 字」，超限变红
- 实测：全空卡片一次填充得到 目标 51 字 / 流程 3 步 163 字 / 约束 5 条 114 字 / 验收 4 条 120 字

## 0.6.3 — 闭环目标升为第一位

- 「意图·预期」改名「**闭环目标**」，成为闭环卡片的第一字段；「落地场景流程」第二位
- 「据此填充」纳入闭环目标：空白时一句话写清「做完之后能稳定做到什么」，写结果不写手段；
  若已有场景流程，两者必须一致
- 填充顺序：标题 → 闭环目标 → 落地场景流程 → 约束 → 验收
- 模板 / rotation-card-spec.md 同步字段顺序与表述
- 实测：字段顺序「闭环目标 / 落地场景流程 / 约束 / 验收」；目标与流程都空时，一次填充产出
  可判定的目标 + 5 步流程

## 0.6.2 — 落地场景流程为主字段

- `scenario` 改名「落地场景流程」，并提到闭环字段的**第一位**（它是意图的延展，也是最重要的预期）
- 卡片 chip 文案改为「流程 N 步」
- 「据此填充」顺序改为：标题 → 落地场景流程 → 约束 → 验收
- 生成约束与验收时**以场景流程为唯一依据**：验收每条对应流程的某一步、总验收写成「几步全过即达成」；
  约束从流程的边界与前提里来；如果流程缺关键信息，先按最合理方式补齐再据此推导
- 模板与 rotation-card-spec.md 同步改名与顺序
- 实测：卡片字段顺序「落地场景流程 / 意图·预期 / 约束 / 验收」；真实会话产出的验收逐条写着
  「对应流程第 N 步（…）」；chip 显示「流程 4 步」

## 0.6.1 — 场景闭环验证

- 闭环卡片新增 `scenario`（场景闭环验证）：写「闭环真正跑通后，用户从头到尾能走通的完整操作流程」
- 三步式结构：每步「操作 / 预期 / 体验」三行，编号 1)–N)，3–6 步；编辑器里是普通文本，改完即存
- 卡片增加计数 chip「场景 N 步」（按编号数步骤），详情卡里按字段编辑
- 「据此填充」纳入这一项：只对闭环、只在空着时补；prompt 里给出固定的三步式骨架与写法要求
- 校验器：`scenario` 必须是字符串；非闭环节点写了只给警告（会被忽略）
- 模板 `templates/card.rotation.json` 与 `rotation-card-spec.md` 补示例
- 实测：真实会话为测试卡片生成 3–5 步的场景（每步含操作/预期/体验），写盘成功；卡片 chip 生效

## 0.6.0 — 改名「闭环树」

- 插件显示名与包名统一：`闭环树` / `dsh-looptree-dashboard`（原名 `dsh-rotation-dashboard`）
- 左栏图标换成**从左到右展开的树**（根在左、两根分叉到右侧子节点），与「树形收敛」一致
- 面板标题、副标题、README / INSTALL / docs 全部同步新名字
- 迁移：profile 里旧键 `dsh-rotation-dashboard` 需移除后再装新的（link 路径不变）

## 0.5.2 — 跨平台开发环境

- `validate:samples`、`preflight` 改成纯 node 脚本，Windows 上无需 bash
- 会话全文解压失败时给出安装 `zstd` 的明确提示（macOS/Windows/Linux 各自的命令）
- 新增 `docs/dev-setup.md`：本地/远程环境分层、Windows 开发 SOP、平台差异清单、
  从零重建流程、发布流程与检查清单

## 0.5.4 — 分层关闭 + 编辑器改版

- 修：关字段编辑器的那一下点击会继续穿透，把详情卡也一起关掉。
  现在用 `suppressDocClick` 标记吞掉这一次点击：**一次点击只关一层**
  （编辑器 → 详情卡 → 再点才轮到卡片）
- 编辑器改版：顶部「编辑字段」kicker + 字段名 + 节点上下文（闭环 · 标题）、右上 × 关闭、
  底部提示与「取消 / 完成」按钮、遮罩加深、圆角 14px、阴影分层、输入区带底色与聚焦描边

## 0.5.3 — 字段编辑弹出大编辑区

- 点详情卡里的字段不再就地变成小文本框，而是弹出**居中大编辑器**
  （宽 min(720px, 92vw)、高 min(46vh, 420px)，可拖高），适合编辑长验收/约束
- 点编辑器外面（遮罩）→ 保存并关闭，**详情卡保持打开**；再点卡片外面才关卡片
- ⌘/Ctrl+Enter 保存，Esc 取消；`#field-pop[hidden]` 补 display:none（否则透明度为 0 仍拦点击）
- 详情卡不再贴模型原始 JSON（字段已在上面），改为一行「模型已返回 N 字，点查看会话」
- 新增「在 DSH 打开」：面板 postMessage → client 半 `uiWorkspace.openSession(sessionId)`，
  直接切到 DSH 里那条会话（实测：iframe 关闭、主区显示该会话全文）
- 「最后」一行补 brief（工具调用/模型回复/回合结束），不再显示 undefined；字段标签不换行

## 0.5.2 — 节点卡片可读性

- 卡片不再直接铺长文本：`意图/验收/方案/验证` 压成**一句摘要**（首句，超 42 字省略），
  单行省略号 + 悬停看全文
- 增加计数 chip：`N 目标 / N 构思 / N 执行 / 验收 N 项`（自动识别 A. 1) - 这类编号）
- 标题最多两行（原本就是 clamp，保持），长内容撑高卡片的问题随之消失

## 0.5.1 — 据此填充移到 host，关面板也不丢

- 「据此填充」从面板内轮询改为 **host 侧执行**：`POST /api/fill` 起会话，
  `onFinish` 里统一解析 JSON 并写卡片；面板关掉、刷新、切走都不影响结果
- 只要还有任一空白（标题占位 / 约束 / 验收）按钮就可点，每次只补缺的那些
- prompt 换成「项目背景 + 质量要求」：给项目目录、意图、已有目标，要求先读
  仓库再作答；验收要可判定（命令/退出码/轮数），约束要落到数字
- 面板发起后后台盯一眼状态，完成后自动重载卡片

## 0.5.0 — 会话直接进 DSH 侧栏

- host 声明 `workspaceRegistry` 服务；会话创建后立刻
  `workspaceRegistry.resolveByPath(cwd).attachSession(sessionId)`，
  于是「轮转」发起的会话**从一开始就是 DSH 里的普通会话**（侧栏可见、可点开续聊），
  不再是事后追加
- 会话头未落盘时自动重试一次；失败只记警告，不影响本轮运行
- 实测：`/api/run` 跑出的 session-253b00d9… 出现在 english-shadow 工作区的
  `sessionIds` 首位，`/api/session` 能读到完整 4 条事件

## 0.4.1 — 会话全文可见 + 标题自动补

- 会话区新增「查看会话」：host 直接读 DSH 落盘的
  `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`，按事件还原
  用户 / 模型 / 工具调用 / 工具结果 / 回合结束，面板里以弹窗全文展示
- 新增「最近会话」：列出该项目工作区下最近 20 条会话（按时间倒序）随时点开
- 「据此填充」现在也会补标题：空标题或占位名（待命名闭环 / 未命名…）→ 让模型起名并写回
- 校验：`缺少 title` 也纳入宽松模式（草稿可落盘）
- 多帧 zstd 兼容：node 只解第一帧时自动改用 `zstd -dc` 兜底

## 0.4.0 — 闭环/目标字段迭代

- 字段改名：`意图` → `意图·预期`
- 新增 `constraints`（约束）字段，闭环与目标各有；渲染在「验收」上方
- 就地展开编辑：字段平时两行省略，点击变成大编辑区（可拖高），
  **失焦自动保存**，⌘/Ctrl+Enter 立即保存，Esc 放弃；去掉「保存 / 取消」按钮
- 「据此填充」：闭环/目标行右侧按钮，按「意图」调模型补齐缺失字段（验收 / 约束），
  解析 JSON 后回填并落盘；无缺失项时按钮置灰
- 写入改为**宽松校验**：缺验收/验证/证据只给警告（`allowIncomplete`），
  允许边填边存，不再因为「另一个字段还空着」而 422 丢编辑

## 0.3.3 — 修工作区路径

- 修：`DSH_HOME` 缺省时直接用了 home 目录，拼出 `/Users/<user>/storages/workspace.json`（ENOENT）
- 现在缺省拼 `~/.dsh`，且兼容 `DSH_HOME` 指向 `~/.dsh` 或它的父目录；文件不存在时再回退到 `~/.dsh/storages/workspace.json`
- 实测：端点返回 15 个工作区，弹窗下拉 15 项，无「读取失败」提示

## 0.3.2 — 只列未登记的工作区

- `/rotation/api/workspaces` 过滤掉已登记进轮转的目录，并返回 `total` / `registeredCount`
- 添加项目弹窗去掉目录输入与「选择…」，只剩「工作区下拉 + 名称」
- 没有可选项时给出明确原因（端点未加载 / 全部已登记），并提示先去 DSH 添加工作区
- 实测：15 → 登记 1 个后剩 14；重复登记返回 409；弹窗无 picker/目录行

## 0.3.1 — 添加项目时直接选 DSH 工作区

- 添加项目改为**下拉选 DSH 已有工作区**（读 `~/.dsh/storages/workspace.json` 的
  `tables.workspaces`，返回 title + path），最后一项是「手动输入 / 选择其它目录…」
- 选中工作区后名称自动带出工作区标题；同一目录重复登记返回 409
- 新增 `GET /rotation/api/workspaces`；原来的原生目录选择保留为手动模式的备选
- 修 `.detail-row[hidden]` 被 `display:flex` 覆盖导致手动行一直显示

## 0.3.0 — 添加项目可直接选目录

- 添加项目弹窗新增「选择…」：优先用宿主自带的 `__DSH_DIRECTORY_PICKER__`（桌面端），
  否则调用 host 的 `POST /rotation/api/pick-directory`（macOS `osascript choose folder`）
- 目录输入框接 `<datalist>`：已在轮转里的项目目录自动成为下拉建议
- 实测：弹窗结构、按钮与 datalist 均存在；独立面板下 GET 端点返回 501（仅接受 POST）

## 0.2.9 — 桌面外壳真正连上

- 根因：boot 里用 `location.protocol.startsWith('http')` 作为「能不能调 API」的判据，
  桌面外壳的 iframe 是 `dsh-app:`，于是**数据请求根本没发**（诊断里探测 200 但面板仍显示未连接）
- 三处守卫（读 cards / 读 run-config / 写卡片）统一改成 `API_BASE` 是否存在：
  探测成功后的绝对地址同样能读写

## 0.2.8 — 连接诊断

- 连不上保存服务时，状态行可点击 → 弹出诊断面板：页面/协议/origin、注入的候选与版本、
  每个候选的探测结果（状态码或错误名）、父窗口 URL 与 `__` 全局
- 修：0.2.3 里那句离线提示的替换静默失败，界面一直显示旧文案（也掩盖了点击入口）

## 0.2.7 — 私有网络预检

- API 的 CORS 响应补 `Access-Control-Allow-Private-Network: true`：
  桌面外壳（`dsh-app://`）跨源访问 `127.0.0.1` 时，Chromium 的 PNA 预检可能拦下请求

## 0.2.6 — 版本标签真的生效

- 0.2.5 只注入了 `__ROTATION_VERSION__`，但面板侧消费代码的目标串不匹配（静默没插进去），
  标签仍显示「原型 v0.3」；本次把消费代码插到稳定锚点，副标题与 `<title>` 都显示真实版本

## 0.2.5 — 版本号显示

- host 半注入 `window.__ROTATION_VERSION__`，面板顶部副标题从「原型 v0.3」改为真实插件版本
  （之前容易误读成「还是原型」）

## 0.2.4 — 候选 API 地址探测

- host 半在 index.html 注入**候选** API 地址（Host 头 / 探测到的监听端口 / 相对路径），
  面板在非 http 协议下逐个探 `/health`，第一个通的就用
- 服务端口探测：`ctx.webServer.port|listeningPort|address()|server.address()` 与 `--port` 参数
- `/health` 增加 `server` 段（port / argvPort / 可用键），便于排查桌面端地址问题

## 0.2.3 — 主题跟随 + 桌面端 API 地址

- **主题跟随 DSH**：client 半读宿主 `html[data-theme]`（并观察变化 + 系统偏好），
  通过 `?theme=` 与 `postMessage` 同步给面板；面板首屏即按宿主主题渲染
- 修：空注册表时 boot 跳过 render，导致主题停在默认 dark（嵌入浅色 DSH 里发黑）
- 修：`updateKpis`/`render` 在空项目列表下抛错（`Cannot read properties of undefined`）
- **桌面端 API 地址**：host 半把 `http://<Host>/rotation/api` 注入到 index.html
  （`window.__ROTATION_API_ABS__`），面板在非 http(s) 协议下优先用它；API 加 CORS
  与 OPTIONS 预检，解决 `dsh-app://app` 里相对路径到不了 HTTP 服务的问题
- 注入值做 `</script>` 转义，防 Host 头注入

## 0.2.2 — 去掉浮标

- 移除右下角「轮转」浮标（DOM 注入、弹窗兜底、激活隐藏逻辑一并删除）
- 唯一入口 = 左栏「闭环轮转」；独立 URL 打开时仍有「← 返回 DSH」
- 真机验证：`#dsh-rotation-launcher` 不存在、激活标记仍在、侧边栏点击后 iframe 正常、零报错

## 0.2.1 — 侧边栏入口

- **侧边栏条目**：`sidebar.panellist` 注册「闭环轮转」（在「插件 / 自动化任务」之后），
  点击在主区以 iframe 打开面板（`main` 槽，key=`rotation`）
- 嵌入模式：iframe 内隐藏「← 返回 DSH」，工具栏改单行紧凑并可横向滚动
- 面板激活时隐藏右下角浮标「轮转」，避免两个入口重复
- 启动器改为优先 `ctx.layout.selectPanel('rotation')`（应用内切换），失败再退回 URL
- 「← 返回 DSH」在有/无历史时都能回到 DSH 根路径；连不上保存服务时状态行可点击重载

## 0.2.0 — 真机可用

从「原型 + 本地服务」变成「装进 DSH 的插件」，并在真实 DSH 进程里逐项验证。

### 新增
- **插件形态**：`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 自动挂载；`lib/client.js` 走 `__ModuleLoader__`
- **host 路由** `/rotation/*`：面板静态资源 + `/api/health|projects|cards|run*|services*`
- **数据层**：注册表 `~/.dsh/rotation/registry.json` + 卡片 `<workspace>/.dsh/rotation.json`；写入走 validate → `.bak` → tmp+rename
- **节点会话**：`ctx.agents.create` + `agent.followup` + `ctx.on('session/event')`，结果写回卡片 `session` 字段
- **项目服务**：探活 / 一键拉起 / 停止 / 日志预览
- **项目移除**：`DELETE /api/projects/<id>` + 泳道悬停 ✕（不删项目文件）
- **入口**：DSH 右下角常驻「轮转」按钮（右栏 tab 在 0.2.1-rc.3 不渲染，已放弃）
- **provider/model 钉死**：注册项目时可指定，便于把项目钉到网关路由
- **工程化**：`npm run preflight`（lint / client 契约 / 会话状态机 / 样例 / tarball 五段）、`scripts/real-plugin-check.sh`（一次性 profile 真机验证）、`scripts/migrate-samples.mjs`、`scripts/check-install.mjs`
- **文档**：`docs/architecture.md`、`INSTALL.md`（安装 / 验证 / 升级 / 回滚 / 网关 patch）

### 修复（都是真机才暴露的）
- client bundle 的 `id` 必须是**包名**，否则 `web boot: 1 entry did not activate`
- client 必须导出 `inject = ['slots']`
- host 必须在 `inject` 里声明 `agents` / `agentDefaultModel`，否则 `/api/run` 500
- `turn/end` 要透传 `reason.error.message`，否则卡片只显示「turn 结束原因：error」
- 中文项目名派生 id 会撞 `ID_RE`，改为退回 `project-<随机>`
- 同版本 `file:` 包重装是空操作（pnpm 缓存），升级必须 `remove` + `add`
- 空注册表曾退回样例数据，导致看不到空状态引导
- `[hidden]` 被 `display:flex` 覆盖，空状态与矩阵同时出现
- 后台标签页不刷新运行状态
- preflight 的 mock 会写脏真实注册表

### 真机验证记录
- host 三路由 200；client 半进 boot 清单并零错误激活
- 服务链路（真机）：探活 `down` → 拉起 `up pid=…` → 停止 `down`，5822 端口释放
- `npm run check` 在真机实例上三项全绿
- 面板在真实浏览器里：空状态 → 注册项目 → 泳道渲染 → 数据源可写回
- 真实会话：`POST /api/run` → `assistant/message "OK"` → `turn/end completed` → 卡片 `session.result = "OK"`

## 0.1.0 — 原型
静态面板（`index.html`）：泳道视图、详情卡、结构化 prompt、14 天趋势、健康度评分、服务探活、会话状态点、已关闭节点折叠。
