# Prompt 审计：18 个模板的现状、要点与改写方案

> 状态：审计 + 改写方案。第 2 阶段已落地 3 条：生成计划（§3.3）、`/goal` 计划指针（§3.4）、
> 候选生成（§3.6）；其余条目仍是方案态，见 [templates.md](prompt-audit/templates.md) 顶部的落地状态。
> 日期：2026-10-29。
> 范围：`lib/prompt.mjs` 的 18 个模板；`lib/index.js` 的发送链；`docs/prompts.md` 的结构规范；`scripts/prompt-mock.mjs` / `scripts/action-mock.mjs` 的现有断言。
> 配套：完整「现状 / 改后」文本见 [templates.md](prompt-audit/templates.md)。

## 摘要

这次审计覆盖 18 个模板：10 个节点详情模板、3 个动作 prompt、4 个 JSON 生成 prompt、1 个 `/goal` 单行目标。结论不是「每条都重写一遍」，而是三条：

1. **发送链决定优化优先级**。`plan` 发的是完整正文，`reflect` 发的是完整正文；`exec` 正常路径发的是 `/goal` 的 **240 字单行目标**，完整正文只是命令不可用时的退路。只改 `composeExecPrompt` 不会改变正常执行，必须同时改 `composeGoalObjective`。实测 `english-shadow` 的 `h2-c1`：执行正文 **4182 字**（超过 `docs/prompts.md` 的 1500 字规则），但 `/goal` 目标只有 240 字，25 步计划被截到第 1 步。`exec` 复用同一 session，计划可能还在历史里；但会话压缩/重开后 objective 就是全部信息——把 25 步压成 240 字仍然是信息损失。
2. **生成计划的 prompt 把「怎么做」留给了模型自觉**。它只有 3 行通用指令（读文件、不编、产出计划），没有证据要求、没有文件级动作、没有验收映射；DSH 系统提示已经说了「探索、决策完整、覆盖边界/测试/假设」，模板却在重复这些通用要求，同时缺了仓库与任务特有的信息。本机真实计划会话在收敛前做了约 50 次工具调用，计划质量靠模型，不靠模板。
3. **规范与实现已经漂移，测试只保结构**。`场景` 块被 3 个生成器使用，但不在 `BLOCK_LABELS` / `docs/prompts.md` 的允许清单里；`exec` / `reflect` 没有长度断言；测试断言 JSON 字面量和首行格式，不判断内容质量。所以「prompt 变好了没有」目前没有度量。

本审计给出的 top-5 高杠杆改动：

- 生成计划：加「证据要求 + 文件级步骤 + 验收映射 + 非目标」，删掉与系统提示重复的通用句。
- 执行计划：先修 `/goal` 单行目标，把计划目标、关键步骤、验证命令按优先级压进 240 字；完整正文退路补「失败处理」。
- 反馈提炼：注入已有 lessons 与本次执行证据，明确「不重复已有经验」。
- 候选生成：补 `constraints` / `scenario`，避免候选越过闭环边界。
- 规范/测试：`场景` 入规范与 lint；补 `exec` / `reflect` 长度断言；加 golden case 盲评（本审计已做 pilot）。

**Pilot 的冷水**：4 个 case 里 2 胜（反馈提炼、生成计划）、2 负（闭环拆目标、候选生成）。生成计划是 english-shadow 的真 A/B：candidate 实测 17 passed 并逐条映射验收，baseline 写「应 17/17」未实测、还用推测性 PUT 代替「重播后再点」。负的两个不是「再改改文案」就能过：拆目标的 candidate 把 baseline 的「验收优先写命令」弱化了；候选生成的 candidate 的 `strength` 用了「最小/最易」这类没有对比对象的词。两条模板已按评审意见修正，下一轮重跑，**不把第一稿当胜利**。这说明「加更多要求」不等于「更好」；每条改动必须过盲评，过不了就回退或重写。

---

## 1. 盘点

### 1.1 十个节点详情模板

来源：`lib/prompt.mjs` 的 `PROMPT_TASKS`（`lib/prompt.mjs:157`）；由 `composeTaskPrompt`（`lib/prompt.mjs:397`）渲染；运行时优先级 `node.prompts` > `card.prompts[类型]` > 内置（`lib/prompt.mjs:369`）。

| # | 节点 | id | 标题 | 触发场景 | 输出契约 |
|---|---|---|---|---|---|
| 1 | 闭环 | `split` | 拆成目标 | 闭环详情卡 / AI 拆目标 | Markdown：3–5 目标 + 验收 |
| 2 | 闭环 | `closed` | 检查是否真闭合 | 闭环详情卡 | Markdown：结论 + 缺口 |
| 3 | 目标 | `ideas` | 拆出构思 | 目标详情卡 | Markdown：1 条路线 + 优势 |
| 4 | 目标 | `verify` | 验收可判定性 | 目标详情卡 | Markdown：结论 + 改写验收 |
| 5 | 构思 | `regen` | 重新生成构思 | 构思详情卡 | Markdown：1 条替代 + 优势/代价 |
| 6 | 构思 | `plan` | 梳理执行计划 | 构思详情卡 | Markdown：3–6 动作 + 验证/证据 |
| 7 | 构思 | `risk` | 预演失败点 | 构思详情卡 | Markdown：3 失败点 + 早期信号 |
| 8 | 执行 | `steps` | 给出执行步骤 | 执行详情卡 | Markdown：步骤 + 验证命令 + 通过标准 |
| 9 | 执行 | `proof` | 补齐证据 | 执行详情卡 | Markdown：证据 + 采集方式 |
| 10 | 执行 | `blocker` | 定位阻塞 | 执行详情卡 | Markdown：3 原因 + 验证方法 |

