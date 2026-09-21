/**
 * 后端访问入口
 *
 * 渲染层**只**允许通过 `window.whales`（`WhalesApi`）访问后端。
 * 这里做三件事：
 *   1. 探测 `window.whales` 是否可用；不可用时切换到内置演示后端（便于独立预览界面）；
 *   2. 把每个方法包一层防御：接口缺失、同步抛错、Promise 拒绝都转成 `Result.ok === false`；
 *   3. 保证 `onLog` / `onState` 永远返回可调用的取消订阅函数。
 */
import type { InstanceRuntime, LogChunk, Result, WhalesApi } from '../../shared/contracts';
import { describeError } from '../util/result';
import { createDemoApi } from './demo';

export interface BackendHandle {
  api: WhalesApi;
  /** 是否处于内置演示数据模式。 */
  demo: boolean;
  /** 降级原因（中文，演示模式时非空）。 */
  reason: string | null;
}

let cached: BackendHandle | null = null;

/** 取得后端句柄（首次调用时探测并缓存）。 */
export function backend(): BackendHandle {
  if (cached) return cached;
  const raw = readWhales();
  if (raw) {
    cached = { api: guard(raw), demo: false, reason: null };
  } else {
    cached = {
      api: createDemoApi(),
      demo: true,
      reason:
        '未检测到 window.whales —— 后端（Electron 主进程 / preload）尚未就绪。当前展示内置演示数据，所有操作仅作用于内存。',
    };
  }
  return cached;
}

/** 便捷判断：是否演示模式。 */
export function isDemo(): boolean {
  return backend().demo;
}

function readWhales(): WhalesApi | null {
  try {
    const candidate = (window as unknown as { whales?: unknown }).whales;
    if (!candidate || typeof candidate !== 'object') return null;
    const api = candidate as Partial<WhalesApi>;
    if (!api.instance || typeof api.instance.list !== 'function') return null;
    if (!api.engine || typeof api.engine.list !== 'function') return null;
    return candidate as WhalesApi;
  } catch {
    return null;
  }
}

/** 调用一个可能缺失的异步接口，永不抛出。 */
function invoke<T>(fn: (() => Promise<Result<T>>) | undefined, label: string): Promise<Result<T>> {
  if (typeof fn !== 'function') {
    return Promise.resolve({ ok: false, error: `后端未实现接口 ${label}（preload 可能尚未就绪）` });
  }
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.catch((error: unknown) => ({ ok: false as const, error: describeError(error) }));
    }
    return Promise.resolve({ ok: false, error: `接口 ${label} 未返回 Promise` });
  } catch (error) {
    return Promise.resolve({ ok: false, error: describeError(error) });
  }
}

/** 订阅一个可能缺失的推送接口，永远返回可调用的退订函数。 */
function subscribe<T>(fn: ((cb: (payload: T) => void) => () => void) | undefined, cb: (payload: T) => void): () => void {
  if (typeof fn !== 'function') return () => undefined;
  try {
    const off = fn(cb);
    return typeof off === 'function' ? off : () => undefined;
  } catch {
    return () => undefined;
  }
}

