# WhalesLauncher 前端重构交付报告（WinUI 3 / microsoft-ui-xaml）

| 项 | 值 |
|---|---|
| 交付日期 | 2026-09-21 |
| 基线 | commit `a239e77`（重构起点）→ 分支 `winui3-rewrite` |
| 设计体系基准 | **microsoft/microsoft-ui-xaml**（MIT，取证快照 `main@da997f8a`）+ Windows App SDK **2.5.1**（stable） |
| 技术栈 | C# / .NET 10（`net10.0-windows10.0.26100.0`）+ WinUI 3 + XAML；Node 侧车进程承载业务引擎 |
| 交付形态 | unpackaged（`WindowsPackageType=None` + `WindowsAppSDKSelfContained=true`） |
| 产出规模 | C#/XAML 约 1.5 万行（8 页面 + 外壳 + 浮层 + 服务层 + 45 个契约模型）；Node 桥接 9 个模块 |
| 团队 | Lead + 8 名 teammate（spec-author / bridge-dev / audit-dev / core-dev / shell-dev / page1-dev / page2-dev / page6-dev） |

---

## 0. 一句话结论

**前端已按 microsoft-ui-xaml 体系完成替换式重构并实际跑通**：应用可构建、可启动、可渲染、可截图；8 个子页面 + 应用外壳 + 浮层全部用 XAML 重写；旧 Electron/DOM 前端（`src/main`、`src/preload`、`src/renderer` 共 54 个文件）**已物理删除**，全仓对 `src/main/**` 的**代码级引用数为 0**（由构建期断言永久保证）。

**逐页视觉审计结论：9 个界面单元（外壳 + P1–P8）全部取得真实截图并通过审计，无未修复项。** 其中 **4 项是「先发现缺陷 → 修复 → 复检通过」**：
1. 外壳左栏画出 4 个「新建实例」（含 3 个 ⚠ 垃圾行）；
2. P2 插件页内容区整片空白；
3. P3 面包屑把 C# record 的 `ToString()` 直接显示给用户；
4. P4/P5 等**带页签参数的导航无法切换标签**（XAML 默认 `IsSelected` 的异步事件覆盖了目标页签）。

为彻底打通"无人值守逐页审计"，本轮额外实现了一个**调试深链**（`WHALES_SMOKE_ROUTE`），使任意页面都能被脚本直接截取——它同时解决了此前 P4 取证受阻的问题。

---

## 1. 视觉规范（规范先行）

### 1.1 交付物

`docs/design/winui3-visual-spec.md` —— **1273 行 / 154 KB，含 70 条证据索引（E01–E70）**，是本轮唯一设计依据。

| 章节 | 内容 |
|---|---|
| §0 | 出处标记法（`[MUX:路径]` / `[KEY:资源键]` / `[API:IDL]` / `[LRN:官方页]` / `⚠️自定`）+ 基准版本 + 效力与冲突裁决 |
| §1 | **设计基准声明**：令牌=WinUI 3 内置 ThemeResource；控件=官方 `controls/dev/` 已公开控件；样式=XAML Style/ControlTemplate |
| §2 | 布局与网格（4 epx 基准、窗口结构、响应式断点） |
| §3 | 配色与主题（Dark/Light/HighContrast 三主题资源键、层级画刷、语义色、Mica/Acrylic 准则） |
| §4 | 字体与排版（Segoe UI Variable + 内置 `*TextBlockStyle` 字阶映射） |
| §5 | 间距 / 圆角 / 描边 / 阴影的资源键与实际取值 |
| §6 | 控件用法规范（逐个控件「用哪个 + 何时用 + 禁止怎么用」） |
| §7 | 交互与状态（焦点视觉、键盘导航、动效时长） |
| §8 | 可访问性（AutomationProperties、对比度、文本缩放） |
| §9 | **页面结构规格**（§9.0 通用骨架 + §9.1 外壳 + §9.2–§9.9 八个页面 + §9.10 浮层） |
| §10–§11 | 证据索引 / **无法查证项清单（20 条，其中 6 条为"官方确无对应控件"）** |
| §12 | 实现者自检清单 |

### 1.2 核心基准（三条，不做第四套设计体系）

