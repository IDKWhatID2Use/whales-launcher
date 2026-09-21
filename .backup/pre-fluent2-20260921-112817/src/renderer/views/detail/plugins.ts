/**
 * 实例详情 · 插件页
 *
 * 三块内容：
 *  1. 组合包 —— 参与配置树组合，可开关，内置项不可卸载；
 *  2. 插件依赖 —— npm 包名安装的普通依赖；
 *  3. 本地插件 —— 「随实例搬运」的插件（zip / GitHub / 文件夹）。
 *
 * 第 3 块的落点是 `<实例>/home/plugins/<名>`，profile 里只留相对 `file:` 依赖，
 * 于是整个实例目录可以像整合包一样复制走而插件不丢。
 */
import type {
  InstanceSummary,
  PluginInstallResult,
  PluginInventory,
  PluginSource,
  PluginSummary,
} from '../../../shared/contracts';
import { backend } from '../../data/api';
import { store } from '../../data/store';
import { confirmDialog } from '../../components/modal';
import { toastInfo, toastSuccess } from '../../components/toast';
import {
  badge,
  banner,
  button,
  card,
  chip,
  field,
  listEmpty,
  rows,
  segmented,
  setBusy,
  spinner,
  switchControl,
} from '../../components/ui';
import { h, replace } from '../../util/dom';
import { runAction } from '../../util/result';
import type { ViewContext, ViewInstance } from '../../context';

/** 本地插件安装入口的三种来源。 */
type LocalSourceKind = 'github' | 'archive' | 'folder';

/**
 * 去掉来源规格里的传输前缀，避免界面上出现 `github:github:owner/repo`。
 *
 * 账本里 source 存的是 profile 依赖规格（`github:owner/repo`），而展示时外层还会
 * 再写一次来源类型（GitHub / 压缩包 / 文件夹），两处叠加就会重复。
 * @param source 依赖规格。
 * @returns 去掉 `github:` / `git+` 前缀的可读地址。
 */
function withoutOriginPrefix(source: string): string {
  return source.replace(/^git\+/i, '').replace(/^github:/i, '');
}

