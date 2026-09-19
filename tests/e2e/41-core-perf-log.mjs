/**
 * QA 补充测量：真实尺度下的性能 + 日志增长 + 本机数据未被污染的核对。
 *
 * 运行：node tests/e2e/41-core-perf-log.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const mod = await loadCoreBundle();
const { core, engine } = mod;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ================================================================== *
 * 1. 真实 dsh 安装的目录大小统计成本
 * ================================================================== */
{
  const realDsh = 'F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh';
  const exists = await fs.access(path.join(realDsh, 'package.json')).then(() => true, () => false);
  if (!exists) {
    console.log('  SKIP  真实 dsh 不可用，跳过真实尺度性能测量');
  } else {
    // 先数文件数（用 Node 自己遍历，避免依赖被测代码）
    let files = 0;
    let bytes = 0;
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          files += 1;
          bytes += (await fs.stat(full)).size;
        }
      }
    };
    const t0 = Date.now();
    await walk(realDsh);
    const ownMs = Date.now() - t0;
    console.log(`  [info] 真实 dsh 包：${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB，独立遍历耗时 ${ownMs}ms`);

    const t1 = Date.now();
    const size = await core.dirSize(realDsh);
    const sizeMs = Date.now() - t1;
    record(
      'P5 dirSize 在真实 dsh 尺度（数千文件）下可用',
      size !== null && sizeMs < 5000,
      `dirSize=${(size / 1024 / 1024).toFixed(1)}MB 耗时 ${sizeMs}ms（独立遍历 ${ownMs}ms）`,
    );

    // listEngines 会对每个引擎调一次 dirSize；用 junction 把真实 dsh 接进引擎目录来测量
    const root = await makeTempRoot('perf-real-engine');
    const info = await engine.attachEngineFromLocal(root, realDsh);
    const t2 = Date.now();
    const engines = await core.listEngines(root);
    const listMs = Date.now() - t2;
    record(
      'P6 listEngines 对真实尺度引擎的耗时（含递归算大小）',
      listMs < 5000,
      `${listMs}ms，返回 ${engines.length} 个引擎，sizeBytes=${engines[0]?.sizeBytes}`,
    );

    // main 每次 engine:list 都会触发一次全量 dirSize —— 界面轮询下的放大效应
    const t3 = Date.now();
    for (let i = 0; i < 3; i += 1) await core.listEngines(root);
    const repeatMs = Date.now() - t3;
    record(
      'P7 重复调用 listEngines 的成本（是否值得做缓存）',
      true,
      `连续 3 次共 ${repeatMs}ms（单次约 ${Math.round(repeatMs / 3)}ms）；若 UI 每次刷新都调用，属于可优化点`,
    );
    void info;
  }
}

/* ================================================================== *
 * 2. 日志增长：多次启动后的日志目录
 * ================================================================== */
{
  const root = await makeTempRoot('log-growth');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'lg',
    dirName: 'lg',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  process.env.STUB_EXIT_AFTER_MS = '400';
  for (let i = 0; i < 3; i += 1) {
    await core.launchInstance(root, meta, { instanceId: meta.id }, { primaryHome: '' }, {});
    // 等它自己退出
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && core.runtimeOf(meta.id).state === 'running') {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  delete process.env.STUB_EXIT_AFTER_MS;
  const files = await fs.readdir(paths.logs);
  let total = 0;
  for (const f of files) total += (await fs.stat(path.join(paths.logs, f))).size;
  record(
    'L9 每次启动产生独立日志文件（不会单文件无限增长）',
    files.length >= 3,
    `${files.length} 个文件，合计 ${total} 字节`,
  );

  // 轮转：真跑 12 次启动，验证文件数被 MAX_LOG_FILES 截住（而不是只查源码里有没有关键字）
  const extra = 9;
  for (let i = 0; i < extra; i += 1) {
    process.env.STUB_EXIT_AFTER_MS = '250';
    await core.launchInstance(root, meta, { instanceId: meta.id }, { primaryHome: '' }, {});
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && core.runtimeOf(meta.id).state === 'running') {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  delete process.env.STUB_EXIT_AFTER_MS;
  const after = (await fs.readdir(paths.logs)).filter((n) => n.endsWith('.log'));
  const launchSrc = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'launch.ts'), 'utf8');
  const maxFiles = Number(/MAX_LOG_FILES\s*=\s*(\d+)/.exec(launchSrc)?.[1] ?? 0);
  record(
    'L10 日志轮转真实生效（连跑 12 次后文件数被上限截住）',
    maxFiles > 0 && after.length <= maxFiles && after.length < 12,
    `共启动 ${3 + extra} 次；当前 ${after.length} 个 .log 文件，MAX_LOG_FILES=${maxFiles}`,
  );

  // 背压：是否已改为串行化写入（单写者队列 / 自动合并），而不是 void appendFile 发后不管
  const fireAndForget = /void appendFile\(logFile, text\)\.catch/.test(launchSrc);
  const serialized = /writeQueue|pendingWrite|enqueueLog|logWriter|appendQueue/.test(launchSrc);
  record(
    'L11 日志写盘有背压控制',
    !fireAndForget && serialized,
    fireAndForget
      ? 'emit() 仍用 `void appendFile(...)` 发后不管：高频输出时会累积大量未完成写操作'
      : `已改为串行化写入（单写者队列=${serialized}）`,
  );
}

/* ================================================================== *
 * 3. 核对：QA 全程未污染真实用户数据
 * ================================================================== */
{
  const realHome = path.join(process.env.USERPROFILE ?? 'C:\\Users\\user', '.dsh');
  const profiles = await fs.readdir(path.join(realHome, 'profiles')).catch(() => []);
  record(
    'X1 真实 ~/.dsh/profiles 未被 QA 用例新增目录',
    !profiles.includes('qa-ok') && !profiles.includes('qa-one') && !profiles.includes('qa-upper'),
    `现有 profiles：${profiles.join(', ')}`,
  );
  // 说明：`instances/` 现在是**真实交付数据**（Lead 用 CDP 实机截图验证时建的实例）。
  // 这里只核查"QA 用例有没有往交付目录里写"——所有 QA 用例都使用 fs.mkdtemp 生成的
  // `.spike/qa-*` 临时根，因此只要 instances/ 里出现的都是正常中文名的实例即可。
  const launcherRoot = process.cwd();
  const strayInstances = await fs.readdir(path.join(launcherRoot, 'instances')).catch(() => null);
  const qaArtifacts = (strayInstances ?? []).filter((name) => /^(qa-|ds-|rb-|cfg-|reg-|deep-|repro-|dsh-|cmd)/i.test(name));
  record(
    'X2 交付目录 instances/ 中没有 QA 用例留下的产物',
    qaArtifacts.length === 0,
    strayInstances === null
      ? 'instances/ 不存在'
      : `instances/ 内容：${JSON.stringify(strayInstances)}；QA 产物：${qaArtifacts.length === 0 ? '无' : JSON.stringify(qaArtifacts)}`,
  );
}

console.log('\n=== 性能/日志/污染核对 汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
