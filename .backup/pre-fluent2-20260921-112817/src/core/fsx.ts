/**
 * WhalesLauncher core —— 文件系统工具层
 *
 * 本模块只依赖 Node 内置模块，所有写操作都走「临时文件 + rename」的原子写。
 *
 * Windows 链接能力（本机实测结论，决定了共享策略的实现方式）：
 *  - `fs.symlink(target, link, 'junction')`      → 可用（无需管理员）
 *  - `fs.symlink(target, link, 'file' | 'dir')`  → **EPERM**（无管理员 / 未开开发者模式）
 *  - 指向文件的 junction 能创建但**不可访问**（读取报 ENOENT），因此单文件共享不能靠链接
 *  - `fs.rm(dir, { recursive: true })` 不会跟随 junction（已实测：链接目标内容完好）
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 原子写临时文件的后缀计数器，避免同名临时文件互相覆盖。 */
let tempSeq = 0;

/**
 * 确保目录存在（递归创建）。
 * @param dir 目标目录绝对路径。
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * 判断路径是否存在。
 *
 * 基于 `lstat`：链接本身存在即算存在（即使目标已被删除）。
 * @param p 目标路径。
 * @returns 是否存在。
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断路径是否为 junction / 符号链接。
 * @param p 目标路径。
 * @returns 是否为链接。
 */
export async function isLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 读取目录项（缺失时返回空数组）。
 * @param dir 目标目录。
 * @returns 目录项数组。
 */
export async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 读取 JSON 文件。
 *
 * 文件不存在返回 `null`；文件存在但内容不是合法 JSON 时**抛出**（避免把损坏数据
 * 静默当成"不存在"，那会让用户以为实例凭空消失）。
 * @param file JSON 文件路径。
 * @returns 解析结果或 `null`。
 */