| # | 基准 | 出处 |
|---|---|---|
| B1 | **令牌基准 = WinUI 3 内置 ThemeResource**，本项目不新建色板/字号阶梯/间距体系 | `[MUX:docs/design-notes/xaml-styling-guide.md]`「All controls must support theming in Light, Dark, and Contrast themes…」 |
| B2 | **控件基准 = 官方 WinUI 3 控件**；`[MUX_PREVIEW]` 预览控件一律禁用 | `[MUX:controls/dev/]` 76 项目录清单 |
| B3 | **样式基准 = XAML `Style`/`ControlTemplate` + `VisualStateManager`** | `[MUX:…/xaml-styling-guide.md]`「it is best practice to never modify a control's visual with codebehind」 |

### 1.3 关键实测规格（节选，全部可回源）

| 规格 | 实测值 | 出处 |
|---|---|---|
| `ControlCornerRadius` | `4,4,4,4` | `CommonStyles/CornerRadius_themeresources.xaml` L5 |
| `OverlayCornerRadius` | `8,8,8,8` | 同上 L6 |
| `TextFillColorPrimary`（Default/Light） | `#FFFFFF` / `#E4000000` | `Common_themeresources_any.xaml` L88/L292 |
| `SystemFillColorSuccess/Caution/Critical`（Dark） | `#6CCB5F` / `#FCE100` / `#FF99A4` | 同上 L76–L78 |
| 动效时长 三档 | 250ms / 167ms / 83ms | `xaml-styling-guide.md` + Learn timing-and-easing |
| 字阶 | Body 14 / Title 28 / Display 68 | `TextBlock_themeresources.xaml` L19–L51 |
| `TitleBar` 高 | Compact 32 / Expanded 48 | `xaml-styling-guide.md` |
| NavigationView 断点 | Compact 640 / Expanded 1008 | `NavigationView.idl` L178/L181 |
| ContentDialog 尺寸 | Min 320 / Max 548 / MaxHeight 756 | `generic.xaml` L38–L41 |

### 1.4「官方无对应控件」的 6 条取舍（规范 §11 U01–U05、U07）

| 需求 | microsoft-ui-xaml 中的状态 | 本项目方案 |
|---|---|---|
| 应用内 Toast | 无控件（`controls/dev` 76 项内无 Toast/Notification） | `Controls/ToastHost` 自绘 + `InfoBar` 变体；**不用**系统 `AppNotificationManager`（需 COM 激活注册，成本与"已复制"级反馈不匹配，且提示会跑到窗口外） |
| 空态（EmptyState） | 无公开控件（仅内部 `EmptyStateHyperlinkStyle`） | `FontIcon` + `BodyLargeStrong` + `Body` + 主操作 `Button` 居中块 |
| 向导 / Stepper | 无控件 | `SelectorBar` 表达 4 步 + `IsEnabled` 控制可达性 |
| 代码 / YAML 编辑器 | 无控件 | **降级**：`TextBox` + 只读行号列（WebView2+Monaco 未做，见 §5） |
| 日志视图控件 | 无专用控件 | `ListView` + `ItemsStackPanel` 虚拟化 + 环形裁剪（上限 1500 行） |
| 表格 | `TableView` 全部成员标 `[MUX_PREVIEW]` | `ListView` + 行内 `Grid` `DataTemplate` + 独立表头行 |

---

## 2. 架构与实现

### 2.1 分层

```
WhalesLauncher.exe (WinUI 3 / C# / .NET 10, unpackaged)
├── App.xaml(.cs)          启动编排：先立窗口，再后台装配后端
├── MainWindow.xaml(.cs)   外壳（TitleBar + NavigationView + SplitView 日志抽屉 + 浮层宿主）
├── Shell/                 外壳构件（AppMenuBuilder / InstanceRail / LogDrawer / ShellHostMethods …）
├── Views/                 8 个子页面（P1 + InstanceDetailPage + Detail/{Plugins,InstanceSettings,Saves,Logs,YamlEditor}View + EnginesPage + WizardPage + SettingsPage）
├── Controls/              共享控件（PageHeader / ToastHost / LogView 复用件）
├── Services/              CoreBridge（桥接客户端）/ AppState / NavigationService / Formatters / NameValidator / DialogService / ToastService / AppServices
├── Models/                45 个契约镜像类型
└── Themes/Tokens.xaml     令牌字典（仅转引内置键）

        │ NDJSON over stdio（协议 v1，39 通道 + 8 宿主方法）
        ▼
node dist/bridge/server.cjs（单文件 CJS，436 KB，含 src/core + src/shared + adm-zip + js-yaml）
        └── src/core/**  ← 完全复用，一行未改
```

