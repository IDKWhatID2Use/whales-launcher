/**
 * 本地插件安装测试（`core/plugin-packs.ts`）
 *
 * 覆盖用户实际会走的四条路径：
 *  1. zip 压缩包 → 解压到 `<实例>/home/plugins/<名>`，依赖写成**相对** `file:`，可整体搬运；
 *  2. 压缩包越界路径（zip-slip）必须被拒绝，且一个字节都不能落到目标之外；
 *  3. 包内没有 `dsh.bundle.patch` 时以普通依赖安装并**不**登记进 bundles；
 *  4. 卸载要把依赖、bundles 登记和实例内目录一起清掉（否则悬空链接会堵死该 profile）。
 *
 * 引擎用 `_helpers.mjs` 的假 dsh（它的 plugin 子命令会把依赖链进 node_modules），
 * 因此不联网、不需要真实 pnpm 即可端到端验证。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import yaml from 'js-yaml';
import {
  cleanup,
  loadCore,
  loadCoreModule,
  makeTempRoot,
  readJsonFile,
  run,
  seedStubEngine,
  test,
} from './_helpers.mjs';

/** core 暴露的内部工具（纯函数，不需要引擎即可验证）。 */
async function pluginTestApi() {
  const module = await loadCoreModule();
  const api = module.pluginPacksTest;
  assert.ok(api, 'core 必须导出 pluginPacksTest（否则纯函数用例会静默失效）');
  return api;
}

/** 解析 YAML（断言配置文件内容用）。 */
function yamlLoad(text) {
  return yaml.load(text);
}

/**
 * 手工构造 STORE 方式的 zip（`adm-zip` 会规范化条目名，造不出 zip-slip 样本）。
 *
 * 注意：本地文件头与中央目录的字段必须写全 —— 省略时间/标志/压缩方式会让
 * adm-zip 解析出 0 个条目（实测踩过），那样测试会以「找不到 package.json」的
 * 假象失败，掩盖真正要验证的行为。
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
  return Buffer.concat([...parts, centralBuffer, end]);
}

/**
 * 造一个「插件包」的 zip。
 * @param {string} prefix 包内前缀（空串表示根目录直接放文件）。
 * @param {Record<string, string>} files 相对路径 → 内容。
 * @param {string} file 输出 zip 路径。
 */
async function writePluginZip(prefix, files, file) {
  const entries = Object.entries(files).map(([rel, content]) => [
    prefix.length > 0 ? `${prefix}/${rel}` : rel,
    content,
  ]);
  await fs.writeFile(file, buildRawZip(entries));
  return file;
}

/** 标准可用的插件包内容（声明了 dsh.bundle.patch 且 patch 文件存在）。 */
const GOOD_PLUGIN_FILES = {
  'package.json': JSON.stringify({
    name: 'demo-plugin',
    version: '1.2.3',
    description: '演示插件',
    type: 'module',
    main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }),
  'cordis.patch.yml': "- insert:\n    - id: demo-plugin\n      name: 'demo-plugin'\n",
  'index.js': 'export const name = "demo-plugin";\nexport function apply() {}\n',
};

/** 建一个装了 stub 引擎、profile 已初始化的实例。 */
async function seedInstance(root, core, label = '插件测试') {
  await seedStubEngine(root, '9.9.9');
  return core.createInstance(root, {
    name: label,
    dirName: 'inst',
    engineVersion: '9.9.9',
    template: 'web',
  });
}

/** 读取 profile 清单。 */
async function readManifest(root, meta) {
  return readJsonFile(
    path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'package.json'),
  );
}

/* ------------------------------------------------------------------ *
 * 纯函数：GitHub 地址解析
 * ------------------------------------------------------------------ */

test('parseGithubUrl：URL / SSH / 简写 / 带 ref 都能解析', async () => {
  const __test = await pluginTestApi();
  const cases = [
    ['https://github.com/owner/repo', 'owner', 'repo', null],
    ['https://github.com/owner/repo.git', 'owner', 'repo', null],
    ['http://www.github.com/owner/repo', 'owner', 'repo', null],
    ['https://github.com/owner/repo/tree/main', 'owner', 'repo', 'main'],
    ['https://github.com/owner/repo/tree/feature/x', 'owner', 'repo', 'feature'],
    ['https://github.com/owner/repo#v1.2.3', 'owner', 'repo', 'v1.2.3'],
    ['git@github.com:owner/repo.git', 'owner', 'repo', null],
    ['git+https://github.com/owner/repo', 'owner', 'repo', null],
    ['owner/repo', 'owner', 'repo', null],
    ['owner/repo#dev', 'owner', 'repo', 'dev'],
    // 从 dsh 日志 / pnpm 输出里复制过来的写法也必须能解析
    ['github:owner/repo', 'owner', 'repo', null],
    ['github:owner/repo#v1.0.0', 'owner', 'repo', 'v1.0.0'],
    ['github:dsh-market/dsh-market', 'dsh-market', 'dsh-market', null],
  ];
  for (const [input, owner, name, ref] of cases) {
    const parsed = __test.parseGithubUrl(input);
    assert.equal(parsed.owner, owner, `${input} 的 owner`);
    assert.equal(parsed.name, name, `${input} 的仓库名`);
    assert.equal(parsed.ref, ref, `${input} 的 ref`);
  }
});

