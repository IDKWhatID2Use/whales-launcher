/**
 * 错误翻译层：把底层异常变成「用户能照着做」的中文提示。
 *
 * **内联自旧 Electron 主进程（`src` / `main`，本轮待拆除）的 `errors.ts`（135 行，逐字搬运，仅去掉 TS 类型标注）**。
 * 为什么不 `import` 它：旧主进程目录在本轮属于**待拆除的 Electron 主进程**，
 * 只要桥接层还引用其中任何文件，那个目录就不能删 —— 而用户验收标准要求
 * 「旧前端设计与代码已完全不被使用」。这两个文件的价值只是「错误文案表 + 翻译规则」，
 * 用内联换掉旧主进程目录的存活权是划算的。
 *
 * **搬运纪律**：消息文案**逐字不变**（`CODE_HINTS` / `PATTERN_HINTS` / 兜底文案 / 截断后缀）。
 * 这些文案会被 C# 侧 InfoBar 直接显示给用户，改一个字就是改产品行为。
 * 一致性由两重机械证据保证（见 `.probe/bridge/inline-diff.mjs`）：
 *  1. 与源文件的**中文字符串字面量多重集**逐项比对；
 *  2. 对全部错误码与全部特征模式做**运行时行为等价比对**。
 *
 * 未搬运的只有一个未被桥接层使用的导出：`fail()`（4 行，等价于 `throw new AppError(...)`）。
 */
// 冻结契约要求：所有跨边界调用返回 Result<T>，异常绝不穿透。
// 桥接层捕获到任何异常后都必须经 describeError() 转成可展示文案，
// 因此这里承担了「错误消息质量」的全部责任。

/** 消息可直接展示给用户的错误；前置校验时一律抛它。 */
export class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

/** 错误码 → 处置建议。 */
const CODE_HINTS = {
  ENOENT: '目标文件或目录不存在，请在界面上刷新后重试。',
  EACCES: '没有访问权限：请把启动器放在用户可写目录，或以管理员身份运行。',
  EPERM: '操作被系统拒绝（多为权限或占用问题），请先停止相关实例后重试。',
  ENOTEMPTY: '目录非空，无法直接替换；请先停止实例并清理残留文件。',
  EBUSY: '文件被其它进程占用，请先停止对应实例。',
  ENOSPC: '磁盘空间不足，请清理磁盘后重试。',
  EEXIST: '目标已存在，请换一个名字。',
  EISDIR: '期望的是文件，实际拿到的是目录。',
  ENOTDIR: '期望的是目录，实际拿到的是文件。',
  ETIMEDOUT: '连接超时，请检查网络或更换「设置 → 引擎源」。',
  ENOTFOUND: '域名解析失败，请检查网络或更换「设置 → 引擎源」。',
  EAI_AGAIN: 'DNS 暂时不可用，请稍后重试。',
  ECONNREFUSED: '目标主机拒绝连接，请检查网络与代理设置。',
  ECONNRESET: '连接被重置，请稍后重试。',
  EADDRINUSE: '端口被占用：请关闭占用该端口的程序，或在实例启动参数里换一个端口。',
  ERR_INVALID_ARG_TYPE: '传给底层接口的参数类型不正确（通常由损坏的实例元数据引起）。',
  ERR_PNPM_NO_MATCHING_VERSION: '该版本在引擎源上不存在，请刷新「可用版本」列表后重试。',
};

/** 消息里出现这些特征时追加的处置建议（错误码建议之后补充，最多两条）。 */
const PATTERN_HINTS = [
  [
    /StartupError/i,
    'dsh 启动自检失败；完整诊断见该实例 home/logs/startup-*.log。',
  ],
  [
    /ERR_PNPM|\bpnpm\b.*(not found|不是内部或外部命令|无法将)/i,
    'pnpm 执行失败。dsh 的插件管理依赖 pnpm，请先执行 npm i -g pnpm 安装后重试。',
  ],
  [
    /npm ERR!|registry\.npmjs\.org|ERR_SOCKET_TIMEOUT/i,
    'npm 安装失败：请检查网络连通性、代理设置，以及 npm 缓存目录是否可写（本启动器默认使用工作区内的 .npm-cache）。',
  ],
  [
    /cache.*(EPERM|EACCES|denied)|EPERM.*cache/i,
    'npm/pnpm 缓存目录不可写：请把缓存目录指到工作区内（例如 F:\\WhalesLauncher\\.npm-cache）后重试。',
  ],
  [
    // 必须限定在"profile 名被保留"的语境里：否则 C:\Users\x\Desktop\... 这类路径会误伤。
    /\bdesktop\b[^\n]{0,40}(is reserved|reserved|保留)|(reserved|保留)[^\n]{0,40}\bdesktop\b/i,
    '「desktop」是 dsh 保留给 Electron 宿主的 profile 名，请换一个实例名。',
  ],
  [
    /junction|symlink|符号链接/i,
    '创建链接失败：请确认目标目录存在；共享目录不可用时可先把实例模式切回「独立」。',
  ],
  [
    /spawn .* ENOENT|not recognized as an internal/i,
    '找不到可执行文件，请确认 Node.js（以及插件管理所需的 pnpm）已安装并存在于 PATH。',
  ],
];

/** 命中这些特征时，"错误码建议"会误伤，需要让位给更精确的提示。 */
const CODE_HINT_SUPPRESSORS = [/spawn .* ENOENT|not recognized as an internal/i];

/** 单条错误消息的展示上限，避免把整段 stderr 糊到界面上。 */
const MAX_LENGTH = 1200;

/**
 * 把任意异常翻译成一条可展示的中文错误消息。
 * @param {unknown} error 捕获到的任何东西（Error / 字符串 / 未知对象）
 * @param {string} fallback 完全无法提取信息时的兜底文案
 * @returns {string} 面向用户的中文文案。
 */
export function describeError(error, fallback = '操作失败，请稍后重试。') {
  if (error instanceof AppError) return clamp(error.message);

  const message = errorMessage(error, fallback);
  const code = errorCode(error);

  const hints = [];
  const suppressed = CODE_HINT_SUPPRESSORS.some((pattern) => pattern.test(message));
  const codeHint = code === undefined || suppressed ? undefined : CODE_HINTS[code];
  if (codeHint !== undefined) hints.push(codeHint);

  for (const [pattern, hint] of PATTERN_HINTS) {
    if (hints.length >= 2) break;
    if (pattern.test(message) && !hints.includes(hint)) hints.push(hint);
  }

  const withCode = code !== undefined && !message.includes(code) ? `${message}（${code}）` : message;
  return clamp(hints.length > 0 ? `${withCode}\n提示：${hints.join(' ')}` : withCode);
}

function errorMessage(error, fallback) {
  if (error instanceof Error) {
    const message = (error.message ?? '').trim();
    if (message.length > 0) return message;
    return error.name.trim().length > 0 ? error.name : fallback;
  }
  if (typeof error === 'string') {
    const message = error.trim();
    if (message.length > 0) return message;
    return fallback;
  }
  if (error === null || error === undefined) return fallback;
  try {
    return JSON.stringify(error) ?? fallback;
  } catch {
    return fallback;
  }
}

function errorCode(error) {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = error.code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : undefined;
}

function clamp(text) {
  if (text.length <= MAX_LENGTH) return text;
  return `${text.slice(0, MAX_LENGTH)}…（消息过长，已截断）`;
}
