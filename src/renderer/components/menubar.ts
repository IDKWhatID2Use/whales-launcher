/**
 * 应用内 Fluent 菜单栏（取代系统菜单，折进标题栏同一行）
 *
 * **菜单项不做本地定义**：结构、标签、快捷键全部来自主进程的
 * `window.whales.app.menu()`（`MenuNode[]`，唯一事实源）；
 * 点击时调 `window.whales.app.menuCommand(id)`，失败给出可读中文提示。
 * 演示模式（无 window.whales）由内置演示后端提供同结构的树，
 * 并由渲染层承担等价动作（重载 / 编辑命令 / 关于），其余项提示需要主进程。
 *
 * 键盘：Alt 唤出/收起、Alt+F/E/V/W/H 直达、←/→ 在顶级菜单间切换、
 *       ↑/↓/Home/End 移动、Enter 触发、Esc 关闭并归还焦点、Tab 关闭。
 * 说明：**不注册任何全局加速键**（F5 / Ctrl+R / F11 / Ctrl+Shift+I 等由主进程
 * `before-input-event` 统一接管，渲染层重复绑定会导致双重触发）。
 */
import type { MenuNode } from '../../shared/contracts';
import { openModal } from './modal';
import { openMenu, type MenuEntry, type MenuHandle } from './menu';
import { toastError, toastInfo } from './toast';
import { h, replace } from '../util/dom';
import { backend, isDemo } from '../data/api';
import { store } from '../data/store';

/** 顶级菜单的 Alt 助记字母（与 Windows 习惯一致；仅用于界面快捷键，不定义菜单内容） */
const ALT_KEYS = ['f', 'e', 'v', 'w', 'h'];

export interface MenubarHandle {
  el: HTMLElement;
  /** 重新拉取菜单树（后端就绪后调用） */
  reload(): Promise<void>;
  destroy(): void;
}

