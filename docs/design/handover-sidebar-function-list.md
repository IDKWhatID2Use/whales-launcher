# 交接文档：外壳左栏改为「功能列表」

> 交接对象：下一位负责实现的 agent（WinUI 3 / C# 侧）。
> 本文所有结论都已核对过源码与测试脚本，**实测行号会随改动漂移，请以符号名（类名 / 方法名 / x:Name）为主、行号为辅**。
> 视觉基准（已由用户确认样式）：[docs/design/demo/ui-function-nav.html](../design/demo/ui-function-nav.html)

---

## 0.1 实施状态：已完成

唯一需要用户拍板的 §2.2 选了**方案 A**（新增独立 `AboutPage` + `RouteKeys.About`）。四个切片的落地与验证：

| 切片 | 落地内容 | 验证 |
|---|---|---|
| ① 外壳左栏 | `MainWindow.xaml`：删 `Grid.Resources`（模板 + 4 个状态点 `Style`）、`MenuItemTemplate`、`PaneHeader`，改为静态 `MenuItems`（实例 / 引擎版本管理 / 全局设置）+ `FooterMenuItems`（关于），每项设 `AutomationProperties.Name`；`MainWindow.xaml.cs`：删 `_rail` / `RebuildRail` / `OnInstanceFilterChanged` / `_currentParameter`，`OnNavSelectionChanged` 改按 `Tag` 分发，新增 `SyncNavSelection`（路由 → 选中项），返回按钮恢复"仅详情页"；删除 `Shell/InstanceRail.cs`、`Shell/RailEntry.cs`、`Shell/RailEntryKind.cs`（`InstanceStateText.DotStyleKey` 随之失去引用，一并删除，只留 `Label`） | `dotnet build` **0 错误 0 警告** |
| ② 面包屑 + 关于页 | 新增 `RouteKeys.About` + `Views/AboutPage.xaml(.cs)` + `NavigationService.Resolve` 映射 + `SubtitleFor("关于")` + 深链 `about`；`DetailBreadcrumb` 改三段可点击，**数据源仍是 `List<string>`、只按下标分发**，所以 **P3（record `ToString()` 泄漏）不可能复发** | 深链 `about` 实测：副标题、五项内容、左栏「关于」选中态全部正确 |
| ③ UI 测试 | `shell.ps1`：SH-01 改**负向断言**（左栏不再出现实例名）、SH-09 改**负向断言**（`InstanceFilter` 必须不存在）、SH-02 改按 `AutomationProperties.Name` 精确匹配四项，**新增 SH-10（功能页 ↔ 实例页互跳，旧左栏没有实例入口的回归保护）与 SH-11（「关于」是可导航页面而非弹框）**；`labels.mjs` 删无引用的 `railItemTypeName` / `railNewInstance`、补 `railInstances` / `railAbout` / `railEntries` / `subtitleAbout`；`p8-settings.ps1` 兜底从 `FooterMenuItemsHost` 改 `MenuItemsHost` 并按名字定位 | `npm run test:ui` 全套 **73 断言 / 0 失败**（1 项 unverifiable 是 P6-04，依赖 npm registry，与本次无关），shell **11/11** |
| ④ 文档 | 视觉规范 §2.2 §6.1 §9.1（含选中态、图标、窗口按钮配色三条规格）、guide 五篇、交付报告 L1/L5/L7、`architecture.md`、`README.md`、`report-notes.mjs`（DEFECT-3 标注左栏那一半已消失） | 与实现逐一核对 |

### 0.2 过程中顺带修掉的测试基建缺陷（都不是本次改造引入的）

1. **`UiDriver.psm1#Get-UiDescendants` 的 `FindAll` 会瞬时抛 E_FAIL**（实测在 SH-07 切完主题后必现），一个异常就把整个用例带崩。现在异常退回函数里**本来就有**的 TreeWalker 兜底。
2. **同函数原先"`FindAll` 只要返回非空就直接用它"**，而本应用的 provider 对子作用域并不稳定（同一文件早已记载 `MenuItemsHost` 对 `FindAll` 返回 0 后代）。改为 **`FindAll` + TreeWalker 合并、按 runtime id 去重**，查找不再取决于当帧拿到哪种形状。
3. **`run-ui-tests.mjs` spawn 用例进程时显式删除 `WHALES_SMOKE_ROUTE` / `WHALES_LAUNCHER_ROOT`**，避免上游环境泄漏让应用静默打开别的页面（曾观察到一次 SH-08 因此报"副标题是「关于」"）。

### 0.3 用户验收时新报的两处缺陷（已修）

1. **关于页把许可证写成了 MIT** —— 实际是 **Polyform Noncommercial License 1.0.0**（仓库 `LICENSE` 与 `README` 都是这个，只有这一页写错）。已改为准确表述，并在页面里点明"该许可证不是 OSI 认证的开源许可证"。
2. **深色模式下标题栏右上角三个窗口按钮几乎不可见** —— 这三个按钮**不是窗口内容**，由系统按**系统主题**绘制，不跟随 `RootGrid.RequestedTheme`；深色窗口跑在浅色系统上时字形与标题栏同为暗色。修法：按**当前生效主题**显式设置 `AppWindowTitleBar.Button*Color`（注意 API 在 `AppWindowTitleBar` 上，**不是** XAML `TitleBar` 控件的属性）。深色实测截图已确认三个按钮清晰可见。

