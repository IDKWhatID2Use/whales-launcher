/**
 * 实例详情：头部（状态 / 运行信息 / 主要操作）+ 四个页签（插件 · 设置 · 存档 · 日志）
 */
import type { InstanceSummary } from '../../shared/contracts';
import { createLogsTab } from './detail/logs';
import { createPluginsTab } from './detail/plugins';
import { createSavesTab } from './detail/saves';
import { createSettingsTab } from './detail/settings';
import { avatar, templateInfo } from './parts';
import { backend } from '../data/api';
import { store } from '../data/store';
import { problemOf } from '../data/summary-ext';
import { openMenu } from '../components/menu';
import { openModal } from '../components/modal';
import { toastError, toastInfo, toastSuccess, toastWarning } from '../components/toast';
import { badge, button, chip, emptyState, iconButton, spinner, statTile, statusBadge, tabs } from '../components/ui';
import { icon } from '../icons';
import { copyText, h, replace } from '../util/dom';
import { formatDateTime, formatRelative } from '../util/format';
import { runAction } from '../util/result';
import type { ViewContext, ViewInstance } from '../context';
import type { DetailTab } from '../router';

const TAB_META: Array<{ value: DetailTab; label: string; icon: 'puzzle' | 'settings' | 'archive' | 'terminal' }> = [
  { value: 'plugins', label: '插件', icon: 'puzzle' },
  { value: 'settings', label: '设置', icon: 'settings' },
  { value: 'saves', label: '存档', icon: 'archive' },
  { value: 'logs', label: '日志', icon: 'terminal' },
];

