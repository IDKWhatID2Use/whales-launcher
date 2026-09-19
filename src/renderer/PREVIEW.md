# 渲染层（界面）说明 · WhalesLauncher

> 作用域：`src/renderer/**`（原生 TypeScript + CSS，无 UI 框架、无 CDN、无外部字体）。
> 设计依据：`docs/design/ui-redesign.md` v2（WCO + Mica + Fluent 令牌）；
> 验收依据：`docs/design/ui-acceptance-criteria.md`。
> 产物：`dist/renderer/index.js`（IIFE）+ `index.html` + `styles/*.css`。

## 1. 无后端也能独立预览

```powershell
npm run build
start .\dist\renderer\index.html      # 或直接用浏览器打开该文件
```

产物是 **IIFE**，`file://` 下可直接打开（无 ESM/CORS 限制）。

未检测到 `window.whales` 时自动切换到 **内置演示数据模式**：

- 左实例栏底部出现橙色「演示数据」徽标，实例列表顶部有说明条；
- 5 个演示实例覆盖全部视觉状态：**运行中（16px 确定性进度环 + 计时器 + 界面地址）/ 已停止 / 已崩溃 / 目录缺失 / 引擎未安装**；
- **应用菜单同样可用**：演示后端提供与主进程 `menuSpec()` 同结构的菜单树（5 组 / 23 项 / 6 条分隔线），菜单项带真实快捷键文案；
- 启动、停止、插件装卸、组合包开关、引擎安装、实例包导入导出都会返回模拟结果并推送日志；
- 所有操作只作用于内存，不写磁盘。

## 2. 标题栏 / 菜单栏 / 内容区如何做到"同一套语言"

- **一条 chrome**：标题栏 48px（`--titlebar-h`，=== 主进程 `titleBarOverlay.height`），菜单栏**折进同一行**，与品牌、拖拽区、操作区共用 `--titlebar-surface` 表面与同一套按钮状态表；全窗口**只有标题栏下沿那一条** 1px 横贯线。
- **L 形外壳**：标题栏与左实例栏来自同一族半透明表面（Mica 透出 ≈10–12%），主工作区取 `--content-bg`；层级只靠面板色阶梯与 1px 描边表达，除浮层外不用投影。
- **WCO 拼接**：窗口三按钮由 **Windows 系统绘制**（渲染层不创建任何窗口控制按钮）；`--wco-w` 由 `titlebar.ts` 用 `navigator.windowControlsOverlay.getTitleBarAreaRect()` 运行时写入（`geometrychange` + `resize` 重算），CSS 兜底 138px，`env(titlebar-area-width)` 仅作上界保险；内容层宽度收在 WCO 左侧，背景全宽铺到窗口右缘。
- **拖拽区**：`.titlebar__brand` / `.titlebar__spacer` 声明 `-webkit-app-region: drag`，其余分区与所有可交互元素显式 `no-drag`（`app-region` 不可继承）；容器本身不声明 drag，保留窗口边缘缩放热区；双击拖拽区最大化由系统内建行为提供，渲染层不绑 `dblclick`。
- **应用内菜单**：结构/标签/快捷键/启用态**全部来自主进程** `window.whales.app.menu()`，点击调 `menuCommand(id)`，失败弹中文提示；渲染层**不维护第二份菜单定义**（避免快捷键漂移）。键盘：`Alt` 唤出/收起、`Alt+F/E/V/W/H` 直达、`←/→` 切组、`↑/↓/Home/End` 移动、`Enter` 触发、`Esc` 关闭并归还焦点、`Tab` 关闭；模态打开时触发器 `aria-disabled`。
- **浮层可读性**（Lead 实机验收项）：菜单/模态/Toast 的背景是不透明实色令牌 `--bg-elevated`（深浅两套均为 hex），并叠加 `backdrop-filter: blur(20px) saturate(1.4)`；入场动画起始不透明度 0.72，**任何时刻都不会出现"面板半透、底层正文可辨认"的中间态**；`prefers-reduced-transparency` / `forced-colors` 下退化为纯实色无模糊。

## 3. 后端边界