### 0.4 遗留（不在本次改动范围）

- **§7.2 的教程截图未重新生成**：`docs/assets/tutorial/*.png` 仍是左栏改造前的版本（图里的左栏还列着实例、还有「筛选实例」输入框），与当前实现不一致。用户明确表示这块由其自行处理，本次不再触碰。
- 重新取证时暴露的两个**截图工具**缺陷已一并修好（`scripts/tutorial/tour.ps1`：`FindAll` → 合并双视图遍历 `Get-UiaCandidates`；`clickcenter` 改为 pattern 优先、坐标点击兜底；`ChildName` 兼容"元素自身即该名字"）。修好之后**尚未完整重跑过五份 plan**，下次重跑时请留意。

---

## 0. 一句话任务

把主窗口左侧导航栏从「实例列表 + 两个底部入口」改成**固定的功能列表**（实例 / 引擎版本管理 / 全局设置，底部固定「关于」），**实例列表只保留在「实例」页内**（现有卡片网格不动）。

改动落在 `desktop/src/WhalesLauncher.App`（WinUI 3 外壳），**不动 Node 侧车（`desktop/bridge`）、不动契约（`src/shared/contracts.ts`）**。

---

## 1. 背景：为什么改

现状（`MainWindow.xaml` 的 `InstanceRailItemTemplate` + `Shell/InstanceRail.cs`）把**实例列表画在左栏**，而同一个实例列表又以卡片网格出现在内容区 —— 同一批数据在屏幕上出现两次，用户明确指出的问题就是**功能元素重复**（左栏底部已有「引擎版本管理 / 全局设置」，而实例行与实例页的卡片表达同一件事）。

同时它带来一个已被登记的缺陷链：

- `MainWindow.xaml.cs` 的 `OnFrameNavigated` 注释（现约 L606-610）写明：**§9.1 的左栏没有「实例列表」入口，所以如果按规范把返回按钮限制在详情页，P6/P7/P8 之后就没有任何路径回到实例列表（P1 不可达）** —— 当时的权宜之计是把返回按钮放宽成"任何非首屏路由且可后退"。
- `docs/winui3-重构交付报告.md` 的 L5 登记了同一个根因的另一面：**P1 停在实例列表时左栏无选中高亮**（因为左栏没有"实例列表"这一项）。

左栏改成功能列表后，这两处都自然消解：**「实例」这一项在实例页就是选中态**，从引擎 / 设置页返回也有明确入口。

---

## 2. 已确认的决策 / 未决问题

### 2.1 已确认（用户已拍板，照做即可）

| # | 决策 | 说明 |
|---|---|---|
| D1 | 左栏是**纯功能导航**，不再承载实例列表 | 实例 / 引擎版本管理 / 全局设置 |
| D2 | 实例列表移入「实例」页 | 卡片网格、导入实例包 / 刷新 / 新建实例按钮、页内搜索 / 状态筛选 / 排序**全部保留原样** |
| D3 | 左栏顶部的「筛选实例」`AutoSuggestBox` **删除** | 它与实例页内的搜索框（`InstancesPage.xaml` 的 `SearchBox`，宽度 320）重复 |
| D4 | 左栏底部**固定保留「关于」** | 不是可选项 |
| D5 | 图标：三个功能图标统一 16 px 描边风格；**设置用标准齿轮** | 见 §5 与 §6.4 |
| D6 | **选中项只染左侧 3 px 指示条 + 字重**，图标保持主文字色 | 不要给选中图标上强调色（深色主题下会出现突兀的亮色图标） |
| D7 | 实例头像色底必须是**实例色 10% 透明淡底** | 与 `InstanceCardPaint.Tint` 的 `0x1A` 同源；**不得**改成不透明浅色 hex（深色模式下会变成亮色方块、符号头像不可读） |

### 2.2 未决（需要向用户确认后再定，二选一）

**「关于」点下去是什么？** 演示稿实现成了独立页面（标题栏副标题「关于」），但真实应用里「关于」目前是从**应用菜单 → 帮助 → 关于 WhalesLauncher** 弹出的对话框（`desktop/bridge/menu.mjs` 的 `help.about`）。

- **方案 A（演示稿形态，推荐）**：新增一个 `AboutPage` 并注册路由 `RouteKeys.About`，放进 `NavigationView.FooterMenuItems`，点它有选中态。
- **方案 B（保持对话框）**：左栏底部不放可选项。注意：**若坚持放进去，它会被 `NavigationView` 当作可选中项**（点一次弹框却留下选中高亮，语义错误）。正确做法是**不放进 `FooterMenuItems`**，而是在 pane 底部另放一个不可选中的 `Button`（视觉上贴着底部）。
- 若选 B 但图省事只把 `help.about` 命令在左栏触发一次，必须显式处理"不产生选中态"。

> 交接时请先问用户。文档其余部分按**方案 A** 给出改动清单（方案 B 只需把 §5.4 的 AboutPage 换成"底部 Button + 复用 AppMenuCommand('help.about')"）。

---

## 3. 视觉基准

