# WinUI 3 重构 · C# 侧工程约定（冻结）

> **效力**：本文件与 `docs/design/winui3-visual-spec.md`（视觉规范）、`docs/design/winui3-bridge-protocol.md`（桥接协议）共同构成实现约束。
> **冲突裁决**：视觉规范 > 本文件 > 个人偏好。任何偏离须由 Lead 裁决后回写本文件。
> **为什么要有它**：本轮由多个实现者并行写 XAML/C#，若无统一命名与边界，必然出现同名类型、重复控件、样式漂移。

---

## 1. 目录与命名空间

```
desktop/
├── WhalesLauncher.sln
└── src/WhalesLauncher.App/
    ├── WhalesLauncher.App.csproj
    ├── app.manifest
    ├── App.xaml / App.xaml.cs                  ns: WhalesLauncher
    ├── MainWindow.xaml / MainWindow.xaml.cs    ns: WhalesLauncher
    ├── Models/                                 ns: WhalesLauncher.Models
    ├── Services/                               ns: WhalesLauncher.Services
    ├── Controls/                               ns: WhalesLauncher.Controls
    ├── Themes/                                 ns: WhalesLauncher.Themes（资源字典）
    ├── Shell/                                  ns: WhalesLauncher.Shell
    └── Views/                                  ns: WhalesLauncher.Views
        └── Detail/                             ns: WhalesLauncher.Views.Detail
```

**一个类型一个文件**，文件名 = 类型名。XAML 页面的 `.xaml` 与 `.xaml.cs` 同名。

## 2. 目标框架与构建

| 项 | 值 |
|---|---|
| TFM | `net10.0-windows10.0.26100.0` |
| TargetPlatformMinVersion | `10.0.17763.0` |
| RID | `win-x64` |
| Windows App SDK | `2.5.1`（已实测可还原可构建） |
| 打包 | `WindowsPackageType=None`（unpackaged，免 MSIX 签名/部署） |
| WinAppSDK 运行时 | `WindowsAppSDKSelfContained=true`（免安装运行时） |
| 语言 | `LangVersion=latest`、`Nullable=enable`、`ImplicitUsings=enable` |

## 3. Models（`WhalesLauncher.Models`）

**唯一来源**：`src/shared/contracts.ts`。C# 侧只是**镜像**，不得增删字段语义。

| 规则 | 说明 |
|---|---|
| 类型形态 | `public sealed class` + `{ get; set; }` 属性（便于 `System.Text.Json`） |
| 命名 | TS 接口名原样保留（`InstanceSummary`、`EngineInfo`…），字段 TS camelCase → C# PascalCase（靠全局 `JsonNamingPolicy.CamelCase` 自动映射） |
| 可选字段 | TS `x?: T` 与 `x: T \| null` 一律映射为 C# 可空 `T?` |
| 字符串联合类型 | TS `'a' \| 'b'` → C# **不要**用 `enum`（JSON 里是字符串，转换会引入失败面）；用 `string` + 同文件 `public static class XxxValues` 常量（如 `InstanceStateValues.Running = "running"`） |
| 判别联合 `Result<T>` | C# 侧用 `Services.BridgeResult<T>`（见 §4），**不**映射为 Model |
| 数值可空 | `number \| null` → `double?` / `int?`，按 TS 语义选 |

**禁止**：在 Models 里写业务逻辑、写 `JsonConverter`（除确有必要的例外，须注明理由）、改字段名。

## 4. Services（`WhalesLauncher.Services`）

| 类型 | 职责 | 负责人 |
|---|---|---|
| `CoreBridge` | Node 子进程生命周期、NDJSON 读写、请求配对、事件分发、`host:` 方法注册 | W-CORE |
| `BridgeResult<T>` | `{ bool Ok; T? Value; string? Error; }`，对应契约 `Result<T>` | W-CORE |
| `AppState` | 单一状态源（对应旧 `data/store.ts`），含实例列表、配置、引擎、当前主题；**去掉 toast 耦合**，改为事件 | Lead |
| `NavigationService` | 页面导航与参数传递（替代 hash 路由） | Lead |
| `Formatters` | 时间/体积/路径格式化（逐行移植旧 `util/format.ts`，**不用 Intl**，手写逻辑） | Lead |
| `ThemeService` | 三主题（Dark/Light/HighContrast）应用与持久化 | Lead |

**约定**：
- 所有后端调用**只经 `CoreBridge`**，UI 层不得直接 `Process.Start`。
- 视图**不持有** `CoreBridge` 引用；通过 `AppState` 与 `Services` 暴露的方法访问（保持视图可测、职责薄）。
- 事件（状态变更）用 `event EventHandler<T>` 或 `ObservableCollection` 通知，**不得**在 Service 里直接弹 UI。

## 5. 视图契约

每个页面是一个 `Page`（或 `UserControl`），类名与文件如下 —— **实现者不得改名**，导航按此路由：

