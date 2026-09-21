/**
 * WhalesLauncher core —— 实例启动与运行时状态
 *
 * 启动形态（架构文档 §5.2，dsh 接口勘察 D1/D2）：
 * ```
 * spawn(node, [<engines>/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js,
 *              "--profile", <p>, ...appArgs],
 *       { cwd: <实例>/workspace, env: { ...process.env, DSH_HOME: <实例>/home } })
 * ```
 * 启动器自己的 flag 必须放在最前：dsh 的解析器从第一个不认识的 token 起把其余参数
 * 原样交给被启动的应用（`bin.js` 的 `passThroughOptions`），因此 `appArgs` 直接追加即可。
 *
 * 端口/URL 探测：web profile 启动后会在输出里打印监听地址，本模块从 stdout/stderr
 * 中提取 `http://127.0.0.1:<port>` 形态的地址放进 `runtime.url`；是否打开浏览器
 * 由 main（`shell.openExternal`）决定，core 不碰 Electron API。
 *
 * **自动端口**：带 Web 界面的 profile 会由 `core/ports.ts` 先算出一个可用端口并以
 * `--port <n>` 注入（用户已显式写 `--port` 则原地改写它的值），从而让多个实例自动避让、
 * 不必人工逐个指定。非 Web 模板**一个参数都不加**（`--port` 只有 Web 应用认，
 * 传给 headless/sdk/acp 会被 commander 当成未知选项而启动失败）。
 * 界面地址里解析出的真实端口会回填 `runtime.port`，因此 `--port 0` 交内核分配时也能记录。
 *
 * 强制终止的语义：Windows 上被 `TerminateProcess` 结束的进程由 Node 以 signal 报告，
 * 因此此时 `runtime.exitCode` 为 `null`、`state` 为 `stopped`（属正常现象，不是缺陷）。
 */
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  InstanceMeta,
  InstanceRuntime,
  LaunchRequest,
  LaunchResult,
  LauncherConfig,
  LogSink,
} from '../shared/contracts';
import { BUNDLE_TEMPLATES } from '../shared/contracts';
import { resolveEngineBin } from './engine';
import { applyShareModes, markLaunched } from './instance';
import { describeNodeCandidates, nodeRuntimeLabel, resolveNodeRuntime } from './node-runtime';
import { childBaseEnv, corePaths, instancePaths, logFileName } from './paths';
import {
  OS_ASSIGNED_PORT,
  allocatePort,
  notePortActual,
  notePortBound,
  notePortFailure,
  parseExplicitPort,
  releasePort,
  withPortArg,
} from './ports';
import { spawnStreaming, type StreamingHandle } from './proc';
import { readBundles, readProfileManifest } from './profile';
import { clearRuntime, listRuntimes, patchRuntime, runtimeOf, setRuntimeState } from './runtime';
/** 正在运行的实例（instanceId → 句柄与日志文件）。 */
const active = new Map<string, { handle: StreamingHandle; logFile: string; settled: Promise<void> }>();

/** 停止实例的等待上限（毫秒）。 */
const STOP_TIMEOUT_MS = 15_000;

/** Web 界面的组合包名：只有启用了它的 profile 才需要监听端口。 */
const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app';

/** 从输出里识别界面地址的正则（web profile 监听 127.0.0.1）。 */
const URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s"'`]*)?/i;

/** URL 探测的滚动窗口大小（地址可能被切到两个 chunk 里）。 */
const URL_WINDOW = 4096;

/** 保留的 stderr 尾巴长度（用于 `lastError`）。 */
const STDERR_TAIL = 4000;

/** 超时哨兵值。 */
const TIMEOUT = Symbol('timeout');

