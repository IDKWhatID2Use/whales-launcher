# WhalesLauncher

> **DeepSeek Harness (dsh) 的实例与版本管理启动器**
> Windows 11 · Electron 41 · TypeScript · 遵循 Windows 11 原生 Fluent Design
>
> 仓库：<https://github.com/IDKWhatID2Use/whales-launcher>
> 许可证：[Polyform Noncommercial 1.0.0](LICENSE) —— 非商业用途免费，**未经授权不得商用**
>
> 📘 **第一次用？直接看 [完整使用教程（图文）](docs/guide/README.md)** —— 从安装到日常使用，关键界面逐步配图。

---

## 这是什么

WhalesLauncher 是 **DeepSeek Harness (dsh) 的实例与版本管理启动器**：每个实例独享自己的
引擎版本、插件列表与设置，会话与工作文件夹可以互通，实例之间互不干扰。

| 概念 | 承载物 |
|---|---|
| **dsh 实例** | 一个独立 `DSH_HOME` + 一份实例元数据 |
| **dsh 引擎版本** | `engines/<版本>/node_modules/@deepseek-ai/dsh` |
| **dsh 插件** | profile 的 `dependencies` |
| **dsh 组合包** | profile 的 `dsh.profile.bundles` |
| **插件启用/禁用** | `cordis.patch.yml` 的 `disabled` |
| **实例设置** | 每实例一份 `settings.yaml` |
| **会话 + 工作文件夹** | `sessions/` × workspace 目录 |
| **隔离开关** | 会话 / 设置 / 工作区可各自独立或共享 |
| **实例包** | 可导入导出的 zip |

---

## 三条核心特性

### 1. 每个实例独享引擎版本、插件列表与设置

每个实例是一个**自包含目录**，内含专属的 `DSH_HOME`：

```
instances/<实例名>/
├── instance.json       # 启动器元数据（唯一事实源）
├── home/               # ← 该实例专属的 DSH_HOME
│   ├── profiles/<profile>/    # package.json（插件与组合包）+ cordis.patch.yml（覆盖层）
│   ├── settings.yaml          # 该实例独享的设置
│   ├── .credentials.yaml      # 凭证（可继承主 home）
│   └── sessions/              # 该实例的会话
├── workspace/          # 默认工作文件夹
└── logs/               # 启动日志
```

启动实例时，启动器以 `DSH_HOME=<实例>/home`、`cwd=<实例工作区>` 派生 dsh 进程 ——
因为 dsh 的 home 解析优先级是「显式配置 > `$DSH_HOME` > `~/.dsh`」，注入环境变量即可实现**真正的隔离**。

### 2. 存档可互通

会话与工作区支持三种模式：

| 模式 | 行为 |
|---|---|
| `local` | 使用实例自己的目录 |
| `shared` | 用 **junction** 链接到 `shared/`，多个实例共用同一份存档 |
| `inherit`（凭证） | 从主 home 同步凭证，免去每个实例重复登录 |

Windows 的 junction **不需要管理员权限**，也不需要开发者模式。

### 3. 实例之间互相运行不干扰

独立 home、独立工作目录、独立进程、独立日志。删除实例目录即彻底删除，不影响其它实例。

**自动端口避让**：Web 实例的监听端口由启动器自动分配，**不需要人工逐个指定**。
不传 `--port` 时 dsh 会硬编码落在 3080（`dsh-web-app/cordis.patch.yml` 的 `ctx.webStartup.port ?? 3080`），
因此同时启动多个实例会全部抢同一个端口、只有一个能起来 —— 本机制消除的正是这一点。

- 每个实例有**期望端口**（手写的 `--port` 或上次分配到的端口），被占用时在 **3080–3179** 内自动避让；
- 并发启动时靠**进程内同步预留 + 操作系统绑定探测**保证不会选中同一端口（不是"概率上不会撞"）；
- 整个区间都被占满时回落 **`--port 0`**，由内核分配 —— 因此端口耗尽也不会变成启动失败；
- 各实例的实际端口记录在**实例日志**、**界面（卡片统计项 / 详情页「监听端口」）**
  与**台账** `<root>/cache/ports.json` 三处；
- 非 Web 模板（headless / sdk / acp）**一个参数都不加**（`--port` 只有 Web 应用认，传过去会被当成未知选项）；
- `instance.json` 的 schema **未改动**，台账独立存放，因此不触发任何迁移。

