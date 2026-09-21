/**
 * 桥接层冒烟测试（协议 §5.5「可脱离 UI 的冒烟测试」）
 * ============================================================================
 *
 * 做法：spawn `dist/bridge/server.cjs`，按协议 §1 往 stdin 喂 NDJSON、读 stdout 断言，
 * 并在同一条流上**扮演 C# 宿主**——响应 Node 反向发来的 `host:` 调用（协议 §3.3），
 * 因此对话框类通道也能被端到端验证，不依赖任何 UI。
 *
 * 安全边界（硬性）：
 *  - 全程只在 `os.tmpdir()/whales-bridge-smoke-*` 上跑，`--home` 指向该临时目录；
 *  - 启动前显式断言临时目录**不在**仓库根之下（避免任何形式的误伤）；
 *  - 结束时断言仓库根的 `launcher.json` / `instances/` 未被改动，并删除临时目录
 *    （`--keep` 可保留现场排查）。
 *
 * 运行：`node scripts/audit/bridge-smoke.mjs [--keep]`
 * 退出码：0 = 全部通过；1 = 有断言失败或桥接进程异常。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeEntry = path.join(repoRoot, 'dist', 'bridge', 'server.cjs');
const keepTemp = process.argv.includes('--keep');

/** 契约 `CH` 的 39 条通道字面值（冻结值，独立于实现硬编码以形成交叉校验）。 */
const EXPECTED_CHANNELS = [
  'launcher:getConfig', 'launcher:setConfig', 'launcher:detectNode',
  'instance:list', 'instance:create', 'instance:get', 'instance:update',
  'instance:remove', 'instance:launch', 'instance:stop', 'instance:openFolder',
  'engine:list', 'engine:available', 'engine:install', 'engine:remove',
  'plugin:inventory', 'plugin:add', 'plugin:remove', 'plugin:setBundleEnabled',
  'plugin:install', 'plugin:removeLocal', 'plugin:listLocal',
  'plugin:pickArchive', 'plugin:pickFolder',
  'settings:read', 'settings:write', 'settings:shareConflicts', 'settings:resolveShareConflict',
  'saves:list', 'saves:openFolder',
  'pack:export', 'pack:import', 'pack:pickFile',
  'log:chunk', 'log:state',
  'app:version', 'app:openExternal', 'app:menu', 'app:menuCommand',
];

/** 协议 §3.3 的宿主方法表。 */
const EXPECTED_HOST_METHODS = [
  'host:pickArchive', 'host:pickFolder', 'host:pickPackFile', 'host:saveFile',
  'host:downloadsDir', 'host:openPath', 'host:openExternal', 'host:messageBox',
];

const INSTANCE_ID = 'smoke-id-0001';
const INSTANCE_DIR = 'smoke-demo';
const ENGINE_VERSION = '0.0.1-smoke';

/* ------------------------------------------------------------------ *
 * 断言框架
 * ------------------------------------------------------------------ */

const checks = [];
let failures = 0;

function check(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok) });
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` —— ${detail}`;
  console.log(`${ok ? '✓' : '✗'} ${label}${suffix}`);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

/** 打印真实响应原文（截断到 400 字符），供人工核对。 */
function sample(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const clipped = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  console.log(`  · ${label} → ${clipped}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等待某个条件成立（事件是异步推送的，不能假设它紧跟响应到达）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(25);
  }
}

/* ------------------------------------------------------------------ *
 * 桥接客户端（扮演 C# 宿主）
 * ------------------------------------------------------------------ */

function createClient(child, { tmpHome }) {
  const pending = new Map();
  const events = [];
  const hostCalls = [];
  const stderrLines = [];
  const stdoutViolations = [];
  const unexpected = [];

  /** 宿主方法实现：默认全部成功；各用例按需覆盖。 */
  let hostImpl = (method) => {
    if (method === 'host:downloadsDir') return { ok: true, value: tmpHome };
    if (method === 'host:pickArchive') return { ok: true, value: path.join(tmpHome, 'fake-plugin.zip') };
    if (method === 'host:pickFolder') return { ok: true, value: path.join(tmpHome, 'fake-plugin-dir') };
    if (method === 'host:pickPackFile') return { ok: true, value: path.join(tmpHome, 'fake.whalepack.zip') };
    if (method === 'host:saveFile') return { ok: true, value: path.join(tmpHome, 'fake-export.whalepack.zip') };
    return { ok: true, value: null };
  };

  let buffer = '';
  let stdoutText = '';
  let stderrText = '';
  let seq = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutText += chunk;
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // stdout 只允许协议数据（协议 §4）：任何非 JSON 行都是污染，计入失败证据。
        stdoutViolations.push(line);
        continue;
      }

      if (typeof message.method === 'string') {
        // Node → C# 的宿主调用（协议 §3.3）：本脚本就是 C#。
        hostCalls.push({ id: message.id, method: message.method, params: message.params });
        let answer;
        try {
          answer = hostImpl(message.method, message.params ?? []);
        } catch (error) {
          answer = { ok: false, error: error?.message ?? String(error) };
        }
        Promise.resolve(answer)
          .then((value) => {
            if (child.stdin.writable && !child.killed) {
              child.stdin.write(`${JSON.stringify({ id: message.id, ...value })}\n`);
            }
          })
          .catch(() => undefined);
        continue;
      }

      if (typeof message.event === 'string') {
        events.push(message);
        continue;
      }

      const entry = pending.get(message.id);
      if (entry === undefined) {
        unexpected.push(message);
        continue;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim().length > 0) stderrLines.push(line);
    }
  });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    events,
    hostCalls,
    stderrLines,
    stdoutViolations,
    unexpected,
    get stdout() {
      return stdoutText;
    },
    get stderr() {
      return stderrText;
    },
    setHost(fn) {
      hostImpl = fn;
    },
    /** 发一条请求并等响应。 */
    request(method, params = [], options = {}) {
      seq += 1;
      const id = options.id ?? `c${seq}`;
      const payload =
        options.omitParams === true
          ? { id, method }
          : { id, method, params };
      const text = options.raw ?? `${options.prefix ?? ''}${JSON.stringify(payload)}${options.eol ?? '\n'}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`等待 ${method} 的响应超时（${options.timeoutMs ?? 30_000}ms）`));
        }, options.timeoutMs ?? 30_000);
        pending.set(id, { resolve, timer });
        child.stdin.write(text);
      });
    },
    waitForExit(timeoutMs = 20_000) {
      return Promise.race([exited, sleep(timeoutMs).then(() => ({ code: null, signal: null, timeout: true }))]);
    },
    exited,
  };
}

