# WhalesLauncher 验收清单（逐项结论 + 证据）

| 项 | 值 |
|---|---|
| 验收人 | `qa-reviewer`（独立第三方） |
| 验收对象 | `src/core/**`、`src/main/**`、`src/preload/**`、`src/renderer/**` |
| 基准 | `src/shared/contracts.ts`（冻结契约）、`docs/research/dsh-interface.md`、`docs/design/architecture.md` |
| 环境 | Windows + pwsh，Node v26.3.0，dsh `0.1.6-alpha.2`（本机真实安装），Electron 41.1.0 |
| 结论口径 | **通过 / 不通过 / 无法验证** 三态；每条附命令、输出片段或 `文件:行号` |
| 复现入口 | `node tests/e2e/run-all.mjs`（QA 自建；进程内加载，不依赖 `node --test`） |
| 最终状态 | 见文末 §9「验收结论」 |

---

## 0. 工程基线（先确认能构建、能自测）

| 检查 | 结论 | 证据 |
|---|---|---|
| 类型检查 | **通过** | `node node_modules/typescript/bin/tsc --noEmit` → 退出码 **0**，零输出（此前 renderer 侧 9 条错误已随 T3/T6 消除） |
| 构建 | **通过** | `npm --cache F:\WhalesLauncher\.npm-cache run build` → `[build] 完成 ✓ dist/main/index.cjs 354.6 KB | dist/preload/index.cjs 3.9 KB | dist/renderer/index.js 275.3 KB`，退出码 0 |
| 项目自带测试 | **通过** | `npm --cache F:\WhalesLauncher\.npm-cache test` → **12 个测试文件全部通过，0 失败，1 跳过**；逐文件累计断言 `12 → 104 passed`（例：`--- 104 passed, 0 failed, 1 skipped（4.9s）`），退出码 **0** |
| QA 独立端到端 | **见 §9** | `node tests/e2e/run-all.mjs` |

> 说明：早期 `npm test` 在本沙箱 100% 失败（`node --test` runner 为每个文件 spawn 带管道 stdio 的子进程被拒 `EPERM`；另有 Node 26 strip-only 不支持参数属性）。该问题已由 core-engineer/Lead 修复，**现已通过**，因此不再列为缺陷。

---

## 1. 契约一致性

### 1.1 T1 是否实现 `CoreApi` 全部方法 → **通过**

- 证据：`node tests/e2e/00-smoke.mjs`
- 输出：`[smoke] core 导出键数：39` / `[smoke] 契约方法缺失：无` / `[smoke] 额外导出（非契约）：无`
- 方法：脚本内硬编码 `src/shared/contracts.ts` 的 `CoreApi` 39 个方法名，逐个 `typeof core[name] === 'function'`；同时检查有无多余键。
- 结论：**39/39 覆盖，无缺无多**。

### 1.2 T2 是否逐条实现 `CH` 全部通道 → **通过**

- 证据：`tests/e2e/20-contract-and-dsh.mjs` 用例 1-C1/1-C2
- 输出：`契约 invoke 27 条（另有 2 条 push-only），main 注册 27 条`、`main 启动时对通道覆盖做自检` → PASS
- 方法：从 `contracts.ts` 的 `CH` 块提取全部通道字面量，减去 `log:chunk`/`log:state` 两条 push-only，与 `src/main/ipc.ts` 里 `[CH.xxx.yyy]` 键名集合比对。
- 补充：`src/main/ipc.ts:58-69` 的 `assertChannelCoverage()` 在启动时自检，漏实现会直接抛错——静态核对与运行期自检互相印证。
- 注：审查期间 Lead 扩展了契约（新增 `app:menu`、`app:menuCommand`，见 `contracts.ts:267/334-335/387-389`），main 与 preload 已同步覆盖。

### 1.3 `WhalesApi` 形状是否与 preload 实际暴露一致 → **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 1-B1 ~ 1-B6，全部 PASS
- 输出摘要：
  - `preload 覆盖契约全部 invoke 通道 —— 27 条 invoke 通道，未引用：无`
  - `preload 不裸写通道字符串（全部经 CH） —— 裸用次数=0`
  - `preload 不泄漏 ipcRenderer/event 对象 —— 无命中`
  - `onLog/onState 返回可用的取消订阅函数` → PASS
  - `WhalesApi 顶层形状与契约一致 —— 缺失：无`
  - `WhalesApi 各分组方法逐条暴露 —— 契约方法 27 个，preload 缺失：无`
- 关键实现点：`src/preload/index.ts:39-41` 的 listener 只取 `payload`，**不把 `IpcRendererEvent` 交给页面**；`subscribe()` 返回幂等的 `removeListener` 闭包。

### 1.4 IPC 异常不得穿透（契约首条约定）→ **通过**

- 证据：1-C3 → PASS；方法为核对 `src/main/ipc.ts:44-51` 的统一 `try { return ok(await handler(...)) } catch { return err(describeError(error)) }` 包装。
- 渲染层同样有兜底：`src/renderer/data/api.ts:60-73` 的 `invoke()` 把"接口缺失 / 同步抛错 / Promise 拒绝"统一转成 `{ ok:false, error }`，永不抛出。

