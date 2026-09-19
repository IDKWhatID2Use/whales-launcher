/**
 * WhalesLauncher core —— 子进程执行层
 *
 * 两条稳定边界之一（`dsh` CLI）就在这里落地。本模块只依赖 Node 内置模块。
 *
 * ### 为什么要有「文件重定向降级」
 * 受管沙箱（以及部分受限 Windows 环境）禁止创建命名管道，`spawn` 使用
 * `stdio: 'pipe'` 时会直接 **EPERM**（本机实测：`spawnSync(..., {encoding:'utf8'})`
 * 报 EPERM，而 `stdio: 'inherit' / 'ignore'` 正常，把 stdout/stderr 指向已打开的
 * 文件句柄也正常）。为了让启动器在这类环境下仍能完成「创建实例 / 装插件 / 启动」
 * 全流程，`runCapture` 与 `spawnStreaming` 在管道创建失败时自动降级为
 * **文件句柄重定向 + 增量读文件**，对外行为（收集输出、流式回调、退出码）保持一致。
 *
 * ### Windows 命令解析
 * `npm` / `pnpm` 在 Windows 上是 `.cmd` 垫片，无法直接 spawn，必须先解析出真实
 * `.cmd`/`.exe` 路径再交给 `cmd.exe /d /s /c` 执行；所有参数都会做引号包裹并拒绝
 * 含 `"`/`%`/换行的危险参数，避免命令注入。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** 日志下沉回调（与契约 `LogSink` 形状一致）。 */
export type ProcLogSink = (stream: 'stdout' | 'stderr' | 'system', text: string) => void;

/** 一次性命令的执行选项。 */
export interface RunOptions {
  /** 工作目录。 */
  cwd?: string;
  /** 追加/覆盖的环境变量。 */
  env?: NodeJS.ProcessEnv;
  /** 输出回调（stdout/stderr 实时透传）。 */
  onLog?: ProcLogSink;
  /** 超时毫秒数，超时后强杀并抛错。 */
  timeoutMs?: number;
  /** 降级时落临时文件的目录，建议传 `<root>/cache`。 */
  captureDir?: string;
}

/** 一次性命令的执行结果。 */
export interface RunResult {
  /** 退出码（被信号终止时为 null）。 */
  code: number | null;
  /** 完整 stdout。 */
  stdout: string;
  /** 完整 stderr。 */
  stderr: string;
}

/** 长驻进程句柄。 */
export interface StreamingHandle {
  /** 子进程 PID（启动失败为 -1）。 */
  pid: number;
  /** 子进程退出码承诺。 */
  exited: Promise<number | null>;
  /** 终止整棵进程树（返回是否确认已终止）。 */
  kill(): boolean;
  /** 进程是否仍然存活。 */
  isAlive(): boolean;
}

/** 供 `spawn` 使用的已解析命令。 */
interface ResolvedCommand {
  /** 实际要 spawn 的可执行文件。 */
  file: string;
  /** 实际参数（`.cmd` 垫片会被包进 `cmd.exe /d /s /c`）。 */
  args: string[];
  /** 是否要求 Node 原样传递参数（cmd 垫片必须为 true，见 {@link wrapCmdShim}）。 */
  verbatim?: boolean;
}

/**
 * 解析 Windows 上的命令垫片。
 *
 * 非 Windows 或命令已含路径分隔符时原样返回；否则按 `PATH` + `PATHEXT` 查找真实文件。
 * @param command 命令名或路径。
 * @param args 原始参数。
 * @returns 可直接 spawn 的文件与参数。
 */
export function resolveCommand(command: string, args: string[]): ResolvedCommand {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return { file: command, args };
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
      if (!isFile(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) return wrapCmdShim(candidate, args);
      return { file: candidate, args };
    }
    const bare = path.join(dir, command);
    if (isFile(bare)) return { file: bare, args };
  }
  return { file: command, args };
}

/**
 * 把 `.cmd`/`.bat` 调用包装成 `cmd.exe /d /s /c ""<file>" <args>"`。
 *
 * **本机实测矩阵**（`npm.cmd --version`）：
 *  - `cmd /d /s /c "\"npm.cmd\" args"`（Node 默认再加一层引号）→
 *    `'"C:\Program Files\nodejs\npm.cmd"' is not recognized`（**旧实现，全部 npm/pnpm 功能失效**）
 *  - `cmd /d /s /c ""npm.cmd" args""` + `windowsVerbatimArguments: true` → **成功，输出 11.16.0** ✓
 *  - 不加引号（路径含空格）→ `'C:\Program' is not recognized`
 *
 * cmd.exe 的经典规则：`/c` 后整条命令若以引号开头，必须再用一对引号把整串包住，
 * 否则首尾引号会被 cmd 吃掉。同时必须配合 `windowsVerbatimArguments`，否则 Node
 * 会按 CommandLineToArgvW 规则二次转义（`\"`），cmd 并不按那套规则解析。
 * @param file 垫片绝对路径。
 * @param args 原始参数。
 * @returns 可直接 spawn 的文件与参数。
 */
