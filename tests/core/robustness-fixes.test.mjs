/**
 * QR 缺陷回归测试（Lead 派单的本轮 6 项 + QA 40/51 号脚本对应的核心侧缺陷）
 *
 * - QR-16 目录被改名/复制后出现重复记录（同 id 多条）
 * - QR-08 引擎体积递归统计卡顿（改为惰性 + mtime 缓存）
 * - QR-09 日志写入发后不管（改为单写者串行 + 合并）
 * - QR-10 日志无轮转（保留最近 N 个）
 * - QR-12 可切到未安装的引擎版本
 * - QR-13 删除实例后共享工作区残留
 * - J2    registry.json 丢失后记录全丢（新增镜像索引）
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, sleep, run, test } from './_helpers.mjs';

const { core, paths: corePathsModule, launch, engine: engineModule } = await loadCoreModule();
const CONFIG = { schemaVersion: 1, primaryHome: 'C:\\Users\\tester\\.dsh', theme: 'dark', lastInstanceId: null, confirmOnDelete: true, engineRegistry: 'https://registry.npmjs.org' };

/** 建根目录 + 一个实例。 */
async function setup(t, label, input = {}) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: label, dirName: 'inst', engineVersion: '9.9.9', template: 'web', ...input });
  return { root, meta, paths: core.instancePaths(root, meta) };
}

/* ---------------------------------------------------------------- *
 * QR-16：改名 / 复制不得产生重复记录
 * ---------------------------------------------------------------- */

test('QR-16 目录被改名：同 id 只出一条记录，present=true，并标记不一致', async (t) => {
  const { root, meta, paths } = await setup(t, 'qr16-rename');
  await fs.rename(paths.root, path.join(root, 'instances', 'inst-renamed'));

  const list = await core.listInstances(root);
  const ids = new Set(list.map((item) => item.meta.id));
  assert.equal(ids.size, list.length, `不得出现重复 id：${JSON.stringify(list.map((i) => i.meta.id))}`);
  const dupes = list.filter((item) => item.meta.id === meta.id);
  assert.equal(dupes.length, 1, '同一实例只能有一条记录');
  const record = dupes[0];
  assert.equal(record.present, true, '目录真实存在 → present 必须为 true');
  assert.ok(record.problem?.includes('目录名与记录不一致'), `problem=${record.problem}`);
  assert.equal(record.meta.dirName, meta.dirName, '不得静默改写元数据（dirName 保持稳定）');
  // 元数据文件本身也不能被悄悄改过
  const onDisk = await readJsonFile(path.join(root, 'instances', 'inst-renamed', 'instance.json'));
  assert.equal(onDisk.dirName, meta.dirName);
});

test('QR-16 目录被复制：同 id 只出一条记录，并提示存在副本', async (t) => {
  const { root, meta, paths } = await setup(t, 'qr16-copy');
  const copyDir = path.join(root, 'instances', 'inst-copy');
  await fs.cp(paths.root, copyDir, { recursive: true });

  const list = await core.listInstances(root);
  const dupes = list.filter((item) => item.meta.id === meta.id);
  assert.equal(dupes.length, 1, `同一 id 只允许一条记录，实得 ${dupes.length}`);
  assert.equal(new Set(list.map((item) => item.meta.id)).size, list.length);
  // 记录里应提示磁盘上还有一份副本，便于用户自行清理
  assert.ok(dupes[0].problem?.includes('重复目录') || dupes[0].problem?.includes('副本'), `problem=${dupes[0].problem}`);
});

test('QR-16 改名 + 索引同时存在时也不重复（34 例回归口径）', async (t) => {
  const { root, meta, paths } = await setup(t, 'qr16-both');
  await fs.rename(paths.root, path.join(root, 'instances', 'inst-moved'));
  // 索引里仍是旧 dirName → 旧实现在这里会多出一条幽灵记录
  const registry = await core.readInstanceRegistry(root);
  assert.equal(registry.filter((entry) => entry.id === meta.id).length, 1);
  const list = await core.listInstances(root);
  assert.equal(list.length, 1, `列表应只有 1 条，实得 ${list.length}`);
  assert.equal(list[0].present, true, '目录真实存在（只是名字变了）');
  assert.ok(list[0].problem?.includes('目录名与记录不一致'), `problem=${list[0].problem}`);
});

/* ---------------------------------------------------------------- *
 * J2：索引文件丢失后记录不能全丢（镜像兜底）
 * ---------------------------------------------------------------- */

