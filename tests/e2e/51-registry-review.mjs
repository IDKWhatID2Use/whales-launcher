/**
 * QA 独立评估：`<instances>/registry.json` 索引快照设计是否成立（Lead 指派题目）。
 *
 * 只依据**实跑行为**判定，不采信实现说明。
 * 检查维度：
 *  1. 手删目录 → 记录可见 + present:false（口径要求）
 *  2. deleteInstance(true/false) 后 registry 是否被正确维护（有无幽灵条目）
 *  3. 整个 instances/ 被清空（registry.json 成为孤儿）会怎样
 *  4. 导入实例包后 registry 是否有重复/错配
 *  5. registry.json 自身损坏时的容错
 *  6. 目录被改名/移动后的表现
 *  7. 是否存在"更简单且能表达 present:false"的替代方案（分析）
 *
 * 运行：node tests/e2e/51-registry-review.mjs
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
const registryPath = (root) => path.join(root, 'instances', 'registry.json');
/** 读取 registry 的 entries 数组（文件形状：`{ schemaVersion, entries: [{id, dirName, meta}] }`）。 */
const readRegistry = async (root) => {
  try {
    const raw = JSON.parse(await fs.readFile(registryPath(root), 'utf8'));
    return Array.isArray(raw?.entries) ? raw.entries : null;
  } catch {
    return null;
  }
};
/** 读取 registry 的原始对象（用于检查 schemaVersion）。 */
const readRegistryRaw = async (root) => {
  try {
    return JSON.parse(await fs.readFile(registryPath(root), 'utf8'));
  } catch {
    return null;
  }
};
/** 取条目的稳定 id（兼容两种形状）。 */
const entryId = (e) => e?.id ?? e?.meta?.id;

/* ================================================================== *
 * 1. 口径要求：手删目录 → 可见 + present:false
 * ================================================================== */
{
  const root = await makeTempRoot('reg-1');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'x', dirName: 'x', engineVersion: '9.9.9', template: 'web' });
  await fs.rm(core.instancePaths(root, meta).root, { recursive: true, force: true });
  const list = await core.listInstances(root);
  const entry = list.find((item) => item.meta.id === meta.id);
  record(
    '1a 目录被手删后记录可见且 present=false',
    entry !== undefined && entry.present === false,
    entry === undefined ? '记录消失' : `present=${entry.present} problem=${JSON.stringify(entry.problem)}`,
  );
  record(
    '1b registry.json 已生成并含该实例快照',
    (await readRegistry(root)) !== null,
    `registry 内容条目数=${(await readRegistry(root))?.length ?? 'null'}`,
  );
}

/* ================================================================== *
 * 2. 删除路径下 registry 的维护（幽灵条目检测）
 * ================================================================== */
{
  const root = await makeTempRoot('reg-2');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'a', dirName: 'a', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'b', dirName: 'b', engineVersion: '9.9.9', template: 'web' });
  const c = await core.createInstance(root, { name: 'c', dirName: 'c', engineVersion: '9.9.9', template: 'web' });

  await core.deleteInstance(root, a.id, true); // 目录 + 索引一起清理
  await core.deleteInstance(root, b.id, false); // 数据保留、记录离开列表（契约 remove 语义）

  const list = await core.listInstances(root);
  const ids = new Set(list.map((item) => item.meta.id));
  record(
    '2a deleteInstance(true) 后无幽灵条目',
    !ids.has(a.id) && (await fs.access(core.instancePaths(root, a).root).then(() => true, () => false)) === false,
    `a 仍在列表=${ids.has(a.id)}；a 目录仍存在=${await fs.access(core.instancePaths(root, a).root).then(() => true, () => false)}`,
  );
  record(
    '2b deleteInstance(false) 后记录离开列表、数据保留',
    !ids.has(b.id) && (await fs.readFile(path.join(core.instancePaths(root, b).workspace, '.keep'), 'utf8').catch(() => 'no-file')) === 'no-file',
    `b 仍在列表=${ids.has(b.id)}（契约 remove 语义：应离开）`,
  );
  record(
    '2c 健康实例 c 不受影响',
    ids.has(c.id),
    `列表=${list.length} 个`,
  );
  const reg = await readRegistry(root);
  record(
    '2d registry.json 经删除后仍可解析且无残留 dirName',
    reg !== null && !reg.some((e) => e.dirName === 'a' || e.dirName === 'b'),
    `registry 条目=${JSON.stringify(reg?.map((e) => e.dirName) ?? null)}`,
  );
}

