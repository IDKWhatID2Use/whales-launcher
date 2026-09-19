/**
 * 自动端口分配测试
 *
 * 覆盖范围（对应需求 1–5 与边界情况）：
 *  - 参数改写：`--port` 的解析与**原地改写**（不追加第二个 `--port`）
 *  - 探测与预留：原子占用测试、进程内同步预留
 *  - 分配决策：自动分配 / 期望端口被占避让 / 区间耗尽回落 `--port 0`
 *  - 并发：8 个实例同时分配**不得选中同一端口**，且台账 8 条齐全
 *  - 收尾：退出后端口可重用、失败端口被回避、删除实例清台账
 *  - 接线：真实 spawn 一个"假 dsh"，验证 web 模板注入 `--port`、headless 模板一个都不加
 *
 * **前置条件**：候选区间 3080–3179 不应被外部程序大量占用。端口区间是**机器级共享资源**，
 * 被占满时分配会走文档化的 `--port 0` 兜底 —— 那是正确行为，不是缺陷。
 * 若同机有别的进程正在批量抢占该区间（例如并发的端口压测），本文件的少数断言可能偶发失败；
 * 这属于环境噪声而非代码问题，判据是：安静的机器上应稳定全绿。
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  cleanup,
  loadCoreModule,
  makeTempRoot,
  readJsonFile,
  seedStubEngine,
  test,
  waitFor,
  run,
} from './_helpers.mjs';

const { core, ports } = await loadCoreModule();

const CONFIG = {
  schemaVersion: 1,
  primaryHome: 'C:\\Users\\tester\\.dsh',
  theme: 'dark',
  lastInstanceId: null,
  confirmOnDelete: true,
  engineRegistry: 'https://registry.npmjs.org',
};

const { PORT_RANGE_START, PORT_RANGE_END, OS_ASSIGNED_PORT } = ports;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 建一个临时根目录。 */
async function tempRoot(t, label) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  return root;
}

/**
 * 真实占住一个端口（用监听 socket，而不是"假装占用"）。
 * @returns 监听句柄；端口已被别的程序占用时返回 null（此时它同样是"不可用"）。
 */
function holdPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server));
  });
}

/** 关闭一批监听句柄。 */
async function closeAll(servers) {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => (server === null ? resolve() : server.close(() => resolve())))),
  );
}