test('parseGithubUrl：非 GitHub 地址与空值一律拒绝', async () => {
  const __test = await pluginTestApi();
  for (const bad of ['', '   ', 'https://gitlab.com/owner/repo', 'just-a-word', 'owner/', 'github.com/owner']) {
    assert.throws(() => __test.parseGithubUrl(bad), /无法解析|不能为空/, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test('normalizeRef：空白与首尾斜杠被规范化', async () => {
  const __test = await pluginTestApi();
  assert.equal(__test.normalizeRef(undefined), null);
  assert.equal(__test.normalizeRef('   '), null);
  assert.equal(__test.normalizeRef('///'), null);
  assert.equal(__test.normalizeRef(' /v1.0.0/ '), 'v1.0.0');
});

test('assertPackageName：拒绝路径分隔符等一切会逃出插件目录的名字', async () => {
  const __test = await pluginTestApi();
  for (const good of ['demo-plugin', '@scope/demo-plugin', 'a1.b_c-d']) {
    __test.assertPackageName(good);
  }
  for (const bad of ['..', '../evil', 'a/b', 'a\\b', '', 'D:', 'a b', 'a:b']) {
    assert.throws(() => __test.assertPackageName(bad), /不合法|长度/, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

/* ------------------------------------------------------------------ *
 * 读取包内元数据
 * ------------------------------------------------------------------ */

test('readPluginMeta：识别 bundle patch / client 并给出缺失警告', async (t) => {
  const root = await makeTempRoot('plugin-meta');
  t.after(() => cleanup(root));
  const __test = await pluginTestApi();

  // 完整包
  const full = path.join(root, 'full');
  await fs.mkdir(full, { recursive: true });
  for (const [rel, content] of Object.entries(GOOD_PLUGIN_FILES)) {
    await fs.writeFile(path.join(full, rel), content);
  }
  const good = await __test.readPluginMeta(full);
  assert.equal(good.name, 'demo-plugin');
  assert.equal(good.version, '1.2.3');
  assert.equal(good.bundlePatch, './cordis.patch.yml');
  assert.equal(good.patchFileExists, true);
  assert.equal(good.hasClient, false);
  assert.equal(good.warnings.length, 0);

  // 只有 dsh.client 的纯客户端插件
  const clientOnly = path.join(root, 'client-only');
  await fs.mkdir(clientOnly, { recursive: true });
  await fs.writeFile(
    path.join(clientOnly, 'package.json'),
    JSON.stringify({ name: 'pure-client', version: '0.0.1', dsh: { client: { platform: 'web' } } }),
  );
  const pure = await __test.readPluginMeta(clientOnly);
  assert.equal(pure.bundlePatch, null);
  assert.equal(pure.hasClient, true);
  assert.ok(
    pure.warnings.some((w) => w.includes('dsh.bundle.patch')),
    '缺少 bundle patch 必须给出警告',
  );

  // 声明了 patch 但文件不在 → 警告（实例启动会失败）
  const brokenPatch = path.join(root, 'broken-patch');
  await fs.mkdir(brokenPatch, { recursive: true });
  await fs.writeFile(
    path.join(brokenPatch, 'package.json'),
    JSON.stringify({ name: 'broken', version: '1.0.0', dsh: { bundle: { patch: './missing.yml' } } }),
  );
  const broken = await __test.readPluginMeta(brokenPatch);
  assert.equal(broken.patchFileExists, false);
  assert.ok(broken.warnings.some((w) => w.includes('不存在')));

  // patch 指向包外 → 直接拒绝
  const escapePatch = path.join(root, 'escape-patch');
  await fs.mkdir(escapePatch, { recursive: true });
  await fs.writeFile(
    path.join(escapePatch, 'package.json'),
    JSON.stringify({ name: 'escape', version: '1.0.0', dsh: { bundle: { patch: '../../outside.yml' } } }),
  );
  await assert.rejects(() => __test.readPluginMeta(escapePatch), /包外路径/);
});

/* ------------------------------------------------------------------ *
 * zip 压缩包安装（端到端，走假 dsh）
 * ------------------------------------------------------------------ */

test('zip 安装：落进 home/plugins、依赖写成相对 file:、登记 bundles 并链接生效', async (t) => {
  const root = await makeTempRoot('plugin-zip');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('demo-plugin', GOOD_PLUGIN_FILES, path.join(root, 'demo.zip'));

  const logs = [];
  const result = await core.pluginInstall(
    root,
    meta,
    { kind: 'archive', file: zipFile },
    { nodePath: null },
    (stream, text) => logs.push(`${stream}:${text}`),
  );

  // 1) 落点必须在实例目录内
  const instanceHome = path.join(root, 'instances', meta.dirName, 'home');
  const expectedDir = path.join(instanceHome, 'plugins', 'demo-plugin');
  assert.equal(result.dir, expectedDir, '插件目录');
  assert.ok(result.dir.startsWith(instanceHome), '插件必须落在实例目录内（可整体搬运）');
  assert.equal(await fs.readFile(path.join(expectedDir, 'index.js'), 'utf8'), GOOD_PLUGIN_FILES['index.js']);
  assert.equal(
    await fs.readFile(path.join(expectedDir, 'cordis.patch.yml'), 'utf8'),
    GOOD_PLUGIN_FILES['cordis.patch.yml'],
  );

  // 2) profile 里必须是相对路径（否则换机器就指向旧路径）
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['demo-plugin'], 'file:../../plugins/demo-plugin');
  assert.ok(!path.isAbsolute(manifest.dependencies['demo-plugin'].replace(/^file:/, '')), '依赖不得是绝对路径');
  assert.ok(manifest.dsh.profile.bundles.includes('demo-plugin'), '必须登记进 dsh.profile.bundles');
  assert.equal(result.registeredBundle, true);
  assert.equal(result.spec, 'file:../../plugins/demo-plugin');
  assert.equal(result.version, '1.2.3');

  // 3) 假 dsh 已按依赖建好链接
  assert.equal(result.linked, true, '依赖应已链接进 node_modules');
  const linked = path.join(
    root,
    'instances',
    meta.dirName,
    'home',
    'profiles',
    meta.profile.name,
    'node_modules',
    'demo-plugin',
  );
  assert.equal((await fs.stat(linked)).isDirectory(), true);

  // 4) 来源标记落盘，界面据此区分「随实例搬运」
  const origin = await readJsonFile(path.join(expectedDir, '.whales-plugin.json'));
  assert.equal(origin.origin, 'archive');

  // 5) 清单里能读到该插件
  const local = await core.listInstancePlugins(root, meta);
  assert.equal(local.length, 1);
  assert.equal(local[0].name, 'demo-plugin');
  assert.equal(local[0].enabled, true);
  assert.equal(local[0].hasBundlePatch, true);
  assert.equal(local[0].origin, 'archive');

  // 6) 临时目录必须清干净
  const cacheDir = path.join(root, 'cache');
  const leftovers = (await fs.readdir(cacheDir).catch(() => [])).filter((n) => n.startsWith('plugin-'));
  assert.deepEqual(leftovers, [], '解压临时目录应被清理');
});

test('zip 安装：支持「单一顶层文件夹」包结构', async (t) => {
  const root = await makeTempRoot('plugin-nested');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('my-plugin-1.0.0', GOOD_PLUGIN_FILES, path.join(root, 'nested.zip'));

  const result = await core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null });
  assert.equal(result.name, 'demo-plugin', '插件名取包内 package.json 的 name，而不是 zip 的顶层文件夹名');
  assert.equal(result.dir, path.join(root, 'instances', meta.dirName, 'home', 'plugins', 'demo-plugin'));
});

test('zip 安装：显式指定插件名可覆盖包内 name', async (t) => {
  const root = await makeTempRoot('plugin-rename');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('', GOOD_PLUGIN_FILES, path.join(root, 'flat.zip'));

  const result = await core.pluginInstall(
    root,
    meta,
    { kind: 'archive', file: zipFile, name: 'renamed-plugin' },
    { nodePath: null },
  );
  assert.equal(result.name, 'renamed-plugin');
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['renamed-plugin'], 'file:../../plugins/renamed-plugin');
  assert.ok(manifest.dsh.profile.bundles.includes('renamed-plugin'));
});

test('zip 安装：越界路径（zip-slip）被拒绝，且不落任何文件到目标之外', async (t) => {
  const root = await makeTempRoot('plugin-slip');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const outside = path.join(root, 'escaped.txt');
  assert.equal(await fs.stat(outside).catch(() => null), null);

  const zipFile = path.join(root, 'evil.zip');
  await fs.writeFile(
    zipFile,
    buildRawZip([
      ['package.json', JSON.stringify({ name: 'evil', version: '1.0.0' })],
      ['../../escaped.txt', 'pwned'],
    ]),
  );

  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null }),
    /越界路径/,
  );
  assert.equal(await fs.stat(outside).catch(() => null), null, '越界文件绝不能被写出');
  const pluginsDir = path.join(root, 'instances', meta.dirName, 'home', 'plugins');
  const created = await fs.readdir(pluginsDir).catch(() => []);
  assert.ok(!created.includes('evil'), '失败的安装不得留下插件目录');
});

test('zip 安装：结构不明确（多个顶层文件夹、无 package.json）时给出可读错误', async (t) => {
  const root = await makeTempRoot('plugin-shape');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  const many = path.join(root, 'many.zip');
  await fs.writeFile(
    many,
    buildRawZip([
      ['a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' })],
      ['b/package.json', JSON.stringify({ name: 'b', version: '1.0.0' })],
    ]),
  );
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: many }, { nodePath: null }),
    /结构不明确/,
  );

  const empty = path.join(root, 'empty.zip');
  await fs.writeFile(empty, buildRawZip([['readme.txt', 'hello']]));
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: empty }, { nodePath: null }),
    /没有找到 package.json/,
  );
});

