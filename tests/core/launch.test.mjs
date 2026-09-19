/**
 * 启动 / 停止 / 运行时状态测试
 *
 * 用"假 dsh"（`seedStubEngine`）真实 spawn 一个进程（不是 mock），验证：
 *  - DSH_HOME 与 cwd 正确注入（假 dsh 会把它们写进 `<cwd>/.stub-start.json`）
 *  - 启动参数形态（`--profile <p>` + appArgs）
 *  - 运行时状态机 starting → running → stopped
 *  - 日志落盘与界面地址探测
 *  - 停止会终止整棵进程树
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, waitFor, run, test } from './_helpers.mjs';

const { core, ports } = await loadCoreModule();

const CONFIG = {
  schemaVersion: 1,
  primaryHome: 'C:\\Users\\tester\\.dsh',
  theme: 'dark',
  lastInstanceId: null,
  confirmOnDelete: true,
  engineRegistry: 'https://registry.npmjs.org',
};

/** 建一个带假引擎的临时根目录与实例。 */
async function setup(t, label = 'launch', input = {}) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '启动实例', engineVersion: '9.9.9', template: 'web', ...input });
  return { root, meta };
}

test('launchInstance：注入 DSH_HOME/cwd、传参正确、状态机 running', async (t) => {
  const { root, meta } = await setup(t);
  const states = [];
  const logs = [];
  const result = await core.launchInstance(root, meta, {}, CONFIG, {
    onState: (runtime) => states.push(runtime.state),
    onLog: (stream, text) => logs.push(`${stream}:${text}`),
  });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });
  assert.ok(result.pid > 0);
  assert.equal(result.dshHome, path.join(root, 'instances', meta.dirName, 'home'));
  assert.equal(result.cwd, path.join(root, 'instances', meta.dirName, 'workspace'));
  assert.deepEqual(states.slice(0, 2), ['starting', 'running']);

  const instanceWorkspace = path.join(root, 'instances', meta.dirName, 'workspace');
  assert.equal(await waitFor(async () => core.pathExists(path.join(instanceWorkspace, '.stub-start.json'))), true, '假 dsh 应已启动');
  const marker = await readJsonFile(path.join(instanceWorkspace, '.stub-start.json'));
  assert.equal(marker.home, result.dshHome, 'DSH_HOME 必须指向实例 home');
  assert.equal(marker.cwd, instanceWorkspace, 'cwd 必须是实例 workspace');
  // 启动器 flag 必须位于最前；web profile 之后会被**自动端口机制**追加一个 --port
  assert.deepEqual(marker.args.slice(0, 2), ['--profile', meta.profile.name], '启动器 flag 应位于最前');
  const portIndex = marker.args.indexOf('--port');
  assert.notEqual(portIndex, -1, `web 实例应自动注入 --port，实际 ${JSON.stringify(marker.args)}`);
  assert.equal(
    marker.args.length,
    4,
    `除 --profile <p> 与 --port <n> 外不应有多余参数，实际 ${JSON.stringify(marker.args)}`,
  );
  const injected = Number(marker.args[portIndex + 1]);
  /*
   * 端口落在候选区间内是常态；`0` 是**区间被占满时文档化的兜底**（交内核分配）。
   * 这里之所以接受 0：候选区间是机器级共享资源，别的程序（或并发的端口实验）大量占用时
   * 走兜底是正确行为，把它判成失败会把"环境忙"误报成"代码错"。
   * 区间内的分配由 `tests/core/ports.test.mjs` 用可控的隔离环境严格断言。
   */
  assert.ok(
    Number.isInteger(injected) &&
      (injected === 0 || (injected >= ports.PORT_RANGE_START && injected <= ports.PORT_RANGE_END)),
    `注入的端口应是区间内端口，或区间占满时的 0。实际 args=${JSON.stringify(marker.args)}` +
      `（若为 0，请确认 3080–3179 是否被外部程序大量占用）`,
  );

  const runtime = core.runtimeOf(meta.id);
  assert.equal(runtime.state, 'running');
  assert.equal(runtime.pid, result.pid);
  assert.equal(runtime.exitCode, null);
  assert.ok(core.listRuntimes().some((item) => item.instanceId === meta.id));
});

