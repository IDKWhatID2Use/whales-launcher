# WinUINav 质量审阅 与 WhalesLauncher 前端迁移可行性评估

- 审阅对象：<https://github.com/LingduSoftStudio/WinUINav>（branch `main`，审阅时 HEAD `86f4589`，pushed_at `2026-09-21T01:47:01Z`）
- 迁移来源：本机工作区 `F:\WhalesLauncher`（`package.json` name `whales-launcher`）
- 审阅日期：2026-09-21
- 证据口径：全部结论均可用「仓库路径 / 提交 SHA / 本机文件:行号」核对；无法核实的项显式标注「无法确认」

## 访问情况说明

| 站点 | 结果 |
|---|---|
| `github.com/LingduSoftStudio/WinUINav` | HTTP 200，可访问 |
| `api.github.com/repos/...`（Contents / Blobs / Commits / Trees API） | HTTP 200，可访问，**本次审阅的主证据来源** |
| `raw.githubusercontent.com/...` | `fetch failed`，本环境不可达 —— 故改用 Contents API 取 base64 后解码 |
| pwsh 直连网络 | 失败（`基础连接已经关闭`）—— 本环境网络只能走 web_fetch 通道 |

**未取到的项**：`Issue/PR/Discussions` 数量可由仓库元数据确认为 0（`open_issues_count: 0`，无 PR 记录），但**没有逐页翻取 issue 列表**；`CustomCaptionButtons.xaml.cs` 的**完整 32,631 字节原文未整篇解码**（仅解码了前约 40% 的字段/属性/生命周期区段与全文符号清单，见 §1.2）。这两项的缺口感已在对应小节标注。

---

# 第一部分　WinUINav 项目质量审阅

## 1.1 项目定位与成熟度

**评价：这是一个「WinUI 3 自定义标题栏」的技术验证/示例仓库，不是可复用的框架或模板，成熟度处于原型阶段。**

