/**
 * 实例列表视图
 *
 * 卡片网格 + 搜索/筛选/排序 + 空态引导。卡片的启动/停止、更多菜单、
 * 打开界面等操作全部在这里闭环；结构分「静态头部」与「动态区域」两部分，
 * 动态区域随状态重建，搜索框等交互元素保持稳定（不丢焦点）。
 */
import type { InstanceSummary } from '../../shared/contracts';
import { avatar, metaChips } from './parts';
import { backend } from '../data/api';
import { store } from '../data/store';
import { problemOf } from '../data/summary-ext';
import { openMenu } from '../components/menu';
import { openModal } from '../components/modal';
import { toastError, toastInfo, toastSuccess, toastWarning } from '../components/toast';
import {
  badge,
  banner,
  button,
  chip,
  emptyState,
  iconButton,
  listEmpty,
  segmented,
  selectControl,
  statTile,
  statusBadge,
} from '../components/ui';
import { icon } from '../icons';
import { copyText, h, replace } from '../util/dom';
import { formatDateTime, formatRelative } from '../util/format';
import { runAction } from '../util/result';
import type { ViewContext, ViewInstance } from '../context';

type StatusFilter = 'all' | 'running' | 'stopped' | 'attention';
type SortKey = 'recent' | 'name' | 'created' | 'launches';

