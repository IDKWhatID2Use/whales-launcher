/**
 * 离线铺设 Electron 运行时二进制。
 *
 * 背景（本机实测）：
 *   - 本机无法访问 github.com（DNS 解析到非公网 IP），而 `electron` 包的
 *     postinstall 默认从 github releases 下载 ~142MB 的发行包，必然失败。
 *   - 但 `%LOCALAPPDATA%\electron\Cache` 下已存在可用的发行包 zip
 *     （`electron-v<版本>-win32-x64.zip`），且是合法 ZIP。
 *   - 因此安装依赖时用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过下载，
 *     再由本脚本把缓存 zip 解压到 `node_modules/electron/dist` 并写好
 *     `path.txt`，使 `electron` 包认为二进制已就绪。
 *
 * 幂等：dist 已存在且版本匹配时直接跳过。
 * 用法：`node scripts/setup-electron.mjs`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = join(root, 'node_modules', 'electron');
const distDir = join(electronDir, 'dist');
const exePath = join(distDir, 'electron.exe');
const pathTxt = join(electronDir, 'path.txt');

function fail(msg) {
  console.error(`[electron-setup] ${msg}`);
  process.exit(1);
}

if (!existsSync(join(electronDir, 'package.json'))) {
  fail('未找到 node_modules/electron，请先执行 npm install。');
}

const wantVersion = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version;

/** 已就绪判定：exe 存在，且版本标记文件与目标版本一致。 */
const stampFile = join(distDir, '.whales-electron-version');
if (existsSync(exePath) && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === wantVersion) {
  console.log(`[electron-setup] 已就绪：electron ${wantVersion}`);
  process.exit(0);
}

/** 在 Electron 缓存目录里递归找目标版本的 win32-x64 发行包。 */
function findCachedZip(version) {
  const cacheRoot = join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache');
  if (!existsSync(cacheRoot)) return null;
  const wanted = `electron-v${version}-win32-x64.zip`;
  const stack = [cacheRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === wanted) return full;
    }
  }
  return null;
}

const zip = findCachedZip(wantVersion);
if (zip === null) {
  // 缓存里没有对应发行包。若 electron 自身的 postinstall 已成功下载并铺好
  // dist，则视为已就绪，不阻断安装。
  if (existsSync(exePath)) {
    console.log(`[electron-setup] 已就绪（由 electron 自身 postinstall 提供）：${wantVersion}`);
    writeFileSync(stampFile, wantVersion, 'utf8');
    process.exit(0);
  }
  fail(
    `未在 Electron 缓存中找到 electron-v${wantVersion}-win32-x64.zip，且 dist 不存在。\n` +
      `  期望位置：%LOCALAPPDATA%\\electron\\Cache\\<hash>\\\n` +
      `  解决办法：在可联网环境下载对应发行包放入上述目录，或把 package.json 的 electron 版本\n` +
      `  改为本机缓存中已有的版本（当前缓存里有 v41.1.0 与 v35.7.5）。`,
  );
}

const sizeMb = (statSync(zip).size / 1048576).toFixed(1);
console.log(`[electron-setup] 使用缓存发行包：${zip} (${sizeMb} MB)`);

if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 用 .NET 的 ZipFile 解压：比 PowerShell 的 Expand-Archive 快得多。
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory('${zip.replace(/'/g, "''")}', '${distDir.replace(/'/g, "''")}')
`;
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  stdio: 'inherit',
});
if (result.status !== 0) fail(`解压失败（退出码 ${result.status}）。`);

if (!existsSync(exePath)) fail(`解压完成但未找到 ${exePath}，发行包结构可能已变化。`);

// electron 包通过 path.txt 定位可执行文件。
writeFileSync(pathTxt, 'electron.exe', 'utf8');
writeFileSync(stampFile, wantVersion, 'utf8');

console.log(`[electron-setup] 完成 ✓ electron ${wantVersion} → ${distDir}`);
