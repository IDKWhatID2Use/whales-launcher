/**
 * Node 运行时解析测试（**启动失败根因的回归护栏**）
 *
 * 背景：启动器曾经把 Electron 的 `process.execPath`（electron.exe）配
 * `ELECTRON_RUN_AS_NODE=1` 当 Node 跑 dsh，结果 dsh 的原生模块按运行时指纹拒绝：
 *
 * ```
 * node-addon-require-builtin unsupported: Unsupported/no-context
 *   (unsupported Electron runtime fingerprint: Node 24.14.0,
 *    V8 14.6.202.26-electron.0 (supported Electron versions: 43.0.0, ...))
 * ```
 *
 * 因此这里守住三件事：
 *  1. 解析结果必须是**真正的 Node.js**（Electron 指纹一律判为不可用）；
 *  2. 显式配置优先，且填错路径时必须在报告里可见（不能被静默跳过）；
 *  3. 失败文案是可直接给用户看的中文建议，而不是英文堆栈。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCoreModule, run, test } from './_helpers.mjs';

const coreModule = await loadCoreModule();
const { core } = coreModule;
const { classifyProbe, describeNodeCandidates, nodeRuntimeLabel, resolveNodeRuntime } = coreModule.nodeRuntime;

/** 临时改环境变量并在用例结束后恢复。 */
function withEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test('classifyProbe：真 Node 判定为可用', () => {
  const verdict = classifyProbe('WHALES_NODE_PROBE:{"node":"26.3.0","electron":null}', '', 0);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.version, '26.3.0');
  assert.equal(verdict.electron, null);
  assert.equal(verdict.reason, null);
});

test('classifyProbe：Electron 指纹必须被拒绝（本次缺陷的核心判据）', () => {
  const verdict = classifyProbe('WHALES_NODE_PROBE:{"node":"24.14.0","electron":"41.1.0"}', '', 0);
  assert.equal(verdict.ok, false, 'Electron 运行时绝不能当 Node 用');
  assert.equal(verdict.electron, '41.1.0');
  assert.match(verdict.reason, /Electron 41\.1\.0/);
  assert.match(verdict.reason, /独立的 Node\.js/);
});

test('classifyProbe：低版本 Node 被拒绝，且与 Electron 的原因可区分', () => {
  const verdict = classifyProbe('WHALES_NODE_PROBE:{"node":"18.20.4","electron":null}', '', 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /版本过低/);
  assert.match(verdict.reason, />= v20/);
});

test('classifyProbe：非 Node 可执行文件 / 无输出时给出带退出码的原因', () => {
  const broken = classifyProbe('', "'-e' 不是内部或外部命令", 1);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /探针未返回结果/);
  assert.match(broken.reason, /退出码 1/);

  const garbage = classifyProbe('WHALES_NODE_PROBE:not-json', '', 0);
  assert.equal(garbage.ok, false);
  assert.match(garbage.reason, /无法解析/);
});

test('resolveNodeRuntime：本进程是真 Node 时直接命中，且结果被缓存', async (t) => {
  withEnv(t, 'WHALES_NODE_PATH', undefined);
  const first = await resolveNodeRuntime({ captureDir: path.join(process.cwd(), 'cache'), refresh: true });
  assert.equal(first.ok, true, `应找到可用的 Node.js：${first.message}`);
  assert.equal(first.file, process.execPath);
  assert.equal(first.source, 'current');
  assert.match(first.version, /^\d+\.\d+\.\d+/);
  const cached = await resolveNodeRuntime({ captureDir: path.join(process.cwd(), 'cache') });
  assert.equal(cached, first, '同一配置下应复用缓存对象');
});

