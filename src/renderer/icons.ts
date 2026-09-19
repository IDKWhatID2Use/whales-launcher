/**
 * 内联 SVG 图标集
 *
 * 全部为手写静态路径，不依赖任何图标字体或 CDN。
 * 统一 24×24 视窗、1.8 描边、圆头圆角，保证视觉重量一致。
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 图标内容（`<svg>` 的子节点，静态字符串，无任何外部输入）。 */
const PATHS = {
  whale:
    '<path d="M2.8 13.6C2.8 9.9 5.9 7 9.7 7h4.6c1.5 0 2.8.6 3.8 1.5l3.1-1.8-.7 3.1 2.1 1.5-2.6 1.1c-.7 3.4-3.7 5.9-7.3 5.9H9.6C5.6 18.3 2.8 16 2.8 13.6Z"/><path d="M9.6 7c0-2.2 1.6-4 3.6-4.4"/><circle cx="8.2" cy="12.4" r="1.1"/>',
  /**
   * 品牌剪影（**实心**）：只用于 20px 应用标记与空态插画。
   * 描边版 `whale` 在 14–28px 下会糊成一团（Lead 实机截图确认），故品牌位改用剪影；
   * UI 图标仍全部线性。眼睛用 evenodd 挖空，因此在任何底色上都成立。
   */
  whaleMark:
    '<path fill="currentColor" stroke="none" fill-rule="evenodd" clip-rule="evenodd" d="M2.8 14.6c0-3.3 2.7-6 6-6h4.4c1.6 0 3 .6 4.1 1.6l3.5-2-.8 3.3 2.6 1.6-3 1.2c-.7 3.2-3.6 5.6-7 5.6H9.2c-3.5 0-6.4-2.4-6.4-5.3Zm5 1.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7.5 4.8v14.4L19.5 12z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4" fill="currentColor" stroke="none"/>',
  settings:
    '<path d="M4 7.5h8.5M17 7.5h3M4 16.5h3M11.5 16.5H20"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9.2" cy="16.5" r="2.2"/>',
  package:
    '<path d="M3.4 7.6 12 3.1l8.6 4.5v8.9L12 21l-8.6-4.5z"/><path d="M3.4 7.6 12 12.1l8.6-4.5M12 12.1V21"/>',
  puzzle:
    '<path d="M10 3.6a2 2 0 0 1 4 0V5h2.4A1.6 1.6 0 0 1 18 6.6V9h1.4a2 2 0 0 1 0 4H18v2.4a1.6 1.6 0 0 1-1.6 1.6H14v1.4a2 2 0 0 1-4 0V17H7.6A1.6 1.6 0 0 1 6 15.4V13H4.6a2 2 0 0 1 0-4H6V6.6A1.6 1.6 0 0 1 7.6 5H10z"/>',
  fileText:
    '<path d="M13.8 3.2H7.4A2.2 2.2 0 0 0 5.2 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V8.4z"/><path d="M13.8 3.2v5.2h5M9 13.4h6M9 16.8h4"/>',
  folder:
    '<path d="M3.4 7.6A2.2 2.2 0 0 1 5.6 5.4h3.1a2 2 0 0 1 1.6.8l1 1.3h7.1a2.2 2.2 0 0 1 2.2 2.2v7.7a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2z"/>',
  terminal:
    '<rect x="2.9" y="4.9" width="18.2" height="14.2" rx="2.2"/><path d="M7 10.2 9.6 12.8 7 15.4M12.6 15.4h4.2"/>',
  layers:
    '<path d="M12 3 3.4 7.4 12 11.8l8.6-4.4z"/><path d="M3.4 12.4 12 16.8l8.6-4.4M3.4 16.6 12 21l8.6-4.4"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 4.2 4.2"/>',
  trash:
    '<path d="M4.2 7.2h15.6M9.6 4.6h4.8M6.6 7.2l.7 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.7-12"/><path d="M10.6 11v5.6M13.4 11v5.6"/>',
  external:
    '<path d="M14.2 4.6h5.2v5.2"/><path d="M19.4 4.6 11.8 12.2"/><path d="M18 14.6v3.2a2.2 2.2 0 0 1-2.2 2.2H6.2A2.2 2.2 0 0 1 4 17.8V8.2A2.2 2.2 0 0 1 6.2 6h3.2"/>',
  refresh:
    '<path d="M20.2 11.4a8.2 8.2 0 1 0-2.4 6.2"/><path d="M20.2 5.6v5.8h-5.8"/>',
  reload:
    '<path d="M3.8 11.4a8.2 8.2 0 1 1 2.4 6.2"/><path d="M3.8 5.6v5.8h5.8"/>',
  close: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  check: '<path d="m5.2 12.6 4.6 4.6L18.8 7.2"/>',
  alertTriangle:
    '<path d="M12 4.1 2.9 19.4h18.2z"/><path d="M12 9.8v4.4M12 17.1h.02"/>',
  alertCircle:
    '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.8v5M12 15.6h.02"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v4.6M12 8.2h.02"/>',
  chevronRight: '<path d="m9.6 5.6 6.4 6.4-6.4 6.4"/>',
  chevronDown: '<path d="m5.6 9.4 6.4 6.4 6.4-6.4"/>',
  arrowLeft: '<path d="M19 12H5.4M11 5.4 4.4 12l6.6 6.6"/>',
  arrowDown: '<path d="M12 4.8v13.4M6.6 12.8 12 18.2l5.4-5.4"/>',
  pencil:
    '<path d="M4.6 19.4h4l10-10a2.05 2.05 0 0 0-2.9-2.9l-10 10z"/><path d="m14.6 6.4 3 3"/>',
  download:
    '<path d="M12 4v10.6M7.6 10.4 12 14.8l4.4-4.4"/><path d="M4.8 18.8h14.4"/>',
  upload: '<path d="M12 14.8V4.2M7.6 8.6 12 4.2l4.4 4.4"/><path d="M4.8 18.8h14.4"/>',
  copy: '<rect x="8.6" y="8.6" width="10.8" height="10.8" rx="2.2"/><path d="M15.4 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v8.8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M5.4 18.6 7 17M17 7l1.6-1.6"/>',
  moon: '<path d="M20.2 13.6A8.6 8.6 0 0 1 10.4 3.8a8.6 8.6 0 1 0 9.8 9.8z"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 2"/>',
  disk: '<rect x="3.2" y="6.6" width="17.6" height="10.8" rx="2.2"/><path d="M4.6 13.4h14.8M7.4 16.6h.02M10.6 16.6h.02"/>',
  filter: '<path d="M4 6.2h16l-6.2 7.4V19l-3.6-2v-3.4z"/>',
  cpu: '<rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2.2"/><path d="M10.4 3.6v3.6M13.6 3.6v3.6M10.4 16.8v3.6M13.6 16.8v3.6M3.6 10.4h3.6M3.6 13.6h3.6M16.8 10.4h3.6M16.8 13.6h3.6"/>',
  shield: '<path d="M12 3.2 5.2 6v5.6c0 4.3 2.8 7.6 6.8 9.2 4-1.6 6.8-4.9 6.8-9.2V6z"/>',
  link: '<path d="M10.2 13.8a4.2 4.2 0 0 0 5.9 0l2.6-2.6a4.2 4.2 0 0 0-5.9-5.9l-1.3 1.3"/><path d="M13.8 10.2a4.2 4.2 0 0 0-5.9 0l-2.6 2.6a4.2 4.2 0 0 0 5.9 5.9l1.3-1.3"/>',
  key: '<circle cx="8.2" cy="14.2" r="3.6"/><path d="m10.8 11.6 8-8M15.4 7l2.4 2.4M12.8 9.6l2.4 2.4"/>',
  sparkles:
    '<path d="M11.4 3.8 13 8.4l4.6 1.6-4.6 1.6-1.6 4.6-1.6-4.6L5.2 10l4.6-1.6z"/><path d="m18.2 15.4.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75z"/>',
  more: '<circle cx="5.6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.4" cy="12" r="1.5"/>',
  list: '<path d="M8.4 6.6h11.2M8.4 12h11.2M8.4 17.4h11.2M4.4 6.6h.02M4.4 12h.02M4.4 17.4h.02"/>',
  save: '<path d="M5.4 4.6h9.4l4.8 4.8v9.4a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V6.2a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M8.6 4.6v4.8h5.8V4.6M8.4 15.4h7.2"/>',
  globe:
    '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c2.3 2.4 3.5 5.3 3.5 8.4S14.3 18 12 20.4C9.7 18 8.5 15.1 8.5 12S9.7 6 12 3.6z"/>',
  power: '<path d="M12 3.6v8.2"/><path d="M7.4 6.6a7 7 0 1 0 9.2 0"/>',
  cube: '<path d="m12 3.4 7.4 3.9v9.4L12 20.6l-7.4-3.9V7.3z"/><path d="m4.6 7.3 7.4 3.9 7.4-3.9M12 11.2v9.4"/>',
  archive:
    '<rect x="3.4" y="4.6" width="17.2" height="4.4" rx="1.4"/><path d="M5.2 9v9a1.6 1.6 0 0 0 1.6 1.6h10.4A1.6 1.6 0 0 0 18.8 18V9"/><path d="M10 12.4h4"/>',
  wand: '<path d="M4.4 19.6 15 9M14.2 4.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/><path d="M19.4 13.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** 图标名清单（供文档与遍历使用）。 */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** 允许的图标显示尺寸档（≤6 档；24/28 属空态插画「图形档」）。 */
export const ICON_SIZES = [12, 14, 16, 18, 20] as const;

/**
 * 描边分档（判据 I4-3）：粗描系数 = 描边 px ÷ 显示尺寸，必须落在 [7%, 12%]。
 * 固定 1.8 会在 12px 下达到 15%（过粗），因此按显示尺寸分档。
 */
function strokeFor(size: number): number {
  if (size <= 12) return 1.4;
  if (size <= 15) return 1.6;
  if (size <= 21) return 1.8;
  return 2;
}

/**
 * 创建图标元素。
 * @param name 图标名
 * @param size 边长（px），请取 ICON_SIZES 中的档位
 * @param className 追加的 class
 */
export function icon(name: IconName, size = 16, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeFor(size)));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  // PATHS 为编译期常量，不含任何外部输入。
  svg.innerHTML = PATHS[name];
  return svg;
}
