# 旧前端残余清单（WinUI 3 重构后）

> **本文件只出清单，不执行任何删除。** 删除动作由 Lead 复核后统一执行。
>
> 盘点对象：`src/main/**`、`src/preload/**`、`src/renderer/**` 在 commit `ed93af9` 物理删除后，
> 全仓库仍然存在的旧前端残余。
>
> 扫描时间基线：仓库 HEAD = `ed93af9`（`git log --oneline -3` → `ed93af9` / `8690343` / `a239e77`）。
>
> ⚠ **工作树是活的**：本轮调查**进行中**，另一名 teammate 正在并行修改本仓库。
> 调查开始时 `git status --short` 为干净；结束时出现以下**他人改动**（**非本审计所为**）：
>
> ```
>  M WhalesLauncher.vbs
>  M 启动 WhalesLauncher.bat
> ?? scripts/launch-app.ps1          (6856 B, 2026-09-21 18:56)
> ?? scripts/test/lib/fixtures.mjs   (6408 B, 18:54)
> ?? scripts/tutorial/demo-home.mjs  (14727 B, 18:55)
> ?? scripts/tutorial/verify-home.mjs(5388 B, 18:55)
> ?? docs/cleanup/                   ← 本文件
> ```
>
> 本审计**只写了 `docs/cleanup/legacy-residue-inventory.md`**，未触碰其它任何文件。
> 下表凡涉及 `WhalesLauncher.vbs` / `启动 WhalesLauncher.bat` 的条目，已按**改动后**的现状复核并就地标注。

---

## 0. 方法与机械证据定义

全部结论来自**只读**手段，不使用"看起来像旧的"作为依据。

| 证据类型 | 取得方式 | 说明 |
|---|---|---|
| 引用计数 | `grep -R` 全仓库正则命中 + 行号 | 排除 `node_modules/`、`.git/`、`bin/`、`obj/`、`dist/`、`.probe/`、`.spike/`、`.backup/`、`.fluent-b64/`、`.npm-cache/`、`.pnpm-store/`、`instances/`、`engines/`、`logs/`、`cache/`、`快捷方式/` |
| 存在性 | `Test-Path` 逐条实测 | 区分"指向已删文件"与"指向仍存在文件" |
| 编码缺陷 | Python 3.12 全文件 `decode('utf-8')` + Latin-1/CP936/CP1252 往返测试 | 见 §3 |
| 通道覆盖 | 从 `contracts.ts` 的 `CH` 块提取 39 条通道字面量，与 `desktop/bridge/**` 的 `CH.<g>.<n>` 引用求差集 | 见 §4.2 |
| 构建期断言 | 读 `scripts/build-bridge.mjs:118-141` 的 esbuild `--metafile` 模块图断言 | 见 §4.4 |

**扫描规模**：212 个文本文件（`.md` / `.json` / `.mjs` / `.cjs` / `.ps1` / `.cs` / `.xaml` / `.ts` / `.yml` / `.gitignore` / `.npmrc` / `.csproj` / `.bat` / `.vbs` / `.txt` 等）。

**已删除路径实测**（`Test-Path`，全部为 `False`）：

```
src\main          src\preload        src\renderer
scripts\build.mjs scripts\launch.mjs scripts\setup-electron.mjs
scripts\make-tutorial-shots.mjs       scripts\record
```

**仍存在但属旧链路的路径**（`Test-Path` = `True`）：

```
tests\dist\**（3 文件）        docs\assets\screenshot-*.png（4 张）
scripts\make-shortcut.ps1      WhalesLauncher.vbs / 启动 WhalesLauncher.bat
docs\assets\tutorial\*.png（23 张，生成器已删）   dist\bridge\server.cjs（新链路产物，必须保留）
```

---

## 1. 乱码缺陷（实测结论：**不存在**）

### 1.1 ⚠ 任务书第 6 条「已实测缺陷」经复核**不成立**

任务书称 `desktop/src/WhalesLauncher.App/WhalesLauncher.App.csproj`（第 17–21 行附近）与
`package.json`（`description` 字段）存在「UTF-8 被按 ANSI 解码后重新写回」的 mojibake 乱码。
**逐项复核后判定：两个文件都是合法 UTF-8，没有任何乱码。**

原始字节证据（`repr()` 直读，未经任何解码工具转写）：

```
CSPROJ 第 15 行: b'    <!-- unpackaged\xef\xbc\x9a\xe5\x85\x8d\xe9\x99\xa4 MSIX \xe7\xad\xbe\xe5\x90\x8d...'
CSPROJ 第 17 行: '         取舍说明见 docs/design/winui3-visual-spec.md 与最终交付报告「遗留问题」一节。 -->'
CSPROJ 第 33 行: '  <!-- 桥接脚本随应用分发：C# 侧在启动时以 node 拉起 dist/bridge/server.cjs -->'
PACKAGE.JSON 第 5 行: '"description": "WhalesLauncher —— DeepSeek Harness (dsh) 的实例与版本管理启动器（WinUI 3 前端 + Node 侧车业务引擎）",'
```

四项机械判据（全部指向"非乱码"）：

| 判据 | csproj | package.json | 乱码应有表现 |
|---|---|---|---|
| `bytes.decode('utf-8')` | OK | OK | — |
| 往返 `text.encode('gbk').decode('utf-8')` | `UnicodeDecodeError`（不可逆） | 同左 | 乱码必然可逆 |
| 往返 `text.encode('cp1252'/'latin-1').decode('utf-8')` | `UnicodeEncodeError`（不可逆） | 同左 | 乱码必然可逆 |
| 完好 CJK 字符数 | 50 | 19 | 乱码会**丢失全部 CJK** |
| `Ã` / `Â` / `â€` 标记字符数 | 0 | 0 | 乱码必然有 `Ã`/`Â` 前导对 |
| UTF-8 CSPROJ 中 `[C2C3][80-BF]` 前导字节对 | 0 | 0 | — |

**Git 历史反证**：`git log -1 -- .../WhalesLauncher.App.csproj` → `8690343`（拆除前快照），
`git show 8690343:...csproj` 的中文注释显示正常；该文件**自上一次提交起从未被改写**，不存在"被 ANSI 重新写回"的时间窗。
`package.json` 同理（`git log -1` → `ed93af9`，`git show 8690343:package.json` 正常）。

**全仓库编码扫描**（212 个文本文件）：

```
NOT-UTF8 / 读错误文件数 : 0
U+FFFD（替换字符）出现 : 0
```

**关于"乱码观感"的可能来源**（仅供 Lead 判断，非本清单结论）：本项目**确实有两处文件被刻意要求纯 ASCII**，
并在注释里记录了历史上真实发生过的乱码事故——这很可能是第 6 条缺陷的误报来源：

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `WhalesLauncher.vbs:13-18` | `'  !! PURE ASCII ONLY - THIS FILE MUST CONTAIN ZERO NON-ASCII BYTES. !!` `'  WSH reads .vbs as ANSI (code page 936 here), so UTF-8 Chinese in a` `'  comment decodes into stray bytes - measured: it turned into a syntax` `'  error at "end of statement expected" ...` | 文档陈旧 | 保留 | 这是**已修复事故的防护性记录**，不是缺陷。文件当前实测纯 ASCII |
| `启动 WhalesLauncher.bat:11-17` | `rem  !! THIS FILE MUST STAY PURE ASCII. !!` … `rem  page, and a "chcp 65001" line inside the file does NOT re-read what` `rem  follows. UTF-8 Chinese in a batch body therefore arrives as mojibake` | 文档陈旧 | 保留 | 同上，防护性记录；文件当前实测纯 ASCII |
| `创建桌面快捷方式.bat:31-36` | `rem NOTHING non-ASCII may appear in this file, comments included. Three separate` … `rem here all ended the same way: cmd truncated the rem line at the UTF-8 bytes` | 文档陈旧 | 保留 | 同上 |
| `desktop/build-app.ps1:23-24` | `NOTE: ASCII-only by design. PowerShell 5.1 reads .ps1 files as ANSI, so non-ASCII` `characters in this file (Chinese comments, etc.) would be mis-decoded into syntax errors.` | 文档陈旧 | 保留 | 同上 |

> **结论**：§3 的「乱码缺陷」分类在本轮盘点中**条目数为 0**。
> 若 Lead 在别的工具里看到乱码，应优先怀疑**读取方工具的编码设置**（例如用 PS 5.1 `Get-Content` 无 `-Encoding UTF8`），
> 而不是文件本身 —— 文件本身已用字节级证据排除。

---

## 2. 死引用清单（文件系统可验证：目标已不存在）