function wrapCmdShim(file: string, args: string[]): ResolvedCommand {
  const comspec = process.env['ComSpec'] ?? 'cmd.exe';
  const inner = [quoteCmdArg(file), ...args.map(quoteCmdArg)].join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
}

/**
 * 为 `cmd.exe` 行内参数加引号，并拒绝无法安全转义的输入（防命令注入）。
 * @param value 原始参数。
 * @returns 加引号后的参数。
 */
function quoteCmdArg(value: string): string {
  if (/["%&|<>^\r\n]/.test(value)) {
    throw new Error(`拒绝执行：参数包含 shell 危险字符 ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

/*
 * 这里曾经有一个 `nodeRunner()`：在 Electron 主进程里把 `process.execPath`
 * （electron.exe）配 `ELECTRON_RUN_AS_NODE=1` 当 Node 用。**它是实例启动失败的
 * 直接原因**（dsh 的 `node-addon-require-builtin` 原生模块只认特定 Electron 运行时
 * 指纹，Electron 41 不在其中），已删除。凡是需要执行 dsh 的地方，一律先用
 * `node-runtime.ts` 的 `resolveNodeRuntime()` 解析出**真正的 Node.js**。
 */

/**
 * 执行一次性命令并收集输出。
 *
 * @param command 命令名或可执行文件路径。
 * @param args 参数列表。
 * @param options 执行选项。
 * @returns 退出码与完整输出。
 * @throws 命令不存在 / 参数非法 / 超时。
 */
export async function runCapture(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const resolved = resolveCommand(command, args);
  try {
    return await runWithPipes(resolved, options);
  } catch (error) {
    if (!isPipeDenied(error)) throw error;
  }
  return runWithFiles(resolved, options);
}

/**
 * 启动长驻进程并实时透传输出。
 *
 * @param command 命令名或可执行文件路径。
 * @param args 参数列表。
 * @param options 执行选项。
 * @returns 进程句柄。
 */
export function spawnStreaming(command: string, args: string[], options: RunOptions = {}): StreamingHandle {
  const resolved = resolveCommand(command, args);
  try {
    return spawnWithPipes(resolved, options);
  } catch (error) {
    if (!isPipeDenied(error)) throw error;
  }
  return spawnWithFiles(resolved, options);
}

/** 管道模式：一次性命令（生产路径）。 */
function runWithPipes(resolved: ResolvedCommand, options: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(resolved.file, resolved.args, {
      cwd: options.cwd,
      windowsVerbatimArguments: resolved.verbatim === true,
      env: buildEnv(options.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onLog?.('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onLog?.('stderr', text);
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killTree(child.pid);
        reject(new Error(`命令超时（${options.timeoutMs}ms）：${resolved.file} ${resolved.args.join(' ')}`));
      }, options.timeoutMs);
    }
    child.on('error', (error) => {
      stop();
      reject(error);
    });
    child.on('close', (code) => {
      stop();
      resolve({ code, stdout, stderr });
    });
  });
}

/** 管道模式：长驻进程（生产路径）。 */
function spawnWithPipes(resolved: ResolvedCommand, options: RunOptions): StreamingHandle {
  const child = spawn(resolved.file, resolved.args, {
    cwd: options.cwd,
    windowsVerbatimArguments: resolved.verbatim === true,
    env: buildEnv(options.env),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const decoderOut = new StringDecoder('utf8');
  const decoderErr = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer) => options.onLog?.('stdout', decoderOut.write(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => options.onLog?.('stderr', decoderErr.write(chunk)));
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => killTree(child.pid, child), options.timeoutMs);
  return {
    pid: child.pid ?? -1,
    exited: new Promise<number | null>((resolve) => {
      child.on('error', () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(code);
      });
    }),
    kill: () => killTree(child.pid, child),
    isAlive: () => isAlive(child.pid),
  };
}

/** 降级模式：一次性命令 —— 文件句柄重定向，退出后读回文件。 */
async function runWithFiles(resolved: ResolvedCommand, options: RunOptions): Promise<RunResult> {
  const dir = options.captureDir ?? path.join(os.tmpdir(), 'whalelauncher-capture');
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `capture-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const outPath = `${base}.out`;
  const errPath = `${base}.err`;
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  try {
    const result = spawnSync(resolved.file, resolved.args, {
      cwd: options.cwd,
      windowsVerbatimArguments: resolved.verbatim === true,
      env: buildEnv(options.env),
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      timeout: options.timeoutMs,
    });
    const stdout = await readFile(outPath, 'utf8').catch(() => '');
    const stderr = await readFile(errPath, 'utf8').catch(() => '');
    if (stdout.length > 0) options.onLog?.('stdout', stdout);
    if (stderr.length > 0) options.onLog?.('stderr', stderr);
    if (result.error !== undefined && result.error !== null) {
      const code = (result.error as { code?: string }).code;
      if (code === 'ETIMEDOUT') throw new Error(`命令超时（${options.timeoutMs}ms）：${resolved.file}`);
      throw result.error;
    }
    return { code: result.status, stdout, stderr };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    await rm(outPath, { force: true }).catch(() => undefined);
    await rm(errPath, { force: true }).catch(() => undefined);
  }
}

/** 降级模式：长驻进程 —— 文件句柄重定向 + 轮询读增量。 */
function spawnWithFiles(resolved: ResolvedCommand, options: RunOptions): StreamingHandle {
  const dir = options.captureDir ?? path.join(os.tmpdir(), 'whalelauncher-capture');
  const base = path.join(dir, `stream-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const outPath = `${base}.out`;
  const errPath = `${base}.err`;
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const tail = new FileTail({ stdout: outPath, stderr: errPath }, options.onLog);
  const child = spawn(resolved.file, resolved.args, {
    cwd: options.cwd,
    windowsVerbatimArguments: resolved.verbatim === true,
    env: buildEnv(options.env),
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => killTree(child.pid, child), options.timeoutMs);
  /*
   * `error` 与 `close` **都会**触发收尾，而收尾里有 `closeSync`。
   * 没有这个守卫就会关闭同一个 fd 两次 —— 更糟的是：第二次调用时该 fd 号可能已经被
   * 另一个并发 spawn 复用，于是被关掉的是**别人**的捕获文件句柄（8 个实例并发启动时
   * 实测复现 `EBADF: bad file descriptor, close`）。因此收尾必须是幂等的。
   */
  let settled = false;
  const finish = async (code: number | null): Promise<number | null> => {
    if (settled) return code;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    await tail.drain();
    tail.dispose();
    closeSync(outFd);
    closeSync(errFd);
    await rm(outPath, { force: true }).catch(() => undefined);
    await rm(errPath, { force: true }).catch(() => undefined);
    return code;
  };
  return {
    pid: child.pid ?? -1,
    exited: new Promise<number | null>((resolve) => {
      child.on('error', () => void finish(null).then(resolve));
      child.on('close', (code) => void finish(code).then(resolve));
    }),
    kill: () => killTree(child.pid, child),
    isAlive: () => isAlive(child.pid),
  };
}

/**
 * 轮询文件增量的流式捕获器。
 *
 * 降级模式下没有管道，靠每 300ms 读一次新增字节把输出喂给 `onLog`。
 */
class FileTail {
  private readonly paths: { stdout: string; stderr: string };
  private readonly onLog: ProcLogSink | undefined;
  private readonly offsets = { stdout: 0, stderr: 0 };
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private readonly timer: NodeJS.Timeout;

  /**
   * @param paths 两个流的临时文件路径。
   * @param onLog 输出回调。
   */
  constructor(paths: { stdout: string; stderr: string }, onLog: ProcLogSink | undefined) {
    // 不用 TS 参数属性：Node 的类型擦除（strip-only）不支持该语法，测试直接 import 源码会失败
    this.paths = paths;
    this.onLog = onLog;
    this.timer = setInterval(() => void this.drain(), 300);
    this.timer.unref?.();
  }

  /** 读取两个流的新增内容并回调。 */
  async drain(): Promise<void> {
    await this.pull('stdout');
    await this.pull('stderr');
  }

  /** 释放资源（含冲刷解码器尾部残字节）。 */
  dispose(): void {
    clearInterval(this.timer);
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.decoders[stream].end();
      if (tail.length > 0) this.onLog?.(stream, tail);
    }
  }

  /** 拉取单个流的新增字节。 */
  private async pull(stream: 'stdout' | 'stderr'): Promise<void> {
    const file = this.paths[stream];
    const offset = this.offsets[stream];
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, 'r');
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      this.offsets[stream] = offset + bytesRead;
      const text = this.decoders[stream].write(buffer.subarray(0, bytesRead));
      if (text.length > 0) this.onLog?.(stream, text);
    } catch {
      // 读取失败（文件尚未落盘等）留待下一轮
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }
}

/** 组装子进程环境变量。 */
function buildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

/**
 * 判断进程是否存活。
 * @param pid 目标进程 PID。
 * @returns 是否存活。
 */
export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 终止进程树。
 *
 * ### 顺序（重要，别调换）
 * ```
 * 1. taskkill /pid <pid> /T /F   ← 必须在"根还活着"时执行
 * 2. child.kill('SIGKILL')       ← taskkill 被拒时的可靠兜底
 * 3. process.kill(pid,'SIGKILL') ← 无 child 句柄时的最后兜底
 * 4. 轮询确认进程是否真的消失
 * ```
 * **为什么树杀必须排在杀根之前**：Windows 上 `taskkill /T` 是"从根 PID 解析进程树"，
 * 根一旦先死就再也遍历不出孙进程；而 Windows 在父进程死亡时**不会**自动收走子进程
 * （除非用 Job Object）。若先 `child.kill()`，则在 taskkill 可用的普通环境里反而
 * **丢掉孙进程清理**——恰是树杀本该生效的场景。因此先树杀、后杀根：
 *  - taskkill 可用 → 整棵树（含 dsh 拉起的 npm/pnpm/shell 孙进程）被收走；
 *  - taskkill 被拒（本机受限沙箱实测 `taskkill` 退出码 1 且进程仍存活）→ 回退
 *    `child.kill('SIGKILL')`（实测有效），行为与"只杀直接子进程"一致。
 *
 * 进程仍然存活时先做树杀还有第二个好处：此刻该 PID 一定是我们自己的子进程，
 * 避免"根已退出、PID 被系统复用后误杀无关进程"的风险。
 *
 * 本机实测（受限沙箱）：`child.kill('SIGKILL')` 与 `process.kill(pid,'SIGKILL')` 均成功，
 * `taskkill` 恒定 Access denied（对存活的根与已死的根都是），因此本环境**测不出**顺序差异。
 *
 * 补充（shell-engineer 对照实验结论，已交叉确认）：本沙箱对进程树有 **job object 级别的
 * 自动包容** —— 孙进程在父进程正常退出（exit 0）后也会消失，孤儿进程结构性不可能存在。
 * 因此"树杀是否生效"在本会话内**原理上不可观测**（不是实现问题）。要验证顺序收益只能在
 * 沙箱外的普通 shell 里跑，期望：taskkill 成功 → 孙进程被一并收走。
 * `tests/core/degraded-records.test.mjs` 有一条覆盖"根→孙"两级的用例，用例名已标注
 * "本沙箱必然通过、无区分力，真环境才具区分力"，避免被误读为已验证。
 * @param pid 目标进程 PID。
 * @param child 直接子进程对象（可选，但强烈建议传）。
 * @returns 是否确认已终止。
 */
export function killTree(pid: number | undefined, child?: ChildProcess): boolean {
  const validPid = pid !== undefined && pid > 0;
  // 用"自己的 child 句柄"判断子进程是否仍在运行：比 isAlive(pid) 可靠，且不存在 PID 复用问题
  const childRunning = child === undefined ? validPid : child.exitCode === null && child.signalCode === null;

  // 1) 先树杀：taskkill /T 只能从活着的根遍历，必须在杀根之前
  if (validPid && childRunning && process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // taskkill 不可用（被沙箱/权限拒绝）→ 继续走下面的兜底
    }
  }

  // 2) 直接终止自己拉起的子进程（最可靠的一步）
  if (child !== undefined && childRunning) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能已经退出
    }
  }

  // 3) 最后兜底：仅当确认它还没死、且没有 PID 复用风险时才动手
  if (validPid && childRunning && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程可能已经退出
    }
  }

  return !isAlive(pid);
}

/**
 * 同步等待进程终止（Windows 上 TerminateProcess 之后需要极短时间收敛）。
 * @param pid 目标进程 PID。
 * @param timeoutMs 最长等待。
 * @returns 是否已终止。
 */
export function waitForExit(pid: number | undefined, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    sleepSync(60);
  }
  return !isAlive(pid);
}

/** 同步睡眠（仅用于短暂的终止确认，避免引入异步复杂度）。 */
function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** 同步判断是否为已存在的文件（仅用于命令解析）。 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 判断错误是否为「命名管道被拒」（沙箱 EPERM）。 */
function isPipeDenied(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP';
}

/** 保留引用：`ChildProcess` 类型用于显式标注长驻进程（避免误用 sync API）。 */
export type ProcChild = ChildProcess;