/** 找出区间内第一个真正空闲的端口（测试自己也需要一个"肯定可用"的端口）。 */
async function firstFreePort() {
  for (const port of ports.scanOrder(PORT_RANGE_START)) {
    if (await ports.isPortFree(port)) return port;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 参数改写
 * ------------------------------------------------------------------ */

test('parseExplicitPort：支持两种形态、出现多次时后者优先、非法形态返回 null', () => {
  assert.equal(ports.parseExplicitPort([]), null);
  assert.equal(ports.parseExplicitPort(['--no-open']), null);
  assert.equal(ports.parseExplicitPort(['--port', '3099']), 3099);
  assert.equal(ports.parseExplicitPort(['--port=3099']), 3099);
  assert.equal(ports.parseExplicitPort(['--port', '3081', '--port', '3099']), 3099);
  assert.equal(ports.parseExplicitPort(['--port', '0']), 0, '--port 0 应被识别为显式要求内核分配');
  // 非法形态一律不认，避免把用户的笔误当成"期望端口"
  assert.equal(ports.parseExplicitPort(['--port']), null);
  assert.equal(ports.parseExplicitPort(['--port', 'abc']), null);
  assert.equal(ports.parseExplicitPort(['--port', '99999']), null, '超出 65535 不是合法端口');
  assert.equal(ports.parseExplicitPort(['--port=']), null);
  // 数字形态的边界（前导零合法；带符号/科学计数/空格都不是 dsh 认的形态）
  assert.equal(ports.parseExplicitPort(['--port', '03080']), 3080, '前导零仍是合法数字');
  assert.equal(ports.parseExplicitPort(['--port', '65535']), 65535, '边界值合法');
  assert.equal(ports.parseExplicitPort(['--port', '65536']), null);
  assert.equal(ports.parseExplicitPort(['--port', '3080 ']), null, '带空格不是合法数字');
  assert.equal(ports.parseExplicitPort(['--port', ' 3080']), null);
  assert.equal(ports.parseExplicitPort(['--port', '+3080']), null);
  assert.equal(ports.parseExplicitPort(['--port', '1e3']), null);
  assert.equal(ports.parseExplicitPort(['--PORT', '3090']), null, 'flag 大小写敏感，只认小写 --port');
  assert.equal(ports.parseExplicitPort(['--port', '-1']), null);
  // `--` 之后是位置参数：不能被当成端口设置，更不能被改写
  assert.equal(ports.parseExplicitPort(['--no-open', '--', '--port', '3090']), null, '`--` 之后不参与 flag 解析');
  assert.equal(ports.hasMalformedPortFlag(['--port', '--']), true, '`--port --` 是悬空的 --port');
});

test('withPortArg：原地改写而不是追加第二个 --port', () => {
  assert.deepEqual(ports.withPortArg([], 3081), ['--port', '3081']);
  assert.deepEqual(ports.withPortArg(['--no-open'], 3081), ['--no-open', '--port', '3081']);
  // 关键：已经有 --port 时**改写它的值**，命令行里始终只有一个 --port
  assert.deepEqual(ports.withPortArg(['--no-open', '--port', '3080'], 3081), ['--no-open', '--port', '3081']);
  assert.deepEqual(ports.withPortArg(['--port=3080', '--no-open'], 3081), ['--port=3081', '--no-open']);
  assert.deepEqual(
    ports.withPortArg(['--port', '3080', '--port=3081'], 3090),
    ['--port', '3090', '--port=3090'],
  );
  // 形态非法 → 一律不碰（不掩盖用户错误，也不拼出 `--port --port 3080` 这种命令行）
  assert.deepEqual(ports.withPortArg(['--port'], 3081), ['--port']);
  assert.deepEqual(ports.withPortArg(['--port', 'abc'], 3081), ['--port', 'abc']);
  assert.equal(ports.hasMalformedPortFlag(['--port']), true);
  assert.equal(ports.hasMalformedPortFlag(['--port', 'abc']), true);
  assert.equal(ports.hasMalformedPortFlag(['--port', '3081']), false);
  // `--` 及其之后是位置参数：原样搬运，只改 `--` 之前的 flag
  assert.deepEqual(
    ports.withPortArg(['--port', '3080', '--', '--port', '3090'], 3199),
    ['--port', '3199', '--', '--port', '3090'],
    '`--` 之后是用户的数据，不得改写',
  );
  assert.deepEqual(
    ports.withPortArg(['--no-open', '--', '--port', '3090'], 3199),
    ['--no-open', '--port', '3199', '--', '--port', '3090'],
    '没有可改写的 --port 时，注入必须落在 -- 之前（-- 之后是位置参数，不得插入）',
  );
  // 末尾悬空的 `--`：原本 0 个位置参数、完全合法 —— 注入必须落在 `--` **之前**，
  // 追加到末尾会凭空多出两个位置参数，把合法命令行弄坏（独立审查指出，已复核确认）
  assert.deepEqual(
    ports.withPortArg(['--no-open', '--'], 3199),
    ['--no-open', '--port', '3199', '--'],
    '注入必须落在 -- 之前，否则会把合法的命令行变成多余位置参数',
  );
  assert.deepEqual(ports.withPortArg(['--no-open', '--', 'x'], 3199), ['--no-open', '--port', '3199', '--', 'x']);
});

test('scanOrder：从期望端口环形推进，覆盖整个区间且不重复', () => {
  const order = ports.scanOrder(3150);
  assert.equal(order.length, PORT_RANGE_END - PORT_RANGE_START + 1);
  assert.equal(order[0], 3150, '第一个应是期望端口本身');
  assert.equal(order[1], 3151);
  // 到区间末尾后绕回区间开头
  const last = order[order.length - 1];
  assert.equal(last, 3149);
  assert.equal(new Set(order).size, order.length, '不应出现重复端口');
  assert.ok(order.every((port) => port >= PORT_RANGE_START && port <= PORT_RANGE_END));
  // 期望端口在区间外 → 从区间起点开始
  assert.equal(ports.scanOrder(8080)[0], PORT_RANGE_START);
});

/* ------------------------------------------------------------------ *
 * 探测与预留
 * ------------------------------------------------------------------ */

test('isPortFree：空闲返回 true，被真实监听后返回 false，释放后恢复 true', async (t) => {
  const free = await firstFreePort();
  assert.notEqual(free, null, '区间内应至少有一个空闲端口');
  assert.equal(await ports.isPortFree(free), true);
  const server = await holdPort(free);
  assert.notEqual(server, null, '应能占住刚探测到的空闲端口');
  t.after(() => closeAll([server]));
  assert.equal(await ports.isPortFree(free), false, '被监听后必须判定为不可用');
  await closeAll([server]);
  assert.equal(await ports.isPortFree(free), true, '释放后应恢复可用');
});

test('isPortFree：非法端口一律判为不可用（不抛错）', async () => {
  for (const bad of [0, -1, 70000, 1.5, Number.NaN]) {
    assert.equal(await ports.isPortFree(bad), false);
  }
});

test('claimPort：同步占位，同一端口不会被发放两次', () => {
  const port = 31999;
  assert.equal(ports.claimPort(port), true);
  assert.equal(ports.claimPort(port), false, '第二次必须失败');
  ports.releaseClaim(port);
  assert.equal(ports.claimPort(port), true, '释放后应可再次占位');
  ports.releaseClaim(port);
});

/* ------------------------------------------------------------------ *
 * 分配决策
 * ------------------------------------------------------------------ */

test('allocatePort：首次自动分配落在候选区间内，并把期望端口写进台账', async (t) => {
  const root = await tempRoot(t, 'ports-auto');
  const decision = await ports.allocatePort(root, { id: 'i-1', name: '自动分配' }, null);
  t.after(() => ports.releasePort(root, 'i-1'));

  assert.equal(decision.source, 'auto');
  assert.equal(decision.avoided, false);
  assert.ok(decision.port >= PORT_RANGE_START && decision.port <= PORT_RANGE_END, `端口应在区间内，实际 ${decision.port}`);
  // 探测 socket 已经关闭（要把它让给 dsh），因此"已被占用"体现在**进程内预留集**里
  assert.equal(await ports.isPortFree(decision.port), true, '交给 dsh 前探测 socket 必须已释放');
  assert.ok(
    ports.reservedPorts().includes(decision.port),
    '分配出去的端口必须留在预留集里，否则并发分配会重复发放',
  );

  const ledger = await ports.readPortLedger(root);
  assert.equal(ledger.allocations['i-1'].preferred, decision.port);
  assert.equal(ledger.allocations['i-1'].last, decision.port);
  assert.equal(ledger.allocations['i-1'].name, '自动分配');
});

test('allocatePort：期望端口被外部占用 → 自动避让到下一个可用端口', async (t) => {
  const root = await tempRoot(t, 'ports-avoid');
  const first = await firstFreePort();
  assert.notEqual(first, null);

  // 先把 first 占掉，再把 first 登记为该实例的期望端口
  const server = await holdPort(first);
  t.after(() => closeAll([server]));
  assert.notEqual(server, null);

  await ports.writePortLedger(root, {
    schemaVersion: 1,
    allocations: {
      'i-2': { name: '避让', preferred: first, last: first, pid: null, updatedAt: new Date().toISOString() },
    },
    failures: {},
  });

  const decision = await ports.allocatePort(root, { id: 'i-2', name: '避让' }, null);
  t.after(() => ports.releasePort(root, 'i-2'));
  assert.equal(decision.source, 'ledger');
  assert.equal(decision.desired, first);
  assert.equal(decision.avoided, true, '期望端口被占必须标记为避让');
  assert.notEqual(decision.port, first);
  assert.match(decision.reason, /已被占用/);
  assert.match(decision.reason, /避让/);

  const ledger = await ports.readPortLedger(root);
  assert.equal(ledger.allocations['i-2'].preferred, first, '期望端口不应因为一次避让就漂移');
  assert.equal(ledger.allocations['i-2'].last, decision.port);
});

test('allocatePort：用户显式 --port 可用时直接采用，且命令行参数被原地改写', async (t) => {
  const root = await tempRoot(t, 'ports-explicit');
  const free = await firstFreePort();
  const decision = await ports.allocatePort(root, { id: 'i-3', name: '显式' }, free);
  t.after(() => ports.releasePort(root, 'i-3'));
  assert.equal(decision.port, free);
  assert.equal(decision.source, 'explicit');
  assert.equal(decision.avoided, false);
  assert.deepEqual(ports.withPortArg(['--port', '3080', '--no-open'], decision.port), [
    '--port',
    String(free),
    '--no-open',
  ]);
});

test('allocatePort：用户显式写 --port 0 → 尊重，不做避让，但台账仍留记录', async (t) => {
  const root = await tempRoot(t, 'ports-zero');
  const decision = await ports.allocatePort(root, { id: 'i-4', name: '内核分配' }, 0);
  assert.equal(decision.port, OS_ASSIGNED_PORT);
  assert.equal(decision.source, 'explicit');
  assert.equal(decision.avoided, false);
  assert.match(decision.reason, /操作系统分配/);
  const ledger = await ports.readPortLedger(root);
  assert.ok(ledger.allocations['i-4'] !== undefined, '「台账为每个实例留一条记录」不该有例外');
  assert.equal(ledger.allocations['i-4'].last, OS_ASSIGNED_PORT);
  assert.equal(ledger.allocations['i-4'].preferred, PORT_RANGE_START);
  await ports.releasePort(root, 'i-4');
});

test('allocatePort：并发 8 次不得选中同一端口，且台账 8 条齐全', async (t) => {
  const root = await tempRoot(t, 'ports-concurrent');
  const ids = Array.from({ length: 8 }, (_, index) => `c-${String(index)}`);
  // 真并发：8 个分配请求同时发出
  const decisions = await Promise.all(
    ids.map((id) => ports.allocatePort(root, { id, name: `并发 ${id}` }, null)),
  );
  t.after(() => Promise.all(ids.map((id) => ports.releasePort(root, id))));

  const chosen = decisions.map((item) => item.port);
  assert.equal(new Set(chosen).size, 8, `8 个实例必须拿到 8 个不同端口，实际 ${JSON.stringify(chosen)}`);
  for (const port of chosen) {
    assert.ok(port >= PORT_RANGE_START && port <= PORT_RANGE_END, `端口 ${port} 应在候选区间内`);
  }

  // 台账不能因为并发读改写而丢记录（这正是加串行锁的原因）
  const ledger = await ports.readPortLedger(root);
  assert.equal(Object.keys(ledger.allocations).length, 8, '8 条分配记录必须一条不少');
  for (const id of ids) {
    assert.ok(ledger.allocations[id] !== undefined, `台账缺少 ${id}`);
    assert.ok(chosen.includes(ledger.allocations[id].last), `台账里 ${id} 的端口应是本次分配到的端口`);
  }
});

test('allocatePort：候选区间全部不可用 → 回落 --port 0，保证实例仍能启动', async (t) => {
  const root = await tempRoot(t, 'ports-exhausted');
  const servers = [];
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    servers.push(await holdPort(port)); // 占不到的说明本来就被别的程序占着，同样是"不可用"
  }
  t.after(() => closeAll(servers));
  const held = servers.filter((item) => item !== null).length;
  assert.ok(held >= 1, '至少应占住一个端口，否则本用例没有意义');

  const decision = await ports.allocatePort(root, { id: 'e-1', name: '区间耗尽' }, null);
  t.after(() => ports.releasePort(root, 'e-1'));
  assert.equal(decision.port, OS_ASSIGNED_PORT, `区间占满时必须回落内核分配，实际 ${decision.port}`);
  assert.equal(decision.source, 'os');
  assert.match(decision.reason, /操作系统分配/);
});

/* ------------------------------------------------------------------ *
 * 收尾与边界
 * ------------------------------------------------------------------ */

test('releasePort：实例退出后端口被回收，下次启动仍优先复用同一端口', async (t) => {
  const root = await tempRoot(t, 'ports-reuse');
  const first = await ports.allocatePort(root, { id: 'r-1', name: '复用' }, null);
  await ports.releasePort(root, 'r-1');
  assert.equal(ports.reservedPorts().includes(first.port), false, '释放后不应继续留在预留集里');

  const again = await ports.allocatePort(root, { id: 'r-1', name: '复用' }, null);
  t.after(() => ports.releasePort(root, 'r-1'));
  assert.equal(again.port, first.port, '期望端口应被复用（这是台账 persisted preferred 的作用）');
  assert.equal(again.source, 'ledger');
});

test('notePortFailure：被 dsh 拒绝过的端口在短时间内不再被优先选用', async (t) => {
  const root = await tempRoot(t, 'ports-failure');
  const first = await firstFreePort();
  assert.notEqual(first, null);
  await ports.notePortFailure(root, first);

  const decision = await ports.allocatePort(root, { id: 'f-1', name: '失败回避' }, null);
  t.after(() => ports.releasePort(root, 'f-1'));
  assert.notEqual(decision.port, first, `刚失败过的端口 ${first} 不应被优先选中，实际 ${decision.port}`);

  const ledger = await ports.readPortLedger(root);
  assert.ok(ledger.failures[String(first)] !== undefined, '失败记录应落进台账');
});

test('forgetPort：删除实例后台账记录随之消失', async (t) => {
  const root = await tempRoot(t, 'ports-forget');
  await ports.allocatePort(root, { id: 'g-1', name: '待删除' }, null);
  await ports.allocatePort(root, { id: 'g-2', name: '保留' }, null);
  t.after(() => ports.releasePort(root, 'g-2'));

  await ports.forgetPort(root, 'g-1');
  const ledger = await ports.readPortLedger(root);
  assert.equal(ledger.allocations['g-1'], undefined, 'g-1 的记录应被删除');
  assert.ok(ledger.allocations['g-2'] !== undefined, 'g-2 的记录不应受影响');
});

test('notePortActual：把 dsh 输出里的真实端口回填进台账（否则 last 永远停在 0）', async (t) => {
  const root = await tempRoot(t, 'ports-actual');
  await ports.allocatePort(root, { id: 'a-1', name: '内核分配' }, OS_ASSIGNED_PORT);
  await ports.notePortBound(root, 'a-1', 4242);
  const before = await ports.readPortLedger(root);
  assert.equal(before.allocations['a-1'].last, OS_ASSIGNED_PORT, '分配阶段只能记 0（此刻还不知道端口号）');
  assert.equal(before.allocations['a-1'].pid, 4242);

  await ports.notePortActual(root, 'a-1', 53902);
  const after = await ports.readPortLedger(root);
  assert.equal(after.allocations['a-1'].last, 53902, '真实端口必须回填，否则需求 4 在兜底路径上不成立');
  assert.equal(after.allocations['a-1'].pid, 4242, '回填不应破坏已有字段');

  // 幂等：同一端口重复回填不产生额外写入
  await ports.notePortActual(root, 'a-1', 53902);
  assert.equal((await ports.readPortLedger(root)).allocations['a-1'].last, 53902);

  // 非法端口不得写进台账
  await ports.notePortActual(root, 'a-1', 0);
  await ports.notePortActual(root, 'a-1', -5);
  await ports.notePortActual(root, 'a-1', 70000);
  assert.equal((await ports.readPortLedger(root)).allocations['a-1'].last, 53902);
  await ports.releasePort(root, 'a-1');
});

test('readPortLedger：文件损坏或缺失时返回空台账，绝不抛错', async (t) => {
  const root = await tempRoot(t, 'ports-corrupt');
  const empty = await ports.readPortLedger(root);
  assert.deepEqual(empty.allocations, {}, '文件不存在时应返回空台账');

  await fs.mkdir(path.dirname(ports.portLedgerFile(root)), { recursive: true });
  await fs.writeFile(ports.portLedgerFile(root), '{ 这不是 JSON', 'utf8');
  const broken = await ports.readPortLedger(root);
  assert.deepEqual(broken.allocations, {}, '损坏文件应被当作空台账');
  assert.deepEqual(broken.failures, {});

  // 坏台账不能阻止分配
  const decision = await ports.allocatePort(root, { id: 'x-1', name: '坏台账' }, null);
  t.after(() => ports.releasePort(root, 'x-1'));
  assert.ok(decision.port >= PORT_RANGE_START && decision.port <= PORT_RANGE_END);
});

test('readPortLedger：单条坏记录不影响其余记录（坏记录丢弃而非整体作废）', async (t) => {
  const root = await tempRoot(t, 'ports-partial');
  await fs.mkdir(path.dirname(ports.portLedgerFile(root)), { recursive: true });
  await fs.writeFile(
    ports.portLedgerFile(root),
    JSON.stringify({
      schemaVersion: 1,
      allocations: {
        good: { name: '好的', preferred: 3100, last: 3101, pid: null, updatedAt: '2026-01-01T00:00:00.000Z' },
        bad: { name: '坏的', preferred: 'not-a-number' },
        worse: null,
      },
      failures: {},
    }),
    'utf8',
  );
  const ledger = await ports.readPortLedger(root);
  assert.equal(ledger.allocations.good.preferred, 3100);
  assert.equal(ledger.allocations.good.last, 3101);
  assert.equal(ledger.allocations.bad, undefined, '字段类型不对的记录应被丢弃');
  assert.equal(ledger.allocations.worse, undefined);
});

/* ------------------------------------------------------------------ *
 * 接线：真实 spawn
 * ------------------------------------------------------------------ */

/** 启动一个实例并等待假 dsh 写出启动信息。 */
async function launchAndReadArgs(root, meta, appArgs) {
  const logs = [];
  await core.launchInstance(root, meta, { instanceId: meta.id, appArgs }, CONFIG, {
    onLog: (stream, text) => logs.push(`${stream}:${text}`),
  });
  const stubFile = path.join(core.instancePaths(root, meta).workspace, '.stub-start.json');
  const written = await waitFor(async () => {
    try {
      await fs.access(stubFile);
      return true;
    } catch {
      return false;
    }
  }, 8000);
  assert.equal(written, true, '假 dsh 应已写出 .stub-start.json');
  return { info: await readJsonFile(stubFile), logs };
}

test('launchInstance：web 模板自动注入 --port，并从输出回填真实端口', async (t) => {
  const root = await tempRoot(t, 'launch-web');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'Web 实例', engineVersion: '9.9.9', template: 'web' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  const { info, logs } = await launchAndReadArgs(root, meta, []);

  const occurrences = info.args.filter((item) => item === '--port').length;
  assert.equal(occurrences, 1, `命令行里必须恰好一个 --port，实际 args=${JSON.stringify(info.args)}`);
  const index = info.args.indexOf('--port');
  const port = Number(info.args[index + 1]);
  assert.ok(
    Number.isInteger(port) && port >= PORT_RANGE_START && port <= PORT_RANGE_END,
    `注入的端口应在候选区间内，实际 ${String(info.args[index + 1])}`,
  );
  assert.ok(
    logs.some((line) => line.includes('端口：')),
    '日志里应记录端口决策说明',
  );

  // 假 dsh 固定打印 3999，因此 runtime.port 必须被回填成**真实**端口而不是我们请求的那个
  assert.ok(
    await waitFor(() => core.runtimeOf(meta.id).port === 3999, 6000),
    `runtime.port 应回填为输出里的真实端口 3999，实际 ${String(core.runtimeOf(meta.id).port)}`,
  );
  assert.match(core.runtimeOf(meta.id).url ?? '', /:3999/);
});

test('launchInstance：headless 模板一个 --port 都不加（否则 commander 会当成未知选项）', async (t) => {
  const root = await tempRoot(t, 'launch-headless');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '无界面实例', engineVersion: '9.9.9', template: 'headless' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  const { info, logs } = await launchAndReadArgs(root, meta, []);
  assert.equal(info.args.includes('--port'), false, `headless 不应注入 --port，实际 args=${JSON.stringify(info.args)}`);
  assert.equal(
    logs.some((line) => line.includes('端口：')),
    false,
    '非 Web 模板不应产生端口决策日志',
  );
});

test('launchInstance：用户手写 --port 被占用 → 改写其值并明确提示「已改用」', async (t) => {
  const root = await tempRoot(t, 'launch-avoid');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '固定端口实例', engineVersion: '9.9.9', template: 'web' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  const occupied = await firstFreePort();
  assert.notEqual(occupied, null);
  const server = await holdPort(occupied);
  t.after(() => closeAll([server]));
  assert.notEqual(server, null);

  const { info, logs } = await launchAndReadArgs(root, meta, ['--port', String(occupied)]);

  const occurrences = info.args.filter((item) => item === '--port').length;
  assert.equal(occurrences, 1, `仍应只有一个 --port，实际 ${JSON.stringify(info.args)}`);
  const index = info.args.indexOf('--port');
  const actual = Number(info.args[index + 1]);
  assert.notEqual(actual, occupied, '指定端口被占时必须改用别的端口，而不是硬顶着冲突启动');
  assert.ok(actual >= PORT_RANGE_START && actual <= PORT_RANGE_END);
  assert.ok(
    logs.some((line) => line.includes('已被占用') && line.includes('避让')),
    `日志应明确说明避让，实际端口相关日志：${JSON.stringify(logs.filter((line) => line.includes('端口')))}`,
  );
});

test('launchInstance：用户 --port 的形态非法时不做任何注入（不掩盖用户的输入错误）', async (t) => {
  const root = await tempRoot(t, 'launch-malformed');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '非法参数实例', engineVersion: '9.9.9', template: 'web' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  const { info } = await launchAndReadArgs(root, meta, ['--port']);
  assert.deepEqual(info.args, ['--profile', meta.profile.name, '--port'], '非法参数应原样透传，既不改写也不追加');
});

test('launchInstance：启动途中抛错时预留端口必须被归还（不留泄漏）', async (t) => {
  const root = await tempRoot(t, 'ports-leak');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '抛错实例', engineVersion: '9.9.9', template: 'web' });
  const before = ports.reservedPorts();

  // hook 抛错是最真实的泄漏来源（例如窗口已销毁导致的推送失败）
  await assert.rejects(
    core.launchInstance(root, meta, { instanceId: meta.id }, CONFIG, {
      onLog: () => {
        throw new Error('hook 故意抛错');
      },
    }),
    /hook 故意抛错/,
  );

  const after = ports.reservedPorts();
  assert.deepEqual(
    after,
    before,
    `失败后预留集必须回到原状，否则后续实例会白避开一个没人在用的端口。实际 ${JSON.stringify(after)}`,
  );
  const ledger = await ports.readPortLedger(root);
  assert.equal(ledger.allocations[meta.id]?.pid ?? null, null, '台账不应留下"看起来在运行"的记录');
});

