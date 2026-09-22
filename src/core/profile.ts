/**
 * WhalesLauncher core —— profile 读写（package.json / cordis.patch.yml / settings.yaml）
 *
 * 与 dsh 的文件系统约定完全对齐（源码依据：`@deepseek-ai/dsh-app-boot`）：
 *  - `<profile>/package.json`：`{ name, private, dependencies, dsh: { profile: { bundles: [] } } }`
 *    （2 空格缩进 + 末尾换行）
 *  - `<profile>/cordis.patch.yml`：**用户 patch 层，必须是 `[]` 而不是空文件**，
 *    空的或只有注释的 patch 文件会导致启动失败，因此本模块只做"备份 + 整体改写"，
 *    不生成空文件。
 *  - 组合包（bundle）开关 = 改 `dsh.profile.bundles` 有序数组；
 *    patch 条目级的 `disabled` 属于插件管理器按 id 的处理范畴，本启动器不碰。
 */
import { rename } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import path from 'node:path';
import type { BundleEntry, InstanceMeta, PluginEntry, PluginInventory } from '../shared/contracts';
import { copyFileAtomic, listDir, pathExists, readJson, readText, writeJsonAtomic, writeTextAtomic } from './fsx';
import { enginePackageDir, instancePaths, sharedSettingsFile } from './paths';

/** profile 的 package.json 结构（只声明我们关心的字段，其余原样保留）。 */
export interface ProfileManifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: {
    profile?: {
      bundles?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 内置（随 dsh 安装提供）组合包所在目录。 */
const SCOPED_DIR = '@deepseek-ai';

/**
 * 读取 profile 清单。
 * @param profileDir profile 目录。
 * @returns 清单对象；文件不存在返回 `null`。
 */
export async function readProfileManifest(profileDir: string): Promise<ProfileManifest | null> {
  return readJson<ProfileManifest>(path.join(profileDir, 'package.json'));
}

/**
 * 写入 profile 清单（2 空格 JSON + 末尾换行，与 dsh 的 `writeProfileManifest` 一致）。
 * @param profileDir profile 目录。
 * @param manifest 清单对象。
 */
export async function writeProfileManifest(profileDir: string, manifest: ProfileManifest): Promise<void> {
  await writeJsonAtomic(path.join(profileDir, 'package.json'), manifest);
}

/**
 * 读取已启用的组合包列表（`dsh.profile.bundles`）。
 * @param manifest profile 清单。
 * @returns 有序组合包名数组。
 */
export function readBundles(manifest: ProfileManifest): string[] {
  const bundles = manifest.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 读取插件清单（组合包 + 普通依赖）。
 *
 * 组合包列表来自 `dsh.profile.bundles`；另外把 dsh 安装里**随附但未启用**的组合包
 * 也列出来（`enabled: false`），UI 才能把它们打开。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 插件清单。
 */
export async function readProfileInventory(root: string, meta: InstanceMeta): Promise<PluginInventory> {
  const paths = instancePaths(root, meta);
  const manifest = await readProfileManifest(paths.profileDir);
  if (manifest === null) {
    throw new Error(`profile 清单不存在：${path.join(paths.profileDir, 'package.json')}（实例可能未创建完成）`);
  }
  const enginePkg = enginePackageDir(root, meta.engine.version);
  const dependencies = manifest.dependencies ?? {};
  const enabled = readBundles(manifest);
  const bundles: BundleEntry[] = [];
  for (const name of enabled) {
    const described = await describeBundle(enginePkg, paths.profileDir, name);
    bundles.push({
      name,
      enabled: true,
      description: described.description,
      version: dependencies[name] ?? described.version,
      builtin: described.builtin,
    });
  }
  for (const name of await listInstallationBundles(enginePkg)) {
    if (enabled.includes(name)) continue;
    const described = await describeBundle(enginePkg, paths.profileDir, name);
    bundles.push({
      name,
      enabled: false,
      description: described.description,
      version: dependencies[name] ?? described.version,
      builtin: true,
    });
  }
  const plugins: PluginEntry[] = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    const installed = await readPackageVersion(path.join(paths.profileDir, 'node_modules', name));
    plugins.push({
      name,
      version: installed ?? spec,
      installed: installed !== null || (await pathExists(path.join(paths.profileDir, 'node_modules', name))),
      spec,
    });
  }
  return { bundles, dependencies: plugins, profileDir: paths.profileDir };
}

/**
 * 启用/禁用某个组合包（改 `dsh.profile.bundles` 有序数组）。
 *
 * 顺序即 patch 层叠加顺序（后者覆盖前者），因此**禁用时保持其余项相对顺序不变，
 * 启用时追加到末尾**（新组合包优先级最高，等价于 dsh 插件管理器的行为）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 组合包包名。
 * @param enabled 目标状态。
 */
export async function setBundleEnabled(root: string, meta: InstanceMeta, name: string, enabled: boolean): Promise<void> {
  const paths = instancePaths(root, meta);
  if (!isPackageName(name)) throw new Error(`组合包名不合法：${JSON.stringify(name)}`);
  const manifest = await readProfileManifest(paths.profileDir);
  if (manifest === null) throw new Error(`profile 清单不存在：${path.join(paths.profileDir, 'package.json')}`);
  const current = readBundles(manifest);
  if (enabled === current.includes(name)) return;
  const next = enabled ? [...current, name] : current.filter((item) => item !== name);
  const updated: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } },
  };
  await writeProfileManifest(paths.profileDir, updated);
}

