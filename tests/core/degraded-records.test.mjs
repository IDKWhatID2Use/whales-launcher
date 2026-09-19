/**
 * 回归测试：坏记录必须"降级呈现"，绝不静默丢弃
 *
 * 对应 QA 健壮性用例 R2b / R3 / R3a：
 *  - `instance.json` 损坏        → 仍在列表里，`problem` 标记，可删除
 *  - profile `package.json` 损坏 → 仍在列表里，`problem` 标记，pluginCount 降级为 0
 *  - 实例目录被手工删除          → 仍在列表里，`present === false`，可删除记录
 *  - 目录名不合法 / 索引损坏     → 不影响其它实例
 *
 * 另覆盖：导入实例包时拒绝非法 `settings.yaml`（不把坏 YAML 落盘）、
 * `npm.cmd` 降级调用（管道被拒时仍能执行 npm）、以及"停止失败"文案的诚实性。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, cleanup, loadCoreModule, makeTempRoot, readJsonFile, seedStubEngine, sleep, waitFor, run, test } from './_helpers.mjs';

const { core, launch } = await loadCoreModule();
const { describeStopFailure } = launch;

/** 建根目录 + 一个实例。 */
async function setup(t, label, input = {}) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: label, dirName: 'inst', engineVersion: '9.9.9', template: 'web', ...input });
  return { root, meta, paths: core.instancePaths(root, meta) };
}

test('instance.json 损坏：仍可列出、带问题标记、可删除', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-json');
  await fs.writeFile(paths.metaFile, '{ 这不是 JSON');

  const list = await core.listInstances(root);
  assert.equal(list.length, 1, '实例不得凭空消失');
  const summary = list[0];
  assert.equal(summary.meta.id, meta.id, '应能从索引快照恢复 id');
  assert.equal(summary.meta.name, meta.name);
  assert.equal(summary.present, true, '目录还在');
  assert.ok(summary.problem?.includes('instance.json 损坏'), `problem=${summary.problem}`);
  // 仍可按 id 读取（索引兜底）并删除
  assert.equal((await core.readInstance(root, meta.id))?.id, meta.id);
  await core.deleteInstance(root, meta.id, true);
  assert.deepEqual(await core.listInstances(root), []);
});

test('profile 清单损坏：实例仍可见并标记问题（R2b）', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-profile');
  await fs.writeFile(path.join(paths.profileDir, 'package.json'), '{ 坏掉的 JSON');

  const list = await core.listInstances(root);
  assert.equal(list.length, 1, '实例不得从列表消失');
  assert.equal(list[0].meta.id, meta.id);
  assert.equal(list[0].present, true);
  assert.equal(list[0].pluginCount, 0, '清单不可读时插件数降级为 0');
  assert.ok(list[0].problem?.includes('profile 清单损坏'), `problem=${list[0].problem}`);
  // 其它实例不受影响
  const healthy = await core.createInstance(root, { name: '健康实例', dirName: 'healthy', engineVersion: '9.9.9', template: 'web' });
  const after = await core.listInstances(root);
  assert.equal(after.length, 2);
  assert.equal(after.find((item) => item.meta.id === healthy.id).problem, undefined);
});

test('实例目录被手工删除：present=false 且仍是可删除的记录（R3/R3a）', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-gone');
  await fs.rm(paths.root, { recursive: true, force: true });
  assert.equal(await core.pathExists(paths.root), false);

  const list = await core.listInstances(root);
  assert.equal(list.length, 1, '目录被删后记录仍必须可见（否则用户无法感知与清理）');
  const summary = list[0];
  assert.equal(summary.meta.id, meta.id);
  assert.equal(summary.present, false, 'present 必须如实反映目录不存在');
  assert.ok(summary.problem?.includes('目录缺失'), `problem=${summary.problem}`);

  // 彻底删除记录（目录本就不存在，删除文件是幂等的）
  await core.deleteInstance(root, meta.id, true);
  assert.deepEqual(await core.listInstances(root), []);
});

test('deleteFiles=false 是显式注销：数据保留在磁盘、记录不再出现在列表', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-unregister');
  await fs.writeFile(path.join(paths.workspace, 'keep.txt'), '保留');
  await core.deleteInstance(root, meta.id, false);

  assert.equal(await core.pathExists(paths.metaFile), false, 'instance.json 应被摘除');
  assert.equal(await core.pathExists(path.join(paths.workspace, 'keep.txt')), true, '数据必须保留');
  assert.deepEqual(await core.listInstances(root), [], '显式注销后记录不再出现（契约 remove(id,false) 语义）');
  assert.deepEqual(await core.readInstanceRegistry(root), [], '索引记录同步清理');
  assert.equal(await core.readInstance(root, meta.id), null);
});

test('元数据被外部删除（非主动注销）：记录仍可见并带标记', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-meta-gone');
  await fs.rm(paths.metaFile, { force: true });
  assert.equal(await core.pathExists(paths.metaFile), false);
  const list = await core.listInstances(root);
  assert.equal(list.length, 1, '外部删除元数据不得让实例失联');
  assert.equal(list[0].meta.id, meta.id, '索引快照提供稳定 id');
  assert.ok(list[0].problem?.includes('instance.json 缺失'), `problem=${list[0].problem}`);
  assert.equal(list[0].present, true);
});