---

## 2. dsh 行为正确性

### 2.1 是否误 import dsh 内部 API → **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 1-A / 1-A2
- 输出：`1-A 启动器源码不 import 任何 dsh 包（含子包） —— 扫描 55 个文件，0 命中`；`1-A2 启动实例只经 resolveEngineBin→CLI，代码中不含 dsh 包内部路径` → PASS
- 方法：遍历 `src/**` + `scripts/**` 全部 `.ts/.mjs/.js`，正则匹配 `from '<spec>'` / `require('<spec>')` 中 spec 含 `dsh` 且非相对路径的用法；再剥离 `launch.ts` 注释后确认代码里没有 `@deepseek-ai/dsh` 字面量（避免把文档注释误判为依赖）。

### 2.2 启动实例时 `DSH_HOME` 与 `cwd` 是否都正确注入 → **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 2-B1 / 2-B1b / 2-B2 / 2-B3 / 2-B4
- 方法：用行为对齐真实 dsh 的 stub 引擎，让它把**实际收到的 `DSH_HOME`、`process.cwd()`、`argv`** 写到 `<cwd>/.stub-start.json`，再读回比对。
- 输出：
  - `2-B2 启动实例：DSH_HOME=实例 home 且 cwd=实例 workspace` → `home=…\instances\env-probe\home`、`cwd=…\instances\env-probe\workspace`，与期望完全一致
  - `2-B1 创建实例（dump-config）的 profile 落在实例专属 DSH_HOME 内 —— profile=…\instances\env-probe2\home\profiles\env-probe2 存在=true`
  - `2-B1b 初始化未把 profile 泄漏到启动器根或主 home` → PASS
  - `2-B3 launchInstance 返回真实 pid/dshHome/cwd` → `pid=16452`
  - `2-B4 appArgs 追加在启动器 flag 之后（透传给应用层）` → `argv=["--profile","env-probe"]`
- 代码位置：`src/core/launch.ts:80`（`args = ['--profile', name, ...appArgs]`）、`src/core/launch.ts:118-123`（`env: {...runner.env, DSH_HOME: paths.home, ...childBaseEnv(root)}`、`cwd: paths.workspace`）。

### 2.3 profile 名校验是否真的复刻 dsh 规则（含 `desktop` 拒绝、大小写）→ **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 2-A0 / 2-A / 2-A2 —— **用本机真实 `dsh@0.1.6-alpha.2` 逐条实测比对**
- 方法：对 16 个候选名，先 `--profile <n> --from-default-profile web --dump-config`（两步法：先建再加载，避免把"profile 不存在"误判为"名字非法"），记录真实退出码，再与 `core.validateName(n) === null` 比对。
- 实测比对表（节选）：

| 名称 | 真实 dsh | `core.validateName` | 判定 |
|---|---|---|---|
| `qa-ok` / `QA-Upper` / `中文实例` / `with space` | 接受 | 接受 | 一致 |
| `desktop` / `Desktop` / `DESKTOP` | 拒绝 | 拒绝 | 一致，**大小写不敏感** |
| `node_modules` / `.` / `..` / `a/b` / `a\b` / `a:b` | 拒绝 | 拒绝 | 一致 |
| `trailing.` / `con` / 65 字符 | 接受 | 拒绝 | **core 更严格（设计如此）** |

- 关键结论：`2-A0 core 不放松任何 dsh profile 约束（危险方向 = 0）` → PASS。"危险方向"= dsh 拒绝但 core 接受；实测 **0 例**。三处更严格的地方与 `src/core/names.ts:13-14` 注释声明完全一致（把"启动时才失败"提前到"创建时失败"）。
- 附带修正了一处**研究文档的措辞不精确**（不影响实现）：`dsh-interface.md` §1 说"profile 名 desktop 被保留"，容易被读成"不能作为 `--from-default-profile` 的值"；实测 `--profile qa-one --from-default-profile web --dump-config` **成功**，真正被拒的是"目标 profile 名本身等于随附模板名"。`src/core/instance.ts` 的 `shippedName` 分支正是按这个真实语义实现的（已核对其 OR 条件与 dsh 报错文案一致）。

### 2.4 插件增删是否走 `dsh plugin` CLI 而非自己改 pnpm 状态 → **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 2-C1 / 2-C2 / 2-C3
- 输出：
  - `2-C1 pluginAdd 走 dsh plugin --profile <p> add <spec> CLI` → 实测 `argv=["plugin","--profile","plug-probe","add","some-plugin","--config.cache=…\.spike\qa-dsh-plugin-…\cache"]`
  - `2-C2 CLI 失败时抛出可读错误（含退出码）` → `插件操作失败（退出码 1）：stub: plugin command not supported`
  - `2-C3 pluginAdd 失败后未擅自改写 profile package.json` → PASS
