/**
 * WhalesLauncher 接口契约 —— **冻结文件（唯一事实源）**
 *
 * 主进程、preload、renderer 与 core 引擎全部依赖本文件。
 * 任何一方需要改动这里的类型/通道，必须先通知 Lead，不得单方面修改。
 *
 * 约定：
 *  - 所有跨 IPC 的调用返回 `Result<T>`，绝不抛异常穿透 IPC 边界。
 *  - 所有路径均为 Windows 绝对路径字符串。
 *  - 时间一律 ISO 8601 字符串。
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 基础
 * ------------------------------------------------------------------ */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: string): Result<never> => ({ ok: false, error });

/** 资源是否与其它实例共享（对应 PCL2 的版本隔离开关）。 */
export type ShareMode = 'local' | 'shared';
/** 凭证策略：继承主 home，或本实例独立。 */
export type CredentialsMode = 'inherit' | 'local';

/* ------------------------------------------------------------------ *
 * 实例
 * ------------------------------------------------------------------ */

export interface InstanceMeta {
  schemaVersion: number;
  /** 稳定标识，重命名/移动不变。 */
  id: string;
  /** 显示名，可含中文与空格。 */
  name: string;
  /** 目录名，同时用作 dsh profile 名；必须通过 dsh 的 profile 名校验。 */
  dirName: string;
  /** emoji 或 null。 */
  icon: string | null;
  /** 主题强调色，形如 `#5B8DEF`。 */
  color: string;
  note: string;
  engine: {
    /** 绑定的 dsh 引擎版本，如 `0.1.6-alpha.2`。 */
    version: string;
  };
  profile: {
    /** profile 名（`$DSH_HOME/profiles/<name>`）。 */
    name: string;
    /** 创建时使用的随附模板，如 `web`。 */
    template: string;
  };
  workspace: { mode: ShareMode };
  saves: { mode: ShareMode };
  settings: { mode: ShareMode };
  credentials: { mode: CredentialsMode };
  launch: {
    /** 追加给 dsh 应用层的参数（CLI 第一个无法识别 token 起）。 */
    appArgs: string[];
    /** web profile 启动后是否自动打开界面。 */
    autoOpenBrowser: boolean;
  };
  createdAt: string;
  lastLaunchedAt: string | null;
  launchCount: number;
}

/** 新建实例的入参。 */
export interface CreateInstanceInput {
  name: string;
  /** 省略时由 Lead 侧的 `makeDirName` 从 name 派生并去重。 */
  dirName?: string;
  icon?: string | null;
  color?: string;
  note?: string;
  engineVersion: string;
  /** dsh 随附模板名：`web` | `headless` | `sdk` | `sdk-minimal` | `acp`。 */
  template: string;
  profileName?: string;
  saves?: ShareMode;
  settings?: ShareMode;
  /** 工作区隔离策略：`shared` 时 junction 到 `shared/workspaces/<dirName>`。 */
  workspace?: ShareMode;
  credentials?: CredentialsMode;
}

/** 可更新的字段子集。 */
export type UpdateInstancePatch = Partial<
  Pick<
    InstanceMeta,
    'name' | 'icon' | 'color' | 'note'
  >
> & {
  engineVersion?: string;
  appArgs?: string[];
  autoOpenBrowser?: boolean;
  saves?: ShareMode;
  settings?: ShareMode;
  /** 工作区隔离策略（架构文档 §4.3 的 4 个隔离维度之一）。 */
  workspace?: ShareMode;
  credentials?: CredentialsMode;
};

/** 实例运行时状态。 */
export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface InstanceRuntime {
  instanceId: string;
  state: InstanceState;
  /** 进程 PID，未运行时为 null。 */
  pid: number | null;
  startedAt: string | null;
  /** web profile 探测到的界面地址。 */
  url: string | null;
  /**
   * 本实例**实际**使用的监听端口。
   *
   * 启动中先填入分配决策给出的端口；dsh 打印界面地址后再由真实端口覆盖
   * （`--port 0` 交内核分配时，只有回读才知道端口号）。非 Web 界面时为 `null`。
   */
  port: number | null;
  /** 最近一次退出码。 */
  exitCode: number | null;
  /** 最近一次启动失败的摘要。 */
  lastError: string | null;
}

/** 列表用的聚合视图。 */
export interface InstanceSummary {
  meta: InstanceMeta;
  runtime: InstanceRuntime;
  /** 目录是否真实存在。 */
  present: boolean;
  /** 引擎版本是否已在本地安装。 */
  engineInstalled: boolean;
  /** 插件数量（dependencies 条目数）。 */
  pluginCount: number;
  /**
   * 异常态说明 —— core 的「降级呈现」机制。
   *
   * 当 `instance.json` 损坏、或实例目录被外部删除/改名时，记录**仍会出现在列表里**
   * 并带上这条说明（而不是被丢弃，那会让用户觉得"实例凭空消失"）。
   * 界面**必须**把它显示出来，否则用户看到的是"一张完全正常的卡片，却怎么都启动不了"。
   */
  problem?: string;
}

