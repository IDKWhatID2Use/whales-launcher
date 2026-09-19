# 最终验收状态（Lead 汇总）

> 本文由 **Lead** 编写，用于补充 [`acceptance.md`](acceptance.md) 的时点差异。
> 独立审查员的原始结论**保持原样不动**（其独立性与可追溯性优先），本文只做状态对齐。
>
> | 文档 | 编写时点 | 说明 |
> |---|---|---|
> | [`code-review.md`](code-review.md) | 00:50:25 | QA 独立审查的**问题清单**（结论有效，缺陷状态见本文） |
> | [`acceptance.md`](acceptance.md) | 00:50:38 | QA 独立验收的**三态结论**；其 §11 结论为"不通过（6 项未闭环）" |
> | **本文** | 收尾时点 | 上述 6 项在 00:50 之后全部修复并复验转绿，此处给出闭环证据 |

---

## 1. 为什么 `acceptance.md` §11 的结论是"不通过"

QA 写结论时（00:50:38），清单里确实有 **6 项未闭环的 P2/P3**，其中 QR-16 是"唯一尚未被任何人认领的 P2"。**那一刻的结论是准确的。**

问题在于**时点**：这 6 项是在 QA 落笔**之后**才被派单修复的（派单依据正是 QA 自己的报告）。因此文档里的"不通过"已不代表当前状态，但**不代表 QA 审错了** —— 恰恰相反，它的报告正是这 6 项得以定位与闭环的原因。

---

## 2. 六项缺陷的闭环状态（含验证证据）

| 编号 | QA 报告时 | 当前状态 | 实现要点与证据 |
|---|---|---|---|
| **QR-16** | 未认领 P2 | ✅ 闭环 | 改为**按 id 去重** + 目录存在者胜出 + `problem` 标记（不动元数据）；复制场景另提示副本。QA `51-registry-review` → **15/15** |
| **QR-08** | P3（`dirSize` 1375ms） | ✅ 闭环 | `sizeBytes` 改**惰性 + mtime 签名缓存**：列表首次返回 `null` 不阻塞、后台单飞计算。`qr08-check.cjs` → **4/4** |
| **QR-09** | P3（日志发后不管） | ✅ 闭环 | `createLogWriter` 单写者循环 + 自动合并，**挂起写恒为 1**（天然背压）；退出前 `drain()` |
| **QR-10** | P3（日志无轮转） | ✅ 闭环 | `pruneOldLogs` 保留最近 10 个；启动前先腾位再写，总量 ≤ 10 |
| **QR-12** | P3（可切未安装引擎） | ✅ 闭环 | 硬拒绝并保留原值，与 `createInstance` 同口径 → `engineInstalled` 恒真成为可测不变量 |
| **QR-13** | P3（共享数据残留） | ✅ 闭环（**方案被 QA 用例推翻后重做**） | 原方案"归属可确认就自动清理"被 QA 的 `10-data-safety` **D1** 转 FAIL 推翻 → 改为**只报告 + 显式清理入口**（`removeOrphanSharedWorkspace` 仅允许清理无人认领、且路径必须落在 `shared/workspaces/` 内）；`shared/sessions` 永不触碰 |

**另有两项 QA 未报、由团队自查或交叉审查发现并闭环：**

| 编号 | 来源 | 状态 |
|---|---|---|
| **QR-05** 缓存根可能落到 `process.cwd()` | QA 报告 | ✅ 闭环：契约补 `root?` → main 显式传 `launcherRoot()` → core 去掉 `cwd` 兜底（改 `$WHALES_LAUNCHER_ROOT` → 最近使用的 root → 临时目录） |
| **QR-11** 正式包 DevTools 恒开 | QA 报告 | ✅ 闭环：生产默认关闭；`WHALES_DEV` / `WHALES_DEVTOOLS` 两档；F12 / Ctrl+Shift+I / 菜单项**三处同源**，关闭时空动作不抛错、菜单项如实置灰 |
| **QR-15** 冲突模型未被 UI 消费 | QA 报告 | ✅ 闭环：契约加两条通道 → main handler + preload 暴露 → UI InfoBar / 卡片徽标 / 启动提示；解决动作显式且覆盖前备份 |
| **`workspace` 隔离维度缺失** | core-engineer 自查发现 | ✅ 闭环：契约补 `workspace?: ShareMode` → core 透传 → UI 向导 + 详情页 + 独立 `isolation.ts` 样板 |

