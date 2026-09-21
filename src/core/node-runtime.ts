/**
 * WhalesLauncher core —— Node 运行时解析
 *
 * ### 为什么需要这个模块（真实缺陷复盘）
 * 启动器是 Electron 应用，主进程里 `process.execPath` 是 **electron.exe**，不是 node。
 * 早期实现直接用它（配 `ELECTRON_RUN_AS_NODE=1`）去跑 `dsh/lib/bin.js`，在多数情况下
 * 能"看起来能跑"，但 dsh 的 `node-addon-require-builtin` 原生模块需要在 V8 内部
 * 取到 `internal/modules/esm/loader` 等内建模块，而它的实现**按运行时指纹白名单**匹配：
 *
 * ```
 * Error: node-addon-require-builtin unsupported: Unsupported/no-context
 *   (unsupported Electron runtime fingerprint: Node 24.14.0,
 *    V8 14.6.202.26-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
 * ```
 *
 * 即：Electron 41 的运行时不在 dsh 支持列表内 → 实例启动必然失败（`--dump-config`
 * 这类不触发 profile 包解析的轻量命令是能过的，所以问题只在启动时才暴露）。
 *
 * 结论：**dsh 必须由真正的 Node.js 执行**（这也是 dsh CLI 的标准运行方式）。
 * 本模块负责在启动器进程里找到这样一个 Node：
 *
 * ```
 * 1. $WHALES_NODE_PATH       （排障/自动化用的显式覆盖）
 * 2. launcher.json 的 nodePath（界面可配，用户显式指定）
 * 3. 启动器自身进程           （开发模式下 `node scripts/launch.mjs` 就是真 node）
 * 4. 系统 PATH 上的 node.exe  （常规安装的 Node.js）
 * 5. 启动器自备运行时         （`<root>/runtime/node/node.exe`，首次启动自检下载的便携版）
 * 6. 常见安装位置             （PATH 未刷新/由 IDE 启动时的兜底）
 * ```
 *
 * 第 5 项是"零手动安装"的兜底：系统一个 Node 都没有时，首次启动自检会下载一份便携版
 * 放在启动器根下（见 `node-provision.ts`）；它排在系统 PATH **之后**，因此用户自己
 * 装好的 Node 仍然优先被沿用。判定成功后其所在目录会被登记为额外命令目录
 * （`proc.ts` 的 `setExtraCommandDirs`），让 `npm` / `pnpm` 一起被找到。
 *
 * 每个候选都会**实际跑一次探针**（`node -e` 打印 `process.versions`），只有
 * "不是 Electron" 且 "主版本 >= {@link MIN_NODE_MAJOR}" 的才算合格 —— 不做任何
 * 基于路径名的猜测，避免把 `electron.exe` 当成 node 用。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { NodeRuntimeCandidate, NodeRuntimeReport, NodeRuntimeSource } from '../shared/contracts';
import { LAUNCHER_CONFIG_FILE, portableNodeExe } from './paths';
import { runCapture, setExtraCommandDirs } from './proc';

/** 运行时来源（用于诊断展示；顺序即优先级）。 */
export type { NodeRuntimeCandidate, NodeRuntimeReport, NodeRuntimeSource };

/** dsh 引擎要求的最低 Node.js 主版本。 */
export const MIN_NODE_MAJOR = 20;

/** 探针脚本：只输出一行带前缀的 JSON，避免被 npm/node 警告污染。 */
const PROBE_PREFIX = 'WHALES_NODE_PROBE:';
const PROBE_SOURCE =
  `process.stdout.write(${JSON.stringify(PROBE_PREFIX)} + ` +
  'JSON.stringify({node: process.versions.node, electron: process.versions.electron ?? null}) + "\\n")';

/** 探针超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 来源的中文说明。 */
const SOURCE_LABELS: Record<NodeRuntimeSource, string> = {
  env: '环境变量 WHALES_NODE_PATH',
  config: '全局设置的 Node 运行时路径',
  current: '启动器自身进程',
  path: '系统 PATH',
  portable: '启动器自备运行时',
  common: '常见安装位置',
};

/** 解析结果缓存（key 含环境变量与显式配置，避免跨配置复用）。 */
const cache = new Map<string, NodeRuntimeReport>();

/**
 * 清空解析缓存。
 *
 * 供两处调用：用户在设置页改了路径 / 点了"重新检测"；测试需要隔离环境时。
 */
export function resetNodeRuntimeCache(): void {
  cache.clear();
}

