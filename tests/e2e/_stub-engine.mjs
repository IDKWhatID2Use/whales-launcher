/**
 * QA 端到端测试：假 dsh 引擎（stub）。
 *
 * 与 T1 的 `tests/core/_helpers.mjs` 中的 stub **相互独立**（QA 不依赖被审代码的
 * 测试助手，避免"用被测方的假设验证被测方"）。本 stub 只复刻 dsh 的**外部可观测
 * 契约**（`docs/research/dsh-interface.md` §1/§3.1）：
 *   - `--profile <n> [--from-default-profile <tpl>] --dump-config` →
 *     在 `$DSH_HOME/profiles/<n>/` 建 `package.json` / `cordis.patch.yml` /
 *     `pnpm-workspace.yaml` / `cordis.yml`，退出码 0，不启动应用。
 *   - 随附模板名（web/headless/…）不可作 `--from-default-profile` 目标 → 退出码 1
 *     （对应 dsh 的 `profile "web" is shipped and cannot be a custom profile target`）。
 *   - 长驻模式：打印监听地址到 stdout，写完 `.stub-start.json` 记录 DSH_HOME/cwd。
 *   - `plugin` 子命令：默认失败（可用 `STUB_PLUGIN_OK=1` 令其成功），用于验证
 *     "插件增删是否真的走 dsh plugin CLI"。
 *
 * 额外能力（供 QA 破坏性用例使用）：`STUB_FAIL=1` 让启动立即非零退出、
 * `STUB_HANG=1` 让启动后挂住不退出、`STUB_EXIT_AFTER_MS=<n>` 定时退出。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 随附模板 → bundles（dsh PROFILE_TEMPLATES 的忠实复刻）。 */
const TEMPLATES = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
};

/** stub 脚本源码（CJS，用 node 直接跑）。 */
const SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const TEMPLATES = ${JSON.stringify(TEMPLATES)};
const SHIPPED = Object.keys(TEMPLATES);
const argv = process.argv.slice(2);
const home = process.env.DSH_HOME;
function readFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
if (!home) { process.stderr.write('error: DSH_HOME is not set\\n'); process.exit(3); }
const profile = readFlag('--profile');
const fromTemplate = readFlag('--from-default-profile');

if (argv[0] === 'plugin') {
  // 记录调用现场，供 QA 断言"是否真的走了 CLI"。
  try {
    fs.writeFileSync(path.join(home, '.stub-plugin.json'), JSON.stringify({ argv, cwd: process.cwd() }, null, 2));
  } catch (e) {}
  if (process.env.STUB_PLUGIN_OK === '1') { process.stdout.write('stub plugin ok\\n'); process.exit(0); }
  process.stderr.write('stub: plugin command not supported\\n');
  process.exit(1);
}

if (argv.includes('--dump-config')) {
  if (!profile) { process.stderr.write('error: --profile <name> is required\\n'); process.exit(2); }
  if (profile === 'desktop') { process.stderr.write('profile "desktop" is reserved for the Electron host\\n'); process.exit(1); }
  // 实测校准（真实 dsh 0.1.6-alpha.2，本机 2026-02 验证）：
  //   --profile qa-one --from-default-profile web --dump-config  → 退出码 0（合法）✓
  //   --profile web    --from-default-profile web --dump-config  → 退出码 1（被拒）✗
  // 即 from-default-profile 取随附模板名本身没问题；被拒绝的是"目标 profile 名等于随附模板名"。
  if (fromTemplate !== null && SHIPPED.indexOf(profile) >= 0) {
    process.stderr.write('dsh: profile "' + profile + '" is shipped and cannot be a custom profile target; omit --from-default-profile to use it\\n');
    process.exit(1);
  }
  if (profile === '.' || profile === '..' || profile === 'node_modules' || profile.includes('/') || profile.includes('\\\\')) {
    process.stderr.write('invalid profile name: ' + profile + '\\n');
    process.exit(1);
  }
  const dir = path.join(home, 'profiles', profile);
  const manifestPath = path.join(dir, 'package.json');
  if (fromTemplate !== null && fs.existsSync(manifestPath)) {
    process.stderr.write('dsh: profile "' + profile + '" already exists; omit --from-default-profile to use it\\n');
    process.exit(1);
  }
  if (!fs.existsSync(manifestPath)) {
    const bundles = fromTemplate !== null ? (TEMPLATES[fromTemplate] || ['@deepseek-ai/dsh-base'])
                                          : (TEMPLATES[profile] || ['@deepseek-ai/dsh-base']);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\\n');
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# profile patch layer\\n[]\\n');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n');
  }
  fs.writeFileSync(path.join(dir, 'cordis.yml'), '# root\\n[]\\n');
  process.stdout.write('# stub dump-config for ' + profile + '\\n');
  process.exit(0);
}

if (process.env.STUB_FAIL === '1') { process.stderr.write('stub: fatal startup error\\n'); process.exit(7); }

try {
  fs.writeFileSync(path.join(process.cwd(), '.stub-start.json'), JSON.stringify({ home, cwd: process.cwd(), args: argv }, null, 2));
} catch (e) {}
process.stdout.write('stub: DSH_HOME=' + home + '\\n');
process.stdout.write('stub: cwd=' + process.cwd() + '\\n');
process.stdout.write('stub: listening on http://127.0.0.1:3999/\\n');
const exitAfter = Number(process.env.STUB_EXIT_AFTER_MS || '0');
if (exitAfter > 0) setTimeout(() => process.exit(Number(process.env.STUB_EXIT_CODE || '0')), exitAfter);
else setInterval(() => {}, 1000);
`;

/**
 * 在启动器根下铺一个假 dsh 引擎。
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
  await fs.writeFile(path.join(packageDir, 'lib', 'bin.js'), SOURCE);
  return packageDir;
}

/** 读取 JSON 文件。 */
export async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** 生成一个最小可用实例元数据（绕过 createInstance 造"手删目录"等异常态）。 */
export function fakeMeta(overrides = {}) {
  return {
    schemaVersion: 1,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'QA 实例',
    dirName: overrides.dirName ?? 'qa-instance',
    icon: null,
    color: '#5B8DEF',
    note: '',
    engine: { version: overrides.engineVersion ?? '9.9.9' },
    profile: { name: overrides.profileName ?? overrides.dirName ?? 'qa-instance', template: 'web' },
    workspace: { mode: overrides.workspace ?? 'local' },
    saves: { mode: overrides.saves ?? 'local' },
    settings: { mode: overrides.settings ?? 'local' },
    credentials: { mode: overrides.credentials ?? 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: false },
    createdAt: new Date().toISOString(),
    lastLaunchedAt: null,
    launchCount: 0,
  };
}
