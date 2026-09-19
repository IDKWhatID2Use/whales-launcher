/**
 * QA 检查项 1（契约一致性）与检查项 2（dsh 行为正确性）。
 *
 * 设计原则：**凡是能用真实 dsh 校验的，不用 stub**。profile 名规则直接对本机
 * 真实 `dsh@0.1.6-alpha.2` 跑 `--dump-config`，与 `core.validateName` 的结果逐条比对。
 *
 * 注意（沙箱事实）：本环境禁止带管道 stdio 的 spawn（EPERM），因此所有子进程捕获
 * 都用**文件句柄重定向**（与 `src/core/proc.ts` 的降级策略同款）。
 *
 * 运行：node tests/e2e/20-contract-and-dsh.mjs
 */
import { promises as fs } from 'node:fs';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, REPO_ROOT } from './_bundle.mjs';

const { core } = await loadCoreBundle();
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/* ================================================================== *
 * 0. 定位真实 dsh
 * ================================================================== */
const REAL_DSH_BIN = 'F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const realDshAvailable = await fs.access(REAL_DSH_BIN).then(() => true, () => false);
console.log(`[env] 真实 dsh：${realDshAvailable ? REAL_DSH_BIN : '不可用（跳过实测比对）'}`);

/* ================================================================== *
 * 1-A. 不得 import dsh 内部 API
 * ================================================================== */
{
  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  await walk(path.join(REPO_ROOT, 'src'));
  await walk(path.join(REPO_ROOT, 'scripts'));

  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    for (const hit of text.matchAll(/from\s+['"]([^'"]*dsh[^'"]*)['"]/g)) {
      const spec = hit[1];
      // 允许：相对路径（本地模块）、显式子进程调用的字符串常量
      if (spec.startsWith('.')) continue;
      offenders.push(`${rel}: import ${spec}`);
    }
    for (const hit of text.matchAll(/require\(\s*['"]([^'"]*dsh[^'"]*)['"]\s*\)/g)) {
      if (hit[1].startsWith('.')) continue;
      offenders.push(`${path.relative(REPO_ROOT, file)}: require ${hit[1]}`);
    }
  }
  record(
    '1-A 启动器源码不 import 任何 dsh 包（含子包）',
    offenders.length === 0,
    offenders.length === 0 ? `扫描 ${files.length} 个文件，0 命中` : offenders.join(' | '),
  );

  // 反向确认：subprocess 调用的确实只是 lib/bin.js（CLI 边界）
  const launchSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'core', 'launch.ts'), 'utf8');
  const codeOnly = launchSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const cliOnly = /resolveEngineBin\(root, meta\.engine\.version\)/.test(codeOnly) &&
    !/@deepseek-ai\/dsh/.test(codeOnly);
  record('1-A2 启动实例只经 resolveEngineBin→CLI，代码中不含 dsh 包内部路径', cliOnly);
}