export function createPluginsTab(ctx: ViewContext, summary: InstanceSummary): ViewInstance {
  const instanceId = summary.meta.id;
  let inventory: PluginInventory | null = null;
  let localPlugins: PluginSummary[] = [];
  let loading = true;
  let loadError: string | null = null;
  let installing = false;
  let localSource: LocalSourceKind = 'github';
  const busyBundles = new Set<string>();
  const busyPlugins = new Set<string>();
  const busyLocal = new Set<string>();

  const root = h('div', { class: 'stack stack--loose' });
  const specInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'npm 包名，例如 @deepseek-ai/dsh-plugin-memory 或 dsh-plugin-pdf-reader@^0.9',
    'aria-label': '要安装的 npm 包名',
    autocomplete: 'off',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void install();
      }
    },
  });

  /* 本地插件的三个输入控件（切换来源时只重渲染，值不丢） */
  const githubInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'https://github.com/owner/repo 或 owner/repo#v1.0.0',
    'aria-label': 'GitHub 仓库地址',
    autocomplete: 'off',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void installLocal();
      }
    },
  });
  const archiveInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '插件压缩包绝对路径，例如 D:\\下载\\my-plugin.zip',
    'aria-label': '插件压缩包路径',
    autocomplete: 'off',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void installLocal();
      }
    },
  });
  const folderInput = h('input', {
    class: 'input',
    type: 'text',
    placeholder: '插件文件夹绝对路径（其中含 package.json）',
    'aria-label': '插件文件夹路径',
    autocomplete: 'off',
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void installLocal();
      }
    },
  });

  const installButton = button({
    label: '安装插件',
    icon: 'plus',
    variant: 'primary',
    onClick: () => void install(),
  });

  const localInstallButton = button({
    label: '安装到实例',
    icon: 'download',
    variant: 'primary',
    onClick: () => void installLocal(),
  });

  const running = (): boolean => store.runtimeOf(instanceId).state === 'running';

  /* ── 数据 ─────────────────────────────────────────────────── */

  async function load(silent = false): Promise<void> {
    if (!silent) {
      loading = true;
      loadError = null;
      render();
    }
    const result = await runAction(backend().api.plugin.inventory(instanceId), '读取插件列表');
    loading = false;
    if (result === null) {
      loadError = '无法读取插件清单，请检查实例目录与 profile 是否存在。';
    } else {
      inventory = result;
      loadError = null;
    }
    const local = await backend().api.plugin.listLocal(instanceId);
    if (local.ok) localPlugins = local.value;
    render();
  }

  async function install(): Promise<void> {
    const spec = specInput.value.trim();
    if (spec.length === 0) {
      specInput.classList.add('is-invalid');
      specInput.focus();
      return;
    }
    specInput.classList.remove('is-invalid');
    installing = true;
    setBusy(installButton, true, '安装中…');
    render();
    const result = await runAction(backend().api.plugin.add(instanceId, spec), '安装插件');
    installing = false;
    setBusy(installButton, false, '安装插件');
    if (result !== null) {
      inventory = result;
      specInput.value = '';
      toastSuccess(`已安装 ${spec}`, { detail: '依赖已写入 profile 的 package.json 与 pnpm-lock.yaml。' });
    }
    render();
  }

  /**
   * 安装「随实例搬运」的本地插件。
   *
   * 三种来源都交给 core 处理落点：zip 走 `home/plugins`、GitHub 走 profile 依赖、
   * 文件夹走 junction。界面只负责收集参数与呈现结果。
   */
  async function installLocal(): Promise<void> {
    let source: PluginSource;
    let input: HTMLInputElement;
    if (localSource === 'github') {
      input = githubInput;
      const url = githubInput.value.trim();
      if (url.length === 0) {
        githubInput.classList.add('is-invalid');
        githubInput.focus();
        return;
      }
      githubInput.classList.remove('is-invalid');
      source = { kind: 'github', url };
    } else if (localSource === 'archive') {
      input = archiveInput;
      const file = archiveInput.value.trim();
      if (file.length === 0) {
        archiveInput.classList.add('is-invalid');
        archiveInput.focus();
        return;
      }
      archiveInput.classList.remove('is-invalid');
      source = { kind: 'archive', file };
    } else {
      input = folderInput;
      const dir = folderInput.value.trim();
      if (dir.length === 0) {
        folderInput.classList.add('is-invalid');
        folderInput.focus();
        return;
      }
      folderInput.classList.remove('is-invalid');
      source = { kind: 'folder', dir };
    }

    installing = true;
    setBusy(localInstallButton, true, '安装中…');
    render();
    const result = await runAction(backend().api.plugin.install(instanceId, source), '安装本地插件');
    installing = false;
    setBusy(localInstallButton, false, '安装到实例');
    if (result !== null) {
      afterInstall(result, source);
    }
    await load(true);
  }

  /** 安装成功后的反馈：清空输入、刷新清单、如实提示落点与警告。 */
  function afterInstall(result: PluginInstallResult, source: PluginSource): void {
    if (source.kind === 'github') githubInput.value = '';
    else if (source.kind === 'archive') archiveInput.value = '';
    else folderInput.value = '';
    inventory = result.inventory;
    const detail =
      source.kind === 'github'
        ? '按 GitHub 依赖安装进 profile（迁移实例后随清单重装）。重启实例生效。'
        : source.kind === 'archive'
          ? `已复制到实例目录：home\\plugins\\${result.name}（随实例搬运）。重启实例生效。`
          : `已链接到源目录（不随实例搬运）。重启实例生效。`;
    toastSuccess(`已安装 ${result.name}`, { detail });
    for (const warning of result.warnings) {
      toastInfo(warning, { detail: `插件：${result.name}` });
    }
  }

  async function pickArchive(): Promise<void> {
    const picked = await backend().api.plugin.pickArchive();
    if (!picked.ok || picked.value === null) return;
    archiveInput.value = picked.value;
    render();
  }

  async function pickFolder(): Promise<void> {
    const picked = await backend().api.plugin.pickFolder();
    if (!picked.ok || picked.value === null) return;
    folderInput.value = picked.value;
    render();
  }

  async function uninstallLocal(name: string): Promise<void> {
    const confirmed = await confirmDialog({
      title: `卸载本地插件「${name}」`,
      message: '会从 profile 依赖与 dsh.profile.bundles 中移除它，并删除实例目录下的插件文件夹。',
      detail: '删除后该插件不再随实例搬运；如果它仍被 cordis 配置引用，实例启动时会输出警告。',
      confirmText: '卸载',
      danger: true,
      icon: 'trash',
    });
    if (!confirmed) return;
    busyLocal.add(name);
    render();
    const result = await runAction(backend().api.plugin.removeLocal(instanceId, name), '卸载本地插件');
    busyLocal.delete(name);
    if (result !== null) {
      inventory = result;
      toastSuccess(`已卸载 ${name}`);
    }
    await load(true);
  }

  async function uninstall(name: string): Promise<void> {
    const confirmed = await confirmDialog({
      title: `卸载插件「${name}」`,
      message: '卸载会从 profile 的依赖中移除该包；若它仍被 cordis 配置引用，实例启动时会输出警告。',
      detail: 'dsh plugin remove 失败时会保留原状，不会留下半装状态。',
      confirmText: '卸载',
      danger: true,
      icon: 'trash',
    });
    if (!confirmed) return;
    busyPlugins.add(name);
    render();
    const result = await runAction(backend().api.plugin.remove(instanceId, name), '卸载插件');
    busyPlugins.delete(name);
    if (result !== null) {
      inventory = result;
      toastSuccess(`已卸载 ${name}`);
    }
    render();
  }

  async function toggleBundle(name: string, enabled: boolean): Promise<void> {
    busyBundles.add(name);
    const previous = inventory;
    if (inventory) {
      inventory = {
        ...inventory,
        bundles: inventory.bundles.map((b) => (b.name === name ? { ...b, enabled } : b)),
      };
      render();
    }
    const result = await runAction(
      backend().api.plugin.setBundleEnabled(instanceId, name, enabled),
      `${enabled ? '启用' : '停用'}组合包`,
    );
    busyBundles.delete(name);
    if (result === null) {
      inventory = previous;
    } else {
      inventory = result;
      toastSuccess(`${enabled ? '已启用' : '已停用'} ${name}`, {
        detail: '变更已写入 dsh.profile.bundles；重启实例后生效。',
      });
    }
    render();
  }

  /* ── 渲染 ─────────────────────────────────────────────────── */

  function bundleRows(): Node[] {
    const bundles = inventory?.bundles ?? [];
    if (loading) {
      return Array.from({ length: 2 }, () =>
        h('div', { class: 'bundle-item' }, h('div', { class: 'grow' }, h('div', { class: 'skeleton skeleton--text', style: { width: '40%' } }), h('div', { class: 'skeleton skeleton--text', style: { width: '70%' } }))),
      );
    }
    if (bundles.length === 0) return [listEmpty('该 profile 尚无组合包，启动时会自动补全 dsh-base。', 'package')];
    return bundles.map((bundle) => {
      const busy = busyBundles.has(bundle.name);
      const badges: Node[] = [];
      if (bundle.builtin) badges.push(badge('内置', 'info', { title: '随 dsh 安装提供，不可卸载' }));
      else badges.push(badge('第三方', 'accent'));
      if (bundle.version) badges.push(chip(bundle.version));
      if (!bundle.enabled) badges.push(badge('已停用', 'neutral'));

      return h(
        'div',
        { class: `bundle-item${bundle.enabled ? '' : ' is-disabled'}` },
        h(
          'div',
          { class: 'bundle-item__main' },
          h(
            'div',
            { class: 'bundle-item__title' },
            h('span', { class: 'bundle-item__name', text: bundle.name, title: bundle.name }),
            badges,
          ),
          bundle.description ? h('div', { class: 'plugin-desc', text: bundle.description }) : null,
        ),
        h(
          'div',
          { class: 'bundle-item__side' },
          busy ? spinner('sm') : null,
          switchControl({
            checked: bundle.enabled,
            disabled: busy,
            ariaLabel: `${bundle.enabled ? '停用' : '启用'}组合包 ${bundle.name}`,
            title: '组合包开关（写入 dsh.profile.bundles）',
            onChange: (checked) => void toggleBundle(bundle.name, checked),
          }),
        ),
      );
    });
  }

  function dependencyRows(): Node[] {
    const deps = inventory?.dependencies ?? [];
    if (loading) {
      return Array.from({ length: 3 }, () =>
        h('div', { class: 'bundle-item' }, h('div', { class: 'grow' }, h('div', { class: 'skeleton skeleton--text', style: { width: '46%' } }))),
      );
    }
    if (deps.length === 0) {
      return [listEmpty('还没有安装任何插件依赖。可以在上面输入 npm 包名安装。', 'puzzle')];
    }
    return deps.map((dep) => {
      const busy = busyPlugins.has(dep.name);
      return h(
        'div',
        { class: 'bundle-item' },
        h(
          'div',
          { class: 'bundle-item__main' },
          h(
            'div',
            { class: 'bundle-item__title' },
            h('span', { class: 'bundle-item__name', text: dep.name, title: dep.name }),
            dep.version ? chip(dep.version) : null,
            dep.installed ? badge('已安装', 'success', { dot: true }) : badge('未安装到 node_modules', 'warning', { dot: true }),
          ),
        ),
        h(
          'div',
          { class: 'bundle-item__side' },
          busy ? spinner('sm') : null,
          button({
            label: '卸载',
            icon: 'trash',
            size: 'sm',
            variant: 'danger',
            disabled: busy,
            onClick: () => void uninstall(dep.name),
          }),
        ),
      );
    });
  }

  /** 本地插件的来源标签：决定它能不能随实例目录一起搬走。 */
  function originBadge(plugin: PluginSummary): HTMLElement {
    switch (plugin.origin) {
      case 'archive':
        return badge('压缩包 · 随实例搬运', 'success', { title: '文件本体在 home\\plugins 下，复制实例目录即可带走' });
      case 'folder':
        return badge('文件夹链接 · 不随实例搬运', 'warning', { title: 'junction 指向实例之外的源目录，换机器需重新安装' });
      case 'github':
        return badge('GitHub · 走 profile 依赖', 'info', { title: '迁移后按 profile 清单重新安装' });
      case 'manual':
        return badge('手工放入', 'neutral', { title: '目录里没有来源标记，迁移后需自行确认' });
      default:
        return badge('来源未知', 'neutral', { title: '来源标记损坏' });
    }
  }

  function localRows(): Node[] {
    if (loading) {
      return Array.from({ length: 2 }, () =>
        h('div', { class: 'bundle-item' }, h('div', { class: 'grow' }, h('div', { class: 'skeleton skeleton--text', style: { width: '44%' } }))),
      );
    }
    if (localPlugins.length === 0) {
      return [listEmpty('实例内还没有本地插件。用上面的 GitHub 链接或插件压缩包安装，文件会落在实例目录里。', 'download')];
    }
    return localPlugins.map((plugin) => {
      const busy = busyLocal.has(plugin.name);
      const badges: Node[] = [originBadge(plugin)];
      if (plugin.version) badges.push(chip(plugin.version));
      if (!plugin.hasBundlePatch) {
        badges.push(badge('无 dsh.bundle.patch', 'neutral', { title: '作为普通依赖安装，不进入组合包层；纯客户端插件由 dsh 处理' }));
      } else if (!plugin.patchFileExists) {
        badges.push(badge('patch 文件缺失', 'danger', { title: '声明的 dsh.bundle.patch 在包内不存在，实例启动会失败' }));
      } else if (plugin.enabled) {
        // 文件、依赖、bundles 三处都已确认 → 这是"事实已就位"的明确结论。
        // 第三方自检（如插件市场装完再验一遍）报的失败不影响它。
        badges.push(
          badge('已装好', 'success', {
            dot: true,
            title: '依赖、包文件、dsh.profile.bundles 三处均已确认；第三方自检若报失败，与此状态无关',
          }),
        );
      } else {
        badges.push(badge('已装但未启用', 'warning', { title: '依赖已就位，但未登记进 dsh.profile.bundles' }));
      }
      if (plugin.hasClient) badges.push(badge('含客户端界面', 'info', { title: '刷新 Web GUI 后才能看到它提供的界面' }));

      const detail: string[] = [];
      if (plugin.description) detail.push(plugin.description);
      detail.push(plugin.dir);
      if (plugin.installedByLauncher) {
        const via = plugin.installedVia;
        detail.push(via?.source ? `由启动器安装（${via.kind}：${withoutOriginPrefix(via.source)}）` : '由启动器安装');
      }
      if (plugin.enabled) detail.push('已在 dsh.profile.bundles 中启用');
      else if (plugin.hasBundlePatch) detail.push('未登记进 dsh.profile.bundles（不会参与配置树组合）');

      return h(
        'div',
        { class: 'bundle-item' },
        h(
          'div',
          { class: 'bundle-item__main' },
          h(
            'div',
            { class: 'bundle-item__title' },
            h('span', { class: 'bundle-item__name', text: plugin.name, title: plugin.name }),
            badges,
          ),
          h('div', { class: 'plugin-desc', text: detail.join(' · '), title: plugin.dir }),
        ),
        h(
          'div',
          { class: 'bundle-item__side' },
          busy ? spinner('sm') : null,
          button({
            label: '打开目录',
            icon: 'folder',
            size: 'sm',
            variant: 'subtle',
            onClick: () => void openPluginsFolder(),
          }),
          button({
            label: '卸载',
            icon: 'trash',
            size: 'sm',
            variant: 'danger',
            disabled: busy,
            onClick: () => void uninstallLocal(plugin.name),
          }),
        ),
      );
    });
  }

  /** 三种本地来源的输入区（切 tab 只换控件，值保留）。 */
  function localInstallBody(): Array<Node | null> {
    const control =
      localSource === 'github' ? githubInput : localSource === 'archive' ? archiveInput : folderInput;
    const hints: Record<LocalSourceKind, string> = {
      github: '支持 https://github.com/owner/repo、owner/repo#标签 或 git@github.com:owner/repo.git；安装走 profile 依赖，需要能访问 github.com。',
      archive: 'zip 内应是「单一顶层文件夹」或根目录直接含 package.json（与 dsh 插件仓库同构）。解压后复制到实例目录，随实例搬迁。',
      folder: '会建 junction 指向该目录，不复制文件；适合边改边调，但这样的插件不随实例目录搬走。',
    };
    const pick = localSource === 'archive' ? pickArchive : localSource === 'folder' ? pickFolder : null;
    const pickButton: Node | null =
      pick !== null ? button({ label: '选择…', icon: 'folder', variant: 'subtle', onClick: () => void pick() }) : null;

    const body: Array<Node | null> = [
      h(
        'div',
        { class: 'stack' },
        segmented<LocalSourceKind>({
          value: localSource,
          options: [
            { value: 'github', label: 'GitHub 链接', icon: 'link' },
            { value: 'archive', label: '压缩包', icon: 'package' },
            { value: 'folder', label: '文件夹', icon: 'folder' },
          ],
          onChange: (value: LocalSourceKind) => {
            localSource = value;
            render();
          },
        }),
        h(
          'div',
          { class: 'plugin-install' },
          field({
            label: localSource === 'github' ? 'GitHub 仓库' : localSource === 'archive' ? '插件压缩包' : '插件文件夹',
            control,
            hint: hints[localSource],
          }),
          h('div', { class: 'plugin-install__actions' }, pickButton, localInstallButton),
        ),
      ),
      installing ? h('div', { class: 'busy-row' }, spinner('sm'), h('span', { text: '正在安装本地插件，请稍候…（进度见右下角运行日志）' })) : null,
      rows(localRows()),
    ];
    return body;
  }

  function render(): void {
    const children: Node[] = [];
    if (running()) {
      children.push(
        banner({
          tone: 'warning',
          title: '实例正在运行',
          text: 'dsh 的插件操作会对 profile 加写锁，建议先停止实例再变更插件，避免安装被中断。',
        }),
      );
    }

    if (loadError) {
      children.push(
        banner({
          tone: 'danger',
          title: '读取插件清单失败',
          text: loadError,
          actions: [button({ label: '重试', size: 'sm', variant: 'subtle', onClick: () => void load() })],
        }),
      );
    }

    const bundleCount = inventory?.bundles.length ?? 0;
    const depCount = inventory?.dependencies.length ?? 0;

    children.push(
      card({
        title: '组合包',
        icon: 'package',
        desc: '组合包按 dsh.profile.bundles 的顺序叠加 patch，决定实例具备哪些能力；内置组合包随 dsh 提供，可停用但不可卸载。',
        actions: [badge(`${bundleCount} 个`, 'neutral')],
        body: bundleRows(),
        flush: true,
      }),
    );
    children.push(
      card({
        title: '插件依赖',
        icon: 'puzzle',
        desc: '普通依赖安装在该实例 profile 的 node_modules 中，不会影响其它实例。',
        actions: [
          badge(`${depCount} 个`, 'neutral'),
          button({
            label: '打开 profile 目录',
            icon: 'folder',
            size: 'sm',
            onClick: () => void openProfileFolder(),
          }),
          button({ label: '刷新', icon: 'refresh', size: 'sm', onClick: () => void load(true) }),
        ],
        body: [
          h(
            'div',
            { class: 'plugin-install' },
            h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '安装新插件' })), specInput, h('div', { class: 'field__hint', text: '支持 package 或 package@版本范围；安装失败会回滚 package.json 与锁文件。' })),
            installButton,
          ),
          installing ? h('div', { class: 'busy-row' }, spinner('sm'), h('span', { text: '正在调用 dsh plugin add，请稍候…（进度见右下角运行日志）' })) : null,
          rows(dependencyRows()),
        ],
        flush: false,
      }),
    );

    children.push(
      card({
        title: '本地插件（随实例搬运）',
        icon: 'download',
        desc: '插件文件放进实例目录 home\\plugins，profile 只记相对路径 —— 整个实例目录复制到别处（或打进实例包）时插件不会丢。亦可直接从 GitHub 仓库或 zip 压缩包安装。',
        actions: [
          badge(`${localPlugins.length} 个`, 'neutral'),
          button({
            label: '打开插件目录',
            icon: 'folder',
            size: 'sm',
            onClick: () => void openPluginsFolder(),
          }),
          button({ label: '刷新', icon: 'refresh', size: 'sm', onClick: () => void load(true) }),
        ],
        body: localInstallBody(),
        flush: false,
      }),
    );

    if (inventory) {
      children.push(
        card({
          title: 'profile 位置',
          icon: 'folder',
          desc: '插件与配置树都落在该目录，可在此直接查看生成的配置文件。',
          body: [h('div', { class: 'path-text', text: inventory.profileDir })],
        }),
      );
    }

    replace(root, children);
  }

  /** 打开 `<实例>/home/plugins`（不存在时由 main 侧创建）。 */
  async function openPluginsFolder(): Promise<void> {
    const done = await runAction(backend().api.instance.openFolder(instanceId, 'plugins'), '打开插件目录');
    if (done === null) return;
    toastInfo(ctx.demo ? '演示模式：已模拟打开目录' : '已打开实例插件目录', {
      detail: 'home\\plugins —— 随实例搬运的插件都在这里',
    });
  }

  async function openProfileFolder(): Promise<void> {
    // profile 位于实例 home 之下：打开 home 后进入 profiles/<name>
    const done = await runAction(backend().api.instance.openFolder(instanceId, 'home'), '打开 profile 目录');
    if (done === null) return;
    toastInfo(
      ctx.demo ? '演示模式：已模拟打开目录' : '已打开实例 home 目录',
      { detail: `profile 目录：home\\profiles\\${summary.meta.profile.name}` },
    );
  }

  // profile 目录按钮：用 openFolder 打开实例目录下的 home，再让用户进入 profile
  render();
  void load();

  return {
    el: root,
    destroy(): void {
      /* 插件页没有推送订阅，无需退订 */
    },
  };
}