| 项 | 值 | 来源 |
|---|---|---|
| 左栏项 | 图标 16 px + 文字 14 px，项高 40，圆角 5，左右内边距 12 | 演示稿；真实左栏现有行模板 `MinHeight="40"` |
| 选中态 | 背景 `NavigationViewItemBackgroundSelected`（框架默认）+ 左侧 3×16 圆角强调色指示条 + 文字 Semibold | 演示稿；**框架自带**，不要自绘 |
| 左栏宽度 | 让 `NavigationView.OpenPaneLength` 保持框架默认（演示稿按 280 px 画，仅供观感参照） | — |
| 底部「关于」 | 固定在 pane 最底部 | 演示稿 |
| 图标语言 | 16 px、1.25 px 描边、`currentColor` | 演示稿（HTML 里用 SVG，**真实实现请用 Segoe Fluent Icons 字形**，不要引入 SVG 资产） |

**演示稿里的 SVB 图标只是"形状示意"，不是要抄的资产**：真实实现用 `FontIcon Glyph="&#xE713;"` 这类字形即可（见 §5.1 的推荐片段）。落地后请**截图核对**三个图标在深浅两套主题下的观感。

---

## 4. 现状代码地图（改之前先看这些）

| 文件 | 现在的职责 | 本次命运 |
|---|---|---|
| `MainWindow.xaml`（约 359 行） | 标题栏 + `SplitView` 日志抽屉 + `NavigationView`；其中 L31-148 是 `Grid.Resources`：4 个状态点 `Style`（L33-44）+ `InstanceRailItemTemplate`（L52-147） | 模板与点样式**整体删除**；删 `MenuItemsSource` / `MenuItemTemplate` / `PaneHeader`；菜单项改成 XAML 静态声明 |
| `MainWindow.xaml.cs`（约 729 行） | 外壳编排：`_rail`（L38）、构造里装配（L71-77）、`RebuildRail`（L482-533）、`OnInstanceFilterChanged`（L535-536）、`OnNavSelectionChanged`（L538-574）、`SyncRailSelection`（L577-594）、`OnFrameNavigated` 的返回按钮权宜（L600-613） | 上述实例栏相关成员**全部删除或改写**；返回按钮恢复成"仅详情页" |
| `Shell/InstanceRail.cs`（148 行） | 左栏数据源：按实例 + 筛选词重建 `ObservableCollection<object>` | **退役（删除）** |
| `Shell/RailEntry.cs`（148 行） | 左栏一行（实例 / 新建实例 / 分隔线 / 无匹配 / 底部入口）+ 显示开关 | **退役（删除）** |
| `Shell/RailEntryKind.cs` | 行类型枚举 | 若无人引用则删除；`RailEntryKind` 仍在 `Console` 之外被引用的地方要一并清 |
| `Shell/InstanceStateText.cs` | 状态 → 中文标签 / 状态点样式键 | **保留**（实例卡片、详情页也要用）；确认 `DotStyleKey` 若无引用可留 |
| `Services/NavigationService.cs`（107 行） | `RouteKeys` / `DetailTabs` / `Frame.Navigate` 封装 | 保留；方案 A 时**新增** `RouteKeys.About` |
| `Views/InstanceDetailPage.xaml(.cs)` | 详情页外壳：页头 + InfoBar + 4 页签 `SelectorBar` + `TabHost` | 加面包屑入口；返回按钮语义调整 |
| `Views/Detail/DetailBreadcrumb.cs`（27 行） | 面包屑只给字符串列表（只读，类注释解释了为什么不做点击） | 改为**可点击**（见 §5.4） |
| `Views/InstancesPage.xaml(.cs)` | 实例页：页头 + 工具条 + InfoBar 区 + 卡片网格 + 两套空态 | **基本不动**（它就是实例列表的新家）。可选：页头描述微调 |
| `Controls/PageHeader.xaml` | 统一页头（标题 + 说明 + Actions） | 不动 |
| `Shell/AppMenuBuilder.cs`、`Shell/LogDrawer.cs`、`Shell/ShellHostMethods.cs` | 应用菜单 / 日志抽屉 / 宿主方法 | **不动** |

---

## 5. 目标实现方案（逐文件改动清单）

### 5.1 `MainWindow.xaml`

**删除**

1. `Grid.Resources` 里的 4 个 `Style`：`RailDotRunning` / `RailDotTransitional` / `RailDotCrashed` / `RailDotStopped`（L33-44）。
2. `InstanceRailItemTemplate`（L52-147，含其大段类注释 —— 那段注释解释的"自容器项会被套模板"问题在新方案下不复存在，可整体删或**精简后移到 §6.3 的说明位置**）。
3. `NavigationView` 上的 `MenuItemTemplate="{StaticResource InstanceRailItemTemplate}"`（L329）。
4. `NavigationView.PaneHeader` 整块（L332-339，即 `InstanceFilter` `AutoSuggestBox`）——**决策 D3**。

**新增**（替换 `MenuItemsSource` 的数据绑定方案）

