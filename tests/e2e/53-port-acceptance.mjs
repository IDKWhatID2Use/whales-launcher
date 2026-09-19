/**
 * 自动端口验收（真实 dsh 引擎）
 *
 * 验收标准（用户给定）：
 *  1. 同时启动 N 个实例，全部正常运行且**监听端口互不冲突**；
 *  2. 当某端口被外部占用时，实例仍能**自动避让并成功启动**。
 *
 * 判定方式刻意选用"外部可观测的事实"，而不是启动器的自我report：
 *  - 每个实例都做一次真实 HTTP 请求 → 证明它**真的在监听**（不是只打印了地址）；
 *  - 端口集合去重 → 证明互不冲突；
 *  - 台账逐条对账 → 证明"实际端口"被如实记录（需求 4）。
 *
 * 用法：`node tests/e2e/53-port-acceptance.mjs [实例数]`（默认 8）
 *
 * 注意：所有实例都带 `--no-open`。`dsh web` 默认会自己拉起默认浏览器，
 * 不加这个参数会一次性弹出 N 个浏览器标签页 —— 验收脚本不能这么打扰使用者。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { REPO_ROOT, cleanup, loadCoreBundle, makeTempRoot, waitFor } from './_bundle.mjs';

const COUNT = Number(process.argv[2] ?? '8');
/** 真实 dsh 启动较慢（要组完整棵插件树），给足时间。 */
const READY_TIMEOUT_MS = 120_000;

const { core, ports } = await loadCoreBundle();

