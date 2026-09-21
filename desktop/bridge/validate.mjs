/**
 * 参数校验层 —— **等价搬运自旧主进程（`src` / `main`，本轮待拆除）的 `ipc.ts`**（该校验是唯一事实源）。
 *
 * 为什么不直接 `import` ipc.ts：它顶部 `import { BrowserWindow, app, dialog, ipcMain, shell }
 * from 'electron'`（ipc.ts L11），Node 侧车进程里没有 Electron。因此按协议 §5.2
 * 「抽出参数层再复用」的要求，把**纯校验函数**逐字搬到这里：
 *  - 错误消息一字不改（`${label}必须是字符串。` 这类文案是面向用户的既有契约）；
 *  - 白名单/枚举一字不减（例如 `PATCH_KEYS` 少一项会让用户的 workspace 改动报"不支持的字段"）；
 *  - 每个函数都标注来源行号，便于与 ipc.ts 逐行对账。
 *
 * 与 Electron 无关的错误翻译层（`AppError` / `describeError`）在 `errors.mjs` 里**内联**
 * （逐字搬运自旧主进程的 `errors.ts`）—— 不 import 旧目录，因为旧主进程目录本轮要整体拆除；
 * 文案一致性由 `.probe/bridge/inline-diff.mjs` 的两重机械证据保证。
 */
import { AppError } from './errors.mjs';

export { AppError };

/* ------------------------------------------------------------------ *
 * 基础标量校验（来源：旧主进程 ipc.ts L555-L589）
 * ------------------------------------------------------------------ */