export function createInstancesView(ctx: ViewContext): ViewInstance {
  let query = '';
  let status: StatusFilter = 'all';
  let sort: SortKey = 'recent';
  let disposed = false;

  const dynamic = h('div', { class: 'stack stack--loose' });
  const statusSlot = h('div', { class: 'toolbar' });
  const root = h('div', { class: 'view' });

  /* ── 头部（静态） ─────────────────────────────────────────── */
  const head = h(
    'div',
    { class: 'view__head' },
    h(
      'div',
      { class: 'view__head-main' },
      h('h1', { class: 'view__title' }, h('span', { text: '实例' }), h('span', { class: 'view__count', id: 'inst-count' })),
      h('div', {
        class: 'view__sub',
        text: '每个实例拥有独立的 DSH_HOME、profile、插件与设置；存档与工作区可共享。',
      }),
    ),
    h(
      'div',
      { class: 'view__actions' },
      button({
        label: '从实例包导入',
        icon: 'upload',
        onClick: () => void importPack(),
      }),
      button({
        label: '新建实例',
        icon: 'plus',
        variant: 'primary',
        onClick: () => ctx.navigate('#/create'),
      }),
    ),
  );

  /* ── 工具条（静态，搜索框保持稳定） ───────────────────────── */
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索实例名称、备注或引擎版本…',
    'aria-label': '搜索实例',
    autocomplete: 'off',
    oninput: () => {
      query = searchInput.value.trim().toLowerCase();
      renderDynamic();
    },
  });
  const clearSearch = h(
    'button',
    {
      class: 'search__clear',
      type: 'button',
      title: '清空搜索',
      'aria-label': '清空搜索',
      onclick: () => {
        searchInput.value = '';
        query = '';
        renderDynamic();
        searchInput.focus();
      },
    },
    icon('close', 14),
  );

  const toolbar = h(
    'div',
    { class: 'inst-toolbar' },
    h(
      'div',
      { class: 'search inst-toolbar__search' },
      icon('search', 16, 'search-icon'),
      searchInput,
      clearSearch,
    ),
    statusSlot,
    selectControl<SortKey>({
      value: sort,
      options: [
        { value: 'recent', label: '按最近启动排序' },
        { value: 'name', label: '按名称排序' },
        { value: 'created', label: '按创建时间排序' },
        { value: 'launches', label: '按启动次数排序' },
      ],
      onChange: (value) => {
        sort = value;
        renderDynamic();
      },
      ariaLabel: '排序方式',
    }),
    h('div', { class: 'toolbar__spacer' }),
    button({
      label: '刷新',
      icon: 'refresh',
      size: 'sm',
      onClick: () => void store.refreshInstances(),
    }),
  );

  function renderStatusFilter(): void {
    replace(
      statusSlot,
      segmented<StatusFilter>({
        options: [
          { value: 'all', label: '全部' },
          { value: 'running', label: '运行中' },
          { value: 'stopped', label: '已停止' },
          { value: 'attention', label: '需处理' },
        ],
        value: status,
        onChange: (value) => {
          status = value;
          renderStatusFilter();
          renderDynamic();
        },
        ariaLabel: '按状态筛选',
      }),
    );
  }

  root.appendChild(head);
  root.appendChild(
    h('div', { class: 'view__body' }, h('div', { class: 'view__inner' }, toolbar, dynamic)),
  );

  /* ── 动态区域 ─────────────────────────────────────────────── */

  /**
   * 是否需要用户处理（QR-17：把 core 的 `problem` 一并算进来）。
   *
   * 单一判定来源：既用于「需处理」筛选器，也用于概览统计卡，
   * 避免两处各写一份条件而出现"筛选里有、统计里没有"的不一致。
   */
  function needsAttention(summary: InstanceSummary): boolean {
    return (
      !summary.present ||
      !summary.engineInstalled ||
      store.hasConflict(summary.meta.id) ||
      problemOf(summary) !== null
    );
  }

  function visibleInstances(): InstanceSummary[] {
    const all = store.get().instances;
    const filtered = all.filter((summary) => {
      if (status === 'running' && summary.runtime.state !== 'running' && summary.runtime.state !== 'starting') {
        return false;
      }
      if (status === 'stopped' && summary.runtime.state !== 'stopped' && summary.runtime.state !== 'crashed') {
        return false;
      }
      if (status === 'attention' && !needsAttention(summary)) {
        return false;
      }
      if (query.length === 0) return true;
      const haystack = [
        summary.meta.name,
        summary.meta.note,
        summary.meta.engine.version,
        summary.meta.profile.template,
        summary.meta.dirName,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    const sorted = filtered.slice();
    sorted.sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.meta.name.localeCompare(b.meta.name, 'zh-Hans-CN');
        case 'created':
          return Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt);
        case 'launches':
          return b.meta.launchCount - a.meta.launchCount;
        case 'recent':
        default: {
          const at = a.meta.lastLaunchedAt ? Date.parse(a.meta.lastLaunchedAt) : 0;
          const bt = b.meta.lastLaunchedAt ? Date.parse(b.meta.lastLaunchedAt) : 0;
          return bt - at;
        }
      }
    });
    return sorted;
  }

  function renderDynamic(): void {
    if (disposed) return;
    const state = store.get();
    const children: Node[] = [];

    if (state.demo && ctx.demoReason) {
      children.push(
        banner({
          tone: 'info',
          title: '当前为演示数据（未连接后端）',
          text: ctx.demoReason,
          actions: [
            button({
              label: '重新检测',
              size: 'sm',
              variant: 'subtle',
              onClick: () => window.location.reload(),
            }),
          ],
        }),
      );
    }

    if (state.loadError) {
      children.push(
        banner({
          tone: 'danger',
          title: '无法读取实例列表',
          text: state.loadError,
          actions: [
            button({
              label: '重试',
              size: 'sm',
              variant: 'subtle',
              onClick: () => void store.refreshInstances(),
            }),
          ],
        }),
      );
    }

    // 概览数字（QR-15：「需处理」计入共享设置冲突；QR-17：计入 core 的降级标记 problem）
    const instances = state.instances;
    const running = instances.filter((s) => s.runtime.state === 'running').length;
    const crashed = instances.filter((s) => s.runtime.state === 'crashed').length;
    const attention = instances.filter(needsAttention).length;
    const engineVersions = new Set(instances.map((s) => s.meta.engine.version)).size;

    children.push(
      h(
        'div',
        { class: 'inst-summary' },
        statTile('实例总数', String(instances.length), 'package'),
        statTile('运行中', String(running), 'play'),
        statTile('需处理', String(attention + crashed), 'alertTriangle'),
        statTile('已装引擎版本', String(engineVersions), 'layers'),
      ),
    );

    const visible = visibleInstances();
    const countNode = document.getElementById('inst-count');
    if (countNode) countNode.textContent = `${visible.length} / ${instances.length}`;

    if (state.loadingInstances && instances.length === 0) {
      children.push(
        h(
          'div',
          { class: 'inst-grid' },
          Array.from({ length: 6 }, () =>
            h(
              'div',
              { class: 'inst-card', style: { pointerEvents: 'none' } },
              h('div', { class: 'inst-card__top' }, h('div', { class: 'skeleton', style: { width: '44px', height: '44px', borderRadius: '12px' } }), h('div', { class: 'inst-card__head' }, h('div', { class: 'skeleton skeleton--text', style: { width: '60%' } }), h('div', { class: 'skeleton skeleton--text', style: { width: '80%' } }))),
              h('div', { class: 'skeleton skeleton--text', style: { width: '45%' } }),
              h('div', { class: 'skeleton skeleton--text', style: { width: '70%' } }),
            ),
          ),
        ),
      );
    } else if (instances.length === 0) {
      children.push(
        emptyState({
          icon: 'whaleMark',
          title: '还没有任何实例',
          desc: '实例 = 一个独立的 DSH_HOME：自己的 profile、插件、设置与存档。创建第一个实例后即可在这里启动它，或者从他人分享的实例包导入。',
          actions: [
            button({
              label: '新建实例',
              icon: 'plus',
              variant: 'primary',
              onClick: () => ctx.navigate('#/create'),
            }),
            button({ label: '从实例包导入', icon: 'upload', onClick: () => void importPack() }),
          ],
        }),
      );
    } else if (visible.length === 0) {
      children.push(
        emptyState({
          icon: 'search',
          title: '没有匹配的实例',
          desc: query.length > 0 ? `没有找到包含「${query}」的实例，试试其它关键词或清空筛选。` : '当前筛选条件下没有实例。',
          compact: true,
          actions: [
            button({
              label: '清空筛选',
              icon: 'refresh',
              onClick: () => {
                query = '';
                searchInput.value = '';
                status = 'all';
                renderDynamic();
              },
            }),
          ],
        }),
      );
      children.push(listEmpty('提示：可在左上角切换「全部 / 运行中 / 已停止 / 需处理」。', 'info'));
    } else {
      children.push(h('div', { class: 'inst-grid' }, visible.map((summary) => instanceCard(summary))));
    }

    replace(dynamic, children);
  }

  /* ── 卡片 ─────────────────────────────────────────────────── */

  function instanceCard(summary: InstanceSummary): HTMLElement {
    const runtime = store.runtimeOf(summary.meta.id);
    const busy = runtime.state === 'starting' || runtime.state === 'stopping';
    const running = runtime.state === 'running';
    const missing = !summary.present;
    const engineMissing = !summary.engineInstalled;
    // QR-17：core 的降级标记（instance.json 损坏 / 元数据被删 / 清单损坏）
    const problem = problemOf(summary);

    const card = h('div', {
      class: `inst-card${running ? ' is-running' : ''}${runtime.state === 'crashed' ? ' is-crashed' : ''}${
        missing ? ' is-missing' : ''
      }`,
      style: { '--card-accent': summary.meta.color },
      tabindex: '0',
      role: 'button',
      'aria-label': `打开实例 ${summary.meta.name} 的详情`,
      onclick: (event: MouseEvent) => {
        if ((event.target as HTMLElement | null)?.closest('button')) return;
        ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/plugins`);
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/plugins`);
        }
      },
    });

    const badges: Node[] = [statusBadge(runtime.state)];
    if (missing) {
      // 目录缺失时优先这一枚（同义徽标不重复），并把 core 的具体原因挂进 title
      badges.push(badge('目录缺失', 'warning', { title: problem ?? '实例目录不存在，可能已被移动或删除' }));
    } else if (problem !== null) {
      // QR-17：坏记录原本会渲染成一张完全正常的卡片
      badges.push(badge('记录异常', 'warning', { icon: 'alertTriangle', title: problem }));
    }
    if (engineMissing) {
      badges.push(badge('引擎未安装', 'danger', { title: `本地未安装引擎 ${summary.meta.engine.version}` }));
    }
    // QR-15：共享设置冲突必须在列表层可见，用户不必点进详情才发现
    if (store.hasConflict(summary.meta.id)) {
      badges.push(
        badge('设置冲突', 'warning', {
          icon: 'alertTriangle',
          title: '本地设置与共享设置不一致、尚未应用（未覆盖任何一边）。打开详情 →「设置」页签可选择以哪一份为准。',
        }),
      );
    }

    card.appendChild(
      h(
        'div',
        { class: 'inst-card__top' },
        avatar(summary.meta, 'lg'),
        h(
          'div',
          { class: 'inst-card__head' },
          h('div', { class: 'inst-card__name', text: summary.meta.name, title: summary.meta.name }),
          h('div', { class: 'inst-card__note', text: summary.meta.note || '（无备注）' }),
        ),
        h('div', { class: 'row wrap', style: { justifyContent: 'flex-end', gap: '4px' } }, badges),
      ),
    );

    card.appendChild(h('div', { class: 'inst-card__chips' }, metaChips(summary.meta), chip(`${summary.pluginCount} 个依赖`)));

    const stats: Node[] = [
      h(
        'div',
        { class: 'inst-stat', title: `上次启动：${formatDateTime(summary.meta.lastLaunchedAt)}` },
        icon('clock', 14),
        h('span', { class: 'inst-stat__value', dataset: { relative: summary.meta.lastLaunchedAt ?? '' }, text: formatRelative(summary.meta.lastLaunchedAt) }),
      ),
      h(
        'div',
        { class: 'inst-stat', title: '累计启动次数' },
        icon('power', 14),
        h('span', { class: 'inst-stat__value', text: `${summary.meta.launchCount} 次` }),
      ),
    ];
    if (running || runtime.state === 'starting') {
      stats.push(
        h(
          'div',
          { class: 'inst-stat', title: '本次运行时长' },
          icon('play', 14),
          h('span', {
            class: 'inst-stat__value',
            dataset: runtime.startedAt ? { elapsed: runtime.startedAt } : {},
            text: runtime.startedAt ? '00:00:00' : '—',
          }),
        ),
      );
      // 监听端口：多实例同时运行时，这是"谁在哪"最直接的信息
      if (runtime.port !== null) {
        stats.push(
          h(
            'div',
            { class: 'inst-stat', title: `监听端口（多实例自动避让）：${String(runtime.port)}` },
            icon('globe', 14),
            h('span', { class: 'inst-stat__value', text: `:${String(runtime.port)}` }),
          ),
        );
      }
    }
    card.appendChild(h('div', { class: 'inst-card__stats' }, stats));

    if (runtime.lastError && runtime.state === 'crashed') {
      card.appendChild(
        h('div', { class: 'banner banner--danger' },
          h('span', { class: 'banner__icon' }, icon('alertCircle', 16)),
          h('div', { class: 'banner__main' }, h('div', { class: 'banner__text truncate', text: runtime.lastError, title: runtime.lastError })),
        ),
      );
    }

    // QR-17：把 core 的 problem 文案**直接显示出来**（不只是挂在 title 上）：
    // 坏记录以前看起来完全正常，用户点了启动只拿到底层报错，不知道为什么。
    if (problem !== null) {
      card.appendChild(
        h('div', { class: 'banner banner--warning' },
          h('span', { class: 'banner__icon' }, icon('alertTriangle', 16)),
          h('div', { class: 'banner__main' }, h('div', { class: 'banner__text truncate', text: problem, title: problem })),
        ),
      );
    }

    /* 操作区 */
    const foot = h('div', { class: 'inst-card__foot' });
    const primary = running
      ? button({
          label: '停止',
          icon: 'stop',
          variant: 'danger',
          onClick: () => void stopInstance(summary),
        })
      : button({
          label: runtime.state === 'starting' ? '启动中…' : '启动',
          icon: 'play',
          variant: 'primary',
          // `present=false`（目录真的不存在）必然启动失败 → 禁用（Lead 裁决）；
          // `present=true` + problem 仍允许启动：用户可能先修好文件再启动。
          disabled: busy || missing || engineMissing,
          // QR-17：悬停即告知原因，而不是点了才看到底层报错
          title: missing
            ? '实例目录不存在，无法启动'
            : problem !== null
              ? `该实例存在问题：${problem}`
              : engineMissing
                ? `引擎 ${summary.meta.engine.version} 未安装`
                : '启动实例',
          onClick: () => void launchInstance(summary),
        });
    primary.dataset['role'] = 'primary-action';
    foot.appendChild(primary);

    if (running && runtime.url) {
      foot.appendChild(
        button({
          label: '打开界面',
          icon: 'globe',
          variant: 'subtle',
          onClick: () => void openUrl(runtime.url ?? ''),
        }),
      );
    }

    foot.appendChild(
      iconButton('folder', {
        label: '打开实例目录',
        size: 'sm',
        title: '打开实例目录',
        onClick: () => void openFolder(summary.meta.id, 'root', summary.meta.name),
      }),
    );

    foot.appendChild(h('div', { class: 'toolbar__spacer' }));

    const more = iconButton('more', {
      label: '更多操作',
      size: 'sm',
      title: '更多操作',
      onClick: () => {
        openMenu(more, [
          { label: '打开实例目录', icon: 'folder', onSelect: () => void openFolder(summary.meta.id, 'root', summary.meta.name) },
          { label: '打开工作目录', icon: 'folder', onSelect: () => void openFolder(summary.meta.id, 'workspace', summary.meta.name) },
          { label: '打开日志目录', icon: 'terminal', onSelect: () => void openFolder(summary.meta.id, 'logs', summary.meta.name) },
          { kind: 'separator' },
          { label: '查看运行日志', icon: 'list', onSelect: () => ctx.openLogDrawer(summary.meta.id) },
          { label: '插件与设置', icon: 'settings', onSelect: () => ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/plugins`) },
          { kind: 'separator' },
          { label: '导出实例包', icon: 'download', disabled: busy, onSelect: () => void exportPack(summary) },
          { label: '编辑实例信息', icon: 'pencil', onSelect: () => void editInstance(summary) },
          { kind: 'separator' },
          { label: '删除实例', icon: 'trash', danger: true, disabled: running || busy, onSelect: () => void removeInstance(summary) },
        ]);
      },
    });
    foot.appendChild(more);
    card.appendChild(foot);

    return card;
  }

  /* ── 操作实现 ─────────────────────────────────────────────── */

  async function launchInstance(summary: InstanceSummary): Promise<void> {
    // QR-15：启动前非阻塞提示（不拦启动，只把"共享设置尚未应用"讲清楚并给出入口）
    if (store.hasConflict(summary.meta.id)) {
      toastWarning('该实例存在未解决的设置冲突', {
        detail: '共享设置尚未应用，本次启动使用本地设置。可在实例详情 →「设置」页签选择以哪一份为准。',
        timeout: 9000,
        action: {
          label: '去处理',
          onClick: () => ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/settings`),
        },
      });
    }
    const value = await runAction(
      backend().api.instance.launch({ instanceId: summary.meta.id }),
      '启动实例',
    );
    if (!value) return;
    toastSuccess(`已启动「${summary.meta.name}」`, { detail: `PID ${value.pid} · DSH_HOME ${value.dshHome}` });
    await store.refreshInstances({ silent: true });
  }

  async function stopInstance(summary: InstanceSummary): Promise<void> {
    const okFlag = await runAction(backend().api.instance.stop(summary.meta.id), '停止实例');
    if (okFlag === null) return;
    toastInfo(`正在停止「${summary.meta.name}」…`);
    await store.refreshInstances({ silent: true });
  }

  async function openFolder(id: string, which: 'root' | 'home' | 'workspace' | 'logs', name: string): Promise<void> {
    const result = await runAction(backend().api.instance.openFolder(id, which), '打开目录');
    if (result === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开目录', { detail: `${name} · ${which}` });
  }

  async function openUrl(url: string): Promise<void> {
    if (!url) return;
    const result = await runAction(backend().api.app.openExternal(url), '打开界面');
    if (result === null) return;
    if (ctx.demo) toastInfo('演示模式：已模拟打开外部地址', { detail: url, action: { label: '复制地址', onClick: () => void copyText(url) } });
  }

  async function exportPack(summary: InstanceSummary): Promise<void> {
    const file = await runAction(backend().api.pack.export(summary.meta.id), '导出实例包');
    if (!file) {
      toastError('导出未完成', { detail: '未选择保存位置或接口未返回路径。' });
      return;
    }
    toastSuccess('实例包已导出', {
      detail: file,
      action: { label: '复制路径', onClick: () => void copyText(file) },
    });
  }

  async function importPack(): Promise<void> {
    const result = await runAction(backend().api.pack.import(), '导入实例包');
    if (!result) return;
    await store.refreshInstances({ silent: true });
    toastSuccess(
      `已导入实例「${result.name}」`,
      result.warnings.length > 0
        ? { detail: result.warnings.join('\n'), action: { label: '查看实例', onClick: () => ctx.navigate(`#/instance/${encodeURIComponent(result.instanceId)}/plugins`) } }
        : { action: { label: '查看实例', onClick: () => ctx.navigate(`#/instance/${encodeURIComponent(result.instanceId)}/plugins`) } },
    );
  }

  async function removeInstance(summary: InstanceSummary): Promise<void> {
    const deleteFiles = h('input', { type: 'checkbox' });
    const extra = h(
      'div',
      { class: 'stack stack--tight' },
      h(
        'label',
        { class: 'checkbox' },
        deleteFiles,
        h('span', { text: '同时删除磁盘上的实例目录（home / workspace / 日志，不可恢复）' }),
      ),
      h('div', { class: 'section-hint', text: `实例目录：instances\\${summary.meta.dirName}` }),
    );
    const handle = openModal({
      title: `删除实例「${summary.meta.name}」`,
      desc: '删除后该实例将不再出现在列表中。若实例目录被其它实例共享，请勿勾选删除文件。',
      icon: 'trash',
      tone: 'danger',
      size: 'md',
      body: [extra],
      actions: [
        { label: '取消', value: 'cancel', variant: 'ghost' },
        { label: '删除实例', value: 'delete', variant: 'danger', primary: true },
      ],
    });
    const value = await handle.result;
    if (value !== 'delete') return;
    const deleteFlag = deleteFiles.checked;
    const okFlag = await runAction(
      backend().api.instance.remove(summary.meta.id, deleteFlag),
      '删除实例',
    );
    if (okFlag === null) return;
    store.forgetInstance(summary.meta.id);
    ctx.refreshShell();
    toastSuccess(`已删除「${summary.meta.name}」`, deleteFlag ? { detail: '实例目录已一并删除' } : { detail: '仅移出列表，磁盘文件保留' });
  }

  async function editInstance(summary: InstanceSummary): Promise<void> {
    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      value: summary.meta.name,
      maxlength: '64',
    });
    const dirHint = h('div', { class: 'field__hint', text: `目录名：${summary.meta.dirName}（保持稳定标识，不随重命名变化）` });
    const colorInput = h('input', {
      class: 'color-input',
      type: 'color',
      value: summary.meta.color,
      'aria-label': '强调色',
    });
    const iconInput = h('input', {
      class: 'input',
      type: 'text',
      maxlength: '4',
      value: summary.meta.icon ?? '',
      placeholder: 'emoji 或单个字符（留空显示名称首字）',
    });
    const noteInput = h('textarea', { class: 'textarea', rows: '3', value: summary.meta.note, placeholder: '备注（可选）' });

    const body = [
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '实例名称' }), h('span', { class: 'field__req', text: '*' })), nameInput, dirHint),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label' }, h('span', { text: '图标与颜色' })),
        h('div', { class: 'row' }, iconInput, colorInput),
      ),
      h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '备注' })), noteInput),
    ];

    const handle = openModal({
      title: '编辑实例信息',
      desc: '仅修改启动器侧的展示信息，不影响 profile 与插件。',
      icon: 'pencil',
      size: 'md',
      body,
      actions: [
        { label: '取消', value: 'cancel', variant: 'ghost' },
        {
          label: '保存',
          value: 'save',
          variant: 'primary',
          primary: true,
          onSelect: () => {
            const name = nameInput.value.trim();
            if (name.length === 0) {
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
      backend().api.instance.update(summary.meta.id, {
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

  /* ── 订阅 ─────────────────────────────────────────────────── */

  const unsubscribe = store.subscribe(() => renderDynamic());

  renderStatusFilter();
  renderDynamic();

  return {
    el: root,
    destroy(): void {
      disposed = true;
      unsubscribe();
    },
  };
}