test('resolveNodeRuntime：显式配置优先，且填错路径必须出现在报告里', async (t) => {
  const bogus = path.join(process.cwd(), '.spike', 'not-a-real-node.exe');
  const report = await resolveNodeRuntime({
    configuredPath: bogus,
    captureDir: path.join(process.cwd(), 'cache'),
    refresh: true,
  });
  // 配置错了不应让启动器直接死掉，但必须能在诊断里看到
  assert.equal(report.candidates[0].file, path.resolve(bogus));
  assert.equal(report.candidates[0].source, 'config');
  assert.equal(report.candidates[0].ok, false);
  assert.match(report.candidates[0].reason, /不存在/);
  assert.equal(report.ok, true, '后面的候选（本进程）仍应顶上');
  assert.notEqual(report.file, path.resolve(bogus));
});

test('resolveNodeRuntime：环境变量 WHALES_NODE_PATH 指向非 Node 时会继续回退', async (t) => {
  const cmd = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  withEnv(t, 'WHALES_NODE_PATH', cmd);
  const report = await resolveNodeRuntime({
    captureDir: path.join(process.cwd(), 'cache'),
    refresh: true,
  });
  assert.equal(report.candidates[0].source, 'env');
  assert.equal(report.candidates[0].ok, false, 'cmd.exe 不是 Node');
  assert.ok(report.candidates[0].reason.length > 0);
  assert.equal(report.ok, true, '应回退到真实 Node');
  assert.equal(report.file, process.execPath);
});

test('resolveNodeRuntime：launcher.json 的 nodePath 作为配置来源被读取', async (t) => {
  // 造一个临时 root，只放 launcher.json：验证 core 在没有 config 参数的调用链
  //（createInstance → profile 初始化）里仍能拿到用户配置。
  const { makeTempRoot, cleanup } = await import('./_helpers.mjs');
  const root = await makeTempRoot('node-config');
  t.after(() => cleanup(root));
  const { promises: fs } = await import('node:fs');
  const configured = path.join(root, 'node-not-here.exe');
  await fs.writeFile(
    path.join(root, 'launcher.json'),
    `${JSON.stringify({ schemaVersion: 1, nodePath: configured }, null, 2)}\n`,
  );
  const report = await resolveNodeRuntime({
    root,
    captureDir: path.join(root, 'cache'),
    refresh: true,
  });
  assert.equal(report.candidates[0].source, 'config', 'launcher.json 的 nodePath 应作为 config 候选');
  assert.equal(report.candidates[0].file, path.resolve(configured));
});

test('nodeRuntimeLabel / describeNodeCandidates：给人看的文案可用', () => {
  const ok = {
    ok: true,
    file: 'C:\\Program Files\\nodejs\\node.exe',
    version: '26.3.0',
    source: 'path',
    candidates: [],
    message: '',
  };
  assert.match(nodeRuntimeLabel(ok), /Node v26\.3\.0/);
  assert.match(nodeRuntimeLabel(ok), /系统 PATH/);

  const bad = { ...ok, ok: false, file: null, version: null, source: null };
  assert.match(nodeRuntimeLabel(bad), /未找到/);

  const lines = describeNodeCandidates({
    ...ok,
    candidates: [
      { file: 'C:\\a\\node.exe', source: 'path', ok: true, version: '26.3.0', electron: null, reason: null },
      { file: 'C:\\b\\electron.exe', source: 'config', ok: false, version: '24.14.0', electron: '41.1.0', reason: '这是 Electron 运行时' },
    ],
  });
  assert.match(lines, /可用（Node v26\.3\.0/);
  assert.match(lines, /不可用：这是 Electron 运行时/);
});

test('explainLaunchFailure：把已知失败特征翻译成可操作的中文提示', () => {
  const electron = coreModule.explainLaunchFailure(
    'Error: dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context ' +
      '(unsupported Electron runtime fingerprint: Node 24.14.0, V8 14.6.202.26-electron.0)',
  );
  assert.ok(electron !== null);
  assert.match(electron, /Node 运行时/);

  const port = coreModule.explainLaunchFailure(
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:3080\n    at Server.setupListenHandle",
  );
  assert.ok(port !== null);
  assert.match(port, /3080/);
  assert.match(port, /--port/);

  assert.equal(coreModule.explainLaunchFailure('一切正常，没有任何已知失败特征'), null);
});

await run();
