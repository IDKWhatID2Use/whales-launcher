/**
 * WhalesLauncher core —— 统一入口
 *
 * 纯 Node/TypeScript 引擎，**不依赖 Electron**；对外只暴露
 * `src/shared/contracts.ts` 里的 `CoreApi` 形状（`export const core`）。
 *
 * 与 dsh 的边界只有两条（架构决策 D3）：
 *  1. `dsh` CLI 子进程（创建 profile、插件增删、启动）
 *  2. 文件系统约定（`$DSH_HOME` 布局、`profiles/<name>/package.json`、`sessions/`）
 * 绝不 import dsh 内部 API —— 多版本共存时内部 API 会漂移。
 *
 * 模块划分：
 *  - `fsx.ts`      文件工具（原子写、junction 安全增删）
 *  - `proc.ts`     子进程（管道优先，受限环境自动降级为文件重定向）
 *  - `paths.ts`    路径解析 + npm 缓存环境（子进程必用）
 *  - `names.ts`    名称校验（复刻 dsh profile 名规则）
 *  - `instance.ts` 实例 CRUD + 共享模式落地 + 共享冲突登记
 *  - `engine.ts`   dsh 版本管理
 *  - `profile.ts`  profile 清单 / 设置 / 组合包开关
 *  - `plugins.ts`  插件增删（走 `dsh plugin`）
 *  - `launch.ts`   启动与运行时状态
 *  - `saves.ts`    会话枚举与 workspace 编码
 *  - `modpack.ts`  实例包导入导出
 *  - `runtime.ts`  进程内运行时登记表
 *
 * > 语法约束：`src/core/**` 必须能被 Node 的 **strip-only 类型擦除**直接加载
 * > （测试会直接 import 源码），因此**不得**使用 `enum`、`namespace`、
 * > 构造函数参数属性、`declare` 类字段等需要转译的语法。
 */
import type { CoreApi } from '../shared/contracts';
import { dirSize, ensureDir, isLink, pathExists, readJson, readText, removeLink, replaceWithJunction, writeJsonAtomic, writeTextAtomic } from './fsx';
import { corePaths, engineBinPathIfPresent, instancePaths } from './paths';
import { makeDirName, validateName } from './names';
import {
  applyShareModes,
  clearShareConflicts,
  createInstance,
  deleteInstance,
  deleteInstanceDetailed,
  findOrphanSharedWorkspaces,
  listInstances,
  listShareConflicts,
  markLaunched,
  readInstance,
  readInstanceRegistry,
  resolveSettingsConflict,
  removeOrphanSharedWorkspace,
  updateInstance,
} from './instance';
import type { InstanceRemovalReport, InstanceSummaryExt, ShareConflict } from './instance';
import {
  attachEngineFromLocal,
  computeEngineSize,
  installEngine,
  latestEngineVersion,
  listAvailableEngines,
  listEngines,
  removeEngine,
  resolveEngineBin,
} from './engine';
import {
  readInstanceSettings,
  readProfileInventory,
  setBundleEnabled,
  writeInstanceSettings,
} from './profile';
import { pluginAdd, pluginRemove } from './plugins';
import { installPlugin, listInstancePlugins, pluginsDir, removeInstancePlugin } from './plugin-packs';
import { PREFLIGHT_STATUS_LABELS, readPreflightState, runPreflight } from './preflight';
import { allRuntimes, describeStopFailure, explainLaunchFailure, instanceRuntime, launchInstance, stopInstance } from './launch';
import { resetNodeRuntimeCache, resolveNodeRuntime } from './node-runtime';
import { listSessions, workspaceKeyFor } from './saves';
import { exportPack, importPack, readPackManifest } from './modpack';
import { clearRuntime, listRuntimes, patchRuntime, putRuntime, runtimeOf, setRuntimeState } from './runtime';

/**
 * 非契约扩展：契约之外但 main/UI 需要的工具
 * （共享冲突处理、离线接入引擎、包元数据预览等）。
 */
