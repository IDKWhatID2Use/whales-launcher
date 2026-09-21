# 旧前端（Electron / DOM 时代）拆除方案与依赖边界取证

> **本文性质**：**方案与取证**，不是执行记录。本轮**没有删除任何文件**，也没有修改除本文件外的任何文件（调查全程只读：`read` / `grep` / `glob` / 只读 PowerShell）。
> **执行时机**：WinUI 3 新前端通过验收后，由 Lead 按 §7 的步骤一次性执行。
> **基线 commit**：`a239e77a28e4f07a66abda0287c14cc27d657e96`（分支 `winui3-rewrite`，调查时 HEAD）
> 所有 `git rm` 的删除都可由 git 精确恢复，回滚命令见 §8。
>
> **一句话结论**：可安全删除 **18 项、约 19 842 行**旧前端代码（`src/renderer` 15 119 + `src/main` 7 个 Electron 文件 2 428 + `src/preload` 141 + `tests/dist` 809 + 旧构建脚本 1 345），外加 2 份废弃设计文档（2 583 行）。
> **但 `src/main/` 下有两个文件绝对不能跟着删：`errors.ts` 与 `devtools.ts`** —— 它们是 Node 侧车进程**运行时 import** 的模块（§6.1 有原文证据）。
> 另有 **12 项属「暂缓／需人工确认」**，其中风险最高的是「双击启动与桌面快捷方式」（§9.1）。

---

## 0. 调查时点与"漂移"警告（**执行前必读**）

本调查进行时，`desktop/bridge/**`（Node 侧车）仍在被并行编写：调查中途新增了第 7 个桥接文件 `desktop/bridge/menu.mjs`，它当场**推翻了**我第一轮"`src/main/devtools.ts` 可删"的结论（详见 §6.1）。

因此：

1. 本文所有"引用数 = 0"的结论都带**时点**（下表数字为最后一次复扫的结果）；
2. **执行前必须重跑 §6.6 的反查命令**，确认 `src/main/**` 的运行时 import 仍只有 §6.1 那 4 条。桥接层只要再引入一个 `src/main/**` 模块，本文的删除清单就会失效。

> **行数口径**：本文所有行数均为**物理行数**，用 `[System.IO.File]::ReadAllLines($path).Count` 统计。
> 不要用 `Get-Content | Measure-Object -Line`：在 Windows PowerShell 5.1 上它会跳过空行（实测 `src/main/devtools.ts` 得 25，实际 39），据此估算会低估约 15%。

---

## 1. 判定方法：先定义"存活集合"，再看引用

"旧代码"不能靠"看起来像旧的"来判断 —— 本仓库尤其危险：`src/main/**` 这个目录在新架构里仍有**两个活文件**。
所以本文对每个候选删除项，统一统计**存活集合对它的引用**。

**存活集合**（新架构仍在用、拆除后必须继续工作的东西）：

| 存活项 | 为什么在存活集合里 |
|---|---|
| `desktop/bridge/**`（7 个 `.mjs`，共 2 308 行） | Node 侧车进程本体，C# 侧 `Process.Start` 拉起它 |
| `desktop/src/WhalesLauncher.App/**` | 新前端（C#/XAML） |
| `scripts/build-bridge.mjs` | 新构建入口，产出 `dist/bridge/server.cjs` |
| `scripts/audit/**` | 本轮新增的桥接冒烟与 WinUI 视觉审计工具 |
| `tests/core/**`、`tests/e2e/**` | core 引擎的测试资产（§6.4 证明 `tests/e2e` 测的是 **core**，不是 Electron） |
| `src/core/**` | 业务引擎（`desktop/bridge/server.mjs` 运行时 import） |
| `src/shared/contracts.ts` | 契约唯一事实源（bridge 运行时 import） |
| `tsconfig.json`、`package.json` | 构建与依赖声明 |
| `docs/design/winui3-*.md`、`docs/audit/**` | 本轮冻结的规范与新审计产物 |

**判据分两级**（本文最重要的区分，混用会误删）：

- **运行时 import**（`import … from '<path>'` / `require('<path>')`）→ 删了就崩，属**保留**；
- **注释 / 文档提及**（`* 来源：src/main/ipc.ts L423`、C# 的 `<c>src/main/ipc.ts</c>` 文档注释）→ 只是溯源说明，删除不影响编译与运行，属**可删但留痕**（§5.3）。

---

## 2. 待删清单（18 项）

风险栏：**高** = 删错会破坏新架构或用户可见能力；**中** = 需同步改配置/文档，否则断链；**低** = 纯死代码。

