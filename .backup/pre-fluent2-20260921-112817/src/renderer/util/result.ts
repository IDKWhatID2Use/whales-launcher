/**
 * `Result<T>` 统一处理
 *
 * 契约规定所有 IPC 调用返回 `Result<T>` 且不抛异常；但渲染层仍要防御
 * "接口缺失 / preload 未注入 / 未来实现抛出"三种情况，因此这里统一兜底。
 */
import type { Result } from '../../shared/contracts';
import { toastError } from '../components/toast';

/** 把任意抛出物转成可读中文消息。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return '未知错误';
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 执行一次 IPC 调用：成功返回值，失败弹提示并返回 null。 */
export async function runAction<T>(promise: Promise<Result<T>>, label: string): Promise<T | null> {
  try {
    const result = await promise;
    if (result.ok) return result.value;
    toastError(`${label}失败`, { detail: result.error });
    return null;
  } catch (error) {
    toastError(`${label}失败`, { detail: describeError(error) });
    return null;
  }
}

/** 执行一次 IPC 调用但不提示（调用方自行处理错误）。 */
export async function attempt<T>(promise: Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 给一次后端调用加超时。
 *
 * 背景：`engine.available()` 之类的调用会去查 npm registry，网络慢时可能几十秒不返回。
 * 视图**绝不能**因为一个慢调用而无限停在加载态 —— 超时后按失败处理，让界面给出
 * 可读错误与重试入口。
 */
export function withTimeout<T>(promise: Promise<Result<T>>, ms: number, label: string): Promise<Result<T>> {
  let timer: number | undefined;
  const timeout = new Promise<Result<T>>((resolve) => {
    timer = window.setTimeout(
      () => resolve({ ok: false, error: `${label}超时（已等待 ${Math.round(ms / 1000)} 秒）` }),
      ms,
    );
  });
  return Promise.race([attempt(promise), timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

/** 从 Result 中取出错误消息（成功返回空串）。 */
export function errorOf<T>(result: Result<T>): string {
  return result.ok ? '' : result.error;
}