/* ------------------------------------------------------------------ *
 * 引擎版本
 * ------------------------------------------------------------------ */

export interface EngineInfo {
  version: string;
  /** 引擎目录绝对路径。 */
  dir: string;
  installed: boolean;
  /** dsh 主入口绝对路径，未安装为 null。 */
  binPath: string | null;
  /** 占用该引擎的实例 id 列表。 */
  usedBy: string[];
  sizeBytes: number | null;
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

/** 组合包（bundle）：参与配置树组合的插件包。 */
export interface BundleEntry {
  name: string;
  enabled: boolean;
  description: string | null;
  /** 版本号，来自 dependencies 或 null。 */
  version: string | null;
  /** 是否随 dsh 安装提供（内置组合包）。 */
  builtin: boolean;
}

/** 普通插件依赖。 */
export interface PluginEntry {
  name: string;
  version: string | null;
  /** 在 node_modules 中是否真实存在。 */
  installed: boolean;
  /**
   * profile `dependencies` 里的原始规格（如 `link:D:\dev\x`、`file:../../plugins/x`、`github:o/r`）。
   *
   * 界面靠它区分「随实例搬运的相对 file:」与「指向本机绝对路径的 link:」，
   * 因此**不能**用 node_modules 里读到的版本号代替。
   */
  spec: string | null;
}

export interface PluginInventory {
  bundles: BundleEntry[];
  dependencies: PluginEntry[];
  /** profile 目录绝对路径。 */
  profileDir: string;
}

/**
 * 「随实例搬运」的插件来源。
 *
 * 三种来源最终都落到实例目录内的 `home/plugins/<name>`，profile 里只留**相对路径**
 * 依赖 —— 于是整个实例目录可以像整合包一样复制到别处，插件不会丢。
 */
export type PluginSource =
  | {
      kind: 'archive';
      /** 插件 zip 绝对路径。 */
      file: string;
      /** 期望的插件名（可空，空则取包内 `package.json` 的 name）。 */
      name?: string;
    }
  | {
      kind: 'github';
      /**
       * GitHub 仓库地址或简写。支持：
       * - `https://github.com/owner/repo`（可带 `/tree/<ref>` 或 `#<ref>`）
       * - `git@github.com:owner/repo.git`
       * - `owner/repo`、`owner/repo#v1.2.3`
       */
      url: string;
      /** 已解析的 ref（分支/标签/提交），可空。 */
      ref?: string;
    }
  | {
      kind: 'folder';
      /** 本地插件目录绝对路径（含 `package.json`）。 */
      dir: string;
    };

/** 本地插件在实例内的落点与启用状态。 */
export interface PluginSummary {
  name: string;
  version: string | null;
  /** 实例内插件目录绝对路径（`home/plugins/<name>`）。 */
  dir: string;
  /** 来源：zip 包 / GitHub 仓库 / 本地文件夹 / 手工放入 / 来源标记损坏。 */
  origin: 'archive' | 'github' | 'folder' | 'manual' | 'unknown';
  /**
   * 是否被 profile 的 `dsh.profile.bundles` 收录。
   *
   * `false` 表示它已作为普通依赖安装，但**不会**参与配置树组合 —— 典型情况是
   * 包内没有声明 `dsh.bundle.patch`（纯客户端插件），或用户手动停用了它。
   */
  enabled: boolean;
  /** 包内是否声明了 `dsh.bundle.patch`。 */
  hasBundlePatch: boolean;
  /** 包内是否声明了 `dsh.client`（有 Web 界面部分）。 */
  hasClient: boolean;
  /** 来自包内 `package.json` 的 description（可空）。 */
  description: string | null;
  /** `dsh.bundle.patch` 指向的文件在包内是否存在。 */
  patchFileExists: boolean;
  /** 依赖规格（相对 `file:` 或 `link:`），用于识别外部引用。 */
  spec: string | null;
  /**
   * 是否由启动器安装（`.whales-plugins.json` 账本里有记录）。
   *
   * 界面据此对「启动器亲自装过」的插件给出明确状态：第三方自检（例如插件市场装完
   * 自己再验证一遍）可能报失败，但账本 + 文件系统的事实说明它已就位。
   */
  installedByLauncher?: boolean;
  /** 账本记录：来源类型与来源标识（zip 路径 / GitHub 地址 / 源目录）。 */
  installedVia?: { kind: string; source: string | null; at: string } | null;
}

/**
 * pnpm 拒绝执行 git 依赖的 `prepare` 构建脚本时抛出的错误。
 *
 * 单独成类而不是丢一句字符串：调用方（GitHub 来源的安装流程）要据此**自动**
 * 往 profile 的 `pnpm-workspace.yaml` 写入 `allowBuilds` 并重试一次，
 * 而不是把「自己去读 pnpm 提示、自己找配置文件」丢给用户。
 */
export class AllowBuildsError extends Error {
  /**
   * pnpm / dsh 的原始输出，供上层提取包名。
   *
   * 注意：契约文件会被 Node 直接做**类型擦除**执行（测试直跑 `src/**`），
   * 因此这里不能用「构造函数参数属性」这类需要编译的语法，只能显式声明 + 赋值。
   */
  readonly output: string;