样例卡里 `storyweft` 有 `card.prompts.idea` 与节点 `sw-e4` 的自定义模板；审计与改写针对**内置默认**，自定义覆盖只做兼容性检查。

### 1.2 三个动作 prompt

| # | 动作 | 触发 | 真正发出去的内容 | 输出契约 | 落点 |
|---|---|---|---|---|---|
| 11 | `plan` 生成计划 | 构思卡「生成计划」 | `/plan\n<完整正文>` | 三节：`## 目标` / `## 验证命令` / `## 步骤`；`exit_plan_mode` | `idea.plan` |
| 12 | `exec` 执行计划 | 构思卡「执行计划」 | `/plan off` + `/goal <单行目标>` | 无严格格式；收尾写改动 + 验证 | 执行记录 + 会话 |
| 13 | `reflect` 反馈提炼 | 执行记录 done 自动 / 手动补跑 | 普通消息（无命令） | 严格 JSON：`{"lessons":["…"]}`，≤5 条、每条 ≤200 字 | `loop.lessons` |

发送链代码：`lib/index.js:480`（`startActionSession`）、`lib/index.js:497`（`actionCommand`）、`lib/index.js:1212`（`GET /rotation/api/prompts`）。命令与退路：`lib/prompt.mjs:619`（`actionCommand`）、`lib/prompt.mjs:632`（`actionFallbackPrompt`）。

**关键事实**：`exec` 的完整正文只在命令不可用或失败时退回；正常路径发的是 `composeGoalObjective`（`lib/prompt.mjs:561`）生成的单行目标。`exec` 的 prompt 质量因此分成两层：目标单行（常态）与完整正文（退路），两层都要审。

实测 `english-shadow` 的 `h2-c1`：

- `composeExecPrompt` 渲染 **4182 字**，超过 `docs/prompts.md` 的 1500 字规则；`scripts/prompt-mock.mjs:87` 只对 `plan` 断言长度，所以没红。
- `composeGoalObjective` 输出 **240 字**，25 步计划只保留到第 1 步，且截断在命令中间（`pnpm test:e2e -- tests/e2e/journey.spec.…`）；目标里没有验证命令、没有目录、没有收尾要求。
- 也就是说：**正常执行路径看到的是一个被截断的单行目标，完整计划只存在于退路里**。`exec` 复用同一 session，历史里可能还留着计划；但不能假设它一直在（会话压缩、重开、跨天都会丢）。这是本次审计最高优先级的发现。

### 1.3 四个 JSON 生成 + 一个目标

| # | 生成器 | 触发 | 输出契约 | 消费方 |
|---|---|---|---|---|
| 14 | `composeSplitPrompt`（`lib/prompt.mjs:647`） | 闭环「AI 拆出目标」 | `{"goals":[{"title","acceptance"}]}` 恰好 3 条 | 预览选择 → 写卡 |
| 15 | `composeIdeaPrompt`（`lib/prompt.mjs:694`） | 目标「AI 拆出构思」 | `{"ideas":[{"title","strength"}]}` 3 条，单选 1 条 | 预览 → 写卡 |
| 16 | `composeCandidatePrompt`（`lib/prompt.mjs:750`） | 闭环/目标「生成候选」；构思→执行候选 0.8.0 起面板不再暴露，函数仍兼容 | JSON 数组，N 条；构思带 `strength` | 候选池 |
| 17 | `composeFillPrompt`（`lib/prompt.mjs:794`） | 各详情卡「补全」 | JSON 对象，只含被要求字段，每字段 ≤300 字 | 回填字段 |
| 18 | `composeGoalObjective`（`lib/prompt.mjs:561`） | 执行计划动作 | 单行 ≤240 字 | `/goal` 命令输入 |

### 1.4 上下文覆盖矩阵

字段来自 `CTX_FIELDS`（`lib/prompt.mjs:224`）与各生成器的 `background` 拼装。`●` 已注入，`○` 可用但未注入，`—` 不适用。

| 模板 | 项目 | 闭环意图 | 闭环验收 | 闭环约束 | 场景 | 目标 | 目标验收 | 构思 | 方向 | 节点状态 | 子节点 | 同级 | 引用 | 计划步骤 | 计划验证 | 已有经验 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 个节点模板（默认） | ● | ● | ● | ○ | ○ | ● | ● | ● | ○ | ● | ● | ○ | ○ | — | — | — |
| `composePlanPrompt` | ● | ● | ○ | ○ | ○ | ● | ● | ● | ● | — | — | ○ | ○ | ○ | ○ | ○ |
| `composeExecPrompt` | ● | ○ | ○ | ○ | ○ | ● | ○ | ○ | — | — | — | — | — | ● | ● | ○ |
| `composeGoalObjective` | ● | ○ | ○ | ○ | ○ | ○ | ○ | ● | — | — | — | — | — | ● | ● | — |
| `composeReflectPrompt` | ● | ○ | ○ | ○ | ○ | ○ | ○ | ● | — | — | — | — | — | ● | ○ | ○ |
| `composeSplitPrompt` | ● | ● | ● | ● | ● | — | — | — | — | — | ● | — | — | — | — | — |
| `composeIdeaPrompt` | ● | ● | — | ● | ● | ● | ● | — | — | — | ● | — | — | — | — | — |
| `composeCandidatePrompt` | ● | ● | ○ | ○ | ○ | ● | ● | — | — | — | ● | — | — | — | — | — |
| `composeFillPrompt` | ● | ● | ○ | ● | ● | — | — | — | — | ● | ● | ● | — | — | ● | — |

