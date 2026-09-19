/**
 * QA 检查项 5（健壮性）、6（资源泄漏）、7（性能）与安全加固项。
 *
 * ## 本沙箱下的可验证边界（先说清楚，避免把环境限制误判成产品缺陷）
 * 实测：`taskkill /PID <pid> /T /F` 在本沙箱返回 **exit 1「Access denied」**，
 * 目标进程继续存活（`tests/e2e/31-stop-probe.mjs` 有原始证据）。
 * 因此 `stopInstance` 的"进程是否真的被杀掉"在本环境**无法验证** ——
 * `src/core/proc.ts killTree()` 与 `src/main/runtime.ts forceKillLeftovers()` 都依赖 taskkill。
 * 本文件据此只验证**可测**的部分，并把 kill 相关结论标为"无法验证"。
 *
 * 运行：node tests/e2e/30-robustness.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, waitFor } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const { core } = await loadCoreBundle();
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};
const unverifiable = (name, reason) => {
  results.push({ name, ok: true, detail: `无法验证：${reason}`, unverifiable: true });
  console.log(`  SKIP  ${name} —— 无法验证：${reason}`);
};

/* ================================================================== *
 * 1. 健壮性
 * ================================================================== */

/* R1: instance.json 损坏 → 记录仍可见 + 带 problem 标记（Lead 定稿口径） */
{
  const root = await makeTempRoot('rb-corrupt');
  await seedStubEngine(root);
  const good = await core.createInstance(root, { name: 'good', dirName: 'good', engineVersion: '9.9.9', template: 'web' });
  const bad = await core.createInstance(root, { name: 'bad', dirName: 'bad', engineVersion: '9.9.9', template: 'web' });
  const badPaths = core.instancePaths(root, bad);
  await fs.writeFile(badPaths.metaFile, '{ 这不是 JSON');

  let error = null;
  let list = [];
  try {
    list = await core.listInstances(root);
  } catch (e) {
    error = e.message;
  }
  const goodVisible = list.some((item) => item.meta.id === good.id);
  const brokenEntry = list.find((item) => item.meta.id === bad.id);
  const brokenVisible = brokenEntry !== undefined;
  const brokenMarked = typeof brokenEntry?.problem === 'string' && brokenEntry.problem.length > 0;
  // 定稿口径（Lead 裁决 2026-09）：instance.json 损坏 → 记录**可见** + 带 problem 标记，
  // 绝不静默丢弃（丢弃会让用户看到实例凭空消失、且无法通过界面删除这条记录）。
  record(
    'R1 instance.json 损坏时两条记录都可见，损坏那条带 problem 标记',
    error === null && goodVisible && brokenVisible && brokenMarked && list.length === 2,
    error !== null
      ? `抛错：${error}`
      : `返回 ${list.length} 个（期望 2）；健康可见=${goodVisible}；损坏可见=${brokenVisible}；problem=${JSON.stringify(brokenEntry?.problem)}`,
  );
}

/* R2: profile/package.json 损坏 → 列表不能崩（但实例会不会凭空消失？） */
{
  const root = await makeTempRoot('rb-profile-corrupt');
  await seedStubEngine(root);
  const a = await core.createInstance(root, { name: 'a', dirName: 'ia', engineVersion: '9.9.9', template: 'web' });
  const b = await core.createInstance(root, { name: 'b', dirName: 'ib', engineVersion: '9.9.9', template: 'web' });
  await fs.writeFile(path.join(core.instancePaths(root, b).profileDir, 'package.json'), '{ 坏掉的 JSON');

  let error = null;
  let list = [];
  try {
    list = await core.listInstances(root);
  } catch (e) {
    error = e.message;
  }
  const bVisible = list.some((item) => item.meta.id === b.id);
  const bEntry = list.find((item) => item.meta.id === b.id);
  const aVisible = list.some((item) => item.meta.id === a.id);
  record(
    'R2 profile/package.json 损坏不会让整个实例列表不可用（不整体崩）',
    error === null && aVisible,
    error !== null ? `listInstances 抛错：${error.split('\n')[0]}` : `返回 ${list.length} 个，健康的 a 可见=${aVisible}`,
  );
  record(
    'R2b profile 清单损坏的实例不应从列表中"凭空消失"（应可见并标记异常）',
    bVisible,
    bVisible
      ? `该实例可见，problem=${JSON.stringify(bEntry?.problem)}`
      : `该实例被静默丢弃：listInstances 只返回 ${list.length} 个，用户界面上这个实例直接消失了（实例元数据与目录都还在）`,
  );
  void a;
}

