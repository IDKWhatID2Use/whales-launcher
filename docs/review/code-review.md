# WhalesLauncher 独立代码审查报告

| 项 | 值 |
|---|---|
| 审查人 | `qa-reviewer`（独立第三方，非任何被审代码的作者） |
| 审查对象 | `src/core/**`（core-engineer）、`src/main/**` + `src/preload/**`（shell-engineer）、`src/renderer/**`（ui-engineer） |
| 对照基准 | `src/shared/contracts.ts`（冻结契约）、`docs/research/dsh-interface.md`、`docs/design/architecture.md` |
| 环境 | Windows + pwsh，Node v26.3.0，dsh `0.1.6-alpha.2`（本机真实安装，用于行为比对），Electron 41.1.0 |
| 方法 | **实跑优先**：`tsc --noEmit`、`npm run build`、`npm test`、真实 dsh CLI 实测比对、自建端到端脚本 `tests/e2e/**`；每条结论附命令/输出/`文件:行号` |
| 审查性质 | 对抗性审查：目标是**证伪**"完整可用、界面美观、功能全面、性能良好、简单易用、无 bug" |

> 本报告在审查过程中**多次重跑**（被审代码并行演进）。所有"已修复"结论均为**对当前代码重新实测**得出，不是采信实现说明。
> 逐项验收结论见 `docs/review/acceptance.md`。

---

## 0. 问题统计（截至最终一轮实测）

| 级别 | 当前仍未闭环 | 本轮已修复并验证 | 不再适用 |
|---|---|---|---|
| **P0 阻断** | 0 | 1（`npm test` 完全跑不起来） | —— |
| **P1 严重** | 0 | 2（QR-01、QR-02） | —— |
| **P2 一般** | **1（QR-17）** | 5（QR-03、QR-04、QR-05、QR-06、QR-16） | 1（QR-14 已随 T6 重写消失） |
| **P3 建议** | **0** | 6（QR-08、QR-09、QR-10、QR-11、QR-12、QR-13） | 1（QR-18 按设计接受） |
| 无法验证 | 3（NV-01~NV-03） | —— | —— |

**总评（按最终实测重写）：无 P0、无 P1、无 P3；仅剩 1 项 P2 体验缺口（QR-17）。**

全部结论均为**对最终代码重新执行**得出（不采信任何人的汇总），逐套结果见 `docs/review/acceptance.md` §12：

| 用例集 | 最终结果 |
|---|---|
| `00-smoke` | PASS（core 覆盖契约全部方法，现 51 个键） |
| `10-data-safety` | **13 / 13 PASS** |
| `11-repro-settings-clobber` | **三条反例全部转正**（R1/R2/R3 皆"实例设置被保留 ✓"） |
| `20-contract-and-dsh` | **26 / 26 PASS** |
| `30-robustness` | **35 / 35 PASS**（仅 S10 CSP 已转派 ui-engineer） |
| `40-core-deep` | **16 / 16 PASS** |
| `41-core-perf-log` | **8 / 8 PASS**（含行为级轮转验证：12 次启动 → 保留 10 个日志） |
| `42-config-heal` | **7 / 7 PASS** |
| `43-resolve-command` | **4 / 4 PASS** |
| `50-status-recheck` | **12 项检查：已修复 11，仍存在 1**（仅 QR-17） |
| `51-registry-review` | **15 / 15 PASS**（QR-16 已修） |
| `52-broken-record-cleanup` | A1/A2/A3/B1/C2/D1 PASS；C1 FAIL（= QR-17） |
| `32-stop-verify` | **3 / 3 PASS** |

项目门禁：`tsc --noEmit` **exit 0**；`npm run build` 完成；`npm test` **13 文件 / 128 passed / 0 failed / 1 skipped**。

> 方法论提醒（本轮教训）：我最初用**源码模式匹配**判定修复状态，结果 QR-08/QR-10/QR-13 三项被误判为"仍存在"——实际实现已换成 `engineSizeCache` / `pruneOldLogs` / `removeOrphanSharedWorkspace`，我的旧正则匹配不到。全部改为**行为验证**（如"连跑 12 次看日志是否被截到 10 个"）后转绿。这也说明：修复状态的判定必须以行为为准，不能以关键字为准。