test('索引损坏 / 目录名不合法：不影响正常实例', async (t) => {
  const { root, meta } = await setup(t, 'deg-index');
  await fs.writeFile(path.join(root, 'instances', 'registry.json'), '{ 坏索引');
  const list = await core.listInstances(root);
  assert.deepEqual(list.map((item) => item.meta.id), [meta.id], '索引损坏时以目录为准');

  // 目录名不合法（dsh 保留名）→ 仍可见但带标记，且不影响其它实例
  const badDir = path.join(root, 'instances', 'desktop');
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(badDir, 'instance.json'), '{}');
  const after = await core.listInstances(root);
  assert.equal(after.length, 2);
  const bad = after.find((item) => item.meta.dirName === 'desktop');
  assert.ok(bad !== undefined, '非法目录名的记录也必须可见');
  assert.ok(bad.problem !== undefined, '应标记问题');
  await core.deleteInstance(root, bad.meta.id, true);
  assert.equal((await core.listInstances(root)).length, 1);
});

test('importPack：非法 settings.yaml 不落盘，只记警告（R4c）', async (t) => {
  const { root, meta, paths } = await setup(t, 'deg-import');
  await core.writeInstanceSettings(root, meta, 'good: 1\n');
  const outFile = path.join(root, 'exports', 'bad-settings.zip');
  // 先导出一个正常包，再把包内 settings.yaml 换成坏 YAML
  await core.exportPack(root, meta, outFile, '1.0.0');
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(outFile);
  zip.updateFile('home/settings.yaml', Buffer.from('a: [1, 2\nb: }{\n', 'utf8'));
  zip.writeZip(outFile);

  const target = await makeTempRoot('deg-import-dst');
  t.after(() => cleanup(target));
  await seedStubEngine(target);
  const result = await core.importPack(target, outFile, { primaryHome: '' });
  const imported = await core.readInstance(target, result.instanceId);
  assert.ok(result.warnings.some((line) => line.includes('settings.yaml') && line.includes('YAML')), `warnings=${JSON.stringify(result.warnings)}`);
  const importedSettings = await core.readInstanceSettings(target, imported);
  assert.equal(importedSettings, '', '坏 YAML 绝不能落盘');
  assert.equal(await core.pathExists(core.instancePaths(target, imported).settingsFile), false);
  void paths;
});

test('settings 校验工具与导入校验一致（validateYaml）', async () => {
  const { profile } = await loadCoreModule();
  assert.equal(profile.validateYaml('a: 1\n'), null);
  assert.equal(profile.validateYaml(''), null);
  assert.equal(profile.validateYaml('   '), null);
  assert.notEqual(profile.validateYaml('a: [1, 2\n'), null);
});

test('降级路径下 npm.cmd 仍可执行（cmd /c 双引号 + verbatim）', async () => {
  const { proc } = await loadCoreModule();
  // 管道被拒（本机沙箱）时 runCapture 会降级为文件重定向；两条路径都必须能跑 npm
  const result = await proc.runCapture('npm', ['--version'], { timeoutMs: 120000 });
  assert.equal(result.code, 0, `npm --version 失败：${result.stderr}`);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/, `stdout=${result.stdout}`);
  // resolveCommand 的形态：cmd.exe + 双引号包裹 + verbatim
  const resolved = proc.resolveCommand('npm', ['--version']);
  if (process.platform === 'win32') {
    assert.equal(resolved.verbatim, true);
    assert.equal(path.basename(resolved.file).toLowerCase(), 'cmd.exe');
    assert.equal(resolved.args[0], '/d');
    assert.match(resolved.args[3], /^""/);
    assert.match(resolved.args[3], /"$/);
  }
});

test('停止失败文案必须诚实（不谎报"已强制结束"）', () => {
  const aliveMessage = describeStopFailure(true);
  assert.ok(aliveMessage.includes('请手动结束'), `文案=${aliveMessage}`);
  assert.equal(/已强制结束/.test(aliveMessage), false, '进程仍存活时不得声称已结束');
  const exitedMessage = describeStopFailure(false);
  assert.ok(exitedMessage.includes('已自行退出'), `文案=${exitedMessage}`);
});

