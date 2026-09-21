/**
 * 教程截图专用「隔离临时 home」构造器
 * ============================================================================
 *
 * 目的：为 `docs/guide/**` 的教程配图提供**可复现的演示数据**，让截图里出现
 * 「多个实例 / 引擎已安装 / 需处理状态 / 崩溃记录」等场景，而**绝不触碰用户的真实
 * 数据**（`F:\WhalesLauncher\instances`、`F:\WhalesLauncher\engines`）。
 *
 * 硬性安全边界：
 *  - home 只在 `os.tmpdir()/whales-tutorial-home` 下创建，脚本启动时**显式断言**
 *    该路径不在仓库根之下，且不等于仓库根；
 *  - 全程只写临时 home，从不读写仓库根的 `instances/` 与 `engines/`；
 *  - 引擎是**桩**（几行 Node 脚本，不是 dsh）：本脚本会把这一点写进
 *    `<home>/TUTORIAL-DEMO-HOME.md`，避免任何人误以为那是真实引擎。
 *
 * 运行：`node scripts/tutorial/demo-home.mjs`
 * 输出：stdout 一行 JSON（home 路径 + 实例/引擎清单）；退出码 0 = 构造成功。
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * 默认 home（有演示实例）。`--empty` 时改为一个**空 home**：一个实例都没有，
 * 用来截「还没有实例」的引导空态（docs/assets/screenshot-empty.png）。
 */
const emptyMode = process.argv.includes('--empty');
const home = path.join(os.tmpdir(), emptyMode ? 'whales-tutorial-home-empty' : 'whales-tutorial-home');

/* ---------------------------------------------------------------- 安全断言 */

function assertIsolated(target) {
  const resolved = path.resolve(target);
  if (resolved === repoRoot) throw new Error(`拒绝在仓库根上操作：${resolved}`);
  if (resolved.toLowerCase().startsWith(repoRoot.toLowerCase() + path.sep)) {
    throw new Error(`拒绝在仓库内创建临时 home（必须落在系统临时目录）：${resolved}`);
  }
  if (path.resolve(os.tmpdir()) !== path.dirname(resolved)) {
    throw new Error(`临时 home 必须直接位于系统临时目录下：${resolved}`);
  }
}

assertIsolated(home);

/* ---------------------------------------------------------------- 小工具 */

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeText = async (file, text) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
};

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/**
 * 桩引擎：**不是 dsh**。被启动器以 `node <bin> --profile <name> […]` 拉起，
 * 模拟一个最小可用的运行进程：打印一行带 URL 的输出（启动器据此探测界面地址），
 * 然后常驻；带 `--demo-crash` 时立即以退出码 1 结束，用来演示「已崩溃」状态。
 */
