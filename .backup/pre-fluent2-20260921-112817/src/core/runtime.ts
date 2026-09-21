/**
 * WhalesLauncher core —— 实例运行时状态登记表
 *
 * 进程内单例状态（启动中的 PID、探测到的界面地址、最近退出码等）。
 * 单独成模块是为了让 `instance.ts` 与 `launch.ts` 都能读写它而**不互相 import**
 * （避免循环依赖）。核心引擎不持有跨进程状态，进程重启即回到 `stopped`。
 */
import type { InstanceRuntime, InstanceState } from '../shared/contracts';

/** instanceId → 运行时状态。 */
const registry = new Map<string, InstanceRuntime>();

/** 创建一个"未运行"的默认状态。 */
function stoppedRuntime(instanceId: string): InstanceRuntime {
  return {
    instanceId,
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    port: null,
    exitCode: null,
    lastError: null,
  };
}

/**
 * 读取某个实例的运行时状态（未登记过时返回 `stopped` 默认值，不写入登记表）。
 * @param instanceId 实例 id。
 * @returns 运行时状态快照（副本）。
 */
export function runtimeOf(instanceId: string): InstanceRuntime {
  const current = registry.get(instanceId);
  return current === undefined ? stoppedRuntime(instanceId) : { ...current };
}

/**
 * 列出所有已登记的运行时状态。
 * @returns 运行时状态数组。
 */
export function listRuntimes(): InstanceRuntime[] {
  return [...registry.values()].map((item) => ({ ...item }));
}

/**
 * 局部更新运行时状态并与旧值合并。
 * @param instanceId 实例 id。
 * @param patch 待合并字段。
 * @returns 合并后的状态快照。
 */
export function patchRuntime(instanceId: string, patch: Partial<InstanceRuntime>): InstanceRuntime {
  const current = registry.get(instanceId) ?? stoppedRuntime(instanceId);
  const next: InstanceRuntime = { ...current, ...patch, instanceId };
  registry.set(instanceId, next);
  return { ...next };
}

/**
 * 设置状态字段（`lastError` 与 `exitCode` 可按需清理）。
 * @param instanceId 实例 id。
 * @param state 新状态。
 * @param extra 附加字段。
 * @returns 合并后的状态快照。
 */
export function setRuntimeState(
  instanceId: string,
  state: InstanceState,
  extra: Partial<InstanceRuntime> = {},
): InstanceRuntime {
  return patchRuntime(instanceId, { state, ...extra });
}

/**
 * 直接覆盖登记表条目（仅供 launch 内部与测试使用）。
 * @param runtime 完整运行时状态。
 */
export function putRuntime(runtime: InstanceRuntime): void {
  registry.set(runtime.instanceId, { ...runtime });
}

/**
 * 清理某个实例的运行时登记（测试与删除实例时使用）。
 * @param instanceId 实例 id。
 */
export function clearRuntime(instanceId: string): void {
  registry.delete(instanceId);
}