> ### ⚠ 先读这一条：本节的"根入口硬失败"已由并行 teammate 修复
>
> 本轮调查**开始时**，项目根目录的两个入口 + 快捷方式脚本是**确定坏的**（`scripts/launch.mjs` 被删，
> 三个人口仍在调它）。调查过程中，另一名 teammate 引入了 `scripts/launch-app.ps1` 并改写了三处调用方。
> **下列 7 行现已消解，Lead 不必重复处理**（保留在表中是为了留痕与解释为何曾坏）：
>
> | 已修复项 | 修复后证据 |
> |---|---|
> | `WhalesLauncher.vbs` | `:42` → `scripts\launch-app.ps1`；`:71` 改为 `powershell.exe … -File … -Wait` |
> | `启动 WhalesLauncher.bat` | `:38` → `powershell.exe … -File "%~dp0scripts\launch-app.ps1" %*` |
> | `scripts/make-shortcut.ps1` | `:46` 改用 `assets\whales.ico`（实测 20,007 B 存在）；删除 Electron 硬等待分支，改为 `:54-60` 的 `$appBuilt` 软警告 |
>
> **也就是说：本节剩余**待处理**的死引用集中在 `tests/**`（12 处，见 §4.7）与 `README.md` / `docs/guide/**`（见 §5.2）。**

### 2.1 代码级死引用（会导致运行时报错，**优先级最高**）

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `WhalesLauncher.vbs:34`（**改动前**） | `launcher = scriptDir & "\scripts\launch.mjs"` | 死引用 | ~~修正~~ **已由他人修复** | 调查开始时该行为硬失败源。**现已改为** `:42 launcher = scriptDir & "\scripts\launch-app.ps1"`，并在 `:17-21` 留下说明「This file used to run "node scripts\launch.mjs" … launch.mjs was deleted. Calling it produced a message box saying "scripts\launch.mjs is missing" on every shortcut launch.」→ **本条已消解，无需再动** |
| `WhalesLauncher.vbs:82`（**改动前**） | `cmd = "cmd /c node """ & launcher & """ --quiet --log=""" & logFile & """ > """ & consoleFile & """ 2>&1"` | 死引用 | ~~修正~~ **已由他人修复** | **现已改为** `:71 cmd = "cmd /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """ -Wait > """ & consoleFile & """ 2>&1"` → 本条已消解 |
| `启动 WhalesLauncher.bat:34`（**改动前**） | `node "scripts\launch.mjs" %*` | 死引用 | ~~修正~~ **已由他人修复** | **现已改为** `:38 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-app.ps1" %*`，`scripts/launch-app.ps1:66-74` 实测用 `Get-ChildItem -Recurse -Filter 'WhalesLauncher.exe'` 定位新 exe → 本条已消解 |
| `创建桌面快捷方式.bat:42` | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"` | 死引用 | 修正 | 本行本身路径正确（`make-shortcut.ps1` 仍存在），**但被调脚本内部仍在硬等 Electron** → 见下两行（**尚未修复**） |
| `scripts/make-shortcut.ps1:45`（**改动前**） | `$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'` | 死引用 | ~~修正~~ **已由他人修复** | 调查开始时此处硬等 Electron（`package.json` 已无该依赖）。**现已删除该变量**：当前 `:46 $ico = Join-Path $root 'assets\whales.ico'`，并在 `:27` 留说明「it used to fall back to electron.exe, which no longer exists here」 |
| `scripts/make-shortcut.ps1:52-53`（**改动前**） | `if (-not (Test-Path -LiteralPath $electron)) {` `[Console]::Error.WriteLine("Electron runtime not found: $electron")` | 死引用 | ~~修正~~ **已由他人修复** | **现已删除该硬失败分支**，改为 `:54-60` 的「未构建也允许建快捷方式，只警告不拒绝」逻辑（`$appBuilt` 探测 `desktop\src\WhalesLauncher.App\bin` 下的 `WhalesLauncher.exe`）→ 本条已消解 |
| `scripts/make-shortcut.ps1:18`（**改动前**） | `#  All Chinese that must reach the user is printed by scripts\launch.mjs` | 死引用 | ~~修正~~ **已由他人修复** | **现已改为** `:18 #  All user-facing text is English: scripts\launch-app.ps1 (launched by` → 指向正确的新脚本 |
| `scripts/make-shortcut.ps1:22-25`（**改动前**） | `#    * the shortcut points at wscript.exe + WhalesLauncher.vbs, NOT at` … `#      scripts/make-icon.mjs), else falls back to electron.exe;` | 死引用 | ~~修正~~ **已由他人修复** | **现已改为** `:27 #      it used to fall back to electron.exe, which no longer exists here;` → 已从"活描述"降级为"历史说明"，措辞正确 |
| `README.md:169` | `` `postinstall` 会自动执行 `scripts/setup-electron.mjs`：若 `electron` 自身的 postinstall `` | 死引用 | 修正 | `package.json` 已无 `postinstall`（实测 `scripts` 段仅 11 项，无 `postinstall`），`scripts/setup-electron.mjs` 已删 |
| `README.md:199` | `` 三个入口都走同一份实现（[`scripts/launch.mjs`](scripts/launch.mjs)），做事顺序一致： `` | 死引用 | 修正 | **Markdown 相对链接指向已删文件** → 渲染为死链 |
| `README.md:201` | `` 1. **环境自检** —— 确认 `node_modules/electron/dist/electron.exe` 到位；缺失时只用本机缓存离线修复（`scripts/setup-electron.mjs`），绝不联网；`` | 死引用 | 修正 | 双重死引用（目录 + 脚本均不存在） |
| `README.md:263` | `└── setup-electron.mjs    # 离线铺设 Electron 运行时` | 死引用 | 修正 | 目录树清单列出已删脚本 |
| `README.md:243` | `` > **教程截图是可复现的**：`npm run shots:tutorial` 会用无头 Chromium + CDP 驱动渲染层， `` | 死引用 | 修正 | `npm run shots:tutorial` 已从 `package.json` 移除（实测 `scripts` 无此项） |
| `README.md:185-186` | `npm run launch    # 按需构建后启动（等价于双击下面的 .bat）` / `npm start         # 强制重建后启动` | 死引用 | 修正 | `package.json` 的 `scripts` 段实测**无** `launch`、无 `start` → 两条命令均报 `Missing script` |
| `README.md:201`（同 201 行链） | 参见上一行 | 死引用 | 修正 | 合并计 1 处 |
| `README.md:222` | `` > 入口仍是 `dist/main/index.cjs`，与现在完全一致。 `` | 死引用 | 修正 | `dist/main` 已不存在（产物已清），入口现在是 `desktop/src/WhalesLauncher.App/bin/**/WhalesLauncher.exe` |
| `README.md:333` | `` 3. **产物加载验证**：`node tests/dist/verify-dist.cjs` 直接 `require` 真实产物（替身 electron）， `` | 死引用 | 修正 | 该脚本仍存在但 `require(dist/main/index.cjs)` 的目标已删 → 脚本必然失败（详见 §5） |
| `README.md:343-345` | `node tests/dist/verify-dist.cjs         # 产物可加载性 + 静态资源 SHA256 对账` / `node tests/dist/node-runtime-check.cjs  # Node 运行时探测 + nodePath 配置（自动还原 launcher.json）` / `node tests/dist/qr08-check.cjs          # 引擎体积惰性计算` | 死引用 | 修正 | 三条命令是 README「回归命令」清单的一部分，断言对象为旧产物（详见 §4.7） |
| `README.md:346-347` | `node .spike/smoke/run.mjs               # 渲染层交互冒烟（演示模式，exit 0 为通过）` / `node .spike/smoke/real-mode.mjs         # 渲染层真实桩冒烟（28 项）` | 死引用 | 修正 | **渲染层冒烟脚本已随 `src/renderer/**` 消失**（`src/renderer/data/demo.ts` 演示数据模式已删）；`.spike/` 在排除清单内未核查，但脚本语义已无对象 |
| `README.md:349` | `npm run launch -- --dry-run             # 启动链路自检（环境 + 按需构建判定，不开窗口）` | 死引用 | 修正 | `npm run launch` 已不存在（`package.json` 无 `launch`） |
| `README.md:353-356` | `` > QA 产物，体积 24 MB），所以上面两条渲染层冒烟命令**只在原始开发机上可用**，clone 下来的仓库没有这个目录。 `` … `` > 在原开发机上，`.spike/smoke/node_modules` 是 **jsdom 的唯一安装位置**（未声明在 `package.json`）， `` | 死引用 | 修正 | 整段为渲染层冒烟的说明，随上两条命令一并失效 |
| `docs/guide/07-troubleshooting.md:118` | `` **原因**：用浏览器直接打开了 `dist/renderer/index.html`（渲染层可以脱离后端独立预览， `` | 死引用 | 修正 | `dist/renderer` 已删；该"故障原因"在新架构下不可能发生 |
| `docs/guide/07-troubleshooting.md:119` | `` 见 [`src/renderer/PREVIEW.md`](../../src/renderer/PREVIEW.md)），或者 preload 没加载成功。 `` | 死引用 | 修正 | **Markdown 相对链接指向已删文件** → 死链。`legacy-teardown-plan.md:319` 已点名此处需改写（`docs/guide/**` 归另一名 teammate，本清单只登记） |
| `docs/guide/07-troubleshooting.md:141` | `` > 该缺陷已修复（`src/renderer/router.ts` + `src/renderer/index.ts` 调整启动顺序）， `` | 死引用 | 修正 | 指向已删源码文件，读者会照着去找 |
| `docs/guide/01-install.md:74` | `` `npm install` 结束时会自动跑 `postinstall`（`scripts/setup-electron.mjs`）： `` | 死引用 | 修正 | 同 `README.md:169`：`postinstall` 与脚本均已不存在 |
| `docs/guide/01-install.md:102` | `` 三个入口走的是**同一份实现**（[`scripts/launch.mjs`](../../scripts/launch.mjs)），做的事顺序一致： `` | 死引用 | 修正 | **Markdown 相对链接指向已删文件** → 死链 |
| `docs/guide/README.md:17` | `` 本文所有界面截图由 [`scripts/make-tutorial-shots.mjs`](../../scripts/make-tutorial-shots.mjs) **自动生成**，可随时重跑复现： `` | 死引用 | 修正 | **相对链接死链**；且"可随时重跑复现"的承诺已不成立 |
| `docs/guide/README.md:21-22` | `node scripts/make-tutorial-shots.mjs          # 重新生成 docs/assets/tutorial/*.png` / `node scripts/make-tutorial-shots.mjs --list   # 查看全部截图场景` | 死引用 | 修正 | 两条命令均指向已删脚本 |
| `docs/review/final-status.md:129` | `` \| [`scripts/launch.mjs`](../../scripts/launch.mjs) \| 三个入口**共用**的实现：环境自检 / 按需构建 / 启动 / 诊断 \| `` | 死引用 | 修正 | **相对链接死链**（`docs/review/**` 属历史评审记录，见 §6） |
| `docs/research/dsh-interface.md:246` | `` - Electron 41.1.0 二进制由 `%LOCALAPPDATA%\electron\Cache` 中的发行包离线铺设，脚本见 `scripts/setup-electron.mjs`。 `` | 死引用 | 修正 | 指向已删脚本 |
| `.npmrc:21-24` | `# Do NOT set electron_mirror here.` `# The Electron binary cache (%LOCALAPPDATA%\electron\Cache) keys its entries by` `# ... Use \`node scripts/setup-electron.mjs\` instead.` | 死引用 | 修正 | 指向已删脚本（第 24 行）；Electron 已从依赖移除，该提醒已无对象 |
| `tests/e2e/50-status-recheck.mjs:86` | `const src = await read('src/main/config.ts');` | 死引用 | 修正 | **运行时报错源**：`read()` 无 `.catch`（第 21 行 `const read = (rel) => fs.readFile(path.join(REPO_ROOT, rel), 'utf8')`）→ ENOENT 抛到模块顶层 |
| `tests/e2e/50-status-recheck.mjs:93` | `const ipc = await read('src/main/ipc.ts');` | 死引用 | 修正 | 同上 |
| `tests/e2e/50-status-recheck.mjs:223` | `const main = await read('src/main/index.ts');` | 死引用 | 修正 | 同上 |
| `tests/e2e/50-status-recheck.mjs:207` | `await walk(path.join(REPO_ROOT, 'src', 'renderer'));` | 死引用 | 修正 | 该目录已删 → `fs.readdir` ENOENT |
| `tests/e2e/20-contract-and-dsh.mjs:80` | `const preloadSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'preload', 'index.ts'), 'utf8');` | 死引用 | 修正 | 模块作用域无 try/catch → 抛异常 |
| `tests/e2e/20-contract-and-dsh.mjs:136` | `const ipcSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'ipc.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/30-robustness.mjs:421` | `const mainSrc = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/30-robustness.mjs:428` | `const ipcSrc = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/30-robustness.mjs:451` | `await walk(path.join(process.cwd(), 'src', 'renderer'));` | 死引用 | 修正 | 目录已删 → 抛异常 |
| `tests/e2e/30-robustness.mjs:497` | `const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/30-robustness.mjs:502` | `const domSrc = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'util', 'dom.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/40-core-deep.mjs:120` | `const mainIpc = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'ipc.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/40-core-deep.mjs:133` | `await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8'),` | 死引用 | 修正 | 同上 |
| `tests/e2e/42-config-heal.mjs:27` | `const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'config.ts'), 'utf8');` | 死引用 | 修正 | 同上 |
| `tests/e2e/52-broken-record-cleanup.mjs:119` | `await walk(path.join(process.cwd(), 'src', 'renderer'));` | 死引用 | 修正 | 同上 |
| `tests/dist/verify-dist.cjs:6` | `` * 本脚本用替身 electron 直接 `require(dist/main/index.cjs)`，能在 1 秒内抓住 `` | 死引用 | 删除 | 见 §5：脚本整体已失效 |
| `tests/dist/qr08-check.cjs:8` | 引 `dist/main/index.cjs` | 死引用 | 删除 | 同上 |
| `tests/dist/node-runtime-check.cjs:55` | 引 `dist/renderer/index.html` | 死引用 | 删除 | 同上 |

