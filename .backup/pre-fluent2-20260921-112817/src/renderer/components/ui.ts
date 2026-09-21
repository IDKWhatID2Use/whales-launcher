/**
 * 界面原子组件
 *
 * 约定：每个工厂函数返回一个真实 DOM 元素；需要动态更新的场景由调用方
 * 重建子树（视图内部状态很轻），或使用暴露的辅助函数（如 `setBusy`）。
 */
import type { InstanceState } from '../../shared/contracts';
import { icon, type IconName } from '../icons';
import { copyText, h } from '../util/dom';
import { toastError, toastSuccess } from './toast';

/* ══ 按钮 ═══════════════════════════════════════════════════════════ */

export type ButtonVariant = 'default' | 'primary' | 'subtle' | 'danger' | 'danger-solid' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  iconAfter?: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
  id?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const classes = ['btn'];
  if (options.variant && options.variant !== 'default') classes.push(`btn--${options.variant}`);
  if (options.size && options.size !== 'md') classes.push(`btn--${options.size}`);
  if (options.block) classes.push('btn--block');
  if (options.className) classes.push(options.className);

  // 图标尺寸只取档位：小控件 14，其余 16（判据 S3-5）
  const iconSize = options.size === 'sm' || options.size === 'icon-sm' ? 14 : 16;
  const label = h(
    'span',
    { class: 'btn__label' },
    options.icon ? icon(options.icon, iconSize) : null,
    options.label ? h('span', { text: options.label }) : null,
    options.iconAfter ? icon(options.iconAfter, iconSize) : null,
  );

  const btn = h(
    'button',
    {
      class: classes.join(' '),
      type: options.type ?? 'button',
      title: options.title ?? '',
      disabled: options.disabled ?? false,
    },
    label,
  );
  const aria = options.ariaLabel ?? (options.label ? undefined : options.title);
  if (aria) btn.setAttribute('aria-label', aria);
  if (options.id) btn.id = options.id;
  if (options.onClick) btn.addEventListener('click', options.onClick as EventListener);
  return btn;
}

/**
 * 纯图标按钮：`label` 只作为无障碍名称与悬浮提示，**不渲染可见文字**。
 *
 * 注意：必须把 `label` 从透传参数里剥掉。曾因 `...options` 把 label 一并传给
 * `button()`，图标按钮在 28px 盒子里渲染出文字并溢出到相邻按钮上
 * （Lead 用 CDP 实测到标题栏两枚按钮的文字重叠 20px）。CSS 侧另有兜底规则
 * 隐藏 `.btn--icon*` 内的文字节点，双重保险。
 */
export function iconButton(
  name: IconName,
  options: Omit<ButtonOptions, 'icon' | 'label'> & { label: string },
): HTMLButtonElement {
  const { label, ...rest } = options;
  const marker = 'btn--glyph';
  return button({
    ...rest,
    icon: name,
    size: options.size ?? 'icon',
    variant: options.variant ?? 'ghost',
    className: options.className ? `${options.className} ${marker}` : marker,
    ariaLabel: label,
    title: options.title ?? label,
  });
}

/** 切换忙碌态：禁用 + 内联转圈，标签可选替换。 */
export function setBusy(target: HTMLButtonElement, busy: boolean, label?: string): void {
  target.classList.toggle('is-busy', busy);
  target.disabled = busy;
  if (label) {
    const text = target.querySelector('.btn__label > span');
    if (text) text.textContent = label;
  }
  let holder = target.querySelector<HTMLElement>('.btn__spinner');
  if (busy && !holder) {
    holder = h('span', { class: 'btn__spinner' }, spinner('sm'));
    target.appendChild(holder);
  } else if (!busy && holder) {
    holder.remove();
  }
}

/* ══ 徽标 / 芯片 ═══════════════════════════════════════════════════ */

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'stopping';

export interface BadgeOptions {
  /** 静止状态标记：6px 圆点 */
  dot?: boolean;
  /** 运动状态标记：16px 确定性进度环（替代透明度闪烁） */
  ring?: boolean;
  icon?: IconName;
  lg?: boolean;
  title?: string;
}

