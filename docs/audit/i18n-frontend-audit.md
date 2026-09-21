# WhalesLauncher 前端用户可见字符串普查（只读调研报告）

调查范围：`desktop/src/WhalesLauncher.App`（含 `obj/`、`bin/` 之外的**全部** XAML 与 C# 文件）。
所有证据均为 `相对路径:行号`。路径基准为 `F:\WhalesLauncher`。

> 计数口径说明：下文「条数」= **独立的中文字符串字面量/属性值数量**，不含 `<!-- -->` XAML 注释、不含 `///`/`//` C# 注释、不含 `Debug.WriteLine` 等仅进调试器的文本（后者单独标注为「内部」）。

---

## 一、用户可见文案的载体分布

### 1.1 XAML 属性上的中文字面量（最大头）

共 **13 个** XAML 文件含用户可见属性文案，估算 **约 330 条**。

| 属性载体 | 实例 | 大致条数 |
|---|---|---|
| `Text=` | `Views\InstancesPage.xaml:503` `Text="正在读取实例列表…"`；`Views\Detail\LogView.xaml:140` `Text="暂无日志"` | ~150 |
| `Content=` | `Views\InstancesPage.xaml:534` `Content="创建第一个实例"`；`Views\AboutPage.xaml` 无；`Views\EnginesPage.xaml:508` `Content="安装最新版"` | ~55 |
| `Header=` | `Views\InstancesPage.xaml:125` `Header="排序"`；`Views\Detail\InstanceSettingsView.xaml:262` `Header="名称"`；`Views\Detail\LogsView.xaml:105` `Header="跟随"` | ~20 |
| `Title=`（PageHeader / InfoBar / Expander） | `Views\InstancesPage.xaml:42` `Title="实例"`；`Views\EnginesPage.xaml:337` `Title="操作失败"`；`Views\Detail\LogView.xaml:37` `Title="较早日志已截断"` | ~20 |
| `Description=` | `Views\InstancesPage.xaml:43`；`Views\AboutPage.xaml:43`；`Views\EnginesPage.xaml:282`；`Views\WizardPage.xaml:74` | 4 |
| `ToolTipService.ToolTip=` | `MainWindow.xaml:81` `"打开或关闭运行日志抽屉（Ctrl+L）"`；`Views\InstancesPage.xaml:57`；`Views\Detail\PluginsView.xaml:76`/`319`；`Views\InstancesPage.xaml:644`（EnginesPage） | ~9 |
| `AutomationProperties.Name=` | `MainWindow.xaml:80`、`240`、`251`、`262`、`276`；`Views\InstancesPage.xaml:52`、`56`、`66`、`77`、`104`；`Views\WizardPage.xaml:144-155`（12 个 emoji 名称）、`171-186`（6 个色板名） | ~75 |
| `PlaceholderText=` | `Views\InstancesPage.xaml:102` `"搜索实例名、目录名、备注"`；`Views\WizardPage.xaml:108`、`200`；`Views\SettingsPage.xaml:110`、`149`；`Views\Detail\InstanceSettingsView.xaml:264`、`271`、`277`、`284`、`325` | ~11 |
| `SelectorBarItem Text=` / `ComboBoxItem Content=` | `Views\InstancesPage.xaml:112-115`（全部/运行中/已停止/需处理）、`127-130`（最近启动/名称/创建时间/插件数）；`Views\EnginesPage.xaml:397-398` | ~12 |
| `ToggleSwitch OnContent=/OffContent=` | `Views\SettingsPage.xaml:270-271` `OnContent="需要确认"` `OffContent="直接删除"` | 2 |
| `InfoBar Message=`（内联元素形式） | `Views\EnginesPage.xaml:339`、`359`、`379`；`Views\Detail\PluginsView.xaml:396` | ~5 |
| `x:String` 下拉项 | `Views\SettingsPage.xaml:95-96`（深色/浅色）；`Views\WizardPage.xaml:285-286`、`298-299`、`311-312`、`324-325`；`Views\Detail\PluginsView.xaml:40-42` | 13 |
| `MenuFlyoutItem/SubItem Text=`（卡片"更多"菜单） | `Views\InstancesPage.xaml:408`、`413`、`420`、`425`、`430`、`435`、`440`、`447`、`452`、`457`、`463`、`470` | 12 |

### 1.2 XAML 内联元素内容

- **`<Run Text="..."/>`：无**（全仓 0 处）。
- **`<Hyperlink>` / `NavigateUri`：无**（全仓 0 处）。
- **`<TextBlock>中文</TextBlock>` 直接内文：无**。所有含中文的 TextBlock 均走 `Text="..."` 属性。
- **`<x:String>中文</x:String>`：13 条**（上表末行），这是 XAML 里唯一"伪内联元素"形式的文案。

### 1.3 C# 代码里的字符串字面量

按文件统计（**仅中文字面量，不含注释**）。`obj/`、`bin/` 已排除。

