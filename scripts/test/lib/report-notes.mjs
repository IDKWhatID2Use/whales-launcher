/**
 * 报告正文（人类可读部分）。
 *
 * 与断言数据分开存放：断言结果是每次跑出来的，正文是随交付固定下来的说明。
 * 放在 .mjs 里是刻意的 —— 这是 UTF-8 文件，中文不会像 .ps1 那样被 PowerShell 5.1
 * 按 ANSI 解码成乱码。
 */

export const FRAMEWORK_RATIONALE = [
  '**复用既有 PowerShell UIA + Node 运行器，未引入任何新依赖。** 依据：',
  '',
  '1. **零新依赖、无第二次工具链认证。** 驱动只用系统内置的 `UIAutomationClient` / `UIAutomationTypes`（.NET Framework 自带）与 Node 运行时；没有 FlaUI / Appium / WinAppDriver / Playwright。CI 里不需要装 WebDriver、不需要匹配驱动与 Windows 版本、不需要为每个 runner 做一次环境认证。',
  '2. **该 UIA 路径已在本项目生产验证。** `scripts/audit/capture-core.ps1` 的 `[WinAuditCore]::UiaDump` 已经在逐页视觉审计里实际用过；驱动直接 dot-source 同一个文件，不复制第二份实现。',
  '3. **可直接复用 PrintWindow 截图与 `ImageStats`/`ImageDiff` 产出像素级证据。** 这条路（`PW_RENDERFULLCONTENT`）是本项目唯一验证过能拿到 DirectComposition 内容的做法；FlaUI 等库的截图能力并不比它强，却要额外引入依赖。',
  '4. **与既有 `scripts/audit/**` 同构，维护者只需会一种东西。** 审计脚本、驱动、用例脚本都是 PowerShell，定位失败时的诊断格式也一致。',
  '',
  '性能与稳定性上明确的代价（如实登记）：',
  '',
  '- UIA 调用是跨进程 COM，比进程内驱动慢；全量 9 页约 2 分钟。逐页独立启进程是刻意的取舍 —— 换来的是页面之间零状态串扰。',
  '- 依赖合成输入（`SendInput`）的部分会被前台窗口抢占影响，所以用例优先使用 UIA 模式（Invoke / SelectionItem / Toggle / Value），键盘只在"必须验证快捷键或关闭浮层"时使用（`Send-Keys` 会先 `SetForegroundWindow`）。',
];

export const ISOLATION_NOTES = [
  '- **数据根隔离**：每次运行在 `os.tmpdir()` 下 `mkdtemp` 一个唯一 home，`assertHomeIsolated` 机械断言它不在仓库内；应用通过 `WHALES_LAUNCHER_ROOT` 指向它。真实的 `F:\\WhalesLauncher\\instances` 与 `F:\\WhalesLauncher\\engines` 从不被读写。',
  '- **零网络、零真实引擎**：实例 fixture 按 core 的磁盘布局直接落盘（与 `scripts/audit/bridge-smoke.mjs` 相同的做法），引擎目录是只含 `package.json` 的合成目录。测试从不启动实例，因此不执行任何引擎代码，也不依赖 dsh / pnpm / registry。',
  '- **期望值全部动态取**：实例数、实例名、引擎版本都来自临时 home 上的 `instance:list` / `engine:list`；用例脚本里没有一个硬编码的实例名或版本号。',
  '- **逐页独立进程**：每页重新启动一个 `WhalesLauncher.exe`，避免上一个页面的编辑态、滚动位置、选中项残留。',
  '- **中文不经 `.ps1`**：PowerShell 5.1 按 ANSI 读 `.ps1`/`.psm1`，脚本里任何中文字面量都会乱码。因此用例脚本一律纯 ASCII，界面文案集中在 `lib/labels.mjs`，经 runner 写出的 UTF-8 JSON context 文件进入 PowerShell。',
];

