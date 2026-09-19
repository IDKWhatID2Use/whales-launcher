/**
 * 启动器根目录与全局配置（`launcher.json`）。
 *
 * 契约规定 `LauncherConfig.rootDir` 由 main 注入且只读，因此：
 *  - 读取时统一经 `withRoot()` 补上 rootDir；
 *  - 落盘时一律剥掉 rootDir，绝不把机器相关路径写进配置文件。
 */
import { app } from 'electron';
import { rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { core } from '../core/index.js';
import { SCHEMA_VERSION } from '../shared/contracts.js';
import type { CorePaths, LauncherConfig } from '../shared/contracts.js';
import { AppError, describeError } from './errors.js';
import { LAUNCHER_LOG_ID, logSink } from './runtime.js';

let cachedRoot: string | null = null;

/** 启动器根目录：dev 下即 `electron .` 的目录（含 package.json）。 */
export function launcherRoot(): string {
  if (cachedRoot !== null) return cachedRoot;
  let base: string;
  try {
    base = app.getAppPath();
  } catch {
    base = process.cwd();
  }
  cachedRoot = path.resolve(base);
  return cachedRoot;
}

/** 启动器根下的关键路径（由 core 解析，main 不重复实现）。 */
export function corePaths(): CorePaths {
  return core.corePaths(launcherRoot());
}

/** 出厂默认配置。 */
export function defaultConfig(): LauncherConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    primaryHome: path.join(os.homedir(), '.dsh'),
    theme: 'dark',
    lastInstanceId: null,
    confirmOnDelete: true,
    engineRegistry: 'https://registry.npmjs.org',
    // null = 自动探测（环境变量 → 启动器自身 → PATH → 常见安装位置）
    nodePath: null,
  };
}

/**
 * 读取全局配置。
 *
 * 三条自愈路径：
 *  - 文件不存在 → 写入默认值；
 *  - schema 版本落后 → 就地升级；
 *  - **文件损坏**（`core.readJson` 对非法 JSON 是抛错而非返回 null，见 `core/fsx.ts`）
 *    → 把原文件**改名备份**为 `launcher.json.bak-<毫秒>`，再以默认配置继续启动。
 *    绝不静默吞掉这份文件：备份失败时连默认值也不写回，宁可让用户自己修。
 */
export async function loadConfig(): Promise<LauncherConfig> {
  const file = corePaths().configFile;

  let raw: Record<string, unknown> | null = null;
  try {
    raw = await core.readJson<Record<string, unknown>>(file);
  } catch (error) {
    const backedUp = await backupBrokenConfig(file, error);
    const fallback = defaultConfig();
    if (backedUp) {
      // 原文件已安全挪到备份路径 → 现在写一份干净的默认配置，下次启动即恢复正常。
      await persist(fallback);
    } else {
      console.error('[config] 备份失败，本次仅在内存中回退默认值，不会改写磁盘上的损坏文件。');
    }
    return fallback;
  }

  if (raw === null) {
    const created = defaultConfig();
    await persist(created);
    return created;
  }

  const config = normalize(raw, defaultConfig());
  // schema 升级时立即回写，保证磁盘上永远是当前版本。
  if (raw['schemaVersion'] !== config.schemaVersion) await persist(config);
  return config;
}

/**
 * 损坏配置的恢复：把原文件改名备份（不覆盖任何既有备份），并把处置结果告诉用户。
 * @returns 是否已成功备份（false 表示原文件仍在原地，调用方不得写回默认值覆盖它）
 */
async function backupBrokenConfig(file: string, cause: unknown): Promise<boolean> {
  const backup = await backupPathFor(file);
  const reason = describeError(cause);

  if (backup === null) {
    const notice = `全局配置 ${file} 已损坏且无法备份（${reason}）。本次以默认配置运行，原文件保持原样未被改动，请你自行检查。`;
    console.error(`[config] ${notice}`);
    queueNotice(notice);
    return false;
  }

  const notice = `全局配置已损坏（${reason}）。原文件已备份为 ${backup}，本次以默认配置启动；如需找回旧设置，请打开该备份文件。`;
  console.error(`[config] ${notice}`);
  queueNotice(notice);
  return true;
}

/** 生成不冲突的备份路径：`<file>.bak-<毫秒>`，重名时追加 `-1`、`-2`… */
async function backupPathFor(file: string): Promise<string | null> {
  const stamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? `${file}.bak-${stamp}` : `${file}.bak-${stamp}-${attempt}`;
    try {
      // rename 到已存在的目标会失败（Windows 报 EEXIST/EPERM）→ 换名重试，
      // 因此**永远不会覆盖**用户此前留下的备份。
      await rename(file, candidate);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') continue;
      console.error('[config] 备份损坏配置失败：', error);
      return null;
    }
  }
  console.error('[config] 备份损坏配置失败：连续 100 次未能找到可用备份名。');
  return null;
}

/* ------------------------------------------------------------------ *
 * 一次性用户通知
 * ------------------------------------------------------------------ */

