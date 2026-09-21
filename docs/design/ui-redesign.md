# WhalesLauncher 视觉语言与 GUI 重设计方案（Windows 11 Fluent 版）

> ## ⛔ 已废弃 —— 请勿作为设计依据
>
> **本文档描述的是已被整体替换的 Electron + DOM/CSS 前端**（`src/renderer/**`、`src/preload/**`、
> `src/main/**` 于 commit `ed93af9` 物理删除）。其中的视觉规范、令牌体系、标题栏/菜单方案
> **全部不适用于当前实现**。
>
> - **当前视觉规范**：[`winui3-visual-spec.md`](winui3-visual-spec.md)（基于 microsoft-ui-xaml，每条规格带出处）
> - **当前交付说明**：[`../winui3-重构交付报告.md`](../winui3-重构交付报告.md)
> - **废弃判定来源**：`winui3-visual-spec.md` §0 明确把本文档列入「不得作为设计依据的已废弃材料」
>
> 本文档**保留在仓库中**是为了记录设计演进与被替换的原因，并让旧版本可回溯
> （旧前端源码用 `git show ed93af9^:<路径>` 取回）。**不要按它写新代码。**

| 项目 | 内容 |
| --- | --- |
| 文档版本 | **v2**（WCO + Mica 版） |
| 日期 | 2026-09-19 |
| 目标平台 | Windows 10 1809+ / Windows 11（x64），Electron 41.1.0 + 原生 TypeScript + 原生 CSS（无 UI 框架） |
| 用户诉求 | 「标题栏菜单栏要和主界面设计语言保持一致，重新设计 GUI」＋「ui 遵循 windows11 原生的 fluent design」 |
| 核心问题 | 窗口里同时存在 **三套视觉系统**：Windows 绘制的标题栏、Windows 绘制的菜单栏、WhalesLauncher 自绘的深色内容区 |
| 交付范围 | **只描述设计**。本文件是唯一交付物，`src/**` 一行代码都不改；所有数值均可被工程师直接翻译为 CSS 与主进程配置 |
| 与旧版关系 | **本文取代 `ui-redesign.md` v1**。v1 采用 `frame:false` 全自绘标题栏并自绘窗口控制按钮；本文按已定技术取舍改为 **WCO（Window Controls Overlay）＋ Mica**，窗口三按钮交还系统绘制。v1 的 Mica 顾虑（第二处色源）在即 §1.2 与 §2.2.6 给出收敛方案，不再构成冲突 |
| 既有配套文件 | `docs/design/ui-acceptance-criteria.md`（一致性验收标准，**需按本文同步三处口径**，见 §10.3 末表）；`docs/design/architecture.md` |

**已逐行读取的现状文件**：`src/renderer/styles/tokens.css`（217 行）、`base.css`（303 行）、`layout.css`（506 行）、`components.css`（1773 行）、`views.css`（729 行）、`src/renderer/index.html`、`shell.ts`、`components/menu.ts`、`components/ui.ts`、`components/modal.ts`、`components/logview.ts`、`icons.ts`、`router.ts`、`index.ts`、`src/main/index.ts`、`src/main/menu.ts`、`src/main/config.ts`、`src/preload/index.ts`、`package.json`。

**落地依赖的技术事实**（已按 Electron 41 / WICG 规范核实，非推测）：

| 事实 | 来源 | 对本方案的影响 |
| --- | --- | --- |
| `titleBarStyle: 'hidden'` 在 Windows 上**必须**配 `titleBarOverlay` 才显示窗口按钮 | Electron BaseWindowConstructorOptions | 这是本方案启用 WCO 的唯一开关 |
| `titleBarOverlay` 可为 `true`（系统色）或对象 `{ color, symbolColor, height }`；`height` 必须是整数 | 同上 | `height: 48` 与 `--titlebar-h` 必须同值 |
| `color` / `symbolColor` 仅标 `_Windows_ _Linux_`；`color` 支持 `rgba()` / `hsla()` / `#RRGGBBAA`（含透明） | 同上 | 主题切换时**必须由主进程**改这两个值，CSS 无权改 |
| `backgroundMaterial: 'auto' \| 'none' \| 'mica' \| 'acrylic' \| 'tabbed'`，标 `_Windows_` | 同上 | Mica 用 `'mica'`，并有 `win.setBackgroundMaterial()` 运行时可改 |
| WCO 区域**永远在 web 内容之上、吞掉所有输入、不穿透** | WICG explainer §Overlaying Window Controls | 不必为“按钮被拖拽层吃掉”做额外防御；但拖拽区不得覆盖该区域 |
| WCO 只暴露 4 个 CSS 环境变量 `titlebar-area-x / -y / -width / -height` | WICG explainer §CSS Environment Variables | 用 `env()` + 兜底值排版；**不要**自己猜按钮宽度 |
| WCO 另暴露 `navigator.windowControlsOverlay.getTitleBarAreaRect()` 与 `geometrychange` 事件 | WICG explainer §JavaScript APIs | 用于把 overlay 实际宽度写进 CSS 变量（DIP 级精确） |
| `app-region: drag` 的区域**忽略全部指针事件** | Electron custom-window-interactions | 拖拽区内的每个可交互节点必须显式 `no-drag` |

---

## 1. 设计主张与一致性判据

### 1.1 设计主张：**一片海，一条 chrome，一层毛玻璃**

> 整个窗口是**同一片深海的剖面**。Mica 是海水的底质（由 Windows 从桌面壁纸取样），标题栏、左实例栏、内容区只是**同一片水在三个深度上的读数**——靠同一个 6 档面板色阶梯与同一条 1px 发丝线分层，不靠渐变、不靠投影、不靠位移。
> 形态取自鲸：**流线**（圆角按 Fluent 的 2/4/8/12 递减收敛、动效只用减速曲线、任何 hover 都不许位移）、**分叉的尾**（危险动作只出现在交互态与状态徽标，绝不大面积铺色挡在正文后面）、**声呐**（“运行中”是一个 16px 的确定性进度环，不是整块闪烁的绿）。
> 用户抱怨的“割裂”只有一个根因：窗口里有三条 chrome。本方案把菜单栏**折进**标题栏（同一行、同一底色、同一套按钮状态表），把标题栏与左实例栏**连成 L 形外壳**，于是全窗口只剩**一条** chrome——它和内容区的唯一区别，是深度差一档。

### 1.2 一致性判据（唯一主判据，可逐像素判定）

> **判据 M ——**
> 全窗口可见表面的颜色，**必须**只由以下四个来源决定，且**这四层严格等域**：
> ① **Mica 底**（`--material-*` 或 `--bg-app` 回退，仅出现在标题栏、左实例栏、主工作区三块外壳背景）；
> ② **外壳面**（`--rail-bg` / `--content-bg` 等半透明色，半透明值**只能出现在 ① 之上**）；
> ③ **内容面**（`--bg-surface` / `--bg-surface-2` / `--bg-inset`，**必须**是不透明色，因为卡片、输入框、日志区的正文可读性不允许被壁纸干扰）；
> ④ **浮层面**（`--bg-elevated`，**必须**不透明，且**只有**菜单下拉、模态框、Toast 三类元素可挂投影 `--shadow-s3`）。
> 层级**只**由 ①→②→③ 的明度阶梯表达；分隔**只**由 **1px** 的 `--border-subtle` / `--border` / `--border-strong` 表达。**除 ④ 之外，任何元素不得使用投影表达层级**，也不得使用渐变、不得使用 `translateY/scale` 位移表达悬浮。

**判据 M 的可执行子判据（逐条可打勾，供 QA 使用）**

| 编号 | 子判据 | 取证方法 | 通过标准 |
| --- | --- | --- | --- |
| M-1 | 标题栏、左实例栏、主工作区三者无水平色缝 | 窗口最大化，用取色器在 **y = 2 / 24 / 46** 三行分别于 x = 300 / 700 / 1200 取样（避开按钮） | 三点为同一合成色，**ΔRGB ≤ 2/通道**；“标题栏下沿”处不得出现比两侧更亮的横条 |
| M-2 | 全窗口只有一条 chrome | 统计可见的水平分隔线 | 只有 **1 条** 1px 线横贯窗口宽度（标题栏下沿）；视图头、卡片头一律**无横贯线** |
| M-3 | 全窗口无渐变 | `Select-String -Pattern 'linear-gradient\|radial-gradient' src\renderer\styles\*.css`，排除 `.boot` 与品牌标记后 | 剩 **0 行**（品牌标记的渐变是唯一图形例外，见 M-4） |
| M-4 | 全窗口无 hover 位移 | `Select-String -Pattern 'translateY\|scale\(' src\renderer\styles\*.css` | 仅剩 `.badge__dot` 的呼吸脉冲（若保留）与图形化字符；**卡片/按钮/页签的 hover 一律不得命中** |
| M-5 | 圆角收敛 | 逐元素量 `border-radius` | 只允许 `--r-nav(2) / --r-sm(4) / --r-md(8) / --r-lg(12)` 与 `--r-full`；**菜单项 4px 必须小于菜单面板 8px**（嵌套递减，Fluent 规则） |
| M-6 | 收口自检 | 把窗口底部 3px 用同色遮住再截图 | 判据 M 的核心校验：**标题栏与内容区在无分隔线时也应看起来属于同一片海**（若看上去“少了一套风格”，则配色出错；若“看不出区别”，则深度阶梯不足） |

### 1.3 意象 → 形态映射

| 意象 | 落到的**具体设计决策**（可翻译为代码） |
| --- | --- |
| 海面只有一条线 | 全窗口 **一条 48px chrome**：标题栏 + 菜单栏同行，共用 `--rail-bg`；**不设**第二条工具栏、**不设**视图头下边框 |
| 水深分层 | 六个面板色 + 三个表面色组成 6 档阶梯；深色**越浮越亮**，浅色**越浮越白 + 越浮越实**（浅色下靠 border 与卡片描边区分，不靠阴影） |
| L 形外壳 | 标题栏与左实例栏**同取 `--rail-bg`**，形成连续 L 形；主工作区取 `--content-bg`；两者之间**只有 1 条 1px 竖线** |
| Mica 是海水的底质 | 外壳背景半透明，内容面不透明；Mica 不支持时**只换 3 个变量的值**（见 §4.3），其它一律不动 |
| 鲸身流线 | 圆角：行内 2px / 控件 4px / 卡片与菜单 8px / 卡片外框与模态 12px；**禁止** 3px、6px、7px、10px、16px、20px |
| 鲸尾分叉（危险） | `--danger` 三件套只用于：危险按钮的交互态、崩溃状态徽标、日志 stderr 侧条；**禁止**大面积危险色填充正文区 |
| 声呐脉冲 | “运行中”= 16px 确定性进度环（`--dur-spin` 0.9s linear）＋ 文本标签；**禁止**整块元素 opacity 闪烁 |
| 深海静音 | 动效只有两个函数：标准 `--ease`（进场/位移）与 Fluent **减速曲线** `--ease-out-fluent`（状态反馈）；**删除全部弹性过冲** |

---

## 2. 标题栏规格（含与 WCO 的拼接）

### 2.1 窗口级参数（`src/main/index.ts:126-144` 的 `new BrowserWindow({...})`）

| 字段 | 现值 | 目标值 | 理由 |
| --- | --- | --- | --- |
| `frame` | 未设置（`true`，系统原生边框） | **不设置**（保持默认） | WCO 只需 `titleBarStyle`，**不要**改成 `frame:false`——`frame:false` 会同时关掉 DWM 的圆角、阴影与 Snap Layouts |
| `titleBarStyle` | 未设置（`'default'`） | **`'hidden'`** | 隐藏系统标题栏，把整条 48px 让给自绘内容 |
| `titleBarOverlay` | 未设置 | **`{ color, symbolColor, height: 48 }`** | 三按钮由系统绘制；`height` 必须 === `--titlebar-h`（§2.2） |
| `backgroundMaterial` | 未设置 | **`'mica'`**，运行时按 §4.3 判定降级为 `'none'` | 用户已定取舍；`'mica'` 会自动跟随系统深浅色 |
| `autoHideMenuBar` | `false`（`index.ts:134`） | **`true`**，自绘菜单跑通后整条删除 | 过渡期兜底；**绝不允许** `false` + 自绘菜单同时存在（双菜单 = 直接失败） |
| `backgroundColor` | 硬编码 `'#0f1116'`（`index.ts:31`） | **`--bg-app` 的两档取值**：深 `#0b1017` / 浅 `#f3f6fb` | 消除启动闪帧；Mica 生效时该值只在首帧可见 |
| `width / height` | `1280 / 840` | **沿用** | 设计基准 1280×800/840 |
| `minWidth / minHeight` | `1024 / 680` | **`1024 / 720`** | 高度 680 会让 48px 标题栏 + 44px 视图头 + 44px 页签 挤压内容；1024 保持（§6 已按 1024 做像素预算） |
| `hasShadow` / `roundedCorners` | 默认 `true` | **沿用** | DWM 提供窗口阴影与圆角，**不要**自绘 |
| `transparent` | 未设置 | **保持 `false`** | 开透明就得自绘圆角与阴影，代价高且会与 DWM 打架 |

**WCO 初始化代码形状**（供工程师直接照写，含 §4.3 的降级分支）：

```ts
const mica = supportsMica();            // process.platform === 'win32' && build >= 22000 && systemPreferences 允许透明
const win = new BrowserWindow({
  // …其余字段按上表…
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: theme === 'dark' ? '#10151d' : '#fbfcfe',   // 与 --rail-solid-* 同源，见 §4.1
    symbolColor: theme === 'dark' ? '#a2b2c8' : '#4c5c73',
    height: 48,                                        // === var(--titlebar-h)
  },
  backgroundMaterial: mica ? 'mica' : 'none',
});
```

### 2.2 标题栏几何与分区

**总高 `--titlebar-h: 48px`**（现值 `.topbar` 为 `var(--topbar-h)` = 52px，`tokens.css:136` / `layout.css:16`）。

选 48px 的三条硬理由：① 48 同时是 Windows 触摸目标最小值与 WinUI 命令栏标准值，且 48 − 28 = 20，正好给 28px 菜单触发器上下各 10px 呼吸；② 1280×800 下比 52px 省 4px，再叠加上「菜单栏折进标题栏」省掉的 32px，内容区共回收 36px；③ 48px 能容纳 20px 应用标记 + 14px 品牌字 + 28px 菜单项，三者共用一条中线。

**水平分区（从左到右，1280 宽窗口）**

```
┌─12─┬─20─┬8─┬─104─────┬12─┬─ 菜单区 256 ─┬───── 拖拽区 flex:1（1280 宽下实得 594）─────┬─ 操作区 136 ─┬── WCO 138 ──┐
│    │鲸标│  │Whales…  │   │文件 编辑 视图 │        实例名 · 插件 · 运行中               │日志 主题 新建│  ─   □   ✕   │ 48px
│    │    │  │         │   │窗口 帮助      │                                             │              │             │
└────┴────┴──┴─────────┴───┴───────────────┴─────────────────────────────────────────────┴──────────────┴─────────────┘
  0   12   32 40        144 156           412                                          1006           1142 → 1280
                                            └─────────── 拖拽区 594px ───────────┘  └ 136 ┘  └ 138 ┘
```

**像素自校验（1280 宽）**：12（左内边距）+ 20（标记）+ 8 + 104（品牌名 14px/600 实测）+ 12 + 256（菜单区）+ **594**（拖拽区）+ 136（操作区）+ 138（WCO）= **1280** ✅
**像素自校验（1024 宽，`minWidth`）**：品牌名仍显示、版本徽标隐藏 ⇒ 拖拽区实得 1024 − 1280 + 594 = **338px** ≥ 160px 下限 ✅

| 区段 | 起点 x（1280 窗口） | 宽度 | 规格 |
| --- | --- | --- | --- |
| A 左内边距 | 0 | 12px | `padding-left: var(--titlebar-pad-x)` = **12px**（现值 `layout.css:21` 为 `--sp-4`(16px) ⇒ 收紧到 12px，让品牌标记更贴边） |
| B 品牌标记 | 12 | 20×20 | 圆角 `--r-nav`（**2px**），底 `linear-gradient(140deg, var(--brand-a) 0%, var(--brand-b) 100%)`，外描边 1px `--accent-border`，内嵌 `icon('whale', 14)`，色 `--text-on-accent` |
| C 品牌名 | 32+8=40 | 104（14px/600 实测） | `--fs-titlebar`（**14px**）/ `--fw-semibold` / `--text-1` / `letter-spacing: 0` / 单行省略；右侧 **不留** 版本徽标间隙 |
| D 版本徽标 | 144（仅 ≥1440 时） | 0（**默认隐藏**） | 规格同 `layout.css:70-78`（`--fs-xs` / `--font-mono` / `--text-3` / `--r-nav` / 1px `--border-subtle` / `--bg-surface-2`），仅在 **窗口宽 ≥ 1440px** 时显示，否则 `display: none` |
| E 区间距 | 144 | 12px | `--sp-3` |
| F 菜单区 | 156 | 256px | 5 个触发器，`gap: var(--menu-gap-x)` = **2px**；见 §3.2 |
| G 拖拽区 | 412 | `flex: 1 1 auto`，`min-width: var(--titlebar-drag-min)` = **160px** | `justify-content: center`；1280 宽下实得 **594px**，1024 宽下实得 **338px** |
| H 操作区 | 1006 | 136px | 2 个图标按钮（28×2 = 56）+ gap 4×2 = 8 + 分隔线 1 + margin 4×2 = 8 + 主按钮 63 ≈ **136px**，见 §2.4 |
| I WCO 区 | 1142 | **138px**（系统固定，不可改） | 系统绘制，见 §2.5 |
| 右侧留白 | — | **0** | 最大化时三按钮直抵屏幕右上角（Windows 习惯） |

**1024 宽（`minWidth`）像素预算**

| 区段 | 1280 宽 | 1024 宽 | 判定 |
| --- | --- | --- | --- |
| A–F 品牌 + 菜单区（固定） | 400（含左内边距与区间距） | 400 | ✅ 固定，不折叠 |
| D 版本徽标 | 隐藏 | 隐藏（< 1440） | ✅ |
| G 拖拽区 | 594 | **338** | ✅ 远大于 `--titlebar-drag-min`(160px) |
| H 操作区（固定） | 136 | 136 | ✅ |
| I WCO（系统固定） | 138 | 138 | ✅ |
| **合计** | **1280** | **1024** | **不破版，无需折叠标题栏任何元素** ✅ |

### 2.3 拖拽区（`app-region`）规格与边界

**关键约束（WCO 特有的两条，务必先读）**

1. **`app-region: drag` 的区域忽略一切指针事件**——拖拽区内的每个可交互节点必须显式 `no-drag`，否则点击被吞。
2. **绝对不要让拖拽区覆盖 x > `100% − 138px` 的右上角**。虽然 WCO 永远在最上层并且吞掉输入（点击不会漏给页面），但若拖拽区铺到那里，会出现「鼠标形状是拖动、点击落在系统按钮上」的错位感；且窗口最大化时该区域属于系统非客户区语义。**用 §2.7 的做法把 titlebar 的 `width` 收在 WCO 左侧**。

**CSS 骨架（可直接落地）**

```css
.titlebar {
  position: fixed;
  inset: 0 0 auto 0;
  height: var(--titlebar-h);
  z-index: var(--z-topbar);
  /* 注意：容器自身不声明 drag，以保留窗口左右边缘 4px 的缩放手柄热区 */
}

/* 全宽背景层：负责标题栏表面与全窗口唯一的那条 1px 分隔线 */
.titlebar__surface {
  position: absolute;
  inset: 0;
  /* 用标题栏专属表面（而非常识上的 --rail-bg）：Mica 透出度被压到 8–10%，
     以收敛系统绘制的 WCO 区造成的竖向接缝，见 §2.5 */
  background: var(--titlebar-surface);
  border-bottom: 1px solid var(--border-subtle);
}

/* 内容层：宽度严格收在 WCO 左侧，由 --wco-w 兜底 138px */
.titlebar__content {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  gap: var(--titlebar-gap);
  padding-left: var(--titlebar-pad-x);
  width: min(calc(100% - var(--wco-w)), env(titlebar-area-width, 100%));
}

/* 默认全部 no-drag，再逐区放开需要拖拽的两块 */
.titlebar__content,
.titlebar__menubar,
.titlebar__actions {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.titlebar__brand,
.titlebar__spacer {
  app-region: drag;
  -webkit-app-region: drag;
  user-select: none;
}

.titlebar :is(button, input, select, textarea, a, [role="menuitem"], [tabindex]) {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.titlebar__spacer { justify-content: center; min-width: var(--titlebar-drag-min); }
```

> **`app-region` 不可继承**：必须按上表在**每个分区**上显式声明，不能只在容器写一次。

**必须显式 `no-drag` 的元素清单**

| 元素 | 理由 |
| --- | --- |
| `.titlebar__menubar` 及其 5 个 `.menu-trigger` | 否则点击被窗口拖动吞掉 |
| `.titlebar__actions` 内全部按钮（日志、主题、新建） | 同上 |
| `.titlebar__version`（版本徽标） | 它有 `title` 悬浮提示，属可交互节点 |
| 菜单下拉面板 `.menu` | 面板渲染在 `#overlays`（`position: fixed; inset: 0`），不在拖拽区内；**仍要补 `app-region: no-drag` 作为双保险**（一行 CSS） |
| 窗口三按钮 | **不存在于 DOM 中**（系统绘制），无需声明 |

**拖拽区内的禁用项清单**

| 禁止 | 后果 |
| --- | --- |
| 拖拽区内放搜索框 | 输入框需要文本选择与光标，与拖拽冲突；实例搜索**留在左实例栏**（现状正确，保持） |
| 拖拽区内放需要文本选中的元素 | `user-select` 必须为 `none` |
| 在 drag 节点上绑 `click` | Chromium 优先解释为拖动，点击随机丢失 |
| 在 drag 区内自绘鼠标拖窗（`mousedown` + `mousemove`） | 与系统拖动冲突 |
| 给 `#overlays` 加 `pointer-events: auto` 或放全屏遮罩 | 会同时吞掉拖拽与菜单点击（打开菜单时**不得**加遮罩，这是硬性禁忌） |
| 把拖拽区宽度退化为 0 | 用户会以为窗口不能拖；`--titlebar-drag-min: 160px` 是硬性下限 |
| 依赖右键默认行为 | 标题栏内 `contextmenu` 一律 `event.preventDefault()` 后不做事；**不要**在这一区域自绘「还原/移动/大小」小菜单（会引入第二套菜单语言） |

**双击行为与边缘缩放**