test('zip 安装：非 zip 扩展名与不存在的文件被拒绝', async (t) => {
  const root = await makeTempRoot('plugin-badfile');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  const notZip = path.join(root, 'plugin.7z');
  await fs.writeFile(notZip, 'not a zip');
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: notZip }, { nodePath: null }),
    /只支持 \.zip/,
  );
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: path.join(root, 'nope.zip') }, { nodePath: null }),
    /不存在/,
  );
});

test('zip 安装：没有 dsh.bundle.patch 时按普通依赖安装，不登记 bundles 并给出警告', async (t) => {
  const root = await makeTempRoot('plugin-nopatch');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip(
    '',
    {
      'package.json': JSON.stringify({ name: 'pure-client', version: '0.1.0', dsh: { client: { platform: 'web' } } }),
      'client.js': 'export default {};\n',
    },
    path.join(root, 'pure.zip'),
  );

  const result = await core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null });
  assert.equal(result.registeredBundle, false, '没有 bundle patch 就不该进组合包层');
  assert.ok(
    result.warnings.some((w) => w.includes('dsh.bundle.patch')),
    '必须给出警告',
  );
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['pure-client'], 'file:../../plugins/pure-client');
  assert.ok(!manifest.dsh.profile.bundles.includes('pure-client'));
});

test('zip 安装：同名插件已存在时拒绝覆盖', async (t) => {
  const root = await makeTempRoot('plugin-dup');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('', GOOD_PLUGIN_FILES, path.join(root, 'demo.zip'));

  await core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null });
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null }),
    /已存在/,
  );
  // 已装的那份必须原样保留
  const dir = path.join(root, 'instances', meta.dirName, 'home', 'plugins', 'demo-plugin');
  assert.equal(await fs.readFile(path.join(dir, 'index.js'), 'utf8'), GOOD_PLUGIN_FILES['index.js']);
});

