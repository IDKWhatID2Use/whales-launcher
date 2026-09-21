/**
 * 降级演示后端
 *
 * 当 `window.whales` 不存在（后端未就绪 / 在普通浏览器中预览界面）时启用。
 * 它实现了完整的 `WhalesApi`，数据全部驻留内存：
 *   - 启动/停止会推送真实的状态变更与日志流（含计时器与 URL 探测）；
 *   - 插件增删、设置读写、版本安装、导入导出都有可见的进度反馈；
 *   - 任何操作都不会写磁盘，界面会显式标注「演示数据」。
 */
import {
  BUNDLE_TEMPLATES,
  err,
  ok,
  type BundleEntry,
  type CreateInstanceInput,
  type CredentialsMode,
  type EngineInfo,
  type ImportResult,
  type InstanceMeta,
  type InstanceRuntime,
  type InstanceSummary,
  type LaunchRequest,
  type LaunchResult,
  type LauncherConfig,
  type LogChunk,
  type MenuNode,
  type NodeRuntimeReport,
  type PluginEntry,
  type PluginInstallResult,
  type PluginInventory,
  type PluginSource,
  type PluginSummary,
  type Result,
  type SessionInfo,
  type ShareConflict,
  type ShareConflictResolution,
  type ShareMode,
  type UpdateInstancePatch,
  type WhalesApi,
} from '../../shared/contracts';
import { validateInstanceName } from '../util/names';

const ROOT = 'F:\\WhalesLauncher';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** 取路径末段（兼容 `\` 与 `/`，用于从来源推导插件名）。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : '';
}

const BUNDLE_DESCRIPTIONS: Record<string, string> = {
  '@deepseek-ai/dsh-base': '基础运行时：配置树、会话存储、工具与模型接入',
  '@deepseek-ai/dsh-web-app': '本地 Web 界面与 HTTP 服务（默认 127.0.0.1:3080）',
  '@deepseek-ai/dsh-headless': '无界面批处理：执行一次任务后输出最终结果',
  '@deepseek-ai/dsh-sdk-app': 'JSON-RPC stdio 服务，供外部程序集成',
  '@deepseek-ai/dsh-sdk-minimal': '最小 SDK 运行时，仅含基础服务',
  '@deepseek-ai/dsh-acp-app': 'ACP stdio 服务，对接编辑器与 IDE',
  '@deepseek-ai/dsh-experimental-agent-team-profile': '实验性：终端多智能体协作',
  '@deepseek-ai/dsh-experimental-agent-team-web-profile': '实验性：多智能体协作面板（Web）',
};

const OPTIONAL_BUNDLES = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-agent-team-web-profile',
];

interface Seed {
  id: string;
  name: string;
  dirName: string;
  icon: string;
  color: string;
  note: string;
  engineVersion: string;
  template: string;
  profileName: string;
  workspace: ShareMode;
  saves: ShareMode;
  settings: ShareMode;
  credentials: CredentialsMode;
  createdAt: string;
  lastLaunchedAt: string | null;
  launchCount: number;
  present: boolean;
  state: InstanceRuntime['state'];
  pid: number | null;
  startedAt: string | null;
  url: string | null;
  exitCode: number | null;
  lastError: string | null;
  /** QR-17：core 的降级标记（非契约扩展字段），仅演示数据用。 */
  problem?: string;
}

const SEEDS: Seed[] = [
  {
    id: 'ins-workbench',
    name: '我的工作台',
    dirName: '我的工作台',
    icon: '🐳',
    color: '#4D8DFF',
    note: '日常开发、文档协作与代码检索，开启存档共享。',
    engineVersion: '0.1.6-alpha.2',
    template: 'web',
    profileName: 'main',
    workspace: 'local',
    saves: 'shared',
    settings: 'local',
    credentials: 'inherit',
    createdAt: iso(-62 * DAY),
    lastLaunchedAt: iso(-3 * MIN),
    launchCount: 128,
    present: true,
    state: 'running',
    pid: 21384,
    startedAt: iso(-3 * MIN),
    url: 'http://127.0.0.1:3080',
    exitCode: null,
    lastError: null,
  },
  {
    id: 'ins-headless',
    name: '无人值守任务',
    dirName: '无人值守任务',
    icon: '🤖',
    color: '#7C5CFF',
    note: '定时批处理：日志摘要、日报生成、仓库巡检。',
    engineVersion: '0.1.6-alpha.2',
    template: 'headless',
    profileName: 'main',
    workspace: 'local',
    saves: 'local',
    settings: 'local',
    credentials: 'inherit',
    createdAt: iso(-31 * DAY),
    lastLaunchedAt: iso(-5 * HOUR),
    launchCount: 37,
    present: true,
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    exitCode: 0,
    lastError: null,
  },
  {
    id: 'ins-sdk',
    name: 'SDK 集成测试',
    dirName: 'SDK-集成测试',
    icon: '🧩',
    color: '#2FB8A8',
    note: '给内部平台提供 JSON-RPC 接口，绑定旧版引擎。',
    engineVersion: '0.1.4',
    template: 'sdk',
    profileName: 'main',
    workspace: 'shared',
    saves: 'shared',
    settings: 'shared',
    credentials: 'local',
    createdAt: iso(-88 * DAY),
    lastLaunchedAt: iso(-2 * DAY),
    launchCount: 12,
    present: true,
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    exitCode: 0,
    lastError: null,
  },
  {
    id: 'ins-desktop',
    name: '桌面预览',
    dirName: '桌面预览',
    icon: '🛠️',
    color: '#F0A934',
    note: '试跑 ACP 组合包的实验实例。',
    engineVersion: '0.1.6-alpha.2',
    template: 'acp',
    profileName: 'main',
    workspace: 'local',
    saves: 'local',
    settings: 'local',
    credentials: 'local',
    createdAt: iso(-12 * DAY),
    lastLaunchedAt: iso(-40 * MIN),
    launchCount: 5,
    present: true,
    state: 'crashed',
    pid: null,
    startedAt: null,
    url: null,
    exitCode: 1,
    lastError:
      'StartupError：无法解析 profile 目录。完整诊断已写入 home/logs/startup-*.log，请检查 cordis.patch.yml 是否为合法 YAML 数组。',
  },
  {
    id: 'ins-archive',
    name: '归档实验',
    dirName: '归档实验',
    icon: '📦',
    color: '#5B6B7F',
    note: '早期试验用例，目录已被移动到备份盘。',
    engineVersion: '0.1.3',
    template: 'web',
    profileName: 'main',
    workspace: 'local',
    saves: 'local',
    settings: 'local',
    credentials: 'inherit',
    createdAt: iso(-154 * DAY),
    lastLaunchedAt: iso(-21 * DAY),
    launchCount: 88,
    present: false,
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    exitCode: null,
    lastError: null,
  },
  {
    // QR-17：core 会保留坏记录并通过附加属性 `problem` 给出原因。
    // 这一条是"目录在、元数据坏了"的形态：present=true，界面若不消费 problem
    // 就会把它渲染成一张完全正常的卡片（用户点启动只看到底层报错）。
    id: 'ins-broken',
    name: '元数据损坏的实例',
    dirName: '元数据损坏的实例',
    icon: '🧯',
    color: '#F0A934',
    note: 'instance.json 已损坏（演示降级记录：仍可见、可删除）。',
    engineVersion: '0.1.6-alpha.2',
    template: 'web',
    profileName: 'main',
    workspace: 'local',
    saves: 'local',
    settings: 'local',
    credentials: 'inherit',
    createdAt: iso(-30 * DAY),
    lastLaunchedAt: iso(-9 * DAY),
    launchCount: 12,
    present: true,
    state: 'stopped',
    pid: null,
    startedAt: null,
    url: null,
    exitCode: null,
    lastError: null,
    // 文案与 core 的 collectInstances 保持同源口径
    problem: 'instance.json 损坏（无法解析）；该记录已保留在列表中，可修复文件，或删除该实例以清理残留目录',
  },
];

const DEMO_SETTINGS: Record<string, string> = {
  'ins-workbench': `# $DSH_HOME/settings.yaml —— 按插件命名空间分组
