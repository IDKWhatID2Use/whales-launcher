# WhalesLauncher 前端现状与关键需求清单（面向「迁移到 C# WinUI 3」的可行性勘查）

> 勘查方式：全部数字与结论由 read / grep / glob / pwsh 实读源码得出，未做任何推测。
> 统计口径：`[System.IO.File]::ReadAllLines(UTF8)` 计行（含空行与注释）。
> 勘查对象：`src/renderer/**`（渲染层）、`src/main/**`（主进程）、`src/preload/**`、`src/shared/**`（契约）、`src/core/**`（业务引擎）、`tests/**`、`scripts/**`、`docs/**`。

---

## 0. 总量速览（全部实测）

| 区域 | 文件数 | 行数 | 字节 |
|---|---|---|---|
| `src/renderer/*.ts` | 37 | **10 930** | 394 458 |
| `src/renderer/*.css` | 5 | **4 006** | 94 092 |
| `src/renderer/index.html` | 1 | 55 | 2 674 |
| `src/renderer` 合计 | 43 | **14 991** | 491 224 |
| `src/main/*.ts` | 9 | **2 602** | 101 242 |
| `src/core/*.ts` | 16 | **6 982** | 292 584 |
| `src/shared/*.ts` | 1 | **892** | 32 115 |
| `src/preload/*.ts` | 1 | 141 | 5 831 |
| `src` 合计（TS） | 64 | **21 547** | 826 230 |
| `tests/**/*.mjs` | 38 | 8 767 | 417 227 |
| `tests/**/*.cjs` | 3 | 809 | 27 838 |
| `scripts/**/*.mjs` | 6 | 2 396 | 98 003 |
| `scripts/**/*.cjs` | 1 | 259 | 12 099 |
| `scripts/**/*.ps1` | 1 | 168 | 7 057 |
| `docs/**/*.md` | 18 | 6 433 | 510 612 |

**渲染层三大子目录拆解（实测）**

| 目录 | 行数 |
|---|---|
| `src/renderer/views/` 含 `views/detail/` | 4 398（其中 `views/detail/` 1 375） |
| `src/renderer/components/` | 1 876 |
| `src/renderer/data/` | 2 321 |
| `src/renderer/util/` | 603 |
| `src/renderer/` 根（index/shell/titlebar/icons/router/context） | 1 732 |

**CSS 拆解（实测，非空行统计会低约 15%）**

| 文件 | 行数 | 职责 |
|---|---|---|
| `styles/tokens.css` | 323 | 设计令牌（深/浅两套）+ 主题切换 |
| `styles/base.css` | 355 | 重置、字体栈、滚动条、`.boot` 启动骨架、Mica 兜底、减少动效 |
| `styles/layout.css` | 661 | 外壳布局：标题栏 / 左实例栏 / 抽屉 / WCO 拼接 / 6 个断点 |
| `styles/components.css` | 1 931 | 控件与浮层：按钮、输入、卡片、徽标、菜单、模态、Toast、日志视图 |
| `styles/views.css` | 736 | 各视图专属样式 |
| 合计 | **4 006** | |

**产物形态（`dist/` 实测）**：`main/index.cjs` 451 KB + map、`preload/index.cjs` 5.3 KB + map、`renderer/index.js` 350 KB + map、`renderer/index.html` 2.7 KB、`renderer/styles/*.css` 5 个文件共 94 KB。

---

## 1. 技术栈与构建

### 结论
- **无任何 UI 框架**：无 React/Vue/Svelte/Angular，无虚拟 DOM，无第三方运行时依赖。渲染层是**手写原生 TypeScript + 手写 hyperscript 工厂函数 + 5 层手写 CSS**。
- **esbuild 是打包器（`--bundle`），不是转译器**；构建流程带 tsc 门禁与「暂存目录 + 原子替换」。
- **生产依赖只有两个**：`adm-zip`、`js-yaml`，都只在 `src/core` 里用（`package.json:26-29`），渲染层零运行时依赖。
- CSS 设计令牌化程度**极高**：非 `tokens.css` 文件里**硬编码颜色为 0 处**（实测扫描 `#hex` / `rgba(` 在 base/layout/components/views 中命中 0 行）。

### 证据

`package.json:26-37` —— 依赖清单：
```json
"dependencies": { "adm-zip": "^0.5.16", "js-yaml": "^4.1.0" },
"devDependencies": { "@types/node": "^22.10.2", "esbuild": "^0.24.2",
                     "electron": "41.1.0", "typescript": "^5.7.2" }
```

`scripts/build.mjs:60-99` —— 三个 target 都带 `--bundle`：
```js
{ label:'main',     args:['src/main/index.ts','--bundle','--platform=node','--format=cjs','--target=node22','--external:electron',...] },
{ label:'preload',  args:['src/preload/index.ts','--bundle','--platform=node','--format=cjs',...] },
{ label:'renderer', args:['src/renderer/index.ts','--bundle','--platform=browser','--format=iife','--target=chrome130',...] },
```
`scripts/build.mjs:167-189` 构建前强制 `tsc --noEmit`（理由写在注释里：esbuild 不做类型检查，曾发生「构建成功但产物引用未定义标识符」）；`scripts/build.mjs:147-164` `promoteStage()` 在全部产物就绪后才替换 `dist/`，失败保留旧产物。

`scripts/build.mjs:19-20` 明确记录了 **renderer 必须是 IIFE**：
```
 *   src/renderer/index.ts → dist/renderer/index.js  （界面，IIFE：
 *                            file:// 协议下 ESM 会被 CORS 拦截）
```

无框架证据 —— `src/renderer/util/dom.ts:1-31` 自述并有实现：
```ts
/**
 * `h()` 是一个极简的 hyperscript：无虚拟 DOM、无 diff，直接建真实节点。
 * 视图通过"重建局部子树"的方式更新，配合 rAF 批量调度保证性能。
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElProps|null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);   // ← 直接 createElement
```

`tsconfig.json:25-26` 只检查 `src/**/*.ts` 与 `scripts/**/*.mjs`；`tsconfig.json:3-13` 为 `target ES2023` + `strict` + `noUncheckedIndexedAccess`，`lib` 含 `DOM`。

CSS 分层（`index.html:26-30` 按此顺序加载，级联依赖明确）：
```html
<link rel="stylesheet" href="styles/tokens.css" />
<link rel="stylesheet" href="styles/base.css" />
<link rel="stylesheet" href="styles/layout.css" />
<link rel="stylesheet" href="styles/components.css" />
<link rel="stylesheet" href="styles/views.css" />
```

令牌规模：`tokens.css` 内共 **226 条变量声明**（含 `:root` 与 `:root[data-theme="light"]` 两套覆盖），**唯一变量名 164 个**；深色块 `tokens.css:12-239`，浅色块 `tokens.css:241-323`。分组覆盖：品牌/语义色、状态色、Mica 与表面层级、面板色阶梯、描边、文本、字体、字号/行高/字重、间距、圆角、阴影、动效、标题栏/菜单尺寸、控件尺寸、图形尺寸、布局、层级（`--z-rail`…`--z-toast`）。

---

## 2. 渲染层规模与结构

### 结论
5 个视图 + 4 个详情页签 + 7 个组件 + 6 个数据模块 + 7 个工具模块 + 6 个根文件；**全部是「工厂函数返回真实 DOM 元素」的同一套范式**，没有类组件、没有生命周期框架。

### 2.1 视图（`src/renderer/views/`，4 398 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `wizard.ts` | 896 | 创建实例向导：四步（名称与外观 → 引擎版本 → profile 模板 → 隔离策略）+ 右侧常驻摘要卡 + 提交进度；实例名做与 dsh 一致的前端校验 |
| `instances.ts` | 755 | 实例列表：卡片网格 + 搜索/状态筛选/4 种排序 + 空态引导；卡片的启动/停止/更多菜单/打开界面全部闭环；分「静态头部 + 动态区域」，搜索框保持稳定不丢焦点 |
| `detail/plugins.ts` | 696 | 实例详情·插件页：组合包开关 / 插件依赖 / 本地插件（zip、GitHub、文件夹）（三块内容） |
| `engines.ts` | 495 | 版本管理：本地已安装引擎（占用实例、体积、目录）+ 可安装版本列表；安装过程内嵌实时日志控制台；卸载前提示占用 |
| `detail.ts` | 434 | 实例详情外壳：头部（状态/运行信息/主要操作）+ 四个页签（插件·设置·存档·日志） |
| `global.ts` | 433 | 全局设置：主题、主 home 路径、npm registry、删除前二次确认开关、**Node 运行时**探测面板、运行模式与数据位置 |
| `detail/settings.ts` | 383 | 实例详情·设置页：`settings.yaml` 编辑器（行号槽、脏标记、重新载入、Ctrl+S）+ 共享冲突提示条 + 启动参数编辑 |
| `parts.ts` | 357 | 跨视图复用片段：模板目录、头像（渐变）、图标/配色选择器、隔离策略、metaChips |
| `isolation.ts` | 307 | 隔离策略：架构文档 §4.3 四维度（workspace/saves/settings/credentials）的唯一入口模型与切换动作 |
| `detail/saves.ts` | 204 | 实例详情·存档页：sessions/ × 工作文件夹构成"存档"，按 mtime 倒序，显示体积与 workspace 归属 |
| `detail/logs.ts` | 92 | 实例详情·日志页：复用 logview，加"打开日志目录""复制全部" |