| 文件 | 条数 | 备注 |
|---|---|---|
| `Services\CoreBridge.cs` | 85 | 其中 **48 条是 `Debug.WriteLine` 内部文本**；**约 37 条面向用户** |
| `Views\EnginesPage.xaml.cs` | 86 | 全文由 `x:Name.Text = "..."` 赋值、InfoBar、Toast 组成 |
| `Views\Detail\InstanceSettingsView.xaml.cs` | 68 | 含 4 处「值→显示名」表 |
| `Views\InstancesPage.xaml.cs` | 58 | 卡片视图模型 `InstanceCard` 内的复合消息 |
| `Views\WizardPage.xaml.cs` | 45 | 含模板说明 switch、步骤校验文案 |
| `Shell\PreflightPresenter.cs` | 41 | 多行 `+` 拼接的对话框正文 |
| `Views\SettingsPage.xaml.cs` | 39 | |
| `Views\Detail\PluginsView.xaml.cs` | 30 | 大量 `{n} 个…` 量词 |
| `Views\InstanceDetailPage.xaml.cs` | 26 | 面包屑摘要 `$"目录名：{...}"` 系列 |
| `Services\NodeProvisioner.cs` | 24 | 进度消息 `$"正在下载 Node {ver}…"` |
| `Shell\ShellHostMethods.cs` | 14 | 仅 2 条用户可见（`101`、`196`），余为内部 `throw`/Debug |
| `Services\NameValidator.cs` | 11 | 校验消息 |
| `Shell\LogDrawer.cs` | 10 | |
| `Views\Detail\StatePresentation.cs` | 10 | 两张状态映射表 |
| `Services\Formatters.cs` | 9 | **全部含数字/时间/单位** |
| `Shell\InstanceStateText.cs` | 6 | 状态映射第 2 份 |
| `Views\Detail\YamlLint.cs` | 6 | |
| `Views\Detail\LocalPluginRow.cs` | 8 | 徽标文本 + 来源映射 |
| `Views\AboutPage.xaml.cs` | 7 | |
| `Views\Detail\SavesView.xaml.cs` | 6 | |
| `Services\NavigationService.cs` | 5 | 页签名 + 路由名 |
| `Services\DialogService.cs` | 4 | 默认按钮字 |
| `Services\AppServices.cs` | 3 | 仅异常文本 |
| `Views\Detail\YamlEditorView.xaml.cs` | 2 | |
| `Views\Detail\DetailBreadcrumb.cs` | 1 | `23: public const string RootLabel = "实例";` |
| `Views\Detail\BundleRow.cs` | 1 | `32: "版本未知"` |
| `Views\Detail\PluginRow.cs` | 1 | `35: "已安装" / "未安装"` |
| `Views\Detail\LogView.xaml.cs` | 1 | `273:` 截断提示 |
| `Services\PreflightService.cs` | 1 | 内部 Debug |
| `App.xaml.cs` | 6 | Toast + 异常 |
| `MainWindow.xaml.cs` | 27 | 见 §2.4 |

**明确为「无用户可见中文字面量」的文件**：
- 全部 `Models\*.cs`（0 条）——中文只存在于 `///` XML 文档注释中，逐文件核验通过。
- `Services\ToastService.cs`、`Services\BridgeResult.cs`、`Services\Channels.cs`、`Services\AppState.cs`（仅注释）。
- `Shell\AppMenuBuilder.cs`（**0 条**，见 §1.5）。
- `Controls\PageHeader.xaml.cs`、`Controls\ToastHost.xaml.cs`、`Controls\ToastHost.xaml`、`Controls\PageHeader.xaml`、`Themes\Tokens.xaml`、`App.xaml`（仅注释）。
- `Views\Detail\LogRow.cs`、`Views\Detail\SessionRow.cs`（0 条）。

### 1.4 `*Values.cs` 文件的真实性质（关键结论）

**它们不是「值→显示文本」映射，而是英文契约枚举值的字符串常量集。** 逐条证据：

| 文件 | 字面值 | 证据 |
|---|---|---|
| `Models\InstanceStateValues.cs` | `"stopped"` `"starting"` `"running"` `"stopping"` `"crashed"` | `:12-16`，注释 `:5` 注明「来源：`src/shared/contracts.ts:108`」 |
| `Models\ShareModeValues.cs` | `"local"` `"shared"` | `:13`、`:16`，注释 `:6-8` 说明「契约里是字符串联合类型 `'local' \| 'shared'`，按约定 §3 **不用 enum**」 |
| `Models\CredentialsModeValues.cs` | `"inherit"` `"local"` | `:10`、`:13` |
| `Models\InstanceFolderValues.cs` | `"root"` `"home"` `"workspace"` `"logs"` `"plugins"` | `:12-16`，且 `:8` 注明「拼错时 Node 侧会立刻给出中文错误」 |
| `Models\PluginOriginValues.cs`（同型） | `"archive"` `"github"` `"folder"` `"manual"` `"unknown"` | `PluginSummary.cs:71-83` |

**结论：这些常量是「机器值」（wire value），用于 RPC 参数、字符串比较与序列化，与界面语言无关；它们是 i18n 的安全区（不需要也不应该翻译）。**

真正的「值→中文显示名」映射发生在**视图层**，共有 **6 处**、且同一映射存在**多处重复实现**：

| 映射对象 | 位置 | 证据 |
|---|---|---|
| 实例运行态 → 中文标签（第 1 份） | `Shell\InstanceStateText.cs` | `:22-28`（5 态 + `null or "" => "状态未知"`） |
| 实例运行态 → 中文标签（第 2 份，**重复**） | `Views\InstancesPage.xaml.cs` `InstanceCard.LabelOf` | `:1152-1160` |
| 实例运行态 → 中文标签（第 3 份，**重复**） | `Views\Detail\StatePresentation.cs` `Label` | `:14-21` |
| 实例运行态 → 主按钮文案/可用性 | `Views\Detail\StatePresentation.cs` `For` | `:24-31` |
| 实例运行态 → 主按钮文案（**第 2 份，重复**） | `Views\InstancesPage.xaml.cs` `PrimaryOf` | `:1243-1250` |
| 共享/凭证模式 → 中文显示名 | `Views\Detail\InstanceSettingsView.xaml.cs` `ShareOptions`/`CredentialsOptions` + `Label()` | `:38-48`、`:563` |
| 共享/凭证模式 → 中文显示名（**重复**） | `Views\WizardPage.xaml.cs` `DescribeShareMode`/`DescribeCredentials` | `:676-680` |
| 插件来源 → 徽标文本 | `Views\Detail\LocalPluginRow.cs` | `:36-43` |
| 自检项状态 → 中文状态名 | `Controls\PreflightReportView.xaml.cs` | `:181-185` |
| Node 来源 → 中文来源名（**3 份重复**） | `Services\CoreBridge.cs:185-194`、`Views\EnginesPage.xaml.cs:364-372`、`Views\SettingsPage.xaml.cs:563-571` | 三处 switch 高度相似但文案不一致 |

> ⚠️ 上表最后一行值得单独注意：`NodeRuntimeSourceValues` 的中文映射被**抄了三份且文案已漂移**。例如 `Portable`：`CoreBridge.cs:191` 写「启动器自备运行时」、`EnginesPage.xaml.cs:370` 用 `Common`→「常见安装位置」（**漏了 `Portable` 分支**）、`SettingsPage.xaml.cs:569` 写「启动器自备运行时」。

### 1.5 菜单、命令、快捷键描述

**`Shell\AppMenuBuilder.cs` 内没有任何中文字符串（0 条）。** 该文件是纯粹的投影器：

