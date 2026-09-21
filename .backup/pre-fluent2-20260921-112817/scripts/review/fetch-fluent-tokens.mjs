/**
 * 从 api.github.com 取回 @fluentui/tokens 的 6 个官方源文件（base64），
 * 原样落盘到 .fluent-b64/<逻辑名>.b64，并生成 index.json（逻辑名 → sha）
 * 与 manifest.json（sha / API size / base64 字符数 / 解码字节数 / 行数）。
 *
 * 说明：pwsh 无法直连网络（TLS 失败），但 node 的 fetch 可直连 api.github.com，
 * 因此由本脚本完成取回，避免手工搬运 base64 造成截断。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILES = {
  'global-fonts.ts': '9b8dca7bf3dc8b7faf4e2628b4eeda574bae91b3',
  'global-strokeWidths.ts': '6cc868a3551b1b3b87f64b3df4fe9e56edf98ad4',
  'alias-lightColor.ts': '01c7e85750c1c7edd71a861be0310f976f0386d6',
  'alias-darkColor.ts': 'a4749ae3bb43362c134aabdf5ba3b54040b50ff2',
  'global-colors.ts': 'e8744d569ba821d013ab3f4cec0c319c16c6da50',
  'global-typographyStyles.ts': '8c8ffdd77077cb90856ec934a77c37b70eb8119b',
};

const outDir = path.join(process.cwd(), '.fluent-b64');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(FILES, null, 2) + '\n', 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = {};

for (const [name, sha] of Object.entries(FILES)) {
  const url = `https://api.github.com/repos/microsoft/fluentui/git/blobs/${sha}`;
  let json = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dsh-fluent-token-fetch', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      break;
    } catch (err) {
      lastErr = err;
      await sleep(800 * attempt);
    }
  }
  if (!json) throw new Error(`${name}: 取回失败 → ${lastErr?.message}`);
  if (json.encoding !== 'base64' || typeof json.content !== 'string') {
    throw new Error(`${name}: 意外的 encoding=${json.encoding} content=${typeof json.content}`);
  }

  const b64 = json.content.replace(/\s+/g, '');
  writeFileSync(path.join(outDir, `${name}.b64`), b64, 'utf8');
  const decoded = Buffer.from(b64, 'base64');
  const text = decoded.toString('utf8');
  const bytes = decoded.byteLength;

  manifest[name] = {
    sha,
    apiSize: json.size,
    b64Chars: b64.length,
    decodedBytes: bytes,
    sizeMatch: bytes === json.size,
    lines: text.split('\n').length,
  };
  console.log(
    `[fetch] ${name.padEnd(28)} sha=${sha.slice(0, 10)} apiSize=${String(json.size).padStart(6)} ` +
      `decoded=${String(bytes).padStart(6)} match=${bytes === json.size} lines=${manifest[name].lines}`,
  );
}

writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
const bad = Object.entries(manifest).filter(([, m]) => !m.sizeMatch);
console.log(`[fetch] 6 个文件已落盘到 .fluent-b64/ ；字节数不一致: ${bad.length}`);
if (bad.length) process.exitCode = 1;