export function createMenubar(): MenubarHandle {
  const el = h('nav', { class: 'titlebar__menubar', role: 'menubar', 'aria-label': '应用菜单' });

  let tree: MenuNode[] = [];
  let triggers: HTMLButtonElement[] = [];
  let openIndex = -1;
  let handle: MenuHandle | null = null;
  let altActive = false;
  let altConsumed = false;
  let loadError: string | null = null;
  let retried = false;

  /* ── 加载菜单树 ─────────────────────────────────────────── */

  async function reload(): Promise<void> {
    const result = await backend().api.app.menu();
    if (result.ok && result.value.length > 0) {
      tree = result.value;
      loadError = null;
    } else {
      tree = [];
      loadError = result.ok ? '后端返回了空的菜单树' : result.error;
      // preload 可能比渲染层晚就绪：非演示模式重试一次
      if (!retried && !isDemo()) {
        retried = true;
        window.setTimeout(() => void reload(), 1200);
      }
    }
    rebuildTriggers();
  }

  function rebuildTriggers(): void {
    closeGroup(false);
    triggers = [];
    if (tree.length === 0) {
      const fallback = h(
        'button',
        {
          class: 'menu-trigger',
          type: 'button',
          'aria-disabled': 'true',
          title: loadError ?? '菜单尚未就绪',
          onclick: () => toastInfo('应用菜单不可用', { detail: loadError ?? '请稍后重试，或使用视图内的操作按钮。' }),
        },
        h('span', { text: '菜单' }),
      );
      replace(el, fallback);
      return;
    }

    const nodes: Node[] = tree.map((node, index) => {
      const trigger = h(
        'button',
        {
          class: 'menu-trigger',
          type: 'button',
          role: 'menuitem',
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'aria-keyshortcuts': ALT_KEYS[index] ? `Alt+${ALT_KEYS[index].toUpperCase()}` : undefined,
          title: ALT_KEYS[index] ? `Alt+${ALT_KEYS[index].toUpperCase()}` : node.label,
          onclick: () => toggleGroup(index),
          onmouseenter: () => {
            // 已展开时移到相邻触发器：立即切换（Windows 原生行为）
            if (openIndex >= 0 && openIndex !== index) openGroup(index);
          },
        },
        h('span', { text: node.label }),
      );
      triggers.push(trigger);
      return trigger;
    });
    replace(el, nodes);
  }

  /* ── 打开 / 关闭 ─────────────────────────────────────────── */

  function modalOpen(): boolean {
    return document.querySelector('.modal-backdrop') !== null;
  }

  function setExpanded(index: number, expanded: boolean): void {
    triggers[index]?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (expanded) el.setAttribute('aria-activedescendant', `menu-trigger-${index}`);
    else el.removeAttribute('aria-activedescendant');
  }

  function closeGroup(restoreFocus = true): void {
    const previous = openIndex;
    handle?.close(false);
    handle = null;
    openIndex = -1;
    if (previous >= 0) setExpanded(previous, false);
    if (restoreFocus && previous >= 0) triggers[previous]?.focus();
  }

  function openGroup(index: number): void {
    const node = tree[index];
    const trigger = triggers[index];
    if (!node || !trigger) return;
    if (modalOpen()) {
      toastInfo('请先关闭当前对话框', { detail: '模态框打开时，应用菜单不可用（菜单层级低于模态）。' });
      return;
    }
    if (openIndex === index && handle?.isOpen()) {
      closeGroup();
      return;
    }
    const previous = openIndex;
    handle?.close(false);
    handle = null;
    if (previous >= 0) setExpanded(previous, false);

    handle = openMenu(trigger, toEntries(node.children ?? []), {
      alignTo: el,
      restoreFocus: false,
      // 面板被任何方式关闭（Esc / 点击外部 / Tab / 失焦 / 触发项）都要同步本组件的状态
      onClose: () => {
        if (openIndex === index) {
          setExpanded(index, false);
          openIndex = -1;
          handle = null;
        }
      },
      onHorizontal: (direction) => {
        const next = (index + direction + tree.length) % tree.length;
        openGroup(next);
      },
    });
    openIndex = index;
    setExpanded(index, true);
  }

  /** 把后端菜单节点投影成菜单项（分隔线 / 分组标题 / 可点击项）。 */
  function toEntries(nodes: readonly MenuNode[]): MenuEntry[] {
    const entries: MenuEntry[] = [];
    for (const node of nodes) {
      if (node.kind === 'separator') {
        entries.push({ kind: 'separator' });
        continue;
      }
      if (node.kind === 'header') {
        entries.push({ kind: 'header', label: node.label });
        continue;
      }
      // 深层嵌套（本应用当前为两级）：把子节点展开为分组标题 + 同级项，避免出现点不动的死项
      if (node.children && node.children.length > 0) {
        entries.push({ kind: 'header', label: node.label });
        entries.push(...toEntries(node.children));
        continue;
      }
      entries.push({
        label: node.label,
        hint: node.accelerator,
        disabled: node.enabled === false,
        // 契约无 danger 字段：按约定对「退出」特判
        danger: node.id === 'file.quit',
        onSelect: () => void dispatch(node),
      });
    }
    return entries;
  }

  function toggleGroup(index: number): void {
    if (openIndex === index && handle?.isOpen()) closeGroup();
    else openGroup(index);
  }

  /* ── 命令执行 ─────────────────────────────────────────────── */

  async function dispatch(node: MenuNode): Promise<void> {
    if (isDemo()) {
      const handledLocally = runLocalFallback(node.id);
      if (handledLocally) return;
      toastInfo(`「${node.label}」需要主进程`, {
        detail: node.accelerator
          ? `演示模式下无窗口层；真实运行时可点此菜单项，或按 ${node.accelerator}。`
          : '演示模式下无窗口层；该项在真实运行时由主进程执行。',
      });
      return;
    }
    try {
      const result = await backend().api.app.menuCommand(node.id);
      if (!result.ok) toastError(`「${node.label}」执行失败`, { detail: result.error });
    } catch (error) {
      toastError(`「${node.label}」执行失败`, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 演示模式的等价实现：只覆盖渲染层真正做得到的动作。 */
  function runLocalFallback(id: string): boolean {
    switch (id) {
      case 'file.refresh':
      case 'view.reload':
      case 'view.forceReload':
        window.location.reload();
        return true;
      case 'edit.undo':
      case 'edit.redo':
      case 'edit.cut':
      case 'edit.copy':
      case 'edit.paste':
      case 'edit.selectAll':
        return execEdit(id);
      case 'file.quit':
      case 'window.close':
        return true; // 普通浏览器中 window.close() 会被忽略，演示模式不产生副作用
      case 'help.about':
        showAbout();
        return true;
      default:
        return false;
    }
  }

  function execEdit(id: string): boolean {
    const map: Record<string, string> = {
      'edit.undo': 'undo',
      'edit.redo': 'redo',
      'edit.cut': 'cut',
      'edit.copy': 'copy',
      'edit.paste': 'paste',
      'edit.selectAll': 'selectAll',
    };
    const command = map[id];
    if (!command) return false;
    try {
      document.execCommand(command);
    } catch {
      toastInfo('当前焦点不在可编辑区域');
    }
    return true;
  }

  /* ── Alt 键与键盘 ─────────────────────────────────────────── */

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      altActive = true;
      altConsumed = false;
      return;
    }
    if (altActive) altConsumed = true;
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const index = ALT_KEYS.indexOf(event.key.toLowerCase());
    if (index < 0 || index >= tree.length) return;
    event.preventDefault();
    altConsumed = true;
    openGroup(index);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt') return;
    const shouldToggle = altActive && !altConsumed;
    altActive = false;
    if (!shouldToggle || tree.length === 0) return;
    if (openIndex >= 0) closeGroup();
    else openGroup(0);
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  // 模态框打开时禁用触发器（--z-menu 低于 --z-modal）
  const observer = new MutationObserver(() => {
    const blocked = modalOpen();
    for (const trigger of triggers) trigger.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked && openIndex >= 0) closeGroup(false);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  void reload();

  return {
    el,
    reload,
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      observer.disconnect();
      handle?.close(false);
      handle = null;
    },
  };
}

/** 关于对话框（演示模式与帮助菜单共用；真实模式走主进程原生对话框）。 */
function showAbout(): void {
  const state = store.get();
  const config = state.config;
  openModal({
    title: '关于 WhalesLauncher',
    desc: 'DeepSeek Harness (dsh) 的实例与版本管理启动器。',
    icon: 'whaleMark',
    size: 'sm',
    body: [
      h(
        'div',
        { class: 'kv' },
        h('div', { class: 'kv__row' }, h('div', { class: 'kv__k', text: '版本' }), h('div', { class: 'kv__v mono', text: state.appVersion || '—' })),
        h(
          'div',
          { class: 'kv__row' },
          h('div', { class: 'kv__k', text: '运行模式' }),
          h('div', { class: 'kv__v', text: state.demo ? '演示数据（未连接后端）' : '已连接后端' }),
        ),
        h('div', { class: 'kv__row' }, h('div', { class: 'kv__k', text: '启动器目录' }), h('div', { class: 'kv__v path-text', text: config?.rootDir ?? '—' })),
        h('div', { class: 'kv__row' }, h('div', { class: 'kv__k', text: '主 home' }), h('div', { class: 'kv__v path-text', text: config?.primaryHome ?? '—' })),
        h('div', { class: 'kv__row' }, h('div', { class: 'kv__k', text: '界面框架' }), h('div', { class: 'kv__v', text: '原生 TypeScript + CSS（Fluent / WCO）' })),
      ),
    ],
    actions: [{ label: '确定', value: 'ok', variant: 'primary', primary: true }],
  });
}

/** 供外壳在需要时刷新菜单（例如后端迟到就绪）。 */
export function refreshMenubar(handle: MenubarHandle | null): void {
  if (handle) void handle.reload();
}