```xml
<muxc:NavigationView
    x:Name="Nav"
    AlwaysShowHeader="False"
    IsBackButtonVisible="Collapsed"
    IsSettingsVisible="False"
    IsTitleBarAutoPaddingEnabled="False"
    PaneDisplayMode="Auto"
    SelectionChanged="OnNavSelectionChanged">

    <!-- 左栏 = 功能列表（静态声明，不再走 MenuItemsSource + MenuItemTemplate） -->
    <muxc:NavigationView.MenuItems>
        <muxc:NavigationViewItem x:Name="NavInstances" Content="实例" Tag="instances"
                                 AutomationProperties.Name="实例">
            <muxc:NavigationViewItem.Icon>
                <FontIcon Glyph="&#xE8FD;" /><!-- List：候选 E8FD / E71D / E8A9，落地后截图核对 -->
            </muxc:NavigationViewItem.Icon>
        </muxc:NavigationViewItem>
        <muxc:NavigationViewItem x:Name="NavEngines" Content="引擎版本管理" Tag="engines"
                                 AutomationProperties.Name="引擎版本管理">
            <muxc:NavigationViewItem.Icon>
                <FontIcon Glyph="&#xE71D;" /><!-- AllApps：与现在底部入口使用的字形一致，避免观感回归 -->
            </muxc:NavigationViewItem.Icon>
        </muxc:NavigationViewItem>
        <muxc:NavigationViewItem x:Name="NavSettings" Content="全局设置" Tag="settings"
                                 AutomationProperties.Name="全局设置">
            <muxc:NavigationViewItem.Icon>
                <FontIcon Glyph="&#xE713;" /><!-- Setting：标准齿轮 -->
            </muxc:NavigationViewItem.Icon>
        </muxc:NavigationViewItem>
    </muxc:NavigationView.MenuItems>

    <!-- 底部固定「关于」（方案 A） -->
    <muxc:NavigationView.FooterMenuItems>
        <muxc:NavigationViewItem x:Name="NavAbout" Content="关于" Tag="about"
                                 AutomationProperties.Name="关于 WhalesLauncher">
            <muxc:NavigationViewItem.Icon>
                <FontIcon Glyph="&#xE946;" /><!-- Info -->
            </muxc:NavigationViewItem.Icon>
        </muxc:NavigationViewItem>
    </muxc:NavigationView.FooterMenuItems>

    <Grid Background="{ThemeResource LayerFillColorDefaultBrush}">
        <Frame x:Name="ContentFrame" />
    </Grid>
</muxc:NavigationView>
```

要点：

- **`AutomationProperties.Name` 必设** —— UI 测试脚本按名字定位（见 §7.1），这同时修掉 `docs/audit/ui-test-report.md` 里登记的 DEFECT-3（左栏项 UIA `Name` 是 CLR 类型名 `WhalesLauncher.Shell.RailEntry`）。改成静态 `NavigationViewItem` 后这个缺陷**自动消失**。
- 「实例」项**暂不加数量角标**（演示稿里有个 `7`）。要加就再议，别顺手做。
- 不要动 `TitleBar` 的 `IsPaneToggleButtonVisible="False"`：pane 的折叠按钮由 `NavigationView` 自带（就是演示稿左栏顶部那个 ☰）。

### 5.2 `MainWindow.xaml.cs`

**删除**

| 成员 | 说明 |
|---|---|
| `_rail` 字段（L38） | 连同 `new InstanceRail(RootGrid.Resources)`（L71-73） |
| `Nav.MenuItemsSource = _rail.Items;`、`Nav.FooterMenuItemsSource = _rail.FooterItems;`（L72、L77） | 静态声明后不再需要 |
| `RebuildRail()`（L482-533，约 50 行） | **整段删除**：这是"NavigationView 在 ItemsSource 被替换后会自动选中第一项"的对抗代码（`_syncingSelection` + 排到 `Low` 优先级再收敛一次）。静态项不再重建集合，这个坑随之消失 —— **这是本次改动的净收益，别保留"以防万一"** |
| `OnInstanceFilterChanged`（L535-536） | 筛选框已删 |
| `OnNavSelectionChanged`（L538-574） | 改为按 `Tag` 分发（见下） |
| `SyncRailSelection`（L577-594） | 改为按当前路由设置 `Nav.SelectedItem`（见下） |
| `LoadStartupStateAsync` 与 `WaitForBackend` 里的 `RebuildRail()` 调用（L427、L389） | 删除对应调用；后端仍未就绪的提示 toast 保留 |

**改写**

```csharp
// 选中项 → 路由（Tag 是路由键，与 RouteKeys 一致）
private void OnNavSelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
{
    if (_syncingSelection) return;
    if (args.SelectedItem is not NavigationViewItem item) return;

    switch (item.Tag as string)
    {
        case RouteKeys.Instances: _navigation.Navigate(RouteKeys.Instances); break;
        case RouteKeys.Engines:   _navigation.Navigate(RouteKeys.Engines);   break;
        case RouteKeys.Settings:  _navigation.Navigate(RouteKeys.Settings);  break;
        case RouteKeys.About:     _navigation.Navigate(RouteKeys.About);     break;   // 方案 A
        default: SyncNavSelection(); break;
    }
}

// 路由 → 选中项（详情页归属「实例」功能；实例列表页也选中「实例」）
private void SyncNavSelection()
{
    var previous = _syncingSelection;
    _syncingSelection = true;
    try
    {
        Nav.SelectedItem = _currentRoute switch
        {
            RouteKeys.Instances or RouteKeys.Detail => NavInstances,
            RouteKeys.Engines => NavEngines,
            RouteKeys.Settings => NavSettings,
            RouteKeys.About => NavAbout,
            _ => null,
        };
    }
    finally { _syncingSelection = previous; }
}
```