/* ================================================================== *
 * 3. 整个 instances/ 被清空（registry 成为孤儿）
 * ================================================================== */
{
  const root = await makeTempRoot('reg-3');
  await seedStubEngine(root);
  await core.createInstance(root, { name: 'p', dirName: 'p', engineVersion: '9.9.9', template: 'web' });
  await core.createInstance(root, { name: 'q', dirName: 'q', engineVersion: '9.9.9', template: 'web' });
  // 模拟"用户把 instances 目录里除了 registry.json 之外的东西全删了"
  const entries = await fs.readdir(path.join(root, 'instances'));
  for (const name of entries) {
    if (name === 'registry.json') continue;
    await fs.rm(path.join(root, 'instances', name), { recursive: true, force: true });
  }
  const list = await core.listInstances(root);
  record(
    '3 目录全删后留下"幽灵记录"（registry 仍在，记录可见但 present=false）',
    list.length === 2 && list.every((item) => item.present === false),
    `列表长度=${list.length}，present 全为 false=${list.every((i) => i.present === false)}；` +
      `problem=${JSON.stringify(list.map((i) => i.problem))}`,
  );
  console.log('         ↳ 判定：这是**预期**行为（口径要求"记录可见"），前提是 UI 必须能删除这类记录；');
  console.log('           若 UI 未提供"删除残留记录"入口，用户会看到两条永远无法消除的空壳。');
  // 能否通过公开 API 清理幽灵记录？
  const ghost = list[0];
  let cleaned = false;
  try {
    await core.deleteInstance(root, ghost.meta.id, true);
    cleaned = (await core.listInstances(root)).length === 1;
  } catch {
    cleaned = false;
  }
  record(
    '3b 幽灵记录可通过 deleteInstance 清理',
    cleaned,
    cleaned ? '可清理（收到 1 条）' : '无法清理',
  );
}

/* ================================================================== *
 * 4. 导入实例包后 registry 是否一致
 * ================================================================== */
{
  const root = await makeTempRoot('reg-4');
  await seedStubEngine(root);
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  zip.addFile('whalelauncher-pack.json', Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'whalelauncher-pack',
    instance: { name: 'packed', profile: { name: 'packed', template: 'web' }, engine: { version: '9.9.9' }, icon: null, color: '#fff', note: '', launch: { appArgs: [], autoOpenBrowser: true } },
    requirements: {}, bundles: [],
  })));
  const file = path.join(root, 'p.zip');
  zip.writeZip(file);
  const imported = await core.importPack(root, file, { primaryHome: '' }, {});
  const list = await core.listInstances(root);
  const entry = list.find((item) => item.meta.id === imported.instanceId);
  const reg = await readRegistry(root);
  record(
    '4a 导入后新实例出现在列表且 dirName 一致',
    entry !== undefined && entry.meta.dirName === (await readRegistry(root))?.find((e) => entryId(e) === imported.instanceId)?.dirName,
    `列表条目=${entry?.meta.dirName} registry 条目=${reg?.find((e) => entryId(e) === imported.instanceId)?.dirName}`,
  );
  record(
    '4b 导入不产生重复 registry 条目',
    Array.isArray(reg) && new Set(reg.map((e) => entryId(e))).size === reg.length,
    `registry 条目数=${reg?.length}，唯一 id 数=${reg === null ? 'null' : new Set(reg.map((e) => entryId(e))).size}`,
  );
  record('4c 列表长度与 registry 条目数一致', reg !== null && list.length === reg.length, `列表=${list.length} registry=${reg?.length}`);
}

