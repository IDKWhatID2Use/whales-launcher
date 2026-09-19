/**
 * 应用菜单的**唯一数据源**（规范 `docs/design/ui-redesign.md` §3.6：main 是唯一真相）。
 *
 * 形态变化（§2.1 / §3.5）：窗口改走 WCO 方案后，原生菜单栏必须移除 ——
 * `Menu.setApplicationMenu(null)`（反例 F-09 禁止原生菜单与自绘菜单并存），
 * 菜单视觉改由渲染层自绘。因此本模块不再构建原生 `Menu`，只保留两件事：
 *
 *   1. `menuSpec()` —— 结构 + 标签 + 加速键 + command id，纯数据、无副作用；
 *   2. `runMenuCommand()` —— 命令的本地实现（打开目录 / 视图动作 / 编辑动作 / 关于 / 退出）。
 *
 * `shortcuts.ts` 从同一份 `menuSpec()` 推导窗口级快捷键，所以
 * 「菜单里显示的快捷键文本」与「真实生效的快捷键」永远同源（§3.6 表格第 2 行）。
 * 渲染层自绘菜单通过冻结契约的 `app:menu` / `app:menuCommand` 两条通道接入：
 * `menuNodes()` 投影出 `MenuNode[]`，点击后回传 `MenuNode.id` 由 `runMenuCommandById()` 执行。
 */
import { BrowserWindow, app, dialog, shell } from 'electron';
import path from 'node:path';
import type { MenuNode } from '../shared/contracts.js';
import { launcherRoot } from './config.js';
import { devToolsEnabled } from './devtools.js';
import { AppError } from './errors.js';

/** 菜单项结构（规范 §3.6 `MenuSpec` 形状，逐字段对齐）。 */
export interface MenuSpec {
  id: string;
  label: string;
  /** 快捷键文本；同时驱动 `shortcuts.ts` 的匹配（编辑类命令除外，见 §3.5）。 */
  accelerator?: string;
  /** 命令 id，由 `runMenuCommand()` 执行。 */
  command?: string;
  kind?: 'separator' | 'header';
  enabled?: boolean;
  danger?: boolean;
  children?: MenuSpec[];
}

/**
 * 23 个菜单项，与改造前的原生菜单**逐项等价**（§3.6）。
 * 分组：文件 5 · 编辑 6 · 视图 7 · 窗口 2 · 帮助 3 = 23。
 */