/**
 * 换行归一：`\r\n` 与孤立的 `\r` 都变成 `\n`。
 *
 * 为什么必须在写入前做：WinUI 的 TextBox 用 `\r` 作段落分隔符，编辑器读入一份 CRLF 的
 * settings.yaml 再写回，落盘的就是"只有 \r、没有 \n"的文本。dsh 的 settings 用 `yaml`
 * 包解析，它**不把孤立的 \r 当换行**，整份文件被当成一行 → `BLOCK_AS_IMPLICIT_KEY`，
 * 实例每次启动都崩（KREA2 实测）。而 js-yaml 接受纯 CR，所以本模块原有的
 * `assertYaml` 拦不住这类损坏 —— 归一之后两个解析器看到的是同一份文本。
 * @param text YAML 文本。
 * @returns 换行统一为 `\n` 的文本。
 */
export function toLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * 读取实例设置（`<home>/settings.yaml`）。
 *
 * dsh 的 settings 是 home 级单文件，因此"实例设置"就是该实例 home 下的这一份文件。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns YAML 文本；文件不存在返回空字符串。
 */
export async function readInstanceSettings(root: string, meta: InstanceMeta): Promise<string> {
  const paths = instancePaths(root, meta);
  return (await readText(paths.settingsFile)) ?? '';
}

/**
 * 写入实例设置。
 *
 * 写入前用 js-yaml 解析校验，避免把语法错误的 YAML 落盘导致 dsh 启动失败。
 * `shared` 模式下先写共享文件再写实例副本（Windows 上文件级符号链接需要管理员权限，
 * 因此共享设置用"内容同步"实现，见 `instance.ts` 的 `applyShareModes`）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param yaml YAML 文本。
 */
export async function writeInstanceSettings(root: string, meta: InstanceMeta, yaml: string): Promise<void> {
  // 先归一换行再校验：CR 文本会被 js-yaml 放过、却被 dsh 的解析器拒绝（见 toLf）
  const text = toLf(yaml);
  assertYaml(text);
  const paths = instancePaths(root, meta);
  if (meta.settings.mode === 'shared') {
    const shared = sharedSettingsFile(root);
    await writeTextAtomic(shared, text);
  }
  await writeTextAtomic(paths.settingsFile, text);
}

/**
 * 备份 `cordis.patch.yml`（重命名为 `.bak-<毫秒>`，重名追加序号）。
 *
 * 调用前必须确保实例已停止（dsh 会热加载该文件）。
 * @param profileDir profile 目录。
 * @returns 备份路径；原文件不存在返回 `null`。
 */
export async function backupPatchFile(profileDir: string): Promise<string | null> {
  return backupFile(path.join(profileDir, 'cordis.patch.yml'));
}

/**
 * 备份任意文件（重命名为 `<原名>.bak-<毫秒>`，重名追加 `-1`、`-2`…）。
 *
 * 用于「覆盖前先留后路」的最后一道保险：本启动器的任何覆盖动作都不允许
 * 让用户数据无路可退。
 * @param file 目标文件。
 * @returns 备份路径；原文件不存在返回 `null`。
 */
export async function backupFile(file: string): Promise<string | null> {
  if (!(await pathExists(file))) return null;
  const base = `${file}.bak-${Date.now()}`;
  let target = base;
  let ordinal = 0;
  while (await pathExists(target)) target = `${base}-${++ordinal}`;
  await rename(file, target);
  return target;
}

/**
 * 备份"有内容"的文件（空文件不值得备份，避免堆一堆无意义的 `.bak`）。
 * @param file 目标文件。
 * @returns 备份路径；文件不存在或内容为空返回 `null`。
 */
export async function backupFileIfNotEmpty(file: string): Promise<string | null> {
  const text = await readText(file);
  if (text === null || text.trim().length === 0) return null;
  return backupFile(file);
}

