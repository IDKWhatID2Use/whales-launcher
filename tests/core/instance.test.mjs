/**
 * 实例 CRUD 与共享模式测试
 *
 * 用 `seedStubEngine` 提供的"假 dsh"驱动创建流程（不依赖真 dsh、不联网），
 * 覆盖：黄金路径 profile 初始化、instance.json 往返、更新、删除、
 * 以及 junction 共享与**不误删真实数据**的安全语义。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, run, test } from './_helpers.mjs';

const { core, fsx } = await loadCoreModule();
const { pathExists, readText, writeTextAtomic, isLink } = fsx;

const CONFIG = { schemaVersion: 1, primaryHome: 'C:\\Users\\tester\\.dsh', theme: 'dark', lastInstanceId: null, confirmOnDelete: true, engineRegistry: 'https://registry.npmjs.org' };

/** 准备一个含假引擎的临时启动器根。 */
async function setup(t, label = 'instance') {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  return root;
}

test('createInstance：黄金路径初始化 profile，bundles 与模板一致', async (t) => {
  const root = await setup(t);
  const logs = [];
  const meta = await core.createInstance(root, { name: '我的实例', engineVersion: '9.9.9', template: 'web' }, { onLog: (stream, text) => logs.push(`${stream}:${text}`) });
  const inst = path.join(root, 'instances', meta.dirName);
  const profileDir = path.join(inst, 'home', 'profiles', meta.profile.name);
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.equal(manifest.name, `dsh-profile-${meta.dirName}`);
  assert.equal(await readText(path.join(profileDir, 'cordis.patch.yml')), '# stub patch layer\n[]\n');
  assert.equal(await pathExists(path.join(profileDir, 'pnpm-workspace.yaml')), true);
  assert.equal(await pathExists(path.join(inst, 'workspace')), true);
  assert.equal(await pathExists(path.join(inst, 'logs')), true);
  assert.equal(await pathExists(path.join(inst, 'instance.json')), true);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.id.length, 36);
  assert.equal(meta.engine.version, '9.9.9');
  assert.equal(meta.workspace.mode, 'local');
  assert.equal(meta.credentials.mode, 'inherit');
  assert.equal(meta.launchCount, 0);
  assert.ok(logs.some((line) => line.includes('--dump-config')), '应记录黄金路径命令');
});

test('createInstance：各模板的 bundles 与契约 BUNDLE_TEMPLATES 一致', async (t) => {
  const root = await setup(t, 'instance-tpl');
  const { BUNDLE_TEMPLATES } = await import('../../src/shared/contracts.ts');
  for (const [template, bundles] of Object.entries(BUNDLE_TEMPLATES)) {
    const meta = await core.createInstance(root, { name: `实例-${template}`, dirName: `inst-${template}`, engineVersion: '9.9.9', template });
    const manifest = await readJsonFile(path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'package.json'));
    assert.deepEqual(manifest.dsh.profile.bundles, bundles, `模板 ${template} 的 bundles 应一致`);
  }
});

