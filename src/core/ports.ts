/**
 * WhalesLauncher core —— 自动端口分配
 *
 * 目标：多个实例同时运行时**自动避让端口**，既不抢占他人端口，也不因端口冲突而启动失败。
 *
 * ## 端口从哪来（源码依据，非推测）
 * dsh 的 Web 端口链路：
 * ```
 * dsh-web-app/lib/startup.js      --port <port>  "listen port; pass 0 to let the OS pick a free one"
 * dsh-web-app/cordis.patch.yml    webserver.port: ctx.webStartup.port ?? 3080
 * dsh-host-webserver/lib/index.js webServer.port → 绑定完成后的**真实**端口（--port 0 时由内核给出）
 * ```
 * 即：**不传 `--port` 时每个实例都落在 3080** —— 这正是本机制要消除的冲突源。
 *
 * ## 三层防护（各管一段，职责不重叠）
 * 1. **进程内预留集**：{@link claimPort} 在**同步**阶段占位（函数体内没有 `await`），
 *    因此同一个启动器进程里并发启动 N 个实例时，不可能有两个拿到同一端口。
 * 2. **操作系统绑定探测**：{@link isPortFree} 用 `listen({ exclusive: true })` 做原子占用测试，
 *    如实判定「此刻这个端口是否已被绑着」—— 包括别的启动器进程与任何外部程序。
 * 3. **跨进程台账**：`<root>/cache/ports.json` 让期望端口在启动器重启后依然稳定，
 *    并留下「每个实例实际用了哪个端口」的审计记录。
 *
 * ## 边界必须说清楚（刻意不夸大）
 * - 第 1 层只在**本进程内**成立；
 * - 第 2 层只回答「此刻是否被占用」，**不构成跨进程的分配互斥** —— 两个启动器进程同时探测
 *   同一个**空闲**端口会双双成功，随后谁先 `bind` 谁赢，后到者以 EADDRINUSE 退出，
 *   再由 {@link notePortFailure} 记录并自愈；
 * - 台账同样**不是**互斥手段（读改写做不到原子）：进程内串行锁只在单进程内有效，
 *   两个启动器进程并发写会互相覆盖，审计记录可能不全。
 *
 * 一句话：「多个实例同时启动不撞端口」在**单启动器进程**下是强保证；跨进程由内核在
 * `bind` 那一刻兜底（见 {@link notePortFailure} 与 `launch.ts` 的收尾逻辑）。
 *
 * ## 已知的残余窗口（诚实说明）
 * 探测成功后我们会**关闭**探测 socket 再把端口交给 dsh，而 dsh 要到启动末期才真正绑定，
 * 两者之间有一个数百毫秒的窗口。该窗口内若被外部程序抢走，dsh 会以 `EADDRINUSE` 退出。
 * 应对是**自愈而非重试**：`launch.ts` 会把这次失败的端口写进台账的 `failures`，
 * 短时间内任何实例都不会再优先选用它 —— 下一次启动即自动避开，不会连续撞同一个坑。
 */
import net from 'node:net';
import path from 'node:path';
import type { PortDecision, PortLedger, PortRecord, PortSource } from '../shared/contracts';
import { ensureDir, readJson, writeJsonAtomic } from './fsx';
import { corePaths } from './paths';

/** 自动避让的候选端口区间起点（含）。 */
export const PORT_RANGE_START = 3080;

/** 自动避让的候选端口区间终点（含）。 */
export const PORT_RANGE_END = 3179;

/** 交操作系统分配的哨兵端口值（即 dsh 的 `--port 0` 语义）。 */
export const OS_ASSIGNED_PORT = 0;

/** 端口台账文件名（位于 `<root>/cache/`）。 */
export const PORT_LEDGER_FILE = 'ports.json';

/** 台账 schema 版本。 */
export const PORT_LEDGER_SCHEMA = 1;

/** 失败端口的回避时长（毫秒）：超过此时长的失败记录不再影响选端口。 */
export const PORT_FAILURE_TTL_MS = 5 * 60 * 1000;

