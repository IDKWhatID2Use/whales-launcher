/**
 * 创建实例向导
 *
 * 四步：名称与外观 → 引擎版本 → profile 模板 → 隔离策略。
 * 右侧常驻摘要卡实时反映当前选择；实例名做与 dsh 一致的前端校验；
 * 提交阶段显示分步进度，失败时保留全部已填内容。
 */
import type { CredentialsMode, EngineInfo, InstanceSummary, ShareMode } from '../../shared/contracts';
import { avatar, colorPicker, iconPicker, isolationRow, TEMPLATES, templateBundles, templateInfo } from './parts';
import { isolationDesc, WORKSPACE_SHARED_WARNING } from './isolation';
import { backend } from '../data/api';
import { store } from '../data/store';
import { toastError, toastSuccess } from '../components/toast';
import { badge, banner, button, card, chip, emptyState, spinner } from '../components/ui';
import { icon } from '../icons';
import { clear, h, replace } from '../util/dom';
import { runAction, withTimeout } from '../util/result';
import { NAME_MAX_LENGTH, previewDirName, validateInstanceName } from '../util/names';
import type { ViewContext, ViewInstance } from '../context';

interface WizardState {
  name: string;
  icon: string | null;
  color: string;
  note: string;
  engineVersion: string;
  template: string;
  profileName: string;
  workspace: ShareMode;
  saves: ShareMode;
  settings: ShareMode;
  credentials: CredentialsMode;
}

const STEP_TITLES = ['名称与外观', '选择引擎版本', '选择 profile 模板', '隔离策略'];

