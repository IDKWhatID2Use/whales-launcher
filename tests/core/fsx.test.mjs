/**
 * 文件工具测试：原子写、junction 替换、**安全解除链接**、目录大小。
 *
 * 安全用例是本文件的重点：`replaceWithJunction` 与 `removeLink` 绝不能删除真实目录。
 * 另有一条"递归删除不跟随 junction"的验证（共享数据不能被误删）。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, run, test } from './_helpers.mjs';

const { fsx, core } = await loadCoreModule();
const { ensureDir, pathExists, readJson, writeJsonAtomic, readText, writeTextAtomic, isLink, replaceWithJunction, removeLink, dirSize, mergeDirInto, listDir: listDirEntries } = fsx;

/** 建一个临时工作区。 */
async function workspace(t) {
  const dir = await makeTempRoot('fsx');
  t.after(() => cleanup(dir));
  return dir;
}

test('writeTextAtomic / readText：原子写且不留临时文件', async (t) => {
  const dir = await workspace(t);
  const file = path.join(dir, 'nested', 'a.txt');
  await writeTextAtomic(file, '你好');
  assert.equal(await readText(file), '你好');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['a.txt']);
  await writeTextAtomic(file, 'BOM');
  assert.equal(await readText(file), 'BOM');
});

test('writeTextAtomic：写到链接目标是替换真实文件而不是替换链接', async (t) => {
  const dir = await workspace(t);
  const targetDir = path.join(dir, 'target');
  await ensureDir(targetDir);
  await writeTextAtomic(path.join(targetDir, 'real.txt'), '原内容');
  const link = path.join(dir, 'link');
  await replaceWithJunction(link, targetDir);
  await writeTextAtomic(path.join(link, 'real.txt'), '改过');
  assert.equal(await readText(path.join(targetDir, 'real.txt')), '改过');
  assert.equal(await isLink(link), true, '链接本身必须还在');
});

test('readJson：缺失返回 null，损坏抛错，往返一致', async (t) => {
  const dir = await workspace(t);
  assert.equal(await readJson(path.join(dir, 'missing.json')), null);
  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, '{ not json');
  await assert.rejects(() => readJson(broken), /JSON 解析失败/);
  const good = path.join(dir, 'good.json');
  await writeJsonAtomic(good, { a: 1, b: '中文' });
  assert.deepEqual(await readJson(good), { a: 1, b: '中文' });
  const raw = await fs.readFile(good, 'utf8');
  assert.ok(raw.endsWith('\n'), 'JSON 应以换行结尾（与 dsh 一致）');
});

test('isLink：junction 为 true，真实目录/文件为 false', async (t) => {
  const dir = await workspace(t);
  const target = path.join(dir, 'target');
  await ensureDir(target);
  await writeTextAtomic(path.join(dir, 'plain.txt'), 'x');
  const link = path.join(dir, 'link');
  await replaceWithJunction(link, target);
  assert.equal(await isLink(link), true);
  assert.equal(await isLink(target), false);
  assert.equal(await isLink(path.join(dir, 'plain.txt')), false);
  assert.equal(await isLink(path.join(dir, 'nope')), false);
});

test('replaceWithJunction：创建、幂等替换、目标自动创建', async (t) => {
  const dir = await workspace(t);
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  const link = path.join(dir, 'link');
  await writeTextAtomic(path.join(first, 'f.txt'), '1');
  await writeTextAtomic(path.join(second, 'f.txt'), '2');
  await replaceWithJunction(link, first);
  assert.equal(await readText(path.join(link, 'f.txt')), '1');
  await replaceWithJunction(link, second);
  assert.equal(await readText(path.join(link, 'f.txt')), '2', '重复调用应指向新目标');
  assert.equal(await isLink(link), true);
});

test('replaceWithJunction：绝不删除真实目录（必须抛错且数据完好）', async (t) => {
  const dir = await workspace(t);
  const real = path.join(dir, 'real');
  await writeTextAtomic(path.join(real, 'precious.txt'), '别删我');
  const target = path.join(dir, 'target');
  await ensureDir(target);
  await assert.rejects(() => replaceWithJunction(real, target), /拒绝覆盖/);
  assert.equal(await readText(path.join(real, 'precious.txt')), '别删我');
  assert.equal(await isLink(real), false);
});