---

## 1. 已修复并实测验证的问题（保留编号，便于追溯）

### QR-01 `settings: 'shared'` 静默覆盖 / 删除实例既有设置 —— ✅ 已修复

| 项 | 内容 |
|---|---|
| 原文件 | `src/core/instance.ts` 的 `applyShareModesInternal` settings 分支（修复前 `:463-487`） |
| 复现脚本 | `node tests/e2e/11-repro-settings-clobber.mjs` |
| 修复前输出 | `[R1] 实例设置 "skin: mine" 被静默替换为 "skin: shared-theme\n"` ✗；`[R2] 实例设置被清空/删除`（文件已不存在）✗；`[R3] B 的 "owner: B" 被覆盖为 "owner: A"`，无备份无提示 ✗ |
| 修复后验证 | `tests/e2e/10-data-safety.mjs` 用例 I2 → **PASS**：`共享文件="owner: A\n" A实例="owner: A\n" B实例="owner: B\n"`（B 的本地值被保留） |
| 修复方式 | 新增显式冲突模型：`src/core/instance.ts:311-364` 的 `ShareConflict`、`listShareConflicts`、`clearShareConflicts`，以及 `use-local` / `use-shared` 解决路径（均先备份）；core 自带测试亦有覆盖 |

**残余问题（→ QR-15，P3）**：`src/renderer/**` 中检索 `problem|present` **未命中 `shareConflict`**。冲突已能在核心层记录与解决，但界面尚未显示它、也没有让用户选择"用共享覆盖本地 / 把本地推给共享"的入口。若 UI 不消费该 API，用户依然可能感知不到"本地与共享不一致"，QR-01 的修复效果在界面上打了折扣。

---

### QR-02 实例从界面"凭空消失" —— ✅ 已修复（Lead 定稿口径）

| 项 | 内容 |
|---|---|
| 原文件 | `src/core/instance.ts:103-105` `catch {}` 吞掉 `summarize` 的一切异常 |
| 定稿口径 | `instance.json` 损坏 / 被删 / 实例目录被删 → 记录**可见** + `problem` 标记（绝不静默丢弃）；`deleteInstance(id,false)` → 记录离开列表；`deleteInstance(id,true)` → 目录与索引一起清理 |
| 复现脚本 | `node tests/e2e/50-status-recheck.mjs`、`tests/e2e/51-registry-review.mjs` |
| 修复后验证 | `QR-02 异常实例从列表消失` → **已修复**：`元数据坏=true 清单坏=true 目录删=true`（返回 3 个，期望 3 个都可见）；`可读 problem 标记：3 条` → `["instance.json 损坏（无法解析）","profile 清单损坏（home/profiles/<p>/package.json 无法解析）","实例目录缺失（可能在文件管理器里被删除）"]` |
| 实现要点 | 新增 `<instances>/registry.json` 索引快照（`{schemaVersion, entries:[{id,dirName,meta}]}`）+ `InstanceSummaryExt.problem` 非契约扩展字段 |

**设计评估（Lead 指派题目，独立实测，不采信实现说明）**：见 `acceptance.md` §8。结论：**registry 机制是必要的**（纯目录扫描无法表达"记录存在但目录不在"），删除/导入路径维护正确、损坏容错、无重复条目；但发现新缺陷 **QR-16**（目录改名产生重复记录）。

---

### QR-03 `importPack` 绕过 YAML 校验 —— ✅ 已修复

- 原文件：`src/core/modpack.ts` 的 settings 还原段（修复前 `:186-189` 直接 `writeTextAtomic`）。
- 修复前证据：`R4c` → `导入成功且坏 YAML 已落盘："a: [1, 2\nb: }{ 这行非法\n"`。
- 修复后验证：`src/core/modpack.ts:188-196` 先 `validateYaml(settings)`，不合法则**跳过写入**并记 warning；`R4c` → 实测落盘内容为 `""`，PASS。
- `50-status-recheck.mjs`：`已修复 QR-03 importPack 绕过 YAML 校验 —— 写入前 validateYaml=true 不合法则跳过写入并记 warning=true`。