test('createInstance：目录名等于随附模板名时也能创建（绕开 dsh 的 shipped 限制）', async (t) => {
  const root = await setup(t, 'instance-shipped');
  const meta = await core.createInstance(root, { name: '网页实例', dirName: 'web', engineVersion: '9.9.9', template: 'web' });
  assert.equal(meta.dirName, 'web');
  const manifest = await readJsonFile(path.join(root, 'instances', 'web', 'home', 'profiles', 'web', 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
});

test('createInstance：重名 / 非法名 / 引擎缺失均抛错', async (t) => {
  const root = await setup(t, 'instance-errors');
  await core.createInstance(root, { name: 'A', engineVersion: '9.9.9', template: 'web' });
  await assert.rejects(() => core.createInstance(root, { name: 'B', dirName: 'A', engineVersion: '9.9.9', template: 'web' }), /已被占用/);
  await assert.rejects(() => core.createInstance(root, { name: '   ', engineVersion: '9.9.9', template: 'web' }), /不能为空/);
  await assert.rejects(() => core.createInstance(root, { name: 'C', dirName: '..', engineVersion: '9.9.9', template: 'web' }), /不合法/);
  await assert.rejects(() => core.createInstance(root, { name: 'D', dirName: 'desktop', engineVersion: '9.9.9', template: 'web' }), /不合法/);
  await assert.rejects(() => core.createInstance(root, { name: 'E', engineVersion: '1.2.3', template: 'web' }), /未安装/);
  await assert.rejects(() => core.createInstance(root, { name: 'F', engineVersion: '9.9.9', template: 'nope' }), /未知的 profile 模板/);
});

test('createInstance：失败时清理半成品目录', async (t) => {
  const root = await setup(t, 'instance-cleanup');
  await assert.rejects(() => core.createInstance(root, { name: 'G', dirName: 'gone', engineVersion: '1.0.0', template: 'web' }), /未安装/);
  assert.equal(await pathExists(path.join(root, 'instances', 'gone')), false);
});

test('readInstance / listInstances / instance.json 往返', async (t) => {
  const root = await setup(t, 'instance-read');
  const meta = await core.createInstance(root, { name: '往返实例', icon: '🐋', color: '#123456', note: '备注', engineVersion: '9.9.9', template: 'headless' });
  const byId = await core.readInstance(root, meta.id);
  assert.deepEqual(byId, meta);
  assert.equal(await core.readInstance(root, 'no-such-id'), null);

  // 写点依赖，验证 pluginCount
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'));
  manifest.dependencies = { 'some-plugin': '^1.0.0', '@scope/other': '~2.0.0' };
  await fs.writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const list = await core.listInstances(root);
  assert.equal(list.length, 1);
  const summary = list[0];
  assert.equal(summary.meta.id, meta.id);
  assert.equal(summary.present, true);
  assert.equal(summary.engineInstalled, true);
  assert.equal(summary.pluginCount, 2);
  assert.equal(summary.runtime.state, 'stopped');
  assert.equal(summary.runtime.pid, null);
});

test('listInstances：损坏的 instance.json 不再静默丢弃（降级呈现且不影响其它实例）', async (t) => {
  const root = await setup(t, 'instance-broken');
  const meta = await core.createInstance(root, { name: '好的实例', engineVersion: '9.9.9', template: 'web' });
  const brokenDir = path.join(root, 'instances', 'broken');
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, 'instance.json'), '{ 坏 json');
  const list = await core.listInstances(root);
  assert.equal(list.length, 2, '坏记录必须仍可见（否则用户既看不到也删不掉）');
  const healthy = list.find((item) => item.meta.id === meta.id);
  assert.equal(healthy.problem, undefined, '健康实例不应带问题标记');
  const broken = list.find((item) => item.meta.dirName === 'broken');
  assert.ok(broken !== undefined, '坏记录应可见');
  assert.ok(broken.problem.includes('损坏'), `problem=${broken.problem}`);
  assert.equal(broken.meta.id, 'orphan:broken');
});

test('updateInstance：可更新字段生效且目录名不变', async (t) => {
  const root = await setup(t, 'instance-update');
  const meta = await core.createInstance(root, { name: '旧名', engineVersion: '9.9.9', template: 'web' });
  await seedStubEngine(root, '9.9.8');
  const updated = await core.updateInstance(root, meta.id, {
    name: '新名字',
    icon: '🎮',
    color: '#abcdef',
    note: '改了备注',
    engineVersion: '9.9.8',
    appArgs: ['--port', '8080'],
    autoOpenBrowser: false,
    saves: 'shared',
    credentials: 'local',
  });
  assert.equal(updated.name, '新名字');
  assert.equal(updated.dirName, meta.dirName, '目录名必须稳定');
  assert.equal(updated.profile.name, meta.profile.name);
  assert.equal(updated.icon, '🎮');
  assert.equal(updated.color, '#abcdef');
  assert.equal(updated.note, '改了备注');
  assert.equal(updated.engine.version, '9.9.8');
  assert.deepEqual(updated.launch.appArgs, ['--port', '8080']);
  assert.equal(updated.launch.autoOpenBrowser, false);
  assert.equal(updated.saves.mode, 'shared');
  assert.equal(updated.credentials.mode, 'local');
  const reread = await core.readInstance(root, meta.id);
  assert.deepEqual(reread, updated);
  await assert.rejects(() => core.updateInstance(root, meta.id, { engineVersion: 'bad/version' }), /不合法/);
  await assert.rejects(() => core.updateInstance(root, 'missing', { name: 'x' }), /不存在/);
});