| # | 待删项 | 类别 | 行数 | 删除依据（机械证据） | 风险 | 同步动作 |
|---|---|---|---|---|---|---|
| 1 | `src/main/index.ts` | Electron 主进程 | 417 | 运行时 import **0**；存活集合 5 处命中：`desktop/**` 4 处**全是注释**（`config-store.mjs:79,371`、`server.mjs:697,719` 的"来源：src/main/index.ts L…"）+ `tests/e2e/50-status-recheck.mjs:223` 的**文本读取**（见 §9 #1） | 中 | 先处理 §9 #1 |
| 2 | `src/main/ipc.ts` | Electron 主进程 | 743 | 运行时 import **0**；17 处命中全是注释/文档（`desktop/bridge/validate.mjs` 的"等价搬运自"、`desktop/bridge/server.mjs` 的通道对照表、`scripts/audit/bridge-smoke.mjs:403`、C# 6 处 `<c>` 文档注释）。**校验逻辑已机械搬运到 `desktop/bridge/validate.mjs`**（协议 §5.2 的做法） | 中 | `docs/design/winui3-impl-brief.md:12` 需改写（§7 步骤 5） |
| 3 | `src/main/config.ts` | Electron 主进程 | 268 | 运行时 import **0**；3 处命中为注释（`config-store.mjs:2`"等价搬运自"、`SettingsPage.xaml.cs:335` 行为说明）+ `tests/e2e/50-status-recheck.mjs:86` 文本读取 | 中 | 同 #1 |
| 4 | `src/main/menu.ts` | Electron 主进程（菜单） | 373 | 运行时 import **0**；2 处命中为注释（`server.mjs:55`、`server.mjs:480`）。**菜单数据已搬运到新增的 `desktop/bridge/menu.mjs`**：`menuSpec()`（menu.ts L41-119 的纯数据）与 `menuNodes()` 投影（L142-192）都在 `menu.mjs` 里重写；`runMenuCommand()`（L227-322）**无法搬运**（每支都在操作 Electron `BrowserWindow`）→ `app:menuCommand` 在桥接层回**明确错误**、由宿主按 `MenuNode.id` 本地执行 | 低 | 无（注释可留） |
| 5 | `src/main/runtime.ts` | Electron 主进程（日志推送） | 349 | 运行时 import **0**；5 处命中为注释（`events.mjs:2`、`server.mjs:52`、`EnginesPage.xaml.cs:31` + `tests/e2e` 2 处）。推送语义已搬运到 `desktop/bridge/events.mjs`（协议 §2.4 的 `log:chunk`/`log:state`） | 低 | 无 |
| 6 | `src/main/theme.ts` | Electron 主进程（主题） | 130 | **引用计数 0**（存活集合内零命中） | 低 | 无（三主题由 Lead 的 `ThemeService` 接管） |
| 7 | `src/main/shortcuts.ts` | Electron 主进程（快捷键） | 148 | **引用计数 0**。快捷键语义改由 XAML `KeyboardAccelerator` 承担 | 低 | 无 |
| 8 | `src/preload/**` | preload | 141 | 运行时 import **0**；`src/shared` 3 处命中是 `WhalesApi` 的文档注释（"preload 通过 contextBridge 暴露"），非代码依赖。`contextBridge` 通道已被 NDJSON 桥接取代 | 低 | `contracts.ts` 内 3 处注释可选择性改写（不影响编译） |
| 9 | `src/renderer/**` | DOM 渲染层 + 旧样式 | 44 文件 15 119 | 运行时 import **0**；`desktop/**` 13 处命中全为注释（C# 侧"移植自 src/renderer/util/*"的溯源说明）；`src/shared` 4 处为注释。**`src/core/**` 对它零引用**（§6.3） | 低 | `docs/guide/07-troubleshooting.md:118-119` 链接 `src/renderer/PREVIEW.md` 需改写 |
| 10 | `tests/dist/**` | 旧测试（产物验证） | 3 文件 809 | **引用计数 0**。三者都用**替身 electron** 直接 `require(dist/main/index.cjs)`（`verify-dist.cjs:1-14`、`qr08-check.cjs:8`、`node-runtime-check.cjs:55` 引 `dist/renderer/index.html`），验证对象是被删产物 | 低 | 其意图（"构建通过但模块初始化即抛错"）已由 `scripts/audit/bridge-smoke.mjs` + `CoreBridge` 自验覆盖 |
| 11 | `scripts/build.mjs` | 旧构建脚本 | 244 | 无 import；2 处命中为注释（`build-bridge.mjs:10` 说明与它的关系）。它打包 `src/main/index.ts` + `src/preload/index.ts` + `src/renderer/index.ts` 三个待删入口 | 中 | **`package.json` 的 `build` 必须同时改指 `build-bridge.mjs`**，否则断链（§7 步骤 1） |
| 12 | `scripts/launch.mjs` | 旧构建脚本（启动器） | 522 | `src/core` 1 处命中为注释；`package.json` 2 处是 `launch`/`start`。它自检 `node_modules/electron/dist/electron.exe` 并拉起 Electron | 中 | 与 §9 #2 一起做：双击启动改指新 exe |
| 13 | `scripts/setup-electron.mjs` | 旧依赖铺设 | 108 | `package.json` 2 处命中（`postinstall` + `setup:electron`）。它铺设 Electron 运行时二进制 | **高** | **必须先摘掉 `postinstall`**：脚本删了但 `postinstall` 还在，`npm install` 会直接失败（§7 步骤 1） |
| 14 | `scripts/make-tutorial-shots.mjs` | 旧构建脚本（截图） | 471 | 其输入 `dist/renderer` 与"渲染层演示数据模式"（`src/renderer/data/demo.ts`）都随 #9 消失 | 中 | `package.json` 的 `shots:tutorial` 一并移除 |
| 15 | `dist/main/**`、`dist/preload/**`、`dist/renderer/**` | 旧构建产物 | 12 文件 24 182（未入库：`/dist/` 已 ignore，`git ls-files dist` = **0**） | 旧入口的产物。**注意 `dist/` 本身要留下** —— `dist/bridge/server.cjs` 是新前端的产品，`.csproj` 靠 `Exists(dist/bridge)` 复制到 exe 目录 | **高** | 只能删这三个子目录（或 `npm run clean` 后**立刻** `npm run build:bridge`），**不可删整个 `dist/` 后忘记重建** |
| 16 | `docs/design/ui-redesign.md` | 旧设计（DOM/CSS 规范） | 1 737 | **已冻结的视觉规范亲自判它废弃**：`docs/design/winui3-visual-spec.md:8`「不得作为设计依据的已废弃材料：`src/renderer/**`、`docs/design/ui-redesign.md`、`docs/design/ui-acceptance-criteria.md`、`docs/review/fluent2-*.md`」 | 中 | 6 处入链需处理（§6.5、§7 步骤 5） |
| 17 | `docs/design/ui-acceptance-criteria.md` | 旧设计（旧验收标准） | 846 | 同上。其判据全部针对 `src/renderer/styles/*.css` 与 `src/main/index.ts` 的 BrowserWindow 配置 | 中 | 同上 |
| 18 | `package.json` 的 `electron` devDependency | 旧依赖 | `electron@41.1.0` | `package.json:35` 与 `package-lock.json` 是唯一出处；`build-bridge.mjs:122` 已显式 `--external:electron` **拒绝**把 Electron 打进产物 | 中 | 必须同批 `npm install` 重建 `package-lock.json`（§4.1） |