---

## 3. 修复过程中"被检查本身误导"的四次记录

这一轮出现过四次**验证工具自身不可靠**的情况。它们全部被当事成员主动发现并如实报告，是本项目最值得记录的过程证据：

| # | 谁 | 现象 | 后果与处置 |
|---|---|---|---|
| 1 | shell-engineer | `verify-dist.cjs` 首版**同步断言建窗**，而 `require` 只跑到"注册 whenReady 回调" | 误报 4 项失败；已改为等 500ms 后断言，并把坑写进脚本头 |
| 2 | shell-engineer | `qr08-check.cjs` 假引擎夹具只放 `package.json`（core 判定"已安装"还需 `lib/bin.js`），且断言漏写 message | 报错只有 `false !== true`；已修夹具 + 全断言补 message |
| 3 | ui-engineer | `real-mode.mjs` 的 `check(name, predicate)` **不调用函数型断言** → 函数对象恒为真 | **12 条断言永远通过**（假绿）；修正后断言数 20 → 28，并明确声明"旧的 20/20 含金量低于当时汇报水平" |
| 4 | ui-engineer | `run.mjs` 用 `q('.card__body')` 取**第一张卡**，新增卡片后取错 | 曾被我误判为"中间态"；实为断言脆弱，已改为按标题定位 |

**共性结论**：它们的破坏方式各不相同，但都属于同一类 —— **检查覆盖不到的地方，结论就不该说满**。

---

## 4. QA 未覆盖、由 Lead 实机验收发现并修复的两项

QA 已诚实声明"界面美观度不在代码审查能力范围内（NV-02）"。Lead 用 CDP 直接抓取渲染器位图（`Page.captureScreenshot`，绕开 `PrintWindow` 对分层/GPU 合成窗口的抓取缺陷）后发现两个真实缺陷：

| # | 缺陷 | 根因 | 处置 |
|---|---|---|---|
| 1 | **版本管理页无限加载** | `Promise.all([engine.list(), engine.available()])` 被慢的 `npm view` 拖住，**且无超时** → 快的本地列表也永远停在加载态；失败时静默 | 两段各自加载/各自状态；本地 12s、npm 30s 超时；失败在对应分区显示错误 + 重试；同类隐患（创建向导步骤 2）一并修；`sizeBytes: 0` 改显示「未知」 |
| 2 | **标题栏两个按钮文字叠印** | `iconButton()` 把 `label` 透传给 `button()` → 28px 图标盒里渲染出 91px 宽文字并溢出；标题栏那枚还压根没走 `iconButton` | 修正 `iconButton`（label 只进 `aria-label`/`title`）+ CSS 兜底；标题栏窄屏收纳为 1 个纯图标动作，主题切换下沉到左栏；修好**全应用**图标按钮 |

另在验收中排除了一处**误判**：早期用 `PrintWindow` 抓到的"菜单浮层透明、底层文字可辨"实为**抓取缺陷**，改用 CDP 后确认浮层是实心不透明；但据此加的 `backdrop-filter` + 入场动画起始不透明度 0.72 予以保留（本身是 Fluent 正确做法）。

---

## 5. 最终门禁（收尾时点实测）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | **exit 0**（全项目零类型错误） |
| `npm test` | **128 passed / 0 failed / 1 skipped**（13 文件，exit 0） |
| `npm run build` | **exit 0**（含构建前 `tsc` 门禁 + `dist.tmp` 原子替换） |
| QA 独立脚本 | `00-smoke` / `10-data-safety` 13/13 / `51-registry-review` 15/15 / `40-core-deep` 16/16 / `30-robustness` 35/35 / `31-stop-probe` / `11-repro` — **全部 exit 0** |
| 产物加载验证 | `node tests/dist/verify-dist.cjs` → **12/12**；`node tests/dist/qr08-check.cjs` → **4/4** |
| 渲染层冒烟 | `node .spike/smoke/run.mjs` → **exit 0**（155 项）；`node .spike/smoke/real-mode.mjs` → **exit 0**（28 项） |
| 构建产物 | `dist/main/index.cjs` 368.0 KB · `dist/preload/index.cjs` 4.2 KB · `dist/renderer/index.js` 309.0 KB |

