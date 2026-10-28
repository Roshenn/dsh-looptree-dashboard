# 开发环境（本地 / 远程）与 SOP

面向：换机器（含 Windows）继续开发这个插件，以及后续发布。
先看结论，再看清单；所有命令都在仓库根目录执行。

---

## 1. 当前这套东西分三层

| 层 | 是什么 | 在哪 |
|---|---|---|
| **插件源码（唯一真源）** | 一个 npm 包目录：`package.json` + `lib/`（host 半）+ `web/`（面板）+ `cordis.patch.yml` | 本机 `~/.dsh/reports/rotation-panel`（macOS） |
| **远程仓库** | Git 远端，代码唯一备份 | `git@gitee.com:jrri/dsh-looptree-dashboard.git`（分支 `main`） |
| **运行环境** | DSH 桌面端 / dsh web 进程 + 它所在 profile 的 `node_modules` | 桌面端用 `~/.dsh/profiles/desktop`，测试用一次性 profile |

关键事实：

- 插件**不需要构建**：没有打包步骤，`web/` 是原生 HTML/JS，改了就是改了。
- 装进 profile 的方式决定「改动是否实时生效」：
  - `link:`（本地目录）→ 直接指到源码目录，**改完重启 DSH 即生效**，不用重装；
  - `file:`（.tgz）→ 是拷贝，改完必须 `remove` + `add` 重装。
- 当前桌面端装的是 `link:`：`~/.dsh/profiles/desktop/package.json` →
  `"dsh-looptree-dashboard": "link:/Users/julian/.dsh/reports/rotation-panel"`。

---

## 2. 换到 Windows 开发机：SOP

### 2.1 前置

1. 装 **DSH Desktop for Windows**（插件只能装进它的 profile）。
2. 装 **Git for Windows**（提供 Git Bash 与 `git`），并配好访问 Gitee 的 SSH key 或 HTTPS 凭据。
3. （可选）装 `zstd`：`winget install zstd`。只影响「查看历史会话全文」这个功能，
   面板其它功能不需要。
4. **不要**自己装 pnpm 往 profile 里装插件——profile 的依赖必须由 DSH 自己（内置 pnpm）写。

### 2.2 拉代码

```powershell
mkdir C:\dev
cd C:\dev
git clone git@gitee.com:jrri/dsh-looptree-dashboard.git rotation-panel
cd rotation-panel
node -v      # 需要 >= 20（package.json engines 已声明）
```

### 2.3 把插件装进 profile（桌面端市场 UI）

1. 打开 DSH Desktop → 插件市场 → 添加插件。
2. 输入**本地目录绝对路径**：`C:\dev\rotation-panel`
   （市场只接受「包名 / GitHub 地址 / 本地目录」；`.tgz` 文件路径会被拒）。
3. 装完后确认是 link 形态：

```powershell
type $env:USERPROFILE\.dsh\profiles\desktop\package.json
# 期望看到 "dsh-looptree-dashboard": "link:C:\\dev\\rotation-panel"
dir $env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-looptree-dashboard
# 期望是目录联接/符号链接指回源码
```

4. 重启 DSH，左栏应出现「闭环树」。

### 2.4 日常开发回路

```
改 lib/*.mjs / lib/*.js   → 重启 DSH（host 模块在启动时加载）
改 web/index.html、web/*  → 只刷新面板（切走再切回「闭环树」）
改 lib/client.js          → 重启 DSH（client bundle 启动时加载）
```

改完跑自检（跨平台，Windows 直接可用）：

```powershell
npm run check        # 对正在跑的 DSH 做冒烟（要 DSH_URL）
npm run preflight    # 离线全量自检：lint / 客户端契约 / 会话 mock / 样例 / 打包内容
```

`npm run check` 需要当前 DSH 端口：

```powershell
$env:DSH_URL="http://127.0.0.1:54373"; npm run check
```

### 2.5 一次性验证实例（不碰你的日常 profile）

macOS 上是 `cp -R profiles/web profiles/rotationtest`；Windows 上等价：

```powershell
# 1) 复制一份 profile（体积约 400MB，用完删）
robocopy $env:USERPROFILE\.dsh\profiles\desktop $env:USERPROFILE\.dsh\profiles\rotationtest /E

# 2) 用 CLI 装/卸插件（这一步只在一次性 profile 上做）
dsh plugin --profile rotationtest add C:\dev\rotation-panel
dsh --profile rotationtest --port 64600 --no-open
# 3) 验证后清理
Remove-Item -Recurse -Force $env:USERPROFILE\.dsh\profiles\rotationtest
```

---

