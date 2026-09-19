/**
 * WhalesLauncher core —— 实例 CRUD 与共享模式落地
 *
 * 一个实例 = `<root>/instances/<dirName>/`，自包含：
 * ```
 * instance.json        实例元数据（唯一事实源）
 * home/                ← 该实例专属 DSH_HOME
 * workspace/           默认工作文件夹（可为 junction）
 * logs/                启动日志
 * ```
 * 删除目录即彻底删除实例。
 *
 * ### 创建实例的「黄金路径」
 * `node <engineBin> --profile <p> --from-default-profile <tpl> --dump-config`
 * （本机实测 + Lead 复核：全新 home 下约 130ms 完成、退出码 0、输出 500+ 行组合配置、
 * 不启动应用、不调用模型、不联网，同时生成
 * `package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml` / `cordis.yml`）。
 *
 * 一个必须绕开的 dsh 约束（源码 `initializeProfileFromDefault` 实测）：
 * **随附模板名（web/headless/sdk/sdk-minimal/acp）不能作为 `--from-default-profile` 的目标**，
 * 否则报 `profile "web" is shipped and cannot be a custom profile target`。
 * 因此当实例目录名恰好等于随附模板名时，改为执行 `--profile <p> --dump-config`
 * （dsh 会自动用同名模板初始化），再按用户所选模板对齐 `dsh.profile.bundles`。
 *
 * 另有两点实测结论影响实现：
 *  - `--dump-config` **不会**创建 `<home>/profiles/node_modules`（该共享 fallback 由
 *    启动路径的 `composeProfile` → `healProfilesModuleFallback` 在首次启动时建立），
 *    所以创建阶段**不预建**，不替 dsh 管理模块解析。
 *  - `initProfile` 对已存在文件绝不覆盖（幂等），但 **dump 成功不等于实例可用**：
 *    本模块在调用前先用 `resolveEngineBin` 确认引擎已安装，未装直接给明确错误。
 *  - 空的 `cordis.patch.yml` 会导致启动失败，dsh 写入的模板本身就是合法的 `[]`，
 *    本模块不重写该文件。
 */
import { randomUUID } from 'node:crypto';
import { readlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BUNDLE_TEMPLATES,
  SCHEMA_VERSION,
  type CreateInstanceInput,
  type InstanceMeta,
  type InstancePaths,
  type InstanceSummary,
  type LauncherConfig,
  type LogSink,
  type UpdateInstancePatch,
} from '../shared/contracts';
import {
  copyFileAtomic,
  ensureDir,
  ensureRealDir,
  isLink,
  listDir,
  mergeDirInto,
  pathExists,
  readJson,
  readText,
  removeDir,
  removeLink,
  replaceWithJunction,
  writeJsonAtomic,
  writeTextAtomic,
} from './fsx';
import { isValidVersion, resolveEngineBin } from './engine';
import { makeDirName, validateName } from './names';
import {
  INSTANCE_META_FILE,
  childBaseEnv,
  corePaths,
  enginePackageDir,
  instancePaths,
  sharedSettingsFile,
  sharedWorkspaceDir,
} from './paths';
import { forgetPort } from './ports';
import { readBundles, readProfileManifest, writeProfileManifest, backupFile, backupFileIfNotEmpty } from './profile';
import { resolveNodeRuntime } from './node-runtime';
import { runCapture, type ProcLogSink } from './proc';
import { clearRuntime, runtimeOf } from './runtime';

/** 实例默认强调色。 */
export const DEFAULT_COLOR = '#5B8DEF';

/** 实例索引（元数据快照）文件名，位于 `<root>/instances/` 下。 */
export const INSTANCE_REGISTRY_FILE = 'registry.json';

/**
 * 索引镜像文件名（与主索引同形状）。
 *
 * 存在的意义：主索引被误删/损坏时不会一次性抹掉全部记录（QA J2）。
 * 读取时两者合并、同 id 以主索引为准；写入时先写镜像、后写主索引。
 */
export const INSTANCE_REGISTRY_MIRROR_FILE = '.registry-mirror.json';

/**
 * 列表/详情用的聚合视图（契约 `InstanceSummary` + 可选的异常标记）。
 *
 * `problem` 是**非契约扩展**：契约本身冻结了字段，这里用附加属性承载
 * "该实例存在问题"的信息，UI 可据此提示用户（例如"目录缺失，可删除该记录"）。
 */
export interface InstanceSummaryExt extends InstanceSummary {
  /** 该实例存在的问题（目录缺失 / 元数据损坏 / 清单损坏）；正常为 `undefined`。 */
  problem?: string;
}

/** profile 初始化（dump-config）超时。 */
const INIT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 枚举全部实例。
 *
 * 单个实例的 `instance.json` 损坏时跳过该实例而不是让整个列表失败。
 * @param root 启动器根目录。
 * @returns 实例聚合视图（按创建时间排序）。
 */
export async function listInstances(root: string): Promise<InstanceSummaryExt[]> {
  const collected = await collectInstances(root);
  const summaries: InstanceSummaryExt[] = [];
  for (const item of collected) {
    summaries.push(await summarize(root, item.meta, item.problem, item.actualDirName));
  }
  return summaries.sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt));
}

/**
 * 按 id 读取实例元数据。
 *
 * 目录里的 `instance.json` 是唯一事实源；当它缺失或损坏时，回退到
 * `<instances>/registry.json` 的快照，保证"坏记录"仍可被查看与删除。
 * @param root 启动器根目录。
 * @param id 实例 id。
 * @returns 元数据；不存在返回 `null`。
 */
export async function readInstance(root: string, id: string): Promise<InstanceMeta | null> {
  const collected = await collectInstances(root);
  const found = collected.find((item) => item.meta.id === id);
  return found === undefined ? null : found.meta;
}

/**
 * 创建实例（含 profile 初始化）。
 * @param root 启动器根目录。
 * @param input 创建入参。
 * @param hooks 日志回调。
 * @returns 新实例元数据。
 * @throws 名称非法 / 目录已占用 / 引擎未安装 / profile 初始化失败。
 */
