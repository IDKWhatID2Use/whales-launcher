/**
 * QA 端到端测试基础设施：把 `src/core/**` 用 esbuild 打成 ESM 单文件，供 node 直接运行。
 *
 * 为什么需要它（与 T1 的 `tests/core/_helpers.mjs` 走不同路线）：
 *  - 本机 `npm test` 使用 `node --test`，runner 会为每个测试文件 spawn 一个带**管道**
 *    stdio 的子进程；受管沙箱直接返回 `EPERM`，实测 8/8 文件全部 `spawn EPERM` 失败。
 *  - 退一步直接 `node tests/core/names.test.mjs` 也不行：Node 26 的类型擦除是
 *    "strip-only"，而 `src/core/proc.ts` 的 `FileTail` 用了**参数属性**
 *    （`constructor(private readonly paths: ...)`），strip-only 模式报
 *    `TypeScript parameter property is not supported in strip-only mode`。
 *  - esbuild 打包同时解决两件事：进程内 `import()` 即可加载，且顺带验证 esbuild
 *    能解析 core 的全部语法/依赖（T2 的构建链就在用 esbuild）。
 *
 * 产物放在 `.spike/qa-build/`（工作区内，已 gitignore/tsconfig 排除），**绝不写 src/**。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** QA 构建产物目录。 */
export const QA_BUILD_DIR = path.join(REPO_ROOT, '.spike', 'qa-build');

/** 定位 esbuild 可执行文件（与 scripts/build.mjs 同策略）。 */
function resolveEsbuild() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    path.join(REPO_ROOT, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'),
    path.join(REPO_ROOT, 'node_modules', '.bin', 'esbuild.cmd'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('找不到 esbuild 可执行文件，无法构建 QA 测试桩');
}

/**
 * 打包一个入口为 ESM 单文件。
 * @param {string} entry 相对仓库根的入口路径。
 * @param {string} outName 产物文件名。
 * @returns {Promise<string>} 产物绝对路径。
 */
export function bundleEntry(entry, outName) {
  const outfile = path.join(QA_BUILD_DIR, outName);
  const result = spawnSync(
    resolveEsbuild(),
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--packages=external',
      `--outfile=${outfile}`,
    ],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`esbuild 失败（${entry}），退出码 ${result.status}`);
  return outfile;
}

/**
 * 打包并加载 core 入口。
 *
 * 只打一次（进程内缓存），后续用例复用同一个模块实例 —— 这与真实 main 进程
 * "单例 in-process 状态"的语义一致（`runtime.ts` 的登记表是进程内单例）。
 * @returns {Promise<typeof import('../../src/core/index.ts')>} core 模块。
 */
let coreModulePromise;
export function loadCoreBundle() {
  if (coreModulePromise === undefined) {
    coreModulePromise = (async () => {
      await mkdir(QA_BUILD_DIR, { recursive: true });
      const outfile = bundleEntry('src/core/index.ts', 'core.mjs');
      return import(pathToFileURL(outfile).href);
    })();
  }
  return coreModulePromise;
}

/**
 * 在 `.spike/qa-*` 下创建独立临时启动器根目录。
 * @param {string} label 标签。
 * @returns {Promise<string>} 绝对路径。
 */
export async function makeTempRoot(label) {
  const { mkdtemp } = await import('node:fs/promises');
  const base = path.join(REPO_ROOT, '.spike');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `qa-${label}-`));
}

/** 递归删除临时目录。 */
export async function cleanup(dir) {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}

/** 小睡。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件。 */
export async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}
