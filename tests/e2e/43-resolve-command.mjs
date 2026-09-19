/**
 * QA 隔离：`resolveCommand` 对 Windows `.cmd` 垫片的解析与 spawn 能力。
 *
 * 背景：R5 用例里 `core.listAvailableEngines` 报
 *   `'"C:\Program Files\nodejs\npm.cmd"' is not recognized as an internal or external command`
 * 而不是实际的网络错误。需要判断这是 **core 的解析缺陷** 还是本沙箱限制。
 *
 * 运行：node tests/e2e/43-resolve-command.mjs
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot } from './_bundle.mjs';

const mod = await loadCoreBundle();
const { proc } = mod;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

const root = await makeTempRoot('resolve');
const outPath = path.join(root, 'o.txt');
const errPath = path.join(root, 'e.txt');
const readFileSafe = async (f) => {
  try {
    return await fs.readFile(f, 'utf8');
  } catch {
    return '';
  }
};

/** 用文件重定向跑一条命令（避免管道 stdio 被沙箱拒绝）。 */
const run = (file, args, opts = {}) => {
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(file, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, ...opts });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return { status: r.status, error: r.error ? `${r.error.code}: ${r.error.message.slice(0, 80)}` : null };
};

/* 1. resolveCommand 对 npm 的解析结果 */
const resolved = proc.resolveCommand('npm', ['view', 'x', '--json']);
console.log(`  [info] resolveCommand('npm', ...) → file=${JSON.stringify(resolved.file)}`);
console.log(`  [info]                              args=${JSON.stringify(resolved.args)}`);
console.log(`  [info]                              verbatim=${resolved.verbatim}`);
{
  const file = String(resolved.file).toLowerCase();
  const isCmd = file.endsWith('cmd.exe');
  const hasWrapping = resolved.args.length === 4 && resolved.args[0] === '/d' && resolved.args[1] === '/s' && resolved.args[2] === '/c';
  const commandLine = resolved.args[3] ?? '';
  // cmd.exe 规则：/c 后以引号开头的整条命令必须再用一对引号包住
  const doubleQuoted = commandLine.startsWith('""') && commandLine.endsWith('""');
  record(
    '1 resolveCommand 把 .cmd 垫片包成 cmd.exe /d /s /c ""…"" 且标记 verbatim',
    isCmd && hasWrapping && doubleQuoted && resolved.verbatim === true,
    `file=${resolved.file} 双层引号=${doubleQuoted} verbatim=${resolved.verbatim} cmdline=${JSON.stringify(commandLine.slice(0, 70))}`,
  );
}

/* 2. 用解析结果直接 spawn —— 同时覆盖管道模式与降级模式（都用同一个 ResolvedCommand） */
{
  const r = run(resolved.file, resolved.args, { windowsVerbatimArguments: resolved.verbatim === true });
  const stderr = (await readFileSafe(errPath)).trim().split('\n')[0] ?? '';
  console.log(`  [info] 直接 spawn 解析结果 → status=${r.status} error=${r.error}`);
  console.log(`  [info] stderr: ${stderr.slice(0, 160)}`);
  record(
    '2 解析结果可直接被执行（.cmd 垫片不再报 not recognized）',
    !/not recognized|command not found|ENOENT|EINVAL/i.test(stderr),
    `status=${r.status} stderr首行=${JSON.stringify(stderr.slice(0, 120))}`,
  );
}

/* 3. 对照：核心的降级路径（runWithFiles）是否也走同一套 verbatim 参数 */
{
  const procSrc = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'proc.ts'), 'utf8');
  const verbatimCount = (procSrc.match(/windowsVerbatimArguments:\s*resolved\.verbatim === true/g) ?? []).length;
  record(
    '3 四条 spawn 路径都带上了 windowsVerbatimArguments',
    verbatimCount >= 4,
    `实测命中 ${verbatimCount} 处（管道一次性 / 管道长驻 / 降级一次性 / 降级长驻 应为 4 处）`,
  );
}

/* 4. 真实 npm 端到端：用降级路径同款调用形态跑通 npm */
{
  const realNpm = 'C:\\Program Files\\nodejs\\npm.cmd';
  const exists = await fs.access(realNpm).then(() => true, () => false);
  if (!exists) {
    console.log('  SKIP  本机无 npm.cmd，跳过真实 npm 端到端');
  } else {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    const inner = `"${realNpm}" "--version"`;
    const r = run(comspec, ['/d', '/s', '/c', `"${inner}"`], { windowsVerbatimArguments: true });
    const out = (await readFileSafe(outPath)).trim();
    const err = (await readFileSafe(errPath)).trim();
    console.log(`  [info] npm --version → status=${r.status} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err.slice(0, 80))}`);
    record(
      '4 真实 npm 经 cmd.exe 包装可执行（输出 npm 版本号）',
      /^\d+\.\d+\.\d+/.test(out),
      `stdout=${JSON.stringify(out || err.slice(0, 100))}`,
    );
  }
}

console.log('\n=== resolveCommand 隔离 汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
