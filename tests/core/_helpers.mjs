/**
 * tests/core 公共测试助手（自带微型测试运行器）
 *
 * ### 为什么不用 `node:test`
 * 本机受管沙箱禁止创建命名管道，而 `node --test` 默认会为**每个测试文件 spawn 一个
 * 子进程并接管它的 stdio 管道**，直接 `spawn EPERM`。因此这里自带一个极简运行器：
 *  - 每个测试文件顶层 `import { test, run }`，用 `test(name, fn)` 注册，
 *    文件末尾 `await run()` 执行；
 *  - 直接用 `node tests/core/xxx.test.mjs` 跑，打印 `PASS/FAIL/SKIP` 行，
 *    失败时退出码为 1（`npm test` 的 runner 无论怎么改都能接住）。
 *
 * ### TypeScript 解析钩子
 * Node 26 原生支持 TS 类型擦除，但要求 import 说明符带显式 `.ts` 扩展名；而项目
 * tsconfig 用 `moduleResolution: Bundler` 且未开 `allowImportingTsExtensions`，
 * 源码里不能写 `.ts`。两边都要成立，所以注册解析钩子自动补 `.ts`。
 *
 * ### 假 dsh
 * `seedStubEngine` 生成一个行为对齐真实 dsh 关键约定的"假 dsh"
 * （`--dump-config` 初始化 profile、长驻模式打印界面地址），使创建/启动/导入导出
 * 都能在没有真 dsh、不联网的环境下被自动化验证。
 */
import { registerHooks } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** core 入口的 file URL（供动态 import）。 */
export const CORE_ENTRY_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'index.ts')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL ?? '';
      if (parent.endsWith('.ts') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // 继续尝试下一个候选
          }
        }
      }
      throw error;
    }
  },
});

/* ------------------------------------------------------------------ *
 * 微型测试运行器
 * ------------------------------------------------------------------ */

/** 已注册的用例。 */
const registry = [];

/** 测试上下文（只实现本项目用到的能力）。 */
class TestContext {
  /** 收尾回调（逆序执行）。 */
  afters = [];
  /** 跳过原因（由 `t.skip()` 设置）。 */
  skipReason = undefined;

  /** 注册收尾回调（即使用例失败也会执行）。 */
  after(fn) {
    this.afters.push(fn);
  }

  /** 标记本用例跳过（典型用法：在用例开头调用后 `return`）。 */
  skip(reason = '跳过') {
    this.skipReason = reason;
  }
}

/**
 * 注册一个用例。
 * @param {string} name 用例名。
 * @param {(t: TestContext) => Promise<void>|void} fn 用例体。
 */
export function test(name, fn) {
  registry.push({ name, fn });
}

/**
 * 直接标记跳过的用例（用于整文件条件跳过）。
 * @param {string} name 用例名。
 * @param {string} reason 原因。
 */
export function skip(name, reason) {
  registry.push({ name, fn: () => undefined, skip: reason });
}

/** 打印一行结果。 */
function line(text) {
  process.stdout.write(`${text}\n`);
}

/** 是否已调用过 {@link run}（用于兜住"忘了 run() → 整个文件假绿"这类失误）。 */
let hasRun = false;

/*
 * 假绿护栏：任何 import 了本帮助文件、却没有调用 `run()` 的测试文件，在退出时判为失败。
 * 否则 `node --test` 只会看到一个"0 断言、全通过"的文件 —— 比没有测试更危险。
 * （同源教训：ui-engineer 的 `check(name, predicate)` 把函数当布尔值，导致 12 条断言恒真。）
 */
process.on('exit', () => {
  if (hasRun) return;
  process.exitCode = 1;
  process.stderr.write(
    `[_helpers] ${path.relative(REPO_ROOT, process.argv[1] ?? '')} 未调用 run()：用例未执行，判定为失败（避免假绿）\n`,
  );
});

/**
 * 执行所有已注册用例。
 * @returns {Promise<{passed:number, failed:number, skipped:number}>} 统计。
 */
