# 安装与验证

插件包：`dsh-rotation-dashboard@0.2.0`（`npm pack` 产物：`dsh-rotation-dashboard-0.5.3.tgz`，约 62 KB）。

## 一、安装（二选一）

### A. 市场 UI 本地安装（推荐，符合本机规矩）

1. 打开 DSH 桌面端 → 市场 / 插件页 → 找「本地安装 / 从文件安装」。
2. 选本目录下的 `dsh-rotation-dashboard-0.5.3.tgz`。
3. 重启 DSH（`dsh web` 或桌面端重启，让 profile 重新合并 patch）。

> 本机规矩：插件增删改默认只走市场 UI。用 CLI 前必须先核对
> `profiles/web/node_modules/.modules.yaml` 的 `storeDir` 与 `pnpm store path` **逐字一致**，
> 不一致就先对齐 pnpm 版本，否则会把 profile 的 store 记录写坏。

### B. CLI（仅在市场 UI 不可用时）

```bash
cd ~/.dsh/reports/rotation-panel
npm pack                                   # 生成 tgz
pnpm store path                            # 记下这个路径
grep storeDir ~/.dsh/profiles/web/node_modules/.modules.yaml   # 必须与上一行逐字一致
dsh plugin --profile web add ./dsh-rotation-dashboard-0.5.3.tgz
```

## 二、验证清单（按顺序做，任一步失败就停）

```bash
# 1) 插件是否挂上（端口以你实际 DSH Web 端口为准）
curl -s http://127.0.0.1:64517/rotation/api/health
#    期望：{"ok":true,"name":"dsh-rotation-dashboard","version":"0.2.0",...}

# 2) 面板是否可打开
open http://127.0.0.1:64517/rotation/app/

# 3) 入口：左栏应出现「闭环轮转」（在「插件 / 自动化任务」之后）
#    点它 → 主区打开面板；也可以直接访问：
open http://127.0.0.1:64517/rotation/app/
#    右栏「轮转」标签在 0.2.1-rc.3 实测没有渲染出来（见 README「入口结论」），
#    以 URL 为准；client 半是否激活可看 document.documentElement.dataset.dshRotation

# 4) 注册第一个真实项目（把路径换成你自己的项目）
curl -s -X POST http://127.0.0.1:64517/rotation/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"词块","workspace":"/Users/julian/agentic/projects/chunks"}'

# 5) 面板里应出现该项目；改一个节点标题 → 刷新 → 改动仍在
cat ~/agentic/projects/chunks/.dsh/rotation.json | head -20
```

## 三、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `/rotation/api/health` 404 | 插件没挂上：确认 profile 的 `dsh.profile.bundles` 里有 `dsh-rotation-dashboard`，或市场里已启用；重启 DSH |
| 406/502 / 路由冲突 | 有别的插件也注册了 `/rotation` 前缀；在 `cordis.patch.yml` 里改 `config.basePath` |
| 打开面板是空白且控制台有 404 | 面板静态资源没打进包：确认 `npm pack` 列表里有 `web/index.html` |
| 发起会话 503「会话服务不可用」 | DSH 版本缺少 `ctx.agents`；确认 `dsh --version` 与 `package.json` 的 `engines.dsh` 匹配 |
| 一键拉起无反应 | 服务的 `cwd` 不存在或缺 `start` 命令；看卡片 `services` 配置 |
| 发起会话失败：`Authentication Fails … invalid` | 宿主默认 provider 的 key 无效。要么在 GUI 里换可用凭据，要么注册项目时用 `provider`/`model` 把它钉到网关路由 |
| 会话失败：`cannot get property "agents" without inject` | 插件版本过旧（< 0.2.0），升级插件（见「升级插件」） |

## 四、真机联调（不进你的日常 profile）

`scripts/real-plugin-check.sh` 会复制一份 web profile 成一次性的 `rotationtest`，把 tgz 装进去、
起在 64600 端口，用来在**真实 DSH 进程**里验证插件（不碰你在用的 web profile）：

```bash
./scripts/real-plugin-check.sh install   # 复制 profile + 安装插件（约 400MB 副本）
./scripts/real-plugin-check.sh boot      # 起在 :64600，打印带 token 的 URL
./scripts/real-plugin-check.sh probe     # health / app / cards 三个 200
./scripts/real-plugin-check.sh stop
./scripts/real-plugin-check.sh clean     # 删掉一次性 profile
```

已用这套验证过：host 半挂载 200、client 半进 boot 清单（`plugins/??dsh-rotation-dashboard/client.js`）、
中文项目名注册、卡片改标题落盘。

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

## 五、升级插件（重要）

用 `file:` 方式装的同版本 tgz，**pnpm 会复用旧包**：直接 `add` 不会更新文件。升级必须：

```bash
dsh plugin --profile <name> remove dsh-rotation-dashboard
dsh plugin --profile <name> add ./dsh-rotation-dashboard-0.5.3.tgz
```

## 六、回滚

```bash
dsh plugin --profile web remove dsh-rotation-dashboard
```

数据不受影响：卡片都在各项目 `.dsh/rotation.json`，注册表在 `~/.dsh/rotation/registry.json`。
