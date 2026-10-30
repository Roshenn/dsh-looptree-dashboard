/* 由 build-cards.mjs 生成，勿手改。源：samples/ */
window.ROTATION_CARDS = [
 {
  "schema": "rotation/v1",
  "project": {
   "name": "词块",
   "workspace": "/Users/julian/agentic/projects/chunks",
   "vision": "一套词块数据同时服务教与学两种用法：换教材只改数据、不改流程，两条路径都能独立交付。"
  },
  "updated": "2026-10-30T00:42:55.975Z",
  "prompt_context": {
   "fields": [
    "project",
    "milestone",
    "goal",
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
     "id": "ck-g1",
     "kind": "goal",
     "title": "教学轨可用",
     "acceptance": "教学轨能按词频顺序推送词块",
     "status": "doing",
     "closed_at": null,
     "children": [
      {
       "id": "ck-i1",
       "kind": "idea",
       "title": "词频驱动词块顺序",
       "approach": "按 COCA 词频排序，优先级高于自定义顺序",
       "status": "doing",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
    },
    {
     "id": "ck-g2",
     "kind": "goal",
     "title": "学习轨可用",
     "acceptance": "学习轨能记录每块掌握度",
     "status": "ready",
     "closed_at": null,
     "children": [
      {
       "id": "ck-i2",
       "kind": "idea",
       "title": "语料词频现场计算",
       "approach": "用户语料现场计算，不依赖预生成表",
       "status": "ready",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "教与学两条路径都能独立走完一组词块",
   "metrics": "1)两轨各自走完 1 组词块，进度互不覆盖\n2)同一组词块在教/学两个入口都能打开，切换 ≤2 次点击\n3)换一套词块数据后，两轨都不改代码即可跑通"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "练习卡面板",
   "workspace": "/Users/julian/agentic/projects/english-shadow-loop",
   "vision": "任何一条英文视频链接，都能变成可跟读、可计数的练习卡，学员不用自己剪音频、不必装本地工具。"
  },
  "updated": "2026-10-30T00:42:55.982Z",
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
     "id": "xr-g1",
     "kind": "goal",
     "title": "链接到练习卡可一键生成",
     "acceptance": "粘贴链接后 60 秒内出现练习卡",
     "status": "doing",
     "closed_at": null,
     "started_at": "2026-10-29T12:05:00+08:00",
     "children": [
      {
       "id": "xr-i1",
       "kind": "idea",
       "title": "外部链接自动补全卡片元信息",
       "approach": "先解析视频标题与时长，缺什么补什么，再写进练习卡",
       "status": "doing",
       "closed_at": null,
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
       "started_at": "2026-10-29T12:10:00+08:00",
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
       "kind": "idea",
       "title": "单句循环跟读与计数",
       "approach": "一句一卡，Enter 记一次，localStorage 持久化",
       "status": "plan",
       "closed_at": null,
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
       "started_at": "2026-10-29T12:38:00+08:00",
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
     ]
    }
   ],
   "vision": "粘贴一个 YouTube 链接，就能得到一张可直接跟读的逐句练习卡",
   "metrics": "1)粘贴任意 YouTube 链接，90 秒内出练习卡\n2)刷新页面后跟读计数与练习进度不丢\n3)抽 10 条链接，≥9 条能直接出卡且不用手工修字幕"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "竞品知识图谱",
   "workspace": "/Users/julian/agentic/projects/kg",
   "vision": "选型对比不再翻十几个标签页：四款竞品的功能、交互、定价在一张图里横向看完。"
  },
  "updated": "2026-10-30T00:42:55.982Z",
  "milestone": {
   "id": "kg-loop",
   "kind": "milestone",
   "title": "竞品知识图谱闭环",
   "status": "done",
   "closed_at": "2026-10-18T16:40:00+08:00",
   "children": [
    {
     "id": "kg-g1",
     "kind": "goal",
     "title": "四款竞品数据入库",
     "acceptance": "4 款竞品官网+文档抓取完成",
     "status": "done",
     "closed_at": "2026-10-18T14:20:00+08:00",
     "children": [
      {
       "id": "kg-i1",
       "kind": "idea",
       "title": "官网 + 文档抓取",
       "approach": "按站点适配抓取器",
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
      }
     ]
    },
    {
     "id": "kg-g2",
     "kind": "goal",
     "title": "图谱交互可用",
     "acceptance": "节点连线 + 过滤，切换不卡顿",
     "status": "done",
     "closed_at": "2026-10-18T16:40:00+08:00",
     "children": [
      {
       "id": "kg-i2",
       "kind": "idea",
       "title": "节点连线 + 过滤",
       "approach": "力导向布局，按类别过滤",
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
     ]
    }
   ],
   "vision": "竞品功能和交互能在一个图谱里横向对比",
   "metrics": "1)4 款竞品全部入图，可一键切换\n2)任一功能点都能追到出处（官网 / 文档链接）\n3)单屏看完 4 款核心差异，不用滚第二屏"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "NeedsFinder",
   "workspace": "/Users/julian/agentic/projects/needsfinder",
   "vision": "选题不再靠猜：每天从小红书真实讨论里捞出需求，按痛点强度排好，直接能开工。"
  },
  "updated": "2026-10-30T00:42:55.983Z",
  "milestone": {
   "id": "nf-loop",
   "kind": "milestone",
   "title": "需求发现闭环",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "nf-g1",
     "kind": "goal",
     "title": "小红书链路跑通",
     "acceptance": "抓取→聚类→打分三段能跑完整条链路",
     "status": "blocked",
     "closed_at": null,
     "children": [
      {
       "id": "nf-i1",
       "kind": "idea",
       "title": "抓取 → 聚类 → 打分",
       "approach": "三段各自可单独重跑",
       "status": "doing",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
    },
    {
     "id": "nf-g2",
     "kind": "goal",
     "title": "端到端产出 10 条需求",
     "acceptance": "去重后 ≥10 条且带出处链接",
     "status": "plan",
     "closed_at": null,
     "children": [
      {
       "id": "nf-i2",
       "kind": "idea",
       "title": "需求去重",
       "approach": "按语义相似度去重，阈值 0.82",
       "status": "plan",
       "closed_at": null,
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
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "从小红书真实讨论里端到端产出可验证的需求列表",
   "metrics": "1)单次运行产出 ≥10 条去重需求，每条带原帖出处\n2)其中 ≥6 条能被第三方按原帖复现\n3)从抓取到排序一次跑完，不需要人工补数据"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "shadowing",
   "workspace": "/Users/julian/agentic/projects/shadowing",
   "vision": "任意一条视频都能当教材：选一条就能逐句跟读，随时看到自己对齐了多少、还差哪几句。"
  },
  "updated": "2026-10-30T00:42:55.983Z",
  "milestone": {
   "id": "sh-loop",
   "kind": "milestone",
   "title": "youtube 跟读闭环",
   "status": "doing",
   "closed_at": null,
   "children": [
    {
     "id": "sh-g1",
     "kind": "goal",
     "title": "素材入库",
     "acceptance": "链接解析 + 落盘可重复执行",
     "status": "done",
     "closed_at": "2026-10-22T09:30:00+08:00",
     "children": [
      {
       "id": "sh-i1",
       "kind": "idea",
       "title": "链接解析 + 落盘",
       "approach": "yt-dlp 取字幕，落盘到 data/",
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
      }
     ]
    },
    {
     "id": "sh-g2",
     "kind": "goal",
     "title": "词幕加载展示",
     "acceptance": "词幕逐句高亮且与音频对齐",
     "status": "doing",
     "closed_at": null,
     "children": [
      {
       "id": "sh-i2",
       "kind": "idea",
       "title": "字幕抓取 + 时间轴对齐",
       "approach": "自动字幕缺时间轴时走人工兜底",
       "status": "doing",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "vision": "选一条视频就能逐句跟读并对齐",
   "metrics": "1)抽样 10 条视频，≥9 条字幕可渲染\n2)逐句高亮与音频偏差 < 200ms\n3)中途退出再回来，进度停在原句不丢"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "StoryWeft",
   "workspace": "/Users/julian/agentic/projects/storyweft",
   "vision": "作者改一段情节，视觉与结构同时更新：评审不用再截图对稿，打开项目就能看到三层情节图。"
  },
  "updated": "2026-10-30T00:42:55.984Z",
  "prompts": {
   "idea": [
    {
     "id": "regen",
     "title": "重新生成构思（保留验收）",
     "ask": "保留闭环意图与目标验收，重新给出 2 个替代构思；每个写清与现方案的差异、代价、以及对验收方式的影响。"
    },
    {
     "id": "split3",
     "title": "拆成 3 个执行动作",
     "ask": "把这个构思拆成恰好 3 个执行动作，每个动作一条可直接运行的验证命令。"
    },
    {
     "id": "contract",
     "title": "写成接口契约",
     "ask": "把这个构思写成可对接的接口契约：输入、输出、错误码、以及谁调用它。"
    }
   ]
  },
  "prompt_context": {
   "fields": [
    "project",
    "milestone",
    "milestone.vision",
    "milestone.metrics",
    "goal",
    "goal.acceptance",
    "idea",
    "idea.approach",
    "siblings",
    "node",
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
     "id": "sw-g1",
     "kind": "goal",
     "title": "情节数据模型可用",
     "acceptance": "章节与情节两层索引可双向查询",
     "status": "doing",
     "closed_at": null,
     "children": [
      {
       "id": "sw-i1",
       "kind": "idea",
       "title": "章节 → 情节两层索引",
       "approach": "章节表 + 情节表，情节挂章节 id",
       "status": "ready",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      },
      {
       "id": "sw-i2",
       "kind": "idea",
       "title": "分层 SVG 绘制",
       "approach": "每层一个 <g>，用 transform 叠加",
       "status": "ready",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00",
     "blocker": "缺章节→情节索引",
     "scenario": "1) 操作：在章节编辑区改一段情节\n  预期：右侧三层情节图在 300ms 内更新\n  体验：不用手动刷新、不用切 tab\n2) 操作：点开第二层的某个节点\n  预期：展开该节点的三层关联（上级长卷 / 同级 / 下级情节）\n  体验：一屏内看完，不需要二次搜索\n3) 操作：折叠第二层\n  预期：第一、三层仍然对齐，折叠状态刷新后保留\n  体验：折叠/展开 ≤ 2 次点击"
    },
    {
     "id": "sw-g2",
     "kind": "goal",
     "title": "三层叠渲染管线",
     "acceptance": "切换章节时三层同步刷新且无残影",
     "status": "doing",
     "closed_at": null,
     "children": [
      {
       "id": "sw-i3",
       "kind": "idea",
       "title": "分层绘制 + 缓存",
       "approach": "按章节 id 缓存已绘制的层",
       "status": "doing",
       "closed_at": null,
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
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
    },
    {
     "id": "sw-g3",
     "kind": "goal",
     "title": "地图渲染完成",
     "acceptance": "地图图层可复用，节点位置稳定",
     "status": "done",
     "closed_at": "2026-10-24T18:00:00+08:00",
     "children": [
      {
       "id": "sw-i4",
       "kind": "idea",
       "title": "复用既有地图图层",
       "approach": "直接接老地图的 layer 实例",
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
     ]
    }
   ],
   "started_at": "2026-10-24T21:00:00+08:00",
   "blockers": "1)缺章节→情节索引（src/plot/index.ts 无实现）→ 挡在「打开即见三层图」\n2)缺分层采样（无 LOD 计算，8 节点起就掉帧）→ 挡在「首屏 < 800ms」\n3)缺折叠交互（无展开/收起状态）→ 挡在「可折叠」这一步",
   "metrics": "1)三层图各 ≥8 节点，可折叠\n2)首屏渲染 < 800ms\n3)点任一情节节点，能定位到对应章节原文",
   "vision": "打开项目就能看到三层情节图，不用读代码"
  }
 }
];
