# Prompt 规范（查看 / 变更 / 发送）

这份文档是 prompt 结构的唯一权威定义；实现落在 `lib/prompt.mjs`。
改格式先改这里，再改代码与 `scripts/prompt-mock.mjs` 的断言。

## 一、为什么要统一

1. **会话气泡是纯文本**：DSH 的用户消息是 `white-space: pre-wrap`，不渲染 markdown；
   `#`、`**` 会原样露出来。所以结构只能靠「空行 + 短行 + 标签」，不能靠 markdown 语法。
2. **以前有两套实现**：host 的 `buildPlanTask / buildExecPrompt` 与面板的 `composePrompt`
   各写一份，格式不同、先后漂移；动作 prompt 还被 `oneLine()` 压成一行塞进 `/plan`，
   人看到的是糊墙，模型拿到的也是一行。
3. **一条 prompt 会出现在四个地方**：详情卡模板、发起弹窗、发送前的预览、会话气泡。
   四处的文本必须是同一份，否则「看到什么」和「发出去什么」对不上。

## 二、唯一实现

`lib/prompt.mjs`（纯函数、无 I/O）：

| 函数 | 用在哪 |
|---|---|
| `composeTaskPrompt` / `listTaskPrompts` | 详情卡的 prompt 模板（`GET /api/prompts`） |
| `composePlanPrompt` / `composeExecPrompt` / `composeReflectPrompt` | 能力闭环动作：生成计划 / 执行计划 / 反馈提炼 |
| `composeGoalObjective` | `/goal` 的单行目标（执行计划用，指向能力闭环的 `plan`） |
| `actionCommand` | 动作 → 真正发出的斜杠命令 |
| `composeSplitPrompt` | 里程碑「AI 拆出主要能力闭环」（输出 `{"capabilities":[...]}`） |
| `composeCandidatePrompt` | 里程碑 → 候选能力闭环（重要性排序 + 模块归属 + 缺失影响 + 协同面） |
| `composeFillPrompt` | 按标题补全（里程碑补 capabilities；能力闭环补模块信息 + metric + approach） |
| `composeCollectServicesPrompt` | 项目级「服务信息收集」（`POST /api/services/collect`，JSON 契约见下） |
| `lintPrompt` | 结构自检（测试与面板提示共用） |

面板不再自己拼 prompt：查看、复制、发起、动作预览都走 `GET /rotation/api/prompts`。
`goal` / `idea` 语境已退役（2026-10-31 收敛成 `capability`）：没有 `composeIdeaPrompt`，拆解也不再产出目标和构思。

## 三、格式规范

### 骨架

````
生成计划 · 能力闭环「章节→情节索引」     ← 首行：一眼知道这条 prompt 干什么

背景                                  ← 块标签单独一行，2–4 字
- 项目：<name>（<workspace>）
- 里程碑：<title>
  - 里程碑愿景：<vision>
  - 主要能力闭环：<capabilities>
- 能力闭环：<title>
  - 承接能力闭环：<capability>
  - 必要性：<necessity>
  - 因果：<causal>
  - 核心指标：<metric>
  - 实现思路：<approach>

要做什么
1. 一行一个动作
2. 先读项目里的文件，再写计划
3. 计划要能被独立执行：每条步骤都带可判定的完成判据

非目标
- 明确不做什么，防 scope creep

证据要求
- 先复现现状（命令 / 路径 / 产物），引用成 path:line
- 未决问题写「未确认：缺什么证据」，不猜

输出
用 Markdown，三节顺序固定：
## 目标
…
## 验证命令
```bash
…
```
## 步骤
1. …

提交方式
- 写完用 exit_plan_mode 提交，plan 传完整 markdown。
- 不要直接开始执行。
````

允许的块标签：`背景` `当前节点` `任务` `要做什么` `证据要求` `非目标`
`约束` `输出` `验证命令` `步骤` `提交方式` `收尾` `质量要求` `示例`。
`场景` / `验收` 两个块随 `scenario` / `acceptance` 字段退役，新模板不再使用。

块的用途（新增块别混用）：

