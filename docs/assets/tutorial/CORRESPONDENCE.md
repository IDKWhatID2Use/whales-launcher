# 教程配图：旧图 ↔ 新图对应关系与取证记录

> **结论摘要**：`docs/guide/**` 引用的 23 张教程配图（实体在 `docs/assets/tutorial/`）
> 已从旧 Electron UI 截图替换为 **WinUI 3 新 UI 的真实运行截图**。
> 23 张中 **22 张已完成**，**1 张（`21-import-pack`）未完成** —— 原因见 [§6](#6-未完成项)。
> 所有新图都在**隔离临时 home** 下、由真实运行的应用窗口截取，**未触碰用户的真实
> `instances/` 与 `engines/`**。

---

## 1. 本次替换的基本事实

| 项 | 值 |
|---|---|
| 应用 | `desktop/src/WhalesLauncher.App/bin/Debug/net10.0-windows10.0.26100.0/win-x64/WhalesLauncher.exe` |
| 截图工具 | [`scripts/tutorial/tour.ps1`](../../scripts/tutorial/tour.ps1)（内部复用 `scripts/audit/capture-core.ps1` 的 `[WinAuditCore]`） |
| 截图方式 | 普通页面用 `PrintWindow(PW_RENDERFULLCONTENT)`（1280×840）；**含浮层**（菜单/对话框）的页面用屏幕区域截取（1266×833，按 DWM 可见边界裁掉不可见边框） |
| 数据 home | `F:\Temp\whales-tutorial-home`（有 6 个演示实例 + 1 条幽灵记录）与 `F:\Temp\whales-tutorial-home-empty`（无实例，用于空态） |
| 数据来源 | **全部为「临时演示实例」**，没有任何一张来自真实用户数据 |
| 图名 | 与旧图**完全同名**、原地覆盖（`docs/guide/*.md` 的引用因此不受影响） |

### 1.1 数据来源：临时演示实例（重要）

- 演示 home 由 [`scripts/tutorial/demo-home.mjs`](../../scripts/tutorial/demo-home.mjs) 生成，
  内含 7 条实例记录，刻意覆盖多种状态：正常、共享工作区/存档、headless 模板、
  **引擎未安装**、**instance.json 损坏**、**目录缺失（仅索引快照）**、崩溃演示。
- 引擎是**桩**（几行 Node 脚本，不是 dsh）：`engines/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js`。
  桩打印一行 `http://127.0.0.1:<port>/` 让启动器完成界面地址探测后常驻；
  profile 名为 `crash-demo` 时立即以退出码 1 结束。
  **为什么用桩**：任务硬性约束禁止启动真实 dsh 引擎，而「运行中 / 已崩溃」这类状态
  只有真的拉起一个进程才会产生。截图里的状态是**启动器真实判定**出来的
  （见 `instances/workbench/logs/*.log` 与 `instances/crash-demo/logs/*.log`），
  但被启动的进程是桩 —— 这一点在图上也能看出来（引擎体积 2.1 KB、路径为 `F:\Temp\...`），
  是**刻意的诚实标注**，不是伪造。
- 隔离边界：脚本启动时断言 home 必须直接位于系统临时目录下、且不在仓库根之下；
  每次启动应用前会清理**只属于该临时 home** 的残留 node 进程（命令行含该 home 路径），
  真实启动器/实例/引擎的进程不在过滤范围内。

### 1.2 一键复跑

```powershell
# ① 构造演示数据（可重复执行；--empty 生成空态 home）
node scripts\tutorial\demo-home.mjs
node scripts\tutorial\demo-home.mjs --empty

# ② 校验 core 视角下的数据（只读，退出码 0 = 通过）
node scripts\tutorial\verify-home.mjs

# ③ 截图（每个计划文件可单独跑；-Only 是镜头名的正则过滤）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\tour.ps1 -PlanFile scripts\tutorial\plan-guide-a.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\tour.ps1 -PlanFile scripts\tutorial\plan-guide-b.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\tour.ps1 -PlanFile scripts\tutorial\plan-guide-c.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\tour.ps1 -PlanFile scripts\tutorial\plan-guide-d.json

# ④ 取证（像素证据 / 交互差异）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tutorial\diff-evidence.ps1
```

> 表中「复跑命令」一律指 **③** 的整份计划；若只补某一张，用 `-Only '<文件名不含扩展名>'`，
> 例如 `-Only '23-node-runtime'`。注意：部分镜头依赖同一会话内的前置镜头
> （例如 `19-edit-instance` 需要先打开卡片菜单），单跑时可能失败 —— 整份计划重跑最稳。

---

## 2. 对应关系总表（23 张）

| 旧图文件名 | 新图文件名 | 对应页面 / 控件（新 UI） | 复跑命令 | 数据来源 | 备注 |
|---|---|---|---|---|---|
| `01-instance-list.png` | 同名（已覆盖） | 实例列表页：页头「实例」+ 工具条（搜索 / 状态筛选 SelectorBar / 排序）+ 卡片网格 + 左侧实例栏 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 新 UI **没有**旧的「概览统计卡」四宫格（见 §8 文档修正） |
| `02-filter-needs-attention.png` | 同名（已覆盖） | 工具条「需处理」SelectorBar 选中态（`SelectionItemPattern.Select` 生效，坐标点击对 SelectorBar 无效） | `-PlanFile plan-guide-a.json` | 临时演示实例 | 命中 3 个需处理实例：引擎未安装 / 目录缺失 / 记录异常 |
| `03-search.png` | 同名（已覆盖） | 工具条搜索框（`AutoSuggestBox`）输入「实例」后的实时过滤结果 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 搜索字段为**实例名 / 目录名 / 备注**（新 UI 不含引擎版本） |
| `04-app-menu.png` | 同名（已覆盖） | 标题栏内嵌菜单栏 `MenuBar` → 「文件」展开（打开启动器目录 / 打开实例目录 / 打开引擎目录 / 刷新界面 `F5` / 退出） | `-PlanFile plan-guide-a.json` | 临时演示实例 | 屏幕区域截取（菜单浮层是独立 HWND，PrintWindow 主窗口截不到） |
| `05-card-more-menu.png` | 同名（已覆盖） | 卡片右下角「更多」`DropDownButton` 展开（启动/停止、打开界面、打开文件夹▸、实例详情、编辑设置、刷新状态、删除实例…） | `-PlanFile plan-guide-a.json` | 临时演示实例 | **必须用坐标点击**：UIA `Invoke` 这个按钮会让应用崩溃（`COMException 0x8000FFFF`，已记入 §9） |
| `06-log-drawer.png` | 同名（已覆盖） | 标题栏「运行日志」（`Ctrl+L`）打开的右侧抽屉，含实时日志行、来源筛选、跟随、复制全部 | `-PlanFile plan-guide-b.json` | 临时演示实例 | 在**实例运行中**截取，抽屉里有真实日志行（12 行） |
| `07-wizard-step1-name.png` | 同名（已覆盖） | 向导第 1 步「名称与外观」：实例名称、目录名预览、图标、强调色、备注 + 右侧「将要创建」实时预览 | `-PlanFile plan-guide-c.json` | 临时演示实例 | 名称是**真的输入**进去的（`实例名` + `备注` 两次键盘输入） |
| `08-wizard-step2-engine.png` | 同名（已覆盖） | 向导第 2 步「引擎版本」：已安装（含被占用实例数、体积）/ 可安装但尚未安装（来自 npm registry） | `-PlanFile plan-guide-c.json` | 临时演示实例 | 「可安装」列表是**真实 npm registry 查询结果**（22 个版本） |
| `09-wizard-step3-template.png` | 同名（已覆盖） | 向导第 3 步「profile 模板」：web / headless / sdk / sdk-minimal / acp 五个模板及各自组合包 | `-PlanFile plan-guide-c.json` | 临时演示实例 | 步骤用步骤条 `SelectionItemPattern.Select` 切换 |
| `10-wizard-step4-isolation.png` | 同名（已覆盖） | 向导第 4 步「隔离策略」：工作区 / 存档 / 设置 / 凭证 四个维度各自「独立 / 共享」 | `-PlanFile plan-guide-c.json` | 临时演示实例 | 新 UI **没有**旧图的「三个快速预设」按钮（见 §8） |
| `11-detail-plugins.png` | 同名（已覆盖） | 实例详情 · 插件页签：内置组合包开关、本地插件、依赖 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 详情页页签同样是 SelectorBar，用 `SelectionItemPattern` 切换 |
| `12-detail-settings.png` | 同名（已覆盖） | 实例详情 · 设置页签：`settings.yaml` 纯文本编辑器 + 隔离策略 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 顶部为重新载入 / 保存 |
| `13-detail-saves.png` | 同名（已覆盖） | 实例详情 · 存档页签：工作区筛选 + 存档列表（空态「还没有存档」） | `-PlanFile plan-guide-a.json` | 临时演示实例 | 演示实例未跑过真实会话，故为空态 |
| `14-detail-logs.png` | 同名（已覆盖） | 实例详情 · 日志页签 | `-PlanFile plan-guide-a.json` | 临时演示实例 | — |
| `15-running-detail.png` | 同名（已覆盖） | **运行中**实例的详情页：标题右侧「运行中 · 端口 3080 · http://127.0.0.1:3080/」+ 停止按钮 + 页脚「开始运行」 | `-PlanFile plan-guide-b.json` | 临时演示实例 | 由真实启动流程产生；被启动的是桩引擎（见 §1.1） |
| `16-crashed-card.png` | 同名（已覆盖） | **已崩溃**实例的列表态：红点 + 「已崩溃」+ 端口 + 「重新启动」按钮 | `-PlanFile plan-guide-b.json` | 临时演示实例 | 桩引擎以退出码 1 结束，启动器真实判定为异常退出；需点一次「刷新」才会把卡片状态刷新出来 |
| `17-engines.png` | 同名（已覆盖） | 全局「引擎版本管理」页：已安装 / 可安装分段、版本表（引擎目录、体积、占用实例、移除）、底部安装日志 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 顶部还显示当前生效的 Node 版本 |
| `18-global-settings.png` | 同名（已覆盖） | 全局设置页：外观 / 存储位置 / 引擎与网络 / Node 运行时 / 危险操作 五段 | `-PlanFile plan-guide-a.json` | 临时演示实例 | — |
| `19-edit-instance.png` | 同名（已覆盖） | **编辑实例信息的新位置**：详情 · 设置 → 折叠段「实例信息」（名称 / 图标 / 强调色 / 备注 / 引擎版本） | `-PlanFile plan-guide-a.json` | 临时演示实例 | 旧 UI 的模态框在新 UI 中不存在；卡片菜单「编辑设置」跳到详情 · 设置 |
| `20-delete-confirm.png` | 同名（已覆盖） | 删除确认 `ContentDialog`（标题「删除实例」+ 说明 + 删除实例 / 取消） | `-PlanFile plan-guide-a.json` | 临时演示实例 | 新 UI 的确认框**没有**「同时删除磁盘目录」勾选框（见 §8） |
| `21-import-pack.png` | **未替换（仍是旧图）** | —（新 UI 没有「从实例包导入」入口） | — | 旧图（Electron 时代） | **未完成**，原因见 §6 |
| `22-empty-search.png` | 同名（已覆盖） | 搜索无结果空态：「没有匹配的实例」+「清除筛选」按钮 + 顶部 InfoBar 提示 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 搜索词显示为 `实例zzz`（在 03 的基础上续打 `zzz`） |
| `23-node-runtime.png` | 同名（已覆盖） | 全局设置 → 「Node 运行时」段：结论行、当前使用 / 版本 / 来源、候选运行时清单 | `-PlanFile plan-guide-a.json` | 临时演示实例 | 结论取自**真实探针**（Node v26.3.0） |

---

## 3. 像素证据（每张图都不是黑屏 / 空白）

由 [`scripts/tutorial/evidence.ps1`](../../scripts/tutorial/evidence.ps1) 用
`[WinAuditCore]::ImageStats` 直接测量（原始数据：`.probe/tutorial-work/evidence.json`）。

- `distinctExact` = 采样到的不同 RGB 值个数；`nonBg` = 与主背景色差异 > 24 的像素占比；
- `blackish` = 近黑像素占比（黑屏截图会接近 1.0）；`lumaSpread` = 内容亮度 0.5%–99.5% 分位差。

| 图 | 尺寸 | distinctExact | distinctQuantized | nonBg | blackish | lumaSpread |
|---|---|---|---|---|---|---|
| `01-instance-list.png` | 1280×840 | 710 | 346 | 0.3839 | 0.0219 | 244 |
| `02-filter-needs-attention.png` | 1280×840 | 671 | 336 | 0.4050 | 0.0219 | 244 |
| `03-search.png` | 1280×840 | 695 | 347 | 0.4137 | 0.0220 | 244 |
| `04-app-menu.png` | 1266×833 | 942 | 350 | 0.3571 | 0.00004 | 219 |
| `05-card-more-menu.png` | 1266×833 | 959 | 369 | 0.3730 | 0.00004 | 219 |
| `06-log-drawer.png` | 1280×840 | 784 | 357 | 0.3912 | 0.0219 | 244 |
| `07-wizard-step1-name.png` | 1280×840 | 1361 | 601 | 0.3349 | 0.0222 | 245 |
| `08-wizard-step2-engine.png` | 1280×840 | 686 | 318 | 0.3503 | 0.0219 | 244 |
| `09-wizard-step3-template.png` | 1280×840 | 697 | 322 | 0.3327 | 0.0219 | 244 |
| `10-wizard-step4-isolation.png` | 1280×840 | 725 | 322 | 0.3322 | 0.0219 | 244 |
| `11-detail-plugins.png` | 1280×840 | 654 | 294 | 0.3736 | 0.0219 | 244 |
| `12-detail-settings.png` | 1280×840 | 663 | 298 | 0.3290 | 0.0219 | 244 |
| `13-detail-saves.png` | 1280×840 | 585 | 287 | 0.3097 | 0.0219 | 244 |
| `14-detail-logs.png` | 1280×840 | 620 | 294 | 0.3117 | 0.0219 | 244 |
| `15-running-detail.png` | 1280×840 | 590 | 298 | 0.3161 | 0.0219 | 244 |
| `16-crashed-card.png` | 1280×840 | 749 | 356 | 0.3839 | 0.0219 | 244 |
| `17-engines.png` | 1280×840 | 587 | 284 | 0.3161 | 0.0219 | 244 |
| `18-global-settings.png` | 1280×840 | 635 | 286 | 0.3371 | 0.0226 | 244 |
| `19-edit-instance.png` | 1266×833 | 734 | 300 | 0.3168 | 0.0004 | 219 |
| `20-delete-confirm.png` | 1266×833 | 793 | 244 | 0.2185 | 0.00004 | 237 |
| `21-import-pack.png` | 1440×900 | 3701 | 751 | 0.2467 | 0 | 230 |
| `22-empty-search.png` | 1280×840 | 581 | 314 | 0.3571 | 0.0220 | 244 |
| `23-node-runtime.png` | 1280×840 | 610 | 284 | 0.3358 | 0.0223 | 244 |
| `docs/assets/screenshot-empty.png` | 1280×840 | 296 | 83 | 0.3161 | 0.0219 | 243 |
| `docs/assets/screenshot-instances.png` | 1280×840 | 710 | 346 | 0.3839 | 0.0219 | 244 |
| `docs/assets/screenshot-menu.png` | 1266×833 | 942 | 350 | 0.3571 | 0.00004 | 219 |
| `docs/assets/screenshot-settings.png` | 1280×840 | 635 | 286 | 0.3371 | 0.0226 | 244 |

> `21-import-pack.png` 仍是一张 **1440×900** 的旧图（尺寸本身就暴露它不是新 UI 截图，
> 其余新图要么 1280×840 要么 1266×833）。它是本批唯一未替换项。

---

## 4. 交互自证（证明「截图前真的发生了操作」）

由 [`scripts/tutorial/diff-evidence.ps1`](../../scripts/tutorial/diff-evidence.ps1) 用
`[WinAuditCore]::ImageDiff` 计算（原始数据：`.probe/tutorial-work/diff-evidence.json`）。

**同一会话内、同一窗口位置**的对比（最有力，差异只可能来自交互本身）：

| 操作 | 对比 | 变化像素 | 占比 | 变化区域 |
|---|---|---|---|---|
| 应用「需处理」筛选 | 01 → 02 | 66 868 / 1 075 200 | 6.22% | 370,168 631×637 |
| 搜索框输入「实例」 | 01 → 03 | 50 781 | 4.72% | 354,179 630×625 |
| 续打「zzz」（无结果） | 03 → 22 | 77 560 | 7.21% | 353,179 895×626 |
| 打开日志抽屉 | 01 → 06 | 86 098 | 8.01% | 64,10 1207×804 |
| 进入向导第 1 步 | 01 → 07 | 122 380 | 11.38% | 22,19 1226×789 |
| 向导第 2 步 | 07 → 08 | 53 705 | 4.99% | 353,153 834×655 |
| 向导第 3 步 | 07 → 09 | 32 664 | 3.04% | 353,153 834×655 |
| 向导第 4 步 | 07 → 10 | 32 987 | 3.07% | 353,153 834×655 |
| 详情切到「设置」 | 11 → 12 | 69 210 | 6.44% | 353,199 895×584 |
| 详情切到「存档」 | 11 → 13 | 75 878 | 7.06% | 353,199 895×415 |
| 详情切到「日志」 | 11 → 14 | 78 802 | 7.33% | 353,199 895×583 |
| 导航到引擎版本管理 | 01 → 17 | 104 955 | 9.76% | 12,19 1236×789 |
| 导航到全局设置 | 01 → 18 | 127 342 | 11.84% | 12,19 1236×796 |
| 设置页向下滚动 | 18 → 23 | 71 952 | 6.69% | 353,169 893×638 |

**跨会话或跨截图方式**的对比（支持性证据，差异还包含窗口位置/裁剪偏移）：

| 对比 | 变化像素 | 占比 | 说明 |
|---|---|---|---|
| 04 → 05（文件菜单 vs 卡片菜单） | 22 704 / 1 054 578 | 2.15% | 两个浮层内容与位置不同 |
| 05 → 19（卡片菜单 vs 详情·设置） | 123 465 | 11.71% | 页面已切换 |
| 19 → 20（两个不同的对话框/页面） | 971 887 | 92.16% | 形态完全不同（含窗口位移） |
| 01 → 16（已停止 vs 已崩溃） | 3 418 | 0.32% | 只有状态点/文字/按钮变化，区域集中在卡片左上与按钮行 —— 正是崩溃态应有的最小差异 |

> **含浮层的镜头（04/05/19/20）除像素差异外，另有 UIA 树取证**：
> 截图时窗口的 UIA 树里同时存在菜单项（`启动或停止实例` / `在浏览器中打开界面` /
> `打开实例文件夹` / `查看实例详情` / `编辑实例设置` / `刷新该实例状态` / `删除实例`）
> 或对话框文本（`确定要删除实例「崩溃演示实例」吗？…`）。原始 dump 在
> `.probe/tutorial-work/uia/<镜头名>-uia.json`。

---

## 5. 每张图是怎么到达的（可复核）

| 镜头 | 到达方式 |
|---|---|
| 01 / 02 / 03 / 22 | 默认实例列表页；筛选用 SelectorBar 的 `SelectionItemPattern.Select`；搜索用**真实键盘输入**（`SendInput` 逐字符） |
| 04 | 应用菜单栏 `文件` 的 `ExpandCollapsePattern.Expand`，屏幕区域截取 |
| 05 / 19 / 20 | 卡片「更多」用**坐标点击**打开（UIA `Invoke` 会让应用崩溃，见 §9），菜单项用 `InvokePattern` |
| 06 | `Ctrl+L` 快捷键（标题栏 `ToggleButton` 自带的 `KeyboardAccelerator`） |
| 07–10 | 实例页「新建实例」按钮 → 向导；步骤用步骤条 `SelectionItemPattern.Select` 切换 |
| 11–14 | 卡片「详情」→ 详情页；页签用 `SelectionItemPattern.Select` 切换 |
| 15 | 卡片「启动」用 `InvokePattern`（真启动流程）→ 详情页 |
| 16 | 卡片「启动」（崩溃演示实例）→ 等进程异常退出 → 点一次「刷新实例列表」 |
| 17 / 18 | 左侧实例栏底部「引擎版本管理」/「全局设置」（`NavigationViewItem`，按子元素文本定位） |
| 19 | 卡片菜单「编辑设置」→ 详情 · 设置 → 展开「实例信息」折叠段 |
| 23 | 设置页内滚动到「Node 运行时」段（`move` + `wheel`，注意避开 YAML 编辑器自身滚动区） |

---

## 6. 未完成项

| 图 | 状态 | 具体原因 | 建议 |
|---|---|---|---|
| `21-import-pack.png` | **未完成 / 待补充**（保留旧图） | 新 UI（WinUI 3）**没有暴露「从实例包导入 / 导出」入口**：通道与宿主方法都在（`desktop/src/WhalesLauncher.App/Services/Channels.cs:77-79` 的 `pack:export` / `pack:import` / `pack:pickFile`，以及 `Shell/ShellHostMethods.cs:36` 的 `host:pickPackFile` 文件选择器），但**没有任何视图调用它们**；旧 Electron 版列表页右上角的「从实例包导入」按钮在重构后不存在，卡片 `⋯` 菜单里也没有导出项。没有入口 = 没有可截的真实界面状态，**不用别的图顶替**。 | 待该入口在新 UI 中落地后，把「实例包导入/导出」镜头补进 `plan-guide-a.json`（计划里预留了 `21-import-pack` 的位置）并重跑；在那之前，`docs/guide/03-instances.md` §6 已注明该能力当前只能通过桥接通道调用（见 §8） |

---

## 7. 旧图归档说明（「保留原图与替换图对应关系」的落地方式）

**旧图没有被删除，它们完整保存在 git 历史里**，因此「旧图 ↔ 新图」的对应关系是可
随时复原、可逐张比对的，而不是一句口头承诺：

- **归档提交**：`ed93af9` — `feat(winui3): 完成基于 microsoft-ui-xaml 的前端替换式重构`
- 该提交的 `docs/assets/tutorial/` 目录下就是这 23 张**旧 Electron UI** 截图
  （已用 `git ls-tree` 逐条核对，文件名与本目录下的新图**一一同名**）。
- 本次替换**原地覆盖**了工作区里的同名文件；`git diff` 因此天然给出「哪张新图替换了
  哪张旧图」—— 同名即对应关系。

取回旧图的方式（挑一种即可）：

```bash
# ① 只看某张旧图的内容（不落盘；用于核对 sha256 或尺寸）
git show ed93af9:docs/assets/tutorial/01-instance-list.png | git hash-object --stdin

# ② 把单张旧图导出到临时目录（必须在 cmd 里做：cmd 的重定向是二进制安全的，
#    PowerShell 的 > / Out-File 会按文本解码，直接把 PNG 写坏）
cmd /c "git show ed93af9:docs/assets/tutorial/01-instance-list.png > F:\Temp\old-01.png"

# ③ 整个旧目录取回到一个**独立工作树**，完全不动当前工作区（推荐做逐张比对时用）
git worktree add F:\Temp\wl-old-ed93af9 ed93af9

# ④ 只恢复某一个文件到工作区（会覆盖同名新图，慎用）
git checkout ed93af9 -- docs/assets/tutorial/01-instance-list.png
```

> 实测：`cmd /c "git show ed93af9:docs/assets/tutorial/01-instance-list.png > %TEMP%\old-01.png"`
> 得到 **157 237 字节 / 1440×900** 的旧图；当前新图为 **105 354 字节 / 1280×840**。
> 尺寸差异（1440×900 → 1280×840）本身就是「旧 Electron 窗口 vs 新 WinUI 3 窗口」的证据。

---

## 8. `docs/assets/screenshot-*.png` 四张旧图的处置

先按要求 grep 了全仓库引用：

| 旧资产 | 是否仍被引用 | 引用位置 | 处置 |
|---|---|---|---|
| `docs/assets/screenshot-empty.png` | ✅ 被引用 | `docs/video/promo-plan-v1.md:151`（备用过渡镜头） | **已替换**为新的新 UI 空态截图（`F:\Temp\whales-tutorial-home-empty`，实例数 0） |
| `docs/assets/screenshot-instances.png` | ✅ 被引用 | `docs/video/promo-plan-v1.md:150`（S03/S04/S17 备用帧） | **已替换**为 `01-instance-list.png` 的同一份新 UI 截图 |
| `docs/assets/screenshot-menu.png` | ✅ 被引用 | `docs/video/promo-plan-v1.md:152`（S15） | **已替换**为 `04-app-menu.png`（文件菜单展开） |
| `docs/assets/screenshot-settings.png` | ✅ 被引用 | `docs/video/promo-plan-v1.md:153`（S15） | **已替换**为 `18-global-settings.png`（全局设置） |

- 结论：四张**都有文档引用**（`docs/video/promo-plan-v1.md`，另有
  `docs/cleanup/legacy-residue-inventory.md:230-233` 记录了它们的引用状态），
  因此按「有引用 → 一并替换」处理，**不删除**。
- 副作用提示：`docs/video/promo-plan-v1.md` 里那四行仍写着「1280×840」，
  其中 `screenshot-menu.png` 现在是 **1266×833**（浮层截图的裁剪尺寸），
  如宣传片脚本对分辨率敏感，请把那行改成 1266×833。
  （该文件不在本次写作用域内，未改动。）
- 同理，`docs/cleanup/legacy-residue-inventory.md` 的对应行现在描述的是**已被替换的**
  资产，建议由该清单的负责人同步更新为「新 UI 截图」。

---

## 9. 过程中发现、但不在本次写作用域内修复的问题

1. **卡片「更多」按钮的 UIA `Invoke` 会让应用崩溃**（`System.Runtime.InteropServices.COMException (0x8000FFFF)`，
   写到 exe 同目录的 `crash.txt`）。真实鼠标点击不会崩。截图脚本因此改用坐标点击
   （`clickcenter`），并在 `tour.ps1` 里记录了原因。
2. **深链 `WHALES_SMOKE_ROUTE=create` / `settings` 存在启动竞态**：后端装配完成后
   `RebuildRail()` 会把选中项同步回实例列表，导致「标题栏已经是新建实例/全局设置，
   内容区却还停在实例列表（加载中）」。`engines` 与 `detail/<id>/<tab>` 未复现。
   截图脚本因此统一改为**从界面导航**（点左栏 / 点按钮 / 切页签），不依赖这两条深链。
3. **深链 `detail/<id>/settings` 不会选中「设置」页签**：详情页渲染出来仍是「插件」页签。
   截图脚本改为先进入详情页、再用 `SelectionItemPattern` 选中目标页签。
4. **崩溃后的卡片状态需要手动「刷新」才更新**：进程异常退出后列表页仍显示「运行中」，
   点一次「刷新实例列表」才变成「已崩溃」。`16-crashed-card.png` 因此包含这一步。
5. 卡片处于「运行中」时按钮行会多出一个「打开界面」，在 320px 卡片宽度下 `⋯` 按钮被挤到
   勉强可见（`06-log-drawer.png` / `15-running-detail.png` 可见）。属视觉细节，未处理。

---

## 10. 不确定项 / 待 Lead 复核

1. **演示数据的可见痕迹**：`17-engines.png` 里引擎体积是 `2.1 KB`、`18/23/06` 里路径是
   `F:\Temp\whales-tutorial-home...`。这是隔离临时 home 的直接结果，也为「这是演示数据」
   留下了可核查的痕迹；若教程要求图里不出现临时路径，需要换一个更中性的 home 路径
   （`demo-home.mjs` 一行即可改），但**不建议**改成看起来像真实用户路径的值。
2. **`21-import-pack` 的处置**：当前保留旧图 + 在 `docs/guide/03-instances.md` 里注明。
   若 Lead 认为「教程里出现旧 UI 图」不可接受，可改为删除该图并同步删掉文档里的引用，
   但那样会丢掉唯一的导入流程示意。
3. **`docs/video/promo-plan-v1.md` / `docs/cleanup/legacy-residue-inventory.md`** 的
   同步修改不在本次写作用域（`docs/assets/**`、`docs/guide/**`、`scripts/tutorial/**`），
   已在上文给出需要改的具体行号。
4. **`03-search.png` 的搜索词是「实例」**（命中 4 张卡，其中 `资料检索` 是靠**备注**命中）。
   如果教程希望演示「按引擎版本搜索」，需要改搜索词并重跑
   —— 但新 UI 的搜索框提示明确是「实例名、目录名、备注」，不含引擎版本。