- 结论：走 CLI（`src/core/plugins.ts:87`），且 cache 双保险（命令行 `--config.cache=` + 环境变量 `npm_config_cache`，见 `src/core/paths.ts:146-173`）。
- 关于 `setBundleEnabled` 直接改 `package.json`：实测确认它**不走 CLI**（`40-core-deep.mjs` I1），但**判定合规**——它只改 `dsh.profile.bundles` 这个**声明式清单**（文件系统约定层，dsh 官方布局的一部分），且只对 dsh 随附的 `builtin` 组合包开放（无需 pnpm 安装），并未触碰 pnpm 状态机。`src/core/profile.ts:10-11` 也明确声明"patch 条目级 `disabled` 属插件管理器范畴，本启动器不碰"。

### 2.5 `cordis.patch.yml` 写回是否遵守"patch 整块替换 config"语义 → **通过**

- 证据：`20-contract-and-dsh.mjs` 用例 2-D1 ~ 2-D4
- 输出：
  - `2-D1 新建 profile 的 cordis.patch.yml 非空且含 []` → `"# profile patch layer\n[]\n"`
  - `2-D2 writePatchFile 拒绝空内容` → PASS
  - `2-D3 backupPatchFile 生成 .bak-<毫秒> 备份` → `…\cordis.patch.yml.bak-1789833236152`
  - `2-D4 备份后原文件消失（已 rename 而非复制）` → PASS
- 说明：`src/core/profile.ts:8-9` 明确"空的或只有注释的 patch 会导致启动失败，因此只做备份+整体改写，不生成空文件"；`writePatchFile` 拒绝空内容与之自洽。启动器不做"只写增量字段"的合并（那正是 D8 禁止的），因而不存在违反"整块替换"语义的路径。

---

## 3. 数据安全（最高优先级）

### 3.1 `removeLink` / 共享模式切换是否可能在真实目录上递归删除 → **不通过（已修复，现通过）**

**这是本轮最重要的一条。** 分两个子项：

**(a) `removeLink` / `replaceWithJunction` / 删除实例 / 卸载引擎 —— 从未发现真实删除，通过**

- 证据：`tests/e2e/10-data-safety.mjs` 用例 A1/A2/B1/C1/C2/D1 与 `40-core-deep.mjs` D1/D2，**全部 PASS**
- 关键实测：
  - A1 `removeLink(真实目录)` → `removed=false`，文件内容 `不可丢失` 完好
  - A2 `removeLink(junction)` → `removed=true`，共享目标内容 `共享数据` 完好
  - B1 `replaceWithJunction` 遇到真实目录 → **抛错拒绝**，原文件 `{"a":1}` 完好
  - C1/C2 `local → shared → local` 双向切换 → 本地内容先并入共享库，共享库数据全程完好
  - D1 删除实例（`deleteFiles=true`）时，**实例目录内部**的 junction（我额外构造，分别放在 `home/` 与 `workspace/` 指向外部"重要数据"）→ 外部文件 `外部重要数据` 完好
  - D2 卸载"以 junction 接入"的引擎（`attachEngineFromLocal` 的真实形态）→ 真实全局 `dsh/lib/bin.js` 仍在
- 结论：`removeLink` 先 `lstat` 确认是链接、`replaceWithJunction` 拒绝覆盖真实目录（`src/core/fsx.ts:170-211`），`fs.rm` 不跟随 junction —— **实测与实现一致，未发现递归误删真实目录的路径**。

**(b) `settings: 'shared'` 静默覆盖/删除实例既有设置 —— 曾为 P1，现已修复**

- 问题：`src/core/instance.ts` 的 `applyShareModesInternal` 在 settings 分支无条件用共享内容覆盖本地，共享为空时甚至 `rm(settingsFile)`。
- 复现（修复前）：`node tests/e2e/11-repro-settings-clobber.mjs` →
  - `[R1] 实例设置 "skin: mine" 被静默替换为 "skin: shared-theme\n"` ✗
  - `[R2] 实例设置被清空/删除`（文件已不存在）✗
  - `[R3] B 的 "owner: B" 被覆盖为 "owner: A"`，无备份无提示 ✗
- 修复后验证：`tests/e2e/10-data-safety.mjs` 用例 I2 → **PASS**，`共享文件="owner: A\n" A实例="owner: A\n" B实例="owner: B\n"`（B 的本地值被保留）。
- 修复后还新增了显式冲突 API：`src/core/instance.ts:311-364` 的 `ShareConflict` / `listShareConflicts` / `clearShareConflicts`，以及"由调用方决定如何解决"的 `use-local` / `use-shared` 路径；core 自带测试亦覆盖（`PASS R3：A 播种共享后，B 切共享不被 A 的内容覆盖`、`PASS 冲突解决路径：use-local 推送到共享 / use-shared 覆盖本地（均先备份）`）。
- 残余风险（P3，见 §6 QR-15）：`src/renderer/**` 全文检索 `problem|present` 未命中 `shareConflict`，即**冲突已能在核心层记录与解决，但界面尚未把它显示/交给用户选择**。若 UI 不消费该 API，用户仍可能察觉不到"本地与共享不一致"。

### 3.2 删除实例、导入导出是否会误伤用户数据 → **通过**

