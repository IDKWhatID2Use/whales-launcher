/**
 * WhalesLauncher core —— 路径解析层
 *
 * 启动器根目录（`root`）下的全部关键路径都在这里定义，其它模块**不得**自行拼接。
 * 同时集中定义 npm/pnpm 子进程所需的缓存路径与安全环境变量，避免散落硬编码。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CorePaths, InstanceMeta, InstancePaths } from '../shared/contracts';
import { validateName } from './names';
import { extraCommandDirsSnapshot } from './proc';

/**
 * 启动器根下的缓存目录名。
 *
 * npm / pnpm 子进程必须显式指向它：本机环境变量 `npm_config_cache` 指向工作区外，
 * 而配置优先级是「命令行 > 环境变量 > 项目 .npmrc」，不覆盖就会触发沙箱 EPERM。
 */
export const CACHE_DIR_NAME = 'cache';

/** 实例元数据文件名。 */
export const INSTANCE_META_FILE = 'instance.json';

/** 实例目录（`instances/`）名。 */
export const INSTANCES_DIR_NAME = 'instances';

/** 引擎目录（`engines/`）名。 */
export const ENGINES_DIR_NAME = 'engines';

/** 共享资源目录（`shared/`）名。 */
export const SHARED_DIR_NAME = 'shared';

/** 启动器全局设置文件名。 */
export const LAUNCHER_CONFIG_FILE = 'launcher.json';

/**
 * 启动器自备运行时目录（`runtime/`）。
 *
 * 首次启动自检在系统没有任何可用 Node.js 时会向这里**下载一份便携版 Node**
 * （`<root>/runtime/node/node.exe`，见 `src/core/node-provision.ts`），
 * 它是"零手动安装"的落点：解压即用、不需要管理员权限、不污染系统 `PATH`。
 */
export const RUNTIME_DIR_NAME = 'runtime';

/** dsh 包在引擎目录里的相对位置。 */
export const DSH_PACKAGE_RELATIVE = path.join('node_modules', '@deepseek-ai', 'dsh');

/**
 * 记录"当前正在操作的启动器根目录"。
 *
 * 少数契约方法没有 root 参数（如 `listAvailableEngines`），却又必须定位一个可写的
 * cache 目录。任何带 root 的调用都会经由 {@link corePaths}/{@link instancePaths}
 * 顺带记录，因此实际运行时总能拿到正确的根目录；**刻意不依赖 `process.cwd()`**
 * （Electron 从快捷方式启动时 cwd 由系统决定，见 QA F1/F2）。
 */
let rememberedRoot: string | null = null;

/**
 * 读取最近一次使用的启动器根目录。
 * @returns 根目录；从未使用过返回 `null`。
 */
export function lastRoot(): string | null {
  return rememberedRoot;
}

/**
 * 显式记录启动器根目录（`$WHALES_LAUNCHER_ROOT` 之外的第二种显式途径）。
 * @param root 启动器根目录。
 */
export function rememberRoot(root: string): void {
  rememberedRoot = root;
}

/**
 * 启动器自备运行时目录：`<root>/runtime/node`。
 * @param root 启动器根目录。
 * @returns 目录绝对路径（不保证存在）。
 */
export function portableNodeDir(root: string): string {
  return path.join(root, RUNTIME_DIR_NAME, 'node');
}

/**
 * 启动器自备 Node 可执行文件：`<root>/runtime/node/node.exe`（非 Windows 上为 `node`）。
 *
 * 路径**必须**由本函数给出：C# 侧（`Services/NodeProvisioner.cs`）写、Node 侧
 * （`node-runtime.ts` 的候选枚举）读，两边写死各自的一份就会漂移成"装好了却探测不到"。
 * @param root 启动器根目录。
 * @returns 可执行文件绝对路径（不保证存在）。
 */
export function portableNodeExe(root: string): string {
  return path.join(portableNodeDir(root), process.platform === 'win32' ? 'node.exe' : 'node');
}

/**
 * 计算启动器关键路径。
 * @param root 启动器根目录（绝对路径）。
 * @returns 关键路径集合。
 */
export function corePaths(root: string): CorePaths {
  rememberedRoot = root;
  const sharedDir = path.join(root, SHARED_DIR_NAME);
  return {
    root,
    instancesDir: path.join(root, INSTANCES_DIR_NAME),
    enginesDir: path.join(root, ENGINES_DIR_NAME),
    sharedDir,
    sharedSessionsDir: path.join(sharedDir, 'sessions'),
    sharedWorkspacesDir: path.join(sharedDir, 'workspaces'),
    cacheDir: path.join(root, CACHE_DIR_NAME),
    configFile: path.join(root, LAUNCHER_CONFIG_FILE),
  };
}

/**
 * 计算某个实例的文件系统布局。
 *
 * `dirName` 必须通过 dsh 的 profile 名校验，否则直接抛错——这是防止 `..` 之类的
 * 目录穿越把读写引到实例区之外的最后一道闸门。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 实例路径集合。
 */
