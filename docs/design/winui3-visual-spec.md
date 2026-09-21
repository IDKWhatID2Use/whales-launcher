# WhalesLauncher WinUI 3 视觉规范（W0-SPEC）

> **本文档是 WhalesLauncher WinUI 3 前端（8 个页面 + 应用外壳 + 浮层）的唯一设计依据。**
> 规范先行：先有本文件，再有 XAML。实现者不得自行发明色板、字号、圆角、间距与控件替换方案。
>
> **本文档的产出方式**：所有规格逐条回源到 microsoft-ui-xaml 仓库、WinUI 3 内置 ThemeResource 定义文件或 Windows App SDK 官方 API 页；查不到出处的条目一律显式标注 `⚠️ 自定`，不做伪官方化。
>
> **不得作为设计依据的已废弃材料**：`src/renderer/**`（含 `styles/fluent-tokens.css`）、`docs/design/ui-redesign.md`、`docs/design/ui-acceptance-criteria.md`、`docs/review/fluent2-*.md`。
> **唯一可用作「功能需求清单」的来源**：`docs/review/frontend-survey-for-winui3.md`（该文件描述的 **UI 设计** 同样不作依据，只取其「页面需要哪些功能」与 IPC 契约事实）。

---

## 0. 出处标记法、基准版本与效力

### 0.1 五种出处标记

| 标记 | 含义 | 示例 |
|---|---|---|
| `[MUX:路径]` | microsoft-ui-xaml 仓库（MIT）中的文件，本次实读原文 | `[MUX:controls/dev/CommonStyles/CornerRadius_themeresources.xaml]` |
| `[KEY:定义文件]` | WinUI 3 内置 ThemeResource 键名，附定义处 | `ControlCornerRadius` `[KEY:CornerRadius_themeresources.xaml]` |
| `[API:定义文件]` | Windows App SDK / WinUI 3 API 名，附 `.idl` 或官方 API 页 | `NavigationView.CompactModeThresholdWidth` `[API:controls/dev/NavigationView/NavigationView.idl]` |
| `[LRN:slug]` | Microsoft Learn 官方文档页 | `[LRN:alignment-margin-padding]` |
| `⚠️ 自定` | 查无官方出处，本项目自定义约定 | `⚠️ 自定` |

### 0.2 基准版本（取证快照）

| 项 | 值 |
|---|---|
| microsoft-ui-xaml 读数 commit | `da997f8a2314b538a766dc4e66afce2646781a66`（branch `main`，2026-09-18T23:09:38Z，commit message: `Merge pull request #11933 from microsoft/user/jessecol/agent-build-reliability`） |
| microsoft-ui-xaml 最新 release tag | `winui3/release/2.5.1` |
| Windows App SDK 最新 stable | `v2.5.1`（2026-09-16 发布） |
| 本项目锁定 | **Windows App SDK 2.5.1（stable）**；`MUX_PUBLIC_Vn` 标记的 API 需在锁定的 WinAppSDK 上实测可用后再使用 |

### 0.3 效力与冲突裁决

1. 本文件与任何旧文档冲突时，以本文件为准。
2. 本文件内部冲突时，优先级：`[KEY]` > `[MUX]` > `[LRN]` > `[API]` > `⚠️ 自定`。
3. 实现者若认为某条规格不可行，**不得静默偏离**：须在 PR 描述中引用本文件条款号并说明理由，由 Lead 裁决后回写本文件。

---

## 1. 设计基准声明

### 1.1 三条基准（本项目不做第四套设计体系）

| # | 基准 | 含义 | 出处 |
|---|---|---|---|
| B1 | **令牌基准 = WinUI 3 内置 ThemeResource** | 所有颜色、字号、圆角、厚度、动效时长一律引用内置键名；本项目**不新建**色板、字号阶梯、间距体系 | `[MUX:docs/design-notes/xaml-styling-guide.md]`「All controls must support theming in Light, Dark, and Contrast themes. This is achieved by referencing **all** colors as a brush in the resource dictionary.」「`{ThemeResource}` is used instead of a `StaticResource` … We **almost always** use `ThemeResource` to reference brush keys.」 |
| B2 | **控件基准 = 官方 WinUI 3 控件** | 需求优先映射到 `controls/dev/` 下已公开（`[MUX_PUBLIC]`）控件；`[MUX_PREVIEW]` 控件一律禁用 | `[MUX:controls/dev/]` 目录清单（76 项）；本文 §6 逐个给出映射与禁用项 |
| B3 | **样式基准 = XAML `Style` / `ControlTemplate` + `VisualStateManager`** | 视觉差异用 `Style`（`BasedOn` 内置样式）表达，不用代码里硬改属性 | `[MUX:docs/design-notes/xaml-styling-guide.md]`「Giving the style a key and referencing it with `BasedOn` syntax is imperative to allow for re-templating.」「it is best practice to never modify a control's visual with codebehind」 |

### 1.2 为什么在「Electron → WinUI 3 替换式重构」下这是唯一正统做法

| 理由 | 证据 |
|---|---|
| **① 自建色板会直接丢掉高对比主题。** WinUI 的每个颜色键都有 `Light`/`Dark`/`HighContrast` 三份映射，`HighContrast` 指向 `SystemColor*`（由系统「轻松使用」设置控制）。自建 hex 色板无法参与这套重映射 | `[MUX:controls/dev/CommonStyles/Common_themeresources_any.xaml]`：`Default` 字典中 `TextFillColorPrimary` = `#FFFFFF`、`Light` 中 = `#E4000000`、`HighContrast` 中 `TextFillColorPrimaryBrush` 的颜色取 `{ThemeResource SystemColorWindowTextColor}`；`[LRN:theme-resources]`「there's a corresponding SolidColorBrush resource for every Color resource」「it's a best practice to respect the user's color choices, especially for contrast theme settings」 |
| **② 强调色归用户所有。** 系统强调色是用户在个性化设置里选的运行时值，应用不应固定它 | `[LRN:theme-resources]`「the system accent color is provided as a special color resource using the key `SystemAccentColor`. At runtime, this resource gets the color that the user has specified as the accent color in the Windows personalization settings.」 |
| **③ Mica 的降级语义是用内置底色键定义的。** 只要用内置 `LayerFillColorDefaultBrush` / `SolidBackgroundFillColorBase` 体系，Mica 在「关闭透明效果 / 节电模式 / 低端硬件 / 窗口失焦 / Windows < 22000」时会自动退回正确的实色；自建配色会破坏这条链路 | `[LRN:mica]`「the Mica materials will appear as a solid fallback color (`SolidBackgroundFillColorBase` for Mica, `SolidBackgroundFillColorBaseAlt` for Mica Alt) when: The user turns off transparency … Battery Saver mode is activated … The app runs on low-end hardware … An app window on desktop deactivates … The Windows version is below 22000.」 |
| **④ 字阶已经是现成资源，且与系统文本缩放联动。** WinUI 文本控件默认开启文本缩放；自建字号体系会让缩放行为不一致 | `[LRN:theme-resources]` 给出 9 个 `*TextBlockStyle` 的「Style / Weight / Size」表；`[LRN:accessible-text]`「Many text elements and controls expose `IsTextScaleFactorEnabled`, which defaults to `true` … Avoid disabling text scaling broadly.」 |
| **⑤ 迁移成本论证。** 旧前端 4 006 行 CSS / 164 个设计令牌是**为了在浏览器里手工重建 Fluent 观感**；WinUI 3 场景下这套工作变成「引用内置键名」，重做等价体系是纯粹负收益 | 需求来源：`docs/review/frontend-survey-for-winui3.md` §1「CSS 设计令牌化程度极高 … 唯一变量名 164 个」、§10「令牌→`ResourceDictionary` 映射直接；但 4 000 行选择器规则必须重写为控件模板」 |

### 1.3 允许的自定义白名单（超出即违规）

| 允许 | 边界 | 出处 |
|---|---|---|
| 新建自己的 `ResourceDictionary` 并**转引**内置键 | 必须写成 `<StaticResource x:Key="X" ResourceKey="内置键名" />` 形式，三套主题字典（`Light`/`Dark`/`HighContrast`）都要给 | `[MUX:docs/design-notes/xaml-styling-guide.md]` 的 `TitleBarForegroundBrush` 范例（`ResourceKey="TextFillColorPrimaryBrush"` / `ResourceKey="SystemControlForegroundBaseHighBrush"`） |
| 新建 `Style`（`BasedOn` 内置样式） | 只允许改内边距、对齐、`Margin` 布局类属性；颜色必须仍取 `ThemeResource` | `[MUX:docs/design-notes/xaml-styling-guide.md]`「Property values should always reference a defined ThemeResource or StaticResource.」 |
| 新建 `DataTemplate` / `ControlTemplate` | 颜色取 `ThemeResource`；状态用 `VisualStateManager`，不在 code-behind 改视觉 | 同上「it is best practice to never modify a control's visual with codebehind」 |
| 自定义几何尺寸（`Height`/`Width`/`Margin`/`Padding`） | 必须是 **4 epx 的整数倍** | `[LRN:alignment-margin-padding]`「all dimensions, margins, and padding should be in increments of 4 epx」 |

**禁止**：自定义 `Color` hex 常量、自定义字号数值（用字阶资源）、`StaticResource` 引用画刷（换主题不刷新）、预览版（`MUX_PREVIEW`）控件。

---

## 2. 布局与网格

### 2.1 间距阶梯（4 epx 基准）

| 阶梯 | 值 | 用途 | 出处 |
|---|---|---|---|
| 基准网格 | **4 epx** | 一切尺寸 / `Margin` / `Padding` 都取 4 的整数倍 | `[LRN:alignment-margin-padding]`「if you do use measurement values, all dimensions, margins, and padding should be in increments of 4 epx… it scales UI elements by multiples of 4. Using values in increments of 4 results in the best rendering by aligning with whole pixels.」 |
| `4` | 4 | 图标与文字之间、紧凑控件内边距 | 由 4 epx 基准推导（`⚠️ 自定`：具体档位分配是本项目约定） |
| `8` | 8 | 卡片内元素垂直间距、列表项内左右内边距 | 同上 |
| `12` | 12 | **窄窗口 gutter**（窗口宽 < 640 epx）；`NavigationView` 处于 `Minimal` 模式时的内容边距 | `[LRN:alignment-margin-padding]`「For small window widths (less than 640 pixels), we recommend 12 epx gutters」；`[LRN:navview]`「We recommend 12px margins for your content area when NavigationView is in Minimal mode」 |
| `16` | 16 | 卡片内边距、表单行间距 | `⚠️ 自定`（档位分配） |
| `24` | 24 | **宽窗口 gutter**（≥ 640 epx）；`NavigationView` 非 `Minimal` 模式的内容边距；页面主边距 | `[LRN:alignment-margin-padding]`「for larger window widths, we recommend 24 epx gutters」；`[LRN:navview]`「and 24px margins otherwise」 |
| `32` | 32 | 页面标题区与内容区之间、向导步骤间距 | `⚠️ 自定`（档位分配） |

**硬性规则**
- 页面根 `Grid` 的 `Padding`：窗口宽 ≥ 640 epx → `24,24,24,24`；< 640 epx → `12,12,12,12`。`[LRN:alignment-margin-padding]` + `[LRN:navview]`
- `Margin` 是**累加**的（两个相邻元素各 10 会得到 20 的间距），因此**不要**同时给父子元素设同一方向的 `Margin` 与 `Padding` 来"凑"间距。`[LRN:alignment-margin-padding]`「Margins are additive.」
- **禁止**使用负 `Margin`。`[LRN:alignment-margin-padding]`「using a negative margin can often cause clipping, or overdraws of peers, so it's not a common technique to use negative margins.」

### 2.2 窗口与应用外壳结构

外壳分区（对应需求「标题栏 + 左侧功能栏 + 菜单 + 右侧日志抽屉」）：

```
Window (root Grid)
├─ Row 0  [Auto]  Microsoft.UI.Xaml.Controls.TitleBar   ← 高 48 epx，折进 MenuBar
└─ Row 1  [*]     SplitView (PanePlacement=Right, DisplayMode=Overlay, OpenPaneLength=480)
   ├─ SplitView.Content = NavigationView                ← 左侧功能栏 + 内容 Frame
   │  ├─ MenuItems       = 实例 / 引擎版本管理 / 全局设置   （静态 NavigationViewItem）
   │  ├─ FooterMenuItems = 关于
   │  └─ Content         = Frame（P1…P8 + 关于）
   └─ SplitView.Pane    = 日志抽屉（跨实例聚合 / 单实例）
```

| 结构决策 | 规格 | 出处 |
|---|---|---|
| 窗口标题栏高 = **48 epx** | 用 `TitleBar` 控件，高取 `TitleBarExpandedHeight` 键（= 48）；紧凑态为 `TitleBarCompactHeight`（= 32） | `[KEY:TitleBar_themeresources.xaml 中的 TitleBarCompactHeight=32 / TitleBarExpandedHeight=48，见 MUX:docs/design-notes/xaml-styling-guide.md 摘录]`；`[LRN:titlebar-md]` 官方示例用 `<Grid x:Name="AppTitleBar" Height="48">` |
| 标题栏用官方 `TitleBar` 控件而非裸 `Grid` | `TitleBar` 提供 `Title` / `Subtitle` / `IconSource` / `LeftHeader` / `Content` / `RightHeader` / `IsBackButtonVisible` / `IsBackButtonEnabled` / `IsPaneToggleButtonVisible` 与 `BackRequested` / `PaneToggleRequested` 事件 | `[API:controls/dev/TitleBar/TitleBar.idl]`（`[MUX_PUBLIC_V8]`） |
| **菜单折进标题栏同一行** | 把 `MenuBar` 放进 `TitleBar.Content` 槽（`Content` 类型为 `UIElement`） | `Content` 类型见 `[API:controls/dev/TitleBar/TitleBar.idl]`；组合方式官方无示例 → **本文档组合约定 `⚠️ 自定`**，但 API 层面合法 |
| 左侧功能栏用 `NavigationView`，不用 `SplitView` | 官方明确分工：「If you'd like to build a navigation menu with an expand/collapse button and a list of navigation items, then use the NavigationView control.」 | `[LRN:splitview]` |
| 右侧日志抽屉用 `SplitView` | 官方明确：「The split view control can be used to create any "drawer" experience where users can open and close the supplemental pane.」其 pane「can present itself from either the left side or right side of an app window」 | `[LRN:splitview]` |
| `NavigationView` 置于 `TitleBar` 下方（不重叠）时，关闭其自动标题栏补白 | `IsTitleBarAutoPaddingEnabled="False"` | `[API:controls/dev/NavigationView/NavigationView.idl]` L292 `Boolean IsTitleBarAutoPaddingEnabled { get; set; };` |
| 不用 `NavigationView` 自带返回按钮，返回按钮放 `TitleBar` | `TitleBar.IsBackButtonVisible="True"` + `BackRequested`；`NavigationView.IsBackButtonVisible="Collapsed"`（官方示例同款写法） | `[API:controls/dev/TitleBar/TitleBar.idl]`；`[LRN:titlebar-md]` 官方示例 `<NavigationView IsBackButtonVisible="Collapsed" IsSettingsVisible="False">` |
| 不使用 `NavigationView` 内置 Header（避免与 `TitleBar.Subtitle` 重复标题） | `AlwaysShowHeader="False"` | `[API:controls/dev/NavigationView/NavigationView.idl]` L194；`[LRN:navview]`「To hide the header, set the `AlwaysShowHeader` property to `false`」（官方 Header 固定高 52 px） |
| 拖拽区 | 优先由 `TitleBar` 控件自身提供；额外拖拽区用 `TitleBar.IsDragRegionProperty` 附加属性 | `[API:controls/dev/TitleBar/TitleBar.idl]` L58-L63（`[MUX_PUBLIC_V11]`） |
| 窗口激活/失焦可见性 | 官方要求：至少在失焦时改变标题栏文字/图标/按钮颜色 | `[LRN:titlebar-md]`「Do make it obvious when your window is active or inactive. At minimum, change the color of the text, icons, and buttons in your title bar.」 |
| Mica 必须延伸到标题栏 | 自定义标题栏 + `Window.SystemBackdrop`，让 Mica 在标题栏区域可见 | `[LRN:mica]`「To give your app's window a seamless look, Mica should be visible in the title bar if you choose to apply the material to your app. You can show Mica in the title bar by extending your app into the non-client area and creating a transparent custom title bar.」 |

### 2.3 响应式断点与窗口最小尺寸

**断点来源 = `NavigationView` 官方自适应行为**（不要另造一套 `@media` 式断点）：

| 窗口宽（epx） | `NavigationViewDisplayMode` | 左功能栏表现 | 出处 |
|---|---|---|---|
| ≥ 1008 | `Expanded` | 展开左栏（图标 + 文字） | `[LRN:navview]`「An expanded left pane on large window widths (1008px or greater).」；枚举 `[API:controls/dev/NavigationView/NavigationView.idl]` `NavigationViewDisplayMode { Minimal, Compact, Expanded }` |
| 641 – 1007 | `Compact` | 仅图标（`LeftCompact`） | `[LRN:navview]`「A left, icon-only, nav pane (`LeftCompact`) on medium window widths (641px to 1007px).」 |
| ≤ 640 | `Minimal` | 只剩菜单按钮（`LeftMinimal`），内容边距切 12 epx | `[LRN:navview]`「Only a menu button (`LeftMinimal`) on small window widths (640px or less).」 |

- 断点值即 `CompactModeThresholdWidth`（默认 640）与 `ExpandedModeThresholdWidth`（默认 1008）。`[LRN:navview]`「Here, it's changed from the default of 640 to 1007.」
- **本项目的断点就是这两个默认值，不改。** `⚠️ 自定`（不改动本身是决策）
- 若某页需要"窄窗口换布局"（如 P1 卡片列数），用 `AdaptiveTrigger.MinWindowWidth`，其语义是"窗口宽于该值时触发"。`[LRN:navview]`「When you use `AdaptiveTrigger.MinWindowWidth`, the visual state is triggered when the window is wider than the specified minimum width.」

**窗口最小尺寸**

| 项 | 值 | 依据 |
|---|---|---|
| 初始尺寸 | 1280 × 840 | `⚠️ 自定`（沿用既有产品尺寸，非设计依据） |
| 最小尺寸 | **1024 × 720** | 推导：≥ 1008 才进入 `Expanded` 左栏（`[LRN:navview]`），故最小宽度取 1024 可保证左栏始终展开、内容区不被压迫；`⚠️ 自定`（1024/720 这两个具体数值是本项目约定） |
| 实现方式 | `AppWindow.Presenter` 为 `OverlappedPresenter` 时设 `PreferredMinimumWidth` / `PreferredMinimumHeight` | `[API:Microsoft.UI.Windowing.OverlappedPresenter.PreferredMinimumWidth]`（官方 Windows App SDK API 页存在）。**风险**：microsoft-ui-xaml issue #10475 记录了 `OverlappedPresenter.Preferred***` 的已知问题，实现后必须实测「拖拽缩到最小 / 最大化再还原 / Snap 布局」三种路径 |

### 2.4 布局禁止事项

| 禁止 | 原因 | 出处 |
|---|---|---|
| 把 `ListView` / `GridView`（或任何虚拟化列表）放进 `StackPanel` | 会**彻底关闭**虚拟化（`StackPanel` 在堆叠方向用无限可用尺寸测量），是官方点名的性能陷阱 | `[MUX:docs/design-notes/ListView-GridView-overview.md]`「Placing a ListView/GridView into a StackPanel turns off its potential virtualization, since the StackPanel uses an infinite available size for its stacking direction. It's a recurring performance trap for our customers.」 |
| 调 `UIElement.UpdateLayout()` | 会引发布局循环 | `[MUX:docs/design-notes/Layout-overview.md]`「Avoid the use of `UIElement.UpdateLayout` as it can lead to layout cycles.」 |
| 在布局过程（measure/arrange）里改布局特征 | 同样引发布局循环 | 同上「Avoid changing layout characteristics within a layout pass as this can lead to layout cycles as well.」 |
| 深层嵌套导致布局深度 > 250 | 官方硬上限 `MaxLayoutDepth = 250`，超出返回 `E_FAIL` | 同上「The depth of those measure calls, `CLayoutManager::m_cMeasuresOnStack`, cannot exceed `MaxLayoutDepth = 250` or an E_FAIL error is returned.」 |
| 依赖 `FrameworkElement.LayoutTransform` | WinUI **没有**这个属性（WPF 才有） | 同上「The `FrameworkElement.LayoutTransform` property, which is available in WPF, does not exist in WinUI.」 |

---

## 3. 配色与主题

### 3.1 三套主题字典与选择顺序

- WinUI 支持 3 个主题：`Light`、`Dark`、`HighContrast`。`[LRN:theme-resources]`「There are 3 themes that the XAML framework supports: "Light", "Dark", and "HighContrast".」
- **自建字典时显式使用 `Light` / `Dark` / `HighContrast` 三个键**，不要用 `Default` 兜底。`[LRN:theme-resources]`「it's preferred to be explicit and instead use "Light", "Dark", and "HighContrast".」
- 运行时只会在 `ThemeDictionaries` 里选出**一个**字典，顺序为：高对比模式 → `HighContrastWhite`/`HighContrastBlack`（依主题）→ `HighContrast` → `Light`/`Dark`（依主题设置）→ `Default`。`[MUX:docs/design-notes/resources.md]`「If the system is in high contrast mode: The dictionary with key HighContrastWhite or HighContrastBlack is used… If in low contrast, or the above didn't find a dictionary yet, the dictionary with key HighContrast is used. If nothing found yet, the dictionary with key Light or Dark, based on theme settings, is used. If nothing found yet, the dictionary with key Default is used.」
- 资源解析：`{StaticResource}` 与 `{ThemeResource}` 查找算法相同，但 `{ThemeResource}` 会在主题变化时重新求值。`[MUX:docs/design-notes/resources.md]`「Once a matching key is found, the search stops… MergedDictionary search starts with the last merged dictionary」；`[MUX:docs/design-notes/xaml-styling-guide.md]`「`ThemeResource` allows for brushes to be re-evaluated in xaml, while `StaticResource` is evaluated once OnApplyTemplate only.」

**硬性规则**：画刷一律 `{ThemeResource}`；**只有**主题无关资源（如 `SymbolThemeFontFamily` 这类字族）才用 `{StaticResource}`。`[LRN:theme-resources]`「Use the `{StaticResource}` markup extension to reference resources that are agnostic to the app theme in your `ThemeDictionaries`.」