/* ------------------------------------------------------------------ *
 * 卸载
 * ------------------------------------------------------------------ */

test('卸载：依赖、bundles 登记、实例内目录与 node_modules 链接一起清掉', async (t) => {
  const root = await makeTempRoot('plugin-remove');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('', GOOD_PLUGIN_FILES, path.join(root, 'demo.zip'));
  await core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null });

  const profilesDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const pluginsDir = path.join(root, 'instances', meta.dirName, 'home', 'plugins');
  assert.equal((await fs.stat(path.join(pluginsDir, 'demo-plugin'))).isDirectory(), true);

  await core.pluginRemoveLocal(root, meta, 'demo-plugin', { nodePath: null });

  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['demo-plugin'], undefined, '依赖应被移除');
  assert.ok(!manifest.dsh.profile.bundles.includes('demo-plugin'), 'bundles 登记应被移除');
  assert.equal(await fs.stat(path.join(pluginsDir, 'demo-plugin')).catch(() => null), null, '插件目录应被删除');
  assert.equal(
    await fs.stat(path.join(profilesDir, 'node_modules', 'demo-plugin')).catch(() => null),
    null,
    'node_modules 里的链接应被摘掉（悬空链接会堵死该 profile 的后续安装）',
  );
  assert.deepEqual(await core.listInstancePlugins(root, meta), []);
});

test('卸载：不存在的插件给出可读错误', async (t) => {
  const root = await makeTempRoot('plugin-remove-missing');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  await assert.rejects(
    () => core.pluginRemoveLocal(root, meta, 'never-installed', { nodePath: null }),
    /没有名为/,
  );
});

test('卸载：文件夹来源只断开链接，绝不删除用户的源目录', async (t) => {
  const root = await makeTempRoot('plugin-remove-external');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  // 源目录刻意放在实例目录之外 —— 这是用户的开发目录，删掉是不可逆事故
  const source = path.join(root, 'outside-dev', 'live-plugin');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'live-plugin', version: '0.0.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  );
  await fs.writeFile(path.join(source, 'cordis.patch.yml'), '- insert: []\n');
  await fs.writeFile(path.join(source, 'index.js'), '// 用户正在开发的代码\n');

  await core.pluginInstall(root, meta, { kind: 'folder', dir: source }, { nodePath: null });
  await core.pluginRemoveLocal(root, meta, 'live-plugin', { nodePath: null });

  assert.equal(
    await fs.readFile(path.join(source, 'index.js'), 'utf8'),
    '// 用户正在开发的代码\n',
    '源目录必须原样保留',
  );
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['live-plugin'], undefined, '依赖登记应被移除');
  assert.ok(!manifest.dsh.profile.bundles.includes('live-plugin'));
  assert.deepEqual(await core.listInstancePlugins(root, meta), []);
});

/* ------------------------------------------------------------------ *
 * 搬运语义：整目录复制到另一台机器后仍可恢复
 * ------------------------------------------------------------------ */

test('搬运：实例目录整体复制到别处后，插件文件与相对依赖都还在', async (t) => {
  const root = await makeTempRoot('plugin-portable-src');
  const target = await makeTempRoot('plugin-portable-dst');
  t.after(() => cleanup(root));
  t.after(() => cleanup(target));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const zipFile = await writePluginZip('', GOOD_PLUGIN_FILES, path.join(root, 'demo.zip'));
  await core.pluginInstall(root, meta, { kind: 'archive', file: zipFile }, { nodePath: null });

  // 模拟「复制粘贴搬运」：把实例目录整份拷到另一个启动器根下。
  // dereference:true —— 资源管理器/robocopy 的默认行为是**跟随**链接复制内容，
  // 这正是"复制实例目录到另一台机器"的实际结果。
  const from = path.join(root, 'instances', meta.dirName);
  const to = path.join(target, 'instances', meta.dirName);
  await fs.cp(from, to, { recursive: true, dereference: true });

  const copiedManifest = await readJsonFile(
    path.join(to, 'home', 'profiles', meta.profile.name, 'package.json'),
  );
  assert.equal(copiedManifest.dependencies['demo-plugin'], 'file:../../plugins/demo-plugin');
  // 相对依赖 + 实例内文件 → 在新位置重新解析后指向新位置的插件
  const resolved = path.resolve(
    path.join(to, 'home', 'profiles', meta.profile.name),
    copiedManifest.dependencies['demo-plugin'].replace(/^file:/, ''),
  );
  assert.equal(resolved, path.join(to, 'home', 'plugins', 'demo-plugin'));
  assert.equal(
    await fs.readFile(path.join(resolved, 'index.js'), 'utf8'),
    GOOD_PLUGIN_FILES['index.js'],
    '插件文件本体随实例目录一起搬走了',
  );
});

/* ------------------------------------------------------------------ *
 * 文件夹来源（junction 链接，不复制）
 * ------------------------------------------------------------------ */

test('文件夹安装：建链接指向源目录，改源文件即时可见，且不复制进插件目录', async (t) => {
  const root = await makeTempRoot('plugin-folder');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  const source = path.join(root, 'dev', 'live-plugin');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'live-plugin',
      version: '0.0.1',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  await fs.writeFile(
    path.join(source, 'cordis.patch.yml'),
    "- insert:\n    - id: live-plugin\n      name: 'live-plugin'\n",
  );
  await fs.writeFile(path.join(source, 'index.js'), 'export function apply() {}\n');

  const result = await core.pluginInstall(root, meta, { kind: 'folder', dir: source }, { nodePath: null });
  assert.equal(result.name, 'live-plugin');
  assert.equal(result.dir, source, '文件夹来源不改动源目录');
  assert.equal(result.linked, true);
  assert.ok(
    result.warnings.some((w) => w.includes('不随实例') || w.includes('junction')),
    '必须提示「不随实例搬运」',
  );
  // 文件夹来源登记的是绝对 link:（换机器必须重新安装）
  assert.ok(result.spec.startsWith('link:'), '文件夹来源应以 link: 记录');

  // 源码改动即时可见（链接而非复制）
  await fs.writeFile(path.join(source, 'index.js'), 'export function apply() { /* v2 */ }\n');
  const profilesDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  assert.equal(
    await fs.readFile(path.join(profilesDir, 'node_modules', 'live-plugin', 'index.js'), 'utf8'),
    'export function apply() { /* v2 */ }\n',
  );

  // 来源标记为 folder（界面据此显示「不随实例搬运」）
  const local = await core.listInstancePlugins(root, meta);
  assert.equal(local.length, 1);
  assert.equal(local[0].origin, 'folder');
});