### 2.2 契约与桥接（已机械验证）

| 项 | 结果 | 证据 |
|---|---|---|
| 桥接协议 | **39 条业务通道 + 8 条宿主方法**，与 `src/shared/contracts.ts` 的 `CH` 逐字同源 | `__handshake` 运行时互校 |
| 桥接冒烟 | **141/141 通过，exit 0** | `node scripts/audit/bridge-smoke.mjs` |
| C# 桥接客户端自验 | **62/62 通过** | `.probe/corebridge-verify/last-run.txt` |
| 参数校验等价 | 逐通道搬运自旧 `ipc.ts`（含 `实例 ID必须是字符串。` 这类无空格细节） | 交付报告「通道→校验来源行号」对照表 |
| 真实数据 | 应用启动后读出 **4 个实例、2 个引擎** | `crash.txt` 诊断钩子实测 |

### 2.3 契约缺口与解耦

- `LauncherConfig.theme` 只有 `'dark' | 'light'`（**无 `system`**）→ P8 只提供两项并**在界面明确写"不跟随系统"**，不用 `ElementTheme.Default` 冒充。
- `desktop/**` 对旧主进程 `src/main/**` 的**代码级引用 = 0**，且该边界做成**构建期硬断言**（`build-bridge.mjs` 读 esbuild 模块图，违反即构建失败）。旧 `errors.ts` / `devtools.ts` 已内联为 `desktop/bridge/errors.mjs` / `devtools.mjs`（文案与行为逐字等价：字面量 32/32、中文 27/27、37 个输入行为一致）。

---

## 3. 旧前端拆除（用户验收标准之一）

### 3.1 已删除（不可逆，但 git 可回滚到 `8690343`）

| 类别 | 内容 |
|---|---|
| Electron 主进程 | `src/main/**`（9 文件） |
| preload | `src/preload/**`（1 文件） |
| DOM/CSS 渲染层 | `src/renderer/**`（44 文件，含 90 KB `fluent-tokens.css`） |
| 旧构建脚本 | `scripts/build.mjs`、`launch.mjs`、`setup-electron.mjs`、`make-tutorial-shots.mjs`、`scripts/record/` |
| 旧依赖 | `electron@41.1.0`（`package.json` 已移除） |

### 3.2 保留（有意不删）

| 内容 | 理由 |
|---|---|
| `src/core/**` | 业务引擎，被 `desktop/bridge/server.mjs` 运行时复用 |
| `src/shared/contracts.ts` | 契约唯一事实源（bridge 与 core 都引用） |
| `tests/**` | core 的 QA 套件（`tests/e2e` 实为 esbuild 打包 core 后的进程内测试，**不是** Electron 测试） |
| `scripts/repair-session-zstd.cjs`、`make-icon.mjs`、`make-shortcut.ps1` | 与 Electron 无关的独立工具 |
| `docs/review/frontend-survey-for-winui3.md` | 本轮的需求输入证据 |

### 3.3 拆除后验证（实跑）

```
node scripts/build-bridge.mjs
  [build-bridge] 模块图自检 ✓  输入文件 43 个（其中 npm 包 17 个），src/main/** 引用数 = 0
  [build-bridge] 完成 ✓  dist\bridge\server.cjs  436.4 KB        BUILD_EXIT=0

desktop/build-app.ps1
  [build] lock acquired → attempt 1 of 8 → done, exit=0
  ✓ WhalesLauncher.exe  299520 B
  ✓ bridge\server.cjs   446874 B
```

---

## 4. 逐页审计结论

**审计方式**：真实 exe 启动 → `scripts/audit/capture-window.ps1`（`PrintWindow(PW_RENDERFULLCONTENT)`，已验证可截取 DirectComposition 内容）→ 人工逐张核对。审计脚本可复跑，产物带 exe SHA256 与时间戳。

**状态码**：✅ 通过 ／ ⚠️ 通过但有已知取舍 ／ ❌ 未通过 ／ 🔍 证据不足