/**
 * 读取 `cordis.patch.yml` 文本。
 * @param profileDir profile 目录。
 * @returns 文本内容或 `null`。
 */
export async function readPatchFile(profileDir: string): Promise<string | null> {
  return readText(path.join(profileDir, 'cordis.patch.yml'));
}

/**
 * 写入 `cordis.patch.yml`（**空内容会被拒绝**：dsh 要求它至少是 `[]`）。
 * @param profileDir profile 目录。
 * @param text YAML 文本。
 */
export async function writePatchFile(profileDir: string, text: string): Promise<void> {
  const yaml = toLf(text);
  if (yaml.trim().length === 0) {
    throw new Error('cordis.patch.yml 不能为空（dsh 要求至少写入 "[]"），已拒绝写入');
  }
  await writeTextAtomic(path.join(profileDir, 'cordis.patch.yml'), yaml);
}

/**
 * 把 profile 目录的 `package.json` 与 `cordis.patch.yml` 复制到别处（导出实例包用）。
 * @param profileDir 源 profile 目录。
 * @param targetDir 目标目录（通常是解压根下的 `home/profiles/<p>`）。
 * @returns 实际复制过去的相对文件名列表。
 */
export async function copyProfileFiles(profileDir: string, targetDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    if (await copyFileAtomic(path.join(profileDir, name), path.join(targetDir, name))) copied.push(name);
  }
  return copied;
}

/** 读取指定目录下某包的版本号；不存在返回 null。 */
async function readPackageVersion(packageDir: string): Promise<string | null> {
  const manifest = await readJson<{ version?: unknown }>(path.join(packageDir, 'package.json'));
  return manifest !== null && typeof manifest.version === 'string' ? manifest.version : null;
}

/** 扫描 dsh 安装里所有声明了 `dsh.bundle` 的组合包名。 */
async function listInstallationBundles(enginePkgDir: string): Promise<string[]> {
  const scopeDir = path.join(enginePkgDir, 'node_modules', SCOPED_DIR);
  const entries = await listDir(scopeDir);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifest = await readJson<{ dsh?: { bundle?: { patch?: unknown } } }>(path.join(scopeDir, entry.name, 'package.json'));
    if (manifest?.dsh?.bundle?.patch === undefined) continue;
    names.push(`${SCOPED_DIR}/${entry.name}`);
  }
  return names.sort();
}

/** 汇总某个包（在引擎里或 profile 里）的描述/版本/是否内置。 */
async function describeBundle(
  enginePkgDir: string,
  profileDir: string,
  name: string,
): Promise<{ description: string | null; version: string | null; builtin: boolean }> {
  const engineInfo = await readPackageMeta(path.join(enginePkgDir, 'node_modules', name));
  if (engineInfo !== null) {
    return { description: engineInfo.description, version: engineInfo.version, builtin: true };
  }
  const profileInfo = await readPackageMeta(path.join(profileDir, 'node_modules', name));
  if (profileInfo !== null) {
    return { description: profileInfo.description, version: profileInfo.version, builtin: false };
  }
  return { description: null, version: null, builtin: false };
}

/** 读取包的 description / version。 */
async function readPackageMeta(packageDir: string): Promise<{ description: string | null; version: string | null } | null> {
  const manifest = await readJson<{ description?: unknown; version?: unknown }>(path.join(packageDir, 'package.json'));
  if (manifest === null) return null;
  return {
    description: typeof manifest.description === 'string' ? manifest.description : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
  };
}

/**
 * 校验 YAML 文本是否可解析。
 *
 * 空文本视为合法（表示"无设置"）。
 * @param text YAML 文本。
 * @returns 合法返回 `null`，否则返回可读错误消息。
 */
export function validateYaml(text: string): string | null {
  if (text.trim().length === 0) return null;

  // 孤立的 CR 必须先拦下：js-yaml 接受它，dsh 的 `yaml` 解析器不接受 ——
  // 放过去就是"界面说合法、实例每次启动都崩"（见 toLf 的说明）
  if (/\r(?!\n)/.test(text)) {
    return '包含孤立的 CR（\\r）换行符：dsh 的 YAML 解析器不把它当换行，整份文件会被当成一行。请使用 LF 或 CRLF 换行。';
  }

  try {
    parseYaml(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 校验 YAML 语法（js-yaml 抛错即拒绝写入）。 */
function assertYaml(text: string): void {
  const problem = validateYaml(text);
  if (problem !== null) throw new Error(`YAML 语法错误，已拒绝写入：${problem}`);
}

/** 轻量 npm 包名校验（防止把奇怪字符串写进 bundles）。 */
function isPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i.test(name);
}