说明：

- 节点模板的默认字段由 `CTX_DEFAULT_FIELDS` 决定（`lib/prompt.mjs:218`），卡片/节点可用 `prompt_context.fields` 覆盖；表格里的 `○` 表示「字段存在但默认不注入」，不是 bug。
- `composePlanPrompt` 缺 `constraints` / `scenario` / `refs` / `siblings` / `prior plan` 的注入；`composeCandidatePrompt` 缺 `constraints` / `scenario`；`composeReflectPrompt` 缺 `已有经验` 与本次执行证据。这三处是上下文层最明确的缺口。
- `composePlanPrompt` 的 `验收` 块取 `idea.acceptance || goal.acceptance`（`lib/prompt.mjs:501`），没有去重；两者相同时同一事实出现两次。

### 1.5 规范漂移与测试缺口

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | `场景` 块不在允许标签里 | `composeSplitPrompt` / `composeIdeaPrompt` / `composeFillPrompt` 使用 `场景`；`BLOCK_LABELS`（`lib/prompt.mjs:24`）、`docs/prompts.md` 的清单、`web/index.html:2380` 的 `PROMPT_BLOCKS` 都没有 | 三方漂移；lint 的 `empty-block` 覆盖不到；结构视图不会把 `场景` 加粗 |
| 2 | `exec` / `reflect` 没有长度断言 | `scripts/prompt-mock.mjs:87` 只对 `plan` 断言 ≤1500；现有样例实测 `exec` 最大 429 字、`reflect` 289 字，测不出 `english-shadow` 那种 4182 字的真实长计划 | 动作 prompt 可能膨胀到气泡难读；加断言也需要长 plan fixture，否则空转 |
| 3 | 测试只保结构与字面量 | `scripts/prompt-mock.mjs` 断言首行、空行、JSON 键、命令编排 | 没有内容质量回归；prompt 改差了测试也不会红 |
| 4 | `验收` 可能重复 | `composePlanPrompt` 的背景已有目标验收，`验收` 块又取 idea/goal 验收 | 同一事实出现两次，违反 `docs/prompts.md` 的「同一事实只出现一次」 |
| 5 | 反馈提炼不知道已有经验 | `composeReflectPrompt` 背景只有项目/构思/计划目标 | 模型可能重复已有 lessons；host 只能事后按 text 去重 |
| 6 | 候选生成缺边界 | `composeCandidatePrompt` 没有 `constraints` / `scenario` | 候选可能越过闭环的已知约束 |
| 7 | 构思→执行候选疑似死路径 | `CHILD_KIND.idea = 'exec'`（`lib/prompt.mjs:19`），但 0.8.0 起构思卡不再暴露候选生成 | 维护成本；审计先标为兼容路径，不投入改写预算 |

### 1.6 真实轨迹证据

本机 `~/.dsh/sessions/--I-dev-business-english-shadow--/session-452ba22c-…` 是一次真实的「生成计划」会话：

- 输入就是 `composePlanPrompt` 渲染出的 23 行文本：背景 7 行、要做什么 3 行、验收 1 条、输出 3 节、提交方式 2 行。
- 模型在收敛前做了约 50 次工具调用（读 README、package.json、源码、测试、git 历史，起临时 e2e server 实测），最后才给出「reload 后重复写 progress」的根因与四文件计划。
- 这说明：计划本身可以很好，但**模板没有规定证据标准、没有要求文件级步骤、没有验收映射**；质量由模型和仓库规模决定，不可复现、不可度量。

同一份卡片里还有你贴出的那条 prompt 的来源：`I:\dev\business\english-shadow\.dsh\rotation.json` 的构思 `english-shadow-loop-gmvrxyo8h1-c1`（「在现有练习页补齐录音与计数」）。附录用它做生成计划的现状样例。

---

## 2. 每个阶段的 top-3 要点

### 2.1 提要点的方法

1. **写清 job-to-be-done**：这条 prompt 产出什么、谁消费、下游拿它做什么决定。
2. **收集失败模式**：从当前模板、测试、真实会话、8 个 golden case 的试跑输出里找。
3. **生成候选因子**：每个失败模式对应「如果改掉哪个 prompt 属性，这类失败会显著减少」。
4. **排序取前 3**：按「频率 × 严重度 × 模板可控性 × 可观测性 × 是否已被 harness/lint 覆盖」排序；已被系统提示或解析器保证的，不算质量因子。
5. **写成可观察 rubric**：每条 0/1/2 锚点；盲评里分不开新旧模板的因子，降级或删掉。

### 2.2 矩阵