**`OnFrameNavigated`（L600-613）**：删掉那条"放宽返回按钮"的权宜逻辑与其大段注释，恢复规范 §6.1：

```csharp
AppTitleBar.IsBackButtonVisible = ContentFrame.CanGoBack && _currentRoute == RouteKeys.Detail;
```

**`OnInstancesChanged`（L460-464）**：`RebuildRail()` 删除；**`_logDrawer.RebuildSources()` 必须保留**（日志抽屉的来源下拉依赖实例列表）。

**`SubtitleFor`（L628-636）**：新增 `RouteKeys.About => "关于"`。

### 5.3 退役 `Shell/InstanceRail.cs` / `Shell/RailEntry.cs` / `Shell/RailEntryKind.cs`

- 三个文件整体删除（`RailEntryKind` 若被别处引用，先清引用再删）。
- `Shell/InstanceStateText.cs` **保留**。
- 删除后请全仓搜索确认没有残留引用：`InstanceRail`、`RailEntry`、`RailEntryKind`、`InstanceFilter`、`MenuItemTemplate`、`MenuItemsSource`、`FooterMenuItemsSource`。

### 5.4 详情页面包屑 + 「关于」页（方案 A）

**面包屑可点击**：`Views/Detail/DetailBreadcrumb.cs` 现在返回 `List<string>`，类注释明确说明"只读，不做跳转"，理由是"上级（实例列表）已由页头返回按钮承担"。左栏改造后这条理由不再成立 —— 面包屑给了更强的"我在哪 / 怎么上去"的信息，且与左栏「实例」选中态呼应。建议：

- 把第一段「实例」做成可点击（回到 `RouteKeys.Instances`）；
- 中间段实例名点击 → 该实例的默认页签（`DetailTabs.Plugins`）；
- 末段（页签名）不可点。
- 实现上可以把 `List<string>` 换成 `List<BreadcrumbNode>` + `ItemTemplate`，**但务必注意**：`BreadcrumbBar` 无 `ItemTemplate` 时按 `ToString()` 渲染，历史上曾因此把 `record` 的结构文本（`BreadcrumbNode { Label = test1, … }`）直接泄漏到界面上 —— 见 `docs/winui3-重构交付报告.md` 里登记的 **P3 缺陷**（该报告 §3 的 P3 行 + 开头缺陷清单第 3 条）。要自定义对象就**必须**配 `ItemTemplate`。

**新增 `Views/AboutPage.xaml(.cs)` + `RouteKeys.About`**（`NavigationService.Resolve` 加一条映射）：

- 页头用 `Controls/PageHeader`（标题「关于」，说明一行）；
- 内容建议：版本（`app.version` 后端通道已有）、前端 / 业务引擎、启动器目录、以及"开源许可 / 文档入口"。**不要**为了凑内容自己发明字段；
- 左栏副标题：`SubtitleFor` 里加 `"关于"`；
- 若最终选方案 B（对话框）：**不要**放进 `FooterMenuItems`，按 §2.2 处理。

### 5.5 视觉规范同步（必做，否则文档与实现立刻漂移）

`docs/design/winui3-visual-spec.md` §9.1（约 L601-664）：

- L629 `PaneHeader = AutoSuggestBox("筛选实例")` → 删除；
- L630-637 `MenuItemsSource = ObservableCollection<InstanceRow>` + `MenuItemTemplate`（含头像/状态点描述）→ 替换为"静态 `NavigationViewItem` 功能列表（实例 / 引擎版本管理 / 全局设置）+ 底部「关于」"；
- L637 `FooterMenuItemsSource = [引擎版本管理, 全局设置]` → `FooterMenuItems = [关于]`（★ 这一行是**移动**，不是新增：引擎与设置上移到主区）；
- L660 空态："无实例：P1 空态 + 左栏 `MenuItemsSource` 只剩『新建实例』" → 改为"无实例：左栏不变（功能列表与实例数量无关）；实例页显示空态 A"；
- L620 `IsBackButtonVisible = 详情页 True / 其它 False` → 与 §5.2 的实现对齐（现在是权宜版，改完就一致了）；
- §9.2 P1 段落里若提到"左栏"，一并改。

---

## 6. 必须遵守的既有约束与坑（前车之鉴）

### 6.1 规范 §6.1：禁止在 code-behind 手工往 `NavigationView.MenuItems` 塞 `NavigationViewItem`

本次方案是**在 XAML 里静态声明**，这**不违反** §6.1（它针对的是 code-behind 动态塞项、丢掉模板可替换性）。这一点如果被 review 质疑，请直接把本行连同 §6.3 一起引用：静态声明 + 框架默认模板正是规范想要的方向。

### 6.2 主题相关画刷必须走 `{ThemeResource}`，不要在 code-behind 取画刷对象

`MainWindow.xaml` 里状态点样式之所以写成 `Style` + `Setter Value="{ThemeResource ...}"`，是因为 code-behind 里取到的画刷对象**换主题后不会刷新**。新的左栏用量极小（框架默认样式），基本不涉及；但如果你给「实例」项加了自定义内容（例如数量角标），同样要遵守这条。