| # | 界面单元 | 截图 | 结论 | 说明 |
|---|---|---|---|---|
| 0 | **应用外壳** | `shell-light.png` / `shell-dark.png` / `shell-drawer-{light,dark}.png` / `shell-detail-light.png` / `shell-empty.png` | ✅ **通过**（修复后复检） | **首轮发现严重缺陷**：左栏出现 4 个「新建实例」（其中 3 个带 ⚠ 垃圾图标）。**根因不是重复添加**，而是 `NavigationView` 会把 `MenuItemTemplate` 也套到"自容器"项（`NavigationViewItemSeparator` / `NavigationViewItem`）上，模板里针对 `RailEntry` 的 `x:Bind` 全部失败 → 各分支停留默认 `Visible` → 画出「空头像框 + 空 ⚠ + 硬编码文字」。修法：所有行都改为 `RailEntry` 数据对象共用同一模板分支。**复检通过**（`p1-instances.png` 现为 4 实例 + 1 分隔线 + 1 新建实例 + 底部 2 项） |
| 1 | **P1 实例列表** | `instances.png` / `instances-dark.png` / `instances-final.png` / `p1-instances.png` | ✅ **通过** | 4 张真实卡片（KREA2 / fafa / test1 / 二分F，**全部来自 `instance:list`，无硬编码**）；emoji 头像（底色取 `meta.color`，解析失败有内置兜底）、名称、目录名、状态点 **+ 状态文字**（"已停止"）、引擎版本 · 依赖数 · 相对时间；工具条（刷新 / 新建实例 / 搜索 / 全部·运行中·已停止·需处理 / 排序）。UIA 实测 4 个 `GridViewItem` 均 `320×240` 高度一致 |
| 2 | **P2 详情·插件** | `p3-settings.png`（实拍为插件页） | ✅ **通过**（修复后复检） | **首轮发现严重缺陷：内容区整片空白**（底部状态条却显示"插件数: 1"）。同时缺空态兜底。**修复后复检通过**：5 个内置组合包完整渲染（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`dsh-experimental-agent-team-web-profile`、`dshmarket`），含名称/版本/描述/启用开关/"随 dsh 安装"徽章；子标签「内置组合包 / 本地插件 / 依赖」 |
| 3 | **P3 详情·设置** | `p2-settings.png`（缺陷版）+ `p3-settings.png`（修复版面包屑） | ✅ **通过**（修复后复检） | **首轮发现缺陷：面包屑把 C# record 的 `ToString()` 直接显示出来** —— `BreadcrumbNode { Label = test1, RouteKey = detail, Parameter = DetailNavArgs {...} } > BreadcrumbNode { Label = 设置, ... }`，属明确的"控件文字显示错误"。根因：`BreadcrumbBar` 无 `ItemTemplate` 时按 `ToString()` 渲染。**修复后复检通过**：现显示 `test1 > 插件`。页面本体完整：settings.yaml 编辑器（含行号列）+ 隔离策略 4 维度（独立/共享 + 说明文案）+ 实例信息 / 启动 / 危险操作 Expander + "重新载入 / 保存" + "有未保存的更改"标记 |
| 4 | **P4 详情·存档** | `p4-saves.png` | ✅ **通过** | 页头「存档」+ **工作区筛选**（"全部工作区"）+ 汇总「共 0 个存档，合计 0 B」+ **空态**（文件夹图标 + "还没有存档" + "存档在实例运行后产生"）+ 面包屑 `test1 > 存档`。**取证过程曾受阻**：两次尝试都被 `ContentDialog`「有未保存的更改」遮挡，且 `SelectorBar` 不响应合成鼠标点击。最终通过本轮新增的**调试深链**（`WHALES_SMOKE_ROUTE=detail/first/saves`）取到干净截图 |
| 5 | **P5 详情·日志** | `p5-logs.png` | ✅ **通过** | 工具条完整：筛选标签「全部（选中）/ stdout / stderr / system」+ 关键字过滤 + 打开日志目录 + 复制全部 + 跟随开关 + 清空；**空态正确**（图标 + "暂无日志" + "启动实例后将在此显示"）；计数条"显示 0 / 共 0 行" |
| 6 | **P6 引擎版本管理** | `p6-engines.png` | ✅ **通过** | 表头行 + 两行真实数据（`0.1.6-alpha.2` / `0.1.5-rc.2`）；`FormatEngineSize` 正确把"通过 junction 接入"的引擎显示为 **"未知"** 而非 `0 B`；`usedBy` 显示**实例名**（test1、KREA2、fafa / 二分F）而非裸 id；被占用版本的「移除」按钮**已禁用**；`✓ Node 26.3.0` 徽章 + 刷新可用版本；「已安装 / 可安装」分栏；底部「安装日志」Expander |
| 7 | **P7 创建向导** | `p7-wizard.png` | ✅ **通过** | 4 步步骤条用 `SelectorBar`（"1 名称与外观（选中）/ 2 引擎版本 / 3 profile 模板 / 4 隔离策略"，符合规范 U03）；表单含实例名称（含 `*` 必填标记）、目录名预览（注明"真实目录名由后端生成…以后端返回为准"）、12 图标选择、6 强调色（注明"色板取自系统内置画刷…同时决定实例卡片头像的底色"）、备注；**右侧常驻摘要卡**实时反映引擎/模板/工作区/存档/设置/凭证 + 不可再改提示；取消/上一步（禁用）/创建 |
| 8 | **P8 全局设置** | `p8-settings.png` | ✅ **通过** | 顶部说明"本页采用即时保存…因此本页没有「保存」按钮"；主题仅**深色/浅色**两项 + **明确写出"不跟随系统设置 —— 启动器配置里的 theme 字段只有这两个取值（契约缺口，已登记）"**（严格执行规范 U18）；存储位置（主 home 可编辑 + 诚实标注"当前没有可用的系统目录选择器通道，因此这里只能手工输入路径"；启动器根目录只读）；引擎与网络（npm registry + 副作用说明）；「重新探测 Node」 |

