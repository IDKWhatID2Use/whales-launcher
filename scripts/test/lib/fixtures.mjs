/**
 * UI 测试 fixture：在系统临时目录下造一个完全隔离的 launcher home。
 *
 * 设计约束（与 scripts/audit/bridge-smoke.mjs 保持一致的做法）：
 *  - **不装真实 dsh 引擎、不联网、不执行任何引擎代码**。实例目录按 core 的磁盘布局
 *    直接落盘（`instances/<dir>/instance.json` + `home/profiles/<name>/package.json`），
 *    这正是 bridge-smoke 已验证过的 fixture 形态。
 *  - 为什么不用 `instance:create`：core 的 `createInstance` 会**真的执行引擎 CLI**
 *    （src/core/instance.ts L172-L175 + initializeProfile），在测试里等价于要求一个真实
 *    引擎安装；手写磁盘布局可以完全不依赖引擎。
 *  - 引擎目录用一个**只含 package.json 的合成目录**（外加一个永不执行的 lib/bin.js 占位）。
 *    `listEngines` 只读 package.json / bin 路径 / 目录大小，不会执行它。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** fixture 实例的显示名（断言只允许引用这里导出的常量，绝不硬编码用户机器上的名字）。 */
export const FIXTURE_INSTANCES = Object.freeze([
  { id: 'ui-fixture-0001', dirName: 'ui-alpha', name: 'UI Alpha', note: 'ui test fixture one', color: '#5B8DEF' },
  { id: 'ui-fixture-0002', dirName: 'ui-beta', name: 'UI Beta', note: 'ui test fixture two', color: '#3FB950' },
  { id: 'ui-fixture-0003', dirName: 'ui-gamma', name: 'UI Gamma', note: 'ui test fixture three', color: '#D29922' },
]);

/** 合成引擎的版本号（fixture 专属，断言从这里取，不硬编码真实版本）。 */
export const FIXTURE_ENGINE_VERSION = '0.0.1-uitest';

/** 一个**永远不存在的**搜索关键词：用于验证"搜索无结果"空态。 */
export const NO_MATCH_QUERY = 'zzz-no-such-instance-zzz';

/** 目录名 / 描述一律 ASCII，避免 PS 5.1 侧编码问题。 */
function instanceMeta({ id, dirName, name, note, color }) {
  return {
    schemaVersion: 1,
    id,
    name,
    dirName,
    icon: null,
    color,
    note,
    engine: { version: FIXTURE_ENGINE_VERSION },
    profile: { name: dirName, template: 'web' },
    workspace: { mode: 'local' },
    saves: { mode: 'local' },
    settings: { mode: 'local' },
    credentials: { mode: 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: false },
    createdAt: new Date(0).toISOString(),
    lastLaunchedAt: null,
    launchCount: 0,
  };
}

/**
 * 造一个临时 home。
 * @param {{ instances?: number, engines?: number }} [options]
 * @returns {Promise<{ home: string, dispose: () => Promise<void>, instances: object[], engines: string[] }>}
 */
export async function createFixtureHome(options = {}) {
  const instanceCount = options.instances ?? FIXTURE_INSTANCES.length;
  const engineCount = options.engines ?? 1;

  const home = await mkdtemp(path.join(os.tmpdir(), 'whales-ui-test-'));

  // 合法但最小的 launcher.json：让 P8 / 主题路径有真实配置可读，同时不依赖真实 home。
  await writeFile(
    path.join(home, 'launcher.json'),
    `${JSON.stringify({ registry: 'https://registry.npmjs.org', theme: 'dark' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(home, 'package.json'),
    `${JSON.stringify({ name: 'ui-test-decoy', version: '9.9.9-decoy' }, null, 2)}\n`,
    'utf8',
  );

  const instances = FIXTURE_INSTANCES.slice(0, instanceCount);
  for (const item of instances) {
    const instanceRoot = path.join(home, 'instances', item.dirName);
    const profileDir = path.join(instanceRoot, 'home', 'profiles', item.dirName);
    await mkdir(profileDir, { recursive: true });
    await mkdir(path.join(instanceRoot, 'home', 'logs'), { recursive: true });
    // 空 sessions 目录：让"无存档"是一条**真实**的后端状态，而不是"目录都不存在"。
    await mkdir(path.join(instanceRoot, 'home', 'sessions'), { recursive: true });
    await mkdir(path.join(instanceRoot, 'workspace'), { recursive: true });
    await writeFile(
      path.join(instanceRoot, 'instance.json'),
      `${JSON.stringify(instanceMeta(item), null, 2)}\n`,
      'utf8',
    );
    // 真实存在的 settings.yaml：P3 的 YAML 编辑器要有内容可读（否则只会看到失败态）。
    await writeFile(
      path.join(instanceRoot, 'home', 'settings.yaml'),
      [
        '# ui-test fixture settings',
        'model: ui-test-model',
        'temperature: 0.2',
        'features:',
        '  - alpha',
        '  - beta',
        'nested:',
        '  flag: true',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(profileDir, 'package.json'),
      `${JSON.stringify(
        {
          name: item.dirName,
          version: '0.0.1',
          private: true,
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
          dependencies: {},
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  }

  const engines = [];
  for (let i = 0; i < engineCount; i += 1) {
    // 第二个引擎用不同版本号，让"引擎行数"断言不会因为 1 而被凑巧满足。
    const version = i === 0 ? FIXTURE_ENGINE_VERSION : `${FIXTURE_ENGINE_VERSION}.${i}`;
    const packageDir = path.join(home, 'engines', version, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(path.join(packageDir, 'lib'), { recursive: true });
    await writeFile(
      path.join(packageDir, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version, main: 'lib/bin.js' }, null, 2)}\n`,
      'utf8',
    );
    // 占位入口：只为让 engineBinPathIfPresent 判定为"已安装"。UI 测试从不启动实例，
    // 因此这个文件永远不会被执行。
    await writeFile(
      path.join(packageDir, 'lib', 'bin.js'),
      '// synthetic engine placeholder for UI tests; never executed\nprocess.exit(1);\n',
      'utf8',
    );
    engines.push(version);
  }

  return {
    home,
    instances: instances.map((item) => ({ ...item })),
    engines,
    async dispose() {
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * 隔离断言：临时 home 必须落在系统临时目录下，且不在仓库内。
 * 这是"绝不触碰真实 F:\WhalesLauncher\instances / engines"的机械保证。
 * @param {string} home
 * @param {string} repoRoot
 */
export function assertHomeIsolated(home, repoRoot) {
  const resolved = path.resolve(home);
  const tmpRoot = path.resolve(os.tmpdir());
  const repo = path.resolve(repoRoot);
  if (!resolved.startsWith(tmpRoot)) {
    throw new Error(`隔离断言失败：临时 home ${resolved} 不在系统临时目录 ${tmpRoot} 之下。`);
  }
  if (resolved === repo || resolved.startsWith(repo + path.sep)) {
    throw new Error(`隔离断言失败：临时 home ${resolved} 落在仓库 ${repo} 之内。`);
  }
  return true;
}