export async function createInstance(
  root: string,
  input: CreateInstanceInput,
  hooks: { onLog?: LogSink } = {},
): Promise<InstanceMeta> {
  const onLog = hooks.onLog;
  const displayName = typeof input.name === 'string' ? input.name.trim() : '';
  if (displayName.length === 0) throw new Error('实例名不能为空');
  const existing = await listInstances(root);
  const taken = existing.map((item) => item.meta.dirName);
  const dirName =
    input.dirName !== undefined && input.dirName.trim().length > 0
      ? input.dirName.trim()
      : makeDirName(displayName, taken);
  assertValidName(dirName, '实例目录名');
  if (taken.some((item) => item.toLowerCase() === dirName.toLowerCase())) {
    throw new Error(`实例目录已被占用：${dirName}`);
  }
  const profileName = input.profileName !== undefined && input.profileName.trim().length > 0 ? input.profileName.trim() : dirName;
  assertValidName(profileName, 'profile 名');
  if (!Object.hasOwn(BUNDLE_TEMPLATES, input.template)) {
    throw new Error(`未知的 profile 模板 ${JSON.stringify(input.template)}，可选：${Object.keys(BUNDLE_TEMPLATES).join('、')}`);
  }
  if (!isValidVersion(input.engineVersion)) throw new Error(`引擎版本号不合法：${JSON.stringify(input.engineVersion)}`);
  const engineBin = resolveEngineBin(root, input.engineVersion);
  if (engineBin === null) {
    throw new Error(`引擎 ${input.engineVersion} 未安装（期望 ${enginePackageDir(root, input.engineVersion)}），请先在版本管理中安装`);
  }

  const meta: InstanceMeta = {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    name: displayName,
    dirName,
    icon: input.icon ?? null,
    color: input.color ?? DEFAULT_COLOR,
    note: input.note ?? '',
    engine: { version: input.engineVersion },
    profile: { name: profileName, template: input.template },
    workspace: { mode: input.workspace ?? 'local' },
    saves: { mode: input.saves ?? 'local' },
    settings: { mode: input.settings ?? 'local' },
    credentials: { mode: input.credentials ?? 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: true },
    createdAt: new Date().toISOString(),
    lastLaunchedAt: null,
    launchCount: 0,
  };
  const paths = instancePaths(root, meta);
  if (await pathExists(paths.root)) throw new Error(`实例目录已存在：${paths.root}`);
  await ensureDir(paths.home);
  await ensureDir(paths.logs);
  await ensureDir(paths.workspace);
  try {
    await initializeProfile(root, meta, engineBin, onLog);
  } catch (error) {
    // 初始化失败时清理半成品目录，避免留下"看起来存在但不可用"的实例
    await removeDir(paths.root).catch(() => undefined);
    throw error;
  }
  await writeJsonAtomic(paths.metaFile, meta);
  await registerInstance(root, meta);
  await applyLocalStructure(root, meta);
  await applyShareModesInternal(root, meta, null, onLog);
  onLog?.('system', `实例已创建：${meta.name}（目录 ${meta.dirName}，模板 ${meta.profile.template}）\n`);
  return meta;
}

/**
 * 更新实例可变字段（显示名 / 图标 / 颜色 / 备注 / 引擎版本 / 启动参数 / 共享模式）。
 *
 * 说明：显示名变更**不会移动目录**（`dirName` 与 profile 名保持稳定，避免破坏
 * dsh 的会话路径与 profile 解析）；共享模式字段只落库，实际链接/同步由
 * {@link applyShareModes} 在启动前应用。
 * @param root 启动器根目录。
 * @param id 实例 id。
 * @param patch 待更新字段。
 * @returns 更新后的元数据。
 */
export async function updateInstance(root: string, id: string, patch: UpdateInstancePatch): Promise<InstanceMeta> {
  const meta = await readInstance(root, id);
  if (meta === null) throw new Error(`实例不存在：${id}`);
  const next: InstanceMeta = {
    ...meta,
    name: patch.name !== undefined && patch.name.trim().length > 0 ? patch.name.trim() : meta.name,
    icon: patch.icon !== undefined ? patch.icon : meta.icon,
    color: patch.color !== undefined && patch.color.trim().length > 0 ? patch.color.trim() : meta.color,
    note: patch.note !== undefined ? patch.note : meta.note,
    engine: patch.engineVersion !== undefined ? { version: patch.engineVersion } : meta.engine,
    launch: {
      appArgs: patch.appArgs ?? meta.launch.appArgs,
      autoOpenBrowser: patch.autoOpenBrowser ?? meta.launch.autoOpenBrowser,
    },
    saves: patch.saves !== undefined ? { mode: patch.saves } : meta.saves,
    settings: patch.settings !== undefined ? { mode: patch.settings } : meta.settings,
    credentials: patch.credentials !== undefined ? { mode: patch.credentials } : meta.credentials,
    workspace: patch.workspace !== undefined ? { mode: patch.workspace } : meta.workspace,
  };
  if (patch.engineVersion !== undefined && !isValidVersion(patch.engineVersion)) {
    throw new Error(`引擎版本号不合法：${JSON.stringify(patch.engineVersion)}`);
  }
  // QR-12：拒绝切到未安装的引擎 —— 否则实例会进入"列表可见但必然启动失败"的状态。
  // 与 createInstance 的口径保持一致（后者同样要求引擎已安装），因此不会出现
  // "先建实例后装引擎"被拦住的例外：那种流程本来就是先装引擎。
  if (patch.engineVersion !== undefined && patch.engineVersion !== meta.engine.version) {
    if (resolveEngineBin(root, patch.engineVersion) === null) {
      throw new Error(
        `引擎 ${patch.engineVersion} 未安装，无法切换（期望 ${enginePackageDir(root, patch.engineVersion)}）；请先在版本管理中安装`,
      );
    }
  }
  // 目录还在 → 顺带修复 instance.json；目录已缺失 → 仅更新索引快照（不重建目录）
  if (validateName(next.dirName) === null) {
    const instanceRoot = path.join(corePaths(root).instancesDir, next.dirName);
    if (await pathExists(instanceRoot)) {
      await writeJsonAtomic(path.join(instanceRoot, INSTANCE_META_FILE), next);
    }
  }
  await registerInstance(root, next);
  return next;
}

