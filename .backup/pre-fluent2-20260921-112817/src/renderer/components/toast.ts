/**
 * 轻提示（Toast）：右上角堆叠，自动消失，永不阻塞界面。
 * 失败提示附可展开的详情行，便于用户复制错误原文。
 */
import { icon, type IconName } from '../icons';
import { h, required } from '../util/dom';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  detail?: string;
  /** 毫秒；<= 0 表示不自动关闭。 */
  timeout?: number;
  action?: { label: string; onClick: () => void };
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alertTriangle',
  error: 'alertCircle',
};

const TONE_TIMEOUT: Record<ToastTone, number> = {
  info: 4200,
  success: 3400,
  warning: 6000,
  error: 8000,
};

const MAX_TOASTS = 4;

/** 显示一条提示；返回手动关闭函数。 */
export function toast(message: string, tone: ToastTone = 'info', options: ToastOptions = {}): () => void {
  const host = required<HTMLElement>('#toasts');
  while (host.children.length >= MAX_TOASTS) {
    const first = host.firstElementChild;
    if (!first) break;
    first.remove();
  }

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('is-out');
    window.setTimeout(() => el.remove(), 200);
  };

  const main = h('div', { class: 'toast__main' }, h('div', { class: 'toast__msg', text: message }));
  if (options.detail) main.appendChild(h('div', { class: 'toast__detail', text: options.detail }));

  const body: (Node | null)[] = [
    h('span', { class: 'toast__icon' }, icon(TONE_ICON[tone], 16)),
    main,
  ];

  if (options.action) {
    const action = options.action;
    body.push(
      h(
        'button',
        {
          class: 'btn btn--sm btn--subtle',
          type: 'button',
          onclick: () => {
            action.onClick();
            dismiss();
          },
        },
        action.label,
      ),
    );
  }

  body.push(
    h(
      'button',
      { class: 'toast__close', type: 'button', title: '关闭', 'aria-label': '关闭提示', onclick: dismiss },
      icon('close', 14),
    ),
  );

  const el = h('div', { class: `toast toast--${tone}`, role: 'alert' }, body);

  host.appendChild(el);

  const timeout = options.timeout ?? TONE_TIMEOUT[tone];
  if (timeout > 0) window.setTimeout(dismiss, timeout);
  return dismiss;
}

export const toastInfo = (message: string, options?: ToastOptions): (() => void) =>
  toast(message, 'info', options ?? {});

export const toastSuccess = (message: string, options?: ToastOptions): (() => void) =>
  toast(message, 'success', options ?? {});

export const toastWarning = (message: string, options?: ToastOptions): (() => void) =>
  toast(message, 'warning', options ?? {});

export const toastError = (message: string, options?: ToastOptions): (() => void) =>
  toast(message, 'error', options ?? {});
