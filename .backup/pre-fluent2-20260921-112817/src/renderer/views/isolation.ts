/**
 * 隔离策略 —— 架构文档 §4.3 的 4 个维度
 *
 * `workspace` / `saves` / `settings` / `credentials` 决定实例的哪一部分与其它
 * 实例共享。向导第 4 步与实例详情共用这里的**同一份模型与同一份文案**，避免
 * 两处说法不一致（尤其是"共享工作区"的代价，见 `WORKSPACE_SHARED_WARNING`）。
 *
 * 本模块同时是**切换动作的唯一入口**：切到「共享」或从共享切回都会重建磁盘上
 * 的 junction（core 侧按其幂等规则落形），属于结构性变更，所以统一走二次确认。
 * 确认框必须写清两件事：
 *   1. 文件会落在哪里（独立 = 实例目录内，共享 = `shared/...` 共享区）；
 *   2. 什么**不会**被删除（解除链接不递归删除真实目录；删除实例也不会清理共享区）。
 */
import type { CredentialsMode, InstanceSummary, ShareMode, UpdateInstancePatch } from '../../shared/contracts';
import { backend } from '../data/api';
import { store } from '../data/store';
import { confirmDialog } from '../components/modal';
import { toastSuccess } from '../components/toast';
import { banner, card } from '../components/ui';
import { h } from '../util/dom';
import { runAction } from '../util/result';
import type { IconName } from '../icons';
import type { ViewContext } from '../context';
import { isolationRow } from './parts';

/** 4 个隔离维度的键。 */
export type IsolationKey = 'workspace' | 'saves' | 'settings' | 'credentials';

/** 共享工作区的代价：向导与详情共用这一段文案。 */
export const WORKSPACE_SHARED_WARNING = {
  title: '共享工作区：文件实际落在共享区',
  text: '共享后实例的工作区是 junction，文件保存在 shared/workspaces/<实例名>；多个实例指向同一目录时会互相看到、互相覆盖文件。删除实例不会清理共享工作区（core 的有意设计：只报告孤儿目录），需要手工删除。',
};

/** 工作区维度的形态说明（向导第 4 步的开关下方文案）。 */
export const WORKSPACE_DESC =
  '实例的工作目录（dsh 启动时的 cwd，也是文件读写的根）。独立 = instances/<实例名>/workspace；共享 = junction 到 shared/workspaces/<实例名>。';

interface ConfirmSpec {
  title: string;
  message: string;
  detail?: string;
  confirmText: string;
  danger: boolean;
}

interface DimensionModel {
  label: string;
  icon: IconName;
  desc: string;
  options: Array<{ value: string; label: string; title?: string }>;
  current(summary: InstanceSummary): string;
  /** 返回确认框文案；返回 null 表示该方向无需二次确认。 */
  confirm(summary: InstanceSummary, next: string): ConfirmSpec | null;
  /** 切换成功后的 toast 说明。 */
  done(summary: InstanceSummary, next: string): string;
  /** 当前形态需要额外警示时返回提示条内容。 */
  warning(summary: InstanceSummary): { tone: 'warning' | 'info'; title: string; text: string } | null;
}

const SHARED_WORKSPACE_DIR = (summary: InstanceSummary): string => `shared/workspaces/${summary.meta.dirName}`;
const LOCAL_WORKSPACE_DIR = (summary: InstanceSummary): string => `instances/${summary.meta.dirName}/workspace`;