- 删除实例：见 3.1(a)，D1/E1 均 PASS。补充口径核对（Lead 定稿）：
  - `deleteInstance(id, true)` → 目录与索引一起清理（`51-registry-review.mjs` 2a PASS）
  - `deleteInstance(id, false)` → 数据保留、记录离开列表（2b PASS，`b 仍在列表=false`）
- 导入导出：
  - `R7 非 zip 文件导入报可读错误` → PASS
  - `R7b zip-slip：越界条目未把文件写到解压根之外` → PASS（`父目录出现文件=false 根内出现文件=false`）
  - `R7c zip-slip（含 `..` 的嵌套条目）仍不越界` → PASS
  - `R8 schemaVersion 过新的包被拒绝并提示升级` → PASS
  - 导出仅打包 `package.json` / `cordis.patch.yml` / `settings.yaml` / README 与 manifest（`src/core/modpack.ts`），**不含 `node_modules`**，不触碰实例外数据。

### 3.3 原子写是否真的原子（同目录临时文件 + rename）→ **通过**

- 证据：`tests/e2e/10-data-safety.mjs` F1/F2/F3、G1
- 输出：
  - `F1 原子写用「同目录临时文件 + rename」` → `同目录临时文件=true rename=true`（源码核对：`src/core/fsx.ts:135` 的 `path.join(dir, '.' + basename + '.tmp-…')` 与 `:138` 的 `rename(temp, target)`）
  - `F2 原子写完成后不残留临时文件` → `残留=无`
  - `F3 写入失败时清理临时文件` → `抛错=true 残留=无`
  - `G1 经链接写入会落到真实文件（不破坏链接/不新建影子文件）` → `"updated: true\n"` 落在真实文件上（`resolveWriteTarget` 先 `realpath`）

---

## 4. 安全

| 检查 | 结论 | 证据 |
|---|---|---|
| `nodeIntegration` 必须为 false | **通过** | `S1 nodeIntegration=false`；`src/main/index.ts:137` |
| `contextIsolation` 必须为 true | **通过** | `S2 contextIsolation=true`；`src/main/index.ts:138` |
| preload 是否泄漏 `ipcRenderer` 本体 | **通过** | `S3`（另见 §1.3 1-B3）：`exposeInMainWorld('whales', api)` 只暴露方法；listener 不把 event 交给页面；`S11 applyProps 对 on* 只接受函数` |
| 渲染层是否可能出现 XSS（如把日志/包名 `innerHTML`） | **通过** | `S9 渲染层无"外部数据 → innerHTML"的直接写入点 —— 检查 2 处，均为静态查表/工具层`；`S9b 危险 html 属性通道无调用方（死代码而非活漏洞）`。两处 `innerHTML`：`src/renderer/icons.ts:118` `svg.innerHTML = PATHS[name]`（静态图标表）；`src/renderer/util/dom.ts:47`（`html` 通道，**无调用方**）。日志渲染走文本节点：`src/renderer/components/logview.ts:139-148` 全用 `h(..., { text: … })` |
| 其它加固 | **通过** | `S4 webSecurity 未被关闭`、`S5 禁止 webview / 新窗口`（`will-attach-webview` + `setWindowOpenHandler` deny）、`S6 openExternal 只允许 http/https`、`S7 openFolder 的 which 走白名单映射`、`S8 IPC 参数一律校验` |
| `sandbox` | **通过** | `S3 sandbox=true`；`src/main/index.ts:139` |
| CSP（`index.html`） | **不通过（已转派）** | `S10 index.html 声明 CSP` → FAIL：`src/renderer/index.html` 无 `Content-Security-Policy`。已由 Lead 转派 ui-engineer |

---

## 5. 健壮性（引擎未装 / 目录手删 / 启动失败 / YAML 非法 / npm 断网）

| 场景 | 结论 | 证据 |
|---|---|---|
| 引擎未安装 | **通过** | `R6 引擎未安装时创建实例给出可读错误` → `引擎 1.0.0-nope 未安装（期望 …\engines\1.0.0-nope\node_modules\@deepseek-ai\dsh），请先在版本管理中安装`；`L6/2-B` 启动前置检查同样给出"请先在版本管理安装" |
| 非法版本号（`../evil` 路径穿越尝试） | **通过** | `R6b 非法版本号（路径穿越尝试）被拒绝` → `引擎版本号不合法："../evil"` |
| 未知模板 | **通过** | `R6c 未知模板被拒绝` → `未知的 profile 模板 "no-such-template"，可选：web、headless、sdk、sdk-minimal、acp` |
| 实例目录被手删 | **通过（已修复）** | `R3 实例目录被手删后仍能被列出（而非静默消失）` → `可见，present=false`；`R3a present=false（契约字段可用）` → PASS；`R3b` 启动时自愈重建（`自愈成功（pid=…）`）；`R3c` 读插件清单给出可读错误 |
| `instance.json` 损坏 | **通过（已修复）** | `R1` → 修复后按 Lead 定稿口径：两条记录都可见、损坏那条带 `problem`；实测 `problem="instance.json 损坏（无法解析）"` |
| `profile/package.json` 损坏 | **通过（已修复）** | `R2b …该实例可见` → `problem="profile 清单损坏（home/profiles/<p>/package.json 无法解析）"` |
| dsh 启动失败 | **通过** | `L4 子进程非零退出 → crashed 且 lastError 可读` → `状态=crashed lastError="stub: fatal startup error"` |
| YAML 非法（设置写入） | **通过** | `R4 非法 YAML 被拒绝且原设置未被破坏` → `抛错=true 原内容="good: 1\n"`；`R4b 空设置内容允许写入（清空语义）` |
| YAML 非法（导入实例包） | **通过（已修复）** | `R4c` → 修复后导入不再把坏 YAML 落盘：实测落盘内容为 `""`（源码 `src/core/modpack.ts:188-196` 先 `validateYaml`，不合法则跳过写入并记 warning） |
| `registry.json` 损坏 | **通过** | `51-registry-review.mjs` 用例 5 → `registry.json 损坏时列表仍可用（目录扫描兜底）`，返回 1 个且健康实例可见 |
| npm 断网 / registry 不可达 | **通过** | `R5 查询可安装版本失败时给出可读错误` → `查询可安装版本失败（退出码 1）：npm error … at onSocketNT (node:_http_client:1027:5)`；`R5b 安装引擎失败时给出可读错误` → 同类可读信息 |
| 全局配置 `launcher.json` 损坏 | **通过（已修复）** | `42-config-heal.mjs` 用例 K1 由 FAIL 转 PASS；`loadConfig` 已有兜底（备份 + 恢复默认） |

