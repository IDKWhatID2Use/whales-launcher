# WhalesLauncher 双语化（中 / 英 i18n）改造方案

> **本文性质**：**方案与取证**，不是执行记录。调查全程未改动任何**工程文件**（`csproj` / XAML / `.cs` / 构建脚本 / `src/**` / `desktop/bridge/**` 全部零改动）。
> 本次新增的文件共 3 处：**本文件**、证据附件 `docs/audit/i18n-frontend-audit.md`（唯一入库的新增文档）、调研产物 `.probe/i18n-research/`（2 个只读 MSBuild 探针 + 1 份 2.2 MB PRI 转储 + 复现说明；`.probe/` 已在 `.gitignore` 内，**不入库、可整目录删除**）。工程文件本身未被写入。
> **基线 commit**：`049f7705af575cfbbedc62fd5340421d44ffd05d`（分支 `winui3-rewrite`，调查时 HEAD）
> **一句话结论**：项目当前**没有任何 i18n 基础设施**——0 个 `.resw`、0 处 `x:Uid`、0 个语言开关、0 个 i18n 依赖。要双语化：前端 **约 890 条**用户可见中文字面量待资源化（上界 1 068，47 个文件），后端 **约 576 条**（含 159 处 `throw`）需把**面向用户的错误字符串**升级为**错误码 + 参数**；另有 **1 条硬阻塞**（`App.xaml.cs:138` 用中文文案做控制流判据）必须先改。**建议先做击穿实验（`.probe/`）再全量迁移**——本工程是 unpackaged + `dotnet build`，正落在社区报告本地化资源失效的敏感组合上（§2.4）。
> **前置依赖**：本方案的 §3.5 需要修改**冻结的桥接协议**（`docs/design/winui3-bridge-protocol.md` §6 变更流程）与**唯一事实源契约**（`src/shared/contracts.ts`）。这两处都超出普通实现者的写范围，需 **Lead 批准**。

---

## 0. 决策摘要

| # | 决策点 | 建议 | 一句话理由 |
|---|---|---|---|
| D1 | 资源承载方式 | **混合**：XAML 标记用 `x:Uid` + `.resw`，C# 文案用 `Localizer`（先过击穿实验） | `x:Uid` 覆盖不到 C# 侧的 ~499 处字面量，所以 C# 无论如何都要一个资源服务；XAML 侧 `x:Uid` 不动结构、最省。反方意见与翻牌条件见 §2.5 |
| D2 | 后端错误怎么办 | **错误码 + 参数，向后兼容地增补**（保留 `error` 中文字段） | 不破坏冻结协议 §2.3，老读取方（日志、崩溃报告、未翻译项）继续可用（§3.5） |
| D3 | 语言切换的生效方式 | **首版：切换后提示重启生效**；热切换列为二期 | 主题能热切换是因为 `RequestedTheme` 作用于可视树；静态 XAML 文本不能（§3.7） |
| D4 | 默认语言 | `language` 配置项默认 **`zh-CN`**，并额外提供 `system` 选项 | 对现有用户**零行为变化**，可回归、可审计（§3.6） |
| D5 | 纯日志（stderr）是否翻译 | **不翻译** | 协议 §1 规定 stderr "不参与协议"，且它是排障信息而非产品文案（§3.5.3） |
| D6 | 数字 / 日期是否区域敏感化 | **不敏感化**，只翻译"词" | 沿用 `Formatters.cs:6-9` 的既有设计意图（与旧版逐字一致，截图可对比），避免引入区域噪声（§3.4） |
| D7 | 语言选项要不要跟随系统 | 提供 `system`，但**不做默认** | 默认跟随系统会静默改变英文系统上现有用户的行为（§3.6） |
| D8 | 术语一致性如何保证 | 立**术语表**（§6）+ "值 → 资源键"单一映射点 | 现在同一状态标签在 2 个文件里各写一份（§3.3），术语天然会漂 |

---

## 1. 现状取证

> **证据附件**：`docs/audit/i18n-frontend-audit.md`（前端逐文件普查：载体分布、每条来源行号、难以本地化的构造清单）。本章给结论与决策依据，附件给全部明细。

### 1.1 零基础设施（机械证据）

| 检查项 | 结果 | 取证方式 |
|---|---|---|
| `.resw` / `.resx` 资源文件 | **0 个**（全仓，排除 `node_modules` / `instances` / `obj` / `bin`） | 递归搜 `*.resw`、`*.resx`、`Resources` 目录 |
| XAML 中 `x:Uid`（MRT 本地化入口） | **0 处** | `desktop/src/**/*.xaml` 全量搜 `x:Uid` |
| `csproj` 本地化属性（`DefaultLanguage` / `PRIResource` / `NeutralLanguage`） | **无** | 通读 `WhalesLauncher.App.csproj`（全文 41 行） |
| 语言切换 UI | **无** | 全仓搜 `LanguageSelector`、`语言设置`、`LanguageSwitch`；`SettingsPage.xaml` 的「外观」区只有主题（`SettingsPage.xaml:91-97`） |
| 配置项 | **无 `language` 字段** | `LauncherConfig`（`contracts.ts:410-429`）只有 `theme` / `confirmOnDelete` 等；`launcher.json` 实测字段亦无 |
| i18n 依赖 | **无** | `package.json` 的 dependencies 仅 `adm-zip`、`js-yaml` |

已生成 PRI（`artifacts/WhalesLauncher-win-x64/WhalesLauncher.pri`，2.2 MB）与 `Microsoft.Windows.ApplicationModel.Resources.dll`，说明 **MRT 运行时已在分发物里**——这是走官方路线的有利前提，但不等于 `.resw` 已被纳入构建（§2.4）。

### 1.2 文案规模（工作量基线）

统计口径：**含中日韩统一表意文字的字面量条数**，已剔除 C# 的 `//`、`/* */`、`///` 注释与 XAML 的 `<!-- -->` 注释；**未**区分"用户可见"与"仅开发者可见"（`Debug.WriteLine` 的中文也计入，故为**上界**）。

| 载体 | 文件数 | 条数 |
|---|---|---|
| XAML（属性值 + 内联文本节点） | 14 | **412** |
| C#（字符串字面量，含插值） | 33 | **656** |
| **合计** | **47** | **1 068** |

热点文件（前 10）：

| 文件 | 条数 |
|---|---|
| `Views/EnginesPage.xaml.cs` | 92 |
| `Views/Detail/InstanceSettingsView.xaml.cs` | 79 |
| `Views/WizardPage.xaml` | 72 |
| `Views/InstancesPage.xaml` | 72 |
| `Views/InstancesPage.xaml.cs` | 64 |
| `Views/Detail/InstanceSettingsView.xaml` | 54 |
| `Views/WizardPage.xaml.cs` | 52 |
| `Views/SettingsPage.xaml.cs` | 50 |
| `Shell/PreflightPresenter.cs` | 45 |
| `Views/EnginesPage.xaml` | 44 |

> 后端（`src/core/**`）另有一批用户可见文案，但**不走**这 1 068 条的口径统计——它以**错误字符串**形式存在，改造方式不同（§3.5）。

**两个口径的对照**（避免与附件报告的数字打架）：

| 口径 | 条数 | 差异来源 |
|---|---|---|
| 本文（**上界**） | ~1 068 | 含 `Debug.WriteLine` 等仅进调试器的中文 |
| 附件 `docs/audit/i18n-frontend-audit.md`（**用户可见**） | XAML ~330 + C# ~560 ≈ **890** | 已剔除调试器专用文本（如 `CoreBridge.cs` 85 条中 48 条是 `Debug.WriteLine`） |

真正要翻译的工作量落在**用户可见**口径上（~890 条）；上界数字用于提醒"机械 `grep` 会捞到更多东西"。

**后端（`src/core/**` + `desktop/bridge/**`）不在上述口径内**，单独统计：

