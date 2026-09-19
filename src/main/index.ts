/**
 * WhalesLauncher 主进程入口。
 *
 * 生命周期要点：
 *  - 单实例锁：第二个启动器立刻退出，并把焦点交回既有窗口；
 *  - 窗口安全三件套：nodeIntegration=false / contextIsolation=true / sandbox=true；
 *  - 优雅退出：`before-quit` 先停掉所有由本启动器拉起的 dsh 子进程，
 *    再由 `will-quit` 做"强杀残留"兜底 —— 绝不留孤儿进程。
 *
 * 窗口外壳（Windows 11 原生 Fluent，规范 `docs/design/ui-redesign.md` §2.1）：
 *  - `titleBarStyle: 'hidden'` + `titleBarOverlay`：三枚窗口按钮交还 **Windows 系统绘制**
 *    （Fluent 外观、hover 关闭变红、Snap Layouts 全部保留），因此**不设** `frame: false`（反例 F-06）；
 *  - `backgroundMaterial: 'mica'`（Win11）带 `'none'` 降级；
 *  - 原生菜单栏整体移除（`Menu.setApplicationMenu(null)`），菜单改由渲染层自绘（反例 F-09）；
 *  - 加速键不随之丢失：`shortcuts.ts` 用窗口级 `before-input-event` 逐条重绑（§3.5、反例 F-16）。
 */
import { BrowserWindow, Menu, app, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { core } from '../core/index.js';
import { corePaths, launcherRoot, loadConfig, takePendingNotices } from './config.js';
import { devToolsAutoOpen, devToolsEnabled } from './devtools.js';
import { describeError } from './errors.js';
import { registerIpcHandlers } from './ipc.js';
import {
  LAUNCHER_LOG_ID,
  attachWindow,
  detachWindow,
  forceKillLeftovers,
  runningCount,
  stopAll,
  systemLog,
} from './runtime.js';
import { installShortcuts } from './shortcuts.js';
import {
  getCurrentTheme,
  normalizeTheme,
  overlayOptions,
  setCurrentTheme,
  supportsMica,
  themeBackground,
  type ThemeName,
} from './theme.js';

let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;

const rendererEntry = (): string => path.join(launcherRoot(), 'dist', 'renderer', 'index.html');
const preloadEntry = (): string => path.join(launcherRoot(), 'dist', 'preload', 'index.cjs');

/**
 * 应用图标（任务栏 / Alt+Tab / 窗口）：
 * `npx electron .` 启动时进程是 electron.exe，Windows 用的是**窗口图标**，
 * 不设它就会顶着 Electron 的默认原子图标。文件不存在时返回 undefined ——
 * 图标缺失只影响观感，绝不该让窗口建不出来（assets/ 被清理时也要能启动）。
 */
const iconEntry = (): string | undefined => {
  const file = path.join(launcherRoot(), 'assets', 'whales.ico');
  return existsSync(file) ? file : undefined;
};

/**
 * 把启动器根目录钉进 `$WHALES_LAUNCHER_ROOT` —— core 的 `defaultRootForCache()` 会读它。
 *
 * 为什么需要：core 的 `listAvailableEngines(registry, root?)` 未传 `root` 时会依次回退
 * `$WHALES_LAUNCHER_ROOT` → `process.cwd()`（见 `core/engine.ts`）。用户从桌面快捷方式
 * 或任意目录启动时，cwd 与启动器根毫无关系，npm 的 `--cache` 就会落到工作区外 ——
 * 在本机这种受限环境下那会直接 EPERM，引擎列表/安装随之失败。
 *
 * 在**任何 core 调用之前**赋值；子进程会继承该变量，等于给所有 npm/pnpm 调用上了双保险。
 * （未选「给 `listAvailableEngines` 传第二个参数」是因为契约里该签名只有 `registry`，
 *   而这个环境变量既不需要改冻结契约，又能覆盖 core 里任何 cwd 回退点。）
 */
function pinLauncherRoot(): void {
  const root = launcherRoot();
  const previous = process.env['WHALES_LAUNCHER_ROOT'];
  if (previous !== undefined && previous.trim().length > 0 && path.resolve(previous) !== root) {
    console.warn(`[main] 覆写环境变量 WHALES_LAUNCHER_ROOT：${previous} → ${root}`);
  }
  process.env['WHALES_LAUNCHER_ROOT'] = root;
}

pinLauncherRoot();

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  console.warn('[main] 已有 WhalesLauncher 实例在运行，本次启动退出。');
  app.quit();
} else {
  app.setName('WhalesLauncher');
  app.setAppUserModelId('com.whalelauncher.app');

  app.on('second-instance', () => focusMainWindow());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', onBeforeQuit);
  app.on('will-quit', onWillQuit);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.quit());
  }

  app.whenReady().then(
    () => {
      // onReady 自身也可能失败（例如 IPC 通道覆盖自检不过），必须一并兜住。
      onReady().catch(abortStartup);
    },
    (error: unknown) => abortStartup(error),
  );
}