## 3. 平台差异清单（Windows 上会踩到的点）

| 点 | macOS 现状 | Windows 处理 |
|---|---|---|
| 目录选择器端点 `POST /api/pick-directory` | 用 `osascript` 弹原生框 | 非 macOS 返回 501；面板里已不再使用它（改成从 DSH 工作区下拉选） |
| 会话全文解压 `session.v4.jsonl.zstd` | 多帧写入，靠 `zstd -dc` 兜底 | 需要本机有 `zstd`；没有会返回带安装提示的错误 |
| `npm run validate:samples` | 曾是 bash `for` 循环 | 已换成 `scripts/validate-samples.mjs`（纯 node） |
| `npm run preflight` | 曾是 bash `$(mktemp -d)` + `$RANDOM` | 已换成 `scripts/preflight.mjs`（纯 node + 临时目录 + 随机端口） |
| `scripts/real-plugin-check.sh` | bash | Windows 用 Git Bash 跑，或照 §2.5 手工执行 |
| 路径分隔符 | `/` | host 侧一律用 `node:path` 拼接；面板里只用 `/` 拼 URL，不拼文件路径 |
| `~` 展开 | shell 展开 | 文档/脚本里不要用 `~`，写绝对路径 |

---

## 4. 从零重建开发环境（任一平台）

```bash
# 1) 拿代码
git clone git@gitee.com:jrri/dsh-looptree-dashboard.git && cd rotation-panel

# 2) 自检（不需要 DSH 在跑）
npm run preflight

# 3) 装进日常 profile：桌面端市场 UI 里填仓库绝对路径（别用 CLI，见 §5）

# 4) 冒烟（DSH 在跑时）
DSH_URL=http://127.0.0.1:<端口> npm run check
```

产物与文档：`docs/architecture.md`（结构）、`docs/dev-setup.md`（本文）、
`INSTALL.md`（用户安装）、`CHANGELOG.md`（版本记录）、`samples/`（示例卡片）。

---

## 5. 不要做的事（血泪）

1. **不要**在 profile 目录里手工 `pnpm add / npm install`：桌面端与终端用的是两份不同 pnpm，
   `node_modules/.modules.yaml` 会被互相覆盖，之后两边都报 `ERR_PNPM_UNEXPECTED_STORE`。
2. **不要**用 `.tgz` 路径去市场里装（会被判为不合法地址）；要目录，或远程仓库，或包名。
3. 同版本 `file:` 包重装是空操作（pnpm 缓存）：升级必须 `remove` → `add`。
4. 提交前 `npm run preflight` 必须绿；host/client 的加载契约坏了是「整个 web 起不来」级别的故障。

---

## 6. 发布流程（当你要把它给别人用）

### 6.1 每次发版（必做）

```bash
# 1) 版本号 + 变更记录（语义化：修 bug 补丁位，加字段/交互次版本位）
npm version patch --no-git-tag-version      # 或 minor
$EDITOR CHANGELOG.md                        # 写清「新增/修复/影响面」

# 2) 全量自检
npm run preflight

# 3) 打产物（包内只含 lib/ web/ cordis.patch.yml）
npm pack                                    # → dsh-looptree-dashboard-x.y.z.tgz

# 4) 提交与推送
git add -A && git commit -m "release: vX.Y.Z" && git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

### 6.2 三种分发方式

| 方式 | 对方怎么装 | 前提 |
|---|---|---|
| **本地目录** | 市场里填目录绝对路径 | 对方能拿到源码目录（团队内最省事） |
| **Git 仓库** | 市场里填仓库地址 | 仓库公开可访问（GitHub 最稳；私有 Gitee 需要凭据） |
| **npm 包** | 市场里填包名 | `npm publish` 到对方能访问的 registry（默认官方源，或指定国内镜像） |

### 6.3 发布前检查清单

- [ ] `package.json`：`version` / `dsh.bundle.patch` / `dsh.client` / `dsh.engines.dsh` 四样齐全且版本匹配
- [ ] `cordis.patch.yml` 里的 `id` 与包名一致（不一致 → 整个 web 起不来）
- [ ] `lib/client.js` 的 `__ModuleLoader__.load({ id })` 等于 package name，`exports.inject` 含 `slots`
- [ ] host `inject` 声明齐全（`webServer` / `agents` / `agentDefaultModel` / `workspaceRegistry`）
- [ ] `npm run preflight` 绿；`npm pack` 内容里没有 `.git`、`node_modules`、`.tgz`
- [ ] `CHANGELOG.md` 有本次条目，`INSTALL.md` 里的版本号与文件名已同步
