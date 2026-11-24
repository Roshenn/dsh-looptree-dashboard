# UI 用户评审团报告 · 2026-11-24 · 轮转里程碑树面板（首轮）

> 证据包：`~/.dsh/outbox/gate/2026-11-24-panel/`（修前） / `~/.dsh/outbox/gate/2026-11-24-panel-after/`（修后）
> 评审轮次：R1 首轮 · 席位：6/6 返回 · 模型路由：单 provider（跨模型盲区未覆盖）· 机制：`~/.dsh/skills/ui-user-panel/`

## 1. 结论

**不可直接交付** —— 面板的「看板阅读」与「打开一条记录」两条主线在键盘与空态下会断，另有 5 处状态/反馈问题；但骨架、深/浅主题、动效时基（150/160/180ms，ease-out）与帧率（p95 16.7ms）是站得住的。

- 原始 findings 29 条 → 校验后聚成 19 条（4 席以上同指 1 条，2 席同指 5 条）；复检又抓出 3 条（嵌套可交互 / 空态死按钮 / 命中环与锚点环重叠）。
- 修前 block 级：4（键盘详情 / 320 溢出 / 搜索零命中 / 小目标+对比度误报已剔除）→ 两轮修复后 block 级剩 2（320 溢出、小目标，均落到下一轮）。
- 一句话最该动的地方：**让「现在做什么」这件事在任何输入方式下都可达** —— 卡片可聚焦、空态说人话、打开详情能看出是哪张卡。

## 2. 本轮 top 3（已修，见 §8 复检）

| # | 台账 id | 区域 / locus | 严重度 | 支持席位 | 用户代价 | 修法 | 类别 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ui-20261124-001 | swimlane / `.tnode` | blocker | A2B1, A3B1 | 纯键盘打不开详情，看不到 prompt/验证命令/发起会话；100 个 Tab 停靠点全在按钮上，卡片 0 个 | `.tnode` 加 `role=button/tabindex=0` + `aria-label`；Enter/Space 打开详情；焦进对话框、Esc 关闭后回焦原卡 | defect-fix |
| 2 | ui-20261124-002 | empty-error / `#stage` | blocker | A1B2, A2B1, A3B1, A3B2 | 搜索 0 命中时整块画布空黑，无文案、无计数、无清除入口，被读成「接口又断了」 | 新增 `#no-match` 空态：说明 + 命中 0 + 「清空搜索」；矩阵同步隐藏 | defect-fix |
| 3 | ui-20261124-005 | swimlane / `.tnode.is-active` | impact | A2B2 | 打开详情后锚点只剩与 hover 同值的边框，2px 品牌环被后面一条同名规则覆盖；阻断卡的红边也被改成中性色 | 把覆盖规则改成只补 2px 环、保留状态色边框 | defect-fix |

> 对比图：`shots/before-no-match.png` vs `shots/after-no-match.png`；`shots/before-anchor.png` vs `shots/after-anchor.png`；键盘路径 `shots/after-focus.png`、`shots/after-keyboard-detail.png`。均为同视口（1440×900）同状态。

## 3. 全部 findings（按严重度）