---

### QR-04 损坏的 `launcher.json` 无自愈路径 —— ✅ 已修复

- 原文件：`src/main/config.ts` 的 `loadConfig`（修复前直接 `core.readJson`，而 `readJson` 对坏 JSON 是**抛错**）。
- 修复前证据：`42-config-heal.mjs` 用例 K1 → FAIL，`launcher:getConfig` 会持续返回 error 且无恢复入口。
- 修复后验证：K1 → PASS（`loadConfig` 已有备份 + 恢复默认的兜底）。

---

### QR-06 降级路径下 `cmd.exe` 包装失效 → npm/pnpm 功能全废 —— ✅ 已修复

| 项 | 内容 |
|---|---|
| 原文件 | `src/core/proc.ts` 的 `wrapCmdShim`（修复前 `:102-106`） |
| 现象 | 管道被拒（EPERM）后降级到文件重定向路径时，spawn 的命令行为 `cmd.exe /d /s /c "C:\Program Files\nodejs\npm.cmd" "view" "x"` → cmd 报 `'"C:\Program Files\nodejs\npm.cmd"' is not recognized as an internal or external command`。**引擎安装、可安装版本列表、`dsh plugin add/remove` 在该环境下全部失败**，且报错完全不可读 |
| 我的独立矩阵实验 | `node tests/e2e/44-cmd-invocation-matrix.mjs`（A=旧实现 ✗ / B=整体再包一层引号 ✓ / C=不加引号 ✗ / D=`call` 前缀 ✗ / E=`shell:true` ✓ / F=直接 spawn `.cmd` ✗） |
| 修复后验证 | `43-resolve-command.mjs` → PASS：`resolveCommand` 现返回 `cmd.exe /d /s /c ""<file>" <args>""` **且 `verbatim:true`**；`windowsVerbatimArguments 覆盖 4/4 条 spawn 路径`；真实 `npm --version` 端到端输出正常 |
| 价值 | 这是**专门为受限环境写的降级路径**；修复前它在这类环境里等于完全不可用，与存在目的相反 |

> 说明：我此前把该问题定性为"P2（普通环境不受影响）"。core-engineer 的修复与我的矩阵结论一致（都指向"整体再包一层引号 + 必须配合 `windowsVerbatimArguments`"），修复完整覆盖了管道与降级两条路径。

---

### QR-14 渲染层 `html` 属性通道直通 `innerHTML` —— ✅ 已随 T6 重写消失

- 修复前：`src/renderer/util/dom.ts:46-49` 的 `html` 通道直通 `innerHTML`（**当时无任何调用方**，属死代码风险）。
- T6 重写后：`tests/e2e/30-robustness.mjs` 用例 S9b → PASS：`html: 仅存在于 util/dom.ts 定义处，无视图使用 → 当前无实际 XSS`。

---

### QR-00（原 P0）`npm test` 完全跑不起来 —— ✅ 已修复

- 修复前证据：`npm --cache F:\WhalesLauncher\.npm-cache test` → 8/8 文件 `Error: spawn EPERM`（`node --test` runner 为每个文件 spawn 带管道 stdio 的子进程，被文件沙箱拒绝）；另有 Node 26 strip-only 模式不支持参数属性（`class FileTail` 的 `constructor(private readonly …)`）。
- 修复后验证：`npm --cache F:\WhalesLauncher\.npm-cache test` → **12 个测试文件全部通过、0 失败、1 跳过**，逐文件累计 `--- 104 passed, 0 failed, 1 skipped（4.9s）`，退出码 **0**。

---

## 2. 已修复并实测验证（QR-16）

### QR-16 实例目录被改名 / 复制后出现**重复记录** —— ✅ 已修复

| 项 | 内容 |
|---|---|
| 原文件 | `src/core/instance.ts` 的 `collectInstances`（目录扫描 + registry 合并逻辑） |
| 修复前证据 | `51-registry-review.mjs` 用例 6 / 6b → FAIL：`目录改名后列表返回 2 个：["r","r"]`；`出现重复 id：列表 2 条但有 1 个唯一 id` |
| 修复后验证 | `node tests/e2e/51-registry-review.mjs` → **15 / 15 PASS**（0 失败）。用例 6/6b 由 FAIL 转 PASS |
| 修复方式 | 按 **id** 而非 `dirName` 去重；同名冲突时以**目录实际存在者**为准；不一致情形走 `problem` 标记呈现为**一条**记录 |

