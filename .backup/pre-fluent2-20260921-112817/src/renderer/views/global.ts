/**
 * 全局设置
 *
 * 主题切换（立即生效并持久化）、主 home 路径、npm registry、
 * 删除前二次确认开关、**Node 运行时**（dsh 必须由独立 Node.js 执行，见下），
 * 以及运行模式与数据位置信息。
 *
 * ### 为什么设置页必须暴露 Node 运行时
 * 启动器是 Electron 应用，而 dsh 的原生模块**拒绝 Electron 内置运行时**
 * （只识别特定 Electron 版本）。若不给出"当前用哪个 node / 每个候选为何不可用"
 * 的可视入口，用户只能看到实例启动失败的一长串英文堆栈。这里把它变成可读状态。
 */
import type { NodeRuntimeReport, NodeRuntimeSource } from '../../shared/contracts';
import { backend } from '../data/api';
import { applyTheme, store } from '../data/store';
import { toastSuccess } from '../components/toast';
import { badge, banner, button, card, copyButton, kv, segmented, setBusy, switchControl } from '../components/ui';
import { h, replace } from '../util/dom';
import { attempt } from '../util/result';
import type { ViewContext, ViewInstance } from '../context';

/** Node 运行时来源的中文说明（与 core 的解析顺序一致）。 */
const NODE_SOURCE_LABEL: Record<NodeRuntimeSource, string> = {
  env: '环境变量 WHALES_NODE_PATH',
  config: '全局设置中指定',
  current: '启动器自身进程',
  path: '系统 PATH',
  common: '常见安装位置',
};

