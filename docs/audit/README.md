# WinUI 3 视觉审计（W-AUDIT）

本目录是「每个子页面均通过视觉审计，无未修复项」这条验收标准的技术支撑。
工具链只做两件事：**产出真实截图**、**给出有证据、可复核的判据结论**——它不会为了让报告好看而放宽任何一条。

- 报告（机器可读）：[visual-audit.json](visual-audit.json)
- 报告（人读摘要）：[visual-audit.md](visual-audit.md)
- 截图：`docs/audit/shots/<page>.<theme>[.focus|.stable].png`

---

## 1. 状态码定义（唯一词汇表）

| 状态 | 含义 | 是否算通过 |
|---|---|---|
| `pass` | **已测量**，且测量值满足判据 | 是 |
| `fail` | **已测量**，且测量值违反判据 | 否（必须修） |
| `unverifiable` | **当前证据无法判定**。`reason` 字段必须写明缺什么 | **否，绝不计为通过** |

> 判定纪律：`unverifiable` 不等于「大概率没问题」。审阅者必须把每条 `unverifiable` 当作**未完成项**处理，
> 要么补上测量手段，要么人工复核并留下记录。工具本身造假比页面有缺陷严重得多，因此宁可输出 `unverifiable`。

---

## 2. 怎么跑

### 2.1 依赖

- Windows PowerShell 5.1（`powershell.exe`，即 Windows 自带的那一个）
- 一个能启动的 WinUI 3 应用（本仓库的 C# 前端）
- 无需 Electron、无需 Playwright、无需 CDP（旧链路已废弃）

### 2.2 最简命令

```powershell
# 用示例页面清单跑一遍，Light/Dark 各来一轮，并恢复系统主题
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit\audit-visual.ps1 `
  -ConfigFile scripts\audit\pages.example.json `
  -Themes 'Light,Dark' `
  -AllowSystemThemeOverride `
  -RestoreSystemTheme
```

产物：

```
docs/audit/shots/p1-instances.light.png          # 每页每主题一张基准图
docs/audit/shots/p1-instances.light.focus.png    # Tab 之后的焦点帧
docs/audit/shots/p1-instances.light.stable.png   # Shift+Tab 回到原地之后的稳定帧
docs/audit/visual-audit.json                     # 逐判据证据
docs/audit/visual-audit.md                       # 人读摘要
.probe/audit/steps-<page>-<theme>.json           # 当次用的步骤序列（可复现）
.probe/audit/args-<page>-<theme>.json            # 当次传给截图工具的完整参数
.probe/audit/capture-<page>-<theme>.json         # 截图工具的完整原始输出
```

### 2.3 单页调试

```powershell
# 只跑一页
... -ConfigFile scripts\audit\pages.example.json -OnlySlugs p1-instances

# 只截一张图（工具级）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit\capture-window.ps1 `
  -Exe path\to\App.exe -OutPath .probe\audit\one.png -WaitMs 6000 -EmitJson
