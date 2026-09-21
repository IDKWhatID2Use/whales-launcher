/**
 * 版本管理
 *
 * 本地已安装引擎（含被哪些实例占用、体积、目录）与可安装版本列表；
 * 安装过程把实时日志流进内嵌控制台，卸载前提示占用实例并禁止误删。
 */
import type { EngineInfo } from '../../shared/contracts';
import { backend } from '../data/api';
import { logStore } from '../data/logs';
import { store } from '../data/store';
import { confirmDialog } from '../components/modal';
import { toastError, toastSuccess } from '../components/toast';
import { badge, banner, busyRow, button, card, copyButton, emptyState, listEmpty, setBusy, spinner } from '../components/ui';
import { icon } from '../icons';
import { clear, h, replace } from '../util/dom';
import { formatBytes, formatEngineSize } from '../util/format';
import { runAction, withTimeout } from '../util/result';
import type { ViewContext, ViewInstance } from '../context';

export function createEnginesView(ctx: ViewContext): ViewInstance {
  /** 每段列表各自的状态：一个慢调用绝不能把另一段也拖进无限加载（实机 P1） */
  type LoadState = 'loading' | 'ready' | 'error';
  let engines: EngineInfo[] | null = null;
  let available: string[] | null = null;
  let enginesState: LoadState = 'loading';
  let availableState: LoadState = 'loading';
  let enginesError: string | null = null;
  let availableError: string | null = null;
  let installing: string | null = null;
  let removing: string | null = null;
  const consoleLines: Array<{ text: string; kind: 'out' | 'err' | 'sys' }> = [];

  /** 本地引擎列表：读目录，正常应在毫秒级返回 */
  const ENGINES_TIMEOUT_MS = 12_000;
  /** npm 版本列表：走网络，首次可能数十秒 */
  const AVAILABLE_TIMEOUT_MS = 30_000;

  const topHost = h('div', { class: 'stack stack--tight' });
  const installedHost = h('div', { class: 'stack stack--tight' });
  const availableHost = h('div', { class: 'stack stack--tight' });
  const consoleHost = h('div', { class: 'stack stack--tight' });
  const root = h('div', { class: 'view' });

  const head = h(
    'div',
    { class: 'view__head' },
    h(
      'div',
      { class: 'view__head-main' },
      h('h1', { class: 'view__title' }, h('span', { text: '版本管理' }), h('span', { class: 'view__count', id: 'engine-count' })),
      h('div', {
        class: 'view__sub',
        text: '引擎版本来自 npm 的 @deepseek-ai/dsh；每个实例绑定一个版本，可同时安装多个版本共存。',
      }),
    ),
    h(
      'div',
      { class: 'view__actions' },
      button({ label: '刷新', icon: 'refresh', onClick: () => refreshAll() }),
    ),
  );

  const body = h(
    'div',
    { class: 'view__body' },
    h('div', { class: 'view__inner' }, topHost, installedHost, availableHost, consoleHost),
  );
  root.appendChild(head);
  root.appendChild(body);

  /* ── 数据 ─────────────────────────────────────────────────── */

  /**
   * 读取本地已安装引擎。**独立于** npm 版本列表：
   * 二者曾经用 `Promise.all` 合并，导致 npm 查询慢时"本地已安装"也永远停在加载态
   * （Lead 实机截图 evidence）。现在各自加载、各自超时、各自报错。
   */
  async function loadEngines(options: { notify?: boolean } = {}): Promise<void> {
    enginesState = 'loading';
    enginesError = null;
    render();
    const result = await withTimeout(backend().api.engine.list(), ENGINES_TIMEOUT_MS, '读取已安装引擎');
    if (result.ok) {
      engines = result.value;
      enginesState = 'ready';
    } else {
      enginesState = 'error';
      enginesError = result.error;
      if (options.notify) toastError('读取已安装引擎失败', { detail: result.error });
    }
    render();
  }

  /** 读取可安装版本（npm registry）。失败/超时都必须结束加载态并给出重试入口。 */
  async function loadAvailable(options: { notify?: boolean } = {}): Promise<void> {
    availableState = 'loading';
    availableError = null;
    render();
    const result = await withTimeout(backend().api.engine.available(), AVAILABLE_TIMEOUT_MS, '读取 npm 版本列表');
    if (result.ok) {
      available = result.value;
      availableState = 'ready';
    } else {
      availableState = 'error';
      availableError = result.error;
      if (options.notify) toastError('读取 npm 版本列表失败', { detail: result.error });
    }
    render();
  }

  /** 手动刷新：两段并行加载，失败时额外弹提示（用户主动操作的反馈） */
  function refreshAll(): void {
    void loadEngines({ notify: true });
    void loadAvailable({ notify: true });
  }

  /* ── 操作 ─────────────────────────────────────────────────── */

  async function install(version: string): Promise<void> {
    if (installing) return;
    installing = version;
    consoleLines.length = 0;
    consoleLines.push({ text: `$ npm install @deepseek-ai/dsh@${version}`, kind: 'sys' });
    const startSeq = logStore.lastSeq;
    const off = logStore.subscribe(() => {
      for (const line of logStore.since(startSeq)) {
        consoleLines.push({
          text: line.text,
          kind: line.stream === 'stderr' ? 'err' : line.stream === 'system' ? 'sys' : 'out',
        });
      }
      renderConsole();
    });
    render();
    const result = await runAction(backend().api.engine.install(version), '安装引擎');
    off();
    installing = null;
    if (result === null) {
      consoleLines.push({ text: '安装失败：详见上方错误提示与日志。', kind: 'err' });
      render();
      return;
    }
    consoleLines.push({ text: `安装完成：${result.version}`, kind: 'sys' });
    toastSuccess(`引擎 ${result.version} 安装完成`, {
      detail: result.dir,
      action: { label: '去创建实例', onClick: () => ctx.navigate('#/create') },
    });
    await store.refreshInstances({ silent: true });
    await loadEngines();
  }

  async function uninstall(engine: EngineInfo): Promise<void> {
    const usedBy = engine.usedBy
      .map((id) => store.instanceById(id)?.meta.name ?? id)
      .filter((name) => name.length > 0);
    if (usedBy.length > 0) {
      toastError(`引擎 ${engine.version} 正在被使用`, {
        detail: `以下实例绑定了该版本：${usedBy.join('、')}。请先在这些实例中改用其它版本。`,
      });
      return;
    }
    const confirmed = await confirmDialog({
      title: `卸载引擎 ${engine.version}`,
      message: `将删除引擎目录及其 node_modules，释放约 ${formatEngineSize(engine.sizeBytes)} 空间。该操作不可恢复，需要时可重新安装。`,
      detail: engine.dir,
      confirmText: '卸载',
      danger: true,
      icon: 'trash',
    });
    if (!confirmed) return;
    removing = engine.version;
    render();
    const done = await runAction(backend().api.engine.remove(engine.version), '卸载引擎');
    removing = null;
    if (done === null) {
      render();
      return;
    }
    toastSuccess(`已卸载引擎 ${engine.version}`);
    await loadEngines();
  }

  /* ── 渲染 ─────────────────────────────────────────────────── */

  function renderInstalled(): void {
    const children: Node[] = [];

    children.push(
      h(
        'div',
        { class: 'plugin-head' },
        h('div', { class: 'plugin-head__title' }, icon('cpu', 18), h('span', { text: '本地已安装' })),
        engines ? badge(`${engines.length} 个版本`, 'neutral') : null,
        h('div', { class: 'toolbar__spacer' }),
        button({
          label: '打开引擎目录',
          icon: 'folder',
          size: 'sm',
          variant: 'ghost',
          disabled: true,
          title: '引擎目录由主进程管理，可在下方复制路径',
        }),
      ),
    );

    if (enginesState === 'loading') {
      children.push(
        busyRow('正在读取已安装引擎…'),
      );
      replace(installedHost, children);
      return;
    }

    if (enginesState === 'error' || engines === null) {
      children.push(
        banner({
          tone: 'danger',
          title: '读取已安装引擎失败',
          text: enginesError ?? '未知错误',
          actions: [button({ label: '重试', size: 'sm', variant: 'subtle', onClick: () => void loadEngines({ notify: true }) })],
        }),
      );
      replace(installedHost, children);
      return;
    }

    if (engines.length === 0) {
      children.push(
        emptyState({
          icon: 'cpu',
          title: '还没有安装任何引擎',
          desc: '从右侧「可安装版本」中选择一个版本安装，即可开始创建实例。首次安装需要下载依赖，请保持网络畅通。',
          compact: true,
        }),
      );
      replace(installedHost, children);
      return;
    }

    const grid = h('div', { class: 'engine-grid' });
    for (const engine of engines) {
      const usedByNames = engine.usedBy.map((id) => store.instanceById(id)?.meta.name ?? id);
      const card = h(
        'div',
        { class: `engine-card${installing === engine.version ? ' is-active' : ''}` },
        h(
          'div',
          { class: 'engine-card__head' },
          h('div', { class: 'row-item__icon' }, icon('cpu', 18)),
          h('div', { class: 'grow' }, h('div', { class: 'engine-version', text: engine.version })),
          badge('已安装', 'success', { dot: true }),
        ),
        h(
          'div',
          { class: 'engine-card__meta' },
          // sizeBytes 为 0 / null 时不显示 "0 B"：junction 接入的引擎不跟随链接统计体积
          h(
            'span',
            { class: 'row' },
            icon('disk', 14),
            h('span', {
              text: formatEngineSize(engine.sizeBytes),
              title:
                engine.sizeBytes && engine.sizeBytes > 0
                  ? '引擎目录体积'
                  : '未统计：该引擎目录通过 junction/链接接入，体积按需计算',
            }),
          ),
          h('span', { class: 'row' }, icon('package', 14), h('span', { text: `${usedByNames.length} 个实例在用` })),
        ),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'path-text truncate', text: engine.dir, title: engine.dir }),
          copyButton(engine.dir, '复制引擎目录'),
        ),
        h(
          'div',
          { class: 'engine-usage' },
          usedByNames.length > 0
            ? usedByNames.map((name) => badge(name, 'neutral', { title: `实例「${name}」绑定此版本` }))
            : h('span', { class: 'section-hint', text: '暂无实例使用' }),
        ),
        h(
          'div',
          { class: 'engine-card__foot' },
          button({
            label: '重新安装',
            icon: 'download',
            size: 'sm',
            variant: 'ghost',
            disabled: installing !== null || removing !== null,
            onClick: () => void install(engine.version),
          }),
          h('div', { class: 'toolbar__spacer' }),
          engine.usedBy.length > 0
            ? button({
                label: '被实例占用',
                icon: 'shield',
                size: 'sm',
                variant: 'ghost',
                disabled: true,
                title: `以下实例正在使用：${usedByNames.join('、')}`,
              })
            : button({
                label: removing === engine.version ? '卸载中…' : '卸载',
                icon: 'trash',
                size: 'sm',
                variant: 'danger',
                disabled: removing !== null,
                onClick: () => void uninstall(engine),
              }),
        ),
      );
      grid.appendChild(card);
    }
    children.push(grid);
    replace(installedHost, children);
  }

  function renderAvailable(): void {
    const installedVersions = new Set((engines ?? []).filter((e) => e.installed).map((e) => e.version));
    const children: Node[] = [];

    children.push(
      h(
        'div',
        { class: 'plugin-head' },
        h('div', { class: 'plugin-head__title' }, icon('layers', 18), h('span', { text: '可安装版本' })),
        available ? badge(`${available.length} 个版本`, 'neutral') : null,
        h('div', { class: 'toolbar__spacer' }),
        h('span', { class: 'section-hint', text: '来源：npm registry（@deepseek-ai/dsh）' }),
      ),
    );

    if (availableState === 'loading') {
      children.push(
        busyRow('正在读取 npm 版本列表…（首次查询可能需要数十秒；本地已安装列表不受影响）'),
      );
      replace(availableHost, children);
      return;
    }

    if (availableState === 'error' || available === null) {
      children.push(
        banner({
          tone: 'danger',
          title: '读取可安装版本失败',
          text: availableError ?? '未知错误',
          actions: [
            button({
              label: '重试',
              size: 'sm',
              variant: 'subtle',
              onClick: () => void loadAvailable({ notify: true }),
            }),
          ],
        }),
      );
      replace(availableHost, children);
      return;
    }

    if (available.length === 0) {
      children.push(listEmpty('npm 未返回任何版本，请检查网络或 registry 配置。', 'globe'));
      replace(availableHost, children);
      return;
    }

    const rows = h('div', { class: 'rows' });
    for (const version of available) {
      const installed = installedVersions.has(version);
      const busy = installing === version;
      const installBtn = button({
        label: installed ? '已安装' : '安装',
        icon: installed ? 'check' : 'download',
        size: 'sm',
        variant: installed ? 'ghost' : 'subtle',
        disabled: installed || installing !== null,
        onClick: () => void install(version),
      });
      if (busy) setBusy(installBtn, true, '安装中…');
      rows.appendChild(
        h(
          'div',
          { class: 'row-item' },
          h('div', { class: 'row-item__icon' }, icon('layers', 16)),
          h(
            'div',
            { class: 'row-item__main' },
            h(
              'div',
              { class: 'row-item__title' },
              h('span', { class: 'mono', text: version }),
              installed ? badge('已安装', 'success', { dot: true }) : null,
              version.includes('alpha') ? badge('预发布', 'warning', { title: 'alpha 版本可能包含不兼容变更' }) : null,
            ),
            h('div', { class: 'row-item__sub', text: `npm install @deepseek-ai/dsh@${version}` }),
          ),
          h('div', { class: 'row-item__side' }, installBtn),
        ),
      );
    }
    children.push(rows);
    replace(availableHost, children);
  }

  function renderConsole(): void {
    if (!installing && consoleLines.length === 0) {
      replace(consoleHost);
      return;
    }
    const box = h('div', { class: 'console' });
    for (const line of consoleLines.slice(-200)) {
      box.appendChild(
        h('div', {
          class: `console__line${line.kind === 'err' ? ' console__line--err' : line.kind === 'sys' ? ' console__line--sys' : ''}`,
          text: line.text,
        }),
      );
    }
    box.scrollTop = box.scrollHeight;

    replace(
      consoleHost,
      card({
        title: installing ? `正在安装引擎 ${installing}` : '安装输出',
        icon: 'terminal',
        desc: '安装过程由 npm 在本机执行，输出实时追加；完成后即可用于创建实例。',
        actions: [
          installing ? spinner('sm') : badge('已完成', 'success', { dot: true }),
          button({
            label: '清空输出',
            icon: 'close',
            size: 'sm',
            variant: 'ghost',
            disabled: installing !== null,
            onClick: () => {
              consoleLines.length = 0;
              renderConsole();
            },
          }),
        ],
        body: [box],
      }),
    );
  }

  function render(): void {
    const count = enginesState === 'ready' && engines ? String(engines.length) : '—';
    const countNode = document.getElementById('engine-count');
    if (countNode) countNode.textContent = `${count} 个已安装`;

    const top: Node[] = [];
    top.push(
      banner({
        tone: 'warning',
        title: '版本兼容提示',
        text: 'dsh 不同大版本之间的 profile 格式不保证兼容；把实例切换到更旧的版本前，请确认 profile 结构未被新版本改写。',
      }),
    );
    if (installing) {
      top.push(
        banner({
          tone: 'info',
          title: `正在安装引擎 ${installing}`,
          text: '安装过程会下载依赖并生成 node_modules；完成后可在「创建实例」中选择该版本。',
        }),
      );
    }

    renderInstalled();
    renderAvailable();
    renderConsole();
    replace(topHost, top);
  }

  const unsubscribe = store.subscribe(() => {
    // 实例名称可能变化（占用列表里的名字），重绘已安装区块
    renderInstalled();
  });

  render();
  // 两段各自加载：本地列表毫秒级返回，npm 列表慢也不会拖住它
  void loadEngines();
  void loadAvailable();

  return {
    el: root,
    destroy(): void {
      unsubscribe();
      clear(consoleHost);
    },
  };
}
