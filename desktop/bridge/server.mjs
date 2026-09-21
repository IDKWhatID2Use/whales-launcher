/**
 * WhalesLauncher Node 侧车桥接服务（协议 v1 的唯一实现）
 * ============================================================================
 *
 * 启动：`node dist/bridge/server.cjs --home <launcher 数据根目录>`
 * 传输：stdin/stdout NDJSON（协议 §1），stderr 为人类可读日志。
 *
 * 本文件把冻结契约 `src/shared/contracts.ts` 的 `CH` 通道映射到保留资产
 * `src/core`（`CoreApi`）上，替换 Electron 的 `ipcMain.handle`。Electron 专有能力
 * （对话框、shell、版本号）改为反向请求 C# 宿主（协议 §3.3，见 `host.mjs`）。
 *
 * ---------------------------------------------------------------------------
 * 「通道 → 校验来源」对照表（校验唯一事实源：旧主进程 `ipc.ts`）
 * ---------------------------------------------------------------------------
 * launcher:getConfig              ipc.ts L79            （配置校验见 config.ts L163-218）
 * launcher:setConfig              ipc.ts L81-87         （config.ts L163-218 逐条搬运）
 * launcher:detectNode             ipc.ts L95-96
 * launcher:preflight              —— **本轮新增**（旧 Electron 版没有环境自检）：
 *                                 参数校验 validate.mjs `parsePreflightOptions`，
 *                                 实现 src/core/preflight.ts
 * instance:list                   ipc.ts L100
 * instance:create                 ipc.ts L102-108 / parseCreateInput L646-680
 * instance:get                    ipc.ts L110 / requireInstance L423-430
 * instance:update                 ipc.ts L112-118 / parseUpdatePatch L696-734（PATCH_KEYS 白名单 L682-694）
 * instance:remove                 ipc.ts L120-129 / mustBoolean L580-584
 * instance:launch                 ipc.ts L131-171 / parseLaunchRequest L736-743（串行锁：协议 §3.4）
 * instance:stop                   ipc.ts L173-187（串行锁：协议 §3.4）
 * instance:openFolder             ipc.ts L189-192 / openInstanceFolder L448-467 / mustString L562-572
 * engine:list                     ipc.ts L196
 * engine:available                ipc.ts L198-206
 * engine:install                  ipc.ts L208-217 / mustString L562-572
 * engine:remove                   ipc.ts L219-232 / mustString L562-572
 * plugin:inventory                ipc.ts L236-237
 * plugin:add                      ipc.ts L239-246 / mustString L242
 * plugin:remove                   ipc.ts L248-255 / mustString L251
 * plugin:setBundleEnabled         ipc.ts L257-264 / mustString L260 / mustBoolean L261
 * plugin:install                  ipc.ts L271-277 / mustPluginSource L600-617
 * plugin:removeLocal              ipc.ts L279-286 / mustString L282
 * plugin:listLocal                ipc.ts L288-289
 * plugin:pickArchive              ipc.ts L291-299 → host:pickArchive
 * plugin:pickFolder               ipc.ts L301-302 → host:pickFolder
 * settings:read                   ipc.ts L306-307
 * settings:write                  ipc.ts L309-317 / mustString(L314, allowEmpty)
 * settings:shareConflicts         ipc.ts L325
 * settings:resolveShareConflict   ipc.ts L328-336 / mustShareConflictResolution L636-644
 * saves:list                      ipc.ts L340
 * saves:openFolder                ipc.ts L342-345 / openSavesFolder L469-485 / mustString L478
 * pack:export                     ipc.ts L349-363 → host:downloadsDir + host:saveFile
 * pack:import                     ipc.ts L365-379 → host:pickPackFile
 * pack:pickFile                   ipc.ts L381-391 → host:pickPackFile
 * app:version                     ipc.ts L395（`app.getVersion()` → **构建期注入**的启动器版本）
 * app:openExternal                ipc.ts L397-400 / openExternalUrl L523-536（仅 http/https）
 * app:menu                        ipc.ts L406 / menu.ts L41-119 + L142-L192（纯数据投影，见 menu.mjs）
 * app:menuCommand                 ipc.ts L412-415 —— **Node 侧无法实现**：命令全部在操作 Electron 窗口
 *                                 （menu.ts L227-L322），由宿主按 MenuNode.id 本地执行；这里返回明确错误
 * 推送 log:chunk / log:state       协议 §2.4（旧 main → renderer 推送，见旧主进程 runtime.ts）
 *
 * 关于 `app:menu`：菜单的 id/label/accelerator 由后端投影（契约要求"渲染层不得自建第二份
 * 定义"），宿主据此构造原生 `MenuBar`；`app:menuCommand` 的执行必须留在宿主侧。
 */