| 台账 id | 区域 | locus | 严重度 | 支持席位 | 事实（摘要） | implies | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ui-20261124-001 | swimlane | `.tnode` | blocker | A2B1, A3B1 | 卡片不可聚焦，键盘无法打开详情 | D9 | fixed |
| ui-20261124-002 | empty-error | `#stage` | blocker | 4 席 | 搜索零命中无空态 | D11 | fixed |
| ui-20261124-003 | topbar | `header` | blocker | A3B1, A3B2 | 320px 横向溢出 621px，顶栏文字重叠 | D12 | open |
| ui-20261124-004 | swimlane | 小目标 28 处 | impact | A2B1, A3B1, A3B2 | ⋯ 22×22、完成 18–24、foldchip 66×22、#next-jump 324×22 | D3 | open |
| ui-20261124-005 | swimlane | `.tnode.is-active` | impact | A2B2 | 详情锚点环被覆盖 | D11 | fixed |
| ui-20261124-006 | detail | `#detail` | impact | A1B1, A1B2 | Prompt 段显示原始英文 `Failed to fetch`，无重试，「说明」指向不存在的「发起」 | D11 | open |
| ui-20261124-007 | detail | `#detail` | impact | A2B2 | 打开后 0.2–0.6s 卡片仍在长高/重排（异步 prompt/候选池） | D11 | open |
| ui-20261124-008 | detail | `#detail` | impact | A2B2 | 任何 `render()` 都销毁重建详情，滚动位置归零 | D6 | open |
| ui-20261124-009 | swimlane | 关闭提示 | impact | A2B1 | 关闭后无撤销、Ctrl+Z 无效，恢复要约 130 次 Tab | D9 | open |
| ui-20261124-010 | modal-menu | `.modal` | impact | A2B1 | 弹窗焦点不锁，Tab 一次就逃到背景；Esc 后焦点回 BODY | D9 | open |
| ui-20261124-011 | topbar | `#save-state` | impact | A3B1, A1B1 | 诊断入口是 span、不可聚焦、文案被截断，键盘打不开 | D11 | open |
| ui-20261124-012 | other | `#next-jump` / 概览 | impact | A1B1, A1B2 | 「下一步」是文本不可点，页脚建议 22px，服务入口藏在 ⋯ | D9 | open |
| ui-20261124-013 | swimlane | 术语 | impact | A1B1 | 能力闭环/收口/在途/收敛健康度等无可见定义；「聚焦」两处同名 | D2 | open |
| ui-20261124-014 | swimlane | 关闭语义 | polish | A1B2 | 「完成/已闭环/关闭/收口」四写法；琥珀同时表示状态与动作 | D8 | open |
| ui-20261124-015 | swimlane | Tab 顺序 | polish | A2B1 | Tab 按 DOM 树序而非视觉列序（右列先于中列） | D9 | open |
| ui-20261124-016 | swimlane | reduced-motion | polish | A3B2 | 全局 `*{1ms}` 兜底，idle 就绪无静态替代 | D11 | open |
| ui-20261124-017 | topbar | `#btn-theme` | polish | A2B2 | 主题整页硬切 + 34 条控件 160ms，双时基 | D6 | open |
| ui-20261124-018 | topbar | `#k-blocked` | polish | A1B1 | 「阻塞 4」不可点；「数据 —」无时间戳 | D9 | open |
| ui-20261124-019 | tabs-filters | `#toolbar-hint` | polish | A1B2 | 规则文案已计算但 `display:none`，首屏看不到自动流转/确认达成规则 | D1 | open |
| ui-20261124-020 | swimlane | `.tnode[role=button]` | impact | 4 席（复检新增） | 整卡 `role=button` 内嵌真按钮 = 非法嵌套；已改标题为真按钮 | D12 | fixed |
| ui-20261124-021 | empty-error | `#no-match-clear` | impact | 6 席（复检新增） | 空态「清空搜索」绑在 `if (isEmpty)` 里，是死按钮；已移出并补 Esc | D11 | fixed |
| ui-20261124-022 | swimlane | `[data-hit]` + `.is-active` | polish | A2B2（复检新增） | 命中环与锚点环同边重叠，命中卡当锚点时锚点环只剩 ~1px | D11 | open |

**已剔除**：A3B2 / A2B1 提出的「已闭环按钮对比度 1.21:1」。复测发现是测量脚本把 `color-mix()` 计算出的 `color(srgb …)` 误当 rgb 数值解析；修脚本后同类文本对比度全部 ≥4.5:1，本仓不落台账（写入 `scripts/ui-evidence.mjs` 修正记录）。
**证据缺口，不算产品缺陷**：A1B1 / A3B2 的「错误态与正常态逐字节相同」—— 取证时接口中断后面板回退静态 `cards.js`，两张图和默认首屏相同（sha256 一致）。产品在真实宿主下是否有断链横幅 **本轮未验证**，已记 `no-evidence`；采集脚本已如实记录该失败。弹窗错误态另有 `shots/modal-add-project.png`（属替代限制）。

## 4. 真实冲突（不取平均，逐条裁决）