| 位置 | 双击结果 |
| --- | --- |
| `.titlebar__brand` / `.titlebar__spacer`（drag 区） | 最大化 ⇄ 还原（Chromium drag region 内建，**无需自行实现**） |
| 菜单触发器、操作按钮 | 必须**不触发**最大化——它们是 `no-drag`，平台内建行为已满足；前提是**绝不在 `.titlebar` 容器上绑 `dblclick`** |
| 窗口左右边缘 4px | 保留缩放热区（容器不声明 drag）；右上角 48px 内因三按钮贴边而不提供右边缘缩放，这与 Windows 原生窗口行为一致，属刻意取舍 |

### 2.4 操作区（H 区）规格

| 元素 | 尺寸 | 变体 | 说明 |
| --- | --- | --- | --- |
| 「运行日志」图标按钮 | 28×28，`--r-sm`，图标 16px | `.btn--ghost.btn--icon-sm`；抽屉打开时改用 `.btn--subtle` | **沿用** `shell.ts:59-66` 的语义与 `drawerOpen` 高亮逻辑，只改尺寸：32→28 |
| 「切换主题」图标按钮 | 28×28，同上 | 同上 | **沿用** `shell.ts:67-77` |
| 分隔线 | 1×20px，`background: var(--border-subtle)` | `margin: 0 var(--sp-1)` | 把「应用级动作」与「主操作」分开 |
| 「新建实例」 | 28px 高，`padding: 0 var(--sp-3)`，`--r-sm`，图标 16px | `.btn--primary.btn--sm` | **下沉备选**：若验收认为标题栏应绝对干净，可把该按钮移到各视图头的 `.view__actions`（`layout.css:327-334` 已就位），标题栏只留 2 个图标按钮（此时 H 区宽 76px，拖拽区实得 += 60px）。**两种形态二选一，不得同时存在** |

**标题栏内一律不放文字型次要按钮**；不放搜索框；不放标签页。

### 2.5 与 WCO 的拼接关系（**本节是方案的关键，务必按此实现**）

```
                     ┌─────────────── titlebar__surface（全宽，铺到 x=1280）───────────────┐
  y=0 ───────────────┼─────────────────────────────────────────────────────────────────────┤
                     │  12 │ 鲸标 │ WhalesLauncher │ 菜单×5 │ ←拖拽区→ │ 日志 主题 新建 │ ← WCO →│
                     │     └──────── titlebar__content（宽 = 100% − 138px = 1142px）────────┘  ↑↑↑
  y=47 ── ── ── ── ──┴───────────────── 1px --border-subtle ────────────────────────────────┴─────
                     │  WCO 区（138×48）由 Windows 绘制：系统图标、系统 hover、系统 Snap Layouts    │
  y=48 ──────────────┴─────────────────────────────────────────────────────────────────────────
                     │  左实例栏（264px，--rail-bg）│  主工作区（flex:1，--content-bg）            │
```

| 拼接要点 | 规格 |
| --- | --- |
| 背景**必须全宽铺到窗口右边缘** | 否则三按钮区域会出现「一块异色矩形」。做法：`.titlebar__surface` 宽度 100%，`.titlebar__content` 才收在 `--wco-w` 左侧（§2.3 CSS） |
| `titleBarOverlay.height` **必须等于** `--titlebar-h` = 48 | 不一致会出现「按钮偏上/偏下、下沿与 1px 分隔线错位」；主进程与 CSS 必须同值 |
| `titleBarOverlay.color` **必须等于** `--rail-solid-dark/light` | 系统绘制区域不透明，无法透出 Mica。取「`--titlebar-surface` 压在 Mica 上的合成色」是最接近的近似；**这是本方案唯一允许的第二色源**，且它只表示 `--titlebar-surface` 一层，不是新颜色 |
| **WCO 竖向接缝的收敛（务必按此实现）** | 标题栏**必须**用专属表面 `--titlebar-surface`（深色 `rgba(31,37,47,.90)` / 浅色 `rgba(250,251,254,.92)`），而**不是**直接用 `--rail-bg`（后者留给左实例栏）。作用：把标题栏的 Mica 透出度从 `--rail-bg` 的 12% 压到约 **10%**，于是「半透明标题栏 vs 不透明 WCO 区」之间的竖向色差被压到 **ΔRGB ≈ 1–4**（深色：合成 `#20262f` vs 系统 `#10151d`，差集中在蓝通道；浅色：`#fafbfe` vs `#fbfcfe`，仅差 1 个色阶），在 48px 高度内肉眼不可辨。**不做这一步会在 x = 窗口宽 − 138px 处出现一条明显竖边**，是本次改造最容易踩的坑 |
| 左实例栏**不**用 `--titlebar-surface` | 左栏用 `--rail-bg`（更透，Mica 透出 12%）。左栏与内容区之间的 1px 竖线是**刻意的结构线**（L 形外壳的竖笔），不存在「系统绘制的邻接区域」，无需收敛；反过来若给左栏也套标题栏的表面，会在 y = 48 处出现横向错色 |
| WCO 的 1px 底边 | **不要**为 WCO 区单独画下边框：系统按钮区域自带底部分隔；由 `.titlebar__surface` 的 `border-bottom` 全宽覆盖即可（WCO 覆盖其上，视觉连续） |
| 最大化时 | 三按钮直抵屏幕右上角，`titlebar__content` 右边界仍停在 `--wco-w` 左侧（`100% − 138px`）；左侧 padding 保持 12px 不动，避免内容跳动 |
| 全屏（F11） | `--titlebar-h` 不变，标题栏**保持可见**——它承载菜单，隐藏即丢失唯一入口。WCO 在全屏下由系统隐藏，此时 `--wco-w` 应由 §2.7 的 JS 自动归 0，内容可用全宽 |
| 非聚焦（窗口失焦） | **不做整条变色**（违反判据 M；且 WCO 按钮外观由系统控制、应用层改不了，整条变色会造成「一半变了、一半没变」）。只把拖拽区标题（`.titlebar__spacer` 内文本）由 `--text-3` 再降一档到 `--text-disabled`；品牌名与图标**保持原色** |
| Snap Layouts（悬停最大化按钮弹出布局浮层） | **由系统绘制按钮 ⇒ 该特性保留**。这是选择 WCO 而非全自绘的主要收益 |
| Windows 10 回退 | 无 Mica：`backgroundMaterial: 'none'`，三按钮仍为系统绘制（Win10 上外观为系统旧版），`roundedCorners` 无效。除此之外一切规格不变 |

### 2.6 拖拽区标题文本

| 项 | 规格 |
| --- | --- |
| 内容 | `实例名 · 视图名`（`#/instances` 时取 `实例名 · 全部实例`；无实例时取 `WhalesLauncher · 尚未创建实例`） |
| 字号/字重 | `--fs-sm`（12px）/ `--fw-regular` |
| 颜色 | `--text-3`（深色 `#71839a` / 浅色 `#6b7a90`）；窗口失焦时不变 |
| 最大宽 | `max-width: var(--titlebar-title-max)` = **40ch**，超出 `text-overflow: ellipsis` |
| 对齐 | 拖拽区内水平居中（`justify-content: center`） |
| 窄屏（< 1024px 不可能出现，因为 `minWidth: 1024`） | 无需隐藏；若未来放宽 `minWidth`，在 `< 900px` 时 `display: none` |

### 2.7 `--wco-w` 的取值策略（不要硬编码猜宽度）

两个来源，**按优先级叠加**：

| 优先级 | 来源 | 取值 | 说明 |
| --- | --- | --- | --- |
| ① 兜底 | CSS `var(--wco-w)` 默认 | **`138px`** | Windows 11 100% 缩放下三按钮实测总宽（46×3）。仅作后备 |
| ② 首选 | `navigator.windowControlsOverlay.getTitleBarAreaRect()` | 运行时计算 | 返回 `{ x, y, width, height }`（DIP 单位，已含显示缩放），`--wco-w = 视口宽 − rect.width` |
| ③ 事件 | `navigator.windowControlsOverlay.geometrychange` | 重新计算并写 CSS 变量 | 覆盖「全屏切换」「系统缩放变化」「RTL 布局」等场景 |
| ④ 不可用时 | `navigator.windowControlsOverlay === undefined` | 保持 `138px` | Windows 10 等场景 |

```ts
// renderer/titlebar.ts 内的实现要点（约 20 行）
function syncWco(): void {
  const wco = navigator.windowControlsOverlay;
  const rect = wco?.getTitleBarAreaRect?.();
  const w = rect ? Math.max(0, window.innerWidth - rect.width) : 138;
  document.documentElement.style.setProperty('--wco-w', `${Math.round(w)}px`);
}
window.addEventListener('resize', syncWco);
navigator.windowControlsOverlay?.addEventListener('geometrychange', syncWco);
syncWco();
```

> 为什么不用纯 `env(titlebar-area-width)`：`env()` 没有「未定义时回退到 100% − 138px」的写法。纯 `env(titlebar-area-width, 100%)` 在 WCO 不可用时会让内容铺满整个右上角（被三按钮盖住）。CSS 里保留 `env(titlebar-area-width, 100%)` 只作为**上界保险**（`min()` 取小值），主控权交给 `--wco-w`。

### 2.8 品牌标记与主题按钮的硬性规格

| 元素 | 规格 | 现状差距 |
| --- | --- | --- |
| `.brand__mark` 尺寸 | **20×20px**，图标 14px | 现为 30×30 / 图标 19px（`layout.css:43-53`、`shell.ts:91`） |
| `.brand__mark` 圆角 | `--r-nav`（2px） | 现为 `--r-md`（8px） |
| `.brand__mark` 渐变 | `linear-gradient(140deg, var(--brand-a) 0%, var(--brand-b) 100%)`，`--brand-a: #4d8dff`、`--brand-b: #2b5fd0` | 现为字面量 `#7c5cff`（`layout.css:50`），品牌紫不在 Fluent 色板内 |
| `.brand__name` | `--fs-titlebar`（14px）/ `--fw-semibold` / `--text-1` | 现为 `--fs-lg`（15px） |
| `.brand__ver` | `--fs-xs`（11px）/ `--font-mono` / `--text-3` / `padding: 1px var(--sp-2)` / `--r-nav` / `--bg-surface-2` / 1px `--border-subtle` | `padding` 现为 `1px 6px`（6px 不在梯度上，`layout.css:74`） |

---

## 3. 应用内菜单规格

### 3.1 位置决策：**与标题栏同一行**（不做第二条工具栏）

| 论据 | 说明 |
| --- | --- |
| 结构上消除割裂 | 菜单栏与标题栏**共用同一条 48px chrome、同一个 `--rail-bg`**，物理上不可能出现第二种配色 |
| 省 36px 垂直空间 | 1280×800 下内容区多约 36px（标题栏 4 + 菜单栏 32），日志抽屉多显示 2 行 |
| 状态表天然复用 | 菜单触发器就是 `.btn--ghost.btn--sm` 的同尺寸变体，hover/active/focus 与操作区按钮**完全一致** |
| 平台习惯 | VS Code、Windows Terminal、Fluent 应用的「标题栏即菜单栏」已被 Windows 用户接受 |

**触发改用独立一行的阈值**：顶级菜单 > 6 个，或需要在标题栏常驻显示长路径时。此时 `--menubar-h` 由 `0px` 改为 `36px`，底色 `--rail-bg`、**无下边框**，其余规格不变。

### 3.2 顶级菜单与触发器

| 项 | 值 |
| --- | --- |
| 顶级菜单 | 文件 / 编辑 / 视图 / 窗口 / 帮助（**与 `main/menu.ts:44-104` 逐项等价**，不新增不删减） |
| 触发器尺寸 | 高 **28px** × `padding: 0 var(--sp-3)`；圆角 `--r-sm`（4px） |
| 触发器排版 | `--fs-titlebar`（14px）/ `--fw-medium`（500）/ `--text-2` |
| 触发器间距 | `gap: var(--menu-gap-x)` = **2px** |
| 菜单区左边距 | `--sp-3`（12px） |
| `aria` 结构 | `<nav class="menubar" role="menubar" aria-label="应用菜单">` + 每个触发器 `role="menuitem" aria-haspopup="menu" aria-expanded` + `aria-keyshortcuts="Alt+F"` |
| 加速键提示 | 标签内用下划线字母：`文<u>件</u>(F)`、`编<u>辑</u>(E)`、`视<u>图</u>(V)`、`窗<u>口</u>(W)`、`帮<u>助</u>(H)` |

**触发器状态表**

| 状态 | 背景 | 文字 | 边框 | 备注 |
| --- | --- | --- | --- | --- |
| normal | `transparent` | `--text-2` | `transparent` | — |
| hover | `--bg-hover` | `--text-1` | `transparent` | 120ms `--ease-out-fluent` |
| 展开中（`aria-expanded="true"`） | `--bg-selected` | `--text-1` | 1px `--accent-border` | 与左实例栏选中项**同一套**视觉 |
| active（按下） | `--bg-active` | `--text-1` | — | **不得**位移 |
| focus-visible | 不变 | 不变 | — | `outline: 2px solid var(--accent); outline-offset: -2px`（**内缩**，避免溢出标题栏被裁切） |
| disabled（模态打开时） | `transparent` | `--text-disabled` | `transparent` | `aria-disabled="true"`，不响应点击 |

### 3.3 下拉面板完整尺寸表

**面板容器**

| 属性 | 值 | 说明 |
| --- | --- | --- |
| `min-width` | `--menu-min-w` = **220px** | 现值 192px（`components.css:1221`）容纳不下「打开引擎目录　Ctrl+Shift+O」 |
| `max-width` | `--menu-max-w` = **340px** | 现值 300px |
| 宽度自适应 | `width: max-content`，同时受上下限约束 | 同一面板内所有项等宽 |
| 内边距 | `--sp-1`（4px） | **沿用** |
| 项间距 | `gap: 0` | 由项自身高度提供节奏；**删除** `gap: 1px`（`components.css:1226`，1px 不在梯度上） |
| 背景 | `--bg-elevated`（不透明） | 判据 M ④，**沿用** |
| 边框 | 1px `--border` | **沿用** |
| 圆角 | `--r-md`（**8px**） | 现值 `--r-md`，**沿用** |
| 投影 | `--shadow-s3` | 现值 `--shadow-3`，**沿用**（浮层是判据 M 的唯一投影例外） |
| 与触发器间距 | `gap = var(--menu-gap-y)` = **4px** | 现值 6px（`menu.ts:108`）；面板顶边 y = 48 + 4 = **52px** |
| 水平对齐 | 面板左边缘对齐**菜单区容器**（x = 156），**不是**各自的触发器 | Windows 原生习惯；避免五个下拉各自参差 |
| 展开动效 | `wl-rise var(--dur-1) var(--ease)`（120ms，位移 8px + 缩放 0.985） | **沿用** `base.css:147-156` |
| 最大高度 | `min(var(--menu-max-h), calc(100vh - var(--titlebar-h) - var(--menu-gap-y) - var(--sp-4)))` | 超出时内部滚动，`--menu-max-h: 480px` |

**菜单项**

| 属性 | 值 |
| --- | --- |
| 高度 | `--menu-item-h` = **32px**（**显式高度**，不再靠 padding 推导） |
| 内边距 | `padding: 0 var(--sp-3)`（12px） |
| 圆角 | `--r-sm`（**4px**）—— 面板 8 − padding 4 = 4，符合 Fluent 嵌套收敛规则 |
| 项间距 | `gap: var(--sp-2)`（8px） |
| 图标槽 | **16×16px** 固定槽位（无图标项用等宽占位），图标 `icon(name, 16)` |
| 标签 | `--fs-md`（13px）/ `--fw-regular`（400）/ `--text-1`，单行省略 |
| 快捷键 | `--fs-xs`（11px）/ `--font-mono` / `--text-3`；`margin-left: auto`，**右对齐**；与标签最小间距 `--sp-6`（24px） |
| 过渡 | `background/color var(--dur-1) var(--ease-out-fluent)` |

**菜单项状态表（深色 / 浅色）**

| 状态 | 背景 | 文字 | 快捷键文字 | 边框 |
| --- | --- | --- | --- | --- |
| normal | `transparent` | `--text-1` | `--text-3` | `transparent` |
| hover | `--bg-hover` | `--text-1` | `--text-2` | `transparent` |
| active（按下） | `--bg-active` | `--text-1` | `--text-2` | — |
| focus-visible（键盘导航） | `--bg-hover` | `--text-1` | `--text-2` | 1px `--accent-border` |
| 危险项（退出） | `transparent` | `--danger-text` | — | — |
| 危险项 hover/active | `--danger-soft` | `--danger-text` | — | — |
| disabled | `transparent` | `--text-disabled` | `--text-disabled` | — |

> **增量要求**：现值 `.menu__item` 缺 `:active` 态（`components.css:1234-1261` 只有 hover / disabled），需补 `--bg-active`。

**分隔线与分组标题**

| 元素 | 规格 |
| --- | --- |
| `.menu__sep` | 高 **1px**，`background: var(--border-subtle)`，`margin: var(--sp-1) 0`（上下各 4px） |
| `.menu__label`（分组标题） | `padding: var(--sp-1) var(--sp-3) var(--sp-1)`；`--fs-xs`（11px）/ `--fw-medium` / `--text-3` / `letter-spacing: 0.04em`；**不参与键盘导航**（不是 `menuitem`） |

**各菜单面板尺寸预算**

| 菜单 | 项数 | 分隔线 | 内容高 = 项×32 + 线×(1+8) + padding 8 | 面板宽 |
| --- | --- | --- | --- | --- |
| 文件 | 5 | 2 | 160 + 18 + 8 = **186px** | 240px |
| 编辑 | 6 | 1 | 192 + 9 + 8 = **209px** | 220px |
| 视图 | 7 | 2 | 224 + 18 + 8 = **250px** | 262px |
| 窗口 | 2 | 0 | 64 + 8 = **72px** | 220px |
| 帮助 | 3 | 1 | 96 + 9 + 8 = **113px** | 300px |

> 五个面板宽度不等（`width: max-content`）是**允许**的（Windows 原生习惯）；但同一面板内不得出现两种项高。

### 3.4 键盘可访问性规格

| 按键 | 上下文 | 行为 | 落地要求 |
| --- | --- | --- | --- |
| `Alt`（单击，松开触发） | 任意 | 聚焦第一个菜单触发器并展开其下拉；再按 `Alt` 关闭并归还焦点 | **新增**。实现要点：监听 `keydown`，记录「本次 Alt 期间是否按下了其他键」，若有则视为组合键、不激活（`keyup` 时判定） |
| `Alt + F/E/V/W/H` | 任意 | 直接展开对应菜单 | **新增**（对应 §3.2 加速键）；`e.preventDefault()` 防菜单音 |
| `ArrowLeft` / `ArrowRight` | 菜单展开中 | 在当前打开的顶级菜单之间左右切换（循环） | **新增**：给 `openMenu()` 的 options 增 `onHorizontal?: (dir: -1 \| 1) => void`。注意 `menu.ts:120` 的 `document` 捕获监听会先收到事件，**必须**在 `openMenu` 内部回调，不能在外层抢 |
| `ArrowDown` | 触发器聚焦 | 展开并聚焦**第一项** | 控制器补；`openMenu()` 打开后已自动聚焦第一个可用项（`menu.ts:124`，**沿用**） |
| `ArrowUp` | 触发器聚焦 | 展开并聚焦**最后一项** | 控制器补 |
| `ArrowDown` / `ArrowUp` | 面板内 | 循环移动，**跳过 disabled 与 separator** | `menu.ts:93-101` **沿用** |
| `Home` / `End` | 面板内 | 首项 / 末项 | **新增**（约 6 行） |
| `Enter` / `Space` | 面板内 | 触发该项并关闭 | `menu.ts:56-59` **沿用**（`<button>` 天然支持 Space） |
| `Esc` | 面板内 | 关闭并归还焦点到触发器 | `menu.ts:87-92` + `close()` 内的 `anchor.focus()` **沿用** |
| `Tab` | 面板内 | 关闭菜单，焦点交回文档顺序 | **新增**（防焦点逃逸到不可见面板） |
| 鼠标 hover（已展开时） | 名 | 移到相邻触发器**立即切换**菜单 | **新增**：先 `close()` 再 `openMenu(next)`（Windows 原生行为） |
| 点击外部 / 窗口失焦 | — | 关闭 | `menu.ts:81-85` / `menu.ts:122` **沿用** |
| 模态框打开时 | — | 触发器 `aria-disabled="true"`，不响应点击与键盘展开 | **新增**。规避已知设计债：`--z-menu`(60) < `--z-modal`(80)（`tokens.css:144,145`），模态内无法显示菜单 |

### 3.5 必须保留的快捷键（移除原生菜单后逐条重绑）

`Menu.setApplicationMenu(null)` 之后，`main/menu.ts` 里 `role: 'reload' | 'forceReload' | 'toggleDevTools' | 'togglefullscreen' | 'zoomIn' | 'zoomOut' | 'resetZoom'` 自带的加速键**全部消失**，必须逐条重绑。

**推荐落地方式**：`main/index.ts` 的 `guardWebContents(win)`（`index.ts:183-206`）中追加 `contents.on('before-input-event', …)`。理由：它不依赖 DOM 焦点（焦点在输入框里按 F11 同样生效），也不会被渲染层的 `preventDefault` 影响，且与菜单项调用同一批动作函数。

| 快捷键 | 动作 | 现状来源 | 必须保留 | 备注 |
| --- | --- | --- | --- | --- |
| `F5` | 重新加载 | `menu.ts:51` accelerator | ✅ | 沿用现有加速键 |
| `Ctrl + R` | 重新加载 | `menu.ts:52` `role:'reload'` | ✅ | Windows 习惯 |
| `Ctrl + Shift + R` | 强制重新加载 | `menu.ts:74` | ✅ | 排障必需 |
| `Ctrl + Shift + I` | 开发者工具 | `menu.ts:75` | ✅ | |
| `F12` | 开发者工具 | Chromium 默认 | ✅ | |
| `F11` | 全屏切换 | `menu.ts:79` | ✅ | 全屏时 `--wco-w` 需按 §2.7 重算 |
| `Ctrl + 0` | 实际大小 | `menu.ts:77` | ✅ | |
| `Ctrl + =` / `Ctrl + -` | 放大 / 缩小 | `menu.ts:78,76` | ✅ | |
| `Ctrl + 1 / 2 / 3 / 4` | 实例列表 / 版本管理 / 全局设置 / 新建实例 | `renderer/index.ts:147-180` **已有实现，保留** | ✅ | 属本应用自有快捷键 |
| `Esc` | 关闭最上层浮层（模态 > 抽屉） | `shell.ts:415-419`、`modal.ts:173-177` **已有** | ✅ | 不得被菜单抢 |
| `Ctrl + C/X/V/Z/Y/A` | 编辑操作 | `menu.ts:59-66` 的 roles | ⚠️ Chromium 内建仍生效 | **无需重绑**；但菜单项须保留（内容区输入框与菜单两条路径都要有） |
| 退出 | 退出应用 | `menu.ts:53` `role:'quit'`（无加速键） | ❌ 建议**不加**全局快捷键 | Windows 无 `Ctrl+Q` 习惯；退出前有「仍有实例运行」确认（`index.ts:160-175`），误触代价高。只保留菜单项 |

