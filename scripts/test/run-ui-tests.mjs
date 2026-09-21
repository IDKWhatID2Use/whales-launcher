#!/usr/bin/env node
/**
 * WinUI 3 渲染层 UI 自动化测试运行器。
 *
 * 设计要点
 *  1. **逐页独立启动应用进程**：每页一个全新的 WhalesLauncher 进程 + 全新深链路由，
 *     避免跨页状态串扰（上一个页面的编辑态、滚动位置、SelectorBar 选中项都会残留）。
 *  2. **完全隔离的数据根**：临时 home 建在 os.tmpdir() 下，经 assertHomeIsolated 断言
 *     不在仓库内。真实的 F:\WhalesLauncher\instances / engines 永远不会被触碰。
 *  3. **期望值全部从后端/磁盘动态取**：实例数、实例名、引擎版本都来自 `instance:list` /
 *     `engine:list`；用例脚本里没有一个硬编码的实例名或版本号。
 *  4. **中文字面量只经过 UTF-8 JSON context 文件进入 PowerShell**：PS 5.1 按 ANSI 读
 *     `.ps1`，脚本内任何中文字面量都会乱码（本项目已实际踩过一次），因此用例脚本一律
 *     纯 ASCII，界面文案集中在 lib/labels.mjs。
 *  5. **诚实**：无法自动判定的项写 unverifiable，绝不计入 pass；退出码只在"有 fail 或有
 *     用例崩溃"时为 1。
 *
 * 用法：
 *   npm run test:ui
 *   node scripts/test/run-ui-tests.mjs --page p1-instances
 *   node scripts/test/run-ui-tests.mjs --list
 *   node scripts/test/run-ui-tests.mjs --keep          （保留临时 home 便于排查）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureHome, assertHomeIsolated, FIXTURE_ENGINE_VERSION, NO_MATCH_QUERY } from './lib/fixtures.mjs';
import { openBridge } from './lib/bridge.mjs';
import { LABELS, CHECKS } from './lib/labels.mjs';
import {
  FRAMEWORK_RATIONALE,
  ISOLATION_NOTES,
  UIA_SPIKE_NOTES,
  KNOWN_DEFECTS,
  ENVIRONMENT_HAZARDS,
  FOLLOW_UPS,
} from './lib/report-notes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const auditDir = path.join(repoRoot, 'docs', 'audit');
const reportJsonPath = path.join(auditDir, 'ui-test-report.json');
const reportMdPath = path.join(auditDir, 'ui-test-report.md');

const EXE = path.join(
  repoRoot,
  'desktop',
  'src',
  'WhalesLauncher.App',
  'bin',
  'Debug',
  'net10.0-windows10.0.26100.0',
  'win-x64',
  'WhalesLauncher.exe',
);
const BRIDGE_ENTRY = path.join(repoRoot, 'dist', 'bridge', 'server.cjs');

/**
 * 页面清单：顺序即执行顺序。
 *  - route      = 人类可读的「这一页怎么到达」
 *  - launchRoute= 传给 WHALES_SMOKE_ROUTE 的深链值
 *
 * ⚠ P7 / P8 的深链（create / settings）曾经失效：那条路径在 MainWindow 构造期执行，
 *   当时后端尚未装配，而 WizardPage / SettingsPage 的 OnNavigatedTo 没有
 *   AppServices.IsReady 守卫（InstancesPage 有），异常被 NavigateSmokeRoute 的
 *   try/catch 静默吞掉 —— 标题栏副标题切到了目标页，内容区却从未建立。
 *   该缺陷已由并行的源码修复解决（ApplySmokeRoute 现在等 IsInitialized 再导航）。
 *   本套用例因此**直接使用深链**，并各自留一条断言（P7-08 / P8-08）专门盯住它；
 *   万一深链再次回归，用例会退回到"点击真实入口"继续跑完，但那条断言会红。
 */
