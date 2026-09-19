# WhalesLauncher 使用教程

> **DeepSeek Harness (dsh) 实例与版本管理启动器 · 从安装到日常使用的完整图文指引**
>
> 仓库：<https://github.com/IDKWhatID2Use/whales-launcher> · 许可证：[Polyform Noncommercial 1.0.0](../../LICENSE)

这份教程面向**使用者**：假设你没有读过源码，只想知道「怎么装起来、怎么建第一个实例、怎么让它跑起来、出问题怎么办」。
每一节都按「**做什么 → 怎么点 → 界面长什么样**」组织，关键界面都配了截图。

想要理解设计取舍（为什么这样分层、端口怎么避让、契约如何冻结），请转到
[README](../../README.md) 与 [设计文档](../design/architecture.md)；本教程只讲**怎么用**。

---

## 关于本文的截图

本文所有界面截图由 [`scripts/make-tutorial-shots.mjs`](../../scripts/make-tutorial-shots.mjs) **自动生成**，可随时重跑复现：

```powershell
npm run build
node scripts/make-tutorial-shots.mjs          # 重新生成 docs/assets/tutorial/*.png
node scripts/make-tutorial-shots.mjs --list   # 查看全部截图场景
```

截图取自渲染层的**内置演示数据模式**（未连接后端时自动启用），因此你会看到：

| 你会看到 | 含义 |
|---|---|
| 左下角橙色「**演示数据**」徽标 | 当前界面没有真实后端，所有操作只作用于内存、不写磁盘 |
| 列表顶部「当前为演示数据（未连接后端）」说明条 | 同上，附带一个「重新检测」按钮 |
| 6 个示例实例、固定的版本号 | 示例数据刻意覆盖了 **6 种状态**：运行中 / 已停止 / 已崩溃 / 目录缺失 / 引擎未安装 / 记录异常 |
| 右下角日志里的 `F:\WhalesLauncher\...` 路径 | 演示数据里的假路径，不代表你的机器 |

**你在真实使用中不会看到这些徽标和说明条** —— 正常启动（双击 `启动 WhalesLauncher.bat`）时后端就绪，
界面直接呈现你的真实实例。之所以用演示数据出图，是因为它能把「平时很难同时凑齐」的各种状态一次性展示出来，
且不泄漏任何本机数据。

---

## 三条阅读路径

挑一条走，不必从头读到尾：

| 你的情况 | 建议路径 |
|---|---|
| **第一次用，想尽快跑起来** | [01 安装与首次启动](01-install.md) → [02 五分钟上手](02-quickstart.md) |
| **已经能跑，想用全功能** | [03 实例管理](03-instances.md) → [04 引擎与插件](04-engines-plugins.md) → [05 设置·存档·日志](05-settings-saves-logs.md) |
| **多实例 / 想共享存档 / 出问题了** | [06 隔离与共享](06-isolation-sharing.md) → [07 故障排查](07-troubleshooting.md) |

---

## 章节一览

| 章节 | 讲什么 | 关键截图 |
|---|---|---|
| [01 安装与首次启动](01-install.md) | 环境要求、克隆安装、三种启动入口、Node 运行时为什么必须独立 | — |
| [02 五分钟上手](02-quickstart.md) | 装引擎 → 建实例 → 启动 → 打开界面，一条最短路径 | `17` `07`~`10` `15` |
| [03 实例管理](03-instances.md) | 列表/搜索/筛选、创建向导四步详解、编辑、删除、实例包导入导出 | `01`~`05` `19`~`22` |
| [04 引擎与插件](04-engines-plugins.md) | 多版本引擎共存、安装与卸载、组合包开关、插件装卸 | `17` `11` |
| [05 设置·存档·日志](05-settings-saves-logs.md) | `settings.yaml` 编辑器、启动参数、会话存档、实时日志 | `12` `13` `14` `06` |
| [06 隔离与共享](06-isolation-sharing.md) | 四个隔离维度、junction 原理、共享冲突怎么处理 | `10` `13` |
| [07 故障排查](07-troubleshooting.md) | 启动失败、端口占用、白屏、日志在哪、常见报错对照 | `16` `06` `23` |

---

## 先认清四个概念

教程里反复出现这四个词，先花 30 秒记住它们：

```mermaid
graph LR
  A["实例<br/>instances/&lt;名字&gt;/"] --> B["home/ = 专属 DSH_HOME<br/>profile · 插件 · 设置 · 会话"]
  A --> C["workspace/ = 默认工作文件夹"]
  A --> D["logs/ = 启动日志"]
  B --> E["引擎版本<br/>engines/&lt;版本&gt;/"]
  E -.绑定.-> A
  F["插件 / 组合包<br/>profile 的依赖与 bundles"] --> B
```

| 概念 | 一句话解释 | 承载物 |
|---|---|---|
| **实例** | 一个独立运行的 dsh，互不干扰 | `instances/<实例名>/`（含专属 `home/`） |
| **引擎版本** | 实例用哪个 dsh 版本 | `engines/<版本>/node_modules/@deepseek-ai/dsh` |
| **插件 / 组合包** | 实例具备哪些能力 | profile 的 `dependencies` 与 `dsh.profile.bundles` |
| **存档** | 会话记录 × 工作文件夹，可共享 | `home/sessions/` 与 `workspace/`（可为 junction） |

> **为什么要分「实例」和「引擎版本」**：dsh 的 home 解析优先级是「显式配置 > `$DSH_HOME` > `~/.dsh`」。
> 启动器给每个实例注入自己的 `DSH_HOME`，就实现了**真正的隔离** —— 于是「升级引擎」变成一个实例自己的事，
> 不会波及别的实例。这也是本启动器存在的理由。

---

## 遇到问题先看这里

无论卡在哪一步，这三个地方按顺序看，八成能找到原因：

1. **`logs\launcher-summary.log`** —— 每次启动覆盖写，一屏给出时间、入口、构建决策、实际执行的命令、退出码结论。
   「双击没反应」时**最该先打开**的就是它。
2. **界面右下角的运行日志抽屉**（标题栏 `>_` 图标，或 `Ctrl+L`）—— 实例的 stdout / stderr / 系统消息分色实时输出。
3. **实例详情 →「日志」页签** —— 启动失败时 dsh 会把完整诊断写进 `$DSH_HOME/logs/startup-<时间戳>-<uuid>.log`。

具体报错对照见 [07 故障排查](07-troubleshooting.md)。