| 类别 | 条数 | 说明 |
|---|---|---|
| `throw` 构造点（含中文） | **159**（core 111 + 桥接 48） | 热点：`plugin-packs.ts` 39、`instance.ts` 21、`validate.mjs` 19、`server.mjs` 17、`modpack.ts` 14、`engine.ts` 13、`config-store.mjs` 12 |
| 结构化 DTO 文案（**进 UI**） | ~150 | `PreflightCheck.title/summary/detail/advice`、`NodeRuntimeReport.message`、`NodeRuntimeCandidate.reason`、`PortDecision.reason`、`InstanceSummary.problem`、`ShareConflict.message`、`PluginInstallResult.warnings`、`ImportResult.warnings`、`MenuNode.label` |
| 运行日志（**进 `LogDrawer`**） | ~40 | `log:chunk` 的 `stream='system'` 行（`events.mjs`、`launch.ts`、`instance.ts` 等） |
| 仅开发者 stderr | ~35 | 正常路径不上屏 |
| **合计** | **~576** | 改造方式与前端不同（§3.5） |

> **后端不是"只有 error 字符串"**：它用**三条**独立通道把中文送进 UI——① `{ok:false, error}`（§1.4 障碍 1）、② 结构化 DTO 字段（上表第 2 行）、③ `log:chunk` 系统日志行。③ 尤其容易漏：`LogDrawer` 是真实界面（`Shell/LogDrawer.cs:187,293-304,345`），用户在日志抽屉里读到的是后端拼的中文。

### 1.3 文案的五个"层"（决定改造方式不同）

| 层 | 载体举例 | 改造方式 |
|---|---|---|
| **静态 UI 文本** | `WizardPage.xaml` 的 `Text=` / `Header=` / `PlaceholderText` | `x:Uid` + `.resw`（或绑定到 Localizer） |
| **代码内文本** | `PreflightPresenter.cs:162-169` 的对话框标题/正文；`DialogService.cs:99-101` 的默认按钮文案 | `ResourceLoader` 取键 + 参数化 |
| **派生文本** | 状态标签（§3.3 的 3 份副本）、运行时长（`Formatters.cs:42-74`）、"发现 N 项待处理"（`PreflightPresenter.cs:92-94`） | **映射表 + 参数**——最容易漏，最需要术语统一 |
| **XAML 初值 + 代码覆写（双写）** | `AboutPage.xaml:87/100/113/126/163/176` 的 `Text="—"` ← `AboutPage.xaml.cs:39-44`；`Views/Detail/LogsView.xaml:132`「显示 0 / 共 0 行」← `LogsView.xaml.cs:273`（同类"0 值"双写共 3 处） | 两处都要改；初值与运行时值**必须取同一个键**，否则中英文下会露馅 |
| **XAML 完全不声明（C# 手搓控件）** | `WizardPage.xaml.cs:520-616`、`Controls/PreflightReportView.xaml.cs:106-137`、`PreflightPresenter.cs:247,252` 的 `new TextBlock { Text = "中文" }` | **没有 XAML 可改**，只能走 `Localizer.T`——纯 `x:Uid` 方案会漏掉这一类 |

**对选型有利的两个形态事实**（普查结论）：

- XAML 文案 **100% 走属性**：`<Run Text="..."/>`、`<Hyperlink>`、`<TextBlock>中文</TextBlock>` 内文**均为 0 处**；唯一"伪内联"形式是 13 条 `<x:String>`（`SettingsPage.xaml:95-96`、`WizardPage.xaml:285-286` 等）。这使 `x:Uid` 的覆盖面最大化（§2.1）。
- `AutomationProperties.Name` 约 **75 条**（`MainWindow.xaml:80,240,251,262,276`、`WizardPage.xaml:144-155` 的 12 个 emoji 名等），是仅次于 `Text=` 的第二大属性载体——无障碍名字的本地化**不是小事**（§3.2、V3）。

### 1.4 三个结构性障碍（"把中文翻译一遍"做不到）

#### 障碍 1：错误通道传的是**自由文本**，不是可翻译的结构

桥接协议把错误形状**冻结**为一句面向用户的中文：

- `docs/design/winui3-bridge-protocol.md:48-54`：`{"id":"c1","ok":false,"error":"实例不存在：KREA2"}`，并明确注释「`error` 是**面向用户的中文文案**（沿用旧 `Result<T>` 的 `err()` 约定），不是堆栈」。
- `contracts.ts:19-22`：`Result<T> = {ok:true,value:T} | {ok:false,error:string}`。
- `CoreBridge.cs:1089-1092`：C# 侧把这个字符串包成 `BridgeCallException(error)`；`winui3-impl-brief.md:54` 进一步要求「文案用 `result.Error` 原文（用户要能复制）」。
- 契约里还有**直接写着"中文"的 DTO 字段**：`PreflightCheck.title`「中文标题（界面直接显示）」（`contracts.ts:500`）、`PreflightCheck.summary/detail/advice`（`:504/:506/:508`）、`NodeRuntimeCandidate.reason`「不可用原因（中文）」（`:451`）、`NodeRuntimeReport.message`「面向用户的一句话结论」（`:472`）。

**改造落点比想象中集中**（好消息，直接影响 §3.5 的成本）：

- `{ok:false, error}` 字面量全仓**只有 4 处**，而 `desktop/bridge/server.mjs:745` 是**全部业务错误的唯一出口**；
- 唯一的"错误加工层"是 `desktop/bridge/errors.mjs:96-114` 的 `describeError()`：`AppError` 逐字不改（`:97`）；裸 `Error` 会追加 OS 码建议（`CODE_HINTS`，`:31-49`）、最多 2 条特征提示（`PATTERN_HINTS`，`:52-82`），并在超 1200 字时截断（`:141-143`）；
- `contracts.ts` 里**中文字面量为 0**（1000 行全是类型与注释）——契约本身不需要 i18n，只需给它加字段；
- 协议文档所称的 `err()` 约定**在实现里是死代码**（全仓 0 调用），线上形状由 `server.mjs` 直接产出。

因此 §3.5 的错误码化**不必逐点重写 159 个 `throw`**，可以分两步：先在出口（`server.mjs:745`）与加工层（`describeError`）建立 code 通道，再按影响面给高频错误（实例 / 引擎 / 端口 / Node / 插件）补 code。

**结论**：英文界面下，这些字符串会以中文原样出现。这不是"漏翻译几条"，而是**通道本身不携带翻译所需的信息**（拿不到错误码、拿不到插值参数）。修法见 §3.5。

#### 障碍 2：中文文案参与控制流（**最高优先级**）

```csharp
// App.xaml.cs:136-138
private static bool IsMissingRuntime(Exception ex)
    => ex is InvalidOperationException
       && ex.Message.Contains("未找到可用的 Node.js 运行时", StringComparison.Ordinal);
```

这是**用中文文案当类型判据**。一旦后端消息被翻译/改词，这个判断静默失效——表现为「这台机器没有 Node」时**不再触发便携版下载**，用户看到的是一个起不来的后端和一句错误提示。

好消息：全仓搜 `Contains/StartsWith/EndsWith/IndexOf/==` 后跟中文字面量的模式，**C# 仅此 1 处，TS 侧 0 处**。也就是说这条债**很小且可一次还清**。
改法：改为判据一个稳定的**错误码**（§3.5.2 的 `node.runtime-missing`），而不是文案。

**一处关键细节（易误判）**：它匹配的是 **C# 自己那份副本**——`Services/CoreBridge.cs:154-157` 的 `NodeRuntimeLocator.ResolveAsync` 消息，**不是**后端 `src/core/node-runtime.ts:145-148` 的 `NodeRuntimeReport.message`。也就是说**同一句中文在两个进程里各写了一份**；改文案时两处必须同步，否则"判据"与"用户实际看到的消息"会脱节。

同类"跨进程同句两份"的另一处：预检状态名——`src/core/preflight.ts:91-97` 的 `PREFLIGHT_STATUS_LABELS` ↔ `Controls/PreflightReportView.xaml.cs:179-187` 的 `StatusLabel()`（后者还被界面复用 3 次：`:161-167` 图标、`:170-176` 状态色、`:189-195` 徽标样式）。**注意 `PREFLIGHT_STATUS_LABELS` 目前 RPC 不传**，前端这份副本才是实际上屏的那个——i18n 时应收敛成一份。