test('launchInstance：appArgs 追加在启动器 flag 之后', async (t) => {
  const { root, meta } = await setup(t, 'launch-args');
  await core.launchInstance(root, meta, { appArgs: ['--port', '8080'] }, CONFIG);
  t.after(() => core.stopInstance(meta.id).catch(() => undefined));
  const marker = path.join(root, 'instances', meta.dirName, 'workspace', '.stub-start.json');
  assert.equal(await waitFor(async () => core.pathExists(marker)), true);
  const parsed = await readJsonFile(marker);
  // 用户显式给了 --port 8080：**可用时应原样保留**（原地改写不会留下第二个 --port）；
  // 若本机 8080 已被占用，则新机制会避让并改写它的值 —— 两种情况下形状都是确定的。
  assert.deepEqual(parsed.args.slice(0, 2), ['--profile', meta.profile.name], 'appArgs 应追加在启动器 flag 之后');
  assert.equal(
    parsed.args.filter((item) => item === '--port').length,
    1,
    `命令行里必须恰好一个 --port，实际 ${JSON.stringify(parsed.args)}`,
  );
  if (await ports.isPortFree(8080)) {
    assert.deepEqual(parsed.args, ['--profile', meta.profile.name, '--port', '8080'], '显式端口可用时应原样保留');
  } else {
    assert.notEqual(parsed.args[3], '8080', '显式端口被占用时应已避让');
  }
  // 一次性覆盖不写回 instance.json
  const stored = await core.readInstance(root, meta.id);
  assert.deepEqual(stored.launch.appArgs, []);
});

test('launchInstance：记录 launchCount / lastLaunchedAt', async (t) => {
  const { root, meta } = await setup(t, 'launch-count');
  await core.launchInstance(root, meta, {}, CONFIG);
  t.after(() => core.stopInstance(meta.id).catch(() => undefined));
  const stored = await core.readInstance(root, meta.id);
  assert.equal(stored.launchCount, 1);
  assert.ok(stored.lastLaunchedAt !== null && !Number.isNaN(Date.parse(stored.lastLaunchedAt)));
});

test('launchInstance：日志落盘且能探测界面地址（退出后仍可读）', async (t) => {
  const { root, meta } = await setup(t, 'launch-logs');
  process.env.STUB_EXIT_AFTER_MS = '400';
  try {
    await core.launchInstance(root, meta, {}, CONFIG);
    const exited = await waitFor(() => core.runtimeOf(meta.id).state !== 'running', 15000);
    assert.equal(exited, true, '进程应在设定时间后自行退出');
  } finally {
    delete process.env.STUB_EXIT_AFTER_MS;
  }
  const runtime = core.runtimeOf(meta.id);
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.exitCode, 0);
  assert.equal(runtime.pid, null);
  assert.equal(runtime.url, 'http://127.0.0.1:3999/', '应探测到界面地址');
  const logDir = path.join(root, 'instances', meta.dirName, 'logs');
  const files = await fs.readdir(logDir);
  assert.equal(files.length, 1, '应只有一个日志文件');
  const text = await fs.readFile(path.join(logDir, files[0]), 'utf8');
  assert.ok(text.includes(`DSH_HOME=${path.join(root, 'instances', meta.dirName, 'home')}`), '日志应含 DSH_HOME');
  assert.ok(text.includes('stub: listening on http://127.0.0.1:3999/'), '日志应含子进程输出');
  assert.ok(text.includes('[whales] 进程退出'), '日志应含启动器自己的系统行');
});

