/**
 * 日志视图
 *
 * - 等宽字体，按 stdout / stderr / system 分色（左侧色条 + 文字色，双通道）；
 * - 自动滚动：仅当用户已经在底部时跟随；上滚后暂停并显示「回到底部」；
 * - 增量渲染：只追加新行，DOM 行数超上限时批量裁剪旧行；
 * - 支持流过滤、清空、行数统计与"较早日志已截断"提示。
 */
import { icon } from '../icons';import { createBatcher } from '../util/batch';
import { clear, h } from '../util/dom';
import { formatClock } from '../util/format';
import { logStore, type LogLine, type LogStream } from '../data/logs';
import { segmented } from './ui';

const MAX_RENDERED = 1500;

export interface LogViewOptions {
  /** 采集哪个实例的日志；`undefined` = 全部实例。 */
  instanceId?: string | undefined;
  toolbar?: boolean;
  extraActions?: Node[];
  emptyText?: string;
  /** 全部实例模式下，为每行给出实例名前缀。 */
  labelFor?: (instanceId: string) => string;
  showFooter?: boolean;
  follow?: boolean;
}

export interface LogViewHandle {
  el: HTMLElement;
  destroy(): void;
  scrollToBottom(): void;
  clearLogs(): void;
  markPaused(): void;
}

type FilterValue = 'all' | LogStream;

