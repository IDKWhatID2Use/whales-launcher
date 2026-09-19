#!/usr/bin/env node
/**
 * QR-08 运行时验证（core-engineer 点名要的）：`node tests/dist/qr08-check.cjs`
 *
 * 要验的行为：`EngineInfo.sizeBytes` 是**惰性**的 —— 首次扫描返回 `null`，
 * 后台算完后再次查询返回真实数值（配合 mtime 缓存）。
 *
 * 做法：加载**真实产物** `dist/main/index.cjs`，但把 `app.getAppPath()` 指向临时根
 * `tests/dist/root`，在那里放一个假引擎目录 —— 这样既能走通真实链路，
 * 又**不会污染真实 `engines/`**（否则会有一个假版本出现在启动器界面上）。
 *
 * 退出码：0 = 通过；1 = 失败。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const HERE = __dirname;
// 临时根放在本目录下（脚本结束前会自行 rmSync 清理），不污染真实 engines/。
const ROOT = path.join(HERE, 'root');
// 产物目录：向上查找项目根，使脚本**可被搬移**后仍然可用。
// （曾经写成 `HERE/../..`：从 tests/dist/ 能对，但一旦再被移动就会指向错误位置 ——
//  与 verify-dist.cjs 保持同一种做法，避免"搬一次改一次"。）
const DIST = path.join(findProjectRoot(HERE), 'dist');
const FAKE_VERSION = '0.0.0-qr08test';
const FAKE_PKG_DIR = path.join(ROOT, 'engines', FAKE_VERSION, 'node_modules', '@deepseek-ai', 'dsh');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 向上查找最近的、同时含 `package.json` 与 `dist` 的祖先目录。 */
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

/* ---------- 造一个假引擎目录（带一点体积，便于断言数值 > 0） ----------
 * 注意：core 判定"引擎已安装"的依据不只有 package.json，还要有 `lib/bin.js`
 * （`paths.engineBinCandidate`）。只放 package.json 会得到 `installed:false`。
 */
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(FAKE_PKG_DIR, { recursive: true });
fs.writeFileSync(
  path.join(FAKE_PKG_DIR, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: FAKE_VERSION }, null, 2),
  'utf8',
);
fs.mkdirSync(path.join(FAKE_PKG_DIR, 'lib'), { recursive: true });
fs.writeFileSync(path.join(FAKE_PKG_DIR, 'lib', 'bin.js'), '// fake dsh entry\n', 'utf8');
fs.writeFileSync(path.join(FAKE_PKG_DIR, 'payload.bin'), Buffer.alloc(4096, 7));

/* ---------- 替身 electron（getAppPath 指向临时根） ---------- */
const calls = { windows: [], handlers: new Map() };

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
    return 'file:///F:/x/index.html';
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
  loadFile() {
    return Promise.resolve();
  }
  loadURL() {
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
    quit() {},
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
  Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: async () => ({}), on() {}, removeListener() {} },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  console.log('\n[qr08] EngineInfo.sizeBytes 惰性行为（走真实产物 + 临时根）');

  require(path.join(DIST, 'main', 'index.cjs'));
  await sleep(500);

  const listEngines = calls.handlers.get('engine:list');
  check('engine:list 通道已注册', () => assert.ok(listEngines, '未注册'));

  const first = await listEngines({ sender: null });
  check('首次查询：引擎被列出，sizeBytes 为 null（惰性，未阻塞列表）', () => {
    assert.equal(first.ok, true, `engine:list 失败：${first.error}`);
    assert.equal(first.value.length, 1, `应列出 1 个假引擎，实际 ${first.value.length}`);
    assert.equal(first.value[0].version, FAKE_VERSION, `版本不符：${first.value[0].version}`);
    assert.equal(
      first.value[0].installed,
      true,
      `应识别为已安装（需 package.json + lib/bin.js），实际 installed=${first.value[0].installed}`,
    );
    assert.equal(first.value[0].sizeBytes, null, `首次应为 null，实际 ${first.value[0].sizeBytes}`);
  });

  // 等后台体积计算完成（core 用 mtime 缓存，不会重复算）
  let second = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    second = await listEngines({ sender: null });
    if (second.ok && second.value[0]?.sizeBytes !== null) break;
  }

  check('再次查询：sizeBytes 变为数值且 > 0（后台算完 + mtime 缓存）', () => {
    assert.equal(second.ok, true);
    const size = second.value[0]?.sizeBytes;
    assert.equal(typeof size, 'number', `仍为 ${JSON.stringify(size)}`);
    assert.ok(size > 0, `体积应 > 0，实际 ${size}`);
  });

  check('清理临时根（不污染真实 engines/）', () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    assert.equal(fs.existsSync(ROOT), false);
  });

  console.log(`\n[qr08] 结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('脚本自身异常：', error);
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(2);
  },
);