test('deleteInstance：保留文件 / 删除文件两种语义', async (t) => {
  const root = await setup(t, 'instance-delete');
  const keep = await core.createInstance(root, { name: '保留', engineVersion: '9.9.9', template: 'web' });
  await core.deleteInstance(root, keep.id, false);
  assert.equal(await pathExists(path.join(root, 'instances', keep.dirName, 'instance.json')), false);
  assert.equal(await pathExists(path.join(root, 'instances', keep.dirName, 'home')), true, '不删文件时必须保留数据');
  // 显式注销：记录不再出现在列表，但磁盘数据完整保留
  assert.equal((await core.listInstances(root)).some((item) => item.meta.id === keep.id), false);
  assert.equal(await core.readInstance(root, keep.id), null);

  const drop = await core.createInstance(root, { name: '删除', dirName: 'dropme', engineVersion: '9.9.9', template: 'web' });
  await core.deleteInstance(root, drop.id, true);
  assert.equal(await pathExists(path.join(root, 'instances', 'dropme')), false);
  await assert.rejects(() => core.deleteInstance(root, drop.id, true), /不存在/);
});

test('deleteInstance：实例内的 junction 不会导致共享数据被误删', async (t) => {
  const root = await setup(t, 'instance-delete-link');
  const meta = await core.createInstance(root, { name: '共享档', engineVersion: '9.9.9', template: 'web', saves: 'shared', settings: 'shared' });
  const sharedSessions = path.join(root, 'shared', 'sessions');
  await fs.mkdir(path.join(sharedSessions, 'ws-key', 'sess-1'), { recursive: true });
  await fs.writeFile(path.join(sharedSessions, 'ws-key', 'sess-1', 'session.v3.jsonl.zstd'), 'data');
  assert.equal(await isLink(path.join(root, 'instances', meta.dirName, 'home', 'sessions')), true);
  await core.deleteInstance(root, meta.id, true);
  assert.equal(await pathExists(path.join(root, 'instances', meta.dirName)), false);
  assert.equal(await readText(path.join(sharedSessions, 'ws-key', 'sess-1', 'session.v3.jsonl.zstd')), 'data', '共享存档必须完好');
});

test('createInstance：workspace=shared 直接建立 junction 到共享工作区', async (t) => {
  const root = await setup(t, 'instance-ws-create');
  const meta = await core.createInstance(root, {
    name: '共享工作区实例',
    engineVersion: '9.9.9',
    template: 'web',
    workspace: 'shared',
  });
  assert.equal(meta.workspace.mode, 'shared', 'meta 必须持久化该模式');
  const instanceWorkspace = path.join(root, 'instances', meta.dirName, 'workspace');
  assert.equal(await isLink(instanceWorkspace), true, '创建时即应建立 junction');
  await writeTextAtomic(path.join(instanceWorkspace, 'file.txt'), 'ws');
  assert.equal(
    await readText(path.join(root, 'shared', 'workspaces', meta.dirName, 'file.txt')),
    'ws',
    '通过链接写入的内容应落到共享工作区',
  );
  const reread = await core.readInstance(root, meta.id);
  assert.equal(reread.workspace.mode, 'shared');
});