界面唯一的数据来源是 `window.whales`（`WhalesApi`，见 `src/shared/contracts.ts`）。

- 每个方法都经 `data/api.ts` 包一层防御：接口缺失、同步抛错、Promise 拒绝都会转成 `Result.ok === false` 并给出中文提示；
- `onLog` / `onState` 缺失时返回空函数，保证组件卸载调用退订不会抛错；
- `instanceId === 'launcher'` 的启动器级日志**在按实例过滤时依然可见**，并在首次出现时额外弹一次可关闭的 toast（不加原生弹窗）；
- **禁止** `alert` / `confirm` / `prompt`（已自建模态框），**禁止**动态 `import()`。

## 4. 文件地图

| 路径 | 职责 |
|---|---|
| `index.html` / `index.ts` | 单页外壳与启动编排（后端探测 → 状态装载 → 外壳 → 路由 → 视图） |
| `shell.ts` | 自绘标题栏、左侧实例栏、右侧日志抽屉（抽屉关闭时保留内容到动画结束） |
| `titlebar.ts` | WCO 预留宽度同步（`--wco-w`）、拖拽区面包屑标题、失焦态 |
| `router.ts` | hash 路由（`#/instances`、`#/instance/<id>/<tab>`、`#/engines`、`#/create`、`#/settings`） |
| `icons.ts` | 内联 SVG 图标集；描边按显示尺寸分档（12→1.4 / 14→1.6 / 16–20→1.8 / ≥22→2.0） |
| `styles/` | `tokens` 设计令牌 → `base` 基础层 → `layout` 布局 → `components` 组件 → `views` 视图 |
| `data/` | `api` 后端守卫、`demo` 演示后端（含菜单树）、`store` 应用状态、`logs` 日志环形缓冲 |
| `components/` | `ui` 原子控件、`menubar` 应用菜单、`menu` 下拉面板、`modal`、`toast`、`logview`、`yaml-editor` |
| `views/` | 实例列表、详情（`detail/` 四页签）、版本管理、创建向导、全局设置 |

## 5. 设计令牌要点（Windows 11 Fluent）

- **字体**：`"Segoe UI Variable Text" → "Segoe UI" → "Microsoft YaHei UI" → system-ui`（西文/数字走 Segoe，中文自然回退）；等宽栈 `Cascadia Mono → Consolas` 只用于机器可读文本。
- **字号**：`--fs-xs/sm/md/lg/xl/2xl/3xl` = 11/12/13/15/18/22/28；标题栏与菜单触发器用 `--fs-titlebar` 14px。字重只用 400/500/600。
- **圆角**：`--r-nav(2) / --r-sm(4) / --r-md(8) / --r-lg(12) / --r-full`；嵌套递减（菜单面板 8 − 内边距 4 = 菜单项 4）。
- **控件高度**：24 / 32 / 40，徽标 20，标题栏图标按钮 28（共 5 档，登记于报告）。
- **动效**：状态反馈 `--dur-1` + `--ease-out-fluent`；入场 `--dur-2` + `--ease`；区域尺寸 `--dur-3`；循环用 `--dur-spin`；**hover/active 一律不位移**（Fluent 纪律）。
- **状态三通道**：颜色 + 文字 + 形状（运动态 16px 确定性进度环、静止态 6px 圆点、崩溃 alertCircle）。

## 6. 布局验证

- `1280×840`（设计基准）：标题栏 48 + 左栏 264 + 主区自适应；抽屉在 **<1280px 走浮层档**（内联会把主区压到 168px）。
- `1920×1080`：主区内容限宽 1560px 居中，卡片网格 3 列；抽屉内联 424px。
- 断点只有 1440 / 1280 / 1100 / 980 四个；`≤980px` 左栏收成 72px 图标栏。

## 7. 核对清单与已知偏离

**核对清单**（`node .spike/smoke/run.mjs` 155 项断言 + `node .spike/smoke/real-mode.mjs` 28 项真实后端桩断言；**断言数以脚本实际输出为准**）

