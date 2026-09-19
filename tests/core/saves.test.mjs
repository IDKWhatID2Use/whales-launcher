/**
 * 会话（存档）枚举测试
 *
 * 用真实的目录形态 `<sessions>/<projectKey>/<sessionId>/session.v3.jsonl.zstd`
 * （本机 `~/.dsh/sessions` 实测结构）构造用例，并验证共享 junction 下的可见性。
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanup, loadCoreModule, makeTempRoot, seedStubEngine, run, test } from './_helpers.mjs';

const { core, fsx, saves } = await loadCoreModule();
const { writeTextAtomic } = fsx;
const { NO_CWD_KEY } = saves;

/** 建一个带假引擎的临时根目录。 */
async function setup(t, label = 'saves') {
  const root = await makeTempRoot(label);
  t.after(() => cleanup(root));
  await seedStubEngine(root);
  return root;
}

/** 写入一个会话目录。 */
async function writeSession(sessionsDir, workspaceKey, sessionId, payload = 'session-data') {
  const dir = path.join(sessionsDir, workspaceKey, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), payload);
  return dir;
}

test('listSessions：枚举会话并给出 id / workspaceKey / 大小 / 更新时间', async (t) => {
  const root = await setup(t);
  const meta = await core.createInstance(root, { name: '存档实例', engineVersion: '9.9.9', template: 'web' });
  const sessionsDir = path.join(root, 'instances', meta.dirName, 'home', 'sessions');
  const key = core.workspaceKeyFor(path.join(root, 'instances', meta.dirName, 'workspace'));
  await writeSession(sessionsDir, key, 'aaaaaaaa-1111-4a43-b9df-b56f73bd0e18', 'x'.repeat(100));
  await writeSession(sessionsDir, key, 'session-bbbb', 'yyyy');
  await writeSession(sessionsDir, '--F-Other--', 'cccc');

  const sessions = await core.listSessions(root, meta);
  assert.equal(sessions.length, 3);
  const ids = sessions.map((item) => item.id).sort();
  assert.deepEqual(ids, ['aaaaaaaa-1111-4a43-b9df-b56f73bd0e18', 'cccc', 'session-bbbb'].sort());
  const mine = sessions.find((item) => item.id === 'session-bbbb');
  assert.equal(mine.workspaceKey, key);
  assert.equal(mine.sizeBytes, 4);
  assert.ok(mine.dir.startsWith(sessionsDir));
  assert.ok(!Number.isNaN(Date.parse(mine.updatedAt)));
  const other = sessions.find((item) => item.id === 'cccc');
  assert.equal(other.workspaceKey, '--F-Other--');
  // 其它 workspace 键下的会话同样可见（实例 home 里可能混有别的 cwd 产生的会话）
  assert.deepEqual(sessions, [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});

test('listSessions：空目录 / 缺失目录返回空数组，忽略散落文件', async (t) => {
  const root = await setup(t, 'saves-empty');
  const meta = await core.createInstance(root, { name: '空实例', engineVersion: '9.9.9', template: 'web' });
  assert.deepEqual(await core.listSessions(root, meta), []);
  const sessionsDir = path.join(root, 'instances', meta.dirName, 'home', 'sessions');
  await writeTextAtomic(path.join(sessionsDir, 'loose.txt'), 'not a session');
  await fs.mkdir(path.join(sessionsDir, '--F-Empty--'), { recursive: true });
  assert.deepEqual(await core.listSessions(root, meta), []);
});

test('listSessions：_no-cwd 目录也能被列出（dsh 的无 cwd 会话）', async (t) => {
  const root = await setup(t, 'saves-nocwd');
  const meta = await core.createInstance(root, { name: '无 cwd', engineVersion: '9.9.9', template: 'web' });
  const sessionsDir = path.join(root, 'instances', meta.dirName, 'home', 'sessions');
  await writeSession(sessionsDir, NO_CWD_KEY, 'no-cwd-session');
  const sessions = await core.listSessions(root, meta);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].workspaceKey, NO_CWD_KEY);
});

test('listSessions：共享模式（junction）下能看到共享库里的会话', async (t) => {
  const root = await setup(t, 'saves-shared');
  const meta = await core.createInstance(root, { name: '共享存档', engineVersion: '9.9.9', template: 'web', saves: 'shared' });
  const sharedSessions = path.join(root, 'shared', 'sessions');
  assert.equal(await core.isLink(path.join(root, 'instances', meta.dirName, 'home', 'sessions')), true);
  await writeSession(sharedSessions, '--F-WhalesLauncher--', 'shared-session', 'shared-data');
  const sessions = await core.listSessions(root, meta);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'shared-session');
  assert.equal(sessions[0].workspaceKey, '--F-WhalesLauncher--');
  assert.equal(sessions[0].sizeBytes, 'shared-data'.length);
});

test('两个实例共享存档：一个写入、另一个可见（存档互通）', async (t) => {
  const root = await setup(t, 'saves-interop');
  const alpha = await core.createInstance(root, { name: '甲', engineVersion: '9.9.9', template: 'web', saves: 'shared' });
  const beta = await core.createInstance(root, { name: '乙', engineVersion: '9.9.9', template: 'web', saves: 'shared' });
  const alphaSessions = path.join(root, 'instances', alpha.dirName, 'home', 'sessions');
  await writeSession(alphaSessions, '--F-Project--', 'from-alpha', 'alpha-data');
  const betaSessions = await core.listSessions(root, beta);
  assert.deepEqual(betaSessions.map((item) => item.id), ['from-alpha']);
  assert.equal(betaSessions[0].sizeBytes, 'alpha-data'.length);
});

test('core 单例暴露契约中的存档方法', async () => {
  assert.equal(typeof core.listSessions, 'function');
  assert.equal(typeof core.workspaceKeyFor, 'function');
});

await run();
