# 01 · 安装与首次启动

> 目标：把 WhalesLauncher 装到本机，并且**第一次就能双击启动成功**。
> 预计耗时 10–20 分钟（大部分时间在下载依赖）。

---

## 1. 先确认环境

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows 10 / 11 x64** | Mica 材质与系统原生窗口按钮需要 Windows 11；Windows 10 会自动降级，不影响使用 |
| Node.js（运行启动器） | **≥ 22** | 源码运行与构建用。本项目在 Node 26 上验证 |
| Node.js（运行 dsh 实例） | **≥ 20，且必须是真正的 Node.js** | 见下一节的解释；可以是同一个 |
| 磁盘 | 约 1 GB 起 | .NET / WinUI 3 运行时与桥接层约 200 MB，每个 dsh 引擎版本另有体积 |

一条命令自查：

```powershell
node -v      # 应输出 v22.x 或更高
npm -v
```

---

## 2. 为什么实例不能借用启动器自带的 Node

这是新手最容易踩、也最难自己看懂的坑，先讲清楚。

启动器的界面是**原生 WinUI 3 应用**，但它把整套启动器逻辑交给一个 **Node 进程**（桥接层 `bridge/server.cjs`）
执行 —— 也就是说本机**必须**有真正的 Node.js。很自然会想：随便找个运行时跑 dsh 不就行了？
**不行。** dsh 依赖原生模块 `node-addon-require-builtin`，它按**运行时指纹白名单**匹配。
非标准运行时（例如 Electron 内置 Node，指纹形如 Electron 41 的 `V8 14.6.202.26-electron.0`）不在白名单里，启动会直接失败：

```
Error: dsh: host preparation failed: node-addon-require-builtin unsupported:
  Unsupported/no-context (unsupported Electron runtime fingerprint: ...)
```

所以启动器会**主动去探测并调用真正的 Node.js**，解析顺序是：

```
$WHALES_NODE_PATH  →  全局设置里的「Node 可执行文件路径」  →  启动器自身进程
                   →  系统 PATH  →  常见安装位置（nvm-windows / Volta / fnm / 官方安装包）
```

每个候选都会**实际执行一次探针**（`node -e` 读 `process.versions`）后才判定可用 —— 绝不按路径名猜测。

怎么确认它找到了？**全局设置 → Node 运行时**：

![Node 运行时](../assets/tutorial/23-node-runtime.png)

*图 23：全局设置的「Node 运行时」段。正常状态是「使用 `C:\Program Files\nodejs\node.exe`
（Node v26.3.0，来源：启动器自身进程）」，下面列出实际使用的路径、版本、来源与候选清单。*

**如果显示「没有找到可用的 Node 运行时」**，有三个办法：

