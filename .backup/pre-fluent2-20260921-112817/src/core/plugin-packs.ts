/**
 * WhalesLauncher core —— 「随实例搬运」的本地插件安装
 *
 * 目标形态（对齐 MC 整合包的迁移体验）：
 * ```
 * <实例>/home/plugins/<插件名>/         ← 插件文件本体，跟着实例目录一起走
 * <实例>/home/profiles/<p>/package.json ← 依赖写成相对 file:../../plugins/<名>
 * ```
 * profile 里**只留相对路径**，所以把整个实例目录复制到另一台机器 / 另一个位置后，
 * 只需一次 `dsh plugin --profile <p> install` 重新链接，插件不会丢、也不会指向旧机器的绝对路径。
 *
 * 三种来源：
 *  - `archive`：插件 zip（参考 dsh 插件仓库的目录格式，见 {@link installPlugin}）
 *  - `github` ：GitHub 仓库（走 pnpm 的 `github:` 依赖，落点在 profile 的 node_modules）
 *  - `folder` ：本地文件夹（建 junction 指向源目录，源目录改动即时可见，适合开发）
 *
 * 安全约束：zip 逐条目校验（拒绝绝对路径、`..`、盘符、ADS），与 `modpack.ts` 同一套口径。
 */
import AdmZip from 'adm-zip';
import yaml from 'js-yaml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AllowBuildsError } from '../shared/contracts';
import type {
  InstanceMeta,
  LauncherConfig,
  LogSink,
  PluginInstallResult,
  PluginInventory,
  PluginSource,
  PluginSummary,
} from '../shared/contracts';
import { copyFileAtomic, ensureDir, pathExists, readText, removeDir, writeJsonAtomic, writeTextAtomic } from './fsx';
import { resolveEngineBin } from './engine';
import { nodeRuntimeLabel, resolveNodeRuntime } from './node-runtime';
import { corePaths, childBaseEnv, instancePaths, pnpmCacheArgs } from './paths';
import { runCapture, type ProcLogSink } from './proc';
import { readBundles, readProfileInventory, readProfileManifest, writeProfileManifest, type ProfileManifest } from './profile';

/** 本地插件安装/卸载超时（首次要为插件拉依赖）。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** 插件包名（含 scope）合法性。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i;

/** zip 条目数量上限（防 zip 炸弹）。 */
const MAX_ARCHIVE_ENTRIES = 20_000;

/** zip 解压总字节上限（1 GiB）。 */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/** 复制插件时跳过的目录（都是可重建的缓存/依赖）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', '.cache', '__pycache__']);

/** 插件包内元数据的解读结果。 */
interface PluginMeta {
  name: string;
  version: string | null;
  description: string | null;
  /** `dsh.bundle.patch` 声明的相对路径（无声明为 null）。 */
  bundlePatch: string | null;
  /** `dsh.bundle.patch` 指向的文件是否真实存在。 */
  patchFileExists: boolean;
  /** 是否声明了 `dsh.client`（有 Web 界面部分）。 */
  hasClient: boolean;
  warnings: string[];
}

/**
 * 实例内插件目录：`<实例>/home/plugins`。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 绝对路径（不保证存在）。
 */
export function pluginsDir(root: string, meta: InstanceMeta): string {
  return instancePaths(root, meta).pluginsDir;
}

/* ------------------------------------------------------------------ *
 * 安装入口
 * ------------------------------------------------------------------ */

/**
 * 安装一个本地插件。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param source 来源（zip / GitHub / 文件夹）。
 * @param config 启动器全局设置（Node 运行时探测用）。
 * @param onLog 日志回调。
 * @returns 安装结果（落点、依赖规格、是否登记为组合包、最新清单）。
 * @throws 来源非法 / 压缩包越界 / 包名冲突 / pnpm 失败。
 */
