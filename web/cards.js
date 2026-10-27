/* 由 bundle-data.mjs 生成，勿手改。源：samples/ */
window.ROTATION_CARDS = [
 {
  "schema": "rotation/v1",
  "project": {
   "name": "词块",
   "workspace": "/Users/julian/agentic/projects/chunks"
  },
  "updated": "2026-10-26T23:20:00+08:00",
  "loop": {
   "id": "ck-loop",
   "kind": "loop",
   "title": "双轨学习闭环",
   "intent": "教与学两条路径都能独立走完一组词块",
   "acceptance": "两轨各完成 1 组词块且进度不互相覆盖",
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
   "started_at": "2026-10-24T21:00:00+08:00"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "竞品知识图谱",
   "workspace": "/Users/julian/agentic/projects/kg"
  },
  "updated": "2026-10-26T23:20:00+08:00",
  "loop": {
   "id": "kg-loop",
   "kind": "loop",
   "title": "竞品知识图谱闭环",
   "intent": "竞品功能和交互能在一个图谱里横向对比",
   "acceptance": "2 个目标全部关闭，4 款竞品可切换",
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
   ]
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "NeedsFinder",
   "workspace": "/Users/julian/agentic/projects/needsfinder"
  },
  "updated": "2026-10-26T23:20:00+08:00",
  "loop": {
   "id": "nf-loop",
   "kind": "loop",
   "title": "需求发现闭环",
   "intent": "从小红书真实讨论里端到端产出可验证的需求列表",
   "acceptance": "10 条需求中 ≥6 条可由第三方复现",
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
   "started_at": "2026-10-24T21:00:00+08:00"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "shadowing",
   "workspace": "/Users/julian/agentic/projects/shadowing"
  },
  "updated": "2026-10-26T23:20:00+08:00",
  "loop": {
   "id": "sh-loop",
   "kind": "loop",
   "title": "youtube 跟读闭环",
   "intent": "选一条视频就能逐句跟读并对齐",
   "acceptance": "10 条视频中 ≥9 条字幕可渲染",
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
   "started_at": "2026-10-24T21:00:00+08:00"
  }
 },
 {
  "schema": "rotation/v1",
  "project": {
   "name": "StoryWeft",
   "workspace": "/Users/julian/agentic/projects/storyweft"
  },
  "updated": "2026-10-26T16:03:14.664Z",
  "loop": {
   "id": "sw-loop",
   "kind": "loop",
   "title": "3 情节层渲染可视化",
   "intent": "打开项目就能看到三层情节图，不用读代码",
   "acceptance": "三层各 ≥ 8 节点、可折叠、首屏 < 800ms",
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
         "issues": []
        }
       ],
       "started_at": "2026-10-21T21:00:00+08:00"
      }
     ],
     "started_at": "2026-10-23T09:00:00+08:00"
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
         "started_at": "2026-10-18T00:30:00+08:00"
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
   "started_at": "2026-10-24T21:00:00+08:00"
  }
 }
];
