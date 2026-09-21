/**
 * 环境与依赖自检测试（`src/core/preflight.ts`）
 *
 * 这里守住四件产品上最要紧的事：
 *  1. **全新根目录能被自动补齐**：目录缺失要自己建，且写探针真的验证过可写；
 *  2. **首次判定只发生一次**：`firstRun` 靠 `<root>/cache/preflight.json` 记账，
 *     第二次自检必须变成 `false`（否则首次报告会每次启动都弹）；
 *  3. **缺引擎时不静默失败**：默认不联网（`missing` + 中文建议）；开了自动安装但
 *     registry 不可达时，必须是 `failed` + 可操作建议，而不是抛异常把自检整个毁掉；
 *  4. **单飞**：并发自检复用同一次执行（界面连点按钮不该并发跑两遍 npm）。
 *
 * 所有用例都在 `.spike` 下的临时根目录里跑，绝不触碰真实启动器数据。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadCoreModule, makeTempRoot, cleanup, run, seedStubEngine, test } from './_helpers.mjs';

const coreModule = await loadCoreModule();
const { formatDuration, readPreflightState, runPreflight } = coreModule.preflight;

/**
 * 起一个本地假 registry。
 *
 * 为什么不直接指向 `http://127.0.0.1:1/`（拒绝连接）或真实 npm：**结论必须确定**。
 * 前者在带透明代理/网络沙箱的环境里反而可能拿到响应（实测本机就是如此），后者则把
 * 单元测试绑在公网可用性上。本地 HTTP 服务的返回值由用例决定，因此离线也稳定。
 * @param t 测试上下文（用于注册收尾）。
 * @param handler 请求处理器。
 * @returns {Promise<string>} registry 地址。
 */