/** 启动阶段致命错误：先收干净子进程，再以非零码退出。 */
function abortStartup(error: unknown): void {
  console.error('[main] 启动失败：', error);
  forceKillLeftovers();
  app.exit(1);
}

async function onReady(): Promise<void> {
  await selfHealDirectories();
  registerIpcHandlers();

  setCurrentTheme(await initialTheme());
  // 规范 §2.1 / §3.5：WCO 方案下不再有原生菜单栏。先摘掉再建窗，
  // 避免窗口出现瞬间闪一下系统菜单栏（原生菜单与自绘菜单并存 = 反例 F-09，P0）。
  Menu.setApplicationMenu(null);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  app.on('render-process-gone', (_event, contents, details) => {
    let url = '未知页面';
    try {
      url = contents.getURL();
    } catch {
      /* 已销毁，忽略 */
    }
    console.error(`[main] 渲染进程异常退出：${url} —— ${details.reason}`);
  });
  app.on('child-process-gone', (_event, details) => {
    console.warn(`[main] 子进程退出：${details.type} —— ${details.reason}`);
  });
}

/** 读取全局配置里的主题；配置损坏时退回深色，绝不阻断启动（规范 §4.9）。 */
async function initialTheme(): Promise<ThemeName> {
  try {
    const config = await loadConfig();
    return normalizeTheme(config.theme);
  } catch (error) {
    console.warn('[main] 读取配置失败，按深色主题启动：', error);
    return 'dark';
  }
}

/**
 * 自愈创建启动器根下的关键目录（首次运行时 `instances/` 必然不存在）。
 * 单个目录失败只记日志，不阻断启动。
 */
async function selfHealDirectories(): Promise<void> {
  const paths = corePaths();
  const required = [
    paths.root,
    paths.instancesDir,
    paths.sharedDir,
    paths.sharedSessionsDir,
    paths.sharedWorkspacesDir,
    paths.cacheDir,
  ];
  for (const dir of required) {
    try {
      await core.ensureDir(dir);
    } catch (error) {
      console.error(`[main] 目录初始化失败：${dir}`, error);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

/**
 * 窗口参数（规范 §2.1 逐项对齐）。
 * `backgroundColor` / `titleBarOverlay` 按当前主题给定，只允许这一处使用主题底色常量。
 */
function buildWindowOptions(theme: ThemeName): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 840,
    minWidth: 1024,
    // 720（原 680）：48px 标题栏 + 44px 视图头 + 44px 页签会把内容区挤没（规范 §2.1）。
    minHeight: 720,
    show: false,
    // 防白闪：与 `--bg-app` 同源；Mica 生效时该值只在首帧可见（§2.1、§4.9）。
    backgroundColor: themeBackground(theme),
    title: 'WhalesLauncher',
    // 图标：`assets/whales.ico`（`scripts/make-icon.mjs` 生成）。缺失时不传该字段。
    icon: iconEntry(),
    // 规范 §2.1 / 反例 F-06：**不要**设 `frame: false` —— 那会一并丢掉 DWM 的
    // 窗口圆角、阴影与边缘缩放手柄；WCO 只需要 `titleBarStyle`。
    titleBarStyle: 'hidden',
    // 系统绘制的三按钮区；`height` 必须 === `tokens.css` 的 `--titlebar-h`（反例 F-07）。
    titleBarOverlay: overlayOptions(theme),
    // 规范 §4.9：Win11 才启用 Mica，其余系统走 `'none'` 降级路径。
    backgroundMaterial: supportsMica() ? 'mica' : 'none',
    // 原生菜单已移除；保留此开关作为兜底，绝不允许它与自绘菜单同时可见。
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadEntry(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // QR-11：生产默认关闭 DevTools 能力（菜单项/快捷键会同步置灰与空动作）。
      devTools: devToolsEnabled(),
    },
  };
}

function createMainWindow(): BrowserWindow {
  const options = buildWindowOptions(getCurrentTheme());

  let win: BrowserWindow;
  try {
    win = new BrowserWindow(options);
  } catch (error) {
    // 规范 §2.1：无边框 / Mica 参数在个别系统上可能不被接受 —— 降级重试，绝不阻断启动。
    console.error('[main] 创建窗口失败，降级为无 Mica 配置重试：', error);
    win = new BrowserWindow({ ...options, backgroundMaterial: 'none' });
  }

  mainWindow = win;
  attachWindow(win);

  win.on('closed', () => {
    detachWindow(win);
    if (mainWindow === win) mainWindow = null;
  });

  // 防白闪：先隐藏，首帧就绪再显示。
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  // 关闭前提醒：仍在运行的实例会被一并停止。
  win.on('close', (event) => {
    if (shuttingDown) return;
    const running = runningCount();
    if (running === 0) return;
    const answer = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'WhalesLauncher',
      message: '仍有 dsh 实例在运行',
      detail: `退出启动器会一并停止 ${running} 个正在运行的实例。确定要退出吗？`,
      buttons: ['退出并停止实例', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer !== 0) event.preventDefault();
  });

  guardWebContents(win);
  loadRenderer(win);
  return win;
}

/** 页面级安全策略 + 窗口级快捷键。 */
function guardWebContents(win: BrowserWindow): void {
  const contents = win.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url).catch((error: unknown) => {
        console.warn('[main] 打开外链失败：', error);
      });
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isRendererUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url).catch(() => undefined);
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // 规范 §3.5 推荐的落点：原生菜单移除后，加速键在这里逐条重绑。
  // 用窗口级 `before-input-event`（而非 globalShortcut）：不依赖 DOM 焦点、
  // 不会被渲染层 preventDefault 影响、且不会在应用失焦时抢键（反例 F-16）。
  installShortcuts(win);
}

