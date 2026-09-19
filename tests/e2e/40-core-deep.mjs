/**
 * QA 深度审查：`src/core/**`（当前最稳定、优先级最高的审查目标）。
 *
 * 覆盖此前未验证的高风险点：
 *  1. 删除/卸载时是否会被目录内的 junction 反向穿透删除外部数据（最高优先级）
 *  2. 版本号比较（dsh 用 alpha/beta 预发布版本，字典序比较会错序）
 *  3. `listAvailableEngines` 的 npm cache 根目录推导（缓存会不会落到工作区外 → EPERM）
 *  4. 切换引擎版本时是否校验目标版本已安装
 *  5. workspaceKeyFor 与真实 dsh 会话目录名的逐字节比对
 *  6. 组合包开关（直接改 package.json 是否违背"插件操作走 CLI"）
 *
 * 运行：node tests/e2e/40-core-deep.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, REPO_ROOT } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const mod = await loadCoreBundle();
const { core, engine, names, paths: corePathsMod } = mod;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ================================================================== *
 * 1. 删除类操作会不会被 junction 反向穿透
 * ================================================================== */
{
  const root = await makeTempRoot('deep-junction');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'jn',
    dirName: 'jn',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);

  // 在实例目录内部放一个指向"外部重要数据"的 junction
  const precious = path.join(root, 'PRECIOUS-DATA');
  await fs.mkdir(precious, { recursive: true });
  await fs.writeFile(path.join(precious, 'important.txt'), '外部重要数据');

  // 1a. home/ 内部放 junction
  await core.replaceWithJunction(path.join(paths.home, 'linked-external'), precious);
  // 1b. workspace/ 内部放 junction
  await core.replaceWithJunction(path.join(paths.workspace, 'linked-ws'), precious);

  await core.deleteInstance(root, meta.id, true);
  const afterDelete = await fs.readFile(path.join(precious, 'important.txt'), 'utf8').catch(() => null);
  record(
    'D1 删除实例（deleteFiles=true）不穿透内部 junction 删除外部数据',
    afterDelete === '外部重要数据',
    `外部文件内容=${afterDelete === null ? '<被删除！>' : afterDelete}`,
  );
}

/* 1c. 卸载引擎：引擎包是 junction（attachEngineFromLocal 的真实形态） */
{
  const root = await makeTempRoot('deep-engine-link');
  const sourceDsh = 'F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh';
  const sourceExists = await fs.access(path.join(sourceDsh, 'package.json')).then(() => true, () => false);
  if (!sourceExists) {
    console.log('  SKIP  真实 dsh 包不可用，跳过"引擎为 junction 时的卸载安全"用例');
  } else {
    const info = await engine.attachEngineFromLocal(root, sourceDsh);
    const link = path.join(root, 'engines', info.version, 'node_modules', '@deepseek-ai', 'dsh');
    const isLink = await core.isLink(link);
    await core.removeEngine(root, info.version);
    const sourceIntact = await fs.access(path.join(sourceDsh, 'lib', 'bin.js')).then(() => true, () => false);
    record(
      'D2 卸载"以 junction 接入"的引擎不会删掉真实 dsh 全局安装',
      isLink && sourceIntact,
      `引擎包是链接=${isLink} 真实 dsh 的 lib/bin.js 仍在=${sourceIntact}（源：${sourceDsh}）`,
    );
  }
}

