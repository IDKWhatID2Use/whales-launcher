# WhalesLauncher 总体设计方案

> 版本：v1（Lead 冻结）｜**技术栈（已更新）**：WinUI 3 (C#/XAML) + Windows App SDK + .NET 10 前端，
> Node.js 侧车承载 `src/core` 业务引擎｜目标平台：Windows x64
> 依据：`docs/research/dsh-interface.md`（dsh 实测）、`docs/research/pcl2-research.md`（PCL2 调研）
>
> ⚠ **本文档诞生于 Electron 前端时代**。§3 分层架构已按 WinUI 3 重构更新；其余章节中
> 凡提到「Electron / renderer / preload / main / esbuild 打包前端 / `npm run launch`」的地方
> 属历史记录，**不再反映当前实现**。当前实现请看
> [WinUI 3 交付报告](../winui3-重构交付报告.md) 与 [视觉规范](winui3-visual-spec.md)。
> 旧前端源码可用 `git show ed93af9^:<路径>` 取回。

---

## 1. 目标与概念映射

做一个"逻辑类似 PCL2"的启动器，管理 **dsh 实例** 与 **dsh 版本**。

| PCL2 概念 | 本项目映射 | 承载物 |
|---|---|---|
| 游戏实例 | **dsh 实例** | 一个独立 `DSH_HOME` + 一份实例元数据 |
| 版本（MC + 加载器） | **dsh 引擎版本** | `<版本目录>/node_modules/@deepseek-ai/dsh` |
| mod | **dsh 插件** | profile 的 `dependencies` + `dsh.profile.bundles` |
| 组合包（bundle） | **dsh 组合包** | `dsh.profile.bundles` 有序列表 |
| 模组开关 | **插件启用/禁用** | `cordis.patch.yml` 的 `disabled` |
| 设置 | **实例设置** | 每实例一份 `settings.yaml` |
| 存档 | **会话 + 工作文件夹** | `sessions/` × workspace 目录 |
| 版本隔离 | **隔离开关** | 会话/设置/工作区各自可独立或共享 |
| 整合包 | **实例包** | 可导入导出的 zip |

**PCL2 的三条核心特性 → 本项目必须满足**

1. **每个实例独享版本、插件列表与设置** → 每实例独立 `DSH_HOME` + 绑定单一引擎版本。
2. **存档可互通** → `sessions/` 与工作区可通过 junction 链接到共享库，实例间互通。
3. **实例之间互相运行不干扰** → 独立 home、独立端口、独立进程、独立工作目录。

---

## 2. 目录布局

启动器根目录（`F:\WhalesLauncher`）：

```
WhalesLauncher/
├── package.json
├── instances/                  # 实例区（= PCL2 的 .minecraft/versions）
│   └── <实例名>/
│       ├── instance.json       # 启动器元数据（唯一事实源）
│       ├── home/               # ← 该实例专属 DSH_HOME
│       │   ├── profiles/<profile>/
│       │   ├── settings.yaml
│       │   ├── .credentials.yaml
│       │   └── sessions/
│       ├── workspace/          # 默认工作文件夹
│       └── logs/               # 启动日志
├── engines/                    # 引擎版本区
│   └── <dsh版本>/node_modules/@deepseek-ai/dsh/
├── shared/                     # 共享资源区（存档互通）
│   ├── sessions/               # 共享会话库
│   └── workspaces/             # 共享工作区
├── cache/                      # 下载缓存（npm cache 等）
├── launcher.json               # 启动器全局设置
└── docs/
```

**设计原则**：实例目录自包含（`instance.json` + `home/` + `workspace/`），删除目录即彻底删除实例；共享资源通过**链接**而非复制接入，符合 PCL2「实例=自包含目录 + 指针到共享资源」的思路。

---

## 3. 分层架构

> ⚠ **本节已按 WinUI 3 重构更新（2026-09）**。旧图把 `renderer/` `preload/` `main/` 三层画成
> Electron 结构，那三层已在 commit `ed93af9` **物理删除**；下面是替换后的真实分层。
> 第 4 节以下（数据模型、核心流程）仍然有效，因为 `core/` 与契约都没有变。

```
┌─────────────────────────────────────────────────────┐
│ desktop/src/WhalesLauncher.App/                     │
│   Views/    8 个页面（实例列表 · 详情4标签 · 引擎 ·   │
│             创建向导 · 全局设置）                    │
│   Shell/    外壳（标题栏 · 左实例栏 · 日志抽屉 · 菜单）│
│   Controls/ PageHeader · ToastHost                  │
│   Services/ CoreBridge · AppState · 导航 · 格式化     │
│   Models/   契约镜像（机械对应 contracts.ts）         │
│   技术：WinUI 3 (C#/XAML) + Windows App SDK + .NET 10 │
└──────────────────────┬──────────────────────────────┘
                       │ NDJSON over stdio（JSON-RPC v1）
                       │ id 命名空间 c*/n*，双向 RPC
┌──────────────────────┴──────────────────────────────┐
│ desktop/bridge/   Node 侧车进程                      │
│  server.mjs（入口） validate.mjs（参数校验）          │
│  host.mjs（反向请求 C# 宿主方法）                     │
│  events.mjs（log:chunk / log:state 推送）            │
└──────────────────────┬──────────────────────────────┘
┌──────────────────────┴──────────────────────────────┐
│ src/core/   纯 Node/TS 引擎（无任何 UI 依赖）         │
│  paths · instance · engine · profile · plugins      │
│  launch · saves · modpack · fsx · node-runtime      │
└──────────────────────┬──────────────────────────────┘
                       │ 仅两条稳定边界
        ┌──────────────┴──────────────┐
        │  dsh CLI（子进程）            │
        │  文件系统（dsh 约定）          │
        └─────────────────────────────┘
```

**关键架构决策**

| 决策 | 理由 |
|---|---|
| core 不依赖任何 UI 框架 | 可脱离 GUI 单测；可复用为 CLI；本次前端整体替换时 core **一行未改**即是证明 |
| **不 import dsh 内部 API**，只走 CLI + 文件系统 | 多版本共存下内部 API 会漂移（见 dsh 勘察 D3） |
| **dsh 必须由独立的 Node.js 执行** | dsh 的原生模块 `node-addon-require-builtin` 按**运行时指纹白名单**匹配，用非官方 Node 运行时（例如 Electron 内置 Node）实测被拒（`Unsupported/no-context`）→ 实例启动必然失败。core 的 `node-runtime.ts` 负责探测 + 探针校验 + 缓存，失败时给出中文诊断 |
| 前端用 **WinUI 3 原生控件 + 内置 ThemeResource 令牌**，不自建设计系统 | 配色/字号/圆角全部来自官方，天然获得系统主题、高对比度与无障碍支持；避免"自绘一套 Fluent"必然带来的漂移 |
| 前端与 core 之间用 **NDJSON 子进程桥接**，不用原生互操作 | core 是 TypeScript（约 7 000 行），用 Node 侧车承载可**零改写**复用；协议有 `__handshake` 运行时对账，能机械发现两端漂移 |
| 契约走 `src/shared/contracts.ts` 单一事实源 | 桥接方法名 = `CH` 常量字面值；C# 侧 `Models/` 是它的机械镜像，通道数量在握手时断言 |

---

## 4. 数据模型

### 4.1 `instances/<名>/instance.json`

```jsonc
{
  "schemaVersion": 1,
  "id": "uuid-v4",                 // 稳定标识，重命名不丢
  "name": "我的实例",               // 显示名（可与目录名不同）
  "dirName": "我的实例",            // 目录名 = profile 名，须过 dsh 校验
  "icon": "emoji-or-null",
  "color": "#5B8DEF",
  "note": "备注",
  "engine": { "version": "0.1.6-alpha.2" },   // 绑定的 dsh 版本
  "profile": { "name": "main", "template": "web" },
  "workspace": { "mode": "local" },           // local | shared
  "saves": { "mode": "local" },               // local | shared
  "settings": { "mode": "local" },            // local | shared | inherit
  "credentials": { "mode": "inherit" },       // inherit | local
  "launch": {
    "appArgs": [],                            // 追加给 dsh 应用层的参数
    "autoOpenBrowser": true                   // web profile 启动后自动开窗
  },
  "createdAt": "ISO", "lastLaunchedAt": "ISO", "launchCount": 0
}
```

### 4.2 `launcher.json`

```jsonc
{
  "schemaVersion": 1,
  "primaryHome": "C:\\Users\\<user>\\.dsh",  // 用于凭证继承的"主 home"
  "theme": "dark",
  "lastInstanceId": null,
  "confirmOnDelete": true,
  "engineRegistry": "https://registry.npmjs.org",
  "nodePath": null                          // 运行 dsh 的 node.exe；null = 自动探测
}
```

### 4.3 共享模式语义

| 字段 | `local` | `shared` / `inherit` |
|---|---|---|
| `workspace.mode` | 用 `instances/<名>/workspace` | junction → `shared/workspaces/<名>` |
| `saves.mode` | 用 `instances/<名>/home/sessions` | junction → `shared/sessions` |
| `settings.mode` | 用实例自己的 `home/settings.yaml` | junction → `shared/settings.yaml`（单文件链接） |
| `credentials.mode` | 实例自己的 `.credentials.yaml` | 启动前从 `primaryHome/.credentials.yaml` 同步 |

**链接实现**：`fs.symlink(target, link, 'junction')` —— Windows 上创建 junction **不需要管理员权限**，也不需要开发者模式。切换模式时须先解除旧链接（仅在确认是链接时，避免误删真实目录）。

---

## 5. 核心流程

### 5.1 创建实例

1. 校验实例名（**复用 dsh 规则**：非空、无 `/`、`\`、非 `.`/`..`/`node_modules`、**非 `desktop`**）
2. 建目录 `instances/<名>/{home,workspace,logs}`
3. 初始化 profile：**调用 `dsh --profile <p> --from-default-profile <tpl> --dump-config`**，`DSH_HOME=<实例>/home`
   → 非交互、不启动应用、不调用模型，且顺带完成配置校验
4. 写 `instance.json`
5. 按需建立共享链接、同步凭证

### 5.2 启动实例

```
spawn(
  <真正的 Node.js>,                       // 由 core/node-runtime.ts 探测并校验（绝不是 electron.exe）
  [<engines>/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js, "--profile", <p>, ...appArgs],
  { cwd: <workspace>, env: { DSH_HOME: <实例>/home, npm_config_cache: <root>/cache } }
)
```
- 为什么不能用 `process.execPath`：Electron 主进程里它是 `electron.exe`，其内置 Node 的
  V8 指纹不被 dsh 原生模块接受 → 启动失败（见 §3 关键架构决策）
- 运行时解析顺序：`$WHALES_NODE_PATH` → `launcher.json:nodePath` → 启动器自身进程（源码模式）
  → 系统 `PATH` → 常见安装位置；每个候选都跑一次 `node -e` 探针后才判定，失败原因进日志与 UI
- 捕获 stdout/stderr → 实时推送到 UI 日志面板；同时落 `instances/<名>/logs/<时间戳>.log`
- `web` profile：解析输出中的端口/URL，可选自动打开
- 退出码与 `StartupError` 摘要回传 UI；已知失败特征会被翻译成可操作提示
  （Electron 指纹、`EADDRINUSE` 端口占用、组合包加载失败）

### 5.3 插件管理

- 安装：`dsh plugin --profile <p> add <包>`
- 卸载：`dsh plugin --profile <p> remove <包>`
- 枚举：读 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`），与 `node_modules` 交叉核对
- 启用/禁用：改 `cordis.patch.yml` 最后一条匹配项的 `disabled`（**须重述完整 config**，因 patch 是整块替换）

#### 5.3.1 随实例搬运的本地插件（`core/plugin-packs.ts`）

目标是 PCL2 整合包那样的搬运体验：**插件放在实例目录里，整个实例目录复制到别处也不丢**。

```
<实例>/home/plugins/<插件名>/      ← 插件文件本体（zip 解压 / 手工放入）
<实例>/home/profiles/<p>/package.json
    dependencies: { "<插件名>": "file:../../plugins/<插件名>" }
    dsh.profile.bundles: [ … , "<插件名>" ]
```

- **相对 `file:` 是这条约定的全部意义**：profile 清单里不出现任何实例外的绝对路径，
  于是换机器/换盘符只需一次 `dsh plugin --profile <p> install` 重新链接
- **三种来源**：
  | 来源 | 落点 | 迁移行为 |
  |---|---|---|
  | zip 压缩包 | `home/plugins/<名>`（复制） | 随实例目录搬运 ✅ |
  | GitHub 仓库 | profile 的 `github:` 依赖 | 随清单在目标机重装 ⚠️（需访问 github.com） |
  | 本地文件夹 | `node_modules` 指向源目录的 junction | **不**随实例搬运（改源码即时生效，适合开发） |
- **zip 安全口径**：逐条目拒绝绝对路径 / `..` / 盘符 / ADS，条目数与解压体积设上限（复用 `modpack.ts` 的同一套口径）
- **卸载按来源区别对待**：实例内副本直接删；链接到实例外的**只断链、绝不删源目录**
  （删掉用户正在开发的代码是不可逆事故，有专门用例守着）
- **git 依赖的构建脚本**：pnpm 默认拦截 git 依赖的 `prepare`。安装失败且输出匹配
  `Ignored build scripts` 时，core 自动把**与本仓库名相关**的包名写进
  `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 并重试一次；命令文件坏成非对象/非映射时
  **拒绝写入**（宁可不写也不能写坏 profile）。逃生门：`WHALES_PLUGIN_ALLOW_BUILDS=0`
- 不写入 `home/plugins` 的额外依赖（如 GitHub 来源的 `js-yaml`）仍留在 profile 的 `node_modules`，
  由 `package.json` 记录 —— 它们与普通 npm 插件走同一条恢复路径

#### 5.3.2 pnpm store 的唯一性（踩坑记录）

**症状**：`dsh plugin add` 报 `ERR_PNPM_UNEXPECTED_STORE`
（dependencies are currently linked from store `F:\WhalesLauncher\.pnpm-store\v10`
but pnpm now wants to use `F:\.pnpm-store\v10`），且 dsh 会在这条错误后面
**照样追加**那句 `git-hosted plugins build … allowBuilds …` 提示。

**成因**：pnpm 未固定 store 时按 `<cache 所在盘>\.pnpm-store` 推导。本机
用户级 `~/.npmrc` 有 `cache=F:\NodeJS\node_cache`，而启动器为沙箱注入的
`npm_config_cache` 在工作区内 —— 同一台机器的"手敲 pnpm"与"启动器/市场"于是算出
两个不同盘的 store，谁先建的 `node_modules` 就让另一个整体失败。

**对策**：
1. 启动器在 `pnpmCacheArgs()` 里**显式**传 `--config.store-dir`，并在
   `childBaseEnv()` 里配 `npm_config_store_dir` —— 两处必须是同一个值（有测试守着）；
2. 该值取 pnpm 自己的默认位置（`<盘>\.pnpm-store`），而**不是**启动器根目录内的私有
   store —— 只有当它与用户在终端里手敲的 pnpm、dsh 市场自己发起的安装落在同一位置，
   三者才不会互相判为"位置不符"；
3. **不要拿 dsh 的追加提示当判据**：它对任何 pnpm 失败都会输出那句 allowBuilds 提示，
   早先据此误判把 `ERR_PNPM_UNEXPECTED_STORE` 当成构建脚本问题，去改了无关的配置。
   现在只认 pnpm 自己的 `Ignored build scripts` / `allowBuilds: <包名>: true`，
   且带 `ERR_PNPM_` 错误码时一律不认（有用例覆盖该真实样本）。

**同源的第二个坑 —— 无 TTY 时不得停下来等确认**：store 统一之后 pnpm 转而报
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`（"Aborted removal of modules directory
due to no TTY … set the CI environment variable to true, or set confirmModulesPurge
to false"）。启动器、dsh、pnpm 全都没有交互终端，因此 `childBaseEnv()` 注入
`CI=true`，`pnpmCacheArgs()` 同时传 `--config.confirm-modules-purge=false`（双保险）。

#### 5.3.3 安装误报：以事实为准，而不是以命令退出码为准

**症状**：装 GitHub 插件时 pnpm 明明打出了 `+ dshmarket github:dsh-market/dsh-market`
与 `Done in 24.7s`，界面却报「安装失败」。

**成因**：git 依赖的 `prepare` 会往 stderr 写大量构建输出，
`prepack`/第三方自检（如插件市场装完自己再验一遍）还可能额外报错 ——
**命令退出码与最终状态并不一致**。

**对策**：
1. `verifyInstallLanded()` 做**事实校验**：清单里有它 + `node_modules/<名>` 有它 +
   其 `package.json` 可读，三条同时成立就按成功处理（附一条"命令退出码非零但已就位"的警告），
   任一不成立才按真失败上报。首次尝试与重试路径都走这道闸门。
2. **安装账本** `<profile>/.whales-plugins.json`：记录"启动器亲自装过什么、来源是什么"。
   界面据此对已就位的插件显示**「已装好」**（依赖 + 包文件 + bundles 三处确认），
   第三方自检的失败话术不再影响用户判断；卸载时同步清账，避免把已卸载的显示成已装好。
3. 顺手修掉的易用性缺陷：`github:owner/repo`（用户从日志里复制的写法）现在也能解析。

### 5.4 版本管理

- 枚举本地：扫 `engines/*/node_modules/@deepseek-ai/dsh/package.json` 取 `version`
- 可安装列表：`npm view @deepseek-ai/dsh versions --json`（实测可用，19 个版本）
- 安装：在 `engines/<版本>/` 下 `npm install @deepseek-ai/dsh@<版本>`，cache 指向工作区内
- 删除：仅当无实例引用时允许

### 5.5 实例包导入导出

- 导出 zip：
  ```
  whalelauncher-pack.json      # 包元数据 + 实例元数据
  home/profiles/<p>/package.json
  home/profiles/<p>/cordis.patch.yml
  home/settings.yaml           # 可选
  README.md                    # 可选说明
  ```
  **不含 `node_modules`**（与 PCL2 整合包同样的取舍），导入时按 manifest 重装
- 导入：解压到临时目录 → 校验 schema → 建实例 → `dsh plugin` 重装依赖 → 注册

---

## 6. 里程碑

> ⚠ M1–M5 是**Electron 前端时代**的里程碑记录，其中"验收"列提到的构建/启动方式已随前端替换而改变。
> 下表保留原样作为历史；**当前状态**见 [WinUI 3 交付报告](../winui3-重构交付报告.md)。

| 里程碑 | 内容 | 验收（历史记录） |
|---|---|---|
| **M1 地基** | 脚手架、构建、契约、core 骨架 | `npm run build` 通过，Electron 空窗可启动 |
| **M2 引擎** | instance / engine / profile / plugins / launch | core 单元测试全绿；能真实创建并启动一个实例 |
| **M3 界面** | 实例列表、详情、创建向导、版本管理 | 可视化完成一次"创建→启动→看到日志"闭环 |
| **M4 进阶** | 存档共享、设置隔离、导入导出 | 两实例间会话互通验证通过 |
| **M5 收口** | 独立代码审查、缺陷修复、端到端验收 | 审查问题清零；验收清单全通过 |

**前端替换（2026-09，已完成）**：M1–M5 交付的 Electron 前端被整体替换为 WinUI 3，
`src/core` 与契约未改一行。对应里程碑：

| 阶段 | 内容 | 状态 |
|---|---|---|
| **R1 规范** | 基于 microsoft-ui-xaml 产出统一视觉规范（含出处索引） | ✅ 交付 |
| **R2 桥接** | Node 侧车（NDJSON）+ C# 契约镜像与客户端 | ✅ 交付，冒烟 141/141 |
| **R3 页面** | 8 个页面 + 外壳 + 浮层全部 XAML 重写 | ✅ 交付 |
| **R4 拆除** | 旧前端（54 文件）物理删除 + 构建期引用断言 | ✅ 交付，`src/main/**` 引用数 = 0 |
| **R5 审计** | 逐页真实截图视觉审计 9 个界面单元 | ✅ 交付，4 项"发现→修复→复检" |
| **R6 收尾** | 渲染层 UI 自动化测试、教程图更新、残余清理、打包与同步 | ✅ 交付 |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| ~~Electron 二进制下载不可达~~ | 无法交付桌面应用 | ✅ **已消除**：Electron 已随旧前端整体移除，不再需要它 |
| npm 写工作区外 cache 遭沙箱 EPERM | 依赖装不上 | 所有 npm/pnpm 调用统一 `--cache <工作区内路径>` |
| dsh 内部实现漂移 | 启动器失效 | 架构上只依赖 CLI + 文件系统约定；版本管理页标注兼容性风险 |
| junction 权限 | 存档共享失败 | 用 junction（非 symlink），Windows 无需提权；失败时降级为"复制并标记"并在 UI 说明 |
| patch 是整块替换 | 设置写坏插件配置 | 写入前读取当前生效值并整块重述；写前备份 `cordis.patch.yml` |
| 长路径（>260） | 文件操作失败 | 实例名长度限制 + 路径拼接前校验 |
| 自动放开 git 构建脚本 | 替用户放行了不该放行的包 | 只接受**与本仓库名相关**的提取结果（`<名>` 或 `@scope/<名>`），认不准就回退到仓库名；配置文件非对象/非映射时拒绝写入；`WHALES_PLUGIN_ALLOW_BUILDS=0` 可整体关闭 |
| 桥接两端契约漂移 | 前端调用不存在的通道 | 方法名由 `CH` 常量在运行时导出，`__handshake` 返回真实列表，C# 侧启动即断言；构建期另有 `src/main/**` 引用数 = 0 的护栏 |

---

## 8. 明确不在本期范围

- macOS / Linux 支持（用户已确认仅 Windows）
- 启动器自身的自动更新
- 插件市场/在线索引（只做"从 npm 安装指定包"；本地插件已支持 zip / GitHub / 文件夹三种来源）
- dsh 引擎跨大版本降级的 profile 兼容性保证