| # | 主题 | 一方要 | 另一方要（veto） | 裁决 | 理由 |
| --- | --- | --- | --- | --- | --- |
| 1 | 术语 | A1B1：术语换成白话，别加说明层（D2） | A1B2/A3B1/A3B2 refuse D2：解释文本是他们的可读性来源 | **换词，不删解释** | 白话化「能力闭环 / 收口」不损失信息；删掉「样本不足」「自动流转」才会伤受限用户 |
| 2 | 目标尺寸 | A1B2/A3B1/A3B2：把 ⋯、完成、页脚建议做大（D3） | A2B2 refuse D3：放大会把一条泳道顶出屏，密度不能动 | **只扩命中区，不改视觉占位**（padding / 伪元素外扩至 ≥24×24） | 同时满足 WCAG 2.5.8 与 A2B2 的密度诉求；下一轮落地 |
| 3 | 窄屏 | A3B1：320 下改成单列堆叠（D5/D12） | A2B2 refuse D5、A3B1 refuse D12（全局合并结构） | **仅 ≤480px 生效的单列堆叠**，桌面布局与密度不变 | 窄屏可用性与桌面密度不冲突，冲突只发生在「全局改」这个错误粒度上 |
| 4 | 动效 | A2B2：主题切换两种时基并存，要么全瞬时要么整页 160ms（D6） | 无反对 | **缓一轮**：先修「详情重建丢滚动」这个更高代价问题，主题时基下一轮 | 影响面小，且与 reduced-motion 方案一起改更稳 |

## 5. 覆盖与盲区

| 区域 | 状态 | 说明 |
| --- | --- | --- |
| topbar | covered | 统计不可点、#save-state、320 重叠 |
| tabs-filters | covered | 零命中提示、规则文案 display:none |
| swimlane | covered | 键盘、小目标、术语、关闭语义、锚点 |
| detail | covered | Prompt 失败、异步重排、render 重建 |
| modal-menu | covered | 焦点不锁（用弹窗错误态截图 + 源码） |
| toast | no-evidence | 证据包没录到 toast 出现/消失，A2B1 的「无撤销」来自关闭提示 DOM 与源码；复检需补录 |
| empty-error | partial | 空态 → 已修；网络丢失态因静态回退不可得（`no-evidence`），弹窗错误态有截图 |
| other | covered | `#next-jump`、页脚建议 |

**`no-evidence` 不等于通过**：toast 与网络错误态本轮没有证据，结论降为 `unknown`。

## 6. 正交性审计

| 指标 | 结果 | 判读 |
| --- | --- | --- |
| 簇数 / 平均支持度 | 24 簇 / 29 条 → 19 条 | 聚簇率约 34%，说明六席确实在不同位置看问题 |
| 两两重叠 > 0.5 | 0 对（最高 A2B1↔A3B1 0.25） | 正交性达标，无需换席 |
| 无咬合力席位 | A2B1（veto D10/D7 无人提出） | 它对「过度加确认/加动效」的防御落空；下一轮把 A1B2 换成「带替代品来的比较者」，把 A2B1 的 veto 改成对 D6 的防御 |
| veto 碰撞 | 5/6 席有碰撞（A1B1 1、A1B2 1、A2B2 4、A3B1 2、A3B2 1） | 冲突真实存在，非各自自说自话 |
| 每席接受率 | 29/29 条 locus 全部命中 inventory | 幻觉率 0 |
| 单一模型风险 | 仅一个 provider | 跨模型盲区未覆盖，报告只做单模型结论 |

## 7. 动效证据（不得用静帧判动效）

| 交互 | contact sheet | 时序 | 硬切 | 结论 |
| --- | --- | --- | --- | --- |
| 开/关详情 | `motion/contact-open-detail*.png` | 150ms opacity+transform，`cubic-bezier(.23,1,.32,1)` | 0 | 时基与操作频率匹配；问题是「打开后 0.2–0.6s 还在重排」（007）与「render 重建」（008），不是 150ms 本身 |
| ＋项目弹窗 | `motion/contact-add-menu*.png` | 180ms（modal-card） | 0 | 时基合理；焦点问题属交互（010） |
| 切主题 | `motion/contact-theme-toggle*.png` | 整页瞬时 + 34 条 160ms 控件色过渡 | 2 | 双时基并存，下一轮统一 |