export function badge(text: string, tone: BadgeTone = 'neutral', options: BadgeOptions = {}): HTMLElement {
  const children: Node[] = [];
  if (options.icon) children.push(icon(options.icon, 12));
  if (options.ring) children.push(h('span', { class: 'badge__ring', 'aria-hidden': 'true' }));
  else if (options.dot) children.push(h('span', { class: 'badge__dot', 'aria-hidden': 'true' }));
  children.push(h('span', { text }));
  const el = h(
    'span',
    { class: `badge badge--${tone}${options.lg ? ' badge--lg' : ''}`, title: options.title ?? '' },
    children,
  );
  return el;
}

const STATE_LABEL: Record<InstanceState, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  crashed: '已崩溃',
};

const STATE_TONE: Record<InstanceState, BadgeTone> = {
  stopped: 'neutral',
  starting: 'warning',
  running: 'success',
  stopping: 'stopping',
  crashed: 'danger',
};

export function stateLabel(state: InstanceState): string {
  return STATE_LABEL[state];
}

/** 运行状态徽标：颜色 + 文本 + 形状 三通道表达（色盲用户凭文本与形状即可判断）。 */
export function statusBadge(state: InstanceState, lg = false): HTMLElement {
  const moving = state === 'running' || state === 'starting' || state === 'stopping';
  return badge(STATE_LABEL[state], STATE_TONE[state], {
    // 运动态用确定性进度环，静止/崩溃用圆点或图标（不用透明度闪烁）
    ring: moving,
    dot: state === 'stopped',
    icon: state === 'crashed' ? 'alertCircle' : undefined,
    lg,
  });
}

export interface ChipOptions {
  /** 等宽字体：仅用于版本号 / 路径 / 快捷键等机器可读文本 */
  mono?: boolean;
}

export function chip(
  text: string,
  tone: 'default' | 'accent' | 'warning' = 'default',
  options: ChipOptions = {},
): HTMLElement {
  return h('span', {
    class: `chip${tone !== 'default' ? ` chip--${tone}` : ''}${options.mono ? ' chip--mono' : ''}`,
    text,
    title: text,
  });
}

/* ══ 反馈 ═══════════════════════════════════════════════════════════ */

export function spinner(size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  return h('span', { class: `spinner${size === 'md' ? '' : ` spinner--${size}`}`, 'aria-hidden': 'true' });
}

export interface ProgressOptions {
  value?: number;
  indeterminate?: boolean;
  label?: string;
}

export function progressBar(options: ProgressOptions = {}): HTMLElement {
  const bar = h('div', { class: 'progress__bar' });
  if (!options.indeterminate && options.value !== undefined) {
    bar.style.setProperty('width', `${Math.max(0, Math.min(100, options.value))}%`);
  }
  const el = h('div', {
    class: `progress${options.indeterminate ? ' progress--indeterminate' : ''}`,
    role: 'progressbar',
    'aria-label': options.label ?? '进度',
  }, bar);
  return el;
}

export function busyRow(text: string): HTMLElement {
  return h('div', { class: 'busy-row' }, spinner('sm'), h('span', { text }));
}

/* ══ 表单控件 ═══════════════════════════════════════════════════════ */

export interface SwitchOptions {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

export function switchControl(options: SwitchOptions): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    checked: options.checked,
    disabled: options.disabled ?? false,
    onchange: () => options.onChange(input.checked),
  });
  if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel);
  return h(
    'label',
    { class: 'switch', title: options.title ?? '' },
    input,
    h('span', { class: 'switch__track' }),
    options.label ? h('span', { class: 'switch__label', text: options.label }) : null,
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  title?: string;
}

export interface SegmentedOptions<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'md' | 'lg';
  ariaLabel?: string;
}

export function segmented<T extends string>(config: SegmentedOptions<T>): HTMLElement {
  const items: Node[] = [];
  for (const option of config.options) {
    const item = h(
      'button',
      {
        class: `segmented__item${option.value === config.value ? ' is-active' : ''}`,
        type: 'button',
        title: option.title ?? '',
        role: 'tab',
        'aria-selected': option.value === config.value ? 'true' : 'false',
        onclick: () => config.onChange(option.value),
      },
      option.icon ? icon(option.icon, 14) : null,
      h('span', { text: option.label }),
    );
    items.push(item);
  }
  const el = h(
    'div',
    { class: `segmented${config.size === 'lg' ? ' segmented--lg' : ''}`, role: 'tablist' },
    items,
  );
  if (config.ariaLabel) el.setAttribute('aria-label', config.ariaLabel);
  return el;
}