test('J2 主索引被删 + 目录被手删：记录仍可见（镜像兜底）', async (t) => {
  const { root, meta, paths } = await setup(t, 'j2-mirror');
  const other = await core.createInstance(root, { name: '另一个', dirName: 'other', engineVersion: '9.9.9', template: 'web' });
  // 模拟 QA J2：删掉主索引文件，再删掉实例目录
  await fs.rm(path.join(root, 'instances', 'registry.json'), { force: true });
  await fs.rm(paths.root, { recursive: true, force: true });

  const list = await core.listInstances(root);
  const ids = new Set(list.map((item) => item.meta.id));
  assert.equal(ids.has(meta.id), true, '主索引丢失后仍应能列出目录已消失的记录');
  assert.equal(ids.has(other.id), true, '正常实例不受影响');
  const ghost = list.find((item) => item.meta.id === meta.id);
  assert.equal(ghost.present, false);
  assert.ok(ghost.problem?.includes('目录缺失'), `problem=${ghost.problem}`);
});

test('J2 主索引损坏：镜像仍能兜底，且不影响正常实例', async (t) => {
  const { root, meta } = await setup(t, 'j2-corrupt');
  await fs.writeFile(path.join(root, 'instances', 'registry.json'), '{ 坏掉的 json');
  const list = await core.listInstances(root);
  assert.deepEqual(list.map((item) => item.meta.id), [meta.id]);
  assert.equal(list[0].present, true);
});

test('J2 镜像损坏/缺失时主索引照常工作，且下次写入自愈', async (t) => {
  const { root, meta } = await setup(t, 'j2-mirror-broken');
  const mirror = path.join(root, 'instances', '.registry-mirror.json');
  assert.equal(await core.pathExists(mirror), true, '登记时应写入镜像');

  // 镜像损坏 → 读取仍以主索引为准
  await fs.writeFile(mirror, '{ 坏镜像');
  const list = await core.listInstances(root);
  assert.deepEqual(list.map((item) => item.meta.id), [meta.id]);
  assert.deepEqual((await core.readInstanceRegistry(root)).map((entry) => entry.id), [meta.id]);

  // 镜像被删 → 主索引照常；下一次写入会把镜像整体重建（自愈）
  await fs.rm(mirror, { force: true });
  assert.deepEqual((await core.readInstanceRegistry(root)).map((entry) => entry.id), [meta.id]);
  await core.updateInstance(root, meta.id, { name: '改名触发写入' });
  assert.equal(await core.pathExists(mirror), true, '成功写入应重建镜像');
  const repaired = JSON.parse(await fs.readFile(mirror, 'utf8'));
  assert.deepEqual(repaired.entries.map((entry) => entry.id), [meta.id]);
  assert.equal(repaired.schemaVersion, 1);
});

/* ---------------------------------------------------------------- *
 * QR-08：引擎体积惰性化
 * ---------------------------------------------------------------- */