- `:42` `new MenuBarItem { Title = node.Label }` —— 顶层标题取自后端 `node.Label`
- `:63`、`:69`、`:79` 下游 `MenuFlyoutItem/SubItem.Text = node.Label` —— 同样来自后端
- `:88` `item.KeyboardAcceleratorTextOverride = node.Accelerator` —— 快捷键描述来自后端
- `:89` `AutomationProperties.SetAcceleratorKey(item, node.Accelerator)`
- 文件头注释 `:10-12` 明确：「菜单项的 id/label/accelerator 与 Node 侧真实命令同源，界面再抄一份必然漂移」

**事实补充（重要）**：在当前工作区中，Node 侧**尚未实现** `menuSpec()`——全仓检索 `menuSpec` 只命中 `src\shared\contracts.ts:619` 的注释，检索含中文的 `label:` 字面量在 `src/` 下**零命中**。因此：

- 菜单栏文案当前**完全不在前端**，是后端契约待补的部分（前端只负责投影）。
- 前端对菜单加载失败有兜底文案：`MainWindow.xaml.cs:439` `Toast.Error("应用菜单加载失败", result.Error ?? "后端未返回菜单数据。")`、`:455` `"菜单命令执行失败"`。

**真正在前端硬编码的「菜单/导航/快捷键」文案**在别处：

| 载体 | 证据 |
|---|---|
| 左栏静态导航项（3 项 + 关于） | `MainWindow.xaml:240-241` 实例、`:251-252` 引擎版本管理、`:262-263` 全局设置、`:276-277` 关于 |
| 标题栏副标题（当前页名） | `MainWindow.xaml.cs:593-601` `SubtitleFor` → 实例 / 实例详情 · {页签} / 引擎版本管理 / 新建实例 / 全局设置 / 关于 |
| 主题按钮标签与无障碍名 | `MainWindow.xaml.cs:661-663`（浅色/深色/跟随系统）、`:668` `$"切换深浅色主题（{label}）"` |
| 日志抽屉标题/按钮 | `MainWindow.xaml:80`、`81`、`90`、`94`、`143`、`147-148`、`166-167`、`172-174`、`186`、`189`、`194`、`197` |
| 详情页 4 个页签名 | `Services\NavigationService.cs:24-31` `DetailTabs.Label` → 插件/设置/存档/日志 |
| 快捷键**描述**（ToolTip 内） | `MainWindow.xaml:81` 「（Ctrl+L）」；`Views\Detail\InstanceSettingsView.xaml` 无；`Views\Detail\YamlEditorView.xaml:84` 注释提到 Ctrl+S |

---

## 二、难以本地化的构造

### 2.1 字符串拼接 / 复合消息

**(a) 多行 `+` 拼接的对话框正文**

```csharp
// Shell\PreflightPresenter.cs:206-211
"启动器的全部功能都由一个 Node 进程执行，而这台机器上目前没有可用的 Node.js。\n\n" +
"可以自动下载一份官方 Node 便携版放在启动器目录里（约 30MB，使用 v22 LTS）：\n" +
"· 不需要管理员权限，也不改动系统设置；\n" +
"· 随启动器目录一起存在，卸载时删掉目录即可；\n" +
"· 之后如需换用自己安装的 Node，可在「全局设置 → Node 可执行文件路径」里指定。\n\n" +
$"探测结论：{reason}");
```

同类：`Shell\PreflightPresenter.cs:164-167`（引擎安装确认正文）、`Views\InstancesPage.xaml.cs:982-984`（删除确认正文）、`Services\CoreBridge.cs:155-157`、`:757-760`、`:908-909`、`:930-931`、`Views\Detail\InstanceSettingsView.xaml.cs:456-457`、`:477-478`。

**(b) `string.Join` 用中文分隔符**

| 位置 | 证据 |
|---|---|
| 顿号 `、` 连接实例名 | `Views\InstancesPage.xaml.cs:553` `string.Join('、', attention.Take(3)...)` |
| 顿号连接被占用实例名 | `Views\EnginesPage.xaml.cs:1240` `$"被 {UsedByCount} 个实例占用：{string.Join("、", usedByNames)}"` |
| 顿号连接引擎版本 | `Views\AboutPage.xaml.cs:95` `string.Join("、", versions)` |
| 顿号连接行号 | `Views\Detail\YamlLint.cs:83` `string.Join("、", lineNumbers.Take(shown).Select(n => $"第 {n} 行"))` |
| 顿号连接组合包 | `Views\WizardPage.xaml.cs:610` `"组合包：" + string.Join("、", bundles)` |
| 空格连接降级原因 | `Views\InstancesPage.xaml.cs:1226` `string.Join(' ', reasons)` |
| 换行连接 | `Services\CoreBridge.cs:1317`、`Views\InstancesPage.xaml.cs:652`、`Views\EnginesPage.xaml.cs:361`、`:1123` |

**(c) `StringBuilder` 组装**

- `Views\EnginesPage.xaml.cs:946-952`：`builder.Append(line.TimeText).Append(' ').Append(line.StreamLabel)...` 复制的日志全文，末尾 `$"已复制 {LogLines.Count} 行安装日志"`。
- `Views\Detail\YamlEditorView.xaml.cs:138`、`:142`：`builder.Append($"；另有 {_findings.Count - shown} 处")` + `"（仅为明显问题的提示，真正的校验由后端 profile.validateYaml 给出）"`。

**(d) 中文文案片段被当作 switch 分支/参数传入**

- `Views\Detail\InstanceSettingsView.xaml.cs:451`、`462`、`472`、`483`：`dimension: "工作区"` / `"存档"` / `"设置"` / `"凭证"`，随后在 `:525` `$"将把「{dimension}」从「…」改为「{option.Label}」。"` 与 `:547` `$"切换{dimension}隔离失败"`、`:557` `$"{dimension}隔离已改为「{option.Label}」"` 中被拼接。**中文词被当数据用**，本地化后需处理词序。
- `Views\Detail\PluginsView.xaml.cs:265`：`$"无法{(desired ? "启用" : "停用")}组合包 {name}"` —— 中文动宾结构在中括号内。
- `Views\Detail\PluginsView.xaml.cs:368`：`PickButton.Content = InstallKind.SelectedIndex == 2 ? "选择插件文件夹…" : "选择 zip 文件…";`

**(e) 用中文文案做逻辑判据（危险）**

```csharp
// App.xaml.cs:138
&& ex.Message.Contains("未找到可用的 Node.js 运行时", StringComparison.Ordinal)
```

