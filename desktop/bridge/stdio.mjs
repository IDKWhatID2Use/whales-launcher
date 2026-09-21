/**
 * NDJSON stdio 传输层 —— 协议 §1 的实现，外加 **stdout 协议保护**。
 *
 * 为什么独立成一个模块：ESM 的求值顺序 = import 声明顺序，`server.mjs` 的第一条
 * import 就是本模块。因此后续任何模块（含被 bundle 进来的 `src/core`）在初始化期调用
 * `console.log` 时，重定向**已经生效** —— 协议 §4 把「stdout 被污染」列为最常见的
 * 集成故障，这道闸门必须早于一切业务代码。
 *
 * 传输约定（协议 §1）：
 *  - 下行（Node → C#）：stdout，每行一个完整 JSON 对象 + `\n`；
 *  - 上行（C# → Node）：stdin，NDJSON。**容忍 CRLF 与首行 UTF-8 BOM** —— C# 的
 *    `StreamWriter` 默认写 `\r\n`、`new UTF8Encoding(true)` 会写 BOM，这是两端
 *    对接时最容易踩的细节；
 *  - 日志：stderr，人类可读文本，不参与协议。
 */
import { format } from 'node:util';

/* ------------------------------------------------------------------ *
 * ① stdout 协议保护
 * ------------------------------------------------------------------ */

/** 日志出口：一律写 stderr。 */
function toStderr(...args) {
  try {
    process.stderr.write(`${format(...args)}\n`);
  } catch {
    /* stderr 也不可用时只能放弃 —— 绝不允许把日志改道回 stdout */
  }
}

// console.log / info / debug 默认写 stdout，会直接破坏 NDJSON 流；一律改道 stderr。
// console.warn / console.error 本来就走 stderr，保持原样（保留其原有的格式化能力）。
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

// 下游（C#）提前退出会导致 EPIPE：写失败只记 stderr，绝不让进程因未捕获的 'error' 崩溃。
process.stdout.on('error', (error) => {
  toStderr(`[bridge] stdout 写入失败：${error?.message ?? String(error)}`);
});
// stderr 自身关闭（父进程已退出）时同样不要抛未捕获异常。
process.stderr.on('error', () => undefined);

/* ------------------------------------------------------------------ *
 * ② 下行：单写者队列（保证顺序 + 可 flush）
 * ------------------------------------------------------------------ */

/** 下行串行链：所有 writeLine 依次排队，顺序即调用顺序。 */
let outChain = Promise.resolve();

/**
 * 写入一行协议 JSON。
 *
 * 返回的 Promise 在该行**真正写入 stdout** 后 resolve；`server.mjs` 在退出前 await 它，
 * 避免 `process.exit()` 把最后一帧（通常是 `__shutdown` 的响应）截断。
 * @param {unknown} value 任意可 JSON 序列化的值。
 * @returns {Promise<void>} flush 完成。
 */
export function writeLine(value) {
  const text = `${JSON.stringify(value)}\n`;
  outChain = outChain.then(
    () => writeText(text),
    () => writeText(text),
  );
  return outChain;
}

/** 写一段文本（不校验协议形状）。永不 reject。 */
function writeText(text) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch (error) {
      toStderr(`[bridge] stdout 写入异常：${error?.message ?? String(error)}`);
      resolve();
    }
  });
}

/**
 * 等待已排队的下行数据全部 flush。
 * 带超时：下游不读时不能让退出流程永远挂住（stderr 会留下说明）。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @returns {Promise<boolean>} 是否在超时前 flush 完毕。
 */
export async function drainOut(timeoutMs = 2000) {
  const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  const done = await Promise.race([outChain.then(() => true), timer.then(() => false)]);
  return done === true;
}

/* ------------------------------------------------------------------ *
 * ③ 上行：NDJSON 分帧
 * ------------------------------------------------------------------ */

/** 协议 §1 的载荷上限：单行 8 MiB。 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 开始从 stdin 读取 NDJSON。
 *
 * 每个完整行**同步**交给 `onLine`（回调内部自行决定并发），因此读取不会被慢方法阻塞 ——
 * 这是协议 §3.4「允许并发」的前提。
 * @param {object} options 选项。
 * @param {(line: string) => void} options.onLine 收到一行（已去掉换行与 BOM）。
 * @param {(reason: string) => void} [options.onMalformed] 无法交付的行（超长/解析失败）。
 * @param {() => void} [options.onEnd] stdin 关闭（下游进程已退出）。
 * @param {number} [options.maxLineBytes] 单行上限，默认 {@link MAX_LINE_BYTES}。
 */
export function readLines({ onLine, onMalformed, onEnd, maxLineBytes = MAX_LINE_BYTES }) {
  process.stdin.setEncoding('utf8');

  let buffer = '';
  let first = true;
  /** 正在丢弃一条超长行（等待下一个换行作为分帧边界）。 */
  let discarding = false;

  const feed = (chunk) => {
    let text = chunk;
    if (first) {
      first = false;
      // C# 的 UTF8Encoding(true) 会在流首写 BOM；它不属于协议数据。
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    buffer += text;

    for (;;) {
      const index = buffer.indexOf('\n');
      if (discarding) {
        if (index < 0) {
          // 还没等到换行：继续丢弃，但别让缓冲区无限增长
          buffer = '';
          return;
        }
        buffer = buffer.slice(index + 1);
        discarding = false;
        continue;
      }
      if (index < 0) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1); // 容忍 CRLF
      if (line.trim().length === 0) continue; // 空行不参与协议
      onLine(line);
    }

    if (buffer.length > maxLineBytes) {
      onMalformed?.(`单行超过 ${maxLineBytes} 字节上限（协议 §1），已丢弃该行并等待下一个换行。`);
      buffer = '';
      discarding = true;
    }
  };

  process.stdin.on('data', feed);
  process.stdin.on('end', () => onEnd?.());
  process.stdin.on('close', () => onEnd?.());
  process.stdin.on('error', (error) => {
    toStderr(`[bridge] stdin 读取失败：${error?.message ?? String(error)}`);
    onEnd?.();
  });
}