test('文件夹安装：目录里没有 package.json 时拒绝', async (t) => {
  const root = await makeTempRoot('plugin-folder-bad');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const empty = path.join(root, 'empty-dir');
  await fs.mkdir(empty, { recursive: true });
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'folder', dir: empty }, { nodePath: null }),
    /没有 package.json/,
  );
});

/* ------------------------------------------------------------------ *
 * git 依赖的构建脚本许可（pnpm allowBuilds）自动放开
 * ------------------------------------------------------------------ */

test('extractBuildScriptPackages：从 pnpm 输出里认出被拦下的包名', async () => {
  const __test = await pluginTestApi();
  // 真实形态：pnpm 会在 stdout 打印一行 `Ignored build scripts: <包名>@<版本>`
  const single = 'Ignored build scripts: dshmarket@1.49.0. Run "pnpm approve-builds" to pick which to allow.';
  assert.deepEqual(__test.extractBuildScriptPackages(single), ['dshmarket']);

  const scoped = 'Ignored build scripts: @scope/my-plugin@2.0.0, other-plugin@1.0.0.';
  assert.deepEqual(__test.extractBuildScriptPackages(scoped).sort(), ['@scope/my-plugin', 'other-plugin'].sort());

  const multiLine = 'Ignored build scripts:\n  foo-plugin@1.0.0\n  bar-plugin@0.2.1\n';
  assert.deepEqual(__test.extractBuildScriptPackages(multiLine).sort(), ['bar-plugin', 'foo-plugin'].sort());

  // 认不出包名时返回空数组（由调用方回退到仓库名）
  assert.deepEqual(__test.extractBuildScriptPackages('some unrelated failure'), []);
  assert.deepEqual(__test.extractBuildScriptPackages(''), []);
});

test('looksLikeAllowBuildsFailure：只对构建脚本被拦下的输出为真', async () => {
  const __test = await pluginTestApi();
  // pnpm 自己的声明
  assert.equal(__test.looksLikeAllowBuildsFailure('Ignored build scripts: x@1.0.0'), true);
  assert.equal(
    __test.looksLikeAllowBuildsFailure('Run "pnpm approve-builds" to pick which to allow.\nallowBuilds:\n  x: true'),
    true,
  );
  // 普通失败：不认
  assert.equal(__test.looksLikeAllowBuildsFailure('ERR_PNPM_FETCH_404 未找到包'), false);
  assert.equal(__test.looksLikeAllowBuildsFailure('spawn EPERM'), false);
  assert.equal(__test.looksLikeAllowBuildsFailure(''), false);
});

test('looksLikeAllowBuildsFailure：dsh 对任何失败都追加的提示不得被当成判据', async () => {
  const __test = await pluginTestApi();
  // 实测样本：ERR_PNPM_UNEXPECTED_STORE 时 dsh 也追加了那句 allowBuilds 提示。
  // 早先这里误判成构建脚本问题，程序跑去改 allowBuilds 并重试 —— 既无效又污染配置。
  const storeFailure = [
    ' ERR_PNPM_UNEXPECTED_STORE  Unexpected store location',
    'The dependencies at "F:\\WhalesLauncher\\instances\\test1\\home\\profiles\\main\\node_modules"',
    'are currently linked from the store at "F:\\WhalesLauncher\\.pnpm-store\\v10".',
    'pnpm now wants to use the store at "F:\\.pnpm-store\\v10" to link dependencies.',
    'dsh: pnpm failed; diagnostics: …\\.plugin-manager\\logs\\operation-GO4fY2\\pnpm.log',
    'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until',
    'allowed — add the exact key pnpm printed above under allowBuilds in',
    'F:\\WhalesLauncher\\instances\\test1\\home\\profiles\\main\\pnpm-workspace.yaml, then re-run',
  ].join('\n');
  assert.equal(
    __test.looksLikeAllowBuildsFailure(storeFailure),
    false,
    'store 位置错误绝不能被判成构建脚本问题',
  );
  // 同样地，网络/权限失败里出现 "prepare script" 字样也不该误判
  assert.equal(
    __test.looksLikeAllowBuildsFailure('dsh: git-hosted plugins build on install via their prepare script'),
    false,
  );
});

test('looksLikeAllowBuildsFailure：认得出 pnpm 10.33 的真实报错原文', async () => {
  const __test = await pluginTestApi();
  // 用户环境实测样本（operation-baLzI7/pnpm.log）：致命形态，错误码是 GIT_DEP_PREPARE_NOT_ALLOWED
  const real = [
    'Packages are hard linked from the content-addressable store to the virtual store.',
    '  Content-addressable store is at: F:\\.pnpm-store\\v10',
    '  Virtual store is at:             node_modules/.pnpm',
    ' ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Failed to prepare git-hosted package fetched from',
    '"https://codeload.github.com/dsh-market/dsh-market/tar.gz/5e29c2866f0eb3d71860a553f466d6afd5292585":',
    'The git-hosted package "dshmarket@1.49.0" needs to execute build scripts but is not in the',
    '"onlyBuiltDependencies" allowlist.',
    '',
    'Add the package to "onlyBuiltDependencies" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
    'onlyBuiltDependencies:',
    '  - "dshmarket"',
  ].join('\n');
  assert.equal(__test.looksLikeAllowBuildsFailure(real), true, '10.33 的致命形态必须被认出来');
  // 包名要能从这段原文里提取出来（含引号与 @版本 的写法）
  assert.ok(__test.extractBuildScriptPackages(real).includes('dshmarket'));
});