export function createLogView(options: LogViewOptions = {}): LogViewHandle {
  const key = options.instanceId;
  const labelFor = options.labelFor;
  let filter: FilterValue = 'all';
  let follow = options.follow !== false;
  let lastSeq = 0;
  let rendered = 0;
  let destroyed = false;

  const scrollBox = h('div', { class: 'logview__scroll', tabindex: '0', role: 'log', 'aria-label': '运行日志' });
  const emptyBox = h('div', {
    class: 'logview__empty',
    text: options.emptyText ?? '暂无日志。启动实例后，这里的输出会实时刷新。',
  });
  const jump = h(
    'button',
    {
      class: 'logview__jump',
      type: 'button',
      onclick: () => {
        follow = true;
        syncFollowUi();
        scrollToBottom();
      },
    },
    icon('arrowDown', 14),
    h('span', { text: '回到底部' }),
  );
  const footLeft = h('span', { class: 'muted' });
  const body = h('div', { class: 'logview__body' }, scrollBox, jump);
  const root = h('div', { class: 'logview' });

  if (options.toolbar !== false) {
    const bar = h('div', { class: 'logview__bar' });
    bar.appendChild(
      segmented<FilterValue>(
        {
          options: [
            { value: 'all', label: '全部' },
            { value: 'stdout', label: 'stdout' },
            { value: 'stderr', label: 'stderr' },
            { value: 'system', label: '系统' },
          ],
          value: filter,
          onChange: (value) => {
            filter = value;
            rebuild();
          },
          ariaLabel: '日志流过滤',
        },
      ),
    );
    bar.appendChild(h('div', { class: 'toolbar__spacer' }));
    if (options.extraActions) {
      for (const action of options.extraActions) bar.appendChild(action);
    }
    bar.appendChild(
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          title: follow ? '暂停自动滚动' : '恢复自动滚动',
          onclick: () => {
            follow = !follow;
            syncFollowUi();
            if (follow) scrollToBottom();
          },
        },
        h('span', { class: 'btn__label' }, icon('arrowDown', 14), h('span', { text: follow ? '自动滚动' : '已暂停' })),
      ),
    );
    bar.appendChild(
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          title: '清空当前视图的日志',
          onclick: () => handle.clearLogs(),
        },
        h('span', { class: 'btn__label' }, icon('close', 14), h('span', { text: '清空' })),
      ),
    );
    root.appendChild(bar);
  }

  root.appendChild(body);
  if (options.showFooter !== false) {
    root.appendChild(h('div', { class: 'logview__foot' }, footLeft));
  }

  function currentLines(): LogLine[] {
    return logStore.snapshot(key);
  }

  function matches(line: LogLine): boolean {
    return filter === 'all' || line.stream === filter;
  }

  function buildLine(line: LogLine): HTMLElement {
    const prefix = labelFor && key === undefined ? labelFor(line.instanceId) : '';
    return h(
      'div',
      { class: `logline logline--${line.stream}` },
      h('span', { class: 'logline__ts', text: formatClock(line.ts) }),
      h('span', { class: 'logline__stream', text: line.stream }),
      h('span', { class: 'logline__text', text: prefix ? `[${prefix}] ${line.text}` : line.text }),
    );
  }

  function trim(): void {
    if (rendered <= MAX_RENDERED) return;
    const excess = rendered - MAX_RENDERED;
    for (let i = 0; i < excess; i += 1) {
      const first = scrollBox.firstElementChild;
      if (!first) break;
      first.remove();
    }
    rendered = Math.max(0, rendered - excess);
  }

  function appendLines(lines: readonly LogLine[]): void {
    if (lines.length === 0) return;
    const atBottom = isAtBottom();
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      if (!matches(line)) continue;
      fragment.appendChild(buildLine(line));
      rendered += 1;
    }
    if (fragment.childNodes.length > 0) {
      scrollBox.appendChild(fragment);
      trim();
    }
    emptyBox.hidden = rendered > 0;
    if (follow || atBottom) {
      follow = true;
      scrollToBottom();
    }
    syncFollowUi();
    syncFooter();
  }

  function rebuild(): void {
    clear(scrollBox);
    rendered = 0;
    const lines = currentLines();
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      if (!matches(line)) continue;
      fragment.appendChild(buildLine(line));
      rendered += 1;
      if (rendered >= MAX_RENDERED) break;
    }
    scrollBox.appendChild(fragment);
    lastSeq = logStore.lastSeq;
    emptyBox.hidden = rendered > 0;
    if (follow) scrollToBottom();
    syncFollowUi();
    syncFooter();
  }

  function isAtBottom(): boolean {
    return scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 28;
  }

  function scrollToBottom(): void {
    scrollBox.scrollTop = scrollBox.scrollHeight;
  }

  function syncFollowUi(): void {
    jump.classList.toggle('is-visible', !follow && rendered > 0);
  }

  function syncFooter(): void {
    const total = logStore.count(key);
    const dropped = logStore.droppedCount;
    const parts = [`${total} 行`];
    if (rendered < total) parts.push(`视图显示最近 ${rendered} 行`);
    if (dropped > 0) parts.push(`较早日志已截断 ${dropped} 行`);
    parts.push(follow ? '自动滚动' : '已暂停');
    footLeft.textContent = parts.join(' · ');
  }

  scrollBox.addEventListener('scroll', () => {
    const atBottom = isAtBottom();
    if (atBottom && !follow) {
      follow = true;
      syncFollowUi();
      syncFooter();
    } else if (!atBottom && follow) {
      follow = false;
      syncFollowUi();
      syncFooter();
    }
  });

  const flushBatched = createBatcher(() => {
    if (destroyed) return;
    const incoming = logStore.since(lastSeq, key);
    if (incoming.length === 0) {
      // 内容被清空的情况：视图需要跟着清空
      if (logStore.count(key) < rendered) rebuild();
      return;
    }
    lastSeq = logStore.lastSeq;
    appendLines(incoming);
  });

  const unsubscribe = logStore.subscribe(flushBatched);

  scrollBox.appendChild(emptyBox);
  rebuild();

  const handle: LogViewHandle = {
    el: root,
    destroy(): void {
      destroyed = true;
      unsubscribe();
    },
    scrollToBottom(): void {
      follow = true;
      syncFollowUi();
      scrollToBottom();
    },
    clearLogs(): void {
      logStore.clear(key);
      rebuild();
    },
    markPaused(): void {
      follow = false;
      syncFollowUi();
    },
  };

  // 首次挂载时补齐（store 可能已有历史行）
  rebuild();
  return handle;
}

/** 日志流的中文说明（界面悬浮提示用）。 */
export const STREAM_LABEL: Record<LogStream, string> = {
  stdout: '标准输出',
  stderr: '错误输出',
  system: '系统消息',
};