### 2.2 组件（`src/renderer/components/`，1 876 行）

| 文件 | 行数 | 实现内容 |
|---|---|---|
| `ui.ts` | 562 | 原子控件集：`button`（6 变体 × 5 尺寸）、`iconButton`、`setBusy`（内联转圈）、`badge`（dot/ring/icon）、`chip`、`banner`、`emptyState`、`listEmpty`、`segmented`、`selectControl`、`statTile`、`statusBadge`、`spinner`、`avatar`、`stateLabel` 等 |
| `menubar.ts` | 353 | 应用内 Fluent 菜单栏（折进标题栏同一行）：**菜单结构不本地定义**，全部来自 `window.whales.app.menu()`；点击回传 `menuCommand(id)`；Alt 唤出、Alt+F/E/V/W/H 直达、←/→ 切组、↑/↓/Home/End 移动、Enter 触发、Esc/Tab 关闭；`document.execCommand(command)` 执行编辑命令（L262）；`MutationObserver` 监听触发器禁用态（L299） |
| `logview.ts` | 285 | 日志视图：等宽 + stdout/stderr/system 分色（色条 + 文字双通道）、自动滚动（仅当已在底部时跟随，上滚暂停并显示"回到底部"）、**增量渲染**（只追加新行，`MAX_RENDERED = 1500` 后批量裁剪旧行，L15）、流过滤、清空、行数统计、"较早日志已截断"提示 |
| `modal.ts` | 272 | 自建模态框（不用 alert/confirm/prompt）：Tab 焦点陷阱、Esc 关闭、Enter 提交主操作、关闭后归还焦点、支持多级堆叠且 Esc 只作用于最上层 |
| `menu.ts` | 209 | 下拉菜单（标题栏应用菜单与内容区右键菜单共用样式与交互）：↑/↓ 循环跳过 disabled、Home/End、Enter/Space 触发、Esc 关闭归还焦点、Tab 关闭、点击外部/窗口失焦/视口避让关闭；`window.innerWidth` 计算右边界（L183） |
| `toast.ts` | 103 | 轻提示：右上堆叠、自动消失、失败提示附可展开详情行便于复制错误原文 |
| `yaml-editor.ts` | 92 | YAML 编辑器：等宽 + 行号槽（与文本区滚动同步，L48）、Tab 输入两空格、Ctrl+S 保存、空内容/行尾空白等前端可判定问题就地标红 |

### 2.3 根文件（`src/renderer/*.ts`，1 732 行）

- **`shell.ts`（524）** 应用外壳：自绘标题栏（品牌 + 菜单 + 拖拽区 + 操作区）+ 左实例栏（搜索 + 实例项 + 底部导航/主题切换/演示徽标）+ 右日志抽屉（含来源实例下拉、"全部实例"聚合）。抽屉关闭时**保留内容到 220ms 收拢动画结束**再清空（L354-364，用 `tokenMs('--dur-3', 220)` 从 CSS 令牌读时长，避免魔法数）。`store.subscribe(() => refresh())` 一处订阅驱动整个外壳重绘（L488）。
- **`titlebar.ts`（90）** WCO 预留宽度同步：优先 `navigator.windowControlsOverlay.getTitleBarAreaRect()`，`geometrychange` + `resize` 重算，CSS 兜底 138px，无 WCO 时取 0（避免死区）；写入 `--wco-w`（L56）；窗口失焦态 `is-blurred`。
- **`icons.ts`（127）** **内联 SVG 图标集**（非图标字体、非 CDN）：`PATHS` 常量是静态 `<path>` 字符串，统一 24×24 视窗、1.8 描边、圆头圆角；`whaleMark` 为实心剪影（evenodd 挖空眼睛），其余为线性图标。
- **`router.ts`（103）** hash 路由，5 条路由。
- **`index.ts`（200）** 启动编排：`applyTheme('dark')` → `Promise.race([store.init(), 6s 超时])`（后端挂起也能出界面）→ `createShell` → `startClock()` → 注册 `onRouteChange` → `startRouter()` → 装应用快捷键 → 移除 `#boot` 骨架；全局 `error` / `unhandledrejection` 兜底成 toast（最多 3 条去重）。
- **`context.ts`（34）** `ViewContext`：视图只通过它拿 store / demo 标记 / navigate / 抽屉开关 / `refreshShell`，不直接触碰外壳 DOM。

---

## 3. 状态管理与数据流

### 结论
**手写单例 store，`get()` / `subscribe()` + 微批处理**；没有虚拟 DOM、没有响应式代理、没有状态库。更新策略是**「整体替换 state 对象 + 通知所有订阅者 + 各视图局部重建子树」**，不是整段 `innerHTML` 重建（`h()`/`replace()` 只替换被指定的容器）。

### 证据

`data/store.ts:49-83` —— 手写 store 骨架：
```ts
export class AppStore {
  private state: AppState = { ready:false, demo:false, ..., instances:[], runtimes:new Map(), conflicts:new Map(), ... };
  private readonly listeners = new Set<() => void>();
  private readonly notifyBatched = createBatcher(() => { for (const fn of this.listeners) fn(); });
  get(): Readonly<AppState> { return this.state; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private patch(partial: Partial<AppState>): void { this.state = { ...this.state, ...partial }; this.notifyBatched(); }
}
```
`data/store.ts:86-108` `init()`：探测后端 → 订阅 `onLog`/`onState` 推送（disposer 记账便于 dispose）→ 并发 `refreshConfig()` / `refreshInstances()` / `loadAppVersion()` → `ready = true`。
`data/store.ts:240-251` `saveConfig()`：**先乐观更新、失败回滚并弹错**。
`data/store.ts:254-261` `mergeRuntime()`：`Map` 拷贝 + `instances.map(...)` 局部替换（不可变更新）。
`util/batch.ts:3-13` 微批处理实现（`setTimeout(...,0)` 合并同一轮事件循环内的多次刷新）。

### 3.1 `data/api.ts`（223 行）—— IPC 封装
`data/api.ts:25-39` `backend()` **单次探测并缓存**；未检测到 `window.whales` 时切到内置演示后端并把原因写进 `reason`：
```ts
cached = { api: createDemoApi(), demo: true,
  reason: '未检测到 window.whales —— 后端（Electron 主进程 / preload）尚未就绪。当前展示内置演示数据，所有操作仅作用于内存。' };
```
`data/api.ts:60-84` `invoke()` / `subscribe()` 两道防御：接口缺失、同步抛错、Promise 拒绝都转成 `Result.ok === false`；订阅永远返回可调用的退订函数（缺失时返回 `() => undefined`）。`data/api.ts:86-222` `guard()` 把 `WhalesApi` 的 **37 个方法 + 2 个订阅**逐一包一层。这是**唯一**允许访问后端的入口。

### 3.2 `data/demo.ts`（1 541 行 / 59 KB）—— 为什么这么大
它实现了**完整的 `WhalesApi`（37 方法 + 2 订阅）的内存版**，用于「无后端也能独立预览界面」（`src/renderer/PREVIEW.md` §1 的明确设计目标）：
- `demo.ts:72-` 5 个演示实例的种子数据，覆盖**全部视觉状态**：运行中（16px 确定性进度环 + 计时器 + 界面地址）、已停止、已崩溃、目录缺失、引擎未安装；
- 启动/停止会推送**真实的状态变更与日志流**（含计时器与 URL 探测，`demo.ts:728` 构造 `LogChunk`）；
- 插件装卸、设置读写、版本安装、导入导出都有可见进度反馈；
- 提供与主进程 `menuSpec()` **同结构的菜单树**（5 组 / 23 项）；
- `demo.ts:56-70` 内建 8 条组合包中文说明文案。
**迁移含义**：这 1 541 行是**纯 UI 契约数据集**，不承载业务规则；WinUI 3 侧若要做无后端预览（设计器 / 设计稿校验），可整体丢弃或替换为 XAML 设计时数据。