import './stdio.mjs'; // ① 必须最先执行：把 console.log 改道 stderr（协议 §4）
import { statSync } from 'node:fs';
import { core } from '../../src/core/index.ts';
import { CH } from '../../src/shared/contracts.ts';
import { AppError, describeError } from './errors.mjs';
import { drainOut, readLines, writeLine } from './stdio.mjs';
import * as v from './validate.mjs';
import { HOST_METHODS, createHostClient } from './host.mjs';
import { menuNodes } from './menu.mjs';
import * as store from './config-store.mjs';
import {
  LAUNCHER_LOG_ID,
  broadcastState,
  forceKillLeftovers,
  launchHooks,
  logSink,
  stopAll,
  systemLog,
} from './events.mjs';

/** 协议版本（协议 §3.2；与 C# 侧不匹配时 C# 必须报错并终止）。 */
const PROTOCOL_VERSION = 1;

/** 只出现在 Node → C# 方向、不可调用的推送通道。来源：ipc.ts L34 */
const PUSH_ONLY_CHANNELS = new Set([CH.log.chunk, CH.log.state]);

/** 契约里的全部通道字面值（含 2 条推送通道）—— `__handshake.channels` 如实返回这一份。 */
const ALL_CHANNELS = Object.values(CH).flatMap((group) => Object.values(group));

/** `__shutdown` 后等待在途请求完成的上限（超出则放弃等待并继续退出）。 */
const SHUTDOWN_IDLE_TIMEOUT_MS = 30_000;

/** 宿主客户端（Node → C#）。 */
const host = createHostClient({ writeLine });

/* ------------------------------------------------------------------ *
 * 通道实现
 * ------------------------------------------------------------------ */

/**
 * 自检时跳过的通道（构建期常量，默认空）。
 *
 * **为什么要有这个逃生开关**：`CH` 是唯一的契约事实源，而"契约先加通道、两端实现随后跟上"
 * 是正常的并行落地顺序。那种中间状态下 `assertChannelCoverage` 会让**整个桥接进程起不来** ——
 * 连与这条新通道无关的页面与用例都一起停摆，代价远大于收益（UI 自动化测试就是这么被卡住的）。
 * 因此允许在**明确知道少的是哪一条**时，构建一份"跳过该条"的产物用于本地验证：
 *
 *     esbuild desktop/bridge/server.mjs --bundle ... --define:__WHALES_SKIP_CHANNEL__='"launcher:preflight"'
 *
 * 常规产物里这个常量是 `undefined`，跳过集合为空 —— 与没有这个开关时逐字等价；
 * 正式产物仍然要求每条契约通道都有实现。
 */
const SKIP_CHANNELS = new Set(
  typeof __WHALES_SKIP_CHANNEL__ === 'string' && __WHALES_SKIP_CHANNEL__.length > 0
    ? [__WHALES_SKIP_CHANNEL__]
    : [],
);