> **关于任务书提到的 `@fluentui/*` 与 `@microsoft/fast-element`：本仓库 `package.json` 中不存在这两个依赖**（已实测确认）。
> 旧渲染层是"原生 TS + 手写 CSS，无 UI 框架"（`docs/review/frontend-survey-for-winui3.md` §2 结论一致），因此 §4.1 的依赖移除清单只有 `electron` 一项。

---

## 3. 保留清单（17 项，**不要删**）

| # | 保留项 | 行数 | 理由（为什么容易误删） |
|---|---|---|---|
| 1 | **`src/main/errors.ts`** | 135 | ⚠️ **最高危误删之一**：名字在 `src/main/` 下，看着像"Electron 主进程"，实为**新侧车的运行时依赖** —— 3 个 bridge 文件直接 import 它（§6.1）。删它 → `build-bridge.mjs` 直接失败 |
| 2 | **`src/main/devtools.ts`** | 39 | ⚠️ **同样高危，且是调查中途才暴露的**：`desktop/bridge/menu.mjs:23` 运行时 `import { devToolsEnabled }`（用于"devTools 菜单项置灰"与旧实现同源）。该文件本身**零 Electron 依赖**（只读 `process.env` / `argv`） |
| 3 | `src/core/**` | 16 文件 6 982 | `desktop/bridge/server.mjs:60` 等运行时 import；业务引擎本体 |
| 4 | `src/shared/contracts.ts` | 892 | 契约唯一事实源；`server.mjs:61`、`config-store.mjs:16`、`events.mjs:15` 运行时 import。其内 7 处 `renderer`/`preload` 提及**都是注释**，不影响保留 |
| 5 | `tests/core/**` | 19 文件 5 053 | core 的测试资产（含 `run-all.mjs`，沙箱内可跑） |
| 6 | `tests/e2e/**`（除 §9 #1 那一个文件） | 19 文件 3 714 | **不是 Electron 测试**：`_bundle.mjs` 用 esbuild 打包 `src/core` 后在进程内直测（`00-smoke.mjs` 断言 `CoreApi` 契约方法清单、`40-core-deep.mjs` 测 junction 删除安全等）。删掉等于自断 core 的 QA |
| 7 | `desktop/**` | 新前端 | 本轮交付物 |
| 8 | `scripts/build-bridge.mjs` | 177 | 新构建入口（顺带发现：其 `sources` 语法自检清单只列了 6 个文件，**漏了新增的 `desktop/bridge/menu.mjs`**；esbuild 仍会打包它，只是少一道 `node --check`。建议补上） |
| 9 | `scripts/audit/**` | 6 文件 | 本轮新增：`bridge-smoke.mjs`（桥接冒烟）+ WinUI 视觉审计（`audit-visual.ps1`/`capture-core.ps1`/`capture-window.ps1` 注释里明确写的是 WinUI 3） |
| 10 | `scripts/repair-session-zstd.cjs` | 259 | 独立排障工具，**零项目内 import**（只用 `node:fs/path/crypto/zlib/util`，实测 5 条 require 全是内置模块），与前端无关 |
| 11 | `scripts/make-icon.mjs` + `assets/whales.ico` | 380 | 程序化生成多尺寸 `.ico`，**与 Electron 无关**（全文唯一一处 Electron 提及只是注释"让任务栏不显示 Electron"）。新 exe 的图标与快捷方式仍要用 → 保留并保留 `npm run icon` |
| 12 | `docs/design/winui3-{visual-spec,csharp-conventions,bridge-protocol,impl-brief}.md` | — | 本轮冻结的四份规范 |
| 13 | `docs/review/frontend-survey-for-winui3.md`、`docs/review/winuinav-migration-assessment.md` | — | 本轮重构的**需求输入证据**（旧前端能力盘点、迁移决策），删掉就丢了"为什么这样重写"的依据 |
| 14 | `docs/audit/**` | 3 文件 | 新前端的视觉审计产物（`visual-audit.json/md`） |
| 15 | `docs/research/**`（`dsh-interface.md`、`pcl2-research.md`） | — | 外部接口与对标调研，结论仍有效 |
| 16 | `package.json`、`tsconfig.json`、`.npmrc`、`.gitattributes`、`LICENSE`、`assets/` | — | 需**改写**而非删除（§4、§5） |
| 17 | `dist/bridge/**` | 构建产物 | 新前端的运行时依赖（`.csproj` 复制到 exe 目录） |

