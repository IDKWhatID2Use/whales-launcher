#!/usr/bin/env node
/**
 * 产物级检查：Node 运行时探测与 nodePath 配置（`node tests/dist/node-runtime-check.cjs`）
 *
 * 守的是"实例启动失败"这类缺陷的**接线层**：core 里的 `node-runtime.ts` 再正确，
 * 只要 main 的 `launcher:detectNode` 没注册、或 `setConfig` 把用户的 nodePath 静默丢了，
 * 界面上就仍然只能看到一长串英文堆栈。
 *
 * 手法与 `verify-dist.cjs` 一致：替身 electron 加载真实产物，直接调用 IPC handler。
 *
 * 副作用控制：会临时改写 `launcher.json`（验证 nodePath 落盘与探测来源），
 * 用例结束时**逐字节还原**原文件；断言失败也同样还原（finally）。
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const CONFIG_FILE = path.join(ROOT, 'launcher.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/* ---------- 替身 electron ---------- */
const calls = { windows: [], handlers: new Map() };

class FakeWebContents {
  constructor() {
    this.handlers = {};
  }
  isDestroyed() {
    return false;
  }
  send() {}
  setWindowOpenHandler() {}
  on(event, handler) {
    (this.handlers[event] ??= []).push(handler);
  }
  getURL() {
    return `file:///${DIST.replace(/\\/g, '/')}/renderer/index.html`;
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
    this.handlers = {};
    this.urls = [];
    calls.windows.push(this);
  }
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  on(event, handler) {
    (this.handlers[event] ??= []).push(handler);
  }
  once(event, handler) {
    (this.handlers[event] ??= []).push(handler);
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
  Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: async () => ({}), on() {}, removeListener() {} },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

/** 调用一条 IPC 通道（第一个参数是 ipc 事件，替身里给空对象）。 */
function call(channel, ...args) {
  const handler = calls.handlers.get(channel);
  if (handler === undefined) throw new Error(`通道未注册：${channel}`);
  return handler({}, ...args);
}

async function main() {
  const configBackup = fs.readFileSync(CONFIG_FILE, 'utf8');

  console.log('\n[node-runtime-check] 产物加载');
  require(path.join(DIST, 'main', 'index.cjs'));
  await sleep(800);
  check('dist 产物可加载且通道注册齐全', () => {
    assert.ok(calls.handlers.size >= 32, `仅注册 ${calls.handlers.size} 条通道`);
    assert.ok(calls.handlers.has('launcher:detectNode'), '缺少 launcher:detectNode 通道');
  });

  console.log('\n[node-runtime-check] 探测');
  const detected = await call('launcher:detectNode', true);
  check('detectNode 返回真实可用的 Node.js', () => {
    assert.equal(detected.ok, true, `IPC 失败：${detected.error ?? ''}`);
    const report = detected.value;
    assert.equal(report.ok, true, `未找到可用 Node：${report.message}`);
    assert.match(report.file, /node(\.exe)?$/i, `file=${report.file}`);
    assert.match(String(report.version), /^\d+\.\d+\.\d+/);
    assert.equal(report.candidates[0].ok, true, '第一个候选取用的应是可用运行时');
  });

  console.log('\n[node-runtime-check] 配置校验（失败分支不得落盘）');
  const badType = await call('launcher:setConfig', { nodePath: 42 });
  check('非字符串 nodePath 被拒绝', () => {
    assert.equal(badType.ok, false);
    assert.match(badType.error, /字符串或 null/);
  });
  const badPath = await call('launcher:setConfig', { nodePath: 'C:\\definitely-not-here-whales.exe' });
  check('不存在的 nodePath 被拒绝', () => {
    assert.equal(badPath.ok, false);
    assert.match(badPath.error, /找不到/);
  });
  check('被拒绝的配置没有写进 launcher.json', () => {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    assert.equal(text.includes('definitely-not-here'), false, 'launcher.json 被污染');
  });

  console.log('\n[node-runtime-check] 配置生效');
  try {
    const saved = await call('launcher:setConfig', { nodePath: detected.value.file });
    check('合法 nodePath 可保存并回读', () => {
      assert.equal(saved.ok, true, `保存失败：${saved.error ?? ''}`);
      assert.equal(saved.value.nodePath, detected.value.file);
    });
    const configured = await call('launcher:detectNode', true);
    check('探测结果反映"全局设置"来源', () => {
      assert.equal(configured.ok, true);
      assert.equal(configured.value.source, 'config', `source=${configured.value.source}`);
      assert.equal(configured.value.file, detected.value.file);
    });
  } finally {
    fs.writeFileSync(CONFIG_FILE, configBackup);
    const restored = await call('launcher:detectNode', true);
    check('还原 launcher.json 后回到自动探测', () => {
      assert.equal(restored.ok, true);
      assert.equal(restored.value.ok, true);
      assert.notEqual(restored.value.source, 'config');
    });
  }

  console.log(`\n[node-runtime-check] 结果：${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('检查脚本自身异常：', error);
    process.exit(2);
  },
);
