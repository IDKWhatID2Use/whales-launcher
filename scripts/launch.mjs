/**
 * WhalesLauncher 直接启动脚本 —— 供根目录的 `启动 WhalesLauncher.bat` /
 * `WhalesLauncher.vbs`（静默）以及 `npm run launch` 调用。
 *
 * 它解决的正是「双击就能用」这件事，所以把三件容易出错的活儿包在里面：
 *
 *   1. **环境自检**：node_modules/electron/dist/electron.exe 是否到位。
 *      缺失时只尝试本机的离线修复（scripts/setup-electron.mjs），绝不联网；
 *      修复不了就给出**可照抄**的命令，而不是丢一句失败。
 *   2. **按需构建**：对比 `src/**` 与构建产物的 mtime。产物齐全且比源码新
 *      就直接启动（双击即开，不浪费十秒）；否则先跑 `scripts/build.mjs`
 *      （它自带 tsc 门禁与 dist.tmp 原子替换，失败不会摧毁上一份好产物）。
 *   3. **可诊断的启动**：Electron 的 stdout/stderr 直通调用方；退出码原样
 *      透传，并用 `--log-file` 让 Electron 自己写一份日志，失败时把路径打出来。
 *
 * 用法：
 *   node scripts/launch.mjs [--rebuild] [--skip-build] [--quiet] [--log=<文件>] [-- <给 electron 的参数>]
 *
 * 为什么不让 .bat 自己判断这些：批处理的中文与引号处理极其脆弱（代码页、
 * 路径含空格、`%ERRORLEVEL%` 展开时机），而这套逻辑需要在 .bat / .vbs /
 * npm 三个入口下行为一致 —— 只有放在 Node 里才能做到一份实现、三处共用。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

/** `--flag` 与 `--flag=值` 两种写法都接受。 */
function option(name) {
  const prefix = `${name}=`;
  const hit = argv.find((item) => item.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/** `--` 之后的参数原样转发给 Electron（例如 `-- --inspect`）。 */
const passthrough = (() => {
  const index = argv.indexOf('--');
  return index === -1 ? [] : argv.slice(index + 1);
})();

/** 保留的启动日志份数（超出按 mtime 删最旧）。 */
const KEEP_LOGS = 5;

const quiet = flag('--quiet');
const forceRebuild = flag('--rebuild');
const skipBuild = flag('--skip-build');
const dryRun = flag('--dry-run');
/** 本次启动的「构建决策」与「环境提示」，会写进汇总结论（见 finalizeSummary）。 */
let buildDecision = '未评估';
const envNotices = [];

if (flag('--help') || flag('-h')) {
  // 帮助文本放在这里而不是 .bat 里：批处理里的中文会被 codespace 撕碎
  // （见 `启动 WhalesLauncher.bat` 顶部的说明），Node 这边没有这个顾虑。
  console.log(`
WhalesLauncher 直接启动

用法：
  启动 WhalesLauncher.bat [选项]        ← 双击即用（无选项）
  WhalesLauncher.vbs                    ← 静默启动（桌面快捷方式指向它）
  npm run launch -- [选项]

选项：
  （无）          构建产物过期时自动构建，然后启动
  --rebuild      强制重新构建后再启动
  --skip-build   直接用现有 dist\\ 启动，不检查、不构建
  --dry-run      只做环境自检与构建判定，不启动 Electron
  --quiet        静默模式（输出仍写入 --log 指定的日志文件）
  --log=<文件>   指定日志文件（快捷方式用的就是它）
  -- <参数>      其余参数原样转发给 Electron
  --help, -h     显示这段说明

日志：
  排查先看 logs\\launcher-summary.log —— 每次启动覆盖，一屏给出结论；
  Electron 日志写 logs\\launcher-<时间戳>.log，保留最近 ${KEEP_LOGS} 份；
  --log 指定固定路径时，上一份会归档到 logs\\history\\；
  快捷方式入口另留 logs\\launcher-console-<时间戳>.log（只兜 node 没跑起来的情况）。

常见故障：
  构建失败       先跑 npm run typecheck 看类型错误；旧产物仍可用 --skip-build 启动
  启动一闪而过   已有启动器在运行时，新进程会把它的窗口切到前台后退出（正常行为）
  窗口开不出来   终端受限（沙箱禁止命名管道与 mojo IPC）时请在普通终端中启动
`);
  process.exit(0);
}

const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const distDir = path.join(root, 'dist');
const logsDir = path.join(root, 'logs');
const buildScript = path.join(root, 'scripts', 'build.mjs');
const setupScript = path.join(root, 'scripts', 'setup-electron.mjs');

/** 构建产物清单 —— 与 build.mjs 的必需产物一致，缺一即视为未构建。 */
const REQUIRED_ARTIFACTS = [
  path.join('main', 'index.cjs'),
  path.join('preload', 'index.cjs'),
  path.join('renderer', 'index.html'),
  path.join('renderer', 'index.js'),
];

function say(message) {
  if (!quiet) console.log(message);
}

function warn(message) {
  // 警告即使在 --quiet 下也要进日志（VBS 静默启动时只能靠文件）。
  console.log(message);
}

function die(message, hints = []) {
  console.error(`\n[启动] ${message}`);
  for (const hint of hints) console.error(`       ${hint}`);
  console.error('');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. 环境自检
 * ------------------------------------------------------------------ */

if (!existsSync(electronExe)) {
  say('[启动] 未找到 Electron 运行时二进制，尝试用本机缓存离线修复…');
  envNotices.push('Electron 运行时二进制缺失，曾尝试用本机缓存离线修复');
  if (!existsSync(setupScript)) {
    die('scripts/setup-electron.mjs 不存在，无法自动修复。', [
      '请在项目根目录执行：npm install',
    ]);
  }
  const repaired = spawnSync(process.execPath, [setupScript], {
    cwd: root,
    stdio: 'inherit',
  });
  if (repaired.status !== 0 || !existsSync(electronExe)) {
    die('Electron 运行时不可用，启动中止。', [
      '修复命令（在项目根目录执行）：',
      '  $env:npm_config_cache="F:\\WhalesLauncher\\.npm-cache"',
      '  npm install --cache "F:\\WhalesLauncher\\.npm-cache"',
      '  npm run setup:electron',
    ]);
  }
  say('[启动] Electron 运行时已修复 ✓');
}

/* ------------------------------------------------------------------ *
 * 2. 按需构建
 * ------------------------------------------------------------------ */

/** 递归取目录下所有文件的 mtime 最大值（不跟随符号链接目录）。 */
function newestMtime(dir, filter) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter !== undefined && !filter(full)) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        /* 单个文件读不到不影响整体判断 */
      }
    }
  }
  return newest;
}