  /**
   * @param message 面向用户的错误消息（含 pnpm 的原始输出）。
   * @param output pnpm/dsh 的原始输出。
   */
  constructor(message: string, output: string) {
    super(message);
    this.name = 'AllowBuildsError';
    this.output = output;
  }
}

/** 一次本地插件安装的结果。 */export interface PluginInstallResult {
  name: string;
  version: string | null;
  /** 落盘后的插件目录（`home/plugins/<name>`）。 */
  dir: string;
  /** 写入 profile 依赖项的规格，如 `file:../../plugins/<name>`。 */
  spec: string;
  /** 是否已加入 `dsh.profile.bundles`。 */
  registeredBundle: boolean;
  /** 依赖是否已链接进 `node_modules`。 */
  linked: boolean;
  inventory: PluginInventory;
  /** 非致命提示（如「包内没有 bundle patch，将以普通依赖安装」）。 */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 会话 / 存档
 * ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string;
  /** 会话最后修改时间。 */
  updatedAt: string;
  /** 会话目录绝对路径。 */
  dir: string;
  /** 归属的 workspace 编码目录名。 */
  workspaceKey: string;
  sizeBytes: number | null;
}

/* ------------------------------------------------------------------ *
 * 启动 / 日志
 * ------------------------------------------------------------------ */

export interface LaunchRequest {
  instanceId: string;
  /** 一次性覆盖参数，不写回 instance.json。 */
  appArgs?: string[];
}

export interface LaunchResult {
  pid: number;
  /** 实际使用的 DSH_HOME。 */
  dshHome: string;
  /** 实际使用的工作目录。 */
  cwd: string;
}

export interface LogChunk {
  instanceId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  ts: string;
}

/* ------------------------------------------------------------------ *
 * 自动端口分配（`core/ports.ts`）
 * ------------------------------------------------------------------ */

/** 期望端口的来源（优先级即此顺序）。 */
export type PortSource = 'explicit' | 'ledger' | 'auto' | 'os';

/** 一次端口分配决策（同时用于日志、运行时状态与界面展示）。 */
export interface PortDecision {
  /**
   * 交给 dsh 的 `--port` 值。
   * `0` 表示交操作系统分配（区间耗尽时的兜底，保证实例一定起得来）。
   */
  port: number;
  /** 期望端口（发生避让前想用的那个）；无期望时为 `null`。 */
  desired: number | null;
  /** 期望端口是否因被占用/不可用而发生避让。 */
  avoided: boolean;
  /** 期望端口的来源。 */
  source: PortSource;
  /** 中文说明，直接进实例日志与界面。 */
  reason: string;
}

/** 端口台账中的一条记录。 */
export interface PortRecord {
  /** 最近一次看到的实例显示名（仅供人工阅读台账）。 */
  name: string;
  /** 该实例的首选端口：稳定，不随避让改变，下次启动优先复用它。 */
  preferred: number;
  /** 最近一次实际分配到的端口。 */
  last: number;
  /** 最近一次拿到的进程 PID；未运行或已退出为 `null`。 */
  pid: number | null;
  /** 最后更新时间（ISO 8601）。 */
  updatedAt: string;
}

/**
 * 跨进程端口台账（`<root>/cache/ports.json`）。
 *
 * 台账用于**持久化期望端口**与**留审计记录**，本身不是互斥手段
 * （读改写做不到原子）；互斥由进程内预留集与操作系统绑定探测保证。
 */
export interface PortLedger {
  schemaVersion: number;
  allocations: Record<string, PortRecord>;
  /** 曾被 dsh 以 EADDRINUSE 拒绝过的端口 → 记录时间（短 TTL 内不再优先选用）。 */
  failures: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * 全局配置
 * ------------------------------------------------------------------ */

export interface LauncherConfig {
  schemaVersion: number;
  /** 用于凭证继承的"主 home"（通常是 `~/.dsh`）。 */
  primaryHome: string;
  theme: 'dark' | 'light';
  lastInstanceId: string | null;
  confirmOnDelete: boolean;
  /** 引擎安装用的 npm registry。 */
  engineRegistry: string;
  /**
   * 运行 dsh 引擎所用的 Node.js 可执行文件（绝对路径）。
   *
   * `null` = 自动探测（环境变量 `WHALES_NODE_PATH` → 启动器自身 → 系统 PATH → 常见安装位置）。
   * 之所以可配：dsh 依赖的原生模块**拒绝 Electron 内置运行时**，必须用独立的 Node.js；
   * 当 Node 不在 PATH 上（或装了多个版本）时，用户需要一个显式出口。
   */
  nodePath: string | null;
  /** 启动器根目录（只读，由 main 注入）。 */
  rootDir?: string;
}

/* ------------------------------------------------------------------ *
 * Node 运行时（dsh 引擎的执行环境）
 * ------------------------------------------------------------------ */

/** Node 运行时的来源（顺序即解析优先级）。 */
export type NodeRuntimeSource = 'env' | 'config' | 'current' | 'path' | 'portable' | 'common';

/** 单个候选运行时的探测结论。 */
export interface NodeRuntimeCandidate {
  /** 候选可执行文件路径。 */
  file: string;
  /** 该候选的来源。 */
  source: NodeRuntimeSource;
  /** 是否可用于运行 dsh。 */
  ok: boolean;
  /** 探测到的 Node 版本（失败时为 null）。 */
  version: string | null;
  /** 探测到的 Electron 版本（只有 Electron 宿主才有值）。 */
  electron: string | null;
  /** 不可用原因（中文；可用时为 null）。 */
  reason: string | null;
}

/**
 * Node 运行时解析报告。
 *
 * 由 core 实际执行探针后得出（绝不按路径名猜测），可在界面直接展示：
 * `ok=false` 时 `candidates` 里每条都带中文失败原因，用户据此知道"为什么不能用"。
 */
export interface NodeRuntimeReport {
  /** 是否找到可用的 Node.js。 */
  ok: boolean;
  /** 最终采用的绝对路径（失败时为 null）。 */
  file: string | null;
  /** 采用的 Node 版本（如 `26.3.0`）。 */
  version: string | null;
  /** 采用的来源。 */
  source: NodeRuntimeSource | null;
  /** 全部候选与结论。 */
  candidates: NodeRuntimeCandidate[];
  /** 面向用户的一句话结论。 */
  message: string;
}

/* ------------------------------------------------------------------ *
 * 环境与依赖自检（preflight）
 *
 * 首次启动与「全局设置 → 环境自检」共用同一份实现（`src/core/preflight.ts`）：
 * 缺目录就建、缺引擎就装，装不了的把原因与下一步如实写进 `advice`。
 * 报告刻意**不含"环境正常"这类断言**，只说检查了什么、修了什么、还剩什么。
 * ------------------------------------------------------------------ */

/** 单项检查的结论。 */
export type PreflightStatus =
  /** 通过。 */
  | 'ok'
  /** 原本缺失/异常，本次已自动修复。 */
  | 'fixed'
  /** 缺失且（按当前选项）没有自动修复。 */
  | 'missing'
  /** 检查本身失败（例如枚举引擎时目录不可读）。 */
  | 'failed'
  /** 按选项跳过（例：未开启联网探测）。 */
  | 'skipped';

/** 单项检查结果。 */
export interface PreflightCheck {
  /** 稳定标识：`runtime-dirs` / `config` / `node` / `npm` / `engine` / `network`。 */
  id: string;
  /** 中文标题（界面直接显示）。 */
  title: string;
  status: PreflightStatus;
  /** 一句话结论。 */
  summary: string;
  /** 细节（路径、版本、候选清单等，可多行）；无细节为 null。 */
  detail: string | null;
  /** 需要用户处理时给出的下一步建议；否则为 null。 */
  advice: string | null;
  /** 是否由本次自检自动完成修复。 */
  autoFixed: boolean;
  /** 自动修复产出的版本号（目前仅引擎自动安装会填）；无则为 null。 */
  fixedValue: string | null;
}

/**
 * 自检选项。
 *
 * 默认值是**保守的**：只有 `autoFix`（建目录这类纯本地动作）默认开启，
 * 联网类动作（装引擎、探测 registry）必须由调用方显式打开 ——
 * 界面上「环境自检」按钮不该顺手产生几分钟的下载（视觉规范 §9.9：本页避免网络副作用）。
 */
export interface PreflightOptions {
  /** 允许自动修复（创建数据目录等）。默认 `true`。 */
  autoFix?: boolean;
  /** 允许自动安装缺失的 dsh 引擎（联网，首次可能数分钟）。默认 `false`。 */
  installEngine?: boolean;
  /** 是否探测 npm registry 连通性。默认 `false`。 */
  checkNetwork?: boolean;
  /** 忽略 Node 运行时探测缓存重新探测。默认 `false`。 */
  refreshRuntime?: boolean;
  /** 覆盖 npm registry（不传则读全局配置，再退回内置默认值）。 */
  registry?: string;
}

/** 一次完整自检的结果。 */
export interface PreflightReport {
  /** 是否为首次自检（此前没有自检状态文件）。 */
  firstRun: boolean;
  /** 开始时刻（ISO 8601）。 */
  startedAt: string;
  /** 结束时刻（ISO 8601）。 */
  finishedAt: string;
  /** 总耗时（毫秒）。 */
  elapsedMs: number;
  /** 被检查的启动器根目录。 */
  root: string;
  /** 依次执行的检查项（顺序稳定，界面按此顺序渲染）。 */
  checks: PreflightCheck[];
  /** 是否**没有遗留问题**（已自动修复的算通过）。 */
  ok: boolean;
  /** 本次自动修复的项数。 */
  fixedCount: number;
  /** 遗留问题项数（`missing` + `failed`）。 */
  problemCount: number;
  /** 本次自动安装的引擎版本；没装则为 null。 */
  installedEngineVersion: string | null;
  /** 面向用户的一句话结论。 */
  message: string;
}

/* ------------------------------------------------------------------ *
 * 资源包（导入导出）
 * ------------------------------------------------------------------ */

export interface PackManifest {
  schemaVersion: number;
  kind: 'whalelauncher-pack';
  exportedAt: string;
  launcherVersion: string;
  instance: Pick<
    InstanceMeta,
    'name' | 'icon' | 'color' | 'note' | 'engine' | 'profile' | 'launch'
  >;
  /** 需要重装的依赖包名与版本范围。 */
  requirements: Record<string, string>;
  bundles: string[];
}

export interface ImportResult {
  instanceId: string;
  name: string;
  /** 重装依赖时的警告（不阻断导入）。 */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 共享资源冲突
 * ------------------------------------------------------------------ */

/** 冲突的解决方向。 */
export type ShareConflictResolution = 'use-local' | 'use-shared';

/**
 * 共享资源冲突记录。
 *
 * 当实例切到共享模式、而本地与共享**都有内容且不同**时，core 会**保留本地并登记一条冲突**，
 * 而不是静默覆盖任何一边（这是曾经的 P1 数据丢失缺陷的修复结果）。
 * 界面必须把这条记录显示出来并让用户显式选择方向，否则问题会从"静默丢数据"变成"静默不生效"。
 */
export interface ShareConflict {
  instanceId: string;
  /** 目前只有设置会产生冲突。 */
  resource: 'settings';
  /** 冲突时保留的一侧，恒为 `local`。 */
  kept: 'local';
  localFile: string;
  sharedFile: string;
  /** core 生成的、可直接展示给用户的说明。 */
  message: string;
}

/* ------------------------------------------------------------------ *
 * 菜单（主进程为唯一事实源，渲染层只负责呈现）
 * ------------------------------------------------------------------ */

/**
 * 菜单树节点。
 *
 * 由主进程的 `menuSpec()` 投影而来 —— 菜单项的 `id`、`label`、`accelerator`
 * 与实际按键绑定同源，渲染层的自绘菜单只是它的视图，不得自行维护第二份定义。
 * 否则菜单里显示的快捷键会和真实绑定漂移。
 */
export interface MenuNode {
  id: string;
  label: string;
  /** 展示用的快捷键文本，如 `Ctrl+R`。 */
  accelerator?: string;
  /** 分隔线或分组标题。 */
  kind?: 'separator' | 'header';
  enabled?: boolean;
  children?: MenuNode[];
}

/* ------------------------------------------------------------------ *
 * IPC 通道表 —— main 必须逐条实现，preload 必须逐条暴露
 * ------------------------------------------------------------------ */

export const CH = {
  launcher: {
    getConfig: 'launcher:getConfig',
    setConfig: 'launcher:setConfig',
    /** 探测运行 dsh 所需的 Node 运行时（`refresh=true` 时重新探测，忽略缓存）。 */
    detectNode: 'launcher:detectNode',
    /**
     * 环境与依赖自检（首次启动与设置页共用）。
     *
     * 参数：`[options?: PreflightOptions]`；返回 {@link PreflightReport}。
     * 只在 `options.installEngine === true` 时才会联网安装引擎，因此该调用可能长达数分钟，
     * 调用方必须给足超时（C# 侧见 `SettingsPage` 与启动编排处的超时设置）。
     */
    preflight: 'launcher:preflight',
  },
  instance: {
    list: 'instance:list',
    create: 'instance:create',
    get: 'instance:get',
    update: 'instance:update',
    remove: 'instance:remove',
    launch: 'instance:launch',
    stop: 'instance:stop',
    openFolder: 'instance:openFolder',
  },
  engine: {
    list: 'engine:list',
    available: 'engine:available',
    install: 'engine:install',
    remove: 'engine:remove',
  },
  plugin: {
    inventory: 'plugin:inventory',
    add: 'plugin:add',
    remove: 'plugin:remove',
    setBundleEnabled: 'plugin:setBundleEnabled',
    /** 安装「随实例搬运」的本地插件（zip / GitHub / 文件夹）。 */
    install: 'plugin:install',
    /** 从实例内删除一个本地插件。 */
    removeLocal: 'plugin:removeLocal',
    /** 列出实例内的本地插件（`home/plugins`）。 */
    listLocal: 'plugin:listLocal',
    /** 选择插件压缩包（zip）。 */
    pickArchive: 'plugin:pickArchive',
    /** 选择插件文件夹。 */
    pickFolder: 'plugin:pickFolder',
  },
  settings: {
    read: 'settings:read',
    write: 'settings:write',
    shareConflicts: 'settings:shareConflicts',
    resolveShareConflict: 'settings:resolveShareConflict',
  },
  saves: {
    list: 'saves:list',
    openFolder: 'saves:openFolder',
  },
  pack: {
    export: 'pack:export',
    import: 'pack:import',
    pickFile: 'pack:pickFile',
  },
  log: {
    /** main → renderer 推送，无需 invoke。 */
    chunk: 'log:chunk',
    state: 'log:state',
  },
  app: {
    version: 'app:version',
    openExternal: 'app:openExternal',
    menu: 'app:menu',
    menuCommand: 'app:menuCommand',
  },
} as const;

/**
 * preload 通过 `contextBridge` 暴露给 renderer 的 API 形状。
 * renderer 只允许访问 `window.whales`。
 */
export interface WhalesApi {
  launcher: {
    getConfig(): Promise<Result<LauncherConfig>>;
    setConfig(patch: Partial<LauncherConfig>): Promise<Result<LauncherConfig>>;
    /** 探测运行 dsh 的 Node 运行时（`refresh` 为 true 时忽略缓存重新探测）。 */
    detectNode(refresh?: boolean): Promise<Result<NodeRuntimeReport>>;
    /** 环境与依赖自检；`installEngine` 为 true 时会联网自动安装缺失的引擎（可能数分钟）。 */
    preflight(options?: PreflightOptions): Promise<Result<PreflightReport>>;
  };
  instance: {
    list(): Promise<Result<InstanceSummary[]>>;
    create(input: CreateInstanceInput): Promise<Result<InstanceSummary>>;
    get(id: string): Promise<Result<InstanceSummary>>;
    update(id: string, patch: UpdateInstancePatch): Promise<Result<InstanceSummary>>;
    remove(id: string, deleteFiles: boolean): Promise<Result<void>>;
    launch(req: LaunchRequest): Promise<Result<LaunchResult>>;
    stop(id: string): Promise<Result<void>>;
    openFolder(id: string, which: 'root' | 'home' | 'workspace' | 'logs' | 'plugins'): Promise<Result<void>>;
  };
  engine: {
    list(): Promise<Result<EngineInfo[]>>;
    available(): Promise<Result<string[]>>;
    install(version: string): Promise<Result<EngineInfo>>;
    remove(version: string): Promise<Result<void>>;
  };
  plugin: {
    inventory(instanceId: string): Promise<Result<PluginInventory>>;
    add(instanceId: string, spec: string): Promise<Result<PluginInventory>>;
    remove(instanceId: string, name: string): Promise<Result<PluginInventory>>;
    setBundleEnabled(instanceId: string, name: string, enabled: boolean): Promise<Result<PluginInventory>>;
    /** 安装本地插件：zip 压缩包 / GitHub 仓库 / 本地文件夹，落点都在实例目录内。 */
    install(instanceId: string, source: PluginSource): Promise<Result<PluginInstallResult>>;
    /** 删除实例内的一个本地插件（含 profile 依赖与 bundles 登记）。 */
    removeLocal(instanceId: string, name: string): Promise<Result<PluginInventory>>;
    /** 列出实例内的本地插件。 */
    listLocal(instanceId: string): Promise<Result<PluginSummary[]>>;
    /** 选择插件压缩包（zip）。 */
    pickArchive(): Promise<Result<string | null>>;
    /** 选择插件文件夹（含 package.json 的目录）。 */
    pickFolder(): Promise<Result<string | null>>;
  };
  settings: {
    read(instanceId: string): Promise<Result<string>>;
    write(instanceId: string, yaml: string): Promise<Result<void>>;
    /** 该实例未解决的共享冲突（core 侧为同步，IPC 层包成 Promise）。 */
    shareConflicts(instanceId: string): Promise<Result<ShareConflict[]>>;
    /** 显式解决冲突：`use-local` 把本地推给共享，`use-shared` 用共享覆盖本地（覆盖前 core 会写备份）。 */
    resolveShareConflict(
      instanceId: string,
      resolution: ShareConflictResolution,
    ): Promise<Result<void>>;
  };
  saves: {
    list(instanceId: string): Promise<Result<SessionInfo[]>>;
    openFolder(instanceId: string, sessionId?: string): Promise<Result<void>>;
  };
  pack: {
    export(instanceId: string): Promise<Result<string | null>>;
    import(): Promise<Result<ImportResult | null>>;
    pickFile(): Promise<Result<string | null>>;
  };
  app: {
    version(): Promise<Result<string>>;
    openExternal(url: string): Promise<Result<void>>;
    /** 取主进程的菜单树（唯一事实源）。 */
    menu(): Promise<Result<MenuNode[]>>;
    /** 执行一个菜单命令；id 来自 {@link MenuNode.id}。 */
    menuCommand(id: string): Promise<Result<void>>;
  };
  /** 订阅日志与状态推送；返回取消订阅函数。 */
  onLog(cb: (chunk: LogChunk) => void): () => void;
  onState(cb: (runtime: InstanceRuntime) => void): () => void;
}

/* ------------------------------------------------------------------ *
 * core 引擎 API 契约（main 依赖此形状调用 core）
 * ------------------------------------------------------------------ */

/** 校验实例/profile 名，返回错误消息或 null。 */
export type ValidateName = (name: string) => string | null;

/** dsh 允许的 profile 名规则（来自 dsh 源码，必须一致）。 */
export const FORBIDDEN_PROFILE_NAMES = ['.', '..', 'node_modules', 'desktop'] as const;

export const BUNDLE_TEMPLATES: Record<string, string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
};

/* ------------------------------------------------------------------ *
 * core 引擎 API 契约
 *
 * `src/core/**` 必须导出且仅需导出以下形状；`src/main/**` 按此调用。
 * 模块文件划分（T1 负责）：
 *   core/fsx.ts      → 文件工具
 *   core/paths.ts    → 路径解析
 *   core/names.ts    → 命名校验
 *   core/instance.ts → 实例 CRUD
 *   core/engine.ts   → 引擎版本
 *   core/profile.ts  → profile 读写（package.json / cordis.patch.yml / settings.yaml）
 *   core/plugins.ts  → 插件增删
 *   core/launch.ts   → 进程启动与运行时状态
 *   core/saves.ts    → 会话枚举 / 共享链接
 *   core/modpack.ts  → 导入导出
 *   core/index.ts    → 统一再导出
 * ------------------------------------------------------------------ */

/** 日志下沉口：core 不直接触碰 Electron，由 main 传入。 */
export type LogSink = (stream: 'stdout' | 'stderr' | 'system', text: string) => void;

/** 启动器根下的关键路径。 */
export interface CorePaths {
  root: string;
  instancesDir: string;
  enginesDir: string;
  sharedDir: string;
  sharedSessionsDir: string;
  sharedWorkspacesDir: string;
  cacheDir: string;
  configFile: string;
}

/** 实例文件系统布局（全部为绝对路径）。 */
export interface InstancePaths {
  root: string;
  home: string;
  workspace: string;
  logs: string;
  sessions: string;
  settingsFile: string;
  credentialsFile: string;
  metaFile: string;
  profilesDir: string;
  profileDir: string;
  /**
   * 实例内插件目录：`<实例>/home/plugins`。
   *
   * 刻意放在实例 home 之内而不是启动器根目录：实例目录整体复制到别处
   * （或打包迁移）时，随实例搬运的插件跟着一起走，不会丢。
   */
  pluginsDir: string;
}

export interface CoreApi {
  /* fsx */
  ensureDir(dir: string): Promise<void>;
  pathExists(p: string): Promise<boolean>;
  readJson<T>(file: string): Promise<T | null>;
  writeJsonAtomic(file: string, value: unknown): Promise<void>;
  readText(file: string): Promise<string | null>;
  writeTextAtomic(file: string, text: string): Promise<void>;
  /** 是否为 junction / symlink。 */
  isLink(p: string): Promise<boolean>;
  /** 把 link 替换为指向 target 的 junction（先安全解除旧链接，绝不删真实目录）。 */
  replaceWithJunction(link: string, target: string): Promise<void>;
  /** 若 link 是链接则移除，返回是否移除了。 */
  removeLink(link: string): Promise<boolean>;
  /** 递归计算目录大小，失败返回 null。 */
  dirSize(dir: string): Promise<number | null>;

