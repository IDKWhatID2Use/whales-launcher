/**
 * 日志/状态推送与退出清理 —— 等价搬运自旧主进程 `runtime.ts`（该文件用 Electron
 * 的 `BrowserWindow.webContents.send` 推送，见 runtime.ts L11/L49-L63）。
 *
 * 传输层替换为协议 §2.4 的事件：
 *   `log:chunk` ← 旧 `CH.log.chunk`，`log:state` ← 旧 `CH.log.state`。
 * 事件**无 id、无响应**，形状与旧 `LogChunk` / `InstanceRuntime` 逐字段一致，
 * 因此 core 的 `LogSink` / `onState` 钩子可以原样接上。
 *
 * 退出清理语义（runtime.ts 的核心承诺，绝不丢）：**绝不留孤儿 dsh 进程** ——
 * 正常退出先 `stopAll()` 优雅停止，再由 {@link forceKillLeftovers} 兜底强杀。
 */
import { spawnSync } from 'node:child_process';
import { core } from '../../src/core/index.ts';
import { CH } from '../../src/shared/contracts.ts';
import { writeLine } from './stdio.mjs';

/** 不属于任何实例的日志（引擎安装、实例包导入等）使用的伪 id。来源：runtime.ts L18 */
export const LAUNCHER_LOG_ID = 'launcher';

/** 已登记的 dsh 子进程：PID → 实例 id（对应 runtime.ts L23 的 liveChildPids）。 */
const liveChildPids = new Map();

/* ------------------------------------------------------------------ *
 * 事件推送（对应 runtime.ts L48-L76 的 send/broadcastLog/broadcastState/systemLog）
 * ------------------------------------------------------------------ */

/**
 * 推送一条事件（无 id、无响应）。
 * @param {string} name 事件名（协议 §2.4）。
 * @param {unknown} data 事件载荷。
 */
function sendEvent(name, data) {
  return writeLine({ event: name, data });
}

/** 日志分片。 */
export function broadcastLog(chunk) {
  return sendEvent(CH.log.chunk, chunk);
}

/** 实例运行时状态变更。 */
export function broadcastState(runtime) {
  return sendEvent(CH.log.state, runtime);
}

/** 一条系统级日志（启动器自己产生的事件，例如进程退出）。来源：runtime.ts L74-L76 */
export function systemLog(instanceId, text) {
  return broadcastLog({ instanceId, stream: 'system', text, ts: new Date().toISOString() });
}

/**
 * 实例日志下沉口：core 通过它把子进程输出交给宿主。来源：runtime.ts L83-L88
 * @param {string} instanceId 实例 id。
 * @returns {(stream: 'stdout'|'stderr'|'system', text: string) => void} LogSink。
 */
export function logSink(instanceId) {
  return (stream, text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    broadcastLog({ instanceId, stream, text, ts: new Date().toISOString() });
  };
}

/* ------------------------------------------------------------------ *
 * core 启动钩子（对应 runtime.ts L90-L117）
 * ------------------------------------------------------------------ */

/**
 * `core.launchInstance` 需要的三个钩子：状态/日志实时推给宿主，并记账 PID。
 * @param {string} instanceId 实例 id。
 */
export function launchHooks(instanceId) {
  return {
    onLog: logSink(instanceId),
    onState: (runtime) => {
      track(runtime);
      broadcastState(runtime);
    },
    onExit: (code) => {
      untrack(instanceId);
      systemLog(instanceId, `进程已退出（退出码：${code === null ? '未知' : code}）。`);
      // core 在 onExit 之后才会把最终状态写进运行时表，稍等一拍再推一次（runtime.ts L108）。
      setTimeout(() => {
        try {
          broadcastState(core.runtimeOf(instanceId));
        } catch (error) {
          console.warn('[bridge] 退出后同步状态失败：', error);
        }
      }, 250);
    },
  };
}

function track(runtime) {
  if (typeof runtime.pid === 'number' && runtime.pid > 0) {
    liveChildPids.set(runtime.pid, runtime.instanceId);
  }
}

function untrack(instanceId) {
  for (const [pid, id] of liveChildPids) {
    if (id === instanceId) liveChildPids.delete(pid);
  }
}

/** 仍在记账中的子进程 PID（诊断用）。来源：runtime.ts L132-L134 */
export function trackedPids() {
  return [...liveChildPids.keys()];
}

/** 非 stopped 状态的实例数量。来源：runtime.ts L137-L144 */
export function runningCount() {
  try {
    return core.listRuntimes().filter((runtime) => runtime.state !== 'stopped').length;
  } catch (error) {
    console.warn('[bridge] 统计运行中实例失败：', error);
    return liveChildPids.size;
  }
}

/* ------------------------------------------------------------------ *
 * 退出清理（对应 runtime.ts L150-L201 / L211-L232）
 * ------------------------------------------------------------------ */