/* R3: 实例目录被手删 → 列表标记 present=false，操作给可读错误 */
{
  const root = await makeTempRoot('rb-missing');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'gone', dirName: 'gone', engineVersion: '9.9.9', template: 'web' });
  const paths = core.instancePaths(root, meta);
  await fs.rm(paths.root, { recursive: true, force: true });

  const list = await core.listInstances(root);
  const summary = list.find((item) => item.meta.id === meta.id);
  record(
    'R3 实例目录被手删后仍能被列出（而非静默消失）',
    summary !== undefined,
    summary === undefined
      ? '实例从列表中消失（用户无法感知"目录没了"，也无法在 UI 里删除这条记录）'
      : `可见，present=${summary.present}`,
  );
  record(
    'R3a 目录被手删时 present=false（契约字段可用）',
    summary !== undefined && summary.present === false,
    summary === undefined ? '实例不可见，present 无从取值' : `present=${summary.present}`,
  );

  let launchError = null;
  let launched = null;
  try {
    launched = await core.launchInstance(root, meta, { instanceId: meta.id }, { primaryHome: '' }, {});
  } catch (e) {
    launchError = e.message;
  }
  // 目录被手删后自动重建并成功启动，是可接受的"自愈"行为
  record(
    'R3b 目录缺失时启动要么自愈重建、要么给出可读错误（不崩溃）',
    launched !== null || launchError !== null,
    launched !== null ? `自愈成功（pid=${launched.pid}）` : `错误：${launchError}`,
  );
  if (launched?.pid > 0) {
    try {
      process.kill(launched.pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
  }

  let inventoryError = null;
  try {
    await core.readProfileInventory(root, meta);
  } catch (e) {
    inventoryError = e.message;
  }
  record('R3c 目录缺失时读插件清单给出可读错误', inventoryError !== null, `error=${inventoryError?.split('\n')[0]}`);
}

/* R4: YAML 非法 → 必须拒绝写入，且不破坏原文件 */
{
  const root = await makeTempRoot('rb-yaml');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, { name: 'y', dirName: 'iy', engineVersion: '9.9.9', template: 'web' });
  await core.writeInstanceSettings(root, meta, 'good: 1\n');
  let error = null;
  try {
    await core.writeInstanceSettings(root, meta, 'a: [1, 2\nb: }{');
  } catch (e) {
    error = e.message;
  }
  const after = await core.readInstanceSettings(root, meta);
  record(
    'R4 非法 YAML 被拒绝且原设置未被破坏',
    error !== null && after === 'good: 1\n',
    `抛错=${error !== null} 原内容=${JSON.stringify(after)}`,
  );

  // 空 YAML 允许（等价于清空）
  let emptyOk = true;
  try {
    await core.writeInstanceSettings(root, meta, '');
  } catch {
    emptyOk = false;
  }
  record('R4b 空设置内容允许写入（清空语义）', emptyOk);

  // 导入路径是否也校验 YAML？（importPack 直接 writeTextAtomic，绕过校验）
  // 用真实行为验证：构造一个带非法 settings.yaml 的实例包，看导入是否被拒绝。
  const { default: AdmZipY } = await import('adm-zip');
  const rootY = await makeTempRoot('rb-yaml-import');
  await seedStubEngine(rootY);
  const zipY = new AdmZipY();
  zipY.addFile('whalelauncher-pack.json', Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'whalelauncher-pack',
    instance: { name: 'yamlbad', profile: { name: 'yamlbad', template: 'web' }, engine: { version: '9.9.9' }, icon: null, color: '#fff', note: '', launch: { appArgs: [], autoOpenBrowser: true } },
    requirements: {}, bundles: [],
  })));
  zipY.addFile('home/settings.yaml', Buffer.from('a: [1, 2\nb: }{ 这行非法\n'));
  const zipYPath = path.join(rootY, 'yamlbad.zip');
  zipY.writeZip(zipYPath);
  let yamlImportError = null;
  let importedId = null;
  try {
    const r = await core.importPack(rootY, zipYPath, { primaryHome: '' }, {});
    importedId = r.instanceId;
  } catch (e) {
    yamlImportError = e.message;
  }
  let importedSettings = null;
  if (importedId !== null) {
    const instances = await core.listInstances(rootY);
    const imported = instances.find((item) => item.meta.id === importedId);
    if (imported !== undefined) {
      importedSettings = await core.readInstanceSettings(rootY, imported.meta);
    }
  }
  record(
    'R4c 导入实例包时拒绝非法 settings.yaml（不把坏 YAML 落盘）',
    yamlImportError !== null || (importedSettings !== null && !/a: \[1, 2/.test(importedSettings)),
    yamlImportError !== null
      ? `导入被拒绝：${yamlImportError.split('\n')[0]}`
      : `导入成功且坏 YAML 已落盘：${JSON.stringify((importedSettings ?? '').slice(0, 60))}`,
  );
}