  /* paths */
  corePaths(root: string): CorePaths;
  instancePaths(root: string, meta: InstanceMeta): InstancePaths;

  /* names */
  validateName(name: string): string | null;
  makeDirName(name: string, taken: readonly string[]): string;

  /* instance */
  listInstances(root: string): Promise<InstanceSummary[]>;
  createInstance(
    root: string,
    input: CreateInstanceInput,
    hooks?: { onLog?: LogSink },
  ): Promise<InstanceMeta>;
  readInstance(root: string, id: string): Promise<InstanceMeta | null>;
  updateInstance(root: string, id: string, patch: UpdateInstancePatch): Promise<InstanceMeta>;
  deleteInstance(root: string, id: string, deleteFiles: boolean): Promise<void>;
  /** 把实例的 saves/settings/workspace/credentials 落到实际形态（幂等）。 */
  applyShareModes(root: string, meta: InstanceMeta, config: LauncherConfig): Promise<void>;

  /* engine */
  listEngines(root: string): Promise<EngineInfo[]>;
  listAvailableEngines(registry: string, root?: string): Promise<string[]>;
  installEngine(
    root: string,
    version: string,
    registry: string,
    onLog?: LogSink,
  ): Promise<EngineInfo>;
  removeEngine(root: string, version: string): Promise<void>;
  /** 引擎 bin.js 绝对路径；未安装返回 null。 */
  resolveEngineBin(root: string, version: string): string | null;