/**
 * 解析可用的 Node.js 运行时。
 * @param options.root 启动器根目录（用于兜底读取 `launcher.json` 的 `nodePath`）。
 * @param options.configuredPath 全局设置里指定的 node 路径（显式传入时优先于文件）。
 * @param options.captureDir 探针降级落盘目录（受限环境用，见 `proc.ts`）。
 * @param options.refresh 为 true 时忽略缓存重新探测。
 * @returns 运行时报告（永不抛错；失败信息在 `message` 与 `candidates` 里）。
 */
export async function resolveNodeRuntime(
  options: {
    root?: string;
    configuredPath?: string | null;
    captureDir?: string;
    refresh?: boolean;
  } = {},
): Promise<NodeRuntimeReport> {
  const configured =
    normalizePath(options.configuredPath) ??
    (options.root === undefined ? null : readConfiguredNodePath(options.root));
  const fromEnv = normalizePath(process.env['WHALES_NODE_PATH']);
  const key = `${fromEnv ?? ''}\u0000${configured ?? ''}`;
  if (options.refresh !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }

  const candidates: NodeRuntimeCandidate[] = [];
  for (const candidate of collectCandidates(configured, fromEnv, options.root)) {
    candidates.push(await probe(candidate.file, candidate.source, options.captureDir));
    const last = candidates[candidates.length - 1] as NodeRuntimeCandidate;
    if (last.ok) {
      /*
       * 把这个运行时的目录登记为「额外命令目录」。
       *
       * 自备运行时（`<root>/runtime/node`，由首次自检下载）**不在系统 PATH 上** ——
       * 它是 C# 宿主用绝对路径拉起来的。不登记的话 `resolveCommand('npm')` 会在 PATH
       * 里一无所获，于是「引擎装不上、插件装不上、版本查不了」，而运行时其实就在手边。
       * 登记必须发生在**判定成功之后**：只有这里确知哪个 node 真的能跑。
       */
      setExtraCommandDirs([path.dirname(last.file)]);
      const report: NodeRuntimeReport = {
        ok: true,
        file: last.file,
        version: last.version,
        source: last.source,
        candidates,
        message: `使用 ${last.file}（Node v${String(last.version)}，来源：${SOURCE_LABELS[last.source]}）`,
      };
      cache.set(key, report);
      return report;
    }
  }

  // 一个可用的都没有：清空登记，避免把上一次结论里的目录继续喂给子进程 PATH。
  setExtraCommandDirs([]);

  const report: NodeRuntimeReport = {
    ok: false,
    file: null,
    version: null,
    source: null,
    candidates,
    message:
      `未找到可用的 Node.js 运行时：dsh 引擎必须由真正的 Node.js（>= ${MIN_NODE_MAJOR}）执行，` +
      'Electron 内置的 Node 运行时不受 dsh 原生模块支持（只识别特定 Electron 版本）。' +
      '请安装 Node.js，或在「全局设置 → Node 运行时」里手动指定 node.exe 的路径后重试。',
  };
  cache.set(key, report);
  return report;
}

/**
 * 生成一行人类可读的运行时说明（用于实例日志的 system 行）。
 * @param report 运行时报告。
 * @returns 形如 `Node v26.3.0（C:\Program Files\nodejs\node.exe，来源：系统 PATH）`。
 */
export function nodeRuntimeLabel(report: NodeRuntimeReport): string {
  if (!report.ok || report.file === null || report.version === null || report.source === null) {
    return '未找到可用的 Node.js 运行时';
  }
  return `Node v${report.version}（${report.file}，来源：${SOURCE_LABELS[report.source]}）`;
}

/**
 * 生成"候选结论"的多行文本（用于把失败原因展示给用户）。
 * @param report 运行时报告。
 * @returns 每行一个候选的结论。
 */
export function describeNodeCandidates(report: NodeRuntimeReport): string {
  if (report.candidates.length === 0) return '（未发现任何候选运行时）';
  return report.candidates
    .map((item) => {
      const label = SOURCE_LABELS[item.source];
      return item.ok
        ? `· ${item.file} —— 可用（Node v${String(item.version)}，${label}）`
        : `· ${item.file} —— 不可用：${String(item.reason)}（${label}）`;
    })
    .join('\n');
}

/**
 * 枚举候选运行时（已去重、已过滤掉不存在的路径）。
 * @param configured 全局设置里指定的路径。
 * @param fromEnv 环境变量里的路径。
 * @param root 启动器根目录（用于把自备运行时纳入候选；未提供时跳过该项）。
 * @returns 候选列表（顺序即优先级）。
 */
