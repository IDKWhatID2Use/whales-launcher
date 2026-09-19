/**
 * 真实 dsh 启动集成测试（找不到 dsh 时自动跳过）
 *
 * **这是本次缺陷（实例启动失败）的端到端回归护栏**：
 * 用真实的 `@deepseek-ai/dsh` 引擎创建实例并启动，断言真的能起来。
 *
 * 关键设计：
 *  - `appArgs: ['--port', '0', '--no-open']` —— `--port 0` 让系统分配空闲端口，
 *    测试不会和「本机已在跑的 dsh Web（3080）」或别的实例抢端口，也不会弹浏览器；
 *  - 用 `resolveNodeRuntime` 的产物（真 Node）执行：若启动器又把 Electron 当 Node，
 *    这里会以 dsh 的原生模块报错失败（`node-addon-require-builtin unsupported`）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanup, findRealDshPackage, loadCoreModule, makeTempRoot, run, test, waitFor } from './_helpers.mjs';

const coreModule = await loadCoreModule();
const { core } = coreModule;

/** 最小可用配置（与 main 的 defaultConfig 同形）。 */
const CONFIG = {
  schemaVersion: 1,
  primaryHome: 'C:\\Users\\tester\\.dsh',
  theme: 'dark',
  lastInstanceId: null,
  confirmOnDelete: true,
  engineRegistry: 'https://registry.npmjs.org',
  nodePath: null,
};

test('真实 dsh：用真 Node 启动实例，能探测到界面地址并能正常停止', async (t) => {
  const dshDir = await findRealDshPackage();
  if (dshDir === null) {
    t.skip('本机未找到真实 @deepseek-ai/dsh 安装，跳过');
    return;
  }
  const root = await makeTempRoot('real-launch');
  t.after(() => cleanup(root));

  const engine = await core.attachEngineFromLocal(root, dshDir);
  const meta = await core.createInstance(root, {
    name: '真实启动',
    engineVersion: engine.version,
    template: 'web',
  });

  const logs = [];
  const result = await core.launchInstance(
    root,
    meta,
    { appArgs: ['--port', '0', '--no-open'] },
    CONFIG,
    { onLog: (_stream, text) => logs.push(text) },
  );
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  assert.ok(result.pid > 0, '应拿到子进程 PID');
  const sawRuntimeLine = logs.some((line) => line.includes('Node 运行时：'));
  assert.equal(sawRuntimeLine, true, '日志必须写明实际使用的 Node 运行时');

  const sniffed = await waitFor(() => core.runtimeOf(meta.id).url !== null, 90_000);
  const tail = logs.join('').slice(-3000);
  assert.equal(sniffed, true, `应在 90s 内打印界面地址；实际日志尾部：\n${tail}`);
  assert.equal(core.runtimeOf(meta.id).state, 'running');
  // dsh Web 会带一次性 token 查询串（`/?token=...`），这里只校验地址形态
  assert.match(core.runtimeOf(meta.id).url, /^http:\/\/127\.0\.0\.1:\d+\//);

  await core.stopInstance(meta.id);
  assert.equal(core.runtimeOf(meta.id).state, 'stopped');
  assert.equal(core.runtimeOf(meta.id).pid, null);
});

test('真实 dsh：profile 初始化（创建实例）由真 Node 执行', async (t) => {
  const dshDir = await findRealDshPackage();
  if (dshDir === null) {
    t.skip('本机未找到真实 @deepseek-ai/dsh 安装，跳过');
    return;
  }
  const root = await makeTempRoot('real-node-init');
  t.after(() => cleanup(root));
  const engine = await core.attachEngineFromLocal(root, dshDir);
  const logs = [];
  const meta = await core.createInstance(
    root,
    { name: '初始化检查', engineVersion: engine.version, template: 'web' },
    { onLog: (_stream, text) => logs.push(text) },
  );
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  assert.equal(await core.pathExists(path.join(profileDir, 'package.json')), true);
  // 初始化命令必须指向真正的 node 可执行文件，而不是 electron.exe
  const initLine = logs.find((line) => line.includes('初始化 profile：'));
  assert.ok(initLine !== undefined, '应记录 profile 初始化命令');
  assert.equal(/electron\.exe/i.test(initLine), false, `初始化不得使用 Electron 运行时：${initLine}`);
});

await run();