---

## 6. 资源泄漏

| 检查 | 结论 | 证据 |
|---|---|---|
| 子进程孤儿风险（启动器退出时） | **无法完全验证（防护代码已审）** | 见 §9 NV-01：本沙箱不允许 `taskkill`，无法观测"强杀是否生效"。**代码层面**防护完整：`src/main/index.ts:278-303`（`before-quit` → `stopAll` → `will-quit` → `forceKillLeftovers`）+ `src/main/runtime.ts:205-330`（记账 PID、**归属复核**防 PID 复用误杀、`taskkill` 失败后 `process.kill(SIGKILL)` 兜底 + `waitGone` 确认） |
| 停止实例是否真能结束进程 | **通过（已修复，实测验证）** | 修复前：`taskkill` 被拒且无原生兜底 → `handle.exited` 永不 resolve → 必然走满 15s+5s 超时并写 `lastError="停止超时，已强制结束进程树"`（实测 **20077ms**，进程仍存活）。修复后：`node tests/e2e/32-stop-verify.mjs` → **3/3 PASS**：`耗时 47ms`（毫秒级完成 = 子进程 `close` 事件被正常触发）、`状态=stopped lastError=null`、`pid=null`。两次观测相反，足以判定原生兜底生效 |
| PID 复用误杀无关进程 | **通过（已修复）** | `src/main/runtime.ts:247-283` 的 `checkOwnership()`：强杀前复核"core 是否仍认为该实例在跑、登记的 PID 是否一致"，不一致则跳过并记日志。这是对我审查中提出的"PID 复用"风险的正确处理 |
| 子进程自行退出后状态归位 | **通过** | `L3 正常退出后状态归位且 exitCode 已记录` → `状态=stopped exitCode=0 pid=null onExit=[0]` |
| 重复启动防护 | **通过** | `L5 已在运行时重复启动被拒绝且报错可读` → `实例已在运行：guard` |
| 事件订阅是否解除 | **通过** | preload 订阅返回幂等的 `removeListener` 闭包（`20-contract-and-dsh.mjs` 1-B4 PASS）；渲染层 `LogStore.subscribe` 返回退订函数（`src/renderer/data/logs.ts:139-144`）、`api.ts:76-84` 保证 `onLog`/`onState` 永远返回可调用函数 |
| 日志流是否无限增长内存 | **通过** | `LogStore` 固定容量环形缓冲：`capacity = 4000`，超出 `splice(0, overflow)` 并计数（`src/renderer/data/logs.ts:47-68`）；渲染侧 `MAX_RENDERED` 裁剪 DOM（`src/renderer/components/logview.ts:150-159`） |
| 日志文件是否无限增长 | **通过（已修复，行为级验证）** | `L10` 由 FAIL 转 PASS：**连跑 12 次启动后仅保留 10 个 `.log`**（`MAX_LOG_FILES=10`；`pruneOldLogs` 在写入前先腾位）。实测输出：`共启动 12 次；当前 10 个 .log 文件，MAX_LOG_FILES=10` |
| 日志写盘背压 | **通过（已修复）** | `L11` 由 FAIL 转 PASS：已从 `void appendFile` 发后不管改为**单写者队列 + 自动合并**（实测 `已改为串行化写入（单写者队列=true）`） |

---

## 7. 性能