test('launchInstance：profile 清单损坏时不得挡住启动（回退到模板名，让 dsh 去报错）', async (t) => {
  const root = await tempRoot(t, 'launch-badmanifest');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '坏清单实例', engineVersion: '9.9.9', template: 'web' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  // 把 profile 清单写成非法 JSON（readJson 对「损坏」是抛错，不是返回 null）
  const manifest = path.join(core.instancePaths(root, meta).profileDir, 'package.json');
  await fs.writeFile(manifest, '{ 这不是合法 JSON', 'utf8');

  const { info } = await launchAndReadArgs(root, meta, []);
  assert.equal(
    info.args.includes('--port'),
    true,
    `清单损坏时应回退到创建时的模板名（web）并照常注入 --port，实际 ${JSON.stringify(info.args)}`,
  );
});

test('launchInstance：--port 0 交内核分配时，台账被回填为输出里的真实端口', async (t) => {
  const root = await tempRoot(t, 'launch-osassigned');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: '内核分配实例', engineVersion: '9.9.9', template: 'web' });
  t.after(async () => {
    await core.stopInstance(meta.id).catch(() => undefined);
  });

  const { info } = await launchAndReadArgs(root, meta, ['--port', '0']);
  const index = info.args.indexOf('--port');
  assert.equal(info.args[index + 1], '0', `应原样透传 --port 0（交内核分配），实际 ${JSON.stringify(info.args)}`);

  // 假 dsh 固定打印 3999：运行时与台账都必须落到这个**真实**端口上
  assert.equal(await waitFor(() => core.runtimeOf(meta.id).port === 3999, 6000), true);
  const filled = await waitFor(
    async () => (await ports.readPortLedger(root)).allocations[meta.id]?.last === 3999,
    6000,
  );
  assert.equal(
    filled,
    true,
    `台账 last 应被回填为输出里的真实端口 3999，实际 ${JSON.stringify((await ports.readPortLedger(root)).allocations[meta.id])}`,
  );
});

await run();