### 2.2 注释级 / 溯源级死引用（不影响编译与运行，属"可留痕"）

任务书第 4 条称交付报告说"仍有 9 处注释级历史路径引用 `src/main`"。**实测口径不同**：
按 `src[\\/]main` 正则全仓库统计，注释级引用共 **26 个文件 / 128 处**；
其中 `desktop/**` 的 C# 溯源注释为 **9 处**（与交付报告一致），
其余分布在 `docs/**`（历史文档）与 `tests/**`（测试注释）。

`desktop/**` 的 9 处（与交付报告口径吻合，构成机械证据）：

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `desktop/src/WhalesLauncher.App/Models/CreateInstanceInput.cs:8` | `/// 由 Node 侧 <c>parseCreateInput</c>（<c>src/main/ipc.ts:646</c>）按"未提供"处理并填默认值。` | 死引用 | 保留 | `<c>` 是纯文本非 `cref`，不影响编译；是"参数形状从何而来"的唯一线索 |
| `desktop/src/WhalesLauncher.App/Models/InstanceFolderValues.cs:7` | `/// 校验逻辑在 <c>src/main/ipc.ts</c> 的 <c>openInstanceFolder()</c>（未知值报错并列出可选值）。` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Models/PluginSource.cs:10` | `/// 校验在 Node 侧 <c>mustPluginSource</c>（<c>src/main/ipc.ts:600</c>）执行，未知 kind 直接报错。` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Models/UpdateInstancePatch.cs:8` | `/// 不表示「改成 null」。原因：Node 侧 <c>parseUpdatePatch</c>（<c>src/main/ipc.ts:696</c>）` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Services/Channels.cs:113` | `/// 只出现在 Node → C# 方向、没有 invoke 的推送通道（对应旧 <c>PUSH_ONLY_CHANNELS</c>，<c>src/main/ipc.ts:34</c>）。` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Services/CoreBridge.cs:735` | `/// <param name="args">位置参数数组，顺序与 <c>src/main/ipc.ts</c> 的 handler 一致。</param>` | 死引用 | 保留 | 该顺序约定仍被 `desktop/bridge/server.mjs` 遵守，是**活约定**的溯源说明 |
| `desktop/src/WhalesLauncher.App/Views/EnginesPage.xaml.cs:31` | `/// <summary>启动器自身的日志来源 id（<c>src/main/runtime.ts:18</c> 的 <c>LAUNCHER_LOG_ID</c>）。` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Views/InstancesPage.xaml.cs:701` | `* 实例操作（经 Bridge 通道，参数形状对齐 src/main/ipc.ts）` | 死引用 | 保留 | 同上 |
| `desktop/src/WhalesLauncher.App/Views/SettingsPage.xaml.cs:356` | `// 后端在 nodePath 变化时会丢掉探测缓存（src/main/config.ts 的既有行为），` | 死引用 | 保留 | 描述的是**现桥接层的活行为**，溯源到已删文件 |

`src/renderer` 的 C# 溯源注释共 10 处（`App.xaml.cs:9`、`MainWindow.xaml.cs:24`、`AppState.cs:7`、
`DialogService.cs:9`、`Formatters.cs:8`、`NameValidator.cs:6`、`NavigationService.cs:10/34/47`、
`LogDrawer.cs:25`、`InstancesPage.xaml.cs:17`），分类 `死引用`，建议动作 `保留`（同理由：溯源说明）。

