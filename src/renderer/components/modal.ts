/**
 * 模态框（自建，不使用 alert / confirm / prompt）
 *
 * - 焦点陷阱：Tab 在面板内循环，Esc 关闭，Enter 提交主操作；
 * - 关闭后把焦点还给打开它的元素；
 * - 支持多级堆叠，Esc 只作用于最上层。
 */
import { icon, type IconName } from '../icons';
import { focusables, h, required, tokenMs } from '../util/dom';

export type ModalActionVariant = 'primary' | 'default' | 'danger' | 'ghost' | 'subtle';

export interface ModalAction {
  label: string;
  /** 关闭时返回给调用方的值。 */
  value: string;
  variant?: ModalActionVariant;
  /** 主操作（Enter 触发、默认聚焦）。 */
  primary?: boolean;
  disabled?: boolean;
  /** 返回 false 可阻止关闭（例如表单校验失败）。 */
  onSelect?: (handle: ModalHandle) => boolean | void;
}

export interface ModalOptions {
  title: string;
  desc?: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'warning';
  body?: Node | Node[] | string;
  actions?: ModalAction[];
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 允许 Esc / 点击遮罩关闭（默认 true）。 */
  dismissable?: boolean;
  footerNote?: string;
  onClose?: () => void;
}

export interface ModalHandle {
  el: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  close(value?: string): void;
  /** 关闭后兑现：动作值或 null（取消）。 */
  result: Promise<string | null>;
}

const stack: ModalHandle[] = [];

export function openModal(options: ModalOptions): ModalHandle {
  const host = required<HTMLElement>('#overlays');
  const dismissable = options.dismissable !== false;
  let closedFlag = false;
  let settle: (value: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const buttons = new Map<string, HTMLButtonElement>();

  const bodyBox = h('div', { class: 'modal__body' });
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;

  const panel = h('div', {
    class: `modal${options.size && options.size !== 'md' ? ` modal--${options.size}` : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  });

  let handle: ModalHandle;

  const close = (value?: string): void => {
    if (closedFlag) return;
    closedFlag = true;
    const index = stack.indexOf(handle);
    if (index >= 0) stack.splice(index, 1);
    document.removeEventListener('keydown', onKeyDown, true);
    panel.classList.add('is-closing');
    backdrop.classList.add('is-closing');
    // 退场时长与 CSS 同源：读 --dur-1，避免硬编码魔法数（M5-7 / M5-5）
    window.setTimeout(() => {
      backdrop.remove();
    }, tokenMs('--dur-1', 120));
    if (previous && previous.isConnected) previous.focus();
    settle(value ?? null);
    options.onClose?.();
  };

  // 头部
  const headMain = h('div', { class: 'modal__head-main' }, h('h2', { class: 'modal__title', id: titleId, text: options.title }));
  if (options.desc) headMain.appendChild(h('div', { class: 'modal__desc', text: options.desc }));
  const head: Node[] = [];
  if (options.icon) {
    const toneClass = options.tone && options.tone !== 'default' ? ` modal__head-icon--${options.tone}` : '';
    head.push(h('div', { class: `modal__head-icon${toneClass}` }, icon(options.icon, 20)));
  }
  head.push(headMain);
  if (dismissable) {
    head.push(
      h(
        'button',
        {
          class: 'btn btn--ghost btn--icon modal__close',
          type: 'button',
          title: '关闭（Esc）',
          'aria-label': '关闭',
          onclick: () => close(undefined),
        },
        icon('close', 16),
      ),
    );
  }
  panel.appendChild(h('div', { class: 'modal__head' }, head));

  // 内容
  if (options.body) {
    if (typeof options.body === 'string') {
      bodyBox.appendChild(h('p', { class: 'modal__desc', text: options.body }));
    } else if (Array.isArray(options.body)) {
      for (const node of options.body) bodyBox.appendChild(node);
    } else {
      bodyBox.appendChild(options.body);
    }
  }
  panel.appendChild(bodyBox);

  // 底部动作
  if (options.actions && options.actions.length > 0) {
    const foot = h('div', { class: 'modal__foot' });
    if (options.footerNote) foot.appendChild(h('div', { class: 'modal__foot-note', text: options.footerNote }));
    for (const action of options.actions) {
      const variant =
        action.variant === 'danger'
          ? 'btn--danger-solid'
          : action.variant === 'primary'
            ? 'btn--primary'
            : action.variant === 'ghost'
              ? 'btn--ghost'
              : action.variant === 'subtle'
                ? 'btn--subtle'
                : '';
      const btn = h(
        'button',
        {
          class: `btn${variant ? ` ${variant}` : ''}`,
          type: 'button',
          disabled: action.disabled ?? false,
          onclick: () => {
            const verdict = action.onSelect?.(handle);
            if (verdict === false) return;
            close(action.value);
          },
        },
        h('span', { class: 'btn__label', text: action.label }),
      );
      if (action.primary) btn.dataset['primary'] = '1';
      buttons.set(action.value, btn);
      foot.appendChild(btn);
    }
    panel.appendChild(foot);
  }

  const backdrop = h('div', { class: 'modal-backdrop' }, panel);

  backdrop.addEventListener('mousedown', (event) => {
    if (!dismissable) return;
    if (event.target === backdrop) close(undefined);
  });

  // 键盘事件挂在 document 上（捕获阶段）：即使焦点不在面板内，Esc / Enter 依然可用
  const onKeyDown = (event: KeyboardEvent): void => {
    if (stack[stack.length - 1] !== handle) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (dismissable) close(undefined);
      return;
    }
    if (event.key === 'Tab') {
      const items = focusables(panel);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
      const primary = panel.querySelector<HTMLButtonElement>('.btn[data-primary="1"]');
      if (primary && !primary.disabled) {
        event.preventDefault();
        primary.click();
      }
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  handle = {
    el: backdrop,
    panel,
    body: bodyBox,
    close,
    result,
  };
  stack.push(handle);
  host.appendChild(backdrop);

  // 初始焦点：主操作 > 内容区第一个可聚焦元素 > 面板内第一个
  window.setTimeout(() => {
    const explicit = options.actions?.find((a) => a.value && a.primary);
    const target =
      (explicit ? buttons.get(explicit.value) : null) ?? focusables(bodyBox)[0] ?? focusables(panel)[0] ?? null;
    target?.focus();
  }, 0);

  return handle;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 附加说明（等宽小字，适合贴错误原文 / 路径）。 */
  detail?: string;
  extra?: Node;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  icon?: IconName;
}

/** 二次确认对话框；返回用户是否确认。 */
export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const body: Node[] = [h('p', { class: 'modal__desc', text: options.message })];
  if (options.detail) {
    body.push(
      h('div', {
        class: 'banner banner--warning',
        style: { alignItems: 'flex-start' },
      }, h('div', { class: 'banner__main' }, h('div', { class: 'banner__text mono', text: options.detail }))),
    );
  }
  if (options.extra) body.push(options.extra);

  const handle = openModal({
    title: options.title,
    icon: options.icon ?? (options.danger ? 'alertTriangle' : 'info'),
    tone: options.danger ? 'danger' : 'default',
    size: 'sm',
    body,
    actions: [
      { label: options.cancelText ?? '取消', value: 'cancel', variant: 'ghost' },
      {
        label: options.confirmText ?? '确认',
        value: 'confirm',
        variant: options.danger ? 'danger' : 'primary',
        primary: true,
      },
    ],
  });
  const value = await handle.result;
  return value === 'confirm';
}