const CONFIG = {
  schemaVersion: 1,
  primaryHome: path.join(process.env.USERPROFILE ?? 'C:\\Users\\tester', '.dsh'),
  theme: 'dark',
  lastInstanceId: null,
  confirmOnDelete: true,
  engineRegistry: 'https://registry.npmjs.org',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail.length > 0 ? ` —— ${detail}` : ''}\n`);
}

/** 找一个本机真实安装的 dsh 引擎目录。 */
async function findEngineSource() {
  const enginesDir = path.join(REPO_ROOT, 'engines');
  const versions = await fs.readdir(enginesDir).catch(() => []);
  for (const version of versions) {
    const dir = path.join(enginesDir, version, 'node_modules', '@deepseek-ai', 'dsh');
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') return { dir, version: manifest.version };
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

/** 占住一个端口（真实监听）。 */
function holdPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server));
  });
}

/** 真实请求一次界面地址；返回 HTTP 状态码，失败返回 null。 */
function probeHttp(port, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

/** 区间内第一个真正空闲的端口。 */
async function firstFreePort() {
  for (const port of ports.scanOrder(ports.PORT_RANGE_START)) {
    if (await ports.isPortFree(port)) return port;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */

const engine = await findEngineSource();
if (engine === null) {
  process.stdout.write('SKIP 本机 engines/ 下没有真实 dsh，无法执行真实验收\n');
  process.exit(0);
}
process.stdout.write(`引擎：${engine.version}（${engine.dir}）\n实例数：${String(COUNT)}\n\n`);

const root = await makeTempRoot('ports-acc');
const started = [];
let holders = [];

try {
  await core.attachEngineFromLocal(root, engine.dir);

  /* ---------------------------------------------------------------- *
   * 前置：占住一个端口，模拟"被外部程序占用"
   * ---------------------------------------------------------------- */

  const occupied = await firstFreePort();
  assert.notEqual(occupied, null, '区间内应至少有一个空闲端口');
  const holder = await holdPort(occupied);
  assert.notEqual(holder, null, '应能占住端口');
  holders.push(holder);
  process.stdout.write(`外部占用：127.0.0.1:${String(occupied)}\n\n`);

  /* ---------------------------------------------------------------- *
   * 场景 A：N 个实例同时启动（其中第 1 个把端口显式指定为被占用的那个）
   * ---------------------------------------------------------------- */

  const metas = [];
  for (let index = 0; index < COUNT; index += 1) {
    metas.push(
      await core.createInstance(root, {
        name: `验收实例 ${String(index + 1)}`,
        engineVersion: engine.version,
        template: 'web',
      }),
    );
  }

  const launchedAt = Date.now();
  await Promise.all(
    metas.map((meta, index) =>
      core.launchInstance(
        root,
        meta,
        {
          instanceId: meta.id,
          // 全部带 --no-open；第 1 个显式指向被外部占用的端口，验证"避让"而不是"失败"
          appArgs: index === 0 ? ['--no-open', '--port', String(occupied)] : ['--no-open'],
        },
        CONFIG,
        { onLog: () => undefined },
      ),
    ),
  );

  // 等全部实例打印出界面地址
  const ready = await Promise.all(metas.map((meta) => waitFor(() => core.runtimeOf(meta.id).url !== null, READY_TIMEOUT_MS)));
  const bootMs = Date.now() - launchedAt;
  check(
    `${String(COUNT)} 个实例全部启动并打印界面地址`,
    ready.every(Boolean),
    `${String(ready.filter(Boolean).length)}/${String(COUNT)} 就绪，耗时 ${String(bootMs)}ms`,
  );

  const runtimes = metas.map((meta) => core.runtimeOf(meta.id));
  const actualPorts = runtimes.map((runtime) => runtime.port);
  check(
    '每个实例都记录到了实际端口',
    actualPorts.every((port) => typeof port === 'number' && port > 0),
    actualPorts.join(', '),
  );
  check(
    '端口互不冲突（无重复）',
    new Set(actualPorts).size === actualPorts.length,
    `去重后 ${String(new Set(actualPorts).size)} 个 / 共 ${String(actualPorts.length)} 个`,
  );
  check(
    '全部落在候选区间 3080–3179 内',
    actualPorts.every((port) => port >= ports.PORT_RANGE_START && port <= ports.PORT_RANGE_END),
  );
  check(
    '没有任何实例落在被外部占用的端口上（避让生效）',
    actualPorts.every((port) => port !== occupied),
    `被占端口 ${String(occupied)}`,
  );
  check(
    '地址里的端口与实际端口一致（回填正确）',
    runtimes.every((runtime) => runtime.url !== null && runtime.url.includes(`:${String(runtime.port)}`)),
  );

  /* ---------------------------------------------------------------- *
   * 真实监听验证：逐个发一次 HTTP 请求
   * ---------------------------------------------------------------- */

  const statuses = [];
  for (const port of actualPorts) statuses.push(await probeHttp(port));
  check(
    '每个实例都在自己的端口上真实监听（HTTP 探测有响应）',
    statuses.every((code) => typeof code === 'number' && code > 0),
    statuses.map((code, index) => `${String(actualPorts[index])}→${code === null ? '无响应' : String(code)}`).join(' '),
  );

  /* ---------------------------------------------------------------- *
   * 台账对账（需求 4：记录每个实例实际使用的端口）
   * ---------------------------------------------------------------- */

  const ledger = await ports.readPortLedger(root);
  const recorded = metas.map((meta) => ledger.allocations[meta.id]).filter((item) => item !== undefined);
  check(
    '台账为每个实例都留下了记录',
    recorded.length === COUNT,
    `${String(recorded.length)}/${String(COUNT)} 条`,
  );
  check(
    '台账记录的端口与实际端口逐条一致',
    metas.every((meta, index) => ledger.allocations[meta.id]?.last === actualPorts[index]),
  );
  check(
    '台账记下了各实例的期望端口（重启后端口稳定）',
    metas.every((meta) => typeof ledger.allocations[meta.id]?.preferred === 'number'),
  );

  /* ---------------------------------------------------------------- *
   * 场景 B：端口回收与重用
   * ---------------------------------------------------------------- */

  await Promise.all(metas.map((meta) => core.stopInstance(meta.id).catch(() => undefined)));
  check(
    '停止后进程全部退出',
    await waitFor(() => metas.every((meta) => core.runtimeOf(meta.id).state === 'stopped'), 30_000),
  );

  // B1：普通实例重启应复用它的期望端口（首次分到的那个）
  const plain = metas[1];
  await core.launchInstance(root, plain, { instanceId: plain.id, appArgs: ['--no-open'] }, CONFIG, {
    onLog: () => undefined,
  });
  started.push(plain);
  const plainReady = await waitFor(() => core.runtimeOf(plain.id).url !== null, READY_TIMEOUT_MS);
  check(
    '普通实例重启后复用同一端口（期望端口未被避让机制弄丢）',
    plainReady && core.runtimeOf(plain.id).port === actualPorts[1],
    `首次 ${String(actualPorts[1])} → 重启后 ${String(core.runtimeOf(plain.id).port)}`,
  );

  // B2：外部占用解除后，显式指定端口的实例应当回到它指定的那个端口
  await Promise.all(holders.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  holders = [];
  const pinned = metas[0];
  await core.launchInstance(
    root,
    pinned,
    { instanceId: pinned.id, appArgs: ['--no-open', '--port', String(occupied)] },
    CONFIG,
    { onLog: () => undefined },
  );
  started.push(pinned);
  const pinnedReady = await waitFor(() => core.runtimeOf(pinned.id).url !== null, READY_TIMEOUT_MS);
  check(
    '外部占用解除后，实例回到用户指定的端口',
    pinnedReady && core.runtimeOf(pinned.id).port === occupied,
    `指定 ${String(occupied)} → 重启后 ${String(core.runtimeOf(pinned.id).port)}`,
  );
} finally {
  for (const meta of started) await core.stopInstance(meta.id).catch(() => undefined);
  await Promise.all(
    holders.map((server) => new Promise((resolve) => server.close(() => resolve()))),
  );
  await cleanup(root);
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const failed = results.filter((item) => !item.ok);
process.stdout.write(
  `\n--- 端口验收：${String(results.length - failed.length)} passed, ${String(failed.length)} failed ---\n`,
);
if (failed.length > 0) {
  for (const item of failed) process.stdout.write(`  未通过：${item.name}\n`);
  process.exitCode = 1;
}
