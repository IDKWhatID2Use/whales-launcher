/**
 * 实例 / profile 命名规则（与 dsh 的 `resolveProfileDir` 校验一致）
 *
 * dsh 源码行为：名称为空、含 `/`、含 `\`、等于 `.`、`..`、`node_modules` 一律拒绝；
 * `desktop` 被保留给 Electron 宿主，CLI 同样拒绝。
 * 启动器在这一基础上再补充 Windows 文件名字符与长路径约束，避免"创建成功但启动失败"。
 */
export const FORBIDDEN_NAMES = ['.', '..', 'node_modules', 'desktop'] as const;

/** 实例名最大长度（兼顾 Windows 路径长度限制）。 */
export const NAME_MAX_LENGTH = 48;

/** 校验实例名；返回中文错误消息或 null（合法）。 */
export function validateInstanceName(raw: string): string | null {
  const name = raw;
  if (name.length === 0) return '实例名不能为空';
  if (name.trim().length === 0) return '实例名不能只有空格';
  if (name !== name.trim()) return '实例名首尾不能包含空格';
  if (name.includes('/') || name.includes('\\')) return '实例名不能包含 / 或 \\';
  if ((FORBIDDEN_NAMES as readonly string[]).includes(name)) {
    if (name === 'desktop') return 'desktop 已保留给桌面宿主，不能用作实例名';
    return `实例名不能是 ${name}`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return '实例名不能包含 < > : " | ? * 等字符';
  if (name.endsWith('.') || name.endsWith(' ')) return '实例名不能以点或空格结尾';
  if (name.length > NAME_MAX_LENGTH) return `实例名最长 ${NAME_MAX_LENGTH} 个字符`;
  return null;
}

/**
 * 由显示名推导目录名（**仅用于界面预览**）。
 * 真实目录名由 core 的 `makeDirName` 结合去重规则生成，以后端返回为准。
 */
export function previewDirName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"|?*\\/\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : 'instance';
}

/** profile 名（默认与目录名一致）。 */
export function validateProfileName(raw: string): string | null {
  if (raw.length === 0) return 'profile 名不能为空';
  if (raw !== raw.trim()) return 'profile 名首尾不能包含空格';
  return validateInstanceName(raw);
}
