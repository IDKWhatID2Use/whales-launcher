/**
 * IPC 路由：逐条实现冻结契约 `CH` 中的每一个 invoke 通道。
 *
 * 铁律（对应 T2 硬性要求）：
 *  1. 每个 handler 都在 try/catch 里执行，统一返回 `Result<T>`，异常绝不穿透 IPC；
 *  2. 渲染层传来的参数一律先校验（它可能是任何东西），校验失败给出可读中文错误；
 *  3. core 抛出的底层异常经 `describeError()` 翻译成"用户能照着做"的提示。
 *
 * 通道覆盖由 `assertChannelCoverage()` 在启动时自检：漏掉任何一条 invoke 通道会直接报错。
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { core } from '../core/index.js';
import { CH, err, ok } from '../shared/contracts.js';
import type {
  CreateInstanceInput,
  CredentialsMode,
  InstanceMeta,
  InstanceSummary,
  LaunchRequest,
  PluginSource,
  Result,
  ShareConflictResolution,
  ShareMode,
  UpdateInstancePatch,
} from '../shared/contracts.js';
import { launcherRoot, loadConfig, rememberInstance, saveConfig, withRoot } from './config.js';
import { AppError, describeError } from './errors.js';
import { menuNodes, runMenuCommandById } from './menu.js';
import { LAUNCHER_LOG_ID, broadcastState, launchHooks, logSink, systemLog } from './runtime.js';
import { applyThemeToAllWindows, normalizeTheme } from './theme.js';

/** 只出现在 main → renderer 方向、无需 invoke 的通道。 */
const PUSH_ONLY_CHANNELS: ReadonlySet<string> = new Set<string>([CH.log.chunk, CH.log.state]);

type Handler = (...args: unknown[]) => Promise<unknown> | unknown;

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/** 注册全部 IPC handler；重复调用安全（先摘掉旧 handler）。 */
export function registerIpcHandlers(): void {
  const handlers = buildHandlers();

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<unknown>> => {
      try {
        return ok(await handler(...args));
      } catch (error) {
        console.error(`[ipc] ${channel} 失败：`, error);
        return err(describeError(error));
      }
    });
  }

  assertChannelCoverage(handlers);
}