test('updateInstance：workspace 双向切换且不丢数据', async (t) => {
  const root = await setup(t, 'instance-ws-update');
  const meta = await core.createInstance(root, { name: '切工作区', engineVersion: '9.9.9', template: 'web' });
  const instanceWorkspace = path.join(root, 'instances', meta.dirName, 'workspace');
  const sharedWorkspace = path.join(root, 'shared', 'workspaces', meta.dirName);
  await writeTextAtomic(path.join(instanceWorkspace, 'local.txt'), '本地内容');

  // local → shared：先落库，再由 applyShareModes 落地（与 saves/settings 同模式）
  const toShared = await core.updateInstance(root, meta.id, { workspace: 'shared' });
  assert.equal(toShared.workspace.mode, 'shared');
  await core.applyShareModes(root, toShared, CONFIG);
  assert.equal(await isLink(instanceWorkspace), true, '切换后应为 junction');
  assert.equal(await readText(path.join(sharedWorkspace, 'local.txt')), '本地内容', '本地既有内容必须并入共享库');

  // 写点共享数据，再 shared → local
  await writeTextAtomic(path.join(instanceWorkspace, 'shared.txt'), '共享内容');
  const toLocal = await core.updateInstance(root, meta.id, { workspace: 'local' });
  assert.equal(toLocal.workspace.mode, 'local');
  await core.applyShareModes(root, toLocal, CONFIG);
  assert.equal(await isLink(instanceWorkspace), false, '切回本地应为真实目录');
  assert.equal(await pathExists(path.join(instanceWorkspace, 'shared.txt')), false, '本地目录为新目录');
  assert.equal(await readText(path.join(sharedWorkspace, 'shared.txt')), '共享内容', '共享库中的数据必须保留');
  assert.equal(await readText(path.join(sharedWorkspace, 'local.txt')), '本地内容');
});

test('applyShareModes：saves 共享 → junction，切回 local 不丢共享数据', async (t) => {
  const root = await setup(t, 'instance-saves');
  const meta = await core.createInstance(root, { name: '存档实例', engineVersion: '9.9.9', template: 'web' });
  const sessions = path.join(root, 'instances', meta.dirName, 'home', 'sessions');

  await core.applyShareModes(root, { ...meta, saves: { mode: 'shared' } }, CONFIG);
  assert.equal(await isLink(sessions), true, '共享存档应为 junction');
  await writeTextAtomic(path.join(sessions, 'shared-marker.txt'), 'via-link');
  assert.equal(await readText(path.join(root, 'shared', 'sessions', 'shared-marker.txt')), 'via-link', '通过链接写入的应落到共享库');

  await core.applyShareModes(root, { ...meta, saves: { mode: 'local' } }, CONFIG);
  assert.equal(await isLink(sessions), false, '切回本地后应为真实目录');
  assert.equal(await pathExists(path.join(sessions, 'shared-marker.txt')), false);
  assert.equal(await readText(path.join(root, 'shared', 'sessions', 'shared-marker.txt')), 'via-link', '共享库数据保留');
});

test('applyShareModes：切到共享时先把本地数据并入共享库，冲突不删数据', async (t) => {
  const root = await setup(t, 'instance-merge');
  const meta = await core.createInstance(root, { name: '迁移实例', engineVersion: '9.9.9', template: 'web' });
  const sessions = path.join(root, 'instances', meta.dirName, 'home', 'sessions');
  await writeTextAtomic(path.join(sessions, 'mine.txt'), 'local');
  await core.applyShareModes(root, { ...meta, saves: { mode: 'shared' } }, CONFIG);
  assert.equal(await isLink(sessions), true);
  assert.equal(await readText(path.join(root, 'shared', 'sessions', 'mine.txt')), 'local', '本地已有会话应并入共享库');

  // 冲突场景：共享库已有同名条目 → 保留本地目录并抛错（绝不删数据）
  const meta2 = await core.createInstance(root, { name: '冲突实例', engineVersion: '9.9.9', template: 'web' });
  const sessions2 = path.join(root, 'instances', meta2.dirName, 'home', 'sessions');
  await writeTextAtomic(path.join(sessions2, 'mine.txt'), 'other');
  await assert.rejects(() => core.applyShareModes(root, { ...meta2, saves: { mode: 'shared' } }, CONFIG), /同名条目/);
  assert.equal(await readText(path.join(sessions2, 'mine.txt')), 'other', '冲突时本地数据必须保留');
  assert.equal(await isLink(sessions2), false);
});

test('applyShareModes：workspace 共享 → junction 到 shared/workspaces/<dirName>', async (t) => {
  const root = await setup(t, 'instance-workspace');
  const meta = await core.createInstance(root, { name: '工作区实例', engineVersion: '9.9.9', template: 'web' });
  const workspace = path.join(root, 'instances', meta.dirName, 'workspace');
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'shared' } }, CONFIG);
  assert.equal(await isLink(workspace), true);
  await writeTextAtomic(path.join(workspace, 'file.txt'), 'ws');
  assert.equal(await readText(path.join(root, 'shared', 'workspaces', meta.dirName, 'file.txt')), 'ws');
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'local' } }, CONFIG);
  assert.equal(await isLink(workspace), false);
});

