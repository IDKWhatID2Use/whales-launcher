/**
 * 窗口级快捷键（规范 §3.5；反例 F-16）。
 *
 * 为什么不用原生菜单的加速键：窗口改用 WCO 后原生菜单栏必须移除（F-09 禁止双菜单），
 *   而 `Menu.setApplicationMenu(null)` 会让所有 `role` 自带的加速键**全部消失**，因此逐条重绑。
 * 为什么不用 `globalShortcut`：那是**系统级**快捷键，应用失焦时会抢键 —— 规范明令禁止（F-16）。
 *
 * 绑定来源是 `menuSpec()` 的 `accelerator` 字段：菜单里显示的快捷键文本与这里的匹配逻辑同源，
 * 杜绝两处定义漂移（§3.6 表格）。唯一例外是编辑类命令 —— 它们的按键由 Chromium 内建处理，
 * 若在这里再绑一次，`Ctrl+Z` 会「撤销两次 = 什么都没撤销」（§3.5 明确标注无需重绑）。
 */
import type { BrowserWindow } from 'electron';
import { menuSpec, runMenuCommand, type MenuSpec } from './menu.js';

/** Chromium 内建已处理的编辑命令：菜单里显示加速键，但**不**在 before-input-event 中抢键。 */
const BUILTIN_EDIT_COMMANDS: ReadonlySet<string> = new Set([
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.selectAll',
]);

/** 规范要求保留、但不出现在任何菜单项里的键：F12 是 Chromium 默认的开发者工具键（§3.5）。 */
const EXTRA_BINDINGS: ReadonlyArray<{ accelerator: string; command: string }> = [
  { accelerator: 'F12', command: 'view.devtools' },
];

export interface ShortcutBinding {
  /** 原始加速键文本（与菜单显示一致）。 */
  accelerator: string;
  command: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 归一化后的按键名（小写）。 */
  key: string;
  /** 修饰键数量，用于把更具体的绑定排在前面（`Ctrl+Shift+R` 先于 `Ctrl+R`）。 */
  weight: number;
}

/**
 * 当前生效的全部绑定（导出以便自测与排查）。
 * 顺序即匹配优先级：修饰键更多者优先。
 */
export function shortcutBindings(): ShortcutBinding[] {
  const collected: Array<{ accelerator: string; command: string }> = [];
  const seen = new Set<string>();

  const walk = (items: readonly MenuSpec[]): void => {
    for (const item of items) {
      if (item.children !== undefined) walk(item.children);
      if (item.kind === 'separator' || item.kind === 'header') continue;
      const { accelerator, command } = item;
      if (accelerator === undefined || command === undefined) continue;
      if (BUILTIN_EDIT_COMMANDS.has(command)) continue;
      if (seen.has(accelerator)) {
        console.warn(`[shortcuts] 加速键重复，已忽略后者：${accelerator}`);
        continue;
      }
      seen.add(accelerator);
      collected.push({ accelerator, command });
    }
  };
  walk(menuSpec());

  for (const extra of EXTRA_BINDINGS) {
    if (seen.has(extra.accelerator)) continue;
    seen.add(extra.accelerator);
    collected.push(extra);
  }

  return collected.map(parseBinding).sort((left, right) => right.weight - left.weight);
}

/**
 * 给窗口装上窗口级快捷键。
 * 在 `guardWebContents()` 内调用（规范 §3.5 推荐的落点）：
 * `before-input-event` 不依赖 DOM 焦点（焦点在输入框里按 F11 同样生效），
 * 也不会被渲染层的 `preventDefault()` 影响，且与菜单项调用同一批动作函数。
 */
export function installShortcuts(win: BrowserWindow): void {
  const table = shortcutBindings();

  win.webContents.on('before-input-event', (event, input) => {
    const binding = table.find((item) => matches(item, input));
    if (binding === undefined) return;
    event.preventDefault();
    void runMenuCommand(binding.command, win).catch((error: unknown) => {
      console.error(`[shortcuts] 执行 ${binding.command} 失败：`, error);
    });
  });
}

function matches(binding: ShortcutBinding, input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  if (Boolean(input.control) !== binding.ctrl) return false;
  if (Boolean(input.shift) !== binding.shift) return false;
  if (Boolean(input.alt) !== binding.alt) return false;
  // Win / Cmd 组合一律不接管，避免误吞系统级快捷键。
  if (input.meta) return false;
  return keyMatches(binding.key, (input.key ?? '').toLowerCase());
}

function keyMatches(expected: string, actual: string): boolean {
  // Ctrl+= 在实际按键里可能是 '='（无 Shift）或 '+'（带 Shift）；缩放不区分二者。
  if (expected === '=') return actual === '=' || actual === '+';
  if (expected === '-') return actual === '-' || actual === '_';
  return expected === actual;
}

function parseBinding(entry: { accelerator: string; command: string }): ShortcutBinding {
  const parts = entry.accelerator.split('+').map((part) => part.trim());
  const key = (parts.pop() ?? '').toLowerCase();

  let ctrl = false;
  let shift = false;
  let alt = false;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'ctrl':
      case 'control':
      case 'cmdorctrl':
      case 'commandorcontrol':
        ctrl = true;
        break;
      case 'shift':
        shift = true;
        break;
      case 'alt':
        alt = true;
        break;
      default:
        console.warn(`[shortcuts] 无法识别的修饰键「${part}」（${entry.accelerator}）`);
    }
  }

  return {
    accelerator: entry.accelerator,
    command: entry.command,
    ctrl,
    shift,
    alt,
    key,
    weight: (ctrl ? 1 : 0) + (shift ? 1 : 0) + (alt ? 1 : 0),
  };
}
