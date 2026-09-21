/**
 * Node 侧车桥接服务的构建脚本（WinUI 3 重构专用）。
 *
 * 产物：`dist/bridge/server.cjs` —— 单文件 CJS，C# 侧以
 * `node dist/bridge/server.cjs --home <dir>` 拉起（协议 §1、§5.1）。
 * `desktop/src/WhalesLauncher.App/WhalesLauncher.App.csproj` 会把 `dist/bridge/**`
 * 随应用分发到输出目录的 `bridge\`。
 *
 * 与旧构建链的关系：**不修改** `scripts/build.mjs`（它构建的是即将废弃的
 * Electron 主进程/preload/renderer）。这里沿用它的两条关键经验：
 *
 *  1. **用 esbuild CLI 子进程 + `stdio: 'inherit'`，不用 esbuild 的 JS API**。
 *     JS API 会拉起长驻子进程并用**管道**通信，在受限沙箱里带管道的 spawn 会被
 *     拒绝（EPERM）。CLI + 继承 stdio 在普通环境下行为完全一致。
 *  2. **先构建到暂存目录，再整体替换产物**。失败的构建不会摧毁上一份可用产物。
 *
 * 打包范围：`server.mjs` + `desktop/bridge/*` + `src/core/**` + `src/shared/contracts.ts`。
 * externals 只有 node 内置模块（`--platform=node` 自动外部化）；`adm-zip` / `js-yaml`
 * 是纯 CJS 依赖，直接 bundle 进来，因此产物是**真正零运行期依赖**的单文件。
 *
 * **两条硬边界（构建期断言，违反即构建失败）**：
 *  1. 不引入 `electron`（`--external:electron`）；
 *  2. 不依赖 `src/main/**`（待拆除的 Electron 主进程目录）——
 *     由 esbuild `--metafile` 的模块图机械证明（{@link assertNoLegacyMainInputs}）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 入口与产物。 */
const entry = 'desktop/bridge/server.mjs';
const outRel = path.join('dist', 'bridge', 'server.cjs');
const stageRel = path.join('dist', '.bridge-stage');

/** 需要做语法自检的桥接层源文件（不执行，只解析）。 */
const sources = [
  'desktop/bridge/stdio.mjs',
  'desktop/bridge/errors.mjs',
  'desktop/bridge/devtools.mjs',
  'desktop/bridge/validate.mjs',
  'desktop/bridge/host.mjs',
  'desktop/bridge/events.mjs',
  'desktop/bridge/config-store.mjs',
  'desktop/bridge/menu.mjs',
  'desktop/bridge/server.mjs',
];

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
  console.error('[build-bridge] 未找到 esbuild 可执行文件。请先安装依赖：');
  console.error('               npm install --cache "F:\\WhalesLauncher\\.npm-cache"');
  process.exit(1);
}

/** 语法自检（`node --check`，只解析不执行）：esbuild 不做类型检查，这一步兜住低级语法错。 */
function checkSyntax() {
  for (const relative of sources) {
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      console.error(`[build-bridge] 源文件缺失：${relative}`);
      process.exit(1);
    }
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`[build-bridge] 语法检查未通过：${relative}`);
      process.exit(1);
    }
  }
}

/**
 * 读取仓库 `package.json` 的 version（构建期注入用）。
 * 读不到就直接失败：**宁可不产出，也不产出一个带假版本号的产物**。
 */
async function readPackageVersion() {
  const file = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
    if (version.length === 0) throw new Error('缺少 version 字段');
    return version;
  } catch (error) {
    console.error(`[build-bridge] 无法从 ${file} 读取启动器版本：${error.message}`);
    console.error('              版本号会进 app:version 与实例包元数据，构建不能在没有它的情况下继续。');
    process.exit(1);
  }
}

/**
 * 硬边界：桥接产物**不得**依赖 `src/main/**`（待拆除的 Electron 主进程目录）。
 *
 * 为什么做成构建期断言而不是只在评审时 grep 一次：`src/main/**` 能否删除是用户验收标准
 * （「旧前端设计与代码已完全不被使用」）的前提 —— 只要还有一个 import 指向它，那个目录就
 * 钉死在仓库里。把这条规则交给构建脚本，任何人以后不小心写回一个 `import '../../src/main/x.ts'`
 * 都会**立刻构建失败**，而不是等到拆除那天才发现。
 *
 * 证据来源是 esbuild 的 `--metafile`：它列出本次打包真正读过的**每一个输入文件**，
 * 比 grep 源码更硬 —— grep 会被人绕开（动态 import / 变量拼接），模块图不会。
 * @param {string} stageDir 暂存目录（meta.json 所在处）。
 * @param {string} version 注入的版本号（仅用于日志）。
 * @returns {Promise<boolean>} 通过为 true。
 */
