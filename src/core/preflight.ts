/**
 * WhalesLauncher core —— 环境与依赖自检（preflight）
 *
 * ### 这个模块解决什么问题
 * 一份全新拉起来的启动器，要能真的干活需要这些东西同时到位：
 *
 * | 依赖 | 缺失时的表现 | 本模块的动作 |
 * |---|---|---|
 * | 数据目录（instances / engines / shared / cache） | 建实例、装引擎直接报错 | **自动创建**（含写探针） |
 * | 全局配置 `launcher.json` | 只影响偏好，桥接层会自愈 | 只读校验 + 如实报告 |
 * | 真正的 Node.js（>= 20） | 实例起不来（dsh 原生模块拒绝 Electron 运行时） | 复用 `node-runtime` 探测；缺失时引导（便携版由宿主侧下载） |
 * | npm | 引擎装不上、插件装不上、版本查不了 | 实跑 `npm -v` 验证 |
 * | 一个 dsh 引擎版本 | 建不了实例（向导第一步就卡住） | **自动安装** registry 的 `latest` |
 * | 能访问 npm registry | 上面两件事都会失败 | 可选联网探测（默认只在首次自检做） |
 *
 * ### 两条设计原则
 *  1. **结论必须来自实跑，不来自路径名或假设**。node 复用 `node-runtime.ts` 的探针；
 *     npm 真的执行一次 `npm -v`；可写性真的写一个文件再删掉。
 *  2. **能自动修的自动修，修不了的说清楚下一步**。每项都带 `status` 与 `advice`，
 *     界面据此显示"已自动修复了什么"和"还需要你做什么"，杜绝"报错了但不知道怎么办"。
 *
 * ### 与"首次启动"的边界
 * 首次/非首次的**判据是 `<root>/cache/preflight.json` 是否存在**，刻意**不**写进
 * `launcher.json`：那是用户配置（契约冻结、且界面逐字段保存），而"上次自检是什么时候"
 * 属于可丢弃的运行时状态。用户清掉 cache 只会让自检多跑一次（幂等），不会损坏任何东西。
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { SCHEMA_VERSION } from '../shared/contracts';
import type {
  PreflightCheck,
  PreflightOptions,
  PreflightReport,
  PreflightStatus,
} from '../shared/contracts';
import {
  DEFAULT_ENGINE_REGISTRY,
  QUICK_NPM_QUERY,
  installEngine,
  latestEngineVersion,
  listEngines,
} from './engine';
import { ensureDir, pathExists, readJson, writeJsonAtomic, writeTextAtomic } from './fsx';
import { LAUNCHER_CONFIG_FILE, childBaseEnv, corePaths, portableNodeExe } from './paths';
import { describeNodeCandidates, resolveNodeRuntime } from './node-runtime';
import { resolveCommand, runCapture, type ProcLogSink } from './proc';

/** 自检状态文件名（位于 `<root>/cache/` 下）。 */
export const PREFLIGHT_STATE_FILE = 'preflight.json';

/** 自检状态文件的 schema 版本。 */
export const PREFLIGHT_STATE_SCHEMA = 1;

/** `npm -v` 的超时（首次调用可能触发 npm 自身的缓存初始化）。 */
const NPM_PROBE_TIMEOUT_MS = 90_000;

/**
 * registry 连通性探测的超时。
 *
 * 8 秒是"够慢网络完成一次 TLS 握手 + HEAD"与"不让用户干等"之间的取值：
 * 网络真的不通时，用户 8 秒后就能看到"不可达 + 怎么办"，而不是等到 npm 重试完。
 */
const REGISTRY_PROBE_TIMEOUT_MS = 8_000;

/** 写探针的文件名（用完即删，绝不留在用户目录里）。 */
const WRITE_PROBE_FILE = '.whales-write-probe';

/**
 * 自检的持久化状态（`<root>/cache/preflight.json`）。
 *
 * 只用于回答两个问题：**这是不是首次自检**、**上次结论如何**。任何字段读不出来都
 * 按"没有状态文件"处理 —— 自检本身绝不能因为这份记账文件损坏而失败。
 */
