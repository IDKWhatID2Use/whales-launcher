/**
 * WhalesLauncher core —— 实例包（整合包）导入导出
 *
 * 包格式（架构文档 §5.5）：
 * ```
 * whalelauncher-pack.json           包元数据 + 实例元数据 + 依赖清单
 * home/profiles/<p>/package.json    profile 清单（组合包列表 + 依赖）
 * home/profiles/<p>/cordis.patch.yml 用户 patch 层
 * home/settings.yaml                实例设置（有内容才带）
 * README.md                         说明
 * ```
 * **不含 `node_modules`**（与 PCL2 整合包同样的取舍），导入时按 manifest 重装依赖。
 *
 * 解压采用手工逐条目写入并校验路径（拒绝绝对路径与 `..`），不使用
 * `extractAllTo`，避免 zip-slip 把文件写到目标目录之外。
 */
import AdmZip from 'adm-zip';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUNDLE_TEMPLATES,
  SCHEMA_VERSION,
  type ImportResult,
  type InstanceMeta,
  type LauncherConfig,
  type LogSink,
  type PackManifest,
} from '../shared/contracts';
import { createInstance, listInstances, readInstance, updateInstance } from './instance';
import { ensureDir, pathExists, readJson, readText, removeDir, writeTextAtomic } from './fsx';
import { makeDirName, validateName } from './names';
import { corePaths, instancePaths } from './paths';
import { listEngines } from './engine';
import { pluginAdd } from './plugins';
import { readBundles, readProfileManifest, writeProfileManifest, validateYaml, type ProfileManifest } from './profile';

/** 包元数据文件名。 */
export const PACK_MANIFEST_NAME = 'whalelauncher-pack.json';

/**
 * 导出实例包（zip）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param outFile 目标 zip 绝对路径。
 * @param launcherVersion 启动器版本号（写入包元数据）。
 * @returns 实际写出的 zip 路径。
 */
export async function exportPack(
  root: string,
  meta: InstanceMeta,
  outFile: string,
  launcherVersion: string,
): Promise<string> {
  const paths = instancePaths(root, meta);
  const manifest = await readProfileManifest(paths.profileDir);
  if (manifest === null) throw new Error(`profile 清单不存在，无法导出：${paths.profileDir}`);
  const requirements = sanitizeRequirements(manifest.dependencies ?? {});
  const bundles = readBundles(manifest);
  const pack: PackManifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'whalelauncher-pack',
    exportedAt: new Date().toISOString(),
    launcherVersion,
    instance: {
      name: meta.name,
      icon: meta.icon,
      color: meta.color,
      note: meta.note,
      engine: meta.engine,
      profile: meta.profile,
      launch: meta.launch,
    },
    requirements,
    bundles,
  };
  const zip = new AdmZip();
  zip.addFile(PACK_MANIFEST_NAME, Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8'));
  const packageJson = await readText(path.join(paths.profileDir, 'package.json'));
  if (packageJson !== null) zip.addFile(`home/profiles/${meta.profile.name}/package.json`, Buffer.from(packageJson, 'utf8'));
  const patch = await readText(path.join(paths.profileDir, 'cordis.patch.yml'));
  if (patch !== null && patch.trim().length > 0) {
    zip.addFile(`home/profiles/${meta.profile.name}/cordis.patch.yml`, Buffer.from(patch, 'utf8'));
  }
  const settings = await readText(paths.settingsFile);
  if (settings !== null && settings.trim().length > 0) zip.addFile('home/settings.yaml', Buffer.from(settings, 'utf8'));
  zip.addFile('README.md', Buffer.from(renderReadme(pack), 'utf8'));
  await ensureDir(path.dirname(outFile));
  zip.writeZip(outFile);
  return outFile;
}

/**
 * 导入实例包。
 *
 * 流程：读包元数据 → 校验 schema → 解压到 `<root>/cache` 下的临时目录 →
 * 创建实例（profile 初始化走黄金路径）→ 还原 patch/设置/依赖清单 →
 * 按 manifest 重装依赖（失败只记警告，不阻断导入）。
 * @param root 启动器根目录。
 * @param zipFile 包文件路径。
 * @param config 启动器全局设置。
 * @param hooks 日志回调。
 * @returns 导入结果（新实例 id、显示名、警告列表）。
 */
