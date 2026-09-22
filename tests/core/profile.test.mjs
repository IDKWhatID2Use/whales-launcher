/**
 * profile 清单 / 组合包开关 / 设置读写测试
 *
 * 覆盖：插件清单（已启用组合包 + 随安装提供但未启用的组合包 + 依赖安装状态）、
 * 组合包启用禁用（顺序即 patch 叠加顺序）、设置 YAML 校验与共享同步、
 * patch 文件备份语义。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, readJsonFile, run, test } from './_helpers.mjs';

const { core, profile: profileModule, fsx } = await loadCoreModule();
const { readProfileManifest, writeProfileManifest, readBundles, backupPatchFile, writePatchFile, readPatchFile, copyProfileFiles } = profileModule;
const { pathExists, readText } = fsx;

/** 构造一个含 profile 与引擎（内置组合包）的临时根目录。 */
async function setup(t, label = 'profile') {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  const profileDir = path.join(root, 'instances', 'demo', 'home', 'profiles', 'main');
  await fs.mkdir(profileDir, { recursive: true });
  await writeProfileManifest(profileDir, {
    name: 'dsh-profile-main',
    private: true,
    dependencies: { 'some-plugin': '^1.2.3', '@scope/bundle-plugin': '~2.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  });
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '# patch\n[]\n');
  await fs.writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');

  // 引擎里的"内置组合包"（声明 dsh.bundle.patch 才会被当成组合包）
  const engineBundles = path.join(root, 'engines', '1.0.0', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  for (const [name, patch] of [
    ['dsh-base', './cordis.patch.yml'],
    ['dsh-web-app', './cordis.patch.yml'],
    ['dsh-experimental-agent-team-profile', './cordis.patch.yml'],
    ['dsh-agent', undefined],
  ]) {
    const dir = path.join(engineBundles, name);
    await fs.mkdir(dir, { recursive: true });
    const manifest = { name: `@deepseek-ai/${name}`, version: '1.0.0', description: `${name} 描述` };
    if (patch) manifest.dsh = { bundle: { patch } };
    await fs.writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // profile 内已安装的插件
  const installed = path.join(profileDir, 'node_modules', 'some-plugin');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'package.json'), `${JSON.stringify({ name: 'some-plugin', version: '1.2.5' }, null, 2)}\n`);

  const meta = {
    schemaVersion: 1,
    id: 'id-demo',
    name: 'demo',
    dirName: 'demo',
    icon: null,
    color: '#5B8DEF',
    note: '',
    engine: { version: '1.0.0' },
    profile: { name: 'main', template: 'web' },
    workspace: { mode: 'local' },
    saves: { mode: 'local' },
    settings: { mode: 'local' },
    credentials: { mode: 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLaunchedAt: null,
    launchCount: 0,
  };
  return { root, profileDir, meta };
}

test('readProfileManifest / writeProfileManifest：2 空格 + 末尾换行', async (t) => {
  const { profileDir } = await setup(t);
  const raw = await readText(path.join(profileDir, 'package.json'));
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.includes('\n  "private": true'), '应为 2 空格缩进');
  const manifest = await readProfileManifest(profileDir);
  assert.deepEqual(readBundles(manifest), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.equal(await readProfileManifest(path.join(profileDir, 'missing')), null);
});

test('readProfileInventory：组合包 + 未启用内置组合包 + 依赖', async (t) => {
  const { root, meta } = await setup(t, 'profile-inventory');
  const inventory = await core.readProfileInventory(root, meta);
  assert.equal(inventory.profileDir, path.join(root, 'instances', 'demo', 'home', 'profiles', 'main'));
  const byName = new Map(inventory.bundles.map((item) => [item.name, item]));
  assert.equal(byName.get('@deepseek-ai/dsh-base').enabled, true);
  assert.equal(byName.get('@deepseek-ai/dsh-base').builtin, true);
  assert.equal(byName.get('@deepseek-ai/dsh-base').version, '1.0.0');
  assert.equal(byName.get('@deepseek-ai/dsh-base').description, 'dsh-base 描述');
  assert.equal(byName.get('@deepseek-ai/dsh-web-app').enabled, true);
  // 随安装提供但未启用的组合包应列出来（UI 才能开启）
  const optional = byName.get('@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.equal(optional.enabled, false);
  assert.equal(optional.builtin, true);
  // 未声明 dsh.bundle.patch 的包不是组合包
  assert.equal(byName.has('@deepseek-ai/dsh-agent'), false);

  const deps = new Map(inventory.dependencies.map((item) => [item.name, item]));
  assert.equal(deps.get('some-plugin').installed, true);
  assert.equal(deps.get('some-plugin').version, '1.2.5');
  assert.equal(deps.get('@scope/bundle-plugin').installed, false);
  assert.equal(deps.get('@scope/bundle-plugin').version, '~2.0.0');
});

test('readProfileInventory：profile 缺失时抛错', async (t) => {
  const root = await makeTempRoot('profile-missing');
  t.after(() => cleanup(root));
  const meta = { dirName: 'nope', profile: { name: 'main', template: 'web' }, engine: { version: '1.0.0' } };
  await assert.rejects(() => core.readProfileInventory(root, meta), /profile 清单不存在/);
});

test('setBundleEnabled：追加 / 移除 / 幂等 / 非法包名', async (t) => {
  const { root, profileDir, meta } = await setup(t, 'profile-toggle');
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-experimental-agent-team-profile', true);
  assert.deepEqual(readBundles(await readProfileManifest(profileDir)), [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
  ]);
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-base', false);
  assert.deepEqual(readBundles(await readProfileManifest(profileDir)), [
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
  ]);
  const before = await readText(path.join(profileDir, 'package.json'));
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-base', false);
  assert.equal(await readText(path.join(profileDir, 'package.json')), before, '重复禁用应无副作用');
  await assert.rejects(() => core.setBundleEnabled(root, meta, 'bad name!', true), /不合法/);
  // 其它字段必须原样保留
  const manifest = await readProfileManifest(profileDir);
  assert.deepEqual(manifest.dependencies, { 'some-plugin': '^1.2.3', '@scope/bundle-plugin': '~2.0.0' });
  assert.equal(manifest.name, 'dsh-profile-main');
});

test('设置读写：YAML 校验、往返、缺失返回空串', async (t) => {
  const { root, meta } = await setup(t, 'profile-settings');
  assert.equal(await core.readInstanceSettings(root, meta), '');
  await core.writeInstanceSettings(root, meta, 'agent-default-model:\n  model: deepseek\n');
  assert.equal(await core.readInstanceSettings(root, meta), 'agent-default-model:\n  model: deepseek\n');
  const before = await core.readInstanceSettings(root, meta);
  await assert.rejects(() => core.writeInstanceSettings(root, meta, 'a: [1, 2\n'), /YAML 语法错误/);
  assert.equal(await core.readInstanceSettings(root, meta), before, '语法错误时不得写入');
  await core.writeInstanceSettings(root, meta, '');
  assert.equal(await core.readInstanceSettings(root, meta), '');
});

test('设置读写：CR/CRLF 换行一律归一为 LF（否则 dsh 的 yaml 解析器拒绝整份文件）', async (t) => {
  const { root, meta } = await setup(t, 'profile-settings-crlf');
  const crlf = 'pet:\r\n  visible: true\r\n  size: 160\r\n';
  await core.writeInstanceSettings(root, meta, crlf);
  const written = await core.readInstanceSettings(root, meta);
  assert.equal(written, 'pet:\n  visible: true\n  size: 160\n');
  assert.equal(written.includes('\r'), false);

  // 孤立的 CR（旧版编辑器落盘的形态）：归一后必须是合法且可被 dsh 读到的 YAML
  await core.writeInstanceSettings(root, meta, 'pet:\r  visible: true\r');
  assert.equal(await core.readInstanceSettings(root, meta), 'pet:\n  visible: true\n');
});

test('validateYaml：拒绝孤立 CR（js-yaml 放行，dsh 的解析器不放行）', async (t) => {
  await setup(t, 'profile-yaml-cr');
  assert.equal(profileModule.validateYaml('a:\n  b: 1\n'), null);
  assert.equal(profileModule.validateYaml('a:\r\n  b: 1\r\n'), null);
  const problem = profileModule.validateYaml('a:\r  b: 1\r');
  assert.ok(problem !== null && problem.includes('孤立的 CR'), `应报孤立 CR，实际：${problem}`);

  // 归一后再校验就是合法的 —— 与 writeInstanceSettings 的实际顺序一致
  assert.equal(profileModule.validateYaml(profileModule.toLf('a:\r  b: 1\r')), null);
});

test('patch 文件：备份改名 + 拒绝写空内容', async (t) => {
  const { profileDir } = await setup(t, 'profile-patch');
  assert.equal(await readPatchFile(profileDir), '# patch\n[]\n');
  const first = await backupPatchFile(profileDir);
  assert.ok(first.endsWith('.bak-' + first.split('.bak-')[1]));
  assert.equal(await pathExists(path.join(profileDir, 'cordis.patch.yml')), false);
  assert.equal(await readText(first), '# patch\n[]\n');
  assert.equal(await backupPatchFile(profileDir), null, '文件已不存在时返回 null');
  await assert.rejects(() => writePatchFile(profileDir, '   \n'), /不能为空/);
  await writePatchFile(profileDir, '[]\n');
  assert.equal(await readText(path.join(profileDir, 'cordis.patch.yml')), '[]\n');
});

test('copyProfileFiles：只复制存在的文件', async (t) => {
  const { profileDir } = await setup(t, 'profile-copy');
  const target = path.join(profileDir, '..', 'copy-target');
  const copied = await copyProfileFiles(profileDir, target);
  assert.deepEqual([...copied].sort(), ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']);
  const manifest = await readJsonFile(path.join(target, 'package.json'));
  assert.equal(manifest.name, 'dsh-profile-main');
});

test('core 单例暴露契约中的 profile/设置方法', async () => {
  for (const name of ['readProfileInventory', 'readInstanceSettings', 'writeInstanceSettings', 'setBundleEnabled']) {
    assert.equal(typeof core[name], 'function', `core.${name} 应为函数`);
  }
});

await run();