这是**用中文异常消息字符串做条件判断**——一旦本地化就静默失效。该中文原文出自 `Services\CoreBridge.cs:155`。

### 2.2 含数字 / 单位 / 日期时间的文案

| 构造 | 位置 | 证据 |
|---|---|---|
| 相对时间（分钟/小时/天） | `Services\Formatters.cs:46`、`50`、`53`、`56`、`59`、`68`、`69`、`72` | `$"{min} 分钟前"`、`$"{hour} 小时前"`、`$"昨天 {Pad(h)}:{Pad(m)}"`、`$"{day} 天前"`、`"从未启动"`、`"刚刚"` |
| 绝对日期/时间/时钟 | `Services\Formatters.cs:16-40` | `$"{v.Year}-{Pad(v.Month)}-{Pad(v.Day)} {Pad(v.Hour)}:{Pad(v.Minute)}"`、`"--:--:--"`、`"—"` 占位符 |
| 运行时长 | `Services\Formatters.cs:77-85` | `"00:00:00"` 兜底 |
| 文件体积 + 单位数组 | `Services\Formatters.cs:94` | `string[] units = { "KB", "MB", "GB", "TB" }`，`:92` `$"{(long)value} B"`，`:104` `scaled.ToString("F"+digits) + " " + units[idx]` |
| 体积未知 | `Services\Formatters.cs:115` | `return "未知";`（`FormatEngineSize`） |
| 超大数/无数字 | `Services\Formatters.cs:19`、`:28`、`:37`、`:90` | `"—"` 破折号占位（同时也是 `Views\AboutPage.xaml:87/100/113/126/163/176` 的初始 `Text="—"`） |
| 路径中间省略 | `Services\Formatters.cs:119-137` | `"…"`、`head + "\\…\\"` |
| 超时秒数（复合） | `Services\CoreBridge.cs:908` | `$"{method} 调用超时（{timeout.TotalSeconds.ToString("0.#", ...)} 秒无响应）。"` |
| 探针超时毫秒 | `Services\CoreBridge.cs:319` | `$"探针超时（超过 {ProbeTimeoutMs} 毫秒无响应）"` |
| 字节上限 | `Services\CoreBridge.cs:930` | `$"请求超过单行上限（{byteCount} 字节 > {MaxLineBytes} 字节，协议 §1）。"` |
| 节点版本号（多档） | `Services\CoreBridge.cs:412` | `$"Node.js 版本过低（v{version}），dsh 需要 >= v{MinNodeMajor}"` |
| 下载下载量/速度 | `Services\NodeProvisioner.cs:123`、`:327`、`:336` | `$"正在下载 Node {release.Version}（{release.ArchiveName}）…"` |
| SHA-256 校验（截断哈希） | `Services\NodeProvisioner.cs:142-143` | `$"下载的 Node 压缩包校验失败（期望 {release.Sha256[..12]}…，实际 {actual[..12]}…）。"` |
| HTTP 状态码 | `Services\NodeProvisioner.cs:304` | `$"下载失败：HTTP {(int)response.StatusCode}（{release.Url}）"` |
| 日志行计数/丢弃数 | `Views\EnginesPage.xaml.cs:1095`、`:1096` | `$"共 {LogLines.Count} 行（较早的 {_droppedLines} 行已丢弃）"` / `$"共 {LogLines.Count} 行"` |
| 显示/总行数 | `Shell\LogDrawer.cs:373`、`Views\Detail\LogsView.xaml.cs:273` | `$"显示 {Visible} / 共 {Total} 行"`；XAML 静态初始值 `Views\Detail\LogsView.xaml:132` `Text="显示 0 / 共 0 行"` |
| 截断提示 | `Views\Detail\LogView.xaml.cs:273` | `$"已丢弃最早的 {DroppedCount} 行（渲染上限 {Math.Max(100, MaxLines)} 行）"`；XAML 初值 `Views\Detail\LogsView.xaml:139` `Text="较早日志已截断（已丢弃 0 行）"` |
| 存档合计与体积 | `Views\Detail\SavesView.xaml.cs:193-196` | `"体积未知"` / `$"合计 {Formatters.FormatBytes(totalBytes)}" + "（部分未知）"` / `$"共 {Rows.Count} 个存档，{sizeText}"`；XAML 初值 `Views\Detail\SavesView.xaml:61` `Text="共 0 个存档"` |
| 自检汇总（4 项计数 + 耗时） | `Controls\PreflightReportView.xaml.cs:68-70` | `$"共 {n} 项：正常 {ok} · 自动修复 {fixed} · 待处理 {attention}" + (…$" · 未检查 {skipped}") + $"（用时 {report.ElapsedText}）"` |
| 自检待处理数 | `Shell\PreflightPresenter.cs:93` | `$"环境自检发现 {report.ProblemCount} 项待处理"`；`Views\SettingsPage.xaml.cs:624` `$"自检完成：{report.ProblemCount} 项待处理"` |
| 版本计数 | `Views\AboutPage.xaml.cs:95` | `$"已安装 {versions.Count} 个版本：{…}"` |
| 补丁行号 | `Views\Detail\YamlLint.cs:83-86` | `$"第 {number} 行"`、`$" 等 {lineNumbers.Count} 处"` |
| 端口/URL | `Views\InstancesPage.xaml.cs:1055`、`1056` | `$":{port}"`、`$"监听端口（多实例自动避让）：{port}"` |
| 时间调度 | `Views\EnginesPage.xaml.cs:519` | `DateTimeOffset.Now.ToString("o")`（ISO 原样，非本地化文本） |

### 2.3 复数 / 量词

中文无复数形态，但**量词结构（`{n} 个/行/项/处/条/次`）遍布全前端**，英文改造时每一个都需要 `one/other` 分支：