完整设计与边界情况见 [自动端口分配设计说明](docs/design/port-allocation.md)。

---

## 界面

界面遵循 **Windows 11 原生 Fluent Design**：

- **无边框窗口 + 系统原生窗口控制按钮**。采用 Window Controls Overlay（`titleBarStyle: 'hidden'` + `titleBarOverlay`），
  最小化 / 最大化-还原 / 关闭三枚按钮由 **Windows 系统绘制** —— 因此它们拥有原生的 Fluent 反馈、
  hover 关闭变红、最大化状态图标自动切换，并且保留 Snap Layouts。标题栏其余部分自绘，
  通过 `env(titlebar-area-*)` 与运行时测得的 WCO 宽度精确拼接，**不与系统按钮重叠**。
- **应用内自绘菜单**取代系统菜单栏，但**菜单项的快捷键文本来自主进程的同一份定义**
  （`menuSpec()` 是唯一事实源），并有自动化断言守住"菜单显示的快捷键 ⊆ 真实绑定"，防止文案与绑定漂移。
- **Mica 背景材质**（Windows 11 可用时启用，否则自动降级，不影响启动）。
- 深浅双主题、跟随系统；统一的 Fluent 令牌体系（圆角、间距、动效曲线、语义色），
  **无硬编码色值**（全部走 CSS 变量），并通过自动化脚本核算对比度。

![实例列表](docs/assets/screenshot-instances.png)

<details>
<summary>更多截图</summary>

**空态引导**

![空态](docs/assets/screenshot-empty.png)

**应用内菜单（Fluent 浮层）**

![菜单](docs/assets/screenshot-menu.png)

**全局设置**

![设置](docs/assets/screenshot-settings.png)

</details>

---

## 功能一览

- **实例管理**：卡片网格、搜索/排序/筛选、创建向导（四步）、重命名、删除（含目录清理）、打开各类文件夹
- **引擎版本管理**：枚举本机已装版本、从 npm 查询可安装版本、安装（实时日志）、卸载（占用保护）
- **插件管理**：组合包开关、插件安装/卸载（走 `dsh plugin` CLI，与 dsh 的写锁一致）
- **设置编辑**：`settings.yaml` 编辑器（行号、Ctrl+S、非空校验）
- **存档管理**：会话列表（倒序、体积）、打开所在文件夹
- **启动与停止**：实时日志流（stdout/stderr 分色、自动滚动、上滚暂停）、运行计时器、**自动端口避让**（多实例同时运行互不抢端口，实际端口写入日志/界面/台账）、web 实例自动探测地址并可一键打开
- **实例包**：导出为 zip、从 zip 导入
- **全局设置**：主题、主 home、registry、删除确认
- **直接启动**：双击 `.bat` 即用（按需重建）、静默启动 `.vbs`、一键建桌面/开始菜单快捷方式

---

## 安装与运行

### 环境要求

- **Windows 10/11 x64**（Mica 材质与原生窗口按钮需要 Windows 11）
- **Node.js ≥ 22**（开发与源码运行需要；本项目在 Node 26 上验证）
- **独立的 Node.js ≥ 20 用于运行 dsh 实例**（可以与上面同一个，但**不能**是启动器内置的
  Electron 运行时 —— 原因见下）

> **为什么实例必须有独立的 Node.js**
> dsh 依赖原生模块 `node-addon-require-builtin` 从 V8 内部取 Node 内建模块，它的实现**按
> 运行时指纹白名单**匹配。启动器自己跑在 Electron 里，其内置 Node 的指纹（例如 Electron 41
> 的 `V8 14.6.202.26-electron.0`）不在 dsh 的支持列表内，启动会直接失败：
>
> ```
> Error: dsh: host preparation failed: node-addon-require-builtin unsupported:
>   Unsupported/no-context (unsupported Electron runtime fingerprint: ...)
> ```
>
> 因此启动器改为**探测并调用真正的 Node.js**（`src/core/node-runtime.ts`）。解析顺序：
> `$WHALES_NODE_PATH` → `launcher.json` 的 `nodePath` → 启动器自身（源码模式）→
> 系统 `PATH` → 常见安装位置（nvm-windows / Volta / fnm / 官方安装包）。
> 每个候选都会**实际执行一次探针**（`node -e` 读取 `process.versions`）后才判定可用，
> 绝不按路径名猜测。界面入口：**全局设置 → Node 运行时**（可看探测结果、手动指定、重新检测）。

