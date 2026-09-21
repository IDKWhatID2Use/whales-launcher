/**
 * 共享设置冲突的渲染层接入（QR-15）
 *
 * 背景：core 做到「不静默覆盖、保留本地并登记冲突」后，如果界面不提示，
 * 用户只会感觉"切了共享却什么都没发生" —— 问题从"静默丢数据"变成"静默不生效"。
 * 本模块把冲突模型接进界面：能力探测 → 空值降级 → 统一 Result 处理。
 *
 * 契约（Lead 已冻结）：`window.whales.settings.shareConflicts` /
 * `resolveShareConflict`；类型 `ShareConflict` / `ShareConflictResolution` 定义在
 * `src/shared/contracts.ts`。IPC 层保证 `core` 的同步实现被包成 Promise。
 */
import type { ShareConflict, ShareConflictResolution, Result } from '../../shared/contracts';
import { backend } from './api';
import { attempt } from '../util/result';

export type { ShareConflict, ShareConflictResolution };

export interface ShareConflictApi {
  list(instanceId: string): Promise<Result<ShareConflict[]>>;
  resolve(instanceId: string, resolution: ShareConflictResolution): Promise<Result<void>>;
}

/**
 * 取得冲突 API。两种后端都要覆盖：
 *   - **真实模式**（存在 `window.whales`）：必须确认 preload 真的暴露了这两个方法，
 *     否则返回 null（不假报能力）；
 *   - **演示模式**（无 `window.whales`）：演示后端已实现该契约，直接可用，
 *     否则演示预览里看不到冲突形态、冒烟也无法覆盖。
 * 后端未接线且非演示时返回 null，界面静默降级。
 */
export function conflictApi(): ShareConflictApi | null {
  const whales = (window as unknown as { whales?: Record<string, unknown> }).whales;
  if (whales) {
    const settings = whales['settings'] as Record<string, unknown> | undefined;
    const hasList = typeof settings?.['shareConflicts'] === 'function';
    const hasResolve = typeof settings?.['resolveShareConflict'] === 'function';
    if (!hasList || !hasResolve) return null;
  }
  const api = backend().api;
  return {
    list: (instanceId) => attempt(api.settings.shareConflicts(instanceId)),
    resolve: (instanceId, resolution) => attempt(api.settings.resolveShareConflict(instanceId, resolution)),
  };
}

/** 冲突能力是否可用（供界面决定"无冲突"文案是否展示）。 */
export function conflictsSupported(): boolean {
  return conflictApi() !== null;
}

/** 判断一条记录是否是设置冲突（防御后端返回非预期结构）。 */
export function isSettingsConflict(value: unknown): value is ShareConflict {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['instanceId'] === 'string' &&
    record['resource'] === 'settings' &&
    typeof record['message'] === 'string'
  );
}

/** 规范化后端返回值：过滤坏记录，避免一条脏数据让整个提示消失。 */
export function normalizeConflicts(value: unknown): ShareConflict[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSettingsConflict);
}

/** 两个解决方式的文案（含"谁会覆盖谁"与备份说明），UI 与提示共用一处。 */
export const RESOLUTION_TEXT: Record<
  ShareConflictResolution,
  { label: string; effect: string; detail: string }
> = {
  'use-local': {
    label: '使用本地设置',
    effect: '用本实例的设置覆盖共享文件',
    detail:
      '将把本实例的 settings.yaml 写入共享设置文件，其它共享该文件的实例也会随之改变。覆盖前会自动生成 .bak-<时间戳> 备份。',
  },
  'use-shared': {
    label: '使用共享设置',
    effect: '用共享文件覆盖本实例的设置',
    detail:
      '将用共享设置覆盖本实例的 settings.yaml，本实例当前的本地修改会被替换。覆盖前会自动生成 .bak-<时间戳> 备份，可从实例 home 目录恢复。',
  },
};