/** 探测与绑定使用的主机（dsh Web 默认只监听回环地址）。 */
const LOOPBACK_HOST = '127.0.0.1';

/** 合法端口的判定（0 表示交内核分配，因此单独放行）。 */
const PORT_PATTERN = /^\d+$/;

/** 合法的 `--port` 参数形态：`--port N` 与 `--port=N`（与 dsh 自身的校验一致）。 */
const PORT_FLAG = '--port';
const PORT_FLAG_EQ = '--port=';

/* ------------------------------------------------------------------ *
 * 进程内预留集
 * ------------------------------------------------------------------ */

/** 已被本进程预留（但尚未确认绑定成功）的端口。 */
const reserved = new Set<number>();

/** instanceId → 已分配给它的端口（用于退出时释放）。 */
const ownedBy = new Map<string, number>();

/**
 * **同步**预留一个端口。
 *
 * 关键点：函数体内没有 `await`，而 JS 是单线程的，因此「检查 + 占位」是一个不可分割的
 * 原子步骤。这是需求「多个实例并发探测时不得选中同一端口」在**进程内**的强保证。
 * @param port 候选端口。
 * @returns 是否成功占位（已被本进程预留时返回 false）。
 */
export function claimPort(port: number): boolean {
  if (reserved.has(port)) return false;
  reserved.add(port);
  return true;
}

/**
 * 释放预留。
 * @param port 端口。
 */
export function releaseClaim(port: number): void {
  reserved.delete(port);
}

/** 当前本进程预留中的端口快照（供测试与诊断）。 */
export function reservedPorts(): number[] {
  return [...reserved].sort((left, right) => left - right);
}

/* ------------------------------------------------------------------ *
 * 参数改写
 * ------------------------------------------------------------------ */

/**
 * 把字符串解析为合法端口。
 * @param value 待解析文本。
 * @returns 合法端口（含 0）；非法返回 `null`。
 */
function toPort(value: string): number | null {
  if (!PORT_PATTERN.test(value)) return null;
  const port = Number(value);
  // dsh 的 schema 是 `z.natural().max(65535)`，超出范围会在启动期报错，因此不视为合法
  return port <= 65535 ? port : null;
}

/**
 * 判断启动参数里是否存在**形态非法**的 `--port`（悬空、或值不是数字）。
 *
 * 这类输入是用户自己的笔误，本机制**一律不碰**：既不改写、也不追加，
 * 交给 dsh 报出它原本的使用错误。这样做有两个好处：
 *  - 不掩盖错误（否则用户永远不知道自己的参数写错了）；
 *  - 不会拼出 `--port --port 3080` 这种更令人困惑的命令行。
 * @param appArgs 启动参数。
 * @returns 存在非法 `--port` 返回 true。
 */
export function hasMalformedPortFlag(appArgs: readonly string[]): boolean {
  let expectsValue = false;
  for (const token of appArgs) {
    // `--` 之后一律是位置参数：不再参与 flag 解析，也不去碰它们
    if (token === '--') return expectsValue;
    if (expectsValue) {
      expectsValue = false;
      if (toPort(token) === null) return true;
      continue;
    }
    if (token === PORT_FLAG) {
      expectsValue = true;
      continue;
    }
    if (token.startsWith(PORT_FLAG_EQ) && toPort(token.slice(PORT_FLAG_EQ.length)) === null) return true;
  }
  // 循环结束时仍在等值 → 末尾是一个悬空的 `--port`
  return expectsValue;
}

/**
 * 解析实例启动参数里用户**显式**写的 `--port`。
 *
 * 支持 `--port 3081` 与 `--port=3081` 两种形态；出现多次时以**最后一个**为准
 * （与 commander 的语义一致）。`--port 0` 会被识别为「显式要求内核分配」。
 * @param appArgs 启动参数。
 * @returns 显式端口；未指定或形态非法返回 `null`。
 */
