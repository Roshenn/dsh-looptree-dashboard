# CHANGELOG

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
