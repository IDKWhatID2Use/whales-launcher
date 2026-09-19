/** 时间 / 体积 / 路径格式化（中文，桌面端习惯）。 */

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `2025-06-01 14:32` */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** `2025-06-01` */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `14:32:07` */
export function formatClock(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return '--:--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 14:32 / 3 天前 / 2025-01-02 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  const d = parse(iso);
  if (!d) return '从未启动';
  const diff = now - d.getTime();
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (d.getTime() >= startOfToday.getTime() - 86_400_000) {
    if (d.getTime() >= startOfToday.getTime()) return `${hour} 小时前`;
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (day < 30) return `${day} 天前`;
  return formatDate(iso);
}

/** 运行时长：`01:23:45`（带小时位）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 体积：`48.2 MB`；未知返回 `—`。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  const unit = units[idx] ?? 'KB';
  return `${value.toFixed(digits)} ${unit}`;
}

/**
 * 引擎体积：`0` 与 `null` 一律显示「未知」。
 *
 * core 的 `dirSize` 刻意不跟随 junction / 符号链接，因此通过链接接入的引擎会返回 0；
 * 若直接渲染成 `0 B`，用户会误以为引擎是空的（Lead 实机验收指出）。
 */
export function formatEngineSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '未知';
  return formatBytes(bytes);
}

/** 中间省略的长路径：`F:\WhalesLauncher\…\instances\我的实例` */
export function shortenPath(path: string, max = 72): string {
  if (path.length <= max) return path;
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length <= 2) return `${path.slice(0, max - 1)}…`;
  const head = parts.slice(0, 2).join('\\');
  const tailParts: string[] = [];
  for (let i = parts.length - 1; i >= 2; i -= 1) {
    const part = parts[i];
    if (part === undefined) continue;
    const candidate = [part, ...tailParts].join('\\');
    if (head.length + candidate.length + 2 > max) break;
    tailParts.unshift(part);
  }
  if (tailParts.length === 0) return `${head}\\…`;
  return `${head}\\…\\${tailParts.join('\\')}`;
}

/** 文件名与最后一段路径。 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
