/**
 * 实例详情 · 日志页
 *
 * 复用日志视图组件：等宽、分色、自动滚动（上滚暂停 + 回到底部）、
 * 流过滤、清空；同时提供"打开日志目录"与"复制全部"。
 */
import type { InstanceSummary } from '../../../shared/contracts';
import { backend } from '../../data/api';
import { logStore, type LogLine } from '../../data/logs';
import { createLogView } from '../../components/logview';
import { toastError, toastInfo, toastSuccess } from '../../components/toast';
import { badge, banner, button, card } from '../../components/ui';
import { copyText, h, replace } from '../../util/dom';
import { runAction } from '../../util/result';
import type { ViewContext, ViewInstance } from '../../context';

export function createLogsTab(ctx: ViewContext, summary: InstanceSummary): ViewInstance {
  const instanceId = summary.meta.id;
  const countBadge = badge('0 行', 'neutral');

  const view = createLogView({
    instanceId,
    toolbar: true,
    showFooter: true,
  });

  const root = h('div', { class: 'logs-page' });

  async function openLogFolder(): Promise<void> {
    const done = await runAction(backend().api.instance.openFolder(instanceId, 'logs'), '打开日志目录');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开日志目录');
    else toastSuccess('已打开日志目录');
  }

  async function copyAll(): Promise<void> {
    const lines: LogLine[] = logStore.snapshot(instanceId);
    if (lines.length === 0) {
      toastError('当前没有可复制的日志');
      return;
    }
    const text = lines.map((line) => `[${line.ts}] ${line.stream.padEnd(6)} ${line.text}`).join('\n');
    const done = await copyText(text);
    if (done) toastSuccess(`已复制 ${lines.length} 行日志`);
    else toastError('复制失败', { detail: '当前环境不允许访问剪贴板，请手动选中日志文本复制。' });
  }

  function render(): void {
    const count = logStore.count(instanceId);
    countBadge.textContent = `${count} 行`;
    replace(
      root,
      card({
        title: '运行日志',
        icon: 'terminal',
        desc: `实时来自 dsh 进程的 stdout / stderr 与启动器系统消息（实例：${summary.meta.name}）。`,
        actions: [
          countBadge,
          button({ label: '打开日志目录', icon: 'folder', size: 'sm', onClick: () => void openLogFolder() }),
          button({ label: '复制全部', icon: 'copy', size: 'sm', onClick: () => void copyAll() }),
          button({
            label: '在侧栏中查看',
            icon: 'external',
            size: 'sm',
            onClick: () => ctx.openLogDrawer(instanceId),
          }),
        ],
        body: [h('div', { class: 'logs-shell' }, view.el)],
      }),
      banner({
        tone: 'info',
        title: '日志说明',
        text: '启动失败时 dsh 会把完整诊断写入 $DSH_HOME/logs/startup-<时间戳>-<uuid>.log；此处只显示摘要与实时输出。',
      }),
    );
  }

  const unsubscribe = logStore.subscribe(() => {
    const count = logStore.count(instanceId);
    countBadge.textContent = `${count} 行`;
  });

  render();

  return {
    el: root,
    destroy(): void {
      unsubscribe();
      view.destroy();
    },
  };
}