export async function run() {
  hasRun = true;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const started = Date.now();
  line(`\n=== ${path.relative(REPO_ROOT, process.argv[1] ?? '')} ===`);
  for (const item of registry) {
    if (item.skip !== undefined) {
      skipped += 1;
      line(`SKIP ${item.name} —— ${item.skip}`);
      continue;
    }
    const context = new TestContext();
    try {
      await item.fn(context);
      if (context.skipReason !== undefined) {
        skipped += 1;
        line(`SKIP ${item.name} —— ${context.skipReason}`);
      } else {
        passed += 1;
        line(`PASS ${item.name}`);
      }
    } catch (error) {
      failed += 1;
      line(`FAIL ${item.name}`);
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      line(
        detail
          .split('\n')
          .map((row) => `     ${row}`)
          .join('\n'),
      );
    } finally {
      for (const after of context.afters.reverse()) {
        try {
          await after();
        } catch (error) {
          line(`     [after] 清理失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  line(`--- ${passed} passed, ${failed} failed, ${skipped} skipped（${seconds}s）`);
  if (failed > 0) process.exitCode = 1;
  return { passed, failed, skipped };
}

/* ------------------------------------------------------------------ *
 * 环境与夹具
 * ------------------------------------------------------------------ */

/** 加载 core 模块（含 `core` 单例与附加导出）。 */
export async function loadCoreModule() {
  return import(CORE_ENTRY_URL);
}

/** 加载 core 契约实现单例。 */
export async function loadCore() {
  return (await loadCoreModule()).core;
}

/**
 * 在 `.spike` 下创建一个临时启动器根目录。
 * @param {string} label 标签（用于目录名）。
 * @returns {Promise<string>} 临时根目录绝对路径。
 */
export async function makeTempRoot(label) {
  const base = path.join(REPO_ROOT, '.spike');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `t1-${label}-`));
}

/**
 * 递归删除临时目录（测试收尾用）。
 *
 * Windows 上刚被终止的实例进程可能短暂占着工作目录（EBUSY），因此退避重试。
 * @param {string} dir 目录。
 */
export async function cleanup(dir) {
  for (const delay of [0, 120, 300, 700, 1500, 3000]) {
    if (delay > 0) await sleep(delay);
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) return;
    }
  }
}

/** 假 dsh 的入口脚本（CommonJS，行为对齐真实 dsh 的关键约定）。 */
const STUB_BIN_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const TEMPLATES = {',
  "  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],",
  "  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],",
  "  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],",
  "  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],",
  "  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],",
  '};',
  'const argv = process.argv.slice(2);',
  'const home = process.env.DSH_HOME;',
  'function readFlag(name) {',
  '  const index = argv.indexOf(name);',
  '  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;',
  '}',
  'const profile = readFlag("--profile");',
  'const fromTemplate = readFlag("--from-default-profile");',
  'if (argv.includes("--dump-config")) {',
  '  if (!profile) {',
  '    process.stderr.write("error: --profile <name> is required\\n");',
  '    process.exit(2);',
  '  }',
  '  const dir = path.join(home, "profiles", profile);',
  '  const manifestPath = path.join(dir, "package.json");',
  '  if (fromTemplate && fs.existsSync(manifestPath)) {',
  '    process.stderr.write(\'dsh: profile "\' + profile + \'" already exists; omit --from-default-profile to use it\\n\');',
  '    process.exit(1);',
  '  }',
  '  if (!fs.existsSync(manifestPath)) {',
  '    const bundles = (fromTemplate ? TEMPLATES[fromTemplate] : TEMPLATES[profile]) || ["@deepseek-ai/dsh-base"];',
  '    fs.mkdirSync(dir, { recursive: true });',
  '    fs.writeFileSync(manifestPath, JSON.stringify({ name: "dsh-profile-" + profile, private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + "\\n");',
  '    fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "# stub patch layer\\n[]\\n");',
  '    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n");',
  '  }',
  '  fs.writeFileSync(path.join(dir, "cordis.yml"), "# stub root\\n[]\\n");',
  '  process.stdout.write("# stub dump-config\\n");',
  '  process.exit(0);',
  '}',
  'if (argv[0] === "plugin") {',
  '  // 对齐真实 dsh 的 plugin 子命令：把 profile 的 file:/link: 依赖链进 node_modules。',
  '  // 这里只做最小复现（真实实现走 pnpm），足以让"插件落盘 → 依赖登记 → 链接生效"整条链路可测。',
  '  const profileArg = readFlag("--profile");',
  '  // 子命令是第一个既不是选项名、也不是选项值的参数（调用方是 `plugin --profile <p> <sub> …`）。',
  '  const OPTION_NAMES = new Set(["--profile", "--config.cache", "--cache", "--patch"]);',
  '  let sub = null;',
  '  for (let i = 1; i < argv.length; i += 1) {',
  '    if (OPTION_NAMES.has(argv[i])) { i += 1; continue; }',
  '    if (argv[i].startsWith("--")) continue;',
  '    sub = argv[i];',
  '    break;',
  '  }',
  '  if (!profileArg) {',
  '    process.stderr.write("error: required option \'--profile <name>\' not specified\\n");',
  '    process.exit(1);',
  '  }',
  '  const dir = path.join(home, "profiles", profileArg);',
  '  const manifestPath = path.join(dir, "package.json");',
  '  if (!fs.existsSync(manifestPath)) {',
  '    process.stderr.write("stub: profile not found: " + dir + "\\n");',
  '    process.exit(1);',
  '  }',
  '  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));',
  '  let deps = manifest.dependencies || {};',
  '  // `add <目录/规格>`：真实 dsh 会转成 pnpm add，把目录变成 `link:<绝对路径>` 依赖写入 package.json。',
  '  // 这里补上这一步，否则"文件夹安装"这条链路在 stub 下根本没登记依赖，测试会假绿。',
  '  if (sub === "add") {',
  '    const spec = (function () {',
  '      for (let i = 1; i < argv.length; i += 1) {',
  '        if (OPTION_NAMES.has(argv[i])) { i += 1; continue; }',
  '        if (argv[i] === "add") continue;',
  '        if (argv[i].startsWith("--")) continue;',
  '        return argv[i];',
  '      }',
  '      return null;',
  '    })();',
  '    if (spec) {',
  '      let depName = null;',
  '      let depValue = spec;',
  '      try {',
  '        if (fs.statSync(spec).isDirectory()) {',
  '          const pkg = JSON.parse(fs.readFileSync(path.join(spec, "package.json"), "utf8"));',
  '          depName = pkg.name;',
  '          depValue = "link:" + spec;',
  '        }',
  '      } catch {',
  '        // 不是目录就当普通规格处理',
  '      }',
  '      if (!depName && /^github:/.test(spec)) {',
  '        // 真实 pnpm 会解析仓库 package.json 取 name；stub 把仓库目录名当包名',
  '        const body = spec.replace(/^github:/, "").split("#")[0];',
  '        const segments = body.split("/");',
  '        depName = segments[segments.length - 1];',
  '        depValue = spec;',
  '      }',
  '      if (!depName && /^https?:/.test(spec)) {',
  '        depName = spec.replace(/^.*\\//, "").replace(/\\.git$/, "");',
  '        depValue = spec;',
  '      }',
  '      if (!depName) {',
  '        depName = spec.replace(/@[^@/]*$/, "");',
  '        depValue = "*";',
  '      }',
  '      // 模拟 pnpm 10 拦截 git 依赖的 prepare 构建脚本（对齐真实行为）',
  '      // 开关：WHALES_TEST_BUILDS_BLOCKED=1；已在 pnpm-workspace.yaml 里放开则放行。',
  '      let blockedKind = null;',
  '      // 真实 pnpm 打印的是**包名**（与仓库名可能不同）；git 依赖的包名无法在下载前得知，',
  '      // 这里用"把 github:owner/ 前缀去掉"来模拟，既贴近真实又不假装知道包内 name。',
  '      if (depValue.startsWith("github:")) blockedKind = depName.replace(/^github:[^/]+\\//, "");',
  '      else if (depValue.startsWith("http")) blockedKind = depName.replace(/^.*\\//, "").replace(/\\.git$/, "");',
  '      if (blockedKind && process.env.WHALES_TEST_BUILDS_BLOCKED === "1") {',
  '        const wsPath = path.join(dir, "pnpm-workspace.yaml");',
  '        const ws = fs.existsSync(wsPath) ? fs.readFileSync(wsPath, "utf8") : "";',
  '        // 逐行判断"配置里有没有放开这个包"——两种字段名都要认：',
  '        // pnpm 10.33 用数组 onlyBuiltDependencies，另一些版本用映射 allowBuilds。',
  '        const lines = ws.split("\\n").map(function (line) { return line.trim(); });',
  '        const asListItem = lines.some(function (text) {',
  '          return text === "- " + blockedKind || text === "- \\"" + blockedKind + "\\"" || text === "- \'" + blockedKind + "\'";',
  '        });',
  '        const asMapEntry = lines.some(function (text) {',
  '          return text.indexOf(blockedKind + ":") === 0 || text.indexOf("\'" + blockedKind + "\':") === 0 || text.indexOf("\\"" + blockedKind + "\\":") === 0;',
  '        });',
  '        const allowed = asListItem || asMapEntry;',
  '        if (!allowed) {',
  '          process.stdout.write("Ignored build scripts: " + blockedKind + "@1.0.0\\n");',
  '          process.stderr.write("dsh: pnpm failed; diagnostics: " + path.join(dir, ".plugin-manager", "logs", "operation-test", "pnpm.log") + "\\n");',
  '          process.stderr.write("dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in " + wsPath + ", then re-run\\n");',
  '          process.exit(1);',
  '        }',
  '      }',
  '      deps[depName] = depValue;',
  '      manifest.dependencies = deps;',
  '      if (!manifest.dsh) manifest.dsh = {};',
  '      if (!manifest.dsh.profile) manifest.dsh.profile = {};',
  '      const list = manifest.dsh.profile.bundles || [];',
  '      if (!list.includes(depName)) list.push(depName);',
  '      manifest.dsh.profile.bundles = list;',
  '      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");',
  '      // 真实 pnpm 会把包装进 node_modules；stub 用「目录 + package.json」模拟，',
  '      // 否则 readProfileInventory 的 installed 判据与清单发现逻辑都测不到。',
  '      const nmDir = path.join(dir, "node_modules", depName);',
  '      try {',
  '        fs.mkdirSync(nmDir, { recursive: true });',
  '        fs.writeFileSync(path.join(nmDir, "package.json"), JSON.stringify({ name: depName, version: "1.0.0" }, null, 2) + "\\n");',
  '      } catch {',
  '        // 建不出来不影响命令语义',
  '      }',
  '      // 模拟"命令失败但依赖与文件其实已经落地"：git 依赖的 prepare 会往 stderr',
  '      // 写大量内容，第三方自检还会额外报错，退出码与最终状态可能不一致。',
  '      // 开关：WHALES_TEST_ADD_FAILS_AFTER_WRITE=1',
  '      if (process.env.WHALES_TEST_ADD_FAILS_AFTER_WRITE === "1") {',
  '        process.stderr.write("dsh: pnpm failed; diagnostics: " + path.join(dir, ".plugin-manager", "logs", "operation-test", "pnpm.log") + "\\n");',
  '        process.exit(1);',
  '      }',
  '    }',
  '  }',
  '  if (sub === "remove") {',
  '    const target = (function () {',
  '      for (let i = 1; i < argv.length; i += 1) {',
  '        if (OPTION_NAMES.has(argv[i])) { i += 1; continue; }',
  '        if (argv[i] === "remove") continue;',
  '        if (argv[i].startsWith("--")) continue;',
  '        return argv[i];',
  '      }',
  '      return null;',
  '    })();',
  '    if (target && Object.prototype.hasOwnProperty.call(deps, target)) {',
  '      delete deps[target];',
  '      manifest.dependencies = deps;',
  '      if (manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)) {',
  '        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== target);',
  '      }',
  '      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");',
  '    }',
  '  }',
  '  if (sub === "install" || sub === "add" || sub === "remove") {',
  '    const nm = path.join(dir, "node_modules");',
  '    for (const [depName, depSpec] of Object.entries(deps)) {',
  '      if (!/^(file|link):/i.test(String(depSpec))) continue;',
  '      const raw = String(depSpec).replace(/^(file|link):/i, "");',
  '      const target = path.isAbsolute(raw) ? raw : path.resolve(dir, raw);',
  '      const link = path.join(nm, depName);',
  '      try {',
  '        fs.mkdirSync(path.dirname(link), { recursive: true });',
  '        fs.rmSync(link, { recursive: true, force: true });',
  '        fs.symlinkSync(target, link, "junction");',
  '      } catch (error) {',
  '        process.stderr.write("stub: link failed for " + depName + ": " + error.message + "\\n");',
  '        process.exit(1);',
  '      }',
  '    }',
  '    process.stdout.write("stub: " + sub + " ok (" + Object.keys(deps).length + " deps)\\n");',
  '    process.exit(0);',
  '  }',
  '  process.stderr.write("stub: unsupported plugin subcommand: " + sub + "\\n");',
  '  process.exit(1);',
  '}',
  'fs.writeFileSync(path.join(process.cwd(), ".stub-start.json"), JSON.stringify({ home, cwd: process.cwd(), args: argv }, null, 2));',
  'process.stdout.write("stub: DSH_HOME=" + home + "\\n");',
  'process.stdout.write("stub: cwd=" + process.cwd() + "\\n");',
  'process.stdout.write("stub: listening on http://127.0.0.1:3999/\\n");',
  'const exitAfter = Number(process.env.STUB_EXIT_AFTER_MS || "0");',
  'if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter);',
  'else setInterval(() => {}, 1000);',
  '',
].join('\n');

/**
 * 在临时根目录下铺一个"假 dsh 引擎"。
 * @param {string} root 启动器根目录。
 * @param {string} version 版本号。
 * @returns {Promise<string>} dsh 包目录。
 */
export async function seedStubEngine(root, version = '9.9.9') {
  const packageDir = path.join(root, 'engines', version, 'node_modules', '@deepseek-ai', 'dsh');
  await fs.mkdir(path.join(packageDir, 'lib'), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(packageDir, 'lib', 'bin.js'), STUB_BIN_SOURCE);
  return packageDir;
}

/**
 * 尝试定位本机真实安装的 `@deepseek-ai/dsh` 包目录。
 *
 * 仅用于集成测试；找不到就跳过（不让测试在别的机器上失败）。
 * @param {string} [root] 临时启动器根目录（优先看它的 engines/）。
 * @returns {Promise<string | null>} dsh 包目录。
 */
export async function findRealDshPackage(root) {
  const candidates = [];
  if (process.env.WHALES_DSH_PACKAGE) candidates.push(process.env.WHALES_DSH_PACKAGE);
  if (root) {
    const enginesDir = path.join(root, 'engines');
    const versions = await fs.readdir(enginesDir).catch(() => []);
    for (const version of versions) candidates.push(path.join(enginesDir, version, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.join(nodeDir, 'node_modules', '@deepseek-ai', 'dsh'));
  candidates.push(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  // 本机已验证的全局安装位置
  candidates.push('F:\\NodeJS\\node_global\\node_modules\\@deepseek-ai\\dsh');
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return candidate;
    } catch {
      // 继续下一个候选
    }
  }
  return null;
}

/** 读取 JSON 文件。 */
export async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** 小睡（等待异步状态收敛）。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待条件成立。
 * @param {() => boolean | Promise<boolean>} predicate 条件。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<boolean>} 是否在超时前成立。
 */
export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}