| 块 | 解决的问题 | 典型模板 |
|---|---|---|
| `证据要求` | 规定读什么、引用成什么格式、先复现什么、未决问题怎么写 | 生成计划、候选生成、拆主要能力闭环 |
| `非目标` | 明确不做什么，防 scope creep | 生成计划 |
| `示例` | 只给契约（JSON 形状 / 字段级要求），不给完整 few-shot | JSON 生成类 |
| `约束` | 标题长度、字数预算、字段归属这类硬边界 | 候选、补全、拆解 |

### 规则

1. 首行必须 `动作 · 对象`；对象写「类型「标题」」，标题超过 24 字截断。
2. 首行后空一行；块之间空一行；块标签单独成行，不加 `#`。
3. 块内一行一个事实/动作；键值 `- 键：值`；步骤 `1. `。
4. 空数据不出块，不留空标题。
5. 单行视觉宽度 ≤ 72 列（CJK 记 2、ASCII 记 1），超了按标点/空格折行、续行缩进两格。
   代码块与 JSON 契约行不折。中文标签变长（如「承接能力闭环」）时优先换行，别破 72 列。
6. 不用 `#` / `**` / `>`；唯一例外是「输出」块里要求模型产出的 markdown 小节。
7. 动作 prompt ≤ 1500 字；超了把细节留在卡片里，用 id 引用。注入的长字段
   （里程碑愿景 / 主要能力闭环 / 能力闭环四件套 / 计划步骤）有裁剪预算（120–220 字，`supportLines` /
   `numberedItems` / `clipText`），截断处标 `…（全文见卡片）`——全文本来就在 `rotation.json` 里，
   执行者需要时自己读。
8. 不复述上下文；同一事实只出现一次。`背景` 已有能力闭环核心指标时，计划正文不再单列重复判据。
9. `/goal` 的目标必须单行、≤ 240 字（目标面板按一行显示）。
10. 每行都要能映射到该阶段的完成判据；映射不上的行删掉，别拿「通用最佳实践」凑长度。
11. **列表字段的 JSON 值必须是字符串数组**：`capabilities` / `metrics`
    写成 `{"capabilities": ["…", "…"]}`，一条一个元素；元素内不换行、行首不加 `○ · •` 符号前缀。
    host 侧 `normalizeListValue()`（`lib/core.mjs`）把数组拼成「一条一行、每行 `N)`」后落盘。
    禁止输出成一段用符号分隔的文本——条目编辑器认不出符号时会把多条揉成一个融合块（2026-10-30 用户反馈）。

### 卡片字段 ↔ prompt 口径

| 卡片字段 | 注入位置 | 口径 |
|---|---|---|
| `project.vision`（项目愿景） | 里程碑「生成」的 `背景`（裁剪 160 字） | 这个项目最终要变成什么样；项目愿景是里程碑愿景的上位参照，只进里程碑补全，进其它节点会稀释当下任务 |
| `milestone.vision`（里程碑愿景） | `背景` 一行（裁剪 200 字） | 这个里程碑之后项目/用户变成什么样；补全时要求 3–6 句宏大叙事、≤1000 字、不写功能清单；拆解/候选时只注入前 300 字（超长标「全文见卡片」） |
| `milestone.capabilities`（主要能力闭环） | `背景` 一条一行（`supportLines`）；补全/拆解时为「约束」+「质量要求」块 | 3–5 条「要什么才能让愿景成立」，按重要性排序、从第一性原理写；候选生成的唯一输入，为空时拒绝生成候选（`409 CAPABILITIES_REQUIRED`） |
| `capability.capability`（承接的主要能力闭环条目） | `背景`（只读） | 照抄 `milestone.capabilities` 的一条原文，≤80 字；候选采纳时写入，人不改 |
| `capability.necessity`（必要性） | `背景`（只读） | 为什么这条能力闭环能帮里程碑达成；候选生成产出，采纳后不改 |
| `capability.causal`（与闭环的关系） | `背景`（只读） | 它让这个能力闭环的哪一步成立；候选生成产出，采纳后不改 |
| `capability.gap`（缺失影响） | `背景`（只读） | 缺了这块能力，闭环断在哪、谁受影响 |
| `capability.module`（功能模块） | `背景`（只读） | 模块名/路径，或能力域（UI 展示 / UX 动画 / 布局审美 / 内容管线） |
| `capability.collaboration`（协同面） | `背景`（只读） | 和哪些组件协同、通过什么接口 / 事件 / 数据 |
| `capability.metric`（能力闭环核心指标） | `背景` + 计划/执行的判据 | 到什么程度算这条支撑撑住里程碑；生成计划的前置条件（`409 FILL_REQUIRED`） |
| `capability.approach`（实现思路） | `背景` + 计划的思路骨架 | 核心思路，通俗简短；生成计划的前置条件（`409 FILL_REQUIRED`） |
| `capability.plan`（计划书） | 执行计划时读 `plan.goal / verify / steps` | 由「生成计划」写回；缺失时执行被拒（`409 PLAN_MISSING`） |
| `exec.verify` / `proof` / `issues[]` | 记录卡的 `当前节点` | 验证命令 / 证据 / 未处置反馈；执行完自动反馈提炼写 `milestone.lessons` |

