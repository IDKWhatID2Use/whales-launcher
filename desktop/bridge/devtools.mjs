/**
 * DevTools 能力开关（QR-11，P3 安全项）。
 *
 * **内联自旧 Electron 主进程（`src` / `main`，本轮待拆除）的 `devtools.ts`（39 行），逐条搬运其判据**。
 * 为什么不 `import`：同 `errors.mjs` 的理由 —— 旧主进程目录是待拆除目录，
 * 桥接层不得再引用它。这里的判据只读 env / argv，与 Electron 无关，因此可以安全内联。
 *
 * 作用范围（桥接层）：`app:menu` 投影里 `view.devtools` 菜单项的 `enabled`
 * （旧实现里菜单项、快捷键与命令执行三处都以此为准，桥接层只剩菜单这一处）。
 *
 * 未搬运的导出：`devToolsAutoOpen()`（旧实现用它决定窗口创建后是否自动弹出
 * DevTools；WinUI 3 侧没有 Chromium DevTools，桥接层无调用方）。
 */

/** 开发模式：`WHALES_DEV=1` 或命令行 `--dev`。 */
export function isDevMode() {
  return process.env['WHALES_DEV'] === '1' || process.argv.includes('--dev');
}

/** 显式要求 DevTools 能力（不自带自动弹出）：`WHALES_DEVTOOLS=1` 或 `--devtools`。 */
function isDevToolsRequested() {
  return process.env['WHALES_DEVTOOLS'] === '1' || process.argv.includes('--devtools');
}

/**
 * DevTools 能力是否可用。**生产环境默认 false**（QR-11）。
 * 菜单项 `view.devtools` 的 `enabled` 以此为准。
 */
export function devToolsEnabled() {
  return isDevMode() || isDevToolsRequested();
}
