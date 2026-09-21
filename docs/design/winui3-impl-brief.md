# WinUI 3 重构 · 实现者简报（所有页面/外壳实现者必读）

> 本文件是所有实现者的共用约定与依赖说明。**你的任务描述只写你那部分，通用规则以本文件为准。**

---

## 1. 你在做什么

WhalesLauncher 原为 Electron + TypeScript 桌面启动器（管理 dsh 实例与版本）。
本轮决策：**前端整体替换为 WinUI 3（C#/XAML），Electron 主进程与 DOM/CSS 渲染层全部废弃**。
- `src/core/**`（约 7 000 行纯 Node/TS 业务逻辑）保留，由 Node 侧车进程承载。
- 旧前端（`src/renderer/**`、`src/main/**`、`src/preload/**`）**不得参考其 UI 设计**；仅 `src/shared/contracts.ts`（契约）与 `src/main/ipc.ts`（参数形状）可作为**事实来源**查阅。
- 工作目录 `F:\WhalesLauncher`，分支 `winui3-rewrite`。

## 2. 必读（按顺序）

| # | 文件 | 读什么 |
|---|---|---|
| 1 | `docs/design/winui3-visual-spec.md` | **你的页面结构规格 §9.x 必须逐条落实**；另读 §1.3（允许的自定义白名单）、§2（布局网格 4epx）、§4（字体字阶）、§5（间距圆角）、§6（控件用法与禁用项）、§7（交互状态）、§8（可访问性）、§12（提交前自检清单）。§10 证据索引可查出处，§11 是无法查证项，**不要在 §11 里挑条目当借口** |
| 2 | `docs/design/winui3-csharp-conventions.md` | §5 视图契约（类名/文件/路由，**不得改名**）、§6 资源与样式铁律、§7 共享控件登记规则、§8 代码风格、§9 分层依赖方向、§10 写范围纪律 |
| 3 | `docs/design/winui3-bridge-protocol.md` | §3 方法表（`CH` 通道名即方法名）、§2.4 事件 |
| 4 | `src/shared/contracts.ts` | DTO 字段语义。**注释里有大量"为什么"**，例如 `InstanceSummary.problem` 明确要求界面必须显示 |

## 3. 依赖状态（重要，会影响你的编译）

| 组件 | 状态 | 说明 |
|---|---|---|
| `Services/CoreBridge.cs`、`Services/Channels.cs`、`Services/BridgeResult.cs`、`Models/**` | **由 core-dev 并行交付中** | 类型名 = `contracts.ts` 的接口名（`InstanceSummary` / `EngineInfo` / `LauncherConfig`…）；字段 TS camelCase → C# PascalCase。若编译报这些类型缺失，**属预期**：先完成 XAML 布局与逻辑，稍后重试编译 |
| `Services/AppServices.cs` | ✅ 已就绪 | 静态服务定位器：`AppServices.State` / `.Bridge` / `.Toast` / `.Dialogs` / `.Navigation` |
| `Services/AppState.cs` | ✅ 已就绪 | `Instances` / `Engines`（`ObservableCollection`）、`Config`、`Load*Async` / `Refresh*Async`、`InstancesChanged` 等事件 |
| `Services/Formatters.cs` | ✅ 已就绪 | `FormatRelative` / `FormatBytes` / `FormatEngineSize` / `ShortenPath` / `FormatDuration` 等（与旧实现逐字一致） |
| `Services/NameValidator.cs` | ✅ 已就绪 | `ValidateInstanceName` / `PreviewDirName` / `ValidateProfileName` |
| `Services/DialogService.cs` | ✅ 已就绪 | `ConfirmAsync` / `AlertAsync` / `Create`（内部封装 ContentDialog） |
| `Services/ToastService.cs` + `Controls/ToastHost` | ✅ 已就绪 | `AppServices.Toast.Success/Error/Warning/Info` |
| `Controls/PageHeader` | ✅ 已就绪 | 统一页头（`Title` / `Description` / `Actions`），**所有页面必须用它**，不得自拼页头 |
| `Themes/Tokens.xaml` | 占位 | 规范 §1.3 允许但不要求新建令牌；**优先直接引用内置键** `{ThemeResource ...}` |