- [x] 标题栏结构（surface/content/brand/menubar/spacer/actions）与 WCO 预留
- [x] 标题栏内容层按 WCO 右边界收敛：`min(calc(100% - var(--wco-w)), calc(env(titlebar-area-x,0px) + env(titlebar-area-width,100%)))`
- [x] **标题栏操作区只保留 1 个动作（运行日志）且为纯图标**；主题切换下沉到左栏底部与全局设置页 → 1280 宽下不会与系统按钮重叠
- [x] 全应用图标按钮（`.btn--glyph` / `.btn--icon*`）都不含可见文字；CSS 有兜底规则隐藏文字节点
- [x] 标题栏内无自绘窗口按钮；品牌/拖拽区可拖、交互分区 no-drag
- [x] 菜单树来自后端；23 项 + 6 分隔线；快捷键与主进程清单逐条一致（无 Ctrl+Q/W/M、无 F12）
- [x] 菜单键盘：点击展开、Esc 关闭、Alt 唤出、Alt+V 直达、方向键移动、模态打开时禁用
- [x] 浮层背景不透明 + `backdrop-filter` + 入场不透明度 ≥0.7 + 减少透明/高对比度退化
- [x] **版本管理页两段列表各自加载**：本地已安装列表先渲染（不被 npm 查询拖住），npm 列表有自己的加载/失败/超时态（12s/30s 超时 + 重试按钮）
- [x] 引擎体积 `0`/`null` 显示「未知」而非 `0 B`（junction 接入不跟随链接统计）
- [x] **QR-15 共享设置冲突**：实例卡片徽标 + 计入「需处理」筛选；设置页提示条说明"未覆盖任何一边"并给出两个动作（含"谁会覆盖谁"与自动 `.bak-<时间戳>` 备份说明）；覆盖本地方向红色 + 二次确认；解决后提示条与徽标同步消失 —— **演示模式与真实后端桩两条路径都验证通过**
- [x] 冲突 API 走能力探测：`window.whales.settings.shareConflicts / resolveShareConflict` 缺失时静默降级（不显示假提示），演示后端与真实后端两种形态都覆盖
- [x] **4 个隔离维度齐备（`workspace` / `saves` / `settings` / `credentials`）**：向导第 4 步 4 行开关；详情页「隔离策略」卡（存档页 = 工作区 + 会话存档，设置页 = 设置文件 + 凭证）可经 `instance.update` 逐项切换。文案来自 `views/isolation.ts` 单一样板（向导与详情不各写一套）
- [x] **共享工作区语义讲清**：独立 = `instances/<实例名>/workspace`；共享 = junction 到 `shared/workspaces/<实例名>`；并明确①文件落在共享区 ②多实例指向同一目录会互相看到/覆盖 ③**删除实例不会清理共享工作区**（core 有意设计，只报告孤儿目录）
- [x] 工作区/会话存档/设置文件切换均为**危险方向 + 二次确认**（`btn--danger-solid`），确认框写明"解除链接不递归删除真实目录"；凭证切换为非危险确认（启动时复制，不改目录结构）
- [x] 隔离维度切换后 store 与左栏同步（`upsertInstance` + `refreshShell`），页签自行持有最新摘要（详情页不会因 store 通知重建同页签）
- [x] **QR-17 消费 core 的降级标记 `problem`**（非契约扩展字段，经 `data/summary-ext.ts` 显式窄化读取）：坏记录（`instance.json` 损坏 / 元数据被删 / 清单损坏）在卡片上有「记录异常」徽标 + 直接可见的原因提示条 + 启动按钮 `title`；目录缺失时并入「目录缺失」徽标的 `title`，不重复出两枚同义徽标
- [x] **`problem` 计入「需处理」**：`needsAttention()` 作为单一判定来源，筛选器与概览统计卡共用（避免"筛选里有、统计里没有"）；演示数据含第 6 种状态（`ins-broken`，`present=true` + `problem`）可回归
- [x] `index.html` 含 CSP：`default-src 'none'` + `object-src 'none'` + `connect-src 'none'`，脚本/样式兼容 file:// IIFE
- [x] 品牌位（标题栏标记 / 空态插画 / 关于对话框）使用实心剪影 `whaleMark`，UI 图标仍全部线性
- [x] 实例列表（卡片/搜索/排序/筛选/空态）、向导四步、详情四页签、版本管理、全局设置
- [x] 五个历史缺陷不回归：演示后端引擎登记时序、插件页依赖列表挂载、向导「下一步」随输入刷新、模态 Esc 捕获阶段、版本管理页无限加载态