test('applyShareModes：settings 共享为内容同步（本机文件链接不可用）', async (t) => {
  const root = await setup(t, 'instance-settings');
  const meta = await core.createInstance(root, { name: '设置实例', engineVersion: '9.9.9', template: 'web' });
  const settingsFile = path.join(root, 'instances', meta.dirName, 'home', 'settings.yaml');
  const sharedFile = path.join(root, 'shared', 'settings.yaml');

  // A. 本地有内容、共享为空 → 用本地内容播种共享（不丢数据）
  await core.writeInstanceSettings(root, meta, 'agent-default-model:\n  model: x\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, CONFIG);
  assert.equal(await readText(sharedFile), 'agent-default-model:\n  model: x\n');
  assert.equal(await readText(settingsFile), 'agent-default-model:\n  model: x\n');

  // B. 本地为空、共享有内容 → 采用共享内容（本地无可失去的数据）
  await fs.rm(settingsFile, { force: true });
  await writeTextAtomic(sharedFile, 'skin-dark: true\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, CONFIG);
  assert.equal(await readText(settingsFile), 'skin-dark: true\n', '本地为空时应采用共享内容');

  // C. 双方都有内容且不同 → 保留本地 + 登记冲突（绝不静默覆盖）
  await writeTextAtomic(settingsFile, 'local-only: true\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, CONFIG);
  assert.equal(await readText(settingsFile), 'local-only: true\n', '冲突时必须保留本地设置');
  assert.equal(await readText(sharedFile), 'skin-dark: true\n', '冲突时不得改动共享设置');
  const conflicts = core.listShareConflicts(meta.id);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].resource, 'settings');
  assert.equal(conflicts[0].kept, 'local');

  // D. 调用方显式选择"用本地覆盖共享" → 两边一致且冲突清除
  await core.resolveSettingsConflict(root, meta, 'use-local');
  assert.equal(await readText(sharedFile), 'local-only: true\n');
  assert.equal(await readText(settingsFile), 'local-only: true\n');
  assert.deepEqual(core.listShareConflicts(meta.id), []);

  // E. 调用方选择"用共享覆盖本地" → 先备份本地再覆盖
  await writeTextAtomic(sharedFile, 'from-shared: 1\n');
  await core.resolveSettingsConflict(root, meta, 'use-shared');
  assert.equal(await readText(settingsFile), 'from-shared: 1\n');
  const backups = (await fs.readdir(path.dirname(settingsFile))).filter((name) => name.startsWith('settings.yaml.bak-'));
  assert.ok(backups.length >= 1, '覆盖本地设置前必须留下备份');
});

test('applyShareModes：credentials inherit 从主 home 复制', async (t) => {
  const root = await setup(t, 'instance-credentials');
  const primaryHome = path.join(root, 'primary-home');
  await fs.mkdir(primaryHome, { recursive: true });
  await writeTextAtomic(path.join(primaryHome, '.credentials.yaml'), 'token: abc\n');
  const meta = await core.createInstance(root, { name: '凭证实例', engineVersion: '9.9.9', template: 'web' });
  await core.applyShareModes(root, meta, { ...CONFIG, primaryHome });
  assert.equal(await readText(path.join(root, 'instances', meta.dirName, 'home', '.credentials.yaml')), 'token: abc\n');
  // local 模式不动实例凭证
  await writeTextAtomic(path.join(root, 'instances', meta.dirName, 'home', '.credentials.yaml'), 'token: mine\n');
  await core.applyShareModes(root, { ...meta, credentials: { mode: 'local' } }, { ...CONFIG, primaryHome });
  assert.equal(await readText(path.join(root, 'instances', meta.dirName, 'home', '.credentials.yaml')), 'token: mine\n');
});

test('core 单例暴露契约中的实例方法', async () => {
  for (const name of ['listInstances', 'createInstance', 'readInstance', 'updateInstance', 'deleteInstance', 'applyShareModes']) {
    assert.equal(typeof core[name], 'function', `core.${name} 应为函数`);
  }
});

await run();
