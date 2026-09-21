/**
 * WhalesLauncher core —— 插件增删
 *
 * **一律走 `dsh plugin --profile <p> …`**，不自己改 pnpm 状态（架构文档 D4）：
 * `dsh plugin` 与插件管理器共享同一条包操作路径与 profile 写锁，绕过它会造成状态不一致。
 *
 * 本机实测：`dsh plugin --profile <p> add <pkg> --config.cache=<dir>` 可正常透传
 * （pnpm 10.33.0，EXIT=0），且首次使用会自动用 `@deepseek-ai/dsh-base` 初始化 profile。
 *
 * pnpm/npm 的 cache 处理是双保险（命令行 `--config.cache=` + 环境变量
 * `npm_config_cache`）：本机环境变量把 cache 指向工作区外，而 npm 配置优先级是
 * 命令行 > 环境变量 > 项目 .npmrc，只做一边仍会触发沙箱 EPERM。
 */
import type { InstanceMeta, LauncherConfig, LogSink } from '../shared/contracts';
import { resolveEngineBin } from './engine';
import { nodeRuntimeLabel, resolveNodeRuntime } from './node-runtime';
import { instancePaths, childBaseEnv, corePaths, pnpmCacheArgs } from './paths';
import { runCapture, type ProcLogSink } from './proc';

/** 插件安装/卸载超时（首次装插件要拉依赖）。 */
const PLUGIN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 安装一个插件到实例 profile。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param spec npm 包名或 `name@version` 形式。
 * @param config 启动器全局设置（保留参数，便于后续接入私有 registry）。
 * @param onLog 日志回调。
 * @throws 包名非法 / 引擎缺失 / pnpm 失败。
 */
export async function pluginAdd(
  root: string,
  meta: InstanceMeta,
  spec: string,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<void> {
  assertSpec(spec);
  await runPluginCommand(root, meta, ['add', spec], config, onLog);
}

/**
 * 从实例 profile 卸载一个插件。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name npm 包名。
 * @param config 启动器全局设置（保留参数）。
 * @param onLog 日志回调。
 * @throws 包名非法 / 引擎缺失 / pnpm 失败。
 */
export async function pluginRemove(
  root: string,
  meta: InstanceMeta,
  name: string,
  config: LauncherConfig,
  onLog?: LogSink,
): Promise<void> {
  assertSpec(name);
  await runPluginCommand(root, meta, ['remove', name], config, onLog);
}

/**
 * 读取 profile 的 `pnpm why` 输出（诊断用，非契约方法）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param name 包名。
 * @returns 命令输出。
 */
export async function pluginWhy(root: string, meta: InstanceMeta, name: string): Promise<string> {
  assertSpec(name);
  const result = await runPluginCommand(root, meta, ['why', name], undefined, undefined);
  return result;
}

/** 执行 `dsh plugin` 并校验退出码。 */
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
  // `dsh plugin` 同样会加载 profile 包树，因此也必须由真正的 Node.js 执行（见 node-runtime.ts）
  const node = await resolveNodeRuntime({
    configuredPath: config?.nodePath ?? null,
    captureDir: corePaths(root).cacheDir,
  });
  if (!node.ok) throw new Error(node.message);
  const args = ['plugin', '--profile', meta.profile.name, ...pnpmArgs, ...pnpmCacheArgs(root)];
  onLog?.('system', `dsh plugin --profile ${meta.profile.name} ${pnpmArgs.join(' ')}（${nodeRuntimeLabel(node)}）\n`);
  const result = await runCapture(String(node.file), [binPath, ...args], {
    cwd: paths.root,
    env: { DSH_HOME: paths.home, ...childBaseEnv(root) },
    onLog,
    timeoutMs: PLUGIN_TIMEOUT_MS,
    captureDir: corePaths(root).cacheDir,
  });
  if (result.code !== 0) {
    if (result.code === 127) {
      throw new Error('未找到 pnpm：请安装 pnpm 并确保它在 PATH 中（dsh plugin 依赖 pnpm）');
    }
    throw new Error(`插件操作失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

/** 校验包名/规格，拒绝会破坏命令行的字符。 */
function assertSpec(spec: string): void {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new Error('包名不能为空');
  if (trimmed.length > 214) throw new Error('包名过长');
  if (/[\s"'`%&|<>^$;(){}[\]\\]/.test(trimmed)) {
    throw new Error(`包名包含非法字符：${JSON.stringify(spec)}`);
  }
  if (!/^(?:@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*(?:@[\w.^~><=*+-]+)?$/i.test(trimmed)) {
    throw new Error(`包名格式不合法：${JSON.stringify(spec)}（示例：some-plugin 或 some-plugin@1.2.3）`);
  }
}

/** 取输出尾部若干行。 */
function tail(text: string, lines = 12): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}
