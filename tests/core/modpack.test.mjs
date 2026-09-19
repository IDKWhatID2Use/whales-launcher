/**
 * 实例包（整合包）导入导出测试
 *
 * 导出：zip 内容与包元数据（requirements / bundles / instance）。
 * 导入：解压 → 建实例 → 还原 patch/设置/依赖清单；依赖重装失败只记警告。
 * 用"假 dsh"驱动创建流程，因此不联网也能跑。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import { cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, run, test } from './_helpers.mjs';

/**
 * 手工构造 STORE 方式的 zip。
 *
 * 为什么要自己写：`adm-zip` 会在 `addFile` 时**规范化**条目名（实测 `../../escaped.txt`
 * 会变成 `escaped.txt`），因此无法用它构造 zip-slip 样本；这里直接按 ZIP 规范拼字节，
 * 才能真实检验解压侧越界路径防护。
 * @param {[string, string][]} entries 条目名与文本内容。
 * @returns {Buffer} zip 内容。
 */
function buildRawZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuffer, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuffer, end]);
}

const { core, modpack, fsx } = await loadCoreModule();
const { readPackManifest, PACK_MANIFEST_NAME } = modpack;
const { readText, pathExists } = fsx;

const CONFIG = {
  schemaVersion: 1,
  primaryHome: 'C:\\Users\\tester\\.dsh',
  theme: 'dark',
  lastInstanceId: null,
  confirmOnDelete: true,
  engineRegistry: 'https://registry.npmjs.org',
};

/** 建根目录 + 一个"有内容"的实例（依赖、patch、设置齐全）。 */
async function setupInstance(t, label = 'pack') {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: '整合包实例',
    icon: '🐳',
    color: '#224466',
    note: '导出用',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'));
  manifest.dependencies = { 'demo-plugin': '^1.0.0' };
  await fs.writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '# 自定义 patch\n- id: demo\n  disabled: true\n');
  await core.writeInstanceSettings(root, meta, 'agent-default-model:\n  model: deepseek\n');
  return { root, meta, profileDir };
}

test('exportPack：zip 内容与包元数据正确', async (t) => {
  const { root, meta } = await setupInstance(t);
  const outFile = path.join(root, 'exports', 'my-pack.zip');
  const written = await core.exportPack(root, meta, outFile, '1.0.0');
  assert.equal(written, outFile);
  assert.equal(await pathExists(outFile), true);

  const zip = new AdmZip(outFile);
  const names = zip.getEntries().map((entry) => entry.entryName).sort();
  assert.deepEqual(names, [
    'README.md',
    `home/profiles/${meta.profile.name}/cordis.patch.yml`,
    `home/profiles/${meta.profile.name}/package.json`,
    'home/settings.yaml',
    PACK_MANIFEST_NAME,
  ].sort());
  assert.equal(names.some((name) => name.includes('node_modules')), false, '不得包含 node_modules');

  const pack = await readPackManifest(outFile);
  assert.equal(pack.kind, 'whalelauncher-pack');
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.launcherVersion, '1.0.0');
  assert.equal(pack.instance.name, '整合包实例');
  assert.equal(pack.instance.icon, '🐳');
  assert.equal(pack.instance.engine.version, '9.9.9');
  assert.equal(pack.instance.profile.name, meta.profile.name);
  assert.deepEqual(pack.requirements, { 'demo-plugin': '^1.0.0' });
  assert.deepEqual(pack.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  const readme = zip.getEntry('README.md').getData().toString('utf8');
  assert.ok(readme.includes('demo-plugin@^1.0.0'));
});

test('exportPack：profile 缺失时抛错', async (t) => {
  const root = await makeTempRoot('pack-missing');
  t.after(() => cleanup(root));
  await assert.rejects(
    () => core.exportPack(root, { dirName: 'nope', profile: { name: 'main', template: 'web' }, engine: { version: '9.9.9' } }, path.join(root, 'x.zip'), '1.0.0'),
    /profile 清单不存在/,
  );
});

