/**
 * QA 最小复现：`settings: 'shared'` 静默覆盖实例既有设置。
 *
 * 两条触发路径（都在公开 API 上，无需私有调用）：
 *   R1 实例创建时直接选「共享设置」 → 共享文件为空时，实例把自己的设置清空
 *   R2 已存在的实例从「独立设置」切到「共享设置」 → 实例既有设置被共享内容静默覆盖
 *
 * 运行：node tests/e2e/11-repro-settings-clobber.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const { core } = await loadCoreBundle();
const config = (root) => ({ primaryHome: path.join(root, 'no-such-home') });

/* ---------- R1：创建时选共享设置，实例既有设置被清空 ---------- */
{
  const root = await makeTempRoot('repro-r1');
  await seedStubEngine(root);
  // 让共享设置已有内容，模拟"另一个实例已经把设置贡献给共享库"
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'settings.yaml'), 'skin: shared-theme\n');

  const meta = await core.createInstance(root, {
    name: 'R1',
    dirName: 'r1',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  console.log('\n[R1] 创建实例时未指定 settings → meta.settings.mode =', meta.settings.mode);
  const created = await fs.readFile(paths.settingsFile, 'utf8').catch(() => null);
  console.log('[R1] 实例 settings.yaml =', JSON.stringify(created));

  // 用户写入实例自己的设置，然后切到共享
  await core.writeInstanceSettings(root, meta, 'skin: mine\n');
  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));
  const after = await fs.readFile(paths.settingsFile, 'utf8').catch(() => null);
  const sharedAfter = await fs.readFile(path.join(root, 'shared', 'settings.yaml'), 'utf8').catch(() => null);
  console.log('[R1] 切换共享后 实例文件 =', JSON.stringify(after));
  console.log('[R1] 切换共享后 共享文件 =', JSON.stringify(sharedAfter));
  console.log(
    after === 'skin: mine\n'
      ? '[R1] 结论：实例设置被保留 ✓'
      : `[R1] 结论：实例设置 "skin: mine" 被静默替换为 ${JSON.stringify(after)} ✗`,
  );
}

/* ---------- R2：共享文件为空时，切共享会把实例设置清空 ---------- */
{
  const root = await makeTempRoot('repro-r2');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'R2',
    dirName: 'r2',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  await core.writeInstanceSettings(root, meta, 'model: deepseek-chat\n');
  // 手工制造"共享设置为空但文件存在"的初始态（真实场景：另一实例在空设置下切了共享）
  await fs.mkdir(path.join(root, 'shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'settings.yaml'), '');

  await core.applyShareModes(root, { ...meta, settings: { mode: 'shared' } }, config(root));
  const after = await fs.readFile(paths.settingsFile, 'utf8').catch(() => null);
  console.log('\n[R2] 实例设置原值 = "model: deepseek-chat"');
  console.log('[R2] 切换共享后实例文件 =', after === null ? '<文件已不存在>' : JSON.stringify(after));
  console.log(
    after === 'model: deepseek-chat\n'
      ? '[R2] 结论：实例设置被保留 ✓'
      : '[R2] 结论：实例设置被清空/删除 ✗',
  );
}

/* ---------- R3：A→共享 播种，B→共享 时 B 的本地值消失 ---------- */
{
  const root = await makeTempRoot('repro-r3');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'A', dirName: 'ra', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'B', dirName: 'rb', engineVersion: '9.9.9', template: 'web' });
  const pa = core.instancePaths(root, a);
  const pb = core.instancePaths(root, b);
  await fs.writeFile(pa.settingsFile, 'owner: A\n');
  await fs.writeFile(pb.settingsFile, 'owner: B\n');
  await core.applyShareModes(root, { ...a, settings: { mode: 'shared' } }, config(root));
  await core.applyShareModes(root, { ...b, settings: { mode: 'shared' } }, config(root));
  const shared = await fs.readFile(path.join(root, 'shared', 'settings.yaml'), 'utf8').catch(() => null);
  const bAfter = await fs.readFile(pb.settingsFile, 'utf8').catch(() => null);
  console.log('\n[R3] A 的设置 = "owner: A"，B 的设置 = "owner: B"，两者先后切到共享');
  console.log('[R3] 共享文件 =', JSON.stringify(shared));
  console.log('[R3] B 的实例文件（切换后）=', JSON.stringify(bAfter));
  console.log(
    bAfter === 'owner: B\n'
      ? '[R3] 结论：B 的设置被保留 ✓'
      : '[R3] 结论：B 的设置被静默覆盖为共享内容 ✗（无备份、无提示）',
  );
}
