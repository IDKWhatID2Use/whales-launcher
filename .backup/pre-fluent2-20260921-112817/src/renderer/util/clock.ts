/**
 * 全局时钟：用**单个**定时器驱动界面上的所有"运行时长 / 相对时间"，
 * 避免每个组件各自 `setInterval` 造成定时器风暴。
 *
 * 组件只需把属性挂到 DOM 上：
 *   运行时长：`data-elapsed="<ISO 起始时间>"`
 *   相对时间：`data-relative="<ISO 时间>"`
 */
import { formatDuration, formatRelative } from './format';

let timer: number | null = null;
let ticks = 0;

export function startClock(): void {
  if (timer !== null) return;
  timer = window.setInterval(() => {
    ticks += 1;
    updateElapsed();
    if (ticks % 15 === 0) updateRelative();
  }, 1000);
  updateElapsed();
  updateRelative();
}

export function stopClock(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

function updateElapsed(): void {
  const nodes = document.querySelectorAll<HTMLElement>('[data-elapsed]');
  const now = Date.now();
  nodes.forEach((el) => {
    const since = el.dataset['elapsed'];
    if (!since) return;
    const started = Date.parse(since);
    if (Number.isNaN(started)) {
      el.textContent = '--:--:--';
      return;
    }
    el.textContent = formatDuration(now - started);
  });
}

function updateRelative(): void {
  const nodes = document.querySelectorAll<HTMLElement>('[data-relative]');
  const now = Date.now();
  nodes.forEach((el) => {
    const iso = el.dataset['relative'];
    if (!iso) return;
    el.textContent = formatRelative(iso, now);
  });
}
