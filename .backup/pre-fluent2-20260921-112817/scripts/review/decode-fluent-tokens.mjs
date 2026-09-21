/**
 * 把从 GitHub API 取回的 @fluentui/tokens base64 载荷解码落盘，并做落盘校验与统计。
 * 用途：为「现有自造 tokens.css vs Fluent 2 官方令牌」的逐项对照提供可核对证据。
 *
 * 输入：.fluent-b64/<逻辑名>.b64（base64 原文）+ index.json（逻辑名 → sha）
 *      + manifest.json（sha / API size / base64 字符数 / 解码字节数 / 行数，由 fetch 脚本写入）
 * 校验：解码字节数必须等于 API 声明的 size，否则以非零码退出。
 * 行数口径：以换行符计（等价 wc -l）；split('\n').length 会因文件结尾换行多算 1。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'docs', 'review', 'fluent2-official');
mkdirSync(outDir, { recursive: true });

const INBOX = path.join(root, '.fluent-b64');
if (!existsSync(INBOX)) {
  console.error('[decode] 缺少 .fluent-b64/ 输入目录（存放各官方文件的 base64 文本）');
  process.exit(1);
}

const index = JSON.parse(readFileSync(path.join(INBOX, 'index.json'), 'utf8'));
const manifestPath = path.join(INBOX, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

let total = 0;
const rows = [];

for (const [name, sha] of Object.entries(index)) {
  const p = path.join(INBOX, `${name}.b64`);
  if (!existsSync(p)) {
    console.warn(`[decode] 跳过（无载荷）: ${name}`);
    continue;
  }
  const b64 = readFileSync(p, 'utf8').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  const text = buf.toString('utf8');
  writeFileSync(path.join(outDir, name), text, 'utf8');

  const bytes = buf.byteLength;
  const apiSize = manifest[name]?.apiSize ?? null;
  const sizeOk = apiSize === null ? null : apiSize === bytes;
  const newlines = (text.match(/\n/g) ?? []).length;
  const lines = text.endsWith('\n') ? newlines : newlines + 1;
  // 统计令牌名：形如 `  identifier: ...`（任意值形态，含跨行字体族）
  const keys = [...text.matchAll(/^\s{2,}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
  const uniq = new Set(keys);
  total += uniq.size;
  rows.push({ name, sha, apiSize, bytes, sizeOk, lines, keys: uniq.size });

  console.log(
    `[decode] ${name.padEnd(27)} sha=${sha.slice(0, 10)}  API size ${String(apiSize).padStart(5)} / ` +
      `解码 ${String(bytes).padStart(5)} 字节  ${sizeOk === null ? '未校验' : sizeOk ? '一致' : '不一致!'}  ` +
      `${String(lines).padStart(4)} 行  顶层令牌键 ${String(uniq.size).padStart(4)}`,
  );
}

writeFileSync(
  path.join(outDir, '_decode-report.json'),
  JSON.stringify({ generatedFrom: '.fluent-b64/', rows, totalTopLevelKeys: total }, null, 2) + '\n',
  'utf8',
);

const bad = rows.filter((r) => r.sizeOk === false);
console.log(`[decode] 合计顶层令牌键（跨文件相加）: ${total}`);
console.log(`[decode] 字节数校验失败: ${bad.length} 个`);
console.log(`[decode] 输出目录: docs/review/fluent2-official/`);
if (bad.length) process.exitCode = 1;