### 6.3 历史缺陷：`NavigationView` 会把 `MenuItemTemplate` 套到"自容器项"上

`Shell/RailEntry.cs` 的类注释记录了上一轮的坑：把 `NavigationViewItem` / `NavigationViewItemSeparator` 直接当数据项时会被套上模板，导致 `x:Bind` 全失败、画出"空头像框 + 假『新建实例』"的垃圾行（交付报告 §3 有完整复盘）。**新方案不再使用 `MenuItemTemplate` / `MenuItemsSource`，这个坑不会再现**；但删除 `RailEntry` 时不要顺手把这段知识从仓库里抹掉 —— 建议把结论一句话留在本文件 §6.3（已在）或 `docs/design/winui3-visual-spec.md` 的相关表格备注里。

### 6.4 图标与选中态（用户已明确指出过的两点）

1. **设置图标必须是标准齿轮**：演示稿第一版我手写了一条多边形路径，形状是错的（用户一眼看出）。用框架字形 `&#xE713;` 即可。
2. **不要给选中项的图标上强调色**。演示稿第一版写了 `.nav-item.selected .ico { color: accent }`，浅色下是深蓝尚可，**深色下强调色变成亮青 `#60cdff`，只有那一枚图标与主题不搭**（用户原话："实例的图标深色模式下和主题不匹配"）。WinUI `NavigationView` 真实行为是：**只把左侧 3 px 指示条染成强调色**，图标与文字保持主文字色。落地时不要"改良"成彩色图标。
3. 图标配色一律 `currentColor` / 框架主题画刷，**不得写死 hex**。

### 6.5 实例头像色底：10% alpha，不要不透明色

`Views/InstancesPage.xaml.cs` 的 `InstanceCardPaint.Tint` 用的是 `Color.FromArgb(0x1A, r, g, b)` = **实例色的 10% 透明淡底**，叠在卡片底上，所以浅色下是淡彩、深色下是暗彩，两套主题都保有对比度。演示稿第一版把底色写成了不透明浅色 hex（`#f3e8fd`），深色模式下变成亮色方块，`✱`/`✳` 这类**主文字色**的符号头像直接不可读（用户截图指出）。

- 若本次改动顺手"美化"了卡片头像，**保持 10% alpha 的语义**；
- 若用户后续想加深，可以按主题给不同 alpha（浅 10% / 深 16%），但那属于新决策，先问。

### 6.6 深链必须继续可用（自动化截图的命脉）

`MainWindow.ApplySmokeRoute` / `NavigateSmokeRoute` 支持 `WHALES_SMOKE_ROUTE`：

```
instances | engines | create | settings | detail/first/<plugins|settings|saves|logs>
```

- `detail/first/...` 取的是 `AppServices.State.Instances` 的第一个实例（**不依赖左栏**），本次改动**不影响**；
- 但 `docs/design/winui3-visual-spec.md` 与审计脚本都依赖这套深链，**改完必须逐条实测**（见 §8）；
- 方案 A 请顺手加 `about` 这一条取值。

### 6.7 其它不要动的东西

日志抽屉（`Shell/LogDrawer.cs` + `SplitView`）、应用菜单（后端 `app:menu` → `AppMenuBuilder`，界面**不得**维护第二份菜单定义）、标题栏主题按钮、`Controls/ToastHost`、`Controls/PreflightReportView`、Wizard / Engines / Settings 三个页面本身、契约与 Node 侧车。

---

## 7. 会被这次改动打破的测试与文档（必改清单）

### 7.1 UI 测试（PowerShell + UIA）：**会直接失败**

| 文件 | 位置 | 现在断言什么 | 怎么改 |
|---|---|---|---|
| `scripts/test/ui/shell.ps1` | SH-01 约 L62-73 | `Find-ByAutomationId 'MenuItemsHost'` 下的文本里能找到全部后端实例名 | 左栏不再有实例 → **改为断言卡片网格**（P1 已覆盖）或**删除该用例**；若保留"左栏"语义，改成"左栏功能项齐全"（与 SH-02 合并） |
| 同上 | SH-02 约 L75-82 | `Nav` 子树里同时出现 `railNewInstance` / `railEngines` / `railSettings` | 改为 `['实例','引擎版本管理','全局设置','关于']`（建议按 `AutomationProperties.Name` 精确匹配，别再靠"文本出现在子树"）。注意「关于」在 `FooterMenuItems`，前三项在 `MenuItems` |
| 同上 | SH-09 约 L190-207 | `Find-ByAutomationId 'InstanceFilter'` 里能写文本 | **筛选框已删** → 改为"断言 `InstanceFilter` **不存在**"（负向断言），或删除该用例并把编号让位；若要保留"筛选可用"的覆盖，断言实例页内的 `SearchBox`（P1-03 已覆盖） |
| `scripts/test/lib/labels.mjs` | L27 `railItemTypeName: 'WhalesLauncher.Shell.RailEntry'` | 左栏项的 CLR 类型名 | **已核实：这个键全仓没有任何引用**，直接删除；若将来要给新项写"类型名断言"，静态项的容器类型是 `Microsoft.UI.Xaml.Controls.NavigationViewItem`，但更稳的做法是断言 `AutomationProperties.Name` |
| 同上 | L28-30 `railNewInstance / railEngines / railSettings` | 左栏标签 | 保留 `railEngines` / `railSettings`（文案未变），`railNewInstance` 仅被 `shell.ps1` SH-02 使用 → 随 SH-02 改写后删除或保留（用不上就删） |
| 同上 | L191-201 `CHECKS.shell` 的 `SH-01/02/09` 标题 | 断言标题文案 | 与上面的改动同步改标题 |
| `scripts/test/ui/p8-settings.ps1` | **约 L46-60（务必看）** | 深链 `settings` 失败时的**兜底路径**：在 **`FooterMenuItemsHost`** 下逐行找文本含「全局设置」的 `ListItem`，找不到就 `throw "entry point missing…"` | **改造会让这条兜底断掉**：「全局设置」已从底部移到主区。把 `Find-ByAutomationId 'FooterMenuItemsHost'` 改成 `'MenuItemsHost'`（或直接在整个 `Nav` 下找），并同步改 L46-48 那段"按子元素文本定位"的注释（静态项设了 `AutomationProperties.Name` 后可以直接按名字找） |
| `scripts/test/run-ui-tests.mjs` | 约 L148 | `navigation: '深链 settings（失败时退回点击左栏「全局设置」入口）'` | 仅是描述，核对仍如实即可 |