async function assertNoLegacyMainInputs(stageDir, version) {
  const metaFile = path.join(stageDir, 'meta.json');
  if (!existsSync(metaFile)) {
    console.error('[build-bridge] 缺少 esbuild 模块图（meta.json），无法证明"不依赖 src/main/**"。');
    return false;
  }
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  const inputs = Object.keys(meta.inputs ?? {});
  // 归一化分隔符后再判：Windows 上 esbuild 给的是 `src\main\ipc.ts`。
  const legacy = inputs.filter((file) => /(^|[\\/])src[\\/]main[\\/]/.test(file));
  if (legacy.length > 0) {
    console.error('[build-bridge] 构建被拒绝：产物依赖了待拆除的旧主进程目录 src/main/**：');
    for (const file of legacy) console.error(`               ${file}`);
    console.error('               请把需要的逻辑内联到 desktop/bridge/**（见 desktop/bridge/errors.mjs 的先例）。');
    return false;
  }
  const vendored = inputs.filter((file) => /(^|[\\/])node_modules[\\/]/.test(file)).length;
  console.log(
    `[build-bridge] 模块图自检 ✓  输入文件 ${inputs.length} 个（其中 npm 包 ${vendored} 个），` +
      'src/main/** 引用数 = 0',
  );
  void version;
  return true;
}

async function main() {
  checkSyntax();

  // 启动器版本**在构建期注入**（`config-store.mjs` 的 `__WHALES_APP_VERSION__`）。
  // 为什么不运行时读文件：`--home` 是数据目录（由 C# 传入，可能是任意路径、也可能没有
  // package.json），而版本号属于构建产物；沿运行时相对路径去猜会得到与真实版本无关的
  // 结论（曾实测到 `app:version` 返回 0.0.0 并被写进实例包元数据）。
  const version = await readPackageVersion();

  const esbuild = resolveEsbuild();
  const stageDir = path.join(root, stageRel);
  const outDir = path.join(root, 'dist', 'bridge');

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const args = [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--sourcemap',
    // 只保留 node 内置为外部依赖（platform=node 自动外部化）；adm-zip / js-yaml 一并打包。
    // 显式拒绝 electron：若哪天有人不小心把 Electron 拖进来，这里会立刻暴露。
    '--external:electron',
    `--define:__WHALES_APP_VERSION__=${JSON.stringify(version)}`,
    `--outfile=${path.join(stageRel, 'server.cjs')}`,
    // 模块图清单：用它机械证明"桥接层不依赖待拆除的旧主进程目录"（见 assertNoLegacyMainInputs）。
    `--metafile=${path.join(stageRel, 'meta.json')}`,
  ];

  console.log(`[build-bridge] esbuild 打包 ${entry} → ${outRel} …（注入版本 ${version}）`);
  const built = spawnSync(esbuild, args, { cwd: root, stdio: 'inherit' });
  if (built.error !== undefined && built.error !== null) {
    console.error(`[build-bridge] 启动 esbuild 失败：${built.error.message}`);
    await rm(stageDir, { recursive: true, force: true });
    process.exit(1);
  }
  if (built.status !== 0) {
    console.error(`[build-bridge] 构建失败（退出码 ${built.status}）；旧产物未被改动。`);
    await rm(stageDir, { recursive: true, force: true });
    process.exit(1);
  }

  if (!(await assertNoLegacyMainInputs(stageDir, version))) {
    await rm(stageDir, { recursive: true, force: true });
    process.exit(1);
  }

  const staged = path.join(stageDir, 'server.cjs');
  if (!existsSync(staged)) {
    console.error('[build-bridge] 构建结束但没有产物，已放弃本次构建。');
    await rm(stageDir, { recursive: true, force: true });
    process.exit(1);
  }

  // 产物语法自检：坏产物比构建失败更隐蔽（旧 build.mjs 亦用类型检查兜同一类问题）。
  const check = spawnSync(process.execPath, ['--check', staged], { cwd: root, stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('[build-bridge] 产物语法检查未通过，已放弃本次构建；旧产物未被改动。');
    await rm(stageDir, { recursive: true, force: true });
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const artifacts = ['server.cjs', 'server.cjs.map'];
  for (const name of artifacts) {
    const from = path.join(stageDir, name);
    if (!existsSync(from)) continue;
    // Windows 上 rename 到已存在的**文件**会覆盖（libuv 用 MOVEFILE_REPLACE_EXISTING），
    // 因此替换是原地完成的，不会出现"两不着地"的中间态。
    await rename(from, path.join(outDir, name));
  }
  await rm(stageDir, { recursive: true, force: true });

  const size = (await stat(path.join(outDir, 'server.cjs'))).size;
  console.log(
    `[build-bridge] 完成 ✓  ${outRel}  ${(size / 1024).toFixed(1)} KB  ` +
      `（${(size / (1024 * 1024)).toFixed(2)} MiB，含 src/core + src/shared + adm-zip/js-yaml）`,
  );
}

main().catch(async (error) => {
  console.error('[build-bridge] 失败：', error);
  await rm(path.join(root, stageRel), { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
});
