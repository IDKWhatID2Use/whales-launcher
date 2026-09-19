/**
 * 子进程与日志流编排。
 *
 * 职责边界：
 *  - core 负责「怎么跑 dsh」（spawn、解析输出、维护状态）；
 *  - main 负责「把结果推到界面」（log:chunk / log:state）与「退出时收干净」。
 *
 * 因此 core 的启动钩子（onLog / onState / onExit）在这里被包装成广播，
 * 并把由本启动器拉起的 PID 记账，供退出兜底强杀使用 —— 杜绝孤儿进程。
 */
import { BrowserWindow } from 'electron';
import { spawnSync } from 'node:child_process';
import { core } from '../core/index.js';
import { CH } from '../shared/contracts.js';
import type { InstanceRuntime, LogChunk, LogSink } from '../shared/contracts.js';

/** 不属于任何实例的日志（引擎安装、实例包导入等）使用的伪 id。 */
export const LAUNCHER_LOG_ID = 'launcher';

/** 已登记的窗口；关闭的窗口会在下一次广播时顺手清理。 */
const windows = new Set<BrowserWindow>();
/** 由本启动器拉起、尚未确认退出的子进程：PID → 实例 id。 */
const liveChildPids = new Map<number, string>();

/* ------------------------------------------------------------------ *
 * 窗口登记与广播
 * ------------------------------------------------------------------ */

export function attachWindow(win: BrowserWindow): void {
  windows.add(win);
}

export function detachWindow(win: BrowserWindow): void {
  windows.delete(win);
}

/** 遍历所有存活窗口（主题同步、批量刷新等用）；顺手清理已销毁的窗口。 */
export function forEachWindow(visit: (win: BrowserWindow) => void): void {
  for (const win of windows) {
    if (win.isDestroyed()) {
      windows.delete(win);
      continue;
    }
    visit(win);
  }
}

/** 向所有存活窗口推送；窗口已销毁则静默跳过（绝不向死窗口 send）。 */
function send(channel: string, payload: unknown): void {
  for (const win of windows) {
    if (win.isDestroyed()) {
      windows.delete(win);
      continue;
    }
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) continue;
    try {
      contents.send(channel, payload);
    } catch (error) {
      console.warn(`[runtime] 推送 ${channel} 失败：`, error);
    }
  }
}

export function broadcastLog(chunk: LogChunk): void {
  send(CH.log.chunk, chunk);
}

export function broadcastState(runtime: InstanceRuntime): void {
  send(CH.log.state, runtime);
}

/** 一条系统级日志（启动器自己产生的事件，例如进程退出）。 */
export function systemLog(instanceId: string, text: string): void {
  broadcastLog({ instanceId, stream: 'system', text, ts: new Date().toISOString() });
}

/* ------------------------------------------------------------------ *
 * core 钩子
 * ------------------------------------------------------------------ */

/** 实例日志下沉口：core 通过它把子进程输出交给 main。 */
export function logSink(instanceId: string): LogSink {
  return (stream, text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    broadcastLog({ instanceId, stream, text, ts: new Date().toISOString() });
  };
}

export interface LaunchHooks {
  onLog: LogSink;
  onState: (runtime: InstanceRuntime) => void;
  onExit: (code: number | null) => void;
}

/** core.launchInstance 需要的三个钩子：状态/日志实时推给所有窗口，并记账 PID。 */
export function launchHooks(instanceId: string): LaunchHooks {
  return {
    onLog: logSink(instanceId),
    onState: (runtime) => {
      track(runtime);
      broadcastState(runtime);
    },
    onExit: (code) => {
      untrack(instanceId);
      systemLog(instanceId, `进程已退出（退出码：${code === null ? '未知' : code}）。`);
      // core 在 onExit 之后才会把最终状态写进运行时表，稍等一拍再推一次。
      setTimeout(() => {
        try {
          broadcastState(core.runtimeOf(instanceId));
        } catch (error) {
          console.warn('[runtime] 退出后同步状态失败：', error);
        }
      }, 250);
    },
  };
}

function track(runtime: InstanceRuntime): void {
  if (typeof runtime.pid === 'number' && runtime.pid > 0) {
    liveChildPids.set(runtime.pid, runtime.instanceId);
  }
}

function untrack(instanceId: string): void {
  for (const [pid, id] of liveChildPids) {
    if (id === instanceId) liveChildPids.delete(pid);
  }
}

/** 仍在记账中的子进程 PID（供诊断/测试）。 */
export function trackedPids(): number[] {
  return [...liveChildPids.keys()];
}

/** 非 stopped 状态的实例数量（关闭窗口前的提醒用）。 */
export function runningCount(): number {
  try {
    return core.listRuntimes().filter((runtime) => runtime.state !== 'stopped').length;
  } catch (error) {
    console.warn('[runtime] 统计运行中实例失败：', error);
    return liveChildPids.size;
  }
}

/* ------------------------------------------------------------------ *
 * 退出清理
 * ------------------------------------------------------------------ */

export interface StopAllReport {
  stopped: string[];
  failed: string[];
}

/**
 * 停止所有由本启动器启动的实例。
 * 每个实例的停止都带超时，避免"某个实例卡住 → 启动器永远退不出去"。
 */
