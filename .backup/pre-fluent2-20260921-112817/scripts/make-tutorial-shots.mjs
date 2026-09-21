#!/usr/bin/env node
/**
 * 生成使用教程截图 → docs/assets/tutorial/*.png
 *
 * 为什么这么做：教程里的界面图必须**可复现**，不能是一次性手工截屏 —— 界面一改动，
 * 手工图就会悄悄过期。这里用无头 Chromium（Chrome 优先，回退 Edge）+ CDP 驱动渲染层，
 * 按固定脚本浏览各路由、模拟少量交互（展开菜单、走完向导、开模态框），逐张截图。
 *
 * 依赖的前提：
 *   1. 已 `npm run build`（脚本消费 dist/renderer 的产物，不读 src）；
 *   2. 渲染产物在 `file://` 下可直接打开（IIFE，无 ESM/CORS 限制）；
 *   3. 无后端时渲染层自动进入**演示数据模式** —— 因此本脚本无需 Electron、无需真实实例，
 *      截出来的是覆盖全部状态的示例数据（运行中/已停止/已崩溃/目录缺失/引擎未安装/记录异常）。
 *      这也是教程截图的正确形态：可读、状态齐全、不泄漏任何本机真实数据。
 *
 * 用法：
 *   node scripts/make-tutorial-shots.mjs                 # 全量重生成
 *   node scripts/make-tutorial-shots.mjs --only wizard   # 只跑名字含 wizard 的场景
 *   node scripts/make-tutorial-shots.mjs --list          # 列出场景名
 *   node scripts/make-tutorial-shots.mjs --width 1600    # 换视口宽（默认 1440×900）
 *
 * 生成后请**抽查**图片（`read_image` 或直接看），再提交 docs/assets/tutorial/。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const RENDERER_DIR = process.env['WL_RENDERER_DIR']
  ? resolve(process.env['WL_RENDERER_DIR'])
  : join(ROOT, 'dist', 'renderer');
const OUT_DIR = join(ROOT, 'docs', 'assets', 'tutorial');
const PAGE_URL = `file:///${RENDERER_DIR.replace(/\\/g, '/')}/index.html`;
const PORT = Number(process.env['CDP_PORT'] ?? 9333);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const VIEW_W = Number(opt('width', 1440));
const VIEW_H = Number(opt('height', 900));

/** 浏览器候选：优先 Chrome，回退 Edge（都试不到就报错，不静默跳过）。 */
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击第一个文本匹配的元素（比类名稳，文案变了才需要改脚本）。 */
const clickByText = (text, sel = 'button') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((n) => (n.textContent ?? '').trim().includes(${JSON.stringify(text)}));
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'clicked:' + (el.textContent ?? '').trim().slice(0, 24);
})()`;

/** 点击 title/aria-label 匹配的元素。 */
const clickByLabel = (label, sel = '[title],[aria-label]') => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find((n) => (n.getAttribute('title') ?? n.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)});
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'clicked:' + ${JSON.stringify(label)};
})()`;

/** 在指定实例卡片内点击某个 title/aria-label 的按钮（卡片级操作必须先定位卡片）。 */
const clickInCard = (cardText, label) => `(() => {
  const card = [...document.querySelectorAll('.inst-card')]
    .find((c) => (c.textContent ?? '').includes(${JSON.stringify(cardText)}));
  if (!card) return 'NOT_FOUND_CARD';
  const el = [...card.querySelectorAll('[title],[aria-label]')]
    .find((n) => (n.getAttribute('title') ?? n.getAttribute('aria-label') ?? '') === ${JSON.stringify(label)});
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'clicked';
})()`;

/** 把某张实例卡片滚到视口中央（列表页很长，不滚动截图就只是顶部）。 */
const scrollToCard = (cardText) => `(() => {
  const card = [...document.querySelectorAll('.inst-card')]
    .find((c) => (c.textContent ?? '').includes(${JSON.stringify(cardText)}));
  if (!card) return 'NOT_FOUND';
  card.scrollIntoView({ block: 'center' });
  return 'scrolled';
})()`;

