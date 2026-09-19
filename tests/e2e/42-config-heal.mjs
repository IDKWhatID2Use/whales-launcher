/**
 * QA 补充：配置文件损坏的自愈 + 归档一致性小项。
 *
 * 运行：node tests/e2e/42-config-heal.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, REPO_ROOT } from './_bundle.mjs';

const mod = await loadCoreBundle();
const { core } = mod;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ================================================================== *
 * 1. 损坏的 launcher.json：main/config.ts 的 loadConfig 会不会自愈
 * ================================================================== */
{
  const root = await makeTempRoot('cfg-heal');
  const configFile = path.join(root, 'launcher.json');
  await fs.writeFile(configFile, '{ 这是坏掉的 JSON');

  // 复刻 main/config.ts loadConfig 的逻辑（main 依赖 Electron，无法直接跑）
  const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'config.ts'), 'utf8');
  const hasTryCatch = /export async function loadConfig[\s\S]*?try\s*\{[\s\S]*?readJson/.test(src);
  let recovered = false;
  try {
    const raw = await core.readJson(configFile);
    if (raw === null) recovered = true;
  } catch {
    recovered = false;
  }
  record(
    'K1 全局配置损坏时 loadConfig 有自愈/降级路径',
    hasTryCatch || recovered,
    hasTryCatch
      ? '有 try/catch 兜底'
      : `readJson 对坏 JSON 抛错；core.readJson 行为 = ${recovered ? '返回 null' : '抛错'}。` +
        `而 main/config.ts:51 直接调用 readJson 且无 try/catch → 一个损坏的 launcher.json 会让 launcher:getConfig 返回 Result.error，` +
        `界面拿不到配置（实例列表等后续调用也会受影响），且用户没有"恢复默认配置"的入口`,
  );
}

/* ================================================================== *
 * 2. core.readJson 对坏 JSON 的行为（确认上面的判定）
 * ================================================================== */
{
  const root = await makeTempRoot('cfg-readjson');
  const file = path.join(root, 'x.json');
  await fs.writeFile(file, '{ 坏的');
  let threw = null;
  let value = 'unset';
  try {
    value = await core.readJson(file);
  } catch (e) {
    threw = e.message;
  }
  record(
    'K2 readJson 对损坏 JSON 抛错（而非静默返回 null）',
    threw !== null,
    threw !== null ? `抛错：${threw.split('\n')[0]}` : `返回 ${JSON.stringify(value)}`,
  );
  const missing = await core.readJson(path.join(root, 'not-exist.json'));
  record('K2b readJson 对缺失文件返回 null（自愈路径可用）', missing === null);
}

/* ================================================================== *
 * 3. 空 bundles 模板的边界
 * ================================================================== */
{
  const root = await makeTempRoot('cfg-bundles');
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'sdkmin',
    dirName: 'sdkmin',
    engineVersion: '9.9.9',
    template: 'sdk-minimal',
  });
  const paths = core.instancePaths(root, meta);
  const manifest = JSON.parse(await fs.readFile(path.join(paths.profileDir, 'package.json'), 'utf8'));
  record(
    'K3 sdk-minimal 模板的 bundles 按契约写入（只有 sdk-minimal 一个包）',
    JSON.stringify(manifest.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-sdk-minimal']),
    `实际=${JSON.stringify(manifest.dsh.profile.bundles)}`,
  );
  let inv = null;
  let err = null;
  try {
    inv = await core.readProfileInventory(root, meta);
  } catch (e) {
    err = e.message;
  }
  record(
    'K3b 读插件清单对 sdk-minimal 实例不报错',
    err === null && inv !== null,
    err ?? `bundles=${inv?.bundles.length} dependencies=${inv?.dependencies.length}`,
  );
}

/* ================================================================== *
 * 4. listInstances 的相互隔离：instance.json 损坏 vs 目录缺失
 * ================================================================== */
{
  const root = await makeTempRoot('cfg-drop');
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'a', dirName: 'a', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'b', dirName: 'b', engineVersion: '9.9.9', template: 'web' });
  const c = await core.createInstance(root, { name: 'c', dirName: 'c', engineVersion: '9.9.9', template: 'web' });
  // a: instance.json 损坏；b: 整个目录被删；c: 健康
  await fs.writeFile(core.instancePaths(root, a).metaFile, '{ 坏');
  await fs.rm(core.instancePaths(root, b).root, { recursive: true, force: true });

  const list = await core.listInstances(root);
  const ids = new Set(list.map((i) => i.meta.id));
  record(
    'K4 三种异常态下，健康实例（c）始终可见',
    ids.has(c.id),
    `返回 ${list.length} 个：a(元数据坏)=${ids.has(a.id)} b(目录删)=${ids.has(b.id)} c(健康)=${ids.has(c.id)}`,
  );
  record(
    'K4b 异常实例在界面上有可见性（否则用户看到实例"凭空消失"）',
    ids.has(a.id) && ids.has(b.id),
    ids.has(a.id) && ids.has(b.id)
      ? '两者均可见'
      : `被静默丢弃：${[!ids.has(a.id) ? 'a(元数据损坏)' : null, !ids.has(b.id) ? 'b(目录被手删)' : null].filter(Boolean).join('、')}`,
  );
}

console.log('\n=== 配置自愈/边界 汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