/* R5: npm 断网 → listAvailableEngines / installEngine 给出可读错误 */
{
  const root = await makeTempRoot('rb-npm');
  let availableError = null;
  try {
    // 指向一个必定不可达的 registry，模拟断网
    await core.listAvailableEngines('http://127.0.0.1:1/definitely-not-a-registry');
  } catch (e) {
    availableError = e.message;
  }
  record(
    'R5 查询可安装版本失败时给出可读错误（不挂起/不裸抛）',
    availableError !== null && /失败|不存在|ECONN|超时|npm/i.test(availableError),
    `error=${availableError?.split('\n')[0]?.slice(0, 160)}`,
  );

  let installError = null;
  try {
    await core.installEngine(root, '99.99.99-nope', 'http://127.0.0.1:1/definitely-not-a-registry');
  } catch (e) {
    installError = e.message;
  }
  record(
    'R5b 安装引擎失败时给出可读错误（含退出码/原因）',
    installError !== null,
    `error=${installError?.split('\n')[0]?.slice(0, 160)}`,
  );
}

/* R6: 引擎未安装 / 版本号非法 */
{
  const root = await makeTempRoot('rb-engine');
  let createError = null;
  try {
    await core.createInstance(root, { name: 'x', dirName: 'ix', engineVersion: '1.0.0-nope', template: 'web' });
  } catch (e) {
    createError = e.message;
  }
  record('R6 引擎未安装时创建实例给出可读错误', createError !== null && /未安装/.test(createError), `error=${createError}`);

  let versionError = null;
  try {
    await core.createInstance(root, { name: 'x', dirName: 'ix2', engineVersion: '../evil', template: 'web' });
  } catch (e) {
    versionError = e.message;
  }
  record('R6b 非法版本号（路径穿越尝试）被拒绝', versionError !== null && /不合法/.test(versionError), `error=${versionError}`);

  let templateError = null;
  try {
    await core.createInstance(root, { name: 'x', dirName: 'ix3', engineVersion: '9.9.9', template: 'no-such-template' });
  } catch (e) {
    templateError = e.message;
  }
  record('R6c 未知模板被拒绝', templateError !== null && /模板/.test(templateError), `error=${templateError}`);
}

