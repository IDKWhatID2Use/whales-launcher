/**
 * WhalesLauncher core —— 引擎（dsh 版本）管理
 *
 * 版本目录布局（架构文档 §2）：
 * ```
 * <root>/engines/<dsh 版本>/node_modules/@deepseek-ai/dsh/
 * ```
 * 启动实例时用该目录下的 `lib/bin.js`，从而实现"每个实例独享版本"。
 *
 * 安装走 `npm install @deepseek-ai/dsh@<版本>`：命令行显式 `--cache`，
 * 环境变量覆盖 `npm_config_cache`，并注入 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
 * （本机环境变量把 cache 指向工作区外会触发沙箱 EPERM；npm 配置优先级是
 * 命令行 > 环境变量 > 项目 .npmrc，所以两道都要上）。
 */
import os from 'node:os';
import path from 'node:path';
import type { EngineInfo } from '../shared/contracts';
import { dirSize, ensureDir, listDir, mtimeMs, pathExists, readJson, removeDir, writeJsonAtomic } from './fsx';
import { listInstances } from './instance';
import {
  childBaseEnv,
  corePaths,
  engineBinPathIfPresent,
  engineDir,
  enginePackageDir,
  lastRoot,
  npmCacheArgs,
} from './paths';
import { runCapture, type ProcLogSink } from './proc';

/** 引擎安装/查询的单次超时（npm 首次装 dsh 依赖较多）。 */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/** 查询可安装版本的超时。 */
const VIEW_TIMEOUT_MS = 3 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 引擎体积（惰性 + mtime 缓存）
 *
 * 真实 dsh 安装有 **26513 个文件 / 551MB，一次递归统计实测 1375ms**。若在
 * `listEngines` 里同步递归，用户每进一次版本管理页都要卡 1 秒以上，多装几个版本更甚。
 * 因此：
 *  - 列表调用**只读缓存**，首次（或目录 mtime 变化后）返回 `null`（契约允许，
 *    UI 已把 0/空显示为「未知」）；
 *  - 后台单飞地计算并写入缓存，用户下次刷新（UI 本来就会刷新）即可看到真实体积。
 * 缓存以**引擎目录 mtime** 作为签名，安装/删除文件后会自动失效重算。
 * ------------------------------------------------------------------ */

/** dir → 上次算出的体积（带 mtime 签名）。 */
const engineSizeCache = new Map<string, { signature: number; sizeBytes: number | null }>();

/** 正在后台计算的目录（单飞，避免重复递归）。 */
const engineSizeWarmup = new Set<string>();

/**
 * 立即递归统计引擎目录体积（供 UI 的"刷新体积"等显式调用）。
 * @param dir 引擎目录。
 * @returns 字节数或 `null`。
 */
export async function computeEngineSize(dir: string): Promise<number | null> {
  const signature = (await mtimeMs(dir)) ?? -1;
  const sizeBytes = await dirSize(dir);
  engineSizeCache.set(dir, { signature, sizeBytes });
  return sizeBytes;
}

/**
 * 读取缓存的体积；缓存缺失或已失效时返回 `null` 并**在后台**安排一次计算。
 * @param dir 引擎目录。
 * @returns 已知体积或 `null`（尚未计算）。
 */
async function lazyEngineSize(dir: string): Promise<number | null> {
  const signature = (await mtimeMs(dir)) ?? -1;
  const hit = engineSizeCache.get(dir);
  if (hit !== undefined && hit.signature === signature) return hit.sizeBytes;
  if (!engineSizeWarmup.has(dir)) {
    engineSizeWarmup.add(dir);
    void computeEngineSize(dir)
      .catch(() => undefined)
      .finally(() => engineSizeWarmup.delete(dir));
  }
  return null;
}

/**
 * 枚举本地已安装的引擎版本。
 *
 * `sizeBytes` 走惰性 + mtime 缓存：首次调用返回 `null`（不阻塞），后台算完后
 * 下次调用即为真实值（见 {@link computeEngineSize}）。
 * @param root 启动器根目录。
 * @returns 引擎信息数组（按版本号从新到旧）。
 */
export async function listEngines(root: string): Promise<EngineInfo[]> {
  const { enginesDir } = corePaths(root);
  const instances = await listInstances(root);
  const entries = await listDir(enginesDir);
  const engines: EngineInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dirName = entry.name;
    let manifest: { version?: unknown } | null = null;
    try {
      manifest = await readJson<{ version?: unknown }>(path.join(enginePackageDir(root, dirName), 'package.json'));
    } catch {
      // 损坏的引擎目录不应让整个列表失败
      continue;
    }
    if (manifest === null) continue;
    const version = typeof manifest.version === 'string' ? manifest.version : dirName;
    const binPath = engineBinPathIfPresent(root, dirName);
    const usedBy = instances
      .filter((item) => item.meta.engine.version === dirName || item.meta.engine.version === version)
      .map((item) => item.meta.id);
    engines.push({
      version,
      dir: engineDir(root, dirName),
      installed: binPath !== null,
      binPath,
      usedBy,
      sizeBytes: await lazyEngineSize(engineDir(root, dirName)),
    });
  }
  return engines.sort((left, right) => compareVersions(right.version, left.version));
}