export const UIA_SPIKE_NOTES = [
  '实测结论（用 `[WinAuditCore]::UiaDump` 与自建 raw/control 视图遍历逐页确认）：',
  '',
  '| 控件 | UIA 表现 | 可枚举 | 可交互 |',
  '|---|---|---|---|',
  '| `x:Name` 命名的控件 | `AutomationId` 就是 `x:Name`（Button / TextBox / GridView / InfoBar 等） | 是 | 是 |',
  '| `SelectorBar`（InstancesPage 的 `StatusFilter`） | 外层是 `NamedContainerAutomationPeer`，item 是 `ListItem` | 是 | 是（SelectionItemPattern） |',
  '| `SelectorBar`（详情页 `TabBar` / 插件页 `BlockBar`） | **外层没有 automation peer，item 只在 raw 视图里** | 仅 raw 视图 | 是（拿到 ListItem 后 SelectionItemPattern 可用） |',
  '| `MenuBar`（应用菜单） | `MenuItem`，Name = 菜单文字，无 AutomationId | 是 | 是（ExpandCollapsePattern / InvokePattern） |',
  '| `MenuFlyout`（卡片"更多"菜单、应用菜单下拉） | 不在独立顶层窗口里，而是作为主窗口 root 的后代出现（`Microsoft.UI.Content.PopupWindowSiteBridge` → `MenuFlyout`） | 是 | 是（InvokePattern；`MenuFlyoutSubItem` 先 Expand） |',
  '| `AccessibilityView="Raw"` 的控件（YAML 编辑器的 `Gutter` 行号列） | 被排除出 control 视图 | 仅 raw 视图 | 是（ValuePattern 读值） |',
  '| `GridView` / `ListView` 的卡片 | 容器 `ListItem` 的 Name 是 **CLR 类型名**（`WhalesLauncher.Views.InstanceCard` / `WhalesLauncher.Shell.RailEntry`），真实文字在子 TextBlock 上 | 是（要读子节点） | 是 |',
  '| 纯布局容器（`Grid`/`StackPanel`，如 `TabHost`、`EmptyPanel`） | **没有 automation peer**，`AutomationId` 不存在 | 否 | 否 —— 改用「锚点 + 相邻文本 / 标记文本」观测（如空态按钮、只在一个视图出现的文案） |',
  '| `ToggleSwitch` / `ToggleButton` | `ControlType.Button` + TogglePattern | 是 | 是 |',
  '| `RadioButtons`（主题、隔离策略） | 组按 `AutomationProperties.Name` 可寻址，选项是 `ControlButton`/`RadioButton`，各自支持 SelectionItemPattern | 是 | 是 |',
  '| `ContentDialog` | 未在本套用例里验证（fixture 不会触发会弹对话框的破坏性操作） | 未验证 | 未验证 |',
  '',
  '由此固化的驱动设计：查找默认走 **control 视图**（与视觉审计一致），需要时用 `-View Raw` 走 **raw 视图**；两者都用超时轮询，失败时把作用域内已枚举到的 `ControlType / AutomationId / Name` 列表打进异常消息。',
];