其余注释级死引用（保留）：

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `src/shared/contracts.ts:716` | `` * `src/core/**` 必须导出且仅需导出以下形状；`src/main/**` 按此调用。 `` | 死引用 | 保留（可选修正） | 契约是唯一事实源，注释描述 CoreApi 的调用方；`src/main/**` 已不存在。**不建议删除契约**，仅可考虑改写措辞 |
| `src/shared/contracts.ts:607` | `    /** main → renderer 推送，无需 invoke。 */` | 死引用 | 保留（可选修正） | 同上（"main / renderer" 是旧架构词，现为"桥接 → C# 宿主"） |
| `src/shared/contracts.ts:620` | `` * preload 通过 `contextBridge` 暴露给 renderer 的 API 形状。 `` | 死引用 | 保留 | 见 §4.1：`WhalesApi` 的保留决策 |
| `desktop/bridge/{server,validate,config-store,events,menu}.mjs` 等 28 处 | `来源：src/main/ipc.ts L…`、`来源：src/main/index.ts L…` 等溯源注释 | 死引用 | 保留 | `legacy-teardown-plan.md:171` 已明确建议保留：这是"这段逻辑搬运自何处"的唯一线索 |
| `scripts/build-bridge.mjs:23,105,107,109,121,126,129,137` | ``  *  2. 不依赖 `src/main/**`（待拆除的 Electron 主进程目录）—— `` 等 8 处 | 有耦合风险需保留 | 保留 | **这是活的构建期断言**，见 §4.4。删掉注释可以，删掉逻辑会立刻失去回归保护 |
| `scripts/audit/bridge-smoke.mjs:403` | `section('[4] 参数校验等价性（校验来源：src/main/ipc.ts / config.ts）');` | 死引用 | 保留 | 冒烟测试的章节标题，描述校验逻辑的搬运来源 |
| `tests/e2e/30-robustness.mjs:8` | ``  * `src/core/proc.ts killTree()` 与 `src/main/runtime.ts forceKillLeftovers()` 都依赖 taskkill。 `` | 死引用 | 保留 | 纯注释 |
| `tests/e2e/32-stop-verify.mjs:4` | ``  * 背景：`src/main/runtime.ts` 与 `src/core/proc.ts` 现均有 `process.kill(pid,'SIGKILL')` `` | 死引用 | 保留 | 纯注释 |
| `tests/e2e/52-broken-record-cleanup.mjs:5` | ``  * 但 `src/renderer/**` 全文检索 `problem|shareConflict` **零命中** —— 界面只认 `present`。 `` | 死引用 | 保留 | 纯注释；描述的是当时的排查发现 |

---

## 3. 旧 UI 资产清单

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `docs/assets/screenshot-empty.png` | 空态引导截图，1280×840 | 旧 UI 资产 | 保留 | ⚠ **不是无主资产**：被 `docs/video/promo-plan-v1.md:151` 引用为「备用过渡」镜头。删除需同步改 promo-plan（见 §7 高危 #2） |
| `docs/assets/screenshot-instances.png` | 主界面卡片网格，1280×840 | 旧 UI 资产 | 保留 | ⚠ 被 `docs/video/promo-plan-v1.md:150` 引用（S03/S04/S17 备用帧） |
| `docs/assets/screenshot-menu.png` | 应用内菜单浮层，1280×840 | 旧 UI 资产 | 保留 | ⚠ 被 `docs/video/promo-plan-v1.md:152` 引用（S15） |
| `docs/assets/screenshot-settings.png` | 全局设置截图，1280×840 | 旧 UI 资产 | 保留 | ⚠ 被 `docs/video/promo-plan-v1.md:153` 引用（S15） |
| `docs/assets/tutorial/*.png`（23 张，`01-instance-list.png` … `23-node-runtime.png`） | 教程截图集 | 旧 UI 资产 | 暂缓，需人工确认 | 生成器 `scripts/make-tutorial-shots.mjs` 已删（`Test-Path`=False）→ 与 `docs/guide/README.md:17` 的「可随时重跑复现」声明矛盾。**这 23 张是否为旧 UI 或新 UI 截图，本轮未做像素级判定** → 归入 §7。`docs/guide/**` 归另一名 teammate |
| `tests/dist/**`（`verify-dist.cjs` 311 行、`qr08-check.cjs` 234、`node-runtime-check.cjs` 222，共 809 行） | 旧产物验证测试 | 旧 UI 资产 | 删除 | **`ed93af9` 未删除它们**（`git show --stat --name-status ed93af9` 的 `D` 行只有 `scripts/build.mjs`、`scripts/launch.mjs`、`scripts/make-tutorial-shots.mjs`、`scripts/setup-electron.mjs`），但 `legacy-teardown-plan.md:69,306,398` 明确把 `tests/dist/**` 列入待删。三者断言对象是被删产物，已必失败（详见 §5） |

---

## 4. 保留清单 / 耦合风险

> 本节所有条目一律**建议保留**，并给出耦合点与机械证据。

### 4.1 `src/shared/contracts.ts` 的 `WhalesApi` —— 有耦合，必须保留

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `src/shared/contracts.ts:623` | `export interface WhalesApi {` | 有耦合风险需保留 | 保留 | **耦合点：仍被 e2e 契约测试断言**。全仓库 `WhalesApi` 命中 24 处：接口定义 1 处（`contracts.ts:623`）+ **测试 5 处**（`tests/e2e/20-contract-and-dsh.mjs:114,115,119,122,126`）+ 文档 18 处。`desktop/**` 命中 **0 处** |

判据细化（避免误判为"只服务旧前端"）：

- `20-contract-and-dsh.mjs:122` 用 `contractsSrc.indexOf('export interface WhalesApi {')` 定位接口块，
  `:123-124` 逐条提取方法名并用 `new RegExp('\\b' + m + '\\s*:')` 在**旧 preload 源码**里查存在性。
- 即：该接口目前是"给已删的 preload 写的类型 + 一个已必失败的 e2e 断言"的组合。
- **但 `WhalesApi` 不是死类型**：它是"契约方法全集"的声明式清单，`1-B6` 断言的方法数（37）正是
  §4.2 通道覆盖率的对照源。删除它会同时删掉一条对"契约方法是否被全部暴露"的护栏。
- 且 `20-contract-and-dsh.mjs` 整体已因读 `src/preload/index.ts` 而失败（§5），
  修该测试时**必须先决定 `WhalesApi` 的去留**——两步耦合，不能分头做。

> **建议**：保留 `WhalesApi`，与 §5 的 e2e 改造同批处理；改造后若确认无消费者，再单独评审。

### 4.2 `CH` 通道常量表 —— 全量在用，零死通道

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `src/shared/contracts.ts:552-617` | `export const CH = { … } as const;` | 有耦合风险需保留 | 保留 | 机械证据：从 `CH` 块提取 **39 条**通道字面量，与 `desktop/bridge/**` 的 `CH.<grp>.<name>` 引用求差集 → **缺失 0 条**。三条 `import { CH } from '../../src/shared/contracts.ts'` 分别位于 `desktop/bridge/config-store.mjs:16`（`SCHEMA_VERSION`）、`events.mjs:15`、`server.mjs:61` |

### 4.3 `src/core/**` —— 无旧前端适配层残留，全部在用

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `src/core/**`（16 文件） | — | 有耦合风险需保留 | 保留 | 机械证据：`desktop/bridge/**` 对 `src/core` 的**运行时 import 恰好 3 条**——`config-store.mjs:15`、`events.mjs:14`、`server.mjs:60`（均为 `import { core } from '../../src/core/index.ts'`）。`src/core` 内**未发现**只服务 Electron 的适配层：`legacy-teardown-plan.md:68` 已实测「`src/core/**` 对 `src/renderer` 零引用」 |
| `src/core/index.ts:107` | `因此界面需要一个"当前用哪个 node / 为什么不可用"的查询入口。` | 有耦合风险需保留 | 保留 | 该注释提到的"界面"现由 `desktop/src/**/Views/SettingsPage.xaml.cs` 承担，属活代码 |

### 4.4 `scripts/build-bridge.mjs` 的回归断言 —— 旧路径是其**主语**，不可误删

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `scripts/build-bridge.mjs:118-141` | `async function assertNoLegacyMainInputs(stageDir, version) {` … `const legacy = inputs.filter((file) => /(^|[\\/])src[\\/]main[\\/]/.test(file));` … `'src/main/** 引用数 = 0',` | 有耦合风险需保留 | 保留 | **这是活的构建期守卫**：读 esbuild `--metafile` 模块图，命中 `src/main/**` 即 `process.exit(1)`。`src/main` 这个词在这里是**断言主语**，删掉就等于拆掉护栏。注释里 8 处 `src/main` 同理 |