/** 启动自检：契约里的每条 invoke 通道都必须有实现。 */
function assertChannelCoverage(handlers: Record<string, Handler>): void {
  const missing: string[] = [];
  for (const group of Object.values(CH)) {
    for (const channel of Object.values(group)) {
      if (PUSH_ONLY_CHANNELS.has(channel)) continue;
      if (!Object.prototype.hasOwnProperty.call(handlers, channel)) missing.push(channel);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[ipc] 契约通道未实现：${missing.join(', ')}`);
  }
}

function buildHandlers(): Record<string, Handler> {
  return {
    /* ---------------- launcher ---------------- */

    [CH.launcher.getConfig]: async () => withRoot(await loadConfig()),

    [CH.launcher.setConfig]: async (patch) => {
      const config = await saveConfig(patch);
      // 规范 ui-redesign.md §4.9 / 反例 F-08：主题切换必须由主进程同步 WCO 与背景色 ——
      // titleBarOverlay 是主进程选项、CSS 无权改，缺这一步标题栏按钮区会停留在旧主题色。
      applyThemeToAllWindows(normalizeTheme(config.theme));
      return withRoot(config);
    },

    /**
     * 探测运行 dsh 的 Node 运行时。
     *
     * dsh 依赖的原生模块拒绝 Electron 内置运行时（本机 Electron 41 实测被拒），所以
     * 需要独立 Node.js；界面用这个通道展示"当前用哪个 node / 每个候选为何不可用"。
     */
    [CH.launcher.detectNode]: async (refresh?: unknown) =>
      core.detectNode(launcherRoot(), refresh === true),

    /* ---------------- instance ---------------- */

    [CH.instance.list]: async () => core.listInstances(launcherRoot()),

    [CH.instance.create]: async (input) => {
      const parsed = parseCreateInput(input);
      const root = launcherRoot();
      const meta = await core.createInstance(root, parsed, { onLog: logSink(LAUNCHER_LOG_ID) });
      systemLog(meta.id, `实例「${meta.name}」创建完成（引擎 ${meta.engine.version}）。`);
      return summarize(root, meta);
    },

    [CH.instance.get]: async (id) => summarize(launcherRoot(), await requireInstance(id)),

    [CH.instance.update]: async (id, patch) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const updated = await core.updateInstance(root, meta.id, parseUpdatePatch(patch));
      broadcastState(core.runtimeOf(updated.id));
      return summarize(root, updated);
    },

    [CH.instance.remove]: async (id, deleteFiles) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const runtime = core.runtimeOf(meta.id);
      if (runtime.state !== 'stopped' && runtime.state !== 'crashed') {
        throw new AppError(`实例「${meta.name}」正在运行，请先停止后再删除。`);
      }
      await core.deleteInstance(root, meta.id, mustBoolean(deleteFiles, '是否删除文件', false));
      return undefined;
    },

    [CH.instance.launch]: async (request) => {
      const req = parseLaunchRequest(request);
      const root = launcherRoot();
      const meta = await requireInstance(req.instanceId);

      const runtime = core.runtimeOf(meta.id);
      if (runtime.state === 'running' || runtime.state === 'starting') {
        throw new AppError(`实例「${meta.name}」已经在运行（PID ${runtime.pid ?? '未知'}）。`);
      }

      // 前置失败要比 core 深处的报错更好读：这里直接给出"去版本管理安装"的指引。
      if (core.resolveEngineBin(root, meta.engine.version) === null) {
        throw new AppError(
          `引擎 ${meta.engine.version} 未安装，请先在「版本管理」中安装该版本。`,
        );
      }

      const config = await loadConfig();
      const hooks = launchHooks(meta.id);
      let opened = false;

      const result = await core.launchInstance(root, meta, req, config, {
        onLog: hooks.onLog,
        onState: (state) => {
          hooks.onState(state);
          // web profile：拿到界面地址后按实例设置自动打开系统浏览器。
          if (!meta.launch.autoOpenBrowser || opened) return;
          const url = state.url;
          if (url === null || url.length === 0) return;
          opened = true;
          void shell.openExternal(url).catch((error: unknown) => {
            console.warn('[ipc] 自动打开界面失败：', error);
          });
        },
        onExit: hooks.onExit,
      });

      await rememberInstance(meta.id);
      broadcastState(core.runtimeOf(meta.id));
      return result;
    },

    [CH.instance.stop]: async (id) => {
      const meta = await requireInstance(id);
      await core.stopInstance(meta.id);

      const runtime = core.runtimeOf(meta.id);
      broadcastState(runtime);

      // `core.stopInstance` 按契约返回 void 且不拒绝：进程杀不掉时它保持 state='running'
      // 并写入 lastError。这里翻译成 Result 错误，避免 UI 收到"停止成功"的假信号
      // （与 T2 的强杀兜底同一原则：日志/提示不能说谎）。
      if (runtime.state !== 'stopped' && runtime.lastError !== null) {
        throw new AppError(runtime.lastError);
      }
      return undefined;
    },

    [CH.instance.openFolder]: async (id, which) => {
      await openInstanceFolder(id, which);
      return undefined;
    },

    /* ---------------- engine ---------------- */

    [CH.engine.list]: async () => core.listEngines(launcherRoot()),

    [CH.engine.available]: async () => {
      const config = await loadConfig();
      // QA F1：显式传启动器根，让 npm `--cache` 一定落在工作区内。
      // 契约 `CoreApi.listAvailableEngines(registry, root?)` 已声明该可选参数；
      // 另有两层兜底不会失效：① `index.ts` 的 pinLauncherRoot() 写入 `$WHALES_LAUNCHER_ROOT`
      // （core 的 defaultRootForCache() 优先读它）；② core 自己记住的 `lastRoot()`。
      // 显式优于隐式：这个调用点不再依赖"环境变量一定被正确设置"这个前提。
      return core.listAvailableEngines(config.engineRegistry, launcherRoot());
    },

    [CH.engine.install]: async (version) => {
      const target = mustString(version, '引擎版本');
      const config = await loadConfig();
      return core.installEngine(
        launcherRoot(),
        target,
        config.engineRegistry,
        logSink(LAUNCHER_LOG_ID),
      );
    },

    [CH.engine.remove]: async (version) => {
      const target = mustString(version, '引擎版本');
      const root = launcherRoot();
      const engines = await core.listEngines(root);
      const found = engines.find((engine) => engine.version === target);
      if (found === undefined) throw new AppError(`本机没有安装引擎 ${target}。`);
      if (found.usedBy.length > 0) {
        throw new AppError(
          `引擎 ${target} 正被 ${found.usedBy.length} 个实例使用，请先把这些实例切换到其它版本。`,
        );
      }
      await core.removeEngine(root, target);
      return undefined;
    },

    /* ---------------- plugin ---------------- */

    [CH.plugin.inventory]: async (id) =>
      core.readProfileInventory(launcherRoot(), await requireInstance(id)),

    [CH.plugin.add]: async (id, spec) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const packageSpec = mustString(spec, '插件包名');
      const config = await loadConfig();
      await core.pluginAdd(root, meta, packageSpec, config, logSink(meta.id));
      return core.readProfileInventory(root, meta);
    },

    [CH.plugin.remove]: async (id, name) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const pluginName = mustString(name, '插件名');
      const config = await loadConfig();
      await core.pluginRemove(root, meta, pluginName, config, logSink(meta.id));
      return core.readProfileInventory(root, meta);
    },

    [CH.plugin.setBundleEnabled]: async (id, name, enabled) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const bundleName = mustString(name, '组合包名');
      const flag = mustBoolean(enabled, '启用状态');
      await core.setBundleEnabled(root, meta, bundleName, flag);
      return core.readProfileInventory(root, meta);
    },

    /**
     * 安装「随实例搬运」的本地插件（zip / GitHub / 文件夹）。
     * 落点由 core 决定：zip 与文件夹复制到 `<实例>/home/plugins/<名>`，
     * GitHub 走 profile 的 `github:` 依赖。
     */
    [CH.plugin.install]: async (id, source) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const parsed = mustPluginSource(source);
      const config = await loadConfig();
      return core.pluginInstall(root, meta, parsed, config, logSink(meta.id));
    },

    [CH.plugin.removeLocal]: async (id, name) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const pluginName = mustString(name, '插件名');
      const config = await loadConfig();
      await core.pluginRemoveLocal(root, meta, pluginName, config, logSink(meta.id));
      return core.readProfileInventory(root, meta);
    },

    [CH.plugin.listLocal]: async (id) =>
      core.listInstancePlugins(launcherRoot(), await requireInstance(id)),

    [CH.plugin.pickArchive]: async () =>
      showOpenDialog({
        title: '选择插件压缩包',
        properties: ['openFile'],
        filters: [
          { name: '插件压缩包', extensions: ['zip'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      }),

    [CH.plugin.pickFolder]: async () =>
      showOpenDialog({ title: '选择插件文件夹（其中含 package.json）', properties: ['openDirectory'] }),

    /* ---------------- settings ---------------- */

    [CH.settings.read]: async (id) =>
      core.readInstanceSettings(launcherRoot(), await requireInstance(id)),

    [CH.settings.write]: async (id, yaml) => {
      const meta = await requireInstance(id);
      await core.writeInstanceSettings(
        launcherRoot(),
        meta,
        mustString(yaml, '设置内容', { allowEmpty: true }),
      );
      return undefined;
    },

    /**
     * 共享设置冲突列表（QR-15）。
     * `core.listShareConflicts` 是**同步**函数，这里用 async handler 自然满足契约的 `Promise` 形态。
     * 冲突记录由 core 在 `applyShareModes` 时生成（本地与共享都有内容且不同 → 保留本地 + 登记冲突），
     * 界面必须把它显示出来并让用户显式选择方向，否则"静默丢数据"会变成"静默不生效"。
     */
    [CH.settings.shareConflicts]: async (id) => core.listShareConflicts((await requireInstance(id)).id),

    /** 解决设置冲突：`use-local` 以本地覆盖共享，`use-shared` 以共享覆盖本地（core 会先备份、并清除冲突记录）。 */
    [CH.settings.resolveShareConflict]: async (id, resolution) => {
      const meta = await requireInstance(id);
      await core.resolveSettingsConflict(
        launcherRoot(),
        meta,
        mustShareConflictResolution(resolution),
      );
      return undefined;
    },

    /* ---------------- saves ---------------- */

    [CH.saves.list]: async (id) => core.listSessions(launcherRoot(), await requireInstance(id)),

    [CH.saves.openFolder]: async (id, sessionId) => {
      await openSavesFolder(id, sessionId);
      return undefined;
    },

    /* ---------------- pack ---------------- */

    [CH.pack.export]: async (id) => {
      const root = launcherRoot();
      const meta = await requireInstance(id);
      const suggested = `${sanitizeFileName(meta.name)}-${new Date().toISOString().slice(0, 10)}.whalepack.zip`;

      const options: Electron.SaveDialogOptions = {
        title: `导出实例包 —— ${meta.name}`,
        defaultPath: path.join(app.getPath('downloads'), suggested),
        filters: [{ name: 'WhalesLauncher 实例包', extensions: ['zip'] }],
      };
      const picked = await showSaveDialog(options);
      if (picked === null) return null;

      return core.exportPack(root, meta, picked, app.getVersion());
    },

    [CH.pack.import]: async () => {
      const root = launcherRoot();
      const options: Electron.OpenDialogOptions = {
        title: '选择要导入的实例包',
        properties: ['openFile'],
        filters: [
          { name: 'WhalesLauncher 实例包', extensions: ['zip'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      };
      const picked = await showOpenDialog(options);
      if (picked === null) return null;
      const config = await loadConfig();
      return core.importPack(root, picked, config, { onLog: logSink(LAUNCHER_LOG_ID) });
    },

    [CH.pack.pickFile]: async () => {
      const options: Electron.OpenDialogOptions = {
        title: '选择文件',
        properties: ['openFile'],
        filters: [
          { name: '实例包或配置', extensions: ['zip', 'json', 'yaml', 'yml'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      };
      return showOpenDialog(options);
    },

    /* ---------------- app ---------------- */

    [CH.app.version]: async () => app.getVersion(),

    [CH.app.openExternal]: async (url) => {
      await openExternalUrl(url);
      return undefined;
    },

    /**
     * 自绘菜单的数据来源：`menuSpec()` 的契约投影（纯数据，可直接结构化克隆）。
     * 菜单结构、标签与快捷键文本全部来自主进程，渲染层不得自建第二份定义（规范 §3.6）。
     */
    [CH.app.menu]: async () => menuNodes(hostWindow()),

    /**
     * 自绘菜单回传点击：`id` 来自 `MenuNode.id`。
     * 未知 id 走 AppError → 统一包装成 `{ok:false, error}`，不让异常穿透 IPC。
     */
    [CH.app.menuCommand]: async (id) => {
      await runMenuCommandById(mustString(id, '菜单命令 id'), hostWindow());
      return undefined;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 实例辅助
 * ------------------------------------------------------------------ */

async function requireInstance(rawId: unknown): Promise<InstanceMeta> {
  const id = mustString(rawId, '实例 ID');
  const meta = await core.readInstance(launcherRoot(), id);
  if (meta === null) {
    throw new AppError(`找不到实例（id：${id}），它可能已被删除。请刷新实例列表后重试。`);
  }
  return meta;
}

/** 聚合视图：优先用 core 的列表结果，取不到时依据元数据补一份等价视图。 */
async function summarize(root: string, meta: InstanceMeta): Promise<InstanceSummary> {
  const list = await core.listInstances(root);
  const found = list.find((item) => item.meta.id === meta.id);
  if (found !== undefined) return found;

  const paths = core.instancePaths(root, meta);
  return {
    meta,
    runtime: core.runtimeOf(meta.id),
    present: await core.pathExists(paths.root),
    engineInstalled: core.resolveEngineBin(root, meta.engine.version) !== null,
    pluginCount: 0,
  };
}

async function openInstanceFolder(rawId: unknown, rawWhich: unknown): Promise<void> {
  const meta = await requireInstance(rawId);
  const paths = core.instancePaths(launcherRoot(), meta);
  const which = mustString(rawWhich, '文件夹类型');
  const targets: Record<string, string | undefined> = {
    root: paths.root,
    home: paths.home,
    workspace: paths.workspace,
    logs: paths.logs,
    /** 随实例搬运的本地插件落点。 */
    plugins: paths.pluginsDir,
  };
  const target = targets[which];
  if (target === undefined) {
    throw new AppError(`未知的文件夹类型：${which}（可选：root、home、workspace、logs、plugins）。`);
  }
  // plugins 目录可能尚未创建（没装过本地插件）；先建出来，避免打开一个不存在的路径
  if (which === 'plugins') await core.ensureDir(target);
  await openPath(target);
}

async function openSavesFolder(rawId: unknown, rawSessionId: unknown): Promise<void> {
  const meta = await requireInstance(rawId);
  const root = launcherRoot();

  if (rawSessionId === undefined || rawSessionId === null || rawSessionId === '') {
    await openPath(core.instancePaths(root, meta).sessions);
    return;
  }

  const sessionId = mustString(rawSessionId, '会话 ID');
  const sessions = await core.listSessions(root, meta);
  const found = sessions.find((session) => session.id === sessionId);
  if (found === undefined) {
    throw new AppError(`找不到会话 ${sessionId}，请刷新存档列表后重试。`);
  }
  await openPath(found.dir);
}

/** 打开目录：先确保存在（自愈），再把失败原因回报给用户。 */
async function openPath(target: string): Promise<void> {
  await core.ensureDir(target);
  const error = await shell.openPath(target);
  if (error.length > 0) throw new AppError(`无法打开文件夹：${error}（${target}）`);
}

/* ------------------------------------------------------------------ *
 * 对话框辅助
 * ------------------------------------------------------------------ */

function hostWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused !== null && !focused.isDestroyed()) return focused;
  const first = BrowserWindow.getAllWindows()[0];
  return first !== undefined && !first.isDestroyed() ? first : null;
}

async function showSaveDialog(options: Electron.SaveDialogOptions): Promise<string | null> {
  const win = hostWindow();
  const result = win === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(win, options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

async function showOpenDialog(options: Electron.OpenDialogOptions): Promise<string | null> {
  const win = hostWindow();
  const result = win === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(win, options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

async function openExternalUrl(rawUrl: unknown): Promise<void> {
  const url = mustString(rawUrl, '链接');
  const parsed = parseUrl(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      `出于安全考虑，只允许打开 http/https 链接（收到 ${parsed.protocol}//）。`,
    );
  }
  try {
    await shell.openExternal(url);
  } catch (error) {
    throw new AppError(`无法用系统浏览器打开该链接：${describeError(error)}`);
  }
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new AppError(`链接格式不正确：${url}`);
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'instance';
}