function collectCandidates(
  configured: string | null,
  fromEnv: string | null,
  root: string | undefined,
): Array<{ file: string; source: NodeRuntimeSource }> {
  const out: Array<{ file: string; source: NodeRuntimeSource }> = [];
  const seen = new Set<string>();
  const push = (file: string | null | undefined, source: NodeRuntimeSource): void => {
    if (file === null || file === undefined || file.length === 0) return;
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    /*
     * 显式来源（环境变量 / 全局设置）**即使路径不存在也要入列**：用户手填错了路径时，
     * 报告里必须能看到"这个路径不存在"，而不是被静默跳过、让人以为配置没生效。
     * 自动发现的候选（current/path/portable/common）才做存在性预过滤，避免噪音。
     */
    const explicit = source === 'env' || source === 'config';
    if (!explicit && !existsSync(resolved)) return;
    out.push({ file: resolved, source });
  };

  push(fromEnv, 'env');
  push(configured, 'config');
  push(process.execPath, 'current');
  for (const file of findOnPath()) push(file, 'path');
  /*
   * 自备运行时排在系统 PATH 之后、常见安装位置之前。
   *
   * 顺序的依据是"谁的优先级更高"：用户自己装好的 Node（PATH/常见位置）应当继续被沿用，
   * 自备运行时是**系统真的没有 Node 时的兜底**；但相比"猜测出来的安装位置"（nvm 符号
   * 链接、Volta 目录等），已经由启动器亲手铺设并验证过的自备运行时更确定。
   */
  if (root !== undefined) push(portableNodeExe(root), 'portable');
  for (const file of commonInstallPaths()) push(file, 'common');
  return out;
}

/**
 * 在 PATH 上查找 `node`。
 *
 * 只接受真正的可执行文件（Windows 上要求 `.exe`；`.cmd`/`.bat` 是 npm 的垫片，
 * 不能当运行时用），且必须是文件。
 * @returns 命中的绝对路径（可能多个 PATH 条目都命中，全部返回以生成完整诊断）。
 */
function findOnPath(): string[] {
  const out: string[] = [];
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((item) => item.length > 0);
  const names =
    process.platform === 'win32'
      ? ['node.exe']
      : ['node', 'nodejs'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * 常见安装位置（PATH 覆盖不到的兜底）。
 *
 * 覆盖：官方安装包、nvm-windows、Volta、fnm 的稳定入口，以及类 Unix 的常见前缀。
 * @returns 可能存在 node 的路径列表（不保证存在，调用方会过滤）。
 */
function commonInstallPaths(): string[] {
  const env = process.env;
  if (process.platform !== 'win32') {
    const home = env['HOME'] ?? '';
    return [
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/bin/node',
      home.length > 0 ? path.join(home, '.nvm/current/bin/node') : '',
      home.length > 0 ? path.join(home, '.volta/bin/node') : '',
    ].filter((item) => item.length > 0);
  }
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'] ?? '';
  const appData = env['APPDATA'] ?? '';
  const userProfile = env['USERPROFILE'] ?? '';
  const nvmSymlink = env['NVM_SYMLINK'] ?? '';
  return [
    path.join(programFiles, 'nodejs', 'node.exe'),
    path.join(programFilesX86, 'nodejs', 'node.exe'),
    localAppData.length > 0 ? path.join(localAppData, 'Programs', 'nodejs', 'node.exe') : '',
    // nvm-windows 的 current 符号链接
    appData.length > 0 ? path.join(appData, 'nvm', 'current', 'node.exe') : '',
    nvmSymlink.length > 0 ? path.join(nvmSymlink, 'node.exe') : '',
    // Volta / fnm 的稳定入口
    localAppData.length > 0 ? path.join(localAppData, 'Volta', 'bin', 'node.exe') : '',
    userProfile.length > 0 ? path.join(userProfile, '.volta', 'bin', 'node.exe') : '',
    localAppData.length > 0 ? path.join(localAppData, 'fnm', 'aliases', 'default', 'node.exe') : '',
    // 显式放在最后：也支持用环境变量指向任意位置
    env['WHALES_NODE_HOME'] ? path.join(env['WHALES_NODE_HOME'], 'node.exe') : '',
  ].filter((item) => item.length > 0);
}

/**
 * 判定的纯函数形态：只吃探针的原始输出，产出结论。
 *
 * 抽出来的意义：**"Electron 运行时不可用"与"版本过低"这两条关键判定必须可被单测
 * 直接打到**（真机上无法在测试进程里伪造 `process.versions.electron`）。
 * @param stdout 探针标准输出。
 * @param stderr 探针标准错误。
 * @param code 退出码。
 * @returns 判定结论。
 */
export function classifyProbe(
  stdout: string,
  stderr: string,
  code: number | null,
): { ok: boolean; version: string | null; electron: string | null; reason: string | null } {
  const line = (stdout ?? '')
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith(PROBE_PREFIX));
  if (line === undefined) {
    const detail = tail(stderr || stdout);
    return {
      ok: false,
      version: null,
      electron: null,
      reason: `探针未返回结果（退出码 ${String(code)}）${detail.length > 0 ? `：${detail}` : ''}`,
    };
  }
  let parsed: { node?: unknown; electron?: unknown };
  try {
    parsed = JSON.parse(line.slice(PROBE_PREFIX.length)) as { node?: unknown; electron?: unknown };
  } catch {
    return { ok: false, version: null, electron: null, reason: `探针输出无法解析：${line.slice(0, 200)}` };
  }
  const version = typeof parsed.node === 'string' ? parsed.node : null;
  const electron = typeof parsed.electron === 'string' ? parsed.electron : null;
  if (version === null) return { ok: false, version: null, electron, reason: '探针未报告 Node 版本' };
  if (electron !== null) {
    return {
      ok: false,
      version,
      electron,
      reason:
        `这是 Electron ${electron} 内置的 Node 运行时（Node v${version}），dsh 的原生模块不支持` +
        '（只识别特定 Electron 版本），必须使用独立的 Node.js',
    };
  }
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      version,
      electron: null,
      reason: `Node.js 版本过低（v${version}），dsh 需要 >= v${MIN_NODE_MAJOR}`,
    };
  }
  return { ok: true, version, electron: null, reason: null };
}

