/**
 * WhalesLauncher preload —— 渲染层唯一的能力出口。
 *
 * 安全约束（对应 T2 硬性要求）：
 *  - 只通过 `contextBridge.exposeInMainWorld('whales', api)` 暴露 `WhalesApi` 形状的方法；
 *  - **绝不**把 `ipcRenderer`（以及 require / process / Buffer 等 Node 能力）交给页面；
 *  - 通道名一律取自冻结契约 `CH`，杜绝 main 与 preload 之间的通道名漂移；
 *  - `onLog`/`onState` 只做"订阅 + 返回取消订阅函数"，不给页面任何 event 对象。
 *
 * 本文件必须打成 CJS（build.mjs 已配置），因为 sandbox:true 的 preload 不支持 ESM。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { CH } from '../shared/contracts.js';
import type {
  CreateInstanceInput,
  EngineInfo,
  ImportResult,
  InstanceRuntime,
  InstanceSummary,
  LaunchRequest,
  LaunchResult,
  LauncherConfig,
  LogChunk,
  MenuNode,
  NodeRuntimeReport,
  PluginInstallResult,
  PluginInventory,
  PluginSource,
  PluginSummary,
  Result,
  SessionInfo,
  ShareConflict,
  ShareConflictResolution,
  UpdateInstancePatch,
  WhalesApi,
} from '../shared/contracts.js';

/** 所有请求统一返回 `Result<T>`（main 侧已保证异常不穿透）。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;
}

/** 订阅 main 推送；返回幂等的取消订阅函数。 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: WhalesApi = {
  launcher: {
    getConfig: () => invoke<LauncherConfig>(CH.launcher.getConfig),
    setConfig: (patch: Partial<LauncherConfig>) =>
      invoke<LauncherConfig>(CH.launcher.setConfig, patch),
    detectNode: (refresh?: boolean) =>
      invoke<NodeRuntimeReport>(CH.launcher.detectNode, refresh === true),
  },

  instance: {
    list: () => invoke<InstanceSummary[]>(CH.instance.list),
    create: (input: CreateInstanceInput) => invoke<InstanceSummary>(CH.instance.create, input),
    get: (id: string) => invoke<InstanceSummary>(CH.instance.get, id),
    update: (id: string, patch: UpdateInstancePatch) =>
      invoke<InstanceSummary>(CH.instance.update, id, patch),
    remove: (id: string, deleteFiles: boolean) =>
      invoke<void>(CH.instance.remove, id, deleteFiles),
    launch: (req: LaunchRequest) => invoke<LaunchResult>(CH.instance.launch, req),
    stop: (id: string) => invoke<void>(CH.instance.stop, id),
    openFolder: (id: string, which: 'root' | 'home' | 'workspace' | 'logs') =>
      invoke<void>(CH.instance.openFolder, id, which),
  },

  engine: {
    list: () => invoke<EngineInfo[]>(CH.engine.list),
    available: () => invoke<string[]>(CH.engine.available),
    install: (version: string) => invoke<EngineInfo>(CH.engine.install, version),
    remove: (version: string) => invoke<void>(CH.engine.remove, version),
  },

  plugin: {
    inventory: (instanceId: string) => invoke<PluginInventory>(CH.plugin.inventory, instanceId),
    add: (instanceId: string, spec: string) =>
      invoke<PluginInventory>(CH.plugin.add, instanceId, spec),
    remove: (instanceId: string, name: string) =>
      invoke<PluginInventory>(CH.plugin.remove, instanceId, name),
    setBundleEnabled: (instanceId: string, name: string, enabled: boolean) =>
      invoke<PluginInventory>(CH.plugin.setBundleEnabled, instanceId, name, enabled),
    install: (instanceId: string, source: PluginSource) =>
      invoke<PluginInstallResult>(CH.plugin.install, instanceId, source),
    removeLocal: (instanceId: string, name: string) =>
      invoke<PluginInventory>(CH.plugin.removeLocal, instanceId, name),
    listLocal: (instanceId: string) => invoke<PluginSummary[]>(CH.plugin.listLocal, instanceId),
    pickArchive: () => invoke<string | null>(CH.plugin.pickArchive),
    pickFolder: () => invoke<string | null>(CH.plugin.pickFolder),
  },

  settings: {
    read: (instanceId: string) => invoke<string>(CH.settings.read, instanceId),
    write: (instanceId: string, yaml: string) =>
      invoke<void>(CH.settings.write, instanceId, yaml),
    shareConflicts: (instanceId: string) =>
      invoke<ShareConflict[]>(CH.settings.shareConflicts, instanceId),
    resolveShareConflict: (instanceId: string, resolution: ShareConflictResolution) =>
      invoke<void>(CH.settings.resolveShareConflict, instanceId, resolution),
  },

  saves: {
    list: (instanceId: string) => invoke<SessionInfo[]>(CH.saves.list, instanceId),
    openFolder: (instanceId: string, sessionId?: string) =>
      invoke<void>(CH.saves.openFolder, instanceId, sessionId),
  },

  pack: {
    export: (instanceId: string) => invoke<string | null>(CH.pack.export, instanceId),
    import: () => invoke<ImportResult | null>(CH.pack.import),
    pickFile: () => invoke<string | null>(CH.pack.pickFile),
  },

  app: {
    version: () => invoke<string>(CH.app.version),
    openExternal: (url: string) => invoke<void>(CH.app.openExternal, url),
    /** 自绘菜单结构（主进程 `menuSpec()` 的唯一投影）。 */
    menu: () => invoke<MenuNode[]>(CH.app.menu),
    /** 回传被点击的菜单项 id（`MenuNode.id`）。 */
    menuCommand: (id: string) => invoke<void>(CH.app.menuCommand, id),
  },

  onLog: (cb: (chunk: LogChunk) => void) => subscribe<LogChunk>(CH.log.chunk, cb),
  onState: (cb: (runtime: InstanceRuntime) => void) =>
    subscribe<InstanceRuntime>(CH.log.state, cb),
};

contextBridge.exposeInMainWorld('whales', api);