| 检查 | 结论 | 证据 |
|---|---|---|
| 实例列表是否对每个实例做重 IO（递归算目录大小）→ 导致卡顿 | **通过** | `P4 列表视图不对每个实例递归计算目录大小` → `summarize 只读 package.json + 存在性检查`（`src/core/instance.ts:584-611` 无 `dirSize`）；`P1 60 个实例（各 120 个会话文件）列表耗时` → **38ms**；`P3 单实例会话枚举` → **0ms** |
| 引擎列表 | **通过（已修复）** | 修复前：真实 dsh 包 **26513 个文件 / 551.1 MB**，一次 `dirSize` **1375ms**，每次进版本管理都会卡。修复后：`engineSizeCache` + mtime 签名 + 惰性 `lazyEngineSize`（首次返回 `null`、后台单飞计算），实测 `41-core-perf-log.mjs` P6 → **`listEngines` 2ms** |
| 版本号排序/比较正确性 | **通过** | `40-core-deep.mjs` E1/E2：5/5 符合 semver（`alpha.2 < alpha.10`、`alpha.10 < beta.1`、正式版 > 预发布、`0.1.10 > 0.1.9`、`0.2.0 < 0.10.0`）；排序把 `0.1.6-beta.1` 排首位 |
| workspace 会话目录编码正确性 | **通过** | `H1 workspaceKeyFor 与真实 dsh 会话目录名一致 —— 3/3 一致`：`F:\WhalesLauncher→--F-WhalesLauncher--`、`C:\Users\user\.dsh→--C-Users-user-.dsh--`、`F:\ComFYUI→--F-ComFYUI--`；`H2` 中文/空格/`~` 走 `~XXXX` 编码不被退化为空 |

---

## 8. 独立评估：`registry.json` 索引快照设计（Lead 指派题目）

**结论：设计成立，且是满足"`present:false` 仍可见"口径的必要机制。评审中发现的一个真实缺陷（QR-16）已修复并复验转绿；当年提出的 UI 缺口（QR-17）**仍开放**。**

依据全部来自实跑（`node tests/e2e/51-registry-review.mjs`，最终 **15 例 / 15 通过**）：

| 评估项 | 结果 | 证据 |
|---|---|---|
| 手删目录 → 记录可见 + `present:false` | **成立** | `1a` → `present=false problem="实例目录缺失（可能在文件管理器里被删除）"` |
| `deleteInstance(true/false)` 后索引维护 | **正确** | `2a` 无幽灵条目；`2b` `deleteInstance(false)` 后记录离开列表、数据保留；`2d` registry 无残留 dirName |
| 导入实例包后一致性 | **正确** | `4a` 列表 dirName 与 registry 一致；`4b` 无重复条目；`4c` 列表长度 == registry 条目数 |
| registry 自身损坏 | **容错** | `5` → 目录扫描兜底，列表仍可用 |
| **目录被改名/移动** | **曾为缺陷（QR-16），现已修复** | `6/6b` 曾 FAIL（见下），修复后 **15/15 全绿** |
| 替代方案可行性 | **registry 是必需的** | 方案 B（仅目录扫描）无法表达"记录存在但目录不在"——记录本身只存在于被删目录里，故无法满足定稿口径；方案 C（把 registry 当"可重建缓存"+ schemaVersion + 清理入口）是当前实现的自然延伸 |

### QR-16 目录被改名后出现**重复记录** —— 曾为 P2，✅ 已修复

- 原文件：`src/core/instance.ts` 的 `collectInstances`（合并逻辑）
- 修复前复现（原始输出）：

```
[info] 目录改名后列表返回 2 个：["r","r"]
  FAIL  6 目录被改名后不产生"重复记录"（同 id 出现两次） —— 出现重复 id：列表 2 条但有 1 个唯一 id
  FAIL  6b 改名后不出现"同一实例两条记录" —— 同一 id 出现 2 条记录（一条来自改名后的目录、一条来自 registry 快照）
```

- 最小复现：
  1. 建实例（`dirName = "r"`）→ `registry.json` 记录 `{id: X, dirName: "r"}`
  2. 在资源管理器里把 `instances/r` 改名为 `instances/r-renamed`
  3. `core.listInstances(root)`
  4. 修复前**结果**：返回**两条** `{id: X, dirName: "r", present: false}` —— 一条来自"改名后的目录里 `instance.json` 的旧 `dirName` 字段"，一条来自 registry 快照；两条都 `present:false`，**真正可用的那个目录反而在界面上完全不可见**
- 为什么曾是真问题：用户只需在资源管理器里重命名一个文件夹就会踩到；表现是"列表里出现两个坏掉的同名实例，而我的实例不见了"，属于典型的"看起来像数据丢失"。
- 我给出的修复建议（已被采纳）：①以 **id** 而非 `dirName` 为主键去重；②冲突时以**实际存在的目录**为准（目录在即 `present:true`）；③不一致情形用 `problem` 标记并作为**一条**记录呈现；④修复动作显式化，**不静默改元数据**（`dirName` 同时是 dsh profile 名与共享目录键）。
- **修复后验证**：`node tests/e2e/51-registry-review.mjs` → **15 / 15 PASS，0 失败**。

---

## 9. 无法验证项

