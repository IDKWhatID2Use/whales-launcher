/**
 * 回归测试：`settings: 'shared'` 绝不静默覆盖/删除实例既有设置
 *
 * 对应 QA 复现脚本 `tests/e2e/11-repro-settings-clobber.mjs` 的三条命中场景
 * （R1/R2/R3）。修复后的语义与 workspace/saves 的 `mergeDirInto` 对齐：
 *
 *  - R1 本地有内容 + 共享有内容且不同 → **冲突：保留本地**、不动共享、登记冲突
 *  - R2 共享内容为空            → 用本地播种共享，**绝不删除/清空实例设置文件**
 *  - R3 A 播种共享、B 再切共享   → B 的本地值**保持不被覆盖**，并登记冲突
 *
 * 另覆盖"覆盖前必留备份"与调用方的两种显式解决路径。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, seedStubEngine, run, test } from './_helpers.mjs';

const { core } = await loadCoreModule();

/** 只带 primaryHome 的最小配置（与 QA 复现脚本一致）。 */
const config = (root) => ({ primaryHome: path.join(root, 'no-such-home') });

/** 建根目录 + 一个实例。 */
async function setup(t, label, input = {}) {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: label, dirName: 'inst', engineVersion: '9.9.9', template: 'web', ...input });
  const paths = core.instancePaths(root, meta);
  return { root, meta, paths, sharedFile: path.join(root, 'shared', 'settings.yaml') };
}

test('R1：本地有内容 + 共享有内容且不同 → 保留本地，不静默替换', async (t) => {
  const { root, meta, paths, sharedFile } = await setup(t, 'regress-r1');
  await fs.mkdir(path.dirname(sharedFile), { recursive: true });
  await fs.writeFile(sharedFile, 'skin: shared-theme\n');
  await core.writeInstanceSettings(root, meta, 'skin: mine\n');

  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));

  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'skin: mine\n', '实例设置必须被保留');
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'skin: shared-theme\n', '共享设置不得被改动');
  const conflicts = core.listShareConflicts(meta.id);
  assert.equal(conflicts.length, 1, '必须登记冲突供 UI 决策');
  assert.equal(conflicts[0].resource, 'settings');
  assert.equal(conflicts[0].kept, 'local');
  assert.ok(conflicts[0].message.includes('保留'));
});

test('R2：共享内容为空 → 实例设置不得被清空或删除', async (t) => {
  const { root, meta, paths, sharedFile } = await setup(t, 'regress-r2');
  await core.writeInstanceSettings(root, meta, 'model: deepseek-chat\n');
  await fs.mkdir(path.dirname(sharedFile), { recursive: true });
  await fs.writeFile(sharedFile, '');

  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));

  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'model: deepseek-chat\n', '实例设置文件必须存在且内容不变');
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'model: deepseek-chat\n', '共享为空时应由本地播种');
  assert.deepEqual(core.listShareConflicts(meta.id), [], '播种不是冲突');
});

test('R3：A 播种共享后，B 切共享不被 A 的内容覆盖', async (t) => {
  const root = await makeTempRoot('regress-r3');
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'A', dirName: 'ra', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'B', dirName: 'rb', engineVersion: '9.9.9', template: 'web' });
  const pa = core.instancePaths(root, a);
  const pb = core.instancePaths(root, b);
  const sharedFile = path.join(root, 'shared', 'settings.yaml');
  await fs.writeFile(pa.settingsFile, 'owner: A\n');
  await fs.writeFile(pb.settingsFile, 'owner: B\n');

  await core.applyShareModes(root, { ...a, settings: { mode: 'shared' } }, config(root));
  await core.applyShareModes(root, { ...b, settings: { mode: 'shared' } }, config(root));

  assert.equal(await fs.readFile(pa.settingsFile, 'utf8'), 'owner: A\n');
  assert.equal(await fs.readFile(pb.settingsFile, 'utf8'), 'owner: B\n', 'B 的设置不得被静默覆盖');
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'owner: A\n', '共享文件保持 A 播种的内容');
  assert.equal(core.listShareConflicts(b.id).length, 1, 'B 侧应登记冲突');
  assert.deepEqual(core.listShareConflicts(a.id), [], 'A 是播种方，无冲突');
});

test('本地为空时采用共享内容，且覆盖前留下备份', async (t) => {
  const { root, meta, paths, sharedFile } = await setup(t, 'regress-adopt');
  await fs.mkdir(path.dirname(sharedFile), { recursive: true });
  await fs.writeFile(sharedFile, 'theme: dark\n');
  // 制造"本地文件存在但只有空白"的形态：覆盖前应备份
  await fs.writeFile(paths.settingsFile, '\n');

  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));

  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'theme: dark\n');
  const backups = (await fs.readdir(path.dirname(paths.settingsFile))).filter((name) => name.includes('settings.yaml.bak-'));
  assert.equal(backups.length, 1, '覆盖非空本地文件前必须备份');
});

test('冲突解决路径：use-local 推送到共享 / use-shared 覆盖本地（均先备份）', async (t) => {
  const { root, meta, paths, sharedFile } = await setup(t, 'regress-resolve');
  await fs.mkdir(path.dirname(sharedFile), { recursive: true });
  await fs.writeFile(sharedFile, 'value: shared\n');
  await fs.writeFile(paths.settingsFile, 'value: local\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));
  assert.equal(core.listShareConflicts(meta.id).length, 1);

  await core.resolveSettingsConflict(root, meta, 'use-local');
  assert.equal(await fs.readFile(sharedFile, 'utf8'), 'value: local\n');
  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'value: local\n');
  assert.deepEqual(core.listShareConflicts(meta.id), [], '解决后冲突必须清除');
  const sharedBackups = (await fs.readdir(path.dirname(sharedFile))).filter((name) => name.includes('.bak-'));
  assert.equal(sharedBackups.length, 1, '推送前必须备份原共享文件');

  await fs.writeFile(sharedFile, 'value: shared-2\n');
  await core.resolveSettingsConflict(root, meta, 'use-shared');
  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'value: shared-2\n');
  const localBackups = (await fs.readdir(path.dirname(paths.settingsFile))).filter((name) => name.includes('settings.yaml.bak-'));
  assert.equal(localBackups.length, 1, '覆盖前必须备份原实例文件');
});

test('切回 local 模式：既有设置保留，冲突记录清除', async (t) => {
  const { root, meta, paths, sharedFile } = await setup(t, 'regress-back');
  await fs.mkdir(path.dirname(sharedFile), { recursive: true });
  await fs.writeFile(sharedFile, 'a: 1\n');
  await fs.writeFile(paths.settingsFile, 'b: 2\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));
  assert.equal(core.listShareConflicts(meta.id).length, 1);

  await core.applyShareModes(root, { ...meta, settings: { mode: 'local' } }, config(root));
  assert.equal(await fs.readFile(paths.settingsFile, 'utf8'), 'b: 2\n');
  assert.deepEqual(core.listShareConflicts(meta.id), []);
});

await run();