| 阶段 | 要点 1 | 要点 2 | 要点 3 |
|---|---|---|---|
| 闭环 | **场景对齐**：每个目标都能对回闭环意图与场景步骤，不引入场景外目标 | **独立可验收**：目标互斥、可单独判定，验收落命令/断言/可观察结果 | **增量去重**：排除已有子节点与近似重复，说明补的是什么缺口 |
| 目标 | **路线互斥**：3 条是不同机制/数据流，不是同一路线的措辞变体 | **优势可比较**：每条一句 `strength`，同一组轴（省时/好验证/复用资产/风险低） | **约束继承**：每条满足目标验收 + 场景约束，写清代价/风险 |
| 构思 | **方向不写实现**：只给路线，不铺做法/步骤/验收 | **动作有序可验证**：3–6 步、依赖顺序、每步验证命令与证据 | **失败点可观测**：3 个具体失败点，每个带早期信号并排序 |
| 计划 | **证据先行**：读具体文件/命令/最近提交，计划里每个改动点有 `path:line` 或命令输出；先复现现状再开方 | **决策完整**：每步写清改哪些文件、怎么验证、期望结果、边界/失败模式、依赖；执行者不用再问 | **验收可追溯**：每个验收项映射到步骤/命令，总验收可执行 |
| 执行 | **计划完整传递**：`/goal` 单行目标包含计划目标、关键步骤顺序、验证命令；完整正文只在命令不可用时兜底 | **执行纪律**：每步跑验证、失败修到过、不停在「打算做」、不扩范围；阻塞就停并报告 | **证据收尾**：只写改了什么 + 命令/结果 + 验收映射，不虚报 |
| 反馈 | **JSON 可解析**：严格 `{"lessons":[…]}`，无 prose/fence；空数组 | **经验可复用**：踩坑/口径/验证方式/协作约定，不写流水账；≤5 条、每条 ≤200 字 | **基于执行证据且去重**：引用实际命令/错误/diff；注入已有 lessons 避免重复 |
| JSON 生成（跨阶段） | **Schema 严格**：键、数量、无多余文字；下游可直接 parse | **候选独立/互斥**：无重复、无包含，每条可独立采纳 | **验收可判定**：命令/断言/可观察结果，不写口号；≤300 字 |

### 2.3 0/1/2 锚点

**闭环**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| 场景对齐 | 目标与场景无关，或只复述标题 | 部分目标能对回场景，个别越界 | 每个目标都能指到场景某一步，无越界 |
| 独立可验收 | 验收是口号，目标互相包含 | 有验收但不可执行，目标部分重叠 | 互斥、可单独判定，验收是命令/断言/可观察结果 |
| 增量去重 | 重复已有目标 | 提到去重但没有具体缺口 | 明确排除已有目标，并说明补的缺口 |

**目标**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| 路线互斥 | 3 条是同一路线的措辞变体 | 有差异但机制相同 | 不同机制/数据流，可独立采纳 |
| 优势可比较 | 优势是空话 | 有优势但轴不一致 | 同一组轴，一句可横向比较 |
| 约束继承 | 候选越过约束 | 提到约束但不具体 | 每条都满足验收+场景约束，写清代价 |

**构思**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| 方向不写实现 | 写成任务清单/步骤 | 有方向但混入做法 | 只给路线，做法留给计划 |
| 动作有序可验证 | 动作无序、无验证 | 有序但验证缺失 | 3–6 步、依赖顺序、每步验证+证据 |
| 失败点可观测 | 通用风险 | 具体但无信号 | 具体到路线，带早期信号，排序 |

**计划**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| 证据先行 | 没有文件/命令引用，出现未验证的 API/字段 | 有引用但覆盖不全，现状未确认 | 每个改动点有 `path:line` 或命令输出，现状被复现或说明复现失败 |
| 决策完整 | 步骤是「实现 X」这类空话 | 有步骤但缺文件/命令/边界 | 每步有文件、命令、预期结果、边界/失败处理、依赖 |
| 验收可追溯 | 验收和步骤各说各的 | 部分映射 | 每个验收项都能指到某一步和某条命令 |

**执行**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| 计划完整传递 | 目标只剩标题，步骤/验证丢失 | 部分步骤/验证进入目标 | 目标包含计划目标、关键步骤顺序、验证命令；退路有完整正文 |
| 执行纪律 | 停在「打算做」或扩范围 | 有验证但不彻底 | 每步验证、失败修到过、不扩范围、阻塞就停 |
| 证据收尾 | 只写「完成了」 | 写了改动但无命令/结果 | 改动 + 命令/结果 + 验收映射 |

**反馈**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| JSON 可解析 | 散文/非法 JSON | 可解析但有多余文字 | 严格 JSON、键名正确、空数组 |
| 经验可复用 | 流水账 | 有经验但空泛 | 踩坑/口径/验证方式/协作约定，≤5 条、≤200 字 |
| 基于证据且去重 | 通用建议/重复已有 | 部分基于本次执行 | 引用实际命令/错误/diff，避开已有 lessons |

**JSON 生成**

| 因子 | 0 | 1 | 2 |
|---|---|---|---|
| Schema 严格 | 无法 parse/键错/数量错 | 可 parse 但有多余文字或数量偏差 | 键、数量、类型完全符合，无多余文字 |
| 候选独立/互斥 | 重复/包含 | 有差异但重叠 | 无重复、无包含，每条可独立采纳 |
| 验收可判定 | 口号/复述标题 | 部分可判定 | 命令/断言/可观察结果，≤300 字 |

### 2.4 因子与模板映射

