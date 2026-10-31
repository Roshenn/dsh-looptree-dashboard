# 架构

## 一、一句话

一个 DSH 插件包，host 半把面板与接口挂到 DSH 自己的 web server 上，client 半在 GUI 右栏加一个入口；
数据以 `rotation/v1` JSON 存在各项目里，会话与服务都在 DSH 进程内执行。

## 二、进程与路由

```
DSH 进程
├─ host 半  lib/index.js            （cordis 插件：export apply/name/inject）
│   ├─ /rotation/app/*              面板静态资源（web/）
│   ├─ /rotation/api/health         自检
│   ├─ /rotation/api/projects       注册表读写
│   ├─ /rotation/api/cards          卡片读写（PUT 走 validate → tmp+rename 原子写）
│   ├─ /rotation/api/run*           节点会话（lib/runner.mjs → ctx.agents）
│   ├─ /rotation/api/prompts        prompt 合成（lib/prompt.mjs，只读）
│   ├─ /rotation/api/service*       单个服务拉起 / 停止（lib/services.mjs）
│   ├─ /rotation/api/services/all   全部项目的服务、端口与冲突
│   ├─ /rotation/api/services/start-all · stop-all   跨项目批量拉起（有冲突整批拒绝）/ 按端口关闭
│   └─ /rotation/api/services*      服务收集（AI 会话 → 草稿 → 预览探活 → 写回）
└─ client 半 lib/client.js          （__ModuleLoader__ 模块）
    └─ sidebar.right.pane.tab       右栏「轮转」入口 → 打开 /rotation/app/
```

## 三、数据

| 数据 | 位置 | 谁写 |
|---|---|---|
| 项目注册表 | `~/.dsh/rotation/registry.json` | host（POST /api/projects、迁移脚本） |
| 卡片真身 | `<workspace>/.dsh/rotation.json` | host（PUT /api/cards）、可手改 |
| 候选池 | `~/.dsh/rotation/candidates/<卡片文件>__<节点 id>.json` | host（`/api/candidates/generate` 写、`/adopt`/`/delete` 删）；按 `importance` 降序 |
| 里程碑历史 | 同一卡片的 `closed_milestones[]`（压缩快照，≤10） | 面板「确认达成」时随整卡写回 |
| 运行状态 | 进程内（内存） | runner；结束写回卡片的 `session` 字段 |
| 服务进程 | 进程内（内存） | services；插件 dispose 时兜底杀掉 |

卡片字段见 `rotation-card-spec.md`；节点阶梯是 **`milestone`（深度 1）→ `capability`（深度 2）→ `exec`（深度 3+）**，
2026-10-31 由 `milestone → goal → idea → exec` 四层收敛而来：`goal` / `idea` 读入即折叠成 `capability`
（`lib/core.mjs` 的 `normalizeLegacyCard`），存量卡用 `npm run migrate:capabilities -- --write` 落盘。
注册表只有指针：`{ id, name, workspace, file }`。
注册表是多台机器共用的文件（`~/.dsh` 走 git 同步），但 `workspace` 是各机器的绝对路径；
`lib/store.mjs` 用 `isLocalEntry` / `partitionRegistry` 按「`workspace` 目录在本机存在」区分两半：
本机条目参与显示、查重、移除，另一台机器的条目既不显示也不占 id，写回时原样保留。

## 四、关键决定

1. **UI 不重写**：现有 `web/index.html` 直接由 host 半托管，client 半只用 iframe/新标签打开。
   好处是原型期积累的交互全部保留；代价是 client 半只有一个入口，不是原生面板。
2. **会话走进程内 agent**：`ctx.agents.create` + `agent.followup` + `ctx.on('session/event')`。
   这样模型凭据/provider 路由沿用 GUI 配置（也满足「模型调用必须走网关」的本机铁律）。
3. **不 spawn `dsh --profile headless`**：那条路依赖 headless profile 自己的凭据插件，且默认直连厂商，
   与网关规则冲突。
4. **写入永远先校验**：`validateCard` → 422 拒绝 → tmp+rename 原子替换；不另留 `.bak`，历史版本由 git 负责。
5. **折叠/状态都是渲染层**：收敛进度、健康度、节点统计用完整树计算，不受折叠影响。

## 五、事件与状态机

```
POST /api/run
  └─ runner.start
       ├─ ctx.agents.create({sessionId, agentOptions, meta:{cwd}, setup})
       ├─ agent.followup(user message)
       └─ ctx.on('session/event', (session, event))       ← 两参数！
            turn/start | step/*        → running
            assistant/message          → result 预览
            turn/end(completed)        → done
            turn/end(其它 reason)      → failed
            超时 15 分钟               → failed + interrupt
  结束 → persistSession → 卡片 node.session
```

## 六、目录

```
lib/index.js      宿主插件入口（路由 + 装配）
lib/prompt.mjs    prompt 唯一实现（结构规范 / 合成 / lint，host 与测试共用）
lib/store.mjs     注册表 / 卡片读写
lib/runner.mjs    会话执行器
lib/services.mjs  服务探活、单个/批量拉起、按端口关闭（端口解析与冲突检测也在这里）
lib/core.mjs      rotation/v1 校验（host 与 CLI 共用；含 goal/idea → capability 的旧卡折叠）
lib/client.js     浏览器侧入口
web/              面板本体（index.html + cards.js 兜底数据）
scripts/          dev-host / mock / lint / migrate（含 migrate-capabilities）/ check-install
samples/          5 张样例卡（也是校验样例）
```

## 七、本地验证手段

| 想验什么 | 命令 |
|---|---|
| 打包自检（装不上的常见原因） | `npm run lint:plugin` |
| host 半路由 | `npm run dev` → `/rotation/api/health` |
| 面板 + 发起会话联调 | `MOCK_AGENTS=1 npm run dev`（假 agent，状态会走 运行中→完成） |
| 会话状态机 | `npm run mock:session`（done / failed / cancelled） |
| 全部服务批量控制（端口冲突 / 按端口杀进程） | `npm run mock:services-batch` |
| client 半契约 | `npm run mock:client` |
| 装进 DSH 后 | `npm run check`（health / panel / registry） |
| 全量 | `npm run preflight` |
