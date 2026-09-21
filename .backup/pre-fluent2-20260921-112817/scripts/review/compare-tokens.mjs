/**
 * 官方 Fluent 2 令牌值 vs 项目 tokens.css 现有值的定量对照。
 * 只在本地做算术：alpha 合成、WCAG 相对亮度与对比度。官方值取自
 * docs/review/fluent2-official/ 的解码原文（注释中的 hex/alpha 即官方声明值）。
 */

const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const over = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const f = (n) => n.toFixed(2);

// ── 基准背景 ────────────────────────────────────────────────────────────────
const officialDarkBg = hex('#292929');   // colorNeutralBackground1 @dark
const projectDarkBg = hex('#0b1017');    // --bg-app (dark)
const officialLightBg = hex('#ffffff');  // colorNeutralBackground1 @light
const projectLightBg = hex('#f3f6fb');   // --bg-app (light)
console.log('== 基准背景 ==');
console.log(`dark  官方 #292929 vs 项目 #0b1017  对比度 ${f(ratio(officialDarkBg, projectDarkBg))}:1`);
console.log(`light 官方 #ffffff vs 项目 #f3f6fb  对比度 ${f(ratio(officialLightBg, projectLightBg))}:1`);

// ── 描边：项目用 alpha，需合成到自身背景后与官方实心值比较 ──────────────────
console.log('== 描边合成 ==');
const pDarkBorder = over([255, 255, 255], 0.2, projectDarkBg);
console.log(`dark  项目 --border rgba(255,255,255,.2) on #0b1017 → ${toHex(pDarkBorder)}   官方 colorNeutralStroke1 #666666`);
const pLightBorder = over(hex('#0f1c30'), 0.38, projectLightBg);
console.log(`light 项目 --border rgba(15,28,48,.38) on #f3f6fb → ${toHex(pLightBorder)}   官方 colorNeutralStroke1 #d1d1d1`);

// ── 遮罩：合成到各自的主题背景 ─────────────────────────────────────────────
console.log('== 遮罩合成 ==');
const oScrimDark = over([0, 0, 0], 0.5, officialDarkBg);
const pScrimDark = over(hex('#03060b'), 0.66, projectDarkBg);
console.log(`dark  官方 colorBackgroundOverlay rgba(0,0,0,.5) on #292929 → ${toHex(oScrimDark)}   项目 --scrim rgba(3,6,11,.66) on #0b1017 → ${toHex(pScrimDark)}`);
const oScrimLight = over([0, 0, 0], 0.4, officialLightBg);
const pScrimLight = over(hex('#182232'), 0.42, projectLightBg);
console.log(`light 官方 rgba(0,0,0,.4) on #ffffff → ${toHex(oScrimLight)}   项目 rgba(24,34,50,.42) on #f3f6fb → ${toHex(pScrimLight)}`);

// ── 文本 ────────────────────────────────────────────────────────────────────
console.log('== 文本对背景 ==');
const rows = [
  ['dark  colorNeutralForeground1', '#ffffff', officialDarkBg, '#e9eef7', projectDarkBg],
  ['dark  colorNeutralForeground2', '#d6d6d6', officialDarkBg, '#a2b2c8', projectDarkBg],
  ['dark  colorNeutralForeground3', '#adadad', officialDarkBg, '#8296ae', projectDarkBg],
  ['light colorNeutralForeground1', '#242424', officialLightBg, '#131c29', projectLightBg],
  ['light colorNeutralForeground2', '#424242', officialLightBg, '#4c5c73', projectLightBg],
  ['light colorNeutralForeground3', '#616161', officialLightBg, '#616f85', projectLightBg],
];
for (const [label, oh, ob, ph, pb] of rows) {
  console.log(
    `${label}  官方 ${oh} on ${toHex(ob)} = ${f(ratio(hex(oh), ob))}:1   项目 ${ph} on ${toHex(pb)} = ${f(ratio(hex(ph), pb))}:1`,
  );
}

// ── 强调色 ──────────────────────────────────────────────────────────────────
console.log('== 强调色 ==');
console.log(`light 官方 colorBrandBackground #0078d4  项目 --accent #2f6fdd  互比 ${f(ratio(hex('#0078d4'), hex('#2f6fdd')))}:1`);
console.log(`dark  官方 colorBrandBackground #106ebe  项目 --accent #4d8dff  互比 ${f(ratio(hex('#106ebe'), hex('#4d8dff')))}:1`);
console.log(`light 官方 白字 on #0078d4 = ${f(ratio([255, 255, 255], hex('#0078d4')))}:1   项目 白字 on #2f6fdd = ${f(ratio([255, 255, 255], hex('#2f6fdd')))}:1`);
console.log(`dark  官方 白字 on #106ebe = ${f(ratio([255, 255, 255], hex('#106ebe')))}:1   项目 白字 on #4d8dff = ${f(ratio([255, 255, 255], hex('#4d8dff')))}:1`);

// ── 字号档位比对 ────────────────────────────────────────────────────────────
const officialFs = [10, 12, 14, 16, 20, 24, 28, 32, 40, 68];
const projectFs = { '--fs-xs': 11, '--fs-sm': 12, '--fs-md': 13, '--fs-lg': 15, '--fs-xl': 18, '--fs-2xl': 22, '--fs-3xl': 28, '--fs-titlebar': 14 };
console.log('== 字号档位 ==');
console.log('官方档位(px):', officialFs.join(', '));
for (const [k, v] of Object.entries(projectFs)) {
  console.log(`  ${k.padEnd(13)} ${String(v).padStart(3)}px  ${officialFs.includes(v) ? '命中官方档位' : '不在官方档位'}`);
}