### 3.2 层级与笔刷映射（本项目的唯一取色表）

> 所有键名均在 `[MUX:controls/dev/CommonStyles/Common_themeresources_any.xaml]` 中实读确认，并给出 `Default`（深色）与 `Light` 两套值作为回归基准。

| 用途 | 键名（`…Brush`） | Dark 值 | Light 值 | HighContrast 取值 | 出处 |
|---|---|---|---|---|---|
| 主要文字 | `TextFillColorPrimaryBrush` | `#FFFFFF` | `#E4000000` | `SystemColorWindowTextColor` | `[KEY:Common_themeresources_any.xaml]`（L5/L209/L416） |
| 次要文字（说明、副标题） | `TextFillColorSecondaryBrush` | `#C5FFFFFF` | `#9E000000` | `SystemColorWindowTextColor` | 同上（L6/L210/L417） |
| 三级文字（占位、元信息） | `TextFillColorTertiaryBrush` | `#87FFFFFF` | `#72000000` | `SystemColorWindowTextColor` | 同上（L7/L211/L418） |
| 禁用文字 | `TextFillColorDisabledBrush` | `#5DFFFFFF` | `#5C000000` | `SystemColorGrayTextColor` | 同上（L8/L212/L419） |
| 反色文字（在实色底上） | `TextFillColorInverseBrush` | `#E4000000` | `#FFFFFF` | `SystemColorWindowTextColor` | 同上（L9/L213/L420） |
| 强调色上的文字 | `TextOnAccentFillColorPrimaryBrush` | `#000000` | `#FFFFFF` | `SystemColorWindowTextColor` | 同上（L12/L216/L426） |
| 控件底（默认/常态） | `ControlFillColorDefaultBrush` | `#0FFFFFFF` | `#B3FFFFFF` | `SystemColorButtonFaceColor` | 同上（L15/L219/L429） |
| 控件底（悬停） | `ControlFillColorSecondaryBrush` | `#15FFFFFF` | `#80F9F9F9` | `SystemColorButtonFaceColor` | 同上（L16/L220/L430） |
| 控件底（按下） | `ControlFillColorTertiaryBrush` | `#08FFFFFF` | `#4DF9F9F9` | `SystemColorButtonFaceColor` | 同上（L17/L221/L431） |
| 文本输入框激活底 | `ControlFillColorInputActiveBrush` | `#B31E1E1E` | `#FFFFFF` | — | 同上（L21/L225） |
| 控件底（禁用） | `ControlFillColorDisabledBrush` | `#0BFFFFFF` | `#4DF9F9F9` | `SystemColorButtonFaceColor` | 同上（L19/L223/L433） |
| 列表/导航项悬停底 | `SubtleFillColorSecondaryBrush` | `#0FFFFFFF` | `#09000000` | — | 同上（L26/L230） |
| 列表/导航项按下底 | `SubtleFillColorTertiaryBrush` | `#0AFFFFFF` | `#06000000` | — | 同上（L27/L231） |
| 强调主色填充 | `AccentFillColorDefaultBrush` | `SystemAccentColorLight2` | `SystemAccentColorDark1` | — | 同上（L125/L329） |
| 强调次/三级 | `AccentFillColorSecondaryBrush` / `…TertiaryBrush` | 同上 + `Opacity 0.9 / 0.8` | 同 | — | 同上（L126-L127 / L330-L331） |
| 强调色文字（链接式） | `AccentTextFillColorPrimaryBrush` | `SystemAccentColorDark2` | 同 | — | `[MUX:docs/design-notes/xaml-styling-guide.md]`「`<SolidColorBrush x:Key="AccentTextFillColorPrimaryBrush" Color="{ThemeResource SystemAccentColorDark2}" />`」 |
| 控件描边（默认） | `ControlStrokeColorDefaultBrush` | `#12FFFFFF` | `#0F000000` | — | 同上（L39/L129/L243/L333） |
| 控件描边（次，用于提升描边渐变） | `ControlStrokeColorSecondaryBrush` | `#18FFFFFF` | `#29000000` | — | 同上（L40/L130/L244/L334） |
| 强调色上的描边 | `ControlStrokeColorOnAccentDefaultBrush` / `…SecondaryBrush` | `#14FFFFFF` / `#23000000` | `#14FFFFFF` / `#66000000` | — | 同上（L41-L42/L131-L132） |
| 分隔线 | `DividerStrokeColorDefaultBrush` | `#15FFFFFF` | `#0F000000` | — | 同上（L53/L143/L257/L347） |
| 焦点描边（外） | `FocusStrokeColorOuterBrush` | `#FFFFFF` | `#E4000000` | — | 同上（L54/L144/L258/L348） |
| 焦点描边（内） | `FocusStrokeColorInnerBrush` | `#B3000000` | `#B3FFFFFF` | — | 同上（L55/L145/L259/L349） |
| **卡片背景（P1 实例卡）** | `CardBackgroundFillColorDefaultBrush` | `#0DFFFFFF` | `#B3FFFFFF` | — | 同上（L56/L146/L260/L350） |
| 卡片背景（次级/嵌套） | `CardBackgroundFillColorSecondaryBrush` / `…TertiaryBrush` | `#08FFFFFF` / `#12FFFFFF` | `#80F6F6F6` / `#FFFFFF` | — | 同上（L57-L58/L147-L148） |
| **模态遮罩** | `SmokeFillColorDefaultBrush` | `#4D000000` | `#4D000000` | — | 同上（L59/L149） |
| **内容层底板（Mica 之上）** | `LayerFillColorDefaultBrush` | `#4C3A3A3A` | `#80FFFFFF` | — | 同上（L60/L150）；用法见 `[LRN:mica]`（见 §3.3） |
| 备选层底板 | `LayerFillColorAltBrush` | `#0DFFFFFF` | `#FFFFFF` | — | 同上（L61/L151） |
| 实色兜底底（Mica 的降级色） | `SolidBackgroundFillColorBaseBrush` | `#202020` | `#F3F3F3` | — | 同上（L68/L158/L272/L362）；语义出处 `[LRN:mica]` |
| Mica Alt 的降级色 | `SolidBackgroundFillColorBaseAltBrush` | `#0A0A0A` | `#DADADA` | — | 同上（L75/L164/L279/L368）；语义出处 `[LRN:mica]` |

### 3.3 层级（Layer / Elevation）与 Mica / Acrylic 使用准则

**两层体系（官方强制）**

| 层 | 内容 | 本项目落点 | 出处 |
|---|---|---|---|
| **Base 层** | 应用最底层，放菜单、命令、导航类控件 | Mica 背景 + `TitleBar` + `MenuBar` + `NavigationView` 的 pane | `[LRN:elevation]`「The base layer is an app's foundation. It is the bottommost layer of every app, and contains controls related to app menus, commands, and navigation.」 |
| **Content 层** | 聚焦应用中心体验；可为一整块或分割为卡片 | 页面内容区容器（`Grid`/`Frame`）用 `LayerFillColorDefaultBrush` 作背景 | `[LRN:elevation]`「The content layer focuses the user on the app's central experience. The content layer may be on contiguous element, or separated into cards that segment content.」 |

**Mica**

| 规格 | 内容 | 出处 |
|---|---|---|
| 用在哪 | 窗口 backdrop（长期存在的窗口底面）；标题栏区域也要能看见 | `[LRN:mica]`「Mica is an opaque, dynamic material that incorporates theme and desktop wallpaper to paint the background of long-lived windows」；「We recommend that you apply Mica or Mica Alt as the base layer of your app, and prioritize visibility in the title bar area.」 |
| 内容层怎么写 | 在 Mica 上加一层内容层，用 `LayerFillColorDefaultBrush`（低不透明度实色）；标准型铺满容器、卡片型切分卡片 | `[LRN:mica]`「The content layer should pick up the material behind it, Mica, using the `LayerFillColorDefaultBrush`, a low-opacity solid color, as its background.」 |
| 用 Mica 还是 Mica Alt | 本项目用 **Mica**（无标签页标题栏）；Mica Alt 用于标签页式标题栏，本项目不需要 | `[LRN:mica]`「Mica Alt is a variant of Mica, with stronger tinting… especially when creating an app with a tabbed title bar.」 |
| 版本与降级 | Mica Alt 需 WinAppSDK 1.1+ 且 Windows 11 22000+；Mica 本身在高对比模式下被系统背景色替换、在 5 种情形下降级为实色 | `[LRN:mica]`（§3.2 引用原文） |
| API | `Microsoft.UI.Xaml.Media.SystemBackdrop` 为基类，经 `Window`/`DesktopWindowXamlSource`/`Popup` 的 `SystemBackdrop` 属性挂载；Mica 与桌面 Acrylic 都走 Composition 的 `SystemBackdropController` | `[MUX:docs/design-notes/mica-desktop-acrylic.md]`「`Microsoft.UI.Xaml.Media.SystemBackdrop` is the base class for the Xaml exposure of Composition's `SystemBackdropController`」；「Attached to the tree via `Window`/`DesktopWindowXamlSource`/`Popup`'s `SystemBackdrop` property」 |

**Acrylic**

| 规格 | 内容 | 出处 |
|---|---|---|
| 只用于**瞬时**表面 | 右键菜单、`MenuFlyout`、非模态弹层、light-dismiss 面板 | `[LRN:acrylic]`「for transient UI elements. For apps with context menus, flyouts, non-modal popups, or light-dismiss panes, we recommend that you use background acrylic, especially if these surfaces draw outside the frame of the main app window.」 |
| 导航面上的 in-app acrylic | 本项目的日志抽屉、`NavigationView` 覆层 pane 属"in-app acrylic"场景 | `[LRN:acrylic]`「If you are using in-app acrylic on navigation surfaces, consider extending content beneath the acrylic pane to improve the flow in your app.」 |
| **禁止**把强调色文字压在 Acrylic 上 | 14px 默认字号下大概率过不了对比度 | `[LRN:acrylic]`「We don't recommend placing accent-colored text on your acrylic surfaces because these combinations are likely to not pass minimum contrast ratio requirements at the default 14px font size.」 |
| **禁止**把多块 Acrylic 边对边拼 | 会产生接缝条纹 | `[LRN:acrylic]`「to avoid creating a striping effect, try not to place multiple pieces of acrylic edge-to-edge - this can create an unwanted seam between the two blurred surfaces.」 |
| 高对比模式 | 自动变成用户选择的实色 | `[LRN:acrylic]`「In High Contrast mode, users continue to see the familiar background color of their choosing in place of acrylic.」 |
| WinUI 3 限制 | in-app Acrylic 可放在任意位置，但**桌面 Acrylic 只能挂在 `Window` / `DesktopWindowXamlSource` 上**，放低了会 no-op 或降级 | `[MUX:docs/design-notes/mica-desktop-acrylic.md]`「While in-app Acrylic can be applied anywhere in the tree (with the restriction of not being able to blur anything outside its own island), desktop Acrylic can only be applied to `Window` and `DesktopWindowXamlSource` objects.」 |

**本项目的 Mica/Acrylic 决策表**

| 表面 | 用 | 不用 |
|---|---|---|
| 窗口背景 | Mica（`SystemBackdrop`） | 自绘渐变 |
| 页面内容区 | `LayerFillColorDefaultBrush` 实色层 | Acrylic（会与卡片叠出条纹） |
| P1 实例卡片 | `CardBackgroundFillColorDefaultBrush` + `ControlStrokeColorDefaultBrush` 1px 描边 | Acrylic |
| `MenuBar` / `MenuFlyout` / `CommandBarFlyout` / `TeachingTip` | 默认样式（已含 Acrylic/阴影） | 手工改背景 |
| 右侧日志抽屉（Overlay） | 默认 `SplitView` pane（叠在内容上，属瞬时表面 → 可用 in-app Acrylic） | 强调色文字 |
| `ContentDialog` | 默认样式（`OverlayCornerRadius` + 遮罩 `SmokeFillColorDefaultBrush`） | 自改遮罩色 |

### 3.4 主题切换（含一个契约缺口）

- `ElementTheme.Default` = 跟随系统主题；`Light` / `Dark` = 强制。
- **⚠️ 契约缺口**：`src/shared/contracts.ts` 的 `LauncherConfig.theme` 类型为 `'dark' | 'light'`（`contracts.ts:414`），**没有"跟随系统"取值**。P8 全局设置若要提供官方推荐的三选一，必须先扩展契约（新增 `'system'`）——这属于**契约变更**，实现者须先报 Lead，不得单方面改 `contracts.ts`（该文件头部自述为冻结文件）。
- **在契约扩展前**：P8 只暴露"浅色 / 深色"两项，`ElementTheme` 直接取 `Light`/`Dark`；不得把 `Default` 映射成"浅色"来糊弄（那会让跟随系统的用户看到错误主题）。`⚠️ 自定`

---

## 4. 字体与排版

### 4.1 字族

| 项 | 值 | 出处 |
|---|---|---|
| UI 正文字族 | **Segoe UI Variable**（系统字体，XAML 控件默认选中） | `[LRN:typography]`「Segoe UI Variable is the new system font for Windows.」；「When using XAML common controls, the Segoe UI Variable font will be selected by default for supported languages.」 |
| XAML 侧的引用方式 | 引用 `ContentControlThemeFontFamily`（其值为 `XamlAutoFontFamily`），**不要**硬编码 `"Segoe UI Variable"` 字符串 | `[KEY:generic.xaml]` L14 `<FontFamily x:Key="ContentControlThemeFontFamily">XamlAutoFontFamily</FontFamily>`（`Default`/`Light`/`HighContrast` 三份，L2796、L3939） |
| 图标字族 | `SymbolThemeFontFamily`（= `Segoe Fluent Icons,Segoe MDL2 Assets`），配合 `FontIcon` 使用 | `[KEY:generic.xaml]` L20 / L2802 / L3945 |
| 等宽字族（YAML 编辑器、日志） | **`Cascadia Mono`**，回退 `Consolas` | `Consolas` 是官方认可的系统等宽字体 `[LRN:typography]`「Consolas … Fixed width font that supports European scripts」；`Cascadia Mono` 官方清单未列出 → **`⚠️ 自定`（回退链 `Cascadia Mono, Consolas, monospace` 为本项目约定）** |
| 字重取值范围 | Light 300 / Semilight 350 / Regular 400 / Semibold 600 / Bold 700（variable 字体的 wght 轴） | `[LRN:typography]` 字重表 |

### 4.2 字阶全集（内置 `TextBlock` 样式）与场景映射

以下 9 个样式定义为内核为准（`[MUX:controls/dev/CommonStyles/TextBlock_themeresources.xaml]`），字号数值亦有官方表格佐证（`[LRN:theme-resources]`、`[LRN:typography]`）：

| 样式键 | FontSize | FontWeight | 行高（官方） | 本项目使用场景 | 出处 |
|---|---|---|---|---|---|
| `CaptionTextBlockStyle` | 12 | Normal | 16 epx | 卡片元信息、日志行数统计、时间戳、次要说明 | `[KEY:TextBlock_themeresources.xaml]` L19-L22；`[LRN:typography]`「Small 12/16 epx」 |
| `BodyTextBlockStyle` | 14 | Normal | 20 epx | **默认正文**：设置项说明、列表项副文本、表单标签 | 同上 L23-L25；`[LRN:typography]`「Text 14/20 epx」 |
| `BodyStrongTextBlockStyle` | 14 | SemiBold | 20 epx | 列表项主文本强调、字段名 | 同上 L26（`BasedOn` `BaseTextBlockStyle`，其 `FontWeight` 已是 SemiBold L13）；`[LRN:typography]`「Text semibold 14/20 epx」 |
| `BodyLargeTextBlockStyle` | 18 | Normal | 24 epx | 卡片标题、对话框正文 | 同上 L27-L31；`[LRN:typography]`「Text 18/24 epx」 |
| `BodyLargeStrongTextBlockStyle` | 18 | SemiBold | 24 epx | 卡片主标题、空态标题 | 同上 L32-L35；`[LRN:typography]`「Text semibold 18/24 epx」；`[LRN:theme-resources]`「Body Large Strong / Semibold / 18」 |
| `SubtitleTextBlockStyle` | 20 | SemiBold | 28 epx | 页面内分节标题 | 同上 L36-L39；`[LRN:typography]`「Display semibold 20/28 epx」 |
| `TitleTextBlockStyle` | 28 | SemiBold | 36 epx | **页面主标题**（每页最多一个） | 同上 L40-L43；`[LRN:typography]`「Display semibold 28/36 epx」 |
| `TitleLargeTextBlockStyle` | 40 | SemiBold | 52 epx | 向导欢迎区、空态大标题 | 同上 L44-L47；`[LRN:typography]`「Display semibold 40/52 epx」 |
| `DisplayTextBlockStyle` | 68 | SemiBold | 92 epx | **本项目不使用**（启动器没有 hero 级场景） | 同上 L48-L51；`⚠️ 自定`（不使用是决策） |
| `BaseRichTextBlockStyle` / `BodyRichTextBlockStyle` | 14 | SemiBold / Normal | — | 需要同一段里混排样式的场景（如错误消息 + 链接） | `[KEY:generic.xaml]` L13286-L13298 |

**⚠️ 已发现的版本差异（实现者必读）**：`generic.xaml`（系统 XAML 的 framework styles）里另有一份 `TitleTextBlockStyle`，字号为 **24**、`TextTrimming="None"`（`[MUX:dxaml/xcp/dxaml/themes/generic.xaml]` L13268-L13271），而 MUXC 的 `TextBlock_themeresources.xaml` 版本为 **28**、`TextTrimming="CharacterEllipsis"`。按官方查找顺序，`CControl` 先查 `generic.xaml`，但**不停留**，会继续向 `Application.Resources` / MUXC 查覆盖并采用后者 → **采用 28**。`[MUX:docs/design-notes/styles.md]`「CControl's search goes to FrameworkStyles, which first includes the "global theme resources", MUX's generic.xaml. If a hit is found we _do not stop_ there. We search all of Application.Resources for an override… which will come back to MUXC and find another hit.」若实测发现标题实际渲染为 24，按此条复核资源加载顺序，不要改字号硬编码。

### 4.3 排版规则（硬性）

| 规则 | 内容 | 出处 |
|---|---|---|
| **最小字号** | 正文最小 14 epx Semibold / 12 epx Regular；**任何文字不得小于 12 epx** | `[LRN:typography]`「Minimum values: 14px Semibold, 12px Regular … Text smaller than these sizes and weights are illegible in some languages」 |
| **只用 Regular / Semibold** | 绝大多数文字 Regular，标题 Semibold；**字阶里没有 Bold 与 Italic**，强调用 Semibold | `[LRN:typography]`「Bold and Italic styles are not part of the Windows type ramp. Use Semibold instead of Bold for emphasis.」 |
| **句首大写** | 所有 UI 文案（含标题）使用句子式大小写 | `[LRN:typography]`「Sentence case: Use sentence casing for all UI text, including titles」（中文界面沿用现有中文文案，不涉及大小写） |
| **默认左对齐** | `TextAlignment` 默认 `Left`；中心对齐仅用于图标下方文字等少数场景 | `[LRN:typography]`「The default `TextAlignment` is Left, and in most instances, flush-left and ragged right provides consistent anchoring…」 |
| **行长** | 每行 50–60 字符为宜，不得少于 20 或超过 60 | `[LRN:typography]`「Keep to 50–60 letters per line… Don't use fewer than 20 characters or more than 60 characters per line」 |
| **截断** | 单行超出用省略号；多行可换行则裁剪。推荐写法 `<TextBlock TextWrapping="WrapWholeWords" TextTrimming="Clip"/>` | `[LRN:typography]`（含该 XAML 示例）；内核默认 `TextTrimming="CharacterEllipsis"` 见 `[KEY:TextBlock_themeresources.xaml]` L14 |
| **路径/版本号不断的处理** | 长路径文本用 `TextTrimming="CharacterEllipsis"` + `ToolTipService.ToolTip` 提供全文；**不**用横向滚动容器包文字 | `⚠️ 自定`（工具提示与省略号的组合是本项目约定） |

---

## 5. 间距、圆角、描边、阴影

### 5.1 圆角

| 资源键 | 值 | 用于 | 出处 |
|---|---|---|---|
| `ControlCornerRadius` | `4,4,4,4` | 页面内常驻元素：`Button`、`CheckBox`、`ComboBox`、`TextBox`、`ListView` 项背板、`ProgressBar`、`ScrollBar`、`ToolTip`（小尺寸例外，仍为 4） | `[KEY:controls/dev/CommonStyles/CornerRadius_themeresources.xaml]` L5（三套主题字典同值 L9、L13）；语义 `[LRN:rounded-corner]`「4px: In-page elements such as buttons and list backplates are rounded using a 4px corner radius.」 |
| `OverlayCornerRadius` | `8,8,8,8` | 顶层容器与瞬态元素：窗口、`ContentDialog`、`Flyout`、`MenuFlyout`、`TeachingTip` | 同上 L6；语义 `[LRN:rounded-corner]`「8px: Top-level containers such as app windows, flyouts and dialogs are rounded using an 8px corner radius.」 |
| `0` | 直边相交处不圆角；窗口贴靠/最大化时不圆角 | 相邻拼接控件（如 `SplitButton` 两半） | `[LRN:rounded-corner]`「Straight edges that intersect with other straight edges are not rounded.」「Window corners are not rounded when windows are snapped or maximized.」 |

**规则**：不逐个控件写 `CornerRadius`；要改全局圆角只改 `App.xaml` 里的 `ControlCornerRadius` / `OverlayCornerRadius` 覆盖。`[LRN:rounded-corner]`「The default corner radii are controlled by two global resources: `ControlCornerRadius` (default 4px) and `OverlayCornerRadius` (default 8px). You can override these values in your App.xaml to change the rounding across all controls in your app.」

### 5.2 描边与提升（Elevation）