const STUB_ENGINE = `#!/usr/bin/env node
/*
 * WhalesLauncher 教程截图专用【桩引擎】—— 不是 @deepseek-ai/dsh。
 * 它只做两件事：① 打印一行形如 http://127.0.0.1:<port>/ 的地址让启动器完成
 * 界面地址探测；② 常驻不退（profile 名为 crash-demo 时立刻以退出码 1 结束）。
 * 之所以用桩：教程配图需要「运行中 / 已崩溃」这类真实运行时状态，而任务约束
 * 明确禁止启动真实 dsh 引擎。
 *
 * 为什么按 profile 名而不是按实例的 appArgs 判断崩溃：启动器传给引擎的命令行
 * 始终带 \`--profile <名>\`，而实例自定义参数不一定会被带上（界面发起启动时
 * 传的是空数组，core 会用请求里的空数组覆盖实例自身的 appArgs）。
 */
const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 3080;
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : '';

if (profile === 'crash-demo') {
  process.stderr.write('[demo-engine] 桩引擎按 profile=crash-demo 立即退出（演示崩溃态）\\n');
  process.exit(1);
}

process.stdout.write('[demo-engine] tutorial stub engine starting\\n');
process.stdout.write('[demo-engine] profile=' + profile + '\\n');
process.stdout.write('[demo-engine] DSH_HOME=' + (process.env.DSH_HOME || '(unset)') + '\\n');
process.stdout.write('[demo-engine] 监听地址 http://127.0.0.1:' + port + '/\\n');
process.stdout.write('[demo-engine] 这是一张教程截图的演示进程，不是真实 dsh 会话\\n');

// 心跳定时器必须保持引用（不能 unref）：unref 后事件循环为空，进程会立刻
// 以退出码 0 结束，启动器如实显示「已停止」，截图里就看不到「运行中」。
setInterval(() => {
  process.stdout.write('[demo-engine] heartbeat ' + new Date().toISOString() + '\\n');
}, 20000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;

/** 安装一个「引擎版本目录」：形状与真实引擎一致，内容只有桩脚本。 */
async function seedEngine(version) {
  const pkgDir = path.join(home, 'engines', version, 'node_modules', '@deepseek-ai', 'dsh');
  await writeJson(path.join(pkgDir, 'package.json'), {
    name: '@deepseek-ai/dsh',
    version,
    description: '教程截图用桩引擎（非真实 dsh 包）',
    private: true,
  });
  await writeText(path.join(pkgDir, 'lib', 'bin.js'), STUB_ENGINE);
  return version;
}

/** 一个实例：instance.json + profile 清单 + 目录骨架（与 core 的布局一致）。 */
async function seedInstance(spec) {
  const root = path.join(home, 'instances', spec.dirName);
  const profileDir = path.join(root, 'home', 'profiles', spec.profile);
  const bundles = spec.bundles;
  await writeJson(path.join(profileDir, 'package.json'), {
    name: spec.profile,
    version: '0.0.1',
    private: true,
    dsh: { profile: { bundles } },
    dependencies: {},
  });
  await writeText(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  await writeText(path.join(root, 'home', '.credentials.yaml'), '# 教程演示实例：无真实凭证\n');
  await writeText(path.join(root, 'workspace', 'README.md'), `# ${spec.name}\n\n教程截图演示工作区。\n`);
  await mkdir(path.join(root, 'logs'), { recursive: true });

  const meta = {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    dirName: spec.dirName,
    icon: spec.icon ?? null,
    color: spec.color,
    note: spec.note,
    engine: { version: spec.engine },
    profile: { name: spec.profile, template: spec.template },
    workspace: { mode: spec.workspace ?? 'local' },
    saves: { mode: spec.saves ?? 'local' },
    settings: { mode: spec.settings ?? 'local' },
    credentials: { mode: spec.credentials ?? 'inherit' },
    launch: { appArgs: spec.appArgs ?? [], autoOpenBrowser: true },
    createdAt: spec.createdAt ?? iso(60 * 24 * 30),
    lastLaunchedAt: spec.lastLaunchedAt ?? null,
    launchCount: spec.launchCount ?? 0,
  };

  if (spec.brokenMeta) {
    // 故意写坏：演示「记录异常」这一类需处理状态（core 会降级呈现而不是丢弃）
    await writeText(path.join(root, 'instance.json'), '{ 这不是合法 JSON —— 教程演示的损坏记录\n');
  } else {
    await writeJson(path.join(root, 'instance.json'), meta);
  }

  if (spec.seedLog) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeText(
      path.join(root, 'logs', `${stamp}.log`),
      [
        `[whales] 启动 ${spec.name}：node <stub-engine> --profile ${spec.profile}`,
        '[whales] DSH_HOME=' + path.join(root, 'home'),
        '[demo-engine] tutorial stub engine starting',
        '[demo-engine] 监听地址 http://127.0.0.1:3080/',
        '[demo-engine] heartbeat ' + iso(1),
        '',
      ].join('\n'),
    );
  }

  return {
    id: meta.id,
    dirName: spec.dirName,
    name: meta.name,
    engine: spec.engine,
    template: spec.template,
    // 索引快照：损坏记录写不出合法快照，返回 null 由调用方用合成元数据兜底
    meta: spec.brokenMeta ? null : meta,
  };
}

/* ---------------------------------------------------------------- 构造 */