/**
 * 删除实例（契约方法，返回空）。
 *
 * 语义与 {@link deleteInstanceDetailed} 相同，只是不返回报告：
 * - `deleteFiles = true`：递归删除实例目录（`fs.rm` 不跟随 junction，已实测：
 *   共享目录里的真实数据不会被误删）；**同时在归属可确认时**清理该实例专用的共享工作区。
 * - `deleteFiles = false`：只摘除 `instance.json` 并移除索引记录（**注销**语义，
 *   与契约 `remove(id,false)` 一致）→ 数据完整保留在 `instances/<dirName>/` 下，
 *   但该实例不再出现在列表里。
 * @param root 启动器根目录。
 * @param id 实例 id。
 * @param deleteFiles 是否同时删除文件。
 */
export async function deleteInstance(root: string, id: string, deleteFiles: boolean): Promise<void> {
  await deleteInstanceDetailed(root, id, deleteFiles);
}

/** 删除实例的结果报告（非契约扩展，供 UI 提示"共享数据残留"）。 */
export interface InstanceRemovalReport {
  /** 被删除的实例 id。 */
  instanceId: string;
  /** 实例目录。 */
  instanceDir: string;
  /** 是否删除了文件（`deleteFiles` 原样回传）。 */
  removedFiles: boolean;
  /** 共享工作区是否已确认属于本实例（junction 指向一致）。 */
  sharedWorkspaceOwned: boolean;
  /**
   * 保留在磁盘上的共享数据路径（UI 应提示用户"共享数据仍在，可手动清理"）。
   *
   * 共享模式下 `<root>/shared/workspaces/<dirName>` **就是用户的真实工作目录**，
   * 因此删除实例时删除它属于破坏性副作用 —— 即使能确认归属，也必须由用户显式决定。
   * 需要清理时请调用 {@link removeOrphanSharedWorkspace}（仅允许清理无人认领的工作区）。
   */
  sharedResidue: string[];
}

/**
 * 删除实例并返回详细报告（非契约扩展）。
 *
 * QR-13：删除实例不会自动清理 `<root>/shared/workspaces/<dirName>`，同名重建会继承旧数据。
 * 处理策略是"**只报告、不自动删**"：
 *  - 共享模式下该目录就是用户的真实工作目录，删除实例时删掉它属于破坏性副作用，
 *    即便 junction 归属可确认（`sharedWorkspaceOwned`）也交由用户显式决定；
 *  - 报告里给出 `sharedResidue`，UI 可提示"共享数据仍在"；
 *  - 清理走显式 API {@link removeOrphanSharedWorkspace}（拒绝清理仍有实例认领的工作区），
 *    或用 {@link findOrphanSharedWorkspaces} 列出所有无人认领的工作区。
 * 注意：`<root>/shared/sessions` 是**多实例共享的会话库**，任何实例删除都不得触碰。
 * @param root 启动器根目录。
 * @param id 实例 id。
 * @param deleteFiles 是否同时删除文件。
 * @returns 删除报告。
 */
export async function deleteInstanceDetailed(
  root: string,
  id: string,
  deleteFiles: boolean,
): Promise<InstanceRemovalReport> {
  const meta = await readInstance(root, id);
  if (meta === null) throw new Error(`实例不存在：${id}`);
  const state = runtimeOf(id).state;
  if (state !== 'stopped') {
    // 运行中的实例其工作目录被进程占用，Windows 上递归删除会 EBUSY；且删除运行中的实例本身也不安全
    throw new Error(`实例正在运行（状态 ${state}），请先停止再删除：${meta.name}`);
  }
  const instanceRoot = path.join(corePaths(root).instancesDir, meta.dirName);
  const sharedWorkspace = sharedWorkspaceDir(root, meta.dirName);
  // 归属校验必须在删除实例目录之前做（要靠 <实例>/workspace 这个 junction 取证）
  const sharedWorkspaceOwned = await isOwnedSharedWorkspace(instanceRoot, sharedWorkspace);
  const sharedResidue: string[] = [];

  if (deleteFiles) {
    if (await isRealDirectory(instanceRoot)) await removeDir(instanceRoot);
  } else {
    await rm(path.join(instanceRoot, INSTANCE_META_FILE), { force: true });
  }
  if (await pathExists(sharedWorkspace)) sharedResidue.push(sharedWorkspace);
  await unregisterInstance(root, id);
  // 端口台账里的记录随实例一起消失：留着只会越积越多，还会让新实例白避开一个没人认领的端口
  await forgetPort(root, id);
  clearRuntime(id);
  return { instanceId: id, instanceDir: instanceRoot, removedFiles: deleteFiles, sharedWorkspaceOwned, sharedResidue };
}

/**
 * 显式清理一个"无人认领"的共享工作区（供 UI 的"清理残留"入口调用）。
 *
 * 安全约束（任一不满足即拒绝，绝不误删）：
 *  - 目标必须位于 `<root>/shared/workspaces/` 之内；
 *  - 目录名必须**没有**同名实例认领（`dirName` 存在实例即拒绝）。
 * @param root 启动器根目录。
 * @param dirName 共享工作区目录名（= 实例目录名）。
 * @returns 是否真的删除了。
 */