## 8. 复检（R5 同六席 → R6 二次修复 → 终检）

**R5 结果（6/6 返回，同六席）**——没有直接通过，反而抓出问题，这正是机制要的效果：

| 台账 id | resolved | open | regressed | 复检发现 |
| --- | --- | --- | --- | --- |
| 001 键盘详情 | 2 | 4 | 0 | 代码实测已通，但交付的 `after-focus.png` 是脚本 `.focus()`，不触发 `:focus-visible`，没有焦点环；Esc 回焦没有截图；另发现整卡 `role=button` 内嵌真按钮（新 020） |
| 002 零命中空态 | 1 | 3 | 2 | 空态外观成立，但「清空搜索」绑定写在 `if (isEmpty)` 分支里，有项目时永不绑定 → 死按钮（新 021） |
| 005 锚点环 | 2 | 4 | 0 | 非 idle 卡已修；idle（可开工）卡的环仍被 `[data-idle]{box-shadow:none}` 同特异性后置规则覆盖；且截图选的锚点恰好躲开 idle 卡 |

**R6 修复（同一天，all in web/index.html）**

1. 不再给整卡 `role=button`：标题改为真正的「打开详情」按钮（`button.tnode-open`，原生 Enter/Space），点卡片空白处仍可开详情；焦点环用按钮自身 `:focus-visible`。→ 修 001 + 020。
2. 「清空搜索」绑定移出 `if (isEmpty)` 并保留幂等保护；清除后焦点回搜索框；`#no-match` 可见时全局 Esc 也能清空。→ 修 002 + 021。
3. 给 `[data-idle]`/`[data-ask]` 的 `box-shadow:none` 加 `:not(.is-active)`，锚点环在 idle 卡上也成立。→ 修 005。

**R6 终检证据（真键盘 + 实测，不是截图推断）**

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 键盘聚焦 | `shots/final-focus.png`：标题按钮 2px 品牌 `outline`，`:focus-visible=true`，`aria-label="打开详情：…"` | resolved |
| 键盘打开 | `shots/final-keyboard-detail.png`：Enter 后焦点在 `.detail-card`，锚点 `box-shadow=0 0 0 2px brand` | resolved |
| Esc 回焦 | 实测：`#detail` 关闭、`activeElement` 回到 `.tnode-open` | resolved |
| 无嵌套按钮 | 实测 `.tnode` 不再有 role/tabindex；`.tnode-open` 内嵌套按钮 0 个 | resolved |
| 空态清空 | `shots/final-no-match.png`；实测 `dataset.bound=1`，点击后 search 空、`#no-match` 隐藏、29 卡恢复；Esc 同样生效 | resolved |
| idle 锚点环 | `shots/final-anchor-idle.png`；实测 idle=strong 锚点 `boxShadow=2px brand`，状态边框保留 | resolved |

**新发现（落台账，下一轮）**：`ui-20261124-022` 命中环与锚点环同边重叠（polish）；`ui-20261124-004` 小目标从 28 → 40（标题按钮 18px 高，属新引入的可点目标，下一轮与命中区一起扩）。
**block 级计数：4 → 2**（003 320 溢出、004 小目标仍在账上）。复检未发现回归。

## 9. 下一步

1. **下一轮 top 3**：320px 单列堆叠（003）、命中区扩到 24×24 不改视觉（004，含新增标题按钮）、关闭后可撤销 / 详情重建不丢滚动（009/008）。
2. 补两处证据：toast 出现/消失录制、真实宿主下的断链错误态（standalone 替身会静态回退）。
3. 机制校准：A2B1 换防线；再跑 2 轮后按 acceptance 决定是否轮换 A1B2 为「比较者」。
4. 机制已按 R5 教训修复取证器：焦点证据必须用真键盘（`evidence/capture.md` §6.5）；证据包补 `inventory.json` / `metrics-summary.json`；错误态与静态回退如实记失败。

## 10. 第二轮（R7）：320px 真视口 + 200% 缩放等效

**请求**：对台账 top 3 跑第二轮评审，并补 320px 布局与真 200% 缩放的证据。

**证据（`~/.dsh/outbox/gate/2026-11-25-panel-r2/`）**