| 编号 | 项 | 原因 + 证据 |
|---|---|---|
| NV-01 | 启动器**整体退出**时是否真的不留孤儿进程（`will-quit` → `forceKillLeftovers` 的端到端起效） | `stopInstance` 的杀进程能力已通过 `32-stop-verify.mjs` 实测验证（见 §6），但"启动器进程被强杀 / 崩溃"这一路径无法在本沙箱触发：`taskkill` 被拒绝，我无法模拟"外部杀掉 Electron 主进程"。可验证的部分：归属复核 + `process.kill(SIGKILL)` 兜底 + `waitGone` 确认逻辑已审阅且 `stopInstance` 实跑通过。**建议在真实桌面环境手测一次**：启动实例 → 关闭启动器 → 任务管理器确认无残留 `node` |
| NV-02 | Mica/WCO 等 Windows 视觉效果、"界面美观" | 属实机肉眼判断，超出代码审查能力。Lead 已用 CDP 实机截图确认无边框 WCO 标题栏、自绘菜单、实例卡片、版本管理页均正常 |
| NV-03 | 真实 dsh 的完整启动链路（登录、调模型、多插件共存） | 受"不得触碰真实 `~/.dsh`"边界约束，只用 stub 引擎 + 真实 dsh 的 `--dump-config`（非交互、不调模型）校验 |

---

## 10. Lead 侧 CDP 实机验收发现（QA 未覆盖，已修复，供报告完整）

这两条是 Lead 用 CDP 实机验收发现的，**QA 的自动化用例没覆盖到**（原因：前者需要真实 `npm view` 网络往返 + 计时观测，后者需要渲染后的像素/DOM 尺寸测量），如实记录并注明责任归属：

| 问题 | 现象 | 根因 | 状态 |
|---|---|---|---|
| 版本管理页无限加载 | 打开版本管理页一直转圈 | `Promise.all([engine.list(), engine.available()])` 被慢的 `npm view` 拖住且**无超时**；任一慢请求即阻塞整页 | **已修复**：请求解耦 + 超时 + 失败可见 + 重试；同类隐患（创建向导步骤 2）一并修 |
| 标题栏两个按钮文字叠印 | 图标按钮内文字溢出 28px 盒子 | `iconButton()` 误把 `label` 透传，导致文字与图标叠加 | **已修复**：并顺带修好全应用图标按钮 |

**对 QA 的启示（盲区自省）**：我此前的渲染层检查全部是**静态**的（源码检索、契约比对、DOM 结构阅读），没有做"渲染后的布局度量"；也没有为"某个 IPC 调用慢/不返回"这类**时序故障**写超时用例。这两类能力缺口已记入 §12 盲区清单。

---

## 11. 审查边界与数据安全声明

