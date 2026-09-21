/**
 * 应用菜单的契约投影 —— **等价搬运自旧主进程 `menu.ts` 的纯数据部分**。
 *
 * 为什么需要它：契约注释把菜单定义钉在"主进程为唯一事实源"上
 * （`src/shared/contracts.ts` 的 `MenuNode` 段：「菜单项的 id、label、accelerator 与实际
 * 按键绑定同源，渲染层的自绘菜单只是它的视图，不得自行维护第二份定义」），
 * 而 `CH.app.menu` / `app:menuCommand` 是契约里真实存在的两条通道。
 *
 * 搬运范围与边界（诚实说明）：
 *  - **搬运**：`menuSpec()`（menu.ts L41-L119，纯数据：id / label / accelerator /
 *    kind / command / danger）与 `menuNodes()` 的投影逻辑（menu.ts L142-L192），
 *    包括 `enabled` 的实时求值规则；
 *  - **内联**：`devToolsEnabled()` 逐条搬运到 `devtools.mjs`（判据只读 env/argv，
 *    与 Electron 无关），因此「DevTools 菜单项置灰」的判据与旧实现同源；
 *    不 import 旧目录 —— 旧主进程目录本轮整体拆除，桥接层不得再引用它。
 *  - **无法搬运**：`runMenuCommand()`（menu.ts L227-L322）的每一个分支都在操作
 *    Electron 的 `BrowserWindow`（reload / devtools / zoom / fullscreen / undo…），
 *    WinUI 3 侧必须由 C# 本地执行 —— 因此 `app:menuCommand` 在桥接层返回**明确错误**，
 *    由宿主按 `MenuNode.id` 映射到本地动作（见 `server.mjs` 的 `app:menuCommand`）。
 *  - **一处语义降级**：`view.fullscreen` 的动态标签（"全屏"/"退出全屏"）取决于窗口的
 *    全屏状态（menu.ts L189-L192），Node 侧看不到 C# 窗口状态，因此**返回基础标签
 *    「全屏」**，由宿主自行按窗口状态改写这一项。
 */
import { devToolsEnabled } from './devtools.mjs';

/** 视图/窗口类命令需要窗口才能执行（menu.ts L162）。 */
const WINDOW_SCOPED_COMMAND = /^(?:view|window)\./;

/**
 * 菜单结构（23 个可执行项 + 分隔线），逐项对齐 menu.ts L41-L119。
 *
 * `command` 字段刻意保留但不投影到 `MenuNode`：旧实现同样只把 `id` 交给渲染层
 * （menu.js L132-L136 的注释：「不把命令表暴露给渲染层」）。
 */