export function createDetailView(ctx: ViewContext, instanceId: string, tab: DetailTab): ViewInstance {
  const root = h('div', { class: 'view' });
  let child: ViewInstance | null = null;
  let lastInstanceId = '';
  let lastTab = '';

  const headHost = h('div', { class: 'view__head' });
  const tabsHost = h('div', { class: 'view__tabs' });
  const metricsHost = h('div', { class: 'stack stack--tight' });
  const tabHost = h('div', { class: 'stack stack--loose' });
  const content = h('div', { class: 'view__inner' }, metricsHost, tabHost);
  root.appendChild(headHost);
  root.appendChild(tabsHost);
  root.appendChild(h('div', { class: 'view__body' }, content));

  function summary(): InstanceSummary | null {
    return store.instanceById(instanceId);
  }

  function renderHead(): void {
    const state = store.get();
    const item = summary();

    if (!item) {
      replace(
        headHost,
        h(
          'div',
          { class: 'view__head-main' },
          h('h1', { class: 'view__title' }, h('span', { text: state.ready ? '实例不存在' : '正在加载实例…' })),
          h('div', {
            class: 'view__sub',
            text: state.ready
              ? '该实例可能已被删除，或者链接已失效。'
              : '正在从后端读取实例信息…',
          }),
        ),
        h(
          'div',
          { class: 'view__actions' },
          button({ label: '返回实例列表', icon: 'arrowLeft', onClick: () => ctx.navigate('#/instances') }),
        ),
      );
      return;
    }

    const runtime = store.runtimeOf(item.meta.id);
    const busy = runtime.state === 'starting' || runtime.state === 'stopping';
    const running = runtime.state === 'running';

    const actions: Node[] = [];
    if (running) {
      actions.push(
        button({
          label: '停止',
          icon: 'stop',
          variant: 'danger',
          onClick: () => void stopInstance(item),
        }),
      );
      if (runtime.url) {
        actions.push(
          button({
            label: '打开界面',
            icon: 'globe',
            variant: 'subtle',
            onClick: () => void openUrl(runtime.url ?? ''),
          }),
        );
      }
    } else {
      actions.push(
        button({
          label: runtime.state === 'starting' ? '启动中…' : '启动实例',
          icon: 'play',
          variant: 'primary',
          disabled: busy || !item.present || !item.engineInstalled,
          // 目录不存在 → 必然失败，禁用并直说；present=true 的坏记录仍可启动（Lead 裁决）
          title: !item.present
            ? '实例目录不存在，无法启动'
            : (problemOf(item) ?? (!item.engineInstalled ? '引擎未安装' : '启动实例')),
          onClick: () => void launchInstance(item),
        }),
      );
    }
    actions.push(
      button({
        label: '打开目录',
        icon: 'folder',
        onClick: () => {
          const anchor = actions[actions.length - 1];
          if (anchor instanceof HTMLElement) {
            openMenu(anchor, [
              { label: '实例根目录', icon: 'folder', onSelect: () => void openFolder(item.meta.id, 'root') },
              { label: 'DSH_HOME（home）', icon: 'folder', onSelect: () => void openFolder(item.meta.id, 'home') },
              { label: '工作目录', icon: 'folder', onSelect: () => void openFolder(item.meta.id, 'workspace') },
              { label: '启动日志目录', icon: 'terminal', onSelect: () => void openFolder(item.meta.id, 'logs') },
            ]);
          }
        },
      }),
    );

    const more = iconButton('more', {
      label: '更多操作',
      title: '更多操作',
      onClick: () =>
        openMenu(more, [
          { label: '导出实例包', icon: 'download', onSelect: () => void exportPack(item) },
          { label: '编辑实例信息', icon: 'pencil', onSelect: () => void editInfo(item) },
          { label: '查看运行日志', icon: 'list', onSelect: () => ctx.openLogDrawer(item.meta.id) },
          { kind: 'separator' },
          { label: '删除实例', icon: 'trash', danger: true, disabled: running, onSelect: () => void removeInstance(item) },
        ]),
    });
    actions.push(more);

    const badges: Node[] = [statusBadge(runtime.state, true)];
    if (!item.present) badges.push(badge('目录缺失', 'warning'));
    if (!item.engineInstalled) badges.push(badge('引擎未安装', 'danger'));
    // QR-15：详情头部同样给出冲突信号（处理入口在「设置」页签）
    if (store.hasConflict(item.meta.id)) {
      badges.push(
        badge('设置冲突', 'warning', {
          icon: 'alertTriangle',
          title: '本地设置与共享设置不一致、尚未应用；在「设置」页签选择以哪一份为准。',
        }),
      );
    }

    replace(
      headHost,
      h(
        'div',
        { class: 'view__head-main' },
        h(
          'div',
          { class: 'detail-title' },
          avatar(item.meta, 'lg'),
          h(
            'div',
            { class: 'detail-title__text' },
            h('div', { class: 'row wrap' }, h('div', { class: 'detail-title__name', text: item.meta.name }), badges),
            h(
              'div',
              { class: 'detail-title__meta' },
              chip(item.meta.engine.version),
              chip(templateInfo(item.meta.profile.template).label),
              h('span', { text: `profile：${item.meta.profile.name}` }),
              h('span', { text: `目录：instances\\${item.meta.dirName}` }),
              item.meta.note ? h('span', { text: `备注：${item.meta.note}` }) : null,
            ),
          ),
        ),
      ),
      h('div', { class: 'view__actions' }, actions),
    );
  }

  function renderTabs(): void {
    const item = summary();
    if (!item) {
      replace(tabsHost, h('div', { class: 'tabs' }));
      return;
    }
    replace(
      tabsHost,
      tabs(
        TAB_META.map((meta) => ({ value: meta.value, label: meta.label, icon: meta.icon })),
        tab,
        (value) => ctx.navigate(`#/instance/${encodeURIComponent(instanceId)}/${value}`),
      ),
    );
  }

  function renderMetrics(): void {
    const item = summary();
    if (!item) {
      replace(metricsHost);
      return;
    }
    const runtime = store.runtimeOf(item.meta.id);
    replace(metricsHost, detailMetrics(item, runtime.url, runtime.port));
  }

  function renderContent(): void {
    const item = summary();
    if (!item) {
      if (child) {
        child.destroy();
        child = null;
      }
      if (store.get().ready) {
        replace(
          tabHost,
          emptyState({
            icon: 'alertCircle',
            title: '找不到该实例',
            desc: '实例可能已被删除。可以返回列表查看当前全部实例。',
            actions: [button({ label: '返回实例列表', icon: 'arrowLeft', onClick: () => ctx.navigate('#/instances') })],
          }),
        );
      } else {
        replace(tabHost, h('div', { class: 'row' }, spinner(), h('span', { text: '正在加载实例数据…' })));
      }
      return;
    }

    if (child && lastInstanceId === instanceId && lastTab === tab) return;
    if (child) child.destroy();
    lastInstanceId = instanceId;
    lastTab = tab;

    const factory =
      tab === 'settings'
        ? createSettingsTab
        : tab === 'saves'
          ? createSavesTab
          : tab === 'logs'
            ? createLogsTab
            : createPluginsTab;
    child = factory(ctx, item);
    replace(tabHost, child.el);
  }

  function renderAll(): void {
    renderHead();
    renderTabs();
    renderMetrics();
    renderContent();
  }

  /* ── 操作 ─────────────────────────────────────────────────── */

  async function launchInstance(item: InstanceSummary): Promise<void> {
    // QR-15：启动前非阻塞提示
    if (store.hasConflict(item.meta.id)) {
      toastWarning('该实例存在未解决的设置冲突', {
        detail: '共享设置尚未应用，本次启动使用本地设置。可在「设置」页签选择以哪一份为准。',
        timeout: 9000,
        action: {
          label: '去处理',
          onClick: () => ctx.navigate(`#/instance/${encodeURIComponent(item.meta.id)}/settings`),
        },
      });
    }
    const value = await runAction(backend().api.instance.launch({ instanceId: item.meta.id }), '启动实例');
    if (!value) return;
    toastSuccess(`已启动「${item.meta.name}」`, { detail: `PID ${value.pid}` });
    await store.refreshInstances({ silent: true });
    ctx.openLogDrawer(item.meta.id);
  }

  async function stopInstance(item: InstanceSummary): Promise<void> {
    const done = await runAction(backend().api.instance.stop(item.meta.id), '停止实例');
    if (done === null) return;
    toastInfo(`正在停止「${item.meta.name}」…`);
    await store.refreshInstances({ silent: true });
  }

  async function openFolder(id: string, which: 'root' | 'home' | 'workspace' | 'logs'): Promise<void> {
    const done = await runAction(backend().api.instance.openFolder(id, which), '打开目录');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开目录');
  }

  async function openUrl(url: string): Promise<void> {
    const done = await runAction(backend().api.app.openExternal(url), '打开界面');
    if (done === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开外部地址', { detail: url, action: { label: '复制地址', onClick: () => void copyText(url) } });
  }

  async function exportPack(item: InstanceSummary): Promise<void> {
    const file = await runAction(backend().api.pack.export(item.meta.id), '导出实例包');
    if (!file) {
      toastError('导出未完成', { detail: '未选择保存位置或接口未返回路径。' });
      return;
    }
    toastSuccess('实例包已导出', { detail: file, action: { label: '复制路径', onClick: () => void copyText(file) } });
  }

  async function editInfo(item: InstanceSummary): Promise<void> {
    const nameInput = h('input', { class: 'input', type: 'text', value: item.meta.name, maxlength: '64' });
    const iconInput = h('input', {
      class: 'input',
      type: 'text',
      maxlength: '4',
      value: item.meta.icon ?? '',
      placeholder: 'emoji 或单个字符',
    });
    const colorInput = h('input', { class: 'color-input', type: 'color', value: item.meta.color, 'aria-label': '强调色' });
    const noteInput = h('textarea', { class: 'textarea', rows: '3', value: item.meta.note, placeholder: '备注（可选）' });
    const handle = openModal({
      title: '编辑实例信息',
      icon: 'pencil',
      body: [
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '实例名称' })), nameInput),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '图标与颜色' })), h('div', { class: 'row' }, iconInput, colorInput)),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '备注' })), noteInput),
      ],
      actions: [
        { label: '取消', value: 'cancel', variant: 'ghost' },
        {
          label: '保存',
          value: 'save',
          variant: 'primary',
          primary: true,
          onSelect: () => {
            if (nameInput.value.trim().length === 0) {
              toastError('实例名称不能为空');
              return false;
            }
            return true;
          },
        },
      ],
    });
    const value = await handle.result;
    if (value !== 'save') return;
    const updated = await runAction(
      backend().api.instance.update(item.meta.id, {
        name: nameInput.value.trim(),
        icon: iconInput.value.trim().length > 0 ? iconInput.value.trim() : null,
        color: colorInput.value,
        note: noteInput.value,
      }),
      '保存实例信息',
    );
    if (!updated) return;
    store.upsertInstance(updated);
    ctx.refreshShell();
    toastSuccess('实例信息已更新');
  }

  async function removeInstance(item: InstanceSummary): Promise<void> {
    const deleteFiles = h('input', { type: 'checkbox' });
    const handle = openModal({
      title: `删除实例「${item.meta.name}」`,
      desc: '删除后该实例将不再出现在列表中。',
      icon: 'trash',
      tone: 'danger',
      size: 'sm',
      body: [
        h(
          'label',
          { class: 'checkbox' },
          deleteFiles,
          h('span', { text: '同时删除磁盘上的实例目录（不可恢复）' }),
        ),
      ],
      actions: [
        { label: '取消', value: 'cancel', variant: 'ghost' },
        { label: '删除实例', value: 'delete', variant: 'danger', primary: true },
      ],
    });
    const value = await handle.result;
    if (value !== 'delete') return;
    const done = await runAction(backend().api.instance.remove(item.meta.id, deleteFiles.checked), '删除实例');
    if (done === null) return;
    store.forgetInstance(item.meta.id);
    ctx.refreshShell();
    ctx.navigate('#/instances');
    toastSuccess(`已删除「${item.meta.name}」`);
  }

  /* ── 订阅 ─────────────────────────────────────────────────── */

  const unsubscribe = store.subscribe(() => {
    renderHead();
    renderTabs();
    renderMetrics();
    // 运行态变化时，日志页保持不动（避免打断用户查看），其余页签重建
    if (tab !== 'logs') renderContent();
  });

  renderAll();

  return {
    el: root,
    destroy(): void {
      unsubscribe();
      if (child) child.destroy();
      child = null;
    },
  };
}

/** 详情头部的关键指标（引擎 / 插件数 / 启动次数 / 界面地址…）。 */
function detailMetrics(summary: InstanceSummary, url: string | null, port: number | null): HTMLElement {
  const items: Array<{ label: string; value: string; icon?: 'cpu' | 'puzzle' | 'clock' | 'power' | 'globe' | 'archive' }> = [
    { label: '引擎版本', value: summary.meta.engine.version, icon: 'cpu' },
    { label: '插件依赖', value: `${summary.pluginCount} 个`, icon: 'puzzle' },
    { label: '启动次数', value: `${summary.meta.launchCount} 次`, icon: 'power' },
    { label: '上次启动', value: formatRelative(summary.meta.lastLaunchedAt), icon: 'clock' },
    { label: '监听端口', value: port === null ? '—' : String(port), icon: 'globe' },
    { label: '界面地址', value: url ?? '—', icon: 'globe' },
    { label: '创建时间', value: formatDateTime(summary.meta.createdAt), icon: 'archive' },
  ];
  return h(
    'div',
    { class: 'detail-metrics' },
    items.map((item) => statTile(item.label, item.value, item.icon)),
  );
}
