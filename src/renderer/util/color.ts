/** 颜色工具：实例强调色的派生（头像渐变、卡片色条、文本对比）。 */

export const DEFAULT_ACCENT = '#4D8DFF';

/** 新建实例时可选的强调色。 */
export const ACCENT_PRESETS = [
  '#4D8DFF',
  '#7C5CFF',
  '#2FB8A8',
  '#35C98A',
  '#F0A934',
  '#F2555A',
  '#EC6AA8',
  '#5B6B7F',
] as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

export function normalizeHex(value: string, fallback = DEFAULT_ACCENT): string {
  const v = value.trim();
  if (!isHexColor(v)) return fallback;
  if (v.length === 4) {
    const r = v[1] ?? '0';
    const g = v[2] ?? '0';
    const b = v[3] ?? '0';
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return v.toUpperCase();
}

function toRgb(hex: string): Rgb {
  const v = normalizeHex(hex);
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16),
  };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** 提亮（amount > 0）或压暗（amount < 0），范围 -1..1。 */
export function shade(hex: string, amount: number): string {
  const { r, g, b } = toRgb(hex);
  if (amount >= 0) {
    return toHex({
      r: r + (255 - r) * amount,
      g: g + (255 - g) * amount,
      b: b + (255 - b) * amount,
    });
  }
  const k = 1 + amount;
  return toHex({ r: r * k, g: g * k, b: b * k });
}

/** `rgba()` 字符串。 */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = toRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 头像 / 徽标的渐变背景。 */
export function gradientFor(hex: string): string {
  const base = normalizeHex(hex);
  return `linear-gradient(140deg, ${shade(base, 0.18)} 0%, ${shade(base, -0.28)} 100%)`;
}

/** 在给定底色上取可读的前景色。 */
export function readableOn(hex: string): string {
  const { r, g, b } = toRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#10161F' : '#FFFFFF';
}

/** 给目录 / 会话生成稳定的色相（无实例色时使用）。 */
export function hashHue(text: string, saturation = 62, lightness = 52): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} ${saturation}% ${lightness}%)`;
}