test('allowBuildScripts：同时写 onlyBuiltDependencies 数组与 allowBuilds 映射，保留原有键与注释', async (t) => {
  const root = await makeTempRoot('plugin-allow');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const file = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'pnpm-workspace.yaml');

  await fs.writeFile(file, '# 顶部注释要保留\npackages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');

  const added = await __test.allowBuildScripts(root, meta, ['dshmarket']);
  assert.deepEqual(added, ['dshmarket']);
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.includes('# 顶部注释要保留'), '原有注释必须保留');
  assert.ok(after.includes('nodeLinker: hoisted'), '原有键必须保留');
  const parsed = yamlLoad(after);
  // pnpm 10.33 只认数组形态（实测 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED 的原文就是它）
  assert.deepEqual(parsed.onlyBuiltDependencies, ['dshmarket'], 'onlyBuiltDependencies 必须写入（10.33 真正读的字段）');
  assert.equal(parsed.allowBuilds.dshmarket, true, 'allowBuilds 同步维护（其他 pnpm 版本的字段名）');

  // 第二次调用：已在配置里 → 不重复写
  assert.deepEqual(await __test.allowBuildScripts(root, meta, ['dshmarket']), []);
  const again = yamlLoad(await fs.readFile(file, 'utf8'));
  assert.deepEqual(again.onlyBuiltDependencies, ['dshmarket'], '不得重复追加');

  // 追加第二个包
  assert.deepEqual(await __test.allowBuildScripts(root, meta, ['other-plugin']), ['other-plugin']);
  const third = yamlLoad(await fs.readFile(file, 'utf8'));
  assert.deepEqual([...third.onlyBuiltDependencies].sort(), ['dshmarket', 'other-plugin']);
  assert.deepEqual(Object.keys(third.allowBuilds).sort(), ['dshmarket', 'other-plugin']);
});

test('allowBuildScripts：已有 onlyBuiltDependencies 数组时正确追加并去重', async (t) => {
  const root = await makeTempRoot('plugin-allow-merge');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const file = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'pnpm-workspace.yaml');

  // 用户/pnpm 已经写过数组（pnpm approve-builds 的产物形态）
  await fs.writeFile(file, 'packages:\n  - .\nonlyBuiltDependencies:\n  - already-there\n');

  assert.deepEqual(await __test.allowBuildScripts(root, meta, ['new-one']), ['new-one']);
  const parsed = yamlLoad(await fs.readFile(file, 'utf8'));
  assert.deepEqual([...parsed.onlyBuiltDependencies].sort(), ['already-there', 'new-one'], '原有条目必须保留');

  // 目标已在数组里 → 不算新增（但仍会把 allowBuilds 补齐，故返回空后配置应更完整）
  await __test.allowBuildScripts(root, meta, ['already-there']);
  const again = yamlLoad(await fs.readFile(file, 'utf8'));
  assert.equal(again.allowBuilds['already-there'], true, '缺 allowBuilds 时应补齐');
  assert.equal(
    again.onlyBuiltDependencies.filter((item) => item === 'already-there').length,
    1,
    '数组里不得出现重复项',
  );
});

test('allowBuildScripts：配置文件坏成非对象时拒绝写入（宁可不写也不能写坏 profile）', async (t) => {
  const root = await makeTempRoot('plugin-allow-bad');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const file = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'pnpm-workspace.yaml');

  await fs.writeFile(file, '- 这是一个数组，不是对象\n');
  await assert.rejects(() => __test.allowBuildScripts(root, meta, ['x']), /无法解析/);
  assert.equal(await fs.readFile(file, 'utf8'), '- 这是一个数组，不是对象\n', '失败时不得改动原文件');

  // allowBuilds 是数组（旧写法）同样拒绝 —— pnpm 10 要求映射
  await fs.writeFile(file, 'packages:\n  - .\nallowBuilds:\n  - somewhere\n');
  await assert.rejects(() => __test.allowBuildScripts(root, meta, ['x']), /不是键值映射/);
});

test('GitHub 安装：构建脚本被拦下时自动放开并重试，最终装成功', async (t) => {
  const root = await makeTempRoot('plugin-allow-e2e');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  process.env.WHALES_TEST_BUILDS_BLOCKED = '1';
  t.after(() => {
    delete process.env.WHALES_TEST_BUILDS_BLOCKED;
  });

  const logs = [];
  const result = await core.pluginInstall(
    root,
    meta,
    { kind: 'github', url: 'https://github.com/owner/test-plugin' },
    { nodePath: null },
    (stream, text) => logs.push(`${stream}:${text}`),
  );

  assert.equal(result.name, 'test-plugin');
  // 1) 配置被自动放开
  const ws = await fs.readFile(
    path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'pnpm-workspace.yaml'),
    'utf8',
  );
  assert.equal(yamlLoad(ws).allowBuilds['test-plugin'], true, '必须写入 allowBuilds');
  // 2) 安装真的完成了（重试生效）
  const manifest = await readManifest(root, meta);
  assert.ok(manifest.dependencies['test-plugin'].startsWith('github:'), '依赖应已登记');
  // 3) 如实告诉用户放开了什么、以及它的含义
  assert.ok(
    result.warnings.some((w) => w.includes('allowBuilds') && w.includes('test-plugin')),
    `必须点名 allowBuilds 配置与包名，实际：${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    result.warnings.some((w) => w.includes('pnpm-workspace.yaml') && w.includes('test-plugin')),
    `必须指明改的是哪个配置文件，实际：${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    result.warnings.some((w) => w.includes('可信')),
    '必须提示这只对可信仓库做',
  );
  // 4) 日志里能看到失败 → 放开 → 重试的全过程
  assert.ok(
    logs.some((line) => line.includes('已写入 pnpm-workspace.yaml')),
    '日志应记录自动放开这一步',
  );
});