| 资源键 | 形态 | 用途 | 出处 |
|---|---|---|---|
| `ControlStrokeColorDefaultBrush` | 实色 | 卡片、输入框、列表项默认描边（1 px） | `[KEY:Common_themeresources_any.xaml]` L39/L129 |
| `DividerStrokeColorDefaultBrush` | 实色 | 分区分隔线 | 同上 L53/L143 |
| `ControlElevationBorderBrush` | `LinearGradientBrush`（`MappingMode="Absolute"`，`StartPoint="0,0"` → `EndPoint="0,3"`，`ScaleTransform ScaleY="-1"`；渐变为 `ControlStrokeColorSecondary`(0.33) → `ControlStrokeColorDefault`(1.0)） | 默认按钮的"投影感"描边 | `[MUX:docs/design-notes/xaml-styling-guide.md]`（Elevation Border Brushes 段，含完整 XAML） |
| `AccentControlElevationBorderBrush` | 同上，用 `ControlStrokeColorOnAccentSecondary` → `ControlStrokeColorOnAccentDefault` | 强调色按钮 | 同上 |
| `CircleElevationBorderBrush` | `LinearGradientBrush`（`RelativeToBoundingBox`，`0,0`→`0,1`；`ControlStrokeColorDefault`(0.50) → `ControlStrokeColorSecondary`(0.70)） | 圆形控件：`RadioButton`、`ToggleSwitch` | 同上 |
| 高对比下的提升描边 | 上述三者均映射为 `{ThemeResource SystemColorWindowTextColor}` 实色 | — | 同上（`HighContrast` 段） |

### 5.3 高度（Elevation）数值表

Windows 11 用「阴影 + 轮廓」共同表达高度，官方给出的数值：

| 表面 | Elevation 值 | 描边宽 | 本项目落点 |
|---|---|---|---|
| Window | 128 | 1 | 主窗口（由系统提供） |
| Dialog | 128 | 1 | `ContentDialog` |
| Flyout | 32 | 1 | `MenuFlyout`、`CommandBarFlyout`、`TeachingTip` |
| Tooltip | 16 | 1 | `ToolTip` |
| **Card** | 8 | 1 | P1 实例卡片 |
| Control | 2 | 1 | `Button`、`TextBox` 等 |
| Layer | 1 | 1 | 内容层容器 |

状态差异：`Rest` = 2、`Hover` = 2、`Pressed` = 1（描边宽恒为 1）。出处：`[LRN:elevation]`（Elevation / Controls 两段表）。

**规则**：不要自己给普通控件加 `ThemeShadow`。`[LRN:elevation]`「Standard controls like flyouts, dialogs, and tooltips already include appropriate shadows based on their elevation values. Using shadows purposefully — rather than decoratively — ensures they remain an effective signal.」实现阴影用 `ThemeShadow` / `DropShadow`（官方指引）。

### 5.4 关键控件尺寸（内置键与官方数值）

| 项 | 值 | 出处 |
|---|---|---|
| `ContentDialog` 最小/最大宽、最大高 | 320 / 548 / 756 | `[KEY:generic.xaml]` L38-L41 `ContentDialogMinWidth`=320、`ContentDialogMaxWidth`=548、`ContentDialogMaxHeight`=756（三套主题字典同值） |
| `NavigationView` Header 固定高 | 52 px | `[LRN:navview]`「It has a fixed height of 52 px.」 |
| `NavigationView` 紧凑 pane 宽 | 由 `CompactPaneLength` 决定；`SplitView` 的默认关闭 pane 宽为 48 px | `[API:controls/dev/NavigationView/NavigationView.idl]` L197；`[LRN:splitview]`「The default closed pane width is 48px, which can be modified with `CompactPaneLength`.」 |
| `ProgressRing` 最小尺寸 | **20 × 20 epx**；必须**同时**设 `Height` 与 `Width`，否则按最小值处理；必须设 `IsActive="True"` 才可见并动画 | `[LRN:progress-controls]`「The ProgressRing can be sized as large as you want, but can only be as small as 20x20epx… To make your ProgressRing visible, and animate, you must set the `IsActive` property to true」 |
| 标题栏高（展开/紧凑） | 48 / 32 | `[KEY:TitleBar_themeresources.xaml（经 MUX:docs/design-notes/xaml-styling-guide.md 摘录）]` |
| 图标尺寸 | 16 / 20 / 24 / 32 epx；图标实现用 `FontIcon` + `SymbolThemeFontFamily`，或需要可换图标时用 `IconSource` 类型族（`controls/dev/IconSource/`、`controls/dev/ImageIcon/`） | `⚠️ 自定`（尺寸档位）；`SymbolThemeFontFamily` 见 §4.1 |

---

## 6. 控件用法规范

> 格式：**需求 → 用哪个官方控件 → 何时用 → 禁止怎么用 → 出处**。
> 凡标 `⛔` 者为**禁止使用**（预览版 API 或官方明确不适用）。

### 6.1 外壳与导航

| 需求 | 官方控件 | 何时用 | 禁止 | 出处 |
|---|---|---|---|---|
| 左侧功能栏 + 页面导航 | `NavigationView` | 主窗口唯一的全局导航；`PaneDisplayMode` 保持默认 `Auto` 以得到官方三段自适应 | 不叠第二个 `NavigationView`；不用它承载页面内页签（那是 `SelectorBar`/`TabView` 的职责） | `[API:controls/dev/NavigationView/NavigationView.idl]` L24-L31（`Auto/Left/Top/LeftCompact/LeftMinimal`）、L178/L181（两个阈值）；`[LRN:navview]`；`[LRN:splitview]`「If you'd like to build a navigation menu… use the NavigationView control.」 |
| 左栏是**静态功能列表** | `NavigationView.MenuItems` / `FooterMenuItems` 里直接声明 `NavigationViewItem`（`FontIcon` 16 px 字形 + 文字，`Tag` 即路由键，并设 `AutomationProperties.Name`） | 左栏只做功能导航（实例 / 引擎版本管理 / 全局设置，底部「关于」）；**实例列表只保留在「实例」页内**（同一批数据不在屏幕上出现两次） | 不使用 `MenuItemsSource` / `MenuItemTemplate`：左栏是固定四项、没有动态集合，而"模板 + 数据对象"正是历史上画出"空头像框 + 假『新建实例』"垃圾行的成因 | `[API:controls/dev/NavigationView/NavigationView.idl]` L204 `Object MenuItemsSource`、L183/L190 `FooterMenuItems`；交接文档 §6.1 / §6.3 |
| 左栏底部固定「关于」 | `NavigationView.FooterMenuItems` + `IsSettingsVisible="False"` | 需要一个固定在 pane 底部的入口，且它是**可导航页面**（因此有正确的选中态） | 不用内置 Settings 项（标签固定为"设置"，无法表达中文标签与顺序）；不要把"点了只弹对话框"的项放进 `FooterMenuItems`（会留下一个语义错误的选中高亮） | `[API:controls/dev/NavigationView/NavigationView.idl]` L183、L190；`[LRN:titlebar-md]` 官方示例 `IsSettingsVisible="False"` |
| 右侧日志抽屉 | `SplitView`（`PanePlacement="Right"`、`DisplayMode="Overlay"`、`OpenPaneLength="480"`） | 需要"抽屉"式补充面板 | 不用 `NavigationView` 做抽屉；不用 `DisplayMode="Inline"`（会把内容区挤窄，日志是辅助信息） | `[LRN:splitview]`（四种模式定义、支持左右两侧）；`[KEY:generic.xaml]` L15008 `<Style TargetType="SplitView">` 确认默认样式存在 |
| 返回上一级 | `TitleBar.IsBackButtonVisible` + `BackRequested` 事件 | 详情页（P2–P5）显示返回；P1/P6/P7/P8 隐藏 | 不在页面内自绘返回按钮到内容区左上角（与系统返回位置不一致） | `[API:controls/dev/TitleBar/TitleBar.idl]` L23/L33；`[LRN:titlebar-md]`「Do define a drag region along the top edge of the app canvas. Matching the placement of system title bars makes it easier for users to find.」 |
| 左栏折叠按钮 | `TitleBar.IsPaneToggleButtonVisible` + `PaneToggleRequested` | 需要把 pane 折叠按钮放进标题栏时 | 不要同时用 `NavigationView` 自带汉堡按钮造成两个入口 | `[API:controls/dev/TitleBar/TitleBar.idl]` L29/L34 |
| 窗口标题栏 | `Microsoft.UI.Xaml.Controls.TitleBar` + `Window.ExtendsContentIntoTitleBar = true` | 需要把菜单折进标题栏 | `ExtendsContentIntoTitleBar` **必须在代码里设**（写在 XAML 会报错）；`PreferredHeightOption` 必须在 `ExtendsContentIntoTitleBar == true` 之后设，否则抛异常 | `[LRN:titlebar-md]`「`ExtendsContentIntoTitleBar` shows in the XAML IntelliSense for `Window`, but setting it in XAML causes an error. Set this property in code instead.」「`AppWindowTitleBar.ExtendsContentIntoTitleBar` property must be `true` before you set the `PreferredHeightOption` property. If you attempt to set `PreferredHeightOption` while `ExtendsContentIntoTitleBar` is `false`, an exception is thrown.」 |

### 6.2 集合与数据展示

| 需求 | 官方控件 | 何时用 | 禁止 | 出处 |
|---|---|---|---|---|
| P1 实例卡片网格 | **`GridView`**（`ItemsWrapGrid`）或 `ListView`（列表形态） | 需要 header/footer、分组、粘性组头、增量加载、拖放、边缘滚动、项回收 | 见下条 | `[MUX:docs/design-notes/ListView-GridView-overview.md]`（能力清单 L380-L412） |
| P1/P2/P4/P6 的列表 | `ListView` / `GridView` | 同上 | ⛔ 不用 `ItemsView` 承载这些列表：官方明确 `ItemsView` **没有** grouping / 粘性组头 / `ISupportIncrementalLoading` / `ICollectionView` / header+footer / 边缘滚动 / 拖放 | `[MUX:docs/design-notes/ItemsView-ItemContainer-overview.md]`「the ItemsView is new, it has no built-in support for: grouping, sticky group headers, progressive data consumption through the ISupportIncrementalLoading, ICollectionView data sources, header and footer, edge-scrolling, drag & drop」 |
| 何时才用 `ItemsView` | `ItemsView`（`ItemsViewSelectionMode { None, Single, Multiple, Extended }`） | 需要流式布局（`LinedFlowLayout`）、可插拔 `Layout`、可插拔滚动控制器、自定义回收池、平滑控制滚动曲线/缩放 | 不要为了"新"而用；本项目当前页面需求不需要上述任一项 | `[API:controls/dev/ItemsView/ItemsView.idl]` L6-L12、L32-L72；`[MUX:docs/design-notes/ItemsView-ItemContainer-overview.md]`（ListView 缺 flow layouts / pluggable layouts / pluggable scrolling controllers / custom recycling pools；ItemsView 缺 header/footer/增量加载） |
| 需要完全自定义渲染的大列表（P5 日志、P2 依赖表） | `ItemsRepeater` + `StackLayout`/`UniformGridLayout`（放进 `ScrollView`/`ScrollViewer`） | 需要虚拟化布局 + 自定义模板，且不需要选择/多选/拖放等 `ListView` 能力 | ⛔ 不用 `RecyclePool`、`ItemsRepeaterScrollHost`、`LinedFlowLayout*`、`UniformGridLayoutState`、`StackLayoutState`、`FlowLayout*`、`SelectTemplateEventArgs` 等 `[MUX_PREVIEW]` 类型 | `[API:controls/dev/Repeater/ItemsRepeater.idl]`（`RecyclingElementFactory`/`RecyclePool`/`LinedFlowLayout`/`FlowLayout`/`UniformGridLayoutState`/`StackLayoutState`/`ItemsRepeaterScrollHost`/`SelectTemplateEventArgs` 标 `[MUX_PREVIEW]`；`ItemsRepeater`/`UniformGridLayout`/`StackLayout`/`Layout`/`VirtualizingLayout` 标 `[MUX_PUBLIC]`） |
| 表格化展示（引擎版本列表、插件依赖表） | **`ListView` + 行内 `Grid` `DataTemplate`**（表头用独立 `Grid` 行） | 列数固定、行数多、需要虚拟化 | ⛔ **不用 `TableView`**：`TableView` 及全部成员（`TableViewColumn`/`TableViewTextColumn`/`TableViewRow`/`TableViewDensity`…）在当前 main 上标 `[MUX_PREVIEW]`，属预览 API | `[API:controls/dev/TableView/TableView.idl]`（L5-L96、L241-L445、L615-L674 全为 `[MUX_PREVIEW]`） |
| 分页 | `⚠️ 自定`：用 `Button` + 页码状态自绘，或改用虚拟化 + `AnnotatedScrollBar` | 仅当必须"页码"语义时 | ⛔ **不用 `PagerControl`**：其全部成员标 `[MUX_PREVIEW]` | `[API:controls/dev/PagerControl/PagerControl.idl]`（L3-L45 全为 `[MUX_PREVIEW]`） |
| 卡片内的自动换行流式排布 | `ItemsWrapGrid`（`GridView` 内置）或 `ItemsRepeater` + `UniformGridLayout` | 需要"每行放 N 个卡片、随宽度变化" | ⛔ **不用 `WrapPanel`**：`WrapPanel` 与 `WrapPanelItemsStretch` 标 `[MUX_PREVIEW]` | `[API:controls/dev/WrapPanel/WrapPanel.idl]`（L4、L12 为 `[MUX_PREVIEW]`）；替代能力见 `[API:controls/dev/Repeater/ItemsRepeater.idl]` `UniformGridLayout`（`MinItemWidth`/`MinItemHeight`/`MinRowSpacing`/`MinColumnSpacing`/`MaximumRowsOrColumns`/`ItemsJustification`/`ItemsStretch`） |
| 层级数据（插件依赖树 / 实例下的插件分类） | `TreeView`（`TreeViewNode` / `RootNodes` / `SelectionMode`=`TreeViewSelectionMode`） | 有真实父子层级且需要展开/折叠 | 只有两层时不要上 `TreeView`；用 `ListView` 项内 `Expander` 更轻 | `[API:controls/dev/TreeView/TreeView.idl]` L6（`TreeViewSelectionMode`）、L26（`TreeViewNode`）、L109（`TreeView`，均 `[MUX_PUBLIC]`） |
| 可折叠分组 | `Expander`（`Header` / `IsExpanded` / `ExpandDirection`） | 需要"分组标题 + 可折叠内容"（P3 的隔离策略分组、P8 的高级项） | 不要用 `Expander` 做导航 | `[API:controls/dev/Expander/Expander.idl]` L15-L28（`[MUX_PUBLIC]`） |
| 面包屑（P2–P5 的"实例名 / 页名"） | `BreadcrumbBar`（`ItemsSource` / `ItemTemplate` / `ItemClicked`） | 层级 > 1 且需要一键跳回上级 | 只有一层时不要显示面包屑 | `[API:controls/dev/Breadcrumb/BreadcrumbBar.idl]` L23-L28（`[MUX_PUBLIC]`） |
| 计数徽标（引擎可用更新数、冲突数） | `InfoBadge`（含 `Value`） | 需要在导航项上挂数字/圆点 | 不要用它表达状态色语义（那是 `InfoBar` 的活） | `[API:controls/dev/InfoBadge/InfoBadge.idl]` L21-L26（`[MUX_PUBLIC_V3]`） |
| 长列表快速跳段（日志） | `AnnotatedScrollBar` 或 `ScrollView.VerticalScrollController` | 日志量大且需要"按时间/来源"跳段 | `ScrollView` 的 `[MUX_PREVIEW]` 成员不得使用 | `[API:controls/dev/AnnotatedScrollBar/AnnotatedScrollBar.idl]`（`[MUX_PUBLIC_V5]`）；`[API:controls/dev/ScrollView/ScrollView.idl]` L136/L138 标 `[MUX_PREVIEW]`（须避开） |

### 6.3 页签与分段

| 需求 | 官方控件 | 何时用 | 禁止 | 出处 |
|---|---|---|---|---|
| 实例详情的 4 个页签（插件/设置/存档/日志） | **`SelectorBar`**（`SelectorBarItem { Text, Icon }`） | 页签数量少（≤ 6）、只需"切换当前视图"、不需要关闭/新增/拖拽页签 | 不用它承载"可关闭的多工作区" | `[API:controls/dev/SelectorBar/SelectorBar.idl]` L15-L41（`SelectorBarItem` 继承 `ItemContainer`；`SelectedItem`；`SelectionChanged`；`[MUX_PUBLIC_V6]`） |
| 可关闭/可新增的页签（若未来引入） | `TabView`（`TabItems`、`TabWidthMode`、`CloseButtonOverlayMode`、`IsAddTabButtonVisible`、`CanReorderTabs`、`TabCloseRequested`） | 真的需要多文档/多工作区 | 本项目**当前不使用** `TabView`：4 个详情页签是固定集合，`TabView` 的关闭/拖出语义会造成数据丢失风险（切页即丢编辑态） | `[API:controls/dev/TabView/TabView.idl]` L101-L161；`⚠️ 自定`（不使用是决策） |
| 向导 4 步的步骤指示 | **`SelectorBar`**（`SelectorBarItem` 逐项对应 4 步，`IsEnabled` 控制可达性） | 步骤数固定、要显示"当前第几步" | ⛔ 无内置 Stepper/Wizard 控件；**不得**用 `TabView` 或 `Pivot` 冒充步骤指示 | `[API:controls/dev/SelectorBar/SelectorBar.idl]`；`controls/dev/CommonStyles/` 下存在 `Pivot_themeresources.xaml` 但本规范不使用；`⚠️ 自定`（"用 SelectorBar 表达步骤"是本项目选定方案，官方无向导控件） |
| 主题/过滤的"分段选择"（P1 状态筛选） | `SelectorBar` 或 `RadioButtons`（横向） | 2–5 个互斥选项且要常驻可见 | 选项 > 5 时改用 `ComboBox` | `[API:controls/dev/RadioButtons/RadioButtons.idl]` L9-L27（`ItemsSource`/`ItemTemplate`/`SelectedIndex`/`SelectedItem`/`MaxColumns`/`Header`，`[MUX_PUBLIC]`） |

### 6.4 命令、菜单与浮层

| 需求 | 官方控件 | 何时用 | 禁止 | 出处 |
|---|---|---|---|---|
| 应用菜单（23 项，唯一事实源在 Node 侧） | `MenuBar` + `MenuBarItem` + `MenuBarItemFlyout`，动态填充 `MenuFlyoutItem` / `ToggleMenuFlyoutItem` / `MenuFlyoutSeparator` | 菜单结构可能变化时；本项目由 `app.menu()` 返回的 `MenuNode[]` 动态构建 | 不在 XAML 里再静态写一份菜单（会造成"菜单显示 vs 真实绑定"漂移，这正是契约里 `MenuNode` 的注释要防的事） | `[API:controls/dev/MenuBar/MenuBar.idl]`（`MenuBarItemFlyout : MenuFlyout`、`MenuBarItem`、`MenuBar`，均 `[MUX_PUBLIC]`）；契约依据 `src/shared/contracts.ts:530-546`（`MenuNode` 含 `id/label/accelerator/kind/enabled/children`） |
| 命令栏 / 溢出命令 | `CommandBar` 或 `AppBarButton` | 页面主操作 > 3 个且需要溢出 | 页面主操作只有 1–2 个时直接放 `Button`，不要为好看上 `CommandBar` | `[MUX:docs/design-notes/control-overview.md]`（`CommandBar` 存在）；`⚠️ 自定`（阈值 3 为本项目约定） |
| 右键菜单（列表项、日志行） | **`CommandBarFlyout`**；文本上下文用 `TextCommandBarFlyout` | 需要"常用命令直接可见 + 次要命令溢出"的上下文菜单 | 不要在自定义控件里手撸 `Popup` 菜单 | `[API:controls/dev/CommandBarFlyout/CommandBarFlyout.idl]` L7、L22（`CommandBarFlyout : FlyoutBase`、`TextCommandBarFlyout`，`[MUX_PUBLIC]`） |
| 简单下拉菜单 | `MenuFlyout`（`MenuFlyoutItem` / `ToggleMenuFlyoutItem` / `MenuFlyoutSeparator` / `RadioMenuFlyoutItem`） | 纯命令列表，无主次之分 | 不用 `CommandBarFlyout` 承载 1 项菜单 | `[API:controls/dev/CommandBarFlyout/CommandBarFlyout.idl]`（`MenuFlyout` 为系统类型）；`[KEY:generic.xaml]` L23779 `DefaultMenuFlyoutPresenterStyle` 确认默认呈现器样式存在 |
| 模态对话框（删除确认、冲突解决、导入结果） | `ContentDialog` | 必须阻断用户直到明确选择时 | 同一窗口**同时只能开一个** `ContentDialog`（开第二个会抛异常）；必须设 `XamlRoot`，否则 `ShowAsync` 失败 | `[LRN:dialogs]`「There can only be one ContentDialog open per window at a time. Attempting to open two content dialogs will throw an exception.」「When you show a ContentDialog, you need to manually set the `XamlRoot` of the dialog to the root of the XAML host.」 |
| 对话框按钮角色与默认按钮 | `PrimaryButtonText` / `SecondaryButtonText` / `CloseButtonText` + `DefaultButton`（`ContentDialogButton { Primary, Secondary, Close }`）；返回 `ContentDialogResult { None, Primary, Secondary }` | 至少一个 `CloseButton` 兜底；2 个"执行"动作时用 `Primary`+`Secondary`；**三按钮对话框要少用** | 不要用 `alert/confirm` 式措辞（"确定/取消"）；按钮文案必须说明具体动作 | `[LRN:dialogs]`「Ensure that your dialog has at least one button corresponding to a safe, nondestructive action like "Got it!", "Close", or "Cancel". Use the CloseButton API」「Three button dialogs should be used sparingly」；Esc / Gamepad B / 系统返回都会走 CloseButton 并返回 `None` |
| 中断性提示条（引擎未安装、实例目录缺失、共享冲突） | `InfoBar`（`Severity` = `Informational`/`Success`/`Warning`/`Error`，`IsOpen`、`Title`、`Message`、`IsClosable`、`ActionButton`、`Content`） | 页面级状态说明；可带一个行动按钮 | 不用 `InfoBar` 做瞬时反馈（那是 Toast 的活，见 §6.6） | `[API:controls/dev/InfoBar/InfoBar.idl]` L14-L20（`InfoBarSeverity`）、L58-L101（`[MUX_PUBLIC]`；`InfoBarOpenedEventArgs` 为 `[MUX_PREVIEW]`，不得使用） |
| 首次使用引导 | `TeachingTip`（`Title`/`Subtitle`/`IsOpen`/`ActionButtonContent`/`CloseButtonContent`/`IsLightDismissEnabled`/`ShouldConstrainToRootBounds`） | 只在首启/新功能时用，一次一页最多一条 | 同一个页面不要弹多条 `TeachingTip`（会互相遮挡） | `[API:controls/dev/TeachingTip/TeachingTip.idl]` L94-L123（`[MUX_PUBLIC]`；L138 有 `[MUX_PREVIEW]` 成员须避开）；`⚠️ 自定`（"一页最多一条"是本项目约定） |