- `shots/narrow-list.png`：320×800 真视口（`narrow.json`：innerWidth 320 / scrollWidth 621 / overflow true）。
- `shots/zoom200-list.png`：200% 缩放**布局等效**——1440×900 窗口放大 200% ⇒ 720×450 CSS px，DPR 2。`zoom200.json`：720/720、overflow false、offscreen 582、smallTargets 54、headerTextOffscreen 0。
  > 诚实标注：CLI 无法设置 Chrome 的 Page Zoom 值，这一项是等效证；Lighthouse 之外的“真 Page Zoom”需人工在真实浏览器里做一次。
- `state/confirm-modal.png`：关闭确认弹窗（含「关错了可点『重开』恢复」承诺）。
- 采集失败项已如实记入 `MANIFEST.failures`：toast 截图未产出、`motion/anims.json` 本轮缺失；动效结论一律不作判。

**六席结论：台账三项全部未闭环，且证据比上一轮更硬**

| 台账 id | 结论（席位） | 新证据 |
| --- | --- | --- |
| 003 顶栏/窄屏 | open · 6/6 席确认 | 320 下 621px 页面溢出 + body overflow:hidden 无滚动路径；200% 等效下 KPI 竖排、标题首行被裁；根因拆成两处：工具栏 chipbar 601px 不换行 + 顶栏 483px、无 ≤1180 以下断点 |
| 004 小目标 | open · 5/5 席确认 | 1440 下**真实 57** 个（31×18 高标题按钮 / 20×22 / 6×23），不是台账写的 40——40 是采集脚本 slice 上限；200% 等效 54 个 |
| 009 撤销 | open · 5/5 席确认 | doClose 的 toast 不带 action、无 Ctrl/Cmd+Z；确认弹窗承诺的恢复入口在折叠 chip 里；「隐藏已闭环」开着时连 chip 都没有；另发现确认弹窗**默认焦点在「确认关闭」**上 |
| 008 详情重建 | open（措辞已校正） | 节点仍可见时 scrollTop 实测保留（60→60），但 card.innerHTML 全量重建、焦点回 BODY、prompt 编辑器状态丢失；筛选/搜索把锚点过滤掉时详情静默关闭并清零 |
| 007 首次打开重排 | open（证据升级） | 首次打开内容多的节点：470ms 后卡片 bottom=1001 > 视口 900，底部动作（发起/候选/复制 JSON）全部不可命中；缓存后第二次打开正常 |

**本轮新增（已落台账）**：023 确认弹窗默认聚焦破坏性按钮；024 320 下 404px 详情卡右侧被裁、关闭键不可见；025 取证脚本截断小目标清单（已修）。

**审计口径说明**：这是**定向评审轮**，六席的 locus 按设计集中在 4 个台账项上（顶栏 6 席、详情入口 6 席、恢复入口 4 席），因此不适用全量 Jaccard 阈值；正交性按“每席是否新增了不同后果”判断——A2B2 校正了 008 的机制、A1B2/A2B1/A3B1 抓出采集截断、A3B2 补出 320 详情卡，均为非重复输入。

**本轮冲突与裁决**

| 主题 | 一方 | 另一方 | 裁决 |
| --- | --- | --- | --- |
| 小目标怎么修 | A3B1/A3B2：放大到 ≥24×24 | A2B2：不得增高控件、不得降密度 | 只扩命中区（伪元素/热区），视觉高度与 1440 布局不变；验收同时看 elementFromPoint 命中盒 |
| 动效要不要动 | A2B2：先修因果、不新增动效 | A3B2：无 anims.json 不判动效 | 动效本轮不判；先做 008 的原地更新与 007 的先取数再定位 |
| 003 怎么收 | A2B2/A3B1：≤900px 断点重排 | A1B1/A1B2：宽屏密度不能动 | 断点只作用于 ≤900px，1440 布局与密度不变；按 design-change 走三套方案门禁后再落地 |

**下一轮 top 3（更新）**：1) 003 窄屏/200% 断点重排（design-change，先出 3 套方案）；2) 004 命中区外扩 + 023 弹窗默认焦点改「取消」；3) 009 撤销 toast + Ctrl/Cmd+Z（008/007 与它同属“操作连续性”簇，一起排）。
