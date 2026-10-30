# 安装与验证

> **一句话**：这台机器是 **link 安装**（profile 里是软链指向本仓库），所以更新 = 改仓库 / `git pull`
> → 刷新面板（改了 `lib/` 才重启 DSH）。**不需要装 `.tgz`**，仓库里也不再产出 tgz。

## 一、link 安装的本机更新法（日常就用这个）

本机两个 profile 都是软链：

```bash
grep looptree ~/.dsh/profiles/desktop/package.json
#   "dsh-looptree-dashboard": "link:../../dsh-looptree-dashboard"
ls -l ~/.dsh/profiles/desktop/node_modules/dsh-looptree-dashboard
#   -> ../../../dsh-looptree-dashboard
```

插件代码就是仓库工作树，所以更新只有三步：

1. **改代码**（或 `git pull` 把另一台机器的提交拉下来）。
2. **面板改动（`web/`）**：直接刷新 `/rotation/app/`。host 每个请求都从磁盘读 `web/index.html`
   （`lib/index.js` 的 `readFile(abs)`），不缓存，刷新即生效。
3. **host 改动（`lib/`）**：重启 DSH（桌面端退出重开，或重启 `dsh web`）。Node 已加载的模块不会热更。

改没改对，用 health 确认（端口 = DSH 网页端口，看 GUI 地址栏）：

```bash
curl -s http://127.0.0.1:<端口>/rotation/api/health
# 期望：{"ok":true,"name":"dsh-looptree-dashboard","version":"x.y.z",...}
```

注意 `version` 是 **模块加载时读一次** 的（`lib/index.js` 的 `VERSION`），所以改了版本号必须重启才变；
面板已刷新到新行为、health 还是旧版本号，属于正常现象。

**不要做什么**：不要为了更新去 `npm pack`、不要往市场里装 `.tgz`。那会把 profile 里的 `link:`
换成一份复制品，之后每版都得重装——正是这套 link 安装要避免的。

## 二、换一台机器 / 新 profile 怎么装（也是 link）

1. 把仓库放在固定路径（本机是 `~/.dsh/dsh-looptree-dashboard`）。
2. 在目标 profile 的 `package.json` 里登记软链，并让 bundles 引到它：

   ```json
   {
     "dependencies": { "dsh-looptree-dashboard": "link:../../dsh-looptree-dashboard" }
   }
   ```

   在同一 profile 目录用 **app 自带的那份 pnpm** 安装（不要用终端里另一份 pnpm，
   两份 store 会互相覆盖，见 `docs/dev-setup.md` §5）。
3. 桌面端市场 UI 也可以装：填**仓库目录绝对路径**（不是 `.tgz` 文件路径，市场不接受文件地址）。
4. 重启 DSH，按 §三 验证。

将来要装到「没有仓库副本」的机器上时，**直接基于 GitHub 仓库安装**（市场里填仓库地址）。
这部分暂不设计，也不再用 tgz。

## 三、验证清单（按顺序做，任一步失败就停）

```bash
# 1) 插件是否挂上
curl -s http://127.0.0.1:<端口>/rotation/api/health
#    期望：{"ok":true,"name":"dsh-looptree-dashboard","version":"x.y.z",...}

# 2) 面板是否可打开
open http://127.0.0.1:<端口>/rotation/app/

# 3) 入口：左栏应出现「轮转里程碑树」（在「插件 / 自动化任务」之后）
#    点它 → 主区打开面板；也可以直接访问上面的 URL
#    右栏「轮转」标签在 0.2.1-rc.3 实测没有渲染出来（见 README「入口结论」），
#    以 URL 为准；client 半是否激活可看 document.documentElement.dataset.dshRotation

# 4) 注册第一个真实项目（把路径换成你自己的项目）
curl -s -X POST http://127.0.0.1:<端口>/rotation/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"词块","workspace":"/Users/julian/agentic/projects/chunks"}'

# 5) 面板里应出现该项目；改一个节点标题 → 刷新 → 改动仍在
cat ~/agentic/projects/chunks/.dsh/rotation.json | head -20
```

## 四、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `/rotation/api/health` 404 | 插件没挂上：确认 profile 的 `dsh.profile.bundles` 里有 `dsh-looptree-dashboard`，或市场里已启用；重启 DSH |
| 改了代码没生效（面板没变） | 面板改动要刷新页面；`web/index.html` 每次请求读盘，但浏览器可能缓存 HTML，硬刷新一次 |
| 改了 `lib/` 没生效 | host 半在进程内存里，必须重启 DSH；health 的 `version` 也会跟着变 |
| 406/502 / 路由冲突 | 有别的插件也注册了 `/rotation` 前缀；在 `cordis.patch.yml` 里改 `config.basePath` |
| 打开面板是空白且控制台有 404 | 面板静态资源缺失：确认 `package.json` 的 `files` 里有 `web`（`npm run preflight` 会验） |
| 发起会话 503「会话服务不可用」 | DSH 版本缺少 `ctx.agents`；确认 `dsh --version` 与 `package.json` 的 `engines.dsh` 匹配 |
| 一键拉起无反应 | 服务的 `cwd` 不存在或缺 `start` 命令；看卡片 `services` 配置 |
| 发起会话失败：`Authentication Fails … invalid` | 宿主默认 provider 的 key 无效。要么在 GUI 里换可用凭据，要么注册项目时用 `provider`/`model` 把它钉到网关路由 |
| 会话失败：`cannot get property "agents" without inject` | 插件版本过旧（< 0.2.0），升级插件（见 §一） |

## 五、真机联调（不进你的日常 profile）

`scripts/real-plugin-check.sh` 会把 web profile 复制成一次性的 `rotationtest`，把**本仓库目录**
以 link 方式装进去，起在 64600 端口——在真实 DSH 进程里验证，不碰日常 profile：

```bash
./scripts/real-plugin-check.sh install   # 复制 profile + link 本仓库（约 400MB 副本）
./scripts/real-plugin-check.sh boot      # 起在 :64600，打印带 token 的 URL
./scripts/real-plugin-check.sh probe     # health / app / cards 三个 200
./scripts/real-plugin-check.sh stop
./scripts/real-plugin-check.sh clean     # 删掉一次性 profile
```

## 让会话真正跑起来：provider 指向网关

DSH 默认的 `deepseek-official` 直连厂商（本机铁律要求走网关）。在 profile 的 patch 层改 baseURL 即可：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml（先备份）
- id: llm-deepseek
  config:
    baseURL: http://llm.riverbegin.cn/v1
```

改完重启 DSH；然后从卡片发起会话，成功时卡片上 `session.result` 会有模型回复。
验证过的最小流程：`POST /rotation/api/run`（prompt「只回复 OK」）→ 约 5 秒 → `status: done, result: "OK"`。

不想改全局 provider，也可以给单个项目钉路由：
`POST /rotation/api/projects {"name":"x","workspace":"/w","provider":"<provider>","model":"<model>"}`。

## 六、回滚

```bash
# link 安装：从 profile 摘掉软链与登记
rm ~/.dsh/profiles/<profile>/node_modules/dsh-looptree-dashboard
# 再从 profile 的 package.json 里删掉依赖条目与 bundles 里的包名，重启 DSH
```

数据不受影响：卡片都在各项目 `.dsh/rotation.json`，注册表在 `~/.dsh/rotation/registry.json`。