### 4.5 `scripts/` 中仍被新链路引用的脚本

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `scripts/audit/bridge-smoke.mjs` | `npm run smoke:bridge` → `node scripts/audit/bridge-smoke.mjs` | 有耦合风险需保留 | 保留 | `package.json:16` 引用它；`legacy-teardown-plan.md:69` 已认定它覆盖了 `tests/dist/**` 的原意图 |
| `scripts/audit/audit-visual.ps1` | `npm run audit:visual` | 有耦合风险需保留 | 保留 | `package.json:17` 引用它 |
| `scripts/make-icon.mjs` | `npm run icon` → `node scripts/make-icon.mjs` | 有耦合风险需保留 | 保留 | `package.json:11` 引用它（生成 `assets/whales.ico`） |
| `scripts/repair-session-zstd.cjs` | DSH 会话日志 zstd 修复工具 | 有耦合风险需保留 | 保留 | 独立运维脚本，`a239e77` 引入，与旧前端无关 |
| `scripts/build-bridge.mjs` | `npm run build:bridge` | 有耦合风险需保留 | 保留 | 新链路核心（见 §4.4） |

### 4.6 `package.json` 已正确清理（**无残余**，供 Lead 交叉核对）

| 检查项 | 实测结果 | 判据 |
|---|---|---|
| `main` 字段 | **不存在** | `package.json` 全文无 `main` 键；原值 `dist/main/index.cjs` 已移除 |
| `scripts.launch` / `scripts.start` | **不存在** | `scripts` 段实测 11 项：`build:bridge` `build:app` `build` `icon` `shortcut` `typecheck` `test` `test:core` `smoke:bridge` `audit:visual` `clean` |
| `scripts.shots:tutorial` | **不存在** | 同上 |
| `scripts.setup:electron` / `postinstall` | **不存在** | 同上 |
| `dependencies` | 仅 `adm-zip`、`js-yaml` | `legacy-teardown-plan.md:79,139` 已实测「`@fluentui/*` 与 `@microsoft/fast-element` 本仓库不存在」 |
| `devDependencies` | `@types/adm-zip` `@types/js-yaml` `@types/node` `esbuild` `typescript` | **`electron` 已移除** ✓ |

### 4.7 `tests/e2e/**` 与 `tests/dist/**` 存活结论

> **方法声明**：本节为**静态依赖分析**，**未实际运行** `node tests/e2e/run-all.mjs`。
> 原因：任务书明确要求「不要运行会启停用户真实实例的东西」——
> `run-all.mjs:39` 把 `32-stop-verify.mjs`（`stopInstance` 实杀验证）列为 `inline` 执行，
> `run-all.mjs:41` 把 `31-stop-probe.mjs`（`taskkill`）列为 `child` 执行，
> 运行总入口即等于运行这两者。结论因此全部由源码级证据推出，判据逐条给出。

**结论：`tests/e2e/**` 已失效（15 个用例文件中 7 个必失败）；`tests/dist/**` 已失效（3/3 必失败）。**

判据一 —— 存在性（**注意：源码已删，但旧构建产物并未删除**）：

```
Test-Path src\main = False ; src\preload = False ; src\renderer = False     ← 源码已删
Test-Path dist\main = True  ; dist\preload = True  ; dist\renderer = True   ← 旧产物仍在磁盘上！
dist\bridge\server.cjs = True（新链路产物，必须保留）
```

`dist/main|preload|renderer` 的 15 个文件（合计约 2.76 MB，含 `.map`）实测存在，
`LastWriteTime` = `2026-09-21 13:41:54` / `13:13:52-53`，**早于** `dist/bridge/server.cjs`
的 `2026-09-21 18:55:18`。`git ls-files dist` **无输出**（`/dist/` 被 `.gitignore:18` 忽略，
未入库）→ 因此 `ed93af9` 的删除**不可能**触及它们，文件是旧前端构建的物理残留。
详见 §6 #8 与 §7 高危 #1。

判据二 —— 失败传播路径（`run-all.mjs:104-121`）：总入口对每个 `inline` 用例执行
`await import(...)`，异常被 `catch` 后记为 `status: '异常'` 并置 `anyFailure = true`
（`:114-115`），最终 `process.exitCode = 1`（`:142`）。
**即：任一用例抛未捕获异常 → 整个 e2e 套件不通过。**

判据三 —— 逐文件命中（这些 `await` 位于**模块顶层**，无 `try/catch` 包裹。
`50-status-recheck.mjs:21` 的 `const read = (rel) => fs.readFile(...)` 亦无 `.catch`）：

| 用例文件 | 命中行 | 读取目标 | 预期结局 |
|---|---|---|---|
| `20-contract-and-dsh.mjs` | `:80` | `src/preload/index.ts` | `readFile` ENOENT → 顶层抛 → `run-all` 记「异常」 |
| `20-contract-and-dsh.mjs` | `:136` | `src/main/ipc.ts` | 同上 |
| `30-robustness.mjs` | `:421` `:428` | `src/main/index.ts`、`src/main/ipc.ts` | 同上 |
| `30-robustness.mjs` | `:451` `:497` `:502` | `src/renderer/**`（`walk` + `index.html` + `util/dom.ts`） | 同上 |
| `40-core-deep.mjs` | `:120` `:133` | `src/main/ipc.ts`、`src/main/index.ts` | 同上 |
| `42-config-heal.mjs` | `:27` | `src/main/config.ts` | 同上 |
| `50-status-recheck.mjs` | `:86` `:93` `:223` | `src/main/{config,ipc,index}.ts` | 同上 |
| `50-status-recheck.mjs` | `:207` | `src/renderer/**`（`walk`） | 同上 |
| `52-broken-record-cleanup.mjs` | `:119` | `src/renderer/**`（`walk`） | 同上 |

**7 个文件**受影响：`20-` `30-` `40-` `42-` `50-` `52-`（6 个）+ 由 `run-all.mjs:26-42` 可见
`31-stop-probe`（`child`）与 `32-stop-verify`（`inline`）**不在**上表内 → 它们不受影响。
按 `run-all.mjs:26-42` 的 15 项清单，**必失败 6 项**，其余 9 项可跑。

判据四 —— 仍可跑的用例：`00-smoke`、`10-data-safety`、`11-repro-settings-clobber`、
`31-stop-probe`、`32-stop-verify`、`41-core-perf-log`、`43-resolve-command`、
`44-cmd-invocation-matrix`、`51-registry-review` —— 它们只读 `src/core/**`（`Test-Path`=True）
与 `REPO_ROOT`，且 `_bundle.mjs:78` 用 esbuild 打包 `src/core/index.ts`（该入口存在）。
**但它们不影响总入口结论：`run-all.mjs` 是「任一失败即整体 exit 1」。**

### `tests/dist/**` 的精确失效原因（与初判不同，已修正）

三者均以**替身 electron** `require(dist/main/index.cjs)` 为断言对象（`verify-dist.cjs:6-8` 自述；
`legacy-teardown-plan.md:69` 复核认定 `qr08-check.cjs:8`、`node-runtime-check.cjs:55` 同构）。

**因为 `dist/main/index.cjs` 仍在磁盘上**，"目标已删所以必然 ENOENT"的初判**不成立**，需按文件分别判断：

| 脚本 | 失效原因 | 证据 |
|---|---|---|
| `verify-dist.cjs` | **必然失败**，但原因不是产物缺失，而是**源码缺失**：`:305-322` 的 SHA256 对账用 `hash(path.join(ROOT,'src','renderer',rel))`，`hash` 无 `existsSync` 保护 → `src/renderer` 已删 → `readFileSync` ENOENT → 被 `check()`（`:45-53`）捕获并 `failures += 1` | `:307` `const srcDir = path.join(ROOT, 'src', 'renderer');` / `:318-320` |
| `qr08-check.cjs` | **未定**：`require(dist/main/index.cjs)` 的目标存在，脚本可能**通过**（读的是旧代码） | 需要实际运行才能定论；**本轮按静态分析不下结论** |
| `node-runtime-check.cjs` | **未定**：同上 | 同上 |

> **给 Lead 的两点提醒**：
> 1. `verify-dist.cjs` 在旧产物被删前是"因源码缺失而红"，删掉 `dist/main` 后会变成"因产物缺失而红" —— 两种都是红，但它**从未**给出过对新架构有意义的结论。其原始意图（"构建通过但模块初始化即抛错"）按 `legacy-teardown-plan.md:69` 已由 `scripts/audit/bridge-smoke.mjs` + `CoreBridge` 自验覆盖。
> 2. **`npm test` 不受上述任何影响**：`package.json:14` 为 `node --test "tests/**/*.test.mjs"`，
>   glob 只匹配 `.test.mjs`；`tests/dist/**` 是 `.cjs`（不匹配），`tests/e2e/*.mjs` 无 `.test.`（不匹配）。
>   实际收集到 **18 个** `tests/core/*.test.mjs`（README `:340` 写的"16 文件"已过时，属文档陈旧）。
>   **但 README `:348` 把 `node tests/e2e/run-all.mjs` 列为回归命令 → 该命令当前必然 exit 1。**

> **给 Lead 的关键提醒**：`tests/e2e/50-status-recheck.mjs` **不在** `legacy-teardown-plan.md:365-375`
> 的「暂缓清单」里被列为待改造（该文 §9 #1 只点了 `50-status-recheck.mjs` 的文本读取问题，
> 列在第 367 行）；而 `20-` / `30-` / `40-` / `42-` / `52-` 五个文件的同类命中
> **未出现**在任何既有清单中 —— 它们是在本次盘点中新发现的。

