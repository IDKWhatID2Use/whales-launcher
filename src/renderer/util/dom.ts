/**
 * DOM 构造与操作工具。
 *
 * `h()` 是一个极简的 hyperscript：无虚拟 DOM、无 diff，直接建真实节点。
 * 视图通过"重建局部子树"的方式更新，配合 rAF 批量调度保证性能。
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElProps {
  class?: string;
  text?: string;
  /** 仅用于本工程内手工编写的静态 SVG 字符串，禁止传入外部数据。 */
  html?: string;
  style?: Record<string, string | number | null | undefined>;
  dataset?: Record<string, string | number | null | undefined>;
  attrs?: Record<string, string | number | null | undefined>;
  [key: string]: unknown;
}

/** 创建元素。props 中 `onXxx` 为事件、`class`/`text`/`style`/`dataset`/`attrs` 有特殊语义。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, props?: ElProps | null): void {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = String(value);
      continue;
    }
    if (key === 'text') {
      el.textContent = String(value);
      continue;
    }
    if (key === 'html') {
      el.innerHTML = String(value);
      continue;
    }
    if (key === 'style' && typeof value === 'object') {
      const styles = value as Record<string, string | number | null | undefined>;
      for (const prop of Object.keys(styles)) {
        const v = styles[prop];
        if (v === null || v === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
        else el.style.setProperty(kebab(prop), String(v));
      }
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      const data = value as Record<string, string | number | null | undefined>;
      for (const prop of Object.keys(data)) {
        const v = data[prop];
        if (v === null || v === undefined) continue;
        el.dataset[prop] = String(v);
      }
      continue;
    }
    if (key === 'attrs' && typeof value === 'object') {
      const attrs = value as Record<string, string | number | null | undefined>;
      for (const prop of Object.keys(attrs)) {
        const v = attrs[prop];
        if (v === null || v === undefined) continue;
        el.setAttribute(prop, String(v));
      }
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key in el) {
      (el as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** 追加子节点，自动忽略空值。 */
export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
      continue;
    }
    parent.appendChild(child);
  }
}

/** 清空子节点。 */
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** 用新内容替换元素的全部子节点。 */
export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** 文本转义（当必须拼接 HTML 字符串时使用）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

/** 必存在的元素（用于外壳固定节点，缺失即视为致命错误）。 */
export function required<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`界面结构缺少必需节点：${selector}`);
  return el;
}

/** 聚焦元素（若可聚焦）。 */
export function focusFirst(root: ParentNode): void {
  const target = root.querySelector<HTMLElement>(
    'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  target?.focus();
}

/** 收集容器内可聚焦元素，形成 Tab 循环。 */
export function focusables(root: ParentNode): HTMLElement[] {
  const list = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(list).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** 复制文本到剪贴板（file:// 下 navigator.clipboard 可能不可用，回退 execCommand）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退路径 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const okFlag = document.execCommand('copy');
    document.body.removeChild(area);
    return okFlag;
  } catch {
    return false;
  }
}

/** 下一次动画帧（用于批处理重渲染）。 */
export function nextFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
}

/**
 * 读取 CSS 时长令牌为毫秒数。
 * 用于让 JS 侧的动画收尾（如模态退场后移除节点）与 CSS 保持同一事实源，
 * 避免出现 `setTimeout(..., 150)` 这类与 `--dur-*` 不一致的魔法数。
 */
export function tokenMs(name: string, fallback: number): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (raw.length === 0) return fallback;
    const value = Number.parseFloat(raw);
    if (Number.isNaN(value)) return fallback;
    return raw.endsWith('ms') ? value : value * 1000;
  } catch {
    return fallback;
  }
}