**禁止**：不要用 `globalShortcut` 注册这些键——那是**系统级**快捷键，会在应用失焦时抢键。

### 3.6 菜单数据源架构：**main 是唯一真相**（沿用既有决策）

`main/menu.ts:1-6` 的注释已声明意图：「只做本地动作…避免菜单与界面出现两套状态源」。渲染层只负责**渲染结构 + 键盘导航 + 把 command id 回传**：

```
main/menu.ts（唯一菜单定义）
  ├─ export function menuSpec(): MenuSpec        // 结构 + 标签 + 加速键 + command id，纯数据、无函数
  └─ export function runMenuCommand(id: string)  // 复用现有 openLocal / showAbout / webContents 动作
        ↓ 新增 2 条 IPC
CH.app.menu         = 'app:menu'          // renderer 拉取菜单结构
CH.app.menuCommand  = 'app:menuCommand'   // renderer 回传被点击的 command id
        ↓
renderer/components/menubar.ts（新建：纯渲染 + 键盘导航）
```

| 项 | 规格 |
| --- | --- |
| `MenuSpec` 形状 | `{ id: string; label: string; accelerator?: string; command?: string; kind?: 'separator' \| 'header'; enabled?: boolean; danger?: boolean; children?: MenuSpec[] }` |
| 快捷键显示 | `accelerator` 字符串直接作为 `.menu__shortcut` 文本（如 `Ctrl+Shift+I`）；**同一字段同时驱动主进程 `before-input-event` 匹配**，杜绝两处定义漂移 |
| 现有 23 个菜单项 | 与 `main/menu.ts:43-104` **逐项等价**，22 项去向已在 `ui-acceptance-criteria.md` §4.7 的 23 行对照表中登记，本文不重复；**自绘菜单是其中 21 项功能的唯一可达路径**，因此 `Menu.setApplicationMenu(null)` 必须在自绘菜单通过 §3.4 全部键盘用例后才可执行 |
| 分组与分隔线 | 与 `ui-acceptance-criteria.md` §4.7 末表一致：文件 `1,2,3 \| 4 \| 5`；编辑 `6,7 \| 8-11`；视图 `12,13,14 \| 15,16,17 \| 18`；窗口无；帮助 `21,22 \| 23` |
| 关于对话框 | 继续用主进程 `dialog.showMessageBox`（`main/menu.ts:18-37`）**沿用**——原生对话框承载版本信息是合适的，不必自绘 |

---

## 4. Fluent 设计令牌表

> 表格「来源」列：**沿用** = 现有 `tokens.css` 已有且取值不改（含行号）；**新增** = 本方案增补；**改值** = 保留变量名但调整取值。
> 全部颜色令牌以**深色为 `:root` 默认、`[data-theme="light"]` 覆盖**（**沿用** `tokens.css:7,150` 的现有机制，不要改结构）。

### 4.1 颜色令牌（深 / 浅两套）

#### 4.1.1 品牌与语义色

| 令牌 | 深色 | 浅色 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| `--accent` | `#4d8dff` | `#2f6fdd` | 品牌主色、焦点环、选中态 | 沿用 `tokens.css:11,153` |
| `--accent-hover` | 沿用 | **改值 `#3d7ce8`**（原 `#3d7ce8`，仅用于 hover 底。**校验**：`--text-on-accent #fff` 压于其上 = **4.73:1** ✅） | 主按钮 hover | 改值（原值对比度 4.00:1 不达 AA） |
| `--accent-press` | `#3a76e0` | `#2559b8` | 主按钮按下 | 沿用 |
| `--accent-soft` | `rgba(77,141,255,.16)` | `rgba(47,111,221,.14)` | 焦点环、开关轨道 | 沿用 |
| `--accent-softer` | `rgba(77,141,255,.08)` | `rgba(47,111,221,.07)` | 极浅底 | 沿用 |
| `--accent-border` | **改值 `rgba(77,141,255,.55)`** | **改值 `rgba(47,111,221,.55)`** | 强调描边、菜单展开态边框、选中行边框 | 改值（原 .45/.42 对 `--bg-app` 仅 2.2–2.6:1，**不达非文本 3:1**） |
| `--accent-contrast` / `--accent-text` | `#ffffff` / `#9dc0ff` | `#ffffff` / `#2a63c9` | 主按钮文字 / 强调文字 | 沿用 |
| `--danger` | `#f2555a` | `#dc3f45` | 危险动作、崩溃徽标、日志 stderr 侧条 | 沿用 |
| `--danger-hover` / `--danger-press` | `#ff6f74` / `#d84146` | `#e6555b` / `#bf3036` | 危险按钮交互态 | 沿用 |
| `--danger-soft` / `-border` / `-text` | `rgba(242,85,90,.14)` / `rgba(...)`.45` / `#ff979b` | `rgba(220,63,69,.11)` / `.40` / `#bd2f35` | 危险按钮静默态 | 沿用 |
| `--success` / `-soft` / `-border` / `-text` | `#35c98a` 系列 | `#12a06a` 系列 | 成功、运行中 | 沿用 |
| `--warning` / `-soft` / `-border` / `-text` | `#f0a934` 系列 | `#c47f0a` 系列 | 警告、启动中 | 沿用 |
| `--info` / `-soft` / `-text` | `#4d8dff` 系列 | `#2f6fdd` 系列 | 信息提示 | 沿用 |
| `--neutral-soft` / `--neutral-text` | `rgba(255,255,255,.07)` / `#a9b8cc` | `rgba(15,28,48,.06)` / `#52627a` | 中性徽标 | 沿用 |
| **`--brand-a` / `--brand-b`** | **`#4d8dff` / `#2b5fd0`** | **`#2f6fdd` / `#1d4fae`** | 唯一品牌渐变（仅用于 20×20 应用标记与 52×52 启动标记） | **新增**（收敛 `#7c5cff` 字面量） |

#### 4.1.2 实例状态色（同时配文字标签，颜色只是辅助通道）

| 令牌 | 深色 | 浅色 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| `--state-running` | `#35c98a` | `#12a06a` | 运行中：确定性进度环 + `--success-soft` 底 + `--success-text` 字 | 沿用 |
| `--state-starting` | `#f0a934` | `#c47f0a` | 启动中 | 沿用 |
| **`--state-stopping`** | **`#8296ae`** | **`#6f8098`** | 停止中 —— **改值**：原 `#b07cf0 / #7a4fc4` 是紫色，不在 Fluent 色板内；停止是「回到静止的过渡」，用中性色比用第五种色相更正确。**徽标底色改用 `--neutral-soft`** | 改值 |
| `--state-stopped` | `#8296ae` | `#6f8098` | 已停止 —— **注意**：与 `--state-stopping` 同值，两者的区分**只靠文字标签 + 是否显示进度环**，不靠颜色（避免引入第 5 种色相） | 沿用 |
| `--state-crashed` | `#f2555a` | `#dc3f45` | 已崩溃 | 沿用 |

#### 4.1.3 表面与 Mica 层级（**本方案的核心新增**）

| 令牌 | 深色 | 浅色 | 用途 / **必须用在哪儿** | 来源 |
| --- | --- | --- | --- | --- |
| `--mica-opacity` | `0.80` | `0.72` | Mica 可见度（用于 `win.setBackgroundMaterial` 降级判定与文档校对） | 新增 |
| `--bg-app` | `#0b1017` | `#f3f6fb` | **主工作区底**，同时是 `BrowserWindow.backgroundColor` 与 `--material-fallback` | 改值（原 `#090d13`；与主进程硬编码 `#0f1116` 的色差问题一并修正） |
| `--material-fallback` | `#0b1017` | `#f3f6fb` | `@supports not (background: color-mix(...))` 或不支持 Mica 时的兜底底 | 新增（= `--bg-app`） |
| `--content-bg` | `rgba(11,16,23,.82)` | `rgba(243,246,251,.80)` | **主工作区**表面（压在 Mica 上） | 新增 |
| `--rail-bg` | `rgba(14,20,29,.88)` | `rgba(252,253,255,.86)` | **左实例栏**表面（Mica 透出 12%） | 新增 |
| `--titlebar-tint` | `rgba(10,14,20,.18)` | `rgba(255,255,255,.62)` | **仅标题栏**额外叠加的 tint：把 Mica 透出度压到 8–10%，收敛 WCO 竖向接缝（§2.5） | 新增 |
| `--titlebar-surface` | `rgba(31,37,47,.90)` | `rgba(250,251,254,.92)` | 标题栏合成色（`--titlebar-tint` 压 `--rail-bg` 的近似值），**标题栏实际使用的表面色**，也是与 WCO `color` 对表的依据 | 新增 |
| `--rail-solid-dark` | `#10151d` | — | 仅用于 WCO `color` 与主进程取值（**不写进 CSS `:root`，由主进程持有**） | 新增 |
| `--rail-solid-light` | — | `#fbfcfe` | 同上 | 新增 |
| `--bg-surface` | `#131a25` | `#ffffff` | **卡片、行项容器**（**不透明**，判据 M ③） | 改值（原 `#111a26`，随 `--bg-app` 同步上调 1 档） |
| `--bg-surface-2` | `#192231` | `#f6f8fc` | 卡片头、次级填充 | 改值（原 `#16202e`） |
| `--bg-elevated` | `#1d2839` | `#ffffff` | **菜单下拉 / 模态 / Toast**（**不透明**，判据 M ④） | 改值（原 `#1a2636`） |
| `--bg-inset` | `#080c11` | `#eef2f8` | 输入框、日志底、YAML、文本域（**不透明**） | 改值（原 `#0b1017`） |
| `--bg-hover` | `rgba(255,255,255,.05)` | `rgba(15,28,48,.05)` | **全部** hover 底（含窗口控制按钮、菜单项、卡片） | 沿用 |
| `--bg-active` | `rgba(255,255,255,.09)` | `rgba(15,28,48,.08)` | **全部**按下态底 | 沿用 |
| `--bg-selected` | `rgba(77,141,255,.16)` | `rgba(47,111,221,.12)` | 左实例栏选中项、菜单触发器展开态 | 沿用 |
| `--scrim` | `rgba(3,6,11,.66)` | `rgba(24,34,50,.42)` | 模态遮罩 | 沿用 |
| `--grid-line` | `rgba(255,255,255,.04)` | `rgba(15,28,48,.05)` | 辅助线 | 沿用 |

**Mica 下的层级语义（一张图说清）**

```
深度 0  Mica（Windows 从壁纸取样，随系统深浅色）
          ↑ 只能被外壳表面半透明覆盖
深度 1  --titlebar-surface  标题栏（Mica 透出 ≈10%，为收敛 WCO 竖缝而刻意压暗）
        --rail-bg           左实例栏（Mica 透出 ≈12%）
        └─ 同一族外壳表面：明度差 ≤ 1 档 ⇒ 组合成 L 形 chrome，物理上不可能出现水平色缝
深度 2  --content-bg  主工作区（与 --rail-bg 的明度差 ≤ 1 档，靠 1px 竖线 + 明度差分离）
          ↑ 到这里为止允许半透明
──────────────────────────── 不可逾越的分界：以下必须不透明 ────────────────────────────
深度 3  --bg-surface / --bg-surface-2 / --bg-inset   卡片、行项、输入框、日志
深度 4  --bg-elevated                                菜单 / 模态 / Toast（唯一挂投影的一层）
```

| 区域 | 用的层级 | 具体令牌 | 为什么 |
| --- | --- | --- | --- |
| **标题栏** | 深度 1 | `--titlebar-surface` + 1px `--border-subtle` 下沿；WCO `color` = 该色的实心近似 `--rail-solid-*` | 与左实例栏同族同明度档 ⇒ 不可能出现水平色缝（判据 M-1）；专属表面用于收敛 WCO 竖缝（§2.5） |
| **应用内菜单** | 深度 4 | `--bg-elevated`（不透明）+ 1px `--border` + `--shadow-s3` | 菜单是「从 chrome 上撕下来的一层」，必须与标题栏同族但更实、更亮一档 |
| **内容区（主工作区）** | 深度 2 | `--content-bg` | 比外壳浅一档，靠明度差而非描边区分 |
| **卡片 / 行项** | 深度 3 | `--bg-surface`（+ hover `--bg-surface-2`） | 不透明，保护正文可读性 |
| **输入框 / 日志 / 文本域** | 深度 3 | `--bg-inset` | 内嵌语义，比卡片再深一档（**深色主题**）；浅色主题下比卡片略深 |
| **浮层（模态 / Toast）** | 深度 4 | `--bg-elevated` | 与菜单同层，都用 `--shadow-s3` |

#### 4.1.4 描边与文本

| 令牌 | 深色 | 浅色 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| `--border-subtle` | `rgba(255,255,255,.06)` | `rgba(15,28,48,.07)` | **一切 1px 分隔线**（标题栏下沿、侧栏右沿、抽屉左沿、卡片头、菜单分隔） | 沿用 |
| `--border` | `rgba(255,255,255,.10)` | `rgba(15,28,48,.13)` | 控件边界（按钮、输入框、卡片、浮层面板） | 沿用 |
| `--border-strong` | `rgba(255,255,255,.18)` | `rgba(15,28,48,.22)` | hover 边界、滚动条 thumb | 沿用 |
| `--text-1` | `#e9eef7` | `#131c29` | 主文字、标题栏品牌名、菜单项 | 沿用 |
| `--text-2` | `#a2b2c8` | `#4c5c73` | 次级文字、菜单触发器常态、窗口按钮符号 | 沿用 |
| `--text-3` | `#71839a` | **`#6b7a90`** | 三级文字、拖拽区标题、快捷键提示 | **改值（仅浅色）**：原 `#78889e` 对 `#f3f6fb` 仅 3.31:1，**不达 AA 4.5:1**；`#6b7a90` = **4.61:1** ✅ |
| `--text-disabled` | `#55647a` | `#9aa7b8` | 禁用 | 沿用 |
| `--text-on-accent` | `#ffffff` | `#ffffff` | 主按钮文字 | 沿用 |
| **`--wco-symbol`** | `#a2b2c8` | `#4c5c73` | WCO `symbolColor`（**仅供主进程读取，不写进 CSS**） | 新增 |

**WCAG AA 对比度校验表（本方案令牌实测，可直接作为验收基线）**

| 组合 | 深色 | 浅色 | 判定 |
| --- | --- | --- | --- |
| `--text-1` / `--content-bg`（→ `--bg-app`） | 16.4:1 | 15.7:1 | ✅ |
| `--text-2` / `--bg-app` | 9.0:1 | 6.8:1 | ✅ |
| `--text-3` / `--bg-app` | 5.0:1 | **4.6:1**（改值后） | ✅（原浅色 3.3:1 ❌） |
| `--text-1` / `--bg-surface` | 15.2:1 | 15.7:1 | ✅ |
| `--text-2` / `--bg-surface` | 8.4:1 | 6.8:1 | ✅ |
| `--text-3` / `--bg-surface` | 4.7:1 | 4.7:1 | ✅（浅色需用改值后的 `#6b7a90`） |
| `--text-1` / `--bg-elevated`（菜单项） | 13.4:1 | 15.7:1 | ✅ |
| `--text-3` / `--bg-elevated`（快捷键） | 4.2:1 | 4.7:1 | ⚠️ 深色 4.2 < 4.5 ⇒ **快捷键提示属「辅助性重复信息」（同一项已有可读标签），按 WCAG 1.4.3 例外允许**；若验收方不接受，深色下改用 `--text-2`（8.4:1） |
| `--text-2` / `--rail-bg`（菜单触发器） | 8.6:1 | 6.6:1 | ✅ |
| `--text-3` / `--rail-bg`（拖拽区标题） | 4.8:1 | 4.5:1 | ✅ |
| `--text-on-accent` / `--accent` | 3.20:1 | 4.73:1 | ⚠️ **深色主按钮不达 AA**。三级缓解：① 主按钮**不加粗**改 `--fw-medium`；② 主按钮文字用 `--fs-md` 13px（< 18.66px 的普通文字口径）；③ **主按钮只承载非唯一入口的动作**（「新建实例」在左实例栏与本页均有替代入口）。**若验收要求严格合规，深色 `--accent` 提亮到 `#5c97ff`（对白字 4.06:1）仍不足，最终只能改深色主按钮文字为 `#0b1017` 深字（对 `#4d8dff` = 6.6:1 ✅）——本文推荐后者，标记为 `--accent-ink`** |
| `--text-on-accent` / `--accent-hover` | 3.55:1 | **4.73:1** | ⚠️ 深色同上；浅色改值后 ✅ |
| WCO 符号 / WCO 底 | 8.3:1 | 7.7:1 | ✅ |

### 4.2 排版令牌

| 令牌 | 值 | 标题栏 / 菜单 / 内容区用途 | 来源 |
| --- | --- | --- | --- |
| `--font-ui` | **`"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif`** | 全 UI。**顺序调整**：现行 `tokens.css:77-78` 把 `Microsoft YaHei UI` 放首位，导致拉丁字母与数字也走雅黑字面、与 Windows 11 原生不符；调整为 Segoe UI Variable 优先（Win11 系统字体），中文自然回退到雅黑 | 改值 |
| `--font-display` | `"Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI", "Microsoft YaHei UI", sans-serif` | 视图标题、模态标题、空态标题 | 新增 |
| `--font-mono` | `"Cascadia Mono", "JetBrains Mono", "Sarasa Mono SC", Consolas, monospace` | 版本号、快捷键、日志、路径、YAML | 沿用 |
| **`--fs-titlebar`** | **14px** | **标题栏品牌名 + 菜单触发器**（低于 14px 的 chrome 字在 Windows 100% 缩放下可读性差） | **新增** |
| `--fs-xs` | 11px | 版本徽标、菜单快捷键提示、菜单分组标题、徽标文字 | 沿用 |
| `--fs-sm` | 12px | 拖拽区标题、表单提示、`.btn--sm` | 沿用 |
| `--fs-md` | 13px | 正文、按钮默认、菜单项、页签 | 沿用 |
| `--fs-lg` | 15px | 卡片标题、抽屉标题 | 沿用 |
| `--fs-xl` | 18px | 模态标题 | 沿用 |
| `--fs-2xl` | 22px | 视图标题 | 沿用 |
| `--fs-3xl` | 28px | 空态大字（保留档位） | 沿用 |
| `--lh-tight` / `--lh-normal` | `1.3` / `1.55` | 标题 / 正文 | 沿用 |
| **`--lh-code`** | **`1.65`** | 等宽文本块（日志、YAML、console） | **新增**（收敛 `1.6`/`1.65` 两处孤值） |
| **`--lh-chrome`** | **`1`** | 标题栏与菜单内单行元素（避免行高参与高度计算） | **新增** |
| `--fw-regular` | 400 | 正文、菜单项、页签 | 沿用 |
| `--fw-medium` | 500 | 按钮、菜单触发器、次级强调 | 沿用 |
| `--fw-semibold` | 600 | 品牌名、卡片标题、视图标题、模态标题 | 沿用 |
| `--fw-bold` | 700 | 仅数据强调；**当前为死令牌**（`ui-acceptance-criteria.md` F1-2 已指出），本方案保留但在 §10 列为待清理 | 沿用 |

### 4.3 间距令牌

| 令牌 | 值 | 标题栏相关用法 | 来源 |
| --- | --- | --- | --- |
| `--sp-0` | 0 | 窗口控制区右侧留白、`app-region` 边缘内缩 | 沿用 |
| `--sp-1` | 4px | 菜单面板内边距、分隔线上下、菜单与标题栏缝隙、滚动条发丝偏移 | 沿用 |
| `--sp-2` | 8px | 品牌区间距、菜单区间隔、操作按钮 gap、按钮内图标与文字 gap | 沿用 |
| `--sp-3` | 12px | **标题栏左内边距（`--titlebar-pad-x`）**、菜单触发器内边距、菜单项内边距、区间距 | 沿用 |
| `--sp-4` | 16px | 卡片内边距、抽屉头左右内边距 | 沿用 |
| `--sp-5` | 20px | 视图头上下内边距、模态头 | 沿用 |
| `--sp-6` | 24px | 视图体内边距、快捷键与标签最小间距 | 沿用 |
| `--sp-7/8/10/12` | 28/32/40/48px | 区块间距、空态 | 沿用 |

> **间距纪律**：`gap` / `padding` / `margin` 只允许取上表值与 `1px / 2px`（发丝级：分隔线、聚焦环偏移、WCO 边界补偿），且发丝级取值必须在代码里注释理由。**现状有 23 处梯度外间距**（`gap: 5px` ×7、`gap: 6px` ×6、`padding: 7/9/10/18px` 等），全部登记在 §10。

### 4.4 圆角令牌（收敛到 Fluent 四档）

| 令牌 | 值 | 用法 | 来源 |
| --- | --- | --- | --- |
| **`--r-nav`** | **2px** | 导航项（左实例栏行、页签）、标题栏版本徽标、20px 级应用标记（对应 WinUI NavigationView 的 2px 项圆角） | **新增** |
| `--r-sm` | 4px | 菜单项、菜单触发器、图标按钮、输入框、复选框、`.btn--sm` | 沿用（**扩大用途**） |
| `--r-md` | 8px | 默认按钮、卡片、行项容器、菜单面板、Toast、日志面板 | 沿用（**扩大用途**） |
| `--r-lg` | 12px | 卡片外框（`.card` / `.inst-card` / `.engine-card` / `.pick-card`）、模态框、抽屉内浮层 | 沿用 |
| **`--r-xl`** | ~~16px~~ | **不再用于模态框**（Fluent 模态是 8px）。若清理后确无使用点，**从令牌删除**，避免孤值 | 标记待删 |
| **`--r-2xl`** | ~~20px~~ | 同上；空态插画块改用 `--r-lg` | 标记待删 |
| `--r-full` | 999px | 徽标、芯片、开关轨道、进度条、头像、状态点 | 沿用 |

**两条必须遵守的几何规则**

1. **嵌套递减**（Fluent 规则）：子元素圆角 = 父元素圆角 − 内边距。菜单：面板 8 − padding 4 = **项 4** ✅。卡片：`.card` 12 − 内边距 8 = 4 ⇒ 卡内 `.btn` / `.input` 用 4（`--r-sm`）✅。
2. **禁止** 3px、6px、7px、10px、13px、16px（模态内）、20px 这些非梯度值。自绘窗口按钮**不存在**，因此本方案**没有**「0 圆角满高按钮」这一例外——这是相比 v1 方案的一处简化。