---

## 4. `package.json` 改造方案

### 4.1 依赖

| 字段 | 现在 | 目标 | 依据 |
|---|---|---|---|
| `main` | `"dist/main/index.cjs"` | **删除该字段** | 它是 `electron .` 的入口；Electron 移除后无意义 |
| `dependencies` | `adm-zip`、`js-yaml` | **保持不变** | 被 `build-bridge.mjs` 打包进 `server.cjs`，运行期仍需要 |
| `devDependencies.electron` | `41.1.0` | **移除** | 见 §2 #18 |
| `devDependencies` 其余 | `@types/adm-zip`、`@types/js-yaml`、`@types/node`、`esbuild`、`typescript` | **保持** | esbuild 供 `build-bridge.mjs`；typescript 供 `typecheck`；`@types/*` 供 core/bridge 类型检查 |

> `package-lock.json` 必须与 `package.json` 同批更新（`npm install` 后提交），否则 lock 里仍留着 Electron 及其全部传递依赖。

### 4.2 `scripts` 字段

| 键 | 处置 | 目标值 / 理由 |
|---|---|---|
| `build` | **改写** | `node scripts/build-bridge.mjs`（原 `scripts/build.mjs` 待删） |
| `build:bridge` | **新增** | `node scripts/build-bridge.mjs`。**当前 `package.json` 里没有这个键** —— 新构建脚本已存在但没登记，属现存缺口 |
| `postinstall` | **删除（必须最先做）** | 保留它却删了 `setup-electron.mjs`，会让任何一次 `npm install` 直接失败 |
| `setup:electron` | 删除 | 同上 |
| `launch` / `start` | 删除或改写 | 若保留"命令行启动"，改为启动 `desktop\src\WhalesLauncher.App\bin\...\WhalesLauncher.exe`（与 §9 #2 一起决策） |
| `shots:tutorial` | 删除 | 输入 `dist/renderer` 消失 |
| `rec` / `rec:setup` / `rec:guide` / `rec:check` | **暂缓**（§9 #3） | `scripts/record/record.mjs`（671 行）本身前端无关（ffmpeg ddagrab 桌面采集），但 R1–R10 清单按旧 UI 编写 |
| `icon` | **保留** | `make-icon.mjs` 生成的 `assets/whales.ico` 新 exe 仍要用 |
| `shortcut` | **改写**（§9 #2） | 目标从 `wscript.exe + WhalesLauncher.vbs` 改为指向新 exe |
| `typecheck` | 保留（收窄 include，见 §5.1） | |
| `test` / `test:core` | 保留 | `tests/**/*.test.mjs` 实际只匹配 `tests/core/**` |
| `clean` | 保留 | `rmSync('dist')`，与 `build:bridge` 配套（注意 clean 后必须重建 bridge） |
| `smoke:bridge` | **建议新增** | `node scripts/audit/bridge-smoke.mjs`（协议 §5.5 要求的可脱离 UI 冒烟） |

> **任务书里点名、但本仓库实际不存在的项**：`gen:tokens` 脚本、`@fluentui/*`、`@microsoft/fast-element` 依赖。
> 已实测 `package.json` 的 `scripts` 与 `dependencies`/`devDependencies` 全文：三者均无（旧渲染层的样式是手写 CSS + `scripts/make-icon.mjs` 生成图标，没有令牌生成链）。因此不在本清单内，**执行时不要去找它们**。
> 同理，任务书要求"移除 `rec*`"：本方案把 `rec*` 归入暂缓（§9 #3），因为 `scripts/record/record.mjs` 本身与前端无关（ffmpeg 桌面采集），只有它的镜头清单绑定了旧 UI。

---

## 5. 其他配置与文档

### 5.1 `tsconfig.json`
现有 `include: ["src/**/*.ts", "scripts/**/*.mjs"]`。拆除后 `src/**` 只剩 `core`、`shared`、`main/{errors,devtools}.ts`，`include` 仍能工作，但建议同步收窄并去掉 DOM：