export async function installPlugin(
  root: string,
  meta: InstanceMeta,
  source: PluginSource,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<PluginInstallResult> {
  if (source === null || typeof source !== 'object') throw new Error('插件来源格式错误');
  switch (source.kind) {
    case 'archive':
      return installFromArchive(root, meta, source, config, onLog);
    case 'github':
      return installFromGithub(root, meta, source, config, onLog);
    case 'folder':
      return installFromFolder(root, meta, source, config, onLog);
    default:
      throw new Error(`未知的插件来源：${JSON.stringify((source as { kind?: unknown }).kind)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 来源一：zip 压缩包
 * ------------------------------------------------------------------ */

/**
 * 从 zip 压缩包安装。
 *
 * 包格式与 dsh 插件仓库一致：包内（根目录或**唯一的**顶层子目录）必须含
 * `package.json`；声明了 `dsh.bundle.patch` 才能进入 profile 的组合包层。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param source 来源描述。
 * @param config 启动器全局设置。
 * @param onLog 日志回调。
 * @returns 安装结果。
 */
async function installFromArchive(
  root: string,
  meta: InstanceMeta,
  source: Extract<PluginSource, { kind: 'archive' }>,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<PluginInstallResult> {
  const file = source.file;
  if (typeof file !== 'string' || file.trim().length === 0) throw new Error('插件压缩包路径不能为空');
  if (!(await pathExists(file))) throw new Error(`插件压缩包不存在：${file}`);
  if (path.extname(file).toLowerCase() !== '.zip') {
    throw new Error(`只支持 .zip 插件包（当前：${path.basename(file)}）`);
  }
  const staged = path.join(corePaths(root).cacheDir, `plugin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    onLog?.('system', `[plugin] 解压插件包：${file}\n`);
    await ensureDir(staged);
    extractArchive(await readArchive(file), staged);
    const pluginRoot = await findPluginRoot(staged);
    const name = await resolveTargetName(pluginRoot, source.name);
    const target = await installIntoPlugins(root, meta, name, (dest) => copyTree(pluginRoot, dest), onLog);
    return await finalizeLocalPlugin(root, meta, name, target, { kind: 'archive', file }, config, onLog);
  } finally {
    await removeDir(staged).catch(() => undefined);
  }
}

/** 读取 zip（失败时给出可读的错误）。 */
async function readArchive(file: string): Promise<AdmZip> {
  try {
    return new AdmZip(file);
  } catch (error) {
    throw new Error(`无法读取插件压缩包：${file} —— ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 解压全部条目，逐条校验越界路径与体积上限。
 * @param zip 压缩包。
 * @param target 目标目录（必须已存在）。
 */
function extractArchive(zip: AdmZip, target: string): void {
  const rootResolved = path.resolve(target);
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`插件包条目过多（${entries.length} > ${MAX_ARCHIVE_ENTRIES}），已拒绝解压`);
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const segments = entry.entryName.split(/[\\/]+/).filter((segment) => segment.length > 1 || (segment.length === 1 && segment !== '.'));
    if (segments.length === 0) continue;
    if (segments.some((segment) => segment === '..' || segment.includes(':'))) {
      throw new Error(`插件包内含越界路径，已拒绝解压：${entry.entryName}`);
    }
    const out = path.resolve(rootResolved, ...segments);
    if (out !== rootResolved && !out.startsWith(rootResolved + path.sep)) {
      throw new Error(`插件包内含越界路径，已拒绝解压：${entry.entryName}`);
    }
    total += entry.header.size;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('插件包解压后体积过大，已拒绝解压');
    const data = entry.getData();
    const dir = path.dirname(out);
    if (dir !== rootResolved) ensureDirSync(dir);
    writeFileSyncSafe(out, data);
  }
}

/** 插件包根目录：根有 package.json 就用根，否则要求**唯一**的顶层子目录。 */
async function findPluginRoot(staged: string): Promise<string> {
  if (await pathExists(path.join(staged, 'package.json'))) return staged;
  const entries = await readDirSafe(staged);
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length === 1) {
    const candidate = path.join(staged, dirs[0]!.name);
    if (await pathExists(path.join(candidate, 'package.json'))) return candidate;
  }
  if (dirs.length === 0) throw new Error('插件包里没有找到 package.json（也不是「单一顶层文件夹」结构）');
  throw new Error(
    `插件包结构不明确：顶层有 ${dirs.length} 个文件夹（${dirs.slice(0, 5).map((d) => d.name).join(', ')}）。` +
      '请把插件文件夹单独打包（zip 内只有一个顶层目录，且其中含 package.json）。',
  );
}

/** 目标插件名：优先用户指定，否则取包内 package.json 的 name。 */
async function resolveTargetName(pluginRoot: string, wanted: string | undefined): Promise<string> {
  const meta = await readPluginMeta(pluginRoot);
  if (wanted !== undefined && wanted.trim().length > 0) {
    const name = wanted.trim();
    assertPackageName(name);
    return name;
  }
  return meta.name;
}

/* ------------------------------------------------------------------ *
 * 来源二：GitHub 仓库
 * ------------------------------------------------------------------ */

/**
 * 从 GitHub 仓库安装。
 *
 * 走 pnpm 的 `github:` 依赖：依赖落在 profile 的 `node_modules` 中、由
 * `package.json` 记录（可随实例搬运，重新 install 即恢复），**不复制**源码到
 * 实例的 plugins 目录 —— 这一点与 zip / 文件夹两种来源不同。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param source 来源描述。
 * @param config 启动器全局设置。
 * @param onLog 日志回调。
 * @returns 安装结果。
 */
async function installFromGithub(
  root: string,
  meta: InstanceMeta,
  source: Extract<PluginSource, { kind: 'github' }>,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<PluginInstallResult> {
  const repo = parseGithubUrl(source.url);
  const ref = normalizeRef(source.ref ?? repo.ref ?? undefined);
  if (ref !== null && !/^[A-Za-z0-9._\/-]+$/.test(ref)) {
    throw new Error(`GitHub ref 含非法字符：${JSON.stringify(ref)}`);
  }
  const name = repo.name;
  assertPackageName(name);
  const spec = `github:${repo.owner}/${name}${ref !== null ? `#${ref}` : ''}`;
  onLog?.('system', `[plugin] 从 GitHub 安装：${spec}（需要能访问 github.com）\n`);

  const warnings: string[] = ['GitHub 插件按仓库依赖安装（不进 home/plugins）；迁移实例后依赖会随 profile 清单重新安装。'];
  try {
    await runPluginCommand(root, meta, ['add', spec], config, onLog);
  } catch (error) {
    if (!(error instanceof AllowBuildsError)) {
      // 命令失败 ≠ 没装成：git 依赖的 prepare 构建会往 stderr 写一堆东西，
      // 某些插件（如 dshmarket 的自检）还会额外报错，命令退出码与最终状态可能不一致。
      // 以**事实**为准，避免把"其实已就位"报成失败。
      const landed = await verifyInstallLanded(root, meta, name);
      if (landed !== null) {
        onLog?.(
          'system',
          `[plugin] 命令以非零退出码结束，但依赖与文件均已就位（版本 ${landed.version ?? '未知'}）——按安装成功处理\n`,
        );
        warnings.push('安装命令的退出码非零，但依赖与文件已确认就位，按成功处理。');
        return await finializeGithubResult(root, meta, name, spec, warnings, landed.inventory);
      }
      throw error;
    }
    // git 插件的 prepare 脚本被 pnpm 拦截 → 自动放开后重试一次，而不是把
    // 「自己读 pnpm 提示、自己改 pnpm-workspace.yaml」丢给用户。
    const parsed = extractBuildScriptPackages(error.output);
    // 只接受与本仓库名相关的提取结果：pnpm 的输出里混着提示文字，
    // 一旦把提示词里的英文单词写进 allowBuilds，就等于替用户放开了别的包
    // （实测踩过：`diagnostics` / `git-hosted` / `re-run` 被当成包名）。
    const related = parsed.filter((item) => item === name || item.endsWith(`/${name}`));
    const allowed = related.length > 0 ? related : [name];
    const patched = await allowBuildScripts(root, meta, allowed);
    onLog?.(
      'system',
      `[plugin] pnpm 拦下了构建脚本，已写入 pnpm-workspace.yaml 的 onlyBuiltDependencies/allowBuilds：${allowed.join(', ')}\n` +
        `[plugin] 重新执行安装（构建脚本会在安装时执行一次）…\n`,
    );
    warnings.push(
      `该插件需要在安装时执行构建脚本（prepare）。已自动在 profile 的 pnpm-workspace.yaml 中把 ${allowed.join(', ')} 加入 onlyBuiltDependencies（并同步 allowBuilds），` +
        `然后重试安装 —— 这等于允许该仓库的代码在你机器上执行构建命令，请只对可信仓库这样做。` +
        (patched.length === 0 ? '（该配置此前已存在，未重复写入）' : ''),
    );
    try {
      await runPluginCommand(root, meta, ['add', spec], config, onLog);
    } catch (retryError) {
      // 同样以事实为准：重试命令报错，不代表没装成
      const landed = await verifyInstallLanded(root, meta, name);
      if (landed !== null) {
        onLog?.('system', `[plugin] 重试命令退出码非零，但依赖与文件均已就位——按安装成功处理\n`);
        warnings.push('重试安装的命令退出码非零，但依赖与文件已确认就位，按成功处理。');
        return await finializeGithubResult(root, meta, name, spec, warnings, landed.inventory);
      }
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `已放开构建脚本并重试，但安装仍未完成：${detail}\n` +
          `（构建脚本许可已写入 ${workspaceFile(root, meta)}：${allowed.join(', ')}）`,
      );
    }
  }

  const inventory = await readProfileInventory(root, meta);
  return await finializeGithubResult(root, meta, name, spec, warnings, inventory);
}

/** 组装 GitHub 来源的安装结果（依赖必须已出现在清单里）。 */
async function finializeGithubResult(
  root: string,
  meta: InstanceMeta,
  name: string,
  spec: string,
  warnings: string[],
  inventory: PluginInventory,
): Promise<PluginInstallResult> {
  const entry = inventory.dependencies.find((item) => item.name === name);
  if (entry === undefined) {
    throw new Error(`已执行安装，但 profile 依赖里没有出现 ${name} —— 请检查仓库名的 package.json name 是否与之不同`);
  }
  // 记账：界面据此对「启动器亲自装过」的插件给出明确状态，
  // 不受第三方自检（例如插件市场装完再验一遍）失败话术的影响。
  await noteInstall(root, meta, name, 'github', spec);
  return {
    name,
    version: entry.version,
    dir: path.join(instancePaths(root, meta).profileDir, 'node_modules', name),
    spec,
    registeredBundle: readBundles(await readManifestOrThrow(root, meta)).includes(name),
    linked: entry.installed,
    inventory,
    warnings,
  };
}

/**
 * 以**事实**判断某个依赖是否真的装好了（用于消解"命令退出码"与"实际状态"不一致）。
 *
 * 判据三条同时成立才算数：清单里有它、`node_modules` 里有它、`package.json` 能读。
 * 任一不成立就返回 null，让调用方按真实失败处理。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 依赖名。
 * @returns 已就位时为 `{ inventory, version }`，否则 null。
 */
async function verifyInstallLanded(
  root: string,
  meta: InstanceMeta,
  name: string,
): Promise<{ inventory: PluginInventory; version: string | null } | null> {
  let inventory: PluginInventory;
  try {
    inventory = await readProfileInventory(root, meta);
  } catch {
    return null;
  }
  const entry = inventory.dependencies.find((item) => item.name === name);
  if (entry === undefined) return null;
  const packageJson = path.join(instancePaths(root, meta).profileDir, 'node_modules', name, 'package.json');
  if (!(await pathExists(packageJson))) return null;
  return { inventory, version: entry.version };
}

/* ------------------------------------------------------------------ *
 * git 依赖的构建脚本许可（pnpm allowBuilds）
 * ------------------------------------------------------------------ */

/** profile 的 pnpm 工作区配置文件（pnpm 从这里读 allowBuilds）。 */
function workspaceFile(root: string, meta: InstanceMeta): string {
  return path.join(instancePaths(root, meta).profileDir, 'pnpm-workspace.yaml');
}

/** 用户显式设置了「不许问」时跳过自动放开。 */
const ALLOW_BUILDS_ENV = 'WHALES_PLUGIN_ALLOW_BUILDS';
const ALLOW_BUILDS_DISABLED = new Set(['0', 'false', 'no', 'off']);

/**
 * 把包名写进 profile 的 `pnpm-workspace.yaml`，允许它们在安装时执行构建脚本。
 *
 * **两个字段都要写**（2026-09-20 实测定位）：
 * pnpm 10.33 只认 `onlyBuiltDependencies`（**数组**）：
 * ```
 * ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED … The git-hosted package "dshmarket@1.49.0"
 * needs to execute build scripts but is not in the "onlyBuiltDependencies" allowlist.
 * Add the package to "onlyBuiltDependencies" in your project's pnpm-workspace.yaml…
 * ```
 * 而 dsh 在 pnpm 失败后追加的提示说的是 `allowBuilds`（**映射**）——
 * 那是另一个 pnpm 版本的字段名。只按 dsh 的话写 `allowBuilds`，拦住的是空气：
 * pnpm 10.33 对未知字段不报错、也不生效，用户看到的就是"改了配置还是不行"。
 * 因此这里同时维护两者：`onlyBuiltDependencies` 数组负责让 10.33 放行，
 * `allowBuilds` 映射留给认识它的版本（两边都写不会冲突，实测 10.33 容忍未知字段）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param packages 要放开的包名。
 * @returns 本次实际新增的包名（已在配置里则为空数组）。
 * @throws 配置无法解析时抛错 —— 宁可不写，也不能写坏 profile（写坏会让 pnpm 直接罢工）。
 */
async function allowBuildScripts(root: string, meta: InstanceMeta, packages: string[]): Promise<string[]> {
  // 逃生门：设置 WHALES_PLUGIN_ALLOW_BUILDS=0 可禁用自动放开（安全敏感场景）
  const flag = process.env[ALLOW_BUILDS_ENV];
  if (flag !== undefined && ALLOW_BUILDS_DISABLED.has(flag.trim().toLowerCase())) {
    throw new Error(
      `${ALLOW_BUILDS_ENV}=${flag} 已禁止自动放开构建脚本。` +
        `请手动把 pnpm 打印的 key 加进 ${workspaceFile(root, meta)} 的 onlyBuiltDependencies 后重试。`,
    );
  }
  const file = workspaceFile(root, meta);
  const raw = await readText(file);
  const doc: Record<string, unknown> = {};
  if (raw !== null && raw.trim().length > 0) {
    const parsed: unknown = yaml.load(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`无法解析 ${file}（顶层应为对象），未改动它。请修好后重试。`);
    }
    Object.assign(doc, parsed as Record<string, unknown>);
  }

  const list = readStringArray(doc.onlyBuiltDependencies, file, 'onlyBuiltDependencies');
  const map = readBooleanMap(doc.allowBuilds, file);
  const added: string[] = [];
  let changed = false;
  for (const name of packages) {
    if (!list.includes(name)) {
      list.push(name);
      added.push(name);
      changed = true;
    }
    if (map[name] !== true) {
      map[name] = true;
      // 目标已在数组、只是缺映射时也要落盘：只写一个字段等于半个配置
      changed = true;
    }
  }
  if (!changed) return [];
  doc.onlyBuiltDependencies = list;
  doc.allowBuilds = map;
  // 保留文件开头连续的注释块（那是 profile 的说明文字，丢掉会让用户莫名其妙）；
  // 键序与其余内容由 yaml.dump 重新序列化。
  const header = leadingComments(raw);
  await writeTextAtomic(file, header + yaml.dump(doc, { lineWidth: 120, noRefs: true }));
  return added;
}

/** 读取必须是字符串数组的字段（类型不对时拒绝写入，避免把 profile 写坏）。 */
function readStringArray(value: unknown, file: string, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${file} 里的 ${key} 不是数组，未改动它。请修好后重试。`);
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** 读取必须是「包名 → 布尔」映射的字段（类型不对时拒绝写入）。 */
function readBooleanMap(value: unknown, file: string): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (value === undefined || value === null) return map;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${file} 里的 allowBuilds 不是键值映射（形如 { "<包名>": true }），未改动它。请修好后重试。`,
    );
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    map[key] = item !== false;
  }
  return map;
}

/** 取文本开头连续的注释/空行（用于重写文件时保留说明）。 */
function leadingComments(raw: string | null): string {
  if (raw === null) return '';
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim().length === 0) kept.push(line);
    else break;
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) kept.pop();
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * 从 pnpm 输出里提取被拦下构建脚本的包名。
 *
 * pnpm 会打印 `Ignored build scripts: a@1.2.3, @s/b@2.0.0.`（可能跨行），
 * 每项形如 `<包名>@<版本/规格>`；包名本身可能带 `@scope/` 前缀。
 * @param output pnpm / dsh 的原始输出。
 * @returns 去重后的包名（解析不出则为空数组）。
 */
function extractBuildScriptPackages(output: string): string[] {
  if (typeof output !== 'string' || output.length === 0) return [];
  const names = new Set<string>();
  const marker = /(?:Ignored build scripts|ignored build scripts|onlyBuiltDependencies|allowBuilds)[^\n]*\n?([\s\S]{0,600})?/i.exec(output);
  const scope = marker !== null && typeof marker[1] === 'string' ? `${marker[0]}\n${marker[1]}` : output;
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const token = raw.trim().replace(/^[-\s]+/, '').replace(/[.,;:'"()]+$/, '').replace(/^["']|["']$/g, '');
    const match = /^(@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*|[a-z0-9][a-z0-9-._~]*)@/.exec(token);
    if (match !== null) names.add(match[1]!);
  };
  for (const raw of scope.split(/[\s,;]+/)) add(raw);
  // pnpm 10.33 的致命形态不给"包名@版本"列表，而是给一份配置示例：
  //   Add the package to "onlyBuiltDependencies" … For example:
  //   onlyBuiltDependencies:
  //     - "dshmarket"
  // 其中 `- "包名"` 才是权威来源，单独扫一遍。
  for (const line of output.split(/\r?\n/)) {
    const item = /^\s*-\s*["']?([@a-z0-9][\w@./-]*)["']?\s*$/i.exec(line);
    if (item !== null && PACKAGE_NAME_RE.test(item[1]!)) names.add(item[1]!);
  }
  if (names.size > 0) return [...names];
  // 兜底：只有输出**确实**在谈构建脚本时才扫裸包名。
  // 不加这道闸门会把 `some unrelated failure` 里的普通单词当成包名去写进配置——
  // 那等于替用户放开了不该放开的包。
  if (!/build script|onlyBuiltDependencies|allowBuilds|approve-builds|prepare/i.test(output)) return [];
  for (const candidate of output.split(/[\s,;]+/)) {
    const token = candidate.trim().replace(/[.,;:'"()]+$/, '');
    if (PACKAGE_NAME_RE.test(token) && !KNOWN_OPTION_WORDS.has(token.toLowerCase())) names.add(token);
  }
  return [...names];
}

/** 兜底扫描时要排除的常见英文词（避免把提示句里的词当成包名）。 */
const KNOWN_OPTION_WORDS = new Set([
  'pnpm', 'dsh', 'plugin', 'plugins', 'add', 'install', 'allowbuilds', 'build', 'builds',
  'script', 'scripts', 'prepare', 'git', 'github', 'hosted', 'via', 'their', 'the', 'a', 'an',
  'exact', 'key', 'printed', 'above', 'under', 'in', 'and', 'then', 're', 'run', 'rerun',
  'was', 'not', 'found', 'failed', 'failure', 'error', 'ignored', 'to', 'pick', 'which',
  'allow', 'until', 'allowed', 'blocks', 'blocked', 'on', 'with', 'for', 'of', 'or', 'is',
  'com', 'www', 'http', 'https', 'yaml', 'yml', 'file', 'path', 'some', 'unrelated',
]);

/**
 * 判断错误输出是否是「git 依赖的构建脚本被拦下」。
 *
 * **只认 pnpm 自己的声明**：
 *  - `Ignored build scripts: …`（非致命形态）
 *  - `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（致命形态，pnpm 10.33 实际报的就是它）
 *  - `onlyBuiltDependencies` / `allowBuilds` 配置示例段
 *
 * 反面教训（2026-09-20 实测踩坑）：dsh 对**任何** pnpm 失败都会追加同一句
 * "git-hosted plugins build on install via their prepare script … under allowBuilds …"。
 * 早先这里把 `prepare script` 也当判据，于是 `ERR_PNPM_UNEXPECTED_STORE`（store 位置不一致，
 * 与构建脚本毫无关系）被误判成构建脚本问题，程序跑去改配置并重试——既没解决问题，又污染了配置。
 * 因此：除上述白名单错误码外，带 `ERR_PNPM_` 的失败一律不认。
 * @param output pnpm / dsh 的原始输出（保留完整输出是为了将来能从里面提取更多线索）。
 * @returns 是否应视为构建脚本被拦下。
 */
function looksLikeAllowBuildsFailure(output: string): boolean {
  if (typeof output !== 'string' || output.length === 0) return false;
  if (/Ignored build scripts/i.test(output)) return true;
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(output)) return true;
  if (/ERR_PNPM_/.test(output)) return false;
  return /onlyBuiltDependencies|allowBuilds/i.test(output) && /[\w@/-]+\s*:\s*(?:true|false)/i.test(output);
}

/** 解析 GitHub 仓库地址（支持 URL、SSH、`owner/repo#ref` 简写）。 */
function parseGithubUrl(input: string): { owner: string; name: string; ref: string | null } {
  if (typeof input !== 'string') throw new Error('GitHub 地址格式错误');
  let text = input.trim();
  if (text.length === 0) throw new Error('GitHub 地址不能为空');
  let ref: string | null = null;
  // `#ref` 后缀
  const hash = text.indexOf('#');
  if (hash >= 0) {
    ref = text.slice(hash + 1).trim() || null;
    text = text.slice(0, hash);
  }
  text = text.replace(/^git\+/, '');
  // `github:owner/repo`：用户在 dsh 日志、pnpm 输出或文档里看到的就是这个写法，
  // 直接粘贴过来必须能用（否则会得到一句"无法解析 GitHub 地址"，非常劝退）。
  text = text.replace(/^github:/i, '');
  // SSH 形式：git@github.com:owner/repo.git
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/i.exec(text);
  if (ssh !== null) return withRef(ssh[1]!, ssh[2]!, ref);
  // HTTP(S) 形式
  const http = /^(?:https?|git):\/\/(?:www\.)?github\.com\/([^/]+)\/(.+)$/i.exec(text);
  if (http !== null) {
    let rest = http[2]!;
    // /tree/<ref> 或 /blob/<ref>
    const tree = /^(.*?)(?:\.git)?\/(?:tree|blob)\/(.+)$/i.exec(rest);
    if (tree !== null) {
      rest = tree[1]!;
      if (ref === null) ref = tree[2]!.split('/')[0]!.trim() || null;
    }
    return withRef(http[1]!, rest, ref);
  }
  // owner/repo 简写
  const shorthand = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text);
  if (shorthand !== null) {
    // 拒绝 `github.com/owner` 这类被砍掉 scheme 的残缺地址：那会被当成
    // owner=`github.com` 的仓库去拉，得到的错误信息毫无指向性。
    if (LOOKS_LIKE_HOST.test(shorthand[1]!)) {
      throw new Error(
        `无法解析 GitHub 地址：${JSON.stringify(input)}（看起来缺少 https:// 前缀，例如 https://github.com/owner/repo）`,
      );
    }
    return withRef(shorthand[1]!, shorthand[2]!, ref);
  }
  throw new Error(`无法解析 GitHub 地址：${JSON.stringify(input)}（示例：https://github.com/owner/repo 或 owner/repo#v1.0.0）`);
}

/** 简写形式里一眼就是域名/主机的 owner（避免把残缺 URL 当仓库名）。 */
const LOOKS_LIKE_HOST = /^(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|dev|cn|co|me|app|git)$/i;

/** 组装解析结果并去掉 `.git` 后缀。 */
function withRef(owner: string, repoRaw: string, ref: string | null): { owner: string; name: string; ref: string | null } {
  const name = repoRaw.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (name.length === 0 || owner.length === 0) throw new Error('GitHub 地址缺少仓库名');
  return { owner, name, ref: ref === null || ref.length === 0 ? null : ref };
}

/** ref 规范化：去空白、去首尾斜杠。 */
function normalizeRef(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const trimmed = ref.trim().replace(/^\/+|\/+$/g, '');
  return trimmed.length === 0 ? null : trimmed;
}

/* ------------------------------------------------------------------ *
 * 来源三：本地文件夹（junction 链接，适合开发）
 * ------------------------------------------------------------------ */

/**
 * 从本地文件夹安装：把 `node_modules/<name>` 换成指向源目录的 junction。
 *
 * 与 zip 的区别是**不复制**：改源目录里的 `index.js`，实例重启后即生效。
 * 代价是实例不能整体搬走（链接指向实例之外的绝对路径），所以界面上标注为
 * 「链接（不随实例搬运）」。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param source 来源描述。
 * @param config 启动器全局设置。
 * @param onLog 日志回调。
 * @returns 安装结果。
 */
async function installFromFolder(
  root: string,
  meta: InstanceMeta,
  source: Extract<PluginSource, { kind: 'folder' }>,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<PluginInstallResult> {
  const dir = typeof source.dir === 'string' ? source.dir.trim() : '';
  if (dir.length === 0) throw new Error('插件文件夹路径不能为空');
  if (!(await pathExists(path.join(dir, 'package.json')))) {
    throw new Error(`文件夹里没有 package.json，不是有效的插件目录：${dir}`);
  }
  const meta_ = await readPluginMeta(dir);
  const name = meta_.name;
  onLog?.('system', `[plugin] 链接本地插件 ${name} → ${dir}\n`);
  await runPluginCommand(root, meta, ['add', dir], config, onLog);
  const inventory = await readProfileInventory(root, meta);
  const entry = inventory.dependencies.find((item) => item.name === name);
  const profiles = instancePaths(root, meta);
  return {
    name,
    version: meta_.version,
    dir: path.resolve(dir),
    spec: entry?.spec ?? `link:${path.resolve(dir)}`,
    registeredBundle: readBundles(await readManifestOrThrow(root, meta)).includes(name),
    linked: entry?.installed ?? false,
    inventory,
    warnings: [
      '文件夹安装是 junction 链接（不复制文件），适合开发调试；这样的插件不随实例目录搬运。',
      ...meta_.warnings,
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 复制 / 落盘 / 依赖登记
 * ------------------------------------------------------------------ */

/**
 * 把插件放进实例的 plugins 目录（先落临时目录再改名，避免半装状态）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 插件名（= 目标目录名）。
 * @param produce 写出内容的回调（目标目录已就绪）。
 * @param onLog 日志回调。
 * @returns 插件目录绝对路径。
 */
async function installIntoPlugins(
  root: string,
  meta: InstanceMeta,
  name: string,
  produce: (dest: string) => Promise<void>,
  onLog?: LogSink,
): Promise<string> {
  assertPackageName(name);
  const plugins = pluginsDir(root, meta);
  const target = path.join(plugins, name);
  if (await pathExists(target)) {
    throw new Error(`插件目录已存在：${target}。请先卸载该插件，或改名后再安装。`);
  }
  const staging = path.join(plugins, `.staging-${name}-${Date.now()}`);
  await removeDir(staging).catch(() => undefined);
  await ensureDir(staging);
  try {
    await produce(staging);
    await mkdir(plugins, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await removeDir(staging).catch(() => undefined);
    throw error;
  }
  onLog?.('system', `[plugin] 插件已就位：${target}\n`);
  return target;
}

/** 递归复制目录（跳过可重建的缓存目录）。 */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readDirSafe(from)) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await copyTree(path.join(from, entry.name), path.join(to, entry.name));
    } else if (entry.isFile()) {
      await copyFileAtomic(path.join(from, entry.name), path.join(to, entry.name));
    }
  }
}

/**
 * 把「实例内插件」登记进 profile：相对 `file:` 依赖 + 可选 bundles 行，然后 install 生效。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 插件名。
 * @param target 插件目录（实例内绝对路径）。
 * @param origin 来源标记（写进实例插件登记文件）。
 * @param config 启动器全局设置。
 * @param onLog 日志回调。
 * @returns 安装结果。
 */
async function finalizeLocalPlugin(
  root: string,
  meta: InstanceMeta,
  name: string,
  target: string,
  origin: { kind: 'archive'; file: string } | { kind: 'manual' },
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<PluginInstallResult> {
  const profileDir = instancePaths(root, meta).profileDir;
  const relative = path.relative(profileDir, target).split(path.sep).join('/');
  const spec = relative.startsWith('.') ? `file:${relative}` : `file:./${relative}`;
  const meta_ = await readPluginMeta(target);

  const manifest = await readManifestOrThrow(root, meta);
  const dependencies = { ...(manifest.dependencies ?? {}) };
  dependencies[name] = spec;
  const bundles = [...readBundles(manifest)];
  let registeredBundle = false;
  if (meta_.bundlePatch !== null) {
    if (!bundles.includes(name)) bundles.push(name);
    registeredBundle = true;
  } else {
    meta_.warnings.push(
      '插件未声明 dsh.bundle.patch —— 已作为普通依赖安装，不会进入组合包层（纯客户端插件由 dsh 自行处理）。',
    );
  }
  const next: ProfileManifest = { ...manifest, dependencies, dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } } };
  await writeProfileManifest(profileDir, next);
  onLog?.('system', `[plugin] profile 依赖：${name} = ${spec}${registeredBundle ? '；已加入 dsh.profile.bundles' : ''}\n`);

  // 登记来源，界面据此区分「随实例搬运」与「链接到外部」
  await writeJsonAtomic(path.join(target, PLUGIN_ORIGIN_FILE), {
    name,
    origin: origin.kind,
    source: origin.kind === 'archive' ? origin.file : null,
    installedAt: new Date().toISOString(),
  });

  await runProfileInstall(root, meta, config, onLog);
  const inventory = await readProfileInventory(root, meta);
  const entry = inventory.dependencies.find((item) => item.name === name);
  return {
    name,
    version: meta_.version,
    dir: target,
    spec,
    registeredBundle,
    linked: entry?.installed ?? (await pathExists(path.join(profileDir, 'node_modules', name))),
    inventory,
    warnings: meta_.warnings,
  };
}

/** 在 profile 目录里跑一次 `dsh plugin --profile <p> install`，把依赖链上去。 */
async function runProfileInstall(
  root: string,
  meta: InstanceMeta,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<void> {
  await runPluginCommand(root, meta, ['install'], config, onLog);
}

/** 执行 `dsh plugin`（与插件管理器共享同一条包操作路径与 profile 写锁）。 */
async function runPluginCommand(
  root: string,
  meta: InstanceMeta,
  pnpmArgs: string[],
  config: LauncherConfig | undefined,
  onLog: ProcLogSink | undefined,
): Promise<string> {
  const binPath = resolveEngineBin(root, meta.engine.version);
  if (binPath === null) throw new Error(`引擎 ${meta.engine.version} 未安装，无法管理插件`);
  const paths = instancePaths(root, meta);
  const node = await resolveNodeRuntime({
    configuredPath: config?.nodePath ?? null,
    captureDir: corePaths(root).cacheDir,
  });
  if (!node.ok) throw new Error(node.message);
  const args = ['plugin', '--profile', meta.profile.name, ...pnpmArgs, ...pnpmCacheArgs(root)];
  onLog?.('system', `dsh plugin --profile ${meta.profile.name} ${pnpmArgs.join(' ')}（${nodeRuntimeLabel(node)}）\n`);
  // 陈旧写锁会让这次操作空等 dsh 的锁超时（实测 121 秒）后才失败。
  // 动手前先清掉「持有者已不存在」的锁，避免用户白等两分钟。
  await clearStaleWriterLock(paths.profileDir, onLog);
  // 同理：锁文件与 package.json 不一致（依赖被手工移除、dsh 回滚过）时，
  // pnpm 每次都要重新解析依赖图，安装会明显变慢甚至直接失败。
  await clearStaleLockfile(paths.profileDir, onLog);
  const result = await runCapture(String(node.file), [binPath, ...args], {
    cwd: paths.root,
    env: { DSH_HOME: paths.home, ...childBaseEnv(root) },
    onLog,
    timeoutMs: INSTALL_TIMEOUT_MS,
    captureDir: corePaths(root).cacheDir,
  });
  if (result.code !== 0) {
    if (result.code === 127) {
      throw new Error('未找到 pnpm：请安装 pnpm 并确保它在 PATH 中（插件依赖管理依赖 pnpm）');
    }
    // 把两侧输出都带上：dsh 只把它自己那句提示写到 stderr，pnpm 的原始输出
    // （含 `Ignored build scripts: <包名>@<版本>`）在 stdout，自动放开 allowBuilds
    // 需要从那里拿包名。
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const summary = `插件操作失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`;
    if (/timed out waiting for the writer lock/i.test(output)) {
      throw new Error(
        `等待 profile 写锁超时：${paths.profileDir}\\package.json.lock 正被另一个进程持有。\n` +
          '通常是「实例正在运行」——dsh 的插件操作与运行中的实例共用同一把锁。请先停止该实例再重试。\n' +
          `若确认实例已停止，可删除该锁文件后重试：${path.join(paths.profileDir, LOCK_FILE_NAME)}`,
      );
    }
    if (looksLikeAllowBuildsFailure(output)) throw new AllowBuildsError(summary, output);
    throw new Error(summary);
  }
  return result.stdout;
}

/** dsh 的 profile 写锁文件名（`dsh-atomic-write` 在 profile 目录下创建）。 */
const LOCK_FILE_NAME = 'package.json.lock';

/** pnpm 依赖锁文件名。 */
const LOCK_FILE_NAME_LOCKFILE = 'pnpm-lock.yaml';

/**
 * 清掉与 profile 清单**不一致**的 `pnpm-lock.yaml`。
 *
 * 实测场景（test1）：此前一次失败安装留下的锁文件里还记着 `js-yaml`，
 * 而清单已被 dsh 回滚成空 —— 之后每次安装 pnpm 都要走"specifiers 不匹配 → 重新解析
 * 依赖图"这条路，既慢（要把 registry 再问一遍，本机实测可观）又容易直接失败
 * （`specifiers in the lockfile don't match specifiers in package.json`）。
 * 锁文件是可再生成的派生数据，与清单不一致时删掉让 pnpm 重建才是正解。
 * @param profileDir profile 目录。
 * @param onLog 日志回调。
 * @returns 是否清掉了一个陈旧锁文件。
 */
async function clearStaleLockfile(profileDir: string, onLog?: ProcLogSink): Promise<boolean> {
  const lockPath = path.join(profileDir, LOCK_FILE_NAME_LOCKFILE);
  const raw = await readText(lockPath);
  if (raw === null) return false;
  const manifest = await readProfileManifest(profileDir);
  if (manifest === null) return false;
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  let locked: Set<string>;
  try {
    const parsed: unknown = yaml.load(raw);
    const importers =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { importers?: Record<string, { dependencies?: Record<string, unknown> }> }).importers
        : undefined;
    const root = importers !== undefined && importers !== null ? importers['.'] : undefined;
    locked = new Set(Object.keys(root?.dependencies ?? {}));
  } catch {
    // 锁文件坏了（无法解析）同样属于"该重建"的情形
    locked = new Set(['__unparsable__']);
  }
  const same = declared.size === locked.size && [...declared].every((name) => locked.has(name));
  if (same) return false;
  await rm(lockPath, { force: true });
  onLog?.(
    'system',
    `[plugin] pnpm-lock.yaml 与 profile 清单不一致（清单 ${[...declared].join(', ') || '无'}；` +
      `锁文件 ${[...locked].slice(0, 8).join(', ') || '无'}），已删除让其重建\n`,
  );
  return true;
}

/**
 * 清掉「持有者已不存在」的 profile 写锁。
 *
 * 锁文件里是持有者的 PID（dsh 的 atomic-write 如此实现）。这里只在该 PID **确实
 * 不存在**时才删——对活着的进程绝不动手，否则会把正在进行的安装搅坏。
 * @param profileDir profile 目录。
 * @param onLog 日志回调。
 * @returns 是否清掉了一个陈旧锁。
 */
async function clearStaleWriterLock(profileDir: string, onLog?: ProcLogSink): Promise<boolean> {
  const lockPath = path.join(profileDir, LOCK_FILE_NAME);
  const raw = await readText(lockPath);
  if (raw === null) return false;
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let alive = true;
  try {
    // 信号 0 只探测存在性，不真的发信号
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM = 进程存在但无权限；ESRCH = 进程不存在
    alive = code === 'EPERM';
  }
  if (alive) return false;
  await rm(lockPath, { force: true });
  onLog?.('system', `[plugin] 发现陈旧写锁（持有者 PID ${pid} 已不存在），已清理：${lockPath}\n`);
  return true;
}

/* ------------------------------------------------------------------ *
 * 读取 / 卸载
 * ------------------------------------------------------------------ */

/** 实例内插件登记文件名（记录来源，供界面区分）。 */
const PLUGIN_ORIGIN_FILE = '.whales-plugin.json';

/**
 * profile 级的「启动器安装账本」：`<profile>/.whales-plugins.json`。
 *
 * 为什么要有它：安装命令的退出码与实际状态可能不一致（git 依赖的 prepare 会写大量
 * stderr、第三方插件装完还会自己再验一遍），界面需要一个**由启动器亲自记录的事实**，
 * 才能在第三方报失败时给出"它其实已经就位"的明确结论，而不是被话术带偏。
 */
const PLUGIN_LEDGER_FILE = '.whales-plugins.json';

/** 账本内容：插件名 → 记录。 */
type PluginLedger = Record<string, { kind: string; source: string | null; at: string }>;

/** 读取账本（损坏时按空处理，不影响插件本身）。 */
async function readLedger(root: string, meta: InstanceMeta): Promise<PluginLedger> {
  const raw = await readText(path.join(instancePaths(root, meta).profileDir, PLUGIN_LEDGER_FILE));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PluginLedger;
  } catch {
    return {};
  }
}

/** 写入账本（原子替换）。 */
async function writeLedger(root: string, meta: InstanceMeta, ledger: PluginLedger): Promise<void> {
  await writeJsonAtomic(path.join(instancePaths(root, meta).profileDir, PLUGIN_LEDGER_FILE), ledger);
}

/** 记一笔「启动器装了它」（幂等，重复装会刷新时间）。 */
async function noteInstall(
  root: string,
  meta: InstanceMeta,
  name: string,
  kind: string,
  source: string | null,
): Promise<void> {
  const ledger = await readLedger(root, meta);
  ledger[name] = { kind, source, at: new Date().toISOString() };
  await writeLedger(root, meta, ledger);
}

/**
 * 列出实例内可管理的本地插件。
 *
 * 两个来源都要覆盖：
 *  1. `home/plugins` 下的目录（zip / 手工放入 —— 随实例搬运）；
 *  2. profile 依赖里以绝对 `link:` 指向实例外目录的插件（文件夹来源 —— 不随实例搬运）。
 * 只列 1 会让「文件夹安装」的插件在界面上凭空消失，用户无法卸载它。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 插件概要列表（按名称排序）。
 */
export async function listInstancePlugins(root: string, meta: InstanceMeta): Promise<PluginSummary[]> {
  const paths = instancePaths(root, meta);
  const dir = paths.pluginsDir;
  const manifest = await readProfileManifest(paths.profileDir);
  const dependencies = manifest?.dependencies ?? {};
  const bundles = new Set(readBundles(manifest ?? {}));
  const ledger = await readLedger(root, meta);
  const result: PluginSummary[] = [];
  const listed = new Set<string>();

  if (await pathExists(dir)) {
    for (const entry of await readDirSafe(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pluginDir = path.join(dir, entry.name);
      if (!(await pathExists(path.join(pluginDir, 'package.json')))) continue;
      const meta_ = await readPluginMeta(pluginDir).catch(() => null);
      if (meta_ === null) continue;
      listed.add(entry.name);
      const note = ledger[entry.name];
      result.push({
        name: entry.name,
        version: meta_.version,
        dir: pluginDir,
        origin: note !== undefined ? originFromLedger(note.kind) : await readOriginFile(pluginDir),
        enabled: bundles.has(entry.name),
        hasBundlePatch: meta_.bundlePatch !== null,
        hasClient: meta_.hasClient,
        description: meta_.description,
        patchFileExists: meta_.patchFileExists,
        spec: dependencies[entry.name] ?? null,
        installedByLauncher: note !== undefined,
        installedVia: note ?? null,
      });
    }
  }

  // 实例外目录的 link: 依赖（文件夹来源）
  const pluginsResolved = path.resolve(dir);
  for (const [name, spec] of Object.entries(dependencies)) {
    if (listed.has(name)) continue;
    const raw = spec.replace(/^link:/i, '');
    if (!/^link:/i.test(spec) || !path.isAbsolute(raw)) continue;
    const target = path.resolve(raw);
    if (target === pluginsResolved || target.startsWith(pluginsResolved + path.sep)) continue;
    if (!(await pathExists(path.join(target, 'package.json')))) continue;
    const meta_ = await readPluginMeta(target).catch(() => null);
    if (meta_ === null) continue;
    listed.add(name);
    const note = ledger[name];
    result.push({
      name,
      version: meta_.version,
      dir: target,
      origin: 'folder',
      enabled: bundles.has(name),
      hasBundlePatch: meta_.bundlePatch !== null,
      hasClient: meta_.hasClient,
      description: meta_.description,
      patchFileExists: meta_.patchFileExists,
      spec,
      installedByLauncher: note !== undefined || (await pathExists(path.join(target, PLUGIN_ORIGIN_FILE))),
      installedVia: note ?? null,
    });
  }

  // 启动器亲自装过的 GitHub 依赖也列出来：它不在 home/plugins 里，
  // 但界面必须能看到「装过什么、成没成」，否则第三方自检一报错用户就无从判断。
  for (const [name, spec] of Object.entries(dependencies)) {
    if (listed.has(name)) continue;
    if (!/^github:/i.test(spec)) continue;
    const pkgDir = path.join(paths.profileDir, 'node_modules', name);
    if (!(await pathExists(path.join(pkgDir, 'package.json')))) continue;
    const meta_ = await readPluginMeta(pkgDir).catch(() => null);
    if (meta_ === null) continue;
    listed.add(name);
    const note = ledger[name];
    result.push({
      name,
      version: meta_.version,
      dir: pkgDir,
      origin: 'github',
      enabled: bundles.has(name),
      hasBundlePatch: meta_.bundlePatch !== null,
      hasClient: meta_.hasClient,
      description: meta_.description,
      patchFileExists: meta_.patchFileExists,
      spec,
      installedByLauncher: note !== undefined,
      installedVia: note ?? null,
    });
  }

  return result.sort((left, right) => left.name.localeCompare(right.name));
}

/** 账本里的来源类型 → 界面的来源标签。 */
function originFromLedger(kind: string): PluginSummary['origin'] {
  if (kind === 'archive' || kind === 'github' || kind === 'folder') return kind;
  return 'unknown';
}

/** 读取 `.whales-plugin.json` 里的来源标记。 */
async function readOriginFile(pluginDir: string): Promise<PluginSummary['origin']> {
  const raw = await readText(path.join(pluginDir, PLUGIN_ORIGIN_FILE));
  if (raw === null) return 'manual';
  try {
    const parsed = JSON.parse(raw) as { origin?: unknown };
    const value = parsed.origin;
    if (value === 'archive' || value === 'github' || value === 'folder') return value;
  } catch {
    /* 损坏的来源标记不影响插件本身，按 manual 处理 */
  }
  return 'unknown';
}

/**
 * 卸载一个本地插件：清 profile 依赖与 bundles 登记，再清理插件本体。
 *
 * **插件本体的处理取决于来源**：位于实例 `home/plugins` 内的（zip / 手工放入）
 * 是副本，直接删除；位于实例之外的（文件夹来源）是用户的开发目录，**只断开
 * 链接、绝不删除源目录** —— 删掉用户正在开发的代码是不可逆的事故。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 插件名。
 * @param config 启动器全局设置。
 * @param onLog 日志回调。
 * @throws 插件不存在 / pnpm 失败。
 */
export async function removeInstancePlugin(
  root: string,
  meta: InstanceMeta,
  name: string,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<void> {
  assertPackageName(name);
  const paths = instancePaths(root, meta);
  const pluginsRoot = path.resolve(paths.pluginsDir);
  const managed = path.join(paths.pluginsDir, name);
  const manifest = await readManifestOrThrow(root, meta);
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const spec = dependencies[name] ?? null;
  const owned = Object.hasOwn(dependencies, name);
  if (!owned && !(await pathExists(managed))) throw new Error(`实例内没有名为 ${name} 的本地插件`);

  delete dependencies[name];
  const bundles = readBundles(manifest).filter((item) => item !== name);
  await writeProfileManifest(paths.profileDir, {
    ...manifest,
    dependencies,
    dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } },
  });
  onLog?.('system', `[plugin] 已从 profile 依赖与组合包中移除 ${name}\n`);

  // 账本同步清掉：留着会让界面把一个已经卸载的插件显示成「启动器已装好」
  const ledger = await readLedger(root, meta);
  if (Object.hasOwn(ledger, name)) {
    delete ledger[name];
    await writeLedger(root, meta, ledger);
  }

  // 让 pnpm 摘掉 node_modules 里的链接（即使依赖清单已空也跑一次，
  // 否则会留下悬空 junction，之后该 profile 的所有安装都会被它挡死）
  await runProfileInstall(root, meta, config, onLog);

  // 只删实例内那份副本；link: 指向实例外的开发目录时保留源目录
  const linkTarget = spec !== null && /^link:/i.test(spec) ? path.resolve(spec.replace(/^link:/i, '')) : null;
  const externalDir = linkTarget !== null && !(linkTarget === pluginsRoot || linkTarget.startsWith(pluginsRoot + path.sep));
  if (externalDir) {
    onLog?.('system', `[plugin] 已断开链接，源目录保留未删：${linkTarget}\n`);
    return;
  }
  await removeDir(managed);
  onLog?.('system', `[plugin] 已删除插件目录：${managed}\n`);
}

/* ------------------------------------------------------------------ *
 * 包内元数据
 * ------------------------------------------------------------------ */

/** 读取并校验插件包内的 `package.json` 与 dsh 元数据。 */
async function readPluginMeta(dir: string): Promise<PluginMeta> {
  const raw = await readText(path.join(dir, 'package.json'));
  if (raw === null) throw new Error(`插件目录缺少 package.json：${dir}`);
  let parsed: {
    name?: unknown;
    version?: unknown;
    description?: unknown;
    dsh?: { bundle?: unknown; client?: unknown } | undefined;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new Error(`插件 package.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (name.length === 0) throw new Error('插件 package.json 缺少 name 字段');
  assertPackageName(name);
  const warnings: string[] = [];
  const bundlePatch = readBundlePatch(parsed.dsh?.bundle);
  let patchFileExists = false;
  if (bundlePatch === null) {
    warnings.push('未声明 dsh.bundle.patch。');
  } else {
    const resolved = path.resolve(dir, bundlePatch);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`dsh.bundle.patch 指向包外路径，已拒绝：${bundlePatch}`);
    }
    patchFileExists = await pathExists(resolved);
    if (!patchFileExists) warnings.push(`dsh.bundle.patch 指向的文件不存在：${bundlePatch}（实例启动会失败）`);
  }
  return {
    name,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    description: typeof parsed.description === 'string' ? parsed.description : null,
    bundlePatch,
    patchFileExists,
    hasClient: parsed.dsh?.client !== undefined && parsed.dsh?.client !== null,
    warnings,
  };
}

/** 读 `dsh.bundle.patch`（兼容字符串与 `{ patch: string }` 两种写法）。 */
function readBundlePatch(bundle: unknown): string | null {
  if (typeof bundle === 'string') return bundle.trim() || null;
  if (bundle !== null && typeof bundle === 'object') {
    const value = (bundle as { patch?: unknown }).patch;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** 读取 profile 清单，缺失时报可读错误。 */
async function readManifestOrThrow(root: string, meta: InstanceMeta): Promise<ProfileManifest> {
  const manifest = await readProfileManifest(instancePaths(root, meta).profileDir);
  if (manifest === null) throw new Error('profile 清单不存在（实例可能未创建完成）');
  return manifest;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 校验 npm 包名（同时用作插件目录名，因此必须拒绝路径分隔符）。 */
function assertPackageName(name: string): void {
  if (name.length === 0 || name.length > 214) throw new Error(`插件名长度不合法：${JSON.stringify(name)}`);
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new Error(`插件名不合法：${JSON.stringify(name)}（应为 npm 包名，如 my-plugin 或 @scope/my-plugin）`);
  }
}

/** 列目录（不存在返回空数组）。 */
async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 同步建目录（AdmZip 解压循环内部使用，避免每个条目一次 await）。 */
function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 同步写文件（解压循环内部使用）。 */
function writeFileSyncSafe(file: string, data: Buffer): void {
  writeFileSync(file, data);
}

/** 取输出尾部若干行。 */
function tail(text: string, lines = 12): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

/* ------------------------------------------------------------------ *
 * 供 main 层复用的补充导出
 * ------------------------------------------------------------------ */

export { readPluginMeta, PLUGIN_ORIGIN_FILE, runPluginCommand as runPluginInstallCommand };
export type { PluginMeta };

/**
 * 内部工具的测试出口（给 `tests/core/plugin-packs.test.mjs` 用）。
 *
 * 这些是纯函数，不需要引擎/网络即可验证；列在这里而不是做成公开契约，
 * 是为了不让它们成为对外承诺。
 */
export const __test = {
  /** 解析 GitHub 地址（URL / SSH / `owner/repo#ref` 简写）。 */
  parseGithubUrl,
  /** 规范化 ref。 */
  normalizeRef,
  /** 读取包内元数据（含 dsh.bundle.patch 校验）。 */
  readPluginMeta,
  /** 包名合法性校验（同时用作目录名）。 */
  assertPackageName,
  /** 从 pnpm 输出提取被拦下构建脚本的包名。 */
  extractBuildScriptPackages,
  /** 判断输出是否是「构建脚本被拦下」。 */
  looksLikeAllowBuildsFailure,
  /** 往 profile 的 pnpm-workspace.yaml 写 allowBuilds / onlyBuiltDependencies。 */
  allowBuildScripts,
  /** 清理「持有者已不存在」的 profile 写锁。 */
  clearStaleWriterLock,
  /** 清理与 profile 清单不一致的 pnpm-lock.yaml（否则每次安装都要重新解析，明显变慢）。 */
  clearStaleLockfile,
};