**调用后端的方式**：
```csharp
var result = await AppServices.Bridge.CallAsync<InstanceSummary[]>(Channels.InstanceList);
if (!result.Ok) { /* 必须把 result.Error 呈现到界面（InfoBar），不得只进日志 */ }
```

## 4. 硬性要求（违反会被 Lead 打回）

1. **只用官方 WinUI 3 控件**。`[MUX_PREVIEW]` 预览控件禁用：`TableView`、`PagerControl`、`WrapPanel`。
2. **颜色 / 字号 / 圆角一律 `{ThemeResource 内置键名}`**。禁止自写 hex 色值、禁止自定字号、禁止 `StaticResource` 引用画刷（换主题不刷新）。
3. **自定义尺寸必须是 4 epx 整数倍**（`Margin` / `Padding` / `Width` / `Height`）。
4. **页头用 `Controls/PageHeader`**；页面根结构遵循规范 §9.0 通用骨架。
5. **错误必须可见**：任何后端调用 `ok:false` 都要在界面呈现（页内 `InfoBar Severity="Error"`），文案用 `result.Error` 原文（用户要能复制）。
6. **降级必须可见**：`InstanceSummary.problem` 非空时必须显示 `InfoBar Severity="Warning"`（契约注释明确要求）。
7. **数据绑定优先 `x:Bind`**（编译期检查、性能好）；`Mode=OneWay` 用于会变的属性。
8. **异步禁止 `.Result` / `.Wait()`**（UI 线程死锁）。跨线程更新 UI 用 `DispatcherQueue.TryEnqueue`。
9. **页面 `OnNavigatedFrom` 必须解绑事件**，避免泄漏。
10. 中文注释，解释**为什么**而不是复述代码。
11. **不使用** `Console.WriteLine`、硬编码 `F:\WhalesLauncher` 路径、`Thread.Sleep`。
12. **XAML 注释里禁止出现 `--`**。XML 规范规定 `<!--` 与 `-->` 之间**任何位置**的连续两个短横线都非法，不只是整行分隔线。违反会直接中断整个工程的 XAML 编译（`WMC9997`）——本项目已实际发生过一次，全队构建被卡。
    - ❌ `<!-- -------------------- 步骤 1 -------------------- -->`
    - ✅ `<!-- ==================== 步骤 1 ==================== -->`
    - ✅ `<!-- ———————— 步骤 1 ———————— -->`（全角横线安全）
    - ✅ `<!-- 步骤 1：名称与外观 -->`
    - C# 里写 `// ----------------` 的习惯**不要**带到 XAML。
13. **编辑后请自行跑一次构建**，确认不是自己的文件在报错。构建失败时**先看错误路径属不属于你**：属于自己就修；不属于自己，把错误原文与文件名报告 Lead（像 page2-dev 那样），不要默默重试到超时。

## 5. 构建与自检

```powershell
# 构建（dotnet 不在 PATH，用全路径）
$env:DOTNET_NOLOGO=1
& 'C:\Program Files\dotnet\dotnet.exe' build 'F:\WhalesLauncher\desktop\src\WhalesLauncher.App\WhalesLauncher.App.csproj' -c Debug

# 截图自检（真实窗口截图，已验证可用）
& powershell -NoProfile -ExecutionPolicy Bypass -File 'F:\WhalesLauncher\.probe\capture-smoke.ps1' `
    -Exe 'F:\WhalesLauncher\desktop\src\WhalesLauncher.App\bin\Debug\net10.0-windows10.0.26100.0\win-x64\WhalesLauncher.exe' `
    -Out 'F:\WhalesLauncher\.probe\shots\<你的页面>.png' -WaitMs 8000
```

