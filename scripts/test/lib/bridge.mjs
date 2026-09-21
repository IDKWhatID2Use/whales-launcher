/**
 * 最小 NDJSON 桥接客户端（UI 测试专用）。
 *
 * 为什么不用 scripts/audit/bridge-smoke.mjs 里的客户端：那个实现内嵌在冒烟脚本里、
 * 背负着冒烟专用的断言与副作用（故意写坏的 launcher.json 等）。UI 测试只需要
 * 「在临时 home 上问几个读接口」，这里保持最小、无副作用。
 *
 * 用法：
 *   const bridge = await openBridge({ home, repoRoot });
 *   const instances = await bridge.call('instance:list');
 *   await bridge.close();
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * @param {{ home: string, repoRoot: string, timeoutMs?: number }} options
 */
export async function openBridge(options) {
  const repoRoot = options.repoRoot;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const entry = path.join(repoRoot, 'dist', 'bridge', 'server.cjs');

  const child = spawn(process.execPath, [entry, '--home', options.home], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let seq = 0;
  const pending = new Map();
  const stderrLines = [];

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    // 首帧可能带 UTF-8 BOM（C# StreamWriter 的默认形态）
    buffer = buffer.replace(/^\uFEFF/, '');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const slot = pending.get(message.id);
      if (!slot) continue;
      clearTimeout(slot.timer);
      pending.delete(message.id);
      slot.resolve(message);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrLines.push(chunk.toString('utf8').trim());
  });

  function request(method, params = []) {
    seq += 1;
    const id = `ui${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`桥接请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  const handshake = await request('__handshake');
  if (handshake?.ok !== true) {
    throw new Error(`桥接握手失败：${JSON.stringify(handshake)}`);
  }

  return {
    handshake: handshake.value,
    stderr: stderrLines,
    /**
     * 调用一个读接口；ok:false 时抛错（UI 测试的期望值必须来自真实后端，
     * 拿不到期望值就应该中止而不是编一个）。
     */
    async call(method, params = []) {
      const response = await request(method, params);
      if (response?.ok !== true) {
        throw new Error(`桥接调用失败 ${method}：${JSON.stringify(response?.error)}`);
      }
      return response.value;
    },
    async close() {
      try {
        child.stdin.end();
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          resolve();
        }, 2500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
