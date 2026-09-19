#!/usr/bin/env node
/**
 * 产物加载验证（可重复执行）：`node tests/dist/verify-dist.cjs`
 *
 * 为什么需要它：**esbuild 不做类型检查**，所以「`npm run build` 成功」不等于「产物可运行」。
 * 本脚本用替身 electron 直接 `require(dist/main/index.cjs)`，能在 1 秒内抓住
 * 「构建通过、但模块初始化就抛错」这一类问题（例如 core 中间态引入的未定义标识符），
 * 并顺带核对渲染层静态引用是否断链。
 *
 * ⚠️ 时序要点：`require` 只跑到「注册 app.whenReady 回调」为止，**建窗与 IPC 注册发生在
 * 之后的事件循环里**，因此断言前必须等一小段（早期版本漏了这一步，会把"还没跑"误判成"没建窗"）。
 *
 * 退出码：0 = 全部通过；1 = 有失败项。只读 dist，不启动 GUI、不写任何文件。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const ROOT = findProjectRoot(__dirname);
const DIST = path.join(ROOT, 'dist');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 向上查找项目根（最近的、同时含 `package.json` 与 `dist` 的祖先目录）。
 * 目的：让本脚本**可被搬移到任意子目录**（例如从临时目录挪进正式测试目录）后仍可用 ——
 * 否则一旦有人移动文件，脚本里的相对路径就会指向错误位置，而"命令跑不起来"比没有脚本更糟。
 */