export function menuSpec(): MenuSpec[] {
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
        // 与 `role:'reload'` 的默认加速键（规范 §3.5 两行都标 ✅）。
        { id: 'file.refresh', label: '刷新界面', accelerator: 'F5', command: 'view.reload' },
        { id: 'file.sep2', label: '', kind: 'separator' },
        // 退出：规范 §3.5 明确**不加**任何加速键（Windows 无 Ctrl+Q 习惯，
        // 且退出前有「仍有实例运行」确认，误触代价高），只保留菜单项。
        { id: 'file.quit', label: '退出', command: 'app.quit', danger: true },
      ],
    },
    {
      id: 'menu.edit',
      label: '编辑',
      children: [
        // 编辑动作的按键由 Chromium 内建处理：accelerator 仅用于菜单**显示**，
        // shortcuts.ts 会跳过这些 command，绝不重绑（否则 Ctrl+Z 会撤销两次 = 没撤销）。
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

/* ------------------------------------------------------------------ *
 * 契约投影：给渲染层自绘菜单用的 MenuNode 树
 * ------------------------------------------------------------------ */

/**
 * 把内部菜单结构投影为冻结契约的 `MenuNode[]`（纯数据、可序列化）。
 *
 * 设计意图（`CH.app.menu`）：主进程的 `menuSpec()` 是唯一事实源 —— 渲染层只负责把它
 * 渲染成自绘菜单，`accelerator` 直接作为菜单项右侧的快捷键文本，因此
 * 「菜单里显示的快捷键」不可能与 `shortcuts.ts` 的真实绑定漂移（规范 §3.6）。
 *
 * 与内部 `MenuSpec` 的两处刻意差异（契约有意为之）：
 *  - **不含 `command`**：渲染层只拿 `id`，点击后回传 `app:menuCommand(id)`，
 *    由 `runMenuCommandById()` 在主进程侧解析成命令，不把命令表暴露给渲染层；
 *  - **不含 `danger`**：契约未定义该字段，需要危险样式的项（如「退出」）由渲染层按 id 特判。
 *
 * 实时求值的两项：
 *  - `label`：全屏项在全屏状态下显示为「退出全屏」；
 *  - `enabled`：视图 / 窗口类命令在没有可用窗口时置 `false`（否则点了没反应）。
 *    注意**不按 `isFullScreen()` 禁用全屏项** —— 那会让用户无法从菜单退出全屏。
 */
export function menuNodes(win?: BrowserWindow | null): MenuNode[] {
  const target = resolveWindow(win);
  return menuSpec().map((node) => projectNode(node, target));
}

/**
 * 按菜单项 id 执行命令。
 * 渲染层回传的是 `MenuNode.id`，它与命令 id 可能不同（如 `file.refresh` → `view.reload`），
 * 因此这里先查菜单树，再退化为「直接是命令 id」。
 * @throws AppError 未知 id（IPC 层会包成 `{ok:false, error}`，不穿透）
 */
export async function runMenuCommandById(id: string, win?: BrowserWindow | null): Promise<void> {
  const command = findCommandById(id) ?? (knownCommands().has(id) ? id : null);
  if (command === null) {
    throw new AppError(`未知的菜单命令：${id}。菜单结构可能已变化，请重新打开菜单。`);
  }
  await runMenuCommand(command, win);
}

/** 视图 / 窗口类命令需要窗口才能执行。 */
const WINDOW_SCOPED_COMMAND = /^(?:view|window)\./;

function projectNode(node: MenuSpec, win: BrowserWindow | null): MenuNode {
  const projected: MenuNode = { id: node.id, label: dynamicLabel(node, win) };
  if (node.accelerator !== undefined) projected.accelerator = node.accelerator;
  if (node.kind !== undefined) projected.kind = node.kind;

  if (node.children !== undefined) {
    projected.children = node.children.map((child) => projectNode(child, win));
  } else if (node.command !== undefined) {
    // 只有真正可执行的菜单项才带 enabled；分隔线不带。
    projected.enabled = isCommandEnabled(node, win);
  }
  return projected;
}

/**
 * 菜单项是否可执行（实时求值）。
 *  - 视图 / 窗口类命令需要窗口；没有可用窗口时置 false；
 *  - DevTools 在生产构建中被关闭（QR-11）→ 如实置灰，与快捷键的空动作保持一致。
 */
function isCommandEnabled(node: MenuSpec, win: BrowserWindow | null): boolean {
  if (node.id === 'view.devtools' && !devToolsEnabled()) return false;
  if (node.command === undefined) return true;
  return win !== null || !WINDOW_SCOPED_COMMAND.test(node.command);
}

function dynamicLabel(node: MenuSpec, win: BrowserWindow | null): string {
  if (node.id !== 'view.fullscreen') return node.label;
  return win !== null && win.isFullScreen() ? '退出全屏' : node.label;
}

function findCommandById(id: string): string | null {
  const walk = (items: readonly MenuSpec[]): string | null => {
    for (const item of items) {
      if (item.id === id && item.command !== undefined) return item.command;
      if (item.children !== undefined) {
        const found = walk(item.children);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(menuSpec());
}

/** 全部合法命令 id（允许渲染层直接回传命令 id 而非菜单项 id）。 */
function knownCommands(): Set<string> {
  const commands = new Set<string>();
  const walk = (items: readonly MenuSpec[]): void => {
    for (const item of items) {
      if (item.command !== undefined) commands.add(item.command);
      if (item.children !== undefined) walk(item.children);
    }
  };
  walk(menuSpec());
  return commands;
}

/**
 * 命令执行入口。原生菜单、窗口级快捷键、以及后续的自绘菜单共用这一条路径，
 * 保证「菜单点一下」与「按快捷键」行为完全一致。
 * @param command 命令 id（`MenuSpec.command`）
 * @param win 目标窗口；省略时取当前聚焦窗口
 */
export async function runMenuCommand(command: string, win?: BrowserWindow | null): Promise<void> {
  const target = resolveWindow(win);

  switch (command) {
    /* ---- 文件 ---- */
    case 'file.openRoot':
      await openLocal(launcherRoot());
      return;
    case 'file.openInstances':
      await openLocal(path.join(launcherRoot(), 'instances'));
      return;
    case 'file.openEngines':
      await openLocal(path.join(launcherRoot(), 'engines'));
      return;

    /* ---- 视图 ---- */
    case 'view.reload':
      target?.webContents.reload();
      return;
    case 'view.forceReload':
      target?.webContents.reloadIgnoringCache();
      return;
    case 'view.devtools':
      // QR-11：生产构建默认关闭 DevTools 能力 —— 此处必须**空动作**（不抛错、不弹窗），
      // 与菜单项的 enabled=false、快捷键路径保持一致。
      if (!devToolsEnabled()) {
        console.info(
          '[menu] 开发者工具在当前构建中已关闭（如需临时排查，请以 WHALES_DEVTOOLS=1 或 --devtools 启动）。',
        );
        return;
      }
      target?.webContents.toggleDevTools();
      return;
    case 'view.fullscreen':
      if (target !== null) target.setFullScreen(!target.isFullScreen());
      return;
    case 'view.zoomReset':
      target?.webContents.setZoomLevel(0);
      return;
    case 'view.zoomIn':
      zoomBy(target, 0.5);
      return;
    case 'view.zoomOut':
      zoomBy(target, -0.5);
      return;

    /* ---- 编辑（键盘由 Chromium 内建处理；这里服务自绘菜单的点击） ---- */
    case 'edit.undo':
      target?.webContents.undo();
      return;
    case 'edit.redo':
      target?.webContents.redo();
      return;
    case 'edit.cut':
      target?.webContents.cut();
      return;
    case 'edit.copy':
      target?.webContents.copy();
      return;
    case 'edit.paste':
      target?.webContents.paste();
      return;
    case 'edit.selectAll':
      target?.webContents.selectAll();
      return;

    /* ---- 窗口 ---- */
    case 'window.minimize':
      target?.minimize();
      return;
    case 'window.close':
      // 走窗口的 close 事件：仍有实例运行时依旧会弹出确认（T2 行为不回归）。
      target?.close();
      return;

    /* ---- 应用 ---- */
    case 'app.quit':
      // 走 before-quit：先停掉所有由本启动器拉起的 dsh 子进程再退出。
      app.quit();
      return;

    /* ---- 帮助 ---- */
    case 'help.docs':
      await openLocal(path.join(launcherRoot(), 'docs', 'research', 'dsh-interface.md'));
      return;
    case 'help.architecture':
      await openLocal(path.join(launcherRoot(), 'docs', 'design', 'architecture.md'));
      return;
    case 'help.about':
      await showAbout(target);
      return;

    default:
      console.warn(`[menu] 未知命令：${command}`);
  }
}

/** Electron 缩放级数步长 0.5；上下限与 Chromium 的可用区间对齐。 */
const ZOOM_LEVEL_MIN = -8;
const ZOOM_LEVEL_MAX = 8;

function zoomBy(win: BrowserWindow | null, delta: number): void {
  if (win === null) return;
  const contents = win.webContents;
  const next = Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, contents.getZoomLevel() + delta));
  contents.setZoomLevel(next);
}

function resolveWindow(win?: BrowserWindow | null): BrowserWindow | null {
  if (win !== undefined && win !== null && !win.isDestroyed()) return win;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== null && !focused.isDestroyed()) return focused;
  const first = BrowserWindow.getAllWindows()[0];
  return first !== undefined && !first.isDestroyed() ? first : null;
}

async function openLocal(target: string): Promise<void> {
  try {
    const error = await shell.openPath(target);
    if (error.length > 0) console.warn(`[menu] 打开失败：${target} —— ${error}`);
  } catch (error) {
    console.warn(`[menu] 打开异常：${target}`, error);
  }
}

/** 关于对话框继续用原生 `dialog`（规范 §3.6：承载版本信息，不必自绘）。 */
async function showAbout(parent: BrowserWindow | null): Promise<void> {
  const detail = [
    `版本：${app.getVersion()}`,
    `Electron：${process.versions.electron ?? '未知'}`,
    `Node：${process.versions.node}`,
    `Chromium：${process.versions.chrome ?? '未知'}`,
    `启动器目录：${launcherRoot()}`,
  ].join('\n');

  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '关于 WhalesLauncher',
    message: 'WhalesLauncher',
    detail: `${detail}\n\nDeepSeek Harness (dsh) 的实例与版本管理启动器。`,
    buttons: ['确定'],
    noLink: true,
  };

  if (parent !== null) await dialog.showMessageBox(parent, options);
  else await dialog.showMessageBox(options);
}