### 3.3 其余数据模块
- `data/logs.ts`（147）：**日志环形缓冲**，按实例归集三路日志、固定容量、超限丢弃最旧行并记录丢弃数、订阅回调经微批处理合并（日志洪峰下每轮事件循环只通知一次）。
- `data/share-conflicts.ts`（85）：QR-15 共享设置冲突的渲染层接入——**能力探测 → 空值降级 → 统一 Result 处理**，后端未接线时明确标记 `conflictsAvailable=false`，界面不显示"无冲突"这类假保证。
- `data/summary-ext.ts`（31）：`InstanceSummary.problem` 的**运行时窄化读取**（IPC / 演示后端 / 桩可能给出空串、纯空白或类型不符的值，这里统一收敛）。

---

## 4. 路由与导航

### 结论
**纯 hash 路由**（`#/...`），状态机式解析，无第三方依赖；5 条路由 + 1 个详情页签参数；**没有独立返回栈**（依赖浏览器/Chromium 的 history），深链接可用（`file://.../index.html#/instance/<id>/plugins`——刷新与 Ctrl+R 都能恢复到该页面）。

### 证据

`router.ts:3-9` 路由模型：
```ts
export type RouteName = 'instances' | 'detail' | 'engines' | 'wizard' | 'settings';
export interface Route { name: RouteName; instanceId: string | null; tab: string; }
export const DETAIL_TABS = ['plugins','settings','saves','logs'] as const;
```
路由表（`router.ts:18-36` 解析、`router.ts:38-52` 生成）：

| hash | name | 参数 |
|---|---|---|
| `#/instances`（默认） | `instances` | — |
| `#/instance/<encodeURIComponent(id)>/<tab>` | `detail` | `instanceId` + `tab`（非法 tab 回落 `plugins`） |
| `#/engines` | `engines` | — |
| `#/create` | `wizard` | — |
| `#/settings` | `settings` | — |

参数传递：**实例 id 走 hash 路径段**，经 `encodeURIComponent` 编码（`shell.ts:289`、`index.ts:43`）；`instanceId` 非法/缺失时详情视图用空串兜底。
`router.ts:73-85` `startRouter()` 有一处**顺序敏感**的设计：URL 已带 hash 时（F5 / Ctrl+R）`hashchange` 不会再触发，必须主动 `notify()` —— 因此调用方**必须先** `onRouteChange(...)` 再 `startRouter()`（`index.ts:127-133` 的注释与顺序即为此）。
`router.ts:87-95` `navigate()` 支持 `{ replace }`（走 `location.replace`）。
`index.ts:56-66` `mount()`：`currentView.destroy()` → `createView(route)` → `replace(main, currentView.el)` → `main.scrollTop = 0`。**视图切换 = 销毁旧视图 + 挂载新 DOM 树**，无 keep-alive、无过渡动画。

---

## 5. IPC 契约与后端能力边界（迁移工作量估算核心）

### 5.1 `src/shared/contracts.ts`（892 行 / 32 KB）—— 冻结契约

导出内容分四类：

**(a) 基础类型与工具**（L13-31）：`SCHEMA_VERSION = 1`、`Result<T> = {ok:true;value:T} | {ok:false;error:string}`、`ok()` / `err()`、`ShareMode = 'local'|'shared'`、`CredentialsMode = 'inherit'|'local'`。

**(b) 领域模型**（L33-546）：`InstanceMeta`、`CreateInstanceInput`、`UpdateInstancePatch`、`InstanceState`（`stopped|starting|running|stopping|crashed`）、`InstanceRuntime`、`InstanceSummary`（含 `problem?: string` 降级呈现字段）、`EngineInfo`、`BundleEntry`、`PluginEntry`、`PluginInventory`、`PluginSource`（`archive|github|folder`）、`PluginSummary`、`PluginInstallResult`、`AllowBuildsError`（L279 自定义错误类，用于 pnpm `allowBuilds` 自动重试）、`SessionInfo`、`LaunchRequest`/`LaunchResult`、`LogChunk`、`PortSource`/`PortDecision`/`PortRecord`/`PortLedger`、`LauncherConfig`、`NodeRuntimeSource`/`NodeRuntimeCandidate`/`NodeRuntimeReport`、`PackManifest`/`ImportResult`、`ShareConflict`/`ShareConflictResolution`、`MenuNode`。

**(c) IPC 通道表 `CH`（L552-617）—— 实测 39 条通道**，按 9 组：

| 组 | 通道 |
|---|---|
| `launcher` (3) | `getConfig` `setConfig` `detectNode` |
| `instance` (8) | `list` `create` `get` `update` `remove` `launch` `stop` `openFolder` |
| `engine` (4) | `list` `available` `install` `remove` |
| `plugin` (9) | `inventory` `add` `remove` `setBundleEnabled` `install` `removeLocal` `listLocal` `pickArchive` `pickFolder` |
| `settings` (4) | `read` `write` `shareConflicts` `resolveShareConflict` |
| `saves` (2) | `list` `openFolder` |
| `pack` (3) | `export` `import` `pickFile` |
| `log` (2) | `chunk` `state` ← **唯二的 main → renderer 推送通道** |
| `app` (4) | `version` `openExternal` `menu` `menuCommand` |

**(d) `WhalesApi`（L623-693）**：7 个命名空间 / **37 个方法** + `onLog(cb)` / `onState(cb)` 两个订阅（返回退订函数）。

**(e) `CoreApi`（L767-889）**：**43 个方法**，是 main 调用 core 的形状（含 `fsx` / `paths` / `names` / `instance` / `engine` / `profile` / `plugins` / `launch` / `saves` / `modpack` 十组）；`LogSink = (stream, text) => void`（L732）是 core 的日志下沉口——**core 完全不碰 Electron**。

**事件/推送机制**：只有 `log:chunk`（`LogChunk`，含 `instanceId` / `stream` / `text` / `ts`）与 `log:state`（`InstanceRuntime` 全量快照）两条，均为**粗粒度全量推送**，无增量 diff、无 request/response 关联 id、无背压协商（背压在渲染层用微批处理吸收）。

### 5.2 `src/preload/index.ts`（141 行）

`preload/index.ts:12` 只 import `contextBridge, ipcRenderer`；`L141` 单行暴露：
```ts
contextBridge.exposeInMainWorld('whales', api);
```
**无 `ipcRenderer` 裸泄漏**（文件头 L1-11 明确列为硬性要求），页面拿不到任何 event 对象（`subscribe()` 在 L45-56 内部吞掉 `_event`）。通道名一律取自冻结契约 `CH`，杜绝通道名漂移。
⚠️ **实测发现一处轻微不一致**：`preload/index.ts:77` 的 `instance.openFolder` 参数类型写作 `'root'|'home'|'workspace'|'logs'`，**漏了 `'plugins'`**（契约 `contracts.ts:638` 有）；因 `WhalesApi` 是结构化类型且 TS 对函数参数是双变的，`tsc` 不报错，运行时 main 侧 `ipc.ts:452-459` 支持 `plugins`，功能正常。

### 5.3 `src/main/index.ts`（417 行）—— 窗口与生命周期

`index.ts:192-225` 窗口参数（**逐项与 UI 规范对齐**）：
```ts
width:1280, height:840, minWidth:1024, minHeight:720, show:false,
backgroundColor: themeBackground(theme),      // 防白闪，与 --bg-app 同源
icon: iconEntry(),                             // assets/whales.ico，缺失时不传
titleBarStyle: 'hidden',                       // 刻意不设 frame:false（会丢 DWM 圆角/阴影/缩放手柄）
titleBarOverlay: overlayOptions(theme),        // { color, symbolColor, height:48 }
backgroundMaterial: supportsMica() ? 'mica' : 'none',
autoHideMenuBar: true,
webPreferences: { preload, nodeIntegration:false, contextIsolation:true, sandbox:true,
                  webSecurity:true, spellcheck:false, devTools: devToolsEnabled() }
```
`index.ts:90-104` 生命周期：`app.requestSingleInstanceLock()` 单实例锁 + `second-instance` 聚焦既有窗口；`window-all-closed` 退出；`before-quit` 先 `stopAll(10s)` 再 `app.quit()`；`will-quit` 兜底 `forceKillLeftovers()`；`SIGINT`/`SIGTERM` 也走 `app.quit()`。
`index.ts:129` `Menu.setApplicationMenu(null)`（先摘原生菜单再建窗，避免闪一下系统菜单栏）。
`index.ts:276-304` `guardWebContents()`：`setWindowOpenHandler` 拒绝新窗并把 http(s) 交给 `shell.openExternal`；`will-navigate` 只允许 renderer 自身 URL；`will-attach-webview` 直接阻止；挂 `installShortcuts(win)`。
`index.ts:227-268` 建窗 + `ready-to-show` 再 show + 关闭前 `dialog.showMessageBoxSync` 提醒「仍有 N 个实例在运行」。
`index.ts:343-367` 界面未构建时给出**可读的兜底页面**（data: URL + 内联 CSS，主题同源）。