/**
 * 查询 npm registry 上可安装的 dsh 版本列表。
 *
 * 契约签名只有 `registry`，但 npm 查询也需要一个可写的 cache 目录（本机
 * `npm_config_cache` 指向工作区外，会触发沙箱 EPERM）。因此提供可选第二参数；
 * 省略时按 `$WHALES_LAUNCHER_ROOT` → 最近一次使用的 root 推导（见
 * {@link defaultRootForCache}，不使用 `process.cwd()`）。
 * @param registry npm registry（如 `https://registry.npmjs.org`）。
 * @param root 启动器根目录（可选，用于定位 cache 目录）。
 * @returns 版本号数组（从新到旧）。
 * @throws npm 不可用 / 网络失败 / 返回格式异常。
 */
export async function listAvailableEngines(registry: string, root?: string): Promise<string[]> {
  const cacheRoot = root ?? defaultRootForCache();
  const result = await runCapture(
    'npm',
    ['view', '@deepseek-ai/dsh', 'versions', '--json', '--registry', registry, ...npmCacheArgs(cacheRoot)],
    {
      timeoutMs: VIEW_TIMEOUT_MS,
      env: childBaseEnv(cacheRoot),
      captureDir: corePaths(cacheRoot).cacheDir,
    },
  );
  if (result.code !== 0) {
    throw new Error(`查询可安装版本失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`);
  }
  const parsed = parseVersionsJson(result.stdout);
  if (parsed === null) throw new Error(`npm 返回的版本列表无法解析：${tail(result.stdout)}`);
  return parsed.sort(compareVersions).reverse();
}

/**
 * 安装指定版本的 dsh 引擎。
 * @param root 启动器根目录。
 * @param version dsh 版本号（如 `0.1.6-alpha.2`）。
 * @param registry npm registry。
 * @param onLog 日志回调。
 * @returns 安装完成后的引擎信息。
 */
export async function installEngine(
  root: string,
  version: string,
  registry: string,
  onLog?: ProcLogSink,
): Promise<EngineInfo> {
  assertVersion(version);
  const dir = engineDir(root, version);
  await ensureDir(dir);
  const manifestPath = path.join(dir, 'package.json');
  if (!(await pathExists(manifestPath))) {
    await writeJsonAtomic(manifestPath, {
      name: `whales-engine-${sanitizeVersionForName(version)}`,
      version: '0.0.0',
      private: true,
      description: `WhalesLauncher 引擎目录（dsh ${version}）`,
    });
  }
  onLog?.('system', `开始安装 @deepseek-ai/dsh@${version}（registry=${registry}）\n`);
  const result = await runCapture(
    'npm',
    [
      'install',
      `@deepseek-ai/dsh@${version}`,
      '--registry',
      registry,
      '--save-exact',
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'info',
      ...npmCacheArgs(root),
    ],
    {
      cwd: dir,
      env: childBaseEnv(root),
      onLog,
      timeoutMs: INSTALL_TIMEOUT_MS,
      captureDir: corePaths(root).cacheDir,
    },
  );
  if (result.code !== 0) {
    throw new Error(`安装 dsh@${version} 失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`);
  }
  const binPath = engineBinPathIfPresent(root, version);
  if (binPath === null) {
    throw new Error(`安装结束但找不到引擎入口：${enginePackageDir(root, version)}（期望 lib/bin.js）`);
  }
  onLog?.('system', `引擎就绪：${binPath}\n`);
  const installed = (await listEngines(root)).find((item) => item.version === version);
  return (
    installed ?? {
      version,
      dir,
      installed: true,
      binPath,
      usedBy: [],
      sizeBytes: await dirSize(dir),
    }
  );
}

/**
 * 删除某个引擎版本。
 *
 * 仅当没有实例引用它时才允许删除；且只允许删除 `<root>/engines` 之内的目录
 * （`fs.rm` 不会跟随 junction，已实测：链接目标内容完好）。
 * @param root 启动器根目录。
 * @param version dsh 版本号（= 引擎目录名）。
 */
