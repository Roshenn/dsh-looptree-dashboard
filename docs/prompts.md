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
| `composePlanPrompt` / `composeExecPrompt` / `composeReflectPrompt` | 构思动作：生成计划 / 执行计划 / 反馈提炼 |
| `composeGoalObjective` | `/goal` 的单行目标（目标面板按一行显示） |
| `actionCommand` | 动作 → 真正发出的斜杠命令 |
| `composeSplitPrompt` / `composeIdeaPrompt` | 「AI 拆出目标 / 拆出构思」 |
| `composeCandidatePrompt` / `composeFillPrompt` | 生成候选 / 按标题补全 |
| `lintPrompt` | 结构自检（测试与面板提示共用） |

面板不再自己拼 prompt：查看、复制、发起、动作预览都走 `GET /rotation/api/prompts`。

## 三、格式规范

### 骨架

```
<动作> · <对象>            ← 首行：一眼知道这条 prompt 干什么

背景                        ← 块标签单独一行，2–4 字
- 项目：<name>（<workspace>）
- 闭环：<title>
  - 意图：<intent>
- 目标：<title>
  - 验收：<acceptance>
- 构思：<title>

要做什么
1. 一行一个动作
2. …

验收
- 一行一个判据

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
```

允许的块标签：`背景` `当前节点` `任务` `要做什么` `验收` `约束` `输出`
`验证命令` `步骤` `提交方式` `收尾` `质量要求`。

### 规则

1. 首行必须 `动作 · 对象`；对象写「类型「标题」」，标题超过 24 字截断。
2. 首行后空一行；块之间空一行；块标签单独成行，不加 `#`。
3. 块内一行一个事实/动作；键值 `- 键：值`；步骤 `1. `。
4. 空数据不出块，不留空标题。
5. 单行视觉宽度 ≤ 72 列（CJK 记 2、ASCII 记 1），超了按标点/空格折行、续行缩进两格。
   代码块与 JSON 契约行不折。
6. 不用 `#` / `**` / `>`；唯一例外是「输出」块里要求模型产出的 markdown 小节。
7. 动作 prompt ≤ 1500 字；超了把细节留在卡片里，用 id 引用。
8. 不复述上下文；同一事实只出现一次。
9. `/goal` 的目标必须单行、≤ 240 字（目标面板按一行显示）。

### lint

`lintPrompt(text, { maxLength })` 返回 `{ ok, warnings:[{ line, code, message }] }`。
codes：`missing-title` `bad-title` `missing-blank` `line-too-long` `markdown-bold`
`tab` `trailing-space` `double-blank` `empty-block` `too-long`。

样例卡的全部模板与动作 prompt 必须零警告，见 `scripts/prompt-mock.mjs`。

## 四、发送编排

| 动作 | 发出去的命令 | 正文 |
|---|---|---|
| 生成计划（plan） | `/plan\n<结构化正文>` | 整段正文就是命令参数，换行保留 |
| 执行计划（exec） | `/plan off` + `/goal <单行目标>` | 目标单行；完整正文只当命令不可用时的退回内容 |
| 反馈提炼（reflect） | 无命令，普通追问 | 结构化正文 |
| 模板发起 | 无命令，普通消息 | 面板里的正文（改过就发改后的） |

`/plan` 的多行实现依据（DSH 侧核对过）：`parseCommand` 只切命令名，`rawInput`
保留换行；`/plan` handler `trim()` 后整段 steer 成一条用户消息。命令不可用或返回
`undefined` 时，`lib/runner.mjs` 退回同一份正文，所以两种路径的文本一致。

## 五、查看 / 变更 / 发送（面板）

- **查看**：详情卡 Prompt 段每行 = 标题 + 一行摘要；点标题展开结构视图（块标签加粗）。
- **变更**：结构视图下点「编辑原文」出现 textarea；改动只存在内存（关掉页面即丢），
  「重置」回到 host 合成的那份。改动会即时做结构提示（行长、`**`、首行）。
- **发送**：模板「发起」与构思「生成计划 / 执行计划」都先开 **发送预览**：
  - 计划 / 模板：结构视图 + 可编辑原文 + 「会发出去的命令」；
  - 执行：`/plan off` + `/goal …` 两行命令、可改的单行目标、只读的退回正文。
  - 预览里的「复制」复制的是将要发送的内容；取消不发任何东西。
- 无服务（`file://` 只读）：Prompt 段显示「只读模式：提示词由服务生成」，不提供复制/发起。

## 六、怎么改一条 prompt

- 内置模板：改 `lib/prompt.mjs` 的 `PROMPT_TASKS`（标题、摘要、任务行、输出要求）。
- 项目自定义：卡片根 `prompts.<类型>` 或节点 `prompts` 数组（节点级 > 卡片级 > 内置）。
  `ask` 里写一行一个要求；多行会原样进「任务」块（过长会触发 lint 警告）。
- 上下文取舍：`prompt_context.fields` 有序列表、`siblings` 条数、`refs` 引用节点；
  处理逻辑见 `CTX_FIELDS`。

## 七、验证

```bash
npm run mock:prompt     # 结构 lint + 命令编排 + 契约字面量 + 覆盖优先级
npm run mock:action     # 动作链路：/plan 多行正文、/goal 单行、覆盖发送、命令退路
npm run preflight       # 全部自检
```