/**
 * 启动实例。
 *
 * 这一层只做一件事：**保证"启动失败"时不会把端口预留漏在本进程里**。
 * `allocatePort` 之后、进程真正创建之前，任何未捕获异常（典型来源是 hook 回调，
 * 例如窗口已销毁导致的推送失败）都会让那个端口永久留在预留集里 ——
 * 此后所有实例都会白避开一个事实上没人在用的端口，而且没有任何报错。
 * 用一层薄包装把它闭合，比在函数体里散落 `release` 调用更难遗漏。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @param req 启动请求（可一次性覆盖 appArgs）。
 * @param config 启动器全局设置（用于共享模式与凭证继承）。
 * @param hooks 日志 / 状态 / 退出回调。
 * @returns 启动结果（PID、DSH_HOME、工作目录）。
 * @throws 已在运行 / 引擎未安装 / 进程启动失败。
 */
export async function launchInstance(
  root: string,
  meta: InstanceMeta,
  req: LaunchRequest,
  config: LauncherConfig,
  hooks: {
    onLog?: LogSink;
    onState?: (runtime: InstanceRuntime) => void;
    onExit?: (code: number | null) => void;
  } = {},
): Promise<LaunchResult> {
  try {
    return await launchInstanceOnce(root, meta, req, config, hooks);
  } catch (error) {
    /*
     * 只有在**进程未登记**时才释放：已登记进 `active` 说明进程确实起来了，
     * 此时释放会让另一个实例趁虚拿走一个正在被监听的端口，破坏"并发不选重"的保证。
     * `releasePort` 本身是幂等的，重复调用无副作用。
     */
    if (!active.has(meta.id)) await releasePort(root, meta.id);
    throw error;
  }
}

