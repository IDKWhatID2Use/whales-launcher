/**
 * 实例详情 · 存档页
 *
 * 会话（sessions/）× 工作文件夹共同构成"存档"。列表按最后修改时间倒序，
 * 显示体积与 workspace 归属，可直接定位到会话目录。
 */
import type { InstanceSummary, SessionInfo } from '../../../shared/contracts';
import { backend } from '../../data/api';
import { SHARE_MODE_LABEL } from '../parts';
import { isolationCard } from '../isolation';
import { toastInfo, toastSuccess } from '../../components/toast';
import { badge, banner, button, card, chip, copyButton, emptyState, listEmpty, rowItem, rows, spinner } from '../../components/ui';
import { icon } from '../../icons';
import { h, replace } from '../../util/dom';
import { formatBytes, formatDateTime, formatRelative } from '../../util/format';
import { runAction } from '../../util/result';
import type { ViewContext, ViewInstance } from '../../context';

export function createSavesTab(ctx: ViewContext, summary: InstanceSummary): ViewInstance {
  const instanceId = summary.meta.id;
  /** 隔离策略切换后 store 会换掉摘要对象；页签不会因 store 通知重建，故自行持有最新值。 */
  let current = summary;
  let sessions: SessionInfo[] = [];
  let loading = true;
  let loadError: string | null = null;

  const listHost = h('div', { class: 'stack stack--tight' });
  const root = h('div', { class: 'stack stack--loose' });

  async function load(silent = false): Promise<void> {
    if (!silent) {
      loading = true;
      render();
    }
    const result = await runAction(backend().api.saves.list(instanceId), '读取会话列表');
    loading = false;
    if (result === null) {
      loadError = '无法枚举会话目录，请确认实例 home/sessions 是否存在。';
    } else {
      sessions = result;
      loadError = null;
    }
    render();
  }

  async function openSessionFolder(session: SessionInfo): Promise<void> {
    const done = await runAction(backend().api.saves.openFolder(instanceId, session.id), '打开会话目录');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开会话目录', { detail: session.dir });
    else toastSuccess('已打开会话目录', { detail: session.dir });
  }

  async function openSessionsRoot(): Promise<void> {
    const done = await runAction(backend().api.saves.openFolder(instanceId), '打开存档目录');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开存档目录');
  }

  async function openWorkspaceFolder(): Promise<void> {
    const done = await runAction(backend().api.instance.openFolder(instanceId, 'workspace'), '打开工作区目录');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开工作区目录', { detail: `instances\\${current.meta.dirName}\\workspace` });
    else toastSuccess('已打开工作区目录');
  }

  function sessionRows(): Node[] {
    if (loading) {
      return [
        rows(
          Array.from({ length: 3 }, () =>
            h(
              'div',
              { class: 'row-item' },
              h('div', { class: 'row-item__icon' }, spinner('sm')),
              h(
                'div',
                { class: 'row-item__main' },
                h('div', { class: 'skeleton skeleton--text', style: { width: '46%' } }),
                h('div', { class: 'skeleton skeleton--text', style: { width: '68%' } }),
              ),
            ),
          ),
        ),
      ];
    }
    if (sessions.length === 0) {
      return [
        rows([
          h(
            'div',
            { class: 'row-item' },
            listEmpty('该实例还没有会话记录。启动实例并完成一次对话后，会话会出现在这里。', 'archive'),
          ),
        ]),
      ];
    }
    return [
      rows(
        sessions.map((session) =>
          rowItem({
            icon: 'archive',
            title: h('span', { class: 'session-id truncate', text: session.id, title: session.id }),
            badges: [
              h('span', { class: 'chip', text: session.workspaceKey, title: `workspace 编码目录：${session.workspaceKey}` }),
              session.dir.includes('\\shared\\')
                ? badge('共享库', 'accent', { title: '该会话位于共享会话库，其它实例也可能使用' })
                : badge('实例内', 'neutral'),
            ],
            sub: [
              h('span', { text: `最后修改 ${formatDateTime(session.updatedAt)}` }),
              h('span', { text: '·' }),
              h('span', { dataset: { relative: session.updatedAt }, text: formatRelative(session.updatedAt) }),
              h('span', { text: '·' }),
              h('span', { class: 'session-size', text: formatBytes(session.sizeBytes) }),
            ],
            side: [copyButton(session.dir, '复制会话目录路径')],
            actions: [
              button({
                label: '打开文件夹',
                icon: 'folder',
                size: 'sm',
                onClick: () => void openSessionFolder(session),
              }),
            ],
          }),
        ),
      ),
    ];
  }

  function render(): void {
    const children: Node[] = [];

    if (loadError) {
      children.push(
        banner({
          tone: 'danger',
          title: '读取存档失败',
          text: loadError,
        }),
      );
    }

    children.push(
      isolationCard({
        ctx,
        summary: current,
        keys: ['workspace', 'saves'],
        desc: '工作区与会话存档决定这个实例的文件落在哪里。切换会重建 junction 链接；共享区的既有文件不会被删除，删除实例也不会清理共享区。',
        actions: [
          button({
            label: '打开工作区',
            icon: 'folder',
            size: 'sm',
            variant: 'subtle',
            onClick: () => void openWorkspaceFolder(),
          }),
          button({
            label: '打开存档根目录',
            icon: 'archive',
            size: 'sm',
            variant: 'subtle',
            onClick: () => void openSessionsRoot(),
          }),
        ],
        onChanged: (updated) => {
          current = updated;
          render();
        },
      }),
    );

    children.push(
      card({
        title: '会话列表',
        icon: 'archive',
        desc: '按最后修改时间倒序。会话 ID 即 dsh 的 session id，可直接复制用于定位。',
        actions: [
          badge(`${sessions.length} 个`, 'neutral'),
          button({ label: '刷新', icon: 'refresh', size: 'sm', onClick: () => void load(true) }),
        ],
        body: [
          h('div', { class: 'row wrap' }, [
            chip(`存档模式：${SHARE_MODE_LABEL[current.meta.saves.mode]}`),
            chip(`工作区模式：${SHARE_MODE_LABEL[current.meta.workspace.mode]}`),
          ]),
          ...sessionRows(),
        ],
      }),
    );

    replace(root, children);
  }

  render();
  void load();

  return {
    el: root,
    destroy(): void {
      /* 无推送订阅 */
    },
  };
}