#### 障碍 3：UI 自动化测试靠**中文 UIA 名字**定位控件

- `scripts/test/lib/labels.mjs:1-8` 的说明：「**所有面向界面的中文字面量集中在这里**」，且「界面文案一旦改动，只会有一个地方需要跟着改」。
- 用例按**精确的 UIA 名字**取控件，例如 `labels.mjs:43` 的 `railEntries: ['实例','引擎版本管理','全局设置','关于 WhalesLauncher']`，注释明确说「用例按**精确的 UIA 名字**定位它们，而不是'文本出现在子树里'」。
- `run-ui-tests.mjs:203-211` 用一份**净化过的 env** 拉起用例，`:372-389` 把 `LABELS` 序列化进 JSON context 传给 PowerShell。

**结论**：语言一旦可切换，8 个页面用例（`scripts/test/ui/*.ps1`）+ 视觉审计都会因"名字对不上"而全线失败。缓解措施见 §5——**必须在 B1 批次就位，不能留到最后**。

---

## 2. 技术选型

### 2.1 路线 A：官方 `.resw` + MRT（`x:Uid`）

- 资源放 `Strings/zh-CN/Resources.resw`、`Strings/en-US/Resources.resw`；XAML 用 `x:Uid`，代码用 `ResourceLoader`。
- 需在 `csproj` 声明 `DefaultLanguage`（或 `NeutralLanguage`）、确保 `.resw` 参与 PRI 生成。
- **优点**：WinUI 3 原生机制，XAML 编译期即可校验 `x:Uid` 存在性；`ContentDialog`、`NavigationViewItem`、`AutomationProperties` 都有既定的 Uid 后缀约定；与系统语言/文本缩放同源。
- **风险**：本工程是 **unpackaged（`WindowsPackageType=None`）+ `EnableMsixTooling=false` + `dotnet build`**（`WhalesLauncher.App.csproj:13,18`），这是社区报告本地化失效的高发组合（§2.4）。

### 2.2 路线 B：自建 `strings.json` + `Localizer` 服务

- 一份或两份 JSON，`Services/Localizer.cs` 提供 `T(key, args)`；XAML 侧大量改用绑定或 `x:Name` + 代码赋值。
- **优点**：完全可控，不依赖 PRI/打包行为；热重载与迭代快；语言热切换更容易做（`INotifyPropertyChanged`）。
- **缺点**：XAML 静态文本必须逐条改成绑定或赋值 → **改造量显著大于路线 A**（1 068 条里 412 条是 XAML）；失去编译期校验；等于自造一套 MRT。

### 2.3 对比

评级 ● 优 / ◐ 中 / ○ 差。**注意最后三行是本项目特有的权重项**。