| 路由键 | 类 | 文件 | 负责人 |
|---|---|---|---|
| `instances` | `InstancesPage` | `Views/InstancesPage.xaml` | W-P1 |
| `detail` | `InstanceDetailPage` | `Views/InstanceDetailPage.xaml` | W-P2 |
| `detail/plugins` | `PluginsView` | `Views/Detail/PluginsView.xaml` | W-P2 |
| `detail/settings` | `InstanceSettingsView` | `Views/Detail/InstanceSettingsView.xaml` | W-P2 |
| `detail/saves` | `SavesView` | `Views/Detail/SavesView.xaml` | W-P2 |
| `detail/logs` | `LogsView` | `Views/Detail/LogsView.xaml` | W-P2 |
| `engines` | `EnginesPage` | `Views/EnginesPage.xaml` | W-P6 |
| `create` | `WizardPage` | `Views/WizardPage.xaml` | W-P7 |
| `settings` | `SettingsPage` | `Views/SettingsPage.xaml` | W-P8 |

**导航参数**：`NavigationService.Navigate(string routeKey, object? parameter = null)`。`InstanceDetailPage` 的 parameter 是 `string instanceId` + `string tab`（用 `DetailNavArgs` record）。

**页面统一外壳**：每个页面根元素用规范 §9.0 的通用骨架（`Grid` + 标题区 + 内容区 + 状态区），由 `Controls/PageScaffold` 提供，避免每页各写一套边距。

## 6. 资源与样式（`Themes/`）

| 文件 | 内容 | 负责人 |
|---|---|---|
| `Tokens.xaml` | 仅**转引** WinUI 内置键（视觉规范 §1.3 白名单）；三主题各一份 | Lead |
| `PageStyles.xaml` | `PageScaffold` 等布局样式 | Lead |
| 各自控件样式 | 页面专属 `Style` 就写在页面的 `Page.Resources` 里 | 各页面 owner |

**铁律**（来自视觉规范 §1.3）：
- 颜色/字号/圆角一律 `{ThemeResource 内置键名}`，**禁止**自写 hex 与自定字号。
- 画刷必须用 `ThemeResource` 而非 `StaticResource`（否则换主题不刷新）。
- 自定义尺寸必须是 4 epx 整数倍。
- `[MUX_PREVIEW]` 预览控件禁用（如 `TableView`、`PagerControl`、`WrapPanel`）。

## 7. 共享控件（`Controls/`）

**先查后用**：动手写新控件前，先看 `Controls/` 是否已有。新增控件必须：
1. 在 `Controls/` 建独立文件，类名 `XxxYyy`；
2. 若属跨页面复用（≥2 个页面要用），归 `Controls/`；仅单页用则放该页 `Page.Resources` 或 `Views/Detail/` 内；
3. 在回复里登记「新增了哪个控件、给谁用」，Lead 会检查是否与他人重复造轮子。

**现有控件**（新增时请在此表登记，避免重复造轮子）：

| 控件 | 用途 | 谁用 |
|---|---|---|
| `Controls/PageHeader` | 页面统一的标题 + 描述 + 右侧操作区 | 全部页面 |
| `Controls/ToastHost` | 应用内轻提示的宿主（§9.10.2） | 外壳 |
| `Controls/PreflightReportView` | 展示环境自检报告（逐项状态走"色 + 图标 + 文字"三通道） | 首次启动的报告对话框（`Shell/PreflightPresenter`）与「全局设置 → 环境自检」分区 |

## 8. 代码风格

| 项 | 规定 |
|---|---|
| 可空性 | `Nullable=enable`，禁止滥用 `!`（Null-forgiving）；确需时写注释说明为何安全 |
| 异步 | UI 线程上的 IO 一律 `async`/`await`，**禁止** `.Result` / `.Wait()`（会死锁 UI 线程） |
| UI 更新 | 从非 UI 线程更新 UI 必须 `DispatcherQueue.TryEnqueue` |
| 事件解绑 | 页面 `OnNavigatedFrom` 时必须解绑事件与取消订阅，避免泄漏 |
| 注释 | 中文注释，解释**为什么**而非复述代码。与旧实现对应的逻辑，注明来源文件名+函数名 |
| 禁止 | `Console.WriteLine` 当日志（用 `Debug.WriteLine` 或 stderr 桥接）、硬编码 `F:\WhalesLauncher` 路径、`Thread.Sleep` |

## 9. 分层与依赖方向（只允许自上而下）

```
Views/Shell  →  Services  →  Models
     ↓             ↓
  Controls      CoreBridge  →  Node 子进程（dist/bridge/server.cjs）
```

**禁止反向依赖**：`Services` 不得 `using WhalesLauncher.Views`；`Models` 不得依赖任何其它层。

## 10. 写范围纪律

每个实现者只写自己被分配的目录/文件。**跨文件改动必须先在共享任务里声明并由 Lead 协调**：
- 改 `App.xaml`、`MainWindow.xaml`、`Themes/`、`Services/`、`Models/`、`Controls/`（共享层）→ 必须经 Lead
- 页面 owner 只写自己的 `Views/**.xaml(.cs)`

违反写范围会产生互相覆盖，最终由 Lead 复核 diff 兜底。