/* ------------------------------------------------------------------ *
 * 断言辅助
 * ------------------------------------------------------------------ */

/** 断言响应成功。 */
function expectOk(label, response) {
  const ok = response?.ok === true;
  check(ok ? label : `${label}（期望 ok:true）`, ok, ok ? undefined : JSON.stringify(response));
  return ok ? response.value : undefined;
}

/** 断言响应失败且错误文案符合预期。 */
function expectErr(label, response, expected) {
  const ok = response?.ok === false;
  const matched = typeof expected === 'function' ? ok && expected(response.error) : ok && response.error === expected;
  check(
    matched ? label : `${label}（错误文案不符）`,
    matched,
    `实际 ${JSON.stringify(response?.error)}${typeof expected === 'string' ? `，期望 ${JSON.stringify(expected)}` : ''}`,
  );
}

/** 目录签名：用于"真实数据未被触碰"的隔离断言。 */
async function dirSignature(dir) {
  try {
    const names = await readdir(dir);
    return `present:${names.sort().join(',')}`;
  } catch {
    return 'absent';
  }
}

async function fileSignature(file) {
  try {
    const info = await stat(file);
    return `present:${info.size}:${info.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('WhalesLauncher 桥接层冒烟测试（NDJSON stdio，无 UI）');
  console.log(`仓库根：${repoRoot}`);

  if (!existsSync(bridgeEntry)) {
    console.error(`\n找不到桥接产物：${bridgeEntry}\n请先执行：node scripts/build-bridge.mjs`);
    process.exit(1);
  }

  // 真实数据的"测试前快照"：用来证明本次冒烟没有碰过仓库里的数据。
  const realLauncherJson = path.join(repoRoot, 'launcher.json');
  const realInstances = path.join(repoRoot, 'instances');
  const beforeLauncher = await fileSignature(realLauncherJson);
  const beforeInstances = await dirSignature(realInstances);

  // ── 临时 home ───────────────────────────────────────────────────
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'whales-bridge-smoke-'));
  const tmpResolved = path.resolve(tmpHome);
  const tmpRootResolved = path.resolve(os.tmpdir());

  // 硬性隔离断言：临时目录必须在系统临时目录下、且不在仓库根之下。
  const isolated =
    tmpResolved.startsWith(tmpRootResolved) &&
    !tmpResolved.startsWith(path.resolve(repoRoot)) &&
    tmpResolved !== path.resolve(repoRoot);
  if (!isolated) {
    console.error(`\n隔离断言失败：临时 home ${tmpResolved} 不在 ${tmpRootResolved} 下（或落在仓库内），已中止。`);
    process.exit(1);
  }
  console.log(`临时 home：${tmpResolved}`);

  await writeFixture(tmpHome);

  const repoVersion = await readRepoVersion();

  const child = spawn(process.execPath, [bridgeEntry, '--home', tmpHome], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = createClient(child, { tmpHome });

  try {
    /* ================= [1] 握手 ================= */
    section('[1] 启动与握手（协议 §3.2）');

    // 故意在第一帧带上 UTF-8 BOM 与 CRLF：C# 的 StreamWriter 默认就是这个形态。
    const handshake = await client.request('__handshake', [], {
      prefix: '\uFEFF',
      eol: '\r\n',
      timeoutMs: 20_000,
    });
    const hs = expectOk('__handshake 成功（且容忍首帧 BOM + CRLF）', handshake);
    check('handshake.protocol === 1', hs?.protocol === 1, `实际 ${JSON.stringify(hs?.protocol)}`);
    sample('handshake', { protocol: hs?.protocol, appVersion: hs?.appVersion, channels: `${hs?.channels?.length} 条`, hostMethods: hs?.hostMethods });

    check(
      `handshake.appVersion === ${repoVersion}（构建期注入，与 --home 无关）`,
      hs?.appVersion === repoVersion,
      `实际 ${JSON.stringify(hs?.appVersion)}`,
    );
    check(
      `handshake.channels 共 ${EXPECTED_CHANNELS.length} 条且与契约 CH 完全一致`,
      Array.isArray(hs?.channels) &&
        hs.channels.length === EXPECTED_CHANNELS.length &&
        EXPECTED_CHANNELS.every((name) => hs.channels.includes(name)),
      `实际 ${hs?.channels?.length} 条`,
    );
    check(
      `handshake.hostMethods 与协议 §3.3 的 ${EXPECTED_HOST_METHODS.length} 条完全一致`,
      Array.isArray(hs?.hostMethods) &&
        hs.hostMethods.length === EXPECTED_HOST_METHODS.length &&
        EXPECTED_HOST_METHODS.every((name) => hs.hostMethods.includes(name)),
      `实际 ${JSON.stringify(hs?.hostMethods)}`,
    );

    expectOk('__ping（params 省略也应可用）', await client.request('__ping', [], { omitParams: true }));

    /* ================= [2] 协议层健壮性 ================= */
    section('[2] 协议层健壮性（协议 §2.1 / §4）');

    expectErr(
      '未知方法 → 「未知方法：<method>」',
      await client.request('no:such:method', []),
      '未知方法：no:such:method',
    );
    expectErr(
      '推送通道不可调用（log:chunk）→ 未知方法',
      await client.request('log:chunk', []),
      '未知方法：log:chunk',
    );
    expectErr(
      'params 非数组 → 明确报错',
      await client.request('instance:list', {}, {
        id: 'c-badparams',
        raw: '{"id":"c-badparams","method":"instance:list","params":{}}\n',
      }),
      'params 必须是数组（协议 §2.1 的位置参数数组）。',
    );

    /* ================= [3] launcher + 配置自愈 ================= */
    section('[3] launcher 通道与配置损坏自愈（config.ts 等价搬运）');

    const config = expectOk('launcher:getConfig', await client.request('launcher:getConfig', []));
    sample('launcher:getConfig', config);
    check('config.rootDir 指向本次 --home', config?.rootDir === tmpResolved, `实际 ${JSON.stringify(config?.rootDir)}`);
    check('config.schemaVersion === 1', config?.schemaVersion === 1);
    check('config.theme === "dark"（损坏配置回退默认值）', config?.theme === 'dark');
    check('config.primaryHome 为绝对路径', typeof config?.primaryHome === 'string' && path.isAbsolute(config.primaryHome), config?.primaryHome);
    check('config.confirmOnDelete === true', config?.confirmOnDelete === true);

    const notice = await waitFor(() =>
      client.events.find(
        (item) => item.event === 'log:chunk' && typeof item.data?.text === 'string' && item.data.text.includes('全局配置已损坏'),
      ),
    );
    check('损坏配置的提示以 log:chunk 事件投递（旧 did-finish-load 时机）', notice !== undefined,
      notice === undefined ? `未收到；已收到事件 ${client.events.length} 条` : undefined);
    if (notice !== undefined) sample('log:chunk(launcher)', notice.data.text.trim());

    const backups = (await readdir(tmpHome)).filter((name) => name.startsWith('launcher.json.bak-'));
    check('损坏的 launcher.json 已改名备份（原文件未被静默丢弃）', backups.length === 1, `备份 ${JSON.stringify(backups)}`);
    const persistedConfig = JSON.parse(await readFile(path.join(tmpHome, 'launcher.json'), 'utf8'));
    check('新写入的 launcher.json 不含 rootDir（rootDir 只注入不落盘）', persistedConfig.rootDir === undefined);
    sample('launcher.json(磁盘)', persistedConfig);

    const nodeReport = expectOk('launcher:detectNode', await client.request('launcher:detectNode', [true], { timeoutMs: 120_000 }));
    sample('launcher:detectNode', { ok: nodeReport?.ok, message: nodeReport?.message });
    check('detectNode 返回 NodeRuntimeReport 形状', typeof nodeReport?.ok === 'boolean' && Array.isArray(nodeReport?.candidates));

    /* ================= [4] 参数校验等价性 ================= */
    section('[4] 参数校验等价性（校验来源：src/main/ipc.ts / config.ts）');

    expectErr(
      'setConfig 拒绝相对主 home（config.ts 校验）',
      await client.request('launcher:setConfig', [{ primaryHome: 'relative/home' }]),
      '主 home 必须是绝对路径，收到：relative/home',
    );
    expectErr(
      'setConfig 拒绝非法主题',
      await client.request('launcher:setConfig', [{ theme: 'blue' }]),
      '主题只能是 dark 或 light。',
    );
    expectErr(
      'setConfig 拒绝空引擎源',
      await client.request('launcher:setConfig', [{ engineRegistry: '   ' }]),
      '引擎源不能为空。',
    );
    expectErr(
      'setConfig 拒绝不存在的 node 路径',
      await client.request('launcher:setConfig', [{ nodePath: path.join(tmpHome, 'no-such-node.exe') }]),
      (error) => typeof error === 'string' && error.startsWith('找不到 Node 可执行文件：'),
    );
    check(
      'setConfig 接受合法 patch',
      (await client.request('launcher:setConfig', [{ confirmOnDelete: false }]))?.ok === true,
    );

    expectErr('instance:get 拒绝非字符串 id', await client.request('instance:get', [42]), '实例 ID必须是字符串。');
    expectErr('instance:get 拒绝空 id', await client.request('instance:get', ['   ']), '实例 ID不能为空。');
    expectErr(
      'instance:get 查不到实例 → 既有中文文案',
      await client.request('instance:get', ['no-such-id']),
      '找不到实例（id：no-such-id），它可能已被删除。请刷新实例列表后重试。',
    );

    /* ================= [5] instance 通道 ================= */
    section('[5] instance 通道（真实 core 读写，临时 home 内）');

    const list = expectOk('instance:list', await client.request('instance:list', []));
    sample('instance:list', list);
    check('instance:list 返回 1 条 fixture 实例', Array.isArray(list) && list.length === 1);
    const summary = Array.isArray(list) ? list[0] : undefined;
    check('fixture 实例 id/name 正确', summary?.meta?.id === INSTANCE_ID && summary?.meta?.name === '冒烟实例', summary?.meta?.name);
    check('summary.present === true（目录存在）', summary?.present === true);
    check('summary.engineInstalled === false（引擎未安装）', summary?.engineInstalled === false);
    check('summary.problem 为空（fixture 无异常）', summary?.problem === undefined, summary?.problem);

    const detail = expectOk('instance:get', await client.request('instance:get', [INSTANCE_ID]));
    check('instance:get 返回同一实例', detail?.meta?.id === INSTANCE_ID);

    const updated = expectOk(
      'instance:update（name 去空白，写回 instance.json）',
      await client.request('instance:update', [INSTANCE_ID, { name: '  改名的冒烟实例  ' }]),
    );
    check('更新后的 name 已 trim', updated?.meta?.name === '改名的冒烟实例', updated?.meta?.name);
    check(
      'instance:update 推送 log:state 事件',
      client.events.some((item) => item.event === 'log:state' && item.data?.instanceId === INSTANCE_ID),
    );
    expectErr(
      'instance:update 拒绝白名单外字段',
      await client.request('instance:update', [INSTANCE_ID, { bogus: 1 }]),
      '不支持的更新字段：bogus。',
    );
    expectErr(
      'instance:update 拒绝非数组 appArgs',
      await client.request('instance:update', [INSTANCE_ID, { appArgs: 'x' }]),
      '启动参数必须是字符串数组。',
    );
    expectErr(
      'instance:update 拒绝数组内空项',
      await client.request('instance:update', [INSTANCE_ID, { appArgs: ['ok', '  '] }]),
      '启动参数第 2 项不能为空。',
    );
    expectErr(
      'instance:update 拒绝非法共享模式',
      await client.request('instance:update', [INSTANCE_ID, { workspace: 'both' }]),
      '工作区模式只能是 local（独立）或 shared（共享）。',
    );

    expectErr('instance:launch 拒绝非对象参数', await client.request('instance:launch', [123]), '启动参数格式不正确（应为对象）。');
    // 注意：文案里 `实例 ID` 与 `必须是字符串。` 之间**没有空格** —— 这是 ipc.ts L567
    // 的模板（`${label}必须是字符串。`）原样产物，此处刻意逐字断言。
    expectErr('instance:launch 拒绝缺 instanceId', await client.request('instance:launch', [{}]), '实例 ID必须是字符串。');
    expectErr(
      'instance:launch 引擎未安装 → 前置指引文案（与 ipc.ts L143 一致）',
      await client.request('instance:launch', [{ instanceId: INSTANCE_ID }]),
      `引擎 ${ENGINE_VERSION} 未安装，请先在「版本管理」中安装该版本。`,
    );

    const stopNoop = await client.request('instance:stop', [INSTANCE_ID]);
    expectOk('instance:stop（未运行的实例为 no-op）', stopNoop);
    check('void 通道的 value 显式归一为 null（协议 §2.2 的 value 恒定存在）', stopNoop.value === null, JSON.stringify(stopNoop));

    const openRes = expectOk('instance:openFolder(logs) → host:openPath', await client.request('instance:openFolder', [INSTANCE_ID, 'logs']));
    check('openFolder 返回 void（value 归一为 null）', openRes === null, JSON.stringify(openRes));
    const logsPath = path.join(tmpHome, 'instances', INSTANCE_DIR, 'logs');
    const openCall = client.hostCalls.filter((call) => call.method === 'host:openPath').at(-1);
    check('宿主收到 host:openPath 且路径为实例 logs 目录', openCall?.params?.[0]?.path === logsPath, JSON.stringify(openCall?.params));
    check('打开前已自愈创建该目录（ipc.ts L489 ensureDir）', existsSync(logsPath));
    check('host 调用 id 使用 n 前缀（协议 §2.1 命名空间）', typeof openCall?.id === 'string' && openCall.id.startsWith('n'), openCall?.id);
    expectErr(
      'instance:openFolder 拒绝未知文件夹类型',
      await client.request('instance:openFolder', [INSTANCE_ID, 'nope']),
      '未知的文件夹类型：nope（可选：root、home、workspace、logs、plugins）。',
    );

    /* ================= [6] engine 通道 ================= */
    section('[6] engine 通道');

    const engines = expectOk('engine:list', await client.request('engine:list', []));
    sample('engine:list', engines);
    check('engine:list 返回数组（临时 home 内无引擎）', Array.isArray(engines) && engines.length === 0);
    expectErr(
      'engine:remove 未安装版本 → 既有文案',
      await client.request('engine:remove', ['9.9.9']),
      '本机没有安装引擎 9.9.9。',
    );
    expectErr('engine:install 拒绝空版本号', await client.request('engine:install', ['  ']), '引擎版本不能为空。');

    // engine:available 需要访问 npm registry（3 分钟超时），因此按"软检查"处理：
    // 有响应就断形状；网络不可用时记为 SKIP，不让整轮冒烟失败。
    const availableStart = Date.now();
    let availableSkipped = false;
    try {
      const available = await client.request('engine:available', [], { timeoutMs: 120_000 });
      const elapsed = Date.now() - availableStart;
      if (available.ok === true) {
        const versions = available.value;
        check(
          `engine:available 返回版本号数组（${versions?.length} 个，耗时 ${elapsed}ms）`,
          Array.isArray(versions) && versions.every((item) => typeof item === 'string'),
          JSON.stringify(versions).slice(0, 120),
        );
        sample('engine:available', Array.isArray(versions) ? versions.slice(0, 5) : versions);
      } else {
        check(
          `engine:available 失败时给出非空中文文案（耗时 ${elapsed}ms）`,
          typeof available.error === 'string' && available.error.length > 0,
          available.error,
        );
      }
    } catch (error) {
      availableSkipped = true;
      console.log(`  ⚠ SKIP engine:available —— ${error.message}（该通道依赖 npm registry，网络不可用时不计失败）`);
    }
    if (availableSkipped) checks.push({ label: 'engine:available（SKIP）', ok: true });

    /* ================= [7] plugin 通道 ================= */
    section('[7] plugin 通道');

    const localPlugins = expectOk('plugin:listLocal', await client.request('plugin:listLocal', [INSTANCE_ID]));
    sample('plugin:listLocal', localPlugins);
    check('plugin:listLocal 返回数组', Array.isArray(localPlugins));
    const inventory = expectOk('plugin:inventory', await client.request('plugin:inventory', [INSTANCE_ID]));
    sample('plugin:inventory', inventory);
    check(
      'plugin:inventory 返回 PluginInventory 形状',
      Array.isArray(inventory?.bundles) && Array.isArray(inventory?.dependencies) && typeof inventory?.profileDir === 'string',
    );
    check(
      'profile 里启用的组合包如实反映（fixture 的 dsh-base）',
      inventory?.bundles?.some((item) => item.name === '@deepseek-ai/dsh-base' && item.enabled === true),
      JSON.stringify(inventory?.bundles),
    );
    expectErr('plugin:add 拒绝空包名', await client.request('plugin:add', [INSTANCE_ID, '']), '插件包名不能为空。');
    expectErr('plugin:remove 拒绝非字符串插件名', await client.request('plugin:remove', [INSTANCE_ID, 42]), '插件名必须是字符串。');
    expectErr(
      'plugin:setBundleEnabled 拒绝非布尔启用状态',
      await client.request('plugin:setBundleEnabled', [INSTANCE_ID, 'x', 'yes']),
      '启用状态必须是布尔值。',
    );
    expectErr(
      'plugin:install 拒绝未知来源 kind',
      await client.request('plugin:install', [INSTANCE_ID, { kind: 'nope' }]),
      '未知的插件来源："nope"（只支持 archive / github / folder）。',
    );
    expectErr(
      'plugin:install 拒绝缺少 file 的 archive 来源',
      await client.request('plugin:install', [INSTANCE_ID, { kind: 'archive' }]),
      '插件压缩包路径必须是字符串。',
    );
    expectErr('plugin:removeLocal 拒绝 null 插件名', await client.request('plugin:removeLocal', [INSTANCE_ID, null]), '插件名必须是字符串。');

    setHostDefault(client, tmpHome);
    client.setHost((method) => {
      if (method === 'host:pickArchive') return { ok: true, value: 'D:\\tmp\\plugin.zip' };
      if (method === 'host:pickFolder') return { ok: true, value: 'D:\\tmp\\plugin-dir' };
      return { ok: true, value: null };
    });
    const pickedArchive = expectOk('plugin:pickArchive → host:pickArchive', await client.request('plugin:pickArchive', []));
    check('取回宿主选中的压缩包路径', pickedArchive === 'D:\\tmp\\plugin.zip', JSON.stringify(pickedArchive));
    const archiveCall = client.hostCalls.filter((call) => call.method === 'host:pickArchive').at(-1);
    check(
      'host:pickArchive 参数形状 [{title}]',
      archiveCall?.params?.length === 1 && archiveCall.params[0].title === '选择插件压缩包',
      JSON.stringify(archiveCall?.params),
    );
    const pickedFolder = expectOk('plugin:pickFolder → host:pickFolder', await client.request('plugin:pickFolder', []));
    check('取回宿主选中的文件夹路径', pickedFolder === 'D:\\tmp\\plugin-dir');

    /* ================= [8] settings 通道 ================= */
    section('[8] settings 通道（真实文件往返，临时 home 内）');

    expectOk('settings:write', await client.request('settings:write', [INSTANCE_ID, 'logLevel: debug\n']));
    const yamlText = expectOk('settings:read', await client.request('settings:read', [INSTANCE_ID]));
    check('写→读 往返一致', yamlText === 'logLevel: debug\n', JSON.stringify(yamlText));
    sample('settings:read', yamlText);
    expectOk('settings:write 允许空内容（allowEmpty）', await client.request('settings:write', [INSTANCE_ID, '']));
    expectErr(
      'settings:write 拒绝非法 YAML（core 侧 js-yaml 校验）',
      await client.request('settings:write', [INSTANCE_ID, 'a: [1,\n  b: :\n']),
      (error) => typeof error === 'string' && error.length > 0,
    );
    expectErr('settings:write 拒绝非字符串内容', await client.request('settings:write', [INSTANCE_ID, 5]), '设置内容必须是字符串。');

    const conflicts = expectOk('settings:shareConflicts', await client.request('settings:shareConflicts', [INSTANCE_ID]));
    sample('settings:shareConflicts', conflicts);
    check('shareConflicts 返回空数组', Array.isArray(conflicts) && conflicts.length === 0);
    expectErr(
      'settings:resolveShareConflict 拒绝非法方向',
      await client.request('settings:resolveShareConflict', [INSTANCE_ID, 'both']),
      '冲突解决方式只能是 use-local（以本地设置为准）或 use-shared（以共享设置为准），收到：both。',
    );
    expectOk(
      'settings:resolveShareConflict(use-local) 成功',
      await client.request('settings:resolveShareConflict', [INSTANCE_ID, 'use-local']),
    );

    /* ================= [9] saves 通道 ================= */
    section('[9] saves 通道');

    const sessions = expectOk('saves:list', await client.request('saves:list', [INSTANCE_ID]));
    sample('saves:list', sessions);
    check('saves:list 返回数组', Array.isArray(sessions));
    expectOk('saves:openFolder（无 sessionId → 实例 sessions 目录）', await client.request('saves:openFolder', [INSTANCE_ID]));
    const sessionsCall = client.hostCalls.filter((call) => call.method === 'host:openPath').at(-1);
    check(
      'host:openPath 指向 <instance>/home/sessions',
      sessionsCall?.params?.[0]?.path === path.join(tmpHome, 'instances', INSTANCE_DIR, 'home', 'sessions'),
      JSON.stringify(sessionsCall?.params),
    );
    expectErr(
      'saves:openFolder 未知会话 → 既有文案',
      await client.request('saves:openFolder', [INSTANCE_ID, 'no-such-session']),
      '找不到会话 no-such-session，请刷新存档列表后重试。',
    );

    /* ================= [10] pack 通道 ================= */
    section('[10] pack 通道（对话框经 host: 反向调用）');

    client.setHost((method) => {
      if (method === 'host:pickPackFile') return { ok: true, value: 'D:\\tmp\\picked.zip' };
      if (method === 'host:downloadsDir') return { ok: true, value: tmpHome };
      if (method === 'host:saveFile') return { ok: true, value: null }; // 用户取消
      return { ok: true, value: null };
    });
    const pickedFile = expectOk('pack:pickFile → host:pickPackFile', await client.request('pack:pickFile', []));
    check('pack:pickFile 返回宿主选中的路径', pickedFile === 'D:\\tmp\\picked.zip', JSON.stringify(pickedFile));

    const exportCancelled = await client.request('pack:export', [INSTANCE_ID]);
    expectOk('pack:export 在用户取消保存时返回 null（不报错）', exportCancelled);
    check('pack:export 取消时 value === null', exportCancelled.value === null, JSON.stringify(exportCancelled));
    const saveCall = client.hostCalls.filter((call) => call.method === 'host:saveFile').at(-1);
    check(
      'host:saveFile 参数形状 [{title, suggestedName, defaultDir}]',
      saveCall?.params?.length === 1 &&
        typeof saveCall.params[0].title === 'string' &&
        /^改名的冒烟实例-\d{4}-\d{2}-\d{2}\.whalepack\.zip$/.test(saveCall.params[0].suggestedName) &&
        saveCall.params[0].defaultDir === tmpHome,
      JSON.stringify(saveCall?.params),
    );

    // 用户取消（宿主返回 null）：必须是 ok:true + value:null，而不是报错。
    client.setHost((method) => {
      if (method === 'host:pickPackFile') return { ok: true, value: null };
      return { ok: true, value: null };
    });
    const importCancelled = await client.request('pack:import', []);
    expectOk('pack:import 在用户取消选择时返回 null', importCancelled);
    check('pack:import 取消时 value === null', importCancelled.value === null, JSON.stringify(importCancelled));
    const importCall = client.hostCalls.filter((call) => call.method === 'host:pickPackFile').at(-1);
    check('pack:import 复用 host:pickPackFile（标题区分意图）', importCall?.params?.[0]?.title === '选择要导入的实例包', JSON.stringify(importCall?.params));

    // 选中一个不存在的包文件：必须是可读的中文错误，而不是崩溃。
    client.setHost((method) => {
      if (method === 'host:pickPackFile') return { ok: true, value: path.join(tmpHome, 'no-such.whalepack.zip') };
      return { ok: true, value: null };
    });
    expectErr(
      'pack:import 选中不存在的包 → 非空中文错误',
      await client.request('pack:import', [], { timeoutMs: 60_000 }),
      (error) => typeof error === 'string' && error.length > 0,
    );

    // 真实导出：写一个真正的 zip，并**校验落盘元数据里的 launcherVersion**
    //（Lead 指出的缺陷正是"包元数据被写成假值 0.0.0"）。
    client.setHost((method) => {
      if (method === 'host:downloadsDir') return { ok: true, value: tmpHome };
      if (method === 'host:saveFile') return { ok: true, value: path.join(tmpHome, 'exported.whalepack.zip') };
      return { ok: true, value: null };
    });
    const exported = await client.request('pack:export', [INSTANCE_ID], { timeoutMs: 60_000 });
    const exportedPath = expectOk('pack:export（真实写出 zip）', exported);
    check('pack:export 返回目标路径且文件存在', typeof exportedPath === 'string' && existsSync(exportedPath), JSON.stringify(exportedPath));
    if (typeof exportedPath === 'string' && existsSync(exportedPath)) {
      sample('pack:export', exportedPath);
      const bytes = await readFile(exportedPath);
      check('产物是合法 zip（PK 头）', bytes.length > 0 && bytes[0] === 0x50 && bytes[1] === 0x4b);
      await verifyPackManifest(exportedPath, repoVersion);
    }

    // 真实导入：把刚导出的包喂回去。引擎未安装时应在"包元数据校验通过之后"报明确错误，
    // 这条路径会真正跑一遍 adm-zip 解包（验证 bundle 进来的 CJS 依赖可用）。
    client.setHost((method) => {
      if (method === 'host:pickPackFile') return { ok: true, value: path.join(tmpHome, 'exported.whalepack.zip') };
      return { ok: true, value: null };
    });
    const importReal = await client.request('pack:import', [], { timeoutMs: 120_000 });
    if (importReal.ok === true) {
      check('pack:import 真实导入返回 ImportResult', typeof importReal.value?.instanceId === 'string', JSON.stringify(importReal.value));
      sample('pack:import', importReal.value);
    } else {
      check(
        'pack:import 真实导入失败时报非空中文文案（临时 home 内无引擎，属预期）',
        typeof importReal.error === 'string' && importReal.error.length > 0,
        importReal.error,
      );
    }

    /* ================= [11] app 通道与外链安全边界 ================= */
    section('[11] app 通道 + host: 反向调用 + 外链安全边界');

    const version = expectOk('app:version（构建期注入的版本）', await client.request('app:version', []));
    check(`app:version === ${repoVersion}`, version === repoVersion, JSON.stringify(version));
    check(
      'app:version 不是假值 0.0.0（曾出现的缺陷：假值冒充成功）',
      version !== '0.0.0' && typeof version === 'string' && version.length > 0,
      JSON.stringify(version),
    );

    client.setHost((method) => {
      if (method === 'host:openExternal') return { ok: true, value: null };
      return { ok: true, value: null };
    });
    const hostCallsBeforeBlocked = client.hostCalls.length;
    expectOk('app:openExternal(https) → host:openExternal', await client.request('app:openExternal', ['https://example.com/x']));
    const externalCall = client.hostCalls.filter((call) => call.method === 'host:openExternal').at(-1);
    check('host:openExternal 参数形状 [{url}]', externalCall?.params?.[0]?.url === 'https://example.com/x', JSON.stringify(externalCall?.params));

    expectErr(
      'app:openExternal 拒绝 file:// 协议（安全硬边界）',
      await client.request('app:openExternal', ['file:///C:/Windows/System32']),
      '出于安全考虑，只允许打开 http/https 链接（收到 file://）。',
    );
    check(
      '被拒的外链不会触发任何宿主调用',
      client.hostCalls.length === hostCallsBeforeBlocked + 1,
      `宿主调用数 ${client.hostCalls.length}`,
    );
    expectErr('app:openExternal 拒绝非 URL 文本', await client.request('app:openExternal', ['不是链接']), '链接格式不正确：不是链接');
    expectErr('app:openExternal 拒绝非字符串', await client.request('app:openExternal', [42]), '链接必须是字符串。');

    // 菜单树：契约要求"主进程为唯一事实源"，W-SHELL 的 MenuBar 依赖本通道。
    const menu = expectOk('app:menu', await client.request('app:menu', []));
    check('app:menu 返回 5 个顶层分组', Array.isArray(menu) && menu.length === 5, `实际 ${menu?.length}`);
    const flatMenu = [];
    const walkMenu = (nodes) => {
      for (const node of nodes ?? []) {
        flatMenu.push(node);
        walkMenu(node.children);
      }
    };
    walkMenu(menu);
    const commandItems = flatMenu.filter((node) => node.kind === undefined && node.children === undefined);
    check(`菜单含 23 个可执行项 + 分隔线（实际 ${commandItems.length} 个可执行项）`, commandItems.length === 23);
    check(
      '菜单项形状符合 MenuNode（id/label 必有；accelerator 可选；分隔线带 kind）',
      flatMenu.every(
        (node) =>
          typeof node.id === 'string' &&
          typeof node.label === 'string' &&
          (node.kind === undefined || node.kind === 'separator' || node.kind === 'header'),
      ),
    );
    check(
      '可执行项都带 enabled（分隔线不带）',
      commandItems.every((node) => typeof node.enabled === 'boolean') &&
        flatMenu.filter((node) => node.kind === 'separator').every((node) => node.enabled === undefined),
    );
    check(
      '快捷键文本与旧菜单同源（F5 / Ctrl+R / Ctrl+Shift+R / F11 均在）',
      ['F5', 'Ctrl+R', 'Ctrl+Shift+R', 'F11'].every((keys) => flatMenu.some((node) => node.accelerator === keys)),
    );
    check(
      'app:menu 不暴露内部 command 字段（契约有意隐去）',
      flatMenu.every((node) => node.command === undefined),
    );
    check(
      'view.devtools 在非开发模式下置灰（devToolsEnabled() 与旧实现同源）',
      flatMenu.find((node) => node.id === 'view.devtools')?.enabled === false,
    );
    check(
      '窗口类命名空间存在（minimize / close）',
      flatMenu.some((node) => node.id === 'window.minimize') && flatMenu.some((node) => node.id === 'window.close'),
    );
    sample('app:menu（顶层）', menu.map((node) => `${node.id}:${node.label}(${node.children?.length ?? 0})`));

    expectErr(
      'app:menuCommand 明确由 WinUI 宿主执行（Node 无 Electron 窗口可操作）',
      await client.request('app:menuCommand', ['file.refresh']),
      (error) => typeof error === 'string' && error.includes('必须由 WinUI 宿主本地执行'),
    );

    /* ================= [12] 并发（协议 §3.4） ================= */
    section('[12] 并发：慢方法不阻塞读取（协议 §3.4）');

    client.setHost((method) => {
      if (method === 'host:pickFolder') return sleep(400).then(() => ({ ok: true, value: 'D:\\tmp\\slow' }));
      return { ok: true, value: null };
    });
    const slow = client.request('plugin:pickFolder', [], { timeoutMs: 20_000 });
    await sleep(60); // 确保慢请求已进入在途
    const fastStart = Date.now();
    const fast = await client.request('instance:list', [], { timeoutMs: 5_000 });
    const fastElapsed = Date.now() - fastStart;
    await slow;
    check(
      '慢请求在途时快速请求仍能立即返回（未被阻塞）',
      fast.ok === true && fastElapsed < 300,
      `快速请求耗时 ${fastElapsed}ms（慢请求占用 400ms）`,
    );

    const burst = await Promise.all([
      client.request('instance:list', [], { id: 'c-burst-1' }),
      client.request('engine:list', [], { id: 'c-burst-2' }),
      client.request('launcher:getConfig', [], { id: 'c-burst-3' }),
      client.request('instance:get', [INSTANCE_ID], { id: 'c-burst-4' }),
      client.request('saves:list', [INSTANCE_ID], { id: 'c-burst-5' }),
      client.request('plugin:listLocal', [INSTANCE_ID], { id: 'c-burst-6' }),
    ]);
    check(
      '6 条并发请求全部配对成功且 id 原样回传',
      burst.every((item, index) => item.id === `c-burst-${index + 1}` && item.ok === true),
      JSON.stringify(burst.map((item) => item.id)),
    );
    check('没有收到无法配对的消息', client.unexpected.length === 0, JSON.stringify(client.unexpected).slice(0, 200));

    /* ================= [13] 事件与 stdout 纯净 ================= */
    section('[13] 事件推送与 stdout 纯净（协议 §2.4 / §4）');

    const logChunks = client.events.filter((item) => item.event === 'log:chunk');
    const stateEvents = client.events.filter((item) => item.event === 'log:state');
    check(`收到 log:chunk 事件 ${logChunks.length} 条`, logChunks.length > 0);
    check(`收到 log:state 事件 ${stateEvents.length} 条`, stateEvents.length > 0);
    check(
      '事件载荷形状符合 §2.4（无 id、有 event/data）',
      client.events.every((item) => item.id === undefined && typeof item.event === 'string' && item.data !== undefined),
    );
    check(
      `log:state 载荷是完整 InstanceRuntime`,
      stateEvents.every(
        (item) =>
          typeof item.data?.instanceId === 'string' &&
          typeof item.data?.state === 'string' &&
          'pid' in item.data &&
          'url' in item.data,
      ),
    );
    check('stdout 只含协议数据（无 console.log 污染）', client.stdoutViolations.length === 0,
      client.stdoutViolations.slice(0, 2).map((line) => line.slice(0, 120)).join(' | '));

    /* ================= [14] 优雅退出 ================= */
    section('[14] __shutdown 优雅退出（协议 §3.2）');

    const shutdown = await client.request('__shutdown', [], { timeoutMs: 30_000 });
    expectOk('__shutdown 成功', shutdown);
    check('__shutdown 返回 {ok:true}（协议 §3.2）', shutdown.value?.ok === true, JSON.stringify(shutdown.value));

    const exit = await client.waitForExit(30_000);
    check('桥接进程自行退出且退出码为 0', exit.code === 0 && exit.timeout !== true, `code=${exit.code} signal=${exit.signal} timeout=${exit.timeout === true}`);
    check(
      'stderr 有启动与退出日志（人类可读，不参与协议）',
      client.stderr.includes('[bridge] 就绪') && client.stderr.includes('开始退出'),
    );
    check(
      'stderr 不含版本未知告警（版本已由构建期注入）',
      !client.stderr.includes('无法确定启动器版本'),
    );

    /* ================= [15] 隔离性 ================= */
    section('[15] 隔离性：真实启动器数据未被触碰');

    const afterLauncher = await fileSignature(realLauncherJson);
    const afterInstances = await dirSignature(realInstances);
    check(`仓库根 launcher.json 未被创建/改动（${beforeLauncher}）`, beforeLauncher === afterLauncher, `now ${afterLauncher}`);
    check(`仓库根 instances/ 未被改动（${beforeInstances}）`, beforeInstances === afterInstances, `now ${afterInstances}`);
    check('配置确实落在临时 home 内', existsSync(path.join(tmpHome, 'launcher.json')));
  } finally {
    if (!child.killed && child.exitCode === null) {
      child.kill();
      await sleep(300);
    }
    if (keepTemp) {
      console.log(`\n临时 home 保留在：${tmpResolved}`);
    } else {
      await rm(tmpResolved, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /* ================= 汇总 ================= */
  const passed = checks.length - failures;
  console.log(`\n${'='.repeat(72)}`);
  console.log(`冒烟结果：${passed}/${checks.length} 通过${failures > 0 ? `，${failures} 项失败` : '，全部通过 ✓'}`);
  if (failures > 0) {
    console.log('\n失败项：');
    for (const item of checks.filter((entry) => !entry.ok)) console.log(`  ✗ ${item.label}`);
    console.log('\nstderr（尾部 30 行）：');
    for (const line of client.stderrLines.slice(-30)) console.log(`  ${line}`);
    process.exit(1);
  }
}

/** 恢复默认宿主实现（各用例之间避免相互污染）。 */
function setHostDefault(client, tmpHome) {
  client.setHost((method) => {
    if (method === 'host:downloadsDir') return { ok: true, value: tmpHome };
    if (method === 'host:pickArchive') return { ok: true, value: path.join(tmpHome, 'fake-plugin.zip') };
    if (method === 'host:pickFolder') return { ok: true, value: path.join(tmpHome, 'fake-plugin-dir') };
    if (method === 'host:pickPackFile') return { ok: true, value: path.join(tmpHome, 'fake.whalepack.zip') };
    if (method === 'host:saveFile') return { ok: true, value: path.join(tmpHome, 'fake-export.whalepack.zip') };
    return { ok: true, value: null };
  });
}

/** 读取仓库 package.json 的版本（用于独立断言 app:version）。 */
async function readRepoVersion() {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return String(pkg.version);
}

/**
 * 用仓库自带的 adm-zip 读导出包里的元数据，断言 `launcherVersion` 是**真实版本**。
 *
 * 这是对 Lead 指出的缺陷（包元数据被写成假值 `0.0.0`）的直接回归断言：
 * 包是好包还不够，**落盘的元数据**必须是真话。
 * adm-zip 不可用时记为 SKIP（审计脚本不应因缺依赖而崩，但也不静默跳过）。
 */
async function verifyPackManifest(zipFile, expectedVersion) {
  let AdmZip;
  try {
    ({ default: AdmZip } = await import('adm-zip'));
  } catch {
    console.log('  ⚠ SKIP 包元数据校验 —— 未能从 node_modules 加载 adm-zip');
    return;
  }
  const zip = new AdmZip(zipFile);
  const manifest = JSON.parse(zip.readAsText('whalelauncher-pack.json'));
  sample('whalelauncher-pack.json', {
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    launcherVersion: manifest.launcherVersion,
    instance: manifest.instance?.name,
  });
  check('导出包的 kind / schemaVersion 正确', manifest.kind === 'whalelauncher-pack' && manifest.schemaVersion === 1);
  check(
    `导出包元数据 launcherVersion === ${expectedVersion}（不是假值）`,
    manifest.launcherVersion === expectedVersion,
    JSON.stringify(manifest.launcherVersion),
  );
  const names = zip.getEntries().map((entry) => entry.entryName);
  check('导出包内含 profile 清单与 README', names.some((name) => name.includes('package.json')) && names.includes('README.md'), JSON.stringify(names));
}

/**
 * 在临时 home 内布置 fixture：
 *  - `launcher.json` **故意写坏** → 验证"损坏→改名备份→回退默认值+提示"的自愈路径；
 *  - `package.json` 写一个**诱饵版本** → 验证 app:version 不再依赖 --home 下的文件
 *    （旧缺陷：打包后相对路径找不到仓库 package.json，版本退化成假值 0.0.0）；
 *  - 一个合法实例 + 最小可用的 profile 清单 → 让 instance / settings / saves / plugin /
 *    pack 通道能跑**真实读写**（含 adm-zip 的真实导出）。
 */
async function writeFixture(home) {
  await writeFile(path.join(home, 'launcher.json'), '{ 这不是合法 JSON', 'utf8');
  await writeFile(
    path.join(home, 'package.json'),
    `${JSON.stringify({ name: 'decoy', version: '9.9.9-decoy' }, null, 2)}\n`,
    'utf8',
  );

  const instanceRoot = path.join(home, 'instances', INSTANCE_DIR);
  const profileDir = path.join(instanceRoot, 'home', 'profiles', INSTANCE_DIR);
  await mkdir(profileDir, { recursive: true });
  const meta = {
    schemaVersion: 1,
    id: INSTANCE_ID,
    name: '冒烟实例',
    dirName: INSTANCE_DIR,
    icon: null,
    color: '#5B8DEF',
    note: '冒烟测试 fixture',
    engine: { version: ENGINE_VERSION },
    profile: { name: INSTANCE_DIR, template: 'web' },
    workspace: { mode: 'local' },
    saves: { mode: 'local' },
    settings: { mode: 'local' },
    credentials: { mode: 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: false },
    createdAt: new Date(0).toISOString(),
    lastLaunchedAt: null,
    launchCount: 0,
  };
  await writeFile(path.join(instanceRoot, 'instance.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  // 最小可用 profile 清单：导出实例包只需要它存在（core/modpack.ts L55-L58）。
  await writeFile(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: INSTANCE_DIR,
        version: '0.0.1',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        dependencies: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
}

main().catch((error) => {
  console.error('\n冒烟测试异常终止：', error);
  process.exit(1);
});