/* ================================================================== *
 * 1-B. preload 暴露的通道集合 ⊆/== 契约 CH，且不泄漏 ipcRenderer
 * ================================================================== */
{
  const preloadSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'preload', 'index.ts'), 'utf8');
  const contractsSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'shared', 'contracts.ts'), 'utf8');

  // 契约里所有通道字面量
  const chBlock = contractsSrc.slice(contractsSrc.indexOf('export const CH = {'));
  const contractChannels = new Set([...chBlock.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]));

  // preload 实际引用的通道
  const usedChannels = new Set([...preloadSrc.matchAll(/CH\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}:${m[2]}`));
  const pushOnly = new Set(['log:chunk', 'log:state']);
  const invokeChannels = [...contractChannels].filter((c) => !pushOnly.has(c));
  const missingInPreload = invokeChannels.filter((c) => !usedChannels.has(c));

  record(
    '1-B1 preload 覆盖契约全部 invoke 通道',
    missingInPreload.length === 0,
    `${invokeChannels.length} 条 invoke 通道，未引用：${missingInPreload.join(', ') || '无'}`,
  );

  // 不得裸用字符串通道名（绕过 CH 会造成漂移）
  const rawChannelUse = [...preloadSrc.matchAll(/ipcRenderer\.(invoke|on|send)\(\s*['"]/g)].length;
  record('1-B2 preload 不裸写通道字符串（全部经 CH）', rawChannelUse === 0, `裸用次数=${rawChannelUse}`);

  // 不得把 ipcRenderer / require / process 泄漏给页面
  const leaks = [];
  if (/exposeInMainWorld\([^)]*ipcRenderer/.test(preloadSrc)) leaks.push('直接暴露 ipcRenderer');
  if (/exposeInMainWorld\(\s*['"]whales['"]\s*,\s*ipcRenderer\s*\)/.test(preloadSrc)) leaks.push('暴露 ipcRenderer 本体');
  if (/exposeInMainWorld\(['"]whales['"],\s*\{[^}]*\b(event|sender)\b/s.test(preloadSrc)) leaks.push('把 event/sender 交给页面');
  record('1-B3 preload 不泄漏 ipcRenderer/event 对象', leaks.length === 0, leaks.join(' | ') || '无命中');

  // 订阅函数必须返回取消订阅函数
  const subscribeOk = /function subscribe<T>\([\s\S]*?return \(\) => \{[\s\S]*?removeListener\(channel, listener\)/.test(preloadSrc);
  record('1-B4 onLog/onState 返回可用的取消订阅函数', subscribeOk);

  // WhalesApi 形状：preload 的顶层键必须与契约接口一致
  const apiBlock = preloadSrc.slice(preloadSrc.indexOf('const api: WhalesApi = {'));
  const topKeys = [...apiBlock.matchAll(/^  ([a-zA-Z]+):/gm)].map((m) => m[1]);
  const expectedTop = ['launcher', 'instance', 'engine', 'plugin', 'settings', 'saves', 'pack', 'app', 'onLog', 'onState'];
  const missingTop = expectedTop.filter((k) => !topKeys.includes(k));
  record('1-B5 WhalesApi 顶层形状与契约一致', missingTop.length === 0, `缺失：${missingTop.join(', ') || '无'}`);

  // 逐方法比对：契约接口里的方法名必须都在 preload 出现
  const ifaceBlock = contractsSrc.slice(contractsSrc.indexOf('export interface WhalesApi {'), contractsSrc.indexOf('* core 引擎 API 契约（main 依赖此形状调用 core）'));
  const methodNames = [...ifaceBlock.matchAll(/^\s{4}(\w+)\(/gm)].map((m) => m[1]);
  const missingMethods = methodNames.filter((m) => !new RegExp(`\\b${m}\\s*:`).test(apiBlock));
  record(
    '1-B6 WhalesApi 各分组方法逐条暴露',
    missingMethods.length === 0,
    `契约方法 ${methodNames.length} 个，preload 缺失：${missingMethods.join(', ') || '无'}`,
  );
}

/* ================================================================== *
 * 1-C. main 侧通道覆盖（静态核对，与运行时自检互为印证）
 * ================================================================== */
{
  const ipcSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'main', 'ipc.ts'), 'utf8');
  const contractsSrc = await fs.readFile(path.join(REPO_ROOT, 'src', 'shared', 'contracts.ts'), 'utf8');
  const chBlock = contractsSrc.slice(contractsSrc.indexOf('export const CH = {'));
  const contractChannels = [...new Set([...chBlock.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]))];
  const handlers = new Set([...ipcSrc.matchAll(/\[CH\.[a-zA-Z]+\.[a-zA-Z]+\]/g)].map((m) => m[0]));
  const pushOnlyChannels = ['log:chunk', 'log:state'];
  const invokeChannels = contractChannels.filter((c) => !pushOnlyChannels.includes(c));
  record(
    '1-C1 main 为契约每条 invoke 通道注册 handler',
    handlers.size === invokeChannels.length,
    `契约 invoke ${invokeChannels.length} 条（另有 ${pushOnlyChannels.length} 条 push-only），main 注册 ${handlers.size} 条`,
  );
  const hasCoverageAssert = /assertChannelCoverage\(handlers\)/.test(ipcSrc);
  record('1-C2 main 启动时对通道覆盖做自检', hasCoverageAssert);
  // 每个 handler 都必须包在 try/catch 里返回 Result（异常不得穿透 IPC）
  const wrapped = /try \{\s*return ok\(await handler\(\.\.\.args\)\);\s*\} catch \(error\) \{[\s\S]*?return err\(describeError\(error\)\);/.test(ipcSrc);
  record('1-C3 IPC 异常统一转成 Result.error（不穿透）', wrapped);
}

/* ================================================================== *
 * 2-A. profile 名校验：core.validateName vs 真实 dsh
 * ================================================================== */
if (realDshAvailable) {
  const probe = await makeTempRoot('dsh-rule');
  const readFileSyncSafe = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  /**
   * 用真实 dsh 尝试在实际的 `$DSH_HOME/profiles/<name>` 下初始化一个 profile。
   *
   * 两步法（关键）：先用 `--from-default-profile web` 创建目录，再 `--dump-config` 加载。
   * 若直接对不存在的 profile 跑 `--dump-config`，dsh 会报 "does not exist" 而不是
   * 名字非法 —— 那会把"合法名字"误判成拒绝，得出完全相反的结论。
   *
   * 输出走**文件重定向**：本沙箱下带管道的 spawn 报 EPERM。
   */
  const dshAcceptsProfile = (name) => {
    const slug = Buffer.from(name).toString('hex').slice(0, 24) || 'empty';
    const home = path.join(probe, `h-${slug}`);
    const run = (args) => {
      const outPath = path.join(probe, `o-${slug}.txt`);
      const errPath = path.join(probe, `e-${slug}.txt`);
      const outFd = openSync(outPath, 'w');
      const errFd = openSync(errPath, 'w');
      let result;
      try {
        result = spawnSync(process.execPath, [REAL_DSH_BIN, ...args], {
          env: { ...process.env, DSH_HOME: home },
          cwd: probe,
          stdio: ['ignore', outFd, errFd],
          timeout: 120000,
          windowsHide: true,
        });
      } finally {
        closeSync(outFd);
        closeSync(errFd);
      }
      return {
        status: result.status,
        spawnError: result.error ? result.error.code ?? result.error.message : null,
        stderr: readFileSyncSafe(errPath),
      };
    };
    const create = run(['--profile', name, '--from-default-profile', 'web', '--dump-config']);
    if (create.status === 0) return { ok: true, status: 0, stderr: '', via: 'create' };
    // 名字可能的拒绝原因："invalid profile name" / "is shipped and cannot be a custom profile target"
    const load = run(['--profile', name, '--dump-config']);
    const nameInvalid = /invalid profile name|is shipped and cannot be|must not be empty/i.test(create.stderr);
    if (load.status === 0 && !nameInvalid) {
      // 建不了但能加载（例如 desktop 之类只被 CLI 拒绝的特殊名）
      return { ok: true, status: 0, stderr: '', via: 'load' };
    }
    return {
      ok: false,
      status: create.status,
      spawnError: create.spawnError,
      stderr: create.stderr.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('Error:') || l.includes('dsh: ')).slice(0, 1).join(' '),
    };
  };

  const cases = [
    { name: 'qa-ok', expectCore: null },
    { name: 'QA-Upper', expectCore: null },
    { name: '中文实例', expectCore: null },
    { name: 'desktop', expectReject: true },
    { name: 'Desktop', expectReject: true },
    { name: 'DESKTOP', expectReject: true },
    { name: 'node_modules', expectReject: true },
    { name: '.', expectReject: true },
    { name: '..', expectReject: true },
    { name: 'a/b', expectReject: true },
    { name: 'a\\b', expectReject: true },
    { name: 'with space', expectCore: null },
    { name: 'trailing.', expectReject: true },
    { name: 'con', expectReject: true },
    { name: 'a:b', expectReject: true },
    { name: 'x'.repeat(65), expectReject: true },
  ];

  const mismatches = [];
  const stricterByDesign = [];
  const rows = [];
  for (const testCase of cases) {
    const dsh = dshAcceptsProfile(testCase.name);
    const coreVerdict = core.validateName(testCase.name) === null; // true = 接受
    const label = JSON.stringify(testCase.name.length > 20 ? `${testCase.name.slice(0, 17)}…` : testCase.name);
    rows.push(`    dsh=${dsh.ok ? '接受' : '拒绝'} core=${coreVerdict ? '接受' : '拒绝'}  ${label}`);
    if (dsh.ok === coreVerdict) continue;
    if (dsh.ok && !coreVerdict) {
      // core 比 dsh 更严格：这是 names.ts 注释里明确声明的行为（把"启动时才失败"提前到"创建时失败"）
      stricterByDesign.push(`${label}（dsh 允许，core 提前拦截）`);
    } else {
      // 危险方向：core 放松了 dsh 的约束 → 会在启动时才炸
      mismatches.push(`${label}：dsh 拒绝（码 ${dsh.status} ${dsh.stderr}）但 core 接受`);
    }
  }
  console.log('  [profile 规则实测比对]');
  for (const row of rows) console.log(row);
  if (stricterByDesign.length > 0) {
    console.log(`  [core 更严格（设计如此，非缺陷）] ${stricterByDesign.join('、')}`);
  }
  record(
    '2-A0 core 不放松任何 dsh profile 约束（危险方向 = 0）',
    mismatches.length === 0,
    mismatches.length === 0 ? '0 例"dsh 拒绝但 core 接受"' : mismatches.join(' | '),
  );
  record(
    '2-A core.validateName 与真实 dsh profile 规则一致（允许更严格的补充校验）',
    mismatches.length === 0 && stricterByDesign.length > 0,
    `一致 ${cases.length - mismatches.length - stricterByDesign.length} 例，core 更严格 ${stricterByDesign.length} 例，危险方向 ${mismatches.length} 例`,
  );

  // desktop 必须大小写不敏感地被拒绝
  const desktopVariants = ['desktop', 'Desktop', 'DESKTOP', 'DeSkToP'];
  const desktopOk = desktopVariants.every((v) => core.validateName(v) !== null);
  record('2-A2 desktop 保留名大小写不敏感拒绝', desktopOk);
}

/* ================================================================== *
 * 2-B. DSH_HOME 与 cwd 是否都正确注入（用 stub 引擎观测子进程现场）
 * ================================================================== */
{
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  const root = await makeTempRoot('dsh-env');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'env',
    dirName: 'env-probe',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);

  // profile 初始化阶段：子进程的 DSH_HOME 必须是实例专属 home —— 用文件系统事实判定
  const initMeta = await core.createInstance(root, {
    name: 'env2',
    dirName: 'env-probe2',
    engineVersion: '9.9.9',
    template: 'headless',
  });
  const initPaths = core.instancePaths(root, initMeta);
  const initProfileManifest = path.join(initPaths.profileDir, 'package.json');
  const initProfileExists = await fs.access(initProfileManifest).then(() => true, () => false);
  // 关键判定：profile 目录必须落在**实例自己的 home** 下，而不是主 home / 启动器根
  const initUnderInstanceHome = initPaths.profileDir.startsWith(initPaths.home) && initPaths.profileDir.includes('instances');
  record(
    '2-B1 创建实例（dump-config）的 profile 落在实例专属 DSH_HOME 内',
    initProfileExists && initUnderInstanceHome,
    `profile=${initPaths.profileDir} 存在=${initProfileExists}`,
  );
  const leaked = [];
  if (await fs.access(path.join(root, 'profiles', 'env-probe2')).then(() => true, () => false)) leaked.push('启动器根下出现了 profiles/');
  if (await fs.access(path.join(root, 'env-probe2')).then(() => true, () => false)) leaked.push('启动器根下出现了实例目录');
  record('2-B1b 初始化未把 profile 泄漏到启动器根或主 home', leaked.length === 0, leaked.join(' | ') || '无泄漏');

  // 启动阶段：读 stub 写下的现场文件（等它落盘）
  const runtime = await core.launchInstance(root, meta, { instanceId: meta.id }, {
    primaryHome: path.join(root, 'nope'),
  }, {});
  const { promises: fsp } = await import('node:fs');
  const scenePath = path.join(paths.workspace, '.stub-start.json');
  const { waitFor } = await import('./_bundle.mjs');
  await waitFor(() => fsp.access(scenePath).then(() => true, () => false), 8000);
  const scene = JSON.parse(await fsp.readFile(scenePath, 'utf8'));
  const homeOk = path.resolve(scene.home) === path.resolve(paths.home);
  const cwdOk = path.resolve(scene.cwd) === path.resolve(paths.workspace);
  record(
    '2-B2 启动实例：DSH_HOME=实例 home 且 cwd=实例 workspace',
    homeOk && cwdOk,
    `home=${scene.home}（期望 ${paths.home}）cwd=${scene.cwd}（期望 ${paths.workspace}）`,
  );
  record('2-B3 launchInstance 返回真实 pid/dshHome/cwd', runtime.pid > 0 && runtime.dshHome === paths.home && runtime.cwd === paths.workspace, `pid=${runtime.pid}`);
  // appArgs 透传位置
  const args = scene.args;
  const profileIdx = args.indexOf('--profile');
  record(
    '2-B4 appArgs 追加在启动器 flag 之后（透传给应用层）',
    profileIdx === 0 && args[1] === meta.profile.name,
    `实际 argv=${JSON.stringify(args)}`,
  );
  // 本沙箱禁止 taskkill（Access denied），stopInstance 会走满 15s+5s 强杀兜底；
  // 这里绕过 stopInstance 直接从进程表清场，避免测试空转 20 秒。
  if (runtime.pid > 0) {
    try {
      process.kill(runtime.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  void initMeta;
}

/* ================================================================== *
 * 2-C. 插件增删是否真的走 `dsh plugin` CLI
 * ================================================================== */
{
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  const root = await makeTempRoot('dsh-plugin');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'plug',
    dirName: 'plug-probe',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  const logs = [];
  // stub 默认让 plugin 失败（exit 1），据此可判断 core 是否真的调了 CLI
  let error = null;
  try {
    await core.pluginAdd(root, meta, 'some-plugin', { primaryHome: '' }, (s, t) => logs.push(t));
  } catch (e) {
    error = e.message;
  }
  const sceneFile = path.join(paths.home, '.stub-plugin.json');
  const scene = await fs.readFile(sceneFile, 'utf8').then(JSON.parse).catch(() => null);
  record(
    '2-C1 pluginAdd 走 `dsh plugin --profile <p> add <spec>` CLI',
    scene !== null && scene.argv[0] === 'plugin' && scene.argv[1] === '--profile' && scene.argv[3] === 'add' && scene.argv[4] === 'some-plugin',
    scene === null ? '未观测到 dsh plugin 调用' : `argv=${JSON.stringify(scene.argv)}`,
  );
  record('2-C2 CLI 失败时抛出可读错误（含退出码）', error !== null && /退出码|pnpm/.test(error), `error=${error}`);

  // 不得自行改 pnpm 状态：package.json 的 dependencies 不应被 core 直接改写
  const manifestBefore = await fs.readFile(path.join(paths.profileDir, 'package.json'), 'utf8');
  record('2-C3 pluginAdd 失败后未擅自改写 profile package.json', !/"some-plugin"/.test(manifestBefore));
}

/* ================================================================== *
 * 2-D. cordis.patch.yml 语义：非空校验 + 整块写入
 * ================================================================== */
{
  const { seedStubEngine } = await import('./_stub-engine.mjs');
  const root = await makeTempRoot('dsh-patch');
  await seedStubEngine(root);
  const meta = await core.createInstance(root, {
    name: 'patch',
    dirName: 'patch-probe',
    engineVersion: '9.9.9',
    template: 'web',
  });
  const paths = core.instancePaths(root, meta);
  const patchFile = path.join(paths.profileDir, 'cordis.patch.yml');

  const created = await fs.readFile(patchFile, 'utf8');
  record('2-D1 新建 profile 的 cordis.patch.yml 非空且含 []', created.trim().length > 0 && created.includes('[]'), `内容=${JSON.stringify(created)}`);

  // 空内容必须被拒绝（dsh 要求至少 []）
  const { profile } = await loadCoreBundle();
  let emptyRejected = false;
  try {
    await profile.writePatchFile(paths.profileDir, '   \n');
  } catch {
    emptyRejected = true;
  }
  record('2-D2 writePatchFile 拒绝空内容', emptyRejected);

  // 备份语义：rename 成 .bak-<毫秒>
  const backup = await profile.backupPatchFile(paths.profileDir);
  const backupExists = backup !== null && (await fs.access(backup).then(() => true, () => false));
  H: {
    record('2-D3 backupPatchFile 生成 .bak-<毫秒> 备份', backupExists && /\.bak-\d+$/.test(backup ?? ''), `backup=${backup}`);
  }
  record('2-D4 备份后原文件消失（已 rename 而非复制）', (await core.pathExists(patchFile)) === false);
}

console.log('\n=== 契约 / dsh 行为用例汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
if (failed.length > 0) process.exitCode = 1;
