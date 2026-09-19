/**
 * QA 隔离续：cmd.exe 调用形态矩阵 —— 找出为什么
 * `cmd.exe /d /s /c "<带空格的 .cmd 路径>" args` 在 Node 的 spawnSync 下会失败。
 *
 * 运行：node tests/e2e/44-cmd-invocation-matrix.mjs
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempRoot } from './_bundle.mjs';

const root = await makeTempRoot('cmdmatrix');
const npmCmd = 'C:\\Program Files\\nodejs\\npm.cmd';
const comspec = process.env.ComSpec ?? 'cmd.exe';

const readSafe = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

const probe = (label, file, args, opts = {}) => {
  const slug = label.replace(/\W/g, '').slice(0, 12);
  const outPath = path.join(root, `o-${slug}.txt`);
  const errPath = path.join(root, `e-${slug}.txt`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(file, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, ...opts });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const err = readSafe(errPath).trim();
  const out = readSafe(outPath).trim();
  const bad = /not recognized|command not found|ENOENT|EINVAL/i.test(err);
  console.log(`  ${String(r.status).padStart(4)}  ${bad ? '✗' : '✓'}  ${label}`);
  if (out) console.log(`         stdout: ${out.split('\n')[0].slice(0, 110)}`);
  if (err) console.log(`         stderr: ${err.split('\n')[0].slice(0, 140)}`);
  return { status: r.status, bad, err };
};

console.log('[cmd.exe 调用形态矩阵]（npm view x 必然失败，这里只看"命令是否被识别"）');

// A: core 当前形态 —— args 数组里一个已加引号的完整命令行
probe('A  core 现状: cmd /d /s /c "\\"npm.cmd\\" args"',
  comspec, ['/d', '/s', '/c', `"${npmCmd}" "view" "x"`]);
// B: 整体再加一层引号（cmd /c 经典转义法）
probe('B  外层再包一层引号',
  comspec, ['/d', '/s', '/c', `""${npmCmd}" "view" "x""`]);
// C: 整个命令行不加引号
probe('C  不加引号（路径含空格）',
  comspec, ['/d', '/s', '/c', `${npmCmd} view x`]);
// D: call 前缀
probe('D  call 前缀',
  comspec, ['/d', '/s', '/c', `call "${npmCmd}" "view" "x"`]);
// E: shell:true 让 Node 自己拼
{
  const slug = 'E';
  const outPath = path.join(root, `o-${slug}.txt`);
  const errPath = path.join(root, `e-${slug}.txt`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(`"${npmCmd}" view x`, { stdio: ['ignore', outFd, errFd], shell: true, windowsHide: true });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const err = readSafe(errPath).trim();
  const bad = /not recognized|command not found/i.test(err);
  console.log(`  ${String(r.status).padStart(4)}  ${bad ? '✗' : '✓'}  E  shell:true（字符串命令）`);
  if (err) console.log(`         stderr: ${err.split('\n')[0].slice(0, 140)}`);
}
// F: 直接 spawn .cmd（Node 20+ 需 shell:true）
probe('F  直接 spawn npm.cmd（无 cmd 包装）', npmCmd, ['view', 'x']);
// G: node + npm-cli.js（真实 JS 入口，避开垫片）
const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
probe('G  node + npm-cli.js（真实 JS 入口）', process.execPath, [npmCli, 'view', 'x']);
