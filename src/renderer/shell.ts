/**
 * 应用外壳：自绘标题栏（品牌 + 应用菜单 + 拖拽区 + 操作区）+ 左实例栏 + 右日志抽屉
 *
 * 依据 ui-redesign.md §2（标题栏规格）、§3（菜单折进标题栏）、§6.1（结构）
 * - 标题栏与左实例栏同取 --rail-bg 一族，构成 L 形外壳，与内容区只差一个深度；
 * - 菜单栏与标题栏同行、同高、同底色，物理上不可能出现第二套配色；
 * - 窗口三按钮由系统 WCO 绘制，本文件**不**创建任何窗口控制按钮。
 */
import type { InstanceSummary } from '../shared/contracts';
import { avatar } from './views/parts';
import { backend } from './data/api';
import { store } from './data/store';
import { createLogView, type LogViewHandle } from './components/logview';
import { LAUNCHER_LOG_ID } from './data/logs';
import { createMenubar, type MenubarHandle } from './components/menubar';
import { openMenu } from './components/menu';
import { toastSuccess } from './components/toast';
import { badge, iconButton, stateLabel } from './components/ui';
import { icon } from './icons';
import { createTitlebar, type TitlebarHandle } from './titlebar';
import { clear, copyText, h, replace, tokenMs } from './util/dom';
import { shortenPath } from './util/format';
import type { ViewContext } from './context';
import { currentRoute, type Route } from './router';

export interface Shell {
  refresh(): void;
  openDrawer(instanceId?: string | null): void;
  closeDrawer(): void;
  toggleDrawer(instanceId?: string | null): void;
  isDrawerOpen(): boolean;
  drawerTarget(): string | null;
  /** 路由变化时同步高亮状态与拖拽区标题。 */
  syncRoute(route: Route): void;
  destroy(): void;
}

const TAB_LABEL: Record<string, string> = {
  plugins: '插件',
  settings: '设置',
  saves: '存档',
  logs: '日志',
};