/**
 * 对一个候选路径跑探针并给出结论。
 * @param file 候选可执行文件。
 * @param source 来源标记。
 * @param captureDir 探针降级落盘目录。
 * @returns 探测结论。
 */
async function probe(
  file: string,
  source: NodeRuntimeSource,
  captureDir: string | undefined,
): Promise<NodeRuntimeCandidate> {
  const fail = (reason: string): NodeRuntimeCandidate => ({
    file,
    source,
    ok: false,
    version: null,
    electron: null,
    reason,
  });
  if (!isFile(file)) return fail('文件不存在或不是可执行文件');
  let result: Awaited<ReturnType<typeof runCapture>>;
  try {
    result = await runCapture(file, ['-e', PROBE_SOURCE], {
      timeoutMs: PROBE_TIMEOUT_MS,
      captureDir,
      // 探针必须看到"裸"的运行时：清掉可能让子进程变成 Electron/被注入预载的环境变量
      env: { ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`无法执行：${message}`);
  }
  const verdict = classifyProbe(result.stdout ?? '', result.stderr ?? '', result.code);
  return {
    file,
    source,
    ok: verdict.ok,
    version: verdict.version,
    electron: verdict.electron,
    reason: verdict.reason,
  };
}

/** 同步判断是否为已存在的文件。 */
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 取文本尾部若干行（错误摘要用）。 */
function tail(text: string, lines = 3): string {
  const parts = text.trim().split(/\r?\n/).filter((item) => item.length > 0);
  return parts.slice(Math.max(0, parts.length - lines)).join(' / ').slice(0, 400);
}

/** 归一化路径（去空白；空串视作未提供）。 */
function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 从 `launcher.json` 兜底读取用户配置的 Node 路径。
 *
 * 存在的意义：`createInstance`（profile 初始化）在契约上拿不到 `LauncherConfig`，
 * 却同样需要 Node 来执行 `dsh --dump-config`。读同一份配置文件是唯一不扩大契约的
 * 方案。任何异常（缺失 / 损坏 / 字段非字符串）都按"未配置"处理 —— 配置只影响
 * 候选顺序，是否可用**一律由探针判定**。
 * @param root 启动器根目录。
 * @returns 配置的路径；未配置或非法时返回 null。
 */
function readConfiguredNodePath(root: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, LAUNCHER_CONFIG_FILE), 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return normalizePath((raw as Record<string, unknown>)['nodePath'] as string | undefined);
  } catch {
    return null;
  }
}