---

## 5. 历史叙述 vs 当前有效引用

> **总口径**：`docs/design/legacy-teardown-plan.md`、`docs/design/winui3-*.md`、`docs/winui3-重构交付报告.md`
> 里提到 `src/main` 的地方**多数是历史说明，属正常**。
> 本节把它们与"读者会照着去找文件"的**当前有效路径引用**区分开。

### 5.1 条数统计（按文件 × 分类）

| 文件 | `src/main` 命中 | `src/renderer` 命中 | 主导性质 | 建议动作 |
|---|---|---|---|---|
| `docs/design/legacy-teardown-plan.md` | 45 | 12 | **历史叙述**（拆除方案本体，描述"曾经有什么/为什么删"） | 保留 |
| `docs/design/winui3-visual-spec.md` | 0 | 1 | 历史叙述（第 8 行"不得作为设计依据的已废弃材料"名单） | 保留 |
| `docs/design/winui3-bridge-protocol.md` | 2 | 0 | **混合**：`:79` `:131` 是"校验事实源"的当前指引 | 修正（见 §5.2） |
| `docs/design/winui3-impl-brief.md` | 1 | 1 | **当前有效引用**：`:12` 让实现者去查阅 `src/main/ipc.ts` | **修正** |
| `docs/design/winui3-csharp-conventions.md` | 0 | 0 | 无命中 | — |
| `docs/winui3-重构交付报告.md` | 7 | 3 | **历史叙述**（"旧前端共 54 文件已物理删除"的交付说明） | 保留 |
| `docs/design/architecture.md` | 0 | 0 | `:177` 提到 Electron 主进程（历史背景） | 保留 |
| `docs/design/port-allocation.md` | 1 | 3 | **当前有效引用**：`:15` `:204-206` 把旧 UI 文件当现状描述 | 修正 |
| `docs/design/ui-redesign.md` | 8 | 12 | **整篇失效设计文档**，已被 `winui3-visual-spec.md:8` 亲自判废弃 | 见 §5.3 |
| `docs/design/ui-acceptance-criteria.md` | 20 | 18 | **整篇失效设计文档**，同上 | 见 §5.3 |
| `docs/video/promo-plan-v1.md` | 0 | 7 | **当前有效引用**：`:41-47` 镜头表把旧 UI 文件行号当"镜头来源" | 修正 |
| `docs/review/acceptance.md` | 9 | 9 | 历史评审记录（旧前端那一轮的验收） | 保留 |
| `docs/review/code-review.md` | 4 | 6 | 历史评审记录 | 保留 |
| `docs/review/final-status.md` | 0 | 0 | 历史评审记录（`:82` 有 `dist/main` 等旧产物数字） | 保留 |
| `docs/review/frontend-survey-for-winui3.md` | 6 | 18 | 历史叙述 + **需求输入证据**（`legacy-teardown-plan.md:100` 认定其为重构需求输入） | 保留 |
| `docs/review/winuinav-migration-assessment.md` | 1 | 9 | 历史叙述（迁移评估） | 保留 |
| `docs/research/dsh-interface.md` | 0 | 0 | 独立研究文档 | — |
| `docs/guide/07-troubleshooting.md` | 0 | 2 | **当前有效引用**（用户手册，含 Markdown 死链） | **修正** |
| `docs/guide/01-install.md` | 0 | 0 | **当前有效引用**（用户手册，指向已删脚本与死链） | **修正** |
| `docs/guide/README.md` | 0 | 0 | **当前有效引用**（用户手册，指向已删脚本与死链） | **修正** |
| `README.md` | 0 | 0 | **当前有效引用**（面向用户，点命令会失败） | **修正** |

### 5.2 需"修正"的当前有效路径引用（逐条）

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `docs/design/winui3-impl-brief.md:12` | `` - 旧前端（`src/renderer/**`、`src/main/**`、`src/preload/**`）**不得参考其 UI 设计**；仅 `src/shared/contracts.ts`（契约）与 `src/main/ipc.ts`（参数形状）可作为**事实来源**查阅。 `` | 文档陈旧 | 修正 | ⚠ **这是"当前有效引用"**：它指令实现者去查阅 `src/main/ipc.ts`，而该文件已删 → 实现者会找不到。`legacy-teardown-plan.md:174` 已点名此句需改写为"见 git 历史 / `docs/design/legacy-teardown-plan.md`" |
| `docs/design/winui3-bridge-protocol.md:79` | `` **参数校验的唯一事实源**：`src/main/ipc.ts` 的既有 handler（`must*` / `parseCreateInput` / `parseUpdatePatch` 白名单等）。**桥接层必须原样搬运这些校验，不得放宽。** `` | 文档陈旧 | 修正 | 搬运**已完成**（落在 `desktop/bridge/validate.mjs`），但本文仍称事实源是已删文件。应改指 `validate.mjs` |
| `docs/design/winui3-bridge-protocol.md:131` | `` 2. **复用而非重写**：Node 侧必须复用 `src/core`（`CoreApi`）与 `src/main/ipc.ts` 的 handler 逻辑。… `` | 文档陈旧 | 修正 | 同上一行：`src/core` 部分仍有效，`src/main/ipc.ts` 部分失效 |
| `docs/design/port-allocation.md:15` | `` \| 用户唯一的出口 \| 实例详情「启动参数」自由文本手写 `--port`（`src/renderer/views/detail/settings.ts`） \| `` | 文档陈旧 | 修正 | 把旧 UI 文件当**现状**描述 |
| `docs/design/port-allocation.md:204-206` | `\| 界面 · 实例卡片 \| 运行中的卡片多一个 \`:3081\` 统计项 \| \`src/renderer/views/instances.ts\` \|` / `\| 界面 · 详情页 \| 「监听端口」指标 \| \`src/renderer/views/detail.ts\` \|` / `\| IPC \| \`InstanceRuntime.port\` 经既有 \`onState\` 广播下发（**未新增通道**） \| \`src/main/runtime.ts\` \|` | 文档陈旧 | 修正 | 三行的"证据来源"列全部指向已删文件 |
| `docs/video/promo-plan-v1.md:41-47` | 镜头 1-7 的「来源」列：`src/renderer/views/instances.ts:58`、`views/wizard.ts:76`、`views/wizard.ts:536`、`views/global.ts:392`、`views/detail.ts:125`、`views/detail/logs.ts:73`、`src/renderer/data/demo.ts:389` | 文档陈旧 | 修正 | ⚠ **这是"当前有效引用"**：宣传片制作方会照着这些行号去取台词。7 条全部指向已删文件 |
| `README.md:141` | ``   Electron 运行时 —— 原因见下） `` | 文档陈旧 | 修正 | 面向用户的"环境要求"仍把 Electron 当启动器运行时 |
| `README.md:145-146` | `` > 运行时指纹白名单**匹配。启动器自己跑在 Electron 里，其内置 Node 的指纹（例如 Electron 41 `` / `` > 的 `V8 14.6.202.26-electron.0`）不在 dsh 的支持列表内，启动会直接失败： `` | 文档陈旧 | 修正 | 新架构下启动器跑在 WinUI 3 + 系统 Node 上，"为什么不能用自带运行时"的论证前提已变（结论仍成立：实例需要独立 Node） |
| `README.md:184` | `` npm run build     # 只构建（含类型门禁与 dist.tmp 原子替换） `` | 文档陈旧 | 修正 | `npm run build` 现为 `build:bridge && build:app`，**无** `dist.tmp` 原子替换环节 |
| `README.md:202-203` | `` 2. **按需构建** —— 产物齐全且比 `src/**` 新就直接启动（**双击即开**）；… `` / `` 3. **启动并留证** —— Electron 的 stdout/stderr 直通控制台，同时写日志（见下）。 `` | 文档陈旧 | 修正 | 描述的是已删 `launch.mjs` 的三步流程 |
| `README.md:217-222` | `` > **为什么没有单文件 .exe**：把 `.bat` **编译**成 exe 并不会改变什么 —— 它照样要调用 `` … `` > 入口仍是 `dist/main/index.cjs`，与现在完全一致。 `` | 文档陈旧 | 修正 | 整段论证已被重构推翻（现在是原生 WinUI 3 exe） |
| `desktop/src/WhalesLauncher.App/WhalesLauncher.App.csproj:16` | `         依据 microsoft-ui-xaml docs/design-notes/unpackaged-apps.md。` | 暂缓，需人工确认 | 保留 | 指向的 `docs/design-notes/unpackaged-apps.md` **不在本仓库**（`Test-Path`=False），疑似指上游 microsoft-ui-xaml 仓库内路径 → 见 §7 |

### 5.3 整篇失效的旧 UI 设计文档（由新规范亲自判废弃）