| 维度 | 路线 A（`.resw` / MRT） | 路线 B（自建 JSON + `Localizer`） |
|---|---|---|
| **XAML 标记（~393 处属性）** | ● 各加一个 `x:Uid`，**不改 XAML 结构**；编译期可校验 | ○ 逐条改 `{x:Bind}`／代码赋值；每个 `DataTemplate`/`UserControl` 还要 `x:DataType`；`AutomationProperties.Name`（109 处）等附加属性的可绑性要逐点验证 |
| **C# 文案（~499 处字面量）** | ○ **覆盖不到**（`x:Uid` 只作用于 XAML 标记）→ 仍须另写 `ResourceLoader.GetString` 层 | ● 同一套字典同时服务 XAML 与 C#，无第二套机制 |
| 接入成本（csproj） | ● **几乎为零**：`EnableDefaultWindowsAppSdkPRIResourceItems` 已生效、`.resw` 通道本来就开着（§2.4 E3/E4）；只需补 `DefaultLanguage` | ● 只需新增 1 个服务 + 2 份 JSON |
| 构建期校验 | ● 官方工具链（VS 资源编辑器、MakePri） | ◐ 可用「键常量生成 + 键集合一致性测试」补回大半（约 100 行脚本） |
| 改文案的迭代速度 | ○ 必须 `dotnet build`（XamlCompiler + MakePri），可能触发本工程已知的 `obj\` 锁竞争与 `WMC9999` 幽灵错误 | ● 改 JSON → 只重启 exe，**不触发 MSBuild** |
| 运行时语言切换 | ○ MRT 有语言解析/缓存语义，已加载的 XAML 文本不回溯刷新；`PrimaryLanguageOverride` 有读回 null 的已知缺陷（#6118） | ● 换字典 + 刷绑定，完全可控 |
| **测试闭环（本项目强约束）** | ○ 语言一旦随系统走，**35 处中文 UIA 定位 + 20 处文本判据**集体失效（§5） | ● 主包恒为中文时**零改动** |
| **视觉审计** | ● 基本解耦（窗口按标题 `WhalesLauncher` 匹配、C4 判据纯几何、C5 同一次运行内两帧互比） | ● 同左 |
| 交付风险 | ◐ PRI 变成**运行时关键文件**：漏拷即取词失败（#5814）。而本工程的交付目录是**人工同步**的（§2.4 E8） | ● 资源缺失可回退键名/中文，**不白屏** |
| 长期演进 | ● 若要社区翻译 / MSIX 商店 / 语言包按需下载，A 是唯一顺路 | ◐ JSON → `.resw` 是机械转换，不是死路 |

### 2.4 实测证据（一手读取，非推断）

两个**只读 MSBuild 探针**（以 `-p:CustomAfterMicrosoftCommonTargets` 注入，**未修改任何工程文件**）与实际产物 dump 得到以下事实：

| # | 事实 | 证据 |
|---|---|---|
| E1 | PRI 由 `dotnet build` 内的 MSBuild 任务链生成（`WinAppSdkGenerateProjectPriFile` → `makepri.exe`），落盘 `$(TargetDir)$(TargetName).pri` | 探针：`ProjectPriFileName=WhalesLauncher.pri`、`ProjectPriFullPath=…\bin\Debug\…\win-x64\WhalesLauncher.pri`、`MakePriExeFullPath=…\.nuget\packages\microsoft.windows.sdk.buildtools\10.0.26100.4654\bin\…\makepri.exe`、`MrtCorePriGenTargets imported=True` |
| E2 | **`DefaultLanguage` 实测 = `en-US`**（SDK 默认值），与"产品全中文"不符 | 探针输出；物证 `obj\Debug\…\win-x64\priconfig.xml:5` = `<qualifier name="Language" value="en-US" />` |
| E3 | **`.resw` 的通道本来就开着，只是没人往里放东西** | 探针 `PRIResource count = 0`；`obj\…\resources.resfiles` = **0 字节**；但 `priconfig.xml` 的第二个 `<index>` 写着 `type="RESW"` / `type="RESJSON"` / `type="RESFILES"` |
| E4 | `.resw` 自动纳入 `@(PRIResource)` 的开关**已生效**，接入几乎零 csproj 成本 | 探针 `EnableDefaultWindowsAppSdkPRIResourceItems=true`、`AppxGeneratePriEnabled=true`；依据 `Microsoft.NET.Sdk.DefaultItems.props:40` |
| E5 | MRT Core 在 unpackaged 下**可用，零额外 NuGet 包、零手写 Initialize** | NuGet 缓存含 `Microsoft.Windows.ApplicationModel.Resources.dll`（158 048 B）+ `.Projection.dll`（68 960 B），`WhalesLauncher.deps.json` 有投射条目；self-contained 下由 `UndockedRegFreeWinRT-AutoInitializer.cs:27-36` 设 `MICROSOFT_WINDOWSAPPRUNTIME_BASE_DIRECTORY` 为 MRT Core 指路 |
| E6 | 应用 PRI 里**应用自己的字符串资源 = 0**；219 条字符串全部属于框架 | `makepri dump` 实测：`<ResourceMap name="WhalesLauncher">` 下**无任何 `Resources` 子树**（三个 `Resources` 子树分属 `Microsoft.UI` / `Microsoft.UI.Xaml` / `Microsoft.Windows.Workloads`） |
| E7 | MRT 语言维度对**框架组件**已经生效 | 本文独立 dump 复核：`Candidate` 18 035，其中 `qualifiers="Language-*"` **18 011**；具名资源 251（**22 个 `.xbf`** = XAML 已进 PRI）；PRI 内 1 922 个中文字符（`白色`/`灰色`，另有日文 `淡い灰色`）——**框架的多语言值，不是本项目文案** |
| E8 | 交付目录 `artifacts/WhalesLauncher-win-x64` **不是构建产物**，是人工同步的快照 | 与 `bin\Release\…\win-x64` 逐字节一致（含 PRI 2 260 032 B）；`publish-release.ps1` 只写 `artifacts\release-staging` |

**这组事实把 R1（T0）从"未知"降为"已知且范围明确"**：MRT 的语言机制在这个 unpackaged 分发物里**已经能按语言选资源**（否则框架那些 `Language-KO-KR` / `Language-JA-JP` 候选毫无意义）；E3/E4 说明接入 `.resw` 几乎是免费的（只差 `DefaultLanguage`）。待验证的不是"能不能用"，而是"**应用侧 `.resw` 能否生成 `Language-zh-CN` / `Language-en-US` 具名资源并被选中**"。

> **边界**：E5/E6 是**直接读取 NuGet 缓存与 SDK targets**（一手），E7 是**对已构建产物的静态分析**。两者都不能替代"应用自己走一遍构建"——B0 仍必需。

> **社区旁证（未实读原文）**：搜索结果指向几个已知问题——[#5832 升级 1.8 破坏 unpackaged 的 ResourceLoader](https://github.com/microsoft/WindowsAppSDK/issues/5832)、[#5814 `resources.pri` 缺失时 MRM 直接报错](https://github.com/microsoft/WindowsAppSDK/issues/5814)、[#6118 `PrimaryLanguageOverride` 读回 null](https://github.com/microsoft/WindowsAppSDK/issues/6118)、[#5987 PRI 发现依赖 base directory 与进程戳](https://github.com/microsoft/WindowsAppSDK/issues/5987)、[#6375 / #6376 模块级 `.pri` 发现](https://github.com/microsoft/WindowsAppSDK/pull/6376)。本会话 `web_fetch` 对 `learn.microsoft.com` / `github.com` 解析到非公网 IP，**这些只作旁证，不作为设计依据**；依据是 E1–E8。

### 2.5 推荐：**混合**（XAML 走 A、C# 走 B）

**推荐：XAML 标记用 `x:Uid`（路线 A 的机制），C# 文案用 `Localizer` 服务（路线 B 的机制）。**

1. **路线 A 覆盖不到 C#**：`x:Uid` 只作用于 XAML 标记，而 C# 侧有约 **499 处**中文字面量。所以"选 A 还是选 B"在 C# 侧是**伪选择**——不管怎么选，都有一个资源服务要写。
2. **XAML 侧 A 明显更省**：393 处属性各加一个 `x:Uid` 即可，**不动 XAML 结构、不引入 `x:DataType`**；B 则要逐条改绑定，并对 109 处 `AutomationProperties.Name` 这类附加属性逐点验证可绑性。
3. 于是混合 = **A 用在它真正省力的地方（XAML 标记）+ B 用在它必须存在的地方（C# 与动态文案）**。

**分歧登记（不作单方面取舍）**：并行调研的独立结论与本推荐不同，主张「**B 为主线、A 只预留**」。它的理由都是真实代价，决策者应当看到：

| # | 反方理由 | 本方案的处置 |
|---|---|---|
| D-a | **测试闭环**：`scripts/test` 有 35 处按中文 UIA `Name` 精确定位 + 20 处文本判据；而 A 的语言锁定依赖 `PrimaryLanguageOverride`（有读回 null 的 #6118，且必须早于任何 XAML 解析） | **已在 D4/D7 处置**：默认 `zh-CN`、显式配置、不做"跟随系统"默认；测试语言锁定列为 B1 首项（§5）。**但若 Lead 决定"默认跟随系统"，D-a 立即升级为否决条件**，届时应改选 B |
| D-b | **构建链**：A 让"改一个错别字"变成"跑一遍 XamlCompiler + MakePri"，而本工程构建链已有多轮坑（`obj\` 锁竞争、`WMC9999` 幽灵错误、`EnableMsixTooling` 与 unpackaged 互斥） | **未消除，只是限制在 XAML 侧**（~393 处）。若文案迭代成为瓶颈，应改选 B |
| D-c | **迭代速度**：B 改 JSON 后只需重启 exe，不触发 MSBuild | 同上 |

**改选 B 的翻牌条件**（满足任一条即应重新评估）：① 需要接入外部翻译服务 / 社区翻译（`.resw`/XLIFF 是行业交换格式）；② 需要 MSIX 商店分发；③ 需要按需语言包 / ODR；④ 把 35 处 `Find-ByName` 改为 `Find-ByAutomationId`（当前已是 77 : 35，改造方向天然存在）。

#### 2.5.1 `csproj` 建议片段（**未写入任何文件**）

```xml
<PropertyGroup>
  <!-- 【必加】PRI 的 fallback 语言。实测当前为 en-US（SDK 默认），与全中文产品不符（§2.4 E2） -->
  <DefaultLanguage>zh-CN</DefaultLanguage>

  <!-- 【建议显式，防回归】实测已为 true，写死是防止 SDK 默认值变化或误设 EnableDefaultItems=false 时静默丢资源 -->
  <EnableDefaultWindowsAppSdkPRIResourceItems>true</EnableDefaultWindowsAppSdkPRIResourceItems>
  <AppxGeneratePriEnabled>true</AppxGeneratePriEnabled>
</PropertyGroup>