```

### 2.4 参数

`audit-visual.ps1`

| 参数 | 说明 |
|---|---|
| `-ConfigFile` / `-ConfigJson` | 页面清单（见 §3）。`-ConfigJson` 优先 |
| `-Exe` | 覆盖配置里的 exe 路径 |
| `-Themes` | `Light`、`Dark`、`System` 逗号分隔。默认取配置，缺省 `System` |
| `-AllowSystemThemeOverride` | 允许临时改 `HKCU\...\Themes\Personalize\AppsUseLightTheme` 来落实主题 |
| `-RestoreSystemTheme` | 跑完恢复原来的主题值（**改了主题就该带上**） |
| `-OnlySlugs` | 只跑指定页 |
| `-LaunchWaitMs` / `-SettleMs` / `-StabilityMs` | 启动、稳定、复测等待（毫秒） |
| `-OutDir` / `-ReportJson` / `-ReportMarkdown` | 产物路径 |
| `-KeepOldShots` | 保留上一轮的 PNG（默认清空，保证幂等） |
| `-EmitJson` | 报告 JSON 同时输出到 stdout |
| `-UiaMaxDepth` / `-UiaMaxNodes` | UIA 遍历上限 |

退出码：`0` = 无 `fail`；`1` = 存在 `fail`；`2` = 工具级异常。

`capture-window.ps1`（单次窗口抓取）

| 参数 | 说明 |
|---|---|
| `-Exe` / `-WorkDir` / `-ExeArgs` | 启动目标 |
| `-ExistingPid` | 复用已在跑的进程（同一进程内连续抓多页，避免重复启动） |
| `-OutPath` | 单张截图路径（没有步骤序列时用） |
| `-StepsFile` / `-StepList` | 「等待 → 截图 → 输入 → 再截图」序列，JSON 数组 |
| `-WaitMs` | 启动后等待 |
| `-WindowTitleLike` | 按标题子串选窗口（多窗口/多进程时必需） |
| `-Uia` | 每次截图附带 UIA 元素树 |
| `-KeepAlive` | 跑完不杀进程（跨页复用必需） |
| `-Action` | `launch` / `capture` / `stop`（`stop -ExistingPid N` 用于收尾） |
| `-CleanDir` / `-CreateCleanDir` | 跑前清空某目录（幂等辅助） |
| `-EmitJson` | 结果 JSON 打到 stdout |
| `-ArgsFile` | 参数改用 JSON 文件传入（`audit-visual.ps1` 走这条通道，见 §6 局限 8） |

### 2.5 步骤序列（步骤即数据）

```json
[
  { "Type": "wait",    "Ms": 800 },
  { "Type": "key",     "Chord": "Ctrl+3" },
  { "Type": "click",   "X": 320, "Y": 200 },
  { "Type": "click",   "X": 320, "Y": 320, "Button": "right" },
  { "Type": "text",    "Value": "KREA2" },
  { "Type": "move",    "X": 400, "Y": 260 },
  { "Type": "capture", "Path": "docs\\audit\\shots\\p2.png", "Uia": true }
]
```

步骤类型：`wait` / `focus` / `key`（`Ctrl+Shift+T` 这类组合键）/ `text` / `move` / `click` / `wheel` / `capture`。
`X`/`Y` 是**窗口内坐标**（进程已 DPI 感知，100%/150%/200% 缩放下都对）。

---

## 3. 页面清单格式

```json
{
  "exe": "C:\\path\\WhalesLauncher.exe",
  "exeArgs": "",
  "windowTitleLike": "WhalesLauncher",
  "themeArgs": ["--theme={theme}"],
  "pages": [
    { "slug": "p1-instances", "title": "P1 实例列表", "route": "P1",
      "steps": [ { "Type": "wait", "Ms": 1000 } ] }
  ]
}
```

- `slug` 决定文件名（ASCII，勿用中文），`title` 任意。
- `themeArgs` 是**首选**的主题落实方式：若应用支持 `--theme=light|dark`，工具会直接传参，不碰系统设置。
- `exe` / `exeArgs` / `windowTitleLike` 全部参数化，工具不硬编码任何产品目录结构。

---

## 4. 判据清单与测量方式

| ID | 判据 | 范围 | 测量手段 | 能否自动定论 |
|---|---|---|---|---|
| C1 | 每页都成功抓到窗口 | 全局 | `PrintWindow(PW_RENDERFULLCONTENT)` 返回码 + PNG 落盘 | 能 |
| C2 | 抓到的是真渲染（非黑屏/非空白） | 每页 | 近黑像素占比、量化色数、非背景像素占比、内容亮度分位差 | 能 |
| C3 | UIA 暴露了元素树 | 每页 | `AutomationElement.FromHandle` + ControlView 遍历 | 能 |
| C4 | 无文本溢出容器 | 每页 | UIA `BoundingRectangle`（窗口相对）与**真实父元素**/窗口矩形比较 | 能（几何溢出；省略号是否**渲染**出来仍需看图） |
| C5 | 等效两帧渲染稳定 | 每页 | 基准帧 vs 稳定帧逐像素差 ≤ 1% | 能 |
| C6 | 字号来自规范字阶 | 每页 | 需字号读数 | **不能** → `unverifiable` |
| C7 | 键盘焦点有可见变化 | 每页 | Tab 前后两帧像素差 + 变化区域与「获得焦点的元素」矩形相交判定 | 能（判定「有无可见指示器」） |
| C8 | 禁用态可观测 | 每页 | UIA `IsEnabled=False` 元素计数 | 仅「存在性」 |
| C9 | 间距是 4 epx 整数倍 | 每页 | PNG 边缘检测量出的内容边距 | **不能仅靠截图定论** → `unverifiable`（需 XAML 静态分析或布局 dump） |
| C10 | 正文对比度 ≥ 4.5:1 | 全局 | 需要文字像素与文字跨度的绑定 | **不能** → `unverifiable` |
| C11 | 四个高对比主题走查 | 全局 | 需切换系统对比主题 | **不能** → `unverifiable` |
| C12 | 悬停/浮层状态各有一张图 | 全局 | 步骤序列里必须声明 `move`/`click` | 未声明即 `unverifiable` |
| C13 | 状态不靠单一颜色 | 全局 | 需逐状态设计映射 | **不能** → `unverifiable` |
| C14 | Light/Dark 真的不同 | 全局 | 两主题平均亮度差 ≥ 10 | 能 |
| C15 | 报告绑定到规范版本 | 全局 | `winui3-visual-spec.md` 的 SHA256 | 能 |
| C16 | PNG 与窗口尺寸 1:1 | 全局 | 窗口矩形 vs PNG 尺寸 | 能 |
| C17 | 各状态帧互不相同 | 全局 | 各帧 SHA256 两两比较 | 能 |
| C18 | 不留孤儿进程 | 全局 | 整轮结束后逐个 pid 存活性检查 | 能 |
| C19 | 结论可追溯到具体产物 | 全局 | 时间戳 + exe SHA256 + 规范 SHA256 + git 版本 | 能 |
| C20 | 报告自身完整 | 全局 | 至少 1 张真图、≥10 条判据、PNG 非空 | 能 |
| C21 | 每条非 pass 都写了原因 | 全局 | `reason` 字段长度检查 | 能 |

> C6/C9/C10/C11/C12/C13 的 `unverifiable` 是**设计上的诚实输出**，不是掩盖缺陷。
> 它们各自在报告 `reason` 里写明了「缺什么才能判定」。补齐方式见 §9。

---

## 5. 怎么看截图

1. 先看 `visual-audit.json` 的 `summary`：`fail` 必须为 0；`unverifiable` 逐条读 `reason`。
2. 打开 `docs/audit/shots/<page>.<theme>.png`，与 `docs/design/winui3-visual-spec.md` §9 对应页的骨架逐条对照。
3. `.focus.png` 是按了一次 Tab 之后的帧，用来核对焦点框是否可见、是否来自系统（不得自绘）。
4. `.stable.png` 用于 C5：它与基准帧若长得不一样，说明页面在动，此时任何布局断言都不可信。
5. 每张图在报告 `screenshots[]` 里都有 `pngSha256` 与像素统计，可核对「这份结论对应哪张图」。
6. 原始抓取输出在 `.probe/audit/capture-<page>-<theme>.json`（含窗口类名、尺寸、步骤执行结果、UIA 全树）。

---

## 6. 已知局限（必须知道）

1. **截图只能证明「渲染发生了、且长这样」**，不能证明「间距是 4 的倍数」「字号出自字阶」「对比度达标」。
   这三类要么做 XAML 静态分析（读 `.xaml` 里的 `Margin`/`Padding`/`FontSize`/`ThemeResource` 键名），
   要么在应用内加一个调试用的布局 dump 通道。工具不猜、不近似、不因为「看起来没问题」就记 pass。
2. **UIA 判据依赖应用暴露元素树**。若应用某页元素为 0，C3/C4/C8 会转 `unverifiable` 而不是 pass。
3. **会改变页面状态的按键**（`Ctrl+Tab` 之类）不能用于焦点探针；本工具默认只用 `Tab` / `Shift+Tab`，
   并用 C5 检测「页面是否在动」来兜底。
4. **主题落实是环境相关的**：优先 `themeArgs`（应用自己切），否则才临时改 `AppsUseLightTheme`。
   用了后者一定要带 `-RestoreSystemTheme`。若应用把主题写死在配置里，C14 会 `fail`（这正是它该报的）。
5. **对比主题（HighContrast）与文本缩放未纳入自动流程**。文本缩放会改变行高，截图仍可对照，但工具不声称已验证。
6. **`PrintWindow` 对最小化/被完全遮挡的窗口行为不一致**。工具会先 `ShowWindow(SW_SHOW)` + `SetForegroundWindow`；
   但若有其他窗口全屏遮挡，仍可能出现异常帧——C2 的低色数阈值会把它判成 `fail`。
7. **帧的落盘是同步的**，一次运行会真的启动应用；跑审计期间不要手动操作被审计的窗口。
8. **PowerShell 5.1 的参数绑定有个坑**：把 hashtable 展开成命令行时，`$false` 或缺省数组会「吞掉」后面的
   `-Switch`，报出 `Cannot convert value "-Xxx" to Int32` 这类莫名其妙的错。因此上层一律通过
   `-ArgsFile`（JSON 参数文件）传参，既绕开该坑，也顺带留下「本次到底请求了什么」的证据。
9. **UIA 矩形坐标是「窗口相对」的**（工具已减去窗口原点），因此可以直接与 PNG 像素坐标比较；
   报告里 C4/C7 的坐标全部是这个坐标系。屏幕缩放变化不影响该关系。

---

## 7. 复跑与幂等

- 默认会清空 `docs/audit/shots/*.png` 再重跑（`-KeepOldShots` 可关闭）。
- 每个（页 × 主题）在 `.probe/audit/` 下重写步骤文件、参数文件与原始输出，不留历史垃圾。
- 同一主题内先启动一次应用，后续页面通过 `-ExistingPid` 复用同一进程（`KeepAlive`），
  因此页面是用**应用内导航**到达的，而不是每页重启；主题跑完立即 `Kill` 进程。
- C18 在整轮结束后逐个检查本轮用过的 pid 是否还活着，确保不留孤儿。
- 报告记录 exe 的 SHA256、构建时间、git 分支/提交与「工作区是否脏」，因此「这份结论对应哪个产物」可追溯。

---

## 8. 本次自检记录（链路验证，非产品验收）

C# 主应用尚未就绪，因此先用 Lead 的 WinUI 3 工具链验证工程作为样本，把整条链路跑通：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit\audit-visual.ps1 `
  -ConfigFile scripts\audit\pages.smoke.json -Themes 'Light,Dark' `
  -AllowSystemThemeOverride -RestoreSystemTheme
```

| 项 | 值 |
|---|---|
| 样本 | `.probe/winui3-smoke/…/WhalesLauncher.Smoke.exe` |
| exe SHA256 | `3554d4bec5c0d70bd534617b61b51f77063c7fb02dd22d1fe3e850b9f68a6713` |
| 规范 SHA256 | `7b4651ba892da4557cc7625c5672ec282049d259feb6e357ce9835c1a088e78a` |
| 页面 × 主题 | 2 × 2 |
| 截图 | 12 张（每页每主题：base / focus / stable） |
| 耗时 | 约 54 s |
| 结果 | pass 27 / fail 1 / unverifiable 17 / total 45 |
| 复跑一致性 | 连跑两次，判据序列完全一致；`shots/` 每次清理后重新生成 12 张 |
| 系统主题 | 工具临时改过 `AppsUseLightTheme`，跑完已恢复为原值 |

**样本上唯一的 `fail` 是真实发现，不是工具缺陷**：轻色主题下按一次 Tab，焦点落到外壳 `Pane`（1084×721），
但整帧只有 847 个像素变化（占该元素面积 0.11%），远不足以构成可见的焦点指示器。证据见报告 `C7` 的 `evidence`。

> 这是**链路验证**结论，不能当作产品页面的视觉验收结论。产品验收要等 C# 应用就绪后，用真实页面清单再跑一轮。

---

## 9. 补齐 `unverifiable` 的路线

| 判据 | 补齐方式 |
|---|---|
| C6 字号 | 加一个 XAML 静态检查：扫 `*.xaml` 的 `FontSize`/`Style`，只允许引用 9 个字阶资源键；或应用内加调试通道 dump 每个 `TextBlock` 的实际字号 |
| C9 4 epx 网格 | 同上：静态扫 `Margin`/`Padding`/`Width`/`Height` 字面量是否为 4 的倍数（排除 `Auto`/`*`） |
| C10 对比度 | 布局完成后 dump「文字 span 矩形 + 前景/背景色」，或对截图做 OCR + 局部配色配对 |
| C11 高对比 | 需切换系统的 4 个对比主题（属系统无障碍设置），逐个跑本工具 |
| C12 悬停/浮层 | 在页面清单里声明 `move` / `click` / 右键步骤即可立刻有证据（工具已支持） |
| C13 状态非单色 | 需要一份「状态 → 图标/文字/颜色」映射表，再逐状态截图核对 |
| C8 禁用态 | 页面本身要有禁用控件才会出现证据；可在清单里加一个能触发禁用态的前置步骤 |

工具宁可输出 `unverifiable` 也不会用近似值冒充 `pass`——这是本目录最重要的一条纪律。

---

*本目录由 W-AUDIT（task-3）产出。工具为参数驱动，不硬编码任何产品目录结构；等 C# 前端就绪后用真实页面清单复跑。*