**并发注意**：
- 多个实现者会同时构建同一工程 → 偶发 `obj` 文件锁冲突或看到他人半成品。**重试一次**；持续失败就在回复里报告，不要反复硬刚。
- 截图时会同时有多个应用窗口，脚本按 PID 定位窗口，互不干扰；但**不要**在截图脚本运行期间手动关闭别人的窗口。
- **`Get-Content` 会把 UTF-8 中文显示成乱码** —— 读文件一律用 read 工具。写 `.ps1` 时用纯 ASCII（PS 5.1 按 ANSI 读脚本，中文会导致语法错误）。

## 5.5 三条实测环境事实（core-dev 实测，务必知道）

1. **构建必须带 `DOTNET_CLI_UI_LANGUAGE='en-US'`**（见 §5 命令）。zh-CN 下 XAML 编译器会把真实错误吞成误导性的 `WMC9999 未能找到任何适合于指定的区域性或非特定区域性的资源` —— 你会朝错误方向修。带上它才会看到 `WMC0909` / `WMC1111` / `CSxxxx` 这类真实错误。
   ⚠ **不要同时设 `VSLANG`**。Lead 实测三种组合，只有"只设 `DOTNET_CLI_UI_LANGUAGE`、不设 `VSLANG`"能显示真实错误；一旦设了 `VSLANG=1033`，XAML 编译器的错误消息资源会加载失败，反而退化回 `WMC9999`：
   ```powershell
   $env:DOTNET_NOLOGO=1
   $env:DOTNET_CLI_UI_LANGUAGE='en-US'
   Remove-Item Env:VSLANG -ErrorAction SilentlyContinue   # 关键：清掉它
   ```
   另一个常见"假错误"：多人并发构建同一工程会命中 `CS2012 ... being used by another process`（obj 文件锁）—— **那是锁冲突、不是代码错误**，等 20~30 秒重试即可，不要据此改代码。
2. **`host:` 宿主方法由外壳统一注册一次**，页面**绝不**各自注册（8 处注册会互相覆盖）。
   外壳注册全部 8 条：`host:pickArchive`、`host:pickFolder`、`host:pickPackFile`、`host:saveFile`、`host:downloadsDir`、`host:openPath`、`host:openExternal`、`host:messageBox`。
   页面要"选文件 / 选目录 / 打开外部链接"，请调用**对应业务通道**（如 `plugin:pickArchive`、`plugin:pickFolder`、`pack:pickFile`、`saves:openFolder`），Node 侧会反向调用宿主编 —— **页面不要直接碰 `host:`**。
   `host:openExternal` 的安全校验（只放行 http/https）在 `CoreBridge.IsAllowedExternalUrl`，两处都要校验。
3. **要"显式置空"一个可选字段，必须传 `JsonObject` / `Dictionary<string, object?>`**：C# 外发请求默认**丢弃** null 可选字段（等价于 TS 的 `undefined`），所以 `instance:update` 里传 `color = null` 会被丢掉 —— 清空实例 emoji、把 `nodePath` 重置回"自动探测"都会**静默失效**。
   - ❌ 用匿名/DTO 对象传 `null` → 字段消失
   - ✅ `new JsonObject { ["color"] = null }` 或 `new Dictionary<string, object?> { ["color"] = null }`
   涉及页面：P3 实例设置（清空 emoji/颜色）、P8 全局设置（重置 `nodePath`）、P7 向导（若允许留空）。
