/**
 * 引擎（dsh 版本）枚举与解析测试
 *
 * 用两个"假引擎"目录验证枚举、排序、binPath 解析、usedBy 归属与删除保护；
 * 另覆盖离线接入（junction）与版本号比较。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, run, test } from './_helpers.mjs';

const { core, paths: corePathsModule, engine: engineModule } = await loadCoreModule();
const { enginePackageDir } = corePathsModule;
const { compareVersions, isValidVersion, attachEngineFromLocal } = engineModule;

test('listEngines：枚举、排序、binPath、sizeBytes（惰性 + 缓存）', async (t) => {
  const root = await makeTempRoot('engine-list');
  t.after(() => cleanup(root));
  await seedStubEngine(root, '0.1.6-alpha.2');
  await seedStubEngine(root, '0.2.0');
  await seedStubEngine(root, '1.0.0-beta.1');
  const engines = await core.listEngines(root);
  assert.deepEqual(engines.map((item) => item.version), ['1.0.0-beta.1', '0.2.0', '0.1.6-alpha.2']);
  for (const info of engines) {
    assert.equal(info.installed, true);
    assert.equal(info.binPath, path.join(enginePackageDir(root, info.version), 'lib', 'bin.js'));
    assert.equal(info.dir, path.join(root, 'engines', info.version));
    assert.deepEqual(info.usedBy, []);
    // QR-08：首次调用不递归统计体积（真实 dsh 551MB/26513 文件一次要 1375ms），返回 null
    assert.equal(info.sizeBytes, null, '首次列表应返回 null（尚未计算体积）');
  }
  // 显式/后台算过一次之后，列表就能给出真实体积
  const size = await engineModule.computeEngineSize(engines[0].dir);
  assert.ok(typeof size === 'number' && size > 0, 'sizeBytes 应为正整数');
  const cached = (await core.listEngines(root)).find((item) => item.version === engines[0].version);
  assert.equal(cached.sizeBytes, size, '缓存后应返回真实体积');
});

test('listEngines：空目录与半成品目录', async (t) => {
  const root = await makeTempRoot('engine-empty');
  t.after(() => cleanup(root));
  assert.deepEqual(await core.listEngines(root), []);
  await fs.mkdir(path.join(root, 'engines', '9.0.0'), { recursive: true });
  assert.deepEqual(await core.listEngines(root), [], '缺少 dsh 包的目录不算已安装');
});

test('listEngines：半安装引擎（有 package.json 无 lib/bin.js）仍列出但 installed=false', async (t) => {
  const root = await makeTempRoot('engine-half');
  t.after(() => cleanup(root));
  // 只放 manifest、不放入口：真实世界对应"npm 装到一半 / 被手工删了 lib"
  const packageDir = path.join(root, 'engines', '3.0.0', 'node_modules', '@deepseek-ai', 'dsh');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '3.0.0' }, null, 2)}\n`);

  const engines = await core.listEngines(root);
  assert.equal(engines.length, 1, '版本信息可读时必须列出（否则用户看不到这个坏安装）');
  assert.equal(engines[0].version, '3.0.0');
  assert.equal(engines[0].installed, false, '"已安装"要求 package.json 与 lib/bin.js 同时存在');
  assert.equal(engines[0].binPath, null);
  assert.equal(core.resolveEngineBin(root, '3.0.0'), null);
  // 补上入口后即视为已安装
  await fs.mkdir(path.join(packageDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'lib', 'bin.js'), '// stub\n');
  const repaired = (await core.listEngines(root))[0];
  assert.equal(repaired.installed, true);
  assert.equal(repaired.binPath, path.join(packageDir, 'lib', 'bin.js'));
  // 半安装引擎不得被实例绑定（否则启动必然失败）
  const instance = await core.createInstance(root, { name: '半安装', engineVersion: '9.9.9', template: 'web' }).catch(() => null);
  assert.equal(instance, null, '没有可用引擎时创建实例必须失败');
});

test('resolveEngineBin：命中 / 未安装', async (t) => {
  const root = await makeTempRoot('engine-resolve');
  t.after(() => cleanup(root));
  await seedStubEngine(root, '1.2.3');
  assert.equal(core.resolveEngineBin(root, '1.2.3'), path.join(enginePackageDir(root, '1.2.3'), 'lib', 'bin.js'));
  assert.equal(core.resolveEngineBin(root, '9.9.9'), null);
});

test('listEngines：usedBy 反映实例绑定', async (t) => {
  const root = await makeTempRoot('engine-usedby');
  t.after(() => cleanup(root));
  await seedStubEngine(root, '1.0.0');
  await seedStubEngine(root, '2.0.0');
  const first = await core.createInstance(root, { name: '甲', engineVersion: '1.0.0', template: 'web' });
  const second = await core.createInstance(root, { name: '乙', engineVersion: '1.0.0', template: 'web' });
  await core.createInstance(root, { name: '丙', engineVersion: '2.0.0', template: 'web' });
  const engines = await core.listEngines(root);
  const one = engines.find((item) => item.version === '1.0.0');
  const two = engines.find((item) => item.version === '2.0.0');
  assert.deepEqual([...one.usedBy].sort(), [first.id, second.id].sort());
  assert.equal(two.usedBy.length, 1);
});

test('removeEngine：被引用时拒绝，无引用时删除；越界路径拒绝', async (t) => {
  const root = await makeTempRoot('engine-remove');
  t.after(() => cleanup(root));
  await seedStubEngine(root, '1.0.0');
  await seedStubEngine(root, '2.0.0');
  const meta = await core.createInstance(root, { name: '引用者', engineVersion: '1.0.0', template: 'web' });
  await assert.rejects(() => core.removeEngine(root, '1.0.0'), /仍被 1 个实例使用/);
  await core.removeEngine(root, '2.0.0');
  assert.deepEqual((await core.listEngines(root)).map((item) => item.version), ['1.0.0']);
  await core.deleteInstance(root, meta.id, true);
  await core.removeEngine(root, '1.0.0');
  assert.deepEqual(await core.listEngines(root), []);
  await assert.rejects(() => core.removeEngine(root, '..\\..\\evil'), /拒绝删除|不存在/);
});

test('attachEngineFromLocal：用 junction 离线接入而且不复制文件', async (t) => {
  const root = await makeTempRoot('engine-attach');
  t.after(() => cleanup(root));
  const external = path.join(root, 'external', 'dsh-package');
  await fs.mkdir(path.join(external, 'lib'), { recursive: true });
  await fs.writeFile(path.join(external, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '7.7.7' }, null, 2)}\n`);
  await fs.writeFile(path.join(external, 'lib', 'bin.js'), '// stub\n');
  const info = await attachEngineFromLocal(root, external);
  assert.equal(info.version, '7.7.7');
  assert.equal(info.installed, true);
  assert.equal(info.binPath, path.join(enginePackageDir(root, '7.7.7'), 'lib', 'bin.js'));
  assert.equal(await core.pathExists(info.binPath), true);
  const linked = path.join(root, 'engines', '7.7.7', 'node_modules', '@deepseek-ai', 'dsh');
  assert.equal(await core.isLink(linked), true, '接入应使用 junction');
  assert.deepEqual((await fs.readdir(external)).sort(), ['lib', 'package.json']);
  await assert.rejects(() => attachEngineFromLocal(root, path.join(root, 'external')), /不是有效的 dsh 包目录|期望包名/);
});

test('attachEngineFromLocal：包名不符时拒绝', async (t) => {
  const root = await makeTempRoot('engine-attach-bad');
  t.after(() => cleanup(root));
  const external = path.join(root, 'external');
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, 'package.json'), `${JSON.stringify({ name: 'not-dsh', version: '1.0.0' }, null, 2)}\n`);
  await assert.rejects(() => attachEngineFromLocal(root, external), /期望包名/);
});

test('版本号校验与比较', () => {
  for (const version of ['0.1.6-alpha.2', '1.0.0', '2.0.0-rc.1']) assert.equal(isValidVersion(version), true, version);
  for (const version of ['', '1.0.0 && rm -rf', '1.0.0;ls', 'a b', 'x'.repeat(65)]) assert.equal(isValidVersion(version), false, version);
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0, '正式版大于预发布');
  assert.ok(compareVersions('0.1.6-alpha.2', '0.1.6-alpha.10') < 0, '预发布段按字典序');
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('core 单例暴露契约中的引擎方法', async () => {
  for (const name of ['listEngines', 'listAvailableEngines', 'installEngine', 'removeEngine', 'resolveEngineBin']) {
    assert.equal(typeof core[name], 'function', `core.${name} 应为函数`);
  }
});

await run();
