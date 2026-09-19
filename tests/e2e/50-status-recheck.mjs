/**
 * QA 快速状态核对：把 code-review.md 里每个待修项对着**当前源码**重新判定。
 * 只读源码 + 少量真实调用，不依赖长驻进程，便于在他人并行改 code 时反复跑。
 *
 * 运行：node tests/e2e/50-status-recheck.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, REPO_ROOT } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const mod = await loadCoreBundle();
const { core, engine } = mod;
const results = [];
const record = (id, name, fixed, evidence) => {
  results.push({ id, name, fixed, evidence });
  console.log(`  ${fixed ? '已修复' : '仍存在'}  ${id}  ${name}`);
  if (evidence) console.log(`         ${evidence}`);
};

const read = (rel) => fs.readFile(path.join(REPO_ROOT, rel), 'utf8');

/* QR-01 settings 静默覆盖 */
{
  const root = await makeTempRoot('rc-settings');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'A', dirName: 'ra', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'B', dirName: 'rb', engineVersion: '9.9.9', template: 'web' });
  const pa = core.instancePaths(root, a);
  const pb = core.instancePaths(root, b);
  await fs.writeFile(pa.settingsFile, 'owner: A\n');
  await fs.writeFile(pb.settingsFile, 'owner: B\n');
  const config = { primaryHome: path.join(root, 'nope') };
  await core.applyShareModes(root, { ...a, settings: { mode: 'shared' } }, config);
  await core.applyShareModes(root, { ...b, settings: { mode: 'shared' } }, config);
  const nowB = await fs.readFile(pb.settingsFile, 'utf8').catch(() => null);
  record(
    'QR-01',
    'settings: shared 静默覆盖实例设置',
    nowB === 'owner: B\n',
    `B 的设置=${JSON.stringify(nowB)}（期望保留 "owner: B"）`,
  );
  // 冲突是否被显式记录
  const src = await read('src/core/instance.ts');
  const hasConflictApi = /listShareConflicts/.test(src);
  console.log(`         冲突记录 API（listShareConflicts）存在=${hasConflictApi}`);
}

/* QR-02 实例凭空消失 */
{
  const root = await makeTempRoot('rc-vanish');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'a', dirName: 'a', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'b', dirName: 'b', engineVersion: '9.9.9', template: 'web' });
  const c = await core.createInstance(root, { name: 'c', dirName: 'c', engineVersion: '9.9.9', template: 'web' });
  await fs.writeFile(core.instancePaths(root, a).metaFile, '{ 坏');
  await fs.writeFile(path.join(core.instancePaths(root, b).profileDir, 'package.json'), '{ 坏');
  await fs.rm(core.instancePaths(root, c).root, { recursive: true, force: true });
  const list = await core.listInstances(root);
  const ids = new Set(list.map((i) => i.meta.id));
  record(
    'QR-02',
    '异常实例从列表消失',
    ids.has(a.id) && ids.has(b.id) && ids.has(c.id),
    `元数据坏=${ids.has(a.id)} 清单坏=${ids.has(b.id)} 目录删=${ids.has(c.id)}（返回 ${list.length} 个，期望 3 个都可见）`,
  );
  const problems = list.map((i) => i.problem).filter(Boolean);
  console.log(`         可读 problem 标记：${problems.length} 条 —— ${JSON.stringify(problems)}`);
}

