/**
 * WhalesLauncher core —— 会话（存档）枚举与 workspace 目录编码
 *
 * dsh 的会话落盘规则（源码依据：`@deepseek-ai/dsh-session-persistence-jsonl`）：
 * ```
 * <DSH_HOME>/sessions/<projectKey(cwd)>/<sessionId>/session.vX.jsonl.zstd
 * ```
 * `projectKey` 的算法**逐字符复刻源码**（非推测）：
 *  - `/`、`\`、`:` 折叠成单个 `-`（连续分隔符只算一个）；
 *  - `[A-Za-z0-9._-]` 原样保留；
 *  - 其余字符（含中文、空格、`~`）编码为 `~XXXX`（UTF-16 码元十六进制，大写，4 位）；
 *  - 去掉开头的 `-`，空串回退 `root`，截断到 251 字符，两端包 `--`。
 *
 * 实测校验：`F:\WhalesLauncher` → `--F-WhalesLauncher--`、
 * `C:\Users\user\.dsh` → `--C-Users-user-.dsh--`（与真实 dsh 的会话目录命名一致）。
 */
import path from 'node:path';
import type { InstanceMeta, SessionInfo } from '../shared/contracts';
import { listDir, scanTree } from './fsx';
import { instancePaths } from './paths';

/** 无 cwd 会话的固定目录名（dsh 源码常量）。 */
export const NO_CWD_KEY = '_no-cwd';

/** projectKey 的截断长度（dsh 源码常量）。 */
const KEY_MAX_LENGTH = 251;

/**
 * 计算 workspace 路径对应的会话目录名（dsh `projectKey` 的逐字符复刻）。
 *
 * 传入路径会先经 `path.resolve` 归一化，保证与子进程 `process.cwd()` 的取值一致
 * （dsh 用 cwd 生成该键，尾随分隔符会产生不同的键）。
 * @param workspacePath 工作目录路径。
 * @returns 会话目录名，形如 `--F-WhalesLauncher--`。
 * @throws 路径为空。
 */
export function workspaceKeyFor(workspacePath: string): string {
  if (workspacePath.length === 0) throw new Error('无法编码空的 workspace 路径');
  const normalized = path.resolve(workspacePath);
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root';
  return `--${trimmed.slice(0, KEY_MAX_LENGTH)}--`;
}

/**
 * 枚举实例 home 下的全部会话。
 *
 * 直接扫描 `<DSH_HOME>/sessions/<workspaceKey>/<sessionId>/`：`workspaceKey` 为
 * 归属的工作目录编码目录名，`sessionId` 为会话目录名（dsh 的会话 id）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 会话列表（按最后修改时间从新到旧）。
 */
export async function listSessions(root: string, meta: InstanceMeta): Promise<SessionInfo[]> {
  const paths = instancePaths(root, meta);
  const sessions: SessionInfo[] = [];
  for (const workspaceEntry of await listDir(paths.sessions)) {
    if (!workspaceEntry.isDirectory() && !workspaceEntry.isSymbolicLink()) continue;
    const workspaceKey = workspaceEntry.name;
    const workspaceDir = path.join(paths.sessions, workspaceKey);
    for (const sessionEntry of await listDir(workspaceDir)) {
      if (!sessionEntry.isDirectory() && !sessionEntry.isSymbolicLink()) continue;
      const dir = path.join(workspaceDir, sessionEntry.name);
      const scanned = await scanTree(dir);
      sessions.push({
        id: sessionEntry.name,
        dir,
        workspaceKey,
        updatedAt: new Date(scanned?.mtimeMs ?? Date.now()).toISOString(),
        sizeBytes: scanned?.sizeBytes ?? null,
      });
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * 返回实例会话根目录（供 main 的 `openFolder` 使用）。
 * @param root 启动器根目录。
 * @param meta 实例元数据。
 * @returns 会话根目录绝对路径。
 */
export function sessionsDirOf(root: string, meta: InstanceMeta): string {
  return instancePaths(root, meta).sessions;
}