/** {@link launchInstance} 的实现体（并发语义与失败清理由外层包装负责）。 */
async function launchInstanceOnce(
  root: string,
  meta: InstanceMeta,
  req: LaunchRequest,
  config: LauncherConfig,
  hooks: {
    onLog?: LogSink;
    onState?: (runtime: InstanceRuntime) => void;
    onExit?: (code: number | null) => void;
  } = {},
): Promise<LaunchResult> {
  if (active.has(meta.id)) throw new Error(`实例已在运行：${meta.name}`);
  await applyShareModes(root, meta, config);
  const binPath = resolveEngineBin(root, meta.engine.version);
  if (binPath === null) throw new Error(`引擎 ${meta.engine.version} 未安装，无法启动实例 ${meta.name}`);
  const paths = instancePaths(root, meta);
  await mkdir(paths.logs, { recursive: true });
  // 日志轮转：先腾出位置（保留 N-1 个），再写本次启动的日志，使总量不超过 MAX_LOG_FILES
  await pruneOldLogs(paths.logs, MAX_LOG_FILES - 1);
  const logFile = path.join(paths.logs, logFileName());
  const logWriter = createLogWriter(logFile);

  /*
   * 自动端口：先算端口再拼命令行。
   * 用户显式写的 `--port` 会被**原地改写值**（而不是再追加一个 `--port`），
   * 保证命令行里始终只有一个 `--port`，不把正确性押在"后者覆盖前者"上。
   */
  const requestedArgs = (req.appArgs ?? meta.launch.appArgs).filter((item) => typeof item === 'string');
  const portDecision = (await hasWebSurface(root, meta))
    ? await allocatePort(root, { id: meta.id, name: meta.name }, parseExplicitPort(requestedArgs))
    : null;
  const appArgs = portDecision === null ? requestedArgs : withPortArg(requestedArgs, portDecision.port);
  const args = ['--profile', meta.profile.name, ...appArgs];

  let urlWindow = '';
  let stderrTail = '';
  const notify = (runtime: InstanceRuntime): void => {
    hooks.onState?.(runtime);
  };
  /**
   * 统一的日志出口：串行写文件（带合并/背压）+ 回调 + URL 探测。
   *
   * 写文件走 {@link createLogWriter} 的单写者队列，不再用"发后不管"的
   * `void appendFile(...)`：后者在子进程爆量输出时会产生无界的并发写。
   */
  const emit = (stream: 'stdout' | 'stderr' | 'system', text: string): void => {
    logWriter.write(text);
    hooks.onLog?.(stream, text);
    if (stream === 'stderr') stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL);
    if (stream === 'system') return;
    urlWindow = `${urlWindow}${text}`.slice(-URL_WINDOW);
    const match = URL_PATTERN.exec(urlWindow);
    if (match === null) return;
    const url = match[0].replace(/[.,;:)\]]+$/, '');
    const current = runtimeOf(meta.id);
    // 地址里解析出的端口是**真实端口**：`--port 0` 交内核分配时只有这里能知道它
    const actual = portFromUrl(url);
    if (current.url === url && (actual === null || current.port === actual)) return;
    notify(patchRuntime(meta.id, actual === null ? { url } : { url, port: actual }));
    /*
     * 把真实端口回填进台账。分配阶段做不到：`--port 0` 时那一刻根本不知道端口号，
     * 不回填的话台账的 `last` 会永远停在 0。这里不 await —— 它是旁路记账，
     * 不该拖慢输出处理；`notePortActual` 内部对读写异常都已收口，不会产生未处理的拒绝。
     */
    if (actual !== null && portDecision !== null) void notePortActual(root, meta.id, actual).catch(() => undefined);
  };

  notify(
    setRuntimeState(meta.id, 'starting', {
      pid: null,
      startedAt: new Date().toISOString(),
      url: null,
      port: portDecision === null ? null : portDecision.port,
      exitCode: null,
      lastError: null,
    }),
  );
  if (portDecision !== null) emit('system', `[whales] 端口：${portDecision.reason}\n`);
  /*
   * 执行 dsh 的运行时必须是**真正的 Node.js**：Electron 主进程的 `process.execPath`
   * 是 electron.exe，而 dsh 的 `node-addon-require-builtin` 原生模块只识别特定
   * Electron 运行时指纹（本机实测 Electron 41 被拒），启动必然失败。
   * 解析顺序与环境变量覆盖见 `node-runtime.ts`。
   */
  const node = await resolveNodeRuntime({
    configuredPath: config.nodePath ?? null,
    captureDir: corePaths(root).cacheDir,
  });
  if (!node.ok) {
    const detail = `${node.message}\n候选运行时：\n${describeNodeCandidates(node)}`;
    emit('system', `[whales] 启动失败：${detail}\n`);
    notify(setRuntimeState(meta.id, 'crashed', { pid: null, lastError: detail }));
    throw new Error(`启动失败：${node.message}`);
  }
  emit(
    'system',
    `[whales] 启动 ${meta.name}：${String(node.file)} ${binPath} ${args.join(' ')}\n` +
      `[whales] Node 运行时：${nodeRuntimeLabel(node)}\n` +
      `[whales] DSH_HOME=${paths.home}\n[whales] cwd=${paths.workspace}\n`,
  );

  let handle: StreamingHandle;
  try {
    handle = spawnStreaming(String(node.file), [binPath, ...args], {
      cwd: paths.workspace,
      env: { DSH_HOME: paths.home, ...childBaseEnv(root) },
      onLog: emit,
      captureDir: corePaths(root).cacheDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('system', `[whales] 启动失败：${message}\n`);
    notify(setRuntimeState(meta.id, 'crashed', { pid: null, lastError: message }));
    throw new Error(`启动失败：${message}`);
  }
  if (handle.pid <= 0) {
    notify(setRuntimeState(meta.id, 'crashed', { pid: null, lastError: '进程未能创建' }));
    throw new Error('启动失败：进程未能创建（可执行文件不存在或不可执行）');
  }
  // 退出处理链：`stopInstance` 会等待它，保证"停止返回"时退出码与状态都已落定
  const settled = handle.exited.then(async (code) => {
    active.delete(meta.id);
    const previous = runtimeOf(meta.id).state;
    const forced = previous === 'stopping';
    const failed = code !== 0 && !forced;
    // 先把日志写完，再据此计算 lastError，避免读到半截日志
    await logWriter.drain();
    const rawError = stderrTail.trim() || lastLines(await readLogTail(logFile));
    const hint = failed ? explainLaunchFailure(rawError) : null;
    if (hint !== null) emit('system', `[whales] ${hint}\n`);
    /*
     * 端口收尾（顺序在最终状态落定之前，保证"已停止"时台账也已一致）：
     *  - 被 EADDRINUSE 拒绝：记进失败台账，短时间内谁都不再优先选它（自愈）；
     *  - 无论何种退出：释放预留，端口还给系统；台账里的 `preferred` 保留，
     *    下次启动仍优先复用同一个端口。
     */
    if (portDecision !== null) {
      const stolen =
        failed && portDecision.port !== OS_ASSIGNED_PORT && /EADDRINUSE/i.test(rawError);
      if (stolen) await notePortFailure(root, portDecision.port);
      await releasePort(root, meta.id);
    }
    const runtime = setRuntimeState(meta.id, failed ? 'crashed' : 'stopped', {
      pid: null,
      exitCode: code,
      lastError: failed ? [hint, rawError].filter((item) => item !== null && item.length > 0).join('\n') : null,
    });
    emit('system', `[whales] 进程退出，退出码 ${String(code)}${failed ? '（异常退出）' : ''}\n`);
    await logWriter.drain();
    notify(runtime);
    hooks.onExit?.(code);
  });
  active.set(meta.id, { handle, logFile, settled });
  notify(setRuntimeState(meta.id, 'running', { pid: handle.pid, startedAt: new Date().toISOString() }));
  emit('system', `[whales] 进程已启动，PID=${handle.pid}，日志：${logFile}\n`);

  const updated = await markLaunched(root, meta.id);
  if (updated === null) emit('system', '[whales] 警告：实例元数据缺失，未能记录启动次数\n');
  // 把 PID 也写进端口台账：人工排查"这个端口是谁占的"时一眼可见
  if (portDecision !== null) await notePortBound(root, meta.id, handle.pid);
  return { pid: handle.pid, dshHome: paths.home, cwd: paths.workspace };
}

/**
 * 判断实例的 profile 是否**真的**带 Web 界面（决定要不要注入 `--port`）。
 *
 * 判据取 profile 的**实际组合包列表**，而不是创建时的模板名：用户后来通过插件管理
 * 启用/禁用了 `@deepseek-ai/dsh-web-app` 时也会跟着变。清单读不到时回退到模板名，
 * 保证实例处于半成品状态时行为依然可预测。
 *
 * 这个判断是必需的：`--port` 只有 Web 应用认，传给 headless/sdk/acp 会被
 * commander 当作未知选项，直接启动失败 —— 那等于用一个新缺陷换掉一个旧缺陷。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 需要监听端口返回 true。
 */
async function hasWebSurface(root: string, meta: InstanceMeta): Promise<boolean> {
  const fallback = BUNDLE_TEMPLATES[meta.profile.template] ?? [];
  let bundles = fallback;
  try {
    const manifest = await readProfileManifest(instancePaths(root, meta).profileDir);
    if (manifest !== null) bundles = readBundles(manifest);
  } catch {
    /*
     * `readJson` 在清单**损坏**（JSON 语法错）时是抛错而不是返回 null —— 只有文件
     * 缺失才返回 null。端口判断是**旁路信息**，绝不能因此让整个启动在这里断掉：
     * 那会把 dsh 自己的报错挡在外面，用户只看到一句 JSON 解析失败，日志里连启动行都没有。
     * 回退到创建时的模板名即可，剩下的交给 dsh 去报。
     * （由独立审查的 trace 实测发现：清单写坏后 launchInstance 直接抛错、dsh 根本没被启动。）
     */
    bundles = fallback;
  }
  return bundles.includes(WEB_APP_BUNDLE);
}

/**
 * 从界面地址里取出端口。
 * @param url 形如 `http://127.0.0.1:3081/` 的地址。
 * @returns 端口；地址未含端口时返回 `null`。
 */
function portFromUrl(url: string): number | null {
  const match = /^https?:\/\/[^/?#]*?:(\d+)/i.exec(url);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * 停止实例（终止整棵进程树）。
 *
 * 终止原语见 `proc.killTree`（本机实测 `taskkill` 在受限沙箱会被拒绝，因此以
 * `child.kill('SIGKILL')` 为主、`taskkill /T` 收孙进程、`process.kill` 兜底）。
 * **确认后才报成功**：返回前会确认进程确实消失；若仍存活，状态如实保持 `running`
 * 并给出"请手动结束"的说明（见 {@link describeStopFailure}），绝不谎报已停止。
 *
 * 对**从未登记过**的实例 id 是纯 no-op（不写任何记录）：这样 `listRuntimes()` 才能如实
 * 回答"core 有没有这个实例的运行记录"（`runtimeOf()` 对未登记 id 返回的是 `stopped`
 * 默认值，**不能**用来判断"有没有记录"）。
 * @param instanceId 实例 id。
 */
export async function stopInstance(instanceId: string): Promise<void> {
  const entry = active.get(instanceId);
  if (entry === undefined) {
    // 只有确实登记过才更新状态，避免为不存在的实例凭空造出一条 stopped 记录
    if (listRuntimes().some((runtime) => runtime.instanceId === instanceId)) {
      setRuntimeState(instanceId, 'stopped', { pid: null });
    }
    return;
  }
  setRuntimeState(instanceId, 'stopping');
  entry.handle.kill();
  let outcome = await raceTimeout(entry.settled, STOP_TIMEOUT_MS);
  if (outcome === TIMEOUT) {
    entry.handle.kill();
    outcome = await raceTimeout(entry.settled, 5_000);
  }
  if (outcome === TIMEOUT) {
    const alive = entry.handle.isAlive();
    active.delete(instanceId);
    setRuntimeState(instanceId, alive ? 'running' : 'stopped', {
      pid: alive ? entry.handle.pid : null,
      lastError: describeStopFailure(alive),
    });
  }
}

/**
 * 生成"停止失败"的说明文案（**绝不谎报**）。
 *
 * 探测到进程仍存活时，必须明确告诉用户需要手动结束，而不是声称"已强制结束"。
 * @param aliveAfterKill 兜底终止后进程是否仍存活。
 * @returns 面向用户的说明。
 */
export function describeStopFailure(aliveAfterKill: boolean): string {
  return aliveAfterKill
    ? '无法终止实例进程（终止调用被系统拒绝），请手动结束该进程后再重试'
    : '停止超时，但进程已自行退出';
}

/**
 * 把已知的启动失败特征翻译成**可操作的中文提示**（纯诊断增强，不改变退出码语义）。
 *
 * 覆盖两类真实遇到过的失败：
 *  - dsh 的原生模块拒绝 Electron 内置运行时（历史缺陷：启动器把 electron.exe 当 node 用）；
 *  - web profile 的监听端口被占用（典型：另一个实例或别的程序已监听 3080）。
 * @param text 子进程 stderr 或日志尾部。
 * @returns 提示文案；无法识别时返回 `null`（此时日志原文已足够）。
 */
export function explainLaunchFailure(text: string): string | null {
  if (text.length === 0) return null;
  if (/node-addon-require-builtin|Unsupported\/no-context|unsupported Electron runtime fingerprint/i.test(text)) {
    return (
      '引擎拒绝在 Electron 内置的 Node 运行时下执行（dsh 的原生模块只支持特定 Electron 版本）。' +
      '请在「全局设置 → Node 运行时」指定真正的 node.exe（Node.js >= 20）后重试，' +
      '并用“重新检测”确认探测结果。'
    );
  }
  if (/EADDRINUSE/i.test(text)) {
    const port = /address already in use\s+[^\s]*?:(\d+)/i.exec(text)?.[1] ?? /port:\s*(\d+)/i.exec(text)?.[1];
    const where = port === undefined ? '监听端口' : `端口 ${port}`;
    return (
      `${where}已被占用：另一个实例或程序正在监听它。请在实例详情里给「启动参数」加上 ` +
      '`--port <其它端口>`（例如 `--port 3081`），或先结束占用该端口的进程再重试。'
    );
  }
  if (/failed to apply loader entry/i.test(text)) {
    return 'profile 的组合包/插件加载失败：请检查实例详情里的插件列表与「设置」页，或查看上方日志定位具体插件。';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 日志写入（QR-09）与轮转（QR-10）
 * ------------------------------------------------------------------ */

/**
 * 日志写入器：**单写者 + 自动合并**。
 *
 * 原先用 `void appendFile(...)` 发后不管：子进程爆发式输出时会同时挂起成百上千个
 * 写操作（无背压），既可能打乱写入顺序，也会把内存和句柄顶高。这里改为
 * "积累到缓冲区 → 由唯一的循环逐次 await 落盘"，天然具备背压与顺序保证：
 * 前一次写盘未完成时的输出会合并进同一批，因此挂起的写操作恒为 1 个。
 */
export interface LogWriter {
  /** 追加文本（同步返回，实际写盘由内部队列串行完成）。 */
  write(text: string): void;
  /** 等待当前缓冲全部落盘（退出前调用，保证日志完整）。 */
  drain(): Promise<void>;
}

/**
 * 创建一个串行化的日志写入器。
 * @param file 目标日志文件。
 * @returns 写入器。
 */
export function createLogWriter(file: string): LogWriter {
  let pending = '';
  let flushing: Promise<void> | null = null;
  const flushLoop = async (): Promise<void> => {
    while (pending.length > 0) {
      const chunk = pending;
      pending = '';
      try {
        await appendFile(file, chunk);
      } catch {
        // 磁盘/句柄异常不应影响启动流程，也不重试（避免死循环）
        pending = '';
      }
    }
    flushing = null;
  };
  return {
    write(text: string): void {
      if (text.length === 0) return;
      pending += text;
      if (flushing === null) flushing = flushLoop();
    },
    async drain(): Promise<void> {
      while (flushing !== null) await flushing;
    },
  };
}

/** 每个实例保留的日志文件数量上限。 */
export const MAX_LOG_FILES = 10;

/**
 * 日志轮转：只保留最近 {@link MAX_LOG_FILES} 个 `*.log`。
 *
 * 日志文件名是 ISO 时间戳（`2026-02-03T10-20-30-123Z.log`），字典序即时间序，
 * 因此按名称倒序保留前 N 个即可；不符合命名规则的文件一律不动。
 * @param logsDir 实例的日志目录。
 * @returns 被删除的日志文件名列表。
 */
export async function pruneOldLogs(logsDir: string, keep: number = MAX_LOG_FILES): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(logsDir)).filter((name) => name.endsWith('.log'));
  } catch {
    return [];
  }
  if (names.length <= keep) return [];
  const stale = [...names].sort().reverse().slice(keep);
  const removed: string[] = [];
  for (const name of stale) {
    try {
      await rm(path.join(logsDir, name), { force: true });
      removed.push(name);
    } catch {
      // 删除失败（被占用等）不影响启动
    }
  }
  return removed;
}

/**
 * 读取实例运行时状态（契约 `runtimeOf`）。
 * @param instanceId 实例 id。
 * @returns 运行时状态快照。
 */
export function instanceRuntime(instanceId: string): InstanceRuntime {
  return runtimeOf(instanceId);
}

/**
 * 列出全部实例运行时状态（契约 `listRuntimes`）。
 * @returns 运行时状态数组。
 */
export function allRuntimes(): InstanceRuntime[] {
  return listRuntimes();
}

/**
 * 注销某个实例的运行时状态（删除实例时调用）。
 * @param instanceId 实例 id。
 */
export function forgetRuntime(instanceId: string): void {
  active.delete(instanceId);
  clearRuntime(instanceId);
}

/** 给 Promise 加超时（超时返回哨兵值 {@link TIMEOUT}）。 */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 读取日志文件尾部。 */
async function readLogTail(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** 取文本尾部若干行。 */
function lastLines(text: string, lines = 12): string {
  const parts = text.trim().split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}