const coreExtras = {
  /** 列出共享模式冲突（设置文件本地/共享不一致时由调用方决定如何解决）。 */
  listShareConflicts,
  /** 清除共享模式冲突记录。 */
  clearShareConflicts,
  /** 由 UI 决定如何解决设置冲突：`use-local` 或 `use-shared`（覆盖前自动备份）。 */
  resolveSettingsConflict,
  /**
   * 查询 npm registry 上 `latest` dist-tag 指向的 dsh 版本。
   *
   * 供环境自检在"一个引擎都没有"时决定装哪个版本（`preflight.ts` 内部也用它），
   * 以及界面提供"安装最新版"入口时复用同一份判定。
   */
  latestEngineVersion,
  /** 把一个本地已存在的 dsh 安装用 junction 接入引擎目录（离线铺设，不联网）。 */
  attachEngineFromLocal,
  /** 读取实例包元数据（导入前预览）。 */
  readPackManifest,
  /** 记录一次启动（`lastLaunchedAt` / `launchCount`）。 */
  markLaunched,
  /** 实例索引快照（目录缺失/元数据损坏时的降级呈现来源）。 */
  readInstanceRegistry,
  /** "停止失败"的诚实文案（探测到进程仍存活时提示需手动结束）。 */
  describeStopFailure,
  /** 删除实例并返回报告（含共享数据残留信息，供 UI 提示）。 */
  deleteInstanceDetailed,
  /** 找出无人认领的共享工作区（供 UI 提供"清理残留"入口）。 */
  findOrphanSharedWorkspaces,
  /** 显式清理一个无人认领的共享工作区（被实例认领时拒绝）。 */
  removeOrphanSharedWorkspace,
  /** 立即统计引擎目录体积（列表默认惰性 + mtime 缓存）。 */
  computeEngineSize,
  /**
   * 探测运行 dsh 的 Node 运行时。
   *
   * dsh 必须由真正的 Node.js 执行（Electron 内置运行时会被其原生模块拒绝），
   * 因此界面需要一个"当前用哪个 node / 为什么不可用"的查询入口。
   * @param root 启动器根目录。
   * @param refresh 为 true 时忽略缓存重新探测。
   */
  detectNode: (root: string, refresh = false) =>
    resolveNodeRuntime({ root, captureDir: corePaths(root).cacheDir, refresh }),
  /** 清空 Node 运行时解析缓存（用户改了 nodePath 后必须调用）。 */
  resetNodeRuntimeCache,
};

/** core 引擎单例实现（契约 `CoreApi` 的逐条实现 + 少量显式标注的扩展）。 */
export const core: CoreApi & typeof coreExtras = {
  /* fsx */
  ensureDir,
  pathExists,
  readJson,
  writeJsonAtomic,
  readText,
  writeTextAtomic,
  isLink,
  replaceWithJunction,
  removeLink,
  dirSize,

  /* paths */
  corePaths,
  instancePaths,

  /* names */
  validateName,
  makeDirName,

  /* instance */
  listInstances,
  createInstance,
  readInstance,
  updateInstance,
  deleteInstance,
  applyShareModes,

  /* engine */
  listEngines,
  // root 透传：`listAvailableEngines` 的签名只有 registry，但 npm 需要一个可写的
  // cache 目录（本机环境变量指向工作区外会触发沙箱 EPERM）。这里保留可选第二参数
  // 透传 root，调用方（main）传了就用它，未传时回退 `$WHALES_LAUNCHER_ROOT` → cwd。
  listAvailableEngines: (registry: string, root?: string) => listAvailableEngines(registry, root),
  installEngine,
  removeEngine,
  resolveEngineBin,

  /* preflight */
  runPreflight,

  /* profile / settings */
  readProfileInventory,
  readInstanceSettings,
  writeInstanceSettings,
  setBundleEnabled,

  /* plugins */
  pluginAdd,
  pluginRemove,
  pluginsDir,
  pluginInstall: installPlugin,
  listInstancePlugins,
  pluginRemoveLocal: removeInstancePlugin,

  /* launch */
  launchInstance,
  stopInstance,
  runtimeOf: instanceRuntime,
  listRuntimes: allRuntimes,

  /* saves */
  listSessions,
  workspaceKeyFor,

  /* modpack */
  exportPack,
  importPack,

  ...coreExtras,
};

export default core;

/* ------------------------------------------------------------------ *
 * 附加导出（非契约）：供 main / 测试使用的细粒度工具
 * ------------------------------------------------------------------ */

export {
  attachEngineFromLocal,
  clearRuntime,
  clearShareConflicts,
  computeEngineSize,
  deleteInstanceDetailed,
  describeStopFailure,
  engineBinPathIfPresent,
  explainLaunchFailure,
  findOrphanSharedWorkspaces,
  listRuntimes,
  listShareConflicts,
  markLaunched,
  patchRuntime,
  putRuntime,
  readInstanceRegistry,
  readPackManifest,
  resetNodeRuntimeCache,
  resolveNodeRuntime,
  resolveSettingsConflict,
  runtimeOf,
  setRuntimeState,
};
export {
  PREFLIGHT_STATE_FILE,
  PREFLIGHT_STATE_SCHEMA,
  PREFLIGHT_STATUS_LABELS,
  formatDuration,
  readPreflightState,
  runPreflight,
} from './preflight';
export type { PreflightState } from './preflight';
export type { InstanceRemovalReport, InstanceSummaryExt, ShareConflict };
/* 内部工具的测试出口（纯函数，供 tests/core/plugin-packs.test.mjs 直接验证）。 */
export { __test as pluginPacksTest } from './plugin-packs';
export * as fsx from './fsx';
export * as paths from './paths';
export * as ports from './ports';
export * as names from './names';
export * as profile from './profile';
export * as engine from './engine';
export * as instance from './instance';
export * as plugins from './plugins';
export * as pluginPacks from './plugin-packs';
export * as preflight from './preflight';
export * as launch from './launch';
export * as nodeRuntime from './node-runtime';
export * as saves from './saves';
export * as modpack from './modpack';
export * as proc from './proc';
export * as runtime from './runtime';