| 模板 | 主因子 |
|---|---|
| `split` / `closed` | 场景对齐、独立可验收、增量去重 |
| `ideas` / `verify` | 路线互斥、优势可比较、约束继承 |
| `regen` / `plan`（详情模板） / `risk` | 方向不写实现、动作有序可验证、失败点可观测 |
| `steps` / `proof` / `blocker` | 动作有序可验证、证据可采集、原因可验证 |
| `composePlanPrompt` | 证据先行、决策完整、验收可追溯 |
| `composeExecPrompt` / `composeGoalObjective` | 计划完整传递、执行纪律、证据收尾 |
| `composeReflectPrompt` | JSON 可解析、经验可复用、基于证据且去重 |
| `composeSplitPrompt` / `composeIdeaPrompt` / `composeCandidatePrompt` / `composeFillPrompt` | Schema 严格、候选独立/互斥、验收可判定 |

---

## 3. 改写方案

### 3.1 设计规则

1. **Harness delta 优先**：DSH 系统提示已经说了「先探索、plan 不执行、决策完整、覆盖边界/测试/假设」；模板只补仓库与任务特有的信息，不重复。OpenAI 的实测表明删掉重复指令可提升 10–15% 评分并大幅降 token，这条直接适用。
2. **每行必须映射到一个 top-3 要点**；映射不上的行删掉或降级为「约束」。
3. **Outcome-first**：先写「做完能稳定做到什么」+ 成功标准 + 停止条件，再给步骤；不要用大量微观步骤替代目标。
4. **证据与引用**：计划类 prompt 要求 `path:line` / 命令输出 / 复现结果；不确定就列假设，不要编。
5. **示例只给契约**：JSON 输出、易歧义格式给 1 个短示例；其他不给 few-shot，避免 token 膨胀。
6. **保持契约**：JSON 键名、数量、`/plan` 三节、`/goal` 单行、`exit_plan_mode` 字面量不改；改结构必须同步 `docs/prompts.md` + `BLOCK_LABELS` + `lintPrompt` + 测试。
7. **长度预算**：`plan` ≤1500 字；`exec` / `reflect` 也加长度断言；新增块必须带来可测收益，否则删。

### 3.2 结构变更

新增/重排的块（按模板按需启用，不搞一刀切）：

| 块 | 用在哪 | 解决什么 |
|---|---|---|
| `证据要求` | 计划、拆目标/拆构思、补全 | 规定读什么、引用格式、先复现什么、未决问题怎么处理 |
| `非目标` | 计划、执行 | 明确不做什么，防 scope creep |
| `失败处理` | 执行 | 阻塞/验证失败时停在哪、报告什么 |
| `示例` | JSON 生成、反馈提炼 | 只给契约样例，减少格式歧义 |
| `验收` 映射说明 | 计划、执行 | 验收项 → 步骤/命令，避免各说各的 |

`场景` 补进 `BLOCK_LABELS` 与 `docs/prompts.md`；`证据要求` / `非目标` / `失败处理` / `示例` 也进规范。`任务` 与 `要做什么` 继续共存：`任务` 用于新模板，`要做什么` 保留兼容。

### 3.3 重点：生成计划

**现状问题**（代码 + 真实会话证实）：

- `背景` 只有 7 行上下文，缺 constraints/scenario/refs/prior plan。
- `要做什么` 是 3 行通用指令；「先读 README、脚本、配置、产物、最近提交」没有说**读什么、提取什么、怎么引用**。
- `输出` 只定义三节标题，没要求文件级改动、命令、边界、失败模式、验收映射；DSH 系统提示要求的「public API / schema / data-flow / edge cases / assumptions」在模板里没有落点。
- `验收` 块可能和背景里的目标验收重复。
- 真实会话显示：模型做了约 50 次工具调用才收敛；计划质量靠模型自觉，不靠模板保证。

**改后骨架**：

```text
生成计划 · 构思「…」

背景
- 项目 / 闭环 / 意图 / 约束
- 目标 / 验收
- 构思 / 方向
- 场景（若有）
- 已有计划（若有）
- 引用节点（若配置）

证据要求
1. 先读 README、package.json/脚本、相关源码与测试、最近提交、产物。
2. 给出 3–5 条可核对事实，每条带 path:line 或命令输出。
3. 先复现或确认当前行为；无法复现就写清卡在哪。
4. 列出未决问题；查不到就写假设，不要猜 API/字段/命令。

任务
产出可执行计划，做完能稳定达到「目标」。
成功标准：
- 每个改动点有文件路径与具体动作。
- 每一步有可执行验证命令与预期结果。
- 覆盖边界/失败模式；写明非目标。
- 每个验收项都能追溯到某一步。

验收
- 每条验收项一行（去重后）。

输出
用 Markdown，三节顺序固定：
## 目标
一句话：做完之后能稳定做到什么。
## 验证命令
可直接执行的 bash 命令，一行一条；每条写清预期结果。
## 步骤
1. 改哪些文件 / 做什么 / 验证命令 / 预期结果 / 对应验收项。

提交方式
- 写完用 exit_plan_mode 提交，plan 传完整 markdown。
- 不要直接开始执行。
```

改动要点：加 `证据要求`、`约束`、`场景`、`已有计划`；把「每步一个可验证动作」升级为「文件 + 命令 + 预期 + 验收项」；删掉与系统提示重复的「不要开始改代码」解释（保留提交方式里的 `exit_plan_mode` 约束）。

### 3.4 重点：执行计划 + `/goal`

