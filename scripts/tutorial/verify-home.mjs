/**
 * 校验「隔离临时 home」是否被 core 正确读取
 * ============================================================================
 *
 * 做法：spawn `dist/bridge/server.cjs --home <临时 home>`，按协议发 `instance:list`
 * 与 `engine:list`，确认演示数据真的出现在 core 的视角里（截图里能看到的东西，
 * 必须是 core 真的报告出来的东西 —— 否则就是自己在骗自己）。
 *
 * 只读：本脚本不写任何实例数据，也不启动任何实例。
 * 运行：`node scripts/tutorial/verify-home.mjs`
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeEntry = path.join(repoRoot, 'dist', 'bridge', 'server.cjs');
const home = path.join(os.tmpdir(), 'whales-tutorial-home');

const child = spawn(process.execPath, [bridgeEntry, '--home', home], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buffer = '';
const pending = new Map();
let seq = 0;
const stderrLines = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (typeof message.method === 'string') {
      // 宿主调用：本脚本不触发对话框类通道，直接回 ok
      child.stdin.write(`${JSON.stringify({ id: message.id, ok: true, value: null })}\n`);
      continue;
    }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/)) if (line.trim()) stderrLines.push(line);
});

const request = (method, params = []) =>
  new Promise((resolve, reject) => {
    seq += 1;
    const id = `v${seq}`;
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
  if (!ok) failures.push(label);
};

try {
  const list = await request('instance:list');
  check('instance:list 成功', list.ok === true, JSON.stringify(list.error ?? ''));
  const items = list.value ?? [];
  check('实例条数 = 7（6 个目录 + 1 条幽灵记录）', items.length === 7, `实际 ${items.length}`);
  for (const item of items) {
    console.log(
      `  · ${item.meta.name}（${item.meta.dirName}）engine=${item.meta.engine.version} ` +
        `present=${item.present} degraded=${item.degraded ?? item.problem ?? '-'}`,
    );
  }
  const names = items.map((item) => item.meta.dirName).sort();
  check(
    '目录名集合符合预期',
    JSON.stringify(names) ===
      JSON.stringify(['archived', 'broken-record', 'crash-demo', 'legacy-compat', 'pipeline', 'research', 'workbench']),
    JSON.stringify(names),
  );

  const engines = await request('engine:list');
  check('engine:list 成功', engines.ok === true, JSON.stringify(engines.error ?? ''));
  const versions = (engines.value ?? []).map((item) => item.version);
  check('引擎版本 = 2 个（桩引擎，标注为已安装）', versions.length === 2, JSON.stringify(versions));
  for (const engine of engines.value ?? []) {
    console.log(`  · ${engine.version} installed=${engine.installed} usedBy=${JSON.stringify(engine.usedBy)}`);
  }

  const detail = await request('instance:get', ['tut-0001-workbench']);
  const detailName = detail.value?.name ?? detail.value?.meta?.name;
  check('instance:get 能读到演示实例', detail.ok === true && detailName === '文档工作台', JSON.stringify(detailName));

  const settings = await request('settings:read', ['tut-0001-workbench']);
  check('settings:read 可用（详情·设置页有内容）', settings.ok === true, JSON.stringify(settings.error ?? ''));

  const saves = await request('saves:list', ['tut-0001-workbench']);
  check('saves:list 可用（详情·存档页有内容）', saves.ok === true, JSON.stringify(saves.error ?? ''));

  const plugins = await request('plugin:inventory', ['tut-0001-workbench']);
  check('plugin:inventory 可用（详情·插件页有内容）', plugins.ok === true, JSON.stringify(plugins.error ?? ''));

  const menu = await request('app:menu');
  check('app:menu 可用（标题栏应用菜单有内容）', menu.ok === true, JSON.stringify(menu.error ?? ''));

  const shutdown = await request('__shutdown');
  check('__shutdown 成功', shutdown.ok === true);
} catch (error) {
  console.error('校验异常：', error);
  failures.push(String(error));
} finally {
  child.kill();
}

if (failures.length > 0) {
  console.error(`\n演示 home 校验失败 ${failures.length} 项：\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\n演示 home 校验通过：core 视角下的数据与预期一致。');