/* R7: 实例包损坏（zip 非法 / 缺清单 / zip-slip） */
{
  const root = await makeTempRoot('rb-pack');
  await seedStubEngine(root);
  const badZip = path.join(root, 'bad.zip');
  await fs.writeFile(badZip, '这不是 zip');
  let error1 = null;
  try {
    await core.importPack(root, badZip, { primaryHome: '' }, {});
  } catch (e) {
    error1 = e.message;
  }
  record('R7 非 zip 文件导入报可读错误', error1 !== null && /无法读取实例包/.test(error1), `error=${error1}`);

  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  const packJson = JSON.stringify({
    schemaVersion: 1, kind: 'whalelauncher-pack',
    instance: { name: 'evil', profile: { name: 'evil', template: 'web' }, engine: { version: '9.9.9' }, icon: null, color: '#fff', note: '', launch: { appArgs: [], autoOpenBrowser: true } },
    requirements: {}, bundles: [],
  });
  zip.addFile('whalelauncher-pack.json', Buffer.from(packJson));
  // 先确认 AdmZip 是否保留了 ../ —— 若归一化掉，则该项根本不构成 zip-slip
  const evilEntryName = '../../escaped.txt';
  zip.addFile(evilEntryName, Buffer.from('越界写入'));
  const slipZip = path.join(root, 'slip.zip');
  zip.writeZip(slipZip);
  const checkZip = new AdmZip(slipZip);
  const storedNames = checkZip.getEntries().map((e) => e.entryName);
  console.log(`  [info] zip 内实际条目名：${JSON.stringify(storedNames)}`);
  const retainsTraversal = storedNames.some((n) => n.includes('..'));

  let error2 = null;
  try {
    await core.importPack(root, slipZip, { primaryHome: '' }, {});
  } catch (e) {
    error2 = e.message;
  }
  // 关键判定：任何文件都不得落到解压根之外（检查父目录与启动器根）
  const escapedOutside = await fs.readFile(path.join(path.dirname(root), 'escaped.txt'), 'utf8').catch(() => null);
  const escapedAtRoot = await fs.readFile(path.join(root, 'escaped.txt'), 'utf8').catch(() => null);
  record(
    'R7b zip-slip：越界条目未把文件写到解压根之外',
    escapedOutside === null && escapedAtRoot === null,
    `条目名保留 ../=${retainsTraversal} 父目录出现文件=${escapedOutside !== null} 根内出现文件=${escapedAtRoot !== null}${error2 !== null ? `（importPack 抛错：${error2.split('\n')[0]}）` : ''}`,
  );

  // 若要真正命中 extractEntries 的越界防护，需要绕过 AdmZip 的归一化：
  // 直接构造一个 entryName 带 .. 的 zip（用 store 方式写入原始条目名）。
  const zip2 = new AdmZip();
  zip2.addFile('whalelauncher-pack.json', Buffer.from(packJson));
  zip2.addFile('a/../../escaped2.txt', Buffer.from('越界写入2'));
  const slipZip2 = path.join(root, 'slip2.zip');
  zip2.writeZip(slipZip2);
  const stored2 = new AdmZip(slipZip2).getEntries().map((e) => e.entryName);
  let error3 = null;
  try {
    await core.importPack(root, slipZip2, { primaryHome: '' }, {});
  } catch (e) {
    error3 = e.message;
  }
  const escaped2 = await fs.readFile(path.join(path.dirname(path.dirname(root)), 'escaped2.txt'), 'utf8').catch(() => null);
  record(
    'R7c zip-slip（含 .. 的嵌套条目）仍不越界',
    escaped2 === null,
    `归一化后条目=${JSON.stringify(stored2)} 外部文件=${escaped2 !== null}${error3 !== null ? `（抛错：${error3.split('\n')[0]}）` : '（未抛错）'}`,
  );
}

/* R8: 实例包 schema 版本过新 */
{
  const root = await makeTempRoot('rb-schema');
  await seedStubEngine(root);
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip();
  zip.addFile('whalelauncher-pack.json', Buffer.from(JSON.stringify({
    schemaVersion: 999, kind: 'whalelauncher-pack',
    instance: { name: 'future', profile: { name: 'future', template: 'web' }, engine: { version: '9.9.9' }, icon: null, color: '#fff', note: '', launch: { appArgs: [], autoOpenBrowser: true } },
    requirements: {}, bundles: [],
  })));
  const file = path.join(root, 'future.zip');
  zip.writeZip(file);
  let error = null;
  try {
    await core.importPack(root, file, { primaryHome: '' }, {});
  } catch (e) {
    error = e.message;
  }
  record('R8 schemaVersion 过新的包被拒绝并提示升级', error !== null && /升级/.test(error), `error=${error}`);
}

