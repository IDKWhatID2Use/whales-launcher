/**
 * 日志环形缓冲
 *
 * - 按实例归集 stdout / stderr / system 三路日志；
 * - 固定容量，超出丢弃最旧行并记录丢弃数（界面提示"较早日志已截断"）；
 * - 订阅回调经微批处理合并，日志洪峰下每轮事件循环只通知一次。
 */
import type { LogChunk } from '../../shared/contracts';
import { createBatcher } from '../util/batch';

export type LogStream = LogChunk['stream'];

export interface LogLine {
  seq: number;
  instanceId: string;
  stream: LogStream;
  text: string;
  ts: string;
}

/** 引擎安装等无实例归属的日志用空串 instanceId。 */
export const GLOBAL_LOG_ID = '';

/**
 * 启动器自身的伪实例 id（main 侧 `instanceId: 'launcher'` 的日志）。
 * 这类日志不属于任何实例，但**必须全局可见**：`launcher.json` 损坏自愈等提示
 * 只有它一条通道，按实例过滤时不能被隐藏。
 */
export const LAUNCHER_LOG_ID = 'launcher';

/** 判断一行日志是否属于某个过滤键（启动器级日志始终并入）。 */
function matchesKey(lineInstanceId: string, key: string | null): boolean {
  if (lineInstanceId === key) return true;
  return lineInstanceId === LAUNCHER_LOG_ID || lineInstanceId === GLOBAL_LOG_ID;
}

export class LogStore {
  readonly capacity: number;
  private lines: LogLine[] = [];
  private seq = 0;
  private dropped = 0;
  private readonly listeners = new Set<() => void>();
  private readonly notifyBatched = createBatcher(() => {
    for (const fn of this.listeners) fn();
  });

  constructor(capacity = 4000) {
    this.capacity = capacity;
  }

  push(chunk: LogChunk): void {
    const parts = chunk.text.split(/\r?\n/);
    for (const part of parts) {
      if (part.length === 0) continue;
      this.seq += 1;
      this.lines.push({
        seq: this.seq,
        instanceId: chunk.instanceId,
        stream: chunk.stream,
        text: part,
        ts: chunk.ts,
      });
    }
    if (this.lines.length > this.capacity) {
      const overflow = this.lines.length - this.capacity;
      this.lines.splice(0, overflow);
      this.dropped += overflow;
    }
    this.notifyBatched();
  }

  pushMany(chunks: readonly LogChunk[]): void {
    for (const chunk of chunks) {
      const parts = chunk.text.split(/\r?\n/);
      for (const part of parts) {
        if (part.length === 0) continue;
        this.seq += 1;
        this.lines.push({
          seq: this.seq,
          instanceId: chunk.instanceId,
          stream: chunk.stream,
          text: part,
          ts: chunk.ts,
        });
      }
    }
    if (this.lines.length > this.capacity) {
      const overflow = this.lines.length - this.capacity;
      this.lines.splice(0, overflow);
      this.dropped += overflow;
    }
    this.notifyBatched();
  }

  /** 清空；给定 instanceId 时只清该实例（`null` 表示只清全局日志）。 */
  clear(instanceId?: string | null): void {
    if (instanceId === undefined) {
      this.lines = [];
      this.dropped = 0;
    } else {
      const key = instanceId ?? GLOBAL_LOG_ID;
      this.lines = this.lines.filter((line) => line.instanceId !== key);
    }
    this.notifyBatched();
  }

  /** 快照（全部或指定实例）。 */
  snapshot(instanceId?: string | null): LogLine[] {
    if (instanceId === undefined) return this.lines.slice();
    return this.lines.filter((line) => matchesKey(line.instanceId, instanceId));
  }

  /** 取 seq 大于 afterSeq 的行（增量渲染用）。 */
  since(afterSeq: number, instanceId?: string | null): LogLine[] {
    const out: LogLine[] = [];
    for (const line of this.lines) {
      if (line.seq <= afterSeq) continue;
      if (instanceId !== undefined && !matchesKey(line.instanceId, instanceId)) continue;
      out.push(line);
    }
    return out;
  }

  count(instanceId?: string | null): number {
    if (instanceId === undefined) return this.lines.length;
    let n = 0;
    for (const line of this.lines) if (matchesKey(line.instanceId, instanceId)) n += 1;
    return n;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const logStore = new LogStore();