/** 来源：ipc.ts L555-L560 */
export function mustRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${label}格式不正确（应为对象）。`);
  }
  return value;
}

/** 来源：ipc.ts L562-L572 */
export function mustString(value, label, options = {}) {
  if (typeof value !== 'string') throw new AppError(`${label}必须是字符串。`);
  if (options.allowEmpty === true) return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AppError(`${label}不能为空。`);
  return trimmed;
}

/** 来源：ipc.ts L574-L578 */
export function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(`${label}必须是字符串。`);
  return value;
}

/** 来源：ipc.ts L580-L584 */
export function mustBoolean(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError(`${label}必须是布尔值。`);
  return value;
}

/** 来源：ipc.ts L586-L589 */
export function mustStringArray(value, label) {
  if (!Array.isArray(value)) throw new AppError(`${label}必须是字符串数组。`);
  return value.map((item, index) => mustString(item, `${label}第 ${index + 1} 项`));
}

/* ------------------------------------------------------------------ *
 * 枚举与结构校验（来源：旧主进程 ipc.ts L591-L644）
 * ------------------------------------------------------------------ */

/**
 * 校验本地插件来源（renderer 只能给出契约里的三种形状之一）。
 * 来源：ipc.ts L600-L617（含 JSDoc「把 UNKNOWN 值挡在 core 之外」的原始理由）。
 */
export function mustPluginSource(value) {
  if (value === null || typeof value !== 'object') throw new AppError('插件来源格式错误。');
  const kind = value.kind;
  if (kind === 'archive') {
    const file = mustString(value.file, '插件压缩包路径');
    const name = optionalString(value.name, '插件名');
    return name === undefined ? { kind: 'archive', file } : { kind: 'archive', file, name };
  }
  if (kind === 'github') {
    const url = mustString(value.url, 'GitHub 地址');
    const ref = optionalString(value.ref, 'GitHub ref');
    return ref === undefined ? { kind: 'github', url } : { kind: 'github', url, ref };
  }
  if (kind === 'folder') {
    return { kind: 'folder', dir: mustString(value.dir, '插件文件夹路径') };
  }
  throw new AppError(`未知的插件来源：${JSON.stringify(kind)}（只支持 archive / github / folder）。`);
}

/** 来源：ipc.ts L619-L625 */
export function mustShareMode(value, label) {
  const mode = mustString(value, label);
  if (mode !== 'local' && mode !== 'shared') {
    throw new AppError(`${label}只能是 local（独立）或 shared（共享）。`);
  }
  return mode;
}

/** 来源：ipc.ts L627-L633 */
export function mustCredentialsMode(value, label) {
  const mode = mustString(value, label);
  if (mode !== 'inherit' && mode !== 'local') {
    throw new AppError(`${label}只能是 inherit（继承主 home）或 local（本实例独立）。`);
  }
  return mode;
}

/** 共享冲突的解决方向：只接受契约里的两个字面量，绝不把未知值传给 core。来源：ipc.ts L636-L644 */
export function mustShareConflictResolution(value) {
  const resolution = mustString(value, '冲突解决方式');
  if (resolution !== 'use-local' && resolution !== 'use-shared') {
    throw new AppError(
      `冲突解决方式只能是 use-local（以本地设置为准）或 use-shared（以共享设置为准），收到：${resolution}。`,
    );
  }
  return resolution;
}

/* ------------------------------------------------------------------ *
 * 复合入参（来源：旧主进程 ipc.ts L646-L743）
 * ------------------------------------------------------------------ */

/** 来源：ipc.ts L646-L680 */
export function parseCreateInput(raw) {
  const source = mustRecord(raw, '创建参数');
  const input = {
    name: mustString(source['name'], '实例名'),
    engineVersion: mustString(source['engineVersion'], '引擎版本'),
    template: mustString(source['template'], '模板'),
  };

  if (source['dirName'] !== undefined) input.dirName = optionalString(source['dirName'], '目录名');
  if (source['color'] !== undefined) input.color = mustString(source['color'], '颜色');
  if (source['note'] !== undefined) {
    if (typeof source['note'] !== 'string') throw new AppError('备注必须是字符串。');
    input.note = source['note'];
  }
  if (source['profileName'] !== undefined) {
    input.profileName = mustString(source['profileName'], 'profile 名');
  }
  if (source['icon'] !== undefined) {
    const icon = source['icon'];
    if (icon !== null && typeof icon !== 'string') throw new AppError('图标必须是字符串或 null。');
    input.icon = icon;
  }
  if (source['saves'] !== undefined) input.saves = mustShareMode(source['saves'], '存档模式');
  if (source['settings'] !== undefined) input.settings = mustShareMode(source['settings'], '设置模式');
  // 契约新增（Lead 批准的破冻结）：创建时即可选择工作区共享模式。
  // 不做这一步的话渲染层传来的 workspace 会被**静默丢弃**，用户的选择不生效且无任何提示。
  if (source['workspace'] !== undefined) {
    input.workspace = mustShareMode(source['workspace'], '工作区模式');
  }
  if (source['credentials'] !== undefined) {
    input.credentials = mustCredentialsMode(source['credentials'], '凭证模式');
  }

  return input;
}

/** 可更新字段的**严格白名单**。来源：ipc.ts L682-L694 */
export const PATCH_KEYS = new Set([
  'name',
  'icon',
  'color',
  'note',
  'engineVersion',
  'appArgs',
  'autoOpenBrowser',
  'saves',
  'settings',
  'workspace',
  'credentials',
]);

/** 来源：ipc.ts L696-L734 */
export function parseUpdatePatch(raw) {
  const source = mustRecord(raw, '更新参数');
  for (const key of Object.keys(source)) {
    if (!PATCH_KEYS.has(key)) throw new AppError(`不支持的更新字段：${key}。`);
  }

  const patch = {};
  if (source['name'] !== undefined) patch.name = mustString(source['name'], '实例名');
  if (source['color'] !== undefined) patch.color = mustString(source['color'], '颜色');
  if (source['engineVersion'] !== undefined) {
    patch.engineVersion = mustString(source['engineVersion'], '引擎版本');
  }
  if (source['appArgs'] !== undefined) patch.appArgs = mustStringArray(source['appArgs'], '启动参数');
  if (source['autoOpenBrowser'] !== undefined) {
    patch.autoOpenBrowser = mustBoolean(source['autoOpenBrowser'], '自动打开界面');
  }
  if (source['saves'] !== undefined) patch.saves = mustShareMode(source['saves'], '存档模式');
  if (source['settings'] !== undefined) patch.settings = mustShareMode(source['settings'], '设置模式');
  // 契约新增（Lead 批准的破冻结）：工作区共享模式可改。
  // 注意 PATCH_KEYS 是**严格白名单**：漏加这一项会让渲染层的 workspace 直接报
  // "不支持的更新字段"，用户看到的是一个莫名错误而不是功能不可用。
  if (source['workspace'] !== undefined) {
    patch.workspace = mustShareMode(source['workspace'], '工作区模式');
  }
  if (source['credentials'] !== undefined) {
    patch.credentials = mustCredentialsMode(source['credentials'], '凭证模式');
  }
  if (source['note'] !== undefined) {
    if (typeof source['note'] !== 'string') throw new AppError('备注必须是字符串。');
    patch.note = source['note'];
  }
  if (source['icon'] !== undefined) {
    const icon = source['icon'];
    if (icon !== null && typeof icon !== 'string') throw new AppError('图标必须是字符串或 null。');
    patch.icon = icon;
  }

  return patch;
}

/** 来源：ipc.ts L736-L743 */
export function parseLaunchRequest(raw) {
  const source = mustRecord(raw, '启动参数');
  const request = { instanceId: mustString(source['instanceId'], '实例 ID') };
  if (source['appArgs'] !== undefined) {
    request.appArgs = mustStringArray(source['appArgs'], '启动参数');
  }
  return request;
}

/* ------------------------------------------------------------------ *
 * 外链安全边界（来源：旧主进程 ipc.ts L523-L549）
 * ------------------------------------------------------------------ */

/**
 * 校验可交给系统浏览器打开的链接。
 *
 * 旧实现的硬边界：只放行 `http:` / `https:`（ipc.ts L526-L530）。协议 §3.3 进一步要求
 * **C# 侧独立再校验一次**，两侧都把关。
 * @param rawUrl 原始值（当未知数据处理）。
 * @returns 通过校验的原始 URL 字符串（与旧实现一致：不 trim 后再拼，而是用 trim 后的值）。
 * @throws {AppError} 非字符串 / 非法 URL / 非 http(s)。
 */
export function mustHttpUrl(rawUrl) {
  const url = mustString(rawUrl, '链接');
  const parsed = parseUrl(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      `出于安全考虑，只允许打开 http/https 链接（收到 ${parsed.protocol}//）。`,
    );
  }
  return url;
}

/** 来源：ipc.ts L538-L544 */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    throw new AppError(`链接格式不正确：${url}`);
  }
}

/* ------------------------------------------------------------------ *
 * 文件名清洗（来源：旧主进程 ipc.ts L546-L549）
 * ------------------------------------------------------------------ */

/** 来源：ipc.ts L546-L549。 */
export function sanitizeFileName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'instance';
}
