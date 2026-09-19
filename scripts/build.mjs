/**
 * WhalesLauncher 构建脚本。
 *
 * 为什么用 esbuild **CLI 子进程**而不是 esbuild 的 JS API：
 *   esbuild 的 JS API 会启动一个长驻子进程并用**管道**与它通信。在受限沙箱
 *   环境里（例如本机 DSH 的文件沙箱）带管道 stdio 的 spawn 会被拒绝
 *   （EPERM），导致 `npm run build` 在该环境下必然失败。改用 CLI 子进程并
 *   走 `stdio: 'inherit'`，既避开这一限制，在普通环境下行为也完全一致。
 *
 * 为什么构建到暂存目录再整体替换（原子构建）：
 *   早期版本是「先 rm -rf dist 再构建」。结果是**一次失败的构建会把上一份
 *   可用产物一起摧毁** —— 实测发生过：core 处于编辑中间态时构建失败，dist
 *   被清空，应用在修复完成前无法启动。现在改为：
 *     构建到 dist.tmp/ → 全部成功 → 原子替换 dist/ → 失败则保留旧 dist 不动。
 *
 * 三个产物：
 *   src/main/index.ts     → dist/main/index.cjs     （Electron 主进程，CJS）
 *   src/preload/index.ts  → dist/preload/index.cjs  （预加载脚本，CJS）
 *   src/renderer/index.ts → dist/renderer/index.js  （界面，IIFE：
 *                            file:// 协议下 ESM 会被 CORS 拦截）
 *
 * 另把 renderer 的静态资源（html/css/图片）原样复制到 dist/renderer。
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** 最终产物目录。 */
const outDir = path.join(root, 'dist');
/** 暂存目录：全部构建成功后才会替换 dist，避免失败构建摧毁好产物。 */
const stageDir = path.join(root, 'dist.tmp');
const stageRel = 'dist.tmp';