<ItemGroup>
  <!-- 【可选】显式声明以替代 SDK 的 **/*.resw 通配；一旦显式声明须防与通配重复（重复项会让 MakePri 报重复 key） -->
  <PRIResource Include="Strings\**\*.resw" />
</ItemGroup>
```

**明确不要做的三件事**（都是本项目实测踩过的坑）：

1. **不要**打开 `EnableMsixTooling=true`「顺手修 PRI」——会导入整套 MSIX 打包管线（`SingleProject.targets`），而 `publish-release.ps1:18-26` 已记录它与 `PublishSingleFile` 互斥，且这正是 `WindowsPackageType=None` 要关掉的东西。
2. **不要**给 `Microsoft.Windows.ApplicationModel.Resources` 加 `PackageReference`——它由 `Microsoft.WindowsAppSDK.Foundation` 传递携带（§2.4 E5），重复引用会引入版本冲突。
3. **不要**改 `<TargetName>` 或 PRI 文件名——`ProjectPriFileName = $(TargetName).pri` 是 unpackaged 下 MRT Core 按已知名字发现 PRI 的契约（§2.4 E1），改名会连带 `ms-resource://` URI 前缀一起漂移。

#### 2.5.2 击穿实验（B0）的验收问题

放在 `.probe/` 下（沿用本项目 spike 惯例）：

1. `.resw` 在 `EnableMsixTooling=false` + `WindowsPackageType=None` 下能否生成**带 `Language-zh-CN` / `Language-en-US` 限定符**的具名资源并合并进应用 PRI？**判据（可机械核对）**：dump 生成的 `.pri`，确认应用 XBF 的候选从"单一 neutral"变成"两份语言候选"，且出现 `Err_*` / `P1_*` 等具名资源。
2. `ResourceLoader.GetString("...")` 与 `x:Uid` 在**非打包**运行下是否都能取到值？
3. 语言覆盖（切到 `zh-CN`/`en-US`）在 unpackaged 下是否生效？用哪种机制？
4. `string` 型 vs 需要 `ResourceContext` 显式指定语言的差异？
5. 用现有 `desktop/build-app.ps1` 走一遍（它带命名 Mutex 串行化，`winui3-impl-brief.md:71-83` 要求一律用它），确认真实窗口能显示英文。

**若 B0 判定路线 A 不可行**：退回路线 B，但**只对 XAML 用 `x:Uid` 的替代**——即 `Services/Localizer.cs` + 把 XAML 文本逐条改为 `x:Bind`（`winui3-impl-brief.md:56` 本就要求"数据绑定优先 `x:Bind`"），代价是 412 条 XAML 的重写进入关键路径。

---

## 3. 目标架构

### 3.1 资源分层与键名规范

| 层 | 键前缀 | 例 |
|---|---|---|
| 外壳（标题栏、左栏、菜单、日志抽屉） | `Shell_` | `Shell_Rail_Instances`、`Shell_Menu_File` |
| 页面静态文本 | `<页>_` | `P1_Toolbar_Create`、`P8_Appearance_Title` |
| 控件类文案（按钮/占位符/提示） | `<页>_<区>_<角色>` | `P1_Empty_NoInstance_Title` |
| 派生文本模板（带参数） | `<域>_<语义>` | `Status_Running`、`Time_MinutesAgo`、`Preflight_ProblemCount` |
| 错误（后端码映射） | `Err_<code>` | `Err_instance.not-found` |
| 项目术语（唯一译法，见 §6） | `Term_` | `Term_Instance`、`Term_Engine` |

规则：

1. **键名只用 ASCII**（`A-Za-z0-9_`），中文/英文只出现在值里。
2. 键名**不承载视觉信息**（不要 `P1_RedButton2`）。
3. 一个中文串在**多个位置**出现时，若语义相同就复用同一键（防术语漂移）；若语义不同必须分键（否则改一处影响一片）。
4. 带参数的键用 `{0}`/`{1}`，**参数名写进注释**，避免译者搞错顺序。

### 3.2 前端取用方式

- **XAML**：`x:Uid="P1_Toolbar_Create"` → `.resw` 中 `P1_Toolbar_Create.Content`；`Text` / `Header` / `PlaceholderText` / `ToolTipService.ToolTip` 有各自的后缀约定。
- **可访问性名字必须一并资源化**：本项目 UI 测试与无障碍都依赖 `AutomationProperties.Name`，例如 `MainWindow.xaml.cs:668` 的 `$"切换深浅色主题（{label}）"`、`labels.mjs:41` 的 `关于 WhalesLauncher`。MRT 对附加属性的 Uid 形如 `Uid.[using:Microsoft.UI.Xaml.Automation]AutomationProperties.Name`，**须在 B0 里顺带验证能否取到**（取不到则这几个点改用代码赋值）。
- **C#**：统一走 `Services/Localizer.cs`（薄封装 `ResourceLoader`，提供 `T(key)` / `T(key, args)`），**不**在页面里直接 `new ResourceLoader()`——集中一处便于后续替换与测试。
- **禁止**在 XAML 里留中文兜底值再靠 `x:Uid` 覆盖：`x:Uid` 生效时 XAML 里的字面量会被覆盖，看着像没事，但一旦 PRI 加载失败就退化成"以为翻译了"（这个坑正好是本工程 T0 风险的伪装形式）。

### 3.3 派生文本：先把重复的映射合并

**同一份状态标签有 3 个实现，主按钮文案有 2 个**（普查证据见 `docs/audit/i18n-frontend-audit.md` §1.4）：

| 映射 | 位置 | 备注 |
|---|---|---|
| 运行态 → 中文标签（1/3） | `Shell/InstanceStateText.cs:20-29` | 有 `null or ""` → `"状态未知"`；未知值原样返回 |
| 运行态 → 中文标签（2/3） | `Views/InstancesPage.xaml.cs:1152-1160` | 卡片路径自己一份 |
| 运行态 → 中文标签（3/3） | `Views/Detail/StatePresentation.cs:14-21` | **无**"状态未知"分支 |
| 运行态 → 主按钮文案（1/2） | `Views/Detail/StatePresentation.cs:26-30` | 启动 / 启动中… / 停止 / 停止中… / 重新启动 |
| 运行态 → 主按钮文案（2/2） | `Views/InstancesPage.xaml.cs:1243-1250` | 卡片路径又一份 |
| Node 来源 → 中文名（**3 份且已漂移**） | `Services/CoreBridge.cs:185-194`、`Views/EnginesPage.xaml.cs:364-372`、`Views/SettingsPage.xaml.cs:563-571` | `EnginesPage` 那份**漏了 Portable 分支** |
| 共享 / 凭证 → 中文名 | `Views/Detail/InstanceSettingsView.xaml.cs:38-48` + `:563`、`Views/WizardPage.xaml.cs:676-680` | 2 份 |
| 插件来源 → 徽标、自检状态 → 中文名 | `Views/Detail/LocalPluginRow.cs:36-43`、`Controls/PreflightReportView.xaml.cs:181-185` | 各 1 份 |

这些副本**已经不一致**（状态标签有的有空态文案、有的没有；Node 来源有一份漏分支）。i18n 会把这种不一致放大成"同一状态在中英文下走不同分支"——**英文界面会最先暴露这些既有 bug**。

**动作**：合并为单一映射（建议放 `Services/InstanceStateText.cs`，它已被多个页面复用），返回**资源键**而不是最终文本：

```csharp
public static string? LabelKey(string? state) => state switch
{
    InstanceStateValues.Running  => "Status_Running",
    InstanceStateValues.Starting => "Status_Starting",
    InstanceStateValues.Stopping => "Status_Stopping",
    InstanceStateValues.Crashed  => "Status_Crashed",
    InstanceStateValues.Stopped  => "Status_Stopped",
    null or ""                   => "Status_Unknown",
    _ => null,                     // null = 无键：调用方按原值原样显示
};
```

保留 `InstanceStateText.cs:17-19` 的既有意图——**未知取值原样显示而不吞掉**，这样后端新增状态时界面立刻暴露。

> **不在此列**：`Models/*Values.cs`（`InstanceStateValues` / `ShareModeValues` / `CredentialsModeValues` / `InstanceFolderValues` / `PluginOriginValues`）存的是 `"running"` / `"local"` 这类**英文契约机器值**，用于 RPC 参数与字符串比较（如 `Views/InstancesPage.xaml.cs:375`），**属 i18n 安全区，一律不翻译**（见 §8）。

### 3.4 格式化本地化（`Services/Formatters.cs`）

需要翻译的"词"（`:42-74`、`:115`）：`从未启动`、`刚刚`、`{n} 分钟前`、`{n} 小时前`、`昨天 HH:mm`、`{n} 天前`、`未知`、`—`。

按 D6 **不做** `CultureInfo` 敏感化：数字仍 `InvariantCulture`，日期仍 `yyyy-MM-dd HH:mm`。理由（尊重既有设计）：`Formatters.cs:6-9` 明确写了"刻意**不用**文化敏感格式化……以保证与旧版输出逐字一致 —— 这样审计时可以拿新旧截图直接对比，不会因格式化差异产生噪声"。改成区域敏感会让视觉审计的截图对比产生大量与 i18n 无关的噪声。

英文侧取**保守译法**，避免复数陷阱：

| 键 | zh-CN | en-US |
|---|---|---|
| `Time_JustNow` | 刚刚 | just now |
| `Time_MinutesAgo` | {0} 分钟前 | {0} min ago |
| `Time_HoursAgo` | {0} 小时前 | {0} h ago |
| `Time_YesterdayAt` | 昨天 {0} | yesterday {0} |
| `Time_DaysAgo` | {0} 天前 | {0} d ago |
| `Time_Never` | 从未启动 | never launched |

用 `min / h / d` 这类**不随数量变化**的缩写，绕开英文 `1 minute` / `2 minutes` 的复数规则——本方案不引入 ICU/PluralRules，因此**必须避免**所有需要复数的句式（这条约束应写进 §7 的评审清单）。

### 3.5 后端：错误码化（协议增补，**需 Lead 批准**）

#### 3.5.1 向后兼容的载荷设计

```ts
/** 面向用户的失败说明（可翻译）。 */
export interface UserMessage {
  /** 稳定错误码：`<域>.<原因>`，如 `instance.not-found`。 */
  code: string;
  /** 插值参数（实例名、路径、端口等）；值已是字符串，不做二次格式化。 */
  params?: Record<string, string | number>;
  /** 中文原文：未翻译时的回退、日志与崩溃报告仍用它。 */
  fallback: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message?: UserMessage };
