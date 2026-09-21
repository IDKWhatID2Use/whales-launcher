/** 供多个视图复用的界面片段（模板目录、头像、图标/配色选择器、隔离策略）。 */
import { BUNDLE_TEMPLATES, type CredentialsMode, type InstanceMeta, type ShareMode } from '../../shared/contracts';
import { icon } from '../icons';
import { h } from '../util/dom';
import { ACCENT_PRESETS, gradientFor, isHexColor, normalizeHex } from '../util/color';
import { field, segmented } from '../components/ui';

/* ── profile 模板目录 ─────────────────────────────────────────── */

export interface TemplateInfo {
  value: string;
  label: string;
  desc: string;
  recommended?: boolean;
}

export const TEMPLATES: TemplateInfo[] = [
  {
    value: 'web',
    label: 'Web 界面',
    desc: '带本地 Web 界面，适合日常交互；启动后自动探测界面地址。',
    recommended: true,
  },
  {
    value: 'headless',
    label: '无界面批处理',
    desc: '一次性执行任务并输出最终结果，适合定时任务与脚本。',
  },
  {
    value: 'sdk',
    label: 'SDK 服务',
    desc: 'JSON-RPC stdio 服务，供其它程序嵌入调用。',
  },
  {
    value: 'sdk-minimal',
    label: '最小 SDK',
    desc: '仅含最小运行时的 SDK 模式，启动最快、占用最低。',
  },
  {
    value: 'acp',
    label: 'ACP 服务',
    desc: 'ACP stdio 协议服务，对接编辑器与 IDE 插件。',
  },
];

export function templateInfo(value: string): TemplateInfo {
  return (
    TEMPLATES.find((t) => t.value === value) ?? {
      value,
      label: value,
      desc: '自定义模板',
    }
  );
}

/** 模板对应的组合包列表。 */
export function templateBundles(value: string): string[] {
  return BUNDLE_TEMPLATES[value] ?? ['@deepseek-ai/dsh-base'];
}

/* ── 文案映射 ─────────────────────────────────────────────────── */

export const SHARE_MODE_LABEL: Record<ShareMode, string> = {
  local: '独立',
  shared: '共享',
};

export const CREDENTIALS_LABEL: Record<CredentialsMode, string> = {
  inherit: '继承主 home',
  local: '实例独立',
};

export function shareModeText(mode: ShareMode): string {
  return SHARE_MODE_LABEL[mode];
}

/* ── 头像 ─────────────────────────────────────────────────────── */

export interface AvatarSource {
  name: string;
  icon: string | null;
  color: string;
}

export function avatar(source: AvatarSource, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const color = normalizeHex(source.color);
  const content = source.icon && source.icon.trim().length > 0 ? source.icon : source.name.slice(0, 1).toUpperCase();
  return h('div', {
    class: `inst-avatar${size === 'md' ? '' : ` inst-avatar--${size}`}`,
    style: { '--avatar-bg': gradientFor(color) },
    'aria-hidden': 'true',
    text: content,
    title: source.name,
  });
}

/* ── 图标选择 ─────────────────────────────────────────────────── */

export const EMOJI_CHOICES = [
  '🐳',
  '🤖',
  '🧩',
  '🛠️',
  '📦',
  '🚀',
  '🧠',
  '📊',
  '🔧',
  '🌊',
  '⚡',
  '🎯',
  '📝',
  '🔍',
  '🧪',
  '🖥️',
  '☁️',
  '🎨',
  '🛰️',
  '🦾',
  '📥',
  '🗂️',
  '🧭',
  '🔮',
];

export interface IconPickerHandle {
  el: HTMLElement;
  getValue(): string | null;
}

export function iconPicker(initial: string | null, onChange: (value: string | null) => void): IconPickerHandle {
  let current = initial;
  const grid = h('div', { class: 'emoji-grid' });
  const custom = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '4',
    placeholder: '自定义（emoji 或 1 个字符）',
    value: initial && !EMOJI_CHOICES.includes(initial) ? initial : '',
    oninput: () => {
      const value = custom.value.trim();
      current = value.length > 0 ? value : null;
      onChange(current);
      sync();
    },
  });

  const buttons = new Map<string, HTMLButtonElement>();
  const sync = (): void => {
    for (const [emoji, btn] of buttons) {
      btn.classList.toggle('is-active', emoji === current);
    }
  };

  for (const emoji of EMOJI_CHOICES) {
    const btn = h(
      'button',
      {
        class: 'emoji-btn',
        type: 'button',
        title: `使用 ${emoji}`,
        'aria-label': `图标 ${emoji}`,
        onclick: () => {
          current = emoji;
          custom.value = '';
          onChange(current);
          sync();
        },
      },
      emoji,
    );
    buttons.set(emoji, btn);
    grid.appendChild(btn);
  }

  const clear = h(
    'button',
    {
      class: 'emoji-btn',
      type: 'button',
      title: '不使用图标（显示名称首字）',
      'aria-label': '清除图标',
      onclick: () => {
        current = null;
        custom.value = '';
        onChange(null);
        sync();
      },
    },
    icon('close', 16),
  );
  grid.appendChild(clear);
  sync();

  return {
    el: h('div', { class: 'stack stack--tight' }, grid, custom),
    getValue: () => current,
  };
}