export function instancePaths(root: string, meta: InstanceMeta): InstancePaths {
  const invalid = validateName(meta.dirName);
  if (invalid !== null) throw new Error(`实例目录名不合法（${meta.dirName}）：${invalid}`);
  const invalidProfile = validateName(meta.profile.name);
  if (invalidProfile !== null) throw new Error(`profile 名不合法（${meta.profile.name}）：${invalidProfile}`);
  const instanceRoot = path.join(corePaths(root).instancesDir, meta.dirName);
  const home = path.join(instanceRoot, 'home');
  const profilesDir = path.join(home, 'profiles');
  return {
    root: instanceRoot,
    home,
    workspace: path.join(instanceRoot, 'workspace'),
    logs: path.join(instanceRoot, 'logs'),
    sessions: path.join(home, 'sessions'),
    settingsFile: path.join(home, 'settings.yaml'),
    credentialsFile: path.join(home, '.credentials.yaml'),
    metaFile: path.join(instanceRoot, INSTANCE_META_FILE),
    profilesDir,
    profileDir: path.join(profilesDir, meta.profile.name),
    pluginsDir: path.join(home, 'plugins'),
  };
}

/**
 * 引擎版本目录：`<root>/engines/<version>`。
 * @param root 启动器根目录。
 * @param version dsh 版本号。
 * @returns 引擎目录绝对路径。
 */
export function engineDir(root: string, version: string): string {
  return path.join(corePaths(root).enginesDir, version);
}

/**
 * 引擎内 dsh 包目录：`<root>/engines/<version>/node_modules/@deepseek-ai/dsh`。
 * @param root 启动器根目录。
 * @param version dsh 版本号。
 * @returns dsh 包目录绝对路径。
 */
export function enginePackageDir(root: string, version: string): string {
  return path.join(engineDir(root, version), DSH_PACKAGE_RELATIVE);
}

/**
 * 引擎入口候选路径：`<dsh 包目录>/lib/bin.js`。
 * @param root 启动器根目录。
 * @param version dsh 版本号。
 * @returns 入口绝对路径（不保证存在）。
 */
export function engineBinCandidate(root: string, version: string): string {
  return path.join(enginePackageDir(root, version), 'lib', 'bin.js');
}

/**
 * 共享设置文件路径：`<root>/shared/settings.yaml`。
 * @param root 启动器根目录。
 * @returns 共享设置文件绝对路径。
 */
export function sharedSettingsFile(root: string): string {
  return path.join(corePaths(root).sharedDir, 'settings.yaml');
}

/**
 * 共享工作区目录：`<root>/shared/workspaces/<dirName>`。
 * @param root 启动器根目录。
 * @param dirName 实例目录名。
 * @returns 共享工作区绝对路径。
 */
export function sharedWorkspaceDir(root: string, dirName: string): string {
  return path.join(corePaths(root).sharedWorkspacesDir, dirName);
}

/**
 * 子进程必须注入的基础环境变量（npm / pnpm / dsh plugin 都要用）。
 *
 * - `npm_config_cache`：覆盖本机指向工作区外的环境变量，与命令行 `--cache` 双保险。
 * - `ELECTRON_SKIP_BINARY_DOWNLOAD`：本机访问不了 github，禁止 npm 安装时联网拉 Electron 二进制。
 * @param root 启动器根目录。
 * @param extra 额外环境变量。
 * @returns 环境变量对象。
 */
export function childBaseEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    npm_config_cache: corePaths(root).cacheDir,
    // 与 `--config.store-dir` 配对：命令行走 pnpm 自己的参数解析，
    // 环境变量兜住那些不读我们命令行参数的 pnpm 内部调用。
    npm_config_store_dir: pnpmStoreDir(root),
    // pnpm 在无 TTY 时需要它才肯重建 node_modules，否则直接中止：
    //   ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    //   "Aborted removal of modules directory due to no TTY … set the CI environment
    //    variable to true, or set confirmModulesPurge to false"
    // 启动器（以及它拉起的一切）本来就没有交互终端，这里如实声明。
    CI: 'true',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    ...runtimePathEnv(),
    ...extra,
  };
}

/**
 * 把自备运行时目录前置到子进程的 `PATH`。
 *
 * 覆盖的场景：启动器在首次自检里下载了便携版 Node（`<root>/runtime/node`），但系统
 * `PATH` 上并没有 Node —— 此时 `dsh` 自己、以及它拉起的 `pnpm` / 插件安装脚本都必须
 * 能找到同一份 `node`/`npm`，否则「引擎装上了却起不来」。目录来源是
 * `node-runtime.ts` 探针判定成功的那一个（见 `proc.ts` 的 `setExtraCommandDirs`）。
 * @returns 只含 `PATH` 的环境变量片段；无额外目录时为空对象（不覆盖原值）。
 */