| 量词模式 | 实例 |
|---|---|
| `{n} 个实例` | `Views\InstancesPage.xaml.cs:1034` `$"{summary.PluginCount} 个依赖"`；`:437` `$"没有实例匹配当前搜索或筛选条件（共 {_all.Count} 个实例）。"`；`:554` `$" 等 {attention.Count} 个"`；`Views\EnginesPage.xaml.cs:1240`、`:1279`；`Views\WizardPage.xaml.cs:531` |
| `{n} 个存档` | `Views\Detail\SavesView.xaml.cs:196`；`Views\Detail\SavesView.xaml:61` |
| `{n} 个版本` | `Views\AboutPage.xaml.cs:95` |
| `{n} 行` | `Shell\LogDrawer.cs:283`、`:373`；`Views\Detail\LogsView.xaml.cs:204`、`:273`、`:277`；`Views\EnginesPage.xaml.cs:1095-1096` |
| `{n} 项` | `Views\EnginesPage.xaml.cs:1122` `$"操作失败（{_errors.Count} 项）"`；`Controls\PreflightReportView.xaml.cs:68`；`Shell\PreflightPresenter.cs:93` |
| `{n} 处` | `Views\Detail\YamlLint.cs:86`；`Views\Detail\YamlEditorView.xaml.cs:138` |
| `{n} 条` | `Shell\LogDrawer.cs:384` `$"运行日志有 {count} 条未读错误"` |
| `{n} 个依赖 / {n} 个插件` | `Views\Detail\PluginsView.xaml.cs:145`、`:152`、`:158`、`:165` |
| `{n} 个共享冲突` | `Views\Detail\InstanceSettingsView.xaml.cs:285` `$"{_conflicts.Length} 个共享冲突需要解决"` |
| `{n} 个追加参数` | `Views\Detail\InstanceSettingsView.xaml.cs:748` `$"已保存 {args.Length} 个追加参数"` |
| `第 {n} 步 / 第 {n} 行` | `Views\WizardPage.xaml.cs:227` `$"还不能进入第 {target + 1} 步"`、`:758` `$"第 {step + 1} 步还没填完"`；`Views\Detail\YamlLint.cs:83` |
| `{n} 个字符`（长度限制） | `Services\NameValidator.cs:47` `$"实例名最长 {NameMaxLength} 个字符"` |

### 2.4 XAML 中被代码动态赋值的文本（x:Name → `.Text =`）

**这是「XAML 里写了中文初值、运行时又被 C# 覆盖」的双写点**，两处都需本地化：

| XAML 元素（x:Name） | XAML 初值（静态文案） | C# 赋值点 |
|---|---|---|
| `AboutPage.xaml:83 LauncherVersionText` | `:87 Text="—"` | `AboutPage.xaml.cs:39` |
| `AboutPage.xaml:96 UiFrameworkText` | `:100` | `AboutPage.xaml.cs:40`、`:56` |
| `AboutPage.xaml:109 NodeRuntimeText` | `:113` | `AboutPage.xaml.cs:41`、`:66`、`:71`、`:74-75` |
| `AboutPage.xaml:122 EnginesText` | `:126` | `AboutPage.xaml.cs:42`、`:84`、`:94-95` |
| `AboutPage.xaml:159 RootDirText` | `:163` | `AboutPage.xaml.cs:43` |
| `AboutPage.xaml:172 PrimaryHomeText` | `:176` | `AboutPage.xaml.cs:44` |
| `EnginesPage.xaml:408 NodeCaption` | `Text="当前生效的 Node：检测中…"` | `EnginesPage.xaml.cs:319`、`:332`、`:339`、`:348` |
| `EnginesPage.xaml:311 NodeBadgeText`（附近） | `Text="检测中…"` | `EnginesPage.xaml.cs:1105`（`SetNodeBadge`，`:318/331/338/347` 传入） |
| `EnginesPage` 空态 `InstalledEmptyTitle/Desc/Icon` | `:494 Text="还没有安装任何引擎版本"` | `EnginesPage.xaml.cs:1031-1032`、`:1041-1044` |
| `EnginesPage` 空态 `AvailableEmptyTitle/Desc/Icon` | `:591 Text="无法获取可用版本"` | `EnginesPage.xaml.cs:1069-1070`、`:1075-1078` |
| `EnginesPage.xaml:656 LogLineCountText` | `Text="暂无日志"` | `EnginesPage.xaml.cs:1092-1096` |
| `EnginesPage` `LogHeaderStatus` | — | `EnginesPage.xaml.cs:1098-1100` |
| `EnginesPage` `AvailableWarningText` / `NodeWarningText` / `ErrorDetailText` | `Views\EnginesPage.xaml:339/359/379` 同类 InfoBar Message | `EnginesPage.xaml.cs:1123`、`:1136`、`:1142-1144` |
| `InstancesPage.xaml:65 PrimaryActionText`（在 `InstanceDetailPage.xaml:65`） | `Text="启动"` | `InstanceDetailPage.xaml.cs`（`StatePresentation.For`）、`InstancesPage.xaml.cs:1081` |
| `InstancesPage.xaml:503` 等三处空态文字 | `:503`、`:524`、`:528`、`:557`、`:562` | `InstancesPage.xaml.cs:440-442` 写入 `EmptyFilterHint.Text` |
| `InstancesPage` `FilterBar.Message` | `Views\InstancesPage.xaml:155` 附近 | `InstancesPage.xaml.cs:437` |
| `InstancesPage` `DegradeBar.Message` | `Views\InstancesPage.xaml:146` Title | `InstancesPage.xaml.cs:563` |
| `LogsView.xaml:132 CountText`、`:139 TruncateText` | `"显示 0 / 共 0 行"`、`"较早日志已截断（已丢弃 0 行）"` | `LogsView.xaml.cs:273`、`:277`、`:281-282` |
| `SavesView` `SummaryText`、`FilteredEmpty` | `Views\Detail\SavesView.xaml:61`、`:178` | `SavesView.xaml.cs:193-196` |
| `SettingsPage.xaml` `RootDirBox`、`VersionText`、`NodeCaption` 类 | `SettingsPage.xaml:124`、`:174` | `SettingsPage.xaml.cs:76`、`:80`、`:122` |
| `SettingsPage` 候选行 `Text`（动态构造） | — | `SettingsPage.xaml.cs:522`、`:552` |
| `InstanceSettingsView` `DirNameText`、`ConflictBar.Title` | `InstanceSettingsView.xaml:47` `Text="有未保存的更改"` | `InstanceSettingsView.xaml.cs:385`、`:285` |
| `PreflightReportView.xaml:48 ConclusionText` 等 | `:48 Text="尚未运行环境自检。"`、`:56 Title="环境自检未能完成"` | `PreflightReportView.xaml.cs:48`、`:68-70`、`:137`、`:181-185` |
| `MainWindow` `ThemeLabel`、`AppTitleBar.Subtitle`、`LogDrawer` `_countText`/`_sourceBox` | `MainWindow.xaml:106 Text="主题"`、`:80`/`:94` 等 | `MainWindow.xaml.cs:661-663`、`:565`、`:593-601`；`LogDrawer.cs:151`、`:373` |
| `WizardPage` 摘要卡字段 | `WizardPage.xaml:363 Text="（未填写）"` | `WizardPage.xaml.cs:689-703` |
| `WizardPage` `StatusBar` InfoBar | `Views\WizardPage.xaml` Row1 | `WizardPage.xaml.cs:83`、`:170-171`、`:227`、`:247`、`:327`、`:352`、`:790`、`:807`、`:901` |