/**
 * 滚到主区底部（用于截取长页面的尾部区块，如「Node 运行时」「关于」）。
 * 不能写死 `#main`：实际滚动容器随布局档位变化，这里按「scrollHeight 明显大于
 * clientHeight」挑出最深的那个可滚动元素，挑不到才退回窗口滚动。
 */
const scrollToBottom = `(() => {
  const all = [document.scrollingElement, ...document.querySelectorAll('*')].filter(Boolean);
  const scrollable = all.filter((n) => n.scrollHeight > n.clientHeight + 40);
  if (scrollable.length === 0) { window.scrollTo(0, document.body.scrollHeight); return 'window'; }
  let best = scrollable[0];
  for (const n of scrollable) if (n.scrollHeight - n.clientHeight > best.scrollHeight - best.clientHeight) best = n;
  best.scrollTop = best.scrollHeight;
  return 'scrolled:' + (best.id || best.className || best.tagName) + '@' + best.scrollTop;
})()`;

/** 往输入框写值并触发 input 事件（渲染层用 'input' 事件做校验）。 */
const fillInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'NOT_FOUND';
  el.focus();
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'filled:' + el.value;
})()`;

/**
 * 场景清单。顺序即文档中的叙事顺序（安装 → 总览 → 创建 → 管理 → 运行 → 版本 → 设置）。
 * 每项：file 输出文件名、route 进入的 hash 路由、steps 进入后依次执行的交互、settle 截图前静置毫秒。
 */
const SCENARIOS = [
  // —— 总览与导航 ——
  { file: '01-instance-list.png', route: '#/instances', desc: '实例列表总览（6 张卡片覆盖 6 种状态）' },
  {
    file: '02-filter-needs-attention.png',
    route: '#/instances',
    desc: '筛选「需处理」',
    steps: [clickByText('需处理', '.segmented button, button')],
  },
  {
    file: '03-search.png',
    route: '#/instances',
    desc: '搜索框过滤实例',
    steps: [fillInput('input[aria-label="搜索实例"], input[placeholder*="搜索实例"]', '工作台')],
  },
  {
    file: '04-app-menu.png',
    route: '#/instances',
    desc: '展开标题栏「文件」菜单',
    steps: [clickByText('文件', '.titlebar__menubar button')],
  },
  {
    file: '05-card-more-menu.png',
    route: '#/instances',
    desc: '卡片「更多操作」菜单',
    steps: [clickByLabel('更多操作')],
  },
  {
    file: '06-log-drawer.png',
    route: '#/instances',
    desc: '右侧运行日志抽屉',
    steps: [clickInCard('我的工作台', '更多操作'), clickByText('查看运行日志', '[role="menuitem"], .menu__item, button')],
    settle: 1000,
  },

  // —— 创建实例向导（四步）——
  { file: '07-wizard-step1-name.png', route: '#/create', desc: '向导第 1 步：名称与外观' },
  {
    file: '08-wizard-step2-engine.png',
    route: '#/create',
    desc: '向导第 2 步：选择引擎版本',
    steps: [
      fillInput('input[placeholder^="例如"]', '我的工作台'),
      clickByText('下一步'),
    ],
    settle: 800,
  },
  {
    file: '09-wizard-step3-template.png',
    route: '#/create',
    desc: '向导第 3 步：选择 profile 模板',
    steps: [
      fillInput('input[placeholder^="例如"]', '我的工作台'),
      clickByText('下一步'),
      clickByText('下一步'),
    ],
    settle: 800,
  },
  {
    file: '10-wizard-step4-isolation.png',
    route: '#/create',
    desc: '向导第 4 步：隔离策略',
    steps: [
      fillInput('input[placeholder^="例如"]', '我的工作台'),
      clickByText('下一步'),
      clickByText('下一步'),
      clickByText('下一步'),
    ],
    settle: 800,
  },

  // —— 实例详情四页签 ——
  { file: '11-detail-plugins.png', route: '#/instance/ins-sdk/plugins', desc: '详情·插件页（含共享设置冲突横幅）', settle: 900 },
  { file: '12-detail-settings.png', route: '#/instance/ins-sdk/settings', desc: '详情·设置页', settle: 900 },
  { file: '13-detail-saves.png', route: '#/instance/ins-workbench/saves', desc: '详情·存档页', settle: 900 },
  { file: '14-detail-logs.png', route: '#/instance/ins-workbench/logs', desc: '详情·日志页', settle: 1200 },

  // —— 运行与异常状态 ——
  {
    file: '15-running-detail.png',
    route: '#/instance/ins-workbench/plugins',
    desc: '运行中实例详情（停止 / 打开界面 / 监听端口）',
    settle: 1000,
  },
  {
    file: '16-crashed-card.png',
    route: '#/instances',
    desc: '崩溃实例的错误横幅',
    steps: [scrollToCard('桌面预览')],
    settle: 900,
  },

  // —— 版本管理 / 全局设置 ——
  // 引擎页的「可安装版本」要走一次 npm 查询（演示后端也会模拟耗时），settle 必须够长，
  // 否则截到的是「正在读取 npm 版本列表…」的加载态而不是版本列表。
  { file: '17-engines.png', route: '#/engines', desc: '版本管理页', settle: 5000 },
  { file: '18-global-settings.png', route: '#/settings', desc: '全局设置页', settle: 1200 },
  {
    file: '23-node-runtime.png',
    route: '#/settings',
    desc: '全局设置·Node 运行时（页尾）',
    steps: [scrollToBottom],
    settle: 1200,
  },

  // —— 模态框 ——
  {
    file: '19-edit-instance.png',
    route: '#/instances',
    desc: '编辑实例信息模态',
    steps: [clickByLabel('更多操作'), clickByText('编辑实例信息', '[role="menuitem"], .menu__item, button')],
    settle: 800,
  },
  {
    file: '20-delete-confirm.png',
    route: '#/instances',
    desc: '删除实例二次确认',
    // 用「无人值守任务」（已停止）而非第一张卡片：运行中的实例删除项是禁用的，
    // 点它不会有任何反应，截出来只是一张展开了菜单的图。
    steps: [
      clickInCard('无人值守任务', '更多操作'),
      clickByText('删除实例', '[role="menuitem"], .menu__item, button'),
    ],
    settle: 900,
  },
  {
    file: '21-import-pack.png',
    route: '#/instances',
    desc: '从实例包导入',
    steps: [clickByText('从实例包导入')],
    settle: 1000,
  },
  {
    file: '22-empty-search.png',
    route: '#/instances',
    desc: '搜索无结果的空态',
    steps: [fillInput('input[aria-label="搜索实例"], input[placeholder*="搜索实例"]', '不存在的实例')],
    settle: 900,
  },
];

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  #ws;
  #seq = 0;
  #pending = new Map();

  static async attach(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((ok, bad) => {
            ws.addEventListener('open', ok, { once: true });
            ws.addEventListener('error', bad, { once: true });
          });
          const cdp = new Cdp();
          cdp.#ws = ws;
          ws.addEventListener('message', (e) => {
            let msg;
            try {
              msg = JSON.parse(e.data);
            } catch {
              return;
            }
            const slot = cdp.#pending.get(msg.id);
            if (slot) {
              cdp.#pending.delete(msg.id);
              slot(msg);
            }
          });
          return cdp;
        }
      } catch {
        // devtools 端点尚未就绪
      }
      await sleep(400);
    }
    throw new Error(`等待 CDP target 超时（port=${port}）`);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.#seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`${method} 超时`));
      }, timeoutMs);
      this.#pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error !== undefined) rej(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else res(msg.result);
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值并取回「按值」结果（容错：整页重载期间执行上下文会被销毁，此时视为"未就绪"）。 */
  async evaluate(expression) {
    try {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return r?.result?.value;
    } catch {
      return undefined;
    }
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // 忽略：进程退出时连接可能已被对端关闭
    }
  }
}

// ---------------------------------------------------------------- 主流程

/** 轮询等待页面进入可截图状态（整页重载期间求值会失败，故内部吞掉异常）。 */
async function waitReady(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cdp.evaluate(expression)) === true) return true;
    await sleep(150);
  }
  return false;
}

function pickBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge 可执行文件，无法截图');
}

async function main() {
  if (flag('list')) {
    for (const s of SCENARIOS) console.log(`${s.file.padEnd(34)} ${s.desc}`);
    return 0;
  }
  if (!existsSync(join(RENDERER_DIR, 'index.html'))) {
    throw new Error(`渲染产物不存在：${join(RENDERER_DIR, 'index.html')} —— 请先 npm run build`);
  }

  const only = opt('only', null);
  const scenarios = only ? SCENARIOS.filter((s) => s.file.includes(only) || s.desc.includes(only)) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`--only ${only} 没有匹配到任何场景（用 --list 查看）`);

  mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = join(ROOT, '.spike', 'tut-shot-profile');
  rmSync(profileDir, { recursive: true, force: true });

  const browser = pickBrowser();
  console.log(`[shot] 浏览器: ${browser}`);
  console.log(`[shot] 页面:   ${PAGE_URL}`);
  console.log(`[shot] 输出:   ${OUT_DIR}`);
  console.log(`[shot] 视口:   ${VIEW_W}×${VIEW_H}，共 ${scenarios.length} 张`);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${VIEW_W},${VIEW_H}`,
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=Translate,BackForwardCache',
      PAGE_URL,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  let failures = 0;
  try {
    const cdp = await Cdp.attach(PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW_W,
      height: VIEW_H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 首帧：等演示后端挂载完成
    await waitReady(cdp, 'document.readyState === "complete" && !!document.querySelector(".inst-card, .view")');

    let index = 0;
    for (const s of scenarios) {
      try {
        // 每张图都从「干净的应用状态」开始。做法是给 URL 挂一个每次不同的 query：
        //   - 只改 hash **不会**重载文档，本张图会继承上一张的界面状态（向导停在第 3 步之类）；
        //   - `Page.reload` 在 headless 下会让后续求值拿不到上下文（实测整张空白）；
        //   - query 变化则是一次真正的文档加载，hash 路由照常从零走一遍。
        // 另注：不要用 about:blank 中转 —— headless 下再回 file:// 会停在空白页。
        index += 1;
        await cdp.send('Page.navigate', { url: `${PAGE_URL}?shot=${index}${s.route}` });
        const ok = await waitReady(cdp, 'document.readyState === "complete" && !!document.querySelector(".view")');
        if (!ok) {
          const diag = await cdp.evaluate('document.readyState + " | " + location.href + " | bodyLen=" + document.body.innerHTML.length');
          console.warn(`[shot]   ! ${s.file} 页面未就绪：${String(diag)}`);
        }
        await sleep(s.settle ?? 700);

        for (const step of s.steps ?? []) {
          const out = await cdp.evaluate(step);
          if (typeof out === 'string' && out.startsWith('NOT_FOUND')) {
            console.warn(`[shot]   ! ${s.file} 交互未命中：${step.slice(0, 60)}…`);
          }
          await sleep(400);
        }
        if (s.steps?.length) await sleep(s.settle ?? 500);

        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const buf = Buffer.from(shot.data, 'base64');
        if (buf.length < 5000) throw new Error(`截图疑似空白（${buf.length} 字节）`);
        writeFileSync(join(OUT_DIR, s.file), buf);
        console.log(`[shot] ✓ ${s.file.padEnd(34)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB  ${s.desc}`);
      } catch (err) {
        failures++;
        console.error(`[shot] ✗ ${s.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    cdp.close();
  } finally {
    child.kill();
    await sleep(300);
    rmSync(profileDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`[shot] 完成，但有 ${failures} 张失败`);
    return 1;
  }
  console.log(`[shot] 全部 ${scenarios.length} 张完成 → ${OUT_DIR}`);
  return 0;
}

process.exitCode = await main();
