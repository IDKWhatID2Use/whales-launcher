/**
 * 名称校验与目录名派生测试
 *
 * 校验规则必须与 dsh 源码一致（`resolveProfileDir` + CLI 的 desktop 拒绝），
 * 因此这里的用例逐条覆盖 dsh 规则边界。
 */
import assert from 'node:assert/strict';
import { loadCoreModule, run, test } from './_helpers.mjs';

const { names, core } = await loadCoreModule();
const { validateName, makeDirName, MAX_NAME_LENGTH } = names;

test('validateName：dsh 规则边界（非法）', () => {
  const invalid = ['', '   ', 'a/b', 'a\\b', '.', '..', 'node_modules', 'NODE_MODULES', 'desktop', 'Desktop', 'DESKTOP'];
  for (const name of invalid) {
    assert.notEqual(validateName(name), null, `应判为非法：${JSON.stringify(name)}`);
  }
});

test('validateName：合法名称', () => {
  const valid = ['main', '我的实例', 'My Instance 2', 'a.b-c_d', '实例-01', 'x'.repeat(MAX_NAME_LENGTH)];
  for (const name of valid) {
    assert.equal(validateName(name), null, `应判为合法：${JSON.stringify(name)}`);
  }
});

test('validateName：Windows 非法字符 / 保留名 / 超长', () => {
  for (const name of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'con', 'COM1', 'nul', 'x'.repeat(MAX_NAME_LENGTH + 1), 'trailing ', 'trailing.', 'a\u0001b']) {
    assert.notEqual(validateName(name), null, `应判为非法：${JSON.stringify(name)}`);
  }
});

test('validateName：非字符串输入', () => {
  assert.notEqual(validateName(undefined), null);
  assert.notEqual(validateName(42), null);
});

test('makeDirName：派生与字符净化', () => {
  assert.equal(makeDirName('我的实例', []), '我的实例');
  assert.equal(makeDirName('a/b:c*d', []), 'a_b_c_d');
  assert.equal(makeDirName('  空白  ', []), '空白');
  assert.equal(makeDirName('', []), 'instance');
  assert.equal(makeDirName('...', []), 'instance');
  assert.equal(makeDirName('node_modules', []), 'node_modules-instance');
  assert.equal(makeDirName('desktop', []), 'desktop-instance');
});

test('makeDirName：去重（大小写不敏感）', () => {
  assert.equal(makeDirName('mine', ['mine']), 'mine-2');
  assert.equal(makeDirName('mine', ['MINE', 'mine-2']), 'mine-3');
  assert.equal(makeDirName('mine', []), 'mine');
});

test('makeDirName：结果一定通过 validateName', () => {
  const inputs = ['我的 实例', 'a/b\\c', 'x'.repeat(100), 'node_modules', '....', '名字. ', 'CON', 'a:b|c?d*e'];
  for (const input of inputs) {
    const dirName = makeDirName(input, []);
    assert.equal(validateName(dirName), null, `派生结果必须合法：${input} → ${dirName}`);
    assert.ok(dirName.length <= MAX_NAME_LENGTH, `派生结果不能超长：${dirName}`);
  }
});

test('core 单例暴露契约中的名称方法', () => {
  assert.equal(typeof core.validateName, 'function');
  assert.equal(typeof core.makeDirName, 'function');
  assert.equal(core.validateName('node_modules') !== null, true);
  assert.equal(core.validateName('ok'), null);
});

await run();