export async function importPack(
  root: string,
  zipFile: string,
  config: LauncherConfig,
  hooks: { onLog?: LogSink } = {},
): Promise<ImportResult> {
  const onLog = hooks.onLog;
  const warnings: string[] = [];
  if (!(await pathExists(zipFile))) throw new Error(`包文件不存在：${zipFile}`);
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipFile);
  } catch (error) {
    throw new Error(`无法读取实例包：${zipFile} —— ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifestEntry = zip.getEntries().find((entry) => path.basename(entry.entryName) === PACK_MANIFEST_NAME);
  if (manifestEntry === undefined) throw new Error(`不是有效的实例包（缺少 ${PACK_MANIFEST_NAME}）：${zipFile}`);
  const raw: unknown = JSON.parse(manifestEntry.getData().toString('utf8'));
  const pack = parsePackManifest(raw);

  const staged = path.join(corePaths(root).cacheDir, `import-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  try {
    await ensureDir(staged);
    await extractEntries(zip, staged);
    const sourceProfileDir = path.join(staged, 'home', 'profiles', pack.instance.profile.name);
    const sourceProfile = await readProfileManifest(sourceProfileDir);

    const installed = await listEngines(root);
    let engineVersion = pack.instance.engine.version;
    if (!installed.some((item) => item.version === engineVersion && item.installed)) {
      const fallback = installed.find((item) => item.installed);
      if (fallback === undefined) throw new Error(`引擎 ${engineVersion} 未安装，且本地没有任何可用引擎，无法导入`);
      warnings.push(`引擎 ${engineVersion} 未安装，已改用本地引擎 ${fallback.version}`);
      engineVersion = fallback.version;
    }
    const template = Object.hasOwn(BUNDLE_TEMPLATES, pack.instance.profile.template) ? pack.instance.profile.template : 'web';
    if (template !== pack.instance.profile.template) warnings.push(`未知模板 ${pack.instance.profile.template}，已回退为 web`);

    const taken = (await listInstances(root)).map((item) => item.meta.dirName);
    const name = pack.instance.name.trim().length > 0 ? pack.instance.name.trim() : '导入实例';
    const dirName = makeDirName(name, taken);
    const meta = await createInstance(
      root,
      {
        name,
        dirName,
        icon: pack.instance.icon,
        color: pack.instance.color,
        note: pack.instance.note,
        engineVersion,
        template,
        saves: 'local',
        settings: 'local',
        credentials: 'inherit',
      },
      { onLog },
    );
    const paths = instancePaths(root, meta);

    // 1) 还原本地恢复出的 package.json（依赖 + 组合包，顺序保持）
    const merged: ProfileManifest = {
      ...(sourceProfile ?? {}),
      name: `dsh-profile-${meta.dirName}`,
      private: true,
      dependencies: { ...(sourceProfile?.dependencies ?? {}), ...pack.requirements },
      dsh: {
        ...(sourceProfile?.dsh ?? {}),
        profile: {
          ...(sourceProfile?.dsh?.profile ?? {}),
          bundles: pack.bundles.length > 0 ? [...pack.bundles] : readBundles(sourceProfile ?? {}),
        },
      },
    };
    await writeProfileManifest(paths.profileDir, merged);

    // 2) 还原用户 patch 层（整块覆盖：patch 语义就是整块替换）
    const patch = await readText(path.join(sourceProfileDir, 'cordis.patch.yml'));
    if (patch !== null && patch.trim().length > 0) {
      await writeTextAtomic(path.join(paths.profileDir, 'cordis.patch.yml'), patch);
    }

    // 3) 还原实例设置（写入实例自己的 settings.yaml）
    //    必须**先校验 YAML**：坏配置一旦落盘，该实例之后启动必然失败
    const settings = await readText(path.join(staged, 'home', 'settings.yaml'));
    if (settings !== null && settings.trim().length > 0) {
      const yamlProblem = validateYaml(settings);
      if (yamlProblem !== null) {
        const message = `home/settings.yaml 未还原（YAML 不合法：${yamlProblem}）`;
        warnings.push(message);
        onLog?.('system', `[import] ${message}\n`);
      } else {
        await writeTextAtomic(paths.settingsFile, settings);
      }
    }

    // 4) 按 manifest 重装依赖（失败不阻断导入）
    const packages = Object.entries(pack.requirements);
    for (const [packageName, range] of packages) {
      const spec = range.trim().length > 0 && range !== '*' ? `${packageName}@${range}` : packageName;
      try {
        onLog?.('system', `[import] 重装依赖 ${spec}\n`);
        await pluginAdd(root, meta, spec, config, onLog);
      } catch (error) {
        const message = `${spec} 安装失败：${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        onLog?.('system', `[import] ${message}\n`);
      }
    }
    const refreshed = (await readInstance(root, meta.id)) ?? meta;
    if (refreshed.launch.appArgs.length === 0 && pack.instance.launch.appArgs.length > 0) {
      await updateInstance(root, meta.id, {
        appArgs: pack.instance.launch.appArgs,
        autoOpenBrowser: pack.instance.launch.autoOpenBrowser,
      });
    }
    return { instanceId: meta.id, name: meta.name, warnings };
  } finally {
    await removeDir(staged).catch(() => undefined);
  }
}

/**
 * 读取实例包元数据（不导入，供 UI 预览用）。
 * @param zipFile 包文件路径。
 * @returns 包元数据。
 */
export async function readPackManifest(zipFile: string): Promise<PackManifest> {
  const zip = new AdmZip(zipFile);
  const entry = zip.getEntries().find((item) => path.basename(item.entryName) === PACK_MANIFEST_NAME);
  if (entry === undefined) throw new Error(`不是有效的实例包（缺少 ${PACK_MANIFEST_NAME}）：${zipFile}`);
  return parsePackManifest(JSON.parse(entry.getData().toString('utf8')));
}

/** 把解压后的条目逐个写盘，拒绝越界路径。 */
async function extractEntries(zip: AdmZip, root: string): Promise<void> {
  const rootResolved = path.resolve(root);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const segments = entry.entryName.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
    if (segments.length === 0 || segments.some((segment) => segment === '..' || /^[A-Za-z]:$/.test(segment))) {
      throw new Error(`包内含越界路径，已拒绝解压：${entry.entryName}`);
    }
    const target = path.resolve(rootResolved, ...segments);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new Error(`包内含越界路径，已拒绝解压：${entry.entryName}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.getData());
  }
}

/** 解析并校验包元数据。 */
function parsePackManifest(raw: unknown): PackManifest {
  if (raw === null || typeof raw !== 'object') throw new Error('实例包元数据格式错误');
  const value = raw as Partial<PackManifest>;
  if (value.kind !== 'whalelauncher-pack') throw new Error(`不是 WhalesLauncher 实例包（kind=${String(value.kind)}）`);
  if (typeof value.schemaVersion !== 'number') throw new Error('实例包缺少 schemaVersion');
  if (value.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`实例包版本过新（schemaVersion=${value.schemaVersion}，当前支持 ${SCHEMA_VERSION}），请升级启动器`);
  }
  const instance = value.instance;
  if (instance === null || typeof instance !== 'object') throw new Error('实例包缺少实例元数据');
  const profileName = instance.profile?.name ?? 'main';
  if (validateName(profileName) !== null) throw new Error(`实例包内 profile 名不合法：${profileName}`);
  return {
    schemaVersion: value.schemaVersion,
    kind: 'whalelauncher-pack',
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : new Date(0).toISOString(),
    launcherVersion: typeof value.launcherVersion === 'string' ? value.launcherVersion : '0.0.0',
    instance: {
      name: typeof instance.name === 'string' ? instance.name : '导入实例',
      icon: typeof instance.icon === 'string' ? instance.icon : null,
      color: typeof instance.color === 'string' ? instance.color : '#5B8DEF',
      note: typeof instance.note === 'string' ? instance.note : '',
      engine: { version: typeof instance.engine?.version === 'string' ? instance.engine.version : '0.0.0' },
      profile: {
        name: profileName,
        template: typeof instance.profile?.template === 'string' ? instance.profile.template : 'web',
      },
      launch: {
        appArgs: Array.isArray(instance.launch?.appArgs) ? instance.launch.appArgs.filter((item): item is string => typeof item === 'string') : [],
        autoOpenBrowser: typeof instance.launch?.autoOpenBrowser === 'boolean' ? instance.launch.autoOpenBrowser : true,
      },
    },
    requirements: sanitizeRequirements(value.requirements ?? {}),
    bundles: Array.isArray(value.bundles) ? value.bundles.filter((item): item is string => typeof item === 'string') : [],
  };
}

/** 过滤掉非法的依赖项。 */
function sanitizeRequirements(input: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(input)) {
    if (typeof name !== 'string' || !isDependencyName(name)) continue;
    result[name.trim()] = typeof range === 'string' && range.trim().length > 0 ? range.trim() : '*';
  }
  return result;
}

/** npm 包名（含 scope）校验。 */
function isDependencyName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i.test(name.trim());
}

/** 生成包内 README。 */
function renderReadme(pack: PackManifest): string {
  const lines = [
    `# ${pack.instance.name}（WhalesLauncher 实例包）`,
    '',
    `- 导出时间：${pack.exportedAt}`,
    `- 启动器版本：${pack.launcherVersion}`,
    `- 引擎版本：${pack.instance.engine.version}`,
    `- profile：${pack.instance.profile.name}（模板 ${pack.instance.profile.template}）`,
    '',
    '## 组合包',
    '',
    ...(pack.bundles.length > 0 ? pack.bundles.map((item) => `- ${item}`) : ['- （无）']),
    '',
    '## 依赖（导入时自动重装）',
    '',
    ...(Object.keys(pack.requirements).length > 0
      ? Object.entries(pack.requirements).map(([name, range]) => `- ${name}@${range}`)
      : ['- （无）']),
    '',
    '> 本包不含 `node_modules`，导入时按上面的依赖清单重装。',
    '',
  ];
  return lines.join('\n');
}
