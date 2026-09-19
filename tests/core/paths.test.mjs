/**
 * 路径解析与 workspace 编码测试
 *
 * `workspaceKeyFor` 必须逐字符复刻 dsh 的 `projectKey`；这里用**本机真实存在的会话
 * 目录名**做反向校验（`C:\Users\user\.dsh\sessions\*`），而不是凭猜测。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCoreModule, run, test } from './_helpers.mjs';

const { paths, core } = await loadCoreModule();
const { corePaths, instancePaths, engineDir, enginePackageDir, engineBinCandidate, sharedSettingsFile, sharedWorkspaceDir, childBaseEnv, npmCacheArgs, pnpmCacheArgs, CACHE_DIR_NAME } = paths;

const ROOT = 'F:\\WhalesLauncher';
const META = {
  schemaVersion: 1,
  id: 'a1b2',
  name: '我的实例',
  dirName: 'main',
  icon: null,
  color: '#5B8DEF',
  note: '',
  engine: { version: '0.1.6-alpha.2' },
  profile: { name: 'web', template: 'web' },
  workspace: { mode: 'local' },
  saves: { mode: 'local' },
  settings: { mode: 'local' },
  credentials: { mode: 'inherit' },
  launch: { appArgs: [], autoOpenBrowser: true },
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLaunchedAt: null,
  launchCount: 0,
};

test('corePaths：全部关键路径', () => {
  const p = corePaths(ROOT);
  assert.equal(p.root, ROOT);
  assert.equal(p.instancesDir, path.join(ROOT, 'instances'));
  assert.equal(p.enginesDir, path.join(ROOT, 'engines'));
  assert.equal(p.sharedDir, path.join(ROOT, 'shared'));
  assert.equal(p.sharedSessionsDir, path.join(ROOT, 'shared', 'sessions'));
  assert.equal(p.sharedWorkspacesDir, path.join(ROOT, 'shared', 'workspaces'));
  assert.equal(p.cacheDir, path.join(ROOT, CACHE_DIR_NAME));
  assert.equal(p.configFile, path.join(ROOT, 'launcher.json'));
});

test('instancePaths：实例布局', () => {
  const p = instancePaths(ROOT, META);
  const root = path.join(ROOT, 'instances', 'main');
  assert.equal(p.root, root);
  assert.equal(p.home, path.join(root, 'home'));
  assert.equal(p.workspace, path.join(root, 'workspace'));
  assert.equal(p.logs, path.join(root, 'logs'));
  assert.equal(p.sessions, path.join(root, 'home', 'sessions'));
  assert.equal(p.settingsFile, path.join(root, 'home', 'settings.yaml'));
  assert.equal(p.credentialsFile, path.join(root, 'home', '.credentials.yaml'));
  assert.equal(p.metaFile, path.join(root, 'instance.json'));
  assert.equal(p.profilesDir, path.join(root, 'home', 'profiles'));
  assert.equal(p.profileDir, path.join(root, 'home', 'profiles', 'web'));
});

test('instancePaths：非法目录名必须抛错（防目录穿越）', () => {
  for (const dirName of ['..', '.', 'a/b', 'a\\b', 'node_modules', 'desktop', '']) {
    assert.throws(() => instancePaths(ROOT, { ...META, dirName }), /不合法/);
  }
  assert.throws(() => instancePaths(ROOT, { ...META, profile: { name: '..', template: 'web' } }), /不合法/);
});

test('引擎路径', () => {
  assert.equal(engineDir(ROOT, '0.1.6-alpha.2'), path.join(ROOT, 'engines', '0.1.6-alpha.2'));
  assert.equal(
    enginePackageDir(ROOT, '0.1.6-alpha.2'),
    path.join(ROOT, 'engines', '0.1.6-alpha.2', 'node_modules', '@deepseek-ai', 'dsh'),
  );
  assert.equal(
    engineBinCandidate(ROOT, '0.1.6-alpha.2'),
    path.join(ROOT, 'engines', '0.1.6-alpha.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  );
  assert.equal(sharedSettingsFile(ROOT), path.join(ROOT, 'shared', 'settings.yaml'));
  assert.equal(sharedWorkspaceDir(ROOT, 'main'), path.join(ROOT, 'shared', 'workspaces', 'main'));
});

test('workspaceKeyFor：与真实会话目录名逐字符一致', () => {
  // 真实 dsh 的 C:\Users\user\.dsh\sessions 下会出现的目录名
  assert.equal(core.workspaceKeyFor('F:\\WhalesLauncher'), '--F-WhalesLauncher--');
  assert.equal(core.workspaceKeyFor('C:\\Users\\user\\.dsh'), '--C-Users-user-.dsh--');
  assert.equal(core.workspaceKeyFor('C:\\Users\\user\\.dsh\\APIHunter'), '--C-Users-user-.dsh-APIHunter--');
  assert.equal(core.workspaceKeyFor('F:\\ComFYUI'), '--F-ComFYUI--');
  assert.equal(core.workspaceKeyFor('F:\\Network problems'), '--F-Network~0020problems--');
});

test('workspaceKeyFor：分隔符折叠 / 大小写保留 / resolve 归一化', () => {
  assert.equal(core.workspaceKeyFor('F:\\\\WhalesLauncher'), '--F-WhalesLauncher--');
  assert.equal(core.workspaceKeyFor('F:\\WhalesLauncher\\'), '--F-WhalesLauncher--');
  // path.resolve 会消掉 "." 段，保证与子进程 process.cwd() 的取值一致
  assert.equal(core.workspaceKeyFor('F:\\WhalesLauncher\\.'), '--F-WhalesLauncher--');
  assert.equal(core.workspaceKeyFor('F:\\WhalesLauncher\\sub\\..'), '--F-WhalesLauncher--');
  assert.equal(core.workspaceKeyFor('c:\\Temp'), '--c-Temp--');
});

test('workspaceKeyFor：空路径抛错', () => {
  assert.throws(() => core.workspaceKeyFor(''), /空/);
});

test('npm/pnpm 子进程环境与缓存参数（双保险）', () => {
  const env = childBaseEnv(ROOT);
  assert.equal(env.npm_config_cache, path.join(ROOT, CACHE_DIR_NAME));
  assert.equal(env.ELECTRON_SKIP_BINARY_DOWNLOAD, '1');
  assert.deepEqual(npmCacheArgs(ROOT), ['--cache', path.join(ROOT, CACHE_DIR_NAME)]);
  assert.deepEqual(pnpmCacheArgs(ROOT), [
    `--config.cache=${path.join(ROOT, CACHE_DIR_NAME)}`,
    `--config.store-dir=${paths.pnpmStoreDir(ROOT)}`,
    '--config.confirm-modules-purge=false',
  ]);
  assert.deepEqual(childBaseEnv(ROOT, { DSH_HOME: 'x' }).DSH_HOME, 'x');
});

test('pnpm 子进程必须声明非交互（无 TTY 时否则会中止重建 node_modules）', () => {
  // 实测：`pnpm install` 在无 TTY 下报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY，
  // 要求 CI=true 或 confirmModulesPurge=false。启动器及其子进程都没有交互终端。
  const env = childBaseEnv(ROOT);
  assert.equal(env.CI, 'true');
  assert.ok(
    pnpmCacheArgs(ROOT).includes('--config.confirm-modules-purge=false'),
    '命令行需与 CI 双保险',
  );
});

test('pnpm store 位置必须唯一且稳定（环境变量与命令行不得打架）', () => {
  // 旧缺陷：pnpm 未固定 store 时按 `<cache 所在盘>\.pnpm-store` 推导，
  // 而用户级 ~/.npmrc 的 cache 与启动器注入的 npm_config_cache 分处不同盘，
  // 于是同一次调用算出两个 store，直接 ERR_PNPM_UNEXPECTED_STORE。
  // 现约定：统一用 pnpm 自己的默认位置（cache 所在盘的 `<盘>\.pnpm-store`），
  // 与用户在终端里手敲的 pnpm、dsh 市场自己发起的安装落到同一个 store。
  const store = paths.pnpmStoreDir(ROOT);
  const fromArgs = pnpmCacheArgs(ROOT)
    .find((item) => item.startsWith('--config.store-dir='))
    ?.slice('--config.store-dir='.length);
  assert.equal(fromArgs, store, '命令行 store-dir 必须等于 pnpmStoreDir');
  assert.equal(childBaseEnv(ROOT).npm_config_store_dir, store, '环境变量 store 必须等于 pnpmStoreDir');
  assert.equal(store, path.join(path.parse(path.join(ROOT, CACHE_DIR_NAME)).root, '.pnpm-store'));
  assert.ok(!store.startsWith(ROOT), 'store 不得存在于启动器根目录内（否则与用户手敲的 pnpm 分家）');
});

test('core 单例暴露契约中的路径方法', () => {
  assert.equal(typeof core.corePaths, 'function');
  assert.equal(typeof core.instancePaths, 'function');
  assert.equal(core.corePaths(ROOT).root, ROOT);
});

await run();