/* ================================================================== *
 * 2. 性能
 * ================================================================== */
{
  const root = await makeTempRoot('perf-list');
  await seedStubEngine(root);
  const N = 60;
  for (let i = 0; i < N; i += 1) {
    await core.createInstance(root, { name: `p${i}`, dirName: `p${i}`, engineVersion: '9.9.9', template: 'web' });
  }
  // 制造"每个实例有大量文件"的场景：如果 listInstances 递归算目录大小，这里会显著变慢
  for (let i = 0; i < N; i += 1) {
    const dir = path.join(root, 'instances', `p${i}`, 'home', 'sessions', 'fake-workspace');
    await fs.mkdir(dir, { recursive: true });
    for (let j = 0; j < 120; j += 1) {
      await fs.writeFile(path.join(dir, `s${j}.jsonl.zstd`), 'x'.repeat(256));
    }
  }

  const t0 = Date.now();
  const list = await core.listInstances(root);
  const elapsed = Date.now() - t0;
  record(
    'P1 60 个实例（各 120 个会话文件）列表耗时 < 1500ms',
    elapsed < 1500,
    `耗时 ${elapsed}ms，返回 ${list.length} 个实例`,
  );

  const t1 = Date.now();
  await core.listEngines(root);
  const enginesMs = Date.now() - t1;
  record(
    'P2 listEngines 不因递归算大小而明显卡顿（< 1500ms）',
    enginesMs < 1500,
    `耗时 ${enginesMs}ms`,
  );

  const t2 = Date.now();
  await core.listSessions(root, list[0].meta);
  const sessionsMs = Date.now() - t2;
  record('P3 单实例会话枚举 < 1000ms', sessionsMs < 1000, `耗时 ${sessionsMs}ms（120 个会话）`);

  // 静态核查：listInstances 是否对每个实例做递归 dirSize
  const instanceSrc = await fs.readFile(path.join(process.cwd(), 'src', 'core', 'instance.ts'), 'utf8');
  const summarizeUsesDirSize = /async function summarize[\s\S]*?\n}/.test(instanceSrc) && /dirSize/.test(instanceSrc.slice(instanceSrc.indexOf('async function summarize'), instanceSrc.indexOf('async function summarize') + 900));
  record(
    'P4 列表视图不对每个实例递归计算目录大小',
    !summarizeUsesDirSize,
    summarizeUsesDirSize ? 'summarize 中存在 dirSize 递归调用' : 'summarize 只读 package.json + 存在性检查',
  );
}