### 5.4 `src/main/ipc.ts`（743 行）—— 39 条通道的实现

`ipc.ts:43-59` `registerIpcHandlers()`：逐条 `ipcMain.handle`，统一 `ok(await handler(...))` / `err(describeError(error))`，**异常绝不穿透 IPC**。
`ipc.ts:61-73` `assertChannelCoverage()`：启动自检，契约里任何 invoke 通道缺实现即抛错（`PUSH_ONLY_CHANNELS` 排除 `log:chunk` / `log:state`）。
`ipc.ts:552-743` 参数校验层（渲染层传来的一律当"未知数据"）：`mustRecord` / `mustString` / `optionalString` / `mustBoolean` / `mustStringArray` / `mustPluginSource` / `mustShareMode` / `mustCredentialsMode` / `mustShareConflictResolution` / `parseCreateInput` / `parseUpdatePatch`（**严格白名单** `PATCH_KEYS`）/ `parseLaunchRequest`。

按功能分组的 **`WhalesApi` 完整方法清单（迁移工作量核心依据）**：

**① launcher（3）** — `getConfig` `setConfig`〔落库后同步 WCO 与窗口背景色〕 `detectNode(refresh?)`〔Node 运行时探测〕
**② instance（8）** — `list` `create`〔创建 profile + 目录 + 索引〕 `get` `update`〔白名单字段〕 `remove(id, deleteFiles)`〔运行中拒绝〕 `launch(req)`〔引擎存在性前置校验 → 端口分配 → 子进程 → 自动开浏览器〕 `stop(id)`〔按下 core 真实状态翻译成 Result 错误〕 `openFolder(id, which)`〔root/home/workspace/logs/plugins〕
**③ engine（4）** — `list` `available`〔npm view 查 registry〕 `install(version)`〔npm install + 实时日志〕 `remove(version)`〔被占用时拒绝〕
**④ plugin（9）** — `inventory` `add(spec)` `remove(name)` `setBundleEnabled(name, enabled)` `install(source)`〔zip/GitHub/folder〕 `removeLocal(name)` `listLocal` `pickArchive()`〔showOpenDialog zip〕 `pickFolder()`〔showOpenDialog 目录〕
**⑤ settings（4）** — `read` `write(yaml)` `shareConflicts` `resolveShareConflict(resolution)`〔use-local / use-shared，core 侧覆盖前写备份〕
**⑥ saves（2）** — `list` `openFolder(sessionId?)`
**⑦ pack（3）** — `export(instanceId)`〔showSaveDialog，默认落到 `app.getPath('downloads')`〕 `import()`〔showOpenDialog + 重装依赖〕 `pickFile()`
**⑧ app（4）** — `version` `openExternal(url)`〔仅 http/https〕 `menu()`〔`menuSpec()` 的 `MenuNode[]` 投影〕 `menuCommand(id)`
**⑨ 推送（2）** — `onLog(cb)` `onState(cb)`

### 5.5 `src/main/` 其余模块职责

| 文件 | 行数 | 职责 |
|---|---|---|
| `main/runtime.ts` | 349 | 子进程与日志流编排：窗口登记 `attachWindow`/`forEachWindow`、`send()` 向所有存活窗口推送、`logSink(instanceId)` 把 core 钩子包成广播、`launchHooks()`（onLog/onState/onExit + PID 记账）、`stopAll(10s)` 带超时并**复核 core 真实状态**、`forceKillLeftovers()` 退出兜底（含 PID 归属复核防误杀）、`terminateTree()` = `taskkill /T /F` → `child.kill('SIGKILL')` → `process.kill` |
| `main/config.ts` | 268 | `launcherRoot()`（`app.getAppPath()`，失败回退 cwd）+ 全局配置 `launcher.json` 读写；三条自愈路径（不存在→写默认值、schema 落后→就地升级、**损坏→改名备份 `launcher.json.bak-<毫秒>` 再以默认值继续**）；`withRoot()` 读时注入 `rootDir`、`persist()` 落盘时剥掉；待推送通知队列 `takePendingNotices()` |
| `main/theme.ts` | 130 | **窗口层唯一色源**：`TITLEBAR_HEIGHT = 48`（必须 === `--titlebar-h`）、`BACKGROUND` / `OVERLAY_COLOR` / `OVERLAY_SYMBOL` 深浅两套、`supportsMica()` = win32 且 `process.getSystemVersion()` build ≥ 22000、`applyThemeToWindow()`（`setBackgroundColor` + `setTitleBarOverlay`）、`applyThemeToAllWindows()` |
| `main/menu.ts` | 373 | **菜单唯一事实源**：`menuSpec()` 5 组 / 23 项（文件 5 · 编辑 6 · 视图 7 · 窗口 2 · 帮助 3）；`menuNodes(win)` 投影成契约 `MenuNode[]`（**刻意不含 `command` 与 `danger`**，只给 id）；`runMenuCommandById(id)` / `runMenuCommand(command)` 的 21 条命令实现（打开目录、reload、devtools、全屏、缩放、编辑动作、最小化/关闭、退出、帮助文档、关于 `dialog.showMessageBox`） |
| `main/shortcuts.ts` | 148 | 窗口级快捷键：从同一份 `menuSpec()` 的 `accelerator` 派生绑定（**杜绝菜单显示与真实绑定漂移**），跳过 6 个 Chromium 内建的编辑命令（否则 Ctrl+Z 撤销两次 = 没撤销），额外绑定 F12；用 `webContents.on('before-input-event')` 而非 `globalShortcut`（后者应用失焦会抢键） |
| `main/errors.ts` | 135 | 错误翻译层：`AppError`、`describeError()` 把错误码（ENOENT/EACCES/EPERM/ENOTEMPTY/EBUSY/ENOSPC/EEXIST/ETIMEDOUT/ENOTFOUND/EADDRINUSE/ERR_PNPM_NO_MATCHING_VERSION…）与正则特征（StartupError、pnpm 缺失、npm ERR、cache EPERM、desktop 保留名、junction 失败、spawn ENOENT）翻成中文处置建议，最多 2 条，单条上限 1200 字符 |
| `main/devtools.ts` | 39 | `devToolsEnabled()` = `WHALES_DEVTOOLS=1` 或 `--devtools`，**生产默认关闭**；`devToolsAutoOpen()` |

---

## 6. 核心业务能力（决定迁移范围）