> 跑法：`npm run test:ui`（内部 `scripts/test/run-ui-tests.mjs`）。**这些用例是"应用真实启动 + UIA 驱动"，改完必须真跑，不能只靠编译通过。**

### 7.2 文档 / 截图（会误导用户，必改）

| 文件 | 现在怎么写 | 怎么改 |
|---|---|---|
| `docs/design/winui3-visual-spec.md` §9.1 | 见 §5.5 | 按 §5.5 逐条改 |
| `docs/guide/03-instances.md` L20 | "左侧实例栏｜常驻的实例列表（顶部有「筛选实例」输入框）…底部是「引擎版本管理」与「全局设置」入口" | 改写为：左栏是功能列表，实例列表在「实例」页内（含页内搜索 / 状态筛选 / 排序） |
| `docs/guide/02-quickstart.md` L13、L160 | "左侧实例栏底部点 引擎版本管理"、"左侧是常驻的实例栏（顶部可筛选实例…）" | 同上 |
| `docs/guide/04-engines-plugins.md` L9、L64 | "左侧实例栏底部的 引擎版本管理"、"左栏点实例名也一样" | 「引擎版本管理」在左栏主区（不再是底部）；"左栏点实例名"这句**必须删**（不再支持），改为"实例页卡片上的 详情" |
| `docs/guide/05-settings-saves-logs.md` L172 | "左侧实例栏底部的 全局设置" | 左栏主区 |
| `docs/guide/06-isolation-sharing.md` L129 | "界面状态（左栏、卡片、页签）立即同步" | 左栏不再随实例变化 → 改为"卡片与页签立即同步" |
| `docs/assets/tutorial/*.png` + `CORRESPONDENCE.md` | 24 张教程截图全部带旧左栏（`01-instance-list.png`、`17-engines.png`、`18-global-settings.png` 等），L210 还写着"按子元素文本定位左栏底部入口" | 用深链 + 新左栏**重新截图**，并更新 `CORRESPONDENCE.md` 的对应行 |
| `docs/audit/ui-test-report.md` DEFECT-3（约 L322-330） | "左栏行 `name='WhalesLauncher.Shell.RailEntry'`" | 加一条"已随左栏改造消失"的备注（`scripts/test/lib/report-notes.mjs` L78-86、L114 里也有同样描述） |
| `docs/winui3-重构交付报告.md` L5 / L7 | L5 登记了"P1 无左栏高亮"的偏离、L7 登记了"左栏底部两项图标位置差异" | L5 改为"**已解决**：左栏改为功能列表后，「实例」项在实例列表页即为选中态"；L7 复核（底部现在是「关于」，图标位置按框架默认） |
| `docs/design/architecture.md` L81 | "Shell/ 外壳（标题栏 · 左实例栏 · 日志抽屉 · 菜单）" | "左实例栏" → "左功能栏" |

### 7.3 不需要改的

`tests/**`（都是 core 层测试，与 UI 无关）、`desktop/bridge/**`、`src/shared/contracts.ts`、审计脚本 `scripts/audit/*`（走深链）。

---

## 8. 验收标准（按顺序跑，命令都是现成的）

```powershell
# 1. 编译 + 类型检查（C# 侧没有 dotnet test，靠 build:app）
npm run build:bridge      # 桥接层（本次不应有变化）
npm run build:app         # WinUI 3 工程编译
npm run typecheck         # TS 侧（本次不应有变化）

# 2. 核心测试（本次不应有变化，用作回归基线）
npm test

# 3. UI 自动化（会覆盖 §7.1 改过的用例）
npm run test:ui
```

**手动清单**（每项都要看深浅两套主题）：

