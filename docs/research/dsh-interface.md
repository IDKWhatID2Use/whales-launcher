# dsh 接口勘察结论

> 勘察对象：本机安装的 `@deepseek-ai/dsh@0.1.6-alpha.2`
> 位置：`F:\NodeJS\node_global\node_modules\@deepseek-ai\dsh\`
> 方法：读取已构建产物 `lib/*.js`、各子包 `README.zh.md`、以及 `C:\Users\user\.dsh` 的真实数据目录
> **本文所有"已确认"条目均来自源码或真实目录，非推测。**

---

## 0. 结论摘要（决定架构的 5 条）

1. **`$DSH_HOME` 是唯一的实例隔离开关**：`resolveDshHome()` 的优先级为「显式参数 > `$DSH_HOME` 环境变量 > `~/.dsh`」。给子进程注入不同的 `DSH_HOME`，即可获得完全独立的 profile、设置、会话、缓存与凭证。这是本项目的地基。
2. **profile = 游戏实例的最小单元**：`$DSH_HOME/profiles/<name>/`，由 `package.json`（含 `dsh.profile.bundles` 有序列表）+ `cordis.patch.yml`（用户覆盖层）构成。
3. **启动器不得 import dsh 内部 API**：多版本共存下各实例的 dsh 版本不同，内部 API 会漂移。**稳定边界只有两条：`dsh` CLI 与文件系统约定**。
4. **存在一个非交互原语可用于创建/校验实例**：`dsh --profile <name> --from-default-profile <tpl> --dump-config` 会初始化 profile 并输出组合配置后退出，**不启动应用、不调用模型**。
5. **凭证与设置位于 home 级**：`.credentials.yaml`、`settings.yaml` 都在 `$DSH_HOME` 根下。实例隔离后必须显式处理凭证继承，否则每个实例都要重新登录。

---

## 1. CLI 接口（已确认）

来源：`lib/bin.js`（`parseDshArgs`）、`dsh --help` 实测输出。

| 命令 | 语义 |
|---|---|
| `dsh <name>` / `dsh --profile <name>` | 启动 `$DSH_HOME/profiles/<name>` |
| `dsh --profile <n> --from-default-profile <tpl>` | 从随附模板创建新 profile，然后启动 |
| `dsh web` | 启动 Web profile（实测默认 `http://127.0.0.1:3080`） |
| `dsh headless "job"` | 跑一个全新持久化会话，打印最终答案后退出 |
| `dsh --profile sdk` / `sdk-minimal` | JSON-RPC stdio 服务 |
| `dsh --profile acp` | ACP stdio 服务 |
| `dsh plugin --profile <n> <pnpm args>` | 在 profile 目录内转发 pnpm；**首次使用会初始化一个以 base 为基础的 profile** |
| `dsh --dump-config` | 打印组合后的配置树后退出（**不启动**） |
| `dsh --dump-default-config` | 打印不含用户层与 `--patch` 的组合树 |

关键解析规则（`bin.js` 实测）：

- **启动器只解析自己的 flag；第一个无法识别的 token 起，全部原样交给被启动的应用**。例如 `dsh web --port 8080` 中 `--port` 属于 web app。
- `dsh <name>` 是 `dsh --profile <name>` 的展开（`first !== undefined && !first.startsWith("-") && first !== "plugin"` 时前置 `--profile`）。
- `--patch <path>` 可重复，**不是变参**（变参会吞掉内层参数）。
- `--dump-config` 与 `--dump-default-config` 互斥；dump 模式不接受 app 参数；`--dump-default-config` 不接受 `--patch`。
- **profile 名 `desktop` 被保留给 Electron 宿主，CLI 直接拒绝**（启动、dump、插件管理均拒绝）。
- 启动失败抛 `StartupError` 时，会把完整诊断写到 `$DSH_HOME/logs/startup-<ISO时间戳>-<uuid>.log`（`mode 0o600`），stderr 只输出简短消息，**退出码 1**。

---

## 2. `$DSH_HOME` 解析（已确认）

来源：`@deepseek-ai/dsh-home-paths/lib/index.js`。

```js
resolveDshHome(configured, env = process.env)
// 优先级：configured > env.DSH_HOME > ~/.dsh
```

- **空字符串或纯空白的 `$DSH_HOME` 视为未设置**（`fromEnv.trim().length > 0`），因此空白覆盖**永远不会**把 home 解析到当前工作目录。
- 展开 `~`、`~/`、`~\` 前缀。
- 结果经 `resolve()` 归一化为绝对路径。
- `dshHomeDisplay()` 只返回 `~/.dsh` 或 `$DSH_HOME` 这样的符号形式，**不暴露机器绝对路径**（启动器 UI 若要显示路径须自行处理）。

---

## 3. profile 结构与初始化（已确认，源码级）

来源：`@deepseek-ai/dsh-app-boot/lib/index.js` 的 `initProfile()` / `PROFILE_TEMPLATES` / `resolveProfileDir()`。

### 3.1 目录布局

```
$DSH_HOME/profiles/<name>/
├── package.json          # name = "dsh-profile-<name>", private: true, dependencies + dsh.profile.bundles
├── cordis.patch.yml      # 用户 patch 层（YAML 数组）
├── cordis.yml            # 组合根，内容为 []，不直接编辑
├── pnpm-workspace.yaml   # packages: [.] / nodeLinker: hoisted / autoInstallPeers: false
├── pnpm-lock.yaml        # pnpm 生成
├── node_modules/         # pnpm 安装的树外插件
├── .plugin-manager/      # 插件管理器日志（logs/）
└── .dsh-market/          # 市场插件数据
```

`initProfile(dir, bundles)` 的**精确行为**（幂等，已存在文件绝不覆盖）：

1. `mkdir -p dir`
2. `package.json`（仅当不存在）：
   ```json
   { "name": "dsh-profile-<basename>", "private": true, "dependencies": {}, "dsh": { "profile": { "bundles": [...bundles] } } }
   ```
3. `cordis.patch.yml`（仅当不存在）= 一段说明注释 + `[]` + 换行
4. `pnpm-workspace.yaml`（仅当不存在）= `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`

> **空的或仅含注释的 `cordis.patch.yml` 会导致启动失败**，必须写成 `[]`。

### 3.2 profile 名校验（必须复用）

`resolveProfileDir(name)` 在以下情况抛错：名称为空、包含 `/`、包含 `\`、等于 `.`、等于 `..`、等于 `node_modules`。
→ 启动器的实例命名必须做同样的校验，否则会在启动时才失败。

### 3.3 随附模板（`PROFILE_TEMPLATES`）

| 模板名 | bundles |
|---|---|
| `web` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` |
| `headless` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless` |
| `sdk` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-sdk-app` |
| `sdk-minimal` | `@deepseek-ai/dsh-sdk-minimal` |
| `acp` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-acp-app` |
| 其他任意名字（经 `dsh plugin` 初始化） | `@deepseek-ai/dsh-base` |

可选组合包（随安装提供、默认关闭、用户可开、**永不卸载**）：`@deepseek-ai/dsh-experimental-agent-team-profile`、`@deepseek-ai/dsh-experimental-agent-team-web-profile`。

> 实测本机 `web` profile 已启用这两个可选组合包（见其 `dsh.profile.bundles`）。

### 3.4 模块解析：双锚点

- bundle 名**先从 dsh 安装目录解析**，再从 profile 目录解析。
- profile 的 `node_modules` 中由 pnpm 管理的条目**优先**解析。
- `$DSH_HOME/profiles/node_modules` 通过 Node 的常规父级向上查找，提供**安装依赖闭包**；普通 Node 用**符号链接**实现这个共享 fallback（打包可执行文件用 ESM proxy）。
- **每个 DSH_HOME 都需要自己的 `profiles/node_modules`**，指向该 home 所用 dsh 版本的依赖闭包。实例隔离后这一点必须逐个满足。

### 3.5 `sanitizeProfile(binName, profileDir, bundles)`

文件级恢复助手：把 `cordis.patch.yml` 重命名为 `cordis.patch.yml.bak-<Unix毫秒>`（重名追加 `-1`、`-2`…）并重建 bundles 列表，**不加载插件、不解析 patch**。调用前必须先停止 profile 并排除并发写入。→ 启动器可将其作为"修复实例"的兜底，通过 CLI 触发而非直接调用。

---

## 4. 配置层组合顺序（已确认）

以**空根**为起点，依次叠加（后者覆盖前者）：

1. `dsh.profile.bundles` 中各组合包的 patch（按列表顺序）
2. profile 自身的 `cordis.patch.yml`
3. home 级 `$DSH_HOME/cordis.patch.yml`
4. `--patch <path>` 指定的覆盖层（可重复，按顺序）

语义要点：

- **patch 条目替换目标的整个 `config`，不做合并**。写覆盖必须重述所有想保留的字段。
- 按 `id` 定位；某条目最后一次写入生效。
- `disabled: true` 可禁用某条；`insert:` 可插入新条目；允许 `!!js` 表达式。
- patch 指定的条目不存在时输出 **stderr 警告**（非致命）。
- 插件开关只改 `cordis.patch.yml` 中**最后一条匹配覆盖项**的 `disabled`；无匹配项时追加。组合包开关则改 `package.json` 的 `dsh.profile.bundles`。

---

## 5. 会话与 workspace（已确认）

来源：`$DSH_HOME/sessions/` 真实目录 + `dsh-session` 相关包。

```
$DSH_HOME/sessions/<编码后的 workspace 路径>/<session-id>/
```

- 实测本机存在目录：`--F-WhalesLauncher--`、`--C-Users-user-.dsh--`、`--F-ComFYUI--`、`--C-Users-user-.dsh-APIHunter--`。
- **编码规则**：`F:\WhalesLauncher` → `--F-WhalesLauncher--`，即盘符与路径分隔符统一替换为 `-`，两端各加 `--`。（启动器实现时须从真实数据反推校验，不能假定。）
- **workspace 根 = 启动 dsh 时进程的当前工作目录**（README 明确："运行命令时所在的目录将作为默认 workspace 根目录"）。
- `$DSH_HOME/storages/workspace.json` 记录 workspace 列表。

→ **"存档"映射**：会话（`sessions/`）× 工作文件夹（workspace cwd）共同构成 PCL2 的"存档"。两者都可共享或隔离。

---

## 6. 设置与凭证（已确认）

- **`$DSH_HOME/settings.yaml`**：home 级全局设置，按插件命名空间分组（如 `agent-default-model`、`agency-agents`、`skin-*`）。实测本机该文件含各插件的键值，**是单文件全局配置**，没有 profile 级 settings。
  → **实例隔离设置 = 每个实例一份 `settings.yaml`**。
- **`$DSH_HOME/.credentials.yaml`**：凭证，同样是 home 级。
  → 实例隔离后必须显式决定：继承主 home 的凭证（复制）、还是各自独立登录。
- 其他 home 级内容：`cache/`、`attachments/`、`stores/`、`logs/`、`change-ledger/`、`telemetry/`、`storages/`、`.agent-presets/`。

---

## 7. 插件管理（已确认）

- 稳定入口是 **`dsh plugin --profile <name> <pnpm args>`**，在 profile 目录内**转发 pnpm**（`add` / `remove` / `why` / …）。
- 内部服务 `@deepseek-ai/dsh-plugin-manager` 提供 `inspect` / `installBundle` / `cancelInstall` / `listBundles`，并与 `dsh plugin` **共享包操作与 profile 写锁**。
- 失败语义（对启动器的 UI 有直接指导意义）：
  - 安装失败 → 恢复 pnpm 运行前的 `package.json` 与 `pnpm-lock.yaml` 快照；已下载文件可能残留。
  - 卸载按序执行：从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove`；任一步失败即停止，不重新启用。
  - 诊断日志保留在 profile 的 `.plugin-manager/logs`。
- pnpm 11 拦截依赖脚本时，失败安装会在 `pendingBuilds` 报告待决定的包名；授权按包名保存在当前 profile。
- `pnpmCommand`（默认 `pnpm`）、`inspectTimeoutMs`（20000）、`outputBytes`（16384）、`lockWaitMs`（120000）可配。

---

## 8. 对启动器的设计含义（本项目的架构结论）

| # | 结论 |
|---|---|
| D1 | **实例 = 一个独立 `DSH_HOME`**。启动实例即：以 `DSH_HOME=<实例>/home`、`cwd=<实例工作区>` spawn dsh 进程。 |
| D2 | **版本 = `<版本目录>/node_modules/@deepseek-ai/dsh`**。启动时用该路径下的 `lib/bin.js`，实现"每个实例独享版本"。 |
| D3 | **创建实例的黄金路径** = `dsh --profile <名> --from-default-profile <模板> --dump-config`，非交互、不启动、不调模型，且顺带完成 profile 初始化与配置校验。 |
| D4 | **插件操作一律走 `dsh plugin --profile <名> …`**，不自己改 `package.json` 之外的 pnpm 状态，避免与 dsh 的写锁冲突。 |
| D5 | **设置隔离靠每实例一份 `settings.yaml`**；凭证需显式继承策略（复制主 home 的 `.credentials.yaml`）。 |
| D6 | **"存档互通" = 共享 `sessions/` 与/或共享工作目录**。Windows 上用 junction（`fs.symlink(target, path, 'junction')`，无需管理员权限）实现目录级共享。 |
| D7 | **实例名必须复用 dsh 的 profile 名校验规则**（非空、无 `/`、`\`、非 `.`/`..`/`node_modules`），且**不得使用 `desktop`**。 |
| D8 | 组合配置是"替换整个 config"而非合并 —— 启动器做设置 UI 时必须读出当前生效值再整块写回，不能只写增量字段。 |

---

## 9. 待确认项（不在无据假定之列）

| 项 | 状态 | 计划 |
|---|---|---|
| `--dump-config` 能否在全新 profile 上无副作用地完成初始化 | ✅ **已实测确认** | 见 §11 实测记录 |
| `profiles/node_modules` 共享 fallback 的建立时机 | **待实测** | 观察首次启动新实例后该链接是否自动生成 |
| workspace 目录名编码的确切算法（是否对 `:` 与 `\` 一律替换） | **部分确认** | 已从 4 个真实目录反推；实现时用真实路径再校验一次 |
| 会话目录内部文件格式（是否可安全跨实例复制） | **待确认** | 交付前抽检一个真实会话目录 |
| dsh 各历史版本间 profile 格式兼容性 | **待确认** | 版本管理页需标注风险；不承诺跨大版本降级 |

---

## 11. 实测记录（Lead 亲测，作为 §9 待确认项的关闭依据）

### 11.1 黄金路径：在全新 home 上初始化 profile（2026-09-19 实测）

命令（等价于启动器 `createInstance` 将要执行的调用）：

```powershell
$env:DSH_HOME = '<临时目录>/home'
node <dsh>/lib/bin.js --profile probe1 --from-default-profile web --dump-config
```

结果：**退出码 0，输出 568 行组合配置，且创建了完整 profile**：

```
<home>/profiles/probe1/
├── package.json          # name=dsh-profile-probe1, bundles=[dsh-base, dsh-web-app]
├── cordis.patch.yml      # 217 字节（模板注释 + []）
├── cordis.yml            # 组合根
└── pnpm-workspace.yaml   # packages:[.] / nodeLinker:hoisted / autoInstallPeers:false
```

**结论**：
1. 该命令可在**全新 home** 上完成 profile 初始化，**不启动应用、不调用模型、无交互**，是启动器创建实例的理想原语。✅
2. `dsh.profile.bundles` 与 `PROFILE_TEMPLATES.web` 完全一致，证实模板机制生效。
3. 组合配置输出以 `# == <bundle 名>` 分节注释标注每个来源层，可用于"配置来源可视化"功能。

### 11.2 未创建 `profiles/node_modules`

上述 dump 路径**没有**生成 `$DSH_HOME/profiles/node_modules`。该共享 fallback 目录预计在真正**启动** profile 时由 dsh 建立。启动器若要在启动前预置它，需自行按安装依赖闭包建立链接 —— 但**优先策略是让 dsh 自己管理**，启动器不越权。

### 11.3 Electron 与本机工具链（应用于交付物，非 dsh 本身）

- 本机 DNS 被本地代理劫持为 fake-ip（所有域名解析到 `198.18.0.0/15`），`web_fetch` 对全部域名失败；github.com 不可达。
- npm registry **可达**（经 npm 自身网络栈），但必须显式 `--cache <工作区内路径>`：环境变量 `npm_config_cache` 指向工作区外目录，优先级高于项目 `.npmrc`，会导致 EPERM。
- Electron 41.1.0 二进制由 `%LOCALAPPDATA%\electron\Cache` 中的发行包离线铺设，脚本见 `scripts/setup-electron.mjs`。


---

## 10. 证据来源

- 源码：`@deepseek-ai/dsh/lib/bin.js`、`lib/profile-boot.js`、`lib/plugin-DJ-rVHUS.js`
- 源码：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`
- 源码：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
- 文档：上述各包 `README.zh.md`、`dsh` 包 `README.zh.md`
- 真实数据：`C:\Users\user\.dsh\`（profiles/web、sessions/、settings.yaml、storages/）
- CLI 实测：`dsh --version` = `0.1.6-alpha.2`、`dsh --help`