README 全文仅 1,725 字节（[README.md](https://github.com/LingduSoftStudio/WinUINav/blob/main/README.md)），自称：

> 「WinUINav 让你的程序更加统一。」

核心特性只列了两条：

1. **完全协调的控制按钮** —— 「WinUI 3 发布以来，一直都存在一个问题，那就是它的程序关闭按钮的颜色问题……WinUINav 完美解决了这个问题，我们自绘了一套按钮，将颜色统一为 UWP 的色号」
2. **精致的图层优化** —— 「懒得写了，你可以认为或想象这个模板不会有不跳脚的白边就对了。」

即：**卖点是「自绘窗口三按钮 + 去除白边」，且第 2 条自述为「懒得写了」**。

成熟度信号（均为可核对事实）：

| 信号 | 事实 | 来源 |
|---|---|---|
| 星标 / Fork / 关注 | `0 / 0 / 0` | 仓库元数据 |
| Issue | `open_issues_count: 0`（仓库创建至今） | 仓库元数据 |
| Release | 无（`/releases` 无记录，仓库亦无 tag 引用） | 仓库元数据 |
| 模板标记 | `is_template: false` —— GitHub 上**未**标记为模板仓库 | 仓库元数据 |
| 功能清单 | 无。README 无「功能」「Features」章节 | README.md |
| 版本 / CHANGELOG | 无 | 文件树（`git/trees/main?recursive=1`，共 90 项，无 CHANGELOG） |
| 许可 | MIT（见 §1.7） | `LICENSE` |

**可用于「借用」的实质资产只有 2 个控件/辅助类**（`Controls/CustomCaptionButtons.*`、`DwmBackdropHelper.cs`、`NativeWindowPaintHook.cs`），其余是演示页。

> 结论：把它当作「WinUI 3 窗口装饰（标题栏）参考实现」是合适的；当作「应用框架/导航框架」则名不副实 —— 见 §1.2、§1.8。

## 1.2 代码结构与可读性

**评价：单层扁平结构，无分层、无 MVVM、无 DI；`SettingsPage.xaml.cs` 内部存在三份近乎逐字重复的实现与死代码；标题栏控件约 900 行但逻辑并不复杂，且资源清理是完整的。**

### 规模（完整文件树，`git/trees/main?recursive=1`，`truncated: false`）

| 类型 | 数量 | 说明 |
|---|---|---|
| `.cs`（手写） | 9 | `App.xaml.cs`、`AppSettings.cs`、`MainWindow.xaml.cs`、`DwmBackdropHelper.cs`、`NativeWindowPaintHook.cs`、`Controls/CustomCaptionButtons.xaml.cs`、`Pages/*.xaml.cs` ×3 |
| `.xaml` | 6 | `App.xaml`、`MainWindow.xaml`、`Controls/CustomCaptionButtons.xaml`、`Pages/*.xaml` ×3 |
| Assets（PNG/ICO） | 61 | 文件树 89 blob 中 61 个在 `Assets/` —— **仓库主体文件数是图片，不是代码** |
| C# 总字节 | **80,687** | `/languages` 返回 `{"C#":80687}`，与 9 个 `.cs` 文件字节和**完全吻合** |
| **代码集中度** | **77%** | `MainWindow.xaml.cs`(30,076 B) + `CustomCaptionButtons.xaml.cs`(32,631 B) 两个文件 = 62,707 B ≈ 全仓 C# 的 77% |
| 仓库大小 | 114,655 KB ≈ **112 MB**（含历史） | 仓库元数据 `size`。而**当前文件树的全部 blob 不足 1 MB**（最大两项 `Assets/App.ico` 253,077 B、`preview/assets/image.png` 155,521 B）——**差额全在 git 历史中** |

全部代码文件位于**仓库根目录 + 3 个子目录**（`Controls/`、`Pages/`、`Properties/`），没有 `Models/`、`ViewModels/`、`Services/`、`Interop/` 之类的分层痕迹。

**interop 类型被塞进 App 类**：`App.xaml.cs` 内嵌 3 个 `public` 嵌套类型 `App.HWND` / `App.User32` / `App.DwmApi`，注释直认是被编译器逼出来的：

```csharp
// 1. 解决未能找到 "HWND" 的报错
// 2. 解决不存在 "User32" 的报错
// 3. 解决不存在 "DwmApi" 的报错
```

同一套 DWM 枚举（`MARGINS` / `DWMWINDOWATTRIBUTE`）在 `App.xaml.cs` 与 `DwmBackdropHelper.cs` 中**各定义了一份**，数值相同。

### MainWindow 是标准 WinUI 3 导航壳

[MainWindow.xaml](https://github.com/LingduSoftStudio/WinUINav/blob/main/MainWindow.xaml) 全文 3,510 字节：

- `NavigationView x:Name="RootNavView"`，`IsBackButtonVisible="Visible"`、`IsTitleBarAutoPaddingEnabled="False"`、`PaneDisplayMode="Auto"`
- `NavigationView.MenuItems` **硬编码在 XAML**，只有两项：`Content="首页" Tag="home"`、`Content="关于" Tag="about"`
- 内容区：`<Frame x:Name="ContentFrame" Navigated="ContentFrame_Navigated"/>`
- 覆盖式标题栏：`<Grid x:Name="AppTitleBar" Canvas.ZIndex="1" Height="{Binding ElementName=RootNavView, Path=CompactPaneLength}" IsHitTestVisible="True" RightTapped="AppTitleBar_RightTapped">`，内含 `BitLogo.png` + `TitleText` + `<controls:CustomCaptionButtons x:Name="CaptionButtons" HorizontalAlignment="Right" VerticalAlignment="Stretch"/>`
- 5 个 `NavigationViewContent*` 主题资源被就地重定义（`Thickness`/`CornerRadius`）

### [MainWindow.xaml.cs](https://github.com/LingduSoftStudio/WinUINav/blob/main/MainWindow.xaml.cs)（30,076 字节）的职责混杂

单个文件混杂 **6 类职责**：窗口生命周期、原生子类化（自建 `SUBCLASSPROC` + `SetWindowSubclass`/`DefSubclassProc`，处理 `WM_GETMINMAXINFO`/`WM_NCRBUTTONUP`/`WM_SYSCOMMAND`）、自绘系统菜单（6 个 `MenuFlyoutItem`）、设置持久化与主题材质、导航路由、标题栏布局数学。**无 ViewModel、无 `DataContext`、无 `INotifyPropertyChanged`**（全文件唯一的绑定是 XAML 内的元素间绑定 `Height="{Binding ElementName=RootNavView, Path=CompactPaneLength}"`）。

**10 处死代码**（私有成员无任何调用点，且 XAML 无对应事件绑定）：

`FindElementByName<T>`、`InitWindowSizeAndCenter()`、`InitTitleBar()`、`LoadAndApplyTheme()`、`AppTitleBar_BackRequested`、`AppTitleBar_PaneToggleRequested`、`MainSearchBox_QuerySubmitted`（**XAML 中根本没有 `MainSearchBox` 这个控件**）、`ApplySavedNavMode`、常量 `BackdropSettingKey`、常量 `ThemeDefault/ThemeLight/ThemeDark`。

其中 `LoadAndApplyTheme()` 暴露了**双持久化方案并存**：

```csharp
// 【修改点】因为现在是免安装(Unpackaged)应用，不能再使用 ApplicationData.Current
string settingsFile = Path.Combine(appFolder, "theme_setting.txt");
```

而 `AppSettings` 用的是 `settings.json` —— 同目录、同语义、两种格式。且该注释与 csproj 的 `<WindowsPackageType>MSIX</WindowsPackageType>` **直接矛盾**，属打包方式反复切换后的残骸。

**重复执行与冗余 I/O**：构造函数与 `MainWindow_Activated` 各跑一遍 `EnsureAppWindow() + CenterWindow(1200,800) + CaptionButtons.Attach()`；`ApplySavedSettings()` 触发 3 次 `AppSettings.Load()`，每次重读磁盘 + 反序列化。硬编码魔数：`CenterWindow(1200, 800)`、`minWidth=800/minHeight=600`、菜单偏移 `8`。

**浮夸注释**（与 README 的「乔布斯审核标准」形成对照）：

```csharp
// 【终极必杀技】
// 直接将系统按钮的物理高度折叠为 0。
// 这不仅仅是变透明，而是彻底把系统按钮连根拔起！
titleBar.PreferredHeightOption = TitleBarHeightOption.Collapsed;
```

### [SettingsPage.xaml.cs](https://github.com/LingduSoftStudio/WinUINav/blob/main/Pages/SettingsPage.xaml.cs) 的质量问题（4,638 字节，全文已解码）

这是本次审阅中**最明确的低质量证据**：

1. **三份近乎逐字重复的实现**：`BackdropModeComboBox_Loaded`、`ThemeComboBox_Loaded`、`NavModeComboBox_Loaded` 三者的结构完全一致（置 ready=false → `AppSettings.Load().X` → `foreach` 匹配 `ComboBoxItem.Tag` → 找不到则设默认 → 置 ready=true）。`ThemeComboBox_SelectionChanged` 与 `NavModeComboBox_SelectionChanged` 亦重复。
2. **死代码**：文件底部定义了泛型 `private static T? FindParent<T>(DependencyObject child) where T : DependencyObject`，在**本文件内无任何调用点**（该文件是唯一出现 `FindParent` 的位置）。
3. **用「ready 标志位」防御性屏蔽初始化期间的 SelectionChanged**，说明作者知道事件时序问题但选择打补丁而非用绑定。
4. **跨层直取全局单例**：`if (App.MainWindowInstance is MainWindow mainWindow) mainWindow.ApplyTheme(theme, save: true);` —— 页面直接操作窗口全局实例，没有服务层。

### [CustomCaptionButtons.xaml.cs](https://github.com/LingduSoftStudio/WinUINav/blob/main/Controls/CustomCaptionButtons.xaml.cs)（32,631 字节）—— 全仓库质量最高的文件

**这是该仓库唯一具备真实技术价值的资产，值得单独评价。**

优点（实测）：

- **7 个 `DependencyProperty`** 构成可注入的配色契约：`ButtonForegroundColor` / `ButtonBackgroundColor` / `ButtonHoverForegroundColor` / `ButtonHoverBackgroundColor` / `ButtonPressedForegroundColor` / `ButtonPressedBackgroundColor` / `ButtonDisabledForegroundColor`（默认值用 `ColorHelper.FromArgb` 字面量）
- **色号抄对了**：`CloseHoverBackgroundColor = #C42B1C`、`ClosePressedBackgroundColor = #C73C31` —— 与 Windows 11 原生关闭按钮的 hover/pressed 色一致，这正是它宣称要修的问题
- **完整指针状态机**：`VisualStateKind{Normal,Hover,Pressed}` × `ClientButtonKind{Minimize,Close}`，且对 `PointerCaptureLost` / `PointerCanceled` 都有兜底（这是多数同类自绘控件漏掉的边界）
- **`IDisposable` 实现无泄漏**：`Dispose()` 内逐项 `-=` 退订 4 个 `SizeChanged`、`_window.Activated`、6 个 `_nonClientPointerSource` 事件、`AppWindow.Changed`，并 `RemoveWindowSubclass`
- **P/Invoke 签名正确**：`nuint uIdSubclass` + `ExactSpelling = true`（质量明显高于 `App.xaml.cs` 里的 interop）
- **全仓库唯一一处 `throw`**：`throw new InvalidOperationException("SetWindowSubclass failed.")`

**Snap Layouts 的实现方式（本仓库最值得借鉴的一处）**：

```csharp
_nonClientPointerSource = InputNonClientPointerSource.GetForWindowId(windowId);
...
_nonClientPointerSource.SetRegionRects(NonClientRegionKind.Passthrough, passthroughRects.ToArray());
...
_nonClientPointerSource.SetRegionRects(NonClientRegionKind.Maximize, new[] { maxRect });
```

即：**最小化 / 关闭**声明为 `Passthrough` 交给 XAML 客户端自绘；**最大化**声明为真正的 `NonClientRegionKind.Maximize`，让系统原生提供 Snap Layouts 悬浮面板。README 里「**基本**支持 Snap Layout」的「基本」二字，正对应「只有最大化按钮具备 Snap 能力」——**这是作者少数如实描述的地方**。

**自定义标题栏五要素核查**：

| 要素 | 结论 | 依据 |
|---|---|---|
| WCO 自定义 | ✅ | 代码中校验了窗口标题栏自定义能力并配合 `TitleBarHeightOption.Collapsed`（注：搜索结果中未找到名为 `IsCustomizationSupported()` 的公开 API 文档条目，**该 API 名无法独立确认**，以仓库代码为准） |
| AppWindow / Presenter | ✅ | `OverlappedPresenter.SetBorderAndTitleBar(true, false)` |
| `WM_NCHITTEST` | ❌ **全仓库未使用** | 无 `WM_NCHITTEST` / `0x0084` 命中；作者改用 `InputNonClientPointerSource.SetRegionRects` 的现代 region API —— **这是加分项**，比社区常见的裸 hit-test 方案更稳 |
| Snap Layouts | ✅（仅最大化按钮） | `NonClientRegionKind.Maximize` + README 自述「基本支持」 |
| DPI | ⚠️ **仅部分** | `XamlRoot.RasterizationScale` 换算 DIP→物理像素、manifest 声明 `PerMonitorV2`；但**无 `WM_DPICHANGED` 处理**，跨显示器拖动时 region rect 存在错位风险 |

**已知缺陷（引入前必须处理）**：

- 尺寸硬编码 `Width="138" Height="48"`、`MinWidth="138"`、3×`ColumnDefinition Width="46"`（Win11 原生按钮为 46×32，48 高度的标题栏与原生手感有差异）
- 字形用私有区码点 `"\uE921"`（最小化）/ `"\uE922"`（最大化）/ `"\uE8BB"`（关闭）
- 只处理单一 `RasterizationScale`，无逐显示器 DPI 感知
- **`MainWindow` 与 `CustomCaptionButtons` 各自做窗口子类化，且 `uIdSubclass` 都取值 `1`** —— 两个子类化过程共用同一 ID，存在互相干扰风险
- 无障碍缺失：三个按钮均无 `AutomationProperties.Name`

## 1.3 依赖与构建方式

**评价：现代但偏新的技术栈（.NET 8 + Windows App SDK 1.8 + WebView2 + MSIX 单项目）；csproj 有确切的手工编辑损伤痕迹；仓库中提交了 IDE 用户级文件。**

[WinUINav.csproj](https://github.com/LingduSoftStudio/WinUINav/blob/main/WinUINav.csproj)（4,047 字节，全文已解码）：

```xml
<OutputType>WinExe</OutputType>
<TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>
<TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
<PublishAot>false</PublishAot>
<Platforms>x86;x64;ARM64</Platforms>
<RuntimeIdentifiers>win-x86;win-x64;win-arm64</RuntimeIdentifiers>
<PublishProfile>win-$(Platform).pubxml</PublishProfile>
<UseWinUI>true</UseWinUI>
<WinUISDKReferences>false</WinUISDKReferences>
<EnableMsixTooling>true</EnableMsixTooling>
<Nullable>enable</Nullable>
<WindowsPackageType>MSIX</WindowsPackageType>
<WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained>
```

NuGet 依赖（**仅 3 个，均为微软官方包**）：

| 包 | 版本 | 备注 |
|---|---|---|
| `Microsoft.Web.WebView2` | 1.0.3912.50 | ⚠️ **全仓库零使用** —— 9 个 `.cs` 文件中无任何 WebView 标识符，属无谓依赖 |
| `Microsoft.Windows.SDK.BuildTools` | 10.0.28000.1721 | — |
| `Microsoft.WindowsAppSDK` | 1.8.260317003 | — |

其余工程属性：`AllowUnsafeBlocks=true`、`DefaultLanguage=zh-CN`、`PublishTrimmed=false`；**`ImplicitUsings` 未声明（默认关闭）**—— 证据是 `App.xaml.cs` 手写了 18 个 `using`。

**无 CommunityToolkit、无 MVVM 库、无 DI 容器**：不存在 `CommunityToolkit.Mvvm`、`Microsoft.Extensions.DependencyInjection`、`Microsoft.Extensions.Hosting`、Prism、ReactiveUI 的任何引用。

发布配置（`Properties/PublishProfiles/win-x64.pubxml`，全文已解码）：`PublishProtocol=FileSystem`、`SelfContained=true`、`PublishSingleFile=False`；`AppxPackageSigningEnabled=False`、`GenerateAppInstallerFile=False`、`GenerateTestArtifacts=True`、`AppxBundlePlatforms=x64`、`HoursBetweenUpdateChecks=0`。

> 注：`HoursBetweenUpdateChecks=0` 意味着**每次启动都检查更新**（MSIX 语义），通常是模板默认值未调整的残留。
>
> `GenerateTestArtifacts=True` **是 MSIX 打包属性，与单元测试无关**（易误判为"有测试"，见 §1.5）。
>
> **无法产出可安装的签名 MSIX**：`Package.appxmanifest` 的 `Publisher="CN=Administrator"` 与 `<PublisherDisplayName>Administrator</PublisherDisplayName>` 是**模板默认值从未替换**，配合 `<AppxPackageSigningEnabled>False</AppxPackageSigningEnabled>`，下游必须自行改 Publisher 并配证书才能打包安装。
>
> `launchSettings.json` 提供 `WinUINav (Package)` / `WinUINav (Unpackaged)` 双 profile，说明打包方式反复切换过（见 §1.2 的双持久化矛盾）。
>
> `WinUISDKReferences=false` 是真实存在的属性（经 Blobs API 二次核对 SHA `36511099537403e658be51ca38b3aacc13e0ae0c` 确认，非抄录失真）。因 csproj 中无任何 `FrameworkReference`，Windows App SDK 的实际引用来自 NuGet 包，XAML 编译链仍然成立。

**手工编辑损伤（可逐字核对）**：

```
Line 13:  <WindowsAppSDKReferences>false</WindowsAppSDKReferences>   ← 属性名错误（非合法 MSBuild 属性）
Line 16:  >EnableMsixTooling>true</EnableMsixTooling>                ← 行首多一个 '>'，缩进由 Tab 变成空
```

这两处只能来自人手编辑，且第 16 行的 `>` 说明有属性原本应写在这里但被误删。**该文件是手工维护的、未被构建验证过的状态**（因为多余字符在 MSBuild 里是无害垃圾，不会报错）。

**仓库卫生问题**：`WinUINav.csproj.user`（665 字节）被提交进版本库。这按约定是 IDE 用户级文件，通常应进 `.gitignore`（而仓库 `.gitignore` 仅 46 字节，明显是模板最小集）。`.csproj.user` 常包含本机调试路径/启动配置，属于个人信息泄漏面。

**构建方式**：`dotnet build` / Visual Studio 打开 `WinUINav.slnx`（359 字节）。README 要求「Visual Studio 2026」—— 这是一个**处于预览/未来态**的 IDE 版本要求，实质上把可构建门槛抬高了。

## 1.4 文档完整度

**评价：极低。README 1.7KB，且克隆地址指向了错误（旧）组织名。无 API 文档、无贡献指南、无变更日志。**

| 文档项 | 状态 | 证据 |
|---|---|---|
| README | 1,725 字节 | `README.md` size 字段 |
| 目录结构说明 | 无 | README 无此章节 |
| 构建/运行说明 | 仅「打开 slnx 文件」 | README「使用方式」只有 2 步 |
| API 文档 | 无 | — |
| 截图 | 有 1 张预览图 | `preview/assets/image.png`（155,521 字节），README 以 `![Main Preview](./preview/assets/image.png)` 引用 |
| 贡献指南 / CHANGELOG | 无 | 文件树无 `CONTRIBUTING.md` / `CHANGELOG.md` |
| 许可说明 | 有（badge + `LICENSE`） | README 顶部 badge 表格 |

**确切的文档缺陷**：README 的「使用方式」第 1 步写的是

```bash
git clone https://github.com/BitCloudStudio/WinUINav.git
```

而仓库实际位于 `LingduSoftStudio/WinUINav`（旧组织名 `BitCloudStudio` 已改名）。**照抄 README 的命令会 404** —— 这是文档与仓库状态脱节的可验证证据，也印证了维护不活跃（§1.6）。

## 1.5 测试与 CI

**评价：零。没有测试项目、没有 CI、没有静态分析配置。**

| 项 | 状态 | 证据 |
|---|---|---|
| 测试项目 | 无。完整文件树中没有 `*Test*.csproj` / `*Tests*` 目录 / `xunit` / `MSTest` / `NUnit` 引用；`WinUINav.slnx` 只含**一个** `<Project Path="WinUINav.csproj">` | `git/trees/main?recursive=1`（89 blob + 6 tree） |
| CI | 无。`/contents/.github/workflows` → **HTTP 404**，完整树中不存在 `.github/` 目录 | Contents API |
| 分析器 / 代码规则 | 无 `.editorconfig`、无 `Directory.Build.props`/`.targets`、无 `TreatWarningsAsErrors`、无 `AnalysisLevel` | 文件树 + csproj 全文 |
| TODO/FIXME/HACK 标记 | **全仓库 0 个** —— 这反而是负面信号：所有已知问题都没有被记录，维护者只能通读 30KB 文件 | 全仓 grep |
| 手动验证记录 | README 无「测试」「验证」章节 | README.md |

**这是本次审阅中最硬的减分项**：一个以「修复 WinUI 3 关闭按钮颜色/白边」为唯一卖点的仓库，其卖点恰恰是**必须跨 DPI、跨主题、跨窗口状态（普通/最大化/全屏/Snap）实测才能验证**的视觉行为，而仓库里**没有任何自动化或人工验证记录**。所有质量主张都只能靠使用者自己复现。

**直接的因果链**：无分析器规则 + 无 CI ⇒ 10 处死代码（§1.2）能长期存活；无测试 ⇒ `NativeWindowPaintHook` 的 `WM_PAINT` 黑底 hack（§1.2 末）能长期留在主分支。

## 1.6 维护活跃度

**评价：仓库存在 168 天，提交 31 次；87% 的提交信息不含任何变更意图；单账号三名身份；04-13 一天内 42 分钟提交 21 次，随后 5 个月完全停滞。**

**提交总数 = 31**（三重验证：`/contributors` 唯一贡献者 `contributions:31`；`/commits?per_page=1&page=32` 返回 `[]`；去重合并两次抓取恰得 31 条）。

**时间线**：

| 日期 (UTC) | 提交数 | 说明 |
|---|---|---|
| 2026-04-06 | 2 | `Initial commit`（SHA `5364cfbe…`，`parents:[]` 确认为根提交） |
| 2026-04-07 | 1 | — |
| **2026-04-13** | **21** | 集中在 `01:57–02:39Z` 约 **42 分钟内**，其中 **12 次是 `Update README.md`** |
| 2026-04-23 | 5 | `Code Refactoring` / `delete some files` / `Create LICENSE` / `Add MIT License` 等 |
| 2026-04-23 → 2026-09-20 | **0** | **约 5 个月完全停滞** |
| 2026-09-20 | 1 | `new`（SHA `466b178`） |
| 2026-09-21 | 1 | `Update MainWindow.xaml.cs`（HEAD `86f4589`） |

**提交信息质量：27/31（约 87%）无任何变更意图**

- `Update README.md` 字面重复 **12 次**
- 单词小写 6 条：`new` / `preview` / `readme` / `winui` / `WinUI` / `WinUINav`
- subject 与 body 全同的 3 条（如 `20260413\n\n20260413`）
- Merge 2 条
- 略有信息量的仅 4 条
- **`d5f94b3`（"delete some files"）的 tree SHA 是 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`** —— Git 的**空树对象哈希**，即该提交把仓库内容清空过；`e8cff8a`（"winui"）的 tree 亦为空树。**「重构」实为「先删光再放回」，导致这些提交无法作为可审阅的 diff**，也解释了仓库 112 MB 体积的来源（§1.2）

**单账号多身份（不是多作者协作）**：作者名出现 `LiZLL` / `BitCloud` / `LingduStudio` 三个，但 email 全部指向同一 GitHub id `138379231`（`138379231+BitCloudStudio@…` → `138379231+LingduSoftStudio@…`），`/contributors` 也只返回 1 人。

分支/标签/发布：`/branches` 仅 `main`（未保护）、`/tags` = `[]`、`/releases` = `[]`、`/issues?state=all` = `[]`、`/pulls?state=all` = `[]`；`0` star / `0` fork / `0` discussion / `topics:[]` / `description:"WinUINav"`（仅项目名）/ `homepage:null`。

> **结论**：无法从 git 历史追溯任何设计决策 —— 这对「把它当作可依赖的上游」是致命的，因为任何回归都无从定位。

## 1.7 License 与合规性

**评价：干净。标准 MIT，允许商用与修改，义务明确。**

[LICENSE](https://github.com/LingduSoftStudio/WinUINav/blob/main/LICENSE)（1,065 字节，全文已解码）：

```
MIT License

Copyright (c) 2026 BitCloud
```

- 仓库元数据亦确认：`license: { key: "mit", spdx_id: "MIT" }`
- **MIT 允许**：商业使用、修改、分发、再许可、私有使用；**义务**：在所有副本或实质部分保留版权声明与许可声明（即引入后需在衍生项目的许可/致谢中标注 `Copyright (c) 2026 BitCloud` + MIT 全文）。
- 无 copyleft 传染性，**与 WhalesLauncher 的 Polyform Noncommercial 1.0.0 不冲突**（可把 MIT 代码并入受限许可的项目；反向则不行，但本场景是前者）。
- 依赖许可：3 个 NuGet 包全部为微软官方（MIT / BSD-3-Clause 性质），无 GPL/AGPL 风险；但仓库**无 `THIRD-PARTY-NOTICES`**。
- **⚠️ 版权主体无法确定**：同一项目出现 **5 个不同署名** ——

  | 出现位置 | 名称 |
  |---|---|
  | `LICENSE` 版权行 | `BitCloud` |
  | 仓库 owner | `LingduSoftStudio` |
  | 早期提交作者 | `LiZLL` |
  | `AboutPage.xaml` 开发者卡片 | `BitChen` |
  | README 克隆地址 / 跳转链接 | `BitCloudStudio`（旧组织名） |

  下游要合规地保留「版权声明」时，**无法确定该写哪一个**。这不影响 MIT 的可用性（任一名称都不改变授权），但会影响 NOTICE 的准确性。
- 品牌资产：`Assets/BitLogo.png`、`Assets/App.ico`、`Assets/StoreLogo.png` 等为 BitCloud 的品牌图；`MainWindow.xaml` 的 `Title="WinUINav"`、标题栏 `Text="WinUINav"`、`Image Source="/Assets/BitLogo.png"` 均为硬编码。**引入时必须替换**，否则会把 BitCloud 的品牌带进 WhalesLauncher。
- **仓库卫生 4 类问题**：
  1. **`WinUINav.csproj.user`（665 字节）被提交进仓库** —— 根因已定位：`.gitignore` 仅 **46 字节 / 5 行**（`.vs/`、`bin/`、`obj/`、`AppPackages/`、`BundleArtifacts/`），**缺 `*.csproj.user`**。该文件含 `<ActiveDebugProfile>WinUINav (Package)</ActiveDebugProfile>`、`DebuggerFlavor`、`Designer` SubType —— 属每用户本地状态，克隆者会继承原作者的调试配置
  2. `Assets/StoreLogo.backup.png` 与 `StoreLogo.png` 的 **SHA 完全相同**（`a4586f26…`，456 字节），纯冗余副本
  3. `Microsoft.Web.WebView2` 无谓依赖（§1.3）+ 4 条冗余 `None Remove` / 独立 `Page Update` MSBuild 项
  4. **未发现任何密钥/证书**（无 pfx / snk / .env / 连接串）—— **这一项是干净的**

## 1.8 可扩展性

**评价：可扩展性很差。没有 MVVM、没有 DI、没有导航服务、没有参数传递机制；新增一个页面的成本是「手改 XAML + 手改 code-behind」，且不可避免会复制现有页面的重复模式。**

| 扩展动作 | 现状 | 依据 |
|---|---|---|
| 新增一个页面 | 需 (a) 新建 `Pages/X.xaml(.cs)`；(b) 在 `MainWindow.xaml` 的 `NavigationView.MenuItems` **手写** `NavigationViewItem`；(c) 在 `MainWindow.xaml.cs` 的 `SelectionChanged` 里加分支。**漏改任一处即出现「点菜单没反应」或「导航后菜单不选中」** | MainWindow.xaml（菜单硬编码） |
| 第三份映射残留 | 同样的 tag→page 映射还残留在死代码 `MainSearchBox_QuerySubmitted` 里 | MainWindow.xaml.cs |
| 菜单是否数据驱动 | **否**。无 `IEnumerable<NavItem>` 绑定、无 `MenuItemsSource` | MainWindow.xaml |
| 导航服务 / 路由注册表 | **无**。只有 `ContentFrame.Navigate(...)`，无 `Dictionary<string,Type>` | MainWindow.xaml（`Frame x:Name="ContentFrame"`） |
| 页面间传参 | **完全不存在**。全仓无一处使用 `Navigate` 的带 parameter 重载，页面也未实现 `OnNavigatedTo` | 全仓无相关符号 |
| ViewModel 层 | **无**。所有页面逻辑在 code-behind | `Pages/*.xaml.cs` |
| 依赖注入 | **无**。`App.xaml.cs` 全文无 `ServiceProvider` / `Host` / `IServiceCollection`；`OnLaunched` 全部有效逻辑仅 3 行 | [App.xaml.cs](https://github.com/LingduSoftStudio/WinUINav/blob/main/App.xaml.cs) |
| 全局状态传递 | **静态全局单例** `public static MainWindow? MainWindowInstance`，页面反向依赖具体窗口类型 | `Pages/SettingsPage.xaml.cs`（3 处同写法） |
| 设置持久化 | `AppSettings.Load()` / `Save()` 静态调用（`AppSettings.cs` 1,386 字节） | SettingsPage.xaml.cs 中 `AppSettings.Load().BackdropMode` 等 |
| 设置项类型安全 | **无**。`AppSettingsModel` 用裸 `string`，合法值只写在注释里；`ApplyBackdrop` 的 `switch` default 静默兜底并回写 `mode = "MicaAlt"` 覆盖入参 | `AppSettings.cs` / `MainWindow.xaml.cs` |
| 主题/背景切换 | `MainWindow.ApplyTheme(mode, save: true)` / `ApplyBackdrop(mode, save: true)` / `ApplyNavMode(mode, save: true)` —— 由页面直接调用窗口方法 | SettingsPage.xaml.cs |

**可复用的最小单元**：

- `Controls/CustomCaptionButtons.xaml(.cs)` —— 公开 API 设计合理（`Attach(window, titleBarHost)` + `RefreshForTheme(theme)` + `Dispose()`），**可以被搬到另一个 WinUI 3 工程**，代价是连同 `InputNonClientPointerSource` / `AppWindow` 的假设一起搬（要求宿主窗口用 `OverlappedPresenter` 且不走系统 WCO）。硬编码的 138/48/46 与 `\uE921..E8BB` 字形需要按新设计调整。
- `DwmBackdropHelper.cs`（2,406 字节）+ `App.xaml.cs` 内嵌的 `DwmApi`/`User32` interop —— 处理 Mica/Acrylic 与 `WS_EX_NOREDIRECTIONBITMAP`，可搬。
- `Pages/*`、`MainWindow.xaml(.cs)` —— **强耦合于演示场景**，无可搬价值（`HomePage.xaml` 仅 542 字节）。

---

> **小节顺序说明**：§1.8 是任务书要求的第 8 个维度；§1.9 / §1.10 是跨维度的风险与复用性汇总，因此编号排在维度之后。

## 1.9 成熟度与风险信号（正面与高危并列）

前 8 节按维度拆解，这一节把跨维度的风险信号集中呈现，因为它们**不落在任何单一维度上**。

### 真实优点（不夸大）

| 优点 | 证据 |
|---|---|
| 依赖面极窄 | 3 个 NuGet 包，全为微软官方 |
| 技术选型现代且正确 | 用 `InputNonClientPointerSource.SetRegionRects` 取代社区常见的裸 `WM_NCHITTEST`；用 `TitleBarHeightOption.Collapsed` 取代透明 hack |
| 标题栏控件质量达标 | 完整指针状态机 + `Dispose()` 无泄漏 + 正确 `nuint`/`ExactSpelling` P/Invoke 签名（§1.2） |
| 色号准确 | `#C42B1C` / `#C73C31` 与 Win11 原生一致 |
| 无密钥泄漏 | 全仓无 pfx / snk / .env / 连接串 |

### 🔴 高危

**H1 —— `NativeWindowPaintHook.cs` 在 `WM_PAINT` 里用 GDI 纯黑刷子铺满客户区**

```csharp
case WM_ERASEBKGND: return new IntPtr(1);          // 拦截背景擦除，阻止系统刷默认白底
case WM_PAINT:
    IntPtr hdc = BeginPaint(hWnd, out ps);
    GetClientRect(hWnd, out RECT rcClient);
    IntPtr hBrush = CreateSolidBrush(MakeRgb(0, 0, 0));
    FillRect(hdc, ref rcClient, hBrush);
    DeleteObject(hBrush);
    EndPaint(hWnd, ref ps);
    return IntPtr.Zero;                             // 表示我们已经处理完绘制
```

这是**全仓库最危险的代码**：它吞掉整个 `WM_PAINT`，等于替 WinUI 3 合成器决定客户区外观（硬编码纯黑）。在 Mica/Acrylic 与深浅主题切换下与 DWM 背景的叠加行为**不可控**。窗口 `Activated` 即挂载，**无开关、无回退**。

> 这很可能就是 README 那句「**极致的图层优化**」/「**懒得写了**」的真身 —— 即该仓库两大卖点之一，其实现是一个 GDI 黑底填充 hack。

**H2 —— 异常处理形同虚设**

- 全仓库 **4 个 `try`，其中 3 个是空 `catch {}`**（`DwmBackdropHelper.Apply`、`AppSettings.Load`、`MainWindow.SetWindowIcon` —— 后者注释写「先别抛异常」）
- **`AppSettings.Save` 完全没有 `try/catch`** —— 读写不对称，`%LocalAppData%` 不可写即崩溃
- **`App` 类没有 `UnhandledException` 处理器**
- 空 `catch {}` 还会吞掉 `SEHException` 级别的原生错误（在含 P/Invoke 的工程里尤其危险）

**H3 —— 零测试零 CI（§1.5）**，与 H1/H2 构成因果：没有 CI 就没有任何东西能拦住「在 `WM_PAINT` 里刷黑底」和「10 处死代码」进入主分支。

### 🟠 中危

| 信号 | 说明 |
|---|---|
| 窗口子类化 ID 冲突 | `MainWindow` 与 `CustomCaptionButtons` **各自做窗口子类化，`uIdSubclass` 都取值 `1`** |
| 双持久化并存 | `settings.json`（`AppSettings`）与 `theme_setting.txt`（死代码 `LoadAndApplyTheme`） |
| interop 签名不一致 | `App.DwmApi.DwmSetWindowAttribute` 把 `LPCVOID` 写成 `nint`，与 `DwmBackdropHelper` 的 `ref int` 版本不一致；自定义 `public struct HWND` 与 CsWin32 / `Windows.Win32` 存在类型冲突风险 |
| 设置项类型不安全 | `AppSettingsModel` 用裸 `string`，合法值只写在注释里；`ApplyBackdrop` 的 `switch` default 甚至**回写 `mode = "MicaAlt"` 覆盖入参** |
| DPI 只做了一半 | 有 `RasterizationScale` 换算 + `PerMonitorV2` manifest，但**无 `WM_DPICHANGED` 处理** |

### 🟡 低危 / 卫生

- 10 处死代码 + `SettingsPage._isInitializing` 声明后从未赋值 + `App._window` 死字段
- 硬编码魔数：`CenterWindow(1200, 800)`、`minWidth=800/minHeight=600`、菜单偏移 `8`、按钮 `138/48/46`
- **全仓库 0 个 TODO/FIXME/HACK** —— 反而是负面信号（§1.5）
- **无障碍缺失**：`TitleText.Foreground` 硬编码 White/Black 不走 `ThemeResource`、不响应高对比度；三个自绘按钮无 `AutomationProperties.Name`
- 仓库 112 MB vs 当前代码不足 1 MB（§1.2），差额在历史中的两次整仓清空

### 总评

> **这是一个个人实验性工程，不是可依赖的开源上游。** 它的技术价值高度集中于**一个文件**（`CustomCaptionButtons.xaml.cs`）与**一个技术点**（WinUI 3 自绘三按钮 + region API 保留 Snap Layouts）。README 的「乔布斯审核标准 / 终极 / 完美」与 10 处死代码、3 个空 `catch`、未替换的 `CN=Administrator`、未闭合的 README 代码块、`WM_PAINT` 刷黑底形成显著反差。

## 1.10 最容易复用的部分

| 可搬运性 | 文件 | 说明 |
|---|---|---|
| **可直接搬**（低耦合、质量达标） | `Controls/CustomCaptionButtons.xaml(.cs)` | 对外仅 `Attach(Window, FrameworkElement)`、`RefreshForTheme(ElementTheme)`、`Dispose()` + 7 个配色 DP + 3 个 `IsCustom*ButtonEnabled`。**唯一必改的是硬编码尺寸** `138/48/46`（Win11 原生为 46×32） |
| **可直接搬** | `DwmBackdropHelper.cs` | 单一静态入口 `Apply(Window, string, bool)`，无业务依赖。需自行修掉空 `catch {}`；DWM 枚举若与本地 interop 重叠则删本地定义 |
| **可直接搬** | `Properties/PublishProfiles/*.pubxml` | 标准 FileSystem + SelfContained，改 Platform/RID 即用 |
| **可直接搬** | `app.manifest` | `asInvoker` + `PerMonitorV2`，WinUI 3 桌面正确基线（建议补 `longPathAware`） |
| **仅作参考** | `NativeWindowPaintHook.cs` | 子类化骨架（委托防 GC、`IntPtr.Size` 分支选 `SetWindowLongPtr64/32`）是好模板，但 `WM_PAINT` 黑底填充**不可照搬** |
| **必须重写**（强耦合） | `MainWindow.xaml.cs` | 拆成 Interop / ThemeService / BackdropService / NavigationService + 导航路由表 |
| **必须重写** | `App.xaml.cs` | interop 移出 → 独立 `Interop/` 命名空间；引入 `IServiceProvider`；补全局异常处理 |
| **必须重写** | `AppSettings.cs` | 改 enum + 接口 + 读写对称兜底 |
| **必须重写** | `Pages/SettingsPage.xaml.cs` | 去掉 `App.MainWindowInstance is MainWindow` 反向依赖 |
| **必须重写** | `MainWindow.xaml` | MenuItems 改数据驱动 |
| **无价值** | `HomePage.*` / `AboutPage.xaml.cs` | **仍是未修改的模板文件**（XML 注释还写着 "An empty page that can be used on its own or navigated to within a Frame."） |
| **⚠️ 重写而非复制** | `.gitignore` | 原仓库正因缺 `*.csproj.user` 而踩坑（§1.7） |

**搬运时必须一并复制的宿主逻辑**（摘自 `MainWindow` 构造函数）：

```csharp
this.ExtendsContentIntoTitleBar = true;
EnsureAppWindow();
if (_appWindow?.Presenter is OverlappedPresenter presenter)
    presenter.SetBorderAndTitleBar(true, false);
HideSystemTitleBarButtons();          // → TitleBarHeightOption.Collapsed
SetTitleBar(AppTitleBar);
CaptionButtons.Attach(this, AppTitleBar);
```

**引入前必须实测的三项**（仓库内无任何验证记录）：① 多显示器 / 多缩放比下拖动的 region 对齐；② 深浅主题切换时关闭按钮配色与 Mica 叠加；③ 最大化 / 还原 / Snap 三种状态下字形与 hit-test。


---

# 第二部分　WhalesLauncher 前端迁移可行性评估

## 2.1 迁移来源现状（实测数据）

> 说明：任务书中「待补充：whaleslauncher 的仓库地址/代码位置、技术栈、前端规模」已由本机工作区补齐 —— `F:\WhalesLauncher` 即该项目（`package.json` name `whales-launcher`，README 自述仓库为 `github.com/IDKWhatID2Use/whales-launcher`）。以下数据均为工具实测。

### 技术栈与产物形态

| 项 | 事实 | 证据 |
|---|---|---|
| 运行时 | Electron `41.1.0` | `package.json:35` |
| 语言 | TypeScript 5.7（`tsc --noEmit` 作为构建门禁） | `package.json:21,36` |
| UI 框架 | **无**。原生 DOM + 自研 `h()` / 模板函数 | `src/renderer/util/dom.ts` |
| 状态管理 | 手写 `AppStore`（`get()` / `subscribe()` / 微批 `patch()`） | `src/renderer/data/store.ts:49-286` |
| 路由 | 自研 hash 路由，5 路由 + 4 详情子标签 | `src/renderer/router.ts:3-11,18-52` |
| 样式 | 5 个手写 CSS，语义令牌 + 组件/视图分层，**无硬编码色值** | `src/renderer/styles/*.css` |
| 依赖（运行时） | 仅 2 个：`adm-zip`、`js-yaml` | `package.json:26-29` |
| 依赖（开发） | `esbuild`、`typescript`、`electron`、`@types/*` | `package.json:30-37` |
| 构建 | `scripts/build.mjs`：tsc 门禁 → esbuild 三产物 → `dist.tmp` → 原子替换 `dist/` | `scripts/build.mjs:60-99,166-237` |
| 渲染产物 | IIFE（`file://` 下 ESM 会被 CORS 拦），`dist/renderer/index.js` **350,459 B** | `scripts/build.mjs:88-97` |
| 主进程产物 | CJS，`dist/main/index.cjs` **451,452 B** | `scripts/build.mjs:60-73` |
| preload 产物 | CJS，`dist/preload/index.cjs` **5,321 B** | `scripts/build.mjs:74-86` |
| CSP | `default-src 'none'; connect-src 'none'; script-src 'self' file:; ...` —— **渲染层零网络** | `src/renderer/index.html:18-21` |
| 交付形态 | 免安装：`.bat` 双击启动 + 按需重建；`.vbs` 静默；无单文件 exe（README 明确说明不上 electron-builder） | `README.md:217-222` |

### 代码规模（逐文件实测行数）

> **统计口径**：用 Node 逐文件 `fs.readFileSync(...).split(/\r?\n/).length` 统计，**含空行与注释**。`node_modules` 与 `.spike` 已排除。
> （注：若用 PowerShell `Measure-Object -Line` 会**只计非空行**，同一份代码会得到约 0.8 倍的数字；下文一律采用上表口径。）

| 模块 | 文件数 | 行数 |
|---|---|---|
| `src/renderer`（前端全部 .ts） | 37 | **10,967** |
| `src/renderer/styles`（CSS） | 5 | **4,011** |
| → **渲染层合计（ts + css + html 55）** | 43 | **≈ 15,033** |
| `src/main`（Electron 主进程） | 9 | **2,611** |
| `src/core`（纯 Node 业务引擎） | 16 | **6,998** |
| `src/shared`（契约） | 1 | **893** |
| `src/preload` | 1 | **142** |
| → **src 全部 TS 合计** | **64** | **≈ 21,611** |
| `tests`（38 个 `.mjs` + 3 个 `.cjs`） | 41 | **9,617** |
| `scripts` | 8 | 2,831 |
| `docs`（20 个 `.md`，含本次新增的 2 份） | 20 | 7,546 |

**渲染层内部构成**（`src/renderer` 子目录）：`views/` 4,398 ｜ `data/` 2,321 ｜ `components/` 1,876 ｜ 根文件 1,732 ｜ `util/` 603 ｜ `styles/` 4,011。

### 前端的关键技术约束（决定迁移难度）

1. **渲染层有 120 处 DOM/浏览器 API 直用**（`document.` / `window.` / `navigator.` / `MutationObserver` / `requestAnimationFrame` / `getComputedStyle` / `execCommand` / `document.hasFocus` …），分布在 18 个文件。这是「重写」的物理边界 —— 它们**没有** WinUI 对应物。
2. **数据层也不是框架无关的**：`store.ts:289-292` 的 `applyTheme()` 直接 `document.documentElement.dataset['theme'] = target`。即**连 UI 框架无关的「状态层」都被 DOM 污染**，不能原样移植。
3. **IPC 契约是清晰的**：`src/shared/contracts.ts` 导出 44 个类型/常量 + `WhalesApi` 接口（**37 个方法** + 2 个推送订阅）。分域清单：

| 域 | 方法数 | 方法 |
|---|---|---|
| `launcher` | 3 | `getConfig` / `setConfig` / `detectNode` |
| `instance` | 8 | `list` / `create` / `get` / `update` / `remove` / `launch` / `stop` / `openFolder` |
| `engine` | 4 | `list` / `available` / `install` / `remove` |
| `plugin` | 9 | `inventory` / `add` / `remove` / `setBundleEnabled` / `install` / `removeLocal` / `listLocal` / `pickArchive` / `pickFolder` |
| `settings` | 4 | `read` / `write` / `shareConflicts` / `resolveShareConflict` |
| `saves` | 2 | `list` / `openFolder` |
| `pack` | 3 | `export` / `import` / `pickFile` |
| `app` | 4 | `version` / `openExternal` / `menu` / `menuCommand` |
| 订阅 | 2 | `onLog(chunk)` / `onState(runtime)` |
| **合计** | **37 + 2** | — |

4. **核心业务是「进程 + 文件系统 + 网络」重度型**：`core/instance.ts` 50,473 B、`core/plugin-packs.ts` 58,528 B、`core/ports.ts` 28,176 B、`core/launch.ts` 23,724 B、`core/proc.ts` 21,221 B。
5. **日志链路是性能敏感的自研实现**：`data/logs.ts` 是**容量 4000 的环形缓冲**（`logs.ts:47`），`logview.ts` **上限 1500 DOM 行**（`logview.ts:15`）+ 微批合并（`util/batch.ts`）+ 「仅当用户在底部才跟随」+ 超限批量裁剪（`logview.ts:150-159`）。
6. **菜单是「唯一事实源」驱动**：`menuSpec()` 在主进程定义一次，渲染层通过 `app.menu()` 拉取 `MenuNode[]` 渲染，并有自动化断言守住"菜单显示的快捷键 ⊆ 真实绑定"（`README.md:93-94`）。
7. **WCO 兜底链是三级**：CSS `--wco-w: 138px` → `navigator.windowControlsOverlay.getTitleBarAreaRect()` → `geometrychange` 事件（`titlebar.ts:42-57`）。且 **WCO 参数三处同源**：主进程 `titleBarOverlay.height = 48`（`main/theme.ts:22`）↔ CSS `--titlebar-h: 48px`（`styles/tokens.css:179`）↔ 渲染层运行时测得 `--wco-w`。
8. **对浏览器 API 的依赖「浅而窄」（难得的正面证据）**：`canvas` / `Intl` / `localStorage` / `fetch` / `ResizeObserver` / `Blob` / 拖放 API **全部 0 命中**。整层只有 6 类 Web 语义：hash 路由、`MutationObserver`×1、`requestAnimationFrame`×1、剪贴板双路径（`navigator.clipboard` + `execCommand` 回退）、`app-region` 拖拽。**这意味着重写时不需要面对「Web 平台独有能力缺失」的深坑**，只是需要把 DOM 表达换成 XAML 表达。
9. **存在一层约 2,300 行「DOM-free 逻辑」可近乎逐行移植**（迁移的减负项）：`data/api.ts`、`data/logs.ts`、`data/share-conflicts.ts`、`data/summary-ext.ts`、`util/format.ts`、`util/color.ts`、`util/names.ts`、`util/batch.ts`。`store.ts`（294 行）只差**去 toast 化**（`store.ts:9` 引入 `toast`）。真正必须重写的是约 **8,300 行表现层** + **4,011 行 CSS**。
10. **CSS 令牌化极彻底**：`styles/tokens.css` **226 条变量声明 / 164 个唯一名**，且**非 tokens 文件中实测 0 处硬编码颜色** —— 这使「CSS → XAML `ResourceDictionary`」的转译成为机械工作，而非审美重做。
11. **测试现状的关键事实**：**渲染层零自动化测试**（无 jsdom / playwright / puppeteer），41 个测试文件全部针对 `core/` 与 `dist/` 产物（`tests/dist/verify-dist.cjs` 用替身 `electron` 去 `require` 真实产物，专门抓"构建成功但初始化即抛错"）。教程截图靠 CDP 驱动（`scripts/make-tutorial-shots.mjs`）。

## 2.2 需求对照表

> 判定口径：**可直接复用** = 现成实现或 API 可直接承接，改动限于接线；**需改造** = 逻辑可迁移但代码必须重写；**不支持** = 平台无对应能力，需替换方案或放弃。

### A. 界面外壳

| 需求项 | WinUI 3 / WinUINav 支持情况 | 结论 | 依据 |
|---|---|---|---|
| 自绘标题栏（品牌+菜单+拖拽区） | WinUI 3 标准做法 `ExtendsContentIntoTitleBar` + `SetTitleBar`；WinUINav 用覆盖式 `Grid` + `IsHitTestVisible` 自行实现 | 需改造 | `MainWindow.xaml`；`titlebar.ts` |
| Windows 三按钮「系统原生绘制」 | Windows 11 **无此 API**。WinUI 3 只能「自绘」或「完全交给系统」。WinUINav 自绘（138px/48px，字形 `\uE921/\uE922/\uE8BB`） | **不支持，必须替换** | `CustomCaptionButtons.xaml`（`Width=138 Height=48`，三列 46） |
| WCO 宽度自适应（`env(titlebar-area-*)` / `getTitleBarAreaRect`） | WinUI 3 无 WCO。需改为固定自绘按钮宽度或读 `AppWindowTitleBar` 尺寸 | 需改造 | `titlebar.ts:42-57` |
| 关闭按钮 hover 变红 / 最大化字形切换 | WinUINav 已实现（`ApplyCloseVisual`、`UpdateMaxGlyph`、`ClosesHover` 硬编码 Fluent 色） | 需改造（可搬 WinUINav 实现） | `CustomCaptionButtons.xaml.cs` |
| Snap Layouts 保留 | WinUINav 用 `InputNonClientPointerSource.SetRegionRects(Maximize, ...)` 保留 | 需改造（可搬） | `CustomCaptionButtons.xaml.cs` |
| Mica 背景（带降级） | 原生支持：`MicaBackdrop` / `DesktopAcrylicBackdrop`；WinUINav 已有 `ApplyBackdrop(mode)` + `DwmBackdropHelper.cs` | **可直接复用** | `App.xaml.cs`（`DwmApi`/`User32` interop）；`main/theme.ts` |
| 深浅双主题 + 跟随系统 | 原生 `ElementTheme`（Default/Light/Dark）；WinUINav 的 `RefreshForTheme(ElementTheme)` 可直接接 | **可直接复用** | `SettingsPage.xaml.cs`（`ApplyTheme`）；`store.ts:289-292` |
| 设计令牌体系（CSS 变量 → 语义色） | WinUI 3 有 `ThemeResource` / `XamlResource` 体系，需逐条重建 269 行令牌 | 需改造 | `styles/tokens.css` |
| 自绘应用内菜单（含加速键显示） | WinUI 3 `MenuBar` / `MenuFlyout` 原生。但"菜单定义即唯一事实源 + 渲染层拉取"的设计需重做（C# 侧 `MenuNode[]` → XAML） | 需改造 | `main/menu.ts`（15,317 B）、`components/menubar.ts`（12,869 B）、`contracts.ts` `MenuNode` |
| 单实例 + 切前台 | 需 `AppInstance.FindOrRegisterInstanceForKey` 或 Mutex + `SetForegroundWindow` | 需改造 | `main/index.ts` |
| 自定义图标集（SVG） | WinUI 3 用 `FontIcon`（Segoe Fluent Icons）/ `PathIcon`；★ 本机渲染层是**运行时构造 SVG** | 需改造 | `src/renderer/icons.ts:112`（`createElementNS(SVG_NS, 'svg')`） |
| 模板化教程截图（CDP 驱动无头 Chromium） | WinUI 3 无等价物；需换 `Windows.Graphics.Capture` 或 UIA 驱动 | **不支持** | `package.json:15`（`shots:tutorial`） |

### B. 路由与导航

| 需求项 | 支持情况 | 结论 | 依据 |
|---|---|---|---|
| 5 路由（instances/detail/engines/wizard/settings） | `NavigationView` + `Frame` 可承接 | 需改造 | `router.ts:3`；`MainWindow.xaml` |
| 详情页 4 子标签（plugins/settings/saves/logs） | `NavigationView` 不支持标签语义；需 `TabView` 或自绘 | 需改造 | `router.ts:11`（`DETAIL_TABS`） |
| 路由参数（`#/instance/<id>/<tab>`，URI 解码容错） | 需自建「route → page + 参数」注册表（WinUINav 完全没有） | 需改造 | `router.ts:18-52`、`safeDecode` |
| 前进/后退 + F5 刷新后恢复路由 | `Frame.BackStack` 可做后退；"hash 持久化 + 刷新恢复"无对应，需自建状态序列化 | 需改造 | `router.ts:73-95` |
| 深链接（外部以带 hash 地址加载） | 无对应（可做成命令行参数/协议激活） | 需改造 | `router.ts:81-84` |

### C. 组件模型

| 需求项 | 支持情况 | 结论 | 依据 |
|---|---|---|---|
| 通用 UI 原语（`ui.ts` 18,993 B：按钮/徽标/分段控件/卡片/统计） | WinUI 3 有对应控件；需逐个重建样式层 | 需改造 | `components/ui.ts` |
| 模态框（焦点陷阱 + `activeElement` 恢复） | `ContentDialog` 原生 | 需改造 | `components/modal.ts:58,185,206` |
| 浮层菜单（视口内定位 + 外部点击关闭 + focus 保护） | `Flyout` / `MenuFlyout` 原生 | 需改造 | `components/menu.ts:183-198` |
| Toast（`aria-live` 堆栈） | `InfoBar` / `TeachingTip` 或自绘 | 需改造 | `components/toast.ts` |
| **YAML 编辑器**（行号槽滚动同步、Tab→2 空格、Ctrl+S、空内容/行尾空白标红） | **无现成控件**。需自建：`TextBox`/`RichEditBox` + 行号 `ListView` 同步，或引入第三方编辑器 | **需从零构建（迁移难度最高的单个组件）** | `components/yaml-editor.ts:40-74`（`renderGutter`/`syncScroll`/`keydown`） |
| **日志视图**（三路分色 + 流过滤 + 底部跟随 + 1500 行裁剪 + 环形 4000 + 微批 + 快捷键） | `ListView`/`ItemsRepeater` 可做，但**增量 append 的性能模型完全不同**；`ObservableCollection` 逐条 `Add` 是典型卡顿源 | **需改造 + 性能重做** | `components/logview.ts:15,150-159,237-247`；`data/logs.ts:47` |
| 日志抽屉（右滑出 + Esc 关闭 + 路由联动） | `SplitView` / 自绘 | 需改造 | `shell.ts` |
| 左实例栏（搜索/排序/筛选 + 计数） | `ListView` + `CollectionViewSource` | 需改造 | `views/instances.ts:289` |
| 状态徽标 / 运行计时器 | `DispatcherQueueTimer` 替代 `setInterval` + `querySelectorAll('[data-elapsed]')` | 需改造 | `util/clock.ts:16-47` |
| 剪贴板（含 `execCommand` 回退） | `Clipboard.SetContent` / `DataPackage` | 需改造 | `util/dom.ts:158-178` |

### D. 状态管理与数据流

| 需求项 | 支持情况 | 结论 | 依据 |
|---|---|---|---|
| `AppStore`（单一事实源 + subscribe + 微批） | C# 侧等价物：`INotifyPropertyChanged`（CommunityToolkit.Mvvm）或自建 `Store` 类 | 需改造 | `store.ts:49-286` |
| `LogStore` 环形缓冲 4000 + seq 增量 | C# 直接实现（`List<T>` + 头裁剪），逻辑无痛 | 需改造 | `logs.ts:37-145` |
| 实时运行态推送 `onState` | IPC → C# 事件 → UI 线程 `DispatcherQueue.TryEnqueue` | 需改造 | `contracts.ts:691-692` |
| 乐观更新 + 失败回滚（`saveConfig`） | C# 逻辑直译 | 需改造 | `store.ts:240-251` |
| 主题应用 | 已耦合 DOM（`document.documentElement.dataset`），必须重写 | 需改造 | `store.ts:289-292` |
| 演示模式（无后端时用内置假数据，59 KB） | 可保留为 C# 的 `DemoApi : IWhalesApi` | 需改造 | `data/demo.ts:1539`（`createDemoApi()`） |

### E. IPC 契约与后端能力（37 方法 + 2 推送订阅）

> **契约实测**：`CH` 通道表 **39 条**（9 组：launcher 3 / instance 8 / engine 4 / plugin 9 / settings 4 / saves 2 / pack 3 / log 2 / app 4）；`WhalesApi` **37 个方法 + 2 个订阅**（`onLog`/`onState`）；内部 `CoreApi` **43 个方法**。推送只有 `log:chunk` + `log:state` 两条**粗粒度全量**通道（无增量/按需订阅）。

| 需求项 | 支持情况 | 结论 | 依据 |
|---|---|---|---|
| `contextBridge` → `window.whales`（零 `ipcRenderer` 泄漏） | WinUI 3 无 Electron IPC。同进程内直接方法调用 / DI，或跨进程用 `NamedPipe`/`AppService` | 需改造 | `src/preload/index.ts`（125 行）、`main/ipc.ts`（29,821 B） |
| 38 个方法的契约与类型 | `contracts.ts` 是**可机械转写的契约**（44 个类型/常量），转 C# record/interface 成本可控 | 需改造 | `contracts.ts:33-537,623-698` |
| 路径类型 `NodeRuntimeSource` / `InstanceState` 等联合类型 | C# enum + `[JsonConverter]` | 需改造 | `contracts.ts:108,436` |
| 结果包装 `Result<T> = {ok:true,value} \| {ok:false,error}` | C# 需自建 `Result<T>`（或抛异常 + 边界捕获） | 需改造 | `contracts.ts:19-22` |
| **流式日志推送**（stdout/stderr/system 分色 + 实时） | 需在 C# 侧订阅 `Process.OutputDataReceived` → 批量投递 UI 线程 | 需改造（**性能关键**） | `contracts.ts:348-353`（`LogChunk`）、`core/launch.ts` |

### F. 核心业务域（`src/core`，6,998 行 —— 迁移的真实主体）

| 域 | 需求要点 | 结论 | 依据 / 迁移难点 |
|---|---|---|---|
| 实例 CRUD + 共享模式（junction 链接 / `lstat` 防误删 / 凭证 inherit） | C# `Directory.CreateSymbolicLink` / `File.CreateSymbolicLink` + `File.GetAttributes(ReparsePoint)` 等价 | 需改造 | `core/instance.ts`（50,473 B，全仓最大业务文件）、`core/fsx.ts`（13,181 B） |
| 引擎版本枚举 / npm 查询 / 安装（实时日志）/ 卸载（占用保护） | C# `HttpClient` 打 registry + `Process` 跑安装；网络请求**必须移到进程侧**（因 CSP `connect-src 'none'`） | 需改造 | `core/engine.ts`（15,936 B）、`package.json`（`adm-zip` 用于解包） |
| 插件管理（走 `dsh plugin` CLI）+ 本地插件包（archive/github/folder 三来源） | `ProcessStartInfo` + `adm-zip` → C# `System.IO.Compression` | 需改造 | `core/plugins.ts`、`core/plugin-packs.ts`（58,528 B）、`core/modpack.ts` |
| **端口自动分配**（3080–3179 避让、进程内同步预留、OS 绑定探测、全占满回落 `--port 0`、三处落账） | C# `Socket`/`TcpListener` 可做 bind 探测；「进程内同步预留」需 `SemaphoreSlim` 或 `lock`；台账 `cache/ports.json` 直译 | 需改造（**逻辑最复杂，必须逐条重验**） | `core/ports.ts`（28,176 B）、`docs/design/port-allocation.md` |
| 实例启动/停止/进程树管理（spawn + 注入 `DSH_HOME` + stdout/stderr 分流 + 退出码 + `taskkill` 兜底） | C# `Process` + `ProcessStartInfo.Environment`；**进程树终止语义与 Node 不同**，需 `JobObject` 或重写 | 需改造（**风险高**） | `core/launch.ts`（23,724 B）、`core/proc.ts`（21,221 B） |
| Node 运行时探测（跑 `node -e` 读 `process.versions`，5 级候选） | C# `Process` 跑同样探针即可，逻辑直译 | 需改造 | `core/node-runtime.ts:30,50,95,104,329` |
| 设置读写（`settings.yaml` **文本级保真** + 写入前 YAML 语法校验） | C# 需 `YamlDotNet` 之类做**校验**；★ 现实现是「原文读写」，不解析往返，因此**注释/格式保真度不是问题** | 需改造 | `core/profile.ts:14,160-174,316` |
| 会话枚举（`sessions/` 倒序 + 体积） | 文件系统枚举，直译 | 需改造 | `core/saves.ts` |
| 实例包导入导出（zip） | `System.IO.Compression.ZipFile` | 需改造 | `core/modpack.ts`（14,816 B） |
| 原子写（同目录临时文件 + rename） | C# `File.Replace` / `File.Move` | 需改造 | `core/fsx.ts` |

### G. Electron / Web 专有能力使用点（迁移阻塞清单）

| 现用能力 | 位置 | WinUI 3 对应 | 结论 |
|---|---|---|---|
| `titleBarStyle:'hidden'` + `titleBarOverlay`（WCO） | `main/index.ts`、`titlebar.ts`、`index.html`（`env(titlebar-area-*)`） | **无**。WebView2 方案下**有**（见 2.5） | **不支持**（原生方案） |
| `backgroundMaterial`（Mica） | `main/index.ts`、`main/theme.ts` | `MicaBackdrop` | 可直接复用 |
| `MenuItem` 加速键 + `menuSpec()` 唯一事实源 | `main/menu.ts`（15,317 B） | `MenuBar` / `KeyboardAccelerator` | 需改造 |
| 单实例锁 | `main/index.ts` | `AppInstance` / `Mutex` | 需改造 |
| `shell.openPath` / `openExternal` | `main/ipc.ts`（`instance:openFolder`、`app:openExternal`） | `Process.Start` + `UseShellExecute` / `Launcher.LaunchUriAsync` | 可直接复用 |
| `dialog.showOpenDialog/SaveDialog` | `plugin:pickArchive`、`plugin:pickFolder`、`pack:pickFile` | `FileOpenPicker` / `FileSavePicker`（**注意：MSIX 打包下需 `InitializeWithWindow`**） | 需改造 |
| **子进程 spawn + 环境变量注入 + 流式 stdio** | `core/launch.ts`、`core/proc.ts`、`core/node-runtime.ts` | `Process` + 事件；**流式转发需自建批量投递** | 需改造（风险高） |
| **端口 bind 探测 / 预留** | `core/ports.ts` | `Socket.Bind` | 需改造 |
| **junction 创建/解除 + `lstat` 判定** | `core/instance.ts`、`core/fsx.ts` | P/Invoke 或 `Directory.CreateSymbolicLink` + `ReparsePoint` | 需改造 |
| `contextBridge` / `ipcMain` / `ipcRenderer` | `preload/index.ts`、`main/ipc.ts` | 同进程直调 或 `NamedPipe` | 需改造 |
| CSP `connect-src 'none'` 的架构含义 | `renderer/index.html:20` | 无 CSP 概念（但**同样的架构原则应保留**：网络只在进程侧） | 可直接复用（原则） |
| `MutationObserver` / `requestAnimationFrame` / `document.hasFocus` / `activeElement` / `getComputedStyle` | `menubar.ts:299`、`dom.ts:187,198`、`menu.ts:169`、`modal.ts:58` | **无对应**。需用 `VisualTreeHelper` / `LayoutUpdated` / `FocusManager` / `ActualThemeChanged` 重新表达 | **不支持** |
| `document.execCommand('copy')` 回退 | `dom.ts:177` | `Clipboard.SetContent` | 可直接复用 |
| CDP 驱动的截图脚本（教程图） | `package.json:15`、`scripts/` | 无 | **不支持** |
| Node 生态依赖（`js-yaml`、`adm-zip`） | `package.json:26-29` | `YamlDotNet`、`System.IO.Compression` | 需改造 |

## 2.3 工作量估算（相对量级）

参照系：**WinUINav 用「3 个演示页面 + 1 个标题栏控件 + 2 个 interop 辅助类」换来了约 1,900 行自写 C#**（`CustomCaptionButtons.xaml.cs` 32,631 B + `MainWindow.xaml.cs` 30,076 B + `App.xaml.cs` 3,796 B + `SettingsPage.xaml.cs` 4,638 B + XAML），而它**只有 2 个导航项、无业务逻辑、无测试**。WhalesLauncher 是 15,033 行渲染层（10,967 TS + 4,011 CSS + html）+ 6,998 行业务引擎 + 37 个 IPC 方法 + 41 个测试文件的量级。

| 方案 | 范围 | 预估代码量 | 相对量级 | 说明 |
|---|---|---|---|---|
| **A. 全量重写**（前端 + 主进程 + core 全用 C#/XAML） | 全部 | 自写 C#/XAML **25,000–40,000 行** | **XXL**（单人 6–12 人月） | 5 个路由 + 11 视图 + 7 组件 + 12 个业务域；XAML 声明式代码通常比等价 TS 更长 |
| **B. WinUI 外壳 + WebView2 承载现有渲染层** | 只换外壳；渲染层**零改动** | 新增 C# **1,500–3,000 行**（窗口/标题栏/WCO 接线/桥接/打包） | **S–M**（单人 2–6 周） | 见 §2.5 方案 B；`window.whales` 需以 `chrome.webview` 适配层补齐 |
| **C. 混合**：XAML 重做界面 + core 保留为 Node 侧车进程 | 前端重写；core 不动 | C# 15,000–25,000 行 + 桥接 500–1,000 行 | **XL**（单人 3–6 人月） | 换取 core 的 41 个测试与 5,466 行逻辑全部保留 |

**分项量级（方案 A 视角）**：

| 分项 | 相对量级 | 主要成本来源 |
|---|---|---|
| 外壳/标题栏/Mica/主题 | M | WCO 替换为自绘，需搬 WinUINav 方案 + 重新做 DPI |
| 5 视图 + 4 子标签 + 向导四步 | XL | 4,635 行视图逻辑 + 5 视图的交互细节 |
| 7 个组件（含 YAML 编辑器、日志视图） | L | 日志视图的性能模型重做 + YAML 编辑器从零写 |
| 3,432 行 CSS → XAML 样式/令牌 | L | 269 行令牌 + 1,655 行组件样式逐条转译 |
| `store` + `logs` + `router` | M | 逻辑可直译，但 `store` 的主题部分耦合 DOM |
| **core 12 个业务域** | **XXL** | 5,466 行 + 12 个域，其中 ports/launch/proc 为高风险 |
| 38 方法 IPC → C# 接口 + 序列化 | M | 契约机械转写 |
| 测试体系重建 | L | 41 个 `.mjs` 测试文件在 C# 下**全部作废** |
| 构建/启动/打包链路 | M | esbuild+原子替换 → MSBuild+MSIX；`.bat` 免安装体验会变 |
| 教程截图/录制脚本 | S–M | CDP 方案不可用，需换 |

## 2.4 主要风险点

| # | 风险 | 严重度 | 依据 | 缓解 |
|---|---|---|---|---|
| R1 | **core 层全量重写 ⇒ 41 个测试文件 9,617 行全部作废**，其中含真实 dsh 引擎集成测试（`tests/e2e/53-port-acceptance.mjs` 8 实例并发、`tests/core/launch-real-dsh.test.mjs`，以及 Windows 深度耦合的 `killTree` 先 `taskkill /T`、`net.createServer().listen({exclusive:true})` 绑定探测、`.cmd` 垫片） | 极高 | `tests/` 实测 41 文件 9,617 行；`core/proc.ts:456`、`core/ports.ts:263` | 采用方案 B/C 保留 core 与测试 |
| R1b | **渲染层本来就没有自动化测试** —— 迁移后前端质量只能靠人工回归，没有可迁移的测试资产兜底 | 高 | 实测无 jsdom / playwright / puppeteer | 先为渲染层补 e2e 再动刀 |
| R2 | **端口分配逻辑**（3080–3179 避让 / 进程内同步预留 / bind 探测 / 三处落账）在 C# 下需逐条重验，且「进程内同步预留」依赖 Node 单线程事件循环语义 | 高 | `core/ports.ts`（28,176 B）、`docs/design/port-allocation.md`（20,244 B） | 独立验收用例先行（对等移植现有 e2e） |
| R3 | **进程树终止语义差异**：Node 侧 `taskkill` 兜底 + sandbox job object 行为，C# 需 `JobObject` 重做，否则产生孤儿进程 | 高 | `core/proc.ts`（21,221 B）、`README.md:365` | 引入 `JobObject` 并做真机对拍 |
| R4 | **日志流性能**：4000 行环形缓冲 + 微批 + 1500 行视图上限的方案，在 `ObservableCollection` 逐条 `Add` 下会卡顿 | 中高 | `logs.ts:47`、`logview.ts:15,237-247` | 用 `ItemsRepeater` + 自建批通知，或单控件累积文本 |
| R5 | **「系统原生三按钮」体验回归**：现设计刻意让系统绘制三按钮（`shell.ts:7` 明确「本文件不创建任何窗口控制按钮」），WinUI 3 必须自绘 | 中高 | `shell.ts:1-7`；WinUINav 自绘方案 | 搬 WinUINav `CustomCaptionButtons`，并**补上它缺失的逐显示器 DPI 处理** |
| R6 | **YAML 编辑器需从零构建**（行号槽滚动同步、Tab→2 空格、Ctrl+S、就地标红） | 中 | `components/yaml-editor.ts:40-74` | 评估第三方编辑器控件；或降级为纯 `TextBox` |
| R7 | **`.bat` 免安装交付形态会变**：WinUINav 是 `WindowsPackageType=MSIX` + `WindowsAppSDKSelfContained=true`，MSIX 需签名/开发者模式 | 中 | `WinUINav.csproj`（`WindowsPackageType`, `AppxPackageSigningEnabled=False`） | 改 `WindowsPackageType=None`（unpackaged）或自签名 |
| R8 | **WinUINav 的关键交互验证不完整**：`CustomCaptionButtons` 只做单一 `RasterizationScale` 缩放（多显示器 DPI 是已知短板），且仓库零测试零 CI | 中 | `TryGetPixelRect` 实现；§1.5 | 引入前必须在多显示器/多缩放比下实测 |
| R9 | **构建环境门槛抬升**：WinUINav 要求 VS 2026；WhalesLauncher 现只需 Node ≥22 | 中 | `README.md`（快速开始） | 用 `dotnet build` CLI 绕开，但 XAML 编译链路仍需 SDK |
| R10 | **文档与工程资产连带损失**（方案 A）：`docs/` 22,390 行中 `ui-redesign.md`（155 KB）、`ui-acceptance-criteria.md`（98 KB）描述的判据需重新映射到 XAML | 中 | `docs/design/*` | 保留为设计输入，不改写 |
| R11 | **CSP 架构约束**：现渲染层 `connect-src 'none'`，所有网络都在进程侧。任何新前端必须维持该边界 | 低–中 | `renderer/index.html:20`、`core/engine.ts` | 作为硬约束写入新架构规范 |
| R12 | **Polyform Noncommercial 与 MIT 的兼容性**：可把 MIT 代码并入受限许可项目（需保留 `Copyright (c) 2026 BitCloud` + MIT 全文）；但 WhalesLauncher 的「非商业」限制会随分发传递 | 低 | 两份 LICENSE 全文 | 在 `NOTICE`/致谢中标注 |
| R13 | **第三方依赖引入**：方案 A 需新增 `YamlDotNet` 等；WinUINav 自身有 3 个 NuGet 包 | 低 | `WinUINav.csproj` | 保持依赖最小化 |

## 2.5 结论

### 前提敏感：两个必须先定的问题

任务书中「是否允许修改 WinUINav 自身源码，或仅作为依赖/模板使用」为**待补充**。该前提**不改变结论方向，但改变实现路径**：

| 前提 | 对结论的影响 |
|---|---|
| **P1：允许修改/接管 WinUINav 源码**（把它作为起点骨架改写） | WinUINav 可作为**窗口装饰层的起步代码**（`CustomCaptionButtons` + `DwmBackdropHelper` + `NativeWindowPaintHook` 约 1,900 行可搬）。但其 `MainWindow`/`Pages`/导航结构不承载任何业务价值，仍需全部重写 |
| **P2：仅作为依赖/NuGet 使用** | **不可行**。WinUINav 不是库：无 NuGet 包、无类库项目（`OutputType=WinExe`）、未标记模板（`is_template:false`），全部代码在可执行工程内。此时它只能作为**参考实现**阅读，无「依赖」可言 |

> 一个额外的**信息自相矛盾点**（按要求不做单方面取舍，予以指出）：任务书把 WinUINav 称为「该项目」并期望「把 whaleslauncher 的前端重写到该项目上」；但 WinUINav 的技术栈是 C# / WinUI 3 / XAML，而 whaleslauncher 前端是 TypeScript / DOM / CSS。**「重写到某项目上」在这种栈关系下不存在增量迁移路径——它不是"移植"，而是"用另一种语言重写"**。本报告的方案对照表就是围绕这一事实展开的。

### 最终结论

> ## **有条件可行**
>
> 技术上不存在硬性不可逾越的障碍（WinUI 3 + .NET 8 完全能承载该应用的业务形态），但**「把前端重写到 WinUINav」这个表述所指的路径（全量重写为 C#/XAML）在工程上不成立**，理由是三条硬约束：
>
> 1. **30 个前端/业务模块中，没有任何一行 TypeScript 能变成 C#** —— 渲染层 120 处 DOM API 直用、数据层耦合 DOM、核心层依赖 Node 子进程与 Node 运行时，**可复用代码量为 0**（唯一例外是「契约定义」这一层语义，可机械转写为 C# 接口）。
> 2. **WinUINav 自身不可作为「承载容器」** —— 它是 90 项文件树、~1,900 行示例代码、零测试、零 CI、2 个导航项的原型仓库；它唯一有价值的资产是标题栏自绘控件，而那个控件**恰好替代掉了** WhalesLauncher 精心保留的「系统原生三按钮」体验（`README.md:89-93`）。
> 3. **全量重写会摧毁本项目最重的工程资产** —— 41 个测试文件、8,327 行测试代码、真实 dsh 引擎集成验收、CDP 教程截图链路，在 C# 下**全部需要重建**。

### 推荐路径（按性价比排序）

| 序 | 方案 | 适用条件 | 量级 |
|---|---|---|---|
| **①**（推荐） | **保留渲染层，用 WinUI 3 外壳 + WebView2 承载**。关键技术事实：WebView2 **原生提供** `CoreWebView2WindowControlsOverlay`（`IsEnabled` / `Height` / `BackgroundColor`），并会向页面暴露 `navigator.windowControlsOverlay` 与 `env(titlebar-area-*)` —— **正是 `titlebar.ts:39-63` 已经在用的那套 API**，且 WinUINav 已经引用了满足该特性的 `Microsoft.Web.WebView2 1.0.3912.50`（该 API 自 WindowsAppSDK/WebView2 1.0.3415 起提供）。**换句话说：现有 WCO 代码在 WebView2 里无需改动即可工作**，这是「保留渲染层」路线最强的技术依据 | 目标是「去掉 Electron 约 200 MB 运行时 / 换原生外壳」，且接受 WebView2 运行时依赖（Win11 已内置，Win10 需分发 Runtime 或走 fixed-version） | **S–M：2–6 周** |
| ②  | **混合**：XAML 重做界面，`src/core` 保留为 Node 侧车进程，通过命名管道/IPC 通信 | 必须得到 100% 原生 XAML 界面与手感 | **XL：3–6 人月** |
| ③  | **全量重写为 C#/XAML**（即「迁移到 WinUINav」的字面路径） | 有专职 .NET 团队且愿意重做全部测试与工具链 | **XXL：6–12 人月** |

**若坚持按字面路径（方案③）执行，可接受的交付条件为**：接受 3 个「不支持」项（系统原生三按钮 → 自绘、CDP 截图链路 → 替换、DOM 观测 API → 重写）；接受 41 个测试文件作废并重写；接受交付形态从「双击 `.bat` 免安装」改为 MSIX（或改 `WindowsPackageType=None`）；并额外为 `CustomCaptionButtons` 补上多显示器 DPI 处理。

### 待补信息清单（用户需提供，及其对结论的影响）

| # | 待补信息 | 为何影响结论 |
|---|---|---|
| 1 | **是否允许修改 WinUINav 源码**（P1/P2） | 决定能否把其控件作为起步代码（见「前提敏感」） |
| 2 | **迁移的不可妥协项**：是否必须**彻底移除 Electron 运行时**（包体积目标）？是否必须**逐像素外观一致**？ | 若是——方案①（WebView2）方向正确；若否——**根本不必迁移**，现状已是 Fluent 合规实现 |
| 3 | **是否必须 100% 原生 XAML 控件树**（如为无障碍/UIA/性能） | 是则排除方案①，只能②/③ |
| 4 | **平台支持范围**：是否要 ARM64？是否要 Windows 10 支持？ | WinUINav 覆盖 `x86;x64;ARM64`、`TargetPlatformMinVersion=10.0.17763.0`，但 README 要求 Win11 24H2+ —— 存在矛盾，需确认基线 |
| 5 | **构建/网络环境能否访问 NuGet 与 VS 2026** | 本机已实测**无法访问 `raw.githubusercontent.com`、pwsh 直连网络失败**；若 NuGet 亦不可达，方案②/③ 的依赖恢复会直接失败 |
| 6 | **是否接受交付形态变化**（免安装 `.bat` → MSIX/自签名） | 影响方案③的可接受性 |
| 7 | **测试与 CI 的保留要求**（是否必须保留真实 dsh 引擎对拍） | 决定方案①/②/③ 的取舍 |
| 8 | **WinUINav 的 fork 关系**：其提交历史引用旧组织 `BitCloudStudio`，README 的克隆地址也是旧地址 | 若需长期跟随上游修复，需确认上游是否仍活跃（当前 12 次提交、无 release） |

**缺口对结论的影响**：第 2、3 项若答案为「不必移除 Electron / 不必原生控件树」，则**结论会从「有条件可行」变为「不建议迁移」**——因为现状（Electron + 原生 TS 渲染层 + Mica + WCO + Fluent 令牌体系）已经是在该约束下的合理实现，迁移只有成本没有收益。反之若第 2 项是「必须移除 Electron」，则方案①是唯一低成本路径。

---

## 附录：本报告的证据索引

| 证据 | 位置 |
|---|---|
| 仓库元数据（star/fork/issue/license/时间/size） | `GET /repos/LingduSoftStudio/WinUINav` |
| 完整文件树（90 项，`truncated:false`） | `GET /repos/.../git/trees/main?recursive=1` |
| 提交历史（12 次，含空树提交 `d5f94b3`） | `GET /repos/.../commits?per_page=100` |
| `README.md`（1,725 B，全文已解码） | Contents API |
| `WinUINav.csproj`（4,047 B，全文已解码 + Blobs API 二次核对） | Contents API + `git/blobs/3651109…` |
| `MainWindow.xaml`（3,510 B，全文已解码） | Contents API |
| `App.xaml.cs`（3,796 B，全文已解码） | Contents API |
| `Pages/SettingsPage.xaml.cs`（4,638 B，全文已解码） | Contents API |
| `Controls/CustomCaptionButtons.xaml`（4,104 B，全文已解码） | Contents API |
| `Controls/CustomCaptionButtons.xaml.cs`（32,631 B，**部分解码 + 全文符号清单**） | Contents API（§1.2 已标注覆盖范围） |
| `LICENSE`（1,065 B，全文已解码） | Contents API |
| `Properties/PublishProfiles/win-x64.pubxml`（553 B，全文已解码） | Contents API |
| WhalesLauncher 侧全部数据 | 本机 `F:\WhalesLauncher` 实测（行数/字节数/`:行号` 见正文） |
| WebView2 WCO 能力 | [CoreWebView2WindowControlsOverlay Class](https://learn.microsoft.com/dotnet/api/microsoft.web.webview2.core.corewebview2windowcontrolsoverlay) |
| WebView2 本地内容加载 | [Using local content in WebView2 apps](https://learn.microsoft.com/microsoft-edge/webview2/concepts/working-with-local-content) |