export function createShell(ctx: ViewContext): Shell {
  const titlebar = requiredEl('#titlebar');
  const rail = requiredEl('#rail');
  const drawer = requiredEl('#drawer');

  let drawerOpen = false;
  let drawerTarget: string | null = null;
  let logView: LogViewHandle | null = null;
  let drawerHasContent = false;
  let drawerCleanup: number | null = null;
  let route: Route = currentRoute();
  let railQuery = '';

  const titleEl = h('span', { class: 'titlebar__title' });
  const actionsHost = h('div', { class: 'titlebar__actions' });
  const menubar: MenubarHandle = createMenubar();
  const titlebarCtl: TitlebarHandle = createTitlebar(titleEl);

  /* ══ 标题栏 ═══════════════════════════════════════════════════ */

  function renderTitlebar(): void {
    const state = store.get();

    // 标题栏操作区**只保留最高频的一个动作**（运行日志）。
    // 主题切换属偏好设置，已下沉到左实例栏底部与「全局设置」页；
    // 1264px 宽的窗口里，标题栏右侧还要让位给系统 WCO 三按钮，不能塞满。
    replace(
      actionsHost,
      iconButton('terminal', {
        label: '运行日志',
        size: 'icon-sm',
        variant: drawerOpen ? 'subtle' : 'ghost',
        title: drawerOpen ? '关闭运行日志抽屉（Esc）' : '打开运行日志抽屉',
        onClick: () => toggleDrawer(drawerTarget),
      }),
    );

    replace(
      titlebar,
      h('div', { class: 'titlebar__surface' }),
      h(
        'div',
        { class: 'titlebar__content' },
        h(
          'div',
          { class: 'titlebar__brand' },
          h('div', { class: 'brand__mark' }, icon('whaleMark', 14)),
          h(
            'div',
            { class: 'brand__text' },
            h('span', { class: 'brand__name', text: 'WhalesLauncher' }),
            h('span', {
              class: 'brand__ver',
              text: state.appVersion ? `v${state.appVersion}` : 'dsh',
              title: state.appVersion ? `启动器版本 ${state.appVersion}` : 'dsh 实例与版本管理',
            }),
          ),
        ),
        menubar.el,
        h('div', { class: 'titlebar__spacer' }, titleEl),
        actionsHost,
      ),
    );
    updateTitle();
  }

  function toggleTheme(theme: 'dark' | 'light'): void {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset['theme'] = next;
    void store.saveConfig({ theme: next }).then((saved) => {
      if (saved) toastSuccess(`已切换到${next === 'light' ? '浅色' : '深色'}主题`);
    });
  }

  /** 拖拽区标题：实例名 · 视图名（§2.6） */
  function updateTitle(): void {
    let text: string;
    let target = 'WhalesLauncher · 尚未创建实例';
    if (route.name === 'detail' && route.instanceId) {
      const item = store.instanceById(route.instanceId);
      const name = item?.meta.name ?? '实例';
      target = `${name} · ${TAB_LABEL[route.tab] ?? route.tab}`;
    } else if (route.name === 'instances') {
      const count = store.get().instances.length;
      target = count > 0 ? `WhalesLauncher · 全部实例（${count}）` : 'WhalesLauncher · 尚未创建实例';
    } else if (route.name === 'engines') {
      target = 'WhalesLauncher · 版本管理';
    } else if (route.name === 'wizard') {
      target = 'WhalesLauncher · 新建实例';
    } else if (route.name === 'settings') {
      target = 'WhalesLauncher · 全局设置';
    }
    text = target;
    titlebarCtl.setTitle(text);
  }

  /* ══ 实例栏 ═══════════════════════════════════════════════════ */

  const railSearch = h('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索实例…',
    'aria-label': '搜索实例',
    autocomplete: 'off',
    oninput: () => {
      railQuery = railSearch.value.trim().toLowerCase();
      renderRailList();
    },
  });

  const railListHost = h('div', { class: 'rail__list' });
  const railCount = h('span', { class: 'rail__count' });

  function renderRail(): void {
    const state = store.get();
    replace(
      rail,
      h(
        'div',
        { class: 'rail__head' },
        h(
          'div',
          { class: 'rail__section' },
          h('span', { class: 'rail__label', text: '实例' }),
          railCount,
        ),
        h('div', { class: 'search' }, icon('search', 14, 'search-icon'), railSearch),
      ),
      railListHost,
      h(
        'div',
        { class: 'rail__foot' },
        railNavButton('#/instances', '实例列表', 'package'),
        railNavButton('#/engines', '版本管理', 'layers'),
        railNavButton('#/settings', '全局设置', 'settings'),
        themeButton(state.config?.theme ?? 'dark'),
        state.demo
          ? h(
              'div',
              { class: 'rail__demo' },
              badge('演示数据', 'warning', {
                dot: true,
                title: state.demoReason ?? '未连接后端，当前展示内置演示数据',
              }),
            )
          : null,
      ),
    );
    renderRailList();
  }

  function railNavButton(path: string, label: string, iconName: 'package' | 'layers' | 'settings'): HTMLElement {
    const active =
      (path === '#/instances' && route.name === 'instances') ||
      (path === '#/engines' && route.name === 'engines') ||
      (path === '#/settings' && route.name === 'settings');
    return h(
      'button',
      {
        class: `rail__nav-btn${active ? ' is-active' : ''}`,
        type: 'button',
        onclick: () => ctx.navigate(path),
      },
      icon(iconName, 16),
      h('span', { text: label }),
    );
  }

  /** 主题切换（下沉到左栏底部：标题栏右侧要留给系统 WCO 三按钮） */
  function themeButton(theme: 'dark' | 'light'): HTMLElement {
    const next = theme === 'light' ? 'dark' : 'light';
    return h(
      'button',
      {
        class: 'rail__nav-btn',
        type: 'button',
        title: `当前为${theme === 'light' ? '浅色' : '深色'}主题，点击切换到${next === 'light' ? '浅色' : '深色'}`,
        'aria-label': `切换到${next === 'light' ? '浅色' : '深色'}主题`,
        onclick: () => toggleTheme(theme),
      },
      icon(theme === 'light' ? 'moon' : 'sun', 16),
      h('span', { text: `外观：${theme === 'light' ? '浅色' : '深色'}` }),
    );
  }

  function renderRailList(): void {
    const state = store.get();
    const all = state.instances;
    const visible =
      railQuery.length === 0
        ? all
        : all.filter((summary) =>
            `${summary.meta.name} ${summary.meta.engine.version} ${summary.meta.note}`
              .toLowerCase()
              .includes(railQuery),
          );
    railCount.textContent = `${visible.length}/${all.length}`;

    if (all.length === 0) {
      replace(
        railListHost,
        h(
          'div',
          { class: 'rail__item', style: { cursor: 'default', color: 'var(--text-3)' } },
          icon('info', 16),
          h('span', { class: 'rail__item-name', text: '还没有实例' }),
        ),
        h(
          'button',
          { class: 'rail__nav-btn', type: 'button', onclick: () => ctx.navigate('#/create') },
          icon('plus', 16),
          h('span', { text: '新建第一个实例' }),
        ),
      );
      return;
    }

    if (visible.length === 0) {
      replace(
        railListHost,
        h(
          'div',
          { class: 'rail__item', style: { cursor: 'default', color: 'var(--text-3)' } },
          h('span', { class: 'rail__item-name', text: '没有匹配的实例' }),
        ),
      );
      return;
    }

    replace(
      railListHost,
      visible.map((summary) => railItem(summary)),
    );
  }

  function railItem(summary: InstanceSummary): HTMLElement {
    const runtime = store.runtimeOf(summary.meta.id);
    const active = route.name === 'detail' && route.instanceId === summary.meta.id;
    const btn = h(
      'button',
      {
        class: `rail__item${active ? ' is-active' : ''}`,
        type: 'button',
        title: `${summary.meta.name} · ${stateLabel(runtime.state)} · 引擎 ${summary.meta.engine.version}`,
        onclick: () => ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/plugins`),
        oncontextmenu: (event: MouseEvent) => {
          event.preventDefault();
          openMenu(btn, [
            {
              label: '打开实例目录',
              icon: 'folder',
              onSelect: () => void backend().api.instance.openFolder(summary.meta.id, 'root'),
            },
            {
              label: '打开工作目录',
              icon: 'folder',
              onSelect: () => void backend().api.instance.openFolder(summary.meta.id, 'workspace'),
            },
            { kind: 'separator' },
            { label: '查看运行日志', icon: 'list', onSelect: () => openDrawer(summary.meta.id) },
            {
              label: '复制实例 ID',
              icon: 'copy',
              onSelect: () => {
                void copyText(summary.meta.id).then((done) => {
                  if (done) toastSuccess('实例 ID 已复制', { detail: summary.meta.id });
                });
              },
            },
            { kind: 'separator' },
            {
              label: '打开实例详情',
              icon: 'chevronRight',
              onSelect: () => ctx.navigate(`#/instance/${encodeURIComponent(summary.meta.id)}/plugins`),
            },
          ]);
        },
      },
      avatar(summary.meta, 'sm'),
      h(
        'div',
        { class: 'rail__item-main' },
        h('span', { class: 'rail__item-name', text: summary.meta.name }),
        h(
          'span',
          { class: 'rail__item-meta' },
          // 图形化状态点（不用文本字符 ●），颜色由状态类决定
          h('span', { class: `state-dot state-dot--${runtime.state}`, 'aria-hidden': 'true' }),
          h('span', { text: `${stateLabel(runtime.state)} · ${summary.meta.engine.version}` }),
        ),
      ),
    );
    return btn;
  }

  /* ══ 日志抽屉 ═════════════════════════════════════════════════ */

  function renderDrawer(): void {
    if (!drawerOpen) {
      // 关闭：保留内容直到宽度收拢动画结束，避免"空壳滑出"
      drawer.classList.remove('is-open');
      scheduleDrawerCleanup();
      return;
    }
    drawer.classList.add('is-open');
    if (drawerHasContent) return;
    buildDrawerContent();
  }

  function scheduleDrawerCleanup(): void {
    if (drawerCleanup !== null) return;
    drawerCleanup = window.setTimeout(() => {
      drawerCleanup = null;
      if (drawerOpen) return;
      logView?.destroy();
      logView = null;
      clear(drawer);
      drawerHasContent = false;
    }, tokenMs('--dur-3', 220));
  }

  function buildDrawerContent(): void {
    const state = store.get();
    const options = [
      { value: '', label: '全部实例' },
      ...state.instances.map((summary) => ({ value: summary.meta.id, label: summary.meta.name })),
    ];
    const targetName =
      drawerTarget === null
        ? '全部实例'
        : (state.instances.find((s) => s.meta.id === drawerTarget)?.meta.name ?? '未知实例');

    const select = h('select', {
      class: 'select',
      'aria-label': '选择日志来源实例',
      onchange: () => setDrawerTarget(select.value.length > 0 ? select.value : null),
    });
    for (const option of options) {
      const node = h('option', { value: option.value, text: option.label });
      if ((drawerTarget ?? '') === option.value) node.selected = true;
      select.appendChild(node);
    }

    const head = h(
      'div',
      { class: 'drawer__head' },
      h('div', { class: 'drawer__title' }, icon('terminal', 16), h('span', { text: '运行日志' })),
      h('div', { class: 'select-wrap grow' }, select, icon('chevronDown', 14, 'select-caret')),
      iconButton('close', {
        label: '关闭日志抽屉',
        size: 'icon-sm',
        title: '关闭（Esc）',
        onClick: () => closeDrawer(),
      }),
    );

    const body = h('div', { class: 'drawer__body' });
    logView = createLogView({
      instanceId: drawerTarget ?? undefined,
      toolbar: true,
      showFooter: true,
      emptyText:
        drawerTarget === null
          ? '暂无日志。启动任一实例后，输出会按实例聚合在这里。'
          : `「${targetName}」暂无日志输出。`,
      labelFor: (id) => (id === '' || id === LAUNCHER_LOG_ID ? '启动器' : (store.instanceById(id)?.meta.name ?? id)),
    });
    body.appendChild(logView.el);

    replace(
      drawer,
      h(
        'div',
        { class: 'drawer__inner' },
        head,
        body,
        h(
          'div',
          { class: 'logview__foot' },
          h('span', { text: `来源：${targetName}` }),
          h('div', { class: 'toolbar__spacer' }),
          h('span', {
            class: 'path-text truncate',
            text: drawerTarget ? shortenPath(instanceLogsPath(drawerTarget), 46) : '全部实例的聚合输出',
            title: drawerTarget ? instanceLogsPath(drawerTarget) : '全部实例的聚合输出',
          }),
        ),
      ),
    );
    drawerHasContent = true;
    logView.scrollToBottom();
  }

  function instanceLogsPath(id: string): string {
    const summary = store.instanceById(id);
    const root = store.get().config?.rootDir ?? 'F:\\WhalesLauncher';
    return summary ? `${root}\\instances\\${summary.meta.dirName}\\logs` : root;
  }

  /* ══ 对外接口 ═════════════════════════════════════════════════ */

  function refresh(): void {
    renderTitlebar();
    renderRail();
    renderRailList();
    renderDrawer();
  }

  function openDrawer(instanceId?: string | null): void {
    if (instanceId !== undefined) setDrawerTarget(instanceId, false);
    drawerOpen = true;
    renderDrawer();
  }

  function closeDrawer(): void {
    drawerOpen = false;
    renderDrawer();
  }

  function toggleDrawer(instanceId?: string | null): void {
    if (drawerOpen) {
      closeDrawer();
      return;
    }
    openDrawer(instanceId);
  }

  /** 切换日志来源：重建日志视图，保证订阅的实例过滤器同步。 */
  function setDrawerTarget(instanceId: string | null, rerender = true): void {
    drawerTarget = instanceId;
    logView?.destroy();
    logView = null;
    drawerHasContent = false;
    if (rerender) renderDrawer();
  }

  function syncRoute(next: Route): void {
    route = next;
    renderRail();
    renderRailList();
    updateTitle();
  }

  const unsubscribe = store.subscribe(() => refresh());

  // Esc 关闭抽屉（模态自行处理 Esc，优先级更高；菜单由 menu.ts 处理）
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (document.querySelector('.modal-backdrop')) return;
    if (document.querySelector('.menu')) return;
    if (drawerOpen) closeDrawer();
  };
  document.addEventListener('keydown', onKeyDown);

  refresh();

  return {
    refresh,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    isDrawerOpen: () => drawerOpen,
    drawerTarget: () => drawerTarget,
    syncRoute,
    destroy(): void {
      unsubscribe();
      document.removeEventListener('keydown', onKeyDown);
      if (drawerCleanup !== null) window.clearTimeout(drawerCleanup);
      logView?.destroy();
      menubar.destroy();
      titlebarCtl.destroy();
    },
  };
}

function requiredEl(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`界面结构缺少必需节点：${selector}`);
  return el;
}