`capability` / `necessity` / `causal` 是**只读三件套**（候选论证的落点），
`metric` / `approach` 是**可写两项**（人的判断），两者在 prompt 里的注入位置一样、来源不同。

### lint

`lintPrompt(text, { maxLength })` 返回 `{ ok, warnings:[{ line, code, message }] }`。
codes：`missing-title` `bad-title` `missing-blank` `line-too-long` `markdown-bold`
`tab` `trailing-space` `double-blank` `empty-block` `too-long`。

样例卡的全部模板与动作 prompt 必须零警告，见 `scripts/prompt-mock.mjs`。

## 四、四份生成契约

### 4.1 候选生成（里程碑 → 能力闭环）

入口：`POST /rotation/api/candidates/generate` `{file, nodeId, count}`。

- **前置**：`milestone.capabilities` 非空；为空时 `409 CAPABILITIES_REQUIRED`，不退化成「按愿景缺口编抽象支撑」。
  候选池里还有未处理候选时也拒绝（先处理掉）。
- **条数**：`count` 夹在 1–6；每条候选承接一条**不同**的主要能力闭环，条数不超过 `capabilities` 条数。
- **证据**：先读 README / 目录 / 现有模块（读代码 / 跑命令 / 看产物），再判断「改造现有还是新增」；
  `evidence` 指到文件 / 命令 / 输出，不写「已确认」这类空话。

输出契约（严格 JSON 数组，不输出其它文字）：

```json
[
  {
    "title": "章节索引落盘",
    "capability": "章节→情节索引",
    "necessity": "没有索引，情节图只能读临时数据，打开项目看不到真实情节。",
    "causal": "索引落地后，情节图第一次能挂在真实章节上，第一层图才成立。",
    "gap": "缺它三层图没有数据源，改完章节图不更新，评审只能看截图对稿。",
    "module": "src/plot/index.ts（情节索引层）",
    "module_mode": "existing",
    "collaboration": "读章节源文件；向渲染层提供 plot tree；与大纲共用章节 id。",
    "importance": 5,
    "evidence": "src/plot/index.ts 不存在；README 的「打开即见」段没有实现入口"
  }
]
```

- `importance` 1–5（5 = 最该先做）；host 解析时**按 importance 降序稳定排序**后落盘，cap 6。
- `module_mode` 只能是 `existing`（改造现有）/ `new`（新增）；`existing` 必须能在项目里指到模块。
- 缺 `necessity` / `causal` / `gap` / `module` 的候选在解析时丢弃——这四项答不出「缺了会怎样、落在哪」。
- 采纳（`POST /candidates/adopt`）把 `title` / `capability` / `necessity` / `causal` / `gap` /
  `module` / `module_mode` / `collaboration` 全部写进新的 `capability` 节点，`metric` / `approach` 留空，
  由面板「生成 N 项」补齐；不锁定候选池（能力闭环可以有多条备选）。

### 4.2 补全（里程碑 → capabilities；能力闭环 → metric + approach）

入口：`POST /rotation/api/fill` `{file, nodeId}`，由节点卡「生成 N 项」触发。只补缺项：

- **里程碑**（缺 `vision` / `capabilities`）：先项目愿景、再里程碑愿景、再主要能力闭环（里程碑不再有核心指标）。
- **能力闭环**（缺 `capability` / `necessity` / `causal` / `gap` / `module` / `module_mode` /
  `collaboration` / `metric` / `approach`）：只补被点名的缺项——迁移过来的老节点会一次补齐模型信息与指标思路。