const DIMENSIONS: Record<IsolationKey, DimensionModel> = {
  workspace: {
    label: '工作区',
    icon: 'folder',
    desc: WORKSPACE_DESC,
    options: [
      { value: 'local', label: '独立', title: '文件保存在 instances/<实例名>/workspace' },
      { value: 'shared', label: '共享', title: 'junction 链接到 shared/workspaces/<实例名>' },
    ],
    current: (summary) => summary.meta.workspace.mode,
    confirm: (summary, next) =>
      next === 'shared'
        ? {
            title: '切换为共享工作区？',
            message: `「${summary.meta.name}」的工作区会改建成 junction，链接到共享区。`,
            detail: `${SHARED_WORKSPACE_DIR(summary)}\n\n文件从此落在共享区：多个实例指向同一目录时会互相看到、互相覆盖文件。为避免文件冲突，切换前请先停止该实例。`,
            confirmText: '切换为共享',
            danger: true,
          }
        : {
            title: '改回独立工作区？',
            message: `要解除「${summary.meta.name}」的共享工作区链接，改回实例目录内的工作区吗？`,
            detail: `${LOCAL_WORKSPACE_DIR(summary)}\n\n共享区（${SHARED_WORKSPACE_DIR(summary)}）里的原有文件不会被删除：core 只解除链接，不做递归删除。`,
            confirmText: '改回独立',
            danger: true,
          },
    done: (summary, next) =>
      next === 'shared' ? `工作区已共享 → ${SHARED_WORKSPACE_DIR(summary)}` : `工作区已改回独立 → ${LOCAL_WORKSPACE_DIR(summary)}`,
    warning: (summary) => (summary.meta.workspace.mode === 'shared' ? { tone: 'warning', ...WORKSPACE_SHARED_WARNING } : null),
  },
  saves: {
    label: '会话存档',
    icon: 'archive',
    desc: '会话保存在实例 home/sessions，或链接到 shared/sessions 与其它实例互通。',
    options: [
      { value: 'local', label: '独立' },
      { value: 'shared', label: '共享' },
    ],
    current: (summary) => summary.meta.saves.mode,
    confirm: (summary, next) =>
      next === 'shared'
        ? {
            title: '切换为共享会话库？',
            message: `「${summary.meta.name}」的会话目录会链接到 shared/sessions。`,
            detail: 'shared/sessions\n\n所有使用共享会话库的实例都能看到这里的会话；删除会话目录会影响其它实例。',
            confirmText: '切换为共享',
            danger: true,
          }
        : {
            title: '改回独立会话库？',
            message: `要解除「${summary.meta.name}」的共享会话链接吗？`,
            detail: '共享库中的既有会话不会被删除；解除链接后本实例只看到自己目录内的会话。',
            confirmText: '改回独立',
            danger: true,
          },
    done: (_summary, next) => (next === 'shared' ? '会话存档已共享 → shared/sessions' : '会话存档已改回独立'),
    warning: (summary) =>
      summary.meta.saves.mode === 'shared'
        ? { tone: 'warning', title: '会话库已共享', text: '所有指向 shared/sessions 的实例都能看到这里的会话；删除会话目录会影响其它实例。' }
        : null,
  },
  settings: {
    label: '设置文件',
    icon: 'fileText',
    desc: 'settings.yaml 使用实例自己的副本，或链接到共享设置（修改会影响所有共享实例）。',
    options: [
      { value: 'local', label: '独立' },
      { value: 'shared', label: '共享' },
    ],
    current: (summary) => summary.meta.settings.mode,
    confirm: (summary, next) =>
      next === 'shared'
        ? {
            title: '切换为共享设置？',
            message: `「${summary.meta.name}」的 settings.yaml 会链接到共享设置。`,
            detail: '共享设置\n\n此文件的修改会影响所有共享实例；与本地副本不一致时，设置页会出现「待处理冲突」并等你决定以哪一份为准。',
            confirmText: '切换为共享',
            danger: true,
          }
        : {
            title: '改回独立设置？',
            message: `要解除「${summary.meta.name}」的共享设置链接吗？`,
            detail: '共享设置中的既有内容不会被删除；改回独立后本实例使用自己的 settings.yaml 副本。',
            confirmText: '改回独立',
            danger: true,
          },
    done: (_summary, next) => (next === 'shared' ? '设置文件已共享' : '设置文件已改回独立'),
    warning: (summary) =>
      summary.meta.settings.mode === 'shared'
        ? {
            tone: 'warning',
            title: '设置文件已共享',
            text: 'settings.yaml 指向共享设置：修改会影响所有共享实例，与本地副本不一致时会出现待处理冲突。',
          }
        : null,
  },
  credentials: {
    label: '凭证',
    icon: 'key',
    desc: '继承主 home：启动前从「主 home」同步 .credentials.yaml，无需每个实例重新登录。',
    options: [
      { value: 'inherit', label: '继承主 home', title: '启动前从主 home 复制 .credentials.yaml' },
      { value: 'local', label: '实例独立', title: '使用实例自己的 .credentials.yaml' },
    ],
    current: (summary) => summary.meta.credentials.mode,
    confirm: (summary, next) =>
      next === 'inherit'
        ? {
            title: '改为继承主 home 凭证？',
            message: `「${summary.meta.name}」将在每次启动前从主 home 同步 .credentials.yaml。`,
            detail: '主 home 退出登录或更换账号后，继承的实例下次启动会跟着变化（不是链接，是启动时复制）。',
            confirmText: '改为继承',
            danger: false,
          }
        : {
            title: '改为实例独立凭证？',
            message: `「${summary.meta.name}」将使用自己目录内的 .credentials.yaml。`,
            detail: '当前继承到的凭证文件会保留在实例 home 内；主 home 之后的登录变化不再同步。',
            confirmText: '改为独立',
            danger: false,
          },
    done: (_summary, next) => (next === 'inherit' ? '凭证改为继承主 home' : '凭证改为实例独立'),
    warning: (summary) =>
      summary.meta.credentials.mode === 'inherit'
        ? { tone: 'info', title: '凭证继承主 home', text: '启动前从主 home 同步 .credentials.yaml；主 home 重新登录后，继承实例下次启动即生效。' }
        : null,
  },
};