4. **改源码一律用 `edit` / `write` 工具，绝不要用 `Get-Content | Set-Content` 周转。**
   PowerShell 5.1 的 `Get-Content` **默认按 ANSI(GBK) 读**，会把含中文的 UTF-8 源码整文件读成乱码；再写回就产生「双重编码 + 引号丢失 + 换行丢失」的连锁语法错误。
   **本项目已实际发生过一次**：`Views/InstanceDetailPage.xaml.cs`（675 行）被写坏，那个文件里 20+ 条语法错误（`CS1010 Newline in constant` / `CS1039 Unterminated string literal`）让全队编译阻塞，最后靠**整文件重写**才恢复。
   - ❌ `(Get-Content 'x.cs' -Raw) -replace 'a','b' | Set-Content 'x.cs' -Encoding UTF8`
   - ✅ 定点替换用 `edit` 工具；整体重写用 `write` 工具
   - 读文件同理用 `read` 工具，**不要**用 `Get-Content`
   - 只有**纯 ASCII 的 `.ps1` 脚本**才可以安全地用 shell 周转

---

## 5.6 XAML 增量编译缓存会报「幽灵错误」（务必知道）

**症状**：文件明明已经改好，`dotnet build`（增量）却一直复读**旧行号的旧错误**。
Lead 实测：`EnginesPage.xaml` 的 `ProgressBar.Orientation` 早已被改成 `ProgressRing`，增量构建仍持续报 `(683,25) Unknown member 'Orientation' on element 'ProgressBar'`；只有强制重建才反映真实状态。

```powershell
# 强制重建，清掉 XAML 增量缓存
& 'C:\Program Files\dotnet\dotnet.exe' build '<csproj 全路径>' -c Debug -t:Rebuild
```

**判断法则**：若错误指向的行号与实际文件内容**对不上**，先 `-t:Rebuild` 再下结论 —— 不要在幽灵错误上耗时间，也不要据此去"修"一处本来就正确的代码。

---

## 6. 写范围纪律

### 6.1 代改他方文件的超时授权（长期有效，不必逐次申请）

当构建被**非你写范围**的文件阻塞、且该文件 owner **在 10 分钟内未响应**时，你**可以直接改那一处**解阻塞，条件：

1. 只改导致编译失败的**最小处**（删/换一个属性、加一个 `using`、修一处类型不匹配），**不做重构、不动视觉与逻辑**；
2. 改动前先 `read` 该文件确认现状（避免覆盖 owner 的并行编辑）；
3. 在回复里**明确登记**：文件、行号、改法、原因、时间；
4. 同一文件若还有第二处问题，**只报告不代改**。

**理由**：8 个 writer 共用一个工程，任何一个半成品都会阻塞所有人；与其让人反复申请授权空耗，不如给一条有边界、可审计的规则。owner 仍对自己的文件负最终责任 —— 若你发现自己被代改了，请核对改动是否合理，不合理就改回来并说明。

- **只写你被分配的文件**。共享层（`Services/**`、`Models/**`、`Themes/**`、`Controls/**`、`App.xaml*`）未经 Lead 同意不得修改。
- 需要新增跨页面复用的控件时：**先在回复里登记**（控件名 + 用途 + 谁会复用），由 Lead 决定归属，不要直接写进 `Controls/`。
- 不得改名规范 §5 规定的页面类名与文件名（导航靠它们）。
- 不得修改 `src/core/**`、`src/shared/contracts.ts`、`docs/**`。

## 7. 完成流程

1. 自检规范 **§12 实现者自检清单**，逐条过一遍。
2. `dotnet build` 0 错误。
3. 截图一张真实运行图（Light 或 Dark 至少一张；规范要求两套主题都要能看，能截两张更好）。
4. `team_task_update action=complete`（带最新 revision）。
5. 回复 Lead：
   - 交付文件清单
   - 构建输出尾部（证明 0 错误）
   - 截图路径
   - **规范 §9.x 里你未能落实的条目**（如有，说明原因，**不得静默偏离**）
   - 新增控件登记（如有）
   - 不确定项 / 遗留问题

> **诚信要求**：本项目的验收标准是「每页通过严格视觉审计，无未修复项」。若你的页面有做不到的地方，**如实写明**。伪造"已完成"比留下已知缺陷严重得多 —— 审计环节会实跑截图核对。