### 6.5 输入控件

| 需求 | 官方控件 | 何时用 | 禁止 | 出处 |
|---|---|---|---|---|
| 实例搜索（P1） | `AutoSuggestBox`（`QueryIcon="Find"`、`TextChanged`、`SuggestionChosen`） | 需要"输入 + 建议/自动补全" | 不做自动补全时用 `TextBox` + 清空按钮，不要为了图标上 `AutoSuggestBox` | `[LRN:titlebar-md]` 官方示例 `<AutoSuggestBox QueryIcon="Find" PlaceholderText="Search" .../>`；`[MUX:docs/design-notes/ListView-GridView-overview.md]`（`AutoSuggestBox` 属 `ItemsControl` 子类） |
| 纯文本输入（实例名、registry 地址、启动参数） | `TextBox`（`Header`、`PlaceholderText`、`MaxLength`、`Description`） | 普通单/多行输入 | 不用 `RichEditBox` 承载纯文本（会引入富文本格式风险） | `[LRN:textbox]`；`⚠️ 自定`（不用 RichEditBox 是决策） |
| 数值输入（端口、行数上限、并发数） | `NumberBox`（`Value`/`Minimum`/`Maximum`/`SmallChange`/`LargeChange`/`SpinButtonPlacementMode`/`ValidationMode`/`AcceptsExpression`/`Header`/`Description`） | 需要数值校验 + 步进按钮 | 不用 `TextBox` + 手工 `int.Parse` | `[API:controls/dev/NumberBox/NumberBox.idl]` L31-L92（`NumberBoxSpinButtonPlacementMode`、`NumberBoxValidationMode` 均 `[MUX_PUBLIC]`；L61/L70/L112/L121 有 `[MUX_PREVIEW]` 成员须避开） |
| 设置项开关 | `ToggleSwitch` | "开/关"立即生效的设置项 | 不要把 `CheckBox` 用在设置项行（官方设置页范式是 `ToggleSwitch`） | `[KEY:dxaml/xcp/dxaml/themes/generic.xaml]` L11176-L11188 存在隐式 `<Style TargetType="ToggleSwitch">` 与 `ControlTemplate`；`ToggleSwitch_themeresources.xaml` 见 `controls/dev/CommonStyles/`；`⚠️ 自定`（设置项用 ToggleSwitch 是本项目约定） |
| 多项勾选（列表批量操作） | `CheckBox` | 列表中多选、可与父项三态联动 | 不用它做设置项 | `[LRN:rounded-corner]`（`CheckBox` 属 4px 圆角的常驻控件）；`⚠️ 自定`（分工约定） |
| 互斥选项组（隔离策略 4 维度、向导选项） | `RadioButtons`（`ItemsSource`/`ItemTemplate`/`SelectedIndex`/`SelectedItem`/`MaxColumns`/`Header`） | 选项需要逐个带说明文字、需要键盘上下键切换 | 不用多个裸 `RadioButton` 手工分组（`RadioButtons` 自带方向键导航与 `AutomationProperties`） | `[API:controls/dev/RadioButtons/RadioButtons.idl]` L9-L27（`[MUX_PUBLIC]`） |
| 下拉选择（引擎版本、profile 模板、字体大小） | `ComboBox` | 选项 > 5 或需要省空间 | 选项 ≤ 5 且要常驻可见时改用 `SelectorBar`/`RadioButtons` | `[MUX:docs/design-notes/ListView-GridView-overview.md]`（`ComboBox` 属 `ItemsControl` 子类） |
| 代码/YAML 编辑 | `WebView2`（`Microsoft.UI.Xaml.Controls.WebView2`，`Source`/`CoreWebView2`/`EnsureCoreWebView2Async()`/`NavigateToString`/`DefaultBackgroundColor`/`WebMessageReceived`） | **仅** P3 的 `settings.yaml` 编辑器（Monaco/CodeMirror） | 不用 WebView2 渲染任何应用界面（应用界面一律原生 XAML）；初始化前必须 `EnsureCoreWebView2Async()`；必须设 `DefaultBackgroundColor` 以便主题一致 | `[API:controls/dev/WebView2/WebView2.idl]` L17-L51 |
| YAML 编辑降级方案 | `TextBox`（`AcceptsReturn="True"`、`TextWrapping="NoWrap"`、等宽字族）+ 只读行号 `TextBlock` 列 | WebView2 初始化失败时降级；或用户选择"纯文本模式" | 降级态下**不得**伪装语法着色 | ⚠️ 自定（WinUI 无内置代码编辑器控件，降级方案为本项目自定） |

### 6.6 反馈、状态与容器（含"官方无对应控件"的取舍）

| 需求 | 官方方案 | 取舍理由 | 出处 |
|---|---|---|---|
| **应用内轻提示（Toast）** | ⛔ WinUI **无内置 in-app Toast 控件**（`controls/dev/` 76 项中无 Toast/Notification 控件）。本项目方案：在应用外壳最上层放一个自绘 toast 容器（`Grid`，高 `Canvas.ZIndex`），每条 = `InfoBar` 或 `Border`+`FontIcon`+`TextBlock` 组合，右上角纵向堆叠 | 官方唯一的"通知"能力是**系统级**的 `Microsoft.Windows.AppNotifications.AppNotificationManager` + `AppNotificationBuilder`，桌面应用还需注册 COM 激活（`desktop:ToastNotificationActivation`、`ToastActivatorCLSID`），成本与本场景（"已复制""保存成功"）严重不匹配；且系统通知会离开应用窗口，不适合做操作反馈。**因此：应用内反馈自绘，系统通知不使用。** | 目录证据 `[MUX:controls/dev/]` 无 Toast 控件；系统通知能力与注册成本见 `[LRN:app-notifications-quickstart]`（`AppNotificationManager.Default.Show(appNotification)`；桌面应用需 `<desktop:ToastNotificationActivation ToastActivatorCLSID="..."/>` 与 `AppNotificationManager.Register()`）。自绘方案 `⚠️ 自定` |
| **空态（无实例 / 无插件 / 无存档）** | ⛔ WinUI **无内置 EmptyState 控件**。方案：`StackPanel`（`FontIcon` 24/32 epx + `BodyLargeStrongTextBlockStyle` 标题 + `BodyTextBlockStyle` 说明 + 主操作 `Button`），页面内容区水平垂直居中 | 官方 `generic.xaml` 中确有 `EmptyStateHyperlinkStyle`（`[MUX:docs/design-notes/styles.md]` 提到「an "EmptyStateHyperlinkStyle" style for HyperlinkButton, which defines only four alignment/font/background properties」），但它是 MUXC **内部**样式、无公开文档与稳定性承诺，**不得引用**。故自绘。 | 内部样式证据 `[MUX:docs/design-notes/styles.md]`；自绘方案 `⚠️ 自定` |
| **加载态** | `ProgressBar`（determinate/indeterminate）与 `ProgressRing`（determinate/indeterminate） | 分工：**不确定时长且不阻断** → indeterminate `ProgressBar`（如刷新列表）；**必须阻断用户** → indeterminate `ProgressRing`（如启动实例中）；**时长已知** → determinate 版本。列表加载时**只在列表顶部放一条** `ProgressBar`，不要给每个列表项加转圈 | `[LRN:progress-controls]`「The indeterminate state for ProgressBar shows that an operation is underway, does not block user interaction…」「The indeterminate state for ProgressRing shows that an operation is underway, blocks user interaction」「do not put a progress indicator on each list item as they appear. Instead, use a ProgressBar and place it at the top of the collection」 |
| 按钮内联忙碌 | `Button` + 内联 `ProgressRing`（≥ 20×20 epx，`IsActive="True"`），并 `IsEnabled="False"` | WinUI 按钮无内置忙碌态；不阻塞整个页面时不要弹全屏 `ProgressRing` | `[LRN:progress-controls]`（`ProgressRing` 最小 20×20 epx、`IsActive`）；`⚠️ 自定`（内联做法） |
| 分区容器 | `Grid` + `Border`（`CardBackgroundFillColorDefaultBrush` + `ControlStrokeColorDefaultBrush` 1 px + `ControlCornerRadius`） | 卡片是官方推荐的 content layer 表达 | `[LRN:mica]`（Card pattern / `LayerFillColorDefaultBrush`）；`[KEY:Common_themeresources_any.xaml]`（卡片色键）；`[LRN:elevation]`（Card = 8） |
| 窄内容区滚动 | `ScrollView`（新控件） | 本项目优先用 `ScrollView`：无需 header 特性；`ScrollViewer` 则**不支持**自定义惯性曲线 | `[MUX:docs/design-notes/ScrollView-overview.md]`「The ScrollView does not support header elements. The ScrollViewer does not support customization of its inertia curve.」 |
| 需要 header/footer 的滚动区 | `ScrollViewer` | 仅当确实需要 `ScrollViewer` 独有能力（header 元素）时 | 同上 |

---

## 7. 交互与状态

### 7.1 焦点视觉

| 规格 | 内容 | 出处 |
|---|---|---|
| 焦点矩形只在键盘聚焦时绘制 | WinUI 仅在 `FocusState == Keyboard` 时画焦点框；指针交互不画 | `[MUX:docs/design-notes/focus.md]`「Xaml draws the focus rect when the focused element's FocusState is "Keyboard".」「The app doesn't really have a good way to override this behavior, other than by setting the control's FocusState to "Pointer".」 |
| 系统焦点视觉开关 | 资源键 `UseSystemFocusVisuals`，`x:Boolean`，默认 `True` | `[KEY:dxaml/xcp/dxaml/themes/generic.xaml]` L1525 / L3487 / L5450 `<x:Boolean x:Key="UseSystemFocusVisuals">True</x:Boolean>` |
| 焦点描边取色 | 外圈 `FocusStrokeColorOuterBrush`、内圈 `FocusStrokeColorInnerBrush`（值见 §3.2） | `[KEY:Common_themeresources_any.xaml]` L54-L55、L144-L145 |
| **禁止**自绘焦点框 | 不要用 `Border` 模拟焦点；不要关掉 `UseSystemFocusVisuals` | `[MUX:docs/design-notes/focus.md]`（可用性由框架统一）；⚠️ 自定（禁止条款） |
| 焦点目标可下沉 | 控件可用 `FocusTargetDescendant` 让焦点框落在内部元素上（框架内部机制，实现者只需知道"焦点框可能不等于控件外框"） | `[MUX:docs/design-notes/focus.md]`「Retrieve the FocusTargetDescendant from Sparse Storage」 |

### 7.2 键盘导航与加速键

| 规格 | 内容 | 出处 |
|---|---|---|
| Tab 顺序 | 默认按可视树顺序；需要显式顺序时用 `TabIndex`（值小者先获得焦点）与 `IsTabStop`（`false` 移出 Tab 序列） | `[LRN:focus-nav]`「`TabIndex` to specify the order in which elements receive focus when the user navigates through controls using the Tab key. A control with a lower tab index receives focus before a control with a higher index.」；「All interactive controls support Tab key navigation by default」 |
| 区域化 Tab | `Control.TabNavigation`（`KeyboardNavigationMode`） | `[LRN:focus-nav]`「`Control.TabNavigation`」 |
| 二维方向键导航 | `XYFocusKeyboardNavigation="Enabled"`（默认 `Disabled`）；子元素继承；`Disabled` 形成边界 | `[LRN:focus-nav]`「When set, navigation with the arrow keys is restricted to elements within the directional area. Tab navigation is not affected」 |
| 方向键策略 | `XYFocusUpNavigationStrategy` / `XYFocusDownNavigationStrategy` / `XYFocusLeftNavigationStrategy` / `XYFocusRightNavigationStrategy` | `[LRN:focus-nav]`「Navigation strategies are applicable to keyboard, gamepad, remote control, and various accessibility tools.」 |
| 加速键定义 | `KeyboardAccelerator`（`Key`=`VirtualKey`、`Modifiers`=`VirtualKeyModifiers`，默认 `None`） | `[LRN:keyboard-accelerators]`「you specify your custom `KeyboardAccelerator` objects and define the keystrokes」 |
| **加速键实例不可共享** | 同一个 `KeyboardAccelerator` 对象不能加到多个元素上 | `[LRN:keyboard-accelerators]`「`KeyboardAccelerator` is not shareable, the same KeyboardAccelerator can't be added to multiple elements.」 |
| 加速键作用域 | `ScopeOwner`（默认 `null` = 全局） | `[LRN:keyboard-accelerators]`「The `ScopeOwner` attribute … marks the accelerator as scoped instead of global (the default is null, or global).」 |
| 菜单里显示快捷键 | `KeyboardAcceleratorPlacementMode="Auto"` + `KeyboardAcceleratorTextOverride`（`MenuFlyoutItem` / `ToggleMenuFlyoutItem` 上） | `[LRN:keyboard-accelerators]`（Accelerator key combo appended to MenuFlyoutItem's text 段） |
| 屏幕阅读器播报快捷键 | 设 `AutomationProperties.AcceleratorKey`（**仅**用于播报，不产生功能） | `[LRN:keyboard-accelerators]`「Setting `AutomationProperties.AcceleratorKey` doesn't enable keyboard functionality, it only indicates to the UIA framework which keys are used.」 |
| 访问键（Alt 直达） | `AccessKey`（如 `AccessKey="S"`）+ `IsAccessKeyScope` 划分子作用域 | `[LRN:keyboard-accelerators]`（含 `<AppBarButton AccessKey="R" Icon="Refresh" Label="Refresh" IsAccessKeyScope="True">` 示例） |
| 加速键触发控件的默认行为 | 框架会检查控件是否实现 Invoke 控制模式并自动激活，**无需**监听 `KeyboardAcceleratorInvoked` | `[LRN:keyboard-accelerators]`「the XAML framework looks up whether the control implements the Invoke control pattern and, if so, activates it (it is not necessary to listen for the KeyboardAcceleratorInvoked event).」 |
| 加速键优先于控件默认输入 | 同一组合键不要既做加速键又做控件内动作 | `[LRN:keyboard-accelerators]`（`ScopeOwner` 与 `TextBox.KeyboardAccelerators` 示例说明冲突处理） |

### 7.3 Gamepad / 遥控器