const PAGES = [
  {
    id: 'shell',
    script: 'shell.ps1',
    route: 'instances',
    launchRoute: 'instances',
    navigation: '深链 instances',
    title: '外壳（标题栏 / 左栏 / 应用菜单 / 日志抽屉 / 主题）',
  },
  {
    id: 'p1-instances',
    script: 'p1-instances.ps1',
    route: 'instances',
    launchRoute: 'instances',
    navigation: '深链 instances',
    title: 'P1 实例列表',
    needsEmptyHome: true,
  },
  {
    id: 'p2-detail-plugins',
    script: 'p2-detail-plugins.ps1',
    route: 'detail/first/plugins',
    launchRoute: 'detail/first/plugins',
    alternateRoute: 'detail/first/saves',
    navigation: '深链 detail/first/plugins（另跑一次 detail/first/saves）',
    title: 'P2 实例详情 · 插件',
  },
  {
    id: 'p3-detail-settings',
    script: 'p3-detail-settings.ps1',
    route: 'detail/first/settings',
    launchRoute: 'detail/first/settings',
    navigation: '深链 detail/first/settings',
    title: 'P3 实例详情 · 设置',
  },
  {
    id: 'p4-detail-saves',
    script: 'p4-detail-saves.ps1',
    route: 'detail/first/saves',
    launchRoute: 'detail/first/saves',
    navigation: '深链 detail/first/saves',
    title: 'P4 实例详情 · 存档',
  },
  {
    id: 'p5-detail-logs',
    script: 'p5-detail-logs.ps1',
    route: 'detail/first/logs',
    launchRoute: 'detail/first/logs',
    navigation: '深链 detail/first/logs',
    title: 'P5 实例详情 · 日志',
  },
  {
    id: 'p6-engines',
    script: 'p6-engines.ps1',
    route: 'engines',
    launchRoute: 'engines',
    navigation: '深链 engines（另跑一次无引擎 home）',
    title: 'P6 引擎版本管理',
    needsNoEngineHome: true,
  },
  {
    id: 'p7-wizard',
    script: 'p7-wizard.ps1',
    route: 'create',
    launchRoute: 'create',
    navigation: '深链 create（失败时退回点击页头「新建实例」按钮）',
    title: 'P7 创建实例向导',
  },
  {
    id: 'p8-settings',
    script: 'p8-settings.ps1',
    route: 'settings',
    launchRoute: 'settings',
    navigation: '深链 settings（失败时退回点击左栏「全局设置」入口）',
    title: 'P8 全局设置',
  },
];

