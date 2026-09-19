/**
 * tests/core 顺序运行器
 *
 * 逐个用 `node <file>` 跑测试文件并汇总退出码。
 *
 * 为什么不用 `node --test`：本机沙箱禁止创建命名管道，`node --test` 默认会为每个
 * 测试文件 spawn 子进程并接管其 stdio 管道 → `spawn EPERM`。这里用
 * `stdio: 'inherit'`（沙箱允许）串行执行，既避免管道又保留每个文件独立的退出码。
 *
 * 用法：
 *   node tests/core/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 测试文件按名称排序，保证输出稳定。 */
const files = (await fs.readdir(HERE))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

let failed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(HERE, name)], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`\n[run-all] ${name} 失败（退出码 ${String(result.status)}）\n`);
  }
}

process.stdout.write(`\n[run-all] ${files.length - failed}/${files.length} 个测试文件通过\n`);
process.exitCode = failed === 0 ? 0 : 1;