**另外一类：XAML 完全没有声明、由 C# 用 `new TextBlock { Text = "中文" }` 手工构造的行**（i18n 时无 XAML 可改）：

- `Views\WizardPage.xaml.cs:520-573`：引擎行（`GetInstalledEngineRow`/`BuildPendingEngineRow`）——`:556`、`:565`
- `Views\WizardPage.xaml.cs:591-616`：模板选项行
- `Views\SettingsPage.xaml.cs:522`、`:552`：Node 候选行
- `Controls\PreflightReportView.xaml.cs:106`、`:127`、`:137`
- `Shell\PreflightPresenter.cs:247`、`:252`：进度对话框正文

---

## 三、逐文件统计总表

> 类别代号：**X**=XAML 属性文案 · **L**=C# 纯字面量 · **I**=插值 `$""` · **C**=拼接/`Join`/`StringBuilder` · **N**=含数字/单位/时间 · **Q**=量词 · **M**=值→显示名映射 · **A**=无障碍/提示 · **R**=运行时覆写 XAML · **T**=Toast/InfoBar · **D**=对话框 · **E**=异常（多为内部）

### 3.1 XAML 文件

| 文件 | 大致条数 | 主要类别 | 典型示例（含行号） |
|---|---|---|---|
| `Views\InstancesPage.xaml` | ~62 | X, A, R | `:528` `Text="实例是一份独立的 dsh 运行环境，拥有自己的工作区、插件与设置。…"` |
| `Views\WizardPage.xaml` | ~56 | X, A | `:214` `Text="实例必须绑定一个**已安装**的 dsh 引擎版本。…"` |
| `Views\EnginesPage.xaml` | ~44 | X, A, R | `:282` `Description="管理本机 dsh 引擎版本：安装新版本、查看被哪些实例占用、移除不再需要的版本。"` |
| `Views\SettingsPage.xaml` | ~36 | X, A | `:155` `Text="必须是绝对路径，且指向真实存在的 node 可执行文件。…"` |
| `Views\Detail\InstanceSettingsView.xaml` | ~34 | X, A | `:211` `Text="共享时实例的工作区通过 junction 指向 shared/workspaces/&lt;目录名&gt;…"` |
| `Views\Detail\PluginsView.xaml` | ~32 | X, A | `:574` `Text="该实例只使用随 dsh 提供的组合包"` |
| `MainWindow.xaml` | ~22 | X, A | `:81` `ToolTipService.ToolTip="打开或关闭运行日志抽屉（Ctrl+L）"` |
| `Views\Detail\SavesView.xaml` | ~11 | X, A | `:178` `Text="该工作区暂无存档"` |
| `Views\Detail\LogView.xaml` | ~8 | X, A | `:146` `Text="启动实例后将在此显示"` |
| `Views\InstanceDetailPage.xaml` | ~12 | X, A | `:112` `Text="实例不存在"` |
| `Views\AboutPage.xaml` | ~12 | X | `:203` `Text="WhalesLauncher 以 MIT 许可证开源，仓库根目录的 LICENSE 是许可全文。"` |
| `Views\Detail\LogsView.xaml` | ~8 | X, A | `:88` `PlaceholderText="关键字过滤"` |
| `Controls\PreflightReportView.xaml` | 2 | X | `:48` `Text="尚未运行环境自检。"` |
| `Views\Detail\YamlEditorView.xaml` | 2 | X, A | `:97` `Text="纯文本模式（降级路径）：无语法着色，行号列与编辑区各自滚动"` |
| `Views\Detail\SavesView.xaml`（重复计入上表） | — | — | — |
| `App.xaml` / `Themes\Tokens.xaml` / `Controls\PageHeader.xaml` / `Controls\ToastHost.xaml` | **0** | 仅注释 | — |

### 3.2 C# 文件