```

关键性质：

- **`error` 字段原样保留**（仍是面向用户的中文）→ 协议 §2.3 的冻结语义**不变**，`winui3-impl-brief.md:54`「用 `result.Error` 原文」的既有约束仍成立；
- `message` 是**可选新增**字段 → 老读取方（未同步的调用点、外部脚本、`scripts/audit/bridge-smoke.mjs`）不受影响；
- C# 侧改为：**有 `message.code` 且有对应资源键 → 显示译文；否则显示 `error` 原文**。这样"漏翻译"退化成"显示中文"，而**不是**显示空白或键名——这是本设计最重要的安全属性。

`.resw` 里对应键：`Err_instance.not-found` = `实例不存在：{0}` / `Instance not found: {0}`。

#### 3.5.2 需要码化的清单（按域）

| 域 | 代表码 | 现状出处（示例） |
|---|---|---|
| 启动器 / 配置 | `config.invalid`、`node.runtime-missing` | `App.xaml.cs:138`（**必须**改判据）、`SettingsPage.xaml.cs` |
| 实例 | `instance.not-found`、`instance.name-invalid`、`instance.running` | `src/core/names.ts`、`src/core/instance.ts` |
| 引擎 | `engine.not-installed`、`engine.install-failed` | `src/core/engine.ts` |
| 插件 | `plugin.pack-invalid`、`plugin.allow-builds` | `contracts.ts:279` 的 `AllowBuildsError` |
| 端口 | `port.in-use`、`port.ledger-busy` | `src/core/ports.ts` |
| 预检 | `preflight.*` + 每项的 `title/summary/detail/advice` | `contracts.ts:497-513`、`src/core/preflight.ts` |
| 桥接层 | `bridge.unknown-method`、`bridge.bad-params` | `desktop/bridge/validate.mjs`、协议 §4（`:134-136`） |

`node.runtime-missing` 同时是障碍 2 的修复载体：C# 侧判据从"消息含中文"改为"错误码相等"。

#### 3.5.3 边界：哪些后端文案**不**翻译

| 不翻译 | 理由 |
|---|---|
| `stderr` 日志（协议 §1：不参与协议） | 排障信息，且翻译会让社区排障时对不上官方日志 |
| `PreflightCheck.detail` 里的原始路径/命令/版本号 | 机器事实，翻译反而有害 |
| `Debug.WriteLine` 系列 | 不进 UI |
| 抛给 Node 的底层异常原文（如 `AllowBuildsError` 附带的 npm 输出） | 保留原样供复制排障，**只翻译包裹它的那句话** |

`PreflightCheck` 的 `title/summary/advice` 属于**产品文案**，必须翻译；`detail` 属于**混合**，建议由后端改为"结构化片段"或干脆保持原样（本方案取后者，标注为已知残留）。

### 3.6 语言配置与持久化

```ts
// contracts.ts 的 LauncherConfig 增补
/** 界面语言；`system` = 跟随系统。默认 `zh-CN`（对现有用户零行为变化）。 */
language: 'system' | 'zh-CN' | 'en-US';
```

- `schemaVersion` 由 `1` → `2`；**读旧配置时 `language` 缺失 → `zh-CN`**（D4）。
- 该字段是对**冻结配置契约**的增补：需按协议 §6 流程由 Lead 批准，并**同时**更新 `contracts.ts` 与 C# 侧 `Models/LauncherConfig.cs`。注意本项目已有一条相关先例——`launcher:preflight` 特意"**不改 `LauncherConfig`**（避免触碰冻结配置契约）"（`winui3-bridge-protocol.md:164`），说明这条边界是被有意维护的，本次必须显式走流程而不是顺手加。
- 设置页入口：放进现有「外观」区（`SettingsPage.xaml:91-97` 的 `RadioButtons` 模式，与 `ThemeRadios` 并列），复用 `SettingsPage.xaml.cs:216-231` 的"改配置 → 落盘 → 立即应用"三连写法。

### 3.7 切换生效策略（D3）

主题能即时生效，是因为它作用在**可视树**上：`RootGrid.RequestedTheme`（`MainWindow.xaml.cs:617-630`、`SettingsPage.xaml.cs:161-165`）。语言**没有**这样的机制——XAML 文本在加载时已固化成字符串。

| 方案 | 代价 | 结论 |
|---|---|---|
| **a. 重启生效** | 需一条"重启后生效"提示（可用现有 `ToastService`/`InfoBar`） | **首版采用** |
| b. 重建页面/外壳 | 需处理导航栈与未保存状态，`MainWindow` 有深链机制（`ApplySmokeRoute`，`MainWindow.xaml.cs:114`）需复验 | 二期 |
| c. 全绑定化 + `INotifyPropertyChanged` | 412 条 XAML 全部改绑定，改造量翻倍 | 不做（除非 B0 判定必须走路线 B） |

---

## 4. 迁移批次

| 批次 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **B0** | 击穿实验：`.probe/` 最小工程，回答 §2.5.2 的 5 个问题 | 无 | 真实窗口截图为证：能显示 `en-US` 资源；给出"应用侧 `.resw` 可用 / 不可行"的明确结论 |
| **B1** | 基础设施：`Localizer` + `language` 配置（含 schema 迁移）+ 设置页开关 + 空资源文件 + **测试语言固定**（§5） | B0 | 切到 `en-US` 后界面仍中文（尚未迁移），但**测试全绿**、配置能落盘与回读 |
| **B2** | 外壳：`MainWindow`（标题栏/左栏/菜单）、`ToastService`、`DialogService` 默认文案、状态映射合并（§3.3） | B1 | 外壳可见文本全英文；UIA 名字双语正确 |
| **B3** | 页面 × 8（P1–P8，沿用"一页一 owner"的既有写范围纪律） | B1 | 每页：英文下无中文残留、无截断破相、截图过 `scripts/audit` |
| **B4** | 后端错误码化（协议增补 + `src/core/**` + `bridge/**`） | B1 | `node.runtime-missing` 判据生效（§3.5.2）；`bridge-smoke` 通过 |
| **B5** | 格式化与动态文案（`Formatters`、`PreflightReportView`、`NodeProvisioner` 进度） | B1 | 相对时间/体积/预检报告在英文下正确 |
| **B6** | 双语测试与审计：`labels.mjs` 加 `en` 集 + 新增"语言切换"用例 | B2–B5 | 双语用例各跑一遍全绿 |

参照 `winui3-impl-brief.md:71-83` 的构建纪律：**一律走 `desktop/build-app.ps1`**（命名 Mutex 串行化，避免 `WMC9999` 幽灵错误），**不要加 `-Rebuild`**。

---

## 5. 测试与自动化改造（**必须在 B1 就位**）

现状：UI 用例按**精确中文 UIA 名字**定位（§1.4 障碍 3）。语言一旦可选，测试会因名字不匹配而全线失败——**且失败原因会伪装成"控件找不到"**，极易被误判为页面坏了。

措施（按优先级）：

1. **测试环境强制固定语言**：`run-ui-tests.mjs:203-211` 已在构造一份净化 env 再传给用例，**在同一处**注入 `WHALES_UI_LANG=zh-CN`（或 `en-US` 用于双语用例），并由 app 在启动最早时机读取该变量覆盖配置。这样：测试不依赖**开发者机器**的语言设置，CI 可复现。
2. **`labels.mjs` 保持中文为主集**，新增 `LABELS_EN`：用例通过同一个键名取期望值，断言逻辑不变——避免 8 个 `.ps1` 出现两套逻辑。
3. **新增一条"语言切换"用例**（`scripts/test/ui/shell.ps1` 已有外壳用例可扩展）：切到英文 → 断言若干关键 UIA 名字变为英文 → 切回 → 断言复原。这是唯一能防"切了语言但半页还是中文"的用例。
4. **视觉审计**（`scripts/audit/audit-visual.ps1`、`docs/audit/**`）建议加一轮 **en-US 基线截图**，重点看英文变长后的：左栏项（`系统内置 `OpenPaneLength`，`winui3-visual-spec.md:655`）、按钮、`InfoBar`、对话框。规范里的截断规则是 `TextTrimming="CharacterEllipsis"` + `TextWrapping="WrapWholeWords"`（`winui3-visual-spec.md:293`），英文文本必须复验。
5. **注意 `.ps1` 不能写中文**（PS 5.1 按 ANSI 读脚本，`labels.mjs:3-8`、`winui3-impl-brief.md:90`）：英文断言值**可以**直接写进 `.ps1`（ASCII），反倒是中文必须继续走 JSON context。这条会**降低**英语用例的复杂度，不要画蛇添足。

---

## 6. 术语表（唯一译法）

i18n 最容易失败的地方不是语法而是**术语漂移**。以下为建议基线，**实施前由 Lead 定稿**：

| 中文 | en-US | 备注 |
|---|---|---|
| 实例 | instance | 不用 profile / sandbox |
| 引擎 | engine | dsh 引擎 = dsh engine |
| 实例包 | instance pack | 与 `pack:*` 通道对应 |
| 隔离 | isolation | 三种隔离模式见 `InstanceFolderValues` |
| 共享 | share | |
| 自检 | preflight check | 与 `launcher:preflight` 一致，不用 self-test |
| 桥接 / 侧车 | bridge / sidecar | 面向用户时避免出现，属内部词 |
| 全局设置 | Settings | 左栏项，见 `labels.mjs:36` |
| 引擎版本管理 | Engine versions | `labels.mjs:35` |
| 运行日志 | Logs | `labels.mjs:20` |
| 需处理 | Needs attention | `labels.mjs:66` |

规则：同一概念**只允许一个译法**；界面里出现的**路径指引**（如 `全局设置 → 环境自检`、`运行日志（Ctrl+L）`，见 `PreflightPresenter.cs:71,94`）必须与目标语言的**实际控件名逐字一致**——否则用户按提示找不到地方。

---

## 7. 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 应用侧 `.resw` / PRI 在 unpackaged + `dotnet build` 下不生效 | **T0**（已按 §2.4 收窄） | 不确定性已从"MRT 能否工作"缩小到"应用侧资源能否生成语言限定符"；B0（§2.5.2）先决，失败则 XAML 侧退路线 B |
| R2 | 改错误形状触碰**冻结协议**与**唯一事实源契约** | 高 | 只**增补**可选字段、保留 `error`；按协议 §6 由 Lead 批准并同步更新文档与两端（§3.5） |
| R3 | UI 自动化测试全线失效且伪装成"页面坏" | 高 | B1 就位语言固定 + `LABELS_EN`（§5） |
| R4 | `x:Uid` 生效后 XAML 里的中文兜底值被覆盖，**PRI 加载失败时静默退化** | 中 | 禁止中文兜底；B0 验证失败路径 |
| R5 | 英文变长导致截断/换行破相（最小宽度 1024，`winui3-visual-spec.md:142`） | 中 | en-US 截图基线 + 逐页 §12 自检 |
| R6 | 插值参数顺序错误（`{0}`/`{1}` 在两种语言里位置不同） | 中 | 键注释写明参数名；B6 双语用例覆盖 |
| R7 | 复数句式（`1 minute` / `2 minutes`） | 中 | **约定不使用复数句式**（§3.4），评审清单逐条查 |
| R8 | 翻译质量（无专业译者，由实现者自译） | 中 | 术语表 + 英文母语者复核（本机无该资源，标注为**已知限制**） |
| R9 | 漏翻译（1 068 条不可能一次全中） | 中 | 设计上"漏译 → 显示中文"而非空白（§3.5.1）；B3 每页过"英文下无中文残留"的检查 |
| R10 | `App.xaml.cs:138` 判据失效导致便携版 Node 下载静默失灵 | 高 | 列为 B4 首项，改成错误码相等（§3.5.2） |
| R11 | **中文词被当参数/维度传进句子再拼回** → 英文下词序错乱 | 高 | `Views/Detail/InstanceSettingsView.xaml.cs:451,462,472,483` 把 `dimension: "工作区"/"存档"/"设置"/"凭证"` 传入，`:525` 拼成「将把「{dimension}」从「…」改为「…」」；`PluginsView.xaml.cs:265` 同型。**必须改为资源键 + 参数**，不能译字面量（参 `PreflightPresenter.cs:206-211` 的 6 行拼接） |
| R12 | 菜单文案在**后端**、不在前端的 1 068 条口径内 | 中 | 文案实体在 `desktop/bridge/menu.mjs`（**28 条** = 23 个菜单项 + 5 个分组，如 `'文件'` `:39`、`'打开启动器目录'` `:41`）；`Shell/AppMenuBuilder.cs` 是**纯投影器**（`Title = node.Label`），中文 0 条。**B4 的后端范围必须含它**——契约 `contracts.ts:616-632` 明确禁止渲染层自建第二份定义。<br>**本条系两方调研结论冲突的裁决**：一方只在 `src/` 下检索（0 命中）而误判为"Node 侧 `menuSpec()` 未实现"，另一方在 `desktop/bridge/` 找到 28 条；本文以**实读 `menu.mjs`**（158 行、67 行含中日韩字符）为准 |

### 7.1 顺带修复的现存缺陷（i18n 会碰到，故一并登记）

1. **Markdown 星号泄漏**：`PreflightPresenter.cs:166` 的对话框正文里有 `**这一步开始后无法中途取消**`，而 `DialogService.Create` 用的是纯 `TextBlock`（`DialogService.cs:146-150`），**不解析 Markdown** → 用户看到的是字面星号。改法：拆成多个 `TextBlock`（或用 `RichTextBlock` 加粗该片段），翻译时一并处理。
2. **默认参数里的中文**：`DialogService.cs:99-101`（`primaryText = "确定"`、`closeText = "取消"`）与 `:119`（`closeText = "知道了"`）是**编译期固化的默认值**，最容易被 `grep` 漏掉（调用点看不见）。改法：默认值改为 `null`，在方法体内取资源。
3. **状态映射双份且已不一致**：§3.3。

---

## 8. 明确不做

| 不做 | 理由 |
|---|---|
| 第三种语言、RTL（阿拉伯语等）布局 | 超出"中英双语"目标；RTL 需要镜像布局，是独立工程量级 |
| 数字/日期/货币的区域敏感格式化 | D6：会破坏与旧版截图的逐字对比（`Formatters.cs:6-9`） |
| 复数规则引擎（ICU MessageFormat / PluralRules） | D6 的延伸；用非变形缩写规避（§3.4） |
| 翻译 `stderr` 日志与 `Debug.WriteLine` | §3.5.3 |
| 语言热切换（首版） | D3 |
| 本地化安装包/清单（`Package.appxmanifest` 显示名） | 本工程 unpackaged，无清单本地化面 |
| 帮助文档 / 教程图的双语化（`docs/guide/**`、`docs/assets/tutorial/**`） | 独立交付物；若需要应单独立项（本方案只管应用界面） |
| 翻译 `Models/*Values.cs` 里的英文契约机器值 | 它们是 RPC 参数与字符串比较用的 wire value（`"running"` / `"local"` / `"root"`），翻译会让桥接与判据失配（§3.3） |

---

## 9. 待验证项（本次**未能**查证，实施前必须落实）

| # | 待验证 | 为什么没查证 |
|---|---|---|
| V1 | `.resw` 在本工程 unpackaged 下的实际行为 | **已部分回答**：§2.4 实测证明 MRT 语言维度在本分发物里对框架组件已生效；剩"应用侧 `.resw` 能否生成语言限定符资源"须 B0 实测。本机网络受限，官方文档页无法抓取 |
| V2 | 语言覆盖的正确 API（`ApplicationLanguages.PrimaryLanguageOverride` vs MRT `ResourceContext`） | 同上；搜索结果中有"该 API 在 unpackaged 下不可用/返回空"的报告（[#6118](https://github.com/microsoft/WindowsAppSDK/issues/6118)），**未实读原文**。B0 应同时试两条路径并记录哪条生效 |
| V3 | `AutomationProperties.Name` 能否用 MRT Uid 附加属性语法 | 需 B0 实测；若不能，改用代码赋值（涉及 `MainWindow.xaml.cs:668` 等） |
| V4 | 本机是否存在英文 UI 测试所需的字体/区域设置差异 | 未测 |
| V5 | `PreflightCheck.detail` 是否值得结构化 | 本方案取"保持原样"，需产品确认可接受 |

> 说明：本节按 `winui3-visual-spec.md:6` 的既定做法——**查不到出处的条目显式标注，不做伪官方化**。

---

## 10. 验收标准（本方案完成的定义）

1. 设置页可切换 `中文 / English / 跟随系统`，**重启后生效**，配置落盘且 `schemaVersion` 迁移正确（旧配置读入不报错）。
2. 英文界面下：**除 §3.5.3 明确排除项与 `PreflightCheck.detail` 外，无中文残留**（检查方法：英文下逐页截图 + 全量自检）。
3. `App.xaml.cs` 的 `IsMissingRuntime` 判据**不再依赖文案**，且"缺 Node → 自动下载"路径实测可用（§3.5.2 / R10）。
4. 桥接协议文档已按 §6 流程更新（新增 `UserMessage` 与 `error` 的共存语义），两端实现同步。
5. 双语（zh-CN / en-US）各跑一遍 `scripts/test/run-ui-tests.mjs` **全绿**，且新增"语言切换"用例。
6. 视觉审计新增 en-US 基线截图，**无未登记的破相项**（截断、溢出、术语不一致）。
7. 术语表定稿并被实际文案遵守（`Term_*` 键无第二译法）。

---

## 附 A：本文行号口径（**复现前必读**）

本机 `$PSVersionTable.PSVersion` 实测为 **5.1.26100.9444**（即使通过 `pwsh -Command` 调用）。在 PS 5.1 上 `Get-Content` 有两个陷阱，本文所有行号**一律**不用它取得：

| 陷阱 | 实测表现 |
|---|---|
| 编码 | 按 ANSI 读 UTF-8 文件 → 中文乱码（本项目已知坑，`winui3-impl-brief.md:85-90`） |
| **行号偏移** | `(Get-Content $path)[497]` 取到的是**真实第 546 行**（`root: string;`）——空行被跳过，偏移量随文件空行数变化 |

> 因此：**本文行号来自 `read` / `grep` 工具（`ripgrep`，真实物理行号）**，已抽查复核（`contracts.ts:500` = `/** 中文标题（界面直接显示）。 */`、`:546` = `root: string;`）。若你用 `Get-Content` 复核而对不上行号，是工具口径差异，不是本文错误。
> 本文 §1.2 的统计用 `[System.IO.File]::ReadAllText($p, UTF8)` 显式解码，不受上述陷阱影响。

## 附 B：复现命令

```powershell
$root = 'F:\WhalesLauncher'
$enc  = [System.Text.UTF8Encoding]::new($false)