| 路径:行号 | 原文片段 | 分类 | 建议动作 | 风险说明 |
|---|---|---|---|---|
| `docs/design/winui3-visual-spec.md:8` | `` > **不得作为设计依据的已废弃材料**：`src/renderer/**`（含 `styles/fluent-tokens.css`）、`docs/design/ui-redesign.md`、`docs/design/ui-acceptance-criteria.md`、`docs/review/fluent2-*.md`。 `` | 文档陈旧 | 保留 | **这是废弃判定的机械证据来源**（现行规范亲自声明），必须保留 |
| `docs/design/ui-redesign.md`（1737 行） | 全篇 DOM/CSS 视觉规范；`:14` 逐行读取清单、`:77` `src/main/index.ts:126-144` 的 `new BrowserWindow`、`:1574-1690` 的取证命令 | 文档陈旧 | 保留 | 已被 `winui3-visual-spec.md:8` 判废弃。`legacy-teardown-plan.md:75` 建议删除，但**其"6 处入链需处理"尚未处理** → 见 §7 |
| `docs/design/ui-acceptance-criteria.md`（846 行） | 判据全部针对 `src/renderer/styles/*.css` 与 `src/main/index.ts`；`:9` 取证基线、`:47` `:65` `:70-71` `:694-697` 的 PowerShell 取证命令 | 文档陈旧 | 保留 | 同上一行。`:47` 的 `Get-ChildItem F:\WhalesLauncher\src\renderer\styles\*.css` 等命令现已必然失败 |

---

## 6. 暂缓，需人工确认

以下条目**证据不足以机械判定**，不硬判，交人工确认后再决定动作。

| # | 路径:行号 | 现象 | 缺什么证据 |
|---|---|---|---|
| 1 | `docs/assets/tutorial/*.png`（23 张） | 生成器 `scripts/make-tutorial-shots.mjs` 已删，但 `docs/guide/README.md:17,21-22` 仍称"自动生成、可随时重跑"+ `docs/guide/**` 有 8 处 `../assets/tutorial/*.png` 引用 | 需要**像素级/目视判定**这 23 张是旧 UI 还是重构后的新 UI 截图。若是旧 UI → 旧 UI 资产；若是新 UI → 仅需修正生成器声明 |
| 2 | `desktop/src/WhalesLauncher.App/WhalesLauncher.App.csproj:16` | `依据 microsoft-ui-xaml docs/design-notes/unpackaged-apps.md`；该路径在本仓库 `Test-Path`=False | 需确认这是**上游仓库路径**（则应写成完整 URL 或注明仓库名）还是**本仓库应有而缺失的文件** |
| 3 | `tsconfig.json:6` | `"lib": ["ES2023", "DOM", "DOM.Iterable"]` | `DOM` / `DOM.Iterable` 是给旧渲染层用的；现 `src/**/*.ts` 只剩 core + contracts（Node 侧）。**是否应移除需人工确认**——移除会改变类型检查面，且 `typecheck` 是 `npm run typecheck` 的组成 |
| 4 | `tsconfig.json:30` | `"include": ["src/**/*.ts", "scripts/**/*.mjs"]` | `legacy-teardown-plan.md:153` 建议改为显式 `["src/core/**/*.ts", "src/shared/**/*.ts", …]` 以防"删了目录但 include 空转"。当前写法**仍匹配到全部现存文件**，无实际断链 → 是否收紧需人工确认 |
| 5 | `docs/design/ui-redesign.md`、`docs/design/ui-acceptance-criteria.md` | 已被判废弃，但 `legacy-teardown-plan.md:75-76` 提到的"6 处入链"仍未处理 | 需人工统计**当前**入链（我未做全量入链图分析，避免与另一名 teammate 的 `docs/**` 工作重叠） |
| 6 | `docs/review/{acceptance,code-review,final-status}.md` | 含大量旧前端行号引用（合计 `src/main` 13 处、`src/renderer` 15 处） | 属**历史评审记录**，按 `legacy-teardown-plan.md:375` 建议「保留（可移入 `docs/review/archive/`）」。是否归档需 Lead 决定 |
| 7 | `.gitignore:48-58` `.spike/` 注释块 | 提到 jsdom 的 `node_modules`、`F:\WhalesLauncher` 硬编码路径、`.spike/smoke` 渲染层冒烟脚本 | 需确认 `.spike/`（**已排除出扫描范围**）内是否还有需要公开的资产。注释本身是"日后若要公开则如何改"的指引 |
| 8 | `dist/` 目录现状（**已核实，从"暂缓"升级为确定项**） | `dist/main/`（`index.cjs` 451,452 B + `.map`）、`dist/preload/`（`index.cjs` 5,321 B + `.map`）、`dist/renderer/`（`index.js` 350,459 B + `index.html` + `styles/*.css` ×5 + `.map`）**仍在磁盘上**，mtime `2026-09-21 13:41:54`，早于 `dist/bridge/server.cjs` 的 `18:55:18` | 已确认为旧前端构建残留，**未入库**（`git ls-files dist` 无输出，`/dist/` 被 `.gitignore:18` 忽略）→ 归入 §7 高危 #1 的"高风险删除建议"。**无需再人工确认**；`dist/bridge/` 必须保留 |

---

## 7. 汇总计数

计数口径：**按清单行条目计**（一行 = 一个"路径:行号"定位点）。
计数由脚本对本文表格逐行复算得出（`total data rows: 144`），非人工估算。

| 分类 | 条目数 | 构成 |
|---|---|---|
| **死引用** | **77**（其中 **7 条已被并行 teammate 修复**，见 §2.1「已由他人修复」行） | 代码级 42（§2.1，其中 **5 处曾为硬失败**：`.bat` / `.vbs` / `make-shortcut.ps1` ×2 与 `创建桌面快捷方式.bat` 链路）+ 测试运行时读已删路径 12（§2.1 内 `tests/**` 行）+ `tests/dist/**` 3（§3，兼计）+ C# 与源码注释级 20（§2.2：`desktop/**` 9 + `src/renderer` 10 + `contracts.ts` 注释行） |
| **旧 UI 资产** | **6** | §3：4 张 `docs/assets/screenshot-*.png` + `docs/assets/tutorial/**`（23 张）+ `tests/dist/**`（809 行） |
| **乱码缺陷** | **0** | §1：任务书第 6 条经字节级复核**不成立**（4 项判据全部指向"非乱码"） |
| **文档陈旧** | **34** | §5.2 逐条 12 + §5.3 整篇失效设计文档 2 篇 + §1.1 ASCII 防护记录 4 + 兼计入 §2.1 的用户手册/README 行 16 |
| **有耦合风险需保留** | **12** | §4.1 `WhalesApi` 1 + §4.2 `CH`（39 通道，0 死通道）1 + §4.3 `src/core/**` 2 + §4.4 构建期断言 1 + §4.5 在用脚本 5 + `package.json` 核对结论 1 + `contracts.ts` 契约本体 1 |
| **暂缓，需人工确认** | **7** | §6（原 8 条，#8 `dist/` 已核实并升级为确定项） |

> 「有耦合风险需保留」的 12 条中，**没有任何一条建议动作是"删除"** —— 这是本轮的核心安全结论。

按文件类型分布（`src/main` 正则全仓库 128 处 / 26 文件）：

| 文件域 | 文件数 | 处数 | 主导分类 |
|---|---|---|---|
| `desktop/**`（C# 溯源注释） | 9 | 9 | 死引用（建议保留，仅留痕） |
| `docs/**`（历史与设计文档） | 13 | 105 | 历史叙述为主 |
| `scripts/**` | 2 | 9 | 有耦合风险需保留（构建断言） |
| `tests/**` | 3 | 5 | 死引用（运行时报错源） |
| `src/shared/contracts.ts` | 1 | 1 | 死引用（注释） |

---

## 8. 附：实测验证记录