/** 维度顺序（向导与详情一致）。 */
export const ISOLATION_ORDER: IsolationKey[] = ['workspace', 'saves', 'settings', 'credentials'];

/** 隔离维度的显示名，供摘要/提示复用。 */
export function isolationLabel(key: IsolationKey): string {
  return DIMENSIONS[key].label;
}

/** 隔离维度的形态说明（向导第 4 步与详情卡片共用同一份文案）。 */
export function isolationDesc(key: IsolationKey): string {
  return DIMENSIONS[key].desc;
}

/** 写补丁：把键值映射为类型安全的 `UpdateInstancePatch`。 */
function patchFor(key: IsolationKey, value: string): UpdateInstancePatch {
  switch (key) {
    case 'workspace':
      return { workspace: value as ShareMode };
    case 'saves':
      return { saves: value as ShareMode };
    case 'settings':
      return { settings: value as ShareMode };
    case 'credentials':
      return { credentials: value as CredentialsMode };
  }
}

/**
 * 切换一个隔离维度：二次确认 → `instance.update` → 刷新 store 与外壳。
 *
 * @returns 更新后的实例摘要；用户取消或失败时为 null。
 */
export async function applyIsolationChange(
  ctx: ViewContext,
  summary: InstanceSummary,
  key: IsolationKey,
  next: string,
): Promise<InstanceSummary | null> {
  const model = DIMENSIONS[key];
  if (next === model.current(summary)) return null;
  const spec = model.confirm(summary, next);
  if (spec) {
    const confirmed = await confirmDialog({
      title: spec.title,
      message: spec.message,
      detail: spec.detail,
      confirmText: spec.confirmText,
      danger: spec.danger,
      icon: spec.danger ? 'alertTriangle' : model.icon,
    });
    if (!confirmed) return null;
  }
  const updated = await runAction(backend().api.instance.update(summary.meta.id, patchFor(key, next)), `切换${model.label}`);
  if (updated === null) return null;
  store.upsertInstance(updated);
  ctx.refreshShell();
  toastSuccess(`已更新「${updated.meta.name}」的${model.label}`, { detail: model.done(updated, next) });
  return updated;
}

/** 只读的开关行（用于向导：切换后由调用方重建视图）。 */
export function isolationSwitchRow(key: IsolationKey, value: string, onChange: (next: string) => void): HTMLElement {
  const model = DIMENSIONS[key];
  return isolationRow<string>({
    label: model.label,
    desc: model.desc,
    value,
    options: model.options,
    onChange,
  });
}

/**
 * 实例详情的「隔离策略」卡片。
 *
 * 切换成功后调用 `onChanged`（详情页的页签不会因 store 通知重建，所以要由调用方
 * 用返回的摘要刷新自己的显示）。
 */
export function isolationCard(config: {
  ctx: ViewContext;
  summary: InstanceSummary;
  keys: IsolationKey[];
  desc?: string;
  actions?: Node[];
  onChanged: (updated: InstanceSummary) => void;
}): HTMLElement {
  const rows: Node[] = config.keys.map((key) =>
    isolationSwitchRow(key, DIMENSIONS[key].current(config.summary), (next) => {
      void applyIsolationChange(config.ctx, config.summary, key, next).then((updated) => {
        if (updated) config.onChanged(updated);
      });
    }),
  );

  const warnings: Node[] = [];
  for (const key of config.keys) {
    const warn = DIMENSIONS[key].warning(config.summary);
    if (warn) warnings.push(banner({ tone: warn.tone, title: warn.title, text: warn.text }));
  }

  return card({
    title: '隔离策略',
    icon: 'shield',
    desc: config.desc ?? '决定实例的哪一部分与其它实例共享。共享通过 Windows junction 链接实现，无需管理员权限；切换会重建链接，属于结构性变更。',
    actions: config.actions,
    body: [
      ...rows,
      ...warnings,
      h(
        'div',
        { class: 'section-hint', text: '解除共享只解除链接，不会递归删除共享区里的真实目录；删除实例时共享区的文件同样保留。' },
      ),
    ],
  });
}
