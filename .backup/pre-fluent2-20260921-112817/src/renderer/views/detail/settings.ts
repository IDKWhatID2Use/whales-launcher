/**
 * 实例详情 · 设置页
 *
 * `settings.yaml` 文本编辑器：等宽字体 + 行号槽、脏标记、重新载入、保存（Ctrl+S）。
 * 保存前做前端可判定的校验（非空 / 缩进使用制表符提示），失败就地提示且不提交。
 *
 * QR-15：当实例存在**未解决的共享设置冲突**时，页面顶部显示提示条并给出两个
 * 明确的解决动作（使用本地 / 使用共享），把 core 的"不静默覆盖"落实到界面上。
 */
import type { InstanceSummary, ShareConflictResolution } from '../../../shared/contracts';
import { backend } from '../../data/api';
import { store } from '../../data/store';
import { RESOLUTION_TEXT } from '../../data/share-conflicts';
import { isolationCard } from '../isolation';
import { confirmDialog } from '../../components/modal';
import { toastError, toastSuccess } from '../../components/toast';
import { banner, button, card, setBusy, spinner } from '../../components/ui';
import { createYamlEditor, type YamlEditorHandle } from '../../components/yaml-editor';
import { h, replace } from '../../util/dom';
import { runAction } from '../../util/result';
import type { ViewContext, ViewInstance } from '../../context';