async function main() {
  if (existsSync(home)) await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });

  if (emptyMode) {
    // 空 home：只有合法配置，没有任何实例与引擎 → 实例列表页显示引导空态
    await writeJson(path.join(home, 'launcher.json'), {
      schemaVersion: 1,
      primaryHome: path.join(home, 'home-base'),
      theme: 'light',
      lastInstanceId: null,
      confirmOnDelete: true,
      engineRegistry: 'https://registry.npmjs.org',
      nodePath: null,
    });
    await mkdir(path.join(home, 'instances'), { recursive: true });
    await writeText(
      path.join(home, 'TUTORIAL-DEMO-HOME.md'),
      [
        '# 教程截图演示 home（空态，隔离临时目录）',
        '',
        `由 \`scripts/tutorial/demo-home.mjs --empty\` 生成，路径：\`${home}\``,
        '',
        '这个 home **没有任何实例**，专门用来截「还没有实例」的引导空态',
        '（`docs/assets/screenshot-empty.png`）。真实用户数据在仓库根的 `instances/`、',
        '`engines/`，本目录的生成与使用过程从不读写它们。',
        '',
      ].join('\n'),
    );
    console.log(JSON.stringify({ ok: true, mode: 'empty', home, engines: [], instances: [] }, null, 2));
    return;
  }

  const engines = [];
  engines.push(await seedEngine('0.1.6-alpha.2'));
  engines.push(await seedEngine('0.1.5-rc.2'));

  await writeJson(path.join(home, 'launcher.json'), {
    schemaVersion: 1,
    primaryHome: path.join(home, 'home-base'),
    theme: 'light',
    lastInstanceId: 'tut-0001-workbench',
    confirmOnDelete: true,
    engineRegistry: 'https://registry.npmjs.org',
    nodePath: null,
  });

  const specs = [
    {
      id: 'tut-0001-workbench',
      dirName: 'workbench',
      name: '文档工作台',
      icon: '🐋',
      color: '#5B8DEF',
      note: '日常开发、文档协作与代码检索',
      engine: '0.1.6-alpha.2',
      profile: 'workbench',
      template: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      saves: 'shared',
      launchCount: 128,
      lastLaunchedAt: iso(3),
      createdAt: iso(60 * 24 * 41),
      seedLog: true,
    },
    {
      id: 'tut-0002-research',
      dirName: 'research',
      name: '资料检索',
      icon: '🔎',
      color: '#4C9F70',
      note: '论文与资料检索，工作区与另一个实例共享',
      engine: '0.1.6-alpha.2',
      profile: 'research',
      template: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      workspace: 'shared',
      launchCount: 42,
      lastLaunchedAt: iso(180),
      createdAt: iso(60 * 24 * 18),
    },
    {
      id: 'tut-0003-pipeline',
      dirName: 'pipeline',
      name: '数据流水线',
      icon: '⚙',
      color: '#B26A00',
      note: '无界面批处理：定时抓取与报表生成',
      engine: '0.1.5-rc.2',
      profile: 'pipeline',
      template: 'headless',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      launchCount: 9,
      lastLaunchedAt: iso(60 * 26),
      createdAt: iso(60 * 24 * 7),
    },
    {
      id: 'tut-0004-legacy',
      dirName: 'legacy-compat',
      name: '旧版兼容测试',
      icon: '🧪',
      color: '#7A5AF8',
      note: '绑定了一个本地未安装的旧引擎版本',
      engine: '0.1.0-legacy',
      profile: 'legacy-compat',
      template: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      launchCount: 3,
      lastLaunchedAt: iso(60 * 24 * 5),
      createdAt: iso(60 * 24 * 12),
    },
    {
      id: 'tut-0005-broken',
      dirName: 'broken-record',
      name: '记录异常实例',
      icon: '🧯',
      color: '#C4314B',
      note: 'instance.json 被外部写坏，用于演示降级呈现',
      engine: '0.1.6-alpha.2',
      profile: 'broken-record',
      template: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      brokenMeta: true,
      createdAt: iso(60 * 24 * 3),
    },
    {
      id: 'tut-0006-crash',
      dirName: 'crash-demo',
      name: '崩溃演示实例',
      icon: '💥',
      color: '#D13438',
      note: '启动时会被桩引擎以退出码 1 结束，用于演示崩溃态',
      engine: '0.1.6-alpha.2',
      profile: 'crash-demo',
      template: 'web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      launchCount: 4,
      lastLaunchedAt: iso(60 * 8),
      createdAt: iso(60 * 24 * 2),
    },
  ];

  const instances = [];
  for (const spec of specs) instances.push(await seedInstance(spec));

  /*
   * 幽灵记录：索引里有、磁盘上没有 → 演示「目录缺失」这一类需处理状态。
   * 与 core 的真实行为一致（instance.ts collectInstances 的最后一段）。
   */
  const ghostMeta = {
    schemaVersion: 1,
    id: 'tut-0007-archived',
    name: '已归档实例',
    dirName: 'archived',
    icon: null,
    color: '#5B8DEF',
    note: '目录已在文件管理器中被删除，仅剩索引快照',
    engine: { version: '0.1.5-rc.2' },
    profile: { name: 'archived', template: 'web' },
    workspace: { mode: 'local' },
    saves: { mode: 'local' },
    settings: { mode: 'local' },
    credentials: { mode: 'inherit' },
    launch: { appArgs: [], autoOpenBrowser: true },
    createdAt: iso(60 * 24 * 60),
    lastLaunchedAt: null,
    launchCount: 0,
  };
  const registryEntries = instances.map((item) => {
    if (item.meta !== null) return { id: item.id, dirName: item.dirName, meta: item.meta };
    // 损坏记录的索引快照：形状合法但不含损坏内容（core 会据此降级呈现）
    return {
      id: item.id,
      dirName: item.dirName,
      meta: {
        ...ghostMeta,
        id: item.id,
        name: item.name,
        dirName: item.dirName,
        profile: { name: item.dirName, template: item.template },
        note: '元数据损坏，信息来自索引快照',
      },
    };
  });
  registryEntries.push({ id: ghostMeta.id, dirName: ghostMeta.dirName, meta: ghostMeta });
  await writeJson(path.join(home, 'instances', 'registry.json'), {
    schemaVersion: 1,
    entries: registryEntries,
  });

  await writeText(
    path.join(home, 'TUTORIAL-DEMO-HOME.md'),
    [
      '# 教程截图演示 home（隔离临时目录）',
      '',
      `由 \`scripts/tutorial/demo-home.mjs\` 生成，路径：\`${home}\``,
      '',
      '## 这是什么',
      '',
      '- 这是**演示数据**，不是用户的真实启动器数据。真实数据在仓库根的 `instances/` 与 `engines/`，',
      '  本目录的生成与使用过程**从不读写它们**。',
      '- `docs/guide/**` 的 23 张教程配图（`docs/assets/tutorial/*.png`）就是在本 home 下运行的',
      '  应用窗口的真实截图。',
      '',
      '## 引擎是桩（重要）',
      '',
      '- `engines/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js` 是**几行 Node 桩脚本**，不是 dsh 包。',
      '- 之所以这么做：教程配图需要「运行中 / 已崩溃」这类**真实运行时状态**，而这些状态只有真的',
      '  拉起一个进程才会出现；任务约束明确禁止启动真实 dsh 引擎。',
      '- 桩引擎打印一行 `http://127.0.0.1:<port>/` 让启动器完成地址探测后常驻；',
      '  带 `--demo-crash` 时立刻以退出码 1 结束 —— 于是「已崩溃」也是启动器**真实判定**出来的状态。',
      '',
      '## 实例',
      '',
      ...instances.map(
        (item) => `- \`${item.id}\` — ${item.name}（${item.dirName}，引擎 ${item.engine}，模板 ${item.template}）`,
      ),
      `- \`${ghostMeta.id}\` — ${ghostMeta.name}（archived，仅索引快照 → 「目录缺失」）`,
      '',
    ].join('\n'),
  );

  const summary = {
    ok: true,
    home,
    engines,
    instances: [...instances.map((item) => ({ ...item, kind: 'directory' })), { id: ghostMeta.id, dirName: 'archived', kind: 'registry-only' }],
    realDataTouched: false,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('demo-home 构造失败：', error);
  process.exit(1);
});
