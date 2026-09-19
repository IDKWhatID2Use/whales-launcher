/**
 * 窗口层主题：WCO 颜色、Mica 判定、主题应用。
 *
 * **唯一色源**（规范 `docs/design/ui-redesign.md` §7.4）：这里的常量与
 * `src/renderer/styles/tokens.css` 的同名令牌一一对应：
 *   BACKGROUND     = `--bg-app`              深 `#0b1017` / 浅 `#f3f6fb`
 *   OVERLAY_COLOR  = `--titlebar-surface` 压 `--material-fallback` 的合成色（§2.5，收敛 WCO 竖向接缝）
 *   OVERLAY_SYMBOL = `--text-2`              深 `#a2b2c8` / 浅 `#4c5c73`
 *
 * 渲染层**不得**重复实现主题判定（§4.9）：`titleBarOverlay` 是主进程选项、CSS 无权改，
 * 因此主题切换必须由主进程调用 `applyThemeToAllWindows()` 同步（反例 F-08）。
 */
import type { BrowserWindow } from 'electron';
import { forEachWindow } from './runtime.js';

export type ThemeName = 'dark' | 'light';

/**
 * 标题栏总高（DIP）。
 * **必须等于** `tokens.css` 的 `--titlebar-h: 48px`（规范 §2.2、§7.4 `OVERLAY_HEIGHT`）。
 */
export const TITLEBAR_HEIGHT = 48;

/** Windows 11 起始 build 号：Mica 可用门槛（规范 §4.9）。 */
const WINDOWS_11_BUILD = 22000;

const BACKGROUND: Readonly<Record<ThemeName, string>> = {
  dark: '#0b1017',
  light: '#f3f6fb',
};

const OVERLAY_COLOR: Readonly<Record<ThemeName, string>> = {
  dark: '#10151d',
  light: '#fbfcfe',
};

const OVERLAY_SYMBOL: Readonly<Record<ThemeName, string>> = {
  dark: '#a2b2c8',
  light: '#4c5c73',
};

/** 把任意配置值收敛为合法主题（配置损坏时也不至于让窗口变成不可读的配色）。 */
export function normalizeTheme(value: unknown): ThemeName {
  return value === 'light' ? 'light' : 'dark';
}

/**
 * 窗口层当前的生效主题。
 * 存在这里而不是 `index.ts`：主题同步的触发点在 IPC 层（`launcher:setConfig`），
 * 而窗口重建在 `index.ts` —— 放中间层既避免两者互相 import，也保证
 * 「重建窗口时用的主题」与「上一次同步给 WCO 的主题」是同一个值。
 */
let currentTheme: ThemeName = 'dark';

/** 记录当前生效主题。 */
export function setCurrentTheme(theme: ThemeName): void {
  currentTheme = theme;
}

/** 读取当前生效主题。 */
export function getCurrentTheme(): ThemeName {
  return currentTheme;
}

/** 窗口背景色：消除启动闪帧；Mica 生效时该值只在首帧可见（规范 §2.1）。 */
export function themeBackground(theme: ThemeName): string {
  return BACKGROUND[theme];
}

/**
 * WCO（系统窗口控制按钮区）颜色。
 * `color` **只能是不透明色**，取「标题栏表面压在 Mica 上的合成色」的实心近似 —— 规范 §2.5：
 * 深色合成为 `#20262f`、系统区必须是同深度的实心 `#10151d`，两者 ΔRGB ≈ 1–4，
 * 在 48px 高度内肉眼不可辨；不做这一步会在 x = 窗口宽 − 138px 处出现一条明显竖边。
 */
export function overlayOptions(theme: ThemeName): Electron.TitleBarOverlay {
  return {
    color: OVERLAY_COLOR[theme],
    symbolColor: OVERLAY_SYMBOL[theme],
    height: TITLEBAR_HEIGHT,
  };
}

/**
 * 本机是否支持 Mica（规范 §4.9 判定条件）。
 *
 * 只判 `Windows 11 build ≥ 22000`：系统「透明效果」开关**无法**从 Electron 可靠读取，
 * 而它关闭时 DWM 会自行按不透明渲染 —— 视觉上等效于 `'none'` 降级路径，
 * 因此无需另写一套不透明配色（反例 F-14）。RDP / 虚拟机下 Mica 可能不生效，同样由系统兜底。
 */
export function supportsMica(): boolean {
  if (process.platform !== 'win32') return false;
  const build = systemBuildNumber();
  return build !== null && build >= WINDOWS_11_BUILD;
}

/** 把主题应用到某个窗口：背景色 + WCO 颜色。 */
export function applyThemeToWindow(win: BrowserWindow, theme: ThemeName): void {
  if (win.isDestroyed()) return;

  try {
    win.setBackgroundColor(themeBackground(theme));
  } catch (error) {
    console.warn('[theme] 设置窗口背景色失败：', error);
  }

  try {
    win.setTitleBarOverlay(overlayOptions(theme));
  } catch (error) {
    // 非 win32 / linux 平台没有 WCO，属预期情况，不能影响启动。
    console.warn('[theme] 更新 WCO 颜色失败：', error);
  }
}

/** 把主题应用到所有窗口（`launcher:setConfig` 落库成功后调用，见 §4.9、F-08）。 */
export function applyThemeToAllWindows(theme: ThemeName): void {
  setCurrentTheme(theme);
  forEachWindow((win) => applyThemeToWindow(win, theme));
}

/** 系统 build 号；`process.getSystemVersion()` 形如 `10.0.22631`。 */
function systemBuildNumber(): number | null {
  try {
    const version = process.getSystemVersion();
    const build = Number.parseInt(version.split('.')[2] ?? '', 10);
    return Number.isFinite(build) ? build : null;
  } catch {
    return null;
  }
}