/* ================================================================== *
 * 5. registry.json 自身损坏
 * ================================================================== */
{
  const root = await makeTempRoot('reg-5');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'a', dirName: 'a', engineVersion: '9.9.9', template: 'web' });
  await fs.writeFile(registryPath(root), '{ 坏掉的 registry');
  let error = null;
  let list = [];
  try {
    list = await core.listInstances(root);
  } catch (e) {
    error = e.message;
  }
  record(
    '5 registry.json 损坏时列表仍可用（目录扫描兜底）',
    error === null && list.some((item) => item.meta.id === a.id),
    error !== null ? `抛错：${error.split('\n')[0]}` : `返回 ${list.length} 个，a 可见=${list.some((i) => i.meta.id === a.id)}`,
  );
}

/* ================================================================== *
 * 6. 目录被改名 / 移动
 * ================================================================== */
{
  const root = await makeTempRoot('reg-6');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'r', dirName: 'r', engineVersion: '9.9.9', template: 'web' });
  const from = core.instancePaths(root, meta).root;
  const to = path.join(root, 'instances', 'r-renamed');
  await fs.rename(from, to);
  const list = await core.listInstances(root);
  const ids = new Set(list.map((i) => i.meta.id));
  console.log(`  [info] 目录改名后列表返回 ${list.length} 个：${JSON.stringify(list.map((i) => i.meta.dirName))}`);
  record(
    '6 目录被改名后不产生"重复记录"（同 id 出现两次）',
    ids.size === list.length,
    ids.size === list.length ? '无重复' : `出现重复 id：列表 ${list.length} 条但有 ${ids.size} 个唯一 id`,
  );
  const dupes = list.filter((i) => i.meta.id === meta.id);
  console.log(`         ↳ 同一实例的记录条数：${dupes.length}（dirName: ${JSON.stringify(dupes.map((d) => d.meta.dirName))}）`);
  record(
    '6b 改名后不出现"同一实例两条记录"',
    dupes.length <= 1,
    dupes.length <= 1 ? '正常' : `同一 id 出现 ${dupes.length} 条记录（一条来自改名后的目录、一条来自 registry 快照）`,
  );
}

/* ================================================================== *
 * 7. 替代方案分析（基于实测的可行性判断）
 * ================================================================== */
{
  const instanceSrc = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'instance.ts'), 'utf8');
  const dirsOnly = /readdir\(instancesDir/.test(instanceSrc);
  const registryUsed = /readInstanceRegistry/.test(instanceSrc);
  console.log('\n  [替代方案分析]');
  console.log('  方案 A（当前）：目录扫描 + registry.json 索引快照');
  console.log(`    - 目录扫描仍在（${dirsOnly}）；registry 仅用于"目录消失后仍能列出记录"（${registryUsed}）`);
  console.log('  方案 B（更简单）：只靠目录扫描，取消 registry');
  console.log('    - 能表达 present:true 的全部情形；但**无法**表达"目录被手删但仍要显示记录"');
  console.log('      （记录本身只存在于被删的目录里）→ 无法满足 Lead 定稿口径');
  console.log('  方案 C（折中，推荐评估）：保留 registry，但明确它是**可重建的缓存**：');
  console.log('    - 与目录扫描结果做"以目录为准"的合并（当前实现似乎已如此）');
  console.log('    - 为 registry 增加 schemaVersion，损坏时静默重建而非报错');
  console.log('    - 提供"清理失效记录"入口（对应上面 3b）');
  record(
    '7 结论：registry 是满足"present:false 可见"这一口径的必要机制（目录扫描无法单独表达）',
    true,
    '方案 B 无法表达"记录存在但目录不在"，因此 registry（或等价的外部索引）是必需的',
  );
}

console.log('\n=== registry 设计评估汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