实测问题：`h2-c1` 的完整正文 4182 字，但常态发送的 `/goal` 目标只有 240 字，25 步计划被截到第 1 步。这不是措辞问题，是**信息通道问题**：把 long plan 塞进 240 字一定会丢信息。

建议按优先级做三件事：

1. **先换目标策略（推荐「计划指针」）**：`/goal` 目标不再内联全部步骤，而是写「执行构思「X」的计划：读 `<workspace>/.dsh/rotation.json` 中该构思的 `plan`（goal/steps/verify），按计划执行；先跑验证命令；失败修到过；发现计划有错先说明再调整。目录：<ws>。收尾：改动+命令结果。」这样 240 字够用，agent 用读文件工具拿完整计划。
2. **保留内联退路**：如果卡片不在项目目录/文件不可读，退回方案 A：目标 + 关键步骤 + 验证命令压进 240 字。
3. **修完整正文**：`composeExecPrompt`（退路）补齐全部 steps/verify，加 `失败处理`：验证失败先修；同一失败 2–3 次仍过不去就停，报告阻塞点与已尝试的命令；加「计划是权威，但发现计划有错要说明并调整」。

`/goal` 目标的字符预算建议：

| 段 | 预算 | 内容 |
|---|---|---|
| 目标 | ~60 字 | `执行「标题」：计划目标` |
| 读取 | ~50 字 | 计划文件路径 / `idea.plan` 位置 |
| 验证 | ~50 字 | 2–3 条关键命令 |
| 收尾 | ~30 字 | 目录 + 改动/结果说明 |

### 3.5 重点：反馈提炼

- 背景注入 `loop.lessons` 已有条目（或摘要），让模型知道去重边界。
- 注入本次执行的证据摘要：改动的文件、跑过的命令、失败/通过的输出。
- 输出保持严格 JSON；给一个 1 条 lesson 的短示例；明确「没有新经验就给空数组」。

### 3.6 重点：JSON 生成

- 统一 schema 说明：键名、数量、类型、禁止多余文字；每个生成器给 1 个短示例。
- `composeCandidatePrompt` 补 constraints/scenario；否则候选可能越过闭环边界。
- 候选的 `strength` 必须**显式对比其它候选**；pilot 显示只写「同一组轴」仍会产出「最小/最易」这类没有对比对象的自夸，需加一句「不要用最小/最强这类词」。
- 验收统一要求「命令/断言/可观察结果」，禁止复述标题。
- `composeFillPrompt` 保持字段上限 300 字；新增「查不到就写假设」的处理。

### 3.7 十个节点模板的逐条改动

| 模板 | 改动 | 对应要点 |
|---|---|---|
| `split` | 任务加成功标准（场景对齐、互斥、可验收、去重）；输出保持一行一条 | 场景对齐 / 独立可验收 / 增量去重 |
| `closed` | 缺口行加「为什么 + 最小补法」 | 场景对齐 |
| `ideas` | 加约束继承；优势必须能横向比较 | 路线互斥 / 优势可比较 / 约束继承 |
| `verify` | 加「不偷偷降低标准」；改写后说明改了什么 | 独立可验收 |
| `regen` | 加「机制/数据流实质不同」；保留优势/代价 | 路线互斥 |
| `plan`（详情模板） | 3–6 动作、依赖顺序、每步验证+证据、映射验收 | 动作有序可验证 |
| `risk` | 失败点加触发条件/早期信号/最小应对，排序 | 失败点可观测 |
| `steps` | 每步加验证命令与通过标准 | 动作有序可验证 |
| `proof` | 证据加采集方式与判定标准 | 证据可采集 |
| `blocker` | 原因按可能性排序，给验证方法与分支 | 原因可验证 |

完整「现状 / 改后」文本见 [templates.md](prompt-audit/templates.md)。

### 3.8 兼容性

- `node.prompts` / `card.prompts` 覆盖优先级不变；旧卡片没有新字段时安静跳过。
- `prompt_context.fields` 的现有 key 不删；新增字段只加默认值。
- JSON 契约字面量不变（`goals` / `ideas` / `lessons` / `title` / `strength` / `acceptance`）。
- 新块标签上线前，`lintPrompt` 必须认识它们；否则会出现假 `empty-block` 或漏检。
- 旧计划卡没有新字段时，`composeExecPrompt` 仍能退化到「目标 + 步骤数 + 验证数」。

---

## 4. LLM 盲评（pilot）

### 4.1 设计

- 8 个 golden case（见下表），每个 case 生成旧模板（baseline）与新模板（candidate）两份输出。
- Pilot 先跑 4 个：反馈提炼（6）、候选生成（7）、闭环拆目标（1）、生成计划（4）；其余 4 个在下一阶段实现后用同一套 rubric 补齐。
- 生成用只读 subagent：同模型、同 cwd、同 preamble；不允许编辑文件；plan/exec 只读仓库。
- 评委 1–2 个：每个 case 至少 1 个盲评；有歧义或贴错输出时重跑第二个。只看到 case 目标/验收/上下文 + Output A/B + rubric，不知道哪份是旧模板；每半个 case 交换 A/B 顺序。
- 评分：每个 top-3 因子 0/1/2，总体 1–5，契约检查通过/失败。
- 验收阈值：candidate 的因子均分 ≥ baseline；至少 4/8 个 case 严格胜；无契约失败。

### 4.2 Golden set