export function runtimePathEnv(): NodeJS.ProcessEnv {
  const dirs = extraCommandDirsSnapshot();
  if (dirs.length === 0) return {};
  const current = process.env['PATH'] ?? '';
  const prefix = dirs.join(path.delimiter);
  return { PATH: current.length > 0 ? `${prefix}${path.delimiter}${current}` : prefix };
}

/**
 * npm 子进程的缓存参数（命令行层面显式指定）。
 * @param root 启动器根目录。
 * @returns 参数数组。
 */
export function npmCacheArgs(root: string): string[] {
  return ['--cache', corePaths(root).cacheDir];
}

/**
 * pnpm 子进程的缓存与 store 参数。
 *
 * pnpm 10 用 `--config.<key>` 形式传配置项（实测 `dsh plugin ... add <pkg> --config.cache=<dir>`
 * 可正常透传，EXIT=0）。
 *
 * **`store-dir` 必须显式固定**（2026-09-20 实测定位）：
 * pnpm 未固定 store 时按 `<cache 所在盘>\.pnpm-store` 推导，而本机
 * 用户级 `~/.npmrc` 有 `cache=F:\NodeJS\node_cache`、启动器为沙箱注入的
 * `npm_config_cache` 又在工作区内 —— 同一台机器于是算出**两个盘符不同的 store**，
 * 直接撞上：
 * ```
 * ERR_PNPM_UNEXPECTED_STORE  The dependencies … are currently linked from the store at
 * "F:\WhalesLauncher\.pnpm-store\v10"  but pnpm now wants to use "F:\.pnpm-store\v10"
 * ```
 * 固定值的选取依据是**用户环境实际在用的那个**（实测 `F:\.pnpm-store` 有 2.4 GB、
 * 1787 条索引，工作区内那个是空的）：统一到它之后，「手敲 pnpm」「dsh 市场」
 * 「启动器」三条路径才会落到同一个 store，不再互相判为"位置不符"。
 * @param root 启动器根目录。
 * @returns 参数数组。
 */
export function pnpmCacheArgs(root: string): string[] {
  return [
    `--config.cache=${corePaths(root).cacheDir}`,
    `--config.store-dir=${pnpmStoreDir(root)}`,
    // 无 TTY 时不得停下来等确认（与 childBaseEnv 的 CI 双保险）
    '--config.confirm-modules-purge=false',
  ];
}

/**
 * 启动器统一使用的 pnpm store：pnpm 自身的默认位置（`<盘>\.pnpm-store`）。
 *
 * 刻意**不**放在启动器根目录内：store 是机器级的包缓存，用户在终端里手敲的 pnpm、
 * dsh 市场自己发起的安装都用这个默认位置；启动器若另立一个，就会与它们互相判为
 * 「store 位置不符」而整体失败（见 {@link pnpmCacheArgs}）。
 * 盘的选取沿用 pnpm 的推导规则（cache 所在盘；未配置 cache 时用当前盘）。
 * @param root 启动器根目录。
 * @returns store 目录绝对路径。
 */
export function pnpmStoreDir(root: string): string {
  const drive = path.parse(corePaths(root).cacheDir).root;
  return path.join(drive || path.parse(root).root, '.pnpm-store');
}

/**
 * 同步解析某个引擎版本的入口脚本路径。
 *
 * 优先 `<dsh 包>/lib/bin.js`（dsh 的实际入口）；否则回退读取该包 `package.json` 的
 * `bin` / `main` 字段。放在 `paths.ts` 是为了让 `instance.ts` 与 `engine.ts` 都能用
 * 而**不互相 import**（避免循环依赖）。
 * @param root 启动器根目录。
 * @param version dsh 版本号（= 引擎目录名）。
 * @returns 入口绝对路径；未安装返回 `null`。
 */
export function engineBinPathIfPresent(root: string, version: string): string | null {
  const packageDir = enginePackageDir(root, version);
  const direct = path.join(packageDir, 'lib', 'bin.js');
  if (existsSync(direct)) return direct;
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown; main?: unknown };
    const bin = manifest.bin;
    if (typeof bin === 'string') {
      const candidate = path.join(packageDir, bin);
      return existsSync(candidate) ? candidate : null;
    }
    if (typeof bin === 'object' && bin !== null) {
      const record = bin as Record<string, unknown>;
      const first = record['dsh'] ?? Object.values(record)[0];
      if (typeof first === 'string') {
        const candidate = path.join(packageDir, first);
        return existsSync(candidate) ? candidate : null;
      }
    }
    if (typeof manifest.main === 'string') {
      const candidate = path.join(packageDir, manifest.main);
      return existsSync(candidate) ? candidate : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 生成日志文件名（Windows 文件名不能含 `:`）。
 * @param date 时间戳。
 * @returns 形如 `2026-02-03T10-20-30-123Z.log` 的文件名。
 */
export function logFileName(date: Date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/g, '-')}.log`;
}
