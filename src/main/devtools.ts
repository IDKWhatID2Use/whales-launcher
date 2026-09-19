/**
 * DevTools 能力开关（QR-11，P3 安全项）。
 *
 * **生产默认关闭**：`webPreferences.devTools: false` 会同时关掉 DevTools 能力本身与所有打开入口
 * （菜单项、`Ctrl+Shift+I` / `F12`、`webContents.openDevTools()`），避免正式包暴露调试能力。
 *
 * 两种打开方式（均需显式设置，默认关闭）：
 *  - `WHALES_DEV=1` 或 `--dev`：开发模式 —— 打开能力并**自动弹出** DevTools；
 *  - `WHALES_DEVTOOLS=1` 或 `--devtools`：仅打开能力、不自动弹出。
 *
 * 为什么保留第二种显式开关：启动器出问题时（例如用户机器的 npm/EPERM 环境差异），
 * 没有控制台就只能盲猜；留一个"临时开启"的口子比让用户改源码现实。但它**默认关闭**，
 * 且不会自动弹窗，不影响正常用户。
 *
 * 单独成模块是为了避免 `index.ts` / `menu.ts` / `shortcuts.ts` 之间为了读这个开关而互相 import。
 */

/** 开发模式：`WHALES_DEV=1` 或命令行 `--dev`。 */
export function isDevMode(): boolean {
  return process.env['WHALES_DEV'] === '1' || process.argv.includes('--dev');
}

/** 显式要求 DevTools 能力（不自带自动弹出）：`WHALES_DEVTOOLS=1` 或 `--devtools`。 */
function isDevToolsRequested(): boolean {
  return process.env['WHALES_DEVTOOLS'] === '1' || process.argv.includes('--devtools');
}

/**
 * DevTools 能力是否可用。**生产环境默认 false**（QR-11）。
 * 菜单项 `view.devtools` 的 `enabled`、快捷键与命令执行都以此为准，三处不会漂移。
 */
export function devToolsEnabled(): boolean {
  return isDevMode() || isDevToolsRequested();
}

/** 是否在窗口创建后自动弹出 DevTools（仅开发模式）。 */
export function devToolsAutoOpen(): boolean {
  return isDevMode();
}