1. 左栏只有「实例 / 引擎版本管理 / 全局设置」+ 底部「关于」；**没有任何实例行、没有筛选框**；
2. 在实例页时「实例」处于选中态（这一条修掉了交付报告 L5）；
3. 从引擎页 / 设置页都能一键回实例页（修掉了旧左栏"没有实例列表入口"的问题）；
4. 实例页：搜索 / 状态筛选 / 排序 / 刷新 / 导入实例包 / 新建实例**全部照常**；"需处理"筛选数与提示条文案一致；
5. 卡片「详情」→ 详情页：左栏仍选中「实例」，面包屑可点回实例列表，返回按钮只在详情页出现（`Alt+←` 亦然）；
6. 左栏折叠（pane 顶部 ☰）到紧凑形态（仅图标），四项都能点；
7. 窗口缩到最小 1024×720，左栏仍为 Expanded；Mica 不可用时有实色兜底；
8. **无实例**空态：左栏保持四项不变，实例页显示空态 A「还没有实例」+ 主按钮；
9. 有降级实例（`instance.json` 损坏）时：卡片上的警示仍在、左栏不再重复显示这些信息；
10. 标题栏副标题随路由变化（实例 / 实例详情 · 页签 / 引擎版本管理 / 全局设置 / 关于）；
11. 深链：`WHALES_SMOKE_ROUTE` 逐条试 `instances` / `engines` / `create` / `settings` / `detail/first/saves`，以及方案 A 的 `about`；
12. 日志抽屉的来源下拉仍列出全部实例（它依赖 `OnInstancesChanged → RebuildSources`，删 `RebuildRail` 时最容易误删）；
13. 应用菜单（文件 / 编辑 / 视图 / 窗口 / 帮助）与主题按钮不受影响。

---

## 9. 建议的落地顺序

1. `MainWindow.xaml`：删模板 / 点样式 / PaneHeader，改静态菜单项（此时应用能编译但实例栏相关代码还引用旧类型）；
2. `MainWindow.xaml.cs`：删 `_rail` 与 `RebuildRail` / `OnInstanceFilterChanged`，改 `OnNavSelectionChanged` / `SyncNavSelection`，恢复返回按钮逻辑，补 `RouteKeys.About`；
3. 删除 `Shell/InstanceRail.cs`、`Shell/RailEntry.cs`、`Shell/RailEntryKind.cs`，全仓搜残留引用；
4. 详情页面包屑可点击 + 新增 `AboutPage`（方案 A）；
5. `npm run build:app` + 手动清单 1-6；
6. 改 §7.1 的 UI 测试与 labels（**别漏 `p8-settings.ps1` 的 `FooterMenuItemsHost` 兜底**），`npm run test:ui` 跑到全绿；
7. 改 §7.2 的文档与教程截图；
8. 最后统一跑 §8 的完整验收。

**建议提交切片**（便于 review / 回退）：
① 外壳左栏改造（XAML + code-behind + 删旧类）→ ② 详情页面包屑 + AboutPage → ③ UI 测试与 labels 同步 → ④ 文档与截图同步。

---

## 10. 视觉基准与自检脚本（都在仓库里）

| 资产 | 用途 |
|---|---|
| [docs/design/demo/ui-function-nav.html](../design/demo/ui-function-nav.html) | **样式基准**（用户已确认方向）。可交互：切页、卡片详情、页内搜索 / 筛选、明暗主题、紧凑左栏、说明浮层 |
| `.spike/smoke/demo-check.mjs` | 演示稿的 jsdom 自检（51 条断言，`node demo-check.mjs`，需在 `.spike/smoke` 下跑，该目录 gitignore）。里面沉淀了几条**同样适用于 WinUI 的教训**：断言"可见"要看计算样式而不是属性、选中项别染图标、色底必须半透明 |

演示稿是**纯 HTML 复刻**，不是产品代码；不需要也不应该把它接进构建。

---

## 11. 风险与回退

| 风险 | 影响 | 处置 |
|---|---|---|
| 误删 `OnInstancesChanged` 里的 `RebuildSources()` | 日志抽屉来源下拉变空 | 手动清单第 12 条专门覆盖 |
| `RailEntryKind` / `InstanceRail` 仍有别处引用 | 编译失败 | 删除前先全仓搜（§5.3） |
| 面包屑改成自定义对象却忘了 `ItemTemplate` | 界面上出现 `record` 的 `ToString()` 结构文本（交付报告登记的 P3 缺陷） | 要自定义对象就**必须**配模板；或以字符串 + 单独点击区域实现 |
| 为了"更醒目"给选中项图标上强调色 | 深色主题下突兀（用户已指出过） | §6.4，别做 |
| 顺手把实例色底改成不透明色 | 深色下头像不可读（用户已指出过） | §6.5，别做 |
| UI 测试脚本没同步 | `npm run test:ui` 红，且红的原因看起来像产品缺陷 | §7.1 先改脚本再跑；SH-09 明确改成"筛选框不存在"的负向断言，`p8-settings.ps1` 的兜底要改 `MenuItemsHost` |
| 只改了 `shell.ps1` 忘了 `p8-settings.ps1` | 深链一旦回归，兜底会 `throw`，P8 整个用例挂掉 | 三处一起改：`shell.ps1`（SH-01/02/09）、`labels.mjs`、`p8-settings.ps1` 的兜底查找 |

**回退**：所有改动都在 `desktop/src/WhalesLauncher.App`（+ 测试 / 文档），不涉及桥接层与契约，`git revert` 单个提交即可回到旧左栏，无数据迁移。