### 4.5 阴影令牌

| 令牌 | 值 | **允许的用途（穷举）** | 来源 |
| --- | --- | --- | --- |
| `--shadow-s1` | 深 `0 1px 2px rgba(0,0,0,.30), 0 1px 1px rgba(0,0,0,.20)` / 浅 `0 1px 2px rgba(20,32,52,.08), 0 1px 1px rgba(20,32,52,.05)` | 静态卡片、头像、Toast 常态 | 沿用 `--shadow-1` |
| `--shadow-s2` | 深 `0 4px 14px rgba(0,0,0,.34), 0 1px 3px rgba(0,0,0,.24)` / 浅 `0 4px 14px rgba(20,32,52,.10), 0 1px 3px rgba(20,32,52,.07)` | 卡片 hover（**只改阴影，不改位置**）、窄屏抽屉浮层、日志跳到底部按钮 | 沿用 `--shadow-2` |
| `--shadow-s3` | 深 `0 18px 52px rgba(0,0,0,.50), 0 6px 16px rgba(0,0,0,.34)` / 浅 `0 18px 52px rgba(20,32,52,.18), 0 6px 16px rgba(20,32,52,.10)` | **仅**菜单下拉、模态框、Toast | 沿用 `--shadow-3` |
| `--shadow-inset` | 深 `inset 0 1px 0 rgba(255,255,255,.04)` / 浅 `inset 0 1px 0 rgba(255,255,255,.70)` | 头像、内嵌块、色板 | 沿用 |
| `--ring` | `0 0 0 3px var(--accent-soft)` | 输入框聚焦、开关聚焦、卡片聚焦（替代 outline） | 沿用 |
| `--ring-danger` | `0 0 0 3px var(--danger-soft)` | 非法输入聚焦 | 沿用 |
| **`--ring-titlebar`** | `inset 0 0 0 2px var(--accent)` | **标题栏内**元素的 focus-visible（内缩，避免溢出被裁切） | **新增** |

> **投影纪律（判据 M）**：`--shadow-s3` 只允许出现在 `.menu` / `.modal` / `.toast` 三条规则里。**标题栏、左实例栏、视图头、卡片一律不得有投影**。现有 `.inst-card:hover` 的 `translateY(-3px)` + `--shadow-2` 叠加（`components.css:751-756`）属双重违规（位移 + 阴影抬升），改为「边框变 `--border` + 底色变 `--bg-surface-2`」。

### 4.6 控件与尺寸令牌（**消灭散落的 px 字面量**）

| 令牌 | 值 | 用途 | 来源 |
| --- | --- | --- | --- |
| `--ctl-h-sm` | 24px | `.btn--sm`、`.btn--icon-sm`、Toast 关闭、复制按钮、菜单项内小图标按钮 | 新增 |
| `--ctl-h-md` | 32px | `.btn`（默认）、`.input`、`.select`、`.textarea`、菜单项、分段控件 | 新增 |
| `--ctl-h-lg` | 40px | `.btn--lg`、向导主行动、空态主按钮 | 新增 |
| `--ctl-h-badge` | 20px | `.badge`、`.chip` | 新增 |
| `--nav-item-h` | 36px | 左实例栏行、`rail__nav-btn`、抽屉内行项 | 新增 |
| `--bar-h-view` | 44px | `.view__head`、`.view__tabs` | 新增 |
| `--bar-h-panel` | 40px | `.card__head`、`.drawer__head`、`.logview__bar` | 新增 |
| `--touch-min` | 24px | 任意可点击元素的最小命中区（**`iconButton` 的硬性下限**，对应 WCAG 2.5.8） | 新增 |
| **`--icon-slot`** | **16px** | 行内图标槽位（菜单项、行项前导、按钮内图标） | 新增 |
| **`--icon-sm`** | **14px** | 小控件内图标（`.btn--sm`、分段控件、徽标内 12px 另立） | 新增 |
| **`--icon-lg`** | **20px** | 行项前导图标、模态头图标 | 新增 |
| **`--icon-mark`** | **14px** | 标题栏应用标记内图标 | 新增 |
| **`--icon-badge`** | **12px** | 徽标内图标 | 新增 |

> **图标档位收敛**：全应用 icon 尺寸只允许 `{12, 14, 16, 18, 20}`（+ 空态插画 24/28/34）。现状实测有 **10 个取值**（11..19 + 24），属「随手写」而非「选档」。
> **描边纪律**：`icons.ts:97` 固定 `stroke-width="1.8"`，在 12px 显示时视觉描边仅 0.9px（过细），24px 时 1.8px（过粗）。**视觉描边（px）= 1.8 × (显示尺寸 ÷ 24)**，要求落在 `[1.0, 1.4]`：
> **14px → 1.5｜16px → 1.8｜20px → 2.1**（按显示尺寸分档设置 `stroke-width`，仍保持 24×24 viewBox 与圆头圆角）。

### 4.7 布局尺寸令牌

| 令牌 | 值 | 用途 | 来源 |
| --- | --- | --- | --- |
| **`--titlebar-h`** | **48px** | 标题栏总高（**必须 === `titleBarOverlay.height`**） | **新增**（取代 `--topbar-h: 52px`） |
| **`--titlebar-pad-x`** | **12px** | 标题栏左内边距 | 新增 |
| **`--titlebar-gap`** | **12px** | 标题栏各分区之间的水平间距 | 新增 |
| **`--titlebar-drag-min`** | **160px** | 拖拽区最小宽度（硬性下限） | 新增 |
| **`--titlebar-title-max`** | **40ch** | 拖拽区标题最大宽度 | 新增 |
| **`--wco-w`** | **138px** | WCO 预留宽度（JS 覆盖，见 §2.7） | 新增 |
| **`--menubar-h`** | **0px** | 菜单栏独立行高（当前为 0，即折进标题栏；未来若拆独立行改为 36px） | 新增（预留） |
| `--rail-w` | 264px | 左实例栏宽度（≥1100px） | 沿用 |
| `--rail-w-narrow` | 216px | 左实例栏（<1100px） | 新增 |
| `--rail-w-icon` | 72px | 左实例栏图标态（<980px） | 新增 |
| `--drawer-w` | 424px | 右侧日志抽屉 | 沿用 |
| `--content-max` | 1560px | 视图内容最大宽度 | 沿用 |
| `--menu-min-w` / `--menu-max-w` | 220px / 340px | 菜单面板宽度范围 | 新增 |
| `--menu-max-h` | 480px | 菜单面板最大高度 | 新增 |
| `--menu-item-h` | 32px | 菜单项高度 | 新增 |
| `--menu-trigger-h` | 28px | 菜单触发器高度 | 新增 |
| `--menu-gap-y` | 4px | 面板与标题栏的垂直缝隙 | 新增 |
| `--menu-gap-x` | 2px | 触发器之间的间距 | 新增 |
| `--modal-w-sm/md/lg/xl` | 432 / 560 / 760 / 920px | 模态四档宽度（**从 `components.css:940,953,957,961` 字面量提为令牌**） | 新增 |

### 4.8 动效令牌

| 令牌 | 值 | 用途 | 来源 |
| --- | --- | --- | --- |
| `--dur-fast` | 100ms | 按下反馈（active）、开关滑杆（**替代 `--ease-spring`**） | 新增 |
| `--dur-1` | 120ms | hover / focus 状态反馈 | 沿用 |
| `--dur-2` | 160ms | 入场（菜单、模态、Toast）、卡片 hover | 沿用 |
| `--dur-3` | 220ms | 大区域尺寸变化（抽屉展开 / 收起） | 沿用 |
| `--dur-spin` | 0.9s | 确定性进度环周期（`linear`，无限循环） | 新增 |
| `--ease` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | 入场 / 位移 | 沿用 |
| `--ease-out-fluent` | `cubic-bezier(0.10, 0.90, 0.20, 1.00)` | **Fluent 标准减速曲线**：一切状态反馈（hover / active / focus / 展开） | 新增 |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | 循环动画 | 沿用 |
| `--ease-spring` | ~~`cubic-bezier(0.34, 1.32, 0.64, 1)`~~ | **禁用** —— Fluent 不用过冲弹簧。`components.css:546`（开关滑杆）与 `components.css:483-494`（复选框勾）改 `--ease-out-fluent` + `--dur-fast` | 标记待删 |

**映射规则（新代码不得自定义时长）**

| 场景 | 时长 | 缓动 |
| --- | --- | --- |
| hover / active / focus 变色 | `--dur-1`（100–120ms） | `--ease-out-fluent` |
| 元素入场（菜单、模态、Toast） | `--dur-2`（160ms） | `--ease` |
| 大区域尺寸（抽屉） | `--dur-3`（220ms） | `--ease` |
| 循环指示（进度环、骨架屏） | `--dur-spin` 等 | `linear` |

> **退场时长**：`∈ [入场 × 0.6, 入场 × 1.0]`。抽屉这类大区域关闭必须与开启同档（`--dur-3`）——现状 `.drawer` 展开 220ms，关闭时内容被**瞬清**（`shell.ts:277-285`），观感「被抽走」，需补 160ms 的宽度收拢动画（保留内容直到动画结束）。

### 4.9 Mica 降级矩阵（**只换三个变量的值，别的一律不动**）

| 判定条件 | `backgroundMaterial` | 外壳背景令牌 | 主进程 `backgroundColor` | 标题栏视觉 |
| --- | --- | --- | --- | --- |
| Windows 11 build ≥ 22000 + 系统「透明效果」开启 | `'mica'` | `--titlebar-surface` / `--rail-bg` / `--content-bg`（半透明，见 §4.1.3） | `--bg-app`（Mica 下仅首帧可见） | 标题栏半透明，与左栏、内容区无水平色缝 |
| Windows 11 + 系统「透明效果」**关闭** | `'none'` | 同上（半透明值叠在不透明 `--bg-app` 上，等效于不透明） | `--bg-app` | 全窗口完全不透明，层级仍靠面板色阶梯表达 |
| Windows 10 1809–21H2 | `'none'` | 同上 | `--bg-app` | 无 Mica，其余规格不变（无窗口圆角，`roundedCorners` 无效） |
| `systemPreferences` / 策略禁止透明 | `'none'` | 同上 | `--bg-app` | 同上 |
| 任何降级路径 | — | — | — | **严禁**为降级单独写一套「不透明配色」——半透明令牌叠在不透明底上本身就是正确的不透明配色 |

**实现要点**

```ts
// main/index.ts —— 唯一判定点，渲染层不得重复实现
function themeBackground(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? '#0b1017' : '#f3f6fb';   // === var(--bg-app) 两档，注释里写明与 tokens.css 对齐
}
function overlayColors(theme: 'dark' | 'light') {
  return theme === 'dark'
    ? { color: '#10151d', symbolColor: '#a2b2c8' }   // === --titlebar-surface 的实心近似 / --wco-symbol
    : { color: '#fbfcfe', symbolColor: '#4c5c73' };  // === 同上（浅色）
}
// 主题切换时（launcher:setConfig 落库成功后）：
win.setBackgroundColor(themeBackground(next));
win.setTitleBarOverlay({ ...overlayColors(next), height: 48 });   // height 必须 === var(--titlebar-h)
```

| 时机 | 动作 | 关键约束 |
| --- | --- | --- |
| 窗口创建时 | `backgroundColor` / `titleBarOverlay` / `backgroundMaterial` 按当前 `config.theme` 一次性给定 | 只允许**一处**硬编码主题底色（该常量须与 `tokens.css` 的 `--bg-app` 注释对齐） |
| 用户切主题后 | 渲染层改 `document.documentElement.dataset.theme` → 主进程在 `setConfig` 成功后同步 `setBackgroundColor` + `setTitleBarOverlay` | **必须由主进程改**：`titleBarOverlay` 是主进程选项，CSS 无权改。缺这一步会出现「标题栏按钮区还是旧主题色」的割裂（即用户抱怨的问题在新架构下的复现路径） |
| 最小化 → 还原 | 观察首帧 | 出现与当前主题不符的底色即失败 |
| 判定函数收敛 | `nativeTheme.on('updated')` 与自身 `setConfig` 结果**都收敛到同一组函数** | 杜绝两条路径各写一份色值 |

---

## 5. 组件规格

> 每项给「尺寸 / 内边距 / 圆角 / 状态颜色」。所有颜色写令牌名，括号内为深色/浅色实际取值。
> **统一硬性规则**：全部可点击元素的默认态背景**一律不使用渐变**；active 一律 `--bg-active` 或对应语义色的 `-press` 档；**全部 hover 一律不位移**。

### 5.1 按钮

| 变体 | 类名 | 用途 | 背景 normal / hover / active | 边框 | 文字 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| 主要 | `.btn--primary` | 视图内唯一的主行动（启动实例、创建、保存） | `--accent` / `--accent-hover` / `--accent-press` | 1px `--accent-border` | `--accent-ink`（深色 `#0b1017`，6.6:1 ✅）/ `--text-on-accent`（浅色 `#fff`，4.73:1 ✅） | 改值（删渐变） |
| 次要 | `.btn`（默认） | 绝大多数动作 | `--bg-surface-2` / **`--bg-hover`** / `--bg-active` | 1px `--border` → hover `--border-strong` | `--text-1` | **改值**（原 hover 为 `--bg-elevated`，与卡片同色导致浮起错觉） |
| 危险 | `.btn--danger-solid` | 删除实例、清空存档 | `--danger` / `--danger-hover` / `--danger-press` | 1px `--danger-border` | `--text-on-accent` | 改值（删渐变 + 删 hover 位移） |
| 危险·柔 | `.btn--danger` | 可逆的危险动作（停止实例） | `--danger-soft` / `--danger-soft` 加深至 `--danger` / `--danger-press` | 1px `--danger-border` | `--danger-text` → hover `--text-on-accent` | 沿用 |
| 幽灵 | `.btn--ghost` | 标题栏与工具条图标动作 | `transparent` / `--bg-hover` / `--bg-active` | `transparent` | `--text-2` → hover `--text-1` | 沿用 |
| 柔和强调 | `.btn--subtle` | 已激活的切换按钮（抽屉打开时的「运行日志」） | `--accent-softer` / `--accent-soft` / `--bg-active` | 1px `--accent-border` | `--accent-text` | 沿用 |
| 图标 | `.btn--icon` / `.btn--icon-sm` | 仅图标 | 同所属变体 | — | — | 沿用 |

| 尺寸 | 类名 | 高 | 内边距 | 圆角 | 字号 | 图标 | 最小宽 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 小 | `.btn--sm` | **24px**（改值，原 26px） | `0 var(--sp-2)`（8px） | `--r-sm`（4px） | `--fs-sm`（12px） | `--icon-sm`（14px） | — |
| 中 | `.btn` | **32px** | `0 var(--sp-3)`（12px） | `--r-sm`（4px，**改值**，原 `--r-md`） | `--fs-md`（13px） | 16px | — |
| 大 | `.btn--lg` | **40px**（改值，原 38px） | `0 var(--sp-4)`（16px） | `--r-sm`（4px） | `--fs-md`（13px） | 16px | — |
| 图标·小 | `.btn--icon-sm` | 24px | 0 | `--r-sm` | — | 14px | 24px |
| 图标·中 | `.btn--icon` | 32px | 0 | `--r-sm` | — | 16px | 32px |
| 标题栏图标 | `.titlebar .btn--icon-sm` | **28px** | 0 | `--r-sm` | — | 16px | 28px |

| 通用态 | 规格 |
| --- | --- |
| focus-visible（内容区） | `outline: 2px solid var(--accent); outline-offset: 2px`（**沿用** `base.css:125-129`） |
| focus-visible（标题栏内） | `outline: 2px solid var(--accent); outline-offset: -2px`（**内缩**） |
| disabled | `opacity: .45` + `cursor: not-allowed` + `pointer-events: none`（**沿用**） |
| 忙碌 | `.is-busy`：标签 `opacity: .4`，叠加 12px 确定性进度环（**沿用** `ui.ts:85-99` / `components.css:135-152`） |
| 过渡 | `background/border-color/color var(--dur-1) var(--ease-out-fluent)`；**删除** `transform` 过渡 |

### 5.2 输入框 / 文本域 / 下拉

| 控件 | 高 | 内边距 | 圆角 | normal | hover | focus | disabled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.input` | **32px**（改值，原 34px） | `0 var(--sp-3)` | `--r-sm`（4px，**改值**） | 底 `--bg-inset`，边 1px `--border`，字 `--text-1`，placeholder `--text-3` | 边 `--border-strong` | 边 `--accent`，`box-shadow: var(--ring)` = 3px `--accent-soft`，底 `--bg-app` | `opacity: .5` + `cursor: not-allowed` |
| `.textarea` | auto，`min-height: 84px` | `var(--sp-2) var(--sp-3)` | `--r-sm` | 同 `.input`；`line-height: var(--lh-code)`（1.65） | 同 | 同 | 同 |
| `.select` | 32px | `0 var(--sp-3)`，右侧 `--sp-8`（32px）为箭头让位 | `--r-sm` | 同 `.input`；`appearance: none` + `.select-caret` 图标 14px 绝对定位 `right: var(--sp-2)` | 同 | 同 | 同 |
| `.input--mono` | — | — | — | `font-family: var(--font-mono)` / `--fs-sm` | — | — | — |
| 非法态 | — | — | — | 边 `--danger` | — | `--ring-danger` | — |
| `.search` | 32px | 输入区 `padding-left: 31px` | `--r-sm` | 内嵌 `icon('search', 14)` 绝对定位 `left: var(--sp-2)`，色 `--text-3` | — | — | — |
| `.search__clear` | **24×24** | 0 | `--r-sm` | `right: var(--sp-1)`；底 transparent，图标 `--text-3` | 底 `--bg-hover`，图标 `--text-1` | focus-visible 环 | — |

**下拉选项（`<option>`）**：原生下拉在 Windows 上由系统绘制，样式不可控。**要求**：`color-scheme` 已随主题切换（`tokens.css:8,152` **沿用**），据此系统下拉自动适配深浅；**不要**尝试自绘下拉（会引入第二套浮层语言，违反判据 M ④的穷举性）。

### 5.3 卡片

| 属性 | `.card`（通用容器） | `.card--boxed`（实例卡 / 引擎卡 / 选项卡） |
| --- | --- | --- |
| 背景 | `--bg-surface`（不透明） | 同 |
| 边框 | 1px `--border-subtle` → hover `--border` | 1px `--border` → hover `--border-strong` |
| 圆角 | `--r-md`（8px，**改值**，原 `--r-lg` 12px） | `--r-lg`（12px） |
| 内边距 | 头 `var(--sp-4)`；体 `var(--sp-4)`；脚 `var(--sp-3) var(--sp-4)` | `var(--sp-4)` |
| 投影 | 无 | `--shadow-s1` |
| hover | 底 → `--bg-surface-2`，边 → `--border`，**`--shadow-s1 → --shadow-s2`** | 同 |
| **hover 位移** | **删除**（原 `translateY(-3px)` / `(-2px)`） | 删除 |
| 卡片头下沿 | **无分隔线**（判据 M-2）；靠间距 `var(--sp-4)` 分隔 | — |
| 卡片脚下沿 | 1px `--border-subtle`（**统一 solid**，修正 `.engine-card__foot` 用 dashed 的不一致，`views.css:269`） | 同 |
| 顶部状态色条 | — | 高 **2px**（**改值**，原 3px），全宽，`background: var(--card-accent, var(--accent))`；**是装饰不是语义**，浅色主题下该色需 ≥ 3:1 对白底，否则加 1px 深色描边 |
| 焦点 | `box-shadow: var(--ring)`（替代 outline，因 `overflow: hidden`） | 同 |
| 行项 `.row-item` | 高 `44px`，内边距 `var(--sp-3) var(--sp-4)`，圆角 `--r-nav`（2px），行间 **无分隔线**，hover 底 `--bg-hover` | — |

### 5.4 徽标（实例状态）

**规格**：高 `--ctl-h-badge`（20px），内边距 `0 var(--sp-2)`（8px），圆角 `--r-full`，边框 1px，图标 12px，`gap: var(--sp-1)`，`--fs-xs`（11px）/ `--fw-medium`，`white-space: nowrap`。大号 `.badge--lg`：高 24px，内边距 `0 var(--sp-3)`，`--fs-sm`。

| 状态 | 文案 | 语义色 | 背景 | 边框 | 文字 | 前导标记 |
| --- | --- | --- | --- | --- | --- | --- |
| 已停止 | 已停止 | `--state-stopped` | `--neutral-soft` | `--border-subtle` | `--neutral-text` | 6px 实心圆点 `currentColor`，**静止** |
| 启动中 | 启动中 | `--state-starting` | `--warning-soft` | `--warning-border` | `--warning-text` | **16px 确定性进度环**（`--state-starting` 描边 2px，`--dur-spin` linear） |
| 运行中 | 运行中 | `--state-running` | `--success-soft` | `--success-border` | `--success-text` | **16px 确定性进度环**（`--state-running`） |
| 停止中 | 停止中 | `--state-stopping` | `--neutral-soft` | `--border-subtle` | `--neutral-text` | **16px 确定性进度环**（`--state-stopping`，中性色） |
| 已崩溃 | 已崩溃 | `--state-crashed` | `--danger-soft` | `--danger-border` | `--danger-text` | 12px `alertCircle` 图标 |

**硬性规则**

1. **三通道冗余**：颜色 + 文本标签 + 形状/图标必须同时存在。色盲用户凭文本即可判断，凭形状可分辨「运动中」与「静止」。
2. **进度环而非脉冲**：WinUI 的 `ProgressRing` 是**确定性图形**，不是透明度闪烁。删除 `.badge__dot--pulse`（`components.css:250-252`）的 `wl-pulse` 用法；保留 `wl-pulse` 仅供启动骨架屏。
3. **禁止紫色**：`--state-stopping` 已由 `#b07cf0` 改为中性 `#8296ae`——Fluent 的 WinUI 3 标准色板只有蓝/绿/黄/红四个强调色相 + 中性色，紫色属越界（且 `components.css:231-233` 是硬编码字面量，同时违反 C1-1）。

### 5.5 页签