---

## 6. 仍然"无法验证"的项（继承 QA 的诚实声明）

这三项**不是缺陷，而是本会话沙箱关掉了观测窗口**，合并为一批交给用户在普通桌面环境验证：

| 编号 | 项 | 为什么无法在本环境验证 |
|---|---|---|
| NV-01 | 进程树真杀、孤儿进程防护 | 本沙箱 `taskkill /PID x /T /F` **恒返回 Access denied**；且实测发现本沙箱对进程树有 **job object 级自动包容**（孙进程随父正常退出也消失）→ 现象本身不可观测 |
| NV-02 | 界面美观度、Mica 观感、窗口交互（拖拽/双击最大化/Snap Layouts） | CDP 只能取渲染器位图，取不到 DWM 合成的 Mica；真实窗口交互需真实桌面 |
| NV-03 | 真实 dsh 完整链路（登录、调模型、多插件共存） | 受"不得触碰真实 `~/.dsh`"边界约束，只用 stub 引擎 + 真实 dsh 的 `--dump-config`（非交互、不调模型）校验 |

**给用户的一键验证命令**：
```powershell
cd F:\WhalesLauncher
npm run build
node tests/dist/verify-dist.cjs      # 产物可加载 + 窗口参数 + 通道注册 + HTML 引用一致 + 静态资源 SHA256 对账
npx electron .                    # 真实窗口（需普通桌面环境）
node tests/core/degraded-records.test.mjs   # 真环境下才具区分力的 tree-kill 校验
```

---

## 7. 结论

- **无 P0**；QA 报告的全部 P2/P3 已闭环并有可执行证据；
- 两个**真实数据安全问题**（设置被静默覆盖、异常实例凭空消失）已修复且双向验证；
- 数据安全红线（`removeLink` / 共享切换 / 删除实例不穿透 junction 误删）经独立构造用例验证**未发现可穿透路径**；
- 渲染层无可被外部数据触发的 XSS；
- 交付链路具备**三道自保**：构建前类型门禁、`dist.tmp` 原子替换、产物加载验证。

---

## 8. 补充轮：直接启动方式（用户验收反馈「缺失直接启动方式（exe/bat 等）」）

用户在验收时指出：**此前只能靠 `npx electron .` 或 `npm start` 启动** —— 应用能跑，
缺的是「双击就能用」的入口。本轮补齐，并把踩到的坑一并记录。

### 交付物

