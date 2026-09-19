/**
 * 应用状态（单一事实源）
 *
 * - 只暴露 `get()` / `subscribe()` 与一组具名动作，视图不直接改状态；
 * - 变更通知经微批处理合并，避免一次事件多视图重绘；
 * - 所有网络/IPC 失败都会落进状态或提示，绝不静默。
 */
import type { InstanceRuntime, InstanceSummary, LauncherConfig, LogChunk, ShareConflict, ShareConflictResolution } from '../../shared/contracts';
import { toastError, toastSuccess, toastWarning } from '../components/toast';
import { createBatcher } from '../util/batch';
import { attempt } from '../util/result';
import { backend } from './api';
import { demoSeedLogs } from './demo';
import { LAUNCHER_LOG_ID, logStore } from './logs';
import { conflictApi } from './share-conflicts';

export interface AppState {
  /** 首次数据装载是否完成。 */
  ready: boolean;
  /** 是否运行在内置演示数据模式。 */
  demo: boolean;
  demoReason: string | null;
  appVersion: string;
  config: LauncherConfig | null;
  instances: InstanceSummary[];
  /** 实时运行态（来自 onState 推送，按实例 id 索引）。 */
  runtimes: Map<string, InstanceRuntime>;
  loadingInstances: boolean;
  loadingConfig: boolean;
  /** 实例列表装载失败的原因（界面展示重试入口）。 */
  loadError: string | null;
  /** 共享设置冲突（QR-15）：instanceId → 冲突列表；后端未接线时恒为空。 */
  conflicts: Map<string, ShareConflict[]>;
  /** 冲突能力是否可用（false 时界面不显示"无冲突"之类的假保证）。 */
  conflictsAvailable: boolean;
}

const EMPTY_RUNTIME: InstanceRuntime = {
  instanceId: '',
  state: 'stopped',
  pid: null,
  startedAt: null,
  url: null,
  port: null,
  exitCode: null,
  lastError: null,
};

export class AppStore {
  private state: AppState = {
    ready: false,
    demo: false,
    demoReason: null,
    appVersion: '',
    config: null,
    instances: [],
    runtimes: new Map(),
    loadingInstances: true,
    loadingConfig: true,
    loadError: null,
    conflicts: new Map(),
    conflictsAvailable: false,
  };

  private readonly listeners = new Set<() => void>();
  private readonly notifyBatched = createBatcher(() => {
    for (const fn of this.listeners) fn();
  });
  private readonly disposers: Array<() => void> = [];
  /** 已提示过的启动器级日志文本（去重） */
  private readonly launcherNotices = new Set<string>();
  private inited = false;

  get(): Readonly<AppState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 启动：探测后端、订阅推送、装载配置与实例列表。 */
  async init(): Promise<void> {
    if (this.inited) return;
    this.inited = true;

    const handle = backend();
    this.patch({ demo: handle.demo, demoReason: handle.reason });

    this.disposers.push(
      handle.api.onLog((chunk) => {
        logStore.push(chunk);
        this.surfaceLauncherNotice(chunk);
      }),
    );
    this.disposers.push(handle.api.onState((runtime) => this.mergeRuntime(runtime)));

    if (handle.demo) {
      // 演示模式无历史推送，这里补一段启动日志，让运行中实例的日志页立即有内容
      logStore.pushMany(demoSeedLogs());
    }

    await Promise.all([this.refreshConfig(), this.refreshInstances(), this.loadAppVersion()]);
    this.patch({ ready: true });
  }

  dispose(): void {
    for (const off of this.disposers) {
      try {
        off();
      } catch {
        /* 退订失败不影响退出 */
      }
    }
    this.disposers.length = 0;
  }

  /**
   * 启动器级日志（`instanceId: 'launcher'`）的常规可见位置是日志抽屉，
   * 但像「launcher.json 损坏已自愈」这类提示用户必须立刻看到 —— 这里额外提示一次，
   * 同一文本只提示一次（去重），避免刷屏。
   */
  private surfaceLauncherNotice(chunk: LogChunk): void {
    if (chunk.instanceId !== LAUNCHER_LOG_ID || chunk.stream !== 'system') return;
    const text = chunk.text.trim();
    if (text.length === 0 || this.launcherNotices.has(text)) return;
    this.launcherNotices.add(text);
    toastWarning('启动器提示', { detail: text, timeout: 10_000 });
  }

  /* ── 查询 ─────────────────────────────────────────────────── */

  instanceById(id: string): InstanceSummary | null {
    return this.state.instances.find((s) => s.meta.id === id) ?? null;
  }

  runtimeOf(id: string): InstanceRuntime {
    const runtime = this.state.runtimes.get(id);
    if (runtime) return runtime;
    const summary = this.instanceById(id);
    if (summary) return summary.runtime;
    return { ...EMPTY_RUNTIME, instanceId: id };
  }

  isBusy(id: string): boolean {
    const state = this.runtimeOf(id).state;
    return state === 'starting' || state === 'stopping';
  }