export function parseExplicitPort(appArgs: readonly string[]): number | null {
  let found: number | null = null;
  let expectsValue = false;
  for (const token of appArgs) {
    // `--` 之后是位置参数：不参与 flag 解析（否则会把用户的普通参数当成端口设置）
    if (token === '--') break;
    if (expectsValue) {
      expectsValue = false;
      const parsed = toPort(token);
      if (parsed !== null) found = parsed;
      continue;
    }
    if (token === PORT_FLAG) {
      expectsValue = true;
      continue;
    }
    if (token.startsWith(PORT_FLAG_EQ)) {
      const parsed = toPort(token.slice(PORT_FLAG_EQ.length));
      if (parsed !== null) found = parsed;
    }
  }
  return found;
}

/**
 * 把 `--port` 改写为指定端口（**原地改写，不追加第二个 `--port`**）。
 *
 * 之所以必须改写而不是追加：追加会让命令行里出现两个 `--port`，语义依赖
 * "后者覆盖前者"的解析细节，属于把正确性押在别人的实现上。
 *
 * 形态**非法**的 `--port`（悬空、或值不是数字）→ 整个参数数组原样返回，
 * 既不改写也不注入（理由见 {@link hasMalformedPortFlag}）。
 * @param appArgs 启动参数。
 * @param port 目标端口。
 * @returns 新的参数数组（不修改入参）。
 */