/**
 * 停止所有由本侧车拉起的实例（每个实例带超时，避免卡住退出）。
 * @param {number} timeoutMs 单实例停止上限。
 * @returns {Promise<{stopped: string[], failed: string[]}>} 报告。
 */
export async function stopAll(timeoutMs = 10_000) {
  const stopped = [];
  const failed = [];

  let runtimes = [];
  try {
    runtimes = core.listRuntimes();
  } catch (error) {
    console.warn('[bridge] 读取运行时列表失败：', error);
  }

  const targets = runtimes.filter((r) => r.state !== 'stopped' || r.pid !== null);
  await Promise.all(
    targets.map(async (runtime) => {
      const id = runtime.instanceId;
      try {
        await withTimeout(core.stopInstance(id), timeoutMs, `停止实例 ${id} 超时（${timeoutMs}ms）`);
      } catch (error) {
        failed.push(id);
        console.warn(`[bridge] 停止实例 ${id} 失败：`, error);
        return;
      }
      // `core.stopInstance` 按契约返回 void 且从不拒绝：进程杀不掉时它把真相放在运行时状态里
      // （state 保持 running + lastError）。这里必须复核，否则日志会谎报"已停止"。
      let after;
      try {
        after = core.runtimeOf(id);
      } catch (error) {
        console.warn(`[bridge] 复核实例 ${id} 状态失败：`, error);
        stopped.push(id);
        return;
      }
      if (after.state === 'stopped' || after.pid === null) {
        stopped.push(id);
      } else {
        failed.push(id);
        console.warn(`[bridge] 实例 ${id} 未能停止：${after.lastError ?? '进程仍在运行'}`);
      }
    }),
  );

  return { stopped, failed };
}

/**
 * 退出兜底：强杀所有仍存活的 dsh 子进程（"绝不留孤儿进程"的最后一道防线）。
 *
 * 两段式终止，且**只在确认进程消失后才报告成功**（runtime.ts L211-L232）：
 *  1. `taskkill /T /F` —— Windows 上连带子树（dsh 可能派生了孙进程）；
 *  2. `process.kill(pid,'SIGKILL')` —— 受限环境下 taskkill 可能被拒绝，用原生终止兜底。
 */
export function forceKillLeftovers() {
  const tracked = [...liveChildPids.entries()];
  liveChildPids.clear();
  // 取一次运行时快照：既避免逐个 PID 重复调用，也让"是否登记过"与"状态/PID"来自同一份事实。
  const runtimes = registeredRuntimes();

  for (const [pid, instanceId] of tracked) {
    if (!isAlive(pid)) continue;
    const ownership = checkOwnership(pid, instanceId, runtimes);
    if (!ownership.ours) {
      console.warn(`[bridge] 跳过 PID ${pid}：${ownership.reason}，避免 PID 复用后误杀无关进程。`);
      continue;
    }
    if (terminateTree(pid)) {
      console.warn(`[bridge] 已强制结束残留 dsh 子进程 PID ${pid}（实例 ${instanceId}）。`);
    } else {
      console.error(
        `[bridge] 无法结束残留子进程 PID ${pid}（实例 ${instanceId}），请手动在任务管理器中结束它，避免后台残留。`,
      );
    }
  }
}

/** 运行时快照；读不到时返回 null（按"查不到状态"处理）。来源：runtime.ts L237-L244 */
function registeredRuntimes() {
  try {
    return core.listRuntimes();
  } catch (error) {
    console.warn('[bridge] 读取运行时列表失败，PID 归属将按原逻辑处理：', error);
    return null;
  }
}

/**
 * 复核这个 PID 是否仍是「我们记账的那个实例」的进程（避免 PID 复用后误杀无关进程）。
 * 来源：runtime.ts L257-L282（只用 `listRuntimes()` 而不用 `runtimeOf()` 的理由见原注释）。
 */
function checkOwnership(pid, instanceId, runtimes) {
  if (runtimes === null) return { ours: true };

  const registered = runtimes.find((item) => item.instanceId === instanceId);
  if (registered === undefined) {
    return { ours: false, reason: `core 无实例 ${instanceId} 的运行记录（该实例已退出或从未登记）` };
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

/** 先按进程树杀，失败再直接终止；返回是否确认已消失。来源：runtime.ts L285-L303 */
function terminateTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      console.warn(`[bridge] taskkill 调用失败（PID ${pid}）：`, error);
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

/** 等待进程消失（同步等待：退出阶段无法 await）。来源：runtime.ts L309-L324 */
function waitGone(pid, timeoutMs = TERMINATE_TIMEOUT_MS) {
  const attempts = Math.ceil(timeoutMs / TERMINATE_POLL_MS);
  for (let index = 0; index < attempts; index += 1) {
    if (!isAlive(pid)) return true;
    sleepSync(TERMINATE_POLL_MS);
  }
  return !isAlive(pid);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 无法同步等待时退化为忙等一次，不影响正确性 */
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 给 Promise 加超时。来源：runtime.ts L335-L348 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