### 首次安装

从仓库克隆 —— 项目不依赖固定盘符或路径，放在任意目录都可以：

```powershell
git clone https://github.com/IDKWhatID2Use/whales-launcher.git
cd whales-launcher
npm install
```

`postinstall` 会自动执行 `scripts/setup-electron.mjs`：若 `electron` 自身的 postinstall
已下载好二进制就直接采用；否则尝试从 `%LOCALAPPDATA%\electron\Cache` 离线铺设。
两条路都走不通时该脚本会**明确报错并给出处理办法**（不会静默失败）。

> 以下两行是**原始开发机的额外步骤，不是通用要求**：该机的 shell 环境注入了
> `npm_config_cache` 并指向工作区外，会压过项目配置，因此必须显式指定缓存目录。
>
> ```powershell
> $env:npm_config_cache = 'F:\WhalesLauncher\.npm-cache'
> npm install --cache 'F:\WhalesLauncher\.npm-cache'
> ```

### 构建与启动

```powershell
npm run build     # 只构建（含类型门禁与 dist.tmp 原子替换）
npm run launch    # 按需构建后启动（等价于双击下面的 .bat）
npm start         # 强制重建后启动
```

### 直接启动（双击即用）

不需要打开终端。项目根目录有三个入口：

| 入口 | 行为 | 适合谁 |
|---|---|---|
| **`启动 WhalesLauncher.bat`** | 双击即启动；产物过期会自动重建。构建/启动失败时**窗口保留**并给出原因与日志路径 | 日常使用、排查问题 |
| **`WhalesLauncher.vbs`** | 无控制台窗口的静默启动；失败弹窗提示并指向日志 | 由快捷方式调用 |
| **`创建桌面快捷方式.bat`** | 在**桌面**与**开始菜单**各建一个快捷方式（指向上面那个 .vbs） | 装一次，之后从开始菜单搜索启动 |

三个入口都走同一份实现（[`scripts/launch.mjs`](scripts/launch.mjs)），做事顺序一致：

1. **环境自检** —— 确认 `node_modules/electron/dist/electron.exe` 到位；缺失时只用本机缓存离线修复（`scripts/setup-electron.mjs`），绝不联网；
2. **按需构建** —— 产物齐全且比 `src/**` 新就直接启动（**双击即开**）；源码改过才跑 `npm run build`，且构建失败**不会**摧毁上一份可用产物；
3. **启动并留证** —— Electron 的 stdout/stderr 直通控制台，同时写日志（见下）。

出问题时先看 **`logs\launcher-summary.log`**：每次启动覆盖写，一屏之内给出时间、入口、
构建决策、实际执行的命令、退出码结论与 Electron 日志末尾 —— 这是「双击没反应」时
最该先打开的那一个文件。

想从终端传参就给 `.bat` 加参数（`--rebuild` / `--skip-build` / `--dry-run` / `--help`）：

```powershell
"启动 WhalesLauncher.bat" --rebuild      # 强制重建再启动
"启动 WhalesLauncher.bat" --skip-build   # 直接用现有 dist 启动（调试产物时最快）
"启动 WhalesLauncher.bat" --help         # 全部选项
```

> **为什么没有单文件 .exe**：把 `.bat` **编译**成 exe 并不会改变什么 —— 它照样要调用
> `node` 与 `node_modules/electron`，只是把脚本藏在 exe 里，反而让排查变难。
> 真正的单文件分发要上 electron-builder / electron-forge 之类的打包器，把整个
> Electron 运行时（约 200 MB）打进安装包；本项目在**开发环境**运行，暂不需要，
> 且本机无法访问 github.com（打包器的依赖下不来）。真要打包时，
> 入口仍是 `dist/main/index.cjs`，与现在完全一致。

> **首次使用前请确认依赖已装好**（见上一节）。若没装，双击 `.bat` 会明确告诉你缺什么，
> 而不是闪一下就没了。

### 图标

`assets/whales.ico` 由 [`scripts/make-icon.mjs`](scripts/make-icon.mjs) **程序化生成**
（自写 PNG 编码 + 缩放 + ICO 封装，零新增依赖），供窗口/任务栏与快捷方式使用，尺寸为
256 / 128 / 64 / 48 / 32 / 16。改设计就改脚本里的几何量再跑 `npm run icon`。

### 其它命令