**原始缺陷的最小复现（修复前）**

1. 建实例（`dirName = "r"`）→ `registry.json` 记 `{id: X, dirName: "r"}`
2. 在资源管理器里把 `instances/r` 改名为 `instances/r-renamed`
3. `core.listInstances(root)`
4. 修复前返回**两条** `{id: X, dirName: "r", present: false}`（一条来自改名后目录里 `instance.json` 的旧 `dirName`，一条来自 registry 快照），而**真正可用的那个目录在界面上完全不可见**

**为什么曾是真问题**

用户只需在资源管理器里重命名一个文件夹就能踩到。表现是"列表里出现两个坏掉的同名实例，而我的实例不见了"——典型的"看起来像数据丢失"。

**修复要求（我给出的建议，已被采纳）**

1. `collectInstances` 以 **id** 为主键去重，保证同一实例只出一条；两个来源冲突时以**实际存在的目录**为准（目录存在即 `present: true`）；
2. 当"实际目录名 ≠ `meta.dirName`"时用 `problem` 机制标记，作为**一条**记录呈现；
3. 修复动作保持显式，**不静默改元数据**——`dirName` 同时是 dsh profile 名与共享目录键。同类风险也适用于"把实例目录复制一份"。

**修复建议**

1. `collectInstances` 以 **id**（而非仅 `dirName`）为主键去重，保证同一实例只出一条；两个来源冲突时以**实际存在的目录**为准（目录存在即 `present: true`）；
2. 当"实际目录名 ≠ `meta.dirName`"时，用已有的 `problem` 机制标记（例如"目录名与记录不一致（可能被改名），建议改回 `<dirName>` 或在此修复"），作为**一条**记录呈现；
3. 修复动作必须显式（改回原名，或让用户确认把 `meta.dirName` 更新为新名），**不要静默改元数据**——`dirName` 同时是 dsh profile 名与共享目录键，静默改名会牵动会话路径与共享链接。

---

### QR-05 `listAvailableEngines` 的 npm 缓存根目录不再依赖 `process.cwd()` —— ✅ 已修复

| 项 | 内容 |
|---|---|
| 原问题 | `src/core/index.ts` 丢弃 root 参数 + `src/main/ipc.ts:189` 只传 registry → `defaultRootForCache()` 回退 `process.cwd()`，且 `WHALES_LAUNCHER_ROOT` 全仓库无人赋值 |
| 修复后验证 | `src/main/index.ts:53-70`：启动时把 `launcherRoot()` 钉进 `$WHALES_LAUNCHER_ROOT`（并在覆写时 `console.warn` 记录原值）；`src/core/index.ts:126` 同时保留了 root 透传 |
| 判定 | **PASS**。两条路径任一成立即可消除该风险，当前两条都在：环境变量锚定（覆盖所有 `defaultRootForCache` 调用点）+ 显式参数透传 |

> 已由 shell-engineer 完成。

---

## 3. 仍未闭环的 P2 问题（QR-17，唯一一项）

### QR-17 界面不消费 `problem` 字段 —— "坏记录可见"在 UI 上不可见（P2，新发现，**未闭环**）

| 项 | 内容 |
|---|---|
| 涉及 | `src/renderer/**`（36 个 `.ts` 文件）；core 侧字段为 `src/core/instance.ts` 的 `InstanceSummaryExt.problem` |
| 证据 | `node tests/e2e/52-broken-record-cleanup.mjs` 用例 C1 → **FAIL**（审查末期重测仍 FAIL） |
| 原始输出 | `[info] 该条目的 problem="instance.json 损坏（无法解析）"`，但 `界面上能看到的信号：present=true（renderer 只看 present，不读 problem）`；`扫描 36 个渲染层文件：提到 problem 的=0` |

**问题链（已实测确认每一环）**