| 验证项 | 命令/方法 | 结果 |
|---|---|---|
| 工作树干净 | `git status --short` | 无输出 |
| 已删路径存在性 | `Test-Path` × 10 | `src/main` `src/preload` `src/renderer` `scripts/launch.mjs` `scripts/setup-electron.mjs` `scripts/build.mjs` `scripts/make-tutorial-shots.mjs` `scripts/record` 全部 `False` |
| `tests/dist/**` 是否被 `ed93af9` 删除 | `git show --stat --name-status ed93af9 \| Select-String 'tests/dist'` | **无输出** → 未被删除，仍存活 |
| `ed93af9` 实际删除项 | 同上 | `D scripts/build.mjs`、`D scripts/launch.mjs`、`D scripts/make-tutorial-shots.mjs`、`D scripts/setup-electron.mjs` |
| 桥接运行时 import 边界 | `grep -E "^\\s*(import\|export).*from.*(src/\|core/\|shared/)"` on `desktop/**/*.mjs` | **6 条，全部指向 `src/core` 或 `src/shared`；`src/main` 命中 0 条** ✓ |
| 契约通道覆盖率 | `CH` 块提取 39 条 vs `desktop/bridge/**` 的 `CH.*.*` 引用 | 缺失 **0** 条 ✓ |
| 编码缺陷 | 212 文件 `decode('utf-8')` + 往返测试 | 非 UTF-8 **0** 个；`U+FFFD` **0** 个；乱码标记字符 **0** 个 |
| `package.json` 残留 | 全文读 | `main` 字段不存在；`electron`/`@fluentui`/`@fast-element` 不存在；无 `launch`/`start`/`shots:tutorial`/`setup:electron`/`postinstall` |
| `.editorconfig` | `Test-Path .editorconfig` | **不存在**（任务书列为扫描对象，实测仓库无此文件） |
| Windows 可执行产物 | `Get-ChildItem -Recurse -Include WhalesLauncher.exe` | 仅 Debug 产物：`desktop/src/WhalesLauncher.App/bin/Debug/net10.0-windows10.0.26100.0/win-x64/WhalesLauncher.exe` |
| **旧产物仍在磁盘** | `Get-ChildItem -Recurse -File dist` | `dist/main`、`dist/preload`、`dist/renderer` 共 15 文件约 2.76 MB 实测存在；`dist/bridge/server.cjs` 446,874 B 为新产物 |
| 旧产物未入库 | `git ls-files dist` | **无输出**；`git check-ignore -v` → `.gitignore:18:/dist/` |
| **测试文件语法可解析** | `node --check` ×12（`tests/e2e` 9 个 + `tests/dist` 3 个） | **全部 exit 0** —— 失效是**运行期缺文件**，不是语法错误；这也排除了"文件本身已损坏"的可能 |
| **未运行 e2e 总入口** | 刻意不执行 | `run-all.mjs:39` 含 `32-stop-verify.mjs`（`stopInstance` 实杀）、`:41` 含 `31-stop-probe.mjs`（`taskkill`）→ 违反"不启停用户真实实例"约束。结论全部由静态证据推出 |

---

## 9. 风险最高的 3 条删除建议（供 Lead 决策）

> 以下三条是**建议删除**的项中风险最高的。它们都不是"删了会编译失败"的显性风险，
> 而是"删了看起来没事、但会在用户侧或后续工作里爆掉"的隐性风险。
>
> **说明**：原先的"根入口硬失败"（`.bat` / `.vbs` / `make-shortcut.ps1` 指向已删 `launch.mjs`）
> 曾是最高危项，但**已被并行 teammate 修复**（见 §2 开头的提示），故不再列入。以下三条是**当前仍待决策**的。

### 高危 #1 —— `dist/main/`、`dist/preload/`、`dist/renderer/`（旧构建产物，15 文件约 2.76 MB）

**为什么有风险**：

1. **同目录下 `dist/bridge/` 是活产物，绝不能一起删。**
   `WhalesLauncher.App.csproj:35-38` 用 `Exists('$(MSBuildProjectDirectory)\..\..\..\dist\bridge')`
   条件复制桥接脚本到 exe 输出目录。若有人执行 `rm -rf dist` 或 `npm run clean`
   （`package.json:18` = `rmSync('dist',{recursive:true,force:true})`）而**忘记重建**，
   产物里就没有 `bridge/server.cjs` → 应用启动后侧车起不来。
   `legacy-teardown-plan.md:74` 已用 **"高"** 风险标注过这一点。
2. **它是"未入库"的，所以删了无法从 git 恢复。** `git ls-files dist` 无输出、`.gitignore:18` 忽略。
   `git checkout` 救不回来，只能重新构建 —— 而重新构建需要能跑通旧构建链
   （`scripts/build.mjs` 已删）→ **实际不可恢复**。
3. **它当前正在"掩盖"一个测试缺陷。** 正因为 `dist/main/index.cjs` 还在，
   `tests/dist/qr08-check.cjs` 与 `node-runtime-check.cjs` 可能在**校验旧代码**的情况下通过
   （§4.7 判据表）。删掉产物会让这两个脚本由"可能假绿"变成"确定红" ——
   这是好事，但会让一个**此前被认为可跑的命令突然失败**，容易被误判成"删除操作引发了回归"。

**建议动作**：只删这三个子目录，**保留 `dist/bridge/`**；删完立刻跑
`npm run build:bridge` 并确认 `dist/bridge/server.cjs` 存在；与 `tests/dist/**` 的退役**同批**进行。

### 高危 #2 —— `docs/assets/screenshot-*.png`（4 张旧 UI 截图）

**为什么有风险**：

1. **它们不是无主资产，是有引用的。** `docs/video/promo-plan-v1.md:150-153` 逐张指定用途
   （`:150` S03/S04/S17 备用帧、`:151` 备用过渡、`:152` S15、`:153` S15）。
   直接删 → promo-plan 的镜头表出现 4 个断链，而该文档是**宣传片制作方的输入**。
2. **它们是旧 UI 的唯一影像记录。** 新架构是 WinUI 3 原生，旧 Electron UI 已无源码
   （`src/renderer/**` 已删）→ 删掉这 4 张后，**"旧界面长什么样"就只剩 git 历史里的二进制**
   （需 `git checkout 8690343 -- docs/assets/` 才能找回）。做重构复盘、对外说明"改了什么"时会用到。
3. **"旧 UI 资产"这个分类本身不等于"该删"。** 本清单已把它们判为 `保留`（§3），
   分类是描述性质，不是删除指令。

**建议动作**：**保留**（维持 §3 判定），或先改写 `docs/video/promo-plan-v1.md:150-153`
改用重构后的新截图，再单独评审是否删除。**不要**与其它死引用一起批量删。

### 高危 #3 —— `tests/e2e/50-status-recheck.mjs`（以及同类的 `20-` / `30-` / `40-` / `42-` / `52-`）

**为什么有风险**：

1. **它们不是"死代码"，里面有大量仍然有效的断言。**
   以 `50-status-recheck.mjs` 为例，它含 **10 个 QR 项**（`QR-01` `:37` / `QR-02` `:61` / `QR-03` `:76` /
   `QR-04` `:88` / `QR-05` `:99` / `QR-06` `:112` / `QR-08` `:126` / `QR-09` `:142` / `QR-10` `:148` /
   `QR-12` `:171` / `QR-13` `:187` / `QR-17` `:210`），其中 9 项只读 **仍然存在**的 `src/core/**`：
   `src/core/instance.ts`（`:44` `:169` `:181`）、`modpack.ts`（`:73`）、`engine.ts`（`:94` `:122`）、
   `index.ts`（`:95`）、`proc.ts`（`:109`）、`launch.ts`（`:137`）。
   整文件删除会丢掉这些**仍然有效**的回归断言。
   **且失败位置非常靠前**：第一个坏行是 `:86`（在 `QR-04` 块内），
   它之后的所有断言（`QR-05` … `QR-17`，约占全文 `:91-235`）在 `run-all` 下**完全不会执行** ——
   也就是说该文件当前的实际贡献已经接近 0，但**文件本身仍有修复价值**。
2. **`50-status-recheck.mjs` 是被既有方案点名的"改造而非删除"项。**
   `legacy-teardown-plan.md:367` 对它的建议是"改造成只校验契约 + 桥接行为…或退役"，
   而不是直接删。而 `20-` / `30-` / `40-` / `42-` / `52-` 五个文件**从未出现在任何既有清单中**
   —— 它们是本次盘点的新发现，**没有经过任何评审**。
3. **删除会静默降低覆盖率而不报错。** `run-all.mjs:26-42` 的 `SUITES` 是**硬编码清单**：
   删掉某个用例文件后，`run-all.mjs:69-74` 会打印「文件缺失」并把 `anyFailure = true`
   —— 但如果有人"顺手"把该行也从 `SUITES` 里删掉，套件会变成**全绿**，
   而实际上少了一大块回归保护。`legacy-teardown-plan.md:365-375` 的暂缓清单正是为防这类操作而设。

**建议动作**：**逐条改造，不要整文件删除**。对每个文件先定位依赖已删路径的那一段，
改成"校验桥接层/契约的等价行为"或直接移除该段断言，保留其余仍在读 `src/core/**` 的断言。
改造前建议先跑一次 `run-all.mjs` 取基线（**由 Lead 执行**，会启停进程，不在本轮授权范围内）。

### 补充：为什么"乱码缺陷 = 0"没有列进高危

任务书把它标为"必须修"，但字节级证据显示**无需修改**（§1）。这里唯一的风险是**反向风险**：
若有人按任务书描述去"修"这两个文件，就会在**本来正确**的 UTF-8 文件上执行一次
"读出 → 按 ANSI 解释 → 写回"的操作，从而**亲手制造**出真正的 mojibake。
**建议 Lead 明确否决该条修复动作**，并把 §1 的四项判据留档备查。