export interface SelectOptions<T extends string> {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function selectControl<T extends string>(config: SelectOptions<T>): HTMLElement {
  const select = h('select', {
    class: 'select',
    disabled: config.disabled ?? false,
    onchange: () => config.onChange(select.value as T),
  });
  for (const option of config.options) {
    const opt = h('option', {
      value: option.value,
      text: option.label,
      disabled: option.disabled ?? false,
    });
    if (option.value === config.value) opt.selected = true;
    select.appendChild(opt);
  }
  if (config.ariaLabel) select.setAttribute('aria-label', config.ariaLabel);
  return h('div', { class: 'select-wrap' }, select, icon('chevronDown', 14, 'select-caret'));
}

export interface FieldOptions {
  label: string;
  control: HTMLElement;
  hint?: string;
  error?: string;
  ok?: string;
  required?: boolean;
  htmlFor?: string;
}

export function field(options: FieldOptions): HTMLElement {
  const parts: Node[] = [
    h(
      'label',
      { class: 'field__label', for: options.htmlFor ?? '' },
      h('span', { text: options.label }),
      options.required ? h('span', { class: 'field__req', text: '*', title: '必填' }) : null,
    ),
    options.control,
  ];
  if (options.error) {
    parts.push(h('div', { class: 'field__error' }, icon('alertCircle', 14), h('span', { text: options.error })));
  } else if (options.ok) {
    parts.push(h('div', { class: 'field__ok' }, icon('check', 14), h('span', { text: options.ok })));
  } else if (options.hint) {
    parts.push(h('div', { class: 'field__hint' }, h('span', { text: options.hint })));
  }
  return h('div', { class: 'field' }, parts);
}

/* ══ 容器 ═══════════════════════════════════════════════════════════ */

export interface BannerOptions {
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  text?: string;
  icon?: IconName;
  actions?: Node[];
}

export function banner(options: BannerOptions): HTMLElement {
  const iconName: IconName =
    options.icon ??
    (options.tone === 'danger'
      ? 'alertCircle'
      : options.tone === 'warning'
        ? 'alertTriangle'
        : options.tone === 'success'
          ? 'check'
          : 'info');
  const main: Node[] = [];
  if (options.title) main.push(h('div', { class: 'banner__title', text: options.title }));
  if (options.text) main.push(h('div', { class: 'banner__text', text: options.text }));
  return h(
    'div',
    { class: `banner banner--${options.tone}`, role: options.tone === 'danger' ? 'alert' : undefined },
    h('span', { class: 'banner__icon' }, icon(iconName, 16)),
    h('div', { class: 'banner__main' }, main),
    options.actions && options.actions.length > 0 ? h('div', { class: 'banner__actions' }, options.actions) : null,
  );
}

export interface CardOptions {
  title?: string;
  desc?: string;
  icon?: IconName;
  actions?: Array<Node | null | undefined>;
  body?: Array<Node | string | null | undefined>;
  foot?: Array<Node | string | null | undefined>;
  className?: string;
  /** 内容区不使用内边距（用于列表）。 */
  flush?: boolean;
}

export function card(options: CardOptions): HTMLElement {
  const children: Node[] = [];
  if (options.title || options.desc || options.actions) {
    const headMain: Node[] = [];
    if (options.title) {
      headMain.push(
        h(
          'div',
          { class: 'card__title' },
          options.icon ? icon(options.icon, 16) : null,
          h('span', { text: options.title }),
        ),
      );
    }
    if (options.desc) headMain.push(h('div', { class: 'card__desc', text: options.desc }));
    children.push(
      h(
        'div',
        { class: 'card__head' },
        h('div', { class: 'card__head-main' }, headMain),
        options.actions ? h('div', { class: 'toolbar' }, options.actions) : null,
      ),
    );
  }
  if (options.body && options.body.length > 0) {
    children.push(
      h('div', { class: `card__body${options.flush ? ' card__body--tight' : ''}` }, options.body),
    );
  }
  if (options.foot && options.foot.length > 0) {
    children.push(h('div', { class: 'card__foot' }, options.foot));
  }
  return h('div', { class: `card${options.className ? ` ${options.className}` : ''}` }, children);
}

export interface EmptyStateOptions {
  icon?: IconName;
  title: string;
  desc?: string;
  actions?: Node[];
  compact?: boolean;
}

export function emptyState(options: EmptyStateOptions): HTMLElement {
  return h(
    'div',
    { class: `empty${options.compact ? ' empty--compact' : ''}` },
    // 空态插画属「图形档」：默认 28，紧凑 24（§5.8）
    h('div', { class: 'empty__art' }, icon(options.icon ?? 'package', options.compact ? 24 : 28)),
    h('div', { class: 'empty__title', text: options.title }),
    options.desc ? h('div', { class: 'empty__desc', text: options.desc }) : null,
    options.actions && options.actions.length > 0
      ? h('div', { class: 'empty__actions' }, options.actions)
      : null,
  );
}

/** 卡片内的小空态。 */
export function listEmpty(text: string, iconName: IconName = 'info'): HTMLElement {
  return h(
    'div',
    { class: 'empty empty--compact' },
    h('div', { class: 'empty__art' }, icon(iconName, 24)),
    h('div', { class: 'empty__desc', text }),
  );
}

/* ══ 页签 ═══════════════════════════════════════════════════════════ */

export interface TabItem {
  value: string;
  label: string;
  icon?: IconName;
  count?: number;
}

export function tabs(items: TabItem[], value: string, onChange: (value: string) => void): HTMLElement {
  const buttons: Node[] = [];
  for (const item of items) {
    buttons.push(
      h(
        'button',
        {
          class: `tabs__item${item.value === value ? ' is-active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': item.value === value ? 'true' : 'false',
          onclick: () => onChange(item.value),
        },
        item.icon ? icon(item.icon, 16) : null,
        h('span', { text: item.label }),
        item.count !== undefined && item.count > 0
          ? h('span', { class: 'tabs__count', text: String(item.count) })
          : null,
      ),
    );
  }
  return h('div', { class: 'tabs', role: 'tablist' }, buttons);
}

/* ══ 数据展示 ═══════════════════════════════════════════════════════ */

export function kv(pairs: Array<{ key: string; value: Node | string }>): HTMLElement {
  const rows = pairs.map((pair) =>
    h(
      'div',
      { class: 'kv__row' },
      h('div', { class: 'kv__k', text: pair.key }),
      h('div', { class: 'kv__v' }, pair.value),
    ),
  );
  return h('div', { class: 'kv' }, rows);
}

export function statTile(label: string, value: string, iconName?: IconName): HTMLElement {
  return h(
    'div',
    { class: 'stat-tile' },
    h(
      'div',
      { class: 'stat-tile__label' },
      iconName ? icon(iconName, 12) : null,
      h('span', { text: label }),
    ),
    h('div', { class: 'stat-tile__value', text: value, title: value }),
  );
}

export interface RowItemOptions {
  icon?: IconName;
  title: Node | string;
  badges?: Node[];
  sub?: Node | string | Node[];
  side?: Node[];
  actions?: Node[];
}

export function rowItem(options: RowItemOptions): HTMLElement {
  const title =
    typeof options.title === 'string'
      ? h('div', { class: 'row-item__title' }, h('span', { class: 'truncate', text: options.title }), options.badges)
      : h('div', { class: 'row-item__title' }, options.title, options.badges);
  return h(
    'div',
    { class: 'row-item' },
    options.icon ? h('div', { class: 'row-item__icon' }, icon(options.icon, 16)) : null,
    h(
      'div',
      { class: 'row-item__main' },
      title,
      options.sub ? h('div', { class: 'row-item__sub' }, options.sub) : null,
    ),
    options.side ? h('div', { class: 'row-item__side' }, options.side) : null,
    options.actions ? h('div', { class: 'row-item__actions' }, options.actions) : null,
  );
}

export function rows(children: Node[]): HTMLElement {
  return h('div', { class: 'rows' }, children);
}

/* ══ 复制按钮 ═══════════════════════════════════════════════════════ */

export function copyButton(text: string, label = '复制'): HTMLButtonElement {
  const btn = h(
    'button',
    { class: 'copy-btn', type: 'button', title: label, 'aria-label': label },
    icon('copy', 14),
  );
  btn.addEventListener('click', () => {
    void copyText(text).then((done) => {
      if (done) toastSuccess('已复制到剪贴板');
      else toastError('复制失败', { detail: '当前环境不允许访问剪贴板，请手动选中文本复制。' });
    });
  });
  return btn;
}