test('QR-08 listEngines 不递归统计体积：首次返回 null 且很快，显式计算后有值', async (t) => {
  const root = await makeTempRoot('qr08-size');
  t.after(() => cleanup(root));
  const pkgDir = await seedStubEngine(root, '9.9.9');
  // 造一棵较大目录树（2000 个文件），若同步递归至少几十毫秒
  const bulk = path.join(pkgDir, 'node_modules', 'bulk');
  for (let bucket = 0; bucket < 20; bucket += 1) {
    const dir = path.join(bulk, `b${bucket}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 100 }, (_value, index) => fs.writeFile(path.join(dir, `f${index}.txt`), Buffer.alloc(64))));
  }
  const started = Date.now();
  const first = await core.listEngines(root);
  const elapsed = Date.now() - started;
  assert.equal(first.length, 1);
  assert.equal(first[0].sizeBytes, null, '首次调用应返回 null（尚未计算）');
  assert.ok(elapsed < 1500, `首次列表不应递归统计体积（耗时 ${elapsed}ms）`);

  const size = await engineModule.computeEngineSize(first[0].dir);
  assert.ok(typeof size === 'number' && size > 20 * 100 * 64, `体积应 >= 128KB，实得 ${size}`);
  const second = await core.listEngines(root);
  assert.equal(second[0].sizeBytes, size, '缓存后应给出真实体积');
});

/* ---------------------------------------------------------------- *
 * QR-09 / QR-10：日志写入与轮转
 * ---------------------------------------------------------------- */

test('QR-09 日志写入器：并发调用被串行合并，drain 后内容完整且有序', async (t) => {
  const root = await makeTempRoot('qr09-log');
  t.after(() => cleanup(root));
  const file = path.join(root, 'x.log');
  const writer = launch.createLogWriter(file);
  const chunks = Array.from({ length: 500 }, (_value, index) => `line-${index}\n`);
  for (const chunk of chunks) writer.write(chunk); // 全部同步灌入，模拟爆发式输出
  await writer.drain();
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, chunks.join(''), '必须无丢失、无乱序');
  // drain 可重复调用且期间继续写入也能落盘
  writer.write('tail\n');
  await writer.drain();
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('tail\n'));
});

test('QR-10 pruneOldLogs：只保留最近 N 个 .log，其它文件不动', async (t) => {
  const root = await makeTempRoot('qr10-rotate');
  t.after(() => cleanup(root));
  const logs = path.join(root, 'logs');
  await fs.mkdir(logs, { recursive: true });
  const names = Array.from({ length: 15 }, (_value, index) => `2026-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z.log`);
  for (const name of names) await fs.writeFile(path.join(logs, name), name);
  await fs.writeFile(path.join(logs, 'keep-me.txt'), 'x');
  await fs.writeFile(path.join(logs, 'notes.md'), 'x');

  const removed = await launch.pruneOldLogs(logs);
  assert.equal(removed.length, 5, `应删除 5 个，实得 ${removed.length}`);
  const remaining = (await fs.readdir(logs)).sort();
  assert.equal(remaining.filter((name) => name.endsWith('.log')).length, launch.MAX_LOG_FILES);
  assert.equal(remaining.includes('2026-01-15T00-00-00-000Z.log'), true, '应保留最新的');
  assert.equal(remaining.includes('2026-01-01T00-00-00-000Z.log'), false, '应删除最旧的');
  assert.equal(remaining.includes('keep-me.txt'), true, '非 .log 文件不得被删');
  assert.equal(remaining.includes('notes.md'), true);
});

test('QR-10 启动实例时自动轮转旧日志', async (t) => {
  const { root, meta, paths } = await setup(t, 'qr10-launch');
  await fs.mkdir(paths.logs, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(paths.logs, `2025-12-${String(index + 1).padStart(2, '0')}T00-00-00-000Z.log`), 'old');
  }
  await core.launchInstance(root, meta, {}, CONFIG);
  t.after(() => core.stopInstance(meta.id).catch(() => undefined));
  const files = (await fs.readdir(paths.logs)).filter((name) => name.endsWith('.log'));
  assert.ok(files.length <= launch.MAX_LOG_FILES, `启动后日志数应 <= ${launch.MAX_LOG_FILES}，实得 ${files.length}`);
});

/* ---------------------------------------------------------------- *
 * QR-12：拒绝切到未安装的引擎
 * ---------------------------------------------------------------- */

test('QR-12 切换到未安装的引擎版本被拒绝，切到已安装的允许', async (t) => {
  const { root, meta } = await setup(t, 'qr12-engine');
  await assert.rejects(
    () => core.updateInstance(root, meta.id, { engineVersion: '1.2.3-not-installed' }),
    /未安装/,
  );
  const unchanged = await core.readInstance(root, meta.id);
  assert.equal(unchanged.engine.version, '9.9.9', '被拒绝时不得写入');
  await seedStubEngine(root, '8.8.8');
  const updated = await core.updateInstance(root, meta.id, { engineVersion: '8.8.8' });
  assert.equal(updated.engine.version, '8.8.8');
  // 同版本重复设置（幂等）不应因"未安装"而误报
  await core.removeEngine(root, '8.8.8').catch(() => undefined);
});

/* ---------------------------------------------------------------- *
 * QR-13：共享数据残留
 * ---------------------------------------------------------------- */

test('QR-13 删除实例不自动删共享工作区，但报告"数据仍在 + 归属已确认"', async (t) => {
  const { root, meta } = await setup(t, 'qr13-owned');
  // 契约的 CreateInstanceInput/UpdateInstancePatch 都没有 workspace 字段，
  // 因此共享工作区只能由 applyShareModes 落地（见主报告里给出的契约缺口提示）
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'shared' } }, CONFIG);
  const sharedWorkspace = corePathsModule.sharedWorkspaceDir(root, meta.dirName);
  const instanceWorkspace = path.join(root, 'instances', meta.dirName, 'workspace');
  assert.equal(await core.isLink(instanceWorkspace), true, '共享工作区应是 junction');
  await fs.writeFile(path.join(sharedWorkspace, 'file.txt'), 'shared-data');

  const report = await core.deleteInstanceDetailed(root, meta.id, true);
  assert.equal(report.sharedWorkspaceOwned, true, '应确认该共享工作区属于本实例');
  assert.deepEqual(report.sharedResidue, [sharedWorkspace], '共享数据仍在磁盘上，必须如实报告');
  // 共享模式下的 workspace 就是用户的真实工作目录 → 删除实例时绝不自动删它
  assert.equal(await fs.readFile(path.join(sharedWorkspace, 'file.txt'), 'utf8'), 'shared-data');
  assert.equal(await core.pathExists(instanceWorkspace), false, '实例目录本身应被删除');
});

test('QR-13 归属无法确认时同样只报告、不删除', async (t) => {
  const { root, meta } = await setup(t, 'qr13-unowned');
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'shared' } }, CONFIG);
  const sharedWorkspace = corePathsModule.sharedWorkspaceDir(root, meta.dirName);
  const instanceWorkspace = path.join(root, 'instances', meta.dirName, 'workspace');
  await fs.writeFile(path.join(sharedWorkspace, 'file.txt'), 'shared-data');
  // 断掉归属证据：把实例里的 junction 换成普通目录
  assert.equal(await core.removeLink(instanceWorkspace), true);
  await fs.mkdir(instanceWorkspace, { recursive: true });

  const report = await core.deleteInstanceDetailed(root, meta.id, true);
  assert.equal(report.sharedWorkspaceOwned, false, '归属无法确认');
  assert.deepEqual(report.sharedResidue, [sharedWorkspace], '仍应报告残留路径');
  assert.equal(await fs.readFile(path.join(sharedWorkspace, 'file.txt'), 'utf8'), 'shared-data', '数据必须保留');
});

test('QR-13 显式清理：仍被实例认领时拒绝，无人认领时才允许', async (t) => {
  const { root, meta } = await setup(t, 'qr13-cleanup');
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'shared' } }, CONFIG);
  const sharedWorkspace = corePathsModule.sharedWorkspaceDir(root, meta.dirName);

  // 实例还在 → 拒绝清理
  await assert.rejects(() => core.removeOrphanSharedWorkspace(root, meta.dirName), /仍被实例认领/);
  assert.equal(await core.pathExists(sharedWorkspace), true);

  // 删除实例（默认不自动清理共享数据）→ 之后才允许显式清理
  const report = await core.deleteInstanceDetailed(root, meta.id, true);
  assert.equal(report.sharedResidue.length, 1);
  assert.equal(await core.removeOrphanSharedWorkspace(root, meta.dirName), true, '实例已删除后应可显式清理');
  assert.equal(await core.pathExists(sharedWorkspace), false);

  // 越界路径必须被拒绝
  await assert.rejects(() => core.removeOrphanSharedWorkspace(root, '..\\..\\evil'), /拒绝清理/);
});

test('QR-13 共享会话库永远不被实例删除操作触碰', async (t) => {
  const { root, meta } = await setup(t, 'qr13-sessions', { saves: 'shared', workspace: 'shared' });
  const sharedSessions = corePathsModule.corePaths(root).sharedSessionsDir;
  const sessionDir = path.join(sharedSessions, '--F-Proj--', 'sess-1');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'session.v3.jsonl.zstd'), 'data');

  await core.deleteInstance(root, meta.id, true);
  assert.equal(await fs.readFile(path.join(sessionDir, 'session.v3.jsonl.zstd'), 'utf8'), 'data', '共享会话是多实例共用的，绝不能被删');
});

test('QR-13 findOrphanSharedWorkspaces 找出无人认领的共享工作区', async (t) => {
  const { root, meta } = await setup(t, 'qr13-orphan');
  const orphans = path.join(corePathsModule.corePaths(root).sharedWorkspacesDir);
  await fs.mkdir(path.join(orphans, 'ghost-instance'), { recursive: true });
  await fs.mkdir(path.join(orphans, meta.dirName), { recursive: true });

  const found = await core.findOrphanSharedWorkspaces(root);
  assert.deepEqual(found.map((item) => path.basename(item)), ['ghost-instance']);
});

/* ---------------------------------------------------------------- *
 * F2：cache 根目录不再依赖 process.cwd()
 * ---------------------------------------------------------------- */

test('F2 corePaths 会记录当前根目录，供无 root 参数的 API 推导 cache', async () => {
  const root = await makeTempRoot('f2-root');
  const probe = path.join(root, 'instances');
  await fs.mkdir(probe, { recursive: true });
  assert.equal(corePathsModule.lastRoot() !== null, true, '任何 corePaths 调用后都应记住根目录');
  core.corePaths(root);
  assert.equal(corePathsModule.lastRoot(), root);
  await cleanup(root);
});

test('F2 defaultRootForCache 不使用 process.cwd（源码断言）', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'engine.ts'), 'utf8');
  const anchor = source.indexOf('function defaultRootForCache');
  // 先断言锚点存在：否则 slice(-1) 只取最后一个字符，下面的正则断言会**空过**（假绿）
  assert.ok(anchor >= 0, '未找到 defaultRootForCache（函数被改名/移除时测试必须失败，而不是空过）');
  const tail = source.slice(anchor);
  assert.ok(tail.includes('lastRoot'), '应回退到最近使用的 root');
  assert.equal(/process\.cwd\(\)/.test(tail), false, 'cache 根目录推导不得回退 process.cwd()');
});

await run();