1. core 侧的修复**本身是好的**：`instance.json` 损坏时记录仍可见（A1 PASS）、能用该 id 解析回元数据（A2 PASS）、能正常删除并清理目录（A3 PASS）。
2. 但渲染层**完全不读 `problem`**，只判断 `present`（`src/renderer/context.ts:31`、`views/instances.ts:177/256/342/366`、`views/detail.ts:106-107/145`）。
3. 于是 `instance.json` 损坏的实例在界面上呈现为**一张完全正常的卡片**（`present=true`，无徽标、无警告）；用户唯一能做的操作是"启动"，而启动只会得到一句底层报错（实测 D1：`引擎 1.2.3-not-installed 未安装，无法启动实例 launchbad`）。

**为什么是问题**

Lead 定稿口径是"记录可见 + 带 `problem` 标记"，意图是让用户**知道**出了什么问题。当前只实现了一半：记录不再消失（比"凭空消失"好得多），但用户面对一个"看起来正常却怎么都启动不了"的实例，无从判断原因，也不知道该删掉重来。对"简单易用 / 无 bug"的硬要求而言，这是可见的体验缺口。

**修复建议**（工作量很小）

1. 在实例卡片与详情页把 `summary.problem` 渲染成 warning 徽标（复用 `views/instances.ts:366` 已有的 `badge('目录缺失','warning')` 位置）；
2. `views/instances.ts:177` 的 `attention` 判定纳入 `problem`，让"需要关注"筛选能筛出这类实例；
3. 这类实例的启动按钮保持禁用或加 `title` 说明，避免用户点一次只拿到底层报错。

---

## 4. P3 建议 —— 已全部闭环（保留编号便于追溯）

| 编号 | 原现象 | 闭环情况（均为审查末期实测） |
|---|---|---|
| QR-08 | `listEngines` 对每个引擎递归算目录大小；真实 dsh 安装 **26513 文件 / 551.1 MB**，一次 `dirSize` **1375ms** | ✅ **已修**：`engineSizeCache` + mtime 签名 + `lazyEngineSize`（首次返回 `null`、后台 `void computeEngineSize` 单飞）。实测 `41-core-perf-log.mjs` P6 → `listEngines 对真实尺度引擎的耗时 —— **2ms**，sizeBytes=null` |
| QR-09 | `void appendFile(...)` 发后不管，无背压 | ✅ **已修**：改为单写者队列 + 自动合并。`41-core-perf-log.mjs` L11 → `已改为串行化写入（单写者队列=true）` PASS |
| QR-10 | 日志无轮转/上限 | ✅ **已修**：`pruneOldLogs` + `MAX_LOG_FILES`。**行为级验证**：连跑 **12 次**启动后仅保留 **10** 个 `.log`（`41-core-perf-log.mjs` L10 PASS） |
| QR-11 | 正式包 `devTools` 恒开 | ✅ **已修**：生产默认关闭，三处入口同源且空动作不抛错 |
| QR-12 | 可切到未安装的引擎版本 | ✅ **已修**：硬拒绝（`50-status-recheck.mjs` → 已修复；`engineInstalled` 恒真成为可测不变量） |
| QR-13 | 删除实例后共享目录残留 | ✅ **已闭环（方案被我的用例改写）**：我构造的 `10-data-safety.mjs` D1 用例证明"实例内 junction 反向穿透"的风险后，core **放弃了自动清理**，改成"报告 + 显式清理入口"：`deleteInstanceDetailed`（报告残留）、`findOrphanSharedWorkspaces`（列出）、`removeOrphanSharedWorkspace`（仅清理无人认领者，带认领校验）。**结论：自动删除共享数据比残留更危险，当前方案更安全** |
| QR-18 | `registry.json` 丢失 **且** 实例目录被外部删除时记录不可达 | **按设计接受**：`registry.json` 每次扫描都会重建，"双重丢失"属可接受降级；自建启动器无历史版本，不存在旧版升级路径 |

