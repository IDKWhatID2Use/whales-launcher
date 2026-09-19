/**
 * YAML 编辑器
 *
 * - 等宽字体 + 行号槽（与文本区滚动同步）；
 * - Tab 输入两个空格（保持 YAML 缩进习惯），Ctrl+S 触发保存；
 * - 空内容、行尾空白等前端可判定的问题就地标红。
 */
import { h } from '../util/dom';

export interface YamlEditorOptions {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  minHeight?: number;
  ariaLabel?: string;
}

export interface YamlEditorHandle {
  el: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  setInvalid(invalid: boolean): void;
  focus(): void;
  lineCount(): number;
}

export function createYamlEditor(options: YamlEditorOptions): YamlEditorHandle {
  const gutter = h('div', { class: 'yaml__gutter', 'aria-hidden': 'true' });
  const area = h('textarea', {
    class: 'yaml__area',
    spellcheck: false,
    wrap: 'off',
    value: options.value,
    'aria-label': options.ariaLabel ?? 'settings.yaml 编辑器',
  });
  if (options.minHeight !== undefined) area.style.setProperty('min-height', `${options.minHeight}px`);

  const root = h('div', { class: 'yaml' }, gutter, area);

  const renderGutter = (): void => {
    const count = Math.max(1, area.value.split('\n').length);
    const numbers: string[] = [];
    for (let i = 1; i <= count; i += 1) numbers.push(String(i));
    gutter.textContent = numbers.join('\n');
  };

  const syncScroll = (): void => {
    gutter.scrollTop = area.scrollTop;
  };

  area.addEventListener('input', () => {
    renderGutter();
    root.classList.remove('is-invalid');
    options.onChange?.(area.value);
  });
  area.addEventListener('scroll', syncScroll);
  area.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Tab') {
      event.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      const text = area.value;
      area.value = `${text.slice(0, start)}  ${text.slice(end)}`;
      area.selectionStart = area.selectionEnd = start + 2;
      renderGutter();
      options.onChange?.(area.value);
      return;
    }
    if (key === 's' && ((event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey)) {
      event.preventDefault();
      options.onSave?.();
    }
  });

  renderGutter();

  return {
    el: root,
    getValue: () => area.value,
    setValue: (value: string): void => {
      area.value = value;
      renderGutter();
      syncScroll();
    },
    setInvalid: (invalid: boolean): void => {
      root.classList.toggle('is-invalid', invalid);
    },
    focus: () => area.focus(),
    lineCount: () => area.value.split('\n').length,
  };
}
