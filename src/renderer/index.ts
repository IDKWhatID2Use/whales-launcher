/**
 * WhalesLauncher 渲染层入口
 *
 * 职责：启动顺序编排（后端探测 → 状态装载 → 外壳 → 路由 → 视图挂载）、
 * 全局错误兜底与键盘快捷键。所有视图只通过 `ViewContext` 访问状态与导航。
 */
import { backend, isDemo } from './data/api';
import { applyTheme, store } from './data/store';
import { createShell, type Shell } from './shell';
import { createDetailView } from './views/detail';
import { createEnginesView } from './views/engines';
import { createGlobalSettingsView } from './views/global';
import { createInstancesView } from './views/instances';
import { createWizardView } from './views/wizard';
import { icon } from './icons';
import { onRouteChange, startRouter, type Route } from './router';
import { startClock } from './util/clock';
import { h, required, replace } from './util/dom';
import type { ViewContext, ViewInstance } from './context';

let shell: Shell;
let currentView: ViewInstance | null = null;
let currentRouteName = '';

const ctx: ViewContext = {
  store,
  demo: isDemo(),
  demoReason: backend().reason,
  navigate: (path) => {
    window.location.hash = path.startsWith('#') ? path : `#${path}`;
  },
  openLogDrawer: (instanceId) => shell.openDrawer(instanceId ?? null),
  closeLogDrawer: () => shell.closeDrawer(),
  toggleLogDrawer: (instanceId) => shell.toggleDrawer(instanceId ?? null),
  isLogDrawerOpen: () => shell.isDrawerOpen(),
  logDrawerTarget: () => shell.drawerTarget(),
  refreshShell: () => shell.refresh(),
};

function createView(route: Route): ViewInstance {
  switch (route.name) {
    case 'detail':
      return createDetailView(ctx, route.instanceId ?? '', route.tab === '' ? 'plugins' : (route.tab as 'plugins' | 'settings' | 'saves' | 'logs'));
    case 'engines':
      return createEnginesView(ctx);
    case 'wizard':
      return createWizardView(ctx);
    case 'settings':
      return createGlobalSettingsView(ctx);
    case 'instances':
    default:
      return createInstancesView(ctx);
  }
}

function mount(route: Route): void {
  const main = required<HTMLElement>('#main');
  if (currentView) {
    currentView.destroy();
    currentView = null;
  }
  currentRouteName = route.name;
  currentView = createView(route);
  replace(main, currentView.el);
  main.scrollTop = 0;
}

/* ══ 全局错误兜底 ═════════════════════════════════════════════════ */

const shownErrors = new Set<string>();

function reportError(source: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const key = `${source}:${message}`;
  // eslint-disable-next-line no-console
  console.error(`[WhalesLauncher] ${source}`, error);
  if (shownErrors.has(key) || shownErrors.size > 3) return;
  shownErrors.add(key);
  const host = document.getElementById('toasts');
  if (!host) return;
  const banner = h(
    'div',
    { class: 'toast toast--error', role: 'alert' },
    h('span', { class: 'toast__icon' }, icon('alertCircle', 16)),
    h(
      'div',
      { class: 'toast__main' },
      h('div', { class: 'toast__msg', text: '界面出现未预期的错误' }),
      h('div', { class: 'toast__detail', text: `${source}：${message}` }),
    ),
    h(
      'button',
      {
        class: 'toast__close',
        type: 'button',
        title: '关闭',
        'aria-label': '关闭',
        onclick: () => banner.remove(),
      },
      icon('close', 14),
    ),
  );
  host.appendChild(banner);
  window.setTimeout(() => banner.remove(), 15_000);
}

window.addEventListener('error', (event) => {
  reportError('脚本错误', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportError('未处理的异步错误', event.reason);
});

/* ══ 启动 ═════════════════════════════════════════════════════════ */

async function boot(): Promise<void> {
  applyTheme('dark');

  // 后端可能挂起：最多等 6 秒，之后先用现有状态渲染界面
  await Promise.race([store.init(), new Promise((resolve) => window.setTimeout(resolve, 6_000))]);

  const state = store.get();
  applyTheme(state.config?.theme ?? 'dark');

  shell = createShell(ctx);
  startClock();
  startRouter();
  onRouteChange((route) => {
    shell.syncRoute(route);
    mount(route);
  });

  installShortcuts();

  const app = document.getElementById('app');
  if (app) app.hidden = false;
  document.getElementById('boot')?.remove();

  if (state.demo) {
    // eslint-disable-next-line no-console
    console.warn(
      '[WhalesLauncher] 未检测到 window.whales，已切换到内置演示数据模式。界面可完整操作，但不会写入磁盘。',
    );
  }
}

/**
 * 应用自有快捷键（**不包含** F5 / Ctrl+R / Ctrl+Shift+R / Ctrl+Shift+I / F12 / F11 /
 * Ctrl+0 / Ctrl+= / Ctrl+-：这些由主进程 `before-input-event` 统一接管，
 * 渲染层重复注册会造成一次按键两次动作）。
 */
function installShortcuts(): void {
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable === true;
    switch (event.key.toLowerCase()) {
      case '1':
        if (typing) return;
        event.preventDefault();
        ctx.navigate('#/instances');
        break;
      case '2':
        if (typing) return;
        event.preventDefault();
        ctx.navigate('#/engines');
        break;
      case '3':
        if (typing) return;
        event.preventDefault();
        ctx.navigate('#/settings');
        break;
      case '4':
        if (typing) return;
        event.preventDefault();
        ctx.navigate('#/create');
        break;
      case 'l':
        // 运行日志抽屉；主进程未占用该组合键
        event.preventDefault();
        shell.toggleDrawer(shell.drawerTarget());
        break;
      default:
        break;
    }
  });
}

void boot().catch((error: unknown) => {
  reportError('启动失败', error);
  const bootScreen = document.getElementById('boot');
  if (bootScreen) {
    bootScreen.textContent = `界面启动失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