```powershell
npm run typecheck    # TypeScript 类型检查（零错误为通过）
npm test             # 运行测试（进程内 runner，26 秒左右）
npm run icon         # 重新生成 assets/whales.ico
npm run shortcut     # 重建桌面/开始菜单快捷方式
npm run clean        # 清理 dist/
```

> **教程截图是可复现的**：`npm run shots:tutorial` 会用无头 Chromium + CDP 驱动渲染层，
> 按固定脚本走完各路由并截图到 `docs/assets/tutorial/` —— 界面改动后重跑一次即可，
> 不会留下过期的文档图。加 `-- --list` 看全部场景，`-- --only <关键词>` 只跑其中几张。
> 详见 [使用教程](docs/guide/README.md)。

---

## 目录结构（源码）

```
启动 WhalesLauncher.bat   # ← 双击即用（纯 ASCII：cmd 按活动代码页读批处理，
                          #    中文会被撕成乱码命令，详见文件头注释）
WhalesLauncher.vbs        # ← 静默启动（快捷方式指向它；同样必须纯 ASCII）
创建桌面快捷方式.bat        # ← 建桌面/开始菜单快捷方式
assets/whales.ico         # ← 应用图标（scripts/make-icon.mjs 生成，勿手改）
scripts/
├── build.mjs             # 构建（tsc 门禁 → dist.tmp → 原子替换）
├── launch.mjs            # 三个启动入口共用的实现：自检 / 按需构建 / 启动 / 诊断
├── make-icon.mjs         # 程序化生成多尺寸 ico（零依赖）
├── make-shortcut.ps1     # 建快捷方式（纯 ASCII，见文件头注释）
└── setup-electron.mjs    # 离线铺设 Electron 运行时
src/
├── shared/contracts.ts   # 冻结契约：类型、IPC 通道表、CoreApi / WhalesApi
├── core/                 # 纯 Node/TS 引擎，无 Electron 依赖，可独立测试
│   ├── fsx.ts            # 文件工具（原子写、junction 安全解除）
│   ├── paths.ts          # 路径解析
│   ├── names.ts          # 命名校验（复刻 dsh profile 规则）
│   ├── instance.ts       # 实例 CRUD 与共享模式落地
│   ├── engine.ts         # 引擎版本安装/枚举
│   ├── profile.ts        # profile 读写（package.json / cordis.patch.yml / settings.yaml）
│   ├── plugins.ts        # 插件增删（走 dsh plugin CLI）
│   ├── launch.ts         # 子进程启动与运行时状态
│   ├── saves.ts          # 会话枚举
│   └── modpack.ts        # 实例包导入导出
├── main/                 # Electron 主进程（窗口、IPC 路由、进程编排）
├── preload/              # contextBridge 暴露 window.whales（零 ipcRenderer 泄漏）
└── renderer/             # 界面（原生 TS + CSS，无 UI 框架）
```

> `logs/` 下是启动器自身的日志，三种各司其职：
> **`launcher-summary.log`**（每次启动覆盖，人读的汇总结论，排查先看它）、
> **`launcher-<时间戳>.log`**（Electron 日志，保留最近 5 份）、
> **`launcher-console-<时间戳>.log`**（快捷方式路径下 shell 层的兜底输出，只兜"node 没跑起来"，
> 保留 7 天）。固定名日志（快捷方式用的 `launcher-shortcut.log`）会把上一份归档到 `logs/history/`。

---

## 架构原则

1. **启动器不 import dsh 内部 API。** 多版本共存下各实例的 dsh 版本不同，内部 API 会漂移。
   稳定边界只有两条：**`dsh` CLI** 与**文件系统约定**。
2. **优先让 dsh 自己管理自己的目录。** 例如创建实例走
   `dsh --profile <名> --from-default-profile <模板> --dump-config` —— 它在全新 home 上完成
   profile 初始化并输出组合配置后退出，**不启动应用、不调用模型、无交互**（已实测）。
   `profiles/node_modules` 这类共享 fallback 也交给 dsh 在启动时自行建立，启动器不越权。
3. **绝不静默删数据。** 解除链接前先 `lstat` 确认是链接；共享模式切换遇冲突时保留本地并报错，
   而不是无条件覆盖。
4. **写操作原子化。** 同目录临时文件 + rename。

---

## 已知环境坑（原始开发机特有，非通用问题）

