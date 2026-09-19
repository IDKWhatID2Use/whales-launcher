/**
 * WhalesLauncher core —— 命名校验与目录名派生
 *
 * 校验规则**逐条复刻 dsh 源码**（`@deepseek-ai/dsh-app-boot` 的 `resolveProfileDir`，
 * 见 `docs/research/dsh-interface.md` §3.2）外加 `desktop` 保留名：
 *
 * ```js
 * if (name === "" || name.includes("/") || name.includes("\\") ||
 *     name === "." || name === ".." || name === "node_modules") throw ...
 * ```
 *
 * `desktop` 由 `lib/bin.js` 的 `rejectElectronProfile` 在 CLI 层拒绝（大小写不敏感）。
 * 本模块在此之上**只做更严格的补充**（Windows 非法字符、保留设备名、长度、首尾空白），
 * 目的是把"启动时才失败"提前到"创建时失败"，绝不放宽 dsh 本身的约束。
 */
import { FORBIDDEN_PROFILE_NAMES } from '../shared/contracts';

/** 实例目录名/profile 名长度上限（避免 Windows 长路径问题，见架构文档风险表）。 */
export const MAX_NAME_LENGTH = 64;

/** Windows 保留设备名（大小写不敏感，含带扩展名的形式）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** dsh 保留名（统一小写比较；Windows 文件系统大小写不敏感，必须按小写判重）。 */
const DSH_RESERVED = new Set(FORBIDDEN_PROFILE_NAMES.map((name) => name.toLowerCase()));

/**
 * 校验实例目录名 / dsh profile 名。
 *
 * @param name 待校验的名称。
 * @returns 合法返回 `null`，否则返回中文错误消息。
 */
export function validateName(name: string): string | null {
  if (typeof name !== 'string') return '名称必须是字符串';
  if (name.length === 0) return '名称不能为空';
  if (name.trim().length === 0) return '名称不能只包含空白字符';
  if (name.includes('/')) return '名称不能包含 "/"（dsh profile 名规则）';
  if (name.includes('\\')) return '名称不能包含 "\\"（dsh profile 名规则）';
  const lowered = name.toLowerCase();
  if (DSH_RESERVED.has(lowered)) {
    return `名称不能是 ${FORBIDDEN_PROFILE_NAMES.map((item) => `"${item}"`).join('、')}（dsh 保留名）`;
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(name)) return '名称不能包含 Windows 非法字符 < > : " | ? * 或控制字符';
  if (/[. ]$/.test(name)) return '名称不能以空格或点结尾（Windows 会静默截断）';
  if (name.length > MAX_NAME_LENGTH) return `名称长度不能超过 ${MAX_NAME_LENGTH} 个字符`;
  const device = lowered.split('.')[0] ?? lowered;
  if (WINDOWS_RESERVED.has(device)) return `名称不能是 Windows 保留设备名（如 ${device.toUpperCase()}）`;
  return null;
}

/** 判断名称是否是 Windows 保留设备名（`CON`、`COM1`…，带扩展名形式同样保留）。 */
function isWindowsReserved(name: string): boolean {
  const lowered = name.toLowerCase();
  return WINDOWS_RESERVED.has(lowered.split('.')[0] ?? lowered);
}

/**
 * 从显示名派生一个合法且未被占用的目录名。
 *
 * 规则：替换非法字符 → 折叠空白 → 去掉结尾的点/空格 → 避开 dsh 保留名 →
 * 截断到 {@link MAX_NAME_LENGTH} → 与 `taken` 冲突时追加 `-2`、`-3`…
 *
 * @param name 显示名（可含中文、空格、表情）。
 * @param taken 已被占用的目录名（大小写不敏感去重）。
 * @returns 可安全用作实例目录名与 dsh profile 名的字符串。
 */
export function makeDirName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((item) => item.toLowerCase()));
  const base = sanitizeBase(name);
  let candidate = base;
  let ordinal = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `-${ordinal++}`;
    candidate = `${trimTail(base.slice(0, MAX_NAME_LENGTH - suffix.length))}${suffix}`;
  }
  return candidate;
}

/** 归一化基准名（不含去重后缀）。 */
function sanitizeBase(name: string): string {
  let base = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  base = trimTail(base);
  if (base.length === 0) base = 'instance';
  if (DSH_RESERVED.has(base.toLowerCase()) || isWindowsReserved(base)) base = `${base}-instance`;
  base = trimTail(base.slice(0, MAX_NAME_LENGTH));
  if (base.length === 0) base = 'instance';
  return base;
}

/** 去掉结尾的点与空格，并在结果为空时回退。 */
function trimTail(value: string): string {
  const trimmed = value.replace(/[. ]+$/, '');
  return trimmed.length > 0 ? trimmed : '';
}
