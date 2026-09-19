/**
 * 下拉菜单（标题栏应用菜单与内容区右键菜单**共用同一套样式与交互**）
 *
 * 键盘：↑/↓ 循环（跳过 disabled）、Home/End、Enter/Space 触发、Esc 关闭并归还焦点、
 *       Tab 关闭（防焦点逃逸）、←/→ 交给调用方在顶级菜单间切换。
 * 其它：点击外部关闭、窗口失焦关闭、视口避让、hover 切换由调用方驱动。
 * 规范：ui-redesign.md §3.3 / §3.4；不得加全屏遮罩（F-13）。
 */
import { icon, type IconName } from '../icons';
import { h, required } from '../util/dom';

export interface MenuAction {
  kind?: 'action';
  label: string;
  icon?: IconName;
  hint?: string;
  /** 该项由主进程提供（渲染层点不动，仅显示快捷键） */
  tag?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  kind: 'separator';
}

export interface MenuHeader {
  kind: 'header';
  label: string;
}

export type MenuEntry = MenuAction | MenuSeparator | MenuHeader;

export interface MenuOptions {
  align?: 'start' | 'end';
  /** 面板左边缘对齐到该元素（标题栏菜单对齐菜单区容器，符合 Windows 习惯） */
  alignTo?: HTMLElement | null;
  /** 关闭时是否把焦点还给锚点；上下级菜单切换时传 false */
  restoreFocus?: boolean;
  /** 左右方向键回调：用于在顶级菜单之间切换 */
  onHorizontal?: (direction: -1 | 1) => void;
  /**
   * 面板关闭回调（Esc / 点击外部 / Tab / 失焦 / 触发项 都会触发）。
   * 调用方（如标题栏菜单栏）靠它同步 aria-expanded 与内部索引，
   * 否则 Esc 关闭后面板状态会与调用方不一致。
   */
  onClose?: () => void;
}

export interface MenuHandle {
  close(restoreFocus?: boolean): void;
  isOpen(): boolean;
}

/** 面板与触发器之间的垂直缝隙（=== var(--menu-gap-y)） */
const MENU_GAP_Y = 4;
/** 视口边缘留白（8 = --sp-2） */
const VIEWPORT_PAD = 8;

export function openMenu(anchor: HTMLElement, entries: MenuEntry[], options: MenuOptions = {}): MenuHandle {
  const host = required<HTMLElement>('#overlays');
  const buttons: HTMLButtonElement[] = [];
  const menu = h('div', { class: 'menu', role: 'menu' });
  // 只有当组内确有图标时才保留 16px 图标槽（否则标签会整体右移 24px）
  const hasIcons = entries.some(
    (entry) => entry.kind !== 'separator' && entry.kind !== 'header' && Boolean((entry as MenuAction).icon),
  );

  for (const entry of entries) {
    if (entry.kind === 'separator') {
      menu.appendChild(h('div', { class: 'menu__sep', role: 'separator' }));
      continue;
    }
    if (entry.kind === 'header') {
      menu.appendChild(h('div', { class: 'menu__label', text: entry.label }));
      continue;
    }
    const item = h(
      'button',
      {
        class: `menu__item${entry.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: entry.disabled ?? false,
        onclick: () => {
          close(false);
          entry.onSelect();
        },
      },
      hasIcons ? h('span', { class: 'menu__icon' }, entry.icon ? icon(entry.icon, 16) : null) : null,
      h('span', { class: 'truncate', text: entry.label }),
      entry.hint ? h('span', { class: 'menu__shortcut', text: entry.hint }) : null,
      entry.tag ? h('span', { class: 'menu__tag', text: entry.tag }) : null,
    );
    buttons.push(item);
    menu.appendChild(item);
  }

  let closed = false;
  let hadFocus = false;

  const close = (restoreFocus = options.restoreFocus !== false): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
    menu.remove();
    if (restoreFocus && hadFocus && anchor.isConnected) anchor.focus();
    options.onClose?.();
  };

  const onOutside = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || anchor.contains(target))) return;
    close();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // 关闭但不抢焦点：把焦点交回文档顺序，避免逃逸到不可见面板
      close(false);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (!options.onHorizontal) return;
      event.preventDefault();
      options.onHorizontal(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    const enabled = buttons.filter((b) => !b.disabled);
    if (enabled.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    if (event.key === 'Home') {
      event.preventDefault();
      enabled[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      enabled[enabled.length - 1]?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = active ? enabled.indexOf(active) : -1;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = enabled[(index + step + enabled.length) % enabled.length];
    next?.focus();
  };

  const onResize = (): void => close();
  /**
   * 窗口失焦关闭。
   * 不能直接在 blur 回调里关闭：焦点在「面板内首个菜单项」之间转移时也可能触发窗口级
   * blur（实测 jsdom 必现；Chromium 在焦点元素被移除时同样会出现），会把刚打开的
   * 面板立刻关掉。这里改为下一轮事件循环再判断文档是否真的失去焦点。
   */
  const onBlur = (): void => {
    window.setTimeout(() => {
      if (closed) return;
      if (typeof document.hasFocus === 'function' && document.hasFocus()) return;
      const active = document.activeElement;
      if (active && menu.contains(active)) return;
      close(false);
    }, 0);
  };

  host.appendChild(menu);

  // 定位：默认在锚点下方；alignTo 时按容器左边缘对齐（避免五个下拉参差）
  const anchorRect = (options.alignTo ?? anchor).getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const alignEnd = options.align === 'end';
  let left = alignEnd ? anchorRect.right - size.width : anchorRect.left;
  left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - size.width - VIEWPORT_PAD));
  let top = anchorRect.bottom + MENU_GAP_Y;
  if (top + size.height > window.innerHeight - VIEWPORT_PAD) {
    top = Math.max(VIEWPORT_PAD, anchorRect.top - size.height - MENU_GAP_Y);
  }
  menu.style.setProperty('left', `${left}px`);
  menu.style.setProperty('top', `${top}px`);

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onBlur);

  const first = buttons.find((b) => !b.disabled);
  first?.focus();
  hadFocus = document.activeElement === first;

  return {
    close(restoreFocus?: boolean): void {
      close(restoreFocus);
    },
    isOpen: () => !closed,
  };
}

/** 供菜单模型复用的分隔符。 */
export const MENU_SEPARATOR: MenuSeparator = { kind: 'separator' };
