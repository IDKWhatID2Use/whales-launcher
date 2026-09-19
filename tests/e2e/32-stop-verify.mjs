/**
 * QA 复验：`stopInstance` 在 taskkill 被拒的环境下是否靠原生兜底真的结束了进程。
 *
 * 背景：`src/main/runtime.ts` 与 `src/core/proc.ts` 现均有 `process.kill(pid,'SIGKILL')`
 * 兜底。本沙箱 taskkill 返回 Access denied，因此这是检验兜底路径的天然环境。
 *
 * 运行：node tests/e2e/32-stop-verify.mjs
 */
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, sleep } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const { core } = await loadCoreBundle();
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` —— ${detail}` : ''}`);
};

/**
 * 说明：本沙箱下 `tasklist` / `taskkill` 均被拒绝（taskkill 返回 Access denied，
 * tasklist 输出为空），无法用系统工具独立核对进程存活。因此改用**决定性的间接证据**：
 *  - 修复前：taskkill 被拒且无原生兜底 → `handle.exited` 永不 resolve → stopInstance
 *    必然走满 15s+5s 超时，并写入 `lastError="停止超时，已强制结束进程树"`（实测 20077ms）。
 *  - 修复后：若进程被真正结束，`'close'` 事件会正常触发 → stopInstance 在**毫秒级**返回
 *    且 `lastError` 为 `null`。
 * 这两者在"进程是否真的死了"上给出相反的观测，因此耗时与 lastError 足以判定。
 */
const root = await makeTempRoot('stop-verify');
await seedStubEngine(root);
const meta = await core.createInstance(root, {
  name: 'sv',
  dirName: 'sv',
  engineVersion: '9.9.9',
  template: 'web',
});
const { pid } = await core.launchInstance(root, meta, { instanceId: meta.id }, { primaryHome: '' }, {});
await sleep(1200);
console.log(`  [info] 启动 pid=${pid}`);

const t0 = Date.now();
await core.stopInstance(meta.id);
const elapsed = Date.now() - t0;
const runtime = core.runtimeOf(meta.id);
record(
  '1 stopInstance 在毫秒级完成（说明子进程的 close 事件被正常触发）',
  elapsed < 3000,
  `耗时 ${elapsed}ms（修复前为 20077ms，走满 15s+5s 超时兜底）`,
);
record(
  '2 stopInstance 未把失败伪装成成功（lastError 为空即代表干净退出）',
  runtime.state === 'stopped' && runtime.lastError === null,
  `状态=${runtime.state} lastError=${JSON.stringify(runtime.lastError)}（修复前为 "停止超时，已强制结束进程树"）`,
);
record(
  '3 停止后 PID 已归还（不再指向该实例）',
  runtime.pid === null,
  `pid=${runtime.pid}`,
);

console.log('\n=== stopInstance 复验汇总 ===');
const failed = results.filter((r) => !r.ok);
console.log(`共 ${results.length} 例，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name}：${item.detail ?? ''}`);