- **让启动器自己备一份**：首次启动的自检报告里会给出「自动下载」的选项，或到
  **全局设置 → 环境自检** 点「运行环境自检」；它会下载官方 Node v22 LTS 便携版到
  `<启动器根>\runtime\node\`（约 30MB，不需要管理员权限，也不改系统设置）；
- 在「Node 可执行文件路径」输入框里手动填绝对路径（如 `C:\Program Files\nodejs\node.exe`），
  输入框失焦或按 Enter 即写入（本页是即时保存，没有「保存」按钮）；
- 或设一个环境变量 `WHALES_NODE_PATH` 指向 `node.exe`，然后重启启动器。

改动**立即生效** —— 之后启动实例与插件操作都会用它，不需要重启启动器。
（自备运行时排在上面这些来源**之后**：你自己装好的 Node 永远优先被沿用。）

---

## 3. 获取源码并安装依赖

项目不依赖固定盘符或路径，放在任意目录都行：

```powershell
git clone https://github.com/IDKWhatID2Use/whales-launcher.git
cd whales-launcher
npm install
```

`npm install` 结束时会自动跑 `postinstall`（`scripts/setup-electron.mjs`）：

1. 若 Electron 自身的 postinstall 已经把二进制下载好 → 直接采用；
2. 否则尝试从本机缓存 `%LOCALAPPDATA%\electron\Cache` **离线铺设**；
3. 两条路都走不通时脚本会**明确报错并给出处理办法**，不会静默失败。

### 如果 `npm install` 报 `EPERM ... node_cache`

说明你的 shell 环境里注入了 `npm_config_cache` 且指向工作区外，它**压过了**项目 `.npmrc`
（npm 的优先级是「命令行 > 环境变量 > 项目配置」）。显式指定缓存目录即可：

```powershell
$env:npm_config_cache = "$PWD\.npm-cache"
npm install --cache "$PWD\.npm-cache"
```

---

## 4. 三种启动方式，双击即用

**不需要开终端。** 项目根目录有三个入口，按你的习惯挑一个：

| 入口 | 行为 | 适合谁 |
|---|---|---|
| **`启动 WhalesLauncher.bat`** | 双击即启动；产物过期会自动重建。构建/启动失败时**窗口保留**并给出原因与日志路径 | 日常使用、排查问题 |
| **`WhalesLauncher.vbs`** | 无控制台窗口的静默启动；失败弹窗提示并指向日志 | 由快捷方式调用 |
| **`创建桌面快捷方式.bat`** | 在**桌面**与**开始菜单**各建一个快捷方式（指向上面那个 `.vbs`） | 装一次，之后从开始菜单搜索启动 |

三个入口走的是**同一份实现**（[`scripts/launch.mjs`](../../scripts/launch.mjs)），做的事顺序一致：

1. **环境自检** —— 确认 Node.js 与构建产物到位；缺失时只用本机缓存离线修复，**绝不联网**；
2. **按需构建** —— 产物齐全且比源码新就**直接启动（双击即开）**；只有源码改过才跑构建，
   且构建失败**不会**摧毁上一份可用产物；
3. **启动并留证** —— 应用与桥接层的 stdout/stderr 直通控制台，同时写日志。

> **首次使用前请确认依赖已装好**（见上一节）。没装的话双击 `.bat` 会明确告诉你缺什么，
> 而不是闪一下就没了。

### 从终端启动 / 传参

```powershell
npm run launch              # 按需构建后启动（等价于双击 .bat）
npm start                   # 强制重建后启动
npm run build               # 只构建（含类型门禁与原子替换）
npm run launch -- --dry-run # 启动链路自检：只做环境检查与构建判定，不开窗口
```

想给 `.bat` 传参也可以：

```powershell
"启动 WhalesLauncher.bat" --rebuild      # 强制重建再启动
"启动 WhalesLauncher.bat" --skip-build   # 直接用现有 dist 启动（调试产物最快）
"启动 WhalesLauncher.bat" --help         # 全部选项
```

---

## 5. 第一次启动会看到什么

窗口打开后是**实例列表页**。与此同时，启动器会自动跑一次**环境与依赖自检**，并弹出一份报告：

![Node 运行时](../assets/tutorial/23-node-runtime.png)

*图 23：环境自检会检查数据目录、全局配置、Node 运行时、npm、dsh 引擎与 npm registry 连通性，
逐项给出结论 ——「正常 / 已自动修复 / 缺失 / 失败 / 未检查」，缺失项还会给出下一步建议。*

自检会自动处理掉大部分"本该由你动手"的事：

| 情况 | 启动器的动作 |
|---|---|
| 数据目录（`instances` / `engines` / `shared` / `cache`）不存在 | **自动创建**，并做一次写探针确认真的可写 |
| 本机没有任何 dsh 引擎 | 问一次后**自动用 npm 安装**最新版（联网、数百 MB、不可中途取消） |
| 本机没有任何可用的 Node.js | 问一次后**自动下载官方便携版**（约 30MB，免管理员权限，落在启动器目录下） |
| 全局配置缺失 / 损坏 | 读取时自动生成默认值；损坏的会改名备份，不会静默丢设置 |

之后每次启动只做**本地**检查（不再联网）：一切正常就静默通过，仍有待处理项时才提示一句。
想随时重跑完整的自检，去 **全局设置 → 环境自检**（那里还能勾选"自动安装缺失的依赖"）。

如果你是全新安装，实例列表页里没有任何实例，会看到空态引导：

> 空态引导会告诉你「实例是一份独立的 dsh 运行环境，拥有自己的工作区、插件与设置」，
> 并给出一个 **创建第一个实例** 按钮（当前 WinUI 3 版本还没有「从实例包导入」入口，见
> [03 第 6 节](03-instances.md#6-实例包导出与导入)）。

此时**还差一步才能真正干活**：必须先有一个 dsh 引擎版本 —— 如果首次自检时你已经让它自动装好，
这一步就已经完成了；否则见下一章 [02 五分钟上手](02-quickstart.md)。

---

## 6. 出问题时的三个去处

| 现象 | 先看哪里 |
|---|---|
| 双击 `.bat` 没反应 / 闪退 | **`logs\launcher-summary.log`**（每次启动覆盖写，一屏给出结论） |
| 窗口起来了但界面报错 | 标题栏右上角的 **运行日志** 按钮（或 `Ctrl+L`）打开运行日志抽屉 |
| 实例启动失败 | 实例详情 → **「日志」页签**，以及 `$DSH_HOME/logs/startup-<时间戳>-<uuid>.log` |

关于日志的三种文件各管什么，见 [05 设置·存档·日志](05-settings-saves-logs.md#日志)。

---

## 7. 顺手记一下：其它常用命令

```powershell
npm run typecheck    # TypeScript 类型检查（零错误为通过）
npm test             # 运行核心测试
npm run icon         # 重新生成 assets/whales.ico
npm run shortcut     # 重建桌面 / 开始菜单快捷方式
npm run clean        # 清理 dist/
```

---

**下一步** → [02 五分钟上手：装引擎、建实例、跑起来](02-quickstart.md)