agent-default-model:
  model: deepseek-v4
  temperature: 0.6
  maxOutputTokens: 8192

agency-agents:
  enabled: true
  maxConcurrent: 3
  defaultTimeoutMs: 600000

skin-default:
  accent: "#4D8DFF"
  density: cozy

ui:
  locale: zh-CN
  theme: dark
  telemetry: false
`,
  'ins-headless': `# 无人值守实例：关闭交互式提示，固定较低温度
agent-default-model:
  model: deepseek-v4
  temperature: 0.2

agency-agents:
  enabled: false

ui:
  locale: zh-CN
  telemetry: false
`,
  'ins-sdk': `# SDK 实例：仅保留必要服务
sdk:
  transports: [stdio]
  prettyJson: false
`,
  'ins-desktop': `# 注意：本文件必须保持为合法 YAML，否则启动时组合配置会失败
acp:
  transport: stdio
`,
};

const DEMO_SESSIONS: Record<string, SessionInfo[]> = {
  'ins-workbench': [
    {
      id: '8f2c1a7e-4b91-4d3a-9c07-2f5e6d81ab34',
      updatedAt: iso(-25 * MIN),
      dir: `${ROOT}\\instances\\我的工作台\\home\\sessions\\--F-WhalesLauncher--\\8f2c1a7e-4b91-4d3a-9c07-2f5e6d81ab34`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 1_284_096,
    },
    {
      id: 'b71d09c4-2e58-4a76-8f13-5c9a4d0e77b2',
      updatedAt: iso(-4 * HOUR),
      dir: `${ROOT}\\instances\\我的工作台\\home\\sessions\\--F-WhalesLauncher--\\b71d09c4-2e58-4a76-8f13-5c9a4d0e77b2`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 486_912,
    },
    {
      id: '3ac6f812-77b5-49e0-9d21-8b0e5f2c6419',
      updatedAt: iso(-1 * DAY),
      dir: `${ROOT}\\shared\\sessions\\--F-WhalesLauncher--\\3ac6f812-77b5-49e0-9d21-8b0e5f2c6419`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 2_097_152,
    },
    {
      id: 'd5e0b3a9-6c47-4f82-a10d-9e7b2c4f8830',
      updatedAt: iso(-3 * DAY),
      dir: `${ROOT}\\shared\\sessions\\--F-WhalesLauncher--\\d5e0b3a9-6c47-4f82-a10d-9e7b2c4f8830`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: null,
    },
    {
      id: '1b9f47d2-8a30-4c65-b7e1-2d4f6a90cc57',
      updatedAt: iso(-9 * DAY),
      dir: `${ROOT}\\shared\\sessions\\--C-Users-user-.dsh-APIHunter--\\1b9f47d2-8a30-4c65-b7e1-2d4f6a90cc57`,
      workspaceKey: '--C-Users-user-.dsh-APIHunter--',
      sizeBytes: 73_728,
    },
  ],
  'ins-headless': [
    {
      id: 'c4a8e0f1-35b7-4d92-8a06-7f1e3b5c9d20',
      updatedAt: iso(-5 * HOUR),
      dir: `${ROOT}\\instances\\无人值守任务\\home\\sessions\\--F-WhalesLauncher--\\c4a8e0f1-35b7-4d92-8a06-7f1e3b5c9d20`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 61_440,
    },
    {
      id: '7e2b95c0-4f18-4a73-9c25-1b6d8e04fa91',
      updatedAt: iso(-1 * DAY),
      dir: `${ROOT}\\instances\\无人值守任务\\home\\sessions\\--F-WhalesLauncher--\\7e2b95c0-4f18-4a73-9c25-1b6d8e04fa91`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 55_296,
    },
  ],
  'ins-sdk': [
    {
      id: 'a0d3c7e5-91f4-42b8-8e60-3c5a7d21b9f8',
      updatedAt: iso(-2 * DAY),
      dir: `${ROOT}\\shared\\sessions\\--F-WhalesLauncher--\\a0d3c7e5-91f4-42b8-8e60-3c5a7d21b9f8`,
      workspaceKey: '--F-WhalesLauncher--',
      sizeBytes: 20_480,
    },
  ],
  'ins-desktop': [],
  'ins-archive': [],
};

const AVAILABLE_VERSIONS = [
  '0.1.6-alpha.2',
  '0.1.6-alpha.1',
  '0.1.6-alpha.0',
  '0.1.5',
  '0.1.4',
  '0.1.3',
  '0.1.2',
  '0.1.1',
  '0.1.0',
  '0.0.9',
];

/** 演示模式下预先铺好的启动日志（供运行中实例的日志页立即有内容）。 */
export function demoSeedLogs(): LogChunk[] {
  const base = Date.now() - 3 * MIN;
  const at = (i: number): string => new Date(base + i * 240).toISOString();
  const lines: Array<[LogChunk['stream'], string]> = [
    ['system', '启动实例「我的工作台」，引擎版本 0.1.6-alpha.2'],
    ['system', 'DSH_HOME = F:\\WhalesLauncher\\instances\\我的工作台\\home'],
    ['system', '工作目录 = F:\\WhalesLauncher\\instances\\我的工作台\\workspace'],
    ['stdout', 'dsh 0.1.6-alpha.2'],
    ['stdout', '正在解析 profile "main"（模板 web）…'],
    ['stdout', '组合包：@deepseek-ai/dsh-base → @deepseek-ai/dsh-web-app'],
    ['stderr', '[warn] cordis.patch.yml 中的条目 "legacy-ui" 未匹配任何配置项，已忽略'],
    ['stdout', '配置树组合完成，共 3 个组合包、1 层用户覆盖'],
    ['stdout', '正在监听 127.0.0.1:3080 …'],
    ['stdout', 'Web 界面已就绪：http://127.0.0.1:3080'],
    ['system', '界面地址已探测，可在实例卡片上点击「打开界面」'],
  ];
  return lines.map(([stream, text], i) => ({
    instanceId: 'ins-workbench',
    stream,
    text,
    ts: at(i),
  }));
}

/**
 * 演示模式菜单树。
 *
 * 结构与 id/label/accelerator 与主进程 `menuSpec()` 保持一致（23 项，5 个顶级菜单），
 * 使无后端预览时也能看到完整、可交互的应用菜单；真实模式下渲染层**只**消费
 * `app.menu()` 返回的树，不维护第二份定义。
 */
export function demoMenuTree(): MenuNode[] {
  return [
    {
      id: 'menu.file',
      label: '文件',
      children: [
        { id: 'file.openRoot', label: '打开启动器目录' },
        { id: 'file.openInstances', label: '打开实例目录' },
        { id: 'file.openEngines', label: '打开引擎目录' },
        { id: 'file.sep1', label: '', kind: 'separator' },
        { id: 'file.refresh', label: '刷新界面', accelerator: 'F5' },
        { id: 'file.sep2', label: '', kind: 'separator' },
        { id: 'file.quit', label: '退出' },
      ],
    },
    {
      id: 'menu.edit',
      label: '编辑',
      children: [
        { id: 'edit.undo', label: '撤销', accelerator: 'Ctrl+Z' },
        { id: 'edit.redo', label: '重做', accelerator: 'Ctrl+Y' },
        { id: 'edit.sep1', label: '', kind: 'separator' },
        { id: 'edit.cut', label: '剪切', accelerator: 'Ctrl+X' },
        { id: 'edit.copy', label: '复制', accelerator: 'Ctrl+C' },
        { id: 'edit.paste', label: '粘贴', accelerator: 'Ctrl+V' },
        { id: 'edit.selectAll', label: '全选', accelerator: 'Ctrl+A' },
      ],
    },
    {
      id: 'menu.view',
      label: '视图',
      children: [
        { id: 'view.reload', label: '重新加载', accelerator: 'Ctrl+R' },
        { id: 'view.forceReload', label: '强制重新加载', accelerator: 'Ctrl+Shift+R' },
        { id: 'view.devtools', label: '开发者工具', accelerator: 'Ctrl+Shift+I' },
        { id: 'view.sep1', label: '', kind: 'separator' },
        { id: 'view.zoomReset', label: '实际大小', accelerator: 'Ctrl+0' },
        { id: 'view.zoomIn', label: '放大', accelerator: 'Ctrl+=' },
        { id: 'view.zoomOut', label: '缩小', accelerator: 'Ctrl+-' },
        { id: 'view.sep2', label: '', kind: 'separator' },
        { id: 'view.fullscreen', label: '全屏', accelerator: 'F11' },
      ],
    },
    {
      id: 'menu.window',
      label: '窗口',
      children: [
        { id: 'window.minimize', label: '最小化' },
        { id: 'window.close', label: '关闭' },
      ],
    },
    {
      id: 'menu.help',
      label: '帮助',
      children: [
        { id: 'help.docs', label: 'dsh 接口勘察文档' },
        { id: 'help.architecture', label: '总体设计方案' },
        { id: 'help.sep1', label: '', kind: 'separator' },
        { id: 'help.about', label: '关于 WhalesLauncher' },
      ],
    },
  ];
}

/**
 * 从演示数据的界面地址里取出端口。
 *
 * 演示模式应与真实行为同形：真实运行时 `runtime.port` 由 dsh 打印的地址回填，
 * 这里做同样的推导，避免演示界面出现「有界面地址却没有端口」的不一致形态。
 * @param url 界面地址。
 * @returns 端口；地址为空或未含端口时返回 `null`。
 */
function portOf(url: string | null): number | null {
  if (url === null) return null;
  const match = /:(\d+)/.exec(url);
  return match === null ? null : Number(match[1]);
}

/**
 * 演示模式下的自动端口：从 3080 起避开其它仍在运行的演示实例已占用的端口。
 *
 * 演示界面因此能如实展示「多实例各自监听不同端口」，而不是所有实例都写死 3080 ——
 * 后者会让演示成为一个与真实行为不符的假象。
 * @param summaries 演示实例列表。
 * @returns 可用的演示端口。
 */
function allocateDemoPort(summaries: readonly InstanceSummary[]): number {
  const used = new Set<number>();
  for (const item of summaries) {
    if (item.runtime.state === 'stopped' || item.runtime.state === 'crashed') continue;
    if (item.runtime.port !== null) used.add(item.runtime.port);
  }
  let port = 3080;
  while (used.has(port)) port += 1;
  return port;
}

class DemoApi implements WhalesApi {
  private readonly config: LauncherConfig = {
    schemaVersion: 1,
    primaryHome: 'C:\\Users\\user\\.dsh',
    theme: 'dark',
    lastInstanceId: 'ins-workbench',
    confirmOnDelete: true,
    engineRegistry: 'https://registry.npmjs.org',
    nodePath: null,
    rootDir: ROOT,
  };

  private readonly summaries: InstanceSummary[] = [];
  private readonly inventories = new Map<string, PluginInventory>();
  /** 演示模式的「随实例搬运」本地插件（`home/plugins` 的投影）。 */
  private readonly localPlugins = new Map<string, PluginSummary[]>();
  private readonly settingsStore = new Map<string, string>();
  private readonly sessions = new Map<string, SessionInfo[]>();
  private readonly engines: EngineInfo[] = [];
  private available: string[] = AVAILABLE_VERSIONS.slice();
  /** QR-15：共享设置冲突（instanceId → 冲突列表）；演示一条真实形态的冲突 */
  private readonly conflicts = new Map<string, ShareConflict[]>();

  private readonly logSubs = new Set<(chunk: LogChunk) => void>();
  private readonly stateSubs = new Set<(runtime: InstanceRuntime) => void>();
  private readonly timers = new Set<number>();
  private seq = 0;

  constructor() {
    // 引擎必须先登记：实例的 engineInstalled 依赖它
    this.engines.push(
      {
        version: '0.1.6-alpha.2',
        dir: `${ROOT}\\engines\\0.1.6-alpha.2`,
        installed: true,
        binPath: `${ROOT}\\engines\\0.1.6-alpha.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
        usedBy: [],
        // 刻意复刻真实场景：junction 接入的引擎 dirSize 不跟随链接，返回 0 → UI 显示「未知」
        sizeBytes: 0,
      },
      {
        version: '0.1.4',
        dir: `${ROOT}\\engines\\0.1.4`,
        installed: true,
        binPath: `${ROOT}\\engines\\0.1.4\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
        usedBy: [],
        sizeBytes: 47_185_920,
      },
    );

    for (const seed of SEEDS) {
      const meta: InstanceMeta = {
        schemaVersion: 1,
        id: seed.id,
        name: seed.name,
        dirName: seed.dirName,
        icon: seed.icon,
        color: seed.color,
        note: seed.note,
        engine: { version: seed.engineVersion },
        profile: { name: seed.profileName, template: seed.template },
        workspace: { mode: seed.workspace },
        saves: { mode: seed.saves },
        settings: { mode: seed.settings },
        credentials: { mode: seed.credentials },
        launch: { appArgs: [], autoOpenBrowser: seed.template === 'web' },
        createdAt: seed.createdAt,
        lastLaunchedAt: seed.lastLaunchedAt,
        launchCount: seed.launchCount,
      };
      const inventory = this.buildInventory(meta);
      this.inventories.set(seed.id, inventory);
      const yaml = DEMO_SETTINGS[seed.id];
      if (yaml !== undefined) this.settingsStore.set(seed.id, yaml);
      // 共享模式实例：预置一份"共享侧"内容，与本地内容不同 → 构成 QR-15 的冲突场景
      if (seed.settings === 'shared') {
        this.settingsStore.set(
          `shared:${seed.id}`,
          `# 共享 settings.yaml（其它实例也在用这一份）\nagent-default-model:\n  model: deepseek-v4\n  temperature: 0.3\n\nagency-agents:\n  enabled: true\n  maxConcurrent: 1\n\nui:\n  locale: zh-CN\n`,
        );
      }
      this.sessions.set(seed.id, DEMO_SESSIONS[seed.id] ?? []);
      const summary: InstanceSummary = {
        meta,
        runtime: {
          instanceId: seed.id,
          state: seed.state,
          pid: seed.pid,
          startedAt: seed.startedAt,
          url: seed.url,
          port: portOf(seed.url),
          exitCode: seed.exitCode,
          lastError: seed.lastError,
        },
        present: seed.present,
        engineInstalled: this.isInstalled(seed.engineVersion),
        pluginCount: inventory.dependencies.length,
      };
      // QR-17：core 的降级标记（契约字段 `InstanceSummary.problem`）
      if (seed.problem !== undefined) summary.problem = seed.problem;
      this.summaries.push(summary);
    }

    // 运行中实例的心跳，让日志页在演示模式下保持"活着"
    window.setInterval(() => {
      for (const summary of this.summaries) {
        if (summary.runtime.state !== 'running' || !summary.runtime.startedAt) continue;
        const elapsed = Math.max(0, Date.now() - Date.parse(summary.runtime.startedAt));
        const minutes = Math.floor(elapsed / MIN);
        this.emitLog(summary.meta.id, 'system', `心跳 · 运行正常（已运行 ${minutes} 分钟）`);
      }
    }, 20_000);

    // QR-15：为共享模式实例登记一条真实的设置冲突（本地与共享内容已分叉）
    for (const summary of this.summaries) {
      if (summary.meta.settings.mode !== 'shared') continue;
      const localFile = `${ROOT}\\instances\\${summary.meta.dirName}\\home\\settings.yaml`;
      const sharedFile = `${ROOT}\\shared\\settings.yaml`;
      this.conflicts.set(summary.meta.id, [
        {
          instanceId: summary.meta.id,
          resource: 'settings',
          kept: 'local',
          localFile,
          sharedFile,
          message: `本实例的设置与共享设置不一致，已保留本地内容、未覆盖任何一边。请选择以哪一份为准（覆盖前会自动备份为 .bak-<时间戳>）。`,
        },
      ]);
    }
  }

  /** 清除某实例的设置冲突（解决后调用）。 */
  private clearConflict(instanceId: string): void {
    this.conflicts.delete(instanceId);
  }

  /* ── 内部工具 ─────────────────────────────────────────────── */

  private buildInventory(meta: InstanceMeta): PluginInventory {
    const templateBundles = BUNDLE_TEMPLATES[meta.profile.template] ?? ['@deepseek-ai/dsh-base'];
    const bundles: BundleEntry[] = templateBundles.map((name) => ({
      name,
      enabled: true,
      description: BUNDLE_DESCRIPTIONS[name] ?? null,
      version: meta.engine.version,
      builtin: true,
    }));
    if (meta.profile.template === 'web') {
      bundles.push(
        {
          name: OPTIONAL_BUNDLES[0] ?? '',
          enabled: false,
          description: BUNDLE_DESCRIPTIONS[OPTIONAL_BUNDLES[0] ?? ''] ?? null,
          version: meta.engine.version,
          builtin: true,
        },
        {
          name: OPTIONAL_BUNDLES[1] ?? '',
          enabled: true,
          description: BUNDLE_DESCRIPTIONS[OPTIONAL_BUNDLES[1] ?? ''] ?? null,
          version: meta.engine.version,
          builtin: true,
        },
      );
    }
    if (meta.profile.template === 'sdk' || meta.profile.template === 'acp') {
      bundles.push({
        name: 'whales-demo-toolkit',
        enabled: true,
        description: '第三方组合包示例：自定义工具与提示词模板',
        version: '0.3.2',
        builtin: false,
      });
    }

    const dependencies: PluginEntry[] = [
      { name: '@deepseek-ai/dsh-plugin-memory', version: '^0.1.6', installed: true, spec: '^0.1.6' },
      { name: 'cordis-plugin-timer', version: '^2.4.1', installed: true, spec: '^2.4.1' },
      { name: 'dsh-plugin-markdown-tools', version: '^1.2.0', installed: true, spec: '^1.2.0' },
    ];
    if (meta.profile.template === 'web') {
      dependencies.push(
        { name: 'dsh-plugin-pdf-reader', version: '^0.9.4', installed: true, spec: '^0.9.4' },
        { name: 'whales-theme-deepblue', version: '^1.0.0', installed: false, spec: '^1.0.0' },
      );
    }

    return {
      bundles,
      dependencies,
      profileDir: `${ROOT}\\instances\\${meta.dirName}\\home\\profiles\\${meta.profile.name}`,
    };
  }

  private isInstalled(version: string): boolean {
    return this.engines.some((e) => e.version === version && e.installed);
  }

  private byId(id: string): InstanceSummary | undefined {
    return this.summaries.find((s) => s.meta.id === id);
  }

  private inventoryOf(id: string): PluginInventory | undefined {
    return this.inventories.get(id);
  }

  private schedule(ms: number, fn: () => void): void {
    const handle = window.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
  }

  private emitLog(instanceId: string, stream: LogChunk['stream'], text: string): void {
    this.seq += 1;
    const chunk: LogChunk = { instanceId, stream, text, ts: new Date().toISOString() };
    for (const fn of this.logSubs) fn(chunk);
  }

  private stream(
    instanceId: string,
    lines: ReadonlyArray<readonly [LogChunk['stream'], string]>,
    startDelay = 0,
    step = 110,
  ): void {
    lines.forEach((line, index) => {
      this.schedule(startDelay + index * step, () => this.emitLog(instanceId, line[0], line[1]));
    });
  }

  private setRuntime(id: string, patch: Partial<InstanceRuntime>): void {
    const summary = this.byId(id);
    if (!summary) return;
    Object.assign(summary.runtime, patch);
    const snapshot: InstanceRuntime = { ...summary.runtime };
    for (const fn of this.stateSubs) fn(snapshot);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(ms, resolve));
  }

  /* ── 启动器配置 ───────────────────────────────────────────── */

  launcher: WhalesApi['launcher'] = {
    getConfig: async (): Promise<Result<LauncherConfig>> => ok({ ...this.config }),
    setConfig: async (patch: Partial<LauncherConfig>): Promise<Result<LauncherConfig>> => {
      Object.assign(this.config, patch);
      return ok({ ...this.config });
    },
    // 演示模式：不真的跑探针，返回一份形态真实的报告，让设置页的展示逻辑可被预览
    detectNode: async (): Promise<Result<NodeRuntimeReport>> =>
      ok({
        ok: true,
        file: 'C:\\Program Files\\nodejs\\node.exe',
        version: '24.11.0',
        source: 'path',
        message: '使用 C:\\Program Files\\nodejs\\node.exe（Node v24.11.0，来源：系统 PATH）',
        candidates: [
          {
            file: 'C:\\Program Files\\nodejs\\node.exe',
            source: 'path',
            ok: true,
            version: '24.11.0',
            electron: null,
            reason: null,
          },
        ],
      }),
  };

  /* ── 实例 ─────────────────────────────────────────────────── */

  instance: WhalesApi['instance'] = {
    list: async (): Promise<Result<InstanceSummary[]>> =>
      ok(this.summaries.map((s) => ({ ...s, meta: { ...s.meta }, runtime: { ...s.runtime } }))),

    get: async (id: string): Promise<Result<InstanceSummary>> => {
      const summary = this.byId(id);
      if (!summary) return err(`找不到实例：${id}`);
      return ok({ ...summary, meta: { ...summary.meta }, runtime: { ...summary.runtime } });
    },

    create: async (input: CreateInstanceInput): Promise<Result<InstanceSummary>> => {
      const nameError = validateInstanceName(input.name);
      if (nameError) return err(`实例名不合法：${nameError}`);
      if (!input.engineVersion) return err('请选择引擎版本');
      if (this.summaries.some((s) => s.meta.name === input.name)) {
        return err(`已存在同名实例：${input.name}`);
      }
      const id = `ins-${Date.now().toString(36)}`;
      const dirName = input.dirName && input.dirName.length > 0 ? input.dirName : input.name;
      const meta: InstanceMeta = {
        schemaVersion: 1,
        id,
        name: input.name,
        dirName,
        icon: input.icon ?? null,
        color: input.color ?? '#4D8DFF',
        note: input.note ?? '',
        engine: { version: input.engineVersion },
        profile: { name: input.profileName ?? 'main', template: input.template },
        workspace: { mode: input.workspace ?? 'local' },
        saves: { mode: input.saves ?? 'local' },
        settings: { mode: input.settings ?? 'local' },
        credentials: { mode: input.credentials ?? 'inherit' },
        launch: { appArgs: [], autoOpenBrowser: input.template === 'web' },
        createdAt: new Date().toISOString(),
        lastLaunchedAt: null,
        launchCount: 0,
      };
      const inventory = this.buildInventory(meta);
      this.inventories.set(id, inventory);
      this.settingsStore.set(id, `# $DSH_HOME/settings.yaml\n`);
      this.sessions.set(id, []);
      const summary: InstanceSummary = {
        meta,
        runtime: {
          instanceId: id,
          state: 'stopped',
          pid: null,
          startedAt: null,
          url: null,
          port: null,
          exitCode: null,
          lastError: null,
        },
        present: true,
        engineInstalled: this.isInstalled(meta.engine.version),
        pluginCount: inventory.dependencies.length,
      };
      this.summaries.push(summary);

      this.stream(id, [
        ['system', `创建实例「${meta.name}」`],
        ['system', `目标目录：${ROOT}\\instances\\${meta.dirName}`],
        ['stdout', `dsh --profile ${meta.profile.name} --from-default-profile ${meta.profile.template} --dump-config`],
        ['stdout', `组合包初始化完成：${(BUNDLE_TEMPLATES[meta.profile.template] ?? []).join(', ')}`],
        ['system', 'instance.json 已写入，实例可启动'],
      ]);
      await this.delay(820);
      return ok(summary);
    },

    update: async (id: string, patch: UpdateInstancePatch): Promise<Result<InstanceSummary>> => {
      const summary = this.byId(id);
      if (!summary) return err(`找不到实例：${id}`);
      if (patch.name !== undefined) {
        const nameError = validateInstanceName(patch.name);
        if (nameError) return err(`实例名不合法：${nameError}`);
        summary.meta.name = patch.name;
      }
      if (patch.icon !== undefined) summary.meta.icon = patch.icon;
      if (patch.color !== undefined) summary.meta.color = patch.color;
      if (patch.note !== undefined) summary.meta.note = patch.note;
      if (patch.engineVersion !== undefined) {
        summary.meta.engine.version = patch.engineVersion;
        summary.engineInstalled = this.isInstalled(patch.engineVersion);
      }
      if (patch.appArgs !== undefined) summary.meta.launch.appArgs = patch.appArgs.slice();
      if (patch.autoOpenBrowser !== undefined) {
        summary.meta.launch.autoOpenBrowser = patch.autoOpenBrowser;
      }
      if (patch.workspace !== undefined) summary.meta.workspace.mode = patch.workspace;
      if (patch.saves !== undefined) summary.meta.saves.mode = patch.saves;
      if (patch.settings !== undefined) summary.meta.settings.mode = patch.settings;
      if (patch.credentials !== undefined) summary.meta.credentials.mode = patch.credentials;
      await this.delay(180);
      return ok({ ...summary, meta: { ...summary.meta }, runtime: { ...summary.runtime } });
    },

    remove: async (id: string, deleteFiles: boolean): Promise<Result<void>> => {
      const index = this.summaries.findIndex((s) => s.meta.id === id);
      if (index < 0) return err(`找不到实例：${id}`);
      const summary = this.summaries[index];
      if (summary && summary.runtime.state === 'running') {
        return err('实例正在运行，请先停止后再删除');
      }
      this.summaries.splice(index, 1);
      this.inventories.delete(id);
      this.settingsStore.delete(id);
      this.sessions.delete(id);
      if (deleteFiles) {
        this.emitLog('', 'system', `已删除实例目录：${ROOT}\\instances\\${summary?.meta.dirName ?? id}`);
      }
      await this.delay(260);
      return ok(undefined);
    },

    launch: async (req: LaunchRequest): Promise<Result<LaunchResult>> => {
      const summary = this.byId(req.instanceId);
      if (!summary) return err(`找不到实例：${req.instanceId}`);
      if (summary.runtime.state === 'running' || summary.runtime.state === 'starting') {
        return err('实例已在运行中');
      }
      if (!summary.present) return err('实例目录不存在，请先修复目录或重新导入实例包');
      if (!summary.engineInstalled) {
        return err(`引擎 ${summary.meta.engine.version} 尚未安装，请先在「版本管理」中安装`);
      }
      const home = `${ROOT}\\instances\\${summary.meta.dirName}\\home`;
      const cwd = `${ROOT}\\instances\\${summary.meta.dirName}\\workspace`;
      const pid = 20_000 + Math.floor(Math.random() * 20_000);
      const isWeb = summary.meta.profile.template === 'web';
      const demoPort = isWeb ? allocateDemoPort(this.summaries) : null;
      this.setRuntime(req.instanceId, {
        state: 'starting',
        pid,
        startedAt: new Date().toISOString(),
        url: null,
        port: demoPort,
        exitCode: null,
        lastError: null,
      });
      const args = req.appArgs && req.appArgs.length > 0 ? req.appArgs : summary.meta.launch.appArgs;
      this.stream(req.instanceId, [
        ['system', `启动实例「${summary.meta.name}」，引擎 ${summary.meta.engine.version}`],
        ['system', `DSH_HOME = ${home}`],
        ['system', `工作目录 = ${cwd}`],
        ['stdout', `dsh --profile ${summary.meta.profile.name}${args.length > 0 ? ` ${args.join(' ')}` : ''}`],
        ['stdout', `正在解析 profile "${summary.meta.profile.name}"（模板 ${summary.meta.profile.template}）…`],
        [
          'stdout',
          `组合包：${(BUNDLE_TEMPLATES[summary.meta.profile.template] ?? []).join(' → ')}`,
        ],
        ['stdout', '配置树组合完成'],
      ]);

      this.schedule(950, () => {
        this.setRuntime(req.instanceId, { state: 'running' });
        summary.meta.lastLaunchedAt = new Date().toISOString();
        summary.meta.launchCount += 1;
        if (isWeb) {
          // 演示端口由 allocateDemoPort 自动避让得到，因此多实例各监听不同端口
          const port = demoPort ?? 3080;
          const url = `http://127.0.0.1:${String(port)}`;
          this.setRuntime(req.instanceId, { url, port });
          this.emitLog(req.instanceId, 'stdout', `正在监听 127.0.0.1:${String(port)} …`);
          this.emitLog(req.instanceId, 'stdout', `Web 界面已就绪：${url}`);
          if (summary.meta.launch.autoOpenBrowser) {
            this.emitLog(req.instanceId, 'system', '已按实例设置请求自动打开界面');
          }
        } else {
          this.emitLog(
            req.instanceId,
            'stdout',
            summary.meta.profile.template === 'headless'
              ? '批处理模式已就绪，等待任务输入'
              : 'stdio 服务已就绪，等待客户端握手',
          );
        }
      });

      await this.delay(360);
      return ok({ pid, dshHome: home, cwd });
    },

    stop: async (id: string): Promise<Result<void>> => {
      const summary = this.byId(id);
      if (!summary) return err(`找不到实例：${id}`);
      if (summary.runtime.state === 'stopped') return err('实例当前未运行');
      this.setRuntime(id, { state: 'stopping' });
      this.emitLog(id, 'system', '正在停止实例（发送终止信号）…');
      this.schedule(620, () => {
        this.setRuntime(id, {
          state: 'stopped',
          pid: null,
          url: null,
          port: null,
          startedAt: null,
          exitCode: 0,
        });
        this.emitLog(id, 'stdout', '进程已退出（退出码 0）');
      });
      await this.delay(300);
      return ok(undefined);
    },

    openFolder: async (
      id: string,
      which: 'root' | 'home' | 'workspace' | 'logs',
    ): Promise<Result<void>> => {
      const summary = this.byId(id);
      if (!summary) return err(`找不到实例：${id}`);
      const base = `${ROOT}\\instances\\${summary.meta.dirName}`;
      const target =
        which === 'root'
          ? base
          : which === 'home'
            ? `${base}\\home`
            : which === 'workspace'
              ? `${base}\\workspace`
              : `${base}\\logs`;
      this.emitLog(id, 'system', `（演示模式）已模拟定位目录：${target}`);
      await this.delay(120);
      return ok(undefined);
    },
  };

  /* ── 引擎版本 ─────────────────────────────────────────────── */

  engine: WhalesApi['engine'] = {
    list: async (): Promise<Result<EngineInfo[]>> => {
      const installed: EngineInfo[] = this.engines.map((engine) => ({
        ...engine,
        usedBy: this.summaries
          .filter((s) => s.meta.engine.version === engine.version)
          .map((s) => s.meta.id),
      }));
      return ok(installed);
    },

    available: async (): Promise<Result<string[]>> => {
      // 刻意慢（模拟 `npm view` 走网络）：用于守住"本地已安装列表不被 npm 查询拖住"
      // 这条回归 —— 曾经两段用 Promise.all 合并，真实环境下整页无限加载。
      await this.delay(2200);
      this.available = AVAILABLE_VERSIONS.slice();
      return ok(this.available.slice());
    },

    install: async (version: string): Promise<Result<EngineInfo>> => {
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
        return err(`版本号格式不合法：${version}`);
      }
      if (this.isInstalled(version)) return err(`引擎 ${version} 已安装`);
      const dir = `${ROOT}\\engines\\${version}`;
      this.stream(
        '',
        [
          ['system', `开始安装引擎 ${version}`],
          ['system', `目标目录：${dir}`],
          ['stdout', `npm install @deepseek-ai/dsh@${version} --registry https://registry.npmjs.org`],
          ['stdout', '正在解析依赖树…'],
          ['stdout', '正在下载 @deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app …'],
          ['stdout', '已解压 1 284 个文件'],
          ['stdout', '正在生成 node_modules 链接（hoisted）…'],
        ],
        0,
        180,
      );
      await this.delay(1_500);
      this.engines.push({
        version,
        dir,
        installed: true,
        binPath: `${dir}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
        usedBy: [],
        sizeBytes: 48_000_000 + Math.floor(Math.random() * 4_000_000),
      });
      this.stream('', [['stdout', '安装完成'], ['system', `引擎 ${version} 可用于创建实例`]], 0, 160);
      const engines = this.engines.find((e) => e.version === version);
      return ok(
        engines ?? {
          version,
          dir,
          installed: true,
          binPath: null,
          usedBy: [],
          sizeBytes: null,
        },
      );
    },

    remove: async (version: string): Promise<Result<void>> => {
      const engine = this.engines.find((e) => e.version === version);
      if (!engine) return err(`未安装该引擎：${version}`);
      const usedBy = this.summaries.filter((s) => s.meta.engine.version === version);
      if (usedBy.length > 0) {
        return err(
          `引擎 ${version} 正被 ${usedBy.length} 个实例引用（${usedBy
            .map((s) => s.meta.name)
            .join('、')}），请先改为其它版本`,
        );
      }
      await this.delay(520);
      const index = this.engines.indexOf(engine);
      if (index >= 0) this.engines.splice(index, 1);
      this.emitLog('', 'system', `已卸载引擎 ${version}（释放 ${engine.sizeBytes ?? 0} 字节）`);
      return ok(undefined);
    },
  };

  /* ── 插件 ─────────────────────────────────────────────────── */

  plugin: WhalesApi['plugin'] = {
    inventory: async (instanceId: string): Promise<Result<PluginInventory>> => {
      const inventory = this.inventoryOf(instanceId);
      if (!inventory) return err(`找不到实例：${instanceId}`);
      await this.delay(140);
      return ok({
        bundles: inventory.bundles.map((b) => ({ ...b })),
        dependencies: inventory.dependencies.map((d) => ({ ...d })),
        profileDir: inventory.profileDir,
      });
    },

    add: async (instanceId: string, spec: string): Promise<Result<PluginInventory>> => {
      const inventory = this.inventoryOf(instanceId);
      if (!inventory) return err(`找不到实例：${instanceId}`);
      const trimmed = spec.trim();
      if (trimmed.length === 0) return err('请输入要安装的 npm 包名');
      if (!/^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+(@[^\s]+)?$/i.test(trimmed)) {
        return err(`包名不合法：${trimmed}`);
      }
      const summary = this.byId(instanceId);
      if (summary && summary.runtime.state === 'running') {
        return err('实例正在运行，插件变更需先停止实例');
      }
      const at = trimmed.lastIndexOf('@');
      const name = at > 0 ? trimmed.slice(0, at) : trimmed;
      const version = at > 0 ? trimmed.slice(at + 1) : 'latest';
      if (name === 'not-found-pkg') {
        this.emitLog(instanceId, 'stderr', `ERR_PNPM_FETCH_404  未找到包：${name}`);
        return err(`pnpm 安装失败：404 Not Found —— ${name} 不存在于当前 registry`);
      }
      this.stream(instanceId, [
        ['system', `安装插件 ${name}`],
        ['stdout', `dsh plugin --profile ${summary?.meta.profile.name ?? 'main'} add ${trimmed}`],
        ['stdout', `正在解析 ${name}@${version} …`],
        ['stdout', '已写入 package.json 并更新 pnpm-lock.yaml'],
      ]);
      await this.delay(900);
      const existing = inventory.dependencies.find((d) => d.name === name);
      if (existing) {
        existing.version = version;
        existing.installed = true;
        existing.spec = version;
      } else {
        inventory.dependencies.push({ name, version, installed: true, spec: version });
      }
      if (summary) summary.pluginCount = inventory.dependencies.length;
      return ok({
        bundles: inventory.bundles.map((b) => ({ ...b })),
        dependencies: inventory.dependencies.map((d) => ({ ...d })),
        profileDir: inventory.profileDir,
      });
    },

    remove: async (instanceId: string, name: string): Promise<Result<PluginInventory>> => {
      const inventory = this.inventoryOf(instanceId);
      if (!inventory) return err(`找不到实例：${instanceId}`);
      const summary = this.byId(instanceId);
      if (summary && summary.runtime.state === 'running') {
        return err('实例正在运行，插件变更需先停止实例');
      }
      const bundle = inventory.bundles.find((b) => b.name === name);
      if (bundle && bundle.builtin) {
        return err('内置组合包由 dsh 提供，无法卸载；如需关闭请在列表中停用');
      }
      if (!bundle && !inventory.dependencies.some((d) => d.name === name)) {
        return err(`未找到插件：${name}`);
      }
      this.stream(instanceId, [
        ['system', `卸载插件 ${name}`],
        ['stdout', `dsh plugin --profile ${summary?.meta.profile.name ?? 'main'} remove ${name}`],
      ]);
      await this.delay(820);
      inventory.dependencies = inventory.dependencies.filter((d) => d.name !== name);
      inventory.bundles = inventory.bundles.filter((b) => b.name !== name);
      if (summary) summary.pluginCount = inventory.dependencies.length;
      return ok({
        bundles: inventory.bundles.map((b) => ({ ...b })),
        dependencies: inventory.dependencies.map((d) => ({ ...d })),
        profileDir: inventory.profileDir,
      });
    },

    setBundleEnabled: async (
      instanceId: string,
      name: string,
      enabled: boolean,
    ): Promise<Result<PluginInventory>> => {
      const inventory = this.inventoryOf(instanceId);
      if (!inventory) return err(`找不到实例：${instanceId}`);
      const bundle = inventory.bundles.find((b) => b.name === name);
      if (!bundle) return err(`未找到组合包：${name}`);
      const summary = this.byId(instanceId);
      if (summary && summary.runtime.state === 'running') {
        return err('实例正在运行，组合包开关需先停止实例');
      }
      await this.delay(320);
      bundle.enabled = enabled;
      this.emitLog(
        instanceId,
        'system',
        `${enabled ? '启用' : '停用'}组合包 ${name}（已更新 dsh.profile.bundles 并整块重述 patch）`,
      );
      return ok({
        bundles: inventory.bundles.map((b) => ({ ...b })),
        dependencies: inventory.dependencies.map((d) => ({ ...d })),
        profileDir: inventory.profileDir,
      });
    },

    install: async (
      instanceId: string,
      source: PluginSource,
    ): Promise<Result<PluginInstallResult>> => {
      const inventory = this.inventoryOf(instanceId);
      const summary = this.byId(instanceId);
      if (!inventory || !summary) return err(`找不到实例：${instanceId}`);
      if (summary.runtime.state === 'running') return err('实例正在运行，插件变更需先停止实例');

      // 演示模式的来源解析：zip 取文件名、GitHub 取 owner/repo、文件夹取末段目录名
      let name: string;
      let origin: PluginSummary['origin'];
      let spec: string;
      let command: string;
      if (source.kind === 'archive') {
        name = source.name ?? baseName(source.file).replace(/\.zip$/i, '');
        origin = 'archive';
        spec = `file:../../plugins/${name}`;
        command = `dsh plugin --profile ${summary.meta.profile.name} install`;
      } else if (source.kind === 'github') {
        const parts = source.url.replace(/^https?:\/\/github\.com\//i, '').split('/');
        name = parts[1] ?? parts[0] ?? 'github-plugin';
        origin = 'github';
        spec = `github:${parts[0] ?? 'owner'}/${name}`;
        command = `dsh plugin --profile ${summary.meta.profile.name} add ${spec}`;
      } else {
        name = baseName(source.dir);
        origin = 'folder';
        spec = `link:${source.dir}`;
        command = `dsh plugin --profile ${summary.meta.profile.name} add ${source.dir}`;
      }
      if (name.trim().length === 0) return err('无法从来源解析出插件名');
      if (!/^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i.test(name)) return err(`插件名不合法：${name}`);

      this.stream(instanceId, [
        ['system', `安装本地插件 ${name}（${origin}）`],
        ['stdout', command],
        ['stdout', `插件已就位：<实例>/home/plugins/${name}`],
        ['stdout', '已写入 profile 依赖与 dsh.profile.bundles'],
      ]);
      await this.delay(1100);

      const version = '1.0.0';
      if (!inventory.dependencies.some((d) => d.name === name)) {
        inventory.dependencies.push({ name, version, installed: true, spec });
      }
      if (!inventory.bundles.some((b) => b.name === name)) {
        inventory.bundles.push({
          name,
          enabled: true,
          description: null,
          version,
          builtin: false,
        });
      }
      const list = this.localPlugins.get(instanceId) ?? [];
      const dir = `${ROOT}\\instances\\${summary.meta.dirName}\\home\\plugins\\${name}`;
      const existing = list.find((item) => item.name === name);
      if (existing) {
        existing.version = version;
        existing.origin = origin;
        existing.spec = spec;
        existing.enabled = true;
      } else {
        list.push({
          name,
          version,
          dir,
          origin,
          enabled: true,
          hasBundlePatch: true,
          hasClient: false,
          description: null,
          patchFileExists: true,
          spec,
        });
      }
      this.localPlugins.set(instanceId, list);
      if (summary) summary.pluginCount = inventory.dependencies.length;
      return ok({
        name,
        version,
        dir,
        spec,
        registeredBundle: true,
        linked: true,
        warnings: [],
        inventory: {
          bundles: inventory.bundles.map((b) => ({ ...b })),
          dependencies: inventory.dependencies.map((d) => ({ ...d })),
          profileDir: inventory.profileDir,
        },
      });
    },

    removeLocal: async (instanceId: string, name: string): Promise<Result<PluginInventory>> => {
      const inventory = this.inventoryOf(instanceId);
      const summary = this.byId(instanceId);
      if (!inventory || !summary) return err(`找不到实例：${instanceId}`);
      if (summary.runtime.state === 'running') return err('实例正在运行，插件变更需先停止实例');
      const list = this.localPlugins.get(instanceId) ?? [];
      if (!list.some((item) => item.name === name)) return err(`实例内没有本地插件：${name}`);
      this.stream(instanceId, [
        ['system', `卸载本地插件 ${name}`],
        ['stdout', `dsh plugin --profile ${summary.meta.profile.name} install`],
        ['stdout', `已删除 <实例>/home/plugins/${name}`],
      ]);
      await this.delay(900);
      this.localPlugins.set(
        instanceId,
        list.filter((item) => item.name !== name),
      );
      inventory.dependencies = inventory.dependencies.filter((d) => d.name !== name);
      inventory.bundles = inventory.bundles.filter((b) => b.name !== name);
      summary.pluginCount = inventory.dependencies.length;
      return ok({
        bundles: inventory.bundles.map((b) => ({ ...b })),
        dependencies: inventory.dependencies.map((d) => ({ ...d })),
        profileDir: inventory.profileDir,
      });
    },

    listLocal: async (instanceId: string): Promise<Result<PluginSummary[]>> => {
      if (!this.byId(instanceId)) return err(`找不到实例：${instanceId}`);
      await this.delay(160);
      return ok((this.localPlugins.get(instanceId) ?? []).map((item) => ({ ...item })));
    },

    pickArchive: async (): Promise<Result<string | null>> => {
      await this.delay(200);
      this.emitLog('', 'system', '（演示模式）已模拟选择插件压缩包：dsh-demo-plugin.zip');
      return ok(`${ROOT}\\下载\\dsh-demo-plugin.zip`);
    },

    pickFolder: async (): Promise<Result<string | null>> => {
      await this.delay(200);
      this.emitLog('', 'system', '（演示模式）已模拟选择插件文件夹：F:\\dev\\dsh-demo-plugin');
      return ok('F:\\dev\\dsh-demo-plugin');
    },
  };

  /* ── 设置 ─────────────────────────────────────────────────── */

  settings: WhalesApi['settings'] = {
    read: async (instanceId: string): Promise<Result<string>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      await this.delay(180);
      return ok(this.settingsStore.get(instanceId) ?? '# $DSH_HOME/settings.yaml\n');
    },

    write: async (instanceId: string, yaml: string): Promise<Result<void>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      if (yaml.trim().length === 0) return err('settings.yaml 内容不能为空');
      if (summary.runtime.state === 'running') {
        return err('实例正在运行，设置变更需先停止实例');
      }
      await this.delay(420);
      this.settingsStore.set(instanceId, yaml);
      this.emitLog(instanceId, 'system', 'settings.yaml 已保存（写入前已生成 .bak 备份）');
      return ok(undefined);
    },

    /** QR-15：未解决的共享设置冲突（真实实现由 core 维护，IPC 层包成 Promise）。 */
    shareConflicts: async (instanceId: string): Promise<Result<ShareConflict[]>> => {
      await this.delay(60);
      return ok((this.conflicts.get(instanceId) ?? []).map((item) => ({ ...item })));
    },

    /** QR-15：解决冲突；use-local 把本地推给共享，use-shared 用共享覆盖本地。 */
    resolveShareConflict: async (
      instanceId: string,
      resolution: ShareConflictResolution,
    ): Promise<Result<void>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      const pending = this.conflicts.get(instanceId) ?? [];
      if (pending.length === 0) return err('该实例没有待解决的设置冲突');
      await this.delay(420);
      const local = this.settingsStore.get(instanceId) ?? '';
      if (resolution === 'use-local') {
        this.settingsStore.set(`shared:${instanceId}`, local);
        this.emitLog(instanceId, 'system', '已用本地设置覆盖共享设置（旧共享文件已备份为 .bak-<时间戳>）');
      } else {
        const shared = this.settingsStore.get(`shared:${instanceId}`) ?? local;
        this.settingsStore.set(instanceId, shared);
        this.emitLog(instanceId, 'system', '已用共享设置覆盖本地设置（旧本地文件已备份为 .bak-<时间戳>）');
      }
      this.clearConflict(instanceId);
      return ok(undefined);
    },
  };

  /* ── 存档 ─────────────────────────────────────────────────── */

  saves: WhalesApi['saves'] = {
    list: async (instanceId: string): Promise<Result<SessionInfo[]>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      await this.delay(200);
      const list = (this.sessions.get(instanceId) ?? []).slice();
      list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return ok(list);
    },

    openFolder: async (instanceId: string, sessionId?: string): Promise<Result<void>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      const target = sessionId
        ? ((this.sessions.get(instanceId) ?? []).find((s) => s.id === sessionId)?.dir ??
          `${ROOT}\\instances\\${summary.meta.dirName}\\home\\sessions`)
        : `${ROOT}\\instances\\${summary.meta.dirName}\\home\\sessions`;
      this.emitLog(instanceId, 'system', `（演示模式）已模拟定位目录：${target}`);
      await this.delay(140);
      return ok(undefined);
    },
  };

  /* ── 实例包 ───────────────────────────────────────────────── */

  pack: WhalesApi['pack'] = {
    export: async (instanceId: string): Promise<Result<string | null>> => {
      const summary = this.byId(instanceId);
      if (!summary) return err(`找不到实例：${instanceId}`);
      this.stream(instanceId, [
        ['system', `导出实例包「${summary.meta.name}」`],
        ['stdout', '正在打包 profile 配置与 settings.yaml（不含 node_modules）…'],
      ]);
      await this.delay(760);
      const stamp = new Date().toISOString().slice(0, 10);
      const file = `${ROOT}\\export\\${summary.meta.name}-${stamp}.zip`;
      this.emitLog(instanceId, 'system', `实例包已生成：${file}`);
      return ok(file);
    },

    import: async (): Promise<Result<ImportResult | null>> => {
      this.emitLog('', 'system', '（演示模式）已模拟选择实例包文件：demo-web-pack.zip');
      await this.delay(900);
      const id = `ins-import-${Date.now().toString(36)}`;
      const name = `导入的实例 ${this.summaries.length + 1}`;
      const meta: InstanceMeta = {
        schemaVersion: 1,
        id,
        name,
        dirName: `imported-${this.summaries.length + 1}`,
        icon: '📥',
        color: '#4D8DFF',
        note: '由实例包导入（演示数据）',
        engine: { version: '0.1.6-alpha.2' },
        profile: { name: 'main', template: 'web' },
        workspace: { mode: 'local' },
        saves: { mode: 'local' },
        settings: { mode: 'local' },
        credentials: { mode: 'inherit' },
        launch: { appArgs: [], autoOpenBrowser: true },
        createdAt: new Date().toISOString(),
        lastLaunchedAt: null,
        launchCount: 0,
      };
      const inventory = this.buildInventory(meta);
      this.inventories.set(id, inventory);
      this.settingsStore.set(id, DEMO_SETTINGS['ins-workbench'] ?? '');
      this.sessions.set(id, []);
      this.summaries.push({
        meta,
        runtime: {
          instanceId: id,
          state: 'stopped',
          pid: null,
          startedAt: null,
          url: null,
          port: null,
          exitCode: null,
          lastError: null,
        },
        present: true,
        engineInstalled: this.isInstalled(meta.engine.version),
        pluginCount: inventory.dependencies.length,
      });
      this.stream(id, [
        ['system', '正在校验实例包清单（whalelauncher-pack.json）…'],
        ['stdout', '正在重建 profile：web 模板，2 个组合包'],
        ['stdout', '正在重装依赖：@deepseek-ai/dsh-plugin-memory, cordis-plugin-timer …'],
        ['system', '导入完成，实例已加入列表'],
      ]);
      return ok({
        instanceId: id,
        name,
        warnings: ['实例包不包含 node_modules，依赖已按清单重新安装（演示数据为模拟结果）'],
      });
    },

    pickFile: async (): Promise<Result<string | null>> => {
      await this.delay(200);
      return ok(`${ROOT}\\export\\demo-web-pack.zip`);
    },
  };

  /* ── 应用 ─────────────────────────────────────────────────── */

  app: WhalesApi['app'] = {
    version: async (): Promise<Result<string>> => ok('1.0.0'),
    openExternal: async (url: string): Promise<Result<void>> => {
      this.emitLog('', 'system', `（演示模式）已模拟打开外部地址：${url}`);
      await this.delay(120);
      return ok(undefined);
    },
    menu: async (): Promise<Result<MenuNode[]>> => ok(demoMenuTree().map((node) => ({ ...node }))),
    menuCommand: async (id: string): Promise<Result<void>> => {
      // 演示模式没有主进程：只记录，具体效果由渲染层的等价实现承担
      this.emitLog('', 'system', `（演示模式）菜单命令：${id}`);
      await this.delay(60);
      return ok(undefined);
    },
  };

  onLog(cb: (chunk: LogChunk) => void): () => void {
    this.logSubs.add(cb);
    return () => {
      this.logSubs.delete(cb);
    };
  }

  onState(cb: (runtime: InstanceRuntime) => void): () => void {
    this.stateSubs.add(cb);
    return () => {
      this.stateSubs.delete(cb);
    };
  }
}

/** 创建演示后端实例。 */
export function createDemoApi(): WhalesApi {
  return new DemoApi();
}
