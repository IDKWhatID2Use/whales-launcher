/**
 * QA 检查项 3：数据安全（最高优先级）—— **构造用例证明或证伪**
 *
 * 全部在 `.spike/qa-*` 临时根目录内进行，绝不触碰 `instances/` 之外的既有数据，
 * 更不触碰 `C:\Users\user\.dsh`。
 *
 * 运行：node tests/e2e/10-data-safety.mjs
 * 退出码 0 = 全部断言通过；非 0 = 发现真实缺陷（脚本会打印反例）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const { core } = await loadCoreBundle();
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ================================================================== *
 * A. removeLink 绝不能删除真实目录内容
 * ================================================================== */
{
  const root = await makeTempRoot('ds-a');
  const real = path.join(root, 'instances', 'A', 'workspace');
  await fs.mkdir(real, { recursive: true });
  await fs.writeFile(path.join(real, 'precious.txt'), '不可丢失');

  const removed = await core.removeLink(real);
  const stillThere = await fs.readFile(path.join(real, 'precious.txt'), 'utf8').catch(() => null);
  record(
    'A1 removeLink(真实目录) 返回 false 且不删除内容',
    removed === false && stillThere === '不可丢失',
    `removed=${removed} 内容=${stillThere}`,
  );

  const target = path.join(root, 'shared', 'workspaces', 'A');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'shared.txt'), '共享数据');
  const link = path.join(root, 'instances', 'B', 'workspace');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await core.replaceWithJunction(link, target);
  const removedLink = await core.removeLink(link);
  const targetIntact = await fs.readFile(path.join(target, 'shared.txt'), 'utf8').catch(() => null);
  record(
    'A2 removeLink(junction) 摘链接但共享目标内容完好',
    removedLink === true && targetIntact === '共享数据',
    `removed=${removedLink} 目标内容=${targetIntact}`,
  );
}

/* ================================================================== *
 * B. replaceWithJunction 绝不允许覆盖真实目录
 * ================================================================== */
{
  const root = await makeTempRoot('ds-b');
  const link = path.join(root, 'x', 'workspace');
  await fs.mkdir(link, { recursive: true });
  await fs.writeFile(path.join(link, 'mine.json'), '{"a":1}');
  const target = path.join(root, 'shared', 'x');
  let threw = null;
  try {
    await core.replaceWithJunction(link, target);
  } catch (error) {
    threw = error.message;
  }
  const survived = await fs.readFile(path.join(link, 'mine.json'), 'utf8').catch(() => null);
  record(
    'B1 replaceWithJunction 拒绝覆盖真实目录',
    threw !== null && survived === '{"a":1}',
    `抛出=${threw === null ? '否' : '是'} 内容=${survived}`,
  );
}

/* ================================================================== *
 * C. 共享模式切换（local → shared → local）不丢数据
 * ================================================================== */
{
  const root = await makeTempRoot('ds-c');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: '共享测试',
    dirName: 'shared-test',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  await fs.writeFile(path.join(paths.workspace, 'local-file.txt'), '本地工作区内容');
  await fs.mkdir(path.join(paths.sessions, 'wks'), { recursive: true });
  await fs.writeFile(path.join(paths.sessions, 'wks', 'session-1'), '会话数据');

  const config = { primaryHome: path.join(root, 'no-such-home') };

  const sharedMeta = { ...meta, workspace: { mode: 'shared' }, saves: { mode: 'shared' } };
  await core.applyShareModes(root, sharedMeta, config);
  const wsLink = await core.isLink(paths.workspace);
  const ssLink = await core.isLink(paths.sessions);
  const sharedWorkspaceFile = await fs
    .readFile(path.join(root, 'shared', 'workspaces', meta.dirName, 'local-file.txt'), 'utf8')
    .catch(() => null);
  const sharedSessionFile = await fs
    .readFile(path.join(root, 'shared', 'sessions', 'wks', 'session-1'), 'utf8')
    .catch(() => null);
  record(
    'C1 local→shared 把本地内容并入共享库（不删除）',
    wsLink && ssLink && sharedWorkspaceFile === '本地工作区内容' && sharedSessionFile === '会话数据',
    `workspace是链接=${wsLink} sessions是链接=${ssLink} 工作区内容=${sharedWorkspaceFile} 会话内容=${sharedSessionFile}`,
  );

  await core.applyShareModes(root, meta, config);
  const wsStillLink = await core.isLink(paths.workspace);
  const ssStillLink = await core.isLink(paths.sessions);
  const sharedTargetIntact = await fs
    .readFile(path.join(root, 'shared', 'workspaces', meta.dirName, 'local-file.txt'), 'utf8')
    .catch(() => null);
  record(
    'C2 shared→local 解除链接且共享库数据完好',
    !wsStillLink && !ssStillLink && sharedTargetIntact === '本地工作区内容',
    `workspace仍是链接=${wsStillLink} sessions仍是链接=${ssStillLink} 共享库=${sharedTargetIntact}`,
  );
}