### 6.1 `src/core/` 全模块一览（16 文件 / 6 982 行）

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `instance.ts` | 1 095 | 实例 CRUD + 四个共享维度落地（junction / 内容同步）+ **共享冲突登记与解决** + 实例索引 `registry.json` 与镜像 `.registry-mirror.json` 的降级呈现 |
| `plugin-packs.ts` | 1 312 | 「随实例搬运」的本地插件安装：zip 解压 / GitHub 依赖 / 文件夹 junction 三种来源，profile 依赖与 `dsh.profile.bundles` 登记，pnpm `allowBuilds` 自动重试 |
| `ports.ts` | 693 | 自动端口分配：区间 3080–3179、进程内预留集、OS 绑定探测、环形扫描、跨进程台账 `cache/ports.json`（含进程内串行锁）、EADDRINUSE 短 TTL 失败记录 |
| `launch.ts` | 545 | 实例启动与运行时状态：`DSH_HOME` 注入、端口决策、`--port` 原地改写、stdout/stderr 流式 + URL 探测、日志文件轮转（保留 10 份）、`stopInstance` 带超时且**绝不谎报已停止** |
| `proc.ts` | 528 | 子进程执行层：Windows 命令垫片解析（`.cmd` → `cmd.exe /d /s /c` + `windowsVerbatimArguments`）、管道优先 / **文件重定向降级**、`FileTail` 增量轮询、`killTree` 三段式、`isAlive` / `waitForExit` |
| `node-runtime.ts` | 406 | Node 运行时解析（5 级候选 + 实跑探针 + 版本门禁 + 缓存） |
| `engine.ts` | 405 | dsh 版本管理：`computeEngineSize`（mtime 缓存）、`listEngines`、`listAvailableEngines`（npm view）、`installEngine`、`removeEngine`、`resolveEngineBin`、`attachEngineFromLocal`（离线 junction 接入）、版本比较 |
| `fsx.ts` | 397 | 文件系统工具层：**原子写**（临时文件 + rename）、junction 安全增删、`dirSize` / `scanTree`（不跟随链接）、`mergeDirInto`、`resolveWriteTarget`（链接写入真实目标）、Windows EBUSY/EPERM 重试 |
| `modpack.ts` | 332 | 实例包（zip）导入导出：manifest 格式、**手工逐条目解压并校验路径拒绝 zip-slip**、导入时按 manifest 重装依赖 |
| `profile.ts` | 325 | profile 读写：`package.json`（`dsh.profile.bundles`）、`cordis.patch.yml`、`settings.yaml`；`setBundleEnabled`、`validateYaml`、各类备份 |
| `paths.ts` | 293 | 全部关键路径唯一定义处 + **子进程环境变量**（`npm_config_cache` / `npm_config_store_dir` / `CI=true` / `ELECTRON_SKIP_BINARY_DOWNLOAD`）+ npm/pnpm cache 参数 + pnpm store 推导 |
| `index.ts` | 233 | 统一入口：`CoreApi` 逐条实现 + `coreExtras`（共享冲突、离线接引擎、包元数据预览、Node 探测…）+ 命名空间再导出 |
| `plugins.ts` | 128 | 插件增删：**一律走 `dsh plugin --profile <p> …`**，不自己改 pnpm 状态；`pluginWhy` 诊断 |
| `runtime.ts` | 87 | 进程内运行时状态登记表（PID / url / port / 退出码） |
| `saves.ts` | 100 | 会话（存档）枚举 + `projectKey` 的**逐字符复刻**（`F:\WhalesLauncher` → `--F-WhalesLauncher--`） |
| `names.ts` | 103 | 命名校验与目录名派生（复刻 dsh `resolveProfileDir` 规则 + Windows 文件名字符与长路径约束） |

### 6.2 强平台特性 → 实现文件与关键函数（**迁移风险清单的核心**）

| 平台特性 | 实现位置 | 关键函数 |
|---|---|---|
| **子进程 spawn + 环境变量注入（DSH_HOME）** | `core/proc.ts` / `core/launch.ts` / `core/paths.ts` | `spawnStreaming()`（`proc.ts:169`）、`launchInstanceOnce()`（`launch.ts:116`，`launch.ts:221` 注入 `env: { DSH_HOME: paths.home, ...childBaseEnv(root) }`）、`childBaseEnv()`（`paths.ts:174`） |
| **日志流式读取（stdout/stderr 实时）** | `core/proc.ts`（管道 + `StringDecoder`）/ 降级 `FileTail` | `spawnWithPipes()`（`proc.ts:223`，`child.stdout.on('data')`）、`class FileTail`（`proc.ts:341`，300ms 轮询增量）、`createLogWriter()`（`launch.ts:431`，单写者串行队列 + 背压） |
| **端口探测与绑定预留** | `core/ports.ts` | `isPortFree()`（`ports.ts:263`，`net.createServer().listen({ port, host: LOOPBACK_HOST, exclusive: true })`——用内核判定而非 connect 试探）、`claimPort()` / `releaseClaim()`（进程内预留集）、`allocatePort()`（`ports.ts:455`）、`scanOrder()`（环形扫描）、`withLedgerLock()`（台账串行锁，`ports.ts:321`） |
| **junction 链接创建/解除** | `core/fsx.ts` / `core/instance.ts` / `core/engine.ts` / `core/plugin-packs.ts` | `replaceWithJunction()`（`fsx.ts:243`，`symlink(target, link, 'junction')`）、`removeLink()`（`fsx.ts:218`，先 `lstat` 确认是链接）、`ensureRealDir()`、`isOwnedSharedWorkspace()`（`instance.ts:411`）、`attachEngineFromLocal()`（`engine.ts:269`）、文件夹插件 junction（`plugin-packs.ts:635`） |
| **zip 导入导出** | `core/modpack.ts` + `core/plugin-packs.ts` | `exportPack()`（`modpack.ts:48`，`zip.writeZip`）、`importPack()`（`modpack.ts:104`，**手工 `extractEntries()` 拒绝绝对路径与 `..`**）、`readArchive()` / `extractArchive()`（`plugin-packs.ts:158/171`） |
| **npm registry 网络请求** | `core/engine.ts` + `core/plugins.ts`/`plugin-packs.ts` | `listAvailableEngines()`（`engine.ts:138`，`npm view @deepseek-ai/dsh versions --json --registry <r> --cache <dir>`）、`installEngine()`（`engine.ts:165`，`npm install … --save-exact --no-audit --no-fund`）、`runPluginCommand()`（`plugin-packs.ts:810/827`，`dsh plugin --profile <p> …`） |
| **文件原子写** | `core/fsx.ts` | `writeJsonAtomic()`（`fsx.ts:96`）、`writeTextAtomic()`（`fsx.ts:122`）、`writeFileAtomicRaw()`（`fsx.ts:131`）、`copyFileAtomic()`（`fsx.ts:179`） |
| **会话文件解析** | `core/saves.ts` | `workspaceKeyFor()`（`saves.ts:37`，逐字符复刻 dsh 的 `projectKey`：`/\:` 折叠成单个 `-`，`[A-Za-z0-9._-]` 保留，其余编 `~XXXX`，去头 `-`、截断 251、两端 `--`）、`listSessions()`（`saves.ts:69`，扫 `sessions/<key>/<id>/`）、`scanTree()`（`fsx.ts:311`） |
| **进程终止（Windows 进程树）** | `core/proc.ts` + `main/runtime.ts` | `killTree()`（`proc.ts:456`，**先 `taskkill /T` 再杀根**，注释解释为何顺序不可换）、`terminateTree()`（`runtime.ts:285`）、`forceKillLeftovers()` |

### 6.3 `core/node-runtime.ts` 的探测做法（406 行）

**5 级候选**（`node-runtime.ts:20-28` 注释即文档）：
1. `$WHALES_NODE_PATH`（显式覆盖） → 2. `launcher.json` 的 `nodePath`（界面可配） → 3. 启动器自身进程（dev 下 `node scripts/launch.mjs` 就是真 node） → 4. 系统 PATH 上的 `node.exe` → 5. 常见安装位置。

**探针**（`node-runtime.ts:46-53`）：**不做任何基于路径名的猜测**，每个候选实际执行一次
```
node -e "process.stdout.write('WHALES_NODE_PROBE:' + JSON.stringify({node: process.versions.node, electron: process.versions.electron ?? null}) + '\n')"
```
`PROBE_TIMEOUT_MS = 10_000`；只有「`electron === null`」且「主版本 ≥ `MIN_NODE_MAJOR = 20`」才合格。
**为什么必须这样**（`node-runtime.ts:5-19` 的真实缺陷复盘）：Electron 41 的运行时被 dsh 的 `node-addon-require-builtin` 原生模块按指纹白名单拒绝（`unsupported Electron runtime fingerprint: Node 24.14.0, V8 14.6.202.26-electron.0`），所以**dsh 必须由真正的 Node.js 执行**。`resolveNodeRuntime()`（L84）带缓存（key 含环境变量与显式配置），产出 `NodeRuntimeReport` 直接给界面展示"当前用哪个 node / 每个候选为何不可用"。

---

## 7. 测试与验证现状

### 结论
测试与验证**几乎全部集中在 `src/core` 与构建产物**，**渲染层没有自动化测试**（无 jsdom / happy-dom / playwright / puppeteer，测试文件里对 `renderer` 的引用全是文本级存在性检查或注释提及）。

### 7.1 `tests/` 结构（38 个 `.mjs` / 8 767 行 + 3 个 `.cjs` / 809 行）