function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'dist'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..');
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  \u2717 ${name}\n      ${error.message}`);
  }
}

/**
 * 读取启动器持久化的主题（`launcher.json`）。
 *
 * 与 `main/config.ts` 的默认值保持一致：读不到或值非法时按深色处理。
 * @returns {'dark'|'light'}
 */
function persistedTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'launcher.json'), 'utf8'));
    return raw.theme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/* ---------- 替身 electron ---------- */
const calls = { windows: [], handlers: new Map(), quit: 0 };

class FakeWebContents {
  constructor() {
    this.destroyed = false;
    this.handlers = {};
  }
  isDestroyed() {
    return this.destroyed;
  }
  send() {}
  setWindowOpenHandler() {}
  on(event, handler) {
    (this.handlers[event] ??= []).push(handler);
  }
  fire(event, ...args) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
  getURL() {
    return 'file:///F:/WhalesLauncher/dist/renderer/index.html';
  }
  openDevTools() {}
  toggleDevTools() {}
  reload() {}
  reloadIgnoringCache() {}
  getZoomLevel() {
    return 0;
  }
  setZoomLevel() {}
  undo() {}
  redo() {}
  cut() {}
  copy() {}
  paste() {}
  selectAll() {}
}

class FakeWindow {
  constructor(options = {}) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.windowHandlers = {};
    this.urls = [];
    calls.windows.push(this);
  }
  static getFocusedWindow() {
    return calls.windows.find((win) => !win.destroyed) ?? null;
  }
  static getAllWindows() {
    return [...calls.windows];
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  on(event, handler) {
    (this.windowHandlers[event] ??= []).push(handler);
  }
  once(event, handler) {
    (this.windowHandlers[event] ??= []).push(handler);
  }
  show() {}
  focus() {}
  restore() {}
  minimize() {}
  close() {}
  setFullScreen() {}
  isFullScreen() {
    return false;
  }
  setBackgroundColor() {}
  setTitleBarOverlay() {}
  loadFile(file) {
    this.urls.push(file);
    return Promise.resolve();
  }
  loadURL(url) {
    this.urls.push(url);
    return Promise.resolve();
  }
}

const electronStub = {
  app: {
    getAppPath: () => ROOT,
    getVersion: () => '1.0.0',
    getPath: (name) => path.join(ROOT, name),
    setName() {},
    setAppUserModelId() {},
    quit() {
      calls.quit += 1;
    },
    exit() {},
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: FakeWindow,
  ipcMain: {
    handle: (channel, fn) => calls.handlers.set(channel, fn),
    removeHandler: (channel) => calls.handlers.delete(channel),
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
    showMessageBoxSync: () => 1,
  },
  shell: { openPath: async () => '', openExternal: async () => {} },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: async () => ({}), on() {}, removeListener() {} },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  console.log('\n[verify-dist] 产物存在性');
  for (const rel of ['main/index.cjs', 'preload/index.cjs', 'renderer/index.js', 'renderer/index.html']) {
    check(rel, () => assert.ok(fs.existsSync(path.join(DIST, rel)), '缺失'));
  }

  console.log('\n[verify-dist] 加载 dist/main/index.cjs（替身 electron）');
  let loadError = null;
  try {
    require(path.join(DIST, 'main', 'index.cjs'));
  } catch (error) {
    loadError = error;
  }
  check('require 不抛错（模块初始化可完成）', () => {
    if (loadError) throw loadError;
  });
  if (loadError) {
    console.log(`\n[verify-dist] 结果：加载失败，后续断言跳过 ✗`);
    return 1;
  }

  // require 只跑到「注册 whenReady 回调」；建窗与 IPC 注册在之后的事件循环里发生。
  await sleep(500);

  console.log('\n[verify-dist] 运行时接线（等 whenReady 之后）');
  check('创建了主窗口', () => {
    assert.equal(calls.windows.length, 1, `窗口数 ${calls.windows.length}`);
  });
  check('安全三件套 + preload 路径', () => {
    const prefs = calls.windows[0]?.options?.webPreferences ?? {};
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.ok(
      String(prefs.preload).endsWith(path.join('dist', 'preload', 'index.cjs')),
      `preload=${prefs.preload}`,
    );
  });
  check('WCO / Mica / 背景色参数齐全（T5 窗口外壳）', () => {
    const options = calls.windows[0]?.options ?? {};
    assert.equal(options.titleBarStyle, 'hidden');
    assert.equal(options.titleBarOverlay?.height, 48);
    assert.ok(['mica', 'none'].includes(options.backgroundMaterial), `backgroundMaterial=${options.backgroundMaterial}`);
    /*
     * 背景色取决于**持久化的主题**（`src/main/theme.ts` 的 `themeBackground`：
     * 深 `#0b1017` / 浅 `#f3f6fb`）。
     * 这里原本写死深色 —— 结果是"用户在浅色主题下跑本脚本必然误报失败"：
     * 一个只与环境状态有关的假失败（实测踩到过）。因此按 launcher.json 的实际主题取期望值。
     */
    const theme = persistedTheme();
    const expected = theme === 'light' ? '#f3f6fb' : '#0b1017';
    assert.equal(options.backgroundColor, expected, `launcher.json 的主题是 ${theme}，背景色应为 ${expected}`);
  });

  // 图标接线的回归保护：`assets/whales.ico` 是**生成物**（scripts/make-icon.mjs），
  // 最容易被"清理构建产物"这类操作顺手删掉；而它一旦缺失，应用照样启动，
  // 只是任务栏顶着 Electron 的默认原子图标 —— 没人会立刻发现。
  // 因此这里双向断言：文件在该在的位置，且主进程确实把它传给了窗口。
  check('应用图标存在且已接到 BrowserWindow.icon', () => {
    const iconFile = path.join(ROOT, 'assets', 'whales.ico');
    assert.ok(fs.existsSync(iconFile), `缺少 ${iconFile}，请运行 npm run icon`);
    assert.equal(
      calls.windows[0]?.options?.icon,
      iconFile,
      `窗口 icon=${String(calls.windows[0]?.options?.icon)}`,
    );
    // ICO 头：reserved=0 / type=1 / count>=1，且尺寸表里的 256 档记作 0。
    const head = fs.readFileSync(iconFile).subarray(0, 6);
    assert.equal(head.readUInt16LE(0), 0, 'ICONDIR.reserved 必须为 0');
    assert.equal(head.readUInt16LE(2), 1, 'ICONDIR.type 必须为 1（icon）');
    assert.ok(head.readUInt16LE(4) >= 1, `图标档数 ${head.readUInt16LE(4)}`);
  });
  check('全部 invoke 通道已注册（≥31）', () => {
    assert.ok(calls.handlers.size >= 31, `仅注册 ${calls.handlers.size} 条`);
  });

  console.log('\n[verify-dist] 渲染层静态引用不断链');
  check('index.html 的 script/link 引用都能解析到真实文件', () => {
    const htmlPath = path.join(DIST, 'renderer', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((ref) => !/^(https?:|data:|#)/.test(ref));
    assert.ok(refs.length > 0, 'index.html 里没有任何本地引用，请人工确认');
    const missing = refs.filter((ref) => {
      const clean = ref.split('?')[0].split('#')[0];
      return !fs.existsSync(path.resolve(path.dirname(htmlPath), clean));
    });
    assert.deepEqual(missing, [], `断链引用：${missing.join(', ')}`);
    console.log(`      （核对 ${refs.length} 个引用：${refs.join(', ')}）`);
  });

  // Lead 已决定：Markdown 是开发文档，不进产物（`build.mjs` 的 copyStatic 已排除 .md）。
  // 这条断言来自一次真实事故：有人用手工 `Copy-Item` 把 PREVIEW.md 写回了 dist，
  // 等于用手工动作撤销了刚加的管线规则；而 Copy-Item 保留源文件时间戳，
  // 让它在 mtime 上看起来"比构建更早"，进一步误导排查。
  check('产物中不含 Markdown 开发文档（管线规则不得被手工动作撤销）', () => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.md')) found.push(path.relative(DIST, target));
      }
    };
    walk(DIST);
    assert.deepEqual(found, [], `产物中出现了开发文档：${found.join(', ')}`);
  });

  // 静态资源必须与源码逐字节一致：源改了产物没跟上、或手工改过产物，都能被抓住。
  // 之所以用 SHA256 而不是时间戳：Copy-Item 保留源 mtime，时间戳在"手工改产物"场景里会说谎。
  check('静态资源与 src/renderer 逐字节一致（SHA256 对账）', () => {
    const crypto = require('node:crypto');
    const srcDir = path.join(ROOT, 'src', 'renderer');
    const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const mismatched = [];
    for (const rel of [
      'styles/tokens.css',
      'styles/base.css',
      'styles/layout.css',
      'styles/components.css',
      'styles/views.css',
      'index.html',
    ]) {
      const src = path.join(srcDir, rel);
      const dst = path.join(DIST, 'renderer', rel);
      if (!fs.existsSync(dst) || hash(src) !== hash(dst)) mismatched.push(rel);
    }
    assert.deepEqual(mismatched, [], `与源码不一致：${mismatched.join(', ')}`);
    console.log('      （6 个静态资源 SHA256 全部一致）');
  });

  console.log(`\n[verify-dist] 结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('验证脚本自身异常：', error);
    process.exit(2);
  },
);