输出契约：

```json
// 里程碑：列表字段一条一个元素
{"capabilities": ["章节→情节索引", "三层联动渲染", "首屏性能 ≤ 800ms"]}
```

```json
// 能力闭环：字符串字段（缺什么补什么）
{"gap": "缺它闭环断在打开即见这一步，后面三层都无从谈起。",
 "module": "src/plot/index.ts（情节索引层）", "module_mode": "existing",
 "collaboration": "读章节源文件；向渲染层提供 plot tree。",
 "metric": "全部章节可索引，任一情节可双向查到所属章节，缺索引章节为 0。",
 "approach": "扫章节文件建索引，按章节 id 建双向映射，先只支持一种格式。"}
```

- `capabilities` 3–5 条、按重要性排序，整段 ≤300 字；host 用 `normalizeListValue()` 拼成「N)一条」落盘。
- `metric` / `approach` 各 ≤300 字；`metric` 写「到什么程度算撑住里程碑」，不写测试命令。
- `gap` / `module` / `collaboration` 按候选同口径：缺失影响写后果、模块写落点、协同面写接口/事件/数据。
- 只输出被要求的字段，多写的一律丢弃。

### 4.3 拆解（AI 拆出主要能力闭环）

入口：里程碑卡的 **+ 能力闭环 → AI 拆出主要能力闭环**（走 `POST /api/run` 的拆解模板，草稿存 `~/.dsh/rotation/splits/`，预览勾选后写回 `milestone.capabilities`）。

- 输入：项目愿景 + 里程碑愿景 + 已有主要能力闭环。
- 输出契约：

```json
{"capabilities": ["章节→情节索引", "三层联动渲染", "首屏性能 ≤ 800ms"]}
```

- 3–5 条，**按重要性排序**，从第一性原理写「要什么才能让愿景成立」；不写功能清单、不写手段。
- 写入 `milestone.capabilities`（一条一行，`N)` 编号），**不直接建能力闭环节点**——
  能力闭环由候选池采纳产生，拆解只负责把「主要能力闭环」写清。

### 4.4 计划 / 执行（吃 `metric` + `approach`）

| 动作 | 端点 | 前置 | 产出 |
|---|---|---|---|
| 生成计划 | `POST /api/action/plan` | `capability.metric` 与 `capability.approach` 都非空，否则 `409 FILL_REQUIRED` | `capability.plan`（目标 / 验证命令 / 步骤 / 全文） |
| 执行计划 | `POST /api/action/exec` | `capability.plan` 非空，否则 `409 PLAN_MISSING` | `exec` 记录 + 会话结果 |
| 反馈提炼 | `POST /api/action/reflect` | 有一条完成的 `exec` 记录 | `milestone.lessons[]` |

- 计划 prompt 的 `背景` 注入能力闭环四件套（承接 / 必要性 / 因果 / 指标 / 思路）；
  任务块要求「计划要能被独立执行」，每步带可判定的完成判据；输出仍是三节 markdown（目标 / 验证命令 / 步骤）。
- 执行计划 = 同一会话先（或已在）`/plan off`，再 `/goal <单行 objective>`；
  objective 只写「读哪个节点的 plan、按步骤执行、先跑验证、收尾写什么」，计划全文留在卡片里。
- 只有能力闭环能「生成计划 / 执行计划」；给里程碑或执行记录发起动作返回 400（`NOT_SUPPORT`）。

### 错误码

| 状态码 | code | 触发 | 人话 |
|---|---|---|---|
| 409 | `CAPABILITIES_REQUIRED` | 里程碑没有 `capabilities` 时生成候选 | 先在「主要能力闭环」里写清 3–5 条，再生成能力闭环候选 |
| 409 | `FILL_REQUIRED` | 能力闭环缺 `metric` / `approach` 时「生成计划」 | 先补核心指标与实现思路（或点「生成 2 项」） |
| 409 | `PLAN_MISSING` | 能力闭环还没有 `plan` 时「执行计划」 | 先生成计划 |
| 409 | `RUN_ACTIVE` | 同一节点已有会话在跑 | 等当前会话结束 |
| 409 | `NODE_NOT_FOUND` | 面板数据与磁盘不一致 | 刷新面板 |
| 400 | `NOT_SUPPORT` | 给非能力闭环发起动作 | 只有能力闭环能生成 / 执行计划 |
| 422 | — | 写回校验不通过 | 按错误文本补字段（校验规则见 `rotation-card-spec.md`） |