export const KNOWN_DEFECTS = [
  {
    id: 'DEFECT-1',
    title: '深链 `WHALES_SMOKE_ROUTE=create|settings` 只换标题不换内容',
    severity: '高（会让所有依赖深链的自动化拿到空壳）',
    status: '已由并行的源码修复解决；本套用例保留 P7-08 / P8-08 两条断言专门盯住它',
    evidence: [
      '`WHALES_SMOKE_ROUTE=create`：UIA dump 里 `PART_SubtitleText` 已是「新建实例」，但整棵控件树里没有任何 `Step1Item` / `NameBox` / `IconGrid` / `CreateButton`，内容区仍是上一页（InstancesPage）的 `SearchBox` / `StatusFilter` / `InstanceGrid`。`WHALES_SMOKE_ROUTE=settings` 同样：副标题已是「全局设置」，但没有任何 `ThemeRadios` / `PrimaryHomeBox` / `CandidateList`。',
      '根因（源码证据）：`ApplySmokeRoute` 在 MainWindow 构造期执行，此时后端尚未装配。`InstancesPage.OnNavigatedTo` 有 `AppServices.IsReady` 守卫并在注释里写明「直接访问 AppServices.State 会抛 InvalidOperationException，而本页的 OnNavigatedTo 跑在 Frame.Navigate 内，异常会一路冒到 OnLaunched，应用直接死」；`WizardPage.OnNavigatedTo` 与 `SettingsPage.OnNavigatedTo` 没有这个守卫，第一条语句就是 `AppServices.State.XxxChanged += ...`。异常被 `NavigateSmokeRoute` 的 `try/catch` 静默吞掉，`Navigated` 已派发（副标题更新）但目标页从未真正建立。',
      '对照实验（修复前）：把到达方式换成「点击页头的『新建实例』按钮」后，`Step1Item..Step4Item` / `NameBox` / `DirPreviewText` / `IconGrid` / `ColorGrid` / `CancelButton` / `CreateButton` 全部出现，并连续 20 秒稳定 —— 证明页面本身没问题，问题在"导航早于后端装配"。',
      '**当前状态**：`ApplySmokeRoute` 已被并行修改为「所有深链都等 `AppServices.State.IsInitialized` 再导航」。重建后复测：`create` 与 `settings` 深链在 t+0 / t+4 / t+8 秒三次采样中都稳定拿到完整控件树，P7-08 / P8-08 因此转为通过。',
    ],
    impactOnSuite: 'P7 / P8 现在直接使用深链，并在深链失效时自动退回"点击真实入口"继续跑完其余断言；但 P7-08 / P8-08 会红，从而把回归暴露出来，而不是悄悄降级。',
  },
  {
    id: 'DEFECT-2',
    title: '`NavigateSmokeRoute` 缺少显式 `case "instances"`',
    severity: '低（当前不显形，但是静默失效的隐患）',
    status: '已修复',
    evidence: [
      '`switch (parts[0])` 只有 detail / engines / create / settings 四条 case，`instances` 落到 `default` 空操作；只因首屏恰好就是实例列表所以看不出问题。',
      '本次已补上 `case "instances"`（`MainWindow.xaml.cs`），并加注释说明为什么不能依赖 default 空操作。',
    ],
    impactOnSuite: '无功能影响；属于"自动化依赖的行为没有显式契约"的清理。',
  },
  {
    id: 'DEFECT-3',
    title: '列表卡片 / 左栏项的 UIA `Name` 是 CLR 类型名而不是显示文字',
    severity: '低（可访问性问题，且让元素定位变脆）',
    status: '**左栏那一半已随左栏改造消失**；实例卡片那一半仍未修',
    evidence: [
      '实例卡片容器：`ControlType.ListItem` + `name=\'WhalesLauncher.Views.InstanceCard\'`；~~左栏行：`name=\'WhalesLauncher.Shell.RailEntry\'`~~（该数据类型已随左栏改造删除）。',
      '左栏那一半是**自动**消解的：左栏改为静态 `NavigationViewItem` 后每项都显式写了 `AutomationProperties.Name`（实例 / 引擎版本管理 / 全局设置 / 关于 WhalesLauncher），UIA 名字就是可见文字 —— 不再有"类型名当名字"的可能。',
      '实例卡片那一半仍然成立：可见文字（实例名、状态、路径）都在子 TextBlock 上，屏幕阅读器读到的是类型名，不是"UI Alpha，已停止"。',
      '建议：给 `GridViewItem` 设 `AutomationProperties.Name="{x:Bind DisplayName}"`（或在 `InstanceCard` 上实现 `ToString()`）。',
    ],
    impactOnSuite: '左栏断言现在**按 `AutomationProperties.Name` 精确定位**（SH-02 对四项逐一精确匹配），不再依赖"文本出现在子树里"；实例卡片相关断言仍必须读子节点文本，这也是 P1 用例偏长的原因。',
  },
  {
    id: 'DEFECT-4',
    title: 'YAML 编辑器行号列 UIA 值只有 "1"',
    severity: '待确认（可能是采样时机）',
    status: '未修，且**未**作为失败断言（只断言行号列存在且非空）',
    evidence: [
      '`Gutter` 的 `ValuePattern.Value` 实测为 `\'1\'`，而同一时刻 `Editor` 的值是 8 行 115 字符的完整 `settings.yaml`。',
      '可能原因：读数发生在 `OnEditorTextChanged` 同步行号之前（UIA 读的是当时的真实值），也可能是行号同步只写了首行。',
      '没有下"这是缺陷"的结论：单次采样不足以区分上述两种可能。要定性需要"编辑后延时再读"的专项用例。',
    ],
    impactOnSuite: 'P3-02 只断言「行号列存在且可读」，不对行号数量做断言。',
  },
];