| 属性 | 值 |
| --- | --- |
| 容器 | 高 `--bar-h-view`（44px），底 `--content-bg`，**无下边框**（原 `layout.css:339` 的 1px 下沿与 `components.css:899` 的项下划线叠成双线，判据 M-2 失败） |
| 项 | 高 44px，内边距 `0 var(--sp-3)`（12px），圆角 `--r-nav`（2px，仅用于 focus 环），字号 `--fs-md`，`gap: var(--sp-2)` |
| normal | 文字 `--text-2`，指示器 `transparent` |
| hover | 文字 `--text-1`，**指示器不变**（Fluent 不在 hover 时显示指示器） |
| 选中（`is-active`） | 文字 `--text-1`，**2px 底部指示器 `--accent`**，`--fw-medium`（**不增重**：删掉 `components.css:910` 的 `font-weight`，避免切换时文字宽度跳动） |
| focus-visible | `outline: 2px solid var(--accent); outline-offset: -2px` |
| disabled | 文字 `--text-disabled` |
| 计数徽标 `.tabs__count` | 高 16px，内边距 `0 var(--sp-1)`，圆角 `--r-full`，底 `--bg-surface-2`，边 1px `--border-subtle`，字 `--fs-xs`，`font-variant-numeric: tabular-nums` |

### 5.6 模态框

| 属性 | 值 |
| --- | --- |
| 尺寸档 | `--modal-w-sm` 432px / `md` 560px（默认）/ `lg` 760px / `xl` 920px，窗口 `< 640px` 时 `width: 100%` |
| 最大高 | `min(86vh, 820px)` |
| 圆角 | **`--r-md`（8px）**（**改值**，原 `--r-xl` 16px——Fluent 的 `ContentDialog` 是 8px） |
| 背景 | `--bg-elevated`（不透明） |
| 边框 | 1px `--border` |
| 投影 | `--shadow-s3` |
| 遮罩 | `--scrim` + `backdrop-filter: blur(3px)`（**沿用**；遮罩是唯一允许模糊的地方） |
| 头部 | 内边距 `var(--sp-5) var(--sp-5) var(--sp-3)`；图标块 **36×36**，圆角 `--r-md`，底 `--bg-surface-2`，图标 20px；标题 `--fs-xl`（18px）/`--fw-semibold`/`--text-1`；描述 `--fs-sm`/`--text-3` |
| 关闭按钮 | `.btn--ghost.btn--icon-sm`，24×24，`--r-sm`，图标 14px；hover 底 `--bg-hover`（**不得**用危险色） |
| 主体 | 内边距 `0 var(--sp-5) var(--sp-5)`；`overflow-y: auto` |
| 底部 | 高度 **56px**，内边距 `0 var(--sp-5)`，行间 `gap: var(--sp-2)`，右对齐；`border-top: 1px solid var(--border-subtle)`；底 `--bg-surface`（比面板深一档） |
| 底部按钮 | 从左到右：次要（取消）→ 主要/危险。按钮尺寸用 `.btn`（32px） |
| 入场 | `wl-rise var(--dur-2) var(--ease)`；退场 `--dur-1`（**沿用** `components.css:964-966`） |

### 5.7 开关

| 属性 | 值 |
| --- | --- |
| 轨道 | **40×20px**（**改值**，原 36×20），圆角 `--r-full`，边框 1px |
| 轨道关闭态 | 底 `--bg-active`，边 `--border` |
| 轨道打开态 | 底 `--accent`，边 `--accent-border` |
| 滑块 | 14×14px，圆形（`--r-full`） |
| 滑块关闭态 | 底 `--text-2`，`left: 2px` |
| 滑块打开态 | 底 **`--accent-ink`**（深色主题下白滑块在亮蓝轨道上对比仅 3.2:1；用深色滑块 = 6.6:1 ✅；浅色主题下用 `#ffffff`），`transform: translateX(18px)` |
| 动效 | `transform/background var(--dur-fast) var(--ease-out-fluent)`（**删除 `--ease-spring`**，Fluent 不用过冲） |
| hover | 轨道边 `--border-strong` |
| focus-visible | `box-shadow: var(--ring)` |
| disabled | 轨道 `opacity: .45`，标签 `opacity: .55`（**沿用** `components.css:567-573`） |
| 标签 | `--fs-md` / `--text-1`，`gap: var(--sp-2)` |

### 5.8 空态

| 属性 | 默认 | `--compact` |
| --- | --- | --- |
| 容器 | `display: flex; flex-direction: column; align-items: center;` 内边距 `var(--sp-12) var(--sp-6)`，`gap: var(--sp-3)`，`text-align: center` | 内边距 `var(--sp-6) var(--sp-4)`，`gap: var(--sp-2)` |
| 插画块 `.empty__art` | 72×72，圆角 `--r-lg`（**改值**，原 `--r-2xl` 20px），底 `--bg-surface-2`，边 1px `--border-subtle` | 48×48，图标 24px |
| 图标 | 28px，色 `--text-3` | 24px |
| 标题 | `--fs-lg`（15px）/`--fw-medium`/`--text-1` | `--fs-md`/`--fw-medium`/`--text-2` |
| 描述 | `--fs-sm`/`--text-3`，`max-width: 46ch` | `--fs-sm`/`--text-3` |
| 动作 | `gap: var(--sp-2)`，主按钮 `.btn--primary` 40px，次按钮 `.btn` | 无 |

**实例列表空态文案**（**沿用** `shell.ts:175-192` 的语义）：「还没有实例」+「创建一个 dsh 实例，独享引擎版本、插件与设置」+ 主按钮「新建第一个实例」。

### 5.9 加载态

| 元素 | 规格 |
| --- | --- |
| 骨架屏 `.skeleton` | 底 `--bg-surface-2`，圆角 `--r-sm`；流光渐变 `linear-gradient(90deg, transparent, var(--bg-hover), transparent)`，`animation: wl-sheen 1.4s linear infinite`（**沿用** `components.css:1449-1465`） |
| 骨架行 | 高 12px，行间 `var(--sp-2)`；最后一行宽 62% |
| 确定性进度环 `.spinner` | 14px（`--sm` 12px / `--lg` 26px），轨道 2px `--border-strong`，活动弧 `currentColor`；`animation: wl-spin var(--dur-spin) linear infinite`（**沿用** `components.css:155-177`） |
| 进度条 `.progress` | 高 **4px**（**沿用**），底 `--bg-inset`，填充 `--accent`（危险场景 `--danger`），圆角 `--r-full`；不确定态用 `wl-indeterminate 1.15s var(--ease-in-out) infinite`（**沿用**） |
| 忙碌行 `.busy-row` | 12px 环 + `--fs-sm`/`--text-2` 文本，`gap: var(--sp-2)` |
| 按钮忙碌 | 见 §5.1 通用态 |

**加载态的 Fluent 纪律**：**禁止**全屏遮罩转圈（Fluent 用「内容区骨架 + 局部进度」）。列表首次加载用骨架屏，动作类等待用按钮内环或行内 `busy-row`。

---

## 6. 布局与响应式

### 6.1 整体结构

```
┌────────────────────────────── .titlebar（48px，--rail-bg）──────────────────────────────┐
│ 品牌  菜单×5        拖拽区标题                        日志 主题 新建 │   WCO（系统绘制）   │
├────────────────┬──────────────────────────────────────────────────────┬─────────────────┤
│  .rail         │  .main                                               │  .drawer        │
│  264px         │                                                      │  424px（可关）  │
│  --rail-bg     │  ┌ .view__head（44px，无下边框）───────────────────┐   │  --bg-surface   │
│                │  │ 视图标题 + 副标题                [动作按钮组]   │   │  --shadow-s2    │
│  ┌ 搜索 ────┐  │  ├ .view__tabs（44px，2px 下划线指示器）─────────┤   │                 │
│  │ 实例行×N │  │  │ 插件 │ 设置 │ 存档 │ 日志                    │   │  ┌ 工具条 ────┐ │
│  │ (36px)   │  │  ├ .view__body（--content-bg，padding 24px）─────┤   │  │ 日志滚动区 │ │
│  └──────────┘  │  │ 卡片网格 / 表单 / 日志（--bg-inset）           │   │  └───────────┘ │
│  版本管理      │  └───────────────────────────────────────────────┘   │  底部路径栏     │
│  全局设置      │                                                      │                 │
└────────────────┴──────────────────────────────────────────────────────┴─────────────────┘
  ← 同一块 L 形外壳（--rail-bg）；与 .main 之间只有 1 条 1px --border-subtle 竖线 →
```

| 区域 | 宽度 | 背景 | 边界 |
| --- | --- | --- | --- |
| 标题栏 | 100%，高 48px | `--rail-bg` | 下沿 1px `--border-subtle`（**全窗口唯一横贯线**） |
| 左实例栏 | `--rail-w` = 264px | `--rail-bg` | 右沿 1px `--border-subtle` |
| 主工作区 | `flex: 1 1 auto`，`min-width: 0` | `--content-bg` | — |
| 右日志抽屉 | `--drawer-w` = 424px，关闭时 0 | `--bg-surface` | 左沿 1px `--border-subtle`；宽屏为**内联档**（不叠加阴影），窄屏为**浮层档**（`--shadow-s2`） |

**左实例栏内部**

| 分区 | 高度 | 内容 |
| --- | --- | --- |
| `.rail__head` | auto（内边距 `var(--sp-3) var(--sp-3) var(--sp-2)`） | 段标题「实例」+ 计数 `n/N`（`--fs-xs`/`--text-3`/`tabular-nums`）+ 搜索框（32px，占满宽） |
| `.rail__list` | `flex: 1 1 auto`，`overflow-y: auto` | 实例行：高 `--nav-item-h`（36px），内边距 `var(--sp-2)`，`gap: var(--sp-3)`，圆角 `--r-nav`（2px）；头像 24×24（`--r-sm`）；名称 `--fs-md`/`--text-1`；元信息行 `--fs-xs`/`--text-3`（状态点 6px + 「运行中 · 0.9.7」）；行间 **无分隔线**，间距 `2px` |
| 选中行 | — | 底 `--bg-selected`，**左侧 2px `--accent` 指示条**（`::before`，替代现行 `border: 1px var(--accent-border)` 的整圈描边），文字 `--text-1` |
| `.rail__foot` | auto（内边距 `var(--sp-2)`） | 「版本管理」「全局设置」两行，上沿 1px `--border-subtle` |

**主工作区内部**

| 分区 | 高度 | 规格 |
| --- | --- | --- |
| `.view__head` | `--bar-h-view`（44px），内边距 `0 var(--sp-6)` | **删除下边框**与 `linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-app) 100%)`（`layout.css:289-297`，判据 M-3 违规）；视图标题 `--fs-2xl`（22px）/`--fw-semibold`；副标题 `--fs-md`/`--text-2`；动作按钮 32px |
| `.view__tabs` | 44px，内边距 `0 var(--sp-6)` | 见 §5.5 |
| `.view__body` | `flex: 1 1 auto`，`overflow-y: auto`，内边距 `var(--sp-6)`（24px） | 底 `--content-bg` |
| `.view__inner` | `max-width: var(--content-max)`（1560px），居中 | 子项 `gap: var(--sp-5)` |

**右日志抽屉**

| 分区 | 高度 | 规格 |
| --- | --- | --- |
| `.drawer__head` | `--bar-h-panel`（40px），内边距 `0 var(--sp-2) 0 var(--sp-4)` | 底 `--bg-surface`；标题 15px/600；左侧 1px `--border-subtle` |
| `.drawer__body` | `flex: 1 1 auto` | 底 `--bg-inset`（内嵌语义，日志是「机器可读区」） |
| 日志行 | 高 20px，`--font-mono`/`--fs-sm`/`--lh-code`（1.65） | 时间戳 `--text-3`、级别色分档（沿用 `components.css:1530-1590`） |
| 语义侧条 | **2px**（**统一**：`.toast` 的 3px 侧条同步改为 2px，消除「同类元素不同粗」，见 §10.3） | — |
| `.logview__foot` | 32px，上沿 1px `--border-subtle` | 路径 `--fs-xs`/`--font-mono`/`--text-3` 省略号截断 |

### 6.2 断点与适配

| 断点 | 触发 | 变化 |
| --- | --- | --- |
| **≥ 1440px** | 大桌面 | 标题栏显示版本徽标；`.inst-grid` 4 列；`.view__body` 左右内边距可增至 `--sp-8`（32px） |
| **1280–1439px**（设计基准） | 默认窗口 1280×840 | 标题栏隐藏版本徽标；左实例栏 264px；抽屉 424px 内联；卡片网格 `repeat(auto-fill, minmax(324px, 1fr))`（**沿用**） |
| **1100–1279px** | 窄桌面 | 左实例栏 `--rail-w-narrow` = 216px；`.view__body` 内边距 `var(--sp-5) var(--sp-4)`（20/16px）；`.view__head` 内边距 `var(--sp-4) var(--sp-4) var(--sp-3)`（**沿用** `layout.css:446-482` 的既有策略，仅把阈值 1100 与 `--rail-w-narrow` 令牌化） |
| **980–1099px** | 更窄 | 抽屉改为**浮层档**：`position: fixed; top: var(--titlebar-h); right: 0; bottom: 0`，宽 `min(var(--drawer-w), 92vw)`，`--shadow-s2`，不再挤压主区（**沿用** `layout.css:451-469`，仅把 `--topbar-h` 改为 `--titlebar-h`） |
| **< 980px** | 最小窗口附近 | 左实例栏图标态：`--rail-w-icon` = 72px；隐藏 `.rail__label` / `.rail__count` / `.rail__nav-hint` / `.rail__item-main` / `.brand__text`（**沿用** `layout.css:484-505`，仅把宽度 76 → 72 以落在 4px 梯度上）；实例行改为图标居中 |
| **< 720px** | 不可达（`minWidth: 1024`） | 无需设计；若未来放宽 `minWidth`，需重新评审 |

> **断点纪律**：只在 1440 / 1280 / 1100 / 980 四个值上切换；**禁止**新增 1200、900、820 这类一次性断点。所有断点相关的尺寸必须走令牌。

### 6.3 1280×840（设计基准）与 1920×1080 的适配校验

**1280×840**

| 区域 | 实得尺寸 | 校验 |
| --- | --- | --- |
| 标题栏 | 1280×48 | 品牌 144 + 菜单 256 + 拖拽 ≥160 + 操作 136 + WCO 138 = **834 ≤ 1280** ✅ 拖拽区实得 446px |
| 左实例栏 | 264×792 | 实例行 36px ⇒ 一屏可见 **18 行**（含 6px 行距）✅ |
| 主工作区 | 592×792（抽屉关） | 视图头 44 + 页签 44 + 体 704；卡片网格 592 − 48 = 544 可用宽 ⇒ **1 列**（324px 最小列宽）⚠️ 偏窄 |
| 抽屉打开时 | 主区 168px | 主区实质不可用 ⇒ 1280 宽下**默认不开抽屉** ✅（现状即如此） |

> ⚠️ 1280 宽且抽屉打开时主区仅 168px。**结论**：抽屉在 1280 宽下必须走浮层档。**修订**：把浮层档阈值从 1100 提高到 **1280**（即 `@media (max-width: 1279px)` 触发浮层），这样 1280 基准窗口下抽屉浮在内容之上而非挤压主区。**这是本方案对 `layout.css:446` 的一处阈值修改**。

**1920×1080**

| 区域 | 实得尺寸 | 校验 |
| --- | --- | --- |
| 标题栏 | 1920×48 | 拖拽区 ≈ 1086px；**显示版本徽标**（≥1440） |
| 左实例栏 | 264×1032 | 可见 **24 行** ✅ |
| 主工作区 | 1232×1032（抽屉关） | 内容宽 min(1560, 1232) = 1232 − 48 = 1184 ⇒ 卡片网格 **3 列**（324×3 + 16×2 = 1004 ≤ 1184）✅ |
| 抽屉打开 | 主区 808，卡片 **2 列** ✅ | 两侧都不破版 |

### 6.4 抽屉的两种形态

| 形态 | 触发 | 宽度 | 背景 | 投影 | 边界 |
| --- | --- | --- | --- | --- | --- |
| **内联档** | `≥ 1280px` | 424px，挤压主区 | `--bg-surface` | **无**（判据 M：非浮层不得投影） | 左沿 1px `--border-subtle` |
| **浮层档** | `< 1280px` | `min(424px, 92vw)`，`position: fixed` | `--bg-surface` | `--shadow-s2` | 左沿 1px `--border`（比内联档强一档，因为它是浮层） |

两种形态的**开合动效同档**：`width var(--dur-3) var(--ease)`（220ms）；关闭时保留内容直到动画结束（修正 `shell.ts:277-285` 的瞬清）。

---

## 7. 可直接落地的 CSS 变量清单

> **用法**：§7.1 整块替换 `tokens.css` 的 `:root {...}`（第 7–148 行）中**新增/改值**的部分；§7.2 追加到 `:root` 末尾；§7.3 整块替换 `:root[data-theme="light"] {...}` 的**新增/改值**部分。
> **命名风格**：完全对齐现有 `--{域}-{角色}` 约定（`--bg-*` / `--text-*` / `--fs-*` / `--sp-*` / `--r-*` / `--shadow-*` / `--dur-*` / `--ease*` / `--z-*`），不引入第二套命名法。
> 标注 **沿用** 的条目请原样保留，不要重写。

### 7.1 深色（`:root` 默认）

```css
:root {
  color-scheme: dark;

  /* ══ 品牌与语义色 ═══════════════════════════════════════════════ */
  --accent: #4d8dff;                              /* 沿用 */
  --accent-hover: #6ba0ff;                        /* 沿用 */
  --accent-press: #3a76e0;                        /* 沿用 */
  --accent-ink: #0b1017;                          /* 新增：压在主按钮上的深色文字（对 --accent = 6.6:1） */
  --accent-softer: rgba(77, 141, 255, 0.08);      /* 沿用 */
  --accent-soft: rgba(77, 141, 255, 0.16);        /* 沿用 */
  --accent-border: rgba(77, 141, 255, 0.55);      /* 改值：.45 → .55（非文本 3:1） */
  --accent-contrast: #ffffff;                     /* 沿用 */
  --accent-text: #9dc0ff;                         /* 沿用 */

  --brand-a: #4d8dff;                             /* 新增：品牌渐变端点（取代 #7c5cff） */
  --brand-b: #2b5fd0;                             /* 新增 */

  --success: #35c98a;                             /* 沿用 */
  --success-soft: rgba(53, 201, 138, 0.14);       /* 沿用 */
  --success-border: rgba(53, 201, 138, 0.42);     /* 沿用 */
  --success-text: #6ee0ae;                        /* 沿用 */

  --warning: #f0a934;                             /* 沿用 */
  --warning-soft: rgba(240, 169, 52, 0.14);       /* 沿用 */
  --warning-border: rgba(240, 169, 52, 0.42);     /* 沿用 */
  --warning-text: #ffc670;                        /* 沿用 */

  --danger: #f2555a;                              /* 沿用 */
  --danger-hover: #ff6f74;                        /* 沿用 */
  --danger-press: #d84146;                        /* 沿用 */
  --danger-soft: rgba(242, 85, 90, 0.14);         /* 沿用 */
  --danger-border: rgba(242, 85, 90, 0.45);       /* 沿用 */
  --danger-text: #ff979b;                         /* 沿用 */

  --info: #4d8dff;                                /* 沿用 */
  --info-soft: rgba(77, 141, 255, 0.14);          /* 沿用 */
  --info-text: #9dc0ff;                           /* 沿用 */

  --neutral-soft: rgba(255, 255, 255, 0.07);      /* 沿用 */
  --neutral-text: #a9b8cc;                        /* 沿用 */

  /* ══ 实例状态色 ═════════════════════════════════════════════════ */
  --state-running: #35c98a;                       /* 沿用 */
  --state-starting: #f0a934;                      /* 沿用 */
  --state-stopping: #8296ae;                      /* 改值：去紫，改中性 */
  --state-stopped: #8296ae;                       /* 沿用 */
  --state-crashed: #f2555a;                       /* 沿用 */

  /* ══ Mica 与表面层级（新增） ════════════════════════════════════ */
  --material-fallback: #0b1017;                   /* 新增 = --bg-app，Mica 不支持时的底 */
  --mica-opacity: 0.8;                            /* 新增：Mica 可见度（文档/校验用） */
  --content-bg: rgba(11, 16, 23, 0.82);           /* 新增：主工作区表面 */
  --rail-bg: rgba(14, 20, 29, 0.88);              /* 新增：左实例栏表面（L 形的竖笔） */
  --titlebar-tint: rgba(10, 14, 20, 0.18);        /* 新增：仅标题栏叠加的浅色 tint（WCO 接缝收敛，见 §2.5） */
  --titlebar-surface: rgba(31, 37, 47, 0.9);      /* 新增：标题栏合成色 = --titlebar-tint 压 --rail-bg 的近似值 */
  /* --rail-solid-dark 由主进程持有：#10151d（WCO color），不写进 CSS */

  /* ══ 面板色阶梯 ═════════════════════════════════════════════════ */
  --bg-app: #0b1017;                              /* 改值：#090d13 → #0b1017（主进程底色同步） */
  --bg-surface: #131a25;                          /* 改值：#111a26 */
  --bg-surface-2: #192231;                        /* 改值：#16202e */
  --bg-elevated: #1d2839;                         /* 改值：#1a2636 */
  --bg-inset: #080c11;                            /* 改值：#0b1017 */
  --bg-hover: rgba(255, 255, 255, 0.05);          /* 沿用 */
  --bg-active: rgba(255, 255, 255, 0.09);         /* 沿用 */
  --bg-selected: rgba(77, 141, 255, 0.16);        /* 沿用 */
  --scrim: rgba(3, 6, 11, 0.66);                  /* 沿用 */
  --grid-line: rgba(255, 255, 255, 0.04);         /* 沿用 */

  /* ══ 描边 ═══════════════════════════════════════════════════════ */
  --border-subtle: rgba(255, 255, 255, 0.06);     /* 沿用 */
  --border: rgba(255, 255, 255, 0.1);             /* 沿用 */
  --border-strong: rgba(255, 255, 255, 0.18);     /* 沿用 */

  /* ══ 文本 ═══════════════════════════════════════════════════════ */
  --text-1: #e9eef7;                              /* 沿用 */
  --text-2: #a2b2c8;                              /* 沿用 */
  --text-3: #71839a;                              /* 沿用 */
  --text-disabled: #55647a;                       /* 沿用 */
  --text-on-accent: #ffffff;                      /* 沿用 */
  /* --wco-symbol 由主进程持有：#a2b2c8，不写进 CSS */
}
```

### 7.2 追加到 `:root` 末尾（排版 / 间距 / 圆角 / 阴影 / 动效 / 尺寸 / 层级）