| 规格 | 内容 | 出处 |
|---|---|---|
| **默认就有** | WinUI 3 完整应用在 XAML 初始化时由框架**自动**为进程打开手柄按键路由，D-pad / 摇杆 / 导航按键会自动映射为键盘虚拟键，控件"respond to the gamepad automatically, with no additional code in your app" | `[MUX:docs/design-notes/gamepad-navigation.md]`「gamepad input (D-pad, thumbstick, and buttons that map to navigation…）…respond to the gamepad automatically, with no additional code in your app.」；「the framework enables gamepad key routing for the process」 |
| 开关 API | `Windows.UI.Input.GamepadKeyRoutingConfiguration`（`IsSupported()` / `IsKeyRoutingEnabled()` / `TrySetKeyRoutingEnabled(bool)`），**进程级**设置 | 同上（API Details 段） |
| **本项目决策** | **不禁用**手柄路由；按钮通过 XYFocus 自然可达（`XYFocusKeyboardNavigation` 配合）。不做 Xbox 专用 UI | `⚠️ 自定`（保留默认为决策） |
| 注意事项 | `ContentDialog` 的手柄 B 键等同关闭按钮（返回 `ContentDialogResult.None`） | `[LRN:dialogs]`「The user clicked the CloseButton, pressed ESC, Gamepad B, or the system back button.」 |

### 7.4 状态（悬停 / 按下 / 禁用 / 选中）

| 状态 | 视觉来源 | 禁止 |
|---|---|---|
| Normal / PointerOver / Pressed / Disabled | 用内置 `VisualStateGroup x:Name="CommonStates"` 的 `Normal` / `PointerOver` / `Pressed` / `Disabled`，取值一律 `{ThemeResource …}` | **禁止**在 `code-behind` 里改颜色；**禁止**两个 `VisualStateGroup` 同时改同一个元素（会导致不可预测行为） |
| Selected / Checked | 用控件自带 `Selected` / `Checked*` 状态与 `AccentFillColorDefaultBrush` 选中标记 | 不要用 `Border` 手工描边模拟选中 |
| ListView 项悬停/按下 | 用 `SubtleFillColorSecondaryBrush`（悬停）/ `SubtleFillColorTertiaryBrush`（按下），不要改 `CardBackgroundFillColor*` | — |

出处：状态名与规则见 `[MUX:docs/design-notes/xaml-styling-guide.md]`「the most generic `VisualStateGroup` is `CommonStates` and contains visual states such as `Normal`, `PointerOver`, `Pressed`, `Disabled`」「Property values should always reference a defined ThemeResource or StaticResource」「different visual state groups **cannot** modify the same element. Modifying the same element can cause unpredictable behaviour and bugs.」；色键见 §3.2。

### 7.5 动效时长与曲线

| 资源键 | 值 | 用途 | 出处 |
|---|---|---|---|
| `ControlNormalAnimationDuration` | `00:00:00.250`（250 ms） | 页面/大面积进出场 | `[KEY:Common_themeresources_any.xaml，经 MUX:docs/design-notes/xaml-styling-guide.md「Animation Speeds」段摘录]`；`[LRN:timing-easing]`「ControlNormalAnimationDuration 250ms」 |
| `ControlFastAnimationDuration` | `00:00:00.167`（167 ms） | 中等元素状态变化 | 同上；`[LRN:timing-easing]`「167ms」 |
| `ControlFasterAnimationDuration` | `00:00:00.083`（83 ms） | 小元素/淡出 | 同上；`[LRN:timing-easing]`「83ms」 |
| `ControlFastAnimationAfterDuration` | `00:00:00.168`（168 ms） | 紧随其后的第二段动画 | `[MUX:docs/design-notes/xaml-styling-guide.md]` |
| `ControlFastOutSlowInKeySpline` | `0,0,0,1` | **进入**场景的缓动（Fast Out, Slow In） | `[MUX:docs/design-notes/xaml-styling-guide.md]`；`[LRN:timing-easing]`「Fast Out, Slow In `cubic-bezier(0, 0, 0, 1)` Use for objects or UI entering the scene」 |
| 退出场景曲线 | `cubic-bezier(1, 0, 1, 1)`（Slow Out, Fast In；官方未提供同名资源键 → 用 `KeySpline="1,0,1,1"` 写在 `SplineDoubleKeyFrame` 上） | 元素离开场景 | `[LRN:timing-easing]`「Slow Out, Fast In `cubic-bezier(1 , 0 , 1 , 1)` Use for UI or objects that are exiting the scene.」 |

**规则**
- 动画时长**只准**引用上述资源键，不写裸数字（官方明示 "It is best practice to reference the above resources rather than hard-coding the values." `[MUX:docs/design-notes/xaml-styling-guide.md]`）。
- 过渡动画写在 `VisualStateGroup.Transitions` 的 `VisualTransition` + `Storyboard` 里，不写 code-behind。范例见 `[MUX:docs/design-notes/xaml-styling-guide.md]`（`ContentDialog` 的 `DialogShowingStates` 用法）。
- 收藏/展开类动画优先让控件自己做（`Expander` 用 `TemplateSettings.ContentHeight` 驱动，不许在 code-behind 里量高度）。`[MUX:docs/design-notes/xaml-styling-guide.md]`「Instead of animating `ExpanderContent` to the its calculated height value in codebehind, the animation is kept in the template, leveraging `ExpanderTemplateSettings.ContentHeight`.」
- **⚠️ 无官方"减少动效"开关**：WinUI 3 无 `prefers-reduced-motion` 等价物。本项目约定：`⚠️ 自定` —— 读 `Windows.UI.ViewManagement.UISettings.AnimationsEnabled`，为 `false` 时把 `Storyboard` 时长置 0（用 `Duration="0"` 或直接跳终态）。

### 7.6 异步与不卡死（P5/P6 硬性要求）

| 规格 | 内容 | 出处 |
|---|---|---|
| 所有后端推送经 UI 线程合并 | `DispatcherQueue.TryEnqueue` 合并同一帧内的多次刷新（不要逐条 `Invoke`） | `[LRN:accessible-text]`（演示 `DispatcherQueue.TryEnqueue` 的 marshal 用法）；`⚠️ 自定`（"合并"策略） |
| 日志/列表用虚拟化容器 | P5 日志、P6 安装日志必须落在 `ListView`（`ItemsStackPanel`）或 `ItemsRepeater` + `VirtualizingLayout` 上 | `[MUX:docs/design-notes/ListView-GridView-overview.md]`「UI virtualization through the use of virtualizing panels… item recycling, with a recycling pool」；`[API:controls/dev/Repeater/ItemsRepeater.idl]`（`VirtualizingLayout`） |
| 保持滚动位置 | 日志页用 `ItemsStackPanel.ItemsUpdatingScrollMode` = `KeepLastItemInView` 实现"跟随底部" | `[MUX:docs/design-notes/ListView-GridView-overview.md]`「item anchoring through the use of the `ItemsStackPanel.ItemsUpdatingScrollMode` property, to preserve the first or last item in view for example」。**风险**：官方 bug 清单中记录了「[WhatsApp] `ItemsStackPanel.ItemsUpdatingScrollMode=KeepLastItemInView` is broken when shrinking the ListView size」→ 实现后必须实测"窗口缩小时日志跟随"路径 |
| 环形裁剪 | 渲染行数达上限后按批移除最旧行（`ObservableCollection.RemoveAt(0)` 需按批做，逐条会触发 N 次集合变更；或换用自定义 `IList` + `Reset` 通知） | ⚠️ 自定（上限值与裁剪批大小是本项目约定；上限值需求来源见 `docs/review/frontend-survey-for-winui3.md` §2.2 `logview.ts` 的 `MAX_RENDERED = 1500`） |
| 禁止 | ⛔ 用 `RichTextBlock`/`TextBlock` 堆叠承载无上限日志；⛔ 在 UI 线程做文件遍历/解压；⛔ `UpdateLayout()` | `[MUX:docs/design-notes/Layout-overview.md]`（`UpdateLayout` 禁忌）；`⚠️ 自定`（前两条是性能约定） |

---

## 8. 可访问性

### 8.1 `AutomationProperties`（全部成员已回源官方 API 页）

官方 `AutomationProperties` 提供的附加属性（本次实读 Windows App SDK API 参考页确认存在）：
`AcceleratorKey`、`AccessibilityView`、`AutomationId`、`ControlledPeers`、`DescribedBy`、`FlowsFrom`、`FlowsTo`、`HeadingLevel`、`HelpText`、`IsDialog`、`IsRequiredForForm`、`ItemStatus`、`ItemType`、`LabeledBy`、`LandmarkType`、`LiveSetting`、`Name`、`PositionInSet`、`SizeOfSet`。
出处：`[API:Microsoft.UI.Xaml.Automation.AutomationProperties（Windows App SDK API 参考页）]`。

| 场景 | 规格 | 出处 |
|---|---|---|
| 图标按钮必须有名字 | `AutomationProperties.Name` 显式给出动作语义（图标本身无语义） | `[LRN:uia-names]`「`AutomationProperties.Name`」（Icon buttons 段） |
| 复用可见标签而非重复文案 | `AutomationProperties.LabeledBy` 指向可见 `TextBlock` | `[LRN:uia-names]`「Labels and LabeledBy」；`[LRN:accessible-text]`「`AutomationProperties.Name`」 |
| 补充解释 | `AutomationProperties.HelpText` | `[LRN:uia-names]`（`AutomationProperties.HelpText` 段） |
| 装饰性图形 | `AutomationProperties.AccessibilityView="Raw"` | `[MUX:docs/design-notes/xaml-styling-guide.md]` 范例 `<TextBlock … AutomationProperties.AccessibilityView="Raw" />`；`[LRN:uia-names]`「`AutomationProperties.AccessibilityView`」 |
| 自动化测试锚点 | `AutomationProperties.AutomationId`（在模板里显式给出稳定 id） | `[KEY:dxaml/xcp/dxaml/themes/generic.xaml]` L12810 等：`<Setter Property="AutomationProperties.AutomationId" Value="DatePickerFlyoutPresenter" />` |
| 自定义虚拟化布局的顺序播报 | `PositionInSet` / `SizeOfSet` 必须与数据顺序一致（1 基） | `[LRN:items-repeater]`「Users minimally expect that the values for the PositionInSet and SizeOfSet properties used by screen readers will match the order the items appear in the data (offset by 1…)」 |
| 焦点/展开相关的播报 | 用 `HeadingLevel`、`LiveSetting`、`LandmarkType` 给出结构语义（日志页新行的礼貌播报用 `LiveSetting`） | `[API:Microsoft.UI.Xaml.Automation.AutomationProperties]`（成员存在性）；具体取值 `⚠️ 自定`（本项目未逐项实测其播报效果） |

### 8.2 对比度

| 规格 | 值 | 出处 |
|---|---|---|
| 正文对比度 | ≥ **4.5:1**（相对亮度比）；例外：logo 与非活动 UI 中的附带文字 | `[LRN:accessible-text]`「visible text must have a minimum luminance contrast ratio of 4.5:1 against its background. Exceptions include logos and incidental text, such as text in inactive UI.」；WCAG 2.0 G18 |
| 不要把高对比模式当主要手段 | 默认主题下就必须满足对比度 | `[LRN:accessible-text]`「Do not treat high-contrast mode as the primary mitigation for low readability. Base text design on sufficient foreground/background contrast in the default experience.」 |
| Acrylic 上的文字 | 不用强调色文字（14px 下大概率不达标） | `[LRN:acrylic]`（原文见 §3.3） |
| 颜色不是唯一信号 | 状态（运行中/已崩溃/有冲突）必须同时有图标或文字，不能只靠色点 | `[LRN:color]`「Make sure that elements and images have sufficient contrast to differentiate between them, regardless of the accent color or theme.」；`⚠️ 自定`（"色 + 形 + 字"三通道是本项目约定） |

### 8.3 文本缩放与显示缩放

| 规格 | 内容 | 出处 |
|---|---|---|
| 保持默认开启 | `IsTextScaleFactorEnabled` 默认 `true`，**不要全局关闭** | `[LRN:accessible-text]`「Many text elements and controls expose `IsTextScaleFactorEnabled`, which defaults to `true` … Avoid disabling text scaling broadly.」 |
| 受影响类型 | `ContentPresenter`、`Control` 及其派生类、`FontIcon`、`RichTextBlock`、`TextBlock`、`TextElement` | `[LRN:accessible-text]`「These types have an `IsTextScaleFactorEnabled` property」（含清单） |
| 不能假设等比放大 | 小字号被放大得更多，大字号受影响较小 | `[LRN:accessible-text]`「Do not assume uniform scaling across all text sizes. Larger text is generally affected less than smaller text.」 |
| 需要响应缩放变化的 UI（图形与文字对齐） | 订阅 `UISettings.TextScaleFactorChanged`，读 `TextScaleFactor`（`double`，范围 **[1, 2.25]**），在 `DispatcherQueue.TryEnqueue` 里更新 | `[LRN:accessible-text]`「`TextScaleFactor` is a `double` in the range [1,2.25]」+ 官方代码示例 |
| **实现要求** | 所有"固定高"的行高容器在文本放大时会溢出 → 外壳、卡片、页签**禁止**用固定 `Height` 承载文字；需要固定高时用 `MinHeight` | ⚠️ 自定（由 8.3 上条推导出的本项目硬性规则） |
| 缩放验证 | 至少在 `Settings → System → Display → Scale` 的 100% / 150% / 200% 与 `Settings → Accessibility → Text size` 的 100% / 150% 下各走查一遍 8 个页面 | `[LRN:accessible-text]`「You should then validate against Windows text-related accessibility settings」（Magnifier / Scale and layout / Text size） |

### 8.4 高对比（Contrast）主题

| 规格 | 内容 | 出处 |
|---|---|---|
| 与明暗主题不是一回事 | 对比主题用系统色，为最大对比度优化 | `[LRN:high-contrast]`「Do not confuse contrast themes with light and dark themes.」 |
| 背景基线 | 用 `SystemColorWindowColor` 作背景基线 | `[LRN:high-contrast]`「Use `SystemColorWindowColor` as the background baseline.」 |
| 瞬态表面加 2 px 边框 | 只在需要保持视觉边界处加"仅高对比下生效"的边框；`Flyout` / `Dialog` 建议 2 px | `[LRN:high-contrast]`「Add contrast-theme-only borders only where you need to preserve important visual boundaries. We recommend using 2px borders for transitory surfaces such as flyouts and dialogs.」 |
| 四个内置对比主题都要测 | 必须在 4 个内置对比主题下运行验证 | `[LRN:high-contrast]`「Test your app in all four built-in contrast themes while it is running.」 |
| 本项目做法 | 只引用内置键 + `SystemColor*`，即自动获得对比主题支持；自定义 `ResourceDictionary` 必须三字典齐备 | `[KEY:Common_themeresources_any.xaml]`（每个画刷键都有 `HighContrast` 分支）；`[LRN:theme-resources]` |

### 8.5 AI/无障碍检查清单（提交前必过）

1. 每个图标按钮有 `AutomationProperties.Name`；每个输入有可见 `Header` 或 `LabeledBy`。
2. 页面标题用 `TitleTextBlockStyle`，且每页只有一个；分节标题用 `SubtitleTextBlockStyle`。
3. 全键盘可达：Tab 能走完整页；`Esc` 关浮层；`Ctrl+S` 保存；`Enter` 触发主操作。
4. 三主题 × 四对比主题 × 文本缩放 100%/150% 走查通过。
5. 状态不靠单一颜色表达。
6. `ProgressRing` 的 `Height`/`Width` 成对设置且 ≥ 20。

---

## 9. 页面结构规格

### 9.0 通用页面骨架契约（8 页共用的强制结构）

```
Page (Grid, Padding = 24 或 12)
├─ Row 0 [Auto]  页头 Grid
│   ├─ Col 0 [*]  StackPanel: 标题 (TitleTextBlockStyle) + 一句说明 (BodyTextBlockStyle, TextFillColorSecondaryBrush)
│   ├─ Col 1 [Auto] 本页主操作区（Button / CommandBar / ToggleSwitch）
│   └─ Col 2 [Auto] 面包屑占位（BreadcrumbBar，仅详情页用）
├─ Row 1 [Auto]  InfoBar 区（按状态显示；无状态时 Collapsed）
├─ Row 2 [*]     内容区（各页规定见下）
└─ Row 3 [Auto]  状态条（可选）：CaptionTextBlockStyle + TextFillColorTertiaryBrush
```

**页头/内容不外包 `ScrollViewer`** 的页面：P1、P5、P6（内容区自带虚拟化滚动）。
**内容区用 `ScrollView` + `StackPanel`** 的页面：P3、P7、P8、P2 的静态区。

| 状态 | 表现 | 依据 |
|---|---|---|
| 加载中 | 内容区顶部 indeterminate `ProgressBar`（不阻塞）；首屏加载可用居中 `ProgressRing`（`IsActive="True"`） | §6.6 |
| 空 | 居中空态块（`FontIcon` + `BodyLargeStrongTextBlockStyle` + `BodyTextBlockStyle` + 主操作 `Button`） | §6.6 |
| 错误 | 页头下方 `InfoBar Severity="Error"` + `Title` 为错误摘要 + `Message` 为处置建议（`result.error` 原文，可复制）；**错误不得只进日志** | §6.4；契约依据：所有调用返回 `Result<T>`，`ok:false` 时 `error` 为中文可读消息（`src/shared/contracts.ts:19-22`） |
| 降级 | `InstanceSummary.problem` 存在时**必须**显示 `InfoBar Severity="Warning"`，文案用 `problem` 原文 | 契约 `src/shared/contracts.ts:141-148` 明确要求"界面**必须**把它显示出来" |

---

### 9.1 应用外壳（Shell）

**职责**：窗口框架、全局导航、应用菜单、右侧日志抽屉、全局浮层宿主。

**官方控件**：`TitleBar`、`MenuBar`、`SplitView`、`NavigationView`、`NavigationViewItem`、`Frame`、`InfoBar`（toast 容器内）。

**布局骨架**

```
Window (RootGrid)
├─ Row0 [Auto] TitleBar                       [API:TitleBar.idl]
│   ├─ IconSource      = 鲸鱼图标（16×16，Margin 8,0,4,0）
│   ├─ Title           = "WhalesLauncher"
│   ├─ Subtitle        = 当前页名（CaptionTextBlockStyle 由控件默认样式给出）
│   ├─ LeftHeader      = MenuBar（"文件/编辑/视图/窗口/帮助"）
│   ├─ Content         = 留空（避免与 LeftHeader 抢位）
│   ├─ RightHeader     = StackPanel(Horizontal)
│   │                    ├─ ToggleButton  "日志"（含 InfoBadge 显示未读错误数）
│   │                    └─ Button        "主题"（浅色/深色）
│   ├─ IsBackButtonVisible = 详情页 True / 其它 False
│   └─ IsPaneToggleButtonVisible = False（左栏由 NavigationView 自身处理）
└─ Row1 [*] SplitView (PanePlacement=Right, DisplayMode=Overlay, OpenPaneLength=480)
    ├─ Content = NavigationView
    │   ├─ PaneDisplayMode = Auto（默认，得到官方三段自适应）
    │   ├─ IsBackButtonVisible = Collapsed
    │   ├─ IsSettingsVisible = False
    │   ├─ IsTitleBarAutoPaddingEnabled = False
    │   ├─ AlwaysShowHeader = False
    │   ├─ MenuItems = 静态 NavigationViewItem × 3（**功能列表**，不承载实例列表）
    │   │               ├─ 实例          （FontIcon E8FD List，Tag="instances"）
    │   │               ├─ 引擎版本管理  （FontIcon E71D AllApps，Tag="engines"）
    │   │               └─ 全局设置      （FontIcon E713 Setting 标准齿轮，Tag="settings"）
    │   ├─ FooterMenuItems = 静态 NavigationViewItem × 1
    │   │               └─ 关于          （FontIcon E946 Info，Tag="about"）
    │   ├─ 每项**必须**设 AutomationProperties.Name（UI 自动化按名字定位；
    │   │   标签文案见 docs/design/demo/ui-function-nav.html）
    │   ├─ 无 PaneHeader、无 MenuItemsSource、无 MenuItemTemplate
    │   └─ Content = Frame（P1…P8 + 关于，Frame.Navigate(Type, object)）
    └─ Pane = 日志抽屉
        ├─ Grid[Auto,*]
        │   ├─ Row0: StackPanel(Horizontal)
        │   │          ├─ 来源选择 ComboBox（"全部实例" + 各实例）
        │   │          ├─ ToggleButton "跟随"（默认开）
        │   │          └─ Button "打开日志目录" / "复制全部"
        │   └─ Row1: LogView（复用 P5 的日志控件，见 9.6）
        └─ 关闭时保留内容至收拢动画结束再清空（时长取 ControlFastAnimationDuration 或 ControlNormalAnimationDuration）
```

| 规格 | 值 | 出处 |
|---|---|---|
| 标题栏高 | 48（展开） | §2.2 |
| 抽屉宽 | 480 | `⚠️ 自定` |
| 抽屉模式 | `Overlay`（叠在内容上） | §6.1 |
| 左栏默认显示模式 | `Auto` | §2.3 |
| 左栏项 | 图标 16 px（Segoe Fluent Icons 字形）+ 文字 14 px；项高 40、圆角 5、左右内边距 12 | 视觉基准 `docs/design/demo/ui-function-nav.html` |
| 左栏选中态 | 框架默认（背景 + 左侧 3 px 强调色指示条 + 字重）；**图标不染强调色**（深色下会突兀） | 交接文档 §6.4 |
| 左栏宽度 | 保持框架默认 `OpenPaneLength`（演示稿按 280 px 画的只是观感参照） | — |
| 窗口控制按钮配色 | 按**当前生效主题**显式设置 `AppWindowTitleBar.Button*Color`（深色：白字形 / 浅色：黑字形；背景透明，悬停/按下叠一层很淡的覆盖色） | 这些按钮由**系统**按**系统主题**绘制，不跟随 `RootGrid.RequestedTheme`；"深色窗口跑在浅色系统上"时字形与标题栏同为暗色，实测"三个按钮几乎不可见"（用户反馈）。注意 API 在 `AppWindowTitleBar` 上，**不是** XAML `TitleBar` 控件的属性 |
| 菜单来源 | `app.menu()` → `MenuNode[]`，动态构造 `MenuBarItem` / `MenuFlyoutItem` / `MenuFlyoutSeparator` | 契约 `src/shared/contracts.ts:686`、`MenuNode` 注释"渲染层的自绘菜单只是它的视图，不得自行维护第二份定义" |

> **左栏为什么不放实例列表**：实例列表只在「实例」页内出现（卡片网格 + 页内搜索 / 状态筛选 / 排序）。
> 同一批数据同时画在左栏与内容区是用户明确指出的**功能重复**；改版后左栏是纯功能导航，
> 「实例」项在实例列表页与详情页都处于选中态 —— 这也顺带修掉了此前的两个登记缺陷
> （P1 停在实例列表时左栏无高亮；从 P6/P7/P8 没有任何路径回到 P1）。
>
> 左栏项是**静态 `NavigationViewItem`**，不违反 §6.1（那条禁止的是在 code-behind 里手工塞项、
> 丢掉模板可替换性）。历史坑记在这里以免重蹈：`NavigationView` 会把 `MenuItemTemplate`
> 也套到"自容器项"（`NavigationViewItem` / `NavigationViewItemSeparator`）上，导致模板里的
> `x:Bind` 全部失败、画出"空头像框 + 假『新建实例』"的垃圾行（交付报告 §3 有完整复盘）。
> 现在没有 `MenuItemTemplate` / `MenuItemsSource`，这个坑不会再现。

**浮层宿主**：toast 容器（`Grid.HorizontalAlignment=Right`、`VerticalAlignment=Top`、`Canvas.ZIndex` 最大、`Margin=0,56,24,0`）位于 `RootGrid` 最上层，**不拦截点击**（容器 `IsHitTestVisible=False`，每条 toast `True`）。

**空态/加载态/错误态**
- 无实例：左栏**不变**（功能列表与实例数量无关，四项始终在），实例页显示空态 A「还没有实例」+ 主按钮。
- 后端探测失败：窗口仍要出界面（外壳先渲染），用 toast（最多 3 条去重）+ 页级 `InfoBar` 说明。
- 主题：外壳无独立错误态。

**数据来源**：`launcher.getConfig` / `launcher.setConfig`、`instance.list`、`app.menu` / `app.menuCommand`、`app.version`、`log.chunk` / `log.state`（推送）。

---

### 9.2 P1 实例列表

**职责**：实例卡片网格；搜索 / 状态筛选 / 排序；空态引导；卡片上的启动/停止/更多/打开界面。

**官方控件**：`GridView`（卡片网格，`ItemsWrapGrid`）或 `ListView`（列表形态）、`AutoSuggestBox`、`SelectorBar`（状态筛选）、`ComboBox`（排序）、`Button`、`InfoBar`、`CommandBarFlyout`（"更多"）、`MenuFlyout`、`ProgressRing`（卡片内联忙碌）、`InfoBadge`。

**布局骨架**

```
Grid[Auto, Auto, Auto, *]
├─ Row0: 页头（"实例" TitleTextBlockStyle + 右侧"新建实例" Button）
├─ Row1: 工具条 Grid[Auto,*,Auto]
│        ├─ AutoSuggestBox  搜索（匹配 name / dirName / note）
│        ├─ SelectorBar     状态筛选：全部 / 运行中 / 已停止 / 异常
│        └─ ComboBox        排序：名称 / 最近启动 / 创建时间 / 插件数
├─ Row2: InfoBar（"有 N 个实例的目录缺失或被外部改动" 时 Warning；逐条 problem 列在卡片内）
└─ Row3: GridView
         ├─ ItemsPanel = ItemsWrapGrid（`GridView` 默认面板，自动随宽度换列）
         ├─ ItemContainerStyle：宽 320，Margin 8（4 的倍数），圆角取 ControlCornerRadius
         └─ ItemTemplate = DataTemplate
             Border(CardBackgroundFillColorDefaultBrush + ControlStrokeColorDefaultBrush 1px + ControlCornerRadius)
             └─ Grid[Auto,Auto,Auto,*]
                 ├─ 头像（emoji 或 FontIcon，40×40，底色由 meta.color 生成的单色底 + TextFillColorInverseBrush 文字）
                 ├─ StackPanel: 名称(BodyLargeStrongTextBlockStyle)
                 │               目录名(CaptionTextBlockStyle, TextFillColorTertiaryBrush, 省略号)
                 ├─ 状态行: 状态点 + 状态文字(BodyTextBlockStyle) + 端口/URL(Caption, 可点击复制)
                 ├─ 元信息: 引擎版本 · 插件数 · 最近启动(Caption)
                 ├─ problem 存在时: 一行 InfoBar(Severity=Warning, IsClosable=False)
                 └─ 操作行 StackPanel(Horizontal):
                      主按钮 Button（启动/停止，见状态映射）
                      Button "打开界面"（仅 running 且 url != null，Enabled 依此）
                      Button "更多" → CommandBarFlyout（打开目录 5 个入口 / 编辑 / 导出包 / 删除）
```

**状态映射（`InstanceState` → 卡片表现）**

| `runtime.state` | 主按钮 | 忙碌态 | 卡片指示 |
|---|---|---|---|
| `stopped` | "启动"（强调色） | — | 灰点 + "已停止" |
| `starting` | "启动中…"（禁用） | 内联 `ProgressRing` 20×20 | 环 + "启动中" |
| `running` | "停止"（普通） | — | 绿点 + "运行中" + 端口/URL |
| `stopping` | "停止中…"（禁用） | 内联 `ProgressRing` | 环 + "停止中" |
| `crashed` | "重新启动" | — | 红点 + "已崩溃" + `lastError` 摘要（`Caption`，省略号 + ToolTip） |

出处：`InstanceState` 与 `InstanceRuntime` 字段见 `src/shared/contracts.ts:108-129`；`InstanceSummary.problem` 必须显示见 `src/shared/contracts.ts:141-148`。

**空态 / 加载态 / 错误态**
- 空（无实例）：居中空态块，"还没有实例" + 说明 + "创建第一个实例"按钮（跳 P7）。
- 加载（首次 `instance.list`）：内容区居中 `ProgressRing`（`IsActive="True"`）。
- 刷新（已有数据）：只在工具条右侧放 indeterminate `ProgressBar`（宽 120），**不**清空已有卡片，**不**让搜索框失焦。
- 错误：`instance.launch` / `stop` 失败 → toast（可展开详情，便于复制 `error` 原文）+ 卡片主按钮恢复可点。
- 降级：`present=false` 或 `engineInstalled=false` 的实例，主按钮禁用并在卡片内 `InfoBar` 说明原因。

**数据来源**：`instance.list` / `create` / `update` / `remove` / `launch` / `stop` / `openFolder`、`pack.export` / `import` / `pickFile`、`log.state`（推送）。

---

### 9.3 P2 实例详情 · 插件

**职责**：内置组合包开关 / 本地插件（zip、GitHub、文件夹）/ 依赖表三块。

**官方控件**：`SelectorBar`（本页内的三块切换）、`ListView`（依赖表）、`TreeView`（仅当依赖有真实层级时）、`Expander`（分组）、`ToggleSwitch` 或 `CheckBox`（组合包开关）、`Button`、`ContentDialog`（安装来源选择、删除确认）、`InfoBar`、`ProgressBar`（安装进度）、`ItemsRepeater` + `StackLayout`（本地插件卡列表）。

**布局骨架**

```
Grid[Auto, Auto, Auto, *]
├─ Row0: 页头（"插件" + 实例名副标题 + BreadcrumbBar：实例名 / 插件）
│        右侧："安装本地插件" Button（→ ContentDialog 三选一：zip / GitHub / 文件夹）
├─ Row1: InfoBar（bundle patch 缺失、来源标记损坏、`installedByLauncher` 与自检结论不一致时 Warning）
├─ Row2: SelectorBar  [ 内置组合包 | 本地插件 | 依赖 ]
└─ Row3: 三块内容共用同一 Grid，按 SelectedItem 切 Visibility
    ├─ 块 A 内置组合包：ListView
    │     └─ ItemTemplate: Grid[Auto,*,Auto]
    │           ├─ ToggleSwitch（enabled；切换即调 plugin.setBundleEnabled，乐观更新 + 失败回滚并 toast）
    │           ├─ StackPanel: 名称(BodyStrong) + version(Caption) + description(Body, Secondary)
    │           └─ 徽标: "随 dsh 安装"(builtin=true) / "bundle patch 缺失"
    │
    ├─ 块 B 本地插件：ItemsRepeater(StackLayout, Spacing=8) 放在 ScrollView 内
    │     └─ 每项 Border(卡片) Grid[Auto,*,Auto, Auto]
    │           ├─ 名称 + version + origin 徽标（zip/GitHub/文件夹/手工/来源标记损坏）
    │           ├─ 标记行: hasBundlePatch / hasClient / patchFileExists / installedByLauncher → 用 Badge 形式
    │           ├─ 路径 Caption（省略号 + ToolTip 全文）
    │           └─ Button "更多" → MenuFlyout：打开目录 / 删除（ContentDialog 确认）
    │
    └─ 块 C 依赖表：ListView（表头独立 Grid 行，ItemTemplate 对齐同一列宽）
          ├─ 列：名称(*) / 规格 spec(240) / 版本(120) / 状态(96)
          ├─ 未 installed 的行整行 Foreground=TextFillColorSecondaryBrush + 状态列 "未安装"
          └─ spec 以 `link:` 开头的行额外给一个 "外部引用" 徽标（避免用户误以为可随实例搬运）
```

| 关键规格 | 内容 |
|---|---|
| 组合包开关的乐观更新 | 先改本地 `ObservableCollection` 项 → 调后端 → 失败回滚并把 `error` 弹 toast |
| 安装进度 | `ProgressBar`（indeterminate）+ 实时日志（复用 §9.6 的 LogView，高度 160）+ 取消按钮（禁用，本版本后端无取消能力 → 按钮禁用并 ToolTip 说明） |
| `spec` 列不可用版本号替代 | 契约明确"不能用 node_modules 里读到的版本号代替"（`src/shared/contracts.ts:188-194`） |

**空态 / 加载态 / 错误态**
- 空：块 B 空 → "还没有本地插件" + "安装本地插件"按钮；块 C 空 → "没有额外依赖"。
- 加载：进入页面时一次性 `plugin.inventory` + `plugin.listLocal`（并发），期间内容区 indeterminate `ProgressBar`。
- 错误：安装失败 → `InfoBar Severity="Error"` + 可展开的原始输出（`AllowBuildsError.output` 场景：后端会**自动**重试一次，界面须在重试期间保持进度条并显示"正在重试"）；`PluginInstallResult.warnings` 非空 → `InfoBar Severity="Warning"` 逐条显示。

**数据来源**：`plugin.inventory` / `add` / `remove` / `setBundleEnabled` / `install` / `removeLocal` / `listLocal` / `pickArchive` / `pickFolder`。

---

### 9.4 P3 实例详情 · 设置

**职责**：`settings.yaml` 编辑（行号 + 脏标记 + 重新载入 + Ctrl+S）、隔离策略 4 维度、共享冲突解决、启动参数。

**官方控件**：`WebView2`（YAML 编辑器；降级用 `TextBox` + 行号列）、`RadioButtons`（4 个隔离维度各一组）、`ToggleSwitch`（`autoOpenBrowser`）、`TextBox`（`appArgs`）、`InfoBar`（共享冲突）、`ContentDialog`（冲突解决确认）、`Button`、`KeyboardAccelerator`、`Expander`、`BreadcrumbBar`。
**文件/目录选择器不自己实现**：本页不直接调 `FileOpenPicker`/`FolderPicker`，一律走契约里的 picker 通道由后端弹系统对话框并回传绝对路径（`plugin.pickArchive` / `plugin.pickFolder` / `pack.pickFile`，见 `src/shared/contracts.ts:658-660`、`677-680`）。

**布局骨架**

```
Grid[Auto, Auto, *]
├─ Row0: 页头（"设置" + BreadcrumbBar）+ 右侧操作区
│        ├─ 脏标记 TextBlock（Caption，"有未保存的更改"）
│        ├─ Button "重新载入"（脏时二次确认）
│        └─ Button "保存"（Accent，KeyboardAccelerator Key=S Modifiers=Control）
├─ Row1: InfoBar（共享冲突；Severity=Warning；ActionButton="解决冲突"）
└─ Row2: Grid[*, 360]   ← 左编辑器 / 右设置面板
    ├─ Col0: Grid[Auto,*]
    │   ├─ Row0: 工具栏 StackPanel(Horizontal)：路径 Caption（省略号+ToolTip）、"在资源管理器中打开"
    │   └─ Row1: YamlEditor
    │        ├─ 主路径：WebView2（Source = 应用内置编辑器页；SetVirtualHostNameToFolderMapping 或 NavigateToString 注入初始 YAML）
    │        │   通信：WebView2.WebMessageReceived ← 编辑器上报 { dirty, lineCount, save }；→ ExecuteScriptAsync 下发文档与主题
    │        │   初始化前必须 await EnsureCoreWebView2Async()
    │        │   DefaultBackgroundColor 取当前主题底色，避免白闪
    │        └─ 降级路径：Grid[Auto,*]（行号 TextBlock 只读 + TextBox AcceptsReturn TextWrapping=NoWrap，
    │                       FontFamily = Cascadia Mono, Consolas；滚动同步）
    └─ Col1: ScrollView > StackPanel(Spacing=24)
        ├─ Expander "隔离策略"（默认展开）
        │   ├─ RadioButtons 工作区：共享（junction 到 shared/workspaces/<dirName>）/ 独立
        │   ├─ RadioButtons 存档：共享 / 独立
        │   ├─ RadioButtons 设置：共享 / 独立
        │   └─ RadioButtons 凭证：继承主 home / 本实例独立
        │       每项下方一句 BodyTextBlockStyle 说明后果；切换前 ContentDialog 确认（涉及目录搬运）
        ├─ Expander "启动"
        │   ├─ ToggleSwitch 启动后自动打开界面
        │   ├─ TextBox 追加参数（PlaceholderText 示例；解析为 appArgs 数组）
        │   └─ TextBox 只读：本实例的 DSH_HOME / 工作目录（来自 LaunchResult）
        └─ Expander "危险操作"
            ├─ Button "删除实例"（Danger 语义：文字用 SystemFillColorCriticalBrush）
            └─ 依 LauncherConfig.confirmOnDelete 决定是否 ContentDialog 二次确认
```

| 关键规格 | 内容 |
|---|---|
| 脏标记与保存 | 编辑器上报 `dirty` → 页头显示；`Ctrl+S` 触发 `settings.write`；保存成功后清脏标记并 toast（Success） |
| 保存前不做"YAML 合法性"假保证 | 前端只标红可判定问题（空内容、行尾空白、明显缩进错误）；**不得**声称"YAML 合法"（真正的校验由后端 `profile.validateYaml` 给出） |
| 共享冲突必须显式解决 | `settings.shareConflicts` 返回非空 → `InfoBar` 常驻（`IsClosable=false`）+ `ActionButton` 打开 `ContentDialog`，两个动作对应 `use-local`（把本地推给共享）/ `use-shared`（用共享覆盖本地，后端会写备份）。**禁止**默认替用户选一侧 |
| 切换隔离维度 | 调 `instance.update`（`saves`/`settings`/`workspace`/`credentials`）；`workspace` 切到 `shared` 会创建 junction，必须先确认 |

**空态 / 加载态 / 错误态**
- 空：`settings.yaml` 不存在 → 编辑器显示空文档 + `InfoBar Severity="Informational"` 说明"保存时将新建"。
- 加载：进入页面并发 `settings.read` + `launcher.getConfig` + `settings.shareConflicts`；期间编辑器骨架（灰块）而非空白。
- 错误：`settings.read` 失败 → 内容区 `InfoBar Severity="Error"` + 重试按钮，编辑器禁用（**不得**显示空文档让用户误以为文件是空的）。
- 共享冲突存在且用户未解决 → 页面离开时提示（ContentDialog），避免"静默不生效"。

**数据来源**：`settings.read` / `write` / `shareConflicts` / `resolveShareConflict`、`instance.get` / `update` / `openFolder`、`launcher.getConfig`。

---

### 9.5 P4 实例详情 · 存档

**职责**：按 mtime 倒序列出 `sessions/` 存档，显示体积与 workspace 归属，可打开目录。

**官方控件**：`ListView`（虚拟化）、`ComboBox`（按 workspace 筛选）、`Button`、`InfoBar`、`BreadcrumbBar`、`⚠️` 分页控件不可用（`PagerControl` 为预览版，见 §6.2），故本页不做分页。

**布局骨架**

```
Grid[Auto, Auto, *]
├─ Row0: 页头（"存档" + BreadcrumbBar）+ 右侧："打开存档目录" Button
├─ Row1: 工具条：ComboBox（workspace 筛选）+ Caption（"共 N 个存档，合计 X"）
└─ Row2: ListView
     ├─ SelectionMode = Single（选中行显示"打开此存档"内联按钮；不进入详情页）
     └─ ItemTemplate: Grid[Auto,*,Auto,Auto,Auto]
         ├─ FontIcon（文件夹符号，SymbolThemeFontFamily）
         ├─ StackPanel: 会话 id(BodyStrong) + workspaceKey(Caption, Tertiary)
         ├─ "最近修改" 相对时间(autoOpenBrowser 无关；定时刷新)
         ├─ 体积（右对齐，TabularNums 风格用等宽或固定宽）
         └─ Button "打开" → saves.openFolder(instanceId, sessionId)
```

| 关键规格 | 内容 |
|---|---|
| 排序 | 由后端返回的 `updatedAt` 倒序**再排一次**（前端不信任顺序）；排序稳定 |
| 体积为 null | 显示 "—"，不显示 "0 B"（区分"未知"与"空"） |
| 相对时间 | 单一 `DispatcherQueueTimer`（1 s）批量刷新可见行文本，不使用每行一个定时器 |
| 空 workspace | 该 workspace 无存档时在筛选后给出行内空态，而不是整页空态 |

**空态 / 加载态 / 错误态**
- 空：整页空态"还没有存档" + 说明（存档在实例运行后产生）+ "启动实例"按钮。
- 加载：`ProgressBar` indeterminate 于工具条下缘。
- 错误：`saves.list` 失败 → 页级 `InfoBar Severity="Error"`；打开目录失败 → toast（附 `error` 原文）。

**数据来源**：`saves.list` / `saves.openFolder`、`instance.openFolder`。

---

### 9.6 P5 实例详情 · 日志

**职责**：增量渲染 + 行数上限，日志洪峰不能卡死；流过滤、清空、跟随底部、复制全部、打开日志目录。

**官方控件**：`ListView`（`ItemsStackPanel` 虚拟化）、`SelectorBar` 或 `ComboBox`（流过滤：全部/stdout/stderr/system）、`TextBox`（关键字过滤）、`ToggleSwitch`（跟随）、`Button`、`InfoBar`（"较早日志已截断"）、`BreadcrumbBar`、`AnnotatedScrollBar`（可选，快速跳段）。

**布局骨架**

```
Grid[Auto, Auto, *, Auto]
├─ Row0: 页头（"日志" + BreadcrumbBar）+ 右侧："打开日志目录" / "复制全部" Button
├─ Row1: 工具条 Grid[Auto,Auto,*,Auto,Auto]
│        ├─ SelectorBar      流过滤（全部 | stdout | stderr | system）
│        ├─ TextBox          关键字（实时，防抖 150ms）
│        ├─ （弹性空列）
│        ├─ ToggleSwitch     "跟随"（默认开）
│        └─ Button           "清空"
├─ Row2: LogView（本页与外壳抽屉复用同一控件；外露 API：Append(LogChunk[]) / Clear() / 暂停跟随）
│        ListView
│        ├─ ItemsPanel = ItemsStackPanel { ItemsUpdatingScrollMode = KeepLastItemInView }
│        ├─ SelectionMode = Extended（可多选复制）
│        ├─ 虚拟化与回收：默认开启（不要放进 StackPanel、不要设固定 Height 的 ItemsPanel）
│        └─ ItemTemplate: Grid[Auto, Auto, Auto, *]
│            ├─ 色条 Rectangle(宽 2，填充为流语义色)         ← 形/色双通道
│            ├─ 流标签 TextBlock(Caption，固定宽 56，如 "stderr")
│            ├─ 时间戳 TextBlock(Caption, Tertiary, 固定宽)
│            └─ 正文 TextBlock(Body, 等宽字族, TextWrapping=Wrap, TextTrimming 依设置)
│            （system 流行给 TextFillColorSecondaryBrush 与斜体不可用 → 用前缀 "· " 区分）
└─ Row3: 状态条：Caption "显示 N / 共 M 行" + 右侧 "较早日志已截断（已丢弃 K 行）"（InfoBadge 或纯文本）
```

**洪峰不卡死的硬性实现要求**

| 要求 | 具体做法 |
|---|---|
| 批量入队 | `log:chunk` 推送按帧合并：同一 `DispatcherQueue` 轮次内的多条 chunk 合成一次批量 `Append`（`⚠️ 自定`） |
| 增量追加 | 只追加新行，**不**重建整个 `ItemsSource` |
| 环形裁剪 | 达到渲染上限后按批移除最旧行；上限值 `⚠️ 自定`（沿用需求的 1500 行口径，需求来源见 `docs/review/frontend-survey-for-winui3.md` §2.2） |
| 跟随判定 | 仅当用户已在底部时自动滚动；用户上滚 → 暂停跟随并显示"回到底部"按钮（`ToggleSwitch` 同步为关） |
| 流过滤 | 过滤只改 `ItemsSource` 的视图（`CollectionViewSource` 或自维护过滤后的 `ObservableCollection`），**不**重新渲染全部行 |
| 禁止 | ⛔ `RichTextBlock`/`TextBlock` 无界堆叠；⛔ 每条日志一次 `DispatcherQueue.Invoke`；⛔ `UpdateLayout()` |

**空态 / 加载态 / 错误态**
- 空：无日志 → "暂无日志" + "启动实例后将在此显示"；若实例未运行且有历史日志文件 → 提供"读取历史日志"按钮。
- 加载：`ProgressBar` indeterminate（外壳右侧抽屉关闭时不渲染日志行，仅累积计数，打开时一次性填充）。
- 错误：日志文件读取失败 → `InfoBar Severity="Error"`；被截断 → `InfoBar Severity="Informational"` 常驻提示（`IsClosable=false`）。

**数据来源**：`log.chunk` / `log.state`（推送通道，唯二 main→renderer 推送）、`instance.openFolder`。

---

### 9.7 P6 引擎版本管理

**职责**：本地已安装引擎（占用实例、体积、目录）+ 可安装版本列表 + 内嵌实时安装日志 + 卸载前占用提示。

**官方控件**：`ListView`（已安装 / 可安装两个视图，用 `SelectorBar` 切换）、`ProgressBar`、`Button`、`ContentDialog`（卸载确认）、`InfoBar`、`Expander`（内嵌安装日志）、`LogView`（复用 §9.6 控件）、`TextBox`（registry 地址，来自全局设置但可在此临时覆盖？——**不**，registry 只在 P8 编辑）。

**布局骨架**

```
Grid[Auto, Auto, *, Auto]
├─ Row0: 页头（"引擎版本"）+ 右侧："刷新可用版本" Button + Node 运行时状态小徽标
├─ Row1: SelectorBar [ 已安装 | 可安装 ]  +  Caption "当前生效的 Node：<version>（<source>）"
├─ Row2: 内容
│   ├─ 已安装 ListView
│   │    ItemTemplate: Grid[Auto,*,Auto,Auto,Auto]
│   │      ├─ version (BodyLargeStrongTextBlockStyle)
│   │      ├─ 目录（Caption，省略号 + ToolTip）
│   │      ├─ 体积（右对齐）
│   │      ├─ 占用：usedBy.length == 0 ? "未被占用" : "被 N 个实例占用"（Caption；>0 时用 SystemFillColorCautionBrush）
│   │      └─ Button "移除"（usedBy.length > 0 → 禁用 + ToolTip 说明）
│   └─ 可安装 ListView
│        ItemTemplate: Grid[*,Auto]  版本号 + Button "安装"
│        （已安装的版本行显示"已安装"徽标 + 按钮禁用）
└─ Row3: Expander "安装日志"（安装开始时自动展开）
         └─ LogView（高 200）+ 右侧 ProgressBar（indeterminate）
```

| 关键规格 | 内容 |
|---|---|
| 安装中状态 | 被安装版本行的按钮变 `ProgressRing`（20×20）+ 文本"安装中"；同时**禁止**并发发起第二次安装（后端串行，前端也要挡住） |
| 移除占用提示 | `usedBy.length > 0` → 按钮禁用 + ToolTip "被 N 个实例占用：<名称列表>"；**不**允许"强制移除"（后端会拒绝） |
| Node 运行时缺失 | `engine.available` 依赖 npm；若 Node 探测失败 → 页级 `InfoBar Severity="Warning"` + 行动按钮"去全局设置修复" |
| 体积为 null | 显示 "—"（不显示 0） |
| 实时日志 | 与 P5 同一控件，独立缓冲；上限同上 |

**空态 / 加载态 / 错误态**
- 空：已安装为空 → "还没有安装任何引擎版本" + "安装最新版"按钮；可安装为空（离线/registry 不可达）→ "无法获取可用版本" + "重试" + `InfoBar Severity="Warning"` 附原因。
- 加载：`engine.list` 立刻出本地列表；`engine.available` 慢（走 npm view）→ 只让"可安装"页签显示 `ProgressBar`，不阻塞"已安装"页签。
- 错误：安装失败 → `InfoBar Severity="Error"` + 展开日志（`error` 原文可复制），按钮恢复可点。

**数据来源**：`engine.list` / `available` / `install` / `remove`、`launcher.getConfig`、`launcher.detectNode`、`log.chunk`。

---

### 9.8 P7 创建实例向导（4 步）

**职责**：四步向导（名称与外观 / 引擎版本 / profile 模板 / 隔离策略）+ 常驻摘要 + 提交进度。

**官方控件**：`SelectorBar`（步骤指示）、`Frame`/`Grid`（步骤内容）、`TextBox`、`RadioButtons`（图标/配色/模板/隔离）、`ComboBox`/`ListView`（引擎版本）、`NumberBox`（不用于向导）、`InfoBar`（校验与冲突）、`Button`、`ProgressBar`、`FontIcon`/`TextBlock`（emoji 与色板）。

**布局骨架**

```
Grid[Auto, *, Auto]
├─ Row0: 页头（"创建实例"）+ 步骤指示 SelectorBar（4 项：名称与外观 / 引擎版本 / profile 模板 / 隔离策略）
│        （SelectorBar 各项 IsEnabled：仅"已完成 + 当前 + 下一个"可点）
├─ Row1: Grid[*, 320]   ← 左：当前步骤内容；右：常驻摘要卡
│   ├─ Col0: ScrollView > Grid（4 个步骤面板，按当前步切 Visibility；切换时把焦点移到面板首个可聚焦控件）
│   │    ├─ 步骤1 名称与外观
│   │    │   ├─ TextBox 名称（Header="实例名称"；Description 说明可用字符；输入即校验）
│   │    │   ├─ TextBox 目录名（留空则自动派生；右侧"自动/手动"ToggleButton）
│   │    │   ├─ 图标选择：GridView（emoji 网格）或 FontIcon 网格，SelectionMode=Single
│   │    │   ├─ 配色选择：GridView（预设色点，色值来自系统强调色的明度派生）
│   │    │   └─ TextBox 备注（多行）
│   │    ├─ 步骤2 引擎版本
│   │    │   ├─ ListView 已安装版本（SelectionMode=Single）+ "刷新可用版本"
│   │    │   ├─ 未安装版本以次要色列出并标注"需先安装"
│   │    │   └─ 无可用引擎时：InfoBar Warning + "去引擎管理"链接（离开向导前须确认丢失输入）
│   │    ├─ 步骤3 profile 模板
│   │    │   └─ RadioButtons：web / headless / sdk / sdk-minimal / acp（每项附一句说明与包含的组合包）
│   │    └─ 步骤4 隔离策略
│   │        └─ 4 组 RadioButtons（工作区 / 存档 / 设置 / 凭证），默认值：工作区独立、其余共享
│   └─ Col1: 摘要卡（Border + CardBackgroundFillColorDefaultBrush，Sticky：随内容区滚动但自身不滚）
│        ├─ 头像预览（与 P1 卡片一致）
│        ├─ 名称 / 目录名 / 引擎版本 / 模板
│        └─ 4 项隔离策略的当前值（改动即时反映）
└─ Row2: 底部操作条：Button "取消" + Button "上一步" + Button "创建"（Accent）
         创建中：ProgressBar indeterminate + 按钮禁用 + 文案 "正在创建…"
```

| 关键规格 | 内容 |
|---|---|
| 命名校验 | 用后端同源规则做前端预校验（`names` 模块的派生规则）；**同一套规则**不得在前端另写一份不同实现 |
| 步骤可达性 | 未通过当前步校验不得进入下一步（`SelectorBarItem.IsEnabled`）；已完成的步骤可回退 |
| 提交 | 只调用一次 `instance.create`；成功后导航到 P1 并选中新实例（toast Success）；失败停在向导、保留全部输入、`InfoBar Error` 显示 `error` |
| 离开确认 | 有输入且未提交时离开向导 → `ContentDialog` 确认 |
| 键盘 | `Ctrl+Enter` = 创建（最后一步）；`Alt+←` = 上一步；`Esc` = 取消（有确认） |

**空态 / 加载态 / 错误态**
- 空：无可用引擎 → 步骤 2 空态 + 阻断（不能创建）；无模板（后端未返回）→ 步骤 3 用内置 `BUNDLE_TEMPLATES` 的五个模板名兜底（`src/shared/contracts.ts:705-708`）。
- 加载：`engine.list` + `launcher.getConfig` 并发；步骤内容显示骨架。
- 错误：创建失败 → 见上"提交"。

**数据来源**：`engine.list`、`instance.create`、`launcher.getConfig`、`plugin`（无）。

---

### 9.9 P8 全局设置

**职责**：主题 / 主 home 路径 / npm registry / 删除前确认 / Node 运行时探测面板 / 运行模式与数据位置。

**官方控件**：`ScrollView` + `StackPanel`、`RadioButtons` 或 `SelectorBar`（主题）、`TextBox`（路径 / registry）、`ToggleSwitch`、`Button`、`InfoBar`、`ListView`（Node 候选表）、`ProgressRing`（探测中）、`Expander`（高级）。

**布局骨架**

```
Grid[Auto, Auto, *]
├─ Row0: 页头（"全局设置"）+ 右侧："重新探测 Node" Button
├─ Row1: InfoBar（Node 探测失败 / registry 不可达 时 Warning 或 Error）
└─ Row2: ScrollView > StackPanel(Spacing=24, MaxWidth=1000, HorizontalAlignment=Left)
    ├─ Expander "外观"（默认展开）
    │   ├─ RadioButtons 主题：浅色 / 深色  ← 见下方"契约缺口"说明
    │   └─ （无字体大小设置：文本缩放交给系统设置，官方明确要求不要关掉）
    ├─ Expander "存储位置"（默认展开）
    │   ├─ TextBox 主 home 路径（只读展示 + "更改"Button → 目录选择）
    │   ├─ Caption 只读：启动器根目录（LauncherConfig.rootDir）
    │   └─ Caption：数据位置说明（instances / engines / logs / cache / shared）
    ├─ Expander "引擎与网络"（默认展开）
    │   ├─ TextBox npm registry
    │   └─ TextBox Node 可执行文件路径（launcher.json 的 nodePath；留空 = 自动探测）+ "浏览"Button
    ├─ Expander "Node 运行时"（默认展开）
    │   ├─ 顶部结论行：FontIcon(成功/失败) + NodeRuntimeReport.message
    │   ├─ ListView 候选表（ItemTemplate 列：file(*) / source(120) / version(100) / ok 徽标 / reason(240)）
    │   │    不可用候选整行 TextFillColorSecondaryBrush，reason 省略号 + ToolTip
    │   └─ 探测中：ProgressRing（IsActive=True）+ 表格禁用
    └─ Expander "危险操作"（默认折叠）
        ├─ ToggleSwitch 删除前二次确认（confirmOnDelete）
        └─ Button "打开应用数据目录"
```

| 关键规格 | 内容 |
|---|---|
| **主题三选一的契约缺口** | 官方范式是"跟随系统 / 浅色 / 深色"（`ElementTheme.Default/Light/Dark`），但 `LauncherConfig.theme` 只允许 `'dark' \| 'light'`（`src/shared/contracts.ts:414`）。**本规范要求**：先向 Lead 申请把契约扩展为 `'system' \| 'dark' \| 'light'`；在扩展落地前，UI 只提供两项，并显示一句 `Caption` 说明"主题跟随你的选择，不跟随系统"。⛔ 不得用 `Default` 悄悄冒充"浅色" |
| 主 home 路径变更 | 影响凭证继承；变更前 `ContentDialog` 说明影响面 |
| registry 变更 | 只影响后续 `engine.available` / `engine.install`；变更后不自动刷新列表（避免副作用），提示可手动刷新 |
| Node 探测 | `launcher.detectNode(true)` 忽略缓存重探；探测期间按钮变 `ProgressRing`（20×20）；结果直接展示 `NodeRuntimeReport.candidates` 的每一条 reason（契约明确"用户据此知道为什么不能用"，`src/shared/contracts.ts:454-473`） |
| 设置项保存 | 每项独立保存（`launcher.setConfig` patch），成功即 toast（Success）；失败回滚控件值并 toast（Error） |

**空态 / 加载态 / 错误态**
- 空：`candidates` 为空 → "未发现任何 Node 候选" + 手动指定路径入口。
- 加载：`launcher.getConfig` 未返回前显示骨架；探测中只禁用探测区。
- 错误：`setConfig` 失败 → 回滚 + toast；`openFolder` 失败 → toast（附原因）。

**数据来源**：`launcher.getConfig` / `setConfig` / `detectNode`、`app.version`、`app.openExternal`。

---

### 9.10 浮层（对话框 / Toast / 右键菜单）

#### 9.10.1 对话框（`ContentDialog`）

| 场景 | 按钮配置 | 默认按钮 | 出处/依据 |
|---|---|---|---|
| 删除实例 | `PrimaryButtonText="删除实例"` + `CloseButtonText="取消"` | 不设默认（避免误触回车删除） | `[LRN:dialogs]`「Use the CloseButton API to add this button」「You may optionally choose to differentiate one of the three buttons as the dialog's default button.」 |
| 共享冲突解决 | `PrimaryButtonText="使用共享覆盖本地"` + `SecondaryButtonText="把本地推给共享"` + `CloseButtonText="稍后处理"` | `ContentDialogButton.Close` | `[LRN:dialogs]`（三按钮用法与"要少用"）；`ContentDialogButton` 枚举 |
| 切换隔离策略（涉及搬运/建 junction） | `PrimaryButtonText="继续"` + `CloseButtonText="取消"` | `Close` | 同上 |
| 安装插件来源选择 | 用 `ContentDialog` 承载 `RadioButtons` + `PrimaryButtonText="下一步"` + `CloseButtonText="取消"` | `Primary` | 同上 |
| 关于 | `CloseButtonText="关闭"` | — | 同上 |

**硬性规则**
- 必须设 `XamlRoot`（取所在页 `this.XamlRoot`；从 `Window` 发起时取窗口根元素）。`[LRN:dialogs]`「set the `XamlRoot` property on the `ContentDialog` before calling `ShowAsync`. If you don't set…（失败）」
- **必须显式设 `RequestedTheme`**，取窗口根元素（外壳的 `RootGrid`）的当前主题 —— 实测 `ContentDialog` **不继承**它：对话框渲染在 XamlRoot 的浮层（PopupRoot）上，不是窗口根元素的可视树，外壳把主题设在 `RootGrid` 上时对话框仍按系统主题绘制（表现为"深色窗口弹出浅色对话框"，见 §11 U21）。`Services/DialogService.cs` 已统一处理；**任何新增对话框都应经它构造**，不要各处 `new ContentDialog`。
- **同一窗口同时只能有一个 `ContentDialog`**；需要"多级"时改成"单对话框内换内容"，不要叠加。`[LRN:dialogs]`「There can only be one ContentDialog open per window at a time. Attempting to open two content dialogs will throw an exception.」
- 尺寸由内置键约束：最小宽 320、最大宽 548、最大高 756。`[KEY:generic.xaml]`
- 圆角取 `OverlayCornerRadius`（8）。`[LRN:rounded-corner]`

#### 9.10.2 应用内轻提示（Toast）

> ⛔ **WinUI 无内置 in-app Toast 控件**（见 §6.6）。以下为本项目自定规范。

| 规格 | 值 |
|---|---|
| 位置 | 应用窗口右上角，顶部偏移 = 标题栏高 48 + 8 = 56；右边距 24 |
| 堆叠 | 纵向堆叠，最多 3 条；第 4 条入队挤掉最旧（或被顶掉的最旧直接移除） |
| 宽度 | 320–480（4 的倍数），`MaxWidth=480` |
| 圆角 / 高度 | `OverlayCornerRadius`（瞬态表面）+ Elevation 32（"Flyout"档） |
| 时长 | 成功 4 s；信息 6 s；失败**不自动消失**，需手动关闭（失败必须能被复制） |
| 内容 | `FontIcon`(状态) + 标题(BodyStrongTextBlockStyle) + 正文(Body, 可展开) + 关闭按钮 + 可选的"复制错误"按钮 |
| 语义色 | 成功 = `SystemFillColorSuccessBrush`；警告 = `SystemFillColorCautionBrush`；失败 = `SystemFillColorCriticalBrush`；信息 = `SystemFillColorAttentionBrush` |
| 动效 | 进场 `ControlNormalAnimationDuration` + `ControlFastOutSlowInKeySpline`；退场 `ControlFastAnimationDuration` + `cubic-bezier(1,0,1,1)` |
| 可访问性 | 容器不拦截点击（`IsHitTestVisible=False`，单条 `True`）；错误 toast 用 `AutomationProperties.LiveSetting` 礼貌播报 |
| 去重 | 同一文案 500 ms 内只显示一次（避免错误风暴刷屏） |

新方案来源：位置/时长/去重为 `⚠️ 自定`；色键见 §3.2；时长与曲线见 §7.5；高度档位见 §5.3。

#### 9.10.3 右键菜单

| 场景 | 控件 | 菜单项 |
|---|---|---|
| P1 实例卡片 | `CommandBarFlyout` | 启动/停止（主）· 打开界面 · 打开目录（子菜单：根/主目录/工作区/日志/插件）· 编辑 · 导出包 · 删除 |
| P5 日志行 | `CommandBarFlyout` | 复制选中行 · 复制全部 · 按此行过滤 · 清除过滤 |
| P2 插件行 | `MenuFlyout` | 打开目录 · 查看 package.json · 删除 |
| P3 编辑器 | `TextCommandBarFlyout`（由编辑器自身提供） | 撤销/重做/剪切/复制/粘贴/全选 |
| P4 存档行 | `MenuFlyout` | 打开 · 在资源管理器中定位 · 复制路径 |

- 键盘等价：`Shift+F10` / 菜单键必须能唤出同一菜单（框架默认支持，实现者只需保证菜单挂在正确的元素上）。
- 禁用项用 `IsEnabled=False`（不要隐藏，避免菜单项数量跳动）。
- 出处：`[API:controls/dev/CommandBarFlyout/CommandBarFlyout.idl]`（`CommandBarFlyout` / `TextCommandBarFlyout`）；`[KEY:generic.xaml]` L23779（`MenuFlyoutPresenter` 默认样式）。

---

## 10. 证据索引

> 回源方式：
> - `MUX:<path>` → `https://raw.githubusercontent.com/microsoft/microsoft-ui-xaml/main/<path>`（读数 commit `da997f8a2314b538a766dc4e66afce2646781a66`）
> - `LRN:<slug>` → `https://learn.microsoft.com/en-us/windows/apps/design/<slug>`（具体 URL 见对应行的"出处 URL"列）
> - `KEY` 类键名 → 在下列 XAML 定义文件中可 `grep` 到

| # | 规格条目 | 出处类型 | 出处（可回源） | 原文/键值摘录 |
|---|---|---|---|---|
| E01 | 4 epx 网格；gutter 12/24 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/layout/alignment-margin-padding | 「all dimensions, margins, and padding should be in increments of 4 epx」「For small window widths (less than 640 pixels), we recommend 12 epx gutters, and for larger window widths, we recommend 24 epx gutters.」 |
| E02 | Margin 累加、禁用负 Margin | LRN | 同上 | 「Margins are additive.」「using a negative margin can often cause clipping, or overdraws of peers」 |
| E03 | 圆角 4/8 与两个全局资源 | LRN + KEY | https://learn.microsoft.com/en-us/windows/apps/design/style/rounded-corner；`controls/dev/CommonStyles/CornerRadius_themeresources.xaml` | 「The default corner radii are controlled by two global resources: `ControlCornerRadius` (default 4px) and `OverlayCornerRadius` (default 8px)」；文件内 `<CornerRadius x:Key="ControlCornerRadius">4,4,4,4</CornerRadius>`、`<CornerRadius x:Key="OverlayCornerRadius">8,8,8,8</CornerRadius>` |
| E04 | 三主题与主题字典选择顺序 | LRN + MUX | https://learn.microsoft.com/en-us/windows/apps/design/style/xaml-theme-resources；`docs/design-notes/resources.md` | 「There are 3 themes that the XAML framework supports: "Light", "Dark", and "HighContrast"」；「If the system is in high contrast mode: The dictionary with key HighContrastWhite or HighContrastBlack is used… If nothing found yet, the dictionary with key Light or Dark… If nothing found yet, the dictionary with key Default is used.」 |
| E05 | 每个 Color 键有对应 SolidColorBrush 键；`TextFillColorPrimaryBrush` 定义 | LRN + KEY | 同上；`controls/dev/CommonStyles/Common_themeresources_any.xaml` L88 / L292 / L416 | 「there's a corresponding SolidColorBrush resource for every Color resource」；`<SolidColorBrush x:Key="TextFillColorPrimaryBrush" Color="{StaticResource TextFillColorPrimary}" />`（Dark/Light）/ `Color="{ThemeResource SystemColorWindowTextColor}"`（HighContrast） |
| E06 | 画刷一律用 `{ThemeResource}`；不允许在控件里直引底层键 | MUX | `docs/design-notes/xaml-styling-guide.md` | 「We **almost always** use `ThemeResource` to reference brush keys.」「Even though `TextFillColorPrimaryBrush` has all themes set … we should **never reference it directly in the control**.」 |
| E07 | 自建字典必须 Light/Dark/HighContrast 齐备，用 `ResourceKey` 转引 | MUX + LRN | `docs/design-notes/xaml-styling-guide.md`；https://learn.microsoft.com/en-us/windows/apps/design/style/xaml-theme-resources | `<StaticResource x:Key="TitleBarForegroundBrush" ResourceKey="TextFillColorPrimaryBrush" />`；「it's preferred to be explicit and instead use "Light", "Dark", and "HighContrast"」 |
| E08 | 字阶 9 个样式键与字号 | KEY + LRN | `controls/dev/CommonStyles/TextBlock_themeresources.xaml`；https://learn.microsoft.com/en-us/windows/apps/design/style/xaml-theme-resources | `CaptionTextBlockFontSize=12`、`BodyTextBlockFontSize=14`、`BodyLargeTextBlockFontSize=18`、`SubtitleTextBlockFontSize=20`、`TitleTextBlockFontSize=28`、`TitleLargeTextBlockFontSize=40`、`DisplayTextBlockFontSize=68`；`BodyStrongTextBlockStyle`/`BodyLargeStrongTextBlockStyle`/`TitleTextBlockStyle` 等样式定义 |
| E09 | 字阶的行高与字重（官方表） | LRN | https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography | 「Small 12/16 epx」「Text 14/20 epx」「Text semibold 14/20」「Text 18/24」「Display semibold 20/28」「28/36」「40/52」「68/92」 |
| E10 | 最小字号 / 只用 Regular+Semibold / 句首大写 / 行长 / 截断 | LRN | 同上 | 「Minimum values: 14px Semibold, 12px Regular」「Bold and Italic styles are not part of the Windows type ramp. Use Semibold instead of Bold」「Sentence case」「Keep to 50–60 letters per line」 |
| E11 | 字族 Segoe UI Variable 与字重轴 | LRN | 同上 | 「Segoe UI Variable is the new system font for Windows」「When using XAML common controls, the Segoe UI Variable font will be selected by default」 |
| E12 | `ContentControlThemeFontFamily` / `SymbolThemeFontFamily` / `ControlContentThemeFontSize` | KEY | `dxaml/xcp/dxaml/themes/generic.xaml` L14 / L20 / L36（Light: L2796/L2802/L2818；HighContrast: L3939/L3945/L3961） | `<FontFamily x:Key="ContentControlThemeFontFamily">XamlAutoFontFamily</FontFamily>`、`<FontFamily x:Key="SymbolThemeFontFamily">Segoe Fluent Icons,Segoe MDL2 Assets</FontFamily>`、`<x:Double x:Key="ControlContentThemeFontSize">14</x:Double>` |
| E13 | `UseSystemFocusVisuals` 默认 True；焦点框仅键盘态绘制 | KEY + MUX | `dxaml/xcp/dxaml/themes/generic.xaml` L1525；`docs/design-notes/focus.md` | `<x:Boolean x:Key="UseSystemFocusVisuals">True</x:Boolean>`；「Xaml draws the focus rect when the focused element's FocusState is "Keyboard"」 |
| E14 | 焦点描边色键 | KEY | `controls/dev/CommonStyles/Common_themeresources_any.xaml` L54-L55 / L144-L145 | `<Color x:Key="FocusStrokeColorOuter">#FFFFFF</Color>`、`<Color x:Key="FocusStrokeColorInner">#B3000000</Color>`（Dark）；Light 为 `#E4000000` / `#B3FFFFFF` |
| E15 | 语义色 4 档（InfoBar Severity） | API + KEY | `controls/dev/InfoBar/InfoBar.idl` L14-L20；`Common_themeresources_any.xaml` L76-L79 | `enum InfoBarSeverity { Informational = 0, Success = 1, Warning = 2, Error = 3 };`；`SystemFillColorSuccess=#6CCB5F`、`SystemFillColorCaution=#FCE100`、`SystemFillColorCritical=#FF99A4`（Dark） |
| E16 | 卡片 / 层 / 遮罩 / 实色底色的键与值 | KEY | `controls/dev/CommonStyles/Common_themeresources_any.xaml` L56-L75 / L146-L164 | `CardBackgroundFillColorDefault=#0DFFFFFF`、`LayerFillColorDefault=#4C3A3A3A`、`SmokeFillColorDefault=#4D000000`、`SolidBackgroundFillColorBase=#202020`、`SolidBackgroundFillColorBaseAlt=#0A0A0A`（Dark） |
| E17 | Mica 的两层用法、降级色与降级条件 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/style/mica | 「The content layer should pick up the material behind it, Mica, using the `LayerFillColorDefaultBrush`」「Mica materials will appear as a solid fallback color (`SolidBackgroundFillColorBase` for Mica, `SolidBackgroundFillColorBaseAlt` for Mica Alt) when: …」 |
| E18 | Acrylic 用于瞬时表面；禁止强调色文字；禁止边对边拼接 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic | 「for transient UI elements」「We don't recommend placing accent-colored text on your acrylic surfaces」「try not to place multiple pieces of acrylic edge-to-edge」 |
| E19 | WinUI 3 中桌面 Acrylic 只能挂 Window/DesktopWindowXamlSource；`SystemBackdrop` 挂载点 | MUX | `docs/design-notes/mica-desktop-acrylic.md` | 「desktop Acrylic can only be applied to `Window` and `DesktopWindowXamlSource` objects」「Attached to the tree via `Window`/`DesktopWindowXamlSource`/`Popup`'s `SystemBackdrop` property」 |
| E20 | Elevation 数值表（Window 128 / Dialog 128 / Flyout 32 / Tooltip 16 / Card 8 / Control 2 / Layer 1；描边宽 1；Rest 2 / Hover 2 / Pressed 1） | LRN | https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/layering | 同左（Elevation 与 Controls 两段表） |
| E21 | 两层体系（base = 菜单/命令/导航；content = 中心体验） | LRN | 同上 | 「The base layer … contains controls related to app menus, commands, and navigation.」「The content layer focuses the user on the app's central experience.」 |
| E22 | 提升描边三个渐变画刷键 | MUX | `docs/design-notes/xaml-styling-guide.md`（Elevation Border Brushes 段） | `ControlElevationBorderBrush`（`StartPoint="0,0"` `EndPoint="0,3"`，`ControlStrokeColorSecondary` 0.33 → `ControlStrokeColorDefault` 1.0）、`AccentControlElevationBorderBrush`、`CircleElevationBorderBrush` |
| E23 | 动效时长资源键 | MUX + LRN | `docs/design-notes/xaml-styling-guide.md`；https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing | `<x:String x:Key="ControlNormalAnimationDuration">00:00:00.250</x:String>`、`…Fast…167`、`…Faster…083`、`ControlFastOutSlowInKeySpline` = `0,0,0,1`；LRN「ControlNormalAnimationDuration 250ms」 |
| E24 | 进出场缓动曲线 | LRN | 同上 | 「Fast Out, Slow In `cubic-bezier(0, 0, 0, 1)` Use for objects or UI entering the scene」「Slow Out, Fast In `cubic-bezier(1 , 0 , 1 , 1)` Use for UI or objects that are exiting the scene.」 |
| E25 | `NavigationView` 三段自适应与两个阈值（默认 640/1008） | LRN + API | https://learn.microsoft.com/en-us/windows/apps/design/controls/navigationview；`controls/dev/NavigationView/NavigationView.idl` | 「An expanded left pane on large window widths (1008px or greater). A left, icon-only, nav pane (LeftCompact) on medium window widths (641px to 1007px). Only a menu button (LeftMinimal) on small window widths (640px or less).」；`Double CompactModeThresholdWidth`/`ExpandedModeThresholdWidth` |
| E26 | `NavigationView` Header 固定 52 px、内容边距 12/24 | LRN | 同上 | 「It has a fixed height of 52 px.」「We recommend 12px margins for your content area when NavigationView is in Minimal mode and 24px margins otherwise.」 |
| E27 | `NavigationViewDisplayMode` / `NavigationViewPaneDisplayMode` 枚举成员 | API | `controls/dev/NavigationView/NavigationView.idl` L6-L31 | `enum NavigationViewDisplayMode { Minimal = 0, Compact = 1, Expanded = 2 };`、`enum NavigationViewPaneDisplayMode { Auto = 0, Left = 1, Top = 2, LeftCompact = 3, LeftMinimal = 4 };` |
| E28 | `AlwaysShowHeader` / `IsTitleBarAutoPaddingEnabled` / `IsSettingsVisible` / `MenuItems` / `FooterMenuItems` | API | 同上 L183/L190/L194/L292 | 同左 |
| E29 | `SplitView` 支持左右两侧、四种模式、默认收拢宽 48 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/controls/split-view | 「can present itself from either the left side or right side of an app window」「The pane has four modes: Overlay / Inline / CompactOverlay / CompactInline」「The default closed pane width is 48px, which can be modified with CompactPaneLength.」 |
| E30 | 导航用 NavigationView、抽屉用 SplitView | LRN | 同上 | 「The split view control can be used to create any "drawer" experience」「If you'd like to build a navigation menu … then use the NavigationView control.」 |
| E31 | `TitleBar` 控件 API（Title/Subtitle/IconSource/LeftHeader/Content/RightHeader/IsBackButtonVisible/IsPaneToggleButtonVisible/BackRequested/PaneToggleRequested） | API | `controls/dev/TitleBar/TitleBar.idl` L9-L47（`[MUX_PUBLIC_V8]`） | 同左 |
| E32 | 标题栏高 48；`ExtendsContentIntoTitleBar` 必须代码设置；`PreferredHeightOption` 前置条件 | KEY + LRN | `TitleBar_themeresources.xaml`（经 MUX 摘录）；https://learn.microsoft.com/en-us/windows/apps/develop/title-bar | `TitleBarCompactHeight`=32 / `TitleBarExpandedHeight`=48；`<Grid x:Name="AppTitleBar" Height="48">`；「setting it in XAML causes an error. Set this property in code instead.」「must be `true` before you set the `PreferredHeightOption` property」 |
| E33 | 标题栏拖拽区与激活态可见性要求 | LRN | 同上 | 「Do define a drag region along the top edge of the app canvas. Matching the placement of system title bars makes it easier for users to find.」「Do make it obvious when your window is active or inactive.」 |
| E34 | `MenuBar` / `MenuBarItem` / `MenuBarItemFlyout` 存在且公开 | API | `controls/dev/MenuBar/MenuBar.idl` L6/L14/L28（均 `[MUX_PUBLIC]`） | 同左 |
| E35 | `CommandBarFlyout` / `TextCommandBarFlyout` 存在且公开 | API | `controls/dev/CommandBarFlyout/CommandBarFlyout.idl` L7/L22 | 同左 |
| E36 | `SelectorBar` / `SelectorBarItem` 与 `[MUX_PUBLIC_V6]` | API | `controls/dev/SelectorBar/SelectorBar.idl` L31-L41 | `unsealed runtimeclass SelectorBar : Control { IVector<SelectorBarItem> Items; SelectorBarItem SelectedItem; event … SelectionChanged; }` |
| E37 | `ItemsViewSelectionMode` 成员与 `ItemsView` API | API | `controls/dev/ItemsView/ItemsView.idl` L6-L72（`[MUX_PUBLIC_V5]`） | `enum ItemsViewSelectionMode { None = 0, Single = 1, Multiple = 2, Extended = 3 };` |
| E38 | `ItemsView` 缺 header/footer/增量加载；`ListView`/`GridView` 缺 flow layout / 可插拔 Layout / 可插拔滚动控制器 / 自定义回收池 / 滚动曲线控制 / 自定义集合变更动画 | MUX | `docs/design-notes/ItemsView-ItemContainer-overview.md` | 「it has no built-in support for: grouping, sticky group headers, progressive data consumption through the ISupportIncrementalLoading, ICollectionView data sources, header and footer, edge-scrolling, drag & drop」「The ListView & GridView do not support: flow layouts …, pluggable layouts, pluggable scrolling controllers …, custom recycling pools, programmatic control of scrolling/zooming curves, custom collection change animations」 |
| E39 | `ListView`/`GridView` 能力（虚拟化、回收池、header/footer、粘性组头、锚定、`SelectionMode`） | MUX | `docs/design-notes/ListView-GridView-overview.md` L380-L412 | 「UI virtualization through the use of virtualizing panels, with progressive buffer filling, up to ListViewBase.DataFetchSize or ItemsStackPanel/ItemsWrapGrid.CacheLength」「item recycling, with a recycling pool」「item anchoring through the use of the ItemsStackPanel.ItemsUpdatingScrollMode property」 |
| E40 | **不要把虚拟化列表放进 StackPanel** | MUX | 同上 L439-L440 | 「Placing a ListView/GridView into a StackPanel turns off its potential virtualization, since the StackPanel uses an infinite available size for its stacking direction. It's a recurring performance trap for our customers.」 |
| E41 | `[MUX_PREVIEW]` 禁用清单：`TableView` / `PagerControl` / `WrapPanel` / 部分 `ItemsRepeater` 类型 / `InfoBarOpenedEventArgs` / 部分 `NumberBox`·`ScrollView`·`TeachingTip` 成员 | API | `controls/dev/TableView/TableView.idl`（全 `[MUX_PREVIEW]`）、`controls/dev/PagerControl/PagerControl.idl`、`controls/dev/WrapPanel/WrapPanel.idl`、`controls/dev/Repeater/ItemsRepeater.idl`、`controls/dev/InfoBar/InfoBar.idl` L37、`controls/dev/NumberBox/NumberBox.idl` L61/L70/L112/L121、`controls/dev/ScrollView/ScrollView.idl` L136/L138、`controls/dev/TeachingTip/TeachingTip.idl` L138 | 同左（逐行 `[MUX_PREVIEW]` 标记） |
| E42 | `TreeView` / `Expander` / `BreadcrumbBar` / `InfoBadge` / `RadioButtons` / `NumberBox` / `TeachingTip` 公开可用 | API | `controls/dev/TreeView/TreeView.idl`、`Expander.idl`、`Breadcrumb/BreadcrumbBar.idl`、`InfoBadge.idl`（`[MUX_PUBLIC_V3]`）、`RadioButtons.idl`、`NumberBox/NumberBox.idl`、`TeachingTip/TeachingTip.idl` | 同左 |
| E43 | `ContentDialog`：每窗口仅一个、必须设 `XamlRoot`、按钮角色与 `DefaultButton`、Esc/手柄 B 走 Close | LRN | https://learn.microsoft.com/en-us/windows/apps/design/controls/dialogs-and-flyouts/dialogs | 「There can only be one ContentDialog open per window at a time. Attempting to open two content dialogs will throw an exception.」「you need to manually set the `XamlRoot`」「Use the ContentDialog.DefaultButton property to indicate the default button」「pressed ESC, Gamepad B, or the system back button」 |
| E44 | `ContentDialog` 尺寸上限键 | KEY | `dxaml/xcp/dxaml/themes/generic.xaml` L38-L41 | `ContentDialogMinWidth`=320、`ContentDialogMaxWidth`=548、`ContentDialogMaxHeight`=756 |
| E45 | `ProgressBar`/`ProgressRing` 的确定/不确定语义与 ProgressRing 最小 20×20 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/controls/progress-controls | 「The indeterminate state for ProgressBar shows that an operation is underway, does not block user interaction」「The indeterminate state for ProgressRing shows that an operation is underway, blocks user interaction」「can only be as small as 20x20epx」「you must set the IsActive property to true」 |
| E46 | 列表加载只在顶部放一条 `ProgressBar` | LRN | 同上 | 「do not put a progress indicator on each list item as they appear. Instead, use a ProgressBar and place it at the top of the collection」 |
| E47 | 键盘加速键 API 与"不可共享"、`ScopeOwner`、`AutomationProperties.AcceleratorKey` | LRN | https://learn.microsoft.com/en-us/windows/apps/design/input/keyboard-accelerators | 「`KeyboardAccelerator` is not shareable, the same KeyboardAccelerator can't be added to multiple elements.」「The ScopeOwner attribute … marks the accelerator as scoped instead of global」「Setting `AutomationProperties.AcceleratorKey` doesn't enable keyboard functionality」 |
| E48 | Tab 顺序 / `IsTabStop` / `XYFocusKeyboardNavigation` / 方向键策略 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/input/focus-navigation | 「`TabIndex` to specify the order in which elements receive focus」「All interactive controls support Tab key navigation by default」「`XYFocusKeyboardNavigation="Enabled"`」「`XYFocusUpNavigationStrategy` …」 |
| E49 | 手柄导航默认开启（进程级） | MUX | `docs/design-notes/gamepad-navigation.md` | 「the framework enables gamepad key routing for the process」「respond to the gamepad automatically, with no additional code in your app」 |
| E50 | 对比度 4.5:1；高对比不作为主要手段 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessible-text-requirements | 「visible text must have a minimum luminance contrast ratio of 4.5:1 against its background」「Do not treat high-contrast mode as the primary mitigation for low readability.」 |
| E51 | 文本缩放默认开启、`TextScaleFactor` 范围 [1,2.25]、受影响类型 | LRN | 同上 | 「`IsTextScaleFactorEnabled`, which defaults to `true`」「`TextScaleFactor` is a `double` in the range [1,2.25]」「These types have an `IsTextScaleFactorEnabled` property: ContentPresenter / Control …」 |
| E52 | 高对比：背景基线、瞬态表面 2px 边框、四个内置主题都要测 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/accessibility/high-contrast-themes | 「Use SystemColorWindowColor as the background baseline」「We recommend using 2px borders for transitory surfaces such as flyouts and dialogs」「Test your app in all four built-in contrast themes while it is running.」 |
| E53 | `AutomationProperties` 成员全集 | API | https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.automation.automationproperties | 成员：`AcceleratorKey`、`AccessibilityView`、`AutomationId`、`ControlledPeers`、`DescribedBy`、`FlowsFrom`、`FlowsTo`、`HeadingLevel`、`HelpText`、`IsDialog`、`IsRequiredForForm`、`ItemStatus`、`ItemType`、`LabeledBy`、`LandmarkType`、`LiveSetting`、`Name`、`PositionInSet`、`SizeOfSet` |
| E54 | `AutomationProperties.Name` / `LabeledBy` / `HelpText` / `AccessibilityView` 用法 | LRN | https://learn.microsoft.com/en-us/windows/apps/design/accessibility/basic-accessibility-information | 「`AutomationProperties.Name`」「Labels and LabeledBy」「`AutomationProperties.HelpText`」「`AutomationProperties.AccessibilityView`」 |
| E55 | `AutomationId` 在模板里显式给出 | KEY | `dxaml/xcp/dxaml/themes/generic.xaml` L12810 / L12893 / L12954 / L13018 | `<Setter Property="AutomationProperties.AutomationId" Value="DatePickerFlyoutPresenter" />` 等 |
| E56 | `PositionInSet`/`SizeOfSet` 必须与数据顺序一致 | LRN | https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/items-repeater | 「users minimally expect that the values for the PositionInSet and SizeOfSet properties used by screen readers will match the order the items appear in the data」 |
| E57 | `VisualStateManager` 状态名、`{ThemeResource}` 取值、不同组不得改同一元素 | MUX | `docs/design-notes/xaml-styling-guide.md` | 「the most generic `VisualStateGroup` is `CommonStates` and contains visual states such as `Normal`, `PointerOver`, `Pressed`, `Disabled`」「Property values should always reference a defined ThemeResource or StaticResource」「different visual state groups **cannot** modify the same element」 |
| E58 | 禁止 code-behind 改视觉；动画放模板（`ExpanderTemplateSettings.ContentHeight`） | MUX | 同上 | 「it is best practice to never modify a control's visual with codebehind」「Instead of animating `ExpanderContent` to the its calculated height value in codebehind, the animation is kept in the template」 |
| E59 | 禁止 `UpdateLayout()`；布局循环风险；`MaxLayoutDepth = 250` | MUX | `docs/design-notes/Layout-overview.md` | 「Avoid the use of UIElement.UpdateLayout as it can lead to layout cycles.」「cannot exceed MaxLayoutDepth = 250 or an E_FAIL error is returned」 |
| E60 | `ScrollView` 与 `ScrollViewer` 的能力差异 | MUX | `docs/design-notes/ScrollView-overview.md` | 「The ScrollView does not support header elements. The ScrollViewer does not support customization of its inertia curve.」 |
| E61 | `{ThemeResource}` 与 `{StaticResource}` 的解析差异与查找顺序 | MUX | `docs/design-notes/resources.md` | 「Once a matching key is found, the search stops」「MergedDictionary search starts with the last merged dictionary」「ThemeResource references can be reevaluated when…」 |
| E62 | `TitleTextBlockStyle` 字号冲突（generic.xaml 24 vs MUXC 28）与官方查找顺序（最终采用 28） | MUX | `dxaml/xcp/dxaml/themes/generic.xaml` L13268；`controls/dev/CommonStyles/TextBlock_themeresources.xaml` L40；`docs/design-notes/styles.md` | 「CControl's search goes to FrameworkStyles, which first includes the "global theme resources", MUX's generic.xaml. If a hit is found we _do not stop_ there. We search all of Application.Resources for an override … which will come back to MUXC and find another hit.」 |
| E63 | 内部样式 `EmptyStateHyperlinkStyle` 存在但无公开承诺（故不采用） | MUX | `docs/design-notes/styles.md` | 「like in an "EmptyStateHyperlinkStyle" style for HyperlinkButton, which defines only four alignment/font/background properties」 |
| E64 | 手柄/Mica/Acrylic 之外：`SystemBackdrop` 是 Mica 与桌面 Acrylic 的公开挂载入口 | MUX | `docs/design-notes/mica-desktop-acrylic.md` | 「`Microsoft.UI.Xaml.Media.SystemBackdrop` is the base class for the Xaml exposure of Composition's `SystemBackdropController`」 |
| E65 | 系统通知（Toast）能力与桌面注册成本（本项目不采用） | LRN | https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-quickstart | `AppNotificationManager.Default.Show(...)`、`AppNotificationManager.Default.Register()`、`<desktop:ToastNotificationActivation ToastActivatorCLSID="..."/>` |
| E66 | `WebView2` 控件 API（`EnsureCoreWebView2Async` / `NavigateToString` / `DefaultBackgroundColor` / `WebMessageReceived`） | API | `controls/dev/WebView2/WebView2.idl` L17-L51 | 同左 |
| E67 | `ProgressRing` 必须同时设 Height/Width | LRN | https://learn.microsoft.com/en-us/windows/apps/design/controls/progress-controls | 「if only height or width are set, the control will assume minimum sizing (20x20epx) – conversely if the height and width are set to two different sizes, the smaller of the sizes will be assumed」 |
| E68 | 窗口最小尺寸 API | API | https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter.preferredminimumwidth | `OverlappedPresenter.PreferredMinimumWidth` / `PreferredMinimumHeight`（`Microsoft.UI.Windowing`）；已知问题见 microsoft/microsoft-ui-xaml#10475 |
| E69 | 契约事实（`Result<T>`、`InstanceState`、`InstanceSummary.problem`、`LauncherConfig.theme` 仅 dark\|light、`PluginEntry.spec`、`ShareConflict`、`NodeRuntimeReport`、`MenuNode`、39 条通道） | 仓库内 | `src/shared/contracts.ts`（L19-22、L108-129、L141-148、L188-194、L410-429、L454-473、L505-524、L530-546、L552-617、L623-693） | 同左 |
| E70 | 功能需求清单（8 页需要哪些功能；含日志行数上限 1500 的需求口径） | 仓库内 | `docs/review/frontend-survey-for-winui3.md` §2.1–§2.3、§5.1、§10 | 「`logview.ts`（285）… **增量渲染**（只追加新行，`MAX_RENDERED = 1500` 后批量裁剪旧行…）」等（**仅作为功能需求来源，不取其 UI 设计**） |

**证据索引条数：70 条。**

---

## 11. 无法查证项清单

> 以下条目**本次未找到官方出处**，或**找到了 API/文档但未逐项核对可用性**。实现者使用前必须自行回源确认；本规范对它们要么给出显式自定方案，要么明确标注为待验证。

| # | 条目 | 状态 | 本规范的处理 |
|---|---|---|---|
| U01 | 「应用内 Toast」的官方 WinUI 控件 | ❌ 官方无此控件（`controls/dev/` 无 Toast/Notification） | 已给出自定方案（§6.6、§9.10.2），标注 `⚠️ 自定` |
| U02 | 「空态（EmptyState）」的官方 WinUI 控件 | ❌ 官方无公开控件 | 自绘（§6.6），标注 `⚠️ 自定` |
| U03 | 「向导 / Stepper」的官方 WinUI 控件 | ❌ 官方无此控件 | 用 `SelectorBar` 表达步骤（§6.3），标注 `⚠️ 自定` |
| U04 | 「代码 / YAML 编辑器（行号 + 语法着色）」的官方 WinUI 控件 | ❌ 官方无此控件 | WebView2（Monaco/CodeMirror）+ `TextBox` 降级（§6.5），标注 `⚠️ 自定` |
| U05 | 「日志视图」的官方 WinUI 控件 | ❌ 官方无专用控件 | `ListView` + `ItemsStackPanel` + 环形裁剪自建（§9.6），标注 `⚠️ 自定` |
| U06 | 日志渲染行数上限的具体数值（如 1500） | ❌ 无官方出处 | 沿用需求口径，标注 `⚠️ 自定`（需求来源 E70） |
| U07 | 「减少动效」的系统开关的官方 WinUI 3 对应物 | ❌ 未在本次取证范围内找到官方指引 | 约定用 `UISettings.AnimationsEnabled`（§7.5），标注 `⚠️ 自定` |
| U08 | `TitleBar.Content` 槽内放 `MenuBar` 的官方示例 | ⚠️ API 合法但无官方组合示例 | 标注 `⚠️ 自定`（§2.2） |
| U09 | 间距档位 4/8/12/16/24/32 的具体分配 | ⚠️ 官方只给"4 epx 整数倍"与"12/24 gutter" | 档位分配标注 `⚠️ 自定`（§2.1） |
| U10 | 图标尺寸档位（16/20/24/32） | ⚠️ 无官方档位表 | 标注 `⚠️ 自定`（§5.4） |
| U11 | 日志抽屉宽度 480、卡片宽 320、toast 宽 320–480 / 时长 4s·6s / 去重 500ms | ⚠️ 无官方出处 | 全部标注 `⚠️ 自定`（§9.1、§9.2、§9.10.2） |
| U12 | `MUX_PUBLIC_Vn` 与 Windows App SDK 具体版本的映射表 | ⚠️ 未逐一核对 | 要求实现者在锁定的 WinAppSDK 2.5.1 上实测（§0.2）；本规范只确保"不带 `[MUX_PREVIEW]`" |
| U13 | `OverlappedPresenter.PreferredMinimumWidth/Height` 的稳定性 | ⚠️ API 存在，但 microsoft/microsoft-ui-xaml#10475 记录了已知问题 | 要求实测三条路径（§2.3） |
| U14 | `ItemsStackPanel.ItemsUpdatingScrollMode = KeepLastItemInView` 在窗口缩小时的行为 | ⚠️ 官方 bug 清单记录了该问题 | 要求实测（§7.6） |
| U15 | `AutomationProperties.HeadingLevel` / `LiveSetting` / `LandmarkType` 的实际播报效果 | ⚠️ 成员存在性已核对，效果未实测 | 具体取值标注 `⚠️ 自定`（§8.1） |
| U16 | 卡片/accent 配色的具体色板（图标与配色选择器提供的预设值） | ⚠️ 无官方出处 | 约束为"必须从系统强调色的明度派生"（§9.2、§9.8），具体列表由实现者决定，标注 `⚠️ 自定` |
| U17 | 中文界面的"句首大写"是否需要本地化调整 | ⚠️ 官方规则面向英文 | 中文文案沿用既有措辞，不做大小写处理（§4.3） |
| U18 | `LauncherConfig.theme` 缺少 `'system'` 取值 | ⚠️ 契约缺口（非"查不到出处"，而是**产品/契约层面待决策**） | 已显式上报（§3.4、§9.9），要求先报 Lead 再扩展契约 |
| U19 | 取消引擎安装 / 取消插件安装的后端能力 | ⚠️ 契约无取消通道 | UI 的"取消"按钮禁用并 ToolTip 说明（§9.3、§9.7） |
| U20 | 前后端"命名校验规则"在 C# 侧重实现的可行性 | ⚠️ 未评估（后端规则在 TS `core/names.ts`） | 要求"同一套规则、不得两份实现"（§9.8）；实现方式由 Lead 定 |
| U21 | `ContentDialog` 是否继承窗口根元素的 `RequestedTheme` | ❌ **实测不继承**（本机：外壳为深色时对话框仍按系统浅色绘制） | 由 `Services/DialogService.cs` 显式把窗口主题传给每个对话框（`RequestedTheme = 窗口根元素.RequestedTheme`），见 §9.10.1 |
| U22 | 「环境自检」的报告呈现形态 | ❌ 官方无对应控件；本规范 §9.9 亦未涉及 | 自定：`Controls/PreflightReportView`（页面内联 + 首启对话框共用），逐项状态走"色 + 图标 + 文字"三通道（§8.2） |

**无法查证项合计：22 条**（其中 7 条为"官方确无对应控件"的取舍项，1 条为契约缺口，1 条为产品能力缺口，其余为数值/参数级自定项）。

---

## 12. 实现者自检清单（提交前逐条打勾）

**出处纪律**
- [ ] 我写的每个资源键名都能在本文件 §3.2 / §4.2 / §5 找到（或能从 §10 证据索引回源）。
- [ ] 我没有引入任何 `MUX_PREVIEW` API（对照 §6 的 ⛔ 清单：`TableView` / `PagerControl` / `WrapPanel` / `RecyclePool` / `LinedFlowLayout*` / `InfoBarOpenedEventArgs` / `NumberBox` 与 `ScrollView`、`TeachingTip` 的预览成员）。
- [ ] 我没有自定义 hex 颜色，没有自定义字号。

**布局**
- [ ] 所有 `Margin` / `Padding` / 尺寸都是 4 的整数倍。
- [ ] 页面根 `Padding` 随窗口 640 epx 切换为 24 / 12。
- [ ] 没有把虚拟化列表放进 `StackPanel`；没有调 `UpdateLayout()`。

**主题**
- [ ] 所有画刷用 `{ThemeResource}`；我新建的资源字典有 `Light` / `Dark` / `HighContrast` 三份。
- [ ] 内容层背景用了 `LayerFillColorDefaultBrush`（或卡片用 `CardBackgroundFillColorDefaultBrush`）。
- [ ] Mica 在标题栏区域可见；窗口失焦时标题栏文字/图标有变化。

**交互**
- [ ] 焦点框来自系统（未自绘、未关 `UseSystemFocusVisuals`）。
- [ ] 每个加速键都是独立 `KeyboardAccelerator` 实例（未在多元素间复用）。
- [ ] 所有 `ContentDialog` 都设了 `XamlRoot`，且没有嵌套/并发打开。
- [ ] `ProgressRing` 的 `Height` 与 `Width` 成对设置且 ≥ 20，`IsActive="True"`。

**可访问性**
- [ ] 图标按钮有 `AutomationProperties.Name`；输入有 `Header` 或 `LabeledBy`。
- [ ] 正文对比度 ≥ 4.5:1；状态不靠单一颜色。
- [ ] 未全局关闭 `IsTextScaleFactorEnabled`；固定高容器改用 `MinHeight`。
- [ ] 四个内置对比主题 + 文本缩放 150% 各走查一遍。

**页面**
- [ ] 每页都有明确的空态 / 加载态 / 错误态（§9.0 契约）。
- [ ] `InstanceSummary.problem` 已显示（契约硬性要求）。
- [ ] 每个 `Result.ok === false` 都被呈现（至少 toast，必要时 `InfoBar`），没有任何错误只进日志。

---

*本规范由 W0-SPEC 任务产出，写入范围仅限本文件。任何偏离须经 Lead 裁决后回写本文件。*