function guard(raw: WhalesApi): WhalesApi {
  const launcher = raw.launcher;
  const instance = raw.instance;
  const engine = raw.engine;
  const plugin = raw.plugin;
  const settings = raw.settings;
  const saves = raw.saves;
  const pack = raw.pack;
  const app = raw.app;

  return {
    launcher: {
      getConfig: () =>
        invoke(launcher?.getConfig ? () => launcher.getConfig() : undefined, 'launcher.getConfig'),
      setConfig: (patch) =>
        invoke(launcher?.setConfig ? () => launcher.setConfig(patch) : undefined, 'launcher.setConfig'),
      detectNode: (refresh) =>
        invoke(
          launcher?.detectNode ? () => launcher.detectNode(refresh) : undefined,
          'launcher.detectNode',
        ),
    },
    instance: {
      list: () => invoke(instance?.list ? () => instance.list() : undefined, 'instance.list'),
      create: (input) =>
        invoke(instance?.create ? () => instance.create(input) : undefined, 'instance.create'),
      get: (id) => invoke(instance?.get ? () => instance.get(id) : undefined, 'instance.get'),
      update: (id, patch) =>
        invoke(instance?.update ? () => instance.update(id, patch) : undefined, 'instance.update'),
      remove: (id, deleteFiles) =>
        invoke(
          instance?.remove ? () => instance.remove(id, deleteFiles) : undefined,
          'instance.remove',
        ),
      launch: (req) =>
        invoke(instance?.launch ? () => instance.launch(req) : undefined, 'instance.launch'),
      stop: (id) => invoke(instance?.stop ? () => instance.stop(id) : undefined, 'instance.stop'),
      openFolder: (id, which) =>
        invoke(
          instance?.openFolder ? () => instance.openFolder(id, which) : undefined,
          'instance.openFolder',
        ),
    },
    engine: {
      list: () => invoke(engine?.list ? () => engine.list() : undefined, 'engine.list'),
      available: () =>
        invoke(engine?.available ? () => engine.available() : undefined, 'engine.available'),
      install: (version) =>
        invoke(engine?.install ? () => engine.install(version) : undefined, 'engine.install'),
      remove: (version) =>
        invoke(engine?.remove ? () => engine.remove(version) : undefined, 'engine.remove'),
    },
    plugin: {
      inventory: (instanceId) =>
        invoke(
          plugin?.inventory ? () => plugin.inventory(instanceId) : undefined,
          'plugin.inventory',
        ),
      add: (instanceId, spec) =>
        invoke(plugin?.add ? () => plugin.add(instanceId, spec) : undefined, 'plugin.add'),
      remove: (instanceId, name) =>
        invoke(
          plugin?.remove ? () => plugin.remove(instanceId, name) : undefined,
          'plugin.remove',
        ),
      setBundleEnabled: (instanceId, name, enabled) =>
        invoke(
          plugin?.setBundleEnabled
            ? () => plugin.setBundleEnabled(instanceId, name, enabled)
            : undefined,
          'plugin.setBundleEnabled',
        ),
      install: (instanceId, source) =>
        invoke(plugin?.install ? () => plugin.install(instanceId, source) : undefined, 'plugin.install'),
      removeLocal: (instanceId, name) =>
        invoke(
          plugin?.removeLocal ? () => plugin.removeLocal(instanceId, name) : undefined,
          'plugin.removeLocal',
        ),
      listLocal: (instanceId) =>
        invoke(plugin?.listLocal ? () => plugin.listLocal(instanceId) : undefined, 'plugin.listLocal'),
      pickArchive: () =>
        invoke(plugin?.pickArchive ? () => plugin.pickArchive() : undefined, 'plugin.pickArchive'),
      pickFolder: () =>
        invoke(plugin?.pickFolder ? () => plugin.pickFolder() : undefined, 'plugin.pickFolder'),
    },
    settings: {
      read: (instanceId) =>
        invoke(settings?.read ? () => settings.read(instanceId) : undefined, 'settings.read'),
      write: (instanceId, yaml) =>
        invoke(
          settings?.write ? () => settings.write(instanceId, yaml) : undefined,
          'settings.write',
        ),
      // QR-15：共享设置冲突（core 同步实现，IPC 层包成 Promise）
      shareConflicts: (instanceId) =>
        invoke(
          settings?.shareConflicts ? () => settings.shareConflicts(instanceId) : undefined,
          'settings.shareConflicts',
        ),
      resolveShareConflict: (instanceId, resolution) =>
        invoke(
          settings?.resolveShareConflict
            ? () => settings.resolveShareConflict(instanceId, resolution)
            : undefined,
          'settings.resolveShareConflict',
        ),
    },
    saves: {
      list: (instanceId) =>
        invoke(saves?.list ? () => saves.list(instanceId) : undefined, 'saves.list'),
      openFolder: (instanceId, sessionId) =>
        invoke(
          saves?.openFolder ? () => saves.openFolder(instanceId, sessionId) : undefined,
          'saves.openFolder',
        ),
    },
    pack: {
      export: (instanceId) =>
        invoke(pack?.export ? () => pack.export(instanceId) : undefined, 'pack.export'),
      import: () => invoke(pack?.import ? () => pack.import() : undefined, 'pack.import'),
      pickFile: () => invoke(pack?.pickFile ? () => pack.pickFile() : undefined, 'pack.pickFile'),
    },
    app: {
      version: () => invoke(app?.version ? () => app.version() : undefined, 'app.version'),
      openExternal: (url) =>
        invoke(
          app?.openExternal ? () => app.openExternal(url) : undefined,
          'app.openExternal',
        ),
      menu: () => invoke(app?.menu ? () => app.menu() : undefined, 'app.menu'),
      menuCommand: (id) =>
        invoke(app?.menuCommand ? () => app.menuCommand(id) : undefined, 'app.menuCommand'),
    },
    onLog: (cb) => subscribe<LogChunk>(raw?.onLog, cb),
    onState: (cb) => subscribe<InstanceRuntime>(raw?.onState, cb),
  };
}
