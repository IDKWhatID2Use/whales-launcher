/**
 * `InstanceSummary.problem` 的运行时窄化读取
 *
 * 背景（QR-17）：core 为了修「坏记录凭空消失」的 P1，特意把异常实例**保留在列表里**：
 * `instance.json` 损坏 / 元数据被外部删除 / 目录被删除时，记录仍可被 id 解析、可删除，
 * 并通过字段 `problem` 给出可读原因。
 *
 * ⚠️ **契约已含该字段**（`InstanceSummary.problem?: string`，由 Lead 补齐），本文件
 * **不是**在补契约缺口 —— 它负责契约（类型层）表达不了的**运行时脏数据防护**：
 * 数据来自 IPC / 演示后端 / 桩，`problem` 可能是空串、纯空白或类型不符，这里统一
 * 窄化为 `string | null`，避免界面渲染出空徽标或空提示条。
 *
 * 渲染层**必须**消费它：否则 `present === true` 的坏记录会渲染成一张完全正常的卡片，
 * 用户点「启动」只得到一句底层报错，看不出原因（这正是 QA 报的 P2）。
 */
import type { InstanceSummary } from '../../shared/contracts';

/**
 * 读取降级标记（`problem`，契约字段）。
 *
 * 非字符串、空串、纯空白一律视为「无问题」——数据来自 IPC / 演示后端 / 桩，
 * 类型层保证不了运行时的脏值，这里统一窄化为 `string | null`，
 * 避免界面渲染出空徽标或空提示条。
 *
 * @param summary 任意来源的实例摘要。
 * @returns 可读的问题描述；无问题时为 `null`。
 */
export function problemOf(summary: InstanceSummary): string | null {
  const raw: unknown = summary.problem;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}