> 已闭环并移出清单：**QR-15**（共享设置冲突的 UI 消费）—— 复核确认渲染层已实现：`src/renderer/data/share-conflicts.ts`（`conflictApi()` 检测 `settings.shareConflicts` / `settings.resolveShareConflict`）、`data/store.ts`（`conflictsOf` / `resolveConflict`）、`views/detail/settings.ts`（`resolveConflict(resolution)`），全文命中 `ShareConflict` 36 处。此前误报源于我的检查脚本正则写错（`\b` 用法），已修正。

> **本轮教训（方法论）**：QR-08/QR-10/QR-13 我最初用**源码关键字匹配**判定，结果误报为"仍存在"——实际实现已换成 `engineSizeCache` / `pruneOldLogs` / `removeOrphanSharedWorkspace`。改用**行为验证**（连跑 12 次看日志数、看 `listEngines` 返回的 `sizeBytes`）后全部转绿。修复状态的判定必须**以行为为准**，不能以关键字为准。

---

## 5. 已确认**没有**问题的项（避免后人重复怀疑）

全部为实跑结论（详见 `acceptance.md`）：

| 检查点 | 结论 |
|---|---|
| `removeLink`（真实目录 / junction） | 真实目录只返回 `false` 不动数据；junction 摘链不伤目标 |
| `replaceWithJunction` 覆盖真实目录 | **拒绝**并抛可读错误，数据保留 |
| `local ↔ shared` 双向切换 | 本地内容先并入共享库，不删除；切回时共享库完好 |
| `deleteInstance(true)` / 实例内 junction | 不穿透 junction，**外部数据完好**（含我额外构造的 `home/`、`workspace/` 内 junction 用例） |
| 卸载"以 junction 接入"的引擎 | 真实全局 dsh 安装不受影响 |
| `deleteInstance(false)` | 数据保留、记录离开列表（契约 `remove` 语义） |
| 原子写 | 同目录临时文件 + `rename`；无残留；失败时清理；经链接写入落真实文件 |
| 共享目录同名冲突 | 保留双方数据并**报错**（非静默覆盖） |
| 异常实例降级呈现 | 元数据坏 / 清单坏 / 目录删 → 三者皆可见 + 可读 `problem` |
| `registry.json` | 删除与导入路径维护正确、无重复条目、损坏时目录扫描兜底 |
| `workspaceKeyFor` | 与真实 dsh 会话目录名**逐字节一致**（3/3） |
| `compareVersions` | 5/5 符合 semver；排序把最新版排首位 |
| `CoreApi` / `CH` / `WhalesApi` | 39 个 core 方法、27 条 invoke 通道、27 个 preload 方法**逐条覆盖**，无缺无多 |
| 不 import dsh 内部 API | 扫描 55 个源文件，**0 命中** |
| `DSH_HOME` + `cwd` 注入 | 子进程现场实测一致；profile 落在实例 home 内、无泄漏 |
| profile 名校验 | 用**真实 dsh** 逐条比对 16 个名字；危险方向 **0 例**；`desktop` 大小写不敏感拒绝 |
| 插件增删 | 实测走 `dsh plugin --profile <p> add <spec>`；失败报错含退出码；不改写 `package.json` |
| `cordis.patch.yml` | 非空校验 + `.bak-<毫秒>` 备份（`rename`） |
| 安全基线 | `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity` 未关、禁 webview/新窗口、`openExternal` 仅 http/https、`openFolder` 白名单、IPC 参数全校验 |
| XSS 面 | 无"外部数据 → innerHTML"写入点；日志走文本节点；`on*` 只接受函数 |
| 健壮性 | 非法版本号/未知模板/非法包名/非法 YAML/非 zip/schema 过新/zip-slip（两种构造）/npm 断网/`registry.json` 损坏 —— 全部被拒绝或降级且报错可读 |
| 性能（列表） | 60 实例（各 120 会话文件）`listInstances` **38ms**；`summarize` 不做递归目录大小；会话枚举 0ms |
| 日志内存 | 渲染层环形缓冲 `capacity=4000` + DOM `MAX_RENDERED` 裁剪 |

---

## 6. 无法验证项