/* ================================================================== *
 * 2. 版本号比较（预发布版本）
 * ================================================================== */
{
  const cmp = engine.compareVersions;
  const cases = [
    ['0.1.6-alpha.2', '0.1.6-alpha.10', -1, 'semver：alpha.2 < alpha.10'],
    ['0.1.6-alpha.10', '0.1.6-beta.1', -1, 'semver：alpha < beta'],
    ['0.1.6', '0.1.6-alpha.2', 1, 'semver：正式版 > 预发布'],
    ['0.1.10', '0.1.9', 1, '数字段按数值比较'],
    ['0.2.0', '0.10.0', -1, '数字段按数值比较（2 < 10）'],
  ];
  const wrong = [];
  for (const [left, right, expected, label] of cases) {
    const actual = cmp(left, right);
    const normalized = actual === 0 ? 0 : actual > 0 ? 1 : -1;
    const ok = normalized === expected;
    console.log(`    compareVersions(${left}, ${right}) = ${actual}（期望 ${expected > 0 ? '>' : '<'}）  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) wrong.push(`${left} vs ${right}：期望 ${expected}，实得 ${actual}（${label}）`);
  }
  record('E1 版本号比较符合 semver（含预发布段数值比较）', wrong.length === 0, wrong.join(' | ') || '5/5 通过');

  // 版本列表排序：是否把最新的排在前面
  const list = ['0.1.6-alpha.2', '0.1.6-alpha.10', '0.1.6-beta.1', '0.1.5'];
  const sorted = [...list].sort(cmp).reverse();
  console.log(`    排序后：${sorted.join(' → ')}`);
  record(
    'E2 版本列表把最新版排在首位',
    sorted[0] === '0.1.6-beta.1',
    `首位=${sorted[0]}（期望 0.1.6-beta.1）`,
  );
}

/* ================================================================== *
 * 3. listAvailableEngines 的 cache 根目录推导
 * ================================================================== */
{
  const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'engine.ts'), 'utf8');
  const indexSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'index.ts'), 'utf8');
  const mainIpc = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'ipc.ts'), 'utf8');
  const defaultRootUsesCwd = /process\.cwd\(\)/.test(src.slice(src.indexOf('function defaultRootForCache')));
  const indexKeepsRoot = /listAvailableEngines:\s*\(registry: string,\s*root\?: string\)\s*=>\s*listAvailableEngines\(registry,\s*root\)/.test(indexSrc);
  const mainPassesRoot = /listAvailableEngines\([^)]*launcherRoot\(\)/.test(mainIpc);

  record(
    'F0 core 单例保留 root 参数（已修复：曾一度被丢弃）',
    indexKeepsRoot,
    indexKeepsRoot ? 'index.ts 已透传 root' : 'index.ts 仍丢弃 root',
  );
  // 判定口径（已更新）：main 既可以显式传 root，也可以在启动时把 launcherRoot() 钉进
  // WHALES_LAUNCHER_ROOT（core 的 defaultRootForCache() 会读它）。二者任一成立即消除风险。
  const mainAnchorsEnv = /process\.env\['WHALES_LAUNCHER_ROOT'\]\s*=/.test(
    await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8'),
  );
  record(
    'F1 npm cache 根目录已锚定（显式传 root 或注入 WHALES_LAUNCHER_ROOT）',
    mainPassesRoot || mainAnchorsEnv,
    mainPassesRoot
      ? 'main 显式传 launcherRoot()'
      : mainAnchorsEnv
        ? 'main 启动时注入 process.env.WHALES_LAUNCHER_ROOT = launcherRoot()（覆盖所有 defaultRootForCache 调用点）'
        : 'main/ipc.ts:189 只传 registry，且无 WHALES_LAUNCHER_ROOT 锚定 → 回退 process.cwd()，从快捷方式/其他 cwd 启动时 npm cache 会落到非预期目录',
  );
  record(
    'F2 defaultRootForCache 的 cwd 回退是否还有实际风险',
    mainPassesRoot || mainAnchorsEnv || !defaultRootUsesCwd,
    defaultRootUsesCwd
      ? 'engine.ts 仍保留 process.cwd() 回退，但已被 main 的锚定覆盖 → 无实际风险（保留回退便于独立调用）'
      : 'engine.ts 无 cwd 回退',
  );
}

/* ================================================================== *
 * 4. 切换引擎版本是否校验已安装
 * ================================================================== */
{
  const root = await makeTempRoot('deep-engine-switch');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'sw',
    dirName: 'sw',
    engineVersion: '9.9.9',
    template: 'web',
  });
  let updated = null;
  let error = null;
  try {
    updated = await core.updateInstance(root, meta.id, { engineVersion: '1.2.3-not-installed' });
  } catch (e) {
    error = e.message;
  }
  const summary = (await core.listInstances(root)).find((item) => item.meta.id === meta.id);
  record(
    'G1 切换到未安装的引擎版本应被拒绝（否则实例进入必然启动失败的状态）',
    error !== null || updated === null,
    error !== null
      ? `已拒绝：${error}`
      : `切换成功（未安装也写入）：engineVersion=${updated.engine.version}，列表 engineInstalled=${summary?.engineInstalled}`,
  );
}

/* ================================================================== *
 * 5. workspaceKeyFor 与真实 dsh 会话目录名比对
 * ================================================================== */
{
  // 真实数据来源：docs/research/dsh-interface.md §5 记录的实测目录名
  const real = [
    ['F:\\WhalesLauncher', '--F-WhalesLauncher--', '本仓库根'],
    ['C:\\Users\\user\\.dsh', '--C-Users-user-.dsh--', '真实 dsh home'],
    ['F:\\ComFYUI', '--F-ComFYUI--', '外部项目'],
  ];
  const wrong = [];
  for (const [input, expected, label] of real) {
    const actual = core.workspaceKeyFor(input);
    console.log(`    workspaceKeyFor(${JSON.stringify(input)}) = ${actual}（期望 ${expected}）${actual === expected ? ' ✓' : ' ✗'}`);
    if (actual !== expected) wrong.push(`${label}：期望 ${expected}，实得 ${actual}`);
  }
  record('H1 workspaceKeyFor 与真实 dsh 会话目录名一致', wrong.length === 0, wrong.join(' | ') || '3/3 一致');

  // 中文 / 空格 / 波浪号的编码（dsh 用 ~XXXX）
  const encoded = core.workspaceKeyFor('F:\\我的 项目~1');
  console.log(`    workspaceKeyFor('F:\\我的 项目~1') = ${encoded}`);
  record('H2 非 ASCII 路径按 ~XXXX 编码且不退化为空', encoded.length > 4 && /~[0-9A-F]{4}/.test(encoded), `结果=${encoded}`);
}

/* ================================================================== *
 * 6. 组合包开关的写入路径
 * ================================================================== */
{
  const root = await makeTempRoot('deep-bundle');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'bd',
    dirName: 'bd',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  const before = JSON.parse(await fs.readFile(path.join(paths.profileDir, 'package.json'), 'utf8'));
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-experimental-agent-team-web-profile', true);
  const after = JSON.parse(await fs.readFile(path.join(paths.profileDir, 'package.json'), 'utf8'));
  const added = after.dsh.profile.bundles.includes('@deepseek-ai/dsh-experimental-agent-team-web-profile');
  record(
    'I1 setBundleEnabled 直接改写 package.json 的 dsh.profile.bundles（未走 dsh CLI）',
    added,
    `bundle 列表：${JSON.stringify(before.dsh.profile.bundles)} → ${JSON.stringify(after.dsh.profile.bundles)}；是否调用 dsh CLI=否`,
  );
  // 契约要求"插件增删走 CLI"；组合包开关是否属于同一约束需 Lead 判定
  const pluginsSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'profile.ts'), 'utf8');
  const note = /本启动器不碰/.test(pluginsSrc);
  record('I2 profile.ts 明确声明了"不碰 patch 条目级 disabled"的边界', note, '（组合包开关=改 package.json，属声明式清单）');

  // 禁用后再启用，顺序语义是否符合注释（启用追加到末尾）
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-base', false);
  await core.setBundleEnabled(root, meta, '@deepseek-ai/dsh-base', true);
  const finalManifest = JSON.parse(await fs.readFile(path.join(paths.profileDir, 'package.json'), 'utf8'));
  record(
    'I3 禁用后重新启用会追加到末尾（组合顺序=优先级语义）',
    finalManifest.dsh.profile.bundles[finalManifest.dsh.profile.bundles.length - 1] === '@deepseek-ai/dsh-base',
    `最终列表=${JSON.stringify(finalManifest.dsh.profile.bundles)}`,
  );

  // 非法包名必须被拒绝
  let badError = null;
  try {
    await core.setBundleEnabled(root, meta, '../../evil', true);
  } catch (e) {
    badError = e.message;
  }
  record('I4 非法组合包名被拒绝', badError !== null, `error=${badError}`);
}

/* ================================================================== *
 * 7. 实例"凭空消失"场景的当前状态核对
 * ================================================================== */
{
  const instanceSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'instance.ts'), 'utf8');
  const hasRegistry = /INSTANCE_REGISTRY_FILE/.test(instanceSrc) && /async function readInstanceRegistry/.test(instanceSrc);
  const summarizeHasProblem = /problem\?: string/.test(instanceSrc) && /summary\.problem = problem/.test(instanceSrc);
  const hasDegrade = /存在性问题一律降级呈现|降级呈现/.test(instanceSrc);
  record(
    'J1 列表对异常实例的降级呈现已落地（registry 快照 + problem 标记）',
    hasRegistry && summarizeHasProblem && hasDegrade,
    `registry 快照=${hasRegistry} problem 字段=${summarizeHasProblem} 降级注释=${hasDegrade}`,
  );

  // 仍存在的缺口：实例目录被手删且 registry 里没有快照时，记录会不会丢
  const root = await makeTempRoot('deep-vanish');
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'va', dirName: 'va', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'vb', dirName: 'vb', engineVersion: '9.9.9', template: 'web' });
  // 把 registry.json 也删掉，模拟"旧版本启动器升级上来"或 registry 丢失
  await fs.rm(path.join(root, 'instances', 'registry.json'), { force: true });
  await fs.rm(core.instancePaths(root, b).root, { recursive: true, force: true });
  const list = await core.listInstances(root);
  const ids = new Set(list.map((item) => item.meta.id));
  record(
    'J2 目录被手删 + registry.json 缺失时，实例记录仍可见（可被删除）',
    ids.has(a.id) && ids.has(b.id),
    `可见：a=${ids.has(a.id)} b=${ids.has(b.id)}（返回 ${list.length} 个）` +
      (ids.has(b.id) ? '' : '；b 的记录彻底消失，用户无法在界面上清理它'),
  );
}

console.log('\n=== core 深度审查用例汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
void names;
void corePathsMod;
if (failed.length > 0) process.exitCode = 1;