async function startStubRegistry(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        // 必须显式断开存活连接：fetch（undici）默认 keep-alive，只调 close() 会一直
        // 等到连接自然过期，测试文件会凭空多出几十秒
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

/** 取指定 id 的检查项（找不到直接失败，避免"断言没跑到"的假通过）。 */
function checkOf(report, id) {
  const found = report.checks.find((item) => item.id === id);
  assert.ok(found !== undefined, `报告中缺少检查项 ${id}；实际有 ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

/** 建一个临时根目录并在用例结束后清理。 */
async function tempRoot(t, label) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  return root;
}

test('runPreflight：全新根目录自动补齐数据目录，且给出可读结论', async (t) => {
  const root = await tempRoot(t, 'preflight-fresh');
  const report = await runPreflight(root);

  const dirs = checkOf(report, 'runtime-dirs');
  assert.equal(dirs.status, 'fixed', `数据目录应被自动创建：${dirs.summary}`);
  assert.equal(dirs.autoFixed, true);

  // 目录真的在磁盘上（不是只在报告里说"修好了"）
  const { promises: fs } = await import('node:fs');
  for (const relative of ['instances', 'engines', 'shared', 'cache', 'shared/sessions', 'shared/workspaces']) {
    const info = await fs.stat(path.join(root, relative));
    assert.ok(info.isDirectory(), `${relative} 应是目录`);
  }

  // 探针文件绝不能留下
  const leftovers = (await fs.readdir(path.join(root, 'cache'))).filter((name) => name.includes('write-probe'));
  assert.deepEqual(leftovers, [], '写探针文件必须被删除');

  assert.equal(checkOf(report, 'node').status, 'ok', '本进程就是真 Node，应判定可用');
  assert.equal(checkOf(report, 'npm').status, 'ok', '测试机上有 npm，应判定可用');
  assert.equal(checkOf(report, 'network').status, 'skipped', '默认不做联网检查');
  assert.equal(report.firstRun, true);
  assert.equal(report.problemCount > 0, true, '全新根目录缺配置与引擎，必须如实报出问题');
  assert.match(report.message, /环境自检/);
  // 「假保证」防线：有问题时不许说"未发现需要处理的问题"
  assert.doesNotMatch(report.message, /未发现需要处理的问题/);
});

test('runPreflight：缺引擎默认不联网，给出可操作建议', async (t) => {
  const root = await tempRoot(t, 'preflight-noengine');
  const report = await runPreflight(root, { autoFix: true });
  const engine = checkOf(report, 'engine');
  assert.equal(engine.status, 'missing');
  assert.match(engine.summary, /引擎/);
  assert.match(engine.advice ?? '', /自动安装|引擎版本管理/);
  assert.equal(report.installedEngineVersion, null);
});

test('runPreflight：已装引擎时判为 ok，不再触发安装', async (t) => {
  const root = await tempRoot(t, 'preflight-engine-ok');
  await seedStubEngine(root, '9.9.9');
  const report = await runPreflight(root, { installEngine: true });
  const engine = checkOf(report, 'engine');
  assert.equal(engine.status, 'ok', `已装引擎不该再装：${engine.summary}`);
  assert.match(engine.summary, /9\.9\.9/);
  assert.equal(report.installedEngineVersion, null);
});

test('runPreflight：自动安装开启但 registry 不可达 → failed 且带建议，绝不抛错', async (t) => {
  const root = await tempRoot(t, 'preflight-registry-down');
  // 本地假 registry 一律 503：连通性探测立刻判为不可达，自检必须**不进入** npm 安装
  //（npm 对不可达 registry 会重试到分钟级，自检不能把用户挂在那里等）
  const registry = await startStubRegistry(t, (_req, res) => {
    res.writeHead(503);
    res.end();
  });
  const started = Date.now();
  const report = await runPreflight(root, { installEngine: true, registry });
  const elapsed = Date.now() - started;

  const engine = checkOf(report, 'engine');
  assert.equal(engine.status, 'failed');
  assert.match(engine.summary, /registry/);
  assert.match(engine.advice ?? '', /registry|网络/);
  assert.equal(report.ok, false);
  assert.equal(engine.detail !== null, true, '失败必须留下可读的细节');
  assert.ok(elapsed < 60_000, `registry 不可达时必须在秒级给出结论，实际 ${elapsed}ms`);
});

test('readPreflightState / firstRun：首次一次，之后不再算首次', async (t) => {
  const root = await tempRoot(t, 'preflight-state');
  assert.equal(await readPreflightState(root), null);

  const first = await runPreflight(root);
  assert.equal(first.firstRun, true);

  const state = await readPreflightState(root);
  assert.ok(state !== null, '自检后必须落下状态文件');
  assert.equal(state.runCount, 1);
  assert.equal(state.lastProblemCount, first.problemCount);
  assert.equal(state.lastOk, first.ok);

  const second = await runPreflight(root);
  assert.equal(second.firstRun, false, '第二次自检不该再算首次（否则首启报告每次都弹）');
  const after = await readPreflightState(root);
  assert.equal(after.runCount, 2);
  assert.equal(after.firstRunAt, state.firstRunAt, 'firstRunAt 必须保持第一次的时刻');
});

test('runPreflight：并发调用复用同一次执行（单飞）', async (t) => {
  const root = await tempRoot(t, 'preflight-singleflight');
  const [a, b] = await Promise.all([runPreflight(root), runPreflight(root)]);
  assert.equal(a, b, '并发自检必须复用同一个 Promise，而不是跑两遍');
});

test('runPreflight：状态文件损坏不影响自检结论', async (t) => {
  const root = await tempRoot(t, 'preflight-broken-state');
  const { promises: fs } = await import('node:fs');
  await fs.mkdir(path.join(root, 'cache'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'preflight.json'), '{ this is not json');
  assert.equal(await readPreflightState(root), null, '损坏的状态按"没有状态"处理');
  const report = await runPreflight(root);
  assert.equal(report.firstRun, true);
  assert.ok(report.checks.length > 0);
});

test('runPreflight：launcher.json 损坏时如实报 missing，并指向备份', async (t) => {
  const root = await tempRoot(t, 'preflight-broken-config');
  const { promises: fs } = await import('node:fs');
  await fs.writeFile(path.join(root, 'launcher.json'), 'not json at all');
  const report = await runPreflight(root);
  const config = checkOf(report, 'config');
  assert.equal(config.status, 'missing');
  assert.match(config.advice ?? '', /备份/);
});

test('runPreflight：联网检查按 registry 的真实响应给结论', async (t) => {
  const root = await tempRoot(t, 'preflight-network');

  const healthy = await startStubRegistry(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const okReport = await runPreflight(root, { checkNetwork: true, registry: healthy });
  const okCheck = checkOf(okReport, 'network');
  assert.equal(okCheck.status, 'ok', okCheck.summary);
  assert.match(okCheck.detail ?? '', /127\.0\.0\.1/);

  const broken = await startStubRegistry(t, (_req, res) => {
    res.writeHead(503);
    res.end();
  });
  const badReport = await runPreflight(root, { checkNetwork: true, registry: broken });
  const badCheck = checkOf(badReport, 'network');
  assert.equal(badCheck.status, 'failed');
  assert.match(badCheck.advice ?? '', /网络|镜像/);
});

test('formatDuration：给人看的时间文案', () => {
  assert.equal(formatDuration(820), '820ms');
  assert.equal(formatDuration(3400), '3.4s');
  assert.equal(formatDuration(130_000), '2m10s');
});

await run();