/** 构建输入：只有这些变了才需要重建（`.md` 等文档不参与）。 */
const SOURCE_EXTENSIONS = new Set(['.ts', '.css', '.html', '.mjs', '.json']);

function buildInputMtime() {
  let newest = newestMtime(
    path.join(root, 'src'),
    (file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  // 一律拼 root 再 stat：早先写成相对路径，靠"调用方 cwd 恰好是项目根"才成立 ——
  // 从别处调用（或将来改 cwd）就会静默漏掉 package.json 的改动。
  for (const extra of ['package.json', 'tsconfig.json']) {
    const file = path.join(root, extra);
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  if (existsSync(buildScript)) {
    const mtime = statSync(buildScript).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * 产物时间戳 = 四件必需产物里**最新**的一个。
 *
 * 为什么取最大而不是最小：`dist/renderer/index.html` 是 `cp` 复制过去的静态资源，
 * 它的 mtime 是 **src 里那个文件的 mtime**，永远比构建时刻旧（本机实测：构建在
 * 17:32 完成，而它的 mtime 停在 16:34）。若用最小 mtime 当"构建时刻"，每次启动
 * 都会误判为过期、白跑一次构建 —— 这个 bug 是首次实测时抓到的。
 */
function distMtime() {
  const stamps = REQUIRED_ARTIFACTS.map((rel) => path.join(distDir, rel)).map((file) => {
    if (!existsSync(file)) return -1;
    return statSync(file).mtimeMs;
  });
  if (stamps.includes(-1)) return -1; // 产物不全 → 必须构建
  return Math.max(...stamps);
}

/**
 * 判定是否需要构建。
 *
 * 容差 2 秒：文件系统 mtime 精度有限（构建时能看到 .2ms 的零头），同一秒内完成的
 * 编辑 + 构建不该被判成"过期"。超过 2 秒的源码改动则一定重建 —— 宁可多构建一次，
 * 也不能让用户对着旧界面猜为什么改动没生效。
 */
const STALENESS_TOLERANCE_MS = 2000;

function needsBuild() {
  if (forceRebuild) return '已指定 --rebuild';
  const dist = distMtime();
  if (dist === -1) return '构建产物缺失或不完整';
  const newestSource = buildInputMtime();
  if (newestSource > dist + STALENESS_TOLERANCE_MS) return '源码比构建产物更新';
  return null;
}

if (!skipBuild) {
  const reason = needsBuild();
  if (reason === null) {
    buildDecision = '跳过（产物已是最新）';
    say('[启动] 构建产物已是最新，跳过构建 ✓');
  } else {
    buildDecision = `构建（${reason}）`;
    say(`[启动] 需要构建（${reason}）…`);
    const built = spawnSync(process.execPath, [buildScript], {
      cwd: root,
      stdio: 'inherit',
    });
    if (built.status !== 0) {
      die(`构建失败（退出码 ${built.status}），未启动。`, [
        '上一份可用产物未被破坏，可先用 --skip-build 启动旧产物：',
        '  启动 WhalesLauncher.bat --skip-build',
        '查看完整类型错误：',
        '  npm run typecheck',
      ]);
    }
    say('[启动] 构建完成 ✓');
  }
} else {
  const dist = distMtime();
  if (dist === -1) {
    die('--skip-build 已指定，但构建产物缺失或不完整。', [
      '先构建一次：启动 WhalesLauncher.bat --rebuild',
    ]);
  }
  buildDecision = '跳过（--skip-build）';
  say('[启动] 已跳过构建（--skip-build）');
}

/* ------------------------------------------------------------------ *
 * 3. 启动 Electron
 * ------------------------------------------------------------------ */

/**
 * 日志文件的准备工作。
 *
 * 两种入口两种策略：
 *  - 快捷方式（`WhalesLauncher.vbs`，无窗口）：`--log=logs\launcher-shortcut.log`
 *    是**固定路径**，每次启动覆盖。旧的那份先改名归档到 `logs\history\`，
 *    保留最近 KEEP_LOGS 份 —— 覆盖前先留证据，才能事后追查上一次为什么失败。
 *  - 其余入口（.bat / npm）：每次启动一份时间戳日志，超过 KEEP_LOGS 份删最旧。
 */
function prepareLogFile() {
  const explicit = option('--log');
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    return explicit === null ? null : path.resolve(explicit);
  }

  if (explicit !== null) {
    const target = path.resolve(explicit);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(target)) {
        const historyDir = path.join(logsDir, 'history');
        mkdirSync(historyDir, { recursive: true });
        const stamp = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const tag = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
          stamp.getHours(),
        )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
        renameSync(target, path.join(historyDir, `${path.basename(target, '.log')}-${tag}.log`));
        const archived = readdirSync(historyDir)
          .filter((name) => name.endsWith('.log'))
          .map((name) => ({ name, mtime: statSync(path.join(historyDir, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(KEEP_LOGS);
        for (const entry of archived) rmSync(path.join(historyDir, entry.name), { force: true });
      }
    } catch {
      /* 归档失败不影响本次启动，继续覆盖写 */
    }
    return target;
  }

  try {
    const stamp = /^launcher-(\d{8}-\d{6})\.log$/;
    const old = readdirSync(logsDir)
      .filter((name) => stamp.test(name))
      .map((name) => ({ name, mtime: statSync(path.join(logsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(KEEP_LOGS - 1);
    for (const entry of old) rmSync(path.join(logsDir, entry.name), { force: true });
  } catch {
    /* 轮转失败不阻断启动 */
  }
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const name = `launcher-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.log`;
  return path.join(logsDir, name);
}

const logFile = prepareLogFile();
/**
 * 汇总结论文件的路径（与 Electron 自己那份日志区分开）。
 * 每次启动覆盖写，见 `finalizeSummary()`。
 */
const summaryFile = path.join(logsDir, 'launcher-summary.log');

/**
 * 无窗口启动时（VBS 里 `>` 只重定向了 cmd 自身的输出），主进程的 stdout 还得
 * 自己接管：`--quiet` + `--log` 组合下把 stdout 直接接到日志文件，否则
 * 「启动器打不开」时用户手上什么线索都没有。
 */
const consoleLogStream =
  quiet && logFile !== null
    ? (() => {
        try {
          return openSync(logFile, 'a');
        } catch {
          return null;
        }
      })()
    : null;

const electronArgs = [root];
if (logFile !== null) electronArgs.push('--enable-logging=file', `--log-file=${logFile}`);
electronArgs.push(...passthrough);

if (dryRun) {
  // 只验证「环境自检 + 构建判定」这两段，不真的拉窗口。
  // 用于在受限环境（沙箱禁止 Chromium 需要的命名管道）里检验启动链路本身。
  say('[启动] --dry-run：已完成自检与构建判定，不再启动 Electron。');
  say(`[启动] 将要执行的命令：node_modules\\electron\\dist\\electron.exe ${electronArgs.join(' ')}`);
  process.exit(0);
}

say(`[启动] Electron ${path.relative(root, electronExe)} → ${root}`);
if (logFile !== null) say(`[启动] 日志：${path.relative(root, logFile)}`);
say('[启动] 关闭启动器窗口即退出（控制台窗口会随之关闭）');

const child = spawn(electronExe, electronArgs, {
  cwd: root,
  // 无窗口模式（VBS）下 stdout 已经没有去处，接进日志文件当兜底；有窗口时保持直通，
  // 让用户实时看到日志。注意 **Electron 自己会重新初始化 stdout**，所以继承的 fd
  // 往往收不到主进程的 console 输出 —— 真正可靠的那份结论由 finalizeSummary() 写。
  stdio: consoleLogStream === null ? 'inherit' : ['inherit', consoleLogStream, consoleLogStream],
  windowsHide: false,
});

child.on('error', (error) => {
  die(`无法启动 Electron：${error.message}`, [
    '若为「拒绝访问」，说明当前终端受限（沙箱禁止命名管道与 mojo IPC）——',
    '请在普通（非沙箱）终端中重试。',
  ]);
});

/** Ctrl+C 等信号下让 Electron 自己走 shutdown（它会先停掉运行中的实例）。 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal !== null) {
    // 被外部强杀（含本脚本收到信号后的转发）：不算失败，原样返回。
    process.exit(0);
  }

  const logTail = readLogTail(logFile);

  // 单实例锁优先判定：既有窗口已经被激活到前台，这次进程秒退**不是失败**。
  // 为什么不能只看退出码：实测本机（受限终端）第二实例在退出途中还会撞上
  // Chromium 的 mojo 致命错误，于是"已经跑起来了"这件事会带着非零退出码回来。
  // 拿退出码当唯一判据，就会把一次成功的「切到前台」报成崩溃。
  if (logTail.includes('已有 WhalesLauncher 实例在运行')) {
    const text = '已经有 WhalesLauncher 在运行，已把它的窗口切到前台（本次不再开新窗口）。';
    say(`[启动] ${text}`);
    finalizeSummary({ verdict: '已切到前台（单实例）', text });
    if (logFile !== null) say(`[启动] 本次日志：${path.relative(root, logFile)}`);
    process.exit(0);
  }

  if (code === 0) {
    say('[启动] 启动器已退出。');
    finalizeSummary({ verdict: '正常退出（退出码 0）', text: '启动器窗口已由用户关闭。' });
    if (logFile !== null) warn(`[启动] 本次日志：${path.relative(root, logFile)}`);
    process.exit(0);
  }

  warn('');
  warn(`[启动] Electron 异常退出，退出码 ${code}。`);
  if (logFile !== null) warn(`[启动] 日志：${path.relative(root, logFile)}`);
  if (logTail.length > 0) {
    warn('------- 日志末尾 -------');
    for (const line of logTail.split(/\r?\n/).slice(-12)) {
      if (line.trim().length > 0) warn(`  ${line}`);
    }
    warn('------------------------');
  }
  warn('常见原因：当前终端受限（沙箱禁止命名管道与 mojo IPC），');
  warn('          或 Electron 运行时二进制与系统不匹配。');
  warn('');
  finalizeSummary({
    verdict: `异常退出（退出码 ${code}）`,
    text: [
      'Chromium 没能起来。最常见的原因是启动它的终端受限：',
      'Chromium 需要命名管道与 mojo IPC，受限终端会拒绝（日志里通常是',
      '"platform_channel.cc ... 拒绝访问" 或 "Lock file can not be created"）。',
      '换一个普通终端再试；仍失败时把本文件与 launcher-*.log 一起提供。',
    ].join('\n'),
    tail: logTail,
  });
  process.exit(code);
});

/**
 * 写一份**人读得懂**的汇总结论：每次启动覆盖 `logs/launcher-summary.log`。
 *
 * 为什么不能只靠 Electron 那份日志：实测 Electron 会**重新初始化自己的 stdout**，
 * 父进程继承过去的 fd 收不到主进程的 console 输出（用最小脚本验证过：同样的
 * stdio 接线下，普通 node 子进程能写进去，Electron 不能）。于是「双击快捷方式没反应」
 * 时，用户手上会只剩 Chromium 那一两行英文错误，看不到构建决策与处置建议。
 * 这份文件补的就是这段：结论 + 构建决策 + 命令 + 日志尾。
 */
function finalizeSummary({ verdict, text, tail = '' }) {
  const lines = [
    '=== WhalesLauncher 启动汇总结论 ===',
    `时间   ：${new Date().toLocaleString()}`,
    `入口   ：${quiet ? '静默（快捷方式 / --quiet）' : '控制台'}`,
    `项目根 ：${root}`,
    `构建   ：${buildDecision}`,
    ...(envNotices.length > 0 ? [`环境   ：${envNotices.join('；')}`] : []),
    `命令   ："${electronExe}" ${electronArgs.join(' ')}`,
    `结果   ：${verdict}`,
    '',
    text,
  ];
  if (tail.trim().length > 0) {
    lines.push('', '--- Electron 日志末尾 ---', tail.trimEnd());
  }
  lines.push(
    '',
    `Electron 完整日志：${logFile === null ? '(未启用)' : path.relative(root, logFile)}`,
    '',
  );
  try {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(summaryFile, lines.join('\n'), 'utf8');
  } catch {
    /* 写不进去也不能影响退出码 */
  }
}

/** 取日志末尾（最多 4KB）用于失败诊断；读不到就返回空串。 */
function readLogTail(file) {
  if (file === null) return '';
  try {
    const size = statSync(file).size;
    if (size === 0) return '';
    const start = Math.max(0, size - 4096);
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}