/* ================================================================== *
 * D. deleteInstance(deleteFiles=true) 不得穿透 junction 删除共享数据
 * ================================================================== */
{
  const root = await makeTempRoot('ds-d');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: '删除测试',
    dirName: 'del-test',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  const config = { primaryHome: path.join(root, 'no-such-home') };
  await core.applyShareModes(root, { ...meta, workspace: { mode: 'shared' }, saves: { mode: 'shared' } }, config);
  const wsData = path.join(root, 'shared', 'workspaces', meta.dirName, 'data.txt');
  const ssData = path.join(root, 'shared', 'sessions', 'data.txt');
  await fs.writeFile(wsData, '共享工作区');
  await fs.writeFile(ssData, '共享会话');
  // 先确认写入成功再删除：否则"文件本来就没了"会被误判成"删除穿透了 junction"
  const beforeWs = await fs.readFile(wsData, 'utf8').catch(() => null);
  const beforeSs = await fs.readFile(ssData, 'utf8').catch(() => null);

  await core.deleteInstance(root, meta.id, true);
  const wsShared = await fs.readFile(wsData, 'utf8').catch(() => null);
  const ssShared = await fs.readFile(ssData, 'utf8').catch(() => null);
  const instanceGone = (await core.pathExists(paths.root)) === false;
  record(
    'D1 删除实例不穿透 junction 删共享数据',
    beforeWs === '共享工作区' && beforeSs === '共享会话' && instanceGone && wsShared === '共享工作区' && ssShared === '共享会话',
    `删除前（工作区/会话）=${beforeWs}/${beforeSs} 实例目录已删=${instanceGone} 删除后=${wsShared}/${ssShared}`,
  );
}

/* ================================================================== *
 * E. deleteInstance(deleteFiles=false) 只摘元数据、保留全部文件
 * ================================================================== */
{
  const root = await makeTempRoot('ds-e');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: '保留测试',
    dirName: 'keep-test',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  await fs.writeFile(path.join(paths.workspace, 'keep.txt'), '保留');
  await core.deleteInstance(root, meta.id, false);
  const metaGone = (await core.pathExists(paths.metaFile)) === false;
  const dataKept = await fs.readFile(path.join(paths.workspace, 'keep.txt'), 'utf8').catch(() => null);
  const listed = await core.listInstances(root);
  const entry = listed.find((item) => item.meta.id === meta.id);
  // `deleteFiles=false` 的语义是"从启动器里移除记录、但保留磁盘数据"，因此记录不再出现在
  // 列表中属于**预期**；这里只需要确认：数据没被删、且记录不会以"幽灵条目"形式残留。
  record(
    'E1 deleteFiles=false 仅摘 instance.json：数据保留，记录不再出现在列表',
    metaGone && dataKept === '保留' && entry === undefined,
    `元数据已摘=${metaGone} 数据=${dataKept} 列表长度=${listed.length} 残留记录=${entry !== undefined}`,
  );
}

