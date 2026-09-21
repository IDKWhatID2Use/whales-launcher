/**
 * 解析 docs/review/fluent2-official/ 下已解码的官方令牌文件，输出精确统计：
 *   - 令牌总数、light/dark 交集与差集
 *   - 按前缀分组计数（"其他"给出完整名单）
 *   - 关键令牌 light/dark 原文值
 *   - fonts / strokeWidths / typographyStyles 全部档位
 * 结果打印到 stdout 并写入 _analysis.json，供人工报告引用（所有值取自文件原文）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'docs', 'review', 'fluent2-official');
const read = (n) => readFileSync(path.join(dir, n), 'utf8');

/** 解析 `  name: expr, // comment` 形式的别名令牌 */
function parseAlias(file) {
  const text = read(file);
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*(.+?),\s*(?:\/\/\s*(.*))?$/);
    if (m) map.set(m[1], { expr: m[2].trim(), comment: (m[3] ?? '').trim() });
  }
  return map;
}

/** 解析 `  name: value,` 形式的全局令牌 */
function parseSimple(file) {
  const text = read(file);
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*(.+?),?$/);
    if (m) out.push([m[1], m[2].replace(/,$/, '').trim()]);
  }
  return out;
}

const light = parseAlias('alias-lightColor.ts');
const dark = parseAlias('alias-darkColor.ts');

const PREFIXES = [
  'colorNeutralBackground',
  'colorNeutralForeground',
  'colorNeutralStroke',
  'colorBrand',
  'colorCompoundBrand',
  'colorPalette',
  'colorStatus',
  'colorSubtle',
  'colorTransparent',
  'colorStrokeFocus',
];

function group(map) {
  const groups = new Map(PREFIXES.map((p) => [p, []]));
  groups.set('其他', []);
  for (const name of map.keys()) {
    const hit = PREFIXES.find((p) => name.startsWith(p));
    groups.get(hit ?? '其他').push(name);
  }
  return groups;
}

const onlyLight = [...light.keys()].filter((k) => !dark.has(k));
const onlyDark = [...dark.keys()].filter((k) => !light.has(k));
const both = [...light.keys()].filter((k) => dark.has(k));
const valueDiff = both.filter((k) => light.get(k).expr !== dark.get(k).expr);

const report = {
  counts: { light: light.size, dark: dark.size, both: both.length, onlyLight: onlyLight.length, onlyDark: onlyDark.length },
  onlyLight,
  onlyDark,
  groupsLight: {},
  groupsDark: {},
  otherLight: group(light).get('其他'),
  otherDark: group(dark).get('其他'),
  tokens: {},
};

for (const [p, names] of group(light)) report.groupsLight[p] = names.length;
for (const [p, names] of group(dark)) report.groupsDark[p] = names.length;
report.groupMembers = {};
for (const [p, names] of group(light)) report.groupMembers[p] = names;
report.sameValueBoth = both.filter((k) => light.get(k).expr === dark.get(k).expr);

const KEY = [
  'colorNeutralBackground1','colorNeutralBackground2','colorNeutralBackground3','colorNeutralBackground4',
  'colorNeutralBackground5','colorNeutralBackground6','colorNeutralBackgroundDisabled',
  'colorNeutralForeground1','colorNeutralForeground2','colorNeutralForeground3','colorNeutralForeground4',
  'colorNeutralForegroundDisabled','colorNeutralStroke1','colorNeutralStroke2','colorNeutralStroke3',
  'colorNeutralStrokeAccessible','colorNeutralStrokeDisabled','colorBrandBackground','colorBrandBackgroundHover',
  'colorBrandBackgroundPressed','colorBrandForeground1','colorBrandForeground2','colorBrandForegroundLink',
  'colorCompoundBrandBackground','colorStrokeFocus1','colorStrokeFocus2','colorBackgroundOverlay',
  'colorScrollbarOverlay','colorNeutralShadowAmbient','colorNeutralShadowKey','colorNeutralShadowAmbientDarker',
  'colorNeutralShadowKeyDarker',
];
for (const k of KEY) {
  report.tokens[k] = { light: light.get(k) ?? null, dark: dark.get(k) ?? null };
}

report.globalFonts = parseSimple('global-fonts.ts');
report.strokeWidths = parseSimple('global-strokeWidths.ts');

// typographyStyles: 每个样式的 fontSize/fontWeight/lineHeight 令牌引用
const typo = read('global-typographyStyles.ts');
report.typographyStyles = {};
let cur = null;
for (const line of typo.split('\n')) {
  const s = line.match(/^ {2}([A-Za-z][A-Za-z0-9]*):\s*\{$/);
  if (s) { cur = s[1]; report.typographyStyles[cur] = {}; continue; }
  if (cur) {
    const v = line.match(/^ {4}(fontFamily|fontSize|fontWeight|lineHeight):\s*tokens\.([A-Za-z0-9]+),/);
    if (v) report.typographyStyles[cur][v[1]] = v[2];
  }
}

writeFileSync(path.join(dir, '_analysis.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

const quiet = process.argv.includes('--quiet');
const log = quiet ? () => {} : (...a) => log(...a);
const L = (s, n) => String(s).padEnd(n);
log(`[counts] light=${light.size} dark=${dark.size} both=${both.length} onlyLight=${onlyLight.length} onlyDark=${onlyDark.length}`);
log(`[diff-values] 同名但表达式不同: ${valueDiff.length}`);
log(`[onlyLight] ${onlyLight.join(', ') || '(无)'}`);
log(`[onlyDark] ${onlyDark.join(', ') || '(无)'}`);
log('[groups] 前缀 | light | dark');
for (const p of [...PREFIXES, '其他']) log(`  ${L(p, 26)} ${L(report.groupsLight[p], 5)} ${report.groupsDark[p]}`);
log(`[其他/light] ${report.otherLight.join(', ')}`);
log(`[其他/dark ] ${report.otherDark.join(', ')}`);
log('[key tokens] name | light | dark');
for (const k of KEY) {
  const { light: l, dark: d } = report.tokens[k];
  log(`  ${L(k, 34)} ${L(l ? `${l.expr} ${l.comment}` : '(缺失)', 52)} ${d ? `${d.expr} ${d.comment}` : '(缺失)'}`);
}
log('[strokeWidths]', report.strokeWidths.map(([k, v]) => `${k}=${v}`).join('  '));
log('[fonts]');
for (const [k, v] of report.globalFonts) log(`  ${k}=${v}`);
log('[typographyStyles]');
for (const [k, v] of Object.entries(report.typographyStyles)) {
  log(`  ${L(k, 18)} fontSize=${L(v.fontSize ?? '-', 20)} lineHeight=${L(v.lineHeight ?? '-', 20)} weight=${v.fontWeight ?? '-'}`);
}