export function menuSpec() {
  return [
    {
      id: 'menu.file',
      label: '文件',
      children: [
        { id: 'file.openRoot', label: '打开启动器目录', command: 'file.openRoot' },
        { id: 'file.openInstances', label: '打开实例目录', command: 'file.openInstances' },
        { id: 'file.openEngines', label: '打开引擎目录', command: 'file.openEngines' },
        { id: 'file.sep1', label: '', kind: 'separator' },
        // F5 与 Ctrl+R 都要保留：原生菜单时代分别来自「刷新界面」的显式 accelerator
        // 与 `role:'reload'` 的默认加速键。
        { id: 'file.refresh', label: '刷新界面', accelerator: 'F5', command: 'view.reload' },
        { id: 'file.sep2', label: '', kind: 'separator' },
        // 退出：规范明确**不加**任何加速键（Windows 无 Ctrl+Q 习惯，且退出前有确认）。
        { id: 'file.quit', label: '退出', command: 'app.quit', danger: true },
      ],
    },
    {
      id: 'menu.edit',
      label: '编辑',
      children: [
        // 编辑动作的按键由宿主控件内建处理：accelerator 仅用于菜单**显示**，不得重绑。
        { id: 'edit.undo', label: '撤销', accelerator: 'Ctrl+Z', command: 'edit.undo' },
        { id: 'edit.redo', label: '重做', accelerator: 'Ctrl+Y', command: 'edit.redo' },
        { id: 'edit.sep1', label: '', kind: 'separator' },
        { id: 'edit.cut', label: '剪切', accelerator: 'Ctrl+X', command: 'edit.cut' },
        { id: 'edit.copy', label: '复制', accelerator: 'Ctrl+C', command: 'edit.copy' },
        { id: 'edit.paste', label: '粘贴', accelerator: 'Ctrl+V', command: 'edit.paste' },
        { id: 'edit.selectAll', label: '全选', accelerator: 'Ctrl+A', command: 'edit.selectAll' },
      ],
    },
    {
      id: 'menu.view',
      label: '视图',
      children: [
        { id: 'view.reload', label: '重新加载', accelerator: 'Ctrl+R', command: 'view.reload' },
        {
          id: 'view.forceReload',
          label: '强制重新加载',
          accelerator: 'Ctrl+Shift+R',
          command: 'view.forceReload',
        },
        {
          id: 'view.devtools',
          label: '开发者工具',
          accelerator: 'Ctrl+Shift+I',
          command: 'view.devtools',
        },
        { id: 'view.sep1', label: '', kind: 'separator' },
        { id: 'view.zoomReset', label: '实际大小', accelerator: 'Ctrl+0', command: 'view.zoomReset' },
        { id: 'view.zoomIn', label: '放大', accelerator: 'Ctrl+=', command: 'view.zoomIn' },
        { id: 'view.zoomOut', label: '缩小', accelerator: 'Ctrl+-', command: 'view.zoomOut' },
        { id: 'view.sep2', label: '', kind: 'separator' },
        { id: 'view.fullscreen', label: '全屏', accelerator: 'F11', command: 'view.fullscreen' },
      ],
    },
    {
      id: 'menu.window',
      label: '窗口',
      children: [
        { id: 'window.minimize', label: '最小化', command: 'window.minimize' },
        { id: 'window.close', label: '关闭', command: 'window.close' },
      ],
    },
    {
      id: 'menu.help',
      label: '帮助',
      children: [
        { id: 'help.docs', label: 'dsh 接口勘察文档', command: 'help.docs' },
        { id: 'help.architecture', label: '总体设计方案', command: 'help.architecture' },
        { id: 'help.sep1', label: '', kind: 'separator' },
        { id: 'help.about', label: '关于 WhalesLauncher', command: 'help.about' },
      ],
    },
  ];
}

/**
 * 投影为契约的 `MenuNode[]`（对应 menu.ts L142-L145 的 `menuNodes()`）。
 *
 * 与旧实现的唯一差异：`win` 固定视为"宿主窗口存在"—— WinUI 3 应用始终有主窗口，
 * 不存在 Electron 时代"所有窗口已关闭"的中间态，因此视图/窗口类命令恒为可用。
 * @returns {object[]} 可直接 JSON 序列化的菜单树。
 */
export function menuNodes() {
  return menuSpec().map((node) => projectNode(node));
}

/** 对应 menu.ts L164-L176 的 `projectNode()`。 */
function projectNode(node) {
  const projected = { id: node.id, label: dynamicLabel(node) };
  if (node.accelerator !== undefined) projected.accelerator = node.accelerator;
  if (node.kind !== undefined) projected.kind = node.kind;

  if (node.children !== undefined) {
    projected.children = node.children.map((child) => projectNode(child));
  } else if (node.command !== undefined) {
    // 只有真正可执行的菜单项才带 enabled；分隔线不带。
    projected.enabled = isCommandEnabled(node);
  }
  return projected;
}

/**
 * 对应 menu.ts L183-L187 的 `isCommandEnabled()`。
 */
function isCommandEnabled(node) {
  if (node.id === 'view.devtools' && !devToolsEnabled()) return false;
  if (node.command === undefined) return true;
  // 旧实现：`win !== null || !WINDOW_SCOPED_COMMAND.test(command)`（menu.ts L186）——
  // "没有可用窗口时置灰视图/窗口类命令"。桥接层对应的事实是**宿主窗口恒存在**
  // （WinUI 3 应用始终有主窗口），因此这里显式写出这个恒真条件，便于与旧实现逐字对照。
  const hasHostWindow = true;
  return hasHostWindow || !WINDOW_SCOPED_COMMAND.test(node.command);
}

/**
 * 对应 menu.ts L189-L192 的 `dynamicLabel()`。
 * 全屏项的状态相关标签由宿主改写（Node 看不到 C# 窗口的全屏状态）。
 */
function dynamicLabel(node) {
  return node.label;
}