| 文件 | 作用 |
|---|---|
| [`启动 WhalesLauncher.bat`](../../启动%20WhalesLauncher.bat) | 双击即用；产物过期自动重建；失败时窗口保留并给出原因 |
| [`WhalesLauncher.vbs`](../../WhalesLauncher.vbs) | 无控制台静默启动（快捷方式指向它）；失败弹窗指向日志 |
| [`创建桌面快捷方式.bat`](../../创建桌面快捷方式.bat) | 桌面 + 开始菜单各建一个快捷方式 |
| [`scripts/launch.mjs`](../../scripts/launch.mjs) | 三个入口**共用**的实现：环境自检 / 按需构建 / 启动 / 诊断 |
| [`scripts/make-icon.mjs`](../../scripts/make-icon.mjs) + `assets/whales.ico` | 零依赖程序化生成的多尺寸应用图标 |
| [`scripts/make-shortcut.ps1`](../../scripts/make-shortcut.ps1) | 建快捷方式（COM），失败回落到项目内 `快捷方式\` |
| `package.json` | 新增 `launch` / `icon` / `shortcut`；`start` 改为走 launch.mjs |

### 实测证据（不是"应该能用"）

| 项 | 证据 |
|---|---|
| `.bat` 真启动 | 在带虚拟终端的会话中运行：Electron 起 **4 个进程**、窗口标题 `WhalesLauncher —— dsh 实例与版本管理`、退出码 0 |
| `.vbs` 静默路径 | `wscript.exe` 退出码 0；再次启动时正确识别单实例并切前台 |
| 按需构建判定 | 6 个用例逐一实测：最新→跳过、源码更新→构建、`--rebuild`→强制、产物缺失→自动构建、`--skip-build` 缺产物→exit 1 且提示 |
| 日志轮转 | 快捷方式路径连跑 3 次：`history\` 每次新增一份，旧的按 5 份上限清理 |
| 快捷方式回落 | 沙箱拒绝写桌面/开始菜单时回落到 `快捷方式\WhalesLauncher.lnk`，链接四项属性（Target/Args/Icon/WorkDir）逐个校验存在 |
| 图标接线 | `verify-dist.cjs` 新增断言；**反向验证**：临时隐藏 `assets/whales.ico` → 断言失败，恢复 → 全绿 |

### 本轮抓到的 5 个真实缺陷（均由实测暴露，不是推测）

| # | 缺陷 | 根因 | 处置 |
|---|---|---|---|
| 1 | 按需构建**永不生效**，每次启动都白跑一次构建 | 用四个产物的 **min** mtime 当"构建时刻"，而 `dist/renderer/index.html` 是 `cp` 复制来的、mtime 停在源码时间（比构建早 1 小时） | 改用 **max** mtime + 2 秒容差 |
| 2 | `.bat` 里的中文把批处理撕成乱码命令 | cmd 按**活动代码页**读批处理，文件内的 `chcp 65001` **不会**让它重读后面的字节；UTF-8 中文解出的字节里含引号与反斜杠，直接把命令切断 | 两个 `.bat` 与 `.vbs` 一律**纯 ASCII**，中文全部由 Node 层输出 |
| 3 | `.ps1` 里普通的中文注释导致**语法错误** | PowerShell 5.1 把**无 BOM** 的文件按 ANSI 读，注释里的 UTF-8 字节解出引号，把 `if/else` 拆坏 | `make-shortcut.ps1` 改为纯 ASCII（中文目录名由**码点**拼出） |
| 4 | 快捷方式总建在 `scripts\` 下 | `-File` 传**相对路径**时，PowerShell 以启动目录解析脚本位置，`$PSCommandPath` 随之出错 | bat 传**绝对路径**（`%~dp0`），脚本用 `$PSCommandPath` 兜底 |
| 5 | 日志轮转"在跑，但保存下来的全是空文件" | VBS 里 `--log=X > X 2>&1`：cmd 在 node 启动**前**就清空并占住 X，轮转把这**刚被清空的空文件**当成上一份归档，真正的失败现场随后被覆盖 | 重定向改到**另一个**文件；固定日志由 launch.mjs 独占写入 |

### 两条"设计上的诚实说明"

1. **工具沙箱里拉不起 Electron 不是应用缺陷**：本轮首次探测就撞上 `mojo ... 拒绝访问`，
   但**同一条命令在虚拟终端里成功** —— 差异来自沙箱禁止命名管道，而不是代码。因此
   `.bat` 的真启动证据取自虚拟终端，并在 README 里写清这个观测边界。
2. **没有单文件 `.exe`**：把 `.bat` 编译成 exe 只是把脚本藏起来，照样要 `node` 与
   `node_modules/electron`；真分发要 electron-builder 之类把约 200 MB 运行时打进安装包，
   而本机连不上 github.com（依赖下不来），且本项目定位是**开发环境运行**。README
   里明确写"为什么不提供 exe"，而不是假装不需要。

> 共性结论与 §3 一致：**检查覆盖不到的地方，结论就不该说满。**
> 上面 5 个缺陷里有 4 个表面都"在工作"（构建每次都成功、日志每次都有文件、
> 快捷方式每次都有输出），只有真去比对**内容与位置**才暴露出来。