  /* preflight */
  /**
   * 环境与依赖自检（首次启动与设置页共用）。
   *
   * **永不抛错**：任何单项失败都落成该项的 `failed` 并带中文原因；同一根目录上并发调用
   * 会复用同一次执行（单飞）。
   * @param root 启动器根目录。
   * @param options 自检选项（默认只做自动修复，不联网）。
   * @param onLog 长耗时步骤（引擎安装）的实时日志下沉。
   */
  runPreflight(root: string, options?: PreflightOptions, onLog?: LogSink): Promise<PreflightReport>;

  /* profile / settings */
  readProfileInventory(root: string, meta: InstanceMeta): Promise<PluginInventory>;
  readInstanceSettings(root: string, meta: InstanceMeta): Promise<string>;
  writeInstanceSettings(root: string, meta: InstanceMeta, yaml: string): Promise<void>;
  setBundleEnabled(
    root: string,
    meta: InstanceMeta,
    name: string,
    enabled: boolean,
  ): Promise<void>;

  /* plugins */
  pluginAdd(
    root: string,
    meta: InstanceMeta,
    spec: string,
    config: LauncherConfig,
    onLog?: LogSink,
  ): Promise<void>;
  pluginRemove(
    root: string,
    meta: InstanceMeta,
    name: string,
    config: LauncherConfig,
    onLog?: LogSink,
  ): Promise<void>;
  /** 实例内本地插件目录：`<实例>/home/plugins`。 */
  pluginsDir(root: string, meta: InstanceMeta): string;
  /** 安装本地插件（zip / GitHub / 文件夹），落点在实例目录内，可随实例搬运。 */
  pluginInstall(
    root: string,
    meta: InstanceMeta,
    source: PluginSource,
    config: LauncherConfig,
    onLog?: LogSink,
  ): Promise<PluginInstallResult>;
  /** 列出实例内已安装的本地插件。 */
  listInstancePlugins(root: string, meta: InstanceMeta): Promise<PluginSummary[]>;
  /** 删除实例内一个本地插件（清依赖、bundles 登记与目录）。 */
  pluginRemoveLocal(
    root: string,
    meta: InstanceMeta,
    name: string,
    config: LauncherConfig,
    onLog?: LogSink,
  ): Promise<void>;

  /* launch */
  launchInstance(
    root: string,
    meta: InstanceMeta,
    req: LaunchRequest,
    config: LauncherConfig,
    hooks?: { onLog?: LogSink; onState?: (runtime: InstanceRuntime) => void; onExit?: (code: number | null) => void },
  ): Promise<LaunchResult>;
  stopInstance(instanceId: string): Promise<void>;
  runtimeOf(instanceId: string): InstanceRuntime;
  listRuntimes(): InstanceRuntime[];

  /* saves */
  listSessions(root: string, meta: InstanceMeta): Promise<SessionInfo[]>;
  workspaceKeyFor(workspacePath: string): string;

  /* modpack */
  exportPack(root: string, meta: InstanceMeta, outFile: string, launcherVersion: string): Promise<string>;
  importPack(
    root: string,
    zipFile: string,
    config: LauncherConfig,
    hooks?: { onLog?: LogSink },
  ): Promise<ImportResult>;
}

/** 由 `src/core/index.ts` 默认导出的单例实现。 */
export declare const core: CoreApi;