const handlers = {
  /* ---------------- 内建方法（协议 §3.2） ---------------- */

  __handshake: async () => ({
    protocol: PROTOCOL_VERSION,
    // 版本未知时返回空串（**绝不**用 `0.0.0` 之类的假值冒充）；构建产物里恒为真实版本。
    appVersion: store.appVersionOrNull() ?? '',
    // 如实报告"这一份产物实际实现了哪些通道"：被 SKIP_CHANNELS 跳过的条目不列出来，
    // 否则 C# 侧会把它读成"Node 多出一条本地不认识的通道"而在握手断言上失败
    // （协议 §5.3 只要求"两端清单一致"，没规定清单必须等于契约全集）。
    channels: ALL_CHANNELS.filter((channel) => !SKIP_CHANNELS.has(channel)),
    hostMethods: [...HOST_METHODS],
  }),

  __ping: async () => ({ pong: true }),

  /** 返回 `{ok:true}`（协议 §3.2 原样）；真正的退出流程由 dispatch 在响应写出之后触发。 */
  __shutdown: async () => ({ ok: true }),

  /* ---------------- launcher ---------------- */

  [CH.launcher.getConfig]: async () => store.withRoot(await store.loadConfig()), // ipc.ts L79

  /**
   * ipc.ts L81-87。
   * 唯一的差异：旧实现落库后调用 `applyThemeToAllWindows()` 同步 WCO 与窗口底色
   * （titleBarOverlay 是 Electron 主进程选项，CSS 无权改）。WinUI 3 侧窗口/主题归 C#，
   * 因此这里只回传落库后的配置，**由宿主在收到响应后自行应用主题**。
   */
  [CH.launcher.setConfig]: async (patch) => {
    const config = await store.saveConfig(patch);
    return store.withRoot(config);
  },

  /** ipc.ts L95-96 */
  [CH.launcher.detectNode]: async (refresh) => core.detectNode(store.launcherRoot(), refresh === true),

  /**
   * 环境与依赖自检（**本轮新增通道**，旧 Electron 版没有对应能力）。
   *
   * 参数：`[options?: PreflightOptions]` —— 校验见 `validate.mjs` 的 `parsePreflightOptions`
   * （只放行白名单字段；这些开关能让 core 联网下载并安装依赖）。
   * 返回：`PreflightReport`（逐项结论 + 自动修复了什么 + 还需要用户做什么）。
   *
   * **耗时提醒**：`options.installEngine === true` 且本机一个引擎都没有时，这里会联网安装
   * dsh（首次需数分钟）。进度经 launcher 日志流实时下发，调用方（C# 侧）必须给足超时。
   * core 侧对同一根目录做了单飞：界面连点"自检"不会并发跑两遍安装。
   */
  [CH.launcher.preflight]: async (options) => {
    const parsed = v.parsePreflightOptions(options);
    return core.runPreflight(store.launcherRoot(), parsed, logSink(LAUNCHER_LOG_ID));
  },

  /* ---------------- instance ---------------- */

  [CH.instance.list]: async () => core.listInstances(store.launcherRoot()), // ipc.ts L100

  /** ipc.ts L102-108 */
  [CH.instance.create]: async (input) => {
    const parsed = v.parseCreateInput(input);
    const root = store.launcherRoot();
    const meta = await core.createInstance(root, parsed, { onLog: logSink(LAUNCHER_LOG_ID) });
    systemLog(meta.id, `实例「${meta.name}」创建完成（引擎 ${meta.engine.version}）。`);
    return summarize(root, meta);
  },

  /** ipc.ts L110 */
  [CH.instance.get]: async (id) => summarize(store.launcherRoot(), await requireInstance(id)),

  /** ipc.ts L112-118 */
  [CH.instance.update]: async (id, patch) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const updated = await core.updateInstance(root, meta.id, v.parseUpdatePatch(patch));
    broadcastState(core.runtimeOf(updated.id));
    return summarize(root, updated);
  },

  /** ipc.ts L120-129 */
  [CH.instance.remove]: async (id, deleteFiles) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const runtime = core.runtimeOf(meta.id);
    if (runtime.state !== 'stopped' && runtime.state !== 'crashed') {
      throw new AppError(`实例「${meta.name}」正在运行，请先停止后再删除。`);
    }
    await core.deleteInstance(root, meta.id, v.mustBoolean(deleteFiles, '是否删除文件', false));
    return undefined;
  },

  /**
   * ipc.ts L131-171。
   *
   * 并发：同一实例的 launch/stop 必须**串行**（协议 §3.4）—— 旧实现只在 IPC 层做
   * "是否已在运行"的前置检查，两个并发 launch 会双双通过检查；而 core 的
   * `active` 登记发生在 spawn 之后（core/launch.ts L268），同样挡不住并发。
   * 因此这里用实例级串行锁把"检查 + 启动"整体互斥。
   * 参数校验（parseLaunchRequest）在**取锁之前**完成，保证错误文案与旧实现一致。
   */
  [CH.instance.launch]: async (request) => {
    const req = v.parseLaunchRequest(request);
    return withInstanceLock(req.instanceId, async () => {
      const root = store.launcherRoot();
      const meta = await requireInstance(req.instanceId);

      const runtime = core.runtimeOf(meta.id);
      if (runtime.state === 'running' || runtime.state === 'starting') {
        throw new AppError(`实例「${meta.name}」已经在运行（PID ${runtime.pid ?? '未知'}）。`);
      }

      // 前置失败要比 core 深处的报错更好读：这里直接给出"去版本管理安装"的指引。
      if (core.resolveEngineBin(root, meta.engine.version) === null) {
        throw new AppError(`引擎 ${meta.engine.version} 未安装，请先在「版本管理」中安装该版本。`);
      }

      const config = await store.loadConfig();
      const hooks = launchHooks(meta.id);
      let opened = false;

      const result = await core.launchInstance(root, meta, req, config, {
        onLog: hooks.onLog,
        onState: (state) => {
          hooks.onState(state);
          // web profile：拿到界面地址后按实例设置自动打开系统浏览器。
          // 旧实现走 shell.openExternal（ipc.ts L161），桥接层改走 host:openExternal。
          if (!meta.launch.autoOpenBrowser || opened) return;
          const url = state.url;
          if (url === null || url.length === 0) return;
          opened = true;
          void host.openExternal({ url }).catch((error) => {
            console.warn('[bridge] 自动打开界面失败：', error);
          });
        },
        onExit: hooks.onExit,
      });

      await store.rememberInstance(meta.id);
      broadcastState(core.runtimeOf(meta.id));
      return result;
    });
  },

  /**
   * ipc.ts L173-187。
   *
   * `core.stopInstance` 按契约返回 void 且不拒绝：进程杀不掉时它保持 state='running'
   * 并写入 lastError。这里翻译成 Result 错误，避免 UI 收到"停止成功"的假信号。
   */
  [CH.instance.stop]: async (id) => {
    const meta = await requireInstance(id);
    return withInstanceLock(meta.id, async () => {
      await core.stopInstance(meta.id);

      const runtime = core.runtimeOf(meta.id);
      broadcastState(runtime);

      if (runtime.state !== 'stopped' && runtime.lastError !== null) {
        throw new AppError(runtime.lastError);
      }
      return undefined;
    });
  },

  /** ipc.ts L189-192 */
  [CH.instance.openFolder]: async (id, which) => {
    await openInstanceFolder(id, which);
    return undefined;
  },

  /* ---------------- engine ---------------- */

  [CH.engine.list]: async () => core.listEngines(store.launcherRoot()), // ipc.ts L196

  /** ipc.ts L198-206（显式传 root，让 npm `--cache` 一定落在工作区内） */
  [CH.engine.available]: async () => {
    const config = await store.loadConfig();
    return core.listAvailableEngines(config.engineRegistry, store.launcherRoot());
  },

  /** ipc.ts L208-217 */
  [CH.engine.install]: async (version) => {
    const target = v.mustString(version, '引擎版本');
    const config = await store.loadConfig();
    return core.installEngine(
      store.launcherRoot(),
      target,
      config.engineRegistry,
      logSink(LAUNCHER_LOG_ID),
    );
  },

  /** ipc.ts L219-232 */
  [CH.engine.remove]: async (version) => {
    const target = v.mustString(version, '引擎版本');
    const root = store.launcherRoot();
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

  /** ipc.ts L236-237 */
  [CH.plugin.inventory]: async (id) =>
    core.readProfileInventory(store.launcherRoot(), await requireInstance(id)),

  /** ipc.ts L239-246 */
  [CH.plugin.add]: async (id, spec) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const packageSpec = v.mustString(spec, '插件包名');
    const config = await store.loadConfig();
    await core.pluginAdd(root, meta, packageSpec, config, logSink(meta.id));
    return core.readProfileInventory(root, meta);
  },

  /** ipc.ts L248-255 */
  [CH.plugin.remove]: async (id, name) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const pluginName = v.mustString(name, '插件名');
    const config = await store.loadConfig();
    await core.pluginRemove(root, meta, pluginName, config, logSink(meta.id));
    return core.readProfileInventory(root, meta);
  },

  /** ipc.ts L257-264 */
  [CH.plugin.setBundleEnabled]: async (id, name, enabled) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const bundleName = v.mustString(name, '组合包名');
    const flag = v.mustBoolean(enabled, '启用状态');
    await core.setBundleEnabled(root, meta, bundleName, flag);
    return core.readProfileInventory(root, meta);
  },

  /** ipc.ts L271-277 */
  [CH.plugin.install]: async (id, source) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const parsed = v.mustPluginSource(source);
    const config = await store.loadConfig();
    return core.pluginInstall(root, meta, parsed, config, logSink(meta.id));
  },

  /** ipc.ts L279-286 */
  [CH.plugin.removeLocal]: async (id, name) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    const pluginName = v.mustString(name, '插件名');
    const config = await store.loadConfig();
    await core.pluginRemoveLocal(root, meta, pluginName, config, logSink(meta.id));
    return core.readProfileInventory(root, meta);
  },

  /** ipc.ts L288-289 */
  [CH.plugin.listLocal]: async (id) =>
    core.listInstancePlugins(store.launcherRoot(), await requireInstance(id)),

  /**
   * ipc.ts L291-299：`dialog.showOpenDialog`（zip 过滤器）→ `host:pickArchive`（协议 §3.3）。
   * 标题沿用旧实现的字面值。
   */
  [CH.plugin.pickArchive]: async () => host.pickArchive({ title: '选择插件压缩包' }),

  /** ipc.ts L301-302 → `host:pickFolder` */
  [CH.plugin.pickFolder]: async () =>
    host.pickFolder({ title: '选择插件文件夹（其中含 package.json）' }),

  /* ---------------- settings ---------------- */

  /** ipc.ts L306-307 */
  [CH.settings.read]: async (id) =>
    core.readInstanceSettings(store.launcherRoot(), await requireInstance(id)),

  /** ipc.ts L309-317 */
  [CH.settings.write]: async (id, yaml) => {
    const meta = await requireInstance(id);
    await core.writeInstanceSettings(
      store.launcherRoot(),
      meta,
      v.mustString(yaml, '设置内容', { allowEmpty: true }),
    );
    return undefined;
  },

  /** ipc.ts L325 */
  [CH.settings.shareConflicts]: async (id) => core.listShareConflicts((await requireInstance(id)).id),

  /** ipc.ts L328-336 */
  [CH.settings.resolveShareConflict]: async (id, resolution) => {
    const meta = await requireInstance(id);
    await core.resolveSettingsConflict(
      store.launcherRoot(),
      meta,
      v.mustShareConflictResolution(resolution),
    );
    return undefined;
  },

  /* ---------------- saves ---------------- */

  /** ipc.ts L340 */
  [CH.saves.list]: async (id) => core.listSessions(store.launcherRoot(), await requireInstance(id)),

  /** ipc.ts L342-345 */
  [CH.saves.openFolder]: async (id, sessionId) => {
    await openSavesFolder(id, sessionId);
    return undefined;
  },

  /* ---------------- pack ---------------- */

  /**
   * ipc.ts L349-363。
   * 对话框改动：`dialog.showSaveDialog`（默认目录 `app.getPath('downloads')`）→
   * `host:downloadsDir` + `host:saveFile`。宿主拿到的 `defaultDir` 是下载目录，
   * 取不到时为 `null`（由宿主自行决定默认位置）。
   */
  [CH.pack.export]: async (id) => {
    const root = store.launcherRoot();
    const meta = await requireInstance(id);
    // 版本是**落盘**的包元数据（PackManifest.launcherVersion）：先取版本再弹对话框，
    // 取不到就直接失败 —— 绝不用假值写进用户的导出包。
    const launcherVersion = requireAppVersion();
    const suggested = `${v.sanitizeFileName(meta.name)}-${new Date().toISOString().slice(0, 10)}.whalepack.zip`;

    const defaultDir = await host.downloadsDir().catch((error) => {
      console.warn('[bridge] 读取下载目录失败，改由宿主决定默认位置：', error);
      return null;
    });
    const picked = await host.saveFile({
      title: `导出实例包 —— ${meta.name}`,
      suggestedName: suggested,
      defaultDir,
    });
    if (picked === null || typeof picked !== 'string' || picked.length === 0) return null;

    return core.exportPack(root, meta, picked, launcherVersion);
  },

  /** ipc.ts L365-379（旧实现自开的 zip 选择框 → `host:pickPackFile`） */
  [CH.pack.import]: async () => {
    const root = store.launcherRoot();
    const picked = await host.pickPackFile({ title: '选择要导入的实例包' });
    if (picked === null || typeof picked !== 'string' || picked.length === 0) return null;
    const config = await store.loadConfig();
    return core.importPack(root, picked, config, { onLog: logSink(LAUNCHER_LOG_ID) });
  },

  /** ipc.ts L381-391 → `host:pickPackFile` */
  [CH.pack.pickFile]: async () => {
    const picked = await host.pickPackFile({ title: '选择文件' });
    return typeof picked === 'string' && picked.length > 0 ? picked : null;
  },

  /* ---------------- app ---------------- */

  /**
   * ipc.ts L395：语义等价（旧 `app.getVersion()` 读的是应用自带的 package.json）。
   *
   * 桥接层的版本号来自**构建期注入**（见 `scripts/build-bridge.mjs` 与
   * `config-store.mjs` 的 BUILD_VERSION），不依赖 `--home` 下的任何文件：
   * `--home` 是数据目录，与启动器版本无关。
   * 版本未知时返回明确的 `ok:false`（协议 §4），**不用假值冒充成功**。
   */
  [CH.app.version]: async () => requireAppVersion(),

  /** ipc.ts L397-400 + openExternalUrl L523-536（仅 http/https；C# 侧必须再校验一次） */
  [CH.app.openExternal]: async (url) => {
    const target = v.mustHttpUrl(url);
    try {
      await host.openExternal({ url: target });
    } catch (error) {
      throw new AppError(`无法用系统浏览器打开该链接：${describeError(error)}`);
    }
    return undefined;
  },

  /**
   * ipc.ts L406（`menuNodes(hostWindow())`）。
   *
   * 返回 `menuSpec()` 的契约投影 —— 菜单的 id / label / accelerator **唯一事实源仍在
   * 后端**（契约 `MenuNode` 段明确要求"渲染层不得自建第二份定义"），宿主据此构造
   * 原生 `MenuBar`。见 `menu.mjs` 的搬运说明与降级点（`view.fullscreen` 的动态标签由
   * 宿主改写；`view.devtools` 按 `devToolsEnabled()` 置灰）。
   *
   * 注意：`W-SHELL` 的 brief（task-5）要求菜单项由本通道驱动，因此这里**不是**占位实现；
   * 但菜单项的语义适配（WinUI 3 没有 Chromium 的 reload/devtools/zoom）由宿主决定。
   */
  [CH.app.menu]: async () => menuNodes(),

  /**
   * ipc.ts L412-415（`runMenuCommandById(id, hostWindow())`）。
   *
   * **无法在 Node 侧实现**：旧主进程 `menu.ts` 的 `runMenuCommand()`（L227-L322）每一个
   * 分支都在操作 Electron 的 `BrowserWindow`/`app`/`dialog`（reload、devtools、缩放、
   * 全屏、编辑动作、退出、关于对话框）—— WinUI 3 侧没有对应对象，只有 C# 能做。
   * 因此这里返回**明确的**错误（而不是静默成功），请宿主按 `MenuNode.id` 映射到本地动作。
   */
  [CH.app.menuCommand]: async (id) => {
    throw new AppError(
      `菜单命令「${typeof id === 'string' ? id : JSON.stringify(id)}」必须由 WinUI 宿主本地执行` +
        '（Node 侧没有可操作的 Electron 窗口）；桥接层只提供 app:menu 的菜单数据，' +
        '请在 C# 侧按 MenuNode.id 映射到本地动作。',
    );
  },
};

