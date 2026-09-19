/**
 * 真实 dsh 集成测试（找不到 dsh 时自动跳过）
 *
 * 这是任务验收里"用真实 dsh 手动验证黄金路径"的自动化版本：把一个真实安装的
 * `@deepseek-ai/dsh` 用 junction 接入 `engines/`（不复制、不联网），然后调用
 * `core.createInstance` 走真实的 `--dump-config` 初始化路径。
 *
 * 断言依据（dsh 源码 + 实测）：
 *  - `dsh --profile <p> --from-default-profile web --dump-config` 退出码 0，
 *    生成 package.json / cordis.patch.yml / cordis.yml / pnpm-workspace.yaml；
 *  - `dsh.profile.bundles` 与随附模板一致；
 *  - **不创建** `<home>/profiles/node_modules`（该 fallback 由启动路径建立）；
 *  - `cordis.patch.yml` 内容为 `[]`（空文件会导致启动失败）。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BUNDLE_TEMPLATES } from '../../src/shared/contracts.ts';
import { cleanup, findRealDshPackage, loadCoreModule, makeTempRoot, readJsonFile, run, test } from './_helpers.mjs';

const { core } = await loadCoreModule();

test('真实 dsh：createInstance 走黄金路径，profile 与模板一致', async (t) => {
  const root = await makeTempRoot('real-dsh');
  t.after(() => cleanup(root));
  const dshDir = await findRealDshPackage(root);
  if (dshDir === null) {
    t.skip('本机未找到真实 @deepseek-ai/dsh 安装，跳过');
    return;
  }
  const engine = await core.attachEngineFromLocal(root, dshDir);
  const logs = [];
  const meta = await core.createInstance(
    root,
    { name: '真实实例', engineVersion: engine.version, template: 'web' },
    { onLog: (stream, text) => logs.push(`${stream}${text}`) },
  );
  const home = path.join(root, 'instances', meta.dirName, 'home');
  const profileDir = path.join(home, 'profiles', meta.profile.name);

  const manifest = await readJsonFile(path.join(profileDir, 'package.json'));
  assert.deepEqual(
    manifest.dsh.profile.bundles,
    BUNDLE_TEMPLATES.web,
    'dsh.profile.bundles 必须与 web 模板一致',
  );
  assert.equal(manifest.name, `dsh-profile-${meta.profile.name}`);
  const patch = await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('[]'), 'cordis.patch.yml 必须含空数组（空文件会导致启动失败）');
  assert.equal(await core.pathExists(path.join(profileDir, 'pnpm-workspace.yaml')), true);
  assert.equal(await core.pathExists(path.join(profileDir, 'cordis.yml')), true, '组合根 cordis.yml 应由 dump-config 生成');
  assert.equal(
    await core.pathExists(path.join(home, 'profiles', 'node_modules')),
    false,
    'dump-config 不创建 profiles/node_modules（由 dsh 启动时自行建立，启动器不得越权）',
  );
  assert.ok(logs.some((line) => line.includes('--dump-config')), '日志应包含黄金路径命令');

  const summary = (await core.listInstances(root)).find((item) => item.meta.id === meta.id);
  assert.equal(summary.present, true);
  assert.equal(summary.engineInstalled, true);
  assert.equal(summary.pluginCount, 0);
  assert.equal(summary.runtime.state, 'stopped');

  const inventory = await core.readProfileInventory(root, meta);
  assert.deepEqual(
    inventory.bundles.filter((item) => item.enabled).map((item) => item.name),
    BUNDLE_TEMPLATES.web,
  );
  const optional = inventory.bundles.filter((item) => !item.enabled && item.builtin);
  assert.ok(optional.length > 0, '随 dsh 安装提供、默认关闭的组合包应可被 UI 列出并开启');
  assert.ok(
    optional.some((item) => item.name === '@deepseek-ai/dsh-experimental-agent-team-profile'),
    '应识别出实验性 agent-team 组合包',
  );

  // 组合包开关：真机上改 bundles 列表（不安装任何东西）
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-experimental-agent-team-profile', true);
  const toggled = await readJsonFile(path.join(profileDir, 'package.json'));
  assert.ok(toggled.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-agent-team-profile'));

  // 导出实例包（不联网）
  const outFile = await core.exportPack(root, meta, path.join(root, 'exports', 'real.zip'), '1.0.0');
  assert.equal(await core.pathExists(outFile), true);
});

test('真实 dsh：shipped 模板名作为实例名时仍能创建', async (t) => {
  const root = await makeTempRoot('real-dsh-shipped');
  t.after(() => cleanup(root));
  const dshDir = await findRealDshPackage(root);
  if (dshDir === null) {
    t.skip('本机未找到真实 @deepseek-ai/dsh 安装，跳过');
    return;
  }
  const engine = await core.attachEngineFromLocal(root, dshDir);
  const meta = await core.createInstance(root, { name: '网页', dirName: 'web', engineVersion: engine.version, template: 'web' });
  const manifest = await readJsonFile(path.join(root, 'instances', meta.dirName, 'home', 'profiles', 'web', 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, BUNDLE_TEMPLATES.web);
});

test('真实 dsh：引擎入口可解析且版本一致', async (t) => {
  const root = await makeTempRoot('real-dsh-bin');
  t.after(() => cleanup(root));
  const dshDir = await findRealDshPackage(root);
  if (dshDir === null) {
    t.skip('本机未找到真实 @deepseek-ai/dsh 安装，跳过');
    return;
  }
  const manifest = await readJsonFile(path.join(dshDir, 'package.json'));
  const engine = await core.attachEngineFromLocal(root, dshDir);
  assert.equal(engine.version, manifest.version);
  const bin = core.resolveEngineBin(root, engine.version);
  assert.ok(bin !== null && bin.endsWith(path.join('lib', 'bin.js')));
  assert.equal(await core.pathExists(bin), true);
  const listed = (await core.listEngines(root)).find((item) => item.version === engine.version);
  assert.equal(listed.installed, true);
  assert.deepEqual(listed.usedBy, []);
});

test('可选：查询 npm 上的可安装版本（需 WHALES_TEST_REGISTRY=1）', async (t) => {
  if (process.env.WHALES_TEST_REGISTRY !== '1') {
    t.skip('默认跳过联网用例（设置 WHALES_TEST_REGISTRY=1 启用）');
    return;
  }
  const root = await makeTempRoot('registry');
  t.after(() => cleanup(root));
  const versions = await core.listAvailableEngines('https://registry.npmjs.org');
  assert.ok(Array.isArray(versions) && versions.length > 0);
  assert.ok(versions.every((version) => typeof version === 'string'));
});

await run();
