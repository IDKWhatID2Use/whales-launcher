/**
 * 生成 `assets/whales.ico`（多尺寸应用图标）。
 *
 * 为什么自己画而不是找一张图：
 *   仓库里没有任何图形资产（截图是界面截图，不是图标），而图标必须存在才能
 *   让**桌面快捷方式 / 任务栏 / 窗口**显示成 WhalesLauncher 而不是 Electron 的
 *   默认原子图标。因此这里用**零依赖**的方式程序化生成：自写 PNG 编码（zlib 是
 *   Node 内置）+ 自写 box/bilinear 缩放 + 自写 ICO 封装，不引入 canvas / sharp
 *   这类需要编译或联网下载的原生依赖（本机连不上 github，装不了）。
 *
 * 设计：Fluent 风格的圆角方块底 + 白色鲸鱼剪影。鲸鱼用「有符号覆盖率」求交
 *   （身体椭圆 ∩ 尾部多边形，减去眼睛与嘴），全程按**覆盖率**做抗锯齿，
 *   因此 16×16 下依然可辨认。
 *
 * 输出尺寸：256 / 128 / 64 / 48 / 32 / 16（PNG 压缩，Windows Vista 起支持）。
 * 用法：`node scripts/make-icon.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'assets', 'whales.ico');

/** 设计画布边长（所有几何量都按这个坐标系给出）。 */
const N = 256;
/** 图标底色（左上 → 右下渐变，取自界面的强调色系）。 */
const BG_FROM = [0x7a, 0xb7, 0xff];
const BG_TO = [0x12, 0x3a, 0x68];
/** 圆角半径。 */
const RADIUS = 56;
/** 超采样倍率：3 倍下 16×16 的每个目标像素仍有 9 个采样点。 */
const SS = 3;

/* ------------------------------------------------------------------ *
 * 几何：鲸鱼剪影
 * ------------------------------------------------------------------ */

/** 身体椭圆：圆心与半径。 */
const BODY = { cx: 122, cy: 138, rx: 98, ry: 64 };
/** 眼睛（身体内部挖空的小椭圆）。 */
const EYE = { cx: 58, cy: 120, rx: 11.5, ry: 13.5 };
/** 尾巴上缘/下缘的起点（身体右侧偏上/偏下）。 */
const TAIL_TOP = { x: 150, y: 100 };
const TAIL_BOTTOM = { x: 156, y: 180 };
/** 尾鳍外缘的两个顶点与缺口顶点。 */
const TAIL_OUTER_TOP = { x: 238, y: 52 };
const TAIL_OUTER_BOTTOM = { x: 244, y: 230 };
const TAIL_NOTCH = { x: 178, y: 140 };
/** 喷水：三个小圆（水柱）。 */
const SPOUT = [
  { cx: 90, cy: 30, r: 11 },
  { cx: 66, cy: 44, r: 8 },
  { cx: 114, cy: 44, r: 8 },
];

/** 三次贝塞尔采样成折线。 */
function cubic(p0, p1, p2, p3, steps = 48) {
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    out.push({ x, y });
  }
  return out;
}

/**
 * 嘴：**不画**。
 * 试过用圆环弧线画「微笑」，但在 16–48px 下它会和眼睛连成一坨（看起来像问号而不是嘴）。
 * 少一个细节反而更清楚 —— 剪影 + 眼睛 + 喷水已经足够读出「鲸鱼」。
 */


/**
 * 尾部多边形：身体内上衔接点 → 尾鳍外缘上尖 → 缺口 → 尾鳍外缘下尖 → 身体内下衔接点。
 * 顶点顺序无所谓（射线法对两种绕向都成立），关键是首尾都落在身体内部，衔接处不会露缝。
 */
const TAIL_POLYGON = [
  TAIL_TOP,
  ...cubic(TAIL_TOP, { x: 182, y: 84 }, { x: 210, y: 62 }, TAIL_OUTER_TOP),
  TAIL_NOTCH,
  TAIL_OUTER_BOTTOM,
  ...cubic(TAIL_OUTER_BOTTOM, { x: 210, y: 210 }, { x: 182, y: 192 }, TAIL_BOTTOM),
];

/** 射线法：点是否在多边形内。 */
function inPolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > y !== b.y > y) {
      const cross = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < cross) inside = !inside;
    }
  }
  return inside;
}

const inEllipse = (e, x, y) => ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2 <= 1;

/** 圆角矩形的有符号覆盖：返回该点是否落在底板上。 */
function inRoundedRect(x, y) {
  const minX = 0;
  const minY = 0;
  const maxX = N;
  const maxY = N;
  if (x < minX || y < minY || x > maxX || y > maxY) return false;
  const innerMinX = minX + RADIUS;
  const innerMaxX = maxX - RADIUS;
  const innerMinY = minY + RADIUS;
  const innerMaxY = maxY - RADIUS;
  if (x >= innerMinX && x <= innerMaxX) return true;
  if (y >= innerMinY && y <= innerMaxY) return true;
  const cx = x < innerMinX ? innerMinX : innerMaxX;
  const cy = y < innerMinY ? innerMinY : innerMaxY;
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS * RADIUS;
}