/** 定位 esbuild 可执行文件：优先平台专用二进制，其次 .bin 下的 shim。 */
function resolveEsbuild() {
  const candidates = [
    path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    path.join(root, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'),
    path.join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
    path.join(root, 'node_modules', '@esbuild', 'darwin-x64', 'bin', 'esbuild'),
    path.join(root, 'node_modules', '.bin', 'esbuild.cmd'),
    path.join(root, 'node_modules', '.bin', 'esbuild'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error('[build] 未找到 esbuild 可执行文件。请先运行：');
  console.error('        $env:npm_config_cache="F:\\WhalesLauncher\\.npm-cache"');
  console.error('        npm install --cache "F:\\WhalesLauncher\\.npm-cache"');
  process.exit(1);
}

const esbuild = resolveEsbuild();

const targets = [
  {
    label: 'main',
    args: [
      'src/main/index.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--external:electron',
      '--sourcemap',
      `--outfile=${stageRel}/main/index.cjs`,
    ],
  },
  {
    label: 'preload',
    args: [
      'src/preload/index.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--external:electron',
      '--sourcemap',
      `--outfile=${stageRel}/preload/index.cjs`,
    ],
  },
  {
    label: 'renderer',
    args: [
      'src/renderer/index.ts',
      '--bundle',
      '--platform=browser',
      '--format=iife',
      '--target=chrome130',
      '--sourcemap',
      `--outfile=${stageRel}/renderer/index.js`,
    ],
  },
];

/** 递归复制 renderer 静态资源（跳过 TypeScript、sourcemap 与开发文档）。 */
async function copyStatic(from, to) {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await copyStatic(src, dst);
    } else if (
      !entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.map') &&
      // Markdown 是开发文档（如 PREVIEW.md 的核对清单与偏离登记表），
      // 不应随运行产物分发 —— 产物里只该有界面真正加载的资源。
      !entry.name.endsWith('.md')
    ) {
      await cp(src, dst);
    }
  }
}

/**
 * 运行一次 esbuild。`stdio: 'inherit'` 是关键：它让子进程直接继承本进程的
 * 标准流，不使用管道，因而在受限沙箱中也能工作。
 */
function runEsbuild(target, extraArgs) {
  const args = extraArgs === undefined ? target.args : [...target.args, ...extraArgs];
  const result = spawnSync(esbuild, args, { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined && result.error !== null) {
    console.error(`[build] ${target.label} 启动 esbuild 失败：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[build] ${target.label} 构建失败（退出码 ${result.status}）`);
    return false;
  }
  return true;
}

/**
 * 把暂存目录整体替换为 dist。
 *
 * Windows 上直接 rename 到已存在的目录会失败，所以先移除旧 dist。旧产物只会在
 * **新产物已全部就绪之后**才被删除，因此失败构建不会造成"两不着地"。
 */
async function promoteStage() {
  if (existsSync(outDir)) {
    try {
      await rm(outDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`[build] 无法移除旧 dist（可能被正在运行的应用占用）：${error.message}`);
      console.error(`[build] 新产物已构建完成，保留在 ${stageRel}/，请关闭应用后重试。`);
      return false;
    }
  }
  try {
    await rename(stageDir, outDir);
  } catch (error) {
    console.error(`[build] 替换 dist 失败：${error.message}`);
    return false;
  }
  return true;
}

async function main() {
  // 构建前先跑类型检查。
  //
  // 为什么必须有这一步：esbuild **不做类型检查**，它能把"引用了未定义标识符"
  // 的源代码照样打包成功并返回 0。实测发生过：core 处于编辑中间态时
  // `npm run build` 返回 0、产物齐全，但 `electron .` 启动即抛
  // `ReferenceError: computeEngineSize is not defined` —— 原子替换会把这种
  // **构建成功但产物是坏的** 的结果稳定地换上去，比构建失败更隐蔽。
  //
  // 需要跳过时加 `--no-typecheck`（仅用于本地快速迭代，交付前不要用）。
  if (!process.argv.includes('--no-typecheck')) {
    console.log('[build] 类型检查…');
    const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tscBin)) {
      console.error('[build] 未找到 TypeScript，请先安装依赖。');
      process.exit(1);
    }
    const tc = spawnSync(process.execPath, [tscBin, '--noEmit'], { cwd: root, stdio: 'inherit' });
    if (tc.status !== 0) {
      console.error('[build] 类型检查未通过，已中止构建；旧 dist 未被改动。');
      console.error('[build] （确实需要跳过时用 `node scripts/build.mjs --no-typecheck`）');
      process.exit(1);
    }
  }

  // 清理上次可能残留的暂存目录
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const watchArgs = watch ? ['--watch'] : [];

  for (const target of targets) {
    const targetArgs = watchArgs.length > 0 ? watchArgs : undefined;
    if (!runEsbuild(target, targetArgs)) {
      await rm(stageDir, { recursive: true, force: true });
      console.error('[build] 已放弃本次构建；旧 dist 未被改动。');
      process.exit(1);
    }
  }

  await copyStatic(path.join(root, 'src/renderer'), path.join(stageDir, 'renderer'));

  if (watch) {
    // 监视模式下不做原子替换：esbuild 直接写暂存目录，由调用方自行决定何时提升。
    console.log(`[build] 监视模式已启动（输出到 ${stageRel}/）`);
    return;
  }

  const required = [
    'main/index.cjs',
    'preload/index.cjs',
    'renderer/index.js',
    'renderer/index.html',
  ];
  const missing = required.filter((f) => !existsSync(path.join(stageDir, f)));
  if (missing.length > 0) {
    await rm(stageDir, { recursive: true, force: true });
    console.error('[build] 缺少产物:', missing.join(', '));
    console.error('[build] 已放弃本次构建；旧 dist 未被改动。');
    process.exit(1);
  }

  const sizes = [];
  for (const rel of required.slice(0, 3)) {
    sizes.push(`${rel} ${((await stat(path.join(stageDir, rel))).size / 1024).toFixed(1)} KB`);
  }

  if (!(await promoteStage())) {
    process.exit(1);
  }

  console.log(`[build] 完成 ✓  ${sizes.join('  |  ')}`);
}

main().catch(async (error) => {
  console.error('[build] 失败:', error);
  await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
});