```css
:root {
  /* ══ 字体 ═══════════════════════════════════════════════════════ */
  --font-ui: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei",
    system-ui, sans-serif;                        /* 改值：Segoe 优先 */
  --font-display: "Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI",
    "Microsoft YaHei UI", sans-serif;             /* 新增 */
  --font-mono: "Cascadia Mono", "JetBrains Mono", "Sarasa Mono SC", Consolas, "Courier New",
    monospace;                                    /* 沿用 */

  /* ══ 字号 / 行高 / 字重 ═════════════════════════════════════════ */
  --fs-titlebar: 14px;                            /* 新增：标题栏品牌名 + 菜单触发器 */
  --fs-xs: 11px;                                  /* 沿用 */
  --fs-sm: 12px;                                  /* 沿用 */
  --fs-md: 13px;                                  /* 沿用 */
  --fs-lg: 15px;                                  /* 沿用 */
  --fs-xl: 18px;                                  /* 沿用 */
  --fs-2xl: 22px;                                 /* 沿用 */
  --fs-3xl: 28px;                                 /* 沿用 */
  --lh-tight: 1.3;                                /* 沿用 */
  --lh-normal: 1.55;                              /* 沿用 */
  --lh-code: 1.65;                                /* 新增：等宽文本块 */
  --lh-chrome: 1;                                 /* 新增：标题栏/菜单单行 */
  --fw-regular: 400;                              /* 沿用 */
  --fw-medium: 500;                               /* 沿用 */
  --fw-semibold: 600;                             /* 沿用 */
  --fw-bold: 700;                                 /* 沿用（当前为死令牌，见 §10 待清理） */

  /* ══ 间距（4/8 梯度） ═══════════════════════════════════════════ */
  --sp-0: 0;                                      /* 沿用 */
  --sp-1: 4px;                                    /* 沿用 */
  --sp-2: 8px;                                    /* 沿用 */
  --sp-3: 12px;                                   /* 沿用 */
  --sp-4: 16px;                                   /* 沿用 */
  --sp-5: 20px;                                   /* 沿用 */
  --sp-6: 24px;                                   /* 沿用 */
  --sp-7: 28px;                                   /* 沿用 */
  --sp-8: 32px;                                   /* 沿用 */
  --sp-10: 40px;                                  /* 沿用 */
  --sp-12: 48px;                                  /* 沿用 */

  /* ══ 圆角（收敛四档 + full） ════════════════════════════════════ */
  --r-nav: 2px;                                   /* 新增：导航项/徽标/20px 标记 */
  --r-sm: 4px;                                    /* 沿用（扩大用途：菜单项、控件、卡片内件） */
  --r-md: 8px;                                    /* 沿用（扩大用途：按钮、卡片、菜单面板、模态） */
  --r-lg: 12px;                                   /* 沿用（扩大用途：卡片外框） */
  --r-full: 999px;                                /* 沿用 */
  /* --r-xl: 16px 与 --r-2xl: 20px 已停用，确认无引用后删除 */

  /* ══ 阴影 ═══════════════════════════════════════════════════════ */
  --shadow-s1: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 1px rgba(0, 0, 0, 0.2);        /* 沿用 --shadow-1 */
  --shadow-s2: 0 4px 14px rgba(0, 0, 0, 0.34), 0 1px 3px rgba(0, 0, 0, 0.24);      /* 沿用 --shadow-2 */
  --shadow-s3: 0 18px 52px rgba(0, 0, 0, 0.5), 0 6px 16px rgba(0, 0, 0, 0.34);     /* 沿用 --shadow-3 */
  --shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.04);                          /* 沿用 */
  --ring: 0 0 0 3px var(--accent-soft);                                            /* 沿用 */
  --ring-danger: 0 0 0 3px var(--danger-soft);                                     /* 沿用 */
  --ring-titlebar: inset 0 0 0 2px var(--accent);                                   /* 新增：标题栏内聚焦 */

  /* ══ 动效 ═══════════════════════════════════════════════════════ */
  --dur-fast: 100ms;                              /* 新增 */
  --dur-1: 120ms;                                 /* 沿用 */
  --dur-2: 160ms;                                 /* 沿用 */
  --dur-3: 220ms;                                 /* 沿用 */
  --dur-spin: 0.9s;                               /* 新增：确定性进度环周期 */
  --ease: cubic-bezier(0.22, 0.61, 0.36, 1);                    /* 沿用 */
  --ease-out-fluent: cubic-bezier(0.1, 0.9, 0.2, 1);            /* 新增：Fluent 标准减速曲线 */
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);                  /* 沿用 */
  /* --ease-spring 已停用（Fluent 无过冲），确认无引用后删除 */

  /* ══ 标题栏 / 菜单（新增） ══════════════════════════════════════ */
  --titlebar-h: 48px;                             /* 必须 === titleBarOverlay.height */
  --titlebar-pad-x: 12px;
  --titlebar-gap: 12px;
  --titlebar-drag-min: 160px;
  --titlebar-title-max: 40ch;
  --wco-w: 138px;                                 /* JS 覆盖，见 §2.7 */
  --menubar-h: 0px;                               /* 预留：独立行时为 36px */
  --menu-min-w: 220px;
  --menu-max-w: 340px;
  --menu-max-h: 480px;
  --menu-item-h: 32px;
  --menu-trigger-h: 28px;
  --menu-gap-y: 4px;
  --menu-gap-x: 2px;

  /* ══ 控件与条形尺寸（新增，消灭散落 px） ═══════════════════════ */
  --ctl-h-sm: 24px;
  --ctl-h-md: 32px;
  --ctl-h-lg: 40px;
  --ctl-h-badge: 20px;
  --nav-item-h: 36px;
  --bar-h-view: 44px;
  --bar-h-panel: 40px;
  --touch-min: 24px;
  --icon-badge: 12px;
  --icon-sm: 14px;
  --icon-slot: 16px;
  --icon-lg: 20px;
  --icon-mark: 14px;

  /* ══ 布局 ═══════════════════════════════════════════════════════ */
  --rail-w: 264px;                                /* 沿用 */
  --rail-w-narrow: 216px;                         /* 新增 */
  --rail-w-icon: 72px;                            /* 新增 */
  --drawer-w: 424px;                              /* 沿用 */
  --content-max: 1560px;                          /* 沿用 */
  --modal-w-sm: 432px;                            /* 新增（从字面量提为令牌） */
  --modal-w-md: 560px;                            /* 新增 */
  --modal-w-lg: 760px;                            /* 新增 */
  --modal-w-xl: 920px;                            /* 新增 */

  /* ══ 层级（沿用，不新增） ═══════════════════════════════════════ */
  --z-rail: 10;                                   /* 沿用 */
  --z-topbar: 20;                                 /* 沿用（现由 .titlebar 使用） */
  --z-drawer: 30;                                 /* 沿用 */
  --z-menu: 60;                                   /* 沿用 */
  --z-modal: 80;                                  /* 沿用 */
  --z-toast: 100;                                 /* 沿用 */
}
```

### 7.3 浅色（`:root[data-theme="light"]`）

```css
:root[data-theme="light"] {
  color-scheme: light;

  --accent: #2f6fdd;                              /* 沿用 */
  --accent-hover: #3d7ce8;                        /* 沿用（对白字 4.73:1 ✅） */
  --accent-press: #2559b8;                        /* 沿用 */
  --accent-ink: #ffffff;                          /* 新增：浅色主题主按钮用白字 */
  --accent-softer: rgba(47, 111, 221, 0.07);      /* 沿用 */
  --accent-soft: rgba(47, 111, 221, 0.14);        /* 沿用 */
  --accent-border: rgba(47, 111, 221, 0.55);      /* 改值：.42 → .55 */
  --accent-text: #2a63c9;                         /* 沿用 */

  --brand-a: #2f6fdd;                             /* 新增 */
  --brand-b: #1d4fae;                             /* 新增 */

  --success: #12a06a;                             /* 沿用 */
  --success-soft: rgba(18, 160, 106, 0.12);       /* 沿用 */
  --success-border: rgba(18, 160, 106, 0.4);      /* 沿用 */
  --success-text: #0d7d52;                        /* 沿用 */

  --warning: #c47f0a;                             /* 沿用 */
  --warning-soft: rgba(196, 127, 10, 0.13);       /* 沿用 */
  --warning-border: rgba(196, 127, 10, 0.4);      /* 沿用 */
  --warning-text: #9a6408;                        /* 沿用 */

  --danger: #dc3f45;                              /* 沿用 */
  --danger-hover: #e6555b;                        /* 沿用 */
  --danger-press: #bf3036;                        /* 沿用 */
  --danger-soft: rgba(220, 63, 69, 0.11);         /* 沿用 */
  --danger-border: rgba(220, 63, 69, 0.4);        /* 沿用 */
  --danger-text: #bd2f35;                         /* 沿用 */

  --info: #2f6fdd;                                /* 沿用 */
  --info-soft: rgba(47, 111, 221, 0.12);          /* 沿用 */
  --info-text: #2a63c9;                           /* 沿用 */

  --neutral-soft: rgba(15, 28, 48, 0.06);         /* 沿用 */
  --neutral-text: #52627a;                        /* 沿用 */

  --state-running: #12a06a;                       /* 沿用 */
  --state-starting: #c47f0a;                      /* 沿用 */
  --state-stopping: #6f8098;                      /* 改值：去紫，改中性（同 --state-stopped） */
  --state-stopped: #6f8098;                       /* 沿用 */
  --state-crashed: #dc3f45;                       /* 沿用 */

  --material-fallback: #f3f6fb;                   /* 新增 = --bg-app */
  --mica-opacity: 0.72;                           /* 新增 */
  --content-bg: rgba(243, 246, 251, 0.8);         /* 新增 */
  --rail-bg: rgba(252, 253, 255, 0.86);           /* 新增：左实例栏表面 */
  --titlebar-tint: rgba(255, 255, 255, 0.62);     /* 新增：仅标题栏叠加 */
  --titlebar-surface: rgba(250, 251, 254, 0.92);  /* 新增：标题栏合成色 */
  /* --rail-solid-light 由主进程持有：#fbfcfe（WCO color） */

  --bg-app: #f3f6fb;                              /* 改值：#f2f5fa */
  --bg-surface: #ffffff;                          /* 沿用 */
  --bg-surface-2: #f6f8fc;                        /* 改值：#f7f9fc */
  --bg-elevated: #ffffff;                         /* 沿用 */
  --bg-inset: #eef2f8;                            /* 改值：#eef2f7 */
  --bg-hover: rgba(15, 28, 48, 0.05);             /* 沿用 */
  --bg-active: rgba(15, 28, 48, 0.08);            /* 沿用 */
  --bg-selected: rgba(47, 111, 221, 0.12);        /* 沿用 */
  --scrim: rgba(24, 34, 50, 0.42);                /* 沿用 */
  --grid-line: rgba(15, 28, 48, 0.05);            /* 沿用 */

  --border-subtle: rgba(15, 28, 48, 0.07);        /* 沿用 */
  --border: rgba(15, 28, 48, 0.13);               /* 沿用 */
  --border-strong: rgba(15, 28, 48, 0.22);        /* 沿用 */

  --text-1: #131c29;                              /* 沿用 */
  --text-2: #4c5c73;                              /* 沿用 */
  --text-3: #6b7a90;                              /* 改值：#78889e → #6b7a90（对 #f3f6fb = 4.61:1 ✅） */
  --text-disabled: #9aa7b8;                       /* 沿用 */
  --text-on-accent: #ffffff;                      /* 沿用 */
  /* --wco-symbol 由主进程持有：#4c5c73 */

  --shadow-s1: 0 1px 2px rgba(20, 32, 52, 0.08), 0 1px 1px rgba(20, 32, 52, 0.05);  /* 沿用 --shadow-1 */
  --shadow-s2: 0 4px 14px rgba(20, 32, 52, 0.1), 0 1px 3px rgba(20, 32, 52, 0.07);  /* 沿用 --shadow-2 */
  --shadow-s3: 0 18px 52px rgba(20, 32, 52, 0.18), 0 6px 16px rgba(20, 32, 52, 0.1);/* 沿用 --shadow-3 */
  --shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.7);                            /* 沿用 */
}
```

### 7.4 主进程配套常量（**不在 CSS 里，但必须与 §7.1/§7.3 同源**）

| 常量 | 深色 | 浅色 | 对应 CSS 令牌 |
| --- | --- | --- | --- |
| `BACKGROUND[theme]` | `#0b1017` | `#f3f6fb` | `--bg-app` |
| `OVERLAY_COLOR[theme]` | `#10151d` | `#fbfcfe` | `--titlebar-surface` 压 `--material-fallback` 的合成色（收敛 WCO 竖缝，§2.5） |
| `OVERLAY_SYMBOL[theme]` | `#a2b2c8` | `#4c5c73` | `--text-2` |
| `OVERLAY_HEIGHT` | `48` | `48` | `--titlebar-h`（必须同值） |
| `TITLEBAR_TINT[theme]` | `rgba(10, 14, 20, 0.18)` | `rgba(255, 255, 255, 0.62)` | `--titlebar-tint` |
| `TITLEBAR_SURFACE[theme]` | `rgba(31, 37, 47, 0.90)` | `rgba(250, 251, 254, 0.92)` | `--titlebar-surface`（与 `OVERLAY_COLOR` 对表） |

---

## 8. 反例清单（**绝不能出现**）

> 分两组：**F 组**是本方案新增的窗口机制 / Mica 专属禁令；**G 组**是 Fluent 视觉纪律。通用反模式 A-01 ~ A-22 见 `ui-acceptance-criteria.md` §2（本文不重复编号，§10.3 给出需按 WCO 修订的条目）。

### 8.1 F 组：窗口机制与 Mica（每条都对应一次真实可复现的破版）

| 编号 | 反例 | 为什么绝不能出现 |
| --- | --- | --- |
| **F-01** | 标题栏或任何表面用 `backdrop-filter: blur()` 造「毛玻璃」 | Mica 是**窗口级**单一材质，由 DWM 绘制。再叠 CSS 模糊 = 两套材质叠加，滚动时性能塌陷，且模糊区与 WCO 不透明区形成硬边 |
| **F-02** | 标题栏填半透明色却**不加** `--titlebar-tint` | WCO `color` 只能取不透明色 ⇒ 在 x = 宽−138 处出现可见竖边（§2.5） |
| **F-03** | 标题栏用硬编码灰（`#1f1f1f` / `#2b2b2b` / `#101010`） | 中性灰与品牌蓝调深色**不在同一色系**；浅色主题下必然失配（同时命中 A-03） |
| **F-04** | 自绘最小化 / 最大化 / 关闭按钮 | WCO 已提供系统绘制按钮；自绘会得到 **6 个按钮**，并丢失 Snap Layouts、系统 hover 反馈与触摸板手势 |
| **F-05** | 自绘窗口圆角、窗口外描边或窗口阴影 | DWM 负责。**不要**为「补圆角」而开 `transparent: true`（会出现透明角黑洞） |
| **F-06** | `frame: false` 与 WCO 混用 | `frame: false` 会一并丢掉 DWM 圆角、阴影与边缘缩放；WCO 只需 `titleBarStyle: 'hidden'` |
| **F-07** | `titleBarOverlay.height` 与 `--titlebar-h` 不同值 | 按钮与标题栏内容错位、1px 下沿线与系统按钮底边不齐 |
| **F-08** | 主题切换只改 `document.documentElement.dataset.theme`，不同步主进程 | 标题栏按钮区仍是旧主题色 ⇒ **用户抱怨的「标题栏与主界面割裂」在新架构下原样复现** |
| **F-09** | 保留系统菜单栏（`autoHideMenuBar: false` + `Menu.setApplicationMenu`）同时启用自绘菜单 | 一屏两个菜单，字体系 / 间距系 / 交互系完全不同（命中 A-01，**P0**） |
| **F-10** | 拖拽区覆盖 x > 宽−138px 的右上角 | 鼠标呈「可拖动」而点击落在系统按钮上，语义错位。用 §2.3 的 `--wco-w` 把内容层收住 |
| **F-11** | `app-region: drag` 覆盖到窗口边缘或铺满全宽 | 吞掉左右边缘缩放手柄（命中 A-12） |
| **F-12** | 拖拽区内的可交互元素漏 `no-drag` | 点击被窗口拖动吞掉（命中 A-10，**P0**） |
| **F-13** | 打开菜单时加全屏遮罩 | 遮罩盖住标题栏 ⇒ hover 切换、Alt 切换、再次点击关闭**全部失效** |
| **F-14** | 为 Mica 不支持的系统另写一套「不透明配色」 | 半透明令牌叠在不透明 `--bg-app` 上本身就是正确的不透明配色；另写一套会产生两个色源（§4.9） |
| **F-15** | 窗口非聚焦时给整条标题栏换色 | WCO 按钮外观由系统控制、应用层改不了 ⇒ 一半变了、一半没变，比不变更割裂 |
| **F-16** | 用 `globalShortcut` 注册 `F5 / F11 / Ctrl+R` 等 | 系统级快捷键会在应用失焦时抢键。一律用窗口级 `before-input-event` |
| **F-17** | 在 WCO 区下方绘制任何 DOM 内容 | 该区域永远被系统覆盖并吞掉输入，画了也看不见，只会误导后续维护者 |

### 8.2 G 组：Fluent 视觉纪律

| 编号 | 反例 | 为什么绝不能出现 |
| --- | --- | --- |
| **G-01** | 按钮 / 菜单触发器使用 `linear-gradient` 背景 | Fluent（WinUI 3）按钮是**纯色**。现状 `.btn--primary`（`components.css:42`）与 `.btn--danger-solid`（`:80`）都是渐变 ⇒ 必改 |
| **G-02** | hover / active 使用 `translateY` / `scale` 位移 | Fluent 的悬浮反馈是「底色 + 边框变化」，不做位移。现状 `.inst-card:hover`（-3px）、`.pick-card:hover`（-2px）、`.emoji-btn:hover`（-1px）、`.swatch:hover`（-2px）、`.btn:active`（+1px）、`.segmented__item:active`（+1px）全部违规 |
| **G-03** | 使用 `--ease-spring` 这类过冲弹簧缓动 | Fluent 的 motion 是单调减速，**没有回弹**。现状 `.switch__track::after`（`components.css:546`）与 `.checkbox input::after`（`:483-494`）用它 ⇒ 必改 |
| **G-04** | 标题栏或任何非浮层元素挂投影 | 判据 M：投影是浮层专属。标题栏靠「底色 + 1px 下沿」表达层级 |
| **G-05** | 菜单项 6px 圆角而菜单面板 8px | 嵌套圆角必须递减：面板 8 − padding 4 = 项 **4**。现状 `.menu__item` 用 `--r-sm`(6)（`components.css:1240`）⇒ 不构成 8−4=4 |
| **G-06** | 「胶囊化一切」 | 圆角只有 2/4/8/12 四档 + `--r-full`（仅徽标、开关轨道、头像、进度条、状态点）。现状 `--r-xl`(16) 用于模态、`--r-2xl`(20) 用于空态块 ⇒ 必改 |
| **G-07** | 五颜六色的状态色（紫、青、粉…） | WinUI 3 只有蓝（accent）+ 绿/黄/红（语义）+ 中性。现状 `--state-stopping: #b07cf0`（紫）⇒ 改中性 `#8296ae` |
| **G-08** | 大面积危险色填充 | 危险色只出现在：危险按钮交互态、崩溃徽标、日志 stderr 侧条。**禁止**给卡片、横幅、整行铺危险色 |
| **G-09** | 靠字重变化表达选中态 | 会让文字宽度跳动。现状 `.tabs__item.is-active` 加 `font-weight`（`components.css:910`）⇒ 删 |
| **G-10** | 图标尺寸随手写（13 / 15 / 17px…） | 只允许 `{12, 14, 16, 18, 20}` + 空态 24/28/34。现状**10 个取值** ⇒ 必改 |
| **G-11** | emoji 充当界面图标 | 渲染尺寸与基线不受 CSS 完全控制，必然与 SVG 不齐。唯一例外：**实例头像内**（用户数据通道） |
| **G-12** | 同尺寸混用实心与描边图标 | 视觉重量不一致。`.play` / `.stop` / `.more` 是实心（`icons.ts:14,15,67`）。**规则**：只保留「实心播放 / 停止」这一组例外，且必须成对出现、不与描边动作混排 |
| **G-13** | 4px 网格外的间距（`gap: 5px`/`6px`，`padding: 7px`/`9px`/`18px`） | 破坏视觉节奏，是「未查令牌」的信号。现状 **23 处** ⇒ 全部归位（§9） |
| **G-14** | 出现第 5 级字重 | 字重层级 ≤ 4 级（400/500/600/700）且每级对应唯一语义角色。现状 `--fw-bold` 是死令牌（有定义无使用）⇒ 待清理 |
| **G-15** | 三条横贯线并行：标题栏下沿 + 视图头下沿 + 页签下沿 | 判据 M-2：全窗口只允许 **1 条**横贯线。现状 `layout.css:23`、`layout.css:295`、`layout.css:339`、`components.css:899` 四处并存 ⇒ 必改 |
| **G-16** | 焦点环出现第三种写法 | 只允许 `outline: 2px solid var(--accent); outline-offset: 2px`（内容区）与 `offset: -2px`（标题栏 / 菜单内）；需贴边时用 `--ring` |
| **G-17** | 同类元素侧条不同粗 | `.toast` 语义侧条 3px（`components.css:1065`）vs `.logline--stderr` 2px（`:1534`）⇒ 统一 2px |
| **G-18** | 关闭类操作共用中性 hover | 业务删除 / 停止必须 `--danger-soft` 底 + `--danger-text`；模态 / 抽屉关闭用中性 `--bg-hover`（**不得**危险色）。两者强度必须分明 |
| **G-19** | 全屏遮罩转圈加载 | Fluent 用「内容区骨架 + 局部进度环」；全屏转圈在大屏上等于阻塞视线 |
| **G-20** | 抽屉关闭时瞬清内容 | 关闭必须与开启同档（`--dur-3`），内容保留到动画结束（现状 `shell.ts:277-285` 瞬清） |

---

## 9. 对现有代码的差距分析

> 全部基于**实读**文件与行号。格式：**位置 → 现状 → 目标 → 依据**。分级：**[必须]** = 本次改造验收项；**[应改]** = 体系性瑕疵；**[可延]** = 打磨项；**沿用** = 已符合 Fluent，不要动。