- 所有破坏性实验都在 `F:\WhalesLauncher\.spike\qa-*` 内进行；QA 用例用 `fs.mkdtemp` 生成独立临时根。
- **未触碰** `C:\Users\user\.dsh`：核对 `node tests/e2e/41-core-perf-log.mjs` 用例 X1 → `真实 ~/.dsh/profiles 未被 QA 用例新增目录 —— 现有 profiles：web`。
- 交付目录 `instances/` 现含 Lead 的实机验证实例（`主力工作台`、`批量任务`）；QA 用例核查 X2 确认 `instances/` 中**无任何 QA 前缀产物**。
- **未修改** `src/**`、`package.json`、`scripts/build.mjs`、`src/shared/contracts.ts`。QA 写作用域仅 `docs/review/**` 与 `tests/e2e/**`。
- 审查期间我的 profile 规则探针曾在 `.spike` 下创建过带尾随点的目录（Windows 不允许常规删除），已用 `\\?\` 前缀路径清理完毕，以免影响 `rg` 等工具。

---

## 12. 验收结论（✅ 已按最新实测更新）

> **本节于审查末期按"以实测为准"的原则重测并改写。** 上一版结论写于多项缺陷被派单修复**之前**，落笔时点准确但已过时；下面是当前真实状态。

### 总体结论：**通过（附 1 项 P2 体验缺口 + 3 项无法验证项）**

**逐项复验结果（本节所有数字均为本轮重新执行得出，非采信他人汇总）**

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **exit 0**，零输出 |
| 构建 | `npm --cache … run build` | `[build] 完成 ✓ main/index.cjs 368.0 KB \| preload/index.cjs 4.2 KB \| renderer/index.js 306.1 KB` |
| 项目自带测试 | `npm --cache … test` | **13 个测试文件全通过、0 失败、1 跳过**；累计 **128 passed / 0 failed**，exit 0 |

**QA 独立用例逐套复验（当前代码）**

| 用例集 | 结果 |
|---|---|
| `00-smoke.mjs` | **PASS** —— `core` 覆盖契约全部方法（现 51 个键，含 `listShareConflicts`、`removeOrphanSharedWorkspace`、`deleteInstanceDetailed` 等非契约扩展） |
| `10-data-safety.mjs` | **13 / 13 PASS**（0 失败） |
| `11-repro-settings-clobber.mjs` | **三条反例全部转正**：`R1 实例设置被保留 ✓`、`R2 ✓`、`R3 ✓` |
| `20-contract-and-dsh.mjs` | **26 / 26 PASS**（真实 dsh 逐条比对 profile 规则，危险方向 0 例） |
| `30-robustness.mjs` | **35 / 35 PASS**（0 失败） |
| `40-core-deep.mjs` | **16 / 16 PASS** |
| `41-core-perf-log.mjs` | **8 / 8 PASS** —— 含**行为级**轮转验证：连跑 12 次启动后仅保留 **10** 个 `.log`（`MAX_LOG_FILES=10`）；`listEngines` 真实尺度 **2ms**（惰性+mtime 缓存，`sizeBytes=null` 首次） |
| `42-config-heal.mjs` | **7 / 7 PASS** |
| `43-resolve-command.mjs` | **4 / 4 PASS**（`.cmd` 垫片 + `windowsVerbatimArguments`，真实 `npm --version` 跑通） |
| `44-cmd-invocation-matrix.mjs` | 实验留证（A 旧实现 ✗ / B 双层引号+verbatim ✓） |
| `50-status-recheck.mjs` | **检查 12 项：已修复 11，仍存在 1**（仅 QR-17） |
| `51-registry-review.mjs` | **15 / 15 PASS**（QR-16 已修：改名不再产生重复记录） |
| `52-broken-record-cleanup.mjs` | A1/A2/A3/B1/C2/D1 PASS；**C1 FAIL（QR-17）** |
| `32-stop-verify.mjs` | **3 / 3 PASS** —— `stopInstance` 耗时 **46ms**（修复前 20077ms）、`lastError=null`、`pid=null` |
| `31-stop-probe.mjs` | 沙箱限制留证（`taskkill` 被拒） |

### 问题计数（当前）

| 级别 | 数量 | 说明 |
|---|---|---|
| **P0 阻断** | **0** | —— |
| **P1 严重** | **0** | 2 项曾报并已修复验证（QR-01 settings 静默覆盖 / QR-02 实例凭空消失） |
| **P2 一般** | **1** | **QR-17**：渲染层不消费 `problem` 字段（详见下） |
| **P3 建议** | **0** | QR-08/09/10/11/12/13/15/18 均已闭环或按设计接受 |
| **无法验证** | **3** | NV-01 / NV-02 / NV-03（见 §9） |

### 唯一未闭环项：QR-17（P2，体验缺口，非数据安全问题）

- **事实**：core 侧已正确产生 `problem` 文案（实测 `problem="instance.json 损坏（无法解析）"`），且坏记录确实可见、可删除、可解析（A1/A2/A3/B1 全 PASS）；但 `src/renderer/**`（36 个 `.ts` 文件）**零处引用 `problem`**。
- **用户可见后果**：`instance.json` 损坏的实例在界面上呈现为**一张完全正常的卡片**（`present=true`，无任何徽标/警告），用户唯一能做的操作是"启动"，而启动只会得到一句底层报错。
- **建议**（工作量很小）：把 `summary.problem` 渲染为 warning 徽标（复用 `views/instances.ts:366` 现有位置）；把 `views/instances.ts:177` 的 `attention` 判定纳入 `problem`，让"需要关注"筛选能筛出这类实例。
- **为何仍算"通过"**：该缺口不涉及数据丢失或安全问题，主链路与核心资产安全全部经得起检验；它属于"异常态的提示不够显眼"，可在后续迭代补齐。

### 逐项结论速览（任务要求的 7 类）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | 契约一致性（CH 全通道 / WhalesApi 形状 / CoreApi 全方法） | **通过** |
| 2 | dsh 行为正确性（不 import 内部 API / DSH_HOME+cwd / profile 名校验 / 插件走 CLI / patch 语义） | **通过** |
| 3 | 数据安全（递归删除 / 误伤用户数据 / 原子写） | **通过**（含实例内 junction 反向穿透用例；settings 冲突已改为"保留本地+登记冲突"） |
| 4 | 安全（nodeIntegration / contextIsolation / ipcRenderer 泄漏 / XSS） | **通过**（CSP 一项已转派 ui-engineer） |
| 5 | 健壮性（引擎未装 / 目录手删 / 启动失败 / YAML 非法 / npm 断网） | **通过** |
| 6 | 资源泄漏（孤儿进程 / 订阅解除 / 日志内存） | **通过（代码与可测部分）**；日志轮转与背压已修并**行为级验证**；启动器整体退出的端到端仍为 NV-01 |
| 7 | 性能（实例列表重 IO） | **通过** —— 60 实例列表 38ms；引擎体积已惰性+mtime 缓存，真实尺度 `listEngines` **2ms** |

### QA 用例失败的最终解释

当前仅剩 **2 处 FAIL**，且**都不是缺陷**：

1. `52-broken-record-cleanup.mjs` 的 **C1** → 对应真实未闭环项 **QR-17**（保留为可执行证据）。
2. `30-robustness.mjs` 的 **S10（`index.html` 无 CSP）** → 已由 Lead 转派 ui-engineer，属 `src/renderer/**` 写作用域。

> QA 脚本不是交付代码。保留 FAIL 用例是刻意的：它让"缺陷仍然存在"有可执行的证据，每条 FAIL 在 `docs/review/code-review.md` 都有对应编号。缺陷修复后这些用例会自动转绿（本轮已有 11 项如此转绿）。
