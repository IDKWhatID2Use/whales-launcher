/** 视图上下文：视图通过它访问状态、路由与外壳动作，不直接触碰 DOM 外壳。 */
import type { AppStore } from './data/store';
import type { InstanceSummary } from '../shared/contracts';

export interface ViewContext {
  store: AppStore;
  /** 是否处于演示数据模式（未连接后端）。 */
  demo: boolean;
  demoReason: string | null;
  navigate(path: string, options?: { replace?: boolean }): void;
  openLogDrawer(instanceId?: string | null): void;
  closeLogDrawer(): void;
  toggleLogDrawer(instanceId?: string | null): void;
  isLogDrawerOpen(): boolean;
  /** 当前日志抽屉选中的实例（null = 全部）。 */
  logDrawerTarget(): string | null;
  /** 请求外壳（顶部栏 / 实例栏 / 抽屉）重绘。 */
  refreshShell(): void;
}

export interface ViewInstance {
  el: HTMLElement;
  destroy(): void;
}

export type ViewFactory = (ctx: ViewContext) => ViewInstance;

/** 便捷：判断实例是否可操作（目录存在、引擎已安装）。 */
export function instanceIssues(summary: InstanceSummary): string[] {
  const issues: string[] = [];
  if (!summary.present) issues.push('实例目录缺失');
  if (!summary.engineInstalled) issues.push(`引擎 ${summary.meta.engine.version} 未安装`);
  return issues;
}