> 本节记录的是**原始开发机**的隔离沙箱环境所特有的现象（受限文件沙箱、无法访问
> github.com、命名管道被禁用等）。在普通 Windows 机器上通常不会遇到；保留于此是为了
> 说明代码里若干"看起来绕"的设计**为什么存在**。

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm install` 报 `EPERM ... F:\NodeJS\node_cache` | shell 注入了 `npm_config_cache`，npm 优先级为 **命令行 > 环境变量 > 项目 .npmrc**，压过了项目配置 | 显式 `--cache F:\WhalesLauncher\.npm-cache` 并先设 `$env:npm_config_cache` |
| 构建/安装报 `spawn EPERM` | 受限沙箱禁止带管道 stdio 的 spawn（esbuild JS API、npm postinstall 都依赖它） | 构建已改用 esbuild CLI + `stdio:'inherit'`；安装用 `--ignore-scripts` |
| Electron 二进制下载失败 | 本机无法访问 github.com | 从 `%LOCALAPPDATA%\electron\Cache` 离线铺设：`npm run setup:electron` |
| `electron .` 立即崩溃（crashpad "not connected"） | Chromium 需要命名管道与 mojo IPC，受限沙箱禁止 | 在普通（非沙箱）终端运行 |
| `npm test` 报 `spawn EPERM` | `node --test` 的 runner 为每个文件 spawn 带管道的子进程 | 已改用 `--test-isolation=none`（同进程运行） |
| 实例启动即失败，stderr 含 `node-addon-require-builtin unsupported: Unsupported/no-context` | 曾经用 Electron 的 `process.execPath`（electron.exe）+ `ELECTRON_RUN_AS_NODE=1` 当 Node 跑 dsh；dsh 的原生模块只识别特定 Electron 版本 | **已修复**：改用真正的 Node.js（`src/core/node-runtime.ts`）。若本机 Node 不在 PATH 上，在「全局设置 → Node 运行时」指定 `node.exe`，或设 `$env:WHALES_NODE_PATH` |
| 实例启动失败，stderr 含 `EADDRINUSE ... :3080` | web profile 默认监听 3080，已被别的实例或别的程序占用 | 给该实例的启动参数加 `--port <其它端口>`（`launch.appArgs`），或先结束占用者；启动器的失败提示里也会写出来 |

---

## 验证与验收

### 三道构建自保

`npm run build` 不是一条裸命令，它内置了三层保护：

1. **构建前类型门禁**：先跑 `tsc --noEmit`，非 0 立即中止且**不动旧产物**。
   为什么需要它 —— esbuild **不做类型检查**，它能把"引用了未定义标识符"的源码照样打包成功并返回 0。
   实测踩过：core 处于编辑中间态时构建返回 0、产物齐全，但 `electron .` 启动即抛 `ReferenceError`。
2. **原子替换**：构建到 `dist.tmp/` → 四个必需产物齐全 → 才替换 `dist/`。
   失败构建不再摧毁上一份可用产物（早期版本"先 `rm -rf dist` 再构建"，一次失败就让应用起不来）。
3. **产物加载验证**：`node tests/dist/verify-dist.cjs` 直接 `require` 真实产物（替身 electron），
   断言模块初始化不抛错、窗口参数齐备、IPC 通道注册、`index.html` 引用无断链。

### 回归命令

```powershell
npm run typecheck                       # 类型检查（应 exit 0）
npm test                                # 核心测试（16 文件，exit 0 为通过）
node tests/e2e/53-port-acceptance.mjs 8 # 端口验收：8 实例同时启动不冲突 + 外部占用自动避让（真实 dsh 引擎）
node tests/core/launch-real-dsh.test.mjs # 真实 dsh：用真 Node 启动实例（--port 0，不占 3080）
node tests/dist/verify-dist.cjs         # 产物可加载性 + 静态资源 SHA256 对账
node tests/dist/node-runtime-check.cjs  # Node 运行时探测 + nodePath 配置（自动还原 launcher.json）
node tests/dist/qr08-check.cjs          # 引擎体积惰性计算
node .spike/smoke/run.mjs               # 渲染层交互冒烟（演示模式，exit 0 为通过）
node .spike/smoke/real-mode.mjs         # 渲染层真实桩冒烟（28 项）
node tests/e2e/run-all.mjs              # 独立审查者的端到端用例集
npm run launch -- --dry-run             # 启动链路自检（环境 + 按需构建判定，不开窗口）
```

> **`.spike/` 未纳入版本库**（见 `.gitignore`：该目录含指向真实 `~/.dsh` 的 junction 与大量本机
> QA 产物，体积 24 MB），所以上面两条渲染层冒烟命令**只在原始开发机上可用**，clone 下来的仓库没有这个目录。
>
> 在原开发机上，`.spike/smoke/node_modules` 是 **jsdom 的唯一安装位置**（未声明在 `package.json`），
> 清理时**不可删除**，否则两条渲染层冒烟会静默失效。详见 `.spike/smoke/README.md`。

### 无法在本机验证的项（需要在普通桌面环境复核）

这三项**不是缺陷，而是开发环境的观测窗口被关闭**（沙箱禁止 Chromium 所需的命名管道、对进程树有 job object 级包容、CDP 取不到 DWM 合成的 Mica）：

| 项 | 现象 | 一键验证 |
|---|---|---|
| 真实窗口与交互 | 拖动、双击最大化、Snap Layouts、三按钮 hover 变红、Mica 观感 | 双击 `启动 WhalesLauncher.bat`（或 `npx electron .`） |
| 进程树真杀 | 本机 `taskkill` 恒返回 Access denied，且沙箱自动包容进程树 → 差异不可观测 | `node tests/core/degraded-records.test.mjs` |
| 真实 dsh 完整链路 | 受"不得触碰真实 `~/.dsh`"边界约束，用**临时 root + 真实引擎**验证；实例界面（浏览器窗口）本身无法在无桌面环境观察 | `node tests/core/launch-real-dsh.test.mjs`（自动创建/启动/停止，`--port 0` 不抢端口） |
| 往桌面/开始菜单写快捷方式 | 写工作区之外被文件沙箱拒绝（实测 `Unable to save shortcut`）→ 脚本按设计回落到项目内的 `快捷方式\` 目录（目录名由 `scripts/make-shortcut.ps1` 以字符码拼出，避免批处理编码问题） | 在普通终端运行 `创建桌面快捷方式.bat` |

> **直接启动的验证边界（如实声明）**：`.bat` 的真启动已在带虚拟终端的会话中实测通过
> （Electron 起 4 个进程、窗口标题为 `WhalesLauncher —— dsh 实例与版本管理`、退出码 0），
> `.vbs` 静默路径、单实例切前台、日志轮转与快捷方式回落的**失败分支**全部实测。
> 但**从裸 PowerShell 工具进程直接拉 Electron 会失败**（`mojo ... 拒绝访问`）——
> 这是本会话沙箱禁止命名管道所致，不是应用缺陷：同样一条命令在虚拟终端里成功、
> 在沙箱工具进程里失败，差异来自环境而非代码。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [**使用教程（图文）**](docs/guide/README.md) | **面向使用者的完整指引：安装 → 五分钟上手 → 实例/引擎/插件/设置/存档管理 → 隔离与共享 → 故障排查。全部截图由脚本生成，可复现** |
| [dsh 接口勘察](docs/research/dsh-interface.md) | dsh CLI、`$DSH_HOME` 解析、profile 结构、配置层组合顺序（均源码级确认） |
| [总体设计方案](docs/design/architecture.md) | 概念映射、目录布局、分层架构、数据模型、核心流程、里程碑 |
| [自动端口分配设计说明](docs/design/port-allocation.md) | 端口来源与源码依据、三层防护、决策顺序、边界情况、验收实测结果 |
| [UI 设计方案](docs/design/ui-redesign.md) | Windows 11 Fluent 视觉规范、标题栏/菜单规格、设计令牌 |
| [UI 验收标准](docs/design/ui-acceptance-criteria.md) | 一致性判据、反模式清单、评分卡、整改清单模板 |
| [代码审查报告](docs/review/code-review.md) | 独立审查发现的问题与处置 |

---

## 许可证

本项目采用 **[Polyform Noncommercial License 1.0.0](LICENSE)**：非商业用途免费使用、修改与分发，
**未经授权不得用于商业用途**。全文见 [LICENSE](LICENSE)。

> 需要说明的是：该许可证**不是** OSI 认证的开源许可证 —— OSI 的开源定义不允许限制使用领域。
> 因此本项目的准确定位是「**源码可得（source-available）+ 非商业授权**」。
> 商业使用、企业内部生产环境使用或嵌入商业产品，请先联系作者获取授权。

## 致谢

本项目为独立实现，未复制任何第三方项目的源代码。所使用的开源依赖见 [package.json](package.json)。
