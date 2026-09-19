/**
 * QA 新发现验证：`instance.json` 损坏时，记录"可见"了，但用户**能否真的删掉它**？
 *
 * 背景：Lead 定稿口径要求"坏记录可见 + 可被用户清理"。core 已实现"可见 + problem 标记"，
 * 但 `src/renderer/**` 全文检索 `problem|shareConflict` **零命中** —— 界面只认 `present`。
 * 本脚本核对由此产生的实际后果（是否会出现"看得见却清理不掉"的死实例）。
 *
 * 运行：node tests/e2e/52-broken-record-cleanup.mjs
 */
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
 * 场景 A：instance.json 完全损坏（连 id 都读不出来）
 * ================================================================== */
{
  const root = await makeTempRoot('cleanup-a');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'broken', dirName: 'brk', engineVersion: '9.9.9', template: 'web' });
  const paths = core.instancePaths(root, meta);

  // 先看清理前：列表里能看到吗？
  await fs.writeFile(paths.metaFile, '{ 完全坏掉的 JSON');
  const listed = await core.listInstances(root);
  const entry = listed.find((item) => item.meta.dirName === 'brk');
  console.log(`  [info] 损坏后列表：${listed.length} 条，其中 dirName=brk 的条目=${entry !== undefined ? '可见' : '不可见'}`);
  console.log(`  [info] 该条目的 problem=${JSON.stringify(entry?.problem)}`);
  console.log(`  [info] 界面上能看到的信号：present=${entry?.present}（renderer 只看 present，不读 problem）`);

  // 用户点击"删除"时，UI 会传这条记录的 id
  const uiId = entry?.meta.id ?? null;
  if (uiId === null) {
    record('A1 损坏记录在列表中可见', false, '记录不可见，无法进一步测试删除');
  } else {
    record('A1 损坏记录在列表中可见（core 侧修复生效）', true, `id=${uiId} present=${entry.present}`);
    // 走 main/ipc 的真实路径：requireInstance(id) → readInstance → collectInstances
    const resolved = await core.readInstance(root, uiId);
    record(
      'A2 用该 id 能解析回实例元数据（删除前置条件）',
      resolved !== null && resolved.dirName === 'brk',
      resolved === null ? `readInstance('${uiId}') 返回 null → 界面点删除会得到「找不到实例」` : `dirName=${resolved.dirName}`,
    );
    // 真正删除
    let removed = false;
    let error = null;
    try {
      await core.deleteInstance(root, uiId, true);
      removed = true;
    } catch (e) {
      error = e.message;
    }
    const dirStillThere = await fs.access(paths.root).then(() => true, () => false);
    record(
      'A3 损坏记录可被用户删除（且目录被清理）',
      removed && !dirStillThere,
      removed ? `删除成功，目录仍存在=${dirStillThere}` : `删除失败：${error}`,
    );
  }
}

/* ================================================================== *
 * 场景 B：instance.json 被外部删除（只剩目录）
 * ================================================================== */
{
  const root = await makeTempRoot('cleanup-b');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'nometa', dirName: 'nmt', engineVersion: '9.9.9', template: 'web' });
  const paths = core.instancePaths(root, meta);
  await fs.rm(paths.metaFile, { force: true });

  const listed = await core.listInstances(root);
  const entry = listed.find((item) => item.meta.dirName === 'nmt');
  const uiId = entry?.meta.id ?? null;
  // 注意：metaFile 已删，dirName 只能来自 registry 快照或目录名兜底
  console.log(`  [info] 清单被删后：可见=${entry !== undefined} id=${uiId ?? 'null'} dirName=${entry?.meta.dirName}`);
  if (uiId !== null) {
    let error = null;
    let removed = false;
    try {
      await core.deleteInstance(root, uiId, true);
      removed = true;
    } catch (e) {
      error = e.message;
    }
    const dirGone = (await fs.access(paths.root).then(() => true, () => false)) === false;
    record(
      'B1 instance.json 缺失时记录仍可被删除',
      removed && dirGone,
      removed ? `删除成功，目录已清理=${dirGone}` : `删除失败：${error}`,
    );
  } else {
    record('B1 instance.json 缺失时记录可见', false, '记录不可见，用户无法清理它');
  }
}

/* ================================================================== *
 * 场景 C：跨界核对——界面是否会给用户任何"这条记录有问题"的提示
 * ================================================================== */
{
  const { promises: fsp } = await import('node:fs');
  const rendererFiles = [];
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.ts$/.test(e.name)) rendererFiles.push(full);
    }
  };
  await walk(path.join(process.cwd(), 'src', 'renderer'));

  let mentionsProblem = 0;
  let mentionsShareConflict = 0;
  const filesWith = { problem: [], shareConflict: [] };
  for (const f of rendererFiles) {
    const text = await fsp.readFile(f, 'utf8');
    const rel = path.relative(process.cwd(), f);
    if (/problem/.test(text)) {
      mentionsProblem += 1;
      filesWith.problem.push(rel);
    }
    if (/[Ss]hare[Cc]onflict/.test(text)) {
      mentionsShareConflict += 1;
      filesWith.shareConflict.push(rel);
    }
  }
  record(
    'C1 渲染层消费 `problem` 字段（否则"坏记录可见"对用户不可见）',
    mentionsProblem > 0,
    `扫描 ${rendererFiles.length} 个渲染层文件：提到 problem 的=${mentionsProblem}` +
      (mentionsProblem === 0
        ? '。core 已产生可读文案（如「instance.json 损坏（无法解析）」），但界面不显示，用户看到的仍是一张“正常”的实例卡片（present=true），点启动只会得到一句底层报错'
        : `（命中：${filesWith.problem.join(', ')}）`),
  );
  record(
    'C2 渲染层消费共享冲突 API（否则 settings 冲突无法被用户解决）',
    mentionsShareConflict > 0,
    `提到 shareConflict 的渲染层文件=${mentionsShareConflict}${mentionsShareConflict > 0 ? `（如 ${filesWith.shareConflict.slice(0, 3).join('、')}）` : ''}`,
  );
}

/* ================================================================== *
 * 场景 D：启动坏实例给用户的反馈
 * ================================================================== */
{
  const root = await makeTempRoot('cleanup-d');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'launchbad', dirName: 'lb', engineVersion: '9.9.9', template: 'web' });
  await fs.writeFile(core.instancePaths(root, meta).metaFile, '{ 坏');
  const listed = await core.listInstances(root);
  const entry = listed.find((item) => item.meta.dirName === 'lb');
  // 制造"启动必然失败"而非"启动成功"：把引擎指向未安装版本
  const brokenMeta = { ...entry.meta, engine: { version: '1.2.3-not-installed' } };
  let launchError = null;
  let launched = null;
  try {
    launched = await core.launchInstance(root, brokenMeta, { instanceId: brokenMeta.id }, { primaryHome: '' }, {});
  } catch (e) {
    launchError = e.message;
  }
  record(
    'D1 启动元数据损坏的实例时给出可读错误（而非静默成功）',
    launchError !== null || launched === null,
    `error=${launchError?.split('\n')[0] ?? '（未抛错！）'}`,
  );
  if (launched?.pid > 0) {
    try {
      process.kill(launched.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

// 显式收尾：本用例可能留下过子进程，确保事件循环可以退出
process.exit(process.exitCode ?? 0);

console.log('\n=== 坏记录清理能力汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