/* ================================================================== *
 * F. 原子写语义
 * ================================================================== */
{
  const root = await makeTempRoot('ds-f');
  const file = path.join(root, 'a', 'b', 'c.json');
  await core.writeJsonAtomic(file, { v: 1 });

  const src = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'fsx.ts'), 'utf8');
  const sameDirTemp = /const temp = path\.join\(dir,\s*`\.\$\{path\.basename\(target\)\}\.tmp-/.test(src);
  const usesRename = /await rename\(temp, target\)/.test(src);
  record(
    'F1 原子写用「同目录临时文件 + rename」',
    sameDirTemp && usesRename,
    `同目录临时文件=${sameDirTemp} rename=${usesRename}`,
  );

  await core.writeTextAtomic(file, 'hello');
  const leftovers = (await fs.readdir(path.dirname(file))).filter((n) => n.includes('.tmp-'));
  record('F2 原子写完成后不残留临时文件', leftovers.length === 0, `残留=${leftovers.join(',') || '无'}`);

  const dirTarget = path.join(root, 'a', 'dir-target');
  await fs.mkdir(dirTarget, { recursive: true });
  let failed = false;
  try {
    await core.writeTextAtomic(dirTarget, 'x');
  } catch {
    failed = true;
  }
  const leftovers2 = (await fs.readdir(path.dirname(dirTarget))).filter((n) => n.includes('.tmp-'));
  record('F3 写入失败时清理临时文件', failed && leftovers2.length === 0, `抛错=${failed} 残留=${leftovers2.join(',') || '无'}`);
}

/* ================================================================== *
 * G. 经链接写入必须落到真实文件
 * ================================================================== */
{
  const root = await makeTempRoot('ds-g');
  const realDir = path.join(root, 'real');
  await fs.mkdir(realDir, { recursive: true });
  const realFile = path.join(realDir, 'settings.yaml');
  await fs.writeFile(realFile, 'original: true\n');
  const linkDir = path.join(root, 'instances', 'A');
  await fs.mkdir(linkDir, { recursive: true });
  await core.replaceWithJunction(path.join(linkDir, 'home'), realDir);
  await core.writeTextAtomic(path.join(linkDir, 'home', 'settings.yaml'), 'updated: true\n');
  const viaReal = await fs.readFile(realFile, 'utf8').catch(() => null);
  record(
    'G1 经链接写入会落到真实文件（不破坏链接/不新建影子文件）',
    viaReal === 'updated: true\n',
    `真实文件内容=${JSON.stringify(viaReal)}`,
  );
}

/* ================================================================== *
 * H. mergeDirInto 同名冲突：不得覆盖既有共享数据
 * ================================================================== */
{
  const root = await makeTempRoot('ds-h');
  const from = path.join(root, 'instances', 'A', 'workspace');
  const to = path.join(root, 'shared', 'workspaces', 'A');
  await fs.mkdir(from, { recursive: true });
  await fs.mkdir(to, { recursive: true });
  await fs.writeFile(path.join(from, 'dup.txt'), '本地版本');
  await fs.writeFile(path.join(from, 'only-local.txt'), '只本地有');
  await fs.writeFile(path.join(to, 'dup.txt'), '共享版本');

  const meta = {
    schemaVersion: 1, id: 'id-h', name: 'H', dirName: 'A', icon: null, color: '#5B8DEF', note: '',
    engine: { version: '9.9.9' }, profile: { name: 'A', template: 'web' },
    workspace: { mode: 'shared' }, saves: { mode: 'local' }, settings: { mode: 'local' },
    credentials: { mode: 'inherit' }, launch: { appArgs: [], autoOpenBrowser: false },
    createdAt: new Date().toISOString(), lastLaunchedAt: null, launchCount: 0,
  };
  let mergeError = null;
  try {
    await core.applyShareModes(root, meta, { primaryHome: path.join(root, 'nope') });
  } catch (error) {
    mergeError = error.message;
  }
  const dupContent = await fs.readFile(path.join(to, 'dup.txt'), 'utf8').catch(() => null);
  const movedContent = await fs.readFile(path.join(to, 'only-local.txt'), 'utf8').catch(() => null);
  const localDupKept = await fs.readFile(path.join(from, 'dup.txt'), 'utf8').catch(() => null);
  record(
    'H1 共享目录同名条目冲突时保留双方数据并报错',
    mergeError !== null && dupContent === '共享版本' && localDupKept === '本地版本' && movedContent === '只本地有',
    `报错=${mergeError ? '是' : '否'} 共享dup=${dupContent} 移动的独有文件=${movedContent} 本地dup=${localDupKept}`,
  );
}

/* ================================================================== *
 * I. 共享设置：两个实例切换 shared 是否互相覆盖（可疑数据丢失点）
 * ================================================================== */
{
  const root = await makeTempRoot('ds-i');
  await seedStubEngine(root);
  const config = { primaryHome: path.join(root, 'no-such-home') };
  const a = await core.createInstance(root, { name: 'A', dirName: 'inst-a', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'B', dirName: 'inst-b', engineVersion: '9.9.9', template: 'web' });
  const pa = core.instancePaths(root, a);
  const pb = core.instancePaths(root, b);

  await fs.writeFile(pa.settingsFile, 'owner: A\n');
  await fs.writeFile(pb.settingsFile, 'owner: B\n');
  // A 先切共享：共享文件由 A 的本地设置播种
  await core.applyShareModes(root, { ...a, settings: { mode: 'shared' } }, config);
  const afterA = await fs.readFile(path.join(root, 'shared', 'settings.yaml'), 'utf8').catch(() => null);
  // B 再切共享：B 的本地设置（owner: B）应当要么并入共享、要么明确报冲突，绝不能静默消失
  await core.applyShareModes(root, { ...b, settings: { mode: 'shared' } }, config);
  const shared = await fs.readFile(path.join(root, 'shared', 'settings.yaml'), 'utf8').catch(() => null);
  const nowA = await fs.readFile(pa.settingsFile, 'utf8').catch(() => null);
  const nowB = await fs.readFile(pb.settingsFile, 'utf8').catch(() => null);
  // 正确行为（任一即可）：共享文件里保留 B 的改动，或抛出冲突错误让用户决定。
  // 错误行为：B 的 owner: B 无声无息被 owner: A 覆盖。
  const bGotClobbered = afterA === 'owner: A\n' && nowB === 'owner: A\n';
  record(
    'I2 后切换到「共享设置」的实例不会静默丢失自己的设置',
    !bGotClobbered,
    `共享文件=${JSON.stringify(shared)} A实例=${JSON.stringify(nowA)} B实例=${JSON.stringify(nowB)} B原值="owner: B"`,
  );
  if (bGotClobbered) {
    console.log('       ↳ 反例：B 的 settings.yaml（owner: B）被共享文件内容（owner: A）直接覆盖，无备份、无提示。');
    console.log('         触发路径：core/instance.ts applyShareModesInternal「settings 共享」分支。');
  }
}

console.log('\n=== 数据安全用例汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  console.log('失败用例：');
  for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
  process.exitCode = 1;
}