| # | 阶段 | 用例 | 工具 | 主要检查 |
|---|---|---|---|---|
| 1 | 闭环 | `samples/shadowing.rotation.json` 的 `sh-loop` | 无 | 拆目标 JSON + split 模板：场景对齐、3 条独立验收 |
| 2 | 目标 | 同卡 `sh-g1` | 无 | 拆构思 JSON + ideas 模板：互斥、strength、约束 |
| 3 | 构思 | 同卡 `sh-i1` | 只读 | `idea/plan` 与 `idea/risk`：动作有序、失败点可观测 |
| 4 | 计划 | `I:\dev\business\english-shadow\.dsh\rotation.json` 的 `english-shadow-loop-gmvrxyo8h1-c1` | 只读仓库 | 三节、文件级步骤、证据引用、验收映射 |
| 5 | 执行 | 同卡 `english-shadow-loop-gmvrxyo8h2-c1`（已有 plan） | 只读仓库 | `/goal` 目标完整性、验证/停止规则；不实际改文件 |
| 6 | 反馈 | `samples/execution-records.rotation.json` 的 `xr-i1-r1` + 固定执行摘要 | 无 | 严格 JSON、经验可复用、去重 |
| 7 | 候选 | `samples/shadowing.rotation.json` 的 `sh-g1` | 无 | 候选 schema、互斥、验收可判定 |
| 8 | 补全 | `samples/kg.rotation.json` 的 `kg-g1` | 无 | 字段完整、≤300 字、场景/约束一致 |

### 4.3 结果

> Pilot 先跑 4 个 case（反馈提炼、候选生成、闭环拆目标、生成计划）；其余 4 个给出协议，下一阶段实现后用同一套 rubric 补齐。分数是各因子 0/1/2 的均值，不是总体主观分。

| # | case | baseline 均分 | candidate 均分 | 胜/平/负 | 契约 | 备注 |
|---|---|---|---|---|---|---|
| 1 | 闭环拆目标 | 1.67 | 1.33 | baseline | pass | candidate 验收写「用断言脚本校验」但没有具体命令；baseline 每条都有 `pnpm vitest` / `pytest` 命令 |
| 2 | 目标拆构思 | — | — | — | — | 未跑（pilot 外，协议已备） |
| 3 | 构思执行计划 | — | — | — | — | 未跑（pilot 外，协议已备） |
| 4 | 生成计划 | 1.33 | 2.00 | candidate | pass | english-shadow 真 A/B：candidate 实测 17 passed 并逐条映射验收；baseline 写「应 17/17」未实测，且用推测性 PUT 代替「重播后再点」 |
| 5 | 执行计划 | — | — | — | — | 未跑（只读评估，下一阶段） |
| 6 | 反馈提炼 | 1.67 | 2.00 | candidate | pass | candidate 引用具体失败断言与 mock；baseline 第 3 条重复已有经验 |
| 7 | 候选生成 | 2.00 | 1.75 | baseline | pass | baseline 的 strength 显式对比另两条；candidate 用「最小/最易」无对照断言 |
| 8 | 补全 | — | — | — | — | 未跑（pilot 外，协议已备） |

对 case 1 的处理：candidate 加了成功标准，却把 baseline 的「验收优先写成可直接执行的命令」弱化成「命令/断言/可观察结果」。已在 `templates.md` 的 split 模板里补回「优先命令，不要写没有命令的『用断言脚本』」，下一轮重跑。

对 case 7 的处理：pilot 用的是改写第一稿；评审显示 `strength` 反而变弱。已在 `templates.md` 的候选模板里加「显式对比另两条候选，不要用最小/最强这类没有对比对象的词」，下一轮重跑该 case，不把第一稿当胜利。

**case 4 的盲评结果**：candidate 胜（2.00 vs 1.33）。candidate 实测 `journey.spec.ts` 17 passed、`youtube+captions` 4 passed，逐条映射验收，并指出 `EmbedPractice.tsx:231-249` 没有完成按钮的边界；baseline 写「应 17/17」未实测，且把「重播后再点」换成推测性 `PUT /api/progress`，traceability 失分。两边都能产出好计划，差异在**证据是否实测、验收是否逐条映射**。fallback 的本仓 pair 也做了同样的 A/B（candidate 2.00 vs baseline 1.33），但候选子任务读过审计文档，只当 sanity check，不计入干净证据。

### 4.4 局限

- subagent 的系统提示与真实 DSH 会话不同；盲评只能比较「同一噪声下的相对质量」，不是生产级 A/B。
- 8 个 case 不能覆盖所有输入；结论是方向性的，最终以真实使用反馈校正。
- 只读执行评估不测真实工具副作用；执行类 prompt 的最终验证仍要等实现阶段的真实会话。

---

## 5. 下一阶段落地清单（本阶段不执行）

### 5.1 文件/函数

1. `docs/prompts.md`：补 `场景`、`证据要求`、`非目标`、`失败处理`、`示例` 标签；补 `exec` / `reflect` 长度规则；写清 `exec` 的「目标单行 vs 完整正文退路」。同步 `web/index.html:2380` 的 `PROMPT_BLOCKS`（结构视图靠它加粗）。
2. `lib/prompt.mjs`：
   - `BLOCK_LABELS`（`lib/prompt.mjs:24`）补新标签。
   - `PROMPT_TASKS`（`lib/prompt.mjs:157`）10 条模板改写。
   - `composePlanPrompt`（`:475`）、`composeExecPrompt`（`:529`）、`composeGoalObjective`（`:561`）、`composeReflectPrompt`（`:576`）。
   - `composeSplitPrompt`（`:647`）、`composeIdeaPrompt`（`:694`）、`composeCandidatePrompt`（`:750`）、`composeFillPrompt`（`:794`）。