export async function removeEngine(root: string, version: string): Promise<void> {
  const target = engineDir(root, version);
  const relative = path.relative(corePaths(root).enginesDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝删除 engines 目录之外的路径：${target}`);
  }
  const engines = await listEngines(root);
  const found = engines.find((item) => item.version === version || path.basename(item.dir) === version);
  if (found !== undefined && found.usedBy.length > 0) {
    throw new Error(`引擎 ${version} 仍被 ${found.usedBy.length} 个实例使用，请先切换或删除这些实例`);
  }
  if (!(await pathExists(target))) return;
  await removeDir(target);
}

/**
 * 解析引擎入口脚本路径（同步，契约要求）。
 * @param root 启动器根目录。
 * @param version dsh 版本号。
 * @returns `lib/bin.js` 绝对路径；未安装返回 `null`。
 */
export function resolveEngineBin(root: string, version: string): string | null {
  return engineBinPathIfPresent(root, version);
}

/**
 * 【非契约扩展】把一个本地已存在的 dsh 安装接入引擎目录（离线铺设）。
 *
 * 用 junction 指向真实的 `@deepseek-ai/dsh` 包目录，不复制文件、不联网，
 * 适合"本机已有 dsh 全局安装"或打包分发场景。
 * @param root 启动器根目录。
 * @param sourceDshDir 真实 dsh 包目录（须含 package.json）。
 * @returns 接入后的引擎信息。
 */
export async function attachEngineFromLocal(root: string, sourceDshDir: string): Promise<EngineInfo> {
  const manifest = await readJson<{ name?: unknown; version?: unknown }>(path.join(sourceDshDir, 'package.json'));
  if (manifest === null) throw new Error(`不是有效的 dsh 包目录（缺少 package.json）：${sourceDshDir}`);
  if (manifest.name !== '@deepseek-ai/dsh') {
    throw new Error(`期望包名 @deepseek-ai/dsh，实际为 ${String(manifest.name)}：${sourceDshDir}`);
  }
  if (typeof manifest.version !== 'string') throw new Error(`dsh 包缺少 version 字段：${sourceDshDir}`);
  const version = manifest.version;
  const link = path.join(engineDir(root, version), 'node_modules', '@deepseek-ai', 'dsh');
  await ensureDir(path.dirname(link));
  if (!(await pathExists(link))) {
    const { symlink } = await import('node:fs/promises');
    await symlink(path.resolve(sourceDshDir), link, 'junction');
  }
  const binPath = engineBinPathIfPresent(root, version);
  if (binPath === null) throw new Error(`接入后仍找不到入口（期望 lib/bin.js）：${link}`);
  return {
    version,
    dir: engineDir(root, version),
    installed: true,
    binPath,
    usedBy: [],
    sizeBytes: await dirSize(engineDir(root, version)),
  };
}

/**
 * 校验版本号字符串是否可以安全地拼到命令行。
 * @param version 版本号。
 * @returns 是否合法。
 */
export function isValidVersion(version: string): boolean {
  return version.length > 0 && version.length <= 64 && /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(version);
}

/** 断言版本号合法。 */
function assertVersion(version: string): void {
  if (!isValidVersion(version)) throw new Error(`版本号不合法：${JSON.stringify(version)}`);
}

/** 解析 npm view 的版本输出（数组或单值）。 */
function parseVersionsJson(stdout: string): string[] | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return [parsed];
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 比较版本号（semver 规则：数字段按数值比较，预发布段按标识符逐段比较，
 * 且预发布小于同号正式版；如 `1.0.0-alpha.2 < 1.0.0-alpha.10 < 1.0.0`）。
 * @param left 左版本。
 * @param right 右版本。
 * @returns 大于 0 表示 left 更新。
 */
export function compareVersions(left: string, right: string): number {
  const [leftMain = '', leftPre] = splitVersion(left);
  const [rightMain = '', rightPre] = splitVersion(right);
  const leftParts = leftMain.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = rightMain.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  if (leftPre === undefined && rightPre === undefined) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return comparePrerelease(leftPre, rightPre);
}

/** 按 semver 规则比较预发布段。 */
function comparePrerelease(left: string, right: string): number {
  const leftIds = left.split('.');
  const rightIds = right.split('.');
  const length = Math.max(leftIds.length, rightIds.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftIds[index];
    const b = rightIds[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

/** 拆分 `1.2.3-beta.1` 为 `['1.2.3', 'beta.1']`。 */
function splitVersion(version: string): [string, string | undefined] {
  const separator = version.indexOf('-');
  if (separator < 0) return [version, undefined];
  return [version.slice(0, separator), version.slice(separator + 1)];
}

/** 把版本号变成合法的 npm 包名片段。 */
function sanitizeVersionForName(version: string): string {
  return version.replace(/[^0-9A-Za-z.-]/g, '-');
}

/**
 * 推导启动器根目录（用于没有 root 参数的调用，如 `listAvailableEngines`）。
 *
 * 优先级：`$WHALES_LAUNCHER_ROOT` → 最近一次 `corePaths()/instancePaths()` 用过的 root
 * （即启动器当前正在操作的根目录）→ 系统临时目录。
 * **刻意不使用 `process.cwd()`**：Electron 从快捷方式启动时 cwd 由系统决定，
 * 用它推导 cache 会让 `--cache` 双保险失效（见 QA F1/F2）。
 * @returns 可用于定位 cache 目录的根路径。
 */
function defaultRootForCache(): string {
  const fromEnv = process.env['WHALES_LAUNCHER_ROOT'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  const remembered = lastRoot();
  if (remembered !== null) return remembered;
  return path.join(os.tmpdir(), 'whalelauncher');
}

/** 取输出的最后若干行用于报错。 */
function tail(text: string, lines = 12): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}