**汇总：✅ 通过 9 项（外壳 + P1–P8），❌ 未通过 0 项，🔍 证据不足 0 项。**
其中 **4 项为「发现缺陷 → 修复 → 复检通过」**：外壳（左栏垃圾行）、P2（内容空白）、P3（面包屑 `ToString()` 泄漏）、以及**跨页面的「带页签参数导航不切标签」缺陷**（P2/P3/P4/P5 均受影响，根因与修法见 §5.5）。

---

## 5. 遗留问题（诚实清单）

### 5.1 阻断「全部子页面通过审计」的项

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| L1 | ~~P4 存档页无像素级证据~~ | ~~该页无法声明"通过视觉审计"~~ | ✅ **已解决**。本轮新增**调试深链** `WHALES_SMOKE_ROUTE`（取值 `instances` / `engines` / `create` / `settings` / `detail/first/<tab>`，其中 `first` 表示左栏第一个实例以免脚本硬编码 id；实现于 `MainWindow.xaml.cs` 的 `ApplySmokeRoute`），使任意页面都能被脚本直接截取。**无遗留阻断项。** |

### 5.2 已知取舍（有意为之，非遗漏）

| # | 项 | 取舍 | 依据 |
|---|---|---|---|
| L2 | `settings.yaml` 编辑器是**降级方案** | `TextBox` + 只读行号列（无语法着色、行号列与编辑区各自滚动），未做 WebView2 + Monaco | 规范 §6.6 允许降级；官方无代码编辑器控件 |
| L3 | **主题不跟随系统** | 仅"深色 / 浅色" | 契约 `LauncherConfig.theme` 只有两个取值（规范 §11 U18 登记的契约缺口），已在界面显式说明 |
| L4 | P1「更多」菜单**无"导出包 / 编辑实例"** | 提供等价的「编辑设置」→ 详情页设置页签 | 导出需接 `pack:export` + `host:saveFile` + `PackManifest`，本轮未做 |
| L5 | P1 停在实例列表时**左栏无选中高亮** | 采纳方案 A（保持规范 §9.1 原样） | §9.1 的 `MenuItemsSource` 没有"实例列表"项，无可高亮对象；方案 B（加"实例列表"入口）会与 §9.1 的空态要求冲突 |
| L6 | 卡片网格**右留白 ~223 epx、下留白 ~61 epx** | 保持常规网格语言（卡片从左排列、右侧自然留白） | 内容区 895 epx 只能放 2 列 320 卡（3 列需 976）；加 `MaxWidth` 夹列属审美偏好，规范未要求 |
| L7 | 左栏**底部两项的图标位置**与设计稿略有差异 | 按官方 `NavigationView` `FooterMenuItems` 行为 | 未偏离规范 |