export function withPortArg(appArgs: readonly string[], port: number): string[] {
  if (hasMalformedPortFlag(appArgs)) return [...appArgs];
  const next: string[] = [];
  let replaced = false;
  let expectsValue = false;
  for (let index = 0; index < appArgs.length; index += 1) {
    const token = appArgs[index];
    // 索引访问在 `noUncheckedIndexedAccess` 下是 `string | undefined`，显式收口
    if (token === undefined) break;
    // `--` 及其之后是位置参数：原样搬运，绝不改写（那是在改用户的数据，不是配置）
    if (token === '--') {
      next.push(...appArgs.slice(index));
      break;
    }
    if (expectsValue) {
      expectsValue = false;
      if (toPort(token) !== null) {
        next.push(String(port));
        replaced = true;
      } else {
        next.push(token);
      }
      continue;
    }
    if (token === PORT_FLAG) {
      expectsValue = true;
      next.push(token);
      continue;
    }
    if (token.startsWith(PORT_FLAG_EQ) && toPort(token.slice(PORT_FLAG_EQ.length)) !== null) {
      next.push(`${PORT_FLAG_EQ}${String(port)}`);
      replaced = true;
      continue;
    }
    next.push(token);
  }
  if (!replaced) {
    /*
     * 注入位置必须在 `--` **之前**：`--` 之后的一切都会被解析成位置参数，
     * 追加到末尾会把 `--port <n>` 变成两个多余的位置参数，反而把一个**本来合法**的
     * 命令行弄坏（`['--no-open','--']` 原本 0 个位置参数、完全合法）。
     * （由独立审查指出后果、我复核后确认这是注入本身造成的破坏，故修。）
     */
    const separator = next.indexOf('--');
    if (separator === -1) next.push(PORT_FLAG, String(port));
    else next.splice(separator, 0, PORT_FLAG, String(port));
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 探测端口当前是否可绑定（原子占用测试）。
 *
 * 用 `listen({ exclusive: true })` 而不是"连一下试试"：监听冲突由内核判定，
 * 不受防火墙规则、连接超时、进程权限影响，也不会误伤只监听其它地址的程序。
 * @param port 待探测端口。
 * @returns 可绑定返回 true。
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => {
      // 先关闭再判定成功，把"占用窗口"压到最短
      server.close(() => finish(true));
    });
    try {
      server.listen({ port, host: LOOPBACK_HOST, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

/**
 * 生成候选端口顺序：**从 `start` 开始环形扫描整个区间**。
 *
 * 环形而不是"从区间头开始"，是为了让避让结果贴近期望端口（3080 被占 → 3081，
 * 而不是跳到 3080–3179 里某个被释放出来的小号端口）。
 * @param start 起始端口；不在区间内时从区间起点开始。
 * @returns 端口数组（长度等于区间大小）。
 */
export function scanOrder(start: number): number[] {
  const size = PORT_RANGE_END - PORT_RANGE_START + 1;
  const inRange = start >= PORT_RANGE_START && start <= PORT_RANGE_END;
  const from = inRange ? start : PORT_RANGE_START;
  const order: number[] = [];
  for (let offset = 0; offset < size; offset += 1) {
    order.push(PORT_RANGE_START + ((from - PORT_RANGE_START + offset) % size));
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * 台账
 * ------------------------------------------------------------------ */

/**
 * 台账的**进程内串行锁**。
 *
 * 台账是"读 → 改 → 写"的整文件替换，并发执行会互相覆盖：8 个实例同时启动时，
 * 每个都读到同一份旧内容、各自写入自己那条，最后只剩一条 —— 需求「记录每个实例
 * 实际使用的端口」就会静默地只满足 1/8。因此所有台账读写都必须走这条串行链。
 *
 * 注意序列化的粒度是整个分配过程（含端口探测），这样连"决定用哪个端口"也不会交错。
 * 单个探测约几毫秒，8 个实例串行分配的代价可以忽略。
 */
let ledgerTail: Promise<unknown> = Promise.resolve();

function withLedgerLock<T>(work: () => Promise<T>): Promise<T> {
  const result = ledgerTail.then(work, work);
  ledgerTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 台账文件绝对路径。
 * @param root 启动器根目录。
 * @returns `<root>/cache/ports.json`。
 */
export function portLedgerFile(root: string): string {
  return path.join(corePaths(root).cacheDir, PORT_LEDGER_FILE);
}

/** 把台账里的一条原始记录收敛成合法记录（坏记录丢弃，绝不让它影响启动）。 */
function normalizeRecord(key: string, raw: unknown): PortRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const preferred = typeof value['preferred'] === 'number' ? value['preferred'] : null;
  const last = typeof value['last'] === 'number' ? value['last'] : null;
  if (preferred === null && last === null) return null;
  return {
    name: typeof value['name'] === 'string' ? value['name'] : key,
    preferred: preferred ?? (last as number),
    last: last ?? (preferred as number),
    pid: typeof value['pid'] === 'number' ? value['pid'] : null,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : new Date(0).toISOString(),
  };
}

/**
 * 读取端口台账（文件缺失或损坏时返回空台账，绝不抛错）。
 * @param root 启动器根目录。
 * @returns 台账。
 */
export async function readPortLedger(root: string): Promise<PortLedger> {
  const empty: PortLedger = { schemaVersion: PORT_LEDGER_SCHEMA, allocations: {}, failures: {} };
  let raw: Partial<PortLedger> | null;
  try {
    raw = await readJson<Partial<PortLedger>>(portLedgerFile(root));
  } catch {
    /*
     * `readJson` 在文件**损坏**时是抛错而不是返回 null（文件缺失才返回 null）。
     * 台账是纯辅助数据，被手工改坏、或断电写了一半，都绝不能让实例启动失败 ——
     * 这里显式降级为空台账，随后的一次成功写入会自动重建它。
     */
    return empty;
  }
  if (raw === null || typeof raw !== 'object') return empty;
  const allocations: Record<string, PortRecord> = {};
  const source = raw.allocations;
  if (source !== null && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      const record = normalizeRecord(key, value);
      if (record !== null) allocations[key] = record;
    }
  }
  const failures: Record<string, string> = {};
  const rawFailures = raw.failures;
  if (rawFailures !== null && typeof rawFailures === 'object') {
    for (const [key, value] of Object.entries(rawFailures)) {
      if (typeof value === 'string' && toPort(key) !== null) failures[key] = value;
    }
  }
  return { schemaVersion: PORT_LEDGER_SCHEMA, allocations, failures };
}

/**
 * 写入端口台账（原子替换，失败不抛错）。
 * @param root 启动器根目录。
 * @param ledger 台账。
 */
export async function writePortLedger(root: string, ledger: PortLedger): Promise<void> {
  try {
    await ensureDir(corePaths(root).cacheDir);
    await writeJsonAtomic(portLedgerFile(root), ledger);
  } catch {
    // 台账只是"记住偏好 + 留痕"，写不进去也不能影响实例启动
  }
}

/** 过滤掉已过期的失败记录。 */
function liveFailures(failures: Record<string, string>, now: number): Record<string, string> {
  const live: Record<string, string> = {};
  for (const [key, value] of Object.entries(failures)) {
    const at = Date.parse(value);
    if (Number.isFinite(at) && now - at < PORT_FAILURE_TTL_MS) live[key] = value;
  }
  return live;
}

/* ------------------------------------------------------------------ *
 * 决策
 * ------------------------------------------------------------------ */

/** 生成面向用户的中文说明。 */
function describeDecision(
  source: PortSource,
  desired: number | null,
  port: number,
  avoided: boolean,
): string {
  if (port === OS_ASSIGNED_PORT) {
    const why = desired === null ? '候选区间已被占满' : `期望端口 ${String(desired)} 不可用且候选区间已占满`;
    return `${why} → 交操作系统分配空闲端口（--port 0），实际端口以启动输出为准`;
  }
  if (!avoided) {
    if (source === 'explicit') return `使用启动参数指定的端口 ${String(port)}（当前可用）`;
    if (source === 'ledger') return `使用该实例的期望端口 ${String(port)}（当前可用）`;
    return `自动分配端口 ${String(port)}`;
  }
  const from = source === 'explicit' ? `启动参数指定的端口 ${String(desired)}` : `期望端口 ${String(desired)}`;
  return `${from} 已被占用 → 自动避让到 ${String(port)}`;
}

/**
 * 为实例分配一个监听端口。
 *
 * 决策顺序（与设计文档一致）：
 *  1. 用户显式 `--port N`（N ≠ 0）→ N 优先；
 *  2. 台账里该实例的 `preferred`；
 *  3. 区间内自动分配（**优先避开其它实例已认领的期望端口**）。
 *
 * 期望端口被占用时向后避让；整个区间都不可用时回落 `--port 0`（内核分配），
 * 保证"端口耗尽"不会变成"启动失败"。用户显式写 `--port 0` 时直接尊重，不做避让。
 * @param root 启动器根目录。
 * @param instance 实例标识（`id` 用于台账键，`name` 仅写入台账便于人工阅读）。
 * @param explicitPort 用户在启动参数里显式指定的端口（`null` 表示未指定）。
 * @returns 分配决策。
 */
export function allocatePort(
  root: string,
  instance: { id: string; name: string },
  explicitPort: number | null,
): Promise<PortDecision> {
  return withLedgerLock(() => allocatePortLocked(root, instance, explicitPort));
}

/** {@link allocatePort} 的实现体（调用方必须已持有台账锁）。 */
async function allocatePortLocked(
  root: string,
  instance: { id: string; name: string },
  explicitPort: number | null,
): Promise<PortDecision> {
  const now = Date.now();
  const ledger = await readPortLedger(root);
  const failures = liveFailures(ledger.failures, now);

  /*
   * 用户显式要求内核分配：尊重，不进避让逻辑。
   * 但仍然留一条台账记录 —— "台账为每个实例留一条记录"这句话不该有例外，
   * 否则这类实例会从审计里凭空消失。`last` 记 0 是诚实的（真实端口见启动输出），
   * `preferred` 取区间起点，这样用户将来去掉 `--port 0` 时能直接得到一个稳定的托管端口。
   */
  if (explicitPort === OS_ASSIGNED_PORT) {
    ownedBy.set(instance.id, OS_ASSIGNED_PORT);
    await rememberAllocation(root, ledger, instance, {
      preferred: PORT_RANGE_START,
      last: OS_ASSIGNED_PORT,
      pid: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      port: OS_ASSIGNED_PORT,
      desired: OS_ASSIGNED_PORT,
      avoided: false,
      source: 'explicit',
      reason: '启动参数显式指定 --port 0 → 交操作系统分配空闲端口',
    };
  }

  const previous = ledger.allocations[instance.id] ?? null;
  const desired = explicitPort ?? previous?.preferred ?? null;
  const source: PortSource = explicitPort !== null ? 'explicit' : previous !== null ? 'ledger' : 'auto';

  // 其它实例已认领的期望端口：新实例（auto）应主动让开，避免"新来的把老人挤走"
  const claimedByPeers = new Set<number>();
  for (const [key, record] of Object.entries(ledger.allocations)) {
    if (key !== instance.id) claimedByPeers.add(record.preferred);
  }

  const candidates: number[] = [];
  // 显式端口若在区间之外（例如 --port 8080），先试它本身，再退回托管区间
  if (desired !== null && (desired < PORT_RANGE_START || desired > PORT_RANGE_END)) {
    candidates.push(desired);
  }
  candidates.push(...scanOrder(desired ?? PORT_RANGE_START));

  // 自动分配时把"别人认领的"与"最近被 dsh 拒过的"排到后面，提高一次命中的概率
  const deprioritized = (port: number): boolean =>
    claimedByPeers.has(port) || failures[String(port)] !== undefined;
  const ordered =
    source === 'auto'
      ? [
          ...candidates.filter((port) => !deprioritized(port)),
          ...candidates.filter((port) => deprioritized(port)),
        ]
      : candidates;

  for (const port of ordered) {
    if (!claimPort(port)) continue; // 同步占位：同进程并发不可能选重
    const free = await isPortFree(port);
    if (!free) {
      releaseClaim(port);
      continue;
    }
    const avoided = desired !== null && port !== desired;
    ownedBy.set(instance.id, port);
    await rememberAllocation(root, ledger, instance, {
      preferred: desired !== null && desired !== OS_ASSIGNED_PORT ? desired : port,
      last: port,
      pid: null,
      updatedAt: new Date().toISOString(),
    });
    return { port, desired, avoided, source, reason: describeDecision(source, desired, port, avoided) };
  }

  // 区间耗尽：回落内核分配，保证实例仍能起来
  ownedBy.set(instance.id, OS_ASSIGNED_PORT);
  const decision: PortDecision = {
    port: OS_ASSIGNED_PORT,
    desired,
    avoided: desired !== null,
    source: 'os',
    reason: describeDecision('os', desired, OS_ASSIGNED_PORT, desired !== null),
  };
  await rememberAllocation(root, ledger, instance, {
    preferred: desired ?? PORT_RANGE_START,
    last: OS_ASSIGNED_PORT,
    pid: null,
    updatedAt: new Date().toISOString(),
  });
  return decision;
}

/** 写入/更新台账中的一条分配记录（保留 `preferred` 的稳定性）。 */
async function rememberAllocation(
  root: string,
  ledger: PortLedger,
  instance: { id: string; name: string },
  patch: { preferred: number; last: number; pid: number | null; updatedAt: string },
): Promise<void> {
  const record: PortRecord = {
    name: instance.name,
    preferred: patch.preferred,
    last: patch.last,
    pid: patch.pid,
    updatedAt: patch.updatedAt,
  };
  const next: PortLedger = {
    schemaVersion: PORT_LEDGER_SCHEMA,
    allocations: { ...ledger.allocations, [instance.id]: record },
    failures: ledger.failures,
  };
  await writePortLedger(root, next);
}

/**
 * 记录实例已经拿到 PID（启动成功后调用，写入台账便于人工排查）。
 * @param root 启动器根目录。
 * @param instanceId 实例 id。
 * @param pid 进程 PID。
 */
export async function notePortBound(root: string, instanceId: string, pid: number): Promise<void> {
  await withLedgerLock(async () => {
    const ledger = await readPortLedger(root);
    const record = ledger.allocations[instanceId];
    if (record === undefined) return;
    await writePortLedger(root, {
      ...ledger,
      allocations: {
        ...ledger.allocations,
        [instanceId]: { ...record, pid, updatedAt: new Date().toISOString() },
      },
    });
  });
}

/**
 * 回填实例**实际**使用的端口（从 dsh 输出里解析出来的那个）。
 *
 * 为什么不能在分配阶段一次写完：走 `--port 0`（内核分配）时，分配那一刻**根本不知道
 * 端口号**，只有 dsh 打印出界面地址后才知道。不回填的话台账的 `last` 会永远停在 0 ——
 * 需求「记录每个实例实际使用的端口」在兜底路径上就不成立了。
 * （独立审查实测：占满区间后启动，`runtime.port=53902` 正确，台账却仍是 `last: 0`。）
 * @param root 启动器根目录。
 * @param instanceId 实例 id。
 * @param port 实际端口。
 */
export async function notePortActual(root: string, instanceId: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  await withLedgerLock(async () => {
    const ledger = await readPortLedger(root);
    const record = ledger.allocations[instanceId];
    // 幂等：同一个端口重复回填不产生额外写入
    if (record === undefined || record.last === port) return;
    await writePortLedger(root, {
      ...ledger,
      allocations: {
        ...ledger.allocations,
        [instanceId]: { ...record, last: port, updatedAt: new Date().toISOString() },
      },
    });
  });
}

/**
 * 释放实例占用的端口（进程退出时调用）。
 *
 * 释放的是**预留**；端口本身由操作系统在进程结束后回收。`preferred` 保留不动，
 * 因此下次启动仍会优先复用同一个端口（"退出后端口回收与重用"）。
 * @param root 启动器根目录。
 * @param instanceId 实例 id。
 */
export async function releasePort(root: string, instanceId: string): Promise<void> {
  const port = ownedBy.get(instanceId);
  if (port !== undefined && port !== OS_ASSIGNED_PORT) releaseClaim(port);
  ownedBy.delete(instanceId);
  await withLedgerLock(async () => {
    const ledger = await readPortLedger(root);
    const record = ledger.allocations[instanceId];
    if (record === undefined || record.pid === null) return;
    await writePortLedger(root, {
      ...ledger,
      allocations: {
        ...ledger.allocations,
        [instanceId]: { ...record, pid: null, updatedAt: new Date().toISOString() },
      },
    });
  });
}

/**
 * 记录"这个端口刚被 dsh 以 EADDRINUSE 拒绝过"。
 *
 * 这是残余竞态窗口（探测通过 → 交给 dsh 之间被外部抢走）的**自愈**手段：
 * 短时间内不再优先选用该端口，下一次启动即自动避开。
 * @param root 启动器根目录。
 * @param port 失败端口。
 */
export async function notePortFailure(root: string, port: number): Promise<void> {
  if (port === OS_ASSIGNED_PORT) return;
  await withLedgerLock(async () => {
    const ledger = await readPortLedger(root);
    const now = new Date().toISOString();
    const failures = { ...liveFailures(ledger.failures, Date.now()), [String(port)]: now };
    await writePortLedger(root, { ...ledger, failures });
  });
}

/**
 * 彻底删除某个实例的台账记录（删除实例时调用）。
 *
 * 与 {@link releasePort} 的区别：释放**保留** `preferred` 供下次复用，而这里实例已经
 * 不存在了，留着记录只会让台账越积越大、并让新实例白白避开一个没人认领的端口。
 * @param root 启动器根目录。
 * @param instanceId 实例 id。
 */
export async function forgetPort(root: string, instanceId: string): Promise<void> {
  releaseClaim(ownedBy.get(instanceId) ?? -1);
  ownedBy.delete(instanceId);
  await withLedgerLock(async () => {
    const ledger = await readPortLedger(root);
    if (ledger.allocations[instanceId] === undefined) return;
    const allocations = { ...ledger.allocations };
    delete allocations[instanceId];
    await writePortLedger(root, { ...ledger, allocations });
  });
}