| 文件 | 大致条数 | 主要类别 | 典型示例（含行号） |
|---|---|---|---|
| `Views\EnginesPage.xaml.cs` | ~86 | I, C, N, Q, T, D, R, M | `:1240` `UsedText = $"被 {UsedByCount} 个实例占用：{string.Join("、", usedByNames)}"` |
| `Services\CoreBridge.cs` | ~37 用户可见 / 48 内部 | I, C, N, E, M | `:1319` `$"后端已断开：桥接进程已退出（退出码 {codeText}）。界面已禁用写操作，请重启应用。\n最近 stderr：\n{lastLines}"` |
| `Views\Detail\InstanceSettingsView.xaml.cs` | ~68 | I, C, M, D, T, Q | `:38-48` `new("独立（默认）", ShareModeValues.Local)`；`:525` `$"将把「{dimension}」从「{Label(options, current)}」改为「{option.Label}」。"` |
| `Views\InstancesPage.xaml.cs` | ~58 | I, C, N, Q, T, M, R | `:437` `FilterBar.Message = $"没有实例匹配当前搜索或筛选条件（共 {_all.Count} 个实例）。"` |
| `Views\WizardPage.xaml.cs` | ~45 | I, C, M, Q, D, T, R | `:610` `"组合包：" + string.Join("、", bundles)`；`:622-630` 模板说明 switch |
| `App.xaml.cs` | 6 | I, T, E, **中文判据** | `:138` `ex.Message.Contains("未找到可用的 Node.js 运行时", …)` |
| `MainWindow.xaml.cs` | ~27 | L, I, M, T | `:596` `$"实例详情 · {DetailTabs.Label(args.Tab)}"`；`:661-663` 主题标签 |
| `Shell\PreflightPresenter.cs` | ~41 | C, D, T, N | `:206-211` 多行 `+` 拼接的 Node 缺失对话框正文 |
| `Views\SettingsPage.xaml.cs` | ~39 | I, T, M, N | `:80` `$"启动器版本 {version}"`；`:563-571` Node 来源映射 |
| `Views\Detail\PluginsView.xaml.cs` | ~30 | I, Q, T, D | `:165` `$"{ledgerMismatch} 个插件的安装状态与自检结论不一致"` |
| `Views\InstanceDetailPage.xaml.cs` | ~26 | I, N, T, M | `:389-394` `$"目录名：{meta.DirName}"` / `$"插件数：{_instance.PluginCount}"` |
| `Services\NodeProvisioner.cs` | ~24 | I, N, E, R | `:123` `$"正在下载 Node {release.Version}（{release.ArchiveName}）…"` |
| `Shell\ShellHostMethods.cs` | 2 用户可见 / 12 内部 | L, N, D, E | `:101` `picker.FileTypeChoices.Add("WhalesLauncher 实例包", …)`；`:196` `dialog.CloseButtonText = … : "确定";` |
| `Services\NameValidator.cs` | ~11 | L, N, Q | `:47` `$"实例名最长 {NameMaxLength} 个字符"` |
| `Views\Detail\StatePresentation.cs` | ~10 | M | `:16-20` 状态标签；`:26-30` 主按钮文案 |
| `Shell\LogDrawer.cs` | ~10 | I, N, Q, T, A | `:373` `_countText.Text = $"显示 {_surface.VisibleCount} / 共 {_surface.TotalCount} 行"` |
| `Services\Formatters.cs` | ~9 | **全部 N/C** | `:43-73` 相对时间；`:92-104` 体积单位；`:19` `"—"` |
| `Views\Detail\LocalPluginRow.cs` | ~8 | M, L | `:36-43` 插件来源映射；`:51-52` `"bundle patch 就绪"` |
| `Views\AboutPage.xaml.cs` | ~7 | M, I, N, Q | `:95` `$"已安装 {versions.Count} 个版本：{string.Join("、", versions)}"` |
| `Shell\InstanceStateText.cs` | ~6 | M | `:22-28` 状态映射（第 1 份） |
| `Views\Detail\YamlLint.cs` | ~6 | L, Q, N | `:69` `"使用了 Tab 缩进（YAML 不允许 Tab 作为缩进）"` |
| `Views\Detail\SavesView.xaml.cs` | ~6 | I, N, Q, L | `:196` `$"共 {Rows.Count} 个存档，{sizeText}"` |
| `Services\NavigationService.cs` | ~5 | M | `:24-31` `DetailTabs.Label` 页签名 |
| `Services\DialogService.cs` | ~4 | L | `:99-100` `primaryText = "确定"` / `closeText = "取消"`；`:119` `"知道了"` |
| `Services\AppServices.cs` | ~3 | E | `:25` `"服务尚未装配：CoreBridge 为空。"` |
| `Views\Detail\YamlEditorView.xaml.cs` | ~2 | C, N | `:142` `"（仅为明显问题的提示，真正的校验由后端 profile.validateYaml 给出）"` |
| `Views\Detail\DetailBreadcrumb.cs` | 1 | M | `:23` `public const string RootLabel = "实例";` |
| `Views\Detail\BundleRow.cs` | 1 | L | `:32` `"版本未知"` |
| `Views\Detail\PluginRow.cs` | 1 | M | `:35` `Entry.Installed ? "已安装" : "未安装"` |
| `Views\Detail\LogView.xaml.cs` | 1 | N, Q, I | `:273` `$"已丢弃最早的 {DroppedCount} 行（渲染上限 {…} 行）"` |
| `Services\PreflightService.cs` | 0 用户可见 | E（Debug） | `:101` |
| `Shell\AppMenuBuilder.cs` | **0** | 仅投影后端 | `:42` `Title = node.Label` |
| `Services\ToastService.cs` / `BridgeResult.cs` / `Channels.cs` / `AppState.cs` | **0** | 仅注释 | — |
| 全部 `Models\*.cs` | **0** | 仅 `///` 注释 | — |

---

## 四、已有的文本间接层

**无。**

逐项核验结果：

| 检查项 | 结果 | 证据 |
|---|---|---|
| `.resw` / `.resx` 资源文件 | **无**（0 个） | 全 `WhalesLauncher.App` 递归检索无命中 |
| `ResourceDictionary` 中的字符串资源 | **无** | `App.xaml:7-15` 只合并 `Themes/Tokens.xaml`；`Themes/Tokens.xaml:13` 注释明说「当前为空占位」，且 `:5-7` 规定「只允许转引 WinUI 3 内置资源键，不得出现自定义 hex 色值、自定义字号」 |
| 静态 Strings / Constants 文案类 | **无** | 仅有 `NavigationService.DetailBreadcrumb.RootLabel`（`Services\NavigationService.cs:23` 旁，实为 `Views\Detail\DetailBreadcrumb.cs:23`）这一条**孤例常量**；`Services\NavigationService.cs:24` 的 `DetailTabs.Label` 是唯一集中的映射方法 |
| csproj 中的 MRT / PriFile / Culture / 卫星程序集配置 | **无** | `WhalesLauncher.App.csproj:24` 仅命中 `<LangVersion>latest</LangVersion>`（无关） |
| `x:Uid` 标记（XAML 本地化标准机制） | **无** | 全 XAML 零命中 |
| 语言/区域设置读取 | **无** | 无 `CultureInfo.CurrentUICulture`、无 `ApplicationLanguages` |

**唯一存在的「准间接层」是 6 个 `*Values.cs` 常量类，但它们存放的是英文契约值（`"running"`/`"local"`），不是显示文案**（见 §1.4）。

**另一个相关事实**：`Services\Formatters.cs:8-9` 明确写着「刻意**不用**文化敏感格式化（不用 Intl 等价物），以保证与旧版输出逐字一致 —— 这样审计时可以拿新旧截图直接对比」。即当前实现**有意**绕开了 `CultureInfo`，本地化时必须显式推翻这一决定。

---

## 五、AboutPage.xaml 的版本号 / 链接 / 版权许可文本

### 5.1 版本号：**没有任何硬编码版本号**

