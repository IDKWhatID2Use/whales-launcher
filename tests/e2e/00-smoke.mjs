/**
 * QA 冒烟自检：确认测试基础设施本身可用（打包 core → 加载 → 契约形状）。
 * 运行：node tests/e2e/00-smoke.mjs
 */
import assert from 'node:assert/strict';
import { loadCoreBundle, REPO_ROOT } from './_bundle.mjs';

const mod = await loadCoreBundle();
const { core } = mod;

console.log('[smoke] 仓库根：', REPO_ROOT);
console.log('[smoke] core 导出键数：', Object.keys(core).length);

// CoreApi 契约方法清单（逐条来自 src/shared/contracts.ts 的 CoreApi 接口）
const CONTRACT_METHODS = [
  'ensureDir', 'pathExists', 'readJson', 'writeJsonAtomic', 'readText', 'writeTextAtomic',
  'isLink', 'replaceWithJunction', 'removeLink', 'dirSize',
  'corePaths', 'instancePaths',
  'validateName', 'makeDirName',
  'listInstances', 'createInstance', 'readInstance', 'updateInstance', 'deleteInstance', 'applyShareModes',
  'listEngines', 'listAvailableEngines', 'installEngine', 'removeEngine', 'resolveEngineBin',
  'readProfileInventory', 'readInstanceSettings', 'writeInstanceSettings', 'setBundleEnabled',
  'pluginAdd', 'pluginRemove',
  'launchInstance', 'stopInstance', 'runtimeOf', 'listRuntimes',
  'listSessions', 'workspaceKeyFor',
  'exportPack', 'importPack',
];

const missing = CONTRACT_METHODS.filter((name) => typeof core[name] !== 'function');
const extra = Object.keys(core).filter((name) => !CONTRACT_METHODS.includes(name));

console.log('[smoke] 契约方法缺失：', missing.length === 0 ? '无' : missing.join(', '));
console.log('[smoke] 额外导出（非契约）：', extra.length === 0 ? '无' : extra.join(', '));

assert.equal(missing.length, 0, `core 缺少契约方法：${missing.join(', ')}`);

// 契约里 CoreApi 的键总数（含方法）应完全落在实现上
console.log('[smoke] OK —— core 实现覆盖 CoreApi 全部方法');