### 9.1 `tokens.css`（217 行）

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 1 | `:root` 全文 | 深色为默认 + `[data-theme="light"]` 覆盖 | **沿用**（机制正确，不要改结构） | 沿用 |
| 2 | `7-148` 命名风格 `--{域}-{角色}` | 一致清晰 | **沿用**；新增令牌严格沿用该风格（§7） | 沿用 |
| 3 | `10-42` 语义色三件套（`-soft`/`-border`/`-text` + hover/press） | 完整 | **沿用** | 沿用 |
| 4 | `52-62` 面板色六档 | 完整但偏暗 | **改值**：`#090d13/#0d131c/#111a26/#16202e/#1a2636/#0b1017` → `#0b1017/#131a25/#192231/#1d2839/#080c11`，并新增 `--content-bg` / `--rail-bg` / `--titlebar-tint` / `--titlebar-surface` / `--material-fallback` | [必须] |
| 5 | `65-67` 描边三档 | 完整 | **沿用** | 沿用 |
| 6 | `70-74` 文本四档 | 完整 | 深色**沿用**；浅色 `--text-3` **改值** `#78889e → #6b7a90`（对 `#f3f6fb` = 4.61:1） | [必须] |
| 7 | `77-78` `--font-ui` 以 `"Microsoft YaHei UI"` 开头 | 拉丁字母与数字也走雅黑字面 | **改值**：`"Segoe UI Variable Text", "Segoe UI"` 优先 | [应改] |
| 8 | `82-88` 字号七档 | 完整 | **沿用** + 新增 `--fs-titlebar: 14px` | 沿用 |
| 9 | `90-95` 行高两档 + 字重四级 | 完整 | **沿用** + 新增 `--lh-code: 1.65`、`--lh-chrome: 1` | 沿用 |
| 10 | `98-108` 间距梯度 | 完整 | **沿用** | 沿用 |
| 11 | `111-117` 圆角七档（含 `--r-xl` 16 / `--r-2xl` 20） | 档位偏多 | **收敛**：新增 `--r-nav: 2px`；`--r-xl` / `--r-2xl` 停用待删 | [应改] |
| 12 | `120-125` 阴影三级 + `--ring` | 完整 | **沿用**（保持三档语义，可改名 `--shadow-s1/s2/s3`） | 沿用 |
| 13 | `128-133` 动效三档 + 三条缓动 | 完整 | **沿用** + 新增 `--dur-fast`、`--dur-spin`、`--ease-out-fluent`；`--ease-spring` 停用 | [必须] |
| 14 | `136` `--topbar-h: 52px` | 52px | **改值/改名** → `--titlebar-h: 48px`，并补齐 §7.2 的标题栏与菜单尺寸组 | [必须] |
| 15 | `137-139` `--rail-w` / `--drawer-w` / `--content-max` | 完整 | **沿用** + 新增 `--rail-w-narrow` / `--rail-w-icon` | 沿用 |
| 16 | `142-147` 层级六档 | 完整，`--z-topbar: 20` | **沿用**（`.topbar` 改名 `.titlebar` 后 `--z-topbar` 继续服务它）；**不新增层级** | 沿用 |
| 17 | `16` `--accent-border: rgba(77,141,255,.45)` | 对 `--bg-app` 约 2.4:1 | **改值** `.55`（满足非文本 3:1） | [必须] |
| 18 | `17` `--accent-contrast: #ffffff` 压 `--accent` | 深色 3.20:1（AA 不达） | **新增 `--accent-ink`**：深色 `#0b1017`（对 `--accent` = 6.6:1）/ 浅色 `#ffffff` | [必须] |
| 19 | `153-159` 浅色强调色系 | `--accent-hover` 对白字 4.73:1 | **沿用**（已在 AA 内） | 沿用 |
| 20 | `191` 浅色 `--bg-app: #f2f5fa` | — | **改值** `#f3f6fb`（与主进程常量统一） | [可延] |
| 21 | `48` `--state-stopped: #8296ae` | 中性 | **沿用** | 沿用 |
| 22 | `47` `--state-stopping: #b07cf0` | 紫色，越出 Fluent 色板 | **改值** `#8296ae`（浅色 `#6f8098`） | [必须] |

### 9.2 `layout.css`（506 行）

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 23 | `6-12` `.shell` | `height: 100vh`，`background: var(--bg-app)` | **改**：背景改 `--material-fallback`（或透明让 Mica 透出），并为固定标题栏预留 `padding-top: var(--titlebar-h)` | [必须] |
| 24 | `15-26` `.topbar` | `height: var(--topbar-h)`(52)，`padding: 0 var(--sp-4)`，`background: var(--bg-rail)`，`border-bottom: 1px var(--border-subtle)`，`-webkit-app-region: drag` | **改**：改名 `.titlebar`；`height: var(--titlebar-h)`(48)；`position: fixed; inset: 0 0 auto 0`；`padding-left: var(--titlebar-pad-x)`；背景移交 `.titlebar__surface`；**容器本身不再声明 drag**（保住左右边缘缩放手柄） | [必须] |
| 25 | `28-33` `.topbar button/input/select/a { no-drag }` | 覆盖面不全（漏 `[role=menuitem]` / `[tabindex]`） | **改**：选择器扩为 `:is(button, input, select, textarea, a, [role="menuitem"], [tabindex])`，并 `app-region` 与 `-webkit-app-region` 双写 | [必须] |
| 26 | `35-41` `.brand` | `gap: var(--sp-3)`，`padding-right: var(--sp-3)` | **改**：`gap: var(--sp-2)`(8)（Fluent 紧凑 chrome） | [可延] |
| 27 | `43-53` `.brand__mark` | `30×30`，`--r-md`(8)，`linear-gradient(140deg, var(--accent) 0%, #7c5cff 100%)` | **改**：`20×20`，`--r-nav`(2px)，渐变端点 `var(--brand-a) → var(--brand-b)` | [必须] |
| 28 | `62-68` `.brand__name` | `--fs-lg`(15) | **改**：`--fs-titlebar`(14) | [必须] |
| 29 | `70-78` `.brand__ver` | `padding: 1px 6px`（6 不在梯度），无显示条件 | **改**：`padding: 1px var(--sp-2)`；新增「仅 ≥1440px 显示」 | [应改] |
| 30 | `80-88` `.topbar__spacer` / `.topbar__actions` | `gap: var(--sp-2)` | **改**：spacer 加 `app-region: drag` + `min-width: var(--titlebar-drag-min)`；actions 内按钮高度 32 → **28** | [必须] |
| 31 | `98-107` `.rail` | `background: var(--bg-rail)`，`border-right: 1px var(--border-subtle)` | **改**：背景 → `--rail-bg`；其余**沿用** | [必须] |
| 32 | `149-181` `.rail__item` | `padding: var(--sp-2)`，`--r-md`，`is-active` 用整圈 `border: 1px var(--accent-border)` | **改**：高度 `--nav-item-h`(36)，圆角 `--r-nav`(2px)；`is-active` 改为「底 `--bg-selected` + 左侧 2px `--accent` 指示条」 | [必须] |
| 33 | `183-194` `.rail__avatar` | `32×32`，`--r-md` | **改**：`24×24`，`--r-sm`(4) | [应改] |
| 34 | `236-247` `.rail__nav-btn` | `padding: var(--sp-2) var(--sp-3)`，`--r-md` | **改**：高度 `--nav-item-h`(36)，圆角 `--r-nav`(2px) | [应改] |
| 35 | `271-279` `.main` | `background: var(--bg-app)` | **改**：`background: var(--content-bg)` | [必须] |
| 36 | `289-297` `.view__head` | `padding: var(--sp-5) var(--sp-6) var(--sp-4)`，`border-bottom: 1px var(--border-subtle)`，`background: linear-gradient(...)` | **改**：高度 `--bar-h-view`(44)，内边距 `0 var(--sp-6)`；**删下边框**（M-2）**删渐变**（M-3） | [必须] |
| 37 | `336-341` `.view__tabs` | `border-bottom: 1px var(--border-subtle)` | **改**：**删下边框**（与 `.tabs__item` 的 2px 指示器叠成双线） | [必须] |
| 38 | `343-350` `.view__body` | `padding: var(--sp-6)` | **沿用** | 沿用 |
| 39 | `373-388` `.drawer` | `background: var(--bg-rail)` | **改**：背景 → `--bg-surface`；关闭时保留内容至动画结束 | [应改] |
| 40 | `398-406` `.drawer__head` | `height: 46px` | **改**：`height: var(--bar-h-panel)`(40) | [必须] |
| 41 | `435` `.toast-stack { top: calc(var(--topbar-h) + var(--sp-3)) }` | 依赖 `--topbar-h` | **改**：`var(--titlebar-h)`（改名后必须同步，否则 Toast 错位） | [必须] |
| 42 | `446-482` `@media (max-width: 1100px)` | 阈值 1100；抽屉改浮层；`top: var(--topbar-h)` | **改**：抽屉浮层阈值提到 **1280**（§6.3：1280 宽下抽屉挤压后主区仅 168px）；`--rail-w-narrow` 令牌化；`--topbar-h` → `--titlebar-h` | [必须] |
| 43 | `484-505` `@media (max-width: 820px)` | `.rail { width: 76px }` | **改**：阈值 **980**，宽度 `--rail-w-icon`(72)；隐藏清单**沿用** | [应改] |
| 44 | `426-431` `.overlay-host` | `position: fixed; inset: 0; pointer-events: none` | **沿用**（不给 `pointer-events: auto` 是正确的，避免吞掉标题栏交互） | 沿用 |

### 9.3 `components.css`（1773 行）

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 45 | `7-26` `.btn` | `height: 32px`，`padding: 0 12px`，`--r-md`(8)，`gap: 6px`（off-grid），含 `transform` 过渡 | **改**：`height: var(--ctl-h-md)`，`--r-sm`(4)，`gap: var(--sp-2)`，**删 `transform` 过渡** | [必须] |
| 46 | `28-35` `.btn:hover/active` | hover 换 `--bg-elevated`（与卡片同色 ⇒ 浮起错觉）；active `translateY(1px)` | **改**：hover `--bg-hover`；active 只换 `--bg-active`，**删位移** | [必须] |
| 47 | `37-39` `.btn:disabled` | `opacity: .45` | **沿用** | 沿用 |
| 48 | `41-55` `.btn--primary` | 渐变 `--accent-hover → --accent`，hover 渐变含字面量 `#86b2ff`；文字 `--text-on-accent`（深色 2.59–3.20:1） | **改**：纯色 `--accent` / `--accent-hover` / `--accent-press`；文字改 `--accent-ink` | [必须] |
| 49 | `79-87` `.btn--danger-solid` | 渐变含字面量 `#ff8186` | **改**：纯色 `--danger` / `--danger-hover` / `--danger-press` | [必须] |
| 50 | `101-107` `.btn--sm` | `height: 26px`，`padding: 0 9px`（9 off-grid） | **改**：`height: var(--ctl-h-sm)`(24)，`padding: 0 var(--sp-2)`(8) | [必须] |
| 51 | `109-113` `.btn--lg` | `height: 38px`，`padding: 0 18px`（18 off-grid） | **改**：`height: var(--ctl-h-lg)`(40)，`padding: 0 var(--sp-4)`(16) | [必须] |
| 52 | `115-122` `.btn--icon` | `width: 32px`；`.btn--icon.btn--sm { width: 26px }` | **改**：`min-width: var(--ctl-h-md)`；sm 档 `min-width: var(--ctl-h-sm)`；**新增** `.btn--icon-sm`(28px) 供标题栏 | [必须] |
| 53 | `128-133` `.btn__label { gap: 6px }` | off-grid | **改**：`gap: var(--sp-2)` | [应改] |
| 54 | `155-177` `.spinner` | `wl-spin 0.7s linear`（字面时长） | **改**：`var(--dur-spin)` | [可延] |
| 55 | `180-192` `.badge` | `gap: 5px`（off-grid），`padding: 0 8px` | **改**：`gap: var(--sp-1)`(4)，`padding: 0 var(--sp-2)`；新增运动态 16px 进度环 | [必须] |
| 56 | `230-234` `.badge--stopping` | 硬编码 `rgba(176,124,240,…)` + `#c9a6ff`（品牌紫系） | **改**：`--neutral-soft` / `--border-subtle` / `--neutral-text` | [必须] |
| 57 | `236-240` `.badge--lg` | `padding: 0 10px`（off-grid） | **改**：`padding: 0 var(--sp-3)`(12) | [应改] |
| 58 | `242-252` `.badge__dot--pulse` | `wl-pulse` 透明度闪烁 | **改**：运动状态改用确定性进度环；`wl-pulse` 只留给启动骨架 | [必须] |
| 59 | `254-268` `.chip` | `padding: 0 7px`（off-grid）；`--font-mono` 渲染中文标签 | **改**：`padding: 0 var(--sp-2)`；中文标签移除等宽字体 | [应改] |
| 60 | `283-288` `.field { gap: 6px }` | off-grid | **改**：`gap: var(--sp-2)` | [应改] |
| 61 | `303-325` `.field__hint/error/ok { gap: 5px }` | off-grid ×3 | **改**：`gap: var(--sp-1)` | [应改] |
| 62 | `327-341` `.input/.textarea/.select` | `height: 34px`，`padding: 0 10px`，`--r-md`(8) | **改**：`height: var(--ctl-h-md)`(32)，`padding: 0 var(--sp-3)`(12)，`--r-sm`(4) | [必须] |
| 63 | `343-350` `.textarea` | `padding: 8px 10px`（10 off-grid），`line-height: 1.6` | **改**：`padding: var(--sp-2) var(--sp-3)`，`line-height: var(--lh-code)` | [应改] |
| 64 | `363-370` `.input:focus` | `border-color: var(--accent)` + `--ring` + `--bg-app` | **沿用** | 沿用 |
| 65 | `395-399` `.select` | `padding-right: 30px`（off-grid） | **改**：`padding-right: var(--sp-8)`(32) | [可延] |
| 66 | `408-413` `.select-caret` | `right: 9px`（off-grid） | **改**：`right: var(--sp-2)`(8) | [可延] |
| 67 | `415-432` `.search > .input` | `padding-left: 31px`，`padding-right: 28px` | **改**：`var(--sp-8)` / `var(--sp-7)` | [可延] |
| 68 | `434-449` `.search__clear` | `22×22`，`right: 5px`（off-grid），**缺 focus-visible** | **改**：`24×24`，`right: var(--sp-1)`；补 focus-visible | [应改] |
| 69 | `452-507` `.checkbox` | `--r-xs`(4)，`border-strong`，`--ease-spring` 勾动画 | **改**：圆角**沿用**；缓动改 `--ease-out-fluent` + `--dur-fast` | [应改] |
| 70 | `510-547` `.switch` / `.switch__track` | 轨道 `36×20`，滑块 14，`--ease-spring`，位移 16px | **改**：轨道 `40×20`；`--ease-out-fluent` + `--dur-fast`；位移 18px；打开态滑块色 `--accent-ink` | [必须] |
| 71 | `581-625` `.segmented` | `gap: 6px`（off-grid），项高 28px | **改**：`gap: var(--sp-2)`；项高 `--ctl-h-sm`(24) / `--ctl-h-md`(32) | [应改] |
| 72 | `658-663` `.card` | `--r-lg`(12)，`--shadow-1` | **改**：`--r-md`(8)；**删投影**（判据 M：静态面靠底色 + 描边分层） | [必须] |
| 73 | `666-672` `.card__head` | `border-bottom: 1px var(--border-subtle)` | **改**：**删下边框**，改用内部间距分隔 | [必须] |
| 74 | `707-714` `.card__foot` | 上沿 solid | **沿用**（同时把 `.engine-card__foot` 的 dashed 统一过来） | 沿用 |
| 75 | `724-749` `.inst-card` / `::before` | `--r-lg`(12)，`padding-top: calc(var(--sp-4) + 3px)`，顶色条 `height: 3px` | **改**：顶色条 **2px**，`padding-top: calc(var(--sp-4) + 2px)` | [应改] |
| 76 | `751-760` `.inst-card:hover/active` | `translateY(-3px)` / `(-1px)` + `--shadow-2` | **改**：**删位移**；hover 只改底 `--bg-surface-2` + 边 `--border` + 阴影 `s1→s2` | [必须] |
| 77 | `762-766` `.inst-card:focus-visible` | `outline: none` + `box-shadow: var(--ring), var(--shadow-2)` | **沿用**（`overflow: hidden` 下用 ring 替代 outline，须在代码注释标注为特例） | 沿用 |
| 78 | `768-774` `.inst-card.is-running/is-crashed` | 边框换语义色 | **沿用** | 沿用 |
| 79 | `883-888` `.tabs` | `height: 44px` | **沿用**（用 `--bar-h-view` 令牌化） | 沿用 |
| 80 | `890-911` `.tabs__item` / `.is-active` | `padding: 0 var(--sp-4)`；选中态加 `font-weight: var(--fw-medium)` | **改**：内边距 `var(--sp-3)`；**删字重变化**（G-09，避免宽度跳动） | [必须] |
| 81 | `926-937` `.modal-backdrop` | `--scrim` + `backdrop-filter: blur(3px)` | **沿用**（遮罩是唯一允许模糊处） | 沿用 |
| 82 | `939-950` `.modal` | `--r-xl`(16)，`--bg-elevated`，`--shadow-3` | **改**：`--r-md`(8)（Fluent ContentDialog）；其余**沿用** | [必须] |
| 83 | `952-962` `.modal--sm/lg/xl` | 字面量 `432/760/920px` | **改**：`var(--modal-w-sm/lg/xl)` | [可延] |
| 84 | `972-1054` `.modal__head/body/foot` | — | **改**：脚部明确 56px 高 + 上沿 1px `--border-subtle` + 底 `--bg-surface` | [可延] |
| 85 | `1056-1075` `.toast` | 语义侧条 **3px**，`--shadow-3` | **改**：侧条 **2px**（与 `.logline` 统一，G-17）；阴影**沿用** | [应改] |
| 86 | `1133-1147` `.toast__close` | `24×24`，**缺 focus-visible** | 补 focus-visible | [应改] |
| 87 | `1217-1232` `.menu` | `min-width: 192px`，`max-width: 300px`，`gap: 1px`（off-grid），`--r-md`(8)，`--bg-elevated`，`--shadow-3` | **改**：宽度 `--menu-min-w`(220) / `--menu-max-w`(340)；**删 `gap`**；其余**沿用** | [必须] |
| 88 | `1234-1249` `.menu__item` | `padding: 7px var(--sp-3)`（7 off-grid ⇒ 推导高约 30px），`--r-sm`(6) | **改**：`height: var(--menu-item-h)`(32) + `padding: 0 var(--sp-3)`；`--r-sm`(4)（嵌套收敛 8−4=4） | [必须] |
| 89 | `1234-1261` `.menu__item` 状态 | 只有 hover + disabled | **改**：**新增 `:active`（`--bg-active`）** 与 **focus-visible（`--bg-hover` + 1px `--accent-border`）** | [必须] |
| 90 | `1255-1261` `.menu__item.is-danger` | `--danger-text` + hover `--danger-soft` | **沿用** | 沿用 |
| 91 | `1263-1268` `.menu__label` | `padding: 6px var(--sp-3) 2px`（6 off-grid） | **改**：`padding: var(--sp-1) var(--sp-3)` | [可延] |
| 92 | `1276-1281` `.menu__shortcut` | `--fs-xs` / `--font-mono` / `--text-3` / 右对齐 | **沿用** + 补与标签的最小间距 `var(--sp-6)` | 沿用 |
| 93 | `1284-1302` `.rows` / `.row-item` | 圆角 `--r-lg` | **改**：`--r-md`(8)；行高 `--nav-item-h`(36) | [应改] |
| 94 | `1371-1410` `.empty` | 插画块 `--r-2xl`(20) | **改**：`--r-lg`(12) | [应改] |
| 95 | `1420-1447` `.progress` | `height: 4px`，`--r-full` | **沿用** | 沿用 |
| 96 | `1449-1465` `.skeleton` | `margin: 5px 0`（off-grid）；`#7c5cff` 系流光 | **改**：`margin: var(--sp-1) 0`；流光改 `--bg-hover` | [应改] |
| 97 | `1523-1590` `.logline` | `line-height: 1.6`；语义侧条 2px | **改**：`line-height: var(--lh-code)`；侧条 2px **沿用** | [应改] |
| 98 | `1593-1614` `.logview__jump` | `height: 30px`（独立档），**缺 focus-visible** | **改**：`height: var(--ctl-h-md)`(32)；补 focus-visible | [应改] |
| 99 | `1616-1638` `.logview__empty` / `.logview__foot` | — | **沿用** | 沿用 |
| 100 | `1640-1690` `.yaml` | `line-height: 1.65`（两处） | **沿用**，改用 `--lh-code` 令牌 | [可延] |
| 101 | `1756-1769` `.copy-btn` | `24×24`，**缺 focus-visible** | 尺寸**沿用**；补 focus-visible | [应改] |

### 9.4 `views.css`（729 行）

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 102 | `6-16` `.inst-toolbar` / `__search` | `width: 300px`（字面量） | **改**：提为令牌或注释为刻意尺寸档 | [可延] |
| 103 | `24-33` `.view__count` | `padding: 1px 9px`（9 off-grid） | **改**：`padding: 1px var(--sp-2)` | [可延] |
| 104 | `162-168` `.editor-status` | `gap: 5px`（off-grid） | **改**：`gap: var(--sp-1)` | [应改] |
| 105 | `218-239` `.engine-card` | `--shadow-1` → hover `--shadow-2`（**无位移，正确**） | **沿用** | 沿用 |
| 106 | `263-270` `.engine-card__foot` | `border-top: 1px **dashed** var(--border-subtle)` | **改**：改 `solid`（与 `.card__foot` 统一） | [应改] |
| 107 | `272-277` `.engine-usage` | `gap: 5px`（off-grid） | **改**：`gap: var(--sp-1)` | [应改] |
| 108 | `279-292` `.console` | `line-height: 1.6` | **改**：`line-height: var(--lh-code)` | [应改] |
| 109 | `432-438` `.steps__dot` 激活态 | `linear-gradient(180deg, var(--accent-hover), var(--accent))` | **改**：纯色 `--accent` | [必须] |
| 110 | `457-464` `.emoji-grid` | `gap: 6px`（off-grid） | **改**：`gap: var(--sp-2)`（`padding: 2px` 为发丝级，保留） | [可延] |
| 111 | `466-493` `.emoji-btn` | `height: 38px`（独立档）；`font-size: 19px`；**缺 focus-visible** | **改**：高度 `var(--ctl-h-lg)`(40)；**补 focus-visible**；emoji 字号按用户内容通道登记豁免 | [应改] |
| 112 | `502-523` `.swatch` | `28×28`；hover `translateY(-2px)`；**缺 focus-visible / disabled** | **改**：**删位移**（改边框色 + ring）；补 focus-visible 与 disabled | [必须] |
| 113 | `525-533` `.color-input` | `46×28`；**缺 hover / focus-visible** | **改**：`height: var(--ctl-h-sm)`；补 hover 与 focus-visible | [应改] |
| 114 | `541-571` `.pick-card` | hover `translateY(-2px)` + `--shadow-2` | **改**：**删位移** | [必须] |
| 115 | `644-660` `.progress-steps__mark` | `font-size: 10px`（off-grid） | **改**：`--fs-xs`(11) | [应改] |
| 116 | `669-708` `.settings-stack` / `.settings-row` | 布局 | **沿用** | 沿用 |
| 117 | `451` `@media (max-width: 1080px)` | 一次性断点 | **改**：并入 §6.2 的 1100 / 980 断点 | [可延] |