const CASE_TIMEOUT_MS = Number(process.env.WHALES_UI_CASE_TIMEOUT_MS ?? 240_000);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { pages: [], list: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--page' || arg === '-p') {
      const value = argv[i + 1];
      if (!value) throw new Error('--page 需要一个页面 id');
      options.pages.push(value);
      i += 1;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

async function countFiles(dir) {
  try {
    return (await readdir(dir)).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 单页执行
 * ------------------------------------------------------------------ */

function runCaseScript(scriptPath, contextFile, outJson) {
  return new Promise((resolve) => {
    // Hand each case a CLEAN routing/root environment. Start-WhalesApp sets
    // WHALES_SMOKE_ROUTE / WHALES_LAUNCHER_ROOT for the app it launches, so any
    // value inherited from the runner's own environment is pure noise. One
    // observed run had the app sitting on the About page (failing SH-08) with no
    // click involved in the case, which is exactly the symptom of a leaked route
    // value; deleting the keys here removes that whole class of flakiness.
    const env = { ...process.env };
    delete env.WHALES_SMOKE_ROUTE;
    delete env.WHALES_LAUNCHER_ROOT;
    delete env.WHALES_ROOT;

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ContextFile', contextFile, '-OutJson', outJson],
      { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, CASE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) console.log(`      ${line}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) console.log(`      [stderr] ${line}`);
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log('用法：node scripts/test/run-ui-tests.mjs [--page <id>]... [--list] [--keep]');
    return 0;
  }
  if (options.list) {
    for (const page of PAGES) console.log(`${page.id.padEnd(20)} ${page.route.padEnd(24)} ${page.title}`);
    return 0;
  }

  console.log('WhalesLauncher WinUI 3 渲染层 UI 自动化测试');
  console.log(`仓库根：${repoRoot}`);
  console.log('框架：PowerShell 5.1 + 内置 UI Automation（UIAutomationClient / UIAutomationTypes）+ PrintWindow 截图');
  console.log('');

  if (!existsSync(EXE)) {
    console.error(`找不到应用产物：${EXE}\n请先执行：pwsh -File desktop\\build-app.ps1`);
    return 2;
  }
  if (!existsSync(BRIDGE_ENTRY)) {
    console.error(`找不到桥接产物：${BRIDGE_ENTRY}\n请先执行：node scripts/build-bridge.mjs`);
    return 2;
  }

  const selected = options.pages.length === 0 ? PAGES : PAGES.filter((page) => options.pages.includes(page.id));
  const unknown = options.pages.filter((id) => !PAGES.some((page) => page.id === id));
  if (unknown.length > 0) {
    console.error(`未知页面 id：${unknown.join(', ')}（用 --list 查看可用值）`);
    return 2;
  }

  const startedAt = new Date();
  const cleanup = new Set();

  let main = null;
  let emptyHome = null;
  let noEngineHome = null;
  let bridge = null;

  try {
    /* ---------------- fixture ---------------- */
    main = await createFixtureHome({ instances: 3, engines: 2 });
    assertHomeIsolated(main.home, repoRoot);
    cleanup.add(main);

    if (selected.some((page) => page.needsEmptyHome)) {
      emptyHome = await createFixtureHome({ instances: 0, engines: 1 });
      assertHomeIsolated(emptyHome.home, repoRoot);
      cleanup.add(emptyHome);
    }
    if (selected.some((page) => page.needsNoEngineHome)) {
      noEngineHome = await createFixtureHome({ instances: 1, engines: 0 });
      assertHomeIsolated(noEngineHome.home, repoRoot);
      cleanup.add(noEngineHome);
    }

    console.log(`临时 home：${main.home}`);
    if (emptyHome) console.log(`临时 home（无实例）：${emptyHome.home}`);
    if (noEngineHome) console.log(`临时 home（无引擎）：${noEngineHome.home}`);
    console.log('');

    /* ---------------- 从后端取期望值 ---------------- */
    bridge = await openBridge({ home: main.home, repoRoot });
    const instanceList = await bridge.call('instance:list');
    const engineList = await bridge.call('engine:list');
    const instances = Array.isArray(instanceList) ? instanceList : [];
    const engines = Array.isArray(engineList) ? engineList : [];

    const firstInstance = instances[0];
    const firstInstanceId = firstInstance?.meta?.id ?? '';
    const firstInstanceDir = firstInstance?.meta?.dirName ?? '';

    let sessionCount = 0;
    if (firstInstanceDir) {
      const sessionsDir = path.join(main.home, 'instances', firstInstanceDir, 'home', 'sessions');
      sessionCount = await countFiles(sessionsDir);
    }

    const searchHits = instances.filter((item) => String(item?.meta?.name ?? '').includes(String(firstInstance?.meta?.name ?? '\u0000')));
    const expectations = {
      instanceCount: instances.length,
      instanceNames: instances.map((item) => item?.meta?.name).filter(Boolean),
      instanceDirs: instances.map((item) => item?.meta?.dirName).filter(Boolean),
      engineCount: engines.length,
      engineVersions: engines.map((item) => item.version).filter(Boolean),
      noEngineHomeDir: noEngineHome ? noEngineHome.home : '',
      emptyHomeDir: emptyHome ? emptyHome.home : '',
      firstInstanceName: firstInstance?.meta?.name ?? '',
      firstInstanceDir,
      firstInstanceId,
      sessionCount,
      searchHitQuery: firstInstance?.meta?.name ?? '',
      searchHitCount: searchHits.length,
      noMatchQuery: NO_MATCH_QUERY,
      fixtureEngineVersion: FIXTURE_ENGINE_VERSION,
    };

    console.log(`后端期望值：实例 ${expectations.instanceCount} 个（${expectations.instanceNames.join(', ')}）、引擎 ${expectations.engineCount} 个（${expectations.engineVersions.join(', ')}）、首个实例存档 ${sessionCount} 个`);
    console.log('');

    /* ---------------- 逐页执行 ---------------- */
    const results = [];
    const ctxDir = path.join(main.home, '_uidriver', 'ctx');
    const outDir = path.join(main.home, '_uidriver', 'results');
    await mkdir(ctxDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    const logDir = path.join(main.home, '_uidriver', 'logs');
    await mkdir(logDir, { recursive: true });

    for (const page of selected) {
      const context = {
        page: page.id,
        pageTitle: page.title,
        route: page.route,
        launchRoute: page.launchRoute ?? page.route,
        navigation: page.navigation ?? '',
        alternateRoute: page.alternateRoute ?? '',
        script: page.script,
        exe: EXE,
        home: main.home,
        logDir,
        repoRoot,
        labels: LABELS,
        expect: expectations,
        checks: CHECKS[page.id] ?? {},
      };

      const contextFile = path.join(ctxDir, `${page.id}.json`);
      const outJson = path.join(outDir, `${page.id}.json`);
      // UTF-8 无 BOM：PS 5.1 的 ConvertFrom-Json 对 BOM 敏感，Get-Content -Encoding UTF8 可读无 BOM。
      await writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

      console.log(`== ${page.title} ==`);
      console.log(`   到达方式：${page.navigation ?? page.route}`);

      // Retry policy: ONLY infrastructure failures are retried. This machine
      // runs other agents that periodically kill every WhalesLauncher.exe (proven
      // with an A/B run: a control instance on a known-good route died at the very
      // same instant as the subject), and a case killed halfway through produces a
      // pile of meaningless assertion failures. Genuine assertion failures are
      // never retried - they are the product's problem, not the harness's.
      let parsed = null;
      let elapsed = 0;
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        attempts += 1;
        const started = Date.now();
        const run = await runCaseScript(path.join(here, 'ui', page.script), contextFile, outJson);
        elapsed = Date.now() - started;

        parsed = null;
        let readError = '';
        try {
          parsed = JSON.parse(await readFile(outJson, 'utf8'));
        } catch (error) {
          readError = `用例未产出结果 JSON：${error.message}`;
        }

        if (!parsed) {
          parsed = {
            page: page.id,
            title: page.title,
            route: page.route,
            error: readError + (run.timedOut ? '（用例脚本超时被杀）' : ''),
            infrastructure: false,
            total: 0,
            passed: 0,
            failed: 0,
            unverifiable: 0,
            checks: [],
            diagnostics: [],
          };
        }
        parsed.exitCode = run.code;
        parsed.timedOut = run.timedOut;
        if (run.stderr && run.stderr.trim()) {
          parsed.diagnostics = [...(parsed.diagnostics ?? []), `stderr: ${run.stderr.trim().slice(-2000)}`];
        }

        const retryable = parsed.infrastructure === true || run.timedOut === true;
        if (!retryable || attempts >= maxAttempts) break;
        console.log(`   [retry] 基础设施失败（第 ${attempts} 次，应用进程被外部终止），重跑本页…`);
      }

      parsed.durationMs = elapsed;
      parsed.attempts = attempts;
      results.push(parsed);

      const mark = parsed.failed > 0 || parsed.error ? 'FAIL' : 'ok';
      console.log(`   ${mark}：${parsed.passed} 通过 / ${parsed.failed} 失败 / ${parsed.unverifiable} 不可判定（${elapsed}ms，尝试 ${attempts} 次）`);
      console.log('');
    }

    /* ---------------- 汇总 ---------------- */
    const totals = results.reduce(
      (acc, item) => {
        acc.total += item.total ?? 0;
        acc.passed += item.passed ?? 0;
        acc.failed += item.failed ?? 0;
        acc.unverifiable += item.unverifiable ?? 0;
        if (item.error) acc.errored += 1;
        return acc;
      },
      { total: 0, passed: 0, failed: 0, unverifiable: 0, errored: 0 },
    );

    const report = {
      schema: 'whaleslauncher.ui-test-report/1',
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      framework: {
        driver: 'PowerShell 5.1 + 内置 UI Automation（UIAutomationClient / UIAutomationTypes）',
        capture: 'scripts/audit/capture-core.ps1 的 [WinAuditCore]（PrintWindow PW_RENDERFULLCONTENT + ImageStats）',
        runner: 'Node.js（scripts/test/run-ui-tests.mjs）',
        newDependencies: [],
      },
      environment: {
        exe: EXE,
        bridge: BRIDGE_ENTRY,
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        tmpHome: main.home,
      },
      expectations,
      totals,
      pages: results,
      exitCode: totals.failed === 0 && totals.errored === 0 ? 0 : 1,
    };

    await mkdir(auditDir, { recursive: true });
    await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(reportMdPath, renderMarkdown(report), 'utf8');

    /* ---------------- 控制台汇总 ---------------- */
    console.log('================ 汇总 ================');
    for (const item of results) {
      const status = item.failed > 0 || item.error ? 'FAIL' : 'PASS';
      console.log(
        `${status}  ${String(item.page).padEnd(20)} ${String(item.passed).padStart(2)}/${String(item.total).padStart(2)} 通过` +
          `${item.unverifiable ? `（${item.unverifiable} 不可判定）` : ''}${item.failed ? `  ${item.failed} 失败` : ''}  ${item.durationMs}ms`,
      );
    }
    console.log('--------------------------------------');
    console.log(`总断言数：${totals.total}`);
    console.log(`通过：${totals.passed}`);
    console.log(`失败：${totals.failed}`);
    console.log(`不可判定（unverifiable）：${totals.unverifiable}`);
    if (totals.errored) console.log(`用例崩溃：${totals.errored}`);
    console.log(`报告：${path.relative(repoRoot, reportMdPath)} / ${path.relative(repoRoot, reportJsonPath)}`);
    console.log(`退出码：${report.exitCode}`);

    return report.exitCode;
  } finally {
    if (bridge) await bridge.close().catch(() => {});
    if (options.keep) {
      console.log(`\n--keep：临时 home 已保留：${[...cleanup].map((item) => item.home).join(', ')}`);
    } else {
      for (const item of cleanup) {
        await item.dispose().catch(() => {});
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Markdown 报告
 * ------------------------------------------------------------------ */

function renderMarkdown(report) {
  const lines = [];
  lines.push('# WinUI 3 渲染层 UI 自动化测试报告');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}　耗时：${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## 1. 结论');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 总断言数 | ${report.totals.total} |`);
  lines.push(`| 通过 | ${report.totals.passed} |`);
  lines.push(`| 失败 | ${report.totals.failed} |`);
  lines.push(`| 不可判定（unverifiable，**不计入通过**） | ${report.totals.unverifiable} |`);
  lines.push(`| 用例崩溃 | ${report.totals.errored} |`);
  lines.push(`| 退出码 | ${report.exitCode} |`);
  lines.push('');
  lines.push('复跑命令：`npm run test:ui`（单页：`node scripts/test/run-ui-tests.mjs --page p1-instances`）');
  lines.push('');
  lines.push('## 2. 框架选型与依据');
  lines.push('');
  lines.push(...FRAMEWORK_RATIONALE);
  lines.push('');
  lines.push('## 3. 隔离与可复跑性');
  lines.push('');
  lines.push(...ISOLATION_NOTES);
  lines.push('');
  lines.push('## 4. UIA spike 结论：哪些控件可枚举 / 可交互');
  lines.push('');
  lines.push(...UIA_SPIKE_NOTES);
  lines.push('');
  lines.push('## 5. 逐页结果');
  lines.push('');
  lines.push('| 页面 | 到达方式 | 通过/总数 | 失败 | 不可判定 | 尝试次数 | 耗时 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const page of report.pages) {
    lines.push(
      `| ${page.title} | ${page.navigation ?? ''} | ${page.passed}/${page.total} | ${page.failed} | ${page.unverifiable} | ${page.attempts ?? 1} | ${page.durationMs}ms |`,
    );
  }
  lines.push('');

  for (const page of report.pages) {
    lines.push(`### ${page.title}`);
    lines.push('');
    lines.push(`到达方式：${page.navigation ?? page.route}　用例：\`scripts/test/ui/${page.page}.ps1\``);
    lines.push('');
    if (page.error) {
      lines.push('**用例级错误**：');
      lines.push('');
      lines.push('```');
      lines.push(String(page.error));
      lines.push('```');
      lines.push('');
    }
    lines.push('| 断言 | 类型 | 结果 | 说明 |');
    lines.push('|---|---|---|---|');
    for (const check of page.checks ?? []) {
      const status = check.status === 'pass' ? '通过' : check.status === 'fail' ? '**失败**' : 'unverifiable';
      const detail = String(check.detail ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      lines.push(`| ${check.id} ${check.title} | ${check.kind} | ${status} | ${detail} |`);
    }
    if (!page.checks || page.checks.length === 0) lines.push('| （无用例结果） | - | - | - |');
    lines.push('');
    if (page.diagnostics && page.diagnostics.length > 0) {
      lines.push('<details><summary>UIA 诊断</summary>');
      lines.push('');
      lines.push('```');
      for (const diag of page.diagnostics) lines.push(String(diag));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  /* ---- unverifiable 清单 ---- */
  lines.push('## 6. unverifiable 清单（不计入通过）');
  lines.push('');
  const unverifiables = [];
  for (const page of report.pages) {
    for (const check of page.checks ?? []) {
      if (check.status === 'unverifiable') unverifiables.push({ page: page.title, ...check });
    }
  }
  if (unverifiables.length === 0) {
    lines.push('本次运行没有 unverifiable 项。');
  } else {
    lines.push('| 页面 | 断言 | 原因 |');
    lines.push('|---|---|---|');
    for (const item of unverifiables) {
      lines.push(`| ${item.page} | ${item.id} ${item.title} | ${String(item.detail ?? '').replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');

  /* ---- 缺陷 ---- */
  lines.push('## 7. 发现的真实缺陷');
  lines.push('');
  for (const defect of KNOWN_DEFECTS) {
    lines.push(`### ${defect.id}　${defect.title}`);
    lines.push('');
    lines.push(`- 严重度：${defect.severity}`);
    lines.push(`- 状态：${defect.status}`);
    lines.push('- 证据：');
    for (const item of defect.evidence) lines.push(`  - ${item}`);
    lines.push(`- 对本套用例的影响：${defect.impactOnSuite}`);
    lines.push('');
  }

  /* ---- 环境风险 ---- */
  lines.push('## 8. 环境风险与已实现的对策');
  lines.push('');
  lines.push(...ENVIRONMENT_HAZARDS);
  lines.push('');

  /* ---- 每页尝试次数 ---- */
  const retried = report.pages.filter((page) => (page.attempts ?? 1) > 1);
  if (retried.length > 0) {
    lines.push('本次运行发生的重试：');
    lines.push('');
    for (const page of retried) {
      lines.push(`- ${page.title}：尝试 ${page.attempts} 次（前 ${page.attempts - 1} 次为基础设施失败）`);
    }
    lines.push('');
  }

  /* ---- 后续 ---- */
  lines.push('## 9. 建议后续');
  lines.push('');
  lines.push(...FOLLOW_UPS);
  lines.push('');

  /* ---- 环境快照 ---- */
  lines.push('## 10. 环境快照');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({ environment: report.environment, expectations: report.expectations, framework: report.framework }, null, 2));
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('\nUI 测试运行器异常终止：', error);
    process.exitCode = 1;
  });