/* ------------------------------------------------------------------ *
 * 实例辅助（来源：旧主进程 ipc.ts L423-L492）
 * ------------------------------------------------------------------ */

/** 来源：ipc.ts L423-L430 */
async function requireInstance(rawId) {
  const id = v.mustString(rawId, '实例 ID');
  const meta = await core.readInstance(store.launcherRoot(), id);
  if (meta === null) {
    throw new AppError(`找不到实例（id：${id}），它可能已被删除。请刷新实例列表后重试。`);
  }
  return meta;
}

/**
 * 取启动器版本；未知时**明确报错**而不是回一个假值。
 *
 * 版本号会进界面（`app:version`）与落盘的包元数据（`pack:export` → PackManifest），
 * 因此"未知"必须让调用方看得见：`0.0.0` 之类的假值会把一次探测失败伪装成成功。
 * @returns {string} 版本号。
 * @throws {AppError} 构建期未注入版本且运行期兜底也拿不到时。
 */
function requireAppVersion() {
  const version = store.appVersionOrNull();
  if (version === null) {
    throw new AppError(
      '无法确定启动器版本（构建产物未注入版本号，且数据目录下没有可用的 package.json）。' +
        '请重新执行 node scripts/build-bridge.mjs 生成带版本号的产物。',
    );
  }
  return version;
}