export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(stripBom(raw)) as T;
  } catch (error) {
    throw new Error(`JSON 解析失败：${file} —— ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 原子写入 JSON（2 空格缩进 + 末尾换行，与 dsh 的 package.json 风格一致）。
 * @param file 目标文件路径。
 * @param value 待序列化的值。
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 读取文本文件（UTF-8，自动去掉 BOM）。
 * @param file 目标文件路径。
 * @returns 文本内容；文件不存在返回 `null`。
 */
export async function readText(file: string): Promise<string | null> {
  try {
    return stripBom(await readFile(file, 'utf8'));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * 原子写入文本文件。
 *
 * 实现：先在同目录写临时文件，再 `rename` 覆盖目标。同目录保证 rename 是同一卷上的
 * 原子替换；若目标本身是指向别处的链接，则解析真实路径后就地替换，**不会把链接变成普通文件**。
 * @param file 目标文件路径。
 * @param text 文本内容。
 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await writeFileAtomicRaw(file, Buffer.from(text, 'utf8'));
}

/**
 * 原子写入二进制内容（供凭证复制等场景使用）。
 * @param file 目标文件路径。
 * @param data 内容缓冲区。
 */
export async function writeFileAtomicRaw(file: string, data: Buffer): Promise<void> {
  const target = await resolveWriteTarget(file);
  const dir = path.dirname(target);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${tempSeq++}`);
  try {
    await writeFile(temp, data);
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 原子替换的重试节奏（Windows 上 `rename` 可能被瞬时占用或扫描打断）。 */
const RENAME_DELAYS = [0, 50, 150, 400, 900];

/**
 * 原子替换，遇"瞬时占用"退避重试；其它错误立刻抛出。
 *
 * Windows 上目标文件被扫描/短暂持有时 `rename` 会返回 EPERM/EBUSY/EACCES。
 * 实测：8 个实例并发启动（8 路各拉起一个 dsh 进程）时，磁盘压力最大的那一刻
 * `markLaunched` 的替换会被拒 —— 同一个工作区里单纯的 8 路并发 rename 却 320/320 成功，
 * 说明这是压力相关的瞬时失败而非权限问题。`removeDir` 早就有同样的退避，这里补齐一致性。
 *
 * 只重试瞬时占用类错误，其余错误立刻上抛，绝不用重试掩盖真实失败。
 * @param from 临时文件路径。
 * @param to 目标文件路径。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let index = 0; index < RENAME_DELAYS.length; index += 1) {
    const delay = RENAME_DELAYS[index] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isBusy(error) || index === RENAME_DELAYS.length - 1) throw error;
    }
  }
}

/**
 * 复制文件（原子写，缺失源文件返回 false）。
 * @param from 源文件路径。
 * @param to 目标文件路径。
 * @returns 是否复制了文件。
 */
export async function copyFileAtomic(from: string, to: string): Promise<boolean> {
  try {
    const data = await readFile(from);
    await writeFileAtomicRaw(to, data);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * 递归删除目录（不跟随链接；`fs.rm` 对 junction 只删除链接本身，已实测验证）。
 *
 * Windows 上文件/目录可能被进程短暂占用（EBUSY/EPERM，例如刚被终止的实例进程
 * 仍把工作目录当作 CWD），因此这里做有限次退避重试。
 * @param dir 目标目录。
 */
export async function removeDir(dir: string): Promise<void> {
  const delays = [0, 120, 300, 700, 1500];
  for (let index = 0; index < delays.length; index += 1) {
    const delay = delays[index] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      if (!isBusy(error) || index === delays.length - 1) throw error;
    }
  }
}

/**
 * 若路径是链接则移除，返回是否真的移除了。
 *
 * **安全保证**：先 `lstat` 确认是链接；真实目录/文件一律不动，直接返回 `false`。
 * @param link 待解除的链接路径。
 * @returns 是否移除了链接。
 */
export async function removeLink(link: string): Promise<boolean> {
  let info: import('node:fs').Stats;
  try {
    info = await lstat(link);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (!info.isSymbolicLink()) return false;
  try {
    await unlink(link);
  } catch {
    // 极少数情况下 junction 需要 rmdir 语义才能删除
    await rm(link, { recursive: false, force: true });
  }
  return true;
}

/**
 * 把 `link` 替换为指向 `target` 的 junction（幂等）。
 *
 * **绝不删除真实目录**：若 `link` 已存在且不是链接，抛出错误，由调用方决定如何迁移。
 * @param link 链接路径。
 * @param target 目标目录（不存在会自动创建）。
 */
export async function replaceWithJunction(link: string, target: string): Promise<void> {
  await ensureDir(target);
  if (await isLink(link)) {
    await removeLink(link);
  } else if (await pathExists(link)) {
    throw new Error(`拒绝覆盖：${link} 已存在且不是链接（为避免删除真实数据，请先手动迁移或改用 local 模式）`);
  }
  await ensureDir(path.dirname(link));
  await symlink(target, link, 'junction');
}

/**
 * 确保目录存在且是**真实目录**（若当前是链接，先安全解除链接再建目录）。
 * @param dir 目录路径。
 */
export async function ensureRealDir(dir: string): Promise<void> {
  if (await isLink(dir)) await removeLink(dir);
  await ensureDir(dir);
}

/**
 * 递归计算目录大小。
 *
 * 不跟随链接/junction（只统计链接本身），失败返回 `null`。
 * @param dir 目标目录。
 * @returns 字节数或 `null`。
 */
export async function dirSize(dir: string): Promise<number | null> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = await dirSize(full);
        if (nested === null) continue;
        total += nested;
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * 取路径的最近修改时间（毫秒时间戳）。
 * @param p 目标路径。
 * @returns 时间戳；不存在返回 `null`。
 */
export async function mtimeMs(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 列出目录下所有文件（递归，不跟随链接）的最近修改时间与总大小。
 *
 * 用于会话目录统计：会话目录通常只有 1 个 `.jsonl.zstd` 文件。
 * @param dir 目标目录。
 * @returns 最近修改时间与字节数。
 */
export async function scanTree(dir: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let latest = 0;
    let size = 0;
    let seen = false;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = await scanTree(full);
        if (nested === null) continue;
        seen = true;
        latest = Math.max(latest, nested.mtimeMs);
        size += nested.sizeBytes;
      } else if (entry.isFile()) {
        const info = await stat(full);
        seen = true;
        latest = Math.max(latest, info.mtimeMs);
        size += info.size;
      }
    }
    if (!seen) {
      const info = await stat(dir);
      latest = info.mtimeMs;
    }
    return { mtimeMs: latest, sizeBytes: size };
  } catch {
    return null;
  }
}

/**
 * 把 `from` 目录下的条目合并进 `to`（同名条目跳过，不覆盖已有数据）。
 *
 * 用于「本地 → 共享」切换：先把本地已有存档/工作区并入共享库，成功清空后再建 junction。
 * @param from 源目录。
 * @param to 目标目录。
 * @returns 已迁移条目数与因同名冲突被跳过的条目名。
 */
export async function mergeDirInto(from: string, to: string): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];
  if (!(await pathExists(from))) return { moved, skipped };
  if (await isLink(from)) return { moved, skipped };
  await ensureDir(to);
  for (const entry of await listDir(from)) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (await pathExists(destination)) {
      skipped.push(entry.name);
      continue;
    }
    await rename(source, destination);
    moved.push(entry.name);
  }
  return { moved, skipped };
}

/**
 * 解析写入目标：若目标是链接，返回其真实路径，保证原子写替换的是真实文件而不是链接本身。
 * @param file 目标文件路径。
 * @returns 应当写入的真实路径。
 */
export async function resolveWriteTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

/** 去掉字符串开头的 BOM。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 判断错误是否为「不存在」。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/** 判断错误是否为「被占用/无权限」（Windows 上删除正在使用的文件）。 */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}