test('GitHub 安装：WHALES_PLUGIN_ALLOW_BUILDS=0 时拒绝自动放开（安全逃生门）', async (t) => {
  const root = await makeTempRoot('plugin-allow-off');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  process.env.WHALES_TEST_BUILDS_BLOCKED = '1';
  process.env.WHALES_PLUGIN_ALLOW_BUILDS = '0';
  t.after(() => {
    delete process.env.WHALES_TEST_BUILDS_BLOCKED;
    delete process.env.WHALES_PLUGIN_ALLOW_BUILDS;
  });

  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'github', url: 'owner/blocked-plugin' }, { nodePath: null }),
    /已禁止自动放开构建脚本/,
  );
  const ws = await fs.readFile(
    path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name, 'pnpm-workspace.yaml'),
    'utf8',
  );
  assert.ok(!ws.includes('blocked-plugin'), '逃生门生效时不得写入 allowBuilds');
});

/* ------------------------------------------------------------------ *
 * 未知来源必须在边界处失败
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 陈旧写锁（实测：会让插件安装白等 121 秒后超时）
 * ------------------------------------------------------------------ */

test('clearStaleWriterLock：持有者已不存在的锁会被清掉', async (t) => {
  const root = await makeTempRoot('plugin-stale-lock');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const lockPath = path.join(profileDir, 'package.json.lock');

  // 用一个大到不可能存在的 PID 模拟"进程早已退出"
  await fs.writeFile(lockPath, '999999\n');
  const logs = [];
  const cleared = await __test.clearStaleWriterLock(profileDir, (_s, text) => logs.push(text));
  assert.equal(cleared, true, '应清掉陈旧锁');
  assert.equal(await fs.stat(lockPath).catch(() => null), null, '锁文件必须被删除');
  assert.ok(
    logs.some((line) => line.includes('陈旧写锁')),
    '必须留下日志（用户要能解释为什么这次没等两分钟）',
  );
});

test('clearStaleWriterLock：持有者还活着时绝不动手', async (t) => {
  const root = await makeTempRoot('plugin-live-lock');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const lockPath = path.join(profileDir, 'package.json.lock');

  // 当前进程自己就是"活着的持有者"——删掉它会搅坏正在进行的安装
  await fs.writeFile(lockPath, `${process.pid}\n`);
  const cleared = await __test.clearStaleWriterLock(profileDir);
  assert.equal(cleared, false, '活着的持有者不得被清理');
  assert.equal(await fs.readFile(lockPath, 'utf8'), `${process.pid}\n`, '锁文件必须原样保留');
});

test('clearStaleWriterLock：无锁 / 内容不是 PID 时安全跳过', async (t) => {
  const root = await makeTempRoot('plugin-bad-lock');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const lockPath = path.join(profileDir, 'package.json.lock');

  assert.equal(await __test.clearStaleWriterLock(profileDir), false, '没有锁时应安静返回');
  await fs.writeFile(lockPath, 'not-a-pid');
  assert.equal(await __test.clearStaleWriterLock(profileDir), false, '内容不是 PID 时不动手');
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'not-a-pid', '文件未被删');
});