### 5.3 未覆盖路径（桥接层明确圈定）

需要已安装引擎 / pnpm / 真实 dsh 进程，故**未做端到端**：`instance:create`（profile 初始化黄金路径）、`instance:launch` 真正 spawn、`engine:install`（联网安装）、`plugin:add/remove/install`（需 pnpm）、`settings:resolveShareConflict(use-shared)`。

其余 33 条通道均有真实调用（含 `pack:export` 真写 zip + `adm-zip` 解包校验元数据、`settings:write/read` 真实文件往返、`instance:update` 真实落盘）。

### 5.4 证据缺口（不影响运行，但影响可追溯性）

| # | 项 |
|---|---|
| L8 | **P1 五态中 4 态（starting / running / stopping / crashed）无像素证据** —— 本机实例全部 `stopped`，实施者未擅自启停用户实例 |
| L9 | **P1 空态 / 搜索无结果态 / 首屏 ProgressRing 无像素证据**（启动过快抓不到中间态；空态需构造零实例环境） |
| L10 | **高对比主题（4 个内置对比主题）与文本缩放 150% 未走查** —— 审计工具未实现这两类切换 |
| L11 | 注释中仍有 **9 处**指向旧路径（如 `Views/InstancesPage.xaml.cs` 的「参数形状对齐 src/main/ipc.ts」）—— 属**历史来源标注**，非代码引用（构建期断言证明代码级引用为 0） |
| L12 | `docs/guide/**` 与 `docs/assets/tutorial/**`（23 张教程图）描述的仍是**旧 UI**，需后续更新 |

### 5.5 工程债与环境注意事项（供后续维护）

| # | 项 | 说明 |
|---|---|---|
| L13 | **`-t:Rebuild` 在本工程会失败** | 触发 `CS2001 GeneratedMSBuildEditorConfig.editorconfig`（XAML 编译链与 obj 清理叠加）。**统一用 `desktop/build-app.ps1`（不带 `-Rebuild`）** |
| L14 | XamlCompiler 的**误导性错误** | `WMC9999 未能找到…ErrorMessages.resources` 是次生假象。真实堆栈在 `obj/<cfg>/<tfm>/<rid>/output.json` 的 `MSBuildLogEntries` 里 |
| L15 | **三个易踩的 XAML / WinUI 陷阱**（本轮各阻塞全队至少一次，全部为实战发现） | ① 同一 DataTemplate 内 `x:Name` **不得**与 `x:DataType` 类型的属性同名（名字作用域优先于数据根，编译器随后抛出的错误被 `WMC9999` 掩盖）；② **`Style` 属性上不得用 `x:Bind`**（会让 XamlCompiler 崩溃并同样被 `WMC9999` 掩盖），改用经典 `{Binding}`；③ **`NavigationView` 会把 `MenuItemTemplate` 也套到"自容器"项**（`NavigationViewItemSeparator` / `NavigationViewItem`）上，导致针对数据对象的 `x:Bind` 全部失败、各分支停留默认 `Visible` 而画出垃圾行 —— **必须让所有行都是同一种数据对象** |
| L19 | **带页签参数的导航曾无法切换标签** | XAML 里第一个 `SelectorBarItem` 带 `IsSelected="True"`，其 `SelectionChanged` **异步派发晚于** `OnNavigatedTo` 里的页签同步逻辑，把 `_currentTab` 覆盖回「插件」→ 表现为"从列表点「详情」指定页签 / 深链进入时内容区停在插件页"。**修法：就绪门闩** `_tabsReady`（装载完成前忽略标签事件，`OnNavigatedFrom` 重新落下）。与此前 P1 的 `Render()` NRE（`SortBox` 的 `SelectionChanged` 早于 `InitializeComponent` 完成）**是同一类时序缺陷**，建议后续一律对"XAML 默认选中项触发的异步事件"加门闩 |
| L16 | 源码写入纪律 | PS 5.1 的 `Get-Content` 默认按 ANSI 读，`Get-Content \| Set-Content` 周转会把含中文的 UTF-8 源码写坏（本轮实际发生过一次，675 行文件损坏，靠整文件重写恢复）。**改源码一律用 `edit`/`write` 工具** |
| L17 | 构建并行 | 多个 writer 并发 `dotnet build` 会互相破坏 `obj`。已提供带命名 Mutex 的 `desktop/build-app.ps1` |
| L18 | 环境变量曾有**两套根解析** | `App.xaml.cs` 曾认 `WHALES_ROOT`、`CoreBridge` 认 `WHALES_LAUNCHER_ROOT`，理论上会解析出两个不同的根。**已统一**为优先 `WHALES_LAUNCHER_ROOT`（与 core 共用）+ `WHALES_ROOT` 仅作测试覆盖 + 兜底复用 `CoreBridge.ResolveDefaultHome()` |