| 项 | 现在 | 目标 | 理由 |
|---|---|---|---|
| `lib` | `["ES2023","DOM","DOM.Iterable"]` | `["ES2023"]` | 已无 DOM 代码；留着会让后续误用 DOM 全局而不报错 |
| `include` | `src/**/*.ts`、`scripts/**/*.mjs` | `src/core/**/*.ts`、`src/shared/**/*.ts`、`src/main/errors.ts`、`src/main/devtools.ts` | 显式列出，防止"删了目录但 include 空转" |
| 桥接层覆盖 | `desktop/**` 未纳入 | 建议 `allowJs: true` + `checkJs: true` 后纳入 `desktop/bridge/**/*.mjs` | `build-bridge.mjs` 只做 `node --check`（语法级），类型错误目前无人把关 |
| `paths` | `@shared/*`、`@core/*` | 保留 | bridge 用相对路径 import，别名不影响 |

### 5.2 `.gitignore`
本轮产生了两个**未入库、也未被 ignore** 的目录（`git status` 显示 `?? .backup/`、`?? .fluent-b64/`）：前者是 `pre-fluent2-20260921-112817` 全量快照，后者是 Fluent 令牌的 base64 取证素材。建议追加：

```gitignore
/.backup/
/.fluent-b64/
```

已正确 ignore 的：`/node_modules/`、`/.npm-cache/`、`/.pnpm-store/`、`/dist/`、`/instances/`、`/engines/`、`/cache/`、`/logs/`、`/shared/`、`/launcher.json`、`/.spike/`、`/.probe/`、`/desktop/**/bin/`、`/desktop/**/obj/`。

### 5.3 注释与文档中的"悬空引用"（不影响编译，建议批量处理）

| 位置 | 内容 | 处理建议 |
|---|---|---|
| `desktop/bridge/{server,validate,config-store,events,menu}.mjs` 共 28 处 | `来源：src/main/ipc.ts L…`、`menu.ts L41-119` 等溯源注释（另有 4 处是**真 import**，见 §6.1） | **建议保留**：它们是"这段逻辑搬运自何处"的唯一线索，删掉反而让后人无法对照。可在文件头补一行"来源文件已随旧前端拆除，历史见 commit `<基线>`" |
| `desktop/src/**` 9 处 C# 文档注释 | `<c>src/main/ipc.ts:646</c>` 等 | 同上（`<c>` 是文本而非 `cref`，不影响编译） |
| `src/shared/contracts.ts` 7 处 | "preload 通过 contextBridge…"等技术说明 | 建议改写为"宿主（WinUI 侧）"表述；**低优先级** |
| `docs/design/winui3-impl-brief.md:12` | "`src/main/ipc.ts`（参数形状）可作为事实来源查阅" | 拆除后该句失效 → 改写为"见 git 历史 / `docs/design/legacy-teardown-plan.md`" |

---

## 6. 依赖反查证据（原始命中，可逐条复核）

### 6.1 存活集合对 `src/main/**` 的**代码级 import**：恰好 4 条

```
desktop\bridge\config-store.mjs:17: import { AppError, describeError } from '../../src/main/errors.ts';
desktop\bridge\menu.mjs:23:         import { devToolsEnabled } from '../../src/main/devtools.ts';
desktop\bridge\server.mjs:62:       import { AppError, describeError } from '../../src/main/errors.ts';
desktop\bridge\validate.mjs:14:     import { AppError } from '../../src/main/errors.ts';
```

- `errors.ts`（135 行）：错误码 → 中文处置建议的翻译层，**零 Electron import**；
- `devtools.ts`（39 行）：`WHALES_DEV` / `WHALES_DEVTOOLS` 开关，**零 Electron import**。

> 这两条是本文结论的**承重点**：`src/main/` 里其余 7 个文件都是 0 运行时 import，可删；这两个不行。
> `menu.mjs` 是调查进行中才出现的（`desktop/bridge/menu.mjs` mtime 晚于其余 6 个文件），它就是"反向依赖会随桥接层演进而增加"的活例子 —— 见 §0。

### 6.2 存活集合对 `src/main/**` 的其余命中：全部是注释或文档

按文件计的原始命中数（**含注释**，最后一次复扫）：

| 文件 | 命中 | 命中性质 |
|---|---|---|
| `src/main/index.ts` | 4（desktop）+ 1（tests/e2e 文本读取） | 注释 / 文本扫描 |
| `ipc.ts` | 15（desktop）+ 1（scripts/audit）+ 1（tests/e2e） | 注释 / 文档 |
| `config.ts` | 2（desktop）+ 1（tests/e2e 文本读取） | 注释 / 文本扫描 |
| `menu.ts` | 2（desktop） | 注释 |
| `runtime.ts` | 3（desktop）+ 2（tests/e2e） | 注释 |
| `devtools.ts` | 2（desktop，其中 1 处是**真 import**） | 见 §6.1 |
| `errors.ts` | 4（desktop，其中 3 处是**真 import**）+ 1（build-bridge.mjs 注释） | 见 §6.1 |
| `theme.ts` | **0** | —— |
| `shortcuts.ts` | **0** | —— |

### 6.3 `src/core/**` 对旧前端的引用：**0**

```powershell
Get-ChildItem -Recurse -File src/core | Select-String -Pattern "renderer|preload"   # 无输出
```