test('GitHub 安装：命令退出码非零但依赖已落地时，按成功处理（消除安装误报）', async (t) => {
  const root = await makeTempRoot('plugin-false-negative');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  process.env.WHALES_TEST_ADD_FAILS_AFTER_WRITE = '1';
  t.after(() => {
    delete process.env.WHALES_TEST_ADD_FAILS_AFTER_WRITE;
  });

  const logs = [];
  const result = await core.pluginInstall(
    root,
    meta,
    { kind: 'github', url: 'github:owner/dshmarket' },
    { nodePath: null },
    (stream, text) => logs.push(`${stream}:${text}`),
  );

  // 事实判定：依赖与文件都在 → 不该抛"安装失败"
  assert.equal(result.name, 'dshmarket');
  assert.equal(result.linked, true, 'node_modules 里有它');
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies.dshmarket, 'github:owner/dshmarket');
  // 但要如实告诉用户：命令退出码非零
  assert.ok(
    result.warnings.some((w) => w.includes('退出码非零') || w.includes('已确认就位')),
    `必须如实说明命令报错但已就位，实际：${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    logs.some((line) => line.includes('按安装成功处理')),
    '日志要留下判定依据',
  );
});

test('GitHub 安装：命令报错且依赖确实没落地时，仍然如实报失败', async (t) => {
  const root = await makeTempRoot('plugin-true-negative');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  // 让 stub 在没有依赖可写的情况下失败：用一个 stub 不认识的子命令路径不可控，
  // 因此直接指向一个必然失败的分支——删除 engines 目录使 dsh plugin 无法执行。
  await fs.rm(path.join(root, 'engines'), { recursive: true, force: true });

  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'github', url: 'owner/never-landed' }, { nodePath: null }),
    /引擎 .* 未安装|插件操作失败/,
  );
  const manifest = await readManifest(root, meta);
  assert.equal(manifest.dependencies['never-landed'], undefined, '没落地就不能写进清单');
});

test('GitHub 安装：装完会记账，界面据此给出「已装好」而不是被第三方自检带偏', async (t) => {
  const root = await makeTempRoot('plugin-ledger');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);

  await core.pluginInstall(root, meta, { kind: 'github', url: 'owner/ledger-plugin' }, { nodePath: null });

  const list = await core.listInstancePlugins(root, meta);
  const found = list.find((item) => item.name === 'ledger-plugin');
  assert.ok(found, 'GitHub 依赖也应出现在实例插件清单里（否则用户无从判断装没装成）');
  assert.equal(found.origin, 'github');
  assert.equal(found.installedByLauncher, true, '启动器装过 → 必须有账本记录');
  assert.equal(found.installedVia?.kind, 'github');
  assert.ok(found.installedVia?.source?.startsWith('github:'), '账本要留下来源');
  assert.equal(found.enabled, true, '已在 bundles 里');

  // 账本文件确实落在 profile 目录（随实例一起搬运）
  const ledgerPath = path.join(
    root,
    'instances',
    meta.dirName,
    'home',
    'profiles',
    meta.profile.name,
    '.whales-plugins.json',
  );
  const ledger = await readJsonFile(ledgerPath);
  assert.equal(ledger['ledger-plugin'].kind, 'github');

  // 卸载后账本要同步清掉，否则界面会把已卸载的插件显示成"已装好"
  await core.pluginRemoveLocal(root, meta, 'ledger-plugin', { nodePath: null });
  const after = await readJsonFile(ledgerPath).catch(() => ({}));
  assert.equal(after['ledger-plugin'], undefined, '账本条目必须随卸载一起清掉');
  assert.deepEqual(await core.listInstancePlugins(root, meta), []);
});

test('GitHub 安装：命令报错但已落地时同样记账（误报修复的闭环）', async (t) => {
  const root = await makeTempRoot('plugin-ledger-false-negative');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  process.env.WHALES_TEST_ADD_FAILS_AFTER_WRITE = '1';
  t.after(() => {
    delete process.env.WHALES_TEST_ADD_FAILS_AFTER_WRITE;
  });

  const result = await core.pluginInstall(root, meta, { kind: 'github', url: 'owner/lied-about-failure' }, { nodePath: null });
  assert.equal(result.name, 'lied-about-failure');

  const list = await core.listInstancePlugins(root, meta);
  const found = list.find((item) => item.name === 'lied-about-failure');
  assert.ok(found, '即使命令报错，只要已落地就要出现在清单里');
  assert.equal(found.installedByLauncher, true, '按成功处理时也要记账');
  assert.equal(found.enabled, true);
});

test('clearStaleLockfile：锁文件与清单不一致时删掉（否则每次安装都要重新解析，明显变慢）', async (t) => {
  const root = await makeTempRoot('plugin-stale-lockfile');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  const manifestPath = path.join(profileDir, 'package.json');

  // 真实样本（test1 实测）：锁文件里记着 js-yaml，而清单已被 dsh 回滚成空
  const staleLock = [
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: false',
    'importers:',
    '  .:',
    '    dependencies:',
    '      js-yaml:',
    '        specifier: ^5.4.2',
    '        version: 5.4.2',
  ].join('\n');
  await fs.writeFile(lockPath, staleLock);

  const logs = [];
  const cleared = await __test.clearStaleLockfile(profileDir, (_s, text) => logs.push(text));
  assert.equal(cleared, true, '不一致的锁文件必须被清掉');
  assert.equal(await fs.stat(lockPath).catch(() => null), null, '文件应被删除');
  assert.ok(
    logs.some((line) => line.includes('不一致')),
    '必须留日志解释为什么删了它',
  );

  // 一致时不动手
  await fs.writeFile(manifestPath, JSON.stringify({ dependencies: { 'demo-plugin': 'github:x/y' } }));
  await fs.writeFile(lockPath, ['importers:', '  .:', '    dependencies:', '      demo-plugin:', '        specifier: github:x/y'].join('\n'));
  assert.equal(await __test.clearStaleLockfile(profileDir), false, '一致时不得删');
  assert.ok(await fs.readFile(lockPath, 'utf8'), '文件应保留');

  // 清单多了依赖（锁文件缺项）同样算不一致
  await fs.writeFile(manifestPath, JSON.stringify({ dependencies: { 'demo-plugin': 'github:x/y', added: '^1.0.0' } }));
  assert.equal(await __test.clearStaleLockfile(profileDir), true, '锁文件缺项也要重建');

  // 锁文件无法解析时按"该重建"处理
  await fs.writeFile(lockPath, '\t\t这不是 YAML: [');
  assert.equal(await __test.clearStaleLockfile(profileDir), true);
});

test('clearStaleLockfile：没有锁文件时安静返回', async (t) => {
  const root = await makeTempRoot('plugin-no-lockfile');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  const __test = await pluginTestApi();
  const profileDir = path.join(root, 'instances', meta.dirName, 'home', 'profiles', meta.profile.name);
  assert.equal(await __test.clearStaleLockfile(profileDir), false);
});

test('installPlugin：未知来源 kind 一律抛错（不得被当成"没传"）', async (t) => {  const root = await makeTempRoot('plugin-unknown');
  t.after(() => cleanup(root));
  const core = await loadCore();
  const meta = await seedInstance(root, core);
  await assert.rejects(
    () => core.pluginInstall(root, meta, { kind: 'ftp', url: 'x' }, { nodePath: null }),
    /未知的插件来源/,
  );
  await assert.rejects(() => core.pluginInstall(root, meta, null, { nodePath: null }), /格式错误/);
});

await run();
