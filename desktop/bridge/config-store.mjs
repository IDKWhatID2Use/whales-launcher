/**
 * 启动器根目录与全局配置（`launcher.json`）—— 等价搬运自旧主进程 `config.ts`。
 *
 * 唯一与 Electron 解耦的改动：旧实现用 `app.getAppPath()` 得到启动器根目录
 * （config.ts L21-L31），侧车进程改用协议 §1 的启动参数 `--home <dir>`
 * （由 `server.mjs` 在启动时经 {@link configureRoot} 注入）。
 * 其余行为逐条保留：
 *  - 配置读取的三条自愈路径（缺失→写默认值 / schema 落后→就地升级 / 损坏→改名备份）；
 *  - 损坏备份**绝不覆盖**既有备份（rename 到已存在目标会失败 → 换名重试）；
 *  - `rootDir` 只注入给调用方，**绝不落盘**（config.ts L259-L262 的 persist）。
 */
import { rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { core } from '../../src/core/index.ts';
import { SCHEMA_VERSION } from '../../src/shared/contracts.ts';
import { AppError, describeError } from './errors.mjs';

/** 启动器根目录（由 `--home` 注入，进程生命周期内不变）。 */
let cachedRoot = null;

/**
 * 构建期注入的启动器版本（`scripts/build-bridge.mjs` 从仓库 package.json 用 esbuild
 * `--define` 注入，见该脚本的 `--define:__WHALES_APP_VERSION__=`）。
 *
 * 为什么必须是**构建期常量**而不是运行时读文件：
 *  - 旧实现是 Electron 的 `app.getVersion()`，它读的是**应用自身**的 package.json，
 *    而应用的代码根恰好就是数据根，两者重合；
 *  - WinUI 3 布局下 `--home` 是**数据目录**（由 C# 传入，可能是任意路径、甚至尚无
 *    package.json），启动器版本属于**构建产物**，与数据目录无关。
 * 运行期沿相对路径去猜 package.json 会得到一个与真实版本无关的结论 —— 这正是
 * 「版本探测路径」缺陷的根源。构建期注入不依赖任何运行时相对路径。
 *
 * `typeof` 守卫：未打包直接 `node desktop/bridge/server.mjs` 时该标识符不存在，
 * `typeof` 对未声明标识符不抛错，于是退回运行期兜底（见 {@link loadAppVersion}）。
 */
const BUILD_VERSION = typeof __WHALES_APP_VERSION__ === 'string' ? __WHALES_APP_VERSION__.trim() : '';

/**
 * 已确定的启动器版本；`null` = **未知**。
 *
 * 契约上版本是 `string`，但"未知"绝不允许用假值（如 `0.0.0`）冒充 ——
 * 那会污染界面上显示的版本号与实例包里的 `launcherVersion` 元数据。
 * 未知时 `app:version` 返回明确的 `ok:false`（协议 §4），`pack:export` 直接拒绝。
 */
let cachedVersion = null;

/* ------------------------------------------------------------------ *
 * 根目录
 * ------------------------------------------------------------------ */

/**
 * 注入启动器根目录。**必须在任何 core 调用之前执行**。
 * @param {string} home `--home` 传入的目录（绝对路径）。
 * @returns {string} 解析后的绝对路径。
 */
export function configureRoot(home) {
  const resolved = path.resolve(home);
  cachedRoot = resolved;
  pinLauncherRoot(resolved);
  return resolved;
}

/** 启动器根目录。 */
export function launcherRoot() {
  if (cachedRoot === null) {
    throw new Error('启动器根目录尚未初始化：--home 缺失或 configureRoot() 未被调用。');
  }
  return cachedRoot;
}

/** 启动器根下的关键路径（由 core 解析，不重复实现）。来源：config.ts L33-L36 */
export function launcherPaths() {
  return core.corePaths(launcherRoot());
}

/**
 * 把启动器根目录钉进 `$WHALES_LAUNCHER_ROOT` —— core 的 `defaultRootForCache()` 会读它。
 * 来源：旧主进程 index.ts L63-L84（含"cwd 与启动器根毫无关系"的原始理由）。
 */
function pinLauncherRoot(root) {
  const previous = process.env['WHALES_LAUNCHER_ROOT'];
  if (previous !== undefined && previous.trim().length > 0 && path.resolve(previous) !== root) {
    console.warn(`[bridge] 覆写环境变量 WHALES_LAUNCHER_ROOT：${previous} → ${root}`);
  }
  process.env['WHALES_LAUNCHER_ROOT'] = root;
}

/* ------------------------------------------------------------------ *
 * 全局配置
 * ------------------------------------------------------------------ */

/** 出厂默认配置。来源：config.ts L38-L50 */
export function defaultConfig() {
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
 * 读取全局配置（三条自愈路径，来源：config.ts L52-L90）。
 * @returns {Promise<object>} 配置对象（不含 `rootDir`）。
 */
export async function loadConfig() {
  const file = launcherPaths().configFile;

  let raw = null;
  try {
    raw = await core.readJson(file);
  } catch (error) {
    const backedUp = await backupBrokenConfig(file, error);
    const fallback = defaultConfig();
    if (backedUp) {
      // 原文件已安全挪到备份路径 → 现在写一份干净的默认配置，下次启动即恢复正常。
      await persist(fallback);
    } else {
      console.error('[bridge] 备份失败，本次仅在内存中回退默认值，不会改写磁盘上的损坏文件。');
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
 * 来源：config.ts L92-L111
 * @returns {Promise<boolean>} 是否已成功备份。
 */
async function backupBrokenConfig(file, cause) {
  const backup = await backupPathFor(file);
  const reason = describeError(cause);

  if (backup === null) {
    const notice = `全局配置 ${file} 已损坏且无法备份（${reason}）。本次以默认配置运行，原文件保持原样未被改动，请你自行检查。`;
    console.error(`[bridge] ${notice}`);
    queueNotice(notice);
    return false;
  }

  const notice = `全局配置已损坏（${reason}）。原文件已备份为 ${backup}，本次以默认配置启动；如需找回旧设置，请打开该备份文件。`;
  console.error(`[bridge] ${notice}`);
  queueNotice(notice);
  return true;
}

/** 生成不冲突的备份路径：`<file>.bak-<毫秒>`，重名时追加 `-1`、`-2`…。来源：config.ts L113-L132 */
async function backupPathFor(file) {
  const stamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? `${file}.bak-${stamp}` : `${file}.bak-${stamp}-${attempt}`;
    try {
      // rename 到已存在的目标会失败（Windows 报 EEXIST/EPERM）→ 换名重试，
      // 因此**永远不会覆盖**用户此前留下的备份。
      await rename(file, candidate);
      return candidate;
    } catch (error) {
      const code = error?.code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') continue;
      console.error('[bridge] 备份损坏配置失败：', error);
      return null;
    }
  }
  console.error('[bridge] 备份损坏配置失败：连续 100 次未能找到可用备份名。');
  return null;
}

/* ------------------------------------------------------------------ *
 * 一次性用户通知（对应 config.ts L134-L157）
 * ------------------------------------------------------------------ */

/** 启动早期攒下的提示；`__handshake` 完成后由 server 取走并作为 log:chunk 补发。 */
const pendingNotices = [];

/** 取走待推送的通知（取走即清空）。来源：config.ts L142-L144 */
export function takePendingNotices() {
  return pendingNotices.splice(0, pendingNotices.length);
}

/**
 * 记录一条需要让用户看到的提示。
 *
 * 旧实现（config.ts L150-L157）：先尝试立刻下发到日志流，窗口还没建好时留在队列里
 * 等 `did-finish-load`。桥接层改为**单一投递路径**：只入队，由 `server.mjs` 在
 * 每次响应写出之后（且已完成握手）作为 `log:chunk` 补发 ——
 * 这样既复用了旧实现"界面就绪后补发"的时机语义，又不会出现同一提示被投递两次。
 */
function queueNotice(text) {
  pendingNotices.push(text);
}

/**
 * 合并写入全局配置。只接受已知字段；未知字段忽略。来源：config.ts L159-L218
 * @param {unknown} patch 渲染层传来的原始值（当未知数据处理）。
 * @returns {Promise<object>} 写入后的配置。
 */
export async function saveConfig(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new AppError('配置参数格式不正确（应为对象）。');
  }
  const source = patch;
  const next = { ...(await loadConfig()) };

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
    if (!KNOWN_KEYS.has(key)) console.warn(`[bridge] 忽略未知配置字段：${key}`);
  }

  next.schemaVersion = SCHEMA_VERSION;
  await persist(next);
  // 改了 Node 路径就必须丢掉探测缓存，否则界面点"重新检测"仍会看到旧结论
  if (source['nodePath'] !== undefined) core.resetNodeRuntimeCache();
  return next;
}

/** 记住最近一次启动的实例（失败不阻断启动流程）。来源：config.ts L220-L227 */
export async function rememberInstance(id) {
  try {
    await saveConfig({ lastInstanceId: id });
  } catch (error) {
    console.warn('[bridge] 记录最近实例失败：', error);
  }
}

/** 返回给宿主的配置视图（附带只读 rootDir）。来源：config.ts L229-L232 */
export function withRoot(config) {
  return { ...config, rootDir: launcherRoot() };
}

/** 来源：config.ts L234-L243 */
const KNOWN_KEYS = new Set([
  'schemaVersion',
  'primaryHome',
  'theme',
  'lastInstanceId',
  'confirmOnDelete',
  'engineRegistry',
  'nodePath',
  'rootDir',
]);

/** 来源：config.ts L245-L257 */
function normalize(raw, base) {
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

/** 落盘时一律剥掉 rootDir。来源：config.ts L259-L262 */
async function persist(config) {
  const { rootDir: _rootDir, ...rest } = config;
  await core.writeJsonAtomic(launcherPaths().configFile, rest);
}

/** 来源：config.ts L264-L268 */
function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------------------------------------------ *
 * 应用版本（替代旧 `app.getVersion()`）
 * ------------------------------------------------------------------ */

/**
 * 解析启动器版本。
 *
 * 优先级：
 *  1. **构建期注入**（`--define:__WHALES_APP_VERSION__`）—— 生产路径，权威且与运行时
 *     相对路径无关；
 *  2. 未打包运行时的兜底：读 `<home>/package.json` 的 `version`（开发期 `--home`
 *     通常就是仓库根，因此这一步在本地直跑源码时仍然可用）。
 *
 * 两条都拿不到时把 {@link cachedVersion} 置为 `null`（**未知**）并在 stderr 说明，
 * 绝不返回 `0.0.0` 之类的假值：`app:version` 会因此返回 `ok:false`，
 * `pack:export` 会拒绝导出（避免把错误版本写进落盘的包元数据）。
 * @returns {Promise<string|null>} 版本号；未知为 null。
 */
export async function loadAppVersion() {
  if (BUILD_VERSION.length > 0) {
    cachedVersion = BUILD_VERSION;
    return cachedVersion;
  }

  const file = path.join(launcherRoot(), 'package.json');
  try {
    const pkg = await core.readJson(file);
    const version = pkg !== null && typeof pkg['version'] === 'string' ? pkg['version'].trim() : '';
    if (version.length === 0) throw new Error('package.json 缺少 version 字段');
    cachedVersion = version;
    console.warn(`[bridge] 未注入构建期版本号，改用 ${file} 的 version=${version}。`);
  } catch (error) {
    cachedVersion = null;
    console.warn(
      `[bridge] 无法确定启动器版本（构建期未注入版本号，且 ${file} 不可用：${describeError(error)}）；` +
        'app:version 将返回 ok:false，pack:export 将拒绝执行。请重新执行 node scripts/build-bridge.mjs。',
    );
  }
  return cachedVersion;
}

/** 已确定的启动器版本；`null` = 未知（**不会**用假值冒充）。 */
export function appVersionOrNull() {
  return cachedVersion;
}

/* ------------------------------------------------------------------ *
 * 启动自愈（对应旧主进程 index.ts L161-L182）
 * ------------------------------------------------------------------ */

/**
 * 自愈创建启动器根下的关键目录（首次运行时 `instances/` 必然不存在）。
 * 单个目录失败只记日志，不阻断启动。
 */
export async function selfHealDirectories() {
  const paths = launcherPaths();
  const required = [
    paths.root,
    paths.instancesDir,
    paths.sharedDir,
    paths.sharedSessionsDir,
    paths.sharedWorkspacesDir,
    paths.cacheDir,
  ];
  for (const dir of required) {
    try {
      await core.ensureDir(dir);
    } catch (error) {
      console.error(`[bridge] 目录初始化失败：${dir}`, error);
    }
  }
}