/** 该点是否属于鲸鱼（含喷水），眼睛为挖空。 */
function inWhale(x, y) {
  if (inEllipse(EYE, x, y)) return false;
  if (inEllipse(BODY, x, y)) return true;
  if (inPolygon(TAIL_POLYGON, x, y)) return true;
  for (const drop of SPOUT) {
    if ((x - drop.cx) ** 2 + (y - drop.cy) ** 2 <= drop.r * drop.r) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 光栅化（RGBA8，直通 alpha）
 * ------------------------------------------------------------------ */

function renderCanvas() {
  const side = N * SS;
  const rgba = Buffer.alloc(side * side * 4);
  const samples = SS * SS;
  const diagonal = 2 * N;

  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      let plate = 0;
      let whale = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / SS;
          const y = (py + (sy + 0.5) / SS) / SS;
          if (inRoundedRect(x, y)) {
            plate += 1;
            if (inWhale(x, y)) whale += 1;
          }
        }
      }
      if (plate === 0) continue;
      const alpha = plate / samples;
      const white = whale / plate; // 鲸鱼占底板的比重（鲸鱼必然在底板内）
      const x = px / SS;
      const y = py / SS;
      const t = Math.min(1, Math.max(0, (x + y) / diagonal));
      const offset = (py * side + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = BG_FROM[channel] + (BG_TO[channel] - BG_FROM[channel]) * t;
        rgba[offset + channel] = Math.round(base + (255 - base) * white);
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ *
 * 缩放（预乘 alpha + box 过滤，避免透明边缘发黑）
 * ------------------------------------------------------------------ */

function toPremultiplied(rgba, side) {
  const out = new Float64Array(side * side * 4);
  for (let i = 0; i < side * side; i += 1) {
    const alpha = rgba[i * 4 + 3] / 255;
    out[i * 4] = rgba[i * 4] * alpha;
    out[i * 4 + 1] = rgba[i * 4 + 1] * alpha;
    out[i * 4 + 2] = rgba[i * 4 + 2] * alpha;
    out[i * 4 + 3] = alpha * 255;
  }
  return out;
}

/** 精确 1/k 缩小（k 为整数），用 box 平均。 */
function shrinkExact(src, side, factor) {
  const target = side / factor;
  const out = new Float64Array(target * target * 4);
  const area = factor * factor;
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const offset = ((y * factor + dy) * side + (x * factor + dx)) * 4;
          r += src[offset];
          g += src[offset + 1];
          b += src[offset + 2];
          a += src[offset + 3];
        }
      }
      const outOffset = (y * target + x) * 4;
      out[outOffset] = r / area;
      out[outOffset + 1] = g / area;
      out[outOffset + 2] = b / area;
      out[outOffset + 3] = a / area;
    }
  }
  return out;
}

/** 任意尺寸缩放：box 过滤（预乘空间）。 */
function resize(src, side, target) {
  const out = new Float64Array(target * target * 4);
  const scale = side / target;
  for (let y = 0; y < target; y += 1) {
    const y0 = y * scale;
    const y1 = (y + 1) * scale;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(side, Math.max(iy0 + 1, Math.ceil(y1)));
    for (let x = 0; x < target; x += 1) {
      const x0 = x * scale;
      const x1 = (x + 1) * scale;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(side, Math.max(ix0 + 1, Math.ceil(x1)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = iy0; sy < iy1; sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const offset = (sy * side + sx) * 4;
          r += src[offset] * w;
          g += src[offset + 1] * w;
          b += src[offset + 2] * w;
          a += src[offset + 3] * w;
          weight += w;
        }
      }
      const outOffset = (y * target + x) * 4;
      out[outOffset] = r / weight;
      out[outOffset + 1] = g / weight;
      out[outOffset + 2] = b / weight;
      out[outOffset + 3] = a / weight;
    }
  }
  return out;
}

/** 预乘 → 直通 alpha 的 RGBA8。 */
function fromPremultiplied(src, side) {
  const out = Buffer.alloc(side * side * 4);
  for (let i = 0; i < side * side; i += 1) {
    const alpha = src[i * 4 + 3] / 255;
    out[i * 4 + 3] = Math.round(src[i * 4 + 3]);
    if (alpha <= 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      out[i * 4 + channel] = Math.min(255, Math.round(src[i * 4 + channel] / alpha));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * PNG / ICO 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, side) {
  const stride = side * 4;
  const raw = Buffer.alloc((stride + 1) * side);
  for (let y = 0; y < side; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const SIZES = [256, 128, 64, 48, 32, 16];

const base = toPremultiplied(renderCanvas(), N * SS);
const images = new Map();

for (const size of SIZES) {
  let scaled;
  if (size === N) {
    // 256：先从 3 倍超采样精确缩回 1 倍。
    scaled = shrinkExact(base, N * SS, SS);
  } else {
    // 其余尺寸都走 128 这一档（精确 ÷2），再 box 过滤到目标尺寸：
    // 避免从 768 直接降到 16 时引入不必要的模糊。
    const half = shrinkExact(base, N * SS, SS * 2);
    scaled = size === 128 ? half : resize(half, 128, size);
  }
  images.set(size, encodePng(fromPremultiplied(scaled, size), size));
}

// ICO 封装：ICONDIR + n × ICONDIRENTRY + 各自的 PNG 数据。
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

const entries = [];
let offset = 6 + SIZES.length * 16;
for (const size of SIZES) {
  const png = images.get(size);
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size; // 256 记作 0
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0; // 调色板数
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += png.length;
}

const ico = Buffer.concat([header, ...entries, ...SIZES.map((size) => images.get(size))]);
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, ico);

console.log(`[icon] 已生成 ${path.relative(root, outFile)}（${(ico.length / 1024).toFixed(1)} KB）`);
console.log(`[icon] 尺寸：${SIZES.join(' / ')}，每档 PNG 字节：${SIZES.map((s) => images.get(s).length).join(' / ')}`);