export const ENVIRONMENT_HAZARDS = [
  '**本机存在外部进程周期性终止 `WhalesLauncher.exe`。** 这不是应用缺陷 —— 用 A/B 实验证明：同时启动一个"被测"实例（深链 create）与一个"对照"实例（深链 instances，已知可稳定运行 20 秒以上），两者在**同一瞬间**（t+10.5s）一起消失；真实崩溃不会让无关进程同时消失，而且 Windows 应用程序日志里没有对应的 `Application Error` 事件。',
  '影响：用例跑到一半应用被杀，会产生一堆无意义的断言失败。',
  '对策（已实现）：',
  '1. `Start-WhalesApp` 用重定向到文件的 stdio 启动应用，避免子进程持有 runner 的 stdout 管道导致 runner 挂死（spike 期间实际踩到过）。',
  '2. 每个用例在 `finally` 里用 `Stop-WhalesApp` 的返回值判断"进程是不是已经先没了"；是则把整页标记为 `infrastructure` 失败。',
  '3. runner 只对 `infrastructure`（与超时）重试，最多 3 次；**断言失败永不重试** —— 那是产品的问题，不是环境的问题。报告里记录每页的尝试次数。',
  '4. 不依赖进程存活来判定业务结论的地方就不判定（例如 P7-02「空名不创建实例」只看临时 home 的目录数，进程是否被杀不影响结论）。',
  '建议：在这台机器上跑 UI 测试前，先确认没有其它代理/脚本在反复启停 WhalesLauncher。',
];

export const FOLLOW_UPS = [
  '1. **给 `InstanceCard` 补 `AutomationProperties.Name`**（DEFECT-3 的剩余部分；左栏那一半已随左栏改造消失）：既修可访问性，也让元素定位从"读子节点"回到"按名字找"，P1 用例会更稳更短。',
  '2. **专项确认行号列**（DEFECT-4）：加一个"编辑内容 → 等 500ms → 读 `Gutter`"的用例，把"采样时机"与"同步缺陷"区分开。',
  '3. **补 `ContentDialog` 覆盖**：本套用例刻意回避了会弹确认框的破坏性操作（删除实例等）。要覆盖需要一套"点了取消/确认再恢复现场"的用例。',
  '4. **像素级断言按需接入**：驱动已经提供 `Save-Shot` / `Get-ImageStats` / `Compare-Image`（复用 `[WinAuditCore]` 的 PrintWindow 链路），当前用例未使用，因为像素断言在主题/字体/DPI 变化下噪音大。真正需要"变了没有"的场合（如主题切换、抽屉动效）再补。',
  '5. **把 UI 测试接进带交互桌面的自建 runner**：`.github/workflows/ci.yml` 的 `ui-tests` job 已经写好但默认不跑（GitHub 托管 runner 是 session 0，跑不了）。有一台交互式 Windows 机器后把它设为 self-hosted runner 即可启用。',
  '6. **固定每页断言数下限**：当前每页 6–10 条。若某页新增控件，先在 `lib/labels.mjs` 的 `CHECKS` 里登记标题再写断言，避免断言标题散落在 `.ps1` 里（也不得不散落，因为 `.ps1` 不能写中文）。',
];