/** 启动早期还没有窗口，先把提示攒起来；渲染层就绪后由 `index.ts` 取走推送。 */
const pendingNotices: string[] = [];

/** 取走待推送的通知（取走即清空）。 */
export function takePendingNotices(): string[] {
  return pendingNotices.splice(0, pendingNotices.length);
}

/**
 * 记录一条需要让用户看到的提示。
 * 同时尝试立刻下发到日志流（窗口已存在时生效）；窗口还没建好时留在队列里等 `did-finish-load`。
 */
function queueNotice(text: string): void {
  pendingNotices.push(text);
  try {
    logSink(LAUNCHER_LOG_ID)('system', `${text}\n`);
  } catch (error) {
    console.warn('[config] 立即下发提示失败（将等窗口就绪后补发）：', error);
  }
}

/**
 * 合并写入全局配置。
 * 只接受已知字段；未知字段忽略（渲染层可能直接把整份配置对象传回来）。
 */
export async function saveConfig(patch: unknown): Promise<LauncherConfig> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError('配置参数格式不正确（应为对象）。');
  }
  const source = patch as Record<string, unknown>;
  const next: LauncherConfig = { ...(await loadConfig()) };

  if (source['primaryHome'] !== undefined) {
    const home = nonEmpty(source['primaryHome']) ?? '';
    if (home.length === 0) throw new AppError('主 home 不能为空。');
    if (!path.isAbsolute(home)) throw new AppError(`主 home 必须是绝对路径，收到：${home}`);
    next.primaryHome = home;
  }
  if (source['theme'] !== undefined) {
    const theme = source['theme'];
    if (theme !== 'dark' && theme !== 'light') throw new AppError('主题只能是 dark 或 light。');
    next.theme = theme;
  }
  if (source['lastInstanceId'] !== undefined) {
    const id = source['lastInstanceId'];
    if (id !== null && typeof id !== 'string') throw new AppError('lastInstanceId 必须是字符串或 null。');
    next.lastInstanceId = nonEmpty(id);
  }
  if (source['confirmOnDelete'] !== undefined) {
    const flag = source['confirmOnDelete'];
    if (typeof flag !== 'boolean') throw new AppError('confirmOnDelete 必须是布尔值。');
    next.confirmOnDelete = flag;
  }
  if (source['engineRegistry'] !== undefined) {
    const registry = nonEmpty(source['engineRegistry']) ?? '';
    if (registry.length === 0) throw new AppError('引擎源不能为空。');
    next.engineRegistry = registry;
  }
  if (source['nodePath'] !== undefined) {
    const value = source['nodePath'];
    if (value !== null && typeof value !== 'string') {
      throw new AppError('Node 运行时路径必须是字符串或 null（null 表示自动探测）。');
    }
    const file = nonEmpty(value);
    if (file !== null) {
      if (!path.isAbsolute(file)) throw new AppError(`Node 运行时路径必须是绝对路径，收到：${file}`);
      const info = await stat(file).catch(() => null);
      if (info === null || !info.isFile()) throw new AppError(`找不到 Node 可执行文件：${file}`);
    }
    next.nodePath = file;
  }
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) console.warn(`[config] 忽略未知配置字段：${key}`);
  }

  next.schemaVersion = SCHEMA_VERSION;
  await persist(next);
  // 改了 Node 路径就必须丢掉探测缓存，否则界面点"重新检测"仍会看到旧结论
  if (source['nodePath'] !== undefined) core.resetNodeRuntimeCache();
  return next;
}

/** 记住最近一次启动的实例（失败不阻断启动流程）。 */
export async function rememberInstance(id: string | null): Promise<void> {
  try {
    await saveConfig({ lastInstanceId: id });
  } catch (error) {
    console.warn('[config] 记录最近实例失败：', error);
  }
}

/** 返回给渲染层的配置视图（附带只读 rootDir）。 */
export function withRoot(config: LauncherConfig): LauncherConfig {
  return { ...config, rootDir: launcherRoot() };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'primaryHome',
  'theme',
  'lastInstanceId',
  'confirmOnDelete',
  'engineRegistry',
  'nodePath',
  'rootDir',
]);

function normalize(raw: Record<string, unknown>, base: LauncherConfig): LauncherConfig {
  const theme = raw['theme'] === 'light' ? 'light' : 'dark';
  return {
    schemaVersion: SCHEMA_VERSION,
    primaryHome: nonEmpty(raw['primaryHome']) ?? base.primaryHome,
    theme,
    lastInstanceId: nonEmpty(raw['lastInstanceId']),
    confirmOnDelete:
      typeof raw['confirmOnDelete'] === 'boolean' ? raw['confirmOnDelete'] : base.confirmOnDelete,
    engineRegistry: nonEmpty(raw['engineRegistry']) ?? base.engineRegistry,
    nodePath: nonEmpty(raw['nodePath']),
  };
}

async function persist(config: LauncherConfig): Promise<void> {
  const { rootDir: _rootDir, ...rest } = config;
  await core.writeJsonAtomic(corePaths().configFile, rest);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