# 0) 基线
git rev-parse HEAD          # 期望 049f7705af575cfbbedc62fd5340421d44ffd05d

# 1) 零基础设施证据（三段都应无输出 / 0 命中）
Get-ChildItem $root -Recurse -File -Include *.resw,*.resx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\instances\\|\\obj\\|\\bin\\' }
Get-ChildItem "$root\desktop\src" -Recurse -Include *.xaml -File |
  Where-Object { $_.FullName -notmatch '\\obj\\' } |
  Select-String 'x:Uid' -Encoding utf8
Select-String -Path "$root\launcher.json" -Pattern 'language' -Encoding utf8

# 2) 中文文案判据（期望只剩 App.xaml.cs:138 一处）
#    注意：Select-String 对含中文的文件必须显式 -Encoding utf8
Get-ChildItem "$root\desktop\src" -Recurse -Include *.cs -File |
  Where-Object { $_.FullName -notmatch '\\obj\\|\\bin\\' } |
  Select-String '(Contains|StartsWith|EndsWith|IndexOf|==)\s*\(\s*"[^"]*[\u4e00-\u9fff]' -Encoding utf8

# 3) 文案条数量级（上限口径，显式 UTF-8 解码）
$n = 0
Get-ChildItem "$root\desktop\src" -Recurse -Include *.cs,*.xaml -File |
  Where-Object { $_.FullName -notmatch '\\obj\\|\\bin\\' } | ForEach-Object {
    $t = [System.IO.File]::ReadAllText($_.FullName, $enc)
    $t = [regex]::Replace($t, '<!--.*?-->', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $t = [regex]::Replace($t, '/\*.*?\*/', '',   [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $t = [regex]::Replace($t, '(?m)^\s*///.*$', '')
    $t = [regex]::Replace($t, '(?m)//.*$', '')
    $n += ([regex]::Matches($t, '"((?:[^"\\]|\\.)*)"') | Where-Object { $_.Value -match '[\u4e00-\u9fff]' }).Count
  }
$n    # 期望量级 ~1000（XAML 与 C# 合计）

# 4) PRI 内容分析（§2.4 E6/E7 的证据；本命令已实测通过，期望值已核对）
#    makepri.exe 随 Windows SDK 分发；也可从 MSBuild 属性 MakePriExeFullPath 取得实际路径
$mk  = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makepri.exe'
$pri = "$root\artifacts\WhalesLauncher-win-x64\WhalesLauncher.pri"
& $mk dump /if $pri /of "$env:TEMP\wl-pri-dump.xml" /o
$d = [System.IO.File]::ReadAllText("$env:TEMP\wl-pri-dump.xml", $enc)   # dump 带 BOM，ReadAllText 会自动识别
"NamedResource          = {0}" -f ([regex]::Matches($d,'<NamedResource\b')).Count                       # 251
"Candidate              = {0}" -f ([regex]::Matches($d,'<Candidate\b')).Count                          # 18035
"Language 限定符候选     = {0}" -f ([regex]::Matches($d,'qualifiers="Language-')).Count                 # 18011
"xbf 具名资源            = {0}" -f ([regex]::Matches($d,'<NamedResource\s+name="[^"]+\.xbf"')).Count    # 22
"'Resources' 子树       = {0}" -f ([regex]::Matches($d,'<ResourceMapSubtree\s+name="Resources"')).Count # 3
# 那 3 个 Resources 子树分属 Microsoft.UI / Microsoft.UI.Xaml / Microsoft.Windows.Workloads
# ——**没有一个是 WhalesLauncher 的**，这就是"应用自有字符串资源为 0"的直接证据
```

> **注意**：`makepri dump` 的输出编码不是 UTF-8 无 BOM；用 `Get-Content` 或裸 `[System.IO.File]::ReadAllText($p)`（不指定编码）读会看到乱码，那是**读取方式问题、不是 PRI 损坏**。上面的 `ReadAllText($p, $enc)` 靠 BOM 检测可正确读取。

> 改动源码时一律用 `edit` / `write` 工具，**绝不要** `Get-Content | Set-Content` 周转：PS 5.1 按 ANSI 读会把含中文的 UTF-8 源码整文件读成乱码，写回即造成"双重编码 + 引号丢失 + 换行丢失"的连锁语法错误——本项目已实际发生过一次（`winui3-impl-brief.md:108-114`）。