  /* ── 动作 ─────────────────────────────────────────────────── */

  async refreshInstances(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) this.patch({ loadingInstances: true });
    const result = await attempt(backend().api.instance.list());
    if (result.ok) {
      const runtimes = new Map<string, InstanceRuntime>();
      for (const summary of result.value) runtimes.set(summary.meta.id, summary.runtime);
      this.patch({
        instances: result.value,
        runtimes,
        loadingInstances: false,
        loadError: null,
      });
      // 冲突在启动/应用共享模式时产生，随实例列表一并刷新
      await this.refreshConflicts();
    } else {
      this.patch({ loadingInstances: false, loadError: result.error });
    }
  }

  /* ── 共享设置冲突（QR-15） ────────────────────────────────── */

  /** 拉取全部实例的未解决冲突；后端未接线时清空并标记不可用。 */
  async refreshConflicts(): Promise<void> {
    const api = conflictApi();
    if (!api) {
      this.patch({ conflicts: new Map(), conflictsAvailable: false });
      return;
    }
    const conflicts = new Map<string, ShareConflict[]>();
    await Promise.all(
      this.state.instances.map(async (summary) => {
        const result = await api.list(summary.meta.id);
        if (result.ok && result.value.length > 0) {
          conflicts.set(summary.meta.id, result.value);
        }
      }),
    );
    this.patch({ conflicts, conflictsAvailable: true });
  }

  conflictsOf(instanceId: string): ShareConflict[] {
    return this.state.conflicts.get(instanceId) ?? [];
  }

  hasConflict(instanceId: string): boolean {
    return (this.state.conflicts.get(instanceId)?.length ?? 0) > 0;
  }

  /** 解决冲突：调用后端 → 成功后刷新冲突与设置页，失败弹可读错误。 */
  async resolveConflict(instanceId: string, resolution: ShareConflictResolution): Promise<boolean> {
    const api = conflictApi();
    if (!api) {
      toastError('当前后端不支持解决共享设置冲突', {
        detail: '请升级到包含 settings:resolveShareConflict 通道的版本。',
      });
      return false;
    }
    const result = await api.resolve(instanceId, resolution);
    if (!result.ok) {
      toastError('解决共享设置冲突失败', { detail: result.error });
      return false;
    }
    toastSuccess('共享设置冲突已解决', {
      detail: resolution === 'use-local' ? '共享设置已更新为本实例的内容（旧文件已备份）' : '本实例设置已更新为共享内容（旧文件已备份）',
    });
    await this.refreshConflicts();
    return true;
  }

  async refreshConfig(): Promise<void> {
    const result = await attempt(backend().api.launcher.getConfig());
    if (result.ok) {
      this.patch({ config: result.value, loadingConfig: false });
      applyTheme(result.value.theme);
    } else {
      this.patch({ loadingConfig: false });
    }
  }

  private async loadAppVersion(): Promise<void> {
    const result = await attempt(backend().api.app.version());
    if (result.ok) this.patch({ appVersion: result.value });
  }

  /** 保存全局配置：先乐观更新，失败回滚并提示。 */
  async saveConfig(patch: Partial<LauncherConfig>): Promise<LauncherConfig | null> {
    const previous = this.state.config;
    if (previous) this.patch({ config: { ...previous, ...patch } });
    const result = await attempt(backend().api.launcher.setConfig(patch));
    if (result.ok) {
      this.patch({ config: result.value });
      return result.value;
    }
    this.patch({ config: previous });
    toastError('保存全局设置失败', { detail: result.error });
    return null;
  }

  /** 合并实时运行态（同时更新列表视图与运行态索引）。 */
  mergeRuntime(runtime: InstanceRuntime): void {
    const runtimes = new Map(this.state.runtimes);
    runtimes.set(runtime.instanceId, runtime);
    const instances = this.state.instances.map((summary) =>
      summary.meta.id === runtime.instanceId ? { ...summary, runtime } : summary,
    );
    this.patch({ runtimes, instances });
  }

  upsertInstance(summary: InstanceSummary): void {
    const exists = this.state.instances.some((s) => s.meta.id === summary.meta.id);
    const instances = exists
      ? this.state.instances.map((s) => (s.meta.id === summary.meta.id ? summary : s))
      : [...this.state.instances, summary];
    const runtimes = new Map(this.state.runtimes);
    runtimes.set(summary.meta.id, summary.runtime);
    this.patch({ instances, runtimes });
  }

  forgetInstance(id: string): void {
    const runtimes = new Map(this.state.runtimes);
    runtimes.delete(id);
    this.patch({
      instances: this.state.instances.filter((s) => s.meta.id !== id),
      runtimes,
    });
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyBatched();
  }
}

/** 应用主题到根元素（立即生效，不依赖后端）。 */
export function applyTheme(theme: LauncherConfig['theme']): void {
  const target = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset['theme'] = target;
}

export const store = new AppStore();