/** 聚合视图：优先用 core 的列表结果，取不到时依据元数据补一份等价视图。来源：ipc.ts L432-L446 */
async function summarize(root, meta) {
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

/** 来源：ipc.ts L448-L467 */
async function openInstanceFolder(rawId, rawWhich) {
  const meta = await requireInstance(rawId);
  const paths = core.instancePaths(store.launcherRoot(), meta);
  const which = v.mustString(rawWhich, '文件夹类型');
  const targets = {
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

/** 来源：ipc.ts L469-L485 */
async function openSavesFolder(rawId, rawSessionId) {
  const meta = await requireInstance(rawId);
  const root = store.launcherRoot();

  if (rawSessionId === undefined || rawSessionId === null || rawSessionId === '') {
    await openPath(core.instancePaths(root, meta).sessions);
    return;
  }

  const sessionId = v.mustString(rawSessionId, '会话 ID');
  const sessions = await core.listSessions(root, meta);
  const found = sessions.find((session) => session.id === sessionId);
  if (found === undefined) {
    throw new AppError(`找不到会话 ${sessionId}，请刷新存档列表后重试。`);
  }
  await openPath(found.dir);
}

/**
 * 打开目录：先确保存在（自愈），再把失败原因回报给用户。来源：ipc.ts L487-L492。
 * 旧实现的 `shell.openPath` 返回错误字符串；桥接层由宿主以 `ok:false` 表达失败。
 */
async function openPath(target) {
  await core.ensureDir(target);
  try {
    await host.openPath({ path: target });
  } catch (error) {
    throw new AppError(`无法打开文件夹：${describeError(error)}（${target}）`);
  }
}

/* ------------------------------------------------------------------ *
 * 并发：实例级串行锁（协议 §3.4）
 * ------------------------------------------------------------------ */

/** instanceId → 串行链尾。 */
const instanceLocks = new Map();

/**
 * 同一实例上的调用串行执行（launch / stop）。
 *
 * 语义与 `core/ports.ts` 的 `withLedgerLock` 一致（ports.ts L319-L328）：前一个无论成败，
 * 后一个都要跑。端口台账本身已由 core 的串行锁保护（协议 §3.4 的"端口台账写入"一项），
 * 桥接层不绕过、也不重复加锁。
 * @param {string} key 实例 id。
 * @param {() => Promise<unknown>} work 串行执行的工作。
 */
function withInstanceLock(key, work) {
  const previous = instanceLocks.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  instanceLocks.set(key, tail);
  void tail.then(() => {
    if (instanceLocks.get(key) === tail) instanceLocks.delete(key);
  });
  return result;
}

/* ------------------------------------------------------------------ *
 * 请求分发（协议 §2.1 / §3.4 / §4）
 * ------------------------------------------------------------------ */

/** 在途请求（`__shutdown` 前需处理完，见协议 §3.4）。 */
const inFlight = new Set();

/** 握手是否已完成（仅用于 stderr 告警，不做硬性拦截）。 */
let handshakeDone = false;

/** 已告警过的"握手前业务请求"，避免刷屏。 */
let warnedEarlyRequest = false;

/** 是否已进入退出流程。 */
let shuttingDown = false;

/**
 * 处理一条协议请求。
 * @param {string} line 一行 NDJSON 原文。
 */
async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    // 无法解析就没有可用的 id：只写 stderr，绝不臆造一条响应去污染请求-响应配对。
    console.error(`[bridge] 无法解析的输入行（${describeError(error)}）：${line.slice(0, 200)}`);
    return;
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    console.error(`[bridge] 输入不是 JSON 对象：${line.slice(0, 200)}`);
    return;
  }

  if (typeof message['method'] !== 'string') {
    // 没有 method 字段 → 只可能是 host: 调用的响应（协议 §3.3）。
    if (!host.settle(message)) {
      console.error(`[bridge] 收到既非请求也非宿主响应的消息：${line.slice(0, 200)}`);
    }
    return;
  }

  const id = message['id'];
  if (typeof id !== 'string' || id.length === 0) {
    console.error(`[bridge] 请求缺少字符串 id（协议 §2.1），已忽略：${line.slice(0, 200)}`);
    return;
  }

  const method = message['method'];
  const params = message['params'];
  if (params !== undefined && !Array.isArray(params)) {
    await writeLine({ id, ok: false, error: 'params 必须是数组（协议 §2.1 的位置参数数组）。' });
    return;
  }
  const args = params === undefined ? [] : params;

  if (!handshakeDone && !method.startsWith('__') && !warnedEarlyRequest) {
    warnedEarlyRequest = true;
    console.warn('[bridge] 业务方法在 __handshake 之前到达；协议 §3.2 要求 C# 首先握手。');
  }

  const handler = handlers[method];
  if (handler === undefined) {
    // 协议 §4：方法不存在 → 「未知方法：<method>」。
    // （log:chunk / log:state 属推送通道，同样不可调用，因此也走这一条。）
    await writeLine({ id, ok: false, error: `未知方法：${method}` });
    return;
  }

  let response;
  try {
    const value = await handler(...args);
    // `undefined` 在 JSON 里会被丢弃；显式归一为 null，保证 `value` 字段恒定存在（协议 §2.2）。
    response = { id, ok: true, value: value === undefined ? null : value };
  } catch (error) {
    // 堆栈只进 stderr（协议 §2.3）：跨进程只传面向用户的中文文案。
    console.error(`[bridge] ${method} 失败：`, error);
    response = { id, ok: false, error: describeError(error) };
  }

  await writeLine(response);

  if (method === '__handshake' && response.ok === true) {
    handshakeDone = true;
  }
  // 提示类消息（如"全局配置已损坏，已备份为 …"）在触发它的那次请求之后投递：
  // 旧实现等 `did-finish-load` 再补发（旧主进程 index.ts L323-L327），这里以
  // "握手已完成"作为等价的就绪判据，保证宿主一定已经在读事件流。
  if (handshakeDone) flushPendingNotices();
  if (method === '__shutdown' && response.ok === true) {
    void performShutdown({ reason: '__shutdown' });
  }
}

/** 把攒下的一次性提示投递为 log:chunk（对应旧 index.ts 的 did-finish-load 时机）。 */
function flushPendingNotices() {
  for (const notice of store.takePendingNotices()) {
    systemLog(LAUNCHER_LOG_ID, `${notice}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * 退出（协议 §3.2 / §4）
 * ------------------------------------------------------------------ */

/**
 * 优雅退出：等在途请求 → 停止所有实例 → 强杀残留 → flush stdout → exit(0)。
 *
 * 「绝不留孤儿进程」是旧主进程的硬承诺（旧主进程 index.ts L7-L8 / L400-L416）：
 * 本侧车是 dsh 子进程的父进程，若直接退出，子进程会在 Windows 上变成孤儿。
 * @param {{reason: string, exitCode?: number}} options 退出原因与退出码。
 */
async function performShutdown({ reason, exitCode = 0 }) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[bridge] 开始退出（${reason}）…`);

  const idle = await waitForIdle(SHUTDOWN_IDLE_TIMEOUT_MS);
  if (!idle) {
    console.warn(
      `[bridge] 仍有 ${inFlight.size} 个在途请求未完成（已等待 ${SHUTDOWN_IDLE_TIMEOUT_MS}ms），继续退出流程。`,
    );
  }

  try {
    const report = await stopAll(10_000);
    if (report.stopped.length > 0) {
      console.warn(`[bridge] 已停止 ${report.stopped.length} 个 dsh 实例：${report.stopped.join('、')}`);
    }
    if (report.failed.length > 0) {
      console.warn(`[bridge] 未能优雅停止、将在退出时强制结束：${report.failed.join('、')}`);
    }
  } catch (error) {
    console.error('[bridge] 退出清理失败：', error);
  }

  // 最后一道防线：任何仍被记账的 dsh 子进程一律强杀。
  forceKillLeftovers();

  // 在途宿主调用不可能再有响应，让它们立刻失败，避免 Promise 永久挂起。
  host.rejectAll('桥接进程正在退出，宿主调用已取消。');

  const flushed = await drainOut(2000);
  if (!flushed) console.warn('[bridge] stdout 未能在 2s 内 flush 完毕，仍将退出。');
  process.exit(exitCode);
}

/** 等待在途请求全部结束（最多 timeoutMs）。 */
async function waitForIdle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([
      Promise.all([...inFlight]).then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
  }
  return inFlight.size === 0;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 启动自检：契约里的每条 invoke 通道都必须有实现。来源：ipc.ts L62-L73 */
function assertChannelCoverage() {
  const missing = [];
  for (const group of Object.values(CH)) {
    for (const channel of Object.values(group)) {
      if (PUSH_ONLY_CHANNELS.has(channel)) continue;
      if (SKIP_CHANNELS.has(channel)) continue;
      if (!Object.prototype.hasOwnProperty.call(handlers, channel)) missing.push(channel);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[bridge] 契约通道未实现：${missing.join(', ')}`);
  }
}

/**
 * 解析 `--home <dir>`（协议 §1 的启动形式）。
 * @param {string[]} argv `process.argv.slice(2)`。
 * @returns {string} 目录（未做绝对化）。
 */
function parseHomeArg(argv) {
  const usage = '用法：node server.cjs --home <launcher 数据根目录>';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--home') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--home 缺少目录参数。${usage}`);
      }
      return unquote(value);
    }
    if (token.startsWith('--home=')) {
      const value = unquote(token.slice('--home='.length));
      if (value.length === 0) throw new Error(`--home 缺少目录参数。${usage}`);
      return value;
    }
  }
  throw new Error(`缺少必需参数。${usage}`);
}

/** 容错：宿主可能把路径连同引号一起传进来。 */
function unquote(value) {
  const match = /^"(.*)"$/.exec(value);
  return match === null ? value : match[1];
}

/** `--home` 已存在但不是目录时直接失败（否则后续报错会难以定位）。 */
function assertHomeUsable(root) {
  let info;
  try {
    info = statSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return; // 不存在：由 selfHealDirectories 创建
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`--home 指向的不是目录：${root}`);
}

/** 开始读取 stdin（协议 §3.4：逐行交付，回调内部并发处理，慢方法不阻塞读取）。 */
function startReading() {
  readLines({
    onLine: (line) => {
      const task = handleLine(line).catch((error) => {
        console.error('[bridge] 处理输入行时发生未捕获异常：', error);
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    onMalformed: (reason) => console.error(`[bridge] ${reason}`),
    onEnd: () => {
      // 宿主进程已消失：本进程继续存活只会变成孤儿侧车（其子进程也会失去监管）。
      void performShutdown({ reason: 'stdin 关闭（宿主进程已退出）' });
    },
  });
}

async function main() {
  const home = parseHomeArg(process.argv.slice(2));
  const root = store.configureRoot(home); // 必须在任何 core 调用之前（钉住 $WHALES_LAUNCHER_ROOT）
  assertHomeUsable(root);
  await store.selfHealDirectories();
  await store.loadAppVersion();
  assertChannelCoverage();

  console.warn(
    `[bridge] 就绪：home=${root}，协议 v${PROTOCOL_VERSION}，业务通道 ${ALL_CHANNELS.length} 条` +
      `（含 ${PUSH_ONLY_CHANNELS.size} 条推送通道），宿主方法 ${HOST_METHODS.length} 条。`,
  );

  // 进程被强制结束（C# 直接 kill）时不会有任何事件循环回调，这里只作尽力而为的兜底。
  process.on('exit', () => {
    try {
      forceKillLeftovers();
    } catch {
      /* 退出阶段不再抛错 */
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void performShutdown({ reason: `收到 ${signal}` });
    });
  }

  startReading();
}

main().catch((error) => {
  console.error(`[bridge] 启动失败：${describeError(error)}`);
  process.exit(2);
});

export { handlers, parseHomeArg, ALL_CHANNELS, PROTOCOL_VERSION };