**(a) `tests/core/` 单元与集成（19 文件）**
| 文件 | 行数 | 职责 |
|---|---|---|
| `plugin-packs.test.mjs` | 1 079 | 本地插件安装（zip/GitHub/folder）与 `__test` 纯函数 |
| `ports.test.mjs` | 590 | 端口分配、避让、台账并发、失败 TTL |
| `_helpers.mjs` | 456 | 临时根目录与替身工具 |
| `instance.test.mjs` | 333 | 实例 CRUD、共享模式、冲突登记 |
| `robustness-fixes.test.mjs` | 309 | 各轮修复的回归用例 |
| `degraded-records.test.mjs` | 272 | 坏记录降级呈现 + 「根→孙」进程树用例 |
| `modpack.test.mjs` | 234 | 导入导出与 zip-slip 防护 |
| `launch.test.mjs` | 226 | 启动、URL 探测、停止语义 |
| `node-runtime.test.mjs` | 172 / `profile.test.mjs` 171 / `fsx.test.mjs` 157 / `engine.test.mjs` 150 / `paths.test.mjs` 143 / `settings-share.test.mjs` 130 / `integration.dsh.test.mjs` 126 / `saves.test.mjs` 104 / `launch-real-dsh.test.mjs` 92 / `names.test.mjs` 69 / `run-all.mjs` 31 | 各模块单测 |

**(b) `tests/e2e/` 端到端（20 文件，含 `_bundle.mjs` / `_stub-engine.mjs` 基础设施）**：`30-robustness.mjs`(499)、`20-contract-and-dsh.mjs`(407)、`10-data-safety.mjs`(307)、`40-core-deep.mjs`(276)、`53-port-acceptance.mjs`(268)、`51-registry-review.mjs`(246)、`50-status-recheck.mjs`(230)、`52-broken-record-cleanup.mjs`(182)、`41-core-perf-log.mjs`(170)、`run-all.mjs`(137)、`42-config-heal.mjs`(133)、`43-resolve-command.mjs`(111)、`11-repro-settings-clobber.mjs`(98)、`44-cmd-invocation-matrix.mjs`(76)、`31-stop-probe.mjs`(70)、`32-stop-verify.mjs`(57)、`00-smoke.mjs`(35)。
`tests/e2e/_bundle.mjs:1-15` 解释了为何要先把 `src/core/**` esbuild 打成 ESM 单文件：`node --test` 会为每个文件 spawn 带管道的子进程（受限沙箱 EPERM），且 Node 26 的 strip-only 类型擦除不支持参数属性。

**(c) `tests/dist/` 产物验证（3 文件）**：`verify-dist.cjs`(311)、`qr08-check.cjs`(234)、`node-runtime-check.cjs`(222)。`verify-dist.cjs:1-14` 用**替身 electron** 直接 `require(dist/main/index.cjs)`，在 1 秒内抓住「构建通过但模块初始化就抛错」，并核对渲染层静态引用是否断链；`verify-dist.cjs:55-68` 连 `launcher.json` 的主题都要与 `main/config.ts` 默认值对齐。

**跑法**（`package.json:21-24`）：`npm run typecheck`（`tsc --noEmit`）、`npm test`（`node --test --test-isolation=none "tests/**/*.test.mjs"`）、`npm run test:core`；`tests/e2e/run-all.mjs` 与 `tests/core/run-all.mjs` 为自建 runner。

### 7.2 `scripts/`（8 文件）

| 文件 | 行数 | 用途 |
|---|---|---|
| `record/record.mjs` | 652 | 宣传片素材录制器：ffmpeg `ddagrab`（GPU 桌面复制，保住 Mica 观感）+ `h264_mf` 编码，R0–R10 共 11 个分镜清单，子进程一律 `stdio:'ignore'` 或文件重定向 |
| `launch.mjs` | 472 | 双击即用启动器：环境自检（electron.exe 是否到位，只做离线修复）→ 按 mtime 判断是否需重建 → 启动 Electron，stdout/stderr 直通、退出码透传、`--log-file` 落日志，保留最近 5 份 |
| `make-tutorial-shots.mjs` | 441 | **教程截图自动化**：无头 Chrome/Edge + **CDP** 驱动渲染层截图（`--remote-debugging-port=9333`、`Page.captureScreenshot`，L34/278/389/445） |
| `make-icon.mjs` | 358 | 生成 `assets/whales.ico` |
| `repair-session-zstd.cjs` | 241 | 会话 zstd 修复工具 |
| `build.mjs` | 221 | 构建（见 §1） |
| `make-shortcut.ps1` | 168 | 生成桌面快捷方式 |
| `setup-electron.mjs` | 97 | postinstall：离线准备 Electron |

### 7.3 `docs/`（18 个 `.md` / 6 433 行 + 27 张截图）

- **`docs/design/`（4）**：`ui-redesign.md`（1 737 行，Windows 11 Fluent 版视觉语言与 GUI 重设计方案，10 章 + 反例清单 F-01…F-16 + 差距分析 + 取证命令 D1–D8）、`ui-acceptance-criteria.md`（846）、`architecture.md`（322）、`port-allocation.md`（323）
- **`docs/guide/`（8）**：`README.md` `01-install.md` `02-quickstart.md` `03-instances.md` `04-engines-plugins.md` `05-settings-saves-logs.md` `06-isolation-sharing.md` `07-troubleshooting.md`
- **`docs/research/`（2）**：`dsh-interface.md`（258，dsh 接口勘察）、`pcl2-research.md`（475，PCL2 竞品研究）
- **`docs/review/`（3）**：`acceptance.md`（374）、`code-review.md`（303）、`final-status.md`（167）
- **`docs/video/`（1）**：`promo-plan-v1.md`（300）
- **`docs/assets/`**：4 张界面截图 + `tutorial/` 23 张教程截图
- **`src/renderer/PREVIEW.md`**（128 行）：渲染层说明与**偏离登记表**（明确登记了对设计的偏离及 Lead 批准状态）

---

## 8. 平台耦合点清单（迁移风险核心）

### 8.1 Electron / Web 专有能力的实际使用点（逐条给出处）