test('stopInstance：终止进程树并落到 stopped', async (t) => {
  const { root, meta } = await setup(t, 'launch-stop');
  const result = await core.launchInstance(root, meta, {}, CONFIG);
  await core.stopInstance(meta.id);
  const runtime = core.runtimeOf(meta.id);
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.pid, null);
  // Windows 上被 TerminateProcess 终止的进程以 signal 报告，Node 给出的 exit code 为 null
  assert.ok(runtime.exitCode === null || typeof runtime.exitCode === 'number');
  // 进程确实没了（本机实测 taskkill 在受限沙箱会被拒绝，必须靠 child.kill）
  const dead = await waitFor(() => {
    try {
      process.kill(result.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000);
  assert.equal(dead, true, '进程应已被终止');
  // 重复停止是安全的
  await core.stopInstance(meta.id);
  assert.equal(core.runtimeOf(meta.id).state, 'stopped');
});

test('launchInstance：重复启动 / 引擎缺失 / 实例未知的处理', async (t) => {
  const { root, meta } = await setup(t, 'launch-errors');
  await core.launchInstance(root, meta, {}, CONFIG);
  t.after(() => core.stopInstance(meta.id).catch(() => undefined));
  await assert.rejects(() => core.launchInstance(root, meta, {}, CONFIG), /已在运行/);

  await assert.rejects(
    async () => {
      const ghost = { ...meta, id: 'ghost', engine: { version: '0.0.1' } };
      await core.launchInstance(root, ghost, {}, CONFIG);
    },
    /未安装/,
  );
});

test('launchInstance：启动前应用共享模式（saves=shared 建立 junction）', async (t) => {
  const { root, meta } = await setup(t, 'launch-share', { saves: 'shared' });
  const sessions = path.join(root, 'instances', meta.dirName, 'home', 'sessions');
  assert.equal(await core.removeLink(sessions), true, '先安全解除创建时建立的 junction');
  assert.equal(await core.isLink(sessions), false);
  await core.launchInstance(root, meta, {}, CONFIG);
  t.after(() => core.stopInstance(meta.id).catch(() => undefined));
  assert.equal(await core.isLink(sessions), true, '启动前应把共享模式落地');
});

test('runtimeOf：未启动的实例返回 stopped 默认值', async () => {
  const runtime = core.runtimeOf('never-launched');
  assert.deepEqual(runtime, {
    instanceId: 'never-launched',
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    port: null,
    exitCode: null,
    lastError: null,
  });
});

test('listRuntimes：只返回已登记条目；stopInstance 不为陌生 id 凭空造记录', async (t) => {
  const { root, meta } = await setup(t, 'launch-registry');
  // 未登记：listRuntimes 里不应出现该 id
  // （main 靠这一点区分"core 无该实例的运行记录"与"core 记录已停止"）
  assert.equal(core.listRuntimes().some((item) => item.instanceId === meta.id), false);
  await core.stopInstance(meta.id);
  assert.equal(
    core.listRuntimes().some((item) => item.instanceId === meta.id),
    false,
    'stopInstance 对从未登记的实例必须是无副作用的 no-op',
  );
  await core.stopInstance('brand-new-unknown-id');
  assert.equal(core.listRuntimes().some((item) => item.instanceId === 'brand-new-unknown-id'), false);

  // 真正运行过之后再停止，记录应保留且状态为 stopped
  await core.launchInstance(root, meta, {}, CONFIG);
  assert.equal(core.listRuntimes().some((item) => item.instanceId === meta.id), true);
  await core.stopInstance(meta.id);
  const after = core.listRuntimes().find((item) => item.instanceId === meta.id);
  assert.equal(after.state, 'stopped');
  assert.equal(after.pid, null);
});

test('core 单例暴露契约中的启动方法', async () => {
  for (const name of ['launchInstance', 'stopInstance', 'runtimeOf', 'listRuntimes']) {
    assert.equal(typeof core[name], 'function', `core.${name} 应为函数`);
  }
});

await run();