core 引擎完全不含旧前端依赖 —— 这是"可以放心删渲染层"的最强证据。

### 6.4 全仓唯一"读取旧源码文本"的测试：1 个文件

```
tests\e2e\50-status-recheck.mjs:86:  const src  = await read('src/main/config.ts');
tests\e2e\50-status-recheck.mjs:93:  const ipc  = await read('src/main/ipc.ts');
tests\e2e\50-status-recheck.mjs:223: const main = await read('src/main/index.ts');
```

其余 `tests/e2e/**` 对旧前端的提及均为注释（如 `30-robustness.mjs:8`、`32-stop-verify.mjs:4`），且 `tests/e2e/_bundle.mjs` 证明该套测试通过 esbuild 打包 **core** 后在进程内运行（不启动 Electron、不 import electron）。

### 6.5 两份废弃设计文档的入链（共 6 处，含 1 处"故意引用"）

```
docs\design\winui3-visual-spec.md:8                  ← 故意的"已废弃"声明，应保留
docs\guide\02-quickstart.md:166                      ← 需改写
docs\review\frontend-survey-for-winui3.md:415        ← 本轮输入证据，建议加"已废弃"标注
docs\review\winuinav-migration-assessment.md:679     ← 同上
README.md:386,387                                    ← README 将整体改写
```

（另有 14 处命中是这两份文档**内部**的自引用，随文件一起消失。）

### 6.6 执行前必跑的反查命令（**复制即用**）

```powershell
cd F:\WhalesLauncher
# ① 运行时 import 反查：期望输出恰好 4 行（§6.1）——多一行就说明桥接层又引入了 src/main 依赖，先停下
Get-ChildItem -Recurse -File desktop,scripts/audit,tests,src/core,src/shared |
  Where-Object { $_.FullName -notmatch '\\(bin|obj|node_modules)\\' -and $_.Extension -in '.mjs','.cjs','.ts','.cs' } |
  Select-String -Pattern "from\s+['""][^'""]*src/main/[^'""]*['""]|require\(\s*['""][^'""]*src/main/"

# ② core 不含旧前端引用：期望无输出
Get-ChildItem -Recurse -File src/core | Select-String -Pattern 'renderer|preload'

# ③ 行数口径复核（不要用 Get-Content | Measure-Object -Line）
[System.IO.File]::ReadAllLines((Resolve-Path 'src/main/ipc.ts').Path).Count   # 期望 743
```

---

## 7. 执行顺序建议（5 步，每步可验证、可回滚）

> 原则：**先切断"指向待删文件的入口"，再删文件**。顺序颠倒会出现"删了脚本但 `npm install` 里还挂着它"这类难以归因的故障。

### 步骤 0 —— 基线与安全网
```powershell
cd F:\WhalesLauncher
git status --short            # 确认工作树状态已知；新前端代码应先提交，保证拆除 diff 干净可读
git rev-parse HEAD            # 记下本次拆除的基线 commit（本文写作时为 a239e77a…）
```
**验证**：先给新前端落一个 commit（拆除与功能开发混在一个 commit 里会让回滚粒度失控）。

### 步骤 1 —— 先改配置入口（本步不删任何代码文件）
改 `package.json`：删 `main` 字段、删 `postinstall`/`setup:electron`、`build` 改指 `build-bridge.mjs`、新增 `build:bridge` 与 `smoke:bridge`、删 `shots:tutorial`；`devDependencies` 去掉 `electron`。

```powershell
npm install                                   # 重建 package-lock.json（此时 postinstall 已摘掉）
node scripts/build-bridge.mjs                 # 旧入口脚本仍在，但不再被 package.json 引用
dotnet build 'desktop\src\WhalesLauncher.App\WhalesLauncher.App.csproj' -c Debug
```
**验证**：`npm install` 退出码 0；`dist/bridge/server.cjs` 存在且大小合理（≈430 KB）；C# 侧 0 错误。

### 步骤 2 —— 删渲染层与 preload（最大一块，15 260 行）
```powershell
git rm -r src/renderer src/preload
node scripts/build-bridge.mjs                 # 必须仍然成功（core 不依赖它们）
node scripts/audit/bridge-smoke.mjs           # 桥接端到端仍通过
node tests/e2e/00-smoke.mjs                   # core 契约形状仍通过
```
**验证**：三条命令退出码 0。

### 步骤 3 —— 删 Electron 主进程（**保留 `errors.ts` 与 `devtools.ts`**）
```powershell
git rm src/main/index.ts src/main/ipc.ts src/main/config.ts src/main/menu.ts `
       src/main/runtime.ts src/main/theme.ts src/main/shortcuts.ts