export async function stopAll(timeoutMs = 10_000): Promise<StopAllReport> {
  const stopped: string[] = [];
  const failed: string[] = [];

  let runtimes: InstanceRuntime[] = [];
  try {
    runtimes = core.listRuntimes();
  } catch (error) {
    console.warn('[runtime] 读取运行时列表失败：', error);
  }

  const targets = runtimes.filter((r) => r.state !== 'stopped' || r.pid !== null);
  await Promise.all(
    targets.map(async (runtime) => {
      const id = runtime.instanceId;
      try {
        await withTimeout(core.stopInstance(id), timeoutMs, `停止实例 ${id} 超时（${timeoutMs}ms）`);
      } catch (error) {
        failed.push(id);
        console.warn(`[runtime] 停止实例 ${id} 失败：`, error);
        return;
      }
      // `core.stopInstance` 按契约返回 void 且从不拒绝：进程杀不掉时它把真相放在运行时状态里
      // （state 保持 running + lastError）。这里必须复核，否则日志会谎报"已停止"。
      let after: InstanceRuntime;
      try {
        after = core.runtimeOf(id);
      } catch (error) {
        console.warn(`[runtime] 复核实例 ${id} 状态失败：`, error);
        stopped.push(id);
        return;
      }
      if (after.state === 'stopped' || after.pid === null) {
        stopped.push(id);
      } else {
        failed.push(id);
        console.warn(`[runtime] 实例 ${id} 未能停止：${after.lastError ?? '进程仍在运行'}`);
      }
    }),
  );

  return { stopped, failed };
}

/**
 * 进程即将结束时的兜底：强杀所有仍存活的 dsh 子进程。
 * 只在 `will-quit` 阶段调用，属于"最后一道防线"，正常路径不会走到这里。
 *
 * 两段式终止，且**只在确认进程消失后才报告成功**：
 *  1. `taskkill /T /F` —— Windows 上连带子树（dsh 可能派生了孙进程）；
 *  2. `process.kill(pid,'SIGKILL')` —— 受限环境下 taskkill 可能被拒绝，用原生终止兜底。
 */
export function forceKillLeftovers(): void {
  const tracked = [...liveChildPids.entries()];
  liveChildPids.clear();
  // 取一次运行时快照：既避免逐个 PID 重复调用，也让"是否登记过"与"状态/PID"来自同一份事实。
  const runtimes = registeredRuntimes();

  for (const [pid, instanceId] of tracked) {
    if (!isAlive(pid)) continue;
    const ownership = checkOwnership(pid, instanceId, runtimes);
    if (!ownership.ours) {
      console.warn(`[runtime] 跳过 PID ${pid}：${ownership.reason}，避免 PID 复用后误杀无关进程。`);
      continue;
    }
    if (terminateTree(pid)) {
      console.warn(`[runtime] 已强制结束残留 dsh 子进程 PID ${pid}（实例 ${instanceId}）。`);
    } else {
      console.error(
        `[runtime] 无法结束残留子进程 PID ${pid}（实例 ${instanceId}），请手动在任务管理器中结束它，避免后台残留。`,
      );
    }
  }
}

type Ownership = { ours: true } | { ours: false; reason: string };

/** 运行时快照；读不到时返回 null，调用方按"查不到状态"处理。 */
function registeredRuntimes(): InstanceRuntime[] | null {
  try {
    return core.listRuntimes();
  } catch (error) {
    console.warn('[runtime] 读取运行时列表失败，PID 归属将按原逻辑处理：', error);
    return null;
  }
}

/**
 * 复核这个 PID 是否仍是「我们记账的那个实例」的进程。
 *
 * 为什么要复核：main 手里只有 PID（拿不到 core 的 `ChildProcess` 句柄），而 PID 在进程退出后
 * 可能被系统复用 —— 直接按 PID 强杀有**误杀无关进程**的风险（core 侧用 `child.exitCode/signalCode`
 * 守卫解决，那条路 main 走不了）。core 的运行时登记表是唯一事实源：
 * 它没有该实例的记录、说实例已停、或 PID 对不上，就绝不碰这个 PID。
 *
 * 注意**只用 `listRuntimes()` 而不用 `runtimeOf()`**：后者对"从未登记过的实例"也会返回
 * `stopped` 默认值，会把"没有记录"误报成"已停止" —— 日志必须说清是哪一种。
 */
function checkOwnership(
  pid: number,
  instanceId: string,
  runtimes: InstanceRuntime[] | null,
): Ownership {
  // 查不到状态时保持原有行为（宁可清掉残留进程，也不留后台孤儿）。
  if (runtimes === null) return { ours: true };

  const registered = runtimes.find((item) => item.instanceId === instanceId);
  if (registered === undefined) {
    return {
      ours: false,
      reason: `core 无实例 ${instanceId} 的运行记录（该实例已退出或从未登记）`,
    };
  }
  if (registered.state === 'stopped') {
    return { ours: false, reason: `core 记录的实例 ${instanceId} 已停止` };
  }
  if (registered.pid !== pid) {
    return {
      ours: false,
      reason: `core 记录的 PID（${registered.pid ?? '无'}）与记账 PID（${pid}）不一致`,
    };
  }
  return { ours: true };
}

/** 先按进程树杀，失败再直接终止；返回是否确认已消失。 */
function terminateTree(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      console.warn(`[runtime] taskkill 调用失败（PID ${pid}）：`, error);
    }
    if (waitGone(pid)) return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经退出 */
  }
  return waitGone(pid);
}

const TERMINATE_POLL_MS = 25;
const TERMINATE_TIMEOUT_MS = 300;

/** 等待进程消失（同步等待：退出阶段无法 await）。 */
function waitGone(pid: number, timeoutMs = TERMINATE_TIMEOUT_MS): boolean {
  const attempts = Math.ceil(timeoutMs / TERMINATE_POLL_MS);
  for (let index = 0; index < attempts; index += 1) {
    if (!isAlive(pid)) return true;
    sleepSync(TERMINATE_POLL_MS);
  }
  return !isAlive(pid);
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 无法同步等待时退化为忙等一次，不影响正确性 */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