/* QR-03 导入时 YAML 校验 */
{
  const src = await read('src/core/modpack.ts');
  const validates = /const yamlProblem = validateYaml\(settings\)/.test(src);
  const skipsOnProblem = /if \(yamlProblem !== null\)[\s\S]{0,300}else \{[\s\S]{0,120}writeTextAtomic\(paths\.settingsFile, settings\)/.test(src);
  record(
    'QR-03',
    'importPack 绕过 YAML 校验',
    validates && skipsOnProblem,
    `写入前 validateYaml=${validates} 不合法则跳过写入并记 warning=${skipsOnProblem}`,
  );
}

/* QR-04 launcher.json 损坏自愈 */
{
  const src = await read('src/main/config.ts');
  const heals = /catch[\s\S]{0,200}(bak|default|恢复)/i.test(src.slice(src.indexOf('export async function loadConfig'), src.indexOf('export async function saveConfig')));
  record('QR-04', '损坏的 launcher.json 无自愈路径', heals, heals ? 'loadConfig 已有兜底' : 'loadConfig 仍直接 readJson，无 try/catch');
}

/* QR-05 listAvailableEngines 的 root */
{
  const ipc = await read('src/main/ipc.ts');
  const eng = await read('src/core/engine.ts');
  const idx = await read('src/core/index.ts');
  const mainPassesRoot = /listAvailableEngines\([^)]*launcherRoot\(\)/.test(ipc);
  const indexKeepsRoot = /listAvailableEngines:\s*\(registry: string,\s*root\?: string\)/.test(idx);
  const cwdFallback = /process\.cwd\(\)/.test(eng.slice(eng.indexOf('function defaultRootForCache')));
  record(
    'QR-05',
    'listAvailableEngines 的 npm cache 根依赖 process.cwd()',
    mainPassesRoot && !cwdFallback,
    `index 透传 root=${indexKeepsRoot}；main 传 launcherRoot=${mainPassesRoot}；engine 仍回退 cwd=${cwdFallback}`,
  );
}

/* QR-06 .cmd 垫片包装 */
{
  const proc = await read('src/core/proc.ts');
  const doubleQuote = /const inner = \[quoteCmdArg\(file\), \.\.\.args\.map\(quoteCmdArg\)\]\.join\(' '\);[\s\S]{0,120}`"\$\{inner\}"`/.test(proc);
  const verbatimCount = (proc.match(/windowsVerbatimArguments:\s*resolved\.verbatim === true/g) ?? []).length;
  record(
    'QR-06',
    'cmd.exe /d /s /c 缺少外层引号（降级路径 npm 全废）',
    doubleQuote && verbatimCount >= 4,
    `双层引号=${doubleQuote}；windowsVerbatimArguments 覆盖 ${verbatimCount}/4 条 spawn 路径`,
  );
}

/* QR-08 listEngines 递归算大小 */
{
  const src = await read('src/core/engine.ts');
  const caches = /engineSizeCache/.test(src);
  const lazy = /function lazyEngineSize/.test(src) && /void computeEngineSize\(dir\)/.test(src);
  const mtimeSignature = /signature/.test(src) && /mtimeMs\(dir\)/.test(src);
  record(
    'QR-08',
    'listEngines 每次递归算目录大小（真实 dsh 26513 文件 / 1.4s）',
    caches && lazy && mtimeSignature,
    `engineSizeCache=${caches} 惰性+后台单飞=${lazy} mtime 签名失效=${mtimeSignature}` +
      (lazy ? '（首次返回 null、后台算完下次刷新生效；契约允许 sizeBytes 为 null）' : ''),
  );
}

/* QR-09/QR-10 日志背压与轮转 */
{
  const launch = await read('src/core/launch.ts');
  // 背压：序列化写入（单写者队列 / 自动合并），而不是 void appendFile
  const fireAndForget = /void appendFile\(logFile, text\)/.test(launch);
  const serialized = /writeQueue|pendingWrite|enqueueLog|logWriter|chain/.test(launch);
  const rotation = /pruneOldLogs/.test(launch) && /MAX_LOG_FILES/.test(launch);
  record(
    'QR-09',
    '日志写盘无背压（void appendFile）',
    !fireAndForget && serialized,
    `仍是发后不管=${fireAndForget}；已串行化=${serialized}`,
  );
  record(
    'QR-10',
    '日志目录无轮转/上限',
    rotation,
    rotation
      ? '已有 pruneOldLogs + MAX_LOG_FILES（启动前先腾位置，保留最近 N 个）'
      : '仍无轮转策略',
  );
}

/* QR-12 切换未安装引擎版本 */
{
  const root = await makeTempRoot('rc-switch');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'sw', dirName: 'sw', engineVersion: '9.9.9', template: 'web' });
  let rejected = false;
  try {
    await core.updateInstance(root, meta.id, { engineVersion: '1.2.3-not-installed' });
  } catch {
    rejected = true;
  }
  const src = await read('src/core/instance.ts');
  const allowUninstalled = /允许未安装|not installed but|未安装也允许/.test(src);
  record(
    'QR-12',
    '可切到未安装的引擎版本',
    rejected || allowUninstalled,
    rejected ? '已被拒绝' : allowUninstalled ? '源码显式声明允许（需确认 UI 有提示）' : '仍可写入且无提示',
  );
}

/* QR-13 删除实例后的共享目录残留 */
{
  const src = await read('src/core/instance.ts');
  // 定稿方案（Lead 确认）：**不做自动清理**，改为"报告 + 显式清理入口"。
  // 理由正是 QA 的 D1 用例证明"自动清理会碰到 junction/共享数据"，风险高于收益。
  const reports = /deleteInstanceDetailed/.test(src) && /findOrphanSharedWorkspaces/.test(src);
  const explicitCleanup = /removeOrphanSharedWorkspace/.test(src);
  const guard = /拒绝清理仍有实例认领|未被认领|orphan/i.test(src);
  record(
    'QR-13',
    '删除实例后共享目录残留',
    reports && explicitCleanup,
    `报告残留=${reports} 显式清理 API=${explicitCleanup} 认领校验=${guard}` +
      `（采用"只报告 + 用户显式清理"，而非自动删除——自动删除有碰到共享数据的风险）`,
  );
}

/* QR-17 渲染层是否消费 problem 字段（QA 新发现，当前仍未闭环） */
{
  const { promises: fsp } = await import('node:fs');
  const files = [];
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ts$/.test(e.name)) files.push(full);
    }
  };
  await walk(path.join(REPO_ROOT, 'src', 'renderer'));
  let hits = 0;
  for (const f of files) if (/problem/.test(await fsp.readFile(f, 'utf8'))) hits += 1;
  record(
    'QR-17',
    '界面不消费 problem 字段（坏记录在 UI 上显示为正常卡片）',
    hits > 0,
    `扫描 ${files.length} 个渲染层文件：提到 problem 的=${hits}` +
      (hits === 0
        ? '；core 已产生可读文案但界面不显示，用户看到一张“正常”卡片却怎么都启动不了'
        : ''),
  );
}

/* QR-11 devTools（登记项，等 T5） */
{
  const main = await read('src/main/index.ts');
  const devToolsLiteral = /devTools:\s*true/.test(main);
  console.log(`  [登记] QR-11 devTools 恒为 true（等 T5 复核）：${devToolsLiteral ? '仍是字面量 true' : '已按环境开关'}`);
}

console.log('\n=== 状态核对汇总 ===');
const stillOpen = results.filter((r) => !r.fixed);
console.log(`检查 ${results.length} 项：已修复 ${results.length - stillOpen.length}，仍存在 ${stillOpen.length}`);
if (stillOpen.length > 0) {
  console.log('仍存在：');
  for (const item of stillOpen) console.log(`  - ${item.id} ${item.name}`);
}
void engine;