function isRendererUrl(url: string): boolean {
  if (url === 'about:blank' || url.startsWith('devtools:')) return true;
  if (!url.startsWith('file:')) return false;
  try {
    const target = fileURLToPath(new URL(url));
    const relative = path.relative(path.dirname(rendererEntry()), target);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function loadRenderer(win: BrowserWindow): void {
  const html = rendererEntry();

  // 渲染层就绪后才把启动期间积累的一次性提示（如「配置已损坏，已备份为 …」）推给界面：
  // 那时渲染层已订阅 log:chunk；更早推送会石沉大海。
  win.webContents.on('did-finish-load', () => {
    for (const notice of takePendingNotices()) {
      systemLog(LAUNCHER_LOG_ID, `${notice}\n`);
    }
  });

  if (!existsSync(html)) {
    console.error(`[main] 找不到界面资源：${html}`);
    void win.loadURL(placeholderPage(html, 'dist/renderer/index.html 尚未构建。'));
    return;
  }
  win.loadFile(html).catch((error: unknown) => {
    console.error('[main] 加载界面失败：', error);
    if (win.isDestroyed()) return;
    void win.loadURL(placeholderPage(html, describeError(error)));
  });
  if (devToolsAutoOpen()) win.webContents.openDevTools({ mode: 'detach' });
}

/** 界面未构建时的兜底页面：窗口能开、原因可读，而不是一片白屏。 */
function placeholderPage(expected: string, reason: string): string {
  const theme = getCurrentTheme();
  const dark = theme === 'dark';
  const background = themeBackground(theme);
  const foreground = dark ? '#e6e8ee' : '#1d2733';
  const codeBackground = dark ? '#1b1f2a' : '#e6ecf5';
  const hintColor = dark ? '#9aa3b2' : '#6b7a90';

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WhalesLauncher</title>
<style>
  body { margin:0; padding:48px; background:${background}; color:${foreground};
         font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; line-height:1.7; }
  h1 { font-size:20px; margin:0 0 12px; }
  code { background:${codeBackground}; padding:2px 6px; border-radius:4px; }
  .hint { color:${hintColor}; font-size:13px; }
</style></head>
<body>
  <h1>界面资源尚未就绪</h1>
  <p>${escapeHtml(reason)}</p>
  <p>请在项目根目录执行 <code>npm run build</code>，然后重启启动器。</p>
  <p class="hint">期望路径：${escapeHtml(expected)}</p>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function focusMainWindow(): void {
  const win = mainWindow;
  if (win === null || win.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------------------------------------------ *
 * 退出
 * ------------------------------------------------------------------ */

function onBeforeQuit(event: Electron.Event): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // 先拦住退出，把子进程收干净再真正退出。
  event.preventDefault();
  void shutdown().finally(() => app.quit());
}

async function shutdown(): Promise<void> {
  try {
    const report = await stopAll(10_000);
    if (report.stopped.length > 0) {
      console.log(`[main] 已停止 ${report.stopped.length} 个 dsh 实例：${report.stopped.join('、')}`);
    }
    if (report.failed.length > 0) {
      console.warn(`[main] 未能优雅停止、将在退出时强制结束：${report.failed.join('、')}`);
    }
  } catch (error) {
    console.error('[main] 退出清理失败：', error);
  }
}

function onWillQuit(): void {
  // 最后一道防线：任何仍被记账的 dsh 子进程一律强杀。
  forceKillLeftovers();
}