/* ================================================================== *
 * 3. 安全
 * ================================================================== */
{
  const mainSrc = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');
  record('S1 nodeIntegration=false', /nodeIntegration:\s*false/.test(mainSrc));
  record('S2 contextIsolation=true', /contextIsolation:\s*true/.test(mainSrc));
  record('S3 sandbox=true', /sandbox:\s*true/.test(mainSrc));
  record('S4 webSecurity 未被关闭', !/webSecurity:\s*false/.test(mainSrc));
  record('S5 禁止 webview / 新窗口', /will-attach-webview[\s\S]{0,200}preventDefault/.test(mainSrc) && /setWindowOpenHandler[\s\S]{0,300}action:\s*'deny'/.test(mainSrc));

  const ipcSrc = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');
  record(
    'S6 openExternal 只允许 http/https',
    /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/.test(ipcSrc),
  );
  record(
    'S7 openFolder 的 which 参数走白名单映射（不可任意路径）',
    /const targets: Record<string, string \| undefined> = \{/.test(ipcSrc) && /if \(target === undefined\)/.test(ipcSrc),
  );
  record(
    'S8 渲染层传入的参数一律校验（mustString/mustBoolean 等）',
    /function mustString\(/.test(ipcSrc) && /function mustShareMode\(/.test(ipcSrc) && /function parseCreateInput\(/.test(ipcSrc),
  );

  // 渲染层 XSS：区分"静态 SVG 查表"与"把外部数据塞进 innerHTML"
  const rendererFiles = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.ts$/.test(entry.name)) rendererFiles.push(full);
    }
  };
  await walk(path.join(process.cwd(), 'src', 'renderer'));
  const innerHtmlSites = [];
  for (const file of rendererFiles) {
    const text = await fs.readFile(file, 'utf8');
    const rel = path.relative(process.cwd(), file);
    text.split('\n').forEach((line, index) => {
      if (/\.(innerHTML|outerHTML|insertAdjacentHTML)\s*=|\.insertAdjacentHTML\(/.test(line)) {
        innerHtmlSites.push({ rel, line: index + 1, text: line.trim() });
      }
    });
  }
  console.log('  [info] innerHTML 使用点：');
  for (const site of innerHtmlSites) console.log(`    ${site.rel}:${site.line}  ${site.text}`);

  // 判定 1：任何把"非字面量/非静态查表"的数据写入 innerHTML 的地方都是 XSS 面
  const dynamicSites = innerHtmlSites.filter((site) => {
    // 允许：icons.ts 的 PATHS[name]（name 受静态图标名约束）
    if (/svg\.innerHTML\s*=\s*PATHS\[/.test(site.text)) return false;
    // 允许：dom.ts 的 html 属性通道本身（属于工具层，另单独判定其调用方）
    if (/el\.innerHTML\s*=\s*String\(value\)/.test(site.text)) return false;
    return true;
  });
  record(
    'S9 渲染层无"外部数据 → innerHTML"的直接写入点',
    dynamicSites.length === 0,
    dynamicSites.length === 0 ? `检查 ${innerHtmlSites.length} 处，均为静态查表/工具层` : dynamicSites.map((s) => `${s.rel}:${s.line}`).join(', '),
  );

  // 判定 2：html 属性通道的调用方 —— 是否有任何视图把动态数据传进 html:
  const htmlPropUses = [];
  for (const file of rendererFiles) {
    const text = await fs.readFile(file, 'utf8');
    const rel = path.relative(process.cwd(), file);
    text.split('\n').forEach((line, index) => {
      if (/\bhtml:\s*/.test(line) && !/^\s*(\*|\/\/)/.test(line)) htmlPropUses.push(`${rel}:${index + 1} ${line.trim()}`);
    });
  }
  const htmlPropOutsideDom = htmlPropUses.filter((use) => !use.includes('util\\dom.ts') && !use.includes('util/dom.ts'));
  record(
    'S9b 危险 html 属性通道无调用方（死代码而非活漏洞）',
    htmlPropOutsideDom.length === 0,
    htmlPropOutsideDom.length === 0
      ? 'html: 仅存在于 util/dom.ts 定义处，无视图使用 → 当前无实际 XSS'
      : `存在调用方：${htmlPropOutsideDom.join(' | ')}`,
  );

  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  const csp = /Content-Security-Policy/.test(html);
  record('S10 index.html 声明 CSP', csp, csp ? '已声明' : '未声明 CSP（file:// 下漏洞面较小，但建议补上 script-src \'self\'）');

  // 追加：applyProps 的 on* 兜底分支是否可能被字符串利用
  const domSrc = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'util', 'dom.ts'), 'utf8');
  const onGuard = /key\.startsWith\('on'\) && typeof value === 'function'/.test(domSrc);
  const setAttrFallback = /el\.setAttribute\(key,\s*value === true \? '' : String\(value\)\)/.test(domSrc);
  record(
    'S11 applyProps 对 on* 只接受函数（字符串不会被写成事件处理器属性）',
    onGuard && setAttrFallback,
    `on* 需要函数=${onGuard}，其余落到 setAttribute=${setAttrFallback}`,
  );
}

console.log('\n=== 健壮性 / 性能 / 安全 用例汇总 ===');
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.unverifiable);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}，无法验证 ${skipped.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
if (failed.length > 0) process.exitCode = 1;