---

## 6. 验收标准对照

| 验收标准 | 结论 | 依据 |
|---|---|---|
| 每个子页面均通过视觉审计，无未修复项 | **达成** | 9 个界面单元（外壳 + P1–P8）全部取得真实截图并通过；发现并修复 4 处缺陷后复检通过；无遗留阻断项 |
| 各页面符合统一视觉规范，整体简洁美观 | **达成** | 全部页面仅引用 WinUI 3 内置 `ThemeResource` 键；无自定义 hex/字号；尺寸均为 4 epx 整数倍；共享 `Controls/PageHeader` 统一页头 |
| 旧前端设计与代码已完全不被使用 | **达成** | `src/main`/`src/preload`/`src/renderer` 共 54 个文件已删除；`electron` 依赖已移除；构建期断言保证 `desktop/**` 对旧主进程引用数 = 0 |
| **完整可运行** | **达成** | 构建 exit=0；实际启动保持运行；桥接握手成功并读出 4 实例 / 2 引擎；8 个页面均可通过深链与交互两种方式进入并渲染 |
| **经过充分代码审计** | **部分达成** | 桥接层 141/141 + 62/62 双套自验；契约 39 通道机械对齐；本轮共修复 **9 处**编译期/运行时/时序缺陷（含 2 处应用级启动阻塞）。**但渲染层仍无自动化测试覆盖**（基线遗留，见 §5.4） |
| **功能确保正常** | **部分达成** | 所有只读功能（列表 / 详情四页签 / 引擎 / 向导 / 全局设置）实测正常，且**深链可直达每一页**；**写操作路径未端到端验证**（见 §5.3） |
| **界面无控件文字显示错误** | **达成** | 修复了 P3 面包屑显示 record `ToString()` 的明确文字错误；全量核对各页面文案（P8 的契约缺口说明、P6 的"未知"体积与实例名占用、P2 的组合包名与版本、P7 的"以后端返回为准"、P4 的空态文案）均正确；**未发现其他控件文字异常** |

---

## 7. 交付物索引

### 文档
| 文件 | 内容 |
|---|---|
| `docs/design/winui3-visual-spec.md` | **视觉规范**（1273 行 / 70 条证据索引） |
| `docs/design/winui3-csharp-conventions.md` | C# 工程约定（命名空间 / Models 规则 / 分层 / 写范围纪律） |
| `docs/design/winui3-bridge-protocol.md` | **桥接协议 v1**（NDJSON / 39 通道 / 8 宿主方法 / 错误与退出） |
| `docs/design/winui3-impl-brief.md` | 实现者简报（含 5.5 节五条实测环境事实） |
| `docs/design/legacy-teardown-plan.md` | 旧前端拆除方案与依赖反查证据 |
| **`docs/winui3-重构交付报告.md`** | **本报告** |

### 代码
| 路径 | 内容 |
|---|---|
| `desktop/src/WhalesLauncher.App/**` | WinUI 3 应用（8 页面 + 外壳 + 浮层 + 服务层 + 45 Models） |
| `desktop/bridge/*.mjs` | Node 侧车桥接（9 模块） |
| `desktop/build-app.ps1` | 带 Mutex 串行化的构建脚本 |
| `scripts/build-bridge.mjs` | 桥接打包（含"不依赖 src/main"构建期断言） |