**需实机截图核对的项**（jsdom 无布局引擎，无法自动断言；可用 `.spike/cdp-shot.mjs` 复跑）

- [ ] 窄窗口（1280，`minWidth` 1024）下标题栏按钮不重叠、不越过 WCO 边界（x > 宽 − 138）
- [ ] 标题栏与左实例栏无水平色缝（y = 2/24/46 取色，ΔRGB ≤ 2）
- [ ] WCO 竖向接缝不可见（x = 宽 − 138 处无竖边）
- [ ] 全窗口只有 1 条横贯线（标题栏下沿）；除浮层外无投影
- [ ] **CSP 生效后界面正常**（无白屏、样式完整、菜单/模态可用）—— 若白屏，第一件事是移除 `index.html` 的 CSP meta 复核

**已知偏离（如实登记，供验收裁决）**

| # | 项目 | 实测 | 说明 |
|---|---|---|---|
| 1 | `--border` / `--border-strong` 对所在底的对比度 | 深 1.67–2.22:1 / 浅 2.34–3.32:1（目标 3:1） | 已按规范把 alpha 从 .10/.13 提到 .20/.38；再往上需 WinUI 非原生的重描边。所有控件都有文字/图标标签，边界非唯一识别特征（WCAG 1.4.11 的适用条件不成立） |
| 2 | 浮层使用 `backdrop-filter` | 菜单/模态/Toast 各 1 处 | `ui-redesign.md` F-01/A-25 禁止浮层模糊；按 Lead 实机验收结论改为**仅浮层**允许（标题栏仍禁止） |
| 3 | 视图头高度 | `min-height: 44px`（单行头实得 44，双行头按内容增高） | 规范写 44px 且标题 22px，两行内容在 44px 内会裁切；改为 min-height + 内容自适应 |
| 4 | 图形档尺寸 | 头像 24/32/44、插画块 72/48、模态图标块 36、空态图标 24/28 | 非交互控件，单列为「图形档」令牌，不计入"控件高度 ≤5 档" |
| 5 | 危险实心按钮颜色 | `--danger-solid #c42b1c`（WinUI critical 同源，白字 5.66:1） | `--danger`（亮红）压白字仅 3.37:1；实心档单列三件套 + 白字 = 5.66:1，为可访问性刻意偏离亮红（Lead 已批准） |
| 6 | 实心图标数量 | `play` / `stop` / `whaleMark` 三枚 | `whaleMark` 是**品牌剪影**，仅用于标题栏标记、空态插画、关于对话框；UI 图标（菜单/导航/按钮/页签）仍全部线性（Lead 已批准） |
| 7 | `formatEngineSize(0)` 显示「未知」 | 引擎卡 meta | core 的 `dirSize` 不跟随 junction，0 不代表空目录；显示 `0 B` 会误导用户（Lead 实机验收指出） |

## 8. 已知限制

- 本会话沙箱禁止创建命名管道，**Chromium/Edge 无法启动**，渲染层不自带像素级截图能力；像素观感由 Lead 用更宽权限实跑 Electron 核对。
- 功能与样式断言见 `.spike/smoke/`（用法与断言纪律见该目录 `README.md`）：`run.mjs`（155 项交互断言，演示后端）、`real-mode.mjs`（28 项，真实 `window.whales` 桩）、`dist-copy.mjs`（产物文案核验）、`audit.mjs`（CSS 类名一致性）、`contrast.mjs`（WCAG 对比度核算）。两条冒烟都支持 `WL_RENDERER_DIR` 指向隔离构建，便于在不动共享 `dist` 的前提下验证。
- `real-mode.mjs` 的 `check()` 此前不调用函数型断言（函数对象恒为真 → 假绿）；本轮已修正为与 `run.mjs` 一致（只承认严格 `true`），因此断言总数从 20 增至 28 且全部真实执行。