## 五、发送编排

| 动作 | 发出去的命令 | 正文 |
|---|---|---|
| 生成计划（plan） | `/plan\n<结构化正文>` | 整段正文就是命令参数，换行保留 |
| 执行计划（exec） | `/plan off` + `/goal <单行目标>` | 目标单行；完整正文只当命令不可用时的退回内容 |
| 反馈提炼（reflect） | 无命令，普通追问 | 结构化正文 |
| 模板发起 | 无命令，普通消息 | 面板里的正文（改过就发改后的） |

**`/goal` 发的是「计划指针」，不是计划全文。** 实测 english-shadow 的完整执行正文
4182 字、25 步，压进 240 字一定在命令中间截断，执行者拿不到完整计划——这是信息通道
问题，不是措辞问题。所以 `composeGoalObjective` 常态只写：

```
执行能力闭环「<标题>」的计划：读 <workspace>/.dsh/rotation.json 中 id=<能力闭环 id>
节点的 plan（goal/steps/verify），按步骤执行，先跑验证命令；失败修到过；
发现计划有错先说明再调整。收尾：写改动+命令结果。
```

240 字花在「计划在哪、读哪个节点的哪个字段、怎么执行、怎么收尾」；steps/verify
留在卡片文件里，agent 用读文件工具取。卡片没有 `workspace` 时退回内联压缩版
（能力闭环核心指标 + 前 4 步 + 前 2 条验证）。

`/plan` 的多行实现依据（DSH 侧核对过）：`parseCommand` 只切命令名，`rawInput`
保留换行；`/plan` handler `trim()` 后整段 steer 成一条用户消息。命令不可用或返回
`undefined` 时，`lib/runner.mjs` 退回同一份正文，所以两种路径的文本一致。

## 六、查看 / 变更 / 发送（面板）

- **查看**：详情卡 Prompt 段每行 = 标题 + 一行摘要；点标题展开结构视图（块标签加粗）。
- **变更**：结构视图下点「编辑原文」出现 textarea；改动只存在内存（关掉页面即丢），
  「重置」回到 host 合成的那份。改动会即时做结构提示（行长、`**`、首行）。
- **发送**：模板「发起」与能力闭环「生成计划 / 执行计划」都先开 **发送预览**：
  - 计划 / 模板：结构视图 + 可编辑原文 + 「会发出去的命令」；
  - 执行：`/plan off` + `/goal …` 两行命令、可改的单行目标、只读的退回正文。
  - 预览里的「复制」复制的是将要发送的内容；取消不发任何东西。
- 无服务（`file://` 只读）：Prompt 段显示「只读模式：提示词由服务生成」，不提供复制/发起。

## 七、怎么改一条 prompt

- 内置模板：改 `lib/prompt.mjs` 的 `PROMPT_TASKS`（标题、摘要、任务行、输出要求）。
- 项目自定义：卡片根 `prompts.<类型>` 或节点 `prompts` 数组（节点级 > 卡片级 > 内置），
  类型是 `milestone` / `capability` / `exec`。
  `ask` 里写一行一个要求；多行会原样进「任务」块（过长会触发 lint 警告）。
- 上下文取舍：`prompt_context.fields` 有序列表、`siblings` 条数、`refs` 引用节点；
  处理逻辑见 `CTX_FIELDS`（旧键 `loop.*` / `goal.*` / `idea.*` 读入即映射成 `milestone.*` / `capability.*`）。

## 八、验证

```bash
npm run mock:prompt      # 结构 lint + 命令编排 + 契约字面量 + 覆盖优先级
npm run mock:action      # 动作链路：/plan 多行正文、/goal 单行、覆盖发送、命令退路
npm run mock:candidates  # 候选生成/采纳：排序、字段保留、409 CAPABILITIES_REQUIRED
npm run mock:genbtn      # 「生成 N 项」的缺项表与按钮接线
npm run preflight        # 全部自检
```
