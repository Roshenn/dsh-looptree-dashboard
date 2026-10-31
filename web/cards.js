/* 由 build-cards.mjs 生成，勿手改。源：samples/ */
window.ROTATION_CARDS = [
 {
  "schema": "rotation/v1",
  "project": {
   "name": "词块",
   "workspace": "/Users/julian/agentic/projects/chunks",
   "vision": "一套词块数据同时服务教与学两种用法：换教材只改数据、不改流程，两条路径都能独立交付。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "prompt_context": {
   "fields": [
    "project",
    "milestone",
    "support",
    "node"
   ],
   "siblings": 0
  },
  "milestone": {
   "id": "ck-loop",
   "kind": "milestone",
   "title": "双轨学习闭环",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "ck-i1",
     "kind": "support",
     "title": "词频驱动词块顺序",
     "support": "双轨共用的词块排序键",
     "necessity": "词块按什么顺序推给学习者，决定教与学两条路径能不能共用同一份数据；没有统一排序就要各自维护一套。",
     "causal": "词块数据没有统一排序键 → 教轨与学轨各自排序 → 换教材要改两处流程 → 双轨无法独立交付。",
     "metric": "COCA 前 6000 命中 ≥ 90%，且教/学两轨读到同一排序结果",
     "approach": "按 COCA 词频排序，优先级高于自定义顺序；排序结果作为只读字段落进词块数据。",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "ck-e1",
       "kind": "exec",
       "title": "COCA 前 6000 命中 ≥ 90%",
       "verify": "npm run measure -- coca",
       "status": "doing",
       "closed_at": null,
       "issues": [],
       "proof": "采样中",
       "started_at": "2026-10-20T09:00:00+08:00"
      }
     ]
    },
    {
     "id": "ck-i2",
     "kind": "support",
     "title": "语料词频现场计算",
     "support": "两轨共享的数据与进度结构",
     "necessity": "教与学各自记录进度，数据结构不统一时，换一套词块数据就得改两遍代码，双轨交付会互相拖住。",
     "causal": "进度结构绑定在单条路径上 → 两轨无法共用同一组词块 → 换数据要同步改两处 → 双轨不能独立交付。",
     "metric": "教/学两轨各走完 1 组词块，进度互不覆盖",
     "approach": "用户语料现场计算，不依赖预生成表；进度按「轨道 + 词块 id」分开存。",
     "status": "ready",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "ck-e2",
       "kind": "exec",
       "title": "采样 1.2 万句完成",
       "verify": "node scripts/sample.mjs --n 12000",
       "status": "ready",
       "closed_at": null,
       "issues": [],
       "started_at": "2026-10-20T09:00:00+08:00"
      }
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "教与学两条路径都能独立走完一组词块",
   "supports": "1)词频驱动的词块顺序（教/学两轨共用同一份排序）\n2)两轨共享的数据与进度结构（换教材只改数据）"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "练习卡面板",
   "workspace": "/Users/julian/agentic/projects/english-shadow-loop",
   "vision": "任何一条英文视频链接，都能变成可跟读、可计数的练习卡，学员不用自己剪音频、不必装本地工具。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "milestone": {
   "id": "xr-loop",
   "kind": "milestone",
   "title": "外部链接生成逐句练习卡",
   "status": "doing",
   "closed_at": null,
   "started_at": "2026-10-29T12:00:00+08:00",
   "lessons": [
    {
     "text": "面板与 host 先定记录 JSON 形状再写两侧，否则字段对不上要返工两次",
     "from": "xr-i1",
     "at": "2026-10-29T12:30:00+08:00"
    },
    {
     "text": "会话续跑要复用同一个 sessionId，新建会话就丢了计划上下文",
     "from": "xr-i1",
     "at": "2026-10-29T12:30:00+08:00"
    }
   ],
   "children": [
    {
     "id": "xr-i1",
     "kind": "support",
     "title": "外部链接自动补全卡片元信息",
     "support": "外部链接元信息自动补全",
     "necessity": "没有自动补全，用户粘链接后要自己填标题、时长、字幕可用性， 90 秒出练习卡不成立。",
     "causal": "链接页只有 videoId → 练习卡首屏缺标题/时长/字幕 → 用户手工补 → 出卡时间超过 90 秒。",
     "metric": "粘贴链接后 60 秒内出现练习卡，字幕缺失时走降级入口",
     "approach": "先解析视频标题与时长，缺什么补什么，再写进练习卡；字幕探测失败降级为手动上传。",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-29T12:10:00+08:00",
     "plan": {
      "goal": "粘贴链接后自动补全标题、时长、字幕可用性，并写入练习卡",
      "verify": [
       "npm run preflight",
       "npx playwright test tests/e2e/journey.spec.ts"
      ],
      "steps": [
       "解析链接拿到 videoId，用 oEmbed 取标题与作者",
       "字幕可用性探测失败时降级为手动上传字幕",
       "把元信息写进练习卡首屏，并加「重新解析」入口"
      ],
      "doc": "# 外部链接自动补全卡片元信息\n\n## 目标\n粘贴链接后自动补全标题、时长、字幕可用性，并写入练习卡。\n\n## 验证命令\n```bash\nnpm run preflight\nnpx playwright test tests/e2e/journey.spec.ts\n```\n\n## 步骤\n1. 解析链接拿到 videoId，用 oEmbed 取标题与作者\n2. 字幕可用性探测失败时降级为手动上传字幕\n3. 把元信息写进练习卡首屏，并加「重新解析」入口\n",
      "at": "2026-10-29T12:20:00+08:00",
      "session": "session-aaaa1111-2222-3333-4444-555566667777"
     },
     "children": [
      {
       "id": "xr-i1-p1",
       "kind": "exec",
       "action": "plan",
       "title": "计划 · 外部链接自动补全卡片元信息",
       "status": "done",
       "started_at": "2026-10-29T12:18:30+08:00",
       "closed_at": "2026-10-29T12:20:00+08:00",
       "proof": "计划已提交：3 个步骤、2 条验证命令",
       "session": {
        "id": "session-aaaa1111-2222-3333-4444-555566667777",
        "status": "done",
        "started_at": "2026-10-29T12:18:30+08:00",
        "ended_at": "2026-10-29T12:20:00+08:00",
        "result": "计划已提交，等待确认。"
       }
      },
      {
       "id": "xr-i1-e1",
       "kind": "exec",
       "action": "exec",
       "title": "执行 · 外部链接自动补全卡片元信息",
       "verify": "npm run preflight",
       "status": "done",
       "started_at": "2026-10-29T12:21:00+08:00",
       "closed_at": "2026-10-29T12:29:00+08:00",
       "proof": "preflight 绿；e2e 8 条通过；字幕缺失走降级分支",
       "session": {
        "id": "session-aaaa1111-2222-3333-4444-555566667777",
        "status": "done",
        "started_at": "2026-10-29T12:21:00+08:00",
        "ended_at": "2026-10-29T12:29:00+08:00",
        "result": "改完 3 处，验证命令全绿；oEmbed 429 时缓存 10 分钟。"
       }
      },
      {
       "id": "xr-i1-r1",
       "kind": "exec",
       "action": "reflect",
       "title": "反馈 · 外部链接自动补全卡片元信息",
       "status": "done",
       "started_at": "2026-10-29T12:29:05+08:00",
       "closed_at": "2026-10-29T12:30:00+08:00",
       "proof": "提炼 2 条经验，写入闭环经验积累",
       "session": {
        "id": "session-aaaa1111-2222-3333-4444-555566667777",
        "status": "done",
        "started_at": "2026-10-29T12:29:05+08:00",
        "ended_at": "2026-10-29T12:30:00+08:00",
        "result": "{\"lessons\":[\"面板与 host 先定记录 JSON 形状再写两侧\"]}"
       }
      },
      {
       "id": "xr-i1-e2",
       "kind": "exec",
       "action": "exec",
       "title": "执行 · 字幕缺失时的降级分支",
       "verify": "npm run preflight",
       "status": "blocked",
       "started_at": "2026-10-29T12:31:00+08:00",
       "closed_at": null,
       "issues": [
        {
         "text": "e2e 断言失败：字幕缺失时应显示手动上传入口，实际空白",
         "at": "2026-10-29T12:36:00+08:00"
        }
       ],
       "session": {
        "id": "session-bbbb1111-2222-3333-4444-555566667777",
        "status": "failed",
        "started_at": "2026-10-29T12:31:00+08:00",
        "ended_at": "2026-10-29T12:36:00+08:00",
        "result": "已改 UI，但 e2e 仍红。",
        "error": "turn 结束原因：error"
       }
      }
     ]
    },
    {
     "id": "xr-i2",
     "kind": "support",
     "title": "单句循环跟读与计数",
     "support": "逐句跟读与计数",
     "necessity": "跟读次数是学习闭环的度量；不计数的话，练习有没有发生、发生了多少都无法验证。",
     "causal": "计数只存在内存 → 刷新即丢 → 学习进度无法验证 → 跟读闭环缺证据。",
     "metric": "同一句反复跟读，次数可靠累计，刷新后不丢",
     "approach": "一句一卡，Enter 记一次，localStorage 持久化；迁移旧数据带版本号。",
     "status": "plan",
     "closed_at": null,
     "started_at": "2026-10-29T12:38:00+08:00",
     "plan": {
      "goal": "同一句可反复跟读，次数可靠累计并能清零",
      "verify": [
       "npm run preflight",
       "npx playwright test tests/e2e/count.spec.ts"
      ],
      "steps": [
       "抽出计数模块，读写 localStorage 带版本号",
       "Enter / 点击「本句已练」都记一次，避免重复绑定",
       "刷新后按版本号迁移旧数据"
      ],
      "doc": "# 单句循环跟读与计数\n\n## 目标\n同一句可反复跟读，次数可靠累计并能清零。\n\n## 验证命令\n```bash\nnpm run preflight\nnpx playwright test tests/e2e/count.spec.ts\n```\n\n## 步骤\n1. 抽出计数模块，读写 localStorage 带版本号\n2. Enter / 点击「本句已练」都记一次，避免重复绑定\n3. 刷新后按版本号迁移旧数据\n",
      "at": "2026-10-29T12:40:00+08:00",
      "session": "session-cccc1111-2222-3333-4444-555566667777"
     },
     "children": [
      {
       "id": "xr-i2-p1",
       "kind": "exec",
       "action": "plan",
       "title": "计划 · 单句循环跟读与计数",
       "status": "done",
       "started_at": "2026-10-29T12:38:30+08:00",
       "closed_at": "2026-10-29T12:40:00+08:00",
       "proof": "计划已提交：3 个步骤、2 条验证命令",
       "session": {
        "id": "session-cccc1111-2222-3333-4444-555566667777",
        "status": "done",
        "started_at": "2026-10-29T12:38:30+08:00",
        "ended_at": "2026-10-29T12:40:00+08:00",
        "result": "计划已提交，等待确认。"
       }
      }
     ]
    }
   ],
   "vision": "粘贴一个 YouTube 链接，就能得到一张可直接跟读的逐句练习卡",
   "supports": "1)外部链接元信息自动补全（标题/时长/字幕，90 秒内出卡）\n2)逐句跟读与计数（localStorage 持久化，刷新不丢）"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "竞品知识图谱",
   "workspace": "/Users/julian/agentic/projects/kg",
   "vision": "选型对比不再翻十几个标签页：四款竞品的功能、交互、定价在一张图里横向看完。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "milestone": {
   "id": "kg-loop",
   "kind": "milestone",
   "title": "竞品知识图谱闭环",
   "status": "done",
   "closed_at": "2026-10-18T16:40:00+08:00",
   "children": [
    {
     "id": "kg-i1",
     "kind": "support",
     "title": "官网 + 文档抓取",
     "support": "竞品数据的统一入库",
     "necessity": "四款竞品的功能与定价散在各自官网和文档里，不先统一入库，图谱就没有可对比的同一套字段。",
     "causal": "各站点字段名与结构不同 → 直接对比会错位 → 需要适配器把四款数据抓成同一张表。",
     "metric": "4 款竞品全量入图，功能点可追到出处，0 手工补录",
     "approach": "按站点适配抓取器，输出统一的功能/交互/定价字段。",
     "status": "done",
     "closed_at": "2026-10-18T14:10:00+08:00",
     "children": [
      {
       "id": "kg-e1",
       "kind": "exec",
       "title": "入库 4 款竞品",
       "verify": "node scripts/kg-ingest.mjs",
       "status": "done",
       "closed_at": "2026-10-18T14:00:00+08:00",
       "issues": [],
       "proof": "4 款入库"
      }
     ]
    },
    {
     "id": "kg-i2",
     "kind": "support",
     "title": "节点连线 + 过滤",
     "support": "图谱交互可用",
     "necessity": "数据入图只是原料，能按类别过滤并看清连线，才让「单屏对比」这件事成立。",
     "causal": "只有散点没有连线与过滤 → 用户仍要自己脑补竞品关系 → 对比退化成翻页。",
     "metric": "单屏看完 4 款核心差异，任一功能点能追到出处",
     "approach": "力导向布局，按类别过滤；切换竞品不重新布局。",
     "status": "done",
     "closed_at": "2026-10-18T16:30:00+08:00",
     "children": [
      {
       "id": "kg-e2",
       "kind": "exec",
       "title": "切换 4 款不卡顿",
       "verify": "webapp-testing 录屏",
       "status": "done",
       "closed_at": "2026-10-18T16:20:00+08:00",
       "issues": [],
       "proof": "切换 < 200ms"
      }
     ]
    }
   ],
   "vision": "竞品功能和交互能在一个图谱里横向对比",
   "supports": "1)竞品数据的统一入库（4 款官网 + 文档抓成同一套字段）\n2)图谱交互（节点连线 + 过滤，切换不重新布局）"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "NeedsFinder",
   "workspace": "/Users/julian/agentic/projects/needsfinder",
   "vision": "选题不再靠猜：每天从小红书真实讨论里捞出需求，按痛点强度排好，直接能开工。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "milestone": {
   "id": "nf-loop",
   "kind": "milestone",
   "title": "需求发现闭环",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "nf-i1",
     "kind": "support",
     "title": "抓取 → 聚类 → 打分",
     "support": "小红书抓取链路的稳定性",
     "necessity": "整条需求发现链路都挂在小红书数据上；抓取段不稳定，后面的聚类和打分再准也没有原料。",
     "causal": "扫码登录 6 小时失效 → 抓取中断 → 当天需求池为空 → 选题链路停摆。",
     "metric": "抓取段单次运行完整跑完，登录态保活 ≥ 6h",
     "approach": "三段各自可单独重跑；抓取段先修登录态保活，再谈聚类与打分。",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "nf-e1",
       "kind": "exec",
       "title": "登录态保活 6h",
       "verify": "node scripts/crawl.mjs --smoke",
       "status": "blocked",
       "closed_at": null,
       "issues": [
        {
         "text": "扫码登录 6 小时后失效，抓取链路中断",
         "at": "2026-10-26T21:35:00+08:00"
        }
       ],
       "started_at": "2026-10-16T00:30:00+08:00"
      }
     ]
    },
    {
     "id": "nf-i2",
     "kind": "support",
     "title": "需求去重",
     "support": "端到端产出可验证的需求列表",
     "necessity": "同一痛点会被多人重复发帖，不去重就凑不够 10 条真正不同的需求，产出不可用。",
     "causal": "原帖重复度高 → 直接排序会得到一堆同义条目 → 需要按语义相似度去重再排序。",
     "metric": "去重后 ≥10 条需求，每条带原帖出处链接",
     "approach": "按语义相似度去重，阈值 0.82；去重后再按痛点强度排序。",
     "status": "plan",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "nf-e2",
       "kind": "exec",
       "title": "需求去重率 < 20%",
       "verify": "node scripts/dedupe-stats.mjs",
       "status": "plan",
       "closed_at": null,
       "issues": []
      }
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "从小红书真实讨论里端到端产出可验证的需求列表",
   "supports": "1)小红书抓取链路的登录态与稳定性（决定当天有没有原料）\n2)需求去重与排序（决定产出是不是 10 条真正不同的需求）"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "shadowing",
   "workspace": "/Users/julian/agentic/projects/shadowing",
   "vision": "任意一条视频都能当教材：选一条就能逐句跟读，随时看到自己对齐了多少、还差哪几句。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "milestone": {
   "id": "sh-loop",
   "kind": "milestone",
   "title": "youtube 跟读闭环",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "sh-i1",
     "kind": "support",
     "title": "链接解析 + 落盘",
     "support": "素材入库链路",
     "necessity": "跟读的所有环节都依赖素材先落到本地；入库不闭环，后面的词幕与对齐都只能拿 demo 数据演示。",
     "causal": "链接解析不落盘 → 每次跟读都要重新抓 → 无法离线复用与断点续跑。",
     "metric": "链接解析 + 落盘可重复执行，40 条视频 0 失败",
     "approach": "yt-dlp 取字幕，落盘到 data/；入库命令可重复执行不产生重复素材。",
     "status": "done",
     "closed_at": "2026-10-22T09:20:00+08:00",
     "children": [
      {
       "id": "sh-e1",
       "kind": "exec",
       "title": "入库 40 条视频",
       "verify": "node scripts/ingest.mjs --dry",
       "status": "done",
       "closed_at": "2026-10-22T09:10:00+08:00",
       "issues": [],
       "proof": "40 条入库，0 失败"
      }
     ]
    },
    {
     "id": "sh-i2",
     "kind": "support",
     "title": "字幕抓取 + 时间轴对齐",
     "support": "词幕逐句高亮与对齐",
     "necessity": "逐句跟读靠的是「当前这句在哪」，时间轴对不上，高亮就会提前或滞后，跟读体验直接失效。",
     "causal": "自动字幕缺时间轴 → 词幕只能整段显示 → 无法逐句高亮 → 跟读退化成看字幕。",
     "metric": "抽样 10 条视频，逐句高亮与音频偏差 < 120ms",
     "approach": "优先用自动字幕时间轴；缺时间轴时走人工兜底，不让整条链路卡死。",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "sh-e2",
       "kind": "exec",
       "title": "对齐误差 < 120ms",
       "verify": "node scripts/align-check.mjs",
       "status": "doing",
       "closed_at": null,
       "issues": [],
       "proof": "实测 180ms",
       "started_at": "2026-10-20T09:00:00+08:00"
      },
      {
       "id": "sh-e3",
       "kind": "exec",
       "title": "自动字幕缺时间轴",
       "verify": "node scripts/subtitle-check.mjs",
       "status": "blocked",
       "closed_at": null,
       "issues": [
        {
         "text": "长视频无自动字幕，需人工时间轴",
         "at": "2026-10-26T20:05:00+08:00"
        }
       ],
       "started_at": "2026-10-20T09:00:00+08:00"
      }
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "选一条视频就能逐句跟读并对齐",
   "supports": "1)素材入库链路（链接解析 + 落盘可重复执行）\n2)字幕时间轴对齐（缺自动字幕时有人工兜底）"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "StoryWeft",
   "workspace": "/Users/julian/agentic/projects/storyweft",
   "vision": "作者改一段情节，视觉与结构同时更新：评审不用再截图对稿，打开项目就能看到三层情节图。"
  },
  "updated": "2026-10-31T00:00:00+08:00",
  "prompts": {
   "support": [
    {
     "id": "regen",
     "title": "重新生成实现思路（保留核心指标）",
     "ask": "保留里程碑的重要支撑与支撑项的核心指标，重新给出 2 个替代实现思路；每个写清与现方案的差异、代价、以及对核心指标的影响。"
    },
    {
     "id": "split3",
     "title": "拆成 3 个执行动作",
     "ask": "把这个支撑项的实现思路拆成恰好 3 个执行动作，每个动作一条可直接运行的验证命令。"
    },
    {
     "id": "contract",
     "title": "写成接口契约",
     "ask": "把这个支撑项的实现思路写成可对接的接口契约：输入、输出、错误码、以及谁调用它。"
    }
   ]
  },
  "prompt_context": {
   "fields": [
    "project",
    "milestone",
    "milestone.vision",
    "milestone.supports",
    "support",
    "support.necessity",
    "support.causal",
    "support.metric",
    "support.approach",
    "siblings",
    "node",
    "node.metric",
    "node.approach",
    "exec.verify",
    "exec.proof",
    "exec.issues",
    "children"
   ],
   "siblings": 3,
   "refs": [
    "sw-e4"
   ]
  },
  "services": [
   {
    "id": "panel",
    "name": "轮转面板 4173",
    "url": "http://127.0.0.1:4173",
    "health": "/api/run-config"
   },
   {
    "id": "web5800",
    "name": "本地预览 5800",
    "url": "http://127.0.0.1:5800",
    "start": "python3 -m http.server 5800",
    "cwd": "/tmp/rt-workspace"
   }
  ],
  "milestone": {
   "id": "sw-loop",
   "kind": "milestone",
   "title": "3 情节层渲染可视化",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "sw-i1",
     "kind": "support",
     "title": "章节 → 情节两层索引",
     "support": "章节→情节两层索引",
     "necessity": "三层图的数据底座：没有两层索引，上面两层只能靠章节文本硬猜位置，切换章节时对不上。",
     "causal": "章节表与情节表没有共享 id → 无法双向查询 → 三层图无法按章节重组 → 打开即见三层图落空。",
     "metric": "章节与情节两层索引可双向查询，构建后校验全绿",
     "approach": "章节表 + 情节表，情节挂章节 id；先建索引再做校验。",
     "status": "ready",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "sw-e1",
       "kind": "exec",
       "title": "索引构建 + 校验通过",
       "verify": "npm test -- index.spec.ts",
       "proof": "4 个测试用例全绿（2026-10-24）",
       "status": "done",
       "closed_at": "2026-10-24T10:30:00+08:00",
       "issues": []
      }
     ]
    },
    {
     "id": "sw-i2",
     "kind": "support",
     "title": "分层 SVG 绘制",
     "support": "分层 SVG 绘制（每层一个 <g>）",
     "necessity": "三层图要能各自独立更新，又必须叠在一起对齐；不先分层，任何一层的改动都会牵动整图。",
     "causal": "三层画在同一图层 → 改一层要整图重绘 → 单层 100 节点也画不快 → 首屏 800ms 达不到。",
     "metric": "单层渲染 100 节点 < 300ms，三层叠加位置对齐",
     "approach": "每层一个 <g>，用 transform 叠加；层内节点复用缓存。",
     "status": "ready",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "sw-e2",
       "kind": "exec",
       "title": "单层渲染 100 节点",
       "verify": "npm run bench -- render",
       "proof": "实测 210ms",
       "status": "done",
       "closed_at": "2026-10-26T16:03:15.932Z",
       "issues": [],
       "session": {
        "id": "session-11111111-2222-3333-4444-555555555555",
        "status": "done",
        "cwd": "/Users/julian/agentic/projects/storyweft",
        "task_id": "steps",
        "started_at": "2026-10-25T10:02:00+08:00",
        "ended_at": "2026-10-25T10:09:31+08:00",
        "exit_code": 0,
        "result": "已给单层渲染拆出 3 步：先建 layer 容器，再复用节点缓存，最后接通 hover。bench 210ms → 96ms。"
       }
      }
     ]
    },
    {
     "id": "sw-i3",
     "kind": "support",
     "title": "分层绘制 + 缓存",
     "support": "章节 id 缓存与首屏测量",
     "necessity": "首屏 800ms 的瓶颈在重复绘制；不按章节缓存已绘制的层，切换章节就会把三层全部重画一遍。",
     "causal": "每次切章节重画三层 → 首屏实测 1.1s → 需要按章节 id 缓存层，并用 cache hit rate 证明优化有效。",
     "metric": "首屏 3 层 < 800ms，章节切换不闪烁",
     "approach": "按章节 id 缓存已绘制的层；先补 cache hit rate 与首屏埋点，再按数据优化。",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-21T21:00:00+08:00",
     "children": [
      {
       "id": "sw-e3",
       "kind": "exec",
       "title": "首屏 3 层 < 800ms",
       "verify": "npm run bench -- first-paint",
       "proof": "实测 1.1s（未达标）",
       "status": "doing",
       "closed_at": null,
       "issues": [],
       "children": [
        {
         "id": "sw-e3a",
         "kind": "exec",
         "title": "拆解：层缓存命中率",
         "verify": "打印 cache hit rate",
         "status": "doing",
         "closed_at": null,
         "issues": [],
         "started_at": "2026-10-18T21:00:00+08:00"
        },
        {
         "id": "sw-e3b",
         "kind": "exec",
         "title": "拆解：首屏测量埋点",
         "verify": "performance.mark 时间线",
         "status": "plan",
         "closed_at": null,
         "issues": []
        }
       ],
       "started_at": "2026-10-20T09:00:00+08:00"
      },
      {
       "id": "sw-e4",
       "kind": "exec",
       "title": "章节切换不闪烁",
       "verify": "录制 3 次切换，无残影帧",
       "status": "blocked",
       "closed_at": null,
       "issues": [
        {
         "text": "切换时旧层未清空，出现残影",
         "at": "2026-10-26T22:12:00+08:00"
        }
       ],
       "started_at": "2026-10-18T00:30:00+08:00",
       "proof": "录屏 3 次切换，残影出现在 2/3 帧",
       "prompts": [
        {
         "id": "repro",
         "title": "给我最小复现步骤",
         "ask": "列出复现「章节切换残影」的最小步骤，并写出期望结果与实际结果。"
        }
       ]
      }
     ]
    },
    {
     "id": "sw-i4",
     "kind": "support",
     "title": "复用既有地图图层",
     "support": "既有地图图层复用",
     "necessity": "地图图层已经跑通；重写一遍不仅重复劳动，还会撞上节点位置与情节层的对齐问题。",
     "causal": "新画地图图层 → 节点位置与情节层对不齐 → 需要重新做对齐 → 直接复用老 layer 实例省掉这段成本。",
     "metric": "地图图层可复用，节点位置稳定",
     "approach": "直接接老地图的 layer 实例，不重画。",
     "status": "done",
     "closed_at": "2026-10-24T17:40:00+08:00",
     "children": [
      {
       "id": "sw-e5",
       "kind": "exec",
       "title": "图层复用接入",
       "verify": "地图可拖动且节点对齐",
       "proof": "手动验证通过",
       "status": "done",
       "closed_at": "2026-10-24T17:30:00+08:00",
       "issues": []
      }
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "lessons": [
    {
     "text": "三层图的数据底座先定成「章节 id + 情节 id」双索引，后面两个支撑项才能各改各的",
     "from": "sw-i1",
     "at": "2026-10-24T10:40:00+08:00"
    },
    {
     "text": "首屏优化先埋点再动手：没有 cache hit rate 就说不清这次改动到底有没有用",
     "from": "sw-i3",
     "at": "2026-10-26T22:20:00+08:00"
    }
   ],
   "vision": "打开项目就能看到三层情节图，不用读代码",
   "supports": "1)章节→情节两层索引（src/plot/index.ts，三层图的数据底座）\n2)分层 SVG 绘制（每层一个 <g>，独立更新且叠加对齐）\n3)章节 id 缓存与首屏测量（首屏 < 800ms 的瓶颈在这里）\n4)既有地图图层复用（省掉节点对齐成本）"
  }
 }
];