test('killTree：先树杀后杀根（顺序依据），且对已退出的子进程安全', async () => {
  const { proc } = await loadCoreModule();
  const { spawn } = await import('node:child_process');

  // 1) 活着的子进程必须被真正终止，且返回值代表"已确认终止"
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  await sleep(400);
  assert.equal(proc.isAlive(kid.pid), true, '子进程应已启动');
  const confirmed = proc.killTree(kid.pid, kid);
  assert.equal(confirmed, true, 'killTree 返回 true 必须代表"确认已终止"');
  assert.equal(proc.isAlive(kid.pid), false, '进程必须真的消失（本机沙箱只能靠 child.kill）');

  // 2) 子进程已退出后再调用必须安全（不抛错、不误判）
  await sleep(300);
  assert.doesNotThrow(() => proc.killTree(kid.pid, kid));
  assert.equal(proc.killTree(undefined, undefined), true, '无 PID 时应视为已终止');
  assert.doesNotThrow(() => proc.killTree(0));

  // 3) 顺序依据：taskkill /T 必须排在 child.kill 之前。
  //    本机沙箱恒定拒绝 taskkill（Access denied），因此"顺序差异"在此环境不可观测；
  //    这里用源码顺序断言把它钉住，防止将来重构悄悄调换 —— 那会在 taskkill 可用的
  //    普通环境里丢掉孙进程清理：Windows 上根进程一死，/T 就再也遍历不出子进程树，
  //    而 Windows 又不会在父进程死亡时自动收走子进程。
  const source = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'proc.ts'), 'utf8');
  const start = source.indexOf('export function killTree');
  const end = source.indexOf('export function waitForExit');
  // 先断言切片锚点有效：否则 indexOf = -1 会让下面的断言"空过"（假绿）
  assert.ok(start >= 0 && end > start, 'killTree / waitForExit 锚点必须存在，否则本断言无效');
  const body = source.slice(start, end);
  const treeKillAt = body.indexOf("'taskkill'");
  const rootKillAt = body.indexOf("child.kill('SIGKILL')");
  assert.ok(treeKillAt >= 0 && rootKillAt >= 0, 'killTree 应同时包含 taskkill 与 child.kill');
  assert.ok(treeKillAt < rootKillAt, `taskkill /T 必须排在 child.kill 之前（当前 ${treeKillAt} vs ${rootKillAt}）`);
});

test('killTree 不遗留后代进程（本沙箱必然通过、无区分力；真环境才具区分力）', async (t) => {
  // 背景：本沙箱对进程树有 job object 级自动包容 —— 孙进程在父进程退出后也会消失，
  // 因此"树杀是否生效"在此原理上不可观测（见 proc.ts 中 killTree 的 JSDoc）。
  // 这条用例在沙箱外（普通 shell / 真实桌面）才真正校验 taskkill /T 的收益。
  const { proc } = await loadCoreModule();
  const { spawn } = await import('node:child_process');
  const tempRoot = await makeTempRoot('deg-tree');
  t.after(() => cleanup(tempRoot));
  const marker = path.join(tempRoot, 'grandchild.pid');

  // 根进程：拉起一个孙进程，把孙 PID 写盘，然后长眠
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(marker)}, String(g.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const rootChild = spawn(process.execPath, ['-e', rootScript], { stdio: 'ignore' });
  const grandPidHolder = { pid: 0 };
  t.after(() => {
    try {
      proc.killTree(rootChild.pid, rootChild);
    } catch {
      /* 已退出 */
    }
    if (grandPidHolder.pid > 0) {
      try {
        process.kill(grandPidHolder.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  });

  const markerReady = await waitFor(async () => (await fs.readFile(marker, 'utf8').catch(() => '')).trim().length > 0, 10000);
  assert.equal(markerReady, true, '根进程应已写出孙进程 PID');
  const grandPid = Number(await fs.readFile(marker, 'utf8'));
  grandPidHolder.pid = grandPid;
  assert.ok(grandPid > 0);
  assert.equal(proc.isAlive(grandPid), true, '孙进程应已启动');

  const confirmed = proc.killTree(rootChild.pid, rootChild);
  assert.equal(confirmed, true, 'killTree 必须确认根进程已终止');
  await sleep(600);
  assert.equal(proc.isAlive(rootChild.pid), false, '根进程必须消失');
  assert.equal(proc.isAlive(grandPid), false, '孙进程必须一并消失（真环境下由 taskkill /T 保证）');
});

test('实例索引快照可读且随创建/更新/彻底删除同步', async (t) => {
  const { root, meta } = await setup(t, 'deg-registry');
  let registry = await core.readInstanceRegistry(root);
  assert.deepEqual(registry.map((entry) => entry.id), [meta.id]);
  assert.equal(registry[0].meta.name, meta.name);

  await core.updateInstance(root, meta.id, { name: '改名后' });
  registry = await core.readInstanceRegistry(root);
  assert.equal(registry[0].meta.name, '改名后', '更新应同步索引');

  await core.deleteInstance(root, meta.id, true);
  assert.deepEqual(await core.readInstanceRegistry(root), [], '彻底删除应清理索引');
});

test('索引文件损坏时仍能从目录恢复实例（以目录为准）', async (t) => {
  const { root, meta } = await setup(t, 'deg-registry-broken');
  const registryFile = path.join(root, 'instances', 'registry.json');
  await fs.writeFile(registryFile, 'not json at all');
  const list = await core.listInstances(root);
  assert.deepEqual(list.map((item) => item.meta.id), [meta.id]);
  const raw = await readJsonFile(path.join(root, 'instances', meta.dirName, 'instance.json'));
  assert.equal(raw.id, meta.id);
});

await run();