| 编号 | 项 | 原因 + 证据 |
|---|---|---|
| NV-01 | `stopInstance` 是否真杀掉进程树；`killTree` / `forceKillLeftovers` 的孤儿进程防护 | 本沙箱 `taskkill /PID <pid> /T /F` 返回 **exit 1「Access denied」**，目标进程继续存活（`tests/e2e/31-stop-probe.mjs` 原始证据；对照组自建 detached 进程同样杀不掉）。副作用：`stopInstance` 必然走满 15s+5s 兜底并返回 `"停止超时，已强制结束进程树"`，而进程其实还活着。**建议真实桌面环境手测**：启动实例 → 关闭启动器 → 任务管理器确认无残留 `node` |
| NV-02 | Mica/WCO 等 Windows 视觉效果的"美观度" | 属实机肉眼判断，超出代码审查能力；Lead 已用 CDP 截图确认 |
| NV-03 | 真实 dsh 的完整启动链路（登录、调模型、多插件共存） | 受"不得触碰真实 `~/.dsh`"边界约束，只用 stub 引擎 + 真实 dsh 的 `--dump-config`（非交互、不调模型）校验 |

---

## 7. 审查边界与数据安全声明

- 破坏性实验全部在 `F:\WhalesLauncher\.spike\qa-*` 内，用 `fs.mkdtemp` 生成独立临时根。
- **未触碰** `C:\Users\user\.dsh`：核对 → `~/.dsh/profiles` 仅含 `web`，无 QA 新增目录。
- 交付目录 `instances/` 含 Lead 实机验证实例（`主力工作台`、`批量任务`）；核查确认其中**无任何 QA 前缀产物**。
- **未修改** `src/**`、`package.json`、`scripts/build.mjs`、`src/shared/contracts.ts`。QA 写作用域仅 `docs/review/**` 与 `tests/e2e/**`。
- 审查期间的探针曾在 `.spike` 下创建带尾随点的目录（Windows 无法常规删除），已用 `\\?\` 前缀路径清理完毕。

---

## 8. 复现指引

```powershell
# 工程基线
node node_modules/typescript/bin/tsc --noEmit
npm --cache F:\WhalesLauncher\.npm-cache run build
npm --cache F:\WhalesLauncher\.npm-cache test

# QA 全部用例（进程内加载，不依赖 node --test 的 runner）
node tests/e2e/run-all.mjs

# 单跑（推荐：逐套单跑可避免长时间运行被并行构建干扰，也便于定位）
node tests/e2e/00-smoke.mjs                  # core 契约方法覆盖
node tests/e2e/10-data-safety.mjs            # 数据安全（13 例）
node tests/e2e/11-repro-settings-clobber.mjs # QR-01 最小复现（修复后三条全部"被保留 ✓"）
node tests/e2e/20-contract-and-dsh.mjs       # 契约 + 真实 dsh 行为比对（26 例）
node tests/e2e/30-robustness.mjs             # 健壮性/性能/安全（35 例）
node tests/e2e/31-stop-probe.mjs             # 沙箱限制留证：taskkill 被拒
node tests/e2e/32-stop-verify.mjs            # stopInstance 实杀验证（3 例）
node tests/e2e/40-core-deep.mjs              # junction 安全 / 版本比较 / root / 组合包（16 例）
node tests/e2e/41-core-perf-log.mjs          # 真实尺度性能 + 日志轮转行为验证（8 例）
node tests/e2e/42-config-heal.mjs            # 配置自愈 + 实例消失（7 例）
node tests/e2e/43-resolve-command.mjs        # .cmd 垫片解析（4 例）
node tests/e2e/44-cmd-invocation-matrix.mjs  # cmd.exe 调用形态矩阵（实验留证）
node tests/e2e/50-status-recheck.mjs         # 逐项对当前代码重新判定修复状态
node tests/e2e/51-registry-review.mjs        # registry.json 设计评估 + QR-16 复现（15 例）
node tests/e2e/52-broken-record-cleanup.mjs  # 坏记录可见性/可清理性 + QR-17
```

> 注：`run-all.mjs` 会依次加载全部用例集。若同时有其他人在跑构建/测试（会清理 `dist/` 或争抢 `.spike/qa-*`），建议改用上面的**逐套单跑**——本轮最后的权威结果就是这样测出来的。