/* ── 配色选择 ─────────────────────────────────────────────────── */

export interface ColorPickerHandle {
  el: HTMLElement;
  getValue(): string;
}

export function colorPicker(initial: string, onChange: (value: string) => void): ColorPickerHandle {
  let current = normalizeHex(initial);
  const swatches = new Map<string, HTMLButtonElement>();
  const custom = h('input', {
    class: 'color-input',
    type: 'color',
    value: current,
    title: '自定义颜色',
    'aria-label': '自定义强调色',
    oninput: () => {
      current = normalizeHex(custom.value, current);
      onChange(current);
      sync();
    },
  });

  const sync = (): void => {
    for (const [hex, btn] of swatches) btn.classList.toggle('is-active', hex === current);
    custom.value = isHexColor(current) ? current : '#4D8DFF';
  };

  const row = h('div', { class: 'swatches' });
  for (const hex of ACCENT_PRESETS) {
    const btn = h(
      'button',
      {
        class: 'swatch',
        type: 'button',
        style: { background: hex },
        title: hex,
        'aria-label': `强调色 ${hex}`,
        onclick: () => {
          current = hex;
          onChange(current);
          sync();
        },
      },
      null,
    );
    swatches.set(hex, btn);
    row.appendChild(btn);
  }
  row.appendChild(custom);
  sync();

  return { el: row, getValue: () => current };
}

/* ── 隔离策略行 ───────────────────────────────────────────────── */

export interface IsolationRowOptions<T extends string> {
  label: string;
  desc: string;
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}

export function isolationRow<T extends string>(options: IsolationRowOptions<T>): HTMLElement {
  return h(
    'div',
    { class: 'option-row' },
    h(
      'div',
      { class: 'option-row__main' },
      h('div', { class: 'option-row__title', text: options.label }),
      h('div', { class: 'option-row__desc', text: options.desc }),
    ),
    segmented<T>({
      options: options.options,
      value: options.value,
      onChange: options.onChange,
      ariaLabel: options.label,
    }),
  );
}

/* ── 名称输入（带实时校验） ───────────────────────────────────── */

export interface NameFieldHandle {
  el: HTMLElement;
  input: HTMLInputElement;
  getValue(): string;
  validate(): string | null;
}

export function nameField(options: {
  value: string;
  placeholder?: string;
  label?: string;
  hint?: string;
  validate: (value: string) => string | null;
  onChange?: (value: string, error: string | null) => void;
}): NameFieldHandle {
  const input = h('input', {
    class: 'input',
    type: 'text',
    value: options.value,
    placeholder: options.placeholder ?? '例如：我的工作台',
    maxlength: '64',
    autocomplete: 'off',
    oninput: () => update(),
  });
  const messageBox = h('div', { class: 'field__hint' });
  const wrap = h('div', { class: 'stack stack--tight' }, input, messageBox);

  const update = (): void => {
    const error = options.validate(input.value);
    input.classList.toggle('is-invalid', error !== null && input.value.length > 0);
    if (input.value.length === 0) {
      messageBox.className = 'field__hint';
      messageBox.textContent = options.hint ?? '';
    } else if (error) {
      messageBox.className = 'field__error';
      messageBox.textContent = error;
    } else {
      messageBox.className = 'field__ok';
      messageBox.textContent = options.hint ?? '名称可用';
    }
    options.onChange?.(input.value, error);
  };
  update();

  return {
    el: options.label ? field({ label: options.label, control: wrap, required: true }) : wrap,
    input,
    getValue: () => input.value,
    validate: () => options.validate(input.value),
  };
}

/* ── 实例信息摘要（详情头部 / 向导预览共用） ───────────────────── */

export function metaChips(meta: InstanceMeta): HTMLElement[] {
  const chips: HTMLElement[] = [
    h('span', { class: 'chip', text: meta.engine.version, title: `引擎版本 ${meta.engine.version}` }),
    h('span', {
      class: 'chip',
      text: templateInfo(meta.profile.template).label,
      title: `profile：${meta.profile.name}（模板 ${meta.profile.template}）`,
    }),
  ];
  if (meta.saves.mode === 'shared' || meta.workspace.mode === 'shared') {
    chips.push(h('span', { class: 'chip chip--accent', text: '存档共享', title: '会话或工作区链接到共享库' }));
  }
  if (meta.credentials.mode === 'inherit') {
    chips.push(h('span', { class: 'chip', text: '凭证继承', title: '启动前从主 home 同步凭证' }));
  }
  return chips;
}