node scripts/build-bridge.mjs                 # 关键回归：两个被 import 的文件必须仍在
node scripts/audit/bridge-smoke.mjs
node tests/core/run-all.mjs
```
**验证**：
```powershell
Get-ChildItem src/main -File | Select-Object -ExpandProperty Name   # 期望恰好：devtools.ts、errors.ts
```
`build-bridge.mjs` 的 `checkSyntax()` 不应再报"源文件缺失"。

### 步骤 4 —— 删旧测试、旧脚本与旧产物；改写启动入口
```powershell
git rm -r tests/dist scripts/build.mjs scripts/launch.mjs scripts/setup-electron.mjs scripts/make-tutorial-shots.mjs
Remove-Item -Recurse -Force dist/main, dist/preload, dist/renderer   # 构建产物，未入库
node scripts/build-bridge.mjs                 # 必须重建出 dist/bridge/server.cjs
```
**改写**（**不是删除**）双击启动链：`WhalesLauncher.vbs`、`启动 WhalesLauncher.bat`、`创建桌面快捷方式.bat`、`scripts/make-shortcut.ps1` → 目标改为新 `WhalesLauncher.exe`（§9 #2）。
并处理 §9 #1 的 `tests/e2e/50-status-recheck.mjs`。

**验证**：`node tests/e2e/run-all.mjs` 通过；双击 `.bat` 与桌面快捷方式，确认新 exe 正常启动。

### 步骤 5 —— 文档收尾
1. 改写 `README.md`（403 行，当前描述 Electron 架构、`npm run build`/`launch`、`dist/main/index.cjs` 入口）；
2. 改写 `docs/design/architecture.md`（322 行，主进程/preload/renderer 三层 → C# 宿主 + Node 侧车）；
3. 删除 `docs/design/ui-redesign.md`、`docs/design/ui-acceptance-criteria.md`，并修 4 处入链（§6.5）；
4. 修 `docs/guide/07-troubleshooting.md:118-119` 对 `src/renderer/PREVIEW.md` 的失效链接；
5. 更新 `docs/design/winui3-impl-brief.md:12`（事实来源表述）；
6. `docs/guide/**` 保留但标注"截图对应旧界面，待重拍"。

**验证**（应只剩历史文档中的"已废弃"标注）：
```powershell
Get-ChildItem -Recurse -File docs,README.md | Select-String -Pattern 'src/renderer|src/preload|dist/main'
```

### 全流程收尾验证命令（逐条跑并留档）

```powershell
$env:DOTNET_NOLOGO=1; $env:DOTNET_CLI_UI_LANGUAGE='en-US'   # zh-CN 会把 XAML 真实错误吞成误导性的 WMC9999
node scripts/build-bridge.mjs
node scripts/audit/bridge-smoke.mjs
node tests/core/run-all.mjs
node tests/e2e/run-all.mjs
& 'C:\Program Files\dotnet\dotnet.exe' build 'F:\WhalesLauncher\desktop\src\WhalesLauncher.App\WhalesLauncher.App.csproj' -c Debug
# 冷启动冒烟：双击 启动 WhalesLauncher.bat → 界面出现 + 任务管理器可见侧车 node.exe
```

---

## 8. 不可逆性与回滚

- **基线 commit**：`a239e77a28e4f07a66abda0287c14cc27d657e96`（`git rev-parse HEAD`，分支 `winui3-rewrite`）。
- 所有 `git rm` 的删除都在索引与历史里，可按路径精确恢复：

```powershell
git checkout a239e77a28e4f07a66abda0287c14cc27d657e96 -- src/renderer src/preload src/main/index.ts src/main/ipc.ts
# 或整体回退（会一并丢掉新前端改动，谨慎）
git revert <拆除 commit>
```

- **只删不 commit** 的中间态同样可恢复：`git restore --staged --worktree <path>`。
- **不在 git 里的东西**（删了就真没了，必须先确认）：
  - `dist/main|preload|renderer/**`、`.spike/qa-build/**`（构建产物，可重建）；
  - `.backup/pre-fluent2-20260921-112817/**`（本机快照，**未入库**）→ 若要留档，拆除前先复制到仓库外；
  - `.probe/**`、`.fluent-b64/**`、`快捷方式/**`、`debug.log`（本机取证/临时物）。

---

## 9. 暂缓 / 需人工确认清单（12 项）

**判定标准**：证据显示"删了会破坏用户可见能力或丢失不可再生信息"，或"必须改写而非删除"。**未列入 §2 的一律不要删。**

| # | 项 | 为什么暂缓 | 建议动作 |
|---|---|---|---|
| 1 | `tests/e2e/50-status-recheck.mjs` | 唯一在运行时**文本读取** `src/main/{config,ipc,index}.ts` 的测试（§6.4）；删源码后它会抛文件不存在 | 改造成只校验契约 + 桥接行为（其"源码一致性"断言已无意义），或退役 |
| 2 | `WhalesLauncher.vbs` + `启动 WhalesLauncher.bat` + `创建桌面快捷方式.bat` + `scripts/make-shortcut.ps1`（168 行） | **用户可见能力**：双击启动与桌面快捷方式。当前指向 `node_modules\electron\dist\electron.exe`（`make-shortcut.ps1:45`）与 `npm start` | **必须改写指向新 exe**，不可裸删（§9.1） |
| 3 | `scripts/record/record.mjs`（671 行） | 工具本身与前端无关（ffmpeg ddagrab 采集桌面），但 R1–R10 镜头清单按旧 UI 编写 | 保留工具，重写清单后再启用 `rec*` 脚本 |
| 4 | `docs/design/architecture.md`（322 行） | 描述的是 Electron 三层架构（`main/preload/renderer` + esbuild 单步打包），与新架构不符，但它是唯一的架构总览 | 改写为「C# 宿主 + Node 侧车 + core」，不要删 |
| 5 | `docs/design/port-allocation.md` | 主体是 core 的端口分配设计（**仍然有效**），仅 2 处引用渲染层 | 保留，改 2 处引用 |
| 6 | `docs/guide/**`（8 份） | 描述的是应用功能（实例/引擎/插件/隔离），功能未变；但截图与个别链接过时 | 保留 + 更新（§7 步骤 5） |
| 7 | `docs/assets/**`（27 个 PNG，含 23 张教程截图） | 全部是旧 UI 截图，但被 `docs/guide/**` 与 README 引用；属"不可再生的历史素材" | 建议保留为历史（或重拍后替换），**不要先删** |
| 8 | `docs/video/promo-plan-v1.md` | 宣传片镜头表引用旧 UI 行号（`src/renderer/views/*.ts`）与旧截图 | 归档或改写 |
| 9 | `docs/review/{acceptance,code-review,final-status}.md` | 旧前端那一轮的验收/评审记录，是"当时为什么这么写"的证据 | 建议保留（可移入 `docs/review/archive/`） |
| 10 | `README.md`（403 行） | 全文按 Electron 项目写（安装/构建/启动/目录树），必须重写但不能删 | 步骤 5 改写 |
| 11 | `.backup/`、`.fluent-b64/` | 本轮本机快照与 Fluent 令牌取证素材；**未入库、也未 ignore** | 决定"入库 / ignore / 删除"三选一（§5.2），拆除前先确认是否需要留档 |
| 12 | `.spike/`、`.probe/`、`快捷方式/`、`cache/`、`logs/`、`engines/`、`instances/`、`shared/`、`debug.log`、`launcher.json` | 本机运行数据与实验区，多数已 ignore；**不属于"旧前端设计"**，但确实是"本轮之后不再需要"的噪声 | 运维级清理，与代码拆除分开做（避免把用户数据 `instances/`、`engines/` 误当垃圾删掉） |

### 9.1 风险最高的三条

1. **`src/main/errors.ts` 与 `src/main/devtools.ts` 被"顺手"一起删掉。**
   两个文件 100% 长在待删目录里，却分别被 3 个和 1 个桥接模块运行时 import（§6.1）；删掉的后果是**构建期**直接失败（`build-bridge.mjs` 的 `checkSyntax()` 报"源文件缺失"），或被误判成"桥接层重构"而浪费排查时间。`devtools.ts` 尤其阴险：它是在桥接层新增 `menu.mjs` 时才被引入的，任何"早一轮做过、结论是 REF=0"的判断都会漏掉它。
   → **若要彻底清空 `src/main/`**：把这两个文件移到 `src/core/`（或 `src/shared/`），同步改 4 处 import + `build-bridge.mjs:18` 的注释，然后再删空目录。**另开一步做，不要混在步骤 3 里。**

2. **双击启动 / 桌面快捷方式链**（§9 #2）。
   `make-shortcut.ps1` 硬编码 `node_modules\electron\dist\electron.exe`；`scripts/launch.mjs` 硬编码 `dist/renderer`、`dist/main`。步骤 1 摘掉 `launch`/`start` 后，若不同期改写启动器，用户手里剩下的是**指向已删除 Electron 的 .bat / .vbs / 旧 .lnk** —— 界面验收全绿，但"双击没反应"，且旧快捷方式不会自动失效。

3. **`dist/` 整体删除或删后忘记重建 bridge**。
   `dist/bridge/server.cjs` 是新前端的运行时依赖，`.csproj` 用 `Exists('...\dist\bridge')` 作为复制条件 —— 它不存在时**构建仍然成功**（静默跳过复制），故障延迟到运行时才表现为"双击后界面报后端已断开"。而 `npm run clean` 恰好会删掉整个 `dist`。

---

## 10. 计数汇总

| 类别 | 数量 | 说明 |
|---|---|---|
| **待删项** | **18** | §2 表：7 个 `src/main` 文件 + `src/preload/**` + `src/renderer/**` + `tests/dist/**` + 4 个旧构建脚本 + `dist/` 旧产物 + 2 份废弃设计文档 + electron 依赖 |
| 待删代码量 | **≈19 842 行** | 15 119（renderer）+ 2 428（main 7 文件）+ 141（preload）+ 809（tests/dist）+ 1 345（4 个旧脚本）；另加废弃文档 2 583 行、未入库旧产物 24 182 行 |
| **保留项** | **17** | §3 表（含两个高危误删项：`src/main/errors.ts`、`src/main/devtools.ts`） |
| **暂缓 / 需人工确认** | **12** | §9 表 |
| 其中"必须改写而非删除" | 5 | 启动器链、`README.md`、`architecture.md`、`docs/guide/**`、`record.mjs` |

**拆除后预期残留**：`src/` 下只剩 `core/`（16 文件）+ `shared/contracts.ts` + `main/{errors,devtools}.ts`（或按 §9.1-① 迁走后彻底没有 `main/`）。