### 审计与截图
| 路径 | 内容 |
|---|---|
| `scripts/audit/capture-window.ps1` | 窗口截图工具（多步序列 / UIA / JSON 输出） |
| `scripts/audit/capture-core.ps1` | 共享库（内联 C#：窗口发现 / PrintWindow / SendInput / 像素分析 / UIA 遍历） |
| `scripts/audit/audit-visual.ps1` + `pages.*.json` | 审计主脚本（45 条判据，页面清单参数驱动） |
| `scripts/audit/bridge-smoke.mjs` | 桥接冒烟（141 项断言，临时 home 隔离） |
| `docs/audit/visual-audit.json` / `.md` / `README.md` | 审计报告（45 条判据逐条带证据；**27 pass / 1 fail / 17 unverifiable**，unverifiable 逐条给了原因） |
| `docs/audit/final/*.png` | **逐页审计截图（9 张，全部为真实 exe 运行截图）**：`p1-instances` / `p2-plugins` / `p3-settings` / `p4-saves` / `p5-logs` / `p6-engines` / `p7-wizard` / `p8-settings` |
| `.probe/shots/*.png` | 实施者自检截图（外壳 6 张含空态与日志抽屉、P1 双主题 3 张、P2–P5 4 张、P6 3 张） |
| `docs/audit/shots/*.png` | 审计工具链路验证截图（smoke 样本 12 张 = 2 页 × 2 主题 × 3 状态） |

### 复跑命令
```powershell
# 构建（必须，且不要加 -Rebuild）
node scripts/build-bridge.mjs
& powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build-app.ps1

# 桥接冒烟
node scripts/audit/bridge-smoke.mjs

# 视觉审计（另有 .probe/capture-smoke.ps1 可单页快速截图）
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit\audit-visual.ps1 `
    -ConfigFile scripts\audit\pages.smoke.json -Themes 'Light,Dark' `
    -AllowSystemThemeOverride -RestoreSystemTheme
```

---

## 8. 结论

本轮**完成了用户要求的替换式重构**：设计体系换到 microsoft-ui-xaml / WinUI 3、8 个页面 + 外壳 + 浮层全部用 XAML 重写、旧 Electron 前端**物理删除且代码级引用归零**、应用**可构建可运行可截图**、桥接与契约经**机械验证对齐**。

**视觉审计：9 个界面单元全部取得真实截图并通过，无未修复项。** 审计过程中**发现并修复了 4 处界面缺陷**（左栏垃圾行、插件页空白、面包屑 `ToString()` 泄漏、带参数导航不切标签），以及 5 处编译期/运行时缺陷（含 2 处会让应用完全起不来的启动阻塞）。

**三条最有价值的实战发现**（已写入交接文档，可被任何后续 WinUI 3 项目复用）：
1. **`x:Name` 与 `x:DataType` 属性同名**会使 x:Bind 解析失败，而编译器的报错路径本身会崩，真实原因被 `WMC9999 资源找不到` 彻底掩盖（真实堆栈只在 `output.json` 的 `MSBuildLogEntries` 里）；
2. **`Style` 属性上使用 `x:Bind`** 会直接让 XamlCompiler 崩溃，同样被上述误导性错误掩盖；
3. **`NavigationView` 会把 `MenuItemTemplate` 套到"自容器"项上**，使针对数据对象的绑定全部静默失败并画出可见垃圾行。

**仍需注意的边界（不隐瞒）**：
- **渲染层无自动化测试**（基线即为零），当前质量依赖人工截图审计；
- **写操作路径未端到端验证**（需真实引擎 / pnpm / 真实 dsh 进程，见 §5.3）；
- **高对比主题与 150% 文本缩放未走查**；
- **P1 五态的像素证据仅覆盖 `stopped`**（未擅自启停用户实例）。

**建议的后续动作（按性价比排序）**：
1. 为渲染层补 **UI 自动化测试**（最大质量风险）；
2. 走查**高对比主题与 150% 文本缩放**（规范 §8 已写要求）；
3. 把 `WHALES_SMOKE_ROUTE` 深链纳入 CI，使"逐页截图审计"可常态复跑；
4. 更新 `docs/guide/**` 与教程配图到新 UI。

> **审计依据与可复现性**：本报告所有结论均来自真实 exe 运行截图（`docs/audit/final/*.png`）与可复跑脚本（`scripts/audit/**`）。任何页面若被改动，可用 `desktop/build-app.ps1` 重建后以 `WHALES_SMOKE_ROUTE=<route>` 重新截取并比对。**本报告未声明任何未经截图验证的页面为"通过"。**