3. `scripts/prompt-mock.mjs`：新增三方标签一致性断言（`BLOCK_LABELS` / `docs/prompts.md` / `web/index.html` 的 `PROMPT_BLOCKS`）；长度按 action 设上限（`plan/exec 1500`、`reflect 800`）；用**非空 `scenario` 的 fixture**测 `场景` 块，用**步骤 ≥20 的长 plan fixture**测 `exec` 上限——现有样例 0 个非空 scenario、exec 最大 429 字，直接加断言会空转。
4. `scripts/action-mock.mjs`：补新 plan/exec prompt 的发送与退路断言；覆盖 `/goal` 目标截断/计划指针。
5. `samples/`：新增两个测试夹具（不参与产品展示）：`scenario` 非空卡、长 plan 卡；标注为测试夹具，workspace 指向本机仓库。

### 5.2 顺序

1. 先改规范 `docs/prompts.md`。
2. 再改 `lib/prompt.mjs`。
3. 同步 `BLOCK_LABELS` / `lintPrompt`。
4. 更新 `scripts/prompt-mock.mjs` / `scripts/action-mock.mjs`。
5. 跑 `npm run mock:prompt`、`npm run mock:action`、`npm run preflight`。
6. 面板「查看 / 编辑 / 发送预览」人工过一遍。

### 5.3 回滚

只改代码与文档，无数据迁移；回滚即 revert 对应文件。旧卡片字段缺失时安静跳过，不做批量迁移。

### 5.4 验收命令

```bash
npm run mock:prompt
npm run mock:action
npm run preflight
git diff --check
```

---

## 6. 时间与风险

**本阶段实际耗时**（2026-10-29）

- 盘点 + 真实轨迹：约 25 分钟
- 提要点 + rubric：约 25 分钟
- 改写 18 条：约 40 分钟
- 盲评 pilot：约 30 分钟
- 文档组装 + 自检：约 20 分钟

**风险**

- **Prompt 膨胀**：新增块可能让 prompt 变长；用长度断言 + 「每行必须映射因子」控制。
- **与 harness 重复/冲突**：先做 delta 清单，删掉系统提示已覆盖的句子；冲突比缺失更伤。
- **过拟合 8 个 case**：rubric 只看因子，不比对具体文字；保留 1 个 held-out case 做 sanity check。
- **模型差异**：盲评用 `deepseek-flash`，结论对其他模型是方向性的。
- **结构改动破坏 lint/测试**：下一阶段必须规范、代码、测试同步改；本阶段只出方案，不落地。
- **`/goal` 240 字上限**：这是产品/UI 约束；审计先按 240 字优化密度，若盲评显示关键信息被截断，再把「放宽到 400 字或加详情退路」作为下一阶段的建议，不擅自改 UI。

---

## 7. 假设与未决项

**假设**

- 模板保持中文；块标签可以增减，但面板展示与气泡折行规则不变。
- 本阶段只写文档，不改生产代码；改写文本先放 `templates.md`，等下一阶段批准后再进 `lib/prompt.mjs`。
- DSH 系统提示是既有基线；模板的职责是补「仓库/任务特有信息」，不是重复 system prompt。
- `english-shadow` 卡片在本机可用；若盲评时仓库不可读，case 4/5 回退到 `samples/storyweft` 并标注。
- 盲评模型与计划会话一致（`deepseek-flash`）；若路由不可用，用当前默认模型并在文档里标注「方向性结论」。

**未决项（不阻塞本阶段，下一阶段前确认）**

- `composeCandidatePrompt` 的「构思→执行候选」是否已完全废弃；若废弃，审计标为死路径，不投入改写预算。
- 是否为 `/goal` 目标放宽 240 字上限；这取决于面板单行展示的产品约束。
- 新块标签最终用 `证据要求` / `非目标` / `失败处理` / `示例`，还是复用现有 `约束` / `任务`；本审计推荐新增，下一阶段实现时再定稿。

---

## 8. 参考基准

- [Anthropic Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)：清晰直接、给上下文与动机、示例、结构化、长上下文「数据在前、问题在后」、引用 grounding、`investigate_before_answering`、避免过度工程、复杂任务链式自纠。
- [OpenAI GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)：outcome-first、success criteria、constraints、evidence、output shape、stop rules；删重复指令的实测收益；实施计划要含 requirements / named files / data flow / validation / failure behavior / open questions。
- [DeepSeek 提示词基本法则](https://cloud.tencent.cn/developer/article/2673745)：任务、上下文、约束、输出格式、示例。
- [LLM eval toolkit](https://github.com/AleBrito124356/llm-eval-toolkit)、[Prompt evaluation & iteration notes](https://github.com/PatrickWiloak/cloud-data-ai-security-zero-to-hero/blob/main/exams/anthropic/claude-prompt-engineering-specialist/notes/06-prompt-evaluation-and-iteration.md)：pairwise 盲评、rubric、随机顺序、评委校准。
- 本地实证：`docs/prompts.md`、`lib/prompt.mjs`、`scripts/prompt-mock.mjs`、`samples/*.rotation.json`、`~/.dsh/sessions/--I-dev-business-english-shadow--/session-452ba22c-…`。