/* ------------------------------------------------------------------ *
 * 参数校验 —— 渲染层传来的一律当"未知数据"处理
 * ------------------------------------------------------------------ */

function mustRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${label}格式不正确（应为对象）。`);
  }
  return value as Record<string, unknown>;
}

function mustString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new AppError(`${label}必须是字符串。`);
  if (options.allowEmpty === true) return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new AppError(`${label}不能为空。`);
  return trimmed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(`${label}必须是字符串。`);
  return value;
}

function mustBoolean(value: unknown, label: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError(`${label}必须是布尔值。`);
  return value;
}

function mustStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new AppError(`${label}必须是字符串数组。`);
  return value.map((item, index) => mustString(item, `${label}第 ${index + 1} 项`));
}

/**
 * 校验本地插件来源（renderer 只能给出契约里的三种形状之一）。
 *
 * 这里把 UNKNOWN 值挡在 core 之外：core 会拿它去拼 pnpm 参数，任何未识别的
 * kind 都必须在边界处失败，而不是被当成"没传"。
 * @param value IPC 传入的原始值。
 * @returns 通过校验的来源描述。
 * @throws 形状不对时抛 {@link AppError}。
 */
function mustPluginSource(value: unknown): PluginSource {
  if (value === null || typeof value !== 'object') throw new AppError('插件来源格式错误。');
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'archive') {
    const file = mustString((value as { file?: unknown }).file, '插件压缩包路径');
    const name = optionalString((value as { name?: unknown }).name, '插件名');
    return name === undefined ? { kind: 'archive', file } : { kind: 'archive', file, name };
  }
  if (kind === 'github') {
    const url = mustString((value as { url?: unknown }).url, 'GitHub 地址');
    const ref = optionalString((value as { ref?: unknown }).ref, 'GitHub ref');
    return ref === undefined ? { kind: 'github', url } : { kind: 'github', url, ref };
  }
  if (kind === 'folder') {
    return { kind: 'folder', dir: mustString((value as { dir?: unknown }).dir, '插件文件夹路径') };
  }
  throw new AppError(`未知的插件来源：${JSON.stringify(kind)}（只支持 archive / github / folder）。`);
}

function mustShareMode(value: unknown, label: string): ShareMode {
  const mode = mustString(value, label);
  if (mode !== 'local' && mode !== 'shared') {
    throw new AppError(`${label}只能是 local（独立）或 shared（共享）。`);
  }
  return mode;
}

function mustCredentialsMode(value: unknown, label: string): CredentialsMode {
  const mode = mustString(value, label);
  if (mode !== 'inherit' && mode !== 'local') {
    throw new AppError(`${label}只能是 inherit（继承主 home）或 local（本实例独立）。`);
  }
  return mode;
}

/** 共享冲突的解决方向：只接受契约里的两个字面量，绝不把未知值传给 core。 */
function mustShareConflictResolution(value: unknown): ShareConflictResolution {
  const resolution = mustString(value, '冲突解决方式');
  if (resolution !== 'use-local' && resolution !== 'use-shared') {
    throw new AppError(
      `冲突解决方式只能是 use-local（以本地设置为准）或 use-shared（以共享设置为准），收到：${resolution}。`,
    );
  }
  return resolution;
}

function parseCreateInput(raw: unknown): CreateInstanceInput {
  const source = mustRecord(raw, '创建参数');
  const input: CreateInstanceInput = {
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

const PATCH_KEYS: ReadonlySet<string> = new Set([
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

function parseUpdatePatch(raw: unknown): UpdateInstancePatch {
  const source = mustRecord(raw, '更新参数');
  for (const key of Object.keys(source)) {
    if (!PATCH_KEYS.has(key)) throw new AppError(`不支持的更新字段：${key}。`);
  }

  const patch: UpdateInstancePatch = {};
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

function parseLaunchRequest(raw: unknown): LaunchRequest {
  const source = mustRecord(raw, '启动参数');
  const request: LaunchRequest = { instanceId: mustString(source['instanceId'], '实例 ID') };
  if (source['appArgs'] !== undefined) {
    request.appArgs = mustStringArray(source['appArgs'], '启动参数');
  }
  return request;
}