export interface PreflightState {
  schemaVersion: number;
  /** 首次自检完成时刻（ISO 8601）。 */
  firstRunAt: string;
  /** 最近一次自检完成时刻（ISO 8601）。 */
  lastRunAt: string;
  /** 累计自检次数（含首次）。 */
  runCount: number;
  /** 最近一次是否**没有遗留问题**。 */
  lastOk: boolean;
  /** 最近一次遗留的问题项数量。 */
  lastProblemCount: number;
  /** 最近一次自动安装的引擎版本（没有则为 null）。 */
  lastInstalledEngine: string | null;
}

/** 结论的状态取值说明（供界面与日志复用，避免各处各写一套中文）。 */
export const PREFLIGHT_STATUS_LABELS: Record<PreflightStatus, string> = {
  ok: '正常',
  fixed: '已自动修复',
  missing: '缺失',
  failed: '失败',
  skipped: '未检查',
};

/**
 * 读取自检状态。
 * @param root 启动器根目录。
 * @returns 状态对象；不存在或不可解析时返回 `null`（**不抛错**）。
 */
export async function readPreflightState(root: string): Promise<PreflightState | null> {
  try {
    const raw = await readJson<Partial<PreflightState>>(stateFilePath(root));
    if (raw === null || typeof raw !== 'object') return null;
    const runCount = typeof raw.runCount === 'number' && Number.isFinite(raw.runCount) ? raw.runCount : 0;
    const firstRunAt = typeof raw.firstRunAt === 'string' ? raw.firstRunAt : '';
    const lastRunAt = typeof raw.lastRunAt === 'string' ? raw.lastRunAt : '';
    if (runCount <= 0 || firstRunAt.length === 0) return null;
    return {
      schemaVersion: PREFLIGHT_STATE_SCHEMA,
      firstRunAt,
      lastRunAt: lastRunAt.length > 0 ? lastRunAt : firstRunAt,
      runCount,
      lastOk: raw.lastOk === true,
      lastProblemCount:
        typeof raw.lastProblemCount === 'number' && Number.isFinite(raw.lastProblemCount)
          ? raw.lastProblemCount
          : 0,
      lastInstalledEngine:
        typeof raw.lastInstalledEngine === 'string' && raw.lastInstalledEngine.length > 0
          ? raw.lastInstalledEngine
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * 运行一次环境自检。
 *
 * **单飞**：同一时刻只允许一次自检在跑（界面连点按钮、首次启动与手动自检撞车时，
 * 直接复用同一次结果而不是并发跑两遍 npm / 两遍引擎安装）。
 * @param root 启动器根目录。
 * @param options 自检选项（见契约 `PreflightOptions`）。
 * @param onLog 日志下沉（长耗时步骤如引擎安装会实时输出，供界面日志抽屉展示）。
 * @returns 自检报告（**永不抛错**：任何单项异常都落成该项的 `failed`）。
 */
export async function runPreflight(
  root: string,
  options: PreflightOptions = {},
  onLog?: ProcLogSink,
): Promise<PreflightReport> {
  const key = root;
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const task = runPreflightInternal(root, options, onLog).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

/** 进行中的自检（按根目录去重）。 */
const inFlight = new Map<string, Promise<PreflightReport>>();

/**
 * 自检主体。
 * @param root 启动器根目录。
 * @param options 自检选项。
 * @param onLog 日志下沉。
 * @returns 自检报告。
 */
async function runPreflightInternal(
  root: string,
  options: PreflightOptions,
  onLog?: ProcLogSink,
): Promise<PreflightReport> {
  const startedAt = new Date();
  const autoFix = options.autoFix !== false;
  const installEngineAllowed = options.installEngine === true && autoFix;
  // 刻意不叫 checkNetwork：那会遮蔽同名函数（checkNetwork 是检查项实现）
  const networkCheckEnabled = options.checkNetwork === true;
  const refreshRuntime = options.refreshRuntime === true;

  const previous = await readPreflightState(root);
  const firstRun = previous === null;

  const checks: PreflightCheck[] = [];
  checks.push(await checkRuntimeDirs(root, autoFix));
  checks.push(await checkConfig(root));

  const nodeReport = await resolveNodeRuntime({
    root,
    captureDir: corePaths(root).cacheDir,
    refresh: refreshRuntime,
  });
  checks.push(nodeCheck(root, nodeReport));
  checks.push(await checkNpm(root, nodeReport.ok));
  checks.push(await checkEngine(root, { autoFix, installEngine: installEngineAllowed, onLog }, options));
  checks.push(await checkNetwork(root, networkCheckEnabled, options.registry));

  const finishedAt = new Date();
  const problemCount = checks.filter((item) => item.status === 'missing' || item.status === 'failed').length;
  const fixedCount = checks.filter((item) => item.status === 'fixed').length;
  const installedEngine = checks.find((item) => item.id === 'engine')?.fixedValue ?? null;

  const report: PreflightReport = {
    firstRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    root,
    checks,
    ok: problemCount === 0,
    fixedCount,
    problemCount,
    installedEngineVersion: installedEngine,
    message: summarize(firstRun, checks, fixedCount, problemCount),
  };

  await writeState(root, previous, report).catch(() => undefined);
  return report;
}

/**
 * 生成面向用户的一句话总结论。
 *
 * 措辞上刻意**不说"环境正常"**：自检只覆盖它检查过的那些项，把它写成保证会误导用户
 * （视觉规范 §9.4「禁止假保证式文案」）。
 * @param firstRun 是否首次自检。
 * @param checks 全部检查项。
 * @param fixedCount 自动修复项数。
 * @param problemCount 遗留问题项数。
 * @returns 一句话结论。
 */
function summarize(
  firstRun: boolean,
  checks: PreflightCheck[],
  fixedCount: number,
  problemCount: number,
): string {
  const prefix = firstRun ? '首次环境自检完成' : '环境自检完成';
  if (problemCount > 0) {
    const names = checks
      .filter((item) => item.status === 'missing' || item.status === 'failed')
      .map((item) => item.title)
      .join('、');
    return `${prefix}：${problemCount} 项需要处理（${names}）${fixedCount > 0 ? `，另有 ${fixedCount} 项已自动修复。` : '。'}`;
  }
  if (fixedCount > 0) return `${prefix}：已自动修复 ${fixedCount} 项，未发现其它问题。`;
  return `${prefix}：未发现需要处理的问题。`;
}

/* ------------------------------------------------------------------ *
 * 各项检查
 * ------------------------------------------------------------------ */

/**
 * ① 数据目录：缺失就建，并真的写一次文件验证可写。
 *
 * 为什么要有写探针：目录存在但 ACL 只读（外置盘、被安全软件接管、企业策略）时，
 * `ensureDir` 会静默成功，直到用户装引擎时才炸 —— 那时错误信息离原因已经很远了。
 * @param root 启动器根目录。
 * @param autoFix 是否允许自动创建。
 * @returns 检查项。
 */
async function checkRuntimeDirs(root: string, autoFix: boolean): Promise<PreflightCheck> {
  const paths = corePaths(root);
  const required = [
    paths.root,
    paths.instancesDir,
    paths.enginesDir,
    paths.sharedDir,
    paths.sharedSessionsDir,
    paths.sharedWorkspacesDir,
    paths.cacheDir,
  ];

  const missing: string[] = [];
  const failed: string[] = [];
  for (const dir of required) {
    if (await pathExists(dir)) continue;
    missing.push(dir);
    if (!autoFix) continue;
    try {
      await ensureDir(dir);
    } catch (error) {
      failed.push(`${dir}（${describeError(error)}）`);
    }
  }

  // 写探针：目录建不出/建出来不可写，都要在这里暴露，而不是留到装引擎时
  const probe = path.join(paths.cacheDir, WRITE_PROBE_FILE);
  let writeProblem: string | null = null;
  try {
    await ensureDir(paths.cacheDir);
    await writeTextAtomic(probe, new Date().toISOString());
    await rm(probe, { force: true });
  } catch (error) {
    writeProblem = describeError(error);
  }

  const detailParts: string[] = [`根目录：${paths.root}`];
  if (missing.length > 0) detailParts.push(`本次缺失并补建：${missing.join('、')}`);
  if (failed.length > 0) detailParts.push(`补建失败：${failed.join('；')}`);
  if (writeProblem !== null) detailParts.push(`缓存目录写探针失败：${writeProblem}`);

  if (failed.length > 0 || writeProblem !== null) {
    return item('runtime-dirs', '数据目录', 'failed', {
      summary: '数据目录不完整或不可写，实例与引擎操作会失败。',
      detail: detailParts.join('\n'),
      advice:
        '确认启动器根目录存在、当前用户对其有写权限；若它是只读介质或网络盘，请改到本机可写目录后重启启动器。',
    });
  }
  if (missing.length > 0) {
    return item('runtime-dirs', '数据目录', 'fixed', {
      summary: `已自动创建 ${missing.length} 个缺失目录。`,
      detail: detailParts.join('\n'),
      autoFixed: true,
    });
  }
  return item('runtime-dirs', '数据目录', 'ok', {
    summary: '目录齐全且可写。',
    detail: detailParts.join('\n'),
  });
}

/**
 * ② 全局配置：只读校验，**不重建**。
 *
 * 为什么不在这里重建：`launcher.json` 的自愈（缺失→写默认值 / 版本落后→就地升级 /
 * 损坏→改名备份）已经在桥接层的 `config-store.mjs` 里实现并有测试覆盖，而自检**总是
 * 在桥接层起来之后**才被调用（`launcher:getConfig` 更早），所以这里再做一遍只会得到
 * 第二份可能漂移的默认值。这里的职责是**如实报告**磁盘上的状态。
 * @param root 启动器根目录。
 * @returns 检查项。
 */
async function checkConfig(root: string): Promise<PreflightCheck> {
  const file = path.join(root, LAUNCHER_CONFIG_FILE);
  if (!(await pathExists(file))) {
    return item('config', '全局配置', 'missing', {
      summary: '尚未建立全局配置（launcher.json）。',
      detail: `期望路径：${file}`,
      advice: '打开一次「全局设置」页或重启启动器即可自动生成默认配置。',
    });
  }

  let raw: unknown;
  try {
    raw = await readJson<unknown>(file);
  } catch (error) {
    return item('config', '全局配置', 'missing', {
      summary: '全局配置无法解析，启动器会用默认值运行，并在下一次读取时把它改名备份。',
      detail: `${file}\n${describeError(error)}`,
      advice: '如需找回旧设置，请到启动器根目录查看 launcher.json.bak-* 备份文件。',
    });
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return item('config', '全局配置', 'missing', {
      summary: '全局配置的内容不是一个 JSON 对象。',
      detail: `期望路径：${file}`,
      advice: '删除该文件后重启启动器，会重新生成一份默认配置（原有的自定义设置会丢失）。',
    });
  }

  const record = raw as Record<string, unknown>;
  const schema = typeof record['schemaVersion'] === 'number' ? record['schemaVersion'] : null;
  const registry = typeof record['engineRegistry'] === 'string' ? record['engineRegistry'] : '';
  const nodePath = typeof record['nodePath'] === 'string' ? record['nodePath'] : '';
  const detail = [
    `文件：${file}`,
    `schemaVersion：${schema === null ? '未标注' : String(schema)}（当前版本 ${String(SCHEMA_VERSION)}）`,
    `npm registry：${registry.length > 0 ? registry : DEFAULT_ENGINE_REGISTRY}`,
    `Node 路径：${nodePath.length > 0 ? nodePath : '（自动探测）'}`,
  ].join('\n');

  if (schema !== null && schema > SCHEMA_VERSION) {
    return item('config', '全局配置', 'missing', {
      summary: `全局配置的版本（${String(schema)}）比当前启动器（${String(SCHEMA_VERSION)}）更新。`,
      detail,
      advice: '这份配置来自更新的启动器版本；降级使用可能读不到部分设置，建议升级启动器。',
    });
  }
  return item('config', '全局配置', 'ok', { summary: '可正常解析。', detail });
}

/**
 * ③ Node 运行时：直接复用探测器的结论。
 * @param root 启动器根目录。
 * @param report 运行时报告。
 * @returns 检查项。
 */
function nodeCheck(root: string, report: Awaited<ReturnType<typeof resolveNodeRuntime>>): PreflightCheck {
  const detail = [
    report.message,
    `自备运行时：${portableNodeExe(root)}${report.source === 'portable' ? '（当前正在使用）' : ''}`,
    '候选结论：',
    describeNodeCandidates(report),
  ].join('\n');

  if (report.ok) {
    return item('node', 'Node 运行时', 'ok', { summary: report.message, detail });
  }
  return item('node', 'Node 运行时', 'missing', {
    summary: '没有找到可用的 Node.js 运行时，实例无法启动。',
    detail,
    advice:
      '可以点「自动下载便携版 Node」由启动器自带一份（约 30MB，无需管理员权限），' +
      '或自行安装 Node.js 20 及以上版本后在「Node 可执行文件路径」里指定 node.exe。',
  });
}

/**
 * ④ npm：实跑一次 `npm -v`。
 *
 * 为什么不能只看文件在不在：Windows 上的 `npm` 是 `.cmd` 垫片，它内部还要找 `node.exe`；
 * 垫片存在但解析不到 node 时，报错会出现在真正装引擎的那一刻。这里先跑一次，把结论提前。
 * @param root 启动器根目录。
 * @param nodeOk Node 运行时是否可用（不可用时 npm 必然不可用，直接跳过以免噪音）。
 * @returns 检查项。
 */
async function checkNpm(root: string, nodeOk: boolean): Promise<PreflightCheck> {
  if (!nodeOk) {
    return item('npm', 'npm 包管理器', 'skipped', {
      summary: 'Node 运行时不可用，未检查 npm。',
      advice: '先解决 Node 运行时问题。',
    });
  }

  const cacheDir = corePaths(root).cacheDir;
  const resolved = resolveCommand('npm', []);
  try {
    const result = await runCapture('npm', ['-v'], {
      timeoutMs: NPM_PROBE_TIMEOUT_MS,
      env: childBaseEnv(root),
      captureDir: cacheDir,
    });
    const stdout = (result.stdout ?? '').trim();
    if (result.code === 0 && stdout.length > 0) {
      const version = firstLine(stdout);
      return item('npm', 'npm 包管理器', 'ok', {
        summary: `npm ${version} 可用。`,
        detail: `调用自：${resolved.file}`,
      });
    }
    return item('npm', 'npm 包管理器', 'missing', {
      summary: 'npm 不可用，安装引擎与插件都会失败。',
      detail: `退出码 ${String(result.code)}\n${tail(result.stderr || result.stdout)}`,
      advice: 'npm 随 Node.js 一起分发；请改用含 npm 的 Node.js 安装，或点「自动下载便携版 Node」由启动器自带一份。',
    });
  } catch (error) {
    return item('npm', 'npm 包管理器', 'missing', {
      summary: 'npm 无法执行，安装引擎与插件都会失败。',
      detail: `${resolved.file}\n${describeError(error)}`,
      advice: 'npm 随 Node.js 一起分发；请改用含 npm 的 Node.js 安装，或点「自动下载便携版 Node」由启动器自带一份。',
    });
  }
}

/**
 * ⑤ dsh 引擎：一个能用的都没有时，按需自动安装 registry 的 `latest`。
 * @param root 启动器根目录。
 * @param flags 自动修复与安装开关。
 * @param options 原始自检选项（用于取 registry 覆盖）。
 * @returns 检查项。
 */
async function checkEngine(
  root: string,
  flags: { autoFix: boolean; installEngine: boolean; onLog?: ProcLogSink },
  options: PreflightOptions,
): Promise<PreflightCheck> {
  let engines: Awaited<ReturnType<typeof listEngines>>;
  try {
    engines = await listEngines(root);
  } catch (error) {
    return item('engine', 'dsh 引擎', 'failed', {
      summary: '无法枚举已安装的引擎。',
      detail: describeError(error),
      advice: '到「引擎版本管理」页查看详情，必要时删除损坏的版本目录后重试。',
    });
  }

  const usable = engines.filter((entry) => entry.installed);
  if (usable.length > 0) {
    const versions = usable.map((entry) => `v${entry.version}`).join('、');
    return item('engine', 'dsh 引擎', 'ok', {
      summary: `已安装 ${usable.length} 个可用版本（${versions}）。`,
      detail: usable.map((entry) => `${entry.dir}${entry.binPath === null ? '' : `\n  入口：${entry.binPath}`}`).join('\n'),
    });
  }

  const registry = normalizeRegistry(options.registry) ?? (await readConfiguredRegistry(root));
  if (engines.length > 0) {
    return item('engine', 'dsh 引擎', 'missing', {
      summary: `发现 ${engines.length} 个引擎目录，但入口文件都缺失（安装不完整）。`,
      detail: engines.map((entry) => `${entry.dir}（未找到 lib/bin.js）`).join('\n'),
      advice: '到「引擎版本管理」把损坏的版本删掉后重新安装。',
    });
  }

  if (!flags.installEngine) {
    return item('engine', 'dsh 引擎', 'missing', {
      summary: '还没有安装任何 dsh 引擎版本，创建实例前必须先装一个。',
      detail: `registry：${registry}`,
      advice: '勾选「发现缺失时自动安装」后重新自检，或到「引擎版本管理」手动安装。',
    });
  }

  flags.onLog?.('system', `环境自检：未发现可用引擎，开始自动安装（registry=${registry}）…\n`);
  const startedAt = Date.now();

  /*
   * 装之前先花几秒确认 registry 真的能连通。
   *
   * 这不是"多此一举"：npm 对不可达 registry 的默认行为是重试 + 五分钟级超时
   * （实测连接被拒 70s、404 超过 180s，见 `engine.ts` 的 NpmQueryTuning 注释）。
   * 少了这一步，网络不通的用户会盯着一个转圈的首启对话框等好几分钟才被告知失败。
   */
  const reachable = await probeRegistry(registry, REGISTRY_PROBE_TIMEOUT_MS);
  if (!reachable.ok) {
    flags.onLog?.('system', `环境自检：registry 不可达，已跳过自动安装（${reachable.reason}）\n`);
    return item('engine', 'dsh 引擎', 'failed', {
      summary: '无法访问 npm registry，自动安装引擎已跳过。',
      detail: `registry：${registry}\n${reachable.reason}\n用时 ${formatDuration(Date.now() - startedAt)}`,
      advice:
        '检查这台机器的网络与代理设置；公司网络/内网环境通常需要在「全局设置 → 引擎与网络」把 registry 换成可访问的镜像，然后重新自检。',
    });
  }

  try {
    const version = await latestEngineVersion(registry, root, QUICK_NPM_QUERY);
    flags.onLog?.('system', `环境自检：将安装 @deepseek-ai/dsh@${version}\n`);
    const info = await installEngine(root, version, registry, flags.onLog);
    return item('engine', 'dsh 引擎', 'fixed', {
      summary: `已自动安装引擎 v${info.version}。`,
      detail: `用时 ${formatDuration(Date.now() - startedAt)}\n入口：${info.binPath ?? '（未找到）'}`,
      autoFixed: true,
      fixedValue: info.version,
    });
  } catch (error) {
    flags.onLog?.('system', `环境自检：自动安装引擎失败：${describeError(error)}\n`);
    return item('engine', 'dsh 引擎', 'failed', {
      summary: '自动安装 dsh 引擎失败。',
      detail: `${describeError(error)}\nregistry：${registry}`,
      advice:
        '先确认这台机器能访问上面的 registry（公司网络/代理常导致失败），也可以到「全局设置 → 引擎与网络」换一个 registry 后重试。',
    });
  }
}

/**
 * ⑥ 联网探测（可选，默认关闭）。
 *
 * 默认只在**首次自检**里打开：每次自检都发一次网络请求，会让"点一下自检"变成有网络
 * 副作用的操作（视觉规范 §9.9 明确要求本页避免网络副作用）。
 * @param root 启动器根目录。
 * @param enabled 是否执行。
 * @param override 调用方指定的 registry（不传则读全局配置）。
 * @returns 检查项。
 */
async function checkNetwork(
  root: string,
  enabled: boolean,
  override?: string,
): Promise<PreflightCheck> {
  const registry = normalizeRegistry(override) ?? (await readConfiguredRegistry(root));
  if (!enabled) {
    return item('network', 'npm registry 连通性', 'skipped', {
      summary: '未做联网检查（按需开启）。',
      detail: `registry：${registry}`,
    });
  }

  const probe = await probeRegistry(registry, REGISTRY_PROBE_TIMEOUT_MS);
  if (!probe.ok) {
    return item('network', 'npm registry 连通性', 'failed', {
      summary: '无法访问 npm registry，自动安装引擎与插件会失败。',
      detail: `registry：${registry}\n${probe.reason}\n用时 ${formatDuration(probe.elapsedMs)}`,
      advice: '检查网络/代理设置；公司网络下通常需要改用内网镜像（「全局设置 → 引擎与网络」）。',
    });
  }
  return item('network', 'npm registry 连通性', 'ok', {
    summary: `可访问（HTTP ${String(probe.status)}，用时 ${formatDuration(probe.elapsedMs)}）。`,
    detail: `registry：${registry}`,
  });
}

/** registry 连通性探测的结论。 */
interface RegistryProbe {
  /** 是否可视为"能拿来装东西"（HTTP < 500 且握手成功）。 */
  ok: boolean;
  /** HTTP 状态码；握手失败为 null。 */
  status: number | null;
  /** 耗时（毫秒）。 */
  elapsedMs: number;
  /** 人类可读的原因（成功时是状态码说明）。 */
  reason: string;
}

/**
 * 探测一个 registry 是否可达。
 *
 * 判定标准刻意**宽松**：只要拿到了 HTTP 响应且不是 5xx 就算可达（4xx 也放行 ——
 * 根路径返回 404/405 的 registry 完全正常，装包时访问的是具体包路径）。
 * 只有"连接不上 / 超时 / 服务端 5xx"才算不可达，这时才拦下自动安装。
 * @param registry registry 基地址。
 * @param timeoutMs 超时（毫秒）。
 * @returns 探测结论（**永不抛错**）。
 */
async function probeRegistry(registry: string, timeoutMs: number): Promise<RegistryProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(registry, { method: 'HEAD', signal: controller.signal });
    const elapsedMs = Date.now() - startedAt;
    if (response.status >= 500) {
      return {
        ok: false,
        status: response.status,
        elapsedMs,
        reason: `registry 返回 HTTP ${String(response.status)}（服务端错误）`,
      };
    }
    return { ok: true, status: response.status, elapsedMs, reason: `HTTP ${String(response.status)}` };
  } catch (error) {
    return {
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      reason: describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 构造一个检查项（统一补上 `elapsedMs` 之外的默认字段，避免每处都写全）。
 * @param id 检查项标识。
 * @param title 中文标题。
 * @param status 结论。
 * @param fields 其余字段。
 * @returns 检查项。
 */
function item(
  id: string,
  title: string,
  status: PreflightStatus,
  fields: {
    summary: string;
    detail?: string;
    advice?: string;
    autoFixed?: boolean;
    fixedValue?: string;
  },
): PreflightCheck {
  return {
    id,
    title,
    status,
    summary: fields.summary,
    detail: fields.detail ?? null,
    advice: fields.advice ?? null,
    autoFixed: fields.autoFixed === true,
    fixedValue: fields.fixedValue ?? null,
  };
}

/**
 * 读取全局配置里的 registry（只读；任何异常都回退到默认值）。
 * @param root 启动器根目录。
 * @returns registry 地址。
 */
async function readConfiguredRegistry(root: string): Promise<string> {
  try {
    const raw = await readJson<{ engineRegistry?: unknown }>(path.join(root, LAUNCHER_CONFIG_FILE));
    const value = raw?.engineRegistry;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  } catch {
    // 读不到就用默认值：自检不能因为配置问题而无法给出结论
  }
  return DEFAULT_ENGINE_REGISTRY;
}

/** 自检状态文件路径。 */
function stateFilePath(root: string): string {
  return path.join(corePaths(root).cacheDir, PREFLIGHT_STATE_FILE);
}

/** 归一化 registry 覆盖值（空串/非字符串一律视为"未提供"）。 */
function normalizeRegistry(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 落盘自检状态（尽力而为：失败只影响"下次算不算首次"，绝不改变本次结论）。
 * @param root 启动器根目录。
 * @param previous 上一次的状态（无则 null）。
 * @param report 本次报告。
 */
async function writeState(
  root: string,
  previous: PreflightState | null,
  report: PreflightReport,
): Promise<void> {
  const state: PreflightState = {
    schemaVersion: PREFLIGHT_STATE_SCHEMA,
    firstRunAt: previous?.firstRunAt ?? report.finishedAt,
    lastRunAt: report.finishedAt,
    runCount: (previous?.runCount ?? 0) + 1,
    lastOk: report.ok,
    lastProblemCount: report.problemCount,
    lastInstalledEngine: report.installedEngineVersion ?? previous?.lastInstalledEngine ?? null,
  };
  await ensureDir(corePaths(root).cacheDir);
  await writeJsonAtomic(stateFilePath(root), state);
}

/** 取文本第一个非空行（npm 版本号用）。 */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line === undefined ? text.trim() : line.trim();
}

/** 取文本尾部若干行（错误摘要用）。 */
function tail(text: string, lines = 6): string {
  const parts = (text ?? '').trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n').slice(0, 800);
}

/** 把错误变成一行中文可读文本。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把毫秒格式化成人类可读的短文本。
 * @param ms 毫秒。
 * @returns 形如 `820ms` / `3.4s` / `2m10s`。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${String(minutes)}m${String(rest)}s`;
}
