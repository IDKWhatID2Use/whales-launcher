/**
 * QA 隔离探针：`stopInstance` 为什么慢/是否真杀掉了进程。
 * 运行：node tests/e2e/31-stop-probe.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadCoreBundle, makeTempRoot, sleep } from './_bundle.mjs';
import { seedStubEngine } from './_stub-engine.mjs';

const { core } = await loadCoreBundle();
const t0 = Date.now();
const log = (...args) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...args);

/* 0. 先确认 process.kill(pid,0) 在本沙箱里是否可信 */
{
  const selfAlive = (() => {
    try {
      process.kill(process.pid, 0);
      return 'alive';
    } catch (error) {
      return `throw ${error.code}`;
    }
  })();
  log('self process.kill(pid,0) →', selfAlive, '（可信则应为 alive）');
}

const root = await makeTempRoot('stop-probe');
await seedStubEngine(root);
const meta = await core.createInstance(root, {
  name: 'stop',
  dirName: 'stop-probe',
  engineVersion: '9.9.9',
  template: 'web',
});
log('实例已创建');

const res = await core.launchInstance(root, meta, { instanceId: meta.id }, { primaryHome: '' }, {
  onState: (s) => log('onState →', s.state, 'pid=' + s.pid),
  onExit: (code) => log('onExit →', code),
});
log('launchInstance 返回 pid=', res.pid);

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return `throw ${error.code}`;
  }
};
log('杀之前 isAlive(', res.pid, ') =', isAlive(res.pid));

/* 1. 直接从外部 taskkill，看退出码与效果 */
const tk = spawnSync('taskkill', ['/PID', String(res.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
log('直接 taskkill → status=', tk.status, 'error=', tk.error ? tk.error.code : null);
await sleep(800);
log('直接 taskkill 之后 isAlive =', isAlive(res.pid));
log('runtime =', JSON.stringify(core.runtimeOf(meta.id)));

/* 2. 再走一次完整 stopInstance，测量耗时 */
const stopStart = Date.now();
await core.stopInstance(meta.id);
log('stopInstance 耗时', Date.now() - stopStart, 'ms；runtime =', JSON.stringify(core.runtimeOf(meta.id)));
log('结束前 isAlive =', isAlive(res.pid));

/* 3. 强清场 */
if (isAlive(res.pid) === true) {
  spawnSync('taskkill', ['/PID', String(res.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  log('清场：已强杀', res.pid);
}
process.exit(0);