test('removeLink：只解除链接，真实目录/文件一律不动', async (t) => {
  const dir = await workspace(t);
  const target = path.join(dir, 'target');
  await writeTextAtomic(path.join(target, 'keep.txt'), 'keep');
  const link = path.join(dir, 'link');
  await replaceWithJunction(link, target);
  assert.equal(await removeLink(link), true);
  assert.equal(await pathExists(link), false);
  assert.equal(await readText(path.join(target, 'keep.txt')), 'keep', '链接目标必须完好');
  const real = path.join(dir, 'real');
  await writeTextAtomic(path.join(real, 'keep.txt'), 'keep');
  assert.equal(await removeLink(real), false, '真实目录不是链接');
  assert.equal(await readText(path.join(real, 'keep.txt')), 'keep');
  assert.equal(await removeLink(path.join(dir, 'missing')), false);
});

test('dirSize：统计真实文件，不跟随 junction，缺失返回 null', async (t) => {
  const dir = await workspace(t);
  assert.equal(await dirSize(path.join(dir, 'missing')), null);
  const root = path.join(dir, 'root');
  await ensureDir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'a.bin'), Buffer.alloc(100));
  await fs.writeFile(path.join(root, 'sub', 'b.bin'), Buffer.alloc(50));
  assert.equal(await dirSize(root), 150);
  const big = path.join(dir, 'big');
  await ensureDir(big);
  await fs.writeFile(path.join(big, 'huge.bin'), Buffer.alloc(4096));
  await replaceWithJunction(path.join(root, 'linked'), big);
  assert.equal(await dirSize(root), 150, 'junction 目标不应计入');
});

test('mergeDirInto：迁移非冲突条目并报告冲突', async (t) => {
  const dir = await workspace(t);
  const from = path.join(dir, 'from');
  const to = path.join(dir, 'to');
  await writeTextAtomic(path.join(from, 'a.txt'), 'a');
  await writeTextAtomic(path.join(from, 'b.txt'), 'b');
  await writeTextAtomic(path.join(to, 'a.txt'), '已有');
  const result = await mergeDirInto(from, to);
  assert.deepEqual(result.moved, ['b.txt']);
  assert.deepEqual(result.skipped, ['a.txt']);
  assert.equal(await readText(path.join(to, 'a.txt')), '已有');
  assert.equal(await readText(path.join(to, 'b.txt')), 'b');
  assert.deepEqual((await listDirEntries(from)).map((entry) => entry.name), ['a.txt']);
});

test('fs.rm 不跟随 junction：删除含 junction 的父目录不会伤到目标（共享数据安全）', async (t) => {
  const dir = await workspace(t);
  const victim = path.join(dir, 'victim');
  await writeTextAtomic(path.join(victim, 'inner', 'precious.txt'), '共享存档');
  const host = path.join(dir, 'host');
  await ensureDir(path.join(host, 'node_modules', '@deepseek-ai'));
  await replaceWithJunction(path.join(host, 'node_modules', '@deepseek-ai', 'dsh'), victim);
  assert.equal(await readText(path.join(host, 'node_modules', '@deepseek-ai', 'dsh', 'inner', 'precious.txt')), '共享存档');
  await fs.rm(host, { recursive: true, force: true });
  assert.equal(await pathExists(host), false);
  assert.equal(await readText(path.join(victim, 'inner', 'precious.txt')), '共享存档', 'junction 目标必须完好');
});

test('core 单例暴露契约中的文件工具', async () => {
  for (const name of ['ensureDir', 'pathExists', 'readJson', 'writeJsonAtomic', 'readText', 'writeTextAtomic', 'isLink', 'replaceWithJunction', 'removeLink', 'dirSize']) {
    assert.equal(typeof core[name], 'function', `core.${name} 应为函数`);
  }
});

await run();