| 展示项 | XAML 标签 | 值来源 | 证据 |
|---|---|---|---|
| 启动器版本 | `AboutPage.xaml:81 Text="启动器版本"` | 后端 `app:version` → `AppState.AppVersion` | `AboutPage.xaml.cs:39`；未就绪时 `:20` `BackendMissing = "尚未取得（后端未就绪）"` |
| 界面框架 | `AboutPage.xaml:94 Text="界面框架"` | **运行时反射程序集版本**（非写死） | `AboutPage.xaml.cs:51-57`：`typeof(Microsoft.UI.Xaml.Application).Assembly.GetName().Version`，输出 `$"WinUI 3（Microsoft.WinUI {version.ToString(3)}）"`；`:56` 注释说明「写死的版本号会在升级 WindowsAppSDK 之后立刻变成假信息」 |
| Node 运行时 | `AboutPage.xaml:107 Text="Node 运行时"` | `launcher:detectNode` | `AboutPage.xaml.cs:60-76`；`:66` `"未探测（在「全局设置 → Node 运行时」里点「重新探测 Node」）"` |
| dsh 引擎 | `AboutPage.xaml:120 Text="dsh 引擎"` | `engine:list` | `AboutPage.xaml.cs:79-96`；`:95` `$"已安装 {versions.Count} 个版本：{…}"` |

初始占位符统一为 em dash：`AboutPage.xaml:87`、`:100`、`:113`、`:126`、`:163`、`:176` 均 `Text="—"`。

### 5.2 链接：**AboutPage 内没有任何可点击链接**

- 全 XAML 检索 `<Hyperlink>` / `NavigateUri`：**0 命中**。
- `AboutPage.xaml:207` 的文本**明确说明链接不在本页**：`Text="「dsh 接口勘察文档」「总体设计方案」等文档入口在标题栏的应用菜单 → 帮助里；这里不重复维护第二份入口定义。"`
- 而该「应用菜单 → 帮助」的菜单项当前由后端 `app:menu` 提供，**Node 侧尚未实现**（见 §1.5），故这些文档入口当前在运行时不产生任何文案。
- 唯一的 URL 白名单逻辑在 `Services\CoreBridge.cs:1239-1261`（`IsAllowedExternalUrl`，只放行 http/https），错误文案 `:1255` `$"出于安全考虑，只允许打开 http/https 链接（收到 {uri.Scheme}://）。"`

### 5.3 版权 / 许可文本：**有**

| 内容 | 位置 |
|---|---|
| 分区标题 | `Views\AboutPage.xaml:200` `Text="许可与文档"` |
| 许可证声明 | `Views\AboutPage.xaml:203` `Text="WhalesLauncher 以 MIT 许可证开源，仓库根目录的 LICENSE 是许可全文。"` |
| 文档入口说明 | `Views\AboutPage.xaml:207`（见上） |
| 页头标题/描述 | `Views\AboutPage.xaml:42` `Title="关于"`、`:43` `Description="WhalesLauncher —— 让每个 dsh 实例各跑各的桌面启动器。"` |
| 存储位置说明 | `Views\AboutPage.xaml:140` `Text="存储位置"`、`:157` `Text="启动器根目录"`、`:170` `Text="主 home"`、`:186` `Text="实例、引擎、日志、缓存与共享资源都在根目录下；主 home 是「继承主 home」凭证策略的读取源。"` |
| 版本信息分区标题 | `Views\AboutPage.xaml:63` `Text="版本信息"` |

**无独立的第三方开源声明（NOTICE / THIRD-PARTY）文本**，只有上述 MIT 一句话说明。应用窗口标题为非中文常量：`MainWindow.xaml.cs:58` `Title = "WhalesLauncher";`。

---

## 六、补充事实（供方案侧参考，非建议）

1. **中文同时出现在 4 个不同层次**：XAML 属性（~330 条）、C# 字面量（~560 条）、后端返回的 `result.Error` 原文（前端**原样展示**，例如 `Views\InstancesPage.xaml.cs:216-218`「错误必须可见，且用 result.Error 原文（用户要能复制）」）、以及后端生成的 `problem`/`lastError`（`Views\InstancesPage.xaml.cs:1191` `return summary.Problem!`）。**第 3、4 类不在本前端仓库内**。
2. **`Services\CoreBridge.cs` 的 85 条中，48 条只进 `Debug.WriteLine`**（如 `:971`、`:1032`、`:1079`），不面向用户；真正会被 `BridgeResult.Error` 送到界面的是 `:807-913`、`:1194-1255` 区间。
3. **XAML 中 `Text="0"` 类静态初值会与运行时值不一致**：`Views\Detail\LogsView.xaml:132` `"显示 0 / 共 0 行"`、`:139` `"较早日志已截断（已丢弃 0 行）"`、`Views\Detail\SavesView.xaml:61` `"共 0 个存档"`——这三处在 XAML 和 C# 中各有一份中文，共 6 条。
4. **同一语义文案在前端存在多处不一致副本**（i18n 时是合并点，也是当前的事实）：
   - 状态标签 3 份：`Shell\InstanceStateText.cs:22-28`、`Views\InstancesPage.xaml.cs:1152-1160`、`Views\Detail\StatePresentation.cs:14-21`
   - 主按钮文案 2 份：`Views\Detail\StatePresentation.cs:26-30`、`Views\InstancesPage.xaml.cs:1243-1250`
   - Node 来源名 3 份且已漂移：`Services\CoreBridge.cs:185-194`、`Views\EnginesPage.xaml.cs:364-372`、`Views\SettingsPage.xaml.cs:563-571`
   - 「无法获取可安装版本」出现在 `Views\EnginesPage.xaml:371` 与 `:591`
   - 「较早日志已截断」出现在 `Views\Detail\LogView.xaml:37`（InfoBar Title）与 `Views\Detail\LogsView.xaml:139`（状态条）
   - 「安装本地插件」出现在 `Views\Detail\PluginsView.xaml:30`、`:140`、`:142`、`:433`、`:435`
5. **emoji 图标与色板名带中文 `AutomationProperties.Name`**：`Views\WizardPage.xaml:144-155`（鲸鱼/鲸/海浪/火箭/齿轮/拼图/包裹/靶心/扳手/试管/书籍/工具）、`:171-186`（系统强调色/绿色/黄色/红色/蓝紫色/中性灰）。这些是 UIA 名称，属于用户/自动化可见文本。
6. **`Services\NameValidator.cs` 的校验文案含用户输入回填**：`:34` `$"实例名不能是 {name}"`、`:42` `"实例名不能包含 < > : \" | ? * 等字符"`（含需转义的引号）。