export function createSettingsTab(ctx: ViewContext, summary: InstanceSummary): ViewInstance {
  const instanceId = summary.meta.id;
  /** 隔离策略切换后 store 会换掉摘要对象；页签不会因 store 通知重建，故自行持有最新值。 */
  let current = summary;
  let original = '';
  let value = '';
  let loading = true;
  let saving = false;
  let resolving = false;
  let loadError: string | null = null;

  const editor: YamlEditorHandle = createYamlEditor({
    value: '',
    onChange: (next) => {
      value = next;
      syncStatus();
    },
    onSave: () => void save(),
    ariaLabel: `实例 ${summary.meta.name} 的 settings.yaml`,
  });

  const statusBox = h('div', { class: 'editor-status' });
  const saveButton = button({
    label: '保存',
    icon: 'save',
    variant: 'primary',
    onClick: () => void save(),
  });
  const reloadButton = button({
    label: '重新载入',
    icon: 'reload',
    onClick: () => void load(),
  });

  const root = h('div', { class: 'stack stack--loose' });

  /* ── 启动参数（appArgs） ───────────────────────────────────
   * 给用户的"正规出口"：web profile 默认监听 3080，与另一个实例或别的程序
   * （例如正在运行的 dsh Web）撞端口时，用户需要就地加 `--port 3081` / `--no-open`。
   * 没有这个入口时只能手改 instance.json，而这正是启动失败后最该能自救的地方。
   */
  let argsSaving = false;
  const argsInput = h('input', {
    class: 'input',
    type: 'text',
    value: current.meta.launch.appArgs.join(' '),
    placeholder: '例如：--port 3081 --no-open',
    'aria-label': `实例 ${summary.meta.name} 的启动参数`,
    oninput: () => syncArgsButton(),
  });
  const argsSaveButton = button({
    label: '保存',
    icon: 'save',
    size: 'sm',
    variant: 'subtle',
    disabled: true,
    onClick: () => void saveArgs(),
  });

  /** 按空白拆分参数（含空格的参数暂不支持，故不做引号解析）。 */
  function parseArgs(text: string): string[] {
    return text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  /** 与已保存值一致（或正在保存）时禁用保存按钮。 */
  function syncArgsButton(): void {
    const saved = current.meta.launch.appArgs.join(' ');
    argsSaveButton.disabled = argsSaving || parseArgs(argsInput.value).join(' ') === saved;
  }

  async function saveArgs(): Promise<void> {
    const next = parseArgs(argsInput.value);
    if (next.some((item) => item.includes('\r') || item.includes('\n'))) {
      toastError('启动参数不能包含换行');
      return;
    }
    argsSaving = true;
    setBusy(argsSaveButton, true, '保存中…');
    const updated = await runAction(
      backend().api.instance.update(instanceId, { appArgs: next }),
      '保存启动参数',
    );
    argsSaving = false;
    setBusy(argsSaveButton, false, '保存');
    if (updated === null) {
      syncArgsButton();
      return;
    }
    current = updated;
    store.upsertInstance(updated);
    argsInput.value = updated.meta.launch.appArgs.join(' ');
    toastSuccess('启动参数已保存', { detail: '下次启动生效；正在运行的实例需要重启。' });
    render();
  }

  const dirty = (): boolean => value !== original;

  function syncStatus(): void {
    const lines = editor.lineCount();
    if (loading) {
      replace(statusBox, spinner('sm'), h('span', { text: '正在读取 settings.yaml…' }));
    } else if (!dirty()) {
      statusBox.className = 'editor-status editor-status--saved';
      replace(statusBox, h('span', { text: `已同步 · ${lines} 行` }));
    } else {
      statusBox.className = 'editor-status editor-status--dirty';
      replace(statusBox, h('span', { text: `有未保存的修改 · ${lines} 行` }));
    }
    saveButton.disabled = saving || loading || !dirty();
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    syncStatus();
    render();
    const result = await runAction(backend().api.settings.read(instanceId), '读取设置文件');
    loading = false;
    if (result === null) {
      loadError = '无法读取 settings.yaml，请确认实例目录与权限。';
      render();
      syncStatus();
      return;
    }
    original = result;
    value = result;
    editor.setValue(result);
    editor.setInvalid(false);
    render();
    syncStatus();
  }

  async function save(): Promise<void> {
    if (loading || saving) return;
    const text = editor.getValue();
    if (text.trim().length === 0) {
      editor.setInvalid(true);
      editor.focus();
      toastError('无法保存空的设置文件', {
        detail: 'settings.yaml 必须包含至少一个键值或注释行；如需重置请从主 home 复制一份。',
      });
      return;
    }
    if (/^\t/m.test(text)) {
      editor.setInvalid(true);
      toastError('缩进不能使用制表符', { detail: 'YAML 要求使用空格缩进，请将制表符替换为两个空格。' });
      return;
    }
    editor.setInvalid(false);
    saving = true;
    setBusy(saveButton, true, '保存中…');
    syncStatus();
    const result = await runAction(backend().api.settings.write(instanceId, text), '保存设置文件');
    saving = false;
    setBusy(saveButton, false, '保存');
    if (result === null) {
      syncStatus();
      return;
    }
    original = text;
    toastSuccess('settings.yaml 已保存', { detail: '写入前会生成 .bak 备份，重启实例后生效。' });
    syncStatus();
  }

  /* ── QR-15：共享设置冲突 ─────────────────────────────────── */

  /** 解决冲突：两个方向都先确认（覆盖本地为破坏性 → 红色 + 二次确认） */
  async function resolveConflict(resolution: ShareConflictResolution): Promise<void> {
    const pending = store.conflictsOf(instanceId);
    if (pending.length === 0) return;
    const info = RESOLUTION_TEXT[resolution];
    const destructive = resolution === 'use-shared';
    const conflict = pending[0];
    const confirmed = await confirmDialog({
      title: `${info.label}？`,
      message: `${info.effect}。${info.detail}`,
      detail: conflict
        ? `本实例：${conflict.localFile}\n共享：${conflict.sharedFile}`
        : undefined,
      confirmText: info.label,
      danger: destructive,
      icon: destructive ? 'alertTriangle' : 'link',
    });
    if (!confirmed) return;
    resolving = true;
    render();
    const done = await store.resolveConflict(instanceId, resolution);
    resolving = false;
    if (done) {
      // 本地内容可能已被共享内容覆盖 → 重新读取编辑器
      await load();
    }
    render();
  }

  /** 冲突提示条（只有存在未解决冲突时出现） */
  function conflictBanner(): HTMLElement | null {
    const pending = store.conflictsOf(instanceId);
    const conflict = pending[0];
    if (!conflict) return null;
    const localButton = button({
      label: RESOLUTION_TEXT['use-local'].label,
      icon: 'upload',
      size: 'sm',
      variant: 'subtle',
      disabled: resolving,
      title: RESOLUTION_TEXT['use-local'].effect,
      onClick: () => void resolveConflict('use-local'),
    });
    const sharedButton = button({
      label: RESOLUTION_TEXT['use-shared'].label,
      icon: 'download',
      size: 'sm',
      variant: 'danger',
      disabled: resolving,
      title: RESOLUTION_TEXT['use-shared'].effect,
      onClick: () => void resolveConflict('use-shared'),
    });
    return banner({
      tone: 'warning',
      title: '本地设置与共享设置不一致，尚未应用',
      text: `${conflict.message} 两个方向都会在覆盖前自动备份为 .bak-<时间戳>。`,
      icon: 'alertTriangle',
      actions: resolving ? [spinner('sm'), h('span', { class: 'text-sm', text: '正在应用…' })] : [localButton, sharedButton],
    });
  }

  function render(): void {
    const children: Node[] = [];
    // 摘要对象会被隔离策略切换替换；用户正在输入时不要抢走焦点与内容
    if (document.activeElement !== argsInput) argsInput.value = current.meta.launch.appArgs.join(' ');
    syncArgsButton();

    const conflict = conflictBanner();
    if (conflict) children.push(conflict);

    if (store.runtimeOf(instanceId).state === 'running') {
      children.push(
        banner({
          tone: 'warning',
          title: '实例正在运行',
          text: 'settings.yaml 在启动时读取；运行中保存不会立即生效，重启实例后应用。',
        }),
      );
    }

    if (loadError) {
      children.push(
        banner({
          tone: 'danger',
          title: '读取失败',
          text: loadError,
          actions: [button({ label: '重试', size: 'sm', variant: 'subtle', onClick: () => void load() })],
        }),
      );
    }

    children.push(
      card({
        title: 'settings.yaml',
        icon: 'fileText',
        desc: '实例级全局设置：按插件命名空间分组（如 agent-default-model、agency-agents、skin-*）。',
        actions: [statusBox, reloadButton, saveButton],
        body: [loading ? h('div', { class: 'row' }, spinner(), h('span', { class: 'muted', text: '正在读取…' })) : editor.el],
      }),
    );

    children.push(
      card({
        title: '写入说明',
        icon: 'info',
        body: [
          h(
            'ul',
            { class: 'stack stack--tight' },
            h('li', { class: 'section-hint', text: '· 保存会先备份为 settings.yaml.bak-<时间戳>，再原子写入。' }),
            h('li', { class: 'section-hint', text: '· 「重新载入」丢弃未保存的修改，从磁盘重新读取。' }),
            h('li', { class: 'section-hint', text: '· 快捷键 Ctrl+S 保存，Tab 插入两个空格。' }),
            h('li', { class: 'section-hint', text: '· 与其它实例共享设置时，此文件的修改会影响所有共享实例。' }),
          ),
        ],
      }),
    );

    children.push(
      card({
        title: '启动参数',
        icon: 'play',
        desc: '追加给 dsh 应用层的参数（位于 --profile <名字> 之后）。web profile 常用：--port 3081 换监听端口、--no-open 不自动打开浏览器。',
        body: [
          h(
            'div',
            { class: 'settings-row' },
            h(
              'div',
              { class: 'settings-row__main' },
              h('div', { class: 'settings-row__title', text: 'appArgs' }),
              h('div', {
                class: 'settings-row__desc',
                text: '按空白拆分为多个参数；含空格的参数暂不支持。修改后需重启实例才生效。',
              }),
            ),
            h(
              'div',
              { class: 'settings-row__control' },
              h('div', { class: 'row grow' }, argsInput, argsSaveButton),
            ),
          ),
          h('div', {
            class: 'section-hint',
            text: '· 启动失败提示 EADDRINUSE（端口被占用）时，在这里加 --port 3081 即可换端口。',
          }),
        ],
      }),
    );

    children.push(
      isolationCard({
        ctx,
        summary: current,
        keys: ['settings', 'credentials'],
        desc: '设置文件与凭证决定这个实例的配置是否与其它实例一致。切到共享后 settings.yaml 会被链接到共享设置，修改会影响所有共享实例。',
        onChanged: (updated) => {
          current = updated;
          render();
        },
      }),
    );

    replace(root, children);
  }

  render();
  void load();
  // 冲突可能在启动/切换共享模式后变化：进页面先拉一次，并跟随 store 通知重绘
  void store.refreshConflicts();

  let conflictSignature = conflictKey();
  function conflictKey(): string {
    return store
      .conflictsOf(instanceId)
      .map((item) => `${item.resource}:${item.kept}`)
      .join('|');
  }
  const unsubscribe = store.subscribe(() => {
    const next = conflictKey();
    if (next === conflictSignature) return;
    conflictSignature = next;
    render();
  });

  return {
    el: root,
    destroy(): void {
      unsubscribe();
    },
  };
}