export function createGlobalSettingsView(ctx: ViewContext): ViewInstance {
  const root = h('div', { class: 'view' });
  const host = h('div', { class: 'view__inner' });

  const head = h(
    'div',
    { class: 'view__head' },
    h(
      'div',
      { class: 'view__head-main' },
      h('h1', { class: 'view__title' }, h('span', { text: '全局设置' })),
      h('div', { class: 'view__sub', text: '仅影响启动器自身；实例的 profile、插件与设置在各实例详情中管理。' }),
    ),
  );
  root.appendChild(head);
  root.appendChild(h('div', { class: 'view__body' }, host));

  /** Node 运行时探测结果（页面局部状态；不进 store，避免把一次性探测结果全局化）。 */
  let nodeReport: NodeRuntimeReport | null = null;
  let nodeProbing = false;
  let nodeProbeError: string | null = null;

  /** 探测 Node 运行时（`refresh=true` 时忽略 core 侧缓存）。 */
  async function probeNode(refresh: boolean): Promise<void> {
    if (nodeProbing) return;
    nodeProbing = true;
    render();
    const result = await attempt(backend().api.launcher.detectNode(refresh));
    nodeProbing = false;
    if (result.ok) {
      nodeReport = result.value;
      nodeProbeError = null;
    } else {
      nodeProbeError = result.error;
    }
    render();
  }

  /** 组装 Node 运行时的状态展示（可用 / 不可用 / 探测中）。 */
  function nodeStatusBlock(): Node[] {
    if (nodeProbing) return [h('div', { class: 'section-hint', text: '正在探测 Node 运行时…' })];
    if (nodeProbeError !== null) {
      return [banner({ tone: 'warning', title: '探测失败', text: nodeProbeError })];
    }
    if (nodeReport === null) return [];
    if (nodeReport.ok && nodeReport.file !== null) {
      const file = nodeReport.file;
      return [
        kv([
          {
            key: '探测结果',
            value: badge(`可用 · Node v${nodeReport.version ?? '?'}`, 'success', { dot: true }),
          },
          {
            key: '可执行文件',
            value: h('div', { class: 'row' }, h('span', { class: 'path-text', text: file }), copyButton(file)),
          },
          {
            key: '来源',
            value: h('span', { text: nodeReport.source === null ? '—' : NODE_SOURCE_LABEL[nodeReport.source] }),
          },
        ]),
      ];
    }
    const blocks: Node[] = [banner({ tone: 'warning', title: '未找到可用的 Node.js', text: nodeReport.message })];
    if (nodeReport.candidates.length > 0) {
      blocks.push(
        h(
          'div',
          { class: 'stack stack--tight' },
          nodeReport.candidates.map((item) =>
            h('div', {
              class: 'section-hint',
              text: item.ok
                ? `· ${item.file} —— 可用（Node v${String(item.version)}）`
                : `· ${item.file} —— 不可用：${String(item.reason)}`,
            }),
          ),
        ),
      );
    }
    return blocks;
  }

  function render(): void {
    const state = store.get();
    const config = state.config;
    const children: Node[] = [];

    if (state.demo) {
      children.push(
        banner({
          tone: 'info',
          title: '演示模式',
          text: '未检测到后端接口，设置项仅保存在内存中，不会写入 launcher.json。',
          actions: [button({ label: '重新检测', size: 'sm', variant: 'subtle', onClick: () => window.location.reload() })],
        }),
      );
    }

    /* 外观 */
    children.push(
      card({
        title: '外观',
        icon: 'sun',
        desc: '主题立即生效；深色为默认主题，浅色适合明亮环境。',
        body: [
          h(
            'div',
            { class: 'settings-row' },
            h(
              'div',
              { class: 'settings-row__main' },
              h('div', { class: 'settings-row__title', text: '界面主题' }),
              h('div', { class: 'settings-row__desc', text: '也可以点击顶部栏的图标快速切换。' }),
            ),
            h(
              'div',
              { class: 'settings-row__control' },
              segmented<'dark' | 'light'>({
                options: [
                  { value: 'dark', label: '深色', icon: 'moon' },
                  { value: 'light', label: '浅色', icon: 'sun' },
                ],
                value: config?.theme ?? 'dark',
                size: 'lg',
                ariaLabel: '界面主题',
                onChange: (value) => {
                  applyTheme(value);
                  void store.saveConfig({ theme: value }).then((saved) => {
                    if (saved) {
                      ctx.refreshShell();
                      toastSuccess(`已切换到${value === 'light' ? '浅色' : '深色'}主题`);
                    }
                  });
                },
              }),
            ),
          ),
        ],
      }),
    );

    /* 行为 */
    children.push(
      card({
        title: '行为',
        icon: 'settings',
        desc: '危险操作始终需要二次确认；此处控制确认框的详尽程度。',
        body: [
          h(
            'div',
            { class: 'settings-row' },
            h(
              'div',
              { class: 'settings-row__main' },
              h('div', { class: 'settings-row__title', text: '删除实例前二次确认' }),
              h('div', {
                class: 'settings-row__desc',
                text: '开启后，删除实例会列出影响范围并可选是否一并删除磁盘文件；关闭后仍会弹出确认框，但简化流程且默认保留文件。',
              }),
            ),
            h(
              'div',
              { class: 'settings-row__control' },
              switchControl({
                checked: config?.confirmOnDelete ?? true,
                onChange: (checked) => {
                  void store.saveConfig({ confirmOnDelete: checked }).then((saved) => {
                    if (saved) {
                      render();
                      toastSuccess(checked ? '已开启删除二次确认' : '已关闭删除二次确认');
                    }
                  });
                },
                ariaLabel: '删除实例前二次确认',
              }),
            ),
          ),
        ],
      }),
    );

    /* 数据位置 */
    const registryInput = h('input', {
      class: 'input',
      type: 'text',
      value: config?.engineRegistry ?? '',
      placeholder: 'https://registry.npmjs.org',
      'aria-label': 'npm registry',
      oninput: () => {
        saveRegistryBtn.disabled =
          registryInput.value.trim().length === 0 || registryInput.value === config?.engineRegistry;
      },
    });

    const saveRegistryBtn = button({
      label: '保存',
      icon: 'save',
      size: 'sm',
      variant: 'subtle',
      disabled: true,
      onClick: () => {
        const value = registryInput.value.trim();
        if (value.length === 0) return;
        setBusy(saveRegistryBtn, true, '保存中…');
        void store.saveConfig({ engineRegistry: value }).then((saved) => {
          setBusy(saveRegistryBtn, false, '保存');
          if (saved) {
            render();
            toastSuccess('npm registry 已更新', { detail: '安装引擎时会使用该地址。' });
          }
        });
      },
    });

    children.push(
      card({
        title: '数据位置',
        icon: 'folder',
        desc: '实例、引擎、共享资源都位于启动器根目录；删除启动器目录会一并移除所有实例。',
        body: [
          kv([
            {
              key: '启动器根目录',
              value: config?.rootDir
                ? h('div', { class: 'row' }, h('span', { class: 'path-text', text: config.rootDir }), copyButton(config.rootDir))
                : h('span', { class: 'muted', text: '由主进程注入，当前不可用' }),
            },
            {
              key: '主 home',
              value: h(
                'div',
                { class: 'row' },
                h('span', { class: 'path-text', text: config?.primaryHome ?? '—' }),
                config?.primaryHome ? copyButton(config.primaryHome) : null,
              ),
            },
            {
              key: 'npm registry',
              value: h('div', { class: 'row grow' }, registryInput, saveRegistryBtn),
            },
          ]),
          h('div', { class: 'section-hint', text: '凭证继承策略下，启动实例前会从「主 home」复制 .credentials.yaml，避免每个实例重复登录。' }),
        ],
      }),
    );

    /* Node 运行时（实例启动失败的常见根因就在这里） */
    const savedNodePath = config?.nodePath ?? '';
    const nodeInput = h('input', {
      class: 'input',
      type: 'text',
      value: savedNodePath,
      placeholder: '留空 = 自动探测（PATH / 常见安装位置）',
      'aria-label': 'Node 运行时路径',
      oninput: () => {
        saveNodeBtn.disabled = nodeInput.value.trim() === savedNodePath;
      },
    });
    const saveNodeBtn = button({
      label: '保存',
      icon: 'save',
      size: 'sm',
      variant: 'subtle',
      disabled: true,
      onClick: () => {
        const value = nodeInput.value.trim();
        setBusy(saveNodeBtn, true, '保存中…');
        void store.saveConfig({ nodePath: value.length === 0 ? null : value }).then((saved) => {
          setBusy(saveNodeBtn, false, '保存');
          if (saved === null) return;
          toastSuccess(value.length === 0 ? '已恢复为自动探测' : 'Node 运行时路径已保存');
          void probeNode(true);
        });
      },
    });
    const probeNodeBtn = button({
      label: '重新检测',
      icon: 'refresh',
      size: 'sm',
      variant: 'ghost',
      onClick: () => void probeNode(true),
    });

    children.push(
      card({
        title: 'Node 运行时',
        icon: 'cpu',
        desc: 'dsh 引擎必须由独立的 Node.js（>= 20）执行：它依赖的原生模块只识别特定 Electron 版本，无法使用启动器内置的 Electron 运行时。留空表示自动探测。',
        body: [
          ...nodeStatusBlock(),
          h(
            'div',
            { class: 'settings-row' },
            h(
              'div',
              { class: 'settings-row__main' },
              h('div', { class: 'settings-row__title', text: 'Node 可执行文件' }),
              h('div', {
                class: 'settings-row__desc',
                text: '例如 C:\\Program Files\\nodejs\\node.exe；改动后立即生效（启动实例与插件操作都会使用它）。',
              }),
            ),
            h(
              'div',
              { class: 'settings-row__control' },
              h('div', { class: 'row grow' }, nodeInput, saveNodeBtn, probeNodeBtn),
            ),
          ),
        ],
      }),
    );

    /* 关于 */
    children.push(
      card({
        title: '关于',
        icon: 'info',
        body: [
          kv([
            { key: '启动器版本', value: h('span', { text: state.appVersion || '—' }) },
            {
              key: '运行模式',
              value: state.demo
                ? badge('演示数据（未连接后端）', 'warning', { dot: true })
                : badge('已连接后端', 'success', { dot: true }),
            },
            { key: '界面框架', value: h('span', { text: '原生 TypeScript + CSS（无第三方 UI 框架）' }) },
            { key: '配置文件', value: h('span', { class: 'path-text', text: 'launcher.json（启动器根目录）' }) },
          ]),
          h(
            'div',
            { class: 'row wrap' },
            button({
              label: '打开日志侧栏',
              icon: 'terminal',
              size: 'sm',
              onClick: () => ctx.openLogDrawer(null),
            }),
            button({
              label: '返回实例列表',
              icon: 'arrowLeft',
              size: 'sm',
              variant: 'ghost',
              onClick: () => ctx.navigate('#/instances'),
            }),
          ),
        ],
      }),
    );

    /* 帮助 */
    children.push(
      card({
        title: '概念速查',
        icon: 'puzzle',
        body: [
          h(
            'div',
            { class: 'stack stack--tight' },
            h('div', { class: 'section-hint', text: '· 实例 = 独立的 DSH_HOME：profile、插件、设置、会话都在其中。' }),
            h('div', { class: 'section-hint', text: '· 插件 = profile 的依赖与组合包；组合包按顺序叠加 patch 决定能力。' }),
            h('div', { class: 'section-hint', text: '· 存档 = 会话（sessions）× 工作文件夹，可通过 junction 在实例间共享。' }),
            h('div', { class: 'section-hint', text: '· 引擎版本 = engines/<版本>/node_modules/@deepseek-ai/dsh。' }),
            h('div', { class: 'section-hint', text: '· 设置 = 每个实例一份 settings.yaml，位于实例 home 根下。' }),
          ),
        ],
      }),
    );

    replace(host, h('div', { class: 'settings-stack' }, children));

    // 首次进入自动探测一次（成功/失败都会记住结论；"重新检测"可强制刷新）
    if (nodeReport === null && !nodeProbing && nodeProbeError === null) void probeNode(false);
  }

  let signature = '';
  const unsubscribe = store.subscribe(() => {
    const state = store.get();
    const next = [
      state.demo ? '1' : '0',
      state.appVersion,
      state.config?.theme ?? '',
      String(state.config?.confirmOnDelete ?? ''),
      state.config?.engineRegistry ?? '',
      state.config?.nodePath ?? '',
      String(state.instances.length),
    ].join('|');
    // 只在真正影响本页的数据变化时重绘，避免打断 registry 输入
    if (next === signature) return;
    signature = next;
    render();
  });
  render();

  return {
    el: root,
    destroy(): void {
      unsubscribe();
    },
  };
}