| # | 能力 | 文件:行 | 代码/说明 |
|---|---|---|---|
| 1 | **Window Controls Overlay（主进程）** | `main/index.ts:207-209`、`main/theme.ts:76-82` | `titleBarStyle:'hidden'` + `titleBarOverlay: { color, symbolColor, height: 48 }`；`theme.ts:108` `win.setTitleBarOverlay(...)` 随主题重设 |
| 2 | **WCO（渲染层 `windowControlsOverlay`）** | `renderer/titlebar.ts:39-63` | `navigator.windowControlsOverlay.getTitleBarAreaRect()` + `geometrychange` 事件；兜底 `WCO_FALLBACK = 138` |
| 3 | **`env(titlebar-area-*)`** | `styles/layout.css:42-47` | `calc(env(titlebar-area-x, 0px) + env(titlebar-area-width, 100%))` 作为内容层右边界上界 |
| 4 | **Mica（`backgroundMaterial`）** | `main/index.ts:210-211`、`main/index.ts:234-237`、`main/theme.ts:91-95` | `supportsMica() ? 'mica' : 'none'`；建窗失败降级重试；`getSystemVersion()` build ≥ 22000 判定 |
| 5 | **BrowserWindow 单实例** | `main/index.ts:90-97` | `app.requestSingleInstanceLock()` + `app.on('second-instance', focusMainWindow)` |
| 6 | **菜单加速键（原生菜单移除）** | `main/index.ts:129`、`main/menu.ts:41-119`、`main/shortcuts.ts:47-94` | `Menu.setApplicationMenu(null)`；23 条菜单项仍带 `accelerator` 文本；`before-input-event` 逐条重绑（**不用** `globalShortcut`） |
| 7 | **快捷键** | `main/shortcuts.ts:83-93`、`renderer/index.ts:154-192` | 主进程：F5/Ctrl+R/Ctrl+Shift+R/Ctrl+Shift+I/F12/F11/Ctrl+0/Ctrl+=/Ctrl+-；渲染层：Ctrl+1/2/3/4（导航）+ Ctrl+L（日志抽屉），两侧刻意不重叠 |
| 8 | **通知** | 无原生 `Notification` | 全部用自绘 toast（`components/toast.ts`）与自建模态（`components/modal.ts`）；系统级提醒只在窗口关闭时用 `dialog.showMessageBoxSync` |
| 9 | **`shell.openPath`** | `main/ipc.ts:488-492`、`main/menu.ts:343-350` | 打开实例/工作区/日志/插件/会话目录前先 `core.ensureDir` 自愈，失败回报原因 |
| 10 | **`shell.openExternal`** | `main/ipc.ts:523-536`、`main/ipc.ts:161-163`、`main/index.ts:279-294` | 仅允许 http/https；`instance.launch` 后按实例设置自动打开 web 界面；窗口外链导航也走它 |
| 11 | **对话框** | `main/ipc.ts:505-521`（`showSaveDialog` / `showOpenDialog` 包装）、`main/ipc.ts:291-391`（4 个 picker 用途）、`main/index.ts:257-267`、`main/menu.ts:353-373` | 插件 zip / 插件目录 / 实例包导入 / 通用 pickFile；实例包导出默认路径 `app.getPath('downloads')`；关闭前确认；关于对话框 |
| 12 | **`contextBridge`** | `preload/index.ts:12,141` | `contextBridge.exposeInMainWorld('whales', api)`，无 `ipcRenderer` 泄漏 |
| 13 | **`nodeIntegration` / 安全设置** | `main/index.ts:214-223` | `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、`spellcheck:false`、`devTools: devToolsEnabled()` |
| 14 | **CSP** | `renderer/index.html:18-21` | `default-src 'none'; script-src 'self' file:; style-src 'self' file: 'unsafe-inline'; img-src 'self' file: data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` —— **`connect-src 'none'` 意味着渲染层完全没有网络能力**（后端通信只走 contextBridge） |
| 15 | **CDP / 远程调试（截图脚本用）** | `scripts/make-tutorial-shots.mjs:34,278,389,445` | `--remote-debugging-port=9333` → `webSocketDebuggerUrl` → `Page.captureScreenshot` |
| 16 | **`session` / `webRequest`** | **未使用**（实测 grep 无命中） | 无代理、无拦截、无 Cookie 操作 |
| 17 | **`app.getPath`** | `main/ipc.ts:356` | 仅 `app.getPath('downloads')` 一处（实例包导出默认目录） |
| 18 | **窗口安全钩子** | `main/index.ts:279-298` | `setWindowOpenHandler`（拒绝新窗）、`will-navigate`（只放行 renderer 自身 URL）、`will-attach-webview`（直接阻止） |
| 19 | **进程事件** | `main/index.ts:136-147` | `render-process-gone` / `child-process-gone` 记录 |
| 20 | **`-webkit-app-region` 拖拽** | `styles/layout.css:58,63,68`、`base.css` | 品牌区与 spacer 声明 `drag`，交互元素显式 `no-drag`；双击最大化由系统内建提供 |

### 8.2 渲染层直接依赖、WinUI 3 无直接对应的浏览器 API

| 浏览器 API | 是否使用 | 使用点 | WinUI 3 对应 |
|---|---|---|---|
| `<canvas>` / `getContext` | **未使用**（0 命中） | — | — |
| `Intl.*` | **未使用**（0 命中） | 时间格式全部手写（`util/format.ts`） | —（手写逻辑可原样移植） |
| `localStorage` / `sessionStorage` | **未使用**（0 命中） | 主题/配置全走后端 `launcher.json` | 无需持久化层 |
| `fetch` / `XMLHttpRequest` | **未使用**（且被 CSP 封死） | — | — |
| `ResizeObserver` | **未使用** | 用 `window.addEventListener('resize')`（`titlebar.ts:62`） | `SizeChanged` 事件 |
| `MutationObserver` | **使用 1 处** | `components/menubar.ts:299`（监听触发器 `aria-disabled` 以同步菜单可用态） | 需改为显式状态绑定 |
| `requestAnimationFrame` | **使用 1 处** | `util/dom.ts:186-189` `nextFrame()`（带 `setTimeout` 兜底） | CompositionTarget.Rendering / DispatcherQueue |
| 剪贴板 API | **使用 2 条路径** | `util/dom.ts:159-183`：优先 `navigator.clipboard.writeText`（要求 `window.isSecureContext`），回退隐藏 `textarea` + `document.execCommand('copy')` | `Windows.ApplicationModel.DataTransfer.Clipboard`（**更简单**） |
| 拖放 API（dragstart/drop/dataTransfer） | **未使用** | 仅 CSS `app-region: drag` 用于窗口拖动 | 窗口拖动由系统标题栏提供 |
| `document.execCommand` | **2 处** | `util/dom.ts:177`（剪贴板回退）、`components/menubar.ts:262`（编辑命令 undo/cut/copy/paste/selectAll） | RichEditBox / TextBox 内建命令 |
| `getComputedStyle` | **1 处** | `util/dom.ts:196-205` `tokenMs()`：读 `--dur-*` 令牌转毫秒（保证 JS 动画收尾与 CSS 同源） | 需把时长做成共享常量 |
| `window.innerWidth` / `scrollTop` / `scrollHeight` | 多处 | `menu.ts:183`（菜单视口避让）、`logview.ts:203-207`（滚动跟随判定）、`yaml-editor.ts:48`（行号槽同步）、`engines.ts:422`、`index.ts:65` | 布局事件 + `ScrollViewer` |
| `Blob` / `URL.createObjectURL` | **未使用** | — | — |
| 动态 `import()` | **禁止**（`PREVIEW.md:41`） | 单文件 IIFE 产物 | — |
| `@media (prefers-reduced-motion/-transparency)` / `forced-colors` | **使用** | `base.css:346`、`components.css:1897,1909` | WinUI 3 需改用 `UISettings.AnimationsEnabled` / 高对比主题 |
| `backdrop-filter` | **使用 5 处** | `components.css:988,1003,1126,1306`（模态/菜单/Toast 面板）+ 兜底降级块 | WinUI 3 的 `AcrylicBrush` / `MicaBackdrop`（**更原生**） |

**结论**：渲染层对浏览器的依赖**非常浅**——没有 canvas、没有网络栈、没有 Web Storage、没有拖放、没有虚拟 DOM。真正带 Web 语义的只有 6 处：hash 路由、MutationObserver、rAF、剪贴板双路径、execCommand 编辑命令、`app-region` 拖拽。

---

## 9. 关键判断：渲染层有没有「与 UI 框架无关的业务逻辑层」？

### 结论
**有一层薄但真实的数据/工具层，但它没有被严格隔离**；`store.ts` 是唯一值得抽出的"半业务层"，而它**已经与 UI 耦合**（import 了 toast）。

### 证据（按依赖方向实测）

**① 完全 DOM-free 的模块（可直接搬进 C# 而几乎不用改逻辑）**
| 模块 | 行数 | 内容 |
|---|---|---|
| `data/api.ts` | 223 | `WhalesApi` 的守卫包装（37 方法），只依赖 `Result` 与 `describeError` |
| `data/demo.ts` | 1 541 | 完整内存后端（可丢弃或改造成 XAML 设计时数据） |
| `data/logs.ts` | 147 | 日志环形缓冲（纯数据结构 + 微批通知） |
| `data/summary-ext.ts` | 31 | `problem` 字段的运行时窄化 |
| `data/share-conflicts.ts` | 85 | 冲突能力探测与降级 |
| `util/format.ts` | 116 | 时间/体积/路径格式化（**手写，不用 Intl**） |
| `util/color.ts` | 96 | 强调色派生（hex→rgb、对比度、渐变端点） |
| `util/names.ts` | 51 | 命名校验（与 dsh 一致） |
| `util/batch.ts` | 13 | 微批处理 |

**② 与 UI 耦合、但耦合点很薄（抽出成本低）**
- `data/store.ts:9` `import { toastError, toastSuccess, toastWarning } from '../components/toast'` —— 状态层直接弹 toast（`store.ts:131,207,214,217,249`）。要抽成 UI 无关层，只需把 toast 换成「事件 / 通知集合」由视图层消费。
- `util/result.ts:8` 同样 import toast（`runAction()` 失败即弹提示）—— 但 `attempt()` / `describeError()` / `withTimeout()` / `errorOf()` **是纯的**，可原样搬。
- `util/clock.ts` 是「单定时器 + `querySelectorAll('[data-elapsed]')` 批量刷 DOM 文本」—— 逻辑是"每秒重算相对时间"，实现是 DOM 驱动，需重写为绑定。
- `util/dom.ts` / `icons.ts` / 全部 `components/` / `views/` 与 `shell.ts` / `titlebar.ts` / `router.ts` —— 纯 DOM 层，**不可迁移，只能重写**。

**③ 实测依赖矩阵（`import ... from` 静态扫描）**：`components/*` 里 6/7 个文件 import `util/dom` 与 `icons`；`views/*` 里 11/11 个文件 import `util/dom`（+ 多数 import `data/api` 与 `data/store`）；`data/api.ts` / `data/demo.ts` / `data/logs.ts` / `data/share-conflicts.ts` / `data/summary-ext.ts` **import 为空**（零 UI 依赖）。视图通过 `ViewContext`（`context.ts:5-19`）访问状态与导航，**不直接触碰外壳 DOM**——这个边界对迁移是有利的。

**④ 对迁移的直接含义**：把前端搬到 WinUI 3 时，`data/*`（除 demo 的种子数据）+ `util/format|color|names|batch` 合计约 **2 300 行**的逻辑可以**近乎逐行移植**（改语法不改算法）；`store.ts` 的 294 行需**去 toast 化**后移植；剩下约 **8 300 行**（components + views + shell + titlebar + icons + dom + router + clock + index）是必须用 XAML/C# 重写的表现层。

---

## 10. 迁移难度总表

| 前端模块 | 行数 | 职责 | 迁移到 WinUI 3 的难度 |
|---|---|---|---|
| `shared/contracts.ts` | 892 | 类型 + 39 条通道 + `WhalesApi`(37) + `CoreApi`(43) | **易** — 纯类型/常量，可机械转 C# `record`/`interface`；IPC 通道改为进程内接口调用 |
| `main/ipc.ts` | 743 | 39 条 handler + 参数校验 + 错误翻译接入 | **中** — 校验逻辑（`must*` / `parseCreateInput` / `parseUpdatePatch` 白名单）可逐条移植；IPC 层本身消失，改为 `CoreApi` 直调 |
| `renderer/data/demo.ts` | 1 541 | 无后端演示后端（37 方法内存实现） | **易/可丢弃** — 只是 UI 契约演示数据；若 XAML 设计时预览需要，改写成设计时数据源 |
| `renderer/views/wizard.ts` | 896 | 4 步向导 + 常驻摘要 + 提交进度 | **中** — 表单步骤机可做成 `NavigationView`+`Frame` 或分步 `Grid`；校验逻辑（`util/names`）可移植 |
| `renderer/views/instances.ts` | 755 | 卡片网格 + 搜索/筛选/排序 + 空态 | **中** — `GridView`+`ItemsRepeater` 表达力足够；需重做「静态头部 + 动态区域」的局部刷新为 `ObservableCollection` |
| `renderer/views/detail/plugins.ts` | 696 | 组合包 / 依赖 / 本地插件三块 | **中** — 表格化为主，`ListView`+`ContentDialog` 可覆盖 |
| `main/menu.ts` | 373 | 23 项菜单唯一事实源 + 21 条命令 | **易** — 直接换成 XAML `MenuBar`/`MenuFlyout` + `KeyboardAccelerator`，比现在更简单 |
| `renderer/views/engines.ts` | 495 | 版本管理 + 内嵌安装日志 | **中** — 日志内嵌 = `RichTextBlock`/`TextBox` 只读追加 |
| `renderer/views/detail.ts` | 434 | 详情外壳 + 4 页签 | **易/中** — `TabView` 或 `NavigationView` |
| `renderer/views/global.ts` | 433 | 全局设置 + Node 运行时面板 | **易** — 标准设置页控件 |
| `core/ports.ts` | 693 | 端口分配 + OS 绑定探测 + 台账 | **易** — `TcpListener` 绑定探测等价；台账串行锁可用 `SemaphoreSlim` |
| `renderer/views/detail/settings.ts` | 383 | settings.yaml 编辑器 + 冲突条 | **中/难** — 若要行号槽 + 语法着色，建议用 WinUI `RichEditBox` 或第三方（AvalonEdit 风格）；纯 `TextBox` 会丢体验 |
| `renderer/components/ui.ts` | 562 | 原子控件集（6 变体按钮 / 徽标 / 分段 / 磁贴 / 空态…） | **难** — 需为每类控件写 `Style`/`ControlTemplate`，工作量大但机械；WinUI 自带控件可覆盖约 70% |
| `renderer/shell.ts` | 524 | 自绘标题栏 + 左实例栏 + 右日志抽屉 | **中/难** — 标题栏改回原生（更简单），但「菜单折进标题栏同一行」的 Fluent 观感与 L 形外壳需用 `NavigationView`+自定义 TitleBar 重做 |
| `renderer/views/parts.ts` | 357 | 复用片段（头像渐变/图标选择器/隔离策略） | **中** — 渐变头像用 `LinearGradientBrush`；emoji 图标可直接显示 |
| `renderer/views/isolation.ts` | 307 | 4 维度隔离策略模型与切换 | **易** — 纯表单 + 说明文案 |
| `renderer/components/logview.ts` | 285 | 日志视图（分色 / 增量 / 跟随 / 截断） | **中** — 增量渲染 + `MAX_RENDERED=1500` 裁剪是必须复刻的关键点，否则日志洪峰会卡死 |
| `renderer/components/modal.ts` | 272 | 自建模态（焦点陷阱/多级堆叠） | **易** — `ContentDialog` 内建焦点管理与 Esc |
| `renderer/data/store.ts` | 294 | 手写单一状态源 + 乐观更新 + 冲突 | **易/中** — 去掉 toast 后为纯数据类，可改 `ObservableCollection`+`INotifyPropertyChanged` |
| `renderer/views/detail/saves.ts` | 204 | 存档列表 | **易** |
| `renderer/components/menu.ts` | 209 | 下拉菜单（含键盘全流程） | **易** — `MenuFlyout` 原生支持 |
| `renderer/views/detail/logs.ts` | 92 | 日志页（复用 logview） | **易** |
| `renderer/util/dom.ts` | 206 | hyperscript + 剪贴板 + 焦点 + rAF | **不可直接迁移** — `h()` 无对应物，整体丢弃；剪贴板改用 WinRT API |
| `renderer/data/api.ts` | 223 | 后端守卫包装 | **易** — 直调 core 后守卫层可大幅简化（无需防"preload 未就绪"） |
| `renderer/util/format.ts` | 116 | 时间/体积/路径格式化 | **易** — 逐行移植 |
| `renderer/util/color.ts` | 96 | 强调色派生 | **易** — 逐行移植 |
| `renderer/util/names.ts` | 51 | 命名校验 | **易** — 逐行移植 |
| `renderer/util/clock.ts` | 54 | 单定时器相对时间 | **易/中** — 逻辑保留，改为绑定刷新 |
| `renderer/util/result.ts` | 67 | Result 处理 | **易/中** — `attempt/describeError/withTimeout` 可移植，`runAction` 去 toast |
| `renderer/util/batch.ts` | 13 | 微批处理 | **易** — `DispatcherQueue.TryEnqueue` 合并 |
| `renderer/titlebar.ts` | 90 | WCO 宽度同步 | **不可直接迁移** — WinUI 3 无 WCO 概念，也不需要（原生标题栏） |
| `renderer/router.ts` | 103 | hash 路由 | **不可直接迁移** — 改 `Frame.Navigate` + 参数对象 |
| `renderer/icons.ts` | 127 | 内联 SVG 图标集 | **中** — SVG path 需转 `PathIcon`/`Geometry`（可用工具批量转换） |
| `renderer/index.ts` | 200 | 启动编排 + 全局错误兜底 + 键盘 | **易/中** — 编排逻辑保留，DOM 部分重写 |
| `renderer/context.ts` | 34 | 视图上下文接口 | **易** — 改为 DI 容器/接口 |
| `renderer/index.html` | 55 | 单页外壳 + CSP | **不可直接迁移** — 由 XAML `Window`/`App.xaml` 取代 |
| `styles/*.css`（5 个） | 4 006 | 164 个令牌的 Fluent 设计系统 | **中** — 令牌→`ResourceDictionary`（颜色/画刷/厚度/圆角/字号）映射直接；但 **4 000 行选择器规则必须重写为控件模板**，这是最大的一块纯体力工作 |

### 顶层结论（三句话）
1. **可复用**：`src/core/**`（6 982 行，纯 Node/TS、不依赖 Electron）+ `src/shared/contracts.ts` 的类型与通道语义 + 约 2 300 行 DOM-free 前端逻辑 —— 这是迁移的**最大资产**，因为 core 与主进程之间只有 `CoreApi` 一个 43 方法的接口边界。
2. **必须重写**：渲染层约 8 300 行表现层代码 + 4 006 行 CSS。由于**没有 UI 框架**，不存在「框架迁移」的额外负担；反过来也没有现成的 XAML 对应物可以自动转换，工作量接近**等量重写**，但每块都边界清晰、无隐藏依赖。
3. **风险最高**：① `components/ui.ts` 的控件集与 4 000 行 CSS 的 Fluent 观感还原；② `logview.ts` 的增量渲染与 1500 行裁剪；③ `detail/settings.ts` 的 YAML 编辑器体验；④ 从 **C# 进程内直调 core** 时，`core` 目前是 TypeScript —— 需要决定是「Node 子进程 + 本地 IPC（保留现有 39 通道契约）」还是「把 core 也重写成 C#」（后者意味着再迁移 6 982 行含 junction、`taskkill /T`、`.cmd` 垫片、`net` 绑定探测等 Windows 深度耦合逻辑）。