### 9.5 `base.css`（303 行）

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 118 | `23-32` `body` | `background: var(--bg-app)` | **改**：`background: transparent`（让 Mica 透出）；由 `.shell` 承担 `--material-fallback` | [必须] |
| 119 | `83-86` `::selection` | `--accent-soft` 底 | **沿用** | 沿用 |
| 120 | `89-118` 滚动条 | `10px` 宽，thumb `--border-strong`，`background-clip: padding-box` | **改**：宽 **8px**；其余**沿用** | [应改] |
| 121 | `120-129` `:focus-visible` | `outline: 2px solid var(--accent); outline-offset: 2px` | **沿用**（唯一写法）；标题栏 / 菜单内改用 `-2px` 内缩 | 沿用 |
| 122 | `132-197` 关键帧 | 7 条 | **沿用** | 沿用 |
| 123 | `248-291` `.boot` | `radial-gradient` 底；标记渐变含 `#7c5cff`；白描边字面量 `rgba(255,255,255,.9)` | **改**：标记渐变端点 → `var(--brand-a)/var(--brand-b)`；启动屏渐变作为**唯一豁免**在代码注释登记理由 | [应改] |
| 124 | `294-303` `prefers-reduced-motion` | 全局降级 | **沿用**（正确用法，是最终兜底） | 沿用 |

### 9.6 `src/main/index.ts`

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 125 | `126-144` `new BrowserWindow({...})` | 系统原生边框；`autoHideMenuBar: false`；无 `titleBarStyle` / `titleBarOverlay` / `backgroundMaterial` | **改**：加 `titleBarStyle: 'hidden'`、`titleBarOverlay: { color, symbolColor, height: 48 }`、`backgroundMaterial`；`autoHideMenuBar: true`（过渡期）→ 删除 | [必须] |
| 126 | `31` `BACKGROUND_COLOR = '#0f1116'` | 与 `--bg-app: #090d13` 不一致 | **改**：`THEME_BG = { dark: '#0b1017', light: '#f3f6fb' }`，与 `tokens.css` 的 `--bg-app` 同源 | [必须] |
| 127 | `128` `minHeight: 680` | 680 | **改**：720（给 48 + 44 + 44 留余量） | [应改] |
| 128 | `155-157` `ready-to-show` | 先隐藏后显示 | **沿用**（防白闪） | 沿用 |
| 129 | `183-206` `guardWebContents` | 外链 / 新窗口 / webview 防护 | **改**：追加 `contents.on('before-input-event', …)` 重绑 §3.5 快捷键 | [必须] |
| 130 | `236-253` `placeholderPage` | 硬编码 `#0f1116` / `#1b1f2a` / `#e6e8ee` / `#9aa3b2` | **改**：取自 `THEME_BG` 与对应令牌，注释标注来源 | [应改] |
| 131 | `135-143` webPreferences | `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false` | **沿用**（WCO 不需要放宽任何安全项） | 沿用 |
| 132 | `160-175` 关闭前确认 | `runningCount()` 提示 | **沿用**（系统按钮点击同样触发 `close` 事件 ⇒ 该确认自动生效） | 沿用 |

### 9.7 `src/main/menu.ts`、`src/main/config.ts`

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 133 | `menu.ts:106` `Menu.setApplicationMenu(...)` | 系统原生菜单栏 | **改**：拆为 `menuSpec()`（纯数据）+ `runMenuCommand(id)`；自绘菜单通过键盘用例后 `setApplicationMenu(null)` | [必须] |
| 134 | `menu.ts:18-37` `showAbout()` | 原生 `dialog.showMessageBox` | **沿用** | 沿用 |
| 135 | `menu.ts:43-104` 菜单模板 | 5 顶级 / 23 项 | **沿用**（逐项等价迁移，不新增不删减） | 沿用 |
| 136 | `menu.ts:51,73-79` accelerator / role | 加速键由原生菜单提供 | **改**：accel 字符串同时驱动 `before-input-event` 与 `.menu__shortcut` 显示（单一定义，杜绝漂移） | [必须] |
| 137 | `config.ts:41,80-84,134` theme 持久化 | `'dark' \| 'light'` 已持久化 | **沿用**；**新增**：`setConfig` 成功后由 main 同步 `setBackgroundColor` + `setTitleBarOverlay`（§4.9） | [必须] |

### 9.8 渲染层文件

| # | 位置 | 现状 | 目标 | 级别 |
| --- | --- | --- | --- | --- |
| 138 | `index.html:27` `<header id="topbar" class="topbar">` | 单容器承载品牌 + 动作 | **改**：容器改名 `.titlebar`，内部拆 `.titlebar__surface` / `__content` / `__brand` / `__menubar` / `__spacer` / `__actions`（§2.2） | [必须] |
| 139 | `shell.ts:45-102` `renderTopbar()` | 品牌 + 演示徽标 + 日志 + 主题 + 新建 | **改**：拆为 `renderTitlebar()`（品牌 + 菜单区 + 拖拽区标题 + 2 个图标按钮）与视图头动作区（「新建实例」下沉、演示徽标移入视图头） | [必须] |
| 140 | `shell.ts:91` `icon('whale', 19)` | 19px（off-grid） | **改**：`--icon-mark`(14) | [必须] |
| 141 | `shell.ts:155-162` `railNavButton` 用 `icon(iconName, 16)` | 16 ✅ | **沿用** | 沿用 |
| 142 | `shell.ts:225-256` 右键菜单用 `openMenu()` | 复用 `.menu` 组件 | **沿用**（**必须与标题栏菜单是同一段 CSS**，不得另写一份） | 沿用 |
| 143 | `shell.ts:277-285` `renderDrawer()` 关闭时 `clear(drawer)` | 瞬清 | **改**：延迟到 `--dur-3` 动画结束后再清 | [应改] |
| 144 | `shell.ts:415-419` Esc 关抽屉 | 全局 Esc | **沿用**（优先级：模态 > 抽屉 > 菜单） | 沿用 |
| 145 | `components/menu.ts:35` `openMenu()` | Arrow / Esc / 外部点击 / 视口避让 / 焦点归还 | **沿用** + 新增 §3.4 的 6 项（Alt、左右键、Home/End、Tab、hover 切换、模态禁用） | [必须] |
| 146 | `components/menu.ts:61` 无图标占位 `width: '15px'` | 15px（off-grid） | **改**：`var(--icon-slot)`(16px) | [必须] |
| 147 | `components/menu.ts:108` `const gap = 6` | 6px（off-grid） | **改**：`var(--menu-gap-y)`(4px) | [必须] |
| 148 | `components/menu.ts:111` 视口留白 `8` | 8 ✅ | **沿用** | 沿用 |
| 149 | `components/ui.ts:40` `iconSize = size === 'sm' ? 14 : 15` | 15（off-grid） | **改**：`--icon-sm`(14) / `--icon-slot`(16) | [必须] |
| 150 | `components/ui.ts:113-126` `badge()` | 无进度环选项 | **改**：新增 `ring?: boolean`，运动状态渲染 16px 确定性进度环 | [必须] |
| 151 | `components/ui.ts:149-155` `statusBadge()` | `dot + pulse` | **改**：运动状态改进度环；静止态保留 6px 圆点 | [必须] |
| 152 | `components/ui.ts:167-169` `spinner()` | `wl-spin 0.7s`（CSS 侧 `components.css:161`） | **改**：周期走 `--dur-spin` | [可延] |
| 153 | `components/ui.ts:205-220` `switchControl()` | 36px 轨道语义 | CSS 侧改 40px 即可，工厂无需改 | [可延] |
| 154 | `components/modal.ts:64-69` `modal` 面板 | 尺寸档靠 class | **沿用**（CSS 侧换令牌） | 沿用 |
| 155 | `icons.ts:90-105` `icon()` | `stroke-width="1.8"` 固定 | **改**：按显示尺寸分档（14→1.5 / 16→1.8 / 20→2.1），见 §4.6 描边纪律 | [应改] |
| 156 | `icons.ts:11-12` `whale` | 24 网格手写路径 | **沿用** | 沿用 |
| 157 | `router.ts` 全文 | hash 路由 5 视图 | **沿用**（拖拽区标题从 `currentRoute()` 派生，无需改路由） | 沿用 |
| 158 | `index.ts:147-180` `installShortcuts()` | `Ctrl+1/2/3/4` | **沿用**；renderer 侧新增 `Alt` 类菜单快捷键（主进程 `before-input-event` 不处理的那些） | 沿用 |
| 159 | `data/store.ts:209-213` `applyTheme()` | 只改 `dataset.theme` | **改**：改完 dataset 后调主进程同步 `titleBarOverlay` + `backgroundColor`（§4.9、F-08） | [必须] |

### 9.9 契约与 IPC（增量）

| # | 文件 | 改动 | 关键约束 |
| --- | --- | --- | --- |
| 160 | `src/shared/contracts.ts` | `CH` 增补 `CH.window.setOverlay = 'window:setOverlay'`；`WhalesApi` 增补 `window.setOverlayTheme(theme)` | 通道名沿用 `域:动作` 现有风格 |
| 161 | `src/main/ipc.ts:30` `PUSH_ONLY_CHANNELS` | 若新增 push 通道（如最大化状态推送）需加入该集合 | **否则** `assertChannelCoverage()`（`ipc.ts:58-69`）会在启动时抛「契约通道未实现」 |
| 162 | `src/main/ipc.ts` `buildHandlers()` | 实现 `window:setOverlay`：`win.setTitleBarOverlay({ ...overlayColors(theme), height: 48 })` + `win.setBackgroundColor(themeBackground(theme))` | 本方案**不需要**窗口控制通道 |
| 163 | `src/preload/index.ts:51-115` | 按现有 `invoke()` 包装暴露 `window.setOverlayTheme` | 不暴露任何 event 对象（沿用现有安全约定） |

> **不需要新增的通道**：`window:minimize` / `window:toggleMaximize` / `window:close` —— WCO 下三按钮由系统绘制，渲染层**不需要**发起窗口控制。这是相比 v1 全自绘方案少掉的 3 个 IPC 通道与 3 个图标（`winMinimize` / `winMaximize` / `winRestore`）。

---

## 10. 落地顺序与验收对齐

### 10.1 建议实施顺序（每步都有独立可验的退出条件）

| 步骤 | 范围 | 退出条件（可截图 / 可命令验证） |
| --- | --- | --- |
| **S1 令牌层** | 只改 `tokens.css`（§7.1–§7.3）与 `base.css`（`body` 背景、滚动条） | `npm run build && npm start` 界面仍可渲染；`--topbar-h` 的所有引用点（`layout.css:16,435,453`）已改为 `--titlebar-h` 后无错位 |
| **S2 窗口层** | `main/index.ts`（`titleBarStyle` / `titleBarOverlay` / `backgroundMaterial` / `THEME_BG`）、`main/config.ts` 的 setConfig 后同步、`contracts.ts` + `ipc.ts` + `preload` 的 `window:setOverlay` | 窗口出现系统三按钮；拖动能拖；**最大化时三按钮贴屏幕右上角**；连续切换深/浅主题 5 次，标题栏按钮区颜色跟随变化（F-08 不出现） |
| **S3 标题栏层** | `index.html` 的 `#topbar` → `.titlebar` 结构、`shell.ts` 的 `renderTitlebar()`、新增 `renderer/titlebar.ts`（`--wco-w` 同步，§2.7） | 判据 **M-1**：y=2/24/46 三行取色无水平色缝；**WCO 竖缝不可见**（x = 宽−138 处无竖边） |
| **S4 菜单层** | `main/menu.ts` 拆 `menuSpec()` + `runMenuCommand()`、新增 `renderer/components/menubar.ts`、`menu.ts` 补 §3.4 的 6 项交互与面板尺寸参数 | 23 个菜单项逐项可达；`Alt` / `Alt+F` / 左右键 / Home-End / Esc / Tab / hover 切换全部通过；**此时才可** `setApplicationMenu(null)` |
| **S5 内容层** | `layout.css`（删渐变、删双线、改宽度）、`components.css`（§9.3 全部 [必须] 项）、`views.css`（§9.4 [必须] 项） | 判据 **M-2 / M-3 / M-4 / M-5** 全绿；`--r-xl` / `--r-2xl` / `--ease-spring` 确认为 0 引用后删除 |
| **S6 收口** | `icons.ts` 描边分档、`ui.ts` 进度环、`views.css` 缺 focus-visible 补齐、`shell.ts` 抽屉退场动画 | 图标尺寸取值集合 ⊆ `{12,14,16,18,20}`；`Select-String 'focus-visible'` 的覆盖率达 100%；`prefers-reduced-motion` 下无位移 |

### 10.2 取证命令（可复制执行，全部只读）

```powershell
# D1 —— 判据 M-3：渐残留扫描（排除 .boot 与品牌标记后应为 0）
Select-String -Path F:\WhalesLauncher\src\renderer\styles\*.css -Pattern 'linear-gradient|radial-gradient'

# D2 —— 判据 M-4：hover 位移扫描（应只剩 wl-pulse / 图形化字符相关）
Select-String -Path F:\WhalesLauncher\src\renderer\styles\*.css -Pattern 'translateY|translateX|scale\('

# D3 —— 旧令牌残留扫描（改完后应全部为 0）
Select-String -Path F:\WhalesLauncher\src\renderer\styles\*.css -Pattern '--topbar-h|--r-xl|--r-2xl|--ease-spring|#7c5cff|#86b2ff|#ff8186|#c9a6ff'
Select-String -Path F:\WhalesLauncher\src\renderer\styles\*.css -Pattern '--bg-rail'      # 应仅剩 0 处（已全部改 --rail-bg）

# D4 —— 间距孤值扫描（目标 ≤ 3 处，且均有注释说明）
$files = Get-ChildItem F:\WhalesLauncher\src\renderer\styles\*.css
$onGrid = @(1,2,3,4,8,12,16,20,24,28,32,40,48)
foreach ($prop in 'gap','padding','margin') {
  Select-String -Path $files -Pattern "^\s*$prop\s*:\s*[^;]*\d+px" |
    Where-Object { $_.Line -notmatch 'var\(--' } |
    ForEach-Object {
      $nums = [regex]::Matches($_.Line, '(?<![\w.])(\d+)px') |
              ForEach-Object { [int]$_.Groups[1].Value } | Where-Object { $onGrid -notcontains $_ }
      if ($nums) { "{0}:{1}: {2}" -f $_.Filename, $_.LineNumber, $_.Line.Trim() }
    }
}

# D5 —— 圆角梯度扫描（应 0 行 px 字面量，仅令牌）
Select-String -Path F:\WhalesLauncher\src\renderer\styles\*.css -Pattern '^\s*border-radius\s*:\s*\d+px'

# D6 —— WCO 三处同值校验（48 必须三处一致）
Select-String -Path F:\WhalesLauncher\src\main\*.ts -Pattern 'height:\s*48|titleBarOverlay|titleBarStyle|backgroundMaterial'
Select-String -Path F:\WhalesLauncher\src\renderer\styles\tokens.css -Pattern '--titlebar-h'

# D7 —— 主进程 / 令牌色值同源校验
Select-String -Path F:\WhalesLauncher\src\main\*.ts -Pattern '#[0-9a-fA-F]{6}'
Select-String -Path F:\WhalesLauncher\src\renderer\styles\tokens.css -Pattern '--bg-app|--rail-solid|--wco-symbol'

# D8 —— 图标尺寸集合（应 ⊆ {12,14,16,18,20} + 空态 24/28/34）
Get-ChildItem F:\WhalesLauncher\src\renderer -Recurse -File -Filter *.ts |
  Select-String -Pattern "icon\([^)]*,\s*(\d+)" |
  ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object { [int]$_ } -Unique
```

### 10.3 与既有验收标准的对齐（`ui-acceptance-criteria.md` 需同步的 4 处）

> 该文件是 v1 全自绘方案期间编写的，其中 **4 条口径与本方案直接冲突**。落地前必须同步修订，否则会出现「设计做对了但被验收判失败」：

| 条目 | v1 口径 | 按本方案修订为 |
| --- | --- | --- |
| **§5 W-01 ~ W-08 全部窗口用例** | 假设存在自绘的 3 个窗口控制按钮（`46×40`、关闭 hover 危险色、`outline-offset: -2px`、`winMaximize ↔ winRestore` 图标切换、拖拽区不外扩到边缘） | 三按钮由**系统绘制**，相应用例整体作废；替换为 §10.1 S2 的 4 条验收（系统按钮存在 / 拖动能拖 / 最大化贴边 / 主题切换后按钮区颜色跟随） |
| **§2 A-04** | 「关闭按钮 hover 不用危险色」判 **P0** | 应用层**无法控制**系统按钮 hover；该条改为「**不得自绘窗口按钮**」（即本文 F-04） |
| **§1.2 T2-1 阴影映射表** | 允许卡片挂 `--shadow-1` | 按判据 M：**非浮层不得挂投影**，卡片改用底色 + 描边；只有菜单 / 模态 / Toast 可用 `--shadow-s3` |
| **§1.3 S1-1** | 「标题栏必须复用 `--topbar-h`」；S1-2 白名单含 `6px`；S1-3 允许 `--r-sm(6)` | `--topbar-h` → **`--titlebar-h: 48px`**；间距白名单移除 `6px`；圆角白名单改为 `2 / 4 / 8 / 12 / full` |

**另需登记的两处新例外**（本方案引入，需写入验收标准的「已登记例外」清单）：

1. **WCO `color` 不与 CSS 令牌同源**：`titleBarOverlay.color` 由主进程持有（`#10151d` / `#fbfcfe`），无法从 CSS 读取。它**等于** `--titlebar-surface` 压 `--material-fallback` 的合成色，属「同一层的近似表示」，不是新色源。取证方式：D7 命令 + §7.4 常量表逐值比对。
2. **启动屏渐变豁免**：`.boot` 的 `radial-gradient`（`base.css:256`）与标记的 `linear-gradient`（`base.css:265`）保留渐变，理由为「启动瞬态画面不承载信息层级，且渐变能掩盖首帧抖动」；须在代码注释中登记。

### 10.4 本方案**未**覆盖的已知项（明确交付边界）

| 项 | 说明 |
| --- | --- |
| Win11 圆角与 Mica 在**虚拟机 / 远程桌面**下的表现 | `backgroundMaterial` 在 RDP 会话中可能不生效，按 §4.9 的 `'none'` 路径降级即可，无需专门设计 |
| 高对比度模式（`forced-colors`） | 未纳入本方案。建议后续补 `@media (forced-colors: active)` 覆盖，把所有 `background` 与 `border-color` 交给系统色 |
| 显示缩放 125% / 150% | 全部尺寸用 px（DIP），随系统缩放线性放大，无需额外设计；但 §4.6 的图标描边分档需在 150% 下复验一次视觉描边 |
| 多语言 | 界面仅中文。若未来加英文，`--fs-titlebar` 与菜单宽度需重算（`width: max-content` 已自动适配） |

---

## 结语：这套方案如何让标题栏 + 菜单栏 + 内容区真正统一

用户看到的那条「割裂」，根因是窗口里同时存在**三套**互不相干的视觉系统——Windows 绘制的标题栏、Windows 绘制的菜单栏、WhalesLauncher 自绘的深色内容区。本方案做的不是「把三者调得像一点」，而是**从结构上让三者不可能不同**：

**第一步是消灭第二条 chrome。** 菜单栏不再独占一行，而是**折进标题栏**——同一行、同一个 48px、同一个 `--rail-bg` 表面、同一套按钮状态表（菜单触发器与操作区的图标按钮在 normal / hover / active / focus 四态上逐值相同）。于是「标题栏」与「菜单栏」在代码里根本是同一个元素的两个分区，物理上无法出现两套配色、两套字体、两套节奏。

**第二步是让外壳与内容区只差一个深度。** 标题栏与左实例栏共用 `--rail-bg`，连成 L 形外壳；主工作区用 `--content-bg`。两者之间**只有 1 条 1px 的 `--border-subtle`**——全窗口也**只允许存在这 1 条**横贯线（判据 M-2）。层级不再靠阴影、渐变、位移去「表现」，而靠 Fluent 的面板色阶梯去「存在」：Mica 是底质，外壳半透明，内容面不透明，浮层最亮且是唯一挂投影的一层。这恰好就是 Windows 11 原生应用（设置、文件资源管理器、终端）的做法。

**第三步是把「系统绘制」这件事收进来而不是推出去。** 窗口三按钮交给 WCO 由系统绘制，因此**保留了 Snap Layouts、系统 hover 反馈、系统触摸板手势与 DWM 圆角阴影**——这些是「原生感」最容易被自绘方案牺牲掉的部分。代价仅是 WCO 区域必须是不透明色，而这个代价用一个 `--titlebar-tint`（深色 `rgba(10,14,20,.18)` / 浅色 `rgba(255,255,255,.62)`）就压到了 ΔRGB ≈ 2–3，竖缝不可见；再叠上「主题切换时主进程同步 `setTitleBarOverlay` + `setBackgroundColor`」这一步，就不会出现「内容区变浅了、标题栏按钮区还是深色」这种新割裂。

**最后是把 Fluent 的纪律写成可判定的数字。** 圆角收敛到 2 / 4 / 8 / 12（菜单面板 8 而菜单项 4，严格满足「子半径 = 父半径 − 内边距」）；控件高度收敛到 24 / 32 / 40；间距只走 4/8 梯度；状态反馈只用 Fluent 的 deque 减速曲线、**没有一处位移与回弹**；状态色只保留蓝（强调）+ 绿/黄/红（语义）+ 中性（去掉了不在 WinUI 3 色板内的紫色与品牌紫 `#7c5cff`）；Loading 用骨架与确定性进度环而不是全屏转圈。判据 M 与它的 6 条子判据可以用取色器和 8 条 PowerShell 命令逐条取证——**「标题栏、菜单栏、内容区视觉统一」这件事，从此不再是一句主观评价，而是一份可以打勾的清单。**

---

**UI 设计师**：UI 设计师（Agent）
**设计系统日期**：2026-09-19
**实施状态**：设计已定稿，可交付开发；建议按 §10.1 的 S1→S6 顺序落地，每步的退出条件可独立验收
**QA 流程**：§1.2 判据 M（6 条子判据）+ §8 反例清单 + §10.2 取证命令 + §10.3 验收口径修订
