# 安装与验证

插件包：`dsh-rotation-dashboard@0.1.0`（`npm pack` 产物：`dsh-rotation-dashboard-0.1.0.tgz`，约 62 KB）。

## 一、安装（二选一）

### A. 市场 UI 本地安装（推荐，符合本机规矩）

1. 打开 DSH 桌面端 → 市场 / 插件页 → 找「本地安装 / 从文件安装」。
2. 选本目录下的 `dsh-rotation-dashboard-0.1.0.tgz`。
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
dsh plugin --profile web add ./dsh-rotation-dashboard-0.1.0.tgz
```

## 二、验证清单（按顺序做，任一步失败就停）

```bash
# 1) 插件是否挂上（端口以你实际 DSH Web 端口为准）
curl -s http://127.0.0.1:64517/rotation/api/health
#    期望：{"ok":true,"name":"dsh-rotation-dashboard","version":"0.1.0",...}

# 2) 面板是否可打开
open http://127.0.0.1:64517/rotation/app/

# 3) 右栏是否出现「轮转」入口（client 半）
#    打开任意会话的右栏，应看到一个含「打开面板」按钮的标签页

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

## 四、回滚

```bash
dsh plugin --profile web remove dsh-rotation-dashboard
```

数据不受影响：卡片都在各项目 `.dsh/rotation.json`，注册表在 `~/.dsh/rotation/registry.json`。