export function createWizardView(ctx: ViewContext): ViewInstance {
  const state: WizardState = {
    name: '',
    icon: '🐳',
    color: '#4D8DFF',
    note: '',
    engineVersion: '',
    template: 'web',
    profileName: 'main',
    workspace: 'local',
    saves: 'local',
    settings: 'local',
    credentials: 'inherit',
  };

  let step = 0;
  let creating = false;
  let createStepIndex = -1;
  const timers = new Set<number>();
  let engines: EngineInfo[] | null = null;
  let available: string[] | null = null;
  let enginesError: string | null = null;
  let createdInstance: InstanceSummary | null = null;

  const root = h('div', { class: 'view' });
  const mainHost = h('div', { class: 'wizard__main' });
  const sideHost = h('div', { class: 'wizard__side' });
  /** 底部导航独立成宿主：输入变化时可原地重建，而不打断正在填写的表单 */
  const navHost = h('div');

  const head = h(
    'div',
    { class: 'view__head' },
    h(
      'div',
      { class: 'view__head-main' },
      h('h1', { class: 'view__title' }, h('span', { text: '新建实例' })),
      h('div', {
        class: 'view__sub',
        text: '每个实例拥有独立的 DSH_HOME（profile、插件、设置、会话），互不干扰。',
      }),
    ),
    h(
      'div',
      { class: 'view__actions' },
      button({ label: '返回实例列表', icon: 'arrowLeft', onClick: () => ctx.navigate('#/instances') }),
    ),
  );

  root.appendChild(head);
  root.appendChild(
    h('div', { class: 'view__body' }, h('div', { class: 'view__inner' }, h('div', { class: 'wizard' }, mainHost, sideHost))),
  );

  /* ── 引擎列表装载 ─────────────────────────────────────────── */

  /**
   * 两段**分开**加载：本地引擎列表必须立刻可用（否则用户卡在"请选择引擎版本"），
   * npm 版本列表只作为补充。曾经用 `Promise.all` 合并，npm 慢时整步都在转圈。
   */
  async function loadEngines(): Promise<void> {
    enginesError = null;
    const localResult = await withTimeout(backend().api.engine.list(), 12_000, '读取已安装引擎');
    if (localResult.ok) {
      engines = localResult.value;
    } else {
      engines = [];
      enginesError = localResult.error;
      toastError('读取已安装引擎失败', { detail: localResult.error });
    }
    if (state.engineVersion.length === 0) {
      const installed = engines.find((e) => e.installed);
      state.engineVersion = installed?.version ?? '';
    }
    repaint();

    const remoteResult = await withTimeout(backend().api.engine.available(), 30_000, '读取 npm 版本列表');
    if (remoteResult.ok) {
      available = remoteResult.value;
      if (state.engineVersion.length === 0) state.engineVersion = available[0] ?? '';
    } else {
      available = [];
      // 本地列表已可用，网络失败只降级提示，不阻塞这一步
      enginesError = enginesError ?? `${remoteResult.error}（仍可从本地已安装版本中选择）`;
    }
    repaint();
  }

  /** 只有引擎版本这一步需要重建；其它步骤重建会打断用户正在填写的输入 */
  function repaint(): void {
    if (step === 1 || creating) render();
    else renderSide();
  }

  /* ── 校验 ─────────────────────────────────────────────────── */

  function stepError(index: number): string | null {
    if (index === 0) {
      const nameError = validateInstanceName(state.name);
      if (nameError) return nameError;
      return null;
    }
    if (index === 1) {
      if (state.engineVersion.length === 0) return '请选择一个引擎版本';
      return null;
    }
    if (index === 2) {
      if (state.template.length === 0) return '请选择 profile 模板';
      if (state.profileName.trim().length === 0) return 'profile 名不能为空';
      return null;
    }
    return null;
  }

  function firstInvalidStep(): number {
    for (let i = 0; i <= 2; i += 1) {
      if (stepError(i) !== null) return i;
    }
    return 3;
  }

  /* ── 侧栏摘要 ─────────────────────────────────────────────── */

  function renderSide(): void {
    const template = templateInfo(state.template);
    const engineInstalled = engines?.some((e) => e.version === state.engineVersion && e.installed) ?? false;
    const preview = h(
      'div',
      { class: 'inst-card', style: { '--card-accent': state.color, cursor: 'default' } },
      h(
        'div',
        { class: 'inst-card__top' },
        avatar({ name: state.name || '新实例', icon: state.icon, color: state.color }, 'lg'),
        h(
          'div',
          { class: 'inst-card__head' },
          h('div', { class: 'inst-card__name', text: state.name || '（未命名实例）' }),
          h('div', { class: 'inst-card__note', text: state.note || '（无备注）' }),
        ),
        badge('预览', 'accent'),
      ),
      h(
        'div',
        { class: 'inst-card__chips' },
        chip(state.engineVersion || '未选择引擎'),
        chip(template.label),
      ),
    );

    const summary = h(
      'div',
      { class: 'summary-list' },
      summaryItem('实例名', state.name || '—'),
      summaryItem('目录名', state.name ? previewDirName(state.name) : '—'),
      summaryItem('引擎', state.engineVersion || '—'),
      summaryItem('模板', `${template.label}（${state.template}）`),
      summaryItem('profile', state.profileName || 'main'),
      summaryItem('工作区', state.workspace === 'shared' ? '共享（shared/workspaces）' : '独立'),
      summaryItem('存档', state.saves === 'shared' ? '共享（实例互通）' : '独立'),
      summaryItem('设置', state.settings === 'shared' ? '共享' : '独立'),
      summaryItem('凭证', state.credentials === 'inherit' ? '继承主 home' : '实例独立'),
    );

    replace(
      sideHost,
      card({
        title: '实例预览',
        icon: 'package',
        desc: '创建后即可在实例列表中看到它。',
        body: [preview],
      }),
      card({
        title: '配置摘要',
        icon: 'list',
        body: [summary],
        foot: [
          engineInstalled
            ? badge('引擎已就绪', 'success', { dot: true })
            : badge('引擎未安装', 'warning', { dot: true }),
          h('div', { class: 'toolbar__spacer' }),
          button({
            label: '创建实例',
            icon: 'check',
            variant: 'primary',
            disabled: creating || firstInvalidStep() !== 3,
            onClick: () => void submit(),
          }),
        ],
      }),
    );
  }

  function summaryItem(key: string, value: string): HTMLElement {
    return h(
      'div',
      { class: 'summary-item' },
      h('div', { class: 'summary-item__k', text: key }),
      h('div', { class: 'summary-item__v', text: value }),
    );
  }

  /* ── 步骤内容 ─────────────────────────────────────────────── */

  function stepsBar(): HTMLElement {
    const nodes: Node[] = [];
    STEP_TITLES.forEach((title, index) => {
      if (index > 0) nodes.push(h('div', { class: 'steps__sep' }));
      nodes.push(
        h(
          'button',
          {
            class: `steps__item${index === step ? ' is-active' : ''}${index < step ? ' is-done' : ''}`,
            type: 'button',
            disabled: creating || index > step,
            title: index <= step ? `跳到：${title}` : `请先完成前面的步骤`,
            onclick: () => {
              if (creating) return;
              if (index < step) {
                step = index;
                render();
              } else if (index > step && firstInvalidStep() > step) {
                render();
                toastError('请先完成当前步骤', { detail: stepError(step) ?? '' });
              }
            },
          },
          h('span', { class: 'steps__dot' }, index < step ? icon('check', 14) : String(index + 1)),
          h('span', { class: 'steps__label', text: title }),
        ),
      );
    });
    return h('div', { class: 'steps' }, nodes);
  }

  function renderStepName(): HTMLElement {
    const iconPickerHandle = iconPicker(state.icon, (value) => {
      state.icon = value;
      renderSide();
    });
    const colorPickerHandle = colorPicker(state.color, (value) => {
      state.color = value;
      renderSide();
    });

    const nameInput = h('input', {
      class: 'input',
      type: 'text',
      value: state.name,
      placeholder: '例如：我的工作台',
      maxlength: String(NAME_MAX_LENGTH),
      autocomplete: 'off',
    });
    const nameMessage = h('div', { class: 'field__hint', text: '不能包含 / \\ 等字符，且不能使用 desktop、node_modules 等保留名。' });
    const dirPreview = h('div', { class: 'field__hint' });

    const validate = (): string | null => {
      const error = validateInstanceName(nameInput.value);
      state.name = nameInput.value;
      nameInput.classList.toggle('is-invalid', error !== null && nameInput.value.length > 0);
      if (nameInput.value.length === 0) {
        nameMessage.className = 'field__hint';
        nameMessage.textContent = '不能包含 / \\ 等字符，且不能使用 desktop、node_modules 等保留名。';
      } else if (error) {
        nameMessage.className = 'field__error';
        nameMessage.textContent = error;
      } else {
        nameMessage.className = 'field__ok';
        nameMessage.textContent = '名称可用';
      }
      dirPreview.textContent =
        nameInput.value.length > 0 ? `预计目录名：instances\\${previewDirName(nameInput.value)}` : '';
      renderSide();
      // 名称合法与否直接决定「下一步」是否可用
      renderNav();
      return error;
    };
    nameInput.addEventListener('input', () => void validate());

    const noteInput = h('textarea', {
      class: 'textarea',
      rows: '3',
      placeholder: '备注（可选）：这个实例用来做什么？',
      value: state.note,
    });
    noteInput.addEventListener('input', () => {
      state.note = noteInput.value;
      renderSide();
    });

    const body = h(
      'div',
      { class: 'wizard__step-body' },
      h(
        'div',
        { class: 'wizard__step-title' },
        h('h2', { text: '名称与外观' }),
        h('p', { text: '实例名会作为 dsh profile 名校验；目录名由启动器自动派生并去重。' }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label' }, h('span', { text: '实例名称' }), h('span', { class: 'field__req', text: '*' })),
        nameInput,
        nameMessage,
        dirPreview,
      ),
      h(
        'div',
        { class: 'split-2' },
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label' }, h('span', { text: '图标' })),
          iconPickerHandle.el,
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label' }, h('span', { text: '强调色' })),
          colorPickerHandle.el,
          h('div', { class: 'field__hint', text: '强调色用于实例卡片色条与头像背景。' }),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label' }, h('span', { text: '备注' })),
        noteInput,
      ),
    );

    // 初次校验，保证摘要与提示同步
    window.setTimeout(() => void validate(), 0);
    return body;
  }

  function renderStepEngine(): HTMLElement {
    const body = h('div', { class: 'wizard__step-body' });
    body.appendChild(
      h(
        'div',
        { class: 'wizard__step-title' },
        h('h2', { text: '选择引擎版本' }),
        h('p', { text: '实例绑定单一 dsh 版本；不同实例可以使用不同版本，互不影响。' }),
      ),
    );

    if (enginesError) {
      body.appendChild(
        banner({
          tone: 'warning',
          title: '版本列表读取不完整',
          text: enginesError,
          actions: [
            button({ label: '重试', size: 'sm', variant: 'subtle', onClick: () => void loadEngines() }),
            button({ label: '打开版本管理', size: 'sm', variant: 'ghost', onClick: () => ctx.navigate('#/engines') }),
          ],
        }),
      );
    }

    if (engines === null) {
      body.appendChild(h('div', { class: 'row' }, spinner(), h('span', { class: 'muted', text: '正在读取引擎版本…' })));
      return body;
    }

    const installedVersions = new Set(engines.filter((e) => e.installed).map((e) => e.version));
    const allVersions: string[] = [];
    for (const engine of engines) if (engine.installed) allVersions.push(engine.version);
    for (const version of available ?? []) if (!installedVersions.has(version)) allVersions.push(version);

    if (allVersions.length === 0) {
      body.appendChild(
        emptyState({
          icon: 'cpu',
          title: '还没有可用引擎',
          desc: '请先在「版本管理」中安装至少一个 dsh 引擎版本，然后回到这里继续创建实例。',
          compact: true,
          actions: [button({ label: '前往版本管理', icon: 'layers', variant: 'primary', onClick: () => ctx.navigate('#/engines') })],
        }),
      );
      return body;
    }

    const list = h('div', { class: 'rows' });
    for (const version of allVersions) {
      const installed = installedVersions.has(version);
      const selected = state.engineVersion === version;
      const row = h(
        'button',
        {
          class: 'row-item',
          type: 'button',
          style: {
            border: 'none',
            width: '100%',
            textAlign: 'left',
            background: selected ? 'var(--accent-softer)' : 'transparent',
            boxShadow: selected ? 'inset 0 0 0 1px var(--accent-border)' : 'none',
            cursor: 'pointer',
          },
          onclick: () => {
            state.engineVersion = version;
            render();
          },
        },
        h('div', { class: 'row-item__icon' }, icon(selected ? 'check' : 'cpu', 16)),
        h(
          'div',
          { class: 'row-item__main' },
          h('div', { class: 'row-item__title' }, h('span', { class: 'mono', text: version }), installed ? badge('已安装', 'success', { dot: true }) : badge('未安装', 'warning', { dot: true })),
          h('div', {
            class: 'row-item__sub',
            text: installed ? '本地已就绪，可立即创建并启动' : '创建前需要下载安装（需要网络，可在版本管理页查看进度）',
          }),
        ),
        h('div', { class: 'row-item__side' }, selected ? badge('已选择', 'accent') : null),
      );
      list.appendChild(row);
    }
    body.appendChild(list);

    if (state.engineVersion && !installedVersions.has(state.engineVersion)) {
      body.appendChild(
        banner({
          tone: 'warning',
          title: `引擎 ${state.engineVersion} 尚未安装`,
          text: '可以先创建实例，但启动前必须完成安装；也可以现在前往版本管理安装后再回来。',
          actions: [button({ label: '前往版本管理', size: 'sm', variant: 'subtle', onClick: () => ctx.navigate('#/engines') })],
        }),
      );
    }

    return body;
  }

  function renderStepTemplate(): HTMLElement {
    const body = h('div', { class: 'wizard__step-body' });
    body.appendChild(
      h(
        'div',
        { class: 'wizard__step-title' },
        h('h2', { text: '选择 profile 模板' }),
        h('p', { text: '模板决定实例随附哪些组合包；创建后可继续安装、启用或停用其它插件。' }),
      ),
    );

    const grid = h('div', { class: 'pick-grid' });
    for (const template of TEMPLATES) {
      const selected = state.template === template.value;
      grid.appendChild(
        h(
          'button',
          {
            class: `pick-card${selected ? ' is-selected' : ''}`,
            type: 'button',
            onclick: () => {
              state.template = template.value;
              render();
            },
          },
          h(
            'div',
            { class: 'pick-card__head' },
            h('span', { class: 'pick-card__name', text: template.label }),
            template.recommended ? badge('推荐', 'accent') : null,
            selected ? badge('已选择', 'success', { dot: true }) : null,
          ),
          h('div', { class: 'pick-card__desc', text: template.desc }),
          h(
            'div',
            { class: 'pick-card__foot' },
            templateBundles(template.value).map((name) => chip(name.split('/').pop() ?? name)),
          ),
        ),
      );
    }
    body.appendChild(grid);

    const profileInput = h('input', {
      class: 'input',
      type: 'text',
      value: state.profileName,
      maxlength: '48',
      placeholder: 'main',
      oninput: () => {
        state.profileName = profileInput.value;
        renderSide();
        renderNav();
      },
    });
    body.appendChild(
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label' }, h('span', { text: 'profile 名称' }), h('span', { class: 'field__req', text: '*' })),
        profileInput,
        h('div', {
          class: 'field__hint',
          text: '默认 main；对应 $DSH_HOME/profiles/<名称>。已有实例使用其它 profile 时，可在此指定同名 profile 复用配置。',
        }),
      ),
    );

    return body;
  }

  function renderStepIsolation(): HTMLElement {
    const body = h('div', { class: 'wizard__step-body' });
    body.appendChild(
      h(
        'div',
        { class: 'wizard__step-title' },
        h('h2', { text: '隔离策略' }),
        h('p', { text: '分别决定工作区、会话存档、设置文件与凭证是否与其它实例共享。共享通过 Windows junction 链接实现，无需管理员权限。' }),
      ),
    );

    const presets = h(
      'div',
      { class: 'row wrap' },
      button({
        label: '完全隔离（推荐）',
        icon: 'shield',
        size: 'sm',
        variant: state.workspace === 'local' && state.saves === 'local' && state.settings === 'local' ? 'subtle' : 'ghost',
        onClick: () => {
          state.workspace = 'local';
          state.saves = 'local';
          state.settings = 'local';
          state.credentials = 'inherit';
          render();
        },
      }),
      button({
        label: '存档互通',
        icon: 'link',
        size: 'sm',
        variant: state.saves === 'shared' ? 'subtle' : 'ghost',
        onClick: () => {
          state.saves = 'shared';
          render();
        },
      }),
      button({
        label: '全部共享',
        icon: 'archive',
        size: 'sm',
        variant: state.workspace === 'shared' && state.saves === 'shared' && state.settings === 'shared' ? 'subtle' : 'ghost',
        onClick: () => {
          state.workspace = 'shared';
          state.saves = 'shared';
          state.settings = 'shared';
          render();
        },
      }),
    );
    body.appendChild(h('div', { class: 'field' }, h('label', { class: 'field__label' }, h('span', { text: '快速预设' })), presets));

    body.appendChild(
      isolationRow<ShareMode>({
        label: '工作区',
        desc: isolationDesc('workspace'),
        value: state.workspace,
        options: [
          { value: 'local', label: '独立' },
          { value: 'shared', label: '共享' },
        ],
        onChange: (value) => {
          state.workspace = value;
          render();
        },
      }),
    );
    body.appendChild(
      isolationRow<ShareMode>({
        label: '会话存档',
        desc: isolationDesc('saves'),
        value: state.saves,
        options: [
          { value: 'local', label: '独立' },
          { value: 'shared', label: '共享' },
        ],
        onChange: (value) => {
          state.saves = value;
          render();
        },
      }),
    );
    body.appendChild(
      isolationRow<ShareMode>({
        label: '设置文件',
        desc: isolationDesc('settings'),
        value: state.settings,
        options: [
          { value: 'local', label: '独立' },
          { value: 'shared', label: '共享' },
        ],
        onChange: (value) => {
          state.settings = value;
          render();
        },
      }),
    );
    body.appendChild(
      isolationRow<CredentialsMode>({
        label: '凭证',
        desc: isolationDesc('credentials'),
        value: state.credentials,
        options: [
          { value: 'inherit', label: '继承主 home' },
          { value: 'local', label: '实例独立' },
        ],
        onChange: (value) => {
          state.credentials = value;
          render();
        },
      }),
    );

    body.appendChild(
      state.workspace === 'shared'
        ? banner({ tone: 'warning', title: WORKSPACE_SHARED_WARNING.title, text: WORKSPACE_SHARED_WARNING.text, icon: 'alertTriangle' })
        : banner({
            tone: 'info',
            title: '工作区默认独立',
            text: '文件保存在 instances/<实例名>/workspace，随实例目录一起管理。改成共享会让文件落到 shared/workspaces/<实例名>，与其它指向同一目录的实例互相可见。',
            icon: 'folder',
          }),
    );

    return body;
  }

  /* ── 提交进度 ─────────────────────────────────────────────── */

  const CREATE_STEPS = [
    '校验实例名与目录名',
    '创建目录结构（home / workspace / logs）',
    '初始化 profile（dsh --from-default-profile）',
    '写入 instance.json 与共享链接',
  ];

  function renderProgress(): HTMLElement {
    const items = CREATE_STEPS.map((title, index) =>
      h(
        'div',
        {
          class: `progress-steps__item${index < createStepIndex ? ' is-done' : ''}${index === createStepIndex ? ' is-active' : ''}`,
        },
        h('span', { class: 'progress-steps__mark' }, index < createStepIndex ? icon('check', 12) : index === createStepIndex ? spinner('sm') : String(index + 1)),
        h('span', { text: title }),
      ),
    );

    return h(
      'div',
      { class: 'wizard__step-body' },
      h(
        'div',
        { class: 'wizard__step-title' },
        h('h2', { text: createdInstance ? '创建完成' : '正在创建实例' }),
        h('p', {
          text: createdInstance
            ? '实例已加入列表，正在打开详情页面…'
            : '正在执行 dsh 的 profile 初始化（非交互、不启动应用、不调用模型）。',
        }),
      ),
      card({
        title: '创建进度',
        icon: 'wand',
        body: [
          h('div', { class: 'progress-steps' }, items),
          h('div', { class: 'path-text', text: `目标：instances\\${previewDirName(state.name)}` }),
        ],
        foot: [
          createdInstance ? badge('已完成', 'success', { dot: true }) : badge('进行中', 'warning', { dot: true }),
          h('div', { class: 'toolbar__spacer' }),
          button({
            label: '查看实例',
            icon: 'chevronRight',
            variant: 'primary',
            disabled: !createdInstance,
            onClick: () => {
              if (createdInstance) ctx.navigate(`#/instance/${encodeURIComponent(createdInstance.meta.id)}/plugins`);
            },
          }),
        ],
      }),
    );
  }

  function schedule(ms: number, fn: () => void): void {
    const handle = window.setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
  }

  async function submit(): Promise<void> {
    const invalid = firstInvalidStep();
    if (invalid !== 3) {
      step = invalid;
      render();
      toastError('还有必填项未完成', { detail: stepError(invalid) ?? '' });
      return;
    }
    creating = true;
    createStepIndex = 0;
    render();
    schedule(240, () => {
      createStepIndex = 1;
      render();
    });
    schedule(520, () => {
      createStepIndex = 2;
      render();
    });

    const created = await runAction(
      backend().api.instance.create({
        name: state.name.trim(),
        icon: state.icon,
        color: state.color,
        note: state.note.trim(),
        engineVersion: state.engineVersion,
        template: state.template,
        profileName: state.profileName.trim() || 'main',
        workspace: state.workspace,
        saves: state.saves,
        settings: state.settings,
        credentials: state.credentials,
      }),
      '创建实例',
    );

    if (!created) {
      creating = false;
      createStepIndex = -1;
      render();
      return;
    }

    createStepIndex = CREATE_STEPS.length;
    createdInstance = created;
    store.upsertInstance(created);
    ctx.refreshShell();
    toastSuccess(`实例「${created.meta.name}」已创建`, {
      detail: `引擎 ${created.meta.engine.version} · 模板 ${templateInfo(created.meta.profile.template).label}`,
      action: { label: '立即启动', onClick: () => void startNow(created) },
    });
    render();
    schedule(700, () => {
      ctx.navigate(`#/instance/${encodeURIComponent(created.meta.id)}/plugins`);
    });
  }

  async function startNow(summary: InstanceSummary): Promise<void> {
    const launched = await runAction(backend().api.instance.launch({ instanceId: summary.meta.id }), '启动实例');
    if (!launched) return;
    toastSuccess(`已启动「${summary.meta.name}」`);
    ctx.openLogDrawer(summary.meta.id);
  }

  /* ── 底部导航（随输入校验实时刷新） ───────────────────────── */

  function renderNav(): void {
    const error = stepError(step);
    const nav = h('div', { class: 'wizard__nav' });
    nav.appendChild(
      button({
        label: '上一步',
        icon: 'arrowLeft',
        variant: 'ghost',
        disabled: step === 0,
        onClick: () => {
          step = Math.max(0, step - 1);
          render();
        },
      }),
    );
    nav.appendChild(h('div', { class: 'wizard__nav-spacer' }));
    if (error) {
      nav.appendChild(h('div', { class: 'field__error' }, icon('alertCircle', 14), h('span', { text: error })));
    }
    nav.appendChild(
      step < STEP_TITLES.length - 1
        ? button({
            label: '下一步',
            iconAfter: 'chevronRight',
            variant: 'primary',
            disabled: error !== null,
            onClick: () => {
              if (stepError(step) !== null) return;
              step += 1;
              render();
            },
          })
        : button({
            label: '创建实例',
            icon: 'check',
            variant: 'primary',
            disabled: error !== null,
            onClick: () => void submit(),
          }),
    );
    replace(navHost, nav);
  }

  /* ── 渲染 ─────────────────────────────────────────────────── */

  function render(): void {
    // 重建步骤面板前记住文本输入焦点，避免刷新时打断输入
    const active = document.activeElement;
    const restoreFocus =
      active instanceof HTMLInputElement && active.type === 'text' && mainHost.contains(active);
    const caret = restoreFocus && active instanceof HTMLInputElement ? active.selectionStart : null;

    clear(mainHost);
    mainHost.appendChild(stepsBar());

    if (creating) {
      mainHost.appendChild(renderProgress());
      renderSide();
      renderNav();
      return;
    }

    mainHost.appendChild(
      step === 0 ? renderStepName() : step === 1 ? renderStepEngine() : step === 2 ? renderStepTemplate() : renderStepIsolation(),
    );
    mainHost.appendChild(navHost);
    renderNav();

    if (restoreFocus) {
      const next = mainHost.querySelector<HTMLInputElement>('.wizard__step-body input[type="text"]');
      if (next) {
        next.focus();
        const end = caret ?? next.value.length;
        next.setSelectionRange(end, end);
      }
    }

    renderSide();
  }

  /* ── 初始化 ───────────────────────────────────────────────── */

  render();
  void loadEngines();

  return {
    el: root,
    destroy(): void {
      for (const handle of timers) window.clearTimeout(handle);
      timers.clear();
    },
  };
}