test('importPack：还原设置/patch/依赖清单，并把重装失败记为警告', async (t) => {
  const { root, meta } = await setupInstance(t, 'pack-import-src');
  const outFile = await core.exportPack(root, meta, path.join(root, 'exports', 'pack.zip'), '1.0.0');

  const other = await makeTempRoot('pack-import-dst');
  t.after(() => cleanup(other));
  await seedStubEngine(other, '8.8.8');

  const result = await core.importPack(other, outFile, CONFIG);
  assert.equal(result.name, '整合包实例');
  const imported = await core.readInstance(other, result.instanceId);
  assert.ok(imported !== null);
  assert.equal(imported.icon, '🐳');
  assert.equal(imported.color, '#224466');
  assert.equal(imported.note, '导出用');
  assert.equal(imported.engine.version, '8.8.8', '引擎缺失时应回退到本地可用引擎');
  assert.ok(result.warnings.some((line) => line.includes('引擎 9.9.9 未安装')), `应提示引擎回退：${JSON.stringify(result.warnings)}`);
  assert.ok(result.warnings.some((line) => line.includes('demo-plugin')), '假 dsh 不支持 plugin，应记为依赖重装警告');

  const profileDir = path.join(other, 'instances', imported.dirName, 'home', 'profiles', imported.profile.name);
  const manifest = await readJsonFile(path.join(profileDir, 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.deepEqual(manifest.dependencies, { 'demo-plugin': '^1.0.0' });
  assert.equal(manifest.name, `dsh-profile-${imported.dirName}`, 'profile 清单名应与新目录一致');
  assert.equal(await readText(path.join(profileDir, 'cordis.patch.yml')), '# 自定义 patch\n- id: demo\n  disabled: true\n');
  assert.equal(await core.readInstanceSettings(other, imported), 'agent-default-model:\n  model: deepseek\n');
  assert.deepEqual((await core.listInstances(other)).map((item) => item.meta.id), [result.instanceId]);
});

test('importPack：同名实例自动改目录名（不覆盖已有实例）', async (t) => {
  const { root, meta } = await setupInstance(t, 'pack-dup-src');
  const outFile = await core.exportPack(root, meta, path.join(root, 'exports', 'pack.zip'), '1.0.0');
  const result = await core.importPack(root, outFile, CONFIG);
  const imported = await core.readInstance(root, result.instanceId);
  assert.notEqual(imported.dirName, meta.dirName);
  assert.equal(imported.name, meta.name);
  assert.equal((await core.listInstances(root)).length, 2);
});

test('importPack：非法输入被拒绝', async (t) => {
  const root = await makeTempRoot('pack-bad');
  t.after(() => cleanup(root));
  await assert.rejects(() => core.importPack(root, path.join(root, 'missing.zip'), CONFIG), /包文件不存在/);

  const notPack = path.join(root, 'not-a-pack.zip');
  const zip = new AdmZip();
  zip.addFile('random.txt', Buffer.from('x'));
  zip.writeZip(notPack);
  await assert.rejects(() => core.importPack(root, notPack, CONFIG), /不是有效的实例包/);

  const future = path.join(root, 'future.zip');
  const zip2 = new AdmZip();
  zip2.addFile(PACK_MANIFEST_NAME, Buffer.from(JSON.stringify({ kind: 'whalelauncher-pack', schemaVersion: 99, instance: {} })));
  zip2.writeZip(future);
  await assert.rejects(() => core.importPack(root, future, CONFIG), /版本过新/);
});

test('importPack：包内越界路径被拒绝（zip-slip 防护）', async (t) => {
  const root = await makeTempRoot('pack-slip');
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const evil = path.join(root, 'evil.zip');
  const manifest = JSON.stringify({
    kind: 'whalelauncher-pack',
    schemaVersion: 1,
    instance: { name: '恶意包', engine: { version: '9.9.9' }, profile: { name: 'main', template: 'web' }, launch: {} },
  });
  // 手工构造带 `../..` 条目名的 zip（adm-zip 的 addFile 会规范化，无法用它造样本）
  await fs.writeFile(
    evil,
    buildRawZip([
      [PACK_MANIFEST_NAME, manifest],
      ['../../escaped.txt', 'escaped'],
    ]),
  );
  const probe = new AdmZip(evil).getEntries().map((entry) => entry.entryName);
  assert.ok(probe.includes('../../escaped.txt'), `样本 zip 必须保留越界条目名，实际：${probe.join(', ')}`);
  await assert.rejects(() => core.importPack(root, evil, CONFIG), /越界路径/);
  assert.equal(await pathExists(path.join(path.dirname(root), 'escaped.txt')), false);
});

test('core 单例暴露契约中的导入导出方法', async () => {
  assert.equal(typeof core.exportPack, 'function');
  assert.equal(typeof core.importPack, 'function');
});

await run();