export async function removeOrphanSharedWorkspace(root: string, dirName: string): Promise<boolean> {
  const { sharedWorkspacesDir } = corePaths(root);
  const target = path.join(sharedWorkspacesDir, dirName);
  const relative = path.relative(sharedWorkspacesDir, target);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理 shared/workspaces 之外的路径：${target}`);
  }
  const claimed = (await listInstances(root)).some((item) => item.meta.dirName.toLowerCase() === dirName.toLowerCase());
  if (claimed) throw new Error(`共享工作区 ${dirName} 仍被实例认领，拒绝清理（请先删除该实例并确认）`);
  if (!(await isRealDirectory(target))) return false;
  await removeDir(target);
  return true;
}

/**
 * 找出"无人认领的共享工作区"（不存在同名实例的共享目录）。
 *
 * 供 UI 提供"清理残留"入口；判定基于**目录名**，不依赖索引，因此索引丢失也能用。
 * @param root 启动器根目录。
 * @returns 残留共享工作区路径数组。
 */
export async function findOrphanSharedWorkspaces(root: string): Promise<string[]> {
  const { sharedWorkspacesDir } = corePaths(root);
  const entries = await listDir(sharedWorkspacesDir);
  if (entries.length === 0) return [];
  const known = new Set((await listInstances(root)).map((item) => item.meta.dirName.toLowerCase()));
  const orphans: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (known.has(entry.name.toLowerCase())) continue;
    orphans.push(path.join(sharedWorkspacesDir, entry.name));
  }
  return orphans;
}

/** 读取链接目标（去掉 Windows 的 `\\?\` 前缀）；不是链接或读取失败返回 `null`。 */
async function linkTarget(link: string): Promise<string | null> {
  if (!(await isLink(link))) return null;
  try {
    const raw = await readlink(link);
    return path.resolve(raw.replace(/^\\\\\?\\/, ''));
  } catch {
    return null;
  }
}

/** 判断实例的 workspace 是否确实是"指向该共享目录"的 junction（Windows 路径大小写不敏感）。 */
async function isOwnedSharedWorkspace(instanceRoot: string, sharedWorkspace: string): Promise<boolean> {
  const target = await linkTarget(path.join(instanceRoot, 'workspace'));
  if (target === null) return false;
  return target.toLowerCase() === path.resolve(sharedWorkspace).toLowerCase();
}

/**
 * 把实例的 workspace / saves / settings / credentials 落到实际形态（幂等）。
 *
 * 语义（架构文档 §4.3）：
 *  - `workspace`：`local` → 真实目录；`shared` → junction 到 `<root>/shared/workspaces/<dirName>`
 *  - `saves`：`local` → 真实 `home/sessions`；`shared` → junction 到 `<root>/shared/sessions`
 *  - `settings`：`local` → 实例自己的 `home/settings.yaml`；`shared` → 与
 *    `<root>/shared/settings.yaml` **内容同步**
 *    （Windows 上文件级符号链接需要管理员权限，本机实测 `symlink(...,'file')` 报 EPERM、
 *    指向文件的 junction 不可访问，因此单文件共享用同步而非链接实现）
 *  - `credentials`：`inherit` → 从 `config.primaryHome/.credentials.yaml` 复制；
 *    `local` → 保留实例自己的凭证文件
 *
 * 切到 `shared` 时，本地已有内容会**先并入共享库**（同名条目保留在本地并报错，绝不删数据）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param config 启动器全局设置（提供 `primaryHome`）。
 */
export async function applyShareModes(root: string, meta: InstanceMeta, config: LauncherConfig): Promise<void> {
  const primaryHome = typeof config.primaryHome === 'string' && config.primaryHome.trim().length > 0 ? config.primaryHome : null;
  await applyShareModesInternal(root, meta, primaryHome);
}

/* ------------------------------------------------------------------ *
 * 共享模式冲突（非契约扩展）
 *
 * 「共享设置」无法用链接实现（本机文件级符号链接 EPERM、指向文件的 junction 不可访问），
 * 只能内容同步。同步必然可能出现"本地与共享不同"的情形，此时**默认保留本地并把选择权
 * 交给调用方**：绝不静默覆盖、绝不删除任何一边。
 * ------------------------------------------------------------------ */

/** 共享资源冲突记录。 */
export interface ShareConflict {
  /** 实例 id。 */
  instanceId: string;
  /** 冲突资源类型（当前只有设置文件会冲突）。 */
  resource: 'settings';
  /** 冲突时保留了哪一边的数据（当前恒为 local）。 */
  kept: 'local';
  /** 实例侧文件。 */
  localFile: string;
  /** 共享侧文件。 */
  sharedFile: string;
  /** 供 UI 直接展示的说明。 */
  message: string;
}

/** instanceId → 冲突列表（进程内）。 */
const shareConflicts = new Map<string, ShareConflict[]>();

/** 登记冲突（同实例同资源去重：每次启动都会重新计算）。 */
function recordShareConflict(conflict: ShareConflict): void {
  const existing = (shareConflicts.get(conflict.instanceId) ?? []).filter((item) => item.resource !== conflict.resource);
  existing.push(conflict);
  shareConflicts.set(conflict.instanceId, existing);
}

/**
 * 列出共享模式冲突（`applyShareModes` 每次执行都会重新计算）。
 * @param instanceId 实例 id；省略时返回全部。
 * @returns 冲突列表。
 */
export function listShareConflicts(instanceId?: string): ShareConflict[] {
  if (instanceId !== undefined) return [...(shareConflicts.get(instanceId) ?? [])];
  return [...shareConflicts.values()].flat();
}

/**
 * 清除共享模式冲突记录。
 * @param instanceId 实例 id；省略时清空全部。
 * @param resource 仅清除该资源的冲突。
 */
export function clearShareConflicts(instanceId?: string, resource?: ShareConflict['resource']): void {
  if (instanceId === undefined) {
    shareConflicts.clear();
    return;
  }
  if (resource === undefined) {
    shareConflicts.delete(instanceId);
    return;
  }
  const remaining = (shareConflicts.get(instanceId) ?? []).filter((item) => item.resource !== resource);
  if (remaining.length === 0) shareConflicts.delete(instanceId);
  else shareConflicts.set(instanceId, remaining);
}

/**
 * 由调用方（UI）决定如何解决设置冲突。
 *
 * - `use-local`：把实例设置**推送**到共享（覆盖前备份共享文件）
 * - `use-shared`：用共享设置**覆盖**实例设置（覆盖前备份实例文件）
 *
 * 两种选择都会在覆盖前留下 `.bak-<毫秒>` 备份，因此都可回退。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param resolution 解决方式。
 */
export async function resolveSettingsConflict(
  root: string,
  meta: InstanceMeta,
  resolution: 'use-local' | 'use-shared',
): Promise<void> {
  const paths = instancePaths(root, meta);
  const shared = sharedSettingsFile(root);
  await ensureDir(path.dirname(shared));
  if (resolution === 'use-local') {
    const local = (await readText(paths.settingsFile)) ?? '';
    await backupFileIfNotEmpty(shared);
    await writeTextAtomic(shared, local);
    await writeTextAtomic(paths.settingsFile, local);
  } else {
    const sharedText = (await readText(shared)) ?? '';
    await backupFileIfNotEmpty(paths.settingsFile);
    await writeTextAtomic(paths.settingsFile, sharedText);
  }
  clearShareConflicts(meta.id, 'settings');
}

/* ------------------------------------------------------------------ *
 * 实例发现与降级呈现
 *
 * 原则：**坏记录只能降级呈现，绝不静默丢弃**。用户必须能在界面上看到
 * "目录缺失 / 元数据损坏"的实例，并把它删掉；否则一个损坏的 `instance.json`
 * 会让实例凭空消失、既看不见也删不掉。
 *
 * 为此维护一个轻量索引（元数据快照），并且**不是单点文件**：
 *  - 主索引 `<instances>/registry.json`（`{schemaVersion, entries}`，UI/测试按此形状读取）
 *  - 镜像 `<instances>/.registry-mirror.json`（同形状，冗余保命）
 * 读取时合并两者（同 id 以主索引为准，镜像独有的条目也保留）；写入时先写镜像再写主索引，
 * 因此"主索引被误删/损坏"不会一次性抹掉全部记录（QA J2）。
 *
 * 记录是否可见由"元数据 + 索引"共同决定：
 *  · 元数据损坏            → 可见 + `problem`（用户可修复或彻底删除）
 *  · 元数据被外部删除      → 可见 + `problem`（索引快照兜底，不会失联）
 *  · 目录被外部删除        → 可见 + `present:false` + `problem`
 *  · 同 id 出现多份（改名/复制）→ **只出一条**，目录存在者胜出，并标记不一致
 *  · `deleteInstance(id,false)` 主动注销 → 数据保留在磁盘上，记录不再出现在列表
 *    （契约 `remove(id,false)` 语义）；`deleteFiles:true` 则连目录与索引一起清掉。
 * ------------------------------------------------------------------ */

/** 实例索引里的快照条目。 */
export interface InstanceRegistryEntry {
  /** 实例 id（稳定标识）。 */
  id: string;
  /** 目录名。 */
  dirName: string;
  /** 元数据快照（用于目录缺失/损坏时降级呈现）。 */
  meta: InstanceMeta;
}

/** 主索引文件结构（镜像同形状）。 */
interface InstanceRegistryFile {
  schemaVersion: number;
  entries: InstanceRegistryEntry[];
}

/** 收集结果：实例元数据 + 发现的问题（正常为 undefined）。 */
interface CollectedInstance {
  meta: InstanceMeta;
  problem?: string;
  /** 该记录实际来自哪个目录（用于 `present` 判定；幽灵记录为 undefined）。 */
  actualDirName?: string;
}

/** 主索引文件路径。 */
function registryFile(root: string): string {
  return path.join(corePaths(root).instancesDir, INSTANCE_REGISTRY_FILE);
}

/** 镜像索引文件路径（与主索引同形状，用于抗单文件丢失）。 */
function registryMirrorFile(root: string): string {
  return path.join(corePaths(root).instancesDir, INSTANCE_REGISTRY_MIRROR_FILE);
}

/** 解析一个索引文件为合法条目数组（缺失/损坏/形状不对都返回空数组，绝不抛错）。 */
async function readRegistryFile(file: string): Promise<InstanceRegistryEntry[]> {
  let raw: InstanceRegistryFile | null = null;
  try {
    raw = await readJson<InstanceRegistryFile>(file);
  } catch {
    return [];
  }
  if (raw === null || !Array.isArray(raw.entries)) return [];
  return raw.entries.filter(
    (entry): entry is InstanceRegistryEntry =>
      typeof entry?.id === 'string' && typeof entry?.dirName === 'string' && normalizeMeta(entry.meta) !== null,
  );
}

/**
 * 读取实例索引快照（主索引 + 镜像合并，缺失/损坏时返回空数组）。
 * @param root 启动器根目录。
 * @returns 索引条目数组（同 id 以主索引为准）。
 */
export async function readInstanceRegistry(root: string): Promise<InstanceRegistryEntry[]> {
  const primary = await readRegistryFile(registryFile(root));
  const mirror = await readRegistryFile(registryMirrorFile(root));
  const merged = new Map<string, InstanceRegistryEntry>();
  for (const entry of mirror) merged.set(entry.id, entry);
  for (const entry of primary) merged.set(entry.id, entry);
  return [...merged.values()];
}

/**
 * 写入索引（先镜像、后主索引）。
 *
 * **写入时机**：每次登记/注销实例都会**整体重写**两份索引（不是增量追加），因此
 * 任何一次成功写入都会顺带修复此前损坏或缺失的那一份（自愈）。
 *
 * **失败处理**（镜像绝不能变成第二个故障点）：
 *  - 镜像写失败 → **吞掉**（`catch`），继续写主索引；主索引是权威副本，操作照常成功，
 *    下一次成功写入会补齐镜像；
 *  - 主索引写失败 → 抛错给调用方（删除/创建会如实报错），此时镜像可能已是新状态、
 *    主索引仍是旧状态；读取时**主索引优先**，于是表现与"操作失败"一致（不会静默不一致）；
 *  - 任一份缺失/损坏 → 读取时按"空"处理并合并另一份（{@link readInstanceRegistry}），
 *    因此单份损坏只会丢"只有那一份才有的记录"，不会整体失效。
 */
async function writeInstanceRegistry(root: string, entries: InstanceRegistryEntry[]): Promise<void> {
  const payload: InstanceRegistryFile = { schemaVersion: SCHEMA_VERSION, entries };
  await ensureDir(corePaths(root).instancesDir);
  // 镜像写失败不影响主流程：主索引才是权威副本
  await writeJsonAtomic(registryMirrorFile(root), payload).catch(() => undefined);
  await writeJsonAtomic(registryFile(root), payload);
}

/**
 * 登记/更新一个实例的索引快照。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 */
export async function registerInstance(root: string, meta: InstanceMeta): Promise<void> {
  const entries = await readInstanceRegistry(root);
  const next = entries.filter((entry) => entry.id !== meta.id);
  next.push({ id: meta.id, dirName: meta.dirName, meta });
  await writeInstanceRegistry(root, next);
}

/**
 * 从索引中移除实例记录（主索引与镜像同时移除）。
 * @param root 启动器根目录。
 * @param id 实例 id。
 */
export async function unregisterInstance(root: string, id: string): Promise<void> {
  const entries = await readInstanceRegistry(root);
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length !== entries.length) await writeInstanceRegistry(root, next);
}

/**
 * 扫描并汇总实例：目录优先，索引兜底，**按 id 去重**。
 *
 * 去重规则（对应"目录被改名/复制"这类真实误操作）：
 *  - 同一 id 只出一条；
 *  - "目录真实存在"的候选优先于"只剩索引快照"的幽灵候选；
 *  - 实际目录名与 `meta.dirName` 不一致时，标记 `problem` 提示可能被改名/复制，
 *    并**不修改任何元数据**（`dirName` 同时是 dsh profile 名与共享目录键，
 *    静默改名会牵动会话路径与共享链接，必须由用户显式决定）。
 * @param root 启动器根目录。
 * @returns 收集结果（含问题标记）。
 */
async function collectInstances(root: string): Promise<CollectedInstance[]> {
  const { instancesDir } = corePaths(root);
  const registry = await readInstanceRegistry(root);
  const byDirName = new Map<string, InstanceRegistryEntry>();
  for (const entry of registry) if (!byDirName.has(entry.dirName)) byDirName.set(entry.dirName, entry);

  /** id → 已选中的候选（去重结果）。 */
  const chosen = new Map<string, CollectedInstance>();
  /** id → 被去重丢弃的额外目录（用于提示"存在副本"）。 */
  const duplicates = new Map<string, string[]>();
  const coveredDirs = new Set<string>();

  /** 候选入表：目录存在者胜出，同级先到先得。 */
  const offer = (candidate: CollectedInstance, fromExistingDir: boolean): void => {
    const existing = chosen.get(candidate.meta.id);
    if (existing === undefined) {
      chosen.set(candidate.meta.id, candidate);
      return;
    }
    const existingFromDir = existing.actualDirName !== undefined;
    if (fromExistingDir && !existingFromDir) {
      // 目录里读到的记录优先于纯索引快照
      if (existing.actualDirName === undefined) duplicates.set(candidate.meta.id, []);
      chosen.set(candidate.meta.id, candidate);
      return;
    }
    if (fromExistingDir && existingFromDir) {
      const others = duplicates.get(candidate.meta.id) ?? [];
      others.push(candidate.actualDirName ?? candidate.meta.dirName);
      duplicates.set(candidate.meta.id, others);
    }
  };

  for (const entry of await listDir(instancesDir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // 索引文件与隐藏目录（如未来新增的内部目录）不参与实例扫描
    if (entry.name.startsWith('.')) continue;
    coveredDirs.add(entry.name);
    const instanceRoot = path.join(instancesDir, entry.name);
    const metaFile = path.join(instanceRoot, INSTANCE_META_FILE);
    let raw: unknown = null;
    let broken = false;
    try {
      raw = await readJson<unknown>(metaFile);
    } catch {
      broken = true;
    }
    const fromDisk = normalizeMeta(raw);
    if (fromDisk !== null) {
      const renamed = fromDisk.dirName !== entry.name;
      const candidate: CollectedInstance = { meta: fromDisk, actualDirName: entry.name };
      if (renamed) {
        candidate.problem = `目录名与记录不一致（实际目录 ${entry.name}，记录 ${fromDisk.dirName}）；可能被改名或复制，请显式确认后再操作`;
      }
      offer(candidate, true);
      continue;
    }
    // 元数据无法使用，按"是否被主动注销"区分（两种都绝不静默丢数据）：
    //  - `instance.json` **存在但损坏** → 记录仍在，降级呈现 + 问题标记（用户可修复/删除）
    //  - `instance.json` **缺失且索引里也没有** → 属于 `deleteInstance(id,false)` 主动注销，
    //    数据仍保留在磁盘上，但记录不再出现在列表（契约 `remove(id,false)` 的语义）
    //  - `instance.json` **缺失但索引里有快照** → 元数据被外部误删，仍可见 + 问题标记
    const fallback = byDirName.get(entry.name);
    if (!(await pathExists(metaFile)) && fallback === undefined) continue;
    const dirNameProblem = validateName(entry.name) === null ? null : `目录名不合法（${entry.name}）`;
    const problemParts = [broken ? 'instance.json 损坏（无法解析）' : 'instance.json 缺失（元数据被外部删除，数据仍在磁盘上）'];
    if (dirNameProblem !== null) problemParts.push(dirNameProblem);
    const meta = fallback?.meta ?? syntheticMeta(entry.name);
    const renamed = meta.dirName !== entry.name;
    if (renamed) problemParts.push(`目录名与记录不一致（实际目录 ${entry.name}，记录 ${meta.dirName}）`);
    offer({ meta, problem: problemParts.join('；'), actualDirName: entry.name }, true);
  }

  // 索引里有、目录却不存在的条目 → 幽灵记录（present=false，可删除）
  for (const entry of registry) {
    if (coveredDirs.has(entry.dirName)) continue;
    coveredDirs.add(entry.dirName);
    offer({ meta: entry.meta, problem: '实例目录缺失（可能在文件管理器里被删除）' }, false);
  }

  // 把"存在副本"的信息并进胜出记录的问题说明里（仍是同一条记录）
  for (const [id, others] of duplicates) {
    const winner = chosen.get(id);
    if (winner === undefined || others.length === 0) continue;
    const note = `检测到重复目录（同名实例的副本）：${others.map((name) => `instances/${name}`).join('、')}`;
    winner.problem = winner.problem === undefined ? note : `${winner.problem}；${note}`;
  }
  return [...chosen.values()];
}

/** 用目录名构造一个最小可用的元数据（索引与元数据都不可用时）。 */
function syntheticMeta(dirName: string): InstanceMeta {
  const safeName = validateName(dirName) === null ? dirName : 'orphan';
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `orphan:${dirName}`,
    name: dirName,
    dirName,
    icon: null,
    color: DEFAULT_COLOR,
    note: '（缺少 instance.json，信息由目录名推断）',
    engine: { version: '' },
    profile: { name: safeName, template: 'web' },
    workspace: { mode: 'local' },
    saves: { mode: 'local' },
    settings: { mode: 'local' },
    credentials: { mode: 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: true },
    createdAt: new Date(0).toISOString(),
    lastLaunchedAt: null,
    launchCount: 0,
  };
}

/**
 * 记录一次启动（`lastLaunchedAt` / `launchCount`）。 * @param root 启动器根目录。
 * @param id 实例 id。
 * @returns 更新后的元数据；实例不存在返回 `null`。
 */
export async function markLaunched(root: string, id: string): Promise<InstanceMeta | null> {
  const meta = await readInstance(root, id);
  if (meta === null) return null;
  const next: InstanceMeta = {
    ...meta,
    lastLaunchedAt: new Date().toISOString(),
    launchCount: meta.launchCount + 1,
  };
  await writeJsonAtomic(instancePaths(root, next).metaFile, next);
  return next;
}

/**
 * 组装实例聚合视图（列表 / 详情共用）。
 *
 * 任何单点损坏都**不得让整条记录消失**：目录名不合法、profile 清单损坏、
 * 实例目录被删除等情况一律降级呈现（`present` 如实反映、`problem` 给出可读标记）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param problem 已知问题标记（来自 {@link collectInstances}）。
 * @param actualDirName 该记录实际来自的目录名（目录被改名时用它判定 `present`）。
 * @returns 聚合视图。
 */
export async function summarize(
  root: string,
  meta: InstanceMeta,
  problem?: string,
  actualDirName?: string,
): Promise<InstanceSummaryExt> {
  const instancesDir = corePaths(root).instancesDir;
  const instanceRoot = path.join(instancesDir, actualDirName ?? meta.dirName);
  let paths: InstancePaths | null = null;
  try {
    paths = instancePaths(root, meta);
  } catch (error) {
    problem ??= error instanceof Error ? error.message : String(error);
  }
  let pluginCount = 0;
  let engineInstalled = false;
  if (paths !== null) {
    try {
      const manifest = await readProfileManifest(paths.profileDir);
      pluginCount = Object.keys(manifest?.dependencies ?? {}).length;
    } catch {
      problem ??= 'profile 清单损坏（home/profiles/<p>/package.json 无法解析）';
    }
    engineInstalled = meta.engine.version.length > 0 && resolveEngineBin(root, meta.engine.version) !== null;
  }
  const summary: InstanceSummaryExt = {
    meta,
    runtime: runtimeOf(meta.id),
    // 目录被改名时，"记录里的 dirName" 与"实际目录"不一致：以实际存在的目录为准
    present: await isRealDirectory(instanceRoot),
    engineInstalled,
    pluginCount,
  };
  if (problem !== undefined) summary.problem = problem;
  return summary;
}

/** 目录是否真实存在（跟随链接；断链的 junction 视为不存在）。 */
async function isRealDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 归一化磁盘上的元数据：补齐缺省字段，形状不合法返回 `null`。
 * @param raw 解析出来的原始 JSON。
 * @returns 归一化后的元数据。
 */
export function normalizeMeta(raw: unknown): InstanceMeta | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Partial<InstanceMeta> & Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.dirName !== 'string') return null;
  if (validateName(value.dirName) !== null) return null;
  const profile = (value.profile ?? {}) as { name?: unknown; template?: unknown };
  const engine = (value.engine ?? {}) as { version?: unknown };
  if (typeof profile.name !== 'string' || validateName(profile.name) !== null) return null;
  if (typeof engine.version !== 'string') return null;
  const launch = (value.launch ?? {}) as { appArgs?: unknown; autoOpenBrowser?: unknown };
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : SCHEMA_VERSION,
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : value.dirName,
    dirName: value.dirName,
    icon: typeof value.icon === 'string' ? value.icon : null,
    color: typeof value.color === 'string' && value.color.trim().length > 0 ? value.color : DEFAULT_COLOR,
    note: typeof value.note === 'string' ? value.note : '',
    engine: { version: engine.version },
    profile: {
      name: profile.name,
      template: typeof profile.template === 'string' ? profile.template : 'web',
    },
    workspace: { mode: value.workspace?.mode === 'shared' ? 'shared' : 'local' },
    saves: { mode: value.saves?.mode === 'shared' ? 'shared' : 'local' },
    settings: { mode: value.settings?.mode === 'shared' ? 'shared' : 'local' },
    credentials: { mode: value.credentials?.mode === 'local' ? 'local' : 'inherit' },
    launch: {
      appArgs: Array.isArray(launch.appArgs) ? launch.appArgs.filter((item): item is string => typeof item === 'string') : [],
      autoOpenBrowser: typeof launch.autoOpenBrowser === 'boolean' ? launch.autoOpenBrowser : true,
    },
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    lastLaunchedAt: typeof value.lastLaunchedAt === 'string' ? value.lastLaunchedAt : null,
    launchCount: typeof value.launchCount === 'number' && Number.isFinite(value.launchCount) ? value.launchCount : 0,
  };
}

/** 走 dsh CLI 初始化 profile 并校验结果。 */
async function initializeProfile(
  root: string,
  meta: InstanceMeta,
  engineBin: string,
  onLog: ProcLogSink | undefined,
): Promise<void> {
  const paths = instancePaths(root, meta);
  const templateBundles = BUNDLE_TEMPLATES[meta.profile.template];
  if (templateBundles === undefined) throw new Error(`未知模板：${meta.profile.template}`);
  const shippedName = Object.hasOwn(BUNDLE_TEMPLATES, meta.profile.name);
  const args = ['--profile', meta.profile.name];
  if (!shippedName) args.push('--from-default-profile', meta.profile.template);
  args.push('--dump-config');
  // dsh 必须由真正的 Node.js 执行（Electron 内置运行时会被原生模块拒绝，见 node-runtime.ts）。
  // 这里没有 config 参数，`resolveNodeRuntime` 会兜底读取 launcher.json 的 nodePath。
  const node = await resolveNodeRuntime({
    root,
    captureDir: corePaths(root).cacheDir,
  });
  if (!node.ok) throw new Error(`profile 初始化失败：${node.message}`);
  onLog?.('system', `初始化 profile：${String(node.file)} ${engineBin} ${args.join(' ')}\n`);
  const result = await runCapture(String(node.file), [engineBin, ...args], {
    cwd: paths.workspace,
    env: { DSH_HOME: paths.home, ...childBaseEnv(root) },
    onLog,
    timeoutMs: INIT_TIMEOUT_MS,
    captureDir: corePaths(root).cacheDir,
  });
  if (result.code !== 0) {
    throw new Error(
      `profile 初始化失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}\n` +
        `提示：引擎 ${meta.engine.version} 位于 ${enginePackageDir(root, meta.engine.version)}`,
    );
  }
  const manifest = await readProfileManifest(paths.profileDir);
  if (manifest === null) {
    throw new Error(`profile 初始化未生成清单：${path.join(paths.profileDir, 'package.json')}`);
  }
  const actual = readBundles(manifest);
  if (!sameBundles(actual, templateBundles)) {
    if (shippedName) {
      // 随附模板名无法作为 --from-default-profile 目标，dsh 会按"同名模板"初始化，
      // 这里按用户所选模板对齐组合包列表。
      onLog?.('system', `按模板 ${meta.profile.template} 对齐组合包：${actual.join(', ')} → ${templateBundles.join(', ')}\n`);
      await writeProfileManifest(paths.profileDir, {
        ...manifest,
        dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...templateBundles] } },
      });
    } else {
      throw new Error(`profile 初始化结果与模板不一致：期望 ${templateBundles.join(', ')}，实际 ${actual.join(', ')}`);
    }
  }
  if (!(await pathExists(path.join(paths.profileDir, 'cordis.patch.yml')))) {
    throw new Error(`profile 缺少 cordis.patch.yml（dsh 要求其内容至少为 "[]"）：${paths.profileDir}`);
  }
}

/** 落地"本地"结构（不触碰共享链接语义）。 */
async function applyLocalStructure(root: string, meta: InstanceMeta): Promise<void> {
  const paths = instancePaths(root, meta);
  await ensureDir(paths.home);
  await ensureDir(paths.logs);
  if (meta.workspace.mode === 'local') await ensureRealDir(paths.workspace);
  else await ensureDir(paths.workspace);
  if (meta.saves.mode === 'local') await ensureRealDir(paths.sessions);
  else await ensureDir(paths.sessions);
  if (meta.settings.mode === 'local' && (await isLink(paths.settingsFile))) await removeLink(paths.settingsFile);
}

/** 共享模式落地的内部实现（`primaryHome` 为 null 时跳过凭证继承）。 */
async function applyShareModesInternal(
  root: string,
  meta: InstanceMeta,
  primaryHome: string | null,
  onLog?: ProcLogSink,
): Promise<void> {
  const paths = instancePaths(root, meta);
  const { sharedSessionsDir } = corePaths(root);
  await ensureDir(paths.root);
  await ensureDir(paths.home);
  await ensureDir(paths.logs);

  // workspace
  if (meta.workspace.mode === 'shared') {
    const target = sharedWorkspaceDir(root, meta.dirName);
    await ensureDir(target);
    await linkDirectory(paths.workspace, target);
  } else {
    if (await isLink(paths.workspace)) await removeLink(paths.workspace);
    await ensureDir(paths.workspace);
  }

  // saves（sessions）
  if (meta.saves.mode === 'shared') {
    await ensureDir(sharedSessionsDir);
    await linkDirectory(paths.sessions, sharedSessionsDir);
  } else {
    if (await isLink(paths.sessions)) await removeLink(paths.sessions);
    await ensureDir(paths.sessions);
  }

  // settings（单文件：本机无法用链接，改为内容同步）
  //
  // 数据安全原则与 workspace/saves 的 mergeDirInto 完全对齐：**绝不静默覆盖或删除
  // 实例既有设置**。四种情形分别处理：
  //   1. 共享为空、本地有内容 → 用本地内容播种共享（不丢数据）
  //   2. 共享有内容、本地为空 → 采用共享内容（本地无可失去的数据，覆盖前仍先备份）
  //   3. 双方都有内容且**不同** → 判定冲突：**保留本地**、不动共享，
  //      并把冲突登记给调用方（`listShareConflicts`）由 UI 决定用哪一边
  //   4. 内容相同或双方都为空 → 不做任何写入（尤其不得删除用户文件）
  if (meta.settings.mode === 'shared') {
    const shared = sharedSettingsFile(root);
    const localText = (await readText(paths.settingsFile)) ?? '';
    const sharedText = (await readText(shared)) ?? '';
    if (await isLink(paths.settingsFile)) await removeLink(paths.settingsFile);
    clearShareConflicts(meta.id, 'settings');
    const localHas = localText.trim().length > 0;
    const sharedHas = sharedText.trim().length > 0;
    if (!sharedHas && localHas) {
      await ensureDir(path.dirname(shared));
      await backupFileIfNotEmpty(shared);
      await writeTextAtomic(shared, localText);
    } else if (sharedHas && !localHas) {
      if (localText.length > 0) await backupFile(paths.settingsFile);
      await writeTextAtomic(paths.settingsFile, sharedText);
    } else if (sharedHas && localHas && sharedText !== localText) {
      recordShareConflict({
        instanceId: meta.id,
        resource: 'settings',
        kept: 'local',
        localFile: paths.settingsFile,
        sharedFile: shared,
        message:
          '实例设置与共享设置内容不同：已保留实例自己的设置（未覆盖、未删除任何一边），' +
          '请在界面里选择"把本地设置推送到共享"或"用共享设置覆盖本地"',
      });
      onLog?.('system', `[whales] 设置冲突：实例与共享内容不同，已保留实例设置（${paths.settingsFile}）\n`);
    }
  } else {
    clearShareConflicts(meta.id, 'settings');
    if (await isLink(paths.settingsFile)) {
      const text = (await readText(paths.settingsFile)) ?? '';
      await removeLink(paths.settingsFile);
      await writeTextAtomic(paths.settingsFile, text);
    }
  }

  // credentials（inherit → 每次启动前从主 home 复制）
  if (meta.credentials.mode === 'inherit' && primaryHome !== null) {
    const source = path.join(primaryHome, '.credentials.yaml');
    const copied = await copyFileAtomic(source, paths.credentialsFile);
    onLog?.('system', copied ? `已继承主 home 凭证：${source}\n` : `主 home 未找到凭证文件（跳过继承）：${source}\n`);
  }
}

/** 把目录变成指向共享库的 junction（必要时先把本地数据并入共享库）。 */
async function linkDirectory(localDir: string, target: string): Promise<void> {
  if (await isLink(localDir)) return;
  if (await pathExists(localDir)) {
    const { skipped } = await mergeDirInto(localDir, target);
    const leftovers = await listDir(localDir);
    if (leftovers.length > 0) {
      throw new Error(
        `共享目录存在同名条目，已保留本地目录（未删除任何数据）：${localDir}\n` +
          `冲突条目：${leftovers.map((entry) => entry.name).join('、')}；跳过条目：${skipped.join('、')}`,
      );
    }
    await removeDir(localDir);
  }
  await replaceWithJunction(localDir, target);
}

/** 断言名称合法。 */
function assertValidName(name: string, label: string): void {
  const invalid = validateName(name);
  if (invalid !== null) throw new Error(`${label}不合法（${name}）：${invalid}`);
}

/** 比较两个组合包列表是否完全一致。 */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 取输出尾部若干行用于报错。 */
function tail(text: string, lines = 12): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}
