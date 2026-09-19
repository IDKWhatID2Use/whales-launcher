/**
 * QA 端到端用例总入口。
 *
 * 为什么不用 `node --test`：本环境禁止带管道 stdio 的 spawn，`node --test` 的 runner
 * 为每个测试文件 spawn 子进程时直接 EPERM（详见 docs/review/acceptance.md §证据）。
 * 这里改为**进程内依次 import** 每个用例文件：不 spawn、无管道，退出码汇总。
 *
 * 计数方式：拦截 console.log，统计每个用例文件打印的 `PASS` / `FAIL` / `SKIP` 标记行。
 * 判定方式：任一用例出现 `FAIL` 标记行，或抛未捕获异常 → 整体退出码 1。
 *
 * 运行：node tests/e2e/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * 用例执行方式分两类：
 *  - `inline`：由本文件直接 import（进程内跑）
 *  - `child` ：必须独立进程跑（会启动长驻子进程的用例）；输出走文件重定向
 */
const SUITES = [
  { file: '00-smoke.mjs', mode: 'inline', label: 'core 契约方法覆盖' },
  { file: '10-data-safety.mjs', mode: 'inline', label: '数据安全' },
  { file: '11-repro-settings-clobber.mjs', mode: 'inline', label: 'P1 最小复现（settings 覆盖）' },
  { file: '20-contract-and-dsh.mjs', mode: 'inline', label: '契约一致性 + 真实 dsh 行为' },
  { file: '30-robustness.mjs', mode: 'inline', label: '健壮性 / 性能 / 安全' },
  { file: '40-core-deep.mjs', mode: 'inline', label: 'core 深度审查' },
  { file: '41-core-perf-log.mjs', mode: 'inline', label: '真实尺度性能 / 日志增长' },
  { file: '42-config-heal.mjs', mode: 'inline', label: '配置自愈 / 实例消失根因' },
  { file: '43-resolve-command.mjs', mode: 'inline', label: '.cmd 垫片解析隔离' },
  { file: '44-cmd-invocation-matrix.mjs', mode: 'inline', label: 'cmd.exe 调用形态矩阵' },
  { file: '50-status-recheck.mjs', mode: 'inline', label: '逐项修复状态核对' },
  { file: '51-registry-review.mjs', mode: 'inline', label: 'registry.json 设计独立评估' },
  { file: '32-stop-verify.mjs', mode: 'inline', label: 'stopInstance 实杀验证' },
  { file: '52-broken-record-cleanup.mjs', mode: 'inline', label: '坏记录可见性与清理' },
  { file: '31-stop-probe.mjs', mode: 'child', label: '沙箱限制证据：taskkill 被拒' },
];

/** 统计器：拦截 console.log 读取用例标记行。 */
const counter = { pass: 0, fail: 0, skip: 0 };
const originalLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  if (/^\s*PASS\s/.test(line)) counter.pass += 1;
  else if (/^\s*FAIL\s/.test(line)) counter.fail += 1;
  else if (/^\s*SKIP\s/.test(line)) counter.skip += 1;
  originalLog(...args);
};

const resetCounter = () => {
  const snapshot = { ...counter };
  counter.pass = 0;
  counter.fail = 0;
  counter.skip = 0;
  return snapshot;
};

const rows = [];
let anyFailure = false;

for (const suite of SUITES) {
  const file = path.join(HERE, suite.file);
  originalLog(`\n${'='.repeat(74)}\n▶ ${suite.label}  (${suite.file})\n${'='.repeat(74)}`);
  if (!existsSync(file)) {
    originalLog('  [run-all] 文件缺失');
    rows.push({ label: suite.label, status: '文件缺失', pass: 0, fail: 0, skip: 0 });
    anyFailure = true;
    continue;
  }

  if (suite.mode === 'child') {
    const outPath = path.join(REPO_ROOT, '.spike', `qa-run-${suite.file}.out`);
    const errPath = path.join(REPO_ROOT, '.spike', `qa-run-${suite.file}.err`);
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [file], {
        cwd: REPO_ROOT,
        stdio: ['ignore', outFd, errFd],
        timeout: 300000,
        windowsHide: true,
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    const text = readFileSync(outPath, 'utf8');
    process.stdout.write(text);
    const counts = {
      pass: (text.match(/^\s*PASS\s/gm) ?? []).length,
      fail: (text.match(/^\s*FAIL\s/gm) ?? []).length,
      skip: (text.match(/^\s*SKIP\s/gm) ?? []).length,
    };
    rows.push({ label: suite.label, status: result.status === 0 ? 'OK' : `exit=${result.status}`, ...counts });
    continue;
  }

  // inline：重置计数 → import → 收集结果
  resetCounter();
  let threw = null;
  try {
    await import(`${new URL(`./${suite.file}`, import.meta.url).href}?qa=${Date.now()}`);
  } catch (error) {
    threw = error;
    originalLog(`  [run-all] 用例文件抛异常：${error?.stack ?? error}`);
  }
  const counts = resetCounter();
  const failed = counts.fail > 0 || threw !== null;
  if (failed) anyFailure = true;
  rows.push({
    label: suite.label,
    status: threw !== null ? '异常' : counts.fail > 0 ? `${counts.fail} 例失败` : 'OK',
    ...counts,
  });
}

originalLog(`\n${'='.repeat(74)}\n汇总\n${'='.repeat(74)}`);
originalLog('  状态'.padEnd(14) + 'PASS'.padStart(6) + 'FAIL'.padStart(7) + 'SKIP'.padStart(7) + '   用例集');
let sumPass = 0;
let sumFail = 0;
let sumSkip = 0;
for (const row of rows) {
  sumPass += row.pass;
  sumFail += row.fail;
  sumSkip += row.skip;
  originalLog(
    `  ${row.status.padEnd(12)}${String(row.pass).padStart(6)}${String(row.fail).padStart(7)}${String(row.skip).padStart(7)}   ${row.label}`,
  );
}
originalLog(`  ${'合计'.padEnd(12)}${String(sumPass).padStart(6)}${String(sumFail).padStart(7)}${String(sumSkip).padStart(7)}`);
originalLog(
  anyFailure
    ? '\n结果：**不通过** —— 存在 FAIL 用例，逐条见上方输出与 docs/review/code-review.md'
    : '\n结果：全部通过',
);
process.exitCode = anyFailure ? 1 : 0;
